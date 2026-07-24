import { env } from "cloudflare:workers";
import type { Context, Next } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createDashboardApp } from "../dashboard-app";
import type { Env } from "../types";

vi.mock("@clerk/hono", () => ({
  clerkMiddleware: () => async (c: Context, next: Next) => {
    const redirect = c.req.header("X-Test-Clerk-Redirect");
    if (redirect) {
      return c.redirect(redirect, 307);
    }
    await next();
  },
  getAuth: (c: Context) => ({
    userId: c.req.header("X-Test-Clerk-User-Id"),
    orgId: c.req.header("X-Test-Clerk-Org-Id"),
  }),
}));

const typedEnv = env as Env;

function request(headers: Record<string, string> = {}) {
  return createDashboardApp(typedEnv).fetch(
    new Request("https://localhost/api/errors/issues", { headers }),
    typedEnv,
  );
}

describe("Clerk authentication", () => {
  it("returns 401 without a user", async () => {
    const response = await request();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns 403 without an active organization", async () => {
    const response = await request({ "X-Test-Clerk-User-Id": "user_clerk" });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "No active organization" });
  });

  it("uses the active organization for protected routes", async () => {
    const orgId = `org_clerk_${crypto.randomUUID()}`;
    const issueTitle = `issue-${crypto.randomUUID()}`;
    const errors = typedEnv.ERRORSDO.get(typedEnv.ERRORSDO.idFromName(orgId));
    const seeded = await errors.record({
      fingerprint: crypto.randomUUID(),
      project: "clerk-auth",
      title: issueTitle,
      level: "error",
      message: issueTitle,
      userId: "user_clerk",
      now: new Date().toISOString(),
    });

    const response = await request({
      "X-Test-Clerk-User-Id": "user_clerk",
      "X-Test-Clerk-Org-Id": orgId,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { issues: { id: string; title: string }[] };
    expect(body.issues).toEqual([
      expect.objectContaining({ id: seeded.issue.id, title: issueTitle }),
    ]);
  });

  it("preserves Clerk middleware redirects", async () => {
    const location = "https://accounts.example.test/sign-in";
    const response = await request({ "X-Test-Clerk-Redirect": location });

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe(location);
  });
});
