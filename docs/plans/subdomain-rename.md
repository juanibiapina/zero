# Plan: Task 3 — clean Zero-branded subdomains for Vault + Errors

Move the two SaaS web apps from `zerovault.juanibiapina.dev` /
`zeroerrors.juanibiapina.dev` to `vault.juanibiapina.dev` /
`errors.juanibiapina.dev`. Authoritative design:
`docs/plans/unified-console-design.md` ("Target architecture" and "Task 3").
Background: `docs/plans/unified-console-research.md`.

This is Task 3 of the unified Zero console. Task 2 (the `@zero/ui` product
selector and `packages/ui/src/products.ts`) has already landed.

## Goal

Serve Vault and Errors on clean, brand-aligned subdomains (`vault.`, `errors.`)
that read as "Zero's Vault" / "Zero's Errors" instead of the doubled
`zerovault.` / `zeroerrors.`. No production-data risk: no worker `name`, KV id,
DO class, or migration-tag change.

## Recommendation (chosen path)

**Rename the web custom domains to `vault.juanibiapina.dev` and
`errors.juanibiapina.dev`.** This matches the design's recommendation. It is a
`custom_domain` route change plus one Cloudflare DNS record per new host, plus
flipping the two prod-host constants in `products.ts`. The worker `name`
(`zerovault-api`, `zeroerrors-api`), KV id `7c218b09…`, DO classes (`OrgDO`,
`ProjectVaultDO`, `ErrorsDO`), and migration tags all stay verbatim, so
production data is untouched — the hard constraint from
`docs/vault-errors-relocation.md` holds.

During cutover, **keep BOTH old and new custom domains attached to each
worker**. In-flight users on the old hosts are not broken; the new hosts come
up in parallel. The old custom domains are **kept attached indefinitely**;
removing them is out of scope for this task (they also serve live API
consumers — see "Old-host handling").

### Fallback (documented, not chosen): keep current hosts

Keeping `zerovault.` / `zeroerrors.` is zero infra churn but perpetuates the
`zerovault` naming this whole effort is shedding, and still needs the Task 4
Clerk allowed-origins work regardless. If the reviewer picks this at the plan
gate, Task 3 collapses to nothing (branding already shipped in Task 2) and only
`products.ts` stays on the current constants. Rejected as the default for
branding.

## Hard constraints

- Do **not** change worker `name`, KV `id`, DO `class_name`, or migration `tag`
  in either wrangler file. These identify production data; renaming orphans it.
- The only in-repo edits are: two `routes[]` blocks (`custom_domain` additions),
  the two prod-host constants in `packages/ui/src/products.ts`, and a CHANGELOG
  entry.

---

## What to change and why

### 1. wrangler `routes[]` — add the new custom domain alongside the old

Confirmed current shape. Both files end with a single-entry `routes` array.

`apps/vault-api/wrangler.jsonc` (current):

```jsonc
  "routes": [
    {
      "pattern": "zerovault.juanibiapina.dev",
      "custom_domain": true
    }
  ],
```

New (both hosts attached during cutover — safe, no user break):

```jsonc
  "routes": [
    {
      "pattern": "zerovault.juanibiapina.dev",
      "custom_domain": true
    },
    {
      "pattern": "vault.juanibiapina.dev",
      "custom_domain": true
    }
  ],
```

`apps/errors-api/wrangler.jsonc` (current):

```jsonc
  "routes": [
    {
      "pattern": "zeroerrors.juanibiapina.dev",
      "custom_domain": true
    }
  ],
```

New:

```jsonc
  "routes": [
    {
      "pattern": "zeroerrors.juanibiapina.dev",
      "custom_domain": true
    },
    {
      "pattern": "errors.juanibiapina.dev",
      "custom_domain": true
    }
  ],
```

**ADD, do not replace.** Keeping both patterns means the deploy that provisions
the new custom domain leaves the old one serving, so any in-flight user or any
cached link keeps working through the whole rename. Removing the old pattern is
out of scope for this task and, if ever done, is gated on repointing the old
hosts' API consumers first (see "Old-host handling").

Each `custom_domain: true` route makes wrangler provision a Cloudflare custom
domain (edge cert + DNS) for that hostname on deploy, on an account already
holding the zone `juanibiapina.dev`.

### 2. Selector hrefs — `packages/ui/src/products.ts`

