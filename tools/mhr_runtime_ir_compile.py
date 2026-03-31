#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np

from mhr_asset_preprocess import canonical_json_bytes, sha256_hex_bytes, write_chunk


DTYPE_MAP: dict[str, Any] = {
    "float32": np.float32,
    "uint32": np.uint32,
    "int32": np.int32,
    "int64": np.int64,
    "uint8": np.uint8,
}

STAT_KEYS = ("min", "median", "p95", "max")


def load_manifest(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Processed bundle manifest must be a JSON object.")
    return payload


def chunk_lookup(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    chunks = manifest.get("chunks")
    if not isinstance(chunks, list):
        raise ValueError("Processed bundle manifest must provide a chunks array.")
    lookup: dict[str, dict[str, Any]] = {}
    for chunk in chunks:
        if not isinstance(chunk, dict) or "key" not in chunk:
            raise ValueError("Each chunk entry must be an object with a key.")
        lookup[str(chunk["key"])] = chunk
    return lookup


def load_chunk_array(manifest_dir: Path, chunk: dict[str, Any]) -> np.ndarray:
    dtype_name = str(chunk["dtype"])
    if dtype_name not in DTYPE_MAP:
        raise ValueError(f"Unsupported chunk dtype: {dtype_name}")
    shape = [int(dim) for dim in chunk["shape"]]
    raw = np.frombuffer((manifest_dir / str(chunk["file"])).read_bytes(), dtype=DTYPE_MAP[dtype_name])
    return np.ascontiguousarray(raw.reshape(shape))


def nnz_stats(counts: np.ndarray) -> dict[str, int]:
    if counts.size == 0:
        return {key: 0 for key in STAT_KEYS}
    return {
        "min": int(np.min(counts)),
        "median": int(np.median(counts)),
        "p95": int(np.percentile(counts, 95)),
        "max": int(np.max(counts)),
    }


def dense_to_csr(matrix: np.ndarray, *, zero_epsilon: float) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict[str, Any]]:
    rows, cols = matrix.shape
    row_ptr = np.zeros((rows + 1,), dtype=np.uint32)
    col_parts: list[np.ndarray] = []
    value_parts: list[np.ndarray] = []
    row_counts = np.zeros((rows,), dtype=np.uint32)
    col_counts = np.zeros((cols,), dtype=np.uint32)
    comparator = np.abs(matrix) > zero_epsilon if zero_epsilon > 0 else matrix != 0

    cursor = 0
    for row_index in range(rows):
        nz_columns = np.nonzero(comparator[row_index])[0].astype(np.uint32, copy=False)
        row_counts[row_index] = int(nz_columns.size)
        if nz_columns.size:
            values = matrix[row_index, nz_columns].astype(np.float32, copy=False)
            col_parts.append(nz_columns)
            value_parts.append(np.ascontiguousarray(values))
            col_counts[nz_columns] += 1
            cursor += int(nz_columns.size)
        row_ptr[row_index + 1] = cursor

    col_index = (
        np.ascontiguousarray(np.concatenate(col_parts))
        if col_parts
        else np.zeros((0,), dtype=np.uint32)
    )
    values = (
        np.ascontiguousarray(np.concatenate(value_parts))
        if value_parts
        else np.zeros((0,), dtype=np.float32)
    )
    total_count = matrix.size
    exact_zero_fraction = 0.0 if total_count == 0 else float((total_count - np.count_nonzero(matrix)) / total_count)
    stats = {
        "rows": int(rows),
        "columns": int(cols),
        "nnz": int(values.size),
        "exactZeroFraction": exact_zero_fraction,
        "rowStats": nnz_stats(row_counts),
        "columnStats": nnz_stats(col_counts),
    }
    return row_ptr, col_index, values, stats


def dense_to_csc(matrix: np.ndarray, *, zero_epsilon: float) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict[str, Any]]:
    rows, cols = matrix.shape
    col_ptr = np.zeros((cols + 1,), dtype=np.uint32)
    row_parts: list[np.ndarray] = []
    value_parts: list[np.ndarray] = []
    col_counts = np.zeros((cols,), dtype=np.uint32)
    row_counts = np.zeros((rows,), dtype=np.uint32)
    comparator = np.abs(matrix) > zero_epsilon if zero_epsilon > 0 else matrix != 0

    cursor = 0
    for col_index in range(cols):
        nz_rows = np.nonzero(comparator[:, col_index])[0].astype(np.uint32, copy=False)
        col_counts[col_index] = int(nz_rows.size)
        if nz_rows.size:
            values = matrix[nz_rows, col_index].astype(np.float32, copy=False)
            row_parts.append(nz_rows)
            value_parts.append(np.ascontiguousarray(values))
            row_counts[nz_rows] += 1
            cursor += int(nz_rows.size)
        col_ptr[col_index + 1] = cursor

    row_index = (
        np.ascontiguousarray(np.concatenate(row_parts))
        if row_parts
        else np.zeros((0,), dtype=np.uint32)
    )
    values = (
        np.ascontiguousarray(np.concatenate(value_parts))
        if value_parts
        else np.zeros((0,), dtype=np.float32)
    )
    total_count = matrix.size
    exact_zero_fraction = 0.0 if total_count == 0 else float((total_count - np.count_nonzero(matrix)) / total_count)
    stats = {
        "rows": int(rows),
        "columns": int(cols),
        "nnz": int(values.size),
        "exactZeroFraction": exact_zero_fraction,
        "rowStats": nnz_stats(row_counts),
        "columnStats": nnz_stats(col_counts),
    }
    return col_ptr, row_index, values, stats


