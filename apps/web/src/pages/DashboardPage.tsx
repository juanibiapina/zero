import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router";
import { useAuth } from "@clerk/clerk-react";
import { LayoutDashboard, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";

interface SessionEntry {
  id: string;
  owner: string;
  repo: string;
  title: string;
  status: string;
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function DashboardPage() {
  const { getToken } = useAuth();
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<Set<string>>(new Set());

  const fetchSessions = useCallback(async () => {
    try {
      const token = await getToken();
      const resp = await fetch("/api/sessions", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) {
        const data = (await resp.json()) as { sessions: SessionEntry[] };
        setSessions(data.sessions);
      }
    } catch {
      // Ignore fetch errors
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  const handleDelete = async (sessionId: string) => {
    setDeleting((prev) => new Set(prev).add(sessionId));
    try {
      const token = await getToken();
      const resp = await fetch(`/api/sessions/${sessionId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) {
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      }
    } catch {
      // Ignore errors
    } finally {
      setDeleting((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <LayoutDashboard className="h-5 w-5" />
        <h1 className="text-2xl font-bold">Dashboard</h1>
      </div>

      {/* Sessions */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Sessions</h2>
        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            Loading sessions...
          </div>
        ) : sessions.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <p className="text-lg font-medium">No sessions yet</p>
            <p className="text-sm mt-1">
              Create a new session from a project page to get started.
            </p>
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block rounded-lg border">
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-sm text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Session</th>
                    <th className="px-4 py-3 font-medium">Project</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Model</th>
                    <th className="px-4 py-3 font-medium">Updated</th>
                    <th className="px-4 py-3 font-medium w-12"></th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((session) => (
                    <tr key={session.id} className="border-b last:border-0 hover:bg-muted/50">
                      <td className="px-4 py-3">
                        <Link
                          to={`/sessions/${session.id}`}
                          className="text-sm font-medium hover:underline"
                        >
                          {session.title}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          to={`/projects/${session.owner}/${session.repo}`}
                          className="text-sm text-muted-foreground hover:underline"
                        >
                          {session.owner}/{session.repo}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={session.status} />
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {session.model}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {relativeTime(session.updatedAt)}
                      </td>
                      <td className="px-4 py-3">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          disabled={deleting.has(session.id)}
                          onClick={() => void handleDelete(session.id)}
                        >
                          {deleting.has(session.id) ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="space-y-3 md:hidden">
              {sessions.map((session) => (
                <div key={session.id} className="rounded-lg border p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <Link
                      to={`/sessions/${session.id}`}
                      className="text-sm font-medium hover:underline"
                    >
                      {session.title}
                    </Link>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                      disabled={deleting.has(session.id)}
                      onClick={() => void handleDelete(session.id)}
                    >
                      {deleting.has(session.id) ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  <Link
                    to={`/projects/${session.owner}/${session.repo}`}
                    className="block text-xs text-muted-foreground hover:underline"
                  >
                    {session.owner}/{session.repo}
                  </Link>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <StatusBadge status={session.status} />
                    <span>{session.model}</span>
                    <span>{relativeTime(session.updatedAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