Flip the two prod constants from the `zerovault.` / `zeroerrors.` hosts to the
new `vault.` / `errors.` hosts. The `VITE_VAULT_URL` / `VITE_ERRORS_URL` dev
override env vars stay — they let localhost dev point the selector at
5176/5177/5178.

Current:

```ts
// Current production hosts (Task 3 renames these to vault./errors.).
const PROD_VAULT_URL = "https://zerovault.juanibiapina.dev";
const PROD_ERRORS_URL = "https://zeroerrors.juanibiapina.dev";
```

New:

```ts
// Zero-branded production hosts.
const PROD_VAULT_URL = "https://vault.juanibiapina.dev";
const PROD_ERRORS_URL = "https://errors.juanibiapina.dev";
```

`getProducts()` keeps reading `import.meta.env.VITE_VAULT_URL ?? PROD_VAULT_URL`
(and errors), so dev is unaffected and prod picks up the new hosts.

Do this **after** the new hosts are live (see sequencing) so the selector never
links to a host that 404s.

### 3. CHANGELOG

Load the `changelog` skill. The repo uses a flat, dated, most-recent-first list
(no Keep-a-Changelog groups). **Merge the new addresses into the existing
unreleased 2026-07-21 brand/switcher bullet** rather than adding a second
overlapping same-date bullet. The merged entry reads:

```
- 2026-07-21: Vault and Errors now share the Zero brand and a product switcher, and live at vault.juanibiapina.dev and errors.juanibiapina.dev.
```

Commit the entry with the code (per `AGENTS.md`), not as a follow-up. Keep it
user-facing (the shared brand, the switcher, the new addresses). If the
2026-07-21 brand bullet has already shipped and is no longer the unreleased top
entry, add a fresh dated bullet naming just the new URLs instead.

---

## Cloudflare DNS / custom-domain provisioning (outside-repo, user-driven)

These steps run against the Cloudflare Dashboard / account, not the repo. The
agent can guide via the `browse` skill during implementation, but the actual
provisioning and any 2FA is user-driven. Order so the **new host is live before**
the selector flip and before the Task 4 Clerk repoint.

1. **Provision the new custom domain per worker.** Two equivalent routes:
   - **Via wrangler (preferred, in the same deploy):** because each new
     `custom_domain: true` route is in `wrangler.jsonc`, `wrangler deploy` (i.e.
     the normal push-to-`main` Workers Build, or `gob run bin/deploy`) creates
     the custom domain and kicks off cert provisioning automatically.
   - **Via Dashboard (manual):** Workers & Pages → `zerovault-api` (resp.
     `zeroerrors-api`) → Settings → Domains & Routes → Add → Custom Domain →
     `vault.juanibiapina.dev` (resp. `errors.juanibiapina.dev`).
2. **Cert provisioning wait.** Cloudflare issues a fresh edge cert for each new
   host. This can lag minutes. Wait until the custom domain shows **Active** and
   the cert is issued before repointing anything.
3. **DNS record.** `vault.juanibiapina.dev` and `errors.juanibiapina.dev` were
   checked live and have **no pre-existing DNS record** — both hostnames are
   verified free, so custom-domain provisioning will not collide with an
   existing record. For a custom domain on a zone Cloudflare already manages
   (`juanibiapina.dev`), Cloudflare creates the proxied record automatically as
   part of provisioning. After deploy, confirm the `vault` / `errors` records
   exist and are proxied. No manual CNAME is normally required for
   `custom_domain` routes; verify rather than add.
4. **Verify the new host serves the app** (see Verification) before Step 2 of
   the in-repo work (the `products.ts` flip) and before Task 4 repoints Clerk.

---

## Interlock with Task 4 (Clerk)

Login on the new hosts requires the new origins to be in the shared SaaS Clerk
instance's **allowed origins / allowed redirect origins**. That change belongs
to **Task 4**, not Task 3. Ordering dependency:

- Task 4 adds `https://vault.juanibiapina.dev` and
  `https://errors.juanibiapina.dev` (and keeps the old `zerovault.` /
  `zeroerrors.` origins during cutover) to the Clerk instance.
- Until Task 4 adds them, a fresh login attempt initiated on the new host can be
  rejected by Clerk. So: the new host can **serve** the SPA immediately after
  provisioning, but **login on the new host is not guaranteed** until Task 4
  lands the origins.
- Sessions/cookies are unaffected by the host rename as long as Clerk allows the
  origin: the session cookie is scoped to the parent domain `juanibiapina.dev`,
  so `vault.` and `errors.` share it with any already-signed-in tab.

