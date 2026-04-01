import { loadRuntimeIrManifest, loadRuntimeIrChunks } from '../core/asset_bundle.mjs';
import { buildRawInputs } from '../core/state_mapping.mjs';
import { dispatchCommand, encodeEvent } from './dispatch.gen.mjs';
import { createMhrWasmRuntime } from './mhr_wasm_runtime.mjs';

const FIXED_SLOT_KEYS = Object.freeze([
  'spine0_rx_flexible',
  'spine0_ry_flexible',
  'spine0_rz_flexible',
  'spine1_rx_flexible',
  'spine1_ry_flexible',
  'spine1_rz_flexible',
  'spine2_rx_flexible',
  'spine2_ry_flexible',
  'spine2_rz_flexible',
  'spine3_rx_flexible',
  'spine3_ry_flexible',
  'spine3_rz_flexible',
  'r_clavicle_rx',
  'l_clavicle_rx',
  'r_foot_lean1',
  'l_foot_lean1',
  'l_foot_ry_flexible',
  'l_subtalar_rz_flexible',
  'l_talocrural_rx_flexible',
  'l_ball_rx_flexible',
  'r_foot_ry_flexible',
  'r_subtalar_rz_flexible',
  'r_talocrural_rx_flexible',
  'r_ball_rx_flexible',
]);
const FIXED_SLOT_SLIDER_MIN = -Math.PI;
const FIXED_SLOT_SLIDER_MAX = Math.PI;
const FIXED_SLOT_SLIDER_STEP = 0.01;

const EMPTY_STATE = Object.freeze({
  root: {},
  pose: {},
  surfaceShape: {},
  skeletalProportion: {},
  expression: {},
  expertRaw: {},
});

function createEmptyPatch() {
  return {
    root: {},
    pose: {},
    surfaceShape: {},
    skeletalProportion: {},
    expression: {},
    expertRaw: {},
  };
}

