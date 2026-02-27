import { useEffect, useRef, useState, useCallback } from "react";
import { useParams } from "react-router";
import { useAuth } from "@clerk/clerk-react";
import { ChevronRight, Loader2, Send, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "react-router";
import { StatusBadge } from "@/components/StatusBadge";
import { TurnView } from "@/components/TurnView";
import { processAgentEvent } from "@/lib/process-agent-event";
import type { AgentEvent, SessionServerMessage } from "@zero/core";
import type { Turn, SessionStatus } from "@/lib/session-types";

// ─── Keyed wrapper ───────────────────────────────────────────────────────────
// Forces full remount when navigating between sessions so stale state
// (turns, WebSocket, scroll position) is never carried over.

export default function SessionPage() {
  const { id } = useParams();
  return <SessionPageInner key={id} />;
}

// ─── Inner implementation ────────────────────────────────────────────────────

function SessionPageInner() {
  const { owner, repo, id } = useParams();
  const { getToken } = useAuth();
  const [turns, setTurns] = useState<Turn[]>([]);

  const [status, setStatus] = useState<SessionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const wsRef = useRef<WebSocket | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastSeqRef = useRef<number>(0);
  const pendingPromptRef = useRef<string | null>(null);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectWebSocketRef = useRef<((sessionId: string) => Promise<void>) | null>(null);
  /** Track user messages we've sent optimistically, to dedup on replay */
  const sentUserMessagesRef = useRef<Set<string>>(new Set());
  const caughtUpRef = useRef(false);
  /** Buffer turns during replay to avoid per-event renders / scroll flicker */
  const replayBufferRef = useRef<Turn[]>([]);
  const statusRef = useRef<SessionStatus>("connecting");

  const setStatusBoth = useCallback((s: SessionStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  // Auto-scroll to bottom (disabled when user scrolls up)
  useEffect(() => {
    if (shouldAutoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // During event replay (before caught_up), don't let scroll events
    // disable auto-scroll — content height changes from rapid setTurns
    // calls can cause spurious "not at bottom" detections.
    if (!caughtUpRef.current) return;
    shouldAutoScrollRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  }, []);

  // Auto-focus input
  useEffect(() => {
    inputRef.current?.focus();
  }, [status]);

  // ── WebSocket connection ────────────────────────────────────────────────

  const connectWebSocket = useCallback(
    async (sessionId: string) => {
      const token = await getToken();
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${location.host}/api/sessions/${sessionId}/ws?token=${token}`;

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatusBoth("connecting");
        caughtUpRef.current = false;
        replayBufferRef.current = [];

        // Start ping keepalive every 30s
        pingIntervalRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, 30000);
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string) as SessionServerMessage;

          switch (msg.type) {
            case "caught_up":
              caughtUpRef.current = true;
              // Flush buffered replay turns in a single render to avoid
              // per-event re-renders and scroll flicker.
              if (replayBufferRef.current.length > 0) {
                setTurns(replayBufferRef.current);
                replayBufferRef.current = [];
              }
              // Scroll to bottom after replay completes. Use rAF to ensure
              // React has committed the flushed turns to the DOM.
              if (shouldAutoScrollRef.current) {
                requestAnimationFrame(() => {
                  if (scrollRef.current) {
                    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                  }
                });
              }
              // Send pending prompt if we have one — don't gate on status.
              // SessionDO handles waiting for the container to be ready.
              if (pendingPromptRef.current) {
                const text = pendingPromptRef.current;
                pendingPromptRef.current = null;
                ws.send(JSON.stringify({ type: "message", text }));
              }
              return;

            case "status": {
              setStatusBoth(msg.status);
              // Capture error message from status event (e.g. API auth failure)
              if (msg.status === "error" && msg.error) {
                setError(msg.error);
              }
              // If transitioning to idle, send pending prompt
              // (fallback for messages queued before caught_up)
              if (msg.status === "idle" && pendingPromptRef.current && caughtUpRef.current) {
                const text = pendingPromptRef.current;
                pendingPromptRef.current = null;
                ws.send(JSON.stringify({ type: "message", text }));
              }
              return;
            }

            case "pong":
              return;

            case "error":
              setError(msg.message);
              return;

            case "event": {
              if (msg.seq <= lastSeqRef.current) return; // dedup
              lastSeqRef.current = msg.seq;

              if (msg.source === "user") {
                // User message — check if we already added it optimistically
                const userText = (msg.data as { text?: string })?.text ?? "";
                if (userText && sentUserMessagesRef.current.has(userText)) {
                  sentUserMessagesRef.current.delete(userText);
                  return; // Already shown
                }
                if (!caughtUpRef.current) {
                  // Buffer during replay — avoid per-event renders
                  replayBufferRef.current = [...replayBufferRef.current, { role: "user", text: userText }];
                } else {
                  setTurns((prev) => [...prev, { role: "user", text: userText }]);
                }
                return;
              }

              // Agent event — typed via AgentEvent
              const event = msg.data as AgentEvent;
              if (!caughtUpRef.current) {
                // Buffer during replay — avoid per-event renders
                replayBufferRef.current = processAgentEvent(event, replayBufferRef.current);
              } else {
                setTurns((prev) => processAgentEvent(event, prev));
              }
              return;
            }
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.onclose = (e) => {
        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }

        // Reconnect on unexpected close (not clean 1000)
        if (e.code !== 1000) {
          setTimeout(async () => {
            try {
              await connectWebSocketRef.current?.(sessionId);
            } catch {
              setStatusBoth("error");
              setError("Lost connection to session");
            }
          }, 2000);
        }
      };

      ws.onerror = () => {
        // onclose will fire after this
      };
    },
    [getToken, setStatusBoth]
  );

  // ── Connect WebSocket ───────────────────────────────────────────────────
  useEffect(() => {
    connectWebSocketRef.current = connectWebSocket;
    if (id) {
      void connectWebSocket(id);
    }
    return () => {
      if (wsRef.current) {
        wsRef.current.close(1000, "navigating away");
        wsRef.current = null;
      }
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
    };
  }, [id, connectWebSocket]);

  // ── Stop/abort session ────────────────────────────────────────────────

  const handleStop = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "stop" }));
    }
  }, []);

  // ── Handle user input ───────────────────────────────────────────────────

  const handleSend = async () => {
    const text = input.trim();
    if (!text) return;

    setInput("");

    // Show the user message immediately (optimistic)
    setTurns((prev) => [...prev, { role: "user", text }]);
    sentUserMessagesRef.current.add(text);

    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && caughtUpRef.current) {
      // Send immediately — SessionDO handles waiting for container readiness
      ws.send(JSON.stringify({ type: "message", text }));
    } else {
      // WS not connected yet — queue for when caught_up
      pendingPromptRef.current = text;
    }
  };

  // Show input bar for all active states (hidden only on terminal error)
  const showInputBar = status !== "error";
  const isRunning = status === "running";

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 border-b pb-3 mb-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
          <Link to="/projects" className="hover:text-foreground">
            Projects
          </Link>
          {owner && repo && (
            <>
              <ChevronRight className="h-3 w-3" />
              <Link to={`/p/${owner}/${repo}`} className="hover:text-foreground">
                {owner}/{repo}
              </Link>
            </>
          )}
          <ChevronRight className="h-3 w-3" />
          <span className="text-foreground">Session</span>
        </div>
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold">Agent Session</h1>
          <StatusBadge status={status} />
        </div>
      </div>

      {/* Error display */}
      {error && (
        <div className="shrink-0 rounded-lg border border-destructive/30 bg-destructive/5 p-3 mb-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Chat area */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto space-y-1 pr-2">
        {turns.length === 0 && (
          <div className="text-muted-foreground text-sm py-8 text-center">
            {status === "connecting" && (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Connecting to agent...
              </span>
            )}
            {(status === "starting" || status === "resuming") && (
              <>
                <span className="flex items-center justify-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Getting ready...
                </span>
                <span className="block mt-2 text-xs text-muted-foreground/60">
                  You can type your message while we get ready
                </span>
              </>
            )}
            {(status === "idle" || status === "stopped") && "Send a message to get started."}
            {status === "error" && !error && "Something went wrong."}
          </div>
        )}

        {turns.map((turn, i) => (
          <TurnView key={i} turn={turn} />
        ))}

        {/* Waiting indicator after user message when container isn't ready */}
        {turns.length > 0 &&
          turns[turns.length - 1]?.role === "user" &&
          (status === "connecting" ||
            status === "starting" ||
            status === "resuming") && (
            <div className="flex items-center gap-2 text-muted-foreground py-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Getting ready… your message will be sent when ready
            </div>
          )}

        {(status === "starting" || status === "resuming" || status === "running") &&
          turns.length > 0 &&
          turns[turns.length - 1]?.role !== "assistant" &&
          turns[turns.length - 1]?.role !== "user" && (
            <div className="flex items-center gap-2 text-muted-foreground py-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Agent is working...
            </div>
          )}
      </div>

      {/* Input bar — always visible except on terminal states */}
      {showInputBar && (
        <div className="shrink-0 border-t pt-3 mt-3">
          <div className="flex gap-2">
            <textarea
              ref={inputRef}
              className="flex-1 rounded-md border bg-background p-3 text-sm min-h-[44px] max-h-[120px] resize-none focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Send a message..."
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (isRunning) return; // Don't send while running
                  void handleSend();
                }
              }}
            />
            {isRunning ? (
              <Button
                size="icon"
                variant="destructive"
                onClick={handleStop}
                className="shrink-0 h-[44px] w-[44px]"
                title="Stop agent"
              >
                <Square className="h-4 w-4 fill-current" />
              </Button>
            ) : (
              <Button
                size="icon"
                onClick={() => void handleSend()}
                disabled={!input.trim()}
                className="shrink-0 h-[44px] w-[44px]"
              >
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
