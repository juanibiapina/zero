import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { isNull } from "@tanstack/db";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ErrorText } from "@/components/ConnectionStatus";
import { EmojiPicker } from "frimousse";
import {
  dayLabel,
  isBasisStale,
  localToday,
  messageOf,
  projectDisplayStatus,
  STATUS_LABELS,
  undoableAction,
  waitingUntil,
  type ProjectEditFields,
  type ProjectStatus,
  type WaitingCondition,
  type WaitingConditionKind,
} from "@zero/agent-core";
import {
  requestIconSuggestions,
  useIconSuggestions,
} from "@/lib/icon-suggestions";
import { getProjectsApi, type ProjectsApi } from "@/lib/projects-collection";
import { getTasksApi, type TasksApi } from "@/lib/tasks-collection";
import { getWaitsApi, type WaitsApi } from "@/lib/waits-collection";
import { useForegroundRefetch } from "@/lib/screen-hooks";
import { cn } from "@/lib/utils";
import { type Project } from "@/lib/projects";
import { type Task } from "@/lib/tasks";

// A project opens its OWN screen (route /projects/:id), not a bottom sheet: it
// is a place you work (groom tasks, record what it waits on), which the
// bottom-sheet guidance says not to put in a transient sheet. The screen leads
// with the work (tasks, then waiting) and keeps identity/management compact (an
// editable title, a de-emphasized icon, a derived-status pill, and an overflow
// menu for the status moves + delete). See docs/plans/todo-project-detail-rework.md.
export function ProjectDetailPage() {
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
  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10">
        <div className="mx-auto w-full max-w-2xl">
          {api && tasksApi && waitsApi ? (
            <ProjectDetailReady api={api} tasksApi={tasksApi} waitsApi={waitsApi} />
          ) : (
            <div className="min-h-24" />
          )}
        </div>
      </main>
    </div>
  );
}

function ProjectDetailReady({
  api,
  tasksApi,
  waitsApi,
}: {
  api: ProjectsApi;
  tasksApi: TasksApi;
  waitsApi: WaitsApi;
}) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useForegroundRefetch(api.refetch);

  const { data: projects, isLoading } = useLiveQuery((q) =>
    q.from({ p: api.collection }).orderBy(({ p }) => p.createdAt, "asc"),
  );
  const { data: openTasks } = useLiveQuery((q) =>
    q.from({ t: tasksApi.collection }).where(({ t }) => isNull(t.completedAt)),
  );
  const { data: conditions } = useLiveQuery((q) =>
    q.from({ w: waitsApi.collection }),
  );

  const list = useMemo(() => projects ?? [], [projects]);
  const tasks = useMemo(() => openTasks ?? [], [openTasks]);
  const conds = useMemo(() => conditions ?? [], [conditions]);
  const project = list.find((p) => p.id === id) ?? null;

  const commitEdit = useCallback(
    (pid: string, fields: ProjectEditFields) => {
      setError(null);
      const tx = api.edit(pid, fields);
      tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
    },
    [api],
  );

  const commitStatus = useCallback(
    (pid: string, status: ProjectStatus) => {
      setError(null);
      const tx = api.setStatus(pid, status);
      tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
    },
    [api],
  );

  // Delete happens immediately (it is already behind the overflow menu — a
  // deliberate act), then we return to the list. The write lives on the shared
  // projects data layer, so it persists even as this screen unmounts. The server
  // cascades the delete to the project's tasks and waiting conditions, so once
  // the delete persists we re-pull those two collections to drop any lingering
  // orphan (a future-dated task of this project would otherwise sit in Upcoming
  // until the next refetch — Upcoming applies no project gate).
  const commitDelete = useCallback(
    (pid: string) => {
      setError(null);
      const tx = api.remove(pid);
      tx.isPersisted.promise
        .then(() => Promise.all([tasksApi.refetch(), waitsApi.refetch()]))
        .catch((e) => setError(messageOf(e)));
      void navigate("/projects");
    },
    [api, tasksApi, waitsApi, navigate],
  );

  // The project isn't in the loaded set: a bad or deleted id. Once the
  // collection has loaded (not just an empty pre-hydration snapshot), redirect
  // back to the list.
  if (!project) {
    if (isLoading) return <div className="min-h-24" />;
    return <Navigate to="/projects" replace />;
  }

  const today = localToday();
  const displayStatus = projectDisplayStatus(project, tasks, today, conds, list);

  return (
    <div className="space-y-6">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 text-muted-foreground"
        onClick={() => void navigate("/projects")}
      >
        ← Projects
      </Button>

      {error && <ErrorText>{error}</ErrorText>}

      <ProjectHeader
        project={project}
        displayStatus={displayStatus}
        onEdit={commitEdit}
        onStatus={(status) => {
          if (status === "done") {
            commitStatus(project.id, "done");
            void navigate("/projects");
          } else {
            commitStatus(project.id, status);
          }
        }}
        onDelete={() => commitDelete(project.id)}
      />

      {/* The description is the project's statement of intent — why this outcome
          matters. It sits directly under the title, above the work. */}
      <ProjectDescription project={project} onEdit={commitEdit} />

      <ProjectTasks api={tasksApi} projectId={project.id} onError={setError} />

      <ProjectWaits
        project={project}
        waitsApi={waitsApi}
        tasks={tasks}
        projects={list}
        today={today}
        onError={setError}
      />
    </div>
  );
}

