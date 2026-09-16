# Project Waiting, After, and workspace design

## Bottom line

Keep Waiting and After at Project scope, but make them different concepts with
different presentation:

- **Waiting on** is one or more text conditions that require human review and
  manual resolution.
- **After** is one or more Project-completion relationships that require no
  review and resolve automatically.
- **Tasks own every date.** A Project has no date condition, exact-time trigger,
  Calendar-event trigger, or Task dependency.

Rework the Project screen as a Project workspace. Identity, description, current
status, Waiting conditions, After relationships, and Tasks are sibling regions.
Waiting and After must not be rendered as a footer of the Task list.

## Why the distinction exists

Backlog, Waiting, and After answer different attention questions:

| State | Meaning | How it returns |
|---|---|---|
| Backlog | The user deliberately parked the Project | The user moves it into play |
| Waiting | The Project still needs periodic review or follow-up | The user resolves its text conditions |
| After | Nothing needs attention until another Project completes | The system resolves the relationship |

After is not necessarily causal blocking. Both examples use the same attention
mechanism:

- **Buy a dog** after **Buy a house**: intentional sequencing.
- **Get German citizenship** after **Learn German**: a genuine prerequisite.

The product models desired attention, not why the relationship exists.

## Relationships

### Manual Waiting condition

```text
Project ──waiting on──▶ text condition
```

Examples:

- Breeder replies.
- Tax office sends the assessment.
- Landlord confirms the date.

A Project can have several conditions. Every condition is visible and resolved
independently. The Project remains Waiting while any unresolved condition still
controls its display status.

### After relationship

```text
Project A ──after──▶ Project B is Done
```

A Project can have several After relationships. They use AND semantics: every
referenced Project must become Done before the source Project has no remaining
After relationship.

Project-to-Task relationships are removed, including existing rows. New After
relationships can reference Projects only.

### Dates

Dates belong to Tasks:

```text
Task ──scheduled for──▶ local calendar date
```

A Project that should return on a date gets a concrete review/action Task on
that date. There is no separate Project-level date system.

## Project status

Persisted Project lifecycle remains In-play, Backlog, or Done. Backlog and Done
are explicit user decisions and always outrank calculated attention.

For an In-play Project, calculate the visible status in this order:

1. **Active** — at least one open Task has a date that has arrived.
2. **Waiting** — at least one manual condition is unresolved, or at least one
   open Task is scheduled for a future date.
3. **After** — at least one Project-completion relationship is unresolved.
4. **Next** — none of the above applies.

An empty In-play Project is Next.

### Dated work overrides After

An After relationship is a fallback attention state, not a hard gate.
Scheduling a Task deliberately brings the Project forward without resolving its
After relationship.

Example:

```text
Buy a dog
After: Buy a house is Done
```

- no dated work → After;
- Task scheduled today → Active;
- Task scheduled Friday → Waiting until Friday;
- dated work completes, relationship unresolved → After again;
- Buy a house becomes Done → relationship resolves; normal derivation yields
  Active, Waiting, or Next.

Existing schedules and recurring Tasks behave the same as newly scheduled work.
Do not record when a date was assigned and do not suppress schedules that predate
an After relationship.

### Waiting overrides After

If a Project has both manual Waiting conditions and After relationships, with no
arrived dated Task, it appears in Waiting. A manual condition is a current review
obligation and must not be hidden by automatic sequencing.

### Backlog remains manual

Adding or removing an After relationship never moves a Project out of Backlog.
A Backlog Project stays in Backlog when its referenced Project completes. The
relationship can resolve, but the stronger manual lifecycle choice remains.

## Relationship lifecycle

- Completing a referenced Project resolves its incoming After relationships.
- Undoing that completion restores the relationships resolved by that action.
- Deleting a referenced Project removes incoming relationships and discloses
  which Projects will recalculate.
- Self relationships, duplicates, and direct or transitive cycles are invalid.
- Removing one of several After relationships leaves the others active.
- There are no notifications in this increment. Resolution only returns the
  Project to its correctly calculated section.

## Projects list

Section order:

```text
Active
Next
Waiting
After
Backlog
```

- After is collapsed by default.
- After is absent when empty.
- Waiting remains expanded because it requires review.
- A Project row shows only its dominant current status and context.
- An unresolved After relationship overridden by Active or Waiting is not shown
  in the Projects-list row. It remains visible inside the Project.
- A Project released from After returns to its normal position in the resulting
  section; no notification or separate Ready state is added.

## Project workspace

### Structural model

The Project screen is not a Task list with metadata in its header and Waiting in
its footer. It is one Project workspace with sibling regions:

1. Project identity;
2. Project description;
3. dominant status;
4. manual Waiting conditions, when present;
5. After relationships, when present;
6. a full section break;
7. Tasks.

One scrolling host may render the screen, but that implementation must not leak
into the visual hierarchy. Waiting and After do not inherit Task spacing,
dividers, gestures, reorder behavior, or footer treatment.

### Confirmed composition

