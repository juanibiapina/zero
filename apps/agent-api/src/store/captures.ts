// The GTD capture Inbox, standalone from the agent's Store on purpose so it does
// not widen the agent's interface.

import { asc, eq, isNull, type Database } from "do-orm";

import { captures } from "../UserDO/db/schema";

export interface Capture {
  id: string;
  text: string;
  createdAt: string;
  processedAt: string | null;
}

// The stored row also carries idempotencyKey; the Capture the client sees never
// does. Project every row back to the clean shape.
function toCapture(row: {
  id: string;
  text: string;
  createdAt: string;
  processedAt: string | null;
}): Capture {
  return {
    id: row.id,
    text: row.text,
    createdAt: row.createdAt,
    processedAt: row.processedAt,
  };
}

export class DbCaptureStore {
  constructor(private db: Database) {}

  // Capturing with an idempotencyKey is exactly-once: a replay of the same key
  // (a retried write after a lost ACK) returns the already-stored row instead of
  // inserting a second one. Without a key, every add is independent.
  add(text: string, idempotencyKey?: string): Capture {
    if (idempotencyKey) {
      const existing = this.db.get(captures, {
        where: eq("idempotencyKey", idempotencyKey),
      });
      if (existing) return toCapture(existing);
    }
    const capture: Capture = {
      id: crypto.randomUUID(),
      text,
      createdAt: new Date().toISOString(),
      processedAt: null,
    };
    this.db.insert(captures, { ...capture, idempotencyKey: idempotencyKey ?? null });
    return capture;
  }

  // The Inbox is the rows where processedAt IS NULL, oldest first.
  list(): Capture[] {
    return this.db
      .all(captures, {
        where: isNull("processedAt"),
        orderBy: asc("createdAt"),
      })
      .map(toCapture);
  }

  // Returns the updated row, or null when no row has that id.
  process(id: string): Capture | null {
    this.db.update(
      captures,
      { processedAt: new Date().toISOString() },
      { where: eq("id", id) },
    );
    const row = this.db.get(captures, { where: eq("id", id) });
    return row ? toCapture(row) : null;
  }
}
