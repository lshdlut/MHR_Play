# MHR Momentum Runtime Redesign

## Goal

Redesign the MHR runtime around an explicit `mhrModel` / `mhrData` split, similar in spirit to
`mjModel` / `mjData`, instead of centering the hot path on TorchScript-exported matrix layouts.

The target runtime is:

- model-centric
- allocation-free in the hot path
- structured around explicit rig, corrective, and skinning stages
- portable to native and wasm

This document describes the intended runtime architecture after re-reading
`Ferguson et al. 2025, MHR Momentum Human Rig`.

## What MHR Is, Computationally

MHR is not best thought of as a monolithic body-model forward pass. It is a Momentum-style rig
system with decoupled skeleton and surface controls:

1. High-level model parameters are linearly transformed into joint-local rig parameters.
2. Local joint transforms are composed from offset, prerotation, translation, rotation, and scale.
3. FK produces world-space joint transforms.
4. Rest-surface deformation is built from base mesh, identity basis, and expression basis.
5. Pose-dependent corrective deformation is applied locally.
6. The final mesh is produced by skinning with the posed skeleton.

The runtime should therefore mirror those operators directly. It should not treat the exported
TorchScript graph or current dense corrective representation as the primary abstraction.

## Why The Current Runtime Center Is Wrong

The current runtime is mathematically valid, but it is organized around export-time bundle
layouts:

- `parameterTransform` is consumed as a generic dense matrix.
- pose correctives are executed as:
  - a sparse first layer
  - followed by a dense global second layer `correctiveData[3V, 3000]`

For the official LOD1 bundle, that second layer is the wrong runtime center:

- `parameterTransform` is about `99.8%` exact zero.
- `correctiveData` is about `97%` exact zero.
- `correctiveSparseIndices` already reveals a joint-local first layer:
  - `750 = 125 * 6`
  - `3000 = 125 * 24`

That means the paper's local corrective structure is still present in the exported data, but it is
flattened into runtime-unfriendly matrices. The redesign should restore the local block structure.

## Target Runtime Objects

### `mhrModel`

`mhrModel` is immutable after load. It owns:

- counts:
  - vertices, faces, joints
  - model parameters, identity parameters, expression parameters
  - pose feature blocks, hidden block sizes, influence counts
- topology:
  - faces
  - skinning indices and weights
- rig rest data:
  - parent tree
  - translation offsets
  - prerotations
  - bind and inverse-bind tuples
- compiled parameter transform IR:
  - sparse dependency tables from high-level controls to joint-local parameters
- compiled surface data:
  - base mesh
  - identity basis
  - expression basis
- compiled pose-corrective IR:
  - per-block input ranges
  - per-block hidden weights
  - per-block target row / vertex locality
- UI / debug metadata:
  - names
  - groups
  - limits
  - raw indices

### `mhrData`

`mhrData` is the per-instance reusable workspace. It owns:

- current high-level controls
- decoded joint-local parameters
- local transforms
- global transforms
- skinning transforms
- pose features
- hidden activations
- rest vertices
- output vertices
- optional normals
- derived/debug outputs

The forward path must not allocate from the heap. All scratch storage is created once when the data
object is instantiated.

## Target Hot Path

The intended runtime order is:

1. Decode high-level parameters into joint-local rig parameters using sparse transform IR.
2. Compose local joint transforms from:
   - offset
   - translation
   - prerotation
   - Euler XYZ rotation
   - uniform scale
3. Run FK.
4. Build skinning transforms.
5. Accumulate rest-surface deformation:
   - base
   - identity
   - expression
6. Build pose features only for the corrective blocks that actually use them.
7. Run local pose-corrective blocks:
   - gather local features
   - small block-local MLP
   - local scatter-add into mesh rows
8. Run LBS.
9. Optionally compute normals / derived outputs.

Normals are not part of the core model forward and should remain optional.

## Exact Path vs Portable Path

The runtime should explicitly keep two paths:

- exact reference path
  - serves parity work
  - may use host-specific math kernels
  - prioritizes matching the official oracle
- portable runtime path
  - serves browser / worker / shipped runtime
  - prioritizes direct structure, sparse execution, and cache locality

Both paths share semantics and stage-level debug outputs, but they do not need identical kernel
implementations.

## Runtime IR Compiler

The redesign depends on an offline compiler step. The compiler should consume the current processed
bundle and emit a runtime-native IR:

- sparse parameter transform IR
- split base / identity / expression basis arrays
- pose-corrective block metadata
- sparse exact representation of the exported second-layer corrective matrix

The first compiler phase does not need to fully fuse the dense second layer into block-local scatter
kernels. It only needs to:

- stop storing it as a dense matrix
- preserve exact semantics
- expose locality metadata per corrective block

This is enough to unblock a later direct C runtime rewrite.

## Important Constraint

The official exported bundle does not currently expose explicit identity partition labels
(`body/head/hands`) as a runtime-ready partition table. The redesign therefore keeps the identity
basis unsplit at the IR layer for now, while documenting that the paper-level semantics are
partitioned.

That means:

- runtime IR v1 should preserve exact identity semantics
- partition-aware refactoring remains a later compiler-stage enhancement

## What This Redesign Should Replace

The redesign should eventually replace:

- generic dense `parameterTransform` evaluation
- generic dense `correctiveData[3V, 3000]` GEMV as the hot-path center
- runtime ownership centered on interpreted bundle arrays

with:

- compiled sparse transform tables
- compiled corrective block IR
- explicit `mhrModel` / `mhrData`
- a fixed forward kernel order
