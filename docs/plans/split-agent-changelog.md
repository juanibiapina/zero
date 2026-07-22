# Plan: Separate the agent changelog from the console/global changelog

## Goal

The root `CHANGELOG.md` is bundled into the Worker and surfaced in-product as the
agent's read-only **Changelog** system topic, so every entry ships to agent
(Zero assistant) users. Recent work mixed ZeroVault / ZeroErrors / console
entries into it (product switcher, subdomains, resolve/hide issues, tab titles).
Agent users should not see those.

Split the changelog into two files so the agent topic shows only agent entries,
and rewrite the `AGENTS.md` rule so future changes route entries to the right
file.

## Research findings (current state)

### How the changelog reaches the agent topic

`apps/agent-api/src/store/system-topics.ts` imports the markdown as a bundled
text module:

```ts
import changelogMarkdown from "../../../../CHANGELOG.md";
```

(four levels up from `apps/agent-api/src/store/` = repo root `CHANGELOG.md`).

It becomes the body of the `Changelog` system topic:

```ts
{
  name: "Changelog",
  description: "Zero's changelog and newly shipped features.",
  summary: "Recent user-facing changes and new features in Zero.",
  body: changelogMarkdown,
  pinned: false,
},
```

`SystemTopicStore` (same file) overlays this onto every topic read, so the
`Changelog` topic is discoverable via `list_topics` and read on demand. It lives
in no user's SQLite; updating it is a source edit + deploy.

**Bundling mechanism (must keep working):**

1. **Production build (wrangler/esbuild):** `apps/agent-api/wrangler.jsonc` has
   ```jsonc
   "rules": [
     { "type": "Text", "globs": ["**/*.sql"], "fallthrough": true },
     { "type": "Text", "globs": ["**/*.md"], "fallthrough": true }
   ],
   ```
   The `**/*.md` Text rule makes any `.md` import resolve as a default-exported
   string. This matches by module glob, not by directory, so a `.md` file
   **inside** `apps/agent-api` matches the same rule. (`wrangler.test.jsonc` has
   only the `.sql` rule, but the test worker is not used for these unit tests.)
2. **Typecheck (`tsc --noEmit`):** `apps/agent-api/worker-configuration.d.ts`
   declares
   ```ts
   declare module "*.md" {
     const value: string;
     export default value;
   }
   ```
   so any `*.md` import typechecks regardless of path.
3. **Vitest:** `apps/agent-api/vitest.config.ts` has a `text-imports` plugin that
   `readFileSync`s any imported `.md`/`.sql` path and returns it as a default
   export, mirroring the wrangler rule. It resolves the path via normal module
   resolution, so a new in-package path works unchanged.

**Conclusion:** moving the agent changelog to `apps/agent-api/CHANGELOG.md` and
importing `../../CHANGELOG.md` keeps all three mechanisms working with no config
change. The import even shortens and stays inside the package boundary (no
reaching four levels up into the repo root).

### Current `CHANGELOG.md` content, classified

Root `CHANGELOG.md` mixes agent and console entries. Classification:

| Date | Entry (abridged) | Class |
|---|---|---|
| 2026-07-22 | Vault/Errors browser tabs read "Zero Vault"/"Zero Errors" | **console** |
| 2026-07-22 | Errors list hides resolved by default + "Show resolved" toggle | **console** |
| 2026-07-22 | Resolve/reopen an error issue from the issues list | **console** |
| 2026-07-21 | Vault/Errors share Zero brand + product switcher, new subdomains | **console** |
| 2026-07-21 | Usage-limit message ("temporarily at its usage limit…") | **agent** |
| 2026-07-21 | Faster replies on research/calendar-heavy turns | **agent** |
| 2026-07-21 | New conversation works in threads with a photo/file | **agent** |
| 2026-07-20 | Sign in to the Zero Agent mobile app | **agent** |
| 2026-07-18 | Send Zero a photo, PDF, or file | **agent** |
| 2026-07-18 | Zero can tell you about itself and its features | **agent** |
| 2026-07-17 | Zero remembers across conversations (topics) | **agent** |
| 2026-07-17 | Zero reads/sends Gmail, reads/schedules Calendar | **agent** |
| 2026-07-17 | Connect Google, Zero reads inbox to get set up | **agent** |
| 2026-07-17 | Zero follows your timezone | **agent** |
| 2026-07-16 | Ask Zero to look something up (web search) | **agent** |
| 2026-05-28 | Message Zero directly, not only in group topics | **agent** |
| 2026-05-26 | Send /new to start a fresh conversation | **agent** |
| 2026-05-17 | Sign in on web and link Telegram | **agent** |

