---
name: gmail
description: "Gmail. Use for reading, sending and managing emails."
---

# gmail

Gmail operations via the `gmcli` CLI.

## Account

Credentials are already injected. Use `$GOOGLE_ACCOUNT_EMAIL` as the
account in every command:

```bash
gmcli "$GOOGLE_ACCOUNT_EMAIL" <command>
```

Never run `gmcli accounts add` or `gmcli accounts credentials` — they
require a browser and will fail here. If a command reports no account,
Google isn't connected; tell the user to connect it in the Zero app.

## Usage

Run `gmcli --help` for the full command reference. Common operations:

- `gmcli "$GOOGLE_ACCOUNT_EMAIL" search "<query>"` — search threads with
  [Gmail query syntax](https://support.google.com/mail/answer/7190);
  returns thread id, date, sender, subject, labels
- `gmcli "$GOOGLE_ACCOUNT_EMAIL" thread <threadId>` — read a full thread
  (every message with its id, headers, body, attachments)
- `gmcli "$GOOGLE_ACCOUNT_EMAIL" send --to <emails> --subject <s> --body <b>` — send
- `gmcli "$GOOGLE_ACCOUNT_EMAIL" send --reply-to <id> --to <emails> --subject <s> --body <b>` — reply in-thread
- `gmcli "$GOOGLE_ACCOUNT_EMAIL" labels <threadIds...> [--add L] [--remove L]` — modify labels
- `gmcli "$GOOGLE_ACCOUNT_EMAIL" drafts list|get|create|send|delete` — drafts

`send`/`drafts create` also take `--cc`, `--bcc`, and `--attach <file>`
(repeatable).

## Replying

- Read the thread first. `search` returns only thread ids; `thread` gives
  the per-message id you reply to — printed on the `Message-ID:` line
  (it's the Gmail message id, not an RFC-822 header).
- Prefer replying to an existing conversation over composing a new
  message.
- `--reply-to` sets In-Reply-To/References and keeps the reply in-thread,
  but gmcli does **not** auto-fill or quote: set `--to` (the original
  sender from the `From:` line), `--subject` (`Re: …`), and `--body`
  yourself.

## Labels

Modify threads with system labels: archive `--remove INBOX`, mark read
`--remove UNREAD`, star `--add STARRED`. `labels list` shows all label
names (case-insensitive). System labels: `INBOX`, `UNREAD`, `STARRED`,
`IMPORTANT`, `TRASH`, `SPAM`.
