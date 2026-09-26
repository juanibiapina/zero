import {
  createInMemoryTaskdoReplica,
  type InMemoryTodoSeed,
  type TaskdoReplica,
} from "@zero/agent-core";

import type { TodoData } from "@/lib/todo-data";

export type { InMemoryTodoSeed };

export function createInMemoryTodoData(seed: InMemoryTodoSeed = {}): {
  data: TodoData;
  replica: TaskdoReplica;
} {
  const replica = createInMemoryTaskdoReplica(seed);
  const data: TodoData = {
    replica,
    ready: true,
    connected: true,
    durable: true,
    error: null,
    durabilityError: null,
    recoveries: replica.snapshot().recoveries,
  };
  return { data, replica };
}
