import { describe, expect, it } from "vitest";

import { composeTurnText, composeWakeNoteText, FIRST_CONTACT_NOTE, WAKE_NOTE } from "./turn-text";

// The offer is prompt text, so these assertions are what stops a later edit
// from silently dropping it or turning it into an auto-created schedule.
describe("FIRST_CONTACT_NOTE", () => {
  it("still asks for the introduction", () => {
    expect(FIRST_CONTACT_NOTE).toContain("introduce yourself");
    expect(FIRST_CONTACT_NOTE).toContain("rather than guessing");
  });

  it("offers a morning check-in and asks for a time", () => {
    expect(FIRST_CONTACT_NOTE).toContain("each morning");
    expect(FIRST_CONTACT_NOTE).toContain("what time");
  });

  it("creates nothing unless the user accepts", () => {
    expect(FIRST_CONTACT_NOTE).toContain("Create nothing now");
    expect(FIRST_CONTACT_NOTE).toContain("only if they accept");
    expect(FIRST_CONTACT_NOTE).toContain("say no or say nothing about it, drop it");
  });

  it("requires the stored prompt to carry content", () => {
    expect(FIRST_CONTACT_NOTE).toContain("create_schedule");
    expect(FIRST_CONTACT_NOTE).toContain("due or unresolved today");
  });
});

// WAKE_NOTE is prompt text: these assertions stop a later edit from dropping
// the one-message rule, the try-then-fallback ordering, or the do-not-reveal
// constraint.
describe("WAKE_NOTE", () => {
  it("re-engages in a single short message without revealing the trigger", () => {
    expect(WAKE_NOTE).toContain("ONE short message");
    expect(WAKE_NOTE).toContain("no more than one message");
    expect(WAKE_NOTE).toContain("Do not mention that a timer");
  });

  it("offers help in order: unread email, then a topic, then a general offer", () => {
    expect(WAKE_NOTE).toContain("gmail_search");
    expect(WAKE_NOTE).toContain("fall through");
    expect(WAKE_NOTE).toContain("list_topics");
    expect(WAKE_NOTE).toContain("general offer of help");
  });

  it("composeWakeNoteText carries the note with no user text", () => {
    expect(composeWakeNoteText()).toBe(WAKE_NOTE);
  });
});

describe("composeTurnText", () => {
  it("returns the text unchanged when there is nothing else", () => {
    expect(composeTurnText({ text: "hello" })).toBe("hello");
  });

  it("orders note, text, then file markers", () => {
    expect(
      composeTurnText({
        note: "[note]",
        text: "look at this",
        markers: ["[file a]", "[file b]"],
      }),
    ).toBe("[note]\n\nlook at this\n\n[file a]\n\n[file b]");
  });

  it("drops the empty text between a note and markers", () => {
    expect(composeTurnText({ note: "[note]", text: "", markers: ["[file a]"] })).toBe(
      "[note]\n\n[file a]",
    );
  });

  it("supports a note with no user text", () => {
    expect(composeTurnText({ note: "[note]", text: "" })).toBe("[note]");
  });

  it("keeps existing behaviour for text plus markers", () => {
    expect(composeTurnText({ text: "caption", markers: ["[file a]"] })).toBe(
      "caption\n\n[file a]",
    );
  });
});