function nowTraceTs() {
  return performance.timeOrigin + performance.now();
}

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
    previewEdges: null,
    jointParents: null,
    parameterMetadata: null,
    parameterByKey: null,
    counts: null,
  },
  state: JSON.parse(JSON.stringify(EMPTY_STATE)),
  revision: 0,
  evaluationSeq: 0,
  wasmRuntime: null,
  lastSetStateDebug: null,
  interactive: {
    active: false,
    rerun: false,
    compareMode: 'both',
    debugTiming: null,
    accumulatedPatch: createEmptyPatch(),
    previewInfluence: null,
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cloneDebugTiming(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return clone(value);
}

function stripDebugPatch(statePatch) {
  if (!statePatch || typeof statePatch !== 'object' || Array.isArray(statePatch)) {
    return {};
  }
  const next = { ...statePatch };
  delete next.__debugTiming;
  return next;
}

function clonePatchForEvent(statePatch) {
  return clone(stripDebugPatch(statePatch || {}));
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

function mergePatchInto(target, patch) {
  const next = target && typeof target === 'object' ? target : createEmptyPatch();
  for (const key of Object.keys(EMPTY_STATE)) {
    const incoming = patch?.[key];
    if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
      next[key] = {
        ...(next[key] || {}),
        ...incoming,
      };
    }
  }
  return next;
}

function buildParameterByKey(parameterMetadata) {
  const lookup = new Map();
  const parameters = Array.isArray(parameterMetadata?.parameters)
    ? parameterMetadata.parameters
    : [];
  for (const parameter of parameters) {
    if (typeof parameter?.key === 'string' && parameter.key) {
      lookup.set(parameter.key, parameter);
    }
  }
  return lookup;
}

function buildFixedSlotEcho(rawInputs) {
  const sections = runtime.assets.parameterMetadata?.sections || {};
  const rawLookup = {
    ...(sections.root || {}),
    ...(sections.pose || {}),
    ...(sections.skeletalProportion || {}),
  };
  const output = {};
  for (const key of FIXED_SLOT_KEYS) {
    const rawIndex = rawLookup[key];
    if (!Number.isFinite(Number(rawIndex))) {
      continue;
    }
    output[key] = {
      rawIndex: Number(rawIndex),
      value: Number(rawInputs.modelParameters[Number(rawIndex)] ?? 0),
    };
  }
  return output;
}

function currentCompareMode(fallback = 'both') {
  const candidate = runtime.state.root?.compareMode;
  if (typeof candidate === 'string' && candidate.trim()) {
    return candidate.trim();
  }
  return fallback;
}

function isFixedSlotParameter(parameter) {
  const min = Number(parameter?.min);
  const max = Number(parameter?.max);
  return Number.isFinite(min) && Number.isFinite(max) && min === max;
}

function getParameterDefaultValue(parameter) {
  const numeric = Number(parameter?.default);
  return Number.isFinite(numeric) ? numeric : 0;
}

function clampToBounds(value, min, max) {
  let next = Number(value);
  if (!Number.isFinite(next)) {
    next = 0;
  }
  if (Number.isFinite(min)) next = Math.max(min, next);
  if (Number.isFinite(max)) next = Math.min(max, next);
  return next;
}

function clampToParameter(parameter, value) {
  if (isFixedSlotParameter(parameter)) {
    return Number(value);
  }
  return clampToBounds(value, Number(parameter?.min), Number(parameter?.max));
}

function getSliderBounds(parameter) {
  if (isFixedSlotParameter(parameter)) {
    return {
      min: FIXED_SLOT_SLIDER_MIN,
      max: FIXED_SLOT_SLIDER_MAX,
      step: FIXED_SLOT_SLIDER_STEP,
    };
  }
  const min = Number.isFinite(Number(parameter?.min)) ? Number(parameter.min) : -1;
  const max = Number.isFinite(Number(parameter?.max)) ? Number(parameter.max) : 1;
  return {
    min,
    max,
    step: Number.isFinite(min) && Number.isFinite(max) && max > min
      ? Math.max((max - min) / 200, 0.001)
      : 0.001,
  };
}

function getStateValue(state, parameter) {
  const section = String(parameter?.stateSection || '').trim();
  const key = String(parameter?.key || '').trim();
  const value = state?.[section]?.[key];
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : getParameterDefaultValue(parameter);
}

function cloneStateTree(state) {
  const source = state && typeof state === 'object' ? state : EMPTY_STATE;
  return {
    root: { ...(source.root || {}) },
    pose: { ...(source.pose || {}) },
    surfaceShape: { ...(source.surfaceShape || {}) },
    skeletalProportion: { ...(source.skeletalProportion || {}) },
    expression: { ...(source.expression || {}) },
    expertRaw: { ...(source.expertRaw || {}) },
  };
}

function buildUniqueTopologyEdges(topology, vertexCount) {
  if (!(vertexCount > 0) || !(topology instanceof Uint32Array) || topology.length < 3) {
    return new Uint32Array(0);
  }
  const edgeKeys = new Set();
  const edges = [];
  const addEdge = (first, second) => {
    const a = Number(first);
    const b = Number(second);
    if (!(a >= 0) || !(b >= 0) || a === b || a >= vertexCount || b >= vertexCount) {
      return;
    }
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = `${lo}:${hi}`;
    if (edgeKeys.has(key)) {
      return;
    }
    edgeKeys.add(key);
    edges.push(lo, hi);
  };
  for (let index = 0; index + 2 < topology.length; index += 3) {
    const a = topology[index + 0];
    const b = topology[index + 1];
    const c = topology[index + 2];
    addEdge(a, b);
    addEdge(b, c);
    addEdge(c, a);
  }
  return new Uint32Array(edges);
}

function buildPreviewDeformationMagnitudes(baseVertices, previewVertices, previewEdges, vertexCount) {
  const magnitudes = new Float32Array(vertexCount);
  if (!(vertexCount > 0)) {
    return {
      magnitudes,
      maxMagnitude: 0,
    };
  }
  if (!(previewEdges instanceof Uint32Array) || previewEdges.length < 2) {
    let maxMagnitude = 0;
    for (let index = 0; index < vertexCount; index += 1) {
      const base = index * 3;
      const dx = Number(previewVertices[base + 0] || 0) - Number(baseVertices[base + 0] || 0);
      const dy = Number(previewVertices[base + 1] || 0) - Number(baseVertices[base + 1] || 0);
      const dz = Number(previewVertices[base + 2] || 0) - Number(baseVertices[base + 2] || 0);
      const magnitude = Math.sqrt((dx * dx) + (dy * dy) + (dz * dz));
      magnitudes[index] = magnitude;
      if (magnitude > maxMagnitude) {
        maxMagnitude = magnitude;
      }
    }
    return {
      magnitudes,
      maxMagnitude,
    };
  }

  const edgeCounts = new Uint32Array(vertexCount);
  let maxMagnitude = 0;
  for (let edgeIndex = 0; edgeIndex + 1 < previewEdges.length; edgeIndex += 2) {
    const first = previewEdges[edgeIndex + 0];
    const second = previewEdges[edgeIndex + 1];
    const baseA = first * 3;
    const baseB = second * 3;

    const baseDx = Number(baseVertices[baseA + 0] || 0) - Number(baseVertices[baseB + 0] || 0);
    const baseDy = Number(baseVertices[baseA + 1] || 0) - Number(baseVertices[baseB + 1] || 0);
    const baseDz = Number(baseVertices[baseA + 2] || 0) - Number(baseVertices[baseB + 2] || 0);
    const previewDx = Number(previewVertices[baseA + 0] || 0) - Number(previewVertices[baseB + 0] || 0);
    const previewDy = Number(previewVertices[baseA + 1] || 0) - Number(previewVertices[baseB + 1] || 0);
    const previewDz = Number(previewVertices[baseA + 2] || 0) - Number(previewVertices[baseB + 2] || 0);

    const baseLength = Math.sqrt((baseDx * baseDx) + (baseDy * baseDy) + (baseDz * baseDz));
    const previewLength = Math.sqrt((previewDx * previewDx) + (previewDy * previewDy) + (previewDz * previewDz));
    const strain = Math.abs(previewLength - baseLength);
    if (!(strain > 0)) {
      continue;
    }
    magnitudes[first] += strain;
    magnitudes[second] += strain;
    edgeCounts[first] += 1;
    edgeCounts[second] += 1;
  }

  for (let index = 0; index < vertexCount; index += 1) {
    const count = edgeCounts[index];
    if (count > 0) {
      magnitudes[index] /= count;
    }
    if (magnitudes[index] > maxMagnitude) {
      maxMagnitude = magnitudes[index];
    }
  }
  return {
    magnitudes,
    maxMagnitude,
  };
}

function choosePreviewDelta(parameter, currentValue) {
  if (isFixedSlotParameter(parameter)) {
    return 0.18;
  }
  const { min, max, step } = getSliderBounds(parameter);
  const range = Number(max) - Number(min);
  let magnitude = Math.max(Math.abs(Number(step) || 0) * 8, range * 0.04, 0.01);
  if (!(magnitude > 0)) {
    magnitude = 0.01;
  }
  if (Number.isFinite(max) && (currentValue + magnitude) <= max) {
    return magnitude;
  }
  if (Number.isFinite(min) && (currentValue - magnitude) >= min) {
    return -magnitude;
  }
  if (Number.isFinite(max) && Number.isFinite(min) && max > min) {
    const upRoom = Math.max(0, max - currentValue);
    const downRoom = Math.max(0, currentValue - min);
    if (upRoom >= downRoom && upRoom > 0) {
      return Math.min(magnitude, upRoom);
    }
    if (downRoom > 0) {
      return -Math.min(magnitude, downRoom);
    }
  }
  return magnitude;
}

function buildInfluencePreviewPayload(request, baseResult) {
  const parameterKey = String(request?.parameterKey || '').trim();
  const stateSection = String(request?.stateSection || '').trim();
  const parameter = runtime.assets.parameterByKey?.get(parameterKey) || null;
  if (!parameter) {
    return null;
  }
  if (stateSection && String(parameter.stateSection || '').trim() !== stateSection) {
    return null;
  }
  const currentValue = getStateValue(runtime.state, parameter);
  const delta = choosePreviewDelta(parameter, currentValue);
  const previewState = cloneStateTree(runtime.state);
  const sectionKey = String(parameter.stateSection || '').trim();
  const nextValue = clampToParameter(parameter, currentValue + delta);
  if (!previewState[sectionKey]) {
    previewState[sectionKey] = {};
  }
  previewState[sectionKey][parameterKey] = nextValue;
  const { result: previewResult } = evaluateStateValue(previewState, null);
  const vertexCount = Number(baseResult?.counts?.vertexCount || 0);
  const { magnitudes, maxMagnitude } = buildPreviewDeformationMagnitudes(
    baseResult.vertices,
    previewResult.vertices,
    runtime.assets.previewEdges,
    vertexCount,
  );
  return {
    parameterKey,
    stateSection: sectionKey,
    revision: Number(runtime.revision || 0),
    vertexCount,
    maxMagnitude,
    appliedDelta: nextValue - currentValue,
    magnitudes,
  };
}

async function ensureWasmRuntime() {
  if (runtime.wasmRuntime) {
    return runtime.wasmRuntime;
  }
  runtime.wasmRuntime = await createMhrWasmRuntime();
  return runtime.wasmRuntime;
}

function buildEvaluation(compareMode, result, debug, influencePreview = null) {
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
    influencePreview: influencePreview ? {
      ...influencePreview,
      magnitudes: influencePreview.magnitudes || null,
    } : null,
    debug: debug || null,
  };
}

