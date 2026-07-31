# User file storage and Gmail imports

## Goal

Replace the conversation-owned attachment implementation with generic,
user-owned file storage.

A file may arrive through Telegram or as a Gmail attachment. Once saved, it is
not owned by that message, conversation, topic, or provider. It remains
available to every conversation for the user and can be referenced from topic
bodies with a stable marker.

Format-specific capabilities remain separate operations over stored files:

- `read_pdf` extracts bounded, page-labelled text from PDFs.
- `view_image` returns native image content to the model.
- `send_file` sends any stored file to the active Telegram topic.

This change does not retain or expose a mapping back to the original Gmail or
Telegram source.

## Technical approach

Create a deep `UserFileStore` module under `apps/agent-api/src/files/`. It owns
the consistency rules between R2 bytes and UserDO SQLite metadata. Callers save,
read, list, and delete files through this interface rather than coordinating the
two stores themselves.

Gmail and Telegram remain source adapters. PDF extraction and image viewing
remain specialized consumers. Topics and conversations hold stable references
only.

### Stored file model

```ts
interface StoredFile {
  id: string;
  storageKey: string;
  filename: string;
  mimeType: string;
  byteSize: number | null;
  createdAt: string;
}
```

Rules:

- There is no `conversationId`, provider, source locator, or format `kind`.
- User ownership is implicit in the per-user Durable Object and explicit in the
  R2 key prefix.
- `mimeType` determines which specialized operations apply.
- `byteSize` is nullable only for records migrated from the current attachment
  table. New files always have a size.
- Existing `att_*` IDs remain valid. New files use `file_*` IDs.

Use one marker for new files:

```text
[file id=file_123 name="report.pdf" mime="application/pdf"]
```

Keep old `[image ...]` and `[pdf ...]` markers readable indefinitely. Stored
conversation and topic text does not need a rewrite.

## 1. Build the user file store

Create `apps/agent-api/src/files/` with a small external interface:

```ts
interface UserFileStore {
  save(input: {
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<StoredFile>;

  get(id: string): StoredFile | null;
  read(id: string): Promise<Uint8Array | null>;
  list(input: FileListInput): FilePage;
  delete(id: string): Promise<boolean>;
  deleteAll(): Promise<void>;
}
```

The implementation coordinates:

- file metadata in UserDO SQLite;
- file bytes in R2;
- safe filename normalization;
- MIME normalization;
- per-file and per-user limits;
- deterministic replay;
- old and new R2 key layouts;
- content-specific validation before persistence.

Keep the R2 adapter as an internal seam with production and memory adapters. It
needs `put`, `get`, `head`, `delete`, and prefix deletion. Callers outside the
file module must not construct R2 keys.

### Stable identity and replay

Compute new file IDs from a hash of the normalized filename, normalized MIME
type, and bytes. This gives an import a deterministic identity without retaining
provider locators. Replaying the same Telegram update or Gmail import resolves
the existing file instead of creating another record.

Use a user-prefixed key such as:

```text
files/{clerkUserId}/{fileId}
```

Save in this order:

1. Normalize and validate metadata and bytes.
2. If the metadata row and object already exist, return the existing file.
3. Put bytes in R2.
4. Upsert the metadata row.

A reset may leave an unreferenced R2 object, but it cannot leave a metadata row
pointing at absent bytes. If a row exists while its object is missing, a replay
repairs the object before returning.

### Limits

Keep the current 5 MB per-file limit because Gmail returns base64url JSON and
Telegram delivery may hold another multipart copy in Worker memory.

Add a 100 MB per-user stored-file limit. Before saving, sum metadata sizes. For
legacy rows with unknown size, lazily call R2 `head` and backfill `byteSize`
before enforcing the quota. Log only counts and byte totals, never names,
content, provider IDs, or file IDs when they are not needed for operational
correlation.

Define the limits next to the file-store policy so Telegram and Gmail cannot
diverge.

## 2. Migrate attachment metadata

Add the next UserDO SQLite migration:

1. Create `files` without a conversation foreign key.
2. Copy every existing `attachments` row into it.
3. Map `r2Key` to `storageKey` and set `byteSize` to `NULL`.
4. Drop `attachments`.

Update the database and memory store interfaces from attachment methods to file
methods. File rows must not be deleted by conversation reset.

Existing R2 objects under `attachments/{clerkUserId}/...` remain valid because
each migrated row retains its exact key. New objects use the `files/` prefix.
Bulk user deletion must cover both prefixes until all legacy objects are gone.

Rename the Worker binding from `ATTACHMENTS` to `FILES` while pointing it at the
existing `zero-attachments` bucket. The bucket itself does not need a data copy
or rename. Update generated environment types and wiring accordingly.

