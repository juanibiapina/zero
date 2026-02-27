import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router";
import { useAuth } from "@clerk/clerk-react";
import { ChevronRight, Loader2, Send, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "react-router";
import { StatusBadge } from "@/components/StatusBadge";
import { TurnView } from "@/components/TurnView";
import { processAgentEvent } from "@/lib/process-agent-event";
import type { AgentEvent, SessionServerMessage, PromptTemplate, ThinkingLevel } from "@zero/core";
import { defaultThinkingLevel } from "@zero/core";
import type { Turn, SessionStatus } from "@/lib/session-types";
import { SlashAutocomplete } from "@/components/SlashAutocomplete";
import { resolveSlashCommand, getSlashFilteredTemplates } from "@/lib/template-utils";
import { useAction } from "@/lib/use-action";
import { useSessionStore } from "@/lib/session-store";
import { useRegisterAction } from "@/lib/action-handlers";
import SessionDeleteDialog from "@/components/SessionDeleteDialog";
import ProviderPickerDialog from "@/components/ProviderPickerDialog";
import ModelPickerDialog from "@/components/ModelPickerDialog";
import ThinkingLevelPickerDialog from "@/components/ThinkingLevelPickerDialog";

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
  const navigate = useNavigate();
  const [turns, setTurns] = useState<Turn[]>([]);

  const [status, setStatus] = useState<SessionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [acIndex, setAcIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const pendingAutoScrollRef = useRef(false);
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

  // Provider/model/thinking state
  const [provider, setProvider] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("high");
  const [modelSupportsReasoning, setModelSupportsReasoning] = useState(false);
  const [modelSupportsXhigh, setModelSupportsXhigh] = useState(false);
  const [providerPickerOpen, setProviderPickerOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [thinkingPickerOpen, setThinkingPickerOpen] = useState(false);

  // Delete session state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const removeSession = useSessionStore((s) => s.removeSession);

  const setStatusBoth = useCallback((s: SessionStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  // Fetch prompt templates (once on mount)
  useEffect(() => {
    void (async () => {
      try {
        const token = await getToken();
        const resp = await fetch("/api/templates", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = (await resp.json()) as { templates?: PromptTemplate[] };
        setTemplates(data.templates ?? []);
      } catch {
        // Non-critical — slash commands just won't work
      }
    })();
  }, [getToken]);

  // Auto-scroll to bottom (disabled when user scrolls up)
  useEffect(() => {
    if (shouldAutoScrollRef.current && scrollRef.current) {
      // Check if window is focused/visible - if not, mark scroll as pending
      if (document.hidden || !document.hasFocus()) {
        pendingAutoScrollRef.current = true;
      } else {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
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

  // Helper function to perform scroll-to-bottom
  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  // Handle window focus changes to catch up on missed auto-scrolls
  useEffect(() => {
    const handleFocusChange = () => {
      // Only scroll if auto-scroll is enabled and we missed a scroll while unfocused
      if (shouldAutoScrollRef.current && pendingAutoScrollRef.current) {
        pendingAutoScrollRef.current = false;
        requestAnimationFrame(scrollToBottom);
      }
    };

    const handleVisibilityChange = () => {
      // Only trigger on becoming visible (not hidden)
      if (!document.hidden) {
        handleFocusChange();
      }
    };

    // Listen for both focus and visibility change events for better compatibility
    window.addEventListener('focus', handleFocusChange);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', handleFocusChange);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [scrollToBottom]);

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
                if (document.hidden || !document.hasFocus()) {
                  pendingAutoScrollRef.current = true;
                } else {
                  requestAnimationFrame(scrollToBottom);
                }
              }
              // Send pending prompt if we have one — don't gate on status.
              // SessionDO handles waiting for the container to be ready.
              if (pendingPromptRef.current) {
                const pending = pendingPromptRef.current;
                pendingPromptRef.current = null;
                ws.send(pending);
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
                const pending = pendingPromptRef.current;
                pendingPromptRef.current = null;
                ws.send(pending);
              }
              return;
            }

            case "config":
              setProvider(msg.provider);
              setModel(msg.model);
              setThinkingLevel(msg.thinkingLevel);
              return;

            case "pong":
              return;

            case "error":
              setError(msg.message);
              return;

            case "event": {
              if (msg.seq <= lastSeqRef.current) return; // dedup
              lastSeqRef.current = msg.seq;

              if (msg.source === "user") {
                // User message — extract text and optional template metadata
                const eventData = msg.data as {
                  text?: string;
                  template?: { slug: string; name: string };
                };
                const userText = eventData.text ?? "";
                const userTemplate = eventData.template;

                // Check if we already added it optimistically
                const dedupKey = userTemplate
                  ? `tpl:${userTemplate.slug}:${userText}`
                  : userText;
                if (dedupKey && sentUserMessagesRef.current.has(dedupKey)) {
                  sentUserMessagesRef.current.delete(dedupKey);
                  return; // Already shown
                }

                const userTurn = userTemplate
                  ? { role: "user" as const, text: userText, template: userTemplate }
                  : { role: "user" as const, text: userText };

                if (!caughtUpRef.current) {
                  replayBufferRef.current = [...replayBufferRef.current, userTurn];
                } else {
                  setTurns((prev) => [...prev, userTurn]);
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

  // ── Fetch model reasoning capability ─────────────────────────────────────

  useEffect(() => {
    if (!provider || !model) return;
    void (async () => {
      try {
        const token = await getToken();
        const resp = await fetch(`/api/providers/${provider}/models`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = (await resp.json()) as { models?: { id: string; reasoning: boolean; supportsXhigh: boolean }[] };
        const m = data.models?.find((m) => m.id === model);
        setModelSupportsReasoning(m?.reasoning ?? false);
        setModelSupportsXhigh(m?.supportsXhigh ?? false);
      } catch {
        setModelSupportsReasoning(false);
        setModelSupportsXhigh(false);
      }
    })();
  }, [provider, model, getToken]);

  // ── Configure provider/model ────────────────────────────────────────────

  const sendConfigure = useCallback((newProvider: string, newModel: string, newThinkingLevel?: ThinkingLevel) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const msg: Record<string, string> = { type: "configure", provider: newProvider, model: newModel };
      if (newThinkingLevel !== undefined) msg.thinkingLevel = newThinkingLevel;
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const handleProviderSelect = useCallback(
    async (newProvider: string) => {
      if (newProvider === provider) return;
      // Fetch models + preferred default for the new provider
      try {
        const token = await getToken();
        const resp = await fetch(`/api/providers/${newProvider}/models`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = (await resp.json()) as {
          models?: { id: string; reasoning: boolean }[];
          defaultModelId?: string | null;
        };
        const models = data.models ?? [];
        // Use backend-provided default, fall back to first model
        const defaultModel = models.find((m) => m.id === data.defaultModelId) ?? models[0];
        const newModel = defaultModel?.id ?? "";
        const newThinking = defaultThinkingLevel(defaultModel?.reasoning ?? false);
        sendConfigure(newProvider, newModel, newThinking);
      } catch {
        // Fallback: send with empty model, backend will handle
        sendConfigure(newProvider, "");
      }
    },
    [provider, getToken, sendConfigure],
  );

  const handleModelSelect = useCallback(
    (newModel: string) => {
      if (newModel === model) return;
      // Send configure immediately to avoid race with user sending a message.
      // Use cached reasoning info from ModelPickerDialog to adjust thinking level
      // synchronously — the model list was already fetched when the picker opened.
      sendConfigure(provider, newModel);
      // Then async-check reasoning capability and send a follow-up configure
      // with adjusted thinking level if needed
      void (async () => {
        try {
          const token = await getToken();
          const resp = await fetch(`/api/providers/${provider}/models`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const data = (await resp.json()) as { models?: { id: string; reasoning: boolean; supportsXhigh: boolean }[] };
          const modelInfo = data.models?.find((m) => m.id === newModel);
          const supportsReasoning = modelInfo?.reasoning ?? false;
          const xhighCapable = modelInfo?.supportsXhigh ?? false;
          // If switching to non-reasoning model, force "off".
          // If switching to reasoning model while currently "off", default to "high".
          // If current level is "xhigh" but new model doesn't support it, downgrade to "high".
          let newThinking: ThinkingLevel | undefined;
          if (!supportsReasoning) {
            newThinking = "off";
          } else if (thinkingLevel === "off") {
            newThinking = "high";
          } else if (thinkingLevel === "xhigh" && !xhighCapable) {
            newThinking = "high";
          }
          if (newThinking !== undefined) {
            sendConfigure(provider, newModel, newThinking);
          }
        } catch {
          // Model already configured, thinking level adjustment is best-effort
        }
      })();
    },
    [provider, model, thinkingLevel, getToken, sendConfigure],
  );

  const handleThinkingSelect = useCallback(
    (newLevel: ThinkingLevel) => {
      if (newLevel === thinkingLevel) return;
      sendConfigure(provider, model, newLevel);
    },
    [provider, model, thinkingLevel, sendConfigure],
  );

  // ── Actions: switch provider / model / thinking ─────────────────────────
  const anyDialogOpen = deleteDialogOpen || providerPickerOpen || modelPickerOpen || thinkingPickerOpen;
  const openProviderPicker = useCallback(() => setProviderPickerOpen(true), []);
  const openModelPicker = useCallback(() => setModelPickerOpen(true), []);
  const openThinkingPicker = useCallback(() => setThinkingPickerOpen(true), []);
  useAction("switchProvider", openProviderPicker, { enabled: !anyDialogOpen && !!provider });
  useAction("switchModel", openModelPicker, { enabled: !anyDialogOpen && !!provider });
  useAction("switchThinking", openThinkingPicker, { enabled: !anyDialogOpen && !!provider && modelSupportsReasoning });

  // Register for command palette (visible while SessionPage is mounted)
  useRegisterAction("switchProvider", openProviderPicker);
  useRegisterAction("switchModel", openModelPicker);
  useRegisterAction("switchThinking", openThinkingPicker);

  // ── Handle user input ───────────────────────────────────────────────────

  const handleSend = async () => {
    const rawInput = input.trim();
    if (!rawInput) return;

    setInput("");

    // Resolve slash command if present
    const resolved = resolveSlashCommand(rawInput, templates);

    if (resolved) {
      // Template matched — show original text with template badge, send expanded
      setTurns((prev) => [
        ...prev,
        { role: "user", text: resolved.originalText, template: resolved.template },
      ]);
      // Dedup key: template slug + original text (matches what SessionDO stores)
      sentUserMessagesRef.current.add(`tpl:${resolved.template.slug}:${resolved.originalText}`);

      const wsMessage = JSON.stringify({
        type: "message",
        text: resolved.expandedText,
        template: resolved.template,
        originalText: resolved.originalText,
      });

      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN && caughtUpRef.current) {
        ws.send(wsMessage);
      } else {
        pendingPromptRef.current = wsMessage;
      }
    } else {
      // Plain message — no template
      setTurns((prev) => [...prev, { role: "user", text: rawInput }]);
      sentUserMessagesRef.current.add(rawInput);

      const wsMessage = JSON.stringify({ type: "message", text: rawInput });

      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN && caughtUpRef.current) {
        ws.send(wsMessage);
      } else {
        pendingPromptRef.current = wsMessage;
      }
    }
  };

  // ── Delete session ───────────────────────────────────────────────────────

  const handleDelete = async () => {
    if (!id) return;
    setIsDeleting(true);
    try {
      const token = await getToken();
      const resp = await fetch(`/api/sessions/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) {
        // Remove from local store
        removeSession(id);
        // Close dialog and navigate to dashboard
        setDeleteDialogOpen(false);
        void navigate("/");
      }
    } catch {
      // Ignore errors - dialog stays open so user can try again or cancel
    } finally {
      setIsDeleting(false);
    }
  };

  // Wire up the delete session action (only when dialog is not open)
  useAction("deleteCurrentSession", () => setDeleteDialogOpen(true), {
    enabled: !deleteDialogOpen,
  });

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
          {provider && (
            <>
              <button
                onClick={() => setProviderPickerOpen(true)}
                className="rounded-md border px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
                title="Switch provider"
              >
                {provider}
              </button>
              <span className="text-muted-foreground/40">/</span>
              <button
                onClick={() => setModelPickerOpen(true)}
                className="rounded-md border px-2 py-1 text-xs font-mono text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
                title="Switch model"
              >
                {model}
              </button>
              {modelSupportsReasoning && (
                <>
                  <span className="text-muted-foreground/40">/</span>
                  <button
                    onClick={() => setThinkingPickerOpen(true)}
                    className="rounded-md border px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
                    title="Switch thinking level"
                  >
                    thinking: {thinkingLevel}
                  </button>
                </>
              )}
            </>
          )}
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
          <div className="relative flex gap-2">
            <SlashAutocomplete
              input={input}
              templates={templates}
              anchorRef={inputRef}
              selectedIndex={acIndex}
              onSelectedIndexChange={setAcIndex}
              onSelect={(t) => {
                setInput(`/${t.slug} `);
                setAcIndex(0);
                inputRef.current?.focus();
              }}
            />
            <textarea
              ref={inputRef}
              className="flex-1 rounded-md border bg-background p-3 text-sm min-h-[44px] max-h-[120px] resize-none focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Send a message… type / for templates"
              rows={1}
              value={input}
              onChange={(e) => {
                const newVal = e.target.value;
                setInput(newVal);
                // Reset autocomplete selection when the filtered list changes
                const prev = getSlashFilteredTemplates(input, templates);
                const next = getSlashFilteredTemplates(newVal, templates);
                if (prev.length !== next.length) setAcIndex(0);
              }}
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

      {/* Delete confirmation dialog */}
      <SessionDeleteDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDelete}
        sessionTitle={owner && repo ? `${owner}/${repo} session` : null}
        isDeleting={isDeleting}
      />

      {/* Provider picker */}
      <ProviderPickerDialog
        open={providerPickerOpen}
        onOpenChange={setProviderPickerOpen}
        currentProvider={provider}
        onSelect={(p) => void handleProviderSelect(p)}
      />

      {/* Model picker */}
      <ModelPickerDialog
        open={modelPickerOpen}
        onOpenChange={setModelPickerOpen}
        provider={provider}
        currentModel={model}
        onSelect={(m) => void handleModelSelect(m)}
      />

      {/* Thinking level picker */}
      <ThinkingLevelPickerDialog
        open={thinkingPickerOpen}
        onOpenChange={setThinkingPickerOpen}
        currentLevel={thinkingLevel}
        onSelect={handleThinkingSelect}
        supportsXhigh={modelSupportsXhigh}
      />
    </div>
  );
}
