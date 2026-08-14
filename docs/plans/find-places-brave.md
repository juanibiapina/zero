# Plan: `find_places` over Brave Place Search

Assumes `docs/plans/user-country-capture.md` has landed, so `UserSettings.country`
holds an ISO 3166-1 alpha-2 code or `null` and is threaded into
`orchestrateTurn` beside `timezone`.

## Goal

One tool that answers "where can I get X around Y" with names, addresses,
distance, ratings, opening hours and contact details in a single call. Smallest
version that stands alone: no saved places, no routing, no maps, no location
ingest. Those are separate later steps and this design must not block them.

## Blocker cleared (2026-08-02)

The key is on the Search plan and the endpoint answers. Probed 2026-08-02:

```
GET /res/v1/local/place_search?q=ramen&location=berlin+germany&count=2
200 {"type":"locations","results":[{"title":"Iimori Ramen", ...}]}
GET /res/v1/web/search?q=test&count=1
200
```

The paid key is stored in ZeroVault `zero-api`, **both** `development` and
`production`, as `BRAVE_API_KEY`, replacing the old free-plan value. It is not
yet on disk or on the Worker: run `bin/fetch-secrets` for local dev and
`bin/sync-secrets-to-cloudflare` for the production Worker secret before
anything calls the endpoint.

History, kept because it explains the shape of the error handling below. On
2026-08-01 the then-current free key returned
`400 {"code":"OPTION_NOT_IN_PLAN"}` on both `/res/v1/local/place_search` and
`/res/v1/local/pois`, while `/res/v1/web/search` returned 200 on the same key
and `result_filter=web,locations` yielded no `locations` bucket. A subscription
gate, not a parameter mistake. Place Search sits on Brave's **Search plan**
($5 per 1,000 requests, $5 free credits monthly, 50 rps).

**Still do not write the mapper against documented shapes.** This module is
almost entirely field mapping, and mapping from docs alone is how silent nulls
ship. The 2026-08-02 probes proved the point immediately: two documented fields
never arrive (see "Verified API contract"). Save one real response and commit it
as the test fixture.

## Terms constraints

Brave's Search API Terms of Use (`https://api-dashboard.search.brave.com/terms-of-service`,
last updated 2026-02-11) bind what may be kept. §3(b)(i) allows only "transient
storage required for operation"; a plan granting storage rights is sold
separately and is not what we bought.

- **Never persist a `LocationResult` verbatim into a topic.** A topic body is
  durable by design and outlives the conversation, so no reading of the
  transient-storage exception reaches it. Places written to memory must be
  Zero's own synthesis plus a link, never a retained payload.
