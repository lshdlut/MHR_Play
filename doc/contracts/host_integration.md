# Host Integration

The current host-facing API is intentionally narrow.

## Public Surface

- `mountMhrPlay({ root, runtimeConfig?, assetConfig? })`
- `loadAssets`
- `setState`
- `getState`
- `evaluate`
- `resize`
- `destroy`

## Current Ownership Boundary

- host provides container, runtime configuration, and processed-bundle manifest configuration
- bootstrap normalizes standalone URL input only for the dev shell
- backend and worker own runtime truth
- host does not directly access worker internals or renderer internals

## Entry Boundary

- `app/main.mjs` is the library entry and does not auto-mount
- `app/standalone_entry.mjs` is the standalone shell entry used by `index.html`
- embed integrations must call `mountMhrPlay(...)` explicitly

## Config Precedence

1. explicit `runtimeConfig` / `assetConfig`
2. standalone bootstrap config derived from URL
3. repository defaults

Embed mode must not silently consume URL-derived asset config when explicit host
config is absent.

## Integration Rule

Consumers should integrate through the public mount/host surface only. Internal
globals are for local debugging, not for product integration.
