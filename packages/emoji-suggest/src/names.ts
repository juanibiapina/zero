import { CATEGORIES, COUNTRIES } from "./catalog";

const NAMES = new Map<string, string>([
  ...CATEGORIES.flatMap((c) => c.emoji.map((e) => [e.emoji, e.name] as const)),
  ...COUNTRIES.map((c) => [c.emoji, `flag: ${c.name}`] as const),
]);

export const emojiName = (emoji: string): string | undefined => NAMES.get(emoji);
