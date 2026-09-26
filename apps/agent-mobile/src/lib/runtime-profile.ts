import {
  resolveRuntimeProfile,
  type RuntimeProfile,
} from '../../runtime-profile';

// Expo only inlines direct EXPO_PUBLIC_* reads. Keep both reads here, then make
// every application-side mode decision from this resolved profile.
export const RUNTIME_PROFILE: RuntimeProfile = resolveRuntimeProfile({
  hermeticE2E: process.env.EXPO_PUBLIC_HERMETIC_E2E,
  apiUrl: process.env.EXPO_PUBLIC_API_URL,
});
