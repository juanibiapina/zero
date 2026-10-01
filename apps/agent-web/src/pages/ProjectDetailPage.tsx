import { taskRecurrenceLabel } from "@zero/agent-core";
import { TaskRecurrence } from "@/components/task-recurrence";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { isNull } from "@tanstack/db";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ErrorText } from "@/components/ConnectionStatus";
import { ProjectOptionList } from "@/components/ProjectOptionList";
import { CalendarGlyph, ScheduleMenu } from "@/components/schedule-menu";
import { useTaskEditor } from "@/components/task-editor";
import { reportTodoError } from "@/lib/todo-feedback";
import { useTodoAdd, type TodoAddKind } from "@/components/todo-composer";
import { useLocalDay } from "@/lib/local-day";
import { EmojiPicker } from "frimousse";
import {
  isBasisStale,
  compareByOrder,
  isProjectAfter,
  messageOf,
  orderKeyBetween,
  projectAfters,
  projectAfterRemovalImpact,
  projectAfterRemovalWarning,
  projectDisplayStatus,
  projectStatusContext,
  scheduleLabel,
  PROJECT_DISPLAY_STATUS_LABELS,
  undoableAction,
  type ProjectDisplayStatus,
  type ProjectEditFields,
  type Project,
  type ProjectState,
  type Task,
  type TaskdoReplica,
  type TodoTasks,
  type TodoWaits,
  type WaitingCondition,
} from "@zero/agent-core";
import {
  requestIconSuggestions,
  useIconSuggestions,
} from "@/lib/icon-suggestions";
import { useTodoData } from "@/lib/todo-data";
import { cn } from "@/lib/utils";

// A project opens its OWN screen (route /projects/:id), not a bottom sheet: it
// is a place you work, not a transient sheet. Identity, description, dominant
// status, manual Waiting, After relationships, and Tasks are sibling regions in
// that order. See docs/entities/project.md.
export function ProjectDetailPage() {
  const { replica } = useTodoData();
  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10">
        <div className="mx-auto w-full max-w-2xl">
          {replica ? (
            <ProjectDetailReady replica={replica} />
          ) : (
            <div className="min-h-24" />
          )}
        </div>
      </main>
    </div>
  );
}

