# From Todoist to Full Assistant

Living doc, tracked in the repo at `docs/todo-app.md` (source of truth). It holds
the long-term **Vision** (philosophy + entity wiki) and **Project tracking**.
Each entity we actually build is documented on its own in `docs/entities/`; the
wiki below points at those. Detailed implementation plans live in `docs/plans/`.
Keep the tracking section and the per-entity docs current as increments land.

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
  `list` = open Captures, `process`) — that is the value, not CRUD.
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

**Rule-of-Three status (2026-09-04, extracted):** Task (#2) and Project (#3) were
built as deliberate structural siblings of Capture at every layer, and with three
in hand the client plumbing was extracted (plan:
`docs/plans/todo-rule-of-three-extraction.md`). What moved: the offline
collection factory (`packages/agent-core/src/collection/base.ts`: in-memory
fallback, persisted local-first sync, reconcile-after-write, outbox wiring,
client-minted id/createdAt), the list-region view rule (`listView`), and the
per-surface wiring (`apps/agent-mobile/src/lib/entity-api.ts`,
`apps/agent-web/src/lib/entity-api.ts`). Each entity's collection file is now a
verb table over that factory. What stayed per entity on purpose: the domain
verbs and their optimistic drafts, the REST contracts, and the server stores
(do-orm is already the generic layer; the leftover overlap is two 3-line idioms).
See `docs/storage.md`.

**Collapse to one list (decided 2026-08-31; merged 2026-09-12):** the
Capture/Task split proved premature — the user works in one list the way they do
in Todoist. This went through two stages. First the separate **Today tab was
removed** and the app was one **Captures** list, with Capture growing the moves a
single list wants (postpone to a day, drag-to-reorder, the detail sheet + date
scheduler) while Task sat parked. Then the **single-list merge** (2026-09-12,
`docs/plans/todo-single-list-1-merge.md`) finished the job the other way round:
**Capture was collapsed into Task**, so Task is the single entity and the one
list, and Capture is deleted. The scheduling/reorder/visibility behavior that had
been built on Capture moved onto Task. See the shipped entry below and
`docs/entities/task.md`.

## Entity wiki (draft — grow one at a time)

Grounding: **Task** is the foundational block and the entry point (Capture was
collapsed into it by the single-list merge, 2026-09-12), and **Project** is the
container. Everything else below (Person, Note…) is a vision draft, not
committed.

- **Task** — the **single entity and the entry point** (named `Task`, not "Todo",
  which collides with the app name). One line of work: a loose quick-capture with
  no project, or a committed next-action under a project. It owns the nullable
  `showUpDate`, the manual drag-reorder, and the Home/Upcoming visibility split.
  Fully documented in `docs/entities/task.md`.
- **Capture** — **retired.** Collapsed into Task by the single-list merge
  (2026-09-12); a quick-add with no project is a loose task now. Tombstone at
  `docs/entities/capture.md`.
- **Project** — the first container, entity #3 (plan:
  `docs/plans/todo-project-entity.md`; source of truth: `docs/entities/project.md`).
  Goal-oriented (baby, diploma, buy a house, watch a movie), sometimes
  maintenance-oriented (a "baby maintenance" project should maybe not exist). Has
  a nice icon (baby face, diploma), persisted lifecycle state (in-play / backlog /
  done), and calculated status (Active / Next / Waiting / After / Backlog / Done). Slices
  A1 + A2 shipped: name-only create and a status-grouped list on
  both surfaces; A3 added enrichment (an emoji icon picker over all standard emoji
  with search, editable title and notes). Slice A (the hand-managed entity) is
  complete. A project now opens **its own screen** (web `/projects/:id`, mobile a
  pushed screen), not a bottom sheet. It is a Project workspace whose identity,
  dominant status, description, manual Waiting conditions, After relationships,
  and Tasks are sibling regions. After is Project-to-Project completion
  sequencing and remains a fallback behind deliberate dated work and manual
  review. Vision beyond that: can contain Todos, agent sessions, documents. Can
  spin off other Projects and even People. Idea:
  project "slots", start with one slot to teach the game.
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
  in the session trace; following a link is a trackable tool. The [TaskDO plan](plans/todo-local-replica-task-do-slice1.md#future-online-agent-sessions) records how online sessions will access todo data.
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
- Starting a new agent session in an existing GitHub project is many manual
  steps in `juanibiapina/agent`: create a Telegram topic, name it, then run
  Telegram commands to bind it to the repo directory (e.g. the zero repo). Every
  new session against the same project repeats the whole ritual. In the todo
  app, spinning up a new session for a known project should be one click/action:
  the Project already knows its repo directory, so the app creates the Session
  and binds it in a single step — no topic naming, no directory-selection
  commands.

## Dreamy / low-confidence ideas (parked)

- Game-like timeline UI.
- Project slots as a teaching mechanic.
- Zero auto-creating projects from templates instead of the user creating them.

---

## Project tracking

Implemented (2026-09-26): `TaskDO` is the only todo authority for every signed-in
account. It owns the complete todo model, typed REST writes, account-scoped phone
persistence, and visible recovery and repair. The migrated production account
was verified after cutover; the other accounts had no todo rows to import and
start with empty TaskDOs. `UserDO` continues to own agent conversations and
other non-todo state. Its old todo tables remain untouched as inert recovery
data. Updated mobile clients open TinyBase directly without starting the retired
REST-backed todo collections. See
[the replica plan](plans/todo-local-replica-sync.md).

Implemented (2026-09-24): **Browse on mobile.** Home and Projects stay direct tabs; the rightmost Browse tab opens a menu with Upcoming. Its task list, editing, completion, and future-date rules stay the same. Android Back and the visible Browse action return to the menu. Plan: `docs/plans/todo-browse-upcoming-mobile.md`.

Implemented (2026-09-24): **Reorder tasks on a web project page.** The project's
Tasks region now follows the saved manual order and has a handle for pointer and
keyboard moves. A move writes only the task's existing global order key and
persists through refresh or navigation; completion and date chips remain separate
actions. See `docs/entities/task.md` for ordering and
`docs/plans/todo-web-project-task-reorder.md` for the implementation plan.

Implemented and Pixel-verified (2026-09-17): **Save Project descriptions before
workspace actions and exits.** The Project workspace now owns the description
draft and queues its existing optimistic, offline-durable edit before root touch
actions, visible or Android Back, route focus loss, unmount, and input blur.
Blank text clears the description to `null`; unchanged and overlapping save
signals do not add writes, while a failed write leaves the draft available for a
later retry. Thirteen focused Project-screen cases cover Add plus Task creation,
identity/relationship/Task actions, both Back paths, lifecycle cleanup,
deduplication, no-op and blank edits, and failure retry. Mobile's 24 suites / 185
tests, lint with 3 existing warnings, typecheck, and Android export passed. The
whole-repo check reached the documented unrelated NixOS `workerd` `EPIPE` failure
in dashboard Worker tests. The hermetic Pixel 7 run passed both behavior flows:
it retained the existing loose Task and a newly created Project description
through Back and reopening, then the local Worker returned exactly that Task and
described Project. Production stores, launcher state, development-client
identity, reverse ports, and harness processes remained isolated. Plan:
`docs/plans/todo-project-description-save.md`.

Implemented and Pixel-verified (2026-09-17): **Create Tasks from the mobile
Projects list.** The Projects-list Add drawer now offers Project and Task modes,
while keeping Project selected by default. Task mode reuses the global Task
composer, including its date and Project rows; Waiting and After remain
Project-workspace actions. A focused Pixel 7 check created a throwaway Project,
created and filed a Task from the Projects list, confirmed it in the Project,
and deleted the Project and its Task.

Implemented (2026-09-16; Pixel workspace flow verified): **Project Waiting,
After, and workspace redesign.** Manual Waiting is now Project-scoped prose that
requires review; After is separate Project-completion sequencing that resolves
automatically. In-play display precedence is Active → Waiting → After → Next, so
arrived or future-dated work and manual review can bring an After Project forward
without resolving its relationships. Projects lists After after Waiting and
collapsed by default. Each Project workspace now orders identity, dominant
status, description, all Waiting conditions, After Project rows, then Tasks with
one compact section rhythm; empty relationship regions disappear. Project Add
opens the shared drawer directly with Task, Waiting, After, and Project selectors,
and local add controls select their matching type. Completing a Project Task
persists immediately and offers Undo plus Waiting for…, which opens that drawer
on Waiting, shows the destination Project, and asks what needs to happen.
Completing a Project offers Undo and restores the After rows that completion
resolved. Historical Task and arbitrary Project-status
condition rows are removed. This supersedes the hard Blocked / Depends on behavior
recorded in the 2026-09-15 completion-dependencies entry below. **Pixel 7:** two
throwaway Projects proved focused After and Waiting creation, Waiting-over-After
and Active-over-both precedence, workspace order, local section add controls,
Project Task completion with Waiting for…, default-collapsed After, and light,
dark, and 1.3× font layouts. Both Projects and their cascaded Task/relationships
were deleted and device settings restored. Project-completion relationship
restoration remains package-tested but cannot be proven end to end until the new
Worker is deployed. Plan: `docs/plans/todo-project-waiting-after.md`.

Implemented and Pixel-verified (2026-09-16): **Recurring tasks and natural-language dates.** Task quick-add on web and mobile recognizes one-time dates and date-level repeat phrases through the new private `@zeroapps/recurrence` package, which hides Chrono, Temporal, and RRULE behind normalized versioned JSON. Tasks persist a separate recurrence cursor so one-off postpones do not move the pattern. Scheduled `every` rules catch up every missed occurrence, `every!` rules advance from completion, invalid month days clamp backward, inclusive end dates finish normally, and the existing single Undo restores the prior occurrence. Migration 0055 adds recurrence JSON + cursor columns; completion is expected-cursor guarded so offline replay cannot advance twice. **Device proof:** a throwaway `every day` task created through natural-language quick-add persisted its `every day` summary, advanced from Home into Upcoming, returned through Undo, and disappeared through Complete forever; production Workers Logs recorded two occurrence completions, one occurrence Undo, and the permanent completion. The throwaway task was removed. A follow-up now places the exact parsed schedule phrase on a colored inline background on mobile and web; tapping/clicking it keeps that phrase as title text and moves recognition to the previous date phrase in the same draft. On the Pixel 7, light and dark themes showed aligned ordinary text and high-contrast schedule badges, a long recurrence wrapped cleanly across three lines, tapping the active `Friday` badge moved the background and schedule summary to `today` without losing focus, recognized submission stored the cleaned title, and every throwaway task or draft was completed or discarded. Plans: `docs/plans/todo-recurring-tasks.md` and `docs/plans/todo-inline-schedule-highlighting.md`.

Implemented and Pixel-verified (2026-09-16): **Smaller clear-Home launcher icon.** The user selected candidate A from a Pixel-corrected comparison: the current checkmark path and material strokes are both 15% smaller, leaving visible white space around the mark under Pixel Launcher's circular mask. The adaptive foreground now occupies 444 × 323 pixels instead of 520 × 377 while preserving the checkmark's angle, proportions, graphite material, center, and safe-zone containment. Two generator runs produced identical hashes across all 31 tracked outputs; only the empty SVG, its three Android PNGs, and the family comparison changed. Mobile's 22 suites / 153 tests, lint with 3 existing warnings, typecheck, Android export, and clean prebuild passed. The whole-repo check reached the existing unrelated dashboard test shutdown timeout. Local ARM64 development-client versionCode 83 built successfully and installed on the Pixel 7 while preserving the naturally enabled Empty alias. Launcher search showed the selected reduced checkmark, and tapping it opened the development client. Verification made no production-data writes. Plan: `docs/plans/todo-smaller-empty-launcher-icon.md`.

Implemented and Pixel-verified (2026-09-15): **Three-row Android default
icon.** Android's primary APK, pre-hydration, and signed-out icon now uses the
approved static three-row mark. The dynamic launcher feature remains intact:
a new explicit Empty alias carries the checkmark after a hydrated Home resolves
to zero tasks, while one through four-plus keep their existing row states. The
generator now emits safe static adaptive and monochrome layers; two runs
produced identical hashes across all 31 outputs, and every existing task-count
asset stayed byte-identical. Mobile's 22 suites / 153 tests, lint with 3 existing
warnings, typecheck, Android export, clean prebuild, and local ARM64 native build
passed. Prebuild and the APK contain one enabled static Default alias plus five
disabled runtime aliases while leaving `MainActivity` and its deep links
available. Development-client versionCode 81 was clean-installed on the Pixel 7;
launcher search showed the three-row icon before first app launch, then a
temporary non-data-mutating harness switched to the checkmark on background and
back to the three-row default with exactly one alias enabled each time. The
production source was restored, sign-in read existing production state without
any write, and the real empty Home then selected the Empty alias normally. The
whole-repo check reached the existing unrelated dashboard
test shutdown timeout after the touched mobile checks passed. The four-ABI
`1.2.0` preview APK then built locally as versionCode 82 with runtime fingerprint
`e8aabe44052797dbbcb55bd179a7edeeb78896db`; its manifest retains the six
launcher aliases and preview update channel. The link-shareable APK replaced
versionCode 80 in the dedicated Drive folder and is the folder's only file. Plan:
`docs/plans/todo-android-three-row-app-icon.md`.

Implemented and Pixel-verified (2026-09-15): **Swipe project tasks to Today.**
A right swipe on a mobile project task now reveals Today, writes the reactive
local day through the existing offline-durable reschedule path, springs the
retained row back, and shows `Scheduled · Today`; an undated task thereby
commits the project to Active and appears on Home when the project is available.
Home keeps its separate swipe-to-Tomorrow exit without a success toast. The
shared `ReorderableTaskList` interface now selects either complete semantic
policy instead of exposing return/exit mechanics. Mobile's 22 suites / 152
tests, lint, typecheck, and Android export passed with the existing 3 lint
warnings and test warnings; the whole-repo check reached the documented NixOS
`workerd` `EPIPE` failure in untouched dashboard Worker tests. On the Pixel 7,
an isolated throwaway project stayed Next after a below-threshold swipe,
revealed Today during the committed swipe,
settled as Active with `Scheduled · Today`, appeared on Home, retained Home's
Tomorrow reveal, and persisted after project refresh. Screenshot and hierarchy
evidence captured both the Today reveal and settled caption; deleting the
throwaway project removed its task from Home. Plan:
`docs/plans/todo-project-task-swipe-today.md`.

Implemented and Pixel-verified (2026-09-15): **Automatic local-day
rollover and empty-Home refresh.** The mobile app now keeps one reactive
local-day clock for Home, Upcoming, Projects, project detail, task date controls,
and the Home launcher count. It publishes at local midnight and catches up on
foreground after Android suspends timers. Home's empty call to action now stays
inside the reorderable list, so the same pull-to-refresh surface remains
available with zero visible tasks. A Home screen regression proves a locally
cached next-day task appears after midnight without another server fetch;
another proves empty Home re-pulls Tasks, Projects, and Waiting Conditions. The
local-day lifecycle test covers an active midnight and a missed background
rollover. Mobile's 22 suites / 151 tests, lint, typecheck, and Android export
passed with existing warnings only; the whole-repo check reached the documented
NixOS `workerd` `EPIPE` failure in the untouched dashboard Worker tests. On the
Pixel 7, with networking disabled and the clock temporarily set to 23:59, an
existing future task appeared on Home at 00:00 and disappeared from Upcoming
without a pull, relaunch, or production-data write; automatic time and
networking were restored. Plan: `docs/plans/todo-mobile-midnight-refresh.md`.

Implemented, published, and device-verified (2026-09-15):
**Frequent private Android releases.** The preview app now includes
`expo-updates`, uses the EAS `preview` channel and environment, and guards each
release with the native `fingerprint` runtime policy. Relevant `main` pushes
publish an Android update only after lint/typecheck and build/test pass; a
separate full-history path gate prevents irrelevant pushes from entering the
publisher's cancellation group. The hermetic E2E configuration disables remote
updates. The public Clerk key now lives in the project-scoped EAS `preview`
environment. Normal and E2E Expo configuration checks passed, two Android
fingerprints matched (`02b05f3014c70d1c67ddcfb8654e9471190f2488`), actionlint
passed, and mobile's 21 suites / 148 tests, lint, typecheck, and Android export
passed with existing warnings only. The whole-repo check reached the existing
unrelated dashboard test shutdown timeout. Adding `expo-updates` exposed its use
of Android Gradle Plugin's default NDK 27.0.12077973; the declarative Android
shell in `juanibiapina/dotfiles` now includes that NDK beside React Native's
27.1.12297006. A local ARM64 development-client build then passed as versionCode
79, installed on the Pixel 7, loaded headless Metro, and completed a read-only
Home → Projects Maestro flow. The signed four-ABI `1.1.0` preview APK then built
as versionCode 80 with the expected URL, channel, runtime fingerprint, and
nonblocking launch values. GitHub CI passed and published an Android update whose
runtime exactly matches the APK. A matching update-protocol request returned the
published update, while an incompatible runtime returned 204 with
`NO_UPDATE_AVAILABLE`. The versionCode 80 APK replaced versionCode 77 in Drive,
is link-shareable, and is the folder's only file. A tester installed that APK and
cold-launched it twice; EAS then recorded one OTA install for one Android user,
zero failed installs, and a 0% crash rate. The offline cold-launch check was
skipped. Plan:
`docs/plans/todo-mobile-frequent-releases.md`.

Implemented and Pixel-verified (2026-09-15): **Project completion
dependencies.** An existing project can now depend on completion of one or more
other existing projects. Unresolved relationships produce a calculated Blocked
status, hard-hide the dependent project's dated tasks from Home without changing
their dates, and appear as navigable rows under Depends on. Completion settles
incoming relationships durably before the prerequisite leaves the working set;
the final settlement returns arrived tasks to Home immediately. Self, duplicate,
Done-target, and cyclic relationships are rejected, and deleting a prerequisite
warns about affected dependents before removing incoming relationships. Mobile
links from the status sheet; web uses the Project completion builder. Agent-core's
23 files / 156 tests, API's 86 / 1045, web's 3 / 44, and mobile's 21 suites / 148
tests passed with lint and typecheck (existing warnings only); Android export
passed. On the Pixel 7, two throwaway projects linked through the native status
sheet and searchable picker, the dependent showed its Blocked context and
separate Depends on row, row navigation opened the prerequisite, prerequisite
deletion disclosed the dependent impact, removing the relationship restored
Next, and both throwaway projects were deleted. Screenshot evidence captured the
Blocked detail. No existing entity changed and no EAS rebuild was required for
device verification. Local preview APK `1.0.0` versionCode 77 then built
successfully and replaced versionCode 76 in the dedicated Drive folder; the new
file is link-shareable and is the folder's only APK. Plan:
`docs/plans/todo-project-completion-dependency.md`.

Implemented and Pixel-verified (2026-09-15): **Project state is distinct from
calculated status** (Stage 1 of
`docs/plans/todo-project-completion-dependency.md`; dependency behavior remains
unimplemented). Projects now persist only In-play / Backlog / Done through a
`state` field; Active / Next / Waiting remain calculated presentation. Migration
0053 preserved every Project while mapping the old in-play values. One shared
`ENTITY_CACHE_VERSION` now invalidates every server-backed entity snapshot, while
a separate `OFFLINE_OUTBOX_VERSION` makes destructive queued-write resets
explicit; both moved to 2 for this breaking local shape. Agent-core's 20 files /
142 tests, API's 83 / 1031, web's 3 / 38, mobile's 21 suites / 140 tests, all
four lint/typecheck passes, and Android export passed (existing lint/test warnings
only). The production Worker build succeeded. On the Pixel 7, the refreshed
collections repopulated all four Project groups; a throwaway project moved Next
→ Backlog → Next through the status pill and was deleted; after Wi-Fi/mobile data
were disabled and the dev client was force-stopped, Home and Projects cold-loaded
the refreshed local snapshots, including Croatia Trip. Connectivity was restored
and no existing entity was changed. Local preview APK `1.0.0` versionCode 76
built successfully and replaced versionCode 75 in the dedicated Drive folder;
the new file is link-shareable and is the folder's only APK.

Implemented and Pixel-verified (2026-09-14): **Larger clear-Home launcher
icon.** After three comparison rounds, the user selected B Full: the original
check path is 1.45× larger and its graphite material strokes are 1.28× heavier.
The adaptive foreground now occupies 520 × 377 pixels instead of 369 × 271,
while remaining inside Android's guaranteed safe circle. The generator enforces
those bounds and rejected the old output; two runs produced identical hashes
across all 28 generated files, and only the empty-state SVG, its three Android
PNGs, and the family comparison changed. Mobile's 21 suites / 140 tests, lint
with 3 existing warnings, typecheck, Android export, and clean prebuild passed;
the whole-repo check reached an unrelated existing dashboard test shutdown
timeout after all mobile checks passed. Local development-client build 74 was
installed on the Pixel 7. Launcher search showed the selected checkmark under
the Pixel's circular mask, its default alias was the only enabled launcher
entry, and tapping it opened Home. The test read existing production data but
made no production-data writes. Plan:
`docs/plans/todo-empty-launcher-icon-weight.md`.

Implemented and verified in the browser and on the Pixel 7 (2026-09-14):
**Transparent, full-size web favicon.** Browser tabs now receive the approved
three-row graphite mark on transparency, enlarged to about 90% of its canvas, so
it sits directly on light, gray, or dark browser chrome without a nested white
square. The generator derives the SVG and PNG from the same layered source,
validates alpha, dimensions, centering, 88–92% coverage, and deterministic
output, and uses fresh web URLs to escape the previous favicon cache. This
supersedes only the web presentation in the square-first icon item below: Apple
touch, splash, iOS, Android legacy, and all five adaptive/monochrome launcher
outputs remained byte-identical. Web tests/build and mobile tests/lint/typecheck,
Android export, clean prebuild, real-size Chromium rendering, and Pixel launcher
search plus app launch passed without production-data writes. Plan:
`docs/plans/todo-transparent-full-size-web-favicon.md`.

Implemented and Pixel-verified (2026-09-14): **task project jump and filtered
assignment** (plan: `docs/plans/todo-task-project-jump-and-filter.md`). A
project-owned task's mobile editor now keeps its Project row for reassignment
and adds a separate native arrow that opens the exact project from Home or
Upcoming; the arrow stays hidden when that project is already open. The shared
project picker filters titles without hiding No project and resets each opening.
Pixel testing caught two native-only interaction failures: the icon host first
intercepted its parent press, and the keyboard covered the picker panel; disabling
icon hit testing and docking the bounded list above the keyboard fixed both.
Automated tests cover independent actions, anchored navigation, owner-screen and
loose-task suppression, matching, empty results, and reset. Device verification
used and deleted four throwaway projects plus two throwaway tasks; final cleanup
confirmed every throwaway entity was gone.

Implemented and verified in the browser and on the Pixel 7 (2026-09-14):
**Square-first, mask-safe icons.** The approved static and task-count artwork now starts on a
full-bleed square instead of baking in a circular crop. Web displays that square
directly; iOS and Android receive generated platform derivatives and apply their
own launcher masks. The splash keeps a transparent mark. Generation rejects bad
background, alpha, color, dimension, or Android safe-zone output; see
`docs/plans/todo-square-mask-safe-icons.md`.

Implemented and Pixel-verified (2026-09-14): **Dynamic Home-task launcher
icon.** Android now uses the approved checkmark when Home is clear, one to three
rows for those exact task counts, and four rows for every larger count. The
observer waits for Tasks, Projects, and WaitingConditions to hydrate and counts
the existing `homeTasks` result, so future, completed, groomed, and unavailable
work stays out. An app-owned Expo module changes launcher aliases only after the
app backgrounds while leaving `MainActivity` enabled for Clerk, app links, and
the development client. Asset generation is deterministic; unit tests, clean
prebuild, native compilation, all five Pixel states, repeated alias relaunches,
and default restoration pass. Plan and evidence:
`docs/plans/todo-dynamic-task-count-icon.md`.

Updated (2026-09-14): **Quiet project screens.** Removed the empty-project
message/Add task shortcut and the explanatory paragraph in the status sheet at
the user's request. The plus button, status disclosure, and status actions remain.
This supersedes the guidance portions of beta-polish slices 8 and 9. Mobile tests,
lint, and typecheck pass; Pixel verification covered empty Next/Backlog states and
both status sheets using a throwaway project, deleted afterward.

Implemented and launcher-verified on the Pixel 7 (2026-09-14): **Selected
white/graphite icon** on mobile and web. The approved SVG generates platform
assets and web favicons through `bin/generate-todo-icons`; see
`docs/plans/todo-selected-icon-integration.md`. Native archive rules now exclude
stale generated projects so Expo config applies on every build. The
`development-pixel` profile verifies native changes on ARM64 without reducing
preview compatibility. Application UI colors are unchanged.

Implemented and Pixel-verified (2026-09-13): **Beta flow polish**, plan and proof
at `docs/plans/todo-beta-polish.md`. Task drafts survive scheduling/moving/completion;
project deletion confirms its cascade; Undo respects longer native timeouts;
project pickers scroll and show selection; project creation shares draft protection;
departure failures stay visible; destination feedback links to the resulting list;
empty projects and status controls explain the next action; calendars reopen at
the selected month; non-color accessibility includes larger targets, spoken
feedback, and large-text drawers. Release verification also found and fixed
offline cold-start authentication by enabling Clerk's resource cache. Colors and
contrast were deliberately excluded. Each slice has its own commit and mobile
changelog entry.

Implemented and device-verified on the Pixel 7 (2026-09-13): **Direct
project status and focused settings on mobile** (plan:
`docs/plans/todo-project-status-and-settings.md`). The derived-status pill is now
the status-change control and opens the existing valid manual moves: Put in
play, Move to backlog, or Mark done. The `⋯` menu is now a compact native
Project settings menu containing only Delete project. Project descriptions and
their empty prompt now use the stronger secondary foreground color. Status
derivation, inline project editing, persistence, and the web interface are
unchanged. Mobile screen tests cover both backlog transitions, Done navigation, the settings
split, delete, and cascade refetch. **Pixel 7:** a throwaway project moved Next
→ Backlog → Next through the status pill, the settings menu showed only Delete
project, and deletion returned to Projects and removed the throwaway row.
Screenshots and UI hierarchies captured both presentations, and the stronger
empty-description prompt was inspected read-only on an existing project; no
existing project was changed.

Implemented and device-verified on the Pixel 7 (2026-09-13): **Create a project
from inside another project on mobile** (plan:
`docs/plans/todo-project-create-from-project-screen.md`). The project-detail add
drawer now offers Task / Waiting / Project through the existing deep
`useQuickAdd` module; Task remains first and resets as the default, while Project
uses the same optimistic, offline-durable create path and View toast as Home.
Projects created there are independent, not children of the open project. The
screen test covers creation, staying on the current project, toast navigation,
and the default after reopening. **Pixel 7:** from a throwaway parent project,
the three tabs fit above the keyboard with Task selected; Project created a
throwaway child while the parent stayed open and raised the expected toast; the
child persisted in the Projects list; reopening defaulted to Task. Both
throwaway projects were deleted and no existing entity was changed.

Implemented and device-verified on the Pixel 7 (2026-09-13): **Project task
reorder and the original swipe-to-Tomorrow behavior on mobile** (plan:
`docs/plans/todo-project-task-reorder-postpone.md`). The project swipe target was
superseded by Today on 2026-09-15; the rest of this item records the original
gesture shipment. Project detail introduced the same deep
`ReorderableTaskList` module as Home: long-press drag writes the moved
task's existing fractional `sortKey`, while a committed right swipe sets local
Tomorrow through the existing offline-durable reschedule verb and springs the
retained project row back with its new schedule caption. The project page is one
virtualized scroll host with its identity/description in the header and waiting
conditions in the footer. The module owns the proven gesture arbitration: the
row pan fails on vertical intent, the reorder pan waits 520 ms, and Android
refresh disables only during an active drag. Screen tests cover persisted manual
order, project-scoped drop neighbors, undated swipe threshold/commit, retained
Tomorrow presentation, and three-collection refresh. **Pixel 7:** a 15-task
throwaway project scrolled from a row, showed pull-to-refresh from a row, moved
`ZZ drag 05` above `ZZ drag 02` and kept that order after reopening plus a server
refresh, rejected a below-threshold swipe, and kept an undated swiped task in the
project as `Scheduled · Tomorrow` while also showing it in Upcoming. The editor
and completion targets remained distinct. Screenshot and hierarchy evidence were
captured, then deleting the project removed every throwaway task from Upcoming.

Implemented and device-verified on the Pixel 7 (2026-09-13): **Project task
schedule clarity on mobile** (plan:
`docs/plans/todo-project-task-list-clarity.md`). A future task no longer appears
as an unexplained automatic row under Waiting on: the project status now reads
`Waiting · until <day>`, while the source task reads `Scheduled · <day>`.
Waiting on is reserved for real condition entities, with condition-before-date
precedence still supplied by the shared `waitingBadge` module. Project tasks now
reuse the standard mobile `ListRow`, giving them the established 46 dp minimum
row, full-row edit target, and inset dividers; long titles wrap above their muted
schedule caption. Shared derivation and persistence are unchanged. The mobile
screen tests cover date-only and condition-plus-date states. **Pixel 7:** a
throwaway project with undated and long Tomorrow tasks showed the contextual
status, source caption, roomier rows, clean wrapping, and no Waiting-on section;
the row opened the shared editor, completion Undo restored a throwaway task, and
the project was deleted afterward.

Shipped, device-verified on the Pixel 7 (2026-09-12): **Retire take-on — the
show-up date is the sole commitment gate** (plan:
`docs/plans/todo-retire-take-on.md`). The take-on/park star (`takenOnAt`) is gone
end to end: a project task reaches Home only when it has a date that has arrived
(`showUpDate <= today`) and its project is `active`; an undated project task is
groomed on the project screen only (the loose/project null-date asymmetry — a
loose task with no date still always shows on Home). Committing a groomed task is
now "give it a date" (Today), reusing `reschedule`; there is no separate verb. The
project screen's per-task star became a **date chip** (web + mobile) opening the
existing scheduler; picking Today commits the task and flips the project active,
"No date" keeps it groomed. New tasks added on a project start **undated**. The
derivation swapped its predicate from "taken-on" to "has a shown-up date"
(`projectBaseStatus`, `waitingUntil`, `homeTasks`), so a future-dated task is now
itself the commitment that drives "waiting until <day>" and Upcoming, and a
shown-up dated task overrides an open waiting condition. Migration 0052 drops the
`takenOnAt` column (rebuild), backfilling any undated taken-on row to
`date(takenOnAt)` so it stays on Home (zero rows in practice). The `takenOnAt`
field/verb/log left the store, routes, `UserDO`, the `Task` type, the collection,
and both surfaces' REST + UI. Web reused a shared `ScheduleMenu` component; mobile
reused the detail sheet's `ScheduleSheet`. The **Home quick-add also became a
mini-composer**: in task mode it shows a date chip and a project chip (web +
mobile), so a quick-add can be dated and filed to a project at create time;
filing a dateless task to a project lands it groomed (off Home) behind a "Filed to
<project>" toast. A device-only bug was caught and fixed on the Pixel 7: opening a
composer picker dismisses the keyboard, and the mobile Home's keyboard-hide
handler closed the whole quick-add before the picker showed — guarded now with the
picker-open flags plus a short suppression window for the close race.
**Device-verified on the Pixel 7** (throwaway project): project-screen date chip
commits a groomed task (No date → Today → project Active, task on Home); the Home
composer files a dateless task to a project (groomed, off Home) and dates a loose
task onto Home; both pickers open without closing the composer. Supersedes
Decision A of `docs/plans/todo-project-task-row-parity.md` (the star is replaced,
not kept).

Implemented (2026-09-12, mobile; Pixel 7 verified): **task creation and editing
share an editor-first bottom drawer** (`TaskEditorSheet`). A grip, strong title
row, and full-width date/project rows replace the temporary round pills; create
modes are direct text tabs. The selected project supplies its own icon once.
Creation opens the keyboard and confirms before discarding text; editing opens
without the keyboard and saves on dismissal. `useQuickAdd` and `useTaskDetail`
retain their separate write lifecycles. Editing keeps the Modal. On
2026-09-24 creation moved into the screen window so native input focus can
start the keyboard immediately; `KeyboardStickyView` docks the drawer using
the measured gap below the screen. The Projects list kept its then-project-only bar,
but its input adopted the same editor typography; the 2026-09-17 follow-up added
Task as a second mode. See
`docs/plans/todo-unify-task-editor-drawer.md` and
`docs/plans/todo-task-drawer-editor-first-restyle.md`.

Shipped (2026-09-12, mobile — device pending): **the project screen reuses the
shared task editor and quick-add composer** (plan:
`docs/plans/todo-project-task-edit-and-shared-add.md`). Tapping a task on a
project's screen now opens the same `useTaskDetail` editor Home and Upcoming open
(rename, schedule, move, complete-with-Undo), instead of a dead row. The
project-screen add path became the same composer Home uses: the quick-add state,
per-mode writes, date chip, discard-confirm, and keyboard-race guard were
extracted from Home into one shared deep module, `useQuickAdd`
(`apps/agent-mobile/src/components/quick-add-composer.tsx`), a sibling of
`useTaskDetail`. Two adapters make the seam real — Home (task/project modes, no
preset project) and the project screen (task/waiting modes, `projectId` presets
the project chip to this project). Both show the same date **and** project chips
in task mode; on the project screen the project chip starts on this project and
is changeable (pick another project or make the task loose), and filing to a
DIFFERENT project than the screen's own raises the "Filed to project" toast (to
this project it stays quiet — the task lands right there). Consequence: the
project screen gained create-time **date and project chips** and lost the
per-task inline date chip from the take-on retire (scheduling now lives in the
editor), so its task rows read like every other list row.

