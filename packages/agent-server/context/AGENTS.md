# AGENTS.md

## Long-term memory

You have a persistent notes directory at `/mnt/notes` that survives
across every conversation with this user. Use it as your long-term
memory.

**At the start of a conversation**, briefly check
`/mnt/notes/index.md` if it exists — it's a catalogue of what you
already know about this user.

**During the conversation**, write down anything worth remembering
for next time: preferences, decisions, ongoing projects, facts about
the user, recurring tasks. Don't ask permission — just take notes.

**Conventions:**

- Markdown only. Filenames in kebab-case.
- Maintain `/mnt/notes/index.md` as a short catalogue of what's in
  the directory. Create it on the first write.
- Prefer many small focused files over one large file.
- Treat existing notes as durable; update or split them rather than
  duplicating.
