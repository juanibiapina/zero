import { useState } from "react";
import { Brain, MessageSquare, Wrench, Terminal, AlertTriangle, KeyRound } from "lucide-react";
import { Link } from "react-router";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  Turn,
  ThinkingBlock,
  TextBlock,
  ToolCallBlock,
  ToolResultBlock,
  ErrorBlock,
} from "@/lib/session-types";

function ThinkingBlockView({ block }: { block: ThinkingBlock }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <Brain className="h-3 w-3" />
        {open ? "Hide" : "Show"} thinking
        {!open && block.text.length > 0 && (
          <span className="ml-1 text-muted-foreground/60">({block.text.length} chars)</span>
        )}
      </button>
      {open && (
        <pre className="mt-1 rounded border bg-muted/30 p-2 text-xs text-muted-foreground whitespace-pre-wrap max-h-[300px] overflow-y-auto">
          {block.text}
        </pre>
      )}
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

function ToolCallBlockView({ block }: { block: ToolCallBlock }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1 rounded border bg-muted/20 p-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs font-medium text-foreground/80 hover:text-foreground"
      >
        <Wrench className="h-3 w-3" />
        {block.name || "tool call"}
      </button>
      {open && block.text && (
        <pre className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap max-h-[200px] overflow-y-auto">
          {block.text}
        </pre>
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
        <div className="text-sm font-medium">{turn.text}</div>
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
          case "toolcall":
            return <ToolCallBlockView key={i} block={block} />;
          case "toolresult":
            return <ToolResultBlockView key={i} block={block} />;
          case "error":
            return <ErrorBlockView key={i} block={block} />;
        }
      })}
    </div>
  );
}
