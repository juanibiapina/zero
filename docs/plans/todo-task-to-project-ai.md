# Task → Project via AI (brainstorm)

Status: brainstorm, nothing built. Captures the design direction for refining a
loose Task into a Project with the agent. Not a committed plan yet — the open
questions at the bottom gate that.

## The idea

A loose Task can hold a raw thought (e.g. "Project: yearly retreat, 4 days, no
talking, no phones"). Today the user reviews it by hand and can file it under a
Project. In the app, an AI assistant should be able to refine that thought:

- **Swipe left** on a loose Task = generic "Refine with AI". Starts a session
  with the agent telling it to refine this Task.
- The agent **proposes** what to do: convert to a Project with some requirements.
- The user **confirms, or asks for changes** (a back-and-forth).
- On "OK", the agent **executes** and creates the entities.

## Bottom line

This one feature is the convergence point of the todo-app roadmap. It pulls in
four unbuilt things at once:

- the **Project** entity (#3),
- **un-parking Task** (a project's "requirements" = Tasks with `projectId`),
- the agent's **first write path** into todo-app entities,
- a **propose / confirm session UI**.

It is the reason Task exists again — `docs/todo-app.md` parks Task until "Projects
and the agent give it a reason to exist"; this is that reason. Build it in slices;
each slice ships on its own.

Biggest scope lever: **does v1 need the back-and-forth chat, or is one-shot
propose→confirm enough to start?** Lean toward starting without the chat.

## Recommended slicing

**Slice A — Project entity (#3), no AI.** Historical prerequisite:
`projects` table, `DbProjectStore`, `/api/projects`, a collection, a Projects
screen with a real creation UI. Minimal schema: `id`, `title`, `icon`,
`description`, `status` (active/next/waiting/backlog/done), `createdAt`. Ships
value alone (projects created by hand) and de-risks the rest. Delivered as three
**vertical sub-slices, each web + mobile** — A1 create & list, A2 status
(grouping + change, via a tap-to-open detail sheet), A3 enrich (icon/title/
description in the sheet) — then the Rule-of-Three base extraction as a non-vertical
follow-up. All four shipped (extraction: #66). The shipped Project model is
documented in `docs/entities/project.md`.

**Slice B — place Task under Project.** Historical prerequisite: `projectId`
lets the existing Task move between loose and Project-owned states. A Project
shows its Tasks. No Capture provenance is part of the current domain.

**Slice C — one-shot AI proposal.** Swipe-left = "Refine with AI" → one agent
call reads the Task text → returns a **structured draft** (`{title, icon,
tasks: [...]}`) → app renders it as a native confirm sheet → **Confirm** creates
the Project + Tasks and completes or removes the original Task as one explicit
user-confirmed action. No provenance field is required. No chat yet. Proves the
whole pipeline with the smallest agent surface.

**Slice D — conversational session.** Add the **Session** entity + a chat screen
so "ask for changes" works: the proposal becomes a message, the user replies, the
agent revises the draft, a final "OK" commits. This is where Session lands as a
first-class entity.

## Two design forks to decide before building

**1. Who writes the entities — agent or app?**
Preference: the agent stays **read-only during the proposal** and emits a
structured draft; the **app commits on Confirm**. The human tap is the
transaction boundary — no accidental writes, deterministic preview, and slice C
needs zero agent write-tools. The alternative (agent holds `create_project` /
`create_task` tools that fire into a staging area) is more Minecraft-pure but much
heavier and lets a bad turn write junk. Do the draft-object version first; add
real tools only if the chat loop later needs them.

**2. Reuse the interface agent runner or a new one?**
`agents/run.ts` is tuned for Telegram conversation plus the topic/writer knowledge
model. A Task-refinement runner wants structured output and none of that.
Preference: a **new small runner** (or a distinct entry that skips topics/writer)
so the agent's conversational baggage stays out of a structured task.

## Smaller decisions

- **swipe-left vs circle-tap:** clean split — circle-tap = "I handled it"
  (complete); swipe-left = "AI, refine this." Swipe-left is currently
  free (right = postpone).
- **"generic process with AI":** the gesture is generic, but v1 lets the agent
  pick the target type while only **Project** is supported. Other target types
  (Note, Task-only) come later without changing the gesture.
- **web-first vs mobile-first:** the gesture is mobile, but the AI proposal +
  confirm sheet iterate far faster on **web** (Home remains at `/captures`; no EAS rebuild
  per native change). Consider building slice C's proposal web-first, then port
  the sheet to mobile.

## Open questions (gate the plan)

1. Is one-shot propose→confirm (slice C) an acceptable v1, or is the chat loop
   (slice D) needed from the start?
2. Minimal Project schema — is `title / icon / status / tasks` enough, or should
   requirements be free text separate from Tasks?
3. New runner vs reuse the interface agent — which?
4. Build the AI proposal web-first or mobile-first?
