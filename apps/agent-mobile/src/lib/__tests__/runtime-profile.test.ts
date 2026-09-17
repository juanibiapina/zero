import { describe, expect, it } from '@jest/globals';

import {
  DEFAULT_API_BASE_URL,
  HERMETIC_API_BASE_URL,
  resolveRuntimeProfile,
} from '../../../runtime-profile';

describe('mobile runtime profile', () => {
  it('preserves every normal runtime value', () => {
    expect(resolveRuntimeProfile({ offlineOutboxVersion: 2 })).toEqual({
      name: 'normal',
      hermetic: false,
      clerkModules: 'real',
      apiBaseUrl: DEFAULT_API_BASE_URL,
      persistence: {
        databaseName: 'zero-app.sqlite',
        outboxDatabaseName: 'zero-app-outbox-v2.sqlite',
        timezoneKey: 'zero.timezone.synced',
        iconSuggestionsKey: 'zero.icon-suggestions.v1',
      },
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
    const normal = resolveRuntimeProfile({ offlineOutboxVersion: 2 });
    const hermetic = resolveRuntimeProfile({
      hermeticE2E: '1',
      offlineOutboxVersion: 2,
    });

    expect(hermetic).toEqual({
      name: 'hermetic-e2e',
      hermetic: true,
      clerkModules: 'fake',
      apiBaseUrl: HERMETIC_API_BASE_URL,
      persistence: {
        databaseName: 'zero-app-e2e.sqlite',
        outboxDatabaseName: 'zero-app-e2e-outbox-v2.sqlite',
        timezoneKey: 'zero.e2e.timezone.synced',
        iconSuggestionsKey: 'zero.e2e.icon-suggestions.v1',
      },
      launcherCountSyncEnabled: false,
      native: {
        updatesEnabled: false,
        cleartextEnabled: true,
      },
    });
    for (const key of Object.keys(normal.persistence) as (
      keyof typeof normal.persistence
    )[]) {
      expect(hermetic.persistence[key]).not.toBe(normal.persistence[key]);
    }
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
