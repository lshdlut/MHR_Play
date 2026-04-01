# Play-hosted MHR Integration

`MHR_Play` now owns the downstream Play-hosted MHR product surface.

The integration model is:

- upstream `mujoco-wasm-play` stays an unmodified host repo on its `main` branch,
- `MHR_Play/mjwp_inject/patches/` is reserved for rare generic host patches,
- `MHR_Play/mjwp_inject/plugin/` owns the MHR plugin, backend, service, and worker code,
- `MHR_Play/mjwp_inject/site/` owns `mhr.html`, CSS, and the MHR-specific stage glue,
- `MHR_Play/mjwp_inject/run.ps1` assembles a disposable Play clone from those inputs and serves `mhr.html` through `mjwp_inject/server.py`.

This keeps the upstream Play checkout clean while preserving the MHR page,
plugin, runtime glue, and smoke-test surface in a product-owned repo. The
assembly is intentionally not part of the GitHub Pages export path.

For a disposable-clone browser smoke after assembly, run:

```powershell
python tools/mjwp_inject_smoke.py http://127.0.0.1:4173
```
