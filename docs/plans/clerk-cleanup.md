# Plan: Post-rename Clerk cleanup (infra/dashboard hygiene)

## Goal (three cleanups)

1. **Rename the Clerk application display name** "ZeroVault" -> "Zero" so the
   sign-in card reads "Sign in to Zero" (console Clerk instance / ZeroVault app).
   Likely a manual Clerk Dashboard action unless the Clerk Backend API can do it
   with an available key.
2. **Prune orphaned DNS for the OLD Clerk domain** in the Cloudflare zone
   `juanibiapina.dev` — records no longer used by the instance:
   `clerk.zerovault`, `accounts.zerovault`, `clkmail.zerovault`,
   `clk._domainkey.zerovault`, `clk2._domainkey.zerovault`. CONFIRM each is
   unused before deleting. This is automatable via the Cloudflare API (wrangler
   is authed via CLOUDFLARE_API_TOKEN; account
   4e04b64af4013414441c59014392bea0, zone juanibiapina.dev).
3. **Remove the unused old redirect URI from the Google OAuth client**
   `566245288679-...apps.googleusercontent.com` (project zerovault-497513):
   delete `https://clerk.zerovault.juanibiapina.dev/v1/oauth_callback`. KEEP
   `https://clerk.apps.juanibiapina.dev/v1/oauth_callback` and the
   `good-wallaby-70...` dev one. Manual Google Cloud Console action (unless a
   gcloud CLI is authed for that project).

All low-risk; verify login still works after each.

---

## What this task changes

The DNS prune (Item 2) and the Google OAuth cleanup (Item 3) are pure
infra/dashboard actions with **no repo change** — nothing in the repo references
the old `clerk.zerovault.*` Clerk hostnames in a live way (confirmed below), so
there is nothing to edit or commit for those two.

**One conditional repo change: a `CHANGELOG.md` line for Item 1.** Renaming the
Clerk app display name flips the console sign-in card from "Sign in to ZeroVault"
to "Sign in to Zero" on `vault.apps.*` / `errors.apps.*`. That is
user-observable, and per `AGENTS.md` a user-visible console change gets a bullet
in the **root** `CHANGELOG.md`. Item 1 is a manual Clerk Dashboard action with no
code to commit, so this one changelog line is the sole repo artifact this task
produces, and it is **conditional on Item 1 actually being done**: when the user
confirms the rename shipped (sign-in card reads "Sign in to Zero"), add and commit
the entry (see Item 1 for exact wording). Items 2 and 3 are genuinely invisible to
users and get no changelog entry.

So the end state is: DNS prune = no repo change; Google OAuth = no repo change;
the Clerk rename adds exactly one root `CHANGELOG.md` line (changelog-only commit).
Do not manufacture any other commit.

---

## Findings (recon 2026-07-22, this box)

### Credentials available here

| Need | Available? | Consequence |
|---|---|---|
| Cloudflare API (DNS) | **Yes** — `CLOUDFLARE_API_TOKEN` set; `wrangler whoami` = account `4e04b64af4013414441c59014392bea0` (juanibiapina@gmail.com) | Item 2 is **automatable here** |
| gcloud authed for `zerovault-497513` | **No** — `gcloud` binary present but `gcloud auth list` shows "No credentialed accounts" | Item 3 is **manual** |
| Clerk Backend API key (console instance) | **No** — no `CLERK_*` in env | Item 1 is **manual** (and see note below: the display name is not a Backend API operation regardless) |

### Which Clerk hosts are live vs orphaned (decisive)

The live console Clerk instance is `ins_3EGKil7J2EWNSe96p54lMOqt25X` / app
`app_3EGJu5MjQcEhWYQgYeHUwhwJDTr`, primary domain `apps.juanibiapina.dev`,
Frontend API `clerk.apps.juanibiapina.dev`, Hobby plan (per `docs/console-auth.md`
and `docs/plans/console-signin-redirect.md`).

Confirmed live-vs-orphaned three independent ways:

