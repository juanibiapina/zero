import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { isNull } from "@tanstack/db";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppHeader } from "@/components/AppHeader";
import { ErrorText } from "@/components/ConnectionStatus";
import {
  capturesView,
  dueToday,
  localToday,
  todayView,
} from "@zero/agent-core";
import { getCapturesApi, type CapturesApi } from "@/lib/captures-collection";
import { getTasksApi, type TasksApi } from "@/lib/tasks-collection";
import { type Capture } from "@/lib/captures";
import { type Task } from "@/lib/tasks";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// How long a list may sit empty-and-loading before it shows the "Loading…"
// text. The local snapshot hydrates the cached rows in well under this, so a
// normal load paints straight to the list with no spinner flash; the text only
// appears on a genuinely slow first load (empty cache waiting on the network).
const LOADING_TEXT_DELAY_MS = 1000;

// True only after `active` has held continuously for `ms`. Resets the moment
// `active` goes false, so a fast hydrate never trips it.
function useDelayed(active: boolean, ms: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => setElapsed(true), ms);
    return () => {
      clearTimeout(t);
      setElapsed(false);
    };
  }, [active, ms]);
  return active && elapsed;
}

type Tab = "captures" | "today";

// Captures holds unclarified Captures; Today holds Tasks due on or before today.
// The active tab is also the entry target: the add bar creates a Capture on
// Captures and a Task dated today on Today. Same bar, same speed, the intent is
// the tab you are in.
export function HomePage() {
  const [tab, setTab] = useState<Tab>("captures");

  const title = tab === "captures" ? "Captures" : "Today";
  const subtitle =
    tab === "captures"
      ? "Capture anything. Process it later."
      : "What you are doing today.";

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />
      <main className="container mx-auto px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10">
        <div className="mx-auto w-full max-w-2xl space-y-6">
          <SegmentedControl tab={tab} onChange={setTab} />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
          </div>
          {/* Both panels stay mounted so switching tabs is instant and neither
              list re-hydrates; the inactive one is hidden. */}
          <div className={tab === "captures" ? undefined : "hidden"}>
            <CapturesPanel />
          </div>
          <div className={tab === "today" ? undefined : "hidden"}>
            <TodayPanel />
          </div>
        </div>
      </main>
    </div>
  );
}

function SegmentedControl({
  tab,
  onChange,
}: {
  tab: Tab;
  onChange: (t: Tab) => void;
}) {
  const item = (value: Tab, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === value}
      onClick={() => onChange(value)}
      className={
        "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
        (tab === value
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground")
      }
    >
      {label}
    </button>
  );
  return (
    <div
      role="tablist"
      className="flex gap-1 rounded-lg bg-muted p-1"
      aria-label="Captures and Today"
    >
      {item("captures", "Captures")}
      {item("today", "Today")}
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

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void api.refetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [api]);

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

  const onEdit = useCallback(
    (item: Capture, text: string) => {
      setError(null);
      const tx = api.edit(item.id, text);
      tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
    },
    [api],
  );

  const list = captures ?? [];
  const view = capturesView({ count: list.length, isLoading, loadError: null });
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
        <ul className="space-y-3">
          {list.map((item) => (
            <Row
              key={item.id}
              text={item.text}
              actionLabel={`Process "${item.text}"`}
              onAction={() => onProcess(item)}
              onEdit={(text) => onEdit(item, text)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TodayPanel() {
  const [api, setApi] = useState<TasksApi | null>(null);
  useEffect(() => {
    let live = true;
    void getTasksApi().then((a) => {
      if (live) setApi(a);
    });
    return () => {
      live = false;
    };
  }, []);
  return api ? <TodayReady api={api} /> : <div className="min-h-24" />;
}

function TodayReady({ api }: { api: TasksApi }) {
  const { data: tasks, isLoading } = useLiveQuery((q) =>
    q
      .from({ t: api.collection })
      .where(({ t }) => isNull(t.completedAt))
      .orderBy(({ t }) => t.createdAt, "asc"),
  );

  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void api.refetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [api]);

  const onAdd = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setError(null);
    // v1 dates a new task today; the Today list shows it immediately.
    const tx = api.add(trimmed, localToday());
    tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
    setText("");
    inputRef.current?.focus();
  }, [api, text]);

  const onComplete = useCallback(
    (item: Task) => {
      setError(null);
      const tx = api.complete(item.id);
      tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
    },
    [api],
  );

  // The live query returns all open tasks; narrow to those due on or before the
  // local today (overdue rolls in, future stays hidden), ordered by day.
  const list = useMemo(() => dueToday(tasks ?? [], localToday()), [tasks]);
  const view = todayView({ count: list.length, isLoading, loadError: null });
  const showLoadingText = useDelayed(view === "loading", LOADING_TEXT_DELAY_MS);

  return (
    <div className="space-y-6">
      <QuickAdd
        value={text}
        placeholder="Add a task for today"
        ariaLabel="Add a task for today"
        onChange={setText}
        onSubmit={onAdd}
        inputRef={inputRef}
      />

      {error && <ErrorText>{error}</ErrorText>}

      {view === "loading" ? (
        showLoadingText ? (
          <p className="text-sm text-muted-foreground">Loading today…</p>
        ) : (
          <div className="min-h-24" />
        )
      ) : view === "empty" ? (
        <p className="text-sm text-muted-foreground">
          Nothing for today. Add a task.
        </p>
      ) : (
        <ul className="space-y-3">
          {list.map((item) => (
            <Row
              key={item.id}
              text={item.text}
              actionLabel={`Complete "${item.text}"`}
              onAction={() => onComplete(item)}
            />
          ))}
        </ul>
      )}
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

function Row({
  text,
  actionLabel,
  onAction,
  onEdit,
}: {
  text: string;
  actionLabel: string;
  onAction: () => void;
  // When provided, the row's text becomes click-to-edit inline. Today omits it,
  // so its rows stay read-only.
  onEdit?: (text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);

  const startEdit = () => {
    if (!onEdit) return;
    setDraft(text);
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    // No-op on empty or unchanged, matching add's empty guard.
    if (!trimmed || trimmed === text) return;
    onEdit?.(trimmed);
  };

  return (
    <li className="flex items-center gap-4 rounded-xl border bg-card px-4 py-4">
      <button
        type="button"
        aria-label={actionLabel}
        className="size-6 shrink-0 rounded-full border-2 border-muted-foreground/50 transition-colors hover:border-primary hover:bg-primary/10"
        onClick={onAction}
      />
      {editing ? (
        <Input
          autoFocus
          value={draft}
          aria-label={`Edit "${text}"`}
          className="h-9 flex-1"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
        />
      ) : (
        <span
          className={
            "flex-1 text-base" + (onEdit ? " cursor-text" : "")
          }
          onClick={startEdit}
        >
          {text}
        </span>
      )}
    </li>
  );
}
