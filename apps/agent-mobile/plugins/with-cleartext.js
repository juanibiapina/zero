// E2E-only config plugin: allow Android cleartext (HTTP) traffic. The hermetic
// release build talks to the local worker over http://localhost:8787, which
// Android release builds block by default ("CLEARTEXT communication to localhost
// not permitted by network security policy"). This is applied only when the
// fake-auth flag is set (see app.config.js), so production/preview manifests keep
// cleartext disabled.
const { withAndroidManifest, AndroidConfig } = require('@expo/config-plugins');

module.exports = function withCleartext(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.$['android:usesCleartextTraffic'] = 'true';
    return cfg;
  });
};
