---
name: calendar
description: "Google Calendar. Use for viewing, creating and managing calendar events."
---

# calendar

Use `gws` CLI for managing calendar events.

- Check the agenda before creating events to avoid conflicts.
- Use ISO 8601 / RFC 3339 timestamps with timezone offset (e.g. `2026-06-17T09:00:00-07:00`).

## Global flags

| Flag | Description |
|------|-------------|
| `--format <FORMAT>` | Output format: `json` (default), `table`, `yaml`, `csv` |
| `--dry-run` | Show the request without executing |
| `--params '{"key": "val"}'` | URL/query parameters |
| `--json '{"key": "val"}'` | Request body |
| `--page-all` | Auto-paginate (NDJSON output) |

## View agenda

```bash
gws calendar +agenda
gws calendar +agenda --today
gws calendar +agenda --week --format table
gws calendar +agenda --days 3 --calendar 'Work'
gws calendar +agenda --today --timezone America/New_York
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--today` | — | — | Show today's events |
| `--tomorrow` | — | — | Show tomorrow's events |
| `--week` | — | — | Show this week's events |
| `--days <N>` | — | — | Number of days ahead to show |
| `--calendar <NAME>` | — | all calendars | Filter to specific calendar name or ID |
| `--timezone <TZ>` | — | account default | IANA timezone override (e.g. America/Denver) |

Read-only — never modifies events. Queries all calendars by default.

## Create an event

```bash
gws calendar +insert --summary 'Standup' --start '2026-06-17T09:00:00-07:00' --end '2026-06-17T09:30:00-07:00'
gws calendar +insert --summary 'Review' --start '2026-06-17T14:00:00-07:00' --end '2026-06-17T15:00:00-07:00' --attendee alice@example.com
gws calendar +insert --summary 'Sync' --start '2026-06-17T10:00:00-07:00' --end '2026-06-17T10:30:00-07:00' --meet
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--summary <TEXT>` | ✓ | — | Event title |
| `--start <TIME>` | ✓ | — | Start time (ISO 8601) |
| `--end <TIME>` | ✓ | — | End time (ISO 8601) |
| `--calendar <ID>` | — | primary | Calendar ID |
| `--location <TEXT>` | — | — | Event location |
| `--description <TEXT>` | — | — | Event description/body |
| `--attendee <EMAIL>` | — | — | Attendee email (repeatable) |
| `--meet` | — | — | Add a Google Meet link |

> [!CAUTION]
> Confirm with the user before executing.

## Get event details

```bash
gws calendar events get --params '{"calendarId": "primary", "eventId": "<EVENT_ID>"}'
```

Use `--format json` on agenda output to get event IDs.

## Update an event

```bash
gws calendar events patch --params '{"calendarId": "primary", "eventId": "<EVENT_ID>"}' --json '{"summary": "New title"}'
gws calendar events patch --params '{"calendarId": "primary", "eventId": "<EVENT_ID>"}' --json '{"start": {"dateTime": "2026-06-17T11:00:00-07:00"}, "end": {"dateTime": "2026-06-17T12:00:00-07:00"}}'
```

> [!CAUTION]
> Confirm with the user before executing.

## Delete an event

```bash
gws calendar events delete --params '{"calendarId": "primary", "eventId": "<EVENT_ID>"}'
```

> [!CAUTION]
> Confirm with the user before executing.

## Check availability

```bash
gws calendar freebusy query --json '{"timeMin": "2026-06-17T00:00:00Z", "timeMax": "2026-06-18T00:00:00Z", "items": [{"id": "primary"}]}'
```

## List calendars

```bash
gws calendar calendarList list
```

Use this to discover calendar IDs for `--calendar` or `calendarId` params.

## Raw API access

For operations not covered above, inspect the API directly:

```bash
gws calendar --help
gws schema calendar.<resource>.<method>
```

Use `gws schema` output to build `--params` and `--json` flags.
