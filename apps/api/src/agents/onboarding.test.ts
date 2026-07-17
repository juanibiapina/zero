import { describe, expect, it } from "vitest";
import { runOnboardingAgent } from "./onboarding";
import { scriptedModel } from "./mock-model";
import { MemoryStore } from "../store/memory";
import { createMemoryGoogle } from "../google/memory";

describe("runOnboardingAgent", () => {
  it("scans Gmail and writes the pinned identity topic", async () => {
    const store = new MemoryStore();
    store.createTopic("About You", "identity");
    store.setPinned("About You", true);

    const google = createMemoryGoogle({
      threadSummaries: [
        {
          threadId: "t1",
          date: "2026-07-10",
          from: "Alice Smith <alice@example.com>",
          subject: "Re: lunch",
          snippet: "See you then — Alice",
        },
      ],
    });

    const model = scriptedModel([
      { tools: [{ name: "gmail_search", input: { query: "in:sent" } }] },
      {
        tools: [
          {
            name: "update_topic",
            input: {
              name: "About You",
              body: "## Identity\n\nName: Alice Smith\nEmail: alice@example.com",
              summary: "The user is Alice Smith.",
            },
          },
        ],
      },
      { text: "Recorded the user's name: Alice Smith." },
    ]);

    await runOnboardingAgent({ model, store, google, topicName: "About You" });

    const topic = store.getTopic("About You");
    expect(topic?.body).toContain("Alice Smith");
    // Authoring the topic must not unpin it.
    expect(topic?.pinned).toBe(true);
    expect(store.getPinnedTopics().map((t) => t.name)).toEqual(["About You"]);
  });

  it("does not expose write-side Gmail or calendar tools", async () => {
    const store = new MemoryStore();
    store.createTopic("About You", "identity");
    store.setPinned("About You", true);

    // The model tries to send mail; the tool does not exist, so nothing is sent.
    const google = createMemoryGoogle();
    const model = scriptedModel([
      {
        tools: [
          { name: "gmail_send", input: { to: "x@y.z", subject: "hi", body: "hi" } },
        ],
      },
      { text: "done" },
    ]);

    await runOnboardingAgent({ model, store, google, topicName: "About You" });

    expect(google.sentMail).toEqual([]);
  });
});
