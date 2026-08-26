# From Todoist to Full Assistant

Living doc, tracked in the repo at `docs/todo-app.md` (source of truth). Two
layers: the long-term **Vision** (philosophy + entity wiki) and the **Spec**
(what we actually build next, one small slice at a time). We grow the entity wiki
one entity at a time as we build. Keep the PROGRESS block and build order current
as increments land.

---

## Changelog routing

The mobile todo app is a **separate product surface, not the Zero agent**. Its
user-facing changes do **NOT** go in `apps/agent-api/CHANGELOG.md` — that file
ships in-product as Zero's read-only "Changelog" topic to agent users, and the
todo app is not part of it. Track todo-app changes here (PROGRESS block + build
order) until the app grows its own user-facing changelog.

## North star

Replace Todoist as the single entry point to all tasks, then let that entry
point absorb the surrounding workflows: email processing, calendar, AI coding,
life-project management. Build inside `juanibiapina/zero` as a parallel app so it
does not disturb the current agent. Dogfood Zero's own services (ZeroErrors,
ZeroVault).

Why zero and not `juanibiapina/agent`: agent has more features but is hacky and
not scalable as a product. Zero's design is more scalable.

## Design philosophy: entities are Minecraft blocks

Each entity type is like a new block added to Minecraft. Introducing it forces a
deliberate pass over how it interacts with *every* system of the app: how it
looks in the UI, how it interacts with other entities, what workflows it plugs
into, what special behaviors it has. Not just relational DB foreign keys — game
design thinking. Ideal end state: the code should not compile (or should refuse)
if a new entity's required interactions are not wired. Open question: whitelist
of allowed interactions vs blacklist of forbidden ones.

## Entity wiki (draft — grow one at a time)

- **Todo** — belongs to a Project. Basic actions: add, mark done. First slice.
- **Project** — goal-oriented (baby, diploma, buy a house, watch a movie).
  Sometimes maintenance-oriented (a "baby maintenance" project should maybe not
  exist). Has a nice icon (baby face, diploma). Can contain Todos, agent
  sessions, documents. Can spin off other Projects and even People. Notify
  dependent Projects when they move; can unblock them. Idea: project "slots",
  start with one slot to teach the game.
- **Person** — first-class. New to the user's workflow; named as a gap. Circle
  avatar. Connect to Todos and Projects. "People" is a basic filter: see how
  many people a Todo/Project affects. Family displayed clearly. Seed avatars +
  relationships from Google Contacts. Know where you first met someone.
- **Vault** — holds Notes. Notes shared across Projects on the same Vault. Can be
  one global Vault, per-project, or per-group. Low priority now (all projects
  share one Vault).
- **Note** — generic. Tension: user would rather have *no* generic Note entity
  and instead many specific typed entities, each with special behavior, so UIs
  and interactions can be specialized.
- **Preferences** — written docs of taste (e.g. "I strongly prefer OV movies").
  System should flag violations instantly in context (a movie project that isn't
  OV). Some rules today live in the user's head or in notes skills.
- **Workflow** — e.g. "process email", "watch a movie in the cinema". More than a
  user prompt: needs custom prompting + each entity type contributes its own
  influence to a workflow. Templates could auto-create Projects.
- **Email** — must attach to something, likely a Project. Strict `email ->
  project`? Newsletters, invoices, bills may be their own entities. Present an
  email with all attached entities + suggested updates (todos, calendar,
  timeline); user answers yes / no / ask-for-changes in an AI session.
- **Session** — AI session with tools to work with every entity. UI tracks all
  accessed/saved entities; jump to the note/person/etc. Tools have visuals shown
  in the session trace; following a link is a trackable tool.
- **Deliveries**, **Newsletter**, **Invoice**, **Bill**, **Trip**, **Album**
  (Google Photos), **Google Wallet** (service; auto-use for movie tickets),
  **Movie ticket** — candidate entities.

## Concrete pains that motivate this

- Zero booked a movie calendar event but ignored that the confirmation named 2
  tickets = another person involved. Want required entity interactions encoded.
- Zero's email workflow didn't follow a (safe, read-only) ticket link. Want it
  to follow non-mutating links to extract more info; each fetch is a trackable
  tool with visual output.
- Movie tickets should go to Google Wallet automatically.
- A movie project should ping during/after the movie for a review + photo with
  the poster, and prompt to tag the people who came.

## Dreamy / low-confidence ideas (parked)

- Game-like timeline UI.
- Project slots as a teaching mechanic.
- Zero auto-creating projects from templates instead of the user creating them.

---

## Spec map (the part we actually build)

story:   Replace Todoist as my task entry point with a parallel app in zero.
decisions:
  - Scope this session to the first shippable slice; vision stays a growing wiki.
  - Surface: extend the existing Expo mobile app (apps/agent-mobile) so there's a
    real dock icon on the phone. It already has Clerk login. Not a PWA. Phone is
    Android (package dev.juanibiapina.zeroagent).
  - Build additive in place (option A): new todos table in the existing UserDO,
    new /api/todos routes, new screen in the existing mobile app. Reuses Clerk
    auth + the DO + app shell; does not touch agent turn logic. Chosen because
    the todo app is meant to BECOME the main way to interact with Zero, with the
    agent living inside it later. Not a separate worker/DO.
  - Verification reality on this dev box: no workerd, no Android emulator. Verify
    via unit tests (pnpm --filter @zero/agent-api test, mobile api test) + a
    real-phone check (expo start on device, or an EAS preview build). No local
    end-to-end.
  - Mobile UI stack: NativeWind v4 (stable) + react-native-reusables (shadcn for
    RN). Chosen to match the web stack (agent-web/dashboard-web/landing already
    on Tailwind 4 + shadcn: agent-web has components.json, packages/ui is the
    shared shadcn lib) for one design language across web+mobile, best
    AI-assisted UI generation, and owned components that suit the bespoke
    game-like vision. NativeWind v5 is preview only; use v4.
    Compat verified (Jan 2026): NativeWind 4.2.6 peers (tailwindcss, reanimated,
    safe-area-context) already satisfied by the app (reanimated 4.5.1,
    safe-area-context 5.7.0, gesture-handler 2.32.0). Both libs ship NO native
    modules, so adopting them needs no new EAS build, only a metro/babel config
    change + `expo start --clear`. New Architecture (SDK 57) supported by v4.
rules:
  - rule: Capture an item to a single flat inbox list
    examples:
      - Type "buy milk", tap add -> "buy milk" appears in the list
  - rule: Optionally set a scheduled "show-up" date (NOT a deadline) while adding
    examples:
      - Add "pay rent", pick tomorrow -> item hidden today, shows up tomorrow
      - Add "call mom" with no date -> shows in the list now
  - rule: See the list = what's due to show up now (scheduled <= today, plus undated)
    examples:
      - Open the app -> today's + undated open items are visible in one list
  - rule: List is hand-ordered; position IS the priority (no priority field)
    examples:
      - New captures append at the bottom
      - User reorders items to set priority (top = do first)
  - rule: Postpone an item to tomorrow (FREQUENT, core action)
    examples:
      - Tap postpone on "call mom" -> leaves today's list, returns tomorrow
  - rule: Mark an item done
    examples:
      - Tap done on "buy milk" -> vanishes from the list instantly (still stored)

deferred (later slices, in rough order):
  - Separate the two roles of the list: a pure capture inbox vs a today/do-list
    (a known Todoist pain the product should fix; not needed to match flow now)
  - Triage: move captured items into Projects (the next-day workflow; richest
    for data-model learning)
  - Use the list as a daily to-do list (second mode of the same surface)
  - Recurring tasks
  - Reminders / push notifications
  - (not used in Todoist today, likely never: subtasks, priorities, labels)

