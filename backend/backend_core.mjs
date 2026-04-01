import { encodeCommand, dispatchEvent } from '../worker/dispatch.gen.mjs';
import { normalizeAssetConfig } from '../core/runtime_config.mjs';
import { logWarn } from '../core/viewer_runtime.mjs';

const EMPTY_STATE = Object.freeze({
  root: {},
  pose: {},
  surfaceShape: {},
  skeletalProportion: {},
  expression: {},
  expertRaw: {},
});

const DEFAULT_SNAPSHOT = Object.freeze({
  status: 'booting',
  assets: null,
  state: EMPTY_STATE,
  evaluation: null,
  diagnostics: [],
  revision: 0,
});

function cloneSnapshot(snapshot) {
  if (typeof structuredClone === 'function') {
    return structuredClone(snapshot);
  }
  return JSON.parse(JSON.stringify(snapshot));
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

export async function createBackend({ runtimeConfig, assetConfig = null } = {}) {
  const listeners = new Set();
  let client = null;
  let currentAssetConfig = normalizeAssetConfig(assetConfig || {}, globalThis);
  let lastSnapshot = cloneSnapshot(DEFAULT_SNAPSHOT);
  const pendingByEvent = new Map();

  function snapshot() {
    return cloneSnapshot(lastSnapshot);
  }

  function notify() {
    for (const fn of listeners) {
      fn(snapshot());
    }
  }

  function applyMutation(mutator) {
    const draft = cloneSnapshot(lastSnapshot);
    mutator(draft);
    lastSnapshot = draft;
    notify();
    return lastSnapshot;
  }

  function enqueuePending(eventName) {
    return new Promise((resolve, reject) => {
      const queue = pendingByEvent.get(eventName) || [];
      queue.push({ resolve, reject });
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
    next?.resolve?.(payload);
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
        draft.status = 'ready';
        draft.contractVersion = payload.contractVersion || 'v1';
        draft.capabilities = payload.capabilities || {};
      });
    },
    assetsLoaded(payload) {
      applyMutation((draft) => {
        draft.status = 'assets-loaded';
        draft.assets = {
          bundleId: payload.bundleId,
          manifestUrl: payload.manifestUrl || '',
          assetBaseUrl: payload.assetBaseUrl || '',
          parameterCount: payload.parameterCount || 0,
          counts: payload.counts || null,
          topology: payload.topology || null,
          jointParents: payload.jointParents || null,
          parameterMetadata: payload.parameterMetadata || null,
        };
      });
      resolvePending('assetsLoaded', snapshot());
    },
    stateUpdated(payload) {
      applyMutation((draft) => {
        draft.status = 'state-updated';
        draft.state = mergeMhrState(draft.state, payload.state || {});
        draft.revision = payload.revision || draft.revision;
      });
      resolvePending('stateUpdated', snapshot());
    },
    evaluation(payload) {
      applyMutation((draft) => {
        draft.status = 'evaluated';
        draft.evaluation = payload.evaluation || null;
      });
      resolvePending('evaluation', snapshot());
    },
    presetApplied(payload) {
      applyMutation((draft) => {
        draft.status = `preset:${payload.presetId || 'unknown'}`;
      });
      resolvePending('presetApplied', snapshot());
    },
    sweepProgress(payload) {
      applyMutation((draft) => {
        draft.status = `sweep:${payload.phase || 'running'}`;
      });
      resolvePending('sweepProgress', snapshot());
    },
    diagnostic(payload) {
      applyMutation((draft) => {
        draft.diagnostics = [...(draft.diagnostics || []), payload];
      });
    },
    error(payload) {
      applyMutation((draft) => {
        draft.status = 'error';
        draft.diagnostics = [...(draft.diagnostics || []), payload];
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
    return snapshot().state;
  }

  async function loadAssets(assetConfig = {}) {
    const payload = normalizeAssetConfig(assetConfig || currentAssetConfig, globalThis);
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

  async function setState(statePatch = {}) {
    const pending = enqueuePending('stateUpdated');
    ensureWorker().postMessage(encodeCommand('setState', { statePatch }));
    return pending;
  }

  async function evaluate(options = {}) {
    const pending = enqueuePending('evaluation');
    ensureWorker().postMessage(encodeCommand('evaluate', options));
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
      logWarn('Failed to send dispose command before worker termination.', error);
    }
    client.terminate();
    client = null;
    if (disposeError) {
      throw disposeError;
    }
  }

  ensureWorker();

  return {
    kind: 'worker',
    loadAssets,
    setState,
    getState,
    evaluate,
    applyPreset,
    runSweep,
    snapshot,
    subscribe,
    dispose,
  };
}
