// Wiki-link helpers for topic bodies. A link is a topic's exact name wrapped in
// double brackets, Obsidian-style: `[[Topic Name]]`. These pure functions are
// the single source of truth for parsing and rewriting links; both Store
// adapters use them to keep the topic_links rows in sync with body text.

// Matches a `[[...]]` token. The inner group forbids brackets so nesting and
// unterminated tokens do not match.
const LINK_RE = /\[\[([^[\]]+)\]\]/g;

// Distinct target names referenced by `[[Name]]` tokens in `text`, trimmed.
// Order follows first appearance.
export const extractLinks = (text: string): string[] => {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(LINK_RE)) {
    const name = match[1].trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
};

// Replace every `[[oldName]]` token with `[[newName]]`, matching the whole name
// exactly (a link to `[[Japan]]` is untouched when renaming `Japan Trip`).
// Non-link text is left alone.
export const rewriteLinks = (
  text: string,
  oldName: string,
  newName: string,
): string =>
  text.replace(LINK_RE, (whole, inner: string) =>
    inner.trim() === oldName ? `[[${newName}]]` : whole,
  );
