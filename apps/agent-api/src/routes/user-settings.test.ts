import { describe, expect, it, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

import type { UserDO } from "../UserDO/index";
import { fakeAccountNamespace } from "../telegram/test-support";

// ---------------------------------------------------------------------------
// Mock only the auth verification, not the schema
// ---------------------------------------------------------------------------

vi.mock("../telegram-auth", async () => {
  const actual = await vi.importActual("../telegram-auth");
  return {
    ...actual,
    verifyTelegramAuth: vi.fn(),
  };
});

import { verifyTelegramAuth } from "../telegram-auth";
import { createUserSettingsRoutes } from "./user-settings";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const fakeKV = (entries: Record<string, string> = {}) => {
  const store = new Map(Object.entries(entries));
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    _store: store,
  } as unknown as KVNamespace & { _store: Map<string, string> };
};

type UserDOStub = Pick<UserDO, "getTelegramId" | "linkTelegram" | "unlinkTelegram" | "getSettings" | "updateSettings" | "setGoogleOnboardingStatus">;

const createFakeUserDO = (
  initial?: string,
): UserDOStub & { _telegramId: string | null; _onboardingSeen: boolean; _googleOnboardingStatus: string | null; _createdAt: string | null; _timezone: string | null; _country: string | null } => {
  let stored: string | null = initial ?? null;
  let onboardingSeen = false;
  let googleOnboardingStatus: string | null = null;
  let createdAt: string | null = null;
  let timezone: string | null = null;
  let country: string | null = null;
  let hasRow = false;
  return {
    get _telegramId() {
      return stored;
    },
    get _onboardingSeen() {
      return onboardingSeen;
    },
    set _onboardingSeen(v: boolean) {
      onboardingSeen = v;
    },
    get _createdAt() {
      return createdAt;
    },
    get _timezone() {
      return timezone;
    },
    get _country() {
      return country;
    },
    getTelegramId: () => stored,
    linkTelegram: (telegramId: string) => {
      const previous = stored;
      stored = telegramId;
      return { previous };
    },
    unlinkTelegram: () => {
      const removed = stored;
      stored = null;
      return Promise.resolve({ removed });
    },
    getSettings: () => {
      if (!hasRow) {
        createdAt = new Date().toISOString();
        hasRow = true;
        return { onboardingSeen, googleOnboardingStatus, createdAt, timezone, country, isNewUser: true };
      }
      return { onboardingSeen, googleOnboardingStatus, createdAt, timezone, country, isNewUser: false };
    },
    updateSettings: (patch: { onboardingSeen?: boolean; timezone?: string; country?: string }) => {
      if (patch.onboardingSeen !== undefined) onboardingSeen = patch.onboardingSeen;
      if (patch.timezone !== undefined) timezone = patch.timezone;
      if (patch.country !== undefined) country = patch.country;
    },
    setGoogleOnboardingStatus: (status: string) => {
      googleOnboardingStatus = status;
    },
    get _googleOnboardingStatus() {
      return googleOnboardingStatus;
    },
  };
};

const fakeAnalytics = () => ({
  writeDataPoint: vi.fn(),
});

const fakeEnv = (
  kv: ReturnType<typeof fakeKV>,
  userDO?: UserDOStub,
  analytics?: ReturnType<typeof fakeAnalytics>,
  accounts: ReturnType<typeof fakeAccountNamespace> = fakeAccountNamespace(),
) => {
  return {
    KV: kv,
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    ANALYTICS: analytics ?? fakeAnalytics(),
    USER_DO: {
      idFromName: (_name: string) => ({ toString: () => "fake-id" }),
      get: () => userDO ?? createFakeUserDO(),
    },
    TELEGRAM_ACCOUNT_DO: accounts.namespace,
  } as unknown as Env;
};

// Helper to build the Hono app with faked Clerk middleware
const buildApp = (env: Env, userId: string) => {
  const app = new OpenAPIHono<{ Bindings: Env; Variables: { userId: string } }>();
  // Fake Clerk auth — inject userId
  app.use("/api/*", async (c, next) => {
    c.set("userId", userId);
    await next();
  });
  app.route("/", createUserSettingsRoutes());
  return {
    request: (path: string, init?: RequestInit, cfCountry?: string) => {
      const request = new Request(`http://localhost${path}`, init);
      if (cfCountry !== undefined) {
        Object.defineProperty(request, "cf", {
          value: { country: cfCountry },
        });
      }
      return app.fetch(request, env);
    },
  };
};

