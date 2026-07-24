import { useEffect, useState } from "react";
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
import { truncateId, type AdminUser } from "./admin-shared";

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
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((u) => (
            <TableRow key={u.clerkUserId}>
              <TableCell>
                <Link
                  to={`/admin/users/${encodeURIComponent(u.clerkUserId)}`}
                  className="block text-foreground hover:underline"
                >
                  {userLabel(u)}
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

export function AdminPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/admin/users");
      if (!res.ok) {
        if (!cancelled) {
          setError("Failed to load admin data.");
          setLoading(false);
        }
        return;
      }
      const data = (await res.json()) as AdminUser[];
      if (!cancelled) {
        setUsers(data);
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
        <UsersTable users={users} />
      </main>
    </div>
  );
}
