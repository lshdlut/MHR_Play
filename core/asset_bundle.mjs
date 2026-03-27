import { normalizeAssetConfig } from './runtime_config.mjs';

export const PROCESSED_BUNDLE_SCHEMA = 'mhr-processed-bundle/v1';

export const REQUIRED_CHUNK_KEYS = Object.freeze([
  'meshTopology',
  'skinningWeights',
  'bindMatrices',
  'inverseBindMatrices',
  'rigTransforms',
  'blendshapeData',
  'correctiveData',
]);

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  throw new Error('Chunk reader must return Uint8Array or ArrayBuffer.');
}

function bytesToHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('crypto.subtle is required for chunk hash validation.');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(digest));
}

export function validateProcessedBundleManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Processed bundle manifest must be an object.');
  }
  if (manifest.bundleSchema !== PROCESSED_BUNDLE_SCHEMA) {
    throw new Error(`Unsupported bundle schema: ${String(manifest.bundleSchema)}`);
  }
  if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion <= 0) {
    throw new Error('Processed bundle manifest requires a positive integer schemaVersion.');
  }
  const bundleId = requireNonEmptyString(manifest.bundleId, 'Processed bundle manifest bundleId');
  const sourceId = requireNonEmptyString(manifest.sourceId, 'Processed bundle manifest sourceId');
  const modelVersion = requireNonEmptyString(manifest.modelVersion, 'Processed bundle manifest modelVersion');
  requireNonEmptyString(manifest.bundleFingerprint, 'Processed bundle manifest bundleFingerprint');
  if (!manifest.bundleFingerprint.startsWith('sha256:')) {
    throw new Error('Processed bundle manifest bundleFingerprint must use sha256: prefix.');
  }
  if (!manifest.parameterMetadata || typeof manifest.parameterMetadata !== 'object') {
    throw new Error('Processed bundle manifest requires parameterMetadata.');
  }
  if (!Array.isArray(manifest.chunks)) {
    throw new Error('Processed bundle manifest requires chunks.');
  }

  const seen = new Set();
  const chunkMap = {};
  for (const chunk of manifest.chunks) {
    if (!chunk || typeof chunk !== 'object') {
      throw new Error('Chunk entries must be objects.');
    }
    const chunkKey = requireNonEmptyString(chunk.key, 'Chunk key');
    if (seen.has(chunk.key)) {
      throw new Error(`Duplicate chunk key: ${chunk.key}`);
    }
    seen.add(chunk.key);
    requireNonEmptyString(chunk.file, `Chunk ${chunk.key} file`);
    requireNonEmptyString(chunk.dtype, `Chunk ${chunk.key} dtype`);
    if (!Array.isArray(chunk.shape) || chunk.shape.length === 0) {
      throw new Error(`Chunk ${chunk.key} requires shape.`);
    }
    if (!Number.isInteger(chunk.count) || chunk.count <= 0) {
      throw new Error(`Chunk ${chunk.key} requires count.`);
    }
    if (!Number.isFinite(chunk.byteLength) || chunk.byteLength <= 0) {
      throw new Error(`Chunk ${chunk.key} requires byteLength.`);
    }
    if (typeof chunk.sha256 !== 'string' || !chunk.sha256.startsWith('sha256:')) {
      throw new Error(`Chunk ${chunk.key} requires sha256 fingerprint.`);
    }
    chunkMap[chunkKey] = Object.freeze({ ...chunk });
  }

  for (const key of REQUIRED_CHUNK_KEYS) {
    if (!seen.has(key)) {
      throw new Error(`Processed bundle manifest is missing required chunk: ${key}`);
    }
  }

  return {
    bundleId,
    bundleSchema: manifest.bundleSchema,
    schemaVersion: manifest.schemaVersion,
    sourceId,
    modelVersion,
    chunkCount: manifest.chunks.length,
    parameterCount: Array.isArray(manifest.parameterMetadata?.parameters)
      ? manifest.parameterMetadata.parameters.length
      : 0,
    chunkMap,
  };
}

export async function loadProcessedBundleManifest(
  assetConfig = {},
  {
    fetchImpl = globalThis.fetch,
  } = {},
) {
  const resolvedAssetConfig = normalizeAssetConfig(assetConfig);
  const manifestUrl = requireNonEmptyString(
    resolvedAssetConfig.manifestUrl,
    'assetConfig.manifestUrl',
  );
  if (typeof fetchImpl !== 'function') {
    throw new Error('loadProcessedBundleManifest requires fetch.');
  }

  const response = await fetchImpl(manifestUrl);
  if (!response?.ok) {
    throw new Error(`Failed to fetch processed bundle manifest: ${manifestUrl}`);
  }

  const manifest = await response.json();
  const validated = validateProcessedBundleManifest(manifest);
  const resolvedManifestUrl =
    typeof response.url === 'string' && response.url.trim()
      ? response.url
      : manifestUrl;
  const assetBaseUrl =
    resolvedAssetConfig.assetBaseUrl || new URL('./', resolvedManifestUrl).href;
  const chunks = manifest.chunks.map((chunk) => ({
    ...chunk,
    url: new URL(chunk.file, assetBaseUrl).href,
  }));

  return Object.freeze({
    ...manifest,
    manifestUrl: resolvedManifestUrl,
    assetBaseUrl,
    chunks,
    chunkMap: Object.freeze(
      Object.fromEntries(chunks.map((chunk) => [chunk.key, Object.freeze(chunk)])),
    ),
    summary: Object.freeze(validated),
  });
}

export async function validateProcessedBundleChunks(
  manifest,
  {
    readChunk,
  } = {},
) {
  if (typeof readChunk !== 'function') {
    throw new Error('validateProcessedBundleChunks requires readChunk.');
  }

  const summary = validateProcessedBundleManifest(manifest);
  for (const chunk of manifest.chunks) {
    const chunkBytes = toUint8Array(await readChunk(chunk));
    if (chunkBytes.byteLength !== chunk.byteLength) {
      throw new Error(
        `Chunk ${chunk.key} byteLength mismatch: expected ${chunk.byteLength}, got ${chunkBytes.byteLength}.`,
      );
    }
    const actualSha = await sha256Hex(chunkBytes);
    if (`sha256:${actualSha}` !== chunk.sha256) {
      throw new Error(`Chunk ${chunk.key} sha256 mismatch.`);
    }
  }

  return {
    ...summary,
    validatedChunkCount: manifest.chunks.length,
  };
}
