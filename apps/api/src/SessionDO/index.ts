/**
 * ============================================================================
 * SessionDO — Agent Session Hub (Hibernation API + Decoupled Container)
 * ============================================================================
 *
 * One per session. Accepts browser WebSocket connections via the Hibernation
 * API, persists all events to local SQLite, and broadcasts to connected
 * clients.
 *
 * Architecture:
 *   Browser ←WS (hibernation)→ SessionDO ←HTTP commands / ephemeral event WS→ Container
 *
 * - Browser connections use the Hibernation API: SessionDO can sleep between
 *   WS messages, waking automatically when a message arrives.
 * - Commands to the container go via HTTP POST.
 * - Events from the container stream via an ephemeral WS, opened on-demand.
 * - Container sleeps via its own sleepAfter timeout.
 */

import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { DurableObject } from "cloudflare:workers";
import { eq, gt, sql } from "drizzle-orm";
import { getContainer, switchPort } from "@cloudflare/containers";
// @ts-expect-error — Generated migrations file
import migrations from "./db/drizzle/migrations";
import { sessionMetaTable, sessionEventsTable } from "./db/schema";
import type { Env } from "../types";
import type { UserDO } from "../UserDO";
import type { SessionStatus, SessionServerMessage, SessionClientMessage } from "@zero/core";
import { migrate } from "@zero/drizzle-migrator";
import { getInstallationToken } from "../services/github";

export class SessionDO extends DurableObject<Env> {
  db: DrizzleSqliteDODatabase;

  /** SessionDO-assigned monotonic sequence counter */
  private seq = 0;

  /** Last container SSE seq we've seen (for reconnection after hibernation) */
  private lastContainerSeq = 0;

  /** Ephemeral event WebSocket to the container (null when agent is idle) */
  private containerWs: WebSocket | null = null;

