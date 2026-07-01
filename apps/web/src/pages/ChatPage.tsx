import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppHeader } from "@/components/AppHeader";
import {
  type ChatMessage,
  type SessionSummary,
  createSession,
  listSessions,
  pollMessages,
  sendMessage,
} from "@/lib/chat";

const ACTIVE_POLL_MS = 1500;
const IDLE_POLL_MS = 6000;

function sessionLabel(s: SessionSummary): string {
  return s.name ?? `${s.type} · ${s.sessionId.slice(0, 8)}`;
}

// ─── Session list ───────────────────────────────────────────────────

function SessionList({
  sessions,
  activeId,
  onSelect,
  onNew,
  creating,
}: {
  sessions: SessionSummary[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
  onNew: () => void;
  creating: boolean;
}) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-muted/30">
      <div className="p-3">
        <Button className="w-full" size="sm" disabled={creating} onClick={onNew}>
          {creating ? "Creating…" : "New session"}
        </Button>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-3">
        {sessions.length === 0 ? (
          <p className="px-2 py-4 text-sm text-muted-foreground">No sessions yet.</p>
        ) : (
          sessions.map((s) => (
            <button
              key={s.sessionId}
              onClick={() => onSelect(s.sessionId)}
              className={`mb-1 w-full truncate rounded-md px-3 py-2 text-left text-sm transition-colors ${
                s.sessionId === activeId
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/50"
              }`}
            >
              {sessionLabel(s)}
            </button>
          ))
        )}
      </nav>
    </aside>
  );
}

// ─── Thread ─────────────────────────────────────────────────────────

function Thread({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef<number | undefined>(undefined);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Poll for new messages. Backs off when idle and caught up.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const { messages: fresh, status: st } = await pollMessages(sessionId, cursorRef.current);
        if (cancelled) return;
        if (fresh.length > 0) {
          cursorRef.current = fresh[fresh.length - 1].id;
          setMessages((prev) => [...prev, ...fresh]);
        }
        setStatus(st);
        const delay = st === "active" ? ACTIVE_POLL_MS : IDLE_POLL_MS;
        timer = setTimeout(() => void tick(), delay);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        timer = setTimeout(() => void tick(), IDLE_POLL_MS);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  const onSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setError(null);
    try {
      const landedOn = await sendMessage(sessionId, trimmed);
      setText("");
      if (landedOn !== sessionId) {
        void navigate(`/chat/${landedOn}`);
        return;
      }
      setStatus("active");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [text, sending, sessionId, navigate]);

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                m.role === "user"
                  ? "self-end bg-primary text-primary-foreground"
                  : "self-start bg-muted"
              }`}
            >
              {m.text}
            </div>
          ))}
          {status === "active" && (
            <div className="self-start rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
              Thinking…
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
      <div className="border-t px-4 py-3">
        <form
          className="mx-auto flex w-full max-w-2xl items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void onSend();
          }}
        >
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a message…"
            disabled={sending}
          />
          <Button type="submit" disabled={sending || text.trim() === ""}>
            Send
          </Button>
        </form>
        {error && <p className="mx-auto mt-2 w-full max-w-2xl text-sm text-destructive">{error}</p>}
      </div>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────

export function ChatPage() {
  const navigate = useNavigate();
  const { sessionId } = useParams();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSessions(await listSessions());
    } catch {
      // Non-fatal; the list stays as-is.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listSessions();
        if (!cancelled) setSessions(list);
      } catch {
        // Non-fatal; the list stays as-is.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const onNew = useCallback(async () => {
    setCreating(true);
    try {
      const id = await createSession();
      await refresh();
      void navigate(`/chat/${id}`);
    } finally {
      setCreating(false);
    }
  }, [navigate, refresh]);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader />
      <div className="flex flex-1 overflow-hidden">
        <SessionList
          sessions={sessions}
          activeId={sessionId}
          onSelect={(id) => void navigate(`/chat/${id}`)}
          onNew={() => void onNew()}
          creating={creating}
        />
        {sessionId ? (
          <Thread key={sessionId} sessionId={sessionId} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Select a session or start a new one.
          </div>
        )}
      </div>
    </div>
  );
}
