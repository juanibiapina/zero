# Mobile: picker sheets move when they open (Android)

## Cause

The date and project picker sheets move after they appear because of two
Material 3 behaviors. Both are reached through `@expo/ui`'s Compose
`ModalBottomSheet`, which the app's `Sheet` (`src/components/ui/sheet.tsx`)
wraps. Every `Sheet` in the app goes through the same code, so both causes
reach every `Sheet`, not only the pickers.

1. **Keyboard up at open: the open animation freezes, then jumps past rest.**
   The sheet opens in its own dialog window, and that window reports the
   keyboard of the screen behind it as an IME inset (953 px). Material 3
   `1.5.0-alpha17` pads the sheet's container by that inset
   (`ModalBottomSheet.kt:138`, `Box(Modifier.fillMaxSize().imePadding())`), and
   the sheet's anchors come from the padded height (`SheetDefaults.kt:321-331`:
   `Hidden at fullHeight`, `Expanded at max(0, fullHeight - sheetSize.height)`).
   The sheet therefore starts its rise at the keyboard's top edge. Android then
   hides that keyboard because focus moved to the sheet's window, and the
   inset shrinks over about 260 ms, so the anchors change on every frame.
   Compose Foundation 1.11.4 runs the open animation inside
   `restartable({ anchors to targetValue })` (`AnchoredDraggable.kt:1206`), so
   each anchor change cancels and relaunches it (`:1576-1592`). Each relaunch
   starts from the current offset with `lastVelocity` (`:1336-1356`), which "does
   not get reset when an animation gets interrupted" (`:986-990`). The offset
   holds still while the keyboard slides away. Once the inset reaches 0 and
   the anchors stop changing, the animation runs from where it froze, with the
   stored velocity of about −10,000 to −12,000 px/s. The date sheet then overshoots its
   rest by 59–118 px.
2. **Every open: the expressive spring overshoots.** `@expo/ui`'s `Host` wraps
   content in `MaterialExpressiveTheme` without a motion scheme
   (`HostView.kt:131`), which selects `MotionScheme.expressive()`
   (`MaterialTheme.kt:280`). The sheet opens with
   `motionScheme.defaultSpatialSpec()` (`SheetDefaults.kt:163`), a spring with
   damping 0.8 and stiffness 380 (`ExpressiveMotionTokens.kt:22-23`). It
   overshoots by `exp(-ζπ/√(1-ζ²))` = 1.5% of its travel at 269 ms, and
   Material's own comments say the sheet "bounces when it opens" with this
   setting (`SheetDefaults.kt:365`, `:1006`). With the keyboard down, this
   bounce is the whole motion: 25 px for the date picker, 34 px for the project
   picker and 10 px for the task editor.

Sources: Material 3 `material3-android-1.5.0-alpha17-sources.jar`, Compose
Foundation `foundation-android-1.11.4-sources.jar` (the version the app
resolves), and `@expo/ui` 57.0.22 `android/src/main/java/expo/modules/ui/`.

## Evidence

Recorded on the USB Pixel 7 with `adb shell screenrecord` at 86–90 fps during
the motion. The sheet's top edge was measured on every frame. Three runs per
cell; ranges cover all runs.

| Cell | Freeze while the keyboard hides | Overshoot past rest | Settled after first move |
|---|---|---|---|
| A: quick add, keyboard up, date | 222–267 ms, 167–390 px below rest | 61–118 px | 610–622 ms |
| A: quick add, keyboard up, project | 233 ms, 806–947 px below rest | 20–23 px | 666–688 ms |
| B: existing task, keyboard down, date | none | 24–25 px at ~234 ms | ~400 ms |
| B: existing task, keyboard down, project | none | 33–34 px at ~234 ms | 400–411 ms |
| C: existing task, title focused, date | 265–266 ms, 260–402 px below rest | 59–112 px | 615–621 ms |
| C: existing task, title focused, project | 210–222 ms, 805–1058 px below rest | 19–23 px | 676–688 ms |
| D: task editor sheet from Home | none | 10 px | 352–356 ms |

In A and C, the freeze starts on the frame the keyboard starts to slide down.
It ends on the first recorded frame after the keyboard is gone. The scrim,
drawn in the same window, keeps animating during the freeze, so the window
draws normally and only the sheet's offset holds.

The expressive spring, started at rest from the Hidden anchor, fits every B and
D run within 2.0–8.3 px RMS, over 678–2223 px of travel. The standard spring
misses by 13.7–51.7 px RMS. A free grid fit picks damping 0.8, stiffness 360,
the grid point nearest 380.

A probe build logged the sheet's internal state on every frame, over 50 opens:

| Opens | IME inset in the sheet window | Frames with an anchor change / offset held | Offset held | `lastVelocity` kept | Overshoot |
|---|---|---|---|---|---|
| 18 keyboard up (A, C) | 953 px (1048 px when Gboard showed its number row) | 25–28 / 24–25 | 263–289 ms | −10,259 to −11,960 px/s | date 58.7–107.8 px, project 21.2–23.8 px |
| 17 keyboard down (B, D) | 0 | 0 / 0 | — | — | 25.4 px (date), 33.6–33.7 px (project), 10.3 px (editor) |

