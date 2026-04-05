#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import stat
import shutil
from pathlib import Path


PLAY_ALLOWLIST = (
    "favicon.ico",
    "site_config.js",
    "app",
    "assets",
    "backend",
    "bridge",
    "core",
    "environment",
    "renderer",
    "spec",
    "ui",
    "worker",
)

SCREENSHOT_ALLOWLIST = (
    "main.png",
    "influence_heatmap.png",
    "skin_skel_axes_label.png",
    "skel.png",
)


SUN_PRESET_OLD = """  sun: {
    // Bright daytime preset: strong directional light with moderate IBL so
    // shadows remain clearly visible.
    background: 0x8fb8ec,
    // Base clear colour used when no skybox/environment is active.
    clearColor: 0xe6ebf2,
    exposure: 0.82,
    ambient: { color: 0xf0f4ff, intensity: 0.15 },
    hemi: { sky: 0xf0f4ff, ground: 0x10121a, intensity: 0.24 },
    dir: {
      color: 0xffffff,
      intensity: 3.1,
      position: [9, -5.3, 6],
      target: [0, 0, 1],
      shadowBias: -0.0001,
    },
    fill: { color: 0xb6d5ff, intensity: 0.16, position: [-4, 3, 2] },
    shadowBias: -0.00015,
    // Kept deliberately low so HDRI does not wash out shadows.
    envIntensity: 0.48,
    // Preset-specific environment settings
    hdriFile: 'rustig_koppie_puresky_4k.hdr',
    backgroundMode: 'hdri',
    backgroundBottom: 0xf3f6fb,
    ground: {
      style: 'shadow',
      opacity: 1.0,
      color: 0xe8e6e0,
      metallic: 0,
      roughness: 0.86,
      surface: {
        albedoFile: 'preset-ground/sandy_gravel_diff_2k.jpg',
        normalFile: 'preset-ground/sandy_gravel_nor_gl_2k.png',
        roughnessFile: 'preset-ground/sandy_gravel_rough_2k.png',
        projection: 'infinite',
        // Sandy Gravel captures a much smaller ground footprint, so keeping
        // repeat near 0.95 preserves its denser near-field texel density.
        repeat: 0.95,
        albedoGain: 1.8,
        normalScale: 0.36,
      },
      infinite: {
        distance: 2000,
        fadePow: 2.5,
        fadeStartFactor: 0.6,
        gridStep: 2.0,
        gridIntensity: 0.0,
        gridColor: 0x3a4250,
      },
    },
"""

SUN_PRESET_NEW = """  sun: {
    // Bright daytime preset tuned for the public MHR viewer.
    background: 0x8fb8ec,
    clearColor: 0xe6ebf2,
    exposure: 0.82,
    ambient: { color: 0xf0f4ff, intensity: 0.28 },
    hemi: { sky: 0xf0f4ff, ground: 0xffffff, intensity: 0.34 },
    dir: {
      color: 0xffffff,
      intensity: 1.55,
      position: [9, -5.3, 6],
      target: [0, 0, 1],
      shadowBias: -0.0001,
    },
    fill: { color: 0xe7efff, intensity: 0.30, position: [-4, 3, 2] },
    shadowBias: -0.00015,
    envIntensity: 0.66,
    hdriFile: 'rustig_koppie_puresky_4k.hdr',
    backgroundMode: 'hdri',
    backgroundBottom: 0xf3f6fb,
    ground: {
      style: 'shadow',
      opacity: 1.0,
      color: 0xffffff,
      metallic: 0,
      roughness: 0.98,
      surface: null,
      infinite: {
        distance: 2000,
        fadePow: 2.5,
        fadeStartFactor: 0.6,
        gridStep: 2.0,
        gridIntensity: 0.0,
        gridColor: 0x3a4250,
      },
    },
"""

PIPELINE_FRAME_SUBSCRIBERS_OLD = """  const frameSubscribers = new Set();
  let pendingSceneSnapshot = null;
"""

