/**
 * ============================================================================
 * ZeroErrors API Tests — ingest, grouping, notify, auth, rate limit
 * ============================================================================
 *
 * Runs via the Cloudflare Workers test pool. Keys are written straight into the
 * shared APIKEYS KV (ZeroErrors only reads keys; it never mints them). DO state
 * is inspected via direct stub RPC calls to avoid depending on the read API.
 */

import { env, exports as SELF } from "cloudflare:workers";
import { hashApiKey } from "@zero/auth";
import { describe, it, expect } from "vitest";
import type { Env } from "../types";
import type { ErrorsDO } from "../ErrorsDO";
import { createApp } from "../app";
import type { Notifier, NotifyKind } from "../notify/notifier";
import type { IssueSummary } from "@zero/errors-core";

const typedEnv = env as Env;

/** Write a valid v2 API key straight into the shared KV and return the token. */
async function putKey(orgId: string, userId: string): Promise<string> {
  const randomHex = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const key = `zv_${randomHex}`;
  await typedEnv.APIKEYS.put(
    await hashApiKey(key),
    JSON.stringify({ v: 2, orgId, userId }),
  );
  return key;
}

function authed(key: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      ...(init.headers as Record<string, string>),
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  };
}

function errorsDO(orgId: string): DurableObjectStub<ErrorsDO> {
  return typedEnv.ERRORSDO.get(typedEnv.ERRORSDO.idFromName(orgId));
}

