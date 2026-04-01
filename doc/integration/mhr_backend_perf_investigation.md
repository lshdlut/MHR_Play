# MHR Backend Investigation

## Scope

This note captures the latest outcomes from the March 28, 2026 investigation pass:

- `Fixed Slots` no-clamp experimentation for official `min == max` raw slots.
- Full-official-bundle latency tracing across plugin, backend, worker, wasm, and scene-apply phases.
- Main/worker `debugPing` RTT sampling to separate real transport latency from trace artifacts.

Two measurement environments were used:

- local headless Chromium, for deterministic CI-style collection
- local headed Chromium, for a realistic interaction baseline

Both runs used `mhr.html` with the full official processed bundle (`official-mhr-lod1-processed`).

## Fixed raw slots

The current `Fixed Slots` section exposes these official raw slots:

- `spine0_rx_flexible`
- `spine0_ry_flexible`
- `spine0_rz_flexible`
- `spine1_rx_flexible`
- `spine1_ry_flexible`
- `spine1_rz_flexible`
- `spine2_rx_flexible`
- `spine2_ry_flexible`
- `spine2_rz_flexible`
- `spine3_rx_flexible`
- `spine3_ry_flexible`
- `spine3_rz_flexible`
- `r_clavicle_rx`
- `l_clavicle_rx`
- `r_foot_lean1`
- `l_foot_lean1`
- `l_foot_ry_flexible`
- `l_subtalar_rz_flexible`
- `l_talocrural_rx_flexible`
- `l_ball_rx_flexible`
- `r_foot_ry_flexible`
- `r_subtalar_rz_flexible`
- `r_talocrural_rx_flexible`
- `r_ball_rx_flexible`

They all exist in the official raw schema but ship with `min=max=0` in the current official bundle.

These are not "recommended off" parameters. They are real raw vector slots whose legal range is locked to a constant by the current official model version. They must stay in the schema because downstream arrays (`parameterTransform`, `parameterMaskPose`, `parameterMaskRigid`, `parameterMaskScaling`) depend on a fixed-width raw index layout.

### No-clamp experiment result

`Fixed Slots` now exposes those slots without commit-time clamping.

Observed result for `spine0_rx_flexible = 12.345`:

- UI textbox preserved `12.345`
- worker state preserved `12.345`
- debug raw echo reported `12.345000267028809`
- raw slot index was `6`
- wasm evaluate completed normally

This proves the current browser runtime does **not** silently ignore these locked slots. If UI clamping is bypassed, the value reaches `buildRawInputs`, gets written into the raw vector, and is consumed by wasm. That behavior is unsupported by the official range metadata, but it is real runtime input, not a UI-only illusion.

## Timing setup

Tracing was collected from `tests/perf/mhr_profile_timing.spec.ts` with:

- full official processed bundle
- 30 `surfaceShape` slider samples
- 30 `pose/root` slider samples

The trace currently exports:

- plugin timing
- worker merge/build timing
- wasm bridge timing
- wasm native timing
- main-thread publish/apply/settle timing

## Full bundle timing summary

### Headless Chromium

#### Blend drag

| stage | median ms | p95 ms | max ms |
| --- | ---: | ---: | ---: |
| ui input to flush | 0.0 | 0.1 | 0.1 |
| main to worker setState | 0.1 | 0.2 | 0.3 |
| worker build raw inputs | 0.1 | 0.2 | 0.3 |
| wasm evaluate bridge | 109.5 | 176.2 | 220.7 |
| wasm evaluate core native | 109.5 | 176.2 | 220.7 |
| worker postMessage to main receive | 51.5 | 101.0 | 112.1 |
| main event to geometry start | 0.1 | 0.3 | 0.3 |
| geometry apply | 0.1 | 0.2 | 0.2 |
| normals update | 2.5 | 12.4 | 18.5 |
| first presented after geometry | 2.6 | 5.1 | 5.3 |
| visually settled after geometry | 80.5 | 125.9 | 144.2 |
| end-to-end input to settle | 245.1 | 399.8 | 403.1 |

