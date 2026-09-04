import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { ErrorText } from "@/components/ConnectionStatus";
import {
  ALL_STATUSES,
  BACKLOG_COLLAPSE_THRESHOLD,
  DONE_UNDO_MS,
  ICON_CHOICES,
  LOADING_TEXT_DELAY_MS,
  messageOf,
  projectsByStatus,
  listView,
  STATUS_LABELS,
  type ProjectEditFields,
  type ProjectStatus,
} from "@zero/agent-core";
import { getProjectsApi, type ProjectsApi } from "@/lib/projects-collection";
import { cn } from "@/lib/utils";
import { type Project } from "@/lib/projects";

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

// Projects is a status-grouped list of outcome-oriented containers. The add
// field creates a Project by name; tapping a row opens a detail sheet where the
// status is changed (icon/title/notes editing is slice A3).
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

  // The open detail sheet's project id, and the sets of projects mid-Done and
  // mid-Delete (both shown struck-through with Undo until the timer commits
  // them). Timers are cleared on unmount so a pending action never fires against
  // a torn-down page.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingDone, setPendingDone] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<Set<string>>(new Set());
  const doneTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const deleteTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  useEffect(() => {
    const timers = doneTimers.current;
    const dTimers = deleteTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const t of dTimers.values()) clearTimeout(t);
      dTimers.clear();
    };
  }, []);

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

  const commitStatus = useCallback(
    (id: string, status: ProjectStatus) => {
      setError(null);
      const tx = api.setStatus(id, status);
      tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
    },
    [api],
  );

  // Edit a project's icon/title/description from the sheet. Unlike a status
  // pick, an edit keeps the sheet open so the user can change several fields.
  const commitEdit = useCallback(
    (id: string, fields: ProjectEditFields) => {
      setError(null);
      const tx = api.edit(id, fields);
      tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
    },
    [api],
  );

  // Setting Done does not write immediately: hold the row struck-through with an
  // Undo for DONE_UNDO_MS, then commit. Undo clears the timer and the row stays.
  const startDone = useCallback(
    (id: string) => {
      setPendingDone((prev) => new Set(prev).add(id));
      const timer = setTimeout(() => {
        doneTimers.current.delete(id);
        setPendingDone((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        commitStatus(id, "done");
      }, DONE_UNDO_MS);
      doneTimers.current.set(id, timer);
    },
    [commitStatus],
  );
  const undoDone = useCallback((id: string) => {
    const timer = doneTimers.current.get(id);
    if (timer) clearTimeout(timer);
    doneTimers.current.delete(id);
    setPendingDone((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Delete mirrors Done: the row leaves after a DONE_UNDO_MS Undo window, then
  // the hard delete commits. Deleting is destructive and has no server-side
  // undo, so the client window is the only guard against a mis-tap.
  const commitDelete = useCallback(
    (id: string) => {
      setError(null);
      const tx = api.remove(id);
      tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
    },
    [api],
  );
  const startDelete = useCallback(
    (id: string) => {
      setPendingDelete((prev) => new Set(prev).add(id));
      const timer = setTimeout(() => {
        deleteTimers.current.delete(id);
        setPendingDelete((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        commitDelete(id);
      }, DONE_UNDO_MS);
      deleteTimers.current.set(id, timer);
    },
    [commitDelete],
  );
  const undoDelete = useCallback((id: string) => {
    const timer = deleteTimers.current.get(id);
    if (timer) clearTimeout(timer);
    deleteTimers.current.delete(id);
    setPendingDelete((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Route an Undo tap to the pending action that owns the row.
  const onUndo = useCallback(
    (id: string) => {
      if (pendingDelete.has(id)) undoDelete(id);
      else undoDone(id);
    },
    [pendingDelete, undoDelete, undoDone],
  );

  const onPickStatus = useCallback(
    (project: Project, status: ProjectStatus) => {
      setSelectedId(null);
      if (status === project.status) return;
      if (status === "done") {
        startDone(project.id);
      } else {
        commitStatus(project.id, status);
      }
    },
    [commitStatus, startDone],
  );

  const list = useMemo(() => projects ?? [], [projects]);
  const sections = useMemo(() => projectsByStatus(list), [list]);
  const view = listView({ count: list.length, isLoading, loadError: null });
  const showLoadingText = useDelayed(view === "loading", LOADING_TEXT_DELAY_MS);

  const selected = selectedId
    ? (list.find((p) => p.id === selectedId) ?? null)
    : null;

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
        <div className="space-y-6">
          {sections.map((section) => (
            <ProjectSectionView
              key={section.status}
              status={section.status}
              projects={section.projects}
              pending={pendingDone}
              pendingDelete={pendingDelete}
              onOpen={(p) => setSelectedId(p.id)}
              onUndo={onUndo}
            />
          ))}
        </div>
      )}

      <Sheet
        open={selected != null}
        onClose={() => setSelectedId(null)}
        title={selected?.title ?? "Project"}
        srOnlyTitle={selected == null}
      >
        {selected && (
          <ProjectDetail
            key={selected.id}
            project={selected}
            onEdit={commitEdit}
            onPickStatus={(status) => onPickStatus(selected, status)}
            onDelete={() => {
              setSelectedId(null);
              startDelete(selected.id);
            }}
          />
        )}
      </Sheet>
    </div>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

// One collapsible status section: a header with a count and a chevron, and the
// rows beneath it when expanded. Backlog starts collapsed when large; the other
// working statuses start open. Collapse is local UI state (not persisted).
function ProjectSectionView({
  status,
  projects,
  pending,
  pendingDelete,
  onOpen,
  onUndo,
}: {
  status: ProjectStatus;
  projects: Project[];
  // Projects mid-Done (struck-through with Undo).
  pending: Set<string>;
  // Projects mid-Delete (also struck-through with Undo).
  pendingDelete: Set<string>;
  onOpen: (p: Project) => void;
  onUndo: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(
    status === "backlog" && projects.length > BACKLOG_COLLAPSE_THRESHOLD,
  );
  return (
    <section className="space-y-3">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 text-sm font-semibold text-muted-foreground"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cn("size-4 transition-transform", collapsed && "-rotate-90")}
          aria-hidden
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
        <span>{STATUS_LABELS[status]}</span>
        <span className="text-muted-foreground/70">· {projects.length}</span>
      </button>
      {!collapsed && (
        <ul className="space-y-3">
          {projects.map((item) => {
            const isPending = pending.has(item.id) || pendingDelete.has(item.id);
            return (
              <li key={item.id}>
                <div
                  className={cn(
                    "flex items-center gap-3 rounded-xl border bg-card px-4 py-4",
                    isPending && "opacity-60",
                  )}
                >
                  <span className="shrink-0 text-xl" aria-hidden>
                    {item.icon}
                  </span>
                  {isPending ? (
                    <>
                      <span className="flex-1 text-base text-muted-foreground line-through">
                        {item.title}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onUndo(item.id)}
                      >
                        Undo
                      </Button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onOpen(item)}
                      className="flex-1 text-left text-base"
                    >
                      {item.title}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// The detail sheet body: an icon picker, an editable title, an editable
// description, and the Status group. Edits commit on blur / Enter (not per
// keystroke) and keep the sheet open; only a status pick dismisses it. Keyed by
// project id at the call site, so the seeded field state resets between projects.
function ProjectDetail({
  project,
  onEdit,
  onPickStatus,
  onDelete,
}: {
  project: Project;
  onEdit: (id: string, fields: ProjectEditFields) => void;
  onPickStatus: (status: ProjectStatus) => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(project.title);
  const [description, setDescription] = useState(project.description ?? "");

  const commitTitle = useCallback(() => {
    const trimmed = title.trim();
    if (trimmed === "" || trimmed === project.title) {
      setTitle(project.title);
      return;
    }
    onEdit(project.id, { title: trimmed });
  }, [title, project.id, project.title, onEdit]);

  const commitDescription = useCallback(() => {
    const next = description.trim() === "" ? null : description;
    if ((next ?? null) === (project.description ?? null)) return;
    onEdit(project.id, { description: next });
  }, [description, project.id, project.description, onEdit]);

  return (
    <div className="space-y-5">
      <div>
        <p className="mb-2 text-sm font-medium text-muted-foreground">Icon</p>
        <div className="flex flex-wrap gap-2">
          {ICON_CHOICES.map((icon) => {
            const isCurrent = icon === project.icon;
            return (
              <button
                key={icon}
                type="button"
                aria-label={`Set icon ${icon}`}
                aria-pressed={isCurrent}
                onClick={() => onEdit(project.id, { icon })}
                className={cn(
                  "flex size-11 items-center justify-center rounded-lg border text-xl transition-colors hover:bg-accent",
                  isCurrent && "border-primary ring-2 ring-primary",
                )}
              >
                {icon}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-1">
        <label
          htmlFor="project-title"
          className="text-sm font-medium text-muted-foreground"
        >
          Title
        </label>
        <Input
          id="project-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitTitle();
            }
          }}
        />
      </div>

      <div className="space-y-1">
        <label
          htmlFor="project-description"
          className="text-sm font-medium text-muted-foreground"
        >
          Notes
        </label>
        <textarea
          id="project-description"
          value={description}
          rows={3}
          placeholder="A sentence of intent (optional)"
          onChange={(e) => setDescription(e.target.value)}
          onBlur={commitDescription}
          className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>

      <StatusGroup current={project.status} onPick={onPickStatus} />

      {/* Destructive: hard-delete the project (distinct from Done, which keeps
          it). Leaves a brief Undo window before it commits. */}
      <div className="border-t pt-4">
        <Button
          variant="ghost"
          className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={onDelete}
        >
          Delete project
        </Button>
      </div>
    </div>
  );
}

// The Status group in the detail sheet: the five states as selectable rows, the
// current one marked. Tapping the current status is a no-op (the caller closes
// the sheet); tapping another changes it.
function StatusGroup({
  current,
  onPick,
}: {
  current: ProjectStatus;
  onPick: (status: ProjectStatus) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-muted-foreground">Status</p>
      <ul className="divide-y rounded-xl border">
        {ALL_STATUSES.map((status) => {
          const isCurrent = status === current;
          return (
            <li key={status}>
              <button
                type="button"
                onClick={() => onPick(status)}
                aria-pressed={isCurrent}
                className="flex w-full items-center justify-between px-4 py-3 text-left text-base transition-colors hover:bg-accent"
              >
                <span>{STATUS_LABELS[status]}</span>
                {isCurrent && <CheckIcon className="size-5 text-primary" />}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
