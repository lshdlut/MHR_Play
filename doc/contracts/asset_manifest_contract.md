# Asset Manifest Contract

Runtime-facing assets are consumed as processed bundles.

## Runtime Rule

The front end and worker must not parse raw official source assets directly in
the bootstrap slice. They consume a processed bundle manifest plus referenced
binary chunks. Runtime-facing loading currently freezes to
`assetConfig.manifestUrl` plus optional `assetConfig.assetBaseUrl`.

## Required Manifest Fields

- `bundleSchema`
- `schemaVersion`
- `bundleId`
- `sourceId`
- `modelVersion`
- `bundleFingerprint`
- `parameterMetadata`
- `chunks`

## Required Chunk Keys

- `meshTopology`
- `skinningWeights`
- `bindMatrices`
- `inverseBindMatrices`
- `rigTransforms`
- `blendshapeData`
- `correctiveData`

## Additional Current Chunk Keys

- `skinningIndices`
- `jointParents`
- `parameterTransform`
- `parameterLimits`
- `parameterMaskPose`
- `parameterMaskRigid`
- `parameterMaskScaling`
- `correctiveSparseIndices`
- `correctiveSparseWeights`
