import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useSearchParams } from "react-router";
import { useAuth } from "@clerk/clerk-react";
import { ChevronRight, Loader2, Send, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "react-router";
import { StatusBadge } from "@/components/StatusBadge";
import { TurnView } from "@/components/TurnView";
import { processAgentEvent } from "@/lib/process-agent-event";
import type { AgentEvent } from "@zero/core";
import type { Turn, SessionStatus } from "@/lib/session-types";

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function SessionPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const { getToken } = useAuth();
  const [turns, setTurns] = useState<Turn[]>([]);
  const isNew = !id;

  // For new sessions, owner/repo come from query params
  const [owner] = useState(searchParams.get("owner") ?? "");
  const [repo] = useState(searchParams.get("repo") ?? "");

  const [status, setStatus] = useState<SessionStatus>(
    isNew ? "creating" : "connecting"
  );
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sessionIdRef = useRef<string | null>(isNew ? null : id ?? null);
  const lastSeqRef = useRef<number>(0);
  const pendingPromptRef = useRef<string | null>(null);
  const createdRef = useRef(false);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Track user messages we've sent optimistically, to dedup on replay */
  const sentUserMessagesRef = useRef<Set<string>>(new Set());
  const caughtUpRef = useRef(false);
  const statusRef = useRef<SessionStatus>(isNew ? "creating" : "connecting");

  const setStatusBoth = useCallback((s: SessionStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns]);

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

        // Start ping keepalive every 30s
        pingIntervalRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, 30000);
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);

          switch (msg.type) {
            case "caught_up":
              caughtUpRef.current = true;
              // Send pending prompt if we have one — don't gate on status.
              // SessionDO handles waiting for the container to be ready.
              if (pendingPromptRef.current) {
                const text = pendingPromptRef.current;
                pendingPromptRef.current = null;
                ws.send(JSON.stringify({ type: "message", text }));
              }
              return;

            case "status": {
              const s = msg.status as string;
              if (["ready", "running", "idle", "error", "starting", "stopped", "pending", "failed", "resuming"].includes(s)) {
                setStatusBoth(s === "pending" ? "ready" : s === "failed" ? "error" : s as SessionStatus);
              }
              // Capture error message from status event (e.g. API auth failure)
              if ((s === "error" || s === "failed") && msg.error) {
                setError(msg.error as string);
              }
              // If transitioning to ready/idle, send pending prompt
              // (fallback for messages queued before caught_up)
              if ((s === "ready" || s === "idle") && pendingPromptRef.current && caughtUpRef.current) {
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
              const seq = msg.seq as number;
              if (seq <= lastSeqRef.current) return; // dedup
              lastSeqRef.current = seq;

              if (msg.source === "user") {
                // User message — check if we already added it optimistically
                const userText = msg.data?.text as string;
                if (userText && sentUserMessagesRef.current.has(userText)) {
                  sentUserMessagesRef.current.delete(userText);
                  return; // Already shown
                }
                // From another tab or replay — add it
                setTurns((prev) => [...prev, { role: "user", text: userText || "" }]);
                return;
              }

              // Agent event — typed via AgentEvent
              const event = msg.data as AgentEvent;
              setTurns((prev) => processAgentEvent(event, prev));
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
              await connectWebSocket(sessionId);
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

  // ── Auto-create session when new ────────────────────────────────────────

  useEffect(() => {
    if (!isNew || createdRef.current) return;
    createdRef.current = true;

    (async () => {
      setStatusBoth("creating");
      setError(null);

      try {
        const token = await getToken();
        const resp = await fetch("/api/sessions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ owner, repo }),
        });

        if (!resp.ok) {
          let message = `Failed to create session (${resp.status})`;
          try {
            const data = await resp.json();
            if ((data as { error?: string }).error) {
              message = (data as { error: string }).error;
            }
          } catch {
            // Response wasn't JSON
          }
          throw new Error(message);
        }

        const data = (await resp.json()) as { sessionId: string };
        sessionIdRef.current = data.sessionId;

        // Update URL without remounting
        window.history.replaceState(
          null,
          "",
          `/sessions/${data.sessionId}`
        );

        // Connect WebSocket
        setStatusBoth("connecting");
        await connectWebSocket(data.sessionId);
      } catch (err) {
        setStatusBoth("error");
        setError(
          err instanceof Error
            ? err.message
            : "Failed to create session"
        );
      }
    })();
  }, [isNew, owner, repo, getToken, connectWebSocket, setStatusBoth]);

  // ── Connect WebSocket for existing sessions ─────────────────────────────
  useEffect(() => {
    if (!isNew && id) {
      connectWebSocket(id);
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
  }, [isNew, id, connectWebSocket]);

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

  // Show input bar for all active states (hidden only on terminal error/stopped)
  const showInputBar = status !== "error" && status !== "stopped";
  const isRunning = status === "running";

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 border-b pb-3 mb-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
          <Link to="/" className="hover:text-foreground">
            Dashboard
          </Link>
          {owner && repo && (
            <>
              <ChevronRight className="h-3 w-3" />
              <Link to={`/projects/${owner}/${repo}`} className="hover:text-foreground">
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
      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-1 pr-2">
        {turns.length === 0 && (
          <div className="text-muted-foreground text-sm py-8 text-center">
            {status === "creating" && (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Creating session...
              </span>
            )}
            {status === "connecting" && (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Connecting to agent...
              </span>
            )}
            {status === "starting" && (
              <>
                <span className="flex items-center justify-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Setting up environment...
                </span>
                <span className="block mt-2 text-xs text-muted-foreground/60">
                  You can type your prompt while we get ready
                </span>
              </>
            )}
            {status === "resuming" && (
              <>
                <span className="flex items-center justify-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Waking up container...
                </span>
                <span className="block mt-2 text-xs text-muted-foreground/60">
                  You can type your message while we get ready
                </span>
              </>
            )}
            {status === "ready" && "Ready! Describe what you want the agent to do."}
            {status === "error" && !error && "Something went wrong."}
          </div>
        )}

        {turns.map((turn, i) => (
          <TurnView key={i} turn={turn} />
        ))}

        {/* Waiting indicator after user message when container isn't ready */}
        {turns.length > 0 &&
          turns[turns.length - 1]?.role === "user" &&
          (status === "creating" ||
            status === "connecting" ||
            status === "starting" ||
            status === "resuming") && (
            <div className="flex items-center gap-2 text-muted-foreground py-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              {status === "resuming"
                ? "Waking up container… your message will be sent when ready"
                : "Setting up… your prompt will be sent once the agent is ready"}
            </div>
          )}

        {(status === "creating" || status === "starting" || status === "resuming" || status === "running") &&
          turns.length > 0 &&
          turns[turns.length - 1]?.role !== "assistant" &&
          turns[turns.length - 1]?.role !== "user" && (
            <div className="flex items-center gap-2 text-muted-foreground py-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              {status === "creating" ? "Creating session..." :
               status === "resuming" ? "Waking up container..." :
               "Agent is working..."}
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
              placeholder={
                isRunning
                  ? "Type your next message..."
                  : status === "idle"
                    ? "Send a follow-up..."
                    : "Describe what you want the agent to do..."
              }
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (isRunning) return; // Don't send while running
                  handleSend();
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
                onClick={handleSend}
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
