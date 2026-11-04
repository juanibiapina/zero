'use dom';

import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
import { useEffect, useRef, useState } from 'react';

import { renderPromptMarkdown } from '@/components/prompt-markdown';

export type PromptDocumentComment = { id: string; quote: string; text: string };

export type PromptDocumentColors = {
  background: string;
  foreground: string;
  secondary: string;
  muted: string;
  surface: string;
  divider: string;
  accent: string;
  accentSoft: string;
  onAccent: string;
  danger: string;
};

type Props = {
  markdown: string;
  comments: PromptDocumentComment[];
  pendingQuote: string | null;
  canComment: boolean;
  dark: boolean;
  colors: PromptDocumentColors;
  onPassage: (quote: string, top: number) => Promise<void>;
  onRemoveComment: (id: string) => Promise<void>;
  onOpenLink: (url: string) => Promise<void>;
  dom?: import('expo/dom').DOMProps;
};

// The blocks a tap can comment on. A tap picks the innermost one.
const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, th, td, .diagram';
const MAX_QUOTE = 300;

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
const cap = (text: string) => (text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE - 1)}…` : text);

function passageOf(block: Element): string {
  if (block instanceof HTMLElement && block.dataset.source) return cap(block.dataset.source.trim());
  return cap(squash(block.textContent ?? ''));
}

// The innermost block whose text holds the quote: the passage a comment was
// left on. A capped quote matches on the part before its ellipsis.
function anchorOf(root: HTMLElement, quote: string): Element | null {
  const wanted = squash(quote.endsWith('…') ? quote.slice(0, -1) : quote);
  if (!wanted) return null;
  let best: Element | null = null;
  for (const block of root.querySelectorAll(BLOCKS)) {
    const source = block instanceof HTMLElement ? block.dataset.source : undefined;
    const text = squash(source ?? block.textContent ?? '');
    if (text.includes(wanted) && (!best || text.length <= squash(best.textContent ?? '').length)) best = block;
  }
  return best;
}

const SYNTAX = {
  light: { keyword: '#8250df', string: '#1a7f37', number: '#b35900', type: '#0e7490', comment: '#8c959f' },
  dark: { keyword: '#c4a7ff', string: '#7ee2a8', number: '#ffb86b', type: '#67d4e8', comment: '#8a8a8a' },
};

function css(colors: PromptDocumentColors, dark: boolean): string {
  const ink = dark
    ? `color-mix(in srgb, ${colors.accent} 55%, #ffffff)`
    : `color-mix(in srgb, ${colors.accent} 78%, #000000)`;
  const syntax = dark ? SYNTAX.dark : SYNTAX.light;
  return `
    html, body { margin: 0; background: ${colors.background}; }
    body { color: ${colors.foreground}; font: 16px/24px system-ui, -apple-system, Roboto, sans-serif; -webkit-tap-highlight-color: transparent; }
    ::selection { background: color-mix(in srgb, ${colors.accent} 30%, transparent); }
    .doc { padding: 4px 16px 24px; overflow-wrap: anywhere; }
    .doc > :first-child { margin-top: 0; }
    .doc a { color: ${ink}; text-decoration-color: color-mix(in srgb, ${colors.accent} 45%, transparent); text-underline-offset: 2px; }
    .doc strong { font-weight: 650; }
    .doc h1, .doc h2, .doc h3, .doc h4, .doc h5, .doc h6 { margin: 28px 0 10px; }
    .doc h1 { font-size: 24px; line-height: 30px; font-weight: 700; letter-spacing: -0.01em; }
    .doc h2 { font-size: 20px; line-height: 26px; font-weight: 650; color: ${ink}; padding-bottom: 6px; border-bottom: 1px solid ${colors.divider}; }
    .doc h3 { font-size: 17px; line-height: 24px; font-weight: 600; }
    .doc h4, .doc h5, .doc h6 { font-size: 13px; line-height: 18px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: ${colors.secondary}; }
    .doc p, .doc ul, .doc ol, .doc blockquote, .doc pre, .doc table, .doc .diagram { margin: 0 0 14px; }
    .doc ul, .doc ol { padding-left: 22px; }
    .doc li + li { margin-top: 6px; }
    .doc li > ul, .doc li > ol { margin: 6px 0 0; }
    .doc li::marker { color: ${colors.accent}; }
    .doc ol > li::marker { font-weight: 600; font-size: 14px; }
    .doc blockquote { padding: 10px 14px; border-left: 3px solid ${colors.accent}; border-radius: 4px 10px 10px 4px;
      background: color-mix(in srgb, ${colors.accentSoft} 60%, transparent); color: ${colors.secondary}; }
    .doc blockquote > :last-child { margin-bottom: 0; }
    .doc code { font: 14px/20px ui-monospace, 'SF Mono', 'Roboto Mono', monospace; color: ${ink};
      background: ${colors.accentSoft}; border-radius: 5px; padding: 1px 5px; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
    .doc pre { background: ${colors.surface}; border: 1px solid ${colors.divider}; border-radius: 10px; padding: 12px 14px; overflow-x: auto; }
    .doc h1 code, .doc h2 code, .doc h3 code { font-size: 0.85em; }
    .doc pre code { padding: 0; background: none; color: ${colors.foreground}; font-size: 13px; line-height: 20px; }
    .hljs-keyword, .hljs-selector-tag, .hljs-doctag, .hljs-meta .hljs-keyword { color: ${syntax.keyword}; }
    .hljs-string, .hljs-regexp, .hljs-addition, .hljs-template-tag, .hljs-template-variable { color: ${syntax.string}; }
    .hljs-number, .hljs-literal, .hljs-symbol, .hljs-bullet, .hljs-variable.constant_ { color: ${syntax.number}; }
    .hljs-built_in, .hljs-type, .hljs-attr, .hljs-attribute, .hljs-property, .hljs-selector-attr, .hljs-selector-pseudo { color: ${syntax.type}; }
    .hljs-title, .hljs-section, .hljs-name, .hljs-selector-id, .hljs-selector-class { color: ${ink}; }
    .hljs-comment, .hljs-quote, .hljs-meta { color: ${syntax.comment}; font-style: italic; }
    .hljs-deletion { color: ${colors.danger}; }
    .hljs-emphasis { font-style: italic; } .hljs-strong { font-weight: 650; }
    .doc table { border-collapse: separate; border-spacing: 0; display: block; overflow-x: auto; width: max-content; max-width: 100%;
      border: 1px solid ${colors.divider}; border-radius: 10px; font-size: 15px; line-height: 21px; }
    .doc th, .doc td { padding: 8px 10px; text-align: left; border-bottom: 1px solid ${colors.divider}; overflow-wrap: break-word; }
    .doc th { white-space: nowrap; }
    .doc th + th, .doc td + td { border-left: 1px solid ${colors.divider}; }
    .doc tr:last-child td { border-bottom: 0; }
    .doc th { background: ${colors.surface}; font-weight: 600; }
    .doc hr { border: 0; border-top: 1px solid ${colors.divider}; margin: 20px 0; }
    .doc img { max-width: 100%; border-radius: 8px; }
    .diagram { overflow-x: auto; text-align: center; padding: 12px; border: 1px solid ${colors.divider}; border-radius: 10px; }
    .diagram svg { max-width: 100%; height: auto; }
    .diagram-error { color: ${colors.secondary}; font-size: 14px; }
    .commented { background: color-mix(in srgb, ${colors.accentSoft} 70%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, ${colors.accentSoft} 70%, transparent); border-radius: 3px; }
    .pending { background: color-mix(in srgb, ${colors.accent} 18%, transparent); border-radius: 4px; }
    .comment { display: flex; gap: 8px; align-items: flex-start; margin: 4px 0 14px; padding: 8px 10px;
      background: ${colors.accentSoft}; border-left: 3px solid ${colors.accent}; border-radius: 4px 10px 10px 4px; font-size: 15px; line-height: 20px; }
    .doc li > .comment, .doc td > .comment, .doc th > .comment { margin-bottom: 4px; }
    .comment-text { flex: 1; white-space: pre-wrap; }
    .comment-quote { display: block; color: ${colors.secondary}; font-size: 13px; margin-bottom: 2px; }
    .comment-remove { border: 0; background: none; color: ${colors.muted}; font-size: 18px; line-height: 20px; padding: 0 2px; }
    .selection-comment { position: absolute; z-index: 1; border: 0; border-radius: 16px; padding: 6px 14px;
      background: ${colors.accent}; color: ${colors.onAccent}; font: 600 14px system-ui, sans-serif; box-shadow: 0 2px 6px rgb(0 0 0 / 0.25); }
  `;
}

