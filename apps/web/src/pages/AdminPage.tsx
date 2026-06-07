import { useEffect, useState } from "react";
import { Link } from "react-router";
import { UserButton } from "@clerk/clerk-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCost, formatTokens, truncateId, type AdminUser } from "./admin-shared";

// ─── Types ──────────────────────────────────────────────────────────

interface CostSummary {
  totalCostUsd: number;
  totalSessions: number;
  totalInputTokens: number;
  totalOutputTokens: number;
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

// ─── Users ──────────────────────────────────────────────────────────

function userLabel(u: AdminUser): string {
  return u.email ?? u.username ?? truncateId(u.clerkUserId);
}

function UsersTable({ users }: { users: AdminUser[] }) {
  if (users.length === 0) {
    return <p className="text-sm text-muted-foreground">No users found.</p>;
  }

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Users</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead className="text-right">Cost</TableHead>
            <TableHead className="text-right">Sessions</TableHead>
            <TableHead className="text-right">Input</TableHead>
            <TableHead className="text-right">Output</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((u) => (
            <TableRow key={u.clerkUserId} className="cursor-pointer">
              <TableCell>
                <Link
                  to={`/admin/users/${encodeURIComponent(u.clerkUserId)}`}
                  state={{ user: u }}
                  className="block text-foreground hover:underline"
                >
                  {userLabel(u)}
                </Link>
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

// ─── Page ───────────────────────────────────────────────────────────

export function AdminPage() {
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [costsRes, usersRes] = await Promise.all([
        fetch("/api/admin/costs"),
        fetch("/api/admin/users"),
      ]);
      if (!costsRes.ok || !usersRes.ok) {
        if (!cancelled) {
          setError("Failed to load admin data.");
          setLoading(false);
        }
        return;
      }
      const costsData = (await costsRes.json()) as CostSummary;
      const usersData = (await usersRes.json()) as AdminUser[];
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
        <UsersTable users={users} />
      </main>
    </div>
  );
}
