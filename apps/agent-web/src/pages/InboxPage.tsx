import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppHeader } from "@/components/AppHeader";
import { ErrorText } from "@/components/ConnectionStatus";
import {
  addCapture,
  fetchInbox,
  processCapture,
  type Capture,
} from "@/lib/captures";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The GTD capture Inbox on the web. Parity with the mobile screen: capture (add),
// list open captures oldest-first, Process (remove). Hand-rolled fetch + local
// state, matching the rest of the web app; Process is optimistic with rollback.
// Reached only via the unlinked /inbox route — the current app is untouched.
export function InboxPage() {
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await fetchInbox();
        if (!cancelled) setCaptures(list);
      } catch (e) {
        if (!cancelled) setError(messageOf(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onAdd = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const created = await addCapture(trimmed);
        // Append (oldest-first order); keep the input open and cleared so many
        // items can be captured in a row.
        setCaptures((prev) => [...prev, created]);
        setText("");
        inputRef.current?.focus();
      } catch (e) {
        setError(messageOf(e));
      } finally {
        setBusy(false);
      }
    })();
  }, [text, busy]);

  const onProcess = useCallback((item: Capture) => {
    // Optimistic remove; restore the row on failure.
    setError(null);
    setCaptures((prev) => prev.filter((c) => c.id !== item.id));
    void (async () => {
      try {
        await processCapture(item.id);
      } catch (e) {
        setError(messageOf(e));
        setCaptures((prev) =>
          [...prev, item].sort((a, b) =>
            a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
          ),
        );
      }
    })();
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
            <Button type="submit" disabled={busy || text.trim() === ""}>
              {busy ? "Adding…" : "Add"}
            </Button>
          </form>

          {error && <ErrorText>{error}</ErrorText>}

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading your inbox…</p>
          ) : captures.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Your inbox is empty. Capture something.
            </p>
          ) : (
            <ul className="divide-y">
              {captures.map((item) => (
                <li key={item.id} className="flex items-center gap-3 py-3">
                  {/* Left round Process control, matching the mobile motif and
                      the Person-avatar circle. Click processes the capture out of
                      the Inbox (GTD Clarify). */}
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
