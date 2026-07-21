# Plan: Task 2 — product selector in `@zero/ui`

Implements Task 2 of the unified "Zero" console (design:
`docs/plans/unified-console-design.md`, "Product selector design"; background:
`docs/plans/unified-console-research.md`). Scope is **this task only**: a
left-side product selector in the shared `@zero/ui` `AppLayout` plus a shared
products module, wired into vault-web and errors-web with brand "Zero". No
domain rename, no Clerk change, no secrets work (Tasks 3/4/5).

## Goal

A signed-in user of Vault or Errors sees a Cloudflare-style left product
selector and can switch to the sibling product without signing in again. Both
apps render the shared **Zero** brand. Cross-product links are absolute
cross-subdomain URLs pointing at the **current** production hosts
(`zerovault.juanibiapina.dev` / `zeroerrors.juanibiapina.dev`), with a dev
override so localhost works. The change ships independently and is safe to merge
first; Task 3 later repoints hrefs when the subdomains rename.

## Current state (verified)

- `packages/ui/src/components/AppLayout.tsx` is a **top sticky header only**: a
  `brand` link (name + icon), a desktop nav (`navItems`), a `md:hidden`
  horizontal mobile nav strip, plus Clerk `OrganizationSwitcher` + `UserButton`,
  a `<main>` `<Outlet/>`, and `<Toaster position="bottom-right"/>`. Auth gate is
  `<SignedIn>…</SignedIn>` / `<SignedOut><RedirectToSignIn/></SignedOut>`. There
  is **no left sidebar and no product selector**.
- `AppLayoutProps` today: `brand: { name; icon: LucideIcon; to }`,
  `navItems: NavItem[]`, `afterOrgUrl?: string`. `NavItem` is `{ to; label;
  icon: LucideIcon }`. Both types are exported from `packages/ui/src/index.ts`.
- `apps/vault-web/src/main.tsx` mounts `AppLayout` with
  `brand={{ name: "ZeroVault", icon: Shield, to: "/projects" }}`,
  `navItems` = Projects (`FolderOpen`) + API Keys (`Key`), `afterOrgUrl="/projects"`.
- `apps/errors-web/src/main.tsx` mounts `AppLayout` with
  `brand={{ name: "ZeroErrors", icon: Bug, to: "/issues" }}`, `navItems` = Issues
  (`ListChecks`), `afterOrgUrl="/issues"`.
- `@zero/ui` deps: `lucide-react` (`^1.24.0`), `@radix-ui/react-label`,
  `@radix-ui/react-slot`, `class-variance-authority`, `clsx`, `sonner`,
  `tailwind-merge`. shadcn primitives present: `button`, `card`, `input`,
  `label`, `sonner`, `table`. **No dropdown-menu / select / sheet / popover
  component and no `@radix-ui/react-dropdown-menu`.** `LucideIcon` type is
  already imported and used.
- `packages/ui/src/env.d.ts` declares `ImportMetaEnv` with only
  `VITE_CLERK_PUBLISHABLE_KEY`. The web apps reference `vite/client` types.
- Dev ports (from AGENTS.md, confirmed in vite configs): vault-web **5178**,
  errors-web **5177**.
- CHANGELOG.md is a **flat dated list** (`- YYYY-MM-DD: …`, most recent first),
  per the repo's `AGENTS.md`, not the Keep-a-Changelog grouped format.

## Settled open detail: product-list source

