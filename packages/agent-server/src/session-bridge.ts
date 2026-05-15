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
 * Every pi event is logged with `[sess=<8-char-id>] <event>` so the full
 * agent loop is visible in the container's `Logs` view. Keep the lines
 * compact.
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

const tag = (sessionId: string) => `[sess=${sessionId.slice(0, 8)}]`;

const summariseContent = (blocks?: ContentBlock[]): string => {
  if (!blocks || blocks.length === 0) return "[]";
  const parts = blocks.map((b) => {
    switch (b.type) {
      case "text":
        return `text(${String(b.text ?? "").length})`;
      case "thinking":
        return `thinking(${String(b.thinking ?? "").length})`;
      case "toolCall":
        return `toolCall(${String(b.name ?? "?")})`;
      default:
        return b.type;
    }
  });
  return `[${parts.join(",")}]`;
};

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

interface DeltaCounters {
  text: number;
  thinking: number;
  toolcall: number;
}

const logEvent = (
  sessionId: string,
  event: AgentSessionEvent,
  counters: DeltaCounters,
): void => {
  const t = tag(sessionId);
  switch (event.type) {
    case "agent_start":
      console.log(`${t} agent_start`);
      break;
    case "turn_start":
      console.log(`${t} turn_start`);
      break;
    case "message_start": {
      const msg = event.message as unknown as AgentMessageLike;
      console.log(`${t} message_start role=${msg.role}`);
      break;
    }
    case "message_update": {
      const sub = event.assistantMessageEvent;
      switch (sub.type) {
        case "text_delta":
          counters.text += sub.delta.length;
          break;
        case "thinking_delta":
          counters.thinking += sub.delta.length;
          break;
        case "toolcall_delta":
          counters.toolcall += sub.delta.length;
          break;
        case "text_end":
          console.log(`${t} text_end len=${counters.text}`);
          counters.text = 0;
          break;
        case "thinking_end":
          console.log(`${t} thinking_end len=${counters.thinking}`);
          counters.thinking = 0;
          break;
        case "toolcall_end":
          console.log(
            `${t} toolcall_end name=${sub.toolCall.name} argLen=${counters.toolcall}`,
          );
          counters.toolcall = 0;
          break;
        case "error":
          console.log(
            `${t} stream_error reason=${sub.reason} msg=${sub.error.errorMessage ?? "?"}`,
          );
          break;
      }
      break;
    }
    case "message_end": {
      const msg = event.message as unknown as AgentMessageLike;
      console.log(
        `${t} message_end role=${msg.role} stop=${msg.stopReason ?? "?"} content=${summariseContent(msg.content)}`,
      );
      break;
    }
    case "tool_execution_start":
      console.log(
        `${t} tool_start name=${event.toolName} id=${event.toolCallId.slice(0, 8)}`,
      );
      break;
    case "tool_execution_end": {
      const errSuffix = event.isError ? " ERROR" : "";
      const resultPreview = (() => {
        try {
          const s = JSON.stringify(event.result);
          return s.length > 80 ? s.slice(0, 80) + "…" : s;
        } catch {
          return "<unserialisable>";
        }
      })();
      console.log(
        `${t} tool_end name=${event.toolName}${errSuffix} result=${resultPreview}`,
      );
      break;
    }
    case "turn_end": {
      const msg = event.message as unknown as AgentMessageLike;
      console.log(
        `${t} turn_end stop=${msg.stopReason ?? "?"} toolResults=${event.toolResults.length.toString()}`,
      );
      break;
    }
    case "agent_end": {
      const messages = event.messages as unknown as AgentMessageLike[];
      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m.role === "assistant");
      console.log(
        `${t} agent_end totalMsgs=${messages.length.toString()} lastAssistant=${summariseContent(lastAssistant?.content)}`,
      );
      break;
    }
    case "compaction_start":
    case "compaction_end":
    case "auto_retry_start":
    case "auto_retry_end":
    case "thinking_level_changed":
    case "session_info_changed":
    case "queue_update":
      break;
  }
};

interface SessionState {
  session: AgentSession;
  accumulated: string;
  counters: DeltaCounters;
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
      counters: { text: 0, thinking: 0, toolcall: 0 },
    };

    const t = tag(sessionId);
    session.subscribe((event) => {
      logEvent(sessionId, event, state.counters);

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
        console.log(`${t} no_reply (no text content from model)`);
        return;
      }
      console.log(`${t} postReply source=${source} len=${text.length.toString()}`);
      postReply(sessionId, text).catch((err: unknown) => {
        console.error(
          `${t} postReply threw:`,
          err instanceof Error ? err.message : err,
        );
      });
    });

    return state;
  };

  const createSession = async (sessionId: string): Promise<void> => {
    const t = tag(sessionId);
    const dir = sessionDirFor(sessionId);
    mkdirSync(dir, { recursive: true });
    console.log(`${t} createSession cwd=${cwd} dir=${dir}`);

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

    const t = tag(sessionId);
    console.log(`${t} resumeSession dir=${dir}`);
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

    const t = tag(sessionId);
    console.log(`${t} prompt len=${text.length.toString()}`);
    state.session.prompt(text).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${t} prompt threw:`, message);
      void postReply(sessionId, `⚠️ ${message}`);
    });
    return true;
  };

  return { createSession, promptSession };
};
