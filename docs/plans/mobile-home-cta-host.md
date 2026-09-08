# Plan: Fix the missing `<Host>` around the Home empty-state button

**Conclusion:** The Home "all-clear" call-to-action renders an `@expo/ui`
`<Button>` with no `<Host>` ancestor, so on Android the button fails to render
and throws the Jetpack Compose error banner ("A Jetpack Compose view \"Button\"
must be rendered as a direct child of a `<Host>` component"). Wrap that one
button in `<Host matchContents>`, the same pattern `sign-in.tsx` already uses. It
is a one-file fix plus a regression guard.

## Root cause (confirmed by research)

- `HomeCallToActionView` in `apps/agent-mobile/src/app/(signed-in)/index.tsx`
  (line ~481) renders `<Button>` from `@expo/ui` inside plain React Native
  `<View>`s, with no `<Host>` wrapper.
- `@expo/ui` Compose views (Button, Column, TextInput) must be a **direct** child
  of `<Host>`. `sign-in.tsx` does this correctly
  (`<Host matchContents><Button/></Host>`). Every other `@expo/ui` Button in the
  app sits inside a `<Sheet>` (the `@expo/ui` `BottomSheet`), which is itself a
  native Compose host, so those are fine.
- This is **pre-existing**, introduced in commit `e90bd8a1a` ("rework the Today
  screen into Home"), not by the emoji branch. The error banner is sticky across
  navigation once thrown, which is why it also appears on other screens after
  Home renders it.
- It is **user-facing**: on the empty Home state the CTA button does not render
  (it is replaced by the error), so the empty-Home next-step action is
  unreachable.

## What to change and why

1. **`apps/agent-mobile/src/app/(signed-in)/index.tsx`** — in
   `HomeCallToActionView`, wrap the `<Button>` in
   `<Host matchContents>…</Host>`, and add `Host` to the existing
   `import { Button, Column, TextInput } from '@expo/ui'`. `matchContents` sizes
   the host to the button so the centered layout is unchanged.

## Tests to add or update

The current `@expo/ui` jest mock (in `apps/agent-mobile/jest.setup.js`) renders
`Button` and `Host` both as plain views, so it cannot catch a missing host — a
plain "button renders" test would pass even when broken. Two options, pick one
during implementation:

- **Preferred (real guard):** teach the `@expo/ui` mock in
  `apps/agent-mobile/jest.setup.js` to enforce the invariant — `Host` (and
  `BottomSheet`) provide a React context; `Button`/`Column`/`TextInput` throw
  when that context is **absent from their ancestry** (a host ancestor is what
  the native runtime requires; the real error's "direct child" wording is
  looser than the actual rule — working examples nest Button under `Column`
  under `BottomSheet`). The guard test already exists:
  `src/app/(signed-in)/__tests__/index.test.tsx:172` ("shows the create call to
  action when plate and inbox are empty") already renders Home's empty
  call-to-action state and passes today only because the current mock can't see
  the missing host. With the context-enforcing mock it fails before the fix and
  passes after — no new test needed, just the mock change. This guards every
  future bare-Compose-view regression, not just this one.
- **Fallback (if the mock change proves noisy):** skip the unit guard and rely on
  on-device verification, and note in the test file why jest cannot cover the
  native host requirement.

## Docs to add or update

- Add a `apps/agent-mobile/CHANGELOG.md` entry dated today, user-facing, e.g. the
  empty-Home next-step button now appears (it was failing to render).

## Verification (on-device, the authoritative check)

Rebuild the JS over Metro to the Pixel 7 (dev client + `adb reverse`, per
`apps/agent-mobile/README.md`), open Home in the empty state, and confirm: the
Compose error banner is gone and the CTA button renders and navigates to
Projects. jest cannot prove the native host requirement.

## Skills to use

- **tdd** — write the failing empty-Home test first (if taking the preferred
  mock-guard route), then the fix.
- **testing** — deciding the mock-context guard shape and keeping it honest.
- **git-commit** — commit the fix, test, and changelog together.
- **changelog** — for the CHANGELOG entry wording.

## Acceptance criteria

- `HomeCallToActionView`'s button is a direct child of `<Host>`.
- On the Pixel 7, the empty Home shows the CTA button with no Compose error
  banner.
- If the mock-guard route is taken: a unit test covering the empty-Home CTA fails
  without the fix and passes with it.
- A dated `apps/agent-mobile/CHANGELOG.md` entry is added.
- Lint, typecheck, and the mobile jest suite pass.
