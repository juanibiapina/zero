import { describe, expect, it, vi } from "vitest";

import { openaiCleanup, openaiSpeechToText, openaiTitleWriter, transcriptionKeywords } from "./openai";

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("OpenAI speech to text", () => {
  it("sends the audio with each keyword as its own field and returns the text", async () => {
    const send = vi.fn<typeof fetch>(async () => reply(200, { text: "Call Ana." }));
    const speechToText = openaiSpeechToText({ apiKey: "key", fetch: send });

    expect(await speechToText.transcribe(new Blob([new Uint8Array(4)]), { keywords: ["Ana", "ZeroVault"] })).toBe("Call Ana.");
    const [url, init] = send.mock.calls[0] ?? [];
    const form = init?.body as FormData;
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(form.get("model")).toBe("gpt-transcribe");
    expect(form.getAll("keywords")).toEqual(["Ana", "ZeroVault"]);
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("throws on an error response", async () => {
    const speechToText = openaiSpeechToText({ apiKey: "key", fetch: async () => reply(500, { error: "x" }) });

    await expect(speechToText.transcribe(new Blob([]), { keywords: [] })).rejects.toThrow("OpenAI transcription failed: 500");
  });
});

describe("OpenAI cleanup", () => {
  it("returns the model's text and asks it to spell the keywords as given", async () => {
    const send = vi.fn<typeof fetch>(async () => reply(200, {
      output: [
        { type: "reasoning", content: [] },
        { type: "message", content: [{ type: "output_text", text: "Call Ana." }] },
      ],
    }));
    const cleanup = openaiCleanup({ apiKey: "key", fetch: send });

    expect(await cleanup.clean("Um, call Ana.", { keywords: ["Ana"] })).toBe("Call Ana.");
    const body = JSON.parse(send.mock.calls[0]?.[1]?.body as string) as { model: string; input: string; instructions: string };
    expect(body.model).toBe("gpt-6-luna");
    expect(body.input).toBe("Um, call Ana.");
    expect(body.instructions).toContain("spell them exactly like this: Ana");
  });

  it("throws on an error response", async () => {
    const cleanup = openaiCleanup({ apiKey: "key", fetch: async () => reply(429, {}) });

    await expect(cleanup.clean("x", { keywords: [] })).rejects.toThrow("OpenAI cleanup failed: 429");
  });
});

describe("OpenAI title writer", () => {
  it("sends the transcript with title instructions and returns the model's text", async () => {
    const send = vi.fn<typeof fetch>(async () => reply(200, {
      output: [{ type: "message", content: [{ type: "output_text", text: "Call Ana" }] }],
    }));
    const writer = openaiTitleWriter({ apiKey: "key", fetch: send });

    expect(await writer.write("Call Ana on Friday.")).toBe("Call Ana");
    const [url, init] = send.mock.calls[0] ?? [];
    const body = JSON.parse(init?.body as string) as { model: string; input: string; instructions: string };
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(body.model).toBe("gpt-6-luna");
    expect(body.input).toBe("Call Ana on Friday.");
    expect(body.instructions).toContain("short title");
  });

  it("throws on an error response", async () => {
    const writer = openaiTitleWriter({ apiKey: "key", fetch: async () => reply(500, {}) });

    await expect(writer.write("x")).rejects.toThrow("OpenAI title failed: 500");
  });
});

describe("transcription keywords", () => {
  it("drops characters the API rejects, blanks, duplicates and overlong terms", () => {
    expect(transcriptionKeywords(["Ana", " <b>Bold</b> ", "two\nlines", "", "Ana", "x".repeat(61)]))
      .toEqual(["Ana", "b Bold /b", "two lines"]);
  });

  it("keeps at most 100 keywords", () => {
    expect(transcriptionKeywords(Array.from({ length: 150 }, (_, index) => `k${index}`))).toHaveLength(100);
  });
});
