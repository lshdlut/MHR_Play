import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function resolveExactPythonExe() {
  const probe = spawnSync(
    'python',
    [
      '-c',
      [
        'from pathlib import Path',
        'from tools.local_config import resolve_exact_runtime_python_executable',
        'print(resolve_exact_runtime_python_executable(Path.cwd()))',
      ].join('; '),
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  const resolved = probe.stdout.trim();
  assert.notEqual(resolved, '');
  return resolved;
}

function runOptionalPython(args, env = {}) {
  return spawnSync('python', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PYTHON_EXE: process.env.PYTHON_EXE || resolveExactPythonExe(),
      KMP_DUPLICATE_LIB_OK: process.env.KMP_DUPLICATE_LIB_OK || 'TRUE',
      ...env,
    },
  });
}

function parseTrailingJson(output) {
  const jsonStart = output.lastIndexOf('\n{');
  const payload = (jsonStart >= 0 ? output.slice(jsonStart + 1) : output).trim();
  return JSON.parse(payload);
}

test('non-LOD1 exact portable parity smoke (lod6)', async (t) => {
  if (process.env.MHR_MULTI_LOD_EXACT_SMOKE !== '1') {
    t.skip('Set MHR_MULTI_LOD_EXACT_SMOKE=1 to run the local non-LOD1 exact smoke.');
    return;
  }

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'mhr-play-multi-lod-exact-'));
  const bundleOut = path.join(tempRoot, 'bundle');
  const oracleOut = path.join(tempRoot, 'oracle');
  const nativeBuildDir = path.join(tempRoot, 'native-build');

  try {
    const preprocess = runOptionalPython([
      'tools/run_python.py',
      'tools/mhr_asset_preprocess.py',
      '--source-kind',
      'official',
      '--lod',
      '6',
      '--out',
      bundleOut,
    ]);
    assert.equal(preprocess.status, 0, preprocess.stderr || preprocess.stdout);

    const processedManifestPath = path.join(bundleOut, 'manifest.json');
    assert.ok(existsSync(processedManifestPath));
    const processedManifest = JSON.parse(readFileSync(processedManifestPath, 'utf8'));
    assert.equal(processedManifest.lod, 6);

    const oracle = runOptionalPython([
      'tools/run_python.py',
      'tools/mhr_python_oracle.py',
      '--lod',
      '6',
      '--oracle',
      'official-full-cpu',
      '--out',
      oracleOut,
    ]);
    assert.equal(oracle.status, 0, oracle.stderr || oracle.stdout);

    const parity = runOptionalPython([
      'tools/mhr_runtime_ir_portable_parity.py',
      '--manifest',
      processedManifestPath,
      '--oracle-root',
      oracleOut,
      '--build-dir',
      nativeBuildDir,
      '--exact',
    ]);
    assert.equal(parity.status, 0, parity.stderr || parity.stdout);
    const parityReport = parseTrailingJson(parity.stdout);
    assert.equal(parityReport.lod, 6);
    assert.equal(parityReport.exactMode, true);
    for (const entry of parityReport.cases) {
      assert.equal(entry.vertices.maxAbs, 0, `vertex drift for ${entry.id}`);
      assert.equal(entry.skeleton.maxAbs, 0, `skeleton drift for ${entry.id}`);
      assert.equal(entry.derived.maxAbs, 0, `derived drift for ${entry.id}`);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
