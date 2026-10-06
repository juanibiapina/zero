import { Type, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import type {
  ConversationId,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import type { AgentTool, AgentToolSet, ToolResultContent } from "../agents/protocol";
import { ExternalCallNotSent } from "../agents/external-call";
import { BACKGROUND } from "./context";

export const UNCERTAIN_EXTERNAL_CALL =
  "This action was already started by an earlier attempt at this turn and its " +
  "outcome was never recorded, so it may or may not have gone through. Do not " +
  "retry it. Tell the user to check Gmail or Calendar to confirm before trying " +
  "again.";

export const UNCERTAIN_SCHEDULE =
  "This schedule was already being created by an earlier attempt and its " +
  "outcome was never recorded. Do not create it again: call list_schedules to " +
  "see whether it exists.";

export type Replay = "safe" | "guarded";

const GUARDED: Readonly<Record<string, string>> = {
  gmail_send: UNCERTAIN_EXTERNAL_CALL,
  gmail_send_draft: UNCERTAIN_EXTERNAL_CALL,
  gmail_draft: UNCERTAIN_EXTERNAL_CALL,
  gmail_save_attachment: UNCERTAIN_EXTERNAL_CALL,
  calendar_create_event: UNCERTAIN_EXTERNAL_CALL,
  drive_upload: UNCERTAIN_EXTERNAL_CALL,
  drive_import: UNCERTAIN_EXTERNAL_CALL,
  drive_create_folder: UNCERTAIN_EXTERNAL_CALL,
  send_file: UNCERTAIN_EXTERNAL_CALL,
  create_schedule: UNCERTAIN_SCHEDULE,
};

export const replayOf = (name: string): Replay =>
  name in GUARDED ? "guarded" : "safe";

type Content = (TextContent | ImageContent)[];

const serializeOutput = (output: unknown): string => {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output) ?? String(output);
  } catch {
    return String(output);
  }
};

export const toPiContent = (content: ToolResultContent): Content =>
  typeof content === "string"
    ? [{ type: "text", text: content }]
    : content.map((block) =>
        block.type === "text"
          ? { type: "text", text: block.text }
          : {
              type: "image",
              data: block.source.data,
              mimeType: block.source.media_type,
            },
      );

const textResult = (text: string, isError = false): ToolExecutionResult => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

const runTool = async (
  name: string,
  tool: AgentTool,
  args: unknown,
): Promise<ToolExecutionResult> => {
  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) {
    return textResult(
      `Invalid input for tool ${name}: ${parsed.error.message}`,
      true,
    );
  }
  const output = await tool.execute(parsed.data);
  if (tool.toContent) {
    const { content, isError } = tool.toContent(output);
    return {
      content: toPiContent(content),
      ...(isError ? { isError: true } : {}),
    };
  }
  return textResult(serializeOutput(output));
};

type StoredResult = { text: string; isError: boolean };

const STARTED = "zero.started";
const RESULT = "zero.result";

const resultText = (result: ToolExecutionResult): string =>
  (result.content ?? [])
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");

const runGuarded = async (
  name: string,
  tool: AgentTool,
  args: unknown,
  api: ToolExecutionApi,
): Promise<ToolExecutionResult> => {
  const uncertain = GUARDED[name] ?? UNCERTAIN_EXTERNAL_CALL;
  const stored = await api.memo<StoredResult>(RESULT, BACKGROUND);
  if (stored) return textResult(stored.text, stored.isError);
  if (await api.memo<boolean>(STARTED, BACKGROUND)) {
    return textResult(uncertain, true);
  }
  await api.memo(STARTED, true, BACKGROUND);
  let result: ToolExecutionResult;
  try {
    result = await runTool(name, tool, args);
  } catch (err) {
    if (!(err instanceof ExternalCallNotSent)) return textResult(uncertain, true);
    result = textResult(err.message, true);
  }
  await api.memo<StoredResult>(
    RESULT,
    { text: resultText(result), isError: result.isError === true },
    BACKGROUND,
  );
  return result;
};

const wireSchema = (schema: AgentTool["inputSchema"]) => {
  const json: Record<string, unknown> = { ...z.toJSONSchema(schema, { io: "input" }) };
  delete json["~standard"];
  delete json.$schema;
  return json;
};

export type ToolsetFor = (conversationId: ConversationId) => Promise<AgentToolSet>;

export const toDurableTools = (
  shape: AgentToolSet,
  toolsetFor: ToolsetFor,
): ToolRegistration[] =>
  Object.entries(shape).map(([name, proto]) => {
    const replay = replayOf(name);
    const registration: ToolRegistration = {
      name,
      description: proto.description,
      parameters: Type.Unsafe(wireSchema(proto.inputSchema)),
      replay: "safe",
      execute: async (args, api) => {
        const tools = await toolsetFor(api.conversationId);
        const tool = tools[name];
        if (!tool) return textResult(`Unknown tool: ${name}`, true);
        if (replay === "guarded") return runGuarded(name, tool, args, api);
        return runTool(name, tool, args);
      },
    };
    return registration;
  });
