'use strict';

const DEFAULT_API_BASE_URL = 'https://zero.juanibiapina.dev';
const HERMETIC_API_BASE_URL = 'http://localhost:8787';
const productionStorageKeys = () => ({
  timezoneKey: 'zero.timezone.synced',
  iconSuggestionsKey: 'zero.icon-suggestions.v1',
  projectSectionFoldsKey: 'zero.project-section-folds.v1',
  todoWorkspaceKey: 'zero.todo-workspace.v1',
});

const hermeticStorageKeys = () => ({
  timezoneKey: 'zero.e2e.timezone.synced',
  iconSuggestionsKey: 'zero.e2e.icon-suggestions.v1',
  projectSectionFoldsKey: 'zero.e2e.project-section-folds.v1',
  todoWorkspaceKey: 'zero.e2e.todo-workspace.v1',
});

function resolveRuntimeProfile({
  hermeticE2E,
  apiUrl,
} = {}) {
  if (hermeticE2E !== undefined && hermeticE2E !== '1') {
    throw new Error(
      `EXPO_PUBLIC_HERMETIC_E2E must be unset or "1"; received ${JSON.stringify(hermeticE2E)}`,
    );
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
      storageKeys: Object.freeze(hermeticStorageKeys()),
      todoWorkspaceId: 'hermetic-e2e-guest',
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
    storageKeys: Object.freeze(productionStorageKeys()),
    todoWorkspaceId: undefined,
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
