import { createInitialSnapshot } from '../../../backend/snapshot_utils.mjs';
import { logWarn } from '../core/viewer_runtime.mjs';
import { COMMAND_FIELDS, EVENT_FIELDS, WORKER_COMMANDS, WORKER_EVENTS } from '../worker/protocol.gen.mjs';
import { normalizeAssetConfig } from '../core/runtime_config.mjs';

const EMPTY_STATE = Object.freeze({
  root: {},
  pose: {},
  surfaceShape: {},
  skeletalProportion: {},
  expression: {},
  expertRaw: {},
});

const COMMAND_SET = new Set(WORKER_COMMANDS);
const EVENT_SET = new Set(WORKER_EVENTS);

function assertRequiredFields(label, payload, required) {
  if (!required || !required.length) {
    return;
  }
  const missing = [];
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) {
      missing.push(key);
    }
  }
  if (missing.length) {
    throw new Error(`${label} missing fields: ${missing.join(', ')}`);
  }
}

function encodeCommand(cmd, payload = {}) {
  if (!COMMAND_SET.has(cmd)) {
    throw new Error(`Unknown command: ${String(cmd)}`);
  }
  const body = payload && typeof payload === 'object' ? payload : {};
  assertRequiredFields(`Command ${cmd}`, body, COMMAND_FIELDS[cmd]?.required || []);
  return { cmd, ...body };
}

function dispatchEvent(handlers, message) {
  if (!message || typeof message !== 'object') {
    throw new Error('Event message must be an object.');
  }
  const kind = message.kind;
  if (!EVENT_SET.has(kind)) {
    throw new Error(`Unknown event: ${String(kind)}`);
  }
  const payload = { ...message };
  delete payload.kind;
  assertRequiredFields(`Event ${kind}`, payload, EVENT_FIELDS[kind]?.required || []);
  const handler = handlers?.[kind];
  if (typeof handler !== 'function') {
    throw new Error(`Unhandled event: ${kind}`);
  }
  return handler(payload, message);
}

function mergeMhrState(currentState, patch) {
  const next = { ...currentState };
  for (const key of Object.keys(EMPTY_STATE)) {
    const incoming = patch?.[key];
    if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
      next[key] = {
        ...(currentState[key] || {}),
        ...incoming,
      };
    }
  }
  return next;
}

function stripDebugPatch(statePatch) {
  if (!statePatch || typeof statePatch !== 'object' || Array.isArray(statePatch)) {
    return {};
  }
  const next = { ...statePatch };
  delete next.__debugTiming;
  return next;
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

function cloneAssetsView(assets) {
  if (!assets || typeof assets !== 'object') {
    return null;
  }
  return {
    ...assets,
    counts: assets.counts ? { ...assets.counts } : null,
    topology: assets.topology || null,
    jointParents: assets.jointParents || null,
    parameterMetadata: assets.parameterMetadata || null,
  };
}

function cloneDerivedView(derived) {
  if (!derived || typeof derived !== 'object') {
    return null;
  }
  return {
    ...derived,
    selectedOutputs: Array.isArray(derived.selectedOutputs) ? [...derived.selectedOutputs] : derived.selectedOutputs || null,
    rootTranslation: Array.isArray(derived.rootTranslation) ? [...derived.rootTranslation] : derived.rootTranslation || null,
    firstVertex: Array.isArray(derived.firstVertex) ? [...derived.firstVertex] : derived.firstVertex || null,
  };
}

function cloneDebugView(debug) {
  if (!debug || typeof debug !== 'object') {
    return null;
  }
  return JSON.parse(JSON.stringify(debug));
}

function cloneEvaluationView(evaluation) {
  if (!evaluation || typeof evaluation !== 'object') {
    return null;
  }
  return {
    ...evaluation,
    mesh: evaluation.mesh ? {
      ...evaluation.mesh,
      vertices: evaluation.mesh.vertices || null,
    } : null,
    skeleton: evaluation.skeleton ? {
      ...evaluation.skeleton,
      states: evaluation.skeleton.states || null,
    } : null,
    influencePreview: evaluation.influencePreview ? {
      ...evaluation.influencePreview,
      magnitudes: evaluation.influencePreview.magnitudes || null,
    } : null,
    derived: cloneDerivedView(evaluation.derived),
    debug: cloneDebugView(evaluation.debug),
  };
}

function cloneSnapshotView(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return snapshot;
  }
  return {
    ...snapshot,
    sceneFlags: Array.isArray(snapshot.sceneFlags) ? [...snapshot.sceneFlags] : snapshot.sceneFlags,
    info: snapshot.info ? { ...snapshot.info } : snapshot.info,
    mhr: snapshot.mhr ? {
      ...snapshot.mhr,
      assets: cloneAssetsView(snapshot.mhr.assets),
      state: cloneStateTree(snapshot.mhr.state),
      evaluation: cloneEvaluationView(snapshot.mhr.evaluation),
      diagnostics: Array.isArray(snapshot.mhr.diagnostics) ? [...snapshot.mhr.diagnostics] : [],
      capabilities: snapshot.mhr.capabilities ? { ...snapshot.mhr.capabilities } : snapshot.mhr.capabilities,
    } : snapshot.mhr,
  };
}

