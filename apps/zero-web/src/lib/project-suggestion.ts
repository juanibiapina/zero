import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  ProjectSuggester,
  projectSuggestionCandidates,
  type Project,
  type ProjectSelection,
  type ProjectSuggestionRequest,
  type Task,
} from "@zero/agent-core";

export const requestProjectSuggestion: ProjectSuggestionRequest = async (input, signal) => {
  const res = await fetch("/api/tasks/project-suggestion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  if (!res.ok) return null;
  return ((await res.json()) as { projectId: string | null }).projectId;
};

export function useProjectSuggestion({ initial, title, projects, tasks, enabled }: {
  initial: ProjectSelection;
  title: string;
  projects: Project[];
  tasks: Task[];
  enabled: boolean;
}) {
  const [suggester] = useState(() => new ProjectSuggester({ request: requestProjectSuggestion, initial }));
  const candidates = useMemo(() => projectSuggestionCandidates(projects, tasks), [projects, tasks]);
  const { selection, loading } = useSyncExternalStore(suggester.subscribe, suggester.getState);
  useEffect(() => suggester.update({ title, candidates, enabled }), [suggester, title, candidates, enabled]);
  useEffect(() => () => suggester.dispose(), [suggester]);
  const pick = useCallback((projectId: string | null) => suggester.pick(projectId), [suggester]);
  const reset = useCallback((next: ProjectSelection) => suggester.reset(next), [suggester]);
  return { selection, loading, pick, reset };
}
