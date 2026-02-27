import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router";
import { useAuth } from "@clerk/clerk-react";
import {
  FolderGit2,
  Plus,
  ChevronRight,
  Loader2,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";
import { useSessionStore } from "@/lib/session-store";

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

export default function ProjectDetailPage() {
  const { owner, repo } = useParams();
  const { getToken } = useAuth();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Get all sessions from store and filter for current project
  const allSessions = useSessionStore((s) => s.sessions);
  const loadingSessions = useSessionStore((s) => s.loading);
  const removeSession = useSessionStore((s) => s.removeSession);
  const sessions = allSessions.filter(
    (s) => s.owner === owner && s.repo === repo
  );

  const handleDelete = async (sessionId: string) => {
    setDeleting((prev) => new Set(prev).add(sessionId));
    try {
      const token = await getToken();
      const resp = await fetch(`/api/sessions/${sessionId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) {
        removeSession(sessionId);
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

  const handleCreate = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const token = await getToken();
      const resp = await fetch("/api/sessions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ owner, repo }),
      });
      if (!resp.ok) {
        let message = `Failed to create session (${resp.status})`;
        try {
          const parsed = (await resp.json()) as { error?: string };
          if (parsed.error) message = parsed.error;
        } catch {
          // Response wasn't JSON
        }
        throw new Error(message);
      }
      const data = (await resp.json()) as { sessionId: string };
      void navigate(`/p/${owner}/${repo}/sessions/${data.sessionId}`);
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "Failed to create session"
      );
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link to="/projects" className="hover:text-foreground">
          Projects
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground font-medium truncate">
          {owner}/{repo}
        </span>
      </div>

      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <FolderGit2 className="h-5 w-5 shrink-0" />
          <h1 className="text-2xl font-bold truncate">
            {owner}/{repo}
          </h1>
        </div>
        <Button className="shrink-0" disabled={creating} onClick={() => void handleCreate()}>
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {creating ? "Creating..." : "New Session"}
        </Button>
      </div>

      {/* Create error */}
      {createError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {createError}
        </div>
      )}

      {/* Sessions */}
      {loadingSessions ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          Loading sessions...
        </div>
      ) : sessions.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg font-medium">No sessions yet</p>
          <p className="text-sm mt-1">
            Create a new session to start working with an AI agent on this project.
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
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Provider</th>
                  <th className="px-4 py-3 font-medium">Model</th>
                  <th className="px-4 py-3 font-medium">Created</th>
                  <th className="px-4 py-3 font-medium w-12"></th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id} className="border-b last:border-0 hover:bg-muted/50">
                    <td className="px-4 py-3">
                      <Link
                        to={`/p/${owner}/${repo}/sessions/${session.id}`}
                        className="text-sm font-medium hover:underline"
                      >
                        {session.title}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={session.status} />
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {session.provider}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {session.model}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {relativeTime(session.createdAt)}
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
                    to={`/p/${owner}/${repo}/sessions/${session.id}`}
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
                <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <StatusBadge status={session.status} />
                  <span>{session.provider}</span>
                  <span>{session.model}</span>
                  <span>{relativeTime(session.createdAt)}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
