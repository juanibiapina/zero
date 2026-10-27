# Data deletion

A signed-in user erases everything Zero holds for them from the Settings page:
`DELETE /api/user-data`, wired in `routes/user-settings.ts`. The sequence lives
in `do/purge.ts`, away from the Durable Objects, so the order is unit tested.

The request is synchronous. A 200 means the data is already gone, which is what
lets the web app sign the user out on success; a failure is a 500 and the user
presses the button again. Every step is idempotent.

## What is deleted

| Store | What it holds | How it goes |
|---|---|---|
| `TaskDO` | Tasks, Projects, Waiting conditions, Afters, Medicines, the night routine, the shopping list | `purge()`, then `reset()` |
| `UserDO` | settings (timezone, creation date) | `deleteAllData()`, then `reset()` |

Both objects are emptied before either is aborted, so a 200 never hides a store
that still holds data.

## Why the objects are left empty

`deleteAll()` on a SQLite-backed class removes the entire private database,
schema included, which deallocates the object's storage. Nothing is written
back: re-running migrations there would immediately re-allocate it. That leaves
the live instance holding a schema-less database, so the purge finishes with
`reset()`, which calls `ctx.abort`.

`abort` raises an error that cannot be caught inside the Durable Object, so the
RPC always rejects on the caller's side. That rejection is the success signal,
and `purgeUserData` swallows it. It is a separate RPC from the purge for exactly
that reason: only one of the two is expected to throw.

If anything ever addresses that DO id again, the constructor migrates from
scratch and the user is a brand-new, empty user.

## What is not deleted

The UI says the honest version of this, not "we deleted everything, everywhere".

- **The Clerk account**: name and email. Deletion signs the user out; it does not
  delete the account.
- **Analytics Engine** (`zero-events`): write-only, indexed by Clerk user id.
  There is no delete API; Cloudflare stores data for three months and it ages out.
- **Workers Logs**: lines carry `clerk_user_id`. No per-record delete; they age
  out with the retention window.
- **ZeroErrors** (project `zero-agent`): error contexts include
  `clerk_user_id`, never task content. Cleared by deleting the issue.
- **The Discord signup notice**: a one-off message with name and email in our
  channel. Manual.
