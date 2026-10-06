import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, modelCalls, script, type TestAssistantDO } from "./worker";

const assistantStub = (id: DurableObjectId) =>
  env.ASSISTANT_DO.get(id) as unknown as DurableObjectStub<TestAssistantDO>;
const user = (name: string) => assistantStub(env.ASSISTANT_DO.idFromName(name));
const userDO = (name: string) => env.USER_DO.get(env.USER_DO.idFromName(name));

const settle = async (stub: DurableObjectStub<TestAssistantDO>) => {
  for (let i = 0; i < 100; i++) {
    const sent = await stub.sentMessages();
    if (sent.length > 0) return sent;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return stub.sentMessages();
};

describe("AssistantDO on PiHarness", () => {
  it("answers a Telegram message handed off by UserDO", async () => {
    script([fauxAssistantMessage("Hello from Pi.")]);
    const name = "user_answer";
    const accepted = await userDO(name).enqueueTurn({
      updateId: "1",
      clerkUserId: name,
      chatId: 42,
      topicId: 0,
      text: "hi",
    });
    expect(accepted).toBe(true);
    expect(await settle(user(name))).toEqual(["42:0:Hello from Pi."]);
  });

  it("does not answer a repeated webhook update twice", async () => {
    script([fauxAssistantMessage("Once."), fauxAssistantMessage("Twice.")]);
    const name = "user_repeat";
    const update = { updateId: "7", clerkUserId: name, chatId: 1, topicId: 0, text: "hi" };
    await userDO(name).enqueueTurn(update);
    expect(await userDO(name).enqueueTurn(update)).toBe(false);
    expect(await settle(user(name))).toEqual(["1:0:Once."]);
  });

  it("re-runs a request cut off by a crash and answers once", async () => {
    const calls = modelCalls();
    const hung = new Promise<never>(() => {});
    script([
      async () => {
        await hung;
        return fauxAssistantMessage("Never sent.");
      },
      fauxAssistantMessage("Recovered answer."),
    ]);
    const id = env.ASSISTANT_DO.idFromName("user_crash");
    let stub = assistantStub(id);
    await stub.submit({
      chat: { chatId: 5, topicId: 0 },
      conversationId: "c-5",
      text: "hi",
      operationId: "tg:crash",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await runInDurableObject(stub, (_instance, state) => state.abort("crash")).catch(() => {});
    stub = assistantStub(id);
    await runDurableObjectAlarm(stub);
    let sent: string[] = [];
    for (let i = 0; i < 50 && sent.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      sent = await stub.sentMessages();
    }
    expect(sent).toEqual(["5:0:Recovered answer."]);
    expect(modelCalls() - calls).toBe(2);
  });

  it("leaves no alarm armed once the user is idle", async () => {
    script([fauxAssistantMessage("Done.")]);
    const stub = user("user_idle");
    await stub.submit({
      chat: { chatId: 9, topicId: 0 },
      conversationId: "c-9",
      text: "hi",
      operationId: "tg:idle",
    });
    expect(await settle(stub)).toEqual(["9:0:Done."]);
    const alarm = async () =>
      runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm());
    for (let i = 0; i < 10 && (await alarm()) !== null; i++) {
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec("UPDATE cf_agents_jobs SET time = 0");
      });
      await runDurableObjectAlarm(stub);
    }
    expect(await alarm()).toBeNull();
  });
});

describe("legacy conversations", () => {
  it("continues a conversation stored by the old turn path", async () => {
    const name = "user_legacy";
    const seen: string[] = [];
    script([
      (context) => {
        seen.push(JSON.stringify(context.messages));
        return fauxAssistantMessage("Answering the waiting message.");
      },
      (context) => {
        seen.push(JSON.stringify(context.messages));
        return fauxAssistantMessage("Still remember the tea.");
      },
    ]);
    await runInDurableObject(userDO(name), async (instance, state) => {
      await state.storage.put("clerkUserId", name);
      const store = (instance as unknown as { store: import("../store/types").Store }).store;
      const conversationId = store.getOrCreateConversation(3, 0);
      store.storeMessage(conversationId, "user", "what do I like to drink?");
      store.storeMessage(
        conversationId,
        "assistant",
        [{ type: "tool_use", id: "call_1", name: "get_topic", input: { name: "User" } }],
        { stopReason: "tool_use" },
      );
      store.storeMessage(
        conversationId,
        "user",
        [{ type: "tool_result", tool_use_id: "call_1", content: '{"version":1,"body":"likes green tea"}' }],
        { kind: "tool_result" },
      );
      store.storeMessage(conversationId, "assistant", "You like green tea.", { stopReason: "end_turn" });
      store.storeMessage(conversationId, "user", "and for breakfast?");
    });

    await userDO(name).enqueueTurn({
      updateId: "900",
      clerkUserId: name,
      chatId: 3,
      topicId: 0,
      text: "do you remember?",
    });

    const stub = user(name);
    let sent: string[] = [];
    for (let i = 0; i < 100 && sent.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      sent = await stub.sentMessages();
    }
    expect(sent).toEqual(["3:0:Answering the waiting message.", "3:0:Still remember the tea."]);
    expect(seen[0]).toContain("You like green tea.");
    expect(seen[0]).toContain('"toolName":"get_topic"');
    expect(seen[0]).toContain("and for breakfast?");
    expect(seen[1]).toContain("do you remember?");
  });
});
