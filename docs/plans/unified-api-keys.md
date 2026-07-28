# Plan: unified API keys in the console

## Goal

A signed-in user finds API key management in one product-neutral place in the
Zero console, reachable in one click from either ZeroVault or ZeroErrors, and
the page itself says what the key is (organization-scoped, works for both
products). No user, doc, or skill ever again has to say "go to ZeroVault to get
a key for ZeroErrors".

## Background (verified, not assumed)

Everything below was read in the current checkout (`main`, up to date with
`origin/main`).

**The key surface is already unified everywhere except the console IA.**

- `apps/vault-api/src/OrgDO/index.ts` stores keys per **organization** (Clerk
  org id), writes `{ v: 2, orgId, userId }` to the `APIKEYS` KV namespace.
- `packages/auth/src/index.ts` (`validateApiKey`) is the shared front door.
  `apps/vault-api/src/dashboard-app.ts` runs it for both `/vault/v1/*` and
  `/errors/v1/*`. One `zv_…` key already authorizes both products.
- `apps/vault-api/src/routes/keys.ts` serves create/list/revoke at
  `/vault/v1/keys` (API key auth, used by `zv keys`) and `/api/vault/keys`
  (Clerk JWT auth, used by the console).
- `apps/landing/src/pages/index.astro` already sells the unified story: the hero
  reads "One API key. Every Zero product.", and both CTA buttons link to
  `https://dash.zeroapps.dev/vault/keys`. The landing page promises unity and the
  link lands the user inside Vault.

So this is a front-end information-architecture change. The data model, the KV
value, the DO, and both HTTP surfaces stay exactly as they are.

**Console shape today.**

- `apps/dashboard-web/src/main.tsx` builds the whole router inline. Two
  `AppLayout` instances: a `vault` shell (`navItems`: Projects, API Keys) and an
  `errors` shell (`navItems`: Issues). `/` redirects to `/vault/projects`, and
  both sign-in and sign-up use `/vault/projects` as the redirect target.
- `packages/ui/src/components/AppLayout.tsx` is the shared shell. Desktop rail
  (`hidden md:flex md:w-60`) stacks four bordered regions: brand link (`h-14`,
  `border-b`), product switcher block (`border-b`, `p-2`), product nav
  (`flex-1`, `p-2`), and a hardcoded Docs link foot (`mt-auto`, `border-t`,
  external, with an `ExternalLink` icon). Below `md` the rail is replaced by a
  top bar (brand + native `<select>` product switcher) and a horizontal
  `overflow-x-auto` nav strip.
- Active nav state is `location.pathname.startsWith(item.to)` plus
  `bg-accent text-accent-foreground` on a ghost `Button`. The current product row
  in the switcher renders as an inert `<span aria-current="page">`; the other
  renders as a `Link`.
- `showSelector = products !== undefined && currentProductId !== undefined`, so
  today a shell without a current product would silently hide the switcher.
- `apps/dashboard-web/src/products/vault/pages/KeysPage.tsx` holds the page;
  `apps/dashboard-web/src/products/vault/lib/api.ts` holds
  `createApiKey`/`listApiKeys`/`revokeApiKey` next to the projects, environments,
  and secrets calls. `ApiKeyInfo` / `ApiKeyCreated` types come from
  `@zero/vault-core`.
- `apps/vault-api/wrangler.jsonc` sets `not_found_handling:
  "single-page-application"`, and `apps/vault-api/src/worker.ts` sends every
  non-`/api/`, non-`/ping` dashboard path to `env.ASSETS`. Any new client route
  works with no worker change.

**Recent work to preserve.**

- Deep links from empty states to the docs (KeysPage empty state and the
  post-create banner both link to `docs.zeroapps.dev/vault/loading-secrets/`;
  ProjectsPage and IssuesPage link to their getting-started guides). Keep the
  pattern and keep a loading-secrets link on the keys page; add the errors side
  rather than replacing it.
- The docs were just made platform-neutral (Cloudflare Workers demoted to one
  optional guide). Do not reintroduce Cloudflare-first phrasing.
- `apps/dashboard-web` has a vitest + jsdom harness (`vitest.config.ts`,
  `src/test/setup.ts`, `ProjectsPage.test.tsx`) with a working pattern for
  mocking `@clerk/clerk-react` with stable hook return values.

**Current shipped user-facing key-acquisition paths.**

Everything in this table is live product surface a key seeker can hit today, and
every row is in scope. Historical records (`docs/plans/agent-skills.md`,
`docs/plans/docs-content-getting-started.md`) and internal implementation
comments (`packages/auth/src/index.ts`, `docs/zeroerrors/design.md`) also mention
the old Vault-owned framing. They are not acquisition instructions, nobody reads
them to get a key, and rewriting history is not a goal. Leave them.

| File | What it says |
|---|---|
| `apps/dashboard-web/src/main.tsx` | "API Keys" sits in the Vault nav |
| `apps/landing/src/pages/index.astro` | one `keysUrl` constant, `https://dash.zeroapps.dev/vault/keys`, used by two CTAs |
| `packages/zerovault-cli/src/index.ts` | the no-key error says "See https://docs.zeroapps.dev/vault/getting-started/ to create one." |
| `apps/docs/.../index.mdx` | "Keys are managed in one place, under **ZeroVault → API Keys**" |
| `apps/docs/.../vault/getting-started.mdx` | step 4 "Create an API key" |
| `apps/docs/.../vault/overview.md` | "Where things live" lists keys under the Vault dashboard |
| `apps/docs/.../vault/cli.mdx` | "Create one in the dashboard under **ZeroVault → API Keys**" |
| `apps/docs/.../errors/getting-started.mdx` | step 1 links into the Vault guide anchor |
| `apps/docs/.../errors/overview.md` | a whole section titled "Keys come from ZeroVault" |
| `zero-skills:zerovault/SKILL.md` | "Create your first key in the dashboard (dash.zeroapps.dev -> **ZeroVault -> API Keys**)" |
| `zero-skills:zeroerrors/SKILL.md` | "ZeroErrors has no key page of its own… create it in the ZeroVault console" |

