/**
 * useAction — bind a hotkey to a named action using the user's settings.
 *
 * Reads the prefix and per-action key from the settings store and wires
 * them into a TanStack `useHotkeySequence` call. If the action has no
 * binding in settings (shouldn't happen for bindable actions), it's a no-op.
 */

import { useHotkeySequence } from "@tanstack/react-hotkeys";
import type { Hotkey } from "@tanstack/react-hotkeys";
import { useSettingsStore } from "./settings-store";

export function useAction(
  actionId: string,
  callback: () => void,
  options?: { enabled?: boolean },
) {
  const prefix = useSettingsStore((s) => s.settings.hotkeyPrefix) as Hotkey;
  const key = useSettingsStore((s) => s.settings.hotkeyBindings[actionId]) as Hotkey | undefined;

  useHotkeySequence([prefix, (key ?? "UNBOUND") as Hotkey], callback, {
    enabled: (options?.enabled ?? true) && key != null,
  });
}
