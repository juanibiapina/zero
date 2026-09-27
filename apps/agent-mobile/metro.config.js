// Metro config: wrap Expo's default config with Uniwind so it processes the
// Tailwind 4 CSS entry and generates className typings. `getDefaultConfig`
// keeps SDK 54+ pnpm-workspace auto-detection, so no custom monorepo Metro
// wiring is needed. `withUniwindConfig` must be the OUTERMOST wrapper.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const { withUniwindConfig } = require('uniwind/metro');
const { resolveRuntimeProfile } = require('./runtime-profile');

const config = getDefaultConfig(__dirname);
const profile = resolveRuntimeProfile({
  hermeticE2E: process.env.EXPO_PUBLIC_HERMETIC_E2E,
  apiUrl: process.env.EXPO_PUBLIC_API_URL,
});

if (profile.clerkModules === 'fake') {
  const fakeAuthAliases = {
    '@clerk/expo': path.resolve(__dirname, 'src/lib/fake-auth/clerk-expo.tsx'),
    '@clerk/expo/token-cache': path.resolve(
      __dirname,
      'src/lib/fake-auth/clerk-expo-token-cache.ts',
    ),
    '@clerk/expo/resource-cache': path.resolve(
      __dirname,
      'src/lib/fake-auth/clerk-expo-resource-cache.ts',
    ),
  };
  const defaultResolveRequest = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    const alias = fakeAuthAliases[moduleName];
    if (alias) {
      return { type: 'sourceFile', filePath: alias };
    }
    const resolve = defaultResolveRequest ?? context.resolveRequest;
    return resolve(context, moduleName, platform);
  };
}

module.exports = withUniwindConfig(config, {
  cssEntryFile: './global.css',
  dtsFile: './src/uniwind-types.d.ts',
});
