---
name: memory
description: "Persistent memory at /workspace/notes. Load at the start of every conversation."
---

# Memory

Your memory consists of persistent notes at `/workspace/notes`.
This directory survives across every conversation with this user.
Gather context from notes when interacting with the user.
Use it to track everything that you and the user know.

## When to write

Write a note when:
- The user states a preference or corrects you
- A decision is made
- An action has been taken
- A state change happened in the world
- A new person, project, entity, interest or task appears
- Something has clear future value for future conversations

Don't ask permission. Just take notes.

## What not to store

- Secrets: passwords, API keys, tokens
- One-off transient info (temporary debug output, throwaway commands)
- Duplicates of existing notes — update the existing file instead

## Organization

- One file per thing
- Name the file after the subject: `Maria.md`, `Buy a House.md`, `Sourdough Recipe.md`, `Berlin Trip 2026.md`.
- Flat structure.
- Markdown only.

## Special Notes

- User.md: User identity (load in the beginning of conversations)
