import { createMergeableStore } from "tinybase";
import { describe, expect, it } from "vitest";

import { PromptModel, promptStatus } from "./model";

const NOW = "2026-11-03T09:00:00.000Z";
const LATER = "2026-11-03T09:05:00.000Z";

function workspace(store = createMergeableStore()) {
  let now = NOW;
  const model = new PromptModel(store, () => new Date(now));
  return { store, model, at: (time: string) => { now = time; } };
}

const question = { title: "Which flight?", text: "Two flights fit the trip. Which one should I book?", suggestions: ["The 9:40", "The 14:05"] };

const value = <T>(result: { ok: true; value: T } | { ok: false; conflict: string }): T => {
  if (!result.ok) throw new Error(result.conflict);
  return result.value;
};

describe("PromptModel", () => {
  it("creates an unread Prompt with trimmed text and suggestions", () => {
    const { model } = workspace();
    const prompt = value(model.create("p1", { title: " Which flight? ", text: question.text, suggestions: [" The 9:40 ", "The 14:05"] }));
    expect(prompt).toEqual({ id: "p1", ...question, createdAt: NOW, seenAt: null, answer: null });
    expect(promptStatus(prompt)).toBe("unread");
    expect(model.get("p1")).toEqual(prompt);
  });

  it("accepts an open question without suggestions", () => {
    const { model } = workspace();
    expect(value(model.create("p1", { ...question, suggestions: [] })).suggestions).toEqual([]);
  });

  it("refuses an empty title or text, and suggestions that are empty, repeated, or more than six", () => {
    const { model } = workspace();
    const refused = (input: Partial<typeof question>) => model.create("p1", { ...question, ...input });
    expect(refused({ title: " " })).toEqual({ ok: false, conflict: "invalid-prompt" });
    expect(refused({ text: "" })).toEqual({ ok: false, conflict: "invalid-prompt" });
    expect(refused({ suggestions: ["Yes", " "] })).toEqual({ ok: false, conflict: "invalid-prompt" });
    expect(refused({ suggestions: ["Yes", " Yes"] })).toEqual({ ok: false, conflict: "invalid-prompt" });
    expect(refused({ suggestions: ["1", "2", "3", "4", "5", "6", "7"] })).toEqual({ ok: false, conflict: "invalid-prompt" });
    expect(model.list()).toEqual([]);
  });

  it("treats a repeated create as unchanged and a different one with the same id as a conflict", () => {
    const { model } = workspace();
    model.create("p1", question);
    expect(model.create("p1", question)).toMatchObject({ ok: true, changed: false });
    expect(model.create("p1", { ...question, title: "Other" })).toEqual({ ok: false, conflict: "id-conflict" });
  });

  it("is read once the user opens it", () => {
    const { model, at } = workspace();
    model.create("p1", question);
    at(LATER);
    expect(model.markSeen("p1")).toMatchObject({ ok: true, changed: true, value: { seenAt: LATER } });
    expect(model.markSeen("p1")).toMatchObject({ ok: true, changed: false });
    expect(promptStatus(model.get("p1")!)).toBe("read");
    expect(model.markSeen("gone")).toEqual({ ok: false, conflict: "missing-prompt" });
  });

  it("takes a suggestion or the user's own words as the answer, and marks it read", () => {
    const { model, at } = workspace();
    model.create("p1", question);
    model.create("p2", question);
    at(LATER);
    expect(value(model.answer("p1", "The 9:40"))).toMatchObject({ seenAt: LATER, answer: { text: "The 9:40", answeredAt: LATER } });
    expect(value(model.answer("p2", "  Neither, wait for prices to drop "))).toMatchObject({ answer: { text: "Neither, wait for prices to drop" } });
    expect(promptStatus(model.get("p2")!)).toBe("answered");
  });

  it("keeps the first answer", () => {
    const { model } = workspace();
    model.create("p1", question);
    model.answer("p1", "The 9:40");
    expect(model.answer("p1", "The 9:40")).toMatchObject({ ok: true, changed: false });
    expect(model.answer("p1", "The 14:05")).toEqual({ ok: false, conflict: "already-answered" });
    expect(model.answer("p1", " ")).toEqual({ ok: false, conflict: "empty-answer" });
    expect(model.answer("gone", "Yes")).toEqual({ ok: false, conflict: "missing-prompt" });
    expect(model.get("p1")?.answer?.text).toBe("The 9:40");
  });

  it("deletes a Prompt, and an answer that arrives after the delete does not bring it back", () => {
    const { store, model } = workspace();
    model.create("p1", question);
    expect(model.delete("p1")).toEqual({ ok: true, changed: true, value: null });
    expect(model.delete("p1")).toEqual({ ok: true, changed: false, value: null });
    store.setCell("prompts", "p1", "answer", JSON.stringify({ text: "The 9:40", answeredAt: LATER }));
    expect(model.get("p1")).toBeNull();
    expect(model.list()).toEqual([]);
  });

  it("converges when two phones answer differently while offline", () => {
    const phone = workspace();
    phone.model.create("p1", question);
    const tablet = workspace(createMergeableStore().merge(phone.store));
    phone.model.answer("p1", "The 9:40");
    tablet.model.answer("p1", "The 14:05");
    phone.store.merge(tablet.store);
    expect(phone.model.get("p1")?.answer).toEqual(tablet.model.get("p1")?.answer);
  });

  it("lists Prompts newest first, and open ones oldest first", () => {
    const { model, at } = workspace();
    model.create("old", question);
    at(LATER);
    model.create("done", question);
    model.answer("done", "The 9:40");
    at("2026-11-03T09:10:00.000Z");
    model.create("new", question);
    expect(model.list().map((prompt) => prompt.id)).toEqual(["new", "done", "old"]);
    expect(model.unanswered().map((prompt) => prompt.id)).toEqual(["old", "new"]);
  });

  it("tells a listener when one Prompt changes", () => {
    const { model } = workspace();
    model.create("p1", question);
    model.create("p2", question);
    const changes: string[] = [];
    const stop = model.onChange("p1", () => changes.push("p1"));
    model.answer("p2", "The 9:40");
    model.answer("p1", "The 9:40");
    stop();
    model.delete("p1");
    expect(changes).toEqual(["p1"]);
  });
});
