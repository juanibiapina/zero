# Plan: Publish installable agent skills for ZeroVault and ZeroErrors

## Goal

Ship two installable agent skills, `zerovault` and `zeroerrors`, in a **new public
GitHub repo `juanibiapina/zero-skills`** that is the **source of truth** for them.
Not a mirror, and no top-level `skills/` directory in this repo. Skills install
through the skills.sh ecosystem CLI (`npx skills add juanibiapina/zero-skills`).
Restore the docs Skills page with real install instructions and wire it back into
the sidebar. Prove the skills are discoverable and installable before calling this
done.

The skills are for an agent doing a task (provision a secret and wire it into a
Worker deploy; add error reporting to a Worker), not a second copy of the docs.

## Decision: public source-of-truth repo (not `skills/` in this private repo)

The zero repo is private, so a `skills/` dir here would never appear on the
skills.sh public leaderboard and would need `gh` auth to install. Instead the
skills live in a dedicated **public** repo, `juanibiapina/zero-skills`, which:

- is publicly installable with `npx skills add juanibiapina/zero-skills` (no auth),
- can appear on the skills.sh directory,
- is the single source of truth: the zero repo does not carry a `skills/` copy.

The reciprocal rule (in `zero-skills/AGENTS.md` and this repo's `AGENTS.md`): the
skills promise live product behavior, so every command and endpoint is verified
against production before changing, and any change to a documented Zero command,
endpoint, or flow updates `zero-skills` in the same change.

## What skills.sh actually is (verified)

skills.sh is the public directory for the open agent-skills ecosystem built around
the open-source CLI `vercel-labs/skills`. Install model: `npx skills add
<source>`, where source is a GitHub `owner/repo`, a URL, a direct path to one
skill, or a local path. No manifest is required: the CLI recursively finds every
directory containing a `SKILL.md` (depth 5, skipping `node_modules`/`.git`/etc.),
accepting one only if its YAML frontmatter has string `name` **and**
`description`. Pi is a first-class agent (`-a pi` → `.pi/skills/`); one `SKILL.md`
serves all agents.

## Layout (in `juanibiapina/zero-skills`)

```
zerovault/SKILL.md
zeroerrors/SKILL.md
README.md      # what these are + one-line install + per-agent notes + source-of-truth line
AGENTS.md      # reciprocal verify-against-production / same-change rule
LICENSE        # MIT
```

No manifest file, no `skills/` wrapper dir. The two skill dirs sit at the repo
root, each with a `SKILL.md` carrying `name` + `description` frontmatter.

## One skill vs two — decision: two

The two cover distinct agent tasks with distinct triggers. ZeroVault is
"provision/read a secret and push it into a deploy" (CLI-driven, stateful).
ZeroErrors is "add error reporting to a Worker / send a report" (HTTP POST,
fire-and-forget). They share only the org-scoped `zv_` key. Two lean skills keep
each trigger sharp; they still install in one command.

## Per-skill content (agent-task instructions, not doc prose)

Real verified commands only, drawn from `apps/docs/src/content/docs/{vault,errors}`,
`packages/zerovault-cli`, and `packages/errors-core`. No real key or secret values.

- **zerovault** — object model in one breath; `zv` install (`pnpm dlx
  zerovault-cli@0.2.2`, `zv --version` misreports 0.2.1) and auth (`ZEROVAULT_API_KEY`,
  `zv whoami`); the commands that matter (projects, secrets set/get/list/delete,
  download `-f json`, keys); pushing secrets into a Worker deploy (`zv secrets
  download -f json | wrangler secret bulk`, delete the plaintext file); the
  `secrets.required` deploy gate (enforced on real deploy, not `--dry-run`).
- **zeroerrors** — get a key (created in the ZeroVault console; one org key works
  for both); ingest contract (`POST https://api.zeroapps.dev/errors/v1/errors`,
  `Bearer zv_`, payload schema with field limits, `202 {issueId,isNew}`); how
  grouping works (project + normalized message + **first stack frame**, the first
  `at ` line, not the first line); a drop-in Worker reporter that never rejects on
  transport failure; `secrets.required` gate for the key.

## Docs surfacing — hand-written page, no generator

For two rarely-changing skills a generator is not worth it. Rewrite
`apps/docs/src/content/docs/skills/overview.md` to a hand-written page: what the
skills are, the `npx skills add juanibiapina/zero-skills` command, per-agent
install notes, and links to the raw `SKILL.md` files on GitHub. Remove the
page-level `noindex` now that it has real content. Restore it to the sidebar in
`apps/docs/astro.config.mjs` as a `Skills` group.

## Zero-repo changes

- `AGENTS.md`: a short **Agent Skills** section near the Changelog rules pointing
  at `juanibiapina/zero-skills` as the source of truth, with the same-change rule.
- Docs: sidebar entry + rewritten `skills/overview.md` (no noindex).
- Root `CHANGELOG.md`: one dated, user-facing entry.

## How installability is proven (no manual step)

1. `npx skills add <local path to zero-skills> --list` lists exactly `zerovault`
   and `zeroerrors`.
2. `npx skills add <local path> -a pi -y --copy` into a fresh temp project produces
   `.pi/skills/zerovault/SKILL.md` and `.pi/skills/zeroerrors/SKILL.md`
   byte-identical to source.
3. After pushing the public repo, `npx skills add juanibiapina/zero-skills --list`
   works over the network against the real public repo.

## Gates

Zero repo: `pnpm -F @zero/docs run build`, lint, typecheck. Push both repos; wait
for the zero-docs Workers Builds deploy and verify the Skills page is live at
https://docs.zeroapps.dev/skills/overview/ with the real install command, the
sidebar entry, no noindex, and its `.md` twin serving.
