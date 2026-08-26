// Babel config for the Expo app. NativeWind needs its own JSX runtime
// (`jsxImportSource: 'nativewind'`) plus the `nativewind/babel` preset so
// `className` props compile to styles. Before adding NativeWind the app had no
// babel.config and relied on Expo's default preset.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
      'nativewind/babel',
    ],
    // Reanimated 4 runs animated styles / layout animations through worklets,
    // which this plugin compiles. It must be listed last. Renamed from
    // `react-native-reanimated/plugin` in v4.
    plugins: ['react-native-worklets/plugin'],
  };
};
