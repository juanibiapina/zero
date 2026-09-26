import type { MergeableStore } from "tinybase";

import type { Project } from "../store/projects";
import type { WaitingCondition, ProjectAfter } from "../store/waiting-conditions";

export type ConditionRecovery = {
  conditionId: string;
  projectId: string | null;
  refId: string | null;
  reason: "invalid-row" | "missing-source" | "missing-target" | "target-done" | "self" | "duplicate" | "cycle";
};

export function reaches(source: string, destination: string, edges: ProjectAfter[]): boolean {
  const next = new Map<string, string[]>();
  for (const edge of edges) next.set(edge.projectId, [...(next.get(edge.projectId) ?? []), edge.refId]);
  const pending = [source];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === destination) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    pending.push(...(next.get(id) ?? []));
  }
  return false;
}

export function projectConditions(
  store: MergeableStore,
  project: (id: string) => Project | null,
): { open: WaitingCondition[]; recoveries: ConditionRecovery[] } {
  const open: WaitingCondition[] = [];
  const acceptedAfters: ProjectAfter[] = [];
  const recoveries: ConditionRecovery[] = [];
  // Stable ordering makes a cycle or duplicate converge to the same accepted
  // subset on all replicas, irrespective of merge or WebSocket arrival order.
  for (const [id, row] of Object.entries(store.getTable("conditions")).sort(([a], [b]) => a.localeCompare(b))) {
    const sourceId = typeof row.projectId === "string" ? row.projectId : null;
    const targetId = typeof row.refId === "string" ? row.refId : null;
    const recover = (reason: ConditionRecovery["reason"]) => {
      recoveries.push({ conditionId: id, projectId: sourceId, refId: targetId, reason });
    };
    if (!sourceId || typeof row.createdAt !== "string" ||
        (row.resolvedAt !== undefined && typeof row.resolvedAt !== "string")) {
      recover("invalid-row");
      continue;
    }
    if (!project(sourceId)) { recover("missing-source"); continue; }
    if (row.kind === "free-text") {
      if (typeof row.text !== "string" || !row.text.trim() || targetId || row.targetStatus) {
        recover("invalid-row");
      } else if (!row.resolvedAt) {
        open.push({ id, projectId: sourceId, kind: "free-text", text: row.text,
          refId: null, targetStatus: null, resolvedAt: null, createdAt: row.createdAt });
      }
      continue;
    }
    if (row.kind !== "project-status" || !targetId || row.targetStatus !== "done" || row.text) {
      recover("invalid-row");
      continue;
    }
    const target = project(targetId);
    if (!target) { recover("missing-target"); continue; }
    if (sourceId === targetId) { recover("self"); continue; }
    // Resolved records remain durable but do not block anything. State changes
    // explicitly settle and restore them; a raw new edge to Done is rejected.
    if (row.resolvedAt) continue;
    if (target.state === "done") { recover("target-done"); continue; }
    if (acceptedAfters.some((edge) => edge.projectId === sourceId && edge.refId === targetId)) {
      recover("duplicate"); continue;
    }
    if (reaches(targetId, sourceId, acceptedAfters)) { recover("cycle"); continue; }
    const after: ProjectAfter = { id, projectId: sourceId, kind: "project-status", text: null,
      refId: targetId, targetStatus: "done", resolvedAt: null, createdAt: row.createdAt };
    acceptedAfters.push(after);
    open.push(after);
  }
  open.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { open, recoveries };
}
