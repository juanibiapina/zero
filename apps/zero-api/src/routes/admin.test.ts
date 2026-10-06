import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

import {
  createAdminRoutes,
  MAX_ADMIN_TASK_PROMPT_CHARS,
} from "./admin";
import type { Env } from "../types";
import { getGithubInstallationStatus } from "../github-token";
import { listClerkUsers, getClerkUser } from "../admin-users";
import { getAdminUsage, getUserUsage } from "../admin-ai-usage";

vi.mock("../github-token", () => ({
  getGithubInstallationStatus: vi.fn(),
}));

vi.mock("../admin-users", () => ({
  listClerkUsers: vi.fn(),
  getClerkUser: vi.fn(),
}));

vi.mock("../admin-ai-usage", async (importOriginal) => {
  const original = await importOriginal<typeof import("../admin-ai-usage")>();
  return {
    ...original,
    getAdminUsage: vi.fn(),
    getUserUsage: vi.fn(),
  };
});

const { getUserDO, getAssistantDO } = vi.hoisted(() => ({
  getUserDO: vi.fn(),
  getAssistantDO: vi.fn(),
}));
vi.mock("../UserDO/stub", () => ({ getUserDO }));
vi.mock("../AssistantDO/stub", () => ({ getAssistantDO }));

const fakeEnv = (adminUserId: string): Env =>
  ({
    ADMIN_USER_ID: adminUserId,
  }) as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks();
});

const buildApp = (env: Env, userId: string) => {
  const app = new OpenAPIHono<{ Bindings: Env; Variables: { userId: string } }>();
  app.use("/api/*", async (c, next) => {
    c.set("userId", userId);
    await next();
  });
  app.route("/", createAdminRoutes());
  return {
    request: (path: string, init?: RequestInit) => app.request(path, init, env),
  };
};

describe("admin gate", () => {
  it("returns 403 for non-admin users", async () => {
    const app = buildApp(fakeEnv("admin_123"), "other_user");
    const res = await app.request("/api/admin/users");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("allows admin user through", async () => {
    vi.mocked(listClerkUsers).mockResolvedValue([]);
    const app = buildApp(fakeEnv("admin_123"), "admin_123");
    const res = await app.request("/api/admin/users");
    expect(res.status).toBe(200);
  });
});

describe("GET /api/admin/github/status", () => {
  const status = {
    githubConnected: true,
    githubUsername: "octocat",
    installationId: 42,
    tokenMinted: true,
    tokenPrefix: "ghs_",
    expiresAt: "2026-06-05T13:00:00Z",
  };

  it("returns 403 for non-admin users", async () => {
    const app = buildApp(fakeEnv("admin_123"), "other_user");
    const res = await app.request("/api/admin/github/status");
    expect(res.status).toBe(403);
  });

  it("returns non-secret diagnostics for the caller by default", async () => {
    vi.mocked(getGithubInstallationStatus).mockResolvedValue(status);
    const app = buildApp(fakeEnv("admin_1"), "admin_1");

    const res = await app.request("/api/admin/github/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(status);
    expect(getGithubInstallationStatus).toHaveBeenCalledWith(
      expect.anything(),
      "admin_1",
    );
  });

  it("checks the requested userId when provided", async () => {
    vi.mocked(getGithubInstallationStatus).mockResolvedValue(status);
    const app = buildApp(fakeEnv("admin_1"), "admin_1");

    await app.request("/api/admin/github/status?userId=user_target");
    expect(getGithubInstallationStatus).toHaveBeenCalledWith(
      expect.anything(),
      "user_target",
    );
  });
});

describe("GET /api/admin/users", () => {
  const identities = [
    { clerkUserId: "user_a", email: "a@example.com", username: "alice", createdAt: "2025-01-01T00:00:00Z" },
    { clerkUserId: "user_b", email: "b@example.com", username: null, createdAt: "2025-02-01T00:00:00Z" },
  ];

  it("returns 403 for non-admin users", async () => {
    const app = buildApp(fakeEnv("admin_1"), "other_user");
    const res = await app.request("/api/admin/users");
    expect(res.status).toBe(403);
  });

  it("returns the Clerk roster", async () => {
    vi.mocked(listClerkUsers).mockResolvedValue(identities);
    const app = buildApp(fakeEnv("admin_1"), "admin_1");

    const res = await app.request("/api/admin/users");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(identities);
  });

  it("does not read the UserDO", async () => {
    vi.mocked(listClerkUsers).mockResolvedValue(identities);
    const app = buildApp(fakeEnv("admin_1"), "admin_1");

    await app.request("/api/admin/users");
    expect(getUserDO).not.toHaveBeenCalled();
  });
});

describe("admin AI usage routes", () => {
  const totals = {
    estimatedCostUsd: 1.25,
    modelCalls: 3,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 20,
    cacheWrite5mTokens: 4,
    cacheWrite1hTokens: 6,
    unpricedModelCalls: 0,
    unpricedTokens: 0,
  };

  it("returns usage independently of the Clerk roster", async () => {
    vi.mocked(getAdminUsage).mockResolvedValue({
      range: "7d",
      totals,
      users: [{ userId: "user_1", ...totals }],
    });
    const app = buildApp(fakeEnv("admin_1"), "admin_1");

    const res = await app.request("/api/admin/ai-usage?range=7d");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      range: "7d",
      totals,
      users: [{ userId: "user_1", ...totals }],
    });
    expect(getAdminUsage).toHaveBeenCalledWith(expect.anything(), "7d");
    expect(listClerkUsers).not.toHaveBeenCalled();
  });

  it("returns a user's agent and conversation breakdown", async () => {
    vi.mocked(getUserUsage).mockResolvedValue({
      range: "30d",
      totals,
      byAgent: [{ agent: "interface", ...totals }],
      byConversation: [
        { conversationId: "conv_1", chatId: "42", topicId: "7", ...totals },
      ],
    });
    const app = buildApp(fakeEnv("admin_1"), "admin_1");

    const res = await app.request("/api/admin/users/user_1/ai-usage");

    expect(res.status).toBe(200);
    expect(getUserUsage).toHaveBeenCalledWith(
      expect.anything(),
      "user_1",
      "30d",
    );
  });

  it("returns a usage-only error without reading the roster", async () => {
    vi.mocked(getAdminUsage).mockRejectedValue(new Error("Cloudflare down"));
    const app = buildApp(fakeEnv("admin_1"), "admin_1");

    const res = await app.request("/api/admin/ai-usage");

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "AI usage unavailable" });
    expect(listClerkUsers).not.toHaveBeenCalled();
  });

  it("keeps the admin gate on usage routes", async () => {
    const app = buildApp(fakeEnv("admin_1"), "other_user");
    expect((await app.request("/api/admin/ai-usage")).status).toBe(403);
  });
});

