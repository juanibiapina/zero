import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorText } from "@/components/ConnectionStatus";
import { projectsView } from "@zero/agent-core";
import { getProjectsApi, type ProjectsApi } from "@/lib/projects-collection";
import { type Project } from "@/lib/projects";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// How long a list may sit empty-and-loading before it shows the "Loading…"
// text. The local snapshot hydrates the cached rows in well under this, so a
// normal load paints straight to the list with no spinner flash; the text only
// appears on a genuinely slow first load (empty cache waiting on the network).
const LOADING_TEXT_DELAY_MS = 1000;

// True only after `active` has held continuously for `ms`. Resets the moment
// `active` goes false, so a fast hydrate never trips it.
function useDelayed(active: boolean, ms: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => setElapsed(true), ms);
    return () => {
      clearTimeout(t);
      setElapsed(false);
    };
  }, [active, ms]);
  return active && elapsed;
}

// Projects is a flat list of outcome-oriented containers. The add field creates
// a Project by name; status, icon, and notes are enriched later (slices A2/A3).
export function ProjectsPage() {
  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10">
        <div className="mx-auto w-full max-w-2xl space-y-6">
          <h1 className="text-2xl font-bold tracking-tight">Projects</h1>
          <ProjectsPanel />
        </div>
      </main>
    </div>
  );
}

function ProjectsPanel() {
  const [api, setApi] = useState<ProjectsApi | null>(null);
  useEffect(() => {
    let live = true;
    void getProjectsApi().then((a) => {
      if (live) setApi(a);
    });
    return () => {
      live = false;
    };
  }, []);
  return api ? <ProjectsReady api={api} /> : <div className="min-h-24" />;
}

function ProjectsReady({ api }: { api: ProjectsApi }) {
  const { data: projects, isLoading } = useLiveQuery((q) =>
    q.from({ p: api.collection }).orderBy(({ p }) => p.createdAt, "asc"),
  );

  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void api.refetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [api]);

  const onAdd = useCallback(() => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setError(null);
    const tx = api.add(trimmed);
    tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
    setTitle("");
    inputRef.current?.focus();
  }, [api, title]);

  const list = projects ?? [];
  const view = projectsView({ count: list.length, isLoading, loadError: null });
  const showLoadingText = useDelayed(view === "loading", LOADING_TEXT_DELAY_MS);

  return (
    <div className="space-y-6">
      <form
        className="space-y-1"
        onSubmit={(e) => {
          e.preventDefault();
          onAdd();
        }}
      >
        <div className="flex items-center gap-2">
          <Input
            ref={inputRef}
            autoFocus
            value={title}
            placeholder="Run a 5K under 30 min"
            aria-label="New project"
            className="h-11"
            onChange={(e) => setTitle(e.target.value)}
          />
          <Button
            type="submit"
            size="lg"
            className="h-11 min-w-20"
            disabled={title.trim() === ""}
          >
            Add
          </Button>
        </div>
        {/* Helper text (not the placeholder): teach outcome-based naming, the one
            deliberate act of creating a project. */}
        <p className="text-sm text-muted-foreground">
          Name the outcome you'll reach, so you know when it's done.
        </p>
      </form>

      {error && <ErrorText>{error}</ErrorText>}

      {view === "loading" ? (
        showLoadingText ? (
          <p className="text-sm text-muted-foreground">
            Loading your projects…
          </p>
        ) : (
          <div className="min-h-24" />
        )
      ) : view === "empty" ? (
        <p className="text-sm text-muted-foreground">
          No projects yet. Name your first outcome.
        </p>
      ) : (
        <ul className="space-y-3">
          {list.map((item: Project) => (
            <li
              key={item.id}
              className="flex items-center gap-3 rounded-xl border bg-card px-4 py-4"
            >
              <span className="shrink-0 text-xl" aria-hidden>
                {item.icon}
              </span>
              <span className="flex-1 text-base">{item.title}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
