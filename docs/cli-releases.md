# CLI releases

`@zeroapps/cli` (`packages/zero-cli`, command `zero`) publishes to npm from
GitHub Actions when a `v*` tag is pushed. `.github/workflows/publish-cli.yml` does the publish
with npm trusted publishing (OIDC), so there is no npm token in the repo and no
manual `npm publish` from a laptop.

## Release steps

1. Bump `version` in `packages/zero-cli/package.json`.
2. Add a `CHANGELOG.md` entry if the release carries user-visible CLI changes.
3. Update the pinned version in `apps/zeroapps-docs/src/content/docs/vault/cli.mdx`.
4. Commit to `main` and wait for CI to go green.
5. Tag and push: `git tag vX.Y.Z && git push origin main --tags`.

Verify with `gh run watch`, then `npm view @zeroapps/cli version`.

## Prerequisite

npmjs.com → `@zeroapps/cli` → Settings → Trusted Publishers must name repository
`juanibiapina/zero` and workflow `publish-cli.yml`. That setting lives on npm,
not in the repo, and there is no API to read it back. **Renaming or moving the
workflow file requires editing it.**

## Constraints

- The tag must equal the package version. The workflow compares them and fails
  before publishing otherwise.
- npm rejects republishing an existing version with `403 You cannot publish over
  the previously published versions`. A failed publish needs a version bump, not
  a retag.
- A publish failure reported as `E404` is almost always the trusted-publisher
  config, not a missing package. npm masks OIDC auth failures as 404.
- `@zeroapps/cli` is the only publishable package, so the bare `v*` tag namespace
  belongs to it. If a second package becomes publishable, switch to a prefixed
  tag (`zero-cli-v*`) and update the trigger.
- `juanibiapina/zero` is private, so npm generates no provenance attestation.
  Expected, not a misconfiguration.
- The workflow runs no lint, typecheck, or test: `ci.yml` already runs all three
  at the repo root on every push to `main`. Only tag commits that are green on
  `main`.
- There is no build step either. `prepublishOnly` runs
  `tsc -p tsconfig.build.json` inside `npm publish`. The workflow still needs
  `pnpm install --frozen-lockfile` because the CLI's `tsconfig.json` extends the
  `workspace:*` package `@zero/typescript-config`.

## First publish of a new package name

Trusted publishing cannot bootstrap a package: npm's `npm trust` prerequisites
state the package "must already exist on the npm registry", and configuring a
trusted publisher is only possible after that. `@zeroapps/cli@0.3.0` was
therefore published by hand from a logged-in machine, after which the trusted
publisher was attached and `0.3.1` shipped from the tag workflow, proving the
config. Every version since goes through the tag.

On a passkey-only account, that manual publish needs `npm publish
--auth-type=web` run under a pty (`script -qec "npm publish --auth-type=web"
/dev/null`): npm prints an approval URL, and it redacts that URL in both piped
output and its debug log, so a plain `npm publish` in a script is a dead end.
`--otp` only helps with an authenticator app.

Expect the same dance for any future rename or new publishable package:

1. Create the npm org/scope if it does not exist.
2. `npm publish` the first version manually from `packages/zero-cli`.
3. Attach the trusted publisher (repository `juanibiapina/zero`, workflow
   `publish-cli.yml`, action `npm publish`). npm does **not** validate this on
   save, so a wrong field only surfaces at the next publish.
4. Prove it with the following version through the tag workflow.

`repository.url` in `package.json` must match the GitHub repository exactly or
npm rejects the publish, and `repository.directory` must track the package
folder.
