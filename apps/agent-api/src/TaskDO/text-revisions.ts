import type { MergeableStore } from "tinybase";

export type TextConflict = { taskId: string; editId: string; text: string; reason: "concurrent-edit" | "orphaned-edit" };

export function projectTaskText(store: MergeableStore, taskId: string, originalText: string): {
  text: string; revision: string; conflicts: TextConflict[];
} {
  const all = Object.entries(store.getTable("task-edits"))
    .filter(([, row]) => row.taskId === taskId);
  const edits = all.filter(([, row]) => typeof row.baseRevision === "string" && typeof row.text === "string");
  const byBase = new Map<string, typeof edits>();
  for (const edit of edits) {
    const base = edit[1].baseRevision as string;
    byBase.set(base, [...(byBase.get(base) ?? []), edit]);
  }
  let revision = "original";
  let text = originalText;
  const path = new Set<string>();
  while (true) {
    const children = (byBase.get(revision) ?? []).sort(([a], [b]) => a.localeCompare(b));
    const next = children.at(-1);
    if (!next || path.has(next[0])) break;
    revision = next[0];
    text = next[1].text as string;
    path.add(revision);
  }
  const ids = new Set(edits.map(([id]) => id));
  return {
    text, revision,
    conflicts: all.filter(([id]) => !path.has(id)).map(([id, row]) => ({
      taskId, editId: id, text: typeof row.text === "string" ? row.text : id,
      reason: row.baseRevision === "original" ||
        (typeof row.baseRevision === "string" && ids.has(row.baseRevision))
        ? "concurrent-edit" as const : "orphaned-edit" as const,
    })),
  };
}
