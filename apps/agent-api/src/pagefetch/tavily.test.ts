import { afterEach, describe, expect, it, vi } from "vitest";
import { createTavilyFetcher } from "./tavily";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const okResponse = (rawContent = "# Title\n\nBody text.") =>
  new Response(
    JSON.stringify({
      results: [{ url: "https://example.com", raw_content: rawContent }],
      failed_results: [],
      response_time: 1.2,
    }),
    { status: 200 },
  );

describe("createTavilyFetcher", () => {
  it("posts to the Extract endpoint and normalizes raw_content", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => okResponse());
    globalThis.fetch = fetchMock;

    const fetcher = createTavilyFetcher("tvly-secret");
    const result = await fetcher.fetch("https://example.com");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.tavily.com/extract");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer tvly-secret",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      urls: "https://example.com",
      extract_depth: "basic",
      format: "markdown",
    });
    expect(result).toEqual({
      url: "https://example.com",
      content: "# Title\n\nBody text.",
    });
  });

  it("truncates content past the char cap with a marker", async () => {
    const long = "x".repeat(100);
    const fetchMock = vi.fn<typeof fetch>(async () => okResponse(long));
    globalThis.fetch = fetchMock;

    const fetcher = createTavilyFetcher("k", { maxContentChars: 10 });
    const result = await fetcher.fetch("https://example.com");

    expect(result.content).toBe(`${"x".repeat(10)}…[truncated]`);
  });

  it("throws immediately without fetching when the key is empty", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => okResponse());
    globalThis.fetch = fetchMock;

    const fetcher = createTavilyFetcher("");
    await expect(fetcher.fetch("https://example.com")).rejects.toThrow(
      /page fetch unavailable: TAVILY_API_KEY not configured/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when results is empty", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ results: [], failed_results: [], response_time: 1 }),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchMock;

    const fetcher = createTavilyFetcher("k");
    await expect(fetcher.fetch("https://example.com")).rejects.toThrow();
  });

  it("throws when the url is in failed_results", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            results: [],
            failed_results: [{ url: "https://example.com", error: "blocked" }],
            response_time: 1,
          }),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchMock;

    const fetcher = createTavilyFetcher("k");
    await expect(fetcher.fetch("https://example.com")).rejects.toThrow();
  });

  it("throws on a non-retryable non-2xx", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("nope", { status: 401 }));
    globalThis.fetch = fetchMock;
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});

    const fetcher = createTavilyFetcher("k", { sleep });
    await expect(fetcher.fetch("https://example.com")).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a 429 then succeeds", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(okResponse());
    globalThis.fetch = fetchMock;
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});

    const fetcher = createTavilyFetcher("k", { sleep });
    const result = await fetcher.fetch("https://example.com");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(result.content).toBe("# Title\n\nBody text.");
  });

  it("retries a 5xx then throws when retries are exhausted", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("boom", { status: 503 }));
    globalThis.fetch = fetchMock;
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});

    const fetcher = createTavilyFetcher("k", { sleep, maxRetries: 2 });
    await expect(fetcher.fetch("https://example.com")).rejects.toThrow(/503/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
