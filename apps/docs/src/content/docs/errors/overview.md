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
sets the status; it does not delete the issue.

An error "project" is created implicitly by the first report that carries its
name. There is no separate step to create one.

## Keys come from ZeroVault

ZeroErrors uses the same organization-scoped `zv_…` API key as ZeroVault. There
is no separate key page for ZeroErrors, so you create your key under
**ZeroVault → API Keys**. See [Getting started](/errors/getting-started/).
