/**
 * Zustand store for user settings.
 *
 * Initializes with defaults so hotkeys work immediately.
 * Fetches user-specific overrides from the API on mount.
 */

import { create } from "zustand";
import { DEFAULT_USER_SETTINGS, type UserSettings, type ThinkingLevel } from "@zero/core";

interface SettingsStore {
  settings: UserSettings;
  loading: boolean;

  /** Fetch settings from the API. Merges with defaults. */
  fetchSettings: (getToken: () => Promise<string | null>) => Promise<void>;

  /** Update the hotkey prefix and persist to the API. */
  updateHotkeyPrefix: (
    getToken: () => Promise<string | null>,
    value: string,
  ) => Promise<void>;

  /** Update a single hotkey binding (actionId → key) and persist to the API. */
  updateHotkeyBinding: (
    getToken: () => Promise<string | null>,
    actionId: string,
    key: string,
  ) => Promise<void>;

  /** Clear a hotkey binding (unbind an action) and persist to the API. */
  clearHotkeyBinding: (
    getToken: () => Promise<string | null>,
    actionId: string,
  ) => Promise<void>;

  /** Update the default provider for new sessions. null clears the setting. */
  updateDefaultProvider: (
    getToken: () => Promise<string | null>,
    value: string | null,
  ) => Promise<void>;

  /** Update the default model for new sessions. null clears the setting. */
  updateDefaultModel: (
    getToken: () => Promise<string | null>,
    value: string | null,
  ) => Promise<void>;

  /** Update the default thinking level for new sessions. null clears the setting. */
  updateDefaultThinkingLevel: (
    getToken: () => Promise<string | null>,
    value: ThinkingLevel | null,
  ) => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
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
    const prev = get().settings.hotkeyPrefix;
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
          settings: { ...state.settings, hotkeyPrefix: prev },
        }));
      }
    } catch {
      // Revert on error
      set((state) => ({
        settings: { ...state.settings, hotkeyPrefix: prev },
      }));
    }
  },

  updateHotkeyBinding: async (getToken, actionId, key) => {
    const prevBindings = { ...get().settings.hotkeyBindings };
    // Optimistic update
    set((state) => ({
      settings: {
        ...state.settings,
        hotkeyBindings: { ...state.settings.hotkeyBindings, [actionId]: key },
      },
    }));

    try {
      const token = await getToken();
      const resp = await fetch("/api/settings", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ hotkeyBindings: { [actionId]: key } }),
      });
      if (!resp.ok) {
        // Revert on failure
        set((state) => ({
          settings: { ...state.settings, hotkeyBindings: prevBindings },
        }));
      }
    } catch {
      // Revert on error
      set((state) => ({
        settings: { ...state.settings, hotkeyBindings: prevBindings },
      }));
    }
  },

  clearHotkeyBinding: async (getToken, actionId) => {
    const prevBindings = { ...get().settings.hotkeyBindings };
    // Optimistic update — remove the key
    set((state) => {
      const next = { ...state.settings.hotkeyBindings };
      delete next[actionId];
      return { settings: { ...state.settings, hotkeyBindings: next } };
    });

    try {
      const token = await getToken();
      const resp = await fetch("/api/settings", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ hotkeyBindings: { [actionId]: null } }),
      });
      if (!resp.ok) {
        set((state) => ({
          settings: { ...state.settings, hotkeyBindings: prevBindings },
        }));
      }
    } catch {
      set((state) => ({
        settings: { ...state.settings, hotkeyBindings: prevBindings },
      }));
    }
  },

  updateDefaultProvider: async (getToken, value) => {
    const prev = get().settings.defaultProvider;
    set((state) => ({
      settings: { ...state.settings, defaultProvider: value },
    }));

    try {
      const token = await getToken();
      const resp = await fetch("/api/settings", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ defaultProvider: value }),
      });
      if (!resp.ok) {
        set((state) => ({
          settings: { ...state.settings, defaultProvider: prev },
        }));
      }
    } catch {
      set((state) => ({
        settings: { ...state.settings, defaultProvider: prev },
      }));
    }
  },

  updateDefaultModel: async (getToken, value) => {
    const prev = get().settings.defaultModel;
    set((state) => ({
      settings: { ...state.settings, defaultModel: value },
    }));

    try {
      const token = await getToken();
      const resp = await fetch("/api/settings", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ defaultModel: value }),
      });
      if (!resp.ok) {
        set((state) => ({
          settings: { ...state.settings, defaultModel: prev },
        }));
      }
    } catch {
      set((state) => ({
        settings: { ...state.settings, defaultModel: prev },
      }));
    }
  },

  updateDefaultThinkingLevel: async (getToken, value) => {
    const prev = get().settings.defaultThinkingLevel;
    set((state) => ({
      settings: { ...state.settings, defaultThinkingLevel: value },
    }));

    try {
      const token = await getToken();
      const resp = await fetch("/api/settings", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ defaultThinkingLevel: value }),
      });
      if (!resp.ok) {
        set((state) => ({
          settings: { ...state.settings, defaultThinkingLevel: prev },
        }));
      }
    } catch {
      set((state) => ({
        settings: { ...state.settings, defaultThinkingLevel: prev },
      }));
    }
  },
}));
