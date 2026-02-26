/**
 * @zero/core — Shared types between api & web
 */

// ============================================================================
// Notification Types
// ============================================================================

export type NotificationProvider = "github" | "email" | "slack";

export type NotificationSeverity = "info" | "warning" | "error";

export type SuggestedActionType = "agent" | "link" | "dismiss";

export interface SuggestedAction {
  id: string;
  label: string;
  description: string;
  prompt: string;
  type: SuggestedActionType;
}

export interface Notification {
  id: string;
  provider: NotificationProvider;
  projectId: string | null;
  type: string;
  title: string;
  summary: string;
  url: string;
  severity: NotificationSeverity;
  sourceRef: string | null;
  payload: Record<string, unknown>;
  actions: SuggestedAction[] | null;
  read: boolean;
  createdAt: string;
}

// ============================================================================
// Session Types
// ============================================================================

export type SessionStatus =
  | "connecting"
  | "idle"
  | "starting"
  | "resuming"
  | "running"
  | "stopped"
  | "error";

export interface SessionSummary {
  id: string;
  projectId: string;
  title: string;
  status: SessionStatus;
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

export interface Session extends SessionSummary {
  messages: SessionMessage[];
}

export interface SessionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

// ============================================================================
// Project Types
// ============================================================================

export interface Project {
  owner: string;
  repo: string;
  projectDOId: string;
  defaultProvider: string | null;
  defaultModel: string | null;
}

export interface ProjectSummary {
  owner: string;
  repo: string;
  fullName: string;
  description: string | null;
  defaultBranch: string;
  private: boolean;
}

// ============================================================================
// Provider Types
// ============================================================================

export type ProviderCredentialType = "oauth" | "api_key";

export interface ProviderInfo {
  id: string;
  name: string;
  connected: boolean;
  credentialType: ProviderCredentialType | null;
  supportsOAuth: boolean;
  supportsApiKey: boolean;
}

export interface ProviderConnectResponse {
  authUrl: string;
}

// ============================================================================
// Agent Event Wire Types (mirrors pi-ai types for the frontend)
// ============================================================================

export type AgentStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface AgentTextContent {
  type: "text";
  text: string;
}

export interface AgentThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface AgentToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface AgentUserMessage {
  role: "user";
  content: string | (AgentTextContent | AgentImageContent)[];
  timestamp: number;
}

export interface AgentAssistantMessage {
  role: "assistant";
  content: (AgentTextContent | AgentThinkingContent | AgentToolCall)[];
  api: string;
  provider: string;
  model: string;
  usage: AgentUsage;
  stopReason: AgentStopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface AgentToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (AgentTextContent | AgentImageContent)[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

export type AgentMessage = AgentUserMessage | AgentAssistantMessage | AgentToolResultMessage;

/** AssistantMessageEvent sub-types (streamed within message_update) */
export type AgentAssistantMessageEvent =
  | { type: "start"; partial: AgentAssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AgentAssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AgentAssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AgentAssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AgentAssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AgentAssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AgentAssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AgentAssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AgentAssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: AgentToolCall; partial: AgentAssistantMessage }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: AgentAssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; error: AgentAssistantMessage };

export type AgentAssistantMessageEventType = AgentAssistantMessageEvent["type"];

/** Top-level agent events emitted by the agent loop */
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "turn_start" }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; assistantMessageEvent: AgentAssistantMessageEvent; message: AgentAssistantMessage }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "turn_end"; message: AgentAssistantMessage; toolResults: AgentToolResultMessage[] }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "status"; status: string; error?: string }
  | { type: "lifecycle"; phase: string };

export type AgentEventType = AgentEvent["type"];

// ============================================================================
// Session WebSocket Protocol
// ============================================================================

/** Client → SessionDO */
export type SessionClientMessage =
  | { type: "message"; text: string }
  | { type: "stop" }
  | { type: "steer"; text: string }
  | { type: "ping" };

/** SessionDO → Client */
export type SessionServerMessage =
  | {
      type: "event";
      seq: number;
      source: string;
      eventType: string;
      data: unknown;
    }
  | { type: "status"; status: SessionStatus; error?: string }
  | { type: "caught_up"; lastSeq: number }
  | { type: "pong" }
  | { type: "error"; message: string };

// ============================================================================
// Secret Types
// ============================================================================

export interface SecretEntry {
  name: string;
  createdAt: string;
  // value intentionally omitted — never returned from API
}

// ============================================================================
// User DO References
// ============================================================================

export interface UserDOReferences {
  inboxDOId: string | null;
  realtimeDOId: string | null;
  projects: { owner: string; repo: string; projectDOId: string }[];
}