// Valid Telegram Login Widget payload
const validPayload = (id: number) => ({
  id,
  first_name: "Test",
  auth_date: Math.floor(Date.now() / 1000),
  hash: "a".repeat(64),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/telegram-id", () => {
  it("returns null when no link exists", async () => {
    const kv = fakeKV();
    const userDO = createFakeUserDO();
    const app = buildApp(fakeEnv(kv, userDO), "user_abc");

    const res = await app.request("/api/telegram-id");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ telegramId: null });
  });

  it("returns the linked telegram id from DO", async () => {
    const kv = fakeKV();
    const userDO = createFakeUserDO("12345");
    const app = buildApp(fakeEnv(kv, userDO), "user_abc");

    const res = await app.request("/api/telegram-id");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ telegramId: "12345" });
  });
});

describe("POST /api/telegram-link", () => {
  it("links telegram via DO, claims the account and writes tg: KV entry", async () => {
    const kv = fakeKV();
    const userDO = createFakeUserDO();
    const accounts = fakeAccountNamespace();
    const env = fakeEnv(kv, userDO, undefined, accounts);
    const app = buildApp(env, "user_abc");

    vi.mocked(verifyTelegramAuth).mockResolvedValue(true);

    const res = await app.request("/api/telegram-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validPayload(12345)),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ telegramId: "12345" });
    expect(userDO.getTelegramId()).toBe("12345");
    expect(kv._store.get("tg:12345")).toBe("user_abc");
    expect(accounts.state.get("12345")).toBe("user_abc");
  });

  it("cleans up the old account and tg: entry when re-linking", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    const userDO = createFakeUserDO("111");
    const accounts = fakeAccountNamespace({ "111": "user_abc" });
    const env = fakeEnv(kv, userDO, undefined, accounts);
    const app = buildApp(env, "user_abc");

    vi.mocked(verifyTelegramAuth).mockResolvedValue(true);

    const res = await app.request("/api/telegram-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validPayload(222)),
    });

    expect(res.status).toBe(200);
    expect(kv._store.has("tg:111")).toBe(false);
    expect(kv._store.get("tg:222")).toBe("user_abc");
    expect(accounts.state.get("111")).toBeUndefined();
    expect(accounts.state.get("222")).toBe("user_abc");
  });

  it("rejects invalid auth", async () => {
    const kv = fakeKV();
    const userDO = createFakeUserDO();
    const app = buildApp(fakeEnv(kv, userDO), "user_abc");

    vi.mocked(verifyTelegramAuth).mockResolvedValue(false);

    const res = await app.request("/api/telegram-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validPayload(12345)),
    });

    expect(res.status).toBe(401);
    expect(userDO.getTelegramId()).toBeNull();
  });
});

describe("DELETE /api/telegram-id", () => {
  it("unlinks telegram via DO and clears both stores", async () => {
    const kv = fakeKV({ "tg:12345": "user_abc" });
    const userDO = createFakeUserDO("12345");
    const accounts = fakeAccountNamespace({ "12345": "user_abc" });
    const env = fakeEnv(kv, userDO, undefined, accounts);
    const app = buildApp(env, "user_abc");

    const res = await app.request("/api/telegram-id", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ telegramId: null });
    expect(userDO.getTelegramId()).toBeNull();
    expect(kv._store.has("tg:12345")).toBe(false);
    expect(accounts.state.get("12345")).toBeUndefined();
  });

  it("returns null when nothing was linked", async () => {
    const kv = fakeKV();
    const userDO = createFakeUserDO();
    const app = buildApp(fakeEnv(kv, userDO), "user_abc");

    const res = await app.request("/api/telegram-id", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ telegramId: null });
  });
});

