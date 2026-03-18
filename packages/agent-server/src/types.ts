/**
 * Request/response types for agent-server HTTP API.
 */

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
  /** Thinking/reasoning level: "off" | "low" | "medium" | "high" | "xhigh". */
  thinkingLevel?: string;
  /** Credential type: 'oauth' credentials may need refresh, 'api_key' are static. */
  credentialType?: string;
  /** OAuth refresh token for token renewal. */
  refreshToken?: string;
  /** OAuth access token expiry (ISO 8601 string). */
  expiresAt?: string;
  /** OAuth provider ID (e.g. "anthropic") for selecting the refresh function. */
  oauthProviderId?: string;
}

export interface MessageRequest {
  text: string;
}

export interface SteerRequest {
  text: string;
}

export interface ConfigureRequest {
  provider: string;
  model: string;
  apiKey: string;
  /** Thinking/reasoning level: "off" | "low" | "medium" | "high" | "xhigh". */
  thinkingLevel?: string;
  /** Credential type: 'oauth' credentials may need refresh, 'api_key' are static. */
  credentialType?: string;
  /** OAuth refresh token for token renewal. */
  refreshToken?: string;
  /** OAuth access token expiry (ISO string or epoch ms). */
  expiresAt?: string;
  /** OAuth provider ID (e.g. "anthropic") for selecting the refresh function. */
  oauthProviderId?: string;
}

export type SessionStatus =
  | "idle"
  | "starting"
  | "running"
  | "error";


