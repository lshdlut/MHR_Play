import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function runOptionalPython(args, env = {}) {
  return spawnSync('python', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
    },
  });
}

test('official oracle and preprocess smoke', async (t) => {
  if (process.env.MHR_REAL_ASSET_SMOKE !== '1') {
    t.skip('Set MHR_REAL_ASSET_SMOKE=1 to run the local official-asset smoke.');
    return;
  }

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'mhr-play-official-'));
  const bundleOutA = path.join(tempRoot, 'bundle-a');
  const bundleOutB = path.join(tempRoot, 'bundle-b');
  const oracleOut = path.join(tempRoot, 'oracle');

  try {
    const preprocessA = runOptionalPython([
      'tools/run_python.py',
      'tools/mhr_asset_preprocess.py',
      '--source-kind',
      'official',
      '--lod',
      '1',
      '--out',
      bundleOutA,
    ]);
    assert.equal(preprocessA.status, 0, preprocessA.stderr || preprocessA.stdout);

    const preprocessB = runOptionalPython([
      'tools/run_python.py',
      'tools/mhr_asset_preprocess.py',
      '--source-kind',
      'official',
      '--lod',
      '1',
      '--out',
      bundleOutB,
    ]);
    assert.equal(preprocessB.status, 0, preprocessB.stderr || preprocessB.stdout);

    const manifestA = JSON.parse(readFileSync(path.join(bundleOutA, 'manifest.json'), 'utf8'));
    const manifestB = JSON.parse(readFileSync(path.join(bundleOutB, 'manifest.json'), 'utf8'));
    assert.equal(manifestA.bundleFingerprint, manifestB.bundleFingerprint);

    const bundleModule = await import(
      pathToFileURL(
        path.join(
          repoRoot,
          'mjwp_inject',
          'plugin',
          'profiles',
          'mhr',
          'core',
          'asset_bundle.mjs',
        ),
      ).href,
    );
    const summary = bundleModule.validateProcessedBundleManifest(manifestA);
    assert.equal(summary.lod, 1);
    assert.ok(summary.chunkCount >= 10);
    assert.ok(summary.parameterCount >= 300);

    const oracleRun = runOptionalPython([
      'tools/run_python.py',
      'tools/mhr_python_oracle.py',
      '--lod',
      '1',
      '--out',
      oracleOut,
    ]);
    assert.equal(oracleRun.status, 0, oracleRun.stderr || oracleRun.stdout);
    assert.ok(existsSync(path.join(oracleOut, 'report.json')));
    const report = JSON.parse(readFileSync(path.join(oracleOut, 'report.json'), 'utf8'));
    assert.equal(report.lod, 1);
    assert.equal(report.oracle, 'official-full-cpu');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
