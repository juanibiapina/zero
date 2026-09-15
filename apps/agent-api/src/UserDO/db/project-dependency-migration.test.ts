import { describe, expect, it } from "vitest";

import { migrations } from "./migrations";

describe("0054 project dependency settlement migration", () => {
  it("settles only open project-status/Done rows referencing Done projects", () => {
    const sql = migrations.m0054;

    expect(sql).toContain('UPDATE "waiting_conditions"');
    expect(sql).toContain('"kind" = \'project-status\'');
    expect(sql).toContain('"targetStatus" = \'done\'');
    expect(sql).toContain('"resolvedAt" IS NULL');
    expect(sql).toContain('"projects"."state" = \'done\'');
    expect(sql).toContain('"projects"."id" = "waiting_conditions"."refId"');
  });
});
