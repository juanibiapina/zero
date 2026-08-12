# Gmail & Calendar tools

The interface agent has in-Worker tools to read/send the user's Gmail and
read/write their Google Calendar. They call Google's REST APIs (`gmail/v1`,
`calendar/v3`) directly with a bearer token — no container, no CLIs. See
`docs/google-workspace.md` for the OAuth/connect plumbing.

## Port and adapters

A single `GoogleWorkspace` port (`apps/agent-api/src/google/types.ts`) groups two
sub-APIs, `mail` and `calendar`, and normalizes payloads to small flat shapes so
a field the model never needs never reaches it and a provider swap stays local.
It mirrors the WebSearch seam:

- **`google/rest.ts`** — `createGoogleWorkspace(getToken)`, the real adapter. A
  deep module: all REST, MIME, base64url, and multi-calendar fan-out detail live
  here. It takes a **token provider** `() => Promise<string | null>`, not a raw
  token.
- **`google/memory.ts`** — `createMemoryGoogle(seed)` for tests: canned
  threads/events, records sent mail and created events for assertions.

Tools are built by `buildGoogleTools({ google, timezone })`
(`apps/agent-api/src/tools/google.ts`) and added to the interface agent's tool set
alongside the topic, research, and set_timezone tools. The learning and research
agents do **not** get them.

## Token strategy

`createGoogleWorkspace` receives a provider, not a token, so a turn that never
calls a Google tool mints nothing. The DO wraps `getGoogleAccessToken` in
`memoizeTokenProvider` (`apps/agent-api/src/google-token.ts`): the first Google tool
call mints a token via Clerk and caches the promise (including a `null` result)
for the turn; later calls reuse it. A Google access token lives ~1h, longer than
any turn, so per-turn caching is safe.

A `null` token (not connected, or a Clerk outage) makes the adapter throw a typed
`GoogleNotConnectedError`. The tool layer converts it to `{ error }` data — the
model tells the user to connect Google in the Zero app and does not retry. A
`401` from Google (revoked grant / missing scope) maps to a distinct error.

The three irreversible tools do not use that error-as-data path. `gmail_send`,
`gmail_send_draft` and `calendar_create_event` classify a failure instead: a missing connection, or a
rejection status that is not a timeout (`408`) or a throttle (`429`), becomes
`ExternalCallNotSent`, which says the request provably had no effect. Anything
else — a `5xx`, a dead socket, a response lost while being read — is left
unclassified and propagates. Turning those into `{ error }` data would tell the
model the send failed when it may well have gone through, and the retry would
deliver the same mail twice. See the external-call claim in `docs/topics.md`.

## Tools

Reads need no confirmation. `gmail_send`, `gmail_send_draft` and
`calendar_create_event` are side-effecting and irreversible; their own tool
descriptions require explicit user confirmation of the exact content before any
of them runs. The label, trash and draft tools are reversible and run freely.

- `gmail_search(query)` — Gmail query syntax; returns thread
  id/date/sender/subject/snippet.
- `gmail_thread(threadId)` — full thread, each message with its Gmail id,
  RFC-822 `Message-ID` header, headers, decoded body, and named attachment
  summaries (`partId`, filename, MIME type, byte size).
- `gmail_save_attachment({ messageId, partId })` — re-fetch the canonical MIME
  part, download up to 20 MB, save it as a user-owned Zero file, and return its
  metadata and stable marker without bytes or base64.
- `gmail_send({ to, subject, body, cc?, bcc?, replyTo? })` — send or reply.
  `replyTo` is `{ messageIdHeader, threadId }` copied from a `gmail_thread`
  result.
- `gmail_labels()` — the user's labels by name, plus the system labels worth
  naming (`INBOX`, `UNREAD`, `STARRED`, `IMPORTANT`, `SPAM`, `TRASH`).
