# @zeroapps/typesafe

The connection to TypeSafe's SystemOne API, pinned to `jev-1.13.0`.

- `Decide` is the port: a state and typed questions (Choice or Noul) in, typed
  answers with probabilities out. Code that asks Jev takes a `Decide`, so tests
  pass a fake.
- `typesafeDecide(apiKey)` is the production adapter. It times out after 5 s
  and throws on a non-2xx response.

Used by Project suggestion in `apps/zero-api` and by
`@zeroapps/emoji-suggest`.

## Project suggestion

While a signed-in user types a new Task in global quick add, the client waits
for a 400 ms pause and sends the title, without schedule phrases, and the open
Projects to `POST /api/tasks/project-suggestion`. Each Project carries its
description and up to five newest open Task titles. The Worker asks Jev
(`jev-1.13.0`, key `TYPESAFE_API_KEY`) one Choice over those Projects plus
`none`, and returns a Project only when its probability is at least 0.5. Each
request logs `task_project_suggested` with its confidence, latency, and input
tokens.

On 2026-10-05 this setting placed 37 of 47 real Project Tasks correctly, 2
wrongly, and 2 of 22 unrelated Tasks in a Project, at 313 ms median and 366 ms
p95 round trip. Cloudflare's Jev-compatible Clef model placed 33 of 47
correctly with the same error counts.
