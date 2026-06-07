// Shared types and formatters for the admin list + detail pages.

export interface AdminUser {
  clerkUserId: string;
  email: string | null;
  username: string | null;
  createdAt: string;
  costUsd: number;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AdminUserDetail {
  clerkUserId: string;
  email: string | null;
  username: string | null;
  createdAt: string;
  telegramId: string | null;
  googleOnboardingStatus: string | null;
  onboardingSeen: boolean;
}

export interface SessionCost {
  sessionId: string;
  clerkUserId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
}

export interface GithubStatus {
  githubConnected: boolean;
  githubUsername: string | null;
  installationId: number | null;
  tokenMinted: boolean;
  tokenPrefix: string | null;
  expiresAt: string | null;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function truncateId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}