- POI `id` is separately barred by the Documentation (expires ~8h, "do not
  store"), and §4(b) makes the Documentation contractual. See the mapper rules
  below, which already drop it.
- Turn-scoped `tool_result` rows are fine: they are required for the loop to
  resume. What is not fine is keeping them forever, which is a pre-existing
  issue for `web_search` and out of scope here.
- A committed test fixture holding one real response is accepted: it is a fixed
  handful of records used to build the product, not an accumulating store.
- Attribution is optional under §4(d), so this tool ships none. If ever added it
  must read "POWERED BY BRAVE" with the logo.

## Provider rationale (settled)

Brave: same key, same header, same plan family as the web search Zero already
runs, so no new secret and no new account (`BRAVE_API_KEY` is already in
`apps/agent-api/wrangler.jsonc` `secrets.required`). Flat $5 per 1,000 with
every field included, against $32–35 per 1,000 for Google's Nearby/Text Search
Pro with per-field metering. Rejected: Foursquare (good, keep as the second
adapter if quality disappoints), HERE and TomTom (no ratings), Yelp
(subscription-first, US-centric, strict display terms), OSM/Overpass (no ratings
or ranking, usage policy hostile to product traffic).

## Verified API contract

```
GET https://api.search.brave.com/res/v1/local/place_search
    ?q=coffee+shops&location=tokyo+japan&count=5&country=JP
    -H "X-Subscription-Token: <key>"
```

Probed live on 2026-08-02 against the paid key (Berlin/DE, San Francisco/US,
Kyoto/JP, plus the docs' own lat/lng example). What the probes show, which is
**not** what the docs table says:

- Anchor is either `location` (free text: `city state country` for the US,
  `city country` elsewhere, no commas, case-insensitive, multilingual) or
  `latitude`+`longitude` with an optional `radius` in metres that biases rather
  than cuts off.
- `count` defaults to 20, range 1–100; `count=0` and `count=101` both return
  422. Verified.
- **`country` must be UPPERCASE and is a closed enum, not any ISO code.**
  `country=de` returns `422 VALIDATION`. Accepted values are exactly `AR AU AT
  BE BR CA CL DK FI FR DE GR HK IN ID IT JP KR MY MX NL NZ NO CN PL PT PH RU SA
  ZA ES SE CH TW TR GB US ALL`. Notably absent: `IE`, `IL`, `SG`, `AE`, `CZ`,
  `RO`, `UA`, `TH`, `VN`. Default `US`.
- Response: `{ type, results: LocationResult[], cities, countries, regions,
  neighborhoods, addresses, streets, mixed, location }`. No `query` key is
  returned. Every bucket except `results` is optional and unused here.
- `LocationResult` as actually returned: `id`, `title`, `url`, `provider_url`,
  `description`, `coordinates: [lat,lng]`, `postal_address` (only `type` and
  `displayAddress` came back, never the documented `streetAddress` /
  `postalCode` breakdown), `opening_hours.{current_day,days}` (entries
  `{abbr_name, full_name, opens, closes}`), `contact.{telephone,email}`,
  `rating.{ratingValue,bestRating,reviewCount,is_tripadvisor}`, `price_range`,
  `categories`, `serves_cuisine`, `thumbnail`, `pictures`, `profiles`,
  `icon_category`, `family_friendly`, `zoom_level`.
- **`distance` and `timezone` are documented but never returned.** 0 of 5
  (Berlin, `location` anchor), 0 of 5 (Berlin, `latitude`+`longitude`+`radius`),
  0 of 5 (San Francisco), 0 of 20 (the docs' own SF lat/lng example verbatim).
  `/res/v1/local/pois` on the returned ids does not add them either. Treat both
  as absent; see the reshaped output below.
- Field coverage is partial and query-dependent: `opening_hours` on 3/5 Berlin
  and 15/20 SF, `rating` on 3/5 Berlin and 7/20 SF. Half a result set carrying
  no hours and no rating is the normal case, not an edge case.
- `location.{coordinates,name,country}` is the resolved search centre, which is
  what the tool reports back. Present in every probe.
- **No `open_now` flag** — and no `timezone` to derive one from. **`id` expires
  in ~8 hours** and must never be persisted.
- `country` does not fight the anchor: with `location=kyoto japan`, passing
  `country=DE`, `country=ALL` or nothing all resolve to Kyoto, JP and return the
  same top shops in a slightly different order. The risk noted below is closed.

## Tool shape

```ts
find_places
input:  { query: string, near: string }
output: { near:   { label: string, coords: { lat, lng } },
          places: [{ name, address, coords, rating, review_count,
                     hours_today, phone, website }] }
```

`distance_m` and `open_now` are **cut**: Brave returns neither `distance` nor
`timezone` (see the contract above), so both would be permanently `null`. A
field that is always null is worse than an absent one, because the model will
narrate it. `review_count` is added because a bare 3.2 without "27 reviews"
misleads.

Five results, fixed. No `radius`, `limit`, `open_now` filter or `place_id`. Both
inputs required: there is no "here" until location ingest exists, and making the
model name where it looked is the behavior we want. Errors return as `{ error }`
data, never thrown, matching `tools/web-search.ts`.

**`country` is not a tool input.** It comes from user settings, invisible to the
model.

## What to change

### 1. Port — `apps/agent-api/src/places/types.ts`

```ts
export interface Place { name; address; coords: {lat,lng};
  rating: number|null; reviewCount: number|null; hoursToday: string|null;
  phone: string|null; website: string|null }
export interface PlaceSearchResult { near: { label: string; coords: {lat,lng} } | null; places: Place[] }
export interface Places { find(query: string, near: string): Promise<PlaceSearchResult> }
```

Mirrors `websearch/types.ts`: port, `brave.ts` production adapter, `memory.ts`
test adapter. Two adapters, so the seam is real.

`find` takes no country: the country is bound at construction, like the timezone
is bound into the calendar tools. Callers cannot vary it per call and the model
cannot see it.

### 2. Shared Brave client — `apps/agent-api/src/brave/client.ts`

`websearch/brave.ts` already carries behavior the places adapter needs
identically: the `X-Subscription-Token` header, 429 retry driven by the first
CSV component of `x-ratelimit-reset` plus jitter, an immediate throw when
`error.meta.quota_current >= quota_limit` (monthly exhaustion is not transient),
and the `brave_rate_limited` / `brave_quota_exhausted` logs. Brave's per-second
ceiling is shared across endpoints, so a places call landing beside a research
burst will trip it.

Extract `braveGet(path, params, apiKey, options): Promise<unknown>` holding
exactly that loop; both adapters call it. Deletion test passes: removing it
duplicates rate-limit behavior, not just indirection. Move the retry and quota
cases from `websearch/brave.test.ts` onto the new client's test and leave
payload mapping behind. Replace, do not layer.

Also teach it the `OPTION_NOT_IN_PLAN` 400: it is a permanent configuration
failure, so it must throw with a message naming the missing subscription rather
than looking like a transient outage. Same for `422 VALIDATION`, which a bad
`country` or `count` produces.

**Fix the quota guard while moving it (this is a live bug on the new key).**
Split out as `docs/plans/brave-quota-guard.md` and expected to land first; if it
already has, this section is just context and the corrected condition simply
moves into the shared client with everything else.
`websearch/brave.ts:93-105` treats a 429 as permanent monthly exhaustion when
`quota_current >= quota_limit`. On the Search plan `quota_limit` is **0**: a
real per-second 429, provoked with 60 parallel requests on 2026-08-02, returns

```json
{"plan":"Search","rate_limit":50,"rate_current":50,
 "quota_limit":0,"quota_current":14,"component":"rate_limiter"}
```

so `14 >= 0` is true and the adapter logs `brave_quota_exhausted` and throws
instead of retrying. Under the old free key `quota_limit` was 2000 and the guard
worked, which is why the existing test (`websearch/brave.test.ts:34`, default
`quota_limit: 2000`) never caught it. Require `quota_limit > 0` before treating
a 429 as exhaustion, and add a regression test using the body above. Also drop
the "free tier is 1 request/second" comment at the top of the file: the Search
plan is 50 rps (`x-ratelimit-policy: 50;w=1`).

### 3. Brave adapter — `apps/agent-api/src/places/brave.ts`

`createBravePlaces(apiKey, { country, now? }): Places`. Calls
`/res/v1/local/place_search` with `q`, `location`, `count=5`, `units=metric`,
and `country` **only when settings hold one** (otherwise omit and accept Brave's
`us` default rather than guessing). Leave `search_lang`/`ui_lang` at defaults
for v1.

The country handling is not a pass-through. `UserSettings.country` is any valid
uppercase ISO 3166-1 alpha-2 code (`src/country.ts` only excludes `XX` and
`T1`), while Brave accepts a closed 37-entry enum. Sending an unlisted code
**422s the whole call**, so an Irish or Singaporean user would get a hard error
on every search. The adapter holds `BRAVE_COUNTRIES`, a `Set` of the enum above,
and sends `country` only when the stored code is in it; otherwise it omits the
parameter. Probed above: omitting it does not move the anchor.

All the real logic lives here, which is what makes the module deep:

- `hoursToday`: join `opening_hours.current_day` as `"07:00–18:00"`,
  comma-separated for split hours. Present-but-empty means closed today; absent
  `opening_hours` means unknown (`null`) — never invent a closure. Roughly half
  of real results have no `opening_hours` at all.
- `rating` / `reviewCount`: from `rating.ratingValue` and `rating.reviewCount`,
  both `null` when the object is absent (also ~half of results). Ignore
  `bestRating`; every probe returned 5.0. `is_tripadvisor` is not surfaced.
- `near`: from `location.name` + `location.coordinates`; `null` when Brave
  resolved nothing, which the tool turns into an error rather than a silent
  global search.
- `website`: prefer `url`, fall back to `provider_url`. `provider_url` came back
  as `""` in probes, so treat empty string as absent.
- `address`: `postal_address.displayAddress` only. The documented component
  fields do not arrive.
- Dropped from the port's output: `categories`, `price_range`, `thumbnail`,
  `pictures`, `profiles`, `serves_cuisine`, `description`, and `id` (8-hour
  expiry, must not reach the model or the store).

No clock injection is needed now that `openNow` is gone.

### 4. Test adapter — `apps/agent-api/src/places/memory.ts`

`createMemoryPlaces(result?)`, canned and query-independent, shaped like
`websearch/memory.ts`.

### 5. Tool — `apps/agent-api/src/tools/places.ts`

`buildPlacesTool({ places })` exposing `find_places`. Description: search for
real-world places near a named location; `near` is a city, neighbourhood or
address; returns up to five with address, distance, rating and today's hours.
Body wraps `places.find` in try/catch, returning `{ error }` after
`log("find_places_failed", ...)`, exactly as `web_search` does. Log a success
line with result count and whether `near` resolved.

The description must not mention the country: it is derived, and a description
that varies by user would break the shared prompt cache.

### 6. Wiring

- `agents/interface.ts`: spread `...buildPlacesTool({ places: input.places })`,
  **registered unconditionally** so the tool schema stays byte-identical across
  users and turns (same rule as the file, Google and schedule tools; see
  `docs/caching.md`).
- `agents/orchestrator.ts`: add `places: Places` to the input type and thread it
  to the interface agent like `search` and `fetcher`. Research and writer agents
  do not get it.
- `UserDO/index.ts`: beside
  `const search = createBraveSearch(this.env.BRAVE_API_KEY)` (~line 384), add
  `const places = createBravePlaces(this.env.BRAVE_API_KEY, { country: this.store.getSettings().country ?? undefined })`,
  reading country from the same settings call that already yields `timezone`
  (~line 393), and pass it into `orchestrateTurn` (~line 463). Country is read
  per turn, so a user who travels gets the new value on their next message with
  no cache implications (it never enters the prompt).
- `agents/prompts.ts`: one short line telling the model to use `find_places` for
  real-world places and to say where it looked. It sits in the cached prefix, so
  keep it non-volatile.

No `wrangler.jsonc`, `Env` or `worker-configuration.d.ts` change.

## Tests

- `brave/client.test.ts`: 429-then-success honours `x-ratelimit-reset`;
  quota-exhausted 429 (`quota_limit: 2000`) throws immediately; **a rate-limit
  429 with `quota_limit: 0` retries instead of throwing** (the Search-plan
  regression above); `OPTION_NOT_IN_PLAN` and `422 VALIDATION` throw
  configuration-specific messages; other non-2xx throw; retry budget exhaustion
  throws. (Moved from the web-search test.)
- `places/brave.test.ts`, against `fetch` stubs built from the saved real
  payload: full mapping of a rich result; missing `opening_hours`, `rating` and
  `contact` each map to `null` rather than throwing; split `current_day` ranges
  join; empty `provider_url` does not become the website; `count=5`, `location`
  and `country` are actually sent; **`country` omitted when settings hold none
  and when they hold a code outside `BRAVE_COUNTRIES` (e.g. `IE`)**; empty
  `results` gives `places: []`; missing `location` gives `near: null`.
- `tools/places.test.ts`: happy path returns the mapped payload; an adapter
  throw becomes `{ error }` and never propagates; unresolved `near` becomes a
  clear `{ error }` telling the model to be more specific.
- `agents/interface.test.ts`: `find_places` is present with a memory adapter
  wired.

No e2e work: `packages/agent-e2e` has no Brave mock and is not in CI.

Verification on this box (workerd cannot start, see `AGENTS.md`):
`pnpm --filter @zero/agent-api run test | lint | typecheck`, plus the live probe
(now available, see "Blocker cleared").

## Docs and changelog

- New `docs/places.md`: the port and its adapters, why Brave, the partial field
  coverage and why `distance` and `open_now` are absent, the 8-hour `id` rule,
  where `country` comes from, why it is not a model input, and why it is
  allowlisted. Match `docs/research.md`'s tone.
- `AGENTS.md` Architecture: one clause noting the interface agent can search
  real-world places.
- `apps/agent-api/CHANGELOG.md`, same commit:
  `- YYYY-MM-DD: Ask Zero for places around a city or neighbourhood (restaurants, pharmacies, museums) and it answers with addresses, ratings and today's opening hours.`

## Skills to use

- `code` — driving the implementation.
- `tdd` — the mapper and the `open_now` derivation, where the bugs will be.
- `deep-modules` — extracting `brave/client.ts` and deciding what stays in the
  adapter.
- `changelog` — before editing the changelog.
- `git-commit` — committing.

## Acceptance criteria

- "Good ramen in Kreuzberg, Berlin" returns up to five real places with address,
  rating where known and today's hours where known, and the reply names the area
  searched.
- A German user's request carries `country=DE`; a user with no stored country,
  or one whose country is outside Brave's enum, sends no `country` param and
  still gets results.
- A Brave outage, a 429 storm, an unsubscribed plan or an unresolvable `near`
  each produce a clear reply, never a failed turn.
- The tool schema is identical for every user and every turn.
- No Brave place `id` is persisted anywhere.
- `test | lint | typecheck` pass for `@zero/agent-api`.

## Risks

- ~~**Plan gate.**~~ Resolved 2026-08-02: key is on the Search plan and the
  endpoint returns 200. Note that web search now bills on that plan too.
- ~~**`country` semantics unverified.**~~ Resolved 2026-08-02 by probe:
  `location` pins the geography and `country` only reorders. Kyoto stays Kyoto
  under `DE`, `ALL` and no country.
- ~~**`open_now` correctness.**~~ Resolved by deletion: Brave returns no
  `timezone`, so `open_now` is not derivable. `hours_today` stays.
- **Thin results.** Roughly half of real results carry no hours and no rating,
  so a five-place answer can be mostly names and addresses. Acceptable for v1,
  but it is the first thing to judge the tool on. If it reads poorly, the lever
  is ranking (drop results with neither hours nor rating) rather than more
  fields.
- **Rate limiting.** A places call in a turn that also runs research shares
  Brave's per-second ceiling (50 rps on the Search plan, up from 1 rps, so far
  less pressing than when `docs/plans/agent-latency-investigation.md` was
  written). The shared client's retry is the mitigation and the reason for the
  extraction — but only once the `quota_limit: 0` guard is fixed, since today a
  429 aborts instead of retrying.
- **Tool-result size.** Five fully populated places run 1–1.5 KB.
  `agents/learner.ts` truncates a rendered tool result at 2,000 chars, so a
  dense result could clip on the way into topics. Keep fields terse; if it
  clips, that cap is the knob, not the tool.

## Follow-ups (not this change)

The wider location design this was cut from: `plan_route` (walk/bike/drive via
OpenRouteService's free tier; transit needs a paid provider), `show_map`
(returning a marker the reply embeds, like `renderFileMarker`, rendering as
`sendVenue` / `sendLocation` / a static map image), `remember_place` (write-only,
read back via `near: "home"`), and location ingest (Telegram `location` and
`venue` messages are currently dropped by `extractAttachment` in
`routes/telegram-webhook.ts`; mobile GPS via `expo-location`).
