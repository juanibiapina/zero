# Verification: unified API keys in the console

## Verdict

NO-GO until the blocker is fixed. The console design is implementable and most
current-code claims are correct. The plan misses one live key-acquisition detour,
adds an unrelated brand change, and has gaps in its redirect and test recipes.

Both repositories were fetched before the sweep:

- `zero`: `main` at `7f2fce4`, 0 ahead and 0 behind `origin/main`
- `zero-skills`: `main` at `d26f184`, 0 ahead and 0 behind `origin/main`

## BLOCKER

### 1. The CLI still sends a key seeker to the ZeroVault guide

The plan says the `zv` no-key error needs no change because the Vault guide and
its anchor remain valid (`docs/plans/unified-api-keys.md:91-94`). That preserves
the detour this task is meant to remove. The live string says:

```text
See https://docs.zeroapps.dev/vault/getting-started/ to create one.
```

Evidence: `packages/zerovault-cli/src/index.ts:46-48`. That URL opens a page titled
"Getting started with ZeroVault" and makes a key seeker find step 4. It is also
recent user-visible work from `fc6452c`.

Fix: change the no-key error to
`https://docs.zeroapps.dev/account/api-keys/`, update its test or add one if the
exact error is not covered, and include this path in the sweep acceptance
criteria. The general `zv --help` link to `/vault/cli/` can stay because it is the
CLI reference, not a key-acquisition detour.

## SHOULD-FIX

### 1. Drop the console-wide brand change from this task

Making every shell drop its product icon is unrelated to moving API keys. The
plan changes all console chrome (`docs/plans/unified-api-keys.md:191-199,
285-286`) and then calls for one shared brand object across all three shells
(`docs/plans/unified-api-keys.md:299-303`). It never chooses that shared object's
`to` value. Today the Vault brand links to `/vault/projects` and the Errors brand
links to `/errors/issues` (`apps/dashboard-web/src/main.tsx:29,40`). A shared
brand target would either change one shell's behavior or point to `/`, which the
plan explicitly leaves Vault-first.

The visual claim is also wrong: the landing wordmark's period uses the orange
`--signal-hot`, not a muted color (`apps/landing/src/styles/global.css:24,
108-109`).

Fix: retain the current icons and per-shell brand targets. Make `brand.icon`
optional only so the `/keys` shell can render plain `Zero` if needed. Give that
shell an explicit target such as `/keys`. A full wordmark reset belongs in a
separate design task.

### 2. Put the legacy redirect outside the Vault shell

A nested `<Navigate to="/keys" replace />` works when its parent outlet renders. A
throwaway Vitest probe using the installed React Router 8.2.0 confirmed that the
nested absolute redirect reaches `/keys` and replaces the location.

The proposed parent is `AppLayout`, though, and `AppLayout` does not render its
`<Outlet />` until Clerk is loaded and an organization is active
(`packages/ui/src/components/AppLayout.tsx:69-83,224`). A user without an active
organization who opens `/vault/keys` sees the Vault organization prompt with
`afterOrgUrl="/vault/projects"`; the promised redirect never mounts. The route can
also flash the Vault shell before redirecting for an active organization.

Fix: declare the compatibility route as a root child, alongside the `vault`,
`errors`, and `keys` shells:

```tsx
{ path: "vault/keys", element: <Navigate to="/keys" replace /> }
```

Then test the redirect independently of an active organization. This does not
break the recent outbound docs links from `KeysPage`; those links remain on the
page after the move. Keep both existing loading-secrets links from `d6ef9cd`.

### 3. The routing test recipe does not run as written

Two separate preconditions are missing:

1. Mocking Clerk does not bypass `AuthProvider`. It reads
   `import.meta.env.VITE_CLERK_PUBLISHABLE_KEY` and throws when it is absent
   (`packages/ui/src/auth/AuthProvider.tsx:9-16`). The checkout and current shell
   provide no dashboard key. A throwaway test confirmed that a pass-through
   `ClerkProvider` mock still gets this error.
