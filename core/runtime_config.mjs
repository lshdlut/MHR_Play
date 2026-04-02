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