1. **Deployed publishable key** on `https://vault.apps.juanibiapina.dev`
   (`/assets/index-*.js`) is `pk_live_Y2xlcmsuYXBwcy5qdWFuaWJpYXBpbmEuZGV2JA`,
   which base64-decodes to `clerk.apps.juanibiapina.dev$` — the app's Frontend
   API is the `*.apps.*` host, not `*.zerovault.*`.
2. **Frontend API liveness probe:**
   - `GET https://clerk.apps.juanibiapina.dev/v1/environment` -> **HTTP 200**
     (an instance is bound to this host).
   - `GET https://clerk.zerovault.juanibiapina.dev/v1/environment` -> **HTTP 403**
     (no instance bound — orphaned).
3. **Docs** (`docs/console-auth.md`) explicitly record the Frontend API moved off
   `clerk.zerovault.juanibiapina.dev` to `clerk.apps.juanibiapina.dev`, and the
   `clerk.zerovault.*` host is superseded.

Caveat that shapes the safety step: both old and new `clerk.*` CNAMEs point to
the **same** shared Clerk target `frontend-api.clerk.services`, so you cannot
tell old from new by CNAME target alone. Distinguish by hostname (`*.zerovault.*`
= old) plus the 403-vs-200 FAPI probe above. That is why the delete steps below
verify by name + probe, not by target.

### The 5 orphaned DNS records (live values, zone `juanibiapina.dev`)

Zone id (resolved via `GET /zones?name=juanibiapina.dev`):
**`795ecc3f79ef50dec600e0a328485c63`**. (Note: `4e04b64af4013414441c59014392bea0`
in the goal is the *account* id; the DNS API needs the *zone* id below.)

| # | Name (FQDN) | Type | Content (target) | Record id |
|---|---|---|---|---|
| a | `clerk.zerovault.juanibiapina.dev` | CNAME | `frontend-api.clerk.services` | `7220c19d8618c716b271e22f5dca9eb7` |
| b | `accounts.zerovault.juanibiapina.dev` | CNAME | `accounts.clerk.services` | `277c993e03035fabf3d5764b2057676f` |
| c | `clkmail.zerovault.juanibiapina.dev` | CNAME | `mail.wbydxyd1tyww.clerk.services` | `4738642e43353ca513989679dc15e5c9` |
| d | `clk._domainkey.zerovault.juanibiapina.dev` | CNAME | `dkim1.wbydxyd1tyww.clerk.services` | `d9c396098e8a19b19326e03082dcd224` |
| e | `clk2._domainkey.zerovault.juanibiapina.dev` | CNAME | `dkim2.wbydxyd1tyww.clerk.services` | `347bd488ddd058ade222f5550ac56f6d` |

**Do-not-delete list (records that MUST survive — never touch):**

| Name (FQDN) | Type | Content | Record id | Why it survives |
|---|---|---|---|---|
| `clerk.apps.juanibiapina.dev` | CNAME | `frontend-api.clerk.services` | `c36c1b69cb6607557004f6feb538c1a9` | live instance FAPI (200) |
| `accounts.apps.juanibiapina.dev` | CNAME | `accounts.clerk.services` | `cf3b4462923edca5a76e02a627f23ca6` | live account portal |
| `zerovault.juanibiapina.dev` | AAAA | `100::` | (re-list before acting) | **live vault API host** — Worker route (`apps/vault-api/wrangler.jsonc`, `zerovault-cli` `DEFAULT_BASE_URL`) |

The `zerovault.juanibiapina.dev` AAAA `100::` record is the IPv6 discard
placeholder Cloudflare uses to attach a Worker route to a hostname; it is the
**live vault API endpoint**, unrelated to Clerk, and is NOT in the delete list.
The five deletes below are by explicit record id so they can't hit it, and the
`.zerovault.` substring in the safety gate does not match this apex name — but it
is listed here explicitly so no operator over-matches "prune `zerovault.*`" and
deletes the vault API.

Record ids can drift; re-list immediately before deleting (steps below) rather
than trusting these verbatim.

### Decisive per-record evidence each of the 5 is orphaned (not extrapolation)

Every deletion is backed by direct live evidence, not inferred from the
`clerk.zerovault` probe alone:

