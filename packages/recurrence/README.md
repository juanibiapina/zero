# @zeroapps/recurrence

Date-only natural-language scheduling and recurrence for JavaScript runtimes.
The package runs in browsers, Cloudflare Workers, and React Native/Hermes.

```ts
import { advance, parseSchedule, toText } from "@zeroapps/recurrence";

const parsed = parseSchedule("Pay rent every 1st", {
  today: "2026-09-16",
  weekStartsOn: "MO",
});

if (parsed.kind === "scheduled" && parsed.schedule.kind === "recurring") {
  toText(parsed.schedule.recurrence); // "every month on day 1"
  advance(parsed.schedule.recurrence, {
    scheduledOn: "2026-10-01",
    completedOn: "2026-10-15",
  }); // { kind: "next", scheduledOn: "2026-11-01" }
}
```

## Interface

- `parseSchedule(text, context)` parses a complete English task title. It
  returns the cleaned title, consumed text ranges, and either a one-time date or
  normalized recurrence. `context.ignored` can mask previously dismissed ranges
  without shifting their UTF-16 offsets, so the next rightmost candidate becomes
  active. The caller supplies its local `today`; the package never reads the host
  clock or timezone.
- `advance(recurrence, event)` completes one occurrence. `every` rules advance
  from `scheduledOn`; `every!` rules advance from `completedOn`.
- `toText(recurrence)` renders a canonical English summary.
- `validateRecurrence(value)` validates untyped persisted or network JSON.

The normalized JSON is versioned. Chrono, RRULE strings, Temporal objects, and
provider-specific types never cross the package interface.

## Semantics

- Scheduled recurrence catches up one occurrence at a time, even when the next
  date remains overdue. It never skips rent-like obligations.
- Completion recurrence re-anchors from the completion day.
- Invalid month days clamp backward and return to their requested day when that
  day exists again.
- `until` is inclusive. Occurrence count is not supported.
- Workdays are Monday through Friday; public holidays do not alter them.
- Times are not parsed. In `Call tomorrow at 3pm`, only `tomorrow` is consumed;
  `at 3pm` remains ordinary title text.

The overdue catch-up and one-off-postpone behavior deliberately differs from
Todoist, which can skip occurrences after overdue completion or rescheduling.
