#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import math
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from build_native import configure_and_build, default_build_dir, default_generator, locate_native_library
from local_config import repo_root_from_here
from mhr_reference import build_raw_inputs, load_case_manifest


SCALAR_TYPES = {
    "float32": 1,
    "uint32": 2,
    "int32": 3,
    "int64": 4,
    "uint8": 5,
}

PYTHON_NATIVE_THRESHOLDS = {
    "maxAbs": 1e-5,
    "rms": 1e-6,
}


class MhrArrayView(ctypes.Structure):
    _fields_ = [
        ("key", ctypes.c_char_p),
        ("data", ctypes.c_void_p),
        ("byte_length", ctypes.c_size_t),
        ("scalar_type", ctypes.c_int),
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


@dataclass
class BundleBinding:
    view: MhrBundleView
    arrays: list[np.ndarray]
    keys: list[bytes]
    shapes: list[Any]
    views: Any


def sha256_hex(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def load_manifest_arrays(manifest_path: Path) -> tuple[dict[str, Any], BundleBinding]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    arrays: list[np.ndarray] = []
    keys: list[bytes] = []
    shapes: list[Any] = []
    array_views: list[MhrArrayView] = []

    for chunk in manifest["chunks"]:
        chunk_path = manifest_path.parent / chunk["file"]
        if not chunk_path.exists():
            raise FileNotFoundError(f"Chunk file not found: {chunk_path}")
        if chunk_path.stat().st_size != int(chunk["byteLength"]):
            raise ValueError(f"Chunk byteLength mismatch for {chunk['key']}")
        if sha256_hex(chunk_path) != chunk["sha256"]:
            raise ValueError(f"Chunk sha256 mismatch for {chunk['key']}")

        dtype = np.dtype(str(chunk["dtype"]))
        shape = tuple(int(dim) for dim in chunk["shape"])
        array = np.memmap(chunk_path, dtype=dtype, mode="r", shape=shape, order="C")
        keys.append(str(chunk["key"]).encode("utf-8"))
        arrays.append(array)
        shape_buffer = (ctypes.c_uint64 * len(shape))(*shape)
        shapes.append(shape_buffer)
        array_views.append(
            MhrArrayView(
                key=keys[-1],
                data=ctypes.c_void_p(int(array.ctypes.data)),
                byte_length=int(chunk["byteLength"]),
                scalar_type=SCALAR_TYPES[str(chunk["dtype"])],
                rank=len(shape),
                shape=shape_buffer,
            )
        )

    view_array_type = MhrArrayView * len(array_views)
    view_array = view_array_type(*array_views)
    bundle_view = MhrBundleView(version=1, array_count=len(array_views), arrays=view_array)
    return manifest, BundleBinding(
        view=bundle_view,
        arrays=arrays,
        keys=keys,
        shapes=shapes,
        views=view_array,
    )


def configure_library(lib: ctypes.CDLL) -> None:
    lib.mhr_native_version.restype = ctypes.c_char_p
    lib.mhr_runtime_create.restype = ctypes.c_void_p
    lib.mhr_runtime_destroy.argtypes = [ctypes.c_void_p]
    lib.mhr_runtime_last_error.argtypes = [ctypes.c_void_p]
    lib.mhr_runtime_last_error.restype = ctypes.c_char_p
    lib.mhr_runtime_load_bundle.argtypes = [ctypes.c_void_p, ctypes.POINTER(MhrBundleView)]
    lib.mhr_runtime_load_bundle.restype = ctypes.c_int
    lib.mhr_runtime_reset_state.argtypes = [ctypes.c_void_p]
    lib.mhr_runtime_reset_state.restype = ctypes.c_int
    lib.mhr_runtime_set_model_parameters.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_float),
        ctypes.c_uint32,
    ]
    lib.mhr_runtime_set_model_parameters.restype = ctypes.c_int
    lib.mhr_runtime_set_identity.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_float),
        ctypes.c_uint32,
    ]
    lib.mhr_runtime_set_identity.restype = ctypes.c_int
    lib.mhr_runtime_set_expression.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_float),
        ctypes.c_uint32,
    ]
    lib.mhr_runtime_set_expression.restype = ctypes.c_int
    lib.mhr_runtime_evaluate.argtypes = [ctypes.c_void_p]
    lib.mhr_runtime_evaluate.restype = ctypes.c_int
    lib.mhr_runtime_get_counts.argtypes = [ctypes.c_void_p, ctypes.POINTER(MhrRuntimeCounts)]
    lib.mhr_runtime_get_counts.restype = ctypes.c_int
    lib.mhr_runtime_get_vertices.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_float),
        ctypes.c_uint32,
    ]
    lib.mhr_runtime_get_vertices.restype = ctypes.c_int
    lib.mhr_runtime_get_joint_parameters.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_float),
        ctypes.c_uint32,
    ]
    lib.mhr_runtime_get_joint_parameters.restype = ctypes.c_int
    lib.mhr_runtime_get_local_skeleton.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_float),
        ctypes.c_uint32,
    ]
    lib.mhr_runtime_get_local_skeleton.restype = ctypes.c_int
    lib.mhr_runtime_get_rest_vertices.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_float),
        ctypes.c_uint32,
    ]
    lib.mhr_runtime_get_rest_vertices.restype = ctypes.c_int
    lib.mhr_runtime_get_pose_features.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_float),
        ctypes.c_uint32,
    ]
    lib.mhr_runtime_get_pose_features.restype = ctypes.c_int
    lib.mhr_runtime_get_hidden.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_float),
        ctypes.c_uint32,
    ]
    lib.mhr_runtime_get_hidden.restype = ctypes.c_int
    lib.mhr_runtime_get_corrective_delta.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_float),
        ctypes.c_uint32,
    ]
    lib.mhr_runtime_get_corrective_delta.restype = ctypes.c_int
    lib.mhr_runtime_get_skin_joint_states.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_float),
        ctypes.c_uint32,
    ]
    lib.mhr_runtime_get_skin_joint_states.restype = ctypes.c_int
    lib.mhr_runtime_get_skeleton.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_float),
        ctypes.c_uint32,
    ]
    lib.mhr_runtime_get_skeleton.restype = ctypes.c_int
    lib.mhr_runtime_get_derived.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_float),
        ctypes.c_uint32,
    ]
    lib.mhr_runtime_get_derived.restype = ctypes.c_int


