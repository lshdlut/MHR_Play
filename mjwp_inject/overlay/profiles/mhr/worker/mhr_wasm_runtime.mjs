const SCALAR_TYPES = Object.freeze({
  float32: 1,
  uint32: 2,
  int32: 3,
  int64: 4,
  uint8: 5,
});

const ARRAY_VIEW_SIZE = 24;
const BUNDLE_VIEW_SIZE = 12;
const MODEL_COUNTS_SIZE = 40;
const DERIVED_VALUE_COUNT = 7;
const DEBUG_TIMING_VALUE_COUNT = 6;

function nowMs() {
  return performance.now();
}

function dataView(module) {
  return new DataView(module.HEAPU8.buffer);
}

function writeCString(module, allocations, text) {
  const bytes = new TextEncoder().encode(`${text}\0`);
  const ptr = module._malloc(bytes.length);
  module.HEAPU8.set(bytes, ptr);
  allocations.push(ptr);
  return ptr;
}

function writeShape(module, allocations, shape) {
  const ptr = module._malloc(shape.length * 8);
  const view = dataView(module);
  shape.forEach((dimension, index) => {
    view.setBigUint64(ptr + index * 8, BigInt(dimension), true);
  });
  allocations.push(ptr);
  return ptr;
}

function writeArrayView(module, ptr, descriptor) {
  const view = dataView(module);
  view.setUint32(ptr + 0, descriptor.keyPtr, true);
  view.setUint32(ptr + 4, descriptor.dataPtr, true);
  view.setUint32(ptr + 8, descriptor.byteLength, true);
  view.setInt32(ptr + 12, descriptor.scalarType, true);
  view.setUint32(ptr + 16, descriptor.rank, true);
  view.setUint32(ptr + 20, descriptor.shapePtr, true);
}

function writeBundleView(module, ptr, arrayCount, arraysPtr) {
  const view = dataView(module);
  view.setUint32(ptr + 0, 1, true);
  view.setUint32(ptr + 4, arrayCount, true);
  view.setUint32(ptr + 8, arraysPtr, true);
}

function readCounts(module, ptr) {
  const view = dataView(module);
  return {
    vertexCount: view.getUint32(ptr + 0, true),
    faceCount: view.getUint32(ptr + 4, true),
    jointCount: view.getUint32(ptr + 8, true),
    maxInfluenceCount: view.getUint32(ptr + 12, true),
    modelParameterCount: view.getUint32(ptr + 16, true),
    identityCount: view.getUint32(ptr + 20, true),
    expressionCount: view.getUint32(ptr + 24, true),
    parameterInputCount: view.getUint32(ptr + 28, true),
    poseFeatureCount: view.getUint32(ptr + 32, true),
    hiddenCount: view.getUint32(ptr + 36, true),
  };
}

function readDebugTiming(ptr, module) {
  const heapView = new Float32Array(module.HEAPU8.buffer, ptr, DEBUG_TIMING_VALUE_COUNT);
  return {
    resetStateMs: heapView[0] || 0,
    parameterUploadMs: heapView[1] || 0,
    evaluateCoreMs: heapView[2] || 0,
    verticesExportMs: heapView[3] || 0,
    skeletonExportMs: heapView[4] || 0,
    derivedExportMs: heapView[5] || 0,
  };
}

async function importRuntimeFactory() {
  const moduleRef = await import(new URL('./mhr_runtime_wasm.gen.mjs', import.meta.url).href);
  return moduleRef.default;
}

