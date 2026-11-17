# Todo REST API (`/api/v1`) and `zero-todo`

`zero-api` serves a versioned REST API for Tasks and Projects at
`https://zero.juanibiapina.dev/api/v1`, for clients outside Zero's own apps. The
`zero-todo` CLI (`packages/todo-cli`) is its first client. The web and phone
apps keep their replica routes under `/api/*`, and agents keep `/mcp`.

## The API

`GET /api/v1/openapi.json` describes every route, without sign-in.

Each handler validates the request and runs one operation of the todo catalog
(`todoOperations` in `packages/agent-core/src/operations`) in the caller's
`TaskDO`, as `/mcp` does. So validation, id minting, the Home view, and Project
attention behave the same over REST and MCP. The bodies are the catalog's
values. Writes reach the phone and web through the normal sync.

Errors are `{ "error": "<name>" }`:

| Status | When |
|---|---|
| 400 | `invalid-request` (the body or query does not validate; `message` says why), `nothing to update` |
| 401 | `unauthorized`: no bearer token, or Clerk rejects it |
| 404 | `not-found` for an unknown path; `missing-task` on a Task route; `missing-project` on `PATCH /projects/{id}` |
| 409 | On Task routes, `missing-project`, `missing-recording`, `id-conflict`, `invalid-recurrence`; on `POST /projects`, `id-conflict` |

Each route keeps its own conflict mapping in `apps/zero-api/src/routes/v1.ts`,
because one catalog name means different things on different routes.
`DELETE /projects/{id}` is idempotent and returns the counts it removed.

## Authentication

`/api/v1` accepts OAuth access tokens issued by the agent Clerk instance
(`https://clerk.zero.juanibiapina.dev`), the same instance and accounts as the
apps and `/mcp`. The router checks them with
`authenticateRequest(..., { acceptsToken: "oauth_token" })` before the apps'
session guard runs. Under `ENVIRONMENT=test` it trusts the bearer as the user
id, like `/api/*` and `/mcp`.

## The Clerk OAuth application

`zero-todo` signs in as the public OAuth application **Zero Todo CLI**, client
id `QFIeIWDsqBsxOfq5` (application `oa_3MEsbo9d81FdawjwetvQgaIWhZ2`), in the
agent Clerk instance. Clerk's consent
screen names it, and revoking it signs out every `zero-todo` install without
touching pi's MCP sign-in. It was created once with the backend SDK, from
`apps/zero-api`:

```bash
zero vault run -p zero-api -e production -- node --input-type=module -e '
import { createClerkClient } from "@clerk/backend";
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
const app = await clerk.oauthApplications.create({
  name: "Zero Todo CLI", public: true,
  redirectUris: ["http://127.0.0.1/callback"], scopes: "profile email",
});
console.log(await clerk.oauthApplications.update({
  oauthApplicationId: app.id, name: app.name, public: true,
  redirectUris: app.redirectUris, scopes: "openid profile email offline_access",
}));'
```

`create` grants only `profile email offline_access`, and Clerk then refuses an
authorization request for `openid`. `update` accepts `openid`, so the
application carries it. `public: true` enables PKCE without a client secret. Clerk accepts any port on
the registered loopback redirect, so the CLI listens on a free port and sends
`http://127.0.0.1:<port>/callback`. The CLI asks for
`openid profile email offline_access`.

## `zero-todo`

```bash
zero-todo auth login           # once per machine, through the browser
zero-todo tasks list --home    # the Tasks on Home today
zero-todo projects list --json
zero-todo --help
```

- `auth login --port N` fixes the callback port, for a sign-in through an SSH
  port forward.
- The tokens live in `~/.config/zero-todo/auth.json` (honours
  `XDG_CONFIG_HOME`), mode `0600`. Clerk rotates refresh tokens and revokes the
  whole family when an old one is replayed, so a refresh runs only while
  holding `auth.json.lock`, and the new pair is saved before it is used.
  Concurrent commands therefore never sign the user out.
- `ZERO_TODO_TOKEN` replaces the stored sign-in with a raw bearer token. Against
  a local Worker under `ENVIRONMENT=test`, that is the user id.
- `ZERO_TODO_API_URL` (or `--api-url`) points at another origin.
  `ZERO_TODO_ISSUER` and `ZERO_TODO_CLIENT_ID` point sign-in at another Clerk
  instance or application; the tests use them.
- Exit codes: 0 success, 1 the API refused or the input was wrong (`Error:
  <name>` on stderr, with a sign-in hint on 401), 75 the API or Clerk was
  unreachable or answered 5xx.

### Build and install

`pnpm -F @zero/todo-cli run build` bundles the CLI and its dependencies into
`packages/todo-cli/dist/zero-todo.mjs`, which runs with plain `node`.

The CLI has no releases: it is installed from source. The Macs take this repo
as a Nix flake input in dotfiles, run that build, and wrap the bundle with
`node`. A newer CLI reaches them with `nix flake update zero`.