PIPELINE_FRAME_SUBSCRIBERS_NEW = """  const frameSubscribers = new Set();
  const labelOverlaySubscribers = new Set();
  let pendingSceneSnapshot = null;
"""

PIPELINE_ONFRAME_OLD = """  function onFrame(fn) {
    if (typeof fn !== 'function') return () => {};
    frameSubscribers.add(fn);
    return () => frameSubscribers.delete(fn);
  }

"""

PIPELINE_ONFRAME_NEW = """  function onFrame(fn) {
    if (typeof fn !== 'function') return () => {};
    frameSubscribers.add(fn);
    return () => frameSubscribers.delete(fn);
  }

  function onLabelOverlay(fn) {
    if (typeof fn !== 'function') return () => {};
    labelOverlaySubscribers.add(fn);
    return () => labelOverlaySubscribers.delete(fn);
  }

"""

PIPELINE_LABEL_BLOCK_OLD = """      if (lastFrameSnapshot && lastFrameState) {
        renderLabelOverlay(ctx, lastFrameSnapshot, lastFrameState, {
          hideAllGeometry: !!lastFrameState?.rendering?.hideAllGeometry,
        });
      } else {
        clearLabelOverlay(ctx);
      }
      if (perfEnabled) {
"""

PIPELINE_LABEL_BLOCK_NEW = """      if (lastFrameSnapshot && lastFrameState) {
        renderLabelOverlay(ctx, lastFrameSnapshot, lastFrameState, {
          hideAllGeometry: !!lastFrameState?.rendering?.hideAllGeometry,
        });
      } else {
        clearLabelOverlay(ctx);
      }
      if (labelOverlaySubscribers.size) {
        const overlay = syncLabelOverlayViewport(ctx);
        for (const fn of labelOverlaySubscribers) {
          try {
            fn({
              ctx,
              overlay,
              snapshot: lastFrameSnapshot,
              state: lastFrameState,
              frame,
            });
          } catch (err) {
            logWarn('[clock] label overlay subscriber error', err);
            strictCatch(err, 'main:clock_label_overlay_subscriber');
          }
        }
      }
      if (perfEnabled) {
"""

PIPELINE_RETURN_OLD = """    renderScene,
    ensureRenderLoop,
    updateViewport: () => updateRendererViewport(),
    onFrame,
    getContext,
"""

PIPELINE_RETURN_NEW = """    renderScene,
    ensureRenderLoop,
    updateViewport: () => updateRendererViewport(),
    onLabelOverlay,
    onFrame,
    getContext,
"""

MAIN_RENDERER_BLOCK_OLD = """    getContext: () => (rendererManager.getContext ? rendererManager.getContext() : (renderCtx.initialized ? renderCtx : null)),
    ensureLoop: () => rendererManager.ensureRenderLoop(),
    renderScene: (snapshot, state) => rendererManager.renderScene(snapshot, state),
    getOverlay3D: () => (rendererManager.getOverlay3D ? rendererManager.getOverlay3D() : null),
"""

MAIN_RENDERER_BLOCK_NEW = """    getContext: () => (rendererManager.getContext ? rendererManager.getContext() : (renderCtx.initialized ? renderCtx : null)),
    ensureLoop: () => rendererManager.ensureRenderLoop(),
    renderScene: (snapshot, state) => rendererManager.renderScene(snapshot, state),
    labelOverlay: {
      register: (fn) => (rendererManager.onLabelOverlay ? rendererManager.onLabelOverlay(fn) : (() => {})),
    },
    getOverlay3D: () => (rendererManager.getOverlay3D ? rendererManager.getOverlay3D() : null),
"""


def copy_path(src: Path, dst: Path) -> None:
    if src.is_dir():
        shutil.copytree(src, dst, dirs_exist_ok=True)
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def remove_path(path: Path) -> None:
    if not path.exists():
        return
    if path.is_dir():
        def onerror(func, failed_path, exc_info):
            os.chmod(failed_path, stat.S_IWRITE)
            func(failed_path)

        shutil.rmtree(path, onerror=onerror)
        return
    path.unlink()


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def load_manifest(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise ValueError(f"Expected source fragment not found while patching {label}.")
    return text.replace(old, new, 1)


def normalize_supported_lods(raw: object, default_lod: int) -> list[int]:
    normalized: list[int] = []
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, int) or item < 0 or item in normalized:
                continue
            normalized.append(item)
    if default_lod not in normalized:
        normalized.insert(0, default_lod)
    return normalized


