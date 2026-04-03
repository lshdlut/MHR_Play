# MHR Play

[English](README.md) | 简体中文

![MHR Play main view](assets/main.png)

MHR Play 是一个面向公众展示的交互式 MHR 体验页：它把官方 MHR 资产、优化后的 WASM runtime，以及 `mujoco-wasm-play` 的 Three.js 界面整合到同一条浏览器产品线上。

## 亮点

- **完整官方 MHR 资产链**：页面直接加载 full official runtime IR，而不是简化 demo 模型。
- **Play 风格的交互界面**：沿用 `mujoco-wasm-play` 的面板、视图控制、HUD 和 Three.js 场景。
- **多 LoD 支持**：同一条产品线支持 `lod0..lod6`，可在页面内切换。
- **可视化调试能力**：支持 skeleton、joint labels、local axes、influence preview heatmap 等表达。
- **性能导向的浏览器 runtime**：heavy family 的 core 已针对 WASM 路线做过专项优化。

## 展示

| Main | Skin / Skeleton / Labels | Influence Preview |
|---|---|---|
| ![Main view](assets/main.png) | ![Skin and skeleton overlays](assets/skin_skel_axes_label.png) | ![Influence heatmap](assets/influence_heatmap.png) |

额外视图：

![Skeleton view](assets/skel.png)

## 快速开始

- 在仓库根目录启动本地页面：

```powershell
$env:PYTHON_EXE='<python>'
powershell -NoProfile -ExecutionPolicy Bypass -File .\mjwp_inject\run.ps1 -PlaySrc ..\mujoco-wasm-play -Port 4269 -Lod 1
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
- `tools/`: 预处理、构建、bench、smoke、仓库约束检查
- `tests/`: tooling / contract / smoke 回归
- `native/`: portable runtime core 与 C ABI

## 说明

- 当前唯一交互产品面是 `mjwp_inject/site/mhr.html`。
- 仓库不再保留旧 standalone/embed 页面。
- 内部研究型设计稿和历史合同文档已下放到本地归档区，不再作为公开仓库文档的一部分。