export async function createMhrWasmRuntime() {
  const createModule = await importRuntimeFactory();
  const module = await createModule();

  const api = {
    modelLoadIr: module.cwrap('mhr_model_load_ir', 'number', ['number']),
    modelDestroy: module.cwrap('mhr_model_destroy', null, ['number']),
    modelLastError: module.cwrap('mhr_model_last_error', 'number', ['number']),
    modelGetCounts: module.cwrap('mhr_model_get_counts', 'number', ['number', 'number']),
    dataCreate: module.cwrap('mhr_data_create', 'number', ['number']),
    dataDestroy: module.cwrap('mhr_data_destroy', null, ['number']),
    dataLastError: module.cwrap('mhr_data_last_error', 'number', ['number']),
    dataReset: module.cwrap('mhr_data_reset', 'number', ['number', 'number']),
    dataSetModelParameters: module.cwrap('mhr_data_set_model_parameters', 'number', ['number', 'number', 'number', 'number']),
    dataSetIdentity: module.cwrap('mhr_data_set_identity', 'number', ['number', 'number', 'number', 'number']),
    dataSetExpression: module.cwrap('mhr_data_set_expression', 'number', ['number', 'number', 'number', 'number']),
    forward: module.cwrap('mhr_forward', 'number', ['number', 'number', 'number']),
    getDebugTiming: module.cwrap('mhr_get_debug_timing', 'number', ['number', 'number']),
    getVertices: module.cwrap('mhr_get_vertices', 'number', ['number', 'number', 'number', 'number']),
    getSkeleton: module.cwrap('mhr_get_skeleton', 'number', ['number', 'number', 'number', 'number']),
    getDerived: module.cwrap('mhr_get_derived', 'number', ['number', 'number', 'number', 'number']),
  };

  let bundleAllocations = [];
  let bundleCounts = null;
  let modelPtr = 0;
  let dataPtr = 0;

  function modelLastError() {
    if (!modelPtr) {
      return 'unknown wasm model error';
    }
    const errorPtr = api.modelLastError(modelPtr);
    return errorPtr ? module.UTF8ToString(errorPtr) : 'unknown wasm model error';
  }

  function dataLastError() {
    if (!dataPtr) {
      return 'unknown wasm data error';
    }
    const errorPtr = api.dataLastError(dataPtr);
    return errorPtr ? module.UTF8ToString(errorPtr) : 'unknown wasm data error';
  }

  function ensureOk(result, label, errorGetter = dataLastError) {
    if (result === 1) {
      return;
    }
    throw new Error(`${label} failed: ${errorGetter()}`);
  }

  function freeAllocations(list) {
    for (const ptr of list.splice(0)) {
      module._free(ptr);
    }
  }

  function currentModelPtr() {
    if (!modelPtr) {
      throw new Error('MHR wasm model is not loaded.');
    }
    return modelPtr;
  }

  function currentDataPtr() {
    if (!dataPtr) {
      throw new Error('MHR wasm data is not created.');
    }
    return dataPtr;
  }

  function loadIr(manifest, chunkMap) {
    if (dataPtr) {
      api.dataDestroy(dataPtr);
      dataPtr = 0;
    }
    if (modelPtr) {
      api.modelDestroy(modelPtr);
      modelPtr = 0;
    }
    freeAllocations(bundleAllocations);
    const allocations = [];
    const arraysPtr = module._malloc(manifest.chunks.length * ARRAY_VIEW_SIZE);
    allocations.push(arraysPtr);
    const bundleViewPtr = module._malloc(BUNDLE_VIEW_SIZE);
    allocations.push(bundleViewPtr);

    manifest.chunks.forEach((chunk, index) => {
      const chunkEntry = chunkMap[chunk.key];
      if (!chunkEntry) {
        throw new Error(`Missing chunk bytes for ${chunk.key}`);
      }
      const keyPtr = writeCString(module, allocations, chunk.key);
      const shapePtr = writeShape(module, allocations, chunk.shape);
      const bytes = chunkEntry.bytes;
      const chunkDataPtr = module._malloc(bytes.byteLength);
      allocations.push(chunkDataPtr);
      module.HEAPU8.set(bytes, chunkDataPtr);
      writeArrayView(module, arraysPtr + index * ARRAY_VIEW_SIZE, {
        keyPtr,
        dataPtr: chunkDataPtr,
        byteLength: bytes.byteLength,
        scalarType: SCALAR_TYPES[chunk.dtype],
        rank: chunk.shape.length,
        shapePtr,
      });
    });

    writeBundleView(module, bundleViewPtr, manifest.chunks.length, arraysPtr);
    modelPtr = api.modelLoadIr(bundleViewPtr);
    if (!modelPtr) {
      throw new Error('mhr_model_load_ir failed: null model pointer');
    }

    const countsPtr = module._malloc(MODEL_COUNTS_SIZE);
    allocations.push(countsPtr);
    ensureOk(api.modelGetCounts(modelPtr, countsPtr), 'mhr_model_get_counts', modelLastError);
    bundleCounts = readCounts(module, countsPtr);
    dataPtr = api.dataCreate(modelPtr);
    if (!dataPtr) {
      throw new Error('mhr_data_create failed.');
    }
    bundleAllocations = allocations;
    return bundleCounts;
  }

  function writeFloatArray(values) {
    const bytes = values.length * Float32Array.BYTES_PER_ELEMENT;
    const ptr = module._malloc(bytes);
    const heapView = new Float32Array(module.HEAPU8.buffer, ptr, values.length);
    heapView.set(values);
    return ptr;
  }

  function readFloatArray(ptr, length) {
    const heapView = new Float32Array(module.HEAPU8.buffer, ptr, length);
    return new Float32Array(heapView);
  }

  function setRawInputs(rawInputs, bridgeTiming) {
    const allocations = [];
    try {
      const modelValuesPtr = writeFloatArray(rawInputs.modelParameters);
      allocations.push(modelValuesPtr);
      const modelStart = nowMs();
      ensureOk(
        api.dataSetModelParameters(currentModelPtr(), currentDataPtr(), modelValuesPtr, rawInputs.modelParameters.length),
        'mhr_data_set_model_parameters',
      );
      bridgeTiming.parameterUploadModelMs = nowMs() - modelStart;

      const identityPtr = writeFloatArray(rawInputs.identity);
      allocations.push(identityPtr);
      const identityStart = nowMs();
      ensureOk(
        api.dataSetIdentity(currentModelPtr(), currentDataPtr(), identityPtr, rawInputs.identity.length),
        'mhr_data_set_identity',
      );
      bridgeTiming.parameterUploadIdentityMs = nowMs() - identityStart;

      const expressionPtr = writeFloatArray(rawInputs.expression);
      allocations.push(expressionPtr);
      const expressionStart = nowMs();
      ensureOk(
        api.dataSetExpression(currentModelPtr(), currentDataPtr(), expressionPtr, rawInputs.expression.length),
        'mhr_data_set_expression',
      );
      bridgeTiming.parameterUploadExpressionMs = nowMs() - expressionStart;
    } finally {
      freeAllocations(allocations);
    }
  }

  function runEvaluate(rawInputs) {
    if (!bundleCounts) {
      throw new Error('runEvaluate requires a loaded IR.');
    }
    const bridgeTiming = {
      resetStateMs: 0,
      parameterUploadMs: 0,
      parameterUploadModelMs: 0,
      parameterUploadIdentityMs: 0,
      parameterUploadExpressionMs: 0,
      evaluateCallMs: 0,
      verticesExportMs: 0,
      skeletonExportMs: 0,
      derivedExportMs: 0,
    };

    const resetStart = nowMs();
    ensureOk(api.dataReset(currentModelPtr(), currentDataPtr()), 'mhr_data_reset');
    bridgeTiming.resetStateMs = nowMs() - resetStart;

    const uploadStart = nowMs();
    setRawInputs(rawInputs, bridgeTiming);
    bridgeTiming.parameterUploadMs = nowMs() - uploadStart;

    const evaluateStart = nowMs();
    ensureOk(api.forward(currentModelPtr(), currentDataPtr(), 0), 'mhr_forward');
    bridgeTiming.evaluateCallMs = nowMs() - evaluateStart;

    const allocations = [];
    try {
      const vertexLength = bundleCounts.vertexCount * 3;
      const skeletonLength = bundleCounts.jointCount * 8;
      const derivedLength = DERIVED_VALUE_COUNT;

      const verticesPtr = module._malloc(vertexLength * 4);
      const skeletonPtr = module._malloc(skeletonLength * 4);
      const derivedPtr = module._malloc(derivedLength * 4);
      const debugTimingPtr = module._malloc(DEBUG_TIMING_VALUE_COUNT * 4);
      allocations.push(verticesPtr, skeletonPtr, derivedPtr, debugTimingPtr);

      const verticesExportStart = nowMs();
      ensureOk(api.getVertices(currentModelPtr(), currentDataPtr(), verticesPtr, vertexLength), 'mhr_get_vertices');
      bridgeTiming.verticesExportMs = nowMs() - verticesExportStart;

      const skeletonExportStart = nowMs();
      ensureOk(api.getSkeleton(currentModelPtr(), currentDataPtr(), skeletonPtr, skeletonLength), 'mhr_get_skeleton');
      bridgeTiming.skeletonExportMs = nowMs() - skeletonExportStart;

      const derivedExportStart = nowMs();
      ensureOk(api.getDerived(currentModelPtr(), currentDataPtr(), derivedPtr, derivedLength), 'mhr_get_derived');
      bridgeTiming.derivedExportMs = nowMs() - derivedExportStart;

      ensureOk(api.getDebugTiming(currentDataPtr(), debugTimingPtr), 'mhr_get_debug_timing');

      return {
        counts: bundleCounts,
        vertices: readFloatArray(verticesPtr, vertexLength),
        skeleton: readFloatArray(skeletonPtr, skeletonLength),
        derived: readFloatArray(derivedPtr, derivedLength),
        debugTiming: {
          bridge: bridgeTiming,
          native: readDebugTiming(debugTimingPtr, module),
        },
      };
    } finally {
      freeAllocations(allocations);
    }
  }

  function dispose() {
    freeAllocations(bundleAllocations);
    bundleAllocations = [];
    if (dataPtr) {
      api.dataDestroy(dataPtr);
      dataPtr = 0;
    }
    if (modelPtr) {
      api.modelDestroy(modelPtr);
      modelPtr = 0;
    }
  }

  return {
    loadIr,
    runEvaluate,
    dispose,
    counts: () => bundleCounts,
  };
}
