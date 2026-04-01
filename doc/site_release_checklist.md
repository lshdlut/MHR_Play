# Site Release Checklist

- Run `npm run build:demo-bundle`.
- Run `npm run build:wasm`.
- Run `npm run export:site`.
- Run `python tools/release_check.py`.
- Confirm `dist/site/index.html` and `dist/site/embed.html` exist.
- Confirm `dist/site/demo_assets/manifest.json` is present and hash-stable.
- Confirm the exported worker bundle contains `worker/mhr_runtime_wasm.gen.mjs`.
- Confirm browser smoke passes on the exported static artifact, not only the repo root dev server.
- Confirm `mountMhrPlay({ root, runtimeConfig?, assetConfig? })` remains the only formal embed surface.
- Confirm the shipped browser runtime consumes processed bundles only and never raw official assets.
