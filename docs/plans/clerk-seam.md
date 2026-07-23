# Plan — Shared `clerk.ts` seam (architecture-review finding #5)

## Goal

`apps/agent-api` duplicates `createClerkClient(...)` construction and
external-account/provider-token lookup across the google-token, github-token, and
admin-users paths. Introduce a small shared `clerk.ts` seam: one Clerk client
construction plus an `externalAccount(provider)` (or equivalent) helper, and
route the 3 paths through it. Keep the public interface small; hide the Clerk
client + provider-token-lookup details. Preserve behavior exactly.

## Findings

Clerk backend client (`@clerk/backend`, `createClerkClient`) is constructed in
**4 places across 3 files**, always with the same two env vars. Two of those
sites also duplicate the same external-account lookup (`getUser` then
`externalAccounts.find(a => a.provider.includes(X))`).

Note: `routes/clerk-webhook.ts` uses `verifyWebhook` from
`@clerk/backend/webhooks` — a different concern (Svix signature verification),
**not** `createClerkClient`. It is out of scope for this seam.

Call-site table:

| File / fn | Client construction | Lookup | Provider | User id | Clerk API | Error handling |
|---|---|---|---|---|---|---|
| `google-token.ts` `getGoogleAccessToken` | `createClerkClient({ secretKey: CLERK_SECRET_KEY, publishableKey: CLERK_PUBLISHABLE_KEY })` | OAuth token, not external account | `"google"` | `clerkUserId` arg | `users.getUserOauthAccessToken(id, "google")` → `.data[0]?.token ?? null` | own `try/catch`, logs `google_token_unavailable`, returns null, never throws |
| `google-token.ts` `getGoogleAccountEmail` | same | external account | matches `"google"` (`provider.includes`) | `clerkUserId` arg | `users.getUser(id)` → `externalAccounts.find(...).emailAddress ?? null` | own `try/catch`, logs `google_email_unavailable`, returns null, never throws |
| `github-token.ts` `getGithubUsername` | same | external account | matches `"github"` (`provider.includes`) | `clerkUserId` arg | `users.getUser(id)` → `externalAccounts.find(...).username ?? null` | **no local catch**; callers (`getGithubInstallationStatus` / `getGithubInstallationToken`) wrap the whole flow in `try/catch`, log `github_token_unavailable` |
| `admin-users.ts` `clerkClient()` (used by `listClerkUsers` + `getClerkUser`) | same, already factored into a private `clerkClient(env)` | user roster, not provider lookup | — | list: none; single: `userId` arg | `users.getUserList({ limit, offset })` (paged, 500 cap) and `users.getUser(id)` → `toIdentity` | `listClerkUsers`: none (propagates); `getClerkUser`: bare `catch` → null |

What collapses:

- **4 client-construction sites → 1** factory.
- **2 external-account lookups → 1** helper (google email + github username).

What is genuinely different and must **not** be flattened:

- **Google OAuth token** (`getUserOauthAccessToken`) is a distinct Clerk API, not
  an external-account read. Single caller. Shares the client factory only.
- **Admin roster** (`getUserList` paging + `toIdentity`, and `getUser` +
  `toIdentity`) is a different operation. Admin-specific logic (pagination past
  the 500 cap, primary-email selection) stays in `admin-users.ts`. Shares the
  client factory only.
- **Error/logging conventions differ per site** (three distinct log events;
  github lets the lookup throw and catches around the whole flow). The seam must
  preserve these by keeping `try/catch` + logging at the call sites.

## Seam design

New file: `apps/agent-api/src/clerk.ts`. Deep-modules category: **true external
(Clerk)** — but a single production adapter is enough; callers are already
mockable at `@clerk/backend`'s module boundary (see Test impact), so **do not
introduce a port**. This is an in-process consolidation of construction +
one lookup, nothing more.

Small public interface (two exports):

```ts
import { createClerkClient } from "@clerk/backend";
import type { Env } from "./types";

// The one place that knows which env vars build a Clerk backend client.
export const clerkClient = (env: Env) =>
  createClerkClient({
    secretKey: env.CLERK_SECRET_KEY,
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
  });

// Find a user's connected external account for a provider ("google", "github").
// Returns the normalized fields both callers need, or null when the user has no
// matching account. Does NOT catch: callers keep their own error/logging
// conventions (google logs + returns null; github lets its outer flow catch).
export const externalAccount = async (
  env: Env,
  clerkUserId: string,
  provider: string,
): Promise<{ username: string | null; email: string | null } | null> => {
  const user = await clerkClient(env).users.getUser(clerkUserId);
  const account = user.externalAccounts.find((a) => a.provider.includes(provider));
  if (!account) return null;
  return {
    username: account.username ?? null,
    email: account.emailAddress ?? null,
  };
};
```

What it hides: the `secretKey`/`publishableKey` wiring, and the
`getUser` + `externalAccounts.find(provider.includes(...))` shape. What it does
**not** hide/own: per-site error handling and logging (stays at call sites), the
google OAuth-token API, and the admin roster/pagination logic.

Handling the differences:
- **Provider match** stays `provider.includes(provider)` verbatim (matches
  `oauth_google` / `oauth_github`), so passing `"google"` / `"github"` preserves
  behavior.
- **Google token path** keeps `getUserOauthAccessToken` inline, only swapping its
  `createClerkClient({...})` for `clerkClient(env)`. Single caller, so no helper
  (one-caller = hypothetical seam).
- **Admin-users** deletes its private `clerkClient` and imports the shared one;
  `listClerkUsers` / `getClerkUser` / `toIdentity` are otherwise untouched.