def coo_to_csr(
    row_index: np.ndarray,
    col_index: np.ndarray,
    values: np.ndarray,
    *,
    row_count: int,
    column_count: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict[str, Any]]:
    order = np.lexsort((col_index, row_index))
    sorted_rows = row_index[order].astype(np.uint32, copy=False)
    sorted_cols = col_index[order].astype(np.uint32, copy=False)
    sorted_values = values[order].astype(np.float32, copy=False)

    row_counts = np.bincount(sorted_rows, minlength=row_count).astype(np.uint32, copy=False)
    col_counts = np.bincount(sorted_cols, minlength=column_count).astype(np.uint32, copy=False)
    row_ptr = np.zeros((row_count + 1,), dtype=np.uint32)
    np.cumsum(row_counts, out=row_ptr[1:])

    stats = {
        "rows": int(row_count),
        "columns": int(column_count),
        "nnz": int(sorted_values.size),
        "rowStats": nnz_stats(row_counts),
        "columnStats": nnz_stats(col_counts),
    }
    return (
        np.ascontiguousarray(row_ptr),
        np.ascontiguousarray(sorted_cols),
        np.ascontiguousarray(sorted_values),
        stats,
    )


def block_offsets(count: int, block_width: int) -> np.ndarray:
    if count == 0 or block_width <= 0 or count % block_width != 0:
        return np.zeros((0,), dtype=np.uint32)
    return np.arange(0, count + block_width, block_width, dtype=np.uint32)