| Record | Proof it is safe to delete |
|---|---|
| `clerk.zerovault` | FAPI `/v1/environment` -> **403** (no instance bound); live FAPI is `clerk.apps` (200). Direct. |
| `accounts.zerovault` | The whole `zerovault.` domain is retired: its FAPI returns 403 (a domain still registered on the instance would serve its FAPI), and the live portal is `accounts.apps` (200 FAPI + docs). Clerk provisions a domain's FAPI/portal/mail/DKIM as one set, so a retired FAPI means the entire `zerovault.` set is retired. |
| `clkmail.zerovault` | The live instance's mail identity is the **`j8iappzd22dx`** Clerk mail hash (`clkmail.apps -> mail.j8iappzd22dx.clerk.services`). This record points at the **old `wbydxyd1tyww`** identity (`mail.wbydxyd1tyww.clerk.services`). The instance emails on the new `apps.` domain, so deleting the old-hash record cannot break Clerk transactional email. |
| `clk._domainkey.zerovault` | Same split: live DKIM is `dkim1.j8iappzd22dx.clerk.services` (the `apps.` record); this points at `dkim1.wbydxyd1tyww.clerk.services` (old hash). Deleting it cannot affect live DKIM signing. |
| `clk2._domainkey.zerovault` | Same: live `dkim2.j8iappzd22dx.clerk.services`; this is `dkim2.wbydxyd1tyww.clerk.services` (old hash). |

**Mail-hash check the executor re-derives at delete time** (this is the crux for
the three mail/DKIM records): compare the live `apps.` mail/DKIM CNAME targets
against the `zerovault.` records' targets. They must carry **different** Clerk
mail hashes for the delete to be safe.

```bash
# Live instance mail/DKIM identity (the apps. records) — note the hash after "mail."/"dkim1."/"dkim2."
for n in clkmail clk._domainkey clk2._domainkey; do
  printf '%-18s -> ' "$n.apps"
  dig +short CNAME "$n.apps.juanibiapina.dev"
done
# Old records slated for deletion — must show a DIFFERENT hash
for n in clkmail clk._domainkey clk2._domainkey; do
  printf '%-18s -> ' "$n.zerovault"
  dig +short CNAME "$n.zerovault.juanibiapina.dev"
done
# ASSERT: the apps. targets contain one hash (expected j8iappzd22dx) and the
# zerovault. targets contain a DIFFERENT hash (expected wbydxyd1tyww). If they
# ever match, STOP — the old records would be the live mail identity; do not delete.
```

(The `dig` targets can also be read straight from the Cloudflare API list in the
gate below; either source works for the hash comparison.)

### No live repo dependency on the old Clerk hostnames

`rg clerk.zerovault` outside `docs/` and `tasks.md` returns nothing. The only
`zerovault.juanibiapina.dev` references in live code are the **API** host
(`apps/vault-api/wrangler.jsonc` route `zerovault.juanibiapina.dev`,
`packages/zerovault-cli` `DEFAULT_BASE_URL`), which is the vault API endpoint —
unrelated to Clerk and not in scope. Nothing depends on `clerk.zerovault.*`,
`accounts.zerovault.*`, or the `clkmail`/`clk*._domainkey.zerovault.*` mail/DKIM
records.

---

## Items, ordered safest-first

Ordering rationale: item 1 is cosmetic (no functional path touched) -> safest.
Item 2 deletes DNS that is already confirmed orphaned (FAPI 403, nothing uses
it). Item 3 edits the **live, shared** Google OAuth client, so a slip there has
the widest blast radius (all Google sign-in) — do it last, most carefully. Verify
login after each.

### Item 1 — Rename Clerk application display name "ZeroVault" -> "Zero"  (MANUAL)

**Why manual:** No Clerk Backend API key is present here, and — even with an
`sk_live` — the Clerk Backend API (`api.clerk.com/v1`) manages users, orgs,
sessions, invitations, and allowlists, **not** the application/instance display
name. Renaming the application is a Clerk Dashboard-only operation. So this is
manual regardless of key availability.

