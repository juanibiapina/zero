import { useState } from "react";
import { Brain, MessageSquare, FileText, Wrench, Terminal, AlertTriangle, KeyRound, ChevronRight, ChevronDown } from "lucide-react";
import { Link } from "react-router";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import oneLight from "react-syntax-highlighter/dist/esm/styles/prism/one-light";

SyntaxHighlighter.registerLanguage("json", json);
import type {
  Turn,
  ThinkingBlock,
  TextBlock,
  ToolCallBlock,
  ToolResultBlock,
  ErrorBlock,
} from "@/lib/session-types";

function ThinkingBlockView({ block }: { block: ThinkingBlock }) {
  return (
    <div className="my-1">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <Brain className="h-3 w-3" />
        Thinking
      </div>
      <pre className="mt-1 rounded border bg-muted/30 p-2 text-xs text-muted-foreground whitespace-pre-wrap max-h-[300px] overflow-y-auto">
        {block.text}
      </pre>
    </div>
  );
}

function TextBlockView({ block }: { block: TextBlock }) {
  return (
    <div className="my-1 prose prose-sm dark:prose-invert max-w-none prose-pre:bg-muted prose-pre:text-foreground prose-code:text-foreground">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {block.text}
      </ReactMarkdown>
    </div>
  );
}

/** Max characters for inline summary text */
const SUMMARY_MAX_LENGTH = 120;

/**
 * Try to get parsed args: prefer block.args (from tool_execution_start),
 * fall back to parsing the streamed JSON text.
 */