describe("GET /api/admin/users/{userId}", () => {
  it("returns 403 for non-admin users", async () => {
    const app = buildApp(fakeEnv("admin_1"), "other_user");
    const res = await app.request("/api/admin/users/user_a");
    expect(res.status).toBe(403);
  });

  it("returns 404 when Clerk does not know the user", async () => {
    vi.mocked(getClerkUser).mockResolvedValue(null);
    const app = buildApp(fakeEnv("admin_1"), "admin_1");

    const res = await app.request("/api/admin/users/ghost");
    expect(res.status).toBe(404);
  });

  it("merges Clerk identity with UserDO link status", async () => {
    vi.mocked(getClerkUser).mockResolvedValue({
      clerkUserId: "user_a", email: "a@example.com", username: "alice",
      createdAt: "2025-01-01T00:00:00Z",
    });
    getUserDO.mockReturnValue({
      getTelegramId: async () => "12345",
      getSettings: async () => ({
        onboardingSeen: true,
        googleOnboardingStatus: "done",
        createdAt: "2025-01-01T00:00:00Z",
        braveKeyPaid: true,
        isNewUser: false,
      }),
    });
    const app = buildApp(fakeEnv("admin_1"), "admin_1");

    const res = await app.request("/api/admin/users/user_a");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      clerkUserId: "user_a", email: "a@example.com", username: "alice",
      createdAt: "2025-01-01T00:00:00Z",
      telegramId: "12345", googleOnboardingStatus: "done", onboardingSeen: true,
      braveKeyPaid: true,
    });
  });
});

