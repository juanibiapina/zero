import { describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { FALLBACK_MESSAGE } from "../agents/fallback";
import { RATE_LIMIT_MESSAGE } from "../agents/llm-error";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createTestAssistant } from "./test-support";

const chat = { chatId: 10, topicId: 0 };

const say = async (
  t: Awaited<ReturnType<typeof createTestAssistant>>,
  text: string,
  operationId: string,
) =>
  t.assistant.submit({ chat, conversationId: "conv-1", text, operationId });

describe("assistant", () => {
  it("delivers the model's answer to the chat it came from", async () => {
    const t = await createTestAssistant({ steps: [fauxAssistantMessage("Hello!")] });
    await say(t, "hi", "tg:1");
    await t.idle();
    expect(t.sent).toEqual([{ chat, text: "Hello!" }]);
    await t.close();
  });

  it("sends an acknowledgment before the tools of its round run", async () => {
    const t = await createTestAssistant({
      steps: [
        fauxAssistantMessage(
          [fauxText("Let me check."), fauxToolCall("list_topics", {})],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("You have no topics yet."),
      ],
    });
    await say(t, "what do you know?", "tg:1");
    await t.idle();
    expect(t.sent.map((s) => s.text)).toEqual([
      "Let me check.",
      "You have no topics yet.",
    ]);
    await t.close();
  });

  it("answers an input once however often it is submitted", async () => {
    const t = await createTestAssistant({
      steps: [fauxAssistantMessage("Once."), fauxAssistantMessage("Twice.")],
    });
    await say(t, "hi", "tg:7");
    await say(t, "hi", "tg:7");
    await t.idle();
    expect(t.sent.map((s) => s.text)).toEqual(["Once."]);
    expect(t.requests()).toBe(1);
    await t.close();
  });

  it("sends the fallback when the model fails", async () => {
    const t = await createTestAssistant({
      steps: Array.from({ length: 4 }, () =>
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom (500)" }),
      ),
    });
    await say(t, "hi", "tg:1");
    await t.idle();
    expect(t.sent.map((s) => s.text)).toEqual([FALLBACK_MESSAGE]);
    await t.close();
  });

  it("tells the user about the usage limit on a 429", async () => {
    const t = await createTestAssistant({
      steps: Array.from({ length: 4 }, () =>
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "cloudflare-ai-gateway API error (429): rate limited",
        }),
      ),
    });
    await say(t, "hi", "tg:1");
    await t.idle();
    expect(t.sent.map((s) => s.text)).toEqual([RATE_LIMIT_MESSAGE]);
    await t.close();
  });
});

describe("assistant follow-ups and context", () => {
  it("answers messages sent while busy in one follow-up run", async () => {
    const contexts: string[] = [];
    let release = () => {};
    const busy = new Promise<void>((resolve) => {
      release = resolve;
    });
    const t = await createTestAssistant({
      steps: [
        async () => {
          await busy;
          return fauxAssistantMessage("First.");
        },
        (context) => {
          contexts.push(JSON.stringify(context.messages));
          return fauxAssistantMessage("Both answered.");
        },
      ],
    });
    await say(t, "one", "tg:1");
    await say(t, "two", "tg:2");
    await say(t, "three", "tg:3");
    release();
    await t.idle();
    expect(t.sent.map((s) => s.text)).toEqual(["First.", "Both answered."]);
    expect(t.requests()).toBe(2);
    expect(contexts[0]).toContain("two");
    expect(contexts[0]).toContain("three");
    await t.close();
  });

  it("puts the current time on the newest user message only", async () => {
    const contexts: string[][] = [];
    const t = await createTestAssistant({
      steps: [
        fauxAssistantMessage("ok"),
        (context) => {
          contexts.push(
            context.messages
              .filter((m) => m.role === "user")
              .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))),
          );
          return fauxAssistantMessage("ok again");
        },
      ],
    });
    await say(t, "first", "tg:1");
    await t.idle();
    await say(t, "second", "tg:2");
    await t.idle();
    const [older, newest] = contexts[0];
    expect(older).not.toContain("Current time:");
    expect(newest).toContain("Current time:");
    expect(newest).toContain("second");
    await t.close();
  });

  it("replaces a topic read taken at an older knowledge version", async () => {
    const contexts: string[] = [];
    const t = await createTestAssistant({
      steps: [
        fauxAssistantMessage([fauxToolCall("list_topics", {})], { stopReason: "toolUse" }),
        fauxAssistantMessage("Listed."),
        (context) => {
          contexts.push(JSON.stringify(context.messages));
          return fauxAssistantMessage("Fresh.");
        },
      ],
    });
    await say(t, "list", "tg:1");
    await t.idle();
    t.store.createTopic({
      expectedVersion: t.store.getKnowledgeVersion(),
      name: "Trip",
      description: "a trip",
      body: "Lisbon in May",
    });
    await say(t, "again", "tg:2");
    await t.idle();
    expect(contexts[0]).toContain("stale: topic knowledge changed");
    await t.close();
  });

  it("starts a fresh context after /new", async () => {
    const contexts: string[] = [];
    const t = await createTestAssistant({
      steps: [
        fauxAssistantMessage("Noted."),
        (context) => {
          contexts.push(JSON.stringify(context.messages));
          return fauxAssistantMessage("Hi again.");
        },
      ],
    });
    await say(t, "my secret word is pineapple", "tg:1");
    await t.idle();
    await t.assistant.reset(chat);
    await say(t, "hello", "tg:2");
    await t.idle();
    expect(contexts[0]).not.toContain("pineapple");
    await t.close();
  });
});

describe("assistant across restarts", () => {
  it("delivers what the dead process committed but never sent, and nothing twice", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zero-assistant-"));
    const t = await createTestAssistant({
      openStorage: () => openNodeSqliteStorage(join(dir, "pi.sqlite")),
      steps: [fauxAssistantMessage("First."), fauxAssistantMessage("Second.")],
    });
    await say(t, "one", "tg:1");
    await t.idle();
    t.ledger.setSentThrough(t.ledger.chats()[0].session, 0);
    const reopened = await t.reopen();
    await reopened.idle();
    expect(reopened.sent.map((s) => s.text)).toEqual(["First."]);
    await reopened.close();
  });
});

describe("assistant jobs and learning", () => {
  it("returns an admin task's final answer", async () => {
    const t = await createTestAssistant({ steps: [fauxAssistantMessage("Cleaned up 3 topics.")] });
    const result = await t.assistant.runJob({ kind: "admin", jobId: "admin:1", prompt: "tidy" });
    expect(result).toEqual({ status: "done", text: "Cleaned up 3 topics." });
    expect(t.sent).toEqual([]);
    await t.close();
  });

  it("consolidates chat messages once and advances past them", async () => {
    const prompts: string[] = [];
    const t = await createTestAssistant({
      steps: [
        fauxAssistantMessage("Nice dog!"),
        (context) => {
          prompts.push(JSON.stringify(context.messages));
          return fauxAssistantMessage("Recorded.");
        },
      ],
    });
    await say(t, "my dog is called Rex", "tg:1");
    await t.idle();
    await t.assistant.learn("idle");
    await t.idle();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("my dog is called Rex");
    const requests = t.requests();
    await t.assistant.learn("idle");
    await t.idle();
    expect(t.requests()).toBe(requests);
    await t.close();
  });
});
