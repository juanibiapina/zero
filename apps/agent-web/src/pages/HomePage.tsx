import { useCallback, useMemo, useRef, useState } from "react";
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
import { CalendarGlyph, ScheduleMenu } from "@/components/schedule-menu";
import { ErrorText } from "@/components/ConnectionStatus";
import { ScheduleHighlightInput } from "@/components/ScheduleHighlightInput";
import { ProjectOptionList } from "@/components/ProjectOptionList";
import { useTaskCompletionFeedback } from "@/components/task-completion-feedback";
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
  orderKeyBetween,
  scheduleLabel,
  toast,
  tomorrow,
  undoableAction,
  type AddMode,
  type HomeCallToAction,
  type Project,
  type TodoProjects,
  type Task,
  type TaskdoReplica,
  type TodoTasks,
  type TodoWaits,
  type WaitingCondition,
} from "@zero/agent-core";
import {
  parseSchedule,
  toText,
  type TextRange,
} from "@zeroapps/recurrence";
import { useTodoData } from "@/lib/todo-data";
import { useDelayed } from "@/lib/screen-hooks";
import { requestIconSuggestions } from "@/lib/icon-suggestions";

// Home is one screen: a single reorderable list of loose and project tasks,
// availability-gated by homeTasks. The quick-add defaults to a task and can
// switch to a project. See docs/entities/task.md.
export function HomePage() {
  const { replica } = useTodoData();
  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10">
        <div className="mx-auto w-full max-w-2xl space-y-6">
          <h1 className="text-2xl font-bold tracking-tight">Home</h1>
          {replica ? (
            <Home replica={replica} />
          ) : (
            <div className="min-h-24" />
          )}
        </div>
      </main>
    </div>
  );
}

