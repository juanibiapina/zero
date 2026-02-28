/**
 * Managed WebSocket connection with auto-reconnect and async auth.
 *
 * Encapsulates the tricky async-cleanup pattern needed for WebSocket
 * connections in React. The core issue: when connecting requires an async
 * step (e.g. `await getToken()`), cleanup during React StrictMode's
 * mount→cleanup→mount cycle runs while the token fetch is still pending.
 * A local `cancelled` flag (scoped per connection instance, not shared
 * via ref) prevents orphaned WebSockets from being created after cleanup.
 *
 * Usage in a React effect:
 * ```ts
 * useEffect(() => {
 *   const conn = createManagedWebSocket({ ... });
 *   return () => conn.close();
 * }, [deps]);
 * ```
 */

export interface ManagedWebSocket {
  /** Send data if connected. Returns true if sent, false otherwise. */
  send(data: string): boolean;
  /** Close the connection permanently and stop reconnecting. */
  close(): void;
}

export interface ManagedWebSocketOptions {
  /** Async function to get an auth token (e.g. Clerk's `getToken`). */
  getToken: () => Promise<string | null>;
  /** URL path segment after `/api/` — token is appended as `?token=...`. */
  path: string;
  /** Called when the WebSocket opens (fires on each connect/reconnect). */
  onOpen?: () => void;
  /** Called for each incoming message. */
  onMessage: (event: MessageEvent) => void;
  /** Called when the WebSocket closes (before any reconnect attempt). */
  onClose?: () => void;
  /** Called when `getToken()` throws (only if not already cancelled). */
  onTokenError?: () => void;
  /** If set, sends `{"type":"ping"}` at this interval (ms) while connected. */
  pingIntervalMs?: number;
}

export function createManagedWebSocket(
  opts: ManagedWebSocketOptions,
): ManagedWebSocket {
  let cancelled = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingInterval: ReturnType<typeof setInterval> | null = null;

  async function connect() {
    if (cancelled) return;

    // Clear any prior ping interval (relevant on reconnect)
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }

    let token: string | null;
    try {
      token = await opts.getToken();
    } catch {
      if (!cancelled) opts.onTokenError?.();
      return;
    }
    if (cancelled || !token) return;

    // Close any prior WS before creating a new one
    if (ws) {
      ws.close(1000, "reconnecting");
      ws = null;
    }

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${location.host}/api/${opts.path}?token=${token}`;

    ws = new WebSocket(url);

    ws.onopen = () => {
      if (opts.pingIntervalMs) {
        pingInterval = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, opts.pingIntervalMs);
      }
      opts.onOpen?.();
    };

    ws.onmessage = opts.onMessage;

    ws.onclose = (e) => {
      ws = null;
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }
      opts.onClose?.();
      // Reconnect on unexpected close (not clean 1000)
      if (e.code !== 1000 && !cancelled) {
        reconnectTimer = setTimeout(() => void connect(), 2000);
      }
    };

    ws.onerror = () => {
      // onclose will fire after this
    };
  }

  void connect();

  return {
    send(data: string): boolean {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(data);
        return true;
      }
      return false;
    },
    close() {
      cancelled = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }
      if (ws) {
        ws.close(1000, "cleanup");
        ws = null;
      }
    },
  };
}
