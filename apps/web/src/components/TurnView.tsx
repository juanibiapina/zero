import { useState } from "react";
import {
  MessageSquare,
  FileText,
  Wrench,
  AlertTriangle,
  KeyRound,
  ChevronRight,
  ChevronDown,
  Loader2,
} from "lucide-react";
import { Link } from "react-router";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import oneLight from "react-syntax-highlighter/dist/esm/styles/prism/one-light";

SyntaxHighlighter.registerLanguage("json", json);

import type {
  AgentAssistantMessage,
  AgentTextContent,
  AgentThinkingContent,
  AgentToolCall,
} from "@zero/core";
import type { DisplayMessage, UserMessageDisplay, AgentToolResultMessage } from "@/lib/session-types";

// ─── Shared Helpers ──────────────────────────────────────────────────────────

const SUMMARY_MAX_LENGTH = 120;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/**
 * Generate a one-line human-readable summary for a tool call.
 */
function getToolSummary(
  name: string,
  args: Record<string, unknown>,
): string | null {
  switch (name) {
    case "read": {
      const path = typeof args.path === "string" ? args.path : null;
      if (!path) return null;
      const offset = typeof args.offset === "number" ? args.offset : null;
      const limit = typeof args.limit === "number" ? args.limit : null;
      if (offset != null && limit != null)
        return `${path}:${offset}-${offset + limit - 1}`;
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
 * Pretty-print JSON with syntax highlighting.
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

// ─── Content Block Views ─────────────────────────────────────────────────────

function ThinkingBlockView({ block }: { block: AgentThinkingContent }) {
  return (
    <div className="my-1">
      <pre className="rounded border bg-muted/30 p-2 text-xs text-muted-foreground whitespace-pre-wrap max-h-[300px] overflow-y-auto">
        {block.thinking}
      </pre>
    </div>
  );
}

function TextBlockView({ block }: { block: AgentTextContent }) {
  return (
    <div className="my-1 prose prose-sm dark:prose-invert max-w-none prose-pre:bg-muted prose-pre:text-foreground prose-code:text-foreground">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.text}</ReactMarkdown>
    </div>
  );
}

// ─── Tool Call View ──────────────────────────────────────────────────────────

/**
 * Extract text content from a tool result message.
 */
function extractToolResultText(result: AgentToolResultMessage): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => (c).text)
    .join("\n");
}

function ToolCallView({
  toolCall,
  result,
  pending,
}: {
  toolCall: AgentToolCall;
  result?: AgentToolResultMessage;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);

  const args = toolCall.arguments;
  const summary = getToolSummary(toolCall.name, args);

  const hasError = result?.isError ?? false;
  const resultText = result ? extractToolResultText(result) : "";
  const preview = resultText.slice(0, 200);
  const hasMore = resultText.length > 200;

  return (
    <div
      className={`my-1 rounded border p-2 ${
        hasError
          ? "border-destructive/30 bg-destructive/5"
          : "bg-muted/20"
      }`}
    >
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs font-medium text-foreground/80 hover:text-foreground w-full text-left"
      >
        {pending ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        ) : open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <Wrench className="h-3 w-3 shrink-0" />
        <span>{toolCall.name}</span>
        {hasError && (
          <span className="text-destructive text-xs">(error)</span>
        )}
        {summary && (
          <span className="text-muted-foreground font-normal truncate ml-1">
            {summary}
          </span>
        )}
      </button>
      {open ? (
        <div className="mt-1.5 space-y-1.5">
          <JsonHighlight text={JSON.stringify(args)} />
          {resultText && (
            <pre className="text-xs text-muted-foreground whitespace-pre-wrap max-h-[400px] overflow-y-auto border-t pt-1.5">
              {resultText}
            </pre>
          )}
          {pending && !resultText && (
            <div className="text-xs text-muted-foreground italic">
              Running…
            </div>
          )}
        </div>
      ) : (
        !pending &&
        result &&
        preview && (
          <pre className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">
            {preview}
            {hasMore && "…"}
          </pre>
        )
      )}
    </div>
  );
}

// ─── Error View ──────────────────────────────────────────────────────────────

interface ParsedError {
  friendlyMessage?: string;
  isAuthError: boolean;
}

function parseErrorMessage(raw: string): ParsedError {
  const spaceIdx = raw.indexOf(" ");
  if (spaceIdx > 0) {
    const jsonPart = raw.slice(spaceIdx + 1);
    try {
      const parsed = JSON.parse(jsonPart) as {
        error?: { type?: string; message?: string };
      };
      return {
        friendlyMessage: parsed?.error?.message ?? undefined,
        isAuthError: parsed?.error?.type === "authentication_error",
      };
    } catch {
      // Not JSON
    }
  }
  return { isAuthError: false };
}

