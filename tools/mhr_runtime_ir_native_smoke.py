#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ctypes
import json
import tempfile
from pathlib import Path

from build_native import configure_and_build, default_build_dir, default_generator
from local_config import repo_root_from_here
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


def configure_library(repo_root: Path, build_dir: Path, config: str) -> Path:
    build_dir.mkdir(parents=True, exist_ok=True)
    return configure_and_build(
        repo_root=repo_root,
        build_dir=build_dir,
        config=config,
        generator=default_generator(),
    )


def bind_api(lib: ctypes.CDLL) -> None:
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
    lib.mhr_data_set_model_parameters.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_uint32]
    lib.mhr_data_set_model_parameters.restype = ctypes.c_int
    lib.mhr_data_set_identity.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_uint32]
    lib.mhr_data_set_identity.restype = ctypes.c_int
    lib.mhr_data_set_expression.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_uint32]
    lib.mhr_data_set_expression.restype = ctypes.c_int
    lib.mhr_forward.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32]
    lib.mhr_forward.restype = ctypes.c_int
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


def build_bundle_view(runtime_ir_dir: Path) -> tuple[MhrBundleView, list[object]]:
    manifest = json.loads((runtime_ir_dir / "manifest.json").read_text(encoding="utf-8"))
    chunk_views: list[MhrArrayView] = []
    keepalive: list[object] = []

    for chunk in manifest["chunks"]:
        raw = (runtime_ir_dir / chunk["file"]).read_bytes()
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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, help="processed bundle manifest path")
    parser.add_argument("--build-dir", help="out-of-tree native build dir")
    parser.add_argument("--config", default="Release")
    args = parser.parse_args()

    repo_root = repo_root_from_here(__file__)
    processed_manifest = Path(args.manifest).resolve()
    build_dir = Path(args.build_dir).resolve() if args.build_dir else default_build_dir()

    with tempfile.TemporaryDirectory(prefix="mhr-runtime-ir-native-") as temp_dir:
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

        bundle_view, _keepalive = build_bundle_view(runtime_ir_dir)
        model_ptr = lib.mhr_model_load_ir(ctypes.byref(bundle_view))
        if not model_ptr:
            raise RuntimeError("mhr_model_load_ir returned null.")
        data_ptr = ctypes.c_void_p()
        try:
            counts = MhrModelCounts()
            check_ok(
                lib.mhr_model_get_counts(model_ptr, ctypes.byref(counts)),
                "mhr_model_get_counts",
                lib.mhr_model_last_error(model_ptr),
            )
            data_ptr = ctypes.c_void_p(lib.mhr_data_create(model_ptr))
            if not data_ptr.value:
                raise RuntimeError("mhr_data_create returned null.")

            check_ok(
                lib.mhr_data_reset(model_ptr, data_ptr),
                "mhr_data_reset",
                lib.mhr_data_last_error(data_ptr),
            )

            model_params = (ctypes.c_float * counts.model_parameter_count)(
                *([0.0] * counts.model_parameter_count)
            )
            identity = (ctypes.c_float * counts.identity_count)(
                *([0.0] * counts.identity_count)
            )
            expression = (ctypes.c_float * counts.expression_count)(
                *([0.0] * counts.expression_count)
            )

            check_ok(
                lib.mhr_data_set_model_parameters(
                    model_ptr,
                    data_ptr,
                    model_params,
                    counts.model_parameter_count,
                ),
                "mhr_data_set_model_parameters",
                lib.mhr_data_last_error(data_ptr),
            )
            check_ok(
                lib.mhr_data_set_identity(
                    model_ptr,
                    data_ptr,
                    identity,
                    counts.identity_count,
                ),
                "mhr_data_set_identity",
                lib.mhr_data_last_error(data_ptr),
            )
            check_ok(
                lib.mhr_data_set_expression(
                    model_ptr,
                    data_ptr,
                    expression,
                    counts.expression_count,
                ),
                "mhr_data_set_expression",
                lib.mhr_data_last_error(data_ptr),
            )
            check_ok(
                lib.mhr_forward(model_ptr, data_ptr, 0),
                "mhr_forward",
                lib.mhr_data_last_error(data_ptr),
            )

            vertex_count = counts.vertex_count * 3
            skeleton_count = counts.joint_count * 8
            derived_count = 7
            vertices = (ctypes.c_float * vertex_count)()
            skeleton = (ctypes.c_float * skeleton_count)()
            derived = (ctypes.c_float * derived_count)()

            check_ok(
                lib.mhr_get_vertices(model_ptr, data_ptr, vertices, vertex_count),
                "mhr_get_vertices",
                lib.mhr_data_last_error(data_ptr),
            )
            check_ok(
                lib.mhr_get_skeleton(model_ptr, data_ptr, skeleton, skeleton_count),
                "mhr_get_skeleton",
                lib.mhr_data_last_error(data_ptr),
            )
            check_ok(
                lib.mhr_get_derived(model_ptr, data_ptr, derived, derived_count),
                "mhr_get_derived",
                lib.mhr_data_last_error(data_ptr),
            )

            print(
                json.dumps(
                    {
                        "libraryPath": str(library_path),
                        "counts": {
                            "vertexCount": counts.vertex_count,
                            "faceCount": counts.face_count,
                            "jointCount": counts.joint_count,
                            "modelParameterCount": counts.model_parameter_count,
                            "identityCount": counts.identity_count,
                            "expressionCount": counts.expression_count,
                            "parameterInputCount": counts.parameter_input_count,
                            "poseFeatureCount": counts.pose_feature_count,
                            "hiddenCount": counts.hidden_count,
                        },
                        "firstVertex": [
                            float(vertices[index]) for index in range(min(3, vertex_count))
                        ],
                        "rootJoint": [
                            float(skeleton[index]) for index in range(min(8, skeleton_count))
                        ],
                        "derived": [float(derived[index]) for index in range(derived_count)],
                    },
                    indent=2,
                    sort_keys=True,
                )
            )
        finally:
            if data_ptr.value:
                lib.mhr_data_destroy(data_ptr)
            lib.mhr_model_destroy(model_ptr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
