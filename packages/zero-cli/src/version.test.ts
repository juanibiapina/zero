import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkgUrl = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version: string };

const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const entry = fileURLToPath(new URL("./index.ts", import.meta.url));

describe("zero --version", () => {
  it("prints the version from package.json", () => {
    const out = execFileSync(tsx, [entry, "--version"], { encoding: "utf8" });
    expect(out.trim()).toBe(pkg.version);
  });
});
