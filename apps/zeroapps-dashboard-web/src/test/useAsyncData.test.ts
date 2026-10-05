import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useAsyncData } from "@zero/ui";

describe("useAsyncData", () => {
  it("clears loading and sets error when the fetcher rejects", async () => {
    const fetcher = vi.fn(() => Promise.reject(new Error("boom")));
    const { result } = renderHook(() => useAsyncData(fetcher, []));

    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toBe("boom");
    expect(result.current.data).toBeNull();
  });

  it("sets data and clears error when the fetcher resolves", async () => {
    const fetcher = vi.fn(() => Promise.resolve({ ok: true }));
    const { result } = renderHook(() => useAsyncData(fetcher, []));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ ok: true });
    expect(result.current.error).toBeNull();
  });

  it("reload re-runs the fetcher, recovering from an earlier rejection", async () => {
    const fetcher = vi
      .fn<() => Promise<{ ok: boolean }>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ ok: true });
    const { result } = renderHook(() => useAsyncData(fetcher, []));

    await waitFor(() => expect(result.current.error?.message).toBe("boom"));

    await act(async () => {
      result.current.reload();
    });

    await waitFor(() => expect(result.current.data).toEqual({ ok: true }));
    expect(result.current.error).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale response when deps change before it settles", async () => {
    let resolveFirst!: (v: string) => void;
    const first = new Promise<string>((r) => (resolveFirst = r));
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce("second");

    const { result, rerender } = renderHook(
      ({ dep }: { dep: number }) => useAsyncData(fetcher, [dep]),
      { initialProps: { dep: 1 } },
    );

    // Change deps: triggers a second fetch that resolves immediately.
    rerender({ dep: 2 });
    await waitFor(() => expect(result.current.data).toBe("second"));

    // Now let the first (stale) fetch resolve; it must not overwrite "second".
    await act(async () => {
      resolveFirst("first");
      await Promise.resolve();
    });

    expect(result.current.data).toBe("second");
  });
});
