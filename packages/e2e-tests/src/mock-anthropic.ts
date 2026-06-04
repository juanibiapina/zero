// Mock Anthropic Messages API server.
// Returns a canned streaming SSE response matching the Anthropic Messages API format.

import { Hono } from "hono";
import { serve } from "@hono/node-server";

const CANNED_TEXT = "Hi there!";

function buildSSE(text: string): string {
  const events = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-sonnet-4-5-20250929",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
    },
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 },
      },
    },
    {
      event: "message_stop",
      data: { type: "message_stop" },
    },
  ];

  return events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n`)
    .join("\n");
}

const app = new Hono();

app.post("/v1/messages", (c) => {
  const body = buildSSE(CANNED_TEXT);
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

const PORT = Number(process.env.MOCK_ANTHROPIC_PORT ?? 3502);

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Mock Anthropic API listening on :${PORT}`);
});
