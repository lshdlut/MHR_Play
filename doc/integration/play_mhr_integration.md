# Play-hosted MHR Integration

`MHR_Play` now owns the downstream Play-hosted MHR product surface.

The integration model is:

- upstream `mujoco-wasm-play` stays an unmodified host repo on its `main` branch,
- `MHR_Play/mjwp_inject/overlay/` contains the MHR-specific Play-facing files that used to live in a local Play working tree,
- `MHR_Play/mjwp_inject/run.ps1` assembles a disposable Play clone, overlays those files, and serves `mhr.html`.

This keeps the upstream Play checkout clean while preserving the current MHR page, plugin, runtime glue, assets, and browser/perf test surfaces in a product-owned repo.

For the original performance investigation that motivated the Play-hosted MHR UI changes, see [`mhr_backend_perf_investigation.md`](./mhr_backend_perf_investigation.md).

For a disposable-clone browser smoke after assembly, run:

```powershell
python tools/mjwp_inject_smoke.py http://127.0.0.1:4173
```
