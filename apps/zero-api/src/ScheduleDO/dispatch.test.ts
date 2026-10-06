import { describe, expect, it } from "vitest";
import { dispatchFor } from "./dispatch";
import type { Env } from "../types";

// Every reason a deadline can carry. Written out rather than derived from the
// table, so this list is what fails when a reason is added without a handler.
const REASONS = [
  "idle",
  "size",
  "onboarding",
  "admin_task",
  "reminder",
  "mailwatch",
  "wake",
] as const;

// A fake env whose namespaces hand back a recording stub, so a dispatch can be
// followed to the object and method it calls without a Durable Object.
const fakeEnv = () => {
  const calls: string[] = [];
  const stub = (label: string) =>
    new Proxy(
      {},
      {
        get:
          (_t, method: string) =>
          (...args: unknown[]) => {
            calls.push(`${label}.${method}(${args.join(",")})`);
            return Promise.resolve();
          },
      },
    );
  const namespace = (label: string) => ({
    idFromName: (name: string) => name,
    get: () => stub(label),
  });
  return {
    calls,
    env: {
      USER_DO: namespace("UserDO"),
      ASSISTANT_DO: namespace("AssistantDO"),
    } as unknown as Env,
  };
};

describe("dispatchFor", () => {
  it("claims every reason a deadline can carry", () => {
    for (const reason of REASONS) expect(dispatchFor(reason)).not.toBeNull();
  });

  it("claims nothing else, so a retired reason is dropped rather than retried", () => {
    expect(dispatchFor("learn")).toBeNull();
    expect(dispatchFor("")).toBeNull();
    // Not fooled by inherited object properties.
    expect(dispatchFor("toString")).toBeNull();
    expect(dispatchFor("constructor")).toBeNull();
  });

  it("sends learning to AssistantDO with its conversation", async () => {
    const { calls, env } = fakeEnv();
    await dispatchFor("idle")!({ env, clerkUserId: "user_1", conversationId: "c1" });
    await dispatchFor("size")!({ env, clerkUserId: "user_1", conversationId: "c1" });
    expect(calls).toEqual([
      "AssistantDO.learn(idle,c1)",
      "AssistantDO.learn(size,c1)",
    ]);
  });

  it("sends a due schedule to UserDO, which only queues the prompt", async () => {
    const { calls, env } = fakeEnv();
    await dispatchFor("reminder")!({ env, clerkUserId: "user_1" });
    expect(calls).toEqual(["UserDO.runDueSchedules()"]);
  });

  it("sends the mail poll to UserDO, which only queues what it finds", async () => {
    const { calls, env } = fakeEnv();
    await dispatchFor("mailwatch")!({ env, clerkUserId: "user_1" });
    expect(calls).toEqual(["UserDO.checkTrackedMail()"]);
  });

  it("sends the wake deadline to UserDO, which only queues the re-engagement", async () => {
    const { calls, env } = fakeEnv();
    await dispatchFor("wake")!({ env, clerkUserId: "user_1" });
    expect(calls).toEqual(["UserDO.wakeSleeper()"]);
  });

  it("sends the user-wide jobs to their own UserDO entry points", async () => {
    const { calls, env } = fakeEnv();
    await dispatchFor("onboarding")!({ env, clerkUserId: "user_1" });
    await dispatchFor("admin_task")!({ env, clerkUserId: "user_1" });
    expect(calls).toEqual([
      "UserDO.runQueuedOnboarding()",
      "UserDO.runQueuedAdminTask()",
    ]);
  });
});
