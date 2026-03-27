# MHR Play Development Plan

## 0. Product Framing

### Goal

Build a production-ready `MHR Play` that can be embedded into a host website as:

- an embed-ready front-end package
- an embed-ready worker/runtime package
- a clear host integration contract

### Delivery Shape

- The front end owns UI, interaction, rendering, and view state.
- The worker owns MHR runtime execution, state evaluation, and `mesh + skeleton` outputs.
- The host website acts as a container and integration layer, not as the place where MHR computation logic lives.

### V1 User Jobs

- inspect the model
- adjust meaningful parameters
- compare `skin / skeleton / both`
- inspect skeleton overlay
- run manual sliders and automatic sweeps

### V1 Success Criteria

- parameters are editable with stable semantics
- the rendered result is visually meaningful and consistent
- runtime execution is wasm-native
- wasm output stays highly aligned with the chosen reference
- the app can be embedded into a host site with a narrow API surface

### Explicit Non-Goals for V1

- a general-purpose body platform
- mixing host-site product logic into `MHR Play`
- solver/fitting productization
- multi-backend unification beyond keeping room for future extension

## 1. Execution Principles

### Contract First

Freeze the product, state, parity, asset, and host contracts before building heavy implementation. Most downstream rework will come from changing these boundaries late.

### Reference First

Treat the runtime as a reference-driven system:

- official Python MHR is the numerical oracle
- native C/C++ runtime is the authoritative implementation reference
- wasm must stay highly aligned with the native runtime

### Embed First

Build `MHR Play` as an embeddable module, not as a site page. Host-site integration should be the final wiring layer, not the place where core architecture decisions are made.

### Asset Pipeline Before UI Polish

The asset preprocessing pipeline and runtime contracts should stabilize before the front end grows rich controls. Otherwise the UI will be built against shifting data semantics.

### Phase Gates

Each milestone must have explicit deliverables and exit criteria. Do not continue to the next heavy stage on verbal agreement alone.

## 2. Milestones and Critical Path

### M0. Repository Bootstrap

#### Purpose

Turn the empty repository into a runnable workspace with the right top-level structure and a minimal engineering baseline.

#### Main Work

- choose the repository shape, ideally close to `mujoco-wasm-play`
- create the initial module layout for `app`, `worker`, `core`, `renderer`, `ui`, `tools`, `tests`, and `doc`
- set up the local dev entrypoint and placeholder build/test commands
- add spec/document locations for contracts and generated artifacts
- define how schemas and protocol artifacts will be generated

#### Deliverables

- repository skeleton
- local development entrypoint
- minimal build/test command surface
- document index for specs and contracts

#### Exit Criteria

- the repo is no longer a single-doc placeholder
- a developer can clone the repo and see where each major concern lives
- schema/protocol generation has an agreed location, even if still stubbed

### M1. Product, State, and Boundary Contracts

#### Purpose

Convert intent into frozen interfaces before runtime work starts.

#### Main Work

- write the `product + architecture charter`
- write the `out of scope` document
- freeze the V1 state layering:
  - global/root
  - pose
  - surface shape
  - skeletal proportion
  - expression
  - raw expert params
- define the default UI parameter model:
  - curated
  - grouped
  - raw
- define default parameter groups such as:
  - `identity`
  - `scale_*`
  - `*_flexible`
  - expression
- define first-class compare modes:
  - skin only
  - skeleton only
  - both
  - reset / preset / sweep
- freeze the initial host and worker responsibilities
- draft the message categories for the worker protocol

#### Deliverables

- `product + architecture charter`
- `out of scope`
- parameter schema
- panel schema
- semantic-to-raw parameter mapping
- worker protocol draft
- typed message schema draft

#### Exit Criteria

- the team can answer “what is the input state?”, “what is the user-facing control model?”, and “what is the host allowed to know?” without ambiguity
- the front end, worker, and runtime boundaries are described in documents, not inferred from future code

