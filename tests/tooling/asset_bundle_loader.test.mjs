import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bundleModule = await import(
  pathToFileURL(path.join(repoRoot, 'core', 'asset_bundle.mjs')).href
);
const fixtureManifest = JSON.parse(
  readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'processed_bundle', 'manifest.json'), 'utf8'),
);

test('processed bundle loader resolves manifest and chunk URLs', async () => {
  const loaded = await bundleModule.loadProcessedBundleManifest(
    {
      manifestUrl: 'https://example.test/assets/manifest.json',
      assetBaseUrl: 'https://example.test/assets/',
    },
    {
      fetchImpl: async (url) => ({
        ok: true,
        json: async () => {
          assert.equal(url, 'https://example.test/assets/manifest.json');
          return fixtureManifest;
        },
      }),
    },
  );

  assert.equal(loaded.bundleId, fixtureManifest.bundleId);
  assert.equal(loaded.summary.chunkCount, 7);
  assert.equal(
    loaded.chunkMap.meshTopology.url,
    'https://example.test/assets/meshTopology.bin',
  );
});

test('processed bundle chunk validator checks byte lengths and hashes', async () => {
  const validated = await bundleModule.validateProcessedBundleChunks(fixtureManifest, {
    readChunk: async (chunk) =>
      readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'processed_bundle', chunk.file)),
  });

  assert.equal(validated.validatedChunkCount, fixtureManifest.chunks.length);
});
