import { describe, expect, it, vi } from "vitest";
import { authenticate, hashApiKey } from "./index";

function kv(entries: Record<string, string>): KVNamespace {
  return {
    get: (key: string) => Promise.resolve(entries[key] ?? null),
  } as unknown as KVNamespace;
}

async function kvWithKey(key: string, value: unknown): Promise<KVNamespace> {
  return kv({ [await hashApiKey(key)]: JSON.stringify(value) });
}

const noOAuth = vi.fn(() => Promise.resolve(null));

describe("authenticate", () => {
  it("reports a missing header as missing, not invalid", async () => {
    const result = await authenticate(
      { apikeys: kv({}), verifyOAuthToken: noOAuth },
      undefined,
    );

    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("accepts a zv_ key and marks it as an api key", async () => {
    const apikeys = await kvWithKey("zv_live", { v: 2, orgId: "org_1", userId: "user_1" });

    const result = await authenticate(
      { apikeys, verifyOAuthToken: noOAuth },
      "Bearer zv_live",
    );

    expect(result).toEqual({
      ok: true,
      auth: { orgId: "org_1", userId: "user_1", via: "api_key" },
    });
  });

  it("never sends a zv_ key to the OAuth verifier", async () => {
    const verifyOAuthToken = vi.fn(() => Promise.resolve(null));
    const apikeys = kv({});

    await authenticate({ apikeys, verifyOAuthToken }, "Bearer zv_unknown");

    expect(verifyOAuthToken).not.toHaveBeenCalled();
  });

  it("rejects an unknown zv_ key as invalid", async () => {
    const result = await authenticate(
      { apikeys: kv({}), verifyOAuthToken: noOAuth },
      "Bearer zv_unknown",
    );

    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("accepts an OAuth token carrying an org", async () => {
    const verifyOAuthToken = vi.fn(() =>
      Promise.resolve({ userId: "user_2", orgId: "org_2" }),
    );

    const result = await authenticate(
      { apikeys: kv({}), verifyOAuthToken },
      "Bearer eyJhbGciOiJSUzI1NiIsevenmore",
    );

    expect(verifyOAuthToken).toHaveBeenCalledWith("eyJhbGciOiJSUzI1NiIsevenmore");
    expect(result).toEqual({
      ok: true,
      auth: { orgId: "org_2", userId: "user_2", via: "oauth" },
    });
  });

  it("separates a token without an org from an invalid one, so the caller can say which", async () => {
    const verifyOAuthToken = vi.fn(() =>
      Promise.resolve({ userId: "user_3", orgId: null }),
    );

    const result = await authenticate(
      { apikeys: kv({}), verifyOAuthToken },
      "Bearer token_without_org",
    );

    expect(result).toEqual({ ok: false, reason: "no_org" });
  });

  it("rejects an expired or revoked OAuth token as invalid", async () => {
    const result = await authenticate(
      { apikeys: kv({}), verifyOAuthToken: noOAuth },
      "Bearer revoked_token",
    );

    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("tolerates a header with no Bearer prefix", async () => {
    const apikeys = await kvWithKey("zv_bare", { v: 2, orgId: "org_4", userId: "user_4" });

    const result = await authenticate({ apikeys, verifyOAuthToken: noOAuth }, "zv_bare");

    expect(result).toEqual({
      ok: true,
      auth: { orgId: "org_4", userId: "user_4", via: "api_key" },
    });
  });

  it("rejects an empty header without calling the verifier", async () => {
    const verifyOAuthToken = vi.fn(() => Promise.resolve(null));

    const result = await authenticate({ apikeys: kv({}), verifyOAuthToken }, "Bearer ");

    expect(result).toEqual({ ok: false, reason: "missing" });
    expect(verifyOAuthToken).not.toHaveBeenCalled();
  });
});

describe("authenticate with a CI token", () => {
  const verifyCiToken = vi.fn((token: string) =>
    Promise.resolve(
      token === "zci_signed" ? { orgId: "org_ci", userId: "ci:github:777" } : null,
    ),
  );

  it("accepts a zci_ token minted for a workflow", async () => {
    const result = await authenticate(
      { apikeys: kv({}), verifyOAuthToken: noOAuth, verifyCiToken },
      "Bearer zci_signed",
    );

    expect(result).toEqual({
      ok: true,
      auth: { orgId: "org_ci", userId: "ci:github:777", via: "ci" },
    });
  });

  it("never sends a zci_ token to the OAuth verifier", async () => {
    const verifyOAuthToken = vi.fn(() => Promise.resolve(null));

    await authenticate(
      { apikeys: kv({}), verifyOAuthToken, verifyCiToken },
      "Bearer zci_unknown",
    );

    expect(verifyOAuthToken).not.toHaveBeenCalled();
  });

  it("never reads KV for a CI token, since the signature is the whole check", async () => {
    const get = vi.fn(() => Promise.resolve(null));
    const apikeys = { get } as unknown as KVNamespace;

    await authenticate({ apikeys, verifyOAuthToken: noOAuth, verifyCiToken }, "Bearer zci_signed");

    expect(get).not.toHaveBeenCalled();
  });

  it("treats a CI token the verifier rejects as invalid", async () => {
    const result = await authenticate(
      { apikeys: kv({}), verifyOAuthToken: noOAuth, verifyCiToken },
      "Bearer zci_expired",
    );

    expect(result).toEqual({ ok: false, reason: "invalid" });
  });
});