### M2. Parity and Asset Contracts

#### Purpose

Freeze what the runtime must match and what assets are allowed to ship.

#### Main Work

- define the parity oracle hierarchy:
  - official Python MHR for numerical tolerance checks
  - native runtime as the implementation authority
  - wasm aligned to native, with bitwise parity where practical
- define required validated outputs:
  - vertices
  - skeleton state
  - selected derived values
- define minimum covered scenarios:
  - neutral
  - skin only
  - skeleton only
  - pose only
  - combined
- define tolerances and release gates
- decide whether V1 ships official assets directly or preprocessed derivatives
- define shipped asset forms and loading assumptions
- define attribution and license handling

#### Deliverables

- parity contract
- golden case list
- asset manifest
- distribution note
- host-side loading assumptions

#### Exit Criteria

- the project has a written answer for “aligned to what?” and “shipping which assets under which assumptions?”
- release-blocking parity expectations are defined before runtime implementation

### M3. Offline Asset Preprocessing Pipeline

#### Purpose

Transform source MHR assets into runtime-friendly, versioned bundles.

#### Main Work

- build the preprocessing pipeline
- define the processed asset format
- output runtime-ready data for:
  - mesh/topology
  - skinning weights
  - bind and inverse-bind data
  - rig transform data
  - blendshape data
  - corrective network weights
  - parameter metadata, names, grouping, and limits
- version the output bundle

#### Deliverables

- preprocessing scripts
- processed asset format spec
- versioned asset bundle

#### Exit Criteria

- runtime-facing code can consume processed assets without depending on ad hoc parsing of source assets
- asset output is reproducible and versioned

### M4. Native Reference Runtime and Parity Harness

#### Purpose

Establish a trustworthy runtime reference before any wasm port.

#### Main Work

- implement the native C/C++ reference evaluator
- cover the minimum forward path:
  - parameter mapping
  - FK / skeleton state
  - rest mesh shape
  - pose corrective
  - LBS
  - mesh + skeleton output
- build the parity test harness
- run the golden cases against the selected oracle(s)

#### Deliverables

- native reference evaluator
- parity harness
- first validated golden outputs

#### Exit Criteria

- native evaluation works end-to-end for the agreed V1 forward path
- golden cases can be executed repeatedly
- wasm work can target a concrete implementation rather than a moving concept

### M5. Wasm Runtime and Final Worker Boundary

#### Purpose

Turn the native reference into a wasm runtime with a stable worker-facing interface.

#### Main Work

- port or compile the runtime to wasm
- expose deterministic runtime evaluation
- define a worker-friendly memory layout
- finalize JS/TS bindings
- implement the worker lifecycle:
  - init runtime
  - load assets
  - set state
  - evaluate
  - return mesh / skeleton / metadata
  - apply presets and sweeps
- finalize diagnostics and error contract

#### Deliverables

- wasm module
- JS/TS bindings
- worker-safe runtime API
- finalized worker protocol
- error contract

#### Exit Criteria

- the worker can execute the full V1 forward path with deterministic outputs
- runtime and worker protocol are frozen enough for front-end integration
- wasm/native parity is measurable through the harness

### M6. Front-End Shell

#### Purpose

Build the actual `MHR Play` application shell around the worker/runtime contract.

#### Main Work

- reuse the organization style of `mujoco-wasm-play` where helpful
- implement the central scene and rendering loop
- build the panel system around the frozen schemas
- support:
  - slider groups
  - compare modes
  - skeleton overlay
  - preset / reset / sweep
- optionally keep a minimal shareable URL/state layer if it remains low-cost

#### Deliverables

- front-end shell
- panel system
- scene integration

#### Exit Criteria

- a user can load the app, manipulate parameters, inspect the model, and switch compare modes
- the front end depends on the worker contract rather than leaking runtime knowledge into the UI layer

### M7. Embed Package and Host Validation

#### Purpose