function evaluateCurrentState(compareMode, debugTiming) {
  const rawBuildStart = performance.now();
  const rawInputs = buildRawInputs(runtime.assets.parameterMetadata, runtime.state);
  if (debugTiming) {
    debugTiming.worker.buildRawInputsMs = performance.now() - rawBuildStart;
  }
  const wasmRunStart = performance.now();
  const result = runtime.wasmRuntime.runEvaluate(rawInputs);
  if (debugTiming) {
    debugTiming.worker.runEvaluateWallMs = performance.now() - wasmRunStart;
    debugTiming.wasm = result.debugTiming || null;
    debugTiming.fixedSlotEcho = buildFixedSlotEcho(rawInputs);
    debugTiming.worker.evaluationDispatchTs = nowTraceTs();
  }
  return {
    rawInputs,
    result,
  };
}

function evaluateStateValue(state, debugTiming = null) {
  const rawBuildStart = performance.now();
  const rawInputs = buildRawInputs(runtime.assets.parameterMetadata, state);
  if (debugTiming) {
    debugTiming.worker.buildRawInputsMs = performance.now() - rawBuildStart;
  }
  const wasmRunStart = performance.now();
  const result = runtime.wasmRuntime.runEvaluate(rawInputs);
  if (debugTiming) {
    debugTiming.worker.runEvaluateWallMs = performance.now() - wasmRunStart;
    debugTiming.wasm = result.debugTiming || null;
    debugTiming.fixedSlotEcho = buildFixedSlotEcho(rawInputs);
    debugTiming.worker.evaluationDispatchTs = nowTraceTs();
  }
  return {
    rawInputs,
    result,
  };
}

