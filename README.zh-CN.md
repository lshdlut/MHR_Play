# MHR Play

[English](README.md) | 简体中文

**主 viewer：** [https://lshdlut.com/en/demos/mhr-play/](https://lshdlut.com/en/demos/mhr-play/)

![MHR Play main view](assets/main.png)

MHR Play 是一个面向公众展示的 Meta [Momentum Human Rig (MHR)](https://arxiv.org/abs/2511.15586) 浏览器体验页，构建在 [mujoco-wasm-play](https://github.com/lshdlut/mujoco-wasm-play) 之上。它把官方 [MHR 仓库](https://github.com/facebookresearch/MHR)、官方 MHR 资产、优化后的 WASM runtime，以及 Play 风格的 Three.js 界面整合到同一条浏览器产品线上，同时提供一个 [GitHub Pages 镜像](https://lshdlut.github.io/MHR_Play/)。

## 亮点

- **完整官方 MHR 资产链**：页面直接加载 full official runtime IR，而不是简化 demo 模型。
- **Play 风格的交互界面**：沿用 [mujoco-wasm-play](https://github.com/lshdlut/mujoco-wasm-play) 的面板、视图控制、HUD 和 Three.js 场景。
- **基于 mujoco-wasm-play**：它提供了我们自己的轻量 Play-hosted viewer 壳，适合浏览器优先、可嵌入的 MuJoCo 应用。
- **多 LoD 支持**：本地/runtime 主线支持 `lod0..lod6`；当前公开浏览器部署提供可嵌入的 `lod1..lod6` viewer。
- **可视化调试能力**：支持 skeleton、joint labels、local axes、influence preview heatmap 等表达。
- **性能导向的浏览器 runtime**：heavy family 的 core 已针对 WASM 路线做过专项优化。

## 对齐说明

- portable runtime 走的是优化后的 sparse 执行路径，**不是**对 **official full-package CPU route**（`official-full-cpu`）的 bitwise exact 对齐。
- 在当前 golden cases 上，剩余的 vertex 误差维持在低 `1e-5` 量级，和 **official TorchScript model route**（`official-torchscript`，仅 `lod=1`）属于同一数量级。
- official TorchScript model route 目前只作为次级参考路线保留，不是主 public runtime。
- GitHub Pages 镜像刻意不包含 `lod0`；当前上线的是 `lod1..lod6`，更重的 `lod0` 留给更大的站点托管。

## 展示

| Influence Preview | Skin / Skeleton / Joint Axes / Labels | Skeleton View |
|---|---|---|
| <img src="assets/influence_heatmap.png" alt="Influence heatmap" height="320" /> | <img src="assets/skin_skel_axes_label.png" alt="Skin, skeleton, joint axes, and labels" height="320" /> | <img src="assets/skel.png" alt="Skeleton view" height="320" /> |

## 快速开始

- 在仓库根目录用你自己的 [mujoco-wasm-play](https://github.com/lshdlut/mujoco-wasm-play) checkout 启动本地页面：

```powershell
$env:PYTHON_EXE='<python>'
powershell -NoProfile -ExecutionPolicy Bypass -File .\mjwp_inject\run.ps1 -PlaySrc <path-to-mujoco-wasm-play> -Port 4269 -Lod 1
```

- 打开：

```text
http://127.0.0.1:4269/mhr.html?lod=1
```

- 如果端口被占用，只改 `-Port` 和 URL 里的端口即可。
- 如果要切换 LoD，把命令里的 `-Lod` 和 URL 里的 `?lod=` 改成对应编号。

## 项目概览

- `mjwp_inject/`: Play 下游装配层、MHR profile/plugin、页面入口
- `assets/`: README 与公开展示使用的截图素材
- `public_assets/`: 公共部署构建使用的跟踪 viewer 资产
- `tools/`: 预处理、构建、bench、smoke、仓库约束检查
- `tests/`: tooling / contract / smoke 回归
- `native/`: portable runtime core 与 C ABI

## 鸣谢

- 感谢 Meta 发布 [Momentum Human Rig (MHR)](https://github.com/facebookresearch/MHR) 及论文 [MHR: Momentum Human Rig](https://arxiv.org/abs/2511.15586)。
