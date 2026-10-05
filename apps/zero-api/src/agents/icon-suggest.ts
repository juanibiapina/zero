// A deep module over the model seam: two strings in (a project's title and
// optional description), emoji out. One structured `model.generate` call, no
// tools, no conversation. The model is true-external behind the injected
// `AgentModel` port, so the parsing is unit-tested with a mock adapter.
//
// It never throws: any parse failure, an off-model response, or an empty result
// returns `[]`. A missed suggestion loses nothing (the manual picker remains),
// so a soft miss is a valid outcome rather than an error.

import type { AgentModel, TextBlock } from "./protocol";

const DEFAULT_COUNT = 6;

const SYSTEM_PROMPT = [
  "You suggest emoji icons for a personal project.",
  "Given a project's title and optional description, return icons that visually",
  "capture the project at a glance.",
  "",
  "Respond with ONLY a JSON array of single emoji strings, no prose, no code",
  'fence. Example: ["🏃", "📚", "🎯"]. Each element must be exactly one emoji.',
].join("\n");

// Pull the assistant's text out of the response. Only text blocks matter here;
// the model is asked for a bare JSON array.
const responseText = (blocks: { type: string }[]): string =>
  blocks
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

const graphemes = (text: string): string[] =>
  Array.from(
    new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text),
    (s) => s.segment,
  );

// The emoji-ness signals present in every kind of icon we accept: a pictographic
// codepoint (📁, and every ZWJ sequence like 👨‍👩‍👧 contains one), a regional
// indicator (flags, 🇧🇷), or the keycap combining mark (1️⃣). Bare letters and
// digits carry none of these. Kept on the `u` flag (the `v`-flag `\p{RGI_Emoji}`
// needs an es2024 target) — paired with the single-grapheme check below it is
// just as strict.
const EMOJI_SIGNAL = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u;

// A single-emoji string is one grapheme cluster that carries an emoji signal.
// The cluster check keeps ZWJ/flag/keycap emoji whole while rejecting letters,
// bare digits, and any multi-character token.
const isSingleEmoji = (value: string): boolean => {
  if (typeof value !== "string" || value.length === 0) return false;
  return graphemes(value).length === 1 && EMOJI_SIGNAL.test(value);
};

// Parse the model's answer into candidate emoji. Try JSON first; if that is not
// an array of strings, fall back to extracting emoji graphemes from the raw text
// (covers a response wrapped in prose or a code fence).
const parseCandidates = (text: string): string[] => {
  const trimmed = text.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // Not JSON; fall through to grapheme extraction.
  }
  return graphemes(trimmed);
};

export const suggestProjectIcons = async (
  model: AgentModel,
  input: { title: string; description?: string | null },
  opts?: { count?: number },
): Promise<string[]> => {
  const count = opts?.count ?? DEFAULT_COUNT;
  const description = input.description?.trim();
  const userText = description
    ? `Title: ${input.title}\nDescription: ${description}`
    : `Title: ${input.title}`;

  let text: string;
  try {
    const response = await model.generate({
      system: [{ type: "text", text: SYSTEM_PROMPT }],
      messages: [{ role: "user", content: userText }],
      tools: [],
    });
    text = responseText(response.content);
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const icons: string[] = [];
  for (const candidate of parseCandidates(text)) {
    if (!isSingleEmoji(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    icons.push(candidate);
    if (icons.length >= count) break;
  }
  return icons;
};
