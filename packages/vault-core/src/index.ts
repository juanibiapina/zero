/**
 * ============================================================================
 * ZeroVault Core — Shared Types
 * ============================================================================
 *
 * Types shared between the API worker, web portal, and CLI.
 */

// ============================================================================
// API Keys
// ============================================================================

export interface ApiKeyInfo {
  id: number;
  prefix: string;
  suffix: string;
  label?: string;
  createdAt: string;
}

export interface ApiKeyCreated extends ApiKeyInfo {
  key: string;
}

// ============================================================================
// Projects
// ============================================================================

export interface Project {
  id: string;
  name: string;
  createdAt: string;
}

// ============================================================================
// Environments
// ============================================================================

export interface Environment {
  id: string;
  name: string;
  createdAt: string;
}

// ============================================================================
// Secrets
// ============================================================================

export interface SecretEntry {
  key: string;
  value: string;
}

// ============================================================================
// API Responses
// ============================================================================

export interface ApiKeyListResponse {
  keys: ApiKeyInfo[];
}

export interface ProjectListResponse {
  projects: Project[];
}

export interface EnvironmentListResponse {
  environments: Environment[];
}

export interface SecretsResponse {
  secrets: SecretEntry[];
}

export interface ErrorResponse {
  error: string;
}

export interface WhoAmIResponse {
  userId: string;
  orgId: string;
}
