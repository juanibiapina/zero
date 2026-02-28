/**
 * User-level WebSocket hook for real-time push events.
 *
 * Opens a single WebSocket to /api/ws on mount (one per browser tab).
 * Handles session_status messages by updating the zustand session store.
 * Reconnects automatically on unexpected disconnect.
 *
 * Mount once at the Layout level so it lives for the entire app session.
 *
 * Uses a local `cancelled` flag (not a ref) to prevent orphaned WebSocket
 * connections in React StrictMode. A ref is shared across mounts, so mount 2
 * overwrites the flag set by cleanup 1. A local variable is scoped per effect
 * invocation, so each cleanup correctly marks only its own instance as stale.
 */

import { useEffect, useRef } from "react";
import { useAuth } from "@clerk/clerk-react";
import { useSessionStore } from "./session-store";
import type { UserServerMessage } from "@zero/core";

export function useUserWebSocket() {
  const { getToken } = useAuth();
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = async () => {
      if (cancelled) return;

      const token = await getToken();
      if (!token || cancelled) return;

      // Close any prior WS before creating a new one
      if (wsRef.current) {
        wsRef.current.close(1000, "reconnecting");
        wsRef.current = null;
      }

      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${location.host}/api/ws?token=${token}`;

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onmessage = (e) => {
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
              // Handled by server auto-response; ignore if received
              break;
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.onclose = (e) => {
        wsRef.current = null;
        // Reconnect on unexpected close
        if (e.code !== 1000 && !cancelled) {
          reconnectTimer = setTimeout(() => {
            void connect();
          }, 2000);
        }
      };

      ws.onerror = () => {
        // onclose will fire after this
      };
    };

    void connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (wsRef.current) {
        wsRef.current.close(1000, "unmounting");
        wsRef.current = null;
      }
    };
  }, [getToken]);
}
