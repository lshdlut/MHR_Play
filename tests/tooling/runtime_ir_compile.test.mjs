import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function runCompiler(outDir) {
  const result = spawnSync(
    'python',
    [
      'tools/mhr_runtime_ir_compile.py',
      '--manifest',
      'tests/fixtures/processed_bundle/manifest.json',
      '--out',
      outDir,
      '--verify-roundtrip',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('runtime IR compiler emits sparse runtime-native bundle', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'mhr-runtime-ir-'));
  const outDir = path.join(tempRoot, 'ir');

  try {
    runCompiler(outDir);
    const manifestPath = path.join(outDir, 'manifest.json');
    assert.ok(existsSync(manifestPath));

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.bundleSchema, 'mhr-runtime-ir/v1');
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.layout.identityPartitionMode, 'unsplit-export');
    assert.equal(manifest.layout.poseFeatureDimPerJoint, 6);
    assert.ok(manifest.analysis.parameterTransform.nnz > 0);
    assert.ok(manifest.analysis.correctiveStage1.nnz > 0);
    assert.ok(manifest.analysis.correctiveDense.rows > 0);
    assert.ok(manifest.analysis.correctiveDense.columns > 0);

    const chunkKeys = new Set(manifest.chunks.map((entry) => entry.key));
    for (const key of [
      'parameterTransformRowPtr',
      'parameterTransformColIndex',
      'parameterTransformValues',
      'poseHiddenRowPtr',
      'poseHiddenFeatureIndex',
      'poseHiddenValues',
      'correctiveColPtr',
      'correctiveRowIndex',
      'correctiveValues',
      'correctiveBlockRowOffsets',
      'correctiveBlockRowIndex',
      'baseMesh',
      'identityBasis',
      'expressionBasis',
    ]) {
      assert.equal(chunkKeys.has(key), true, `missing IR chunk ${key}`);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
