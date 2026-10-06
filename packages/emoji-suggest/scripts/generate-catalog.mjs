import { writeFileSync } from "node:fs";

const SOURCE = "https://www.unicode.org/Public/18.0.0/emoji/emoji-test.txt";
const MAX_EMOJI_VERSION = 15.1;
const COUNTRY_SUBGROUPS = new Set(["country-flag", "subdivision-flag"]);
const OUTPUT = new URL("../src/catalog.ts", import.meta.url);

const text = await (await fetch(SOURCE)).text();
const bySubgroup = new Map();
const countries = [];
let group = "";
let subgroup = "";

for (const line of text.split("\n")) {
  if (line.startsWith("# group: ")) group = line.slice(9).trim();
  else if (line.startsWith("# subgroup: ")) subgroup = line.slice(12).trim();
  if (!line.includes("; fully-qualified") || group === "Component" || line.includes("skin tone")) continue;
  const match = line.match(/# (\S+) E(\d+\.\d+) (.+)$/);
  if (!match || Number(match[2]) > MAX_EMOJI_VERSION) continue;
  const [, emoji, , name] = match;
  if (COUNTRY_SUBGROUPS.has(subgroup)) {
    countries.push({ emoji, name: name.trim().replace(/^flag: /, "") });
    continue;
  }
  if (!bySubgroup.has(subgroup)) bySubgroup.set(subgroup, []);
  bySubgroup.get(subgroup).push({ emoji, name: name.trim() });
}

const categories = [...bySubgroup].map(([key, emoji]) => ({
  label: key.replace(/-/g, ": ").replace(/ & /g, " and "),
  emoji,
}));
countries.sort((a, b) => a.name.localeCompare(b.name, "en"));

const source = [
  'import type { CatalogEmoji, Category } from "./types";',
  "",
  `export const CATEGORIES: readonly Category[] = ${JSON.stringify(categories, null, 1)};`,
  "",
  `export const COUNTRIES: readonly CatalogEmoji[] = ${JSON.stringify(countries, null, 1)};`,
  "",
].join("\n");
writeFileSync(OUTPUT, source);
const total = categories.reduce((n, c) => n + c.emoji.length, 0);
console.log(`${categories.length} categories, ${total} emoji, ${countries.length} country flags`);
