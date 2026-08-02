import { afterEach, describe, expect, it, vi } from "vitest";
import { createBraveSearch } from "./brave";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// Real success headers from the paid Search plan, captured 2026-08-02. Each
// rate-limit header is `per-second, monthly`; the monthly component is 0 because
// that plan has no monthly cap.
const okHeaders = {
  "x-ratelimit-limit": "50, 0",
  "x-ratelimit-remaining": "49, 0",
  "x-ratelimit-reset": "1, 2528987",
  "server-timing": "search-roundtrip;dur=549.911",
};

const okResponse = (headers: Record<string, string> = okHeaders) =>
  new Response(
    JSON.stringify({
      web: {
        results: [
          { title: "T1", url: "https://a.com", description: "d1" },
          { title: "T2", url: "https://b.com", description: "d2" },
        ],
      },
    }),
    { status: 200, headers },
  );

const logLines = () => {
  const lines: unknown[] = [];
  const capture = (...args: unknown[]) => {
    lines.push(args[0]);
  };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  return lines as Record<string, unknown>[];
};

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

// Real 429 body from the paid Search plan, which has no monthly quota and
// reports that as `quota_limit: 0`. Captured 2026-08-02.
const searchPlanRateLimitBody = () =>
  JSON.stringify({
    type: "ErrorResponse",
    error: {
      status: 429,
      detail: "Request rate limit exceeded for plan",
      meta: {
        plan: "Search",
        rate_limit: 50,
        rate_current: 50,
        quota_limit: 0,
        quota_current: 14,
        component: "rate_limiter",
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

  it("retries a 429 on a plan with no monthly quota", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(searchPlanRateLimitBody(), {
          status: 429,
          headers: { "x-ratelimit-reset": "1, 2558678" },
        }),
      )
      .mockResolvedValueOnce(okResponse());
    globalThis.fetch = fetchMock;
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});

    const search = createBraveSearch("k", { sleep });
    const results = await search.search("q");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(2);
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

  describe("request logging", () => {
    it("logs one brave_request per successful call, with Brave's own accounting", async () => {
      const lines = logLines();
      globalThis.fetch = vi.fn<typeof fetch>(async () => okResponse());

      await createBraveSearch("k").search("hello");

      const requests = lines.filter((l) => l.msg === "brave_request");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        status: 200,
        attempt: 0,
        result_count: 2,
        upstream_ms: 550,
        rate_limit_sec: 50,
        rate_limit_month: 0,
        rate_remaining_sec: 49,
        rate_remaining_month: 0,
        rate_reset_sec: 1,
        rate_reset_month: 2528987,
      });
      expect(typeof requests[0].duration_ms).toBe("number");
    });

    it("reports a zero-result search", async () => {
      const lines = logLines();
      globalThis.fetch = vi.fn<typeof fetch>(
        async () => new Response(JSON.stringify({ web: { results: [] } }), { status: 200 }),
      );

      await createBraveSearch("k").search("nothing at all");

      expect(lines.find((l) => l.msg === "brave_request")).toMatchObject({
        result_count: 0,
      });
    });

    it("omits rate-limit fields rather than logging NaN when the headers are absent or malformed", async () => {
      const lines = logLines();
      globalThis.fetch = vi.fn<typeof fetch>(async () =>
        okResponse({ "x-ratelimit-limit": "oops", "server-timing": "junk" }),
      );

      await createBraveSearch("k").search("hello");

      const req = lines.find((l) => l.msg === "brave_request");
      expect(req).toBeDefined();
      expect(req?.rate_limit_sec).toBeUndefined();
      expect(req?.rate_remaining_sec).toBeUndefined();
      expect(req?.upstream_ms).toBeUndefined();
      expect(JSON.stringify(req)).not.toContain("null");
    });

    it("logs one brave_request per attempt, retries included", async () => {
      const lines = logLines();
      globalThis.fetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(rateLimited("1, 1270434"))
        .mockResolvedValueOnce(okResponse());

      await createBraveSearch("k", { sleep: async () => {} }).search("q");

      const requests = lines.filter((l) => l.msg === "brave_request");
      expect(requests.map((r) => r.attempt)).toEqual([0, 1]);
      expect(requests.map((r) => r.status)).toEqual([429, 200]);
    });

    it("names the plan and its limits on a rate-limited attempt", async () => {
      const lines = logLines();
      globalThis.fetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(searchPlanRateLimitBody(), {
            status: 429,
            headers: { "x-ratelimit-reset": "1, 2558678" },
          }),
        )
        .mockResolvedValueOnce(okResponse());

      await createBraveSearch("k", { sleep: async () => {} }).search("q");

      expect(lines.find((l) => l.msg === "brave_rate_limited")).toMatchObject({
        plan: "Search",
        rate_limit: 50,
        rate_current: 50,
        quota_limit: 0,
        quota_current: 14,
      });
    });

    it("reports how many requests a terminal failure spent", async () => {
      const lines = logLines();
      globalThis.fetch = vi
        .fn<typeof fetch>()
        .mockResolvedValue(rateLimited("1, 1270434"));

      await expect(
        createBraveSearch("k", { sleep: async () => {}, maxRetries: 2 }).search("q"),
      ).rejects.toThrow(/429/);

      expect(lines.find((l) => l.msg === "brave_request_failed")).toMatchObject({
        status: 429,
        attempts: 3,
      });
      expect(lines.filter((l) => l.msg === "brave_request")).toHaveLength(3);
    });

    it("logs the same hash for the same query and no query text", async () => {
      const lines = logLines();
      globalThis.fetch = vi.fn<typeof fetch>(async () => okResponse());
      const search = createBraveSearch("k");

      await search.search("juan medical appointment");
      await search.search("juan medical appointment");
      await search.search("something else");

      const hashes = lines
        .filter((l) => l.msg === "brave_request")
        .map((l) => l.query_hash);
      expect(hashes[0]).toBe(hashes[1]);
      expect(hashes[2]).not.toBe(hashes[0]);
      expect(JSON.stringify(lines)).not.toContain("medical");
    });
  });
});
