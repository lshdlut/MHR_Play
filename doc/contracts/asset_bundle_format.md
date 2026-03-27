# Asset Bundle Format

The bootstrap slice freezes a processed bundle format of:

- `manifest.json`
- binary chunk files (`*.bin`)

## Why This Format

- worker-friendly memory layout
- deterministic hashing
- avoids a giant JSON payload for numeric arrays

## Chunk Metadata

Each chunk entry carries:

- `key`
- `file`
- `dtype`
- `shape`
- `count`
- `byteLength`
- `sha256`

## Official Bundle Layout

The current official TorchScript export writes:

- `meshTopology`: triangle index buffer
- `skinningWeights` + `skinningIndices`: LBS influences
- `bindMatrices` + `inverseBindMatrices`: joint transform tuples in `[tx, ty, tz, qx, qy, qz, qw, scale]`
- `rigTransforms`: per-joint translation offsets plus prerotation quaternion
- `blendshapeData`: base shape + identity shapes + expression shapes
- `correctiveData`: dense pose-corrective weights
- `correctiveSparseIndices` + `correctiveSparseWeights`: sparse activation layer
- `parameterTransform` and parameter masks/limits needed for semantic-to-raw mapping

## Parameter Metadata

`parameterMetadata` stays in the manifest because it is small, semantic, and
useful to both the worker contract and future UI schema generation. It now
includes:

- counts for vertices, faces, joints, semantic parameter groups, and corrective layout
- semantic parameter descriptors with `domain`, `stateSection`, `tier`, and `rawIndex`
- joint names
- chunk layout notes for blendshape slices, rig transforms, and corrective data
