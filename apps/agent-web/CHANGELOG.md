# Changelog

User-facing changes to the web app, most recent first.

- 2026-09-30: Start using Tasks and Projects without signing in. Your browser keeps the work locally; your first sign-in adds it to that account alongside its existing work.

- 2026-09-30: Open the full Task editor from Home, Upcoming, or a Project to rename, schedule, move, stop repeats, complete forever, or visit its Project. Title edits survive completion and Undo.

- 2026-09-30: Add scheduled or repeating Tasks from Projects and Project pages, choose their destination, and keep nonempty drafts until you save or confirm discard. Failed additions can retry saving without creating duplicates.

- 2026-09-30: Home and Upcoming update at midnight and when you return to the tab. Clear Home shows every Next and Waiting Project.

- 2026-09-30: Open Project status for its explanation and lifecycle actions. Dismiss feedback directly and refresh from sync details; save failures stay visible across navigation.

- 2026-09-27: Home now shows sync as an icon beside your account. Open it to see the last successful sync and offline-storage details; reconnecting shows Connecting instead of briefly reporting Offline.

- 2026-09-27: Home now uses `/home` as its sole address; the retired `/captures` address is no longer supported.

- 2026-09-26: Tasks and Projects now stay available offline, update live across devices and browser tabs, and recover automatically after reconnecting.

- 2026-09-24: When assigning a Task or choosing an After Project, Projects appear under Active, Next, Waiting, After, and Backlog. After and large Backlogs start folded; every Project picker now has a title filter that finds Projects inside them.

- 2026-09-24: Drag tasks by their handles to reorder them on a project's page. Keyboard reordering works too, and the order stays after you leave or refresh.

- 2026-09-16: Projects now separate manual Waiting from automatic After relationships. Dated work can bring an After project forward, Waiting and After appear before Tasks in the Project workspace, After starts collapsed in Projects, and Add opens focused Task, Waiting condition, After project, or Project flows.

- 2026-09-16: Completing a Project task still saves immediately and now offers Waiting for… beside Undo; completing a Project also offers Undo and restores the After relationships that completion resolved.

- 2026-09-16: Dates and repeats recognized while adding a task now appear on a colored background; click the active phrase to keep those words and move recognition to the previous date in the title.

- 2026-09-16: Weekly and monthly repeat phrases now keep their explicit weekday: “every week on Saturday” schedules Saturday, and “first Tuesday of every month” schedules the first Tuesday instead of today’s month day.

- 2026-09-16: Type dates and repeats into a task, such as “tomorrow”, “every Monday”, or “after 3 days”. Repeating tasks advance in place with Undo; fixed schedules catch up missed occurrences instead of skipping them, while `every!` schedules from when you complete the task.

- 2026-09-15: Make an existing project depend on another project, see hard blockers under Depends on and in a separate Blocked section, and return its dated tasks to Home when the final prerequisite clears. Project deletion now confirms the permanent cascade and warns when removing a prerequisite affects other projects.

- 2026-09-14: Browser tabs now show a larger graphite task mark without an extra white square, including on dark browser themes.

- 2026-09-14: Browser tabs now show the task icon on a clean square instead of an awkward pre-cropped circle.

- 2026-09-14: Browser tabs and saved home-screen shortcuts now use the same white-and-graphite task icon as the mobile app.