questions:
  - Slice-1 list view: ordering, and what happens to done items (see Q5)

acceptance criteria: matched by the ordered increments below

# Build order (each = one vertical increment, its own PR, shippable + usable).
# "Slice" earlier just meant one of these increments; the sequence is what matters.
#
# PROGRESS (all on main, device-verified):
#   inc 0 UI foundation ......... DONE  commit 368a6c9
#   inc 1 add + list todos ...... DONE  commit 82dc1e7 (works on phone)
#   loading-state fix ........... DONE  commit c46319d (works on phone)
#   UI: Todoist-style quick add . DONE  (branch ui-quick-add; device-verified)
#   Upgrade mobile deps ......... DONE  commit c215de9 (SDK 57 + Clerk Core 3);
#                                 device-verified via EAS build 11 (app runs,
#                                 todos load, sign-in session persists)
#   UI: Clerk user button ....... DONE  commit d386b6c (Option B, native
#                                 <UserButton>); device-verified on EAS build 11,
#                                 avatar renders centered. Not yet re-smoked:
#                                 tapping opens the profile, sign-out, Google
#                                 sign-in regression, add-a-todo.
#   Agent-driven mobile verify .. PLANNED (dev-infra; Maestro+MCP driving a spare
#                                 Pixel 7 over USB; see note; waits for the device)
#   do-orm isNull pre-step ...... DONE  do-orm 0.2.0 (8c77381); zero 007412b
#   inc 2 mark done ............. DONE  commit ec43e75 (doneAt column + isNull
#                                 open-list filter; POST /api/todos/{id}/done;
#                                 leftside done circle per row, optimistic remove.
#                                 agent-api 934 tests, mobile 21, expo bundles.
#                                 DEVICE-VERIFIED on the phone via Metro hot-reload
#                                 over Tailscale, no new EAS build (pure JS change).
#                                 Gotcha: styles rendered unstyled until Metro was
#                                 restarted with --clear -- a stale bundler cache
#                                 dropped the NativeWind transform, so rows showed
#                                 as plain text with an invisible zero-size done
#                                 circle. `expo start --dev-client --clear` fixed it.)
#   inc 3 scheduled date ........ NEXT
#   inc 4 postpone tomorrow ..... todo
#   inc 5 manual reorder ........ todo
#
# DONE — Upgrade all mobile deps + Clerk Core 3 (branch upgrade-mobile-deps):
#   - Expo stayed on SDK 57 (57.0.16 is the latest SDK; no newer one exists), so
#     this was within-matrix patch bumps via `expo install`, not an SDK jump.
#     `expo install --check` bumped 11 packages (expo, expo-router, expo-image,
#     jest-expo, etc.); RN stayed 0.86 (do NOT bump to 0.87 -- outside SDK 57).
#   - Clerk: @clerk/clerk-expo@2.20.0 (DEPRECATED) -> @clerk/expo@^4.6.0. NOTE:
#     the successor package is v4, NOT "v3" -- "Core 3" is Clerk's internal core
#     version, not the npm semver. This was the earlier note's mistake.
#   - Surface touched: swapped the import in _layout.tsx (+ token-cache path
#     @clerk/expo/token-cache), sign-in.tsx, both (signed-in) files, api.ts
#     comment, and the two jest.mock('@clerk/clerk-expo') strings -> '@clerk/expo'.
#     Ran `pnpm dlx @clerk/upgrade` guidance but the edits were small enough to do
#     by hand.
#   - Core 3 gotcha hit: ClerkProvider's `publishableKey` is now a REQUIRED
#     string. A module-level `if (!KEY) throw` does NOT narrow the JSX usage, so
#     tsc failed; fixed by narrowing inside RootLayout (local const + throw).
#   - Our Google OAuth uses `useSSO({ strategy: 'oauth_google' })` (Custom Tab +
#     sso-callback deep link), NOT the native `useSignInWithGoogle`, so Core 3's
#     "native Google sign-in moved to @clerk/expo-google-signin" does NOT apply:
#     no new package, no new config plugin. Base @clerk/expo needs no app.json
#     plugin either.
#   - Other Core 3 behavior change to remember (not exercised now): getToken()
#     throws ClerkOfflineError when offline (was null); still returns null when
#     signed out. Wrap with ClerkOfflineError.is(err) from @clerk/expo/errors if
#     offline resilience is ever wanted.
#   - Checks green: typecheck, lint (0 errors), 18 tests, expo export bundles.
#   - RESOLVED: EAS dev build 11 (2026-08-26, cut for the user button) bundles
#     these bumped native modules + Clerk. It runs on device: the app launches,
#     todos load, and the persisted sign-in session survives relaunch. A fresh
#     Google sign-in end-to-end was not re-run on 11 (session already present).
#
# TODO — Agent-driven mobile verification (dev-infra, HIGH priority):
#   - PROBLEM: today the only way the agent proves a mobile change runs is to cut
#     an EAS APK and have the human install + click it. Feedback loop is far too
#     slow, and broken builds reach the human. We want the AGENT to bring the app
#     up, SEE it render, and INTERACT with the specific feature it added, via a
#     few simple commands. The human still gets an APK to eyeball the real thing
#     -- but should stop receiving broken versions.
#   - We want an ACTUAL mobile client (real device / emulator), NOT a web-target
#     simulation (react-native-web) -- explicitly rejected by the human.
#
#   - HARD CONSTRAINT (verified 2026-08-26): the dev box ("mini") has NO /dev/kvm
#     and ZERO vmx/svm CPU flags, so an accelerated Android emulator CANNOT run
#     locally. No adb / Android SDK / Java / Maestro installed yet either. So the
#     Android instance must be hosted off-CPU-emulation and reached over adb.
#
#   - DEVICE DECISION (human, 2026-08-26): use a spare **Pixel 7** (old phone)
#     plugged into "mini" over USB, LATER (not available right now). That means:
#     * Local USB adb -- no Tailscale, no kernel changes, no Redroid needed.
#     * REAL Google login works (real device with Chrome + Google), so both the
#       bypass path and the occasional real-OAuth path are testable on it.
#     * Redroid (containerized Android, no KVM, needs NixOS binder/ashmem kernel
#       modules) and adb-over-Tailscale were the fallbacks if there were no
#       device; now they are unneeded. CI's mobile-e2e emulator stays the
#       device-less backstop.
#
#   - DRIVER LAYER (the "ideal for coding agents" piece): use **Maestro + its
#     built-in MCP** (`claude mcp add maestro -- maestro mcp`, 9 tools: list
#     devices, inspect screen, generate + run flows, screenshot, Viewer, submit
#     to Cloud). Reason: we ALREADY run Maestro flows in CI (.maestro/,
#     mobile-e2e.yml), so one tool spans the interactive agent loop AND the
#     deterministic saved regression flows. Alternative kept in reserve:
#     mobile-mcp (mobile-next) -- accessibility-tree-first, cheaper tokens, any
#     adb device -- if Maestro's screenshot token cost hurts. (Appium MCP /
#     Callstack Agent Device also exist; not preferred given the Maestro
#     investment.) Consider a formal evaluate-existing-solutions pass before
#     committing.
#
#   - APP RUN MODE: fast local loop = drive the already-installed Expo dev-client
#     with Metro headless (EXPO_UNSTABLE_HEADLESS=1 -- REQUIRED on this box or the
#     CLI crashes installing the RN DevTools binary, "NixOS cannot run dynamically
#     linked executables", exit 127; see mobile README). JS changes hot-reload, no
#     new EAS build. For a deterministic full-native check, drive a preview APK
#     (self-contained, same as CI's expo prebuild + assembleRelease); that APK
#     comes from EAS/CI, not local (no Android SDK here).
#
#   - AUTH: support BOTH. (a) BYPASS (agent default): extend the existing
#     EXPO_PUBLIC_E2E flag (sign-in.tsx already branches on it) into a test-only
#     signed-in mode -- stub useAuth/session + a test JWT the worker accepts (or a
#     mock API base) -- so the agent reaches the todo feature in one launch, no
#     OAuth. (b) REAL Google login (occasional, auth-touching changes only): drive
#     the OAuth Custom Tab via Maestro on the Pixel 7; Google anti-bot screens make
#     this flaky, so it stays manual/CI-gated, not the default loop.
#
#   - DELIVERABLE: a one-liner (bin/mobile-verify or a pnpm/turbo script) that
#     checks a device is connected (adb devices), boots the app (dev-client + Metro
#     headless, or installs the preview APK), runs a Maestro flow (open -> reach
#     feature -> tap/type -> assert something visible), and saves a SCREENSHOT +
#     pass/fail the agent reads. Plus a mobile README section (USB pairing, bypass
#     flag, the command). PROOF: agent verifies the existing add-a-todo feature end
#     to end and pastes the screenshot.
#
#   - NEW PROJECT RULE (add to AGENTS.md + here once it works): every
#     mobile-touching task runs bin/mobile-verify and includes the
#     screenshot/result before the work is called done.
#
#   - PHASES: (1) toolchain on NixOS via nix -- adb (android-tools), JDK, Maestro;
#     register `maestro mcp`; watch for NixOS dynamic-link issues, prefer nixpkgs
#     builds, fall back to mobile-mcp or raw adb if Maestro won't run. (2) plug in
#     the Pixel 7 over USB, enable USB debugging, authorize, confirm `maestro test`
#     drives it. (3) auth-bypass mode. (4) bin/mobile-verify + the add-a-todo flow.
#     (5) prove + document + add the project rule. Phases 1/3/4 can be prepped now;
#     phase 2 waits for the device.
#
#   - RISKS: NixOS toolchain friction (adb/Maestro/Java as dynamic binaries -- use
#     nixpkgs builds, fall back to mobile-mcp); device not always connected (loop
#     degrades to CI emulator backstop); real-OAuth flakiness (keep off the default
#     path). Security: if adb ever goes over the network instead of USB, restrict
#     to Tailscale, never expose :5555 publicly.
#
#   - ONE-TIME PIXEL 7 SETUP (done by hand once, later when the human is home;
#     goal: phone sits on a shelf next to mini, plugged in, and mini controls it
#     FULLY hands-off at all times -- so no lock + reboot-proof authorization).
#     This setup itself MUST be documented (mobile README) as part of the task.
#     * Dedicate the phone as a test device (optional factory reset; no personal
#       data since it's exposed on a shelf). Join home wifi. Optionally sign into a
#       THROWAWAY Google account (only needed for the real-OAuth path; the bypass
#       path needs none).
#     * Enable Developer options (About phone -> tap Build number 7x). In Developer
#       options: USB debugging ON; Stay awake ON; disable Automatic system updates
#       (avoid surprise reboots); optionally Wireless debugging ON as a USB-flake
#       backup.
#     * CRITICAL: Settings -> Security -> Screen lock = None. With no PIN a reboot
#       lands on the home screen and mini can always drive it; a PIN would strand
#       the phone behind a lock nobody can reach.
#     * The ONE physical tap that matters: plug into mini with a DATA usb cable ->
#       on the phone check "Always allow from this computer" -> Allow. This binds
#       trust to mini's adb key (~/.android/adbkey) and PERSISTS across reboots (no
#       re-prompt), as long as that key is never regenerated. PROTECT that key
#       (back it up; don't let a re-image / `adb keygen` / deleting ~/.android wipe
#       it, or you'd need physical access to re-tap the dialog).
#     * After authorization, mini pushes the rest with NO phone touching:
#       `adb shell settings put global stay_on_while_plugged_in 3`, wake before each
#       run (`adb shell input keyevent KEYCODE_WAKEUP` -> home, since lock is None),
#       install/launch, run the Maestro flow, screenshot, assert.
#     * OPEN CHOICES (decide at setup): (a) screen burn-in -- "Stay awake" keeps the
#       OLED on 24/7 (months -> burn-in); cleaner is wake-on-demand (let it sleep,
#       mini wakes it per run). Leaning wake-on-demand. (b) battery -- plugged at
#       100% forever degrades the cell; acceptable for a disposable test device,
#       Adaptive Charging helps.
#   - STATUS: waiting on the human to be home to do the physical Pixel setup; the
#     device-independent prep (nix toolchain, EXPO_PUBLIC_E2E auth bypass, the
#     bin/mobile-verify script + add-a-todo Maestro flow) can proceed beforehand.
#
# DONE (code + local checks) — UI: Clerk user button (Option B, native):
#   - Replaced the home-header "Sign out" Button with <UserButton> from
#     @clerk/expo/native, wrapped in a 36px circle (h-9 w-9 overflow-hidden
#     rounded-full). Tapping it opens the native profile (manage account,
#     security, sign out); signOut dropped from useAuth (getToken kept).
#   - Added the @clerk/expo config plugin to app.json as
#     ["@clerk/expo", { "appleSignIn": false }] (Android-only app). Native module,
#     so it needs a NEW EAS dev build; JS alone won't add it.
#   - HAZARD (verified in source): the native button calls
#     requireNativeView('ClerkUserButtonView'); the guard checks only Platform.OS,
#     not view registration, so rendering this JS on a dev client WITHOUT the
#     native module CRASHES the home screen ("Cannot read properties of undefined
#     (reading 'displayName')"). Ship JS + native build together; never hot-reload
#     this change onto the old client. Web renders null (safe); we export
#     android-only anyway.
#   - Why Option B over the pure-JS avatar (Option A): the doc preferred B once on
#     Core 3, and @clerk/expo v4 is on main. Trade-off accepted: native components
#     are Clerk public Beta (minor breaking changes expected before GA) and B
#     couples to a new EAS build. Option A stays the fallback if the native view
#     misbehaves.
#   - jest gotcha: mock '@clerk/expo/native' but keep element creation OUT of the
#     jest.mock factory (NativeWind's babel transform injects _ReactNativeCSSInterop,
#     which the factory rejects as out-of-scope). Define the stub at module scope
#     AND defer the reference (UserButton: () => mockUserButton()), because ES
#     import hoisting evaluates the factory before the const is assigned.
#   - Checks green: 19 mobile tests, typecheck, lint (0 errors), expo export
#     bundles. EAS dev build 11 (versionCode 11) built + installed; the native
#     module linked fine. Device-verified: the avatar renders in the header.
#   - UI fix after first device look: DO NOT wrap <UserButton> in an
#     overflow-hidden rounded-full View — it clips the already-circular native
#     avatar off-center. Render <UserButton /> bare. This was a JS-only fix,
#     hot-reloaded on build 11 (no rebuild).
#   - Still to re-smoke on device: tap opens the native profile, sign out returns
#     to sign-in, Google sign-in still works, add-a-todo still works.
#   - Optional follow-up: pass a theme JSON to the plugin to tint the native
#     surface to primary #208AEF (see Clerk "Theming Expo native components").
#
# (original TODO kept for context)
# TODO — UI: Clerk user button (AFTER the dep upgrade; replace "Sign out"):
#   - Today the home header has a plain secondary "Sign out" Button. Replace it
#     with a proper Clerk user control: the user's avatar that, when tapped,
#     opens the Clerk account actions (manage account, sign out, etc.).
#   - CORRECTION to an earlier note: Clerk's <UserButton> is NOT web-only. Clerk
#     ships NATIVE components (AuthView, UserButton, UserProfileView) in
#     @clerk/expo/native (Core 3, SwiftUI/Jetpack Compose, Beta as of 2026-08,
#     needs Expo SDK 53+ and a dev build). Our OLD @clerk/clerk-expo (Core 2) had
#     no ./native export, which is why the drop-in wasn't available -- the
#     dep-upgrade step above (now on @clerk/expo v4) unlocks it.
#   - Option B (preferred once on Core 3): use <UserButton> from
#     @clerk/expo/native. Size it via the parent's width/height/borderRadius/
#     overflow; tapping opens the native UserProfileView (manage account,
#     security, sign out) with almost no code -- exactly "the Clerk actions that
#     come with it".
#   - Option A (fallback, no migration): build a custom circle avatar from
#     useUser() (imageUrl / initials) in a Pressable + a menu (reuse the
#     quick-add backdrop card, or @gorhom/bottom-sheet); signOut() from
#     useClerk(); "manage account" via expo-web-browser to the Clerk Account
#     Portal or a custom screen. Kept only if we decide NOT to move to Core 3.
#   - Avatar shape: circle (matches the "Person" entity avatar in the vision).
#   - Sources: Clerk "Set up Clerk with Expo Router" article, Expo "Using Clerk"
#     guide, clerk/clerk-expo-quickstart (@clerk/expo/native components).
#
# DONE — UI: Todoist-style quick add (branch ui-quick-add):
#   - Replaced the top inline "Input + Add" row with a circular + FAB (new
#     components/ui/fab.tsx) pinned bottom-right.
#   - Tapping it opens a bottom quick-add bar whose Input has autoFocus, so the
#     keyboard comes up immediately. blurOnSubmit={false} keeps the keyboard up
#     on submit; the bar stays open + cleared for rapid multi-capture. A
#     full-screen backdrop Pressable (and an empty submit) closes it.
#   - Keyboard avoidance: bar wrapped in <KeyboardStickyView> from
#     react-native-keyboard-controller (KeyboardProvider added at the root in
#     _layout.tsx). RN's own KeyboardAvoidingView / a hand-rolled Keyboard-height
#     offset both misaligned on Android edge-to-edge (a gap = the nav-bar inset).
#     keyboard-controller tracks the keyboard and handles insets on both
#     platforms.
#   - IMPORTANT: keyboard-controller is a NATIVE module, so it needs a new EAS
#     dev-client build before it runs on the phone (versionCode 9,
#     `eas build -p android --profile development`). It is the app's first native
#     dep beyond the Expo/RN baseline; NativeWind/safe-area were already native or
#     JS-only. After installing the new dev client, JS changes hot-reload as before.
#   - jest: the native module is mocked in jest.setup.js (registered via the
#     "setupFiles" jest config). The mock passthroughs return children directly,
#     NOT via JSX/createElement, else NativeWind's babel transform trips jest's
#     out-of-scope mock-factory guard (Invalid variable access _ReactNativeCSSInterop).
#   - Tests: fab.test.tsx (2), index.test.tsx updated to the FAB flow + a
#     rapid-capture assertion. 18 mobile tests pass, typecheck+lint clean,
#     expo export bundles. Device-verified on dev-client versionCode 9: bar sits
#     flush on the keyboard, rapid capture + backdrop-close work.
#   - Gotcha: this setup's render() is async — await it in tests, else the query
#     helpers are undefined ("getByLabelText is not a function").
# Local branches increment-0-nativewind / increment-1-todos /
# fix-todos-loading-state are merged to main, not yet deleted.
build order (capture point):
  0. [DONE, on main, commit 368a6c9] UI foundation: adopt NativeWind v4.
     Gotcha found: under pnpm, react-native-css-interop (NativeWind's engine)
     must be a DIRECT dep or Metro can't resolve `react-native-css-interop/
     jsx-runtime` (typecheck passes, bundling fails). Caught via
     `expo export --platform android` (bundles locally, no device/emulator).
     babel-preset-expo also had to be added explicitly once a babel.config.js
     existed. Skipped react-native-reusables CLI init; hand-placed Button/Text in
     src/components/ui with a cn() helper (clsx + tailwind-merge) matching web.
     No changelog entry: pure restyle, no behavior change.
     (original) UI foundation: adopt NativeWind v4 + react-native-reusables. Add tailwindcss,
     metro.config.js (withNativeWind), babel preset, tailwind.config.js (design
     tokens: color/spacing/type), global.css, nativewind-env.d.ts. Scaffold base
     components (Text, Button, Input) via react-native-reusables. Restyle the two
     existing screens (sign-in, home) through them. No behavior change. Verify on
     the real phone with `expo start --clear`. Independently shippable PR.
  1. [DONE, on main, commit 82dc1e7] Walking skeleton: signed-in user adds a text
     item on mobile; it persists in agent-api (per-user store) and shows in a
     list. No done/dates/order yet. Verified on the phone.
  2. [DONE] Mark done: tap the leftside circle -> vanishes from list, still
     stored (doneAt timestamp; open list = doneAt IS NULL).
  3. Scheduled date + today view: optional show-up date on add; list shows
     scheduled<=today + undated; future-dated hidden until their day.
  4. Postpone to tomorrow: one-tap reschedule.
  5. Manual reorder: drag to order, persisted. Position = priority.
  # After #5: capture point matches today's Todoist flow (minus recurring).
then later: recurring -> inbox/today split -> triage into Projects

---

## UI polish backlog (before increment 3)

Fixes to make the capture + done flows feel like Todoist. Not planned yet;
plan each before building. All mobile-only (apps/agent-mobile), pure JS, so
they hot-reload with no EAS build.

- Add flow — animate the quick-add input (PLANNED, see "Plan: quick-add morph +
  done fade-out" below). The circular + FAB should morph into the full-width
  quick-add bar and back (Todoist-style), rising with the keyboard, not the
  current instant swap. Imperative reanimated shared value + keyboard height.
- Done flow — fade out done items (PLANNED, see the same plan). Fade + collapse
  the row on done, rows below slide up, instead of the instant hard remove.
- [DONE] Add flow — confirm discard. Dismissing the open quick-add with unsaved
  text now shows a centered confirm dialog ("Discard changes?" / "The changes
  you've made will not be saved." / Cancel + destructive Discard) instead of
  silently clearing. Both paths gate on trimmed text: backdrop tap AND the
  Android hardware/navigation back button. Empty text still closes silently.
  Implemented as `src/components/ui/confirm-dialog.tsx` (reusable) + state in the
  home screen. GOTCHAS: the dialog is an in-tree absolute overlay, NOT an RN
  `Modal`, so the focused input keeps focus and the keyboard stays up behind it
  (an RN Modal on Android steals focus / drops the keyboard). Back is handled
  with `BackHandler.addEventListener('hardwareBackPress', ...)` returning `true`
  to consume it; the effect must return `sub.remove()` (deps: adding,
  confirmingDiscard, text, closeAdd) or a stale handler captures old state.
  DOUBLE-BACK GOTCHA (device-found): on Android the OS swallows the FIRST Back
  press while the soft keyboard is up (it just hides the keyboard) and never
  calls `BackHandler`, so back-only needed two presses. Fixed by also listening
  to `KeyboardEvents.addListener('keyboardDidHide', ...)` (react-native-keyboard-
  controller) and opening the dialog when the keyboard hides while the bar has
  unsaved text — the first Back now shows the dialog. Guard on
  `adding && !confirmingDiscard && text.trim()` so the hide during close doesn't
  re-open it. On Cancel we refocus the input (Input now forwardRef's to its
  TextInput) to restore the keyboard the Back press dismissed. Pure JS,
  hot-reloads with no EAS build. Tests: confirm-dialog.test.tsx (3) + home-screen
  tests (confirm, discard, empty-close). All mobile checks green, expo export
  bundles.
  EMPTY-BACK FIX (2026-08-26): with an empty input, the first Back (which Android
  turns into a keyboard-hide, never reaching BackHandler) now CLOSES the bar, not
  just the keyboard. The `keyboardDidHide` handler closes on empty text and
  confirms on unsaved text. The jest keyboard mock now records listeners and
  exposes `global.__emitKeyboardEvent(name)` so both branches are tested
  (2 new home-screen tests) instead of device-only.
---

## Plan: quick-add morph + done fade-out animations

Self-contained plan for a fresh agent. Assume only this doc. Two Todoist-style
animations on the mobile todo screen, both mobile-only (`apps/agent-mobile`),
pure JS + one babel config change. Research-backed (reanimated 4 docs, Software
Mansion blog, react-native-keyboard-controller / Expo keyboard docs, GitHub
issue software-mansion/react-native-reanimated#8231).

### Goal

1. **Quick-add morph** — the circular `+` FAB (bottom-right) expands/morphs into
   the full-width quick-add bar when opened, and collapses back into the FAB when
   dismissed, instead of the current instant swap. The bar rises together with
   the keyboard.
2. **Done fade-out** — marking a todo done fades and collapses the row out, and
   the rows below slide up to fill the gap, instead of the current instant hard
   remove.

Both are visual only. All existing behavior stays: rapid capture, discard-confirm
dialog, Android back-button + keyboard-hide handling, optimistic remove + error
rollback, the `markTodoDone` call.

### Context (verified in the repo, 2026-08-26)

- Screen: `apps/agent-mobile/src/app/(signed-in)/index.tsx`. FAB component:
  `src/components/ui/fab.tsx`.
- Today the screen conditionally renders: `adding === true` shows a
  `KeyboardStickyView` bar (`Input` + small `Fab`); `adding === false` shows the
  `Fab` pinned `absolute bottom-6 right-6`. The swap is instant.
- `onDone(item)` does an optimistic `setTodos(prev => prev.filter(...))`, calls
  `markTodoDone`, and re-inserts the item on error. Keep this contract.
- Deps already present: `react-native-reanimated@4.5.1`,
  `react-native-worklets@0.10.1`, `react-native-keyboard-controller@1.21.9`.
  Reanimated is **unused in `src` so far** — this is its first use.
- Keyboard height is trackable via `useReanimatedKeyboardAnimation()` →
  `{ height, progress }` shared values (already returned by the jest mock).

### Reanimated 4 reality (research)

- v4 is New-Architecture-only. The app is SDK 57 + New Arch, so fine.
- v4 moved worklets into `react-native-worklets`. Imperative
  `useSharedValue` / `useAnimatedStyle` code is unchanged from v2/v3.
- v4 also ships a new **CSS-style animation API**, but this plan stays
  **imperative** for the morph: the keyboard-follow needs a shared value anyway,
  so one shared driver is simpler than mixing CSS transitions with it. The CSS
  API adds nothing here.

### Pre-step (shared prerequisite): enable the worklets babel plugin

Reanimated 4 runs animated styles / layout animations through **worklets**, which
need the `react-native-worklets/plugin` babel plugin, added **last**.
`apps/agent-mobile/babel.config.js` currently has no `plugins` array. Without it,
animated styles and `entering`/`exiting`/`layout` props throw at runtime.
Reanimated errors clearly if you use the old `react-native-reanimated/plugin`
name — use `react-native-worklets/plugin`.

- Add `plugins: ['react-native-worklets/plugin']` to `babel.config.js` (only
  plugin, so it is last). GitHub issue #8231 shows this exact config
  (babel-preset-expo + `jsxImportSource: 'nativewind'` + `nativewind/babel`
  + the worklets plugin) working.
- Config change ⇒ needs `expo start --clear` (fresh Metro cache), like the
  NativeWind cache gotcha already recorded above.
- **No new EAS build expected**: reanimated + worklets native modules autolink
  from `package.json` and were present when dev build 11 was cut. **Verify on
  device**: if animations crash or no-op after `--clear`, the native module is
  missing from the installed client and a new
  `eas build -p android --profile development` is required. Flag this before
  assuming JS-only.

### Jest setup

Tests will now render Animated components. Use reanimated's shipped mock so
worklets and layout animations don't error under jest-expo:

- In `jest.setup.js` add
  `jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'))`
  (the standard, documented mock; disables real animation, makes `Animated.View`
  a passthrough). Try it first; fall back to `require('react-native-reanimated')
  .setUpTests?.()` if the mock fights jest-expo's transform.
- The existing keyboard-controller mock already returns
  `useReanimatedKeyboardAnimation: () => ({ height: { value: 0 }, progress: {
  value: 0 } })`, so keyboard-driven styles read a static 0 in tests. Tests
  assert presence + interactions, not motion.

### Accessibility (cheap, modern-correct)

Reanimated layout animations default to `ReduceMotion.System` (auto-respect the
OS reduced-motion setting). Add a `<ReducedMotionConfig />` at the app root (in
`_layout.tsx`) so both animations degrade to instant when the user asks. Optional
`useReducedMotion()` branch for the imperative morph if it doesn't honor System
automatically.

### Sequencing (two independent PRs)

Ship the fade-out first (simpler, lower risk, proves reanimated runs on device),
then the morph. The babel pre-step + jest mock + `ReducedMotionConfig` land with
whichever PR goes first; the second just uses them.

### Increment A: done-item fade-out

Wrap each todo row in `Animated.View` from `react-native-reanimated` with:
- `exiting={FadeOut.duration(200)}` so the removed row fades as reanimated defers
  its unmount.
- `layout={LinearTransition.duration(200)}` on the rows so siblings slide up to
  fill the gap (a bare `FadeOut` leaves the gap and snaps). Software Mansion
  "List Layout Animations" docs; cross-platform Android/iOS/web.
- Optional `entering={FadeIn}` so the error-path re-insert reappears smoothly.
- Keep the stable `key={item.id}` (reanimated needs it to track the leaving row).

Keep the mapped **ScrollView** (the project chose it over FlatList deliberately,
per increment-1 learnings, to avoid VirtualizedList act noise). The
`Animated.FlatList` + `itemLayoutAnimation={LinearTransition}` path is cleaner
for long lists — revisit only if the list grows.

`onDone` is unchanged: the optimistic `filter` triggers `exiting`; the error
re-insert triggers `entering`. No new state. If a plain `FadeOut` leaves a
visible height gap during the fade, upgrade to a custom exiting that animates
opacity **and** height to 0; start with `FadeOut` + `LinearTransition`.

Tests (`(signed-in)/__tests__/index.test.tsx`): the existing "tap done removes it
and calls markTodoDone" test must still pass (under the mock, `exiting` is a
no-op and the row unmounts immediately). No new test needed unless a helper
changes.

