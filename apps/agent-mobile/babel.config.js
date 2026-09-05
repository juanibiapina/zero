// Babel config for the Expo app. Uniwind needs no Babel preset (styling is a
// Metro transform + CSS parser), so this is just Expo's default preset plus
// the reanimated worklets plugin. Before switching to Uniwind this file also
// carried NativeWind's `jsxImportSource` and `nativewind/babel` preset.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // Reanimated 4 runs animated styles / layout animations through worklets,
    // which this plugin compiles. It must be listed last. Renamed from
    // `react-native-reanimated/plugin` in v4.
    plugins: ['react-native-worklets/plugin'],
  };
};
