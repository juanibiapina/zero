---
name: drive
description: "Google Drive. Use for searching, uploading, downloading and managing files."
---

# drive

Use `gws` CLI for managing Google Drive files.

- Use the `q` search parameter to find files instead of listing everything.
- Always include `trashed=false` in queries unless the user explicitly wants trashed files.

## Global flags

| Flag | Description |
|------|-------------|
| `--format <FORMAT>` | Output format: `json` (default), `table`, `yaml`, `csv` |
| `--dry-run` | Show the request without executing |
| `--params '{"key": "val"}'` | URL/query parameters |
| `--json '{"key": "val"}'` | Request body |
| `--page-all` | Auto-paginate (NDJSON output) |

## Search files

```bash
gws drive files list --params '{"q": "name contains '\''report'\'' and trashed=false", "fields": "files(id,name,mimeType,modifiedTime)"}'
gws drive files list --params '{"q": "mimeType='\''application/pdf'\'' and trashed=false", "fields": "files(id,name)"}'
gws drive files list --params '{"q": "'\''me'\'' in owners and trashed=false", "pageSize": 10, "fields": "files(id,name,mimeType)"}'
```

Common `q` operators: `name contains`, `mimeType=`, `'me' in owners`, `modifiedTime >`, `parents in`. Combine with `and`/`or`. Always request specific `fields` to keep responses small.

## List files in a folder

```bash
gws drive files list --params '{"q": "'\''<FOLDER_ID>'\'' in parents and trashed=false", "fields": "files(id,name,mimeType)"}'
```

## Get file metadata

```bash
gws drive files get --params '{"fileId": "<FILE_ID>", "fields": "id,name,mimeType,size,modifiedTime,webViewLink"}'
```

## Download a file

```bash
gws drive files get --params '{"fileId": "<FILE_ID>", "alt": "media"}' -o output.pdf
```

For Google Workspace docs (Docs, Sheets, Slides), use export instead:

```bash
gws drive files export --params '{"fileId": "<FILE_ID>", "mimeType": "application/pdf"}' -o output.pdf
gws drive files export --params '{"fileId": "<FILE_ID>", "mimeType": "text/csv"}' -o output.csv
```

## Upload a file

```bash
gws drive +upload ./report.pdf
gws drive +upload ./report.pdf --parent <FOLDER_ID>
gws drive +upload ./data.csv --name 'Sales Data.csv'
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `<file>` | ✓ | — | Path to file to upload |
| `--parent <ID>` | — | — | Parent folder ID |
| `--name <NAME>` | — | source filename | Target filename |

MIME type is detected automatically.

> [!CAUTION]
> Confirm with the user before executing.

## Create a folder

```bash
gws drive files create --json '{"name": "My Folder", "mimeType": "application/vnd.google-apps.folder"}'
gws drive files create --json '{"name": "Subfolder", "mimeType": "application/vnd.google-apps.folder", "parents": ["<FOLDER_ID>"]}'
```

> [!CAUTION]
> Confirm with the user before executing.

## Move a file

```bash
gws drive files update --params '{"fileId": "<FILE_ID>", "addParents": "<NEW_FOLDER_ID>", "removeParents": "<OLD_FOLDER_ID>"}'
```

> [!CAUTION]
> Confirm with the user before executing.

## Rename a file

```bash
gws drive files update --params '{"fileId": "<FILE_ID>"}' --json '{"name": "New Name.pdf"}'
```

> [!CAUTION]
> Confirm with the user before executing.

## Delete a file

```bash
gws drive files delete --params '{"fileId": "<FILE_ID>"}'
```

> [!CAUTION]
> Confirm with the user before executing.

## Share a file

```bash
gws drive permissions create --params '{"fileId": "<FILE_ID>"}' --json '{"role": "reader", "type": "user", "emailAddress": "alice@example.com"}'
gws drive permissions create --params '{"fileId": "<FILE_ID>"}' --json '{"role": "writer", "type": "user", "emailAddress": "bob@example.com"}'
```

Roles: `reader`, `commenter`, `writer`, `organizer`. Types: `user`, `group`, `domain`, `anyone`.

> [!CAUTION]
> Confirm with the user before executing.

## Raw API access

For operations not covered above, inspect the API directly:

```bash
gws drive --help
gws schema drive.<resource>.<method>
```

Use `gws schema` output to build `--params` and `--json` flags.
