import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { MEDICINE_TASK_ICON, TaskDraft, messageOf, taskMedicineId, taskProjectId, toast, undoableAction, type Project, type Task, type TaskdoReplica, type WaitingCondition } from "@zero/agent-core";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { TaskFields } from "@/components/task-fields";
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
  const [draft, setDraft] = useState(() => TaskDraft.create());
  const selected = tasks.find((task) => task.id === selectedId) ?? null;
  const draftView = useMemo(() => draft.view(today, selected), [draft, today, selected]);
  const selectedProject = projects.find((project) => project.id === (selected ? taskProjectId(selected) : null));
  const selectedMedicineId = selected ? taskMedicineId(selected) : null;
  const selectedMedicine = selectedMedicineId ? replica.snapshot().medicines.find((medicine) => medicine.id === selectedMedicineId) : undefined;
  const fail = (error: unknown) => { onError(messageOf(error)); reportTodoError(error); };
  const completion = useTaskCompletionFeedback({ replica, projects, today, onError: fail });

  const commitDraft = (): Task | null => {
    if (!selected) return null;
    const current = replica.tasks.collection.get(selected.id);
    if (!current) return null;
    const prepared = draft.view(today, current).commit;
    if (prepared.kind === "invalid") {
      onError(prepared.message);
      return null;
    }
    if (prepared.kind === "ready") {
      replica.tasks.edit(current.id, prepared.text, prepared.schedule).isPersisted.promise.catch(fail);
    }
    const applied = replica.tasks.collection.get(current.id);
    if (!applied) return null;
    setDraft(draft.acknowledge(applied));
    return applied;
  };
  const close = () => { if (commitDraft()) setSelectedId(null); };
  const open = (task: Task) => {
    setDraft(TaskDraft.edit(task));
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
    if (!task || projectId === taskProjectId(task)) return;
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
          <TaskFields draft={draftView} inputProps={{ autoFocus: true, "aria-label": "Task text" }}
            onChangeText={(text) => setDraft((current) => current.change(text))}
            onDismissRange={(range) => setDraft((current) => current.dismiss(range))}
            leading={<Button type="button" variant="outline" size="icon" aria-label="Complete task" onClick={complete}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="12" cy="12" r="9" /></svg>
            </Button>}
            dateField={{ onOpen: commitDraft,
              onPick: (date) => {
                const task = commitDraft();
                if (!task || task.showUpDate === date) return;
                replica.tasks.reschedule(task.id, date).isPersisted.promise.catch(fail);
                setSelectedId(null);
              },
              onStopRecurrence: selected.recurrence ? () => {
                const task = commitDraft();
                if (task) replica.tasks.setRecurrence(task.id, null).isPersisted.promise.catch(fail);
              } : undefined,
              onCompleteForever: selected.recurrence ? () => {
                const task = commitDraft();
                if (!task) return;
                setSelectedId(null);
                undoableAction({ message: "Completed forever", act: () => replica.tasks.completeForever(task.id), undo: () => replica.tasks.reopen(task), onError: fail });
              } : undefined,
            }}
            projectField={selectedMedicine ? undefined : { projects, tasks, conditions, projectId: taskProjectId(selected), onPick: move, onOpen: commitDraft }}
          >
            {selectedMedicine ? <Button type="button" variant="outline" aria-label={`Open medicine ${selectedMedicine.name}`} onClick={() => { if (commitDraft()) { setSelectedId(null); void navigate(`/medicines/${selectedMedicine.id}`); } }}><span aria-hidden>{MEDICINE_TASK_ICON}</span>For {selectedMedicine.name}</Button> : null}
            {selectedProject && selectedProject.id !== currentProjectId ? <Button type="button" variant="ghost" aria-label={`Open project ${selectedProject.title}`} onClick={() => { if (commitDraft()) { setSelectedId(null); void navigate(`/projects/${selectedProject.id}`); } }}>Open project</Button> : null}
          </TaskFields>
        </form> : null}
      </Sheet>
      {completion.composer}
    </>,
  };
}
