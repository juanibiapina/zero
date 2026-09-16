import { asc, eq, isNull, type Database } from "do-orm";

import { waitingConditions } from "../UserDO/db/schema";

export type ManualWaitingCondition = {
  id: string;
  projectId: string;
  kind: "free-text";
  text: string;
  refId: null;
  targetStatus: null;
  resolvedAt: string | null;
  createdAt: string;
};

export type ProjectAfter = {
  id: string;
  projectId: string;
  kind: "project-status";
  text: null;
  refId: string;
  targetStatus: "done";
  resolvedAt: string | null;
  createdAt: string;
};

export type WaitingCondition = ManualWaitingCondition | ProjectAfter;

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

export function isProjectAfter(
  condition: WaitingCondition,
): condition is ProjectAfter {
  return condition.kind === "project-status";
}

function toCondition(row: Row): WaitingCondition {
  if (
    row.kind === "project-status" &&
    row.targetStatus === "done" &&
    row.refId != null
  ) {
    return {
      id: row.id,
      projectId: row.projectId,
      kind: "project-status",
      text: null,
      refId: row.refId,
      targetStatus: "done",
      resolvedAt: row.resolvedAt,
      createdAt: row.createdAt,
    };
  }
  return {
    id: row.id,
    projectId: row.projectId,
    kind: "free-text",
    text: row.text ?? "",
    refId: null,
    targetStatus: null,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
  };
}

export class DbWaitingConditionStore {
  constructor(private db: Database) {}

  private insert(condition: WaitingCondition): WaitingCondition {
    this.db.insert(waitingConditions, condition);
    return condition;
  }

  get(id: string): WaitingCondition | null {
    const row = this.db.get(waitingConditions, { where: eq("id", id) });
    return row ? toCondition(row) : null;
  }

  addWaiting(id: string, projectId: string, text: string): WaitingCondition {
    const existing = this.get(id);
    if (existing) return existing;
    return this.insert({
      id,
      projectId,
      kind: "free-text",
      text,
      refId: null,
      targetStatus: null,
      resolvedAt: null,
      createdAt: new Date().toISOString(),
    });
  }

  addAfter(
    id: string,
    projectId: string,
    afterProjectId: string,
  ): ProjectAfter {
    const existing = this.get(id);
    if (existing && isProjectAfter(existing)) return existing;
    if (existing) throw new Error("Project attention id conflict");
    return this.insert({
      id,
      projectId,
      kind: "project-status",
      text: null,
      refId: afterProjectId,
      targetStatus: "done",
      resolvedAt: null,
      createdAt: new Date().toISOString(),
    }) as ProjectAfter;
  }

  listOpen(): WaitingCondition[] {
    return this.db
      .all(waitingConditions, {
        where: isNull("resolvedAt"),
        orderBy: asc("createdAt"),
      })
      .map(toCondition);
  }

  listOpenAfters(): ProjectAfter[] {
    return this.listOpen().filter(isProjectAfter);
  }

  resolveWaiting(id: string): WaitingCondition | null {
    const existing = this.get(id);
    if (!existing || existing.resolvedAt != null) return existing;
    if (isProjectAfter(existing)) return existing;
    this.setResolved(id, new Date().toISOString());
    return this.get(id);
  }

  private setResolved(id: string, resolvedAt: string | null): void {
    this.db.update(waitingConditions, { resolvedAt }, { where: eq("id", id) });
  }

  resolveAftersForCompletedProject(projectId: string): number {
    const matching = this.listOpenAfters().filter(
      (condition) => condition.refId === projectId,
    );
    const resolvedAt = new Date().toISOString();
    for (const condition of matching) this.setResolved(condition.id, resolvedAt);
    return matching.length;
  }

  restoreAftersForReopenedProject(projectId: string): number {
    const matching = this.db
      .all(waitingConditions, { where: eq("refId", projectId) })
      .map(toCondition)
      .filter(
        (condition): condition is ProjectAfter =>
          isProjectAfter(condition) && condition.resolvedAt != null,
      );
    for (const condition of matching) this.setResolved(condition.id, null);
    return matching.length;
  }

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
      .filter(isProjectAfter);
    for (const condition of matching) this.delete(condition.id);
    return matching.length;
  }

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
