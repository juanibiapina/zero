# Plan: Google Drive support

> **Built 2026-08-13, with one change:** `drive_read` was dropped before
> merge. Reading a Drive document is import-then-read (`drive_import` +
> `read_pdf`), so `DRIVE_TEXT_CHARS`, `readText` and the text-export mapping
> below were never shipped. Everything else landed as written.

## Goal

Give the interface agent Drive tools so a user can ask Zero to find a file in
their Drive, read a Google Doc/Sheet/Slide, pull a Drive file into Zero's file
store (so `read_pdf`, `view_image`, `send_file` work on it), push a stored Zero
file back to Drive, organise with folders, and trash/restore.

Drive is the last unwired leg of the Google integration: the `drive` scope is
already requested and granted by the existing "Connect Google" button
(`apps/agent-web/src/google-scopes.ts`), so **no scope change, no new OAuth
verification round**. `docs/google-workspace.md` still says "Drive is still
unwired"; this closes that.

## Background a fresh agent needs

- The Google integration is a single port `GoogleWorkspace`
  (`apps/agent-api/src/google/types.ts`) with two sub-APIs today, `mail` and
  `calendar`. Real adapter: `google/rest.ts` (`createGoogleWorkspace(getToken)`,
  a deep module holding all REST/MIME/base64url detail). Test adapter:
  `google/memory.ts` (`createMemoryGoogle(seed)`, records writes for
  assertions). Tools are built in `tools/google.ts` by `buildGoogleTools({
  google, timezone, files })` and mixed into the interface agent's tool set in
  `agents/interface.ts`. The onboarding agent picks only `gmail_search` /
  `gmail_thread` out of that set; it must keep getting **no** Drive tools.
- Failure policy (already implemented, reuse verbatim): reversible calls go
  through `guard()` and return `{ error }` data; irreversible calls go through
  `writeGuard()` + `externalWrite: true`, which converts only a *provable*
  rejection (`isProvableRejection`, i.e. not 408/429/5xx/socket death) into
  `ExternalCallNotSent` and lets anything ambiguous propagate. See
  `docs/google-tools.md` and `agents/external-call.ts`.
- Token strategy: the adapter takes a token provider, memoized per turn by
  `UserDO`. Nothing to change.
- Zero's own file store is `files/types.ts` (`UserFileStore`), cap
  `MAX_FILE_BYTES` = 20 MB per file, `MAX_USER_FILE_BYTES` = 100 MB per user.
  `gmail_save_attachment` (`tools/google.ts`) is the exact prior art for
  importing an external file: adapter downloads bytes with a size guard, tool
  calls `files.save`, logs `file_imported`, returns metadata + marker, never
  bytes.
- Tools register unconditionally so the tool schema stays byte-identical across
  users and turns (prompt-cache invariant). Drive tools must follow that: no
  conditional registration on "Drive connected".

## Drive API facts that shape the design

Verify each against the Drive v3 discovery document
(`https://www.googleapis.com/discovery/v1/apis/drive/v3/rest`) rather than the
reference pages, the same rule the Calendar scopes work learned.

