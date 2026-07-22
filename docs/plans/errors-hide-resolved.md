# Plan: Hide resolved issues from the ZeroErrors issues list by default

## Goal

On the ZeroErrors issues list (`apps/errors-web/src/pages/IssuesPage.tsx`), show
only **open** issues by default, with a "Show resolved" toggle that reveals
resolved issues too. The paired per-row Resolve/Reopen feature already shipped
(CHANGELOG 2026-07-22), so resolved state is now settable directly from the
list, which makes hiding resolved rows the natural default.

## Research findings (verified against the code)

### Server already supports status filtering

`apps/errors-api/src/routes/issues.ts`:

```ts
const patchSchema = z.object({ status: z.enum(["open", "resolved"]) });

function parseStatus(raw: string | undefined): IssueStatus | undefined {
  return raw === "open" || raw === "resolved" ? raw : undefined;
}

const list = async (c) => {
  const project = c.req.query("project") || undefined;
  const status = parseStatus(c.req.query("status"));
  const issues = await getErrorsDO(c).listIssues({ project, status });
  return c.json({ issues }, 200);
};

app.get("/v1/issues", list);
app.get("/api/issues", list);
```

- `parseStatus` returns `"open"` or `"resolved"` for those exact values, and
  `undefined` for **absent or invalid** (anything else).
- `?status=` is read on both `/v1/issues` and `/api/issues`.

`apps/errors-api/src/ErrorsDO/index.ts` `listIssues`:

```ts
listIssues(filter: { project?: string; status?: IssueStatus } = {}): IssueSummary[] {
  const conditions = [];
  if (filter.project) conditions.push(eq("project", filter.project));
  if (filter.status) conditions.push(eq("status", filter.status));
  ...
}
```

- When `status` is `undefined`, no status condition is added, so **absent status
  = all issues** (open + resolved). This is exactly the "show all" behavior.

Conclusion: the API route and DO need **no changes**. Requesting `?status=open`
returns open only; requesting with no `status` returns all. `IssueStatus` is
`"open" | "resolved"` (`packages/errors-core/src/index.ts`).

### Web client `listIssues` signature and callers

`apps/errors-web/src/lib/api.ts`:

```ts
export async function listIssues(
  getToken: GetToken,
  project?: string,
): Promise<IssueListResponse> {
  const qs = project ? `?project=${encodeURIComponent(project)}` : "";
  return fetchApi<IssueListResponse>(`/api/issues${qs}`, getToken);
}
```

- It does **not** currently forward a status param.
- Callers of `api.listIssues` in errors-web: exactly **one**, in
  `IssuesPage.tsx` line 31. No other callers to worry about. (grep confirmed.)

### UI primitives available

`packages/ui/src/index.ts` exports `Button`/`buttonVariants`, `Input`, `Label`.
There is **no** Checkbox/Switch/Toggle primitive. So the toggle must be a
`Button` in toggle style, not a missing `Checkbox`.

### CHANGELOG format

The repo uses a **flat dated list**, not Keep-a-Changelog sections:

```
- 2026-07-22: Resolve or reopen an error issue directly from the issues list, without opening it.
```

Most recent first, `- YYYY-MM-DD: <user-facing sentence>`.

## Decisions

1. **Filter server-side.** Default list request sends `?status=open` so the
   payload only carries open issues. Matches existing `parseStatus` support and
   keeps payloads small. Toggling "Show resolved" on drops the status param, so
   the server returns all issues (open + resolved).

2. **"Show" means show ALL** (open + resolved), not resolved-only. Dropping the
   filter is the most intuitive behavior: the toggle turns the default (open
   only) into the full list. Implementation: no status param when the toggle is
   on.

3. **Toggle = ephemeral component state** (`useState`), not URL/localStorage.
   Justification: simplest, matches the existing `project` filter which is also
   ephemeral component state on this page. Shareable-link value is low for an
   internal error dashboard, and adding URL sync would be inconsistent with the
   sibling `project` filter. If persistence is wanted later it can be added
   uniformly for both controls.

4. **Toggle control = `Button`** (the only available primitive), styled with
   `variant` to reflect on/off state, placed next to the project filter input.

## What to change

### 1. `apps/errors-web/src/lib/api.ts` — forward optional status

Extend `listIssues` with an optional `status` arg, appended as a query param
alongside `project`. Keep the single existing caller working (arg is optional).

