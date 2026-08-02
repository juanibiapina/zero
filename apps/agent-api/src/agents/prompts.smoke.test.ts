import { describe, expect, it } from "vitest";
import {
  adminTaskSystemPrompt,
  compactionSystemPrompt,
  interfaceSystemPrompt,
  learnerSystemPrompt,
  onboardingSystemPrompt,
} from "./prompts";

// Several prompts interpolate the same rule bodies. These assertions are what
// keeps the shared text from being mangled by an escaping mistake when it is
// reused.
describe("knowledge-maintainer prompts", () => {
  it("gives the learner its framing plus the maintenance rules", () => {
    const prompt = learnerSystemPrompt();
    expect(prompt.startsWith("You maintain this user's knowledge model")).toBe(true);
    expect(prompt).toContain("since\nthe last consolidation");
    expect(prompt).toContain("[[Topic Name]]");
    expect(prompt).toContain("File markers such as");
    // An escaping mistake in the shared body would show up here.
    expect(prompt).not.toContain("\\`");
  });

  // The point of the prompt: a knowledge model of this user, not of the world.
  it("records what is specific to the user and skips what a search would answer", () => {
    const prompt = learnerSystemPrompt();
    expect(prompt).toContain("findable nowhere else");
    expect(prompt).toContain("their projects and where each one stands");
    expect(prompt).toContain("people, companies and organisations in their life");
    expect(prompt).toContain("Leave out what a search would answer the same way");
    expect(prompt).toContain("record what it meant for the\nuser");
  });

  // Until 2026-08-02 the learner was told to record generously and to persist
  // research reports verbatim with their source URLs, which filled the model
  // with material anyone could look up. These are the sentences that must not
  // come back.
  it("does not ask for generous recording or for verbatim research findings", () => {
    const prompt = learnerSystemPrompt();
    expect(prompt).not.toContain("generous");
    expect(prompt).not.toContain("verbatim");
    expect(prompt).not.toContain("Source:");
  });

  // A budget, not a measurement. Over half of this prompt is the shared rule
  // bodies; the learner's own instructions have to earn their room, and the
  // seven topic tool descriptions already carry the write mechanics.
  it("stays small: instructions the topic tools do not already carry", () => {
    expect(learnerSystemPrompt().length).toBeLessThan(3600);
  });

  it("gives every topic-writing agent the same User topic scope", () => {
    const prompts = [
      interfaceSystemPrompt(),
      learnerSystemPrompt(),
      onboardingSystemPrompt(),
      adminTaskSystemPrompt(),
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain('The topic named "User" is special');
      expect(prompt).toContain("It holds identity only");
      expect(prompt).toContain("[[Personal Details]]");
      expect(prompt).toContain("It holds nothing else");
    }
  });

  it("forbids compaction from copying topic knowledge into a summary", () => {
    const prompt = compactionSystemPrompt();
    expect(prompt).toContain("Never copy a topic body");
    expect(prompt).toContain("[[Topic Name]]");
    expect(prompt).toContain("every file marker byte-for-byte");
  });
});
