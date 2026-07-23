# Plan: Switch ZeroVault CLI default API URL to the canonical console host

## Goal

The ZeroVault CLI (`zv`) must default to the **new canonical host**
`https://vault.apps.juanibiapina.dev` instead of the old
`https://zerovault.juanibiapina.dev`. Running `zv` with only `ZEROVAULT_API_KEY`
set must hit `https://vault.apps.juanibiapina.dev` by default, while
`ZEROVAULT_API_URL` (and `--base-url` / a context `baseUrl`) still override it.
After the change, republish the CLI as `0.2.1` and pin the docs to it.

## Why (decision + evidence)

Aligning the CLI default to the new canonical host is prerequisite work for
retiring the old domain in a separate follow-up task.

- The `vault-api` worker is bound to **two** live custom domains:
  `zerovault.juanibiapina.dev` (old) and `vault.apps.juanibiapina.dev` (new
  canonical). Both route to the same worker; both return `401` on `/v1/whoami`
  with an invalid key (live-verified).
- `vault.apps.juanibiapina.dev` is the mandated console host: it is a subdomain
  of the Clerk primary domain `apps.juanibiapina.dev`, which the console auth
  setup requires (see `docs/console-auth.md`).
- The CLI currently defaults to the old host at
  `packages/zerovault-cli/src/index.ts` (`DEFAULT_BASE_URL`).
- `vault-web` uses same-origin relative paths, so no web change is needed.
- The old domain will be retired entirely in a **separate follow-up task**. Do
  not attempt a repo-wide purge of `zerovault.juanibiapina.dev` mentions here;
  only fix docs describing the CLI default/usage.

The client appends versioned paths (e.g. `/v1/whoami`) to the base URL, so the
default must be the bare origin with no `/api` or `/v1` suffix.

## What to change and why (all required)

### 1. Change the CLI default base URL

- In `packages/zerovault-cli/src/index.ts`, change
  `const DEFAULT_BASE_URL = "https://zerovault.juanibiapina.dev";` to
  `"https://vault.apps.juanibiapina.dev"`. This is passed as `defaultBaseUrl`
  into `resolveAuth()` in `getClient()`; the precedence logic (`--base-url >
  context.baseUrl > ZEROVAULT_API_URL env > defaultBaseUrl`) is already correct
  and unit-tested, so only the constant changes.

### 2. Fix the stale version string and bump the package

- In `packages/zerovault-cli/src/index.ts`, change `.version("0.1.0")` to
  `.version("0.2.1")` so `zv --version` matches the package.
- Bump `packages/zerovault-cli/package.json` `version` from `0.2.0` to `0.2.1`
  (an existing npm version cannot be republished).

### 3. Update the unit test for the new default

- In `packages/zerovault-cli/src/config.test.ts`, the `resolveAuth` precedence
  suite uses a synthetic `DEFAULT = "https://default"` and does not assert the
  production host, so the existing fallback and override-precedence cases stay
  as-is (keep them).
- Add a case that pins the **production default** wired in `index.ts`: assert
  that when no flag/context/env base URL is supplied, the resolved base URL is
  `https://vault.apps.juanibiapina.dev`. The cleanest way is to import
  `DEFAULT_BASE_URL` from `index.ts` (export it if not already) or add a small
  test that constructs `resolveAuth` with `defaultBaseUrl:
  "https://vault.apps.juanibiapina.dev"` and asserts the fallback returns that
  host. Prefer importing the real constant so the test breaks if the default
  regresses. If any existing assertion references the old
  `zerovault.juanibiapina.dev` default, update it to the new host.

### 4. Update the docs (CLI default/usage only)

- Root `AGENTS.md` (Secrets paragraph, line ~106): pin
  `pnpm dlx zerovault-cli@0.1.0` → `@0.2.1`; state that only `ZEROVAULT_API_KEY`
  is required and `ZEROVAULT_API_URL` is **optional** (defaults to
  `https://vault.apps.juanibiapina.dev`, only needed to target another
  instance).
- `docs/secrets.md`:
  - Bump every `zerovault-cli@0.1.0` occurrence (alias + all examples) to
    `@0.2.1`.
  - In the Prerequisites list, present `ZEROVAULT_API_URL` as optional
    (defaults to `https://vault.apps.juanibiapina.dev`) rather than required.
  - Replace `zerovault.juanibiapina.dev` references that describe the **CLI
    default/usage** with `vault.apps.juanibiapina.dev`. Leave unrelated mentions
    (e.g. the web portal link, general prose) for the separate domain-retirement
    task; scope this edit to the CLI default/usage.