- `gmail_label({ name, newName? })` — create a label, or rename one.
- `gmail_modify_thread({ threadId, add?, remove? })` — the whole
  archive/read/star/file cluster in one tool: archive is `remove: ["INBOX"]`,
  mark read is `remove: ["UNREAD"]`, star is `add: ["STARRED"]`, filing is
  `add: ["Receipts"]`.
- `gmail_trash_thread({ threadId, restore? })` — trash or restore. Gmail keeps
  trash 30 days; this is the strongest deletion Zero has.
- `gmail_drafts()` — drafts waiting (`draftId`, to, subject, snippet).
- `gmail_draft({ ..., draftId? })` — save a draft, or replace an existing one.
- `gmail_send_draft({ draftId })` — send an approved draft.
- `calendar_list_calendars()` — the user's calendars (`id`, `summary`, whether
  `primary`, `accessRole`).
- `calendar_list_events({ from, to, query?, calendarIds? })` — agenda over a
  window across **all** calendars by default (each event tagged with its
  calendar), or a subset via `calendarIds`.
- `calendar_create_event({ summary, start, end, description?, location?, attendees?, allDay?, calendarId? })`
  — create on `calendarId` (default `primary`).

Not built: `calendar_update_event`, `calendar_delete_event`,
`calendar_freebusy`. Deliberately absent on the Gmail side: permanent delete
(`messages.delete` needs `https://mail.google.com/`, and its only difference
from trash is that mistakes cannot be undone), Gmail settings
(`gmail.settings.*`), per-message label changes, and label deletion.
`history.list` is in scope and worth having, but only alongside something that
stores a `historyId` and wakes up to compare it — that belongs with schedules.

## Gmail labels and drafts

**Labels are names, never ids.** The port speaks `Receipts`; the adapter
resolves it to `Label_12`. System labels are their own id (`INBOX`), user labels
are `Label_*`-shaped, nesting is spelled `Parent/Child`, and matching is
case-insensitive. `labels.list` is fetched at most once per adapter instance
(one per turn), and re-read after a create so a new label is usable immediately.
A model cannot invent `Label_12`, which is the whole reason ids stay inside.

`gmail_modify_thread` never creates a label: an unknown name fails with an error
that *lists the labels that exist*, so a typo is visible instead of quietly
producing "Reciepts". `SENT` and `DRAFT` are refused before the request is
built — Gmail answers `400 Invalid label: SENT`, and labels cannot be applied to
drafts at all.

**A draft update replaces the message.** Gmail cannot edit a draft's message,
only swap it: the `draftId` is stable while the message id inside changes on
every update. So `gmail_draft` with a `draftId` PUTs a complete new message, and
its description tells the model to pass the whole thing, never a fragment.
Sending a draft deletes it and creates a `SENT` message, so a repeated
`gmail_send_draft` is a 404 rather than a second send. Drafts and sends share
one MIME builder, which is what keeps a draft reply threaded exactly like a sent
one.

`drafts.list` returns bare ids (no `format` parameter), so listing drafts costs
one metadata read per draft — the same N+1 as `gmail_search` — and is bounded by
`MAIL_DRAFTS_CAP`.

Reversibility decides the failure policy: every new tool except
`gmail_send_draft` is reversible and reports failures as `{ error }` data.
`gmail_send_draft` is irreversible and classifies failures like `gmail_send`.

The interface agent is not the only Gmail consumer. The **onboarding agent**
(`agents/onboarding.ts`, see [`onboarding.md`](onboarding.md)) reuses the same
`GoogleWorkspace` port but is given only the read-only Gmail tools
(`gmail_search`, `gmail_thread`) to scan a new user's mail once and seed the
pinned `User` topic; it gets no `gmail_save_attachment`, `gmail_send`, or
calendar tools.

## Gmail id spaces

Three distinct identifiers; conflating them silently breaks reply threading:

- **Gmail message id** (`messages.get.id`) — opaque API handle.
- **RFC-822 `Message-ID` header** — what `In-Reply-To`/`References` must echo to
  make a proper reply. Header lookup is case-insensitive (`Message-ID` vs
  `Message-Id`) and walks the MIME `parts` tree recursively.
