import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('library entry exports mount without standalone side effects', async () => {
  const libraryEntryPath = path.join(repoRoot, 'app', 'main.mjs');
  const source = readFileSync(libraryEntryPath, 'utf8');
  assert.ok(source.includes("export { mountMhrPlay } from './mount.mjs';"));
  assert.ok(!source.includes('await mountMhrPlay()'));
  assert.ok(!source.includes('__MHR_PLAY__'));

  const libraryModule = await import(pathToFileURL(libraryEntryPath).href);
  assert.equal(typeof libraryModule.mountMhrPlay, 'function');
});

test('standalone entry retains the dev-shell auto-mount behavior', () => {
  const standaloneEntryPath = path.join(repoRoot, 'app', 'standalone_entry.mjs');
  const source = readFileSync(standaloneEntryPath, 'utf8');
  assert.ok(source.includes('__MHR_PLAY__'));
  assert.ok(source.includes('await mountMhrPlay()'));
});