## 3. Correct ownership and lifecycle

Files belong to the Zero user:

- `/new` removes a conversation but no files.
- Topic deletion removes references but no files.
- Telegram unlink disconnects Telegram but no files.
- Google disconnect does not affect files already imported from Gmail.
- `delete_file` removes one metadata row and its R2 object.
- A full account-data purge uses `deleteAll` for metadata and both R2 prefixes.

Remove the current file purge from `UserDO.unlinkTelegram`. Telegram is one
interface to the account, not the owner of the files.

Do not add reference counting. A file may be referenced from several topics and
conversations, and topic text is not an ownership graph.

## 4. Make Telegram a file-ingestion adapter

Refactor the Telegram webhook and UserDO enqueue path so file persistence goes
through `UserFileStore`.

The webhook should continue to:

- resolve Telegram's downloadable file ID;
- select the preferred photo variant;
- download bytes;
- reject a declared oversize file as early as possible;
- pass canonical filename, MIME type, and bytes to the UserDO.

The UserDO should save the file before queueing the user message, append the
canonical `[file ...]` marker, and then enqueue the message. Keep this in one DO
RPC so metadata persistence and message construction are not duplicated in the
route.

Accept every downloadable Telegram file under the size limit, including
photos, documents, audio, video, voice messages, animations, video notes, and
stickers. The file can be stored and sent even when Zero cannot interpret its
content.

Retain content checks where they protect a specialized capability:

- a claimed PDF must have a PDF signature before being marked
  `application/pdf`;
- image MIME types must be supported by Anthropic before `view_image` returns an
  image block.

Replace the current unsupported-attachment notice with an honest distinction:
Zero saved the file but may not have a reader for that format.

## 5. Expose Gmail attachment metadata

Extend the normalized Gmail message shape in
`apps/agent-api/src/google/types.ts`:

```ts
interface MailAttachmentSummary {
  partId: string;
  filename: string;
  mimeType: string;
  byteSize: number;
}
```

Each `MailMessage` returns its named attachment summaries. Add this operation to
the Google Workspace mail interface:

```ts
downloadAttachment(messageId: string, partId: string): Promise<{
  filename: string;
  mimeType: string;
  declaredSize: number;
  bytes: Uint8Array;
}>;
```

Update the REST adapter to:

- walk nested MIME parts recursively;
- include named files under `multipart/mixed`, `multipart/related`, and nested
  alternatives;
- use Gmail message ID plus MIME part ID as the download reference;
- re-fetch the message and resolve canonical part metadata instead of trusting
  a model-supplied filename;
- decode inline `body.data` when present;
- otherwise fetch `messages/{messageId}/attachments/{attachmentId}`;
- reject a declared size above 5 MB before downloading where possible;
- verify the decoded byte length after downloading;
- reject missing, changed, or malformed parts clearly.

Gmail message and part IDs are transient tool inputs. Do not store them with the
saved file, place them in markers, or log them.

Update the memory Google adapter with seeded MIME parts and downloadable bytes.

## 6. Add `gmail_save_attachment`

Add this interface-agent tool:

```ts
gmail_save_attachment({
  messageId: string,
  partId: string,
})
```

Behavior:

1. Resolve and download the canonical MIME part through `GoogleWorkspace`.
2. Save it through `UserFileStore`.
3. Return the canonical file marker and metadata.
4. Never return bytes or base64 to the model.

The tool result should resemble:

```json
{
  "file": {
    "id": "file_123",
    "filename": "report.pdf",
    "mimeType": "application/pdf",
    "byteSize": 48231,
    "marker": "[file id=file_123 name=\"report.pdf\" mime=\"application/pdf\"]"
  }
}
```

This is an idempotent write to Zero-owned storage, not an irreversible external
write. Do not mark it `externalWrite`.

Register the tool unconditionally for prompt-cache stability. Return a normal
error if file storage is unwired. Update `gmail_thread`'s description so the
model copies `messageId` and `partId` from its result rather than guessing.

Expose `gmail_save_attachment` only to the interface agent. The onboarding agent
keeps `gmail_search` and `gmail_thread` but cannot import files.

## 7. Keep specialized file capabilities

### PDFs

Keep `read_pdf` and `readPdfText` as PDF-specific modules. Preserve:

- one-indexed page ranges;
- the 20-page limit;
- the character limit;
- page-labelled output;
- malformed, encrypted, scanned, and image-only errors;
- content-free PDF observability.

Change only their dependency from attachment lookup/storage to
`UserFileStore`. A PDF imported from Gmail or Telegram behaves identically.

### Images

Rename the image-only `view_attachment` capability to `view_image`:

```ts
view_image({ id: string })
```

