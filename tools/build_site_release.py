#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path

from build_github_pages import load_manifest, normalize_supported_lods
from build_site_app import build_site_app, pack_zip


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build the local release-oriented MHR Play site artifact with placeholder external asset URLs.",
    )
    parser.add_argument("--play-src", type=Path, default=Path("..") / "mujoco-wasm-play", help="Path to a mujoco-wasm-play checkout.")
    parser.add_argument("--manifest", type=Path, default=Path("release/site_manifest.json"), help="Site manifest with Play/runtime defaults.")
    parser.add_argument("--out", type=Path, default=Path("release_assets/site"), help="Output directory for the assembled site artifact.")
    parser.add_argument("--zip-out", type=Path, default=Path("release_assets/site.zip"), help="Zip output path for the assembled site artifact.")
    parser.add_argument("--mhr-lod", type=int, default=None, help="Default MHR LoD written into site_config.js.")
    parser.add_argument(
        "--mhr-manifest-url",
        default="https://assets.example.com/mhr-official/lod1/manifest.json",
        help="External manifest URL placeholder for the default MHR LoD.",
    )
    parser.add_argument(
        "--mhr-asset-base-url",
        default="https://assets.example.com/mhr-official/lod1/",
        help="External asset-base URL placeholder for the default MHR LoD.",
    )
    parser.add_argument(
        "--env-asset-base",
        default="https://assets.example.com/env/",
        help="External environment asset base URL placeholder.",
    )
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
    mhr_lod = int(args.mhr_lod) if args.mhr_lod is not None else default_lod

    if not play_ver:
      raise ValueError("release/site_manifest.json must set play.ver")
    if not forge_base_template:
      raise ValueError("release/site_manifest.json must set forge.baseTemplate")
    if not viewer_path:
      raise ValueError("release/site_manifest.json must set a non-empty pages.viewerPath")
    if mhr_lod not in supported_lods:
      raise ValueError(f"--mhr-lod must be one of {supported_lods}, got {mhr_lod}")

    play_src = args.play_src.expanduser().resolve()
    out_root = args.out.expanduser().resolve()
    zip_out = args.zip_out.expanduser().resolve()
    if not play_src.exists():
      raise FileNotFoundError(f"Play source checkout not found: {play_src}")

    build_site_app(
        play_src=play_src,
        out_root=out_root,
        viewer_path=viewer_path,
        default_lod=default_lod,
        supported_lods=supported_lods,
        play_ver=play_ver,
        forge_base_template=forge_base_template,
        mhr_lod=mhr_lod,
        mhr_manifest_url=args.mhr_manifest_url.strip(),
        mhr_asset_base_url=args.mhr_asset_base_url.strip(),
        env_asset_base=args.env_asset_base.strip(),
    )
    pack_zip(out_root, zip_out)
    print(f"Built release-oriented MHR Play app -> {out_root}")
    print(f"Packed release-oriented MHR Play app -> {zip_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