The CLI row is the one an earlier draft of this plan got wrong. It argued the
string could stay because `vault/getting-started/` remains a valid page. It does
remain valid, but that is not the test: the string is the first thing a user
sees when `zv` has no key, and it drops them on a page titled "Getting started
with ZeroVault" where they have to find step 4. That is the exact detour the
Goal removes, in the highest-intent moment there is. It changes. See step 5.

The general `zv --help` link to `docs.zeroapps.dev/vault/cli/` stays: it is the
CLI reference, not a key-acquisition path.

## Decision 1: where the key surface lives

### Options considered

**A. Left-rail item in an account section, below the product nav** (the
recommendation). The rail gains a fifth region between the product nav and the
Docs foot: a divider, a small section label, and an "API keys" row.

**B. Clerk `UserButton` account popover / custom user-profile page.** Rejected on
semantics: keys are organization-scoped, not user-scoped. The console already has
a separate `OrganizationSwitcher`, so hanging org resources off the personal
avatar menu teaches the wrong model, and switching orgs changes the key list.
Also, it buries a first-run onboarding step behind an avatar with no label, which
is the discoverability complaint that started this task, and it wants a modal for
a create/revoke table.

**C. Clerk `OrganizationProfile` custom page** (keys inside the org switcher's
profile modal). Correct on scope, still wrong on discoverability and still a
modal. A create-once, copy-once secret reveal inside a Clerk-owned modal is a
bad place for the one string the user must not lose.

**D. A `/settings` section with its own nav.** Right shape for a console with
five settings pages. Today it would be one page behind a container page, so the
user pays an extra click and an extra empty screen for structure that does not
exist yet. Option A upgrades into this cleanly later (the account section grows
items; if it passes four, promote it to its own section).

**E. Duplicate an "API keys" entry in both product navs.** Cheapest, and it
solves discoverability, but it keeps saying keys are per-product, doubles the
active-state logic, and leaves two entry points to one page. This is the option
to fall back to only if the rail restructure turns out to be risky, which it is
not.

### Recommendation: A, with the section owned by the shared shell

Put the account section in `AppLayout` (as one new optional prop), not in each
app's `navItems`. If it were a `navItems` entry, it would render inside the
product nav group, look like a product page, and be duplicated per shell where it
can drift. As a shell-owned region it gets one definition, one active state, one
mobile behavior, and it visually sits outside the products.

### Exact rail, top to bottom (desktop, `md` and up)

1. **Brand.** `h-14`, `border-b`. Per-shell, unchanged on the two product
   shells. See Decision 1b.
2. **Product switcher.** Unchanged block: Vault (Shield), Errors (Bug). On the
   keys route **no row is highlighted** and both rows are links. That absence is
   the signal that keys are not a product.
3. **Product nav.** `flex-1`. Vault: Projects only (API Keys leaves). Errors:
   Issues. On the keys route this region is empty and acts as the spacer.
4. **Account section (new).** `border-t p-2`. A label row, then the item:
   - Label: `Account`, `px-3 py-1 text-xs font-medium text-muted-foreground`,
     not uppercase, not letter-spaced.
   - Item: `API keys`, lucide `Key` icon, same ghost `Button` + `Link` markup and
     the same `bg-accent text-accent-foreground` active treatment as the product
     nav, so the row vocabulary stays identical across the rail. Add
     `aria-current="page"` when active (the product switcher already does this;
     the nav rows do not, so this is a small a11y gain).
5. **Docs foot.** Unchanged.

Label wording: `Account`, and the same word in the mobile product `<select>`
placeholder and as the docs sidebar group. One term for one section beats a more
precise term that changes between viewports.

`Organization` was the first choice, because keys are org-scoped and `KeysPage`
already refetches on `organization?.id`. It loses on two counts. On narrow
widths the section name is rendered inside the product `<select>`, one control
away from Clerk's `OrganizationSwitcher` in the header, so "Organization" reads
as a second org picker. And splitting the term (`Organization` on desktop,
`Account` on mobile, `Account` in the docs) makes the same section answer to
three names.

The cost of `Account` is that it hints at user scope, which is wrong. The page
itself pays that back in the place the user is actually looking: the subhead
reads "Keys belong to your organization." The label is a scan target, not the
scope statement. If the section grows user-scoped items, nothing has to change;
if it grows a second org-scoped item, revisit then.

Keep the divider **and** the label: one item under a bare divider reads as an
accident, and the label is what tells a user why the item moved out of the
product nav.

### Narrow widths (below `md`)

The rail is hidden; the top bar keeps brand + the native product `<select>`, and
the horizontal nav strip keeps the product nav. Append the account items to the
end of that strip, separated by a thin vertical rule
(`mx-1 h-5 w-px shrink-0 self-center bg-border`, `aria-hidden`). One tap, same
order as desktop, no hidden menu. With one or two product items plus one account
item the strip does not need to scroll on a 360px viewport, and it is already
`overflow-x-auto` if it ever does.

Two mobile details to handle:

- The `<select>` has no valid value on the keys route. Render
  `value={currentProductId ?? ""}` and, when there is no current product, prepend
  `<option value="" disabled>Account</option>`, the same word as the desktop
  section label. The user sees the section they are in and can still switch to
  either product.
- Do not render the strip at all when there are no items (guard the empty case),
  otherwise the keys route on a phone would show an empty bordered bar if the
  account section were ever absent.

### Decision 1b: the two product brands stay exactly as they are

An earlier draft dropped the per-shell brand icon everywhere and rendered the
landing-site wordmark (`Zero` plus a trailing period) in all three shells. That
is out of scope and it is dropped. Reasons, all checkable:

- It is a console-wide chrome change on every screen, bought by a task about
  where one page lives. The blast radius is larger than the feature.
