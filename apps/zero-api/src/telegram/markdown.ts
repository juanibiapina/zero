import { Marked, type Tokens, type RendererObject } from "marked";

// Telegram supports a limited set of HTML tags:
//   <b>, <i>, <u>, <s>, <code>, <pre>, <a>, <blockquote>, <tg-spoiler>
//
// We use `marked` to parse Markdown into tokens, then render them as
// Telegram-compatible HTML via a custom renderer.

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const renderer: RendererObject = {
  // ── Block-level ──────────────────────────────────────────────────────

  code({ text, lang }: Tokens.Code): string {
    const escaped = esc(text);
    if (lang) {
      return `<pre><code class="language-${esc(lang)}">${escaped}</code></pre>\n`;
    }
    return `<pre>${escaped}</pre>\n`;
  },

  blockquote({ tokens }: Tokens.Blockquote): string {
    const body = this.parser.parse(tokens);
    return `<blockquote>${body.replace(/\n+$/, "")}</blockquote>\n`;
  },

  html({ text }: Tokens.HTML | Tokens.Tag): string {
    return esc(text);
  },

  heading({ tokens }: Tokens.Heading): string {
    const text = this.parser.parseInline(tokens);
    // Surround every heading depth with blank lines so headings never collide
    // with adjacent lists or paragraphs. The trailing \n{3,} collapse keeps
    // this from stacking up.
    return `\n<b>${text}</b>\n\n`;
  },

  hr(): string {
    return "———\n";
  },

  list(token: Tokens.List): string {
    const items = token.items
      .map((item, i) => {
        const bullet = token.ordered
          ? `${token.start !== "" ? Number(token.start) + i : i + 1}. `
          : "• ";
        const body = this.parser.parse(item.tokens);
        return `${bullet}${body.replace(/\n+$/, "")}`;
      })
      .join("\n");
    // Leading blank line separates the list from a preceding heading or
    // paragraph.
    return "\n" + items + "\n\n";
  },

  listitem(item: Tokens.ListItem): string {
    return this.parser.parse(item.tokens);
  },

  checkbox({ checked }: Tokens.Checkbox): string {
    return checked ? "☑ " : "☐ ";
  },

  paragraph({ tokens }: Tokens.Paragraph): string {
    return this.parser.parseInline(tokens) + "\n\n";
  },

  // Flatten a GFM pipe table into per-row bullet groups. A monospace grid
  // overflows on mobile Telegram, so each row becomes a bold heading (the
  // first cell) plus `• Header: value` bullets. Ported from Hermes Agent's
  // _render_table_block_for_telegram (gateway/platforms/telegram.py).
  table(token: Tokens.Table): string {
    const headers = token.header.map((cell) =>
      this.parser.parseInline(cell.tokens),
    );

    const groups = token.rows.map((row) => {
      const cells = row.map((cell) => this.parser.parseInline(cell.tokens));
      const heading = cells[0] || "Row";

      // Single-column tables have no Header: value pairs to emit; fall back to
      // a plain bullet so the cell value is not lost.
      if (headers.length <= 1) {
        return `• ${heading}`;
      }

      const bullets: string[] = [];
      for (let i = 1; i < headers.length; i++) {
        const value = cells[i] ?? "";
        if (value === "" || value === heading) continue;
        bullets.push(`• ${headers[i]}: ${value}`);
      }
      return [`<b>${heading}</b>`, ...bullets].join("\n");
    });

    return "\n" + groups.join("\n\n") + "\n\n";
  },

  tablerow(): string {
    return "";
  },

  tablecell(): string {
    return "";
  },

  space(): string {
    return "";
  },

  def(): string {
    return "";
  },

  // ── Inline-level ─────────────────────────────────────────────────────

  strong({ tokens }: Tokens.Strong): string {
    return `<b>${this.parser.parseInline(tokens)}</b>`;
  },

  em({ tokens }: Tokens.Em): string {
    return `<i>${this.parser.parseInline(tokens)}</i>`;
  },

  codespan({ text }: Tokens.Codespan): string {
    return `<code>${esc(text)}</code>`;
  },

  br(): string {
    return "\n";
  },

  del({ tokens }: Tokens.Del): string {
    return `<s>${this.parser.parseInline(tokens)}</s>`;
  },

  link({ href, tokens }: Tokens.Link): string {
    const text = this.parser.parseInline(tokens);
    return `<a href="${esc(href)}">${text}</a>`;
  },

  image({ href, text }: Tokens.Image): string {
    return `<a href="${esc(href)}">${esc(text || "image")}</a>`;
  },

  text(token: Tokens.Text | Tokens.Escape): string {
    if ("tokens" in token && token.tokens) {
      return this.parser.parseInline(token.tokens);
    }
    return esc(token.text);
  },
};

const marked = new Marked({ renderer });

export function markdownToTelegramHtml(markdown: string): string {
  const result = marked.parse(markdown, { async: false });
  // Collapse more than 2 consecutive newlines and trim
  return result.replace(/\n{3,}/g, "\n\n").trim();
}
