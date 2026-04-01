#!/usr/bin/env python3
from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from local_config import repo_root_from_here


def copy_tree_contents(src: Path, dst: Path) -> None:
    dst.mkdir(parents=True, exist_ok=True)
    for child in src.rglob("*"):
        relative = child.relative_to(src)
        target = dst / relative
        if child.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(child, target)


def clear_directory(path: Path) -> None:
    if not path.exists():
        return
    for child in path.iterdir():
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="dist/site", help="output directory")
    args = parser.parse_args()

    repo_root = repo_root_from_here(__file__)
    out_dir = (repo_root / args.out).resolve()
    clear_directory(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    wasm_module = repo_root / "worker" / "mhr_runtime_wasm.gen.mjs"
    if not wasm_module.exists():
        raise SystemExit("Missing worker/mhr_runtime_wasm.gen.mjs. Run build:wasm first.")

    required_dirs = [
        "app",
        "backend",
        "core",
        "renderer",
        "ui",
        "worker",
        "demo_assets",
    ]
    required_files = [
        "index.html",
        "embed.html",
    ]

    for relative in required_dirs:
        copy_tree_contents(repo_root / relative, out_dir / relative)
    for relative in required_files:
        shutil.copy2(repo_root / relative, out_dir / relative)

    print(f"Exported site artifact to {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
