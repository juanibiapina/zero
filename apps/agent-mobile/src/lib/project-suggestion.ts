import {
  ProjectSuggester,
  projectSuggestionCandidates,
  type Project,
  type ProjectSelection,
  type Task,
} from '@zero/agent-core';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { fetchProjectSuggestion, type TokenGetter } from '@/lib/api';

export function useProjectSuggestion({
  getToken,
  initial,
  title,
  projects,
  tasks,
  enabled,
}: {
  getToken: TokenGetter;
  initial: ProjectSelection;
  title: string;
  projects: Project[];
  tasks: Task[];
  enabled: boolean;
}) {
  const [suggester] = useState(
    () =>
      new ProjectSuggester({
        request: (input, signal) => fetchProjectSuggestion(getToken, input, signal),
        initial,
      }),
  );
  const candidates = useMemo(
    () => projectSuggestionCandidates(projects, tasks),
    [projects, tasks],
  );
  const { selection, loading } = useSyncExternalStore(suggester.subscribe, suggester.getState);
  useEffect(
    () => suggester.update({ title, candidates, enabled }),
    [suggester, title, candidates, enabled],
  );
  useEffect(() => () => suggester.dispose(), [suggester]);
  const pick = useCallback((projectId: string | null) => suggester.pick(projectId), [suggester]);
  const reset = useCallback((next: ProjectSelection) => suggester.reset(next), [suggester]);
  return { selection, loading, pick, reset };
}
