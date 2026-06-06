// Wraps pi (@earendil-works/pi-coding-agent) per logical session id.
//
// Each session is a directory under `stateDir` named by the opaque
// sessionId. Pi writes its JSONL session file there; on resume we hand
// the same dir back to `SessionManager.continueRecent`. Directory
// existence is the only persisted index — no sidecar files.
//
// Durability is per-turn: on agent_end the whole /workspace tree is
// archived and uploaded to R2 via the worker (save-state.ts).
// Logging is sparse on purpose: no user messages, model replies, file
// contents, or shell output ever appear in fields.

import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { execSync } from "node:child_process";

import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  createBashToolDefinition,
  createLocalBashOperations,
  type AgentSession,
  type AgentSessionEvent,
  type BashOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { fmtErr, log, logError } from "./log.js";
import { createCloseSessionTool } from "./close-session-tool.js";
import type { PromptAttachment } from "./app.js";
import { saveState } from "./save-state.js";

const PROVIDER = "anthropic";
const MODEL_ID = "claude-sonnet-4-5-20250929";
const ATTACHMENTS_DIR = "/workspace/attachments";

// pi's bash tool takes an optional per-command timeout (seconds) but has
// no default, so a hung command can block an agent turn forever. We
// enforce a default and cap any agent-specified value.
const DEFAULT_BASH_TIMEOUT_SECS = 300; // 5 min
const MAX_BASH_TIMEOUT_SECS = 1800; // 30 min

// Resolve the timeout (seconds) actually applied to a bash command:
// fall back to the default when unset/non-positive, and cap to the max
// so the agent can't disable the safety net with a huge value.
export const clampBashTimeout = (
  requested: number | undefined,
  opts: { defaultSecs: number; maxSecs: number },
): number => {
  const base =
    typeof requested === "number" && requested > 0
      ? requested
      : opts.defaultSecs;
  return Math.min(base, opts.maxSecs);
};

// Wrap a bash operations backend so every command gets a clamped timeout.
// On timeout pi's local backend throws `timeout:<secs>`; we invoke
// `onTimeout` (for an anonymous metric — no command text) and re-throw so
// the bash tool still surfaces "Command timed out after N seconds" to the
// agent.
export const createTimeoutBashOperations = (
  base: BashOperations,
  onTimeout: () => void,
  opts: { defaultSecs: number; maxSecs: number },
): BashOperations => ({
  exec: async (command, cwd, options) => {
    const timeout = clampBashTimeout(options.timeout, opts);
    try {
      return await base.exec(command, cwd, { ...options, timeout });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("timeout:")) {
        onTimeout();
      }
      throw err;
    }
  },
});

// Reduce an untrusted client filename to a safe basename: no path
// separators, no parent-dir traversal. Empty results fall back to "file".
const sanitizeFilename = (name: string): string => {
  const base = basename(name).replace(/[/\\]/g, "").replace(/\.\.+/g, ".").trim();
  return base.length > 0 ? base : "file";
};

// Persist attachments under `attachmentsDir`, resolving name collisions
// with a short random prefix. Returns the on-disk paths and their MIME types.
export const writeAttachments = (
  attachmentsDir: string,
  attachments: PromptAttachment[],
): { path: string; mimeType: string }[] => {
  mkdirSync(attachmentsDir, { recursive: true });
  const written: { path: string; mimeType: string }[] = [];
  for (const att of attachments) {
    const safe = sanitizeFilename(att.filename);
    let target = join(attachmentsDir, safe);
    if (existsSync(target)) {
      target = join(attachmentsDir, `${randomUUID().slice(0, 8)}_${safe}`);
    }
    const data = Buffer.from(att.dataBase64, "base64");
    writeFileSync(target, data);
    written.push({ path: target, mimeType: att.mimeType });
  }
  return written;
};

const NOTES_DIR = "/workspace/notes";

// Detect archive type from magic bytes.
const detectArchiveType = (data: Buffer): "zip" | "gzip" | "unknown" => {
  // ZIP: starts with PK (0x50 0x4B)
  if (data[0] === 0x50 && data[1] === 0x4b) return "zip";
  // GZIP: starts with 0x1F 0x8B
  if (data[0] === 0x1f && data[1] === 0x8b) return "gzip";
  return "unknown";
};

// Extract a base64-encoded archive (zip or tar.gz) into /workspace/notes/.
// Returns the number of files extracted.
export const importNotes = (dataBase64: string): number => {
  mkdirSync(NOTES_DIR, { recursive: true });

  const data = Buffer.from(dataBase64, "base64");
  const archiveType = detectArchiveType(data);
  log("import_notes_start", { size: data.length, type: archiveType });

  if (archiveType === "unknown") {
    throw new Error("Unsupported archive format. Use .zip or .tar.gz");
  }

  const ext = archiveType === "zip" ? ".zip" : ".tar.gz";
  const tmpFile = `/tmp/import-${randomUUID()}${ext}`;

  try {
    writeFileSync(tmpFile, data);

    let output: string;
    if (archiveType === "zip") {
      output = execSync(`unzip -o "${tmpFile}" -d "${NOTES_DIR}"`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      output = execSync(`tar -xzvf "${tmpFile}" -C "${NOTES_DIR}"`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    }

    // Count extracted files
    const lines = output.split("\n").filter((l) => l.trim().length > 0);
    let filesExtracted: number;
    if (archiveType === "zip") {
      filesExtracted = lines.filter(
        (l) => l.includes("inflating:") || l.includes("extracting:"),
      ).length;
    } else {
      // tar -v outputs one line per file
      filesExtracted = lines.filter((l) => !l.endsWith("/")).length;
    }

    log("import_notes_done", { files_extracted: filesExtracted });
    return filesExtracted;
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      // Ignore cleanup errors
    }
  }
};

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  [key: string]: unknown;
}