  /** In-memory mirror of persisted status — avoids async DB reads in hot paths */
  private currentStatus: SessionStatus = "pending";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });

    ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);

      const maxRow = this.db
        .select({
          maxSeq: sql<number>`MAX(${sessionEventsTable.seq})`,
          maxContainerSeq: sql<number>`MAX(${sessionEventsTable.containerSeq})`,
        })
        .from(sessionEventsTable)
        .get();

      if (maxRow?.maxSeq) this.seq = maxRow.maxSeq;
      if (maxRow?.maxContainerSeq) this.lastContainerSeq = maxRow.maxContainerSeq;

      const metaRow = this.db.select({ status: sessionMetaTable.status }).from(sessionMetaTable).get();
      if (metaRow?.status) this.currentStatus = metaRow.status as SessionStatus;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Session Metadata (RPC methods)
  // ═══════════════════════════════════════════════════════════════════════

  async initSession(meta: {
    status: SessionStatus;
    containerName: string;
    projectOwner: string;
    projectRepo: string;
    provider: string;
    model: string;
    userDOId?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.db.insert(sessionMetaTable).values({
      status: meta.status,
      containerName: meta.containerName,
      projectOwner: meta.projectOwner,
      projectRepo: meta.projectRepo,
      provider: meta.provider,
      model: meta.model,
      userDOId: meta.userDOId ?? null,
      createdAt: now,
    });
  }

  async getSession(): Promise<{
    status: SessionStatus;
    containerName: string;
    projectOwner: string;
    projectRepo: string;
    provider: string;
    model: string;
    userDOId: string | null;
    createdAt: string;
  } | null> {
    const row = await this.db.select().from(sessionMetaTable).get();
    if (!row) return null;
    return {
      status: row.status as SessionStatus,
      containerName: row.containerName,
      projectOwner: row.projectOwner,
      projectRepo: row.projectRepo,
      provider: row.provider,
      model: row.model,
      userDOId: row.userDOId,
      createdAt: row.createdAt,
    };
  }

  async getStatus(): Promise<SessionStatus | null> {
    const row = await this.db
      .select({ status: sessionMetaTable.status })
      .from(sessionMetaTable)
      .get();
    return (row?.status as SessionStatus) ?? null;
  }

  async updateStatus(status: SessionStatus): Promise<void> {
    this.currentStatus = status;
    await this.db.update(sessionMetaTable).set({ status });
    this.syncStatusToUserDO();
  }

  async deleteSession(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  /**
   * Auto-wake the container when a browser connects to a sleeping session.
   * Fire-and-forget — errors are logged but don't fail the WS connection.
   *
   * Checks actual container state before setting "resuming" — if the container
   * is still running (within its sleepAfter window), we just reconnect the
   * event stream without any status change.
   */
  private async autoWakeContainer(): Promise<void> {
    try {
      const session = await this.getSession();
      if (!session) return;

      const container = getContainer(this.env.AGENT_CONTAINER, session.containerName);

      // Check if container actually needs resuming
      let needsResume = false;
      try {
        const state = await container.getState();
        needsResume = (
          state.status === "stopped" ||
          state.status === "stopped_with_code" ||
          state.status === "stopping"
        );
      } catch {
        needsResume = true;
      }

      if (needsResume) {
        // Container is actually sleeping — show resuming UI and wake it
        await this.updateStatus("resuming");
        this.broadcastToWebSockets({ type: "status", status: "resuming" });
        await this.ensureContainerRunning();
      } else {
        // Container is still running — just reconnect event stream silently
        if (!this.containerWs) {
          await this.connectEventStream(container);
        }
      }
    } catch (err) {
      console.error("Auto-wake failed:", err);
      // Reset to idle so the user isn't stuck at "Resuming" forever.
      // They can still trigger a fresh wake by sending a message.
      await this.updateStatus("idle");
      this.broadcastToWebSockets({ type: "status", status: "idle" });
    }
  }

  /**
   * Proactively connect the event WS to the container.
   * Called during session creation so startup events reach the browser.
   */
  async connectToContainer(): Promise<void> {
    if (this.containerWs) return;
    const session = await this.getSession();
    if (!session) return;
    const container = getContainer(this.env.AGENT_CONTAINER, session.containerName);
    await this.connectEventStream(container);
  }

  /**
   * Called by AgentContainer.onStop() when the container dies.
   */
  async onContainerStopped(): Promise<void> {
    this.closeEventStream();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Browser WebSocket (Hibernation API)
  // ═══════════════════════════════════════════════════════════════════════

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (upgrade !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);

    // Replay stored events
    const events = this.getEvents();
    for (const event of events) {
      server.send(JSON.stringify({
        type: "event", seq: event.seq, source: event.source,
        eventType: event.eventType, data: event.data,
      } satisfies SessionServerMessage));
    }

    // Send current status
    const status = await this.getStatus();
    if (status) {
      server.send(JSON.stringify({ type: "status", status } satisfies SessionServerMessage));
    }

    // Mark end of replay
    server.send(JSON.stringify({ type: "caught_up", lastSeq: this.seq } satisfies SessionServerMessage));

    // Reconnect to container if event stream was lost (e.g. after DO hibernation).
    // "idle" → container is sleeping, needs full wake.
    // "starting"/"running"/"ready"/"resuming" → container should be running
    //   but event stream was lost; reconnect it.
    const ACTIVE_STATES: Set<string> = new Set(["idle", "starting", "running", "ready", "resuming"]);
    if (ACTIVE_STATES.has(this.currentStatus) && !this.containerWs) {
      this.ctx.waitUntil(this.autoWakeContainer());
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;

    let data: SessionClientMessage;
    try { data = JSON.parse(message); } catch { return; }

    switch (data.type) {
      case "message": return this.handleUserMessage(data.text);
      case "stop":    return this.handleStop();
      case "steer":   return this.handleSteer(data.text);
      case "ping":    return void _ws.send(JSON.stringify({ type: "pong" } satisfies SessionServerMessage));
    }
  }

  async webSocketClose(): Promise<void> { /* Hibernation API manages sockets */ }
  async webSocketError(): Promise<void> { /* Hibernation API manages sockets */ }

  // ═══════════════════════════════════════════════════════════════════════
  // Command Handlers
  // ═══════════════════════════════════════════════════════════════════════

  private async handleUserMessage(text: string): Promise<void> {
    // 1. Persist user message
    const persisted = this.appendEvents([{
      source: "user",
      eventType: "message",
      data: { type: "user_message", text },
    }]);

    // 2. Broadcast to all connected browsers
    for (const event of persisted) {
      this.broadcastToWebSockets({
        type: "event", seq: event.seq, source: event.source,
        eventType: event.eventType, data: event.data,
      });
    }

    // 3. Ensure container is running and ready
    try {
      await this.ensureContainerRunning();
      await this.waitForReady();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.broadcastError(msg);
      await this.updateStatus("error");
      this.broadcastToWebSockets({ type: "status", status: "error" });
      return;
    }

    // 4. Send message to container
    try {
      await this.postToContainer("/message", { text });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.broadcastError(msg);
    }
  }

  private async handleStop(): Promise<void> {
    try {
      await this.postToContainer("/stop", undefined);
    } catch {
      // Container might already be dead — that's fine
    }
    await this.updateStatus("idle");
    this.broadcastToWebSockets({ type: "status", status: "idle" });
  }

  private async handleSteer(text: string): Promise<void> {
    try {
      await this.postToContainer("/steer", { text });
    } catch (err) {
      this.broadcastError(err instanceof Error ? err.message : String(err));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Container Lifecycle
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Ensure the container is running and the event stream is connected.
   * Resumes the container if it was sleeping.
   */
  private async ensureContainerRunning(): Promise<void> {
    const session = await this.getSession();
    if (!session) throw new Error("No session");

    const container = getContainer(this.env.AGENT_CONTAINER, session.containerName);

    // Check if container needs resume
    let needsResume = false;
    try {
      const state = await container.getState();

      // If container is still shutting down, wait for it to fully stop
      if (state.status === "stopping") {
        await this.waitForContainerStopped(container);
        needsResume = true;
      } else {
        needsResume = (
          state.status === "stopped" ||
          state.status === "stopped_with_code"
        );
      }
    } catch {
      needsResume = true;
    }

    if (needsResume) {
      this.lastContainerSeq = 0;
      await this.resumeContainer(session, container);
    }

    // Ensure event stream is connected
    if (!this.containerWs) {
      await this.connectEventStream(container);
    }
  }

  /**
   * Wait for a container in "stopping" state to fully stop.
   * The container may be finishing its onActivityExpired snapshot.
   */
  private async waitForContainerStopped(
    container: ReturnType<typeof getContainer>,
    timeoutMs = 30_000
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const state = await container.getState();
        if (state.status !== "stopping") return;
      } catch {
        return; // Can't get state — treat as stopped
      }
    }
    console.warn("Container still stopping after timeout, proceeding anyway");
  }

  /**
   * Wait for the container to be ready (status = ready or idle).
   */
  private async waitForReady(timeoutMs = 60_000): Promise<void> {
    if (this.isContainerReady()) return;

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.isContainerReady()) return;
      if (this.currentStatus === "error" || this.currentStatus === "failed") {
        throw new Error("Container failed to start");
      }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error("Timed out waiting for container to be ready");
  }

  private isContainerReady(): boolean {
    return this.currentStatus === "ready" || this.currentStatus === "idle";
  }

  /**
   * Resume the container session after sleep/wake.
   * Clean, linear flow: credentials → history → POST /resume → R2 restore.
   */
  private async resumeContainer(
    session: NonNullable<Awaited<ReturnType<typeof this.getSession>>>,
    container: ReturnType<typeof getContainer>
  ): Promise<void> {
    this.broadcastToWebSockets({ type: "status", status: "resuming" as SessionStatus });

    if (!session.userDOId) throw new Error("No userDOId for resume");

    // 1. Resolve fresh credentials
    const { apiKey, githubToken, secrets } = await this.resolveCredentials(session);

    // 2. Rebuild conversation history
    const messages = this.getConversationHistory();

    // 3. Check for R2 snapshot
    const snapshotKey = `workspace-snapshots/${this.ctx.id.toString()}/snapshot.tar.zst`;
    const hasSnapshot = await this.env.SNAPSHOTS.head(snapshotKey) !== null;

    // 4. POST /resume (with retry for container startup)
    const repoUrl = `https://github.com/${session.projectOwner}/${session.projectRepo}.git`;
    await this.postToContainerWithRetry(container, "/resume", {
      provider: session.provider,
      model: session.model,
      apiKey,
      repoUrl,
      token: githubToken,
      secrets: Object.keys(secrets).length > 0 ? secrets : undefined,
      messages,
      workspaceRestored: hasSnapshot,
    });

    console.log(`Session resumed (${messages.length} messages restored)`);

    // 5. Restore workspace from R2 if snapshot exists
    if (hasSnapshot) {
      await this.restoreWorkspaceFromR2(container, snapshotKey, repoUrl, githubToken);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Event Stream (ephemeral WS to container)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Open the ephemeral event WS to the container.
   * Retries during container startup.
   */
  private async connectEventStream(container: ReturnType<typeof getContainer>): Promise<void> {
    if (this.containerWs) return;

    let ws: WebSocket | null = null;
    for (let i = 0; i < 20; i++) {
      try {
        const req = new Request(`http://container/ws?after=${this.lastContainerSeq}`, {
          headers: { Upgrade: "websocket" },
        });
        const res = await container.fetch(switchPort(req, 8080));
        if (res.webSocket) { ws = res.webSocket; break; }
      } catch { /* container starting or platform error */ }
      await new Promise(r => setTimeout(r, 2000));
    }

    if (!ws) throw new Error("Could not connect event stream");

    ws.accept();
    this.containerWs = ws;

    ws.addEventListener("message", (event) => this.handleContainerEvent(event));
    ws.addEventListener("close", () => { this.containerWs = null; });
    ws.addEventListener("error", () => { this.containerWs = null; });
  }

  private closeEventStream(): void {
    if (this.containerWs) {
      try { this.containerWs.close(1000, "cleanup"); } catch { /* already closed */ }
      this.containerWs = null;
    }
  }

  /**
   * Handle an event from the container's event stream.
   * Persists to SQLite, updates status, broadcasts to browsers.
   */
  private handleContainerEvent(event: MessageEvent): void {
    if (typeof event.data !== "string") return;

    let envelope: { seq: number; event: unknown; timestamp: string };
    try {
      const raw = JSON.parse(event.data);
      if (raw.type === "pong") return;
      envelope = raw;
    } catch { return; }

    // Skip already-seen events
    if (envelope.seq <= this.lastContainerSeq) return;
    this.lastContainerSeq = envelope.seq;

    const agentEvent = envelope.event as Record<string, unknown>;
    const eventType = (agentEvent?.type as string) ?? "unknown";

    // Persist to SQLite
    const persisted = this.appendEvents([{
      containerSeq: envelope.seq,
      source: "agent",
      eventType,
      data: agentEvent,
    }]);

    // Update status if this is a status event
    if (eventType === "status" && agentEvent.status) {
      const newStatus = agentEvent.status as SessionStatus;
      this.updateStatus(newStatus).catch(() => {});
      this.broadcastToWebSockets({
        type: "status",
        status: newStatus,
        ...(agentEvent.error ? { error: agentEvent.error as string } : {}),
      });

      // Close event stream on terminal states
      if (newStatus === "completed" || newStatus === "failed" || newStatus === "error") {
        this.closeEventStream();
      }
    }

    // Surface container errors to browsers
    if (eventType === "error" && agentEvent.error) {
      this.broadcastToWebSockets({ type: "error", message: agentEvent.error as string });
    }

    // Broadcast events to all connected browsers
    for (const p of persisted) {
      this.broadcastToWebSockets({
        type: "event", seq: p.seq, source: p.source,
        eventType: p.eventType, data: p.data,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Container HTTP Helpers
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * POST to the container. Throws on non-OK response.
   */
  private async postToContainer(path: string, body: unknown): Promise<Response> {
    const session = await this.getSession();
    if (!session) throw new Error("No session");
    const container = getContainer(this.env.AGENT_CONTAINER, session.containerName);
    const resp = await container.fetch(switchPort(
      new Request(`http://container${path}`, {
        method: "POST",
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      }), 8080
    ));
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Container ${path}: ${resp.status} ${text}`);
    }
    return resp;
  }

  /**
   * POST to container with retry for startup.
   * Retries on 404, 503, and 500 "Failed to start container" (transient platform errors).
   */
  private async postToContainerWithRetry(
    container: ReturnType<typeof getContainer>,
    path: string,
    body: unknown,
    maxRetries = 15
  ): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const resp = await container.fetch(switchPort(
          new Request(`http://container${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }), 8080
        ));
        if (resp.ok) return;
        const text = await resp.text();
        // 404/503 are transient during container startup.
        // 500 "Failed to start container" is a transient platform error
        // (e.g. container still cleaning up from previous stop).
        const isTransient = (
          resp.status === 404 ||
          resp.status === 503 ||
          (resp.status === 500 && text.includes("Failed to start container"))
        );
        if (isTransient) {
          if (i === maxRetries - 1) throw new Error(`${path} failed after retries: ${resp.status} ${text}`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        throw new Error(`${path} failed: ${resp.status} ${text}`);
      } catch (err) {
        if (err instanceof Error && err.message.includes("failed:")) throw err;
        if (i === maxRetries - 1) throw new Error(`${path} unavailable after retries`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Credential Resolution
  // ═══════════════════════════════════════════════════════════════════════

  private async resolveCredentials(session: {
    provider: string;
    userDOId: string | null;
  }): Promise<{ apiKey: string; githubToken: string; secrets: Record<string, string> }> {
    if (!session.userDOId) throw new Error("No userDOId");

    const userDO = this.env.USER_DO.get(
      this.env.USER_DO.idFromString(session.userDOId)
    ) as DurableObjectStub<UserDO>;

    // API key
    const credentials = await userDO.listProviderCredentials();
    const cred =
      credentials.find(c => c.provider === session.provider && c.apiKey) ??
      credentials.find(c => c.provider === session.provider && c.accessToken);
    if (!cred) throw new Error(`No credentials for provider: ${session.provider}`);
    const apiKey = (cred.apiKey ?? cred.accessToken)!;

    // GitHub token
    const installation = await userDO.getGitHubInstallation();
    if (!installation) throw new Error("No GitHub installation linked");
    const githubToken = await getInstallationToken(this.env, installation.installationId);

    // User secrets
    const secretRows = await userDO.listUserSecretsWithValues();
    const secrets: Record<string, string> = {};
    for (const row of secretRows) secrets[row.name] = row.value;

    return { apiKey, githubToken, secrets };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // R2 Workspace Snapshots
  // ═══════════════════════════════════════════════════════════════════════

  private async restoreWorkspaceFromR2(
    container: ReturnType<typeof getContainer>,
    snapshotKey: string,
    repoUrl: string,
    githubToken: string
  ): Promise<void> {
    try {
      const obj = await this.env.SNAPSHOTS.get(snapshotKey);
      if (!obj) { console.log("No R2 snapshot found"); return; }

      const buffer = await obj.arrayBuffer();
      console.log(`Restoring workspace: ${snapshotKey} (${buffer.byteLength} bytes)`);

      const resp = await container.fetch(switchPort(
        new Request("http://container/workspace/restore", { method: "POST", body: buffer }), 8080
      ));
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Restore failed: ${resp.status} ${text}`);
      }

      // Update git remote with fresh token
      await container.fetch(switchPort(
        new Request("http://container/workspace/update-remote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoUrl, token: githubToken }),
        }), 8080
      ));

      console.log("Workspace restored from R2 snapshot");
    } catch (err) {
      console.error("Workspace restore failed (session has empty workspace):", err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Event Persistence
  // ═══════════════════════════════════════════════════════════════════════

  private appendEvents(
    events: Array<{
      containerSeq?: number;
      source: string;
      eventType: string;
      data: unknown;
    }>
  ): Array<{ seq: number; source: string; eventType: string; data: unknown }> {
    const now = new Date().toISOString();
    const persisted: Array<{ seq: number; source: string; eventType: string; data: unknown }> = [];

    for (const event of events) {
      this.seq++;
      this.db.insert(sessionEventsTable).values({
        seq: this.seq,
        containerSeq: event.containerSeq ?? null,
        source: event.source,
        eventType: event.eventType,
        data: JSON.stringify(event.data),
        createdAt: now,
      }).run();

      persisted.push({
        seq: this.seq,
        source: event.source,
        eventType: event.eventType,
        data: event.data,
      });
    }
    return persisted;
  }

  private getEvents(afterSeq?: number): Array<{
    seq: number; source: string; eventType: string; data: unknown;
  }> {
    const rows = afterSeq
      ? this.db.select().from(sessionEventsTable).where(gt(sessionEventsTable.seq, afterSeq)).orderBy(sessionEventsTable.seq).all()
      : this.db.select().from(sessionEventsTable).orderBy(sessionEventsTable.seq).all();

    return rows.map(row => ({
      seq: row.seq,
      source: row.source,
      eventType: row.eventType,
      data: JSON.parse(row.data),
    }));
  }

  private getConversationHistory(): unknown[] {
    const rows = this.db
      .select()
      .from(sessionEventsTable)
      .where(eq(sessionEventsTable.eventType, "agent_end"))
      .orderBy(sessionEventsTable.seq)
      .all();

    const messages: unknown[] = [];
    for (const row of rows) {
      const event = JSON.parse(row.data) as { messages?: unknown[] };
      if (event.messages) messages.push(...event.messages);
    }
    return messages;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Status & Broadcast Helpers
  // ═══════════════════════════════════════════════════════════════════════

  private syncStatusToUserDO(): void {
    const row = this.db
      .select({ userDOId: sessionMetaTable.userDOId })
      .from(sessionMetaTable)
      .get();
    if (!row?.userDOId) return;

    const userDO = this.env.USER_DO.get(
      this.env.USER_DO.idFromString(row.userDOId)
    ) as DurableObjectStub<UserDO>;

    userDO
      .updateSessionStatus(this.ctx.id.toString(), this.currentStatus)
      .catch(err => console.error("syncStatusToUserDO failed:", err));
  }

  private broadcastToWebSockets(message: SessionServerMessage): void {
    const json = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(json); }
      catch {
        try { ws.close(1011, "Send failed"); } catch { /* already closed */ }
      }
    }
  }

  private broadcastError(message: string): void {
    this.broadcastToWebSockets({ type: "error", message });
  }
}
