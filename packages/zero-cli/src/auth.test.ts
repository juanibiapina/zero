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
function runWithoutKey(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ZERO_CONFIG: "/nonexistent/zero.json",
    ...extraEnv,
  };
  delete env.ZERO_API_KEY;
  delete env.ZERO_API_URL;

  try {
    execFileSync(tsx, [entry, ...args], { encoding: "utf8", env });
    expect.unreachable(`zero ${args.join(" ")} should fail without a key`);
  } catch (err) {
    return err as { status: number; stderr: string };
  }
}

describe("zero with no API key", () => {
  it("names ZERO_API_KEY and points at the API keys doc", () => {
    const { status, stderr } = runWithoutKey(["whoami"]);

    expect(status).toBe(1);
    expect(stderr).toContain("ZERO_API_KEY");
    expect(stderr).toContain("https://docs.zeroapps.dev/account/api-keys/");
  });

  it("ignores a ZEROVAULT_API_KEY left over from the zv CLI", () => {
    const { status, stderr } = runWithoutKey(["whoami"], {
      ZEROVAULT_API_KEY: "zv_stale_key",
      ZEROVAULT_CONFIG: "/nonexistent/zerovault.json",
    });

    expect(status).toBe(1);
    expect(stderr).toContain("ZERO_API_KEY");
  });

  it("fails the same way for an errors command", () => {
    const { status, stderr } = runWithoutKey(["errors", "issues", "list"]);

    expect(status).toBe(1);
    expect(stderr).toContain("ZERO_API_KEY");
  });
});
