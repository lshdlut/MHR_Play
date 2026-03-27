import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runtimeConfigModule = await import(
  pathToFileURL(path.join(repoRoot, 'core', 'runtime_config.mjs')).href
);

test('standalone bootstrap falls back to URL-derived manifest config', () => {
  const resolved = runtimeConfigModule.resolveMountConfig({
    target: {
      __MHR_PLAY_RUNTIME_CONFIG__: {
        startup: {
          standaloneShell: true,
          assetManifestUrl: '/bundles/from-url/manifest.json',
        },
        ui: {
          defaultCompareMode: 'skin',
        },
        host: {
          mode: 'standalone-dev-shell',
        },
      },
    },
  });

  assert.equal(resolved.runtimeConfig.startup.standaloneShell, true);
  assert.equal(resolved.runtimeConfig.host.mode, 'standalone-dev-shell');
  assert.equal(resolved.assetConfig.manifestUrl, '/bundles/from-url/manifest.json');
});

test('explicit runtime and asset config override standalone bootstrap input', () => {
  const resolved = runtimeConfigModule.resolveMountConfig({
    target: {
      __MHR_PLAY_RUNTIME_CONFIG__: {
        startup: {
          standaloneShell: true,
          assetManifestUrl: '/bundles/from-url/manifest.json',
        },
        host: {
          mode: 'standalone-dev-shell',
        },
      },
    },
    runtimeConfig: {
      startup: {
        standaloneShell: false,
      },
      ui: {
        theme: 'copper',
      },
    },
    assetConfig: {
      manifestUrl: '/bundles/embed/manifest.json',
      assetBaseUrl: '/bundles/embed/',
    },
  });

  assert.equal(resolved.runtimeConfig.startup.standaloneShell, false);
  assert.equal(resolved.runtimeConfig.host.mode, 'embed');
  assert.equal(resolved.runtimeConfig.ui.embedMode, true);
  assert.equal(resolved.assetConfig.manifestUrl, '/bundles/embed/manifest.json');
  assert.equal(resolved.assetConfig.assetBaseUrl, '/bundles/embed/');
});

test('embed runtime without explicit asset config does not consume bootstrap URL manifest', () => {
  const resolved = runtimeConfigModule.resolveMountConfig({
    target: {
      __MHR_PLAY_RUNTIME_CONFIG__: {
        startup: {
          standaloneShell: true,
          assetManifestUrl: '/bundles/from-url/manifest.json',
        },
      },
    },
    runtimeConfig: {
      startup: {
        standaloneShell: false,
      },
      host: {
        mode: 'embed',
      },
    },
  });

  assert.equal(resolved.runtimeConfig.host.mode, 'embed');
  assert.equal(resolved.runtimeConfig.startup.assetManifestUrl, '');
  assert.equal(resolved.assetConfig.manifestUrl, '');
});
