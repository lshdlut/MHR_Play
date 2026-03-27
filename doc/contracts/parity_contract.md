# Parity Contract

This document freezes the reference hierarchy, golden case layout, and
release-facing parity targets for the next implementation phases.

## Reference Hierarchy

1. official MHR oracle for numerical reference
2. native C/C++ runtime for implementation authority
3. wasm runtime for high-consistency alignment to native

Current implementation note:

- the repository currently emits official oracle outputs through the released
  `mhr_model.pt` TorchScript package because it is available in the local
  offline tooling environment
- the oracle artifact layout is already aligned to the future native/wasm parity
  harness
- the current native reference harness consumes processed bundle arrays only; it
  does not parse raw official assets directly

## Golden Cases

- `neutral`
- `skin_only`
- `skeleton_only`
- `pose_only`
- `combined`

## Required Validated Outputs

- vertices
- skeleton state
- selected derived values used by diagnostics or UI summaries

## Golden Case Layout

- tracked manifest: `tests/golden_cases/manifest.json`
- tracked case definitions: `tests/golden_cases/cases/*.json`
- local oracle outputs: `local_tools/mhr_parity/ref_py/<case>/`
- reserved future outputs:
  - `local_tools/mhr_parity/ref_native/<case>/`
  - `local_tools/mhr_parity/ref_wasm/<case>/`

## Tolerances

- preprocessing fingerprint, discrete metadata, and semantic-to-raw mapping:
  exact match
- official oracle vs native:
  - `max_abs <= 1e-5`
  - `rms <= 1e-6`
- native vs wasm:
  - `max_abs <= 1e-6`
  - `rms <= 1e-7`
- bitwise equality is currently a release target only for preprocessing and
  discrete metadata, not for the full floating-point forward path

## Gate Rule

No native or wasm runtime milestone may claim parity without naming the oracle,
the case, the validated outputs, and the threshold that was checked.

## Current Status

- discrete metadata checks are now exercised by the native harness
- the native reference runtime can load official processed bundles and emit
  per-case artifacts under `local_tools/mhr_parity/ref_native/`
- `neutral`, `skin_only`, and `skeleton_only` now reach machine precision
- the remaining mismatches are localized to two kernels:
  - trig: `std::sin/cos` vs official `MKL VML`
  - dense corrective: handwritten loop vs `cblas_sgemv`
- the current native runtime is parity groundwork, not an exact-parity release
  gate
