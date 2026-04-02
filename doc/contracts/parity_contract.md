# Parity Contract

This document freezes the reference hierarchy, golden case layout, and
release-facing parity targets for the next implementation phases.

## Reference Hierarchy

1. official MHR full-package CPU oracle for numerical reference across all LoDs
2. native C/C++ runtime for implementation authority
3. wasm runtime for high-consistency alignment to native

Current implementation note:

- the repository now treats the official full-package CPU route as the primary
  correctness oracle for all LoDs
- the released `mhr_model.pt` TorchScript package remains a secondary `lod=1`
  cross-check only; it is not the primary oracle for any non-`lod=1` lane
- the official full-package GPU route is performance-only reference, not the
  primary numerical oracle
- the oracle artifact layout is already aligned to the future native/wasm parity
  harness
- the current native reference harness consumes processed bundle arrays only; it
  does not parse raw official assets directly

## LoD Lanes

### `LOD1 strict lane`

- primary oracle: official full-package CPU
- secondary cross-check: official TorchScript
- target: current strict parity contract, including native exactness and wasm
  alignment to native

### `non-LOD1 operational lane`

- primary oracle: official full-package CPU
- secondary cross-check: none by default
- first-phase gate:
  - official full CPU can run
  - processed bundle can be produced
  - runtime IR can be compiled
  - native / wasm / Play-hosted page can run
  - compare reports exist for vertices / skeleton / derived outputs
- exact parity is not a first-phase requirement outside `lod=1`

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
- official full-package CPU oracle vs full-exact native reference (`lod=1 strict lane`):
  - machine precision on the frozen golden cases
  - operationalized in harness reports as:
    - `max_abs <= 1e-12`
    - `rms <= 1e-13`
- official TorchScript is a `lod=1` cross-check and is not expected to be
  machine-identical to the full-package oracle
- native vs wasm:
  - `max_abs <= 1e-6`
  - `rms <= 1e-7`
- bitwise equality remains the target for preprocessing and discrete metadata
- native exact reference is now expected to sit at machine precision rather than
  the previous `1e-5` class threshold
- non-`lod=1` lanes currently require compare reports and operational correctness;
  exact parity thresholds are deferred until a later phase

## Gate Rule

No native or wasm runtime milestone may claim parity without naming the oracle,
the case, the validated outputs, and the threshold that was checked.

## Current Status

- discrete metadata checks are now exercised by the native harness
- the native reference runtime can load official processed bundles and emit
  per-case artifacts under `local_tools/mhr_parity/ref_native/`
- the native exact reference path now reaches machine precision across all five
  golden cases against the official full-package CPU `lod=1` oracle
- the next correctness migration target is:
  - `official full CPU -> full-exact native -> portable native -> portable wasm`
- the exact path is implemented with:
  - trig: `MKL VML vsSin/vsCos`
  - dense corrective: `cblas_sgemv`
- wasm parity still targets the future portable runtime path, not this
  host-specific exact reference path
