#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import subprocess
from pathlib import Path

from local_config import repo_root_from_here


def default_build_dir() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA", "").strip()
    if local_app_data:
        return Path(local_app_data) / "mhr-play-native-build"
    return Path.home() / ".mhr-play-native-build"


def default_generator() -> str | None:
    if os.name == "nt":
        return "Visual Studio 17 2022"
    return None


def locate_native_library(build_dir: Path, config: str) -> Path:
    if os.name == "nt":
        candidate = build_dir / config / "mhr_native.dll"
    elif os.name == "posix":
        candidate = build_dir / f"libmhr_native.so"
    else:
        raise RuntimeError(f"Unsupported platform for native runtime: {os.name}")
    if not candidate.exists():
        raise FileNotFoundError(f"Native runtime library not found: {candidate}")
    return candidate


def configure_and_build(*, repo_root: Path, build_dir: Path, config: str, generator: str | None) -> Path:
    source_dir = repo_root / "native"
    if not source_dir.exists():
        raise FileNotFoundError(f"Native source directory not found: {source_dir}")

    configure_command = ["cmake", "-S", str(source_dir), "-B", str(build_dir)]
    if generator:
        configure_command.extend(["-G", generator])
        if os.name == "nt":
            configure_command.extend(["-A", "x64"])

    subprocess.run(configure_command, cwd=repo_root, check=True)
    subprocess.run(
        ["cmake", "--build", str(build_dir), "--config", config],
        cwd=repo_root,
        check=True,
    )
    return locate_native_library(build_dir, config)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--build-dir", help="out-of-tree CMake build directory")
    parser.add_argument("--config", default="Release", help="CMake build config")
    parser.add_argument("--generator", help="override CMake generator")
    parser.add_argument("--print-lib", action="store_true", help="print the built library path")
    args = parser.parse_args()

    repo_root = repo_root_from_here(__file__)
    build_dir = Path(args.build_dir).resolve() if args.build_dir else default_build_dir()
    build_dir.mkdir(parents=True, exist_ok=True)
    generator = args.generator or default_generator()
    library_path = configure_and_build(
        repo_root=repo_root,
        build_dir=build_dir,
        config=args.config,
        generator=generator,
    )
    if args.print_lib:
        print(library_path)
    else:
        print(f"Built {library_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