- **Error handling preserved** by keeping `try/catch` + `log(...)` exactly where
  they are today; `externalAccount` never catches.

## Exact edits

1. **Add** `apps/agent-api/src/clerk.ts` with `clerkClient` and `externalAccount`
   as above.

2. **`google-token.ts`**
   - Replace the `import { createClerkClient } from "@clerk/backend";` with
     `import { clerkClient, externalAccount } from "./clerk";`.
   - In `getGoogleAccessToken`: replace the inline `createClerkClient({...})`
     with `const clerk = clerkClient(env);`. Leave the
     `getUserOauthAccessToken(clerkUserId, "google")` + return + `try/catch` +
     `google_token_unavailable` log unchanged.
   - In `getGoogleAccountEmail`: replace the `createClerkClient({...})` +
     `getUser` + `find(...)` block with
     `const account = await externalAccount(env, clerkUserId, "google");`
     then `return account?.email ?? null;`. Keep the surrounding `try/catch` and
     `google_email_unavailable` log unchanged.

3. **`github-token.ts`**
   - Replace `import { createClerkClient } from "@clerk/backend";` with
     `import { externalAccount } from "./clerk";`.
   - Replace the body of `getGithubUsername` with
     `const account = await externalAccount(env, clerkUserId, "github"); return account?.username ?? null;`
     (no local `try/catch` — unchanged from today; outer flows still catch and
     log `github_token_unavailable`). The app-JWT / installation / mint helpers
     are untouched.

4. **`admin-users.ts`**
   - Replace `import { createClerkClient } from "@clerk/backend";` with
     `import { clerkClient } from "./clerk";` (keep
     `import type { User } from "@clerk/backend";`).
   - Delete the local `const clerkClient = (env) => createClerkClient({...})`.
   - `listClerkUsers` and `getClerkUser` already call `clerkClient(env)`; they now
     resolve the shared import. `CLERK_PAGE_SIZE`, `toIdentity`, paging, and the
     `getClerkUser` bare-`catch` stay unchanged.

## Test impact

Existing tests stay green **without change**:

- `google-token.test.ts` and `github-token.test.ts` both do
  `vi.mock("@clerk/backend", () => ({ createClerkClient: () => ({ users: { getUser } } ) }))`.
  Because `clerk.ts` imports `createClerkClient` from the same module, the
  module-level mock still applies through `clerkClient` / `externalAccount`.
  `getUser` returns the same `externalAccounts` fixtures; `externalAccount`
  reads `.username` / `.emailAddress` exactly as the old inline code did.
- `github-token.test.ts` also mocks `getUserOauthAccessToken`? No — it only
  needs `getUser`; google's token test does not exercise `getGoogleAccessToken`
  against the mock (it only tests `getGoogleAccountEmail` + `memoizeTokenProvider`).
  Unaffected.
- `routes/admin.test.ts` mocks `../admin-users` and `../github-token` wholesale;
  the shared client factory is never reached. Unaffected.

New test (light, optional but recommended by deep-modules — the new helper is the
test surface): `apps/agent-api/src/clerk.test.ts` mocking `@clerk/backend`, two
cases for `externalAccount`: (a) returns `{ username, email }` for a matching
provider, (b) returns `null` when no account matches. This documents the seam
directly; the google/github tests remain end-to-end coverage of the wiring.

## Preservation argument

- Same client construction (identical `secretKey`/`publishableKey` from the same
  env vars), now in one place.
- Same provider match (`provider.includes("google"|"github")`), same Clerk APIs
  (`getUser`, `getUserOauthAccessToken`, `getUserList`).
- Same return values: google email `?? null`, github username `?? null`, google
  token `.data[0]?.token ?? null`, admin identities unchanged.
- Same error/logging behavior: every `try/catch` and `log(...)` stays at its
  current call site; `externalAccount` does not catch, so github's throw-then-
  outer-catch flow and google's local-catch flow are both preserved.
- No public function signature changes on the three modules; callers
  (`UserDO.runTurn` wiring, admin routes) are untouched.

## Verification

Per AGENTS.md, run the touched package directly (dev box can't boot `workerd`):

```bash
pnpm --filter @zero/agent-api run test
pnpm --filter @zero/agent-api run lint
pnpm --filter @zero/agent-api run typecheck
```

`workerd`-backed suites (e2e, cross-worker build) run in GitHub Actions CI on
push; nothing in this change touches them.

## Changelog decision

**None.** Purely internal refactor with no user-observable change (AGENTS.md:
refactors get no entry). Confirmed: no behavior, capability, or message change.

## Skills to use

- `deep-modules` — when shaping `clerk.ts` (keep the interface small; don't add a
  port for a single production adapter).
- `code` — executing the edits.
- `git-commit` — committing.

## Acceptance criteria

- `apps/agent-api/src/clerk.ts` exists with exactly `clerkClient(env)` and
  `externalAccount(env, clerkUserId, provider)`.
- `createClerkClient` is imported/called in **one** file (`clerk.ts`); grep of
  `apps/agent-api/src` shows no other `createClerkClient` construction (webhook's
  `verifyWebhook` excluded).
- `google-token.ts`, `github-token.ts`, `admin-users.ts` route through the seam;
  their public function signatures and error/log behavior are unchanged.
- `pnpm --filter @zero/agent-api run test`, `lint`, and `typecheck` pass.
- Existing google-token / github-token / admin tests pass unmodified; optional
  `clerk.test.ts` covers `externalAccount` match + null.
- No changelog entry.
