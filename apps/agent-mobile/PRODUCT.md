# Product

<!-- impeccable:product-schema 1 -->

## Platform

android

## Users

People replacing a conventional todo list with one place for loose Tasks,
project work, schedules, and the surrounding workflows. The product is currently
dogfooded on a Pixel 7, with the mobile app as the primary daily surface and the
web app as a companion surface.

## Product Purpose

Zero is the daily entry point for deciding what deserves attention now. Tasks
capture individual actions; Projects hold outcomes and calculate their visible
status from lifecycle state, dated work, and unresolved conditions. Success means
the user can trust Home to show current work and Projects to preserve everything
that does not need attention yet.

## Positioning

The app distinguishes manual lifecycle decisions from calculated attention:
Backlog and Done are explicit Project state, while Active, Next, Waiting, and
After follow from work and relationships. Every entity is introduced as a
deliberate “Minecraft block” whose interactions with every existing entity and
surface are considered rather than inherited from a generic data model.

## Operating Context

- Home is the flat list of available Tasks.
- Browse is the rightmost tab; its Upcoming destination holds future-dated Tasks.
- Projects remains a direct tab grouped by calculated Project status.
- A Project screen is the durable place to groom Tasks and manage why the
  Project is Waiting or After something.
- A Project screen is a Project workspace: identity, dominant status,
  description, all manual Waiting conditions, After relationships, and Tasks are
  sibling regions in that order. Waiting and After are not Task-list footers.
- The app is local-first and writes optimistically through durable offline
  collections.
- Completion persists immediately and offers Undo through transient feedback.
- Mobile changes are verified on the physical Pixel 7.

## Capabilities and Constraints

- A loose Task can appear on Home without a date. A Project Task reaches Home
  when its date has arrived.
- An arrived dated Task makes an In-play Project Active. A future dated Task
  makes it Waiting until that date.
- A manual Waiting condition means the Project still needs periodic human
  review or follow-up.
- After means an In-play Project needs no attention until another Project
  completes.
- Dated work overrides After without resolving its relationship. When dated work
  is gone, the unresolved relationship can return the Project to After.
- Manual Waiting takes precedence over After when no dated work is active.
- Backlog and Done remain stronger manual lifecycle decisions. After never moves
  a Project out of Backlog automatically.
- Several After relationships use AND semantics.
- Project-to-Task dependencies, Project-level date conditions, exact times, and
  Google Calendar event triggers are out of scope for the first After model.
  Dates belong to Tasks.
- The After section is hidden when empty and collapsed by default when present.
- Projects show only their dominant current status in the Projects list;
  overridden After relationships remain visible inside the Project.
- There are no product notifications for After resolution yet. Resolution only
  returns the Project to its correctly calculated section.

## Brand Commitments

The product is Zero. Its incumbent mobile identity is quiet, compact, and
native-feeling, with a blue accent, white/graphite surfaces, restrained status
copy, and direct controls. Preserve the established visual system and Android
interaction expectations rather than introducing a separate visual language for
Waiting and After.

## Evidence on Hand

- Product vision and tracking: `docs/todo-app.md`
- Entity behavior: `docs/entities/task.md`, `docs/entities/project.md`, and
  `docs/entities/waiting-condition.md`
- Current Project surface:
  `src/app/(todo)/projects/[id].tsx`
- Current shared Task editor: `src/components/task-editor-sheet.tsx`
- Current transient feedback: `src/components/toaster.tsx`
- Current tokens: `global.css`
- Historical plans under `docs/plans/`, including Waiting affordance, Project
  status, Task completion, and Project dependency work.

## Product Principles

1. Manual lifecycle decisions outrank calculated attention state.
2. Home shows chosen current work; relationships can remain unresolved without
   preventing deliberate scheduled work.
3. The system must distinguish conditions the user reviews from triggers the
   system can observe.
4. Completion writes immediately; transient UI never owns or delays the action.
5. Prefer one clear interaction in the user’s real workflow over a generic
   builder that exposes the storage model.

## Accessibility & Inclusion

All actions must have semantic labels, survive large Android font scales, meet
48 dp touch targets, support dark mode, and remain operable through Android Back
and screen-reader navigation. Status cannot be communicated by color alone.
