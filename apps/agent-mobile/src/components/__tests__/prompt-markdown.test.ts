import { describe, expect, it } from '@jest/globals';

import { renderPromptMarkdown } from '@/components/prompt-markdown';

describe('renderPromptMarkdown', () => {
  it('renders bold that wraps inline code or ends in punctuation', () => {
    const html = renderPromptMarkdown('1. **The skill should document `but merge`.** In 117 sessions\n2. **Fix:** pipe less');
    expect(html).toContain('<strong>The skill should document <code>but merge</code>.</strong>');
    expect(html).toContain('<strong>Fix:</strong>');
    expect(html).not.toContain('**');
  });

  it('highlights code blocks and leaves diagrams for Mermaid', () => {
    const html = renderPromptMarkdown('```ts\nconst a = "x";\n```\n\n```mermaid\nflowchart LR\n  A --> B\n```');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).toContain('<pre><code class="language-mermaid">flowchart LR\n  A --&gt; B\n</code></pre>');
  });

  it('links full URLs and leaves file names as text', () => {
    const html = renderPromptMarkdown('See https://zeroapps.dev and CHANGELOG.md');
    expect(html).toContain('<a href="https://zeroapps.dev">https://zeroapps.dev</a>');
    expect(html).toContain('and CHANGELOG.md</p>');
  });

  it('renders tables and escapes raw HTML', () => {
    const html = renderPromptMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>');
    expect(html).toContain('<table>');
    expect(html).toContain('&lt;script&gt;');
  });
});
