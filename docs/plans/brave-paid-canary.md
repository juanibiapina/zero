# Plan: per-user paid Brave key canary

## Goal

Route the paid Brave Search key to a controllable subset of users (a per-user
flag), so real search cost can be measured on that cohort and optimized before
the paid key is rolled out to everyone. Everyone else keeps using the existing
(free) key. The flag is toggled live by an admin, with no redeploy, and reverts
cleanly.

## Background and constraints (for a fresh reader)

- Zero calls Brave once per `web_search` via `createBraveSearch(apiKey)`, built
  per turn in `UserDO.runTurn` (`apps/agent-api/src/UserDO/index.ts`, ~line 463),
  where `clerkUserId` is already known. That is the selection point.
- The current key is Brave's **Free plan = 1 request/second**; bursty turns
  trip HTTP 429 heavily (measured: 65% of requests 429, ~22% of logical searches
  fail outright). A paid key is **50 req/s** but bills **$5 per 1,000 requests**
  (first ~1,000/month free via a $5 credit). A single turn has been observed
  issuing 43–72 distinct searches, so paid cost can run away; measuring a small
  cohort first is the point of this canary.
- `apps/agent-api/src/websearch/brave.ts` already emits one `brave_request` log
  line per HTTP attempt (plus `brave_rate_limited`, `brave_request_failed`),
  carrying `status`, `attempt`, rate headers, `query_hash`, `query_len`. It does
  **not** currently tag which key/cohort made the request, and Brave is not
  behind the AI Gateway, so Workers Logs is the only place cost can be counted.
  Tagging each line with a `cohort` is what makes the paid cohort's spend a
  one-line query (`cohort:paid, status:200`, per `docs/research.md` Search usage).
- Settings live in `user_settings` (DO SQLite), surfaced through the `Store` port
  with two adapters (`store/db.ts` DbStore, `store/memory.ts` MemoryStore) and a
  shared contract test (`store/store-contract.test.ts`). Migrations are numbered
  SQL files registered in `UserDO/db/migrations.ts`; the latest is `0035`.
- Admin endpoints live in `apps/agent-api/src/routes/admin.ts`, gated by
  `/api/admin/*` (only `ADMIN_USER_ID`), written with `createRoute` +
  `router.openapi`. `getUserDO(env, userId)` reaches a user's DO.
- No changelog entry: this is an internal cost experiment with no user-visible
  behavior change (search keeps working the same). Purely internal per AGENTS.

## Key decisions

1. **Per-user boolean flag `braveKeyPaid` on `user_settings`**, default false.
   Chosen over an env allowlist or percentage rollout because the user wants to
   add/remove specific users live, without a redeploy, to measure and optimize
   gradually. Boolean (not a plan enum) keeps it minimal; a future provider/plan
   dimension can replace it if ever needed.

2. **Selection is a pure function** `selectBraveKey` (new
   `apps/agent-api/src/websearch/brave-key.ts`), taking the flag and both keys and
   returning `{ apiKey, cohort }`. Pure so it is testable without a DO, matching
   the codebase's `do/*.ts` posture. `runTurn` reads `settings.braveKeyPaid` and
   calls it.

3. **Safe fallback.** If the paid flag is set but `BRAVE_API_KEY_PAID` is unset or
   empty, `selectBraveKey` returns the free key with `cohort: "free"`. A missing
   secret must never break search for a flagged user; it degrades to free and the
   logs show it stayed free.

4. **Cohort tagging.** `createBraveSearch` gains a `cohort` option threaded into
   every Brave log line (`brave_request`, `brave_rate_limited`,
   `brave_request_failed`). Values `"paid" | "free"`. This is the measurement
   surface; without it the canary is unfalsifiable.

5. **Admin toggle endpoint** `PUT /api/admin/users/{userId}/brave-plan` with body
   `{ paid: boolean }`, admin-gated, calling a new `UserDO.setBravePaid(paid)` RPC
   that writes the setting. The existing `GET /api/admin/users/{userId}` detail
   response also surfaces the current flag, so the admin can read cohort
   membership back.

## What to change

**1. Secret.** Add `BRAVE_API_KEY_PAID` as a **required** secret:
- Set it in the `zero-api` vault for **both** `development` and `production`. It
  must exist in every environment the deploy validates (including CI's dev
  vault), or the deploy aborts (next bullet). The paid key value is already
  provided.
- Add `"BRAVE_API_KEY_PAID"` to `secrets.required` in
  `apps/agent-api/wrangler.jsonc` (the custom block enforced at deploy by
  `validateSecrets`; see `docs/workers-ops.md`). This is deliberate: a missing
  paid key should fail the deploy, not ship silently.
