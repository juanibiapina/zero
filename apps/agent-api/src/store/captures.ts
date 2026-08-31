// The GTD Captures list, standalone from the agent's Store on purpose so it does
// not widen the agent's interface.

import { asc, eq, isNull, type Database } from "do-orm";

import { captures } from "../UserDO/db/schema";

export interface Capture {
  id: string;
  text: string;
  createdAt: string;
  processedAt: string | null;
  // Local day (YYYY-MM-DD) the capture reappears on, or null for a plain,
  // always-visible capture.
  showUpDate: string | null;
}

// Project a stored row back to the client-facing Capture shape.
function toCapture(row: {
  id: string;
  text: string;
  createdAt: string;
  processedAt: string | null;
  showUpDate: string | null;
}): Capture {
  return {
    id: row.id,
    text: row.text,
    createdAt: row.createdAt,
    processedAt: row.processedAt,
    showUpDate: row.showUpDate,
  };
}

// A capture is visible on `today` when it has no show-up date or that date has
// arrived. do-orm has no `or` operator, so this predicate runs in memory over
// the open-captures query (one user's list, tens of rows). Kept here rather than
// imported from agent-core so agent-api gains no build coupling to a browser/RN
// package for a two-line rule.
function isVisible(row: Capture, today: string): boolean {
  return row.showUpDate === null || row.showUpDate <= today;
}

export class DbCaptureStore {
  constructor(private db: Database) {}

  // The client mints the capture id, so the add is exactly-once on the id alone:
  // a replay (a retried write after a lost ACK) re-sends the same id and gets the
  // already-stored row back instead of inserting a second one.
  add(id: string, text: string): Capture {
    const existingById = this.db.get(captures, { where: eq("id", id) });
    if (existingById) return toCapture(existingById);
    const capture: Capture = {
      id,
      text,
      createdAt: new Date().toISOString(),
      processedAt: null,
      showUpDate: null,
    };
    this.db.insert(captures, capture);
    return capture;
  }

  // The visible open captures for `today`, oldest first: rows where processedAt
  // IS NULL and (showUpDate IS NULL OR showUpDate <= today). The date predicate
  // is applied in memory (do-orm has no `or`); `today` is the user's local day,
  // computed by the DO from their timezone.
  list(today: string): Capture[] {
    return this.db
      .all(captures, {
        where: isNull("processedAt"),
        orderBy: asc("createdAt"),
      })
      .map(toCapture)
      .filter((row) => isVisible(row, today));
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

  // Replace a capture's text. Same-key idempotent update (the client-minted id is
  // the primary key), so a replayed edit re-applies the same text harmlessly.
  // Only text changes; createdAt/processedAt and list position are untouched.
  // Returns the updated row, or null when no row has that id.
  editText(id: string, text: string): Capture | null {
    this.db.update(captures, { text }, { where: eq("id", id) });
    const row = this.db.get(captures, { where: eq("id", id) });
    return row ? toCapture(row) : null;
  }

  // Set (or clear, with null) a capture's show-up date. Same-key idempotent
  // update on the stable id, like editText. A future date hides the capture
  // until its day; null makes it always visible again. Returns the updated row,
  // or null when no row has that id.
  reschedule(id: string, showUpDate: string | null): Capture | null {
    this.db.update(captures, { showUpDate }, { where: eq("id", id) });
    const row = this.db.get(captures, { where: eq("id", id) });
    return row ? toCapture(row) : null;
  }
}
