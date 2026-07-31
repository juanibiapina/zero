# Google onboarding

When a user connects Google, Zero runs a one-shot Gmail scan to learn who they
are and seeds a **pinned** `User` topic that is always in the interface
agent's context (see [`topics.md`](topics.md) on pinned topics). The topic keeps
filling automatically as the user interacts; onboarding gives it a starting
point.

## Flow

```
Google connected (web)
  → POST /api/onboarding/google        (routes/onboarding.ts, Clerk-authed)
  → UserDO.queueOnboarding()           set googleOnboardingStatus = "queued",
                                        ask ScheduleDO for an onboarding deadline
  → ScheduleDO.alarm()                 deadline due → UserDO.runQueuedOnboarding()
  → UserDO.runQueuedOnboarding()       if status == "queued", delegate to…
  → UserDO.runOnboarding()             build model + Google token, delegate to…
  → do/onboarding.ts runOnboarding()   ensure pinned "User" topic, run agent,
                                        set status "done" (or "failed" on throw)
  → agents/onboarding.ts               Gmail scan → update_topic on "User"
```

The web app (`apps/agent-web/src/pages/Onboarding.tsx`) POSTs the route once, guarded
on `googleOnboardingStatus` being null, when Google connects.

## State machine (no task table)

The existing `googleOnboardingStatus` column on `user_settings` is the entire
state: `null → queued → done | failed`. No task/run table, no registry, no
generic executor. The blast radius is one alarm branch, one DO method, and one
route.

- **Idempotency.** `queueOnboarding` no-ops once the status has left `null`, so
  a user is onboarded at most once even if the web app fires more than once.
  `POST /api/onboarding/google?force=true` bypasses the guard to re-run for an
  already-onboarded user (the scan is idempotent: it re-authors the same pinned
  topic). Handy from the signed-in browser console:
  `fetch('/api/onboarding/google?force=true', { method: 'POST' })`.
- **Durability trick.** The status never moves to a transient `running` state.
  It stays `queued` until success flips it to `done` (or a caught failure flips
  it to `failed`). A mid-run DO eviction skips the catch and leaves it `queued`,
  so a later dispatch re-runs it. Re-running is idempotent: it re-authors the
  same `User` topic. A caught failure is logged (`onboarding_failed`), marked
  `failed`, and not retried in a loop.
- **Not on UserDO's alarm.** Onboarding used to run on UserDO's alarm after turn
  draining, which put it in the same single alarm slot as replies. Its deadline
  lives in ScheduleDO now, which calls `runQueuedOnboarding` when it comes due,
  so onboarding can take as long as it likes without a queued message waiting
  behind it.

## The agent

`agents/onboarding.ts` is the same `runAgent` machine as the interface and
learning agents, given the topic tools plus **read-only** Gmail (`gmail_search`,
`gmail_thread`) — no `reply`, no delivery (`gmail_send`), no calendar, no
`research`/`web_search`. It authors the pinned topic directly in one pass, with
no separate consolidation pass afterward. The prompt
(`onboardingSystemPrompt`) revives the old onboarding-skill intent: scan inbox
and sent mail; record identity name-first (then location, role, languages, key
relationships); "capture only what shows repeated interaction or emotional
weight; when in doubt leave it out"; never invent facts.

## Decisions

- **Stable topic name, identity in the body.** The pinned topic is always named
  `User`; the user's actual name is a fact recorded in the body. Avoids
  rename churn and `[[link]]` rewriting on every identity correction.
- **Pinning is a Store/DO operation, not an agent tool.** `runOnboarding`
  pre-creates and pins the topic, then passes its name to the agent to fill.
- **No task system yet.** A generic queue/registry would guess wrong before the
  real requirements (crons, workflows, email triggers) land. This one branch
  either folds into the real abstraction later or gets deleted.

## Observability

Every run reports both of its boundaries, to Workers Logs and to the Discord
channel already used for signup notices (`DISCORD_SIGNUP_WEBHOOK_URL`, reused
because onboarding is a rare per-user event with signup-scale volume).

| line | when | fields |
|---|---|---|
| `onboarding_queued` | the route accepts the request | `clerk_user_id`, `force` |
| `onboarding_started` | the run begins, before the topic is ensured | `clerk_user_id` |
| `onboarding_finished` | the agent returned | `clerk_user_id`, `status: "done"`, `duration_ms` |
| `onboarding_failed` | the agent threw (level=error) | `clerk_user_id`, `duration_ms`, `error` |

Exactly one terminal line per run: `onboarding_finished` **or**
`onboarding_failed`, never both.

**A start line with no terminal line means the run died mid-flight** — a DO
eviction skips the `catch`, so nothing is logged and the status is still
`queued`. That is not lost work: the next dispatch re-runs it (see the
durability trick above). It is the only evidence such an eviction happened.

Notifications never affect the run: a throwing notifier is caught and logged as
`onboarding_notify_failed`, and the production `notifyDiscord` already swallows
non-2xx and network errors.

## Testing

- `agents/onboarding.test.ts` — the agent reads Gmail (memory adapter) and
  writes the pinned topic; write-side Gmail/calendar tools are absent.
- `do/onboarding.test.ts` — the status state machine: `done` on success,
  `failed` on throw, idempotent re-run keeps the topic and pin; plus the
  start/end notifications, the log lines, and that a failing notifier leaves the
  outcome untouched.
- `routes/onboarding.test.ts` — enqueue returns 202 and is idempotent.

No e2e change: the e2e mock Anthropic issues no tool calls, so onboarding does
not fire there.
