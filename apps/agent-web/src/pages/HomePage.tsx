import { useCallback, useEffect, useRef, useState } from "react";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Sheet } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { ErrorText } from "@/components/ConnectionStatus";
import { Link, useNavigate } from "react-router";
import {
  ADD_MODE_LABEL,
  ADD_MODE_PLACEHOLDER,
  ALL_ADD_MODES,
  listView,
  LOADING_TEXT_DELAY_MS,
  homeCallToAction,
  homeCallToActionCopy,
  homeTasks,
  DEFAULT_ICON,
  localToday,
  messageOf,
  monthMatrix,
  orderKeyBetween,
  scheduleLabel,
  toast,
  tomorrow,
  undoableAction,
  weekdayShort,
  type AddMode,
  type HomeCallToAction,
} from "@zero/agent-core";
import { getTasksApi, type TasksApi } from "@/lib/tasks-collection";
import { getProjectsApi, type ProjectsApi } from "@/lib/projects-collection";
import { getWaitsApi, type WaitsApi } from "@/lib/waits-collection";
import { useDelayed, useForegroundRefetch } from "@/lib/screen-hooks";
import { requestIconSuggestions } from "@/lib/icon-suggestions";
import { type Task } from "@/lib/tasks";

// Home is one screen: a single reorderable list of tasks — the loose ones you
// dropped in and the project tasks you have taken on (availability-gated by
// homeTasks). There is no separate capture inbox after the single-list merge;
// the quick-add defaults to a task and can switch to a project. See
// docs/plans/todo-single-list-1-merge.md.
export function HomePage() {
  const [tasksApi, setTasksApi] = useState<TasksApi | null>(null);
  const [projectsApi, setProjectsApi] = useState<ProjectsApi | null>(null);
  const [waitsApi, setWaitsApi] = useState<WaitsApi | null>(null);
  useEffect(() => {
    let live = true;
    void getTasksApi().then((a) => live && setTasksApi(a));
    void getProjectsApi().then((a) => live && setProjectsApi(a));
    void getWaitsApi().then((a) => live && setWaitsApi(a));
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10">
        <div className="mx-auto w-full max-w-2xl space-y-6">
          <h1 className="text-2xl font-bold tracking-tight">Home</h1>
          {tasksApi && projectsApi && waitsApi ? (
            <Home
              tasksApi={tasksApi}
              projectsApi={projectsApi}
              waitsApi={waitsApi}
            />
          ) : (
            <div className="min-h-24" />
          )}
        </div>
      </main>
    </div>
  );
}

function Home({
  tasksApi,
  projectsApi,
  waitsApi,
}: {
  tasksApi: TasksApi;
  projectsApi: ProjectsApi;
  waitsApi: WaitsApi;
}) {
  const [mode, setMode] = useState<AddMode>("task");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const onAdd = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setError(null);
    if (mode === "project") {
      // Create the project but stay on Home; a toast is the escape hatch to jump
      // to it. The id comes off the optimistic insert transaction so the toast
      // can deep-link before the server round-trip finishes.
      const tx = projectsApi.add(trimmed);
      tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
      const id = String(tx.mutations[0]?.key);
      // Pre-warm emoji icon suggestions in the background so the picker shows
      // them instantly when the project is opened. Create is name-only, so the
      // basis is the title alone. Fire-and-forget; a failure only costs the shortcut.
      void requestIconSuggestions(id, { title: trimmed, description: null });
      toast("Project created", {
        description: trimmed,
        action: {
          label: "View",
          onPress: () => {
            void navigate(`/projects/${id}`);
          },
        },
      });
      setText("");
      inputRef.current?.focus();
      return;
    }
    // A quick-add with no project creates a loose open task on Home (no day).
    const tx = tasksApi.add(trimmed);
    tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
    setText("");
    inputRef.current?.focus();
  }, [tasksApi, projectsApi, mode, text, navigate]);

  return (
    <div className="space-y-6">
      <QuickAdd
        mode={mode}
        value={text}
        onModeChange={setMode}
        onChange={setText}
        onSubmit={onAdd}
        inputRef={inputRef}
      />
      {error && <ErrorText>{error}</ErrorText>}
      <TaskList
        api={tasksApi}
        projectsApi={projectsApi}
        waitsApi={waitsApi}
        onError={setError}
      />
    </div>
  );
}

