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

The web app (`apps/zero-web/src/pages/Onboarding.tsx`) POSTs the route once, guarded
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
- **Not in front of a reply.** Onboarding used to run on UserDO's alarm after
  turn draining, which put it in the same single alarm slot as replies. Its
  deadline lives in ScheduleDO, which calls `runQueuedOnboarding` when it comes
  due, and the agent runs as its own Pi session in AssistantDO, alongside the
  user's chats.

## The agent

The onboarding agent is a Pi Durable session in AssistantDO (the
`zero-onboarding` extension; UserDO calls `AssistantDO.runJob`), given the topic
tools plus **read-only** Gmail (`gmail_search`,
`gmail_thread`) — no `reply`, no delivery (`gmail_send`), no calendar, no
`research`/`web_search`. It authors the pinned topic directly in one pass, with
no separate consolidation pass afterward. The prompt
(`onboardingSystemPrompt`) revives the old onboarding-skill intent: scan inbox
and sent mail; record identity name-first (then location, role, languages, key
relationships); "capture only what shows repeated interaction or emotional
weight; when in doubt leave it out"; record only what the mail actually shows.

## Decisions

- **Stable topic name, identity in the body.** The pinned topic is always named
  `User`; the user's actual name is a fact recorded in the body. Avoids
  rename churn and `[[link]]` rewriting on every identity correction.
- **Identity only.** The topic is scoped by contract to who the user is (see
  [`topics.md`](topics.md), "Pinned topics"): everything else the scan turns up
  belongs in its own linked topic, not here. `onboardingSystemPrompt` carries
  the same `USER_TOPIC_RULES` as the other writers, and the seeded description
  (`USER_TOPIC_DESCRIPTION` in `src/user-topic.ts`) states the scope so
  `list_topics` does not invite bloat later. Already-onboarded users keep their
  old description until a writer refreshes it; there is no migration.
- **Fixing an already-bloated topic.** No bulk job, and since 2026-08-02 no
  move-it-out instruction in the prompt either: a writer that touches `User`
  applies the scope, but nothing sweeps a bloated body on its own. To fix one
  user, queue an admin task with a prompt such as "Bring the User topic within
  its stated scope: move everything that is not identity into the right topic
  and link it from User."
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

No e2e change: the e2e mock LLM issues no tool calls, so onboarding does
not fire there.
