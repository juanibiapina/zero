# Medicine and Dose

Medicine is a daily routine with a name, optional instructions, one or more daily dose slots, a start date, an optional inclusive last day, and a paused state. Each slot has its own early reminder and later alarm on the same calendar day. Dates and times follow the phone's local clock.

Dose is a separate dated occurrence identified by Medicine ID, slot ID, and date. It stores its scheduled alarm time and the actual timestamp when Taken was pressed. The confirmation and scheduled-time snapshot persist together, so a concurrent time edit cannot rewrite confirmation history. See [storage](../storage.md) for persistence and synchronization.

## Surfaces

Manage routines under Browse → Medicines on mobile, or Medicines in the web sidebar. The mobile Medicines list has its own plus button, opening its dedicated creation drawer. Global quick-add offers only Task and Project. There are no Medicine rows on Home, and Medicine does not change Task ordering, Project attention, Waiting, After, Upcoming grouping, or the launcher Task count.

The mobile drawer starts with a name, optional description, daily frequency, and visible suggested times. New routines start today and continue indefinitely. Once a day suggests 20:00; twice suggests 08:00 and 20:00; three times suggests 08:00, 14:00, and 20:00; four times suggests 08:00, 12:00, 16:00, and 20:00. These are daytime schedules. Suggested reminders come one hour before once-daily alarms and thirty minutes before three-times-daily alarms. Twice-daily and four-times-daily presets use fifteen minutes. New custom slots use the default for the resulting daily count and preserve existing slots; other counts use fifteen minutes. Saved and copied schedules retain their configured reminder times unless you choose a frequency preset. Adjust opens individual times, reminders, start date, and optional course length. Existing custom schedules stay intact when editing a name or description. Failed saves retain the draft; retrying saves the same routine.

The mobile list emphasizes names and times. Detail emphasizes today's independent doses, Taken and Undo, and actual confirmation times. History and medicine options expand on request. Android reminder setup appears only when delivery is disabled or needs attention. Ended routines retain history and offer Add again, which creates a fresh Medicine identity and date range. Delete removes the routine and its known history and prevents stale replicas from reviving its accepted state.

## Daily behavior

At the early time, the Android phone posts a quiet notification with Taken. If still unrecorded at the alarm time, it rings using alarm audio for up to sixty seconds. Taken records that one occurrence, removes its notification, and cancels or stops its sound without opening the app. Swiping a notification away does not record the dose. There is no separate Stop alarm action.

Taking the morning dose leaves afternoon and evening doses scheduled. Undo clears only the chosen confirmation; it re-arms a future alarm but does not replay an elapsed one. Notification actions preserve their original slot and date. At midnight old pending notifications close and the next date is independent.

Reboot clears Android’s scheduled alarms. The app restores future Medicine reminders from saved schedules when the phone starts again, without requiring you to reopen the app. The reboot test checks this restoration so reminders do not silently stop after a restart or system update.

## Dates and changes

Ongoing has no last day. Number of days calculates `startsOn + days - 1`; for example October 2 through October 11 is ten days. Every eligible last-day slot runs, then delivery ends. Pausing and missed doses never extend the last day.

Edits apply immediately to eligible future alarms. Past alarms do not replay. Stable slot IDs preserve confirmations through time changes and reordering; a removed then newly added slot has a fresh identity. Reminder time must precede alarm time on the same day; alarm times within one Medicine must be distinct. Instructions apply to all daily slots.

## History and delivery limits

Taken at records the time of confirmation, which may differ from the time the medicine was physically taken. History retains recorded occurrences and their scheduled snapshots. It does not reconstruct old schedules, pauses, or complete missed-dose totals.

Android delivery is enabled separately on each phone. Exact-alarm access and notification permission/channel settings must allow delivery. Older APKs can manage Medicine but need a native build containing reminder support to deliver alarms. Closed-app notification confirmations persist natively and import into the shared workspace on the next app opening. Remote edits or confirmations reach a phone when it syncs; an offline phone cannot cancel an alarm based on an unseen remote change. Force-stop, power-off, and alarm-volume settings affect delivery.

## Development and verification

The local [medicine-reminders module](../../apps/agent-mobile/modules/medicine-reminders) implements Android delivery.

The course/history flow runs in the normal suite:

```bash
pnpm --filter @zero/agent-mobile e2e:pixel
```

Run native delivery checks with a debug build and a hermetic Metro server:

```bash
pnpm --filter @zero/agent-mobile e2e:medicine-native
```

The native harness opens `zeroagent:///e2e-medicine-proof`, grants notification and exact-alarm access, and captures artifacts under `/tmp/medicine-native-proof`. The route is available only in the hermetic profile. It uses its own SQLite workspace and mutes playback before installing any schedule; muting survives process death and reboot and applies only to that test workspace.

Metro defaults to port 8098; override it with `E2E_METRO_PORT`. `E2E_NATIVE_PROOF_CASE=boot` selects reboot, cutoff, replay, and checkpoint checks; `handoffs` selects replay and checkpoint. Reboot checks require a phone without a screen lock. Idle checks temporarily change the alarm-clock wake guard and restore its setting on exit.

When checking process death, background and kill the process rather than force-stopping the app: force-stop cancels Android delivery. Check notification Taken, confirmation persistence across restart, alarm-service cancellation, and future delivery after reboot. The route's Clear native proof action removes test alerts. Silent checks do not verify audible volume; a sound check requires explicit permission.
