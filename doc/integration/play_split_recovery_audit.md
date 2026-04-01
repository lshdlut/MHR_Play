# Play Split / Recovery Audit

## Scope

This audit answers a stricter question than the earlier branch-level summary:

- not only "what commits were ahead of `origin/main`",
- but also "which stripped changes were truly MHR product code",
- which were MHR-driven host wiring,
- which were generic host capabilities mixed into those commits, and
- whether any local non-MHR work appears to have been removed from `mujoco-wasm-play/main`.

The audit compares:

- `origin/main`
- `backup/mhr-downstream-before-strip-20260401`

and inspects local recovery signals:

- `git reflog --all`
- `git stash list`
- `git fsck --full --no-reflogs --unreachable --dangling`

## High-level result

1. `mujoco-wasm-play/main` had exactly three local commits above `origin/main` before recovery:
   - `3d34a15` `Add app-owned MHR profile service and runtime plumbing`
   - `b0eaad7` `Polish MHR profile UI and preview interactions`
   - `58468ce` `Add dark theme toggle to MHR control card`
2. Those commits were **not** perfectly pure "MHR-only" commits.
3. They contained four kinds of changes:
   - pure MHR product files,
   - MHR-specific host wiring inserted into shared Play files,
   - generic host capability extensions introduced only because MHR needed them,
   - a small amount of unrelated local hygiene / global host tuning.
4. `mujoco-wasm-play/main` is now restored to `origin/main`.
5. The removed delta is still recoverable from:
   - branch `backup/mhr-downstream-before-strip-20260401`
   - pre-existing stash entries in the Play repo

## Important safety conclusion

The recovery did **not** prove that every removed line was "pure MHR". It only proved that the removed delta was fully contained in the three local commits. Some of those lines were mixed generic host changes and one local hygiene change.

That means:

- `play/main` is clean again,
- but the stripped delta still needs fine-grained review before deciding which generic pieces should be reintroduced elsewhere.

## Detailed classification

### A. Pure MHR product code

These are product-owned and should stay outside the upstream Play working tree:

- `assets/mhr_demo/**`
- `mhr.html`
- `model/mhr_stage.xml`
- `plugins/mhr_profile_plugin.mjs`
- `profiles/mhr/**`
- `doc/mhr_backend_perf_investigation.md`
- `tests/e2e/core/mhr_profile.spec.ts`
- `tests/perf/mhr_profile_timing.spec.ts`

Verdict:

- cleanly stripped from `play/main`
- now hosted by `MHR_Play/mjwp_inject/overlay/**`

### B. MHR-specific host wiring inside shared Play files

These were not generic product files, but they were also clearly introduced only to make the MHR profile boot inside Play:

#### `app/entry_bootstrap.js`

- auto-inject `./plugins/mhr_profile_plugin.mjs` when `profileId === 'mhr'`
- read MHR asset manifest / asset base config
- special panel defaults when `profileId === 'mhr'`

Classification:

- MHR-specific host wiring

#### `app/main.mjs`

- `isMhrProfile`
- default `model/mhr_stage.xml`
- `createMhrService(...)`
- `profileServices.mhr`
- default visual source mode switch to `preset-sun`
- `window.__PLAY_HOST__.extensions.mhr`

Classification:

- MHR-specific host wiring

#### `ui/control_manager.mjs`

- return empty built-in spec when `profileId === 'mhr'`

Classification:

- MHR-specific host wiring

#### `tools/dev_server.py`

- `/mhr-official/` local mount

Classification:

- MHR-specific dev wiring

#### `tests/e2e/test-utils.ts`

- `waitForMhrProfileReady(...)`

Classification:

- MHR-specific test support

Verdict for group B:

- these changes were correctly stripped from upstream `play/main`
- they belong either in downstream MHR assembly or in a later minimal patch set

### C. Generic host capability mixed into the MHR commits

These are the most important mixed items. They are not pure MHR product code, but they first appeared inside the MHR commit range.

#### `app/play_host.mjs`

- add `services` to the public host object

Classification:

- generic host capability
- introduced specifically for MHR service ownership

#### `renderer/pipeline.mjs`

- add `labelOverlay` subscription lane

Classification:

- generic renderer host capability
- introduced only because MHR needed label overlay access

#### `renderer/controllers.mjs`

- add configurable `primaryDragMode`

Classification:

- generic camera-controller capability
- introduced in the MHR commit range

#### `backend/backend_core.mjs`

- add `setSnapshotHz(...)` to backend surface

Classification:

- generic backend capability
- introduced because MHR profile wanted alternate snapshot cadence behavior

#### `worker/physics.worker.mjs`

- extend snapshot tiers from `[30, 60, 120]` to `[1, 5, 15, 30, 60, 120]`

Classification:

- generic worker capability change
- introduced to support the MHR-side snapshot cadence path

#### `core/runtime_config.mjs`

- add `assetConfig`
- propagate `data-play-profile`

