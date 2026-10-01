import { messageOf, toast } from "@zero/agent-core";

export function reportTodoError(error: unknown) {
  return toast("Could not save your change", { description: `${messageOf(error)}. Try again.`, durationMs: Infinity });
}
