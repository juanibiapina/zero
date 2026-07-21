// eslint-config-expo is used here instead of the shared @zero/eslint-config
// because it bundles the React Native / Expo rules and plugins this app needs.
const expoConfig = require('eslint-config-expo/flat');

module.exports = [
  ...expoConfig,
  {
    ignores: ['dist/*', '.expo/*'],
  },
];