Decision (matches the design's recommendation): a **shared `@zero/ui` export**
that builds the list from env vars with production defaults, so the two apps
cannot drift and dev can override hosts.

- New file `packages/ui/src/products.ts` exports:
  - `ProductId = "vault" | "errors"`.
  - `getProducts(): ProductLink[]` — builds both entries, reading
    `import.meta.env.VITE_VAULT_URL` and `VITE_ERRORS_URL`, each falling back to
    the current prod host. Icons come from lucide (`Shield` for vault, `Bug` for
    errors) so the module owns the canonical list; the two apps import it and
    only supply their own `currentProductId`.
- Each app selects its current product by passing a literal
  `currentProductId="vault"` / `"errors"` — no per-app duplication of the list.
- Dev override: developers set `VITE_VAULT_URL=http://localhost:5178` and
  `VITE_ERRORS_URL=http://localhost:5177` in each web app's `.env` when they want
  the selector to hop between local servers. Absent the vars, prod hosts are
  used (correct for deployed builds). No `.env` changes are required to ship;
  the fallbacks are the shipping behavior for now.

Rationale for env-with-fallback over hardcoding: it keeps deployed builds
correct with zero config while letting a dev cross-link localhost, and Task 3
can later change only the two fallback constants (or set build vars) when the
subdomains rename.

## What to change

### 1. New `packages/ui/src/products.ts`

```ts
import { Shield, Bug, type LucideIcon } from "lucide-react";

export type ProductId = "vault" | "errors";

export interface ProductLink {
  id: ProductId;
  label: string;
  icon: LucideIcon;
  href: string; // absolute, cross-subdomain
}

// Current production hosts (Task 3 renames these to vault./errors.).
const PROD_VAULT_URL = "https://zerovault.juanibiapina.dev";
const PROD_ERRORS_URL = "https://zeroerrors.juanibiapina.dev";

export function getProducts(): ProductLink[] {
  const vaultUrl = import.meta.env.VITE_VAULT_URL ?? PROD_VAULT_URL;
  const errorsUrl = import.meta.env.VITE_ERRORS_URL ?? PROD_ERRORS_URL;
  return [
    { id: "vault", label: "Vault", icon: Shield, href: vaultUrl },
    { id: "errors", label: "Errors", icon: Bug, href: errorsUrl },
  ];
}
```

### 2. Extend `packages/ui/src/env.d.ts`

Add the two optional dev-override vars so typecheck passes in `@zero/ui`:

```ts
interface ImportMetaEnv {
  readonly VITE_CLERK_PUBLISHABLE_KEY: string;
  readonly VITE_VAULT_URL?: string;
  readonly VITE_ERRORS_URL?: string;
}
```

### 3. Extend `AppLayoutProps` in `AppLayout.tsx`

New fields, **both optional** for a safe rollout (an app that passes neither
renders exactly as today):

```ts
export interface AppLayoutProps {
  brand: { name: string; icon: LucideIcon; to: string };
  navItems: NavItem[];
  afterOrgUrl?: string;
  products?: ProductLink[];   // full SaaS product list (same on both apps)
  currentProductId?: ProductId; // which product this app is
}
```

Re-export `ProductLink` and `ProductId` (and `getProducts`) from
`packages/ui/src/index.ts` alongside the existing `AppLayout` exports.

### 4. Rework the `AppLayout` shell (desktop left rail + mobile dropdown)

Keep all existing behavior: `SignedIn`/`SignedOut` gate, `RedirectToSignIn`,
`OrganizationSwitcher` + `UserButton` (unchanged props/appearance), the
`<Outlet/>`, and `<Toaster position="bottom-right"/>`. Restructure layout to a
left rail plus top bar.

Desktop (`md+`):
- **Left rail** (fixed-width column, e.g. `w-60`, full height, right border):
  1. **Brand** at top: `brand.icon` + `brand.name` linking to `brand.to`
     (react-router `<Link>`), unchanged semantics.
  2. **Product selector** below the brand: render `products` as a vertical list.
     - The entry whose `id === currentProductId` is **inert** (rendered as a
       non-link, highlighted `bg-accent text-accent-foreground`, `aria-current`).
     - Every other entry is an **absolute** `<a href={product.href}>` (full
       cross-origin navigation, not `<Link>`), with icon + label.
  3. **`navItems`** for the current product move here from the header into the
     rail, as the existing react-router `<Link>` buttons with the same
     active-state logic (`location.pathname.startsWith(item.to)`).
- **Top bar** (spanning the content column, sticky): keep
  `OrganizationSwitcher` + `UserButton` right-aligned. This is the trimmed
  header (brand and nav have moved into the rail).
- `<main>` outlet sits under the top bar in the content column.

When `products`/`currentProductId` are omitted, skip the selector block; the
rail still shows brand + navItems (graceful for any future consumer).

Mobile (`< md`, replaces the current `md:hidden` strip):
- A compact **product dropdown** in the mobile top bar next to the brand that
  navigates to the chosen product's absolute href. Since `@zero/ui` has no
  dropdown-menu primitive and adding a radix dependency is out of scope for this
  task, use a **native styled `<select>`**: options are the `products` labels,
  value is `currentProductId`, `onChange` does
  `window.location.assign(selectedHref)` for a non-current pick (a no-op for the
  current one). Native `<select>` is accessible, dependency-free, and matches the
  design's "minimum viable: a product select/dropdown". Style it with the shared
  `cn` + Tailwind to read like the other controls.
- Keep the existing horizontal `navItems` strip for the current product below
  the mobile bar (unchanged behavior), so per-product nav parity is preserved.

Icons: selector uses each product's lucide icon (`Shield`/`Bug` from
`getProducts`). Brand mark stays whatever each app passes (see wiring); the
active **product** is conveyed by the highlighted selector row, not the brand
text.

Alternative considered for the mobile control: add
`@radix-ui/react-dropdown-menu` + a shadcn `dropdown-menu` wrapper for a richer
menu with per-item icons. Rejected for this task to avoid new dependencies and
scope; a native `<select>` covers the two-item switch. Revisit if the product
list grows.

### 5. Wire the two apps (`main.tsx`)

`apps/vault-web/src/main.tsx`:
- Import `getProducts` from `@zero/ui`.
- `brand={{ name: "Zero", icon: Shield, to: "/projects" }}` (name → **Zero**;
  keep `Shield` as the neutral brand mark, or a shared glyph later).
- Add `products={getProducts()}` and `currentProductId="vault"`.
- Keep `navItems`, `afterOrgUrl="/projects"`, and all routes unchanged.

