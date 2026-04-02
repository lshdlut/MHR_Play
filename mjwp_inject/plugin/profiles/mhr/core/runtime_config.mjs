function freezeIfObject(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  return Object.freeze(value);
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
  } catch (error) {
    throw new Error(`Invalid asset URL: ${value}`, { cause: error });
  }
}

function normalizeLod(rawValue) {
  if (rawValue == null || rawValue === '') {
    return null;
  }
  const numeric = Number(rawValue);
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw new Error(`Invalid LOD value: ${String(rawValue)}`);
  }
  return numeric;
}

export function normalizeAssetConfig(input = {}, target = globalThis) {
  const fallbackBaseUrl =
    typeof target?.location?.href === 'string' ? target.location.href : '';
  const manifestUrl = absolutizeUrl(input?.manifestUrl, fallbackBaseUrl);
  const assetBaseUrl = absolutizeUrl(input?.assetBaseUrl, fallbackBaseUrl);
  const lod = normalizeLod(input?.lod);

  return freezeIfObject({
    manifestUrl,
    assetBaseUrl,
    lod,
  });
}