Classification:

- generic runtime-config surface, but added only to support MHR profile assembly

Verdict for group C:

- these were removed from upstream `play/main` together with the MHR strip
- they are **not lost**, because they remain recoverable from `backup/mhr-downstream-before-strip-20260401`
- they need a separate decision:
  - either reintroduce as minimal generic downstream patches owned by `MHR_Play`
  - or redesign the downstream integration to avoid needing them

### D. Mixed local hygiene / global tuning

These are the clearest examples of "not pure MHR".

#### `.gitignore`

- added `/.agents_arena/`

Classification:

- local repo hygiene
- not MHR product logic

#### `environment/environment.mjs`

- changed the shared `sun` preset:
  - weaker directional light
  - different ambient/fill values
  - pure white ground
  - no textured ground surface

Classification:

- global visual tuning
- motivated by MHR presentation work
- not MHR-specific in scope, because it changes the shared environment preset itself

Verdict for group D:

- yes, these were mixed into the MHR strip
- yes, they were removed from upstream `play/main`
- no, they are not irrecoverably lost; they remain in the backup branch

## Evidence about local non-MHR work outside the three commits

The Play repo already had pre-existing local recovery signals unrelated to the MHR split:

### Branches

- `backup/pre-reset-1a639fe`
- `backup/pre-split-c8a64a9-20260302`
- `feature/haze-overlay-wip`
- `feature/mjwf-337-export-surface`
- `clean-upgrade`
- others

These were **not touched** by the recovery.

### Stashes

Current stash list includes:

- `stash@{0}` `On main: pre-reset to HEAD~1`
- `stash@{1}` `WIP on clean-upgrade: 9b550da ...`
- `stash@{2}` `On (no branch): pre-revert-20251110-112547`
- `stash@{3}` `On main: local-wip-`
- `stash@{4}` `On main: local-wip-20251030-134204`

Notable file scopes inside those stashes include:

- old `dev/*` viewer / worker work
- older `src/*` / `tests/*` work from a prior repo layout

These signals show that the repo already contained preserved local work outside the three stripped commits. The split/recovery did not delete those references.

### Unreachable / dangling objects

`git fsck --full --no-reflogs --unreachable --dangling` also reports multiple unreachable commits and blobs, including old stash/index snapshots such as:

- `35c03db` `untracked files on main: fec374f chore(repo): clean legacy assets; align with forge-only WASM source`
- `4f074bf` `On (no branch): pre-revert-20251110-112547`
- `5033946` `On main: local-wip-`
- `90196ee` `On main: local-wip-20251030-134204`

These again indicate pre-existing local recovery state.

## Practical conclusion

The strict answer is:

- `play/main` **has** been restored to a clean upstream state
- but the stripped delta was **not perfectly pure MHR**
- mixed generic host capability and minor non-MHR changes did exist
- those mixed pieces are still recoverable from:
  - `backup/mhr-downstream-before-strip-20260401`
  - stash / unreachable local recovery objects

## Recommended next step

Do **not** guess which stripped generic items should come back.

Instead:

1. treat `backup/mhr-downstream-before-strip-20260401` as the authoritative source for the stripped delta
2. review group C and D items one by one
3. decide for each item:
   - downstream MHR-owned patch candidate
   - intentionally dropped
   - or separately reinstated in Play for non-MHR reasons

## Restore recommendation matrix

This section answers the stricter question:

> if a stripped change is not really "MHR product logic", should it go back to `play`?

### Restore to Play: yes

#### 1. `.gitignore` -> `/.agents_arena/`

Why:

- not MHR product logic
- not even a renderer/runtime host capability
- local repo hygiene rule that applies repo-wide

Evidence:

- no MHR-specific naming or semantics
- belongs to the local AGENTS arena protocol used across repos in the shared working tree

Recommendation:

- restore to `mujoco-wasm-play`

### Restore to Play: strong candidate

#### 2. `app/entry_bootstrap.js` -> allow `?profile=...` override for `PLAY_UI_PROFILE`

Why:

- Play already had profile infrastructure before MHR:
  - `ui.profileId`
  - `panel_state` profile namespacing
  - `PLAY_UI_PROFILE`
- this hunk does not itself mention `mhr`
- it completes an already-existing profile concept by letting the URL override it

Evidence:

- pre-MHR independent lineage exists:
  - `23b860e` `refactor(ui): consolidate panel state and app-scoped profiles`
- MHR commit only added the missing runtime override path

Recommendation:

- restore to `mujoco-wasm-play`
- treat as a generic runtime-config improvement, not as MHR logic

#### 3. `core/runtime_config.mjs` -> expose `data-play-profile` on `<html>`

Why:

- also builds on the pre-existing profile concept
- generic DOM hook for profile-aware shell styling / diagnostics
- no hard-coded MHR behavior in the hunk itself

Evidence:

- `profileId` existed in runtime config before MHR
- the added DOM attribute simply surfaces that existing state

