import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { isNull } from "@tanstack/db";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorText } from "@/components/ConnectionStatus";
import {
  BACKLOG_COLLAPSE_THRESHOLD,
  DONE_UNDO_MS,
  LOADING_TEXT_DELAY_MS,
  messageOf,
  projectDisplayStatus,
  projectsByStatus,
  listView,
  STATUS_LABELS,
  type ProjectStatus,
} from "@zero/agent-core";
import { getProjectsApi, type ProjectsApi } from "@/lib/projects-collection";
import { getTasksApi, type TasksApi } from "@/lib/tasks-collection";
import { getWaitsApi, type WaitsApi } from "@/lib/waits-collection";
import { getCapturesApi, type CapturesApi } from "@/lib/captures-collection";
import { refiningCaptureId, stopRefine } from "@/lib/refine-session";
import { RefineBanner } from "@/components/RefineBanner";
import {
  useDelayed,
  useForegroundRefetch,
  useUndoableLeave,
} from "@/lib/screen-hooks";
import { cn } from "@/lib/utils";
import { type Project } from "@/lib/projects";

// Projects is a status-grouped list of outcome-oriented containers. The add
// field creates a Project by name; tapping a row navigates to that project's own
// screen (/projects/:id — a destination, not a bottom sheet; see
// docs/plans/todo-project-detail-rework.md). Done and delete are still deferred
// behind an inline ~5s Undo here on the list, whether triggered here or handed
// back from the detail screen via navigation state.
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
  const [tasksApi, setTasksApi] = useState<TasksApi | null>(null);
  const [waitsApi, setWaitsApi] = useState<WaitsApi | null>(null);
  const [capturesApi, setCapturesApi] = useState<CapturesApi | null>(null);
  useEffect(() => {
    let live = true;
    void getProjectsApi().then((a) => live && setApi(a));
    void getTasksApi().then((a) => live && setTasksApi(a));
    void getWaitsApi().then((a) => live && setWaitsApi(a));
    void getCapturesApi().then((a) => live && setCapturesApi(a));
    return () => {
      live = false;
    };
  }, []);
  return api && tasksApi && waitsApi && capturesApi ? (
    <ProjectsReady
      api={api}
      tasksApi={tasksApi}
      waitsApi={waitsApi}
      capturesApi={capturesApi}
    />
  ) : (
    <div className="min-h-24" />
  );
}

function ProjectsReady({
  api,
  tasksApi,
  waitsApi,
  capturesApi,
}: {
  api: ProjectsApi;
  tasksApi: TasksApi;
  waitsApi: WaitsApi;
  capturesApi: CapturesApi;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: projects, isLoading } = useLiveQuery((q) =>
    q.from({ p: api.collection }).orderBy(({ p }) => p.createdAt, "asc"),
  );
  // Open tasks drive each project's derived display status (active vs next).
  const { data: openTasks } = useLiveQuery((q) =>
    q.from({ t: tasksApi.collection }).where(({ t }) => isNull(t.completedAt)),
  );
  // Open waiting conditions make a project display as waiting.
  const { data: conditions } = useLiveQuery((q) =>
    q.from({ w: waitsApi.collection }),
  );

  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Two deferred-undo channels: one for Done, one for Delete. Both hold a row
  // struck-through with an Undo for DONE_UNDO_MS before committing; the hook owns
  // the timers and their cleanup.
  const done = useUndoableLeave(DONE_UNDO_MS);
  const del = useUndoableLeave(DONE_UNDO_MS);

  useForegroundRefetch(api.refetch);

  const onAdd = useCallback(() => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setError(null);
    // When refining a capture, the new project links back to it.
    const tx = api.add(trimmed, refiningCaptureId());
    tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
    setTitle("");
    inputRef.current?.focus();
  }, [api, title]);

  const onFinishRefine = useCallback(
    (captureId: string) => {
      const tx = capturesApi.process(captureId);
      tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
      stopRefine();
    },
    [capturesApi],
  );

  const commitStatus = useCallback(
    (id: string, status: ProjectStatus) => {
      setError(null);
      const tx = api.setStatus(id, status);
      tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
    },
    [api],
  );

  // Setting Done and deleting both defer their write behind a DONE_UNDO_MS Undo
  // window (delete is destructive with no server-side undo, so the window is the
  // only guard against a mis-tap). Route an Undo tap to whichever channel owns
  // the row.
  const startDone = useCallback(
    (id: string) => {
      done.start(id, () => commitStatus(id, "done"));
    },
    [done, commitStatus],
  );
  const startDelete = useCallback(
    (id: string) => {
      del.start(id, () => {
        setError(null);
        const tx = api.remove(id);
        tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
      });
    },
    [del, api],
  );
  const onUndo = useCallback(
    (id: string) => {
      if (del.pending.has(id)) del.undo(id);
      else done.undo(id);
    },
    [del, done],
  );

  // The detail screen hands a Done/Delete back through navigation state, so the
  // transient Undo lives here where the row is. Consume it once, then clear the
  // state so a refresh or Back does not re-trigger it.
  const handledLeave = useRef(false);
  useEffect(() => {
    const state = location.state as
      | { leaveId?: string; leaveKind?: "done" | "delete" }
      | null;
    if (!state?.leaveId || handledLeave.current) return;
    handledLeave.current = true;
    const { leaveId, leaveKind } = state;
    void navigate(".", { replace: true, state: null });
    if (leaveKind === "delete") startDelete(leaveId);
    else startDone(leaveId);
  }, [location.state, navigate, startDelete, startDone]);

  const list = useMemo(() => projects ?? [], [projects]);
  const tasks = useMemo(() => openTasks ?? [], [openTasks]);
  const conds = useMemo(() => conditions ?? [], [conditions]);
  const sections = useMemo(
    () =>
      projectsByStatus(list, (p) =>
        projectDisplayStatus(p, tasks, conds, list),
      ),
    [list, tasks, conds],
  );
  // A row is "leaving" if either channel (Done or Delete) holds it; both render
  // it struck-through with an Undo.
  const pending = useMemo(
    () => new Set([...done.pending, ...del.pending]),
    [done.pending, del.pending],
  );
  const view = listView({ count: list.length, isLoading, loadError: null });
  const showLoadingText = useDelayed(view === "loading", LOADING_TEXT_DELAY_MS);

  return (
    <div className="space-y-6">
      <RefineBanner onFinish={onFinishRefine} />
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
              pending={pending}
              onOpen={(p) => void navigate(`/projects/${p.id}`)}
              onUndo={onUndo}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// One collapsible status section: a header with a count and a chevron, and the
// rows beneath it when expanded. Backlog starts collapsed when large; the other
// working statuses start open. Collapse is local UI state (not persisted).
function ProjectSectionView({
  status,
  projects,
  pending,
  onOpen,
  onUndo,
}: {
  status: ProjectStatus;
  projects: Project[];
  // Projects mid-Done or mid-Delete (struck-through with an Undo).
  pending: Set<string>;
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
            const isPending = pending.has(item.id);
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
