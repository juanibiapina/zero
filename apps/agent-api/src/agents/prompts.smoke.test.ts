import { describe, expect, it } from "vitest";
import {
  compactionSystemPrompt,
  learnerSystemPrompt,
  writerSystemPrompt,
} from "./prompts";

// The writer and learner share one rules body. These assertions are what keeps
// the shared text from being mangled by an escaping mistake when it is reused.
describe("knowledge-maintainer prompts", () => {
  it("keeps the writer's own framing and the shared rules", () => {
    const prompt = writerSystemPrompt();
    expect(prompt.startsWith("You maintain the whole knowledge model")).toBe(true);
    expect(prompt).toContain("the transcript of the turn that just happened");
    expect(prompt).toContain("Be proactive and generous");
    expect(prompt).toContain("[[Topic Name]]");
    expect(prompt).not.toContain("\\`");
  });

  it("gives the learner the same rules over a different input", () => {
    const prompt = learnerSystemPrompt();
    expect(prompt).toContain("since the last\nconsolidation");
    expect(prompt).toContain("Be proactive and generous");
    expect(prompt).not.toContain("the transcript of the turn that just happened");
    expect(prompt).not.toContain("\\`");
  });

  it("forbids compaction from copying topic knowledge into a summary", () => {
    const prompt = compactionSystemPrompt();
    expect(prompt).toContain("Never copy a topic body");
    expect(prompt).toContain("not versioned");
    expect(prompt).toContain("[[Topic Name]]");
  });
});
