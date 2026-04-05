import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const playSrc = path.resolve(repoRoot, '..', 'mujoco-wasm-play');

test('deploy-oriented site app externalizes heavy assets and writes site_config contract', { timeout: 120000 }, () => {
  if (!existsSync(playSrc)) {
    test.skip('requires sibling mujoco-wasm-play checkout');
    return;
  }

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'mhr-site-app-'));
  const outDir = path.join(tempRoot, 'site-app');

  try {
    const result = spawnSync(
      'python',
      [
        'tools/build_site_app.py',
        '--play-src',
        playSrc,
        '--out',
        outDir,
        '--mhr-manifest-url',
        'https://assets.example.com/mhr-official/lod1/manifest.json',
        '--mhr-asset-base-url',
        'https://assets.example.com/mhr-official/lod1/',
        '--env-asset-base',
        'https://assets.example.com/env/',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const viewerRoot = path.join(outDir, 'viewer');
    const rootIndexPath = path.join(outDir, 'index.html');
    const viewerIndexPath = path.join(viewerRoot, 'index.html');
    const siteConfigPath = path.join(viewerRoot, 'site_config.js');
    assert.equal(existsSync(rootIndexPath), true);
    assert.equal(existsSync(viewerIndexPath), true);
    assert.equal(existsSync(path.join(viewerRoot, 'mhr.html')), true);
    assert.equal(existsSync(siteConfigPath), true);
    assert.equal(existsSync(path.join(viewerRoot, 'plugins', 'mhr_profile_plugin.mjs')), true);

    assert.equal(existsSync(path.join(viewerRoot, 'mhr-official')), false);
    assert.equal(existsSync(path.join(viewerRoot, 'assets', 'env')), false);

    const rootIndex = readFileSync(rootIndexPath, 'utf8');
    assert.match(rootIndex, /\.\/viewer\//);
    assert.doesNotMatch(rootIndex, /\?lod=1/);

    const siteConfigSource = readFileSync(siteConfigPath, 'utf8');
    assert.match(siteConfigSource, /globalThis\.PLAY_MHR_LOD = 1;/);
    assert.match(siteConfigSource, /globalThis\.PLAY_MHR_MANIFEST_URL = "https:\/\/assets\.example\.com\/mhr-official\/lod1\/manifest\.json";/);
    assert.match(siteConfigSource, /globalThis\.PLAY_MHR_ASSET_BASE_URL = "https:\/\/assets\.example\.com\/mhr-official\/lod1\/";/);
    assert.match(siteConfigSource, /globalThis\.PLAY_ENV_ASSET_BASE = "https:\/\/assets\.example\.com\/env\/";/);

    const viewerIndex = readFileSync(viewerIndexPath, 'utf8');
    assert.match(viewerIndex, /<script src="\.\/site_config\.js"><\/script>/);
    assert.doesNotMatch(viewerIndex, /\.\/mhr-official\/lod/);
    assert.match(viewerIndex, /PLAY_MHR_MANIFEST_URL or PLAY_MHR_ASSET_BASE_URL via site_config\.js/);
    assert.match(viewerIndex, /PLAY_UI_STORAGE_NAMESPACE = ["']mhr-site-app["']/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
