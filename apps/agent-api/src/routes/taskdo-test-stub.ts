import type { Env } from "../types";

// Route tests declare only the RPCs they expect. Any accidental extra
// delegation fails at the call site instead of acquiring fake domain behavior.
export function taskDoEnv(methods: object): Env {
  const taskDO = new Proxy(methods, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) {
        const value: unknown = Reflect.get(target, property, receiver);
        return value;
      }
      throw new Error(`Unexpected TaskDO RPC: ${String(property)}`);
    },
  });
  return {
    TASK_DO: {
      idFromName: (name: string) => name,
      get: () => taskDO,
    },
  } as unknown as Env;
}
