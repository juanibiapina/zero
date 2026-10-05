import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { defaultToastController } from "@zero/agent-core";

import { Toaster } from "./Toaster";

describe("Toaster", () => {
  afterEach(() => {
    defaultToastController.dismiss();
    vi.useRealTimers();
  });

  it("renders a toast's message, description and action", () => {
    render(<Toaster />);
    act(() => {
      defaultToastController.show({
        message: "Project created",
        description: "ship the app",
        action: { label: "View", onPress: () => {} },
        durationMs: Infinity,
      });
    });
    expect(screen.getByText("Project created")).toBeInTheDocument();
    expect(screen.getByText("ship the app")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View" })).toBeInTheDocument();
  });

  it("fires the action's onPress and dismisses on click", () => {
    const onPress = vi.fn();
    render(<Toaster />);
    act(() => {
      defaultToastController.show({
        message: "Saved",
        action: { label: "View", onPress },
        durationMs: Infinity,
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(defaultToastController.getSnapshot()).toHaveLength(0);
  });

  it("removes the row after the controller auto-dismisses and the exit plays", () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => {
      defaultToastController.show({ message: "Saved", durationMs: 1000 });
    });
    expect(screen.getByText("Saved")).toBeInTheDocument();
    // At 1000ms the controller drops it; the row re-renders as leaving and
    // schedules its own exit timer.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // A further tick past the exit duration unmounts the leaving row.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByText("Saved")).toBeNull();
  });
});
