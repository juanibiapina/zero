/**
 * ============================================================================
 * AgentContainer — CF Container running the pi agent-server
 * ============================================================================
 *
 * Each session gets its own container instance, identified by name.
 * Container auto-sleeps after the configured timeout.
 *
 * Lifecycle hooks notify SessionDO when the container stops so it can
 * reset its event sequence counter and properly surface errors on restart.
 */

import { Container, switchPort } from "@cloudflare/containers";
import type { StopParams } from "@cloudflare/containers";
import type { Env } from "./types";
import { withRetry } from "./lib/retry";

export class AgentContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "5m";

  /**
   * Store the SessionDO ID so onStop() can notify it when the container dies.
   * Called once during session creation (RPC from the worker).
   */
  async setSessionDOId(id: string): Promise<void> {
    await this.ctx.storage.put("sessionDOId", id);
  }

  override onStart(): void {
    console.log("AgentContainer.onStart()");
  }

  /**
   * Renew the activity timeout after each proxied request completes.
   *
   * The Container SDK only calls renewActivityTimeout() *before* proxying,
   * so long-running requests (e.g. POST /resume with a slow git clone) can
   * cause the activity timer to expire before the response arrives. This
   * override ensures the timer is also renewed *after*, preventing
   * onActivityExpired from killing the container immediately after a
   * successful but slow operation.
   */
  override async fetch(request: Request): Promise<Response> {
    const response = await super.fetch(request);
    this.renewActivityTimeout();
    return response;
  }

  /**
   * Called when sleepAfter timeout expires — container is still running.
   * Snapshot the workspace to R2 before letting the container sleep.
   */
  override async onActivityExpired(): Promise<void> {
    // Check if the agent is still busy before sleeping.
    // During agent execution, events stream over WebSocket which doesn't
    // reset the sleepAfter timer — only fetch() calls do. So we poll
    // the agent status here and extend the timeout if it's still running.
    try {
      const statusResp = await this.containerFetch(
        switchPort(new Request("http://container/status"), 8080)
      );
      if (statusResp.ok) {
        const { status } = await statusResp.json<{ status: string }>();
        if (status === "running" || status === "starting") {
          console.log(`Agent still active (${status}), extending activity timeout`);
          this.renewActivityTimeout();
          return;
        }
      }
    } catch (err) {
      // Fetch failed — container may be unhealthy, proceed with stop
      console.error("Status check failed, proceeding with stop:", err);
    }

    const sessionDOId = await this.ctx.storage.get<string>("sessionDOId");
    let snapshotFailed = false;
    try {
      if (sessionDOId) {
        const snapshotKey = `workspace-snapshots/${sessionDOId}/snapshot.tar.zst`;
        console.log(`Snapshotting workspace to R2: ${snapshotKey}`);

        // Fetch snapshot from container with retries
        const buffer = await withRetry(
          async () => {
            const resp = await this.containerFetch(
              switchPort(new Request("http://container/workspace/snapshot"), 8080)
            );
            if (resp.status === 404) {
              // No workspace to snapshot — container never had a repo cloned
              console.log("No workspace to snapshot, skipping");
              return null;
            }
            if (!resp.ok) {
              const text = await resp.text();
              throw new Error(`Snapshot fetch failed: ${resp.status} ${text}`);
            }
            return resp.arrayBuffer();
          },
          { maxAttempts: 3, label: "snapshot-fetch" },
        );

        // Save to R2 with retries (skip if no workspace)
        if (buffer !== null) {
          await withRetry(
            () => this.env.SNAPSHOTS.put(snapshotKey, buffer),
            { maxAttempts: 3, label: "snapshot-r2-put" },
          );
          console.log(`Workspace snapshot saved to R2 (${buffer.byteLength} bytes)`);
        }
      }
    } catch (err) {
      console.error("Workspace snapshot failed after all retries:", err);
      snapshotFailed = true;
    } finally {
      // Notify SessionDO before stopping so it can surface the error to the user.
      // Must happen before this.stop() because onStop() also notifies SessionDO.
      if (snapshotFailed && sessionDOId) {
        try {
          const stub = this.env.SESSION_DO.get(
            this.env.SESSION_DO.idFromString(sessionDOId)
          );
          await stub.onSnapshotSaveFailed();
        } catch (err) {
          console.error("Failed to notify SessionDO about snapshot failure:", err);
        }
      }
      // Always stop — container must sleep even if snapshot fails
      await this.stop();
    }
  }

  override async onStop(params: StopParams): Promise<void> {
    console.log("AgentContainer.onStop()", JSON.stringify(params));

    const sessionDOId = await this.ctx.storage.get<string>("sessionDOId");
    if (!sessionDOId) return;

    const stub = this.env.SESSION_DO.get(
      this.env.SESSION_DO.idFromString(sessionDOId)
    );
    await stub.onContainerStopped({
      exitCode: params.exitCode,
      reason: params.reason,
    });
  }
}
