import { loadRuntimeIrManifest, loadRuntimeIrChunks } from '../core/asset_bundle.mjs';
import { buildRawInputs } from '../core/state_mapping.mjs';
import { dispatchCommand, encodeEvent } from './dispatch.gen.mjs';
import { createMhrWasmRuntime } from './mhr_wasm_runtime.mjs';

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
    chunkMap: null,
    topology: null,
    jointParents: null,
    parameterMetadata: null,
    counts: null,
  },
  state: JSON.parse(JSON.stringify(EMPTY_STATE)),
  revision: 0,
  evaluationSeq: 0,
  wasmRuntime: null,
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

async function ensureWasmRuntime() {
  if (runtime.wasmRuntime) {
    return runtime.wasmRuntime;
  }
  runtime.wasmRuntime = await createMhrWasmRuntime();
  return runtime.wasmRuntime;
}

function buildEvaluation(compareMode, result) {
  const manifest = runtime.assets.manifest;
  runtime.evaluationSeq += 1;
  const parameterCount = manifest?.summary?.parameterCount || 0;
  const counts = runtime.assets.parameterMetadata?.counts || {};

  return {
    seq: runtime.evaluationSeq,
    compareMode,
    mesh: {
      vertexCount: result.counts.vertexCount,
      faceCount: counts.faceCount || manifest?.parameterMetadata?.topology?.faceCount || 0,
      visible: compareMode !== 'skeleton',
      vertices: result.vertices,
    },
    skeleton: {
      jointCount: result.counts.jointCount,
      visible: compareMode !== 'skin',
      states: result.skeleton,
    },
    derived: {
      digest: `${runtime.revision}:${compareMode}:${runtime.assets.bundleId || 'no-bundle'}`,
      assetBundleId: runtime.assets.bundleId || 'unloaded',
      stateRevision: runtime.revision,
      parameterCount,
      manifestUrl: runtime.assets.manifestUrl || '',
      selectedOutputs: ['vertices', 'skeletonState', 'derivedValues'],
      rootTranslation: Array.from(result.derived.slice(0, 3)),
      firstVertex: Array.from(result.derived.slice(3, 6)),
      skeletonExtentY: result.derived[6] || 0,
    },
    debug: {
      timing: {
        resetStateMs: result.debugTiming[0] || 0,
        parameterUploadMs: result.debugTiming[1] || 0,
        evaluateCoreMs: result.debugTiming[2] || 0,
        verticesExportMs: result.debugTiming[3] || 0,
        skeletonExportMs: result.debugTiming[4] || 0,
        derivedExportMs: result.debugTiming[5] || 0,
      },
    },
  };
}

function post(kind, payload = {}, transfer = []) {
  self.postMessage(encodeEvent(kind, payload), transfer);
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
    const manifest = await loadRuntimeIrManifest(payload.assetConfig || {}, {
      fetchImpl: self.fetch?.bind(self),
    });
    const chunkMap = await loadRuntimeIrChunks(manifest, {
      fetchImpl: self.fetch?.bind(self),
    });
    const wasmRuntime = await ensureWasmRuntime();
    const counts = wasmRuntime.loadIr(manifest, chunkMap);
    const topology = new Uint32Array(chunkMap.meshTopology.array);
    const jointParents = new Int32Array(chunkMap.jointParents.array);
    runtime.assets = {
      bundleId: manifest.irId,
      manifestUrl: manifest.manifestUrl,
      assetBaseUrl: manifest.assetBaseUrl,
      manifest,
      chunkMap,
      topology,
      jointParents,
      parameterMetadata: manifest.parameterMetadata,
      counts,
    };
    post('assetsLoaded', {
      bundleId: runtime.assets.bundleId,
      manifestUrl: runtime.assets.manifestUrl,
      assetBaseUrl: runtime.assets.assetBaseUrl,
      parameterCount: manifest.summary.parameterCount,
      counts,
      topology,
      jointParents,
      parameterMetadata: manifest.parameterMetadata,
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
    if (!runtime.assets.manifest || !runtime.assets.parameterMetadata) {
      throw new Error('evaluate requires loaded assets.');
    }
    if (!runtime.wasmRuntime) {
      throw new Error('evaluate requires an initialized wasm runtime.');
    }
    const rawInputs = buildRawInputs(runtime.assets.parameterMetadata, runtime.state);
    const result = runtime.wasmRuntime.runEvaluate(rawInputs);
    const evaluation = buildEvaluation(compareMode, result);
    post(
      'evaluation',
      { evaluation },
      [
        evaluation.mesh.vertices.buffer,
        evaluation.skeleton.states.buffer,
      ],
    );
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
    runtime.wasmRuntime?.dispose?.();
    runtime.wasmRuntime = null;
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack || error.message : String(error);
      post('error', {
        code: 'worker_command_failed',
        message: errorMessage,
        stack: errorStack,
      });
    });
});
