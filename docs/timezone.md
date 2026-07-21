# User Timezone

The interface agent anchors every turn to an absolute datetime rendered in
the user's timezone (see `formatAnchor` in `apps/agent-api/src/agents/prompts.ts`).
Correct time is load-bearing: relative phrasing ("this afternoon",
"tomorrow 9am") and, later, calendar windows all resolve against it.

## Source of truth: the browser

Telegram's Bot API carries **no timezone** — every update has a UTC epoch
and nothing else. The only reliable signal is the browser's
`Intl.DateTimeFormat().resolvedOptions().timeZone`, which returns a canonical
IANA name (`Europe/Berlin`, `America/Sao_Paulo`) from the OS. Linking
Telegram forces a web-app visit (the Login Widget), so a browser context
always exists before the first Telegram message.

## Storage

The canonical IANA name is stored per user in `userSettings.timezone`
(DO SQLite). **Never an offset.** Storing `Europe/Berlin` lets every instant
be formatted with DST resolved automatically; storing `+02:00` would break at
the next DST transition. The value is null until first reported; the prompt
falls back to `UTC` (see `DEFAULT_TIMEZONE`).

Server-side validation (`isValidTimezone` in `apps/agent-api/src/timezone.ts`)
rejects anything that isn't a member of `Intl.supportedValuesOf("timeZone")`
or `UTC`. Legacy abbreviations like `PST` are rejected on purpose — they
carry a fixed offset and ignore DST.

## Sync mechanism (one code path)

`apps/agent-web/src/App.tsx` already does `GET /api/user-settings` on mount. It now
compares the stored zone to `Intl...timeZone` and `PATCH`es only when the
zone is **missing or changed**:

- First sign-up: stored is null → PATCH sets it. Correct from message #1.
- Same location next visit: equal → no request.
- Travel (via the web app): differs → one PATCH corrects it.

Steady state is zero extra writes.

## Telegram-only travel

A user who travels and only uses Telegram (never opens the web app) can't be
auto-detected. The `set_timezone` tool
(`apps/agent-api/src/tools/timezone.ts`) covers this: when the user says where they
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
