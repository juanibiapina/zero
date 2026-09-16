import {
  messageOf,
  undoableAction,
  type Project,
  type Task,
  type TasksApi,
  type WaitsApi,
} from "@zero/agent-core";
import { useCallback, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";

export function useTaskCompletionFeedback({
  api,
  waitsApi,
  projects,
  today,
  onError,
}: {
  api: TasksApi;
  waitsApi: WaitsApi;
  projects: Project[];
  today: string;
  onError: (message: string) => void;
}): {
  complete: (task: Task) => void;
  composer: ReactNode;
} {
  const navigate = useNavigate();
  const [waitingProjectId, setWaitingProjectId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const waitingProject = projects.find(
    (project) => project.id === waitingProjectId,
  );

  const complete = useCallback(
    (task: Task) => {
      const project = task.projectId
        ? projects.find((candidate) => candidate.id === task.projectId)
        : null;
      undoableAction({
        message: "Completed",
        description: project ? `${project.icon} ${project.title}` : undefined,
        descriptionAction: project
          ? {
              accessibilityLabel: `Open project ${project.title}`,
              onPress: () => void navigate(`/projects/${project.id}`),
            }
          : undefined,
        secondaryAction: project
          ? {
              label: "Waiting for…",
              onPress: () => setWaitingProjectId(project.id),
            }
          : undefined,
        act: () => api.complete(task.id, today),
        undo: () =>
          task.recurrence
            ? api.undoOccurrence(task, today)
            : api.reopen(task),
        onError,
      });
    },
    [api, navigate, onError, projects, today],
  );

  const close = () => {
    setText("");
    setWaitingProjectId(null);
  };
  const add = () => {
    const trimmed = text.trim();
    if (!waitingProject || !trimmed) return;
    const tx = waitsApi.addWaiting(waitingProject.id, trimmed);
    tx.isPersisted.promise.catch((error) => onError(messageOf(error)));
    close();
  };

  const composer = (
    <Sheet
      open={waitingProject != null}
      onClose={close}
      title="Add waiting condition"
    >
      <div className="flex flex-col gap-4">
        <Input
          value={text}
          autoFocus
          aria-label="Waiting condition"
          placeholder="What are you waiting for?"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") add();
          }}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button disabled={!text.trim()} onClick={add}>Add</Button>
        </div>
      </div>
    </Sheet>
  );

  return { complete, composer };
}