It must reject non-image MIME types before creating an Anthropic image block.
Keep `view_attachment` as a compatibility alias while old persisted tool calls
may still reference it. New prompts and tool descriptions should use
`view_image`.

Do not replace these tools with a generic `read_file` carrying PDF-only page
arguments. Generic storage and specialized operations provide a smaller,
clearer interface.

## 8. Add generic file tools

### `get_file`

```ts
get_file({ id: string })
```

Return metadata and the canonical marker, but never bytes. This lets an agent
resolve a topic reference before selecting a specialized capability.

### `list_files`

```ts
list_files({
  query?: string,
  mime_type?: string,
  limit?: number,
  cursor?: string
})
```

Return a bounded, newest-first page of metadata and canonical markers. Search
matches safe filenames; MIME filtering supports an exact MIME type or a major
prefix such as `image/*`. Keep pagination stable and cap each page.

### `send_file`

```ts
send_file({ id: string })
```

Resolve any stored file, fetch its bytes, and send the original filename and
MIME type to the active Telegram topic through grammY `sendDocument`.

Mark it `externalWrite` so the existing durable claim prevents a reset from
knowingly sending the same file twice. Classify definite Telegram 4xx
rejections as `ExternalCallNotSent`; leave network errors, timeouts, throttles,
and server failures uncertain.

Sending requires an explicit user request. Saving or reading does not.

### `delete_file`

```ts
delete_file({ id: string })
```

Delete metadata and R2 bytes. This is irreversible and requires explicit user
confirmation naming the file. Its description must warn that topic and
conversation markers are references and become unresolved after deletion.

Deletion is an owned-state operation rather than an external provider call. It
should be idempotent and report whether the file existed.

## 9. Support topic references

Topics may contain canonical file markers in their bodies. The file remains
independent of the topic.

Update interface, learning, and topic-writing instructions:

- preserve file markers byte-for-byte;
- never invent, shorten, or rewrite a file ID;
- store a marker in a topic when the file is durable knowledge relevant to that
  topic;
- do not copy file content into a topic merely to preserve access;
- resolve a marker through `get_file`, then use `read_pdf`, `view_image`, or
  `send_file` as needed;
- deleting or replacing topic text does not delete the file.

Compaction and learning already preserve ordinary topic text, so file references
need no separate join table or reference-counting system.

## 10. Observability

Add content-free events for:

- file saved, deduplicated, repaired, listed, read, sent, and deleted;
- save source adapter (`telegram` or `gmail`) only at operation time;
- byte count, MIME major type, duration, and quota totals;
- failures classified by size, quota, missing object, invalid PDF, provider
  rejection, or ambiguous delivery.

Do not log filenames, file content, Gmail IDs, Telegram file IDs, markers, topic
bodies, or model-visible extracted text.

Keep the existing PDF extraction events, renamed only where attachment-specific
field names no longer fit.

## 11. Tests

### File-store contract

Run the same contract against memory and R2 blob adapters where practical:

- save/read round trip;
- deterministic deduplication;
- same bytes with changed filename or MIME identity behavior;
- R2-first persistence order;
- replay after a reset between object and metadata writes;
- repair of metadata with a missing object;
- safe filenames and MIME normalization;
- per-file and total quota enforcement;
- lazy size backfill for migrated rows;
- list pagination and filtering;
- idempotent deletion;
- bulk deletion across legacy and new prefixes;
- strict isolation between users.

### Migration and lifecycle

- existing attachment rows become files with unchanged IDs and object keys;
- legacy markers continue resolving;
- conversation reset leaves files intact;
- topic deletion leaves files intact;
- Telegram unlink leaves files intact;
- explicit file deletion removes metadata and bytes.

### Telegram ingestion and delivery

- every downloadable Telegram file category under 5 MB is saved with a generic
  marker;
- oversize and failed downloads do not enqueue a broken marker;
- PDF signature checks and image handling remain correct;
- duplicate webhook delivery does not duplicate the file or queued message;
- `send_file` uses the active Telegram topic and original safe filename;
- completed external-call claims prevent duplicate delivery;
- definite and uncertain Telegram failures are classified correctly.

Extend the mock Telegram server to parse and capture multipart `sendDocument`
requests.

### Gmail adapter and tool

- recursive MIME attachment discovery;
- several attachments with duplicate filenames and distinct part IDs;
- inline and attachment-endpoint bytes;
- non-ASCII filenames;
- missing or changed parts;
- malformed base64url;
- pre-download and post-download size checks;
- Google auth and provider errors;
- `gmail_save_attachment` returns metadata and a marker without bytes;
- repeated imports resolve the same stored file;
- onboarding receives no import tool.

### Specialized capabilities and references

