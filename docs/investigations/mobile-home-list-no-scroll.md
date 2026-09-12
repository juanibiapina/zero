# Mobile: Home list doesn't scroll when it overflows

## Bottom line

Home (`apps/agent-mobile`) didn't scroll once its task list overflowed, and
pull-to-refresh failed when the pull started on a task row (it worked from empty
space). **Root cause: the `ReorderableList` on Home had a `RefreshControl` but no
custom `panGesture`.** The library's default reorder pan activates on any small
movement, and on Android that fights the `RefreshControl`'s native
`SwipeRefreshLayout`, so the wrapper swallows the vertical drag and neither the
list scroll nor pull-to-refresh reaches the list.

**Fix (one prop, verified on the Pixel 7):** pass the reorder pan a long-press
activation delay, exactly as the `react-native-reorderable-list` `RefreshControl`
example does:

```tsx
const reorderPanGesture = useMemo(
  () => Gesture.Pan().activateAfterLongPress(520), // 520ms > the row's 500ms long-press
  [],
);
// ...
<ReorderableList /* ... */ panGesture={reorderPanGesture} refreshControl={<RefreshControl … />} />
```

With this, on device: **scroll from a row, swipe-right-to-postpone, long-press
reorder, and pull-to-refresh started on a row all work together.**

## Why the earlier hypotheses were wrong

Two hypotheses were explored on device and **disproved**, because the diagnostic
replaced the whole screen with a minimal list that lacked Home's real props:

- **Not the native tabs.** Swapping `unstable-native-tabs` for JS `Tabs` did not
  fix scrolling. An outer full-screen `ScrollView` in the view hierarchy is a
  benign provider-level wrapper (a plain `ScrollView` scrolls inside it).
- **Not the row's swipe `Gesture.Pan`.** The hand-rolled swipe-to-postpone looked
  guilty (a minimal `ReorderableList` with plain rows scrolled; the real Home did
  not), and offset tuning (`activeOffsetX`, `activeOffsetY`) didn't help. But the
  minimal test lists also lacked the `RefreshControl`. The decisive test: a
  **bare row (no swipe, no gesture) in the real Home still did not scroll**, and
  **removing only the `refreshControl` made it scroll** — proving the row was not
  the blocker.

Lesson: when isolating a list bug by replacing the screen, keep the real list's
props (`refreshControl`, `onDragStart`/`onDragEnd`, `itemLayoutAnimation`), or the
isolation removes the real variable.

## How it was confirmed (Pixel 7, dev client + Metro)

1. Real Home overflowed past one screen → a firm swipe-up moved nothing; a
   pull-down started on a row did nothing (but worked from empty space).
2. Bisecting the real `ReorderableList` props: removing `refreshControl` restored
   scrolling immediately (bare rows).
3. Restoring `refreshControl` and adding `panGesture={Gesture.Pan().activateAfterLongPress(520)}`
   restored scrolling **with** `refreshControl` present, and all interactions
   worked: scroll, swipe-postpone (a real task left Home), reorder (long-press
   drag moved a row), and pull-to-refresh (the spinner appeared on a pull started
   on a row).

## Scope: which screens are affected

Only **Home** has a `ReorderableList`, so only Home had this bug. Upcoming
(`SectionList`) and the Projects list / project screen (`FlatList` / `ScrollView`)
use non-reorderable scrollers with a `RefreshControl`, which is the standard
combination and does not exhibit the conflict. No change is needed there.

## The fix as shipped

`apps/agent-mobile/src/app/(signed-in)/index.tsx`, in the `Home` component: a
memoized `reorderPanGesture = Gesture.Pan().activateAfterLongPress(520)` passed as
`panGesture` on the `ReorderableList`. `Gesture` and `useMemo` were already
imported. The row's existing swipe, reorder long-press, tap-to-open, and complete
are untouched. +9 lines total.

The `activateAfterLongPress` value (520ms) is just above the row's `Pressable`
`delayLongPress` (500ms), matching the library's "Navigation Gestures" guidance
that the reorder pan should activate slightly after the drag long-press.
