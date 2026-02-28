/**
 * User-level WebSocket hook for real-time push events.
 *
 * Opens a single WebSocket to /api/ws on mount (one per browser tab).
 * Handles session_status messages by updating the zustand session store.
 * Reconnects automatically on unexpected disconnect.
 *
 * Mount once at the Layout level so it lives for the entire app session.
 */

import { useEffect } from "react";
import { useAuth } from "@clerk/clerk-react";
import { createManagedWebSocket } from "./managed-websocket";
import { useSessionStore } from "./session-store";
import type { UserServerMessage } from "@zero/core";

export function useUserWebSocket() {
  const { getToken } = useAuth();

  useEffect(() => {
    const conn = createManagedWebSocket({
      getToken,
      path: "ws",
      onMessage(e) {
        try {
          const msg = JSON.parse(e.data as string) as UserServerMessage;

          switch (msg.type) {
            case "session_status":
              useSessionStore
                .getState()
                .updateSessionStatus(msg.sessionId, msg.status);
              break;

            case "session_created":
              useSessionStore.getState().addSession(msg.session);
              break;

            case "session_deleted":
              useSessionStore.getState().removeSession(msg.sessionId);
              break;

            case "pong":
              break;
          }
        } catch {
          // Ignore parse errors
        }
      },
    });

    return () => conn.close();
  }, [getToken]);
}
