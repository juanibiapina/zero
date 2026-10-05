import { describe, expect, it } from "vitest";
import { migrations } from "./migrations";

describe("0030 files migration", () => {
  it("copies legacy ids and object keys before dropping attachments", () => {
    const sql = migrations.m0030;
    expect(sql).toContain('CREATE TABLE "files"');
    expect(sql).toContain('"byteSize" integer');
    expect(sql).toContain('SELECT "id", "r2Key", "filename", "mimeType", NULL, "createdAt"');
    expect(sql.indexOf('INSERT INTO "files"')).toBeLessThan(sql.indexOf('DROP TABLE "attachments"'));
  });
});
