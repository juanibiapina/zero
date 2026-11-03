// Checks a Mermaid diagram with Mermaid's own parser, the same one the app
// renders with. Returns the parser's message for a diagram that does not parse,
// or null. Mermaid loads on first use, so only Prompts with diagrams pay for it.
export async function checkMermaid(source: string): Promise<string | null> {
  const { default: mermaid } = await import("mermaid");
  try {
    await mermaid.parse(source);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