// The "all clear" state: shown only when the Home list is empty. Its framing and
// destination are chosen by the shared homeCallToAction seam from the projects'
// derived states; every case routes to Projects.
function CallToAction({ action }: { action: HomeCallToAction }) {
  const { title, body, button } = homeCallToActionCopy(action);
  return (
    <section
      aria-label="Next step"
      className="flex flex-col items-center gap-4 rounded-2xl border border-dashed bg-card/50 px-6 py-12 text-center"
    >
      <div className="space-y-1">
        <p className="text-lg font-semibold">{title}</p>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
      <Button asChild size="lg" className="rounded-xl">
        <Link to="/projects">{button}</Link>
      </Button>
    </section>
  );
}

function TaskList({
  api,
  projectsApi,
  waitsApi,
  onError,
}: {
  api: TasksApi;
  projectsApi: ProjectsApi;
  waitsApi: WaitsApi;
  onError: (m: string) => void;
}) {
  const { data: tasks, isLoading } = useLiveQuery((q) =>
    q.from({ t: api.collection }).where(({ t }) => isNull(t.completedAt)),
  );
  const { data: projects, isLoading: projectsLoading } = useLiveQuery((q) =>
    q.from({ p: projectsApi.collection }),
  );
  const { data: conditions } = useLiveQuery((q) =>
    q.from({ w: waitsApi.collection }),
  );
  useForegroundRefetch(api.refetch);

  const today = localToday();
  const list = homeTasks(tasks ?? [], projects ?? [], today, conditions ?? []);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const closingDetailRef = useRef(false);

  // Completing commits immediately (the row leaves at once) and raises a single
  // bottom Undo snackbar. A fixed toast id means a second completion replaces the
  // first toast, so only one Undo is ever offered. Undo reopens the task.
  const onComplete = useCallback(
    (item: Task) => {
      undoableAction({
        message: "Completed",
        act: () => api.complete(item.id),
        undo: () => api.reopen(item),
        onError,
      });
    },
    [api, onError],
  );

  // Park a project task straight from Home (send it back to the project screen).
  // Loose tasks have no star — they are immediate to-dos, not curated.
  const onPark = useCallback(
    (item: Task) => {
      const tx = api.park(item.id);
      tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
    },
    [api, onError],
  );

  // Postpone to tomorrow; the optimistic reschedule drops the row from Home at
  // once (the shown-up gate) and lands it in Upcoming.
  const onReschedule = useCallback(
    (item: Task) => {
      const tx = api.reschedule(item.id, tomorrow(today));
      tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
    },
    [api, today, onError],
  );

  const selected = selectedId
    ? (list.find((item) => item.id === selectedId) ?? null)
    : null;

  const openDetail = useCallback((item: Task) => {
    closingDetailRef.current = false;
    setDraft(item.text);
    setSelectedId(item.id);
  }, []);

  const commitAndClose = useCallback(() => {
    if (closingDetailRef.current) return;
    closingDetailRef.current = true;
    setSelectedId(null);
    const trimmed = draft.trim();
    if (!selected || !trimmed || trimmed === selected.text) return;
    const tx = api.edit(selected.id, trimmed);
    tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
  }, [api, draft, selected, onError]);

  const onCompleteFromDetail = useCallback(() => {
    if (!selected) return;
    const item = selected;
    setSelectedId(null);
    onComplete(item);
  }, [selected, onComplete]);

  const onPickSchedule = useCallback(
    (date: string | null) => {
      if (!selected) return;
      const tx = api.reschedule(selected.id, date);
      tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
    },
    [api, selected, onError],
  );

  // Move the selected task into a project (or back to loose with null). Moving
  // into a project clears takenOnAt, so the row drops off Home's loose list.
  const onPickProject = useCallback(
    (projectId: string | null) => {
      if (!selected) return;
      const tx = api.moveToProject(selected.id, projectId);
      tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
    },
    [api, selected, onError],
  );

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = list.findIndex((t) => t.id === active.id);
      const newIndex = list.findIndex((t) => t.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      const moved = arrayMove(list, oldIndex, newIndex);
      const pos = moved.findIndex((t) => t.id === active.id);
      const prev = moved[pos - 1]?.sortKey ?? null;
      const next = moved[pos + 1]?.sortKey ?? null;
      const tx = api.reorder(String(active.id), orderKeyBetween(prev, next));
      tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
    },
    [api, list, onError],
  );

  // The project a task belongs to lends its icon as a small context badge; a
  // loose task shows none. Default to the neutral icon if the project's is unset.
  const iconOf = (projectId: string): string =>
    (projects ?? []).find((p) => p.id === projectId)?.icon ?? DEFAULT_ICON;

  const view = listView({ count: list.length, isLoading, loadError: null });
  const showLoadingText = useDelayed(view === "loading", LOADING_TEXT_DELAY_MS);

  // When the list is empty, replace it with the state-driven call to action
  // (driven by the projects' derived statuses). Do not flash it while the local
  // snapshot hydrates (every collection reads empty during hydration).
  const cta = homeCallToAction(
    list.length,
    0,
    projects ?? [],
    tasks ?? [],
    conditions ?? [],
  );
  const hydrating = isLoading || projectsLoading;

  if (view === "empty") {
    return hydrating ? <div className="min-h-24" /> : cta ? <CallToAction action={cta} /> : null;
  }

  if (view === "loading") {
    return showLoadingText ? (
      <p className="text-sm text-muted-foreground">Loading your tasks…</p>
    ) : (
      <div className="min-h-24" />
    );
  }

  return (
    <section className="space-y-3" aria-label="Tasks">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={list.map((t) => t.id)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="space-y-3">
            {list.map((item) => (
              <Row
                key={item.id}
                id={item.id}
                text={item.text}
                icon={item.projectId ? iconOf(item.projectId) : null}
                showStar={item.projectId != null}
                onComplete={() => onComplete(item)}
                onOpen={() => openDetail(item)}
                onReschedule={() => onReschedule(item)}
                onPark={() => onPark(item)}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>

      <Sheet
        open={selected != null}
        onClose={commitAndClose}
        title="Edit task"
        srOnlyTitle
      >
        {selected ? (
          <form
            className="space-y-1"
            onSubmit={(event) => {
              event.preventDefault();
              commitAndClose();
            }}
          >
            <div className="flex items-center gap-3 py-1">
              <CompleteCircle
                label="Complete task"
                onClick={onCompleteFromDetail}
              />
              <Input
                autoFocus
                value={draft}
                aria-label="Task text"
                className="h-11 flex-1 rounded-none border-0 bg-transparent px-0 py-0 text-lg font-medium shadow-none focus-visible:ring-0"
                onChange={(event) => setDraft(event.target.value)}
              />
            </div>

            <div className="border-t" />

            <ScheduleField
              showUpDate={selected.showUpDate}
              onPick={onPickSchedule}
            />

            <div className="border-t" />

            <ProjectField
              projects={projects ?? []}
              selectedProjectId={selected.projectId}
              onPick={onPickProject}
            />
          </form>
        ) : null}
      </Sheet>
    </section>
  );
}

function QuickAdd({
  mode,
  value,
  onModeChange,
  onChange,
  onSubmit,
  inputRef,
}: {
  mode: AddMode;
  value: string;
  onModeChange: (m: AddMode) => void;
  onChange: (v: string) => void;
  onSubmit: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="space-y-2">
      <div
        role="radiogroup"
        aria-label="What to add"
        className="inline-flex rounded-lg border bg-muted/40 p-0.5 text-sm"
      >
        {ALL_ADD_MODES.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            className={
              "rounded-md px-3 py-1 transition-colors " +
              (mode === m
                ? "bg-background font-medium shadow-sm"
                : "text-muted-foreground")
            }
            onClick={() => onModeChange(m)}
          >
            {ADD_MODE_LABEL[m]}
          </button>
        ))}
      </div>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <Input
          ref={inputRef}
          autoFocus
          value={value}
          placeholder={ADD_MODE_PLACEHOLDER[mode]}
          aria-label={ADD_MODE_PLACEHOLDER[mode]}
          className="h-11"
          onChange={(e) => onChange(e.target.value)}
        />
        <Button
          type="submit"
          size="lg"
          className="h-11 min-w-20"
          disabled={value.trim() === ""}
        >
          Add
        </Button>
      </form>
    </div>
  );
}

// A six-dot drag grip, rendered inside the handle button.
function GripIcon() {
  return (
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
  );
}

// The task completion circle, shared by the list row and the detail sheet so the
// two never diverge: a hollow ring that fills on hover.
function CompleteCircle({
  label,
  onClick,
  className,
}: {
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className={cn(
        "size-6 shrink-0 rounded-full border-2 border-muted-foreground/50 transition-colors hover:border-primary hover:bg-primary/10",
        className,
      )}
      onClick={onClick}
    />
  );
}

function CalendarGlyph({ className }: { className?: string }) {
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
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}

// The scheduler menu inside the popover: Today / Tomorrow (with the resolved
// weekday), an inline month calendar (built from the shared monthMatrix helper —
// no date library), and No date. Mirrors the mobile scheduler.
function ScheduleMenu({
  today,
  selected,
  onPick,
}: {
  today: string;
  selected: string | null;
  onPick: (date: string | null) => void;
}) {
  const tmr = tomorrow(today);
  const initial = selected ?? today;
  const [iy, im] = initial.split("-").map(Number);
  const [view, setView] = useState<{ y: number; m0: number }>({
    y: iy,
    m0: im - 1,
  });
  const grid = monthMatrix(view.y, view.m0);
  const monthTitle = new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
  }).format(new Date(view.y, view.m0, 1));
  const step = (delta: number) => {
    const d = new Date(view.y, view.m0 + delta, 1);
    setView({ y: d.getFullYear(), m0: d.getMonth() });
  };
  return (
    <div className="p-2">
      <button
        type="button"
        onClick={() => onPick(today)}
        className="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-accent"
      >
        <span>Today</span>
        <span className="text-muted-foreground">{weekdayShort(today)}</span>
      </button>
      <button
        type="button"
        onClick={() => onPick(tmr)}
        className="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-accent"
      >
        <span>Tomorrow</span>
        <span className="text-muted-foreground">{weekdayShort(tmr)}</span>
      </button>
      <div className="my-2 border-t" />
      <div className="px-1">
        <div className="mb-1 flex items-center justify-between">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => step(-1)}
            className="rounded px-2 py-1 text-muted-foreground hover:bg-accent"
          >
            ‹
          </button>
          <span className="text-sm font-medium">{monthTitle}</span>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => step(1)}
            className="rounded px-2 py-1 text-muted-foreground hover:bg-accent"
          >
            ›
          </button>
        </div>
        <div className="grid grid-cols-7 text-center text-xs text-muted-foreground">
          {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
            <div key={i} className="py-1">
              {d}
            </div>
          ))}
        </div>
        {grid.map((week, wi) => (
          <div key={wi} className="grid grid-cols-7">
            {week.map((date) => {
              const day = Number(date.split("-")[2]);
              const inMonth = Number(date.split("-")[1]) === view.m0 + 1;
              const isToday = date === today;
              const isSelected = date === selected;
              return (
                <button
                  key={date}
                  type="button"
                  aria-label={date}
                  onClick={() => onPick(date)}
                  className={cn(
                    "mx-auto my-0.5 flex size-8 items-center justify-center rounded-full text-sm",
                    isSelected
                      ? "bg-primary text-primary-foreground"
                      : isToday
                        ? "border border-primary"
                        : "hover:bg-accent",
                    !inMonth && !isSelected ? "text-muted-foreground/50" : "",
                  )}
                >
                  {day}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="my-2 border-t" />
      <button
        type="button"
        onClick={() => onPick(null)}
        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent"
      >
        No date
      </button>
    </div>
  );
}

// The schedule row in the detail sheet: shows the current date (or "Schedule"
// when unset) and opens the ScheduleMenu popover.
function ScheduleField({
  showUpDate,
  onPick,
}: {
  showUpDate: string | null | undefined;
  onPick: (date: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const today = localToday();
  const scheduled = showUpDate != null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-3 rounded-lg py-3 text-left hover:bg-muted/40"
        >
          <CalendarGlyph
            className={cn(
              "size-5 shrink-0",
              scheduled ? "text-primary" : "text-muted-foreground",
            )}
          />
          <span
            className={cn(
              "text-base",
              scheduled ? "font-medium text-primary" : "text-muted-foreground",
            )}
          >
            {scheduleLabel(showUpDate, today)}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <ScheduleMenu
          today={today}
          selected={showUpDate ?? null}
          onPick={(d) => {
            onPick(d);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

// The project row in the detail sheet: shows the current project (icon + title,
// or "Project" when loose) and opens a picker listing every project plus a
// "No project" row (move back to loose). Mirrors ScheduleField.
function ProjectField({
  projects,
  selectedProjectId,
  onPick,
}: {
  projects: { id: string; title: string; icon: string }[];
  selectedProjectId: string | null;
  onPick: (projectId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = projects.find((p) => p.id === selectedProjectId) ?? null;
  const pick = (projectId: string | null) => {
    onPick(projectId);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-3 rounded-lg py-3 text-left hover:bg-muted/40"
        >
          <span aria-hidden className="w-5 shrink-0 text-center text-base leading-none">
            {current ? current.icon : "📁"}
          </span>
          <span
            className={cn(
              "text-base",
              current ? "font-medium text-primary" : "text-muted-foreground",
            )}
          >
            {current ? current.title : "Project"}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-1">
        <button
          type="button"
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted/60"
          onClick={() => pick(null)}
        >
          <span aria-hidden className="w-5 text-center">
            ⊘
          </span>
          No project
        </button>
        {projects.map((p) => (
          <button
            key={p.id}
            type="button"
            className={cn(
              "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-muted/60",
              p.id === selectedProjectId && "font-medium text-primary",
            )}
            onClick={() => pick(p.id)}
          >
            <span aria-hidden className="w-5 text-center text-base leading-none">
              {p.icon}
            </span>
            {p.title}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function Row({
  id,
  text,
  icon,
  showStar,
  onComplete,
  onOpen,
  onReschedule,
  onPark,
}: {
  // Stable task id; the sortable key for dnd-kit.
  id: string;
  text: string;
  // The project's icon badge, or null for a loose task.
  icon: string | null;
  // A project task shows the park star; a loose task does not.
  showStar: boolean;
  onComplete: () => void;
  onOpen: () => void;
  onReschedule: () => void;
  onPark: () => void;
}) {
  // Drag reorder: only the grip handle carries the drag listeners, so the
  // circle (complete), text (detail sheet) and the hover buttons keep their own
  // clicks. Keyboard reorder comes free (Space to lift, arrows to move).
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
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
      className="group flex items-center gap-3 rounded-xl border bg-card px-4 py-4"
    >
      <button
        type="button"
        aria-label={`Reorder "${text}"`}
        className="shrink-0 cursor-grab touch-none rounded-md px-1 text-muted-foreground/40 transition-colors hover:text-muted-foreground focus-visible:text-muted-foreground active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripIcon />
      </button>
      <CompleteCircle label={`Complete "${text}"`} onClick={onComplete} />
      {icon && (
        <span aria-hidden className="shrink-0 text-base leading-none">
          {icon}
        </span>
      )}
      <button
        type="button"
        className="flex-1 text-left text-base"
        aria-label={`Edit "${text}"`}
        onClick={onOpen}
      >
        {text}
      </button>
      <button
        type="button"
        aria-label={`Postpone "${text}" to tomorrow`}
        className="shrink-0 rounded-md px-2 py-1 text-sm text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        onClick={onReschedule}
      >
        Tomorrow
      </button>
      {showStar && (
        <button
          type="button"
          aria-label={`Park "${text}"`}
          className="shrink-0 text-lg leading-none text-amber-500"
          onClick={onPark}
        >
          ★
        </button>
      )}
    </li>
  );
}
