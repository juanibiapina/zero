/**
 * `zero login`'s payoff, exercised through the real binary: after a login is
 * stored, ordinary commands authenticate with it and `whoami` says so; after
 * `zero logout` they stop working and the credential is revoked upstream.
 *
 * The stub server plays both the Zero API and the identity provider's token
 * endpoints, so nothing here touches Clerk.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const tsx = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
const execFileAsync = promisify(execFile);

let server: http.Server;
let baseUrl: string;
let requests: { method: string; url: string; auth?: string }[] = [];
let configFile: string;
let tmpDir: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push({
      method: req.method!,
      url: req.url!,
      auth: req.headers.authorization,
    });

    if (req.url === "/oauth/token/revoke") {
      res.writeHead(200).end();
      return;
    }

    const body = req.url?.startsWith("/vault/v1/projects")
      ? { projects: [] }
      : req.url?.startsWith("/errors/v1/issues")
        ? { issues: [] }
        : { userId: "user_login", orgId: "org_login" };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  tmpDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "zero-login-"));
  configFile = path.join(tmpDir, "config.json");
  fs.rmSync(configFile, { force: true });
});

function storedLogin(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: "at_stored",
    refreshToken: "rt_stored",
    expiresAt: Date.now() + 3_600_000,
    userId: "user_login",
    orgId: "org_login",
    email: "dev@example.com",
    issuer: baseUrl,
    clientId: "client_test",
    ...overrides,
  };
}

function writeLogin(overrides: Record<string, unknown> = {}) {
  fs.writeFileSync(
    configFile,
    JSON.stringify({ contexts: {}, logins: { [baseUrl]: storedLogin(overrides) } }),
    { mode: 0o600 },
  );
}

async function run(args: string[], env: Record<string, string> = {}) {
  const clean = { ...process.env };
  delete clean.ZERO_API_KEY;
  return execFileAsync(tsx, [entry, "--base-url", baseUrl, ...args], {
    encoding: "utf8",
    env: { ...clean, ZERO_CONFIG: configFile, ...env },
  });
}

describe("a signed-in machine", () => {
  it("authenticates with the stored access token, with no key anywhere", async () => {
    writeLogin();

    await run(["vault", "projects", "list"]);

    expect(requests[0].auth).toBe("Bearer at_stored");
  });

  it("uses the same login for errors, so one sign-in covers both products", async () => {
    writeLogin();

    await run(["errors", "issues", "list"]);

    expect(requests[0].auth).toBe("Bearer at_stored");
  });

  it("reports which credential answered", async () => {
    writeLogin();

    const { stdout } = await run(["whoami"]);

    expect(stdout).toContain("Credential: signed in as dev@example.com");
  });

  it("lets an explicit env key win, and says so", async () => {
    writeLogin();

    const { stdout } = await run(["whoami"], { ZERO_API_KEY: "zv_env" });

    expect(stdout).toContain("Credential: api key");
    expect(requests[0].auth).toBe("Bearer zv_env");
  });
});

describe("zero logout", () => {
  it("revokes the refresh token and drops the local credential", async () => {
    writeLogin();

    const { stdout } = await run(["logout"]);

    expect(stdout).toContain("Signed out");
    expect(requests[0]).toMatchObject({ method: "POST", url: "/oauth/token/revoke" });
    const saved = JSON.parse(fs.readFileSync(configFile, "utf8")) as { logins?: unknown };
    expect(saved.logins).toEqual({});

    await expect(run(["vault", "projects", "list"])).rejects.toThrow(/no credentials/i);
  });

  it("fails plainly when there is nothing to log out of", async () => {
    fs.writeFileSync(configFile, JSON.stringify({ contexts: {} }));

    await expect(run(["logout"])).rejects.toThrow(/Not signed in/);
  });
});

describe("an expired sign-in", () => {
  it("tells the user to log in again rather than sending a dead token", async () => {
    // The stub's token endpoint answers 200 with no access_token, which is how
    // a rejected refresh looks to the CLI.
    writeLogin({ expiresAt: Date.now() - 1000 });

    await expect(run(["vault", "projects", "list"])).rejects.toThrow(/sign-in has expired/);
  });
});