- It has no answer for the brand link target. Vault's brand links to
  `/vault/projects` and Errors' to `/errors/issues`
  (`apps/dashboard-web/src/main.tsx:29,40`). One shared brand object would have
  to pick one, or point at `/`, which this plan deliberately leaves Vault-first.
- The visual premise was wrong: the landing wordmark's period is orange
  (`--signal-hot`), not muted (`apps/landing/src/styles/global.css:24,108-109`).

So: Vault keeps Shield, Errors keeps Bug, both keep their own `to`.

The one shell-level change that is actually needed: the account shell has no
honest icon (a `Key` mark under the word `Zero` reads as a third product called
Zero Keys). Make `brand.icon` optional in `AppLayout` and have the account shell
alone pass no icon, rendering the plain `Zero` wordmark, with `to: "/keys"` so
the brand click is a no-op rather than a jump into a product. That is one
optional prop and one `undefined`, and it changes nothing on the two existing
shells. A full wordmark reset is a separate design task.

### Explicitly out of scope

The console-wide brand change (Decision 1b) and any other chrome redesign.

`/`, sign-in, and sign-up all redirect to `/vault/projects`. That is another
Vault-first default, and changing it (to a neutral chooser, or to the last-used
product) is a separate decision with its own UX questions. It does not block this
task: from either product the key surface is now one click away in the rail.
Leave it, and say so in the plan's non-goals rather than silently changing it.

## Decision 2: the keys page itself

Move `KeysPage` to `apps/dashboard-web/src/account/pages/KeysPage.tsx` and its
three API functions to `apps/dashboard-web/src/account/lib/api.ts` (same
endpoints, `/api/vault/keys`). The `ApiKeyInfo` / `ApiKeyCreated` types stay in
`@zero/vault-core`: moving them to `@zero/auth` would make a browser app depend
on a package whose types reference Workers globals (`KVNamespace`), for zero user
benefit. Say this in the module comment so the next reader does not re-litigate
it.

Copy and content, product-neutral throughout. The page never says "Vault".

