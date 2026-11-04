'use dom';

import DOMPurify from 'dompurify';
import { marked } from 'marked';
import mermaid from 'mermaid';
import { useEffect, useRef, useState } from 'react';

export type PromptDocumentComment = { id: string; quote: string; text: string };

export type PromptDocumentColors = {
  background: string;
  foreground: string;
  secondary: string;
  muted: string;
  surface: string;
  divider: string;
  accent: string;
  onAccent: string;
};

type Props = {
  markdown: string;
  comments: PromptDocumentComment[];
  pendingQuote: string | null;
  canComment: boolean;
  dark: boolean;
  colors: PromptDocumentColors;
  onPassage: (quote: string) => Promise<void>;
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

function css(colors: PromptDocumentColors): string {
  return `
    html, body { margin: 0; background: ${colors.background}; }
    body { color: ${colors.foreground}; font: 16px/22px system-ui, -apple-system, Roboto, sans-serif; -webkit-tap-highlight-color: transparent; }
    .doc { padding: 0 20px 24px; overflow-wrap: anywhere; }
    .doc a { color: ${colors.accent}; }
    .doc h1, .doc h2, .doc h3, .doc h4 { line-height: 1.3; margin: 20px 0 8px; }
    .doc h1 { font-size: 22px; } .doc h2 { font-size: 19px; } .doc h3, .doc h4 { font-size: 17px; }
    .doc p, .doc ul, .doc ol, .doc blockquote, .doc pre, .doc table, .doc .diagram { margin: 0 0 12px; }
    .doc ul, .doc ol { padding-left: 22px; }
    .doc li + li { margin-top: 4px; }
    .doc blockquote { padding-left: 12px; border-left: 3px solid ${colors.divider}; color: ${colors.secondary}; }
    .doc code { font: 14px/20px ui-monospace, monospace; background: ${colors.surface}; border-radius: 4px; padding: 1px 4px; }
    .doc pre { background: ${colors.surface}; border-radius: 8px; padding: 12px; overflow-x: auto; }
    .doc pre code { padding: 0; background: none; }
    .doc table { border-collapse: collapse; display: block; overflow-x: auto; }
    .doc th, .doc td { border: 1px solid ${colors.divider}; padding: 6px 8px; text-align: left; }
    .doc hr { border: 0; border-top: 1px solid ${colors.divider}; margin: 16px 0; }
    .doc img { max-width: 100%; }
    .diagram { overflow-x: auto; text-align: center; }
    .diagram svg { max-width: 100%; height: auto; }
    .diagram-error { color: ${colors.secondary}; font-size: 14px; }
    .commented { box-shadow: -8px 0 0 -5px ${colors.accent}; }
    .pending { background: color-mix(in srgb, ${colors.accent} 18%, transparent); border-radius: 4px; }
    .comment { display: flex; gap: 8px; align-items: flex-start; margin: 4px 0 12px; padding: 8px 10px;
      background: ${colors.surface}; border-left: 3px solid ${colors.accent}; border-radius: 6px; font-size: 15px; line-height: 20px; }
    .comment-text { flex: 1; white-space: pre-wrap; }
    .comment-quote { display: block; color: ${colors.secondary}; font-size: 13px; margin-bottom: 2px; }
    .comment-remove { border: 0; background: none; color: ${colors.muted}; font-size: 18px; line-height: 20px; padding: 0 2px; }
    .selection-comment { position: absolute; z-index: 1; border: 0; border-radius: 16px; padding: 6px 14px;
      background: ${colors.accent}; color: ${colors.onAccent}; font: 600 14px system-ui, sans-serif; box-shadow: 0 2px 6px rgb(0 0 0 / 0.25); }
  `;
}

async function renderDiagrams(root: HTMLElement, dark: boolean) {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
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
  const [rendered, setRendered] = useState(0);
  const [selection, setSelection] = useState<{ quote: string; top: number; left: number } | null>(null);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let cancelled = false;
    element.innerHTML = DOMPurify.sanitize(marked.parse(markdown, { async: false, gfm: true }));
    void renderDiagrams(element, dark).then(() => { if (!cancelled) setRendered((count) => count + 1); });
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
      setSelection({ quote: cap(quote), top: rect.bottom + window.scrollY + 12, left: Math.max(12, rect.left + window.scrollX) });
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
    if (block && root.current?.contains(block)) void onPassage(passageOf(block));
  };

  return (
    <div style={{ position: 'relative' }}>
      <style>{css(colors)}</style>
      <div ref={root} className="doc" onClick={onClick} />
      {selection ? (
        <button
          className="selection-comment"
          style={{ top: selection.top, left: selection.left }}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            void onPassage(selection.quote);
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
