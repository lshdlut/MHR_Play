#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ctypes
import json
import os
from pathlib import Path
from typing import Any

import numpy as np

from build_native import default_build_dir
from local_config import load_local_config, repo_root_from_here, resolve_mhr_asset_root
from mhr_native_harness import (
    MhrRuntimeCounts,
    build_or_locate_library,
    configure_library,
    ensure_ok,
    load_manifest_arrays,
)
from mhr_parity_ablation import compare_arrays, official_outputs
from mhr_reference import build_parameter_metadata, build_raw_inputs, import_torch, load_case_manifest, load_torchscript_model


def read_native_array(
    lib: ctypes.CDLL,
    runtime: ctypes.c_void_p,
    getter_name: str,
    shape: tuple[int, ...],
) -> np.ndarray:
    getter = getattr(lib, getter_name)
    buffer = np.zeros((int(np.prod(shape)),), dtype=np.float32)
    ensure_ok(
        getter(
            runtime,
            buffer.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            buffer.size,
        ),
        lib,
        runtime,
        getter_name,
    )
    return buffer.reshape(shape)


def write_case_dump(case_dir: Path, payload: dict[str, np.ndarray | dict[str, Any]]) -> None:
    case_dir.mkdir(parents=True, exist_ok=True)
    for key, value in payload.items():
        if isinstance(value, np.ndarray):
            np.save(case_dir / f"{key}.npy", value)
        else:
            (case_dir / f"{key}.json").write_text(
                json.dumps(value, indent=2) + "\n",
                encoding="utf-8",
            )


