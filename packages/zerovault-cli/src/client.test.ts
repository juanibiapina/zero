import { describe, it, expect, vi, afterEach } from "vitest";
import { ZeroVaultClient } from "./client.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ZeroVaultClient.whoami", () => {
  it("surfaces both userId and orgId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ userId: "user_1", orgId: "org_1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const client = new ZeroVaultClient("https://example", "zv_key");
    const info = await client.whoami();

    expect(info).toEqual({ userId: "user_1", orgId: "org_1" });
  });
});
