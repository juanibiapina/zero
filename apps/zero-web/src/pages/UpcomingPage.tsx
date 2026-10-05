import { taskRecurrenceLabel } from "@zero/agent-core";
import { TaskRecurrence } from "@/components/task-recurrence";
import { useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { isNull } from "@tanstack/db";
import { dayLabel, upcomingSections, type TaskdoReplica } from "@zero/agent-core";
import { ErrorText } from "@/components/ConnectionStatus";
import { useTaskEditor } from "@/components/task-editor";
import { useTodoData } from "@/lib/todo-data";
import { useLocalDay } from "@/lib/local-day";

export function UpcomingPage() {
  const { replica } = useTodoData();
  return <div className="min-h-screen bg-background"><main className="container mx-auto px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10">
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6"><h1 className="text-2xl font-bold tracking-tight">Upcoming</h1>
      {replica ? <Upcoming replica={replica} /> : <div className="min-h-24" />}
    </div>
  </main></div>;
}

function Upcoming({ replica }: { replica: TaskdoReplica }) {
  const { data: tasks = [], isLoading } = useLiveQuery((q) => q.from({ t: replica.tasks.collection }).where(({ t }) => isNull(t.completedAt)));
  const { data: projects = [] } = useLiveQuery((q) => q.from({ p: replica.projects.collection }));
  const { data: conditions = [] } = useLiveQuery((q) => q.from({ w: replica.waits.collection }));
  const today = useLocalDay();
  const sections = upcomingSections(tasks, today);
  const [error, setError] = useState<string | null>(null);
  const detail = useTaskEditor({ replica, projects, tasks, conditions, onError: setError });
  return <div className="flex flex-col gap-6">
    {error ? <ErrorText>{error}</ErrorText> : null}
    {isLoading && tasks.length === 0 ? <div className="min-h-24" /> : sections.length === 0 ? <p className="text-sm text-muted-foreground">Nothing scheduled ahead.</p> : sections.map((section) => <section key={section.date} className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-muted-foreground">{dayLabel(section.date, today)}</h2>
      <ul className="flex flex-col gap-3">{section.tasks.map((task) => <li key={task.id} className="flex items-center gap-3 rounded-xl border bg-card px-4 py-4">
        <button type="button" aria-label={`Complete "${task.text}"`} className="size-6 shrink-0 rounded-full border-2 border-muted-foreground/50 hover:border-primary" onClick={() => detail.complete(task)} />
        {task.projectId ? <span aria-hidden>{projects.find((project) => project.id === task.projectId)?.icon}</span> : null}
        <button type="button" className="min-w-0 flex-1 break-words text-left" aria-label={[`Edit "${task.text}"`, taskRecurrenceLabel(task)].filter(Boolean).join(", ")} onClick={() => detail.open(task)}><span>{task.text}</span><TaskRecurrence task={task} /></button>
      </li>)}</ul>
    </section>)}
    {detail.editor}
  </div>;
}
