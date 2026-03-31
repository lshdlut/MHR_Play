#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ctypes
import json
import math
import os
import re
import statistics
import tempfile
import time
from pathlib import Path

from build_native import configure_and_build, default_build_dir, default_generator
from local_config import repo_root_from_here, resolve_exact_runtime_python_executable
from mhr_runtime_ir_compile import compile_runtime_ir


SCALAR_TYPES = {
    "float32": 1,
    "uint32": 2,
    "int32": 3,
    "int64": 4,
    "uint8": 5,
}


class MhrArrayView(ctypes.Structure):
    _fields_ = [
        ("key", ctypes.c_char_p),
        ("data", ctypes.c_void_p),
        ("byte_length", ctypes.c_size_t),
        ("scalar_type", ctypes.c_uint32),
        ("rank", ctypes.c_uint32),
        ("shape", ctypes.POINTER(ctypes.c_uint64)),
    ]


class MhrBundleView(ctypes.Structure):
    _fields_ = [
        ("version", ctypes.c_uint32),
        ("array_count", ctypes.c_uint32),
        ("arrays", ctypes.POINTER(MhrArrayView)),
    ]


class MhrRuntimeCounts(ctypes.Structure):
    _fields_ = [
        ("model_parameter_count", ctypes.c_uint32),
        ("identity_count", ctypes.c_uint32),
        ("expression_count", ctypes.c_uint32),
        ("vertex_count", ctypes.c_uint32),
        ("joint_count", ctypes.c_uint32),
    ]


class MhrModelCounts(ctypes.Structure):
    _fields_ = [
        ("vertex_count", ctypes.c_uint32),
        ("face_count", ctypes.c_uint32),
        ("joint_count", ctypes.c_uint32),
        ("max_influence_count", ctypes.c_uint32),
        ("model_parameter_count", ctypes.c_uint32),
        ("identity_count", ctypes.c_uint32),
        ("expression_count", ctypes.c_uint32),
        ("parameter_input_count", ctypes.c_uint32),
        ("pose_feature_count", ctypes.c_uint32),
        ("hidden_count", ctypes.c_uint32),
    ]


class MhrRuntimeDebugTiming(ctypes.Structure):
    _fields_ = [
        ("reset_state_ms", ctypes.c_float),
        ("parameter_upload_ms", ctypes.c_float),
        ("evaluate_core_ms", ctypes.c_float),
        ("vertices_export_ms", ctypes.c_float),
        ("skeleton_export_ms", ctypes.c_float),
        ("derived_export_ms", ctypes.c_float),
    ]


class MhrDataWorkspaceCounts(ctypes.Structure):
    _fields_ = [
        ("model_parameter_count", ctypes.c_uint32),
        ("identity_count", ctypes.c_uint32),
        ("expression_count", ctypes.c_uint32),
        ("joint_parameter_count", ctypes.c_uint32),
        ("local_transform_count", ctypes.c_uint32),
        ("global_transform_count", ctypes.c_uint32),
        ("skin_transform_count", ctypes.c_uint32),
        ("pose_feature_count", ctypes.c_uint32),
        ("hidden_count", ctypes.c_uint32),
        ("corrective_delta_count", ctypes.c_uint32),
        ("rest_vertex_count", ctypes.c_uint32),
        ("output_vertex_count", ctypes.c_uint32),
        ("skeleton_count", ctypes.c_uint32),
        ("derived_count", ctypes.c_uint32),
    ]


def infer_lod_tag(bundle_id: str) -> str:
    match = re.search(r"(lod\d+)", bundle_id, flags=re.IGNORECASE)
    return match.group(1).lower() if match else "unknown"


def percentile(sorted_values: list[float], fraction: float) -> float:
    if not sorted_values:
        return 0.0
    if len(sorted_values) == 1:
        return float(sorted_values[0])
    position = (len(sorted_values) - 1) * fraction
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return float(sorted_values[lower])
    weight = position - lower
    return float(sorted_values[lower] * (1.0 - weight) + sorted_values[upper] * weight)


