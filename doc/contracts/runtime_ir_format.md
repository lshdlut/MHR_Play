# Runtime IR Format

## Status

Experimental, internal-only, and intended as a compiler target between the current processed bundle
format and a future `mhrModel` / `mhrData` runtime.

This format is not a public host contract.

## Schema

- `bundleSchema`: `mhr-runtime-ir/v1`
- `schemaVersion`: `1`

The IR is compiled from the current `mhr-processed-bundle/v1` bundle and keeps exact semantics
while re-encoding the runtime-critical operators into more direct layouts.

## Manifest Fields

Required top-level fields:

- `bundleSchema`
- `schemaVersion`
- `irId`
- `source`
- `counts`
- `layout`
- `analysis`
- `parameterMetadata`
- `chunks`

### `source`

Describes the originating processed bundle:

- `bundleId`
- `bundleSchema`
- `modelVersion`
- `sourceId`
- `bundleFingerprint`

### `counts`

Runtime-relevant counts:

- `vertexCount`
- `faceCount`
- `jointCount`
- `maxInfluenceCount`
- `modelParameterCount`
- `identityCount`
- `expressionCount`
- `parameterInputCount`
- `poseFeatureCount`
- `hiddenCount`

### `layout`

Compiler decisions and structural facts:

- `identityPartitionMode`
  - currently `unsplit-export`
- `poseFeatureDimPerJoint`
  - currently `6`
- `hiddenDimPerPoseBlock`
  - currently `24`
- `poseBlockCount`
  - derived when the bundle follows the current official layout

### `analysis`

Compiler-emitted sparse statistics used for redesign decisions:

- `parameterTransform`
  - `nnz`
  - `exactZeroFraction`
  - `rowStats`
  - `columnStats`
- `correctiveStage1`
  - `nnz`
  - `rowStats`
  - `columnStats`
- `correctiveDense`
  - `nnz`
  - `exactZeroFraction`
  - `rowStats`
  - `columnStats`
- `correctiveBlockRows`
  - locality stats for block union rows

## Required Chunks

The first IR compiler phase emits these chunks:

- `meshTopology`
- `skinningWeights`
- `skinningIndices`
- `bindPose`
- `inverseBindPose`
- `rigTranslationOffsets`
- `rigPrerotations`
- `jointParents`
- `parameterLimits`
- `parameterMaskPose`
- `parameterMaskRigid`
- `parameterMaskScaling`
- `baseMesh`
- `identityBasis`
- `expressionBasis`
- `parameterTransformRowPtr`
- `parameterTransformColIndex`
- `parameterTransformValues`
- `poseHiddenRowPtr`
- `poseHiddenFeatureIndex`
- `poseHiddenValues`
- `correctiveColPtr`
- `correctiveRowIndex`
- `correctiveValues`
- `poseBlockFeatureOffsets`
- `poseBlockHiddenOffsets`
- `correctiveBlockRowOffsets`
- `correctiveBlockRowIndex`

## Design Notes

### Sparse parameter transform

`parameterTransform` is compiled from dense `[jointCount * 7, parameterInputCount]` into CSR:

- `parameterTransformRowPtr`
- `parameterTransformColIndex`
- `parameterTransformValues`

This preserves exact semantics and removes dense runtime iteration.

### Corrective stage 1

The exported sparse first layer already exposes hidden-unit rows and pose-feature columns. The IR
stores it as CSR by hidden row:

- `poseHiddenRowPtr`
- `poseHiddenFeatureIndex`
- `poseHiddenValues`

### Corrective stage 2

The exported dense second layer is re-encoded as CSC:

- `correctiveColPtr`
- `correctiveRowIndex`
- `correctiveValues`

This preserves exact semantics while making it explicit that the runtime should not treat it as a
true dense operator.

The compiler also emits:

- `correctiveBlockRowOffsets`
- `correctiveBlockRowIndex`

These describe the union of touched output rows per corrective block and act as locality metadata
for a later block-scatter runtime.

## Non-Goals

Runtime IR v1 does not yet:

- expose a final fused per-block scatter kernel
- recover body/head/hands partition labels that are absent from the current export
- define a browser/public-facing format
