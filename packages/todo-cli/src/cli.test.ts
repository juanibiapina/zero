import { mkdtemp, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { run, type Io } from "./cli";

const CLIENT_ID = "test-client";

type Recorded = { method: string; path: string; authorization?: string; body: string };
type ApiHandler = (request: Recorded) => { status: number; body: unknown } | undefined;

function idToken(issuer: string, claims: Record<string, unknown> = {}) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  return `${part({ alg: "RS256", typ: "JWT" })}.${part({
    iss: issuer, aud: CLIENT_ID, sub: "user_1", email: "juan@example.com", iat: now, exp: now + 3600, ...claims,
  })}.c2ln`;
}

class FakeZero {
  server = http.createServer();
  requests: Recorded[] = [];
  tokenRequests: URLSearchParams[] = [];
  issued = 0;
  api: ApiHandler = () => undefined;

  get url() {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async start() {
    this.server.on("request", (req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        const url = new URL(req.url ?? "/", this.url);
        const send = (status: number, value: unknown) => {
          res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
        };
        if (url.pathname === "/.well-known/openid-configuration") {
          return send(200, {
            issuer: this.url,
            authorization_endpoint: `${this.url}/oauth/authorize`,
            token_endpoint: `${this.url}/oauth/token`,
            id_token_signing_alg_values_supported: ["RS256"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          });
        }
        if (url.pathname === "/oauth/token") {
          const params = new URLSearchParams(body);
          this.tokenRequests.push(params);
          this.issued += 1;
          return send(200, {
            access_token: `at_${this.issued}`,
            refresh_token: `rt_${this.issued}`,
            token_type: "Bearer",
            expires_in: 3600,
            id_token: idToken(this.url),
          });
        }
        const recorded = { method: req.method ?? "GET", path: `${url.pathname}${url.search}`, authorization: req.headers.authorization, body };
        this.requests.push(recorded);
        const answer = this.api(recorded);
        if (answer) return send(answer.status, answer.body);
        return send(404, { error: "not-found" });
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
  }

  async stop() {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

let zero: FakeZero;
let configHome: string;

beforeEach(async () => {
  zero = new FakeZero();
  await zero.start();
  configHome = await mkdtemp(path.join(tmpdir(), "zero-todo-"));
});

afterEach(async () => {
  await zero.stop();
});

const authFile = () => path.join(configHome, "zero-todo", "auth.json");

async function storeLogin(fields: { accessToken?: string; refreshToken?: string; expiresAt: number }) {
  await mkdir(path.dirname(authFile()), { recursive: true, mode: 0o700 });
  await writeFile(authFile(), JSON.stringify({
    issuer: zero.url,
    clientId: CLIENT_ID,
    accessToken: fields.accessToken ?? "at_old",
    refreshToken: fields.refreshToken ?? "rt_old",
    expiresAt: fields.expiresAt,
    userId: "user_1",
    email: "juan@example.com",
  }), { mode: 0o600 });
}

const approvingBrowser = async (url: string) => {
  const params = new URL(url).searchParams;
  const callback = new URL(params.get("redirect_uri")!);
  callback.searchParams.set("code", "code_1");
  callback.searchParams.set("state", params.get("state")!);
  await fetch(callback);
};

async function zeroTodo(args: string[], options: { env?: Record<string, string>; openBrowser?: Io["openBrowser"] } = {}) {
  let stdout = "";
  let stderr = "";
  const code = await run([...args, "--api-url", zero.url], {
    env: { XDG_CONFIG_HOME: configHome, ZERO_TODO_ISSUER: zero.url, ZERO_TODO_CLIENT_ID: CLIENT_ID, ...options.env },
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    openBrowser: options.openBrowser ?? approvingBrowser,
    confirm: null,
  });
  return { code, stdout, stderr };
}

const TASK = {
  id: "t1", text: "Buy milk", showUpDate: null, recurrence: null, recurrenceDate: null,
  parent: null, recordingId: null, createdAt: "2026-03-01T10:00:00.000Z", completedAt: null,
};
const tasksBody = { today: "2026-03-10", tasks: [TASK] };
const listTasks: ApiHandler = (request) =>
  request.path.startsWith("/api/v1/tasks") ? { status: 200, body: tasksBody } : undefined;

describe("zero-todo auth", () => {
  it("signs in through the browser and keeps the tokens private", async () => {
    zero.api = listTasks;

    const login = await zeroTodo(["auth", "login"]);
    const list = await zeroTodo(["tasks", "list"]);

    expect(login.code).toBe(0);
    expect(zero.tokenRequests[0]?.get("grant_type")).toBe("authorization_code");
    expect(zero.tokenRequests[0]?.get("code_verifier")).toBeTruthy();
    expect((await stat(authFile())).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(authFile()))).mode & 0o777).toBe(0o700);
    expect(list.code).toBe(0);
    expect(zero.requests[0]?.authorization).toBe("Bearer at_1");
  });

  it("reports who is signed in", async () => {
    await storeLogin({ expiresAt: Date.now() + 3_600_000 });
    const status = await zeroTodo(["auth", "status"]);

    expect(status.code).toBe(0);
    expect(status.stdout).toContain("juan@example.com");
  });

  it("forgets the tokens on logout", async () => {
    await storeLogin({ expiresAt: Date.now() + 3_600_000 });
    await zeroTodo(["auth", "logout"]);
    const status = await zeroTodo(["auth", "status"]);

    expect(status.code).toBe(1);
    expect(status.stderr).toContain("zero-todo auth login");
  });

  it("refreshes an expired token once and saves it before use", async () => {
    zero.api = listTasks;
    await storeLogin({ expiresAt: Date.now() - 1000 });

    const result = await zeroTodo(["tasks", "list"]);

    expect(result.code).toBe(0);
    expect(zero.tokenRequests.map((params) => params.get("grant_type"))).toEqual(["refresh_token"]);
    expect(zero.tokenRequests[0]?.get("refresh_token")).toBe("rt_old");
    expect(zero.requests[0]?.authorization).toBe("Bearer at_1");
    expect(JSON.parse(await readFile(authFile(), "utf8"))).toMatchObject({ accessToken: "at_1", refreshToken: "rt_1" });
  });

  it("refreshes once for two commands that start with an expired token", async () => {
    zero.api = () => ({ status: 200, body: { today: "2026-03-10", tasks: [], projects: [] } });
    await storeLogin({ expiresAt: Date.now() - 1000 });

    const results = await Promise.all([zeroTodo(["tasks", "list"]), zeroTodo(["projects", "list"])]);

    expect(results.map((result) => result.code)).toEqual([0, 0]);
    expect(zero.tokenRequests).toHaveLength(1);
    expect(zero.requests.map((request) => request.authorization)).toEqual(["Bearer at_1", "Bearer at_1"]);
  });

  it("refreshes and retries once when the API rejects the token", async () => {
    await storeLogin({ expiresAt: Date.now() + 3_600_000 });
    zero.api = (request) => request.authorization === "Bearer at_old"
      ? { status: 401, body: { error: "unauthorized" } }
      : { status: 200, body: tasksBody };

    const result = await zeroTodo(["tasks", "list"]);

    expect(result.code).toBe(0);
    expect(zero.tokenRequests).toHaveLength(1);
    expect(zero.requests.map((request) => request.authorization)).toEqual(["Bearer at_old", "Bearer at_1"]);
  });

  it("uses ZERO_TODO_TOKEN instead of the stored login", async () => {
    zero.api = listTasks;
    const result = await zeroTodo(["tasks", "list"], { env: { ZERO_TODO_TOKEN: "user-abc" } });

    expect(result.code).toBe(0);
    expect(zero.requests[0]?.authorization).toBe("Bearer user-abc");
    expect(zero.tokenRequests).toHaveLength(0);
  });

  it("asks to sign in when there is no login", async () => {
    const result = await zeroTodo(["tasks", "list"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("zero-todo auth login");
    expect(zero.requests).toHaveLength(0);
  });
});

describe("zero-todo commands", () => {
  const token = { env: { ZERO_TODO_TOKEN: "user-abc" } };

  it("prints the response body with --json", async () => {
    zero.api = listTasks;
    const result = await zeroTodo(["tasks", "list", "--home", "--json"], token);

    expect(JSON.parse(result.stdout)).toEqual(tasksBody);
    expect(zero.requests[0]?.path).toBe("/api/v1/tasks?view=home");
  });

  it("prints a table without --json", async () => {
    zero.api = listTasks;
    const result = await zeroTodo(["tasks", "list"], token);

    expect(result.stdout).toMatch(/^ID\s+DATE\s+TEXT\n/);
    expect(result.stdout).toMatch(/t1\s+-?\s+Buy milk/);
  });

  it("adds a Task to a Project on a date", async () => {
    zero.api = () => ({ status: 201, body: { task: TASK } });
    const result = await zeroTodo(["tasks", "add", "Buy milk", "--project", "p1", "--on", "2026-03-11"], token);

    expect(result.code).toBe(0);
    expect(zero.requests[0]).toMatchObject({ method: "POST", path: "/api/v1/tasks" });
    expect(JSON.parse(zero.requests[0].body)).toEqual({
      text: "Buy milk", showUpDate: "2026-03-11", parent: { kind: "project", projectId: "p1" },
    });
  });

  it("clears a Task's date and Project", async () => {
    zero.api = () => ({ status: 200, body: { task: TASK } });
    await zeroTodo(["tasks", "edit", "t1", "--no-date", "--loose"], token);

    expect(zero.requests[0]).toMatchObject({ method: "PATCH", path: "/api/v1/tasks/t1" });
    expect(JSON.parse(zero.requests[0].body)).toEqual({ showUpDate: null, parent: null });
  });

  it("moves a Project to the backlog", async () => {
    zero.api = () => ({ status: 200, body: { project: { id: "p1", title: "Trip", icon: "✈️", description: null, state: "backlog", createdAt: "" } } });
    const result = await zeroTodo(["projects", "state", "p1", "backlog"], token);

    expect(result.code).toBe(0);
    expect(zero.requests[0]).toMatchObject({ method: "PATCH", path: "/api/v1/projects/p1" });
    expect(JSON.parse(zero.requests[0].body)).toEqual({ state: "backlog" });
  });

  it("deletes a Project only with --yes when it cannot ask", async () => {
    zero.api = () => ({ status: 200, body: { removed: { tasks: 2, conditions: 0, afters: 0 } } });

    const refused = await zeroTodo(["projects", "delete", "p1"], token);
    const deleted = await zeroTodo(["projects", "delete", "p1", "--yes"], token);

    expect(refused.code).toBe(1);
    expect(deleted.code).toBe(0);
    expect(zero.requests.map((request) => request.method)).toEqual(["DELETE"]);
  });

  it("exits 1 with the API's error name when it refuses", async () => {
    zero.api = () => ({ status: 404, body: { error: "missing-task" } });
    const result = await zeroTodo(["tasks", "edit", "nope", "--text", "x"], token);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Error: missing-task");
  });

  it("exits 75 when the API fails", async () => {
    zero.api = () => ({ status: 503, body: { error: "unavailable" } });
    const result = await zeroTodo(["tasks", "list"], token);

    expect(result.code).toBe(75);
  });

  it("exits 75 when the API is unreachable", async () => {
    let stderr = "";
    const code = await run(["tasks", "list", "--api-url", "http://127.0.0.1:1"], {
      env: { ZERO_TODO_TOKEN: "user-abc" },
      stdout: () => undefined,
      stderr: (text) => { stderr += text; },
      openBrowser: async () => undefined,
      confirm: null,
    });

    expect(code).toBe(75);
    expect(stderr).toContain("Error:");
  });
});
