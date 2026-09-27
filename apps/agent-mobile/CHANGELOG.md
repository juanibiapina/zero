# Changelog

User-facing changes to the mobile todo app, most recent first.

- 2026-09-27: Pressing + now smoothly transforms the button into the add drawer as the keyboard appears, and reverses back into the button when you close it.

- 2026-09-27: You can start using tasks and projects without signing in, then sign in from the account button whenever you want cross-device sync.

- 2026-09-27: Pulling down to refresh now reconnects and synchronizes your todo list before the spinner stops.

- 2026-09-26: Resolving a Waiting item removes it from the Project immediately without requiring an app restart.

- 2026-09-26: Filing a new Task into a Project from Home confirms where it went after the Task is safely saved.

- 2026-09-26: Tasks and Waiting relationships that point to a missing Project are preserved during account migration and shown for repair instead of being dropped.

- 2026-09-26: Your complete todo list—including Projects, Waiting, After relationships, and repeats—can now stay on the phone for offline use and sync with the web.

- 2026-09-24: Pressing + opens the keyboard with the add drawer, without a pause or a gap between them.

- 2026-09-24: Pressing + opens the add drawer with the keyboard instead of showing a separate drawer slide first.

- 2026-09-24: Upcoming now opens from Browse on the right side of the tab bar. Home and Projects stay one tap away.

- 2026-09-24: When assigning a Task or choosing an After Project, Projects appear under Active, Next, Waiting, After, and Backlog. After and large Backlogs start folded; filtering still finds Projects inside them.

- 2026-09-23: Snackbars are shorter and usually one line. Project feedback keeps its icon, and Undo, Waiting, and View remain available without the extra copy.

- 2026-09-23: Snackbars clear when you interact, navigate, or leave the app. Undo and other action snackbars normally last four seconds; Android accessibility settings can give you more time.

- 2026-09-23: Adding a scheduled task, changing or clearing its date, and postponing it no longer show a snackbar; filing it to another Project still does.

- 2026-09-17: Project descriptions now save before you add work, open another control, or leave the Project, so Back no longer loses what you wrote.

- 2026-09-17: From Projects, the + button now lets you add either a Project or a Task, including the Task's date and Project choices.

- 2026-09-16: Swipe a snackbar sideways to dismiss it. Snackbars now sit above the + button instead of covering it.

- 2026-09-16: Adding a Waiting condition now labels the current Project separately from what it is waiting on.

- 2026-09-16: Projects keep manual Waiting and automatic After separate, while their screens now put status before description in a tighter workspace. Pressing + opens the familiar Task, Waiting, After, and Project selector directly; section + controls open it on the matching type.

- 2026-09-16: Completing a Project task still saves immediately and offers Waiting for… beside Undo; that action now shows the destination Project and asks what needs to happen in the same add drawer. Completing a Project also offers Undo and restores the After relationships that completion resolved.

- 2026-09-16: Dates and repeats recognized while adding a task now appear on a colored background; tap the active phrase to keep those words and move recognition to the previous date in the title.

- 2026-09-16: Weekly and monthly repeat phrases now keep their explicit weekday: “every week on Saturday” schedules Saturday, and “first Tuesday of every month” schedules the first Tuesday instead of today’s month day.

- 2026-09-16: Type dates and repeats into a task, such as “tomorrow”, “every Monday”, or “after 3 days”. Repeating tasks advance in place with Undo; fixed schedules catch up missed occurrences instead of skipping them, while `every!` schedules from when you complete the task.

- 2026-09-16: The clear-Home launcher checkmark is smaller and leaves more breathing room around itself.

- 2026-09-16: New Android installs use the three-row task mark as the app icon while the launcher still mirrors Home after the app loads.

- 2026-09-15: Swipe right on a project task to schedule it for Today; swiping on Home still postpones a task to Tomorrow.

- 2026-09-15: Home now brings scheduled tasks in automatically when the day changes, and pull-to-refresh works while Home is empty.

- 2026-09-15: Preview installs now download compatible releases automatically, so most updates arrive after reopening the app without downloading another APK.

- 2026-09-15: Make an existing project depend on another project, see hard blockers under Depends on and in a separate Blocked section, and return its dated tasks to Home when the final prerequisite clears. Deleting a prerequisite warns when it affects other projects.

- 2026-09-14: The clear-Home launcher checkmark is larger and bolder, so it reads more clearly at a glance.

