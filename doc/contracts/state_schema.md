# State Schema

This document freezes the semantic state layers for the bootstrap slice.

## Top-Level Shape

```json
{
  "root": {},
  "pose": {},
  "surfaceShape": {},
  "skeletalProportion": {},
  "expression": {},
  "expertRaw": {}
}
```

## Layer Semantics

### `root`

Global app and compare-mode state.

Allowed examples:

- `compareMode`
- `activePreset`
- future global view toggles that are still runtime-facing

### `pose`

Pose-driving parameters and joint-level intent.

### `surfaceShape`

Identity and skin-surface parameters that change the visible body shape.

### `skeletalProportion`

Parameters that change skeletal proportion or structural scale.

### `expression`

Face or expression controls when MHR exposes them in the chosen asset/runtime
bundle.

### `expertRaw`

Low-level passthrough values that should not be the default user-facing entry.

## Ownership Rule

The worker owns accepted runtime state. The UI store may hold control drafts,
but the backend snapshot remains the only formal main-thread copy of accepted
runtime state.
