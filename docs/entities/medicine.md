# Medicine and Dose

Medicine is a daily routine with a name, optional instructions, one or more daily dose slots, a start date, an optional inclusive last day, and a paused state. Each slot has an early reminder and a dose time on the same calendar day. Dates and times follow the phone's local clock.

Dose is a separate dated occurrence identified by Medicine ID, slot ID, and date. It stores its scheduled dose time and the actual timestamp when Taken was pressed. The confirmation and scheduled-time snapshot persist together, so a concurrent time edit cannot rewrite confirmation history. See [storage](../storage.md) for persistence and synchronization.

## Surfaces

Manage routines under Browse → Medicines on mobile, or Medicines in the web sidebar. The mobile Medicines list has its own plus button, opening its dedicated creation drawer. Global quick-add offers only Task and Project. There are no Medicine rows on Home, and Medicine does not change Task ordering, Project attention, Waiting, After, Upcoming grouping, or the launcher Task count.

The mobile drawer starts with a name, optional description, daily frequency, and visible suggested times. New routines start today and continue indefinitely. Once a day suggests 20:00; twice suggests 08:00 and 20:00; three times suggests 08:00, 14:00, and 20:00; four times suggests 08:00, 12:00, 16:00, and 20:00. Suggested early reminders come one hour before once-daily doses and thirty minutes before three-times-daily doses. Twice-daily and four-times-daily presets use fifteen minutes. New custom slots use the default for the resulting daily count and preserve existing slots; other counts use fifteen minutes. Saved and copied schedules retain their configured reminder times unless you choose a frequency preset. Adjust opens individual times, reminders, start date, and optional course length. Existing custom schedules stay intact when editing a name or description. Failed saves retain the draft; retrying saves the same routine.

The mobile list emphasizes names and times. Detail emphasizes today's independent doses and actual confirmation times. Recorded doses have no Undo action on mobile. Mobile confirmations use the notification's Taken action; its Postpone 1 hour action defers the dose. History and medicine options expand on request. The top of the mobile Medicines list shows one notice with one fix-it button only when reminders are off on the phone, failed to schedule, lack notification or exact-alarm access, have their category turned off, or face battery restrictions. Muted sound never shows a notice, and detail pages show no reminder setup. Ended routines retain history and offer Add again, which creates a fresh Medicine identity and date range. Delete removes the routine and its known history and prevents stale replicas from reviving its accepted state.

## Daily behavior

At the early time, Android posts a normal notification with Taken. If still pending at dose time, it replaces that card and alerts once again. Both stages use the Medicine reminders category under Medicines, with high importance, the system notification sound, and vibration by default. Android may show a heads-up banner. Sound follows notification volume, ringer mode, Do Not Disturb, and the user's category settings. There is no looping alarm playback or full-screen medicine screen.

Each Dose has at most one card: a newer stage replaces the visible card of the same Dose and alerts again. Different Doses of one Medicine, such as morning and evening, keep separate cards and actions.

Postpone 1 hour closes the card and keeps that Dose quiet for one hour. Then the card returns and alerts once, with Taken and Postpone 1 hour. The returned card says the dose is due if its dose time has passed. Every stage scheduled within the hour is skipped, so postponing the early card can also defer the dose-time alert; a dose time after the hour still alerts. The card can be postponed again. A postpone never crosses midnight: it returns at 23:59 at the latest, and at 23:59 Postpone only closes the card. Taken, pausing, ending, deleting, or changing that dose time cancels a pending postpone. Reboot rearms a pending postpone and quietly restores a return that was missed while the phone was off. Postpone is delivery state on one phone and does not sync.

A notification can be swiped away. Dismissal leaves the dose pending and does not cancel the later dose-time notification. Refresh and restart do not replay an already delivered stage or immediately restore a dismissed card. Quiet catch-up cards can appear when enabling a schedule after its early time. Reboot restores undismissed pending cards quietly.

Taken records that one occurrence, removes its notification, and cancels its future delivery without opening the app. Confirmations persist natively without JavaScript, login, or a network connection. Repeated delivery of the same Taken action does not create another confirmation. Tapping the card opens its Medicine and dated Dose. Medicine details are private on the lock screen, with a generic public notification.

Standard notification forwarding allows a paired watch to receive the card. Enable Zero Agent notifications in the watch companion app. Watch sound, vibration, connectivity, and Do Not Disturb govern the watch alert. No standalone watch app is required. Forwarding and Taken availability must be checked on the actual watch model.

Taking the morning dose leaves afternoon and evening doses scheduled. Simultaneous doses share a scheduled wake-up and have separate notifications and Taken actions. The shared model's undo operation clears only the chosen confirmation; it re-arms a future deadline but does not replay an elapsed one. Notification actions preserve their original slot and date. At midnight old pending notifications close and the next date is independent.

