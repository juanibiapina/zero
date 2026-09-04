import { useCallback, useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { isNull } from "@tanstack/db";
import {
  capturesLocalToday,
  dayLabel,
  messageOf,
  upcomingSections,
} from "@zero/agent-core";
import { Input } from "@/components/ui/input";
import { ErrorText } from "@/components/ConnectionStatus";
import { getCapturesApi, type CapturesApi } from "@/lib/captures-collection";
import { useForegroundRefetch } from "@/lib/screen-hooks";
import { type Capture } from "@/lib/captures";

// Upcoming lists captures scheduled for a future day, grouped into day sections.
// The complement of Captures: what has shown up stays there, what is still ahead
// shows here. The Capture data layer is the same shared singleton.
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
  return api ? <UpcomingReady api={api} /> : <div className="min-h-24" />;
}

function UpcomingReady({ api }: { api: CapturesApi }) {
  const { data: captures } = useLiveQuery((q) =>
    q.from({ c: api.collection }).where(({ c }) => isNull(c.processedAt)),
  );

  const today = capturesLocalToday();
  const sections = useMemo(
    () => upcomingSections(captures ?? [], today),
    [captures, today],
  );

  const [error, setError] = useState<string | null>(null);

  useForegroundRefetch(api.refetch);

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
                {section.captures.map((item) => (
                  <Row
                    key={item.id}
                    text={item.text}
                    onProcess={() => onProcess(item)}
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
  onProcess,
  onEdit,
}: {
  text: string;
  onProcess: () => void;
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
        aria-label={`Process "${text}"`}
        className="size-6 shrink-0 rounded-full border-2 border-muted-foreground/50 transition-colors hover:border-primary hover:bg-primary/10"
        onClick={onProcess}
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
