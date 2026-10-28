import { describe, expect, it, vi } from "vitest";

import { createTranscriber, type Cleanup, type SpeechToText } from "./transcriber";

const NOW = new Date("2026-10-20T18:31:00.000Z");
const audio = new Blob([new Uint8Array(10)]);
const hints = { keywords: ["Ana"] };

const hearing = (text: string): SpeechToText => ({ model: "stt", transcribe: vi.fn(async () => text) });
const cleaning = (text: string): Cleanup => ({ model: "cleanup", clean: vi.fn(async () => text) });

const transcribe = (speechToText: SpeechToText, cleanup: Cleanup) =>
  createTranscriber({ speechToText, cleanup, now: () => NOW })(audio, hints);

describe("transcriber", () => {
  it("keeps the verbatim words and the cleaned text, naming both models", async () => {
    const heard = vi.fn(async () => "Um, call Ana on Thursday, no, Friday.");
    const cleaned = vi.fn(async () => "Call Ana on Friday.");

    expect(await transcribe({ model: "stt", transcribe: heard }, { model: "cleanup", clean: cleaned })).toEqual({
      text: "Call Ana on Friday.",
      verbatim: "Um, call Ana on Thursday, no, Friday.",
      model: "stt+cleanup",
      transcribedAt: NOW.toISOString(),
    });
    expect(heard).toHaveBeenCalledWith(audio, hints);
    expect(cleaned).toHaveBeenCalledWith("Um, call Ana on Thursday, no, Friday.", hints);
  });

  it("gives no text for a note with no speech, without asking for a cleanup", async () => {
    const clean = vi.fn(async () => "Thanks for watching!");

    expect(await transcribe(hearing("  "), { model: "cleanup", clean })).toMatchObject({ text: "", verbatim: "", model: "stt" });
    expect(clean).not.toHaveBeenCalled();
  });

  it("falls back to the verbatim words when the cleanup adds content", async () => {
    const result = await transcribe(hearing("Buy milk."), cleaning("Sure! Here is your note: buy milk, eggs, bread and butter today."));

    expect(result).toMatchObject({ text: "Buy milk.", model: "stt" });
  });

  it("falls back to the verbatim words when the cleanup drops most of a long note", async () => {
    const long = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");

    expect(await transcribe(hearing(long), cleaning("A short summary."))).toMatchObject({ text: long, model: "stt" });
  });

  it("falls back to the verbatim words when the cleanup returns nothing", async () => {
    expect(await transcribe(hearing("Call the plumber."), cleaning(""))).toMatchObject({ text: "Call the plumber." });
  });

  it("lets a short note lose most of its words to fillers", async () => {
    const result = await transcribe(hearing("Um, uh, so, yeah, okay, milk."), cleaning("Milk."));

    expect(result).toMatchObject({ text: "Milk.", model: "stt+cleanup" });
  });

  it("fails when either step fails, so the phone can try again", async () => {
    const broken: SpeechToText = { model: "stt", transcribe: async () => { throw new Error("down"); } };
    await expect(transcribe(broken, cleaning("x"))).rejects.toThrow("down");

    const brokenCleanup: Cleanup = { model: "cleanup", clean: async () => { throw new Error("down"); } };
    await expect(transcribe(hearing("Call the plumber."), brokenCleanup)).rejects.toThrow("down");
  });
});
