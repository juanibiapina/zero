// Metro config: wrap Expo's default config with Uniwind so it processes the
// Tailwind 4 CSS entry and generates className typings. `getDefaultConfig`
// keeps SDK 54+ pnpm-workspace auto-detection, so no custom monorepo Metro
// wiring is needed. `withUniwindConfig` must be the OUTERMOST wrapper.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const { withUniwindConfig } = require('uniwind/metro');

const config = getDefaultConfig(__dirname);

// Release E2E build only: swap the real Clerk modules for in-repo fakes so the
// app is signed-in with a static token and never touches Google/Clerk. Gated by
// EXPO_PUBLIC_E2E_FAKE_AUTH=1, so production/preview builds resolve Clerk as
// normal and no screen imports change.
if (process.env.EXPO_PUBLIC_E2E_FAKE_AUTH === '1') {
  const fakeAuthAliases = {
    '@clerk/expo': path.resolve(__dirname, 'src/lib/fake-auth/clerk-expo.tsx'),
    '@clerk/expo/token-cache': path.resolve(
      __dirname,
      'src/lib/fake-auth/clerk-expo-token-cache.ts',
    ),
    '@clerk/expo/native': path.resolve(
      __dirname,
      'src/lib/fake-auth/clerk-expo-native.tsx',
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
