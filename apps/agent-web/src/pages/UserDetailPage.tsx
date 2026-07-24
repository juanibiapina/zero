import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { UserButton } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatCost,
  formatDate,
  formatTokens,
  truncateId,
  type AdminUser,
  type AdminUserDetail,
  type GithubStatus,
  type SessionCost,
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

// ─── Sessions ───────────────────────────────────────────────────────

const PAGE_SIZE = 50;

function SessionsTable({ userId }: { userId: string }) {
  const [sessions, setSessions] = useState<SessionCost[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);

  const fetchPage = async (nextOffset: number): Promise<SessionCost[] | null> => {
    const params = new URLSearchParams({
      userId,
      limit: String(PAGE_SIZE),
      offset: String(nextOffset),
    });
    const res = await fetch(`/api/admin/costs/sessions?${params}`);
    if (!res.ok) return null;
    return (await res.json()) as SessionCost[];
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const data = await fetchPage(0);
      if (cancelled || !data) {
        if (!cancelled) setLoading(false);
        return;
      }
      setSessions(data);
      setHasMore(data.length === PAGE_SIZE);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps -- fetchPage is stable per userId

  const loadMore = () => {
    const next = offset + PAGE_SIZE;
    setOffset(next);
    void (async () => {
      setLoading(true);
      const data = await fetchPage(next);
      if (!data) {
        setLoading(false);
        return;
      }
      setSessions((prev) => [...prev, ...data]);
      setHasMore(data.length === PAGE_SIZE);
      setLoading(false);
    })();
  };

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Sessions</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Session</TableHead>
            <TableHead>Model</TableHead>
            <TableHead className="text-right">Cost</TableHead>
            <TableHead className="text-right">In</TableHead>
            <TableHead className="text-right">Out</TableHead>
            <TableHead className="text-right">Cache R</TableHead>
            <TableHead className="text-right">Cache W</TableHead>
            <TableHead>Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((s) => (
            <TableRow key={s.sessionId}>
              <TableCell className="font-mono text-sm">
                {truncateId(s.sessionId)}
              </TableCell>
              <TableCell className="text-sm">{s.model}</TableCell>
              <TableCell className="text-right font-mono">
                {formatCost(s.costUsd)}
              </TableCell>
              <TableCell className="text-right">
                {formatTokens(s.inputTokens)}
              </TableCell>
              <TableCell className="text-right">
                {formatTokens(s.outputTokens)}
              </TableCell>
              <TableCell className="text-right">
                {formatTokens(s.cacheReadTokens)}
              </TableCell>
              <TableCell className="text-right">
                {formatTokens(s.cacheWriteTokens)}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {formatDate(s.updatedAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!loading && sessions.length === 0 && (
        <p className="text-sm text-muted-foreground">No sessions found.</p>
      )}
      {hasMore && !loading && (
        <Button variant="outline" size="sm" onClick={loadMore}>
          Load more
        </Button>
      )}
    </section>
  );
}

// ─── Page ───────────────────────────────────────────────────────────

export function UserDetailPage() {
  const { userId = "" } = useParams();
  const location = useLocation();
  const listRow = (location.state as { user?: AdminUser } | null)?.user ?? null;

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

  const title = detail?.email ?? detail?.username ?? listRow?.email ?? truncateId(userId);

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
            {listRow && (
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Cost</CardTitle>
                  </CardHeader>
                  <CardContent><p className="text-2xl font-bold">{formatCost(listRow.costUsd)}</p></CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Sessions</CardTitle>
                  </CardHeader>
                  <CardContent><p className="text-2xl font-bold">{listRow.sessions}</p></CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Input</CardTitle>
                  </CardHeader>
                  <CardContent><p className="text-2xl font-bold">{formatTokens(listRow.inputTokens)}</p></CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Output</CardTitle>
                  </CardHeader>
                  <CardContent><p className="text-2xl font-bold">{formatTokens(listRow.outputTokens)}</p></CardContent>
                </Card>
              </div>
            )}
            <StatusCard detail={detail} />
            <AdminTaskCard userId={detail.clerkUserId} />
            <SessionsTable userId={detail.clerkUserId} />
          </>
        )}
      </main>
    </div>
  );
}
