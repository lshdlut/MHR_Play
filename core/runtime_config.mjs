const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  startup: Object.freeze({
    standaloneShell: true,
    assetManifestUrl: '',
    entryVariant: 'single',
  }),
  ui: Object.freeze({
    embedMode: false,
    theme: 'sand',
    defaultCompareMode: 'both',
  }),
  host: Object.freeze({
    mode: 'standalone-dev-shell',
  }),
  worker: Object.freeze({
    diagnosticsEnabled: true,
  }),
});

export const DEFAULT_ASSET_CONFIG = Object.freeze({
  manifestUrl: '',
  assetBaseUrl: '',
});

function freezeIfObject(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  return Object.freeze(value);
}

export function normalizeRuntimeConfig(input = {}) {
  const startup = {
    ...DEFAULT_RUNTIME_CONFIG.startup,
    ...(input.startup || {}),
  };
  const ui = {
    ...DEFAULT_RUNTIME_CONFIG.ui,
    ...(input.ui || {}),
  };
  const host = {
    ...DEFAULT_RUNTIME_CONFIG.host,
    ...(input.host || {}),
  };
  const worker = {
    ...DEFAULT_RUNTIME_CONFIG.worker,
    ...(input.worker || {}),
  };

  return freezeIfObject({
    startup: freezeIfObject(startup),
    ui: freezeIfObject(ui),
    host: freezeIfObject(host),
    worker: freezeIfObject(worker),
  });
}

function absolutizeUrl(rawValue, fallbackBaseUrl = '') {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return '';
  }
  const value = rawValue.trim();
  if (!fallbackBaseUrl) {
    return value;
  }
  try {
    return new URL(value, fallbackBaseUrl).href;
  } catch {
    return value;
  }
}

export function normalizeAssetConfig(input = {}, target = globalThis) {
  const fallbackBaseUrl =
    typeof target?.location?.href === 'string' ? target.location.href : '';
  const manifestUrl = absolutizeUrl(input?.manifestUrl, fallbackBaseUrl);
  const assetBaseUrl = absolutizeUrl(input?.assetBaseUrl, fallbackBaseUrl);

  return freezeIfObject({
    manifestUrl,
    assetBaseUrl,
  });
}

export function getBootstrapRuntimeConfig(target = globalThis) {
  return normalizeRuntimeConfig(target.__MHR_PLAY_RUNTIME_CONFIG__ || {});
}

export function getRuntimeConfig(target = globalThis) {
  return getBootstrapRuntimeConfig(target);
}

export function resolveMountConfig({
  target = globalThis,
  runtimeConfig: explicitRuntimeConfig = null,
  assetConfig: explicitAssetConfig = null,
} = {}) {
  const hasExplicitRuntime =
    !!explicitRuntimeConfig && typeof explicitRuntimeConfig === 'object';
  const hasExplicitAsset =
    !!explicitAssetConfig && typeof explicitAssetConfig === 'object';

  const bootstrapRuntimeConfig = getBootstrapRuntimeConfig(target);
  const baseRuntimeConfig = hasExplicitRuntime
    ? normalizeRuntimeConfig(explicitRuntimeConfig)
    : bootstrapRuntimeConfig;
  const standaloneShell = !hasExplicitRuntime && !hasExplicitAsset && !!baseRuntimeConfig.startup.standaloneShell;
  const assetConfig = hasExplicitAsset
    ? normalizeAssetConfig(explicitAssetConfig, target)
    : standaloneShell
      ? normalizeAssetConfig({
          manifestUrl: baseRuntimeConfig.startup.assetManifestUrl,
        }, target)
      : DEFAULT_ASSET_CONFIG;
  const hostMode = hasExplicitRuntime || hasExplicitAsset ? 'embed' : baseRuntimeConfig.host.mode;

  const runtimeConfig = normalizeRuntimeConfig({
    ...baseRuntimeConfig,
    startup: {
      ...baseRuntimeConfig.startup,
      standaloneShell,
      assetManifestUrl: assetConfig.manifestUrl,
      entryVariant: hostMode === 'embed' ? 'host' : baseRuntimeConfig.startup.entryVariant,
    },
    ui: {
      ...baseRuntimeConfig.ui,
      embedMode: hostMode === 'embed',
    },
    host: {
      ...baseRuntimeConfig.host,
      mode: hostMode,
    },
  });

  return freezeIfObject({
    runtimeConfig,
    assetConfig,
    bootstrapRuntimeConfig,
  });
}

export function applyRuntimeUiToDocument(documentRef, runtimeConfig = getRuntimeConfig()) {
  const root = documentRef?.documentElement;
  if (!root) {
    return;
  }
  root.setAttribute('data-mhr-theme', runtimeConfig.ui.theme || 'sand');
  if (runtimeConfig.ui.embedMode) {
    root.setAttribute('data-mhr-embed', '1');
  } else {
    root.removeAttribute('data-mhr-embed');
  }
}
