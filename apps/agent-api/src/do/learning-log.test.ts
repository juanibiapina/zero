import { describe, expect, it } from "vitest";
import {
  appendWireLog,
  clearWireLog,
  readWireLog,
  wireKey,
  type LogStorage,
} from "./learning-log";

const fakeStorage = (): LogStorage & { size: () => number } => {
  const data = new Map<string, unknown>();
  return {
    size: () => data.size,
    list: async <T>({ prefix }: { prefix: string }) => {
      const out = new Map<string, T>();
      for (const [key, value] of data) {
        if (key.startsWith(prefix)) out.set(key, value as T);
      }
      return out;
    },
    put: async (key, value) => void data.set(key, value),
    delete: async (keys: string[]) => {
      let n = 0;
      for (const key of keys) if (data.delete(key)) n++;
      return n;
    },
  };
};

describe("learner wire log", () => {
  it("keys are fixed width so storage order is chronological", () => {
    expect(wireKey(0) < wireKey(9)).toBe(true);
    expect(wireKey(9) < wireKey(10)).toBe(true);
    expect(wireKey(99) < wireKey(100)).toBe(true);
  });

  it("appends one message per key and reads them back in order", async () => {
    const storage = fakeStorage();
    for (let i = 0; i < 12; i++) {
      await appendWireLog(storage, { role: "assistant", content: `m${i}` });
    }
    const log = await readWireLog(storage);
    expect(log.map((m) => m.content)).toEqual(
      Array.from({ length: 12 }, (_, i) => `m${i}`),
    );
    // One key per message, not one growing value: a Durable Object storage value
    // is capped and a learner transcript is not.
    expect(storage.size()).toBe(12);
  });

  it("clears the log when a job ends, leaving nothing for the next one", async () => {
    const storage = fakeStorage();
    await appendWireLog(storage, { role: "assistant", content: "x" });
    await clearWireLog(storage);
    expect(await readWireLog(storage)).toEqual([]);
    await clearWireLog(storage);
  });
});
