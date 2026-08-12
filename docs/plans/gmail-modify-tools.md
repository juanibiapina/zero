# Plan: the rest of the Gmail tools

## Goal

Zero can already search Gmail, read a thread, save an attachment and send.
Everything else the user does in Gmail every day — archive, label, mark read,
star, trash, draft — it cannot do. This adds those, so "archive that", "file it
under Receipts", "draft a reply and let me look at it first" work.

No new OAuth scope. Every call below is already covered by the `gmail.modify`
grant the app requests today (`apps/agent-web/src/google-scopes.ts`), so nothing
here triggers another verification round or a re-consent prompt.

## Background

- Port: `apps/agent-api/src/google/types.ts` (`GoogleWorkspace` = `mail` +
  `calendar`). Adapters: `google/rest.ts` (production, deep: all REST/MIME/
  base64url lives there) and `google/memory.ts` (tests).
- Tools: `apps/agent-api/src/tools/google.ts`, built by `buildGoogleTools` and
  given only to the **interface agent**. The onboarding agent gets read-only
  Gmail (`gmail_search`, `gmail_thread`) and must keep getting only those.
- Failure policy is already established and must be followed exactly:
  `guard()` turns any failure into `{ error }` data for reversible calls;
  `writeGuard()` is for irreversible ones and only converts a **provable
  non-effect** into an error, otherwise it propagates so `agents/run.ts` can
  leave the claim in flight (see `docs/google-tools.md`, `agents/external-call.ts`).
- `docs/google-tools.md` lists `gmail_modify_labels` as unbuilt "Phase 2"; this
  plan is that work.

### Verified endpoints and scopes

Read from the live discovery document
(`https://gmail.googleapis.com/$discovery/rest?version=v1`), not the reference
pages. All of these list `gmail.modify` among their scopes:

| Call | HTTP |
|---|---|
| `labels.list` | `GET users/me/labels` |
| `labels.create` | `POST users/me/labels` |
| `labels.patch` (rename) | `PATCH users/me/labels/{id}` |
| `threads.modify` | `POST users/me/threads/{id}/modify` |
| `threads.trash` / `threads.untrash` | `POST users/me/threads/{id}/trash` / `/untrash` |
| `drafts.list` | `GET users/me/drafts` |
| `drafts.create` | `POST users/me/drafts` |
| `drafts.update` | `PUT users/me/drafts/{id}` |
| `drafts.send` | `POST users/me/drafts/send` |

`messages.delete`, `messages.batchDelete` and `threads.delete` list **only**
`https://mail.google.com/`, and `settings.*` needs `gmail.settings.basic` /
`.sharing`. Both stay out (see Non-goals).

## Tools to add

Seven, all on the interface agent. Names follow the existing `gmail_*` shape.

1. **`gmail_labels()`** — list the user's labels (`name`, `type`: system/user;
   the id stays inside the adapter). Read-only. Return every user label but only
   the system labels worth naming (`INBOX`, `UNREAD`, `STARRED`, `IMPORTANT`,
   `SPAM`, `TRASH`): a mailbox may hold hundreds of labels plus a pile of
   `CATEGORY_*` and `CHAT` noise, and all of it would land in the model's
   context.
2. **`gmail_label({ name, newName? })`** — create the label `name`, or, when
   `newName` is given, rename `name` to it. Reversible. A duplicate name is a
   Gmail error (a user label may not shadow a system label name); surface it as
   a plain message rather than retrying.
3. **`gmail_modify_thread({ threadId, add?: string[], remove?: string[] })`** —
   the workhorse. Label names, not ids. This one tool is archive (`remove:
   ["INBOX"]`), mark read/unread (`remove`/`add: ["UNREAD"]`), star (`add:
   ["STARRED"]`) and filing (`add: ["Receipts"]`). Reversible.
4. **`gmail_trash_thread({ threadId, restore? })`** — trash, or restore from
   trash. Reversible (Gmail keeps trash 30 days), so it is the strongest
   deletion Zero offers.
