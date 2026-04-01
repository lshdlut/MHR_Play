# MHR Play

`MHR Play` is an embeddable `front-end + worker` application for MHR-focused
runtime exploration. The repository is organized around a standalone shell, a
stable embed surface, a processed demo bundle, a wasm worker runtime, and a
small but credible native/parity proof lane.

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
- `index.html` and `embed.html` are the two public surfaces:
  standalone GitHub Pages style delivery and explicit host embedding.
- `mjwp_inject/` owns the Play-hosted downstream MHR dev surface and assembles a
  disposable clean `mujoco-wasm-play` clone from `patches/`, `plugin/`, and
  `site/` inputs instead of tracking a copied Play tree.

## Layout

- `app/`: bootstrap, shell, public mount surface, host contract
- `backend/`: main-thread worker proxy and latest evaluation owner
- `core/`: runtime config, logging helpers, bundle validation
- `renderer/`: minimal viewer for skin and skeleton consumption
- `ui/`: UI-only store and control surface
- `worker/`: generated protocol glue and wasm runtime owner
- `tools/`: dev server, protocol generator, boundary checker, preprocessing,
  oracle generation, demo-bundle/export/release helpers, and downstream Play smoke
- `tests/`: Node-based tooling and contract checks
- `doc/`: product, architecture, parity, asset, and integration contracts
- `native/`: native reference runtime core and C ABI for parity work

## Repository Hygiene

- `demo_assets/` is tracked because it is part of the shipped standalone site surface.
- `dist/`, `local_tools/`, and `tmp/` are local-only output areas and stay ignored.
- `mjwp_inject/` is dev/integration-only and does not participate in site export.
- Local machine coordination and config stay untracked under `.agents_arena/`,
  `AGENTS.md`, and `.repo_local_config.json`.

## Commands

- `npm run dev`
- `npm run play:dev`
- `npm run generate:protocol`
- `npm run ci:guard`
- `npm run test`
- `npm run preprocess:official`
- `npm run parity:python`
- `npm run parity:portable`
- `npm run bench:native`
- `npm run build:native`
- `npm run build:demo-bundle`
- `npm run build:wasm`
- `npm run build:site`
- `npm run export:site`
- `npm run test:native-smoke`
- `npm run test:browser-smoke`
- `npm run parity:native`
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
