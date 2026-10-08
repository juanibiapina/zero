import { taskCompletionMessage } from "@zero/agent-core";
import { restockWithUndo, taskCompletion, undoableAction, type Project, type Task, type TaskdoReplica } from "@zero/agent-core";
import { useState } from "react";
import { useNavigate } from "react-router";
import { PillCountSheet } from "@/components/pill-count-sheet";
import { useTodoAdd } from "@/components/todo-composer";

export function useTaskCompletionFeedback({ replica, projects, today, onError }: {
  replica: TaskdoReplica;
  projects: Project[];
  today: string;
  onError: (message: string) => void;
}) {
  const navigate = useNavigate();
  const [waitingProjectId, setWaitingProjectId] = useState<string>();
  const [restocking, setRestocking] = useState<{ taskId: string; medicineId: string } | null>(null);
  const add = useTodoAdd({ replica, projectId: waitingProjectId, initialKind: "waiting" });
  const complete = (task: Task) => {
    const completion = taskCompletion(task);
    if (completion.kind === "restock") {
      setRestocking({ taskId: task.id, medicineId: completion.medicineId });
      return;
    }
    const project = projects.find((candidate) => candidate.id === completion.projectId);
    undoableAction({
      message: () => taskCompletionMessage(replica.tasks.collection.get(task.id), today),
      description: project ? `${project.icon} ${project.title}` : undefined,
      descriptionAction: project ? { accessibilityLabel: `Open project ${project.title}`, onPress: () => void navigate(`/projects/${project.id}`) } : undefined,
      secondaryAction: project ? { label: "Waiting for…", onPress: () => { setWaitingProjectId(project.id); add.open("waiting"); } } : undefined,
      act: () => replica.tasks.complete(task.id, today),
      undo: () => task.recurrence ? replica.tasks.undoOccurrence(task, today) : replica.tasks.reopen(task),
      onError,
    });
  };
  const medicine = restocking ? replica.snapshot().medicines.find((item) => item.id === restocking.medicineId) : undefined;
  const restockSheet = restocking ? <PillCountSheet title="How many pills did you get?" initial={medicine?.supply?.refill ?? null}
    onClose={() => setRestocking(null)}
    onSave={(amount) => {
      setRestocking(null);
      void restockWithUndo({ replica, medicineId: restocking.medicineId, amount, taskId: restocking.taskId, onError });
    }} /> : null;
  return { complete, composer: <>{add.composer}{restockSheet}</> };
}
