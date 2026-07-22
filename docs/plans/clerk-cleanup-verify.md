# Verify: `clerk-cleanup.md` (post-rename Clerk cleanup)

Adversarial review of `docs/plans/clerk-cleanup.md`. Focus: safety of the
automatable Item 2 DNS prune against the production zone `juanibiapina.dev`.
All probes below run live from this box on 2026-07-22.

## Verdict

**GO.** All 5 target DNS records are independently confirmed orphaned and safe to
delete; their record ids in the plan match the live zone exactly; the CF token is
active. Items 1 and 3 are correctly routed as manual and are low-risk. **No record
should be blocked from deletion.** Fix the concerns below before executing so the
plan carries the real per-record proof (not extrapolation) and explicitly fences
off the one live `zerovault.*` record that must survive.

Counts: **0 blockers, 3 concerns, 3 nits.**

---

## What I verified live (evidence)

FAPI / portal probes:

```
clerk.apps.juanibiapina.dev      /v1/environment -> 200   (live instance bound)
clerk.zerovault.juanibiapina.dev /v1/environment -> 403   (no instance bound; old domain retired)
accounts.zerovault  /  -> 403
accounts.apps       /  -> 403   (403 at root is normal for the portal; not a liveness signal)
```

Cloudflare zone `795ecc3f79ef50dec600e0a328485c63`, live record list — the 5
targets, ids **match the plan verbatim**:

```
7220c19d8618c716b271e22f5dca9eb7  clerk.zerovault           CNAME frontend-api.clerk.services
277c993e03035fabf3d5764b2057676f  accounts.zerovault        CNAME accounts.clerk.services
4738642e43353ca513989679dc15e5c9  clkmail.zerovault         CNAME mail.wbydxyd1tyww.clerk.services
d9c396098e8a19b19326e03082dcd224  clk._domainkey.zerovault  CNAME dkim1.wbydxyd1tyww.clerk.services
347bd488ddd058ade222f5550ac56f6d  clk2._domainkey.zerovault CNAME dkim2.wbydxyd1tyww.clerk.services
```

Live pair that must survive (present, untouched):

```
c36c1b69cb6607557004f6feb538c1a9  clerk.apps      CNAME frontend-api.clerk.services
cf3b4462923edca5a76e02a627f23ca6  accounts.apps   CNAME accounts.clerk.services
```

Decisive new evidence the plan does not use — the live instance's mail/DKIM
identity is a **different Clerk mail hash** from the old records:

```
clkmail.apps       -> mail.j8iappzd22dx.clerk.services      (LIVE)
clk._domainkey.apps-> dkim1.j8iappzd22dx.clerk.services     (LIVE)
clk2._domainkey.apps-> dkim2.j8iappzd22dx.clerk.services    (LIVE)

clkmail.zerovault  -> mail.wbydxyd1tyww.clerk.services      (OLD, to delete)
clk._domainkey.zvt -> dkim1.wbydxyd1tyww.clerk.services     (OLD)
clk2._domainkey.zvt-> dkim2.wbydxyd1tyww.clerk.services     (OLD)
```

The live instance transmits email/DKIM under `j8iappzd22dx`; the records slated
for deletion belong to the retired `wbydxyd1tyww` identity. This answers the
"could deleting DKIM/clkmail break Clerk email?" question directly: **no — the
instance's email is on the new `apps.` domain, not the old one.**

Token: `user/tokens/verify` -> `status: active` (can delete). gcloud: **no
credentialed account** (Item 3 manual — confirmed). No `CLERK_*` in env (Item 1
manual — confirmed). Repo grep: only `docs/` and `tasks.md` reference
`clerk.zerovault.*`; the only live-code `zerovault.juanibiapina.dev` refs are the
vault **API** host (`apps/vault-api/wrangler.jsonc` route,
`packages/zerovault-cli` default base URL) — unrelated to Clerk. The plan's
"no live repo dependency" claim holds.

---

## Concerns

### C1 — 4 of the 5 records are proven orphaned only by extrapolation in the plan

