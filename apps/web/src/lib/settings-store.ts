/**
 * Zustand store for user settings.
 *
 * Initializes with defaults so hotkeys work immediately.
 * Fetches user-specific overrides from the API on mount.
 */

import { create } from "zustand";
import { DEFAULT_USER_SETTINGS, type UserSettings } from "@zero/core";

interface SettingsStore {
  settings: UserSettings;
  loading: boolean;

  /** Fetch settings from the API. Merges with defaults. */
  fetchSettings: (getToken: () => Promise<string | null>) => Promise<void>;

  /** Update a single setting optimistically and persist to the API. */
  updateHotkeyPrefix: (
    getToken: () => Promise<string | null>,
    value: string,
  ) => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  settings: { ...DEFAULT_USER_SETTINGS },
  loading: true,

  fetchSettings: async (getToken) => {
    try {
      const token = await getToken();
      const resp = await fetch("/api/settings", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) {
        const data = (await resp.json()) as { settings: UserSettings };
        set({ settings: data.settings });
      }
    } catch {
      // Keep defaults on fetch error
    } finally {
      set({ loading: false });
    }
  },

  updateHotkeyPrefix: async (getToken, value) => {
    // Optimistic update
    set((state) => ({
      settings: { ...state.settings, hotkeyPrefix: value },
    }));

    try {
      const token = await getToken();
      const resp = await fetch("/api/settings", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ hotkeyPrefix: value }),
      });
      if (!resp.ok) {
        // Revert on failure
        set((state) => ({
          settings: { ...state.settings, hotkeyPrefix: DEFAULT_USER_SETTINGS.hotkeyPrefix },
        }));
      }
    } catch {
      // Revert on error
      set((state) => ({
        settings: { ...state.settings, hotkeyPrefix: DEFAULT_USER_SETTINGS.hotkeyPrefix },
      }));
    }
  },
}));
