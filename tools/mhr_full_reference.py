from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np

from local_config import repo_root_from_here, resolve_mhr_asset_root


OFFICIAL_FULL_CPU_ORACLE_KIND = "official-full-cpu"
OFFICIAL_FULL_GPU_PERF_KIND = "official-full-gpu"
OFFICIAL_TORCHSCRIPT_CROSSCHECK_KIND = "official-torchscript-lod1"

STAGE_NAMES = (
    "joint_parameters",
    "local_skeleton_state",
    "global_skeleton_state",
    "rest_surface_pre_corrective",
    "pose_features",
    "hidden",
    "corrective_delta",
    "rest_surface_post_corrective",
    "skin_joint_states",
    "final_vertices",
)


def import_torch():
    try:
        import torch
    except ImportError as error:  # pragma: no cover - depends on local env
        raise RuntimeError(
            "Torch is required for official full-package tooling. "
            "Set PYTHON_EXE to an environment that provides torch."
        ) from error
    return torch


def import_official_full_package():
    try:
        from mhr.mhr import MHR
    except ImportError as error:  # pragma: no cover - depends on local env
        raise RuntimeError(
            "Official full-package tooling requires the `mhr` package. "
            "Install the official MHR package into the PYTHON_EXE environment."
        ) from error
    return MHR


def resolve_official_asset_root(repo_root: Path, explicit_root: str | Path | None = None) -> Path:
    if explicit_root is not None:
        candidate = Path(explicit_root).expanduser().resolve()
        if not candidate.exists():
            raise FileNotFoundError(f"Official asset root not found: {candidate}")
        return candidate
    asset_root = resolve_mhr_asset_root(repo_root)
    if asset_root is None:
        raise FileNotFoundError(
            "Unable to resolve official MHR asset root. Set MHR_ASSET_ROOT or "
            "configure mhr_asset_root in .repo_local_config.json."
        )
    if not asset_root.exists():
        raise FileNotFoundError(f"Official asset root not found: {asset_root}")
    return asset_root


def load_full_model(
    repo_root: Path,
    *,
    asset_root: str | Path | None = None,
    lod: int = 1,
    device: str = "cpu",
):
    torch = import_torch()
    MHR = import_official_full_package()
    resolved_asset_root = resolve_official_asset_root(repo_root, asset_root)
    model = MHR.from_files(folder=resolved_asset_root, device=torch.device(device), lod=lod)
    model.eval()
    return model, resolved_asset_root


def extract_full_surface_basis(model) -> np.ndarray:
    base_shape = np.asarray(model.character.blend_shape.base_shape, dtype=np.float32)
    shape_vectors = np.asarray(model.character.blend_shape.shape_vectors, dtype=np.float32)
    return np.ascontiguousarray(
        np.concatenate([base_shape[None, ...], shape_vectors], axis=0),
        dtype=np.float32,
    )


def extract_full_inverse_bind_pose(model) -> np.ndarray:
    return np.ascontiguousarray(
        np.asarray(model.character_torch.linear_blend_skinning.inverse_bind_pose, dtype=np.float32),
        dtype=np.float32,
    )


def float32_bits(array: np.ndarray) -> np.ndarray:
    values = np.ascontiguousarray(array, dtype=np.float32)
    return values.view(np.uint32)


def compare_float32_arrays(reference: np.ndarray, candidate: np.ndarray) -> dict[str, Any]:
    reference_values = np.ascontiguousarray(reference, dtype=np.float32)
    candidate_values = np.ascontiguousarray(candidate, dtype=np.float32)
    if reference_values.shape != candidate_values.shape:
        raise ValueError(
            f"Shape mismatch: reference={reference_values.shape}, candidate={candidate_values.shape}"
        )
    diff = reference_values.astype(np.float64) - candidate_values.astype(np.float64)
    reference_bits = float32_bits(reference_values).reshape(-1)
    candidate_bits = float32_bits(candidate_values).reshape(-1)
    mismatches = reference_bits != candidate_bits
    mismatch_count = int(np.count_nonzero(mismatches))
    first_mismatch_index = int(np.flatnonzero(mismatches)[0]) if mismatch_count else -1
    return {
        "bitwiseEqual": mismatch_count == 0,
        "mismatchCount": mismatch_count,
        "firstMismatchIndex": first_mismatch_index,
        "maxAbs": float(np.max(np.abs(diff))) if diff.size else 0.0,
        "rms": float(np.sqrt(np.mean(diff * diff))) if diff.size else 0.0,
    }


def build_random_raw_inputs(
    *,
    model_parameter_count: int,
    identity_count: int,
    expression_count: int,
    batch_size: int,
    seed: int,
) -> dict[str, np.ndarray]:
    rng = np.random.default_rng(seed)
    return {
        "identity": np.ascontiguousarray(
            0.8 * rng.standard_normal((batch_size, identity_count), dtype=np.float32),
            dtype=np.float32,
        ),
        "model_parameters": np.ascontiguousarray(
            0.2 * (rng.random((batch_size, model_parameter_count), dtype=np.float32) - 0.5),
            dtype=np.float32,
        ),
        "expression": np.ascontiguousarray(
            0.3 * rng.standard_normal((batch_size, expression_count), dtype=np.float32),
            dtype=np.float32,
        ),
    }


