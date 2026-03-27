const HOST_API_VERSION = 1;

function freezeIfObject(value) {
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  return Object.freeze(value);
}

export function createMhrPlayHost({
  backend = null,
  store = null,
  renderer = null,
  shell = null,
  destroy = () => {},
} = {}) {
  const contract = freezeIfObject({
    apiVersion: HOST_API_VERSION,
    methods: ['loadAssets', 'setState', 'getState', 'resize', 'destroy', 'evaluate'],
  });

  const host = {
    apiVersion: HOST_API_VERSION,
    contract,
    shell: freezeIfObject(shell),
    backend,
    store,
    renderer,
    loadAssets: (assetConfig) => backend?.loadAssets?.(assetConfig),
    setState: (patch) => backend?.setState?.(patch),
    getState: () => backend?.getState?.() ?? null,
    evaluate: (options) => backend?.evaluate?.(options),
    resize: () => renderer?.resize?.(),
    getSnapshot: () => backend?.snapshot?.() ?? null,
    destroy,
  };

  return freezeIfObject(host);
}