`apps/errors-web/src/main.tsx`:
- Import `getProducts` from `@zero/ui`.
- `brand={{ name: "Zero", icon: Bug, to: "/issues" }}` (name → **Zero**).
- Add `products={getProducts()}` and `currentProductId="errors"`.
- Keep `navItems`, `afterOrgUrl="/issues"`, and routes unchanged.

### 6. CHANGELOG.md

Add one entry at the top of the flat list (repo format `- YYYY-MM-DD: …`,
current date 2026-07-21), user-facing per the `changelog` skill:

```
- 2026-07-21: Vault and Errors now share the Zero brand and a product switcher to move between them without signing in again.
```

(Adjust the date to the merge date.) One bullet; describes what the user sees,
no module names.

## Files touched

- `packages/ui/src/products.ts` — **new**: `ProductId`, `ProductLink`,
  `getProducts()`.
- `packages/ui/src/env.d.ts` — add optional `VITE_VAULT_URL` / `VITE_ERRORS_URL`.
- `packages/ui/src/components/AppLayout.tsx` — extend props; left rail +
  selector + mobile `<select>`; move `navItems` into rail; keep org/user/outlet/
  toaster/auth.
- `packages/ui/src/index.ts` — export `getProducts`, `ProductLink`, `ProductId`.
- `apps/vault-web/src/main.tsx` — brand "Zero", `products`, `currentProductId`.
- `apps/errors-web/src/main.tsx` — brand "Zero", `products`, `currentProductId`.
- `CHANGELOG.md` — one user-facing bullet.

## Test / verification approach

There are no component tests in `@zero/ui` (only `lint` + `typecheck` scripts),
and whole-repo `bin/ci` / `bin/e2e-test` cannot run locally on this NixOS box
(`workerd` won't start). Verify the three touched packages directly with
per-package commands (per AGENTS.md's local fallback):

```bash
pnpm --filter @zero/ui run typecheck && pnpm --filter @zero/ui run lint
pnpm --filter @zero/vault-web run typecheck && pnpm --filter @zero/vault-web run lint && pnpm --filter @zero/vault-web run build
pnpm --filter @zero/errors-web run typecheck && pnpm --filter @zero/errors-web run lint && pnpm --filter @zero/errors-web run build
```

(`build` for the web apps is `tsc && vite build`, exercising the JSX/type
changes end to end.) Then a manual smoke check with `pnpm turbo dev`:

- Vault (5178) and Errors (5177) each render the **Zero** brand + left rail with
  the product selector; the current product is highlighted and inert.
- Clicking the other product navigates to its absolute href. With
  `VITE_VAULT_URL`/`VITE_ERRORS_URL` set to the localhost ports, the hop lands on
  the sibling dev server; without them, hrefs point at the prod hosts.
- Mobile width: the product `<select>` shows both products and navigates on
  change; the per-product `navItems` strip still works.
- Org switcher, user button, auth redirect, outlet content, and toaster behave
  as before.

Rely on GitHub Actions CI (and the Cloudflare deploy) to run the `workerd`-backed
suites.

## Skills to use during implementation

- `code` — making the edits.
- `changelog` — the user-facing CHANGELOG bullet (format per AGENTS.md's dated
  list, writing rules per the skill).
- `impeccable` — for the left-rail / mobile-selector visual structure and
  responsive parity.
- `git-commit` — committing the change (code + changelog together).

## Acceptance criteria

- `AppLayoutProps` gains optional `products` + `currentProductId`; omitting both
  renders as today.
- `@zero/ui` exports `getProducts`, `ProductLink`, `ProductId`.
- Both apps render brand **Zero** and a working product selector (desktop left
  rail + mobile dropdown); current product highlighted/inert, other product is an
  absolute cross-subdomain link.
- Hrefs default to the current prod hosts and are overridable via
  `VITE_VAULT_URL` / `VITE_ERRORS_URL` for localhost dev.
- Existing `OrganizationSwitcher`, `UserButton`, auth redirect, `<Outlet/>`, and
  toaster behavior preserved; mobile per-product nav parity preserved.
- Per-package typecheck + lint + build pass for `@zero/ui`, `vault-web`,
  `errors-web`.
- One user-facing CHANGELOG entry added in the same change.
- No domain rename, Clerk, or secrets changes (out of scope for Task 2).

## Risks / notes

- **No shared dropdown primitive.** Mitigated by using a native `<select>` for
  mobile; no new dependency.
- **Absolute hrefs point at old hosts.** Intentional for now; Task 3 flips the
  two fallback constants (or sets build vars) when subdomains rename. Selector is
  forward-compatible via the env override.
- **Cross-subdomain session continuity** (staying signed in across the hop) is a
  Clerk cookie-domain property handled in Task 4; not required for Task 2 to ship
  (the link works regardless; worst case the target prompts sign-in until Task 4).
- **Layout regression surface.** Moving `navItems` from header into the rail
  touches the one shared shell both products use; the per-package builds plus the
  manual smoke check cover it.
