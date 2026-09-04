import { useAuth } from '@clerk/expo';
import { useQueryClient } from '@tanstack/react-query';
import { type ProjectsApi } from '@zero/agent-core';
import { useEffect, useState } from 'react';

import {
  getMobileProjectsApi,
  setProjectsTokenGetter,
} from './projects-collection';

// Read the shared singleton Project data layer inside the signed-in tree, where
// the Clerk token getter is valid. The singleton is built once and reused across
// tabs; this hook only keeps the module's token getter pointed at Clerk's latest
// getToken (its function identity changes across renders) and returns the api
// once it resolves. Sibling of useCapturesApi.
export function useProjectsApi(): ProjectsApi | null {
  const queryClient = useQueryClient();
  const { getToken } = useAuth();
  setProjectsTokenGetter(getToken);

  const [api, setApi] = useState<ProjectsApi | null>(null);
  useEffect(() => {
    let live = true;
    void getMobileProjectsApi(queryClient).then((a) => {
      if (live) setApi(a);
    });
    return () => {
      live = false;
    };
  }, [queryClient]);

  return api;
}