function createMutableSnapshot(snapshot) {
  return {
    ...snapshot,
    info: snapshot?.info ? { ...snapshot.info } : snapshot?.info,
    mhr: snapshot?.mhr ? {
      ...snapshot.mhr,
      diagnostics: Array.isArray(snapshot.mhr.diagnostics) ? [...snapshot.mhr.diagnostics] : [],
    } : snapshot?.mhr,
  };
}

function createDefaultSnapshot() {
  const snapshot = createInitialSnapshot();
  snapshot.paused = true;
  snapshot.pausedSource = 'mhr';
  snapshot.rateSource = 'mhr';
  snapshot.sceneFlags = (snapshot.sceneFlags || []).map((flag, index) => (index === 0 ? 0 : flag));
  snapshot.info = { ncon: 0, nefc: 0, energy: 0 };
  snapshot.mhr = {
    status: 'booting',
    assets: null,
    state: typeof structuredClone === 'function'
      ? structuredClone(EMPTY_STATE)
      : JSON.parse(JSON.stringify(EMPTY_STATE)),
    evaluation: null,
    diagnostics: [],
    revision: 0,
    contractVersion: 'v1',
    capabilities: null,
  };
  return snapshot;
}

export async function createBackend({ runtimeConfig = null, assetConfig = null } = {}) {
  const listeners = new Set();
  let client = null;
  let currentAssetConfig = normalizeAssetConfig(assetConfig || runtimeConfig?.assetConfig || {}, globalThis);
  let lastSnapshot = createDefaultSnapshot();
  const pendingByEvent = new Map();

  function snapshot() {
    return cloneSnapshotView(lastSnapshot);
  }

  function syncTraceFieldsIntoSnapshot(nextSnapshot, traceRef, patch) {
    if (!patch || typeof patch !== 'object') {
      return;
    }
    if (traceRef && typeof traceRef === 'object') {
      traceRef.mainThread = {
        ...(traceRef.mainThread || {}),
        ...patch,
      };
    }
    const snapshotTrace = nextSnapshot?.mhr?.evaluation?.debug?.debugTiming;
    if (snapshotTrace && typeof snapshotTrace === 'object') {
      snapshotTrace.mainThread = {
        ...(snapshotTrace.mainThread || {}),
        ...patch,
      };
    }
  }

  function notify(traceRef = null) {
    const cloneStart = performance.now();
    const nextSnapshot = snapshot();
    const cloneEnd = performance.now();
    syncTraceFieldsIntoSnapshot(nextSnapshot, traceRef, {
      snapshotCloneMs: cloneEnd - cloneStart,
    });
    const fanoutStart = performance.now();
    for (const fn of listeners) {
      fn(nextSnapshot);
    }
    const fanoutEnd = performance.now();
    if (traceRef && typeof traceRef === 'object') {
      traceRef.mainThread = {
        ...(traceRef.mainThread || {}),
        notifyListenersMs: fanoutEnd - fanoutStart,
        notifyCompleteTs: performance.timeOrigin + fanoutEnd,
      };
    }
  }

  function applyMutation(mutator, traceRef = null, beforeNotify = null) {
    const draft = createMutableSnapshot(lastSnapshot);
    mutator(draft);
    if (typeof beforeNotify === 'function') {
      beforeNotify(draft);
    }
    lastSnapshot = draft;
    notify(traceRef);
    return lastSnapshot;
  }

  function enqueuePending(eventName, projector = null) {
    return new Promise((resolve, reject) => {
      const queue = pendingByEvent.get(eventName) || [];
      queue.push({ resolve, reject, projector });
      pendingByEvent.set(eventName, queue);
    });
  }

  function resolvePending(eventName, payload) {
    const queue = pendingByEvent.get(eventName);
    if (!queue?.length) {
      return;
    }
    const next = queue.shift();
    if (!queue.length) {
      pendingByEvent.delete(eventName);
    }
    const value = typeof next?.projector === 'function'
      ? next.projector(payload)
      : payload;
    next?.resolve?.(value);
  }

  function rejectPending(eventName, error) {
    const queue = pendingByEvent.get(eventName);
    if (!queue?.length) {
      return;
    }
    pendingByEvent.delete(eventName);
    for (const entry of queue) {
      entry.reject(error);
    }
  }

  function rejectAllPending(payload) {
    const error = new Error(payload?.message || 'Worker command failed.');
    for (const eventName of [...pendingByEvent.keys()]) {
      rejectPending(eventName, error);
    }
  }

  const workerHandlers = {
    ready(payload) {
      applyMutation((draft) => {
        draft.mhr.status = 'ready';
        draft.mhr.contractVersion = payload.contractVersion || 'v1';
        draft.mhr.capabilities = payload.capabilities || {};
      });
    },
    assetsLoaded(payload) {
      applyMutation((draft) => {
        draft.mhr.status = 'assets-loaded';
        draft.mhr.assets = {
          bundleId: payload.bundleId,
          manifestUrl: payload.manifestUrl || '',
          assetBaseUrl: payload.assetBaseUrl || '',
          lod: Number.isInteger(payload.lod) ? payload.lod : null,
          parameterCount: payload.parameterCount || 0,
          counts: payload.counts || null,
          topology: payload.topology || null,
          jointParents: payload.jointParents || null,
          parameterMetadata: payload.parameterMetadata || null,
        };
        draft.ngeom = Number(payload?.counts?.vertexCount) || draft.ngeom || 0;
      });
      resolvePending('assetsLoaded', snapshot());
    },
    debugPong(payload) {
      resolvePending('debugPong', {
        mainSentTs: Number(payload?.mainSentTs || 0),
        workerReceiveTs: Number(payload?.workerReceiveTs || 0),
        workerDispatchTs: Number(payload?.workerDispatchTs || 0),
        mainReceiveTs: performance.timeOrigin + performance.now(),
      });
    },
    stateUpdated(payload) {
      applyMutation((draft) => {
        draft.mhr.status = 'state-updated';
        draft.mhr.state = mergeMhrState(draft.mhr.state || EMPTY_STATE, payload.state || {});
        draft.mhr.revision = payload.revision || draft.mhr.revision || 0;
      });
      resolvePending('stateUpdated', snapshot());
    },
    evaluation(payload) {
      const eventReceiveTs = performance.timeOrigin + performance.now();
      const traceRef = payload?.evaluation?.debug?.debugTiming && typeof payload.evaluation.debug.debugTiming === 'object'
        ? payload.evaluation.debug.debugTiming
        : null;
      if (traceRef) {
        traceRef.mainThread = {
          ...(traceRef.mainThread || {}),
          evaluationEventReceiveTs: eventReceiveTs,
        };
      }
      applyMutation((draft) => {
        draft.mhr.status = 'evaluated';
        draft.mhr.state = mergeMhrState(
          draft.mhr.state || EMPTY_STATE,
          stripDebugPatch(payload.appliedStatePatch || {}),
        );
        draft.mhr.revision = payload.revision || draft.mhr.revision || 0;
        draft.mhr.evaluation = payload.evaluation || null;
        const faceCount = Number(payload?.evaluation?.mesh?.faceCount) || 0;
        draft.ngeom = faceCount;
        draft.info = {
          ...(draft.info || {}),
          ncon: 0,
          nefc: faceCount,
          energy: Number(payload?.evaluation?.derived?.skeletonExtentY) || 0,
        };
      }, traceRef, () => {
        if (traceRef) {
          traceRef.mainThread = {
            ...(traceRef.mainThread || {}),
            eventApplyBeforeNotifyMs: (performance.timeOrigin + performance.now()) - eventReceiveTs,
          };
        }
      });
      if (traceRef) {
        traceRef.mainThread = {
          ...(traceRef.mainThread || {}),
          eventApplyAndPublishMs: (performance.timeOrigin + performance.now()) - eventReceiveTs,
        };
      }
      resolvePending('evaluation', snapshot());
    },
    influencePreview(payload) {
      applyMutation((draft) => {
        const previewRevision = Number(payload?.revision || 0);
        const currentRevision = Number(draft?.mhr?.revision || 0);
        if (previewRevision > 0 && currentRevision > 0 && previewRevision !== currentRevision) {
          return;
        }
        if (!draft.mhr.evaluation || typeof draft.mhr.evaluation !== 'object') {
          return;
        }
        draft.mhr.evaluation = {
          ...draft.mhr.evaluation,
          influencePreview: {
            previewId: Number(payload?.previewId || 0),
            parameterKey: String(payload?.parameterKey || ''),
            stateSection: String(payload?.stateSection || ''),
            revision: previewRevision,
            vertexCount: Number(payload?.vertexCount || 0),
            maxMagnitude: Number(payload?.maxMagnitude || 0),
            appliedDelta: Number(payload?.appliedDelta || 0),
            magnitudes: payload?.magnitudes || null,
          },
        };
      });
      resolvePending('influencePreview', {
        previewId: Number(payload?.previewId || 0),
        parameterKey: String(payload?.parameterKey || ''),
        stateSection: String(payload?.stateSection || ''),
        revision: Number(payload?.revision || 0),
        vertexCount: Number(payload?.vertexCount || 0),
        maxMagnitude: Number(payload?.maxMagnitude || 0),
        appliedDelta: Number(payload?.appliedDelta || 0),
        magnitudes: payload?.magnitudes || null,
      });
    },
    presetApplied(payload) {
      applyMutation((draft) => {
        draft.mhr.status = `preset:${payload.presetId || 'unknown'}`;
      });
      resolvePending('presetApplied', snapshot());
    },
    sweepProgress(payload) {
      applyMutation((draft) => {
        draft.mhr.status = `sweep:${payload.phase || 'running'}`;
      });
      resolvePending('sweepProgress', snapshot());
    },
    diagnostic(payload) {
      applyMutation((draft) => {
        draft.mhr.diagnostics = [...(draft.mhr.diagnostics || []), payload];
      });
    },
    error(payload) {
      applyMutation((draft) => {
        draft.mhr.status = 'error';
        draft.mhr.diagnostics = [...(draft.mhr.diagnostics || []), payload];
      });
      rejectAllPending(payload);
    },
  };

  function handleMessage(event) {
    const message = event?.data ?? event;
    if (!message || typeof message !== 'object') {
      return;
    }
    dispatchEvent(workerHandlers, message);
  }

  function ensureWorker() {
    if (client) {
      return client;
    }
    if (typeof Worker !== 'function') {
      throw new Error('Worker API is unavailable in this environment.');
    }
    const workerUrl = new URL('../worker/mhr.worker.mjs', import.meta.url);
    client = new Worker(workerUrl, { type: 'module' });
    client.addEventListener('message', handleMessage);
    client.addEventListener('error', (event) => {
      applyMutation((draft) => {
        draft.mhr.status = 'error';
        draft.mhr.diagnostics = [
          ...(draft.mhr.diagnostics || []),
          {
            code: 'worker_module_error',
            message: String(event?.message || 'Worker module failed to load or execute.'),
            filename: String(event?.filename || ''),
            lineno: Number(event?.lineno || 0),
            colno: Number(event?.colno || 0),
            stack: String(event?.error?.stack || event?.error || ''),
          },
        ];
      });
    });
    client.addEventListener('messageerror', () => {
      applyMutation((draft) => {
        draft.mhr.status = 'error';
        draft.mhr.diagnostics = [
          ...(draft.mhr.diagnostics || []),
          {
            code: 'worker_message_error',
            message: 'Worker emitted a message that could not be deserialized.',
          },
        ];
      });
    });
    client.postMessage(encodeCommand('init', { runtimeConfig }));
    return client;
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') {
      return () => {};
    }
    listeners.add(fn);
    fn(snapshot());
    return () => listeners.delete(fn);
  }

  function getState() {
    return cloneStateTree(lastSnapshot?.mhr?.state);
  }

  async function loadAssets(assetConfigArg = {}) {
    const payload = normalizeAssetConfig(assetConfigArg || currentAssetConfig, globalThis);
    if (!payload.manifestUrl) {
      throw new Error('loadAssets requires assetConfig.manifestUrl.');
    }
    currentAssetConfig = payload;
    const pending = enqueuePending('assetsLoaded');
    ensureWorker().postMessage(
      encodeCommand('loadAssets', {
        assetConfig: payload,
      }),
    );
    return pending;
  }

  async function debugPing(mainSentTs = performance.timeOrigin + performance.now()) {
    const pending = enqueuePending('debugPong');
    ensureWorker().postMessage(encodeCommand('debugPing', { mainSentTs }));
    return pending;
  }

  async function setState(statePatch = {}) {
    const pending = enqueuePending('stateUpdated');
    ensureWorker().postMessage(encodeCommand('setState', { statePatch }));
    return pending;
  }

  async function evaluate(options = {}) {
    const pending = enqueuePending('evaluation', (payload) => ({
      revision: payload?.revision || 0,
      status: 'evaluated',
    }));
    ensureWorker().postMessage(encodeCommand('evaluate', options));
    return pending;
  }

  async function applyStateAndEvaluate(statePatch = {}, options = {}) {
    const pending = enqueuePending('evaluation', (payload) => ({
      revision: payload?.revision || 0,
      status: 'evaluated',
    }));
    ensureWorker().postMessage(encodeCommand('applyStateAndEvaluate', {
      statePatch,
      ...options,
    }));
    return pending;
  }

  async function applyInteractiveStateAndEvaluate(statePatch = {}, options = {}) {
    const pending = enqueuePending('evaluation', (payload) => ({
      revision: payload?.revision || 0,
      status: 'evaluated',
    }));
    ensureWorker().postMessage(encodeCommand('applyStateAndEvaluate', {
      statePatch,
      interactive: true,
      ...options,
    }));
    return pending;
  }

  async function previewInfluence({ previewId = 0, parameterKey = '', stateSection = '', revision = 0 } = {}) {
    const pending = enqueuePending('influencePreview');
    ensureWorker().postMessage(encodeCommand('previewInfluence', {
      previewId: Number(previewId || 0),
      parameterKey: String(parameterKey || ''),
      stateSection: String(stateSection || ''),
      revision: Number(revision || 0),
    }));
    return pending;
  }

  async function applyPreset(presetId) {
    const pending = enqueuePending('presetApplied');
    ensureWorker().postMessage(encodeCommand('applyPreset', { presetId: String(presetId || '') }));
    return pending;
  }

  async function runSweep(sweepId) {
    const pending = enqueuePending('sweepProgress');
    ensureWorker().postMessage(encodeCommand('runSweep', { sweepId: String(sweepId || '') }));
    return pending;
  }

  function dispose() {
    if (!client) {
      return;
    }
    let disposeError = null;
    try {
      client.postMessage(encodeCommand('dispose'));
    } catch (error) {
      disposeError = error;
      logWarn('[mhr-backend] Failed to send dispose command before worker termination.', error);
    }
    client.terminate();
    client = null;
    if (disposeError) {
      throw disposeError;
    }
  }

  ensureWorker();

  return {
    kind: 'mhr-worker',
    loadAssets,
    debugPing,
    setState,
    applyStateAndEvaluate,
    applyInteractiveStateAndEvaluate,
    previewInfluence,
    getState,
    evaluate,
    applyPreset,
    runSweep,
    snapshot,
    subscribe,
    dispose,
    getStrictReport: () => null,
    getInitialModelInfo: () => ({
      file: currentAssetConfig.manifestUrl || null,
      label: Number.isInteger(currentAssetConfig.lod)
        ? `MHR profile (lod${currentAssetConfig.lod})`
        : 'MHR profile',
    }),
  };
}