**Manual click-path (user):**
1. Clerk Dashboard -> select the **console** application (currently "ZeroVault",
   app `app_3EGJu5MjQcEhWYQgYeHUwhwJDTr`, instance
   `ins_3EGKil7J2EWNSe96p54lMOqt25X`). Do **not** touch the separate **agent**
   Clerk instance (`clerk.zero.juanibiapina.dev`).
2. **Configure -> Settings** (application settings). Change **Application name**
   from `ZeroVault` to `Zero`. Save.
   - The sign-in card heading "Sign in to <name>" is driven by this application
     name, so this is the field that makes the card read "Sign in to Zero".
3. If a separate branding/display string exists under **Customization ->
   Branding** ("Application name" shown in the `<SignIn>`/`<SignUp>` components),
   set it to `Zero` there too. The Settings name is the source of truth; check
   Branding only if the card still shows the old name after save.

**Verification:**
- Open `https://vault.apps.juanibiapina.dev` signed out in a fresh incognito
  window; the Clerk sign-in card heading reads **"Sign in to Zero"**.
- Complete a Google sign-in and confirm you still land signed in on
  `vault.apps.juanibiapina.dev` (login unaffected by a display-name change).

**Changelog (do this once the rename is confirmed live):** the card change is
user-observable, so add one bullet to the **root** `CHANGELOG.md` (the console
changelog — NOT `apps/agent-api/CHANGELOG.md`) and commit it. This is the only
repo artifact this task produces, and only if Item 1 shipped. Load the
`changelog` skill for format; write from the user's perspective, dated, e.g.:

```
- 2026-07-22: The console sign-in card now reads "Sign in to Zero" (was "ZeroVault"), matching the unified Zero brand.
```

Match the existing root `CHANGELOG.md` bullet style (a dated line under the header
list). Do not add a bullet for Items 2 or 3 — they are invisible to users.

### Item 2 — Prune the 5 orphaned `*.zerovault.*` DNS records  (AUTOMATABLE HERE)

Automatable now via the Cloudflare DNS records API with the box's
`CLOUDFLARE_API_TOKEN`. Per-record: **list -> verify -> delete**, never a blind
delete. Do them one at a time and re-verify after each.

**Setup (resolve zone id fresh):**
```bash
ZID=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=juanibiapina.dev" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"][0]["id"])')
echo "$ZID"   # expect 795ecc3f79ef50dec600e0a328485c63
```

**Per-record safety gate — generic list -> confirm -> delete -> log-deleted-target.**
Run this loop for EACH of the 5 names, one at a time, re-verifying after each. The
gate is the same shape for every record (no hardcoded per-record probe); the
per-record *evidence* that it is orphaned is the table in Findings above, and each
record's own list output (its target) confirms which Clerk identity it belongs to.

```bash
# The 5 names to prune, and the do-not-delete guard set.
DELETE_NAMES="clerk.zerovault accounts.zerovault clkmail.zerovault clk._domainkey.zerovault clk2._domainkey.zerovault"
DO_NOT_DELETE="clerk.apps.juanibiapina.dev accounts.apps.juanibiapina.dev zerovault.juanibiapina.dev"

for short in $DELETE_NAMES; do
  NAME="$short.juanibiapina.dev"

  # GUARD: never proceed if NAME is on the do-not-delete list, or lacks ".zerovault.",
  # or is the apex vault API host.
  case " $DO_NOT_DELETE " in *" $NAME "*) echo "REFUSE (protected): $NAME"; continue;; esac
  case "$NAME" in *.zerovault.juanibiapina.dev) : ;; *) echo "REFUSE (not a .zerovault. host): $NAME"; continue;; esac

  # 1) LIST — capture id + type + target; abort if not exactly one record.
  REC=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/zones/$ZID/dns_records?name=$NAME")
  echo "$REC" | python3 -c 'import sys,json;[print(r["id"],r["type"],r["content"],"proxied="+str(r.get("proxied"))) for r in json.load(sys.stdin)["result"]]'
  RID=$(echo "$REC" | python3 -c 'import sys,json;rs=json.load(sys.stdin)["result"];print(rs[0]["id"] if len(rs)==1 else "")')
  TARGET=$(echo "$REC" | python3 -c 'import sys,json;rs=json.load(sys.stdin)["result"];print(rs[0]["content"] if len(rs)==1 else "")')
  [ -z "$RID" ] && { echo "REFUSE (not exactly one record): $NAME"; continue; }

  # 2) CONFIRM name + id + target match the Findings table (and, for the mail/DKIM
  #    records, that TARGET carries the OLD wbydxyd1tyww hash, not the live j8iappzd22dx).
  #    Human/agent eyeballs the printed id + target here before proceeding.

  # 3) LOG the deletion payload for rollback BEFORE deleting (reversible: re-create the
  #    same name/type/content, proxied=false, to roll back).
  echo "ROLLBACK-RECORD: name=$NAME type=CNAME content=$TARGET proxied=false" | tee -a /tmp/clerk-dns-deleted.log

  # 4) DELETE by the confirmed id.
  curl -s -X DELETE -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/zones/$ZID/dns_records/$RID" \
    | python3 -c 'import sys,json;print("deleted:",json.load(sys.stdin).get("success"))'
done
```

