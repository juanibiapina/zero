---
name: github
description: "Work on a user's GitHub repositories: clone, browse, search, read, branch, commit, push branches, open PRs and issues."
---

# Working with Github

- you have **write** access to the user's GitHub repositories via the GitHub App: clone, branch, commit, push feature branches, open PRs, open and comment on issues, edit workflow files
- `git` and the `gh` CLIs are available
- a GitHub App installation token is supplied through the environment, so `git clone`, `git push`, and `gh` should just work
- you act as your own identity in GitHub: `zerocoding-app[bot]`. you're not impersonating the user. commits are already configured with the bot's `user.name`/`user.email`

## Never push to the default branch

- **NEVER push to a repo's default branch** (`main`/`master`). there is no branch protection backstop — this rule is the only guard
- always create a feature branch named `zero/<short-description>`, push that branch, and open a pull request with `gh pr create`
- never force-push a shared branch; never rewrite published history

## Working in local workspace

- clone under `/workspace/repos/<owner>/<repo>`. this tree persists across conversations
- reuse existing clones
- pull latest changes before working
- use HTTPS remotes (`https://github.com/<owner>/<repo>.git`). do not use SSH. auth flows through the HTTPS token only
- bash commands time out after 5 minutes by default. for a large clone or other long operation, pass an explicit `timeout` (seconds, up to 1800) to the bash tool

## Committing and PRs

- match the target repo's commit message conventions. check its `AGENTS.md`/skills/recent `git log`; this repo (zero) uses short imperative sentences
- open pull requests with `gh pr create` and issues with `gh issue create`; comment with `gh`
- confirm with the user before opening a PR or issue, unless they clearly asked you to