- Gmail and Telegram PDFs both work through `read_pdf`;
- Gmail and Telegram images both work through `view_image`;
- image viewing rejects PDFs and generic binary files;
- generic binary files remain listable and sendable;
- a marker copied into a topic resolves from another conversation;
- learner/writer tests preserve markers exactly;
- tool results, durable messages, and logs never contain file bytes or base64.

### End-to-end coverage

Add a Worker E2E flow that:

1. Finds a Gmail thread with an attached PDF.
2. Saves the attachment.
3. Reads part of it with `read_pdf`.
4. Stores its marker in a topic.
5. Starts or uses another conversation.
6. Resolves the topic marker and sends the original file to Telegram.

The local NixOS host cannot run this `workerd`-backed suite. Run it on a
`workerd`-capable machine; the package E2E script is not currently wired into
GitHub Actions.

## 12. Documentation and changelog

Update:

- `docs/design.md` with user-level file ownership, R2/SQLite coordination,
  markers, topic references, limits, and lifecycle.
- `docs/google-tools.md` with Gmail attachment summaries and
  `gmail_save_attachment`.
- Telegram attachment documentation and notices to distinguish storage from
  format interpretation.
- `apps/agent-api/CHANGELOG.md` with a current user-facing entry: Zero saves
  files for the user across conversations, can import Gmail attachments, keeps
  PDF/image capabilities, and can send requested files in Telegram.

This is an Agent product change, so the entry belongs only in
`apps/agent-api/CHANGELOG.md`.

## Implementation phases

1. Add the `files` schema migration and user-level metadata store.
2. Build and contract-test `UserFileStore` over SQLite and R2.
3. Migrate existing PDF/image tools and legacy markers to file lookup.
4. Move Telegram ingestion to the file store and accept generic files.
5. Add Gmail attachment discovery and `gmail_save_attachment`.
6. Add `get_file`, `list_files`, `send_file`, and `delete_file`.
7. Update topic/learning behavior, documentation, changelog, and E2E fixtures.

Keep each phase compatible with migrated records. Do not remove legacy marker or
tool support in the same release.

## Verification

Run the checks supported on this machine:

```bash
pnpm --filter @zero/agent-api run test
pnpm --filter @zero/agent-api run lint
pnpm --filter @zero/agent-api run typecheck
```

Whole-repo CI and deploy dry-run cannot run locally because `workerd` cannot
start on this NixOS host. GitHub Actions must cover build and deploy dry-run.
Run `bin/e2e-test` separately on a `workerd`-capable machine.

## Alternatives rejected

### Conversation-owned attachments

This prevents cross-conversation and topic use and makes `/new` destroy files
that belong to the user.

### Provider-specific file records

Gmail and Telegram describe how bytes arrived, not what the saved resource is.
Provider fields in the core model would spread ingestion concerns into every
reader and file tool.

### Stored source locators

The feature does not need navigation back to Gmail or Telegram. Keeping provider
IDs would add schema, privacy surface, and lifecycle questions without serving
the required file operations.

### One generic reader tool

PDF page ranges and image content blocks have different interfaces. Keeping
specialized capability tools hides format complexity without polluting the file
model.

### File bytes in tool results or SQLite

Base64 would inflate model context and durable storage. Bytes belong in R2 and
transit only.

## Skills to use

- `deep-modules` when shaping `UserFileStore` and its internal R2 seam.
- `tdd` for the schema migration, file-store contract, Gmail MIME traversal,
  and replay behavior.
- `testing` for adapter contracts, failure classification, and E2E design.
- `cloudflare` for Durable Object migration, R2, RPC payload, memory, and bundle
  constraints.
- `changelog` before editing `apps/agent-api/CHANGELOG.md`.
- `git-commit` after all supported checks pass.

## Acceptance criteria

- Files are owned by the user and remain accessible across conversations and
  topics.
- Topics can hold stable file markers that resolve in later conversations.
- Telegram and Gmail save into the same generic file store.
- New storage and metadata contain no provider-specific source mapping.
- PDFs retain `read_pdf`; images retain a specialized image-viewing capability.
- Any stored MIME type can be listed, retrieved as metadata, sent to Telegram,
  and explicitly deleted.
- `/new`, topic deletion, Telegram unlink, and Google disconnect do not delete
  files.
- Existing attachment rows, R2 objects, IDs, markers, and persisted tool calls
  continue to work.
- Save replay is idempotent, and file delivery is not knowingly duplicated.
- Per-file and per-user limits bound Worker memory and persistent storage.
- File bytes never enter topic bodies, durable messages, model text, or logs.
- Agent API tests, lint, and typecheck pass; Worker E2E passes on a capable host.