def main() -> int:
    os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--manifest",
        default="local_tools/official_bundle/manifest.json",
        help="processed bundle manifest",
    )
    parser.add_argument(
        "--cases",
        default="tests/golden_cases/manifest.json",
        help="golden case manifest",
    )
    parser.add_argument(
        "--out",
        default="local_tools/mhr_parity/native_stage_probe",
        help="output directory",
    )
    parser.add_argument("--asset-root", help="path to official MHR assets")
    parser.add_argument("--build-dir", help="native build directory")
    parser.add_argument("--config", default="Release", help="native build configuration")
    parser.add_argument("--rebuild", action="store_true", help="rebuild native library before probing")
    args = parser.parse_args()

    repo_root = repo_root_from_here(__file__)
    config = load_local_config(repo_root)
    asset_root = Path(args.asset_root).resolve() if args.asset_root else resolve_mhr_asset_root(repo_root, config)
    if asset_root is None:
        raise SystemExit(
            "Stage probe requires --asset-root or MHR_ASSET_ROOT / .repo_local_config.json."
        )

    manifest_path = Path(args.manifest).resolve()
    manifest, bundle_binding = load_manifest_arrays(manifest_path)
    corrective_chunk = next(chunk for chunk in manifest["chunks"] if chunk["key"] == "correctiveData")
    hidden_count = int(corrective_chunk["shape"][1])
    case_manifest_path = Path(args.cases).resolve()
    case_manifest = load_case_manifest(case_manifest_path)
    cases = case_manifest.get("cases")
    if not isinstance(cases, list) or not cases:
        raise SystemExit("Golden case manifest requires a non-empty cases list.")

    build_dir = Path(args.build_dir).resolve() if args.build_dir else default_build_dir()
    library_path = build_or_locate_library(
        repo_root=repo_root,
        build_dir=build_dir,
        config=args.config,
        rebuild=args.rebuild,
    )

    lib = ctypes.CDLL(str(library_path))
    configure_library(lib)
    runtime = ctypes.c_void_p(lib.mhr_runtime_create())
    if not runtime:
        raise RuntimeError("Failed to create native runtime.")

    out_root = Path(args.out).resolve()
    out_root.mkdir(parents=True, exist_ok=True)

    try:
        ensure_ok(
            lib.mhr_runtime_load_bundle(runtime, ctypes.byref(bundle_binding.view)),
            lib,
            runtime,
            "mhr_runtime_load_bundle",
        )
        counts = MhrRuntimeCounts()
        ensure_ok(
            lib.mhr_runtime_get_counts(runtime, ctypes.byref(counts)),
            lib,
            runtime,
            "mhr_runtime_get_counts",
        )

        model = load_torchscript_model(asset_root)
        torch = import_torch()
        parameter_metadata = build_parameter_metadata(model)

        report = {
            "libraryPath": str(library_path),
            "manifest": str(manifest_path),
            "cases": [],
        }

        for entry in cases:
            if not isinstance(entry, dict):
                raise ValueError("Golden case entries must be objects.")
            case_id = str(entry.get("id", "")).strip()
            case_path = case_manifest_path.parent / str(entry.get("path", "")).strip()
            if not case_id or not case_path.exists():
                raise ValueError(f"Invalid golden case entry: {entry}")
            case_payload = json.loads(case_path.read_text(encoding="utf-8"))
            state_patch = case_payload.get("state", {})
            raw_inputs = build_raw_inputs(parameter_metadata, state_patch)
            official = official_outputs(model, raw_inputs)

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

            native_joint_parameters = read_native_array(
                lib,
                runtime,
                "mhr_runtime_get_joint_parameters",
                (counts.joint_count, 7),
            )
            native_local_skeleton = read_native_array(
                lib,
                runtime,
                "mhr_runtime_get_local_skeleton",
                (counts.joint_count, 8),
            )
            native_rest_vertices = read_native_array(
                lib,
                runtime,
                "mhr_runtime_get_rest_vertices",
                (counts.vertex_count, 3),
            )
            native_pose_features = read_native_array(
                lib,
                runtime,
                "mhr_runtime_get_pose_features",
                (max(counts.joint_count - 2, 0), 6),
            )
            native_hidden = read_native_array(
                lib,
                runtime,
                "mhr_runtime_get_hidden",
                (hidden_count,),
            )
            native_corrective_delta = read_native_array(
                lib,
                runtime,
                "mhr_runtime_get_corrective_delta",
                (counts.vertex_count, 3),
            )
            native_skin_joint_states = read_native_array(
                lib,
                runtime,
                "mhr_runtime_get_skin_joint_states",
                (counts.joint_count, 8),
            )
            native_skeleton = read_native_array(
                lib,
                runtime,
                "mhr_runtime_get_skeleton",
                (counts.joint_count, 8),
            )
            native_vertices = read_native_array(
                lib,
                runtime,
                "mhr_runtime_get_vertices",
                (counts.vertex_count, 3),
            )

            with torch.no_grad():
                official_skin_native_inputs = (
                    model.character_torch.skin_points(
                        torch.from_numpy(native_skeleton[None]),
                        torch.from_numpy(native_rest_vertices[None]),
                    )
                    .detach()
                    .cpu()
                    .numpy()
                    .astype(np.float32)
                )
                official_skin_native_skeleton_official_rest = (
                    model.character_torch.skin_points(
                        torch.from_numpy(native_skeleton[None]),
                        torch.from_numpy(official["rest"]),
                    )
                    .detach()
                    .cpu()
                    .numpy()
                    .astype(np.float32)
                )
                official_skin_official_skeleton_native_rest = (
                    model.character_torch.skin_points(
                        torch.from_numpy(official["globalState"]),
                        torch.from_numpy(native_rest_vertices[None]),
                    )
                    .detach()
                    .cpu()
                    .numpy()
                    .astype(np.float32)
                )

            case_report = {
                "id": case_id,
                "jointParameters": compare_arrays(official["jointParameters"], native_joint_parameters[None]),
                "localState": {
                    "translation": compare_arrays(official["localState"][..., :3], native_local_skeleton[None, ..., :3]),
                    "rotation": compare_arrays(official["localState"][..., 3:7], native_local_skeleton[None, ..., 3:7]),
                    "scale": compare_arrays(official["localState"][..., 7:], native_local_skeleton[None, ..., 7:]),
                },
                "globalState": compare_arrays(official["globalState"], native_skeleton[None]),
                "restVertices": compare_arrays(official["rest"], native_rest_vertices[None]),
                "poseFeatures": compare_arrays(official["poseFeatures"], native_pose_features.reshape(1, -1)),
                "hiddenRelu": compare_arrays(np.maximum(official["hiddenPre"], 0.0), native_hidden.reshape(1, -1)),
                "corrective": compare_arrays(official["corrective"], native_corrective_delta[None]),
                "vertices": compare_arrays(official["vertices"], native_vertices[None]),
                "crossFeed": {
                    "oracleVsOfficialSkinNativeInputs": compare_arrays(
                        official["vertices"],
                        official_skin_native_inputs,
                    ),
                    "oracleVsOfficialSkinNativeSkeletonOfficialRest": compare_arrays(
                        official["vertices"],
                        official_skin_native_skeleton_official_rest,
                    ),
                    "oracleVsOfficialSkinOfficialSkeletonNativeRest": compare_arrays(
                        official["vertices"],
                        official_skin_official_skeleton_native_rest,
                    ),
                    "officialSkinNativeInputsVsNativeFinal": compare_arrays(
                        official_skin_native_inputs,
                        native_vertices[None],
                    ),
                },
            }
            report["cases"].append(case_report)
            write_case_dump(
                out_root / case_id,
                {
                    "joint_parameters": native_joint_parameters,
                    "local_skeleton": native_local_skeleton,
                    "rest_vertices": native_rest_vertices,
                    "pose_features": native_pose_features,
                    "hidden": native_hidden,
                    "corrective_delta": native_corrective_delta,
                    "skin_joint_states": native_skin_joint_states,
                    "skeleton": native_skeleton,
                    "vertices": native_vertices,
                    "report": case_report,
                },
            )

        (out_root / "report.json").write_text(
            json.dumps(report, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"Wrote native stage probe to {out_root}")
        return 0
    finally:
        lib.mhr_runtime_destroy(runtime)


if __name__ == "__main__":
    raise SystemExit(main())
