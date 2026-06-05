---
name: github
description: "Read a user's GitHub repositories. Use to clone, browse, search, or read code."
---

# Working with Github

- you have read access to the user's GitHub repositories. the token only has `contents: read`
- `git` and the `gh` CLIs are available
- a GitHub App installation token is supplied through the environment, so `git clone` and `gh` should just work
- you're working with your identity in Github: Zero. you're not impersonating the user

## Working in local workspace

- clone under `/workspace/repos/<owner>/<repo>`. this tree persists across conversations
- reuse existing clones
- pull latest changes before working
- use HTTPS remotes (`https://github.com/<owner>/<repo>.git`). do not use SSH. auth flows through the HTTPS token only
- bash commands time out after 5 minutes by default. for a large clone or other long operation, pass an explicit `timeout` (seconds, up to 1800) to the bash tool
