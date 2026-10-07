# Entities are blocks

This folder describes how we think about the things in the todo app. Each
entity is a block, in the sense of a block in Minecraft. A new block is not a
new table. It is a new piece of the game, and adding it means deciding how it
behaves when it meets every other piece.

Game design thinking, not foreign keys. Water next to lava makes obsidian.
Redstone next to a piston pushes it. Those rules make the game, and nobody
derives them from a schema. In the same way, a Task with a date that arrives
makes its Project Active, and completing a Project releases the Projects that
wait for it. Each rule is a decision someone made on purpose.

So we prefer specific blocks with specific behavior over generic ones. A typed
Preference that flags a movie without original audio beats a generic Note that
holds the same sentence and does nothing with it.

## What every block decides

Each block has a card in this folder. A card answers these questions, in this
order:

1. What it is: one paragraph in the user's terms, with an example.
2. Why it is its own block: the behavior that only it has.
3. Rules: the few invariants that define it.
4. How it looks: its visual identity and where it appears.
5. Interactions: what happens when it meets each other block, each place, each
   workflow, and an agent. A missing interaction is named and is deliberate.
6. Left out on purpose: ideas we rejected for this block.
7. Ideas: open product ideas for this block.

Cards describe the product. How a block is stored, synchronized, and served
lives in the code and in [`storage.md`](../storage.md) and [`mcp.md`](../mcp.md).

## Blocks today

- [Task](task.md): one line of work.
- [Project](project.md): an outcome that groups work and shows how much
  attention it needs.
- [Waiting condition](waiting-condition.md): something a Project waits for that
  a person must check.
- [After](project-after.md): a Project that needs no attention until another
  Project is Done.
- [Medicine](medicine.md): a daily routine of doses, with its Doses.

## Interactions

Read a row as "this block, when it meets that one".

| | Task | Project | Waiting | After | Medicine |
|---|---|---|---|---|---|
| **Task** | Shares one manual order | Belongs to at most one. An arrived date makes it Active, a future date makes it Waiting until that day, no date keeps the Task off Home | Completing a Project Task offers to add what the Project now waits for | None. After never hides dated work | None |
| **Project** | Deleting it deletes its Tasks | After another Project, through After | Owns any number. One open condition makes it Waiting | Completing it releases the Projects that wait for it. Undo restores them | None |
| **Waiting** | None | Belongs to one Project and goes when it goes | Each resolves on its own | Outranks After | None |
| **After** | None | Points from one Project to another. No cycles | Ranks below Waiting | Several on one Project must all resolve | None |
| **Medicine** | None | None | None | None | Each Medicine has its own Doses |

Medicine stands apart on purpose. It never appears on Home and never changes
how much attention a Project needs.

Places and agents:

| | Home | Upcoming | Projects | Medicines | Agents |
|---|---|---|---|---|---|
| **Task** | Loose Tasks without a date or with an arrived date, and Project Tasks with an arrived date | Tasks with a future date | Inside its Project | | List, add, edit, complete, reopen, set repeats |
| **Project** | Next and Waiting Projects, when Home has no Tasks | | Grouped by attention, each with its own workspace | | List, add, edit, change state, delete |
| **Waiting** | | | In its Project | | List, add, resolve, delete |
| **After** | | | In its Project, and as its own Projects section | | List, add, delete |
| **Medicine** | | | | Its own list and detail | List only |

## Removed blocks

Capture was the first block: a raw thought dropped into an inbox and processed
later into a typed Task. The split proved premature, because the user worked in
one list. Task absorbed Capture's role as the entry point, together with its
optional date and manual order. The reasoning is in
[`todo-single-list-overview.md`](../plans/todo-single-list-overview.md).

## Candidate blocks

These are ideas, not plans:

- Person: first class, with a round avatar. Connects to Tasks and Projects, so
  you can see how many people a piece of work touches. Seeded from Google
  Contacts, with family shown clearly and where you first met someone.
- Vault and typed notes: notes shared across Projects. We would rather have many
  typed notes with behavior than one generic Note.
- Preference: a written taste, such as "I strongly prefer original audio
  movies", that the system checks in context and flags when something breaks
  it.
- Workflow: such as "process email" or "watch a movie in the cinema". Each
  block it touches adds its own influence. A template can create Projects.
- Email: attaches to something, likely a Project. Shown with its attached
  blocks and suggested updates that you accept, reject, or discuss.
- Session: an AI session with tools for every block, which shows every block it
  read or saved.
- Domain blocks such as Movie ticket, Trip, Invoice, Bill, Delivery,
  Newsletter, Album, and Wallet.

Problems that motivate these blocks:

- Zero booked a movie in the calendar but ignored that the confirmation named
  two tickets, so another Person was coming.
- Zero's email workflow did not follow a safe ticket link to learn more.
- Movie tickets belong in Google Wallet without asking.
- A movie Project could ask for a review and a photo with the poster after the
  show, and ask who came.

Parked ideas: a timeline that feels like a game, and Project slots that start
at one to teach the game.

## Open questions

- Can the code refuse to build when a new block does not wire its required
  interactions?
- Do we list the interactions a block allows, or the ones it forbids?
- Are Waiting and After blocks, or connectors between Projects?
