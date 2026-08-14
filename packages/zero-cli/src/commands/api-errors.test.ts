/**
 * What a user sees when the API says no. A failing request is an ordinary
 * outcome for a CLI (expired key, revoked login, service down), so it must read
 * as one line on stderr with a useful exit code — never a Node stack trace.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const tsx = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
const execFileAsync = promisify(execFile);

let server: http.Server;
let baseUrl: string;
let status = 401;
let payload: unknown = { error: "Invalid API key" };

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type Run = { stdout: string; stderr: string; code: number };

async function run(args: string[], url = baseUrl): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(tsx, [entry, "--base-url", url, ...args], {
      encoding: "utf8",
      env: { ...process.env, ZERO_CONFIG: "/nonexistent/zero.json", ZERO_API_KEY: "zv_test" },
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout: string; stderr: string; code?: number };
    return { stdout: e.stdout, stderr: e.stderr, code: e.code ?? 0 };
  }
}

describe("a rejected request", () => {
  it("prints the API's reason on stderr, with no stack trace", async () => {
    status = 401;
    payload = { error: "Invalid API key" };

    const result = await run(["vault", "projects", "list"]);

    expect(result.stderr).toContain("Invalid API key");
    expect(result.stderr).not.toContain("at ");
    expect(result.stderr).not.toContain("ApiError:");
    expect(result.stdout).toBe("");
  });

  it("exits 1 on a rejected credential", async () => {
    status = 401;
    payload = { error: "Invalid API key" };

    expect((await run(["vault", "projects", "list"])).code).toBe(1);
  });

  it("says how to fix an unauthorized request", async () => {
    status = 401;
    payload = { error: "Invalid API key" };

    const result = await run(["vault", "projects", "list"]);

    expect(result.stderr).toMatch(/zero login|ZERO_API_KEY/);
  });

  it("passes through the org message the API sends for a login with no org", async () => {
    status = 401;
    payload = {
      error: "Token has no organization. Run `zero login` again and select an organization.",
    };

    const result = await run(["vault", "projects", "list"]);

    expect(result.stderr).toContain("select an organization");
  });

  it("exits 75 when the service is failing, since a retry may work", async () => {
    status = 503;
    payload = { error: "Service unavailable" };

    expect((await run(["vault", "projects", "list"])).code).toBe(75);
  });

  it("exits 75 with a readable message when the API cannot be reached", async () => {
    const result = await run(["vault", "projects", "list"], "http://127.0.0.1:1");

    expect(result.code).toBe(75);
    expect(result.stderr).toMatch(/could not reach/i);
    expect(result.stderr).not.toContain("at ");
  });

  it("still shows the stack when asked, so a bug stays debuggable", async () => {
    status = 500;
    payload = { error: "Internal server error" };

    const { stderr } = await execFileAsync(
      tsx,
      [entry, "--base-url", baseUrl, "vault", "projects", "list"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ZERO_CONFIG: "/nonexistent/zero.json",
          ZERO_API_KEY: "zv_test",
          ZERO_DEBUG: "1",
        },
      },
    ).catch((err: { stderr: string }) => err);

    expect(stderr).toContain("at ");
  });
});
