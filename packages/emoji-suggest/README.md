# @zeroapps/emoji-suggest

Suggests emoji for a short text with TypeSafe's Jev (`jev-1.13.0`). Zero uses it
for Project icons; `apps/zeroapps-emoji` uses it for the public emoji page.

```ts
import { suggestEmoji } from "@zeroapps/emoji-suggest";
import { typesafeDecide } from "@zeroapps/typesafe";

const { emoji, inputTokens } = await suggestEmoji(typesafeDecide(apiKey), {
  title: "Trip to Japan",
  description: null,
  purpose: { context: "The user … wants an emoji as its icon.", subject: "project" },
});
```

`purpose.context` says what the emoji is for, and `purpose.subject` names the
thing in every question. The function never throws: a failure returns
`{ emoji: [], inputTokens: null }`.

## How it picks emoji

Jev answers typed questions over options that code supplies, so each call makes
two requests:

1. One request asks which Unicode emoji category (subgroup) holds the right emoji,
   twice with the options in opposite orders, averaged, because Jev favors
   options listed first. The same request asks which country the text is about
   (two multiple choice questions over every flag, each with a "none" option)
   and whether that place is the main subject.
2. A second request asks a yes/no question, "would this emoji be a fitting
   icon?", for every emoji in the 8 best categories.

Code ranks emoji by their yes probability and keeps one per variant family:
names that match before the first `:`, ignoring words such as man, woman, and
person. A country found with probability of at least 0.5 adds its flag, first
when the place is the main subject and sixth otherwise.

A call takes about 0.7 s and up to about 35k input tokens. Measurements are in
`docs/entities/project.md`.

## Catalog

`src/catalog.ts` is generated from Unicode's `emoji-test.txt` (version 18.0):
fully qualified emoji up to Emoji 15.1, without skin tone variants, so most
phones can show every suggestion. To raise the version, change
`MAX_EMOJI_VERSION` in `scripts/generate-catalog.mjs` and run:

```bash
pnpm -F @zeroapps/emoji-suggest run generate
```
