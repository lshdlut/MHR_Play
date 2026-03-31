#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ctypes
import json
import math
import os
import tempfile
from pathlib import Path

import numpy as np

from local_config import repo_root_from_here, resolve_exact_runtime_python_executable
from mhr_reference import build_raw_inputs, load_case_manifest
from mhr_runtime_compare_bench import (
    MhrBundleView,
    MhrModelCounts,
    MhrRuntimeCounts,
    bind_api,
    build_bundle_view,
    check_ok,
    configure_library,
)
from mhr_runtime_ir_compile import compile_runtime_ir


def compare_arrays(reference: np.ndarray, candidate: np.ndarray) -> dict[str, float]:
    diff = reference.astype(np.float64) - candidate.astype(np.float64)
    max_abs = float(np.max(np.abs(diff))) if diff.size else 0.0
    rms = float(math.sqrt(float(np.mean(diff * diff)))) if diff.size else 0.0
    return {
        "maxAbs": max_abs,
        "rms": rms,
    }


def load_runtime_counts(
    lib: ctypes.CDLL,
    legacy_runtime: ctypes.c_void_p,
    portable_model: ctypes.c_void_p,
) -> tuple[MhrRuntimeCounts, MhrModelCounts]:
    legacy_counts = MhrRuntimeCounts()
    check_ok(
        lib.mhr_runtime_get_counts(legacy_runtime, ctypes.byref(legacy_counts)),
        "mhr_runtime_get_counts",
        lib.mhr_runtime_last_error(legacy_runtime),
    )
    portable_counts = MhrModelCounts()
    check_ok(
        lib.mhr_model_get_counts(portable_model, ctypes.byref(portable_counts)),
        "mhr_model_get_counts",
        lib.mhr_model_last_error(portable_model),
    )
    return legacy_counts, portable_counts


