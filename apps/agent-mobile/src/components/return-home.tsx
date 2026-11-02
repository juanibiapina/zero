import { useRouter } from 'expo-router';
import { useEffect } from 'react';

// Uses the router from context: the global `router` is bound only after the
// root's first render, and this effect can run before that on a cold start.
export function ReturnHome() {
  const router = useRouter();
  useEffect(() => {
    router.dismissTo('/');
  }, [router]);
  return null;
}
