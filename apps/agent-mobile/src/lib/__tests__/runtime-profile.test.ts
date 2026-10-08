import { describe, expect, it } from '@jest/globals';

import {
  DEFAULT_API_BASE_URL,
  HERMETIC_API_BASE_URL,
} from '../../../runtime-profile';
import { resolveApplicationRuntimeProfile as resolveRuntimeProfile } from '../runtime-profile';

describe('mobile runtime profile', () => {
  it('preserves every normal runtime value', () => {
    expect(resolveRuntimeProfile()).toEqual({
      name: 'normal',
      hermetic: false,
      clerkModules: 'real',
      apiBaseUrl: DEFAULT_API_BASE_URL,
      storageKeys: {
        timezoneKey: 'zero.timezone.synced',
        iconSuggestionsKey: 'zero.icon-suggestions.v1',
        projectSectionFoldsKey: 'zero.project-section-folds.v1',
        todoWorkspaceKey: 'zero.todo-workspace.v1',
      },
      todoWorkspaceId: undefined,
      launcherCountSyncEnabled: true,
      native: {
        updatesEnabled: true,
        cleartextEnabled: false,
      },
    });
  });

  it('keeps the normal API URL override', () => {
    expect(
      resolveRuntimeProfile({ apiUrl: 'https://staging.example.com' })
        .apiBaseUrl,
    ).toBe('https://staging.example.com');
  });

  it('selects fake auth, localhost, isolated state, and suppressed side effects together', () => {
    const normal = resolveRuntimeProfile();
    const hermetic = resolveRuntimeProfile({
      hermeticE2E: '1',
    });

    expect(hermetic).toEqual({
      name: 'hermetic-e2e',
      hermetic: true,
      clerkModules: 'fake',
      apiBaseUrl: HERMETIC_API_BASE_URL,
      storageKeys: {
        timezoneKey: 'zero.e2e.timezone.synced',
        iconSuggestionsKey: 'zero.e2e.icon-suggestions.v1',
        projectSectionFoldsKey: 'zero.e2e.project-section-folds.v1',
        todoWorkspaceKey: 'zero.e2e.todo-workspace.v1',
      },
      todoWorkspaceId: 'hermetic-e2e-guest',
      launcherCountSyncEnabled: false,
      native: {
        updatesEnabled: false,
        cleartextEnabled: true,
      },
    });
    for (const key of Object.keys(normal.storageKeys) as (
      keyof typeof normal.storageKeys
    )[]) {
      expect(hermetic.storageKeys[key]).not.toBe(normal.storageKeys[key]);
    }
  });

  it('enables only launcher synchronization for the explicit hermetic proof', () => {
    const ordinary = resolveRuntimeProfile({ hermeticE2E: '1' });
    expect(resolveRuntimeProfile({ hermeticE2E: '1', launcherIconProof: '1' }))
      .toEqual({ ...ordinary, launcherCountSyncEnabled: true });
    expect(resolveRuntimeProfile({ hermeticE2E: '1', launcherIconProof: '0' }))
      .toEqual(ordinary);
    expect(() => resolveRuntimeProfile({ launcherIconProof: '1' }))
      .toThrow('requires EXPO_PUBLIC_HERMETIC_E2E=1');
  });

  it.each(['true', 'yes', '', '2'])('rejects unknown launcher proof value %p', (value) => {
    expect(() => resolveRuntimeProfile({ hermeticE2E: '1', launcherIconProof: value }))
      .toThrow('must be unset, "0", or "1"');
  });

  it('does not let an ordinary URL override change hermetic localhost', () => {
    expect(
      resolveRuntimeProfile({
        hermeticE2E: '1',
        apiUrl: HERMETIC_API_BASE_URL,
      }).apiBaseUrl,
    ).toBe(HERMETIC_API_BASE_URL);
    expect(() =>
      resolveRuntimeProfile({
        hermeticE2E: '1',
        apiUrl: 'https://zero.juanibiapina.dev',
      }),
    ).toThrow('cannot override');
  });

  it.each(['0', 'true', 'yes', ''])('rejects unknown toggle value %p', (value) => {
    expect(() => resolveRuntimeProfile({ hermeticE2E: value })).toThrow(
      'must be unset or "1"',
    );
  });
});
