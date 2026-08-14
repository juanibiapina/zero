/**
 * End-to-end command wiring: run the real binary against a stub API and assert
 * the request it makes and the streams it writes. These are the tests that
 * would catch a command moving to the wrong product prefix, or data leaking
 * out of stdout into a pipe.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const tsx = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
const entry = fileURLToPath(new URL("../index.ts", import.meta.url));

let server: http.Server;
let baseUrl: string;
let requests: { method: string; url: string }[] = [];

/** Canned responses keyed by `METHOD path`, falling back to `{}`. */
const responses: Record<string, unknown> = {
  "GET /vault/v1/projects/demo/environments/production/secrets": {
    secrets: [
      { key: "B_KEY", value: "b" },
      { key: "A_KEY", value: "a" },
    ],
  },
  "GET /errors/v1/issues?status=open": {
    issues: [
      {
        id: "iss_1",
        fingerprint: "f",
        project: "web",
        title: "boom",
        level: "error",
        status: "open",
        count: 3,
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-02T00:00:00.000Z",
      },
    ],
  },
  "POST /errors/v1/errors": { issueId: "iss_9", isNew: true },
  "GET /vault/v1/keys": { keys: [] },
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push({ method: req.method!, url: req.url! });
    const body = responses[`${req.method!} ${req.url!}`] ?? {};
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const execFileAsync = promisify(execFile);

/**
 * Run the CLI in a child process. Must be async: the stub server lives in this
 * process, so a synchronous spawn would block the event loop that answers it.
 */
async function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
  requests = [];
  return execFileAsync(tsx, [entry, "--base-url", baseUrl, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ZERO_CONFIG: "/nonexistent/zero.json",
      ZERO_API_KEY: "zv_test_key",
    },
  });
}

describe("zero vault", () => {
  it("reaches the vault surface for secrets", async () => {
    const { stdout } = await run([
      "vault",
      "secrets",
      "download",
      "-p",
      "demo",
      "-e",
      "production",
      "--format",
      "json",
    ]);

    expect(requests).toEqual([
      {
        method: "GET",
        url: "/vault/v1/projects/demo/environments/production/secrets",
      },
    ]);
    // stdout must be nothing but the payload: bin/json-to-dotenv.mjs parses it.
    expect(JSON.parse(stdout)).toEqual({ A_KEY: "a", B_KEY: "b" });
  });

  it("masks values in the list output", async () => {
    const { stdout } = await run(["vault", "secrets", "list", "-p", "demo", "-e", "production"]);

    expect(stdout).toBe("A_KEY=••••••••\nB_KEY=••••••••\n");
  });
});

describe("zero keys", () => {
  it("reads keys from the vault surface, not a keys surface", async () => {
    await run(["keys", "list"]);

    expect(requests).toEqual([{ method: "GET", url: "/vault/v1/keys" }]);
  });
});

describe("zero errors", () => {
  it("lists issues from the errors surface", async () => {
    const { stdout } = await run(["errors", "issues", "list", "-s", "open"]);

    expect(requests).toEqual([{ method: "GET", url: "/errors/v1/issues?status=open" }]);
    expect(stdout).toContain("iss_1");
    expect(stdout).toContain("boom");
  });

  it("prints raw JSON with --json", async () => {
    const { stdout } = await run(["errors", "issues", "list", "-s", "open", "--json"]);

    expect((JSON.parse(stdout) as { issues: unknown[] }).issues).toHaveLength(1);
  });

  it("prints only the issue id on stdout when reporting", async () => {
    const { stdout } = await run(["errors", "report", "-p", "web", "-m", "boom"]);

    expect(requests).toEqual([{ method: "POST", url: "/errors/v1/errors" }]);
    expect(stdout).toBe("iss_9\n");
  });
});
