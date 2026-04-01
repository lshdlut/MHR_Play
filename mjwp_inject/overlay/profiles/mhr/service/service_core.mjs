import { createBackend as createMhrBackend } from '../backend/backend_core.mjs';

const EMPTY_STATE = Object.freeze({
  root: {},
  pose: {},
  surfaceShape: {},
  skeletalProportion: {},
  expression: {},
  expertRaw: {},
});

const DISPLAY_COMPARE_MODE = 'both';
const MHR_TO_MJ_UP_ALIGNMENT_RX = Math.PI * 0.5;
const ROOT_TRANSLATION_DEFAULTS = Object.freeze({
  root_ty: -9.2,
  root_tz: 10.0,
  translateY: -9.2,
  translateZ: 10.0,
});

function cloneEmptyPatch() {
  return {
    root: {},
    pose: {},
    surfaceShape: {},
    skeletalProportion: {},
    expression: {},
    expertRaw: {},
  };
}

function hasPatchValues(patch) {
  return Object.values(patch || {}).some((section) => section && Object.keys(section).length > 0);
}

function mergePatch(target, patch) {
  for (const key of Object.keys(EMPTY_STATE)) {
    const incoming = patch?.[key];
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      continue;
    }
    Object.assign(target[key], incoming);
  }
}

function isRuntimeUpAlignmentParameter(parameter) {
  if (!parameter || typeof parameter !== 'object') {
    return false;
  }
  const stateSection = String(parameter.stateSection || '');
  const key = String(parameter.key || '');
  return (
    (stateSection === 'root' && key === 'root_rx')
    || (stateSection === 'pose' && key === 'rootPitch')
  );
}

function supportsRuntimeUpAlignment(parameter) {
  if (!isRuntimeUpAlignmentParameter(parameter)) {
    return false;
  }
  const min = Number(parameter.min);
  const max = Number(parameter.max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return true;
  }
  return min <= MHR_TO_MJ_UP_ALIGNMENT_RX && max >= MHR_TO_MJ_UP_ALIGNMENT_RX;
}

function clampToParameter(parameter, value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return Number(parameter?.default) || 0;
  }
  const min = Number(parameter?.min);
  const max = Number(parameter?.max);
  let next = numeric;
  if (Number.isFinite(min)) next = Math.max(min, next);
  if (Number.isFinite(max)) next = Math.min(max, next);
  return next;
}

function getParameterDefaultValue(parameter) {
  const fallback = Number(parameter?.default) || 0;
  const key = String(parameter?.key || '');
  if (Object.prototype.hasOwnProperty.call(ROOT_TRANSLATION_DEFAULTS, key)) {
    return clampToParameter(parameter, ROOT_TRANSLATION_DEFAULTS[key]);
  }
  if (!supportsRuntimeUpAlignment(parameter)) {
    return fallback;
  }
  return clampToParameter(parameter, MHR_TO_MJ_UP_ALIGNMENT_RX);
}

function buildDefaultsPatch(parameters) {
  const patch = cloneEmptyPatch();
  for (const parameter of parameters || []) {
    const section = patch[parameter.stateSection];
    if (!section) continue;
    section[parameter.key] = getParameterDefaultValue(parameter);
  }
  patch.root.compareMode = DISPLAY_COMPARE_MODE;
  return patch;
}

export async function createMhrService({ runtimeConfig = null, assetConfig = null } = {}) {
  const backend = await createMhrBackend({
    runtimeConfig,
    assetConfig,
  });

  let disposed = false;
  let pendingPatch = cloneEmptyPatch();
  let flushTaskActive = false;
  let flushRequested = false;
  let pendingTrace = null;
  let pendingPreviewInfluence = null;
  let queue = Promise.resolve();

  const readyPromise = (async () => {
    const current = backend.snapshot()?.mhr || null;
    if (!current?.assets && assetConfig?.manifestUrl) {
      await backend.loadAssets(assetConfig);
    }
    const afterLoad = backend.snapshot()?.mhr || null;
    const parameters = Array.isArray(afterLoad?.assets?.parameterMetadata?.parameters)
      ? afterLoad.assets.parameterMetadata.parameters
      : [];
    if (afterLoad?.assets && !afterLoad?.evaluation) {
      const defaultsPatch = buildDefaultsPatch(parameters);
      await backend.applyStateAndEvaluate(defaultsPatch, { compareMode: DISPLAY_COMPARE_MODE });
    }
  })();

  function serial(task) {
    queue = queue.then(task, task);
    return queue;
  }

  function kickFlushLoop() {
    if (flushTaskActive || disposed) {
      flushRequested = true;
      return queue;
    }
    flushTaskActive = true;
    queue = serial(async () => {
      try {
        await readyPromise;
        do {
          flushRequested = false;
          const patch = pendingPatch;
          const trace = pendingTrace || null;
          const previewInfluence = pendingPreviewInfluence || null;
          pendingPatch = cloneEmptyPatch();
          pendingTrace = null;
          pendingPreviewInfluence = null;
          if (!hasPatchValues(patch) || disposed) {
            continue;
          }
          await backend.applyStateAndEvaluate(patch, {
            compareMode: DISPLAY_COMPARE_MODE,
            ...(previewInfluence ? { previewInfluence } : {}),
            ...(trace ? { __debugTiming: trace } : {}),
          });
        } while (flushRequested || hasPatchValues(pendingPatch));
      } finally {
        flushTaskActive = false;
        if (!disposed && (flushRequested || hasPatchValues(pendingPatch))) {
          kickFlushLoop();
        }
      }
    });
    return queue;
  }

  async function applyPatch(statePatch = {}, options = {}) {
    const interactive = options?.interactive === true;
    const trace = options?.__debugTiming || null;
    if (disposed) {
      throw new Error('mhr service is disposed');
    }
    if (interactive) {
      await readyPromise;
      backend.applyInteractiveStateAndEvaluate(statePatch, {
        compareMode: DISPLAY_COMPARE_MODE,
        ...(options?.previewInfluence ? { previewInfluence: options.previewInfluence } : {}),
        ...(trace ? { __debugTiming: trace } : {}),
      });
      return null;
    }
    mergePatch(pendingPatch, statePatch);
    pendingPreviewInfluence = options?.previewInfluence || pendingPreviewInfluence;
    if (trace) {
      pendingTrace = trace;
    }
    flushRequested = true;
    return kickFlushLoop();
  }

  function snapshot() {
    return backend.snapshot();
  }

  function subscribe(listener) {
    return backend.subscribe(listener);
  }

  function hasPendingCommit() {
    return flushTaskActive || flushRequested || hasPatchValues(pendingPatch);
  }

  function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    backend.dispose?.();
  }

  return {
    kind: 'mhr-service',
    snapshot,
    subscribe,
    applyPatch,
    hasPendingCommit,
    ready: () => readyPromise,
    dispose,
  };
}
