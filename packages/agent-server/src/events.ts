/**
 * EventBuffer — In-memory append-only event buffer with WebSocket broadcasting.
 *
 * Supports multiple concurrent WebSocket clients. Each client can replay
 * from a specific sequence number and receive live events.
 */

import type { WebSocket as WsWebSocket } from "ws";
import type { EventEnvelope } from "./types.js";

export class EventBuffer {
  private _events: EventEnvelope[] = [];
  private _seq = 0;
  private _wsClients = new Set<WsWebSocket>();

  /**
   * Add an event to the buffer and broadcast to all WebSocket clients.
   */
  addEvent(event: unknown): EventEnvelope {
    const envelope: EventEnvelope = {
      seq: ++this._seq,
      event,
      timestamp: new Date().toISOString(),
    };
    this._events.push(envelope);

    const json = JSON.stringify(envelope);
    for (const ws of this._wsClients) {
      try {
        ws.send(json);
      } catch {
        this._wsClients.delete(ws);
      }
    }
    return envelope;
  }

  /**
   * Get all events after a given sequence number.
   */
  getEventsAfter(afterSeq: number): EventEnvelope[] {
    return this._events.filter((e) => e.seq > afterSeq);
  }

  /**
   * Current highest sequence number (0 if empty).
   */
  get lastSeq(): number {
    return this._seq;
  }

  /**
   * Register a WebSocket client for live event broadcasting.
   * Replays buffered events after `afterSeq` as JSON messages.
   */
  registerWebSocket(ws: WsWebSocket, afterSeq = 0): void {
    const missed = this.getEventsAfter(afterSeq);
    for (const envelope of missed) {
      try {
        ws.send(JSON.stringify(envelope));
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
   * Reset events and sequence counter but keep WebSocket clients registered.
   * Used during session resume — the WS connection is still valid.
   */
  reset(): void {
    this._events = [];
    this._seq = 0;
  }

  /**
   * Clear all events, reset sequence counter, and remove all clients.
   * Used for brand-new sessions where no prior state should survive.
   */
  clear(): void {
    this._events = [];
    this._seq = 0;
    this._wsClients.clear();
  }
}
