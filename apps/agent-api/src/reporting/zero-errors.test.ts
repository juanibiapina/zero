import { afterEach, describe, expect, it, vi } from "vitest";
import { reportError } from "./zero-errors";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const mockFetch = () => {
  const fn = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(null, { status: 202 }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
};

describe("reportError", () => {
  it("posts the error to the ingest endpoint with the bearer key", async () => {
    const fetchFn = mockFetch();

    await reportError({ ZEROVAULT_API_KEY: "zv_test" }, new Error("boom"), {
      site: "alarm_turn",
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://errors.apps.juanibiapina.dev/v1/errors");
    expect(init?.method).toBe("POST");
    expect(
      (init?.headers as Record<string, string>).authorization,
    ).toBe("Bearer zv_test");

    const body = JSON.parse(init?.body as string) as {
      project: string;
      message: string;
      stack?: string;
      context: Record<string, unknown>;
    };
    expect(body.project).toBe("zero-agent");
    expect(body.message).toBe("boom");
    expect(typeof body.stack).toBe("string");
    expect(body.context.site).toBe("alarm_turn");
  });

  it("folds API-error detail (status, headers) into the event context", async () => {
    const fetchFn = mockFetch();
    const apiErr = Object.assign(new Error("rate limited"), {
      statusCode: 429,
      responseHeaders: { "retry-after": "30", "cf-ray": "abc" },
    });

    await reportError({ ZEROVAULT_API_KEY: "zv_test" }, apiErr);

    const init = fetchFn.mock.calls[0][1];
    const body = JSON.parse(init?.body as string) as {
      context: { statusCode?: number; rateLimitHeaders?: Record<string, string> };
    };
    expect(body.context.statusCode).toBe(429);
    expect(body.context.rateLimitHeaders?.["retry-after"]).toBe("30");
  });

  it("never rejects when the transport fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    await expect(
      reportError({ ZEROVAULT_API_KEY: "zv_test" }, new Error("boom")),
    ).resolves.toBeUndefined();
  });
});