interface AgentMessageLike {
  role: string;
  content?: ContentBlock[];
  stopReason?: string;
  [key: string]: unknown;
}

const extractAssistantText = (msg: AgentMessageLike | undefined): string => {
  if (!msg?.content) return "";
  return msg.content
    .filter((b): b is ContentBlock & { text: string } =>
      b.type === "text" && typeof b.text === "string",
    )
    .map((b) => b.text)
    .filter((s) => s.length > 0)
    .join("\n")
    .trim();
};

// Trace-level events only: tool boundaries, stream errors, and an
// agent_end counter. Per-message and per-chunk events are dropped.
const logEvent = (
  sessionId: string,
  event: AgentSessionEvent,
): void => {
  switch (event.type) {
    case "message_update": {
      const sub = event.assistantMessageEvent;
      if (sub.type === "error") {
        log("stream_error", {
          session_id: sessionId,
          reason: sub.reason,
          error_message: sub.error.errorMessage ?? null,
        });
      }
      break;
    }
    case "tool_execution_start":
      log("tool_start", {
        session_id: sessionId,
        tool_name: event.toolName,
        tool_call_id: event.toolCallId,
      });
      break;
    case "tool_execution_end": {
      log("tool_end", {
        session_id: sessionId,
        tool_name: event.toolName,
        is_error: event.isError,
      });
      break;
    }
    case "agent_end": {
      const messages = event.messages as unknown as AgentMessageLike[];
      log("agent_end", {
        session_id: sessionId,
        total_msgs: messages.length,
      });
      break;
    }
    default:
      break;
  }
};

interface SessionState {
  session: AgentSession;
}

export type MessageEndFn = (sessionId: string, text: string) => Promise<void>;

