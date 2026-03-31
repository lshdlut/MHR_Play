import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function runPreprocess(outDir) {
  const result = spawnSync(
    'python',
    [
      'tools/mhr_asset_preprocess.py',
      '--source',
      'tests/fixtures/minimal_asset_source/source_bundle.json',
      '--out',
      outDir,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('preprocess pipeline is deterministic and manifest-valid', async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'mhr-play-'));
  const outA = path.join(tempRoot, 'bundle-a');
  const outB = path.join(tempRoot, 'bundle-b');

  try {
    runPreprocess(outA);
    runPreprocess(outB);

    const manifestA = JSON.parse(readFileSync(path.join(outA, 'manifest.json'), 'utf8'));
    const manifestB = JSON.parse(readFileSync(path.join(outB, 'manifest.json'), 'utf8'));

    assert.equal(manifestA.bundleFingerprint, manifestB.bundleFingerprint);
    const bundleModule = await import(pathToFileURL(path.join(repoRoot, 'core', 'asset_bundle.mjs')).href);
    const validated = bundleModule.validateProcessedBundleManifest(manifestA);
    assert.equal(validated.bundleId, 'minimal-human-fixture');
    assert.equal(validated.chunkCount, 16);
    assert.equal(validated.parameterCount, 15);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
