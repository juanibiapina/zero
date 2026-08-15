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

    // The token endpoint hands out a rotated pair only for the refresh token a
    // test opts in with, so the "expired sign-in" case still sees a refusal.
    if (req.url === "/oauth/token") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
        const rotates = form.get("refresh_token") === "rt_rotate";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            rotates
              ? { access_token: "at_rotated", refresh_token: "rt_rotated", expires_in: 3600 }
              : { error: "invalid_grant" },
          ),
        );
      });
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

async function run(args: string[], env: Record<string, string> = {}, cwd?: string) {
  const clean = { ...process.env };
  delete clean.ZERO_API_KEY;
  return execFileAsync(tsx, [entry, "--base-url", baseUrl, ...args], {
    encoding: "utf8",
    env: { ...clean, ZERO_CONFIG: configFile, ...env },
    ...(cwd ? { cwd } : {}),
  });
}

function readConfig() {
  return JSON.parse(fs.readFileSync(configFile, "utf8")) as {
    logins?: Record<string, { accessToken: string; refreshToken: string }>;
    contexts?: Record<string, unknown>;
  };
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

describe("a directory bound to its own sign-in", () => {
  let projectDir: string;

  /**
   * A machine signed in to org_a, plus a context holding a sign-in to org_b
   * bound to one project directory — the setup the feature exists for.
   */
  function writeBoundProject(orgLogin: Record<string, unknown> = {}) {
    projectDir = fs.mkdtempSync(path.join(tmpDir, "project-"));
    fs.mkdirSync(path.join(projectDir, "apps", "api"), { recursive: true });
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        contexts: { cragstronauts: { login: { orgId: "org_b" } } },
        dirContexts: { [fs.realpathSync(projectDir)]: "cragstronauts" },
        logins: {
          [baseUrl]: storedLogin({ accessToken: "at_machine", orgId: "org_a" }),
          [`${baseUrl}#org_b`]: storedLogin({
            accessToken: "at_org_b",
            orgId: "org_b",
            ...orgLogin,
          }),
        },
      }),
      { mode: 0o600 },
    );
  }

  it("uses the directory's organization, not the machine's", async () => {
    writeBoundProject();

    await run(["vault", "projects", "list"], {}, projectDir);

    expect(requests[0].auth).toBe("Bearer at_org_b");
  });

  it("applies in subdirectories too", async () => {
    writeBoundProject();

    await run(["vault", "projects", "list"], {}, path.join(projectDir, "apps", "api"));

    expect(requests[0].auth).toBe("Bearer at_org_b");
  });

  it("leaves every other directory on the machine sign-in", async () => {
    writeBoundProject();

    await run(["vault", "projects", "list"], {}, tmpDir);

    expect(requests[0].auth).toBe("Bearer at_machine");
  });

  it("is not overridden by an ambient ZERO_API_KEY", async () => {
    writeBoundProject();

    const { stdout } = await run(["whoami"], { ZERO_API_KEY: "zv_env" }, projectDir);

    expect(requests[0].auth).toBe("Bearer at_org_b");
    expect(stdout).toContain("Credential: signed in as dev@example.com (context cragstronauts)");
  });

  it("is still overridden by an explicit --api-key flag", async () => {
    writeBoundProject();

    await run(["--api-key", "zv_flag", "vault", "projects", "list"], {}, projectDir);

    expect(requests[0].auth).toBe("Bearer zv_flag");
  });

  it("stops with the fix when the sign-in is gone, instead of using another org", async () => {
    writeBoundProject();
    const config = readConfig();
    delete config.logins![`${baseUrl}#org_b`];
    fs.writeFileSync(configFile, JSON.stringify(config));

    await expect(run(["vault", "projects", "list"], {}, projectDir)).rejects.toThrow(
      /context "cragstronauts" has no sign-in.*zero login --context cragstronauts/s,
    );
  });

  it("writes a rotated token pair back to its own entry, never over the machine's", async () => {
    writeBoundProject({ expiresAt: Date.now() - 1000, refreshToken: "rt_rotate" });

    await run(["vault", "projects", "list"], {}, projectDir);

    const saved = readConfig();
    expect(saved.logins![`${baseUrl}#org_b`]).toMatchObject({
      accessToken: "at_rotated",
      refreshToken: "rt_rotated",
    });
    expect(saved.logins![baseUrl]).toMatchObject({ accessToken: "at_machine" });
  });

  it("logs out of the directory's sign-in and keeps the machine's", async () => {
    writeBoundProject();

    const { stdout } = await run(["logout"], {}, projectDir);

    expect(stdout).toContain("context cragstronauts");
    const saved = readConfig();
    expect(saved.logins![`${baseUrl}#org_b`]).toBeUndefined();
    expect(saved.logins![baseUrl]).toBeDefined();
    expect(requests[0]).toMatchObject({ method: "POST", url: "/oauth/token/revoke" });
  });

  it("names the credential each context carries", async () => {
    writeBoundProject();

    const { stdout } = await run(["context", "list"], {}, projectDir);

    expect(stdout).toContain("* cragstronauts");
    expect(stdout).toContain("login dev@example.com (org org_b)");
  });

  it("revokes the sign-in when its context is removed", async () => {
    writeBoundProject();

    const { stdout } = await run(["context", "remove", "cragstronauts"], {}, projectDir);

    expect(stdout).toContain("signed out of org org_b");
    expect(readConfig().logins![`${baseUrl}#org_b`]).toBeUndefined();
    expect(requests.some((r) => r.url === "/oauth/token/revoke")).toBe(true);
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
