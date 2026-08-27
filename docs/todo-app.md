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

## Data-store strategy (decided 2026-08-27): per-entity, not a generic bag

`DbCaptureStore` is deliberately specific to captures, and future entities
(Project, Person, Note…) get their own thin stores too. NOT a generic
`Repository<T>` / uniform CRUD bag. Reasons:

- do-orm already IS the generic layer (`db.insert/all/get/update` + conditions).
  A per-entity store adds only the entity's DOMAIN methods (capture: `add`,
  `list` = open Inbox, `process`) — that is the value, not CRUD.
- A uniform generic store fights the Minecraft-block philosophy above: adding an
  entity should force wiring its behavior, not be a no-op in a shared bag.
- One example is not enough to abstract. Extract a small shared base only at the
  ~third real entity (Rule of Three), and only for genuinely shared plumbing
  (id/createdAt conventions, a `list/get` helper) — never the domain methods.
- Keep product stores separate from the agent's `DbStore` (one namespace per
  product area); do not widen the agent interface with todo-app entities.
- Caveat: the TanStack DB adoption may shrink or dissolve the server-side store
  (client owns collections; the DO persists generically). Settle the sync-engine
  direction before investing in any server-store framework.

The thing to watch is duplicated CRUD boilerplate across future stores, not
specificity; do-orm + a Rule-of-Three base covers it when the time comes.

## Entity wiki (draft — grow one at a time)

Grounding: the entry point is modeled as GTD's **Inbox**, not a todo list (see
"GTD nomenclature" below). The foundational block is the **Capture**. The typed
entities a Capture becomes during **Process** (GTD Clarify) are exactly GTD's
eight endpoints: Trash, Someday/Maybe, Reference (≈ Note), Project, Done-now,
Waiting-For (≈ Person + delegation), Next Action (the real Todo), Calendar
(≈ our schedules). So the list below is the Clarify target set, not a loose bag.

- **Capture** — the foundational block and the entry point. A single raw line of
  text dropped into the **Inbox**: a thought, task, idea, book someone
  mentioned, anything. Deliberately UNTYPED and uncommitted (GTD "stuff"). No
  Project, no type, no priority at capture time. Actions: capture (add),
  **Process** (the GTD Clarify step — turn it into a typed entity and remove it
  from the inbox), optional **Tickler** date (resurface in the inbox on its day;
  a scheduled show-up, NOT a deadline). Rule: the Inbox is not a to-do list, and
  a processed Capture never goes back into it. First real slices (built as
  "todos", renamed to Capture): capture + Process.
- **Todo** (a.k.a. **Next Action**) — a typed entity a Capture becomes during
  Process, NOT the entry point. GTD-strict: the single physical, visible next
  step ("email James", not "follow up"), optionally with a Context
  (@computer, @calls, @home, @errands, @waiting). Belongs to a Project. This is
  what the app originally mis-modeled as the first block.
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

## GTD nomenclature (research, 2026-08-27)

Sourced from gettingthingsdone.com (David Allen Co.), the 2015 revised book via
Wikipedia, and practitioner guides. This is the vocabulary the app models. We
adopted **Capture** (item), **Inbox** (list), **Process** (the tap action, GTD
Clarify), **Tickler** (scheduled show-up date).

The five steps (2015 ed.): **Capture → Clarify → Organize → Reflect → Engage**
(2001 ed. named them Collect → Process → Organize → Plan → Do; "Process" ≈
Clarify, which is why our tap action is **Process**).

- **Capture** — collect everything with your attention into a trusted tool.
- **Clarify** — process each item: what is it, is it actionable?
- **Organize** — put it on the right list.
- **Reflect** — the Weekly Review.
- **Engage** — just do it.

Core nouns:

- **Stuff** — Allen's word for the raw, uncategorized captured items ("open
  loops", "incompletes"). Purist noun for an inbox item; bad for code/UI, so we
  say **Capture** (derived from the Capture step).
- **Inbox** ("in") — the collection bucket. Rules: empty it to zero regularly;
  it is NOT a to-do list; never put clarified items back into it.
- **Project** — any outcome needing 2+ actions.
- **Next Action** — the single physical, visible next step (the true "todo").
- **Context** — where/tool/person a next action needs (@computer, @calls, @home,
  @errands, @waiting, @anywhere).
- **Waiting For** — delegated items you track and chase.
- **Someday/Maybe** — not now; might do later.
- **Reference** — non-actionable info worth keeping (a recommended book).
- **Tickler file** ("43 folders") — date-based resurfacing: an item reappears on
  its day. This is our "scheduled show-up date" and the "recurring = resurface"
  idea.
- **Two-minute rule** — if a clarified item takes <2 min, do it now.
- **Weekly Review** — the Reflect cadence. **Trusted system** — the whole store.

The eight endpoints of Clarify (every inbox item leaves to exactly one):
Trash, Someday/Maybe, Reference, Projects (2+ steps; gets an outcome + next
action), Done-now (<2 min), Waiting-For (delegated), Next Action (context list;
single step), Calendar (day/time-specific). **These eight ARE the typed entities
the vision wants**, so Clarify/Process is the spine of the app, not a footnote.

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

story:   Replace Todoist's entry point with a GTD capture Inbox in zero: one
         fast place to capture any raw thought, then Process it later into a
         typed entity. NOT a todo list (the original mis-model; see the reframe
         plan below).
decisions:
  - VOCABULARY LOCKED (2026-08-27, GTD nomenclature): the item is a **Capture**,
    the list is the **Inbox**, the tap action is **Process** (GTD Clarify), a
    scheduled show-up date is a **Tickler**. Code, routes, tables, docs use these
    words; none say todo/done. Increments 0–2 were built as "todos" and get
    renamed to Capture (see "reframe the todo app as a GTD capture Inbox" below).
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
  - rule: Capture a raw item into the flat Inbox (untyped, uncommitted)
    examples:
      - Type "buy milk", tap add -> "buy milk" appears in the Inbox
  - rule: Process a Capture -> it leaves the Inbox (still stored)
    examples:
      - Tap the circle on "buy milk" -> vanishes from the Inbox instantly
      - (later) Process clarifies it into a typed entity (one of the 8 endpoints)
  - rule: Optionally set a Tickler date (a scheduled show-up, NOT a deadline)
    examples:
      - Add "pay rent", pick tomorrow -> hidden today, resurfaces in the Inbox tomorrow
      - Add "call mom" with no date -> shows in the Inbox now
  - rule: The Inbox = Captures due to show up now (tickler <= today, plus undated)
    examples:
      - Open the app -> today's + undated open Captures are visible in one list
  - rule: Inbox is hand-ordered; position IS the priority (no priority field)
    examples:
      - New Captures append at the bottom
      - User reorders to set priority (top = process first)

