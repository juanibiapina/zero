import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IconSuggester, type IconSuggestionRequest } from "./icon-suggester";

const deferred = () => {
  const calls: { title: string; resolve: (icons: string[]) => void; reject: (error: Error) => void; signal: AbortSignal }[] = [];
  const request = vi.fn<IconSuggestionRequest>(
    (input, signal) =>
      new Promise((resolve, reject) => {
        calls.push({ title: input.title, resolve, reject, signal });
      }),
  );
  return { request, calls };
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("IconSuggester", () => {
  it("asks once after typing pauses and chooses the top suggestion", async () => {
    const { request, calls } = deferred();
    const suggester = new IconSuggester({ request });
    for (const title of ["tri", "trip to", "trip to japan"]) {
      suggester.update({ title, enabled: true });
      vi.advanceTimersByTime(100);
    }
    expect(request).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);

    expect(request).toHaveBeenCalledOnce();
    expect(calls[0]?.title).toBe("trip to japan");
    calls[0]?.resolve(["🇯🇵", "✈️"]);
    await flush();

    expect(suggester.getChoice()).toEqual({ icon: "🇯🇵", source: "suggested", icons: ["🇯🇵", "✈️"], status: "ready" });
  });

  it("drops an answer for text the user has since changed", async () => {
    const { request, calls } = deferred();
    const suggester = new IconSuggester({ request });
    suggester.update({ title: "trip to japan", enabled: true });
    vi.advanceTimersByTime(400);
    suggester.update({ title: "renovate bathroom", enabled: true });

    expect(calls[0]?.signal.aborted).toBe(true);
    calls[0]?.resolve(["🇯🇵"]);
    await flush();
    expect(suggester.getChoice().icon).toBe("📁");

    vi.advanceTimersByTime(400);
    calls[1]?.resolve(["🛁"]);
    await flush();
    expect(suggester.getChoice().icon).toBe("🛁");
  });

  it("does not ask for short titles or when disabled", () => {
    const { request } = deferred();
    const suggester = new IconSuggester({ request });
    suggester.update({ title: "ab", enabled: true });
    vi.advanceTimersByTime(1000);
    suggester.update({ title: "trip to japan", enabled: false });
    vi.advanceTimersByTime(1000);

    expect(request).not.toHaveBeenCalled();
    expect(suggester.getChoice()).toEqual({ icon: "📁", source: "default", icons: [], status: "idle" });
  });

  it("keeps the picked icon while suggestions keep refreshing", async () => {
    const { request, calls } = deferred();
    const suggester = new IconSuggester({ request });
    suggester.update({ title: "trip", enabled: true });
    vi.advanceTimersByTime(400);
    calls[0]?.resolve(["✈️", "🧳"]);
    await flush();
    suggester.pick("🧳");

    suggester.update({ title: "trip to japan", enabled: true });
    vi.advanceTimersByTime(400);
    expect(request).toHaveBeenCalledTimes(2);
    calls[1]?.resolve(["🇯🇵", "🗾"]);
    await flush();

    expect(suggester.getChoice()).toEqual({ icon: "🧳", source: "manual", icons: ["🇯🇵", "🗾"], status: "ready" });

    suggester.update({ title: "", enabled: true });
    expect(suggester.getChoice().icon).toBe("🧳");
  });

  it("falls back to the default icon when suggestions fail or come back empty", async () => {
    const { request, calls } = deferred();
    const suggester = new IconSuggester({ request });
    suggester.update({ title: "trip", enabled: true });
    vi.advanceTimersByTime(400);
    calls[0]?.resolve(["✈️"]);
    await flush();

    suggester.update({ title: "trip to japan", enabled: true });
    vi.advanceTimersByTime(400);
    calls[1]?.reject(new Error("offline"));
    await flush();
    expect(suggester.getChoice()).toEqual({ icon: "📁", source: "default", icons: [], status: "error" });

    suggester.update({ title: "trip to japan!", enabled: true });
    vi.advanceTimersByTime(400);
    calls[2]?.resolve([]);
    await flush();
    expect(suggester.getChoice()).toEqual({ icon: "📁", source: "default", icons: [], status: "ready" });
  });

  it("reset unlocks the next draft", async () => {
    const { request, calls } = deferred();
    const suggester = new IconSuggester({ request });
    suggester.pick("🧳");
    suggester.reset();
    expect(suggester.getChoice()).toEqual({ icon: "📁", source: "default", icons: [], status: "idle" });

    suggester.update({ title: "trip", enabled: true });
    vi.advanceTimersByTime(400);
    calls[0]?.resolve(["✈️"]);
    await flush();
    expect(suggester.getChoice()).toMatchObject({ icon: "✈️", source: "suggested" });
  });
});
