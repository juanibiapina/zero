import { taskRecurrenceLabel } from "@zero/agent-core";
import { TaskRecurrence } from "@/components/task-recurrence";
import { useCallback, useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { isNull } from "@tanstack/db";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { homeTasks, listView, taskIcon, LOADING_TEXT_DELAY_MS, messageOf, orderKeyBetween, tomorrow, type Task, type TaskdoReplica } from "@zero/agent-core";
import { ErrorText } from "@/components/ConnectionStatus";
import { TodoComposer } from "@/components/todo-composer";
import { useTaskEditor } from "@/components/task-editor";
import { useTodoData } from "@/lib/todo-data";
import { useDelayed } from "@/lib/screen-hooks";
import { useLocalDay } from "@/lib/local-day";

export function HomePage() {
  const { replica } = useTodoData();
  return <div className="min-h-screen bg-background"><main className="container mx-auto px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10">
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6"><h1 className="text-2xl font-bold tracking-tight">Home</h1>
      {replica ? <Home replica={replica} /> : <div className="min-h-24" />}
    </div>
  </main></div>;
}

function Home({ replica }: { replica: TaskdoReplica }) {
  const [error, setError] = useState<string | null>(null);
  const { data: tasks = [], isLoading } = useLiveQuery((q) => q.from({ t: replica.tasks.collection }).where(({ t }) => isNull(t.completedAt)));
  const { data: projects = [], isLoading: projectsLoading } = useLiveQuery((q) => q.from({ p: replica.projects.collection }));
  const { data: conditions = [], isLoading: conditionsLoading } = useLiveQuery((q) => q.from({ w: replica.waits.collection }));
  const today = useLocalDay();
  const list = homeTasks(tasks, projects, today);
  const detail = useTaskEditor({ replica, projects, tasks, conditions, onError: setError });
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = list.findIndex((task) => task.id === active.id);
    const newIndex = list.findIndex((task) => task.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const moved = arrayMove(list, oldIndex, newIndex);
    const position = moved.findIndex((task) => task.id === active.id);
    replica.tasks.reorder(String(active.id), orderKeyBetween(moved[position - 1]?.sortKey ?? null, moved[position + 1]?.sortKey ?? null)).isPersisted.promise.catch((cause) => setError(messageOf(cause)));
  }, [replica, list]);
  const view = listView({ count: list.length, isLoading });
  const showLoading = useDelayed(view === "loading", LOADING_TEXT_DELAY_MS);
  const hydrating = isLoading || projectsLoading || conditionsLoading;

  return <div className="flex flex-col gap-6">
    <TodoComposer replica={replica} />
    {error ? <ErrorText>{error}</ErrorText> : null}
    {view === "loading" || (view === "empty" && hydrating) ? showLoading ? <p className="text-sm text-muted-foreground">Loading your tasks…</p> : <div className="min-h-24" /> : list.length ? <section aria-label="Tasks">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={list.map((task) => task.id)} strategy={verticalListSortingStrategy}>
          <ul className="flex flex-col gap-3">{list.map((task) => <Row key={task.id} id={task.id} text={task.text} task={task} icon={taskIcon(task, projects) ?? undefined}
            onComplete={() => detail.complete(task)} onOpen={() => detail.open(task)} onPostpone={() => { void replica.tasks.reschedule(task.id, tomorrow(today)).isPersisted.promise.catch((cause) => setError(messageOf(cause))); }} />)}</ul>
        </SortableContext>
      </DndContext>
    </section> : <section aria-label="All done" className="flex flex-col items-center gap-4 py-16">
      <div aria-hidden className="flex size-20 items-center justify-center rounded-full bg-muted text-4xl text-muted-foreground">✓</div>
      <h2 className="text-2xl font-semibold">All done</h2>
    </section>}
    {detail.editor}
  </div>;
}

function Row({ id, text, task, icon, onComplete, onOpen, onPostpone }: { id: string; text: string; task: Task; icon?: string; onComplete: () => void; onOpen: () => void; onPostpone: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 1 : undefined }} className="group flex items-center gap-3 rounded-xl border bg-card px-4 py-4">
    <button type="button" aria-label={`Reorder "${text}"`} className="shrink-0 cursor-grab touch-none rounded-md px-1 text-muted-foreground active:cursor-grabbing" {...attributes} {...listeners}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>{[4, 8, 12].map((y) => <g key={y}><circle cx="5" cy={y} r="1.4" /><circle cx="11" cy={y} r="1.4" /></g>)}</svg>
    </button>
    <button type="button" aria-label={`Complete "${text}"`} className="size-6 shrink-0 rounded-full border-2 border-muted-foreground/50 hover:border-primary" onClick={onComplete} />
    {icon ? <span aria-hidden>{icon}</span> : null}
    <button type="button" className="min-w-0 flex-1 break-words text-left" aria-label={[`Edit "${text}"`, taskRecurrenceLabel(task)].filter(Boolean).join(", ")} onClick={onOpen}><span>{text}</span><TaskRecurrence task={task} /></button>
    <button type="button" aria-label={`Postpone "${text}" to tomorrow`} className="shrink-0 rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-foreground" onClick={onPostpone}>Tomorrow</button>
  </li>;
}
