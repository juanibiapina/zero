import { afterEach, describe, expect, it, vi } from "vitest";
import { reportError } from "./zero-errors";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const PROD = { ZERO_API_KEY: "zv_test", ENVIRONMENT: "production" };

const mockFetch = (status = 202) => {
  const fn = vi.fn(
    async (_url: string, _init?: RequestInit) => new Response(null, { status }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
};

const bodyOf = (init?: RequestInit) =>
  JSON.parse(init?.body as string) as {
    project: string;
    message: string;
    stack?: string;
    level?: string;
    context: Record<string, unknown>;
  };

describe("reportError", () => {
  it("posts the error to the ingest endpoint with the bearer key", async () => {
    const fetchFn = mockFetch();

    await reportError(PROD, new Error("boom"), { site: "alarm_turn" });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.zeroapps.dev/errors/v1/errors");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe(
      "Bearer zv_test",
    );

    const body = bodyOf(init);
    expect(body.project).toBe("zero-agent");
    expect(body.message).toBe("boom");
    expect(typeof body.stack).toBe("string");
    expect(body.level).toBe("error");
    expect(body.context.site).toBe("alarm_turn");
  });

  it("folds API-error detail (status, headers) into the event context", async () => {
    const fetchFn = mockFetch();
    const apiErr = Object.assign(new Error("rate limited"), {
      status: 429,
      headers: new Headers({ "retry-after": "30", "cf-ray": "abc" }),
    });

    await reportError(PROD, apiErr);

    const body = bodyOf(fetchFn.mock.calls[0][1]) as unknown as {
      context: { statusCode?: number; rateLimitHeaders?: Record<string, string> };
    };
    expect(body.context.statusCode).toBe(429);
    expect(body.context.rateLimitHeaders?.["retry-after"]).toBe("30");
  });

  it("sends the requested level", async () => {
    const fetchFn = mockFetch();

    await reportError(PROD, new Error("throttled"), {}, { level: "warning" });

    expect(bodyOf(fetchFn.mock.calls[0][1]).level).toBe("warning");
  });

  it("replaces an empty message, which ingest rejects", async () => {
    const fetchFn = mockFetch();

    await reportError(PROD, new Error(""));

    expect(bodyOf(fetchFn.mock.calls[0][1]).message).toBe("Unknown error");
  });

  it.each([undefined, "development", "test"])(
    "sends nothing when ENVIRONMENT is %s",
    async (environment) => {
      const fetchFn = mockFetch();

      await reportError(
        { ZERO_API_KEY: "zv_test", ...(environment ? { ENVIRONMENT: environment } : {}) },
        new Error("boom"),
      );

      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it("sends nothing for a Durable Object reset, which every deploy causes", async () => {
    const fetchFn = mockFetch();

    await reportError(
      PROD,
      new Error("Durable Object reset because its code was updated"),
    );

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("logs when ingest rejects the report", async () => {
    const fetchFn = mockFetch(400);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await reportError(PROD, new Error("boom"));

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const logged = errSpy.mock.calls.map((c) => JSON.stringify(c[0])).join("\n");
    expect(logged).toContain("error_report_failed");
    expect(logged).toContain("400");
  });

  it("never rejects when the transport fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    await expect(reportError(PROD, new Error("boom"))).resolves.toBeUndefined();
  });
});
