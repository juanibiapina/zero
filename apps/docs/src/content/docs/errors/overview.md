---
title: ZeroErrors Overview
description: How ZeroErrors groups error reports into issues.
---

ZeroErrors collects error reports from your applications. You send a report; it is
grouped into an **issue** you can browse and resolve in the dashboard.

## Reports and issues

You POST individual **reports** (one per occurrence). ZeroErrors groups reports
that look like the same problem into a single **issue**, so a thousand
occurrences of one bug show up as one issue with a count, not a thousand rows.

Grouping is by project, a normalized version of the message, and the first stack
frame. The frame is the first line of the stack that begins with `at ` (the error
type and message line above it is skipped); if the report has no stack, that part
is empty and grouping falls back to project and message alone. Two reports group
together when all three parts match. Normalization masks the parts that change
between occurrences (UUIDs, long hex strings, and plain numbers), so repeats of
the same error collapse together even when they carry different IDs.

An issue tracks:

- `count`, `firstSeenAt`, `lastSeenAt`
- `level`: `error`, `warning`, or `info` (defaults to `error`)
- `status`: `open` or `resolved`
- `title`: the first line of the message

## The console

At [dash.zeroapps.dev/errors](https://dash.zeroapps.dev/errors) you get a list of
issues you can filter by project and toggle to show resolved ones. Open an issue
to see its recent events, and mark it **Resolve** when it is handled. Resolving
sets the status; it does not delete the issue. To get rid of an issue, see
[Deleting an issue](#deleting-an-issue).

An error "project" is created implicitly by the first report that carries its
name. There is no separate step to create one.

## Deleting an issue

Deleting removes the issue and its stored events. It is how you clear out test
data or an issue you never want to see again.

In the console you can delete from the issues list, using the delete button on
the row, or from the issue detail page. Both ask you to confirm first. Deleting
from the detail page takes you back to the issues list.

Over the API:

```bash
curl -sS -X DELETE https://api.zeroapps.dev/errors/v1/issues/$ISSUE_ID \
  -H "authorization: Bearer $ZEROVAULT_API_KEY"
```

You get `204` with an empty body. An id that does not exist, including one you
already deleted, gets `404 {"error":"Issue not found"}`. A missing or wrong key
gets `401`, and a rate-limited request gets `429` with a `Retry-After` header.

An issue id comes from the `issueId` in the `202` response to a report, or from
the listing:

```bash
curl -sS "https://api.zeroapps.dev/errors/v1/issues?project=docs-demo" \
  -H "authorization: Bearer $ZEROVAULT_API_KEY"
```

Two things to know before you delete:

- **The issue comes back as a new one if the error happens again.** Grouping
  works off a fingerprint that no longer exists once the issue is gone, so the
  next report creates a fresh issue with a new id, a count of 1, and `isNew:
  true`, and it notifies as a new issue. Deleting does not mute a live bug.
- **Deleting the last issue of a project removes that project from the
  console.** A project only exists as a label on its issues, so nothing carries
  the name once they are all gone. Reporting under the name again brings it
  back.

You cannot undo a delete from the product. It is not an erasure guarantee across
the whole platform either: logs written when the issue was created or regressed
can be retained for up to 7 days, and the underlying store supports
point-in-time recovery over the past 30 days.

## API keys

ZeroErrors uses an organization-scoped `zv_…` API key, created under **API keys**
in the dashboard sidebar. The same key authorizes ZeroVault. See
[API keys](/account/api-keys/), or
[Getting started](/errors/getting-started/) to send your first report.
