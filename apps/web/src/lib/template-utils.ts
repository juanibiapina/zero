import type { PromptTemplate } from "@zero/core";

/**
 * Parse a slash command from user input.
 * Returns the matched slug and the remaining arguments, or null if no match.
 *
 * Examples:
 *   "/plan look at the backlog" → { slug: "plan", args: "look at the backlog" }
 *   "/plan"                     → { slug: "plan", args: "" }
 *   "fix the tests"             → null
 */
export function parseSlashCommand(
  input: string
): { slug: string; args: string } | null {
  const match = input.match(/^\/(\S+)(?:\s([\s\S]*))?$/);
  if (!match) return null;
  return { slug: match[1], args: (match[2] ?? "").trim() };
}

/**
 * Expand a template by replacing $ARGUMENTS and $@ with the provided args.
 */
export function expandTemplate(content: string, args: string): string {
  return content.replace(/\$ARGUMENTS|\$@/g, args);
}

/**
 * Returns the filtered templates for the current input, or empty array if no slash command.
 * Used to reset autocomplete selection when the list changes.
 */
export function getSlashFilteredTemplates(
  input: string,
  templates: PromptTemplate[]
): PromptTemplate[] {
  const slashMatch = input.match(/^\/(\S*)$/);
  if (!slashMatch || templates.length === 0) return [];
  const partial = slashMatch[1];
  return templates.filter(
    (t) =>
      t.slug.startsWith(partial) ||
      t.name.toLowerCase().startsWith(partial.toLowerCase())
  );
}

/**
 * Resolve a slash command against a template list.
 * Returns the expanded text and template metadata, or null if no template matched.
 */
export function resolveSlashCommand(
  input: string,
  templates: PromptTemplate[]
): {
  expandedText: string;
  originalText: string;
  template: { slug: string; name: string };
} | null {
  const parsed = parseSlashCommand(input);
  if (!parsed) return null;

  const template = templates.find((t) => t.slug === parsed.slug);
  if (!template) return null;

  return {
    expandedText: expandTemplate(template.content, parsed.args),
    originalText: parsed.args,
    template: { slug: template.slug, name: template.name },
  };
}