Shipped (2026-09-12): **Delete a project cascades to its tasks and waiting
conditions** (plan: `docs/plans/todo-project-delete-cascade.md`). Deleting a
project no longer leaves
orphans: `DELETE /api/projects/{id}` now also hard-removes every task with that
`projectId` (open or completed) and every waiting condition on the project. Before
this, an orphaned task was a ghost — hidden from Home (its project is gone, so
`homeTasks` gates it out) yet still an open row, and a future-dated orphan even
lingered in Upcoming (which applies no project gate). The cascade lives in the
`UserDO` composition root (`deleteProject` calls the project delete, then
`DbTaskStore.deleteByProject` and `DbWaitingConditionStore.deleteByProject`), so
each per-entity store still owns only its own table; the route stays 204 and
idempotent and now logs the cascade counts. On both surfaces the project-detail
screen re-pulls the tasks and waits collections once the delete persists, so any
lingering orphan drops at once (offline, the client cascade waits for reconnect;
Home already hides the orphan meanwhile). No schema/migration change. Store, route
(via a cross-store composition test), and both screen tests pass. **Device-verified
on the Pixel 7:** a throwaway project's taken-on task was dated to tomorrow (so it
sat in Upcoming, the surface with no project gate where an orphan would otherwise
linger), the project was deleted, and the task vanished from Upcoming at once — and
production Workers Logs recorded the `project_deleted` cascade (`tasks: 1`),
confirming the server delete, not just a client hide. Deleting a project stays
permanent (no undo).

