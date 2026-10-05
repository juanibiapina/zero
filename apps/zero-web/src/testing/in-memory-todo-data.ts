import {
  createInMemoryTaskdoClientState,
  type InMemoryTodoSeed,
  type TaskdoReplica,
} from "@zero/agent-core";

import type { TodoData } from "@/lib/todo-data";

export type { InMemoryTodoSeed };

export function createInMemoryTodoData(seed: InMemoryTodoSeed = {}): {
  data: TodoData;
  replica: TaskdoReplica;
} {
  const { state, replica } = createInMemoryTaskdoClientState(seed);
  return { data: state, replica };
}