function Home({ replica }: { replica: TaskdoReplica }) {
  const { tasks: tasksApi, projects: projectsApi, waits: waitsApi } = replica;
  const [mode, setMode] = useState<AddMode>("task");
  const [text, setText] = useState("");
  const [ignoredSchedule, setIgnoredSchedule] = useState<{
    text: string;
    ranges: TextRange[];
  } | null>(null);
  // Create-time date and project for a task quick-add (the mini-composer). Both
  // default to "unset": null date + no project = a loose Home task. Reset after
  // each add. See docs/entities/task.md.
  const [date, setDate] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { data: projects } = useLiveQuery((q) =>
    q.from({ p: projectsApi.collection }),
  );
  const { data: openTasks } = useLiveQuery((q) =>
    q.from({ t: tasksApi.collection }).where(({ t }) => isNull(t.completedAt)),
  );
  const { data: conditions } = useLiveQuery((q) =>
    q.from({ w: waitsApi.collection }),
  );
  const today = localToday();
  const parsedSchedule = useMemo(
    () =>
      mode === "task"
        ? parseSchedule(text, {
            today,
            weekStartsOn: "MO",
            ignored: ignoredSchedule?.text === text ? ignoredSchedule.ranges : [],
          })
        : { kind: "none" as const },
    [mode, text, today, ignoredSchedule],
  );
  const parsedValue =
    parsedSchedule.kind === "scheduled" ? parsedSchedule.schedule : null;
  const recurrence =
    parsedValue?.kind === "recurring" ? parsedValue.recurrence : null;
  const effectiveDate =
    parsedValue?.kind === "once"
      ? parsedValue.date
      : recurrence?.origin ?? date;
  const effectiveText =
    parsedSchedule.kind === "scheduled"
      ? parsedSchedule.remainingText
      : text.trim();
  const ignoreScheduleRange = (range: TextRange) => {
    setIgnoredSchedule((current) => ({
      text,
      ranges:
        current?.text === text ? [...current.ranges, range] : [range],
    }));
  };

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
      setIgnoredSchedule(null);
      inputRef.current?.focus();
      return;
    }
    // A task quick-add carries the composer's date + project. No project + null
    // date = a loose Home task; a date makes it a Home/Upcoming task; a project
    // with no date files it groomed (off Home), explained by a toast so nothing
    // vanishes silently.
    const taskText = effectiveText.trim();
    if (!taskText) return;
    const tx = tasksApi.add(
      taskText,
      effectiveDate,
      projectId,
      recurrence,
    );
    tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
    if (projectId != null && effectiveDate == null) {
      const project = (projects ?? []).find((p) => p.id === projectId);
      toast("Filed to project", {
        description: project
          ? `${project.icon ?? DEFAULT_ICON} ${project.title}`
          : undefined,
      });
    }
    setText("");
    setIgnoredSchedule(null);
    setDate(null);
    setProjectId(null);
    inputRef.current?.focus();
  }, [
    tasksApi,
    projectsApi,
    mode,
    text,
    effectiveText,
    effectiveDate,
    recurrence,
    projectId,
    projects,
    navigate,
  ]);

  return (
    <div className="space-y-6">
      <QuickAdd
        mode={mode}
        value={text}
        onModeChange={setMode}
        onChange={(next) => {
          setText(next);
          if (next !== ignoredSchedule?.text) setIgnoredSchedule(null);
        }}
        scheduleRanges={
          parsedSchedule.kind === "scheduled" ? parsedSchedule.consumed : []
        }
        onUnrecognizeSchedule={ignoreScheduleRange}
        onSubmit={onAdd}
        inputRef={inputRef}
        date={effectiveDate}
        recurrenceText={recurrence ? toText(recurrence) : null}
        onDateChange={(nextDate) => {
          if (parsedSchedule.kind === "scheduled") {
            setText(effectiveText);
            setIgnoredSchedule({
              text: effectiveText,
              ranges: effectiveText
                ? [{ start: 0, end: effectiveText.length, text: effectiveText }]
                : [],
            });
          }
          setDate(nextDate);
        }}
        projectId={projectId}
        onProjectChange={setProjectId}
        projects={projects ?? []}
        tasks={openTasks ?? []}
        conditions={conditions ?? []}
        today={today}
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
  api: TodoTasks;
  projectsApi: TodoProjects;
  waitsApi: TodoWaits;
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
  const today = localToday();
  const list = homeTasks(tasks ?? [], projects ?? [], today);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const closingDetailRef = useRef(false);

  const completion = useTaskCompletionFeedback({
    api,
    waitsApi,
    projects: projects ?? [],
    today,
    onError,
  });

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

  const onCompleteFromDetail = () => {
    if (!selected) return;
    const item = selected;
    setSelectedId(null);
    completion.complete(item);
  };

  const onPickSchedule = useCallback(
    (date: string | null) => {
      if (!selected) return;
      const tx = api.reschedule(selected.id, date);
      tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
    },
    [api, selected, onError],
  );

  const stopRecurrence = useCallback(() => {
    if (!selected?.recurrence) return;
    const tx = api.setRecurrence(selected.id, null);
    tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
  }, [api, selected, onError]);

  const completeForever = useCallback(() => {
    if (!selected?.recurrence) return;
    const item = selected;
    setSelectedId(null);
    undoableAction({
      message: "Completed forever",
      act: () => api.completeForever(item.id),
      undo: () => api.reopen(item),
      onError,
    });
  }, [api, selected, onError]);

  // Move the selected task into a project (or back to loose with null). An
  // undated task filed into a project drops off Home's loose list (it becomes
  // groomed); a dated one keeps its date.
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

  const view = listView({ count: list.length, isLoading });
  const showLoadingText = useDelayed(view === "loading", LOADING_TEXT_DELAY_MS);

  // When the list is empty, replace it with the state-driven call to action
  // (driven by the projects' derived statuses). Do not flash it while the local
  // snapshot hydrates (every collection reads empty during hydration).
  const cta = homeCallToAction(
    list.length,
    projects ?? [],
    tasks ?? [],
    today,
    conditions ?? [],
  );
  const hydrating = isLoading || projectsLoading;

  if (view === "empty") {
    return (
      <>
        {hydrating ? <div className="min-h-24" /> : cta ? <CallToAction action={cta} /> : null}
        {completion.composer}
      </>
    );
  }

  if (view === "loading") {
    return (
      <>
        {showLoadingText ? (
          <p className="text-sm text-muted-foreground">Loading your tasks…</p>
        ) : (
          <div className="min-h-24" />
        )}
        {completion.composer}
      </>
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
                onComplete={() => completion.complete(item)}
                onOpen={() => openDetail(item)}
                onReschedule={() => onReschedule(item)}
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
              recurrence={selected.recurrence ?? null}
              onStopRecurrence={stopRecurrence}
              onCompleteForever={completeForever}
              onPick={onPickSchedule}
            />

            <div className="border-t" />

            <ProjectField
              projects={projects ?? []}
              tasks={tasks ?? []}
              conditions={conditions ?? []}
              today={today}
              selectedProjectId={selected.projectId}
              onPick={onPickProject}
            />
          </form>
        ) : null}
      </Sheet>
      {completion.composer}
    </section>
  );
}

