# MHR Play Architecture Charter

This document is the MHR-specific runtime charter for the bootstrap slice. It
defines ownership, lifecycle, and allowed side effects for the repository while
the project remains in the M0-M3 stage.

## Product Goal

Build an embeddable `MHR Play` module with:

- a front-end shell for UI, interaction, and rendering
- a worker/runtime layer for MHR evaluation
- a narrow host integration contract

The host site is a container, not the place where MHR runtime logic lives.

## Runtime Scope

Included runtime areas:

- `app/`
- `backend/`
- `core/`
- `renderer/`
- `ui/`
- `worker/`

Excluded from runtime scope for this slice:

- `tests/`
- `tools/`
- `doc/`
- any future plugin or environment system
- raw official asset parsing in the browser runtime

## System Layers

The repository currently enforces this coarse import DAG:

- `base`: shared runtime helpers under `core/`
- `protocol`: generated worker protocol glue under `worker/protocol.gen.mjs` and `worker/dispatch.gen.mjs`
- `worker`: worker runtime owner
- `backend`: main-thread worker proxy
- `ui`: UI-only state and controls
- `renderer`: viewport ownership and rendering
- `entry`: application assembly under `app/`

## Lifecycle

### 1. Bootstrap

Owner: `app/entry_bootstrap.js` for standalone bootstrap,
`app/standalone_entry.mjs` for standalone auto-mount wiring

Responsibilities:

- read standalone-shell URL parameters
- normalize runtime config into `globalThis.__MHR_PLAY_RUNTIME_CONFIG__`
- apply pre-mount shell state such as theme and embed mode

Rule:

- runtime input discovery happens in bootstrap only for the standalone shell
- no downstream runtime module may treat URL parameters as a primary source
- embed integrations must supply explicit `runtimeConfig` / `assetConfig`

### 2. Main-thread Assembly

Owner: `app/mount.mjs`

Responsibilities:

- mount the shell
- resolve explicit host config before consulting standalone bootstrap state
- create the backend, store, renderer, and coarse controls
- wire backend snapshots into renderer and UI consumers
- expose the public host surface

Library entry:

- `app/main.mjs` is library-only and exports `mountMhrPlay`
- standalone auto-mount behavior lives in `app/standalone_entry.mjs`

### 3. Backend Proxy

Owner: `backend/backend_core.mjs`

Responsibilities:

- spawn and own the worker
- send commands through the generated protocol
- receive worker events and publish the latest evaluation snapshot
- remain the only main-thread owner of runtime truth

### 4. Worker Runtime

Owner: `worker/mhr.worker.mjs`

Responsibilities:

- own runtime state and evaluation sequencing
- accept asset, state, and evaluation commands
- emit formal events back to the main thread

Current state:

- the worker owns the shipped browser-side wasm runtime
- processed bundle loading, semantic state transport, evaluation, and result
  readback all occur inside `worker/mhr.worker.mjs`
- native reference work lives under `native/` and includes a reference-only
  exact-kernel path for oracle parity

### 5. UI Store

Owner: `ui/state.mjs`

Responsibilities:

- own UI-only shell state
- store compare mode, panel state, and future control-tier state

Rule:

- the UI store must not mirror mesh buffers, skeleton buffers, or other large
  runtime-owned payloads

### 6. Renderer

Owner: `renderer/pipeline.mjs`

Responsibilities:

- consume backend snapshots and UI state
- own viewport rendering and resize behavior

## Ownership Matrix

| State / Buffer | Owner | Notes |
| --- | --- | --- |
| Normalized runtime config | `app/entry_bootstrap.js` + `core/runtime_config.mjs` | Page lifetime |
| Latest evaluation snapshot | `backend/backend_core.mjs` | Main-thread runtime truth |
| Worker runtime state | `worker/mhr.worker.mjs` | Reset on worker restart |
| UI shell state | `ui/state.mjs` | UI only, not runtime truth |
| Viewport draw state | `renderer/pipeline.mjs` | Derived from snapshot + UI state |

## Public Host Contract

The mounted host surface is formal and versioned. The current minimum API is:

- `mountMhrPlay({ root, runtimeConfig?, assetConfig? })`
- `loadAssets`
- `setState`
- `getState`
- `evaluate`
- `resize`
- `destroy`

Embedding is allowed to depend on this surface, not on ad hoc globals or
internal module imports.

## Public Beta Surfaces

- `index.html`: standalone public beta shell that auto-loads the tracked demo bundle
- `embed.html`: explicit host-mount demo that exercises the stable embed contract
- `dist/public_beta/`: export target for local release checks and GitHub Pages style deployment

## Architectural Invariants

- Bootstrap is the only primary runtime input collector.
- Standalone URL parsing is allowed only in bootstrap.
- Explicit host config wins over bootstrap-derived config.
- Backend snapshot is the only main-thread runtime truth.
- UI state stays UI-only.
- Worker protocol is formal and generated.
- The repository stays `play`-inspired in shape, but `MHR`-specific in meaning.
- The shipped browser runtime consumes processed bundles only.