def summarize(values: list[float]) -> dict[str, float]:
    ordered = sorted(values)
    return {
        "median": float(statistics.median(ordered)) if ordered else 0.0,
        "p95": percentile(ordered, 0.95),
        "max": float(max(ordered)) if ordered else 0.0,
    }


def configure_library(repo_root: Path, build_dir: Path, config: str) -> Path:
    build_dir.mkdir(parents=True, exist_ok=True)
    return configure_and_build(
        repo_root=repo_root,
        build_dir=build_dir,
        config=config,
        generator=default_generator(),
    )


def bind_api(lib: ctypes.CDLL) -> None:
    lib.mhr_runtime_create.restype = ctypes.c_void_p
    lib.mhr_runtime_destroy.argtypes = [ctypes.c_void_p]
    lib.mhr_runtime_last_error.argtypes = [ctypes.c_void_p]
    lib.mhr_runtime_last_error.restype = ctypes.c_char_p
    lib.mhr_runtime_load_bundle.argtypes = [ctypes.c_void_p, ctypes.POINTER(MhrBundleView)]
    lib.mhr_runtime_load_bundle.restype = ctypes.c_int
    lib.mhr_runtime_reset_state.argtypes = [ctypes.c_void_p]
    lib.mhr_runtime_reset_state.restype = ctypes.c_int
    lib.mhr_runtime_set_model_parameters.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_uint32]
    lib.mhr_runtime_set_model_parameters.restype = ctypes.c_int
    lib.mhr_runtime_set_identity.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_uint32]
    lib.mhr_runtime_set_identity.restype = ctypes.c_int
    lib.mhr_runtime_set_expression.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_uint32]
    lib.mhr_runtime_set_expression.restype = ctypes.c_int
    lib.mhr_runtime_evaluate.argtypes = [ctypes.c_void_p]
    lib.mhr_runtime_evaluate.restype = ctypes.c_int
    lib.mhr_runtime_get_counts.argtypes = [ctypes.c_void_p, ctypes.POINTER(MhrRuntimeCounts)]
    lib.mhr_runtime_get_counts.restype = ctypes.c_int
    lib.mhr_runtime_get_debug_timing.argtypes = [ctypes.c_void_p, ctypes.POINTER(MhrRuntimeDebugTiming)]
    lib.mhr_runtime_get_debug_timing.restype = ctypes.c_int
    lib.mhr_runtime_get_vertices.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_uint32]
    lib.mhr_runtime_get_vertices.restype = ctypes.c_int
    lib.mhr_runtime_get_joint_parameters.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_uint32]
    lib.mhr_runtime_get_joint_parameters.restype = ctypes.c_int
    lib.mhr_runtime_get_local_skeleton.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_uint32]
    lib.mhr_runtime_get_local_skeleton.restype = ctypes.c_int
    lib.mhr_runtime_get_rest_vertices.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_uint32]
    lib.mhr_runtime_get_rest_vertices.restype = ctypes.c_int
    lib.mhr_runtime_get_pose_features.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_uint32]
    lib.mhr_runtime_get_pose_features.restype = ctypes.c_int
    lib.mhr_runtime_get_hidden.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_uint32]
    lib.mhr_runtime_get_hidden.restype = ctypes.c_int
    lib.mhr_runtime_get_corrective_delta.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_uint32]
    lib.mhr_runtime_get_corrective_delta.restype = ctypes.c_int
    lib.mhr_runtime_get_skin_joint_states.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_uint32]
    lib.mhr_runtime_get_skin_joint_states.restype = ctypes.c_int
    lib.mhr_runtime_get_skeleton.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_uint32]
    lib.mhr_runtime_get_skeleton.restype = ctypes.c_int
    lib.mhr_runtime_get_derived.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_uint32]
    lib.mhr_runtime_get_derived.restype = ctypes.c_int

    lib.mhr_model_load_ir.argtypes = [ctypes.POINTER(MhrBundleView)]
    lib.mhr_model_load_ir.restype = ctypes.c_void_p
    lib.mhr_model_destroy.argtypes = [ctypes.c_void_p]
    lib.mhr_model_destroy.restype = None
    lib.mhr_model_last_error.argtypes = [ctypes.c_void_p]
    lib.mhr_model_last_error.restype = ctypes.c_char_p
    lib.mhr_model_get_counts.argtypes = [ctypes.c_void_p, ctypes.POINTER(MhrModelCounts)]
    lib.mhr_model_get_counts.restype = ctypes.c_int

    lib.mhr_data_create.argtypes = [ctypes.c_void_p]
    lib.mhr_data_create.restype = ctypes.c_void_p
    lib.mhr_data_destroy.argtypes = [ctypes.c_void_p]
    lib.mhr_data_destroy.restype = None
    lib.mhr_data_last_error.argtypes = [ctypes.c_void_p]
    lib.mhr_data_last_error.restype = ctypes.c_char_p
    lib.mhr_data_reset.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    lib.mhr_data_reset.restype = ctypes.c_int
    lib.mhr_data_get_workspace_counts.argtypes = [ctypes.c_void_p, ctypes.POINTER(MhrDataWorkspaceCounts)]
    lib.mhr_data_get_workspace_counts.restype = ctypes.c_int
    lib.mhr_data_set_model_parameters.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_uint32]
    lib.mhr_data_set_model_parameters.restype = ctypes.c_int
    lib.mhr_data_set_identity.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_uint32]
    lib.mhr_data_set_identity.restype = ctypes.c_int
    lib.mhr_data_set_expression.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_uint32]
    lib.mhr_data_set_expression.restype = ctypes.c_int
    lib.mhr_forward.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32]
    lib.mhr_forward.restype = ctypes.c_int
    lib.mhr_get_debug_timing.argtypes = [ctypes.c_void_p, ctypes.POINTER(MhrRuntimeDebugTiming)]
    lib.mhr_get_debug_timing.restype = ctypes.c_int
    lib.mhr_get_stage_debug.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.POINTER(ctypes.c_float),
        ctypes.c_uint32,
    ]
    lib.mhr_get_stage_debug.restype = ctypes.c_int
    lib.mhr_get_vertices.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_uint32]
    lib.mhr_get_vertices.restype = ctypes.c_int
    lib.mhr_get_skeleton.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_uint32]
    lib.mhr_get_skeleton.restype = ctypes.c_int
    lib.mhr_get_derived.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_uint32]
    lib.mhr_get_derived.restype = ctypes.c_int


