# MHR Play

`MHR Play` is an embeddable `front-end + worker` application for MHR-focused
runtime exploration. The repository now includes a public-beta-ready standalone
shell, a stable embed surface, a processed demo bundle, a wasm worker runtime,
and an official TorchScript/native reference lane for parity work.

## Current Status

- Repository shape and layer ownership are established.
- Runtime input ownership is centralized in bootstrap.
- Backend, worker, UI store, renderer, and host boundaries exist as separate
  modules.
- Worker protocol generation is driven by `tools/worker_protocol.json`.
- `mountMhrPlay({ root, runtimeConfig?, assetConfig? })` now treats explicit
  host config as first-class and limits URL-derived config to the standalone
  shell only.
- Asset preprocessing supports both the tracked minimal fixture and a real
  official MHR TorchScript bundle export.
- Golden cases and an offline Python oracle exist under `tests/golden_cases/`
  and `tools/mhr_python_oracle.py`.
- The native reference runtime now reaches machine precision on the frozen
  golden cases through a reference-only exact-kernel path.
- The standalone shell auto-loads the tracked demo bundle and evaluates it
  through the worker-owned wasm runtime.
- `index.html` and `embed.html` are the two public beta surfaces:
  standalone GitHub Pages style delivery and explicit host embedding.

## Layout

- `app/`: bootstrap, shell, public mount surface, host contract
- `backend/`: main-thread worker proxy and latest evaluation owner
- `core/`: runtime config, logging helpers, bundle validation
- `renderer/`: minimal beta viewer for skin and skeleton consumption
- `ui/`: UI-only store and beta control surface
- `worker/`: generated protocol glue and wasm runtime owner
- `tools/`: dev server, protocol generator, boundary checker, preprocessing,
  oracle generation, demo-bundle/export/release helpers
- `tests/`: Node-based tooling and contract checks
- `doc/`: product, architecture, parity, asset, and integration contracts
- `native/`: native reference runtime core and C ABI for parity work

## Commands

- `npm run dev`
- `npm run generate:protocol`
- `npm run ci:guard`
- `npm run test`
- `npm run preprocess:official`
- `npm run parity:python`
- `npm run build:native`
- `npm run build:demo-bundle`
- `npm run build:wasm`
- `npm run build:beta`
- `npm run export:beta`
- `npm run test:native-smoke`
- `npm run test:browser-smoke`
- `npm run parity:native`
- `npm run parity:native-stages`
- `npm run test:official-assets`
- `npm run release:check`

If `node` is not on `PATH`, the scripts still resolve it through
`tools/run_node.py` using either `NODE_EXE` or the default Windows install
location.

If the official MHR tooling lives in a separate Python environment, point the
repo at it through environment variables or `.repo_local_config.json`:

- `PYTHON_EXE`
- `MHR_REF_ROOT`
- `MHR_ASSET_ROOT`

See `.repo_local_config.example.json` for the supported local keys. The
heavy official-asset smoke test is opt-in and requires `MHR_REAL_ASSET_SMOKE=1`.
