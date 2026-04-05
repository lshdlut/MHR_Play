# MHR Play Site Mounting

This note documents the minimal contract for mounting MHR Play as a self-contained browser app inside another site.

## App Shape

- MHR Play remains a complete browser app.
- The mount host should treat it as a static webroot and should not reassemble plugin/runtime pieces.
- The deploy-oriented app artifact keeps the current viewer structure:
  - root redirect page
  - `viewer/` full-page entry
  - `viewer/?embed=1...` embed entry

## Viewer URL Patterns

- Full-page viewer:

```text
/viewer/?lod=1&theme=light&font=75&spacing=tight
```

- Embed viewer:

```text
/viewer/?embed=1&lod=1&theme=light&font=75&spacing=tight
```

## `site_config.js` Contract

Set these before `app/entry_bootstrap.js` runs:

```js
globalThis.PLAY_MHR_LOD = 1;
globalThis.PLAY_MHR_MANIFEST_URL = "https://assets.example.com/mhr-official/lod1/manifest.json";
globalThis.PLAY_MHR_ASSET_BASE_URL = "https://assets.example.com/mhr-official/lod1/";
// Recommended when using Play HDRI/EXR environment presets:
globalThis.PLAY_ENV_ASSET_BASE = "https://assets.example.com/env/";
```

Notes:

- `PLAY_MHR_LOD` is the default LoD when the viewer URL does not provide `?lod=...`.
- `PLAY_MHR_MANIFEST_URL` and `PLAY_MHR_ASSET_BASE_URL` should use the same `/lodN/` path shape. The viewer derives other LoDs by replacing that segment.
- `PLAY_ENV_ASSET_BASE` is optional for MHR boot itself, but recommended if the mounted app uses Play's built-in HDRI/EXR environment presets.

The generated deploy artifact already includes the existing Play runtime config:

- `PLAY_VER`
- `__FORGE_DIST_BASE__`

Those two are still required by the Play shell, but they are already written into the generated artifact and are not MHR-specific integration inputs.

## Recommended Defaults

- `lod=1`
- `theme=light`
- `font=75`
- `spacing=tight`

These defaults match the intended lightweight site embedding profile.

## Deploy-Oriented Artifact

The deploy-oriented MHR Play artifact keeps:

- the viewer shell
- plugin code
- UI/runtime JS needed to boot
- `viewer/site_config.js`

It intentionally excludes heavy bundled assets:

- `assets/env/*`
- `mhr-official/lod*/...`

Those assets are expected to come from the configured external base URLs.
