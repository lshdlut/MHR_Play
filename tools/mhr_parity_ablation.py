#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import numpy as np

from local_config import load_local_config, repo_root_from_here, resolve_mhr_asset_root
from mhr_reference import (
    build_parameter_metadata,
    build_raw_inputs,
    import_torch,
    load_case_manifest,
    load_torchscript_model,
)


def compare_arrays(reference: np.ndarray, candidate: np.ndarray) -> dict[str, float]:
    diff = reference.astype(np.float64) - candidate.astype(np.float64)
    return {
        "maxAbs": float(np.max(np.abs(diff))),
        "rms": float(math.sqrt(float(np.mean(diff * diff)))),
    }


def load_processed_bundle(manifest_path: Path) -> tuple[dict[str, Any], dict[str, np.ndarray]]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    arrays: dict[str, np.ndarray] = {}
    for chunk in manifest["chunks"]:
        chunk_path = manifest_path.parent / str(chunk["file"])
        dtype = np.dtype(str(chunk["dtype"]))
        shape = tuple(int(dim) for dim in chunk["shape"])
        arrays[str(chunk["key"])] = np.fromfile(chunk_path, dtype=dtype).reshape(shape)
    return manifest, arrays


def quat_normalize(q: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(q))
    if norm <= np.finfo(np.float64).eps:
        return np.array([0.0, 0.0, 0.0, 1.0], dtype=np.float64)
    return q / norm


