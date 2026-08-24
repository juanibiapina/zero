// Mock OpenAI Responses API server.
// Streams a canned Server-Sent-Events response in the shape the worker's LLM
// layer (@earendil-works/pi-ai, which posts `stream: true`) parses, so the e2e
// suite exercises the real adapter and the real wire translation without
// reaching the network.

import { Hono } from "hono";
import { serve } from "@hono/node-server";

const CANNED_TEXT = "Hi there!";

let responseCounter = 0;

// One SSE event: an `event:` line plus a `data:` JSON line, terminated by a
// blank line, which is what the OpenAI SDK's stream parser reads.
function sse(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

// A minimal Responses stream that yields one final-answer text item. pi-ai needs
// `response.created` (for the response id), `response.output_item.done` (the
// message item, which it turns into a text block), and `response.completed`
// (status + usage, which finalize stop reason and token counts).
function buildStream(text: string): string {
  const id = `resp_test_${++responseCounter}`;
  const usage = {
    input_tokens: 10,
    output_tokens: 5,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 15,
  };
  return (
    sse("response.created", { response: { id } }) +
    sse("response.output_item.done", {
      output_index: 0,
      item: {
        id: `msg_test_${responseCounter}`,
        type: "message",
        role: "assistant",
        status: "completed",
        phase: "final_answer",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    }) +
    sse("response.completed", {
      response: { id, status: "completed", incomplete_details: null, output: [], usage },
    })
  );
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
  return new Response(buildStream(CANNED_TEXT), {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

const PORT = Number(process.env.MOCK_OPENAI_PORT ?? 3502);

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Mock OpenAI API listening on :${PORT}`);
});
