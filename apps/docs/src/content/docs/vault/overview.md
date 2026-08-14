---
title: ZeroVault Overview
description: The ZeroVault object model and where things live.
---

ZeroVault stores secrets for your applications and serves them to any process, CI
job, or platform at deploy and runtime. You read and write them from the
dashboard, the API, or the `zero` CLI.

## Object model

```
Organization
└── Project
    └── Environment   (development and production by default)
        └── Secret    (key / value)
```

- Your **organization** is your workspace. It is created for you when you sign up,
  and it owns everything below. You do not create one by hand.
- A **project** groups the secrets for one app or service. Creating a project
  automatically gives it two environments, `development` and `production`. You can
  add or delete more.
- An **environment** holds a flat set of key/value secrets.
- **Credentials are organization-scoped.** A browser sign-in (`zero login`), an
  API key, and a trusted GitHub Actions workflow all reach every project and
  environment in one organization, and all of them authorize ZeroErrors too.

## Where things live

- **Dashboard:** [dash.zeroapps.dev/vault](https://dash.zeroapps.dev/vault):
  projects, environments, and secrets.
- **API keys:** [dash.zeroapps.dev/keys](https://dash.zeroapps.dev/keys), outside
  either product, since one key authorizes both. See
  [API keys](/account/api-keys/).
- **Public API:** `https://api.zeroapps.dev/vault/v1`, Bearer-authenticated with
  a `zv_…` key or a token from `zero login` or a
  [trusted workflow](/vault/github-actions/).
- **CLI:** `zero vault …`, published as `@zeroapps/cli` on npm.

## Next

- [Getting started](/vault/getting-started/): the dashboard walkthrough.
- [Vault commands](/vault/cli/): script your secrets with `zero vault`.
- [Loading secrets](/vault/loading-secrets/): pull secrets into any process or CI
  job.
- [Cloudflare Workers](/vault/workers/): pull secrets into a Worker deploy.
