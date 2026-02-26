/**
 * User-level WebSocket hook for real-time push events.
 *
 * Opens a single WebSocket to /api/ws on mount (one per browser tab).
 * Handles session_status messages by updating the zustand session store.
 * Reconnects automatically on unexpected disconnect.
 *
 * Mount once at the Layout level so it lives for the entire app session.
 */

import { useEffect, useRef } from "react";
import { useAuth } from "@clerk/clerk-react";
import { useSessionStore } from "./session-store";
import type { UserServerMessage } from "@zero/core";

export function useUserWebSocket() {
  const { getToken } = useAuth();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    const connect = async () => {
      if (!mountedRef.current) return;

      const token = await getToken();
      if (!token || !mountedRef.current) return;

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
        if (e.code !== 1000 && mountedRef.current) {
          reconnectTimerRef.current = setTimeout(() => {
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
      mountedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close(1000, "unmounting");
        wsRef.current = null;
      }
    };
  }, [getToken]);
}