// The pre-warmed AI icon suggestions, shown above the manual picker inside the
// icon popover. The row only mounts when the popover opens, so its mount effect
// is the fetch-on-open fallback: a cache miss here (a different device, an
// eviction, an offline creation) fetches now; a warmed cache shows instantly.
// A failed or empty result degrades to the manual picker below with no blocking.
function SuggestedIconRow({
  project,
  onPick,
}: {
  project: Project;
  onPick: (emoji: string) => void;
}) {
  const basis = useMemo(
    () => ({ title: project.title, description: project.description }),
    [project.title, project.description],
  );
  const cached = useIconSuggestions(project.id);

  // Fetch-on-open: no-ops when an entry already exists (the create-time warm),
  // so this only fires on a genuine cache miss.
  useEffect(() => {
    void requestIconSuggestions(project.id, basis);
  }, [project.id, basis]);

  const refresh = () => {
    void requestIconSuggestions(project.id, basis, { force: true });
  };

  const status = cached?.status;
  const icons = cached?.icons ?? [];
  const stale = !!cached && status === "ready" && isBasisStale(cached.basis, basis);
  const loading = !cached || status === "loading";

  const RefreshButton = (
    <button
      type="button"
      aria-label="Refresh suggested icons"
      onClick={refresh}
      className={cn(
        "shrink-0 rounded-md px-1.5 py-1 text-sm transition-colors hover:bg-accent",
        stale ? "text-foreground" : "text-muted-foreground",
      )}
    >
      ↻
    </button>
  );

  return (
    <div className="flex min-h-9 items-center gap-1 border-b px-2 py-1.5">
      <span className="mr-1 shrink-0 text-xs font-medium text-muted-foreground">
        Suggested
      </span>
      {loading ? (
        <span className="text-sm text-muted-foreground">
          Loading suggested icons…
        </span>
      ) : icons.length > 0 ? (
        <>
          <div className="flex flex-wrap items-center gap-0.5">
            {icons.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={`Use suggested icon ${emoji}`}
                onClick={() => onPick(emoji)}
                className="flex size-8 items-center justify-center rounded-md text-lg hover:bg-accent"
              >
                {emoji}
              </button>
            ))}
          </div>
          <div className="ml-auto">{RefreshButton}</div>
        </>
      ) : (
        <>
          <span className="text-sm text-muted-foreground">
            Couldn&apos;t load suggestions
          </span>
          <div className="ml-auto">{RefreshButton}</div>
        </>
      )}
    </div>
  );
}

