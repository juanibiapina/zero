import { focusManager, QueryClient } from '@tanstack/react-query';
import { AppState, type AppStateStatus } from 'react-native';

// One QueryClient for the app. Defaults tuned for a mobile client on a flaky
// radio: retry transient failures with exponential backoff, refetch when the
// network reconnects, and treat data as fresh for a short window so a resume
// doesn't spam refetches.
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 3,
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30_000),
        refetchOnReconnect: true,
        staleTime: 30_000,
      },
    },
  });
}

// React Query's focusManager listens to web focus events, which don't exist in
// React Native. Bridge it to AppState so queries refetch when the app returns to
// the foreground — the moment a backgrounded app's data is most likely stale and
// the moment its first request can otherwise fail on a still-waking radio.
// Returns an unsubscribe.
export function setupAppStateFocus(): () => void {
  const onChange = (status: AppStateStatus) => {
    focusManager.setFocused(status === 'active');
  };
  const sub = AppState.addEventListener('change', onChange);
  return () => sub.remove();
}
