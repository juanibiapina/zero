// Metro config: wrap Expo's default config with NativeWind so it processes the
// Tailwind CSS entry. `getDefaultConfig` keeps SDK 54+ pnpm-workspace
// auto-detection, so no custom monorepo Metro wiring is needed.
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

module.exports = withNativeWind(config, { input: './global.css' });
