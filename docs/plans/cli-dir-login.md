# Per-directory sign-in for the `zero` CLI

Shipped 2026-08-15. Why the design is what it is, and what was measured.

## Problem

A `zero login` was machine-wide: one sign-in per API origin, stored under the
origin key in `~/.config/zero/config.json`. A project belonging to another
organization had only one workaround, an API key in a context or in the
environment, which is the credential shape the browser sign-in exists to avoid.

Contexts already bound a directory to a credential (`dirContexts`, nearest
ancestor wins), but a context could only hold an API key.

## Shape

- A login's organization is fixed at sign-in. Clerk puts `org_id` in the token
  from the consent screen, and `apps/vault-api` routes every Durable Object by
  it. Nothing can re-scope an existing token, so a second organization requires
  a second sign-in — hence storage keyed by origin **and** org.
- `logins` is keyed by `loginKey(baseUrl, orgId?)`: the bare origin for the
  machine-wide sign-in (unchanged, so old config files keep working with no
  migration), `origin#org_…` for one a directory picked.
- `Context` became a union: `KeyContext` (`apiKey`) or `LoginContext`
  (`login.orgId`). The context stores only the org, never the credential: a
  login rotates on refresh, and several contexts may name the same one.
- A login context resolves at the **same precedence slot as a context key**,
  above `ZERO_API_KEY`. A directory binding is a deliberate per-project choice
  and the env var is ambient; the cost of the wrong call is a write to the wrong
  organization. `--api-key` still overrides everything.
- A login context whose sign-in is missing **stops the command**. Falling back
  to the machine sign-in would run against a different organization than the
  directory asked for, which is the exact failure the feature removes. This is
  why `requireAuth` answers login contexts before the GitHub Actions branch too.
- `ResolvedAuth.loginKey` records where a login came from. Refresh tokens rotate
  and a replay revokes the family, so the rotated pair must be written back to
  the key it was read from, never to an assumed bare origin.
- `zero logout` and `zero context remove` act on the credential the directory
  actually uses, and `remove` revokes the sign-in it drops unless another
  context still names it. A sign-in reachable only through a removed context
  would otherwise stay live and invisible.

## Kept out

- No `zero login --here` (sign in and bind in one step). Two commands, one of
  which already existed, and the binding is worth being explicit about.
- No org switcher inside one token. Not possible: see above.
- No change to `ZERO_API_KEY` support. It remains the fallback for machines with
  no browser and no config; the docs stopped presenting it as the laptop path.

## Measured

- Clerk's consent screen offers the session's **active** organization. A second
  `zero login` can therefore return the same org as the first. The CLI prints a
  warning naming the org and pointing at the dashboard's organization switcher
  rather than silently storing a duplicate.

## Tests

`packages/zero-cli/src/config.test.ts` covers precedence and the no-fallback
rule as pure functions. `src/commands/login.test.ts` drives the real binary in a
bound temp directory against a stub that plays both the API and the identity
provider: directory vs machine org, subdirectories, `ZERO_API_KEY` not winning,
`--api-key` still winning, the missing-sign-in error, rotation written to the
org key, and logout/remove scope.
