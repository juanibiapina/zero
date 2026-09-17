'use strict';

const DEFAULT_API_BASE_URL = 'https://zero.juanibiapina.dev';
const HERMETIC_API_BASE_URL = 'http://localhost:8787';
const DEFAULT_OFFLINE_OUTBOX_VERSION = 2;

const productionPersistence = (outboxVersion) => ({
  databaseName: 'zero-app.sqlite',
  outboxDatabaseName: `zero-app-outbox-v${outboxVersion}.sqlite`,
  timezoneKey: 'zero.timezone.synced',
  iconSuggestionsKey: 'zero.icon-suggestions.v1',
});

const hermeticPersistence = (outboxVersion) => ({
  databaseName: 'zero-app-e2e.sqlite',
  outboxDatabaseName: `zero-app-e2e-outbox-v${outboxVersion}.sqlite`,
  timezoneKey: 'zero.e2e.timezone.synced',
  iconSuggestionsKey: 'zero.e2e.icon-suggestions.v1',
});

function resolveRuntimeProfile({
  hermeticE2E,
  apiUrl,
  offlineOutboxVersion = DEFAULT_OFFLINE_OUTBOX_VERSION,
} = {}) {
  if (hermeticE2E !== undefined && hermeticE2E !== '1') {
    throw new Error(
      `EXPO_PUBLIC_HERMETIC_E2E must be unset or "1"; received ${JSON.stringify(hermeticE2E)}`,
    );
  }

  if (!Number.isInteger(offlineOutboxVersion) || offlineOutboxVersion < 1) {
    throw new Error('offlineOutboxVersion must be a positive integer');
  }

  if (hermeticE2E === '1') {
    if (apiUrl !== undefined && apiUrl !== HERMETIC_API_BASE_URL) {
      throw new Error(
        'EXPO_PUBLIC_API_URL cannot override the fixed hermetic localhost origin',
      );
    }
    return Object.freeze({
      name: 'hermetic-e2e',
      hermetic: true,
      clerkModules: 'fake',
      apiBaseUrl: HERMETIC_API_BASE_URL,
      persistence: Object.freeze(hermeticPersistence(offlineOutboxVersion)),
      launcherCountSyncEnabled: false,
      native: Object.freeze({
        updatesEnabled: false,
        cleartextEnabled: true,
      }),
    });
  }

  return Object.freeze({
    name: 'normal',
    hermetic: false,
    clerkModules: 'real',
    apiBaseUrl: apiUrl ?? DEFAULT_API_BASE_URL,
    persistence: Object.freeze(productionPersistence(offlineOutboxVersion)),
    launcherCountSyncEnabled: true,
    native: Object.freeze({
      updatesEnabled: true,
      cleartextEnabled: false,
    }),
  });
}

module.exports = {
  DEFAULT_API_BASE_URL,
  HERMETIC_API_BASE_URL,
  resolveRuntimeProfile,
};
