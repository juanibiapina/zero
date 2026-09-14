import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { isNull } from "@tanstack/db";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorText } from "@/components/ConnectionStatus";
import {
  BACKLOG_COLLAPSE_THRESHOLD,
  LOADING_TEXT_DELAY_MS,
  localToday,
  messageOf,
  projectDisplayStatus,
  projectsByStatus,
  listView,
  PROJECT_DISPLAY_STATUS_LABELS,
  waitingBadge,
  type ProjectDisplayStatus,
} from "@zero/agent-core";
import { getProjectsApi, type ProjectsApi } from "@/lib/projects-collection";
import { getTasksApi, type TasksApi } from "@/lib/tasks-collection";
import { getWaitsApi, type WaitsApi } from "@/lib/waits-collection";
import { requestIconSuggestions } from "@/lib/icon-suggestions";
import { useDelayed, useForegroundRefetch } from "@/lib/screen-hooks";
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
  useEffect(() => {
    let live = true;
    void getProjectsApi().then((a) => live && setApi(a));
    void getTasksApi().then((a) => live && setTasksApi(a));
    void getWaitsApi().then((a) => live && setWaitsApi(a));
    return () => {
      live = false;
    };
  }, []);
  return api && tasksApi && waitsApi ? (
    <ProjectsReady api={api} tasksApi={tasksApi} waitsApi={waitsApi} />
  ) : (
    <div className="min-h-24" />
  );
}

function ProjectsReady({
  api,
  tasksApi,
  waitsApi,
}: {
  api: ProjectsApi;
  tasksApi: TasksApi;
  waitsApi: WaitsApi;
}) {
  const navigate = useNavigate();
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

  useForegroundRefetch(api.refetch);

  const onAdd = useCallback(() => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setError(null);
    const tx = api.add(trimmed);
    tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
    // Pre-warm emoji icon suggestions in the background off the optimistic
    // insert's id, so the picker shows them instantly when opened (create is
    // name-only, so the basis is the title alone). Fire-and-forget; a failure
    // only costs the shortcut.
    const key = tx.mutations[0]?.key as string | number | undefined;
    if (key !== undefined) {
      void requestIconSuggestions(String(key), {
        title: trimmed,
        description: null,
      });
    }
    setTitle("");
    inputRef.current?.focus();
  }, [api, title]);

  const list = useMemo(() => projects ?? [], [projects]);
  const tasks = useMemo(() => openTasks ?? [], [openTasks]);
  const conds = useMemo(() => conditions ?? [], [conditions]);
  const today = localToday();
  const sections = useMemo(
    () =>
      projectsByStatus(
        list,
        (p) => projectDisplayStatus(p, tasks, today, conds, list),
        // The Waiting section orders by the shared badge's sort key (condition
        // waits longest-first, then date waits soonest-first); others fall back
        // to createdAt.
        (p) => waitingBadge(p, tasks, conds, list, today)?.sortKey ?? p.createdAt,
      ),
    [list, tasks, conds, today],
  );
  // A project's waiting badge text, non-null only for waiting projects:
  // "for <elapsed>" for a condition wait, "until <day>" for a date wait.
  const labelOf = useCallback(
    (p: Project) => waitingBadge(p, tasks, conds, list, today)?.label ?? null,
    [tasks, conds, list, today],
  );
  const view = listView({ count: list.length, isLoading, loadError: null });
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
            placeholder="Name an outcome"
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
              labelOf={labelOf}
              onOpen={(p) => void navigate(`/projects/${p.id}`)}
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
  labelOf,
  onOpen,
}: {
  status: ProjectDisplayStatus;
  projects: Project[];
  labelOf: (p: Project) => string | null;
  onOpen: (p: Project) => void;
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
        <span>{PROJECT_DISPLAY_STATUS_LABELS[status]}</span>
        <span className="text-muted-foreground/70">· {projects.length}</span>
      </button>
      {!collapsed && (
        <ul className="space-y-3">
          {projects.map((item) => {
            const waited = labelOf(item);
            return (
              <li key={item.id}>
                <div className="flex items-center gap-3 rounded-xl border bg-card px-4 py-4">
                  <span className="shrink-0 text-xl" aria-hidden>
                    {item.icon}
                  </span>
                  <button
                    type="button"
                    onClick={() => onOpen(item)}
                    className="flex-1 truncate text-left text-base"
                  >
                    {item.title}
                  </button>
                  {waited && (
                    <span
                      className="shrink-0 text-sm text-muted-foreground"
                      aria-label={`Waiting ${waited}`}
                    >
                      {waited}
                    </span>
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