def build_viewer_html(default_lod: int, supported_lods: list[int]) -> str:
    supported_json = json.dumps(supported_lods)
    return f"""<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>MHR Play Viewer</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" href="./favicon.ico" />
    <link rel="stylesheet" href="./app/viewer_shell.css" />
    <link rel="stylesheet" href="./mhr.css" />
    <script type="importmap">
      {{
        "imports": {{
          "three": "https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.module.js",
          "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.161.0/examples/jsm/"
        }}
      }}
    </script>
    <script src="./site_config.js"></script>
    <script>
      (() => {{
        const defaultLod = {default_lod};
        const supportedLods = {supported_json};
        const url = new URL(window.location.href);
        const rawLod = url.searchParams.get('lod');
        const parsed = rawLod == null || rawLod === '' ? defaultLod : Number(rawLod);
        const lod = Number.isInteger(parsed) && supportedLods.includes(parsed) ? parsed : defaultLod;
        if (!url.searchParams.get('model')) {{
          url.searchParams.set('model', 'model/mhr_stage.xml');
        }}
        if (url.searchParams.get('lod') !== String(lod)) {{
          url.searchParams.set('lod', String(lod));
        }}
        history.replaceState(null, '', url);
        globalThis.PLAY_UI_PROFILE = 'mhr';
        globalThis.PLAY_PLUGINS = ['./plugins/mhr_profile_plugin.mjs'];
        globalThis.PLAY_MHR_SUPPORTED_LODS = supportedLods;
        globalThis.PLAY_MHR_LOD = lod;
        globalThis.PLAY_MHR_MANIFEST_URL = `./mhr-official/lod${{lod}}/manifest.json`;
        globalThis.PLAY_MHR_ASSET_BASE_URL = `./mhr-official/lod${{lod}}/`;
        globalThis.PLAY_UI_PANEL_DEFAULTS = {{ left: true, right: true }};
        globalThis.PLAY_UI_SECTION_DEFAULT_OPEN = {{
          left: {{
            'plugin:mhr-control': true,
            'plugin:mhr-scale': true,
            'plugin:mhr-blend': true
          }},
          right: {{
            'plugin:mhr-pose': true,
            'plugin:mhr-fixed': true
          }}
        }};
      }})();
    </script>
    <script data-play-entry-variant="single" src="./app/entry_bootstrap.js"></script>
  </head>
  <body>
    <script data-play-shell-module="./app/main.mjs" src="./app/viewer_shell.js"></script>
  </body>
</html>
"""


