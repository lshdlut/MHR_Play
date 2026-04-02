# MHR Play

`MHR Play` is a Play-hosted MHR product workspace. The repository now keeps a
single runtime surface: a downstream `mujoco-wasm-play` assembly driven by
`mjwp_inject/`. The old standalone/embed shell and the low-poly tracked demo
bundle are intentionally removed.

## Current Status

- `mjwp_inject/` owns the only interactive product surface.
- The injected page loads full official runtime IR assets instead of the old
  tracked low-poly fixture.
- Shared runtime helpers stay under `core/` and `worker/`; they are copied into
  the disposable Play clone as build inputs, not exposed as a second product UI.
- Python is still used for build/proof tooling:
  official-asset preprocessing, wasm/native build steps, parity, bench, and
  smoke helpers.
- The proof lane is intentionally slimmed down to native smoke, portable parity,
  and benchmark entry points.

## Layout

- `core/`: runtime config, logging helpers, bundle validation
- `worker/`: shared wasm module output and protocol generation inputs
- `mjwp_inject/`: disposable Play clone assembly, MHR plugin, page glue, and smoke surface
- `tools/`: protocol generation, boundary/hygiene checks, preprocessing,
  parity, bench, native/wasm builds, and downstream Play smoke
- `tests/`: Node-based tooling and contract checks
- `doc/`: product, architecture, parity, asset, and integration contracts
- `native/`: native reference runtime core and C ABI for parity work

## Repository Hygiene

- The legacy standalone shell, embed shell, and tracked low-poly `demo_assets/`
  are forbidden.
- `dist/`, `local_tools/`, and `tmp/` are local-only output areas and stay ignored.
- `mjwp_inject/` is the only interactive dev/integration surface in this repo.
- Local machine coordination and config stay untracked under `.agents_arena/`,
  `AGENTS.md`, and `.repo_local_config.json`.

## Commands

- `npm run play:dev`
- `npm run generate:protocol`
- `npm run ci:guard`
- `npm run test`
- `npm run preprocess:official`
- `npm run parity:python`
- `npm run parity:portable`
- `npm run bench:native`
- `npm run build:native`
- `npm run build:wasm`
- `npm run test:native-smoke`
- `npm run test:play-smoke`
- `npm run parity:native`
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
