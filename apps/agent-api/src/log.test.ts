import { describe, expect, it } from "vitest";
import { fmtErr } from "./log";

describe("fmtErr", () => {
  it("formats a plain Error", () => {
    const e = fmtErr(new Error("boom"));
    expect(e.message).toBe("boom");
    expect(e.name).toBe("Error");
    expect(e.statusCode).toBeUndefined();
  });

  it("formats a non-Error value", () => {
    expect(fmtErr("nope")).toEqual({ message: "nope" });
  });

  it("extracts status, request id, and rate-limit headers from an API error", () => {
    const apiErr = Object.assign(new Error("Too Many Requests"), {
      name: "RateLimitError",
      status: 429,
      requestID: "req_123",
      headers: new Headers({
        "content-type": "application/json",
        "retry-after": "27",
        "anthropic-ratelimit-input-tokens-limit": "30000",
        "anthropic-ratelimit-input-tokens-remaining": "0",
        "cf-ray": "abc123",
      }),
      error: { type: "error", error: { type: "rate_limit_error" } },
    });
    const e = fmtErr(apiErr);
    expect(e.statusCode).toBe(429);
    expect(e.requestId).toBe("req_123");
    expect(e.rateLimitHeaders).toEqual({
      "retry-after": "27",
      "anthropic-ratelimit-input-tokens-limit": "30000",
      "anthropic-ratelimit-input-tokens-remaining": "0",
      "cf-ray": "abc123",
    });
    expect(e.responseBody).toContain("rate_limit_error");
  });

  it("unwraps a wrapping error to the underlying API error", () => {
    const apiErr = Object.assign(new Error("Too Many Requests"), {
      status: 429,
      headers: new Headers({ "retry-after": "5" }),
    });
    const wrapper = new Error("tool call failed", { cause: apiErr });
    const e = fmtErr(wrapper);
    // Top-level message stays the wrapper summary, detail comes from the cause.
    expect(e.message).toBe("tool call failed");
    expect(e.statusCode).toBe(429);
    expect(e.rateLimitHeaders).toEqual({ "retry-after": "5" });
  });

  it("truncates a long response body", () => {
    const apiErr = Object.assign(new Error("x"), {
      status: 500,
      error: { message: "a".repeat(2000) },
    });
    expect(fmtErr(apiErr).responseBody).toHaveLength(500);
  });
});
