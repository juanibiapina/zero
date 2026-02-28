import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@clerk/clerk-react";
import {
  useHotkeyRecorder,
  formatForDisplay,
  validateHotkey,
  hasNonModifierKey,
} from "@tanstack/react-hotkeys";
import type { Hotkey } from "@tanstack/react-hotkeys";
import { Settings, Keyboard, Bot, Loader2 } from "lucide-react";
import { APP_ACTIONS, THINKING_LEVELS, type AppAction, type ThinkingLevel, type ProviderInfo } from "@zero/core";
import { useSettingsStore } from "@/lib/settings-store";
import { cn } from "@/lib/utils";
import { jsonBody } from "@/lib/api";

function HotkeyBadge({ hotkey }: { hotkey: string }) {
  return (
    <kbd className="inline-flex items-center rounded border bg-muted px-2 py-1 font-mono text-sm">
      {formatForDisplay(hotkey)}
    </kbd>
  );
}

// ── Prefix recorder (unchanged from before) ─────────────────────────────

function PrefixRecorder() {
  const { getToken } = useAuth();
  const prefix = useSettingsStore((s) => s.settings.hotkeyPrefix);
  const updateHotkeyPrefix = useSettingsStore((s) => s.updateHotkeyPrefix);

  const [error, setError] = useState<string | null>(null);

  const recorder = useHotkeyRecorder({
    onRecord: (hotkey: Hotkey) => {
      setError(null);

      const validation = validateHotkey(hotkey);
      if (!validation.valid) {
        setError(validation.errors.join(", "));
        return;
      }
      if (!hasNonModifierKey(hotkey)) {
        setError("Prefix must include a non-modifier key (e.g. Space, period)");
        return;
      }

      void updateHotkeyPrefix(getToken, hotkey);
    },
    onCancel: () => {
      setError(null);
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-muted-foreground w-28">
          Prefix key
        </span>
        {recorder.isRecording ? (
          <div
            className={cn(
              "inline-flex items-center rounded border-2 border-primary bg-muted px-3 py-1.5 font-mono text-sm",
              "animate-pulse",
            )}
          >
            {recorder.recordedHotkey
              ? formatForDisplay(recorder.recordedHotkey)
              : "Press keys…"}
          </div>
        ) : (
          <HotkeyBadge hotkey={prefix} />
        )}

        {recorder.isRecording ? (
          <button
            onClick={() => recorder.cancelRecording()}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted transition-colors"
          >
            Cancel
          </button>
        ) : (
          <button
            onClick={() => {
              setError(null);
              recorder.startRecording();
            }}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted transition-colors"
          >
            Change
          </button>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {recorder.isRecording && (
        <p className="text-xs text-muted-foreground">
          Press the key combination you want as your prefix, or{" "}
          <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">
            Esc
          </kbd>{" "}
          to cancel.
        </p>
      )}
    </div>
  );
}

// ── Per-action binding recorder ──────────────────────────────────────────

function ActionBindingRow({ action }: { action: AppAction }) {
  const { getToken } = useAuth();
  const bindings = useSettingsStore((s) => s.settings.hotkeyBindings);
  const prefix = useSettingsStore((s) => s.settings.hotkeyPrefix);
  const updateHotkeyBinding = useSettingsStore((s) => s.updateHotkeyBinding);
  const clearHotkeyBinding = useSettingsStore((s) => s.clearHotkeyBinding);

  const currentKey: string | undefined = bindings[action.id];
  const isBound = currentKey != null;

  const [error, setError] = useState<string | null>(null);

  const recorder = useHotkeyRecorder({
    onRecord: (hotkey: Hotkey) => {
      setError(null);

      const validation = validateHotkey(hotkey);
      if (!validation.valid) {
        setError(validation.errors.join(", "));
        return;
      }

      // Check for duplicate bindings across all actions
      const duplicate = APP_ACTIONS.find(
        (a) => a.id !== action.id && bindings[a.id] === hotkey,
      );
      if (duplicate) {
        setError(`"${hotkey}" is already bound to "${duplicate.label}"`);
        return;
      }

      void updateHotkeyBinding(getToken, action.id, hotkey);
    },
    onCancel: () => {
      setError(null);
    },
  });

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-sm">
        <HotkeyBadge hotkey={prefix} />
        <span className="text-muted-foreground">→</span>
        {recorder.isRecording ? (
          <div
            className={cn(
              "inline-flex items-center rounded border-2 border-primary bg-muted px-2 py-1 font-mono text-sm",
              "animate-pulse",
            )}
          >
            {recorder.recordedHotkey
              ? formatForDisplay(recorder.recordedHotkey)
              : "Press key…"}
          </div>
        ) : isBound ? (
          <HotkeyBadge hotkey={currentKey} />
        ) : (
          <span className="inline-flex items-center rounded border border-dashed px-2 py-1 font-mono text-sm text-muted-foreground">
            Unbound
          </span>
        )}
        <span className="text-muted-foreground">{action.label}</span>

        <div className="ml-auto flex items-center gap-1">
          {recorder.isRecording ? (
            <button
              onClick={() => recorder.cancelRecording()}
              className="rounded-md border px-2 py-1 text-xs hover:bg-muted transition-colors"
            >
              Cancel
            </button>
          ) : (
            <>
              {isBound && (
                <button
                  onClick={() => {
                    setError(null);
                    void clearHotkeyBinding(getToken, action.id);
                  }}
                  className="rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-muted transition-colors"
                >
                  Clear
                </button>
              )}
              <button
                onClick={() => {
                  setError(null);
                  recorder.startRecording();
                }}
                className="rounded-md border px-2 py-1 text-xs hover:bg-muted transition-colors"
              >
                {isBound ? "Change" : "Bind"}
              </button>
            </>
          )}
        </div>
      </div>
      {error && <p className="text-xs text-destructive mt-1">{error}</p>}
    </div>
  );
}

// ── Session defaults ─────────────────────────────────────────────────────

interface ModelInfo {
  id: string;
  name: string;
  reasoning: boolean;
}

function SessionDefaults() {
  const { getToken } = useAuth();
  const defaultProvider = useSettingsStore((s) => s.settings.defaultProvider);
  const defaultModel = useSettingsStore((s) => s.settings.defaultModel);
  const defaultThinkingLevel = useSettingsStore((s) => s.settings.defaultThinkingLevel);
  const updateDefaultProvider = useSettingsStore((s) => s.updateDefaultProvider);
  const updateDefaultModel = useSettingsStore((s) => s.updateDefaultModel);
  const updateDefaultThinkingLevel = useSettingsStore((s) => s.updateDefaultThinkingLevel);

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [loadingModels, setLoadingModels] = useState(false);

  // Fetch connected providers on mount
  useEffect(() => {
    void (async () => {
      try {
        const token = await getToken();
        const resp = await fetch("/api/providers", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await jsonBody<{ providers?: ProviderInfo[] }>(resp);
        setProviders((data.providers ?? []).filter((p) => p.connected));
      } catch {
        // leave empty
      } finally {
        setLoadingProviders(false);
      }
    })();
  }, [getToken]);

  // Fetch models when provider changes
  useEffect(() => {
    if (!defaultProvider) {
      setModels([]);
      return;
    }
    void (async () => {
      setLoadingModels(true);
      try {
        const token = await getToken();
        const resp = await fetch(`/api/providers/${defaultProvider}/models`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await jsonBody<{ models?: ModelInfo[] }>(resp);
        setModels(data.models ?? []);
      } catch {
        setModels([]);
      } finally {
        setLoadingModels(false);
      }
    })();
  }, [defaultProvider, getToken]);

  const selectedModelInfo = models.find((m) => m.id === defaultModel);
  const showThinkingLevel = defaultProvider && defaultModel && selectedModelInfo?.reasoning;

  const handleProviderChange = useCallback(
    (value: string) => {
      if (value === "") {
        void updateDefaultProvider(getToken, null);
        void updateDefaultModel(getToken, null);
        void updateDefaultThinkingLevel(getToken, null);
      } else {
        void updateDefaultProvider(getToken, value);
        // Clear model & thinking when provider changes
        void updateDefaultModel(getToken, null);
        void updateDefaultThinkingLevel(getToken, null);
      }
    },
    [getToken, updateDefaultProvider, updateDefaultModel, updateDefaultThinkingLevel],
  );

  const handleModelChange = useCallback(
    (value: string) => {
      if (value === "") {
        void updateDefaultModel(getToken, null);
        void updateDefaultThinkingLevel(getToken, null);
      } else {
        void updateDefaultModel(getToken, value);
        // Clear thinking when model changes
        void updateDefaultThinkingLevel(getToken, null);
      }
    },
    [getToken, updateDefaultModel, updateDefaultThinkingLevel],
  );

  const handleThinkingChange = useCallback(
    (value: string) => {
      if (value === "") {
        void updateDefaultThinkingLevel(getToken, null);
      } else {
        void updateDefaultThinkingLevel(getToken, value as ThinkingLevel);
      }
    },
    [getToken, updateDefaultThinkingLevel],
  );

  return (
    <div className="rounded-lg border p-4 space-y-4">
      {/* Provider */}
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-muted-foreground w-28">Provider</span>
        {loadingProviders ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <select
            className="rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            value={defaultProvider ?? ""}
            onChange={(e) => handleProviderChange(e.target.value)}
          >
            <option value="">Auto (first connected)</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Model */}
      {defaultProvider && (
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-muted-foreground w-28">Model</span>
          {loadingModels ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <select
              className="rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={defaultModel ?? ""}
              onChange={(e) => handleModelChange(e.target.value)}
            >
              <option value="">Auto (provider default)</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Thinking level */}
      {showThinkingLevel && (
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-muted-foreground w-28">Thinking</span>
          <select
            className="rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            value={defaultThinkingLevel ?? ""}
            onChange={(e) => handleThinkingChange(e.target.value)}
          >
            <option value="">Auto (based on model)</option>
            {THINKING_LEVELS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label} — {l.description}
              </option>
            ))}
          </select>
        </div>
      )}

      {!defaultProvider && (
        <p className="text-xs text-muted-foreground">
          When set to Auto, new sessions use the first connected provider and its default model.
        </p>
      )}
    </div>
  );
}

// ── Settings page ────────────────────────────────────────────────────────

export default function SettingsPage() {
  return (
    <div className="space-y-8">
      <div className="flex items-center gap-2">
        <Settings className="h-5 w-5" />
        <h1 className="text-2xl font-bold">Settings</h1>
      </div>

      {/* Session defaults */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Session Defaults</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Default provider, model, and thinking level for new sessions.
        </p>
        <SessionDefaults />
      </section>

      {/* Keyboard shortcuts */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Keyboard className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Keyboard Shortcuts</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Shortcuts use a tmux-style prefix: press the prefix key, then the
          action key.
        </p>

        <div className="rounded-lg border p-4 space-y-6">
          <PrefixRecorder />

          <div className="border-t pt-4 space-y-4">
            <h3 className="text-sm font-medium">Shortcuts</h3>
            {Array.from(
              APP_ACTIONS.reduce((map, action) => {
                const list = map.get(action.category) ?? [];
                list.push(action);
                map.set(action.category, list);
                return map;
              }, new Map<string, AppAction[]>()),
            ).map(([category, actions]) => (
              <div key={category} className="space-y-2">
                <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/60">
                  {category}
                </h4>
                <div className="grid gap-3">
                  {actions.map((action) => (
                    <ActionBindingRow key={action.id} action={action} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
