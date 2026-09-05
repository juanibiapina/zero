// Waiting conditions: why a project is waiting. A per-entity store like
// DbCaptureStore / DbTaskStore / DbProjectStore (do-orm is the shared layer; a
// store holds only domain verbs). Standalone from the agent's tables. See
// docs/entities/waiting-condition.md.

import { asc, eq, isNull, type Database } from "do-orm";

import { waitingConditions } from "../UserDO/db/schema";

export type WaitingConditionKind = "free-text" | "task-done" | "project-status";

export interface WaitingCondition {
  id: string;
  // The project this condition blocks.
  projectId: string;
  kind: WaitingConditionKind;
  // Prose condition, for kind 'free-text'; null otherwise.
  text: string | null;
  // Referenced task ('task-done') or project ('project-status') id; null for
  // 'free-text'.
  refId: string | null;
  // Target status the referenced project must reach ('project-status'); null
  // otherwise.
  targetStatus: string | null;
  // When a 'free-text' condition was resolved by hand/AI; null while open.
  // Structured kinds never set this (derived-satisfied on the client).
  resolvedAt: string | null;
  createdAt: string;
}

type Row = {
  id: string;
  projectId: string;
  kind: string;
  text: string | null;
  refId: string | null;
  targetStatus: string | null;
  resolvedAt: string | null;
  createdAt: string;
};

function toCondition(row: Row): WaitingCondition {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind as WaitingConditionKind,
    text: row.text,
    refId: row.refId,
    targetStatus: row.targetStatus,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
  };
}

export type WaitingConditionFields = {
  text?: string | null;
  refId?: string | null;
  targetStatus?: string | null;
};

export class DbWaitingConditionStore {
  constructor(private db: Database) {}

  // The client mints the id, so add is exactly-once on the id: a replay re-sends
  // the same id and gets the stored row back instead of inserting a second one.
  add(
    id: string,
    projectId: string,
    kind: WaitingConditionKind,
    fields: WaitingConditionFields = {},
  ): WaitingCondition {
    const existing = this.db.get(waitingConditions, { where: eq("id", id) });
    if (existing) return toCondition(existing);
    const condition: WaitingCondition = {
      id,
      projectId,
      kind,
      text: fields.text ?? null,
      refId: fields.refId ?? null,
      targetStatus: fields.targetStatus ?? null,
      resolvedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.db.insert(waitingConditions, condition);
    return condition;
  }

  // Every open condition (resolvedAt IS NULL), oldest first. Structured kinds
  // stay here (they are derived-satisfied on the client); only resolved
  // free-text conditions drop out. The client filters by project.
  listOpen(): WaitingCondition[] {
    return this.db
      .all(waitingConditions, {
        where: isNull("resolvedAt"),
        orderBy: asc("createdAt"),
      })
      .map(toCondition);
  }

  // Resolve a free-text condition by hand/AI (sets resolvedAt). Idempotent on
  // the id. Returns the updated row, or null when no row has that id.
  resolve(id: string): WaitingCondition | null {
    this.db.update(
      waitingConditions,
      { resolvedAt: new Date().toISOString() },
      { where: eq("id", id) },
    );
    const row = this.db.get(waitingConditions, { where: eq("id", id) });
    return row ? toCondition(row) : null;
  }

  // Permanently remove a condition. Idempotent on the id (a replayed delete of
  // an already-gone row is a no-op). Returns whether a row existed.
  delete(id: string): boolean {
    const existing = this.db.get(waitingConditions, { where: eq("id", id) });
    if (!existing) return false;
    this.db.delete(waitingConditions, { where: eq("id", id) });
    return true;
  }
}
