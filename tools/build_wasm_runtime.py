#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import subprocess
from pathlib import Path

from local_config import repo_root_from_here


EXPORTED_FUNCTIONS = [
    "_mhr_native_version",
    "_mhr_model_load_ir",
    "_mhr_model_destroy",
    "_mhr_model_last_error",
    "_mhr_model_get_counts",
    "_mhr_data_create",
    "_mhr_data_destroy",
    "_mhr_data_last_error",
    "_mhr_data_reset",
    "_mhr_data_set_model_parameters",
    "_mhr_data_set_identity",
    "_mhr_data_set_expression",
    "_mhr_forward",
    "_mhr_get_debug_timing",
    "_mhr_get_stage_debug",
    "_mhr_get_vertices",
    "_mhr_get_skeleton",
    "_mhr_get_derived",
    "_malloc",
    "_free",
]


def resolve_emcc() -> Path:
    explicit = os.environ.get("EMCC", "").strip()
    if explicit:
        path = Path(explicit)
        if path.exists():
            return path
    emsdk_home = os.environ.get("EMSDK_HOME", "").strip()
    if emsdk_home:
      candidate = Path(emsdk_home) / "upstream" / "emscripten" / "emcc.bat"
      if candidate.exists():
          return candidate
    for candidate in [
        Path(r"C:\emsdk\upstream\emscripten\emcc.bat"),
        Path(r"C:\emsdk\bazel\emscripten_toolchain\emcc.bat"),
    ]:
        if candidate.exists():
            return candidate
    raise FileNotFoundError("Unable to locate emcc.bat. Set EMCC or EMSDK_HOME.")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--out",
        help="output ES module path",
    )
    args = parser.parse_args()

    repo_root = repo_root_from_here(__file__)
    out_path = Path(args.out).resolve() if args.out else (repo_root / "worker" / "mhr_runtime_wasm.gen.mjs")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    emcc = resolve_emcc()
    native_dir = repo_root / "native"
    command = [
        str(emcc),
        str(native_dir / "src" / "mhr_model_data_api.cpp"),
        str(native_dir / "src" / "mhr_native_api.cpp"),
        str(native_dir / "src" / "mhr_runtime.cpp"),
        "-I",
        str(native_dir / "include"),
        "-I",
        str(native_dir / "src"),
        "-std=c++17",
        "-O3",
        "-sALLOW_MEMORY_GROWTH=1",
        "-sFILESYSTEM=0",
        "-sMODULARIZE=1",
        "-sEXPORT_ES6=1",
        "-sENVIRONMENT=worker,web",
        "-sEXPORT_NAME=createMhrRuntimeModule",
        "-sSINGLE_FILE=1",
        "-sEXPORTED_RUNTIME_METHODS=['cwrap','UTF8ToString','HEAPU8']",
        f"-sEXPORTED_FUNCTIONS=[{','.join(repr(name) for name in EXPORTED_FUNCTIONS)}]",
        "-o",
        str(out_path),
    ]
    subprocess.run(command, cwd=repo_root, check=True)
    print(f"Wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
