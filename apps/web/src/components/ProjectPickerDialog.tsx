import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "@clerk/clerk-react";
import { Loader2, FolderGit2, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { jsonBody } from "@/lib/api";
import type { ProjectSummary } from "@zero/core";

interface ProjectPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function ProjectPickerDialog({
  open,
  onOpenChange,
}: ProjectPickerDialogProps) {
  const { getToken } = useAuth();
  const navigate = useNavigate();

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Filter projects by query (exclude archived)
  const filtered = projects
    .filter((p) => !p.archived)
    .filter((p) =>
      p.fullName.toLowerCase().includes(query.toLowerCase())
    );

  // Fetch projects when dialog opens
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
    setError(null);
    setCreating(false);
    setLoading(true);

    void (async () => {
      try {
        const token = await getToken();
        const resp = await fetch("/api/projects", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await jsonBody<{ projects?: ProjectSummary[] }>(resp);
        setProjects(data.projects ?? []);
      } catch {
        setProjects([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [open, getToken]);

  // Keep selectedIndex in bounds when filtered list changes
  useEffect(() => {
    setSelectedIndex((prev) =>
      filtered.length === 0 ? 0 : Math.min(prev, filtered.length - 1)
    );
  }, [filtered.length]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const item = listRef.current.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const createSession = useCallback(
    async (project: ProjectSummary) => {
      setCreating(true);
      setError(null);
      try {
        const token = await getToken();
        const resp = await fetch("/api/sessions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            owner: project.owner,
            repo: project.repo,
          }),
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
        onOpenChange(false);
        void navigate(
          `/p/${project.owner}/${project.repo}/sessions/${data.sessionId}`
        );
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to create session"
        );
        setCreating(false);
      }
    },
    [getToken, navigate, onOpenChange]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (creating) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((prev) =>
          prev < filtered.length - 1 ? prev + 1 : prev
        );
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
        break;
      case "Enter":
        e.preventDefault();
        if (filtered[selectedIndex]) {
          void createSession(filtered[selectedIndex]);
        }
        break;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl gap-0 p-0 overflow-hidden"
        showCloseButton={false}
        onKeyDown={handleKeyDown}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>New Session</DialogTitle>
          <DialogDescription>
            Select a project to create a new session
          </DialogDescription>
        </DialogHeader>

        {/* Search input */}
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            placeholder="Search projects..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            disabled={creating}
            className="border-0 shadow-none focus-visible:ring-0 h-11"
            autoFocus
          />
        </div>

        {/* Project list */}
        <div
          ref={listRef}
          className="max-h-[28rem] overflow-y-auto py-1"
        >
          {loading && (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              <span className="text-sm">Loading projects...</span>
            </div>
          )}

          {!loading && filtered.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {projects.length === 0
                ? "No projects found"
                : "No matching projects"}
            </div>
          )}

          {!loading &&
            filtered.map((project, index) => (
              <button
                key={project.fullName}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors",
                  index === selectedIndex
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground hover:bg-muted/50"
                )}
                disabled={creating}
                onClick={() => void createSession(project)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate font-medium">
                  {project.fullName}
                </span>
                {project.description && (
                  <span className="ml-auto truncate text-xs text-muted-foreground max-w-[40%]">
                    {project.description}
                  </span>
                )}
              </button>
            ))}
        </div>

        {/* Error */}
        {error && (
          <div className="border-t px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {/* Creating indicator */}
        {creating && (
          <div className="flex items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Creating session...
          </div>
        )}

        {/* Footer hint */}
        {!creating && !error && filtered.length > 0 && (
          <div className="border-t px-3 py-2 text-xs text-muted-foreground">
            <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">↑↓</kbd>
            {" "}navigate{" "}
            <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">↵</kbd>
            {" "}create session{" "}
            <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">esc</kbd>
            {" "}close
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