1. **`files.list` includes trashed items by default.** The reference states it
   outright ("This method returns all files by default, including trashed
   files"). Every query must append `trashed = false` unless the caller asked
   for trash.
2. **`fields` is mandatory in practice.** The default response carries only
   `kind, id, name, mimeType`. Request
   `files(id,name,mimeType,size,modifiedTime,webViewLink,parents,shortcutDetails,capabilities/canDownload)`
   plus `nextPageToken`.
3. **Google-native files have no bytes.** `files.get?alt=media` fails
   `403 fileNotDownloadable` for
   `application/vnd.google-apps.{document,spreadsheet,presentation}`. Those need
   `files/{id}/export?mimeType=...`. **Exported content is limited to 10 MB**
   (documented), and `text/csv` is listed in the export-formats table as
   "Comma Separated Values (**first-sheet only**)" — say so in the tool result
   rather than silently returning a partial workbook. Google Vids cannot be
   exported at all (`403 fileNotExportable`); it needs the long-running
   `files.download`, which is out of scope, so map that error to a plain "Zero
   can't read Google Vids files".
4. **Folders are files** (`application/vnd.google-apps.folder`), parenting is
   the `parents` array, and **shortcuts** (`...apps.shortcut`) point at another
   id via `shortcutDetails.targetId` (+ `targetMimeType`). Both fields come back
   in the **list** response when requested, so resolving a shortcut's id and
   type costs no extra request; only the target's *name* would. Resolve
   shortcuts lazily — in `get`/`readText`/`download`, never by fanning out
   `files.get` per search hit.
5. **Query syntax needs escaping.** Per the search guide, both `'` and `\` in a
   `name contains '...'` / `fullText contains '...'` term must be
   backslash-escaped. The model never writes raw `q`; the adapter builds it.
6. **Uploads use a different host**: `https://www.googleapis.com/upload/drive/v3/files`.
   Google documents `uploadType=media`/`multipart` for files **5 MB or less**
   and `uploadType=resumable` for larger, explicitly calling resumable "a good
   choice for most applications ... at a minimal cost of one additional HTTP
   request". (The 5 MB figure is guidance; the discovery doc's `maxSize` is
   5 TB.) **Decision: resumable**, uniform for 1 KB and 20 MB alike:
   `POST .../upload/drive/v3/files?uploadType=resumable` with the metadata JSON
   body, then a single `PUT` of all bytes to the `Location` header of that
   response. Note the discovery document's `/resumable/upload/drive/v3/files`
   path is *not* the URL you call.
7. **`files.delete` is permanent**; `files.update {trashed:true}` is reversible.
   Mirror the Gmail decision: trash only, no permanent delete.
8. Shared drives need `supportsAllDrives=true` (+ `includeItemsFromAllDrives=true`
   on list) or a user's work files are invisible.
9. **Abusive-file downloads** (malware-flagged) fail unless
   `acknowledgeAbuse=true`. Do **not** set it; let the error surface as data.
   Check `capabilities.canDownload` before attempting bytes so a read-only
   shared file gives a clear message instead of a 403.
10. **Scope check (verified against the discovery document):** every method used
    here — `files.list/get/export/create/update` — accepts
    `https://www.googleapis.com/auth/drive`, so nothing new is needed. Worth
    recording for OAuth verification: `drive.file` covers all of them *except*
    finding the user's pre-existing files, since it only ever sees files the app
    itself created. That is the reason the broad `drive` scope stays.

## What to change

### 1. Port — `google/types.ts`

Add a `DriveApi` and a third sub-API on `GoogleWorkspace`:

```ts
export const DRIVE_SEARCH_CAP = 20;
// Bound on text returned by readText. Matches PDF_MAX_CHARACTERS in
// files/pdf.ts, the existing precedent for text out of a stored document.
export const DRIVE_TEXT_CHARS = 30_000;

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  byteSize: number | null;   // null for Google-native files
  modifiedAt: string;
  webViewLink: string | null;
  isFolder: boolean;
}

export interface DriveSearchParams {
  query?: string;        // matched against name and full text
  mimeType?: string;
  folderId?: string;
  trashed?: boolean;
}

export interface DriveApi {
  search(params: DriveSearchParams): Promise<DriveFile[]>;
  get(fileId: string): Promise<DriveFile>;
  // Text of a Google-native doc or a text/* file, bounded by the adapter.
  readText(fileId: string): Promise<{ file: DriveFile; text: string; truncated: boolean }>;
  // Bytes for the Zero file store: binary via alt=media, native via export.
  download(fileId: string): Promise<{ filename: string; mimeType: string; bytes: Uint8Array }>;
  upload(input: { filename: string; mimeType: string; bytes: Uint8Array; folderId?: string }): Promise<DriveFile>;
  createFolder(input: { name: string; parentId?: string }): Promise<DriveFile>;
  trash(fileId: string, restore?: boolean): Promise<DriveFile>;
}
```

