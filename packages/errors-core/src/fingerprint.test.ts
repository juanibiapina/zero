import { describe, it, expect } from "vitest";
import { fingerprint, normalizeMessage, firstFrame } from "./fingerprint";

describe("normalizeMessage", () => {
  it("replaces standalone numbers with a placeholder", () => {
    expect(normalizeMessage("user 12345 not found")).toBe("user <n> not found");
  });

  it("replaces uuids", () => {
    expect(
      normalizeMessage("trip 550e8400-e29b-41d4-a716-446655440000 missing"),
    ).toBe("trip <uuid> missing");
  });

  it("replaces long hex tokens", () => {
    expect(normalizeMessage("token deadbeefcafe1234 expired")).toBe(
      "token <hex> expired",
    );
  });

  it("leaves stable text untouched", () => {
    expect(normalizeMessage("Cannot read properties of undefined")).toBe(
      "Cannot read properties of undefined",
    );
  });
});

describe("firstFrame", () => {
  it("returns the first `at` frame", () => {
    const stack = [
      "Error: boom",
      "    at handler (/app/src/index.ts:10:5)",
      "    at run (/app/src/run.ts:2:1)",
    ].join("\n");
    expect(firstFrame(stack)).toBe("at handler (/app/src/index.ts:10:5)");
  });

  it("returns empty string when no stack", () => {
    expect(firstFrame(undefined)).toBe("");
    expect(firstFrame("")).toBe("");
  });
});

describe("fingerprint", () => {
  it("collapses the same bug with varying ids into one fingerprint", async () => {
    const a = await fingerprint({
      project: "trippycards",
      message: "Cannot read trip 111",
      stack: "Error\n    at h (/a.ts:1:1)",
    });
    const b = await fingerprint({
      project: "trippycards",
      message: "Cannot read trip 999",
      stack: "Error\n    at h (/a.ts:1:1)",
    });
    expect(a).toBe(b);
  });

  it("differs when the project differs", async () => {
    const a = await fingerprint({ project: "trippycards", message: "boom" });
    const b = await fingerprint({ project: "travel-api", message: "boom" });
    expect(a).not.toBe(b);
  });

  it("differs when the message differs", async () => {
    const a = await fingerprint({ project: "p", message: "boom a" });
    const b = await fingerprint({ project: "p", message: "boom b" });
    expect(a).not.toBe(b);
  });

  it("differs when the first frame differs", async () => {
    const a = await fingerprint({
      project: "p",
      message: "boom",
      stack: "Error\n    at one (/a.ts:1:1)",
    });
    const b = await fingerprint({
      project: "p",
      message: "boom",
      stack: "Error\n    at two (/b.ts:2:2)",
    });
    expect(a).not.toBe(b);
  });

  it("is a 64-char hex sha256 digest", async () => {
    const fp = await fingerprint({ project: "p", message: "boom" });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});
