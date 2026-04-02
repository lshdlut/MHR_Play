# Host Integration

`MHR_Play` no longer exposes a standalone in-repo shell. The supported host
surface is the Play-hosted downstream assembly under `mjwp_inject/`.

## Public Surface

- `mjwp_inject/site/mhr.html`
- `mjwp_inject/run.ps1`
- `mjwp_inject/patches/*.patch`
- `mjwp_inject/plugin/**`

## Ownership Boundary

- upstream `mujoco-wasm-play` remains an unmodified host checkout
- `MHR_Play` owns the MHR plugin, backend/service glue, page glue, and smoke
  tooling
- shared runtime helpers under `core/` and `worker/` are copied into the
  disposable clone as implementation inputs
- official runtime IR assets remain external to the Play checkout and are
  mounted through `mjwp_inject/server.py`

## Integration Rule

Consumers should validate and iterate through the disposable Play clone only.
Do not reintroduce a second standalone shell or a tracked low-poly demo page in
this repository.
