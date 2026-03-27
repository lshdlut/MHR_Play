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
  const protocolPath = path.join(repoRoot, 'worker', 'protocol.gen.mjs');
  const dispatchPath = path.join(repoRoot, 'worker', 'dispatch.gen.mjs');
  const beforeProtocol = readFileSync(protocolPath, 'utf8');
  const beforeDispatch = readFileSync(dispatchPath, 'utf8');

  runPython(['tools/run_node.py', 'tools/generate_worker_protocol.mjs']);

  const afterProtocol = readFileSync(protocolPath, 'utf8');
  const afterDispatch = readFileSync(dispatchPath, 'utf8');
  assert.equal(afterProtocol, beforeProtocol);
  assert.equal(afterDispatch, beforeDispatch);
});

test('public modules expose expected surfaces', async () => {
  const mountModule = await import(pathToFileURL(path.join(repoRoot, 'app', 'mount.mjs')).href);
  const hostModule = await import(pathToFileURL(path.join(repoRoot, 'app', 'mhr_play_host.mjs')).href);
  const configModule = await import(pathToFileURL(path.join(repoRoot, 'core', 'runtime_config.mjs')).href);
  const bundleModule = await import(pathToFileURL(path.join(repoRoot, 'core', 'asset_bundle.mjs')).href);

  assert.equal(typeof mountModule.mountMhrPlay, 'function');
  assert.equal(typeof hostModule.createMhrPlayHost, 'function');
  assert.equal(typeof configModule.getRuntimeConfig, 'function');
  assert.equal(typeof configModule.resolveMountConfig, 'function');
  assert.equal(typeof bundleModule.validateProcessedBundleManifest, 'function');
  assert.equal(typeof bundleModule.loadProcessedBundleManifest, 'function');
  assert.equal(typeof bundleModule.validateProcessedBundleChunks, 'function');
});

test('contract documents are present', () => {
  const requiredDocs = [
    'ARCHITECTURE.md',
    'doc/contracts/out_of_scope.md',
    'doc/contracts/state_schema.md',
    'doc/contracts/panel_schema.md',
    'doc/contracts/semantic_to_raw_mapping.md',
    'doc/contracts/worker_protocol_draft.md',
    'doc/contracts/host_integration_draft.md',
  ];
  for (const docPath of requiredDocs) {
    assert.ok(existsSync(path.join(repoRoot, docPath)), `missing ${docPath}`);
  }
});