Implemented, device verification pending (2026-09-12): **Date-aware
availability** — the last slice of the single-list series (plan part 3
`docs/plans/todo-single-list-3-date-availability.md`). A project's derived status
is now date-aware: a taken-on task postponed to a future day no longer keeps its
project `active` — the project instead **waits until that day**, derived purely
from the task's `showUpDate` with **no** stored `waiting_conditions` row, and the
day it arrives (shown-up) makes the project `active` again with no write on either
transition. A not-taken task whose date passed leaves the project `Next` and lives
only on the project screen. Derivation only, no migration: `projectDisplayStatus`
threads the user's local `today` and gates `active` on shown-up taken-on tasks; a
new `waitingUntil` returns the soonest future-dated taken-on task's day; and one
new shared seam `waitingBadge` folds both wait kinds (elapsed "3 days" for a
condition, "until <day>" for a date) into a single label + sort key, replacing the
per-surface `waitingSince ?? createdAt` idiom the web and mobile Projects lists
duplicated. The project screen's Waiting-on section shows the derived "until
<day>" as an automatic reason (no Resolve/delete). Shared unit tests
(`derive`/`waitingUntil`/`waitingBadge`), web page tests, and mobile screen tests
pass; **Pixel 7 device verification is pending** (postpone a taken-on project task
→ it leaves Home, project shows "waiting until <day>", the day arrives → it
returns to Home and the project is active). This closes the derivation work of the
single-list series; the remaining loose ends are pushing/device-verifying parts 1
and 2 and giving web Upcoming a move-to-project affordance (see the plan's "Series
closeout").

Shipped (2026-09-12): **Move a loose task to a project** (plan part 2
`docs/plans/todo-single-list-2-move-to-project.md`). A task's detail now carries a
Project row + picker: filing a loose task under a project (or moving it back to
loose) rides one new `projectId` field on `PATCH /api/tasks/{id}` (store
`setProject`, RPC `setTaskProject`, collection `moveToProject`, log `task_moved`).
Moving into a project clears `takenOnAt` server-side so the task obeys the
project's curation gate; moving back to loose leaves it. On mobile it works from
both Home and Upcoming (shared task detail); on web from Home only (web Upcoming
has no detail sheet yet — deferred). Server + agent-core + web suites pass; mobile
unit tests pass and **Pixel 7 device verification is pending**. Part 3 (date-aware
project status / derived "waiting until a day") is the next slice.

Shipped (2026-09-12): **One list — Capture collapsed into Task** (plan series
`docs/plans/todo-single-list-overview.md`, part 1 `todo-single-list-1-merge.md`).
Task is now the single entity and the app's entry point; the Capture entity is
deleted (no `captures` table/route/store/collection/type, no Process, no Refine).
A quick-add with no project creates a **loose task**; Task absorbed the nullable
show-up date, the manual drag-reorder, and the Home/Upcoming visibility split.
Home is one reorderable `sortKey`-ordered list (swipe-right to postpone,
long-press/grip to reorder, complete with the single bottom Undo, tap to
rename/schedule); Upcoming lists every future-dated open task grouped by day.
Migration 0051 drops `captures` and preserves every `tasks` row with a nullable
`showUpDate` + backfilled `sortKey`; the dormant `sourceCaptureId` stays for a
future Refine. Shared helpers moved onto the task module (`homeTasks` gained the
shown-up gate + sortKey ordering; `upcomingSections`, `orderKeyBetween` /
`compareByOrder`, and the date helpers were ported from the deleted `captures/`).
Server + agent-core + web suites pass; mobile unit tests pass and **Pixel 7
device verification is pending**. Part 3 (date-aware project status / derived
"waiting until a day") is the next slice.

Shipped (on main, device-verified): the Capture list (Captures) on mobile
(`apps/agent-mobile`) and web (unlinked `/captures`) — add a Capture, Process it
out of Captures — backed by the `captures` table and `/api/captures` in the
per-user UserDO. Mobile UI on Uniwind (Tailwind 4) + `@expo/ui`; Clerk sign-in with a
native user button. The Captures data layer runs on TanStack DB (see
`docs/storage.md`). Captures carry a client-minted UUID id (stable end to end,
and the sole idempotency key for offline replay), so adding and processing a
Capture no longer flickers — the row never blinks out-and-back while the write
settles.

Captures loads local-first and reconciles the server in the background; the
shared `listView` helper in `@zero/agent-core` gates the list on the row count
so a hydrated snapshot shows at once. See `docs/storage.md` for the mechanics.

Shipped (2026-08-30): **Task**, the first typed entity, and the **Today** view
over it (plan: `docs/plans/todo-task-entity.md`). Built as a sibling of the
Capture stack, web first, then mobile: a `tasks` table + `/api/tasks` in the
per-user UserDO (add is exactly-once on the client-minted id; complete flips
`completedAt`; list returns open tasks); a shared `@zero/agent-core` Task type,
`createTasksApi` collection (local-first, offline outbox), and `dueToday` /
`localToday` helpers; and a **Captures | Today** segmented control on
both web (`/captures`) and mobile home. The active segment is the entry target: the
quick-add mints a Capture on Captures and a Task dated today on Today; the circle
completes. Timezone lives on the client (server returns all open tasks; the live
query filters `showUpDate <= localToday`, so overdue rolls in and future stays
hidden). Mobile device verification (Maestro, Pixel 7) still needs a standalone
EAS build for the durable-snapshot path.

Shipped (2026-09-02): **Upcoming** as section #2 on both surfaces (plan:
`docs/plans/todo-upcoming-tab.md`). A second tab (mobile) / nav entry (web) that
lists open, future-dated captures (`showUpDate > today`) grouped into day
sections (Tomorrow and beyond), the complement of the Captures list (which shows
what has already shown up). Grouping is one shared pure helper `upcomingSections`
in `@zero/agent-core`; each surface renders it in its own idiom (a mobile
`SectionList`, a web section list), with process + inline-edit rows, no calendar
strip and no drag-reorder. The mobile Capture data layer is now a shared
singleton so both tabs read one collection. Quick-add-to-a-day and a date strip
are deferred follow-ups.