def check_ok(result: int, label: str, error: bytes | None) -> None:
    if result == 1:
        return
    message = error.decode("utf-8") if error else "unknown error"
    raise RuntimeError(f"{label} failed: {message}")


def build_bundle_view(manifest_dir: Path) -> tuple[MhrBundleView, list[object]]:
    manifest = json.loads((manifest_dir / "manifest.json").read_text(encoding="utf-8"))
    chunk_views: list[MhrArrayView] = []
    keepalive: list[object] = []

    for chunk in manifest["chunks"]:
        raw = (manifest_dir / chunk["file"]).read_bytes()
        raw_buffer = ctypes.create_string_buffer(raw, len(raw))
        keepalive.append(raw_buffer)

        shape_values = [int(dim) for dim in chunk["shape"]]
        shape_array = (ctypes.c_uint64 * len(shape_values))(*shape_values)
        keepalive.append(shape_array)

        chunk_view = MhrArrayView(
            key=str(chunk["key"]).encode("utf-8"),
            data=ctypes.cast(raw_buffer, ctypes.c_void_p),
            byte_length=len(raw),
            scalar_type=SCALAR_TYPES[str(chunk["dtype"])],
            rank=len(shape_values),
            shape=ctypes.cast(shape_array, ctypes.POINTER(ctypes.c_uint64)),
        )
        chunk_views.append(chunk_view)

    array_storage = (MhrArrayView * len(chunk_views))(*chunk_views)
    keepalive.append(array_storage)
    bundle_view = MhrBundleView(
        version=1,
        array_count=len(chunk_views),
        arrays=ctypes.cast(array_storage, ctypes.POINTER(MhrArrayView)),
    )
    return bundle_view, keepalive


