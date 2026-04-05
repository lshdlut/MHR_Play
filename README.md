English | [简体中文](README.zh-CN.md)

# MHR Play

![MHR Play main view](assets/main.png)

MHR Play is a public-facing browser experience for Meta's [Momentum Human Rig (MHR)](https://arxiv.org/abs/2511.15586), built on top of [mujoco-wasm-play](https://github.com/lshdlut/mujoco-wasm-play). It combines the official [MHR repository](https://github.com/facebookresearch/MHR), official MHR assets, an optimized WASM runtime, and a Play-style Three.js UI into a single browser product surface.

- Public viewer: [https://lshdlut.github.io/MHR_Play/](https://lshdlut.github.io/MHR_Play/)
- This GitHub Pages deployment is a lightweight public mirror. The future primary hosted surface will move to `lshdlut site`.

## Highlights

- **Full official MHR asset path**: the page loads the full official runtime IR instead of a simplified demo mesh.
- **Play-style browser UI**: panels, HUD, camera controls, and scene interaction are hosted by [mujoco-wasm-play](https://github.com/lshdlut/mujoco-wasm-play).
- **Built on mujoco-wasm-play**: the project reuses our lightweight Play-hosted viewer shell for browser-first, embed-friendly MuJoCo apps.
- **Multi-LoD support**: the local/runtime surface supports `lod0..lod6`; the public GitHub Pages build ships embeddable `lod1..lod6` viewers.
- **Rich debugging overlays**: skeleton, joint labels, local axes, and influence-preview heatmaps are available in the viewer.
- **Performance-oriented runtime**: the heavy-family WASM core has been optimized specifically for interactive `blend` / `expression` workloads.

## Parity

- The portable runtime follows the optimized sparse execution path and is **not bitwise exact** to the **official full-package CPU route** (`official-full-cpu`).
- On the current golden cases, the remaining vertex residuals stay in the low `1e-5` range, which is the same order of magnitude we observe in the **official TorchScript model route** (`official-torchscript`, `lod=1` only).
- The official TorchScript model route is kept as a secondary reference route, not the primary public runtime.
- The public GitHub Pages deployment intentionally excludes `lod0`; `lod1..lod6` are published there, while the heavier `lod0` bundle is reserved for larger-site hosting later.

## Gallery

| Influence Preview | Skin / Skeleton / Joint Axes / Labels | Skeleton View |
|---|---|---|
| <img src="assets/influence_heatmap.png" alt="Influence heatmap" height="320" /> | <img src="assets/skin_skel_axes_label.png" alt="Skin, skeleton, joint axes, and labels" height="320" /> | <img src="assets/skel.png" alt="Skeleton view" height="320" /> |

## Quickstart

- Start the local page from the repository root with your own [mujoco-wasm-play](https://github.com/lshdlut/mujoco-wasm-play) checkout:

```powershell
$env:PYTHON_EXE='<python>'
powershell -NoProfile -ExecutionPolicy Bypass -File .\mjwp_inject\run.ps1 -PlaySrc <path-to-mujoco-wasm-play> -Port 4269 -Lod 1
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
- `public_assets/`: tracked public viewer assets used by the GitHub Pages build
- `tools/`: preprocessing, build, bench, smoke, and repository guardrails
- `tests/`: tooling, contract, and smoke regression coverage
- `native/`: portable runtime core and C ABI

## Acknowledgements

- Meta for releasing [Momentum Human Rig (MHR)](https://github.com/facebookresearch/MHR) and the paper [MHR: Momentum Human Rig](https://arxiv.org/abs/2511.15586).
