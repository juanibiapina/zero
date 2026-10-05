import { describe, expect, it } from "vitest";
import { suggestProjectIcons } from "./icon-suggest";
import { scriptedModel, capturingModel } from "./mock-model";
import type { AgentModel } from "./protocol";

// A model that answers one generate call with a fixed assistant text block.
const answering = (text: string): AgentModel => scriptedModel([{ text }]);

describe("suggestProjectIcons", () => {
  it("parses a clean JSON array of emoji", async () => {
    const icons = await suggestProjectIcons(answering('["📁", "🚀", "📚"]'), {
      title: "Learn Rust",
    });
    expect(icons).toEqual(["📁", "🚀", "📚"]);
  });

  it("caps the result at the requested count", async () => {
    const icons = await suggestProjectIcons(
      answering('["📁", "🚀", "📚", "🎯", "🧪"]'),
      { title: "x" },
      { count: 2 },
    );
    expect(icons).toEqual(["📁", "🚀"]);
  });

  it("defaults to six suggestions", async () => {
    const icons = await suggestProjectIcons(
      answering('["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣"]'),
      { title: "x" },
    );
    expect(icons).toHaveLength(6);
  });

  it("falls back to emoji extraction from a fenced / prose-wrapped response", async () => {
    const icons = await suggestProjectIcons(
      answering("Sure! Here you go:\n```json\n[🏃, 📚, 🎯]\n```"),
      { title: "Run a 5K" },
    );
    expect(icons).toEqual(["🏃", "📚", "🎯"]);
  });

  it("drops non-emoji tokens", async () => {
    const icons = await suggestProjectIcons(
      answering('["📁", "folder", "🚀", "", "ab"]'),
      { title: "x" },
    );
    expect(icons).toEqual(["📁", "🚀"]);
  });

  it("dedupes repeated emoji", async () => {
    const icons = await suggestProjectIcons(
      answering('["📁", "📁", "🚀", "🚀"]'),
      { title: "x" },
    );
    expect(icons).toEqual(["📁", "🚀"]);
  });

  it("keeps a multi-codepoint emoji (ZWJ / keycap) whole", async () => {
    const icons = await suggestProjectIcons(answering('["👨‍👩‍👧", "🇧🇷"]'), {
      title: "family",
    });
    expect(icons).toEqual(["👨‍👩‍👧", "🇧🇷"]);
  });

  it("returns [] for garbage or an empty response", async () => {
    expect(
      await suggestProjectIcons(answering("no emoji at all here"), {
        title: "x",
      }),
    ).toEqual([]);
    expect(await suggestProjectIcons(answering(""), { title: "x" })).toEqual([]);
  });

  it("returns [] when the model throws, never propagating", async () => {
    const throwing: AgentModel = {
      modelId: "boom",
      generate: async () => {
        throw new Error("gateway down");
      },
    };
    expect(await suggestProjectIcons(throwing, { title: "x" })).toEqual([]);
  });

  it("sends the title and description in the request", async () => {
    let seen = "";
    const model = capturingModel((request) => {
      seen = request.messages
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("");
      return { content: [{ type: "text", text: "[]" }] };
    });
    await suggestProjectIcons(model, {
      title: "Ship the app",
      description: "get it to the store",
    });
    expect(seen).toContain("Ship the app");
    expect(seen).toContain("get it to the store");
  });
});