describe("PUT /api/admin/users/{userId}/brave-plan", () => {
  const path = "/api/admin/users/user_a/brave-plan";
  const put = (paid: boolean) => ({
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paid }),
  });

  it("returns 403 for non-admin users", async () => {
    const app = buildApp(fakeEnv("admin_1"), "other_user");
    expect((await app.request(path, put(true))).status).toBe(403);
  });

  it("returns 404 when Clerk does not know the user", async () => {
    vi.mocked(getClerkUser).mockResolvedValue(null);
    const app = buildApp(fakeEnv("admin_1"), "admin_1");
    expect((await app.request(path, put(true))).status).toBe(404);
  });

  it("sets the flag via UserDO and echoes it back", async () => {
    vi.mocked(getClerkUser).mockResolvedValue({
      clerkUserId: "user_a", email: null, username: null,
      createdAt: "2025-01-01T00:00:00Z",
    });
    const setBravePaid = vi.fn(async () => {});
    getUserDO.mockReturnValue({ setBravePaid });
    const app = buildApp(fakeEnv("admin_1"), "admin_1");

    const res = await app.request(path, put(true));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clerkUserId: "user_a", paid: true });
    expect(setBravePaid).toHaveBeenCalledWith(true);
  });
});

describe("admin task", () => {
  const identity = {
    clerkUserId: "user_a",
    email: "a@example.com",
    username: "alice",
    createdAt: "2025-01-01T00:00:00Z",
  };
  const path = "/api/admin/users/user_a/task";

  it("rejects non-admin users", async () => {
    const app = buildApp(fakeEnv("admin_1"), "other_user");
    const res = await app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "notes" }),
    });
    expect(res.status).toBe(403);
  });

  it.each([
    {},
    { prompt: "" },
    { prompt: "   " },
    { prompt: "x".repeat(MAX_ADMIN_TASK_PROMPT_CHARS + 1) },
  ])("rejects an invalid task prompt", async (body) => {
    const app = buildApp(fakeEnv("admin_1"), "admin_1");
    const res = await app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
  });

  it("accepts a prompt at the maximum length", async () => {
    vi.mocked(getClerkUser).mockResolvedValue(identity);
    const queueAdminTask = vi.fn(async () => true);
    getUserDO.mockReturnValue({ queueAdminTask });
    const app = buildApp(fakeEnv("admin_1"), "admin_1");
    const prompt = "x".repeat(MAX_ADMIN_TASK_PROMPT_CHARS);

    const res = await app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });

    expect(res.status).toBe(202);
    expect(queueAdminTask).toHaveBeenCalledWith({
      clerkUserId: "user_a",
      prompt,
    });
  });

  it("checks Clerk before queueing", async () => {
    vi.mocked(getClerkUser).mockResolvedValue(null);
    const app = buildApp(fakeEnv("admin_1"), "admin_1");
    const callsBefore = getUserDO.mock.calls.length;
    const res = await app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "notes" }),
    });
    expect(res.status).toBe(404);
    expect(getUserDO).toHaveBeenCalledTimes(callsBefore);
  });

  it("queues a valid task prompt", async () => {
    vi.mocked(getClerkUser).mockResolvedValue(identity);
    const queueAdminTask = vi.fn(async () => true);
    getUserDO.mockReturnValue({ queueAdminTask });
    const app = buildApp(fakeEnv("admin_1"), "admin_1");
    const res = await app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Prepared notes" }),
    });
    expect(res.status).toBe(202);
    expect(queueAdminTask).toHaveBeenCalledWith({
      clerkUserId: "user_a",
      prompt: "Prepared notes",
    });
  });

  it("returns conflict while a task is queued", async () => {
    vi.mocked(getClerkUser).mockResolvedValue(identity);
    getUserDO.mockReturnValue({ queueAdminTask: async () => false });
    const app = buildApp(fakeEnv("admin_1"), "admin_1");
    const res = await app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Prepared notes" }),
    });
    expect(res.status).toBe(409);
  });

  it("returns 404 for an unknown user or missing task", async () => {
    vi.mocked(getClerkUser).mockResolvedValue(null);
    const app = buildApp(fakeEnv("admin_1"), "admin_1");
    expect((await app.request(path)).status).toBe(404);

    vi.mocked(getClerkUser).mockResolvedValue(identity);
    getUserDO.mockReturnValue({ getAdminTaskStatus: async () => null });
    expect((await app.request(path)).status).toBe(404);
  });

  it("returns only redacted task status", async () => {
    vi.mocked(getClerkUser).mockResolvedValue(identity);
    getUserDO.mockReturnValue({
      getAdminTaskStatus: async () => ({
        clerkUserId: "user_a",
        status: "done",
        summary: "Created [[Project]].",
      }),
    });
    const app = buildApp(fakeEnv("admin_1"), "admin_1");
    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      clerkUserId: "user_a",
      status: "done",
      summary: "Created [[Project]].",
    });
  });
});

