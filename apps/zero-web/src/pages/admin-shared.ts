// Shared types and formatters for the admin list + detail pages.

export interface AdminUser {
  clerkUserId: string;
  email: string | null;
  username: string | null;
  createdAt: string;
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

export interface GithubStatus {
  githubConnected: boolean;
  githubUsername: string | null;
  installationId: number | null;
  tokenMinted: boolean;
  tokenPrefix: string | null;
  expiresAt: string | null;
}

export type UsageRange = "24h" | "7d" | "30d" | "90d";

export interface UsageTotals {
  estimatedCostUsd: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  unpricedModelCalls: number;
  unpricedTokens: number;
}

export interface AdminUsageReport {
  range: UsageRange;
  totals: UsageTotals;
  users: Array<UsageTotals & { userId: string }>;
}

export interface UserUsageReport {
  range: UsageRange;
  totals: UsageTotals;
  byAgent: Array<UsageTotals & { agent: string }>;
  byConversation: Array<
    UsageTotals & {
      conversationId: string | null;
      chatId: string | null;
      topicId: string | null;
    }
  >;
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

export const USAGE_RANGES: UsageRange[] = ["24h", "7d", "30d", "90d"];

export function formatCost(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 0.01 ? 4 : 2,
    maximumFractionDigits: value < 0.01 ? 6 : 2,
  }).format(value);
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

export function totalTokens(usage: UsageTotals): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheWrite5mTokens +
    usage.cacheWrite1hTokens
  );
}