export interface SessionCostStats {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export type AgentEndFn = (sessionId: string, willRetry: boolean, stats: SessionCostStats | null) => Promise<void>;

export interface SessionBridgeOptions {
  cwd: string;
  /** Parent dir; each session becomes a subdir named by sessionId. */
  stateDir: string;
  /** Base URL for callback endpoints (e.g. http://zero.worker). */
  callbackUrl: string;
  /** Clerk user ID for callback payloads. */
  clerkUserId: string;
}

export interface SessionBridge {
  createSession: (sessionId: string) => Promise<void>;
  promptSession: (sessionId: string, text: string, attachments?: PromptAttachment[]) => Promise<boolean>;
  abortSession: (sessionId: string) => Promise<"aborted" | "nothing_running" | "unknown">;
  getSessionStatus: (sessionId: string) => Promise<{ model: string; contextPercent: number | null } | null>;
  importNotes: (dataBase64: string) => Promise<number>;
}

export const createSessionBridge = (
  postMessageEnd: MessageEndFn,
  postAgentEnd: AgentEndFn,
  opts: SessionBridgeOptions,
): SessionBridge => {
  const { cwd, stateDir, callbackUrl, clerkUserId } = opts;
  const workspaceDir = "/workspace";
  const sessions = new Map<string, SessionState>();

  const sessionDirFor = (sessionId: string): string =>
    join(stateDir, sessionId);

  const buildSession = async (
    sessionId: string,
    sessionManager: SessionManager,
  ): Promise<SessionState> => {
    const authStorage = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const model = modelRegistry.find(PROVIDER, MODEL_ID);
    if (!model) {
      throw new Error(`model ${PROVIDER}/${MODEL_ID} not found in registry`);
    }

    const closeSessionTool = createCloseSessionTool({
      callbackUrl,
      getSessionId: () => sessionId,
      getClerkUserId: () => clerkUserId,
    });

    // Custom bash tool that enforces a default/capped timeout. Registered
    // as a custom tool named "bash", it overrides pi's built-in bash by
    // name while leaving read/edit/write untouched.
    const bashOperations = createTimeoutBashOperations(
      createLocalBashOperations(),
      () => log("bash_timeout", { session_id: sessionId }),
      { defaultSecs: DEFAULT_BASH_TIMEOUT_SECS, maxSecs: MAX_BASH_TIMEOUT_SECS },
    );
    // Concrete bash definition widened to the generic ToolDefinition that
    // `customTools` expects (same pattern as close_session via defineTool).
    const bashTool = createBashToolDefinition(cwd, {
      operations: bashOperations,
    }) as unknown as ToolDefinition;

    const { session } = await createAgentSession({
      cwd,
      modelRegistry,
      authStorage,
      sessionManager,
      model,
      thinkingLevel: "high",
      customTools: [bashTool, closeSessionTool],
    });

    const state: SessionState = {
      session,
    };

    session.subscribe((event) => {
      logEvent(sessionId, event);

      if (event.type === "message_end") {
        const msg = event.message as unknown as AgentMessageLike;
        if (msg.role !== "assistant") return;
        const text = extractAssistantText(msg);
        if (text.length > 0) {
          log("post_message_end", { session_id: sessionId, len: text.length });
          void postMessageEnd(sessionId, text).catch((err: unknown) => {
            logError("post_message_end_threw", {
              session_id: sessionId,
              error: fmtErr(err),
            });
          });
        }
        return;
      }

      if (event.type === "agent_end") {
        let costStats: SessionCostStats | null = null;
        if (!event.willRetry) {
          try {
            const stats = state.session.getSessionStats();
            const model = state.session.model;
            costStats = {
              model: model ? `${model.provider}/${model.id}` : "unknown",
              inputTokens: stats.tokens.input,
              outputTokens: stats.tokens.output,
              cacheReadTokens: stats.tokens.cacheRead,
              cacheWriteTokens: stats.tokens.cacheWrite,
              costUsd: stats.cost,
            };
          } catch (err) {
            logError("get_session_stats_failed", {
              session_id: sessionId,
              error: fmtErr(err),
            });
          }
        }
        log("post_agent_end", { session_id: sessionId, will_retry: event.willRetry });
        void postAgentEnd(sessionId, event.willRetry, costStats).catch((err: unknown) => {
          logError("post_agent_end_threw", {
            session_id: sessionId,
            error: fmtErr(err),
          });
        });
        void saveState(workspaceDir, callbackUrl, clerkUserId).catch((err: unknown) => {
          logError("save_state_threw", {
            session_id: sessionId,
            error: fmtErr(err),
          });
        });
        return;
      }
    });

    return state;
  };

  const createSession = async (sessionId: string): Promise<void> => {
    const dir = sessionDirFor(sessionId);
    mkdirSync(dir, { recursive: true });
    log("create_session", { session_id: sessionId, cwd, dir });

    const sessionManager = SessionManager.create(cwd, dir);
    const state = await buildSession(sessionId, sessionManager);
    sessions.set(sessionId, state);
  };

  // Resume a session from disk; undefined if the directory is missing.
  const resumeSession = async (
    sessionId: string,
  ): Promise<SessionState | undefined> => {
    const dir = sessionDirFor(sessionId);
    if (!existsSync(dir)) return undefined;

    log("resume_session", { session_id: sessionId, dir });
    const sessionManager = SessionManager.continueRecent(cwd, dir);
    const state = await buildSession(sessionId, sessionManager);
    sessions.set(sessionId, state);
    return state;
  };


  const promptSession = async (
    sessionId: string,
    text: string,
    attachments: PromptAttachment[] = [],
  ): Promise<boolean> => {
    let state = sessions.get(sessionId);
    if (!state) {
      state = await resumeSession(sessionId);
    }
    if (!state) return false;

    let promptText = text;
    if (attachments.length > 0) {
      const written = writeAttachments(ATTACHMENTS_DIR, attachments);
      for (const w of written) {
        log("attachment_saved", { session_id: sessionId, path: w.path });
      }
      const notes = written
        .map((w) => `[File saved to ${w.path} (${w.mimeType})]`)
        .join("\n");
      promptText = text.length > 0 ? `${text}\n\n${notes}` : notes;
    }

    log("prompt", { session_id: sessionId, len: promptText.length });
    void state.session.prompt(promptText, { streamingBehavior: "steer" }).catch((err: unknown) => {
      const formatted = fmtErr(err);
      logError("prompt_threw", { session_id: sessionId, error: formatted });
      void postMessageEnd(sessionId, `⚠️ ${formatted.message}`);
      void postAgentEnd(sessionId, false, null);
    });
    return true;
  };

  const abortSession = async (
    sessionId: string,
  ): Promise<"aborted" | "nothing_running" | "unknown"> => {
    let state = sessions.get(sessionId);
    if (!state) {
      state = await resumeSession(sessionId);
    }
    if (!state) return "unknown";

    if (!state.session.isStreaming) return "nothing_running";

    await state.session.abort();
    log("abort_session", { session_id: sessionId });
    return "aborted";
  };

  const getSessionStatus = async (
    sessionId: string,
  ): Promise<{ model: string; contextPercent: number | null } | null> => {
    let state = sessions.get(sessionId);
    if (!state) {
      state = await resumeSession(sessionId);
    }
    if (!state) return null;

    const model = state.session.model;
    const modelStr = model ? `${model.provider}/${model.id}` : "unknown";
    const usage = state.session.getContextUsage();
    const contextPercent = usage?.percent ?? null;
    return { model: modelStr, contextPercent };
  };

  return {
    createSession,
    promptSession,
    abortSession,
    getSessionStatus,
    importNotes: (dataBase64: string) => Promise.resolve(importNotes(dataBase64)),
  };
};
