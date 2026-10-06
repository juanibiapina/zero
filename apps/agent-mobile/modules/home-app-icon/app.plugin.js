const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs/promises');
const path = require('path');

const ALTERNATES = require('./icons.json');

const ALIAS_PREFIX = 'MainActivityIcon';

function launcherFilter() {
  return {
    action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
    category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }],
  };
}

function isLauncherFilter(filter) {
  return (
    filter.action?.some(
      ({ $ }) => $?.['android:name'] === 'android.intent.action.MAIN',
    ) &&
    filter.category?.some(
      ({ $ }) => $?.['android:name'] === 'android.intent.category.LAUNCHER',
    )
  );
}

function withLauncherAliases(config) {
  return withAndroidManifest(config, (config) => {
    const application =
      AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults);
    const mainActivity =
      AndroidConfig.Manifest.getMainActivityOrThrow(config.modResults);
    const packageName = config.android?.package;
    if (!packageName) throw new Error('android.package is required for Home icons');

    const filters = mainActivity['intent-filter'] ?? [];
    const launcher = filters.find(isLauncherFilter) ?? launcherFilter();
    // MainActivity stays enabled for Expo dev-client's explicit launch and owns
    // app/Clerk deep links. Only aliases appear in the launcher.
    mainActivity['intent-filter'] = filters.filter((filter) => !isLauncherFilter(filter));

    const fullPrefix = `${packageName}.${ALIAS_PREFIX}`;
    const existing = (application['activity-alias'] ?? []).filter(
      (alias) => !alias.$?.['android:name']?.startsWith(fullPrefix),
    );
    const label =
      mainActivity.$['android:label'] ??
      application.$['android:label'] ??
      config.name;

    const aliases = [
      {
        name: 'Default',
        enabled: true,
        icon: '@mipmap/ic_launcher',
        roundIcon: '@mipmap/ic_launcher_round',
      },
      ...Object.entries(ALTERNATES).map(([name, slug]) => ({
        name,
        enabled: false,
        icon: `@mipmap/home_app_icon_${slug.replaceAll('-', '_')}`,
        roundIcon: `@mipmap/home_app_icon_${slug.replaceAll('-', '_')}`,
      })),
    ].map(({ name, enabled, icon, roundIcon }) => ({
      $: {
        'android:name': `${fullPrefix}${name}`,
        'android:enabled': String(enabled),
        'android:exported': 'true',
        'android:icon': icon,
        'android:label': label,
        'android:roundIcon': roundIcon,
        'android:targetActivity': '.MainActivity',
      },
      'intent-filter': [JSON.parse(JSON.stringify(launcher))],
    }));

    application['activity-alias'] = [...existing, ...aliases];
    return config;
  });
}

function withLauncherResources(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const projectRoot = config.modRequest.projectRoot;
      const resources = path.join(
        config.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'res',
      );
      const drawable = path.join(resources, 'drawable');
      const drawableNoDpi = path.join(resources, 'drawable-nodpi');
      const legacy = path.join(resources, 'mipmap-xxxhdpi');
      const adaptive = path.join(resources, 'mipmap-anydpi-v26');
      await Promise.all(
        [drawable, drawableNoDpi, legacy, adaptive].map((directory) =>
          fs.mkdir(directory, { recursive: true }),
        ),
      );

      for (const slug of Object.values(ALTERNATES)) {
        const resource = `home_app_icon_${slug.replaceAll('-', '_')}`;
        const source = path.join(projectRoot, 'assets', 'images', 'task-count');
        await Promise.all([
          fs.copyFile(
            path.join(source, `${slug}.png`),
            path.join(legacy, `${resource}.png`),
          ),
          fs.copyFile(
            path.join(source, `${slug}-foreground.png`),
            path.join(drawableNoDpi, `${resource}_foreground.png`),
          ),
          fs.copyFile(
            path.join(source, `${slug}-monochrome.png`),
            path.join(drawableNoDpi, `${resource}_monochrome.png`),
          ),
          fs.writeFile(
            path.join(drawable, `${resource}_background.xml`),
            '<shape xmlns:android="http://schemas.android.com/apk/res/android">\n' +
              '  <solid android:color="#FFFFFF"/>\n' +
              '</shape>\n',
          ),
          fs.writeFile(
            path.join(adaptive, `${resource}.xml`),
            '<?xml version="1.0" encoding="utf-8"?>\n' +
              '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n' +
              `  <background android:drawable="@drawable/${resource}_background"/>\n` +
              `  <foreground android:drawable="@drawable/${resource}_foreground"/>\n` +
              `  <monochrome android:drawable="@drawable/${resource}_monochrome"/>\n` +
              '</adaptive-icon>\n',
          ),
        ]);
      }
      return config;
    },
  ]);
}

module.exports = function withHomeAppIcons(config) {
  config = withLauncherAliases(config);
  config = withLauncherResources(config);
  return config;
};
