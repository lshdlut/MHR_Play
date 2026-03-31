import { mountMhrPlay } from './main.mjs';

const root = document.querySelector('[data-mhr-embed-demo-root]');

if (!root) {
  throw new Error('Embed demo root is missing.');
}

window.__MHR_PLAY_EMBED_DEMO__ = await mountMhrPlay({
  root,
  runtimeConfig: {
    startup: {
      standaloneShell: false,
      assetManifestUrl: '',
      entryVariant: 'host',
    },
    ui: {
      embedMode: true,
      theme: 'sand',
      defaultCompareMode: 'both',
    },
    host: {
      mode: 'embed',
    },
    worker: {
      diagnosticsEnabled: true,
    },
  },
  assetConfig: {
    manifestUrl: './demo_assets/manifest.json',
  },
});
