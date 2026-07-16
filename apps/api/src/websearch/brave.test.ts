import { afterEach, describe, expect, it, vi } from "vitest";
import { createBraveSearch } from "./brave";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("createBraveSearch", () => {
  it("queries Brave and normalizes results", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            web: {
              results: [
                { title: "T1", url: "https://a.com", description: "d1" },
                { title: "T2", url: "https://b.com", description: "d2" },
              ],
            },
          }),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchMock;

    const search = createBraveSearch("secret-key");
    const results = await search.search("hello world");

    const [url, init] = fetchMock.mock.calls[0];
    if (typeof url !== "string") throw new Error("expected a string url");
    expect(url).toContain("q=hello%20world");
    expect(init?.headers).toMatchObject({
      "X-Subscription-Token": "secret-key",
    });
    expect(results).toEqual([
      { title: "T1", url: "https://a.com", snippet: "d1" },
      { title: "T2", url: "https://b.com", snippet: "d2" },
    ]);
  });

  it("throws on a non-ok response", async () => {
    globalThis.fetch = vi.fn<typeof fetch>(
      async () => new Response("nope", { status: 429 }),
    );

    const search = createBraveSearch("k");
    await expect(search.search("q")).rejects.toThrow(/429/);
  });
});
