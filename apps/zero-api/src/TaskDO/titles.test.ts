import { createMergeableStore } from "tinybase";
import { RecordingModel } from "@zero/agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Titler } from "../transcription/titler";
import { createTitleQueue, type TitleAttempt } from "./titles";

const MINUTE = 60_000;
const START = Date.parse("2026-10-20T18:31:00.000Z");

function setup() {
  const model = new RecordingModel(createMergeableStore());
  const say = (id: string, text: string) => {
    model.add({ id, startedAt: "2026-10-20T18:30:00.000Z", timeZone: "Europe/Berlin", durationMs: 1000, source: "app", device: "Pixel 7" });
    model.setTranscript(id, { text, verbatim: text, model: "m", transcribedAt: "2026-10-20T18:31:00.000Z" });
  };
  const stored = new Map<string, TitleAttempt>();
  const replies: Array<string | Error> = [];
  const ask = vi.fn(async () => {
    const reply = replies.shift() ?? "A title";
    if (reply instanceof Error) throw reply;
    return reply;
  });
  const titler: Titler = { model: "luna", title: ask };
  const reports: Array<{ error: unknown; context: Record<string, unknown> }> = [];
  const saves = vi.fn();
  const time = { now: START };
  const account = { erased: false };
  const queue = createTitleQueue({
    recordings: {
      untitled: () => model.untitled(),
      setTitle: async (id, title) => { saves(); return model.setTitle(id, title); },
    },
    titler,
    attempts: {
      list: async () => new Map(stored),
      put: async (id, attempt) => { stored.set(id, attempt); },
      delete: async (id) => { stored.delete(id); },
    },
    report: async (error, context) => { reports.push({ error, context }); },
    isErased: async () => account.erased,
    clock: () => time.now,
  });
  const run = (at: number) => { time.now = at; return queue.runDue(); };
  const title = (id: string) => model.get(id)?.title ?? null;
  return { model, say, stored, replies, ask, reports, saves, run, title, time, account };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("Recording titles", () => {
  it("titles every untitled voice note and has nothing left to do", async () => {
    const { say, replies, run, title, stored } = setup();
    say("a", "Call Ana on Friday.");
    say("b", "Ideas for the garden.");
    replies.push("Call Ana on Friday", "Garden ideas");

    expect(await run(START)).toBeNull();

    expect(title("a")).toBe("Call Ana on Friday");
    expect(title("b")).toBe("Garden ideas");
    expect(stored.size).toBe(0);
  });

  it("skips silent and already titled notes", async () => {
    const { model, say, run, ask } = setup();
    say("silent", "");
    say("done", "Buy grout.");
    model.setTitle("done", "Buy grout");

    expect(await run(START)).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });

  it("retries after 1, 5 and 30 minutes and 2 hours, then reports the 5th failure once and retries daily", async () => {
    const { say, replies, run, reports, title } = setup();
    say("a", "Call Ana on Friday.");
    const down = new Error("OpenAI title failed: 503");
    replies.push(down, down, down, down, down, down);

    let now = START;
    const waits: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const next = await run(now);
      expect(next).not.toBeNull();
      waits.push((next! - now) / MINUTE);
      expect(reports).toHaveLength(attempt >= 4 ? 1 : 0);
      now = next!;
    }

    expect(waits).toEqual([1, 5, 30, 120, 24 * 60, 24 * 60]);
    expect(reports).toEqual([{ error: down, context: { site: "recording_title", recording_id: "a" } }]);
    expect(JSON.stringify(reports[0]?.context)).not.toContain("Ana");

    replies.push("Call Ana on Friday");
    expect(await run(now)).toBeNull();
    expect(title("a")).toBe("Call Ana on Friday");
  });

  it("waits for a failed note's next attempt instead of retrying early", async () => {
    const { say, replies, run, ask } = setup();
    say("a", "Call Ana.");
    replies.push(new Error("down"));
    await run(START);

    expect(await run(START + 30_000)).toBe(START + MINUTE);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("comes back at once for a note transcribed while another note's title was failing", async () => {
    const { say, replies, run, title } = setup();
    say("a", "Call Ana.");
    replies.push(new Error("down"));
    const failing = run(START);
    say("b", "Buy grout.");

    expect(await failing).toBe(START);

    replies.push("Buy grout");
    expect(await run(START)).toBe(START + MINUTE);
    expect(title("b")).toBe("Buy grout");
  });

  it("clears a note's attempts once it is titled", async () => {
    const { say, replies, run, stored } = setup();
    say("a", "Call Ana.");
    replies.push(new Error("down"));
    await run(START);
    expect(stored.get("a")).toEqual({ attempts: 1, nextAt: START + MINUTE, reported: false });

    await run(START + MINUTE);
    expect(stored.size).toBe(0);
  });

  it("drops the attempts of a deleted note", async () => {
    const { model, say, replies, run, stored } = setup();
    say("a", "Call Ana.");
    replies.push(new Error("down"));
    await run(START);
    model.remove("a");

    expect(await run(START + MINUTE)).toBeNull();
    expect(stored.size).toBe(0);
  });

  it("waits a full minute after a failure that took the Titler 90 seconds", async () => {
    const { say, ask, run, time, stored } = setup();
    say("a", "Call Ana.");
    say("b", "Buy grout.");
    ask.mockImplementation(async () => {
      time.now += 90_000;
      throw new Error("timeout");
    });

    expect(await run(START)).toBe(START + 90_000 + MINUTE);
    expect(stored.get("a")?.nextAt).toBe(START + 90_000 + MINUTE);
    expect(stored.get("b")?.nextAt).toBe(START + 180_000 + MINUTE);
  });

  it("sends nothing more to the Titler once the account is erased", async () => {
    const { say, ask, run, account } = setup();
    say("a", "Call Ana.");
    say("b", "Buy grout.");
    ask.mockImplementation(async () => {
      account.erased = true;
      return "Call Ana";
    });

    expect(await run(START)).toBeNull();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("skips a note deleted or titled elsewhere while an earlier title was in flight", async () => {
    const { model, say, ask, run, stored, title } = setup();
    say("a", "Call Ana.");
    say("b", "Buy grout.");
    say("c", "Garden ideas.");
    ask.mockImplementationOnce(async () => {
      model.remove("b");
      model.setTitle("c", "My garden");
      return "Call Ana";
    });

    expect(await run(START)).toBeNull();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(title("c")).toBe("My garden");
    expect(stored.size).toBe(0);
  });

  it("counts an empty reply as a failed attempt", async () => {
    const { say, replies, run, title, stored } = setup();
    say("a", "Call Ana.");
    replies.push(' "." ');

    expect(await run(START)).toBe(START + MINUTE);
    expect(title("a")).toBeNull();
    expect(stored.get("a")?.attempts).toBe(1);
  });

  it.each([
    ['"Call Ana on Friday."', "Call Ana on Friday"],
    ["“Ideen für Anas Geburtstag”", "Ideen für Anas Geburtstag"],
    ["Call the plumber\nabout the boiler", "Call the plumber about the boiler"],
    ["Wait for it…", "Wait for it…"],
    [`Plan ${"the very long garden renovation ".repeat(3)}`, "Plan the very long garden renovation the very long garden"],
  ])("cleans the reply %j into one short line", async (reply, expected) => {
    const { say, replies, run, title } = setup();
    say("a", "Something.");
    replies.push(reply);
    await run(START);
    expect(title("a")).toBe(expected);
    expect(expected.length).toBeLessThanOrEqual(60);
  });
});