Shipped (2026-09-02): **navigation chrome** on both surfaces — a native bottom
tab bar on mobile (`NativeTabs`) and a matching web nav (left sidebar on desktop,
bottom bar on phones). One section for now (**Captures**); a second lands next.
The chrome is built per surface (mobile tabs vs web sidebar), sharing only the
`@zero/agent-core` view helpers, since `apps/agent-web` is a separate app, not the
Expo web build. First on-device run of the native tab bar needs a fresh EAS dev
build. This reverses the earlier one-list-no-nav shape (Today tab removal) in
intent: nav returns, but sections grow one real screen at a time.

Shipped (2026-09-04): **Project**, entity #3 and the first container — slice A1
(plan: `docs/plans/todo-project-entity.md`, slice `todo-project-entity-a1.md`;
source of truth: `docs/entities/project.md`). Built as a third full sibling of
Capture/Task, web first then mobile: a `projects` table + `/api/projects` in the
per-user UserDO (`add` is exactly-once on the client-minted id; `list` is
oldest-first), a shared `@zero/agent-core` `Project` type, `createProjectsApi`
collection (local-first, offline outbox), and the shared `listView` count-gate;
a name-only create with outcome-naming helper text over a flat list on web
(`/projects`, a `SideNav` entry) and mobile (a `NativeTabs` Projects tab). First on-device run of the new native tab needs a fresh EAS dev build.

