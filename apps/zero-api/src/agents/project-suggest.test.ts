import { describe, expect, it, vi } from "vitest";

import { suggestProject, type ProjectCandidate } from "./project-suggest";
import type { Decide, SystemOneRequest, SystemOneResponse } from "./system-one";

const bathroom: ProjectCandidate = {
  id: "project-bathroom",
  title: "Bathroom renovation",
  icon: "🛁",
  description: "Redo the tiles",
  tasks: ["choose tiles", "get plumber quotes"],
};
const trip: ProjectCandidate = {
  id: "project-trip",
  title: "Lisbon trip",
  icon: "✈️",
  description: null,
  tasks: [],
};

const answering = (choice: string, probabilities: Record<string, number>) =>
  vi.fn<Decide>(async () => ({
    model: "jev-1.13.0",
    answers: { project: { type: "choice", choice, probabilities, confidence: 0.5 } },
    usage: { input_tokens: 321, output_tokens: 0 },
  }));

const input = { title: "buy grout", projects: [bathroom, trip] };

describe("suggestProject", () => {
  it("returns the chosen Project when its probability reaches the cutoff", async () => {
    const decide = answering("p1", { p1: 0.8, p2: 0.1, none: 0.1 });

    expect(await suggestProject(decide, input)).toEqual({
      projectId: "project-bathroom",
      confidence: 0.8,
      inputTokens: 321,
    });
  });

  it("returns no Project when the model picks none", async () => {
    const decide = answering("none", { p1: 0.2, p2: 0.1, none: 0.7 });

    expect((await suggestProject(decide, input)).projectId).toBeNull();
  });

  it("returns no Project below the cutoff", async () => {
    const decide = answering("p2", { p1: 0.3, p2: 0.45, none: 0.25 });

    expect(await suggestProject(decide, input)).toMatchObject({ projectId: null, confidence: 0.45 });
  });

  it("returns no Project for an unknown option, a malformed answer, or a failure", async () => {
    const unknown = answering("p9", { p9: 0.9 });
    const malformed = vi.fn<Decide>(async () => ({ model: "jev-1.13.0", answers: {} }) as unknown as SystemOneResponse);
    const failing = vi.fn<Decide>(async () => {
      throw new Error("rate limited");
    });

    for (const decide of [unknown, malformed, failing]) {
      expect((await suggestProject(decide, input)).projectId).toBeNull();
    }
  });

  it("asks one choice with each Project's evidence plus a none option", async () => {
    const decide = answering("none", { none: 1 });
    await suggestProject(decide, input);

    const request: SystemOneRequest | undefined = decide.mock.calls[0]?.[0];
    expect(request?.state).toEqual({ draft_task: "buy grout" });
    const criteria = request?.questions.project?.criteria ?? {};
    expect(Object.keys(criteria)).toEqual(["p1", "p2", "none"]);
    expect(criteria.p1).toBe("🛁 Bathroom renovation. Redo the tiles Open tasks: choose tiles; get plumber quotes");
    expect(criteria.p2).toBe("✈️ Lisbon trip.");
  });

  it("skips the decision when there are no Projects", async () => {
    const decide = answering("none", { none: 1 });

    expect((await suggestProject(decide, { title: "buy grout", projects: [] })).projectId).toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });
});
