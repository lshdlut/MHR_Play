import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function runPython(args) {
  const result = spawnSync('python', args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

test('module boundaries pass', () => {
  runPython(['tools/run_node.py', 'tools/check_module_boundaries.mjs']);
});

test('protocol generator is stable', () => {
  const protocolPath = path.join(repoRoot, 'mjwp_inject', 'plugin', 'profiles', 'mhr', 'worker', 'protocol.gen.mjs');
  const dispatchPath = path.join(repoRoot, 'mjwp_inject', 'plugin', 'profiles', 'mhr', 'worker', 'dispatch.gen.mjs');
  const beforeProtocol = readFileSync(protocolPath, 'utf8');
  const beforeDispatch = readFileSync(dispatchPath, 'utf8');

  runPython(['tools/run_node.py', 'tools/generate_worker_protocol.mjs']);

  const afterProtocol = readFileSync(protocolPath, 'utf8');
  const afterDispatch = readFileSync(dispatchPath, 'utf8');
  assert.equal(afterProtocol, beforeProtocol);
  assert.equal(afterDispatch, beforeDispatch);
});

test('play-hosted runtime modules expose expected surfaces', async () => {
  const configModule = await import(pathToFileURL(path.join(repoRoot, 'mjwp_inject', 'plugin', 'profiles', 'mhr', 'core', 'runtime_config.mjs')).href);
  const bundleModule = await import(pathToFileURL(path.join(repoRoot, 'mjwp_inject', 'plugin', 'profiles', 'mhr', 'core', 'asset_bundle.mjs')).href);

  assert.equal(typeof configModule.normalizeAssetConfig, 'function');
  assert.equal(typeof bundleModule.validateProcessedBundleManifest, 'function');
  assert.equal(typeof bundleModule.loadProcessedBundleManifest, 'function');
  assert.equal(typeof bundleModule.validateProcessedBundleChunks, 'function');
  assert.equal(typeof bundleModule.validateRuntimeIrManifest, 'function');
  assert.equal(typeof bundleModule.loadRuntimeIrManifest, 'function');
  assert.equal(typeof bundleModule.validateRuntimeIrChunks, 'function');
  assert.equal(typeof bundleModule.loadRuntimeIrChunks, 'function');
});

test('user-facing docs are present', () => {
  const requiredDocs = [
    'ARCHITECTURE.md',
    '.repo_local_config.example.json',
    'README.md',
    'README.zh-CN.md',
    'doc/README.md',
    'doc/integration/play_mhr_integration.md',
    'tests/golden_cases/manifest.json',
  ];
  for (const docPath of requiredDocs) {
    assert.ok(existsSync(path.join(repoRoot, docPath)), `missing ${docPath}`);
  }
});

test('legacy standalone product files are absent', () => {
  const forbiddenPaths = [
    'index.html',
    'embed.html',
    'app',
    'backend',
    'renderer',
    'ui',
    'demo_assets',
    'tools/build_demo_bundle.py',
    'tools/browser_smoke.py',
    'tools/dev_server.py',
    'tools/export_site.py',
    'tools/site_release_check.py',
    'core/asset_bundle.mjs',
    'core/runtime_config.mjs',
    'core/state_mapping.mjs',
    'core/viewer_runtime.mjs',
    'worker/protocol.gen.mjs',
    'worker/dispatch.gen.mjs',
    'worker/mhr.worker.mjs',
    'worker/mhr_wasm_runtime.mjs',
    'worker/mhr_runtime_wasm.gen.mjs',
  ];
  for (const relative of forbiddenPaths) {
    assert.equal(existsSync(path.join(repoRoot, relative)), false, `forbidden legacy path still exists: ${relative}`);
  }
});
