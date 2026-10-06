# The topic model and the two agents

**Zero's long-term memory is a graph of topic documents in the per-user `UserDO`
SQLite, maintained by two agents: an interface agent answers each turn, and a
learner consolidates what was learned afterward, off the turn path.** Both run in
the per-user `AssistantDO` on Pi Durable, which keeps every transcript and
resumes any interrupted run (see [`harness.md`](harness.md)). There is no
container and no per-user filesystem. One global knowledge version keeps
concurrent topic writers correct.

This document is the source of truth for the topic model and the agents. How
the agents run (Pi Durable, delivery, execution, recovery) lives in
[`harness.md`](harness.md), the model id in [`design.md`](design.md), prompt
caching in [`caching.md`](caching.md), and web research in
[`research.md`](research.md).

## Key ideas

Each section below expands one of these:

- **Topics are a linked graph of markdown documents** — named, addressed by the
  agent, joined by `[[Topic Name]]` links, with a pinned `User` topic and
  read-only system topics. See [Topics](#topics).
- **The interface agent answers each turn; the learner consolidates afterward**,
  off the turn path, both in `AssistantDO`. See
  [The turn, and what happens after it](#the-turn-and-what-happens-after-it).
- **The model sees a bounded slice of each conversation** — a compaction summary
  plus the recent messages, with stale topic reads stubbed. See
  [Conversation context](#conversation-context).
- **One global knowledge version makes concurrent writes safe.** See
  [Knowledge versions](#knowledge-versions).
- **Pi Durable runs the loop and keeps the transcript, so an interrupted run
  resumes and answers once.** See [Execution](#execution) and
  [`harness.md`](harness.md).
- **The agents reach topics through one port**, local in UserDO and remote from
  AssistantDO. See [Storage seam](#storage-seam).

## Topics

A **topic** is a living knowledge document about a subject (a project, a person,
an ongoing thread). Columns (see `apps/zero-api/src/UserDO/db/schema.ts`):

- `name` — human label the agent addresses (unique). A surrogate integer `id` is
  the internal key, so a rename is a one-field `name` update.
- `description` — short routing blurb: what belongs in this topic. It is the
  only field `list_topics` returns besides the name, so it stays a short routing
  pointer and never grows into a second knowledge document.
- `body` — the knowledge document (markdown).
- `createdAt`, `lastActiveAt`, `messageCount` — activity tracking.

Topics are the agent's long-term memory. They are addressed by name through the
tools below; the interface agent discovers them itself (no separate routing
pass).

### Links between topics

Topic bodies link to each other with Obsidian-style `[[Topic Name]]` tokens, so
the knowledge model is a graph of cross-referencing documents. A link is the target topic's
exact `name` wrapped in double brackets; it resolves to that topic. This lets
the learner keep topics small and granular and connect related subjects (a person
links `[[Trip to Japan]]`, a project links `[[Deadline]]`) instead of copying
facts between bodies.

Links are first-class rows in `topic_links` (see `schema.ts`, migration
`0018_topic_links.sql`): one row per (source topic, target name), with a
`targetId` foreign key resolved when a topic of that name exists (else null, a
dangling link). The `Store` maintains one invariant: a topic's outbound rows are
always exactly the `[[Name]]` tokens in its current body. `syncOutboundLinks`
re-derives them on every `saveTopic`/`updateTopicBody`, so rows never drift from
the text. Creating a topic resolves any dangling links that were waiting for that
name. A rename rewrites `[[old]]` -> `[[new]]` in every other body and re-derives
their rows, so bodies and links move together and never break. This logic lives
in both Store adapters and is covered by `store/store-contract.test.ts`; the
`[[Name]]` parsing/rewriting helpers are the pure functions in `store/links.ts`.

Agents see the graph through the topic tools: `get_topic` returns a topic's
`outboundLinks` and `backlinks` alongside its body, and `list_backlinks` lists
what references a topic (used before renaming or merging).

### Pinned topics

A topic can be **pinned** (`pinned` column, migration `0019_topic_pinned.sql`).
Pinned topics are always rendered into the interface agent's system prompt under
a "Pinned topics (always in your context)" block, so their current bodies are
available every turn without a `get_topic` lookup. Pinning is a Store operation
(`setPinned(name, pinned)` / `getPinnedTopics()`), not an agent tool; a pinned
topic is otherwise an ordinary topic reachable by the normal tools and
consolidated by learning like any other. The canonical use is a stable
`User` topic seeded at Google onboarding (see `docs/onboarding.md`).

Each pinned body is capped (1,000 chars) when rendered into the prompt so a topic
that keeps growing can't blow up the prompt; the full body is still reachable
via `get_topic`. Pinning survives a `saveTopic` rename. The tradeoff is a
slightly higher token cost every turn in exchange for always-on identity.

A pinned body is **index-shaped**: a short set of pointers, capped hard.
Whatever sits in `User` is
paid for on every turn of every conversation, and past the cap it is silently
truncated (the head is kept, the newest facts at the tail are dropped). So the
topic is scoped by contract to identity: name and preferred form of address,
city and country, work, languages, the closest people as `[[Name]]` links, and
how the user wants to be spoken to. Addresses, phone numbers, documents and
account numbers, health details, plans, trips, projects, events and gear are
durable and kept — in their own topics, linked from `User` (contact and address
details go in `[[Personal Details]]`).

The contract is `USER_TOPIC_RULES` in `agents/prompts.ts`, appended to all four
prompts that can write topics (interface, learner, onboarding, admin task).
Enforcement is by prompt, deliberately: a store-level size limit would bounce a
write and lose the fact rather than relocate it, while the render cap already
bounds the cost. The rules state the scope; they no longer spell out a migration
procedure for a body that already breaks it, so an over-full `User` is corrected
opportunistically as writers touch it, or on demand with an admin task
(`POST /api/admin/users/{userId}/task`) saying to bring `User` within its stated
scope — that agent carries the same rules.

The topic name and its routing description are `USER_TOPIC` /
`USER_TOPIC_DESCRIPTION` in `src/user-topic.ts`, shared by `UserDO` and the
prompts. Only a topic created after this change carries the scoped description;
an already-onboarded user keeps the old one in `list_topics` until a writer
refreshes it with `update_topic_metadata`. There is no migration for that on
purpose: the description is prose the learner may rewrite anyway, and a boot-time
write would bump the knowledge version for every user just to restate a blurb.

### System topics

Some topics are **read-only reference documents bundled with the Worker**, the
same for every user and versioned with the code. They live in no user's SQLite.
There are two: `Zero` (the assistant's own identity and how it communicates,
pinned so it is always in context) and `Changelog` (Zero's user-facing changelog,
unpinned but discoverable via `list_topics`, its body sourced from
`apps/zero-api/CHANGELOG.md`). Their definitions are `SYSTEM_TOPICS` in
`store/system-topics.ts`; the `Zero` body is authored inline and the `Changelog`
body is a text import of `apps/zero-api/CHANGELOG.md` (bundled by the
`text-imports` plugin in `apps/zero-api/vite.config.ts`, which `vitest.config.ts`
reuses).

They are not seeded into the database. `SystemTopicStore` (same file) decorates
the `Store`: it overlays the bundled topics onto every read
(`getTopic`/`listTopics`/`getPinnedTopics`/`getTopicsWithBodies`/`getOutboundLinks`,
with `system: true` set on the returned rows) and rejects every write to a
system name (`createTopic`/`saveTopic`/`updateTopicBody`/`deleteTopic`/`setPinned`
throw `topic is read-only`). `getBacklinks` delegates unchanged, so a user topic
linking `[[Zero]]` still resolves. The `UserDO` wraps its `DbStore` in this
decorator once at construction, so every consumer (its RPC methods, including
the ones AssistantDO's agents call) sees the same overlay. Read-only is thus enforced
structurally at the store boundary, so no prompt or soft tool check is
load-bearing; the `update_topic`/`delete_topic` tools surface the thrown error as
a tool error. The
learner prompt also tells it not to edit `Zero`/`Changelog`, to avoid a wasted,
always-rejected call. Updating a system topic is a source edit plus deploy (edit
the `Zero` body or `apps/zero-api/CHANGELOG.md`); every user picks up the new content with no
migration and no per-user seeding.

## The turn, and what happens after it

The interface agent answers the user live during the turn, and the learner
consolidates durable knowledge afterward, off the turn path.

1. **Interface agent** (the `zero-interface` extension in
   `assistant/harness.ts`, one Pi session per Telegram chat). Given the new
   user message plus the chat's transcript, it runs a tool loop and sends
   replies as it works. The transcript is the model's own: a user message as
   text with an absolute `[YYYY-MM-DD HH:MM]` timestamp, each model response
   verbatim (tool calls included), each tool result as its own message. Sending
   back the same bytes the model produced is what makes the prefix cacheable
   across turns. Instructions and pinned topics are the system prompt; the
   current time, timezone and country ride on the latest user message.
   There is **no `reply` tool**. The assistant's own text blocks are the
   messages: each one is delivered as soon as its response is committed, before
   that response's tools run, so a turn that acknowledges and then answers is
   just a model that wrote text on two steps. A run that fails, or that never
   sent anything, gets the no-silence fallback. Tools (`tools/topics.ts`):
   - `list_topics`, `get_topic`, `create_topic`, `edit_topic`, `append_topic`,
     `update_topic_metadata`, `list_backlinks` — read/write the knowledge model and its
     `[[Name]]` link graph. Every topic touched is added to an `accessed` set.
   - `web_search(query)` — search the web; returns title/url/snippet results.
   - `read_page(url)` — open a web address and return its cleaned markdown,
     whether the user handed the link over or a search turned it up. Full URLs
     and shorthand (`thing.com/path`) both work; the adapter normalizes them.
   - `delete_topic` — permanently remove a topic. Interface-agent only (not in
     the shared `buildTopicTools`, so the learner cannot delete),
     and its tool description gates it on explicit user confirmation. Deleting a topic
     drops its own outbound link rows; inbound links from other bodies keep
     their `[[Name]]` text and become dangling, re-resolving if a topic of that
     name is recreated. Bodies of other topics are left untouched.
2. **Learning agent** (the `zero-learner` extension), which does **not** run on
   the turn path. It has the same shared topic tools (`buildTopicTools`), reads
   the raw transcript since the last consolidation across all of the user's
   chats, and runs as its own Pi session (see "How a learning job runs"). Durable facts often live in tool
   results — calendar events, email bodies, search results — so it reads the
   persisted results themselves. For each topic that gained
   durable information it reads the body (`get_topic`), merges new facts under
   sensible sections with `edit_topic` or `append_topic`, and uses
   `update_topic_metadata` only to refresh the description or rename. It never
   rewrites or compacts a body — the tools enforce that, not only the prompt.
   With `list_topics` + `create_topic` it creates a topic for a subject that has
   none.

   What it records is **what is true of the user and findable nowhere else**:
   their projects and where each stands, their goals, plans and decisions, the
   people, companies and organisations in their life and what each is to them,
   their commitments, dates, circumstances, preferences and belongings.
   Everything a search would answer the same way for a stranger — background on a
   company, product, technology or place, general explanations, public facts —
   is left out. Until 2026-08-02 the prompt said the opposite ("be proactive and
   generous", ten illustrative categories, web findings persisted verbatim),
   and the model filled with encyclopedia content that buried the user's own
   material.

Material for topics also arrives from the web: the interface agent searches with
`web_search` and opens pages with `read_page` in its own loop (see
`docs/research.md`). Neither tool writes topics. The results and the pages read
are persisted tool results in the conversation log, so the learner reads the
real thing rather than a truncated copy — but it keeps only **what the
searching meant for the user** (what they were deciding, what they chose, what
they will do) and leaves the findings out. A search that changed nothing for the
user leaves no topic behind.

The topic tools are shared, and **no tool replaces a complete body**:

- `create_topic(expectedVersion, name, description, body)` — create a topic
  whole. An empty body and an existing name are tool errors.
- `update_topic_metadata(expectedVersion, name, description?, newName?)` —
  routing description and rename only; it never accepts body text.

Revising an existing body goes through the incremental writes:

- `edit_topic(name, oldText, newText)` — replace an exact snippet of the body.
  `oldText` must match exactly once; zero matches and multiple matches are tool
  errors that tell the model which case it hit, so it can re-anchor.
- `append_topic(name, text)` — add to the end of the body, separated by a blank
  line.

Both write through `store.updateTopicBody`, which re-derives the `[[Name]]` link
rows, and both check `getTopic` themselves before writing: `DbStore.updateTopicBody`
silently no-ops on an unknown topic while `MemoryStore.updateTopicBody` throws, so
a store-level check would pass tests and lose writes in production.

## Conversation context

For a chat, the model sees its Pi transcript from the newest head marker: the
latest compaction summary or `/new` reset, then everything after it. Pi
compacts on its own once the context passes Zero's budget (45,000 tokens):
a summary written with Zero's compaction prompt replaces the older messages, and
the newest ones stay verbatim. Compaction is non-destructive: every raw entry
stays in storage, because learning reads it.

The summary must never carry topic knowledge: it is unversioned, so anything
copied into it could never be detected as stale. The prompt states the rule
flatly ("never copy a topic body") and asks for topic names as `[[Topic Name]]`
references, so the assistant rereads them instead.

**Staleness stubs.** A persisted topic read carries the knowledge version it was
taken at (see below). If that differs from the current version, the tool
result's content is replaced by
`[stale: topic knowledge changed; reread before using or writing]` for that
request. It is replaced, never removed: every tool call keeps its matching
result. There is no LLM call and no per-topic bookkeeping.

## Learning triggers

Learning is asked for by two events, never a poll:

- **Idle.** Every accepted user message pushes that conversation's deadline to
  now + 1h in ScheduleDO. When it comes due with no newer message, the schedule
  asks AssistantDO to consolidate.
- **Size.** When Pi starts compacting a chat, the compaction hook asks for
  learning at once. This covers a conversation that never goes idle.

## How a learning job runs

A job is one active run per user with at most one successor queued behind it. A
request that arrives while a job is running is coalesced into that successor,
because the active job froze its input when it started: messages that arrive
later belong to the next job, never to a prompt that was already built.

The job renders every chat's entries after that chat's consolidation mark into
one learner prompt, bounded by its rendered size (40,000 estimated tokens), not
by a message count. A job that fills the budget asks for a successor. The
learner runs as a Pi session: Pi checkpoints it and resumes it after a crash,
and a topic write that had already been applied conflicts on its expected
version instead of appending twice. When the learner's run ends cleanly, each
chat's mark moves to the last entry the learner was shown. Only then is a queued
successor started.

## Knowledge versions

Every topic read (`list_topics`, `get_topic`, `list_backlinks`) returns the
user's `version`: one integer covering every topic body, the catalog and the
link graph. Every write states the `expectedVersion` it was based on, and the
store compares it to the current value before applying anything. A mismatch
writes nothing and returns a recoverable tool error telling the model to reread;
a success returns the new version, so a chain of writes can use each result as
the next `expectedVersion`. Two conversations that read the same version cannot
both write: the second one is told to reread. Conflicts are logged as
`topic_write_conflict` (tool plus expected/current version, never a name or
content), which is how the cost of the single global counter is measured.

The counter is deliberately coarse. An edit to one topic invalidates reads of
every topic, in exchange for one correctness rule covering bodies, the catalog
and links. The bundled system topics (Zero, Changelog) live in no user's SQLite,
so their content is fingerprinted at build time and compared on each UserDO
init: a deploy that changes their text bumps the version once, which is what
makes a persisted read of them stale.

This exists to control cost. `update_topic`'s full-document `body` meant
that preserving a topic while adding one line to it cost the model the entire
document in generated tokens, growing with the topic without bound: on
2026-07-29 the per-turn writer reached 13,856 output tokens in a single 298s generation,
took 76% of the day's LLM time and 69% of its spend, and the wall time landed on
the *next* message, since turns drain serially per DO. Anchored edits make a
write cost the change. See `docs/plans/writer-latency-investigation.md` for the
measurements. The learner prompt also asks it to split a subject into a new linked
topic once a body passes roughly 2,000 characters, so bodies stop growing without
limit in the first place.

Nothing consolidates knowledge after the reply: that happens off the turn path
(see "Learning triggers"). Until 2026-07-30 a writer agent ran on every turn,
which put 20-40s of topic consolidation in front of the user's *next* message.
Nothing writes to a topic mechanically: every body change is a tool call the
learner chose to make, so material it judges to be about nobody in particular
leaves the model untouched.

## Execution

Every message reaches AssistantDO with an operation id, so it is answered once
however often it is handed over. Pi checkpoints each model request and each tool
call, and Cloudflare's `PiHarness` keeps the object awake while a run has work:
after an eviction, a crash or a deploy, the run continues from its last
checkpoint. Replies are claimed before they are sent, so an interrupted run
neither repeats a message nor swallows one; mail sends, calendar events and other
irreversible calls record their outcome, so a rerun never repeats them. The
details live in [`harness.md`](harness.md).

A message sent while Zero is working is queued and answered by the next run,
and a burst of them becomes one run.

## Storage seam

UserDO's code depends only on the `Store` port (`store/types.ts`), keeping do-orm
out of reach. Two adapters implement it: `DbStore` (do-orm over DO SQLite,
production) and `MemoryStore` (in-memory, tests); the shared contract test
(`store/store-contract.test.ts`) keeps them in sync. The topic tools are written
against `TopicToolStore`, which a local `Store` satisfies and which AssistantDO
reaches over RPC through `UserDataPort` (`assistant/user-data.ts`).
