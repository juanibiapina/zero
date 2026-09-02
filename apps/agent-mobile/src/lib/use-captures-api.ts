import { useAuth } from '@clerk/expo';
import { useQueryClient } from '@tanstack/react-query';
import { type CapturesApi } from '@zero/agent-core';
import { useEffect, useState } from 'react';

import {
  getMobileCapturesApi,
  setCapturesTokenGetter,
} from './captures-collection';

// Read the shared singleton Capture data layer inside the signed-in tree, where
// the Clerk token getter is valid. The singleton is built once and reused across
// tabs; this hook only keeps the module's token getter pointed at Clerk's latest
// getToken (its function identity changes across renders) and returns the api
// once it resolves.
export function useCapturesApi(): CapturesApi | null {
  const queryClient = useQueryClient();
  const { getToken } = useAuth();
  setCapturesTokenGetter(getToken);

  const [api, setApi] = useState<CapturesApi | null>(null);
  useEffect(() => {
    let live = true;
    void getMobileCapturesApi(queryClient).then((a) => {
      if (live) setApi(a);
    });
    return () => {
      live = false;
    };
  }, [queryClient]);

  return api;
}
