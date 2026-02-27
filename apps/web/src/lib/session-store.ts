/**
 * Zustand store for the user's session list.
 *
 * Shared between Sidebar, DashboardPage, and any component that needs
 * the session list. Status updates are pushed in real-time via the
 * user-level WebSocket (see use-user-websocket.ts).
 */

import { create } from "zustand";
import type { SessionStatus } from "@zero/core";

export interface SessionEntry {
  id: string;
  owner: string;
  repo: string;
  title: string;
  status: string;
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

interface SessionStore {
  sessions: SessionEntry[];
  loading: boolean;

  /** Fetch the session list from the API. Optionally filter by project. */
  fetchSessions: (getToken: () => Promise<string | null>, filter?: { owner: string; repo: string }) => Promise<void>;

  /** Add a session to the local list (from WebSocket push). No-op if already present. */
  addSession: (session: SessionEntry) => void;

  /** Patch a single session's status in-place (from WebSocket push). */
  updateSessionStatus: (sessionId: string, status: SessionStatus) => void;

  /** Remove a session from the local list (after delete). */
  removeSession: (sessionId: string) => void;
}

export const useSessionStore = create<SessionStore>((set) => ({
  sessions: [],
  loading: true,

  fetchSessions: async (getToken, filter) => {
    try {
      const token = await getToken();
      let url = "/api/sessions";
      if (filter) {
        url += `?owner=${encodeURIComponent(filter.owner)}&repo=${encodeURIComponent(filter.repo)}`;
      }
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) {
        const data = (await resp.json()) as { sessions: SessionEntry[] };
        set({ sessions: data.sessions });
      }
    } catch {
      // Ignore fetch errors — keep stale data
    } finally {
      set({ loading: false });
    }
  },

  addSession: (session) => {
    set((state) => {
      if (state.sessions.some((s) => s.id === session.id)) return state;
      return { sessions: [session, ...state.sessions] };
    });
  },

  updateSessionStatus: (sessionId, status) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, status } : s
      ),
    }));
  },

  removeSession: (sessionId) => {
    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== sessionId),
    }));
  },
}));
