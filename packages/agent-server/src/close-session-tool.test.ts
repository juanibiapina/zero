import { describe, expect, it, vi, afterEach } from "vitest";

import { createCloseSessionTool } from "./close-session-tool.js";

const makeToolResult = (tool: ReturnType<typeof createCloseSessionTool>) =>
  tool.execute("call-1", { message: "Goodbye!" }, undefined, undefined, undefined as never);

const makeTool = () =>
  createCloseSessionTool({
    callbackUrl: "http://zero.worker",
    getSessionId: () => "sess-1",
    getClerkUserId: () => "user-1",
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("close_session_tool", () => {
  it("returns the message from a 200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "Session closed." }), { status: 200 }),
      ),
    );

    const result = await makeToolResult(makeTool());

    expect(result.content).toEqual([
      { type: "text", text: "Session closed." },
    ]);
  });

  it("returns a custom message from a 200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "This session cannot be closed." }), { status: 200 }),
      ),
    );

    const result = await makeToolResult(makeTool());

    expect(result.content).toEqual([
      { type: "text", text: "This session cannot be closed." },
    ]);
  });

  it("returns error text when response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("bad", { status: 500 })),
    );

    const result = await makeToolResult(makeTool());

    expect(result.content).toEqual([
      { type: "text", text: "Close failed: HTTP 500" },
    ]);
  });

  it("returns error text when fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    const result = await makeToolResult(makeTool());

    expect(result.content).toEqual([
      { type: "text", text: "Close failed: network down" },
    ]);
  });
});
