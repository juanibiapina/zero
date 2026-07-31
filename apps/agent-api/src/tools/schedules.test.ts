import { describe, expect, it, vi } from "vitest";
import { buildScheduleTools } from "./schedules";
import { createScheduleBook } from "../schedules/book";
import { MemoryStore } from "../store/memory";

const NOW = new Date("2026-01-02T12:00:00Z").getTime();

const makeTools = (options: { wired?: boolean; onScheduleChanged?: () => void } = {}) => {
  const { wired = true } = options;
  const store = new MemoryStore(() => "2026-01-02T12:00:00.000Z");
  const conversationId = store.getOrCreateConversation(1, 0);
  let counter = 0;
  const schedules = createScheduleBook({
    store,
    conversationId,
    now: () => NOW,
    newId: () => `sch_${++counter}`,
  });
  const tools = buildScheduleTools({
    schedules: wired ? schedules : undefined,
    timezone: "Europe/Berlin",
    onScheduleChanged: options.onScheduleChanged,
  });
  return { tools, store };
};

type Exec<T> = (args: T) => Promise<unknown>;

const create = (tools: ReturnType<typeof buildScheduleTools>, args: Record<string, string>) =>
  (tools.create_schedule.execute as Exec<Record<string, string>>)(args);
const list = (tools: ReturnType<typeof buildScheduleTools>) =>
  (tools.list_schedules.execute as Exec<Record<string, never>>)({});
const cancel = (tools: ReturnType<typeof buildScheduleTools>, id: string) =>
  (tools.cancel_schedule.execute as Exec<{ id: string }>)({ id });

describe("schedule tools", () => {
  it("creates a schedule and reports its resolved time", async () => {
    const onScheduleChanged = vi.fn();
    const { tools } = makeTools({ onScheduleChanged });
    const result = await create(tools, {
      prompt: "send today's calendar",
      pattern: "0 8 * * 1-5",
    });
    expect(result).toEqual({
      id: "sch_1",
      prompt: "send today's calendar",
      description: "every weekday at 08:00 (Europe/Berlin)",
      nextRun: "Mon 2026-01-05 08:00 (Europe/Berlin)",
      timezone: "Europe/Berlin",
    });
    expect(onScheduleChanged).toHaveBeenCalled();
  });

  it("creates in an explicit zone when given one", async () => {
    const { tools } = makeTools();
    const result = (await create(tools, {
      prompt: "x",
      pattern: "0 8 * * *",
      timezone: "Asia/Tokyo",
    })) as { timezone: string };
    expect(result.timezone).toBe("Asia/Tokyo");
  });

  it("reports an invalid pattern without scheduling anything", async () => {
    const onScheduleChanged = vi.fn();
    const { tools } = makeTools({ onScheduleChanged });
    const result = (await create(tools, {
      prompt: "x",
      pattern: "every morning",
    })) as { error: string };
    expect(result.error).toContain("not a valid schedule pattern");
    expect(onScheduleChanged).not.toHaveBeenCalled();
    expect(await list(tools)).toEqual({ schedules: [] });
  });

  it("reports an invalid timezone with suggestions", async () => {
    const { tools } = makeTools();
    const result = (await create(tools, {
      prompt: "x",
      pattern: "0 8 * * *",
      timezone: "Tokyo",
    })) as { error: string; suggestions: string[] };
    expect(result.error).toContain("not a valid IANA timezone");
    expect(result.suggestions).toContain("Asia/Tokyo");
  });

  it("refuses a pattern below the frequency floor", async () => {
    const { tools } = makeTools();
    const result = (await create(tools, {
      prompt: "x",
      pattern: "*/1 * * * *",
    })) as { error: string };
    expect(result.error).toContain("more often than every 15 minutes");
  });

  it("lists schedules with rendered times", async () => {
    const { tools } = makeTools();
    await create(tools, { prompt: "call Ana", pattern: "2026-01-03T18:00:00" });
    expect(await list(tools)).toEqual({
      schedules: [
        {
          id: "sch_1",
          prompt: "call Ana",
          description: "Sat 2026-01-03 18:00 (Europe/Berlin)",
          nextRun: "Sat 2026-01-03 18:00 (Europe/Berlin)",
          timezone: "Europe/Berlin",
        },
      ],
    });
  });

  it("cancels a schedule and refuses an unknown id", async () => {
    const onScheduleChanged = vi.fn();
    const { tools } = makeTools({ onScheduleChanged });
    await create(tools, { prompt: "x", pattern: "0 8 * * *" });
    expect(await cancel(tools, "sch_1")).toEqual({ cancelled: true, id: "sch_1" });
    expect(onScheduleChanged).toHaveBeenCalledTimes(2);
    expect(await cancel(tools, "sch_1")).toEqual({
      error: "No active schedule with id sch_1.",
    });
    expect(await list(tools)).toEqual({ schedules: [] });
  });

  it("reports it cannot schedule when storage is absent", async () => {
    const { tools } = makeTools({ wired: false });
    for (const result of [
      await create(tools, { prompt: "x", pattern: "0 8 * * *" }),
      await list(tools),
      await cancel(tools, "sch_1"),
    ]) {
      expect(result).toEqual({ error: "Can't manage schedules in this context." });
    }
  });
});
