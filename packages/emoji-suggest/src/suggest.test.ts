import { describe, expect, it, vi } from "vitest";

import { CATEGORIES } from "./catalog";
import { suggestEmoji, type Purpose } from "./suggest";
import type { Decide, SystemOneRequest, SystemOneResponse } from "@zeroapps/typesafe";

const purpose: Purpose = {
  context: "The user is creating a project in their personal todo app and wants an emoji as its icon.",
  subject: "project",
};

type Script = {
  categories: Record<string, number>;
  country?: Record<string, number>;
  mainSubject?: number;
  fit: Record<string, number>;
};

const usage = { input_tokens: 100, output_tokens: 0 };

const nameIn = (instructions: unknown): string => String(instructions).match(/emoji "([^"]+)"/)?.[1] ?? "";

const scripted = (script: Script) =>
  vi.fn<Decide>(async (request: SystemOneRequest): Promise<SystemOneResponse> => {
    const answers: SystemOneResponse["answers"] = {};
    if ("categories" in request.questions) {
      const probabilities = Object.fromEntries(
        CATEGORIES.map((c) => [c.label, script.categories[c.label] ?? 0]),
      );
      answers.categories = { type: "choice", choice: "", probabilities, confidence: 1 };
      answers.categoriesReversed = { type: "choice", choice: "", probabilities, confidence: 1 };
      for (const id of ["country0", "country1"]) {
        const options = Object.keys((request.questions[id] as { criteria: object }).criteria);
        const probabilities = Object.fromEntries(options.map((o) => [o, script.country?.[o] ?? 0]));
        answers[id] = { type: "choice", choice: "", probabilities, confidence: 1 };
      }
      answers.mainSubject = { type: "noul", noul: script.mainSubject ?? 0 };
    } else {
      for (const [id, question] of Object.entries(request.questions)) {
        answers[id] = { type: "noul", noul: script.fit[nameIn(question.instructions)] ?? 0.01 };
      }
    }
    return { model: "jev-1.13.0", answers, usage };
  });

const dogs: Script = {
  categories: { "animal: mammal": 0.9, "animal: bird": 0.1 },
  fit: { "dog face": 0.95, dog: 0.9, "paw prints": 0.8, poodle: 0.7, "guide dog": 0.6, "service dog": 0.5, "cat face": 0.4 },
};

describe("suggestEmoji", () => {
  it("ranks emoji in the best categories by how well they fit", async () => {
    const result = await suggestEmoji(scripted(dogs), { title: "Get a dog", purpose });

    expect(result).toEqual({ emoji: ["🐶", "🐕", "🐾", "🐩", "🦮", "🐕‍🦺"], inputTokens: 200 });
  });

  it("returns the requested number of emoji", async () => {
    const result = await suggestEmoji(scripted(dogs), { title: "Get a dog", purpose }, { count: 2 });

    expect(result.emoji).toEqual(["🐶", "🐕"]);
  });

  it("asks fit questions only for emoji in the top eight categories", async () => {
    const categories = Object.fromEntries(CATEGORIES.slice(0, 9).map((c, i) => [c.label, 0.9 - i * 0.1]));
    const decide = scripted({ categories, fit: {} });
    await suggestEmoji(decide, { title: "x", purpose });

    const asked = Object.values(decide.mock.calls[1][0].questions).map((q) => nameIn(q.instructions));
    const expected = CATEGORIES.slice(0, 8).flatMap((c) => c.emoji.map((e) => e.name));
    expect(asked.sort()).toEqual(expected.sort());
  });

  it("keeps one emoji per variant family", async () => {
    const decide = scripted({
      categories: { family: 0.6, "person: symbol": 0.4 },
      fit: { family: 0.99, "family: man, woman, boy": 0.98, "family: adult, child": 0.97, "people hugging": 0.6 },
    });
    const result = await suggestEmoji(decide, { title: "Family visit", purpose }, { count: 2 });

    expect(result.emoji).toEqual(["👪", "🫂"]);
  });

  it("puts the country's flag first when the place is the main subject", async () => {
    const decide = scripted({ ...dogs, country: { Croatia: 0.99 }, mainSubject: 0.8 });
    const result = await suggestEmoji(decide, { title: "Croatia trip", purpose });

    expect(result.emoji).toEqual(["🇭🇷", "🐶", "🐕", "🐾", "🐩", "🦮"]);
  });

  it("puts the country's flag last when the place is incidental", async () => {
    const decide = scripted({ ...dogs, country: { Japan: 0.9 }, mainSubject: 0.1 });
    const result = await suggestEmoji(decide, { title: "Tokyo marathon", purpose });

    expect(result.emoji).toEqual(["🐶", "🐕", "🐾", "🐩", "🦮", "🇯🇵"]);
  });

  it("reaches flags in both halves of the country list", async () => {
    for (const [country, flag] of [["Austria", "🇦🇹"], ["Zimbabwe", "🇿🇼"], ["Scotland", "🏴󠁧󠁢󠁳󠁣󠁴󠁿"]] as const) {
      const decide = scripted({ ...dogs, country: { [country]: 0.9 }, mainSubject: 0.9 });
      expect((await suggestEmoji(decide, { title: country, purpose })).emoji[0]).toBe(flag);
    }
  });

  it("adds no flag when no country is likely enough", async () => {
    const decide = scripted({ ...dogs, country: { Croatia: 0.4, "none of these": 0.6 }, mainSubject: 0.9 });
    const result = await suggestEmoji(decide, { title: "Get a dog", purpose });

    expect(result.emoji).not.toContain("🇭🇷");
  });

  it("returns nothing when a request fails or an answer is malformed", async () => {
    const failing = vi.fn<Decide>(async () => {
      throw new Error("rate limited");
    });
    const malformed = vi.fn<Decide>(async () => ({ model: "jev-1.13.0", answers: {} }) as unknown as SystemOneResponse);

    for (const decide of [failing, malformed]) {
      expect(await suggestEmoji(decide, { title: "x", purpose })).toEqual({ emoji: [], inputTokens: null });
    }
  });

  it("describes the subject in the state and the purpose in every question", async () => {
    const decide = scripted(dogs);
    await suggestEmoji(decide, { title: "Get a dog", description: "a small one", purpose });

    for (const [request] of decide.mock.calls) {
      expect(request.state).toEqual({ project: { title: "Get a dog", description: "a small one" } });
    }
    const fit = Object.values(decide.mock.calls[1][0].questions)[0];
    expect(String(fit.instructions)).toContain(purpose.context);
    expect(JSON.stringify(decide.mock.calls[0][0].questions.categories)).toContain(purpose.context);
  });
});