def build_landing_html(default_lod: int, supported_lods: list[int], viewer_path: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>MHR Play</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" href="./{viewer_path}/favicon.ico" />
    <style>
      :root {{
        color-scheme: light;
        --page-bg: #f3f4ef;
        --panel-bg: rgba(255, 255, 255, 0.92);
        --panel-border: rgba(36, 44, 33, 0.14);
        --text: #20251c;
        --muted: #5d6858;
        --accent: #254f38;
        --accent-soft: #e4eee4;
        --frame-bg: #dce5d8;
        --shadow: 0 28px 80px rgba(32, 37, 28, 0.12);
        --radius: 22px;
      }}
      * {{ box-sizing: border-box; }}
      body {{
        margin: 0;
        font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(104, 145, 95, 0.18), transparent 34%),
          linear-gradient(180deg, #fafaf6 0%, var(--page-bg) 100%);
      }}
      main {{
        max-width: 1380px;
        margin: 0 auto;
        padding: 40px 24px 56px;
      }}
      .hero {{
        display: grid;
        grid-template-columns: minmax(280px, 420px) minmax(0, 1fr);
        gap: 24px;
        align-items: start;
      }}
      .copy,
      .preview,
      .gallery {{
        background: var(--panel-bg);
        border: 1px solid var(--panel-border);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
        backdrop-filter: blur(14px);
      }}
      .copy {{
        padding: 28px;
      }}
      .copy h1 {{
        margin: 0 0 12px;
        font-size: clamp(2rem, 3.2vw, 3.2rem);
        line-height: 1.04;
      }}
      .copy p {{
        margin: 0;
        color: var(--muted);
        line-height: 1.58;
        font-size: 1rem;
      }}
      .badge {{
        display: inline-flex;
        margin-bottom: 14px;
        padding: 7px 12px;
        border-radius: 999px;
        font-size: 0.8rem;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--accent);
        background: var(--accent-soft);
      }}
      .actions {{
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-top: 22px;
      }}
      .actions a {{
        text-decoration: none;
        border-radius: 999px;
        padding: 11px 18px;
        font-weight: 600;
      }}
      .actions a.primary {{
        color: white;
        background: var(--accent);
      }}
      .actions a.secondary {{
        color: var(--accent);
        background: var(--accent-soft);
      }}
      .meta {{
        margin-top: 18px;
        display: grid;
        gap: 8px;
        color: var(--muted);
        font-size: 0.92rem;
      }}
      .preview {{
        padding: 14px;
      }}
      .preview-header {{
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
        padding: 2px 4px 14px;
      }}
      .preview-header h2 {{
        margin: 0;
        font-size: 1rem;
      }}
      .preview-header p {{
        margin: 4px 0 0;
        color: var(--muted);
        font-size: 0.9rem;
      }}
      .preview-shell {{
        width: 100%;
        aspect-ratio: 16 / 9;
        border-radius: 18px;
        overflow: hidden;
        background: var(--frame-bg);
      }}
      iframe {{
        width: 100%;
        height: 100%;
        border: 0;
        display: block;
      }}
      .gallery {{
        margin-top: 24px;
        padding: 18px;
      }}
      .gallery h2 {{
        margin: 0 0 16px;
        font-size: 1.05rem;
      }}
      .gallery-grid {{
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 14px;
      }}
      .gallery-card {{
        border-radius: 18px;
        overflow: hidden;
        background: white;
        border: 1px solid rgba(36, 44, 33, 0.08);
      }}
      .gallery-card img {{
        width: 100%;
        aspect-ratio: 4 / 3;
        object-fit: cover;
        display: block;
      }}
      .gallery-card strong {{
        display: block;
        padding: 12px 14px 4px;
        font-size: 0.94rem;
      }}
      .gallery-card span {{
        display: block;
        padding: 0 14px 14px;
        color: var(--muted);
        font-size: 0.88rem;
        line-height: 1.45;
      }}
      @media (max-width: 980px) {{
        .hero {{
          grid-template-columns: 1fr;
        }}
        .gallery-grid {{
          grid-template-columns: 1fr;
        }}
      }}
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div class="copy">
          <div class="badge">Public Viewer</div>
          <h1>MHR Play</h1>
          <p>MHR Play is a Play-hosted browser viewer for official MHR assets, the portable WASM runtime, and the full interactive profile UI. The public GitHub Pages build ships a subpath-safe LoD1 viewer that can later be embedded directly into another site shell.</p>
          <div class="actions">
            <a class="primary" id="open-full" href="./{viewer_path}/?lod={default_lod}">Open full viewer</a>
            <a class="secondary" href="https://github.com/lshdlut/MHR_Play">Source on GitHub</a>
          </div>
          <div class="meta">
            <div>Public runtime: optimized sparse portable route</div>
            <div>Public asset scope: LoD {supported_lods[0]}-{supported_lods[-1]} runtime IR bundles</div>
            <div>Embed-ready entrypoint: <code>./{viewer_path}/?embed=1&amp;lod={default_lod}</code></div>
          </div>
        </div>
        <div class="preview">
          <div class="preview-header">
            <div>
              <h2>Live Preview</h2>
              <p>The embedded frame below uses the same viewer entry that downstream sites can iframe later.</p>
            </div>
          </div>
          <div class="preview-shell">
            <iframe id="demo-frame" title="MHR Play demo" loading="lazy"></iframe>
          </div>
        </div>
      </section>
      <section class="gallery">
        <h2>Feature Glimpses</h2>
        <div class="gallery-grid">
          <article class="gallery-card">
            <img src="./assets/influence_heatmap.png" alt="Influence preview heatmap" />
            <strong>Influence Preview</strong>
            <span>Heatmap debugging on the live surface deformation route.</span>
          </article>
          <article class="gallery-card">
            <img src="./assets/skin_skel_axes_label.png" alt="Skin, skeleton, axes, and labels" />
            <strong>Skin / Skeleton / Joint Axes / Labels</strong>
            <span>Overlay-rich scene debugging inside the Play-hosted interface.</span>
          </article>
          <article class="gallery-card">
            <img src="./assets/skel.png" alt="Skeleton view" />
            <strong>Skeleton View</strong>
            <span>Clean bone-space inspection with the portable runtime output.</span>
          </article>
        </div>
      </section>
    </main>
    <script>
      (() => {{
        const params = new URLSearchParams(window.location.search);
        const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
        const font = new Set(['50', '75', '100', '150', '200']).has(String(params.get('font') || '')) ? String(params.get('font')) : '75';
        const spacing = params.get('spacing') === 'wide' ? 'wide' : 'tight';
        const viewerUrl = new URL('./{viewer_path}/', window.location.href);
        viewerUrl.searchParams.set('lod', '{default_lod}');
        viewerUrl.searchParams.set('theme', theme);
        viewerUrl.searchParams.set('font', font);
        viewerUrl.searchParams.set('spacing', spacing);
        const fullUrl = new URL(viewerUrl.href);
        viewerUrl.searchParams.set('embed', '1');
        document.getElementById('demo-frame').src = viewerUrl.href;
        document.getElementById('open-full').href = fullUrl.href;
      }})();
    </script>
  </body>
