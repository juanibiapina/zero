// The learner's append-only wire log inside LearningDO, and the slice driver
// that advances one job a bounded amount per alarm. DO-free so the checkpoint
// rules are testable without a Durable Object.
//
// The log is stored one message per key rather than as one array: a Durable
// Object storage value is capped (128 KiB), a learner's transcript is not, and a
// per-message key also means a slice appends instead of rewriting.

import type { AgentMessage } from "../agents/protocol";

export const WIRE_PREFIX = "wire:";

// Fixed-width so lexicographic key order is chronological order.
export const wireKey = (seq: number): string =>
  `${WIRE_PREFIX}${String(seq).padStart(6, "0")}`;

// The slice of DurableObjectStorage the log needs.
export interface LogStorage {
  list<T = unknown>(options: {
    prefix: string;
  }): Promise<Map<string, T>>;
  put(key: string, value: unknown): Promise<void>;
  delete(keys: string[]): Promise<number>;
}

export const readWireLog = async (
  storage: LogStorage,
): Promise<AgentMessage[]> => {
  const rows = await storage.list<AgentMessage>({ prefix: WIRE_PREFIX });
  return [...rows.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, message]) => message);
};

// Append one message and return the new length, so the caller can key the next
// one. Reading the current length first keeps a resumed slice from overwriting
// what an earlier one wrote.
export const appendWireLog = async (
  storage: LogStorage,
  message: AgentMessage,
): Promise<void> => {
  const rows = await storage.list<AgentMessage>({ prefix: WIRE_PREFIX });
  await storage.put(wireKey(rows.size), message);
};

export const clearWireLog = async (storage: LogStorage): Promise<void> => {
  const rows = await storage.list({ prefix: WIRE_PREFIX });
  const keys = [...rows.keys()];
  if (keys.length > 0) await storage.delete(keys);
};
