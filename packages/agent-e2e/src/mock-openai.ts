// Mock OpenAI Responses API server.
// Returns a canned non-streaming response in the shape the worker's OpenAI SDK
// client posts to and parses, so the e2e suite exercises the real adapter and
// the real wire translation without reaching the network.

import { Hono } from "hono";
import { serve } from "@hono/node-server";

const CANNED_TEXT = "Hi there!";

let responseCounter = 0;

// A complete Response object, trimmed to the fields the worker reads. The
// `output` array is what the adapter translates back into content blocks, and
// `status: "completed"` with no function_call is what makes it a final answer.
function buildResponse(text: string): Record<string, unknown> {
  return {
    id: `resp_test_${++responseCounter}`,
    object: "response",
    model: "gpt-5.6-luna",
    status: "completed",
    incomplete_details: null,
    output: [
      {
        id: `msg_test_${responseCounter}`,
        type: "message",
        role: "assistant",
        status: "completed",
        phase: "final_answer",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 15,
    },
  };
}

const app = new Hono();

// Mutable response mode, toggled by tests via /test/mode. "rate_limit" makes
// /responses return an HTTP 429 so the worker exercises the rate-limit path.
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

app.post("/responses", (c) => {
  if (mode === "rate_limit") {
    return new Response(
      JSON.stringify({
        error: {
          type: "rate_limit_error",
          code: "rate_limit_exceeded",
          message: "rate limited",
        },
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "retry-after": "1",
          "x-ratelimit-remaining-requests": "0",
        },
      },
    );
  }
  return c.json(buildResponse(CANNED_TEXT));
});

const PORT = Number(process.env.MOCK_OPENAI_PORT ?? 3502);

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Mock OpenAI API listening on :${PORT}`);
});
