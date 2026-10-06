import type {
  Api,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import type { ContentBlock, ThinkingBlock, ToolResultContent } from "../agents/protocol";

// Legacy UserDO rows store Anthropic-shaped content blocks; these turn them
// into pi-ai content for the one-time import into Pi sessions.

export const toResultContent = (
  content: ToolResultContent,
): (TextContent | ImageContent)[] => {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : {
          type: "image",
          data: part.source.data,
          mimeType: part.source.media_type,
        },
  );
};

// A `thinking` block back into pi-ai's shape. OpenAI reasoning is the whole
// reasoning item JSON (what pi-ai `JSON.parse`s and replays verbatim); Anthropic
// reasoning is the opaque signature. A block with neither identity carries no
// replayable reasoning and is dropped (null), matching Zero's own rule.
const toThinkingContent = (block: ThinkingBlock): ThinkingContent | null => {
  if (block.id && block.encrypted_content) {
    return {
      type: "thinking",
      thinking: block.thinking || "",
      thinkingSignature: JSON.stringify({
        type: "reasoning",
        id: block.id,
        summary: [],
        encrypted_content: block.encrypted_content,
      }),
    };
  }
  if (block.signature) {
    return {
      type: "thinking",
      thinking: block.thinking,
      thinkingSignature: block.signature,
    };
  }
  return null;
};

const phaseSignature = (
  phase: "commentary" | "final_answer" | undefined,
): string | undefined =>
  phase ? JSON.stringify({ v: 1, id: "", phase }) : undefined;

export const toAssistantContent = (
  blocks: ContentBlock[],
): (TextContent | ThinkingContent | ToolCall)[] => {
  const out: (TextContent | ThinkingContent | ToolCall)[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      out.push({
        type: "text",
        text: block.text,
        ...(phaseSignature(block.phase)
          ? { textSignature: phaseSignature(block.phase) }
          : {}),
      });
    } else if (block.type === "thinking") {
      const thinking = toThinkingContent(block);
      if (thinking) out.push(thinking);
    } else if (block.type === "redacted_thinking") {
      out.push({
        type: "thinking",
        thinking: "",
        thinkingSignature: block.data,
        redacted: true,
      });
    } else if (block.type === "tool_use") {
      out.push({
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: (block.input ?? {}) as ToolCall["arguments"],
      });
    }
    // Images and tool results never appear in an assistant message.
  }
  return out;
};

// Which wire produced a stored assistant message. pi-ai replays reasoning
// verbatim only when the message's `api` matches the target model's; otherwise
// it converts reasoning to text. Zero infers the source api from the thinking
// block's shape so a provider flip (rollback to claude) drops OpenAI reasoning
// instead of replaying it into the wrong wire.
export const inferApi = (blocks: ContentBlock[], fallback: Api): Api => {
  for (const block of blocks) {
    if (block.type === "thinking") {
      if (block.id && block.encrypted_content) return "openai-responses";
      if (block.signature) return "anthropic-messages";
    }
  }
  return fallback;
};