Shipped (slice A2, plan `todo-project-entity-a2.md`): the five-status model.
`DbProjectStore.setStatus` + `PATCH /api/projects/{id}` (list now scoped to the
non-`done` working set), a pure `projectsByStatus` grouping helper, and
`api.setStatus` in the collection (offline-replaying). On both surfaces the list
is grouped into collapsible Active / Next / Waiting / Backlog sections (counts,
hide-empty, Backlog collapsed when large), and a tap opens a detail bottom sheet
with a Status group; setting `done` removes the row with an inline ~5s Undo. The
detail sheet is a generic reusable primitive — web on `@radix-ui/react-dialog`,
mobile on the universal `@expo/ui` `BottomSheet` — shared with the Captures
detail sheet.

Shipped (slice A3, plan `todo-project-entity-a3.md`): enrichment in the detail
sheet. `DbProjectStore.edit` + a widened `PATCH /api/projects/{id}` carrying
title/icon/description alongside status, and `api.edit` in the collection
(offline-replaying; `setStatus` and `edit` share one update, disambiguated by the
changed field set). The sheet gained an emoji icon picker, an editable
title, and an editable notes field on both surfaces; field edits commit on
blur/submit (the icon on tap) and keep the sheet open, while a status pick still
dismisses it. The icon picker later grew from a curated 12-emoji row into a
searchable picker over every standard emoji (`frimousse` on web,
`rn-emoji-keyboard` on mobile); the stored `icon` is still a single emoji
string, and the neutral default is the shared `DEFAULT_ICON` (📁). The `icon`/`description` columns existed from A1, so A3 needed no
migration. This completes **slice A** (the hand-managed Project entity: no AI, no
Task membership). The mobile `@expo/ui` `TextInput` is native, so on-device
verification needs an EAS dev build. The Rule-of-Three extraction of the shared
plumbing (never the domain verbs) followed as its own change.

