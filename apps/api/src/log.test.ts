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

  it("extracts status, url, and rate-limit headers from an API error", () => {
    const apiErr = Object.assign(new Error("Too Many Requests"), {
      name: "AI_APICallError",
      statusCode: 429,
      url: "https://gateway.ai.cloudflare.com/v1/acct/zero/anthropic/v1/messages",
      responseHeaders: {
        "content-type": "application/json",
        "retry-after": "27",
        "anthropic-ratelimit-input-tokens-limit": "30000",
        "anthropic-ratelimit-input-tokens-remaining": "0",
        "cf-ray": "abc123",
      },
      responseBody: '{"type":"error","error":{"type":"rate_limit_error"}}',
    });
    const e = fmtErr(apiErr);
    expect(e.statusCode).toBe(429);
    expect(e.url).toContain("anthropic");
    expect(e.rateLimitHeaders).toEqual({
      "retry-after": "27",
      "anthropic-ratelimit-input-tokens-limit": "30000",
      "anthropic-ratelimit-input-tokens-remaining": "0",
      "cf-ray": "abc123",
    });
    expect(e.responseBody).toContain("rate_limit_error");
  });

  it("unwraps AI_RetryError to the underlying API error", () => {
    const apiErr = Object.assign(new Error("Too Many Requests"), {
      statusCode: 429,
      responseHeaders: { "retry-after": "5" },
    });
    const retry = Object.assign(
      new Error("Failed after 3 attempts. Last error: Too Many Requests"),
      { name: "AI_RetryError", lastError: apiErr },
    );
    const e = fmtErr(retry);
    // Top-level message stays the retry summary, but detail comes from lastError.
    expect(e.message).toContain("Failed after 3 attempts");
    expect(e.statusCode).toBe(429);
    expect(e.rateLimitHeaders).toEqual({ "retry-after": "5" });
  });

  it("truncates a long response body", () => {
    const apiErr = Object.assign(new Error("x"), {
      statusCode: 500,
      responseBody: "a".repeat(2000),
    });
    expect(fmtErr(apiErr).responseBody).toHaveLength(500);
  });
});
