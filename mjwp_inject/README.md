## mjwp_inject (MHR Play + disposable mujoco-wasm-play clone)

This directory owns the downstream Play-hosted MHR surface.

It does **not** modify the sibling `mujoco-wasm-play` working tree. Instead it:

- clones or reuses a disposable `mujoco-wasm-play` workspace,
- applies any tracked generic host patches,
- copies the MHR-owned plugin/page glue from this repo, and
- copies only the required shared runtime modules from the repo root, and
- serves the assembled clone locally.

Directory roles:

- `patches/`: tracked patch set for disposable Play clones
- `plugin/`: MHR-owned plugin/runtime/service/worker files
- `site/`: `mhr.html`, CSS, and stage glue
- `server.py`: MHR-owned dev server with `/forge/`, `/mhr-official/`, and `/mhr-demo/` mounts

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
- `mjwp_inject/server.py` serves the clean Play clone as the root and mounts this repo's `local_tools/official_runtime_ir` under `/mhr-official/`.
- The current tracked patch set restores the MHR-tuned `preset-sun` environment on clean Play clones.

### Browser smoke

With the disposable clone server running:

```powershell
python tools/mjwp_inject_smoke.py http://127.0.0.1:4173
```