The gate deletes by the id it just listed and records the full recreate payload
(`name + type + content + proxied=false`) to `/tmp/clerk-dns-deleted.log` first,
so any delete is reversible by re-creating the CNAME with the logged target. The
per-record justification that each is orphaned lives in the Findings evidence
table (FAPI 403 for `clerk`/`accounts`; old-vs-live mail hash `wbydxyd1tyww` vs
`j8iappzd22dx` for `clkmail`/`clk*._domainkey`), which the executor re-confirms via
the mail-hash check above and the printed `TARGET` for each record.

**Verification (after all 5 deleted):**
- Re-list each name; the API returns an empty `result` for all 5.
- DNS no longer resolves the pruned names:
  ```bash
  for n in clerk accounts clkmail clk._domainkey clk2._domainkey; do
    dig +short "$n.zerovault.juanibiapina.dev" | head -1 | sed "s/^$/  (no record)/;s/^/  $n.zerovault: /"
  done
  ```
  (Allow for DNS/CDN cache; authoritative check is the empty API list above.)
- Live records untouched: `clerk.apps.juanibiapina.dev` still lists and
  `GET https://clerk.apps.juanibiapina.dev/v1/environment` still returns **200**;
  the `zerovault.juanibiapina.dev` AAAA `100::` vault-API record still lists.
- Login unaffected: complete a Google sign-in on
  `https://vault.apps.juanibiapina.dev` and land signed in.
- Vault API unaffected: `zerovault.juanibiapina.dev` (the vault API host) still
  resolves and responds (a quick request to the API, or the CLI, still works).

### Item 3 — Remove the old redirect URI from the Google OAuth client  (MANUAL)

**Why manual:** `gcloud` is installed but has **no credentialed account** for
project `zerovault-497513`, so there is no authed CLI path on this box. (If a
gcloud account with edit rights on `zerovault-497513` were later authed, the same
change is possible via the OAuth client update in the Google Cloud APIs, but
today it is manual.)

**Manual click-path (user):**
1. Google Cloud Console -> project **`zerovault-497513`** -> **APIs & Services ->
   Credentials**.
2. Open the OAuth 2.0 Client ID `566245288679-...apps.googleusercontent.com`.
3. Under **Authorized redirect URIs**, delete **only**:
   `https://clerk.zerovault.juanibiapina.dev/v1/oauth_callback`.
4. **KEEP** `https://clerk.apps.juanibiapina.dev/v1/oauth_callback` (the live
   Clerk callback) and the `good-wallaby-70...clerk.accounts.dev/v1/oauth_callback`
   dev URI. Do not remove or edit any other URI or the client secret.
5. Save. Google may warn changes take a few minutes to propagate.

**Pre-delete safety check:** before saving, confirm the remaining list still
contains the `clerk.apps.*` callback and the `good-wallaby-70...` dev callback.
The one being removed is the retired `clerk.zerovault.*` host (Item 2 also prunes
its DNS), which the live instance no longer uses.

