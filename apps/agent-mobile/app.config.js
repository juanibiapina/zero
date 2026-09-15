// Dynamic config layered on app.json. The hermetic release E2E build adds the
// cleartext plugin for its local worker and disables remote updates so it always
// runs the embedded fake-auth bundle. Every other build returns app.json unchanged.
module.exports = ({ config }) => {
  if (process.env.EXPO_PUBLIC_E2E_FAKE_AUTH !== '1') {
    return config;
  }
  return {
    ...config,
    updates: {
      ...config.updates,
      enabled: false,
    },
    plugins: [...(config.plugins ?? []), './plugins/with-cleartext.js'],
  };
};