def evaluate_legacy(
    lib: ctypes.CDLL,
    runtime: ctypes.c_void_p,
    counts: MhrRuntimeCounts,
    raw_inputs: dict[str, np.ndarray],
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    model_parameters = np.ascontiguousarray(raw_inputs["model_parameters"].reshape(-1), dtype=np.float32)
    identity = np.ascontiguousarray(raw_inputs["identity"].reshape(-1), dtype=np.float32)
    expression = np.ascontiguousarray(raw_inputs["expression"].reshape(-1), dtype=np.float32)
    check_ok(lib.mhr_runtime_reset_state(runtime), "mhr_runtime_reset_state", lib.mhr_runtime_last_error(runtime))
    check_ok(
        lib.mhr_runtime_set_model_parameters(
            runtime,
            model_parameters.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            model_parameters.size,
        ),
        "mhr_runtime_set_model_parameters",
        lib.mhr_runtime_last_error(runtime),
    )
    check_ok(
        lib.mhr_runtime_set_identity(
            runtime,
            identity.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            identity.size,
        ),
        "mhr_runtime_set_identity",
        lib.mhr_runtime_last_error(runtime),
    )
    check_ok(
        lib.mhr_runtime_set_expression(
            runtime,
            expression.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            expression.size,
        ),
        "mhr_runtime_set_expression",
        lib.mhr_runtime_last_error(runtime),
    )
    check_ok(lib.mhr_runtime_evaluate(runtime), "mhr_runtime_evaluate", lib.mhr_runtime_last_error(runtime))

    vertices = np.zeros((counts.vertex_count * 3,), dtype=np.float32)
    skeleton = np.zeros((counts.joint_count * 8,), dtype=np.float32)
    derived = np.zeros((7,), dtype=np.float32)
    check_ok(
        lib.mhr_runtime_get_vertices(
            runtime,
            vertices.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            vertices.size,
        ),
        "mhr_runtime_get_vertices",
        lib.mhr_runtime_last_error(runtime),
    )
    check_ok(
        lib.mhr_runtime_get_skeleton(
            runtime,
            skeleton.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            skeleton.size,
        ),
        "mhr_runtime_get_skeleton",
        lib.mhr_runtime_last_error(runtime),
    )
    check_ok(
        lib.mhr_runtime_get_derived(
            runtime,
            derived.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            derived.size,
        ),
        "mhr_runtime_get_derived",
        lib.mhr_runtime_last_error(runtime),
    )
    return vertices, skeleton, derived


def evaluate_portable(
    lib: ctypes.CDLL,
    model: ctypes.c_void_p,
    data: ctypes.c_void_p,
    counts: MhrModelCounts,
    raw_inputs: dict[str, np.ndarray],
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    model_parameters = np.ascontiguousarray(raw_inputs["model_parameters"].reshape(-1), dtype=np.float32)
    identity = np.ascontiguousarray(raw_inputs["identity"].reshape(-1), dtype=np.float32)
    expression = np.ascontiguousarray(raw_inputs["expression"].reshape(-1), dtype=np.float32)
    check_ok(lib.mhr_data_reset(model, data), "mhr_data_reset", lib.mhr_data_last_error(data))
    check_ok(
        lib.mhr_data_set_model_parameters(
            model,
            data,
            model_parameters.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            model_parameters.size,
        ),
        "mhr_data_set_model_parameters",
        lib.mhr_data_last_error(data),
    )
    check_ok(
        lib.mhr_data_set_identity(
            model,
            data,
            identity.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            identity.size,
        ),
        "mhr_data_set_identity",
        lib.mhr_data_last_error(data),
    )
    check_ok(
        lib.mhr_data_set_expression(
            model,
            data,
            expression.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            expression.size,
        ),
        "mhr_data_set_expression",
        lib.mhr_data_last_error(data),
    )
    check_ok(lib.mhr_forward(model, data, 0), "mhr_forward", lib.mhr_data_last_error(data))

    vertices = np.zeros((counts.vertex_count * 3,), dtype=np.float32)
    skeleton = np.zeros((counts.joint_count * 8,), dtype=np.float32)
    derived = np.zeros((7,), dtype=np.float32)
    check_ok(
        lib.mhr_get_vertices(
            model,
            data,
            vertices.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            vertices.size,
        ),
        "mhr_get_vertices",
        lib.mhr_data_last_error(data),
    )
    check_ok(
        lib.mhr_get_skeleton(
            model,
            data,
            skeleton.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            skeleton.size,
        ),
        "mhr_get_skeleton",
        lib.mhr_data_last_error(data),
    )
    check_ok(
        lib.mhr_get_derived(
            model,
            data,
            derived.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            derived.size,
        ),
        "mhr_get_derived",
        lib.mhr_data_last_error(data),
    )
    return vertices, skeleton, derived


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, help="processed bundle manifest path")
    parser.add_argument("--cases", default="tests/golden_cases/manifest.json")
    parser.add_argument("--build-dir", help="native build dir")
    parser.add_argument("--config", default="Release")
    parser.add_argument("--zero-epsilon", type=float, default=0.0)
    args = parser.parse_args()

    repo_root = repo_root_from_here(__file__)
    os.environ["PYTHON_EXE"] = resolve_exact_runtime_python_executable(repo_root)
    processed_manifest = Path(args.manifest).resolve()
    cases_manifest = Path(args.cases).resolve()
    build_dir = Path(args.build_dir).resolve() if args.build_dir else (Path(tempfile.gettempdir()) / "mhr-runtime-parity-build")

    processed_payload = json.loads(processed_manifest.read_text(encoding="utf-8"))
    parameter_metadata = processed_payload["parameterMetadata"]

    with tempfile.TemporaryDirectory(prefix="mhr-runtime-ir-portable-parity-") as temp_dir:
        runtime_ir_dir = Path(temp_dir) / "runtime_ir"
        compile_runtime_ir(
            manifest_path=processed_manifest,
            out_dir=runtime_ir_dir,
            zero_epsilon=args.zero_epsilon,
            verify_roundtrip=True,
        )

        library_path = configure_library(repo_root, build_dir, args.config)
        lib = ctypes.CDLL(str(library_path))
        bind_api(lib)

        processed_view, _processed_keepalive = build_bundle_view(processed_manifest.parent)
        runtime_ir_view, _runtime_ir_keepalive = build_bundle_view(runtime_ir_dir)

        legacy_runtime = ctypes.c_void_p(lib.mhr_runtime_create())
        if not legacy_runtime.value:
            raise RuntimeError("mhr_runtime_create returned null.")
        portable_model = ctypes.c_void_p(lib.mhr_model_load_ir(ctypes.byref(runtime_ir_view)))
        if not portable_model.value:
            raise RuntimeError("mhr_model_load_ir returned null.")
        portable_data = ctypes.c_void_p()
        try:
            check_ok(
                lib.mhr_runtime_load_bundle(legacy_runtime, ctypes.byref(processed_view)),
                "mhr_runtime_load_bundle",
                lib.mhr_runtime_last_error(legacy_runtime),
            )
            portable_data = ctypes.c_void_p(lib.mhr_data_create(portable_model))
            if not portable_data.value:
                raise RuntimeError("mhr_data_create returned null.")

            legacy_counts, portable_counts = load_runtime_counts(lib, legacy_runtime, portable_model)
            case_manifest = load_case_manifest(cases_manifest)
            cases = case_manifest.get("cases")
            if not isinstance(cases, list) or not cases:
                raise ValueError("Golden case manifest requires a non-empty cases list.")

            report_cases: list[dict[str, object]] = []
            for entry in cases:
                case_id = str(entry["id"])
                case_payload = json.loads((cases_manifest.parent / str(entry["path"])).read_text(encoding="utf-8"))
                raw_inputs = build_raw_inputs(parameter_metadata, case_payload.get("state", {}))
                legacy_vertices, legacy_skeleton, legacy_derived = evaluate_legacy(
                    lib,
                    legacy_runtime,
                    legacy_counts,
                    raw_inputs,
                )
                portable_vertices, portable_skeleton, portable_derived = evaluate_portable(
                    lib,
                    portable_model,
                    portable_data,
                    portable_counts,
                    raw_inputs,
                )
                report_cases.append(
                    {
                        "id": case_id,
                        "vertices": compare_arrays(legacy_vertices, portable_vertices),
                        "skeleton": compare_arrays(legacy_skeleton, portable_skeleton),
                        "derived": compare_arrays(legacy_derived, portable_derived),
                    }
                )

            print(
                json.dumps(
                    {
                        "libraryPath": str(library_path),
                        "manifest": str(processed_manifest),
                        "bundleId": processed_payload.get("bundleId"),
                        "cases": report_cases,
                    },
                    indent=2,
                    sort_keys=True,
                )
            )
        finally:
            if portable_data.value:
                lib.mhr_data_destroy(portable_data)
            lib.mhr_model_destroy(portable_model)
            lib.mhr_runtime_destroy(legacy_runtime)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
