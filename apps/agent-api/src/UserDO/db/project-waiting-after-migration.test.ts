import { describe, expect, it } from "vitest";

import { migrations } from "./migrations";

describe("0056 Project Waiting and After migration", () => {
  it("removes rejected relationship kinds and guards direct After duplicates", () => {
    const sql = migrations.m0056;
    expect(sql).toContain('"kind" = \'free-text\'');
    expect(sql).toContain('"kind" = \'project-status\'');
    expect(sql).toContain('"targetStatus" = \'done\'');
    expect(sql).not.toContain("task-done");
    expect(sql).toContain('"projectId" != "refId"');
    expect(sql).toContain('CREATE UNIQUE INDEX "project_after_unique"');
    expect(sql).toContain('min(CASE WHEN "resolvedAt" IS NULL THEN "id" END)');
    expect(sql).toContain('GROUP BY "projectId", "refId"');
  });
});