- 2026-09-14: Jump straight from a task's editor to its project with the arrow icon, and filter projects by name when assigning a task.

- 2026-09-14: The launcher icon now mirrors Home: a checkmark when your list is clear, then one to four task rows as work appears.

- 2026-09-14: Empty projects no longer show a “No tasks yet” prompt, and the project status sheet keeps just the status and its actions.

- 2026-09-14: The app now uses the white-and-graphite task icon on the launcher and launch screen, with a matching Android themed icon.

- 2026-09-13: After signing in online, you can reopen the app without a connection and access your locally saved tasks instead of getting stuck during startup.

- 2026-09-13: Screen readers announce snackbar results, selected dates, and expanded project sections. Calendar and snackbar controls are easier to tap, waiting actions name their condition, and drawers stay usable with larger text.

- 2026-09-13: The calendar reopens at your selected month, creation uses a “Project” picker, and undated tasks say “No date” consistently.

- 2026-09-13: Project status has a visible disclosure arrow and explains how tasks and waiting conditions determine it. “Move out of backlog” replaces “Put in play”.

- 2026-09-13: Empty projects explain how to start and offer Add task directly, with separate guidance for projects in Backlog.

- 2026-09-13: Scheduling, moving, and adding tasks outside your current list now explains where they went and offers View to open the destination.

- 2026-09-13: If deleting or completing a project fails, the explanation stays visible after you leave the screen, with instructions to refresh and try again.

- 2026-09-13: Creating a project from Projects uses the same drawer as Home and asks before discarding your draft; submitting still opens the new project.

- 2026-09-13: The project picker scrolls within the screen and marks the selected project with a check, so longer lists stay usable.

- 2026-09-13: Undo and other snackbar actions stay available for at least eight seconds, respect Android's accessibility timeout, and pause while the app is in the background.

- 2026-09-13: Deleting a project now asks for confirmation and explains that its tasks and waiting conditions are permanently deleted too.

- 2026-09-13: Task names you edit are saved before scheduling, moving, or completing the task, and Undo keeps the edited name.

- 2026-09-13: Project descriptions and their empty prompt are easier to read with stronger contrast.
- 2026-09-13: Tap a project's status to move it into play, send it to Backlog, or mark it done. Project settings now keeps Delete project in a compact menu.
- 2026-09-13: Create a project without leaving the project you're working in: open +, tap Project, and name the new outcome. Task still opens by default.
- 2026-09-13: On a project's screen, press and hold tasks to reorder them or swipe right to schedule them for Tomorrow. Scrolling and pull-to-refresh still work directly from task rows.
- 2026-09-13: A project waiting for a scheduled task now shows the date in its status and directly beneath that task, instead of listing an unexplained automatic condition. Project task rows also have more room and clear dividers.
- 2026-09-13: Opening any add form now brings up the keyboard automatically.
- 2026-09-13: Task and project names now use the same title type while you add them.
- 2026-09-12: Creating and editing tasks now use the same bottom drawer, with clear date and project rows instead of round pills. A selected project shows its own icon once, and hiding the keyboard keeps your draft open.

