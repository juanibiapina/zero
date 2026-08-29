import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { isNull } from "@tanstack/db";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppHeader } from "@/components/AppHeader";
import { ErrorText } from "@/components/ConnectionStatus";
import { inboxView } from "@zero/agent-core";
import { getCapturesApi, type CapturesApi } from "@/lib/captures-collection";
import { type Capture } from "@/lib/captures";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function InboxPage() {
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

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />
      <main className="container mx-auto px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10">
        <div className="mx-auto w-full max-w-2xl space-y-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Inbox</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Capture anything. Process it later.
            </p>
          </div>
          {api ? (
            <InboxReady api={api} />
          ) : (
            <p className="text-sm text-muted-foreground">Loading your inbox…</p>
          )}
        </div>
      </main>
    </div>
  );
}

function InboxReady({ api }: { api: CapturesApi }) {
  const { data: captures, isLoading } = useLiveQuery((q) =>
    q
      .from({ c: api.collection })
      .where(({ c }) => isNull(c.processedAt))
      .orderBy(({ c }) => c.createdAt, "asc"),
  );

  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  const list = captures ?? [];
  // Gate on the row count, not isLoading: a hydrated snapshot must paint even
  // while the network sync is still pending. Write errors show above the list
  // (their own ErrorText), so the list region tracks no loadError here.
  const view = inboxView({
    count: list.length,
    isLoading,
    loadError: null,
  });

  return (
    <>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onAdd();
        }}
      >
        <Input
          ref={inputRef}
          autoFocus
          value={text}
          placeholder="Capture a thought"
          aria-label="Capture a thought"
          className="h-11"
          onChange={(e) => setText(e.target.value)}
        />
        <Button
          type="submit"
          size="lg"
          className="h-11 min-w-20"
          disabled={text.trim() === ""}
        >
          Add
        </Button>
      </form>

      {error && <ErrorText>{error}</ErrorText>}

      {view === "loading" ? (
        <p className="text-sm text-muted-foreground">Loading your inbox…</p>
      ) : view === "empty" ? (
        <p className="text-sm text-muted-foreground">
          Your inbox is empty. Capture something.
        </p>
      ) : (
        <ul className="space-y-3">
          {list.map((item) => (
            <li
              key={item.id}
              className="flex items-center gap-4 rounded-xl border bg-card px-4 py-4"
            >
              <button
                type="button"
                aria-label={`Process "${item.text}"`}
                className="size-6 shrink-0 rounded-full border-2 border-muted-foreground/50 transition-colors hover:border-primary hover:bg-primary/10"
                onClick={() => onProcess(item)}
              />
              <span className="flex-1 text-base">{item.text}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