function QuickAdd({
  mode,
  value,
  onModeChange,
  onChange,
  scheduleRanges,
  onUnrecognizeSchedule,
  onSubmit,
  inputRef,
  date,
  recurrenceText,
  onDateChange,
  projectId,
  onProjectChange,
  projects,
  tasks,
  conditions,
  today,
}: {
  mode: AddMode;
  value: string;
  onModeChange: (m: AddMode) => void;
  onChange: (v: string) => void;
  scheduleRanges: TextRange[];
  onUnrecognizeSchedule: (range: TextRange) => void;
  onSubmit: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  // Create-time date + project for a task quick-add (the mini-composer). Shown
  // only in task mode.
  date: string | null;
  recurrenceText: string | null;
  onDateChange: (date: string | null) => void;
  projectId: string | null;
  onProjectChange: (projectId: string | null) => void;
  projects: Project[];
  tasks: Task[];
  conditions: WaitingCondition[];
  today: string;
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
        <ScheduleHighlightInput
          ref={inputRef}
          autoFocus
          value={value}
          ranges={scheduleRanges}
          placeholder={ADD_MODE_PLACEHOLDER[mode]}
          aria-label={ADD_MODE_PLACEHOLDER[mode]}
          className="h-11"
          onChange={(e) => onChange(e.target.value)}
          onDismissRange={onUnrecognizeSchedule}
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
      {mode === "task" && (
        <div className="flex items-center gap-2">
          <QuickAddDateChip
            date={date}
            recurrenceText={recurrenceText}
            onUnrecognize={
              recurrenceText && scheduleRanges[0]
                ? () => onUnrecognizeSchedule(scheduleRanges[0])
                : undefined
            }
            onPick={onDateChange}
          />
          <QuickAddProjectChip
            projects={projects}
            tasks={tasks}
            conditions={conditions}
            today={today}
            projectId={projectId}
            onPick={onProjectChange}
          />
        </div>
      )}
    </div>
  );
}

