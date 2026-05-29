import { describe, expect, it, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

import type { UserDO } from "../UserDO/index";

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

type UserDOStub = Pick<UserDO, "getTelegramId" | "linkTelegram" | "unlinkTelegram" | "getSettings" | "updateSettings">;

const createFakeUserDO = (
  initial?: string,
): UserDOStub & { _telegramId: string | null; _onboardingSeen: boolean } => {
  let stored: string | null = initial ?? null;
  let onboardingSeen = false;
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
    getTelegramId: () => stored,
    linkTelegram: (telegramId: string) => {
      const previous = stored;
      stored = telegramId;
      return { previous };
    },
    unlinkTelegram: () => {
      const removed = stored;
      stored = null;
      return { removed };
    },
    getSettings: () => ({ onboardingSeen }),
    updateSettings: (patch: { onboardingSeen?: boolean }) => {
      if (patch.onboardingSeen !== undefined) onboardingSeen = patch.onboardingSeen;
    },
  };
};

const fakeEnv = (kv: ReturnType<typeof fakeKV>, userDO?: UserDOStub) => {
  return {
    KV: kv,
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    USER_DO: {
      idFromName: (_name: string) => ({ toString: () => "fake-id" }),
      get: () => userDO ?? createFakeUserDO(),
    },
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
    request: (path: string, init?: RequestInit) =>
      app.request(path, init, env),
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
  it("links telegram via DO and writes tg: KV entry", async () => {
    const kv = fakeKV();
    const userDO = createFakeUserDO();
    const env = fakeEnv(kv, userDO);
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
  });

  it("cleans up old tg: entry when re-linking", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    const userDO = createFakeUserDO("111");
    const env = fakeEnv(kv, userDO);
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
  it("unlinks telegram via DO and removes tg: KV entry", async () => {
    const kv = fakeKV({ "tg:12345": "user_abc" });
    const userDO = createFakeUserDO("12345");
    const env = fakeEnv(kv, userDO);
    const app = buildApp(env, "user_abc");

    const res = await app.request("/api/telegram-id", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ telegramId: null });
    expect(userDO.getTelegramId()).toBeNull();
    expect(kv._store.has("tg:12345")).toBe(false);
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
  it("returns onboardingSeen false by default", async () => {
    const kv = fakeKV();
    const userDO = createFakeUserDO();
    const app = buildApp(fakeEnv(kv, userDO), "user_abc");

    const res = await app.request("/api/user-settings");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ onboardingSeen: false });
  });

  it("returns onboardingSeen true after update", async () => {
    const kv = fakeKV();
    const userDO = createFakeUserDO();
    userDO._onboardingSeen = true;
    const app = buildApp(fakeEnv(kv, userDO), "user_abc");

    const res = await app.request("/api/user-settings");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ onboardingSeen: true });
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
    expect(await res.json()).toEqual({ onboardingSeen: true });
    expect(userDO._onboardingSeen).toBe(true);
  });

  it("resets onboardingSeen to false", async () => {
    const kv = fakeKV();
    const userDO = createFakeUserDO();
    userDO._onboardingSeen = true;
    const app = buildApp(fakeEnv(kv, userDO), "user_abc");

    const res = await app.request("/api/user-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ onboardingSeen: false }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ onboardingSeen: false });
    expect(userDO._onboardingSeen).toBe(false);
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
    expect(await res.json()).toEqual({ onboardingSeen: true });
    expect(userDO._onboardingSeen).toBe(true);
  });
});
