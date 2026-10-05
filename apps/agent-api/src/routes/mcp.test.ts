import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { todoOperations } from "@zero/agent-core/operations";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import type { Env } from "../types";
import { createMcpRoutes } from "./mcp";
import { taskDoEnv } from "./taskdo-test-stub";

function buildApp(methods: object) {
  const env = { ...taskDoEnv(methods), ENVIRONMENT: "test" } as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.route("/", createMcpRoutes({ resolveToday: async () => "2026-03-10" }));
  return async (input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(input, init), env);
}

async function connect(fetch: ReturnType<typeof buildApp>, userId = "user-abc") {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch,
    requestInit: { headers: { Authorization: `Bearer ${userId}` } },
  }));
  return client;
}

describe("todo MCP server", () => {
  it("asks an unauthenticated client to sign in through the protected resource metadata", async () => {
    const response = await buildApp({})("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate"))
      .toBe("Bearer resource_metadata=http://localhost/.well-known/oauth-protected-resource/mcp");
  });

  it("lists one tool per catalog operation with its safety hints", async () => {
    const client = await connect(buildApp({}));
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(todoOperations.map((operation) => operation.name).sort());
    const deleteProject = tools.find((tool) => tool.name === "projects_delete");
    expect(deleteProject?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(tools.find((tool) => tool.name === "tasks_list")?.annotations).toMatchObject({ readOnlyHint: true });
  });

  it("runs a tool in the caller's TaskDO with the user's today", async () => {
    const runOperation = vi.fn(async () => ({ ok: true, changed: true, value: { id: "t1", text: "Buy milk" } }));
    const client = await connect(buildApp({ runOperation }), "user-xyz");

    const result = await client.callTool({ name: "tasks_create", arguments: { text: "Buy milk" } });

    expect(runOperation).toHaveBeenCalledWith("tasks_create", { text: "Buy milk" }, "2026-03-10");
    expect(result.structuredContent).toEqual({ id: "t1", text: "Buy milk" });
    expect(result.isError).toBeFalsy();
  });

  it("returns a model conflict as a tool error", async () => {
    const client = await connect(buildApp({ runOperation: async () => ({ ok: false, error: "missing-project" }) }));
    const result = await client.callTool({ name: "tasks_create", arguments: { text: "x", projectId: "gone" } });
    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "missing-project" }] });
  });

  it("answers GET with 405 because the server is stateless", async () => {
    const response = await buildApp({})("http://localhost/mcp", { headers: { Authorization: "Bearer user-abc" } });
    expect(response.status).toBe(405);
  });
});
