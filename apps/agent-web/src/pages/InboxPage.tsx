import { useCallback, useRef, useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { isNull } from "@tanstack/db";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppHeader } from "@/components/AppHeader";
import { ErrorText } from "@/components/ConnectionStatus";
import { capturesCollection } from "@/lib/captures-collection";
import { type Capture } from "@/lib/captures";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function InboxPage() {
  const { data: captures, isLoading } = useLiveQuery((q) =>
    q
      .from({ c: capturesCollection })
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
    const tx = capturesCollection.insert({
      id: `temp-${crypto.randomUUID()}`,
      text: trimmed,
      createdAt: new Date().toISOString(),
      processedAt: null,
    });
    tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
    setText("");
    inputRef.current?.focus();
  }, [text]);

  const onProcess = useCallback((item: Capture) => {
    setError(null);
    const tx = capturesCollection.update(item.id, (draft) => {
      draft.processedAt = new Date().toISOString();
    });
    tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
  }, []);

  const list = captures ?? [];

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
              onChange={(e) => setText(e.target.value)}
            />
            <Button type="submit" disabled={text.trim() === ""}>
              Add
            </Button>
          </form>

          {error && <ErrorText>{error}</ErrorText>}

          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading your inbox…</p>
          ) : list.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Your inbox is empty. Capture something.
            </p>
          ) : (
            <ul className="divide-y">
              {list.map((item) => (
                <li key={item.id} className="flex items-center gap-3 py-3">
                  <button
                    type="button"
                    aria-label={`Process "${item.text}"`}
                    className="size-5 shrink-0 rounded-full border-2 border-muted-foreground/50 transition-colors hover:border-primary hover:bg-primary/10"
                    onClick={() => onProcess(item)}
                  />
                  <span className="flex-1 text-sm">{item.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}