#### Pose/root drag

| stage | median ms | p95 ms | max ms |
| --- | ---: | ---: | ---: |
| ui input to flush | 0.0 | 0.1 | 0.1 |
| main to worker setState | 0.1 | 0.1 | 0.1 |
| worker build raw inputs | 0.1 | 0.2 | 0.2 |
| wasm evaluate bridge | 108.5 | 118.4 | 132.3 |
| wasm evaluate core native | 108.5 | 118.4 | 132.3 |
| worker postMessage to main receive | 52.6 | 57.0 | 57.1 |
| main event to geometry start | 0.1 | 0.5 | 1.0 |
| geometry apply | 0.1 | 0.1 | 0.2 |
| normals update | 2.3 | 2.7 | 5.4 |
| first presented after geometry | 2.5 | 5.0 | 6.4 |
| visually settled after geometry | 79.0 | 85.6 | 119.0 |
| end-to-end input to settle | 245.2 | 271.3 | 289.4 |

#### Zero-work main/worker ping

| stage | median ms | p95 ms | max ms |
| --- | ---: | ---: | ---: |
| round trip | 85.0 | 120.1 | 120.1 |
| main to worker | 0.0 | 0.1 | 0.1 |
| worker to main | 84.9 | 120.1 | 120.1 |

### Headed Chromium

#### Blend drag

| stage | median ms | p95 ms | max ms |
| --- | ---: | ---: | ---: |
| ui input to flush | 0.0 | 0.1 | 0.2 |
| main to worker setState | 0.2 | 0.3 | 0.4 |
| worker build raw inputs | 0.1 | 0.2 | 0.2 |
| wasm evaluate bridge | 87.2 | 99.5 | 103.8 |
| wasm evaluate core native | 87.2 | 99.5 | 103.7 |
| worker postMessage to main receive | 0.3 | 0.9 | 1.1 |
| main event to geometry start | 1.3 | 1.7 | 1.8 |
| geometry apply | 0.1 | 0.2 | 0.2 |
| normals update | 2.3 | 3.1 | 3.1 |
| first presented after geometry | 1.6 | 5.5 | 6.4 |
| visually settled after geometry | 10.1 | 15.5 | 15.7 |
| end-to-end input to settle | 104.6 | 118.5 | 124.5 |

#### Pose/root drag

| stage | median ms | p95 ms | max ms |
| --- | ---: | ---: | ---: |
| ui input to flush | 0.0 | 0.0 | 0.0 |
| main to worker setState | 0.2 | 0.3 | 0.3 |
| worker build raw inputs | 0.1 | 0.2 | 0.2 |
| wasm evaluate bridge | 95.1 | 100.2 | 100.5 |
| wasm evaluate core native | 95.1 | 100.2 | 100.4 |
| worker postMessage to main receive | 0.2 | 1.1 | 1.3 |
| main event to geometry start | 1.5 | 1.7 | 2.0 |
| geometry apply | 0.1 | 0.1 | 0.2 |
| normals update | 2.7 | 3.1 | 3.2 |
| first presented after geometry | 1.2 | 4.3 | 4.4 |
| visually settled after geometry | 10.3 | 13.7 | 13.9 |
| end-to-end input to settle | 111.5 | 120.0 | 120.8 |

#### Zero-work main/worker ping

| stage | median ms | p95 ms | max ms |
| --- | ---: | ---: | ---: |
| round trip | 0.0 | 0.3 | 0.3 |
| main to worker | 0.0 | 0.1 | 0.1 |
| worker to main | 0.0 | 0.2 | 0.2 |

## Bottleneck ranking

Sorted by median impact in the realistic headed trace:

1. Wasm evaluate core: `~87-95 ms`
2. Double-RAF "visually settled" metric: `~10-14 ms` (measurement artifact, not direct apply cost)
3. Normals recompute: `~2-3 ms`
4. First presented after geometry: `~1-2 ms`
5. Worker to main-thread receive: effectively negligible (`<=1.3 ms`)
6. Raw input build, wasm copy-in/copy-out, geometry upload, and scene apply: effectively negligible (`<=0.2 ms`)

## What this means

### 1. The main bottleneck is **not** raw input building

`buildRawInputs` is effectively free at the current scale. That is not where the drag latency is coming from.

### 2. The main bottleneck is **not** JS<->wasm buffer upload/export either

Current bridge-side copy-in/copy-out is also tiny. Persistent wasm buffers may still be worthwhile, but they are not the first-order problem in the present implementation.

### 3. In a real interactive browser, the dominant cost is now:

- wasm core evaluation itself
- browser frame-settle measurement if you insist on waiting for two RAFs
- normals recompute as a minor tail

### 4. The old plugin debounce was a real bug, and it is now gone

Measured `ui input -> flush` is now `0 ms` median. The earlier `~170 ms` delay was self-inflicted by custom plugin debounce / queue behavior, not by Play itself.

### 5. Geometry upload is cheap; the old "visual settle" number was misleading

Direct position upload is cheap. Normals recompute is noticeable but not dominant. The real "first presented after geometry" cost is only `~2.5 ms`. The larger `~80 ms` number came from an intentionally conservative double-RAF settle marker and should not be treated as direct apply cost.

### 6. The scary `worker->main` number was a headless artifact, not app logic

`main_event_to_geometry_start` is only `~1-2 ms`, which means the main thread starts applying geometry almost immediately once the event is handled.

In headed Chromium, zero-work `debugPing` is effectively `0 ms`, and `worker_post_message_ms` drops to `~0.2-0.3 ms`. The earlier `~50-85 ms` number came from headless browser scheduling, not from our geometry apply code or message shape.

## Backend decisions for the next pass

This investigation is sufficient to drive the next backend redesign.

### Keep or drop `setState + evaluate` as separate messages?

Status: **done for drag-time hot path**.

Drag interactions already use a single combined worker command (`applyStateAndEvaluate(latestPatch)` / interactive latest-wins path), so there is no separate `stateUpdated` phase on the hot path anymore.

### Should `stateUpdated` keep echoing the whole state tree?

Recommendation: **no** for any future hot path.

The interactive drag flow already avoids this. Any future backend cleanup should keep `stateUpdated` out of the hot path and reduce it to revision/ack semantics when it is still needed.

### Are persistent wasm buffers required immediately?

Recommendation: **not first**.

They remain a reasonable optimization, but the current trace shows they are not the dominant cost. Do this after the message/commit model is simplified.

### Do we need a preview path during drag?

Recommendation: **yes**.

Adopt a dual-mode interaction:

- drag: latest-wins preview path, allowed to drop stale evaluations
- pointer-up / blur / Enter: full fidelity evaluate

This matters more than micro-optimizing the current bridge copy path.

### Is a lighter `sikc`-style backend warranted?

Recommendation: **yes, but now for worker-forward reasons first, not UI/transport reasons**.

The current lane was too chatty before the hot-path cleanup, but the latest headed measurements show that most non-forward overhead has already been stripped. The next backend should now be shaped primarily around making the evaluation path cheaper and more preview-friendly:

- single hot-path command for latest patch + evaluate
- revision-based ack instead of full state echo
- ability to discard stale in-flight results
- explicit preview/full-evaluate split
- scene updates that avoid unnecessary work when topology is unchanged

## Immediate next implementation targets

1. Keep the single latest-wins worker command; the old split hot path is already removed.
2. Add preview/full-evaluate split for slider drags so full wasm forward is not paid on every intermediate drag tick.
3. Treat worker-to-main transport as solved for real interactive browsers unless future headed profiling says otherwise.
4. Revisit normals update only after the control/worker path is simplified.
5. Any future `sikc`-style backend redesign should be driven by real interactive browser traces, not headless worker RTT.
