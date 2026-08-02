# Plan: fix the Brave quota guard for the paid Search plan

Standalone bug fix, cut out of `docs/plans/find-places-brave.md` (which folds
this into a larger client extraction). Nothing here depends on that plan, and
this should land first: the bug is live in production today.

## The bug

`apps/agent-api/src/websearch/brave.ts:96-106` decides whether a 429 is worth
retrying by comparing monthly quota fields in the error body:

```ts
if (meta && typeof meta.quota_current === "number" &&
    typeof meta.quota_limit === "number" &&
    meta.quota_current >= meta.quota_limit) { /* logError + throw */ }
```

Brave enforces a per-second rate limit and a monthly quota, and reports both in
the same 429. Per-second is transient and must be retried; monthly exhaustion is
not and must throw at once. The comparison above is how the two are told apart.

On the **free** key it worked: a burst 429 carried `quota_limit: 2000`,
`quota_current: 396`, so the guard was false and the call retried.

On the **paid Search** key there is no monthly quota, and Brave reports that as
`quota_limit: 0`. Confirmed by a single 200 response's headers (re-probed
2026-08-02), where the second CSV component is the monthly window:

```
x-ratelimit-limit:  50, 0
x-ratelimit-policy: 50;w=1, 0;w=2678400
x-ratelimit-reset:  1, 2558678
```

And in the 429 body itself, probed by firing 60 parallel `place_search` calls
(8 came back 429):

```json
{"plan":"Search","rate_limit":50,"rate_current":50,
 "quota_limit":0,"quota_current":14,"component":"rate_limiter"}
```

`14 >= 0` is true, so every ordinary per-second 429 is now classified as monthly
exhaustion: it logs `brave_quota_exhausted` and throws instead of sleeping ~1s
and retrying. `0` means "no cap" and the comparison reads it as "a cap of zero,
already blown". Unlimited and exhausted are indistinguishable to that line.

Live since the paid key was synced to the Worker on 2026-08-02. Impact is
bounded but real: at 50 rps a burst 429 is much rarer than under the old 1 rps
key, but when it does happen the `web_search` call fails outright and the
research loop loses that query.

## What to change

### 1. `apps/agent-api/src/websearch/brave.ts`

Add one condition: only treat a 429 as monthly exhaustion when a monthly cap
exists.

```ts
meta.quota_limit > 0 && meta.quota_current >= meta.quota_limit
```

When `quota_limit` is 0 there is no monthly cap to exhaust, so the 429 can only
be the per-second limit, which is exactly the case the retry loop exists for.
Everything else in the loop is unchanged: same `x-ratelimit-reset` delay, same
jitter, same retry budget.

Also correct the header comment (lines 4-8), which states "Brave's free tier is
1 request/second". The key is on the Search plan at 50 rps
(`x-ratelimit-policy: 50;w=1`, verified in the same probe). Say that bursts can
still trip the per-second limit and that a monthly quota only exists on plans
that have one.

### 2. `apps/agent-api/src/websearch/brave.test.ts`

The existing suite never fails on this because its shared `rateLimitBody` helper
(line 24) defaults to `quota_limit: 2000`, `plan: "Free"` — every test describes
the old plan.

- Keep the existing exhaustion test as-is (`quota_current: 2000, quota_limit:
  2000` still throws without sleeping). It pins the behavior that must survive.
- Add a regression test using the real paid-plan body above: a 429 with
  `quota_limit: 0`, `quota_current: 14` followed by a 200 **retries** — one
  `sleep`, two fetches, results returned. Without the fix it throws on the first
  response.
- The regression body must be the captured payload, not the Free helper with one
  field swapped: `plan: "Search"`, `rate_limit: 50`, `rate_current: 50`,
  `component: "rate_limiter"`. The current helper hardcodes `plan: "Free"` and
  `rate_limit: 1` and sends no `component`, so passing only `quota_limit: 0`
  builds a body Brave never sends. Widen the helper or add a second one.

No production-code change beyond the one condition, so no new tests elsewhere.

## Verification

`workerd` cannot start on this box (see `AGENTS.md`), and this path never needs
it:

```
pnpm --filter @zero/agent-api run test
pnpm --filter @zero/agent-api run lint
pnpm --filter @zero/agent-api run typecheck
```

The new test fails before the fix and passes after it, which is the proof that
matters. The live 429 body is already captured above, so reproducing the probe
is not required (and costs real requests).

## Docs and changelog

No changelog entry. A user never saw "quota exhausted"; they saw a research call
fail, which reads as an ordinary transient error. This restores intended
behavior rather than changing what the product does, so it falls under the
internal-change exemption in `AGENTS.md`.

`docs/research.md:124-130` **does** need the same correction, in the same
commit. Its `brave.ts` bullet repeats both stale facts: "Brave's free tier is 1
req/s" (twice, including "until the 1-req/s window resets") and "A 429 from
monthly-quota exhaustion (`meta.quota_current >= meta.quota_limit`) is not
transient and throws immediately" — that is the buggy comparison written out.
Update it to the Search plan's 50 rps and the corrected condition.

## Skills to use

- `tdd` — write the failing regression test first; it is the whole proof.
- `git-commit` — committing.

## Acceptance criteria

- A 429 whose body has `quota_limit: 0` is retried after the
  `x-ratelimit-reset` delay.
- A 429 whose body shows a real monthly cap reached still throws immediately and
  logs `brave_quota_exhausted`.
- `test | lint | typecheck` pass for `@zero/agent-api`.

## Risk

One-line condition on a path with existing coverage. The only way to get it
wrong is to widen it into "never treat a 429 as permanent", which would make a
genuinely exhausted monthly quota retry three times before failing. The retained
exhaustion test guards exactly that.

Note what the fix leaves behind: with `quota_limit: 0` on every plan in use,
`brave_quota_exhausted` becomes unreachable in production. The branch is kept
because it costs one condition and covers a downgrade back to a capped plan, not
because it can fire today. If a real monthly-exhaustion 429 is ever captured,
its `component` field (the burst body says `component: "rate_limiter"`) is the
better discriminator and should replace the numeric comparison.
