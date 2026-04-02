function assertNumeric(value, label) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`${label} must be numeric.`);
  }
  return value;
}

function assignNamedValues(payload, sectionName, lookup, target) {
  if (!payload) {
    return;
  }
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${sectionName} must be an object.`);
  }
  for (const [key, rawValue] of Object.entries(payload)) {
    if (!(key in lookup)) {
      throw new Error(`Unknown ${sectionName} parameter: ${key}`);
    }
    target[lookup[key]] = assertNumeric(rawValue, `${sectionName}.${key}`);
  }
}

export function buildRawInputs(parameterMetadata, statePatch = {}) {
  if (!parameterMetadata || typeof parameterMetadata !== 'object') {
    throw new Error('parameterMetadata is required.');
  }
  const counts = parameterMetadata.counts || {};
  const sections = parameterMetadata.sections || {};
  const modelParameters = new Float32Array(counts.modelParameterCount || 0);
  const identity = new Float32Array(counts.identityCount || 0);
  const expression = new Float32Array(counts.expressionCount || 0);

  const rootState = { ...(statePatch.root || {}) };
  delete rootState.compareMode;
  delete rootState.activePreset;

  assignNamedValues(rootState, 'root', sections.root || {}, modelParameters);
  assignNamedValues(statePatch.pose || {}, 'pose', sections.pose || {}, modelParameters);
  assignNamedValues(
    statePatch.skeletalProportion || {},
    'skeletalProportion',
    sections.skeletalProportion || {},
    modelParameters,
  );
  assignNamedValues(
    statePatch.surfaceShape || {},
    'surfaceShape',
    sections.surfaceShape || {},
    identity,
  );
  assignNamedValues(
    statePatch.expression || {},
    'expression',
    sections.expression || {},
    expression,
  );

  const expertRaw = statePatch.expertRaw || null;
  if (expertRaw != null) {
    if (typeof expertRaw !== 'object' || Array.isArray(expertRaw)) {
      throw new Error('expertRaw must be an object.');
    }
    assignNamedValues(
      expertRaw.modelParameters || {},
      'expertRaw.modelParameters',
      {
        ...(sections.root || {}),
        ...(sections.pose || {}),
        ...(sections.skeletalProportion || {}),
      },
      modelParameters,
    );
    assignNamedValues(
      expertRaw.identity || {},
      'expertRaw.identity',
      sections.surfaceShape || {},
      identity,
    );
    assignNamedValues(
      expertRaw.expression || {},
      'expertRaw.expression',
      sections.expression || {},
      expression,
    );
  }

  return Object.freeze({
    modelParameters,
    identity,
    expression,
  });
}

export function buildZeroStatePatch(parameterMetadata) {
  const patch = {
    root: {},
    pose: {},
    surfaceShape: {},
    skeletalProportion: {},
    expression: {},
    expertRaw: {},
  };
  const parameters = Array.isArray(parameterMetadata?.parameters)
    ? parameterMetadata.parameters
    : [];
  for (const parameter of parameters) {
    const stateSection = parameter?.stateSection;
    const key = parameter?.key;
    if (typeof key !== 'string' || !key) {
      continue;
    }
    if (stateSection === 'root') {
      patch.root[key] = 0;
    } else if (stateSection === 'pose') {
      patch.pose[key] = 0;
    } else if (stateSection === 'skeletalProportion') {
      patch.skeletalProportion[key] = 0;
    } else if (stateSection === 'surfaceShape') {
      patch.surfaceShape[key] = 0;
    } else if (stateSection === 'expression') {
      patch.expression[key] = 0;
    }
  }
  return patch;
}