5. **`gmail_drafts()`** — list drafts (`draftId`, `to`, `subject`, `snippet`),
   so a draft written in an earlier conversation can still be found. Read-only.
   **`drafts.list` returns bare ids only** — it has no `format` parameter and the
   `Draft.message` it returns carries just `id`/`threadId` — so the adapter must
   fan out one `drafts.get?format=metadata` per draft to fill those headers.
   That is the same N+1 `mail.search` already does per thread, so cap it the
   same way: add `MAIL_DRAFTS_CAP = 20` next to `MAIL_SEARCH_CAP` and flag
   `truncated`.
6. **`gmail_draft({ to, subject, body, cc?, bcc?, replyTo?, draftId? })`** —
   create a draft, or replace the one named by `draftId`. Reversible, and the
   safe half of "write this email for me".
   **An update replaces the whole message**: a draft's message cannot be edited,
   only swapped, and the underlying message id changes each time while
   `draftId` stays stable. So the tool description must tell the model to pass
   the complete new message, never a fragment — a partial update silently
   discards the rest of the draft.
7. **`gmail_send_draft({ draftId })`** — send an existing draft.
   **Irreversible**: `externalWrite: true` and `writeGuard`, exactly like
   `gmail_send`, and its description demands the same explicit confirmation.
   Sending deletes the draft and returns a new message with the `SENT` label, so
   the tool returns that message id and says the draft is gone; a later call
   with the same `draftId` is a 404, not a second send.

Only #7 is irreversible. Everything else uses `guard()` and needs no
confirmation ritual; the prompt already tells the model to say what it did.

### Decisions worth keeping

- **Labels by name, ids hidden.** The model says "Receipts"; the adapter
  resolves names to ids. System labels (`INBOX`, `UNREAD`, `STARRED`, `SPAM`,
  `IMPORTANT`) are their own ids; user labels are `Label_12`-shaped and are
  matched case-insensitively, with nesting spelled `Parent/Child`. Resolution
  caches `labels.list` per adapter instance, so a modify costs one extra GET at
  most per turn. Keeping ids out of the port is what makes this usable at all:
  a model cannot invent `Label_12`.
- **`gmail_modify_thread` never creates a label.** An unknown name is an error
  that *lists the labels that do exist*, so a typo fails loudly and visibly
  instead of quietly creating "Reciepts". Creation is the explicit
  `gmail_label` call. (Considered and rejected: an auto-create flag. It saves
  one round trip and buys a category of silent clutter.)
- **`SENT` and `DRAFT` are refused before the request goes out.** Gmail rejects
  adding or removing them with `400 Invalid label: SENT`, and labels cannot be
  applied to draft messages at all. The tool rejects those two names itself with
  a sentence saying why, instead of relaying a Gmail error the model will try to
  work around.
- **Thread-level, not message-level.** Every id the model holds comes from
  `gmail_search` (threads) or `gmail_thread`, and Gmail's own UI is
  thread-shaped. `messages.modify` is available under the same scope if a real
  need for per-message state shows up.
- **Deleting a label is not offered.** `labels.delete` is in scope but it
  destroys a user's filing across their whole mailbox, and Gmail's own UI is one
  click away.

## Cost to weigh before building

Tool schemas sit in the cached prefix of every interface turn (see
`docs/caching.md`), so seven more tools is a permanent per-turn token cost for
every user, plus one cache-prefix invalidation at deploy. Keep each description
to the two lines it needs, and cut `gmail_labels` first if the budget bites (its
job is partly done by the error message in decision 2).

## Implementation phases

1. **Port + memory adapter.** Extend `MailApi` with `listLabels`, `createLabel`,
   `renameLabel`, `modifyThread`, `trashThread`, `untrashThread`, `listDrafts`,
   `createDraft`, `updateDraft`, `sendDraft`, plus the flat result types
   (`MailLabel`, `MailDraftSummary`). Teach `createMemoryGoogle` to record
   modifications and drafts the way it already records `sentMail`.
2. **REST adapter.** The nine calls above, label-name resolution with its cache,
   and reuse of the existing MIME builder for drafts — the `raw` body of a draft
   is the same RFC-822 message `send` already builds, so extract that builder
   rather than copying it (that shared builder is also what keeps reply
   threading correct for drafts: `threadId` in the JSON, `In-Reply-To`/
   `References` from `messageIdHeader`, `Re:`-prefixed subject).
