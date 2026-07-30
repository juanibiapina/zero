import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReadPageTool } from "./read-page";
import { createMemoryFetcher } from "../pagefetch/memory";
import type { PageContent, PageFetcher } from "../pagefetch/types";

afterEach(() => {
  vi.restoreAllMocks();
});

type ReadPageExecute = (input: {
  url: string;
}) => Promise<PageContent | { error: string }>;

const run = (
  fetcher: PageFetcher,
  caller: "interface" | "research",
  url: string,
): Promise<PageContent | { error: string }> => {
  const tool = buildReadPageTool({ fetcher, caller }).read_page;
  return (tool.execute as unknown as ReadPageExecute)({ url });
};

const failingFetcher = (message: string): PageFetcher => ({
  fetch: async () => {
    throw new Error(message);
  },
});

const logLines = () => {
  const lines: unknown[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => {
    lines.push(args[0]);
  });
  return lines as Record<string, unknown>[];
};

describe("buildReadPageTool", () => {
  it("returns the page content and logs the caller, duration and length", async () => {
    const lines = logLines();
    const fetcher = createMemoryFetcher({
      "https://ex.com/a": "# Title\n\nBody.",
    });

    const result = await run(fetcher, "interface", "https://ex.com/a");

    expect(result).toEqual({
      url: "https://ex.com/a",
      content: "# Title\n\nBody.",
    });
    const done = lines.find((l) => l.msg === "read_page_completed");
    expect(done).toMatchObject({ caller: "interface", content_len: 14 });
    expect(typeof done?.duration_ms).toBe("number");
  });

  it("returns the failure as data and logs the caller and duration", async () => {
    const lines = logLines();

    const result = await run(
      failingFetcher("page fetch failed: invalid web address"),
      "interface",
      "ftp://ex.com",
    );

    expect(result).toEqual({ error: "page fetch failed: invalid web address" });
    const failed = lines.find((l) => l.msg === "read_page_failed");
    expect(failed).toMatchObject({ caller: "interface" });
    expect(typeof failed?.duration_ms).toBe("number");
  });

  it("logs neither the address nor the page content", async () => {
    const lines = logLines();
    const fetcher = createMemoryFetcher({
      "https://secret.example.com/private": "confidential body",
    });

    await run(fetcher, "research", "https://secret.example.com/private");
    await run(failingFetcher("boom"), "research", "https://secret.example.com/private");

    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain("secret.example.com");
    expect(serialized).not.toContain("confidential body");
  });

  it("distinguishes the interface and research callers", async () => {
    const lines = logLines();
    const fetcher = createMemoryFetcher({ "https://ex.com/a": "body" });

    await run(fetcher, "interface", "https://ex.com/a");
    await run(fetcher, "research", "https://ex.com/a");

    expect(
      lines.filter((l) => l.msg === "read_page_completed").map((l) => l.caller),
    ).toEqual(["interface", "research"]);
  });
});
