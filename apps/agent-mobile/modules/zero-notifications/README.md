# Scheduled notifications (Android)

This native module shows scheduled notifications and runs their buttons with no JavaScript running. JavaScript describes what to show in a schedule; the module decides only when. The schedule format, the device interface and the shared parser live in [`packages/agent-core/src/notifications`](../../../../packages/agent-core/src/notifications/schedule.ts). Medicine is the only source today; how Medicine maps onto the module is in [`packages/agent-core/src/medicines/notifications.ts`](../../../../packages/agent-core/src/medicines/notifications.ts), and its product rules are in [Medicine](../../../../docs/entities/medicine.md).

## Terms

- **Source:** one feature that installs its own schedule, such as `medicines`.
- **Reminder:** one definition in a schedule: a repeat rule, the times of day it shows, its text, buttons and link.
- **Occurrence:** a Reminder on one date, identified by source, key and date.
- **Stage:** a time of day at which an occurrence shows.
- **Card:** the visible notification. An occurrence has at most one.
- **Settled:** done. A settled occurrence shows nothing more.
- **Receipt:** a record the module writes when a card is shown (`presented`) or a settle button is used (`settled`). JavaScript imports receipts and acknowledges them.

## Rules

1. A Reminder has an occurrence on each date its recurrence allows. An occurrence's card changes only through its own stages and buttons; occurrences never affect each other's cards.
2. An occurrence is settled when its date is in the Reminder's `settled` list, or when the module settled it since the last install, or when the module holds an unacknowledged settle receipt for it. Each install keeps only the last kind of the module's own record.
3. At each stage time of an unsettled occurrence, its card is posted or replaced with that stage's text and alerts.
4. Only stages scheduled before their time fire. A stage already past when its Reminder, date and time were first installed never shows. Reinstalling the same Reminder keeps its stages scheduled.
5. A settle button records one receipt, closes the card and settles the occurrence. Repeating it changes nothing.
6. A snooze button closes the card and skips the occurrence's stages until the snooze ends. Then the card returns through an alarm clock with the text of the latest stage at or before that time. Snoozes stay on the phone and write no receipt.
7. A swiped card is forgotten; later stages of the occurrence still fire.
8. Cards never expire.
9. Install closes a card or cancels a snooze when its occurrence is settled, its Reminder is gone or no longer occurs on that date, or the stage that showed the card no longer exists at the same time.
10. Times are wall times in the phone's current zone. A time inside a daylight-saving gap moves forward by the gap.
11. One workspace owns the store. Another workspace takes it over unless unacknowledged settle receipts remain. A quiesced store shows nothing and refuses settle until the next install.

The parser rejects a whole schedule on any error, including unknown fields, so a schedule this APK does not understand fails loudly.

## Delivery, power saving and restarts

Stages with `wake: "alarmClock"` and snooze returns use Android alarm-clock scheduling, which wakes the phone through Battery Saver and Doze and shows the upcoming-alarm indicator. Stages with `wake: "exact"` use exact allow-while-idle alarms, which Android throttles per app in idle. The module arms at most one alarm of each kind, so a delayed exact alarm cannot delay an alarm clock. Both need exact-alarm access on Android 12 and later.

Every channel has high importance, the default notification sound and vibration. A schedule declares its channels and install creates any that are missing; after that only the name changes, and sound and importance belong to the user. Changing a channel id resets the user's settings for it. A blocked channel or channel group shows nothing and records nothing.

Reboot clears alarms and notifications. After a reboot the module restores visible cards quietly and, for each Reminder, quietly shows the newest stage or snooze return it missed while the phone was off. Clock changes, zone changes, app updates and regained exact-alarm access re-arm the alarms and show anything that came due, alerting. The store lives in `no_backup`, outside Android backup.

## What needs an APK

Any change to the schedule format or the module's behavior: a new field, a new repeat rule, a new button kind, a new icon, a new wake kind, or new channel behavior. Such a change updates both parsers and adds fixture cases in [`conformance/`](../../../../packages/agent-core/src/notifications/conformance). Everything a schedule expresses (text, buttons, links, stage times, which Reminders exist) ships as an EAS Update.

## Limits

Android stops posting an app's notifications once it has 50 open, and this module does not guard against that. Force-stop cancels all alarms until the app opens again. Missing permissions, a blocked channel, manufacturer power controls, a muted phone or a disconnected watch limit delivery or alerting.

## Development and verification

After generating the development Android project, run the module's tests from `apps/agent-mobile/android`:

```bash
./gradlew :zero-notifications:testDebugUnitTest --max-workers=1
```

These tests and agent-core's Vitest suite read the same fixtures in `packages/agent-core/src/notifications/conformance`, so the two parsers and recurrence functions must agree. CI runs the Kotlin tests whenever the module, the fixtures or the TypeScript notification code changes, and an EAS Update waits for them.

The normal phone suite (`pnpm --filter @zero/agent-mobile e2e:pixel`) shows a medicine card in the shade and records Taken from it. Deadline delivery, Battery Saver, Doze, reboot and race checks run in a separate harness with a fresh debug APK and a hermetic Metro server:

```bash
pnpm --filter @zero/agent-mobile e2e:medicine-native
```

The harness opens `zeroagent:///e2e-medicine-proof`, grants notification and exact-alarm access, and stores artifacts under `/tmp/medicine-native-proof`. The proof route is available only in the hermetic profile and silences its own workspace through a separate silent test channel; production channels stay audible. It checks the `notification_presented` log lines against a 30-second timing criterion, which is evidence on a controlled device, not an Android guarantee.

Metro defaults to port 8098; override it with `E2E_METRO_PORT`. `E2E_NATIVE_PROOF_CASE=power` selects the power-saving cases; `boot` selects reboot, replay and checkpoint; `handoffs` selects replay and checkpoint; `remaining` skips the first case; `finish` selects simultaneous occurrences, replay and checkpoint. Reboot needs a test phone without a screen lock. For process-death checks, background and kill the process instead of force-stopping the app.
