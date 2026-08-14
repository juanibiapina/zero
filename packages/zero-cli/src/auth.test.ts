import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const entry = fileURLToPath(new URL("./index.ts", import.meta.url));

/**
 * The no-key error is the first thing a user without a key reads, and it ships
 * inside a published binary, so it cannot be hotfixed from a deploy. Assert the
 * whole URL: a fragment would still pass if it drifted back to a product-owned
 * getting-started page.
 */
describe("zv with no API key", () => {
  it("points at the API keys doc", () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ZEROVAULT_CONFIG: "/nonexistent/zerovault.json",
    };
    delete env.ZEROVAULT_API_KEY;

    try {
      execFileSync(tsx, [entry, "whoami"], { encoding: "utf8", env });
      expect.unreachable("zv whoami should fail without a key");
    } catch (err) {
      const { status, stderr } = err as { status: number; stderr: string };
      expect(status).toBe(1);
      expect(stderr).toContain("https://docs.zeroapps.dev/account/api-keys/");
    }
  });
});
