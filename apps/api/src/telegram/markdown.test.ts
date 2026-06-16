import { describe, it, expect } from "vitest";
import { markdownToTelegramHtml } from "./markdown";

describe("markdownToTelegramHtml", () => {
  it("converts bold text", () => {
    expect(markdownToTelegramHtml("**hello**")).toBe("<b>hello</b>");
  });

  it("converts italic text", () => {
    expect(markdownToTelegramHtml("*hello*")).toBe("<i>hello</i>");
  });

  it("converts inline code", () => {
    expect(markdownToTelegramHtml("`code`")).toBe("<code>code</code>");
  });

  it("converts code blocks with language", () => {
    const result = markdownToTelegramHtml("```js\nconst x = 1;\n```");
    expect(result).toContain("<pre>");
    expect(result).toContain("const x = 1;");
    expect(result).toContain('language-js');
  });

  it("converts code blocks without language", () => {
    const result = markdownToTelegramHtml("```\nplain code\n```");
    expect(result).toContain("<pre>");
    expect(result).toContain("plain code");
  });

  it("converts links", () => {
    expect(markdownToTelegramHtml("[click](https://example.com)")).toBe(
      '<a href="https://example.com">click</a>',
    );
  });

  it("converts h1/h2 headings to bold with spacing", () => {
    const result = markdownToTelegramHtml("# Title");
    expect(result).toContain("<b>Title</b>");
  });

  it("converts h3+ headings to bold", () => {
    const result = markdownToTelegramHtml("### Subtitle");
    expect(result).toContain("<b>Subtitle</b>");
  });

  it("converts unordered lists", () => {
    const result = markdownToTelegramHtml("- item 1\n- item 2");
    expect(result).toContain("• item 1");
    expect(result).toContain("• item 2");
  });

  it("converts ordered lists", () => {
    const result = markdownToTelegramHtml("1. first\n2. second");
    expect(result).toContain("1. first");
    expect(result).toContain("2. second");
  });

  it("converts blockquotes", () => {
    const result = markdownToTelegramHtml("> quoted text");
    expect(result).toContain("<blockquote>");
    expect(result).toContain("quoted text");
  });

  it("converts horizontal rules", () => {
    const result = markdownToTelegramHtml("above\n\n---\n\nbelow");
    expect(result).toContain("———");
  });

  it("converts strikethrough", () => {
    expect(markdownToTelegramHtml("~~deleted~~")).toBe("<s>deleted</s>");
  });

  it("escapes HTML entities in plain text", () => {
    const result = markdownToTelegramHtml("a < b && c > d");
    expect(result).toContain("&lt;");
    expect(result).toContain("&amp;");
    expect(result).toContain("&gt;");
  });

  it("collapses excessive newlines", () => {
    const result = markdownToTelegramHtml("a\n\n\n\n\nb");
    expect(result).not.toContain("\n\n\n");
  });

  it("renders tables as bullet row groups", () => {
    const md = "| Name | Age |\n|------|-----|\n| Alice | 30 |";
    const result = markdownToTelegramHtml(md);
    expect(result).toContain("<b>Alice</b>");
    expect(result).toContain("• Age: 30");
    expect(result).not.toContain("<pre>");
    expect(result).not.toContain("│");
  });

  it("separates table row groups with a blank line", () => {
    const md =
      "| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |";
    const result = markdownToTelegramHtml(md);
    expect(result).toContain("<b>Alice</b>\n• Age: 30\n\n<b>Bob</b>\n• Age: 25");
  });

  it("preserves inline formatting inside table cells", () => {
    const md = "| Name | Note |\n|------|------|\n| Alice | **vip** |";
    const result = markdownToTelegramHtml(md);
    expect(result).toContain("• Note: <b>vip</b>");
  });

  it("renders single-column tables as plain bullets", () => {
    const md = "| Name |\n|------|\n| Alice |\n| Bob |";
    const result = markdownToTelegramHtml(md);
    expect(result).toContain("• Alice");
    expect(result).toContain("• Bob");
    expect(result).not.toContain("<b></b>");
  });

  it("surrounds h3+ headings with blank lines", () => {
    const result = markdownToTelegramHtml("### Section\nbody text");
    expect(result).toBe("<b>Section</b>\n\nbody text");
  });

  it("separates a list from a preceding heading", () => {
    const result = markdownToTelegramHtml("### Section\n\n- one\n- two");
    expect(result).toContain("<b>Section</b>\n\n• one");
    expect(result).not.toContain("\n\n\n");
  });
});
