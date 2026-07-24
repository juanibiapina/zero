import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyDiscord } from "./discord";

describe("notifyDiscord", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts content as JSON to the webhook URL", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await notifyDiscord("https://discord.test/webhook", "hello");

    expect(fetchMock).toHaveBeenCalledWith("https://discord.test/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
  });

  it("swallows non-2xx responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("rate limited", { status: 429 }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      notifyDiscord("https://discord.test/webhook", "hello"),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  it("swallows network errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      notifyDiscord("https://discord.test/webhook", "hello"),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });
});