Keep Task 3's own diff limited to wrangler `routes[]` + `products.ts` +
CHANGELOG. Do not touch Clerk config in this task.

---

## Old-host handling

**Recommendation: keep `zerovault.` / `zeroerrors.` attached indefinitely.**
They cost nothing, they keep every existing consumer working, and the rename is
**purely additive for the web / branding**. Removing them is out of scope for
this task (see below).

- Simplest and safest: both custom domains stay attached, both serve the same
  worker bundle, both work. No redirect needed for correctness because the
  selector and Clerk move to the new hosts while the old ones keep functioning
  for any bookmarked link.
- **Optional nicety (later):** add a redirect from the old hosts to the new ones
  so bookmarks land on the branded URL. This is not required and adds a small
  worker code path; defer it. If wanted, it is a follow-up, not part of Task 3.

### Removing the old custom domains is OUT OF SCOPE (deferred)

> **Update (2026-07-22):** this section conflates the API hosts with the bare web
> hosts. The bare **web** hosts `vault.juanibiapina.dev` /
> `errors.juanibiapina.dev` were later dropped by
> `docs/plans/drop-old-console-hosts.md` (no users yet, no value in preserving old
> bookmarks). The `zerovault.` / `zeroerrors.` **API** hosts below remain attached
> — they still have live consumers, as this section explains.

The same worker + custom domain serves **both** the SPA and the API on each
host: `run_worker_first: ["/ping", "/v1/*", "/api/*"]` in
`apps/vault-api/wrangler.jsonc` and `apps/errors-api/wrangler.jsonc` routes
those paths to worker code, so the old hosts are not web-only — they have live
API consumers. Removing the old custom domains would break these, and one of
the breakages is **silent**:

- **ZeroErrors ingest (fire-and-forget, silent breakage).**
  `apps/agent-api/src/reporting/zero-errors.ts` hardcodes
  `ENDPOINT = "https://zeroerrors.juanibiapina.dev/v1/errors"`. The reporter
  never rejects, so if the host went away, error reporting would just stop with
  no signal. Its test `apps/agent-api/src/reporting/zero-errors.test.ts` asserts
  that exact URL.
- **ZeroVault CLI + secret.** `packages/zerovault-cli/src/index.ts` sets
  `DEFAULT_BASE_URL = "https://zerovault.juanibiapina.dev"`, and `docs/secrets.md`
  documents `ZEROVAULT_API_URL = https://zerovault.juanibiapina.dev`. Both the
  in-repo secrets tooling and any external CLI user rely on the old host.

Because of this, **keep the old hosts serving the API indefinitely** — the
default and recommended path. Do **not** remove the old custom domains as part
of this task.

If old-host removal is ever undertaken as a future cleanup, it is **gated on a
precondition**: first repoint every API consumer above (the `zero-errors.ts`
ENDPOINT + its test, the `zerovault-cli` `DEFAULT_BASE_URL`, and the
`ZEROVAULT_API_URL` secret in `docs/secrets.md`) to the new hosts, ship and
verify those, and only then delete the old `routes[]` entries and Cloudflare
custom domains. That is a separate, user-driven task, not this one.

---

## Sequencing (risky/irreversible parts LAST)

1. **[In-repo]** Add the new `custom_domain` routes to both wrangler files
   (keep old). Deploy. This provisions the new custom domains + certs. Old hosts
   still serve. Reversible (revert the added route + redeploy).
2. **[Cloudflare, user-driven]** Wait for both new custom domains to go Active
   with issued certs. Verify each new host serves the app.
3. **[Task 4, separate]** Add the new origins to Clerk allowed origins (keep old
   origins). This unblocks login on the new hosts.
4. **[In-repo]** Flip the two `products.ts` prod constants to `vault.` /
   `errors.`. Deploy both web apps. The selector now cross-links the new hosts.
   Ship the CHANGELOG entry with this. Reversible (revert one line + redeploy).
