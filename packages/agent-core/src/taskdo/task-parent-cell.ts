import { getHlcFunctions, type Row } from "tinybase";
import type { MergeableStore } from "tinybase";

import type { TaskParent } from "./types";

const PARENT = "parent";
const LEGACY = ["projectId", "medicineId", "role"] as const;

type CellStamp = [value: unknown, hlc: string, hash?: number];

const [, , encodeHlc, decodeHlc] = getHlcFunctions();

// The next stamp after a cell's own stamp outranks that cell and never runs
// ahead of the store's clock, which would make the store reject the change.
function stampAfter(hlc: string): string {
  const [time, counter, clientId] = decodeHlc(hlc);
  return encodeHlc(time, counter + 1, clientId);
}

export function parentCellValue(parent: TaskParent | null): string | null {
  return parent ? JSON.stringify(parent) : null;
}

export function readParentCell(row: Row): TaskParent | null {
  if (typeof row[PARENT] !== "string") return null;
  try {
    const value: unknown = JSON.parse(row[PARENT]);
    if (typeof value !== "object" || value === null) return null;
    const parent = value as Record<string, unknown>;
    if (parent.kind === "project" && typeof parent.projectId === "string") {
      return { kind: "project", projectId: parent.projectId };
    }
    if (parent.kind === "medicine" && typeof parent.medicineId === "string") {
      return { kind: "medicine", medicineId: parent.medicineId, role: parent.role === "restock" ? "restock" : null };
    }
    return null;
  } catch {
    return null;
  }
}

function legacyParent(cells: Record<string, CellStamp | undefined>): TaskParent | null {
  const projectId = cells.projectId?.[0];
  if (typeof projectId === "string") return { kind: "project", projectId };
  const medicineId = cells.medicineId?.[0];
  if (typeof medicineId === "string") {
    return { kind: "medicine", medicineId, role: cells.role?.[0] === "restock" ? "restock" : null };
  }
  return null;
}

// Older apps stored a parent as projectId, or medicineId and role. Each row
// becomes one parent cell stamped with its legacy cells' newest stamp, so a
// replica that migrates stale rows never outranks a later parent change.
function migrate(store: MergeableStore, rowIds?: readonly string[]): void {
  const table = store.getMergeableContent()[0][0].tasks?.[0] as
    Record<string, [Record<string, CellStamp | undefined>, ...unknown[]]> | undefined;
  if (!table) return;
  const changes: Record<string, [Record<string, [unknown, string]>]> = {};
  for (const rowId of rowIds ?? Object.keys(table)) {
    const cells = table[rowId]?.[0];
    if (!cells) continue;
    const legacy = LEGACY.flatMap((cellId) => cells[cellId] ? [[cellId, cells[cellId]] as const] : []);
    const live = legacy.filter(([, stamp]) => stamp[0] != null);
    if (legacy.length === 0 || (live.length === 0 && cells[PARENT])) continue;
    const hlc = (live.length ? live : legacy).map(([, stamp]) => stamp[1]).sort().at(-1)!;
    const rowChanges: Record<string, [unknown, string]> = {
      [PARENT]: [parentCellValue(legacyParent(cells)) ?? undefined, hlc],
    };
    for (const [cellId, stamp] of live) rowChanges[cellId] = [undefined, stampAfter(stamp[1])];
    changes[rowId] = [rowChanges];
  }
  if (Object.keys(changes).length === 0) return;
  store.applyMergeableChanges([[{ tasks: [changes] }], [{}], 1] as unknown as Parameters<MergeableStore["applyMergeableChanges"]>[0]);
}

// Migrates the store now and every transaction that brings legacy parent
// cells, whether from a persister load, a sync merge, or a local merge.
export function keepTaskParentsMigrated(store: MergeableStore): () => void {
  migrate(store);
  const listenerId = store.addWillFinishTransactionListener(() => {
    const tasks = store.getTransactionChanges()[0].tasks;
    if (!tasks) return;
    const rowIds = Object.entries(tasks).flatMap(([rowId, cells]) =>
      cells && LEGACY.some((cellId) => cellId in cells) ? [rowId] : []);
    if (rowIds.length) migrate(store, rowIds);
  });
  return () => { store.delListener(listenerId); };
}