- **Title:** `API keys` (sentence case, `text-2xl font-bold`, matching the other
  pages' heading treatment).
- **Subhead** directly under it, `text-muted-foreground`, one line, this is where
  the cross-product fact lives:
  "Keys belong to your organization. One key authorizes both Vault and Errors."
- **Create form:** unchanged shape (label input + Create). Add a visually hidden
  `<Label htmlFor="key-label">` wired to a matching `id` on the input, which
  today has a placeholder and no accessible name. The `htmlFor`/`id` pair is the
  part that makes the name real; a visually hidden `<Label>` on its own names
  nothing.
- **Post-create reveal:** keep the panel, the monospace key, the copy button, and
  Dismiss. Changes:
  - Rewrite the current "Copy it now, it won't be shown again" line (which uses
    an em dash) as two sentences: "Copy it now. It is not shown again."
  - Wrap the panel in `role="status"` so the reveal is announced, and move focus
    to the copy button after creation so a keyboard user lands on the one action
    that matters. The copy button is icon-only today
    (`apps/dashboard-web/src/products/vault/pages/KeysPage.tsx:79-81`), so give
    it `aria-label="Copy API key"` in the same edit. Focusing an unnamed control
    announces nothing and makes the new keyboard flow worse than the old one.
  - Two destinations instead of one, since the key now serves both products:
    "Use it with the CLI to [load secrets], or to [send error reports]." linking
    `docs.zeroapps.dev/vault/loading-secrets/` (the existing deep link, kept) and
    `docs.zeroapps.dev/errors/getting-started/`.
- **Empty state:** teach both paths and keep the docs deep links:
  "No API keys yet. A key authorizes the `zv` CLI, your apps, and error
  reporting. See [loading secrets] or [sending errors]." Same link styling as the
  other empty states (`font-medium text-foreground underline underline-offset-2`).
- **Table:** unchanged columns (Key, Label, Created, Actions). Give the icon-only
  revoke button an accessible name (`aria-label={\`Revoke key ${k.prefix}${k.suffix}\`}`).
  One copy change: the fallback for an unlabelled key is an em dash today
  (`apps/dashboard-web/src/products/vault/pages/KeysPage.tsx:137`, `{k.label ||
  "—"}`). Make it `None`. The no-em-dash acceptance criterion covers every
  user-facing string on the page, and a bare dash in a data cell is also worse
  for a screen reader than a word.

No redesign beyond this. The page is already in the house style and the task is
IA, not a visual refresh.

## Decision 3: routes and the old URL

- New route: **`/keys`**. Not `/settings/keys` or `/account/keys`: there is one
  page, and a fake two-level path would have to be renamed the day a real
  settings section appears anyway. Short, guessable, product-neutral.
- Old route `/vault/keys`: keep it as a **client-side redirect**
  (`<Navigate to="/keys" replace />`), kept indefinitely. Reasons: the console is
  behind auth so there is no SEO or crawler cost either way, but the URL is live
  today in the landing page's `keysUrl` (which this change also updates) and in
  whatever bookmarks and chat logs users already have. A one-line route is
  cheaper than one confused user. `replace` keeps the back button sane.
- Declare that redirect as a **root-level route child**, a sibling of the three
  shells, not inside the vault shell:

  ```tsx
  { path: "vault/keys", element: <Navigate to="/keys" replace /> }
  ```

  Nesting it under the vault shell would work only when the shell renders its
  `<Outlet />`, and `AppLayout` gates the outlet on Clerk being loaded **and** an
  active organization (`packages/ui/src/components/AppLayout.tsx:69-83,224`). A
  user with no active org who opens `/vault/keys` would get the Vault
  create-organization prompt with `afterOrgUrl="/vault/projects"` and land back
  in Vault; the promised redirect never mounts. Even with an active org the
  nested version flashes the Vault shell first. At the root the redirect is pure
  routing: no auth gate, no shell, no flash, and it is testable without an
  organization.
- The worker's SPA fallback already serves `index.html` for unknown dashboard
  paths, so `/keys` needs no `apps/vault-api` change.
- **No back-end change.** `/api/vault/keys` (console) and `/vault/v1/keys` (CLI)
  stay. Adding an `/api/keys` alias would add surface with no user-visible
  benefit; renaming the public `/vault/v1/keys` path would break the published
  `zerovault-cli` and needs its own deprecation, out of scope here.

## Implementation steps (commit-sized)

### 1. `feat(ui): give the console rail an account section`

`packages/ui/src/components/AppLayout.tsx`, `packages/ui/src/index.ts`.

- Add one prop: `accountNav?: { label?: string; items: NavItem[] }`. The shell
  owns the region, the divider, the label, active state, and the mobile
  placement; the app supplies only the items.
- Render the desktop region between the product nav and the Docs foot; append the
  items plus a vertical rule to the mobile strip; skip the strip when there are
  no items at all.
- Change `showSelector` to `products !== undefined` and highlight a product row
  only when `product.id === currentProductId`, so a shell with no current product
  still shows the switcher with nothing selected.
- Mobile `<select>`: `value={currentProductId ?? ""}` plus a disabled
  `Account` placeholder option when there is no current product.
- Make `brand.icon` optional; when absent render the brand name with no icon and
  no other styling change (Decision 1b). Product shells keep their icons and
  their own `to`.
- Give every `<nav>` in the shell a **distinct** `aria-label`. Tailwind's `md:`
  classes hide nothing in jsdom, so the desktop rail and the mobile strip both
  render and duplicate names make `getByRole` throw on two matches. Use:
  `"Product"` and `"Account"` for the two desktop rail navs, `"Product and
  account"` for the single combined mobile strip. Every landmark name is then
  unique in the document and tests can scope to one tree without
  `getAllByRole`.
- Export the new prop type from `packages/ui/src/index.ts` if it is named.

### 2. `feat(dashboard-web): move API keys out of Vault`

- Extract the router config from `apps/dashboard-web/src/main.tsx` into
  `apps/dashboard-web/src/routes.tsx` exporting a `routes` array;
  `main.tsx` becomes `createBrowserRouter(routes)`. This is what makes the
  routing behavior testable with `createMemoryRouter`.
- In `routes.tsx`: a shared `accountNav` (`{ to: "/keys", label: "API keys",
  icon: Key }`) passed to all three shells; drop `API Keys` from `vaultNav`; add
  the `/keys` shell (`products={getProducts()}`, no `currentProductId`,
  `navItems={[]}`, `afterOrgUrl="/keys"`, `brand={{ name: "Zero", to: "/keys" }}`
  with no icon) with `KeysPage` as its index child. The Vault and Errors shells
  keep their existing brand objects untouched.
- Add the legacy redirect as a **root-level** child, sibling to the shells:
  `{ path: "vault/keys", element: <Navigate to="/keys" replace /> }`. Not under
  the vault shell (Decision 3).
- Move the page to `src/account/pages/KeysPage.tsx` and the three key functions
  from `src/products/vault/lib/api.ts` to `src/account/lib/api.ts` (delete them
  from the vault module; nothing else imports them, verified).
- Apply the Decision 2 copy, links, and a11y changes.
- Add the tests from the test strategy below.
- Add the root `CHANGELOG.md` bullet in this commit (AGENTS.md: the changelog
  ships with the code, never as a follow-up):
  `- YYYY-MM-DD: API keys now live in their own place in the dashboard sidebar, below the product list, instead of inside ZeroVault. One key still works for both Vault and Errors, and the page now says so. Old links to /vault/keys redirect to /keys.`

### 3. `feat(landing): point the key CTAs at the new page`

`apps/landing/src/pages/index.astro`: the file declares `keysUrl` once (line 6)
and both CTAs (lines 66 and 111) use it, so this is a one-line change to
`https://dash.zeroapps.dev/keys`. No copy change; the hero already says "One API
key. Every Zero product." This touches the `zero-landing` watch path only.

### 4. `docs: make API keys a product-neutral page`

- New page `apps/docs/src/content/docs/account/api-keys.md`, title "API keys",
  the canonical key doc: what a key is, organization scope, that one key
  authorizes both products, create/copy/revoke in the console (**API keys** in
  the sidebar, below the product list), `export ZEROVAULT_API_KEY=…`, rotation
  (revoke then create), and pointers to `zv keys` (CLI), loading secrets, and the
  errors ingest endpoint.
- `apps/docs/astro.config.mjs`: new sidebar group **Account** with that page,
  placed after ZeroErrors and before Skills, mirroring the console rail order.
- `index.mdx`: "Keys are managed in one place, under **API keys** in the
  dashboard sidebar" linking the new page.
- `vault/getting-started.mdx` step 4: keep the `## 4. Create an API key` heading
  (the anchor is linked from the errors guide and possibly elsewhere), change the
  instruction to "Open **API keys** in the sidebar, below the product list", and
  link the account page for the full reference.
- `errors/getting-started.mdx` step 1: stop deep-linking into the Vault guide.
  Give the three-line version (sign in, open **API keys**, Create) and link
  `/account/api-keys/`. This removes the docs-level detour, which is the same bug
  in prose form.
- `errors/overview.md`: replace the "Keys come from ZeroVault" section with an
  "API keys" section pointing at the account page, and drop "there is no separate
  key page for ZeroErrors".
- `vault/overview.md` "Where things live": the Vault dashboard bullet lists
  projects, environments, and secrets; add a keys bullet pointing at
  `dash.zeroapps.dev/keys`.
- `vault/cli.mdx` "Authenticate": "Create one in the dashboard under **API keys**".
- `llms.txt`, `llms-full.txt`, `llms-small.txt`, and the per-page markdown twins
  are generated at build; no manual edit.

The URL `docs.zeroapps.dev/account/api-keys/` is now load-bearing outside the
docs site: the console links to it and, after step 5, so does the CLI's no-key
error. Do not rename the file or move the sidebar group without changing both.

### 5. `fix(zerovault-cli): point the no-key error at the API keys doc`

`packages/zerovault-cli/src/index.ts:46-48`. The error becomes:

```text
See https://docs.zeroapps.dev/account/api-keys/ to create one.
```

Everything else in the message (the three ways to supply a key) stays. Leave the
`--help` link to `/vault/cli/` alone.

Add `packages/zerovault-cli/src/no-key-error.test.ts`, following the existing
`version.test.ts` recipe (`execFileSync` on `node_modules/.bin/tsx` against
`src/index.ts`): run `zv whoami`, the smallest command that calls `getClient`,
with `ZEROVAULT_API_KEY` deleted from the child env and `ZEROVAULT_CONFIG`
pointed at a path that does not exist so no bound context can satisfy auth
(`configPath()` honours that variable, `src/config.ts:42-44`). `execFileSync`
throws on the non-zero exit, so catch and assert on `err.status === 1` and that
`err.stderr` contains `https://docs.zeroapps.dev/account/api-keys/`. Assert the
full URL string, not a fragment: the point of the test is that a released binary
cannot drift back to a Vault-owned page.

**Publish state, and why it does not block.** `packages/zerovault-cli` is at
version `0.2.3` in the repo, and `0.2.3` is **not on npm**: `npm view
zerovault-cli dist-tags` reports `latest: 0.2.2`. The publish is pending the
user's npm login. So:

- This change rides the pending `0.2.3` publish. No version bump, no separate
  release.
- **The changelog ships in this commit.** A CLI user sees different guidance,
  so AGENTS.md requires an entry committed with the code, and the dashboard
  bullet from step 2 does not describe the CLI. The root `CHANGELOG.md` already
  carries an unshipped `0.2.3` bullet (the `zv --version` fix). Because it is
  unreleased, extend that one bullet in this commit rather than adding a second
  one for the same unpublished version:

  ```text
  - 2026-07-28: `zv --version` now prints the CLI's real version instead of the stale `0.2.1` string, and running `zv` with no API key now points at docs.zeroapps.dev/account/api-keys/ instead of the ZeroVault getting-started guide. Both ship in zerovault-cli 0.2.3.
  ```

  Keep the date the file already carries unless the release date moves.
- The docs URL must exist before `0.2.3` is published, not before this commit.
  It will: `apps/docs` deploys automatically on the push to `main` in step 6,
  and the publish is step 8. If the publish ever runs first, the error message
  points at a 404, so "`/account/api-keys/` returns 200" is a precondition of
  step 8, checked there.
- No Worker watches `packages/zerovault-cli`, so this commit triggers no deploy
  on its own.

### 6. Push, deploy, verify in production

Push all of the above to `main`. `zerovault-api`, `zero-landing`, and `zero-docs`
redeploy. Then run the production verification checks below, in full. This step
gates step 7; do not start it early.

### 7. `zero-skills` repo (separate repo, same task, after verification)

Two instruction sets meet here. This repo's AGENTS.md requires the skills to be
updated in the same change as the user-flow change they document. The
`zero-skills` AGENTS.md requires every statement to match live behavior, which
cannot be checked before the console and docs are deployed. Both hold if the
skills edit stays inside this task rather than becoming a follow-up in a later
one: land and deploy `zero` (steps 1 to 6), verify in production, then
immediately edit and push `zero-skills`. The release is not done until this step
and step 8 are done, or step 8 is explicitly recorded as blocked.

In `/home/juan/workspace/juanibiapina/zero-skills`, commit and push to `main`
(direct pushes; the repo has no PR workflow):

- `zerovault/SKILL.md`: "Create your first key in the dashboard (dash.zeroapps.dev
  -> **API keys**)".
