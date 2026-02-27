/**
 * EventBuffer — In-memory append-only event buffer with WebSocket broadcasting.
 *
 * Supports multiple concurrent WebSocket clients. Each client can replay
 * buffered events and receive live events. No sequence numbering — the
 * persistent sequence is managed by SessionDO.
 */

import type { WebSocket as WsWebSocket } from "ws";

export interface BufferedEvent {
  event: unknown;
  timestamp: string;
}

export class EventBuffer {
  private _events: BufferedEvent[] = [];
  private _wsClients = new Set<WsWebSocket>();

  /**
   * Add an event to the buffer and broadcast to all WebSocket clients.
   */
  addEvent(event: unknown): BufferedEvent {
    const buffered: BufferedEvent = {
      event,
      timestamp: new Date().toISOString(),
    };
    this._events.push(buffered);

    const json = JSON.stringify(buffered);
    for (const ws of this._wsClients) {
      try {
        ws.send(json);
      } catch {
        this._wsClients.delete(ws);
      }
    }
    return buffered;
  }

  /**
   * Register a WebSocket client for live event broadcasting.
   * Replays all buffered events as JSON messages.
   */
  registerWebSocket(ws: WsWebSocket): void {
    for (const buffered of this._events) {
      try {
        ws.send(JSON.stringify(buffered));
      } catch {
        return;
      }
    }
    this._wsClients.add(ws);
  }

  /**
   * Unregister a WebSocket client.
   */
  unregisterWebSocket(ws: WsWebSocket): void {
    this._wsClients.delete(ws);
  }

  /**
   * Reset events but keep WebSocket clients registered.
   * Used during session resume — the WS connection is still valid.
   */
  reset(): void {
    this._events = [];
  }

  /**
   * Clear all events and remove all clients.
   * Used for brand-new sessions where no prior state should survive.
   */
  clear(): void {
    this._events = [];
    this._wsClients.clear();
  }
}