// The identity header: a de-emphasized icon (tap to reveal the picker), the
// title as an editable heading (commit on blur / Enter), the derived-status
// pill, and an overflow menu holding the occasional status moves + delete.
function ProjectHeader({
  project,
  displayStatus,
  onEdit,
  onStatus,
  onDelete,
}: {
  project: Project;
  displayStatus: ProjectStatus;
  onEdit: (id: string, fields: ProjectEditFields) => void;
  onStatus: (status: ProjectStatus) => void;
  onDelete: () => void;
}) {
  // Seeded from the project once; keyed by project id at the call site, so a
  // different project remounts this with fresh state instead of a reseed effect.
  const [title, setTitle] = useState(project.title);
  const [pickingIcon, setPickingIcon] = useState(false);

  const commitTitle = () => {
    const trimmed = title.trim();
    if (trimmed === "" || trimmed === project.title) {
      setTitle(project.title);
      return;
    }
    onEdit(project.id, { title: trimmed });
  };

  // Apply an icon (from a suggestion chip or the manual picker) and close the
  // popover. A no-op edit is skipped so an unchanged pick does not churn.
  const applyIcon = (emoji: string) => {
    if (emoji !== project.icon) onEdit(project.id, { icon: emoji });
    setPickingIcon(false);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <Popover open={pickingIcon} onOpenChange={setPickingIcon}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Change icon"
              className="shrink-0 rounded-lg px-1 text-3xl leading-none transition-colors hover:bg-accent"
            >
              {project.icon}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-fit p-0">
            {/* Pre-warmed AI suggestions sit above the full manual picker: an
                additive shortcut, never a replacement. */}
            <SuggestedIconRow project={project} onPick={applyIcon} />
            <EmojiPicker.Root
              className="isolate flex h-[368px] w-fit flex-col"
              onEmojiSelect={({ emoji }) => applyIcon(emoji)}
            >
              <EmojiPicker.Search
                autoFocus
                aria-label="Search emoji"
                placeholder="Search emoji…"
                className="z-10 mx-2 mt-2 mb-1 h-9 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <EmojiPicker.Viewport className="relative flex-1 outline-hidden">
                <EmojiPicker.Loading className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                  Loading…
                </EmojiPicker.Loading>
                <EmojiPicker.Empty className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                  No emoji found.
                </EmojiPicker.Empty>
                <EmojiPicker.List
                  className="select-none pb-1.5"
                  components={{
                    CategoryHeader: ({ category, ...props }) => (
                      <div
                        className="bg-popover px-3 pt-3 pb-1.5 text-xs font-medium text-muted-foreground"
                        {...props}
                      >
                        {category.label}
                      </div>
                    ),
                    Row: ({ children, ...props }) => (
                      <div className="scroll-my-1.5 px-1.5" {...props}>
                        {children}
                      </div>
                    ),
                    Emoji: ({ emoji, ...props }) => (
                      <button
                        aria-label={`Set icon ${emoji.emoji}`}
                        className="flex size-8 items-center justify-center rounded-md text-lg data-[active]:bg-accent"
                        {...props}
                      >
                        {emoji.emoji}
                      </button>
                    ),
                  }}
                />
              </EmojiPicker.Viewport>
            </EmojiPicker.Root>
          </PopoverContent>
        </Popover>
        <input
          value={title}
          aria-label="Project title"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
          className="min-w-0 flex-1 border-0 bg-transparent p-0 text-2xl font-bold tracking-tight outline-none focus-visible:ring-0"
        />
        <div className="flex shrink-0 items-center gap-2 pt-1">
          <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
            {STATUS_LABELS[displayStatus]}
          </span>
          <OverflowMenu>
            {project.status === "backlog" ? (
              <MenuItem onSelect={() => onStatus("next")}>Put in play</MenuItem>
            ) : (
              <MenuItem onSelect={() => onStatus("backlog")}>
                Move to backlog
              </MenuItem>
            )}
            <MenuItem onSelect={() => onStatus("done")}>Mark done</MenuItem>
            <MenuItem destructive onSelect={onDelete}>
              Delete project
            </MenuItem>
          </OverflowMenu>
        </div>
      </div>
    </div>
  );
}

// A small overflow ("⋯") disclosure: a toggle button revealing a menu, closed by
// Escape or an outside click. Built inline (the app ships no menu primitive) and
// kept minimal: a handful of rarely-used commands, off the main work path.
function OverflowMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Project actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="rounded-md px-2 py-1 text-lg leading-none text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        ⋯
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            className="absolute right-0 z-50 mt-1 min-w-44 overflow-hidden rounded-lg border bg-popover p-1 shadow-md"
            onClick={() => setOpen(false)}
          >
            {children}
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({
  children,
  onSelect,
  destructive,
}: {
  children: React.ReactNode;
  onSelect: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={cn(
        "block w-full rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
        destructive && "text-destructive hover:bg-destructive/10",
      )}
    >
      {children}
    </button>
  );
}

