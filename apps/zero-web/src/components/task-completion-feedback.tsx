import { taskCompletionMessage } from "@zero/agent-core";
import { undoableAction, type Project, type Task, type TaskdoReplica } from "@zero/agent-core";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useTodoAdd } from "@/components/todo-composer";

export function useTaskCompletionFeedback({ replica, projects, today, onError }: {
  replica: TaskdoReplica;
  projects: Project[];
  today: string;
  onError: (message: string) => void;
}) {
  const navigate = useNavigate();
  const [waitingProjectId, setWaitingProjectId] = useState<string>();
  const add = useTodoAdd({ replica, projectId: waitingProjectId, initialKind: "waiting" });
  const complete = (task: Task) => {
    const project = projects.find((candidate) => candidate.id === task.projectId);
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
  return { complete, composer: add.composer };
}