Recommendation:

- restore to `mujoco-wasm-play`
- but only as a generic profile hook, with no profile-specific CSS shipped alongside it

### Restore to Play: no, keep out for now

#### 4. `app/play_host.mjs` -> `host.services`

Why not:

- generic in shape, but no independent non-MHR lineage was found
- only consumer in visible history was `host.services.mhr`
- current Play host already exposes `extensions`, which is enough for downstream-specific ownership unless Play decides to standardize app-owned services later

Evidence:

- `git log -S "host.services.mhr"` only points to the MHR commit range
- no other branch/reflog evidence shows an independent Play effort to add a first-class services contract

Recommendation:

- do **not** restore to upstream Play now
- keep it downstream in `MHR_Play` until another non-MHR consumer justifies standardization

#### 5. `renderer/pipeline.mjs` -> `onLabelOverlay(...)`

Why not:

- generic renderer extension point in principle
- but it first appears only in the MHR UI work
- upstream already has a renderer-owned label pass; exposing plugin registration into that pass is a policy change, not just a refactor

Evidence:

- `git log -S "onLabelOverlay"` points only to `b0eaad7`
- no independent non-MHR history uses this hook

Recommendation:

- do **not** restore now
- treat as downstream MHR patch until Play explicitly wants a public label-overlay subscription surface

#### 6. `renderer/controllers.mjs` -> `primaryDragMode`

Why not:

- generic option in form, but introduced only for MHR interaction feel
- no evidence of prior or parallel non-MHR work asking for a configurable primary drag gesture

Evidence:

- `git log -S "primaryDragMode"` points only to `3d34a15`

Recommendation:

- do **not** restore now
- keep downstream

#### 7. `backend/backend_core.mjs` -> public `setSnapshotHz(...)`

Why not yet:

- `play` already had two separate timing systems before MHR:
  - UI / plugin-facing clock lanes:
    - `onUiMainTick`
    - `onUiControlsTick`
    - `onUiSlowTick`
    - `onSnapshot`
  - backend / worker snapshot cadence:
    - adaptive worker-side `setSnapshotHz`
    - upstream tiers `[30, 60, 120]`
- so the existence of `setSnapshotHz` is **not** evidence that the public backend API should automatically come back
- what MHR added here was specifically a **public caller surface** into a mechanism that Play already used internally
- there is still no non-MHR caller in visible history

Evidence:

- upstream `backend/backend_core.mjs` already had:
  - `postSnapshotHzIfChanged(...)`
  - `maybeUpdateAdaptiveSnapshotHz(...)`
  - initial worker post `{ cmd: 'setSnapshotHz', hz: SNAPSHOT_ADAPT_DEFAULT_HZ }`
- upstream `worker/physics.worker.mjs` already had:
  - worker command `setSnapshotHz`
  - comment `adaptive 120/60/30Hz via setSnapshotHz`
- the public backend method appears only in `3d34a15`

Recommendation:

- **not an automatic restore**
- plausible future generic API, but not justified by current non-MHR evidence

#### 8. `worker/physics.worker.mjs` -> low snapshot tiers `[1, 5, 15, 30, 60, 120]`

Why not:

- this is **not** part of Play's existing UI/plugin lane system
- upstream already had complete adaptive snapshot behavior for the worker, but only at `[30, 60, 120]`
- MHR changed the worker cadence tiers themselves to `[1, 5, 15, 30, 60, 120]`
- that is a behavior change to the shared worker, not merely exposing a generic host hook

Evidence:

- upstream `worker/physics.worker.mjs` already supported:
  - `setSnapshotHz`
  - adaptive tier selection among `[30, 60, 120]`
- MHR range changed:
  - worker tiers to `[1, 5, 15, 30, 60, 120]`
  - flex snapshot fallback to `snapshotHz >= 120 ? 60 : snapshotHz >= 30 ? 30 : Math.max(1, snapshotHz)`
- no independent non-MHR lineage was found for those low tiers

Recommendation:

- do **not** restore
- treat as an MHR-driven experiment unless separate Play evidence appears

#### 9. `core/runtime_config.mjs` -> `assetConfig`

Why not:

- the current shape is effectively MHR-specific manifest/asset-base wiring
- no independent Play consumer exists

Recommendation:

- do **not** restore

### Not generic host capability, but still worth separate handling

#### 10. `environment/environment.mjs` -> shared `sun` preset retune

Why:

- this is not a generic host capability
- it is a global visual preset retune made during MHR visual polishing
- it should follow MHR downstream presentation, not upstream Play defaults

Evidence:

- changed shared sun preset values:
  - directional intensity
  - ambient/hemi/fill values
  - white ground
  - removed preset ground surface
- no evidence that this came from an independent non-MHR line

Recommendation:

- **do not restore to upstream Play as part of this split recovery**
- keep it downstream with MHR presentation
- only revisit if there is a separate Play-wide visual redesign decision
