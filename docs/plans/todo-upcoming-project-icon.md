# Plan: show the project icon on Upcoming task rows

## Goal

An Upcoming task that belongs to a project shows that project's icon glyph
before its title, exactly as a Home task row already does. A loose task (no
project) shows no glyph. The icon-resolution rule lives in one shared place so
Home and Upcoming cannot drift.

## Background (what exists today)

Two mobile screens list tasks (`apps/agent-mobile/src/app/(signed-in)/`):

- **Home** (`index.tsx`): its hand-built `TaskRow` renders
  `[CheckCircle] [icon?] [text] [star?]`. The icon is resolved by a local
  `iconOf` `useCallback`: `null` when `projectId == null`, otherwise the
  project's `icon` or `DEFAULT_ICON` when the project is missing. `TaskRow`
  renders `{icon != null ? <Text className="text-[16px]">{icon}</Text> : null}`.
- **Upcoming** (`upcoming.tsx`): its `UpcomingRow` uses the generic `ListRow`
  (`components/ui/list-row.tsx`) with a `CheckCircle` in the `leading` slot and
  a bare `<Text>{item.text}</Text>` as the body. It already loads the projects
  collection (`projectsApi`, `projects`) for the detail editor, but never uses
  it to show an icon.

So the icon-resolution rule exists once, privately, inside Home. Upcoming has
the data but not the rendering.

`DEFAULT_ICON` (`📁`) and the other project display constants live in
`packages/agent-core/src/projects/display.ts`, whose header already states its
job: "Project display data shared by the web and mobile ... Pure data, no UI."
That is the natural home for a shared task-icon resolver.

## What to change and why

1. **Add a shared resolver in agent-core** — `packages/agent-core/src/projects/display.ts`:

   ```ts
   // The icon glyph shown for a task in a list: null for a loose task (no
   // project, no badge), otherwise the task's project icon, falling back to
   // DEFAULT_ICON when the project row is absent (deleted or not yet loaded).
   // The single rule the Home and Upcoming task rows share, so the two surfaces
   // cannot drift. Pure and in-process.
   export function taskIcon(task: Task, projects: Project[]): string | null {
     if (task.projectId == null) return null;
     return projects.find((p) => p.id === task.projectId)?.icon ?? DEFAULT_ICON;
   }
   ```

   Import `Task` from `../tasks/types` and `Project` from `./types`. Export
   `taskIcon` from `packages/agent-core/src/index.ts` alongside `DEFAULT_ICON`.

   This is the shared module the task calls for. It is deep enough to earn its
   keep by the deletion test: delete it and the loose-vs-project + missing-project
   fallback rule reappears in both `index.tsx` and `upcoming.tsx`. The glyph
   render itself (`<Text className="text-[16px]">{icon}</Text>`) is a one-liner
   and is **not** extracted into a component — deleting such a component would
   concentrate no complexity, and the two rows are structurally different (Home
   is a hand-built swipe row, Upcoming is the generic `ListRow`), so a shared row
   component is not on the table.

2. **Home uses the shared resolver** — `index.tsx`: replace the body of the
   `iconOf` `useCallback` with `taskIcon(item, projects ?? [])`, dropping the
   local `DEFAULT_ICON` fallback logic (still importing `DEFAULT_ICON` for the
   complete-toast description, which is unrelated). Keep the `useCallback`
   wrapper and its `renderItem` wiring unchanged. No behavior change on Home.

3. **Upcoming renders the icon** — `upcoming.tsx`:
   - Give `UpcomingRow` an `icon: string | null` prop.
   - Render the glyph between the `CheckCircle` (leading) and the title. Put it
     inside the body so the `ListRow` divider inset (`ml-[50px]`) stays correct:
     wrap the body in a row, e.g.
     ```tsx
     <View className="flex-row items-center gap-3">
       {icon != null ? <Text className="text-[16px]">{icon}</Text> : null}
       <Text className="flex-1">{item.text}</Text>
     </View>
     ```
     matching Home's `text-[16px]` glyph size.
   - In `renderItem`, compute the icon with `taskIcon(item, projects ?? [])`.
     `projects` is already in scope in `Upcoming`. Add `taskIcon` to the
     existing `@zero/agent-core` import.

## Out of scope

- The web Upcoming/Home surfaces. This plan is the mobile app only; if the web
  surface resolves task icons with its own copy of the rule, unifying it onto
  `taskIcon` is a separate follow-up.
- Any change to the Projects detail screen task rows (`projects/[id].tsx`),
  which intentionally show a take-on/park star rather than a project icon.
- Sizing, layout, or divider changes beyond placing the glyph.

## Tests to add or update

- **agent-core unit test** for `taskIcon` (new file
  `packages/agent-core/src/projects/display.test.ts`, or extend an existing
  display test if present): loose task → `null`; project task with an icon →
  that icon; project task whose project is not in the list → `DEFAULT_ICON`.
- **Upcoming screen test** (`app/(signed-in)/__tests__/upcoming.test.tsx`): add a
  test that a future-dated project task shows its icon glyph. Mirror the Home
  test `badges a project task with its project icon` (index.test.tsx line ~180):
  add `fetchProjects`/`resetProjectsApiForTest` to the mock (the current
  Upcoming test file mocks only the tasks API), return one project with a known
  icon, give the task a matching `projectId` and a `2099-…` `showUpDate`, and
  assert `getByText('🎓')`. Also assert a loose future-dated task shows no glyph.
- Home's existing `badges a project task with its project icon` test must keep
  passing unchanged (proves the `iconOf` refactor is behavior-preserving).

## Docs to add or update

- `apps/agent-mobile/CHANGELOG.md`: one user-facing entry, e.g.
  `- YYYY-MM-DD: Upcoming tasks now show their project's icon, like Home.`
  (Mobile app changes go in the mobile changelog, not the agent changelog.)

## Skills to use

- `tdd` — write the `taskIcon` unit test and the Upcoming icon test first, then
  make them pass.
- `git-commit` — when committing (code + changelog together).

## Acceptance criteria

- A project task in Upcoming shows its project's icon glyph before the title; a
  loose task shows none.
- The icon-resolution rule exists in exactly one place (`taskIcon` in
  agent-core); Home and Upcoming both call it, and Home's own tests still pass.
- New `taskIcon` unit test and Upcoming icon test pass;
  `pnpm --filter @zero/agent-core test`, and the mobile jest/lint/typecheck
  checks pass.
- The change is verified on the real Pixel 7 (open Upcoming with a future-dated
  project task and confirm the icon renders), per the mobile testing rule —
  using a throwaway project/task, deleted when done.
- A dated `apps/agent-mobile/CHANGELOG.md` entry ships with the code.
```
