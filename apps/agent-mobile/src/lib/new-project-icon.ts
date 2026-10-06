import { IconSuggester } from '@zero/agent-core';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { fetchIconSuggestions, type TokenGetter } from '@/lib/api';

export function useNewProjectIcon({
  getToken,
  title,
  enabled,
}: {
  getToken: TokenGetter;
  title: string;
  enabled: boolean;
}) {
  const [suggester] = useState(
    () =>
      new IconSuggester({
        request: (input, signal) => fetchIconSuggestions(getToken, input, signal),
      }),
  );
  const choice = useSyncExternalStore(suggester.subscribe, suggester.getChoice);
  useEffect(() => suggester.update({ title, enabled }), [suggester, title, enabled]);
  useEffect(() => () => suggester.dispose(), [suggester]);
  const pick = useCallback((icon: string) => suggester.pick(icon), [suggester]);
  const reset = useCallback(() => suggester.reset(), [suggester]);
  return { choice, pick, reset };
}
