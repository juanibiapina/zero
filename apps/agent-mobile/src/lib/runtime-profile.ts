import {
  resolveRuntimeProfile,
  type RuntimeProfile,
} from '../../runtime-profile';

export function resolveApplicationRuntimeProfile({
  launcherIconProof,
  ...options
}: Parameters<typeof resolveRuntimeProfile>[0] & { launcherIconProof?: string } = {}): RuntimeProfile {
  if (launcherIconProof !== undefined && !['0', '1'].includes(launcherIconProof)) {
    throw new Error('EXPO_PUBLIC_LAUNCHER_ICON_PROOF must be unset, "0", or "1"');
  }
  const profile = resolveRuntimeProfile(options);
  if (launcherIconProof === '1' && !profile.hermetic) {
    throw new Error('Launcher icon proof requires EXPO_PUBLIC_HERMETIC_E2E=1');
  }
  return launcherIconProof === '1'
    ? Object.freeze({ ...profile, launcherCountSyncEnabled: true })
    : profile;
}

// Expo only inlines direct EXPO_PUBLIC_* reads. Resolve application modes here.
export const RUNTIME_PROFILE = resolveApplicationRuntimeProfile({
  hermeticE2E: process.env.EXPO_PUBLIC_HERMETIC_E2E,
  apiUrl: process.env.EXPO_PUBLIC_API_URL,
  launcherIconProof: process.env.EXPO_PUBLIC_LAUNCHER_ICON_PROOF,
});
