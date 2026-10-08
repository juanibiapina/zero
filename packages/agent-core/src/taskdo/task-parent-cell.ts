import type { Row } from "tinybase";

import type { TaskParent } from "./types";

const PARENT = "parent";

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
