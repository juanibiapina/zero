/**
 * ============================================================================
 * session-bridge
 * ============================================================================
 *
 * Wraps pi (@earendil-works/pi-coding-agent) per logical session id.
 *
 * Each session is a directory under `stateDir` named by our (opaque)
 * sessionId. Pi writes its JSONL session file inside that dir; on resume
 * we hand the same dir back to `SessionManager.continueRecent` and pi
 * picks up where it left off. The directory's existence is the only
 * persisted index — no separate sidecar files.
 *
 * Pi resolves the API key from `process.env.ANTHROPIC_API_KEY`, which the
 * container DO injects via `envVars`.
 *
 * Logging is deliberately sparse: prompt-in / tool-in-flight / reply-out
 * with byte counts only. Tool results and message content are never
 * logged so user messages, model replies, file contents, and shell
 * output stay out of the container's `Logs` view.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

import { fmtErr, log, logError } from "./log.js";

const PROVIDER = "anthropic";
const MODEL_ID = "claude-sonnet-4-5-20250929";

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

/**
 * Log only what's needed to trace a request and diagnose failures.
 *
 * Kept: tool_start / tool_end (name + error flag), stream errors,
 * agent_end (count only). Skipped: every per-message and per-stream-chunk
 * event — they fire dozens of times per turn and add nothing useful in
 * production. Tool results and message bodies are never logged.
 */
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
  accumulated: string;
}

export type ReplyFn = (sessionId: string, text: string) => Promise<void>;

export interface SessionBridgeOptions {
  cwd: string;
  /**
   * Directory where each session is stored as a subdirectory named by its
   * (opaque) sessionId. Must be writable.
   */
  stateDir: string;
}

export interface SessionBridge {
  createSession: (sessionId: string) => Promise<void>;
  promptSession: (sessionId: string, text: string) => Promise<boolean>;
}

export const createSessionBridge = (
  postReply: ReplyFn,
  opts: SessionBridgeOptions,
): SessionBridge => {
  const { cwd, stateDir } = opts;
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

    const { session } = await createAgentSession({
      cwd,
      modelRegistry,
      authStorage,
      sessionManager,
      model,
      thinkingLevel: "high",
    });

    const state: SessionState = {
      session,
      accumulated: "",
    };

    session.subscribe((event) => {
      logEvent(sessionId, event);

      if (event.type === "message_update") {
        const sub = event.assistantMessageEvent;
        if (sub.type === "text_delta") {
          state.accumulated += sub.delta;
        }
        return;
      }

      if (event.type !== "agent_end") return;

      const accumulated = state.accumulated.trim();
      state.accumulated = "";

      const lastAssistant = [
        ...(event.messages as unknown as AgentMessageLike[]),
      ]
        .reverse()
        .find((m) => m.role === "assistant");

      // Prefer streamed text. Fall back to the final assistant message's
      // text blocks (covers cases where streaming finished but accumulator
      // missed something).
      let text = accumulated;
      let source = "stream";
      if (text.length === 0) {
        text = extractAssistantText(lastAssistant);
        source = "message.text";
      }

      if (text.length === 0) {
        log("no_reply", { session_id: sessionId });
        return;
      }
      log("post_reply", { session_id: sessionId, source, len: text.length });
      postReply(sessionId, text).catch((err: unknown) => {
        logError("post_reply_threw", {
          session_id: sessionId,
          error: fmtErr(err),
        });
      });
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

  /**
   * Resume a session from disk. Returns the state on success, undefined if
   * the on-disk directory is missing or empty (i.e. nothing to resume).
   */
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
  ): Promise<boolean> => {
    let state = sessions.get(sessionId);
    if (!state) {
      state = await resumeSession(sessionId);
    }
    if (!state) return false;

    log("prompt", { session_id: sessionId, len: text.length });
    state.session.prompt(text).catch((err: unknown) => {
      const formatted = fmtErr(err);
      logError("prompt_threw", { session_id: sessionId, error: formatted });
      void postReply(sessionId, `⚠️ ${formatted.message}`);
    });
    return true;
  };

  return { createSession, promptSession };
};