describe("POST /api/admin/wake-sleepers", () => {
  const path = "/api/admin/wake-sleepers";
  const users = [
    { clerkUserId: "user_a", email: null, username: null, createdAt: "2025-01-01T00:00:00Z" },
    { clerkUserId: "user_b", email: null, username: null, createdAt: "2025-02-01T00:00:00Z" },
  ];

  // Pass a fake executionCtx so waitUntil's promise can be awaited in the test.
  const buildAppWithCtx = (env: Env, userId: string) => {
    const tasks: Promise<unknown>[] = [];
    const app = new OpenAPIHono<{ Bindings: Env; Variables: { userId: string } }>();
    app.use("/api/*", async (c, next) => {
      c.set("userId", userId);
      await next();
    });
    app.route("/", createAdminRoutes());
    const ctx = { waitUntil: (p: Promise<unknown>) => tasks.push(p), passThroughOnException: () => {} };
    return {
      request: (p: string, init?: RequestInit) =>
        app.request(p, init, env, ctx as unknown as ExecutionContext),
      settle: () => Promise.all(tasks),
    };
  };

  it("returns 403 for non-admin users", async () => {
    const app = buildApp(fakeEnv("admin_1"), "other_user");
    const res = await app.request(path, { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("returns 202 and wakes every user; the guard decides who is messaged", async () => {
    vi.mocked(listClerkUsers).mockResolvedValue(users);
    const wakeSleeper = vi.fn(async () => {});
    getUserDO.mockReturnValue({ wakeSleeper });
    const app = buildAppWithCtx(fakeEnv("admin_1"), "admin_1");

    const res = await app.request(path, { method: "POST" });
    expect(res.status).toBe(202);
    await app.settle();
    expect(getUserDO).toHaveBeenCalledWith(expect.anything(), "user_a");
    expect(getUserDO).toHaveBeenCalledWith(expect.anything(), "user_b");
    expect(wakeSleeper).toHaveBeenCalledTimes(2);
  });

  it("one failing user does not abort the backfill", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(listClerkUsers).mockResolvedValue(users);
    const wakeSleeper = vi
      .fn()
      .mockRejectedValueOnce(new Error("do down"))
      .mockResolvedValueOnce(undefined);
    getUserDO.mockReturnValue({ wakeSleeper });
    const app = buildAppWithCtx(fakeEnv("admin_1"), "admin_1");

    const res = await app.request(path, { method: "POST" });
    expect(res.status).toBe(202);
    await app.settle();
    expect(wakeSleeper).toHaveBeenCalledTimes(2);
  });
});

describe("POST /api/admin/assistant-import", () => {
  const path = "/api/admin/assistant-import";

  it("returns 403 for non-admin users", async () => {
    const app = buildApp(fakeEnv("admin_1"), "other_user");
    const res = await app.request(path, { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("imports every user's legacy conversations, carrying on past a failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(listClerkUsers).mockResolvedValue([
      { clerkUserId: "user_a", email: null, username: null, createdAt: "2025-01-01T00:00:00Z" },
      { clerkUserId: "user_b", email: null, username: null, createdAt: "2025-02-01T00:00:00Z" },
    ]);
    const importLegacy = vi
      .fn()
      .mockRejectedValueOnce(new Error("do down"))
      .mockResolvedValueOnce(undefined);
    getAssistantDO.mockReturnValue({ importLegacy });
    const tasks: Promise<unknown>[] = [];
    const app = new OpenAPIHono<{ Bindings: Env; Variables: { userId: string } }>();
    app.use("/api/*", async (c, next) => {
      c.set("userId", "admin_1");
      await next();
    });
    app.route("/", createAdminRoutes());
    const ctx = { waitUntil: (p: Promise<unknown>) => tasks.push(p), passThroughOnException: () => {} };

    const res = await app.request(path, { method: "POST" }, fakeEnv("admin_1"), ctx as unknown as ExecutionContext);
    expect(res.status).toBe(202);
    await Promise.all(tasks);
    expect(getAssistantDO).toHaveBeenCalledWith(expect.anything(), "user_a");
    expect(getAssistantDO).toHaveBeenCalledWith(expect.anything(), "user_b");
    expect(importLegacy).toHaveBeenCalledTimes(2);
  });
});
