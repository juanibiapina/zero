import { describe, expect, it } from "vitest";

import { composeTurnText, FIRST_CONTACT_NOTE } from "./turn-text";

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
