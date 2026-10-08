export type RuntimeProfile = Readonly<{
  name: 'normal' | 'hermetic-e2e';
  hermetic: boolean;
  clerkModules: 'real' | 'fake';
  apiBaseUrl: string;
  storageKeys: Readonly<{
    timezoneKey: string;
    iconSuggestionsKey: string;
    projectSectionFoldsKey: string;
    todoWorkspaceKey: string;
  }>;
  todoWorkspaceId: string | undefined;
  launcherCountSyncEnabled: boolean;
  native: Readonly<{
    updatesEnabled: boolean;
    cleartextEnabled: boolean;
  }>;
}>;

export const DEFAULT_API_BASE_URL: 'https://zero.juanibiapina.dev';
export const HERMETIC_API_BASE_URL: 'http://localhost:8787';

export function resolveRuntimeProfile(options?: {
  hermeticE2E?: string;
  apiUrl?: string;
}): RuntimeProfile;