def build_or_locate_library(*, repo_root: Path, build_dir: Path, config: str, rebuild: bool) -> Path:
    if rebuild:
        return configure_and_build(
            repo_root=repo_root,
            build_dir=build_dir,
            config=config,
            generator=default_generator(),
        )
    return locate_native_library(build_dir, config)


def ensure_ok(result: int, lib: ctypes.CDLL, runtime: ctypes.c_void_p, label: str) -> None:
    if result == 1:
        return
    message = lib.mhr_runtime_last_error(runtime)
    detail = message.decode("utf-8") if message else "unknown native error"
    raise RuntimeError(f"{label} failed: {detail}")


def compare_arrays(reference: np.ndarray, candidate: np.ndarray) -> dict[str, float]:
    diff = reference.astype(np.float64) - candidate.astype(np.float64)
    max_abs = float(np.max(np.abs(diff)))
    rms = float(math.sqrt(float(np.mean(diff * diff))))
    return {
        "maxAbs": max_abs,
        "rms": rms,
    }


def save_case_outputs(case_dir: Path, vertices: np.ndarray, skeleton: np.ndarray, derived: dict[str, Any]) -> None:
    case_dir.mkdir(parents=True, exist_ok=True)
    np.save(case_dir / "vertices.npy", vertices)
    np.save(case_dir / "skeleton_state.npy", skeleton)
    (case_dir / "derived.json").write_text(json.dumps(derived, indent=2) + "\n", encoding="utf-8")