```ts
export async function listIssues(
  getToken: GetToken,
  project?: string,
  status?: IssueStatus,
): Promise<IssueListResponse> {
  const params = new URLSearchParams();
  if (project) params.set("project", project);
  if (status) params.set("status", status);
  const qs = params.toString();
  return fetchApi<IssueListResponse>(`/api/issues${qs ? `?${qs}` : ""}`, getToken);
}
```

`IssueStatus` is already imported in this file. Using `URLSearchParams` handles
encoding and the `?`/`&` joining cleanly for the two-param case.

### 2. `apps/errors-web/src/pages/IssuesPage.tsx` — toggle + pass status

- Add state: `const [showResolved, setShowResolved] = useState(false);`
- In `load()`, pass `status` = `open` when the toggle is off, `undefined` when
  on:

```ts
const load = useCallback(async () => {
  setLoading(true);
  const { issues } = await api.listIssues(
    tokenFn,
    project.trim() || undefined,
    showResolved ? undefined : "open",
  );
  setIssues(issues);
  setLoading(false);
}, [tokenFn, project, showResolved, organization?.id]);
```

  Adding `showResolved` to the dependency array makes the existing
  `useEffect(() => void load(), [load])` refetch automatically when the toggle
  flips — no extra handler needed.

- Add the toggle button next to the project filter. Example (place in the same
  row as the `Filter by project` input):

```tsx
<Button
  variant={showResolved ? "default" : "outline"}
  size="sm"
  onClick={() => setShowResolved((v) => !v)}
>
  {showResolved ? "Hide resolved" : "Show resolved"}
</Button>
```

  Wrap the existing search `Input` and this `Button` in a `flex items-center
  gap-2` container so they sit on one row.

### Interaction with the shipped Resolve/Reopen button

- `toggleStatus` already calls `await load()` after `setIssueStatus`. Because
  `load()` now honors `showResolved`, resolving an issue in the default view
  refetches with `?status=open` and the just-resolved row **disappears** — the
  desired UX.
- With "Show resolved" on, reopening flips a row back to `open`; the refetch
  (no status filter) still returns it, so it **stays visible**. Resolving in
  this view keeps the row visible too (status filter is off), only its
  StatusBadge and button label change.

## Tests

- errors-api: `parseStatus` and status-filtered `listIssues` behavior is already
  covered by `apps/errors-api/src/tests/errors.test.ts`. No API change is made,
  so no new API tests. (These tests need workerd; leave to CI.)
- errors-web: no unit test harness exists on this page; rely on typecheck + lint
  + build. No new tests added.

## Docs

- Add a CHANGELOG entry (repo flat dated format, most recent first) to
  `CHANGELOG.md`:

```
- 2026-07-22: The errors issues list now hides resolved issues by default, with a "Show resolved" toggle to reveal them.
```

  (Use the implementation date if later than 2026-07-22.) No other docs need
  updating.

## Skills to use

- `code` — implementing the web changes.
- `changelog` — writing the CHANGELOG entry (repo flat dated format).
- `git-commit` — committing code + CHANGELOG together.

## Verification

Per-package (dev box can't run whole-repo workerd suites):

```bash
pnpm --filter @zero/errors-web run typecheck
pnpm --filter @zero/errors-web run lint
pnpm --filter @zero/errors-web run build
```

Manual smoke (optional, via dev server on errors web port 5177): default list
shows only open; toggle reveals resolved; resolving a row in default view makes
it vanish on refetch; reopening in "show resolved" view keeps it.

errors-api parseStatus/listIssues status tests run in CI (need workerd). No API
change is expected; if the route is touched for any reason, note it and run
`pnpm --filter @zero/errors-api run test` (CI, workerd).

## Acceptance criteria

- Issues list defaults to open-only (server request carries `?status=open`).
- A visible "Show resolved" toggle (a `Button`, since @zero/ui has no checkbox)
  switches to showing all issues (open + resolved) by dropping the status param.
- Toggling refetches automatically.
- Resolving from the default view removes the row on refetch; reopening from the
  show-all view keeps the row.
- The single existing `listIssues` caller keeps compiling; no other callers
  affected.
- No errors-api route or DO changes required.
- CHANGELOG updated in the same change.
- errors-web typecheck, lint, build pass.
```

## Scope guardrails

- Do **not** modify `apps/errors-api` (route already reads `?status=` and DO
  already filters; absent status already means "all").
- Do **not** add a Checkbox/Switch primitive to `@zero/ui`; use `Button`.
- Do **not** persist the toggle to URL/localStorage; keep it component state,
  consistent with the sibling `project` filter.
