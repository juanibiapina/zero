import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { importLegacyConversations, planImport, type LegacyConversation, type LegacyMessage } from "./legacy-import";
import { createTestAssistant } from "./test-support";

const at = "2026-03-01T10:00:00.000Z";

const user = (id: number, text: string, consolidated = false): LegacyMessage => ({
  id,
  kind: "user_message",
  content: [{ type: "text", text }],
  stopReason: null,
  consolidated,
  createdAt: at,
});

const answer = (id: number, text: string, consolidated = false): LegacyMessage => ({
  id,
  kind: "assistant_message",
  content: [{ type: "text", text }],
  stopReason: "end_turn",
  consolidated,
  createdAt: at,
});

const conversation = (input: Partial<LegacyConversation>): LegacyConversation => ({
  id: "conv-1",
  chatId: 7,
  topicId: 0,
  summary: null,
  boundary: null,
  timezone: "UTC",
  messages: [],
  pending: [],
  ...input,
});

describe("planImport", () => {
  it("keeps unlearned rows before the boundary for learning and hides them from the model", () => {
    const plan = planImport(
      conversation({
        summary: "They talked about cats.",
        boundary: 2,
        messages: [user(1, "my cat is Tom"), answer(2, "Nice.", true), user(3, "hi"), answer(4, "Hello.")],
      }),
    );
    expect(plan.hidden.map((m) => m.id)).toEqual([1]);
    expect(plan.handoff).toBe("They talked about cats.");
    expect(plan.visible.map((m) => m.id)).toEqual([3, 4]);
    expect(plan.resubmit).toEqual([]);
  });

  it("resubmits a message that was never answered and everything still queued", () => {
    const plan = planImport(
      conversation({
        messages: [user(1, "hi"), answer(2, "Hello."), user(3, "are you there?")],
        pending: [{ id: 9, content: "hello?" }],
      }),
    );
    expect(plan.visible.map((m) => m.id)).toEqual([1, 2]);
    expect(plan.resubmit).toEqual([
      { operationId: "legacy:conv-1:3", text: "are you there?" },
      { operationId: "legacy:conv-1:pending:9", text: "hello?" },
    ]);
  });
});

describe("importLegacyConversations", () => {
  it("continues an imported conversation without repeating its replies", async () => {
    const seen: string[] = [];
    const t = await createTestAssistant({
      steps: [
        (context) => {
          seen.push(JSON.stringify(context.messages));
          return fauxAssistantMessage("Still here.");
        },
      ],
    });
    const legacy = conversation({
      messages: [
        user(1, "what do you know about me?"),
        {
          id: 2,
          kind: "assistant_message",
          content: [{ type: "tool_use", id: "call_1", name: "get_topic", input: { name: "User" } }],
          stopReason: "tool_use",
          consolidated: false,
          createdAt: at,
        },
        {
          id: 3,
          kind: "tool_result",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: '{"version":1,"body":"likes tea"}' }],
          stopReason: null,
          consolidated: false,
          createdAt: at,
        },
        answer(4, "You like tea."),
        user(5, "are you there?"),
      ],
    });
    const result = await importLegacyConversations({
      source: { agentExportLegacy: () => [legacy] },
      pi: t.harness,
      ledger: t.ledger,
      agents: t.agents.interface,
      createSession: t.createSession,
      submit: (input) => t.assistant.submit(input),
    });
    await t.idle();
    expect(result).toEqual({ imported: 1 });
    expect(t.sent.map((s) => s.text)).toEqual(["Still here."]);
    expect(seen[0]).toContain("You like tea.");
    expect(seen[0]).toContain("likes tea");
    expect(seen[0]).toContain("are you there?");

    const again = await importLegacyConversations({
      source: { agentExportLegacy: () => [legacy] },
      pi: t.harness,
      ledger: t.ledger,
      agents: t.agents.interface,
      createSession: t.createSession,
      submit: (input) => t.assistant.submit(input),
    });
    expect(again).toEqual({ imported: 0 });
    await t.close();
  });
});
