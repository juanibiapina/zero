/**
 * SessionWrapper — Manages pi agent lifecycle.
 *
 * Uses agentLoop from pi-agent-core + codingTools from pi-coding-agent.
 * Auto-stops existing session on new start. Clones repo before starting.
 */

import { execSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { getModel } from "@mariozechner/pi-ai";
import type { Message } from "@mariozechner/pi-ai";
import { agentLoop } from "@mariozechner/pi-agent-core";
import type { AgentEvent, AgentContext, AgentMessage } from "@mariozechner/pi-agent-core";
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
  private _apiKey: string | null = null;
  private _thinkingLevel: string = "high";

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

    // Map thinking level to pi-ai's reasoning option:
    // "off" → undefined (disables thinking), else pass directly
    const reasoning = this._thinkingLevel === "off"
      ? undefined
      : (this._thinkingLevel as "low" | "medium" | "high");

    const config = {
      model,
      reasoning,
      apiKey: this._apiKey ?? undefined,
      signal: this._abortController.signal,
      // Identity converter — we only use standard user/assistant/toolResult messages
      convertToLlm: (msgs: AgentMessage[]) => msgs.filter(
        (m): m is Message => m.role === "user" || m.role === "assistant" || m.role === "toolResult"
      ),
    };

    const eventStream = agentLoop(
      [userMessage],
      context,
      config,
      this._abortController.signal,
    );

    this._status = "running";
    this._eventBuffer.addEvent({ type: "status", status: this._status });

    this._runPromise = (async () => {
      try {
        for await (const event of eventStream as AsyncIterable<AgentEvent>) {
          this._eventBuffer.addEvent(event);

          if (event.type === "agent_end") {
            // Accumulate messages from this turn for follow-up context
            // Filter to standard LLM messages (agent_end may include custom AgentMessage types)
            const llmMessages = event.messages.filter(
              (m): m is Message => m.role === "user" || m.role === "assistant" || m.role === "toolResult"
            );
            this._messages.push(...llmMessages);

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
    thinkingLevel?: string,
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
      let workDir: string;
      if (workspaceRestored) {
        workDir = WORKSPACE_DIR;
        mkdirSync(workDir, { recursive: true });
        console.log("Skipping clone — workspace will be restored from R2 snapshot");
        
        // Set up user git authentication for restored workspace
        // (cloneRepo already handles this for the clone case)
        this.setupUserGitAuthentication(workDir, repoUrl);
      } else {
        workDir = this.cloneRepo(repoUrl, token);
      }

      // Configure provider and model
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
      this._apiKey = apiKey;
      this._thinkingLevel = thinkingLevel ?? "high";

      // Restore conversation history
      this._messages = messages;

      // Ready for follow-up messages
      this._status = "idle";
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
   * Works when idle (after resume completes or a turn finishes).
   */
  async sendMessage(text: string): Promise<void> {
    if (this._status !== "idle") {
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
   * Reconfigure provider/model/apiKey.
   *
   * Safe to call in any state (idle or running). The new model is stored
   * immediately, but runAgentLoop() snapshots this._model at turn start,
   * so a running turn continues with the old model. The next turn uses
   * the new one.
   */
  async configure(provider: string, modelId: string, apiKey: string, thinkingLevel?: string): Promise<void> {
    if (!this._workDir) {
      throw new Error("Session not initialized — cannot configure before resume");
    }

    const model = getModel(
      provider as Parameters<typeof getModel>[0],
      modelId as never,
    );
    if (!model) {
      throw new Error(`Unknown model: ${provider}/${modelId}`);
    }

    this._model = model;
    this._apiKey = apiKey;
    if (thinkingLevel !== undefined) {
      this._thinkingLevel = thinkingLevel;
    }
    console.log(`Session reconfigured: ${provider}/${modelId} thinking=${this._thinkingLevel}`);
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
