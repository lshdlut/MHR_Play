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


def build_viewer_bootstrap_script(
    default_lod: int | None,
    supported_lods: list[int],
    *,
    fallback_manifest_template: str | None,
    fallback_asset_base_template: str | None,
    storage_namespace: str | None,
    built_in_default_open: bool | None,
) -> str:
    supported_json = json.dumps(supported_lods)
    fallback_manifest_json = json.dumps(fallback_manifest_template)
    fallback_asset_base_json = json.dumps(fallback_asset_base_template)
    storage_namespace_line = (
        f"        globalThis.PLAY_UI_STORAGE_NAMESPACE = {json.dumps(storage_namespace)};\n"
        if storage_namespace is not None
        else ""
    )
    built_in_default_open_line = (
        f"        globalThis.PLAY_UI_BUILTIN_DEFAULT_OPEN = {'true' if built_in_default_open else 'false'};\n"
        if built_in_default_open is not None
        else ""
    )
    default_lod_json = "null" if default_lod is None else str(default_lod)
    return f"""      (() => {{
        const defaultLod = {default_lod_json};
        const supportedLods = {supported_json};
        const fallbackManifestTemplate = {fallback_manifest_json};
        const fallbackAssetBaseTemplate = {fallback_asset_base_json};
        const url = new URL(window.location.href);
        const rawLod = url.searchParams.get('lod');
        const configuredLodValue = globalThis.PLAY_MHR_LOD;
        const configuredLod = configuredLodValue == null || configuredLodValue === ''
          ? null
          : Number(configuredLodValue);
        const candidateLod = rawLod == null || rawLod === '' ? configuredLod : Number(rawLod);
        const fallbackLod = Number.isInteger(defaultLod) && supportedLods.includes(defaultLod)
          ? defaultLod
          : (supportedLods[0] ?? 1);
        const lod = Number.isInteger(candidateLod) && supportedLods.includes(candidateLod) ? candidateLod : fallbackLod;

        function replaceLodTemplate(template, numericLod) {{
          return String(template || '').replaceAll('{{lod}}', String(numericLod));
        }}

        function ensureTrailingSlash(rawUrl) {{
          const href = new URL(String(rawUrl || ''), window.location.href).href;
          return href.endsWith('/') ? href : `${{href}}/`;
        }}

        function resolveAbsoluteUrl(rawUrl) {{
          return new URL(String(rawUrl || ''), window.location.href).href;
        }}

        function usesConfiguredLod(numericLod) {{
          return Number.isInteger(configuredLod) && numericLod === configuredLod;
        }}

        function deriveLodPath(rawUrl, numericLod, {{ expectManifest = false }} = {{}}) {{
          const urlValue = String(rawUrl || '').trim();
          if (!urlValue) {{
            return '';
          }}
          const target = new URL(urlValue, window.location.href);
          const nextPath = expectManifest
            ? target.pathname.replace(/\\/lod\\d+\\/manifest\\.json$/i, `/lod${{numericLod}}/manifest.json`)
            : target.pathname.replace(/\\/lod\\d+\\/?$/i, `/lod${{numericLod}}/`);
          if (nextPath === target.pathname) {{
            const fallback = expectManifest
              ? `lod${{numericLod}}/manifest.json`
              : `lod${{numericLod}}/`;
            const baseHref = target.pathname.endsWith('/')
              ? target.href
              : new URL('./', target.href).href;
            const resolved = new URL(fallback, baseHref).href;
            return expectManifest ? resolved : ensureTrailingSlash(resolved);
          }}
          target.pathname = nextPath;
          return expectManifest ? target.href : ensureTrailingSlash(target.href);
        }}

        function resolveManifestUrl(numericLod) {{
          const configuredManifestUrl = String(globalThis.PLAY_MHR_MANIFEST_URL || '').trim();
          if (configuredManifestUrl) {{
            if (usesConfiguredLod(numericLod)) {{
              return resolveAbsoluteUrl(configuredManifestUrl);
            }}
            return deriveLodPath(configuredManifestUrl, numericLod, {{ expectManifest: true }});
          }}
          const configuredAssetBaseUrl = String(globalThis.PLAY_MHR_ASSET_BASE_URL || '').trim();
          if (configuredAssetBaseUrl) {{
            const assetBaseUrl = usesConfiguredLod(numericLod)
              ? ensureTrailingSlash(resolveAbsoluteUrl(configuredAssetBaseUrl))
              : deriveLodPath(configuredAssetBaseUrl, numericLod);
            return new URL('manifest.json', assetBaseUrl).href;
          }}
          if (fallbackManifestTemplate) {{
            return replaceLodTemplate(fallbackManifestTemplate, numericLod);
          }}
          if (fallbackAssetBaseTemplate) {{
            return new URL('manifest.json', ensureTrailingSlash(replaceLodTemplate(fallbackAssetBaseTemplate, numericLod))).href;
          }}
          return '';
        }}

        function resolveAssetBaseUrl(numericLod) {{
          const configuredAssetBaseUrl = String(globalThis.PLAY_MHR_ASSET_BASE_URL || '').trim();
          if (configuredAssetBaseUrl) {{
            if (usesConfiguredLod(numericLod)) {{
              return ensureTrailingSlash(resolveAbsoluteUrl(configuredAssetBaseUrl));
            }}
            return deriveLodPath(configuredAssetBaseUrl, numericLod);
          }}
          const configuredManifestUrl = String(globalThis.PLAY_MHR_MANIFEST_URL || '').trim();
          if (configuredManifestUrl) {{
            if (usesConfiguredLod(numericLod)) {{
              return ensureTrailingSlash(new URL('./', resolveAbsoluteUrl(configuredManifestUrl)).href);
            }}
            return deriveLodPath(configuredManifestUrl, numericLod);
          }}
          if (fallbackAssetBaseTemplate) {{
            return ensureTrailingSlash(replaceLodTemplate(fallbackAssetBaseTemplate, numericLod));
          }}
          if (fallbackManifestTemplate) {{
            return deriveLodPath(replaceLodTemplate(fallbackManifestTemplate, numericLod), numericLod);
          }}
          return '';
        }}

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
        globalThis.PLAY_MHR_MANIFEST_URL = resolveManifestUrl(lod);
        globalThis.PLAY_MHR_ASSET_BASE_URL = resolveAssetBaseUrl(lod);
        if (!globalThis.PLAY_MHR_MANIFEST_URL) {{
          throw new Error('MHR Play viewer requires PLAY_MHR_MANIFEST_URL or PLAY_MHR_ASSET_BASE_URL via site_config.js.');
        }}
        if (!globalThis.PLAY_MHR_ASSET_BASE_URL) {{
          throw new Error('MHR Play viewer requires PLAY_MHR_ASSET_BASE_URL or PLAY_MHR_MANIFEST_URL via site_config.js.');
        }}
{storage_namespace_line}{built_in_default_open_line}        globalThis.PLAY_UI_PANEL_DEFAULTS = {{ left: true, right: true }};
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
      }})();"""


