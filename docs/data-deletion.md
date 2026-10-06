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
| `UserDO` SQLite + KV | topics, conversations, legacy messages, file rows, schedules, settings, the Telegram link row, the admin task | `deleteAll()` |
| `ScheduleDO` | every deadline for the user, and its alarm | `purge()` |
| `AssistantDO` | every agent transcript (Pi's tables), delivery claims, learning state, Lifecycle jobs and its alarm | `purge()`, then `drop()` |
| `TelegramAccountDO` | the Telegram account's claim on this user | `release()` |
| KV `tg:{id}` | cache of that claim (the only KV key shape the Worker writes) | `delete()` |
| R2 `zero-attachments` | file bytes under `files/{user}/` and `attachments/{user}/` | per-record deletes plus a prefix sweep |

The R2 prefix sweep is not redundant with the per-record loop. It is what
removes **orphans**: objects whose metadata row was lost (a save that died
between the put and the insert, an old bug). A row-driven loop cannot see them,
so without the sweep they would outlive the user.

`UserDO.deleteAllData` takes the Clerk user id as an argument instead of reading
the one in DO storage. That stored copy is written by `enqueueTurn`, so a DO that
never ran a turn has none, and reading it would silently skip the R2 sweep —
the one step that reaches a store the SQLite wipe cannot.

## Why the order is what it is

1. **Release the Telegram claim first.** While it stands, an inbound message
   still resolves to this user and writes fresh rows behind the purge.
2. **Purge `ScheduleDO`, then `AssistantDO`.** Both call back into `UserDO`,
   so they have to stop before `UserDO` is emptied.
3. **Empty `UserDO`.**
4. **Purge schedules and the assistant again.** An agent run that was already
   going in step 2 can keep writing topics over RPC.
5. **Abort `AssistantDO`, then the `UserDO` instance** (`ctx.abort`).

## Why the object is left empty

`deleteAll()` on a SQLite-backed class removes the entire private database,
schema included, which deallocates the object's storage. Nothing is written
back: re-running migrations there would immediately re-allocate it. That leaves
the live instance holding a schema-less database, so the purge finishes with
`UserDO.reset()`, which calls `ctx.abort`.

`abort` raises an error that cannot be caught inside the Durable Object, so the
RPC always rejects on the caller's side. That rejection is the success signal,
and `purgeUserData` swallows it. It is a separate RPC from `deleteAllData` for
exactly that reason: only one of the two is expected to throw.

If anything ever addresses that DO id again, the constructor migrates from
scratch and the user is a brand-new, empty user.

## Accepted races

- An agent run that is mid-flight can re-create a topic seconds after the wipe,
  which also re-creates UserDO's schema. The second purge (step 4)
  catches what it re-armed; anything later is the user's own data and a second
  press of the button removes it. Closing the window properly needs a deletion
  generation stamped on every write, which is not worth it today.

## What is not deleted

The UI says the honest version of this, not "we deleted everything, everywhere".

- **The Clerk account**: name, email, and the Google OAuth grant with its
  tokens. Deletion signs the user out; it does not delete the account, and Zero
  keeps the Google grant until the user disconnects it in Settings.
- **Analytics Engine** (`zero-events`, `zero-ai-usage`): write-only datasets
  indexed by Clerk user id. There is no delete API; Cloudflare stores data for
  three months and it ages out.
- **Workers Logs**: lines carry `clerk_user_id`. No per-record delete; they age
  out with the retention window.
- **AI Gateway logs**: each call carries `cf-aig-metadata` with
  `{ user_id, agent }`, and OpenAI requests carry `safety_identifier`. These can
  be deleted per user, but only out of band, since it needs a Cloudflare API
  token the Worker does not hold:

  ```bash
  curl -X DELETE "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/ai-gateway/gateways/zero/logs" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" \
    --get --data-urlencode 'filters=[{"key":"metadata.value","operator":"eq","value":"<clerk_user_id>"}]'
  ```

  Run it when a user asks for their AI Gateway logs to go too.
- **ZeroErrors** (project `zero-agent`): error contexts include
  `clerk_user_id`, never message content. Cleared by deleting the issue.
- **The Discord signup notice**: a one-off message with name and email in our
  channel. Manual.
- **Telegram**: the chat history on the user's own device and on Telegram's
  servers is theirs, not ours.
- **The model provider**: prompts already sent are subject to OpenAI's
  retention, not ours.
