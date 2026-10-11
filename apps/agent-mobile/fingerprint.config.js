const { SourceSkips } = require('expo/fingerprint');

/** @type {import('expo/fingerprint').Config} */
module.exports = {
  sourceSkips: SourceSkips.PackageJsonScriptsAll,
};