The **top 4** entries are console; the **remaining 14** are agent. The
quota/usage-limit entry (2026-07-21) is **agent** and stays with the agent. The
mobile-app sign-in (2026-07-20) is the agent product's mobile client, so
**agent**.

### Current `AGENTS.md` rule (to be rewritten)

Root `AGENTS.md`, `## Changelog` section:

> Any change a user can observe (new capability, changed behavior, user-visible
> fix) must add a bullet to the root `CHANGELOG.md` **in the same change**. …
>
> - Format: `- YYYY-MM-DD: <what the user now sees or gets>`, most recent first.
> - Write from the user's perspective. …
> - Purely internal changes (refactors, tests, infra) get no entry.
>
> `CHANGELOG.md` is surfaced in-product as the read-only "Changelog" system topic
> (`apps/agent-api/src/store/system-topics.ts`), so every entry ships to users on
> the next deploy. Keep entries clean and user-facing.

This tells every product to write to root `CHANGELOG.md`, which is exactly what
caused the mixing. It must route per product.

### Docs that reference the changelog topic

`docs/topics.md` (around lines 66–92) describes the `Changelog` system topic and
says its body is "a text import of `CHANGELOG.md`" and "the repo-root
`CHANGELOG.md`". These sentences need to point at the new agent file.

### Tests

`apps/agent-api/src/store/system-topics.test.ts` asserts
`s.getTopic("Changelog")?.body).toContain("Changelog")`. The new agent changelog
must keep a `# Changelog` heading (or otherwise contain the word "Changelog") so
this assertion still holds. These tests use `MemoryStore` + plain vitest (no
workers pool), so they run locally without `workerd`.

## Chosen model

**Option (a): the agent gets its own `apps/agent-api/CHANGELOG.md`; the root
`CHANGELOG.md` becomes the console/global changelog (ZeroVault + ZeroErrors).**

Rationale:

- **Least surprising.** "Each app owns its `CHANGELOG.md`" is a standard monorepo
  convention. The agent changelog lives with the Worker that bundles and ships it
  (`apps/agent-api`). Keeping the root file as "agent-only" (option b) is the
  surprising choice in a 3-product monorepo — a reader would expect the root file
  to be repo-wide, not secretly agent-only.
- **Least churn to the mechanism.** The import path change is one line and the
  bundling (wrangler Text rule, `*.md` module decl, vitest plugin) keeps working
  untouched. No `wrangler.jsonc` edits.
- **Vault/Errors have no in-product changelog surface today.** Their entries have
  no code-side consumer, so the root file is simply their human-readable
  changelog (viewed in the repo / on GitHub). No new bundling is introduced for
  them.

Rejected:

- **(b) root stays agent-only, console moves to `CHANGELOG-console.md`.** Same
  functional result but the root file's meaning is surprising, and it leaves the
  in-product-bundled file reaching four levels up to the repo root for no reason.
- **(c) per-product changelogs for all three.** More files and more churn now
  (a `vault-api`/`errors-api` split) for no benefit, since vault/errors share the
  "console" brand and have no per-product changelog surface. Can be revisited if
  a console changelog UI is ever built.

## What to change

### 1. Create `apps/agent-api/CHANGELOG.md` (agent changelog)

Keep the `# Changelog` heading and intro, then the 14 agent entries in current
order:

