import { describe, expect, it } from "vitest";
import { APICallError } from "ai";
import { isRateLimitError, RATE_LIMIT_MESSAGE } from "./llm-error";

describe("isRateLimitError", () => {
  it("classifies a bare APICallError with statusCode 429", () => {
    const err = new APICallError({
      message: "rate limited",
      url: "https://gateway/v1/messages",
      requestBodyValues: {},
      statusCode: 429,
      isRetryable: false,
    });
    expect(isRateLimitError(err)).toBe(true);
  });

  it("classifies a plain object carrying statusCode 429", () => {
    expect(isRateLimitError({ statusCode: 429 })).toBe(true);
  });

  it("classifies statusCode 529 (overloaded)", () => {
    expect(isRateLimitError({ statusCode: 529 })).toBe(true);
  });

  it("unwraps AI_RetryError-like lastError", () => {
    expect(isRateLimitError({ lastError: { statusCode: 429 } })).toBe(true);
  });

  it("unwraps ToolExecutionError-like cause", () => {
    expect(isRateLimitError({ cause: { statusCode: 429 } })).toBe(true);
  });

  it("unwraps nested lastError + cause", () => {
    expect(
      isRateLimitError({ lastError: { cause: { statusCode: 529 } } }),
    ).toBe(true);
  });

  it("returns false for a non-capacity status", () => {
    expect(isRateLimitError({ statusCode: 400 })).toBe(false);
  });

  it("returns false for a plain Error", () => {
    expect(isRateLimitError(new Error("boom"))).toBe(false);
  });

  it("returns false for undefined and null", () => {
    expect(isRateLimitError(undefined)).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
  });

  it("returns false for a cyclic object without looping forever", () => {
    const a: Record<string, unknown> = {};
    a.cause = a;
    expect(isRateLimitError(a)).toBe(false);
  });

  it("returns false for a chain deeper than the guard", () => {
    let deep: Record<string, unknown> = { statusCode: 429 };
    for (let i = 0; i < 10; i++) deep = { cause: deep };
    expect(isRateLimitError(deep)).toBe(false);
  });
});

describe("RATE_LIMIT_MESSAGE", () => {
  it("is a non-empty user-facing string", () => {
    expect(RATE_LIMIT_MESSAGE.length).toBeGreaterThan(0);
  });
});
