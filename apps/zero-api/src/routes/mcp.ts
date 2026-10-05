import {
  authServerMetadataHandlerClerk,
  mcpAuth,
  protectedResourceHandlerClerk,
  streamableHttpHandler,
} from "@clerk/mcp-tools/hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { todoOperations, type OperationOutcome } from "@zero/agent-core/operations";
import { Hono, type MiddlewareHandler } from "hono";

import { clerkClient } from "../clerk";
import { localDayInZone } from "../dates";
import { log } from "../log";
import { getTaskDO } from "../TaskDO/stub";
import { DEFAULT_TIMEZONE } from "../timezone";
import type { Env } from "../types";
import { getUserDO } from "../UserDO/stub";

export type ResolveToday = (env: Env, userId: string) => Promise<string>;

const userToday: ResolveToday = async (env, userId) => {
  const { timezone } = await getUserDO(env, userId).getSettings();
  return localDayInZone(new Date(), timezone ?? DEFAULT_TIMEZONE);
};

const INSTRUCTIONS =
  "Zero's todo workspace for the signed-in user: Tasks, Projects, Waiting conditions, Afters, and Medicines. " +
  "Changes sync to the user's phone and web app immediately. Medicines are read-only here; the user changes them in the Zero app. " +
  "Read with the *_list tools before changing anything, " +
  "and refer to items by the ids they return. Dates are YYYY-MM-DD in the user's local calendar.";

function toolResult(outcome: OperationOutcome) {
  if (!outcome.ok) return { isError: true, content: [{ type: "text" as const, text: outcome.error }] };
  const text = JSON.stringify(outcome.value ?? null);
  const structured = outcome.value && typeof outcome.value === "object" && !Array.isArray(outcome.value)
    ? { structuredContent: outcome.value as Record<string, unknown> }
    : {};
  return { content: [{ type: "text" as const, text }], ...structured };
}

function createTodoMcpServer(env: Env, userId: string, resolveToday: ResolveToday): McpServer {
  const server = new McpServer({ name: "zero-todo", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  for (const operation of todoOperations) {
    server.registerTool(operation.name, {
      title: operation.title,
      description: operation.description,
      inputSchema: operation.input,
      annotations: {
        title: operation.title,
        readOnlyHint: operation.kind === "read",
        destructiveHint: operation.kind === "destructive",
        idempotentHint: operation.kind === "read",
        openWorldHint: false,
      },
    }, async (input) => {
      const today = await resolveToday(env, userId);
      const outcome = await getTaskDO(env, userId).runOperation(operation.name, input, today);
      log("mcp_tool_called", { clerk_user_id: userId, tool: operation.name, ok: outcome.ok });
      return toolResult(outcome);
    });
  }
  return server;
}

const testAuth = mcpAuth(async (token) => ({ token, clientId: "test", scopes: [], extra: { userId: token } }));

const oauthAuth = mcpAuth(async (token, c) => {
  const env = c.env as Env;
  const state = await clerkClient(env).authenticateRequest(c.req.raw, { acceptsToken: "oauth_token" });
  const auth = state.toAuth();
  if (!auth?.isAuthenticated || auth.tokenType !== "oauth_token" || !auth.userId) return undefined;
  return { token, clientId: auth.clientId, scopes: auth.scopes, extra: { userId: auth.userId } };
});

const authenticate: MiddlewareHandler<{ Bindings: Env }> = async (c, next) =>
  c.env.ENVIRONMENT === "test" ? testAuth(c, next) : oauthAuth(c, next);

export const createMcpRoutes = ({ resolveToday = userToday }: { resolveToday?: ResolveToday } = {}) => {
  const router = new Hono<{ Bindings: Env }>();
  const resourceMetadata = protectedResourceHandlerClerk({ scopes_supported: ["profile", "email"] });

  router.get("/.well-known/oauth-protected-resource/mcp", resourceMetadata);
  router.get("/.well-known/oauth-protected-resource", resourceMetadata);
  router.get("/.well-known/oauth-authorization-server", authServerMetadataHandlerClerk);

  router.on(["GET", "DELETE"], "/mcp", (c) => c.json({ error: "Method not allowed" }, 405, { Allow: "POST" }));
  router.post("/mcp", authenticate, (c) => {
    const userId = c.get("mcpAuth").extra?.userId;
    if (typeof userId !== "string" || !userId) return c.json({ error: "Unauthorized" }, 401);
    return streamableHttpHandler(() => createTodoMcpServer(c.env, userId, resolveToday))(c);
  });

  return router;
};