def collect_full_stage_outputs(model, raw_inputs: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    torch = import_torch()
    import pymomentum.skel_state as skel_state

    identity = torch.from_numpy(np.ascontiguousarray(raw_inputs["identity"], dtype=np.float32))
    model_parameters = torch.from_numpy(np.ascontiguousarray(raw_inputs["model_parameters"], dtype=np.float32))
    expression = torch.from_numpy(np.ascontiguousarray(raw_inputs["expression"], dtype=np.float32))
    device = model_parameters.device if model_parameters.is_cuda else next(model.parameters(), identity).device
    identity = identity.to(device)
    model_parameters = model_parameters.to(device)
    expression = expression.to(device)

    with torch.no_grad():
        identity = identity.expand(model_parameters.shape[0], -1)
        coeffs = torch.cat([identity, expression], dim=1)
        rest_pre = model.character_torch.blend_shape.forward(coeffs)

        model_padding = torch.zeros(
            model_parameters.shape[0],
            model.get_num_face_expression_blendshapes() + model.get_num_identity_blendshapes(),
            device=model_parameters.device,
            dtype=model_parameters.dtype,
        )
        joint_parameters = model.character_torch.model_parameters_to_joint_parameters(
            torch.concatenate((model_parameters, model_padding), axis=1)
        )
        local_skeleton = model.character_torch.joint_parameters_to_local_skeleton_state(joint_parameters)
        global_skeleton = model.character_torch.joint_parameters_to_skeleton_state(joint_parameters)

        pose_features = torch.zeros(
            (model_parameters.shape[0], 0),
            device=model_parameters.device,
            dtype=model_parameters.dtype,
        )
        hidden = torch.zeros(
            (model_parameters.shape[0], 0),
            device=model_parameters.device,
            dtype=model_parameters.dtype,
        )
        corrective_delta = torch.zeros_like(rest_pre)
        rest_post = rest_pre

        if model.pose_correctives_model is not None:
            pose_features = model.pose_correctives_model._pose_features_from_joint_params(joint_parameters)
            hidden_linear = model.pose_correctives_model.pose_dirs_predictor[0](pose_features)
            hidden = model.pose_correctives_model.pose_dirs_predictor[1](hidden_linear)
            corrective_delta = model.pose_correctives_model.pose_dirs_predictor[2](hidden).reshape(
                pose_features.shape[0], -1, 3
            )
            rest_post = rest_pre + corrective_delta

        inverse_bind_pose = model.character_torch.linear_blend_skinning.inverse_bind_pose
        while inverse_bind_pose.ndim < global_skeleton.ndim:
            inverse_bind_pose = inverse_bind_pose.unsqueeze(0)
        skin_joint_states = skel_state.multiply(global_skeleton, inverse_bind_pose)
        final_vertices = model.character_torch.skin_points(
            skel_state=global_skeleton,
            rest_vertex_positions=rest_post,
        )

    return {
        "joint_parameters": joint_parameters.detach().cpu().numpy().astype(np.float32),
        "local_skeleton_state": local_skeleton.detach().cpu().numpy().astype(np.float32),
        "global_skeleton_state": global_skeleton.detach().cpu().numpy().astype(np.float32),
        "rest_surface_pre_corrective": rest_pre.detach().cpu().numpy().astype(np.float32),
        "pose_features": pose_features.detach().cpu().numpy().astype(np.float32),
        "hidden": hidden.detach().cpu().numpy().astype(np.float32),
        "corrective_delta": corrective_delta.detach().cpu().numpy().astype(np.float32),
        "rest_surface_post_corrective": rest_post.detach().cpu().numpy().astype(np.float32),
        "skin_joint_states": skin_joint_states.detach().cpu().numpy().astype(np.float32),
        "final_vertices": final_vertices.detach().cpu().numpy().astype(np.float32),
    }


def save_stage_outputs(
    out_dir: Path,
    stage_outputs: dict[str, np.ndarray],
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    for stage_name, values in stage_outputs.items():
        data_path = out_dir / f"{stage_name}.npy"
        bits_path = out_dir / f"{stage_name}.bits.npy"
        np.save(data_path, np.ascontiguousarray(values, dtype=np.float32))
        np.save(bits_path, float32_bits(values))


def write_oracle_manifest(
    out_dir: Path,
    *,
    oracle_kind: str,
    asset_root: Path,
    lod: int,
    cases: list[dict[str, Any]],
    random_batches: list[dict[str, Any]],
) -> None:
    payload = {
        "oracleKind": oracle_kind,
        "assetRoot": str(asset_root),
        "lod": lod,
        "stages": list(STAGE_NAMES),
        "cases": cases,
        "randomBatches": random_batches,
    }
    (out_dir / "manifest.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")


def repo_root() -> Path:
    return repo_root_from_here(__file__)