- **`threadId`** — keeps a sent message in the same conversation.

A reply needs **all three** of: `threadId` in the request JSON,
`In-Reply-To`/`References` set to the `messageIdHeader`, and a `Subject` that
matches the thread (the original subject, `Re:`-prefixed). Missing the Subject
match silently drops the message out of the thread, so the tool carries the
reply subject through.

Sending builds an RFC-822 MIME message (`Content-Type: text/plain;
charset="UTF-8"`, base64 body, encoded-word Subject when non-ASCII),
base64url-encodes it into `raw`, and POSTs to `users/me/messages/send`. Reading a
thread walks the nested `payload` tree, decodes base64url part bodies, and
prefers `text/plain` (falls back to stripped `text/html`). It also walks nested
mixed, related, and alternative parts for named files. Imports use the Gmail
message id plus MIME `partId` only as transient tool inputs: the adapter
re-fetches the message, resolves canonical filename/MIME/size metadata, then
uses inline `body.data` or the Gmail attachments endpoint. Gmail identifiers are
not stored in file metadata or markers.

## Calendar / timezone contract

The calendar tools close over the user's IANA timezone (the value already
threaded to the interface agent from the timezone work). The model supplies
**local wall-clock** times; the tools stamp the zone:

- `calendar_list_events` `from`/`to` are a local date (`YYYY-MM-DD`) or datetime
  (`YYYY-MM-DDTHH:MM`); the tool resolves them to RFC-3339 `timeMin`/`timeMax`
  with the zone's offset.
- `calendar_create_event` sends `{ dateTime, timeZone: <user zone> }` (or
  `{ date }` for `allDay`), so Google resolves DST for future dates.

When the user has no reported timezone the value falls back to `UTC`; the prompt
tells the model to restate a create time **with its timezone** for confirmation
so a mis-detected zone is caught before the (irreversible) write.

## Multi-calendar model

Users have several calendars (own, work, shared, subscribed); `primary` is only
the user's own. Listing only `primary` yields a confidently-wrong agenda, so:

- `listCalendars` enumerates `calendarList.list` → `CalendarSummary`.
- `listEvents` with no `calendarIds` fans out over every calendar with at least
  reader access (skips `none`/`freeBusyReader`), issues one `events.list` per
  calendar, tags each event with its `calendarId`/`calendarSummary`, and merges
  the results sorted by start time.
- `createEvent` targets `calendarId` (default `primary`). The prompt tells the
  model to confirm the target calendar when ambiguous rather than defaulting.

## Recurring events and result caps

`events.list` always passes `singleEvents=true` and `orderBy=startTime`, so a
recurring series arrives expanded into dated instances rather than a single RRULE
item. Every list is bounded (Gmail search and each calendar `events.list` cap
results and do **not** follow `nextPageToken`); the tool flags truncation
(`truncated: true` when the result count hits the cap) so the model can narrow
the query. Caps live in `google/types.ts` (`MAIL_SEARCH_CAP`,
`CALENDAR_EVENTS_CAP`, `CALENDAR_PER_LIST_CAP`).

## Testing

- `google/rest.test.ts` — mocks global `fetch`; asserts request shape, multipart
  decode, case-insensitive/recursive header lookup, non-ASCII send round-trip,
  reply threading, calendar fan-out/tag/merge/skip, `{ dateTime, timeZone }`
  create, and the `401`/`500`/null-token error paths.
- `tools/google.test.ts` — memory adapter; asserts each tool's shape, wall-clock
  → zone stamping, `calendarId` default vs override, and that
  `GoogleNotConnectedError` surfaces as `{ error }` data.
- `agents/interface.test.ts` — a scripted run reads a Gmail thread then replies.
- `google-token.test.ts` — `memoizeTokenProvider` mints once and caches `null`.
