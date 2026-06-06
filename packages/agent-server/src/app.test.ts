import { describe, expect, it, vi } from "vitest";

import { createAgentApp, type AgentHandlers, type PromptAttachment } from "./app.js";

const baseHandlers = (): AgentHandlers => ({
  createSession: vi.fn(async () => {}),
  promptSession: vi.fn(async () => true),
  abortSession: vi.fn(async () => "aborted" as const),
  getSessionStatus: vi.fn(async () => ({ model: "m", contextPercent: null })),
  importNotes: vi.fn(async () => 0),
});

const postMessage = (app: ReturnType<typeof createAgentApp>, body: unknown) =>
  app.request("/sessions/sess-1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("message route", () => {
  it("forwards attachments and caption to promptSession", async () => {
    const handlers = baseHandlers();
    const app = createAgentApp(handlers);

    const attachments: PromptAttachment[] = [
      { filename: "a.pdf", mimeType: "application/pdf", dataBase64: "AAAA" },
    ];
    const res = await postMessage(app, { text: "look", attachments });

    expect(res.status).toBe(202);
    expect(handlers.promptSession).toHaveBeenCalledWith("sess-1", "look", attachments);
  });

  it("accepts a caption-less attachment (empty text)", async () => {
    const handlers = baseHandlers();
    const app = createAgentApp(handlers);

    const res = await postMessage(app, {
      attachments: [{ filename: "a.jpg", mimeType: "image/jpeg", dataBase64: "AAAA" }],
    });

    expect(res.status).toBe(202);
    expect(handlers.promptSession).toHaveBeenCalledWith("sess-1", "", [
      { filename: "a.jpg", mimeType: "image/jpeg", dataBase64: "AAAA" },
    ]);
  });

  it("rejects a message with neither text nor attachments", async () => {
    const handlers = baseHandlers();
    const app = createAgentApp(handlers);

    const res = await postMessage(app, { text: "" });

    expect(res.status).toBe(400);
    expect(handlers.promptSession).not.toHaveBeenCalled();
  });

  it("returns 404 when the session is unknown", async () => {
    const handlers = baseHandlers();
    handlers.promptSession = vi.fn(async () => false);
    const app = createAgentApp(handlers);

    const res = await postMessage(app, { text: "hi" });
    expect(res.status).toBe(404);
  });
});
