import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { UserButton } from "@clerk/react";
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
  formatCount,
  totalTokens,
  truncateId,
  USAGE_RANGES,
  type AdminUsageReport,
  type AdminUser,
  type UsageRange,
} from "./admin-shared";

function userLabel(user: AdminUser): string {
  return user.email ?? user.username ?? truncateId(user.clerkUserId);
}

export function AdminPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [range, setRange] = useState<UsageRange>("30d");
  const [usage, setUsage] = useState<AdminUsageReport | null>(null);
  const [usageErrorRange, setUsageErrorRange] = useState<UsageRange | null>(null);
  const usageLoading = usage?.range !== range && usageErrorRange !== range;
  const usageError = usageErrorRange === range;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/admin/users");
        if (!res.ok) throw new Error("roster failed");
        const data = (await res.json()) as AdminUser[];
        if (!cancelled) setUsers(data);
      } catch {
        if (!cancelled) setUsersError("Failed to load users.");
      } finally {
        if (!cancelled) setUsersLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/admin/ai-usage?range=${range}`);
        if (!res.ok) throw new Error("usage failed");
        const data = (await res.json()) as AdminUsageReport;
        if (!cancelled) {
          setUsage(data);
          setUsageErrorRange(null);
        }
      } catch {
        if (!cancelled) setUsageErrorRange(range);
      }
    })();
    return () => { cancelled = true; };
  }, [range]);

  const usageByUser = useMemo(
    () => new Map(
      usage?.range === range
        ? usage.users.map((row) => [row.userId, row])
        : [],
    ),
    [range, usage],
  );
  const sortedUsers = useMemo(
    () => [...users].sort((a, b) =>
      (usageByUser.get(b.clerkUserId)?.estimatedCostUsd ?? 0) -
      (usageByUser.get(a.clerkUserId)?.estimatedCostUsd ?? 0)),
    [users, usageByUser],
  );

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto flex h-14 items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
              ← Settings
            </Link>
            <span className="text-xl font-bold tracking-tight">Admin</span>
          </div>
          <UserButton appearance={{ elements: { avatarBox: "size-8" } }} />
        </div>
      </header>

      <main className="container mx-auto space-y-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10">
        <section className="space-y-4" aria-labelledby="usage-heading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 id="usage-heading" className="text-lg font-semibold">Estimated AI cost</h1>
              <p className="text-sm text-muted-foreground">
                Collection starts at deployment. Analytics history lasts about three months.
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Range</span>
              <select
                value={range}
                onChange={(event) => setRange(event.target.value as UsageRange)}
                className="h-9 rounded-md border bg-background px-2"
                aria-label="AI usage range"
              >
                {USAGE_RANGES.map((value) => <option key={value}>{value}</option>)}
              </select>
            </label>
          </div>

          {usageLoading && <p className="text-sm text-muted-foreground">Loading usage…</p>}
          {usageError && (
            <p className="text-sm text-destructive">Estimated AI usage is unavailable.</p>
          )}
          {usage?.range === range && !usageLoading && (
            <>
              <dl className="grid gap-4 border-y py-4 sm:grid-cols-3">
                <div>
                  <dt className="text-sm text-muted-foreground">Estimated cost</dt>
                  <dd className="mt-1 text-2xl font-semibold tabular-nums">
                    {formatCost(usage.totals.estimatedCostUsd)}
                  </dd>
                </div>
                <div>
                  <dt className="text-sm text-muted-foreground">Model calls</dt>
                  <dd className="mt-1 text-2xl font-semibold tabular-nums">
                    {formatCount(usage.totals.modelCalls)}
                  </dd>
                </div>
                <div>
                  <dt className="text-sm text-muted-foreground">Tokens</dt>
                  <dd className="mt-1 text-2xl font-semibold tabular-nums">
                    {formatCount(totalTokens(usage.totals))}
                  </dd>
                </div>
              </dl>
              {usage.totals.unpricedModelCalls > 0 && (
                <p className="text-sm text-amber-700">
                  {formatCount(usage.totals.unpricedModelCalls)} calls and{" "}
                  {formatCount(usage.totals.unpricedTokens)} tokens are not included in the cost estimate.
                </p>
              )}
            </>
          )}
        </section>

        <section className="space-y-3" aria-labelledby="users-heading">
          <h2 id="users-heading" className="text-lg font-semibold">Users</h2>
          {usersLoading && <p className="text-sm text-muted-foreground">Loading users…</p>}
          {usersError && <p className="text-sm text-destructive">{usersError}</p>}
          {!usersLoading && !usersError && sortedUsers.length === 0 && (
            <p className="text-sm text-muted-foreground">No users found.</p>
          )}
          {!usersLoading && !usersError && sortedUsers.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead className="text-right">Estimated cost</TableHead>
                    <TableHead className="text-right">Calls</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedUsers.map((user) => {
                    const row = usageByUser.get(user.clerkUserId);
                    return (
                      <TableRow key={user.clerkUserId}>
                        <TableCell>
                          <Link
                            to={`/admin/users/${encodeURIComponent(user.clerkUserId)}`}
                            className="block text-foreground hover:underline"
                          >
                            {userLabel(user)}
                          </Link>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row ? formatCost(row.estimatedCostUsd) : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row ? formatCount(row.modelCalls) : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
