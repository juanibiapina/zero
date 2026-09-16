import { useCallback, useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { isNull } from "@tanstack/db";
import {
  dayLabel,
  localToday,
  messageOf,
  undoableAction,
  upcomingSections,
} from "@zero/agent-core";
import { Input } from "@/components/ui/input";
import { ErrorText } from "@/components/ConnectionStatus";
import { getTasksApi, type TasksApi } from "@/lib/tasks-collection";
import { useForegroundRefetch } from "@/lib/screen-hooks";
import { type Task } from "@/lib/tasks";

// Upcoming lists tasks scheduled for a future day, grouped into day sections.
// The complement of Home: what has shown up stays there, what is still ahead
// shows here — every future-dated open task, loose or project, no other gate.
// The Task data layer is the same shared singleton.
export function UpcomingPage() {
  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10">
        <div className="mx-auto w-full max-w-2xl space-y-6">
          <h1 className="text-2xl font-bold tracking-tight">Upcoming</h1>
          <UpcomingPanel />
        </div>
      </main>
    </div>
  );
}

function UpcomingPanel() {
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
  return api ? <UpcomingReady api={api} /> : <div className="min-h-24" />;
}

function UpcomingReady({ api }: { api: TasksApi }) {
  const { data: tasks } = useLiveQuery((q) =>
    q.from({ t: api.collection }).where(({ t }) => isNull(t.completedAt)),
  );

  const today = localToday();
  const sections = useMemo(
    () => upcomingSections(tasks ?? [], today),
    [tasks, today],
  );

  const [error, setError] = useState<string | null>(null);

  useForegroundRefetch(api.refetch);

  const onComplete = useCallback(
    (item: Task) => {
      setError(null);
      // Same single bottom Undo snackbar as elsewhere; Undo reopens the task.
      undoableAction({
        message: "Completed",
        act: () => api.complete(item.id, today),
        undo: () =>
          item.recurrence
            ? api.undoOccurrence(item, today)
            : api.reopen(item),
        onError: setError,
      });
    },
    [api, today],
  );

  const onEdit = useCallback(
    (item: Task, text: string) => {
      setError(null);
      const tx = api.edit(item.id, text);
      tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
    },
    [api],
  );

  return (
    <div className="space-y-6">
      {error && <ErrorText>{error}</ErrorText>}

      {sections.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing scheduled ahead.</p>
      ) : (
        <div className="space-y-6">
          {sections.map((section) => (
            <section key={section.date} className="space-y-3">
              <h2 className="text-sm font-semibold text-muted-foreground">
                {dayLabel(section.date, today)}
              </h2>
              <ul className="space-y-3">
                {section.tasks.map((item) => (
                  <Row
                    key={item.id}
                    text={item.text}
                    onComplete={() => onComplete(item)}
                    onEdit={(text) => onEdit(item, text)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({
  text,
  onComplete,
  onEdit,
}: {
  text: string;
  onComplete: () => void;
  onEdit: (text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);

  const startEdit = () => {
    setDraft(text);
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (!trimmed || trimmed === text) return;
    onEdit(trimmed);
  };

  return (
    <li className="flex items-center gap-3 rounded-xl border bg-card px-4 py-4">
      <button
        type="button"
        aria-label={`Complete "${text}"`}
        className="size-6 shrink-0 rounded-full border-2 border-muted-foreground/50 transition-colors hover:border-primary hover:bg-primary/10"
        onClick={onComplete}
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
        <span className="flex-1 cursor-text text-base" onClick={startEdit}>
          {text}
        </span>
      )}
    </li>
  );
}