- 2026-09-12: On a project's screen you can now tap a task to open the full editor — rename it, schedule it, move it to another project, or complete it — the same editor Home and Upcoming use. Adding a task there now uses the same quick-add as Home, with an optional date and a project chip preset to the current project (change it to file the new task elsewhere, or keep it here). The old per-task date chip on the project screen is gone; set a date from inside the editor instead.
- 2026-09-12: The take-on star is gone — giving a project task a date is now how you commit it. On a project's screen each task shows a date chip; tap it and pick Today to bring the task to Home (the project turns active), or leave it with no date to keep grooming it there. New tasks you add on a project start with no date. Everything else works the same: a future date shows the project as waiting until that day, and a dated task returns to Home on its day.
- 2026-09-12: Home scrolls again when it's full, and pull-to-refresh works even when you start the pull on a task instead of from empty space. Swipe-to-postpone, drag-to-reorder, and tap-to-open are unchanged.
- 2026-09-12: A project waiting on a condition now shows how long it's been waiting as "for 5 days", matching the "until <day>" label on a project waiting for a date.
- 2026-09-12: Upcoming tasks now show their project's icon before the title, just like Home. Loose tasks show none.
- 2026-09-12: Deleting a project now also deletes all of its tasks and everything it was waiting on, so nothing is left behind with no project to belong to. Deleting a project is still permanent — there's no undo.
- 2026-09-12: Pushing a project task you've taken on to a future day now moves the project to Waiting and shows the day it's waiting until (e.g. "until Tue"), on both the project's screen and its row in the Projects list. The task leaves Home and returns on its own when the day arrives — the project turns active again with nothing to re-star. A task you dated but never took on stays on the project's screen until you do.
- 2026-09-12: A task's detail now has a Project row — tap it to file the task under a project, or move it back to loose. Filing a task under a project takes it off Home until you take it on from the project. Works from both Home and Upcoming.
- 2026-09-12: Home is now one list. What you jot down is a task — there's no separate capture inbox or "Process" step anymore. The quick-add adds a task by default (and can still create a project). Swipe a task right to push it to tomorrow, long-press to reorder, tap the circle to complete (with Undo), and tap the text to rename or schedule it. Anything you postpone shows up under Upcoming and returns on its day. "Refine" is gone for now.
- 2026-09-11: A project's screen no longer shows an empty "Tasks" or "Waiting on" heading — each section appears only once it has something in it. Add either from the + button.
- 2026-09-11: Tapping a capture in Upcoming now opens the same detail editor as Home — complete it with the round check, edit the title, reschedule it, or refine it into tasks & projects — instead of a plain inline text edit.
- 2026-09-10: Tapping a capture opens a cleaner detail: a round check to complete it, an editable title, a quiet "Refine into tasks & projects", and a schedule row that opens a Today / Tomorrow / calendar picker (or clears the date). The old "Done" button is gone — the check completes the capture, and your edits save when you close the sheet.
- 2026-09-10: Pull-to-refresh now works anywhere on Home — over the inbox rows and the empty space below them. Before, it only worked from the top: the rows' swipe-to-postpone gesture swallowed the pull, and the empty area below a short inbox wasn't refresh-responsive at all.
- 2026-09-10: Completing a task that belongs to a project now names the project in the "Completed" bar and adds a one-tap Open beside Undo that jumps straight to that project's screen. Completing a loose task is unchanged.
- 2026-09-10: Opening a project from a link — the View after creating one on Home, and the new Open on a completed task — now lands on the project's own screen directly, with the tabs still showing and Back returning to the Projects list, instead of dropping you on the list.
- 2026-09-10: Adding a project from the Projects list now opens its own screen right away, so you can add a description, pick an icon, and start listing tasks. When refining a capture, this keeps going — the new project links back to the capture, and tasks you add on its screen do too.
- 2026-09-11: The Projects list + button now shows a "Project" pill above the input when opened, matching Home and the project screen.
- 2026-09-10: Add what a project is waiting on from the project's + button — it now offers a "Waiting" pill beside "Task", so one + adds either a task or a waiting condition. The always-open "Waiting on…" field is gone.
- 2026-09-10: Each waiting project now shows how long it has been waiting (e.g. "3 days") on its row, and the Waiting section is ordered so the longest-waiting project is on top.
- 2026-09-09: Removed a thin orange line that showed beneath each inbox capture on Home. Swiping a capture right still reveals "Tomorrow" and postpones it.
- 2026-09-09: Screen titles and headings now show at their proper size. A styling bug had shrunk the top titles (Home, Upcoming, Projects) and every heading down to a small default; text across the app now renders at its intended size.
- 2026-09-09: Adding a task on a project's own screen now shows the same "Task" pill in the quick-add box as Home does, so it's clear you're adding a task there.
- 2026-09-09: The quick-add box now closes as soon as you add something, on every screen, instead of staying open. It also shows a single, clearer prompt with no separate hint line — Projects and the New project box now say "Name an outcome".
- 2026-09-09: Undo on the bottom bar now actually brings a completed task or a processed capture back on your phone. Before, the bar appeared but tapping Undo quietly did nothing once the row had left the list.
- 2026-09-09: Completing a task on a project's own screen now shows the same bottom Undo bar as everywhere else, so a mis-tap is one tap to bring it back.
- 2026-09-09: Completing a capture from your inbox (on Home or Upcoming) now shows the same bottom Undo bar that tasks do, so a mis-tap is one tap to bring it back. The Undo bar also sits clear above the tabs now, instead of overlapping them.
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