deferred (later slices, in rough order):
  - PROCESS/CLARIFY into typed entities — the spine. A Capture becomes one of
    GTD's 8 endpoints: Trash, Someday/Maybe, Reference (Note), Project, Done-now,
    Waiting-For (Person), Next Action (Todo), Calendar (schedule). Richest slice
    for the data model; promoted from a footnote to the next real increment.
  - Tickler: scheduled show-up date on a Capture + a "due today" Inbox view.
  - Separate the two roles: a pure capture Inbox vs a today/do-list. GTD rule:
    the Inbox is NOT a to-do list and processed items never return to it. This is
    the split the product must enforce, not just offer.
  - Recurring capture (a Tickler that re-fires) — GTD's answer to "recurring".
  - Reminders / push notifications.
  - (likely never, not used in Todoist today: subtasks, priorities, labels.)

questions:
  - Inbox view: ordering, and what Process does before the Clarify decision tree
    exists (today it just removes; see the reframe plan).

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
#   inc 3 RENAME todo -> Capture . DONE  commit a2d4d80 (DEVICE-VERIFIED on the
#                                 phone: existing captures survived migration 0039,
#                                 Process works, new capture works).
#                                 GTD reframe: migration 0039 renames
#                                 todos->captures & doneAt->processedAt (forward-
#                                 only; 0037/0038 untouched; live rows preserved);
#                                 backend store/routes/RPC (addCapture/listInbox/
#                                 processCapture, /api/captures[/{id}/process]);
#                                 mobile lib/captures.ts + screen title "Inbox",
#                                 circle label "Process", FAB "Capture",
#                                 placeholder "Capture a thought". Behavior
#                                 unchanged (add + Process). agent-api 934 tests,
#                                 mobile 32 tests, typecheck+lint+expo export green.
#   expo-ui refactor ............ DONE (branch refactor-mobile-expo-ui). Adopt the
#                                 native @expo/ui layer where it fits, per the
#                                 expo-ui / expo-native-ui skills. Three changes +
#                                 one recorded decision:
#                                 (1) Inbox list ScrollView+map -> a virtualized
#                                     reanimated Animated.FlatList (itemLayout +
#                                     per-row fade kept). @expo/ui List is native
#                                     but NOT virtualized, so it is the WRONG tool
#                                     for the unbounded Inbox -- FlatList is right.
#                                     jest gotcha: Animated.FlatList is undefined
#                                     in the reanimated mock; aliased it to the RN
#                                     FlatList in jest.setup.js.
#                                 (2) Sign-in CTAs -> native @expo/ui <Button> in a
#                                     <Host> (filled/outlined); deleted the custom
#                                     Pressable Button + its test (sign-in was the
#                                     only consumer). @expo/ui native module already
#                                     ships in dev client 11.
#                                 (3) Dropped unused template deps expo-symbols
#                                     (iOS-only SF Symbols; app is Android) and
#                                     expo-glass-effect.
#                                 KEPT custom, by decision (native did NOT fit):
#                                   - Quick-add bar stays a KeyboardStickyView +
#                                     reanimated cross-fade. @expo/ui has no
#                                     keyboard-attached quick-add primitive; a
#                                     BottomSheet changes the rapid-capture model.
#                                   - ConfirmDialog stays an in-tree overlay. The
#                                     only native path is RN Alert, a system modal
#                                     that dismisses the keyboard and cannot be
#                                     queried in-tree; it would regress the
#                                     deliberate keyboard-preserving discard flow
#                                     and its 3 tests for a marginal gain.
#                                   - Fab stays custom (not a native Button shape).
#                                 Checks: mobile typecheck+lint green, 29 tests
#                                 (down 3 with the custom Button), expo export
#                                 bundles. NOT yet device-verified (needs a phone /
#                                 dev client 11 running; @expo/ui native views must
#                                 render on device before merge -- same class as the
#                                 Clerk UserButton hazard).
#   inc 4 Process/Clarify ....... todo (THE SPINE: a Capture becomes a typed entity,
#                                 one of GTD's 8 endpoints. Richest data-model slice.)
#   inc 5 Tickler date .......... todo (scheduled show-up date + "due today" Inbox)
#   (dropped from the roadmap: "postpone to tomorrow" and "reorder = priority" as
#    standalone todo-list mechanics; revisit only as Inbox/Tickler behavior.)
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
  3. [DONE, a2d4d80] RENAME todo -> Capture (GTD reframe): migration 0039 renames
     todos->captures & doneAt->processedAt; behavior unchanged. Web parity
     shipped too (PR #49) + TanStack DB spike phase 0+1 on /inbox (PR #50).
  4. Process/Clarify: a Capture becomes a typed entity (one of GTD's 8 endpoints).
     The spine; richest data-model slice.
  5. Tickler date: optional scheduled show-up date on a Capture; Inbox shows
     tickler<=today + undated; future-dated hidden until their day.
  # After #5: the Inbox matches the user's real capture flow, GTD-faithful.
then later: recurring capture (tickler re-fire) -> enforce Inbox-vs-do-list split

---

## Plan: reframe the todo app as a GTD capture Inbox — [DONE, increment 3, a2d4d80]

Self-contained plan for a fresh agent. Assume only this doc.

### Goal

Stop modeling the entry point as a **Todo** (a task in a Project, "mark done").
Model it as GTD's **Inbox**: one fast place to capture any raw, untyped thought,
later **Processed** into a typed entity. "Todo" was the wrong first block (see the
entity wiki + GTD nomenclature sections above). Behavior does NOT change here:
add + remove-from-list stay identical. This is a rename of the concept across
code, data, docs, and vocabulary, so the NEXT increment builds Process/Clarify
(the spine) instead of todo-list features.

### Vocabulary (LOCKED 2026-08-27)

- item = **Capture** (table `captures`, type `Capture`)
- list/place = **Inbox** (UI title, empty-state copy)
- tap action = **Process** (GTD Clarify; column `processedAt`, RPC
  `processCapture`, route `POST /api/captures/{id}/process`, log
  `capture_processed`)
- scheduled show-up date = **Tickler** (increment 5, not this one)

Open Q resolved: today Process just removes the Capture from the Inbox (no
Clarify decision tree yet). `processedAt` is a nullable ISO timestamp; the Inbox
= rows where `processedAt IS NULL`.

### Data migration (preserve the user's real captures)

Real data lives in the production `todos` table in the live UserDO. Cloudflare DO
SQLite supports `RENAME TO` / `RENAME COLUMN`. DO NOT edit the applied
0037/0038 files. Add forward-only:

- `UserDO/db/migrations/0039_rename_todos_to_captures.sql`:
  ```sql
  ALTER TABLE "todos" RENAME TO "captures";
  ALTER TABLE "captures" RENAME COLUMN "doneAt" TO "processedAt";
  ```
- Register `m0039` in `db/migrations.ts`. Auto-applies on next DO wake.
- `db/schema.ts`: rename table `todos` -> `captures`, column `doneAt` ->
  `processedAt`, update the comment to describe the Inbox.

### Backend rename (apps/agent-api/src)

- `store/todos.ts` -> `store/captures.ts`: `DbCaptureStore`, `Capture`
  (`id`, `text`, `createdAt`, `processedAt`), `add` / `list`
  (`isNull("processedAt")`) / `process(id)`.
- `routes/todos.ts` -> `routes/captures.ts`: `GET /api/captures` -> `{ captures }`;
  `POST /api/captures` `{ text }` -> `{ capture }`;
  `POST /api/captures/{id}/process` -> `{ capture }` / 404. `CaptureSchema`. Logs
  `capture_added` / `capture_processed`.
- `UserDO/index.ts`: field `captures`, RPC `addCapture` / `listInbox` /
  `processCapture`.
- `app.ts`: `createCapturesRoutes()`.
- Keep the "standalone from the agent Store" boundary.

### Mobile rename (apps/agent-mobile/src)

- `lib/api.ts`: `Capture` type; `fetchInbox` / `addCapture` / `processCapture`.
- `lib/todos.ts` -> `lib/captures.ts`: `useInbox` / `useAddCapture` /
  `useProcessCapture`, `inboxKey`. Keep the React Query optimistic-remove +
  rollback contract.
- `app/(signed-in)/index.tsx`: title **"Inbox"**; "Loading your inbox…"; empty
  "Your inbox is empty. Capture something."; circle label
  `Process "${item.text}"`. All behavior (optimistic remove, fade-out, quick-add,
  discard-confirm, Android back) unchanged.
- `components/quick-add*.tsx`: labels "Add to inbox" / placeholder "Capture a
  thought".

### Tests (rename + update fixtures; assertions stay behavioral)

- `store/captures.test.ts`: add->list round-trip; `process` removes from the open
  list and stamps `processedAt`; `process("nope")` -> null.
- `routes/captures.test.ts`: POST then GET round-trips; process removes it;
  unknown id -> 404; two users isolated. Rename the fake UserDO methods.
- Mobile `lib/__tests__/api.test.ts`: the three functions hit the new paths with
  the Bearer token.
- Mobile screen + quick-add tests: same flows, renamed hooks/labels.

### Verification (this box: no workerd, no emulator)

- `pnpm --filter @zero/agent-api test | typecheck | lint`.
- `pnpm --filter @zero/agent-mobile test | typecheck | lint`, then
  `expo export --platform android`.
- Land backend on `main` first (phone hits the deployed worker). After deploy the
  migration runs on next DO wake; confirm existing captures survive (title now
  "Inbox", old items still listed), then Process one -> leaves -> relaunch ->
  still gone.

### Docs / changelog

- Mobile todo app is a separate surface: NO `apps/agent-api/CHANGELOG.md` entry.
  Record here (PROGRESS + build order) on completion; note the SQLite RENAME
  migration and that 0037/0038 stay untouched.

### Skills to use

- ubiquitous-language — keep code + docs on the locked nouns.
- refactoring — behavior-preserving rename with a green baseline; commit before,
  rename in safe steps. tdd — keep existing behavior tests green as the guard.
- development-guidelines, typescript-strict, react-testing / front-end-testing,
  git-commit, open-pr.

### Acceptance criteria

- Code, routes, tables, docs all say Capture/Inbox/Process; none say todo/done.
- Migration 0039 renames table + column; production captures survive after deploy.
- `GET /api/captures` = open Inbox; POST adds; `POST /api/captures/{id}/process`
  removes (404 unknown); users isolated.
- Mobile shows "Inbox"; capture + Process behave exactly as add + done did.
- All checks green; `expo export` bundles.

### Risks

- Migration on live data: forward-only, never edit 0037/0038, verify the swap on
  device after deploy before processing anything.
- Rename churn: `todo` appears across ~14 files, two packages. Lean on typecheck
  + green behavior tests; grep for residual `todo`/`done` after.
- Scope: rename only. Process/Clarify into typed entities is increment 4.

---

## Plan: adopt TanStack DB for the Capture Inbox data layer (spike-first)

STATUS: Phase 0 + Phase 1 DONE (PR #50, merge 99b03e1). /inbox runs on a TanStack
DB Query Collection + live query with optimistic capture/process, in-memory (no
persistence yet). Bundle grew 428->609KB raw (+~49KB gzip) for the TanStack
stack. A partial index (migration 0040, on captures(createdAt) WHERE processedAt
IS NULL) keeps the Inbox query fast. NEXT: Phase 2 (offline SQL persistence) —
now has its own verified, self-contained plan below ("Plan: Phase 2 — web
offline SQL persistence"). The 0.6-era API names in this section (see the
"Concrete API" note) are STALE; the Phase 2 plan carries the corrected 0.8.x
package names.

Self-contained plan for a fresh agent. Assume only this doc.

### Goal

Replace the ad-hoc data layers (web hand-rolled `fetch`, mobile React Query, both
over the DO REST API) with ONE local-first data layer built on **TanStack DB**,
giving instant/optimistic writes, offline persistence, and query-driven auto-sync,
shared across web and mobile. Land it spike-first on the isolated web `/inbox`,
prove it, then migrate mobile. Backend stays Cloudflare + the per-user DO +
do-orm + the existing `/api/captures` REST endpoints — no Postgres, no backend
rewrite.

### Why TanStack DB (decision, from a research pass 2026-08-27)

Compared against Zero, ElectricSQL, PowerSync, TinyBase, Legend-State,
WatermelonDB, RxDB, LiveStore, Triplit, Jazz. Most are Postgres/own-backend
engines that fight the Cloudflare per-user DO model. The two that keep the DO
backend and share web+mobile were TinyBase and TanStack DB. Chose TanStack DB:
it reuses the React Query mutation model the mobile app already uses (lowest
learning delta), keeps do-orm + the REST API, persists to SQLite on web (WASM),
Expo/RN, and even Cloudflare Durable Objects (0.6), and its **live-query engine
with joins** is the right foundation for the future eight-endpoint entity model
(Captures joined to Projects, Persons, etc.). Accepted tradeoff: Query
Collections are query-driven (refetch/poll), NOT real-time server push. For a
single-user Inbox this is fine; real-time multi-device is a later, optional
add (a custom DO-WebSocket collection or an Electric/PowerSync collection) that
does not throw away the collections + live queries built now. TinyBase's one
edge was a turnkey `WsServerDurableObject` push hub; we trade that for TanStack's
query DX and React-Query reuse.

### Concrete API (grounded in the 0.6 docs; confirm exact package names at impl)

- Packages: `@tanstack/db` (core `createCollection`), `@tanstack/react-db`
  (`useLiveQuery`), `@tanstack/query-db-collection` (`queryCollectionOptions`).
  Persistence (new in 0.6): `persistedCollectionOptions({ persistence,
  schemaVersion, ...<synced options> })` with per-platform SQLite adapters
  (browser SQLite WASM; RN `createReactNativeSQLitePersistence` over op-sqlite or
  expo-sqlite). Durable offline writes: `@tanstack/offline-transactions`. Pin
  versions; these are young (0.6) and churn.
- A capture collection wraps the Query Collection:
  `createCollection(queryCollectionOptions({ queryClient, queryKey:
  ['captures'], queryFn: fetchInbox, getKey: c => c.id, onInsert, onUpdate }))`.
  After any mutation handler resolves it auto-refetches (pass `{ refetch: false }`
  to skip when the server response is applied directly).
- Mutations map to the existing REST:
  - `onInsert` -> `addCapture(text)` (POST /api/captures)
  - `onUpdate` when `processedAt` is set -> `processCapture(id)`
    (POST /api/captures/{id}/process). Process is modeled as an UPDATE that
    stamps `processedAt`; the Inbox live query filters `processedAt == null`, so
    a processed row leaves the view (and stays available for a future
    "processed" view). No delete endpoint exists, so no `onDelete`.
- Read via `useLiveQuery(q => q.from({ c: capturesCollection })
  .where(({ c }) => c.processedAt == null).orderBy(({ c }) => c.createdAt))`.

### Where the code lives

Target: a shared factory `createCapturesCollection({ queryClient, persistence })`
in `packages/agent-core` (today an empty placeholder — this grows it), so the
collection definition, schema, and live queries are shared; each app injects its
platform QueryClient + persistence adapter. The spike MAY start inline in
`apps/agent-web` and extract to `agent-core` when mobile is brought in (Phase 3),
to avoid cross-package wiring before the model is proven.

### Phased plan (each phase independently shippable; a gate before mobile)

- Phase 0 [DONE, PR #50] — toolchain de-risk. Add the deps to `apps/agent-web`; a throwaway
  module that builds a trivial collection + live query. Verify
  `pnpm --filter @zero/agent-web typecheck | lint | build` (esp. that SQLite-WASM
  persistence bundles and its size is acceptable). On mobile, verify
  `expo export` still bundles with the RN persistence dep added. STOP if the
  toolchain fights (esp. Expo native SQLite = a new EAS dev build; see Risks).
- Phase 1 [DONE, PR #50] — web `/inbox` on a Query Collection (in-memory, no persistence).
  Add `@tanstack/react-query` + a `QueryClient` to `agent-web` (it has none
  today). Rebuild `InboxPage` on `capturesCollection` + `useLiveQuery`, with
  optimistic `onInsert`/`onUpdate` calling the existing `lib/captures.ts` REST
  helpers. Removes the hand-rolled `useState`/`useEffect`. Same behavior:
  capture appends, list oldest-first, Process removes, rapid capture,
  loading/empty/error. Still behind the unlinked `/inbox` — zero blast radius.
- Phase 2 — web offline SQL persistence. See the dedicated, verified plan
  below ("Plan: Phase 2 — web offline SQL persistence") for the corrected 0.8.x
  package names and the write-path design. In short: wrap the Query Collection
  in `persistedCollectionOptions` from `@tanstack/browser-db-sqlite-persistence`
  (SQLite-WASM/OPFS, durable reads) and route writes through
  `@tanstack/offline-transactions` (IndexedDB outbox, durable writes). PROVE:
  load `/inbox` offline (devtools offline) and last-synced captures render;
  capture while offline and it persists + syncs on reconnect.
- DECISION GATE. Evaluate DX, bundle size, and real offline behavior on the
  deployed `/inbox` before touching mobile or committing further. Cheap to
  abandon here (web `/inbox` is unlinked, no tests, no other consumer).
- Phase 3 — share + migrate mobile. Extract `createCapturesCollection` to
  `packages/agent-core`; consume it from both apps. Migrate the mobile Inbox off
  React Query hooks (`lib/captures.ts` hooks) onto the shared collection, with the
  RN SQLite persistence adapter. NOTE: local SQLite on mobile is a NATIVE module
  (op-sqlite/expo-sqlite) => a new EAS dev-client build (the app has NO local
  SQLite today; do-orm runs on the DO, not the device). Keep the existing mobile
  behavior tests green as the guard; adapt them to the collection.
- Phase 4 — real-time push (DEFERRED, not now). If multi-device live sync is
  ever needed, add a custom DO-WebSocket collection (or an Electric/PowerSync
  collection) without discarding the collections + live queries. Explicitly out
  of scope for this adoption.

### Backend impact

None for phases 0-3: the REST endpoints and do-orm stay. `queryFn` calls
`GET /api/captures`; handlers call the existing POST endpoints. Optional later:
add `loadSubset`/incremental sync or a WebSocket for Phase 4.

### Tests

`agent-web` has no test harness, so Phases 1-2 verify via typecheck + lint +
build + a deployed browser check (matches the app; the REST API is already
tested). Mobile (Phase 3) keeps its existing behavior tests as the guard, adapted
to the collection. Standing up Vitest Browser Mode for the web Inbox is a flagged
follow-up (front-end-testing skill), not a blocker.

### Verification (this box: no workerd, no emulator)

- Web: `pnpm --filter @zero/agent-web typecheck | lint | build`. No local
  end-to-end (the dev `/api` proxy needs workerd, which this box can't run);
  verify on the deployed `zero.juanibiapina.dev/inbox` after each phase (Phase 2:
  toggle devtools offline).
- Mobile (Phase 3): `pnpm --filter @zero/agent-mobile test | typecheck | lint` +
  `expo export`; device-verify over Metro (and a new EAS build for the native
  SQLite module).

### Risks & mitigations

- Young libraries (0.6), API churn -> pin versions; keep the spike isolated on
  `/inbox`; the DECISION GATE lets us bail cheaply.
- Mobile local SQLite = native module = new EAS build and added bundle/native
  surface -> confirm in Phase 0 `expo export`; treat Phase 3 as its own EAS-build
  increment; Phase 1-2 (web) need no native module (WASM).
- Web bundle size (SQLite WASM is hundreds of KB) -> measure in Phase 0; if
  unacceptable, fall back to a lighter web persistence (localStorage collection)
  or ship Phase 1 (in-memory) only and reconsider.
- Two apps eventually depend on `agent-core` with platform-specific adapters ->
  share only the collection definition/factory; inject QueryClient + persistence
  per app.
- do-orm vs collection shape -> the DO keeps do-orm + the `captures` table as the
  source of truth; TanStack DB is a CLIENT layer over the REST API, not a second
  server store. No server data-model change.

### Skills to use

- evaluate-existing-solutions — the library choice is made; revisit only if
  Phase 0/gate surfaces a blocker.
- development-guidelines — throughout. typescript-strict — collection schema +
  handler types. codebase-design — the `createCapturesCollection` factory
  contract in agent-core (Phase 3). git-commit — commits. open-pr — per phase.
- react-testing / front-end-testing — only if the optional web test harness lands.

### Acceptance criteria

- Phase 1: `/inbox` runs on a TanStack DB Query Collection + live query;
  capture/list/Process behave exactly as today; web checks green.
- Phase 2: `/inbox` shows last-synced captures while offline and queues+retries
  offline writes; verified on deploy.
- Phase 3: web + mobile share one `createCapturesCollection` from agent-core;
  mobile behavior tests green; mobile device-verified on a fresh EAS build.
- Backend unchanged across Phases 0-3; no Postgres introduced.

---

## Plan: Phase 2 — web offline SQL persistence

Self-contained plan for a fresh agent. Assume only this doc. VERIFIED against the
installed packages and the adapters' own 0.2.18 source (2026-08-27); no blockers.

### Goal

Make the unlinked web `/inbox` local-first: last-synced captures render while
offline, and a capture made offline persists across reload and syncs when the
network returns. Backend, DO, do-orm, and the `/api/captures` REST endpoints stay
unchanged. Ship behind the same unlinked `/inbox` route (zero blast radius), then
hit the DECISION GATE before mobile (Phase 3).

### Current state (verified in repo)

- `apps/agent-web/src/lib/captures-collection.ts`: a Query Collection built with
  `queryCollectionOptions` over a module-scope `QueryClient`. `queryFn:
  fetchInbox`, `onInsert -> addCapture`, `onUpdate (processedAt set) ->
  processCapture`. In-memory only.
- `InboxPage.tsx` reads via `useLiveQuery` (filter `isNull(processedAt)`, order
  `createdAt asc`) and writes via `capturesCollection.insert/update`, surfacing
  errors through `tx.isPersisted.promise.catch`.
- No `QueryClientProvider` in the tree; the collection holds the `QueryClient`
  directly. No web test harness.
- Installed: `@tanstack/db@0.8.5`, `@tanstack/query-db-collection@1.2.10`,
  `@tanstack/react-db@0.3.5`, `@tanstack/react-query@5.102.7`.

### Corrected API (the 0.6 names in the section above are STALE)

`@tanstack/db@0.8.5` does NOT export `persistedCollectionOptions`. Persistence now
lives in platform adapter packages that re-export it (verified by unpacking the
tarballs):

- Reads (durable local base): `@tanstack/browser-db-sqlite-persistence@0.2.18` —
  exports `openBrowserWASQLiteOPFSDatabase`, `createBrowserWASQLitePersistence`,
  and re-exports `persistedCollectionOptions` (from
  `@tanstack/db-sqlite-persistence-core@0.2.18`). Peer dep
  `@journeyapps/wa-sqlite@^1.4.1` (SQLite WASM engine, OPFS-backed) — a fork; add
  it explicitly (pnpm won't auto-pull a peer).
- Writes (durable outbox): `@tanstack/offline-transactions@1.0.51` — web import
  `@tanstack/offline-transactions` (RN import is a separate `/react-native`
  subpath). Outbox in IndexedDB with localStorage fallback, multi-tab leader
  election, FIFO, exponential backoff + jitter, `window.online/offline`
  detection. Its RN peers (`@react-native-community/netinfo`, `react-native`) are
  OPTIONAL, so web needs neither.

Version compat verified: `db-sqlite-persistence-core@0.2.18` and
`offline-transactions@1.0.51` both depend on exactly `@tanstack/db@0.8.5` = the
installed version. No peer war.

Two stores, by design (not a smell): SQLite/OPFS persists the synced snapshot for
offline reads; IndexedDB persists the write outbox.

Persisted collection shape (the spread is the vendor's own documented pattern;
`queryCollectionOptions` returns a `CollectionConfig`, which carries the required
`sync: SyncConfig`, so it satisfies `persistedCollectionOptions`'s synced
overload):

```ts
const database = await openBrowserWASQLiteOPFSDatabase({ databaseName: "zero-inbox.sqlite" });
const persistence = createBrowserWASQLitePersistence({ database });

export const capturesCollection = createCollection(
  persistedCollectionOptions({
    persistence,
    schemaVersion: 1, // bumping clears the local copy and re-syncs from server
    ...queryCollectionOptions({ queryClient, queryKey: ["captures"], queryFn: fetchInbox, getKey /* handlers: see write path */ }),
  }),
);
```

For a synced collection the server stays authoritative; persistence is only a
durable local base plus reconciliation on resume. `schemaVersion` bump = clear
local + re-sync (the escape hatch if the local store corrupts).

### The write-path decision (the crux)

Phase 1 writes go through the collection's own `onInsert`/`onUpdate`, which call
the REST API immediately and roll back on failure — no offline durability. Two
ways to get durable offline writes:

- Option A (recommended) — outbox executor. Move the server calls out of the
  collection handlers into
  `startOfflineExecutor({ collections: { captures: capturesCollection },
  mutationFns: { addCapture, processCapture } })`. Writes go through
  `offline.createOfflineTransaction(...).mutate(() =>
  capturesCollection.insert/update(...))`. The optimistic row applies locally and
  persists (SQLite base), the mutation persists to the IndexedDB outbox, and the
  executor calls the REST endpoint when online with retry. CONCRETE SHAPE
  (verified against 0.2.18 types, confirm at spike): define the collection
  WITHOUT server-calling `onInsert`/`onUpdate`. A write wrapped in
  `offlineTx.mutate(() => collection.insert(...))` joins the ambient offline
  transaction, whose `mutationFn` does the server call — so the collection needs
  no handlers. A bare `collection.insert()` outside an offline transaction then
  throws `MissingInsertHandlerError`, which is acceptable because every write goes
  through the executor. (`persistedCollectionOptions` passes the `CollectionConfig`,
  including any handlers, straight through, so keeping handlers here would
  double-send.)
- Option B (fallback) — reads-only persistence. Keep the Phase 1 handlers; add
  only `browser-db-sqlite-persistence`. Offline reads work; offline writes still
  fail. Cheaper/smaller but misses the "capture while offline" criterion. Note:
  `persistedCollectionOptions` still requires a synced collection here; Option B
  just drops `offline-transactions`.

Default to A. Fall back to B only if A is blocked at the gate.

### Implementation phases (each independently shippable)

- 2a — toolchain de-risk (mirror the Phase 0 discipline). Add
  `@tanstack/browser-db-sqlite-persistence`, `@journeyapps/wa-sqlite`,
  `@tanstack/offline-transactions` (pin exact versions). A throwaway module opens
  the OPFS database, builds a persisted collection, writes one row. Verify
  `pnpm --filter @zero/agent-web typecheck | lint | build` green, and MEASURE the
  bundle delta from `vite build` output (Phase 1 baseline: 609KB raw / ~+49KB
  gzip over the pre-TanStack 428KB). Record new raw + gzip. If the WASM payload is
  unacceptable, STOP (Option B, or a lighter localStorage read-persister).
  CRITICAL (C1): the browser adapter spawns a nested Web Worker via
  `new Worker(new URL("../assets/opfs-worker-*.js", import.meta.url))`, and that
  worker loads the wa-sqlite `.wasm`. Vite must emit BOTH the worker chunk and the
  wasm. A `vite build` can succeed while the worker URL 404s at RUNTIME. So 2a's
  real gate is opening the OPFS database in a real browser on the
  deployed/preview bundle and confirming the worker + `.wasm` return 200 (Network
  tab) — this box can't run it, so it is a post-deploy check, not a build check.
- 2b — wire persistence into `capturesCollection`. Rebuild
  `captures-collection.ts` to open the OPFS database and wrap the existing
  `queryCollectionOptions` in `persistedCollectionOptions`. The DB open is async;
  prefer a lazy/init-promise pattern over top-level `await` (avoids blocking first
  render AND makes the C4 fallback natural). Keep `useLiveQuery` in `InboxPage`
  unchanged. C4: `openBrowserWASQLiteOPFSDatabase` throws
  `PersistenceUnavailableError` when OPFS/Worker is missing (private browsing,
  older browsers) — catch it and fall back to the in-memory Query Collection so
  `/inbox` never hard-crashes.
- 2c — durable offline writes (Option A). Introduce the offline executor and route
  `insert`/`update` through it (collection defined without server-calling
  handlers, per the write-path shape above). Preserve the existing error surface
  in `InboxPage` (`ErrorText`). Handle the non-leader-tab case
  (`onLeadershipChange` -> online-only) at least with a comment; multi-tab is not
  a hard requirement for a single-user Inbox.

### System-wide impact

- No backend change. REST endpoints and do-orm untouched; `queryFn` still
  `GET /api/captures`, mutations still hit the existing POST routes.
- Serving: agent-web is bundled into `zero-api` static assets; the new `.wasm` +
  worker chunk ship there, within `zero-api`'s `apps/agent-web` watch path, so a
  push redeploys them.
- Auth: same-origin cookie, unchanged. Isolation: `/inbox` stays unlinked; `/` and
  every existing screen untouched.

### Tests

`agent-web` has no test harness (matches the app). Verify by typecheck + lint +
build + a deployed-browser check, same as Phases 0-1:

- Offline READ: load `/inbox` online, then DevTools -> Network -> Offline, reload
  -> last-synced captures still render.
- Offline WRITE: while offline, capture a thought -> it appears; reload (still
  offline) -> it survives; go online -> it syncs to the server (confirm it reaches
  the phone / same UserDO).
- No-regression: capture, oldest-first list, Process optimistic-remove, rapid
  capture, empty/loading/error all behave as Phase 1.

Standing up Vitest Browser Mode for these flows is a flagged follow-up
(front-end-testing skill), not a blocker.

### Verification (this box: no workerd)

- `pnpm --filter @zero/agent-web typecheck | lint | build`. Record bundle size.
- No local end-to-end (the `/api` proxy needs workerd). Push -> `zero-api`
  redeploys bundled assets -> run the offline read/write checks on
  `https://zero.juanibiapina.dev/inbox` (Phase 2: toggle devtools offline).

### DECISION GATE (before Phase 3 / mobile)

Evaluate on the deployed `/inbox`: real offline read + write behavior, DX of the
outbox wiring, and bundle size. Cheap to abandon (unlinked route, no tests, no
other consumer). Only proceed to extract `createCapturesCollection` into
`packages/agent-core` and migrate mobile if this holds up.

### Docs / changelog

- No `apps/agent-api/CHANGELOG.md` entry (todo app is a separate surface; route is
  unlinked anyway).
- Update this doc's PROGRESS + the TanStack plan STATUS on completion: record the
  real package names, that `persistedCollectionOptions` is re-exported from the
  adapter (not core 0.8.5), the two-store split (SQLite reads / IndexedDB outbox),
  and the measured bundle delta.

### Skills to use

- evaluate-existing-solutions — library choice made; revisit only if the gate
  surfaces a blocker. development-guidelines, typescript-strict — collection /
  persistence / handler types. codebase-design — keep the collection factory
  clean for the Phase 3 agent-core extraction. git-commit, open-pr — per phase.
  front-end-testing — only if the optional web test harness lands.

### Acceptance criteria

- `/inbox` renders last-synced captures while offline.
- A capture made offline persists across reload and syncs on reconnect (Option A).
  If shipped as Option B, this is explicitly deferred and recorded.
- Capture / list (oldest-first) / Process behave exactly as Phase 1.
- App root `/` and all existing routes unchanged; `/inbox` still unlinked.
- Backend unchanged; no Postgres.
- `pnpm --filter @zero/agent-web typecheck | lint | build` green; bundle delta
  measured and recorded.

### Risks & mitigations

- C1 — worker + WASM asset emission under Vite + zero-api static hosting is the
  single most likely break -> 2a de-risks it with a RUNTIME browser check on the
  deployed bundle, not just a green build.
- Stale doc API (0.6 names) -> corrected above; pin exact versions (young:
  adapters at 0.2.x, churn expected).
- WASM bundle size (hundreds of KB) -> measure in 2a; fall back to Option B or a
  localStorage read-persister; worst case ship reads-only.
- C3 — offline retries can DUPLICATE a capture: `/api/captures` has no idempotency
  key; `offline-transactions` hands the `mutationFn` an `idempotencyKey`, but the
  server ignores it, so a retry after a lost ACK (POST succeeded, response
  dropped) creates a second capture. For the spike, accept rare duplicates and say
  so; true exactly-once needs a server-side idempotency key (backend change, out
  of Phase 2 scope).
- C4 — OPFS unavailable (private browsing / old browser): catch
  `PersistenceUnavailableError` and fall back to the in-memory collection so
  `/inbox` never hard-crashes.
- No cross-origin isolation needed: the OPFS prereq check tests only
  `navigator.storage.getDirectory` + `Worker` (no `SharedArrayBuffer` /
  `crossOriginIsolated`), verified in the adapter source. OPFS needs a secure
  context; prod is HTTPS.
- Async DB open vs module-scope singleton export -> lazy/init-promise pattern in
  2b. Double-send if both collection handlers and the executor call the server ->
  omit collection handlers in Option A. Multi-tab -> leader election; non-leader
  tabs run online-only, acceptable for a single-user Inbox.

---

## Plan: web parity for the Capture Inbox (unlinked /inbox) — [DONE, PR #49, merge 0cee2eb]

Self-contained plan for a fresh agent. Assume only this doc.

### Goal

Let the user capture and process from a desktop browser, matching the mobile
Inbox, so the web is a real entry point too. Same three actions: capture (add),
Inbox (list open captures, oldest first), Process (remove). Built in
`apps/agent-web`.

### Isolation decision (LOCKED): unlinked `/inbox` route, no feature flag

The new Inbox must NOT interfere with the current web app (Settings home,
onboarding, admin). Chosen approach: add ONE additive route `/inbox` inside the
existing signed-in `Routes`, with NO header link and NO change to the index/home,
`AppHeader`, onboarding, or settings. The URL itself is the gate: nobody reaches
the Inbox unless they type `/inbox`. Rejected a build-time `VITE_ENABLE_INBOX`
flag: it is more machinery for less isolation (it still edits shared routing and
needs a new build var wired into the `zero-web` vault project), and an unlinked
route is a "flag-free flag". When the Inbox is ready to go live, promote it to the
home route in one small edit; no flag cleanup.

### Key facts (verified in repo, 2026-08-27)

- NO backend work. `/api/captures` and `/api/captures/{id}/process` already
  exist, are tested, and are deployed. Web is a pure new consumer.
- Auth is free. `apps/agent-web` is served same-origin by `zero-api` and
  authenticates with the Clerk COOKIE — existing `/api/user-settings` and
  `/api/telegram-*` calls use plain `fetch` with no Bearer header. So
  `fetch("/api/captures")` from the browser is already authenticated. No token
  plumbing (unlike mobile, which is cross-origin and sends a Bearer JWT). Both
  the web and mobile Clerk are the SAME instance and hit the SAME per-user
  UserDO, so the phone and web show the same Inbox.
- Stack: React 19 + react-router 8 + Clerk `@clerk/react` + Tailwind 4 + shadcn
  `src/components/ui/{button,input,card}`. `App.tsx` holds routing:
  `AuthGate` (signed-in guard) -> `AppShell` (fetches `/api/user-settings`,
  renders `<Outlet>` + `DevToolbar`) -> `index` = `HomeRoute` (onboarding gate ->
  `SettingsPage`), plus `onboarding`, `admin`, `admin/users/:userId`. `AppShell`
  gates render on settings load but does NOT force onboarding except on the index
  `HomeRoute`, so a sibling `/inbox` route renders directly (no onboarding
  redirect). `SettingsPage` renders its own `<AppHeader/>`; the Inbox page will
  do the same.
- Bundled into `zero-api` as static assets (`assets.directory
  ../agent-web/dist`); a push redeploys it (watch path `apps/agent-web`). Dev
  Vite (`server.proxy`) proxies `/api` -> `http://localhost:8790` (the agent
  worker), so local end-to-end needs workerd, which this box cannot run.
- NO test harness in `agent-web` (no vitest, no test script).

### Changes (all additive)

- `src/lib/captures.ts` (new): `type Capture` (`id`, `text`, `createdAt`,
  `processedAt: string | null`) and `fetchInbox()`, `addCapture(text)`,
  `processCapture(id)` using same-origin `fetch` (no token arg), throwing on
  non-ok. Mirrors the mobile `src/lib/api.ts` capture helpers minus the token.
- `src/pages/InboxPage.tsx` (new): `<AppHeader/>` + a persistent capture `Input`
  at top (Enter or an Add `Button` appends; on success the input stays focused
  and clears for rapid capture) + the open-capture list, each row a LEFT round
  Process control (a circular `Button`/pressable, `aria-label={`Process
  "${text}"`}`) and the text. Loading, empty ("Your inbox is empty. Capture
  something."), and error states. Process = optimistic remove from local state,
  call `processCapture`, restore the row + show error text on failure. Hand-rolled
  `useState`/`useEffect` (fetch on mount), matching `SettingsPage`'s style; do
  NOT add React Query to web (mobile needed it for Android resume/refetch quirks
  that do not apply to a desktop tab).
- `src/App.tsx`: add exactly one route inside the existing signed-in `Routes`,
  `<Route path="inbox" element={<InboxPage/>} />`. Nothing else changes — index,
  header, onboarding, settings, admin all untouched.

Reuse `ui/button`, `ui/input`, `ui/card`. No `AppHeader` edit (no nav link).

### Behavior parity checklist

capture appends (Enter or Add) · list oldest-first · Process optimistic-remove +
rollback · rapid capture (input stays open, cleared) · loading / empty / error.
Skip the mobile-only affordances (FAB morph, discard-confirm dialog,
keyboard-hide handling) — they solve touch problems a desktop input does not have.

### Tests

`agent-web` has no test harness today, so this ships WITHOUT web unit tests,
matching the app; the consumed API is already tested and unchanged. Verify by
typecheck + lint + build + a real-browser check after deploy. Standing up Vitest
Browser Mode (see the front-end-testing skill) is a flagged follow-up, not a
blocker for this slice.

### Verification (this box: no workerd)

- `pnpm --filter @zero/agent-web typecheck | lint | build`.
- No local end-to-end (the `/api` proxy target `localhost:8790` needs workerd,
  which this box cannot run). Push -> `zero-api` redeploys the bundled assets ->
  open `https://zero.juanibiapina.dev/inbox`: existing captures show (same UserDO
  as the phone), capture a new one, Process one, confirm it matches the phone.
  Confirm the app root `/` is unchanged (still Settings/onboarding).

### Docs / changelog

- Update this doc's PROGRESS on completion: web Inbox parity behind the unlinked
  `/inbox` route; record the cookie-auth (web) vs Bearer (mobile) difference.
- No `apps/agent-api/CHANGELOG.md` entry (the todo app is a separate surface, per
  the routing rule at the top of this doc), and the route is unlinked anyway.

### Skills to use

- development-guidelines — throughout. typescript-strict — the `Capture` type +
  fetch helpers. git-commit — commits. open-pr — if a PR.
- front-end-testing / react-testing — only if the optional Vitest harness is
  added.

### Acceptance criteria

- `/inbox` renders the Inbox for a signed-in user; capture, list (oldest-first),
  and Process (optimistic remove + rollback) all work and match the phone.
- The app root `/` and every existing screen/route/header are byte-for-byte
  unchanged; no link to `/inbox` exists.
- No backend change; `/api/captures` consumed with same-origin cookie auth.
- `pnpm --filter @zero/agent-web typecheck | lint | build` green.

### Risks

- A sibling `/inbox` route still renders under `AppShell`, which shows
  `DevToolbar` and waits for `/api/user-settings`; harmless and consistent with
  other pages. Mitigation: none needed.
- No automated web test; mitigated by the unchanged, already-tested API and a
  post-deploy browser check.

---

## UI polish backlog (pre-reframe; items mostly DONE)

Fixes to make the capture + done flows feel like Todoist. Not planned yet;
plan each before building. All mobile-only (apps/agent-mobile), pure JS, so
they hot-reload with no EAS build.

- [DONE] Bug — stuck "Unable to resolve host" on resume. Returning to the app
  sometimes showed a permanent `java.net.UnknownHostException` for
  `zero.juanibiapina.dev`, cleared only by a manual reload. INVESTIGATION ruled
  out a real DNS outage (host resolves), `getToken` identity churn (Clerk
  memoizes it on the stable client singleton, so `useEffect([getToken])` does not
  re-fire on resume), any AppState/focus/interval refetch (none in `src`), and
  StrictMode. Named cause class: a transient network failure at resume (Android
  keeps the radio asleep in the background, so the first request after wake can
  fail DNS once) hit the todos load, which set a permanent error with NO retry.
  The exact resume-fetch trigger (warm refetch vs Android cold-killing and
  remounting the process) was not pinned from the dev box; next probe is a build
  that logs the load effect + AppState across a background/foreground cycle read
  via `adb logcat`. FIX (best practice, chosen after research over a hand-rolled
  retry loop, an AppState-only refresh, or hiding the banner): adopt **TanStack
  Query (React Query)** for the todos server state instead of hand-rolled
  `useEffect`/`useState` fetching. It brings retry+exponential-backoff,
  refetch-on-reconnect, and refetch-on-focus — the documented React Native answer
  to this exact "refetch at the right time" problem. Wiring: `@tanstack/react-
  query` (pure JS, NO new EAS build); `QueryClientProvider` at the root;
  `focusManager` bridged to RN `AppState` ('active' => refetch on foreground) in
  `src/lib/query-client.ts`; the todos query + add/mark-done mutations (optimistic
  done + rollback) in `src/lib/todos.ts`; the home screen consumes those hooks.
  A load error now surfaces only when there's nothing to show, so a failed
  background refetch stays silent behind the last-good list. DEFERRED: NetInfo ->
  `onlineManager` for true "refetch the instant internet returns" (also covers
  wifi dropping mid-use), which needs a native module + EAS build. Tests wrap the
  screen in a QueryClient (retry off, gcTime 0). Pure JS, hot-reloads.

- [DONE] Add flow — animate the quick-add input. The plus FAB and the quick-add
  bar now cross-fade as the bar opens/closes and the bar rises with the keyboard,
  replacing the instant swap. ARCHITECTURE (per "treat them individually,
  separation of concerns"): two reusable presentational elements — `Fab`
  (existing) and `QuickAddBar` (`src/components/quick-add-bar.tsx`, input + Add
  button, no animation/keyboard logic) — plus a decoupled transition layer
  `QuickAdd` (`src/components/quick-add.tsx`) that owns ONLY the motion (cross-
  fade the two + keyboard-follow) and the backdrop. KEYBOARD-FOLLOW FIX
  (device-found): the first cut hand-rolled `translateY: useReanimatedKeyboard
  Animation().height`, which misaligned on Android edge-to-edge and left the bar/
  plus floating up where the keyboard had been when it dismissed — the exact trap
  the increment already knew about. Reverted to wrapping the open bar in
  `KeyboardStickyView` (tracks the keyboard + handles insets); the collapsed FAB
  is a separate absolute bottom-right view. The
  home screen owns state (adding/text/discard) and passes handlers down; the
  elements know nothing about the animation. RESEARCH: Todoist Android's quick-add
  is a bottom sheet off the FAB = Material's container-transform pattern (300ms,
  cubic-bezier(0.4,0,0.2,1), fade-through). A true single-surface container
  transform (shape+color+position in one tween) was designed but NOT built:
  guidance was to keep the FAB and bar as separate reusable elements, so the
  transition layer cross-fades them instead of morphing one surface. Reanimated
  shared-element transitions are experimental / not production, so a single-
  surface morph would be hand-built if ever wanted. Pure JS, hot-reloads. Tests:
  quick-add-bar.test.tsx (2) + existing home-screen flow tests still green (they
  drive the FAB/bar through QuickAdd). DEVICE-VERIFY: the keyboard-rise direction
  (height sign) and the cross-fade timing.
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
