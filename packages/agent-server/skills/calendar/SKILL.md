---
name: calendar
description: "Google Calendar. Use for viewing, creating and managing calendar events."
---

# calendar

Google Calendar operations via the `gccli` CLI.

## Account

Credentials are already injected. Use `$GOOGLE_ACCOUNT_EMAIL` as the
account in every command:

```bash
gccli "$GOOGLE_ACCOUNT_EMAIL" <command>
```

Never run `gccli accounts add` or `gccli accounts credentials` — they
require a browser and will fail here. If a command reports no account,
Google isn't connected; tell the user to connect it in the Zero app.

## Usage

Run `gccli --help` for the full command reference. Common operations:

- `gccli "$GOOGLE_ACCOUNT_EMAIL" calendars` — list calendars (ID, name, role)
- `gccli "$GOOGLE_ACCOUNT_EMAIL" events <calendarId> [--from <dt>] [--to <dt>] [--query <q>] [--max <n>]` — list events
- `gccli "$GOOGLE_ACCOUNT_EMAIL" event <calendarId> <eventId>` — event details
- `gccli "$GOOGLE_ACCOUNT_EMAIL" create <calendarId> --summary <s> --start <dt> --end <dt> [...]` — create
- `gccli "$GOOGLE_ACCOUNT_EMAIL" update <calendarId> <eventId> [...]` — update
- `gccli "$GOOGLE_ACCOUNT_EMAIL" delete <calendarId> <eventId>` — delete
- `gccli "$GOOGLE_ACCOUNT_EMAIL" freebusy <calendarIds> --from <dt> --to <dt>` — availability
- `gccli "$GOOGLE_ACCOUNT_EMAIL" acl <calendarId>` — access rules

Use `primary` as the `calendarId` for the user's main calendar. `create`
takes `--description`, `--location`, `--attendees <emails>` (comma-
separated), and `--all-day`.

## Date/time format

- Timed events: `YYYY-MM-DDTHH:MM:SSZ` (UTC) or with offset
  (`2026-06-17T09:00:00-07:00`)
- All-day events: `YYYY-MM-DD` with `--all-day`

## Agenda

There is no natural-language agenda flag: compute the window yourself and
pass ISO `--from`/`--to` to `events`. The default window is now → one
week. Check the agenda before creating an event to avoid conflicts.