- `zeroerrors/SKILL.md`: rewrite the "Get a key" paragraph. Drop "ZeroErrors has
  no key page of its own" and the ZeroVault console detour; say keys are
  organization-scoped, created at dash.zeroapps.dev under **API keys**, and
  authorize both products. **Add** a key reference link to
  `https://docs.zeroapps.dev/account/api-keys/` next to that paragraph, and
  **keep** the skill's existing final ZeroErrors reference link exactly as it is.
  The file ends up with two links, one per subject. Do not repoint the existing
  "Full reference" line: it is the skill's only pointer to the ZeroErrors guide,
  and replacing it would trade one broken hop for another.

Word both skills against the wording the deployed console actually shows, read
in step 6, not against this plan.

### 8. Publish `zerovault-cli@0.2.3` to npm

The Goal says no key seeker is sent through ZeroVault again. For a `zv` user
that is only true once the corrected error string is on npm: `latest` is `0.2.2`
today, and the repo's `0.2.3` is unpublished. So the publish is a step of this
task, not a later chore.

Preconditions, both checked before running anything:

1. `docs.zeroapps.dev/account/api-keys/` returns 200 (production check 8 from
   step 6). Publishing first would ship an error message pointing at a 404.
2. `pnpm --filter zerovault-cli run build` is green (it emits the published
   output) and `npm whoami` succeeds for an account that can publish
   `zerovault-cli`.

Then, from `packages/zerovault-cli`: build, `npm publish`, and confirm with
`npm view zerovault-cli version` reporting `0.2.3`. Keep the version at `0.2.3`;
this change rides the pending release rather than cutting a new one.

If npm authentication is unavailable, do not publish under another account and do
not call the release complete. Record the blocked handoff in the task's final
report: what is deployed (console, landing, docs, skills), what is not (the CLI
string), and the exact command left to run. A `zv` user with no key keeps seeing
the old URL until then, which still resolves, so the blocked state is a delay,
not a break.

## Test strategy

### What the dashboard-web vitest + jsdom harness covers

`apps/dashboard-web/src/test/KeysPage.test.tsx` (mock `@/account/lib/api` and
`@clerk/clerk-react` with stable hook returns, following `ProjectsPage.test.tsx`):

- Empty state renders the product-neutral copy and **both** doc links, asserting
  the two `href`s (`/vault/loading-secrets/` and `/errors/getting-started/`),
  since the whole point is where they point.
- The post-create reveal also carries **both** links, same two `href`s asserted.
  Both states, not one: a regression that drops the errors link from the reveal
  is the exact bug this task exists to prevent.
