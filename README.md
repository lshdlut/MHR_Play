# MHR Play

`MHR Play` is an embeddable `front-end + worker` application for MHR-focused
runtime exploration. The repository currently covers the bootstrap slice: a
Play-inspired architecture skeleton, frozen runtime contracts, generated worker
protocol glue, and a processed bundle loader exercised through tracked
fixtures.

## Current Status

- Repository shape and layer ownership are established.
- Runtime input ownership is centralized in bootstrap.
- Backend, worker, UI store, renderer, and host boundaries exist as separate
  modules.
- Worker protocol generation is driven by `tools/worker_protocol.json`.
- `mountMhrPlay({ root, runtimeConfig?, assetConfig? })` now treats explicit
  host config as first-class and limits URL-derived config to the standalone
  shell only.
- The worker remains a placeholder runtime owner while the repository freezes
  contracts and runtime ownership.

## Layout

- `app/`: bootstrap, shell, public mount surface, host contract
- `backend/`: main-thread worker proxy and latest evaluation owner
- `core/`: runtime config, logging helpers, bundle validation
- `renderer/`: placeholder scene pipeline and viewport ownership
- `ui/`: UI-only store and coarse control surface
- `worker/`: generated protocol glue and worker runtime owner
- `tools/`: dev server, protocol generator, boundary checker, and local
  runtime helpers
- `tests/`: Node-based tooling and contract checks
- `doc/`: product, architecture, and integration contracts

## Commands

- `npm run dev`
- `npm run generate:protocol`
- `npm run ci:guard`
- `npm run test`

If `node` is not on `PATH`, the scripts still resolve it through
`tools/run_node.py` using either `NODE_EXE` or the default Windows install
location.
