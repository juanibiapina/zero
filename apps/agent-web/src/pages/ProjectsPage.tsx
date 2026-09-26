import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { isNull } from "@tanstack/db";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorText } from "@/components/ConnectionStatus";
import {
  LOADING_TEXT_DELAY_MS,
  localToday,
  messageOf,
  projectStatusSections,
  listView,
  PROJECT_DISPLAY_STATUS_LABELS,
  projectStatusContext,
  type Project,
  type ProjectDisplayStatus,
  type TaskdoReplica,
} from "@zero/agent-core";
import { useTodoData } from "@/lib/todo-data";
import { requestIconSuggestions } from "@/lib/icon-suggestions";
import { useDelayed } from "@/lib/screen-hooks";
import { cn } from "@/lib/utils";

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
  const { replica } = useTodoData();
  return replica ? (
    <ProjectsReady replica={replica} />
  ) : (
    <div className="min-h-24" />
  );
}

function ProjectsReady({ replica }: { replica: TaskdoReplica }) {
  const { projects: api, tasks: tasksApi, waits: waitsApi } = replica;
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
  const [collapseOverride, setCollapseOverride] = useState<Partial<Record<ProjectDisplayStatus, boolean>>>({});
  const inputRef = useRef<HTMLInputElement>(null);

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
      projectStatusSections({ projects: list, tasks, conditions: conds, today, collapseOverride }),
    [list, tasks, conds, today, collapseOverride],
  );
  // A project's waiting badge text, non-null only for waiting projects:
  // "for <elapsed>" for a condition wait, "until <day>" for a date wait.
  const labelOf = useCallback(
    (p: Project) =>
      projectStatusContext(p, tasks, conds, list, today)?.rowLabel ?? null,
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
              collapsed={section.collapsed}
              onToggle={() => setCollapseOverride((prev) => ({ ...prev, [section.status]: !section.collapsed }))}
              labelOf={labelOf}
              onOpen={(p) => void navigate(`/projects/${p.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Each section renders the shared fold decision; the page owns the user's
// temporary override so a new count can still change the default.
function ProjectSectionView({
  status,
  projects,
  collapsed,
  onToggle,
  labelOf,
  onOpen,
}: {
  status: ProjectDisplayStatus;
  projects: Project[];
  collapsed: boolean;
  onToggle: () => void;
  labelOf: (p: Project) => string | null;
  onOpen: (p: Project) => void;
}) {
  return (
    <section className="space-y-3">
      <button
        type="button"
        onClick={onToggle}
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
                      className="max-w-56 shrink-0 truncate text-sm text-muted-foreground"
                      aria-label={`${PROJECT_DISPLAY_STATUS_LABELS[status]} ${waited}`}
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
