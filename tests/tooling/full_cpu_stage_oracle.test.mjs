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

test('official full CPU stage oracle and portable parity smoke', async (t) => {
  if (process.env.MHR_FULL_CPU_SMOKE !== '1') {
    t.skip('Set MHR_FULL_CPU_SMOKE=1 to run the local full-package CPU oracle smoke.');
    return;
  }
  if (!process.env.MHR_ASSET_ROOT) {
    t.skip('Set MHR_ASSET_ROOT to the official asset folder to run the full-package CPU oracle smoke.');
    return;
  }

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'mhr-full-cpu-'));
  const oracleOut = path.join(tempRoot, 'oracle');
  const parityOut = path.join(tempRoot, 'portable_vs_full_cpu.json');

  try {
    const oracle = runOptionalPython([
      'tools/run_python.py',
      'tools/mhr_full_cpu_stage_oracle.py',
      '--out',
      oracleOut,
      '--manifest',
      'local_tools/official_bundle/manifest.json',
      '--random-batch-size',
      '32',
      '--random-seed',
      '0',
    ]);
    assert.equal(oracle.status, 0, oracle.stderr || oracle.stdout);

    const manifestPath = path.join(oracleOut, 'manifest.json');
    assert.ok(existsSync(manifestPath));
    const oracleManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(oracleManifest.oracleKind, 'official-full-cpu');
    assert.equal(oracleManifest.lod, 1);
    assert.equal(Array.isArray(oracleManifest.cases), true);
    assert.equal(oracleManifest.cases.length, 5);
    assert.equal(Array.isArray(oracleManifest.randomBatches), true);
    assert.equal(oracleManifest.randomBatches.length, 1);

    const parity = runOptionalPython([
      'tools/run_python.py',
      'tools/mhr_portable_vs_full_cpu_stage_parity.py',
      '--manifest',
      'local_tools/official_bundle/manifest.json',
      '--out',
      parityOut,
      '--random-batch-size',
      '0',
    ]);
    assert.equal(parity.status, 0, parity.stderr || parity.stdout);
    assert.ok(existsSync(parityOut));
    const parityReport = JSON.parse(readFileSync(parityOut, 'utf8'));
    assert.equal(parityReport.candidate, 'portable');
    assert.equal(parityReport.lod, 1);
    assert.equal(parityReport.cases.length, 5);
    for (const entry of parityReport.cases) {
      assert.ok(entry.stages.joint_parameters);
      assert.ok(entry.stages.skin_joint_states);
      assert.ok(entry.stages.final_vertices);
      assert.ok(entry.stages.global_skeleton_state);
      for (const [stageName, stageReport] of Object.entries(entry.stages)) {
        assert.equal(
          stageReport.bitwiseEqual,
          true,
          `${entry.id} stage ${stageName} is not bitwise exact: ${JSON.stringify(stageReport)}`,
        );
      }
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
