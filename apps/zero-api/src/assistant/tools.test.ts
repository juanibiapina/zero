import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { defineTool, type AgentToolSet } from "../agents/protocol";
import { ExternalCallNotSent } from "../agents/external-call";
import { BACKGROUND } from "./context";
import { toDurableTools, UNCERTAIN_EXTERNAL_CALL } from "./tools";

const fakeApi = (memos = new Map<string, unknown>()) =>
  ({
    conversationId: 1,
    memo: async (name: string, ...rest: unknown[]) => {
      if (rest.length === 1) return memos.get(name);
      if (!memos.has(name)) memos.set(name, rest[0]);
      return memos.get(name);
    },
  }) as unknown as ToolExecutionApi;

const textOf = async (result: Promise<{ content?: { type: string; text?: string }[] }>) =>
  (await result).content?.map((part) => part.text).join("");

const setup = (execute: () => Promise<unknown>) => {
  let calls = 0;
  const tools: AgentToolSet = {
    gmail_send: defineTool({
      description: "send",
      inputSchema: z.object({ to: z.string() }),
      execute: async () => {
        calls++;
        return execute();
      },
    }),
    list_topics: defineTool({
      description: "list",
      inputSchema: z.object({}),
      execute: async () => {
        calls++;
        return { topics: [] };
      },
    }),
  };
  const registrations = toDurableTools(tools, async () => tools);
  const byName = (name: string): ToolRegistration =>
    registrations.find((registration) => registration.name === name)!;
  return { byName, calls: () => calls };
};

describe("guarded write tools", () => {
  it("returns the recorded result on a replay instead of sending again", async () => {
    const { byName, calls } = setup(async () => ({ sent: true }));
    const api = fakeApi();
    const send = byName("gmail_send");
    expect(await textOf(send.execute({ to: "a" }, api, BACKGROUND))).toBe('{"sent":true}');
    expect(await textOf(send.execute({ to: "a" }, api, BACKGROUND))).toBe('{"sent":true}');
    expect(calls()).toBe(1);
  });

  it("reports an unknown outcome when an earlier attempt started and never finished", async () => {
    const { byName, calls } = setup(async () => ({ sent: true }));
    const api = fakeApi(new Map([["zero.started", true]]));
    expect(await textOf(byName("gmail_send").execute({ to: "a" }, api, BACKGROUND))).toBe(
      UNCERTAIN_EXTERNAL_CALL,
    );
    expect(calls()).toBe(0);
  });

  it("treats a failure without proof of no effect as an unknown outcome", async () => {
    const { byName } = setup(async () => {
      throw new Error("socket closed while reading the response");
    });
    expect(await textOf(byName("gmail_send").execute({ to: "a" }, fakeApi(), BACKGROUND))).toBe(
      UNCERTAIN_EXTERNAL_CALL,
    );
  });

  it("reports a provable non-effect as an ordinary error", async () => {
    const { byName } = setup(async () => {
      throw new ExternalCallNotSent("Google is not connected.");
    });
    const result = await byName("gmail_send").execute({ to: "a" }, fakeApi(), BACKGROUND);
    expect(result.isError).toBe(true);
    expect(result.content?.[0]).toEqual({ type: "text", text: "Google is not connected." });
  });

  it("lets a read rerun freely", async () => {
    const { byName, calls } = setup(async () => null);
    const api = fakeApi();
    await byName("list_topics").execute({}, api, BACKGROUND);
    await byName("list_topics").execute({}, api, BACKGROUND);
    expect(calls()).toBe(2);
  });
});
