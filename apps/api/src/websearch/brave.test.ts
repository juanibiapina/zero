import { afterEach, describe, expect, it, vi } from "vitest";
import { createBraveSearch } from "./brave";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const okResponse = () =>
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
  );

const rateLimitBody = (over: Partial<{ quota_current: number; quota_limit: number }> = {}) =>
  JSON.stringify({
    type: "ErrorResponse",
    error: {
      status: 429,
      detail: "Request rate limit exceeded for plan",
      meta: {
        plan: "Free",
        rate_limit: 1,
        rate_current: 1,
        quota_limit: over.quota_limit ?? 2000,
        quota_current: over.quota_current ?? 396,
      },
      code: "RATE_LIMITED",
    },
    time: 1,
  });

const rateLimited = (resetHeader?: string, bodyOver = {}) =>
  new Response(rateLimitBody(bodyOver), {
    status: 429,
    headers: resetHeader ? { "x-ratelimit-reset": resetHeader } : {},
  });

describe("createBraveSearch", () => {
  it("queries Brave and normalizes results", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => okResponse());
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

  it("retries after a per-second 429 and returns results", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(rateLimited("1, 1270434"))
      .mockResolvedValueOnce(okResponse());
    globalThis.fetch = fetchMock;
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});

    const search = createBraveSearch("k", { sleep });
    const results = await search.search("q");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    const delay = sleep.mock.calls[0][0];
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThan(1250);
  });

  it("throws immediately when the monthly quota is exhausted", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        rateLimited("1, 1270434", { quota_current: 2000, quota_limit: 2000 }),
      );
    globalThis.fetch = fetchMock;
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});

    const search = createBraveSearch("k", { sleep });
    await expect(search.search("q")).rejects.toThrow(/429/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("throws after retries are exhausted on a persistent 429", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(rateLimited("1, 1270434"));
    globalThis.fetch = fetchMock;
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});

    const search = createBraveSearch("k", { sleep, maxRetries: 2 });
    await expect(search.search("q")).rejects.toThrow(/429/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-429 error", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("nope", { status: 401 }));
    globalThis.fetch = fetchMock;
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});

    const search = createBraveSearch("k", { sleep });
    await expect(search.search("q")).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("falls back to the default delay when x-ratelimit-reset is absent", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(okResponse());
    globalThis.fetch = fetchMock;
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});

    const search = createBraveSearch("k", { sleep, defaultDelayMs: 500 });
    await search.search("q");

    const delay = sleep.mock.calls[0][0];
    expect(delay).toBeGreaterThanOrEqual(500);
    expect(delay).toBeLessThan(750);
  });
});
