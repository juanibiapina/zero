import { describe, expect, it } from "vitest";

import type { Env } from "./types";
import { createApp } from "./app";

// A fake TASK_DO that records the name it was addressed by (the userId) and
// returns it back through listTasks, so a test can prove which userId the guard
// set. The rest of the surface is unused by the /api/tasks list route.
const fakeEnv = (environment: string | undefined): { env: Env; seen: () => string | null } => {
  let lastName: string | null = null;
  const stub = {
    listTasks: () => [
      {
        id: "id-1",
        text: lastName ?? "",
        showUpDate: "2023-11-14",
        createdAt: "2023-11-14T22:13:20.001Z",
        completedAt: null,
      },
    ],
  };
  const env = {
    ENVIRONMENT: environment,
    // Clerk test-format keys so clerkMiddleware constructs without throwing on
    // the non-test path; an invalid token then simply yields no auth (401).
    CLERK_SECRET_KEY: "sk_test_Zm9vYmFyYmF6cXV4",
    CLERK_PUBLISHABLE_KEY: "pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk",
    TASK_DO: {
      idFromName: (name: string) => {
        lastName = name;
        return { toString: () => name };
      },
      get: () => stub,
    },
  } as unknown as Env;
  return { env, seen: () => lastName };
};

const request = (env: Env, init?: RequestInit) =>
  createApp().fetch(new Request("http://localhost/api/tasks", init), env);

describe("api auth guard", () => {
  it("trusts the bearer as userId under ENVIRONMENT=test", async () => {
    const { env } = fakeEnv("test");
    const res = await request(env, {
      headers: { Authorization: "Bearer e2e-test-user" },
    });
    expect(res.status).toBe(200);
    const body: { tasks: { text: string }[] } = await res.json();
    // The route addressed the DO by the bearer, proving the guard set userId
    // from the token rather than from Clerk.
    expect(body.tasks[0]?.text).toBe("e2e-test-user");
  });

  it("401s under ENVIRONMENT=test with no bearer", async () => {
    const { env } = fakeEnv("test");
    const res = await request(env);
    expect(res.status).toBe(401);
  });

  it("runs the real Clerk guard (not the bypass) when ENVIRONMENT is not test", async () => {
    const { env, seen } = fakeEnv("production");
    const res = await request(env, {
      headers: { Authorization: "Bearer not-a-real-jwt" },
    });
    // The bypass is inert without the flag: the bearer is never trusted, so the
    // request is rejected by Clerk (401 unauthenticated or 500 on a malformed
    // token) and the tasks route is never reached with it as the userId.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(seen()).not.toBe("not-a-real-jwt");
  });
});