def calc_fk_prefix_multiplication_indices(joint_parents: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    joint_parents = np.ascontiguousarray(joint_parents, dtype=np.int32).reshape(-1)
    nr_joints = int(joint_parents.shape[0])
    kinematic_chains: list[list[int]] = []
    for joint_index in range(nr_joints):
        chain = [joint_index]
        parent_index = joint_index
        while joint_parents[parent_index] >= 0:
            parent_index = int(joint_parents[parent_index])
            chain.append(parent_index)
        kinematic_chains.append(chain[::-1])

    level_offsets = [0]
    source_parts: list[np.ndarray] = []
    target_parts: list[np.ndarray] = []
    while True:
        level = len(level_offsets) - 1
        level_source: list[int] = []
        level_target: list[int] = []
        for chain in kinematic_chains:
            index = len(chain) - 1
            current_bit = (index >> level) & 1
            if current_bit:
                level_source.append(chain[index])
                level_target.append(chain[((index >> level) << level) - 1])
        if not level_source:
            break
        source = np.ascontiguousarray(np.asarray(level_source, dtype=np.uint32))
        target = np.ascontiguousarray(np.asarray(level_target, dtype=np.uint32))
        source_parts.append(source)
        target_parts.append(target)
        level_offsets.append(level_offsets[-1] + int(source.size))

    source_indices = (
        np.ascontiguousarray(np.concatenate(source_parts))
        if source_parts
        else np.zeros((0,), dtype=np.uint32)
    )
    target_indices = (
        np.ascontiguousarray(np.concatenate(target_parts))
        if target_parts
        else np.zeros((0,), dtype=np.uint32)
    )
    return (
        np.ascontiguousarray(np.asarray(level_offsets, dtype=np.uint32)),
        source_indices,
        target_indices,
    )


def build_block_row_unions(
    col_ptr: np.ndarray,
    row_index: np.ndarray,
    *,
    block_count: int,
    block_width: int,
) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    offsets = np.zeros((block_count + 1,), dtype=np.uint32)
    block_parts: list[np.ndarray] = []
    row_counts = np.zeros((block_count,), dtype=np.uint32)
    cursor = 0

    for block_index in range(block_count):
        union_rows: set[int] = set()
        for hidden_index in range(block_index * block_width, (block_index + 1) * block_width):
            start = int(col_ptr[hidden_index])
            end = int(col_ptr[hidden_index + 1])
            union_rows.update(int(value) for value in row_index[start:end])
        block_rows = np.asarray(sorted(union_rows), dtype=np.uint32)
        row_counts[block_index] = int(block_rows.size)
        if block_rows.size:
            block_parts.append(block_rows)
            cursor += int(block_rows.size)
        offsets[block_index + 1] = cursor

    block_rows = (
        np.ascontiguousarray(np.concatenate(block_parts))
        if block_parts
        else np.zeros((0,), dtype=np.uint32)
    )
    stats = {
        "blockCount": int(block_count),
        "rowStats": nnz_stats(row_counts),
    }
    return offsets, block_rows, stats


def reconstruct_csr(row_ptr: np.ndarray, col_index: np.ndarray, values: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    dense = np.zeros(shape, dtype=np.float32)
    for row_index in range(shape[0]):
        start = int(row_ptr[row_index])
        end = int(row_ptr[row_index + 1])
        dense[row_index, col_index[start:end]] = values[start:end]
    return dense


def reconstruct_csc(col_ptr: np.ndarray, row_index: np.ndarray, values: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    dense = np.zeros(shape, dtype=np.float32)
    for col_index in range(shape[1]):
        start = int(col_ptr[col_index])
        end = int(col_ptr[col_index + 1])
        dense[row_index[start:end], col_index] = values[start:end]
    return dense


def build_ir_manifest(
    *,
    source_manifest: dict[str, Any],
    parameter_metadata: dict[str, Any],
    counts: dict[str, int],
    layout: dict[str, Any],
    analysis: dict[str, Any],
    chunks: list[dict[str, Any]],
) -> dict[str, Any]:
    source = {
        "bundleId": source_manifest["bundleId"],
        "bundleSchema": source_manifest["bundleSchema"],
        "sourceId": source_manifest["sourceId"],
        "modelVersion": source_manifest["modelVersion"],
        "bundleFingerprint": source_manifest["bundleFingerprint"],
    }
    payload = {
        "source": source,
        "counts": counts,
        "layout": layout,
        "analysis": analysis,
        "parameterMetadata": parameter_metadata,
        "chunks": chunks,
    }
    ir_fingerprint = sha256_hex_bytes(canonical_json_bytes(payload))
    return {
        "bundleSchema": "mhr-runtime-ir/v1",
        "schemaVersion": 1,
        "irId": f"{source_manifest['bundleId']}-runtime-ir",
        **payload,
        "irFingerprint": f"sha256:{ir_fingerprint}",
    }


def compile_runtime_ir(
    *,
    manifest_path: Path,
    out_dir: Path,
    zero_epsilon: float,
    verify_roundtrip: bool,
    surface_basis_override: np.ndarray | None = None,
    inverse_bind_pose_override: np.ndarray | None = None,
    include_dense_corrective: bool = False,
) -> dict[str, Any]:
    manifest = load_manifest(manifest_path)
    metadata = manifest["parameterMetadata"]
    manifest_dir = manifest_path.parent
    chunk_map = chunk_lookup(manifest)

    mesh_topology = load_chunk_array(manifest_dir, chunk_map["meshTopology"])
    skinning_weights = load_chunk_array(manifest_dir, chunk_map["skinningWeights"])
    skinning_indices = load_chunk_array(manifest_dir, chunk_map["skinningIndices"])
    bind_pose = load_chunk_array(manifest_dir, chunk_map["bindMatrices"])
    inverse_bind_pose = load_chunk_array(manifest_dir, chunk_map["inverseBindMatrices"])
    rig_transforms = load_chunk_array(manifest_dir, chunk_map["rigTransforms"])
    joint_parents = load_chunk_array(manifest_dir, chunk_map["jointParents"])
    parameter_transform = load_chunk_array(manifest_dir, chunk_map["parameterTransform"])
    parameter_limits = load_chunk_array(manifest_dir, chunk_map["parameterLimits"])
    parameter_mask_pose = load_chunk_array(manifest_dir, chunk_map["parameterMaskPose"])
    parameter_mask_rigid = load_chunk_array(manifest_dir, chunk_map["parameterMaskRigid"])
    parameter_mask_scaling = load_chunk_array(manifest_dir, chunk_map["parameterMaskScaling"])
    blendshape_data = load_chunk_array(manifest_dir, chunk_map["blendshapeData"])
    corrective_dense = load_chunk_array(manifest_dir, chunk_map["correctiveData"])
    corrective_sparse_indices = load_chunk_array(manifest_dir, chunk_map["correctiveSparseIndices"])
    corrective_sparse_weights = load_chunk_array(manifest_dir, chunk_map["correctiveSparseWeights"])

    counts_meta = metadata["counts"]
    identity_count = int(counts_meta["identityCount"])
    expression_count = int(counts_meta["expressionCount"])
    model_parameter_count = int(counts_meta["modelParameterCount"])
    if surface_basis_override is not None:
        override = np.ascontiguousarray(surface_basis_override, dtype=np.float32)
        if override.shape != blendshape_data.shape:
            raise ValueError(
                "surface_basis_override shape mismatch: "
                f"expected {blendshape_data.shape}, got {override.shape}"
            )
        blendshape_data = override
    if inverse_bind_pose_override is not None:
        override = np.ascontiguousarray(inverse_bind_pose_override, dtype=np.float32)
        if override.shape != inverse_bind_pose.shape:
            raise ValueError(
                "inverse_bind_pose_override shape mismatch: "
                f"expected {inverse_bind_pose.shape}, got {override.shape}"
            )
        inverse_bind_pose = override
    hidden_count = int(corrective_dense.shape[1])
    pose_feature_count = (
        int(np.max(corrective_sparse_indices[1]) + 1) if corrective_sparse_indices.size else 0
    )

    pose_block_count = 0
    if hidden_count % 24 == 0 and pose_feature_count % 6 == 0 and hidden_count // 24 == pose_feature_count // 6:
        pose_block_count = hidden_count // 24

    param_row_ptr, param_col_index, param_values, param_stats = dense_to_csr(
        parameter_transform,
        zero_epsilon=zero_epsilon,
    )
    pose_row_ptr, pose_feature_index, pose_values, pose_stats = coo_to_csr(
        corrective_sparse_indices[0].astype(np.int64, copy=False),
        corrective_sparse_indices[1].astype(np.int64, copy=False),
        corrective_sparse_weights.astype(np.float32, copy=False),
        row_count=hidden_count,
        column_count=pose_feature_count,
    )
    corrective_col_ptr, corrective_row_index, corrective_values, corrective_stats = dense_to_csc(
        corrective_dense,
        zero_epsilon=zero_epsilon,
    )

    pose_block_feature_offsets = block_offsets(pose_feature_count, 6)
    pose_block_hidden_offsets = block_offsets(hidden_count, 24)
    prefix_mul_level_offsets, prefix_mul_sources, prefix_mul_targets = calc_fk_prefix_multiplication_indices(
        joint_parents
    )
    corrective_block_row_offsets, corrective_block_row_index, corrective_block_stats = build_block_row_unions(
        corrective_col_ptr,
        corrective_row_index,
        block_count=pose_block_count,
        block_width=24,
    )

    if verify_roundtrip:
        if not np.array_equal(
            reconstruct_csr(param_row_ptr, param_col_index, param_values, parameter_transform.shape),
            parameter_transform,
        ):
            raise ValueError("parameterTransform CSR roundtrip check failed.")

        pose_dense = np.zeros((hidden_count, pose_feature_count), dtype=np.float32)
        pose_dense[corrective_sparse_indices[0], corrective_sparse_indices[1]] = corrective_sparse_weights
        if not np.array_equal(
            reconstruct_csr(pose_row_ptr, pose_feature_index, pose_values, (hidden_count, pose_feature_count)),
            pose_dense,
        ):
            raise ValueError("correctiveSparse CSR roundtrip check failed.")

        if not np.array_equal(
            reconstruct_csc(corrective_col_ptr, corrective_row_index, corrective_values, corrective_dense.shape),
            corrective_dense,
        ):
            raise ValueError("correctiveData CSC roundtrip check failed.")

    out_dir.mkdir(parents=True, exist_ok=True)
    chunks = [
        write_chunk(key="meshTopology", array=mesh_topology, out_dir=out_dir, dtype=np.uint32),
        write_chunk(key="skinningWeights", array=skinning_weights, out_dir=out_dir, dtype=np.float32),
        write_chunk(key="skinningIndices", array=skinning_indices, out_dir=out_dir, dtype=np.uint32),
        write_chunk(key="bindPose", array=bind_pose, out_dir=out_dir, dtype=np.float32),
        write_chunk(key="inverseBindPose", array=inverse_bind_pose, out_dir=out_dir, dtype=np.float32),
        write_chunk(key="rigTranslationOffsets", array=rig_transforms[:, :3], out_dir=out_dir, dtype=np.float32),
        write_chunk(key="rigPrerotations", array=rig_transforms[:, 3:7], out_dir=out_dir, dtype=np.float32),
        write_chunk(key="jointParents", array=joint_parents, out_dir=out_dir, dtype=np.int32),
        write_chunk(
            key="prefixMulLevelOffsets",
            array=prefix_mul_level_offsets,
            out_dir=out_dir,
            dtype=np.uint32,
        ),
        write_chunk(key="prefixMulSource", array=prefix_mul_sources, out_dir=out_dir, dtype=np.uint32),
        write_chunk(key="prefixMulTarget", array=prefix_mul_targets, out_dir=out_dir, dtype=np.uint32),
        write_chunk(key="parameterLimits", array=parameter_limits, out_dir=out_dir, dtype=np.float32),
        write_chunk(key="parameterMaskPose", array=parameter_mask_pose, out_dir=out_dir, dtype=np.uint8),
        write_chunk(key="parameterMaskRigid", array=parameter_mask_rigid, out_dir=out_dir, dtype=np.uint8),
        write_chunk(key="parameterMaskScaling", array=parameter_mask_scaling, out_dir=out_dir, dtype=np.uint8),
        write_chunk(key="baseMesh", array=blendshape_data[0], out_dir=out_dir, dtype=np.float32),
        write_chunk(
            key="identityBasis",
            array=blendshape_data[1 : 1 + identity_count],
            out_dir=out_dir,
            dtype=np.float32,
        ),
        write_chunk(
            key="expressionBasis",
            array=blendshape_data[1 + identity_count : 1 + identity_count + expression_count],
            out_dir=out_dir,
            dtype=np.float32,
        ),
        write_chunk(key="parameterTransformRowPtr", array=param_row_ptr, out_dir=out_dir, dtype=np.uint32),
        write_chunk(key="parameterTransformColIndex", array=param_col_index, out_dir=out_dir, dtype=np.uint32),
        write_chunk(key="parameterTransformValues", array=param_values, out_dir=out_dir, dtype=np.float32),
        write_chunk(key="poseHiddenRowPtr", array=pose_row_ptr, out_dir=out_dir, dtype=np.uint32),
        write_chunk(key="poseHiddenFeatureIndex", array=pose_feature_index, out_dir=out_dir, dtype=np.uint32),
        write_chunk(key="poseHiddenValues", array=pose_values, out_dir=out_dir, dtype=np.float32),
        write_chunk(key="correctiveColPtr", array=corrective_col_ptr, out_dir=out_dir, dtype=np.uint32),
        write_chunk(key="correctiveRowIndex", array=corrective_row_index, out_dir=out_dir, dtype=np.uint32),
        write_chunk(key="correctiveValues", array=corrective_values, out_dir=out_dir, dtype=np.float32),
        write_chunk(key="poseBlockFeatureOffsets", array=pose_block_feature_offsets, out_dir=out_dir, dtype=np.uint32),
        write_chunk(key="poseBlockHiddenOffsets", array=pose_block_hidden_offsets, out_dir=out_dir, dtype=np.uint32),
        write_chunk(
            key="correctiveBlockRowOffsets",
            array=corrective_block_row_offsets,
            out_dir=out_dir,
            dtype=np.uint32,
        ),
        write_chunk(
            key="correctiveBlockRowIndex",
            array=corrective_block_row_index,
            out_dir=out_dir,
            dtype=np.uint32,
        ),
    ]
    if include_dense_corrective:
        chunks.append(
            write_chunk(
                key="correctiveDenseFull",
                array=corrective_dense,
                out_dir=out_dir,
                dtype=np.float32,
            )
        )

    counts = {
        "vertexCount": int(skinning_weights.shape[0]),
        "faceCount": int(mesh_topology.shape[0]),
        "jointCount": int(joint_parents.shape[0]),
        "maxInfluenceCount": int(skinning_weights.shape[1]),
        "modelParameterCount": model_parameter_count,
        "identityCount": identity_count,
        "expressionCount": expression_count,
        "parameterInputCount": int(parameter_transform.shape[1]),
        "poseFeatureCount": pose_feature_count,
        "hiddenCount": hidden_count,
    }
    layout = {
        "identityPartitionMode": "unsplit-export",
        "poseFeatureDimPerJoint": 6,
        "hiddenDimPerPoseBlock": 24,
        "poseBlockCount": pose_block_count,
    }
    analysis = {
        "parameterTransform": param_stats,
        "correctiveStage1": pose_stats,
        "correctiveDense": corrective_stats,
        "correctiveBlockRows": corrective_block_stats,
    }
    compiled_manifest = build_ir_manifest(
        source_manifest=manifest,
        parameter_metadata=metadata,
        counts=counts,
        layout=layout,
        analysis=analysis,
        chunks=chunks,
    )
    (out_dir / "manifest.json").write_text(
        json.dumps(compiled_manifest, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    return compiled_manifest


def main() -> None:
    parser = argparse.ArgumentParser(description="Compile a processed MHR bundle into runtime IR.")
    parser.add_argument("--manifest", required=True, help="Path to processed bundle manifest.json")
    parser.add_argument("--out", required=True, help="Output directory for runtime IR bundle")
    parser.add_argument(
        "--zero-epsilon",
        type=float,
        default=0.0,
        help="Treat absolute values <= epsilon as zeros for sparse compilation.",
    )
    parser.add_argument(
        "--verify-roundtrip",
        action="store_true",
        help="Reconstruct sparse-compiled arrays and verify exact roundtrip.",
    )
    args = parser.parse_args()

    manifest = compile_runtime_ir(
        manifest_path=Path(args.manifest).resolve(),
        out_dir=Path(args.out).resolve(),
        zero_epsilon=float(args.zero_epsilon),
        verify_roundtrip=bool(args.verify_roundtrip),
    )
    print(
        json.dumps(
            {
                "bundleSchema": manifest["bundleSchema"],
                "irId": manifest["irId"],
                "counts": manifest["counts"],
                "layout": manifest["layout"],
            },
            indent=2,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
