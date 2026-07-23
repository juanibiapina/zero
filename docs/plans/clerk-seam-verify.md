# Verification — Shared `clerk.ts` seam plan

Verdict: **GO**. No blockers. 4 construction sites and 2 external-account lookups
confirmed; the factory reproduces every construction identically; the helper
expresses both lookups without flattening an observable difference; existing
tests stay green; webhook and changelog scoping correct. Two nits below.

## Evidence by check

### 1. Exactly 4 `createClerkClient` construction sites across 3 files — CONFIRMED

`rg createClerkClient apps/agent-api/src` (construction calls only):

- `google-token.ts:29` (`getGoogleAccessToken`)
- `google-token.ts:57` (`getGoogleAccountEmail`)
- `github-token.ts:55` (`getGithubUsername`)
- `admin-users.ts:36` (private `clerkClient` factory)

Plus imports at `google-token.ts:8`, `github-token.ts:14`, `admin-users.ts:10`,
and two test-mock definitions (`*.test.ts`) that are mock factories, not real
construction. So 4 real sites, 3 files. Matches the plan.

All four constructions are byte-identical:
`createClerkClient({ secretKey: env.CLERK_SECRET_KEY, publishableKey: env.CLERK_PUBLISHABLE_KEY })`
(verified at each line). Same two env vars, same option keys, no extra options.
The factory `clerkClient(env)` reproduces each verbatim. No construction is
changed.

### 2. Two external-account lookups share one shape — CONFIRMED, no real difference flattened

Google email (`google-token.ts:57-66`) and github username
(`github-token.ts:55-61`) are structurally identical:

```
clerk.users.getUser(clerkUserId)
  → externalAccounts.find(a => a.provider.includes(<provider>))
  → read one field ?? null
```

Axis-by-axis:
- **provider string**: `"google"` vs `"github"` → parameter. `provider.includes`
  preserved verbatim, so `oauth_google` / `oauth_github` still match.
- **user id source**: both take the `clerkUserId` arg. Same.
- **field read back**: `emailAddress` vs `username`. The helper returns BOTH
  (`{ username, email }`); each caller reads the one it needs
  (`account?.email ?? null` / `account?.username ?? null`). Not flattened.
- **missing handling**: original returns null when no account OR when the field
  is absent (`account?.field ?? null`). Helper returns `null` for no-account and
  `{ field: null }` for account-without-field; the caller's `?? null` collapses
  both to `null`. Observable result identical in every branch.

Error handling — helper does NOT catch, preserving each site's distinct
try/catch + log event:
- **Google email**: keeps its own `try/catch` logging `google_email_unavailable`
  (`google-token.ts:67-72`). A `getUser` throw propagates out of `externalAccount`
  into this catch. Preserved.
- **Github username**: has **no** local catch today; the throw propagates to the
  two outer flows `getGithubInstallationStatus` / `getGithubInstallationToken`,
  both logging `github_token_unavailable` (`github-token.ts:135`, `:161`). Since
  the helper doesn't catch, this path is unchanged. Preserved.

Confirmed the log events are `google_email_unavailable` vs `github_token_unavailable`
(there is no `github_username_unavailable`; github's outer catch is token-scoped).

### 3. Google OAuth-token path and admin roster share only the factory — CORRECT, no risk

- `getGoogleAccessToken` uses `users.getUserOauthAccessToken(id, "google")` →
  `.data[0]?.token ?? null` (`google-token.ts:33-37`). A distinct Clerk API, not
  an external-account read; single caller. Leaving it inline and only swapping
  construction for `clerkClient(env)` is right. Construction is identical, so no
  behavior change.
- `admin-users.ts` already has a private `clerkClient(env)` identical to the
  factory (`:36-40`). Deleting it and importing the shared one is a pure move;
  `getUserList` paging (500 cap, `:49-54`), `toIdentity` primary-email selection
  (`:24-33`), and `getClerkUser`'s bare `catch → null` (`:64-68`) are untouched.
  No behavior risk from routing construction through the factory — same call,
  same options, same per-call client lifetime.

### 4. Existing tests stay green; none assert construction — CONFIRMED

- `google-token.test.ts:5-7` and `github-token.test.ts:5-7` both
  `vi.mock("@clerk/backend", () => ({ createClerkClient: () => ({ users: { getUser: getUserMock } }) }))`.
  `clerk.ts` imports `createClerkClient` from the same module, so the hoisted
  module mock applies through `clerkClient` / `externalAccount`. `clerkClient(env)`
  resolves to the mock object; `.users.getUser` is `getUserMock`. Traced each
  case (happy path, no-account → null, Clerk-throws → outer catch → null): all
  still pass with the seam.
- The mock's `createClerkClient` is a plain arrow, not a `vi.fn()`, and **no test
  asserts on it** (`rg toHaveBeenCalled` in these files hits only `fetchToken`,
  `getGithubInstallationStatus`, `getUserDO`). No test asserts the construction
  call directly, so the indirection is invisible.
- `google-token.test.ts` exercises only `getGoogleAccountEmail` +
  `memoizeTokenProvider`; it never calls `getGoogleAccessToken`, so the mock not
  providing `getUserOauthAccessToken` is fine. Plan's note is accurate.
- `routes/admin.test.ts:9,13` mock `../github-token` and `../admin-users`
  wholesale, so the shared factory is never reached. Unaffected.

Post-edit imports are all used (google-token: both `clerkClient` +
`externalAccount`; github-token: `externalAccount`; admin-users: `clerkClient`
plus retained `import type { User }`), and each file drops its now-unused
`@clerk/backend` value import cleanly — no dangling/unused-import lint risk.

### 5. `clerk-webhook.ts` out of scope — CONFIRMED

`routes/clerk-webhook.ts` imports `verifyWebhook` from `@clerk/backend/webhooks`
(`:12`, used at `:56`) and never calls `createClerkClient`. Different concern
(Svix signature verification). Correctly excluded.

### 6. Changelog: none — CORRECT

Pure internal refactor, no user-observable change. Per AGENTS.md, refactors get
no entry. Preservation argument (identical construction, provider match, return
values, and per-site error/log behavior) holds, so "none" is right.

## Nits

- **Nit**: `externalAccount` returns a richer value than either caller uses (the
  no-account vs account-without-field distinction). Harmlessly collapsed by each
  caller's `?? null`, so behavior is identical. Worth a one-line comment on the
  helper noting callers collapse both to null (the plan's doc comment already
  gestures at this).
- **Nit**: the optional `clerk.test.ts` is the only direct test of the new seam;
  the google/github tests cover it end-to-end. Recommend keeping the two-case
  helper test (match → `{username,email}`; no match → null) since it is the new
  public surface, but it is not required for correctness.

## Summary counts

- Construction sites: 4 across 3 files (google ×2, github ×1, admin ×1) — matches.
- External-account lookups collapsed: 2 (google email, github username) — matches.
- Distinct log events preserved: 2 (`google_email_unavailable`,
  `github_token_unavailable`).
- Paths left on factory-only (no helper): 2 (google OAuth token, admin roster).
- Blockers: 0. Concerns: 0. Nits: 2.
