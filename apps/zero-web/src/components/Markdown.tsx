// Renders agent-written markdown. Every surface that shows model output should
// go through here so the typography stays consistent.
//
// Raw HTML is deliberately not enabled (no rehype-raw): the input is model
// output, and react-markdown's default of escaping HTML is what keeps it inert.

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({ children }: { children: string }) {
  return (
    // `max-w-none` undoes prose's ~65ch cap, which otherwise leaves a narrow
    // column inside an already-constrained card.
    <div className="prose prose-sm max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
