import { describe, expect, it } from "vitest";
import {
  adminTaskSystemPrompt,
  compactionSystemPrompt,
  interfaceSystemPrompt,
  learnerSystemPrompt,
  onboardingSystemPrompt,
} from "./prompts";

// The writer and learner share one rules body. These assertions are what keeps
// the shared text from being mangled by an escaping mistake when it is reused.
describe("knowledge-maintainer prompts", () => {
  it("gives the learner its framing plus the maintenance rules", () => {
    const prompt = learnerSystemPrompt();
    expect(prompt.startsWith("You maintain the whole knowledge model")).toBe(true);
    expect(prompt).toContain("since the last\nconsolidation");
    expect(prompt).toContain("Be proactive and generous");
    expect(prompt).toContain("[[Topic Name]]");
    expect(prompt).toContain("Preserve every marker byte-for-byte");
    // An escaping mistake in the shared body would show up here.
    expect(prompt).not.toContain("\\`");
  });

  it("exempts the pinned User topic from generous recording and from a Log section", () => {
    const prompt = learnerSystemPrompt();
    expect(prompt).toContain("Generous means many topics");
    expect(prompt).toContain('never gets a "## Log" section');
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
      expect(prompt).toContain("Moving\nis not deleting");
    }
  });

  it("forbids compaction from copying topic knowledge into a summary", () => {
    const prompt = compactionSystemPrompt();
    expect(prompt).toContain("Never copy a topic body");
    expect(prompt).toContain("not versioned");
    expect(prompt).toContain("[[Topic Name]]");
    expect(prompt).toContain("every file marker byte-for-byte");
  });
});
