/**
 * SessionWrapper — Manages pi agent lifecycle.
 *
 * Uses agentLoop from pi-ai + codingTools from pi-coding-agent.
 * Auto-stops existing session on new start. Clones repo before starting.
 */

import { execSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import {
  agentLoop,
  setApiKey,
  getModel,
  stream as streamFn,
} from "@mariozechner/pi-ai";
import type { AgentEvent, AgentContext, QueuedMessage, Message } from "@mariozechner/pi-ai";
import { codingTools } from "@mariozechner/pi-coding-agent";
import type { EventBuffer } from "./events.js";
import type { SessionStatus } from "./types.js";

const WORKSPACE_DIR = "/workspace/repo";

export class SessionWrapper {
  private _abortController: AbortController | null = null;
  private _status: SessionStatus = "idle";
  private _error: string | undefined;
  private _eventBuffer: EventBuffer;
  private _runPromise: Promise<void> | null = null;

  // Stored after start() for use by sendMessage()
  private _model: ReturnType<typeof getModel> | null = null;
  private _workDir: string | null = null;

  // Conversation history — accumulated across turns for follow-up context
  private _messages: Message[] = [];

  constructor(eventBuffer: EventBuffer) {
    this._eventBuffer = eventBuffer;
  }

  get status(): SessionStatus {
    return this._status;
  }

  get error(): string | undefined {
    return this._error;
  }

  /**
   * Clone a repo using a GitHub installation token.
   */
  private cloneRepo(repoUrl: string, token: string): string {
    const authedUrl = repoUrl.replace(
      "https://",
      `https://x-access-token:${token}@`
    );

    if (existsSync(WORKSPACE_DIR)) {
      execSync(`rm -rf ${WORKSPACE_DIR}`);
    }
    mkdirSync(WORKSPACE_DIR, { recursive: true });

    console.log(`Cloning ${repoUrl} into ${WORKSPACE_DIR}...`);
    execSync(`git clone --depth 1 ${authedUrl} ${WORKSPACE_DIR}`, {
      stdio: "inherit",
      timeout: 120_000,
    });

    // Strip the token from the remote URL immediately after clone.
    // git stores the full clone URL (including credentials) in .git/config,
    // making the token visible to any tool that reads the remote. Rewrite to
    // the plain HTTPS URL — push auth is handled separately via credential.helper.
    execSync(`git -C ${WORKSPACE_DIR} remote set-url origin ${repoUrl}`);
    
    // TODO: Tech debt - generalize this for other git providers
    // Configure user's GitHub token for subsequent git operations (pull/push)
    this.setupUserGitAuthentication(WORKSPACE_DIR, repoUrl);
    
    console.log("Clone complete.");

    return WORKSPACE_DIR;
  }

  /**
   * Configure git to use user's GitHub token for future operations.
   * Special case for GitHub - TODO: generalize for other providers.
   */
  private setupUserGitAuthentication(workDir: string, repoUrl: string): void {
    // Check if this is a GitHub repository and user has a GitHub token
    const isGitHub = repoUrl.includes('github.com');
    const userGitHubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    
    if (!isGitHub || !userGitHubToken) {
      console.log("No user GitHub token found or not a GitHub repo - skipping user auth setup");
      return;
    }

    try {
      console.log("Setting up user GitHub token authentication...");
      
      // Configure credential helper for GitHub to use user's token
      // This allows pull/push operations to use the user's personal token
      const credentialHelper = `!f() { echo "username=token"; echo "password=${userGitHubToken}"; }; f`;
      execSync(`git -C ${workDir} config credential."https://github.com".helper '${credentialHelper}'`, {
        stdio: "inherit"
      });
      
      // Set user identity if not already configured (for commits)
      try {
        // Check if user.email is already set, if not set a default
        const emailCheck = execSync(`git -C ${workDir} config user.email`, { stdio: "pipe" }).toString().trim();
        if (!emailCheck) {
          execSync(`git -C ${workDir} config user.email "user@zero-app.dev"`, { stdio: "pipe" });
        }
      } catch {
        execSync(`git -C ${workDir} config user.email "user@zero-app.dev"`, { stdio: "pipe" });
      }

      try {
        // Check if user.name is already set, if not set a default
        const nameCheck = execSync(`git -C ${workDir} config user.name`, { stdio: "pipe" }).toString().trim();
        if (!nameCheck) {
          execSync(`git -C ${workDir} config user.name "Zero User"`, { stdio: "pipe" });
        }
      } catch {
        execSync(`git -C ${workDir} config user.name "Zero User"`, { stdio: "pipe" });
      }
      
      console.log("User GitHub authentication configured successfully");
    } catch (err) {
      console.warn("Failed to setup user GitHub authentication:", err);
      // Don't fail the entire clone process for auth setup issues
    }
  }

  /**
   * Run the agent loop with a user message. Fire-and-forget: starts the loop
   * in the background, events flow via EventBuffer.
   */
  private runAgentLoop(
    userMessage: {
      role: "user";
      content: Array<{ type: "text"; text: string }>;
      timestamp: number;
    }
  ): void {
    const model = this._model!;
    const workDir = this._workDir!;

    this._abortController = new AbortController();

    const context: AgentContext = {
      systemPrompt: `You are a coding assistant. You are working in: ${workDir}`,
      messages: [...this._messages],
      tools: codingTools,
    };

    const config = {
      model,
      signal: this._abortController.signal,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getQueuedMessages: async () => [] as QueuedMessage<any>[],
    };

    const eventStream = agentLoop(
      userMessage,
      context,
      config,
      this._abortController.signal,
      streamFn
    );

    this._status = "running";
    this._eventBuffer.addEvent({ type: "status", status: this._status });

    this._runPromise = (async () => {
      try {
        for await (const event of eventStream as AsyncIterable<AgentEvent>) {
          this._eventBuffer.addEvent(event);

          if (event.type === "agent_end") {
            // Accumulate messages from this turn for follow-up context
            this._messages.push(...event.messages);

            // Check if the agent ended due to an API error (e.g. expired OAuth token)
            const lastAssistant = [...event.messages]
              .reverse()
              .find((m) => m.role === "assistant") as
              | { stopReason?: string; errorMessage?: string }
              | undefined;

            if (lastAssistant?.stopReason === "error" && lastAssistant.errorMessage) {
              this._status = "error";
              this._error = lastAssistant.errorMessage;
              this._eventBuffer.addEvent({
                type: "status",
                status: this._status,
                error: this._error,
              });
            } else {
              this._status = "idle";
              this._eventBuffer.addEvent({
                type: "status",
                status: this._status,
              });
            }
          }
        }
      } catch (err) {
        const isAbort =
          err instanceof Error &&
          (err.name === "AbortError" ||
            err.message.includes("aborted"));
        if (!isAbort) {
          this._status = "error";
          this._error =
            err instanceof Error ? err.message : String(err);
          this._eventBuffer.addEvent({
            type: "status",
            status: this._status,
            error: this._error,
          });
        }
      }
    })();
  }

  /**
   * Start a new agent session. Auto-stops any existing session first.
   * If prompt is provided, starts the agent loop immediately.
   * If no prompt, sets up the environment and waits in "ready" state.
   */
  async start(
    provider: string,
    modelId: string,
    apiKey: string,
    prompt: string | undefined,
    repoUrl?: string,
    token?: string
  ): Promise<void> {
    // Auto-stop existing session
    if (this._abortController) {
      await this.stop();
    }

    // Clear state for new session
    this._eventBuffer.clear();
    this._messages = [];
    this._error = undefined;
    this._status = "starting";
    this._eventBuffer.addEvent({ type: "status", status: this._status });

    try {
      // Clone repo if URL provided
      let workDir: string;
      if (repoUrl && token) {
        this._eventBuffer.addEvent({ type: "lifecycle", phase: "cloning" });
        workDir = this.cloneRepo(repoUrl, token);
        this._eventBuffer.addEvent({ type: "lifecycle", phase: "clone_complete" });
      } else {
        workDir = process.cwd();
      }

      // Configure provider and model
      this._eventBuffer.addEvent({ type: "lifecycle", phase: "configuring" });
      setApiKey(provider, apiKey);
      const model = getModel(
        provider as Parameters<typeof getModel>[0],
        modelId as never
      );
      if (!model) {
        throw new Error(`Unknown model: ${provider}/${modelId}`);
      }

      // Set cwd for tools and store setup for sendMessage()
      process.chdir(workDir);
      this._model = model;
      this._workDir = workDir;

      // If no prompt, wait in "ready" state for a message
      if (!prompt) {
        this._status = "ready";
        this._eventBuffer.addEvent({ type: "lifecycle", phase: "ready" });
        this._eventBuffer.addEvent({ type: "status", status: this._status });
        return;
      }

      // Build user message and start agent loop
      const userMessage = {
        role: "user" as const,
        content: [{ type: "text" as const, text: prompt }],
        timestamp: Date.now(),
      };

      this.runAgentLoop(userMessage);
    } catch (err) {
      this._status = "error";
      this._error = err instanceof Error ? err.message : String(err);
      this._eventBuffer.addEvent({
        type: "status",
        status: this._status,
        error: this._error,
      });
      throw err;
    }
  }

  /**
   * Resume a session after container sleep/wake.
   *
   * Similar to start() but restores conversation history instead of running a prompt.
   * After resume, session is "idle" — ready for follow-up messages.
   *
   * When workspaceRestored is true, skips clone — the workspace will be
   * restored from an R2 snapshot via POST /workspace/restore after this returns.
   */
  async resume(
    provider: string,
    modelId: string,
    apiKey: string,
    messages: Message[],
    repoUrl: string,
    token: string,
    workspaceRestored?: boolean,
  ): Promise<void> {
    // Auto-stop existing session
    if (this._abortController) {
      await this.stop();
    }

    // Reset event buffer but keep WS clients registered
    this._eventBuffer.reset();
    this._messages = [];
    this._error = undefined;
    this._status = "starting";
    this._eventBuffer.addEvent({ type: "status", status: this._status });

    try {
      this._eventBuffer.addEvent({ type: "lifecycle", phase: "resuming" });

      let workDir: string;
      if (workspaceRestored) {
        this._eventBuffer.addEvent({ type: "lifecycle", phase: "restoring_workspace" });
        workDir = WORKSPACE_DIR;
        mkdirSync(workDir, { recursive: true });
        console.log("Skipping clone — workspace will be restored from R2 snapshot");
        this._eventBuffer.addEvent({ type: "lifecycle", phase: "workspace_restored" });
        
        // Set up user git authentication for restored workspace
        // (cloneRepo already handles this for the clone case)
        this.setupUserGitAuthentication(workDir, repoUrl);
      } else {
        this._eventBuffer.addEvent({ type: "lifecycle", phase: "cloning" });
        workDir = this.cloneRepo(repoUrl, token);
        this._eventBuffer.addEvent({ type: "lifecycle", phase: "clone_complete" });
      }

      // Configure provider and model
      this._eventBuffer.addEvent({ type: "lifecycle", phase: "configuring" });
      setApiKey(provider, apiKey);
      const model = getModel(
        provider as Parameters<typeof getModel>[0],
        modelId as never
      );
      if (!model) {
        throw new Error(`Unknown model: ${provider}/${modelId}`);
      }

      // Set cwd for tools and store setup for sendMessage()
      process.chdir(workDir);
      this._model = model;
      this._workDir = workDir;

      // Restore conversation history
      this._messages = messages;

      // Ready for follow-up messages
      this._status = "idle";
      this._eventBuffer.addEvent({ type: "lifecycle", phase: "ready" });
      this._eventBuffer.addEvent({ type: "status", status: this._status });
    } catch (err) {
      this._status = "error";
      this._error = err instanceof Error ? err.message : String(err);
      this._eventBuffer.addEvent({
        type: "status",
        status: this._status,
        error: this._error,
      });
      throw err;
    }
  }

  /**
   * Send a message to the session.
   * Works when "ready" (initial prompt) or "idle" (follow-up after a turn completes).
   */
  async sendMessage(text: string): Promise<void> {
    if (this._status !== "ready" && this._status !== "idle") {
      throw new Error(
        `Session not ready for messages (status: ${this._status})`
      );
    }
    if (!this._model || !this._workDir) {
      throw new Error("Session not initialized");
    }

    const userMessage = {
      role: "user" as const,
      content: [{ type: "text" as const, text }],
      timestamp: Date.now(),
    };

    this.runAgentLoop(userMessage);
  }

  /**
   * Steer the agent mid-run (not supported in slice 1).
   */
  async steer(_text: string): Promise<void> {
    throw new Error("Steer not yet supported");
  }

  /**
   * Stop the current session.
   */
  async stop(): Promise<void> {
    if (!this._abortController) {
      return;
    }
    this._abortController.abort();
    this._abortController = null;
    // Wait for the run loop to finish
    if (this._runPromise) {
      await this._runPromise.catch(() => {});
      this._runPromise = null;
    }
    // Transition to idle (not stopped) so the user can send follow-ups after abort
    this._status = "idle";
    this._eventBuffer.addEvent({ type: "status", status: this._status });
  }
}
