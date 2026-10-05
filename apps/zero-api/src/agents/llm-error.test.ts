import { describe, expect, it } from "vitest";
import { APIError } from "@anthropic-ai/sdk";
import { isRateLimitError, RATE_LIMIT_MESSAGE } from "./llm-error";

describe("isRateLimitError", () => {
  it("classifies an SDK APIError with status 429", () => {
    const err = new APIError(
      429,
      { type: "error", error: { type: "rate_limit_error" } },
      "rate limited",
      new Headers(),
    );
    expect(isRateLimitError(err)).toBe(true);
  });

  it("classifies a plain object carrying status 429", () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
  });

  it("classifies status 529 (overloaded)", () => {
    expect(isRateLimitError({ status: 529 })).toBe(true);
  });

  it("unwraps a wrapped cause", () => {
    expect(isRateLimitError({ cause: { status: 429 } })).toBe(true);
  });

  it("unwraps a nested cause chain", () => {
    expect(isRateLimitError({ cause: { cause: { status: 529 } } })).toBe(true);
  });

  it("returns false for a non-capacity status", () => {
    expect(isRateLimitError({ status: 400 })).toBe(false);
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
    let deep: Record<string, unknown> = { status: 429 };
    for (let i = 0; i < 10; i++) deep = { cause: deep };
    expect(isRateLimitError(deep)).toBe(false);
  });
});

describe("RATE_LIMIT_MESSAGE", () => {
  it("is a non-empty user-facing string", () => {
    expect(RATE_LIMIT_MESSAGE.length).toBeGreaterThan(0);
  });
});
