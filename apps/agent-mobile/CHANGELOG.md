# Changelog

User-facing changes to the mobile todo app, most recent first.

- 2026-09-09: Completing a task, marking a project done, and deleting a project now happen right away, instead of leaving the row crossed out for a few seconds first. Switching tabs no longer cancels the action. Completing a task shows an Undo bar at the bottom (like the rest of the app) that brings the task back; a second completion replaces the bar, so there's only ever one. Marking a project done or deleting it — both already tucked in the project's "⋯" menu — just happen, with no Undo. The old "+ Waiting" shortcut that appeared while a task was finishing is gone; add waiting conditions on the project's screen.
- 2026-09-08: A new project suggests emoji icons for itself. Create a project and, when you tap its icon, a row of suggested icons based on its name sits right on top of the full emoji picker — tap a suggestion or search for any emoji, all in one sheet. Refresh recomputes them (handy after you add a description).
- 2026-09-08: Create a project straight from Home. The quick-add now has a Project option alongside Capture and Task; adding one keeps you on Home and shows a toast with a View link that jumps to your Projects, where the new one is on top.
- 2026-09-08: On an empty Home, the next-step button now appears (it was failing to render, leaving the suggested action unreachable).
- 2026-09-08: Starring a task on a waiting project brings the project back to active, even while it is still waiting on something; finishing that task returns the project to waiting.
- 2026-09-08: Searching in the project icon emoji picker now keeps the search box and matching emoji visible above the keyboard.

- 2026-09-08: Pick any emoji as a project's icon. Tapping the icon now opens a full emoji picker with search, instead of a small fixed set.

- 2026-09-06: The Today tab is now Home. When your plate and inbox are both empty, it shows a next step based on your projects — plan your day, bring a project forward from the backlog, or create your first project. Tasks you're working on now show their project's icon.

- 2026-09-06: Add a task to a project with the round + button on the project's screen. It opens an add box that sits flush above the keyboard, the same way you add anywhere else in the app; the old add field at the bottom of the task list is gone.
- 2026-09-06: Pull down on any list — Today, Upcoming, Projects, or a project's screen — to refresh it.
- 2026-09-05: Tapping a project now opens its own screen (with a Back button and the tab bar still there) instead of a pop-up sheet — and its tasks and waiting conditions now show up correctly, which they didn't before. The screen leads with the project's tasks and what it's waiting on; its title is editable at the top, the icon is tucked behind a tap, and status changes and delete live in a "⋯" menu.
- 2026-09-05: Deleting a project now removes it from the list right away, instead of quietly coming back until the next refresh.
- 2026-09-05: Refine a capture into real work. Open a capture and tap "Refine into tasks & projects" — a banner pins it while you add tasks on Today and projects on the Projects tab, all linked back to that capture. Tap Done to clear it from your inbox.
- 2026-09-05: Finishing a task on Today leaves it in place for a few seconds with Undo — and, for a task in a project, a "+ Waiting" shortcut so you can record what the project is now waiting on the moment you finish the task that triggered it.
- 2026-09-05: Say what a project is waiting on. Add a waiting condition in its detail sheet and the project shows as Waiting with its tasks hidden from Today; resolve it to bring them back. A task/project condition clears itself when that task is done or that project reaches its status.
- 2026-09-05: Projects now sort themselves: a project shows as Active while one of its tasks is taken on, and drops to Next once you've cleared them — a nudge to groom and take on more. Backlog and Done stay yours to set (the detail sheet now offers Put in play / Move to backlog / Mark done).
- 2026-09-05: Choose which of a project's tasks you're taking on: star a task in the project to put it on Today, and star it again on Today to park it. No fixed limit — you decide how much shows up. Loose tasks always show.
- 2026-09-05: Your Today list shows tasks from active projects (plus loose tasks); a project's tasks stay hidden until you make it active, so only what you're working on surfaces.
- 2026-09-05: Add tasks to a project and complete them from the project's detail sheet, so a project holds the work toward its outcome.
- 2026-09-05: The Captures tab is now Today, showing your tasks for today on top and your capture inbox below. The add box creates a capture by default; switch it to Task to add a task instead.
- 2026-09-05: The app now follows your phone's light or dark appearance automatically.
- 2026-09-05: Fresh look across the app: a cleaner, denser task list with lighter dividers instead of boxed cards, a round add button, an add box that sits flush above the keyboard, and the tab bar in the app's colors.
- 2026-09-04: Tap a capture's text to edit it in a detail sheet. Changes save when you finish or close the sheet, work offline, and sync across your devices.
- 2026-09-04: Delete a project from its detail sheet. It leaves your list right away with a few seconds to Undo before it's gone for good. Works offline.
- 2026-09-04: Give a project an icon, rename it, or add notes right from its detail sheet. Your changes save on their own, even offline, and sync across your devices.
- 2026-09-04: Organize your projects by status. They're grouped into Active, Next, Waiting, and Backlog (each collapsible, with a count); tap a project to open its details and pick a new status. Marking one Done clears it from the list, with a few seconds to Undo. Works offline.
- 2026-09-04: New Projects tab: name a project by the outcome you want to reach and see all your projects in one list. Creating a project works offline and syncs across your devices.
- 2026-09-03: The quick-add box now sits right above the keyboard instead of floating in the middle of the screen.
- 2026-09-02: New Upcoming tab lists captures scheduled for a future day, grouped by day (Tomorrow and beyond). Tap a capture's circle to process it or its text to edit.
- 2026-09-02: New bottom tab bar to move between sections; Captures is the first.
- 2026-09-02: Press and hold a capture to drag it to a new spot; the order sticks and syncs across your devices. Works offline.
- 2026-08-31: Swipe a capture right to postpone it to the next day; it drops off your list and comes back tomorrow. Works offline.
- 2026-08-31: The Today tab is gone; the app is one Captures list again.
- 2026-08-30: Tap a capture's text to edit it inline. Changes save on their own, even offline, and sync across your devices.
- 2026-08-30: The Inbox is now called Captures.
- 2026-08-30: The home screen now has Inbox and Today tabs. On Today you add a task for today, tap its circle to complete it, and see anything overdue roll in while future-dated tasks stay hidden until their day.
- 2026-08-29: The Inbox opens instantly to your saved list and refreshes when you return to the app, so items captured elsewhere show up without a restart.
- 2026-08-29: Opening the Inbox goes straight to your list from the local copy, with no "Loading your inbox…" flash on the way in.
- 2026-08-29: Inbox items now show as spaced cards with more room around each one, larger tap targets, and a roomier capture bar.
