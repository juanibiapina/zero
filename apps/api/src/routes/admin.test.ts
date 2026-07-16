import { describe, expect, it, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

import { createAdminRoutes } from "./admin";
import type { Env } from "../types";
import { getGithubInstallationStatus } from "../github-token";
import { listClerkUsers, getClerkUser } from "../admin-users";

vi.mock("../github-token", () => ({
  getGithubInstallationStatus: vi.fn(),
}));

vi.mock("../admin-users", () => ({
  listClerkUsers: vi.fn(),
  getClerkUser: vi.fn(),
}));

const { getUserDO } = vi.hoisted(() => ({ getUserDO: vi.fn() }));
vi.mock("../UserDO/stub", () => ({ getUserDO }));

const fakeEnv = (adminUserId: string): Env =>
  ({
    ADMIN_USER_ID: adminUserId,
  }) as unknown as Env;

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
    });
  });
});
