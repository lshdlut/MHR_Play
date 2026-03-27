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
  let currentAssetConfig = normalizeAssetConfig(assetConfig || {});
  let lastSnapshot = cloneSnapshot(DEFAULT_SNAPSHOT);

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

  const workerHandlers = {
    ready(payload) {
      applyMutation((draft) => {
        draft.status = 'ready';
        draft.contractVersion = payload.contractVersion || 'draft';
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
        };
      });
    },
    stateUpdated(payload) {
      applyMutation((draft) => {
        draft.status = 'state-updated';
        draft.state = mergeMhrState(draft.state, payload.state || {});
        draft.revision = payload.revision || draft.revision;
      });
    },
    evaluation(payload) {
      applyMutation((draft) => {
        draft.status = 'evaluated';
        draft.evaluation = payload.evaluation || null;
      });
    },
    presetApplied(payload) {
      applyMutation((draft) => {
        draft.status = `preset:${payload.presetId || 'unknown'}`;
      });
    },
    sweepProgress(payload) {
      applyMutation((draft) => {
        draft.status = `sweep:${payload.phase || 'running'}`;
      });
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
    const payload = normalizeAssetConfig(assetConfig || currentAssetConfig);
    if (!payload.manifestUrl) {
      throw new Error('loadAssets requires assetConfig.manifestUrl.');
    }
    currentAssetConfig = payload;
    ensureWorker().postMessage(
      encodeCommand('loadAssets', {
        assetConfig: payload,
      }),
    );
    return snapshot();
  }

  async function setState(statePatch = {}) {
    ensureWorker().postMessage(encodeCommand('setState', { statePatch }));
    return snapshot();
  }

  async function evaluate(options = {}) {
    ensureWorker().postMessage(encodeCommand('evaluate', options));
    return snapshot();
  }

  async function applyPreset(presetId) {
    ensureWorker().postMessage(encodeCommand('applyPreset', { presetId: String(presetId || '') }));
    return snapshot();
  }

  async function runSweep(sweepId) {
    ensureWorker().postMessage(encodeCommand('runSweep', { sweepId: String(sweepId || '') }));
    return snapshot();
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
