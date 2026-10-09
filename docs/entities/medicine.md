# Medicine and Dose

## What it is

A Medicine is a routine: a name, optional instructions, one or more dose times,
the days of the week it is taken (every day by default), a start day, and an
optional last day. "Vitamin D at 08:00", "Antibiotic at 08:00, 14:00, and 20:00
for ten days", and "Before breakfast at 07:30 on Monday, Wednesday, and Friday"
are Medicines.

A Dose is one dated occurrence of one dose time, such as "Antibiotic, 14:00,
October 3". It records when you pressed Taken.

Each dose time takes a number of pills, one by default. A Medicine can also
track its supply: the pills you have left, and how many days before they run
out Zero reminds you to buy more (14 by default).

## Why it is its own block

A Medicine repeats on a clock and must reach you on time even when the app is
closed, the phone is offline, or nobody is signed in. A repeating Task cannot
do that. Its history also matters: you want to know which doses you took, not
only what comes next.

## Rules

- Each Dose is independent. Taking the morning dose leaves the evening dose
  pending.
- Each dose time has an early reminder 15 minutes, 30 minutes or an hour
  before it, on the same day.
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
- Supply is a count you set. Every Taken subtracts that dose time's pills, and
  Undo adds them back. Taking a dose twice, or a notification Taken that
  arrives again, subtracts once. The count never goes below zero.
- The supply is low when the pills left are at or below what the schedule uses
  in the chosen number of days: chosen weekdays × pills per day × days ÷ 7,
  rounded up. A paused or ended Medicine, or a course whose remaining doses
  need no more pills than you have, is never low.
- When a Taken, a new count, or a schedule change makes the supply low, Zero
  adds one restock Task "Buy <name>" to Home. A recount while already low adds
  nothing. Time alone never makes the supply low.
- Restock adds the pills you got and remembers the amount for next time.
  Recount replaces the count.

## How it looks

Medicines has its own list under Browse on mobile and in the web sidebar. The
list shows names and each dose time with its pills ("08:00 · 2 pills"). A
Medicine's page shows today's doses and when you took them, with history on
request. On a day that is not chosen, the list and the page show the next dose
day as "tomorrow", a weekday within the coming week, or a date. A counted
Medicine shows "24 pills left · about 12 days" with Restock and Recount; an
uncounted one offers Count pills.

On mobile, the Medicine's page is also its editor, and every change saves at
once. The name and notes are text fields at the top and save when you leave
them; a cleared name keeps the old one. Today's doses are tiles: tap one to
record it as taken, with Undo in the toast, and long-press a taken one to undo
it later. A chip per dose opens its exact time, its pills, how early to remind,
and Remove; "+ Time" adds a dose. Weekdays, the start day (Starts: Today,
Tomorrow, or a picked day; "Started" once it is past), Ongoing or a last day,
and when to remind you to buy more (1 week, 2 weeks, 1 month) are chips on the
same page. The add sheet opens with the keyboard on the name and asks for the
name, optional notes, and the same schedule, with 1× to 4× a day presets.

On Android, a normal notification arrives at the early reminder and again at
the dose time, with Taken and Postpone 1 hour. Both say how many pills to take
("Take 2 pills at 20:00", then "Time to take 2 pills"). At the dose time a locked phone
also opens a full-screen alarm with the same buttons. A paired watch can show
the same notification. When reminders cannot reach you, the top of the list shows one
notice with one button to fix it.

## Reminders on Android

- Each Dose has one notification. The dose-time alarm replaces the early
  reminder and alerts again. Doses never replace each other, so the morning and
  evening doses keep separate notifications, and an untaken dose's notification
  stays after midnight until you take it or swipe it away.
- Both stages use the Medicine reminders category with high importance, the
  system notification sound and vibration. Android may show a banner. Sound
  follows the phone's volume, Do Not Disturb and your category settings.
- At the dose time, a locked phone or one with the screen off opens a
  full-screen alarm with the medicine's name, the dose text, and Silence,
  Postpone 1 hour and Taken stacked at the bottom, and plays the alarm sound for
  up to a minute. The alarm sound follows the alarm volume and Android's alarm
  rules for Do Not Disturb. Silence stops the sound and keeps the screen with
  Taken and Postpone 1 hour. Back, the power button, or any button stops the
  sound; after a minute it stops by itself and the screen stays. The screen shows the medicine's details over the
  lock screen. A phone in use shows the notification instead, as Android does.
  When Android denies full-screen access, the notification still arrives and
  the list's notice offers to allow it.
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
- Medicine details are private in the lock-screen notification.
- Reminders are turned on separately on each phone. A Taken pressed with no
  network reaches the shared history the next time the app opens.

For reliable delivery, choose Unrestricted battery use for Zero Agent when
Android offers it. The list warns only when Android reports a background
restriction.

## Interactions

- Task: the parent of restock Tasks. A low supply adds one; completing it asks
  how many pills you got. See [Task](task.md).
- Project, Waiting, After: none, on purpose. Medicine never changes Project
  attention, and its doses never appear on Home.
- Agents: list only. An agent cannot change a Medicine, because the phone sets
  its alarms only when the app sees the change.

## Left out on purpose

- A full record of missed doses or of old schedules.
- A refill history, and lowering the supply for doses taken without pressing
  Taken. Recount fixes the count.
- Notifications for running low, and a "Needs prescription" option.
- Two different doses taken on two phones before they sync each subtract from
  the same count, so one subtraction is lost. Recount fixes it.
- Medicine in global quick add, which offers only Task and Project.

## Ideas

None recorded yet.

How Android delivers notifications, and how to test it, is in the
[notification module](../../apps/agent-mobile/modules/zero-notifications/README.md).