function getToolArgs(block: ToolCallBlock): Record<string, unknown> | null {
  if (block.args) return block.args;
  if (!block.text) return null;
  try {
    const parsed: unknown = JSON.parse(block.text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // JSON incomplete during streaming — that's fine
  }
  return null;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/**
 * Generate a one-line human-readable summary for a tool call.
 */
function getToolSummary(name: string, args: Record<string, unknown>): string | null {
  switch (name) {
    case "read": {
      const path = typeof args.path === "string" ? args.path : null;
      if (!path) return null;
      const offset = typeof args.offset === "number" ? args.offset : null;
      const limit = typeof args.limit === "number" ? args.limit : null;
      if (offset != null && limit != null) return `${path}:${offset}-${offset + limit - 1}`;
      if (offset != null) return `${path}:${offset}`;
      if (limit != null) return `${path} (first ${limit} lines)`;
      return path;
    }
    case "bash": {
      const cmd = typeof args.command === "string" ? args.command : null;
      return cmd ? truncate(cmd, SUMMARY_MAX_LENGTH) : null;
    }
    case "edit": {
      const path = typeof args.path === "string" ? args.path : null;
      return path ?? null;
    }
    case "write": {
      const path = typeof args.path === "string" ? args.path : null;
      return path ?? null;
    }
    case "grep": {
      const pattern = typeof args.pattern === "string" ? args.pattern : null;
      if (!pattern) return null;
      const path = typeof args.path === "string" ? args.path : null;
      return path ? `"${pattern}" in ${path}` : `"${pattern}"`;
    }
    case "find": {
      const pattern = typeof args.pattern === "string" ? args.pattern : null;
      if (!pattern) return null;
      const path = typeof args.path === "string" ? args.path : null;
      return path ? `"${pattern}" in ${path}` : `"${pattern}"`;
    }
    case "ls": {
      const path = typeof args.path === "string" ? args.path : ".";
      return path;
    }
    default:
      return null;
  }
}

/**
 * Pretty-print JSON with syntax highlighting via react-syntax-highlighter.
 * Falls back to raw text if parsing fails (e.g. during streaming).
 */
function JsonHighlight({ text }: { text: string }) {
  let formatted: string;
  try {
    formatted = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return (
      <pre className="mt-1 rounded bg-muted/30 p-2 text-xs whitespace-pre-wrap max-h-[200px] overflow-y-auto">
        {text}
      </pre>
    );
  }

  return (
    <SyntaxHighlighter
      language="json"
      style={oneLight}
      customStyle={{
        margin: "0.25rem 0 0 0",
        padding: "0.5rem",
        borderRadius: "0.25rem",
        fontSize: "0.75rem",
        maxHeight: "200px",
        overflow: "auto",
      }}
    >
      {formatted}
    </SyntaxHighlighter>
  );
}

function ToolCallBlockView({ block, result }: { block: ToolCallBlock; result?: ToolResultBlock }) {
  const args = getToolArgs(block);
  const summary = args ? getToolSummary(block.name, args) : null;
  const [open, setOpen] = useState(false);

  const hasError = result?.isError ?? false;
  const preview = result ? result.content.slice(0, 200) : "";
  const hasMore = result ? result.content.length > 200 : false;

  return (
    <div
      className={`my-1 rounded border p-2 ${
        hasError ? "border-destructive/30 bg-destructive/5" : "bg-muted/20"
      }`}
    >
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs font-medium text-foreground/80 hover:text-foreground w-full text-left"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <Wrench className="h-3 w-3 shrink-0" />
        <span>{block.name || "tool call"}</span>
        {hasError && <span className="text-destructive text-xs">(error)</span>}
        {summary && (
          <span className="text-muted-foreground font-normal truncate ml-1">
            {summary}
          </span>
        )}
      </button>
      {open ? (
        <div className="mt-1.5 space-y-1.5">
          {block.text && <JsonHighlight text={block.text} />}
          {result && (
            <pre className="text-xs text-muted-foreground whitespace-pre-wrap max-h-[400px] overflow-y-auto border-t pt-1.5">
              {result.content}
            </pre>
          )}
        </div>
      ) : (
        result && preview && (
          <pre className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">
            {preview}
            {hasMore && "…"}
          </pre>
        )
      )}
    </div>
  );
}

function ToolResultBlockView({ block }: { block: ToolResultBlock }) {
  const [open, setOpen] = useState(false);
  const preview = block.content.slice(0, 200);
  const hasMore = block.content.length > 200;
  return (
    <div
      className={`my-1 rounded border p-2 ${
        block.isError ? "border-destructive/30 bg-destructive/5" : "bg-muted/10"
      }`}
    >
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <Terminal className="h-3 w-3" />
        {block.toolName} result
        {block.isError && <span className="text-destructive">(error)</span>}
      </button>
      {open ? (
        <pre className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap max-h-[400px] overflow-y-auto">
          {block.content}
        </pre>
      ) : (
        preview && (
          <pre className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">
            {preview}
            {hasMore && "..."}
          </pre>
        )
      )}
    </div>
  );
}

function ErrorBlockView({ block }: { block: ErrorBlock }) {
  const [showRaw, setShowRaw] = useState(false);
  return (
    <div className="my-1 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
      <div className="flex items-start gap-2">
        {block.isAuthError ? (
          <KeyRound className="h-4 w-4 mt-0.5 text-destructive shrink-0" />
        ) : (
          <AlertTriangle className="h-4 w-4 mt-0.5 text-destructive shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-destructive">
            {block.isAuthError
              ? "Authentication Failed"
              : "Agent Error"}
          </p>
          <p className="text-sm text-destructive/80 mt-0.5">
            {block.friendlyMessage ?? block.message}
          </p>
          {block.isAuthError && (
            <p className="text-xs text-muted-foreground mt-2">
              Your API token has expired.{" "}
              <Link
                to="/settings/providers"
                className="underline hover:text-foreground"
              >
                Reconnect your provider
              </Link>{" "}
              to continue.
            </p>
          )}
          {block.friendlyMessage && (
            <button
              onClick={() => setShowRaw(!showRaw)}
              className="text-xs text-muted-foreground hover:text-foreground mt-1"
            >
              {showRaw ? "Hide" : "Show"} details
            </button>
          )}
          {showRaw && (
            <pre className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto">
              {block.message}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

export function TurnView({ turn }: { turn: Turn }) {
  if (turn.role === "user") {
    return (
      <div className="flex gap-2 py-2">
        <MessageSquare className="h-4 w-4 mt-0.5 text-blue-500 shrink-0" />
        <div className="text-sm">
          {turn.template && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-violet-600 dark:text-violet-400 mb-0.5">
              <FileText className="h-3 w-3" />
              {turn.template.name}
            </span>
          )}
          <div className="font-medium">{turn.text}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="py-2 border-l-2 border-muted pl-3">
      {turn.blocks.map((block, i) => {
        switch (block.kind) {
          case "thinking":
            return <ThinkingBlockView key={i} block={block} />;
          case "text":
            return <TextBlockView key={i} block={block} />;
          case "toolcall": {
            // Merge with adjacent toolresult if names match
            const next = turn.blocks[i + 1];
            const result =
              next?.kind === "toolresult" && next.toolName === block.name
                ? next
                : undefined;
            return <ToolCallBlockView key={i} block={block} result={result} />;
          }
          case "toolresult": {
            // Skip if already merged with the preceding toolcall
            const prev = i > 0 ? turn.blocks[i - 1] : undefined;
            if (prev?.kind === "toolcall" && prev.name === block.toolName) {
              return null;
            }
            return <ToolResultBlockView key={i} block={block} />;
          }
          case "error":
            return <ErrorBlockView key={i} block={block} />;
        }
      })}
    </div>
  );
}