function postEvaluation(compareMode, result, debugTiming, appliedStatePatch = null, influencePreview = null) {
  post('evaluation', {
    revision: runtime.revision,
    ...(appliedStatePatch ? { appliedStatePatch: clonePatchForEvent(appliedStatePatch) } : {}),
    evaluation: buildEvaluation(compareMode, result, {
      fixedSlotEcho: debugTiming?.fixedSlotEcho ?? null,
      debugTiming: debugTiming || null,
    }, influencePreview),
  });
}

function scheduleInteractiveLoop() {
  if (runtime.interactive.active) {
    runtime.interactive.rerun = true;
    return;
  }
  runtime.interactive.active = true;
  queueMicrotask(() => {
    try {
      while (true) {
        runtime.interactive.rerun = false;
        const compareMode = runtime.interactive.compareMode || currentCompareMode('both');
        const debugTiming = runtime.interactive.debugTiming;
        const revisionAtStart = runtime.revision;
        if (debugTiming) {
          const workerReceiveTs = nowTraceTs();
          debugTiming.worker = {
            ...(debugTiming.worker || {}),
            applyStateAndEvaluateReceivedTs: workerReceiveTs,
            setStateReceivedTs: workerReceiveTs,
            evaluateReceivedTs: workerReceiveTs,
          };
        }
        const { result } = evaluateCurrentState(compareMode, debugTiming);
        if (runtime.interactive.rerun || runtime.revision !== revisionAtStart) {
          continue;
        }
        const appliedPatch = runtime.interactive.accumulatedPatch;
        const influencePreview = buildInfluencePreviewPayload(
          runtime.interactive.previewInfluence,
          result,
        );
        runtime.interactive.accumulatedPatch = createEmptyPatch();
        runtime.interactive.previewInfluence = null;
        postEvaluation(compareMode, result, debugTiming, appliedPatch, influencePreview);
        runtime.interactive.debugTiming = null;
        if (!runtime.interactive.rerun) {
          break;
        }
      }
    } finally {
      runtime.interactive.active = false;
      if (runtime.interactive.rerun) {
        scheduleInteractiveLoop();
      }
    }
  });
}