### Increment B: quick-add FAB ↔ bar morph

Replace the instant conditional swap with a single persistent Animated container
anchored to the bottom that always renders, driven by one shared `progress` value
(`0` = collapsed FAB, `1` = expanded bar).

- `const progress = useSharedValue(0)`; on open `progress.value = withTiming(1,
  { duration: ~220 })`, on close `withTiming(0)`. Keep the `adding` React state
  as the source of truth for mounting the `Input`, backdrop, and discard dialog;
  drive `progress` from an effect on `adding` (or set both together).
- One `useAnimatedStyle` interpolates the container between the two geometries:
  width 56 → screen width minus horizontal padding; borderRadius 28 → the bar's
  small radius; horizontal position bottom-right inset → full width (interpolate
  `right`/`left` or a `translateX`); the `+` glyph opacity 1 → 0 and rotate
  `0deg → 45deg` (the Reanimated blog's expandable-plus pattern); the `Input` +
  Add button opacity 0 → 1.
- **Keyboard sync**: translate the container up by the live keyboard height so it
  rises with the keyboard, using `useReanimatedKeyboardAnimation().height` in the
  same `useAnimatedStyle` (`translateY: -height.value`). This replaces
  `KeyboardStickyView` for the bar; keep `KeyboardProvider` at the root and the
  `KeyboardEvents` listener for the discard flow. (Note: reanimated's own
  `useAnimatedKeyboard` is deprecated in favor of keyboard-controller, which the
  app already uses.) Fallback: if a hand-rolled translate misaligns on Android
  edge-to-edge (the known inset trap), keep `KeyboardStickyView` wrapping an
  animated width/radius/glyph morph and only animate the shape, not the rise.
- The `Input` keeps `autoFocus`, `blurOnSubmit={false}`, `returnKeyType="done"`,
  and the `onSubmitEditing` → `onAdd` wiring so rapid capture still works.
- Backdrop `Pressable` (dismiss) and the `ConfirmDialog` stay mounted while
  `adding`, exactly as now; only their container's entrance is animated.
  `requestClose`, `closeAdd`, the `keyboardDidHide` listener, and the
  `hardwareBackPress` handler are unchanged — they gate on `adding` + trimmed
  text, which the morph does not touch.
- Because the container always renders, guard the FAB's tap: collapsed it opens
  (`setAdding(true)`); expanded the `+` is faded out and non-interactive (the
  Add-button role takes over). Keep both accessibility labels ("Add todo").

Tests (`fab.test.tsx`, `(signed-in)/__tests__/index.test.tsx`): under the mock,
animated styles are static, so the existing flow tests (tap FAB → bar with input;
backdrop tap → discard/close; rapid capture) must still pass against the
always-mounted structure. Adjust queries if the nesting changes; assert the same
behaviors. Do not assert interpolated style values.

### Verification (this box: no workerd, no emulator)

- `pnpm --filter @zero/agent-mobile test | typecheck | lint`, then
  `expo export --platform android` (bundles locally; catches worklets/reanimated
  resolve errors like the NativeWind engine gotcha did).
- Device: reload over Metro with `expo start --dev-client --clear`. Confirm
  (A) marking done fades the row and rows below slide up; (B) tapping `+` morphs
  it into the bar rising on the keyboard, and dismiss collapses it back to the
  FAB. Pure JS + babel config ⇒ **no deploy, no new EAS build expected** — but
  re-confirm the reanimated native module is in the client (see pre-step); if
  not, cut a dev build.

### Docs / changelog

- No `apps/agent-api/CHANGELOG.md` entry: the mobile todo app is a separate
  surface (routing rule at the top of this doc). Instead, on completion mark the
  two "UI polish backlog" bullets DONE with commits, and record the
  worklets-babel-plugin gotcha + whether a new EAS build was needed.

### Skills to use

- development-guidelines — throughout.
- react-testing / front-end-testing — the screen + FAB tests under the mock.
- tdd — light (mostly visual); keep existing behavior tests green as the guard.
- typescript-strict — shared-value / animated-style typing.
- git-commit — commits. open-pr — the two PRs.

### Acceptance criteria

- Worklets babel plugin wired; reanimated animations run on device (no crash, no
  no-op).
- Done: tapping the circle fades + collapses the row and rows below slide up;
  still removed and still `markTodoDone`-called; error path restores the row.
- Quick-add: `+` FAB morphs into the full-width bar and back, the bar rises with
  the keyboard; rapid capture, backdrop dismiss, discard-confirm, and
  back-button behavior all unchanged.
- Reduced-motion setting degrades both to instant.
- All mobile checks green; `expo export` bundles.

### Risks

- Native module not in dev build 11 → animations crash/no-op; verify on device,
  cut a new EAS dev build if needed.
- Morph + keyboard-sync jank on Android edge-to-edge (same class as the earlier
  KeyboardAvoidingView inset bug); mitigate with the `KeyboardStickyView`
  fallback above.
- jest reanimated integration with jest-expo; mitigate with the shipped mock.

---

## Plan: increment 1 (walking skeleton) — [DONE, commit 82dc1e7; kept for history]

Goal: a signed-in user adds a text todo on the mobile screen; it persists in the
per-user UserDO and shows in a list. No done, no dates, no order yet.

Backend (apps/agent-api):
- Migration `0037_todos.sql`: `todos(id TEXT PRIMARY KEY, text TEXT NOT NULL,
  created_at TEXT NOT NULL)`. id = crypto.randomUUID(). done/date/position land
  in later increments, added by their own migrations.
- Todos store module + schema entry following the existing UserDO db patterns
  (see UserDO/db/schema.ts, migrations.ts).
- UserDO RPC methods on UserDO/index.ts: `addTodo(text): Todo`,
  `listTodos(): Todo[]` (newest last / insertion order for now).
- Route file `routes/todos.ts` (OpenAPIHono, Clerk-authed like
  routes/user-settings.ts): `POST /api/todos {text} -> 201 todo`,
  `GET /api/todos -> { todos }`. Reach the DO via getUserDO(c.env, userId).
- Wire the router into app.ts next to the other /api routes.

Mobile (apps/agent-mobile):
- lib/api.ts: `addTodo(getToken, text)`, `fetchTodos(getToken)` using apiFetch.
- Home screen becomes the todo list: text input + Add button + list of todos.
  Keep sign-out reachable. (This screen is the future main surface.)

Tests:
- UserDO store test: add then list returns the item.
- Route test following user-settings.test.ts: POST then GET round-trips; two
  different users don't see each other's todos (DO isolation).
- Mobile lib/__tests__/api.test.ts: addTodo/fetchTodos hit the right path with
  the Bearer token.

Docs / changelog:
- Add a user-facing bullet to apps/agent-api/CHANGELOG.md (new todo list in the
  app). It ships as Zero's in-product Changelog topic.

Skills to use:
- development-guidelines (throughout), tdd (backend store + routes + mobile api),
  react-testing / front-end-testing (mobile screen), typescript-strict,
  changelog (the entry), git-commit (committing), open-pr (PR).

Acceptance criteria:
- POST /api/todos persists and returns the todo with an id.
- GET /api/todos returns only the caller's todos.
- On the phone: type text, tap Add, the item appears in the list; relaunching
  the app still shows it (persisted).
- lint + typecheck + unit tests green.

---

## Increment 1 + loading fix: DONE, on main, verified on device

Increment 1 = commit 82dc1e7. Loading-state fix = commit c46319d (list shows
"Loading your todos…" until the first fetch settles, instead of flashing the
empty message). Both merged to main and confirmed working on the phone.

Backend: migration 0037_todos.sql + todos schema, store/todos.ts (DbTodoStore),
UserDO addTodo/listTodos RPC, routes/todos.ts (POST/GET /api/todos) wired in
app.ts. Tests: store 3, routes 4. agent-api 928 tests pass, typecheck+lint clean.
Mobile: Input component, addTodo/fetchTodos in api.ts, home screen = Todos
(Input + Add + list). Tests: Input 2, api 2, HomeScreen 2. 14 tests pass,
typecheck+lint clean, expo export bundles.

Learnings (increment 1):
- do-orm ships an in-memory mock storage at `do-orm/src/test-utils`
  (createMockStorage) that runs INSERT/SELECT/ORDER BY, enough to unit-test a
  do-orm store WITHOUT workerd. But it does NOT implement MAX(), so do-orm's
  `migrate()` crashes on it — don't call migrate in those tests; the mock
  creates tables lazily on first insert.
- RN Testing Library: an async onPress handler needs the interactions wrapped in
  `await act(async () => { fireEvent... })`, else the changeText re-render isn't
  flushed and the button fires a stale handler (sees empty text). Product code
  was correct; only the test needed act.
- Used a mapped ScrollView instead of FlatList for the (short) capture list:
  simpler and avoids VirtualizedList act noise in tests. Revisit FlatList if the
  list grows long.

## Plan: loading-state fix (small, mobile only) — [DONE, commit c46319d]

Goal: while the first todo fetch is in flight, show a loading state instead of
the "No todos yet. Add one above." empty message. Distinguish "not loaded yet"
from "loaded and empty".

Only file: apps/agent-mobile/src/app/(signed-in)/index.tsx.

Change:
- Add a `loading` boolean state, initial `true`. In the load effect, set it
  `false` in a `finally` (so both success and error clear it). Keep `todos: Todo[]`
  as is (starts []), and the existing `error` state.
- List area render order: if `loading` -> a loading indicator
  (react-native ActivityIndicator, or a Text "Loading your todos…"); else if
  `todos.length === 0` -> the empty message; else the mapped list. `error` still
  renders above, as now.
- The add flow is unchanged (append to `todos`).

Tests (apps/agent-mobile/src/app/(signed-in)/__tests__/index.test.tsx):
- New: while the fetch is pending (a deferred promise that is not yet resolved),
  the loading indicator is shown and the "No todos yet" message is NOT present.
  Resolve the promise, then assert the empty message appears.
- Existing "shows fetched todos" and "adds a typed todo" tests still pass (they
  resolve the fetch, so loading clears). The add test already waits for the empty
  message after load, which now only appears once loading is false — still valid.

Verification: pnpm --filter @zero/agent-mobile typecheck|lint|test, expo export,
then reload on the phone (Metro job sw5) and confirm a brief loading state, not a
flash of "No todos yet", on launch. No backend change, so no deploy needed; this
is mobile-only and does not touch main's worker.

Skills: tdd (the loading test first), react-testing/front-end-testing, git-commit.

Acceptance:
- On launch, the list area shows a loading state until the first fetch settles.
- After it settles with no todos, the empty message shows; with todos, the list.
- All mobile checks green.

---

## Plan: increment 1 (detailed) — walking skeleton — [DONE, commit 82dc1e7; history]

Self-contained plan for a fresh agent.

Goal: a signed-in user types a todo on the mobile home screen, it POSTs to
agent-api, persists in the per-user UserDO SQLite, and shows in a list that
survives relaunch. No done/date/order (later increments).

Backend patterns (verified in the repo):
- Schema uses `do-orm`: `table()/column()` in `apps/agent-api/src/UserDO/db/
  schema.ts`. Migrations are `.sql` files imported into `db/migrations.ts` as a
  `migrations` object; `UserDO`'s constructor runs `migrate(ctx.storage,
  migrations)` inside `blockConcurrencyWhile`, so a new numbered file auto-applies
  on next DO wake. `createDb(ctx.storage)` gives `this.db: Database`; query
  helpers (`eq`, `asc`, `desc`, `and`) come from `do-orm`.
- The agent's big `Store` interface lives in `store/db.ts` (`DbStore`). Todos are
  a NEW, parallel concern, so DO NOT extend that interface. Add a dedicated
  small `TodoStore` (own module) over `Database`, keeping todos decoupled from
  the agent. This matches the "additive, non-interfering, becomes its own app"
  decision.
- Routes: OpenAPIHono routers mounted in `app.ts`. `/api/*` already has
  `clerkMiddleware()` + a guard that sets `c.get("userId")` (verified Clerk
  user). Reach the DO via `getUserDO(c.env, userId)` (`UserDO/stub.ts`).
  Follow `routes/user-settings.ts` for shape.

Backend changes:
1. `db/migrations/0037_todos.sql`: create table `todos` — `id TEXT PRIMARY KEY`,
   `text TEXT NOT NULL`, `created_at TEXT NOT NULL`. Register `m0037` in
   `db/migrations.ts` (import + add to the `migrations` object).
2. `db/schema.ts`: add `todos` do-orm table matching the migration (camelCase
   keys: `id`, `text`, `createdAt`).
3. `store/todos.ts`: `TodoStore` class over `Database` with `add(text): Todo`
   (id = crypto.randomUUID(), createdAt = new Date().toISOString()) and
   `list(): Todo[]` (order by createdAt asc). Pure over the db; unit-testable
   with an in-memory do-orm db like other store tests.
4. `UserDO/index.ts`: construct a `TodoStore` in the constructor; add RPC
   methods `addTodo(text: string): Promise<Todo>` and `listTodos():
   Promise<Todo[]>` delegating to it.
5. `routes/todos.ts`: `POST /api/todos { text } -> 201 { todo }` and
   `GET /api/todos -> 200 { todos }`, both reading `c.get("userId")` and calling
   the DO. Validate `text` non-empty with zod. Mount in `app.ts` after the auth
   guard, next to `createUserSettingsRoutes()`.

Mobile changes (agent-mobile, built on increment 0's NativeWind + components):
6. `src/components/ui/input.tsx`: base text input styled with className (mirrors
   Button/Text pattern).
7. `src/lib/api.ts`: `addTodo(getToken, text)` (POST) and `fetchTodos(getToken)`
   (GET), using the existing `apiFetch`. Add a `Todo` type.
8. `src/app/(signed-in)/index.tsx`: replace the settings demo with the todo
   screen — an Input + Add button that calls `addTodo` then refreshes, and a list
   (FlatList) of todos from `fetchTodos`. Keep sign-out reachable (e.g. header
   or footer). Loading + error states.

Tests:
- `store/todos.test.ts`: add then list round-trips; list is per-store isolated.
- `routes/todos.test.ts` (follow `user-settings.test.ts`): POST then GET
  round-trips through a real UserDO; two different `userId`s don't see each
  other's todos (DO isolation).
- `src/lib/__tests__/api.test.ts`: extend — addTodo/fetchTodos hit the right
  path/method with the Bearer token.
- `src/components/ui/__tests__/input.test.tsx`: renders, onChangeText fires.

Docs / changelog:
- Add a user-facing bullet to `apps/agent-api/CHANGELOG.md` (this ships as Zero's
  in-product Changelog topic): a new todo list in the app where you add items
  and see them. This IS user-observable, unlike increment 0.

Verification (this dev box: no workerd, no emulator):
- `pnpm --filter @zero/agent-api test`, `pnpm --filter @zero/agent-api typecheck`,
  `pnpm --filter @zero/agent-api lint` for backend.
- `pnpm --filter @zero/agent-mobile typecheck|lint|test` and
  `expo export --platform android` for the mobile bundle.
- On the phone: expo start (gob job, .env.local has the Clerk key), add a todo,
  see it, relaunch, still there. Note: mobile calls EXPO_PUBLIC_API_URL (default
  https://zero.juanibiapina.dev per README) — the /api/todos routes must be
  deployed (push to main) for the phone to reach them, since no local worker runs
  here. So: land the backend on main first, then verify on device.

Skills to use:
- development-guidelines (throughout), tdd (backend store + routes + mobile api +
  Input), typescript-strict, react-testing/front-end-testing (mobile),
  changelog (the entry), git-commit (committing), open-pr (if a PR).

Acceptance criteria:
- POST /api/todos persists and returns the todo with an id; GET returns only the
  caller's todos.
- On the phone: type text, tap Add, item appears; relaunch still shows it.
- All backend + mobile checks green; expo export bundles.

Open decision to confirm before building:
- API base URL for the phone. The dev client hits the DEPLOYED worker
  (zero.juanibiapina.dev / production UserDO). Fine for a single-user dogfood,
  but it means increment 1's backend must be on main before the device test,
  and todos land in the same production UserDO as the agent. Acceptable given
  the "additive in the same DO" decision; flag if you'd rather point the app at
  a separate/staging URL.
## Plan: increment 2 — mark a todo done (with a do-orm pre-step)

Self-contained plan for a fresh agent. Assume only this doc.

Goal: a signed-in user taps a done control on a todo; it vanishes from the list
instantly but stays stored. Matches the spec rule "Mark an item done -> vanishes
from the list instantly (still stored)".

Data model: add a nullable `doneAt TEXT` column to `todos` (ISO timestamp).
`null` = open, a timestamp = done. Chosen over a boolean `done` flag so *when* it
was completed is kept for free, which later increments (history, triage into
Projects, an undo / "completed today" view) will want. The open list = rows where
`doneAt IS NULL`.

do-orm gotcha (verified): do-orm has no null-comparison builder, and
`eq("doneAt", null)` emits `"doneAt" = ?`, which is never true in SQLite. So the
pre-step adds real `IS NULL` support to do-orm and `list()` filters open todos in
SQL. The real `db.ts` just concatenates a condition's `toSql().sql` fragment and
spreads its params, so an `IS NULL` fragment with empty params is safe on real
SQLite; only do-orm's in-memory mock matcher needs a new branch.

### Pre-step: add `isNull` / `isNotNull` to do-orm — [DONE 2026-08-26]

DONE. do-orm `0.2.0` (repo `juanibiapina/do-orm`, commit `8c77381`, tag
`v0.2.0`) exports `isNull(column)` / `isNotNull(column)`, emitting `"col" IS
NULL` / `IS NOT NULL` with no bindings. zero re-pinned to that commit in
`pnpm-lock.yaml` (both workspace entries) via `pnpm update do-orm` +
`pnpm install`, committed `007412b` and pushed to `main`. `@zero/agent-api`
typecheck confirms the export resolves; no agent-api code uses it yet.

What shipped in do-orm (for history):
- `src/conditions.ts`: `NullCondition` class (`toSql()` -> `{ sql: '"col" IS
  NULL', params: [] }`, plus the `IS NOT NULL` variant) + exported
  `isNull`/`isNotNull`; re-exported from `src/index.ts`.
- `src/test-utils.ts`: the mock WHERE matcher gained an `IS (NOT )?NULL` branch
  that consumes no param binding, so a mixed `and(eq(...), isNull(...))` keeps
  param alignment (the null check runs before the `"col" op ?` scan and never
  advances the param index).
- Tests (`src/db.test.ts`): isNull, isNotNull, and mixed-alignment — 60 pass
  (was 57), typecheck clean. README Conditions table + usage, new `CHANGELOG.md`,
  version 0.1.0 -> 0.2.0.

Gotcha confirmed while building: `eq("doneAt", null)` emits `"doneAt" = ?`, which
never matches in SQLite — that is exactly why `isNull` was needed. The JS-filter
fallback is now moot.

Remaining increment-2 backend/mobile work below can call `isNull("doneAt")`
directly.

### Backend (apps/agent-api)

6. Migration `db/migrations/0038_todo_done.sql`:
   `ALTER TABLE "todos" ADD COLUMN "doneAt" TEXT;`. Register `m0038` in
   `db/migrations.ts` (import + add to the `migrations` object). Auto-applies on
   next DO wake.
7. `UserDO/db/schema.ts`: add `doneAt: column.text()` (nullable) to `todos`.
8. `store/todos.ts`:
   - Extend `Todo` with `doneAt: string | null`.
   - `add`: set `doneAt: null` explicitly in the inserted object (do not rely on
     omitted-column insert behavior).
   - `list()`:
     `this.db.all(todos, { where: isNull("doneAt"), orderBy: asc("createdAt") })`.
   - `markDone(id): Todo | null`: `db.update(todos, { doneAt:
     new Date().toISOString() }, { where: eq("id", id) })`, return the updated row
     or `null` when no row has that id.
9. `UserDO/index.ts`: RPC `markTodoDone(id: string): Todo | null` delegating to
   the store.
10. `routes/todos.ts`: `POST /api/todos/{id}/done` -> `200 { todo }`, `404
    { error }` for unknown id. Add `doneAt: z.string().nullable()` to
    `TodoSchema`. Log `todo_done`.

### Mobile (apps/agent-mobile)

11. `src/lib/api.ts`: add `doneAt: string | null` to `Todo`;
    `markTodoDone(getToken, id, baseUrl?)` -> `POST /api/todos/{id}/done`.
12. `src/app/(signed-in)/index.tsx`: a leftside circular done control per row
    (`Pressable`, bordered `rounded-full`, matching the Person-circle motif),
    `accessibilityLabel={`Mark "${item.text}" done`}`. On tap: optimistic remove
    from `todos`, call `markTodoDone`; on error re-insert the item and show
    `error`. No un-done this increment (not in spec).

### Tests (TDD)

- do-orm: the `isNull`/`isNotNull` tests above.
- store `store/todos.test.ts`: `markDone` on the first of two -> `list()` returns
  only the second; the returned todo has a non-null `doneAt`; `markDone("nope")`
  -> `null`.
- route `routes/todos.test.ts`: extend the fake UserDO with `markTodoDone`;
  `POST .../done` -> 200 + todo, a following `GET` excludes it, unknown id ->
  404. Update existing `Todo` fixtures in this file for the new `doneAt` field.
- mobile api `src/lib/__tests__/api.test.ts`: `markTodoDone` hits
  `POST /api/todos/{id}/done` with the Bearer token.
- mobile screen `(signed-in)/__tests__/index.test.tsx`: seed a list, tap done on
  one -> it disappears and `markTodoDone` was called. Use the
  `await act(async () => { fireEvent... })` wrapper (async onPress; increment-1
  learning).

### Docs / changelog

- User-facing bullet in `apps/agent-api/CHANGELOG.md`: you can now mark a todo
  done and it leaves the list.
- Update the PROGRESS block + build order above: `inc 2 mark done` -> DONE with
  the commit, `inc 3 scheduled date` -> NEXT. Note the do-orm `isNull` addition.

### Verification (this box: no workerd, no emulator)

- do-orm: its own `pnpm test|typecheck` in the clone.
- `pnpm --filter @zero/agent-api test|typecheck|lint`.
- `pnpm --filter @zero/agent-mobile test|typecheck|lint` + `expo export
  --platform android`.
- Device: land backend on `main` first (the phone hits the deployed worker; no
  local worker here), then tap done -> item vanishes -> relaunch -> still gone.

### Skills to use

- workspace — cloning/editing the do-orm repo.
- development-guidelines — throughout.
- tdd — do-orm conditions, store `markDone`, route, mobile api, screen;
  test-first.
- typescript-strict — the nullable `doneAt` threading.
- react-testing / front-end-testing — the screen test.
- changelog — the entry. git-commit — commits (two repos). open-pr — if PRs.

### Acceptance criteria

- [DONE] do-orm exports `isNull` + `isNotNull`; real + mock storage honor them;
  zero pins the new commit (do-orm 0.2.0 / `8c77381`; zero `007412b`).
- `POST /api/todos/{id}/done` sets `doneAt` and returns the todo; unknown id ->
  404.
- `GET /api/todos` excludes done todos; done rows stay in the DB.
- On the phone: tap done -> item leaves instantly; relaunch -> still gone.
- All checks green across do-orm, agent-api, mobile; `expo export` bundles.

### Decisions locked

- Done control shape: leftside tappable circle per row (alt was swipe).
- One-way only this increment (no un-done); the `doneAt` timestamp leaves the
  door open for undo/completed views later with no further migration.
- [DONE] do-orm bump via `pnpm update do-orm` against HEAD of its default branch
  (spec is unpinned; the lockfile carries the hash). Landed as 0.2.0.

---

candidate terms:
  - Entity-as-block: each entity type must define its interactions with all app systems
  - Slot: a capacity limit on active projects, possibly a teaching mechanic
  - Workflow: entity-aware procedure (e.g. process-email) beyond a plain prompt
