import { describe, expect, it } from "vitest";

import { composeTurnText } from "./turn-text";

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