- 2026-09-12: The take-on star is gone — giving a project task a date is now how you commit it. On a project's page each task shows a date chip; click it and pick Today to bring the task to Home (the project turns active), or leave it with no date to keep grooming it there. New tasks you add on a project start with no date. Everything else works the same: a future date shows the project as waiting until that day, and a dated task returns to Home on its day.
- 2026-09-12: A project waiting on a condition now shows how long it's been waiting as "for 5 days", matching the "until <day>" label on a project waiting for a date.
- 2026-09-12: Deleting a project now also deletes all of its tasks and everything it was waiting on, so nothing is left behind with no project to belong to. Deleting a project is still permanent — there's no undo.
- 2026-09-12: Pushing a project task you've taken on to a future day now moves the project to Waiting and shows the day it's waiting until (e.g. "until Tue"), on both the project's page and its row in the Projects list. The task leaves Home and returns on its own when the day arrives — the project turns active again with nothing to re-star. A task you dated but never took on stays on the project's page until you do.
- 2026-09-12: A task's detail now has a Project row — click it to file the task under a project, or move it back to loose. Filing a task under a project takes it off Home until you take it on from the project.
- 2026-09-12: Home is now one list. What you add is a task — there's no separate capture inbox or "Process" step anymore. The quick-add adds a task by default (and can still create a project). Reorder by dragging, postpone with the row's "Tomorrow" button, complete with the circle (with Undo), and click the text to rename or schedule it. Anything you postpone appears under Upcoming and returns on its day. "Refine" is gone for now.
- 2026-09-11: Tapping a capture opens a cleaner detail: a complete circle, an editable title, a schedule row that opens a Today / Tomorrow / calendar picker (or clears the date), and a "Refine into tasks & projects" action. The old "Done" button is gone — the circle completes the capture, and your edits save when you close the sheet.
- 2026-09-10: Add a waiting condition from the "+ Waiting condition" control, which now opens a small composer popover instead of an inline form that pushed the page. All three kinds (free text, until a task is done, until a project reaches a status) are still there.
- 2026-09-10: Each waiting project now shows how long it has been waiting (e.g. "3 days") on its row, and the Waiting section is ordered so the longest-waiting project is on top.
- 2026-09-09: The quick-add prompt is simpler and no longer shows a separate hint line — the Projects page and Home's Project mode now prompt "Name an outcome", and a project's task field prompts "Add a task".
- 2026-09-09: Undo on the bottom bar now reliably brings a completed task or a processed capture back. Before, tapping Undo could quietly do nothing once the row had left the list.
- 2026-09-09: Completing a task on a project's own page now shows the same bottom Undo bar as everywhere else, so a mis-click is one click to bring it back.
- 2026-09-09: Completing a capture from your inbox (on Home or Upcoming) now shows the same Undo bar that tasks do, so a mis-tap is one click to bring it back.
- 2026-09-09: Completing a task, marking a project done, and deleting a project now happen right away, instead of leaving the row crossed out for a few seconds first. Navigating away no longer cancels the action. Completing a task shows an Undo bar at the bottom that brings the task back; a second completion replaces the bar, so there's only ever one. Marking a project done or deleting it — both already in the project's "⋯" menu — just happen, with no Undo. The old "+ Waiting condition" shortcut that appeared while a task was finishing is gone; add waiting conditions on the project's page.
- 2026-09-08: A new project suggests emoji icons for itself. Create a project and, by the time you open the icon picker, a row of suggested icons based on its name is already there — tap one to use it. Refresh recomputes them (handy after you add a description), and the full emoji picker is always right below.
- 2026-09-08: Create a project straight from Home. The quick-add now has a Project option alongside Capture and Task; adding one keeps you on Home and shows a toast with a link to open the new project.
- 2026-09-08: Starring a task on a waiting project brings the project back to active, even while it is still waiting on something; finishing that task returns the project to waiting.
- 2026-09-08: Pick any emoji as a project's icon. Opening the icon picker now offers a searchable list of every standard emoji, instead of a small fixed set.

- 2026-09-06: The Today screen is now Home. When your plate and inbox are both empty, it shows a next step based on your projects — plan your day, bring a project forward from the backlog, or create your first project. Tasks you're working on now show their project's icon.

