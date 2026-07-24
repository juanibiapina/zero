import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { UserButton } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatDate,
  truncateId,
  type AdminUserDetail,
  type GithubStatus,
} from "./admin-shared";

// ─── GitHub status ──────────────────────────────────────────────────

function GithubStatusLine({ userId }: { userId: string }) {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(
        `/api/admin/github/status?userId=${encodeURIComponent(userId)}`,
      );
      if (cancelled) return;
      if (res.ok) setStatus((await res.json()) as GithubStatus);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (loading) return <span className="text-muted-foreground">…</span>;
  if (!status || !status.githubConnected)
    return <span className="text-muted-foreground">not connected</span>;
  if (status.installationId === null)
    return <span className="text-muted-foreground">connected, no app installed</span>;
  if (status.tokenMinted)
    return (
      <span className="text-foreground">
        ✓ {status.githubUsername} (#{status.installationId})
      </span>
    );
  return <span className="text-destructive">token mint failed</span>;
}

// ─── Info cards ─────────────────────────────────────────────────────

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}

function StatusCard({ detail }: { detail: AdminUserDetail }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Status
        </CardTitle>
      </CardHeader>
      <CardContent>
        <InfoRow label="Telegram">
          {detail.telegramId ? (
            <span className="font-mono">{detail.telegramId}</span>
          ) : (
            <span className="text-muted-foreground">not linked</span>
          )}
        </InfoRow>
        <InfoRow label="Google">
          {detail.googleOnboardingStatus ?? (
            <span className="text-muted-foreground">not connected</span>
          )}
        </InfoRow>
        <InfoRow label="GitHub">
          <GithubStatusLine userId={detail.clerkUserId} />
        </InfoRow>
        <InfoRow label="Onboarding">
          {detail.onboardingSeen ? "seen" : "pending"}
        </InfoRow>
        <InfoRow label="Created">{formatDate(detail.createdAt)}</InfoRow>
      </CardContent>
    </Card>
  );
}

// ─── Admin task ───────────────────────────────────────────────────

type AdminTaskStatus =
  | { clerkUserId: string; status: "queued" }
  | { clerkUserId: string; status: "done"; summary: string }
  | { clerkUserId: string; status: "failed" };

function AdminTaskCard({ userId }: { userId: string }) {
  const [prompt, setPrompt] = useState("");
  const [task, setTask] = useState<AdminTaskStatus | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [requestFailed, setRequestFailed] = useState(false);

  const path = `/api/admin/users/${encodeURIComponent(userId)}/task`;

  // Read any prior task on entry. A missing task is the normal empty state.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(path);
      if (cancelled || res.status === 404) return;
      if (res.ok) setTask((await res.json()) as AdminTaskStatus);
    })();
    return () => { cancelled = true; };
  }, [path]);

  // Poll only while the asynchronous DO task is running.
  useEffect(() => {
    if (task?.status !== "queued") return;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const res = await fetch(path);
      if (!cancelled && res.ok) {
        const next = (await res.json()) as AdminTaskStatus;
        setTask(next);
        if (next.status === "queued") timeout = setTimeout(() => void poll(), 2_000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [path, task?.status]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    setSubmitting(true);
    setRequestFailed(false);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      if (res.status === 202 || res.status === 409) {
        setTask({ clerkUserId: userId, status: "queued" });
        if (res.status === 202) setPrompt("");
      } else {
        setRequestFailed(true);
      }
    } catch {
      setRequestFailed(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Run Task
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3">
          <div className="space-y-2">
            <label htmlFor="admin-task" className="text-sm font-medium">
              Agent prompt
            </label>
            <textarea
              id="admin-task"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={20_000}
              rows={8}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              disabled={submitting || task?.status === "queued"}
              required
            />
          </div>
          <Button
            type="submit"
            disabled={submitting || task?.status === "queued" || !prompt.trim()}
          >
            Run task
          </Button>
        </form>
        {task?.status === "queued" && (
          <p className="text-sm text-muted-foreground">Running task…</p>
        )}
        {task?.status === "done" && (
          <p className="text-sm text-green-600">{task.summary || "Task completed."}</p>
        )}
        {(task?.status === "failed" || requestFailed) && (
          <p className="text-sm text-destructive">Task failed.</p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Page ───────────────────────────────────────────────────────────

export function UserDetailPage() {
  const { userId = "" } = useParams();

  const [detail, setDetail] = useState<AdminUserDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`);
      if (cancelled) return;
      if (!res.ok) {
        setError(res.status === 404 ? "User not found." : "Failed to load user.");
        setLoading(false);
        return;
      }
      setDetail((await res.json()) as AdminUserDetail);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [userId]);

  const title = detail?.email ?? detail?.username ?? truncateId(userId);

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto flex h-14 items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <Link
              to="/admin"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              ← Users
            </Link>
            <span className="text-xl font-bold tracking-tight">{title}</span>
          </div>
          <UserButton appearance={{ elements: { avatarBox: "size-8" } }} />
        </div>
      </header>

      <main className="container mx-auto space-y-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10">
        {loading && <p className="text-muted-foreground">Loading…</p>}
        {error && <p className="text-destructive">{error}</p>}
        {detail && (
          <>
            <p className="font-mono text-sm text-muted-foreground">
              {detail.clerkUserId}
            </p>
            <StatusCard detail={detail} />
            <AdminTaskCard userId={detail.clerkUserId} />
          </>
        )}
      </main>
    </div>
  );
}
