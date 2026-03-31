#!/usr/bin/env python3
from __future__ import annotations

import shutil
from pathlib import Path

from local_config import repo_root_from_here
from mhr_asset_preprocess import preprocess_fixture, write_manifest_file
from mhr_runtime_ir_compile import compile_runtime_ir


def build_bundle(source_path: Path, out_dir: Path) -> None:
    if out_dir.exists():
        for child in out_dir.iterdir():
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = preprocess_fixture(source_path, out_dir)
    write_manifest_file(manifest, out_dir)


def main() -> int:
    repo_root = repo_root_from_here(__file__)
    source_path = repo_root / "tests" / "fixtures" / "minimal_asset_source" / "source_bundle.json"
    processed_fixture_dir = repo_root / "tests" / "fixtures" / "processed_bundle"
    demo_asset_dir = repo_root / "demo_assets"

    build_bundle(source_path, processed_fixture_dir)
    compile_runtime_ir(
        manifest_path=processed_fixture_dir / "manifest.json",
        out_dir=demo_asset_dir,
        zero_epsilon=0.0,
        verify_roundtrip=True,
    )

    print(f"Built fixture bundle at {processed_fixture_dir}")
    print(f"Built demo runtime IR at {demo_asset_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
