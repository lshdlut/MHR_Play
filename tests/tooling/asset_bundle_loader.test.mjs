import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bundleModule = await import(
  pathToFileURL(path.join(repoRoot, 'core', 'asset_bundle.mjs')).href
);
const fixtureManifest = JSON.parse(
  readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'processed_bundle', 'manifest.json'), 'utf8'),
);

function runRuntimeIrCompiler(outDir) {
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

function bufferToArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

test('processed bundle loader resolves manifest and chunk URLs', async () => {
  const loaded = await bundleModule.loadProcessedBundleManifest(
    {
      manifestUrl: 'https://example.test/assets/manifest.json',
      assetBaseUrl: 'https://example.test/assets/',
    },
    {
      fetchImpl: async (url) => ({
        ok: true,
        json: async () => {
          assert.equal(url, 'https://example.test/assets/manifest.json');
          return fixtureManifest;
        },
      }),
    },
  );

  assert.equal(loaded.bundleId, fixtureManifest.bundleId);
  assert.equal(loaded.summary.chunkCount, 16);
  assert.equal(
    loaded.chunkMap.meshTopology.url,
    'https://example.test/assets/meshTopology.bin',
  );
});

test('processed bundle chunk validator checks byte lengths and hashes', async () => {
  const validated = await bundleModule.validateProcessedBundleChunks(fixtureManifest, {
    readChunk: async (chunk) =>
      readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'processed_bundle', chunk.file)),
  });

  assert.equal(validated.validatedChunkCount, fixtureManifest.chunks.length);
});

test('runtime IR loader resolves manifest and chunk URLs', async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'mhr-runtime-ir-loader-'));
  const outDir = path.join(tempRoot, 'ir');

  try {
    runRuntimeIrCompiler(outDir);
    const runtimeIrManifest = JSON.parse(readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
    const loaded = await bundleModule.loadRuntimeIrManifest(
      {
        manifestUrl: 'https://example.test/runtime-ir/manifest.json',
        assetBaseUrl: 'https://example.test/runtime-ir/',
      },
      {
        fetchImpl: async (url) => ({
          ok: true,
          url,
          json: async () => {
            assert.equal(url, 'https://example.test/runtime-ir/manifest.json');
            return runtimeIrManifest;
          },
        }),
      },
    );

    assert.equal(loaded.irId, runtimeIrManifest.irId);
    assert.equal(loaded.summary.chunkCount, runtimeIrManifest.chunks.length);
    assert.equal(
      loaded.chunkMap.parameterTransformRowPtr.url,
      'https://example.test/runtime-ir/parameterTransformRowPtr.bin',
    );

    const validated = await bundleModule.validateRuntimeIrChunks(runtimeIrManifest, {
      readChunk: async (chunk) => readFileSync(path.join(outDir, chunk.file)),
    });
    assert.equal(validated.validatedChunkCount, runtimeIrManifest.chunks.length);

    const chunkMap = await bundleModule.loadRuntimeIrChunks(loaded, {
      fetchImpl: async (url) => {
        const fileName = new URL(url).pathname.split('/').filter(Boolean).at(-1);
        const bytes = readFileSync(path.join(outDir, fileName));
        return {
          ok: true,
          arrayBuffer: async () => bufferToArrayBuffer(bytes),
        };
      },
    });
    assert.equal(chunkMap.baseMesh.array.length > 0, true);
    assert.equal(chunkMap.parameterTransformRowPtr.array.length > 0, true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
