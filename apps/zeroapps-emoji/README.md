# Emoji for anything

A public page at [emoji.zeroapps.dev](https://emoji.zeroapps.dev). Anyone types
what they need an emoji for and gets up to six suggestions; clicking one copies
it. Every search has its own link (`?q=…`) to share.

Suggestions come from `@zeroapps/emoji-suggest` (TypeSafe's Jev), the same code
that suggests Project icons in Zero.

## Run it

```bash
pnpm -F @zeroapps/emoji dev
```

The page and `/api/suggest` are served together on port 5184. The `dev` script
reads `TYPESAFE_API_KEY` from the `zeroapps-emoji` ZeroVault project.

## `GET /api/suggest?q=<text>`

Returns `{ emoji: [{ emoji, name }] }` for 1–200 characters of text.

- Answers are cached for 7 days under the lowercased, trimmed text, so an opened
  link costs nothing.
- The page searches after a 600 ms pause in typing (3 characters or more) or
  on Enter.
- Uncached searches are limited to 20 per minute per IP and 30 per minute
  overall, so public use stays under a fifth of TypeSafe's token rate limit,
  which may be shared with Zero.
- A TypeSafe failure returns 503 and is not cached.
- Each request logs `emoji_suggested` with whether it was cached, latency, and
  input tokens. The text people type is never logged.
