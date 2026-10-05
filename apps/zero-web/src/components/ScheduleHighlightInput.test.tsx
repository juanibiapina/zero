import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ScheduleHighlightInput } from "./ScheduleHighlightInput";

describe("ScheduleHighlightInput", () => {
  it("shows only the parser-consumed text as an inline highlight", () => {
    render(
      <ScheduleHighlightInput
        aria-label="Add a task"
        value="Stand up every day"
        ranges={[{ start: 9, end: 18, text: "every day" }]}
        onChange={() => {}}
      />,
    );

    expect(screen.getByRole("textbox", { name: "Add a task" })).toHaveValue(
      "Stand up every day",
    );
    expect(screen.getByTestId("schedule-highlight")).toHaveTextContent(
      "every day",
    );
    expect(screen.getByTestId("schedule-highlight")).toHaveClass(
      "bg-schedule-highlight",
      "text-on-schedule-highlight",
    );
    expect(screen.getByTestId("schedule-highlight-mirror")).toHaveTextContent(
      "Stand up every day",
    );
  });

  it("tracks the native input's horizontal scroll", () => {
    render(
      <ScheduleHighlightInput
        aria-label="Add a task"
        value="A long task every day"
        ranges={[{ start: 12, end: 21, text: "every day" }]}
        onChange={() => {}}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Add a task" });
    Object.defineProperty(input, "scrollLeft", { value: 36, writable: true });
    fireEvent.scroll(input);

    expect(screen.getByTestId("schedule-highlight-track")).toHaveStyle({
      transform: "translateX(-36px)",
    });
  });

  it("dismisses recognition when the native caret lands in the highlighted range", () => {
    const onDismissRange = vi.fn();
    render(
      <ScheduleHighlightInput
        aria-label="Add a task"
        value="Stand up every day"
        ranges={[{ start: 9, end: 18, text: "every day" }]}
        onDismissRange={onDismissRange}
        onChange={() => {}}
      />,
    );

    const input = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Add a task",
    });
    input.setSelectionRange(12, 12);
    fireEvent.pointerUp(input);

    expect(onDismissRange).toHaveBeenCalledWith({
      start: 9,
      end: 18,
      text: "every day",
    });
  });
});
