import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runtimeConfigModule = await import(
  pathToFileURL(path.join(repoRoot, 'mjwp_inject', 'plugin', 'profiles', 'mhr', 'core', 'runtime_config.mjs')).href
);

test('normalizeAssetConfig absolutizes manifest and asset base URLs against the target location', () => {
  const normalized = runtimeConfigModule.normalizeAssetConfig(
    {
      manifestUrl: './bundles/lod1/manifest.json',
      assetBaseUrl: './bundles/lod1/',
    },
    {
      location: {
        href: 'http://127.0.0.1:4173/mhr.html',
      },
    },
  );

  assert.equal(normalized.manifestUrl, 'http://127.0.0.1:4173/bundles/lod1/manifest.json');
  assert.equal(normalized.assetBaseUrl, 'http://127.0.0.1:4173/bundles/lod1/');
});

test('normalizeAssetConfig preserves empty values and returns a frozen object', () => {
  const normalized = runtimeConfigModule.normalizeAssetConfig({}, { location: { href: 'http://127.0.0.1:4173/mhr.html' } });
  assert.equal(normalized.manifestUrl, '');
  assert.equal(normalized.assetBaseUrl, '');
  assert.equal(Object.isFrozen(normalized), true);
});
