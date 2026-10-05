import { describe, expect, it } from "vitest";

import { migrations } from "./migrations";

describe("0053 project state migration", () => {
  it("renames status to state and normalizes every calculated legacy value", () => {
    const sql = migrations.m0053;

    expect(sql).toContain('"state" TEXT NOT NULL DEFAULT \'in-play\'');
    expect(sql).toContain(
      "WHEN \"status\" IN ('active', 'next', 'waiting') THEN 'in-play'",
    );
    expect(sql).toContain(
      '"id", "title", "icon", "description", "state", "createdAt",\n  "sourceCaptureId"',
    );
    expect(sql.indexOf('INSERT INTO "projects_new"')).toBeLessThan(
      sql.indexOf('DROP TABLE "projects"'),
    );
    expect(sql).toContain(
      'CREATE INDEX "projects_open" ON "projects" ("createdAt") WHERE "state" != \'done\'',
    );
  });
});
