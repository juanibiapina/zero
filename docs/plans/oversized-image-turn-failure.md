# Fix: a large image kills every turn in a thread, silently

## Background: the incident

2026-08-12 16:59–17:02 UTC, chat `-1004397608762`, topic 133, user
`user_3Ea4tsHDgKswP3GgO0ITkoJmrKp`. The user sent a **6.3 MB image**
(`file_imported ... byte_count: 6310518`). Seven turns ran, all failed, and the
user got **no reply and no fallback** for any of them.

Evidence trail (Workers Logs, plus ZeroErrors issue
`17ad6885-3c39-49c6-9762-654be3ebcab5`, project `zero-agent`):

1. The agent called `view_image`. `apps/agent-api/src/tools/files.ts` reads the
   whole blob and returns `toBase64(bytes)`: 6.3 MB becomes an ~8.4 MB base64
   string in the tool result.
2. `persistToolResults` (`apps/agent-api/src/agents/orchestrator.ts:234`) writes
   that tool result into the DO SQLite conversation row. SQLite refuses it:
   `string or blob too big: SQLITE_TOOBIG` at `DbStore.storeMessage`
   (`apps/agent-api/src/store/db.ts:349`). This is the reported issue.
3. The failure path then died with `Durable Object's isolate exceeded its memory
   limit and was reset` (`apps/agent-api/src/do/alarm.ts:84`), so no fallback
   message was ever sent.
4. The alarm retried; every retry re-read the same file (`file_read` x7, always
   `byte_count: 6310518`) and died the same way.
5. Every one of those OOM resets was **not reported**: they carry
   `durableObjectReset === true`, so `isDurableObjectReset`
   (`apps/agent-api/src/do/retry.ts:36`) classified them as deploy noise and
   logged `error_report_skipped` (7x). Only the first SQLITE_TOOBIG became an
   issue; the user-visible outcome (seven dead turns) was invisible.

So there are four distinct defects: an unbounded image payload, image bytes
persisted into the conversation at all, an error classifier that hides real
resets, and no give-up path that tells the user anything.

## Goal

A large image never kills a turn. If Zero cannot look at an image, it says so.
If a turn dies repeatedly anyway, the user hears about it and the failure lands
in ZeroErrors.

## Guiding rule

**History must replay exactly what the provider saw.** A tool result is stored
verbatim and re-sent verbatim; stubbing, stripping or truncating it after the
fact would make the conversation a lie. Therefore every bound is enforced at the
**tool boundary**, before the model sees the payload. Whatever the model sees is
storable by construction. This is how `read_pdf` already behaves: it truncates at
`PDF_MAX_CHARACTERS = 30_000` (`apps/agent-api/src/files/pdf.ts:4`) inside the
tool, so the model and the row hold the same text.

## Phase 1: no tool result can ever exceed the row limit

The DO SQLite limit is exact and documented: **maximum string, BLOB or table row
size is 2 MB** (Cloudflare Durable Objects limits page). An ~8.4 MB base64 image
can never be stored, and neither can any other oversized tool result — this is
not an image-only failure mode. `read_page`
(`apps/agent-api/src/tools/read-page.ts:28`) returns the fetched page content
with **no cap at all**, unlike `read_pdf` which caps at `PDF_MAX_CHARACTERS =
30_000` (`apps/agent-api/src/files/pdf.ts:4`), so a single large page reproduces
the same dead thread with no image involved. Phase 1 therefore has two parts.

**1a. `view_image` auto-resizes.** The tool returns a *viewing copy*, never the
original bytes: it resizes anything above a budget down to a model-sized image,
and that resized image is both what the model sees and what the row stores.
Nothing downstream changes; history stays faithful.

- Resize with the Cloudflare **Images binding**: add
  `"images": { "binding": "IMAGES" }` to `apps/agent-api/wrangler.jsonc`.
  `.input(stream)` accepts up to **20 MB**, which is exactly Zero's existing
  `MAX_FILE_BYTES` (`apps/agent-api/src/files/types.ts:5`), so every storable
  file is transformable. Billing is per *unique* transformation (source +
  params), once per calendar month; `.info()` is free.
- Wrap it in a port, mirroring `WebSearch` and `PageFetcher`: an `ImageResizer`
  interface plus a Cloudflare adapter, so the tool is unit-testable with a fake
  and the DO never depends on the binding directly. `workerd` does not run on
  the dev box, so a fake is the only way to test this at all.
- Target the model's own image ceiling: long edge **1568 px**, re-encoded as
  JPEG (~quality 80). That lands well under a few hundred KB, which keeps the
  base64 under the 2 MB row limit with room to spare and cuts image tokens.
- Skip the transform when the file is already small (propose: under 1 MB and
  a supported format), so the common Telegram photo path is untouched and
  unbilled.
- Failure path: if the resize fails or the result is still over budget, return
  the existing `ViewOutput` error shape naming the size, so the agent can tell
  the user. An error result is small and storable.
- `files.read` currently returns a `Uint8Array`. The binding wants a
  `ReadableStream`; either wrap the array or add a streaming read to the blob
  store, whichever keeps `apps/agent-api/src/files/store.ts` simpler.
- Replace `toBase64`'s per-byte string concatenation (`tools/files.ts:34`) with
  chunked conversion. Even a resized image should not be built one character at
  a time.