describe("Health check", () => {
  it("returns ok", async () => {
    const res = await SELF.default.fetch("https://localhost/ping");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("API key auth", () => {
  it("401 without a key", async () => {
    const res = await SELF.default.fetch("https://localhost/v1/errors", {
      method: "POST",
      body: JSON.stringify({ project: "p", message: "m" }),
    });
    expect(res.status).toBe(401);
  });

  it("401 with an unknown key", async () => {
    const res = await SELF.default.fetch(
      "https://localhost/v1/errors",
      authed("zv_unknown", {
        method: "POST",
        body: JSON.stringify({ project: "p", message: "m" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("401 with a wrong prefix", async () => {
    const res = await SELF.default.fetch(
      "https://localhost/v1/errors",
      authed("td_wrong", {
        method: "POST",
        body: JSON.stringify({ project: "p", message: "m" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("401 with a legacy v1 key", async () => {
    const key = "zv_legacyerrors00000000000000000000000000";
    await typedEnv.APIKEYS.put(
      await hashApiKey(key),
      JSON.stringify({ v: 1, userId: "legacy" }),
    );
    const res = await SELF.default.fetch(
      "https://localhost/v1/errors",
      authed(key, { method: "POST", body: JSON.stringify({ project: "p", message: "m" }) }),
    );
    expect(res.status).toBe(401);
  });
});

describe("Ingest and grouping", () => {
  it("first occurrence creates an issue (202, isNew)", async () => {
    const key = await putKey("org_ingest1", "user1");
    const res = await SELF.default.fetch(
      "https://localhost/v1/errors",
      authed(key, {
        method: "POST",
        body: JSON.stringify({
          project: "trippycards",
          message: "Cannot read trip 1",
          stack: "Error\n    at h (/a.ts:1:1)",
        }),
      }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { issueId: string; isNew: boolean };
    expect(body.isNew).toBe(true);
    expect(body.issueId).toBeTruthy();
  });

  it("rejects an invalid payload (400)", async () => {
    const key = await putKey("org_bad", "user_bad");
    const res = await SELF.default.fetch(
      "https://localhost/v1/errors",
      authed(key, { method: "POST", body: JSON.stringify({ project: "p" }) }),
    );
    expect(res.status).toBe(400);
  });

  it("same bug (varying ids) collapses to one issue with count=2", async () => {
    const key = await putKey("org_group", "user_g");
    const post = (msg: string) =>
      SELF.default.fetch(
        "https://localhost/v1/errors",
        authed(key, {
          method: "POST",
          body: JSON.stringify({
            project: "trippycards",
            message: msg,
            stack: "Error\n    at boom (/x.ts:2:2)",
          }),
        }),
      );

    const first = (await (await post("Cannot read trip 111")).json()) as {
      isNew: boolean;
    };
    const second = (await (await post("Cannot read trip 999")).json()) as {
      isNew: boolean;
    };
    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);

    const issues = await errorsDO("org_group").listIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0].count).toBe(2);
  });

  it("different bugs produce two issues", async () => {
    const key = await putKey("org_two", "user_t");
    const post = (body: object) =>
      SELF.default.fetch(
        "https://localhost/v1/errors",
        authed(key, { method: "POST", body: JSON.stringify(body) }),
      );
    await post({ project: "p", message: "boom A", stack: "Error\n    at a (/a.ts:1:1)" });
    await post({ project: "p", message: "boom B", stack: "Error\n    at b (/b.ts:1:1)" });

    const issues = await errorsDO("org_two").listIssues();
    expect(issues).toHaveLength(2);
  });

  it("prunes events to the cap while keeping the count", async () => {
    const key = await putKey("org_prune", "user_p");
    for (let n = 0; n < 55; n++) {
      await SELF.default.fetch(
        "https://localhost/v1/errors",
        authed(key, {
          method: "POST",
          body: JSON.stringify({
            project: "p",
            message: `repeat ${n}`,
            stack: "Error\n    at same (/s.ts:1:1)",
          }),
        }),
      );
    }

    const issues = await errorsDO("org_prune").listIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0].count).toBe(55);

    const detail = await errorsDO("org_prune").getIssue(issues[0].id);
    expect(detail?.events.length).toBe(50);
  });

  it("isolates issues per org", async () => {
    const keyA = await putKey("org_iso_a", "ua");
    const keyB = await putKey("org_iso_b", "ub");
    await SELF.default.fetch(
      "https://localhost/v1/errors",
      authed(keyA, { method: "POST", body: JSON.stringify({ project: "p", message: "only A" }) }),
    );

    const issuesB = await errorsDO("org_iso_b").listIssues();
    expect(issuesB).toHaveLength(0);
    void keyB;
  });
});

describe("Read and resolve API", () => {
  /** Ingest one error under `orgId` via the API key and return the issue id. */
  async function seedIssue(
    key: string,
    body: { project: string; message: string; stack?: string },
  ): Promise<string> {
    const res = await SELF.default.fetch(
      "https://localhost/v1/errors",
      authed(key, { method: "POST", body: JSON.stringify(body) }),
    );
    const parsed = (await res.json()) as { issueId: string };
    return parsed.issueId;
  }

  it("lists issues over /v1 with the API key", async () => {
    const key = await putKey("org_read1", "u");
    await seedIssue(key, { project: "web", message: "boom", stack: "E\n    at a (/a:1:1)" });

    const res = await SELF.default.fetch("https://localhost/v1/issues", authed(key));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issues: { project: string }[] };
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0].project).toBe("web");
  });

  it("filters the list by project", async () => {
    const key = await putKey("org_read2", "u");
    await seedIssue(key, { project: "web", message: "a", stack: "E\n    at a (/a:1:1)" });
    await seedIssue(key, { project: "api", message: "b", stack: "E\n    at b (/b:1:1)" });

    const res = await SELF.default.fetch(
      "https://localhost/v1/issues?project=api",
      authed(key),
    );
    const body = (await res.json()) as { issues: { project: string }[] };
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0].project).toBe("api");
  });

  it("returns issue detail with parsed context over /api", async () => {
    const key = await putKey("org_read3", "u");
    const id = await seedIssue(key, {
      project: "web",
      message: "ctx bug",
      stack: "E\n    at c (/c:1:1)",
    });
    // Add a second occurrence carrying context.
    await SELF.default.fetch(
      "https://localhost/v1/errors",
      authed(key, {
        method: "POST",
        body: JSON.stringify({
          project: "web",
          message: "ctx bug",
          stack: "E\n    at c (/c:1:1)",
          context: { route: "/api/trips/1" },
        }),
      }),
    );

    const app = createApp(typedEnv, { testUserId: "u" });
    const res = await app.fetch(
      new Request(`https://localhost/api/issues/${id}`, {
        headers: { "X-Org-Id": "org_read3" },
      }),
      typedEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      issue: { count: number };
      events: { context: Record<string, unknown> | null }[];
    };
    expect(body.issue.count).toBe(2);
    expect(body.events.length).toBe(2);
    const withCtx = body.events.find((e) => e.context !== null);
    expect(withCtx?.context).toEqual({ route: "/api/trips/1" });
  });

  it("404s for an unknown issue detail", async () => {
    const app = createApp(typedEnv, { testUserId: "u" });
    const res = await app.fetch(
      new Request("https://localhost/api/issues/nope", {
        headers: { "X-Org-Id": "org_read_missing" },
      }),
      typedEnv,
    );
    expect(res.status).toBe(404);
  });

  it("resolves and reopens an issue via PATCH", async () => {
    const key = await putKey("org_resolve", "u");
    const id = await seedIssue(key, {
      project: "web",
      message: "resolve me",
      stack: "E\n    at r (/r:1:1)",
    });

    const app = createApp(typedEnv, { testUserId: "u" });
    const patch = (status: string) =>
      app.fetch(
        new Request(`https://localhost/api/issues/${id}`, {
          method: "PATCH",
          headers: { "X-Org-Id": "org_resolve", "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        }),
        typedEnv,
      );

    const resolved = await patch("resolved");
    expect(resolved.status).toBe(200);
    expect(((await resolved.json()) as { issue: { status: string } }).issue.status).toBe(
      "resolved",
    );

    const reopened = await patch("open");
    expect(((await reopened.json()) as { issue: { status: string } }).issue.status).toBe(
      "open",
    );
  });

  it("rejects an invalid PATCH status (400)", async () => {
    const key = await putKey("org_badpatch", "u");
    const id = await seedIssue(key, {
      project: "web",
      message: "x",
      stack: "E\n    at x (/x:1:1)",
    });
    const app = createApp(typedEnv, { testUserId: "u" });
    const res = await app.fetch(
      new Request(`https://localhost/api/issues/${id}`, {
        method: "PATCH",
        headers: { "X-Org-Id": "org_badpatch", "Content-Type": "application/json" },
        body: JSON.stringify({ status: "bogus" }),
      }),
      typedEnv,
    );
    expect(res.status).toBe(400);
  });

  it("isolates the list per org", async () => {
    const keyA = await putKey("org_list_a", "ua");
    const keyB = await putKey("org_list_b", "ub");
    await seedIssue(keyA, { project: "web", message: "A only", stack: "E\n    at a (/a:1:1)" });

    const res = await SELF.default.fetch("https://localhost/v1/issues", authed(keyB));
    const body = (await res.json()) as { issues: unknown[] };
    expect(body.issues).toHaveLength(0);
  });
});

describe("Notification trigger", () => {
  class MockNotifier implements Notifier {
    calls: { id: string; kind: NotifyKind }[] = [];
    async notify(issue: IssueSummary, kind: NotifyKind): Promise<void> {
      this.calls.push({ id: issue.id, kind });
    }
  }

  async function postWith(app: ReturnType<typeof createApp>, key: string, message: string) {
    // Fake ExecutionContext that collects waitUntil promises so the test can
    // await the fire-and-forget notification before asserting.
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => pending.push(p),
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
    const res = await app.fetch(
      new Request("https://localhost/v1/errors", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ project: "p", message, stack: "Error\n    at n (/n.ts:1:1)" }),
      }),
      typedEnv,
      ctx,
    );
    await Promise.all(pending);
    return res;
  }

  it("fires once on the first occurrence and not on a repeat", async () => {
    const key = await putKey("org_notify", "un");
    const mock = new MockNotifier();
    const app = createApp(typedEnv, { notifier: mock });

    await postWith(app, key, "boom 1");
    await postWith(app, key, "boom 2");

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].kind).toBe("new");
  });

  it("fires again as a regression after the issue is resolved", async () => {
    const key = await putKey("org_regress", "ur");
    const mock = new MockNotifier();
    const app = createApp(typedEnv, { notifier: mock });

    await postWith(app, key, "boom 1");
    expect(mock.calls).toHaveLength(1);

    const issues = await errorsDO("org_regress").listIssues();
    await errorsDO("org_regress").setStatus(issues[0].id, "resolved");

    await postWith(app, key, "boom 2");
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[1].kind).toBe("regression");
  });
});
