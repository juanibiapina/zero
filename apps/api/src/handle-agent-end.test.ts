import { describe, expect, it, vi } from "vitest";

import type { UserDO } from "./UserDO/index";
import { handleAgentEnd } from "./handle-agent-end";
import type { Env } from "./types";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type UserDOStub = Pick<UserDO, "lookupSessionById" | "markSessionIdle" | "setGoogleOnboardingStatus" | "getSettings">;

const createFakeUserDO = () => {
  let googleOnboardingStatus: string | null = null;
  const createdAt = new Date().toISOString();
  const sessions = new Map<string, { type: string; chatId: number; topicId: number; name?: string }>();
  const idleCalls: Array<[number, number]> = [];
  return {
    get _googleOnboardingStatus() { return googleOnboardingStatus; },
    _idleCalls: idleCalls,
    lookupSessionById: (sessionId: string) => sessions.get(sessionId) ?? null,
    markSessionIdle: async (chatId: number, topicId: number) => { idleCalls.push([chatId, topicId]); },
    setGoogleOnboardingStatus: (status: string) => { googleOnboardingStatus = status; },
    getSettings: () => ({ onboardingSeen: false, googleOnboardingStatus, createdAt, isNewUser: false }),
    _seed(sessionId: string, record: { type: string; chatId: number; topicId: number; name?: string }) {
      sessions.set(sessionId, record);
    },
  };
};

const fakeEnv = (userDO: UserDOStub, analytics?: { writeDataPoint: ReturnType<typeof vi.fn> }): Env =>
  ({
    ANALYTICS: analytics ?? { writeDataPoint: vi.fn() },
    USER_DO: {
      idFromName: () => ({ toString: () => "fake-id" }),
      get: () => userDO,
    },
  }) as unknown as Env;

const agentEndRequest = (body: object) =>
  new Request("http://zero.worker/agent-end", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleAgentEnd", () => {
  it("marks google-onboarding done when named task finishes", async () => {
    const userDO = createFakeUserDO();
    userDO._seed("sess-1", { type: "task", chatId: 0, topicId: 0, name: "google-onboarding" });

    const res = await handleAgentEnd(
      agentEndRequest({ sessionId: "sess-1", clerkUserId: "user_abc", willRetry: false }),
      fakeEnv(userDO),
    );

    expect(res.status).toBe(204);
    expect(userDO._googleOnboardingStatus).toBe("done");
  });

  it("does not mark done when willRetry is true", async () => {
    const userDO = createFakeUserDO();
    userDO._seed("sess-1", { type: "task", chatId: 0, topicId: 0, name: "google-onboarding" });

    await handleAgentEnd(
      agentEndRequest({ sessionId: "sess-1", clerkUserId: "user_abc", willRetry: true }),
      fakeEnv(userDO),
    );

    expect(userDO._googleOnboardingStatus).toBeNull();
  });

  it("does not mark done for unnamed task sessions", async () => {
    const userDO = createFakeUserDO();
    userDO._seed("sess-1", { type: "task", chatId: 0, topicId: 0 });

    await handleAgentEnd(
      agentEndRequest({ sessionId: "sess-1", clerkUserId: "user_abc", willRetry: false }),
      fakeEnv(userDO),
    );

    expect(userDO._googleOnboardingStatus).toBeNull();
  });

  it("marks telegram session idle when willRetry is false", async () => {
    const userDO = createFakeUserDO();
    userDO._seed("sess-1", { type: "telegram", chatId: 100, topicId: 200 });

    await handleAgentEnd(
      agentEndRequest({ sessionId: "sess-1", clerkUserId: "user_abc", willRetry: false }),
      fakeEnv(userDO),
    );

    expect(userDO._idleCalls).toEqual([[100, 200]]);
    expect(userDO._googleOnboardingStatus).toBeNull();
  });

  it("writes google_onboarding_done analytics event when task finishes", async () => {
    const userDO = createFakeUserDO();
    userDO._seed("sess-1", { type: "task", chatId: 0, topicId: 0, name: "google-onboarding" });
    const analytics = { writeDataPoint: vi.fn() };

    await handleAgentEnd(
      agentEndRequest({ sessionId: "sess-1", clerkUserId: "user_abc", willRetry: false }),
      fakeEnv(userDO, analytics),
    );

    expect(analytics.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["google_onboarding_done"],
      doubles: [expect.any(Number)],
      indexes: ["user_abc"],
    });
  });
});