**1b. `read_page` is already capped — nothing to do.** The cap lives in the
adapter, not the tool: `DEFAULT_MAX_CONTENT_CHARS = 8000` with a `…[truncated]`
marker (`apps/agent-api/src/pagefetch/tavily.ts:18,82`), which is why the port's
contract says content arrives "hard-capped". Verified 2026-08-13.

**1c. Guard, do not rewrite.** Keep the persist path faithful. Optionally have
it *report* a tool result that would exceed the row limit (ZeroErrors) instead
of silently altering it, so a future unbounded tool surfaces as an issue rather
than a dead thread.

## Phase 2: what stays unchanged

Stated so it is not re-litigated during implementation:

- Storage and `send_file` are untouched. The original file is still saved at
  full size (cap stays `MAX_FILE_BYTES` = 20 MB) and is still sent back to the
  user byte-for-byte. Only the *viewing copy* handed to the model is resized.
- The persisted conversation keeps the exact image the provider received, and
  every replay re-sends it. No stubbing, no stripping, no rehydration.

## Phase 3: stop classifying real resets as deploy noise

`isDurableObjectReset` currently ORs the `durableObjectReset` property with the
code-update message. The 2026-08-12 logs are the first observed case of that
property arriving for a reset that is **not** a deploy (memory limit), and the
property branch is what suppressed reporting.

Split the two questions, which are not the same question:

- **Should the orchestrator defer the fallback?** Yes for any reset: the alarm
  re-runs the turn. `apps/agent-api/src/agents/orchestrator.ts:280` keeps the
  current broad predicate.
- **Should the reporter stay silent?** Only for a deploy reset. In
  `apps/agent-api/src/reporting/zero-errors.ts:50`, key on a narrower predicate
  (deploy reset = the code-update message) so a memory-limit reset reports at
  `error` with its existing site.

Update the comment block in `apps/agent-api/src/do/retry.ts` with the new
evidence (the property is not deploy-specific) and update
`docs/error-reporting.md`, which currently states flatly that DO resets are
never reported.

## Phase 4: a poison turn must not fail silently forever

An OOM tears down the isolate before any `catch`, so the alarm's attempt counter
in `apps/agent-api/src/do/alarm.ts` (written in the catch) never grows for this
class of failure and the thread can retry indefinitely with no user-visible
output.

- Persist a per-thread attempt counter **before** running the turn, and clear it
  on successful completion. Only a pre-write survives an isolate kill.
- When it exceeds a small bound (propose 3), skip the turn: drain that thread's
  queue, send one plain message ("I could not process the last message"), and
  report to ZeroErrors under a new site (e.g. `turn_poisoned`, level `error`) so
  the give-up is visible. Add the site to the table in `docs/error-reporting.md`.
- Keep it in the alarm/orchestrator seam so it is testable without a real DO,
  like `runAlarmTurns` already is.

## Tests

Behavior-first, at the layer of each claim (`vitest`, per package):

- `apps/agent-api/src/tools/files.test.ts` with a fake `ImageResizer`: a file
  over the budget is passed to the resizer and the returned image block carries
  the **resized** bytes; a small file skips the resizer entirely (existing test
  stays green); a resizer failure returns the error shape naming the size.
- `apps/agent-api/src/tools/read-page.test.ts`: an oversized page is cut at the
  cap and the result says so.
- Regression at the orchestrator level: a turn whose tool result contains a
  large image completes, and the stored row is byte-identical to the content
  sent to the provider and below the SQLite row limit.
- `apps/agent-api/src/reporting/zero-errors.test.ts`: an error with
  `durableObjectReset: true` and the memory-limit message **is** reported; the
  code-update message is still skipped.
- `apps/agent-api/src/do/alarm.test.ts`: after N pre-counted attempts the turn is
  skipped, the queue is drained, the notice is sent, and the report fires.

## Docs and changelog

- `docs/error-reporting.md`: the reset carve-out is deploy-only now; add
  `turn_poisoned`.
- `apps/agent-api/CHANGELOG.md` (agent product, per AGENTS.md), most recent
  first, user-facing wording: Zero can now look at large photos instead of going
  quiet, and a message it cannot handle gets an answer instead of silence.

## Skills to use

- `tdd` — every phase changes observable behavior; write the failing test first.
- `testing` — test-shape and factory patterns for the store/tool tests.
- `typescript-strict` — new predicates and content-stub types.
- `investigate` — only if a phase does not reproduce as described here.
- `git-commit` — one commit per phase, after approval.

## Acceptance criteria

- Sending a 6.3 MB image produces a normal answer about the image. No turn fails.
- The stored tool result is exactly what the provider received, and a later turn
  replays it unchanged.
- A memory-limit DO reset appears as a ZeroErrors issue in `zero-agent`.
- A turn that fails three times in a row ends with a user-visible notice and a
  reported issue, not silence.
- `pnpm --filter @zero/agent-api run test`, `... lint`, `... typecheck` pass
  (whole-repo `bin/ci` cannot run on this NixOS box; see AGENTS.md).

## Risks

- The Images binding is a new runtime dependency in the agent Worker, billed per
  unique transformation. Confirm it is enabled on the account before relying on
  it, and keep the small-file skip so ordinary photos never touch it.
- `workerd` cannot run on the dev box, so the adapter itself is only proven in
  production; keep all logic behind the port so the tool is fully tested with a
  fake.
- The 1 MB resize threshold and 1568 px target are starting points.
  `file_imported.byte_count` in Workers Logs is the data that should move them.
- Phase 4 touches the alarm loop, the component most likely to cause a paid
  retry storm. Keep its circuit-breaker guard intact and test it in isolation.