**Verification:**
- The OAuth client's Authorized redirect URIs list no longer shows
  `https://clerk.zerovault.juanibiapina.dev/v1/oauth_callback`, and still shows
  the `clerk.apps.*` and `good-wallaby-70...` URIs.
- Real Google round trip (the only true proof): fresh incognito ->
  `https://vault.apps.juanibiapina.dev` -> "Continue with Google" -> lands signed
  in on vault. Repeat once on `https://errors.apps.juanibiapina.dev` (same Clerk
  instance, same Google client).

---

## Automatable-now vs needs-the-user (summary)

| Item | Automatable on this box? | Actor |
|---|---|---|
| 2 — prune 5 orphaned `*.zerovault.*` DNS records | **Yes** — Cloudflare API via `CLOUDFLARE_API_TOKEN` | Agent (with the list->verify->delete gate) |
| 1 — rename Clerk app display name to "Zero" | **No** — Dashboard-only (not a Backend API operation) | **User** (Clerk Dashboard) |
| 3 — remove old Google OAuth redirect URI | **No** — no authed gcloud for `zerovault-497513` | **User** (Google Cloud Console) |

## Skills to use

- `cloudflare` — the DNS records API (`GET`/`DELETE
  /zones/{zone_id}/dns_records`) and zone-id resolution for Item 2.
- `reproducible-locally` — framing verification so the login round trip is
  actually proven (the FAPI probe + a real Google sign-in), not assumed.
- `changelog` — for the single root `CHANGELOG.md` bullet recording the Item 1
  sign-in-card rename (load before editing the changelog).
- `git-commit` — when committing that one changelog line.

## Acceptance criteria

- Clerk console sign-in card reads **"Sign in to Zero"** (Item 1).
- The 5 `*.zerovault.*` DNS records no longer exist (empty API list) and no
  longer resolve; `clerk.apps.*` / `accounts.apps.*` untouched,
  `clerk.apps.juanibiapina.dev/v1/environment` still returns 200, and the live
  `zerovault.juanibiapina.dev` AAAA `100::` vault-API record is untouched (Item 2).
- The Google OAuth client no longer lists
  `https://clerk.zerovault.juanibiapina.dev/v1/oauth_callback`; the `clerk.apps.*`
  and `good-wallaby-70...` URIs remain (Item 3).
- Google sign-in still works end-to-end on both
  `vault.apps.juanibiapina.dev` and `errors.apps.juanibiapina.dev` after each
  change.
- The agent Clerk instance (`clerk.zero.juanibiapina.dev`) is untouched.
- Repo diff is exactly one line: the root `CHANGELOG.md` bullet recording the
  Item 1 sign-in-card rename (added and committed only once the rename is confirmed
  live). Items 2 and 3 produce no repo change. No `apps/agent-api/CHANGELOG.md`
  entry, no other commit.

## Risks / notes

- **Shared Clerk CNAME target (frontend hosts)**: old and new `clerk.*` records
  both point at `frontend-api.clerk.services`; never distinguish the two frontend
  hosts by target — use hostname + the 403/200 FAPI probe. For the mail/DKIM
  records the target IS decisive but the *opposite* way: old and live carry
  **different** Clerk mail hashes (`wbydxyd1tyww` old vs `j8iappzd22dx` live), so
  the mail-hash comparison proves the old records are safe to delete. Both encoded
  in the Findings evidence table and the Item 2 gate.
- **Live vault API record must survive**: `zerovault.juanibiapina.dev` AAAA
  `100::` is the vault API Worker route, not Clerk, and is NOT in the delete list.
  The gate's `DO_NOT_DELETE` guard and id-based deletes protect it; never
  over-match "prune `zerovault.*`" onto this apex record.
- **Record-id drift**: re-list right before each delete; don't trust the ids in
  this plan verbatim.
- **Item 3 blast radius**: the Google client is shared by the whole console Clerk
  instance; deleting the wrong URI breaks all Google sign-in. Verify the
  remaining list before saving. Reversible by re-adding the URI if needed.
- **Cache lag**: pruned DNS may resolve briefly from caches; the authoritative
  check is the empty Cloudflare API list, not `dig`.