The keyboard-down overshoots are exactly 1.5% of each sheet's travel: 1678 px,
2223 px and 678 px. One keyboard-up open, quick add with the date picker:

- **Frames 0–4:** `ime=953`, Hidden at 1447, Expanded at 0. The sheet rises
  from the keyboard's top edge.
- **Frames 5–8:** the inset flickers to 0 and back to 953 as Gboard switches
  layout.
- **Frames 9–33:** the inset falls 937 → 0. Hidden moves 1463 → 2400 and
  Expanded 0 → 722, while the offset stays at 1019.8 and `lastVelocity` at
  −10259.5.
- **Frame 34:** the relaunched animation's first callback, still at 1019.8.
- **Frames 35–43:** the offset moves 1019.8 → 918.9 and bottoms out at 653.6,
  against a rest of 722.

## Counterfactuals

- **Keyboard hidden before the picker opens** (temporary quick-add edit: dismiss
  the keyboard, then open on `keyboardDidHide`; 3 runs per picker): no freeze in
  any run. The motion matches cell B: 25 px (date) and 33–34 px (project)
  overshoot, settled in 378–400 ms.
- **Standard motion scheme** (probe switch that wraps the sheet in
  `MaterialExpressiveTheme(motionScheme = MotionScheme.standard())`, the
  override `@expo/ui`'s `TextField.kt:263` already uses):
  - Keyboard down, overshoot drops as predicted:
    - date: 25.4 → 2.5 px
    - project: 33.7 → 3.4 px
    - editor: 10.3 → 1.0 px
  - Keyboard up, the freeze is unchanged (266–286 ms, `lastVelocity` −11,801 to
    −15,011 px/s):
    - the date picker still overshoots 76.8–91.8 px, because the stored
      velocity is applied over about 300 px of remaining travel;
    - the project picker's overshoot falls to 2.5–2.8 px.

## Ruled out

- **Content height lag (Expo #51034, PR #51083):** zero `ShadowNodeProxy`
  flushes in all 50 opens. The sheets host React Native content with
  `RNHostView matchContents`, which takes its size from the React Native layout
  (`RNHostView.kt:177-183`) and never calls `setViewSize`. Each picker's React
  Native height was constant from its first layout: 1488 px for the date
  picker, 2033 px for the project picker, 488 px for the editor. Only the
  Compose constraint changed, growing from 1320 to 2210 px with the inset. All
  of the project picker's growth comes from the container's keyboard padding.
- **The app's `Sheet` height limit:** every picker mounted with the same JS
  limit (774.5 dp, which is 2033 px at density 2.625) and kept it through the
  open.
- **Late window insets:** the navigation bar inset was 63 px from the first
  frame in every open.
- **Quick add itself:** the existing-task editor with its title focused (C)
  freezes the same way. Any keyboard visible when a sheet opens triggers it.

## Corrections to earlier notes

- With the keyboard up, the date sheet does not drop to its rest. It rises
  from the keyboard's top edge, freezes below its rest, then jumps up past it
  and settles back.
- The project picker's "half height, then grows" is the same freeze. While its
  container is shorter than its 2033 px content, `requiredSize` centers the
  clipped content, so its title and filter are cut off for the first few
  frames.

## Method

- **Device and versions:** Pixel 7 (`panther`), Android 16, 1080×2400 at
  density 2.625, 90 Hz, gesture navigation, Gboard, dev client 1.2.18, app
  `main` at `c82a22a93`. Libraries: `@expo/ui` 57.0.22, Material 3
  `1.5.0-alpha17`, Compose Foundation 1.11.4, `expo-modules-core` 57.0.21.
- **Recordings:** `screenrecord --bit-rate 20000000` with `show_touches` on.
  Frame timestamps came from `ffprobe`. One pixel column per frame came from
  `ffmpeg -vf format=rgb24,crop=1:2400:200:0 -f rawvideo`; RGB conversion must
  come first, or a 1-pixel crop fails on 4:2:0 video.
  - The top edge is the first near-white run below the scrim at x=200.
  - The keyboard edge is the first run of Gboard's background color at x=6.
- **Probe:** local patches to `@expo/ui` (`ModalBottomSheetView.kt`,
  `RNHostView.kt`) and `expo-modules-core` (`ShadowNodeProxy.kt`), never pushed.
  - Per frame (`withFrameNanos`): `SheetState`'s `AnchoredDraggableState`
    offset, anchors and `lastVelocity` (the state is read by reflection,
    because the getter is internal); the sheet window's IME and navigation
    bar insets.
  - On every layout pass: the `RNHostView` constraints and measured size.
  - On every call: `ShadowNodeProxy` flushes.
  - `@expo/ui` ships a prebuilt AAR in `local-maven-repo`, which ignores patched
    sources. It only builds from source with
    `"expo": { "autolinking": { "android": { "buildFromSource": ["expo-ui"] } } }`
    in the app's `package.json`.

## Fix

- **Keyboard up at open:** `Sheet` hides the keyboard before presenting and gives it back after closing. The rule is in the "Bottom sheets" bullet of `apps/agent-mobile/README.md`.
