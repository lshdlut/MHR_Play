English | [简体中文](README.zh-CN.md)

# MHR Play

![MHR Play main view](assets/main.png)

MHR Play is a public-facing interactive MHR experience built on top of `mujoco-wasm-play`. It combines official MHR assets, an optimized WASM runtime, and a Play-style Three.js viewer into a single browser product surface.

## Highlights

- **Full official MHR asset path**: the page loads the full official runtime IR instead of a simplified demo mesh.
- **Play-style browser UI**: panels, HUD, camera controls, and scene interaction are hosted by `mujoco-wasm-play`.
- **Multi-LoD support**: the same runtime surface supports `lod0..lod6` and can switch LoD in-page.
- **Rich debugging overlays**: skeleton, joint labels, local axes, and influence-preview heatmaps are available in the viewer.
- **Performance-oriented runtime**: the heavy-family WASM core has been optimized specifically for interactive `blend` / `expression` workloads.

## Gallery

| Main | Skin / Skeleton / Labels | Influence Preview |
|---|---|---|
| ![Main view](assets/main.png) | ![Skin and skeleton overlays](assets/skin_skel_axes_label.png) | ![Influence heatmap](assets/influence_heatmap.png) |

Additional view:

![Skeleton view](assets/skel.png)

## Quickstart

- Start the local page from the repository root:

```powershell
$env:PYTHON_EXE='<python>'
powershell -NoProfile -ExecutionPolicy Bypass -File .\mjwp_inject\run.ps1 -PlaySrc ..\mujoco-wasm-play -Port 4269 -Lod 1
```

- Open:

```text
http://127.0.0.1:4269/mhr.html?lod=1
```

- If the port is busy, change both `-Port` and the URL port together.
- To test a different LoD, change both `-Lod` and the `?lod=` query parameter.

## Project Layout

- `mjwp_inject/`: downstream Play assembly, MHR profile/plugin, public page entry
- `assets/`: screenshots used for public-facing presentation
- `tools/`: preprocessing, build, bench, smoke, and repository guardrails
- `tests/`: tooling, contract, and smoke regression coverage
- `native/`: portable runtime core and C ABI

## Notes

- `mjwp_inject/site/mhr.html` is the only interactive product surface in this repo.
- The old standalone/embed product shell is intentionally removed.
- Internal research notes and historical contract writeups are now local-only archive material and are no longer part of the public documentation set.
