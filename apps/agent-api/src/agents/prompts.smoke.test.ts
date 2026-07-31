import { describe, expect, it } from "vitest";
import { compactionSystemPrompt, learnerSystemPrompt } from "./prompts";

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

  it("forbids compaction from copying topic knowledge into a summary", () => {
    const prompt = compactionSystemPrompt();
    expect(prompt).toContain("Never copy a topic body");
    expect(prompt).toContain("not versioned");
    expect(prompt).toContain("[[Topic Name]]");
    expect(prompt).toContain("every file marker byte-for-byte");
  });
});
