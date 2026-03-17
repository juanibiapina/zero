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
import { ContainerHandle, ContainerError } from "../services/container";
// @ts-expect-error — Generated JS file without type declarations
import migrations from "./db/drizzle/migrations";
import type { MigrationConfig } from "@zero/drizzle-migrator";
import { sessionMetaTable, sessionEventsTable } from "./db/schema";
import type { Env } from "../types";
import type { SessionStatus, SessionServerMessage, SessionClientMessage } from "@zero/core";
import { migrate } from "@zero/drizzle-migrator";

import { getInstallationToken } from "../services/github";
import { withRetry } from "../lib/retry";

export class SessionDO extends DurableObject<Env> {
  db: DrizzleSqliteDODatabase;

  /** SessionDO-assigned monotonic sequence counter */
  private seq = 0;

  /** Container handle — derived from DO ID, always available */
  private container: ContainerHandle;

  /** Ephemeral event WebSocket to the container (null when agent is idle) */
  private containerWs: WebSocket | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    this.container = new ContainerHandle(env, `session-${ctx.id.toString()}`);

    // Auto-respond to ping/pong at the edge without waking the DO from hibernation.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        JSON.stringify({ type: "ping" }),
        JSON.stringify({ type: "pong" }),
      ),
    );

    void ctx.blockConcurrencyWhile(async () => {
      migrate(this.db, migrations as MigrationConfig);

      const maxRow = this.db
        .select({
          maxSeq: sql<number>`MAX(${sessionEventsTable.seq})`,
        })
        .from(sessionEventsTable)
        .get();

      if (maxRow?.maxSeq) this.seq = maxRow.maxSeq;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Session Metadata (RPC methods)
  // ═══════════════════════════════════════════════════════════════════════

  async initSession(meta: {
    status: SessionStatus;
    projectOwner: string;
    projectRepo: string;
    provider: string;
    model: string;
    thinkingLevel?: string;
    userDOId?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    this.db.insert(sessionMetaTable).values({
      status: meta.status,
      projectOwner: meta.projectOwner,
      projectRepo: meta.projectRepo,
      provider: meta.provider,
      model: meta.model,
      thinkingLevel: meta.thinkingLevel ?? null,
      userDOId: meta.userDOId ?? null,
      createdAt: now,
    }).run();
  }

  async getSession(): Promise<{
    status: SessionStatus;
    projectOwner: string;
    projectRepo: string;
    provider: string;
    model: string;
    thinkingLevel: string | null;
    userDOId: string | null;
    createdAt: string;
  } | null> {
    const row = this.db.select().from(sessionMetaTable).get();
    if (!row) return null;
    return {
      status: row.status as SessionStatus,
      projectOwner: row.projectOwner,
      projectRepo: row.projectRepo,
      provider: row.provider,
      model: row.model,
      thinkingLevel: row.thinkingLevel,
      userDOId: row.userDOId,
      createdAt: row.createdAt,
    };
  }

  async getStatus(): Promise<SessionStatus | null> {
    const row = this.db
      .select({ status: sessionMetaTable.status })
      .from(sessionMetaTable)
      .get();
    return (row?.status as SessionStatus) ?? null;
  }

  async updateStatus(status: SessionStatus): Promise<void> {
    this.db.update(sessionMetaTable).set({ status }).run();
    this.syncStatusToUserDO(status);
  }

  async updateProviderModel(provider: string, model: string, thinkingLevel?: string): Promise<void> {
    const updates: Record<string, string> = { provider, model };
    if (thinkingLevel !== undefined) updates.thinkingLevel = thinkingLevel;
    this.db.update(sessionMetaTable).set(updates).run();
  }

  /**
   * Full teardown: stop container, clean R2 snapshot, clear storage.
   * All steps are best-effort — a single failure doesn't block cleanup.
   */
  async destroySession(): Promise<void> {
    // Step 1: Best-effort stop container process
    try {
      await this.container.stop();
    } catch (err) {
      console.error("Destroy: container stop failed (ok):", err);
    }

    // Step 2: Clear R2 workspace snapshot
    try {
      await this.env.SNAPSHOTS.delete(
        `workspace-snapshots/${this.ctx.id.toString()}/snapshot.tar.zst`
      );
    } catch (err) {
      console.error("Destroy: R2 snapshot cleanup failed (ok):", err);
    }

    // Step 3: Clear all DO storage
    await this.ctx.storage.deleteAll();
  }

  /**
   * Called by AgentContainer.onStop() when the container dies.
   * This is the source of truth for "the container is gone" — it must
   * clean up the event stream, reset container sequence tracking, and
   * transition any stale active status to idle.
   *
   * In the normal flow the agent sends a status:idle event before the
   * container sleeps, so this is a no-op. But if the container dies
   * unexpectedly (crash, OOM, platform kill) while the agent is active,
   * this is the only signal — without it the session would be stuck in
   * "running" forever.
   */
  async onContainerStopped(params?: { exitCode: number; reason: string }): Promise<void> {
    if (params) {
      console.log(`Container stopped: exitCode=${params.exitCode} reason=${params.reason}`);
    }

    this.closeEventStream();

    // The container is gone — always transition to "stopped" so the UI
    // reflects that the next message will require a cold start.
    await this.updateStatus("stopped");
    this.broadcastToWebSockets({ type: "status", status: "stopped" });
  }

  /**
   * Called by AgentContainer.onActivityExpired() when the workspace snapshot
   * could not be saved to R2 after all retries.
   *
   * This is a terminal failure — without a snapshot, the session cannot be
   * resumed. Transition to "error" and notify the user immediately.
   * Also cleans up any stale R2 snapshot so a future resume attempt doesn't
   * try to restore inconsistent state.
   */
  async onSnapshotSaveFailed(): Promise<void> {
    console.error("Snapshot save failed — session is no longer resumable");

    // Clean up any stale R2 snapshot from a previous cycle
    try {
      await this.env.SNAPSHOTS.delete(
        `workspace-snapshots/${this.ctx.id.toString()}/snapshot.tar.zst`
      );
    } catch (err) {
      console.error("Failed to delete stale R2 snapshot:", err);
    }

    await this.updateStatus("error");
    this.broadcastError(
      "Failed to save workspace snapshot. This session can no longer be resumed — any unsaved work may be lost."
    );
    this.broadcastToWebSockets({ type: "status", status: "error" });
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

    // Send current session status and config — the session metadata is authoritative.
    const currentSession = await this.getSession();
    const currentStatus = (currentSession?.status as SessionStatus) ?? "idle";
    server.send(JSON.stringify({ type: "status", status: currentStatus } satisfies SessionServerMessage));
    if (currentSession) {
      server.send(JSON.stringify({
        type: "config",
        provider: currentSession.provider,
        model: currentSession.model,
        thinkingLevel: (currentSession.thinkingLevel ?? "high") as "off" | "low" | "medium" | "high" | "xhigh",
      } satisfies SessionServerMessage));
    }

    // Mark end of replay
    server.send(JSON.stringify({ type: "caught_up", lastSeq: this.seq } satisfies SessionServerMessage));

    // If the container should be active but the event stream was lost
    // (e.g. after DO hibernation), reconnect it so the browser receives
    // live updates. Falls back to idle if the container is unreachable.
    const ACTIVE: Set<string> = new Set(["starting", "running", "resuming"]);
    if (ACTIVE.has(currentStatus) && !this.containerWs) {
      this.ctx.waitUntil((async () => {
        try {
          await this.connectEventStream(this.container);
        } catch {
          await this.updateStatus("stopped");
          this.broadcastToWebSockets({ type: "status", status: "stopped" });
        }
      })());
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;

    let data: SessionClientMessage;
    try { data = JSON.parse(message) as SessionClientMessage; } catch { return; }

    switch (data.type) {
      case "message": return this.handleUserMessage(
        data.text,
        data.template,
        data.originalText,
      );
      case "stop":      return this.handleStop();
      case "configure": return this.handleConfigure(data.provider, data.model, data.thinkingLevel);
      case "steer":     return this.handleSteer(data.text);
    }
  }

  async webSocketClose(): Promise<void> { /* Hibernation API manages sockets */ }
  async webSocketError(): Promise<void> { /* Hibernation API manages sockets */ }

  // ═══════════════════════════════════════════════════════════════════════
  // Command Handlers
  // ═══════════════════════════════════════════════════════════════════════

  private async handleUserMessage(
    text: string,
    template?: { slug: string; name: string },
    originalText?: string,
  ): Promise<void> {
    // 1. Persist user message — store original text + template metadata for UI display.
    //    The full expanded text goes only to the container.
    const eventData = template
      ? { type: "user_message", text: originalText ?? "", template: { slug: template.slug, name: template.name } }
      : { type: "user_message", text };

    const persisted = this.appendEvents([{
      source: "user",
      eventType: "message",
      data: eventData,
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

    // 4. Send message to container — always send the full expanded text
    try {
      await this.container.sendMessage(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.broadcastError(msg);
      await this.updateStatus("error");
      this.broadcastToWebSockets({ type: "status", status: "error" });
    }
  }

  private async handleConfigure(provider: string, model: string, thinkingLevel?: string): Promise<void> {
    const session = await this.getSession();
    if (!session) {
      this.broadcastError("No session found");
      return;
    }

    // 1. Resolve credentials for the new provider
    let apiKey: string;
    let credentialType: string | undefined;
    let refreshToken: string | undefined;
    let expiresAt: string | undefined;
    let oauthProviderId: string | undefined;
    try {
      if (!session.userDOId) throw new Error("No userDOId");
      const userDO = this.env.USER_DO.get(
        this.env.USER_DO.idFromString(session.userDOId),
      );
      const credentials = await userDO.listProviderCredentials();
      const cred =
        credentials.find(c => c.provider === provider && c.apiKey) ??
        credentials.find(c => c.provider === provider && c.accessToken);
      if (!cred) throw new Error(`No credentials for provider: ${provider}`);
      apiKey = (cred.apiKey ?? cred.accessToken)!;
      credentialType = cred.credentialType;
      if (cred.credentialType === "oauth") {
        refreshToken = cred.refreshToken ?? undefined;
        expiresAt = cred.expiresAt ?? undefined;
        oauthProviderId = cred.provider;
      }
    } catch (err) {
      this.broadcastError(err instanceof Error ? err.message : String(err));
      return;
    }

    // Resolve effective thinking level — use provided value or keep existing
    const effectiveThinkingLevel = thinkingLevel ?? session.thinkingLevel ?? "high";

    // 2. Update session metadata (persisted — survives container sleep/wake)
    await this.updateProviderModel(provider, model, effectiveThinkingLevel);

    // 3. Sync to UserDO session index (provider/model only — thinkingLevel is session-scoped)
    if (session.userDOId) {
      const userDO = this.env.USER_DO.get(
        this.env.USER_DO.idFromString(session.userDOId),
      );
      userDO.updateSessionProviderModel(this.ctx.id.toString(), provider, model)
        .catch(err => console.error("syncProviderModel to UserDO failed:", err));
    }

    // 4. If container is alive, reconfigure it (best-effort)
    try {
      const state = await this.container.getState();
      if (state.status !== "stopped" && state.status !== "stopped_with_code") {
        await this.container.configure({
          provider, model, apiKey, thinkingLevel: effectiveThinkingLevel,
          credentialType, refreshToken, expiresAt, oauthProviderId,
        });
      }
    } catch {
      // Container unreachable — OK, next resume reads from sessionMetaTable
    }

    // 5. Broadcast config change to all connected browsers
    this.broadcastToWebSockets({
      type: "config",
      provider,
      model,
      thinkingLevel: effectiveThinkingLevel as "off" | "low" | "medium" | "high" | "xhigh",
    });
  }

  private async handleStop(): Promise<void> {
    try {
      await this.container.stop();
    } catch {
      // Container might already be dead — that's fine
    }
    await this.updateStatus("idle");
    this.broadcastToWebSockets({ type: "status", status: "idle" });
  }

  private async handleSteer(text: string): Promise<void> {
    try {
      await this.container.steer(text);
    } catch (err) {
      this.broadcastError(err instanceof Error ? err.message : String(err));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Container Lifecycle
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Ensure the container is running and the event stream is connected.
   * Uses a single resume path for both first-start and wake-from-sleep:
   * /resume with empty history on a fresh container is equivalent to /start.
   */
  private async ensureContainerRunning(): Promise<void> {
    // Check if container needs (re)starting
    let needsResume = false;
    try {
      const state = await this.container.getState();

      // If container is still shutting down, wait for it to fully stop
      if (state.status === "stopping") {
        await this.waitForContainerStopped(this.container);
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
      const session = await this.getSession();
      if (!session) throw new Error("No session");

      // Show "Starting" for first start, "Resuming" for wake-from-sleep
      const hasHistory = this.getConversationHistory().length > 0;
      const status: SessionStatus = hasHistory ? "resuming" : "starting";
      await this.updateStatus(status);
      this.broadcastToWebSockets({ type: "status", status });

      await this.resumeContainer(session, this.container);
    }

    // Ensure event stream is connected
    if (!this.containerWs) {
      await this.connectEventStream(this.container);
    }
  }

  /**
   * Wait for a container in "stopping" state to fully stop.
   * The container may be finishing its onActivityExpired snapshot.
   */
  private async waitForContainerStopped(
    container: ContainerHandle,
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
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const status = await this.getStatus();
      if (status === "idle") return;
      if (status === "error") {
        throw new Error("Container failed to start");
      }
      if (status === "stopped") {
        throw new Error("Container stopped unexpectedly during startup");
      }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error("Timed out waiting for container to be ready");
  }

  /**
   * Resume the container session (first-start or wake-from-sleep).
   * Works for both cases: fresh container gets empty history + no snapshot,
   * which is equivalent to a first start (clone repo, configure, idle).
   */
  private async resumeContainer(
    session: NonNullable<Awaited<ReturnType<typeof this.getSession>>>,
    container: ContainerHandle
  ): Promise<void> {
    if (!session.userDOId) throw new Error("No userDOId for resume");

    // Ensure container knows which SessionDO to notify on stop (idempotent)
    await container.bindToSession(this.ctx.id.toString());

    // 1. Resolve fresh credentials (including OAuth metadata for token refresh)
    const { apiKey, githubToken, secrets, credentialType, refreshToken, expiresAt, oauthProviderId } = await this.resolveCredentials(session);

    // 2. Rebuild conversation history
    const messages = this.getConversationHistory();

    // 3. Check for R2 snapshot
    const snapshotKey = `workspace-snapshots/${this.ctx.id.toString()}/snapshot.tar.zst`;
    const hasSnapshot = await this.env.SNAPSHOTS.head(snapshotKey) !== null;

    // 4. POST /resume (with retry for container startup)
    const repoUrl = `https://github.com/${session.projectOwner}/${session.projectRepo}.git`;
    await this.resumeWithRetry(container, {
      provider: session.provider,
      model: session.model,
      apiKey,
      repoUrl,
      token: githubToken,
      secrets: Object.keys(secrets).length > 0 ? secrets : undefined,
      messages,
      workspaceRestored: hasSnapshot,
      thinkingLevel: session.thinkingLevel ?? "high",
      credentialType,
      refreshToken,
      expiresAt,
      oauthProviderId,
    });

    console.log(`Session resumed (${messages.length} messages restored)`);

    // 5. Restore workspace from R2 if snapshot exists.
    // This MUST succeed — the container skipped cloning because we told it
    // the workspace would be restored. If this fails, the session is broken.
    if (hasSnapshot) {
      try {
        await this.restoreWorkspaceFromR2(container, snapshotKey, repoUrl, githubToken);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to restore workspace snapshot after multiple attempts. ` +
          `This session cannot continue. (${detail})`
        );
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Event Stream (ephemeral WS to container)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Open the ephemeral event WS to the container.
   * Retries during container startup.
   */
  private async connectEventStream(container: ContainerHandle): Promise<void> {
    if (this.containerWs) return;

    let ws: WebSocket | null = null;
    for (let i = 0; i < 20; i++) {
      try {
        ws = await container.connectWebSocket();
        break;
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

    let envelope: { event: unknown; timestamp: string };
    try {
      const raw: unknown = JSON.parse(event.data);
      if (typeof raw === "object" && raw !== null && "type" in raw && (raw as Record<string, unknown>).type === "pong") return;
      envelope = raw as typeof envelope;
    } catch { return; }

    const agentEvent = envelope.event as Record<string, unknown>;
    const eventType = (agentEvent?.type as string) ?? "unknown";

    // credential_update: internal event from container when it refreshes an OAuth token.
    // Persist the new credential to UserDO so future resumes use the fresh token.
    // Not persisted to SQLite, not broadcast to browsers.
    if (eventType === "credential_update") {
      this.handleCredentialUpdate(agentEvent);
      return;
    }

    // Streaming events (message_update, tool_execution_update) are ephemeral:
    // broadcast live to connected browsers but don't persist to SQLite.
    // On replay, the frontend reconstructs content from message_end / tool_execution_end.
    const EPHEMERAL_EVENTS: ReadonlySet<string> = new Set(["message_update", "tool_execution_update"]);

    if (EPHEMERAL_EVENTS.has(eventType)) {
      this.broadcastToWebSockets({
        type: "event", seq: 0, source: "agent",
        eventType, data: agentEvent,
      });
      return;
    }

    // Persist to SQLite
    const persisted = this.appendEvents([{
      source: "agent",
      eventType,
      data: agentEvent,
    }]);

    // Update session status if this is a container status event
    if (eventType === "status" && agentEvent.status) {
      const newStatus = this.containerStatusToSessionStatus(agentEvent.status as string);
      if (newStatus) {
        this.updateStatus(newStatus).catch(() => {});
        this.broadcastToWebSockets({
          type: "status",
          status: newStatus,
          ...(agentEvent.error ? { error: agentEvent.error as string } : {}),
        });

        // Close event stream on terminal states
        if (newStatus === "error") {
          this.closeEventStream();
        }
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
  // Container Helpers
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Resume the container with retry for startup.
   * Retries on transient errors (404, 503, platform failures).
   */
  private async resumeWithRetry(
    container: ContainerHandle,
    params: Parameters<ContainerHandle["resume"]>[0],
    maxRetries = 15
  ): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        await container.resume(params);
        return;
      } catch (err) {
        if (err instanceof ContainerError && err.isTransient) {
          if (i === maxRetries - 1) throw new Error(`/resume failed after retries: ${err.status} ${err.body}`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        if (err instanceof ContainerError) throw err;
        if (i === maxRetries - 1) throw new Error("/resume unavailable after retries");
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
  }): Promise<{
    apiKey: string;
    githubToken: string;
    secrets: Record<string, string>;
    credentialType?: string;
    refreshToken?: string;
    expiresAt?: string;
    oauthProviderId?: string;
  }> {
    if (!session.userDOId) throw new Error("No userDOId");

    const userDO = this.env.USER_DO.get(
      this.env.USER_DO.idFromString(session.userDOId)
    );

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

    // OAuth metadata (for token refresh in the container)
    const oauthMeta = cred.credentialType === "oauth"
      ? {
          credentialType: cred.credentialType,
          refreshToken: cred.refreshToken ?? undefined,
          expiresAt: cred.expiresAt ?? undefined,
          oauthProviderId: cred.provider,
        }
      : { credentialType: cred.credentialType };

    return { apiKey, githubToken, secrets, ...oauthMeta };
  }

  /**
   * Handle a credential_update event from the container.
   * Persists refreshed OAuth tokens to UserDO so future resumes use the fresh token.
   */
  private handleCredentialUpdate(event: Record<string, unknown>): void {
    const provider = event.provider as string | undefined;
    const accessToken = event.accessToken as string | undefined;
    const refreshToken = event.refreshToken as string | undefined;
    const expiresAt = event.expiresAt as string | undefined;

    if (!provider || !accessToken) {
      console.error("credential_update missing required fields:", event);
      return;
    }

    const row = this.db
      .select({ userDOId: sessionMetaTable.userDOId })
      .from(sessionMetaTable)
      .get();
    if (!row?.userDOId) {
      console.error("credential_update: no userDOId");
      return;
    }

    const userDO = this.env.USER_DO.get(
      this.env.USER_DO.idFromString(row.userDOId),
    );

    userDO
      .upsertProviderCredential({
        provider,
        credentialType: "oauth",
        accessToken,
        refreshToken,
        expiresAt,
      })
      .then(() => console.log(`Persisted refreshed credential for ${provider}`))
      .catch((err) => console.error(`Failed to persist refreshed credential for ${provider}:`, err));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // R2 Workspace Snapshots
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Restore the workspace from an R2 snapshot.
   * Retries each step (R2 GET, container restore, remote update) up to 3 times.
   * Throws on failure — callers must handle the error (session is broken).
   */
  private async restoreWorkspaceFromR2(
    container: ContainerHandle,
    snapshotKey: string,
    repoUrl: string,
    githubToken: string
  ): Promise<void> {
    // 1. Fetch snapshot from R2 with retries
    const buffer = await withRetry(
      async () => {
        const obj = await this.env.SNAPSHOTS.get(snapshotKey);
        if (!obj) throw new Error(`No R2 snapshot found at ${snapshotKey}`);
        return obj.arrayBuffer();
      },
      { maxAttempts: 3, label: "restore-r2-get" },
    );

    console.log(`Restoring workspace: ${snapshotKey} (${buffer.byteLength} bytes)`);

    // 2. Send snapshot to container with retries
    await withRetry(
      () => container.restoreWorkspace(buffer),
      { maxAttempts: 3, label: "restore-container-post" },
    );

    // 3. Update git remote with fresh token with retries
    await withRetry(
      () => container.updateRemote(repoUrl, githubToken),
      { maxAttempts: 3, label: "restore-update-remote" },
    );

    console.log("Workspace restored from R2 snapshot");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Event Persistence
  // ═══════════════════════════════════════════════════════════════════════

  private appendEvents(
    events: Array<{
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
      data: JSON.parse(row.data) as unknown,
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

  private syncStatusToUserDO(status: SessionStatus): void {
    const row = this.db
      .select({ userDOId: sessionMetaTable.userDOId })
      .from(sessionMetaTable)
      .get();
    if (!row?.userDOId) return;

    const userDO = this.env.USER_DO.get(
      this.env.USER_DO.idFromString(row.userDOId)
    );

    userDO
      .updateSessionStatus(this.ctx.id.toString(), status)
      .catch(err => console.error("syncStatusToUserDO failed:", err));
  }

  /**
   * Explicitly convert a container status string to a session status.
   * Container status is an internal concern — only recognized values
   * are mapped; unknown container statuses are ignored.
   */
  private containerStatusToSessionStatus(containerStatus: string): SessionStatus | null {
    switch (containerStatus) {
      case "idle":     return "idle";
      case "starting": return "starting";
      case "running":  return "running";
      case "error":    return "error";
      default:         return null;
    }
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
