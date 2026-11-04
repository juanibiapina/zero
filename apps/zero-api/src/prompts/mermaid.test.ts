import { describe, expect, it } from "vitest";

import { checkMermaid } from "./mermaid";

// Transforming Mermaid for the first import takes several seconds.
describe("checkMermaid", { timeout: 60_000 }, () => {
  it("accepts diagrams whose parsers need DOMPurify, without a browser", async () => {
    for (const source of [
      "graph TD; A-->B",
      "classDiagram\nA <|-- B",
      "pie title Pets\n\"Dogs\": 3",
    ]) {
      expect(await checkMermaid(source)).toBeNull();
    }
  });

  it("returns the parser's message for a diagram that does not parse", async () => {
    expect(await checkMermaid("graph TD; A-->")).toMatch(/^Parse error on line 2/);
    expect(await checkMermaid("not a diagram")).toMatch(/No diagram type detected/);
  });
});
