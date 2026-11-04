# Prompt

## What it is

A Prompt is a question an agent asks you through Zero, which you answer later in the app. An agent planning a trip asks "Which flight?", explains that two flights fit, and suggests "The 9:40" and "The 14:05". You open the Prompt, tap one, or type your own answer, such as "Neither, wait for prices to drop". The agent reads your answer when it next checks.

The question can be a whole document: an agent asking you to approve a plan writes it in Markdown, with headings, lists, tables, code, and Mermaid diagrams, and offers "Approve" and "Revise". Before you answer, you can comment on any passage or diagram, the way you would mark up a draft, and the agent reads your comments together with your answer.

## Why it is its own block

An agent working on its own often needs a decision only you can make, and you are not always there when it asks. A Prompt keeps the question until you answer, and gives the agent your words back as text it can act on.

## Rules

- An agent writes the title, the question, and up to 6 suggested answers. A Prompt can have no suggestions.
- The question is GitHub-flavored Markdown. A code block fenced as `mermaid` shows as a diagram. An agent cannot create a Prompt whose diagram does not parse; it gets the parser's message back and fixes the diagram.
- Until you answer, you can comment on any passage: tap a paragraph, list item, heading, table cell, code block, or diagram, or select some words. Each comment keeps the passage it is on. You can remove a comment before you answer. Answering locks the comments with the answer.
- You can always answer in your own words, also when the Prompt has suggestions.
- A Prompt is new until you open it. Opening it on any device marks it read.
- A Prompt takes one answer. Answering closes it, and it then shows your answer and cannot be answered again.
- An agent can mark a Prompt handled once it has acted on the answer, and unmark it. The mark covers the answer it was set on: if the answer changes afterwards, the Prompt is not handled again, and the agent sees the answer it had handled. The app does not show the mark.
- Only agents delete Prompts. A deleted Prompt leaves every device, answered or not.
- Nothing notifies you. A Prompt waits in the app until you open it.
- Hands-free starts with a short chime, then reads your unanswered Prompts aloud, oldest first, also with the screen off. It reads the title, the question, and the suggestion volume up takes, without explaining the keys. Volume up takes the first suggestion; on a Prompt with no suggestions it skips the Prompt until the next hands-free session. Volume down records a spoken answer as a Recording, and the transcript of that Recording becomes the answer. A silent recording leaves the Prompt open. Reading a Prompt aloud marks it read.
- While hands-free runs, the volume keys do not change the volume, and they are its only keys: one press each, and holding a key counts as one press. Headset buttons do nothing. Either key stops a spoken answer at any point: during the "Speak your answer" cue it cancels the answer, and while recording it stops and saves it.
- Hands-free is a row in Browse. Its screen shows the Prompt being read, what each key does, and an End hands-free button, and a notification with a Stop button stays while it runs. When no Prompts are left, volume down records a plain voice note and volume up ends hands-free.

## How it looks

A question-bubble button in Home's header, left of the mic, with a badge counting the Prompts you have not answered. Tapping it opens the oldest one; with none left, it opens the list.

A Prompt opens full screen, without the tab bar: its title, the question rendered as a document, and after the document one button per suggestion and a text field with a send button. The document colors its headings, inline code, list markers, and quotes with the accent, and highlights code blocks. While the answer controls are below the screen, a floating Answer button scrolls to them. An answered Prompt shows its answer in a box under the title and no answer controls.

Picking a passage tints it and replaces the answer controls with a comment field, docked at the bottom, that names the passage. A comment shows under its passage, in a box with an accent edge, and the passage stays tinted. Once a Prompt has comments, a line above the suggestions says how many go with your answer.

Browse lists Prompts in two groups, Open and Answered, newest first. A circle in front of each shows its state: filled accent for a new Prompt, light accent for one you opened, grey with a check for an answered one. A new Prompt has a bold title. Below the title is the answer when there is one, otherwise how long ago it arrived, or its date after a week.

## Interactions

- Task, Project, Waiting, After, Medicine, Night routine, Recording, Shopping item: none, on purpose.
- Agents: ask, wait for the answer, read the answer and the comments, list, mark handled, and delete. They cannot answer or comment.

## Left out on purpose

- Notifications, on the phone or inside the app.
- Deleting a Prompt from the app.
- Prompts on the web.
- Picking several suggestions, or changing an answer.
- Commenting after answering, editing a comment, and replying to one.
- Sending comments without an answer: comments go with an answer, which can be a suggestion such as "Revise".

## Ideas

- A phone notification when a Prompt arrives.
- Let an answer create a Task or a Shopping item directly.
