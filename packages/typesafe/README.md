# @zeroapps/typesafe

The connection to TypeSafe's SystemOne API, pinned to `jev-1.13.0`.

- `Decide` is the port: a state and typed questions (Choice or Noul) in, typed
  answers with probabilities out. Code that asks Jev takes a `Decide`, so tests
  pass a fake.
- `typesafeDecide(apiKey)` is the production adapter. It times out after 5 s
  and throws on a non-2xx response.

Used by Project suggestion in `apps/zero-api` and by
`@zeroapps/emoji-suggest`.
