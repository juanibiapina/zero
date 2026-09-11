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
  capturesLocalToday,
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
  visibleCaptures,
  weekdayShort,
  type AddMode,
  type HomeCallToAction,
} from "@zero/agent-core";
import { getCapturesApi, type CapturesApi } from "@/lib/captures-collection";
import { getTasksApi, type TasksApi } from "@/lib/tasks-collection";
import { getProjectsApi, type ProjectsApi } from "@/lib/projects-collection";
import { getWaitsApi, type WaitsApi } from "@/lib/waits-collection";
import { useDelayed, useForegroundRefetch } from "@/lib/screen-hooks";
import { refiningCaptureId, startRefine, stopRefine } from "@/lib/refine-session";
import { requestIconSuggestions } from "@/lib/icon-suggestions";
import { RefineBanner } from "@/components/RefineBanner";
import { type Capture } from "@/lib/captures";
import { type Task } from "@/lib/tasks";

// Home is one screen, two regions: the top holds the tasks you have taken on
// (availability-gated by homeTasks), the bottom is the raw capture inbox. The
// quick-add defaults to a capture (the frictionless dump) and can switch to a
// task. See docs/plans/todo-availability-model.md.
export function HomePage() {
  const [capturesApi, setCapturesApi] = useState<CapturesApi | null>(null);
  const [tasksApi, setTasksApi] = useState<TasksApi | null>(null);
  const [projectsApi, setProjectsApi] = useState<ProjectsApi | null>(null);
  const [waitsApi, setWaitsApi] = useState<WaitsApi | null>(null);
  useEffect(() => {
    let live = true;
    void getCapturesApi().then((a) => live && setCapturesApi(a));
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
          {capturesApi && tasksApi && projectsApi && waitsApi ? (
            <MergedHome
              capturesApi={capturesApi}
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

function MergedHome({
  capturesApi,
  tasksApi,
  projectsApi,
  waitsApi,
}: {
  capturesApi: CapturesApi;
  tasksApi: TasksApi;
  projectsApi: ProjectsApi;
  waitsApi: WaitsApi;
}) {
  const [mode, setMode] = useState<AddMode>("capture");
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
      const tx = projectsApi.add(trimmed, refiningCaptureId());
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
    const tx =
      mode === "task"
        ? tasksApi.add(trimmed, localToday(), null, null, refiningCaptureId())
        : capturesApi.add(trimmed);
    tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
    setText("");
    inputRef.current?.focus();
  }, [capturesApi, tasksApi, projectsApi, mode, text, navigate]);

  const onFinishRefine = useCallback(
    (captureId: string) => {
      const tx = capturesApi.process(captureId);
      tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
      stopRefine();
    },
    [capturesApi],
  );

  // The whole-screen empty-region gate. Home reads all four collections, computes
  // the plate (homeTasks) and the visible inbox, and asks the shared seam whether
  // a call to action should replace them. A non-null result means the plate and
  // inbox are both empty (the "all clear" state); null means render the plate and
  // inbox normally. See docs/plans/todo-home-rework.md.
  const { data: tasks, isLoading: tasksLoading } = useLiveQuery((q) =>
    q.from({ t: tasksApi.collection }).where(({ t }) => isNull(t.completedAt)),
  );
  const { data: projects, isLoading: projectsLoading } = useLiveQuery((q) =>
    q.from({ p: projectsApi.collection }),
  );
  const { data: conditions } = useLiveQuery((q) =>
    q.from({ w: waitsApi.collection }),
  );
  const { data: openCaptures, isLoading: capturesLoading } = useLiveQuery((q) =>
    q.from({ c: capturesApi.collection }).where(({ c }) => isNull(c.processedAt)),
  );
  const plate = homeTasks(tasks ?? [], projects ?? [], conditions ?? []);
  const captureCount = visibleCaptures(
    openCaptures ?? [],
    capturesLocalToday(),
  ).length;
  const cta = homeCallToAction(
    plate.length,
    captureCount,
    projects ?? [],
    tasks ?? [],
    conditions ?? [],
  );
  // Do not flash the CTA on a returning user while the local snapshot hydrates:
  // during hydration every collection reads empty, which would render "create".
  const hydrating = tasksLoading || projectsLoading || capturesLoading;

  return (
    <div className="space-y-6">
      <RefineBanner onFinish={onFinishRefine} />
      <QuickAdd
        mode={mode}
        value={text}
        onModeChange={setMode}
        onChange={setText}
        onSubmit={onAdd}
        inputRef={inputRef}
      />
      {error && <ErrorText>{error}</ErrorText>}

      {cta ? (
        hydrating ? (
          <div className="min-h-24" />
        ) : (
          <CallToAction action={cta} />
        )
      ) : (
        <>
          <TasksSection
            api={tasksApi}
            projectsApi={projectsApi}
            waitsApi={waitsApi}
            onError={setError}
          />
          <CapturesSection api={capturesApi} onError={setError} />
        </>
      )}
    </div>
  );
}

// The "all clear" state: shown only when the plate and inbox are both empty. Its
// framing and destination are chosen by the shared homeCallToAction seam from the
// projects' derived states; every case routes to Projects.
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

function TasksSection({
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
  const { data: tasks } = useLiveQuery((q) =>
    q
      .from({ t: api.collection })
      .where(({ t }) => isNull(t.completedAt))
      .orderBy(({ t }) => t.createdAt, "asc"),
  );
  const { data: projects } = useLiveQuery((q) =>
    q.from({ p: projectsApi.collection }),
  );
  const { data: conditions } = useLiveQuery((q) =>
    q.from({ w: waitsApi.collection }),
  );
  useForegroundRefetch(api.refetch);

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

  const list = homeTasks(tasks ?? [], projects ?? [], conditions ?? []);
  // The project a task belongs to lends its icon as a small context badge; a
  // loose task shows none. Default to the neutral icon if the project's is unset.
  const iconOf = (projectId: string): string =>
    (projects ?? []).find((p) => p.id === projectId)?.icon ?? DEFAULT_ICON;

  // Empty is not this section's concern: when the plate is empty the parent
  // renders the inbox alone or the all-clear CTA, so the Tasks section simply
  // does not appear.
  if (list.length === 0) return null;

  return (
    <section className="space-y-3" aria-label="Tasks">
      <h2 className="text-sm font-semibold text-foreground">Tasks</h2>
      <ul className="space-y-3">
        {list.map((item) => (
          <li
            key={item.id}
            className="flex items-center gap-3 rounded-xl border bg-card px-4 py-4"
          >
            <button
              type="button"
              aria-label={`Complete "${item.text}"`}
              className="size-6 shrink-0 rounded-full border-2 border-muted-foreground/50 transition-colors hover:border-primary hover:bg-primary/10"
              onClick={() => onComplete(item)}
            />
            {item.projectId && (
              <span aria-hidden className="shrink-0 text-base leading-none">
                {iconOf(item.projectId)}
              </span>
            )}
            <span className="flex-1 text-left text-base">{item.text}</span>
            {item.projectId && (
              <button
                type="button"
                aria-label={`Park "${item.text}"`}
                className="shrink-0 text-lg leading-none text-amber-500"
                onClick={() => onPark(item)}
              >
                ★
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function CapturesSection({
  api,
  onError,
}: {
  api: CapturesApi;
  onError: (m: string) => void;
}) {
  const { data: captures, isLoading } = useLiveQuery((q) =>
    q
      .from({ c: api.collection })
      .where(({ c }) => isNull(c.processedAt))
      .orderBy(({ c }) => c.createdAt, "asc"),
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const closingDetailRef = useRef(false);

  useForegroundRefetch(api.refetch);

  const onProcess = useCallback(
    (item: Capture) => {
      // Same single bottom Undo snackbar as task-complete (shared 'undo' id).
      // Undo un-processes the capture back to the inbox.
      undoableAction({
        message: "Completed",
        act: () => api.process(item.id),
        undo: () => api.unprocess(item),
        onError,
      });
    },
    [api, onError],
  );

  const onReschedule = useCallback(
    (item: Capture) => {
      const tx = api.reschedule(item.id, tomorrow(capturesLocalToday()));
      tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
    },
    [api, onError],
  );

  // The server returns every open capture (Home inbox and Upcoming share the
  // same set); this pass keeps only the ones that have shown up, so a
  // just-postponed row leaves the list at once and future-dated rows stay in
  // Upcoming. Overdue rolls in. Ordered by the manual sort key.
  const list = visibleCaptures(captures ?? [], capturesLocalToday());
  const selected = selectedId
    ? (list.find((item) => item.id === selectedId) ?? null)
    : null;

  const openDetail = useCallback((item: Capture) => {
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

  // Complete from the detail sheet: close it, then run the same process + Undo
  // path the row uses.
  const onCompleteFromDetail = useCallback(() => {
    if (!selected) return;
    const item = selected;
    setSelectedId(null);
    onProcess(item);
  }, [selected, onProcess]);

  // Reschedule from the detail sheet's scheduler; the sheet stays open.
  const onPickSchedule = useCallback(
    (date: string | null) => {
      if (!selected) return;
      const tx = api.reschedule(selected.id, date);
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
      const oldIndex = list.findIndex((c) => c.id === active.id);
      const newIndex = list.findIndex((c) => c.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      const moved = arrayMove(list, oldIndex, newIndex);
      const pos = moved.findIndex((c) => c.id === active.id);
      const prev = moved[pos - 1]?.sortKey ?? null;
      const next = moved[pos + 1]?.sortKey ?? null;
      const tx = api.reorder(String(active.id), orderKeyBetween(prev, next));
      tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
    },
    [api, list, onError],
  );
  const view = listView({ count: list.length, isLoading, loadError: null });
  const showLoadingText = useDelayed(view === "loading", LOADING_TEXT_DELAY_MS);

  // An empty inbox shows nothing: the both-empty "all clear" state is the CTA
  // (handled by the parent), and a plate-with-tasks + empty inbox needs no
  // "no captures" message. So the Inbox section only appears once it has rows.
  if (view === "empty") return null;

  return (
    <section className="space-y-3" aria-label="Capture inbox">
      <h2 className="text-sm font-medium text-muted-foreground">Inbox</h2>
      {view === "loading" ? (
        showLoadingText ? (
          <p className="text-sm text-muted-foreground">Loading your captures…</p>
        ) : (
          <div className="min-h-24" />
        )
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={list.map((c) => c.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="space-y-3">
              {list.map((item) => (
                <Row
                  key={item.id}
                  id={item.id}
                  text={item.text}
                  actionLabel={`Process "${item.text}"`}
                  onAction={() => onProcess(item)}
                  onOpen={() => openDetail(item)}
                  onReschedule={() => onReschedule(item)}
                  onRefine={() => startRefine(item.id, item.text)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      <Sheet
        open={selected != null}
        onClose={commitAndClose}
        title="Edit capture"
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
            {/* Identity: the shared complete circle + the editable title. No
                "Done" button — the circle completes, dismissal saves. */}
            <div className="flex items-center gap-3 py-1">
              <CaptureCircle
                label="Complete capture"
                onClick={onCompleteFromDetail}
              />
              <Input
                autoFocus
                value={draft}
                aria-label="Capture text"
                className="h-11 flex-1 rounded-none border-0 bg-transparent px-0 py-0 text-lg font-medium shadow-none focus-visible:ring-0"
                onChange={(event) => setDraft(event.target.value)}
              />
            </div>

            <div className="border-t" />

            {/* Schedule: one row, opens the Today/Tomorrow/calendar/No-date menu. */}
            <ScheduleField
              showUpDate={selected.showUpDate}
              onPick={onPickSchedule}
            />

            <div className="border-t" />

            {/* Refine: the next step. */}
            <button
              type="button"
              onClick={() => {
                startRefine(selected.id, selected.text);
                setSelectedId(null);
              }}
              className="flex w-full items-center gap-2 py-3 text-left text-base font-medium text-primary hover:opacity-80"
            >
              <span aria-hidden>✦</span> Refine into tasks &amp; projects
            </button>
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

// The capture completion circle, shared by the inbox row and the detail sheet so
// the two never diverge: a hollow ring that fills on hover.
function CaptureCircle({
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
  const today = capturesLocalToday();
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

function Row({
  id,
  text,
  actionLabel,
  onAction,
  onOpen,
  onReschedule,
  onRefine,
}: {
  // Stable capture id; the sortable key for dnd-kit.
  id: string;
  text: string;
  actionLabel: string;
  onAction: () => void;
  onOpen: () => void;
  // When provided, a "Tomorrow" button (shown on hover/focus) postpones the row.
  onReschedule?: () => void;
  // When provided, a "Refine" button starts a refine session for this capture.
  onRefine?: () => void;
}) {
  // Drag reorder: only the grip handle carries the drag listeners, so the
  // circle (process), text (detail sheet) and "Tomorrow" button keep their own
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
      <CaptureCircle label={actionLabel} onClick={onAction} />
      <button
        type="button"
        className="flex-1 text-left text-base"
        aria-label={`Edit "${text}"`}
        onClick={onOpen}
      >
        {text}
      </button>
      {onRefine && (
        <button
          type="button"
          aria-label={`Refine "${text}"`}
          className="shrink-0 rounded-md px-2 py-1 text-sm text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
          onClick={onRefine}
        >
          Refine
        </button>
      )}
      {onReschedule && (
        <button
          type="button"
          aria-label={`Postpone "${text}" to tomorrow`}
          className="shrink-0 rounded-md px-2 py-1 text-sm text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
          onClick={onReschedule}
        >
          Tomorrow
        </button>
      )}
    </li>
  );
}