function ProjectDetailReady({ replica }: { replica: TaskdoReplica }) {
  const { projects: api, tasks: tasksApi, waits: waitsApi } = replica;
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

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

  const commitState = useCallback(
    (pid: string, state: ProjectState) => {
      setError(null);
      const tx = api.setState(pid, state);
      void tx.isPersisted.promise
        .catch((e) => setError(messageOf(e)));
    },
    [api],
  );

  const completeProject = useCallback(
    (item: Project) => {
      undoableAction({
        message: "Project completed",
        description: `${item.icon} ${item.title}`,
        act: () => {
          const tx = api.setState(item.id, "done");
          return tx;
        },
        undo: () => {
          const tx = api.reopen(item);
          return tx;
        },
        onError: setError,
      });
    },
    [api],
  );

  // Delete happens immediately (it is already behind the overflow menu — a
  // deliberate act), then we return to the list. The write lives on the shared
  // replica, so it persists even as this screen unmounts. The canonical model
  // applies the task and waiting-condition cascade in the same local write.
  const commitDelete = useCallback(
    (pid: string) => {
      setError(null);
      const tx = api.remove(pid);
      tx.isPersisted.promise
        .catch((e) => { setError(messageOf(e)); reportTodoError(e); });
      void navigate("/projects");
    },
    [api, navigate],
  );

  const today = useLocalDay();
  const detail = useTaskEditor({ replica, list: tasks.filter((task) => task.projectId === id), projects: list, tasks, conditions: conds, currentProjectId: id, onError: setError });
  const add = useTodoAdd({ replica, projectId: id, initialKind: "task" });

  // The project isn't in the loaded set: a bad or deleted id. Once the
  // collection has loaded (not just an empty pre-hydration snapshot), redirect
  // back to the list.
  if (!project) {
    if (isLoading) return <div className="min-h-24" />;
    return <Navigate to="/projects" replace />;
  }

  const displayStatus = projectDisplayStatus(project, tasks, today, conds, list);
  const statusContext = projectStatusContext(
    project,
    tasks,
    conds,
    list,
    today,
  );

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
        key={`header-${project.id}`}
        project={project}
        displayStatus={displayStatus}
        statusContext={statusContext?.label ?? null}
        deletionWarning={projectAfterRemovalWarning(
          projectAfterRemovalImpact(project.id, conds, list),
        )}
        onEdit={commitEdit}
        description={
          <ProjectDescription
            key={`description-${project.id}`}
            project={project}
            onEdit={commitEdit}
          />
        }
        onState={(state) => {
          if (state === "done") {
            completeProject(project);
            void navigate("/projects");
          } else {
            commitState(project.id, state);
          }
        }}
        onDelete={() => commitDelete(project.id)}
      />

      <ProjectAddMenu project={project} onOpen={add.open} />

      <ProjectRelations
        project={project}
        waitsApi={waitsApi}
        projects={list}
        tasks={tasks}
        today={today}
        onError={setError}
      />

      <div className="pt-4">
        <ProjectTasks
          api={tasksApi}
          projectId={project.id}
          onComplete={detail.complete}
          onOpen={detail.open}
          onAdd={() => add.open("task")}
          onError={setError}
        />
      </div>
      {detail.editor}
      {add.composer}
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
  statusContext,
  deletionWarning,
  onEdit,
  description,
  onState,
  onDelete,
}: {
  project: Project;
  displayStatus: ProjectDisplayStatus;
  statusContext: string | null;
  deletionWarning: string | null;
  onEdit: (id: string, fields: ProjectEditFields) => void;
  description: React.ReactNode;
  onState: (state: ProjectState) => void;
  onDelete: () => void;
}) {
  // Seeded from the project once; keyed by project id at the call site, so a
  // different project remounts this with fresh state instead of a reseed effect.
  const [title, setTitle] = useState(project.title);
  const [pickingIcon, setPickingIcon] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const { authenticatedFeatures = true } = useTodoData();

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
    <>
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
            {authenticatedFeatures ? <SuggestedIconRow project={project} onPick={applyIcon} /> : null}
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
          <OverflowMenu>
            {project.state === "backlog" ? (
              <MenuItem onSelect={() => onState("in-play")}>Move out of backlog</MenuItem>
            ) : (
              <MenuItem onSelect={() => onState("backlog")}>
                Move to backlog
              </MenuItem>
            )}
            <MenuItem onSelect={() => onState("done")}>Mark done</MenuItem>
            <MenuItem destructive onSelect={() => setDeleting(true)}>
              Delete project
            </MenuItem>
          </OverflowMenu>
        </div>
      </div>
      <div><Button variant="outline" aria-label={`Project status: ${PROJECT_DISPLAY_STATUS_LABELS[displayStatus]}${statusContext ? ` · ${statusContext}` : ""}`} onClick={() => { commitTitle(); setStatusOpen(true); }}>
        {PROJECT_DISPLAY_STATUS_LABELS[displayStatus]}{statusContext ? ` · ${statusContext}` : ""}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="m9 5 7 7-7 7" /></svg>
      </Button></div>
      {description}
    </div>
    <Sheet open={statusOpen} onClose={() => setStatusOpen(false)} title="Project status">
      <div className="flex flex-col gap-4">
        <p className="font-medium">{PROJECT_DISPLAY_STATUS_LABELS[displayStatus]}{statusContext ? ` · ${statusContext}` : ""}</p>
        <p className="text-sm text-muted-foreground">{{ active: "This Project has dated work available now.", next: "Give a Task a date to bring this Project forward.", waiting: "This Project has future-dated work or a Waiting condition to review.", after: "This Project follows another Project's completion.", backlog: "This Project stays in Backlog until you move it out.", done: "This Project is complete." }[displayStatus]}</p>
        <Button variant="outline" onClick={() => { setStatusOpen(false); onState(project.state === "backlog" ? "in-play" : "backlog"); }}>{project.state === "backlog" ? "Move out of backlog" : "Move to backlog"}</Button>
        <Button onClick={() => { setStatusOpen(false); onState("done"); }}>Mark done</Button>
      </div>
    </Sheet>
    <Sheet
      open={deleting}
      onClose={() => setDeleting(false)}
      title={`Delete “${project.title}”?`}
    >
      <div className="flex flex-col gap-6">
        <p className="text-sm text-muted-foreground">
          This permanently deletes the Project, all its Tasks, its Waiting
          conditions, and its After relationships. This cannot be undone.
          {deletionWarning ? ` ${deletionWarning}` : ""}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setDeleting(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              setDeleting(false);
              onDelete();
            }}
          >
            Delete
          </Button>
        </div>
      </div>
    </Sheet>
    </>
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

