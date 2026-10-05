# User Timezone

The interface agent anchors every turn to an absolute datetime rendered in
the user's timezone (see `formatAnchor` in `apps/zero-api/src/agents/prompts.ts`).
Correct time is load-bearing: relative phrasing ("this afternoon",
"tomorrow 9am") and, later, calendar windows all resolve against it.

## Source of truth: the device the user is on

Telegram's Bot API carries **no timezone** — every update has a UTC epoch
and nothing else. The reliable signal is the client device's OS zone, a
canonical IANA name (`Europe/Berlin`, `America/Sao_Paulo`):

- **Web:** `Intl.DateTimeFormat().resolvedOptions().timeZone`. Linking Telegram
  forces a web-app visit (the Login Widget), so a browser context always exists
  before the first Telegram message.
- **Mobile:** `expo-localization`'s `getCalendars()[0].timeZone`. **Not** Hermes
  `Intl…resolvedOptions().timeZone`, which can return `"UTC"` and silently pin
  the wrong day.

The server stores **one** zone; whichever device the user just opened writes its
zone (last-open-wins). For "what is today for this user", matching the device in
front of them is correct.

## Storage

The canonical IANA name is stored per user in `userSettings.timezone`
(DO SQLite). **Never an offset.** Storing `Europe/Berlin` lets every instant
be formatted with DST resolved automatically; storing `+02:00` would break at
the next DST transition. The value is null until first reported; the prompt
falls back to `UTC` (see `DEFAULT_TIMEZONE`).

Server-side validation (`isValidTimezone` in `apps/zero-api/src/timezone.ts`)
rejects anything that isn't a member of `Intl.supportedValuesOf("timeZone")`
or `UTC`. Legacy abbreviations like `PST` are rejected on purpose — they
carry a fixed offset and ignore DST.

## Sync mechanism (one shared core, per-surface adapters)

The decision lives in one deep module, `createTimezoneSync` in
`packages/agent-core/src/timezone/sync.ts`, with three injected ports: a
**DeviceClock** (the OS zone), a **TimezoneStore** (a persisted, device-local
baseline of the last zone we synced), and a **SettingsGateway** (`PATCH
/api/user-settings`). Zone validity (`isCanonicalZone`) is folded into the core.

The core compares the device zone to the **store**, not to a server round-trip,
and PATCHes only when they differ — then advances the store, and only on a
confirmed write (a failed PATCH retries on the next trigger). So:

- First install / sign-up: store empty → one PATCH. Correct from message #1.
- Same zone next open: equal to the store → **no request** (steady state).
- Travel: differs → one PATCH, then the store advances.

The sync is silent (never a prompt) and issues **no timezone GET** — the store is
the baseline. It runs on cold start (`onColdStart`) and, on mobile, on every
`AppState` foreground (`onForeground`), coalesced by an in-flight guard.

Per surface:

- **Web** (`apps/zero-web/src/lib/timezone-sync.ts`, wired in `App.tsx`): a
  `localStorage` store; the mount `GET /api/user-settings` (needed for
  onboarding) also seeds the baseline via `onColdStart(serverZone)`. Web also
  sends `region` derived from the locale. A plain reload no longer re-PATCHes.
- **Mobile** (`apps/agent-mobile/src/lib/timezone-sync.ts`, wired in the
  `(todo)/_layout.tsx`): an `AsyncStorage` store; no settings GET at boot.
  The stores are per-surface and independent — the single shared state is the
  server; the shared *code* is the port contract and the core.

## Telegram-only travel

A user who travels and only uses Telegram (never opens the web app) can't be
auto-detected. The `set_timezone` tool
(`apps/zero-api/src/tools/timezone.ts`) covers this: when the user says where they
are ("I'm in Tokyo now"), the model calls it with the IANA zone. The tool
validates and, on a miss, returns near matches (`suggestTimezones`) so the
model can correct itself. No timezone list is fed into the prompt — the model
maps place → IANA on its own and the tool is the guardrail.

Setting the zone mid-turn does not retroactively change that turn's anchor
(computed at turn start); the next turn is correct.

## Wiring

`UserDO.runTurn` reads `getSettings().timezone` and passes it plus a
`setTimezone` callback into `orchestrateTurn` → `runInterfaceAgent`, threaded
like `now`/`send`. The tool writes back through `updateSettings`.
