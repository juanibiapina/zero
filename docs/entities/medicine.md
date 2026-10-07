# Medicine and Dose

## What it is

A Medicine is a routine: a name, optional instructions, one or more dose times,
the days of the week it is taken (every day by default), a start day, and an
optional last day. "Vitamin D at 08:00", "Antibiotic at 08:00, 14:00, and 20:00
for ten days", and "Before breakfast at 07:30 on Monday, Wednesday, and Friday"
are Medicines.

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
- A day of the week that is not chosen has no Doses and no reminders. The first
  Dose is on the first chosen day on or after the start day. Pausing and missed
  doses do not move the chosen days.
- Changing a dose time affects only future reminders. Past ones do not replay.
- An ended routine keeps its history. Adding it again starts a new routine.

## How it looks

Medicines has its own list under Browse on mobile and in the web sidebar. The
list shows names and times. A Medicine's page shows today's doses and when you
took them, with history on request. On a day that is not chosen, the list and
the page show the day of the next dose instead.

On Android, a normal notification arrives at the early reminder and again at
the dose time, with Taken and Postpone 1 hour. A paired watch can show the same
notification. When reminders cannot reach you, the top of the list shows one
notice with one button to fix it.

## Reminders on Android

- Each Dose has one notification. The dose-time alarm replaces the early
  reminder and alerts again. Doses never replace each other, so the morning and
  evening doses keep separate notifications, and an untaken dose's notification
  stays after midnight until you take it or swipe it away.
- Both stages use the Medicine reminders category with high importance, the
  system notification sound and vibration. Android may show a banner. Sound
  follows the phone's volume, Do Not Disturb and your category settings.
- Taken records that Dose, closes its notification, and cancels its dose-time
  alarm, without opening the app. Tapping the notification opens that Dose.
- Postpone 1 hour closes the notification and brings it back an hour later with
  sound, saying the dose is due if its time has passed. A dose time inside that
  hour waits for it. A Postpone can cross midnight and can be repeated. Taken,
  pausing, deleting, or changing that dose time cancels it. Postpone stays on
  one phone.
- A swiped notification leaves the Dose pending; the dose-time alarm still
  comes.
- Reminders arrive only for times still ahead when the phone learned of them.
  Turning reminders on, or adding a dose, after its early reminder skips that
  reminder; the dose-time alarm still comes.
- If the phone was off through a reminder, the latest one for each dose time
  appears quietly when the phone starts, and open notifications come back
  quietly.
- Medicine details are private on the lock screen.
- Reminders are turned on separately on each phone. A Taken pressed with no
  network reaches the shared history the next time the app opens.

For reliable delivery, choose Unrestricted battery use for Zero Agent when
Android offers it. The list warns only when Android reports a background
restriction.

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

How Android delivers notifications, and how to test it, is in the
[notification module](../../apps/agent-mobile/modules/zero-notifications/README.md).
