// ─── Session Types ──────────────────────────────────────────────────────────

export interface ThinkingBlock {
  kind: "thinking";
  text: string;
}

export interface TextBlock {
  kind: "text";
  text: string;
}

export interface ToolCallBlock {
  kind: "toolcall";
  name: string;
  text: string;
}

export interface ToolResultBlock {
  kind: "toolresult";
  toolName: string;
  content: string;
  isError: boolean;
}

export interface ErrorBlock {
  kind: "error";
  message: string;
  friendlyMessage?: string;
  isAuthError: boolean;
}

export interface LifecycleBlock {
  kind: "lifecycle";
  phase: string;
  message: string;
  completed?: boolean;
}

export type ContentBlock = ThinkingBlock | TextBlock | ToolCallBlock | ToolResultBlock | ErrorBlock | LifecycleBlock;

export interface AssistantTurn {
  role: "assistant";
  blocks: ContentBlock[];
}

export interface UserTurn {
  role: "user";
  text: string;
}

export type Turn = AssistantTurn | UserTurn;

export type { SessionStatus } from "@zero/core";
