import { useState } from "react";
import { monthMatrix, tomorrow, weekdayShort } from "@zero/agent-core";

import { cn } from "@/lib/utils";

// A calendar glyph used by schedule affordances. Kept here with the scheduler
// so both the detail-sheet field and the project-row date chip share one icon.
export function CalendarGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}

// The scheduler menu inside a popover: Today / Tomorrow (with the resolved
// weekday), an inline month calendar (built from the shared monthMatrix helper —
// no date library), and No date. One scheduler shared by the Home detail sheet
// and the project screen's per-task date chip, so the two never drift. Mirrors
// the mobile scheduler.
export function ScheduleMenu({
  today,
  selected,
  onPick,
}: {
  today: string;
  selected: string | null;
  onPick: (date: string | null) => void;
}) {
  const tmr = tomorrow(today);
  const initial = selected ?? today;
  const [iy, im] = initial.split("-").map(Number);
  const [view, setView] = useState<{ y: number; m0: number }>({
    y: iy,
    m0: im - 1,
  });
  const grid = monthMatrix(view.y, view.m0);
  const monthTitle = new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
  }).format(new Date(view.y, view.m0, 1));
  const step = (delta: number) => {
    const d = new Date(view.y, view.m0 + delta, 1);
    setView({ y: d.getFullYear(), m0: d.getMonth() });
  };
  return (
    <div className="p-2">
      <button
        type="button"
        onClick={() => onPick(today)}
        className="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-accent"
      >
        <span>Today</span>
        <span className="text-muted-foreground">{weekdayShort(today)}</span>
      </button>
      <button
        type="button"
        onClick={() => onPick(tmr)}
        className="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-accent"
      >
        <span>Tomorrow</span>
        <span className="text-muted-foreground">{weekdayShort(tmr)}</span>
      </button>
      <div className="my-2 border-t" />
      <div className="px-1">
        <div className="mb-1 flex items-center justify-between">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => step(-1)}
            className="rounded px-2 py-1 text-muted-foreground hover:bg-accent"
          >
            ‹
          </button>
          <span className="text-sm font-medium">{monthTitle}</span>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => step(1)}
            className="rounded px-2 py-1 text-muted-foreground hover:bg-accent"
          >
            ›
          </button>
        </div>
        <div className="grid grid-cols-7 text-center text-xs text-muted-foreground">
          {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
            <div key={i} className="py-1">
              {d}
            </div>
          ))}
        </div>
        {grid.map((week, wi) => (
          <div key={wi} className="grid grid-cols-7">
            {week.map((date) => {
              const day = Number(date.split("-")[2]);
              const inMonth = Number(date.split("-")[1]) === view.m0 + 1;
              const isToday = date === today;
              const isSelected = date === selected;
              return (
                <button
                  key={date}
                  type="button"
                  aria-label={date}
                  onClick={() => onPick(date)}
                  className={cn(
                    "mx-auto my-0.5 flex size-8 items-center justify-center rounded-full text-sm",
                    isSelected
                      ? "bg-primary text-primary-foreground"
                      : isToday
                        ? "border border-primary"
                        : "hover:bg-accent",
                    !inMonth && !isSelected ? "text-muted-foreground/50" : "",
                  )}
                >
                  {day}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="my-2 border-t" />
      <button
        type="button"
        onClick={() => onPick(null)}
        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent"
      >
        No date
      </button>
    </div>
  );
}
