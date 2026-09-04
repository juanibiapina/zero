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
import {
  listView,
  LOADING_TEXT_DELAY_MS,
  capturesLocalToday,
  messageOf,
  orderKeyBetween,
  tomorrow,
  visibleCaptures,
} from "@zero/agent-core";
import { getCapturesApi, type CapturesApi } from "@/lib/captures-collection";
import { useDelayed, useForegroundRefetch } from "@/lib/screen-hooks";
import { type Capture } from "@/lib/captures";

// Captures is the sole list: one fast place to drop any raw thought and Process
// it later. The add bar creates a Capture; tap a row's circle to Process.
export function HomePage() {
  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10">
        <div className="mx-auto w-full max-w-2xl space-y-6">
          <h1 className="text-2xl font-bold tracking-tight">Captures</h1>
          <CapturesPanel />
        </div>
      </main>
    </div>
  );
}

function CapturesPanel() {
  const [api, setApi] = useState<CapturesApi | null>(null);
  useEffect(() => {
    let live = true;
    void getCapturesApi().then((a) => {
      if (live) setApi(a);
    });
    return () => {
      live = false;
    };
  }, []);
  return api ? <CapturesReady api={api} /> : <div className="min-h-24" />;
}

function CapturesReady({ api }: { api: CapturesApi }) {
  const { data: captures, isLoading } = useLiveQuery((q) =>
    q
      .from({ c: api.collection })
      .where(({ c }) => isNull(c.processedAt))
      .orderBy(({ c }) => c.createdAt, "asc"),
  );

  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const closingDetailRef = useRef(false);

  useForegroundRefetch(api.refetch);

  const onAdd = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setError(null);
    const tx = api.add(trimmed);
    tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
    setText("");
    inputRef.current?.focus();
  }, [api, text]);

  const onProcess = useCallback(
    (item: Capture) => {
      setError(null);
      const tx = api.process(item.id);
      tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
    },
    [api],
  );

  const onReschedule = useCallback(
    (item: Capture) => {
      setError(null);
      const tx = api.reschedule(item.id, tomorrow(capturesLocalToday()));
      tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
    },
    [api],
  );

  // The server returns every open capture (Captures and Upcoming share the same
  // set); this pass keeps only the ones that have shown up, so a just-postponed
  // row leaves the list at once and future-dated rows stay in Upcoming. Overdue
  // rolls in; no red. Ordered by the manual sort key.
  const list = visibleCaptures(captures ?? [], capturesLocalToday());
  const selected = selectedId
    ? (list.find((item) => item.id === selectedId) ?? null)
    : null;

  const openDetail = useCallback((item: Capture) => {
    closingDetailRef.current = false;
    setDraft(item.text);
    setSelectedId(item.id);
  }, []);

  // Close first, then write only a changed, non-empty draft. Every sheet
  // dismissal path and form submit calls this same callback.
  const commitAndClose = useCallback(() => {
    if (closingDetailRef.current) return;
    closingDetailRef.current = true;
    setSelectedId(null);
    const trimmed = draft.trim();
    if (!selected || !trimmed || trimmed === selected.text) return;
    setError(null);
    const tx = api.edit(selected.id, trimmed);
    tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
  }, [api, draft, selected]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Drop: mint a key strictly between the moved row's new neighbors and persist
  // it. arrayMove gives the post-drop order, from which the neighbors' keys (or
  // null at an end) bound the new key. Optimistic setSortKey + the re-sort land
  // it in place; surface a write error like the other verbs.
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
      setError(null);
      const tx = api.reorder(String(active.id), orderKeyBetween(prev, next));
      tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
    },
    [api, list],
  );
  const view = listView({ count: list.length, isLoading, loadError: null });
  const showLoadingText = useDelayed(view === "loading", LOADING_TEXT_DELAY_MS);

  return (
    <div className="space-y-6">
      <QuickAdd
        value={text}
        placeholder="Capture a thought"
        ariaLabel="Capture a thought"
        onChange={setText}
        onSubmit={onAdd}
        inputRef={inputRef}
      />

      {error && <ErrorText>{error}</ErrorText>}

      {view === "loading" ? (
        showLoadingText ? (
          <p className="text-sm text-muted-foreground">Loading your captures…</p>
        ) : (
          <div className="min-h-24" />
        )
      ) : view === "empty" ? (
        <p className="text-sm text-muted-foreground">
          No captures yet. Capture something.
        </p>
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
    </div>
  );
}

function QuickAdd({
  value,
  placeholder,
  ariaLabel,
  onChange,
  onSubmit,
  inputRef,
}: {
  value: string;
  placeholder: string;
  ariaLabel: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
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
        placeholder={placeholder}
        aria-label={ariaLabel}
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
}: {
  // Stable capture id; the sortable key for dnd-kit.
  id: string;
  text: string;
  actionLabel: string;
  onAction: () => void;
  onOpen: () => void;
  // When provided, a "Tomorrow" button (shown on hover/focus) postpones the row.
  onReschedule?: () => void;
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