function ErrorView({ errorMessage }: { errorMessage: string }) {
  const [showRaw, setShowRaw] = useState(false);
  const parsed = parseErrorMessage(errorMessage);

  return (
    <div className="my-1 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
      <div className="flex items-start gap-2">
        {parsed.isAuthError ? (
          <KeyRound className="h-4 w-4 mt-0.5 text-destructive shrink-0" />
        ) : (
          <AlertTriangle className="h-4 w-4 mt-0.5 text-destructive shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-destructive">
            {parsed.isAuthError ? "Authentication Failed" : "Agent Error"}
          </p>
          <p className="text-sm text-destructive/80 mt-0.5">
            {parsed.friendlyMessage ?? errorMessage}
          </p>
          {parsed.isAuthError && (
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
          {parsed.friendlyMessage && (
            <button
              onClick={() => setShowRaw(!showRaw)}
              className="text-xs text-muted-foreground hover:text-foreground mt-1"
            >
              {showRaw ? "Hide" : "Show"} details
            </button>
          )}
          {showRaw && (
            <pre className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto">
              {errorMessage}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── User Message View ───────────────────────────────────────────────────────

function UserMessageView({ message }: { message: UserMessageDisplay }) {
  return (
    <div className="flex gap-2 py-2">
      <MessageSquare className="h-4 w-4 mt-0.5 text-blue-500 shrink-0" />
      <div className="text-sm">
        {message.template && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-violet-600 dark:text-violet-400 mb-0.5">
            <FileText className="h-3 w-3" />
            {message.template.name}
          </span>
        )}
        <div className="font-medium">{message.text}</div>
      </div>
    </div>
  );
}

// ─── Assistant Message View ──────────────────────────────────────────────────

function AssistantMessageView({
  message,
  toolResultsById,
  pendingToolCalls,
  isStreaming,
}: {
  message: AgentAssistantMessage;
  toolResultsById: Map<string, AgentToolResultMessage>;
  pendingToolCalls: Set<string>;
  isStreaming?: boolean;
}) {
  return (
    <div className="py-2 border-l-2 border-muted pl-3">
      {message.content.map((block, i) => {
        switch (block.type) {
          case "thinking":
            return block.thinking.trim() ? (
              <ThinkingBlockView key={i} block={block} />
            ) : null;
          case "text":
            return block.text.trim() ? (
              <TextBlockView key={i} block={block} />
            ) : null;
          case "toolCall": {
            const result = toolResultsById.get(block.id);
            const pending = pendingToolCalls.has(block.id);
            return (
              <ToolCallView
                key={i}
                toolCall={block}
                result={result}
                pending={pending}
              />
            );
          }
        }
      })}
      {isStreaming && (
        <div className="flex items-center gap-2 text-muted-foreground mt-1">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span className="text-xs">Generating…</span>
        </div>
      )}
      {message.errorMessage && (
        <ErrorView errorMessage={message.errorMessage} />
      )}
    </div>
  );
}

// ─── Public Components ───────────────────────────────────────────────────────

/**
 * Render a single display message.
 * ToolResult messages are skipped — they're rendered inline in AssistantMessageView.
 */
export function MessageView({
  message,
  toolResultsById,
  pendingToolCalls,
}: {
  message: DisplayMessage;
  toolResultsById: Map<string, AgentToolResultMessage>;
  pendingToolCalls: Set<string>;
}) {
  if (message.role === "user") {
    return <UserMessageView message={message} />;
  }
  if (message.role === "assistant") {
    return (
      <AssistantMessageView
        message={message}
        toolResultsById={toolResultsById}
        pendingToolCalls={pendingToolCalls}
      />
    );
  }
  // toolResult messages are rendered inline via AssistantMessageView
  return null;
}

/**
 * Render the currently-streaming assistant message.
 */
export function StreamingMessageView({
  message,
  toolResultsById,
  pendingToolCalls,
}: {
  message: AgentAssistantMessage;
  toolResultsById: Map<string, AgentToolResultMessage>;
  pendingToolCalls: Set<string>;
}) {
  return (
    <AssistantMessageView
      message={message}
      toolResultsById={toolResultsById}
      pendingToolCalls={pendingToolCalls}
      isStreaming
    />
  );
}


