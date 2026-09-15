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
  // When a free-text wait was resolved or a project-completion dependency was
  // terminally settled; null while open. Other structured kinds stay derived.
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

export function isProjectCompletionDependency(
  condition: WaitingCondition,
): boolean {
  return (
    condition.kind === "project-status" &&
    condition.targetStatus === "done" &&
    condition.refId != null
  );
}

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

  addProjectDependency(
    id: string,
    dependentProjectId: string,
    prerequisiteProjectId: string,
  ): WaitingCondition {
    return this.add(id, dependentProjectId, "project-status", {
      refId: prerequisiteProjectId,
      targetStatus: "done",
    });
  }

  listOpenProjectDependencies(): WaitingCondition[] {
    return this.listOpen().filter(isProjectCompletionDependency);
  }

  get(id: string): WaitingCondition | null {
    const row = this.db.get(waitingConditions, { where: eq("id", id) });
    return row ? toCondition(row) : null;
  }

  // Every open condition (resolvedAt IS NULL), oldest first. Other structured
  // kinds stay here for client derivation; resolved free-text and terminal
  // project-dependency rows drop out. The
  // client filters by project.
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
    const existing = this.get(id);
    if (!existing || existing.resolvedAt != null) return existing;
    this.db.update(
      waitingConditions,
      { resolvedAt: new Date().toISOString() },
      { where: eq("id", id) },
    );
    return this.get(id);
  }

  resolveForCompletedProject(projectId: string): number {
    const matching = this.listOpenProjectDependencies().filter(
      (condition) => condition.refId === projectId,
    );
    for (const condition of matching) this.resolve(condition.id);
    return matching.length;
  }

  // Permanently remove a condition. Idempotent on the id (a replayed delete of
  // an already-gone row is a no-op). Returns whether a row existed.
  delete(id: string): boolean {
    const existing = this.db.get(waitingConditions, { where: eq("id", id) });
    if (!existing) return false;
    this.db.delete(waitingConditions, { where: eq("id", id) });
    return true;
  }

  deleteByReferencedProject(projectId: string): number {
    const matching = this.db
      .all(waitingConditions, { where: eq("refId", projectId) })
      .map(toCondition)
      .filter(isProjectCompletionDependency);
    for (const condition of matching) this.delete(condition.id);
    return matching.length;
  }

  // Delete every waiting condition belonging to a project, resolved or open.
  // Called when the project itself is deleted (the cascade lives in
  // UserDO.deleteProject), so a project delete never leaves conditions pointing
  // at a missing project. Idempotent — a project with none deletes 0. Returns
  // the number of rows removed.
  deleteByProject(projectId: string): number {
    const rows = this.db.all(waitingConditions, {
      where: eq("projectId", projectId),
    });
    if (rows.length > 0) {
      this.db.delete(waitingConditions, { where: eq("projectId", projectId) });
    }
    return rows.length;
  }
}
