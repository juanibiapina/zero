const { resolveRuntimeProfile } = require('./runtime-profile');

module.exports = ({ config }) => {
  const profile = resolveRuntimeProfile({
    hermeticE2E: process.env.EXPO_PUBLIC_HERMETIC_E2E,
    apiUrl: process.env.EXPO_PUBLIC_API_URL,
  });

  if (!profile.hermetic) return config;

  return {
    ...config,
    updates: {
      ...config.updates,
      enabled: profile.native.updatesEnabled,
    },
    plugins: profile.native.cleartextEnabled
      ? [...(config.plugins ?? []), './plugins/with-cleartext.js']
      : config.plugins,
  };
};
