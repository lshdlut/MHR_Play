## mjwp_inject (MHR Play + disposable mujoco-wasm-play clone)

This directory owns the downstream Play-hosted MHR surface.

It does **not** modify the sibling `mujoco-wasm-play` working tree. Instead it:

- clones or reuses a disposable `mujoco-wasm-play` workspace,
- overlays the MHR-owned plugin/runtime/page/assets/tests from this repo, and
- serves the assembled clone locally.

### Quick start (Windows PowerShell)

```powershell
.\mjwp_inject\run.ps1 -PlaySrc ..\mujoco-wasm-play
```

By default the script serves:

```text
http://127.0.0.1:4173/mhr.html
```

### Notes

- `-PlayRef <tag|sha>` can pin the disposable clone to a specific upstream Play revision.
- `-Clean` removes the previous disposable clone before re-cloning.
- `-NoServe` prepares the clone without starting the local server.
- On first local run, `run.ps1` will compile `local_tools/official_bundle/manifest.json` into `local_tools/official_runtime_ir/` when the full runtime IR is missing.
- The injected `tools/dev_server.py` reads `MHR_PLAY_ROOT` so the disposable clone can mount this repo's `local_tools/official_runtime_ir` under `/mhr-official/`.

### Browser smoke

With the disposable clone server running:

```powershell
python tools/mjwp_inject_smoke.py http://127.0.0.1:4173
```
