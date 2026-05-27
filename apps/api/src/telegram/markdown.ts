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

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
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

  heading({ tokens, depth }: Tokens.Heading): string {
    const text = this.parser.parseInline(tokens);
    if (depth <= 2) {
      return `\n<b>${text}</b>\n\n`;
    }
    return `<b>${text}</b>\n`;
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
    return items + "\n";
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

  table(token: Tokens.Table): string {
    const cols = token.header.length;

    const widths: number[] = [];
    for (let c = 0; c < cols; c++) {
      let max = stripTags(
        this.parser.parseInline(token.header[c].tokens),
      ).length;
      for (const row of token.rows) {
        const cellLen = stripTags(
          this.parser.parseInline(row[c].tokens),
        ).length;
        if (cellLen > max) max = cellLen;
      }
      widths.push(max);
    }

    const pad = (text: string, width: number): string => {
      const len = text.length;
      return len >= width ? text : text + " ".repeat(width - len);
    };

    const headerCells = token.header.map((cell, i) =>
      pad(stripTags(this.parser.parseInline(cell.tokens)), widths[i]),
    );
    const separator = widths.map((w) => "─".repeat(w));
    const bodyRows = token.rows.map((row) =>
      row.map((cell, i) =>
        pad(stripTags(this.parser.parseInline(cell.tokens)), widths[i]),
      ),
    );

    const lines = [
      headerCells.join(" │ "),
      separator.join("─┼─"),
      ...bodyRows.map((r) => r.join(" │ ")),
    ];

    return `<pre>${esc(lines.join("\n"))}</pre>\n`;
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
