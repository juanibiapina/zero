// Mock Anthropic Messages API server.
// Returns a canned non-streaming response matching the beta Messages API
// format the worker's Anthropic SDK client posts and parses.

import { Hono } from "hono";
import { serve } from "@hono/node-server";

const CANNED_TEXT = "Hi there!";

let messageCounter = 0;

// A complete BetaMessage. The `id` matters: the worker threads it into the next
// request's `diagnostics.previous_message_id`, so it must look like a real one.
function buildMessage(text: string): Record<string, unknown> {
  return {
    id: `msg_test_${++messageCounter}`,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5-20250929",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    diagnostics: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

const app = new Hono();

// Mutable response mode, toggled by tests via /test/mode. "rate_limit" makes
// /v1/messages return an HTTP 429 so the worker exercises the rate-limit path.
let mode: "normal" | "rate_limit" = "normal";

app.post("/test/mode", async (c) => {
  const body = await c.req.json<{ mode?: string }>();
  mode = body.mode === "rate_limit" ? "rate_limit" : "normal";
  return c.json({ ok: true, mode });
});

app.delete("/test/mode", (c) => {
  mode = "normal";
  return c.body(null, 204);
});

app.post("/v1/messages", (c) => {
  if (mode === "rate_limit") {
    return new Response(
      JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "rate limited" },
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "retry-after": "1",
          "anthropic-ratelimit-requests-remaining": "0",
        },
      },
    );
  }
  return c.json(buildMessage(CANNED_TEXT));
});

const PORT = Number(process.env.MOCK_ANTHROPIC_PORT ?? 3502);

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Mock Anthropic API listening on :${PORT}`);
});