```markdown
# Changelog

User-facing changes to Zero, most recent first.

- 2026-07-21: When the assistant is temporarily at its usage limit, it now tells you clearly and asks you to try again shortly, instead of a generic error.
- 2026-07-21: Faster replies on research and calendar-heavy turns and in longer conversations.
- 2026-07-21: Starting a new conversation now works even in threads where you had sent a photo or file.
- 2026-07-20: Sign in to the Zero Agent mobile app with your Zero account.
- 2026-07-18: Send Zero a photo, PDF, or file and it can read and work with it.
- 2026-07-18: Zero can now tell you about itself and its latest features.
- 2026-07-17: Zero remembers what matters to you across conversations, organized into topics you can browse and that link to each other.
- 2026-07-17: Zero reads and sends your Gmail and reads and schedules on your Google Calendar.
- 2026-07-17: When you connect Google, Zero reads your inbox to learn who you are and get set up.
- 2026-07-17: Zero follows your timezone, so "tomorrow" and "this afternoon" mean the right thing.
- 2026-07-16: Ask Zero to look something up and it searches the web before answering.
- 2026-05-28: Message Zero directly, not only inside group topics.
- 2026-05-26: Send /new in a topic to start a fresh conversation.
- 2026-05-17: Sign in on the web and link your Telegram account to start using Zero.
```

### 2. Rewrite root `CHANGELOG.md` (console/global changelog)

Retitle for the console products, add a one-line pointer to the agent file, keep
only the 4 console entries:

```markdown
# Changelog

User-facing changes to Zero Vault and Zero Errors (the console), most recent first.

Agent (Zero assistant) changes live in `apps/agent-api/CHANGELOG.md`, which ships in-product as Zero's Changelog topic.

- 2026-07-22: The Vault and Errors browser tabs now read "Zero Vault" and "Zero Errors", matching the unified Zero brand.
- 2026-07-22: The errors issues list now hides resolved issues by default, with a "Show resolved" toggle to reveal them.
- 2026-07-22: Resolve or reopen an error issue directly from the issues list, without opening it.
- 2026-07-21: Vault and Errors now share the Zero brand and a product switcher, and live at vault.juanibiapina.dev and errors.juanibiapina.dev.
```

### 3. Point `system-topics.ts` at the agent file

In `apps/agent-api/src/store/system-topics.ts`:

- Change the import:
  ```ts
  import changelogMarkdown from "../../CHANGELOG.md";
  ```
- Update the file's top comment that says "or the repo CHANGELOG.md" to reference
  the agent changelog (`apps/agent-api/CHANGELOG.md`).

No other code changes: the `Changelog` topic def already reads `changelogMarkdown`.

### 4. Rewrite the `AGENTS.md` changelog rule

Replace the `## Changelog` section so it routes per product. New text (intent):

- Every user-observable change still needs an entry in the same change, same
  format (`- YYYY-MM-DD: …`, most recent first), same user-perspective rules,
  purely-internal changes get none.
- **Routing:**
  - Agent changes (Zero assistant: `apps/agent-api`, the Telegram bot, the
    `apps/agent-mobile` app) → `apps/agent-api/CHANGELOG.md`.
  - ZeroVault / ZeroErrors / console changes (`apps/vault-*`, `apps/errors-*`,
    shared console UI) → root `CHANGELOG.md`.
- Note that `apps/agent-api/CHANGELOG.md` is bundled and surfaced in-product as
  Zero's read-only "Changelog" topic (`apps/agent-api/src/store/system-topics.ts`),
  so its entries ship to agent users on the next deploy; the root `CHANGELOG.md`
  has no in-product surface today and is the console's human-readable changelog.
- Explicitly warn: do not mix console entries into the agent file (that is what
  this split fixed).

### 5. Update `docs/topics.md`

In the `Changelog` system-topic description (around lines 66–92), change:

- "its body sourced from the repo-root `CHANGELOG.md`" → sourced from
  `apps/agent-api/CHANGELOG.md`.
- "the `Changelog` body is a text import of `CHANGELOG.md`" → text import of
  `apps/agent-api/CHANGELOG.md` (still bundled via the wrangler `**/*.md` Text
  rule, still mirrored by the vitest `text-imports` plugin).
