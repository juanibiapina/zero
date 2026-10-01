import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useLocalDay } from "./local-day";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

it("updates every subscriber at local midnight", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 30, 23, 59, 59));
  const first = renderHook(useLocalDay);
  const second = renderHook(useLocalDay);
  expect(first.result.current).toBe("2026-09-30");
  act(() => { vi.advanceTimersByTime(1002); });
  expect(first.result.current).toBe("2026-10-01");
  expect(second.result.current).toBe("2026-10-01");
  first.unmount(); second.unmount();
});

it("updates after returning from a suspended browser tab", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 30, 12));
  const view = renderHook(useLocalDay);
  act(() => {
    vi.setSystemTime(new Date(2026, 9, 2, 12));
    window.dispatchEvent(new Event("focus"));
  });
  expect(view.result.current).toBe("2026-10-02");
  view.unmount();
});

it("uses the next calendar midnight on a 23-hour daylight-saving day", () => {
  vi.stubEnv("TZ", "America/New_York");
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 2, 8));
  const view = renderHook(useLocalDay);
  act(() => { vi.advanceTimersByTime(23 * 60 * 60 * 1000 + 2); });
  expect(view.result.current).toBe("2026-03-09");
  view.unmount();
});