def build_viewer_html(
    default_lod: int | None,
    supported_lods: list[int],
    *,
    fallback_manifest_template: str | None = "./mhr-official/lod{lod}/manifest.json",
    fallback_asset_base_template: str | None = "./mhr-official/lod{lod}/",
    storage_namespace: str | None = "mhr-pages",
    built_in_default_open: bool | None = False,
) -> str:
    bootstrap_script = build_viewer_bootstrap_script(
        default_lod,
        supported_lods,
        fallback_manifest_template=fallback_manifest_template,
        fallback_asset_base_template=fallback_asset_base_template,
        storage_namespace=storage_namespace,
        built_in_default_open=built_in_default_open,
    )
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
{bootstrap_script}
    </script>
    <script data-play-entry-variant="single" src="./app/entry_bootstrap.js"></script>
  </head>
  <body>
    <script data-play-shell-module="./app/main.mjs" src="./app/viewer_shell.js"></script>
  </body>
</html>
"""


def build_landing_html(default_lod: int | None, supported_lods: list[int], viewer_path: str) -> str:
    default_query = "" if default_lod is None else f"?lod={default_lod}"
    default_link = f"./{viewer_path}/{default_query}"
    lod_redirect_block = (
        ""
        if default_lod is None
        else f"        if (!params.has('lod')) params.set('lod', '{default_lod}');\n"
    )
    return f"""<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>MHR Play</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="0; url={default_link}" />
    <link rel="icon" href="./{viewer_path}/favicon.ico" />
    <script>
      (() => {{
        const target = new URL('./{viewer_path}/', window.location.href);
        const params = new URLSearchParams(window.location.search);
{lod_redirect_block}        
        for (const [key, value] of params.entries()) {{
          target.searchParams.set(key, value);
        }}
        window.location.replace(target.href);
      }})();
    </script>
    <style>
      body {{
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
        background: #f6f8fb;
        color: #182033;
      }}
      main {{
        width: min(640px, calc(100vw - 32px));
        padding: 24px;
        border-radius: 20px;
        background: rgba(255, 255, 255, 0.92);
        border: 1px solid rgba(24, 32, 51, 0.12);
        box-shadow: 0 20px 60px rgba(15, 28, 58, 0.10);
      }}
      h1 {{
        margin: 0 0 10px;
        font-size: 28px;
      }}
      p {{
        margin: 0 0 12px;
        line-height: 1.7;
        color: #52607a;
      }}
      a {{
        color: #0d4fd8;
      }}
      code {{
        padding: 2px 6px;
        border-radius: 8px;
        background: rgba(24, 32, 51, 0.08);
      }}
    </style>
  </head>
  <body>
    <main>
      <h1>MHR Play</h1>
      <p>Redirecting to the viewer for Meta's <a href="https://arxiv.org/abs/2511.15586">Momentum Human Rig (MHR)</a>.</p>
      <p>If the redirect does not happen, open <a href="{default_link}">the viewer</a>.</p>
    </main>
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
