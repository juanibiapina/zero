/**
 * Request/response types for agent-server HTTP API.
 */

export interface StartRequest {
  repoUrl: string;
  token: string;
  provider: string;
  model: string;
  apiKey: string;
  prompt?: string;
  /** User secrets injected as environment variables before the agent starts. */
  secrets?: Record<string, string>;
}

export interface ResumeRequest {
  provider: string;
  model: string;
  apiKey: string;
  repoUrl: string;
  token: string;
  /** User secrets injected as environment variables before the agent resumes. */
  secrets?: Record<string, string>;
  /** Conversation history reconstructed from SessionDO's persisted agent_end events. */
  messages: unknown[];
  /** When true, workspace will be restored from R2 snapshot after resume — skip clone. */
  workspaceRestored?: boolean;
}

export interface MessageRequest {
  text: string;
}

export interface SteerRequest {
  text: string;
}

export type SessionStatus =
  | "idle"
  | "starting"
  | "ready"
  | "running"
  | "error"
  | "stopped";

export type LifecyclePhase =
  | "cloning"
  | "clone_complete"
  | "configuring"
  | "restoring_workspace"
  | "workspace_restored"
  | "ready"
  | "resuming";

export interface EventEnvelope {
  seq: number;
  event: unknown;
  timestamp: string;
}
