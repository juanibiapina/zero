# Plan: Rebrand web app browser titles to the unified "Zero" brand

## Goal

Replace the user-visible one-word product names `ZeroVault` and `ZeroErrors` in
the browser tab titles of the two SaaS web apps with the unified "Zero" brand,
without touching any string that identifies production infra or API contracts.

This completes the visible-branding side of the earlier unification work (the
2026-07-21 changelog entry: "Vault and Errors now share the Zero brand and a
product switcher"). The in-app `AppLayout` brand is already `"Zero"` (set in each
app's `main.tsx`); the browser tab titles are the last remaining old-brand
strings a user can see.

## Research findings

`rg -n "ZeroVault|ZeroErrors" apps/vault-web apps/errors-web packages/ui` returns
exactly two hits, both `<title>` tags:

- `apps/vault-web/index.html:6` → `<title>ZeroVault</title>`
- `apps/errors-web/index.html:6` → `<title>ZeroErrors</title>`

Both `index.html` files are minimal (charset, viewport, title, root div, module
script). Confirmed absent in both web apps:

- No `public/` directory.
- No web manifest / `manifest.webmanifest`.
- No `<meta name="description">`, no Open Graph (`og:`) or Twitter card tags.
- No hardcoded brand text in any component or page. The only "Zero" brand string
  in source is the already-correct `AppLayout` brand prop:
  - `apps/vault-web/src/main.tsx:27` → `brand={{ name: "Zero", icon: Shield, ... }}`
  - `apps/errors-web/src/main.tsx:22` → `brand={{ name: "Zero", icon: Bug, ... }}`

So the entire change is two lines.

### OUT OF SCOPE — confirmed no overlap

The two `<title>` tags are plain display text and share nothing with the infra /
contract identifiers. None of the following are touched, and none appear in the
two web apps' `index.html`:

- Worker names `zerovault-api` / `zeroerrors-api`.
- KV namespace ids, Durable Object class names.
- The `zerovault-cli` package name and its npm identity (`packages/zerovault-cli`).
- API endpoints / hosts (`zerovault.` / `zeroerrors.juanibiapina.dev`) in
  `api.ts` base URLs and `apps/agent-api` `zero-errors.ts` ENDPOINT.
- Env var names (`VITE_CLERK...`, `ZEROVAULT_API_URL`), ZeroVault secret project
  names (`zero-api`, `zero-web`).
- Docs, `apps/*-api`, `packages/errors-core`, `packages/vault-core`,
  `packages/auth`, `bin/` scripts.

A repo-wide `rg` shows every other `ZeroVault`/`ZeroErrors` hit lives in those
out-of-scope locations. The change surface (two `index.html` display titles) does
not intersect any of them.

## Title convention

Recommended: **`Zero Vault`** and **`Zero Errors`** (brand word, space, product
word).

Justification:

- Brand-first matches the `AppLayout` brand `"Zero"`, so tab and in-app header agree.
- The **space** is the whole point: it separates the new unified brand `Zero`
  from the old single-word product names `ZeroVault`/`ZeroErrors`, so the tab no
  longer reads as the retired brand.
- Fully ASCII, no punctuation ambiguity, reads naturally in a narrow browser tab.

Rejected alternatives:

- `Zero — Vault` / `Zero — Errors`: the em dash character is banned by the repo
  `AGENTS.md` communication rule. Do **not** use `—`.
- `Zero - Vault` (ASCII hyphen with spaces): acceptable and ASCII-safe, but noisier
  than a plain space for a two-word tab title. Use only if a separator is later
  wanted for consistency with a pattern like `Product - Zero`.
- `Vault · Zero` / `Vault — Zero`: the middot `·` and em dash `—` are non-ASCII /
  banned. Skip.

If the implementer prefers a visible separator, the only approved ASCII fallback
is `Zero - Vault` / `Zero - Errors` (hyphen, not em dash). Primary recommendation
stays `Zero Vault` / `Zero Errors`.

## What to change

| File | Line | From | To |
|---|---|---|---|
| `apps/vault-web/index.html` | 6 | `<title>ZeroVault</title>` | `<title>Zero Vault</title>` |
| `apps/errors-web/index.html` | 6 | `<title>ZeroErrors</title>` | `<title>Zero Errors</title>` |

No other files change.

## Tests to add or update

None. There are no title assertions in the web apps' test setup, and the change
is static HTML text. Verification is by build + inspection (below).

## Docs to add or update

None beyond the changelog entry.

## Changelog

The browser tab title is user-visible, so it warrants an entry. Match the repo's
flat dated format in `CHANGELOG.md` (`- YYYY-MM-DD: ...`, most recent first),
written from the user's perspective:

```
- 2026-07-22: The Vault and Errors browser tabs now read "Zero Vault" and "Zero Errors", matching the unified Zero brand.
```

Add it as the top bullet under the intro line. Commit it with the code change,
not as a follow-up.

## Skills to use

- `changelog` — when writing the CHANGELOG entry (flat dated format, user-facing wording).
- `git-commit` — when committing the two title edits plus the changelog together.

## Verification

Per-package, for each of `vault-web` and `errors-web`:

```bash
pnpm --filter @zero/vault-web run typecheck
pnpm --filter @zero/vault-web run lint
pnpm --filter @zero/vault-web run build
pnpm --filter @zero/errors-web run typecheck
pnpm --filter @zero/errors-web run lint
pnpm --filter @zero/errors-web run build
```

(These web packages do not depend on `workerd`, so they run locally despite the
`workerd` limitation noted in `AGENTS.md`.)

The title is verifiable in the built output: after `build`, Vite copies
`index.html` to `dist/index.html` with the title intact. Confirm:

```bash
rg -n "<title>" apps/vault-web/dist/index.html apps/errors-web/dist/index.html
# expect: Zero Vault  /  Zero Errors
```

A final `rg -n "ZeroVault|ZeroErrors" apps/vault-web apps/errors-web packages/ui`
must return no matches, confirming the visible brand strings are gone from the
web apps while all infra identifiers elsewhere are untouched.

## Acceptance criteria

- `apps/vault-web/index.html` title reads `Zero Vault`; `apps/errors-web/index.html`
  title reads `Zero Errors`.
- No em dash characters introduced anywhere.
- No changes to any out-of-scope infra/contract identifier (worker names, hosts,
  env vars, KV/DO ids, `zerovault-cli`, `apps/*-api`, `*-core`, docs).
- `rg "ZeroVault|ZeroErrors" apps/vault-web apps/errors-web packages/ui` returns nothing.
- Both web packages pass typecheck, lint, and build; built `dist/index.html`
  shows the new titles.
- CHANGELOG has the new dated, user-facing bullet, committed with the code.
```
