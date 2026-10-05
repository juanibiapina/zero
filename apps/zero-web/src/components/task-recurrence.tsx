import { taskRecurrenceLabel, type Task } from "@zero/agent-core";

export function TaskRecurrence({ task }: { task: Task }) {
  const label = taskRecurrenceLabel(task);
  if (!label) return null;
  return <span className="mt-0.5 flex items-start gap-1 text-xs text-muted-foreground">
    <svg className="mt-0.5 size-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m17 2 4 4-4 4M3 11V8a2 2 0 0 1 2-2h16M7 22l-4-4 4-4m14-1v3a2 2 0 0 1-2 2H3" />
    </svg>
    <span className="min-w-0 break-words">{label}</span>
  </span>;
}