### 5. Changelog entry (required)

Vault CLI is part of the console/vault product, so the entry goes in the **root
`CHANGELOG.md`**. That file uses a **flat `- YYYY-MM-DD:` list, most recent
first** — follow that existing style and ignore any Keep-a-Changelog scaffolding
the `changelog` skill suggests. Add at the top of the list:

```
- 2026-07-23: The ZeroVault CLI now defaults to the canonical host
  vault.apps.juanibiapina.dev, so you only need ZEROVAULT_API_KEY set;
  ZEROVAULT_API_URL is optional and only needed to target another instance.
```

Use the actual implementation date and keep it to the flat single-entry style
(user-facing, no module/function names).

### 6. Republish to npm

- Build and publish `0.2.1` from `packages/zerovault-cli`:
  ```bash
  cd packages/zerovault-cli && pnpm build && npm publish
  ```
- Run `npm publish` **only if npm credentials are available**. If they are not,
  flag this clearly in the final report, leave the built tarball in place
  (`pnpm build` output / `npm pack`), and hand off the publish step. Note that
  `0.2.1` cannot be published twice — if a publish half-completes, the next
  attempt needs a fresh version bump.

## Tests to add or update

- `packages/zerovault-cli/src/config.test.ts` — keep the fallback +
  override-precedence cases; add/adjust one case asserting the new default is
  `https://vault.apps.juanibiapina.dev` (per step 3).

## Docs to add or update

- Root `AGENTS.md` — Secrets paragraph (pin `@0.2.1`, env var wording, host).
- `docs/secrets.md` — alias, examples, env-var list, CLI-default host.
- Root `CHANGELOG.md` — the flat entry above.

## Skills to use

- `changelog` — before editing `CHANGELOG.md`; follow the file's existing flat
  style, not the skill's Keep-a-Changelog scaffolding.
- `git-commit` — when committing; keep code, test, docs, and changelog in one
  commit.

## Acceptance criteria

- Unit tests pass: `pnpm --filter zerovault-cli test`.
- The CLI default base URL is `https://vault.apps.juanibiapina.dev` (asserted by
  a unit test).
- `zv --version` reports `0.2.1` (matches `package.json`).
- Setting `ZEROVAULT_API_URL` (or `--base-url`, or a context `baseUrl`) still
  overrides the default.
- Root `AGENTS.md` and `docs/secrets.md` pin the CLI to `@0.2.1`, present
  `ZEROVAULT_API_URL` as optional, and describe the CLI default host as
  `vault.apps.juanibiapina.dev`.
- Root `CHANGELOG.md` has a dated, user-facing entry in the flat style.
- `0.2.1` is published to npm, or the publish is clearly flagged as blocked on
  credentials with the tarball built.

## How to verify locally

```bash
# unit tests (new default + fallback + override precedence)
pnpm --filter zerovault-cli test

# build and confirm the version + default host without hitting prod:
cd packages/zerovault-cli && pnpm build
node dist/index.js --version          # -> 0.2.1

# prove the default host is used when the env var is unset (invalid key is fine;
# a 401 from vault.apps.juanibiapina.dev proves the new default):
env -u ZEROVAULT_API_URL ZEROVAULT_API_KEY=dummy node dist/index.js whoami
#   -> a connection/401 against vault.apps.juanibiapina.dev proves the change.
#      A hit against zerovault.juanibiapina.dev would mean the change failed.

# optional live probe with a real key:
env -u ZEROVAULT_API_URL ZEROVAULT_API_KEY=<real-key> node dist/index.js whoami
```

After publishing:

```bash
env -u ZEROVAULT_API_URL ZEROVAULT_API_KEY=<real-key> \
  pnpm dlx zerovault-cli@0.2.1 whoami
```

## Risks and notes

- Only the `DEFAULT_BASE_URL` constant changes behavior; the precedence logic is
  unchanged, so override paths (env/flag/context) keep working. Guard against
  regression with the new unit assertion.
- Do **not** purge `zerovault.juanibiapina.dev` repo-wide — full domain
  retirement is a separate task. Scope doc edits to the CLI default/usage.
- Publishing needs npm credentials. If unavailable, ship the code/docs/changelog
  and flag the publish as blocked; `0.2.1` cannot be reused once published.
