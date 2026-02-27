/**
 * ============================================================================
 * Container Service — Cloudflare Container Runtime
 * ============================================================================
 *
 * Wraps @cloudflare/containers to provide a typed service for a single
 * container instance. Each method maps to a container HTTP endpoint,
 * abstracting away fetch, URL construction, and JSON serialization.
 */

import { getContainer, switchPort } from "@cloudflare/containers";
import type { Env } from "../types";

// ── Parameter Types ──────────────────────────────────────────────────────

export type ConfigureParams = {
  provider: string;
  model: string;
  apiKey: string;
  thinkingLevel?: string;
};

export type ResumeParams = {
  provider: string;
  model: string;
  apiKey: string;
  repoUrl: string;
  token: string;
  /** User secrets injected as environment variables before the agent resumes. */
  secrets?: Record<string, string>;
  /** Conversation history reconstructed from SessionDO's persisted agent_end events. */
  messages: unknown[];
  /** When true, workspace will be restored from R2 snapshot after resume — skip clone. */
  workspaceRestored?: boolean;
  /** Thinking/reasoning level for the session. */
  thinkingLevel?: string;
};

// ── Error Type ───────────────────────────────────────────────────────────

export class ContainerError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    path: string
  ) {
    super(`Container ${path}: ${status} ${body}`);
  }

  /** Transient errors that may resolve on retry (container still starting up). */
  get isTransient(): boolean {
    return (
      this.status === 404 ||
      this.status === 503 ||
      (this.status === 500 && this.body.includes("Failed to start container"))
    );
  }
}

// ── Service ──────────────────────────────────────────────────────────────

/** Typed service for a single named container instance. */
export class ContainerHandle {
  private container;

  constructor(env: Env, name: string) {
    this.container = getContainer(env.AGENT_CONTAINER, name);
  }

  // ── Platform ─────────────────────────────────────────────────────────

  /** Bind this container to a session for lifecycle notifications. */
  async bindToSession(sessionDOId: string): Promise<void> {
    await this.container.setSessionDOId(sessionDOId);
  }

  /** Get current container state. */
  async getState(): Promise<{ status: string }> {
    const state = await this.container.getState();
    return { status: state.status };
  }

  // ── Agent Lifecycle ──────────────────────────────────────────────────

  /** Resume session (first-start or wake-from-sleep). */
  resume(params: ResumeParams): Promise<void> {
    return this.post("/resume", params);
  }

  /** Reconfigure provider/model/apiKey (takes effect next turn). */
  configure(params: ConfigureParams): Promise<void> {
    return this.post("/configure", params);
  }

  /** Send a follow-up message. */
  sendMessage(text: string): Promise<void> {
    return this.post("/message", { text });
  }

  /** Steer the agent mid-run. */
  steer(text: string): Promise<void> {
    return this.post("/steer", { text });
  }

  /** Stop the current session. */
  stop(): Promise<void> {
    return this.post("/stop");
  }

  // ── Event Stream ─────────────────────────────────────────────────────

  /** Open a WebSocket to the container's event stream. */
  async connectWebSocket(): Promise<WebSocket> {
    const resp = await this.container.fetch(
      switchPort(
        new Request("http://container/ws", {
          headers: { Upgrade: "websocket" },
        }),
        8080
      )
    );
    if (!resp.webSocket) throw new Error("WebSocket upgrade failed");
    return resp.webSocket;
  }

  // ── Workspace Management ─────────────────────────────────────────────

  /** Restore workspace from a binary tar.zst snapshot. */
  async restoreWorkspace(snapshot: ArrayBuffer): Promise<void> {
    const resp = await this.container.fetch(
      switchPort(
        new Request("http://container/workspace/restore", {
          method: "POST",
          body: snapshot,
        }),
        8080
      )
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new ContainerError(resp.status, text, "/workspace/restore");
    }
  }

  /** Update the git remote URL with a fresh token. */
  updateRemote(repoUrl: string, token: string): Promise<void> {
    return this.post("/workspace/update-remote", { repoUrl, token });
  }

  // ── Internal ─────────────────────────────────────────────────────────

  /** POST JSON to a container path. Throws ContainerError on non-OK. */
  private async post(path: string, body?: unknown): Promise<void> {
    const resp = await this.container.fetch(
      switchPort(
        new Request(`http://container${path}`, {
          method: "POST",
          ...(body !== undefined
            ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
            : {}),
        }),
        8080
      )
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new ContainerError(resp.status, text, path);
    }
  }
}
