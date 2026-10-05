import { describe, expect, it } from "vitest";
import { migrations } from "./migrations";

const statements = (sql: string) =>
  sql
    .replace(/^--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);

describe("0057 legacy todo tables migration", () => {
  it("drops only the retired UserDO todo tables in dependency order", () => {
    expect(statements(migrations.m0057)).toEqual([
      'DROP TABLE IF EXISTS "waiting_conditions"',
      'DROP TABLE IF EXISTS "tasks"',
      'DROP TABLE IF EXISTS "projects"',
    ]);
  });

  it("runs after the last historical UserDO migration", () => {
    expect(Object.keys(migrations).slice(-2)).toEqual(["m0056", "m0057"]);
  });
});