Shipped (post-A3): **delete a Project**, distinct from `done`. A destructive
Delete button in the detail sheet drops the row behind the same ~5s Undo as
`done`, then hard-removes it server-side (`DbProjectStore.delete` +
`DELETE /api/projects/{id}`, 204 and idempotent so an offline replay is safe).
Offline-safe on web and mobile. This added the shared collection factory's first
`delete` verb kind (`packages/agent-core/src/collection/base.ts`), so every
future entity gets optimistic delete + offline outbox for free.

Tightening (2026-09-04, internal, no user-facing change; plan
`docs/plans/todo-tightening.md`): the six list screens (Captures / Projects /
Upcoming × web + mobile) shared four copies of the same plumbing. The pure,
UI-agnostic pieces moved into `@zero/agent-core` (`messageOf`,
`LOADING_TEXT_DELAY_MS`, the Upcoming `dayLabel` helpers, and the Projects
display data in `projects/display.ts`: `STATUS_LABELS`, `ALL_STATUSES`,
`DEFAULT_ICON`, `BACKLOG_COLLAPSE_THRESHOLD`, `DONE_UNDO_MS`). The React hooks
(`useDelayed`, `useLoadError`, `useForegroundRefetch`, and the `useUndoableLeave`
hook that now backs both the Done and Delete undo timers) live in one
`screen-hooks` module **per app**, not in `@zero/agent-core`: a workspace lib
that calls React hooks resolves its own React copy (agent-core's would be 19.2.8
vs the mobile app's pinned 19.2.3) and trips the rules-of-hooks dispatcher, so
agent-core stays React-free. `apps/agent-web` also gained a Vitest +
`@testing-library/react` toolchain and a `ProjectsPage` suite, so the web surface
is no longer untested.

Shipped (2026-09-06): **Home** — the Today screen reworked (plan:
`docs/plans/todo-home-rework.md`). Renamed Today → Home on both surfaces (web nav
+ mobile tab; the `/captures` route is unchanged). The empty region is now one
Clarify → Engage pipeline: a plate with tasks shows the tasks (each project task
badged with its project's icon); an empty plate with captures shows the inbox
alone; an empty plate *and* inbox shows a state-driven call to action from the
projects' derived statuses — **Plan your day** (Next/Waiting exist, with a
`N Next · M Waiting` summary), **Bring a project forward** (only Backlog/Done), or
**Create your first project** (none) — each routing to Projects. The whole
gate-and-mapping is one shared pure seam `homeCallToAction` in `@zero/agent-core`
(with `homeCallToActionCopy` so web and mobile show identical words), unit-tested;
web and mobile screen tests cover the rename, the CTA cases, and the badge.

Shipped (2026-09-08): **create a Project from Home**. The Home quick-add gained a
third **Project** option beside Capture and Task on both surfaces; submitting in
that mode creates a name-only project, keeps the user on Home, and raises a toast
with a **View** link (the id comes off the optimistic insert transaction). On web
View opens the project's own detail; on mobile it opens the Projects tab (a direct
cross-tab deep link to the detail is blocked by a NativeTabs bug, expo/expo#45786,
that needs a native fix — revisit when it lands). The toast is our **own
primitive**, not a library: a headless controller in `@zero/agent-core` (queue,
timers, dedupe, observable snapshot) behind a tiny `toast()` + `<Toaster>`
interface, with a thin per-surface renderer (web DOM + CSS, mobile RN +
reanimated). We tried `sonner`/`sonner-native` first; sonner-native does not
render on our New-Arch + react-native-screens stack (sonner-native#316), and
react-native-toast-message has an open New-Arch regression (#583) — so no
maintained library fit. Plans: `docs/plans/todo-home-create-project.md` (feature),
`docs/plans/toast-primitive.md` (the primitive). Device-verified on the Pixel 7
(Maestro): the toast renders and View lands on Projects; no EAS rebuild was needed
(the mobile renderer adds no native module).

Shipped (2026-09-09): **immediate complete/done/delete with one bottom Undo
snackbar** (plan: `docs/plans/todo-delete-complete-redesign.md`). The old deferred
model — the acted-on row lingered struck-through with an inline Undo for ~5s
(`DONE_UNDO_MS`) before the write committed — is gone on both surfaces. It had two
faults the user hit: the ghost row lingering, and (because the timer was cleared on
unmount) switching tabs before the window elapsed silently dropped the write.
Everything now commits **immediately** and the row leaves at once. Home
task-complete raises a single global Undo snackbar (fixed toast id, so completing a
second task replaces the first toast — only ever one Undo) that **reopens** the
task on the server (`POST /api/tasks/{id}/reopen`, mirroring complete). Projects
`done` and `delete` commit immediately from the detail screen's ⋯ menu with **no**
toast — they are already three deliberate taps, so an Undo net is low value and the
faithful project-restore path was not worth its cost. The mobile toaster moved to
the **bottom** (above the tab bar), like Todoist. Removed: the deferred
`useUndoableLeave` hook (both apps), the `project-leave` detail→list handoff, the
`DONE_UNDO_MS` constant, and the Home "+ Waiting condition" inline shortcut (it only
existed inside the old completion window; waiting conditions stay on the project
screen).

Shipped (2026-09-09, follow-up): the same single bottom Undo snackbar now covers
**completing a capture** (the inbox "process" action) on Home and Upcoming, both
surfaces. Processing commits immediately (it always did); the new part is the Undo,
which **un-processes** the capture back to the inbox
(`POST /api/captures/{id}/unprocess`, mirroring process — a `unprocess` verb in the
Capture data layer that clears `processedAt`, routed before the catch-all text
edit). One shared `'undo'` toast id across task-complete and capture-complete means
only one Undo is ever on screen. The mobile toaster's bottom offset was also raised
so it clears the native tab bar instead of overlapping it.

Shipped (2026-09-09, follow-up): completing a task from a **project's own
screen/page** now raises the same single bottom Undo snackbar (reopens the task) —
previously the only complete/process action left with no Undo. In the same change
the repeated "commit immediately + raise the shared Undo snackbar" wiring (four
call sites: Home task-complete, Home/Upcoming capture-process, and now
project-detail task-complete) was extracted into one shared `undoableAction` helper
in `@zero/agent-core`, which owns the fixed `'undo'` toast id so "only one Undo on
screen" is an enforced invariant rather than a copy-pasted literal. Plan:
`docs/plans/todo-project-detail-undo-toast.md`.

Shipped (2026-09-09, fix — device-verified on the Pixel 7): the Undo snackbar
now actually **restores** the row on the persisted (device/web) path. On-device
testing revealed that tapping Undo threw `CollectionOperationError: key not found`
and did nothing: completing a task / processing a capture reconciles the row out
of the collection (the server list is open-only), and the Undo was an
`update`-by-id that cannot resurrect an evicted row. This had shipped broken in
the 2026-09-09 snackbar work because the in-memory unit tests keep the row and
never hit the eviction. Fix: `reopen`/`unprocess` are now a fourth collection verb
kind, **`revive`**, that carries the full row and **re-inserts** it when absent
(updates in place when Undo is tapped before the eviction lands), fixing Undo on
all surfaces at once (Home + Upcoming + project screen for tasks; Home + Upcoming
for captures). Verified on the Pixel 7 (reopen and unprocess both restore the row,
`reopenTask`/`unprocessCapture` fire, no `CollectionOperationError`). Plan and
design record: `docs/plans/todo-undo-restore-fix.md`, `docs/storage.md`.
This failure shows why unit tests alone can miss device-specific behavior.

Shipped (2026-09-16, device-verified on the Pixel 7): **mobile snackbars can be
swiped away horizontally and sit above the plus FAB** (plan:
`docs/plans/todo-toast-swipe-dismiss.md`). A short drag springs back; a committed
drag or flick slides off-screen and dismisses only that toast snapshot, so a
same-id replacement is safe. The root renderer reserves the 56dp FAB and its
bottom spacing while keeping tab and safe-area clearance. This is mobile-renderer
behavior only; the shared controller and web renderer are unchanged. The focused
renderer test and all 163 mobile tests passed. On the Pixel 7, completing the
user-prepared “Delete this task” row showed Undo above the unobscured plus button;
a continuous horizontal swipe removed the snackbar, and the task stayed
completed.

Shipped (2026-09-23, device-verified on the Pixel 7): **mobile snackbars clear on activity**.
A touch outside the snackbar, a route change, opening quick-add, submitting a task,
or leaving the app dismisses earlier feedback. Tapping the snackbar still runs its
actions. Action snackbars use the controller's four-second default instead of an
eight-second minimum; longer Android accessibility recommendations still apply.
Project-failure notices remain untimed until dismissal or activity. The existing
hermetic add-task flow covers opening +, tab navigation, and background/reopen
without adding a new flow. Plan: `docs/plans/mobile-toast-dismiss-on-activity.md`.

Shipped (2026-09-23): **mobile snackbars are compact, normally one row**. The
result and optional project icon/name share a line with Undo, Waiting, or View.
Project names still open their Project, and sticky errors show a short recovery
cue with Dismiss. Large text can wrap without hiding actions. Web stays unchanged.
Plan: `docs/plans/mobile-compact-snackbar.md`.

Shipped (2026-09-10): **how long a project has been waiting**, on both surfaces
(plan: `docs/plans/todo-project-waiting-time.md`). Each waiting project's row
shows a muted trailing badge with the elapsed time since its oldest unresolved
condition (a readable phrase like "3 days", via date-fns `formatDistanceStrict`),
and the Waiting section is ordered longest-waiting first. Two pure helpers in
`@zero/agent-core` — `waitingSince` (the blocked-since instant, reusing
`unresolvedConditions` so it never disagrees with the derived `waiting` status)
and `waitingLabel` (the phrase, with a sub-minute "just now" floor) — plus an
optional `sortKeyOf` on `projectsByStatus` (the list passes `waitingSince ??
createdAt`, so only the Waiting section reorders). No data-model change. Unit +
web/mobile screen tests; device-verified on the Pixel 7.

Shipped:

- **The "what shows up" availability model** (plan:
  `docs/plans/todo-availability-model.md`; merged via PR #69), built as 8 vertical
  slices, web + mobile. Today is one screen with tasks on top and the capture
  inbox below; a Task belongs to a Project (`projectId`, migration 0047) and is
  groomed in the project sheet; the Today top region is a computed view
  (`homeTasks`) gated by the project's derived display status and per-task
  curation (`takenOnAt`, migration 0048, a take-on/park star); a project's
  `active`/`next`/`waiting` status is **derived** (`projectDisplayStatus`) from its
  taken-on tasks and its **waiting conditions** — the new fourth entity
  (`waiting_conditions`, migration 0049; `docs/entities/waiting-condition.md`),
  free-text (human/AI-resolved) or task-done / project-status (code-resolved);
  completing a task lingers with Undo + a "+ Waiting condition" shortcut; and a
  capture is **Refined** into tasks/projects (`sourceCaptureId`, migration 0050),
  consumed on Done. The availability rule and derivation live in two pure, tested
  modules in `@zero/agent-core` (`homeTasks`, `projectDisplayStatus` +
  `conditionSatisfied`/`unresolvedConditions`). Shipped with unit/route/page tests;
  mobile on-device verification (EAS/Maestro) still pending. Refinement (2026-09-08):
  a taken-on open task now overrides an open waiting condition — starring a task
  on a waiting project brings it back to `active`, and completing that task
  returns it to `waiting` (not `next`), since the condition is still open. Also fixed a
  pre-existing durable-collection bug where a deleted row reappeared until refresh
  (see `docs/storage.md`).
- **Automatic appearance.** Mobile and web follow the system light or dark
  preference, including native/browser chrome. See `todo-dark-mode.md` for the
  implementation and device proof.
- **Add a waiting condition with the "+" affordance, not an inline form**
  (mobile + web; plan `docs/plans/todo-project-waiting-add-fab.md`). On the
  project screen, the waiting-condition add moved off an always-present inline
  composer. Mobile folds it into the project screen's single plus FAB as a
  second **Waiting** mode (beside Task) — free-text only; web opens the same
  three-kind builder in a popover from the "+ Waiting condition" control. Backed
  by a new project-scoped `waiting` add mode in the shared quick-add registry,
  kept out of the global set so Home and the Projects list never offer it. No
  data/API/store/derivation change. Unit + web/mobile screen tests cover the new
  affordance; device-verified on the Pixel 7 (the project + shows Task/Waiting
  pills, Waiting adds a free-text condition to the Waiting-on list — pure-JS, no
  EAS rebuild).
- **Mobile task add on a project is a plus FAB** (not an inline field): the
  project screen's task composer moved to the shared plus button / keyboard-docked
  quick-add bar, task-only (no capture mode, so captures aren't selectable there).
  Tasks-only rework of one screen; no data/API/collection change. Plan:
  `docs/plans/todo-project-task-add-fab.md`. Device-verified on the Pixel 7 (dev
  client + Maestro): FAB adds a parked task, bar docks above the tab bar, Back
  closes the bar before popping. Follow-up: the bar now shows the single
  interactive **Task** pill (the sole mode there), reading exactly like Home's.
  The add-mode concept — its ids, pill copy, and placeholders, previously smeared
  across a duplicate type, a labels map, and an `ADD_PLACEHOLDER` map on each Home
  (web + mobile) — is now one pure registry (`@zero/agent-core`
  `quick-add/modes.ts`) consumed by both surfaces; the quick-add bar renders
  whatever `modes` it is handed and derives the placeholder from the selected mode.
  Follow-up: the **Projects list** + first gained a single interactive
  **Project** selector. On 2026-09-17 it gained Task as a second selector while
  keeping Project selected by default. All three mobile create surfaces derive
  their labels from the same registry. Web has no selector concept on its plain
  Projects input, so it is unchanged.

- **AI icon suggestions for a Project** (web + mobile shipped) — the
  **first AI integration of the todo app**. Creating a project fires a background
  request that suggests emoji icons from its title; the picker shows them
  instantly from a device-local cache (or a brief loading line), tapping one
  applies it through the existing `edit` path, and Refresh recomputes after the
  title/description changes. Both surfaces put the suggested
  row directly above the full picker in one surface: web in the `frimousse`
  popover, mobile in a plain-RN bottom sheet hosting the inline
  `rn-emoji-keyboard` `EmojiKeyboard` (not the `@expo/ui` native sheet, which
  cannot host raw RN rows) with the chips on top and the searchable grid below. The server side is a stateless
  `POST /api/projects/icon-suggestions` that runs one tool-less model call
  (`suggestProjectIcons` over the `AgentModel` seam, agent label `icon_suggest` at
  `low` effort via the new `AGENT_EFFORT_OVERRIDES` map) and returns single-emoji
  strings, so no new server-side state and a soft miss just returns `[]`. The
  suggestions are an ephemeral client hint (no sync, no server row); the pure
  staleness check lives in `@zero/agent-core`, the cache and fetch per surface.
  Proves the todo app's first server LLM path end to end for heavier features
  (Capture → Project). Plan: `docs/plans/todo-project-icon-suggestions.md`.

Shipped (2026-09-05): **Project detail as a destination** (plan:
`docs/plans/todo-project-detail-rework.md`). Tapping a project now opens its own
screen — a `/projects/:id` route on web (`ProjectDetailPage`) and a pushed screen
within the Projects tab on mobile (`projects/[id].tsx`) — instead of a bottom
sheet. The screen leads with the work (tasks, then what it's waiting on) and keeps
identity compact (icon, editable title, derived-status pill, a `⋯` menu for status
moves/delete); the icon picker and status/delete actions stay as short `@expo/ui`
sheets. This dissolved the broken mobile task/waiting renderer (raw RN rows inside
an `@expo/ui` sheet host): a pushed Expo Router screen is an ordinary RN view tree,
so the rows render correctly. UI/navigation only — no data model, API, store, or
derivation change. Web has a `ProjectsPage` route test; the mobile project screen
was later device-exercised in the Undo-restore fix (2026-09-09).

Shipped (2026-09-24): **Status-grouped Project selectors** (plan:
`docs/plans/todo-project-selectors-status-sections.md`). Web and mobile Task
assignment and After-target selection now share the Projects list's calculated
ordering and folding policy, with search reaching folded matches. The full open
Task and Project attention snapshots drive each selector; no stored state changed.

In flight (details in `docs/plans/`):

- `todo-capture-animations.md` — quick-add morph + done fade-out. **Done fade-out
  shipped** (marking a todo done fades and collapses the row out); the **quick-add
  morph** (FAB expanding into the quick-add bar) is the remaining half.

Next:

- **AI Capture → Project** — swipe a Capture, propose a Project, confirm (the
  content-driven half of Refine; `docs/plans/todo-capture-to-project-ai.md`).
- **AI-resolve a waiting condition** — from email/calendar/content.
- later: agent `create_task` tool, recurring capture, recurring Tasks,
  structured waiting-condition kinds on mobile.

Dev infra: `pnpm --filter @zero/agent-mobile e2e:pixel` is the shipped default
behavioral proof on the USB-attached Pixel 7. It loads the current checkout from
Metro into the existing development client and runs Maestro against fake auth,
a fresh local Worker, and isolated device storage. The first flow adds a loose
Task and proves it through UI restart plus the Worker's HTTP interface. A later
increment will inventory Home, Upcoming, Projects, project detail, scheduling,
completion/Undo, offline replay, reordering, swipes, Waiting, After, recurrence,
and navigation, then choose a small behavior-oriented flow set. See
`apps/agent-mobile/README.md`.

A native fingerprint change still needs a fresh development-client build before
the Pixel run. Pure JavaScript loads through Metro. The dev box has no KVM, so
the optional emulator adapters remain in manual GitHub Actions workflows.
