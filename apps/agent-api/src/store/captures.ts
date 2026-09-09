// The GTD Captures list, standalone from the agent's Store on purpose so it does
// not widen the agent's interface.

import { asc, desc, eq, isNull, type Database } from "do-orm";
import { generateKeyBetween } from "fractional-indexing";

import { captures } from "../UserDO/db/schema";

export interface Capture {
  id: string;
  text: string;
  createdAt: string;
  processedAt: string | null;
  // Local day (YYYY-MM-DD) the capture reappears on, or null for a plain,
  // always-visible capture.
  showUpDate: string | null;
  // Fractional-index sort key for the manual list order, or null (unkeyed,
  // sorts last). In practice every stored row is keyed (add mints, reorder sets,
  // backfill keys legacy rows on DO init); null is only a transient pre-backfill
  // legacy state. See schema.ts / migration 0045.
  sortKey: string | null;
}

// Project a stored row back to the client-facing Capture shape.
function toCapture(row: {
  id: string;
  text: string;
  createdAt: string;
  processedAt: string | null;
  showUpDate: string | null;
  sortKey: string | null;
}): Capture {
  return {
    id: row.id,
    text: row.text,
    createdAt: row.createdAt,
    processedAt: row.processedAt,
    showUpDate: row.showUpDate,
    sortKey: row.sortKey,
  };
}

// The manual list order: by sortKey ascending, NULLs last, createdAt ascending
// as the tiebreak. sortKey is compared by raw codepoint (not localeCompare):
// fractional-indexing's base-62 charset (0-9A-Za-z) sorts by ASCII order, but
// localeCompare folds case (A ≈ a) and would corrupt the key sequence. The
// createdAt tiebreak keeps localeCompare (ISO strings are digit-only). This is
// the SAME rule as agent-core's compareByOrder (duplicated, not imported, so
// agent-api gains no build coupling to the browser/RN package) — keep the two
// in lockstep. NULLs sort last here too so a stray/legacy unkeyed row degrades
// gracefully (falls to the bottom) instead of misordering.
function byOrder(a: Capture, b: Capture): number {
  if (a.sortKey == null && b.sortKey == null) {
    return a.createdAt.localeCompare(b.createdAt);
  }
  if (a.sortKey == null) return 1;
  if (b.sortKey == null) return -1;
  if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? -1 : 1;
  return a.createdAt.localeCompare(b.createdAt);
}

export class DbCaptureStore {
  constructor(private db: Database) {}

  // The client mints the capture id, so the add is exactly-once on the id alone:
  // a replay (a retried write after a lost ACK) re-sends the same id and gets the
  // already-stored row back instead of inserting a second one.
  add(id: string, text: string): Capture {
    const existingById = this.db.get(captures, { where: eq("id", id) });
    if (existingById) return toCapture(existingById);
    // Mint the trailing key: read the current max sortKey and generate one after
    // it, so a new capture appends to the bottom of the manual order.
    const max = this.db.get(captures, { orderBy: desc("sortKey") });
    const capture: Capture = {
      id,
      text,
      createdAt: new Date().toISOString(),
      processedAt: null,
      showUpDate: null,
      sortKey: generateKeyBetween(max?.sortKey ?? null, null),
    };
    this.db.insert(captures, capture);
    return capture;
  }

  // Every open capture (processedAt IS NULL), in manual order. Future-dated rows
  // are included: the client splits the open set into Captures (rows that have
  // shown up) and Upcoming (future-dated rows), so visibility is a client
  // concern and the server returns the whole open list.
  list(): Capture[] {
    return this.db
      .all(captures, {
        where: isNull("processedAt"),
        orderBy: asc("createdAt"),
      })
      .map(toCapture)
      .sort(byOrder);
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

  // The inverse of process: clear processedAt so the capture returns to the
  // inbox. Backs the capture-complete Undo. Idempotent on the id; returns the
  // updated row, or null when no row has that id.
  unprocess(id: string): Capture | null {
    this.db.update(captures, { processedAt: null }, { where: eq("id", id) });
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

  // Set a capture's manual sort key. Same-key idempotent update on the stable
  // id, like reschedule. The client mints the key strictly between the drop
  // position's two neighbors, so this only writes the moved row. Returns the
  // updated row, or null when no row has that id.
  reorder(id: string, sortKey: string): Capture | null {
    this.db.update(captures, { sortKey }, { where: eq("id", id) });
    const row = this.db.get(captures, { where: eq("id", id) });
    return row ? toCapture(row) : null;
  }

  // One-shot backfill of sort keys for rows that predate the column (sortKey IS
  // NULL). Assigns sequential fractional keys in createdAt order, so the list's
  // manual order starts out matching the old oldest-first order. Idempotent:
  // after the first run no NULL rows remain, so a second call is a cheap empty
  // select. Called from the UserDO constructor's init block. Keys every NULL
  // row regardless of processedAt, so an unprocessed capture already has a key.
  backfillSortKeys(): void {
    const rows = this.db.all(captures, {
      where: isNull("sortKey"),
      orderBy: asc("createdAt"),
    });
    let prev: string | null = null;
    for (const row of rows) {
      prev = generateKeyBetween(prev, null);
      this.db.update(captures, { sortKey: prev }, { where: eq("id", row.id) });
    }
  }
}
