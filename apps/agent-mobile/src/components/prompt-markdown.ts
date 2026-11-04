import hljs from 'highlight.js/lib/common';
import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  highlight: (code, info) => {
    const language = info.trim().split(/\s+/)[0];
    if (!language || language === 'mermaid' || !hljs.getLanguage(language)) return '';
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  },
});
markdown.linkify.set({ fuzzyLink: false });

export function renderPromptMarkdown(text: string): string {
  return markdown.render(text);
}
