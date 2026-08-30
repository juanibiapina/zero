// Dynamic config layered on app.json. Expo loads app.json as the base and passes
// it here as `config`. The only change is the hermetic release E2E build: when
// EXPO_PUBLIC_E2E_FAKE_AUTH=1, add the cleartext plugin so the app can reach the
// local worker over http://localhost. Every other build (production, preview,
// dev) returns app.json unchanged.
module.exports = ({ config }) => {
  if (process.env.EXPO_PUBLIC_E2E_FAKE_AUTH !== '1') {
    return config;
  }
  return {
    ...config,
    plugins: [...(config.plugins ?? []), './plugins/with-cleartext.js'],
  };
};
