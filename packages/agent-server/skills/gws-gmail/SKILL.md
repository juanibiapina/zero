---
name: gmail
description: "Gmail. Use for reading, sending and managing emails."
---

# gmail

Use `gws` CLI for managing emails.

- Always read the full thread before replying or taking any action on a message.
- When responding to existing conversations, reply to the message instead of composing a new one — only use send for starting new conversations.

## Global flags

| Flag | Description |
|------|-------------|
| `--format <FORMAT>` | Output format: `json` (default), `table`, `yaml`, `csv` |
| `--dry-run` | Show the request without executing |
| `--params '{"key": "val"}'` | URL/query parameters |
| `--json '{"key": "val"}'` | Request body |
| `--page-all` | Auto-paginate (NDJSON output) |

## List inbox

```bash
gws gmail +triage --query 'in:inbox'
gws gmail +triage --query 'in:inbox is:unread'
gws gmail +triage --query 'in:inbox from:boss' --max 5
```

## Search all mail

For finding archived or older messages across the entire mailbox:

```bash
gws gmail +triage --query 'subject:invoice after:2026/01/01'
gws gmail +triage --query 'from:alice has:attachment'
gws gmail +triage --query 'project kickoff' --max 10
```

Both use [Gmail search syntax](https://support.google.com/mail/answer/7190). Returns message ID, from, subject, and date. Default output is a table, use `--format json` for structured data.

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--query` | — | is:unread | Gmail search query |
| `--max` | — | 20 | Maximum messages to show |
| `--labels` | — | — | Include label names in output |

## Read a message

```bash
gws gmail +read --id <MESSAGE_ID>
gws gmail +read --id <MESSAGE_ID> --headers
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--id` | ✓ | — | The Gmail message ID |
| `--headers` | — | — | Include headers (From, To, Subject, Date) |
| `--format` | — | plain text | Output format: `json`, `table`, `yaml`, `csv` |
| `--html` | — | — | Return HTML body instead of plain text |

- Converts HTML-only messages to plain text automatically.
- Handles multipart/alternative and base64 decoding.

## Read a full thread

Use `--format json` to get the `thread_id` from a message, then fetch the entire conversation:

```bash
gws gmail +read --id <MESSAGE_ID> --format json   # includes thread_id
gws gmail users threads get --params '{"userId": "me", "id": "<THREAD_ID>"}'
```

## Reply to a message

```bash
gws gmail +reply --message-id <MESSAGE_ID> --body 'Thanks, got it!'
gws gmail +reply --message-id <MESSAGE_ID> --body 'Looping in Carol' --cc carol@example.com
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--message-id` | ✓ | — | Gmail message ID to reply to |
| `--body` | ✓ | — | Reply body (plain text, or HTML with --html) |
| `--to` | — | — | Additional To recipients |

Also accepts: `--cc`, `--bcc`, `--html`, `--attach`, `--draft` (same as sending).

- Automatically sets In-Reply-To, References, and threadId headers.
- Quotes the original message in the reply body.
- For reply-all: `gws gmail +reply-all` (same flags, plus `--remove <EMAILS>` to exclude recipients).

> [!CAUTION]
> Confirm with the user before executing.

## Send a new message

```bash
gws gmail +send --to <EMAILS> --subject <SUBJECT> --body <TEXT>
gws gmail +send --to alice@example.com --subject 'Report' --body 'See attached' -a report.pdf
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--to` | ✓ | — | Recipient email address(es), comma-separated |
| `--subject` | ✓ | — | Email subject |
| `--body` | ✓ | — | Email body (plain text, or HTML with --html) |
| `--from` | — | — | Sender address (for send-as/alias) |
| `--attach` | — | — | Attach a file (can repeat) |
| `--cc` | — | — | CC email address(es), comma-separated |
| `--bcc` | — | — | BCC email address(es), comma-separated |
| `--html` | — | — | Treat --body as HTML content |
| `--draft` | — | — | Save as draft instead of sending |

> [!CAUTION]
> Confirm with the user before executing.

## Raw API access

For operations not covered above, inspect the API directly:

```bash
gws gmail --help
gws schema gmail.<resource>.<method>
```

Use `gws schema` output to build `--params` and `--json` flags.