- Create reveals the key once with a copy control, and Dismiss clears it.
- The reveal panel has `role="status"`, and focus lands on the copy button after
  creation (`expect(document.activeElement)` is the button found by its
  accessible name).
- Accessible names exist for the label input (`getByLabelText`) and for both
  icon-only buttons, copy and revoke (`getByRole("button", { name: ... })`).
- Copy writes the key to `navigator.clipboard` (stub it; jsdom has none by
  default, confirmed).
- Revoke asks for confirmation (stub `window.confirm`), calls the API, and
  reloads.
- Load failure shows the error plus Retry, and Retry recovers.

`apps/dashboard-web/src/test/routes.test.tsx` mounts
`createMemoryRouter(routes, { initialEntries: [...] })`. Three setup facts, each
one a confirmed reason the naive version does not run:

1. **Mocking Clerk is not enough.** `AuthProvider` reads
   `import.meta.env.VITE_CLERK_PUBLISHABLE_KEY` and throws when it is missing
   (`packages/ui/src/auth/AuthProvider.tsx:9-16`); the checkout provides no
   dashboard key, and a pass-through `ClerkProvider` mock still hits the throw.
   Call `vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test")` in a
   `beforeEach` (with `vi.unstubAllEnvs()` after), or mock `AuthProvider` itself
   as a pass-through.
2. **Mock the page data modules.** `vi.mock` `@/account/lib/api` and the vault
   and errors page modules' API modules, so mounting a route does not fire
   background relative `fetch` calls that jsdom cannot resolve and that make the
   test flaky and slow.
3. **Landmark names must be unique.** Tailwind `md:` classes hide nothing
   without a layout engine, so the desktop rail and the mobile strip both
   render. With the distinct `aria-label`s from step 1 (`"Product"`, `"Account"`,
   `"Product and account"`) each `getByRole("navigation", { name })` matches
   exactly one node, and queries scope with `within(...)`. A bare
   `getByRole("link", { name: "API keys" })` matches twice and throws.

Also mock `@clerk/clerk-react` so `ClerkProvider` and `SignedIn` pass through,
`SignedOut` renders nothing, `UserButton`/`OrganizationSwitcher` are stubs, and
`useOrganization` returns a loaded org.

Assertions:

- `/keys` renders the keys page.
- `/vault/keys` redirects to `/keys`. Run this case **twice**, with different
  assertions, because the account shell still runs `AppLayout` after the
  redirect and `AppLayout` swaps the outlet for a create-organization prompt
  when there is no active org (`packages/ui/src/components/AppLayout.tsx:69-84`):
  - With `useOrganization` returning a loaded org: assert the router location is
    `/keys` **and** that `KeysPage` rendered.
  - With `{ isLoaded: true, organization: null }`: assert the router location is
    `/keys` and that the create-organization prompt rendered with
    `afterOrgUrl="/keys"`. Do **not** assert `KeysPage` here; it cannot render
    without an org, and expecting it would make the test fail for a reason that
    has nothing to do with the redirect. Location plus the `/keys` org prompt is
    the full proof that the compatibility route mounted outside the Vault shell:
    nested under it, this case lands on the Vault prompt with
    `afterOrgUrl="/vault/projects"` instead.
- The rail shows an "API keys" link on `/vault/projects` and on `/errors/issues`,
  scoped to the `"Account"` nav, and the `"Product"` nav no longer contains it.
- On `/keys` neither product row is marked `aria-current`, and the "API keys" row
  is.
- The Vault and Errors shells still render their own brand link and target, so
  the "no brand change" promise is enforced by a test rather than by intent.

### What the CLI vitest harness covers

`packages/zerovault-cli/src/no-key-error.test.ts`, described in step 5: running
`zv whoami` with no key available exits 1 and prints
`https://docs.zeroapps.dev/account/api-keys/`. This is the only automated guard
on a string that ships in a published binary and cannot be hotfixed from a
deploy.

### Gates that can run on this box

```
pnpm --filter @zero/dashboard-web run test
pnpm --filter @zero/dashboard-web run lint
pnpm --filter @zero/dashboard-web run typecheck
VITE_CLERK_PUBLISHABLE_KEY=pk_test pnpm --filter @zero/dashboard-web run build
pnpm --filter @zero/ui run lint
pnpm --filter @zero/ui run typecheck
pnpm --filter @zero/docs run build
pnpm --filter @zero/docs run lint
pnpm --filter @zero/docs run typecheck
pnpm --filter @zero/landing run build
pnpm --filter @zero/landing run lint
pnpm --filter @zero/landing run typecheck
pnpm --filter zerovault-cli run test
pnpm --filter zerovault-cli run lint
pnpm --filter zerovault-cli run typecheck
pnpm --filter zerovault-cli run build
```

The dashboard build is the strongest local check that the extracted `routes.tsx`
actually bundles, and `apps/dashboard-web/vite.config.ts:7-11` throws on a build
without `VITE_CLERK_PUBLISHABLE_KEY`, so pass a non-secret placeholder. Both
Astro packages define `typecheck` (`astro check`) and landing defines `lint`.
The CLI build (`tsc -p tsconfig.build.json`,
`packages/zerovault-cli/package.json:23`) is not redundant with its tests: the
tests run the TypeScript source through `tsx`, so only the build proves the file
that ships to npm still emits. Step 5 edits that entry point, so run the build
before step 8's publish and before any `npm pack`.
None of these commands starts `workerd`. Note the CLI package's npm name is
`zerovault-cli`, not `@zero/…`, so `pnpm --filter` takes it bare; a wrong filter
exits 0 and silently runs nothing.

`gob run bin/ci` and `bin/e2e-test` cannot run here: they boot `workerd`, which
does not start on this NixOS box (see AGENTS.md). `@zero/ui` has no test script,
so the shell is covered indirectly through the dashboard-web router test rather
than by adding a vitest setup to `packages/ui`. GitHub Actions covers the
cross-worker checks and the deploy dry run.