// The compact date chip in the Home quick-add composer: "No date" by default,
// or the picked date; opens the shared scheduler. The date is the sole
// commitment gate, so this is how a quick-add task lands on Home (or Upcoming).
function QuickAddDateChip({
  date,
  recurrenceText,
  onUnrecognize,
  onPick,
}: {
  date: string | null;
  recurrenceText: string | null;
  onUnrecognize?: () => void;
  onPick: (date: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const today = localToday();
  const scheduled = date != null;
  return (
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={scheduled ? `Date: ${date}` : "Add a date"}
          className={cn(
            "flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors",
            scheduled
              ? "border-primary/40 font-medium text-primary"
              : "text-muted-foreground hover:bg-muted/60",
          )}
        >
          <CalendarGlyph className="size-3.5" />
          <span>
            {recurrenceText ?? (scheduled ? scheduleLabel(date, today) : "No date")}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <ScheduleMenu
          today={today}
          selected={date}
          onPick={(d) => {
            onPick(d);
            setOpen(false);
          }}
        />
      </PopoverContent>
      </Popover>
      {onUnrecognize ? (
        <button
          type="button"
          aria-label="Keep schedule words in task title"
          className="rounded px-1 text-sm text-muted-foreground hover:bg-muted"
          onClick={onUnrecognize}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

// The compact project chip in the Home quick-add composer: "No project" by
// default (a loose task), or the picked project's icon + title. Filing a task to
// a project with no date lands it groomed on the project screen (the composer's
// caller raises a "Filed to <project>" toast).
function QuickAddProjectChip({
  projects,
  tasks,
  conditions,
  today,
  projectId,
  onPick,
}: {
  projects: Project[];
  tasks: Task[];
  conditions: WaitingCondition[];
  today: string;
  projectId: string | null;
  onPick: (projectId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = projects.find((p) => p.id === projectId) ?? null;
  const pick = (id: string | null) => {
    onPick(id);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={current ? `Project: ${current.title}` : "Add to a project"}
          className={cn(
            "flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors",
            current
              ? "border-primary/40 font-medium text-primary"
              : "text-muted-foreground hover:bg-muted/60",
          )}
        >
          <span aria-hidden className="text-sm leading-none">
            {current ? current.icon : "📁"}
          </span>
          <span>{current ? current.title : "No project"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1">
        <ProjectOptionList projects={projects} tasks={tasks} conditions={conditions}
          today={today} selectedProjectId={projectId} showNoProject onPick={pick} />
      </PopoverContent>
    </Popover>
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

// The schedule row in the detail sheet: shows the current date (or "Schedule"
// when unset) and opens the ScheduleMenu popover.
function ScheduleField({
  showUpDate,
  recurrence,
  onStopRecurrence,
  onCompleteForever,
  onPick,
}: {
  showUpDate: string | null | undefined;
  recurrence: NonNullable<Task["recurrence"]> | null;
  onStopRecurrence: () => void;
  onCompleteForever: () => void;
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
            {recurrence ? toText(recurrence) : scheduleLabel(showUpDate, today)}
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
        {recurrence ? (
          <button
            type="button"
            className="w-full border-t px-3 py-2 text-left text-sm text-destructive hover:bg-muted/50"
            onClick={() => {
              onStopRecurrence();
              setOpen(false);
            }}
          >
            Stop repeating
          </button>
        ) : null}
        {recurrence ? (
          <button
            type="button"
            className="w-full border-t px-3 py-2 text-left text-sm text-destructive hover:bg-muted/50"
            onClick={() => {
              onCompleteForever();
              setOpen(false);
            }}
          >
            Complete forever
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

// The project row in the detail sheet: shows the current project (icon + title,
// or "Project" when loose) and opens a picker listing every project plus a
// "No project" row (move back to loose). Mirrors ScheduleField.
function ProjectField({
  projects,
  tasks,
  conditions,
  today,
  selectedProjectId,
  onPick,
}: {
  projects: Project[];
  tasks: Task[];
  conditions: WaitingCondition[];
  today: string;
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
        <ProjectOptionList projects={projects} tasks={tasks} conditions={conditions}
          today={today} selectedProjectId={selectedProjectId} showNoProject onPick={pick} />
      </PopoverContent>
    </Popover>
  );
}

function Row({
  id,
  text,
  icon,
  onComplete,
  onOpen,
  onReschedule,
}: {
  // Stable task id; the sortable key for dnd-kit.
  id: string;
  text: string;
  // The project's icon badge, or null for a loose task.
  icon: string | null;
  onComplete: () => void;
  onOpen: () => void;
  onReschedule: () => void;
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
    </li>
  );
}
