#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np

from local_config import (
    load_local_config,
    repo_root_from_here,
    resolve_mhr_asset_root,
    resolve_mhr_reference_root,
)
from mhr_reference import (
    OFFICIAL_ORACLE_KIND,
    build_parameter_metadata,
    import_torch,
    load_official_full_model,
)


FIXTURE_REQUIRED_ARRAY_KEYS = (
    "meshTopology",
    "skinningWeights",
    "skinningIndices",
    "bindMatrices",
    "inverseBindMatrices",
    "rigTransforms",
    "jointParents",
    "parameterTransform",
    "parameterLimits",
    "parameterMaskPose",
    "parameterMaskRigid",
    "parameterMaskScaling",
    "blendshapeData",
    "correctiveData",
    "correctiveSparseIndices",
    "correctiveSparseWeights",
)


def canonical_json_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_hex_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def ensure_numeric_ndarray(array: Any, *, dtype: str | np.dtype | None = None) -> np.ndarray:
    np_array = np.asarray(array)
    if dtype is not None:
        np_array = np_array.astype(dtype, copy=False)
    if np_array.ndim == 0:
        raise ValueError("Chunk arrays must be at least rank-1.")
    return np.ascontiguousarray(np_array)


def write_chunk(
    *,
    key: str,
    array: Any,
    out_dir: Path,
    dtype: str | np.dtype | None = None,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    np_array = ensure_numeric_ndarray(array, dtype=dtype)
    file_name = f"{key}.bin"
    chunk_path = out_dir / file_name
    chunk_path.write_bytes(np_array.tobytes(order="C"))
    sha = sha256_hex_bytes(chunk_path.read_bytes())
    chunk = {
        "key": key,
        "file": file_name,
        "dtype": str(np_array.dtype),
        "shape": [int(dim) for dim in np_array.shape],
        "count": int(np_array.size),
        "byteLength": int(chunk_path.stat().st_size),
        "sha256": f"sha256:{sha}",
    }
    if meta:
        chunk["meta"] = meta
    return chunk


def build_manifest(
    *,
    bundle_id: str,
    source_id: str,
    model_version: str,
    lod: int,
    parameter_metadata: dict[str, Any],
    chunks: list[dict[str, Any]],
    bundle_profile: str,
) -> dict[str, Any]:
    canonical_meta = canonical_json_bytes(
        {
            "bundleProfile": bundle_profile,
            "sourceId": source_id,
            "modelVersion": model_version,
            "lod": int(lod),
            "parameterMetadata": parameter_metadata,
            "chunks": chunks,
        }
    )
    bundle_fingerprint = sha256_hex_bytes(canonical_meta)
    return {
        "bundleSchema": "mhr-processed-bundle/v1",
        "schemaVersion": 1,
        "bundleProfile": bundle_profile,
        "bundleId": bundle_id,
        "sourceId": source_id,
        "modelVersion": model_version,
        "lod": int(lod),
        "bundleFingerprint": f"sha256:{bundle_fingerprint}",
        "parameterMetadata": parameter_metadata,
        "chunks": chunks,
    }


def load_fixture_source(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Fixture source must be a JSON object.")
    return payload


def validate_fixture_source(source: dict[str, Any]) -> None:
    for key in ("bundleId", "sourceId", "modelVersion", "parameterMetadata"):
        if key not in source:
            raise ValueError(f"Missing required fixture source field: {key}")
    if not isinstance(source["parameterMetadata"], dict):
        raise ValueError("Fixture parameterMetadata must be an object.")
    for key in FIXTURE_REQUIRED_ARRAY_KEYS:
        if key not in source:
            raise ValueError(f"Missing required fixture array block: {key}")


def encode_fixture_chunk(key: str, block: dict[str, Any], out_dir: Path) -> dict[str, Any]:
    dtype = str(block.get("dtype", "")).strip()
    shape = block.get("shape")
    if not dtype:
        raise ValueError(f"{key}: dtype is required")
    if not isinstance(shape, list) or not shape:
        raise ValueError(f"{key}: shape must be a non-empty list")
    expected_count = int(np.prod(np.asarray(shape, dtype=np.int64)))
    values = block.get("values")
    if values is not None:
        if not isinstance(values, list):
            raise ValueError(f"{key}: values must be a list")
        if expected_count != len(values):
            raise ValueError(f"{key}: expected {expected_count} values, got {len(values)}")
        array = np.asarray(values, dtype=dtype).reshape(shape)
    else:
        fill_value = block.get("fill", 0)
        array = np.full(shape, fill_value, dtype=dtype)
        entries = block.get("entries", [])
        if not isinstance(entries, list):
            raise ValueError(f"{key}: entries must be a list")
        for entry in entries:
            if not isinstance(entry, dict):
                raise ValueError(f"{key}: sparse entries must be objects")
            coordinates = entry.get("at")
            if not isinstance(coordinates, list) or len(coordinates) != len(shape):
                raise ValueError(f"{key}: sparse entry must provide full coordinates")
            index = tuple(int(value) for value in coordinates)
            if any(value < 0 or value >= int(shape[dim]) for dim, value in enumerate(index)):
                raise ValueError(f"{key}: sparse entry index out of bounds: {coordinates}")
            array[index] = entry.get("value", fill_value)
    return write_chunk(key=key, array=array, out_dir=out_dir)


def preprocess_fixture(source_path: Path, out_dir: Path) -> dict[str, Any]:
    source = load_fixture_source(source_path)
    validate_fixture_source(source)
    chunks = [
        encode_fixture_chunk(key, source[key], out_dir) for key in FIXTURE_REQUIRED_ARRAY_KEYS
    ]
    return build_manifest(
        bundle_id=source["bundleId"],
        source_id=source["sourceId"],
        model_version=source["modelVersion"],
        lod=int(source.get("lod", 1)),
        parameter_metadata=source["parameterMetadata"],
        chunks=chunks,
        bundle_profile="fixture",
    )


def preprocess_official(asset_root: Path, out_dir: Path, lod: int) -> dict[str, Any]:
    torch = import_torch()
    model = load_official_full_model(asset_root, lod=lod)
    parameter_metadata = build_parameter_metadata(model, oracle_kind=OFFICIAL_ORACLE_KIND)
    counts = parameter_metadata["counts"]
    model_parameter_count = counts["modelParameterCount"]
    identity_count = counts["identityCount"]
    expression_count = counts["expressionCount"]

    faces = model.character_torch.mesh.faces.detach().cpu().numpy().astype(np.uint32)
    skinning_indices_np = np.asarray(model.character.skin_weights.index, dtype=np.uint32)
    skinning_weights_np = np.asarray(model.character.skin_weights.weight, dtype=np.float32)
    zero_model_parameters = torch.zeros(
        (1, model_parameter_count + identity_count + expression_count),
        dtype=torch.float32,
    )
    bind_pose = (
        model.character_torch.joint_parameters_to_skeleton_state(
            model.character_torch.model_parameters_to_joint_parameters(zero_model_parameters)
        )
        .detach()
        .cpu()
        .numpy()
        .astype(np.float32)[0]
    )
    inverse_bind_pose = (
        model.character_torch.linear_blend_skinning.inverse_bind_pose.detach()
        .cpu()
        .numpy()
        .astype(np.float32)
    )
    joint_translation_offsets = (
        model.character_torch.skeleton.joint_translation_offsets.detach()
        .cpu()
        .numpy()
        .astype(np.float32)
    )
    joint_prerotations = (
        model.character_torch.skeleton.joint_prerotations.detach()
        .cpu()
        .numpy()
        .astype(np.float32)
    )
    rig_transforms = np.concatenate([joint_translation_offsets, joint_prerotations], axis=1)
    joint_parents = model.character_torch.skeleton.joint_parents.detach().cpu().numpy().astype(np.int32)
    parameter_transform = (
        model.character_torch.parameter_transform.parameter_transform.detach()
        .cpu()
        .numpy()
        .astype(np.float32)
    )
    parameter_limit_min, parameter_limit_max = model.character.model_parameter_limits
    parameter_limits = np.ascontiguousarray(
        np.stack(
            [
                np.asarray(parameter_limit_min, dtype=np.float32).reshape(-1),
                np.asarray(parameter_limit_max, dtype=np.float32).reshape(-1),
            ],
            axis=1,
        )
    )
    parameter_mask_pose = (
        model.character_torch.parameter_transform.pose_parameters.detach()
        .cpu()
        .numpy()
        .astype(np.uint8)
    )
    parameter_mask_rigid = (
        model.character_torch.parameter_transform.rigid_parameters.detach()
        .cpu()
        .numpy()
        .astype(np.uint8)
    )
    parameter_mask_scaling = (
        model.character_torch.parameter_transform.scaling_parameters.detach()
        .cpu()
        .numpy()
        .astype(np.uint8)
    )
    base_shape = model.character_torch.blend_shape.base_shape.detach().cpu().numpy().astype(np.float32)
    all_blend_shapes = model.character_torch.blend_shape.shape_vectors.detach().cpu().numpy().astype(np.float32)
    identity_shapes = all_blend_shapes[:identity_count]
    expression_shapes = all_blend_shapes[identity_count : identity_count + expression_count]
    blendshape_data = np.concatenate(
        [base_shape[None, :, :], identity_shapes, expression_shapes],
        axis=0,
    )

    if model.pose_correctives_model is None:
        raise RuntimeError("Official full CPU model did not load pose corrective weights.")
    pose_predictor = model.pose_correctives_model.pose_dirs_predictor
    sparse_layer = getattr(pose_predictor, "0")
    dense_layer = getattr(pose_predictor, "2")
    corrective_sparse_indices = sparse_layer.sparse_indices.detach().cpu().numpy().astype(np.int64)
    corrective_sparse_weights = sparse_layer.sparse_weight.detach().cpu().numpy().astype(np.float32)
    corrective_dense_weights = dense_layer.weight.detach().cpu().numpy().astype(np.float32)

    parameter_metadata["oracle"] = OFFICIAL_ORACLE_KIND
    parameter_metadata["jointNames"] = list(model.character.skeleton.joint_names)
    parameter_metadata["counts"].update(
        {
            "vertexCount": int(base_shape.shape[0]),
            "faceCount": int(faces.shape[0]),
            "jointCount": int(bind_pose.shape[0]),
            "maxInfluenceCount": int(skinning_weights_np.shape[1]),
            "blendshapeSliceCount": int(blendshape_data.shape[0]),
            "correctiveDenseShape": [int(dim) for dim in corrective_dense_weights.shape],
            "correctiveSparseEntryCount": int(corrective_sparse_weights.shape[0]),
        }
    )
    parameter_metadata["topology"] = {
        "vertexCount": int(base_shape.shape[0]),
        "faceCount": int(faces.shape[0]),
    }
    parameter_metadata["chunkLayout"] = {
        "rigTransforms": {
            "fields": ["translationOffsetX", "translationOffsetY", "translationOffsetZ", "preRotationX", "preRotationY", "preRotationZ", "preRotationW"],
        },
        "blendshapeData": {
            "baseSlice": [0, 1],
            "identitySlice": [1, 1 + identity_count],
            "expressionSlice": [1 + identity_count, 1 + identity_count + expression_count],
        },
        "correctiveData": {
            "denseWeightKey": "correctiveData",
            "sparseIndexKey": "correctiveSparseIndices",
            "sparseWeightKey": "correctiveSparseWeights",
        },
        "skinning": {
            "weightKey": "skinningWeights",
            "indexKey": "skinningIndices",
        },
    }

    chunks = [
        write_chunk(key="meshTopology", array=faces, out_dir=out_dir, dtype=np.uint32),
        write_chunk(key="skinningWeights", array=skinning_weights_np, out_dir=out_dir, dtype=np.float32),
        write_chunk(key="skinningIndices", array=skinning_indices_np, out_dir=out_dir, dtype=np.uint32),
        write_chunk(key="bindMatrices", array=bind_pose, out_dir=out_dir, dtype=np.float32),
        write_chunk(key="inverseBindMatrices", array=inverse_bind_pose, out_dir=out_dir, dtype=np.float32),
        write_chunk(key="rigTransforms", array=rig_transforms, out_dir=out_dir, dtype=np.float32),
        write_chunk(key="jointParents", array=joint_parents, out_dir=out_dir, dtype=np.int32),
        write_chunk(key="parameterTransform", array=parameter_transform, out_dir=out_dir, dtype=np.float32),
        write_chunk(key="parameterLimits", array=parameter_limits, out_dir=out_dir, dtype=np.float32),
        write_chunk(key="parameterMaskPose", array=parameter_mask_pose, out_dir=out_dir, dtype=np.uint8),
        write_chunk(key="parameterMaskRigid", array=parameter_mask_rigid, out_dir=out_dir, dtype=np.uint8),
        write_chunk(key="parameterMaskScaling", array=parameter_mask_scaling, out_dir=out_dir, dtype=np.uint8),
        write_chunk(key="blendshapeData", array=blendshape_data, out_dir=out_dir, dtype=np.float32),
        write_chunk(key="correctiveData", array=corrective_dense_weights, out_dir=out_dir, dtype=np.float32),
        write_chunk(key="correctiveSparseIndices", array=corrective_sparse_indices, out_dir=out_dir, dtype=np.int64),
        write_chunk(key="correctiveSparseWeights", array=corrective_sparse_weights, out_dir=out_dir, dtype=np.float32),
    ]

    return build_manifest(
        bundle_id=f"official-mhr-lod{lod}-processed",
        source_id="official-mhr-full-package",
        model_version=f"official-mhr/full-package-lod{lod}",
        lod=lod,
        parameter_metadata=parameter_metadata,
        chunks=chunks,
        bundle_profile="full",
    )


def write_manifest_file(manifest: dict[str, Any], out_dir: Path) -> Path:
    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", help="path to the fixture JSON source")
    parser.add_argument(
        "--source-kind",
        choices=("fixture", "official"),
        help="preprocess from a fixture JSON or from official MHR assets",
    )
    parser.add_argument("--asset-root", help="path to official MHR assets")
    parser.add_argument("--ref-root", help="path to official MHR reference repo")
    parser.add_argument("--lod", type=int, default=1, help="target LOD for official assets")
    parser.add_argument("--out", required=True, help="output directory for the processed bundle")
    args = parser.parse_args()

    repo_root = repo_root_from_here(__file__)
    config = load_local_config(repo_root)
    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    source_kind = args.source_kind or ("fixture" if args.source else "official")
    if source_kind == "fixture":
        if not args.source:
            raise SystemExit("--source is required for fixture preprocessing.")
        manifest = preprocess_fixture(Path(args.source).resolve(), out_dir)
    else:
        ref_root = Path(args.ref_root).resolve() if args.ref_root else resolve_mhr_reference_root(repo_root, config)
        asset_root = Path(args.asset_root).resolve() if args.asset_root else resolve_mhr_asset_root(repo_root, config)
        if asset_root is None:
            raise SystemExit(
                "Official preprocessing requires --asset-root or MHR_ASSET_ROOT / .repo_local_config.json."
            )
        manifest = preprocess_official(asset_root, out_dir, lod=args.lod)
        if ref_root is not None:
            manifest["sourceReferenceRoot"] = str(ref_root)

    manifest_path = write_manifest_file(manifest, out_dir)
    print(f"Wrote {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