### What only production verification can cover

This is step 6, and it gates the `zero-skills` edit in step 7. After the push to
`main` deploys `zerovault-api`, `zero-landing`, and `zero-docs`, verify with the
browse skill against the real console:

1. Sign in at `dash.zeroapps.dev`. The rail shows Vault, Errors, then the
   Account divider with "API keys". Screenshot from both products, and confirm
   each product's brand mark and link target are unchanged.
2. Open API keys: no product row is highlighted, the page reads product-neutral,
   and the subhead states the one-key fact.
3. Create a key labelled `ia-check`, confirm the one-time reveal and copy, then
   revoke it. This is the only place the real Clerk session, the real OrgDO, and
   the real KV write are exercised.
4. Visit `dash.zeroapps.dev/vault/keys` and confirm it lands on `/keys`.
5. Narrow the viewport below `md` (`48rem`, which is 768px at a 16px root, but
   check against the breakpoint rather than the pixel value) and confirm the
   strip shows Projects, the rule, and API keys, and that the product `<select>`
   reads "Account" on `/keys`.
6. From `zeroapps.dev`, click "Create an API key" and confirm it lands on
   `/keys`.
7. Load `docs.zeroapps.dev/account/api-keys/` and the errors getting-started page
   and confirm the sidebar wording matches what the console actually shows.
8. Confirm `docs.zeroapps.dev/account/api-keys/` returns 200, since the CLI's
   no-key error now points there. This is the precondition for publishing
   `zerovault-cli@0.2.3`.

Record the exact console wording seen here; step 7 words the skills against it.

## Acceptance criteria

- [ ] "API keys" appears in the console rail in its own bordered section under an
      `Account` label, below the product nav and above the Docs link, on both the
      Vault and the Errors shells. The same word `Account` names the mobile
      `<select>` placeholder and the docs sidebar group.
- [ ] Each of the Vault and Errors shells renders the same brand name and icon as
      before and keeps the same link target (`/vault/projects` and
      `/errors/issues`), proved by the route tests and the production
      screenshots. The brand implementation itself does change, because
      `brand.icon` becomes optional, so this is a rendered-output promise, not a
      byte-identical-source one. Only the new `/keys` shell renders an iconless
      brand.
- [ ] The Vault product nav lists only Projects; no product nav contains a keys
      entry.
- [ ] `/keys` renders the keys page with no product row highlighted; `/vault/keys`
      redirects to `/keys` with `replace`, from a root-level route, including for
      a signed-in user with no active organization.
- [ ] The keys page never says "Vault" as the owner of keys, states that keys are
      organization-scoped and authorize both products, and links to both the
      loading-secrets and the errors getting-started docs from the empty state
      and the post-create reveal.
- [ ] No em dash in any shipped user-facing string on the page, including the
      table's fallback for an unlabelled key, which reads `None`.
      `rg "—" apps/dashboard-web/src/account` returns nothing.
- [ ] The revoke button, the copy button, and the label input all have accessible
      names (the label via `htmlFor`/`id`); the reveal panel is `role="status"`;
      focus lands on the named copy button after creation.
- [ ] Below `md`, the account item is reachable in one tap from the nav strip, and
      the product `<select>` shows a disabled "Account" placeholder on `/keys`.
- [ ] Back end untouched: no diff under `apps/vault-api/src`, `packages/auth`,
      `packages/vault-core` beyond nothing at all.
- [ ] `apps/landing`'s single `keysUrl` points at `dash.zeroapps.dev/keys`, so
      both CTAs do.
- [ ] `packages/zerovault-cli`'s no-key error points at
      `docs.zeroapps.dev/account/api-keys/`, covered by a test that asserts the
      full URL. `rg "vault/getting-started" packages/zerovault-cli/src` returns
      nothing.
- [ ] `docs.zeroapps.dev/account/api-keys/` returns 200 before
      `zerovault-cli@0.2.3` is published to npm.
- [ ] `zerovault-cli@0.2.3` is published (step 8) and `npm view zerovault-cli
      version` reports `0.2.3`, or the publish is recorded as blocked on npm
      authentication in the task's final report, with the remaining command
      named and the release not called complete. `latest` is `0.2.2` today.
- [ ] `apps/docs` has `account/api-keys` in the sidebar, and none of `index.mdx`,
      `vault/getting-started.mdx`, `vault/overview.md`, `vault/cli.mdx`,
      `errors/getting-started.mdx`, `errors/overview.md` still routes a key
      seeker through ZeroVault. `rg -i "ZeroVault . API Keys|no separate key
      page|Keys come from ZeroVault" apps/docs` returns nothing.
- [ ] The `## 4. Create an API key` anchor in `vault/getting-started.mdx` still
      exists (nothing that links to it breaks).
- [ ] `zero-skills` `zerovault/SKILL.md` and `zeroerrors/SKILL.md` are updated and
      pushed in the same task, after production verification, with no remaining
      "ZeroVault console" detour for keys, and with `zeroerrors/SKILL.md` keeping
      its existing ZeroErrors reference link plus a new key reference link.
- [ ] A root `CHANGELOG.md` bullet ships in the dashboard-web commit, and the
      step-5 commit ships the CLI's changelog wording in the same commit as the
      code (the unshipped `0.2.3` bullet, extended). Root file, not the agent
      changelog. No changelog-only follow-up commit.
- [ ] New tests: `KeysPage.test.tsx`, `routes.test.tsx`, and
      `no-key-error.test.ts` pass, and every listed per-package test, lint,
      typecheck, and build gate is green.
- [ ] Production browse verification completed for all eight checks above.

## Risks and mitigations

- **Rail regression on the two product shells.** The `showSelector` change and
  the new region touch every console screen. Mitigation: the router test asserts
  the rail contents and the unchanged brand on `/vault/projects` and
  `/errors/issues`, plus screenshots of both in prod verification. Dropping the
  wordmark change (Decision 1b) removes most of this risk.
