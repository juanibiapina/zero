// Writes a short title for a voice note from its transcript text.
export type Titler = {
  model: string;
  title(text: string): Promise<string>;
};

export const MAX_TITLE_LENGTH = 60;

const QUOTES = /^["'`“”‘’«»„]+|["'`“”‘’«»„]+$/g;

// Turns a model reply into one title line, or "" when nothing usable is left.
export function normalizeTitle(raw: string): string {
  let title = raw.replace(/\s+/g, " ").trim().replace(QUOTES, "").trim().replace(/(?<!\.)\.$/, "").trim();
  if (title.length > MAX_TITLE_LENGTH) {
    const cut = title.slice(0, MAX_TITLE_LENGTH + 1);
    const space = cut.lastIndexOf(" ");
    title = (space > 0 ? cut.slice(0, space) : title.slice(0, MAX_TITLE_LENGTH)).replace(/[\s,;:–—-]+$/, "");
  }
  return title;
}