3. **Tools + descriptions**, with `externalWrite` on `gmail_send_draft` only.

   Optional, and cheap once the builder is shared: `drafts.send` accepts a
   replacement message alongside the draft id, so a "change the last line and
   send it" turn could be one call instead of update-then-send. Not required;
   note it and decide when the tool descriptions are written.
4. **Docs + changelog.**

## Tests

- `google/rest.test.ts`: request shape per call (method, path, JSON body);
  name→id resolution including a system label, a nested user label and a
  case-mismatched one; the unknown-label error naming the existing labels; the
  label cache issuing one `labels.list` for two modifies; a draft's `raw`
  decoding to the same MIME message `send` produces, including the reply
  headers; the refusal of `SENT`/`DRAFT` before any request leaves the adapter;
  `drafts.list` issuing one metadata `get` per draft and stopping at the cap;
  `401`/`404` paths.
- `tools/google.test.ts`: each tool's returned shape over the memory adapter;
  `GoogleNotConnectedError` surfacing as `{ error }` for the six reversible
  tools; `gmail_send_draft` instead throwing `ExternalCallNotSent` on a provable
  rejection and propagating an ambiguous `5xx`.
- `agents/interface.test.ts`: one scripted run that reads a thread, drafts a
  reply, then archives the thread — the behaviour a user actually asks for.
- Onboarding must not gain these. Follow the existing style in
  `agents/onboarding.test.ts`, which proves absence by effect (it scripts a
  `gmail_send` call and asserts `sentMail` stayed empty): script a
  `gmail_modify_thread` call and assert the memory adapter recorded no
  modification.

## Docs and changelog

- `docs/google-tools.md`: add the seven tools, the label-name contract, the
  reversible-vs-irreversible split, and delete the stale "Phase-2 (not built):
  `gmail_modify_labels`" line.
- `docs/google-workspace.md`: the `gmail.modify` row can finally say "modify
  labels" without it being aspirational; add a line that permanent delete
  (`mail.google.com`) and settings (`gmail.settings.*`) are deliberately not
  requested.
- `apps/agent-api/CHANGELOG.md`: one entry, user-facing, e.g. "Ask Zero to
  archive a thread, file it under a label, mark it read, star it, move it to
  trash, or write a draft you can look at before it goes out."

## Non-goals, with reasons

- **Permanent delete** (`messages.delete`, `batchDelete`, `threads.delete`).
  Needs `https://mail.google.com/`, the widest Gmail scope there is, to gain a
  capability whose only difference from trash is that mistakes are
  unrecoverable. An assistant should not hold it.
- **Settings** (vacation responder, filters, forwarding, IMAP/POP). Separate
  `gmail.settings.*` scopes, separate verification, and a rare, high-blast-radius
  set of changes.
- **`history.list`.** In scope and genuinely useful, but not as a tool: it is
  only meaningful with a stored `historyId` per user and something that wakes up
  to compare it. That is the "tell me when X emails you" feature, which belongs
  with schedules (`docs/schedules.md`), not with this batch. Worth doing next;
  it costs no extra scope.
- **Per-message modify, label deletion.** See decisions above.

## Skills to use

- `development-guidelines` — throughout.
- `tdd` — adapter and tools.
- `testing` — memory-adapter fakes.
- `changelog` — the agent changelog entry.
- `git-commit` — when committing.

## Acceptance criteria

- Asking Zero to archive a thread removes it from the inbox and it says so;
  asking to unarchive puts it back.
- "File this under Receipts" applies an existing label, and fails with a message
  naming the real labels when that label does not exist. Creating the label
  first then filing works in the same conversation.
- Mark read/unread and star/unstar work on a thread found by search.
- Trash and restore work; nothing in the tool set can permanently delete mail.
- A drafted reply appears in Gmail as a draft in the right thread, can be
  updated (the update keeps the whole message, not just the changed part), and
  is only sent after the user confirms. After sending, the draft is gone and
  Zero says so rather than offering to send it again.
- Asking to star a sent message, or to label a draft, fails with a sentence
  explaining Gmail does not allow it, without a retry loop.
- `gmail_send_draft` is the only new tool marked `externalWrite`.
- The onboarding agent still has exactly two Gmail tools.
- No change to `GOOGLE_WORKSPACE_SCOPES`, so no user sees "Grant required
  scopes".
- `pnpm --filter @zero/agent-api run test|lint|typecheck` pass.
