import { Lexer, type Token, type Tokens } from "marked";

const isCode = (token: Token): token is Tokens.Code => token.type === "code";
const isList = (token: Token): token is Tokens.List => token.type === "list";

// Finds the Mermaid diagrams in a Prompt's Markdown: the source of every code
// block fenced as `mermaid`, in document order, including blocks nested in
// lists and quotes. The app renders exactly these blocks as diagrams.
export function mermaidDiagrams(markdown: string): string[] {
  const found: string[] = [];
  const visit = (tokens: Token[]) => {
    for (const token of tokens) {
      if (isCode(token) && token.lang?.trim().split(/\s+/)[0] === "mermaid") found.push(token.text);
      if (isList(token)) visit(token.items);
      else if ("tokens" in token && Array.isArray(token.tokens)) visit(token.tokens);
    }
  };
  visit(Lexer.lex(markdown));
  return found;
}