async function renderDiagrams(root: HTMLElement, dark: boolean, colors: PromptDocumentColors) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: {
      darkMode: dark,
      fontFamily: 'system-ui, -apple-system, Roboto, sans-serif',
      background: colors.background,
      primaryColor: colors.accentSoft,
      primaryBorderColor: colors.accent,
      primaryTextColor: colors.foreground,
      secondaryColor: colors.surface,
      tertiaryColor: colors.background,
      lineColor: colors.secondary,
      textColor: colors.foreground,
    },
  });
  const fences = [...root.querySelectorAll('pre > code.language-mermaid')];
  for (const [index, code] of fences.entries()) {
    const source = code.textContent ?? '';
    const diagram = document.createElement('div');
    diagram.className = 'diagram';
    diagram.dataset.source = source;
    code.parentElement!.replaceWith(diagram);
    try {
      const { svg } = await mermaid.render(`diagram-${index}-${Date.now()}`, source);
      diagram.innerHTML = svg;
    } catch {
      const pre = document.createElement('pre');
      pre.textContent = source;
      const note = document.createElement('p');
      note.className = 'diagram-error';
      note.textContent = 'This diagram could not be drawn.';
      diagram.append(note, pre);
    }
  }
}

// Renders a Prompt's Markdown, Mermaid diagrams included, and lets the user pick
// a passage to comment on: tap a block, or select words and tap Comment.
export default function PromptDocument({
  markdown, comments, pendingQuote, canComment, dark, colors, onPassage, onRemoveComment, onOpenLink,
}: Props) {
  const root = useRef<HTMLDivElement>(null);
  const palette = useRef(colors);
  useEffect(() => { palette.current = colors; });
  const [rendered, setRendered] = useState(0);
  const [selection, setSelection] = useState<{ quote: string; at: number; top: number; left: number } | null>(null);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let cancelled = false;
    element.innerHTML = DOMPurify.sanitize(renderPromptMarkdown(markdown));
    void renderDiagrams(element, dark, palette.current).then(() => { if (!cancelled) setRendered((count) => count + 1); });
    setRendered((count) => count + 1);
    return () => { cancelled = true; };
  }, [markdown, dark]);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    element.querySelectorAll('.comment').forEach((bubble) => bubble.remove());
    element.querySelectorAll('.commented, .pending').forEach((block) => block.classList.remove('commented', 'pending'));
    for (const comment of comments) {
      const anchor = anchorOf(element, comment.quote);
      const bubble = document.createElement('div');
      bubble.className = 'comment';
      bubble.dataset.commentId = comment.id;
      const text = document.createElement('span');
      text.className = 'comment-text';
      if (!anchor && comment.quote) {
        const quote = document.createElement('span');
        quote.className = 'comment-quote';
        quote.textContent = `“${comment.quote}”`;
        text.append(quote);
      }
      text.append(comment.text);
      bubble.append(text);
      if (canComment) {
        const remove = document.createElement('button');
        remove.className = 'comment-remove';
        remove.setAttribute('aria-label', 'Remove comment');
        remove.textContent = '×';
        bubble.append(remove);
      }
      if (anchor) {
        anchor.classList.add('commented');
        if (anchor.tagName === 'LI' || anchor.tagName === 'TD' || anchor.tagName === 'TH') anchor.append(bubble);
        else anchor.after(bubble);
      } else {
        element.append(bubble);
      }
    }
    if (pendingQuote) anchorOf(element, pendingQuote)?.classList.add('pending');
  }, [comments, pendingQuote, canComment, rendered]);

  useEffect(() => {
    if (!canComment) return;
    const update = () => {
      const current = document.getSelection();
      const quote = current && !current.isCollapsed ? squash(current.toString()) : '';
      if (!current || !quote || !root.current?.contains(current.anchorNode)) {
        setSelection(null);
        return;
      }
      const rect = current.getRangeAt(0).getBoundingClientRect();
      setSelection({ quote: cap(quote), at: rect.top + window.scrollY, top: rect.bottom + window.scrollY + 12, left: Math.max(12, rect.left + window.scrollX) });
    };
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, [canComment]);

  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    const link = target.closest('a');
    if (link) {
      event.preventDefault();
      if (link.href) void onOpenLink(link.href);
      return;
    }
    if (!canComment) return;
    const remove = target.closest('.comment-remove');
    if (remove) {
      const id = (remove.parentElement as HTMLElement).dataset.commentId;
      if (id) void onRemoveComment(id);
      return;
    }
    if (target.closest('.comment') || !document.getSelection()?.isCollapsed) return;
    const block = target.closest(BLOCKS);
    if (block && root.current?.contains(block)) void onPassage(passageOf(block), block.getBoundingClientRect().top + window.scrollY);
  };

  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <style>{css(colors, dark)}</style>
      <div ref={root} className="doc" onClick={onClick} />
      {selection ? (
        <button
          className="selection-comment"
          style={{ top: selection.top, left: selection.left }}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            void onPassage(selection.quote, selection.at);
            document.getSelection()?.removeAllRanges();
            setSelection(null);
          }}
        >
          Comment
        </button>
      ) : null}
    </div>
  );
}
