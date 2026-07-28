# CLI releases

`zerovault-cli` (`packages/zerovault-cli`) publishes to npm from GitHub Actions
when a `v*` tag is pushed. `.github/workflows/publish-cli.yml` does the publish
with npm trusted publishing (OIDC), so there is no npm token in the repo and no
manual `npm publish` from a laptop.

## Release steps

1. Bump `version` in `packages/zerovault-cli/package.json`.
2. Add a `CHANGELOG.md` entry if the release carries user-visible CLI changes.
3. Update the pinned version in `apps/docs/src/content/docs/vault/cli.mdx`.
4. Commit to `main` and wait for CI to go green.
5. Tag and push: `git tag vX.Y.Z && git push origin main --tags`.

Verify with `gh run watch`, then `npm view zerovault-cli version`.

## Prerequisite

npmjs.com → `zerovault-cli` → Settings → Trusted Publishers must name repository
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
- `zerovault-cli` is the only publishable package, so the bare `v*` tag namespace
  belongs to it. If a second package becomes publishable, switch to a prefixed
  tag (`zerovault-cli-v*`) and update the trigger.
- `juanibiapina/zero` is private, so npm generates no provenance attestation.
  Expected, not a misconfiguration.
- The workflow runs no lint, typecheck, or test: `ci.yml` already runs all three
  at the repo root on every push to `main`. Only tag commits that are green on
  `main`.
- There is no build step either. `prepublishOnly` runs
  `tsc -p tsconfig.build.json` inside `npm publish`. The workflow still needs
  `pnpm install --frozen-lockfile` because the CLI's `tsconfig.json` extends the
  `workspace:*` package `@zero/typescript-config`.