- Update the committed `worker-configuration.d.ts` **by hand**: add
  `BRAVE_API_KEY_PAID: string;` to `__BaseEnv_Env` (next to `BRAVE_API_KEY`) and
  add `"BRAVE_API_KEY_PAID"` to the `ProcessEnv` `Pick<...>` union. That file is
  normally produced by `wrangler types`, which **cannot run on this box**
  (`workerd` won't start under NixOS), so local and CI typecheck read the
  committed file. Hand-edit it to what `wrangler types` would emit once the
  secret is in `.dev.vars`.

Note: `selectBraveKey` still falls back to the free key if the paid key is
somehow empty at runtime (defense in depth), but the secret is required, so the
fallback is a safety net, not the expected path.

**2. Migration `0036_brave_key_paid.sql`** (`UserDO/db/migrations/`, registered in
`migrations.ts`): `ALTER TABLE "user_settings" ADD COLUMN "braveKeyPaid" INTEGER
NOT NULL DEFAULT 0;` (boolean as 0/1, like `onboardingSeen`).

**3. Settings surface** (`store/types.ts`, `store/db.ts`, `store/memory.ts`,
`UserDO/db/schema.ts`): add `braveKeyPaid: boolean` to `UserSettings`; add
`braveKeyPaid?: boolean` to the `updateSettings` patch; map the column in both
adapters and the seeded/default paths; add the column to `schema.ts`. Mirror in
the `SettingsRow` shapes in both adapters.

**4. Selection helper** (`websearch/brave-key.ts`): `selectBraveKey(input: {
paid: boolean; freeKey: string; paidKey: string | undefined }): { apiKey: string;
cohort: "paid" | "free" }`. Paid only when `paid` is true and `paidKey` is a
non-empty string; otherwise free.

**5. Cohort in the adapter** (`websearch/brave.ts`): add `cohort?: string` to
`BraveSearchOptions`; include it in `queryFields` (built once at ~line 115). That
object is spread into every Brave log line (`brave_request`,
`brave_rate_limited`, `brave_request_failed`, `brave_quota_exhausted`), so one
addition tags them all. Omitted when not supplied (keeps existing tests valid
unless they opt in).

**6. Wire it in `runTurn`** (`UserDO/index.ts`): `this.store.getSettings()` is
currently read a few lines **after** `createBraveSearch` (~line 475 vs 463).
Reorder so the settings (and `braveKeyPaid`) are read first, then call
`selectBraveKey({ paid: settings.braveKeyPaid, freeKey: this.env.BRAVE_API_KEY,
paidKey: this.env.BRAVE_API_KEY_PAID })` and build
`createBraveSearch(apiKey, { cohort })`.

**7. UserDO RPC** (`UserDO/index.ts`): `async setBravePaid(paid: boolean)` →
`this.store.updateSettings({ braveKeyPaid: paid })`. Log `brave_plan_set`
(`{ paid }`, no PII beyond the flag).

**8. Admin endpoint** (`routes/admin.ts`): `PUT /api/admin/users/{userId}/brave-plan`,
admin-gated, body `{ paid: boolean }`, 404 for an unknown Clerk user (reuse
`getClerkUser`), else call `getUserDO(...).setBravePaid(paid)` and return 200 with
`{ clerkUserId, paid }`. Add `braveKeyPaid` to `AdminUserDetailSchema` and the
`GET /api/admin/users/{userId}` handler so membership is readable.

## Tests to add or update

- `store/store-contract.test.ts`: `braveKeyPaid` defaults to false on a seeded
  row; round-trips true/false through `updateSettings`/`getSettings`; identical
  for both adapters. Update the exact-shape assertion in the "getSettings seeds
  the row" test to include `braveKeyPaid: false`.
- `websearch/brave-key.test.ts` (new): paid flag + non-empty paid key → paid
  cohort + paid key; paid flag + empty/undefined paid key → free cohort + free
  key (fallback); flag false → free.
- `websearch/brave.test.ts`: when `cohort` is passed, it appears on
  `brave_request` (and on a 429's `brave_rate_limited` / give-up
  `brave_request_failed`). Assert against the existing fake-fetch harness.
- `routes/admin.test.ts`: the brave-plan endpoint is admin-gated (403 for
  non-admin), 404 for an unknown user, and calls `setBravePaid` with the body
  value; the user-detail response includes `braveKeyPaid`.

Behavior-driven: assert the observable result (which key/cohort a turn selects,
the flag persisted, the log tag present, the endpoint effect), not internals.

## Docs to add or update

- `docs/research.md` (Search usage): document the `cohort` field on the Brave log
  lines and the one-line paid-cohort spend query, plus the per-user
  `braveKeyPaid` flag and the admin toggle as the canary mechanism.
- No changelog entry (internal cost experiment, no user-visible change).

## Skills to use

- `tdd` — for the selection helper, settings column, adapter cohort tag, RPC, and
  admin endpoint; RED-GREEN-REFACTOR per increment.
- `testing` — behavior-focused assertions and the store-contract cases.
- `development-guidelines` — throughout, for TS-strict and functional preferences.
- `git-commit` — when committing.

## Acceptance criteria

1. A user with `braveKeyPaid = true` and a configured `BRAVE_API_KEY_PAID` has
   their turns use the paid key, and every Brave log line for that turn carries
   `cohort: "paid"`.
2. Every other user uses the free key, tagged `cohort: "free"`.
3. If the paid flag is set but the paid secret is missing/empty, the turn falls
   back to the free key tagged `cohort: "free"` and search still works.
4. An admin can flip a user's flag on and off live via
   `PUT /api/admin/users/{userId}/brave-plan` with no redeploy, and read the
   current flag from the user-detail endpoint.
5. The paid cohort's request/spend is countable from Workers Logs by filtering
   `cohort: "paid"` (and `status: 200` for the bill).
6. Removing the flag reverts the user to the free key on their next turn, with no
   residue.

## Risks and mitigations

- **Missing paid secret breaks search for flagged users:** the fallback in
  `selectBraveKey` (criterion 3) keeps search working on the free key.
- **Runaway per-turn searching still bills on paid:** out of scope here; the
  canary exists precisely to measure that on a small cohort before any wider
  rollout. The `cohort` tag makes the cost visible per user cohort.
- **PII in logs:** only the boolean cohort is logged, never the user id or query
  text, consistent with the existing Brave logging rule.
```