- 2026-09-05: A project now opens its own page instead of a pop-up panel. The page leads with the project's tasks and what it's waiting on; its title is editable at the top, the icon is tucked away until you want it, and status changes and delete live in a "⋯" menu.
- 2026-09-05: Deleting a project now removes it from the list right away, instead of quietly coming back until the next refresh.
- 2026-09-05: Refine a capture into real work. Hover a capture and click Refine (or open it and choose Refine) — a banner pins it while you create tasks on Today and projects on Projects, all linked back to that capture. Click Done to clear it from your inbox.
- 2026-09-05: Finishing a task on Today leaves it in place for a few seconds with Undo — and, for a task in a project, a "+ Waiting condition" shortcut so you can record what the project is now waiting on the moment you finish the task that triggered it.
- 2026-09-05: Say what a project is waiting on. Add a waiting condition in its detail sheet — free text ("the letter comes back"), until a task is done, or until another project reaches a status — and the project shows as Waiting with its tasks hidden from Today. The task/project conditions clear themselves automatically; resolve a free-text one by hand.
- 2026-09-05: Projects now sort themselves: a project shows as Active while one of its tasks is taken on, and drops to Next once you've cleared them — a nudge to groom and take on more. Backlog and Done stay yours to set (the detail sheet now offers Put in play / Move to backlog / Mark done).
- 2026-09-05: Choose which of a project's tasks you're taking on: star a task in the project to put it on Today, and star it again on Today to park it. No fixed limit — you decide how much shows up. Loose tasks always show.
- 2026-09-05: Your Today list shows tasks from active projects (plus loose tasks); a project's tasks stay hidden until you make it active, so only what you're working on surfaces.
- 2026-09-05: Add tasks to a project and complete them from the project's detail sheet, so a project holds the work toward its outcome.
- 2026-09-05: The Captures section is now Today, with two parts: your tasks for today on top and your capture inbox below. The quick-add creates a capture by default; switch it to Task to add a task instead.
- 2026-09-05: The app now follows your device's light or dark appearance automatically.
- 2026-09-04: Tap a capture's text to edit it in a detail sheet. Changes save when you finish or close the sheet and sync across your devices.
- 2026-09-04: Delete a project from its detail sheet. It leaves your list right away with a few seconds to Undo before it's gone for good.
- 2026-09-04: Give a project an icon, rename it, or add notes right from its detail sheet. Your changes save on their own and sync across your devices.
- 2026-09-04: Organize your projects by status. They're grouped into Active, Next, Waiting, and Backlog (each collapsible, with a count); tap a project to open its details and pick a new status. Marking one Done clears it from the list, with a few seconds to Undo.
- 2026-09-04: New Projects section: name a project by the outcome you want to reach and see all your projects in one list. Your projects are saved and sync across your devices.
- 2026-09-02: New Upcoming section lists captures scheduled for a future day, grouped by day (Tomorrow and beyond). Click a capture's circle to process it or its text to edit.
- 2026-09-02: New side navigation (a bottom bar on phones) to move between sections; Captures is the first.
- 2026-09-02: Drag a capture by its handle to reorder your list; the order sticks and syncs across your devices. Works with the keyboard too.
- 2026-08-31: Cleaner Captures screen — the tagline under the heading is gone.
- 2026-08-31: Click "Tomorrow" on a capture to postpone it to the next day; it drops off your list and comes back tomorrow.
- 2026-08-31: The Today tab is gone; the app is one Captures list again.
- 2026-08-30: Tap a capture's text to edit it inline. Changes save on their own and sync across your devices.
- 2026-08-30: The Inbox is now called Captures.
- 2026-08-30: More breathing room between the capture bar and the list on Inbox and Today.
- 2026-08-30: A Today view sits beside the Inbox. Switch to Today and anything you add becomes a task for today; check it off when done. Overdue tasks carry over to today on their own.
- 2026-08-29: The Inbox opens instantly to your saved list and refreshes when you return to the tab, so items captured elsewhere show up without a reload.
- 2026-08-29: Opening the Inbox goes straight to your list from the local copy, with no "Loading your inbox…" flash on the way in.
- 2026-08-29: Inbox items now show as spaced cards with more room around each one, larger tap targets, and a roomier capture bar.