- "Updating a system topic is a source edit plus deploy (edit the `Zero` body or
  `CHANGELOG.md`)" → edit the `Zero` body or `apps/agent-api/CHANGELOG.md`.

## Changelog entry for this change

**Decision: no new user-facing bullet in the agent changelog.**

The split is an internal reorganization. Its only observable effect for agent
users is that console entries (vault/errors/tab-title/subdomain) disappear from
Zero's Changelog topic — a correction of entries that were never about the agent,
not a shipped feature. Per the changelog skill, describing "we cleaned up the
changelog" is exactly the meta-noise to avoid, and it would be self-referential
inside the very topic it describes. The removed console entries are preserved in
the root `CHANGELOG.md` (their correct home), so nothing is lost.

The `AGENTS.md` routing edit is documentation/process, which also gets no entry.

(If the maintainer prefers a bullet, the least-bad wording would be agent-file:
`- 2026-07-22: Zero's changelog now lists only Zero's own features.` — but the
recommendation is to skip it.)

## Files touched (summary)

- **new** `apps/agent-api/CHANGELOG.md` — 14 agent entries.
- **edit** `CHANGELOG.md` (root) — retitle to console, add pointer line, keep 4
  console entries, remove the 14 agent entries.
- **edit** `apps/agent-api/src/store/system-topics.ts` — import path
  `../../CHANGELOG.md` + top-comment wording.
- **edit** `AGENTS.md` — rewrite `## Changelog` to route per product.
- **edit** `docs/topics.md` — repoint the `Changelog` topic description to the
  agent file.

## Test strategy

No new tests required; behavior of the split is verified by:

- Existing `apps/agent-api/src/store/system-topics.test.ts` still asserting the
  `Changelog` topic body contains "Changelog" (kept via the `# Changelog`
  heading in the new agent file). Confirm this test still passes.
- Optional: strengthen one assertion to check the agent body does **not** contain
  a known console phrase (e.g. "product switcher" / "Show resolved"), locking in
  the split so a future re-mix fails a test. Low cost, catches regressions.

## Verification

Run in `apps/agent-api` (all work locally without `workerd`; these are plain
vitest + tsc, not the workers pool or e2e that need `workerd`):

```bash
pnpm --filter @zero/agent-api run typecheck   # resolves the new *.md import via the module decl
pnpm --filter @zero/agent-api run lint
pnpm --filter @zero/agent-api run test         # system-topics.test.ts: Changelog body still contains "Changelog"
```

- Typecheck proves the moved import resolves at build time (via the `*.md`
  module declaration in `worker-configuration.d.ts`); the wrangler `**/*.md` Text
  rule matches the in-package path identically, so the production bundle picks up
  the new file with no config change.
- The whole-repo `gob run bin/ci` and the e2e/deploy-dry-run boot `workerd` and
  are not runnable on a NixOS dev box; rely on GitHub Actions CI + the Cloudflare
  deploy for those, per repo `AGENTS.md`.
- Post-deploy sanity: the `Changelog` system topic body equals the new agent
  file (no console entries). Because the topic body is the bundled file verbatim,
  the typecheck/build passing is sufficient proof the right file ships.

## Skills to use

- `changelog` — before editing either changelog file; keep entries user-facing.
- `code` — executing the edits.
- `git-commit` — commit all edits together (code + both changelogs + AGENTS.md +
  docs) in one change.

## Acceptance criteria

- `apps/agent-api/CHANGELOG.md` exists with only the 14 agent entries and a
  `# Changelog` heading.
- Root `CHANGELOG.md` contains only the 4 console entries plus the pointer line;
  no agent entries remain.
- `system-topics.ts` imports `../../CHANGELOG.md`; typecheck, lint, and unit
  tests pass in `@zero/agent-api`.
- `AGENTS.md` `## Changelog` routes agent vs console entries explicitly.
- `docs/topics.md` references `apps/agent-api/CHANGELOG.md` as the `Changelog`
  topic source.
- No new bundling config; the `Changelog` topic body still resolves at build.
```