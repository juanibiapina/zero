import { describe, expect, it } from "vitest";
import { runAdminTaskAgent } from "./admin-task";
import { capturingModel, scriptedModel } from "./mock-model";
import { MemoryStore } from "../store/memory";
import { SystemTopicStore } from "../store/system-topics";

describe("runAdminTaskAgent", () => {
  it("executes the submitted task prompt against durable topics", async () => {
    const store = new MemoryStore();
    store.createTopic("Work", "existing work notes");
    store.updateTopicBody("Work", "Existing facts.");
    const model = scriptedModel([
      { tools: [{ name: "list_topics", input: {} }] },
      { tools: [{ name: "get_topic", input: { name: "Work" } }] },
      {
        tools: [
          {
            name: "create_topic",
            input: { name: "Launch", description: "Product launch" },
          },
        ],
      },
      {
        tools: [
          {
            name: "update_topic",
            input: {
              name: "Launch",
              body: "Target date is Friday. Related: [[Work]].",
              summary: "Launch is planned for Friday.",
            },
          },
        ],
      },
      { text: "Created [[Launch]] and linked it to [[Work]]." },
    ]);

    await expect(
      runAdminTaskAgent({
        model,
        store,
        prompt: "Create a launch topic linked to Work for Friday.",
      }),
    ).resolves.toContain("Launch");
    expect(store.getTopic("Launch")?.body).toContain("[[Work]]");
  });

  it("passes the submitted prompt verbatim to the model", async () => {
    let prompt = "";
    const model = capturingModel((request) => {
      // The loop wraps the prompt into a text block carrying the sliding cache
      // breakpoint, so read the text out of the block rather than as a string.
      const content = request.messages.at(-1)?.content;
      prompt =
        typeof content === "string"
          ? content
          : ((content?.[0] as { text?: string })?.text ?? "");
      return { content: [{ type: "text", text: "Done." }] };
    });

    await runAdminTaskAgent({
      model,
      store: new MemoryStore(),
      prompt: "Perform this exact task.",
    });
    expect(prompt).toBe("Perform this exact task.");
  });

  it("registers no tools beyond the topic toolset", async () => {
    let tools: string[] = [];
    const model = capturingModel((request) => {
      tools = request.tools.map((tool) => tool.name);
      return { content: [{ type: "text", text: "No changes needed." }] };
    });

    await runAdminTaskAgent({ model, store: new MemoryStore(), prompt: "notes" });
    expect(tools.sort()).toEqual([
      "create_topic",
      "get_topic",
      "list_backlinks",
      "list_topics",
      "update_topic",
    ]);
  });

  it("keeps Zero and Changelog read-only", async () => {
    const store = new SystemTopicStore(new MemoryStore());
    const model = scriptedModel([
      {
        tools: [
          { name: "update_topic", input: { name: "Zero", body: "changed" } },
          { name: "update_topic", input: { name: "Changelog", body: "changed" } },
        ],
      },
      { text: "The protected topics were unchanged." },
    ]);

    await runAdminTaskAgent({ model, store, prompt: "try protected writes" });
    expect(store.getTopic("Zero")?.body).not.toBe("changed");
    expect(store.getTopic("Changelog")?.body).not.toBe("changed");
  });

  it("rejects a run that did not stop cleanly", async () => {
    const model = scriptedModel([{ tools: [{ name: "list_topics", input: {} }] }]);
    await expect(
      runAdminTaskAgent({ model, store: new MemoryStore(), prompt: "notes", maxSteps: 1 }),
    ).rejects.toThrow("finish reason");
  });
});
