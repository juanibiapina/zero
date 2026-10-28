import { MAX_TITLE_LENGTH } from "@zero/agent-core";

export type TitleWriter = {
  model: string;
  write(text: string): Promise<string>;
};

// Returns a title for a transcript, or null when the note has no words or the
// writer's answer does not read as a short title.
export type Titler = (text: string) => Promise<string | null>;

const MAX_WORDS = 10;

const countWords = (text: string): number => text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;

export function normalizeTitle(raw: string): string | null {
  const line = raw.split(/\r?\n/).map((part) => part.trim()).find((part) => part !== "") ?? "";
  const title = line
    .replace(/^title:\s*/i, "")
    .replace(/^["'“”‘’«»*]+|["'“”‘’«»*]+$/g, "")
    .replace(/[.。]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = countWords(title);
  if (words === 0 || words > MAX_WORDS || title.length > MAX_TITLE_LENGTH) return null;
  return title;
}

export function createTitler(writer: TitleWriter): Titler {
  return async (text) => {
    if (countWords(text) === 0) return null;
    return normalizeTitle(await writer.write(text));
  };
}