</html>
"""


def write_public_site_config(path: Path, play_ver: str, forge_base_template: str) -> None:
    content = f"""// Auto-generated by tools/build_github_pages.py.
globalThis.PLAY_VER = {json.dumps(play_ver)};
globalThis.__FORGE_DIST_BASE__ = {json.dumps(forge_base_template)};
"""
    write_text(path, content)


def apply_play_host_tuning(viewer_root: Path) -> None:
    environment_path = viewer_root / "environment" / "environment.mjs"
    environment_text = environment_path.read_text(encoding="utf-8")
    environment_text = replace_once(
        environment_text,
        SUN_PRESET_OLD,
        SUN_PRESET_NEW,
        "environment/environment.mjs",
    )
    write_text(environment_path, environment_text)

    pipeline_path = viewer_root / "renderer" / "pipeline.mjs"
    pipeline_text = pipeline_path.read_text(encoding="utf-8")
    pipeline_text = replace_once(
        pipeline_text,
        PIPELINE_FRAME_SUBSCRIBERS_OLD,
        PIPELINE_FRAME_SUBSCRIBERS_NEW,
        "renderer/pipeline.mjs frame subscribers",
    )
    pipeline_text = replace_once(
        pipeline_text,
        PIPELINE_ONFRAME_OLD,
        PIPELINE_ONFRAME_NEW,
        "renderer/pipeline.mjs onFrame hook",
    )
    pipeline_text = replace_once(
        pipeline_text,
        PIPELINE_LABEL_BLOCK_OLD,
        PIPELINE_LABEL_BLOCK_NEW,
        "renderer/pipeline.mjs label overlay block",
    )
    pipeline_text = replace_once(
        pipeline_text,
        PIPELINE_RETURN_OLD,
        PIPELINE_RETURN_NEW,
        "renderer/pipeline.mjs return block",
    )
    write_text(pipeline_path, pipeline_text)

    main_path = viewer_root / "app" / "main.mjs"
    main_text = main_path.read_text(encoding="utf-8")
    main_text = replace_once(
        main_text,
        MAIN_RENDERER_BLOCK_OLD,
        MAIN_RENDERER_BLOCK_NEW,
        "app/main.mjs renderer host block",
    )
    write_text(main_path, main_text)


def build_site(
    play_src: Path,
    out_root: Path,
    viewer_path: str,
    default_lod: int,
    supported_lods: list[int],
    play_ver: str,
    forge_base_template: str,
) -> None:
    viewer_root = out_root / viewer_path
    remove_path(out_root)
    viewer_root.mkdir(parents=True, exist_ok=True)

    for rel in PLAY_ALLOWLIST:
      copy_path(play_src / rel, viewer_root / rel)

    write_public_site_config(viewer_root / "site_config.js", play_ver=play_ver, forge_base_template=forge_base_template)
    apply_play_host_tuning(viewer_root)

    copy_path(Path("mjwp_inject/site/mhr.css"), viewer_root / "mhr.css")
    copy_path(Path("mjwp_inject/site/model/mhr_stage.xml"), viewer_root / "model" / "mhr_stage.xml")
    copy_path(Path("mjwp_inject/plugin/plugins/mhr_profile_plugin.mjs"), viewer_root / "plugins" / "mhr_profile_plugin.mjs")
    copy_path(Path("mjwp_inject/plugin/profiles/mhr"), viewer_root / "profiles" / "mhr")
    public_asset_root = Path("public_assets/mhr-official")
    for lod in supported_lods:
        source_dir = public_asset_root / f"lod{lod}"
        if not source_dir.exists():
            raise FileNotFoundError(f"Missing public runtime IR assets for lod{lod}: {source_dir}")
        copy_path(source_dir, viewer_root / "mhr-official" / f"lod{lod}")

    for screenshot in SCREENSHOT_ALLOWLIST:
        copy_path(Path("assets") / screenshot, out_root / "assets" / screenshot)

    viewer_html = build_viewer_html(default_lod, supported_lods)
    write_text(viewer_root / "index.html", viewer_html)
    write_text(viewer_root / "mhr.html", viewer_html)
    write_text(out_root / "index.html", build_landing_html(default_lod, supported_lods, viewer_path))
    write_text(out_root / ".nojekyll", "")


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the public GitHub Pages site for MHR Play.")
    parser.add_argument("--play-src", type=Path, required=True, help="Path to a mujoco-wasm-play checkout.")
    parser.add_argument("--out", type=Path, required=True, help="Output directory for the assembled static site.")
    parser.add_argument("--manifest", type=Path, default=Path("release/site_manifest.json"), help="Pages build manifest.")
    args = parser.parse_args()

    manifest = load_manifest(args.manifest)
    play = manifest.get("play", {})
    forge = manifest.get("forge", {})
    pages = manifest.get("pages", {})
    play_ver = str(play.get("ver", "")).strip()
    forge_base_template = str(forge.get("baseTemplate", "")).strip()
    viewer_path = str(pages.get("viewerPath", "viewer")).strip().strip("/")
    default_lod = int(pages.get("defaultLod", 1))
    supported_lods = normalize_supported_lods(pages.get("supportedLods"), default_lod)
    if not play_ver:
        raise ValueError("release/site_manifest.json must set play.ver")
    if not forge_base_template:
        raise ValueError("release/site_manifest.json must set forge.baseTemplate")
    if not viewer_path:
        raise ValueError("release/site_manifest.json must set a non-empty pages.viewerPath")

    play_src = args.play_src.expanduser().resolve()
    out_root = args.out.expanduser().resolve()
    if not play_src.exists():
        raise FileNotFoundError(f"Play source checkout not found: {play_src}")

    build_site(
        play_src=play_src,
        out_root=out_root,
        viewer_path=viewer_path,
        default_lod=default_lod,
        supported_lods=supported_lods,
        play_ver=play_ver,
        forge_base_template=forge_base_template,
    )
    print(f"Built GitHub Pages site -> {out_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