5. **[OUT OF SCOPE — optional future cleanup, gated]** Removing the old
   `zerovault.` / `zeroerrors.` custom domains is **deferred and not part of
   this task**. The old hosts also serve live API consumers (see "Removing the
   old custom domains is OUT OF SCOPE"), so removal is gated on a precondition:
   first repoint every API consumer (the `zero-errors.ts` ENDPOINT + its test,
   the `zerovault-cli` `DEFAULT_BASE_URL`, and the `ZEROVAULT_API_URL` secret),
   ship and verify, and only then delete the `routes[]` entries + Cloudflare
   custom domains (and, if chosen, the old Clerk origins). Recommended default:
   **never remove them** — they cost nothing and keep consumers working. This is
   the only irreversible step and it runs as a separate, user-present task.

Steps 1 and 4 are the in-repo diff for this task. Steps 2 and 3 are
outside-repo / user-driven. Step 5 is deferred out of scope.

---

## Verification

`gob run bin/ci` cannot run whole-repo locally (untouched vault/errors workers
boot `workerd`, which will not start on this dev box). Verify the touched
packages directly instead.

**Per-package (local, after each in-repo edit):**

```bash
pnpm --filter @zero/ui run typecheck
pnpm --filter @zero/ui run lint
pnpm --filter @zero/agent-web run build   # sanity; unaffected
pnpm --filter @zero/vault-web run typecheck && pnpm --filter @zero/vault-web run lint && pnpm --filter @zero/vault-web run build
pnpm --filter @zero/errors-web run typecheck && pnpm --filter @zero/errors-web run lint && pnpm --filter @zero/errors-web run build
```

(`@zero/ui` has `typecheck` + `lint`; the two web apps have `typecheck`, `lint`,
`build`.) The wrangler-only change to `vault-api` / `errors-api` needs no local
`workerd` run; rely on the Cloudflare deploy to apply the route.

**Post-deploy (both new hosts):**

- `curl -sI https://vault.juanibiapina.dev/ | head -1` → `200`, serves the SPA
  shell (not a Cloudflare error page).
- `curl -sI https://errors.juanibiapina.dev/ | head -1` → `200`.
- `curl -s https://vault.juanibiapina.dev/ping` and `.../errors` `/ping` still
  200 (worker routes intact).
- Confirm in the Cloudflare Dashboard (or `wrangler deployments`/domains) that
  each worker's deployment picked up the **new** custom domain and it is Active.
- The fully rendered, signed-in app view is **behind Clerk login**, so the
  rendered check depends on Task 4's origins being live. Before Task 4, a 200 +
  SPA shell on the new host is the verifiable signal; the logged-in render is
  verified after Task 4.

**Old hosts (should still work through cutover):**

- `curl -sI https://zerovault.juanibiapina.dev/ | head -1` → `200`.
- `curl -sI https://zeroerrors.juanibiapina.dev/ | head -1` → `200`.

---

## Rollback

- **Step 1/4 (route add + products.ts flip):** revert the wrangler `routes[]`
  addition and the one-line `products.ts` change, redeploy. Because the old
  custom domains stay attached the whole time, there is **no downtime** — the
  old hosts still serve and the selector points back at them.
- **Step 5 (old-host removal) is out of scope**, so this task creates no
  irreversible state. If a future cleanup ever removes the old custom domains
  and something regresses, re-add them (re-add the `routes[]` entries +
  redeploy, and re-create the Cloudflare custom domain / DNS). That is why
  removal is deferred, gated on repointing API consumers, and user-driven.

---

## Skills to use during implementation

- `code` — making the wrangler + `products.ts` edits.
- `changelog` — writing the user-facing CHANGELOG bullet (flat dated format).
- `cloudflare` — custom domains / DNS / Workers Assets for the provisioning
  steps.
- `browse` — guiding the user through the Cloudflare Dashboard provisioning /
  verification (user-driven, may hit 2FA).
- `git-commit` — committing the change (code + CHANGELOG together).

## Acceptance criteria

- `apps/vault-api/wrangler.jsonc` and `apps/errors-api/wrangler.jsonc` carry both
  the old and the new `custom_domain` routes during cutover; worker `name`, KV
  id, DO classes, and migration tags are unchanged.
- `packages/ui/src/products.ts` prod constants point at `vault.` / `errors.`;
  the `VITE_VAULT_URL` / `VITE_ERRORS_URL` dev overrides still work.
- `https://vault.juanibiapina.dev` and `https://errors.juanibiapina.dev` return
  200 and serve their app; old hosts still 200.
- The user-facing CHANGELOG entry (merged into the 2026-07-21 brand/switcher
  bullet, naming the new URLs) ships in the same change.
- No old-host removal happens in this task: the old `zerovault.` /
  `zeroerrors.` custom domains stay attached and keep serving their API
  consumers. Removal is deferred out of scope and gated on repointing those
  consumers first.
