import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { messageOf, toast, undoableAction, type Project, type Task, type TaskdoReplica, type WaitingCondition } from "@zero/agent-core";
import { parseSchedule, toText, type TextRange } from "@zeroapps/recurrence";
import { Button } from "@/components/ui/button";
import { ScheduleHighlightInput } from "@/components/ScheduleHighlightInput";
import { Sheet } from "@/components/ui/sheet";
import { TaskDateField, TaskProjectField } from "@/components/task-fields";
import { useTaskCompletionFeedback } from "@/components/task-completion-feedback";
import { useLocalDay } from "@/lib/local-day";

import { reportTodoError } from "@/lib/todo-feedback";

export function useTaskEditor({ replica, projects, tasks, conditions, currentProjectId, onError }: {
  replica: TaskdoReplica;
  projects: Project[];
  tasks: Task[];
  conditions: WaitingCondition[];
  currentProjectId?: string;
  onError: (message: string) => void;
}) {
  const today = useLocalDay();
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const savedDraft = useRef("");
  const [recognizing, setRecognizing] = useState(false);
  const [ignored, setIgnored] = useState<TextRange[]>([]);
  const parsed = recognizing ? parseSchedule(draft, { today, weekStartsOn: "MO", ignored }) : { kind: "none" as const };
  const schedule = parsed.kind === "scheduled" && parsed.remainingText.trim() ? parsed.schedule : undefined;
  const selected = tasks.find((task) => task.id === selectedId) ?? null;
  const effectiveDate = schedule?.kind === "once" ? schedule.date : schedule?.kind === "recurring" ? schedule.recurrence.origin : selected?.showUpDate ?? null;
  const effectiveRecurrence = schedule?.kind === "recurring" ? schedule.recurrence : selected?.recurrence;
  const selectedProject = projects.find((project) => project.id === selected?.projectId);
  const fail = (error: unknown) => { onError(messageOf(error)); reportTodoError(error); };
  const completion = useTaskCompletionFeedback({ replica, projects, today, onError: fail });

  const commitDraft = (): Task | null => {
    if (!selected) return null;
    const current = replica.tasks.collection.get(selected.id);
    if (!current) return null;
    if (parsed.kind === "scheduled" && !parsed.remainingText.trim()) {
      onError("Enter a task title alongside the schedule.");
      return null;
    }
    const text = (parsed.kind === "scheduled" ? parsed.remainingText : draft).trim() || current.text;
    const edited = recognizing && (text !== savedDraft.current || schedule !== undefined);
    if (edited && (text !== current.text || schedule)) {
      replica.tasks.edit(current.id, text, schedule).isPersisted.promise.catch(fail);
    }
    savedDraft.current = edited ? text : current.text;
    setDraft(savedDraft.current);
    setRecognizing(false);
    setIgnored([]);
    return replica.tasks.collection.get(current.id) ?? null;
  };
  const close = () => { if (commitDraft()) setSelectedId(null); };
  const open = (task: Task) => {
    savedDraft.current = task.text;
    setDraft(task.text);
    setRecognizing(false);
    setIgnored([]);
    setSelectedId(task.id);
  };
  const complete = () => {
    const task = commitDraft();
    if (!task) return;
    setSelectedId(null);
    completion.complete(task);
  };
  const move = (projectId: string | null) => {
    const task = commitDraft();
    if (!task || projectId === task.projectId) return;
    const tx = replica.tasks.moveToProject(task.id, projectId);
    setSelectedId(null);
    void tx.isPersisted.promise.then(() => {
      const project = projects.find((item) => item.id === projectId);
      const future = task.showUpDate != null && task.showUpDate > today;
      toast(projectId ? "Moved to project" : "Removed from project", {
        description: future ? "Upcoming" : project ? `${project.icon} ${project.title}` : "Home",
        action: { label: "View", onPress: () => void navigate(future ? "/upcoming" : projectId ? `/projects/${projectId}` : "/home") },
      });
    }, fail);
  };

  return {
    open,
    complete: completion.complete,
    editor: <>
      <Sheet open={selected != null} onClose={close} title="Edit task" srOnlyTitle>
        {selected ? <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); close(); }}>
          <div className="flex items-center gap-3">
            <Button type="button" variant="outline" size="icon" aria-label="Complete task" onClick={complete}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="12" cy="12" r="9" /></svg>
            </Button>
            <ScheduleHighlightInput autoFocus value={draft} aria-label="Task text"
              ranges={parsed.kind === "scheduled" ? parsed.consumed : []}
              onDismissRange={(range) => setIgnored((current) => [...current, range])}
              onChange={(event) => { setDraft(event.target.value); setRecognizing(true); setIgnored([]); }} />
          </div>
          <div className="flex flex-wrap gap-2">
            {parsed.kind === "scheduled" ? <Button type="button" variant="ghost" onClick={() => setIgnored((current) => [...current, parsed.consumed[0]])}>Keep schedule words in task title</Button> : null}
            <TaskDateField date={effectiveDate} label={schedule?.kind !== "once" && effectiveRecurrence ? toText(effectiveRecurrence) : undefined} onOpen={commitDraft}
              onPick={(date) => {
                const task = commitDraft();
                if (!task || task.showUpDate === date) return;
                replica.tasks.reschedule(task.id, date).isPersisted.promise.catch(fail);
                setSelectedId(null);
              }}
              onStopRecurrence={selected.recurrence ? () => {
                const task = commitDraft();
                if (task) replica.tasks.setRecurrence(task.id, null).isPersisted.promise.catch(fail);
              } : undefined}
              onCompleteForever={selected.recurrence ? () => {
                const task = commitDraft();
                if (!task) return;
                setSelectedId(null);
                undoableAction({ message: "Completed forever", act: () => replica.tasks.completeForever(task.id), undo: () => replica.tasks.reopen(task), onError: fail });
              } : undefined}
            />
            <TaskProjectField projects={projects} tasks={tasks} conditions={conditions} projectId={selected.projectId} onPick={move} onOpen={commitDraft} />
            {selectedProject && selectedProject.id !== currentProjectId ? <Button type="button" variant="ghost" aria-label={`Open project ${selectedProject.title}`} onClick={() => { if (commitDraft()) { setSelectedId(null); void navigate(`/projects/${selectedProject.id}`); } }}>Open project</Button> : null}
          </div>
        </form> : null}
      </Sheet>
      {completion.composer}
    </>,
  };
}
