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

  function loadIr(manifest, chunkMap) {
    if (modelPtr) {
      api.modelDestroy(modelPtr);
      modelPtr = 0;
    }
    if (dataPtr) {
      api.dataDestroy(dataPtr);
      dataPtr = 0;
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

  function setRawInputs(rawInputs) {
    const allocations = [];
    try {
      const modelValuesPtr = writeFloatArray(rawInputs.modelParameters);
      allocations.push(modelValuesPtr);
      ensureOk(
        api.dataSetModelParameters(windowModelPtr(), dataPtr, modelValuesPtr, rawInputs.modelParameters.length),
        'mhr_data_set_model_parameters',
      );
      const identityPtr = writeFloatArray(rawInputs.identity);
      allocations.push(identityPtr);
      ensureOk(
        api.dataSetIdentity(windowModelPtr(), dataPtr, identityPtr, rawInputs.identity.length),
        'mhr_data_set_identity',
      );
      const expressionPtr = writeFloatArray(rawInputs.expression);
      allocations.push(expressionPtr);
      ensureOk(
        api.dataSetExpression(windowModelPtr(), dataPtr, expressionPtr, rawInputs.expression.length),
        'mhr_data_set_expression',
      );
    } finally {
      freeAllocations(allocations);
    }
  }

  function windowModelPtr() {
    if (!modelPtr) {
      throw new Error('MHR wasm model is not loaded.');
    }
    return modelPtr;
  }

  function runEvaluate(rawInputs) {
    if (!bundleCounts) {
      throw new Error('runEvaluate requires a loaded bundle.');
    }
    ensureOk(api.dataReset(windowModelPtr(), dataPtr), 'mhr_data_reset');
    setRawInputs(rawInputs);
    ensureOk(api.forward(windowModelPtr(), dataPtr, 0), 'mhr_forward');

    const allocations = [];
    try {
      const vertexLength = bundleCounts.vertexCount * 3;
      const skeletonLength = bundleCounts.jointCount * 8;
      const derivedLength = DERIVED_VALUE_COUNT;
      const debugTimingLength = DEBUG_TIMING_VALUE_COUNT;

      const verticesPtr = module._malloc(vertexLength * 4);
      const skeletonPtr = module._malloc(skeletonLength * 4);
      const derivedPtr = module._malloc(derivedLength * 4);
      const debugTimingPtr = module._malloc(debugTimingLength * 4);
      allocations.push(verticesPtr, skeletonPtr, derivedPtr, debugTimingPtr);

      ensureOk(api.getDebugTiming(dataPtr, debugTimingPtr), 'mhr_get_debug_timing');
      ensureOk(api.getVertices(windowModelPtr(), dataPtr, verticesPtr, vertexLength), 'mhr_get_vertices');
      ensureOk(api.getSkeleton(windowModelPtr(), dataPtr, skeletonPtr, skeletonLength), 'mhr_get_skeleton');
      ensureOk(api.getDerived(windowModelPtr(), dataPtr, derivedPtr, derivedLength), 'mhr_get_derived');

      return {
        counts: bundleCounts,
        vertices: readFloatArray(verticesPtr, vertexLength),
        skeleton: readFloatArray(skeletonPtr, skeletonLength),
        derived: readFloatArray(derivedPtr, derivedLength),
        debugTiming: readFloatArray(debugTimingPtr, debugTimingLength),
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