def run_case(
    *,
    lib: ctypes.CDLL,
    runtime: ctypes.c_void_p,
    case_id: str,
    state_patch: dict[str, Any],
    parameter_metadata: dict[str, Any],
    counts: MhrRuntimeCounts,
    out_root: Path,
    oracle_root: Path | None,
    enforce_thresholds: bool,
) -> dict[str, Any]:
    raw_inputs = build_raw_inputs(parameter_metadata, state_patch)

    model_parameters = np.ascontiguousarray(raw_inputs["model_parameters"].reshape(-1), dtype=np.float32)
    identity = np.ascontiguousarray(raw_inputs["identity"].reshape(-1), dtype=np.float32)
    expression = np.ascontiguousarray(raw_inputs["expression"].reshape(-1), dtype=np.float32)

    ensure_ok(lib.mhr_runtime_reset_state(runtime), lib, runtime, "mhr_runtime_reset_state")
    ensure_ok(
        lib.mhr_runtime_set_model_parameters(
            runtime,
            model_parameters.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            model_parameters.size,
        ),
        lib,
        runtime,
        "mhr_runtime_set_model_parameters",
    )
    ensure_ok(
        lib.mhr_runtime_set_identity(
            runtime,
            identity.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            identity.size,
        ),
        lib,
        runtime,
        "mhr_runtime_set_identity",
    )
    ensure_ok(
        lib.mhr_runtime_set_expression(
            runtime,
            expression.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            expression.size,
        ),
        lib,
        runtime,
        "mhr_runtime_set_expression",
    )
    ensure_ok(lib.mhr_runtime_evaluate(runtime), lib, runtime, "mhr_runtime_evaluate")

    vertices = np.zeros((counts.vertex_count * 3,), dtype=np.float32)
    skeleton = np.zeros((counts.joint_count * 8,), dtype=np.float32)
    derived_values = np.zeros((7,), dtype=np.float32)

    ensure_ok(
        lib.mhr_runtime_get_vertices(
            runtime,
            vertices.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            vertices.size,
        ),
        lib,
        runtime,
        "mhr_runtime_get_vertices",
    )
    ensure_ok(
        lib.mhr_runtime_get_skeleton(
            runtime,
            skeleton.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            skeleton.size,
        ),
        lib,
        runtime,
        "mhr_runtime_get_skeleton",
    )
    ensure_ok(
        lib.mhr_runtime_get_derived(
            runtime,
            derived_values.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            derived_values.size,
        ),
        lib,
        runtime,
        "mhr_runtime_get_derived",
    )

    vertices = vertices.reshape(1, counts.vertex_count, 3)
    skeleton = skeleton.reshape(1, counts.joint_count, 8)
    derived = {
        "vertexCount": int(counts.vertex_count),
        "jointCount": int(counts.joint_count),
        "rootTranslation": [float(value) for value in derived_values[0:3]],
        "firstVertex": [float(value) for value in derived_values[3:6]],
        "skeletonExtentY": float(derived_values[6]),
    }

    case_dir = out_root / case_id
    save_case_outputs(case_dir, vertices, skeleton, derived)

    report: dict[str, Any] = {
        "id": case_id,
        "rawInputCounts": {
            "modelParameters": int(model_parameters.size),
            "identity": int(identity.size),
            "expression": int(expression.size),
        },
        "derived": derived,
    }
    if oracle_root is not None:
        oracle_case_dir = oracle_root / case_id
        oracle_vertices = np.load(oracle_case_dir / "vertices.npy")
        oracle_skeleton = np.load(oracle_case_dir / "skeleton_state.npy")
        vertex_stats = compare_arrays(oracle_vertices, vertices)
        skeleton_stats = compare_arrays(oracle_skeleton, skeleton)
        report["oracleComparison"] = {
            "vertices": vertex_stats,
            "skeleton": skeleton_stats,
            "thresholds": PYTHON_NATIVE_THRESHOLDS,
            "pass": (
                vertex_stats["maxAbs"] <= PYTHON_NATIVE_THRESHOLDS["maxAbs"]
                and vertex_stats["rms"] <= PYTHON_NATIVE_THRESHOLDS["rms"]
                and skeleton_stats["maxAbs"] <= PYTHON_NATIVE_THRESHOLDS["maxAbs"]
                and skeleton_stats["rms"] <= PYTHON_NATIVE_THRESHOLDS["rms"]
            ),
        }
        if enforce_thresholds and not report["oracleComparison"]["pass"]:
            raise RuntimeError(f"Native parity thresholds failed for case {case_id}")
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", default="local_tools/official_bundle/manifest.json", help="processed bundle manifest")
    parser.add_argument("--cases", default="tests/golden_cases/manifest.json", help="golden case manifest")
    parser.add_argument("--out", default="local_tools/mhr_parity/ref_native", help="output directory")
    parser.add_argument("--oracle-root", help="directory containing Python oracle artifacts")
    parser.add_argument("--build-dir", help="native build directory")
    parser.add_argument("--config", default="Release", help="native build config")
    parser.add_argument("--rebuild", action="store_true", help="force a native rebuild before running")
    parser.add_argument("--enforce-thresholds", action="store_true", help="fail on parity threshold violations")
    args = parser.parse_args()

    repo_root = repo_root_from_here(__file__)
    manifest_path = Path(args.manifest).resolve()
    case_manifest_path = Path(args.cases).resolve()
    out_root = Path(args.out).resolve()
    out_root.mkdir(parents=True, exist_ok=True)
    oracle_root = Path(args.oracle_root).resolve() if args.oracle_root else None
    build_dir = Path(args.build_dir).resolve() if args.build_dir else default_build_dir()
    build_dir.mkdir(parents=True, exist_ok=True)

    library_path = build_or_locate_library(
        repo_root=repo_root,
        build_dir=build_dir,
        config=args.config,
        rebuild=args.rebuild,
    )
    lib = ctypes.CDLL(str(library_path))
    configure_library(lib)

    manifest, binding = load_manifest_arrays(manifest_path)
    parameter_metadata = manifest["parameterMetadata"]

    runtime = ctypes.c_void_p(lib.mhr_runtime_create())
    if not runtime:
        raise RuntimeError("Failed to create native runtime.")
    try:
        ensure_ok(
            lib.mhr_runtime_load_bundle(runtime, ctypes.byref(binding.view)),
            lib,
            runtime,
            "mhr_runtime_load_bundle",
        )
        counts = MhrRuntimeCounts()
        ensure_ok(lib.mhr_runtime_get_counts(runtime, ctypes.byref(counts)), lib, runtime, "mhr_runtime_get_counts")

        discrete_checks = {
            "modelParameterCount": {
                "expected": int(parameter_metadata["counts"]["modelParameterCount"]),
                "actual": int(counts.model_parameter_count),
                "pass": int(parameter_metadata["counts"]["modelParameterCount"]) == int(counts.model_parameter_count),
            },
            "identityCount": {
                "expected": int(parameter_metadata["counts"]["identityCount"]),
                "actual": int(counts.identity_count),
                "pass": int(parameter_metadata["counts"]["identityCount"]) == int(counts.identity_count),
            },
            "expressionCount": {
                "expected": int(parameter_metadata["counts"]["expressionCount"]),
                "actual": int(counts.expression_count),
                "pass": int(parameter_metadata["counts"]["expressionCount"]) == int(counts.expression_count),
            },
            "vertexCount": {
                "expected": int(parameter_metadata["counts"]["vertexCount"]),
                "actual": int(counts.vertex_count),
                "pass": int(parameter_metadata["counts"]["vertexCount"]) == int(counts.vertex_count),
            },
            "jointCount": {
                "expected": int(parameter_metadata["counts"]["jointCount"]),
                "actual": int(counts.joint_count),
                "pass": int(parameter_metadata["counts"]["jointCount"]) == int(counts.joint_count),
            },
        }

        case_manifest = load_case_manifest(case_manifest_path)
        cases = case_manifest.get("cases")
        if not isinstance(cases, list) or not cases:
            raise ValueError("Golden case manifest requires a non-empty cases list.")

        report = {
            "libraryPath": str(library_path),
            "manifest": str(manifest_path),
            "cases": [],
            "discreteChecks": discrete_checks,
        }
        for entry in cases:
            case_id = str(entry["id"])
            case_path = case_manifest_path.parent / str(entry["path"])
            case_payload = json.loads(case_path.read_text(encoding="utf-8"))
            case_report = run_case(
                lib=lib,
                runtime=runtime,
                case_id=case_id,
                state_patch=case_payload.get("state", {}),
                parameter_metadata=parameter_metadata,
                counts=counts,
                out_root=out_root,
                oracle_root=oracle_root,
                enforce_thresholds=args.enforce_thresholds,
            )
            report["cases"].append(case_report)

        (out_root / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(f"Wrote native parity outputs to {out_root}")
        return 0
    finally:
        lib.mhr_runtime_destroy(runtime)


if __name__ == "__main__":
    raise SystemExit(main())
