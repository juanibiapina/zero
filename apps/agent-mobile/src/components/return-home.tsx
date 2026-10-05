import { router } from 'expo-router';
import { useEffect } from 'react';

export function ReturnHome() {
  useEffect(() => {
    router.dismissTo('/');
  }, []);
  return null;
}
