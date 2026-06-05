import { useEffect, useState } from "react";
import { Link } from "react-router";
import { UserButton } from "@clerk/clerk-react";
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

// ─── Types ──────────────────────────────────────────────────────────

interface CostSummary {
  totalCostUsd: number;
  totalSessions: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

interface UserCost {
  clerkUserId: string;
  costUsd: number;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
}

interface GithubStatus {
  githubConnected: boolean;
  githubUsername: string | null;
  installationId: number | null;
  tokenMinted: boolean;
  tokenPrefix: string | null;
  expiresAt: string | null;
}

interface SessionCost {
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

// ─── Helpers ────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function truncateId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

// ─── Stat Cards ─────────────────────────────────────────────────────

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-bold">{value}</p>
      </CardContent>
    </Card>
  );
}

function SummaryCards({ data }: { data: CostSummary | null }) {
  if (!data) return null;
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatCard label="Total Cost" value={formatCost(data.totalCostUsd)} />
      <StatCard label="Sessions" value={String(data.totalSessions)} />
      <StatCard label="Input Tokens" value={formatTokens(data.totalInputTokens)} />
      <StatCard label="Output Tokens" value={formatTokens(data.totalOutputTokens)} />
    </div>
  );
}

// ─── GitHub status ──────────────────────────────────────────────────

// Per-user check of the GitHub App installation + token minting. Fetched
// lazily per row so the cost table doesn't block on N GitHub calls.
function GithubStatusCell({ userId }: { userId: string }) {
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
    return <span className="text-muted-foreground">no app</span>;
  if (status.tokenMinted)
    return (
      <span className="text-foreground">
        ✓ {status.githubUsername} (#{status.installationId})
      </span>
    );
  return <span className="text-destructive">token failed</span>;
}

// ─── User Costs ─────────────────────────────────────────────────────

function UserCostsTable({
  users,
  onSelectUser,
  selectedUser,
}: {
  users: UserCost[];
  onSelectUser: (userId: string | null) => void;
  selectedUser: string | null;
}) {
  if (users.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Cost by User</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead>GitHub</TableHead>
            <TableHead className="text-right">Cost</TableHead>
            <TableHead className="text-right">Sessions</TableHead>
            <TableHead className="text-right">Input</TableHead>
            <TableHead className="text-right">Output</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((u) => (
            <TableRow
              key={u.clerkUserId}
              className={
                selectedUser === u.clerkUserId
                  ? "bg-accent"
                  : "cursor-pointer"
              }
              onClick={() =>
                onSelectUser(
                  selectedUser === u.clerkUserId ? null : u.clerkUserId,
                )
              }
            >
              <TableCell className="font-mono text-sm">
                {truncateId(u.clerkUserId)}
              </TableCell>
              <TableCell className="text-sm">
                <GithubStatusCell userId={u.clerkUserId} />
              </TableCell>
              <TableCell className="text-right font-mono">
                {formatCost(u.costUsd)}
              </TableCell>
              <TableCell className="text-right">{u.sessions}</TableCell>
              <TableCell className="text-right">
                {formatTokens(u.inputTokens)}
              </TableCell>
              <TableCell className="text-right">
                {formatTokens(u.outputTokens)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

// ─── Sessions ───────────────────────────────────────────────────────

const PAGE_SIZE = 50;

function SessionsTable({
  filterUserId,
  users,
  onChangeFilter,
}: {
  filterUserId: string | null;
  users: UserCost[];
  onChangeFilter: (userId: string | null) => void;
}) {
  const [sessions, setSessions] = useState<SessionCost[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: "0",
      });
      if (filterUserId) params.set("userId", filterUserId);
      const res = await fetch(`/api/admin/costs/sessions?${params}`);
      if (cancelled || !res.ok) return;
      const data = (await res.json()) as SessionCost[];
      setSessions(data);
      setHasMore(data.length === PAGE_SIZE);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- runs once on mount; remount via key

  const loadMore = () => {
    const next = offset + PAGE_SIZE;
    setOffset(next);
    void (async () => {
      setLoading(true);
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(next),
      });
      if (filterUserId) params.set("userId", filterUserId);
      const res = await fetch(`/api/admin/costs/sessions?${params}`);
      if (!res.ok) {
        setLoading(false);
        return;
      }
      const data = (await res.json()) as SessionCost[];
      setSessions((prev) => [...prev, ...data]);
      setHasMore(data.length === PAGE_SIZE);
      setLoading(false);
    })();
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Sessions</h2>
        <select
          className="rounded-md border bg-background px-3 py-1.5 text-sm"
          value={filterUserId ?? ""}
          onChange={(e) => onChangeFilter(e.target.value || null)}
        >
          <option value="">All users</option>
          {users.map((u) => (
            <option key={u.clerkUserId} value={u.clerkUserId}>
              {truncateId(u.clerkUserId)}
            </option>
          ))}
        </select>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Session</TableHead>
            <TableHead>User</TableHead>
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
              <TableCell className="font-mono text-sm">
                {truncateId(s.clerkUserId)}
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
      {loading && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
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

export function AdminPage() {
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [users, setUsers] = useState<UserCost[]>([]);
  const [filterUserId, setFilterUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [costsRes, usersRes] = await Promise.all([
        fetch("/api/admin/costs"),
        fetch("/api/admin/costs/by-user"),
      ]);
      if (!costsRes.ok || !usersRes.ok) {
        if (!cancelled) {
          setError("Failed to load admin data.");
          setLoading(false);
        }
        return;
      }
      const costsData = (await costsRes.json()) as CostSummary;
      const usersData = (await usersRes.json()) as UserCost[];
      if (!cancelled) {
        setSummary(costsData);
        setUsers(usersData);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-destructive">{error}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto flex h-14 items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <Link
              to="/"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              ← Settings
            </Link>
            <span className="text-xl font-bold tracking-tight">Admin</span>
          </div>
          <UserButton
            appearance={{ elements: { avatarBox: "size-8" } }}
          />
        </div>
      </header>

      <main className="container mx-auto space-y-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10">
        <SummaryCards data={summary} />
        <UserCostsTable
          users={users}
          selectedUser={filterUserId}
          onSelectUser={setFilterUserId}
        />
        <SessionsTable
          key={filterUserId ?? "__all__"}
          filterUserId={filterUserId}
          users={users}
          onChangeFilter={setFilterUserId}
        />
      </main>
    </div>
  );
}
