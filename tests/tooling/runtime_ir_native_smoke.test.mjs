import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('runtime IR native smoke', () => {
  const buildDir = path.join(os.tmpdir(), 'mhr-runtime-ir-native-build');
  const result = spawnSync(
    'python',
    [
      'tools/mhr_runtime_ir_native_smoke.py',
      '--manifest',
      'tests/fixtures/processed_bundle/manifest.json',
      '--build-dir',
      buildDir,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        KMP_DUPLICATE_LIB_OK: process.env.KMP_DUPLICATE_LIB_OK || 'TRUE',
      },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const jsonStart = result.stdout.lastIndexOf('\n{');
  const report = JSON.parse(
    (jsonStart >= 0 ? result.stdout.slice(jsonStart + 1) : result.stdout).trim(),
  );
  assert.equal(report.counts.vertexCount > 0, true);
  assert.equal(report.counts.jointCount > 0, true);
  assert.equal(Array.isArray(report.firstVertex), true);
  assert.equal(report.firstVertex.length, 3);
  assert.equal(Array.isArray(report.rootJoint), true);
  assert.equal(report.rootJoint.length > 0, true);
  assert.equal(Array.isArray(report.derived), true);
  assert.equal(report.derived.length, 7);
});