def quat_multiply(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return np.array(
        [
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz,
        ],
        dtype=np.float64,
    )


def rotate_vec_assume_normalized(q: np.ndarray, v: np.ndarray) -> np.ndarray:
    axis = q[:3]
    av = np.cross(axis, v)
    aav = np.cross(axis, av)
    return v + 2.0 * (av * q[3] + aav)


def euler_xyz_quat_native(rx: float, ry: float, rz: float) -> np.ndarray:
    half_x = float(rx) * 0.5
    half_y = float(ry) * 0.5
    half_z = float(rz) * 0.5
    qx = np.array([math.sin(half_x), 0.0, 0.0, math.cos(half_x)], dtype=np.float64)
    qy = np.array([0.0, math.sin(half_y), 0.0, math.cos(half_y)], dtype=np.float64)
    qz = np.array([0.0, 0.0, math.sin(half_z), math.cos(half_z)], dtype=np.float64)
    return quat_multiply(qz, quat_multiply(qy, qx))


def compose_skel_state(parent: tuple[np.ndarray, np.ndarray, float], local: tuple[np.ndarray, np.ndarray, float]) -> tuple[np.ndarray, np.ndarray, float]:
    parent_t, parent_q, parent_s = parent
    local_t, local_q, local_s = local
    parent_q = quat_normalize(parent_q)
    local_q = quat_normalize(local_q)
    translated = rotate_vec_assume_normalized(parent_q, local_t)
    return (
        parent_t + translated * parent_s,
        quat_multiply(parent_q, local_q),
        parent_s * local_s,
    )


def manual_parameter_transform(parameter_transform: np.ndarray, model_parameters: np.ndarray, identity: np.ndarray) -> np.ndarray:
    parameter_inputs = np.concatenate([model_parameters, identity], axis=0).astype(np.float32)
    out = np.zeros((parameter_transform.shape[0],), dtype=np.float32)
    for row in range(out.shape[0]):
        out[row] = np.float32(
            np.dot(
                parameter_transform[row].astype(np.float64),
                parameter_inputs.astype(np.float64),
            )
        )
    return out.reshape(-1, 7)


def manual_local_state_native(joint_parameters: np.ndarray, rig_transforms: np.ndarray) -> np.ndarray:
    local = np.zeros((joint_parameters.shape[0], 8), dtype=np.float32)
    for joint_index in range(joint_parameters.shape[0]):
        joint_values = joint_parameters[joint_index]
        rig_values = rig_transforms[joint_index]
        local[joint_index, :3] = np.array(
            [
                rig_values[0] + joint_values[0],
                rig_values[1] + joint_values[1],
                rig_values[2] + joint_values[2],
            ],
            dtype=np.float32,
        )
        local[joint_index, 3:7] = quat_multiply(
            quat_normalize(rig_values[3:7].astype(np.float64)),
            quat_normalize(
                euler_xyz_quat_native(
                    float(joint_values[3]),
                    float(joint_values[4]),
                    float(joint_values[5]),
                )
            ),
        ).astype(np.float32)
        local[joint_index, 7] = np.float32(2.0 ** float(joint_values[6]))
    return local


def manual_global_state_from_local(local_state: np.ndarray, joint_parents: np.ndarray) -> np.ndarray:
    global_state = np.zeros_like(local_state)
    states: list[tuple[np.ndarray, np.ndarray, float]] = []
    for joint_index in range(local_state.shape[0]):
        local = (
            local_state[joint_index, :3].astype(np.float64),
            local_state[joint_index, 3:7].astype(np.float64),
            float(local_state[joint_index, 7]),
        )
        parent_index = int(joint_parents[joint_index])
        world = local if parent_index < 0 else compose_skel_state(states[parent_index], local)
        states.append(world)
        global_state[joint_index, :3] = world[0].astype(np.float32)
        global_state[joint_index, 3:7] = world[1].astype(np.float32)
        global_state[joint_index, 7] = np.float32(world[2])
    return global_state


def manual_identity_rest_loop(blendshape_data: np.ndarray, identity: np.ndarray) -> np.ndarray:
    rest = blendshape_data[0].astype(np.float32).copy()
    for identity_index, coefficient in enumerate(identity):
        if coefficient == 0.0:
            continue
        rest += blendshape_data[1 + identity_index].astype(np.float32) * coefficient
    return rest


def manual_expression_rest_loop(blendshape_data: np.ndarray, identity_count: int, expression: np.ndarray) -> np.ndarray:
    rest = np.zeros_like(blendshape_data[0], dtype=np.float32)
    start = 1 + identity_count
    for expression_index, coefficient in enumerate(expression):
        if coefficient == 0.0:
            continue
        rest += blendshape_data[start + expression_index].astype(np.float32) * coefficient
    return rest


def manual_pose_features(joint_parameters: np.ndarray) -> np.ndarray:
    joint_count = joint_parameters.shape[0]
    features = np.zeros((max(joint_count - 2, 0), 6), dtype=np.float32)
    for joint_index in range(2, joint_count):
        rx, ry, rz = joint_parameters[joint_index, 3:6]
        cx, cy, cz = np.cos(rx), np.cos(ry), np.cos(rz)
        sx, sy, sz = np.sin(rx), np.sin(ry), np.sin(rz)
        features[joint_index - 2] = np.array(
            [
                cy * cz - 1.0,
                cy * sz,
                -sy,
                -cx * sz + sx * sy * cz,
                cx * cz + sx * sy * sz - 1.0,
                sx * cy,
            ],
            dtype=np.float32,
        )
    return features.reshape(1, -1)


def manual_hidden_and_corrective(
    pose_features: np.ndarray,
    corrective_sparse_indices: np.ndarray,
    corrective_sparse_weights: np.ndarray,
    corrective_dense: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    hidden_pre = np.zeros((1, corrective_dense.shape[1]), dtype=np.float32)
    entry_count = corrective_sparse_weights.shape[0]
    for entry_index in range(entry_count):
        output_index = int(corrective_sparse_indices[0, entry_index])
        input_index = int(corrective_sparse_indices[1, entry_index])
        hidden_pre[0, output_index] += (
            corrective_sparse_weights[entry_index] * pose_features[0, input_index]
        )
    hidden = np.maximum(hidden_pre, 0.0)
    corrective = np.empty((1, corrective_dense.shape[0]), dtype=np.float32)
    for output_index in range(corrective_dense.shape[0]):
        corrective[0, output_index] = np.float32(
            np.dot(
                corrective_dense[output_index].astype(np.float64),
                hidden[0].astype(np.float64),
            )
        )
    return hidden_pre, hidden, corrective.reshape(1, -1, 3)


def exact_skin_torch(global_state: np.ndarray, inverse_bind: np.ndarray, rest_vertices: np.ndarray, skinning_indices: np.ndarray, skinning_weights: np.ndarray) -> np.ndarray:
    torch = import_torch()

    def quat_multiply_t(a: Any, b: Any) -> Any:
        ax, ay, az, aw = a.unbind(-1)
        bx, by, bz, bw = b.unbind(-1)
        return torch.stack(
            [
                aw * bx + ax * bw + ay * bz - az * by,
                aw * by - ax * bz + ay * bw + az * bx,
                aw * bz + ax * by - ay * bx + az * bw,
                aw * bw - ax * bx - ay * by - az * bz,
            ],
            dim=-1,
        )

    def quat_normalize_t(q: Any) -> Any:
        return q / torch.linalg.vector_norm(q, dim=-1, keepdim=True).clamp_min(1e-12)

    def rotate_vec_t(q: Any, v: Any) -> Any:
        q = quat_normalize_t(q)
        axis = q[..., :3]
        av = torch.cross(axis, v, dim=-1)
        aav = torch.cross(axis, av, dim=-1)
        return v + 2.0 * (av * q[..., 3:4] + aav)

    def multiply_state_t(a: Any, b: Any) -> Any:
        at, aq, a_scale = a[..., :3], a[..., 3:7], a[..., 7:8]
        bt, bq, b_scale = b[..., :3], b[..., 3:7], b[..., 7:8]
        aq = quat_normalize_t(aq)
        bq = quat_normalize_t(bq)
        return torch.cat(
            [
                at + a_scale * rotate_vec_t(aq, bt),
                quat_multiply_t(aq, bq),
                a_scale * b_scale,
            ],
            dim=-1,
        )

    def transform_points_t(state: Any, points: Any) -> Any:
        translation = state[..., :3]
        rotation = state[..., 3:7]
        scale = state[..., 7:8]
        return translation + rotate_vec_t(rotation, scale * points)

    global_state_t = torch.from_numpy(global_state[None].astype(np.float32))
    inverse_bind_t = torch.from_numpy(inverse_bind[None].astype(np.float32))
    rest_vertices_t = torch.from_numpy(rest_vertices[None].astype(np.float32))
    flat_joint_indices = torch.from_numpy(skinning_indices.reshape(-1).astype(np.int64))
    flat_weights = torch.from_numpy(skinning_weights.reshape(-1).astype(np.float32))
    vertex_indices = torch.arange(skinning_indices.shape[0], dtype=torch.int64).repeat_interleave(
        skinning_indices.shape[1]
    )
    joint_state = multiply_state_t(
        global_state_t[:, flat_joint_indices],
        inverse_bind_t[:, flat_joint_indices],
    )
    transformed = transform_points_t(
        joint_state,
        rest_vertices_t[:, vertex_indices, :],
    )
    skinned = torch.zeros_like(rest_vertices_t)
    skinned.index_add_(1, vertex_indices, transformed * flat_weights.view(1, -1, 1))
    return skinned.detach().cpu().numpy().astype(np.float32)


def official_outputs(model: Any, raw_inputs: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    torch = import_torch()
    identity = torch.from_numpy(raw_inputs["identity"])
    model_parameters = torch.from_numpy(raw_inputs["model_parameters"])
    expression = torch.from_numpy(raw_inputs["expression"])
    with torch.no_grad():
        joint_parameters = model.character_torch.model_parameters_to_joint_parameters(
            torch.cat([model_parameters, torch.zeros_like(identity)], dim=1)
        )
        joint_parameters_reshaped = joint_parameters.reshape(joint_parameters.shape[0], -1, 7)
        local_state = model.character_torch.skeleton.joint_parameters_to_local_skeleton_state(joint_parameters)
        global_state = model.character_torch.skeleton.local_skeleton_state_to_skeleton_state(local_state)
        identity_rest = model.character_torch.blend_shape(identity)
        expression_rest = model.face_expressions_model(expression)
        corrective = model.pose_correctives_model(joint_parameters)
        rest = identity_rest + expression_rest + corrective
        vertices, _ = model(identity, model_parameters, expression)
        sparse_layer = getattr(model.pose_correctives_model.pose_dirs_predictor, "0")
        hidden_pre = sparse_layer(model.pose_correctives_model._pose_features_from_joint_params(joint_parameters))
    return {
        "jointParameters": joint_parameters_reshaped.detach().cpu().numpy().astype(np.float32),
        "localState": local_state.detach().cpu().numpy().astype(np.float32),
        "globalState": global_state.detach().cpu().numpy().astype(np.float32),
        "identityRest": identity_rest.detach().cpu().numpy().astype(np.float32),
        "expressionRest": expression_rest.detach().cpu().numpy().astype(np.float32),
        "corrective": corrective.detach().cpu().numpy().astype(np.float32),
        "hiddenPre": hidden_pre.detach().cpu().numpy().astype(np.float32),
        "poseFeatures": model.pose_correctives_model._pose_features_from_joint_params(joint_parameters)
        .detach()
        .cpu()
        .numpy()
        .astype(np.float32),
        "rest": rest.detach().cpu().numpy().astype(np.float32),
        "vertices": vertices.detach().cpu().numpy().astype(np.float32),
    }


def run_case(case_id: str, state_patch: dict[str, Any], model: Any, arrays: dict[str, np.ndarray], parameter_metadata: dict[str, Any]) -> dict[str, Any]:
    raw_inputs = build_raw_inputs(parameter_metadata, state_patch)
    official = official_outputs(model, raw_inputs)

    model_parameters = raw_inputs["model_parameters"].reshape(-1).astype(np.float32)
    identity = raw_inputs["identity"].reshape(-1).astype(np.float32)
    expression = raw_inputs["expression"].reshape(-1).astype(np.float32)

    manual_joint_parameters = manual_parameter_transform(
        arrays["parameterTransform"].astype(np.float32),
        model_parameters,
        identity,
    )
    manual_local = manual_local_state_native(manual_joint_parameters, arrays["rigTransforms"].astype(np.float32))
    manual_global = manual_global_state_from_local(
        manual_local,
        arrays["jointParents"].astype(np.int32),
    )
    manual_identity_loop = manual_identity_rest_loop(arrays["blendshapeData"], identity)
    manual_expression_loop = manual_expression_rest_loop(arrays["blendshapeData"], identity.shape[0], expression)
    manual_pose_features_np = manual_pose_features(manual_joint_parameters)
    manual_hidden_pre, manual_hidden, manual_corrective = manual_hidden_and_corrective(
        manual_pose_features_np,
        arrays["correctiveSparseIndices"].astype(np.int64),
        arrays["correctiveSparseWeights"].astype(np.float32),
        arrays["correctiveData"].astype(np.float32),
    )
    manual_rest = manual_identity_loop[None] + manual_expression_loop[None] + manual_corrective
    official_skin_on_manual = exact_skin_torch(
        manual_global,
        arrays["inverseBindMatrices"].astype(np.float32),
        manual_rest[0],
        arrays["skinningIndices"].astype(np.uint32),
        arrays["skinningWeights"].astype(np.float32),
    )
    official_skin_on_manual_skeleton = exact_skin_torch(
        manual_global,
        arrays["inverseBindMatrices"].astype(np.float32),
        official["rest"][0],
        arrays["skinningIndices"].astype(np.uint32),
        arrays["skinningWeights"].astype(np.float32),
    )
    official_skin_on_manual_rest = exact_skin_torch(
        official["globalState"][0],
        arrays["inverseBindMatrices"].astype(np.float32),
        manual_rest[0],
        arrays["skinningIndices"].astype(np.uint32),
        arrays["skinningWeights"].astype(np.float32),
    )

    return {
        "id": case_id,
        "jointParameters": compare_arrays(official["jointParameters"], manual_joint_parameters[None]),
        "localState": {
            "translation": compare_arrays(official["localState"][..., :3], manual_local[None, ..., :3]),
            "rotation": compare_arrays(official["localState"][..., 3:7], manual_local[None, ..., 3:7]),
            "scale": compare_arrays(official["localState"][..., 7:], manual_local[None, ..., 7:]),
        },
        "globalState": compare_arrays(official["globalState"], manual_global[None]),
        "globalFromOfficialLocal": compare_arrays(
            official["globalState"],
            manual_global_state_from_local(official["localState"][0], arrays["jointParents"].astype(np.int32))[None],
        ),
        "rest": {
            "identityLoop": compare_arrays(official["identityRest"], manual_identity_loop[None]),
            "expressionLoop": compare_arrays(official["expressionRest"], manual_expression_loop[None]),
            "poseFeatures": compare_arrays(official["poseFeatures"], manual_pose_features_np),
            "hiddenPre": compare_arrays(official["hiddenPre"], manual_hidden_pre),
            "hiddenRelu": compare_arrays(np.maximum(official["hiddenPre"], 0.0), manual_hidden),
            "corrective": compare_arrays(official["corrective"], manual_corrective),
            "combined": compare_arrays(official["rest"], manual_rest),
        },
        "vertices": {
            "officialSkinOnManualInputs": compare_arrays(official["vertices"], official_skin_on_manual),
            "officialSkinOnManualSkeletonOfficialRest": compare_arrays(official["vertices"], official_skin_on_manual_skeleton),
            "officialSkinOnOfficialSkeletonManualRest": compare_arrays(official["vertices"], official_skin_on_manual_rest),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--manifest",
        default="local_tools/official_bundle/manifest.json",
        help="path to the processed bundle manifest",
    )
    parser.add_argument(
        "--cases",
        default="tests/golden_cases/manifest.json",
        help="path to the golden case manifest",
    )
    parser.add_argument(
        "--out",
        default="local_tools/mhr_parity/ablation_report.json",
        help="output JSON report path",
    )
    parser.add_argument("--asset-root", help="path to official MHR assets")
    args = parser.parse_args()

    repo_root = repo_root_from_here(__file__)
    config = load_local_config(repo_root)
    asset_root = Path(args.asset_root).resolve() if args.asset_root else resolve_mhr_asset_root(repo_root, config)
    if asset_root is None:
        raise SystemExit(
            "Ablation requires --asset-root or MHR_ASSET_ROOT / .repo_local_config.json."
        )

    manifest_path = Path(args.manifest).resolve()
    _, arrays = load_processed_bundle(manifest_path)
    case_manifest_path = Path(args.cases).resolve()
    case_manifest = load_case_manifest(case_manifest_path)
    cases = case_manifest.get("cases")
    if not isinstance(cases, list) or not cases:
        raise SystemExit("Golden case manifest requires a non-empty cases list.")

    model = load_torchscript_model(asset_root)
    parameter_metadata = build_parameter_metadata(model)

    report = {
        "manifest": str(manifest_path),
        "assetRoot": str(asset_root),
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
        report["cases"].append(run_case(case_id, case_payload.get("state", {}), model, arrays, parameter_metadata))

    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote ablation report to {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
