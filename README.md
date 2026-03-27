# MHR Play

`MHR Play` is an embeddable `front-end + worker` application for MHR-focused
runtime exploration. The repository now covers the bootstrap slice plus the
first real-asset offline lane: a Play-inspired architecture skeleton, frozen
runtime contracts, generated worker protocol glue, a processed bundle loader,
and an official MHR TorchScript-based preprocessing/oracle path.

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

## Layout

- `app/`: bootstrap, shell, public mount surface, host contract
- `backend/`: main-thread worker proxy and latest evaluation owner
- `core/`: runtime config, logging helpers, bundle validation
- `renderer/`: placeholder scene pipeline and viewport ownership
- `ui/`: UI-only store and coarse control surface
- `worker/`: generated protocol glue and worker runtime owner
- `tools/`: dev server, protocol generator, boundary checker, preprocessing,
  oracle generation, local config helpers
- `tests/`: Node-based tooling and contract checks
- `doc/`: product, architecture, parity, asset, and integration contracts

## Commands

- `npm run dev`
- `npm run generate:protocol`
- `npm run ci:guard`
- `npm run test`
- `npm run preprocess:official`
- `npm run parity:python`
- `npm run test:official-assets`

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
