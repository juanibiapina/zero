import { describe, it, expect, vi } from "vitest";
import { splitMessage, formatAndSend } from "./send";

describe("splitMessage", () => {
  it("returns single chunk when text fits", () => {
    expect(splitMessage("short text", 100)).toEqual(["short text"]);
  });

  it("splits on newline boundary", () => {
    const text = "line1\nline2\nline3";
    const chunks = splitMessage(text, 12);
    expect(chunks).toEqual(["line1\nline2", "line3"]);
  });

  it("splits at maxLen when no newline found", () => {
    const text = "abcdefghij";
    const chunks = splitMessage(text, 5);
    expect(chunks).toEqual(["abcde", "fghij"]);
  });
});

describe("formatAndSend", () => {
  it("converts markdown and sends with parse_mode HTML", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await formatAndSend("**bold**", send);
    expect(send).toHaveBeenCalledWith("<b>bold</b>", "HTML");
  });

  it("splits long messages into chunks", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    // Build text that exceeds 4096
    const line = "word ".repeat(100) + "\n";
    const longText = line.repeat(20);
    await formatAndSend(longText, send);
    expect(send.mock.calls.length).toBeGreaterThan(1);
    for (const call of send.mock.calls) {
      const [text, mode] = call as [string, string];
      expect(text.length).toBeLessThanOrEqual(4096);
      expect(mode).toBe("HTML");
    }
  });

  it("falls back to plain text when send rejects with 400", async () => {
    const error = Object.assign(new Error("Bad Request"), {
      error_code: 400,
    });
    const send = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue(undefined);

    await formatAndSend("**bold**", send);
    // Second call should be plain text without parse_mode
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toBe("bold");
    expect(send.mock.calls[1][1]).toBeUndefined();
  });

  it("rethrows non-400 errors", async () => {
    const error = Object.assign(new Error("Server Error"), {
      error_code: 500,
    });
    const send = vi.fn().mockRejectedValue(error);
    await expect(formatAndSend("**bold**", send)).rejects.toThrow(
      "Server Error",
    );
  });
});
