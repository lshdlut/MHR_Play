# mjwp_inject patches

`mjwp_inject` now prefers clean `mujoco-wasm-play` host APIs plus downstream-owned
plugin/page glue. Keep this directory for the rare case where a small upstream
patch is still required to preserve MHR-specific behaviour on a disposable Play
clone.

Current tracked patch set:

- `0001-mhr-sun-preset-tuning.patch`
  Restores the MHR-tuned `preset-sun` environment that was previously carried by
  the old tracked overlay tree: weaker direct light, softer shadows, plain
  white ground, and no ground texture.
- `0002-label-overlay-register-hook.patch`
  Restores the generic `renderer.labelOverlay.register(...)` host hook that the
  old tracked overlay exposed to downstream plugins, so MHR joint labels can
  draw through Play's shared label overlay instead of a private overlay path.