2. The proposed query
   `screen.getByRole("navigation", { name: "Account" })` is incompatible with the
   plan's own duplicated desktop and mobile DOM (`docs/plans/unified-api-keys.md:
   398-401`). If both landmarks have that name, `getByRole` throws because two
   matches exist. Tailwind does not hide either tree in jsdom.

Fix: use `vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "test")` or replace
`AuthProvider` with a pass-through in the route test. Give the desktop account
landmark and the combined mobile strip distinct names, or use `getAllByRole` and
assert both copies. Mock the page data modules so route tests do not issue
background relative fetches.

The rest of the jsdom strategy is sound. The real harness uses jsdom and the
shared setup (`apps/dashboard-web/vitest.config.ts:9-12`), and the current suite
passes: 2 files, 6 tests. A probe confirmed `navigator.clipboard` is absent and
must be stubbed. jsdom can assert rendered copy, hrefs, focus, active classes,
ARIA state, redirects, and mocked calls. It cannot prove breakpoint behavior,
scrolling, or visual separation. Those checks correctly belong in browser
verification.

### 4. The focused copy control still has no accessible name

The plan moves focus to the icon-only copy button after creation
(`docs/plans/unified-api-keys.md:230-233`) but only adds an accessible name to the
icon-only revoke button (`docs/plans/unified-api-keys.md:244`). The current copy
button contains only a Lucide icon (`apps/dashboard-web/src/products/vault/pages/KeysPage.tsx:79-81`). Moving focus to an unnamed control makes the new keyboard flow incomplete.

Fix: give the copy button a stable name such as `aria-label="Copy API key"`.
Connect the visually hidden label to the input with `htmlFor` and `id`. Extend
`KeysPage.test.tsx` to assert:

- the label input and both icon-only buttons have names
- the reveal has `role="status"`
- focus moves to the copy button after creation
- the loading-secrets and errors links survive both the empty and created states

### 5. The zero-skills rollout order conflicts with its repository instructions

Updating both skills is required because this is a documented user-flow change
(`AGENTS.md:37-45`). The plan is right about that obligation. The skills repo also
requires production verification before changing a promise about live behavior
(`/home/juan/workspace/juanibiapina/zero-skills/AGENTS.md:6-12`). The plan lists a
skills commit before its production verification section, while also saying to
edit only against shipped wording (`docs/plans/unified-api-keys.md:351-365`).
Those instructions cannot both be followed in that order.

Fix the rollout sequence:

1. Land and deploy the `zero` console and docs changes.
2. Verify `/keys`, the wording, and `/account/api-keys/` in production.
3. Edit, commit, and push `zero-skills` immediately as the second repository in
   the same release task.

In `zeroerrors/SKILL.md`, add a key-reference link near "Get a key" and retain the
existing final ZeroErrors reference. The plan's wording about pointing "Full
reference" at the account key page is ambiguous and could replace the skill's
only link to the ZeroErrors guide.

### 6. The local gate list is incomplete

The acceptance criteria say package build, lint, typecheck, and tests are green,
but the command list omits:

- `pnpm --filter @zero/dashboard-web run build`
- `pnpm --filter @zero/docs run typecheck`
- `pnpm --filter @zero/landing run lint`
- `pnpm --filter @zero/landing run typecheck`

Both Astro packages define `typecheck`, and landing defines `lint`
(`apps/docs/package.json`, `apps/landing/package.json`). Dashboard build is the
strongest check that the extracted route module bundles. It needs a non-secret,
truthy `VITE_CLERK_PUBLISHABLE_KEY` for the Vite config's build guard
(`apps/dashboard-web/vite.config.ts:7-11`). None of these checks starts
`workerd`.

Fix: add those commands. Keep the stated `workerd` exclusions. The claim that
`@zero/ui` has no test script is correct (`packages/ui/package.json:9-13`).

## NIT

### 1. Tighten two factual descriptions

- The landing page does not hardcode the URL twice. It declares `keysUrl` once
  and uses it for two CTAs (`apps/landing/src/pages/index.astro:6,66,111`). Say
  "both CTAs use the one hardcoded `keysUrl`".
- Tailwind's real `md` breakpoint is `48rem`
  (`node_modules/.pnpm/tailwindcss@4.3.3/node_modules/tailwindcss/theme.css:328`).
  Calling it 768px is the normal 16px-root equivalent, but production checks
  should say "below `md` (`48rem`)" rather than promise a literal pixel value.

### 2. Use one section name on mobile and desktop

The desktop section is called `Organization`, while the mobile disabled select
option is `Account` (`docs/plans/unified-api-keys.md:155-160,177-179`). Choose one
term. `API keys` is clearer as the selected mobile location and avoids confusing
the product select with Clerk's adjacent organization switcher.

### 3. Scope the sweep claim to shipped user-facing surfaces

The plan covers all other shipped console, landing, docs, and skill detours found
by the independent sweep. The repo also contains old statements in historical
plan records such as `docs/plans/agent-skills.md:74` and
`docs/plans/docs-content-getting-started.md:230-232`, plus internal implementation
comments in `packages/auth/src/index.ts:3-10` and `docs/zeroerrors/design.md:5`.
Those are not current acquisition instructions and should not be rewritten.
Rename the table to "Current shipped user-facing key-acquisition paths" so
"every place" does not imply editing historical records.

## Confirmed claims

- Keys are organization-scoped. `OrgDO` writes `{ v: 2, orgId, userId }` to KV
  (`apps/vault-api/src/OrgDO/index.ts:56-62`) and is selected with
  `idFromName(orgId)` (`apps/vault-api/src/vaults.ts:24-25`).
- `validateApiKey` returns the stored org and user context
  (`packages/auth/src/index.ts:45-68`). The same middleware runs on
  `/vault/v1/*` and `/errors/v1/*` (`apps/vault-api/src/dashboard-app.ts:58-69`),
  and Errors ingest is `/errors/v1/errors`
  (`apps/vault-api/src/errors/routes/errors.ts:23`).
- Key management routes are `/vault/v1/keys` for key auth and
  `/api/vault/keys` for Clerk auth (`apps/vault-api/src/routes/keys.ts:43-50`).
- A new client route needs no Worker source change. The dashboard's asset binding
  uses `not_found_handling: "single-page-application"`
  (`apps/vault-api/wrangler.jsonc:19-24`), and non-API dashboard requests go to
  `env.ASSETS.fetch` (`apps/vault-api/src/worker.ts:30-34`).
- `AppLayout` is app-parameterized through `navItems`; it already has a Docs
  foot, a native mobile product select, and a mobile horizontal nav. The product
  switcher is currently gated by both `products` and `currentProductId`
  (`packages/ui/src/components/AppLayout.tsx:57,88-167,203-224`). The account
  section design fits this module.
- Active nav uses `pathname.startsWith`, desktop starts at `md`, and the mobile
  trees use `md:hidden` (`packages/ui/src/components/AppLayout.tsx:88,135,
  161,203,212`).
- `ApiKeyInfo` and `ApiKeyCreated` live in `@zero/vault-core`; `@zero/auth` exposes
  `KVNamespace` in its interface and opts into Workers types
  (`packages/vault-core/src/index.ts:13-23`, `packages/auth/src/index.ts:46`,
  `packages/auth/tsconfig.json:10`). Keeping the browser types out of auth is
  reasonable.
- The recent docs-link work is preserved if the plan keeps both
  loading-secrets links and adds the Errors link. Projects and Issues links are
  untouched. The new account doc remains platform-neutral, so it does not undo
  commit `30c364f`.

## Required plan edits

1. Add the CLI no-key URL change and test.
2. Keep product-shell brand icons and targets; limit any iconless brand to the
   account shell.
3. Move `/vault/keys` redirect outside the gated Vault shell.
4. Correct the route-test setup and landmark queries.
5. Add copy-button accessibility and tests.
6. Put production verification before the zero-skills edit and preserve the
   ZeroErrors full-reference link.
7. Add the missing local gates.
8. Keep the rest of the account rail, page move, docs page, landing URL, root
   changelog, and production checks as planned.

## Round 2

### Verdict

No blockers. All round-1 findings were folded into the revised plan. The plan is
implementable, but five new SHOULD-FIX items should be corrected before work
starts. They are release, test, and acceptance-criterion defects rather than
problems with the account-section design.

The checkout is still `main` at `7f2fce4`, with no divergence from
`origin/main`. The `zero-skills` checkout is still `main` at `d26f184`, also with
no divergence. On 2026-07-28, both `npm view zerovault-cli dist-tags --json` and
`npm view zerovault-cli version` reported `0.2.2`; the repo declares `0.2.3` at
`packages/zerovault-cli/package.json:3`. The revised plan's version premise is
correct.

### Round-1 resolution check

| Round-1 finding | Round-2 result |
|---|---|
| BLOCKER: CLI no-key error keeps the Vault guide | Resolved. Step 5 changes the exact string now at `packages/zerovault-cli/src/index.ts:46-48` to `/account/api-keys/` and adds a full-URL subprocess test. |
| SHOULD-FIX: drop the console-wide brand change | Resolved. Decision 1b and steps 1 to 2 retain the existing Vault and Errors icons and targets. The cited targets are still at `apps/dashboard-web/src/main.tsx:29,40`. The CSS premise is also corrected: `--signal-hot` is at `apps/landing/src/styles/global.css:24`, and the wordmark uses it at lines 108-109. |
| SHOULD-FIX: move the legacy redirect to the root route | Resolved. Decision 3 and step 2 place `vault/keys` beside the shells. The cited gate is real: `AppLayout` selects the organization prompt at `packages/ui/src/components/AppLayout.tsx:69-83` and renders the outlet only at line 224. |
| SHOULD-FIX: repair the route-test recipe | Resolved. The plan now supplies the Clerk env, mocks data modules, gives the three navigation landmarks distinct names, and scopes queries. |
| SHOULD-FIX: name the focused copy button | Resolved. Decision 2 names the copy and revoke controls, connects the input label, and tests the names and focus. The current copy control is icon-only at `apps/dashboard-web/src/products/vault/pages/KeysPage.tsx:79-81`. |
| SHOULD-FIX: verify production before editing `zero-skills` | Resolved. Production verification is step 6 and the skills update is step 7. The ZeroErrors reference link is explicitly retained. |
| SHOULD-FIX: extend local gates | Resolved as to every command named in round 1. The dashboard build, both Astro typechecks, and landing lint and typecheck are present. |
| NIT: describe the landing URL and breakpoint precisely | Resolved. The plan describes one `keysUrl` used twice and names `md` as `48rem`. |
| NIT: use one section name | Resolved. `Account` is used for the desktop section, mobile placeholder, and docs group. |
| NIT: narrow the sweep claim | Resolved. The table now covers current shipped key-acquisition paths and names historical records as out of scope. |

### SHOULD-FIX

#### 1. The CLI change has no changelog entry committed with it

Step 5 says to add nothing for the CLI because the dashboard entry from step 2
is enough (`docs/plans/unified-api-keys.md:448-451`). That entry describes the
new dashboard location and redirect, but not the CLI's changed no-key guidance
(`docs/plans/unified-api-keys.md:376-378`). The plan also puts the dashboard
entry and CLI code in separate commits. This conflicts with the repository rule
that every user-visible change gets an entry committed with its code
(`AGENTS.md:13-16`). The existing unshipped `0.2.3` entry only describes the
version output fix (`CHANGELOG.md:7`).

Fix: add a root changelog bullet for the corrected CLI guidance in the step-5
commit, or combine the dashboard and CLI work into one commit and make one bullet
cover both visible changes explicitly.

#### 2. Publication is required by the goal but absent from the numbered steps

The version ordering is valid: npm latest is `0.2.2`, the repo is `0.2.3`, and
production check 8 proves the new docs URL before any publish. The remaining
problem is task completion. Step 7 says the task is done after the skills push
(`docs/plans/unified-api-keys.md:466-474`), while the risk section says the CLI
fix reaches users only after a manual `0.2.3` publish and calls that publish the
last release step (`docs/plans/unified-api-keys.md:704-708`). No numbered step
publishes it or records a blocked handoff. Without that action, npm users keep
the round-1 detour even though the plan's goal says it is gone.

Fix: add an explicit final publish step, gated on the docs URL returning 200 and
npm authentication. If credentials remain unavailable, mark that step blocked
and do not call the release complete. Keep version `0.2.3`; the checked npm and
repo states support riding the pending release.

#### 3. The organization-free redirect test cannot render the keys page

The route test says to assert both the rendered page and router location for the
organization-free `/vault/keys` case (`docs/plans/unified-api-keys.md:547-552`).
After the root redirect reaches `/keys`, the account shell still runs
`AppLayout`. With `{ isLoaded: true, organization: null }`, it renders the create
organization prompt, not `KeysPage` (`packages/ui/src/components/AppLayout.tsx:
69-84`).

Fix: split the assertions. With an active organization, assert `KeysPage` and
`/keys`. Without one, assert `/keys` plus the create-organization prompt and its
`afterOrgUrl="/keys"`. That still proves the compatibility redirect mounted
outside the Vault shell.

#### 4. The no-em-dash criterion conflicts with the unchanged table

Decision 2 rewrites the reveal sentence and says the table is otherwise
unchanged. The acceptance criteria then require no em dash in any user-facing
string on the page (`docs/plans/unified-api-keys.md:648`). The current unlabeled
key fallback is an em dash at
`apps/dashboard-web/src/products/vault/pages/KeysPage.tsx:137`.

Fix: change the fallback to a word such as `None`, or narrow the criterion to the
rewritten prose. Changing the fallback is clearer and satisfies the criterion as
written.

#### 5. The CLI gate list still omits its build

This revision changes the CLI entry point that is emitted into the npm package,
but the local gates run only its test, lint, and typecheck
(`docs/plans/unified-api-keys.md:583-585`). The package has a separate build
script at `packages/zerovault-cli/package.json:23`; tests execute the TypeScript
source through `tsx`, so they do not prove the publishable output emits. The
build runs successfully on this box.

Fix: add `pnpm --filter zerovault-cli run build` to the local gates, before any
publish or pack step.

### NIT

#### 1. `Byte-identical` brand output is not a satisfiable criterion

The plan must change `brand.icon` from required to optional and conditionally
render it, so the brand implementation cannot remain byte-identical. The real
promise is unchanged rendered name, icon, and target on the Vault and Errors
shells (`docs/plans/unified-api-keys.md:637-638`).

Fix: replace `byte-identical` with `renders the same name and icon and keeps the
same link target`. Keep the route tests and production screenshots as proof.

#### 2. The Worker watch-path claim about `packages/ui` is false

The risk section says no Worker watches `packages/ui`
(`docs/plans/unified-api-keys.md:701-703`). `zerovault-api` explicitly includes
`packages/ui/*` (`AGENTS.md:129-133`). The planned single push still causes the
same three Worker builds, so this does not break the rollout.

Fix: say `packages/zerovault-cli` has no Worker watch path, while `packages/ui`
is a direct `zerovault-api` watch path.

### Scope and implementability

No remaining implementation step is material scope creep. The page and data
module move removes Vault ownership from the source layout, the router
extraction makes the compatibility route testable, and the accessibility edits
are tied to the new focus flow and moved page. The docs, landing link, skills,
and redirect are all current acquisition paths required by the goal. The
console-wide brand reset and default-route redesign remain deferred.

After the five SHOULD-FIX items above, a developer can execute the plan without
this conversation. The route shape, file moves, copy, tests, local gates,
production checks, cross-repository order, and npm version precondition are all
specified.
