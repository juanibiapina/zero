// tinybase declares about 30 optional peers, one per integration (Expo,
// React, Postgres, ...). pnpm resolves optional peers against whatever
// versions exist anywhere in the workspace, so the server and web workspaces
// got their own Expo and React Native trees through tinybase. Those trees
// split tinybase into per-workspace copies, and their hoisted Expo packages
// shadowed the mobile app's. Keep only the peer this repo needs at install
// time; mobile's `expo-sqlite` persister finds expo-sqlite through Expo's
// module resolution in Metro and the hoisted copy in Jest.
const TINYBASE_PEERS = new Set(['@cloudflare/workers-types']);

function readPackage(pkg) {
  if (pkg.name === 'tinybase') {
    for (const name of Object.keys(pkg.peerDependencies ?? {})) {
      if (TINYBASE_PEERS.has(name)) continue;
      delete pkg.peerDependencies[name];
      if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta[name];
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
