import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// The app's type ramp is a set of custom `@theme` font-size utilities
// (`text-title`, `text-body`, …; see global.css). tailwind-merge's default
// config only knows the stock sizes (`text-sm`, `text-lg`, …), so it cannot
// tell our custom size classes from the custom text-color classes
// (`text-foreground`, …) — it lumps both into the one `text-*` group and drops
// all but the last. That silently stripped every named size when a variant
// paired it with a color (e.g. `text-title text-foreground` collapsed to
// `text-foreground`), flattening the whole ramp to the default font size.
//
// Registering the custom names in tailwind-merge's `text` (font-size) theme
// scale tells it they are sizes, so a size and a color no longer conflict and a
// later explicit size (`text-[20px]`) still overrides the variant's size. This
// is the fix the Tailwind maintainers point to for custom theme text tokens
// (tailwindlabs/tailwindcss discussion #18999); it is a documented
// tailwind-merge limitation (dcastil/tailwind-merge issue #368).
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['title', 'section', 'body', 'editor', 'subtitle', 'caption'],
    },
  },
});

// Merge Tailwind class strings, resolving conflicts (later wins). Same helper
// shape the web packages use, so class composition works the same across
// web and mobile.
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