def run_legacy_bench(lib: ctypes.CDLL, manifest_dir: Path, warmup: int, iterations: int) -> dict[str, object]:
    bundle_view, _keepalive = build_bundle_view(manifest_dir)
    runtime = ctypes.c_void_p(lib.mhr_runtime_create())
    if not runtime.value:
        raise RuntimeError("mhr_runtime_create returned null.")
    try:
        check_ok(
            lib.mhr_runtime_load_bundle(runtime, ctypes.byref(bundle_view)),
            "mhr_runtime_load_bundle",
            lib.mhr_runtime_last_error(runtime),
        )
        counts = MhrRuntimeCounts()
        check_ok(
            lib.mhr_runtime_get_counts(runtime, ctypes.byref(counts)),
            "mhr_runtime_get_counts",
            lib.mhr_runtime_last_error(runtime),
        )
        model_params = (ctypes.c_float * counts.model_parameter_count)(*([0.0] * counts.model_parameter_count))
        identity = (ctypes.c_float * counts.identity_count)(*([0.0] * counts.identity_count))
        expression = (ctypes.c_float * counts.expression_count)(*([0.0] * counts.expression_count))
        check_ok(lib.mhr_runtime_reset_state(runtime), "mhr_runtime_reset_state", lib.mhr_runtime_last_error(runtime))
        check_ok(
            lib.mhr_runtime_set_model_parameters(runtime, model_params, counts.model_parameter_count),
            "mhr_runtime_set_model_parameters",
            lib.mhr_runtime_last_error(runtime),
        )
        check_ok(
            lib.mhr_runtime_set_identity(runtime, identity, counts.identity_count),
            "mhr_runtime_set_identity",
            lib.mhr_runtime_last_error(runtime),
        )
        check_ok(
            lib.mhr_runtime_set_expression(runtime, expression, counts.expression_count),
            "mhr_runtime_set_expression",
            lib.mhr_runtime_last_error(runtime),
        )
        vertices = (ctypes.c_float * (counts.vertex_count * 3))()

        for _ in range(warmup):
            check_ok(lib.mhr_runtime_evaluate(runtime), "mhr_runtime_evaluate", lib.mhr_runtime_last_error(runtime))
            check_ok(
                lib.mhr_runtime_get_vertices(runtime, vertices, counts.vertex_count * 3),
                "mhr_runtime_get_vertices",
                lib.mhr_runtime_last_error(runtime),
            )

        evaluate_wall: list[float] = []
        full_to_verts_wall: list[float] = []
        core: list[float] = []
        for _ in range(iterations):
            full_start = time.perf_counter()
            check_ok(lib.mhr_runtime_reset_state(runtime), "mhr_runtime_reset_state", lib.mhr_runtime_last_error(runtime))
            check_ok(
                lib.mhr_runtime_set_model_parameters(runtime, model_params, counts.model_parameter_count),
                "mhr_runtime_set_model_parameters",
                lib.mhr_runtime_last_error(runtime),
            )
            check_ok(
                lib.mhr_runtime_set_identity(runtime, identity, counts.identity_count),
                "mhr_runtime_set_identity",
                lib.mhr_runtime_last_error(runtime),
            )
            check_ok(
                lib.mhr_runtime_set_expression(runtime, expression, counts.expression_count),
                "mhr_runtime_set_expression",
                lib.mhr_runtime_last_error(runtime),
            )
            evaluate_start = time.perf_counter()
            check_ok(lib.mhr_runtime_evaluate(runtime), "mhr_runtime_evaluate", lib.mhr_runtime_last_error(runtime))
            evaluate_wall.append((time.perf_counter() - evaluate_start) * 1000.0)
            check_ok(
                lib.mhr_runtime_get_vertices(runtime, vertices, counts.vertex_count * 3),
                "mhr_runtime_get_vertices",
                lib.mhr_runtime_last_error(runtime),
            )
            full_to_verts_wall.append((time.perf_counter() - full_start) * 1000.0)
            timing = MhrRuntimeDebugTiming()
            check_ok(
                lib.mhr_runtime_get_debug_timing(runtime, ctypes.byref(timing)),
                "mhr_runtime_get_debug_timing",
                lib.mhr_runtime_last_error(runtime),
            )
            core.append(float(timing.evaluate_core_ms))

        return {
            "counts": {
                "vertexCount": counts.vertex_count,
                "jointCount": counts.joint_count,
                "modelParameterCount": counts.model_parameter_count,
                "identityCount": counts.identity_count,
                "expressionCount": counts.expression_count,
            },
            "evaluateWallMs": summarize(evaluate_wall),
            "fullToVertsWallMs": summarize(full_to_verts_wall),
            "evaluateCoreMs": summarize(core),
        }
    finally:
        lib.mhr_runtime_destroy(runtime)


