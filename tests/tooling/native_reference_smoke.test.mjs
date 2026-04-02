import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function runOptionalPython(args, env = {}) {
  return spawnSync('python', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      KMP_DUPLICATE_LIB_OK: process.env.KMP_DUPLICATE_LIB_OK || 'TRUE',
      ...env,
    },
  });
}

test('native reference smoke', async (t) => {
  if (process.env.MHR_NATIVE_SMOKE !== '1') {
    t.skip('Set MHR_NATIVE_SMOKE=1 to run the local native-reference smoke.');
    return;
  }

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'mhr-play-native-'));
  const bundleOut = path.join(tempRoot, 'bundle');
  const oracleOut = path.join(tempRoot, 'oracle');
  const nativeOut = path.join(tempRoot, 'native');
  const nativeBuildDir = path.join(tempRoot, 'native-build');

  try {
    const preprocess = runOptionalPython([
      'tools/run_python.py',
      'tools/mhr_asset_preprocess.py',
      '--source-kind',
      'official',
      '--lod',
      '1',
      '--out',
      bundleOut,
    ]);
    assert.equal(preprocess.status, 0, preprocess.stderr || preprocess.stdout);

    const oracle = runOptionalPython([
      'tools/run_python.py',
      'tools/mhr_python_oracle.py',
      '--lod',
      '1',
      '--out',
      oracleOut,
    ]);
    assert.equal(oracle.status, 0, oracle.stderr || oracle.stdout);

    const nativeHarness = runOptionalPython([
      'tools/run_python.py',
      'tools/mhr_native_harness.py',
      '--manifest',
      path.join(bundleOut, 'manifest.json'),
      '--oracle-root',
      oracleOut,
      '--out',
      nativeOut,
      '--build-dir',
      nativeBuildDir,
      '--rebuild',
    ]);
    assert.equal(nativeHarness.status, 0, nativeHarness.stderr || nativeHarness.stdout);

    const reportPath = path.join(nativeOut, 'report.json');
    assert.ok(existsSync(reportPath));
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.lod, 1);
    assert.equal(report.cases.length, 5);
    for (const check of Object.values(report.discreteChecks)) {
      assert.equal(check.pass, true);
    }
    for (const entry of report.cases) {
      assert.ok(entry.oracleComparison);
      assert.ok(entry.oracleComparison.vertices.maxAbs <= 1e-12);
      assert.ok(entry.oracleComparison.vertices.rms <= 1e-13);
      assert.ok(entry.oracleComparison.skeleton.maxAbs <= 1e-12);
      assert.ok(entry.oracleComparison.skeleton.rms <= 1e-13);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
