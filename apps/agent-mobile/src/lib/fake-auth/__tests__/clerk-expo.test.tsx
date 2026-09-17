// Guards the fake Clerk surface against drift from what the real screens use.
// If a screen starts reading a member the fake lacks, or the fake stops
// reporting signed-in, the release E2E build silently breaks; this catches it.
import { describe, expect, it } from '@jest/globals';

import { E2E_FAKE_TOKEN, useAuth, useSSO } from '../clerk-expo';
import { resourceCache } from '../clerk-expo-resource-cache';
import { tokenCache } from '../clerk-expo-token-cache';

describe('fake clerk auth', () => {
  it('reports signed-in and yields the static token', async () => {
    const auth = useAuth();
    expect(auth.isLoaded).toBe(true);
    expect(auth.isSignedIn).toBe(true);
    await expect(auth.getToken()).resolves.toBe(E2E_FAKE_TOKEN);
  });

  it('exposes a non-crashing useSSO stub', () => {
    expect(typeof useSSO().startSSOFlow).toBe('function');
  });

  it('keeps Clerk token and resource persistence inert', async () => {
    await expect(tokenCache.getToken()).resolves.toBeNull();
    await expect(resourceCache.get()).resolves.toBeNull();
    await expect(resourceCache.save()).resolves.toBeUndefined();
    await expect(resourceCache.remove()).resolves.toBeUndefined();
  });
});
