(function initMhrPlayRuntimeConfig() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  const root = document.documentElement;
  const params = new URLSearchParams(window.location.search || '');
  const TRUE_SET = new Set(['1', 'true', 'yes', 'on']);
  const ALLOWED_COMPARE_MODES = new Set(['skin', 'skeleton', 'both', 'preset', 'sweep']);

  function readRaw(name) {
    const value = params.get(String(name || '').trim());
    return value == null ? '' : String(value).trim();
  }

  function readToken(name) {
    return readRaw(name).toLowerCase();
  }

  function readBoolean(name, fallback) {
    const token = readToken(name);
    if (!token) return fallback;
    return TRUE_SET.has(token);
  }

  function readCompareMode() {
    const token = readToken('compare');
    if (ALLOWED_COMPARE_MODES.has(token)) {
      return token;
    }
    return 'both';
  }

  function readDefaultAssetManifest() {
    const explicit = readRaw('assets');
    if (explicit) {
      return explicit;
    }
    const datasetValue = root.getAttribute('data-mhr-default-assets');
    return datasetValue == null ? '' : String(datasetValue).trim();
  }

  const config = {
    startup: {
      standaloneShell: true,
      assetManifestUrl: readDefaultAssetManifest(),
      entryVariant: 'single',
    },
    ui: {
      embedMode: readBoolean('embed', false),
      theme: readToken('theme') || 'sand',
      defaultCompareMode: readCompareMode(),
    },
    host: {
      mode: 'standalone-dev-shell',
    },
    worker: {
      diagnosticsEnabled: true,
    },
  };

  globalThis.__MHR_PLAY_RUNTIME_CONFIG__ = config;
  root.setAttribute('data-mhr-theme', config.ui.theme);
  if (config.ui.embedMode) {
    root.setAttribute('data-mhr-embed', '1');
  } else {
    root.removeAttribute('data-mhr-embed');
  }
})();
