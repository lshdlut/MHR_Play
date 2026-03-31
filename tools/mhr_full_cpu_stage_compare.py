#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ctypes
import json
import os
import tempfile
from pathlib import Path
from typing import Any

import numpy as np

from local_config import repo_root_from_here, resolve_exact_runtime_python_executable
from mhr_full_reference import (
    compare_float32_arrays,
    extract_full_surface_basis,
    extract_full_inverse_bind_pose,
    load_full_model,
    collect_full_stage_outputs,
    build_random_raw_inputs,
)
from mhr_reference import build_raw_inputs, load_case_manifest, load_torchscript_model
from mhr_runtime_compare_bench import (
    MhrModelCounts,
    MhrRuntimeCounts,
    bind_api,
    build_bundle_view,
    check_ok,
    configure_library,
)
from mhr_runtime_ir_compile import compile_runtime_ir


PORTABLE_STAGE_ENUM = {
    "joint_parameters": 1,
    "local_skeleton_state": 2,
    "global_skeleton_state": 3,
    "rest_surface_pre_corrective": 4,
    "pose_features": 5,
    "hidden": 6,
    "corrective_delta": 7,
    "rest_surface_post_corrective": 8,
    "skin_joint_states": 9,
    "final_vertices": 10,
}


def stage_sizes_from_manifest(processed_payload: dict[str, Any]) -> dict[str, int]:
    counts = processed_payload["parameterMetadata"]["counts"]
    vertex_values = int(counts["vertexCount"]) * 3
    joint_values = int(counts["jointCount"]) * 8
    hidden_count = int(counts["correctiveDenseShape"][1])
    if hidden_count % 24 != 0:
        raise ValueError("correctiveDense hidden count must be divisible by 24.")
    pose_feature_count = (hidden_count // 24) * 6
    return {
        "joint_parameters": int(counts["jointCount"]) * 7,
        "local_skeleton_state": joint_values,
        "global_skeleton_state": joint_values,
        "rest_surface_pre_corrective": vertex_values,
        "pose_features": pose_feature_count,
        "hidden": hidden_count,
        "corrective_delta": vertex_values,
        "rest_surface_post_corrective": vertex_values,
        "skin_joint_states": joint_values,
        "final_vertices": vertex_values,
    }


def load_cases(
    *,
    cases_manifest: Path,
    parameter_metadata: dict[str, Any],
    random_batch_size: int,
    random_seed: int,
) -> list[dict[str, Any]]:
    case_manifest = load_case_manifest(cases_manifest)
    entries = case_manifest.get("cases")
    if not isinstance(entries, list) or not entries:
        raise ValueError("Golden case manifest requires a non-empty cases list.")

    cases: list[dict[str, Any]] = []
    for entry in entries:
        case_payload = json.loads((cases_manifest.parent / str(entry["path"])).read_text(encoding="utf-8"))
        raw_inputs = build_raw_inputs(parameter_metadata, case_payload.get("state", {}))
        cases.append(
            {
                "id": str(entry["id"]),
                "kind": "golden",
                "raw_inputs": raw_inputs,
            }
        )

    if random_batch_size > 0:
        counts = parameter_metadata["counts"]
        cases.append(
            {
                "id": f"random_batch{random_batch_size}_seed{random_seed}",
                "kind": "random",
                "raw_inputs": build_random_raw_inputs(
                    model_parameter_count=int(counts["modelParameterCount"]),
                    identity_count=int(counts["identityCount"]),
                    expression_count=int(counts["expressionCount"]),
                    batch_size=random_batch_size,
                    seed=random_seed,
                ),
            }
        )
    return cases


def evaluate_exact_stage_outputs(
    lib: ctypes.CDLL,
    runtime: ctypes.c_void_p,
    counts: MhrRuntimeCounts,
    stage_sizes: dict[str, int],
    raw_inputs: dict[str, np.ndarray],
) -> dict[str, np.ndarray]:
    batch_size = int(raw_inputs["model_parameters"].shape[0])
    if batch_size > 1:
        batches = [
            evaluate_exact_stage_outputs(
                lib,
                runtime,
                counts,
                stage_sizes,
                {
                    "model_parameters": raw_inputs["model_parameters"][index : index + 1],
                    "identity": raw_inputs["identity"][index : index + 1],
                    "expression": raw_inputs["expression"][index : index + 1],
                },
            )
            for index in range(batch_size)
        ]
        return {
            stage_name: np.concatenate([batch[stage_name] for batch in batches], axis=0)
            for stage_name in batches[0]
        }

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

    joint_parameters = np.zeros((stage_sizes["joint_parameters"],), dtype=np.float32)
    local_skeleton = np.zeros((stage_sizes["local_skeleton_state"],), dtype=np.float32)
    rest_post = np.zeros((stage_sizes["rest_surface_post_corrective"],), dtype=np.float32)
    pose_features = np.zeros((stage_sizes["pose_features"],), dtype=np.float32)
    hidden = np.zeros((stage_sizes["hidden"],), dtype=np.float32)
    corrective_delta = np.zeros((stage_sizes["corrective_delta"],), dtype=np.float32)
    skin_joint_states = np.zeros((stage_sizes["skin_joint_states"],), dtype=np.float32)
    global_skeleton = np.zeros((counts.joint_count * 8,), dtype=np.float32)
    final_vertices = np.zeros((counts.vertex_count * 3,), dtype=np.float32)

    check_ok(
        lib.mhr_runtime_get_joint_parameters(
            runtime,
            joint_parameters.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            joint_parameters.size,
        ),
        "mhr_runtime_get_joint_parameters",
        lib.mhr_runtime_last_error(runtime),
    )
    check_ok(
        lib.mhr_runtime_get_local_skeleton(
            runtime,
            local_skeleton.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            local_skeleton.size,
        ),
        "mhr_runtime_get_local_skeleton",
        lib.mhr_runtime_last_error(runtime),
    )
    check_ok(
        lib.mhr_runtime_get_rest_vertices(
            runtime,
            rest_post.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            rest_post.size,
        ),
        "mhr_runtime_get_rest_vertices",
        lib.mhr_runtime_last_error(runtime),
    )
    check_ok(
        lib.mhr_runtime_get_pose_features(
            runtime,
            pose_features.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            pose_features.size,
        ),
        "mhr_runtime_get_pose_features",
        lib.mhr_runtime_last_error(runtime),
    )
    check_ok(
        lib.mhr_runtime_get_hidden(
            runtime,
            hidden.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            hidden.size,
        ),
        "mhr_runtime_get_hidden",
        lib.mhr_runtime_last_error(runtime),
    )
    check_ok(
        lib.mhr_runtime_get_corrective_delta(
            runtime,
            corrective_delta.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            corrective_delta.size,
        ),
        "mhr_runtime_get_corrective_delta",
        lib.mhr_runtime_last_error(runtime),
    )
    check_ok(
        lib.mhr_runtime_get_skin_joint_states(
            runtime,
            skin_joint_states.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            skin_joint_states.size,
        ),
        "mhr_runtime_get_skin_joint_states",
        lib.mhr_runtime_last_error(runtime),
    )
    check_ok(
        lib.mhr_runtime_get_skeleton(
            runtime,
            global_skeleton.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            global_skeleton.size,
        ),
        "mhr_runtime_get_skeleton",
        lib.mhr_runtime_last_error(runtime),
    )
    check_ok(
        lib.mhr_runtime_get_vertices(
            runtime,
            final_vertices.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            final_vertices.size,
        ),
        "mhr_runtime_get_vertices",
        lib.mhr_runtime_last_error(runtime),
    )
    return {
        "joint_parameters": joint_parameters.reshape(batch_size, counts.joint_count * 7),
        "local_skeleton_state": local_skeleton.reshape(batch_size, counts.joint_count, 8),
        "global_skeleton_state": global_skeleton.reshape(batch_size, counts.joint_count, 8),
        "rest_surface_pre_corrective": (rest_post - corrective_delta).reshape(
            batch_size, counts.vertex_count, 3
        ),
        "pose_features": pose_features.reshape(batch_size, -1),
        "hidden": hidden.reshape(batch_size, -1),
        "corrective_delta": corrective_delta.reshape(batch_size, counts.vertex_count, 3),
        "rest_surface_post_corrective": rest_post.reshape(batch_size, counts.vertex_count, 3),
        "skin_joint_states": skin_joint_states.reshape(batch_size, counts.joint_count, 8),
        "final_vertices": final_vertices.reshape(batch_size, counts.vertex_count, 3),
    }


def evaluate_portable_stage_outputs(
    lib: ctypes.CDLL,
    model: ctypes.c_void_p,
    data: ctypes.c_void_p,
    counts: MhrModelCounts,
    stage_sizes: dict[str, int],
    raw_inputs: dict[str, np.ndarray],
) -> dict[str, np.ndarray]:
    batch_size = int(raw_inputs["model_parameters"].shape[0])
    if batch_size > 1:
        batches = [
            evaluate_portable_stage_outputs(
                lib,
                model,
                data,
                counts,
                stage_sizes,
                {
                    "model_parameters": raw_inputs["model_parameters"][index : index + 1],
                    "identity": raw_inputs["identity"][index : index + 1],
                    "expression": raw_inputs["expression"][index : index + 1],
                },
            )
            for index in range(batch_size)
        ]
        return {
            stage_name: np.concatenate([batch[stage_name] for batch in batches], axis=0)
            for stage_name in batches[0]
        }

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

    stage_outputs: dict[str, np.ndarray] = {}
    for stage_name, stage_kind in PORTABLE_STAGE_ENUM.items():
        values = np.zeros((stage_sizes[stage_name],), dtype=np.float32)
        check_ok(
            lib.mhr_get_stage_debug(
                model,
                data,
                stage_kind,
                values.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
                values.size,
            ),
            f"mhr_get_stage_debug[{stage_name}]",
            lib.mhr_data_last_error(data),
        )
        if "skeleton" in stage_name or stage_name == "skin_joint_states":
            stage_outputs[stage_name] = values.reshape(batch_size, counts.joint_count, 8)
        elif stage_name in {
            "rest_surface_pre_corrective",
            "corrective_delta",
            "rest_surface_post_corrective",
            "final_vertices",
        }:
            stage_outputs[stage_name] = values.reshape(batch_size, counts.vertex_count, 3)
        elif stage_name == "joint_parameters":
            stage_outputs[stage_name] = values.reshape(batch_size, counts.joint_count * 7)
        else:
            stage_outputs[stage_name] = values.reshape(batch_size, -1)
    return stage_outputs


def evaluate_torchscript_stage_outputs(model, raw_inputs: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    import torch

    with torch.no_grad():
        final_vertices, global_skeleton = model(
            torch.from_numpy(np.ascontiguousarray(raw_inputs["identity"], dtype=np.float32)),
            torch.from_numpy(np.ascontiguousarray(raw_inputs["model_parameters"], dtype=np.float32)),
            torch.from_numpy(np.ascontiguousarray(raw_inputs["expression"], dtype=np.float32)),
        )
    return {
        "global_skeleton_state": global_skeleton.detach().cpu().numpy().astype(np.float32),
        "final_vertices": final_vertices.detach().cpu().numpy().astype(np.float32),
    }


def compare_stage_sets(
    oracle_outputs: dict[str, np.ndarray],
    candidate_outputs: dict[str, np.ndarray],
) -> dict[str, dict[str, Any]]:
    report: dict[str, dict[str, Any]] = {}
    for stage_name, oracle_values in oracle_outputs.items():
        if stage_name not in candidate_outputs:
            continue
        report[stage_name] = compare_float32_arrays(oracle_values, candidate_outputs[stage_name])
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", choices=("portable", "exact", "torchscript"), required=True)
    parser.add_argument("--manifest", required=True, help="processed bundle manifest path")
    parser.add_argument("--cases", default="tests/golden_cases/manifest.json")
    parser.add_argument("--assets", help="override official asset root")
    parser.add_argument("--lod", type=int, default=1)
    parser.add_argument("--build-dir", help="native build dir")
    parser.add_argument("--config", default="Release")
    parser.add_argument("--zero-epsilon", type=float, default=0.0)
    parser.add_argument("--random-batch-size", type=int, default=32)
    parser.add_argument("--random-seed", type=int, default=0)
    parser.add_argument("--out", help="optional report output path")
    args = parser.parse_args()

    os.environ["KMP_DUPLICATE_LIB_OK"] = os.environ.get("KMP_DUPLICATE_LIB_OK", "TRUE")
    root = repo_root_from_here(__file__)
    os.environ["PYTHON_EXE"] = resolve_exact_runtime_python_executable(root)

    processed_manifest = Path(args.manifest).resolve()
    processed_payload = json.loads(processed_manifest.read_text(encoding="utf-8"))
    parameter_metadata = processed_payload["parameterMetadata"]
    stage_sizes = stage_sizes_from_manifest(processed_payload)
    case_inputs = load_cases(
        cases_manifest=Path(args.cases).resolve(),
        parameter_metadata=parameter_metadata,
        random_batch_size=args.random_batch_size,
        random_seed=args.random_seed,
    )

    oracle_model, resolved_assets = load_full_model(root, asset_root=args.assets, lod=args.lod, device="cpu")
    report: dict[str, Any] = {
        "candidate": args.candidate,
        "manifest": str(processed_manifest),
        "assetRoot": str(resolved_assets),
        "lod": args.lod,
        "cases": [],
    }

    if args.candidate == "torchscript":
        torchscript_model = load_torchscript_model(resolved_assets)
        for entry in case_inputs:
            oracle_outputs = collect_full_stage_outputs(oracle_model, entry["raw_inputs"])
            candidate_outputs = evaluate_torchscript_stage_outputs(torchscript_model, entry["raw_inputs"])
            report["cases"].append(
                {
                    "id": entry["id"],
                    "kind": entry["kind"],
                    "stages": compare_stage_sets(oracle_outputs, candidate_outputs),
                    "availableStages": sorted(candidate_outputs.keys()),
                }
            )
    else:
        build_dir = Path(args.build_dir).resolve() if args.build_dir else (Path(tempfile.gettempdir()) / "mhr-full-stage-compare")
        library_path = configure_library(root, build_dir, args.config)
        lib = ctypes.CDLL(str(library_path))
        bind_api(lib)
        report["libraryPath"] = str(library_path)

        if args.candidate == "exact":
            processed_view, _processed_keepalive = build_bundle_view(processed_manifest.parent)
            runtime = ctypes.c_void_p(lib.mhr_runtime_create())
            if not runtime.value:
                raise RuntimeError("mhr_runtime_create returned null.")
            try:
                check_ok(
                    lib.mhr_runtime_load_bundle(runtime, ctypes.byref(processed_view)),
                    "mhr_runtime_load_bundle",
                    lib.mhr_runtime_last_error(runtime),
                )
                counts = MhrRuntimeCounts()
                check_ok(
                    lib.mhr_runtime_get_counts(runtime, ctypes.byref(counts)),
                    "mhr_runtime_get_counts",
                    lib.mhr_runtime_last_error(runtime),
                )
                for entry in case_inputs:
                    oracle_outputs = collect_full_stage_outputs(oracle_model, entry["raw_inputs"])
                    candidate_outputs = evaluate_exact_stage_outputs(lib, runtime, counts, stage_sizes, entry["raw_inputs"])
                    report["cases"].append(
                        {
                            "id": entry["id"],
                            "kind": entry["kind"],
                            "stages": compare_stage_sets(oracle_outputs, candidate_outputs),
                            "availableStages": sorted(candidate_outputs.keys()),
                        }
                    )
            finally:
                lib.mhr_runtime_destroy(runtime)
        else:
            with tempfile.TemporaryDirectory(prefix="mhr-full-stage-portable-") as temp_dir:
                runtime_ir_dir = Path(temp_dir) / "runtime_ir"
                compile_runtime_ir(
                    manifest_path=processed_manifest,
                    out_dir=runtime_ir_dir,
                    zero_epsilon=args.zero_epsilon,
                    verify_roundtrip=True,
                    surface_basis_override=extract_full_surface_basis(oracle_model),
                    inverse_bind_pose_override=extract_full_inverse_bind_pose(oracle_model),
                    include_dense_corrective=True,
                )
                runtime_ir_view, _runtime_ir_keepalive = build_bundle_view(runtime_ir_dir)
                portable_model = ctypes.c_void_p(lib.mhr_model_load_ir(ctypes.byref(runtime_ir_view)))
                if not portable_model.value:
                    raise RuntimeError("mhr_model_load_ir returned null.")
                portable_data = ctypes.c_void_p()
                try:
                    portable_data = ctypes.c_void_p(lib.mhr_data_create(portable_model))
                    if not portable_data.value:
                        raise RuntimeError("mhr_data_create returned null.")
                    counts = MhrModelCounts()
                    check_ok(
                        lib.mhr_model_get_counts(portable_model, ctypes.byref(counts)),
                        "mhr_model_get_counts",
                        lib.mhr_model_last_error(portable_model),
                    )
                    for entry in case_inputs:
                        oracle_outputs = collect_full_stage_outputs(oracle_model, entry["raw_inputs"])
                        candidate_outputs = evaluate_portable_stage_outputs(
                            lib,
                            portable_model,
                            portable_data,
                            counts,
                            stage_sizes,
                            entry["raw_inputs"],
                        )
                        report["cases"].append(
                            {
                                "id": entry["id"],
                                "kind": entry["kind"],
                                "stages": compare_stage_sets(oracle_outputs, candidate_outputs),
                                "availableStages": sorted(candidate_outputs.keys()),
                            }
                        )
                finally:
                    if portable_data.value:
                        lib.mhr_data_destroy(portable_data)
                    if portable_model.value:
                        lib.mhr_model_destroy(portable_model)

    output = json.dumps(report, indent=2, sort_keys=True)
    if args.out:
        Path(args.out).resolve().write_text(output, encoding="utf-8")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