- **`startsWith` active-state collisions.** `/keys` is a unique prefix today, but
  a future `/keys-something` route would light it up. Low cost to accept now;
  note it in the code comment.
- **Duplicated jsdom matches** for desktop and mobile trees silently passing a
  wrong assertion. Mitigation: named `<nav>` landmarks and scoped queries, as
  above.
- **Docs and console drift** if only one ships. Mitigation: one push, and the doc
  and skills edits are acceptance criteria, not follow-ups.
- **Deploy fan-out.** This push touches `apps/dashboard-web` (rebuilds
  `zerovault-api`), `apps/landing`, and `apps/docs`, so three of the four Workers
  redeploy. `zero-api` (the agent) is not in any touched watch path, so no agent
  turns are reset. `packages/zerovault-cli` has no Worker watch path, so step 5
  triggers no build on its own. `packages/ui` is different: it is a direct
  `zerovault-api` watch path (AGENTS.md lists `packages/ui/*` in that Worker's
  includes), so step 1 alone would rebuild `zerovault-api`. Since this all lands
  in one push, the fan-out is the same three Workers either way.
- **The CLI ships out of band.** The corrected error string only reaches users
  when `zerovault-cli@0.2.3` is published (step 8), which is manual and needs an
  npm login. Until then a `zv` user with no key still sees the old URL, which
  still resolves. Mitigation: keep the docs page live first, publish as step 8 of
  this task, and if the login is unavailable, report the release as incomplete
  with the publish command named rather than closing the task.

## Verification findings folded into this revision

This plan was reviewed twice (`docs/plans/unified-api-keys-verify.md`: round 1
verdict NO-GO until the blocker was fixed, round 2 verdict no blockers with five
SHOULD-FIX and two NIT items). Every finding from both rounds is resolved here;
nothing was rejected. Recorded so a fresh reader does not re-open settled
questions.

### Round 1

| Finding | Resolution |
|---|---|
| BLOCKER: the CLI no-key error still sends a key seeker to the Vault guide | Step 5 changes it to `/account/api-keys/`, with a test asserting the full URL, plus a criterion that the docs page is live before the pending `0.2.3` publish |
| SHOULD-FIX 1: the console-wide brand change is unrelated, has no brand target, and its visual premise was wrong | Decision 1b now keeps both product brands as they are; `brand.icon` becomes optional only so the new `/keys` shell can render an iconless `Zero` |
| SHOULD-FIX 2: a nested `/vault/keys` redirect never mounts without an active org | Decision 3 declares it as a root-level route; the route test covers the org-less case |
| SHOULD-FIX 3: the route test recipe does not run (Clerk env throw, colliding landmark names, background fetches) | Test strategy now stubs `VITE_CLERK_PUBLISHABLE_KEY`, gives every `<nav>` a distinct name, and mocks the page data modules |
| SHOULD-FIX 4: focus moves to an unnamed copy button | Decision 2 names the copy button, wires the hidden label with `htmlFor`/`id`, and the tests assert names, `role="status"`, focus, and both doc links in both states |
| SHOULD-FIX 5: the skills edit was ordered before the production verification it depends on | Steps renumbered: land, deploy, verify (step 6), then push `zero-skills` (step 7), then publish the CLI (step 8); `zeroerrors/SKILL.md` gains a key link and keeps its ZeroErrors link |
| SHOULD-FIX 6: the local gate list is incomplete | Dashboard build (with a placeholder Clerk key), both Astro `typecheck`s, landing `lint`, and the CLI gates added |
| NIT 1: landing URL described as hardcoded twice; `md` called 768px | Both corrected; the production check now names the `48rem` breakpoint |
| NIT 2: two names for one section | `Account` on desktop, on the mobile `<select>`, and as the docs sidebar group; the `Organization` tradeoff is written down |
| NIT 3: "every place" implied editing historical records | Table retitled to current shipped user-facing key-acquisition paths, with the historical files named as out of scope |

### Round 2

| Finding | Resolution |
|---|---|
| SHOULD-FIX 1: the CLI change had no changelog entry in its own commit | Step 5 now extends the unshipped `0.2.3` bullet in the step-5 commit itself, and an acceptance criterion forbids a changelog-only follow-up |
| SHOULD-FIX 2: publication was required by the Goal but absent from the steps | New step 8 publishes `zerovault-cli@0.2.3`, gated on the docs URL returning 200, a green CLI build, and `npm whoami`; if the login is unavailable the step is recorded as blocked and the release is not called complete. Version stays `0.2.3` |
| SHOULD-FIX 3: the org-free redirect test cannot render the keys page | The route test's two `/vault/keys` cases now assert different things: page plus location with an org, location plus the create-organization prompt and `afterOrgUrl="/keys"` without one |
| SHOULD-FIX 4: the no-em-dash criterion conflicted with the unchanged table | Decision 2 changes the unlabelled-key fallback from an em dash to `None`, and the criterion names it with an `rg` check |
| SHOULD-FIX 5: the CLI gate list omitted its build | `pnpm --filter zerovault-cli run build` added to the local gates, with a note that `tsx`-run tests do not prove the published output emits, and it runs before step 8 |
| NIT 1: `byte-identical` brand output is not satisfiable | The criterion now promises the same rendered brand name, icon, and link target on the Vault and Errors shells, proved by route tests and screenshots |
| NIT 2: the claim that no Worker watches `packages/ui` is false | The risk section now says `packages/zerovault-cli` has no Worker watch path while `packages/ui` is a direct `zerovault-api` watch path; the single push still fans out to the same three Workers |

## Skills to use

- `code` when implementing, `tdd` for the three test files (write the routing
  assertions before moving the route, and the CLI string assertion before
  editing the message).
- `impeccable` (`product` register) for the rail region and the keys page copy.
- `vocabulary` and `ai-writing-signs` for the doc, skill, and changelog wording.
- `changelog` before touching the root `CHANGELOG.md`.
- `browse` for the production verification pass.
- `git-commit` for each commit, including the separate `zero-skills` commit.
