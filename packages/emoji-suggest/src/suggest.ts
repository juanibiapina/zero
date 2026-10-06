import { CATEGORIES, COUNTRIES } from "./catalog";
import type { CatalogEmoji, Category } from "./types";
import type {
  Decide,
  SystemOneChoiceQuestion,
  SystemOneNoulQuestion,
  SystemOneQuestion,
  SystemOneResponse,
} from "@zeroapps/typesafe";

export type Purpose = {
  context: string;
  subject: string;
};

export type EmojiInput = {
  title: string;
  description?: string | null;
  purpose: Purpose;
};

export type EmojiSuggestion = { emoji: string[]; inputTokens: number | null };

export const DEFAULT_COUNT = 6;
export const CANDIDATE_CATEGORIES = 8;
export const COUNTRY_THRESHOLD = 0.5;
export const MAIN_SUBJECT_THRESHOLD = 0.5;

const NONE = "none of these";
const MISS: EmojiSuggestion = { emoji: [], inputTokens: null };
const VARIANT_WORDS = /\b(man|woman|men|women|person|people|boy|girl|adult|child|older)\b/g;
const COUNTRY_HALVES = [
  COUNTRIES.slice(0, Math.ceil(COUNTRIES.length / 2)),
  COUNTRIES.slice(Math.ceil(COUNTRIES.length / 2)),
];

const sample = (emoji: readonly CatalogEmoji[], n = 10): string[] =>
  emoji.length <= n
    ? emoji.map((e) => e.name)
    : Array.from({ length: n }, (_, i) => emoji[Math.floor((i * emoji.length) / n)].name);

const categoryQuestion = (purpose: Purpose, categories: readonly Category[]): SystemOneChoiceQuestion => ({
  type: "choice",
  instructions: {
    context: `${purpose.context} Each option is a category of emoji, with example emoji names.`,
    question: `Which category holds the emoji the user would pick as the icon for the ${purpose.subject} in \`${purpose.subject}\`?`,
  },
  criteria: Object.fromEntries(categories.map((c) => [c.label, `For example: ${sample(c.emoji).join(", ")}`])),
});

const countryQuestion = (purpose: Purpose, countries: readonly CatalogEmoji[]): SystemOneChoiceQuestion => ({
  type: "choice",
  instructions: {
    context: `${purpose.context} The ${purpose.subject} is about a country when it names the country, a city or region in it, its people, or its language, for example a trip there, a move there, family there, or learning its language.`,
    question: `Which country or region is the ${purpose.subject} in \`${purpose.subject}\` about?`,
  },
  criteria: {
    ...Object.fromEntries(countries.map((c) => [c.name, null])),
    [NONE]: `The ${purpose.subject} is not about any of the listed countries or regions.`,
  },
});

const mainSubjectQuestion = (purpose: Purpose): SystemOneNoulQuestion => ({
  type: "noul",
  instructions: `Is a country or place the main subject of the ${purpose.subject} in \`${purpose.subject}\`?`,
  criteria: {
    true: `The ${purpose.subject} is mainly about the place itself: traveling there, moving there, or learning its language or culture.`,
    false: `The place is only where it happens, or no place is named. The main subject is something else, such as an event, an activity, a purchase, or people.`,
  },
});

const fitQuestion = (purpose: Purpose, emoji: CatalogEmoji): SystemOneNoulQuestion => ({
  type: "noul",
  instructions: `${purpose.context} Would the emoji "${emoji.name}" be a fitting icon for the ${purpose.subject} in \`${purpose.subject}\`?`,
  criteria: {
    true: `The emoji clearly depicts the ${purpose.subject}'s goal, subject, or main activity.`,
    false: `The emoji is unrelated, or only matches a word in the title literally without depicting what the ${purpose.subject} is about.`,
  },
});

const family = (name: string): string =>
  name.split(":")[0].replace(VARIANT_WORDS, "").replace(/facing right/g, "").replace(/\s+/g, " ").trim();

const choiceProbabilities = (response: SystemOneResponse, id: string): Record<string, number> | null => {
  const answer = response.answers?.[id];
  return answer?.type === "choice" && answer.probabilities ? answer.probabilities : null;
};

const noulValue = (response: SystemOneResponse, id: string): number | null => {
  const answer = response.answers?.[id];
  return answer?.type === "noul" && typeof answer.noul === "number" ? answer.noul : null;
};

const detectCountry = (response: SystemOneResponse): { emoji: string; mainSubject: boolean } | null => {
  let best: { emoji: string; p: number } | null = null;
  COUNTRY_HALVES.forEach((half, i) => {
    const probabilities = choiceProbabilities(response, `country${i}`);
    if (!probabilities) return;
    for (const country of half) {
      const p = probabilities[country.name] ?? 0;
      if (!best || p > best.p) best = { emoji: country.emoji, p };
    }
  });
  const found = best as { emoji: string; p: number } | null;
  if (!found || found.p < COUNTRY_THRESHOLD) return null;
  return { emoji: found.emoji, mainSubject: (noulValue(response, "mainSubject") ?? 0) >= MAIN_SUBJECT_THRESHOLD };
};

const placeFlag = (emoji: string[], flag: { emoji: string; mainSubject: boolean } | null, count: number): string[] => {
  if (!flag) return emoji.slice(0, count);
  if (flag.mainSubject) return [flag.emoji, ...emoji].slice(0, count);
  return [...emoji.slice(0, count - 1), flag.emoji];
};

export const suggestEmoji = async (
  decide: Decide,
  input: EmojiInput,
  opts?: { count?: number },
): Promise<EmojiSuggestion> => {
  const count = opts?.count ?? DEFAULT_COUNT;
  const { purpose } = input;
  const state = { [purpose.subject]: { title: input.title, description: input.description ?? null } };
  try {
    const first = await decide({
      state,
      questions: {
        categories: categoryQuestion(purpose, CATEGORIES),
        categoriesReversed: categoryQuestion(purpose, [...CATEGORIES].reverse()),
        country0: countryQuestion(purpose, COUNTRY_HALVES[0]),
        country1: countryQuestion(purpose, COUNTRY_HALVES[1]),
        mainSubject: mainSubjectQuestion(purpose),
      },
    });
    const forward = choiceProbabilities(first, "categories");
    const reversed = choiceProbabilities(first, "categoriesReversed");
    if (!forward || !reversed) return MISS;
    const score = (c: Category) => ((forward[c.label] ?? 0) + (reversed[c.label] ?? 0)) / 2;
    const candidates = [...CATEGORIES]
      .sort((a, b) => score(b) - score(a))
      .slice(0, CANDIDATE_CATEGORIES)
      .flatMap((c) => c.emoji);

    const questions: Record<string, SystemOneQuestion> = {};
    candidates.forEach((e, i) => (questions[`e${i}`] = fitQuestion(purpose, e)));
    const second = await decide({ state, questions });

    const scored = candidates
      .map((e, i) => ({ ...e, fit: noulValue(second, `e${i}`) }))
      .filter((e): e is CatalogEmoji & { fit: number } => e.fit !== null)
      .sort((a, b) => b.fit - a.fit);
    if (scored.length === 0) return MISS;

    const seen = new Set<string>();
    const ranked: string[] = [];
    for (const e of scored) {
      const key = family(e.name);
      if (seen.has(key)) continue;
      seen.add(key);
      ranked.push(e.emoji);
      if (ranked.length >= count) break;
    }

    const inputTokens = (first.usage?.input_tokens ?? 0) + (second.usage?.input_tokens ?? 0);
    return { emoji: placeFlag(ranked, detectCountry(first), count), inputTokens };
  } catch {
    return MISS;
  }
};
