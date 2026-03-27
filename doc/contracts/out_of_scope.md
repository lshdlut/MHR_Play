# Out of Scope for the Bootstrap Slice

The current implementation slice is intentionally narrow.

## Not Included

- a production-ready native runtime
- a production-ready wasm runtime
- final renderer semantics for skin, skeleton, or overlays
- plugin surfaces
- environment/lighting ownership outside the current placeholder renderer
- multi-backend support
- fitting, solver, or Jacobian-oriented workflows
- host-site product logic

## Why These Items Stay Out

This slice exists to freeze structure and contracts before runtime-heavy work.
Anything that would force unstable ownership or protocol churn stays deferred.

Current note:

- an initial native reference runtime and parity harness now exist for offline
  validation
- browser runtime ownership and product-facing rendering are still intentionally
  out of scope

## Resulting Constraint

Any new work in this repository must preserve the current architecture
boundaries. If a change requires redefining ownership between bootstrap,
backend, worker, UI state, renderer, or host API, it must first update the
contract documents.