def run_ir_bench(lib: ctypes.CDLL, runtime_ir_dir: Path, warmup: int, iterations: int) -> dict[str, object]:
    bundle_view, _keepalive = build_bundle_view(runtime_ir_dir)
    model = ctypes.c_void_p(lib.mhr_model_load_ir(ctypes.byref(bundle_view)))
    if not model.value:
        raise RuntimeError("mhr_model_load_ir returned null.")
    data = ctypes.c_void_p()
    try:
        counts = MhrModelCounts()
        check_ok(
            lib.mhr_model_get_counts(model, ctypes.byref(counts)),
            "mhr_model_get_counts",
            lib.mhr_model_last_error(model),
        )
        data = ctypes.c_void_p(lib.mhr_data_create(model))
        if not data.value:
            raise RuntimeError("mhr_data_create returned null.")
        model_params = (ctypes.c_float * counts.model_parameter_count)(*([0.0] * counts.model_parameter_count))
        identity = (ctypes.c_float * counts.identity_count)(*([0.0] * counts.identity_count))
        expression = (ctypes.c_float * counts.expression_count)(*([0.0] * counts.expression_count))
        check_ok(lib.mhr_data_reset(model, data), "mhr_data_reset", lib.mhr_data_last_error(data))
        check_ok(
            lib.mhr_data_set_model_parameters(model, data, model_params, counts.model_parameter_count),
            "mhr_data_set_model_parameters",
            lib.mhr_data_last_error(data),
        )
        check_ok(
            lib.mhr_data_set_identity(model, data, identity, counts.identity_count),
            "mhr_data_set_identity",
            lib.mhr_data_last_error(data),
        )
        check_ok(
            lib.mhr_data_set_expression(model, data, expression, counts.expression_count),
            "mhr_data_set_expression",
            lib.mhr_data_last_error(data),
        )
        vertices = (ctypes.c_float * (counts.vertex_count * 3))()

        for _ in range(warmup):
            check_ok(lib.mhr_forward(model, data, 0), "mhr_forward", lib.mhr_data_last_error(data))
            check_ok(
                lib.mhr_get_vertices(model, data, vertices, counts.vertex_count * 3),
                "mhr_get_vertices",
                lib.mhr_data_last_error(data),
            )

        forward_wall: list[float] = []
        full_to_verts_wall: list[float] = []
        core: list[float] = []
        for _ in range(iterations):
            full_start = time.perf_counter()
            check_ok(lib.mhr_data_reset(model, data), "mhr_data_reset", lib.mhr_data_last_error(data))
            check_ok(
                lib.mhr_data_set_model_parameters(model, data, model_params, counts.model_parameter_count),
                "mhr_data_set_model_parameters",
                lib.mhr_data_last_error(data),
            )
            check_ok(
                lib.mhr_data_set_identity(model, data, identity, counts.identity_count),
                "mhr_data_set_identity",
                lib.mhr_data_last_error(data),
            )
            check_ok(
                lib.mhr_data_set_expression(model, data, expression, counts.expression_count),
                "mhr_data_set_expression",
                lib.mhr_data_last_error(data),
            )
            forward_start = time.perf_counter()
            check_ok(lib.mhr_forward(model, data, 0), "mhr_forward", lib.mhr_data_last_error(data))
            forward_wall.append((time.perf_counter() - forward_start) * 1000.0)
            check_ok(
                lib.mhr_get_vertices(model, data, vertices, counts.vertex_count * 3),
                "mhr_get_vertices",
                lib.mhr_data_last_error(data),
            )
            full_to_verts_wall.append((time.perf_counter() - full_start) * 1000.0)
            timing = MhrRuntimeDebugTiming()
            check_ok(
                lib.mhr_get_debug_timing(data, ctypes.byref(timing)),
                "mhr_get_debug_timing",
                lib.mhr_data_last_error(data),
            )
            core.append(float(timing.evaluate_core_ms))

        return {
            "counts": {
                "vertexCount": counts.vertex_count,
                "jointCount": counts.joint_count,
                "modelParameterCount": counts.model_parameter_count,
                "identityCount": counts.identity_count,
                "expressionCount": counts.expression_count,
                "parameterInputCount": counts.parameter_input_count,
                "poseFeatureCount": counts.pose_feature_count,
                "hiddenCount": counts.hidden_count,
            },
            "forwardWallMs": summarize(forward_wall),
            "fullToVertsWallMs": summarize(full_to_verts_wall),
            "evaluateCoreMs": summarize(core),
        }
    finally:
        if data.value:
            lib.mhr_data_destroy(data)
        lib.mhr_model_destroy(model)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, help="processed bundle manifest path")
    parser.add_argument("--build-dir", help="out-of-tree native build dir")
    parser.add_argument("--config", default="Release")
    parser.add_argument("--warmup", type=int, default=3)
    parser.add_argument("--iterations", type=int, default=20)
    args = parser.parse_args()

    repo_root = repo_root_from_here(__file__)
    python_executable = resolve_exact_runtime_python_executable(repo_root)
    os.environ["PYTHON_EXE"] = python_executable
    processed_manifest = Path(args.manifest).resolve()
    processed_dir = processed_manifest.parent
    processed_manifest_payload = json.loads(processed_manifest.read_text(encoding="utf-8"))
    bundle_id = str(processed_manifest_payload.get("bundleId", processed_manifest.stem))
    build_dir = Path(args.build_dir).resolve() if args.build_dir else default_build_dir()

    with tempfile.TemporaryDirectory(prefix="mhr-runtime-ir-bench-") as temp_dir:
        runtime_ir_dir = Path(temp_dir) / "runtime_ir"
        compile_runtime_ir(
            manifest_path=processed_manifest,
            out_dir=runtime_ir_dir,
            zero_epsilon=0.0,
            verify_roundtrip=True,
        )
        library_path = configure_library(repo_root, build_dir, args.config)
        lib = ctypes.CDLL(str(library_path))
        bind_api(lib)

        legacy = run_legacy_bench(lib, processed_dir, args.warmup, args.iterations)
        ir = run_ir_bench(lib, runtime_ir_dir, args.warmup, args.iterations)
        speedup = 0.0
        if ir["fullToVertsWallMs"]["median"] > 0:
            speedup = legacy["fullToVertsWallMs"]["median"] / ir["fullToVertsWallMs"]["median"]

        print(
            json.dumps(
                {
                    "libraryPath": str(library_path),
                    "manifest": str(processed_manifest),
                    "bundleId": bundle_id,
                    "lodTag": infer_lod_tag(bundle_id),
                    "pythonExe": python_executable,
                    "warmup": args.warmup,
                    "iterations": args.iterations,
                    "legacyDenseRuntime": legacy,
                    "irPortableRuntime": ir,
                    "medianFullToVertsSpeedup": speedup,
                },
                indent=2,
                sort_keys=True,
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
