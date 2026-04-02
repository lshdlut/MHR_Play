# MHR Play Architecture Charter

This repository now centers on a single product surface: a Play-hosted MHR page
assembled through `mjwp_inject/`. The previous in-repo standalone/embed shell
has been removed.

## Product Goal

Keep one authoritative interactive scene:

- a clean `mujoco-wasm-play` clone as host
- an MHR-owned plugin, backend/service glue, and page glue
- a wasm/native runtime proof lane for validation and benchmarking

## Runtime Scope

Included runtime areas:

- `core/`
- `worker/`
- `native/`
- `mjwp_inject/`

Excluded from the shipped runtime scope:

- any standalone `index.html` / `embed.html` shell
- tracked low-poly demo assets
- local parity investigations and recovery audits

## System Layers

The repository currently has three active layers:

- `shared runtime`: `core/` and `worker/` build inputs copied into the Play clone
- `downstream surface`: `mjwp_inject/plugin/`, `mjwp_inject/site/`, and minimal `patches/`
- `proof lane`: `native/` plus parity/bench tooling under `tools/`

## Lifecycle

### 1. Disposable Play Assembly

Owner: `mjwp_inject/run.ps1`

Responsibilities:

- clone or refresh a clean `mujoco-wasm-play` checkout
- apply minimal generic host patches
- copy the MHR plugin and page glue
- copy shared runtime inputs needed by the MHR worker
- serve the resulting `mhr.html` through `mjwp_inject/server.py`

### 2. Play-hosted Page

Owner: `mjwp_inject/site/mhr.html`

Responsibilities:

- select the MHR profile
- register the MHR plugin
- point the host page at the mounted official runtime IR manifest

### 3. MHR Plugin Runtime

Owner: `mjwp_inject/plugin/**`

Responsibilities:

- own MHR-specific UI, scene overlays, backend/service glue, and worker bridge
- keep all product-specific behavior out of the upstream Play repo

### 4. Shared Runtime Inputs

Owner: `core/` and `worker/`

Responsibilities:

- validate and load runtime IR manifests/chunks
- provide state-to-raw mapping utilities
- host the built wasm module artifact used by the MHR worker

### 5. Proof Lane

Owner: `native/` and the retained parity/bench tooling

Responsibilities:

- provide a credible native smoke path
- provide portable parity and benchmark entry points
- avoid expanding back into a large internal investigation workbench

## Architectural Invariants

- The only interactive scene is the Play-hosted `mjwp_inject/site/mhr.html` page.
- Shared runtime code may exist at repo root, but it must not expose a second product shell.
- Upstream `mujoco-wasm-play` stays clean; MHR-specific behavior lives in `plugin/`, `site/`, and minimal `patches/`.
- The runtime consumes runtime IR assets, not a tracked low-poly demo bundle.