describe("GET /api/user-settings", () => {
  it("returns settings with createdAt on first access", async () => {
    const kv = fakeKV();
    const userDO = createFakeUserDO();
    const analytics = fakeAnalytics();
    const app = buildApp(fakeEnv(kv, userDO, analytics), "user_abc");

    const res = await app.request("/api/user-settings");
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.onboardingSeen).toBe(false);
    expect(body.googleOnboardingStatus).toBeNull();
    expect(body.createdAt).toBeDefined();
    expect(body).not.toHaveProperty("isNewUser");
  });

  it("writes signup analytics event on first access", async () => {
    const kv = fakeKV();
    const userDO = createFakeUserDO();
    const analytics = fakeAnalytics();
    const app = buildApp(fakeEnv(kv, userDO, analytics), "user_abc");

    await app.request("/api/user-settings");
    expect(analytics.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["signup"],
      indexes: ["user_abc"],
    });
  });

  it("does not write signup analytics event on subsequent access", async () => {
    const kv = fakeKV();
    const userDO = createFakeUserDO();
    const analytics = fakeAnalytics();
    const app = buildApp(fakeEnv(kv, userDO, analytics), "user_abc");

    await app.request("/api/user-settings");
    analytics.writeDataPoint.mockClear();
    await app.request("/api/user-settings");
    expect(analytics.writeDataPoint).not.toHaveBeenCalled();
  });

  it("stores and returns Cloudflare's country without rewriting it", async () => {
    const userDO = createFakeUserDO();
    const update = vi.spyOn(userDO, "updateSettings");
    const app = buildApp(fakeEnv(fakeKV(), userDO), "user_abc");

    const first = await app.request("/api/user-settings", undefined, "DE");
    expect(await first.json()).toMatchObject({ country: "DE" });
    expect(userDO._country).toBe("DE");
    expect(update).toHaveBeenCalledTimes(1);

    await app.request("/api/user-settings", undefined, "DE");
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("does not store Cloudflare's unknown or Tor country markers", async () => {
    const userDO = createFakeUserDO();
    const update = vi.spyOn(userDO, "updateSettings");
    const app = buildApp(fakeEnv(fakeKV(), userDO), "user_abc");

    const response = await app.request("/api/user-settings", undefined, "XX");
    expect(await response.json()).toMatchObject({ country: null });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/user-settings", () => {
  it("sets onboardingSeen to true", async () => {
    const kv = fakeKV();
    const userDO = createFakeUserDO();
    const app = buildApp(fakeEnv(kv, userDO), "user_abc");

    const res = await app.request("/api/user-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ onboardingSeen: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.onboardingSeen).toBe(true);
    expect(body.createdAt).toBeDefined();
    expect(userDO._onboardingSeen).toBe(true);
  });

  it("writes onboarding_completed analytics when onboardingSeen flips false to true", async () => {
    const kv = fakeKV();
    const userDO = createFakeUserDO();
    const analytics = fakeAnalytics();
    const app = buildApp(fakeEnv(kv, userDO, analytics), "user_abc");

    // First call seeds createdAt via getSettings
    await app.request("/api/user-settings");
    analytics.writeDataPoint.mockClear();

    const res = await app.request("/api/user-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ onboardingSeen: true }),
    });
    expect(res.status).toBe(200);
    expect(analytics.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["onboarding_completed"],
      doubles: [expect.any(Number)],
      indexes: ["user_abc"],
    });
  });

  it("does not write analytics when onboardingSeen is already true", async () => {
    const kv = fakeKV();
    const userDO = createFakeUserDO();
    const analytics = fakeAnalytics();
    const app = buildApp(fakeEnv(kv, userDO, analytics), "user_abc");

    // Seed + set onboarding seen
    await app.request("/api/user-settings");
    userDO._onboardingSeen = true;
    analytics.writeDataPoint.mockClear();

    const res = await app.request("/api/user-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ onboardingSeen: true }),
    });
    expect(res.status).toBe(200);
    expect(analytics.writeDataPoint).not.toHaveBeenCalled();
  });

  it("empty body does not change settings", async () => {
    const kv = fakeKV();
    const userDO = createFakeUserDO();
    userDO._onboardingSeen = true;
    const app = buildApp(fakeEnv(kv, userDO), "user_abc");

    const res = await app.request("/api/user-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.onboardingSeen).toBe(true);
    expect(userDO._onboardingSeen).toBe(true);
  });

  it("stores a valid IANA timezone and returns it", async () => {
    const kv = fakeKV();
    const userDO = createFakeUserDO();
    const app = buildApp(fakeEnv(kv, userDO), "user_abc");

    const res = await app.request("/api/user-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone: "America/Sao_Paulo" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.timezone).toBe("America/Sao_Paulo");
    expect(userDO._timezone).toBe("America/Sao_Paulo");
  });

  it("rejects a non-IANA timezone with 400 and does not store it", async () => {
    const kv = fakeKV();
    const userDO = createFakeUserDO();
    const app = buildApp(fakeEnv(kv, userDO), "user_abc");

    const res = await app.request("/api/user-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone: "Mars/Phobos" }),
    });
    expect(res.status).toBe(400);
    expect(userDO._timezone).toBeNull();
  });

  it("exposes timezone on GET (null before set)", async () => {
    const kv = fakeKV();
    const userDO = createFakeUserDO();
    const app = buildApp(fakeEnv(kv, userDO), "user_abc");

    const res = await app.request("/api/user-settings");
    const body = await res.json<Record<string, unknown>>();
    expect(body.timezone).toBeNull();
  });

  it("uses the browser region when Cloudflare has no usable country", async () => {
    const userDO = createFakeUserDO();
    const app = buildApp(fakeEnv(fakeKV(), userDO), "user_abc");

    const res = await app.request(
      "/api/user-settings",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region: "pt" }),
      },
      "T1",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ country: "PT" });
    expect(userDO._country).toBe("PT");
  });

  it("rejects a malformed browser region", async () => {
    const userDO = createFakeUserDO();
    const app = buildApp(fakeEnv(fakeKV(), userDO), "user_abc");

    const res = await app.request("/api/user-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ region: "USA" }),
    });
    expect(res.status).toBe(400);
    expect(userDO._country).toBeNull();
  });
});
