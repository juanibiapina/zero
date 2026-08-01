import { describe, expect, it, vi } from "vitest";

import {
  linkTelegramAccount,
  resolveClerkUserId,
  unlinkTelegramAccount,
} from "./identity";
import { fakeAccountNamespace } from "./test-support";
import type { Env } from "../types";

const fakeKV = (entries: Record<string, string> = {}) => {
  const store = new Map(Object.entries(entries));
  return {
    _store: store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };
};

const fakeAccounts = fakeAccountNamespace;

const fakeEnv = (
  kv: ReturnType<typeof fakeKV>,
  accounts: ReturnType<typeof fakeAccounts>,
): Env =>
  ({
    KV: kv,
    TELEGRAM_ACCOUNT_DO: accounts.namespace,
  }) as unknown as Env;

describe("resolveClerkUserId", () => {
  it("answers from KV without consulting the account record", async () => {
    const accounts = fakeAccounts({ "111": "user_abc" });
    const env = fakeEnv(fakeKV({ "tg:111": "user_abc" }), accounts);

    expect(await resolveClerkUserId(env, "111")).toBe("user_abc");
    expect(accounts.calls).toEqual([]);
  });

  it("falls back to the account record when KV misses", async () => {
    const accounts = fakeAccounts({ "111": "user_abc" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const env = fakeEnv(fakeKV(), accounts);

    expect(await resolveClerkUserId(env, "111")).toBe("user_abc");
    expect(accounts.calls).toEqual([["111", "owner"]]);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: "telegram_account_fallback",
        telegram_id: "111",
        clerk_user_id: "user_abc",
      }),
    );
    log.mockRestore();
  });

  it("returns null when neither store knows the account", async () => {
    const accounts = fakeAccounts();
    const env = fakeEnv(fakeKV(), accounts);

    expect(await resolveClerkUserId(env, "111")).toBeNull();
  });
});

describe("linkTelegramAccount", () => {
  it("claims the account and caches it in KV", async () => {
    const kv = fakeKV();
    const accounts = fakeAccounts();

    await linkTelegramAccount(fakeEnv(kv, accounts), "111", "user_abc");

    expect(accounts.state.get("111")).toBe("user_abc");
    expect(kv._store.get("tg:111")).toBe("user_abc");
    // Authoritative store first, cache second.
    expect(accounts.calls[0]).toEqual(["111", "claim"]);
  });

  it("releases the previous account in both stores on a re-link", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    const accounts = fakeAccounts({ "111": "user_abc" });

    await linkTelegramAccount(
      fakeEnv(kv, accounts),
      "222",
      "user_abc",
      "111",
    );

    expect(accounts.state.get("111")).toBeUndefined();
    expect(kv._store.has("tg:111")).toBe(false);
    expect(accounts.state.get("222")).toBe("user_abc");
    expect(kv._store.get("tg:222")).toBe("user_abc");
  });

  it("keeps the account when re-linking the same id", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    const accounts = fakeAccounts({ "111": "user_abc" });

    await linkTelegramAccount(
      fakeEnv(kv, accounts),
      "111",
      "user_abc",
      "111",
    );

    expect(accounts.state.get("111")).toBe("user_abc");
    expect(kv._store.get("tg:111")).toBe("user_abc");
  });
});

describe("unlinkTelegramAccount", () => {
  it("clears both stores", async () => {
    const kv = fakeKV({ "tg:111": "user_abc" });
    const accounts = fakeAccounts({ "111": "user_abc" });

    await unlinkTelegramAccount(fakeEnv(kv, accounts), "111");

    expect(accounts.state.get("111")).toBeUndefined();
    expect(kv._store.has("tg:111")).toBe(false);
    expect(await resolveClerkUserId(fakeEnv(kv, accounts), "111")).toBeNull();
  });
});