**Ids, not names.** Gmail labels are exposed by name because a model cannot
invent `Label_12`; Drive is the opposite case — names are not unique and a user
has three files called "Invoice", so `fileId` (always obtained from
`drive_search`/`drive_import` output) is the identity the tools speak. Record
that contrast in the docs, it is the question a reader will ask.

### 2. Adapter — `google/rest.ts`

Add a `drive: DriveApi` built from the existing `authFetch`/`getJson` helpers
(reuse them; do not add a second fetch path). Detail that must stay inside:

- `q` construction and escaping, `trashed = false`, `fields`, `pageSize` =
  `DRIVE_SEARCH_CAP`, `supportsAllDrives`/`includeItemsFromAllDrives`, no
  `nextPageToken` following (same bounded-list policy as Gmail/Calendar; the
  tool flags `truncated`).
- Shortcut resolution to the target file.
- Native-vs-binary branching: `download` exports Docs and Slides as
  `application/pdf` (so `read_pdf` works on the result) and Sheets as
  `text/csv`; everything else uses `alt=media`.
- Size guards mirroring `downloadAttachment`: check the metadata `size` before
  fetching bytes, and re-check `bytes.length` after, both against
  `MAX_FILE_BYTES`, with the `MAX_FILE_LABEL` message. Google-native files
  report no `size`, so only the post-check applies there.

  **One file-size cap, no Drive-specific constant.** `MAX_FILE_BYTES` (20 MB,
  `files/types.ts:3`) is already the single cap for every file that enters or
  leaves Zero: Telegram ingest (`routes/telegram-webhook.ts`), Gmail attachments
  (`google/rest.ts:378`), and the store itself (`files/store.ts:114`). Drive
  import and upload use the same constant and the same `MAX_FILE_LABEL`
  wording; do not introduce `DRIVE_MAX_BYTES`. Per-user storage stays at
  `MAX_USER_FILE_BYTES` (100 MB).

  Its comment in `files/types.ts` currently justifies the number by Telegram's
  `getFile` limit ("a larger cap here could never be filled from a Telegram
  attachment"), which stops being the whole story once Drive can supply a 50 MB
  file. Rewrite the comment in this change: 20 MB is Zero's file cap, and
  Telegram is the reason it is not *higher*, not the reason it exists.

  Google's own limits sit under it and are not caps Zero chooses: export of a
  Google-native doc is capped at 10 MB by Google, so a huge Doc fails before
  Zero's 20 MB ever applies. Surface that as its own message rather than the
  too-large one, so the user isn't told to shrink a file they cannot shrink.
- `readText` bound: cut at `DRIVE_TEXT_CHARS` and report `truncated`, so a
  300-page Doc cannot blow the context. There is no paging in v1 (`read_page`
  has no cap to mirror — the only precedents are `PDF_MAX_CHARACTERS = 30_000`
  in `files/pdf.ts` and `DEFAULT_MAX_CONTENT_CHARS = 8000` in
  `pagefetch/tavily.ts`); the truncation message tells the model to
  `drive_import` the doc as PDF and page through it with `read_pdf`, which is
  already paginated.
- Upload encoding.

### 3. Adapter — `google/memory.ts`

Extend the seed with `driveFiles?: DriveFile[]`, `driveText?: Record<string,
string>`, `driveBytes?: Record<string, Uint8Array>`, and record writes:
`uploadedFiles`, `createdFolders`, `trashedFiles`. `notConnected: true` must
throw `GoogleNotConnectedError` from the Drive methods too.

### 4. Tools — `tools/google.ts`

Input keys are **camelCase** (`fileId`, `folderId`, `mimeType`), matching the
Gmail and Calendar tools they sit beside (`threadId`, `messageId`,
`calendarIds`), not the snake_case of `tools/files.ts`.

Reversible, `guard()` + `{ error }` data:

- `drive_search({ query?, mimeType?, folderId? })` → `{ files, truncated }`.
- `drive_read({ fileId })` → text of a Doc/Sheet/Slide or text file, with the
  Sheets first-sheet caveat and a truncation note; points at `drive_import` +
  `read_pdf` for PDFs.
- `drive_import({ fileId })` → `files.save`, log `file_imported` with
  `source: "drive"`, return metadata + marker (copy `gmail_save_attachment`).
  Naturally idempotent: `files.save` deduplicates by content hash
  (`files/store.ts`), so importing the same Drive file twice returns the same
  stored file rather than doubling the user's quota.
- `drive_create_folder({ name, parentId? })`.
- `drive_trash({ fileId, restore? })` — description states Drive trash is
  restorable and that Zero has no permanent delete.

Irreversible, `writeGuard()` + `externalWrite: true`:

- `drive_upload({ fileId, name?, folderId? })` — `fileId` is a **Zero** file
  id. It is an external write whose retry would create a duplicate file in the
  user's Drive, so it takes the same claim treatment as `gmail_send`. Its
  description requires the user to have confirmed the file and destination.
  This is the only tool needing the resumable-upload machinery; if the change
  is getting long, it is the clean cut line for a second PR (everything above
  it ships and is useful on its own).

Deliberately **not** built in v1, say so in the docs: `permissions.create`
(sharing changes who can see data — its own confirmation policy and blast
radius), permanent delete, revisions, comments, moving files between folders
(`addParents`/`removeParents`), and Drive change-watching (`changes.list` has
the same "needs something that stores a token and wakes up" problem as Gmail
`history.list`, and belongs with schedules).

### 5. Wiring

`agents/interface.ts` already passes `google` and `files` into
`buildGoogleTools`; the new tools appear automatically. Confirm
`agents/onboarding.ts` still destructures only `gmail_search`/`gmail_thread`.

## Alternatives considered

- **Multipart vs resumable upload.** Multipart is one request, but Google
  documents it for files 5 MB or less, under Zero's own 20 MB file cap — a user
  who imported a 12 MB PDF from Telegram would be in undocumented territory.
  **Chosen: resumable** (POST session start, single PUT of all bytes, which are
  already in memory), uniform for every size at the cost of one extra round
  trip; Google itself recommends it for most applications.
- **Export Docs as `text/plain` for import instead of PDF.** Plain text loses
  layout and cannot be viewed or forwarded; PDF keeps the document and
  `read_pdf` already extracts its text. `drive_read` covers the "just tell me
  what it says" path, so both needs are served.
- **A separate `GoogleDrive` port.** Rejected: the token provider, error types,
  `authFetch`, caps convention and tool-building are all shared, and the DO
  already constructs one workspace object. A third sub-API costs nothing.
- **Name-addressed tools (like Gmail labels).** Rejected: Drive names are not
  unique, so name addressing would make "delete the invoice" ambiguous in a way
  the model cannot see.

## System-wide impact

- No scope change, no OAuth verification round, no frontend change.
- Tool-schema growth: ~6 new tools on the interface agent. The schema is part of
  the cached prompt prefix, so it costs cached tokens on every turn — one reason
  to keep the v1 list to these six and resist sharing/moving/revisions.
- `file_imported` gains a `source: "drive"` value; nothing consumes it beyond
  logs.
- Drive imports count against the user's 100 MB file quota; `FileQuotaExceeded`
  already surfaces as an error string.
- Data deletion (`docs/data-deletion.md`) is unaffected: Zero stores no Drive
  ids, only imported bytes as ordinary user files, which deletion already
  covers.

## Test strategy

- `google/rest.test.ts` (mock `fetch`): `q` construction incl. `trashed = false`
  and quote escaping; `fields`/`pageSize`/shared-drive params; shortcut
  resolution; binary download via `alt=media` vs native export (PDF for Docs,
  CSV for Sheets); oversize rejection before and after byte fetch; `readText`
  truncation; upload request shape (session start + PUT, or multipart);
  `createFolder` parents; trash/restore; 401 and null-token paths.
- `tools/google.test.ts` (memory adapter): each tool's output shape;
  `truncated` flag at the cap; `drive_import` saves to the file store and
  returns a marker, not bytes; `GoogleNotConnectedError` surfaces as `{ error }`
  for the reversible tools and as `ExternalCallNotSent` for `drive_upload`;
  a 500 from upload propagates unclassified.
- `agents/interface.test.ts`: one scripted run that searches Drive, imports a
  PDF, and reads it — proving the Drive → file store → `read_pdf` chain.
- `agents/onboarding.test.ts`: assert the onboarding tool set has no `drive_*`
  key (guards the "read-only Gmail only" promise). `onboarding.ts` calls
  `buildGoogleTools({ google, timezone: "UTC" })` with **no** `files`, so
  `drive_import` must degrade to an error rather than throw when the store is
  absent — same as today's `gmail_save_attachment`.
- Size-cap tests assert the shared `MAX_FILE_BYTES`, not a Drive-local number:
  an oversize binary rejected on metadata `size`, an oversize native export
  rejected after the bytes arrive, and Google's own 10 MB export failure
  surfacing as its own message.
- One test for the PDF-signature interaction: `files.save` rejects
  non-PDF bytes claiming `application/pdf` (`hasPdfSignature`), so a Doc
  exported as PDF must save cleanly, and a bogus export must surface as
  `{ error }`, not a crash.

Run `pnpm --filter @zero/agent-api run test lint typecheck`; the whole-repo
`bin/ci` cannot run on this box (`workerd`).

## Documentation

- `docs/google-tools.md`: retitle to cover Drive, add a Drive section (tool
  list, id-vs-name contrast with Gmail labels, native-vs-binary export table,
  caps, what is deliberately absent and why).
- `docs/google-workspace.md`: drop "Drive is still unwired", note the `drive`
  scope is now actually exercised (it is restricted: verification + annual CASA,
  which was already accepted).
- `apps/agent-api/CHANGELOG.md`: one user-facing bullet, e.g.
  `- YYYY-MM-DD: Zero can now find, read, and save files from your Google Drive,
  and put files back into it.` (Load the `changelog` skill first.)

## Skills to use

- `development-guidelines` — governing skill for the whole change.
- `tdd` — every adapter and tool behavior, RED first.
- `codebase-design` — keeping the adapter deep and the port flat when adding a
  third sub-API.
- `typescript-strict` — the new port types and zod schemas.
- `testing` — test shape and factories for the memory seed.
- `changelog` — before touching `apps/agent-api/CHANGELOG.md`.
- `git-commit`, `open-pr` — at the end.

## Acceptance criteria

1. A user can ask Zero to find a Drive file by name or content and gets back
   names, types, and modified dates, with truncation flagged at the cap.
2. Asking "what does that doc say" returns the Doc's text without leaving Drive;
   a Sheet says it read the first sheet only.
3. Asking to save a Drive PDF into Zero produces a stored file that `read_pdf`
   and `send_file` accept.
4. Asking to put a stored file in Drive uploads it to the named folder after
   explicit confirmation, and a failed upload never silently duplicates.
5. A user who has not connected Google gets the "connect it in the Zero app"
   message from any Drive tool, and the turn completes.
6. Trash and restore work; no tool can permanently delete a Drive file.
7. Onboarding still has only the two read-only Gmail tools.
8. Docs and changelog updated in the same commit.

## Risks

- **Blast radius of the `drive` scope.** Full read/write over everything the
  user owns, mediated only by tool descriptions. Mitigation: no sharing tool, no
  permanent delete, no move; the only irreversible tool is upload, which creates
  rather than destroys.
- **Context cost** of six more tool schemas on every cached turn.
- **Export surprises**: 10 MB export cap, first-sheet-only CSV, and Docs with
  images becoming PDFs whose text layer is partial (`read_pdf` already warns it
  is text-only).
- **Shared-drive permissions**: a file visible in search may be read-only;
  upload/trash then fail with 403, which `isProvableRejection` correctly treats
  as "provably did nothing" (403 is in `REJECTED_STATUSES`,
  `agents/external-call.ts:30`).
- **Memory**: a 20 MB download lands as one `Uint8Array` in a Worker with a
  128 MB heap, and the resumable PUT holds it again. The Gmail attachment path
  already does the same, so this is not new, but do not add a base64 copy on the
  upload side.
