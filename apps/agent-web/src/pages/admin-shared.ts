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
