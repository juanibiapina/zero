import type { TextRange } from "@zeroapps/recurrence";
import * as React from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type ScheduleHighlightInputProps = Omit<
  React.ComponentProps<"input">,
  "value"
> & {
  value: string;
  ranges: TextRange[];
  onDismissRange?: (range: TextRange) => void;
};

type TextPart = {
  text: string;
  range: TextRange | null;
};

function textParts(value: string, ranges: TextRange[]): TextPart[] {
  const parts: TextPart[] = [];
  let offset = 0;

  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const start = Math.max(offset, Math.min(value.length, range.start));
    const end = Math.max(start, Math.min(value.length, range.end));
    if (start > offset) parts.push({ text: value.slice(offset, start), range: null });
    if (end > start) parts.push({ text: value.slice(start, end), range });
    offset = end;
  }

  if (offset < value.length) parts.push({ text: value.slice(offset), range: null });
  return parts;
}

export const ScheduleHighlightInput = React.forwardRef<
  HTMLInputElement,
  ScheduleHighlightInputProps
>(function ScheduleHighlightInput(
  {
    value,
    ranges,
    onDismissRange,
    className,
    onPointerUp,
    onScroll,
    ...props
  },
  forwardedRef,
) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [scrollLeft, setScrollLeft] = React.useState(0);
  const highlighted = ranges.length > 0 && value.length > 0;

  React.useImperativeHandle(forwardedRef, () => inputRef.current!, []);

  const dismissAtCaret = () => {
    const input = inputRef.current;
    if (!input || input.selectionStart !== input.selectionEnd) return;
    const caret = input.selectionStart;
    const range = ranges.find(
      (candidate) => caret != null && caret >= candidate.start && caret < candidate.end,
    );
    if (range) onDismissRange?.(range);
  };

  return (
    <div className="relative min-w-0 flex-1">
      {highlighted ? (
        <div
          aria-hidden="true"
          data-testid="schedule-highlight-mirror"
          className="pointer-events-none absolute inset-0 flex items-center overflow-hidden rounded-md border border-transparent px-3 py-1 text-sm"
        >
          <span
            data-testid="schedule-highlight-track"
            className="block shrink-0 whitespace-pre"
            style={{ transform: `translateX(${-scrollLeft}px)` }}
          >
            {textParts(value, ranges).map((part, index) =>
              part.range ? (
                <mark
                  key={`${part.range.start}-${part.range.end}`}
                  data-testid="schedule-highlight"
                  className="rounded-[2px] bg-schedule-highlight text-on-schedule-highlight"
                >
                  {part.text}
                </mark>
              ) : (
                <span key={`plain-${index}`}>{part.text}</span>
              ),
            )}
          </span>
        </div>
      ) : null}
      <Input
        {...props}
        ref={inputRef}
        value={value}
        className={cn(
          highlighted &&
            "relative z-10 caret-foreground text-transparent selection:bg-ring/30",
          className,
        )}
        onPointerUp={(event) => {
          onPointerUp?.(event);
          if (!event.defaultPrevented) dismissAtCaret();
        }}
        onScroll={(event) => {
          onScroll?.(event);
          setScrollLeft(event.currentTarget.scrollLeft);
        }}
      />
    </div>
  );
});
