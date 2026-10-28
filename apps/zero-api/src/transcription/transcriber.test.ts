import { describe, expect, it, vi } from "vitest";

import { createTranscriber, type Cleanup, type SpeechToText, type Titler } from "./transcriber";

const NOW = new Date("2026-10-20T18:31:00.000Z");
const audio = new Blob([new Uint8Array(10)]);
const hints = { keywords: ["Ana"] };

const hearing = (text: string): SpeechToText => ({ model: "stt", transcribe: vi.fn(async () => text) });
const cleaning = (text: string): Cleanup => ({ model: "cleanup", clean: vi.fn(async () => text) });
const titling = (title: string): Titler => ({ title: vi.fn(async () => title) });

const transcribe = (speechToText: SpeechToText, cleanup: Cleanup, titler: Titler = titling("A note")) =>
  createTranscriber({ speechToText, cleanup, titler, now: () => NOW })(audio, hints);

describe("transcriber", () => {
  it("keeps the verbatim words, the cleaned text and its title, naming both text models", async () => {
    const heard = vi.fn(async () => "Um, call Ana on Thursday, no, Friday.");
    const cleaned = vi.fn(async () => "Call Ana on Friday.");
    const titled = vi.fn(async () => "  Call Ana\n on   Friday \n");

    expect(await transcribe({ model: "stt", transcribe: heard }, { model: "cleanup", clean: cleaned }, { title: titled })).toEqual({
      text: "Call Ana on Friday.",
      verbatim: "Um, call Ana on Thursday, no, Friday.",
      title: "Call Ana on Friday",
      model: "stt+cleanup",
      transcribedAt: NOW.toISOString(),
    });
    expect(heard).toHaveBeenCalledWith(audio, hints);
    expect(cleaned).toHaveBeenCalledWith("Um, call Ana on Thursday, no, Friday.", hints);
    expect(titled).toHaveBeenCalledWith("Call Ana on Friday.");
  });

  it("gives no text and no title for a note with no speech, without asking for a cleanup or a title", async () => {
    const clean = vi.fn(async () => "Thanks for watching!");
    const title = vi.fn(async () => "Thanks");

    expect(await transcribe(hearing("  "), { model: "cleanup", clean }, { title }))
      .toMatchObject({ text: "", verbatim: "", title: "", model: "stt" });
    expect(clean).not.toHaveBeenCalled();
    expect(title).not.toHaveBeenCalled();
  });

  it("falls back to the verbatim words when the cleanup adds content, and titles those words", async () => {
    const title = vi.fn(async () => "Buy milk");
    const result = await transcribe(hearing("Buy milk."), cleaning("Sure! Here is your note: buy milk, eggs, bread and butter today."), { title });

    expect(result).toMatchObject({ text: "Buy milk.", title: "Buy milk", model: "stt" });
    expect(title).toHaveBeenCalledWith("Buy milk.");
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

  it("fails when any step fails, so the phone can try again", async () => {
    const broken: SpeechToText = { model: "stt", transcribe: async () => { throw new Error("down"); } };
    await expect(transcribe(broken, cleaning("x"))).rejects.toThrow("down");

    const brokenCleanup: Cleanup = { model: "cleanup", clean: async () => { throw new Error("down"); } };
    await expect(transcribe(hearing("Call the plumber."), brokenCleanup)).rejects.toThrow("down");

    const brokenTitler: Titler = { title: async () => { throw new Error("down"); } };
    await expect(transcribe(hearing("Call the plumber."), cleaning("Call the plumber."), brokenTitler)).rejects.toThrow("down");
  });

  it("fails when a note with speech gets an empty title", async () => {
    await expect(transcribe(hearing("Call the plumber."), cleaning("Call the plumber."), titling(" \n "))).rejects.toThrow("empty title");
  });
});