// The project's tasks, groomed in place: complete one with its circle, take it
// on / park it with the star, add a new one (parked by default — grooming is
// collect-then-take-on, so a project-screen task is not surfaced on Home until
// it is taken on). Reads the shared tasks collection filtered to this project.
function ProjectTasks({
  api,
  projectId,
  onError,
}: {
  api: TasksApi;
  projectId: string;
  onError: (message: string) => void;
}) {
  const { data: tasks } = useLiveQuery((q) =>
    q
      .from({ t: api.collection })
      .where(({ t }) => isNull(t.completedAt))
      .orderBy(({ t }) => t.createdAt, "asc"),
  );
  const [text, setText] = useState("");
  const list = (tasks ?? []).filter((t: Task) => t.projectId === projectId);

  const onAdd = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // A project-screen task is parked (takenOnAt null) and shown up today; it is
    // groomed on this screen and taken onto Home from here.
    const tx = api.add(trimmed, localToday(), projectId);
    tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
    setText("");
  }, [api, text, projectId, onError]);

  // Completing commits immediately (the row leaves at once) and raises the same
  // single bottom Undo snackbar used on Home; Undo reopens the task.
  const onComplete = useCallback(
    (task: Task) => {
      undoableAction({
        message: "Completed",
        act: () => api.complete(task.id),
        undo: () => api.reopen(task),
        onError,
      });
    },
    [api, onError],
  );

  const onToggleTakenOn = useCallback(
    (t: Task) => {
      const tx = t.takenOnAt ? api.park(t.id) : api.takeOn(t.id);
      tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
    },
    [api, onError],
  );

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-muted-foreground">Tasks</h2>
      {list.length > 0 && (
        <ul className="space-y-2">
          {list.map((t) => (
            <li
              key={t.id}
              className="flex items-center gap-3 rounded-lg border px-3 py-2.5"
            >
              <button
                type="button"
                aria-label={`Complete "${t.text}"`}
                className="size-5 shrink-0 rounded-full border-2 border-muted-foreground/50 transition-colors hover:border-primary hover:bg-primary/10"
                onClick={() => onComplete(t)}
              />
              <span className="flex-1 text-sm">{t.text}</span>
              <button
                type="button"
                aria-label={t.takenOnAt ? `Park "${t.text}"` : `Take on "${t.text}"`}
                aria-pressed={t.takenOnAt != null}
                className={cn(
                  "shrink-0 text-lg leading-none transition-colors",
                  t.takenOnAt
                    ? "text-amber-500"
                    : "text-muted-foreground/40 hover:text-muted-foreground",
                )}
                onClick={() => onToggleTakenOn(t)}
              >
                {t.takenOnAt ? "★" : "☆"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onAdd();
        }}
      >
        <Input
          value={text}
          placeholder="Add a task"
          aria-label="Add a task"
          className="h-10"
          onChange={(e) => setText(e.target.value)}
        />
        <Button type="submit" size="sm" disabled={text.trim() === ""}>
          Add
        </Button>
      </form>
    </section>
  );
}

// A human label for a waiting condition.
function conditionLabel(
  c: WaitingCondition,
  tasks: Task[],
  projects: Project[],
): string {
  if (c.kind === "free-text") return c.text ?? "(unspecified)";
  if (c.kind === "task-done") {
    const t = tasks.find((x) => x.id === c.refId);
    return `until “${t?.text ?? "?"}” is done`;
  }
  const p = projects.find((x) => x.id === c.refId);
  return `until “${p?.title ?? "?"}” is ${c.targetStatus}`;
}

// The waiting conditions for a project: the open ones, plus a "+ Waiting
// condition" control that opens the kind/param builder in a popover (off the
// main flow, not an inline form that shifts the section). Structured kinds
// (task-done, project-status) clear themselves in code; a free-text one is
// resolved by hand (or later the AI).
function ProjectWaits({
  project,
  waitsApi,
  tasks,
  projects,
  today,
  onError,
}: {
  project: Project;
  waitsApi: WaitsApi;
  tasks: Task[];
  projects: Project[];
  today: string;
  onError: (message: string) => void;
}) {
  const { data: allConditions } = useLiveQuery((q) =>
    q.from({ w: waitsApi.collection }),
  );
  const list = (allConditions ?? []).filter(
    (c: WaitingCondition) => c.projectId === project.id,
  );
  // A future-dated taken-on task makes the project wait until that day, derived
  // with no stored row. Shown as an automatic reason (no Resolve/delete); it
  // clears when the day comes or the task moves.
  const until = waitingUntil(project, tasks, today);

  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<WaitingConditionKind>("free-text");
  const [text, setText] = useState("");
  const [refId, setRefId] = useState("");
  const [targetStatus, setTargetStatus] = useState<ProjectStatus>("done");

  const otherProjects = projects.filter((p) => p.id !== project.id);
  const openTasks = tasks.filter((t) => t.completedAt == null);

  const write = (tx: { isPersisted: { promise: Promise<unknown> } }): void => {
    tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
  };

  // Reset the draft whenever the popover closes (a cancel via outside click, or
  // a successful add), so it reopens clean.
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setText("");
      setRefId("");
    }
  };

  const onAdd = () => {
    if (kind === "free-text") {
      const trimmed = text.trim();
      if (!trimmed) return;
      write(waitsApi.add(project.id, "free-text", { text: trimmed }));
    } else if (kind === "task-done") {
      if (!refId) return;
      write(waitsApi.add(project.id, "task-done", { refId }));
    } else {
      if (!refId) return;
      write(waitsApi.add(project.id, "project-status", { refId, targetStatus }));
    }
    onOpenChange(false);
  };

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-muted-foreground">Waiting on</h2>
      {until != null && (
        <ul className="space-y-1">
          <li className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
            <span className="flex-1">until {dayLabel(until, today)}</span>
            <span className="text-xs text-muted-foreground">auto</span>
          </li>
        </ul>
      )}
      {list.length > 0 && (
        <ul className="space-y-1">
          {list.map((c) => (
            <li
              key={c.id}
              className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
            >
              <span className="flex-1">{conditionLabel(c, tasks, projects)}</span>
              {c.kind === "free-text" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => write(waitsApi.resolve(c.id))}
                >
                  Resolve
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">auto</span>
              )}
              <button
                type="button"
                aria-label={`Delete condition`}
                className="text-muted-foreground/60 hover:text-foreground"
                onClick={() => write(waitsApi.remove(c.id))}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button size="sm" variant="outline" className="w-full">
            + Waiting condition
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 space-y-2">
          <select
            aria-label="Condition kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as WaitingConditionKind)}
            className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
          >
            <option value="free-text">Free text / external</option>
            <option value="task-done">Until a task is done</option>
            <option value="project-status">Until a project reaches a status</option>
          </select>
          {kind === "free-text" && (
            <Input
              value={text}
              aria-label="Waiting condition"
              placeholder="e.g. the letter comes back"
              className="h-9"
              autoFocus
              onChange={(e) => setText(e.target.value)}
            />
          )}
          {kind === "task-done" && (
            <select
              aria-label="Task"
              value={refId}
              onChange={(e) => setRefId(e.target.value)}
              className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
            >
              <option value="">Pick a task…</option>
              {openTasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.text}
                </option>
              ))}
            </select>
          )}
          {kind === "project-status" && (
            <div className="flex gap-2">
              <select
                aria-label="Project"
                value={refId}
                onChange={(e) => setRefId(e.target.value)}
                className="h-9 flex-1 rounded-md border bg-transparent px-2 text-sm"
              >
                <option value="">Pick a project…</option>
                {otherProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.icon} {p.title}
                  </option>
                ))}
              </select>
              <select
                aria-label="Target status"
                value={targetStatus}
                onChange={(e) => setTargetStatus(e.target.value as ProjectStatus)}
                className="h-9 rounded-md border bg-transparent px-2 text-sm"
              >
                {(["active", "next", "waiting", "backlog", "done"] as const).map(
                  (s) => (
                    <option key={s} value={s}>
                      {STATUS_LABELS[s]}
                    </option>
                  ),
                )}
              </select>
            </div>
          )}
          <Button size="sm" className="w-full" onClick={onAdd}>
            Add condition
          </Button>
        </PopoverContent>
      </Popover>
    </section>
  );
}

// The project's description: its statement of intent, an always-visible editable
// subtitle under the title (above the work). Commits on blur (not per keystroke)
// and can be cleared to null. Seeded once at mount (single-project route).
function ProjectDescription({
  project,
  onEdit,
}: {
  project: Project;
  onEdit: (id: string, fields: ProjectEditFields) => void;
}) {
  const [description, setDescription] = useState(project.description ?? "");

  const commit = () => {
    const next = description.trim() === "" ? null : description;
    if ((next ?? null) === (project.description ?? null)) return;
    onEdit(project.id, { description: next });
  };

  return (
    <textarea
      value={description}
      aria-label="Project description"
      rows={2}
      placeholder="What outcome are you after, and why does it matter?"
      onChange={(e) => setDescription(e.target.value)}
      onBlur={commit}
      className="w-full resize-none border-0 bg-transparent p-0 text-base text-muted-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:ring-0"
    />
  );
}