### Power saving and upgrades

Dose deadlines use Android alarm-clock scheduling, which wakes the device through normal Battery Saver and Doze and exposes an upcoming-alarm indicator. The wake-up posts an ordinary notification. Early reminders use exact allow-while-idle scheduling; Android throttles these alarms per app in idle, so closely spaced early reminders can be delayed. These schedulers require exact-alarm access on relevant Android versions.

For reliable delivery, open App battery usage through reminder settings and choose Unrestricted if available. Manufacturer power controls can impose additional restrictions. The app warns only when Android reports a background restriction, so the absence of a warning does not prove every manufacturer restriction is disabled.

Reboot clears Android's scheduled alarms. Saved definitions restore future delivery when the phone starts, without reopening the app. Package replacement, clock/timezone changes, and restored exact-alarm access also restore scheduling. Android backup does not copy reminder delivery state, so a reinstalled app starts with reminders off and schedules them once turned on.

## Dates and changes

Ongoing has no last day. Number of days calculates `startsOn + days - 1`; for example October 2 through October 11 is ten days. Every eligible last-day slot runs, then delivery ends. Pausing and missed doses never extend the last day.

Edits apply immediately to eligible future notifications. Past deadlines do not replay. Stable slot IDs preserve confirmations through time changes and reordering; a removed then newly added slot has a fresh identity. Reminder time must precede dose time on the same day; dose times within one Medicine must be distinct. Instructions apply to all daily slots.

## History and delivery limits

Taken at records the time of confirmation, which may differ from the time the medicine was physically taken. History retains recorded occurrences and their scheduled snapshots. It does not reconstruct old schedules, pauses, or complete missed-dose totals.

Android delivery is enabled separately on each phone. Exact-alarm access and notification permission/category settings must allow delivery. The new behavior requires a native APK containing the updated reminder module. Closed-app confirmations import into the shared workspace on the next app opening. Remote edits or confirmations reach a phone when it syncs; an offline phone cannot cancel a notification based on an unseen remote change. Power-off, force-stop, OEM extreme power saving, missing permissions, muted devices, and disconnected or filtered watches limit delivery or alerting. Notification importance does not override these settings or guarantee a banner.

## Development and verification

The local [medicine-reminders module](../../apps/agent-mobile/modules/medicine-reminders) implements Android delivery. After generating the development Android project, run its channel and delivery tests from `apps/agent-mobile/android`:

```bash
./gradlew :medicine-reminders:testDebugUnitTest --max-workers=1
```

These tests and agent-core's Vitest suite read the same contract fixtures in `packages/agent-core/src/medicines/native-contract`, so the Android engine and the shared model must agree on dose identity, dose times, and receipt fields. The `Mobile native tests` workflow runs the Android tests in CI whenever native or medicine code changes.

Course, history, and pause behavior is covered by Jest. The normal suite runs one medicine phone flow: a reminder notification appears in the shade, and Taken from the notification is recorded as a dose:

```bash
pnpm --filter @zero/agent-mobile e2e:pixel
```

Run native delivery checks with a fresh debug APK and a hermetic Metro server:

```bash
pnpm --filter @zero/agent-mobile e2e:medicine-native
```

The harness opens `zeroagent:///e2e-medicine-proof`, grants notification and exact-alarm access, and captures artifacts under `/tmp/medicine-native-proof`. The route is available only in the hermetic profile. Its separate SQLite workspace uses a separate silent test category; production category defaults stay audible. Silence survives process death and reboot.

The default native proof checks early Taken cancellation, both stages with Battery Saver, both stages with Battery Saver plus forced Doze, reboot restoration, simultaneous-dose independence, receipt replay, and checkpoint races. It checks native delivery logs against a 30-second timing criterion and checks that no alarm playback starts. This criterion is controlled-device evidence, not an unconditional Android timing guarantee.

Metro defaults to port 8098; override it with `E2E_METRO_PORT`. `E2E_NATIVE_PROOF_CASE=power` selects power-saving cases; `boot` selects reboot, replay, and checkpoint; `handoffs` selects replay and checkpoint. To resume an interrupted run, `remaining` skips the initial early Taken case, and `finish` selects simultaneous doses, replay, and checkpoint. Reboot requires a test phone without a screen lock. The harness restores its temporary Battery Saver, battery simulation, and idle settings on exit.

For process-death checks, background and kill the process rather than force-stopping the app: force-stop cancels Android delivery. Clear native proof removes test alerts. Silent automated checks cannot establish audible or tactile behavior. A physical phone/watch sound check requires an appropriate connected watch and audible device settings.
