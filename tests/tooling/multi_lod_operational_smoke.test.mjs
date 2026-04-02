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

test('non-LOD1 operational lane smoke (lod6)', async (t) => {
  if (process.env.MHR_MULTI_LOD_SMOKE !== '1') {
    t.skip('Set MHR_MULTI_LOD_SMOKE=1 to run the local non-LOD1 operational smoke.');
    return;
  }

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'mhr-play-multi-lod-'));
  const bundleOut = path.join(tempRoot, 'bundle');
  const runtimeIrOut = path.join(tempRoot, 'runtime-ir');
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
    assert.ok(Array.isArray(processedManifest.chunks));
    assert.ok(processedManifest.chunks.length > 0);

    const compile = runOptionalPython([
      'tools/mhr_runtime_ir_compile.py',
      '--manifest',
      processedManifestPath,
      '--out',
      runtimeIrOut,
      '--verify-roundtrip',
    ]);
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);

    const runtimeIrManifestPath = path.join(runtimeIrOut, 'manifest.json');
    assert.ok(existsSync(runtimeIrManifestPath));
    const runtimeIrManifest = JSON.parse(readFileSync(runtimeIrManifestPath, 'utf8'));
    assert.equal(runtimeIrManifest.lod, 6);
    assert.equal(runtimeIrManifest.bundleSchema, 'mhr-runtime-ir/v1');

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
    const oracleReport = JSON.parse(readFileSync(path.join(oracleOut, 'report.json'), 'utf8'));
    assert.equal(oracleReport.lod, 6);
    assert.equal(oracleReport.oracle, 'official-full-cpu');

    const nativeSmoke = runOptionalPython([
      'tools/mhr_runtime_ir_native_smoke.py',
      '--manifest',
      processedManifestPath,
      '--build-dir',
      nativeBuildDir,
    ]);
    assert.equal(nativeSmoke.status, 0, nativeSmoke.stderr || nativeSmoke.stdout);
    const nativeReport = parseTrailingJson(nativeSmoke.stdout);
    assert.equal(nativeReport.lod, 6);
    assert.ok(nativeReport.counts.vertexCount > 0);
    assert.ok(nativeReport.counts.jointCount > 0);

    const parity = runOptionalPython([
      'tools/mhr_runtime_ir_portable_parity.py',
      '--manifest',
      processedManifestPath,
      '--oracle-root',
      oracleOut,
      '--build-dir',
      nativeBuildDir,
    ]);
    assert.equal(parity.status, 0, parity.stderr || parity.stdout);
    const parityReport = parseTrailingJson(parity.stdout);
    assert.equal(parityReport.lod, 6);
    assert.equal(parityReport.comparisonMode, 'official-oracle');
    assert.equal(parityReport.oracleRoot, oracleOut);
    assert.ok(parityReport.cases.length >= 5);
    for (const entry of parityReport.cases) {
      assert.equal(entry.skeleton.maxAbs, 0);
      assert.equal(entry.derived.maxAbs, 0);
      assert.ok(entry.vertices.maxAbs <= 5e-5, `vertex drift too large for ${entry.id}`);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
