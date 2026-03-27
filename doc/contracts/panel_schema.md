# Panel Schema

The UI contract exposes parameters in three tiers:

- `curated`
- `grouped`
- `raw`

## Left Panel

The left panel is the primary editing surface.

### Curated

High-signal user controls for common exploration tasks:

- identity
- body scale families
- flexible parameters
- expression
- compare mode actions

### Grouped

Semantic parameter families grouped by runtime meaning:

- root/global
- pose
- surface shape
- skeletal proportion
- expression

### Raw

Direct parameter access by internal/runtime-facing key.

## Right Panel

The right panel is read-mostly and snapshot-driven.

It surfaces:

- accepted compare mode
- bundle metadata
- evaluation digest
- diagnostics
- selected derived values

## Ownership Rule

Panel rendering consumes UI store state plus backend snapshots. It must not
become a hidden owner of runtime truth.
