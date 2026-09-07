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
import { Sheet } from "@/components/ui/sheet";
import { ErrorText } from "@/components/ConnectionStatus";
import { Link } from "react-router";
import {
  listView,
  LOADING_TEXT_DELAY_MS,
  capturesLocalToday,
  DONE_UNDO_MS,
  homeCallToAction,
  homeCallToActionCopy,
  homeTasks,
  ICON_CHOICES,
  localToday,
  messageOf,
  orderKeyBetween,
  tomorrow,
  visibleCaptures,
  type HomeCallToAction,
} from "@zero/agent-core";
import { getCapturesApi, type CapturesApi } from "@/lib/captures-collection";
import { getTasksApi, type TasksApi } from "@/lib/tasks-collection";
import { getProjectsApi, type ProjectsApi } from "@/lib/projects-collection";
import { getWaitsApi, type WaitsApi } from "@/lib/waits-collection";
import {
  useDelayed,
  useForegroundRefetch,
  useUndoableLeave,
} from "@/lib/screen-hooks";
import { refiningCaptureId, startRefine, stopRefine } from "@/lib/refine-session";
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

type AddMode = "capture" | "task";

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

  const onAdd = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setError(null);
    const tx =
      mode === "task"
        ? tasksApi.add(trimmed, localToday(), null, null, refiningCaptureId())
        : capturesApi.add(trimmed);
    tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
    setText("");
    inputRef.current?.focus();
  }, [capturesApi, tasksApi, mode, text]);

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

  // Completing leaves the task in place ~5s with Undo (and, for a project task,
  // a "+ Waiting condition" shortcut) before the write commits.
  const done = useUndoableLeave(DONE_UNDO_MS);
  const [waitingFor, setWaitingFor] = useState<{
    projectId: string;
    label: string;
  } | null>(null);
  const [condText, setCondText] = useState("");

  const onComplete = useCallback(
    (item: Task) => {
      done.start(item.id, () => {
        const tx = api.complete(item.id);
        tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
      });
    },
    [api, done, onError],
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

  const addCondition = useCallback(() => {
    const trimmed = condText.trim();
    const target = waitingFor;
    setWaitingFor(null);
    setCondText("");
    if (!target || !trimmed) return;
    const tx = waitsApi.add(target.projectId, "free-text", { text: trimmed });
    tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
  }, [condText, waitingFor, waitsApi, onError]);

  const list = homeTasks(tasks ?? [], projects ?? [], conditions ?? []);
  // The project a task belongs to lends its icon as a small context badge; a
  // loose task shows none. Default to the neutral icon if the project's is unset.
  const iconOf = (projectId: string): string =>
    (projects ?? []).find((p) => p.id === projectId)?.icon ?? ICON_CHOICES[0];

  // Empty is not this section's concern: when the plate is empty the parent
  // renders the inbox alone or the all-clear CTA, so the Tasks section simply
  // does not appear.
  if (list.length === 0) return null;

  return (
    <section className="space-y-3" aria-label="Tasks">
      <h2 className="text-sm font-semibold text-foreground">Tasks</h2>
      {(
        <ul className="space-y-3">
          {list.map((item) => {
            const leaving = done.pending.has(item.id);
            return (
              <li
                key={item.id}
                className={
                  "flex items-center gap-3 rounded-xl border bg-card px-4 py-4" +
                  (leaving ? " opacity-70" : "")
                }
              >
                {leaving ? (
                  <>
                    <span className="flex-1 text-left text-base text-muted-foreground line-through">
                      {item.text}
                    </span>
                    {item.projectId && (
                      <button
                        type="button"
                        className="shrink-0 text-sm text-muted-foreground hover:text-foreground"
                        onClick={() =>
                          setWaitingFor({
                            projectId: item.projectId as string,
                            label: item.text,
                          })
                        }
                      >
                        + Waiting condition
                      </button>
                    )}
                    <button
                      type="button"
                      className="shrink-0 text-sm font-medium text-primary"
                      onClick={() => done.undo(item.id)}
                    >
                      Undo
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      aria-label={`Complete "${item.text}"`}
                      className="size-6 shrink-0 rounded-full border-2 border-muted-foreground/50 transition-colors hover:border-primary hover:bg-primary/10"
                      onClick={() => onComplete(item)}
                    />
                    {item.projectId && (
                      <span
                        aria-hidden
                        className="shrink-0 text-base leading-none"
                      >
                        {iconOf(item.projectId)}
                      </span>
                    )}
                    <span className="flex-1 text-left text-base">
                      {item.text}
                    </span>
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
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Sheet
        open={waitingFor != null}
        onClose={() => {
          setWaitingFor(null);
          setCondText("");
        }}
        title="What is it waiting on?"
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            addCondition();
          }}
        >
          <Input
            autoFocus
            value={condText}
            aria-label="Waiting condition"
            placeholder="e.g. the letter comes back"
            onChange={(e) => setCondText(e.target.value)}
          />
          <div className="flex justify-end">
            <Button type="submit" disabled={condText.trim() === ""}>
              Add waiting condition
            </Button>
          </div>
        </form>
      </Sheet>
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
      const tx = api.process(item.id);
      tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
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
            className="space-y-6"
            onSubmit={(event) => {
              event.preventDefault();
              commitAndClose();
            }}
          >
            <div className="rounded-2xl bg-muted/60 px-5 py-4 transition-colors focus-within:bg-muted">
              <Input
                autoFocus
                value={draft}
                aria-label="Capture text"
                className="h-14 rounded-none border-0 bg-transparent px-0 py-0 text-xl font-medium leading-7 shadow-none focus-visible:ring-0"
                onChange={(event) => setDraft(event.target.value)}
              />
            </div>
            <div className="flex justify-end">
              <Button type="submit" size="lg" className="min-w-24 rounded-xl">
                Done
              </Button>
            </div>
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
        {(["capture", "task"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            className={
              "rounded-md px-3 py-1 capitalize transition-colors " +
              (mode === m
                ? "bg-background font-medium shadow-sm"
                : "text-muted-foreground")
            }
            onClick={() => onModeChange(m)}
          >
            {m}
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
          placeholder={mode === "task" ? "Add a task" : "Capture a thought"}
          aria-label={mode === "task" ? "Add a task" : "Capture a thought"}
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
      <button
        type="button"
        aria-label={actionLabel}
        className="size-6 shrink-0 rounded-full border-2 border-muted-foreground/50 transition-colors hover:border-primary hover:bg-primary/10"
        onClick={onAction}
      />
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
