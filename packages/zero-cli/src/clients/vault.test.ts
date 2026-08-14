import { describe, it, expect, vi, afterEach } from "vitest";
import { VaultClient } from "./vault.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function stubFetch(body: unknown) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("VaultClient", () => {
  it("surfaces both userId and orgId from whoami", async () => {
    stubFetch({ userId: "user_1", orgId: "org_1" });

    const info = await new VaultClient("https://example", "zv_key").whoami();

    expect(info).toEqual({ userId: "user_1", orgId: "org_1" });
  });

  it("prefixes every path with /vault/v1 on a bare origin", async () => {
    const fetchMock = stubFetch({ secrets: [] });

    await new VaultClient("https://api.zeroapps.dev", "zv_key").getSecrets("demo", "production");

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.zeroapps.dev/vault/v1/projects/demo/environments/production/secrets",
    );
  });

  it("reads API keys from the vault surface, since /keys/v1 does not exist", async () => {
    const fetchMock = stubFetch({ keys: [] });

    await new VaultClient("https://api.zeroapps.dev", "zv_key").listKeys();

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.zeroapps.dev/vault/v1/keys");
  });
});
