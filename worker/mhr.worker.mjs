import { loadProcessedBundleManifest } from '../core/asset_bundle.mjs';
import { dispatchCommand, encodeEvent } from './dispatch.gen.mjs';

const EMPTY_STATE = Object.freeze({
  root: {},
  pose: {},
  surfaceShape: {},
  skeletalProportion: {},
  expression: {},
  expertRaw: {},
});

const runtime = {
  initialized: false,
  runtimeConfig: null,
  assets: {
    bundleId: '',
    manifestUrl: '',
    assetBaseUrl: '',
    manifest: null,
  },
  state: JSON.parse(JSON.stringify(EMPTY_STATE)),
  revision: 0,
  evaluationSeq: 0,
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeStatePatch(patch) {
  const next = clone(runtime.state);
  for (const key of Object.keys(EMPTY_STATE)) {
    const incoming = patch?.[key];
    if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
      next[key] = {
        ...(next[key] || {}),
        ...incoming,
      };
    }
  }
  runtime.state = next;
  runtime.revision += 1;
}

function currentCompareMode(fallback = 'both') {
  const candidate = runtime.state.root?.compareMode;
  if (typeof candidate === 'string' && candidate.trim()) {
    return candidate.trim();
  }
  return fallback;
}

function buildEvaluation(compareMode) {
  const manifest = runtime.assets.manifest;
  const poseCount = Object.keys(runtime.state.pose || {}).length;
  const shapeCount = Object.keys(runtime.state.surfaceShape || {}).length;
  const proportionCount = Object.keys(runtime.state.skeletalProportion || {}).length;
  const expressionCount = Object.keys(runtime.state.expression || {}).length;
  runtime.evaluationSeq += 1;
  const meshChunk = manifest?.chunkMap?.meshTopology || null;
  const rigChunk = manifest?.chunkMap?.rigTransforms || null;
  const parameterCount = manifest?.summary?.parameterCount || 0;

  return {
    seq: runtime.evaluationSeq,
    compareMode,
    mesh: {
      vertexCount:
        manifest?.parameterMetadata?.topology?.vertexCount
        || manifest?.parameterMetadata?.counts?.vertexCount
        || meshChunk?.shape?.[0]
        || (24 + shapeCount * 6 + expressionCount * 4),
      visible: compareMode !== 'skeleton',
    },
    skeleton: {
      jointCount:
        manifest?.parameterMetadata?.counts?.jointCount
        || rigChunk?.shape?.[0]
        || (14 + poseCount + proportionCount),
      visible: compareMode !== 'skin',
    },
    derived: {
      digest: `${runtime.revision}:${compareMode}:${runtime.assets.bundleId || 'no-bundle'}`,
      assetBundleId: runtime.assets.bundleId || 'unloaded',
      stateRevision: runtime.revision,
      parameterCount,
      manifestUrl: runtime.assets.manifestUrl || '',
      selectedOutputs: ['vertices', 'skeletonState', 'derivedValues'],
    },
  };
}

function post(kind, payload = {}) {
  self.postMessage(encodeEvent(kind, payload));
}

const handlers = {
  init(payload) {
    runtime.initialized = true;
    runtime.runtimeConfig = payload.runtimeConfig || null;
    post('ready', {
      contractVersion: 'draft',
      capabilities: {
        lifecycle: true,
        assetLoading: true,
        stateUpdate: true,
        evaluation: true,
        presets: true,
        diagnostics: true,
      },
    });
    post('diagnostic', {
      level: 'info',
      message: 'Worker initialized.',
    });
  },
  async loadAssets(payload) {
    const manifest = await loadProcessedBundleManifest(payload.assetConfig || {}, {
      fetchImpl: self.fetch?.bind(self),
    });
    runtime.assets = {
      bundleId: manifest.bundleId,
      manifestUrl: manifest.manifestUrl,
      assetBaseUrl: manifest.assetBaseUrl,
      manifest,
    };
    post('assetsLoaded', {
      bundleId: runtime.assets.bundleId,
      manifestUrl: runtime.assets.manifestUrl,
      assetBaseUrl: runtime.assets.assetBaseUrl,
      parameterCount: manifest.summary.parameterCount,
    });
  },
  setState(payload) {
    mergeStatePatch(payload.statePatch || {});
    post('stateUpdated', {
      revision: runtime.revision,
      state: runtime.state,
    });
  },
  evaluate(payload) {
    const compareMode = payload.compareMode || currentCompareMode('both');
    post('evaluation', {
      evaluation: buildEvaluation(compareMode),
    });
  },
  applyPreset(payload) {
    mergeStatePatch({
      root: {
        activePreset: payload.presetId || '',
      },
    });
    post('presetApplied', {
      presetId: payload.presetId || '',
      revision: runtime.revision,
    });
  },
  runSweep(payload) {
    post('sweepProgress', {
      sweepId: payload.sweepId || '',
      phase: 'completed',
      revision: runtime.revision,
    });
  },
  dispose() {
    post('diagnostic', {
      level: 'info',
      message: 'Worker disposed.',
    });
    self.close();
  },
};

self.addEventListener('message', (event) => {
  Promise.resolve()
    .then(() => dispatchCommand(handlers, event.data))
    .catch((error) => {
      post('error', {
        code: 'worker_command_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    });
});