// The per-task date chip on a project row: shows the task's show-up date (or
// "No date" when groomed) and opens the shared scheduler. Picking a date commits
// the task to Home (an arrived date makes the project active); "No date" keeps it
// grooming here. This is the replacement for the retired take-on/park star — the
// date is the sole commitment gate. See docs/entities/task.md.
function TaskDateChip({
  showUpDate,
  onPick,
}: {
  showUpDate: string | null;
  onPick: (date: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const today = useLocalDay();
  const scheduled = showUpDate != null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            scheduled ? `Reschedule (${showUpDate})` : "Add a date"
          }
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors",
            scheduled
              ? "font-medium text-primary hover:bg-primary/10"
              : "text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground",
          )}
        >
          <CalendarGlyph className="size-3.5" />
          <span>{scheduled ? scheduleLabel(showUpDate, today) : "No date"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <ScheduleMenu
          today={today}
          selected={showUpDate}
          onPick={(d) => {
            onPick(d);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

// The project's tasks, groomed in place: complete one with its circle, commit it
// to Home by giving it a date with the date chip (or clear the date to keep
// grooming it here), add a new one (undated by default — grooming is
// collect-then-schedule, so a project-screen task is not surfaced on Home until
// it has an arrived date). Reads this project's open tasks in the shared manual
// order; the handle moves a task within this filtered list.
function ProjectTasks({
  api,
  projectId,
  onComplete,
  onOpen,
  onAdd,
  onError,
}: {
  api: TodoTasks;
  projectId: string;
  onComplete: (task: Task) => void;
  onOpen: (task: Task) => void;
  onAdd: () => void;
  onError: (message: string) => void;
}) {
  const { data: tasks } = useLiveQuery((q) =>
    q.from({ t: api.collection }).where(({ t }) => isNull(t.completedAt)),
  );
  const list = (tasks ?? [])
    .filter((t: Task) => t.projectId === projectId)
    .sort(compareByOrder);
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = list.findIndex((task) => task.id === active.id);
    const newIndex = list.findIndex((task) => task.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const moved = arrayMove(list, oldIndex, newIndex);
    const position = moved.findIndex((task) => task.id === active.id);
    const prev = moved[position - 1]?.sortKey ?? null;
    const next = moved[position + 1]?.sortKey ?? null;
    const tx = api.reorder(String(active.id), orderKeyBetween(prev, next));
    tx.isPersisted.promise.catch((error) => onError(messageOf(error)));
  };

  const onSchedule = useCallback(
    (t: Task, showUpDate: string | null) => {
      const tx = api.reschedule(t.id, showUpDate);
      tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
    },
    [api, onError],
  );

  if (list.length === 0) return null;

  return (
    <section className="flex flex-col gap-2" aria-labelledby="project-tasks-heading">
      <div className="flex min-h-12 items-center justify-between gap-3">
        <h2
          id="project-tasks-heading"
          className="text-sm font-semibold text-muted-foreground"
        >
          Tasks
        </h2>
        <Button variant="ghost" size="sm" aria-label="Add task" onClick={onAdd}>+</Button>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={list.map((task) => task.id)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="flex flex-col gap-2">
            {list.map((task) => (
              <ProjectTaskRow
                key={task.id}
                task={task}
                onComplete={() => onComplete(task)}
                onOpen={() => onOpen(task)}
                onSchedule={(date) => onSchedule(task, date)}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </section>
  );
}

function ProjectTaskRow({
  task,
  onComplete,
  onOpen,
  onSchedule,
}: {
  task: Task;
  onComplete: () => void;
  onOpen: () => void;
  onSchedule: (date: string | null) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });
  const dragStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 1 : undefined,
    boxShadow: isDragging ? "0 8px 24px rgba(0,0,0,0.15)" : undefined,
  };

  return (
    <li
      ref={setNodeRef}
      style={dragStyle}
      className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5"
    >
      <button
        type="button"
        aria-label={`Reorder "${task.text}"`}
        className="shrink-0 cursor-grab touch-none rounded-md px-1 text-muted-foreground/40 transition-colors hover:text-muted-foreground focus-visible:text-muted-foreground active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="currentColor"
          aria-hidden="true"
        >
          <circle cx="5" cy="4" r="1.4" />
          <circle cx="11" cy="4" r="1.4" />
          <circle cx="5" cy="8" r="1.4" />
          <circle cx="11" cy="8" r="1.4" />
          <circle cx="5" cy="12" r="1.4" />
          <circle cx="11" cy="12" r="1.4" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={`Complete "${task.text}"`}
        className="size-5 shrink-0 rounded-full border-2 border-muted-foreground/50 transition-colors hover:border-primary hover:bg-primary/10"
        onClick={onComplete}
      />
      <button type="button" className="min-w-0 flex-1 break-words text-left text-sm" aria-label={[`Edit "${task.text}"`, taskRecurrenceLabel(task)].filter(Boolean).join(", ")} onClick={onOpen}><span>{task.text}</span><TaskRecurrence task={task} /></button>
      <TaskDateChip showUpDate={task.showUpDate} onPick={onSchedule} />
    </li>
  );
}

function ProjectAddMenu({ project, onOpen }: { project: Project; onOpen: (kind: TodoAddKind) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return <div className="flex justify-end"><Popover open={menuOpen} onOpenChange={setMenuOpen}>
    <PopoverTrigger asChild><Button aria-label={`Add to ${project.title}`}>+ Add</Button></PopoverTrigger>
    <PopoverContent align="end" className="flex w-56 flex-col gap-1 p-1">
      <p className="px-3 py-2 text-sm font-semibold">Add to {project.title}</p>
      {([["task", "Task"], ["waiting", "Waiting condition"], ["after", "After project"], ["project", "Project"]] as const).map(([kind, label]) => <Button key={kind} variant="ghost" onClick={() => { setMenuOpen(false); onOpen(kind); }}>{label}</Button>)}
    </PopoverContent>
  </Popover></div>;
}

function conditionLabel(condition: WaitingCondition): string {
  return condition.kind === "free-text" ? condition.text : "";
}

function ProjectRelations({
  project,
  waitsApi,
  projects,
  tasks,
  today,
  onError,
}: {
  project: Project;
  waitsApi: TodoWaits;
  projects: Project[];
  tasks: Task[];
  today: string;
  onError: (message: string) => void;
}) {
  const navigate = useNavigate();
  const { data: allConditions } = useLiveQuery((q) =>
    q.from({ w: waitsApi.collection }),
  );
  const conditions = allConditions ?? [];
  const afters = projectAfters(project.id, conditions, projects);
  const waiting = conditions.filter(
    (condition: WaitingCondition) =>
      condition.projectId === project.id && !isProjectAfter(condition),
  );
  const [waitingOpen, setWaitingOpen] = useState(false);
  const [afterOpen, setAfterOpen] = useState(false);
  const [text, setText] = useState("");

  const write = (tx: { isPersisted: { promise: Promise<unknown> } }): void => {
    tx.isPersisted.promise.catch((error) => onError(messageOf(error)));
  };
  const addWaiting = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    write(waitsApi.addWaiting(project.id, trimmed));
    setText("");
    setWaitingOpen(false);
  };
  const addAfter = (afterProjectId: string) => {
    write(waitsApi.addAfter(project.id, afterProjectId));
    setAfterOpen(false);
  };

  if (waiting.length === 0 && afters.length === 0) return null;

  return (
    <div className="flex flex-col gap-6">
      {waiting.length > 0 && (
        <section className="flex flex-col gap-2" aria-labelledby="waiting-heading">
          <div className="flex min-h-12 items-center justify-between gap-3">
            <h2 id="waiting-heading" className="text-sm font-semibold text-muted-foreground">
              Waiting on
            </h2>
            <Popover open={waitingOpen} onOpenChange={setWaitingOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" aria-label="Add waiting condition">
                  +
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="flex w-80 flex-col gap-3">
                <h3 className="font-semibold">Add waiting condition</h3>
                <Input
                  value={text}
                  aria-label="Waiting condition"
                  placeholder="What are you waiting for?"
                  autoFocus
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") addWaiting();
                  }}
                />
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setWaitingOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={addWaiting} disabled={!text.trim()}>
                    Add
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          </div>
          <ul className="flex flex-col gap-1">
            {waiting.map((condition) => {
              const label = conditionLabel(condition);
              return (
                <li key={condition.id} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 whitespace-normal">{label}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Resolve condition: ${label}`}
                    onClick={() => write(waitsApi.resolveWaiting(condition.id))}
                  >
                    Resolve
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Delete condition: ${label}`}
                    onClick={() => write(waitsApi.remove(condition.id))}
                  >
                    Remove
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {afters.length > 0 && (
        <section className="flex flex-col gap-2" aria-labelledby="after-heading">
          <div className="flex min-h-12 items-center justify-between gap-3">
            <h2 id="after-heading" className="text-sm font-semibold text-muted-foreground">
              After
            </h2>
            <Popover open={afterOpen} onOpenChange={setAfterOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" aria-label="Add After project">
                  +
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="flex w-80 flex-col gap-2">
                <h3 className="font-semibold">After project</h3>
                <ProjectOptionList projects={projects} tasks={tasks} conditions={conditions}
                  today={today} afterSourceProjectId={project.id} emptyCopy="No available projects"
                  onPick={(candidateId) => { if (candidateId) addAfter(candidateId); }} />
              </PopoverContent>
            </Popover>
          </div>
          <ul className="flex flex-col gap-1">
            {afters.map(({ relationship, target }) => (
              <li key={relationship.id} className="flex items-center gap-2 rounded-lg border px-3 py-2">
                <button
                  type="button"
                  aria-label={`Open project ${target?.title ?? "After project"}`}
                  className="flex min-h-12 min-w-0 flex-1 items-center gap-3 text-left"
                  disabled={!target}
                  onClick={() => {
                    if (target) void navigate(`/projects/${target.id}`);
                  }}
                >
                  <span className="shrink-0 text-lg" aria-hidden>{target?.icon ?? "📁"}</span>
                  <span className="min-w-0 flex-1 whitespace-normal text-sm font-medium">
                    {target?.title ?? "Another project"}
                  </span>
                  <span className="text-muted-foreground" aria-hidden>›</span>
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove After relationship with ${target?.title ?? "project"}`}
                  onClick={() => write(waitsApi.remove(relationship.id))}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
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
