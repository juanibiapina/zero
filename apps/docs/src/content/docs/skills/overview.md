---
title: Skills
description: Installable agent skills for ZeroVault and ZeroErrors.
---

Zero ships two installable agent skills that teach a coding agent the verified
commands and endpoints for ZeroVault and ZeroErrors:

- **zerovault** — manage secrets and environment variables, and push them into a
  Cloudflare Worker deploy.
- **zeroerrors** — add error tracking and reporting to an app or Worker.

They live in the public repo
[`juanibiapina/zero-skills`](https://github.com/juanibiapina/zero-skills), the
source of truth for Zero's agent skills.

## Install

```bash
npx skills add juanibiapina/zero-skills
```

This uses the open-source [skills CLI](https://github.com/vercel-labs/skills). It
finds both skills and installs them into your agent's skills directory. Add
`--list` to preview, `-s zerovault` (or `zeroerrors`) to install just one, `-a
<agent>` to target a specific agent, and `--copy` to copy files instead of
symlinking.

## Per-agent install

Skills are per-agent; one `SKILL.md` serves all of them. Pass `-a` to pick where
they land:

| Agent | `-a` value | Installs to |
|---|---|---|
| Pi | `pi` | `.pi/skills/` |
| Claude Code | `claude-code` | `.claude/skills/` |
| Codex | `codex` | `.codex/skills/` |

Use `-g` for the user-level directory instead of the project, or omit `-a` to be
prompted.

## Read the skills

- [zerovault/SKILL.md](https://github.com/juanibiapina/zero-skills/blob/main/zerovault/SKILL.md)
- [zeroerrors/SKILL.md](https://github.com/juanibiapina/zero-skills/blob/main/zeroerrors/SKILL.md)
