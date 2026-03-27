# Semantic to Raw Mapping

This document captures how semantic parameter groups map to runtime-facing raw
parameters.

## Mapping Rules

- Semantic groups are the stable UI entry.
- Raw parameters remain the runtime-facing low-level boundary.
- One semantic group may map to multiple raw keys.
- Raw keys may remain hidden from `curated` while still being available in
  `raw`.

## Frozen State Sections

| State Section | Raw Domain | Rule |
| --- | --- | --- |
| `root` | model parameters | root/global controls such as `root_tx`, `root_ry` |
| `pose` | model parameters | articulation controls that are not `scale_*` or `*_flexible` |
| `skeletalProportion` | model parameters | all `scale_*` and `*_flexible` controls |
| `surfaceShape` | identity coefficients | `blend_*` identity parameters |
| `expression` | expression coefficients | synthetic `expression_<index>` keys |
| `expertRaw` | passthrough | direct raw overrides by name within model / identity / expression domains |

## Current Alias Rules

- `surfaceShape` accepts both official `blend_0` style keys and zero-padded
  aliases such as `blend_00`
- `expression` accepts both `expression_0` and `expression_00`

## Contract Constraint

No downstream implementation may skip this mapping layer and treat raw keys as
the default user-facing taxonomy.