```text
‹ Projects                                  ⋯

🐕 Buy a dog
Find the right dog after settling into the house.

[Waiting · for 5 days ▾]


WAITING ON                              ＋

Breeder confirms availability       Resolve
Tax office sends the assessment     Resolve


AFTER                                   ＋

🏠 Buy a house                           ›


TASKS                                   ＋

○ Visit the shelter                 Today
○ Compare pet insurance
○ Find a veterinarian
```

The whitespace between Waiting/After and Tasks is a complete section interval,
not the ordinary gap between rows. The first relationship never touches the
status pill, and the final relationship never reads as another Task.

### Empty relationships

When Waiting or After is empty:

- omit its heading;
- omit its rows;
- omit its local add control;
- show no input, prompt, helper paragraph, or empty-state card.

A clean Project screen contains no Waiting chrome.

## Waiting section

All manual conditions remain visible. Do not fold them into a summary.

Typical count is one; the expected maximum is approximately 23. The screen can
become longer at that uncommon maximum. Do not introduce nested scrolling or a
second manager screen merely to optimize that case.

Each row contains:

- the complete text, wrapping when necessary;
- a full-size **Resolve** action;
- row management for removal where needed.

The section heading has a local `+` for adding another condition. The input is
never permanently mounted on the Project screen.

Adding opens a focused composer:

```text
Add waiting condition

[ What are you waiting for?               ]

Cancel                                Add
```

There is no kind selector, Project picker, Task picker, date field, `auto` label,
or generic condition builder.

## After section

After is presented separately because its rows are navigable Project identities,
not prose obligations.

Each row contains:

- referenced Project icon and title;
- disclosure affordance;
- navigation to the referenced Project;
- relationship removal through row management.

The section heading has a local `+` for adding another Project relationship.
The selection flow uses a searchable Project picker that excludes the current
Project, Done Projects, duplicates, and cycle-producing candidates.

## Add interaction

The main Project `+` means **Add to Project**. It no longer opens one editor with
Task, Waiting, and Project tabs.

It opens a short action surface:

```text
Add to Buy a dog

Task
Waiting condition
After project
Project
```

Each action opens one purpose-built flow:

- Task → Task editor;
- Waiting condition → focused text composer;
- After project → Project picker;
- Project → independent Project creation.

This preserves direct access to Waiting from the Project without keeping an
input or empty section visible. Once a relationship section exists, its local
`+` is the faster repeat-add path.

The status pill returns to status and lifecycle management. It must not become a
second generic relationship builder.

## Completion fast path

Completing a Task persists immediately. Do not restore the earlier delayed
row-linger behavior.

For a Project Task, the transient completion feedback offers:

```text
Completed
🏠 Move house

Undo                   Waiting for…
```

- Undo retains current behavior.
- Waiting for opens the focused Waiting composer scoped to the Task's Project.
- The Project identity remains a quiet navigation target.
- Loose Tasks omit the Project and Waiting actions.
- If the transient feedback disappears, the Project add surface remains the
  durable path.

Inline post-completion actions are out of scope. If the transient surface proves
too crowded on the Pixel, redesign immediate-write inline feedback separately;
never delay completion until a row disappears.

## Web adaptation

Web uses the same hierarchy and copy:

- Waiting and After precede Tasks as sibling Project regions;
- all Waiting conditions are visible;
- empty regions are absent;
- a Project-level Add control opens the same four choices in a web-native menu or
  popover;
- focused dialog/popover flows replace mobile sheets;
- the Projects list uses the same section order and After collapse behavior.

Do not share renderers across mobile and web. Share the model and presentation
data; each surface uses its native interaction idiom.

## Accessibility and content behavior

- Every target is at least 48 dp on Android.
- Resolve and relationship removal have distinct semantic labels.
- Status, Waiting, and After are not communicated by color alone.
- Long condition text and Project titles wrap or truncate without colliding with
  actions.
- Large font scales keep action labels reachable and preserve section order.
- Android Back closes the focused composer or picker before leaving the Project.
- Dark mode retains the incumbent semantic token system.

## Deliberate exclusions

- Task-scoped Waiting.
- Project-to-Task dependencies.
- Project-level date or exact-time conditions.
- Google Calendar event conditions.
- Notifications when After resolves.
- A persistent Waiting input.
- A folded Waiting summary or separate Waiting manager screen.
- A generic condition-kind selector.
- Waiting as a tab in the Task editor.
- Waiting or After as a Task-list footer.
- Deferred completion owned by a lingering row.

## Acceptance criteria for the design

- A Project with no relationships shows no Waiting or After chrome.
- A user can add the first Waiting condition or After relationship from the main
  Project Add surface.
- A user can add subsequent relationships from the matching section heading.
- Every manual condition is visible and independently resolvable.
- After relationships are visibly and conceptually separate from text waits.
- Waiting and After sit near Project status and before Tasks.
- Tasks retain a distinct section with a complete spacing break above it.
- Dated work can override After without resolving it.
- Manual Waiting outranks After when no arrived dated Task exists.
- Backlog and Done remain manual lifecycle decisions.
- Completion persists immediately; its transient Waiting action never owns the
  write.
- Mobile and web express the same model in their own idioms.