Question 1 is the sharp one. The plan proves `clerk.zerovault` dead via the FAPI
403, then for `accounts.zerovault`, `clkmail.zerovault`, and the two `_domainkey`
records it falls back to a **name check** ("`.zerovault.` present, `.apps.`
absent") plus "they point at old Clerk mail/DKIM targets." That is extrapolation
from one probe, exactly as the question suspects. The per-record `curl` in the
safety-gate snippet even probes `clerk.zerovault` unconditionally (see N1), so it
adds nothing for the other four.

The records are in fact safe — I established it above — but the **plan as written
does not carry that proof.** Fix: fold the live evidence into the Item 2 gate so
each record has a real justification:

- `clerk.zerovault`: FAPI 403 (direct). Already in the plan.
- `accounts.zerovault`: the old domain is fully retired (the same domain's FAPI
  returns 403; a domain still registered on the instance would serve its FAPI),
  and the live portal is `accounts.apps` (200-live FAPI + docs). Clerk provisions
  a domain's FAPI / portal / mail / DKIM records as one set, so a retired FAPI
  means the whole `zerovault.` set is retired.
- `clkmail` / `clk._domainkey` / `clk2._domainkey`: the live mail identity is
  `j8iappzd22dx` (the `apps.` records), **not** the `wbydxyd1tyww` identity these
  point at. Deleting `wbydxyd1tyww` records cannot affect live email/DKIM.

With that added, all 5 clear on their own evidence, not by extension from record
(a).

### C2 — The plan never names the live `zerovault.*` record that must NOT be deleted

The zone contains a 6th `zerovault` record the plan omits:

```
zerovault.juanibiapina.dev  AAAA  100::
```

`100::` is the IPv6 discard placeholder used to attach a Worker route to a
hostname — this is the **live vault API host** (`apps/vault-api/wrangler.jsonc`
route `zerovault.juanibiapina.dev`, `zerovault-cli` `DEFAULT_BASE_URL`). It is not
in the delete list, so the explicit id-based deletes won't hit it, and the plan's
`.zerovault.` substring filter would not match the apex name either. But a plan
about "prune orphaned `zerovault.*` DNS" that never mentions this record invites a
future operator to over-match. Add an explicit **"do not touch
`zerovault.juanibiapina.dev` (AAAA `100::`) — it is the live vault API host"**
line to the Item 2 exclusion list, next to the `clerk.apps` / `accounts.apps`
survivors.

### C3 — "No changelog" conflicts with the user-visible sign-in card rename

Item 1 changes the sign-in card from "Sign in to **ZeroVault**" to "Sign in to
**Zero**" on `vault.apps` / `errors.apps`. That is user-observable, which
`AGENTS.md` says requires a changelog bullet. The console entry lives in the root
`CHANGELOG.md`. The plan's flat "No changelog — internal infra hygiene" is wrong
for Item 1 specifically (Items 2 and 3 are genuinely invisible and need none).
Fix: add one root `CHANGELOG.md` line for the rename (a changelog-only commit is
legitimate; the "empty repo diff" acceptance criterion should be relaxed to allow
it). Low urgency, but it contradicts the repo's own rule as written.

---

## Nits

### N1 — The per-record safety-gate snippet hardcodes the `clerk.zerovault` probe

In the Item 2 gate, `NAME` iterates over all 5 records but the liveness `curl` is
always `https://clerk.zerovault.juanibiapina.dev/v1/environment`. For
`accounts`/`clkmail`/`_domainkey` that line is a no-op that looks like a check.
The plan admits this in prose ("no FAPI probe"), but the copy-paste snippet still
invites false confidence. Either drop the probe line for the 4 non-FAPI records or
replace it with the C1 evidence (mail-hash comparison, old-domain-retired note).

### N2 — Make reversibility explicit: log the deleted CNAME target

The list step captures `id`, `type`, `content`, so recreation data exists, and the
findings table already records every target. Say so explicitly: "before each
delete, record `name + type + content + proxied=false`; to roll back, re-create
the CNAME with the same target." Cheap insurance for a production-zone mutation.

### N3 — Item 1 dashboard path may have drifted; the BAPI claim is untestable here

The plan's "Configure -> Settings -> Application name" path and the assertion that
the Clerk **Backend** API cannot rename an application are both plausible but not
verifiable from this box (no `sk_live`, and the app-rename endpoint is Dashboard
/ internal Dashboard-API, not public BAPI). It does not matter operationally —
no Clerk key exists here, so Item 1 is manual regardless, which the plan states.
Keep the "check Customization -> Branding if the card still shows the old name"
fallback; that hedge covers the path drift.

---

## Item-by-item answers to the review questions

1. **Per-record sufficiency:** No — the plan proves only `clerk.zerovault` per se
   and extrapolates the other four (C1). I closed the gap with live evidence; all
   5 are genuinely orphaned. Add that evidence to the plan.
2. **Real list->verify->delete gate + reversible/recorded:** Yes to the gate
   (list captures id + content, delete by id, re-list to confirm). Reversibility
   is implicit; make it explicit (N2).
3. **No live config depends on the 5 records:** Confirmed. Repo has no live
   dependency; the live instance's email/DKIM is on the new `j8iappzd22dx`
   (`apps.`) identity, so deleting the old `wbydxyd1tyww` mail/DKIM records cannot
   break Clerk transactional email. The old FAPI/portal are unbound (403).
4. **Manual-vs-automatable + click-paths:** Correct. Item 2 automatable (token
   active, ids match). Items 1 and 3 manual (no Clerk key, no gcloud auth).
   Click-paths adequate; Item 1 path has minor drift risk (N3), already hedged.
5. **"No repo change, no commit, no changelog":** Mostly right, except the
   user-visible rename should get a root `CHANGELOG.md` entry (C3).
6. **Risk ordering / blast radius:** Ordering (cosmetic -> orphaned DNS -> shared
   OAuth) is sound. Item 3's shared-client risk is handled: the old
   `clerk.zerovault/v1/oauth_callback` is unreachable (FAPI 403), so no live flow
   uses it; removing it can't break the live `clerk.apps` callback, and the plan
   verifies the remaining URI list before saving and re-adds on error. Live login
   is not at risk.

---

## Records: keep vs delete (final)

| Record | Action | Proof it is safe |
|---|---|---|
| `clerk.zerovault` | delete | FAPI 403 (unbound) |
| `accounts.zerovault` | delete | old domain retired (FAPI 403 for the set); live portal = `accounts.apps` |
| `clkmail.zerovault` | delete | live mail id = `j8iappzd22dx`, not `wbydxyd1tyww` |
| `clk._domainkey.zerovault` | delete | live DKIM id = `j8iappzd22dx`, not `wbydxyd1tyww` |
| `clk2._domainkey.zerovault` | delete | live DKIM id = `j8iappzd22dx`, not `wbydxyd1tyww` |
| `clerk.apps` / `accounts.apps` | **KEEP** | live instance (FAPI 200) |
| `zerovault.juanibiapina.dev` (AAAA `100::`) | **KEEP** | live vault API host (Worker route) — not in plan, add to exclusions (C2) |
