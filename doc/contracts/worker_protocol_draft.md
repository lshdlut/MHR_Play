# Worker Protocol Draft

The worker protocol is formal and generated from `tools/worker_protocol.json`.

## Command Categories

- `lifecycle`: `init`, `dispose`
- `asset_loading`: `loadAssets`
- `state_update`: `setState`
- `evaluation`: `evaluate`
- `presets`: `applyPreset`, `runSweep`

## Event Categories

- `lifecycle`: `ready`
- `asset_loading`: `assetsLoaded`
- `state_update`: `stateUpdated`
- `evaluation`: `evaluation`
- `presets`: `presetApplied`, `sweepProgress`
- `diagnostics`: `diagnostic`, `error`

## Draft Shapes

### `loadAssets`

Required:

- `assetConfig`

`assetConfig` currently freezes to:

- `manifestUrl: string`
- `assetBaseUrl?: string`

### `setState`

Required:

- `statePatch`

### `evaluate`

Optional:

- `compareMode`

## Protocol Rules

- command/event names are versioned contract surface
- required fields fail loudly
- diagnostics travel through formal events, not console-only behavior
- runtime-facing asset loading consumes processed bundle manifests, not raw
  official asset paths