function collectTransfers(kind, payload) {
  if (kind !== 'evaluation') {
    if (kind === 'influencePreview' && payload?.magnitudes instanceof Float32Array) {
      return [payload.magnitudes.buffer];
    }
    return [];
  }
  const transfers = [];
  const vertices = payload?.evaluation?.mesh?.vertices;
  const skeleton = payload?.evaluation?.skeleton?.states;
  const previewMagnitudes = payload?.evaluation?.influencePreview?.magnitudes;
  if (vertices instanceof Float32Array) {
    transfers.push(vertices.buffer);
  }
  if (skeleton instanceof Float32Array) {
    transfers.push(skeleton.buffer);
  }
  if (previewMagnitudes instanceof Float32Array) {
    transfers.push(previewMagnitudes.buffer);
  }
  return transfers;
}

function post(kind, payload = {}) {
  const message = encodeEvent(kind, payload);
  const transfers = collectTransfers(kind, payload);
  if (transfers.length) {
    self.postMessage(message, transfers);
  } else {
    self.postMessage(message);
  }
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
      previewEdges: buildUniqueTopologyEdges(topology, Number(counts?.vertexCount || 0)),
      jointParents,
      parameterMetadata: manifest.parameterMetadata,
      parameterByKey: buildParameterByKey(manifest.parameterMetadata),
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
  debugPing(payload) {
    const workerReceiveTs = nowTraceTs();
    post('debugPong', {
      mainSentTs: Number(payload?.mainSentTs || 0),
      workerReceiveTs,
      workerDispatchTs: nowTraceTs(),
    });
  },
  setState(payload) {
    const debugTiming = cloneDebugTiming(payload?.statePatch?.__debugTiming);
    const workerReceiveTs = nowTraceTs();
    const statePatch = stripDebugPatch(payload.statePatch || {});
    const mergeStart = performance.now();
    mergeStatePatch(statePatch);
    const mergeEnd = performance.now();
    runtime.lastSetStateDebug = debugTiming
      ? {
          ...debugTiming,
          worker: {
            ...(debugTiming.worker || {}),
            setStateReceivedTs: workerReceiveTs,
            mergeStatePatchMs: mergeEnd - mergeStart,
          },
        }
      : null;
    post('stateUpdated', {
      revision: runtime.revision,
      state: runtime.state,
      debugTiming: runtime.lastSetStateDebug,
    });
  },
  applyStateAndEvaluate(payload) {
    const compareMode = payload.compareMode || currentCompareMode('both');
    if (!runtime.assets.manifest || !runtime.assets.parameterMetadata) {
      throw new Error('applyStateAndEvaluate requires loaded assets.');
    }
    if (!runtime.wasmRuntime) {
      throw new Error('applyStateAndEvaluate requires an initialized wasm runtime.');
    }
    const debugTiming = cloneDebugTiming(payload?.__debugTiming);
    const workerReceiveTs = nowTraceTs();
    const statePatch = stripDebugPatch(payload.statePatch || {});
    const mergeStart = performance.now();
    mergeStatePatch(statePatch);
    const mergeEnd = performance.now();
    const interactive = payload?.interactive === true;
    if (interactive) {
      runtime.interactive.compareMode = compareMode;
      runtime.interactive.debugTiming = debugTiming || null;
      runtime.interactive.accumulatedPatch = mergePatchInto(runtime.interactive.accumulatedPatch, statePatch);
      runtime.interactive.previewInfluence = payload?.previewInfluence || null;
      if (debugTiming) {
        debugTiming.worker = {
          ...(debugTiming.worker || {}),
          applyStateAndEvaluateReceivedTs: workerReceiveTs,
          setStateReceivedTs: workerReceiveTs,
          mergeStatePatchMs: mergeEnd - mergeStart,
        };
      }
      scheduleInteractiveLoop();
      return;
    }
    if (debugTiming) {
      debugTiming.worker = {
        ...(debugTiming.worker || {}),
        applyStateAndEvaluateReceivedTs: workerReceiveTs,
        setStateReceivedTs: workerReceiveTs,
        mergeStatePatchMs: mergeEnd - mergeStart,
        evaluateReceivedTs: nowTraceTs(),
      };
    }
    const { result } = evaluateCurrentState(compareMode, debugTiming);
    const influencePreview = buildInfluencePreviewPayload(payload?.previewInfluence, result);
    postEvaluation(compareMode, result, debugTiming, statePatch, influencePreview);
  },
  evaluate(payload) {
    const compareMode = payload.compareMode || currentCompareMode('both');
    if (!runtime.assets.manifest || !runtime.assets.parameterMetadata) {
      throw new Error('evaluate requires loaded assets.');
    }
    if (!runtime.wasmRuntime) {
      throw new Error('evaluate requires an initialized wasm runtime.');
    }
    const evaluationReceiveTs = nowTraceTs();
    const incomingDebug = cloneDebugTiming(payload?.__debugTiming);
    const debugTiming = runtime.lastSetStateDebug || incomingDebug || null;
    if (debugTiming) {
      debugTiming.worker = {
        ...(debugTiming.worker || {}),
        evaluateReceivedTs: evaluationReceiveTs,
      };
    }
    const { result } = evaluateCurrentState(compareMode, debugTiming);
    const influencePreview = buildInfluencePreviewPayload(payload?.previewInfluence, result);
    postEvaluation(compareMode, result, debugTiming, null, influencePreview);
  },
  previewInfluence(payload) {
    if (!runtime.assets.manifest || !runtime.assets.parameterMetadata) {
      throw new Error('previewInfluence requires loaded assets.');
    }
    if (!runtime.wasmRuntime) {
      throw new Error('previewInfluence requires an initialized wasm runtime.');
    }
    const previewId = Number(payload?.previewId || 0);
    const parameterKey = String(payload?.parameterKey || '').trim();
    const stateSection = String(payload?.stateSection || '').trim();
    const revision = Number(payload?.revision || runtime.revision || 0);
    const parameter = runtime.assets.parameterByKey?.get(parameterKey) || null;
    if (!parameter) {
      throw new Error(`previewInfluence parameter not found: ${parameterKey}`);
    }
    if (stateSection && String(parameter.stateSection || '').trim() !== stateSection) {
      throw new Error(`previewInfluence section mismatch for ${parameterKey}`);
    }
    const currentValue = getStateValue(runtime.state, parameter);
    const delta = choosePreviewDelta(parameter, currentValue);
    const previewState = cloneStateTree(runtime.state);
    const sectionKey = String(parameter.stateSection || '').trim();
    const nextValue = clampToParameter(parameter, currentValue + delta);
    if (!previewState[sectionKey]) {
      previewState[sectionKey] = {};
    }
    previewState[sectionKey][parameterKey] = nextValue;

    const { result: baseResult } = evaluateStateValue(runtime.state, null);
    const { result: previewResult } = evaluateStateValue(previewState, null);
    const vertexCount = Number(baseResult?.counts?.vertexCount || 0);
    const { magnitudes, maxMagnitude } = buildPreviewDeformationMagnitudes(
      baseResult.vertices,
      previewResult.vertices,
      runtime.assets.previewEdges,
      vertexCount,
    );
    post('influencePreview', {
      previewId,
      parameterKey,
      stateSection: sectionKey,
      revision,
      vertexCount,
      maxMagnitude,
      appliedDelta: nextValue - currentValue,
      magnitudes,
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