Package `MHR Play` as a host-ready module and prove that it integrates cleanly.

#### Main Work

- package the front-end entry
- package the worker bundle
- define the initialization API
- define asset configuration input
- provide the minimum host API:
  - mount
  - load model/assets
  - set state / get state
  - resize
  - destroy
- build a minimal demo host page
- validate resource-path handling and version matching

#### Deliverables

- embed package
- host integration guide
- minimal demo host page
- integration checklist

#### Exit Criteria

- a host page can mount and destroy `MHR Play` without internal knowledge of runtime details
- front end, worker, and assets can be version-matched cleanly
- integration assumptions are documented

### M8. Release Readiness Gate

#### Purpose

Turn the project from “working in development” into “safe to launch”.

#### Required Gates

- asset loading is stable
- wasm/runtime initialization is stable
- parity cases pass the agreed threshold
- major parameter groups are usable
- compare modes are usable
- embed into demo host is validated
- license and attribution pages are complete
- critical runtime and worker errors are surfaced to the host cleanly

#### Deliverables

- release candidate
- launch checklist
- rollback plan

#### Exit Criteria

- no known release blocker remains open
- launch success and rollback conditions are both explicit

## 3. Recommended Execution Order

The critical path should be:

1. `M0` repository bootstrap
2. `M1` product, state, and boundary contracts
3. `M2` parity and asset contracts
4. `M3` offline asset preprocessing pipeline
5. `M4` native reference runtime and parity harness
6. `M5` wasm runtime and final worker boundary
7. `M6` front-end shell
8. `M7` embed package and host validation
9. `M8` release readiness gate

This is close to the original logic, but with two important corrections:

- add a real bootstrap stage for an empty repository
- move worker protocol drafting earlier, while keeping implementation coupled to the wasm runtime stage

## 4. Natural Parallel Work Blocks

Once `M1` and `M2` are stable, the most natural work streams are:

- parameter schema and panel schema
- asset preprocessing
- parity harness and golden-case generation
- native reference runtime
- wasm runtime
- worker protocol implementation
- front-end shell
- embed packaging

Recommended dependency edges:

- front-end panel work depends on the parameter and panel schemas
- worker protocol implementation depends on the runtime API shape
- wasm parity depends on both native runtime and golden cases
- embed packaging should not finalize before worker and front-end boundaries stabilize

## 5. Suggested First Implementation Slice

The first practical slice should stop after `M0` and the document-heavy portion of `M1`.

#### Why

The repository is currently almost empty. The highest-value early move is to freeze structure and semantics before building runtime code or UI code that will later be rewritten.

#### Recommended Immediate Tasks

- create the initial repository layout
- add a top-level architecture index
- write the charter, scope, and state-schema docs
- write the initial worker protocol draft
- decide where generated schema/protocol artifacts live
- add placeholder test and tooling entrypoints

#### Expected Output of the First Slice

- a non-empty, navigable repository
- contract docs that can be reviewed before implementation
- enough structure to start `M3` and `M4` without guessing

## 6. Main Risks and Early Decision Points

### Asset and License Ambiguity

If the project does not freeze what asset form is allowed to ship, implementation may move ahead on a path that cannot be released.

### Parameter Taxonomy Churn

If semantic grouping is not stabilized early, both the UI and the worker API will churn.

### Reference Drift

If the official Python reference, native runtime, and wasm runtime are not tied together through explicit parity contracts, “close enough” will become subjective and expensive.

### Host Boundary Creep

If host responsibilities are left vague, runtime details will leak into the host site and make embed packaging harder later.

### Runtime Memory/Layout Surprises

If wasm memory layout and worker messaging are designed too late, front-end integration may force awkward copies or protocol redesign.

## 7. Core Product Statement

`MHR Play` is not a website page. It is an embeddable MHR application module with a clear `front-end + worker + asset/runtime contract`, and host-site integration is only the final connection layer.
