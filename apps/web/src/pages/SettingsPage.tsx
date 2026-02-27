import { useState } from "react";
import { useAuth } from "@clerk/clerk-react";
import {
  useHotkeyRecorder,
  formatForDisplay,
  validateHotkey,
  hasNonModifierKey,
} from "@tanstack/react-hotkeys";
import type { Hotkey } from "@tanstack/react-hotkeys";
import { Settings, Keyboard } from "lucide-react";
import { BINDABLE_ACTIONS, type AppAction } from "@zero/core";
import { useSettingsStore } from "@/lib/settings-store";
import { cn } from "@/lib/utils";

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

  const currentKey = bindings[action.id] ?? action.defaultKey ?? "";

  const [error, setError] = useState<string | null>(null);

  const recorder = useHotkeyRecorder({
    onRecord: (hotkey: Hotkey) => {
      setError(null);

      const validation = validateHotkey(hotkey);
      if (!validation.valid) {
        setError(validation.errors.join(", "));
        return;
      }

      // Check for duplicate bindings
      const duplicate = BINDABLE_ACTIONS.find(
        (a) => a.id !== action.id && (bindings[a.id] ?? a.defaultKey) === hotkey,
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
        ) : (
          <HotkeyBadge hotkey={currentKey} />
        )}
        <span className="text-muted-foreground">{action.label}</span>

        {recorder.isRecording ? (
          <button
            onClick={() => recorder.cancelRecording()}
            className="ml-auto rounded-md border px-2 py-1 text-xs hover:bg-muted transition-colors"
          >
            Cancel
          </button>
        ) : (
          <button
            onClick={() => {
              setError(null);
              recorder.startRecording();
            }}
            className="ml-auto rounded-md border px-2 py-1 text-xs hover:bg-muted transition-colors"
          >
            Change
          </button>
        )}
      </div>
      {error && <p className="text-xs text-destructive mt-1">{error}</p>}
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

      {/* Keyboard shortcuts */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Keyboard className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Keyboard Shortcuts</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Shortcuts use a tmux-style prefix: press the prefix key, then the
          action key within 1 second.
        </p>

        <div className="rounded-lg border p-4 space-y-6">
          <PrefixRecorder />

          <div className="border-t pt-4 space-y-3">
            <h3 className="text-sm font-medium">Bound shortcuts</h3>
            <div className="grid gap-3">
              {BINDABLE_ACTIONS.map((action) => (
                <ActionBindingRow key={action.id} action={action} />
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
