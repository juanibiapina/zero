import { describe, expect, it, vi } from "vitest";
import { reportError } from "./zero-errors";

const okFetch = () =>
  vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));

describe("reportError", () => {
  it("posts the error to the canonical ingest endpoint with the bearer key", async () => {
    const fetchFn = okFetch();

    await reportError(
      { ZEROVAULT_API_KEY: "zv_test" },
      new Error("boom"),
      { site: "http", path: "/v1/secrets" },
      fetchFn,
    );

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://errors.apps.juanibiapina.dev/v1/errors");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe(
      "Bearer zv_test",
    );

    const body = JSON.parse(init?.body as string) as {
      project: string;
      message: string;
      stack?: string;
      context: Record<string, unknown>;
    };
    expect(body.project).toBe("zerovault");
    expect(body.message).toBe("boom");
    expect(typeof body.stack).toBe("string");
    expect(body.context.site).toBe("http");
    expect(body.context.path).toBe("/v1/secrets");
  });

  it("uses String(err) for non-Error values", async () => {
    const fetchFn = okFetch();

    await reportError({ ZEROVAULT_API_KEY: "zv_test" }, "plain failure", {}, fetchFn);

    const init = fetchFn.mock.calls[0][1];
    const body = JSON.parse(init?.body as string) as { message: string };
    expect(body.message).toBe("plain failure");
  });

  it("never rejects when the transport throws", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new Error("network down");
    });

    await expect(
      reportError(
        { ZEROVAULT_API_KEY: "zv_test" },
        new Error("boom"),
        {},
        fetchFn,
      ),
    ).resolves.toBeUndefined();
  });

  it("never rejects when the transport resolves non-2xx", async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 500 }),
    );

    await expect(
      reportError(
        { ZEROVAULT_API_KEY: "zv_test" },
        new Error("boom"),
        {},
        fetchFn,
      ),
    ).resolves.toBeUndefined();
  });
});
