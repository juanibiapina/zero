# Medicine and Dose

## What it is

A Medicine is a daily routine: a name, optional instructions, one or more dose
times each day, a start day, and an optional last day. "Vitamin D at 08:00" and
"Antibiotic at 08:00, 14:00, and 20:00 for ten days" are Medicines.

A Dose is one dated occurrence of one dose time, such as "Antibiotic, 14:00,
October 3". It records when you pressed Taken.

## Why it is its own block

A Medicine repeats on a clock and must reach you on time even when the app is
closed, the phone is offline, or nobody is signed in. A repeating Task cannot
do that. Its history also matters: you want to know which doses you took, not
only what comes next.

## Rules

- Each Dose is independent. Taking the morning dose leaves the evening dose
  pending.
- Each dose time has an early reminder before it, on the same day.
- Dates and times follow the phone's local clock. At midnight a new day starts
  with new Doses.
- Taken records the moment you confirmed. It works from the notification,
  without opening the app, signing in, or a network connection.
- A course ends on its last day. Pausing and missed doses do not extend it.
- Changing a dose time affects only future reminders. Past ones do not replay.
- An ended routine keeps its history. Adding it again starts a new routine.

## How it looks

Medicines has its own list under Browse on mobile and in the web sidebar. The
list shows names and times. A Medicine's page shows today's doses and when you
took them, with history on request.

On Android, a normal notification arrives at the early reminder and again at
the dose time, with Taken and Postpone 1 hour. A paired watch can show the same
notification. When reminders cannot reach you, the top of the list shows one
notice with one button to fix it.

## Interactions

- Task, Project, Waiting, After: none, on purpose. Medicine never appears on
  Home, never changes Project attention, and never counts toward the Task count
  on the launcher icon.
- Agents: list only. An agent cannot change a Medicine, because the phone sets
  its alarms only when the app sees the change.

## Left out on purpose

- A looping alarm sound or a full-screen alarm.
- A full record of missed doses or of old schedules.
- Medicine in global quick add, which offers only Task and Project.

## Ideas

None recorded yet.

How Android delivers reminders, and how to test it, is in the
[medicine-reminders module](../../apps/agent-mobile/modules/medicine-reminders/README.md).
