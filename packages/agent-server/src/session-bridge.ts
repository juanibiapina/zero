// Wraps pi (@earendil-works/pi-coding-agent) per logical session id.
//
// Each session is a directory under `stateDir` named by the opaque
// sessionId. Pi writes its JSONL session file there; on resume we hand
// the same dir back to `SessionManager.continueRecent`. Directory
// existence is the only persisted index — no sidecar files.
//
// Durability is per-write via tigrisfs `--fsync-on-close` (entrypoint.sh).
// Logging is sparse on purpose: no user messages, model replies, file
// contents, or shell output ever appear in fields.

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
import { createCloseSessionTool } from "./close-session-tool.js";

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
  accumulated: string;
}

export type ReplyFn = (sessionId: string, text: string) => Promise<void>;

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
  promptSession: (sessionId: string, text: string) => Promise<boolean>;
  abortSession: (sessionId: string) => Promise<"aborted" | "nothing_running" | "unknown">;
  getSessionStatus: (sessionId: string) => Promise<{ model: string; contextPercent: number | null } | null>;
}

export const createSessionBridge = (
  postReply: ReplyFn,
  opts: SessionBridgeOptions,
): SessionBridge => {
  const { cwd, stateDir, callbackUrl, clerkUserId } = opts;
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

    const { session } = await createAgentSession({
      cwd,
      modelRegistry,
      authStorage,
      sessionManager,
      model,
      thinkingLevel: "high",
      customTools: [closeSessionTool],
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

      // Prefer streamed text; fall back to assistant message text blocks.
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
      void postReply(sessionId, text).catch((err: unknown) => {
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
  ): Promise<boolean> => {
    let state = sessions.get(sessionId);
    if (!state) {
      state = await resumeSession(sessionId);
    }
    if (!state) return false;

    log("prompt", { session_id: sessionId, len: text.length });
    void state.session.prompt(text).catch((err: unknown) => {
      const formatted = fmtErr(err);
      logError("prompt_threw", { session_id: sessionId, error: formatted });
      void postReply(sessionId, `⚠️ ${formatted.message}`);
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

  return { createSession, promptSession, abortSession, getSessionStatus };
};
