---
title: API keys
description: Create, use, and rotate the organization-scoped key that authorizes every Zero product.
---

An API key (`zv_…`) is how your code proves who it is. One key authorizes every
Zero product: it reads and writes secrets under `/vault/v1/*` and sends error
reports under `/errors/v1/*` on the public API at `api.zeroapps.dev`.

Keys are **organization-scoped**. A key reaches every project and environment in
the organization it was created in, and it keeps working when you add projects.
It is not tied to your user account, so it survives you switching machines. If
you belong to more than one organization, the key you create belongs to the one
that is active in the switcher at the top right.

Treat a key like a password. Anyone holding it can read your secrets and write
error reports.

You may not need a key. On your own machine, `zero login` signs the CLI in with
your browser, and `zero login --context <name>` gives one project directory its
own organization, so a second organization needs no second key. In GitHub
Actions, a job can use its OIDC token instead: see
[GitHub Actions with OIDC](/vault/github-actions/). A key is for a server, a
container, or CI that ZeroVault cannot verify. See the
[CLI reference](/cli/overview/).

## Create a key

1. Sign in at [dash.zeroapps.dev](https://dash.zeroapps.dev).
2. Open **API keys** in the sidebar, below the product list.
3. Give the key a label if you want one (`ci`, `laptop`, `staging-deploy`), and
   click **Create**.

The full key is shown once, right after you create it, with a copy button. Copy
it now. It is not shown again, and there is no way to recover it later. The list
only keeps the first and last few characters so you can tell your keys apart.

## Use a key

Most tools read the key from the `ZERO_API_KEY` environment variable:

```bash
export ZERO_API_KEY=zv_your_key_here
```

The API takes it as a bearer token:

```bash
curl -sS https://api.zeroapps.dev/vault/v1/projects \
  -H "authorization: Bearer $ZERO_API_KEY"
```

From there:

- [Load secrets](/vault/loading-secrets/) into a process or CI job with the
  `zero` CLI.
- [Send an error report](/errors/getting-started/) to the ZeroErrors ingest
  endpoint.
- [Use the CLI](/cli/overview/), which also accepts `--api-key` or a
  directory-bound context instead of the environment variable.

## Rotate or revoke a key

There is no way to change an existing key's value, so rotation is two steps:
create the new key, move your deployments and CI over to it, then revoke the old
one from the list. Revoking takes effect immediately and cannot be undone;
anything still using that key starts getting `401 Invalid API key`.

Revoke a key as soon as you suspect it leaked, and revoke instead of hunting for
a key you lost.

## Manage keys from the CLI

Once you have one key, `zero` creates and revokes the rest:

```bash
zero keys create -l ci     # prints the new key once; save it
zero keys list             # id, prefix, label, created date
zero keys revoke <id>      # revoke by id from the list
```

Your first key can come from the terminal too: run `zero login`, then
`zero keys create`. See the [CLI reference](/cli/overview/).
