---
name: drive
description: "Google Drive. Use for searching, uploading, downloading and managing files."
---

# drive

Google Drive operations via the `gdcli` CLI.

## Account

Credentials are already injected. Use `$GOOGLE_ACCOUNT_EMAIL` as the
account in every command:

```bash
gdcli "$GOOGLE_ACCOUNT_EMAIL" <command>
```

Never run `gdcli accounts add` or `gdcli accounts credentials` — they
require a browser and will fail here. If a command reports no account,
Google isn't connected; tell the user to connect it in the Zero app.

## Usage

Run `gdcli --help` for the full command reference. Common operations:

- `gdcli "$GOOGLE_ACCOUNT_EMAIL" ls [folderId] [--query <q>]` — list files/folders
- `gdcli "$GOOGLE_ACCOUNT_EMAIL" search "<text>"` — full-text content search
- `gdcli "$GOOGLE_ACCOUNT_EMAIL" get <fileId>` — file metadata
- `gdcli "$GOOGLE_ACCOUNT_EMAIL" download <fileId> [destPath]` — download (Google Docs auto-export to PDF/CSV)
- `gdcli "$GOOGLE_ACCOUNT_EMAIL" upload <localPath> [--folder <folderId>] [--name <n>]` — upload
- `gdcli "$GOOGLE_ACCOUNT_EMAIL" mkdir <name> [--parent <folderId>]` — create folder
- `gdcli "$GOOGLE_ACCOUNT_EMAIL" move <fileId> <newParentId>` / `rename <fileId> <newName>`
- `gdcli "$GOOGLE_ACCOUNT_EMAIL" delete <fileId>` — trash a file
- `gdcli "$GOOGLE_ACCOUNT_EMAIL" share <fileId> [--anyone | --email <addr>] [--role reader|writer]`
- `gdcli "$GOOGLE_ACCOUNT_EMAIL" permissions <fileId>` / `unshare <fileId> <permissionId>`

## Search vs ls --query

Two different commands:

- `search "<text>"` — matches **file contents** (full text)
- `ls --query "<query>"` — filters by **metadata** (name, type, date,
  owner). **Use this for filename lookups.**

### Query syntax (for `ls --query`)

Format: `field operator value`. Combine with `and`/`or`, group with `()`.
Operators: `=`, `!=`, `contains`, `<`, `>`, `<=`, `>=`.

```bash
ls --query "name = 'report.pdf'"                       # exact name
ls --query "name contains 'IMG'"                       # name prefix
ls --query "mimeType = 'application/pdf'"
ls --query "mimeType = 'application/vnd.google-apps.folder'"   # folders
ls --query "modifiedTime > '2026-01-01'"
ls --query "'me' in owners"
ls --query "trashed = false"
ls --query "name contains 'report' and mimeType = 'application/pdf'"
```

Reference: <https://developers.google.com/drive/api/guides/ref-search-terms>
