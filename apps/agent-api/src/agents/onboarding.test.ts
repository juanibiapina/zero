import { describe, expect, it } from "vitest";
import { runOnboardingAgent } from "./onboarding";
import { scriptedModel } from "./mock-model";
import { MemoryStore } from "../store/memory";
import { createMemoryGoogle } from "../google/memory";
import { pinTopic, seedTopic } from "../store/test-support";

describe("runOnboardingAgent", () => {
  it("scans Gmail and writes the pinned identity topic", async () => {
    const store = new MemoryStore();
    seedTopic(store, "User", "identity");
    pinTopic(store, "User", true);

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
            name: "append_topic",
            input: {
              expectedVersion: store.getKnowledgeVersion(),
              name: "User",
              text: "## Identity\n\nName: Alice Smith\nEmail: alice@example.com",
            },
          },
        ],
      },
      { text: "Recorded the user's name: Alice Smith." },
    ]);

    await runOnboardingAgent({ model, store, google, topicName: "User" });

    const topic = store.getTopic("User");
    expect(topic?.body).toContain("Alice Smith");
    // Authoring the topic must not unpin it.
    expect(topic?.pinned).toBe(true);
    expect(store.getPinnedTopics().map((t) => t.name)).toEqual(["User"]);
  });

  it("does not expose write-side Gmail or calendar tools", async () => {
    const store = new MemoryStore();
    seedTopic(store, "User", "identity");
    pinTopic(store, "User", true);

    // The model tries to send mail and to reorganise the mailbox; neither tool
    // exists here, so nothing happens to the user's Gmail.
    const google = createMemoryGoogle({ labels: ["Receipts"] });
    const model = scriptedModel([
      {
        tools: [
          { name: "gmail_send", input: { to: "x@y.z", subject: "hi", body: "hi" } },
        ],
      },
      {
        tools: [
          {
            name: "gmail_modify_thread",
            input: { threadId: "t1", remove: ["INBOX"] },
          },
        ],
      },
      {
        tools: [
          { name: "gmail_trash_thread", input: { threadId: "t1" } },
        ],
      },
      { text: "done" },
    ]);

    await runOnboardingAgent({ model, store, google, topicName: "User" });

    expect(google.sentMail).toEqual([]);
    expect(google.modifications).toEqual([]);
    expect(google.trashed).toEqual([]);
  });
});
