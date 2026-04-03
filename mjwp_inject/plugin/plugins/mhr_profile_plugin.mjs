import * as THREE from 'three';
import { getRuntimeConfig } from '../core/runtime_config.mjs';
import { loadRuntimeIrManifest } from '../profiles/mhr/core/asset_bundle.mjs';
import { buildViewerCameraPayload } from '../renderer/pipeline.mjs';
import { syncLabelOverlayViewport } from '../renderer/label_overlay.mjs';
import { switchVisualSourceMode } from '../ui/viewer_actions.mjs';
import { createMhrService } from '../profiles/mhr/service/service_core.mjs';

const EMPTY_STATE = Object.freeze({
  root: {},
  pose: {},
  surfaceShape: {},
  skeletalProportion: {},
  expression: {},
  expertRaw: {},
});

const DISPLAY_UNIT_SCALE_METERS = 0.01;
const MHR_TO_MJ_UP_ALIGNMENT_RX = Math.PI * 0.5;
const FIXED_SLOT_SLIDER_MIN = -Math.PI;
const FIXED_SLOT_SLIDER_MAX = Math.PI;
const FIXED_SLOT_SLIDER_STEP = 0.01;
const ROOT_TRANSLATION_DEFAULTS = Object.freeze({
  root_ty: -9.2,
  root_tz: 10.0,
  translateY: -9.2,
  translateZ: 10.0,
});
const SKELETON_BONE_RADIUS_RAW = 0.9;
const SKELETON_JOINT_RADIUS_RAW = 1.368;
const SKELETON_AXIS_LENGTH_RAW = 4.2;
const SKELETON_AXIS_RADIUS_RAW = 0.44;
const BLEND_BODY_REGION_END = 19;
const BLEND_FACE_REGION_END = 39;
const BLEND_HAND_REGION_END = 44;
const SUPPORTED_LODS = Object.freeze([0, 1, 2, 3, 4, 5, 6]);
const JOINT_LABEL_FONT_PX = 10;
const JOINT_LABEL_FONT = `${JOINT_LABEL_FONT_PX}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
const JOINT_LABEL_TEXT_COLOR = 'rgba(255, 255, 255, 0.96)';
const JOINT_LABEL_SHADOW_COLOR = 'rgba(0, 0, 0, 0.58)';
const SKIN_BASE_COLOR_HEX = 0x9ebcff;
const GHOST_MESH_OPACITY = 0.5;
const INFLUENCE_PREVIEW_MIN_NORMALIZED = 0.05;
const INFLUENCE_PREVIEW_SCALE_UP_ALPHA = 0.18;
const INFLUENCE_PREVIEW_SCALE_DOWN_ALPHA = 0.08;
const FAMILY_RANDOM_TARGET_FPS_TIERS = Object.freeze([60, 30, 15, 5]);
const FAMILY_RANDOM_DEFAULT_TARGET_FPS = 60;
const FAMILY_RANDOM_ROUNDTRIP_EMA_ALPHA = 0.24;
const FAMILY_RANDOM_TARGET_MAX_ROUNDTRIP_MS = Object.freeze({
  60: 45,
  30: 90,
  15: 180,
  5: Number.POSITIVE_INFINITY,
});
const FAMILY_RANDOM_DOWNSHIFT_STREAK = 6;
const FAMILY_RANDOM_UPSHIFT_STREAK = 10;
const FAMILY_RANDOM_TRANSITION_MIN_MS = 900;
const FAMILY_RANDOM_TRANSITION_MAX_MS = 1500;
const UI_BLEND_ABS_RANGE = 6.0;
const UI_EXPRESSION_ABS_RANGE = 2.0;
const UI_ROOT_TRANSLATION_ABS_RANGE = 30.0;
const UI_ROOT_ROTATION_ABS_RANGE = Math.PI * 3;
const FAMILY_RANDOM_BLEND_ABS_RADIUS = 6.0;
const FAMILY_RANDOM_BLEND_LEADING_ABS_RADIUS = 4.0;
const FAMILY_RANDOM_BLEND_LEADING_COUNT = 3;
const FAMILY_RANDOM_EXPRESSION_ABS_RADIUS = 1.0;
const FAMILY_RANDOM_POSE_RANGE_FRACTION = 0.42;
const FAMILY_RANDOM_FIXED_RANGE_FRACTION = 0.1;
const FAMILY_RANDOM_FIXED_ABS_RADIUS = 0.6;
const SKELETON_AXIS_Z = new THREE.Vector3(0, 0, 1);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const tempSkeletonChild = new THREE.Vector3();
const tempSkeletonParent = new THREE.Vector3();
const tempSkeletonMid = new THREE.Vector3();
const tempSkeletonDir = new THREE.Vector3();
const tempSkeletonQuat = new THREE.Quaternion();
const tempJointBaseQuat = new THREE.Quaternion();
const tempAxisStart = new THREE.Vector3();
const tempAxisEnd = new THREE.Vector3();
const tempAxisDir = new THREE.Vector3();
const tempLabelPosition = new THREE.Vector3();
const tempLabelScreen = new THREE.Vector3();
const skinBaseColor = new THREE.Color(SKIN_BASE_COLOR_HEX);
const tempPreviewColor = new THREE.Color();
const tempMeshColor = new THREE.Color();
const PERF_HUD_STALE_MS = 2000;
const PERF_HUD_WINDOW_MS = 1000;
const PERF_HUD_MAX_SAMPLES = 240;

function prunePerfHudSamples(samples, nowMs) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return samples;
  }
  while (samples.length > 0 && (nowMs - samples[0]) > PERF_HUD_WINDOW_MS) {
    samples.shift();
  }
  if (samples.length > PERF_HUD_MAX_SAMPLES) {
    samples.splice(0, samples.length - PERF_HUD_MAX_SAMPLES);
  }
  return samples;
}

function recordPerfHudSample(samples, nowMs) {
  if (!Array.isArray(samples)) {
    return;
  }
  samples.push(nowMs);
  prunePerfHudSamples(samples, nowMs);
}

function measurePerfHudFps(samples, nowMs) {
  if (!Array.isArray(samples) || samples.length < 2) {
    return 0;
  }
  prunePerfHudSamples(samples, nowMs);
  if (samples.length < 2) {
    return 0;
  }
  const start = samples[0];
  const end = samples[samples.length - 1];
  const spanMs = end - start;
  if (!(spanMs > 0)) {
    return 0;
  }
  return ((samples.length - 1) * 1000) / spanMs;
}

function formatHudFps(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0.05) {
    return '0 fps';
  }
  if (numeric < 10) {
    return `${numeric.toFixed(1)} fps`;
  }
  return `${Math.round(numeric)} fps`;
}

function nowTraceTs() {
  return performance.timeOrigin + performance.now();
}

function getThemeColorValue(state) {
  const color = state?.theme?.color;
  return Number.isFinite(color) ? (color | 0) : 0;
}

function isDarkThemeState(state) {
  return getThemeColorValue(state) !== 1;
}

function isDebugTraceEnabled() {
  try {
    const url = new URL(globalThis.location?.href || 'http://localhost/');
    return url.searchParams.get('mhrTrace') === '1';
  } catch {
    return false;
  }
}

function resolveMhrAssetConfig(target = globalThis) {
  const manifestUrl = String(target?.PLAY_MHR_MANIFEST_URL || '').trim();
  const assetBaseUrl = String(target?.PLAY_MHR_ASSET_BASE_URL || '').trim();
  const lodValue = target?.PLAY_MHR_LOD;
  const lod = lodValue == null || lodValue === '' ? null : Number(lodValue);
  if (!manifestUrl) {
    throw new Error('MHR Play page must set PLAY_MHR_MANIFEST_URL before loading the plugin.');
  }
  if (lod != null && (!Number.isInteger(lod) || lod < 0)) {
    throw new Error(`MHR Play page must set PLAY_MHR_LOD to a non-negative integer, got ${String(lodValue)}.`);
  }
  return {
    manifestUrl,
    assetBaseUrl,
    ...(lod == null ? {} : { lod }),
  };
}

function deriveLodPath(rawUrl, lod, { expectManifest = false } = {}) {
  const url = new URL(String(rawUrl || ''), globalThis.location?.href || 'http://localhost/');
  const nextPath = expectManifest
    ? url.pathname.replace(/\/lod\d+\/manifest\.json$/i, `/lod${lod}/manifest.json`)
    : url.pathname.replace(/\/lod\d+\/?$/i, `/lod${lod}/`);
  if (nextPath === url.pathname) {
    if (expectManifest) {
      url.pathname = `/mhr-official/lod${lod}/manifest.json`;
    } else {
      url.pathname = `/mhr-official/lod${lod}/`;
    }
  } else {
    url.pathname = nextPath;
  }
  return url.href;
}

function buildLodAssetConfig(baseAssetConfig, lod) {
  const numericLod = Number(lod);
  if (!Number.isInteger(numericLod) || numericLod < 0) {
    throw new Error(`Invalid lod switch target: ${String(lod)}`);
  }
  const source = baseAssetConfig && typeof baseAssetConfig === 'object'
    ? baseAssetConfig
    : resolveMhrAssetConfig(globalThis);
  return {
    manifestUrl: deriveLodPath(source.manifestUrl, numericLod, { expectManifest: true }),
    assetBaseUrl: deriveLodPath(source.assetBaseUrl || source.manifestUrl, numericLod),
    lod: numericLod,
  };
}

function formatLodOptionLabel(lod, vertexCount) {
  const numericLod = Number(lod);
  const numericVertexCount = Number(vertexCount);
  if (Number.isInteger(numericVertexCount) && numericVertexCount > 0) {
    return `${numericLod} (${numericVertexCount} verts)`;
  }
  return `${numericLod}`;
}

function isAdjustableParameter(parameter) {
  const min = Number(parameter?.min);
  const max = Number(parameter?.max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return true;
  }
  return max > min;
}

function isFixedSlotParameter(parameter) {
  const min = Number(parameter?.min);
  const max = Number(parameter?.max);
  return Number.isFinite(min) && Number.isFinite(max) && min === max;
}

function isRootTranslationParameter(parameter) {
  if (String(parameter?.stateSection || '') !== 'root') {
    return false;
  }
  const key = String(parameter?.key || '').trim();
  return (
    /^root_t[xyz]$/i.test(key)
    || /^translate[xyz]$/i.test(key)
  );
}

function getUiWorkingBounds(parameter) {
  const stateSection = String(parameter?.stateSection || '').trim();
  if (stateSection === 'surfaceShape') {
    return {
      min: -UI_BLEND_ABS_RANGE,
      max: UI_BLEND_ABS_RANGE,
      step: 0.01,
    };
  }
  if (stateSection === 'expression') {
    return {
      min: -UI_EXPRESSION_ABS_RANGE,
      max: UI_EXPRESSION_ABS_RANGE,
      step: 0.01,
    };
  }
  if (stateSection === 'root') {
    if (isRootTranslationParameter(parameter)) {
      return {
        min: -UI_ROOT_TRANSLATION_ABS_RANGE,
        max: UI_ROOT_TRANSLATION_ABS_RANGE,
        step: 0.05,
      };
    }
    return {
      min: -UI_ROOT_ROTATION_ABS_RANGE,
      max: UI_ROOT_ROTATION_ABS_RANGE,
      step: 0.01,
    };
  }
  return null;
}

function getSliderBounds(parameter) {
  if (isFixedSlotParameter(parameter)) {
    return {
      min: FIXED_SLOT_SLIDER_MIN,
      max: FIXED_SLOT_SLIDER_MAX,
      step: FIXED_SLOT_SLIDER_STEP,
    };
  }
  const working = getUiWorkingBounds(parameter);
  if (working) {
    return working;
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
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return Number(parameter?.default) || 0;
  }
  if (isFixedSlotParameter(parameter)) {
    return numeric;
  }
  const { min, max } = getSliderBounds(parameter);
  let next = numeric;
  if (Number.isFinite(min)) next = Math.max(min, next);
  if (Number.isFinite(max)) next = Math.min(max, next);
  return next;
}

function sampleSmoothNormalized() {
  return (Math.random() + Math.random() + Math.random()) / 3;
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

function needsDisplayUpAlignment(parameters) {
  return !parameters.some((parameter) => supportsRuntimeUpAlignment(parameter));
}

function getMhrSnapshot(snapshot) {
  return snapshot?.mhr && typeof snapshot.mhr === 'object' ? snapshot.mhr : null;
}

function getParameterValue(snapshot, parameter) {
  const state = getMhrSnapshot(snapshot)?.state || EMPTY_STATE;
  const section = state?.[parameter.stateSection];
  const value = section && Object.prototype.hasOwnProperty.call(section, parameter.key)
    ? section[parameter.key]
    : getParameterDefaultValue(parameter);
  return Number.isFinite(Number(value)) ? Number(value) : getParameterDefaultValue(parameter);
}

function ensureMeshHandle(sceneState, topology, vertices) {
  const vertexCount = Math.max(0, (vertices?.length || 0) / 3);
  const needRebuild =
    !sceneState.meshHandle
    || !sceneState.meshGeometry
    || sceneState.meshVertexCount !== vertexCount;

  if (!needRebuild) {
    return;
  }

  sceneState.meshHandle?.dispose?.();
  const geometry = new THREE.BufferGeometry();
  const positionAttr = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
  const colorAttr = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
  positionAttr.setUsage(THREE.DynamicDrawUsage);
  colorAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positionAttr);
  geometry.setAttribute('color', colorAttr);
  geometry.setIndex(Array.from(topology || []));
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0x0a1324,
    emissiveIntensity: 0.02,
    roughness: 0.995,
    metalness: 0.0,
    transparent: false,
    opacity: 1.0,
    side: THREE.FrontSide,
    flatShading: false,
    vertexColors: true,
  });
  if ('envMapIntensity' in material) {
    material.envMapIntensity = 0;
  }
  sceneState.meshHandle = sceneState.scope.createMesh({
    name: 'mhr-profile:mesh',
    geometry,
    material,
    ownsGeometry: true,
    ownsMaterial: true,
    layer: 'worldOpaque',
    castShadow: true,
    receiveShadow: false,
  });
  sceneState.meshGeometry = geometry;
  sceneState.meshVertexCount = vertexCount;
  sceneState.meshBoundsDirty = true;
  sceneState.meshColorModeKey = '';
  if (sceneState.meshHandle?.mesh) {
    sceneState.meshHandle.mesh.scale.setScalar(DISPLAY_UNIT_SCALE_METERS);
    sceneState.meshHandle.mesh.frustumCulled = false;
  }
  syncSkinTransparency(sceneState);
}

function ensureLighting(sceneState) {
  sceneState.lightsReady = true;
}

function renderJointLabelsToPlayOverlay(host, sceneState, skeletonStates, jointNames) {
  const renderCtx = host?.renderer?.getContext?.();
  const camera = renderCtx?.camera || null;
  const overlay = renderCtx ? syncLabelOverlayViewport(renderCtx) : null;
  if (overlay) {
    overlay.mhrJointLabelsDrawn = 0;
    overlay.mhrJointLabelsSample = null;
  }
  if (
    !overlay
    || !camera
    || !sceneState?.jointLabelsVisible
    || !sceneState?.skeletonVisible
    || !Array.isArray(jointNames)
  ) {
    return;
  }
  const jointCount = Math.max(
    0,
    Math.min(jointNames.length, Math.floor((skeletonStates?.length || 0) / 8)),
  );
  if (!(jointCount > 0)) {
    return;
  }
  const { context2d, width, height, dpr } = overlay;
  context2d.save();
  context2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  context2d.font = JOINT_LABEL_FONT;
  context2d.textAlign = 'left';
  context2d.textBaseline = 'alphabetic';
  context2d.fillStyle = JOINT_LABEL_TEXT_COLOR;
  context2d.shadowColor = JOINT_LABEL_SHADOW_COLOR;
  context2d.shadowBlur = 0;
  context2d.shadowOffsetX = 1;
  context2d.shadowOffsetY = 1;
  let drawn = 0;
  let sample = null;
  for (let index = 0; index < jointCount; index += 1) {
    const base = index * 8;
    tempLabelPosition.set(
      skeletonStates[base + 0] || 0,
      skeletonStates[base + 1] || 0,
      skeletonStates[base + 2] || 0,
    );
    tempLabelPosition.multiplyScalar(DISPLAY_UNIT_SCALE_METERS);
    if (sceneState.displayAlignmentRx) {
      tempLabelPosition.applyEuler(new THREE.Euler(sceneState.displayAlignmentRx, 0, 0, 'XYZ'));
    }
    tempLabelScreen.copy(tempLabelPosition).project(camera);
    const inFront = Number.isFinite(tempLabelScreen.z) && tempLabelScreen.z >= -1 && tempLabelScreen.z <= 1;
    if (!inFront) {
      continue;
    }
    const x = (tempLabelScreen.x * 0.5 + 0.5) * width;
    const y = (-tempLabelScreen.y * 0.5 + 0.5) * height;
    const text = String(jointNames[index] || `joint_${index}`);
    context2d.fillText(text, x + 6, y - 6);
    drawn += 1;
    if (!sample) {
      sample = {
        text,
        screen: [x, y],
        sourceIndex: index,
      };
    }
  }
  context2d.restore();
  overlay.mhrJointLabelsDrawn = drawn;
  overlay.mhrJointLabelsSample = sample;
}

function clearJointLabelsOverlay(host) {
  const renderCtx = host?.renderer?.getContext?.();
  const overlay = renderCtx ? syncLabelOverlayViewport(renderCtx) : null;
  if (!overlay) {
    return;
  }
  const { context2d, width, height, dpr } = overlay;
  context2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  context2d.clearRect(0, 0, width, height);
  overlay.mhrJointLabelsDrawn = 0;
  overlay.mhrJointLabelsSample = null;
}

function ensureGhostHandle(sceneState, topology, vertices) {
  const vertexCount = Math.max(0, (vertices?.length || 0) / 3);
  const needRebuild =
    !sceneState.ghostHandle
    || !sceneState.ghostGeometry
    || sceneState.ghostVertexCount !== vertexCount;
  if (!needRebuild) {
    return;
  }
  sceneState.ghostHandle?.dispose?.();
  const geometry = new THREE.BufferGeometry();
  const positionAttr = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
  positionAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positionAttr);
  geometry.setIndex(Array.from(topology || []));
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color: 0xe9f0ff,
    emissive: 0x102040,
    emissiveIntensity: 0.04,
    roughness: 0.98,
    metalness: 0.0,
    transparent: true,
    opacity: GHOST_MESH_OPACITY,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  sceneState.ghostHandle = sceneState.scope.createMesh({
    name: 'mhr-profile:ghost',
    geometry,
    material,
    ownsGeometry: true,
    ownsMaterial: true,
    layer: 'worldTransparent',
    castShadow: false,
    receiveShadow: false,
  });
  sceneState.ghostGeometry = geometry;
  sceneState.ghostVertexCount = vertexCount;
  if (sceneState.ghostHandle?.mesh) {
    sceneState.ghostHandle.mesh.scale.setScalar(DISPLAY_UNIT_SCALE_METERS);
    sceneState.ghostHandle.mesh.visible = false;
  }
}

function syncViewerCameraToBackend(host, renderCtx) {
  const backend = host?.backend;
  if (!backend || typeof backend.apply !== 'function' || !renderCtx) {
    return;
  }
  const snapshot = host?.getSnapshot?.() ?? null;
  const state = host?.store?.get?.() ?? null;
  const payload = buildViewerCameraPayload(renderCtx, snapshot, state, new THREE.Vector3());
  if (!payload) {
    return;
  }
  const prevSeqSource = Number(renderCtx.viewerCameraSyncSeqSent);
  const prevSeq = Number.isFinite(prevSeqSource) ? Math.max(0, Math.trunc(prevSeqSource)) : 0;
  const camSyncSeq = prevSeq + 1;
  renderCtx.viewerCameraSyncSeqSent = camSyncSeq;
  renderCtx.viewerCameraSynced = false;
  renderCtx.viewerCameraTrackId = Number.isFinite(payload.trackbodyid) ? (payload.trackbodyid | 0) : null;
  backend.apply({
    kind: 'gesture',
    gestureType: 'camera',
    phase: 'sync',
    cam: payload,
    camSyncSeq,
  });
}

function fitCameraToMesh(host, sceneState, { force = false } = {}) {
  if ((!force && sceneState.cameraFramed) || !sceneState.meshGeometry) {
    return;
  }
  const renderCtx = host?.renderer?.getContext?.();
  const camera = renderCtx?.camera;
  const target = renderCtx?.cameraTarget;
  if (!camera || !target || !sceneState.meshGeometry.boundingSphere) {
    return;
  }

  const center = sceneState.meshGeometry.boundingSphere.center.clone();
  const bbox = sceneState.meshGeometry.boundingBox || null;
  const radius = Math.max(
    (sceneState.meshGeometry.boundingSphere.radius || 0) * DISPLAY_UNIT_SCALE_METERS,
    0.6,
  );
  center.multiplyScalar(DISPLAY_UNIT_SCALE_METERS);
  if (sceneState.displayAlignmentRx) {
    center.applyEuler(new THREE.Euler(sceneState.displayAlignmentRx, 0, 0, 'XYZ'));
  }
  let targetX = center.x;
  let targetY = center.y;
  let targetZ = center.z;
  if (bbox) {
    const min = bbox.min.clone().multiplyScalar(DISPLAY_UNIT_SCALE_METERS);
    const max = bbox.max.clone().multiplyScalar(DISPLAY_UNIT_SCALE_METERS);
    if (sceneState.displayAlignmentRx) {
      min.applyEuler(new THREE.Euler(sceneState.displayAlignmentRx, 0, 0, 'XYZ'));
      max.applyEuler(new THREE.Euler(sceneState.displayAlignmentRx, 0, 0, 'XYZ'));
    }
    targetX = (min.x + max.x) * 0.5;
    targetY = (min.y + max.y) * 0.5;
    targetZ = min.z + ((max.z - min.z) * 0.58);
  }
  target.set(targetX, targetY, targetZ);
  camera.position.set(
    targetX,
    targetY - radius * 3.25,
    targetZ + radius * 0.18,
  );
  camera.up.set(0, 0, 1);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  renderCtx.autoAligned = true;
  syncViewerCameraToBackend(host, renderCtx);
  sceneState.cameraFramed = true;
}

function syncTraceFields(targetTrace, patch) {
  if (!targetTrace || typeof targetTrace !== 'object' || !patch || typeof patch !== 'object') {
    return;
  }
  targetTrace.mainThread = {
    ...(targetTrace.mainThread || {}),
    ...patch,
  };
}

function ensureMeshBounds(sceneState) {
  const geometry = sceneState?.meshGeometry || null;
  if (!geometry) {
    return false;
  }
  if (sceneState?.cameraFramed && !sceneState?.meshBoundsDirty) {
    return false;
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  sceneState.meshBoundsDirty = false;
  return true;
}

function syncSkinTransparency(sceneState) {
  const material = sceneState?.meshHandle?.mesh?.material || null;
  if (!material) {
    return;
  }
  material.transparent = !!sceneState.skinHalfTransparent;
  material.opacity = sceneState.skinHalfTransparent ? 0.5 : 1.0;
  material.depthWrite = !sceneState.skinHalfTransparent;
  material.needsUpdate = true;
}

function syncMeshVisibility(sceneState, runtimeVisible = true) {
  const mesh = sceneState?.meshHandle?.mesh || null;
  if (!mesh) {
    return;
  }
  mesh.visible = !!sceneState.skinVisible && !!runtimeVisible;
}

function writeMeshColors(sceneState, vertices) {
  const geometry = sceneState?.meshGeometry || null;
  if (!geometry) {
    return false;
  }
  const color = geometry.getAttribute('color');
  if (!color) {
    return false;
  }
  const preview = sceneState?.influencePreviewVisible ? (sceneState?.influencePreviewData || null) : null;
  const vertexCount = Math.max(0, (vertices?.length || 0) / 3);
  const hasPreview =
    !!preview
    && Number(preview.vertexCount || 0) === vertexCount
    && Number(preview.maxMagnitude || 0) > 0
    && preview.magnitudes instanceof Float32Array;
  const magnitudes = hasPreview ? preview.magnitudes : null;
  const maxMagnitude = hasPreview
    ? Math.max(
      Number(preview.displayMaxMagnitude || preview.maxMagnitude || 0),
      1e-9,
    )
    : 1;
  const nextColorModeKey = hasPreview
    ? `preview:${String(preview.parameterKey || '')}:${String(preview.stateSection || '')}:${Number(preview.revision || 0)}:${maxMagnitude}:${vertexCount}`
    : 'base';
  if (sceneState?.meshColorModeKey === nextColorModeKey) {
    return false;
  }
  for (let index = 0; index < vertexCount; index += 1) {
    const normalized = hasPreview
      ? clampToBounds(Number(magnitudes?.[index] || 0) / maxMagnitude, 0, 1)
      : 0;
    const base = index * 3;
    if (normalized <= INFLUENCE_PREVIEW_MIN_NORMALIZED) {
      color.array[base + 0] = skinBaseColor.r;
      color.array[base + 1] = skinBaseColor.g;
      color.array[base + 2] = skinBaseColor.b;
      continue;
    }
    const heat = Math.pow(normalized, 0.7);
    tempPreviewColor.setHSL((1 - heat) * 0.65, 1.0, 0.5);
    tempMeshColor.copy(skinBaseColor).lerp(tempPreviewColor, Math.min(1, heat * 0.92));
    color.array[base + 0] = tempMeshColor.r;
    color.array[base + 1] = tempMeshColor.g;
    color.array[base + 2] = tempMeshColor.b;
  }
  color.needsUpdate = true;
  sceneState.meshColorModeKey = nextColorModeKey;
  return true;
}

function syncSkeletonVisibility(sceneState) {
  const visible = !!sceneState?.skeletonVisible;
  const segmentVisible = visible && Number(sceneState?.skeletonDrawCount || 0) > 0;
  const pointVisible = visible && Number(sceneState?.skeletonPointDrawCount || 0) > 0;
  const axisVisible = visible
    && !!sceneState?.jointAxesVisible
    && Number(sceneState?.skeletonAxisDrawCount || 0) > 0;
  if (sceneState?.skeletonHandle?.lines) {
    sceneState.skeletonHandle.lines.visible = segmentVisible;
  }
  if (sceneState?.skeletonMeshHandle?.mesh) {
    sceneState.skeletonMeshHandle.mesh.visible = segmentVisible;
  }
  if (sceneState?.skeletonPointsHandle?.mesh) {
    sceneState.skeletonPointsHandle.mesh.visible = pointVisible;
  }
  for (const handle of Object.values(sceneState?.skeletonAxesHandles || {})) {
    if (handle?.mesh) {
      handle.mesh.visible = axisVisible;
    }
  }
}

function ensureSkeletonMeshHandle(sceneState, jointParents) {
  const segmentCount = Math.max(1, (jointParents || []).filter((parent) => Number(parent) >= 0).length);
  const needRebuild =
    !sceneState.skeletonMeshHandle
    || sceneState.skeletonMeshCapacity !== segmentCount;

  if (!needRebuild) {
    return;
  }

  sceneState.skeletonMeshHandle?.dispose?.();
  sceneState.skeletonMeshHandle = sceneState.scope.createInstancedMeshBatch({
    name: 'mhr-profile:skeleton-bones',
    primitive: 'cylinder',
    capacity: segmentCount,
    layer: 'worldOpaque',
    castShadow: false,
    receiveShadow: false,
    material: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 0.06,
      roughness: 0.75,
      metalness: 0.0,
      transparent: false,
      opacity: 1.0,
    }),
    ownsMaterial: true,
  });
  sceneState.skeletonMeshCapacity = segmentCount;
  if (sceneState.skeletonMeshHandle?.mesh) {
    sceneState.skeletonMeshHandle.mesh.scale.setScalar(DISPLAY_UNIT_SCALE_METERS);
  }
}

function ensureSkeletonHandle(sceneState, jointParents) {
  const segmentCount = Math.max(1, (jointParents || []).filter((parent) => Number(parent) >= 0).length);
  const needRebuild =
    !sceneState.skeletonHandle
    || sceneState.skeletonCapacity !== segmentCount;

  if (!needRebuild) {
    return;
  }

  sceneState.skeletonHandle?.dispose?.();
  sceneState.skeletonHandle = sceneState.scope.createLineSegmentsBatch({
    name: 'mhr-profile:skeleton',
    capacity: segmentCount,
    layer: 'worldOpaque',
    opacity: 1.0,
  });
  sceneState.skeletonCapacity = segmentCount;
  if (sceneState.skeletonHandle?.lines) {
    sceneState.skeletonHandle.lines.scale.setScalar(DISPLAY_UNIT_SCALE_METERS);
  }
}

function ensureSkeletonAxesHandle(sceneState, jointParents) {
  const axisCount = Math.max(1, (jointParents?.length || 0) * 3);
  const needRebuild =
    !sceneState.skeletonAxesHandles
    || sceneState.skeletonAxisCapacity !== axisCount;

  if (!needRebuild) {
    return;
  }

  for (const handle of Object.values(sceneState.skeletonAxesHandles || {})) {
    handle?.dispose?.();
  }
  const axisSpecs = [
    ['x', 0xff0000],
    ['y', 0x00ff00],
    ['z', 0x0000ff],
  ];
  sceneState.skeletonAxesHandles = Object.fromEntries(axisSpecs.map(([axisKey, color]) => [
    axisKey,
    sceneState.scope.createInstancedMeshBatch({
      name: `mhr-profile:joint-axis-${axisKey}`,
      capacity: Math.max(1, jointParents?.length || 0),
      layer: 'worldOpaque',
      primitive: 'cylinder',
      castShadow: false,
      receiveShadow: false,
      material: new THREE.MeshBasicMaterial({
        color,
        toneMapped: false,
        transparent: false,
        opacity: 1,
      }),
      ownsMaterial: true,
    }),
  ]));
  sceneState.skeletonAxisCapacity = axisCount;
  for (const handle of Object.values(sceneState.skeletonAxesHandles || {})) {
    if (handle?.mesh) {
      handle.mesh.scale.setScalar(DISPLAY_UNIT_SCALE_METERS);
    }
  }
}

function ensureSkeletonPointsHandle(sceneState, jointParents) {
  const pointCount = Math.max(1, (jointParents?.length || 0));
  const needRebuild =
    !sceneState.skeletonPointsHandle
    || sceneState.skeletonPointCapacity !== pointCount;

  if (!needRebuild) {
    return;
  }

  sceneState.skeletonPointsHandle?.dispose?.();
  sceneState.skeletonPointsHandle = sceneState.scope.createInstancedMeshBatch({
    name: 'mhr-profile:skeleton-points',
    capacity: pointCount,
    layer: 'worldOpaque',
    primitive: 'sphere',
    castShadow: false,
    receiveShadow: false,
    material: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 0.08,
      roughness: 0.6,
      metalness: 0.0,
      transparent: false,
      opacity: 1.0,
    }),
    ownsMaterial: true,
  });
  sceneState.skeletonPointCapacity = pointCount;
  if (sceneState.skeletonPointsHandle?.mesh) {
    sceneState.skeletonPointsHandle.mesh.scale.setScalar(DISPLAY_UNIT_SCALE_METERS);
  }
}

function writeSkeleton(sceneState, skeletonStates, jointParents, visible) {
  if (!sceneState.skeletonHandle) return;
  const writer = sceneState.skeletonHandle.writer;
  const meshWriter = sceneState.skeletonMeshHandle?.writer || null;
  const pointWriter = sceneState.skeletonPointsHandle?.writer || null;
  let segmentIndex = 0;
  let pointIndex = 0;
  const jointCount = Math.max(0, (skeletonStates?.length || 0) / 8);
  const effectiveVisible = !!visible && !!sceneState?.skeletonVisible;
  if (effectiveVisible) {
    for (let jointIndex = 0; jointIndex < jointCount; jointIndex += 1) {
      const jointBase = jointIndex * 8;
      if (pointWriter) {
        const pointPosBase = pointIndex * 3;
        pointWriter.pos[pointPosBase + 0] = skeletonStates[jointBase + 0] || 0;
        pointWriter.pos[pointPosBase + 1] = skeletonStates[jointBase + 1] || 0;
        pointWriter.pos[pointPosBase + 2] = skeletonStates[jointBase + 2] || 0;
        pointWriter.scale[pointPosBase + 0] = SKELETON_JOINT_RADIUS_RAW;
        pointWriter.scale[pointPosBase + 1] = SKELETON_JOINT_RADIUS_RAW;
        pointWriter.scale[pointPosBase + 2] = SKELETON_JOINT_RADIUS_RAW;
        pointWriter.rgb[pointPosBase + 0] = 1.0;
        pointWriter.rgb[pointPosBase + 1] = 1.0;
        pointWriter.rgb[pointPosBase + 2] = 1.0;
        pointIndex += 1;
      }
      const parentIndex = Number(jointParents?.[jointIndex]);
      if (!(parentIndex >= 0)) continue;
      const dst = segmentIndex * 6;
      const childBase = jointBase;
      const parentBase = parentIndex * 8;
      writer.pos[dst + 0] = skeletonStates[childBase + 0] || 0;
      writer.pos[dst + 1] = skeletonStates[childBase + 1] || 0;
      writer.pos[dst + 2] = skeletonStates[childBase + 2] || 0;
      writer.pos[dst + 3] = skeletonStates[parentBase + 0] || 0;
      writer.pos[dst + 4] = skeletonStates[parentBase + 1] || 0;
      writer.pos[dst + 5] = skeletonStates[parentBase + 2] || 0;
      writer.rgb.fill(1.0, dst, dst + 6);
      if (meshWriter) {
        tempSkeletonChild.set(
          skeletonStates[childBase + 0] || 0,
          skeletonStates[childBase + 1] || 0,
          skeletonStates[childBase + 2] || 0,
        );
        tempSkeletonParent.set(
          skeletonStates[parentBase + 0] || 0,
          skeletonStates[parentBase + 1] || 0,
          skeletonStates[parentBase + 2] || 0,
        );
        tempSkeletonDir.subVectors(tempSkeletonChild, tempSkeletonParent);
        const length = Math.max(tempSkeletonDir.length(), 1e-6);
        tempSkeletonMid.addVectors(tempSkeletonChild, tempSkeletonParent).multiplyScalar(0.5);
        tempSkeletonDir.multiplyScalar(1 / length);
        tempSkeletonQuat.setFromUnitVectors(SKELETON_AXIS_Z, tempSkeletonDir);
        const meshPosBase = segmentIndex * 3;
        const meshQuatBase = segmentIndex * 4;
        meshWriter.pos[meshPosBase + 0] = tempSkeletonMid.x;
        meshWriter.pos[meshPosBase + 1] = tempSkeletonMid.y;
        meshWriter.pos[meshPosBase + 2] = tempSkeletonMid.z;
        meshWriter.quat[meshQuatBase + 0] = tempSkeletonQuat.x;
        meshWriter.quat[meshQuatBase + 1] = tempSkeletonQuat.y;
        meshWriter.quat[meshQuatBase + 2] = tempSkeletonQuat.z;
        meshWriter.quat[meshQuatBase + 3] = tempSkeletonQuat.w;
        meshWriter.scale[meshPosBase + 0] = SKELETON_BONE_RADIUS_RAW;
        meshWriter.scale[meshPosBase + 1] = SKELETON_BONE_RADIUS_RAW;
        meshWriter.scale[meshPosBase + 2] = length * 0.5;
        meshWriter.rgb[meshPosBase + 0] = 1.0;
        meshWriter.rgb[meshPosBase + 1] = 1.0;
        meshWriter.rgb[meshPosBase + 2] = 1.0;
      }
      segmentIndex += 1;
    }
  }
  sceneState.skeletonHandle.commit({ count: effectiveVisible ? segmentIndex : 0 });
  sceneState.skeletonMeshHandle?.commit({ count: effectiveVisible ? segmentIndex : 0 });
  sceneState.skeletonPointsHandle?.commit({ count: effectiveVisible ? pointIndex : 0 });
  sceneState.skeletonDrawCount = effectiveVisible ? segmentIndex : 0;
  sceneState.skeletonPointDrawCount = effectiveVisible ? pointIndex : 0;
  syncSkeletonVisibility(sceneState);
}

function writeSkeletonAxes(sceneState, skeletonStates, visible) {
  const axisHandles = sceneState.skeletonAxesHandles || null;
  const xWriter = axisHandles?.x?.writer || null;
  const yWriter = axisHandles?.y?.writer || null;
  const zWriter = axisHandles?.z?.writer || null;
  if (!xWriter || !yWriter || !zWriter) {
    return;
  }
  let axisIndex = 0;
  const jointCount = Math.max(0, (skeletonStates?.length || 0) / 8);
  const effectiveVisible = !!visible && !!sceneState?.skeletonVisible && !!sceneState?.jointAxesVisible;
  if (effectiveVisible) {
    for (let jointIndex = 0; jointIndex < jointCount; jointIndex += 1) {
      const base = jointIndex * 8;
      tempAxisStart.set(
        skeletonStates[base + 0] || 0,
        skeletonStates[base + 1] || 0,
        skeletonStates[base + 2] || 0,
      );
      tempSkeletonQuat.set(
        skeletonStates[base + 3] || 0,
        skeletonStates[base + 4] || 0,
        skeletonStates[base + 5] || 0,
        skeletonStates[base + 6] || 1,
      );
      tempJointBaseQuat.copy(tempSkeletonQuat).normalize();
      const axisScale = Math.max(0.4, Number(skeletonStates[base + 7] || 1)) * SKELETON_AXIS_LENGTH_RAW;
      const axes = [
        [xWriter, AXIS_X, [1.0, 0.0, 0.0]],
        [yWriter, AXIS_Y, [0.0, 1.0, 0.0]],
        [zWriter, AXIS_Z, [0.0, 0.0, 1.0]],
      ];
      for (const [writer, basis, rgb] of axes) {
        tempAxisDir.copy(basis).applyQuaternion(tempJointBaseQuat).multiplyScalar(axisScale);
        const length = Math.max(tempAxisDir.length(), 1e-6);
        tempAxisDir.multiplyScalar(1 / length);
        tempAxisEnd.copy(tempAxisStart).addScaledVector(tempAxisDir, length * 0.5);
        tempSkeletonQuat.setFromUnitVectors(SKELETON_AXIS_Z, tempAxisDir);
        const posBase = axisIndex * 3;
        const quatBase = axisIndex * 4;
        writer.pos[posBase + 0] = tempAxisEnd.x;
        writer.pos[posBase + 1] = tempAxisEnd.y;
        writer.pos[posBase + 2] = tempAxisEnd.z;
        writer.quat[quatBase + 0] = tempSkeletonQuat.x;
        writer.quat[quatBase + 1] = tempSkeletonQuat.y;
        writer.quat[quatBase + 2] = tempSkeletonQuat.z;
        writer.quat[quatBase + 3] = tempSkeletonQuat.w;
        writer.scale[posBase + 0] = SKELETON_AXIS_RADIUS_RAW;
        writer.scale[posBase + 1] = SKELETON_AXIS_RADIUS_RAW;
        writer.scale[posBase + 2] = length * 0.5;
        writer.rgb[posBase + 0] = rgb[0];
        writer.rgb[posBase + 1] = rgb[1];
        writer.rgb[posBase + 2] = rgb[2];
      }
      axisIndex += 1;
    }
  }
  axisHandles?.x?.commit?.({ count: effectiveVisible ? axisIndex : 0 });
  axisHandles?.y?.commit?.({ count: effectiveVisible ? axisIndex : 0 });
  axisHandles?.z?.commit?.({ count: effectiveVisible ? axisIndex : 0 });
  sceneState.skeletonAxisDrawCount = effectiveVisible ? axisIndex : 0;
  syncSkeletonVisibility(sceneState);
}

export async function registerPlayPlugin(host) {
  if (!host?.ui?.sections?.register || !host?.renderer?.overlay3d?.createScope) {
    throw new Error('mhr_profile_plugin requires Play ui.sections.register and renderer.overlay3d.');
  }

  const onUiMainTick = host?.clock?.onUiMainTick || host?.clock?.onUiTick;
  const onUiControlsTick = host?.clock?.onUiControlsTick || onUiMainTick;
  const onFrame = host?.clock?.onFrame;
  if (typeof onUiMainTick !== 'function'
    || typeof onUiControlsTick !== 'function'
    || typeof onFrame !== 'function') {
    throw new Error('mhr_profile_plugin requires Play clock lanes (onUiMainTick/onUiControlsTick/onFrame).');
  }

  if (typeof host.ui.kit?.namedRow !== 'function'
    || typeof host.ui.kit?.fullRow !== 'function'
    || typeof host.ui.kit?.button !== 'function'
    || typeof host.ui.kit?.boolButton !== 'function'
    || typeof host.ui.kit?.select !== 'function'
    || typeof host.ui.kit?.range !== 'function'
    || typeof host.ui.kit?.textbox !== 'function') {
    throw new Error('mhr_profile_plugin requires Play ui.kit.namedRow/fullRow/button/boolButton/select/range/textbox.');
  }

  const runtimeConfig = getRuntimeConfig();
  if (String(runtimeConfig?.ui?.profileId || 'play').trim().toLowerCase() !== 'mhr') {
    return () => {};
  }
  const initialAssetConfig = resolveMhrAssetConfig(globalThis);
  const extensionState = host?.extensions?.mhr || null;
  let mhrService = extensionState?.service || null;
  let ownsService = false;
  if (!mhrService) {
    mhrService = await createMhrService({ runtimeConfig, assetConfig: initialAssetConfig });
    ownsService = true;
    if (host?.extensions) {
      host.extensions.mhr = {
        service: mhrService,
        getSnapshot: () => mhrService.snapshot(),
        applyPatch: (statePatch, options) => mhrService.applyPatch(statePatch, options),
        previewInfluence: (request) => mhrService.previewInfluence(request),
        loadAssets: (assetConfig) => mhrService.loadAssets(assetConfig),
        hasPendingCommit: () => mhrService.hasPendingCommit(),
      };
    }
  }
  if (!mhrService
    || typeof mhrService.snapshot !== 'function'
    || typeof mhrService.subscribe !== 'function'
    || typeof mhrService.applyPatch !== 'function'
    || typeof mhrService.previewInfluence !== 'function'
    || typeof mhrService.loadAssets !== 'function'
    || typeof mhrService.hasPendingCommit !== 'function') {
    throw new Error('mhr_profile_plugin requires an MHR service with snapshot/subscribe/applyPatch/previewInfluence/loadAssets/hasPendingCommit.');
  }
  if (typeof host?.renderer?.labelOverlay?.register !== 'function') {
    throw new Error('mhr_profile_plugin requires Play renderer.labelOverlay.register.');
  }

  const kit = host.ui.kit;
  const scope = host.renderer.overlay3d.createScope('mhr-profile', { name: 'MHR Profile' });
  const overlayRoot = host?.mounts?.overlayRoot || document.body;
  const sceneState = {
    scope,
    meshHandle: null,
    meshGeometry: null,
    meshVertexCount: 0,
    ghostHandle: null,
    ghostGeometry: null,
    ghostVertexCount: 0,
    ghostCaptured: false,
    influencePreviewData: null,
    influencePreviewVisible: false,
    influencePreviewScaleKey: '',
    influencePreviewScaleMax: 0,
    skeletonHandle: null,
    skeletonCapacity: 0,
    skeletonMeshHandle: null,
    skeletonMeshCapacity: 0,
    skeletonPointsHandle: null,
    skeletonPointCapacity: 0,
    skeletonAxesHandles: null,
    skeletonAxisCapacity: 0,
    skeletonAxisDrawCount: 0,
    lightsReady: false,
    cameraFramed: false,
    meshBoundsDirty: true,
    meshColorModeKey: '',
    displayAlignmentRx: 0,
    darkTheme: isDarkThemeState(host.store?.get?.()),
    skinVisible: true,
    skinHalfTransparent: false,
    skeletonVisible: true,
    jointLabelsVisible: false,
    jointAxesVisible: false,
    selectedParameterRowKey: '',
    selectedParameterKey: '',
    selectedParameterSection: '',
    skeletonDrawCount: 0,
    skeletonPointDrawCount: 0,
    familyRandomEnabled: {
      scale: false,
      blend: false,
      expression: false,
      pose: false,
      fixed: false,
    },
    familyRandomState: {
      scale: null,
      blend: null,
      expression: null,
      pose: null,
      fixed: null,
    },
    familyRandomLastCommitTs: 0,
    familyRandomNextCommitTs: 0,
    familyRandomLastSubmittedSignature: '',
    familyRandomCadenceMs: 1000 / FAMILY_RANDOM_DEFAULT_TARGET_FPS,
    familyRandomCadenceFps: FAMILY_RANDOM_DEFAULT_TARGET_FPS,
    familyRandomObservedRoundtripMs: 1000 / FAMILY_RANDOM_DEFAULT_TARGET_FPS,
    familyRandomUpshiftVotes: 0,
    familyRandomDownshiftVotes: 0,
    influencePreviewRequestSeq: 0,
    influencePreviewQueuedRequest: null,
    influencePreviewQueuedKey: '',
    influencePreviewInFlightKey: '',
    influencePreviewLoopActive: false,
    lodSwitchInFlight: false,
  };
  const perfHudState = {
    root: null,
    frontValueEl: null,
    backendValueEl: null,
    lastFrontSampleTsMs: 0,
    lastBackendSampleTsMs: 0,
    lastBackendSeq: -1,
    frontSamples: [],
    backendSamples: [],
  };
  let mhrSnapshot = mhrService.snapshot();
  let mhrUnsubscribe = () => {};
  let traceSeq = 0;
  let lastDebugTrace = null;
  let lastRenderedPreviewToken = '';
  const DISPLAY_COMPARE_MODE = 'both';
  const debugTraceEnabled = isDebugTraceEnabled();
  const rowRegistry = {
    scale: new Map(),
    blend: new Map(),
    expression: new Map(),
    fixed: new Map(),
    pose: new Map(),
  };
  const panelSignature = {
    scale: '',
    blend: '',
    expression: '',
    fixed: '',
    pose: '',
  };
  let lastRenderedAssetsKey = '';
  let lastRenderedRevision = -1;
  let lastRenderedEvaluationSeq = -1;
  let uiStructureDirty = true;
  let controlsDirty = true;
  let sceneDirty = true;
  let sunPresetReady = false;
  let sunPresetPromise = null;
  globalThis.__MHR_DEBUG_TRACE__ = null;

  const sectionRoots = {
    control: null,
    scale: null,
    blend: null,
    expression: null,
    fixed: null,
    pose: null,
  };
  const sectionResetButtons = {
    scale: null,
    blend: null,
    expression: null,
    fixed: null,
    pose: null,
  };
  const controlButtons = {
    ghost: null,
  };
  const controlRefs = {
    lodRow: null,
    lodLabel: null,
    lodSelect: null,
    lodMetadata: new Map(),
    lodMetadataPromise: null,
  };

  function reportError(scopeLabel, error) {
    host.logError?.(`[mhr] ${scopeLabel} failed`, error);
    host.strictCatch?.(error, `plugin:mhr:${scopeLabel}`, { allow: true });
  }

  function hasSunPresetActive() {
    const currentMode = String(host.store?.get?.()?.visualSourceMode || '').trim().toLowerCase();
    return currentMode === 'preset-sun';
  }

  async function ensureSunPreset() {
    if (sunPresetReady || hasSunPresetActive()) {
      sunPresetReady = true;
      return;
    }
    if (sunPresetPromise) {
      return sunPresetPromise;
    }
    sunPresetPromise = (async () => {
      try {
        await switchVisualSourceMode(host.store, host.backend, 'preset-sun');
        sunPresetReady = hasSunPresetActive();
        host.renderer.ensureLoop?.();
      } catch (error) {
        reportError('preset-sun', error);
      } finally {
        sunPresetPromise = null;
      }
    })();
    return sunPresetPromise;
  }

  function getCurrentAssetConfig(snapshot = mhrSnapshot) {
    const assets = getMhrSnapshot(snapshot)?.assets || null;
    if (assets?.manifestUrl) {
      return {
        manifestUrl: String(assets.manifestUrl || ''),
        assetBaseUrl: String(assets.assetBaseUrl || ''),
        lod: Number.isInteger(assets.lod) ? assets.lod : null,
      };
    }
    return initialAssetConfig;
  }

  function currentLod(snapshot = mhrSnapshot) {
    const assets = getMhrSnapshot(snapshot)?.assets || null;
    if (Number.isInteger(assets?.lod)) {
      return assets.lod;
    }
    return Number.isInteger(initialAssetConfig?.lod) ? initialAssetConfig.lod : 1;
  }

  function syncCurrentLodMetadata(snapshot = mhrSnapshot) {
    const assets = getMhrSnapshot(snapshot)?.assets || null;
    const lod = Number.isInteger(assets?.lod) ? assets.lod : currentLod(snapshot);
    const vertexCount = Number(assets?.counts?.vertexCount || assets?.parameterMetadata?.counts?.vertexCount || 0);
    if (Number.isInteger(lod) && vertexCount > 0) {
      controlRefs.lodMetadata.set(lod, { vertexCount });
    }
  }

  function updatePageLodState(assetConfig) {
    globalThis.PLAY_MHR_MANIFEST_URL = assetConfig.manifestUrl;
    globalThis.PLAY_MHR_ASSET_BASE_URL = assetConfig.assetBaseUrl;
    globalThis.PLAY_MHR_LOD = assetConfig.lod;
    try {
      const nextUrl = new URL(globalThis.location.href);
      nextUrl.searchParams.set('lod', String(assetConfig.lod));
      globalThis.history?.replaceState?.(globalThis.history.state, '', nextUrl);
    } catch {
      // Ignore URL rewrite failures in non-browser environments.
    }
  }

  function syncLodSelectRow() {
    if (!controlRefs.lodSelect) {
      return;
    }
    syncCurrentLodMetadata();
    const activeLod = currentLod();
    controlRefs.lodSelect.value = String(activeLod);
    controlRefs.lodSelect.disabled = sceneState.lodSwitchInFlight;
    for (const option of controlRefs.lodSelect.options) {
      const lod = Number(option.value);
      const metadata = controlRefs.lodMetadata.get(lod) || null;
      option.textContent = formatLodOptionLabel(lod, metadata?.vertexCount ?? null);
    }
  }

  async function ensureLodMetadataLoaded() {
    if (controlRefs.lodMetadataPromise) {
      return controlRefs.lodMetadataPromise;
    }
    const baseAssetConfig = getCurrentAssetConfig();
    controlRefs.lodMetadataPromise = (async () => {
      for (const lod of SUPPORTED_LODS) {
        const manifest = await loadRuntimeIrManifest(buildLodAssetConfig(baseAssetConfig, lod), {
          fetchImpl: globalThis.fetch?.bind(globalThis),
        });
        const vertexCount = Number(manifest?.counts?.vertexCount || 0);
        if (vertexCount > 0) {
          controlRefs.lodMetadata.set(lod, { vertexCount });
        }
      }
      syncLodSelectRow();
    })().catch((error) => {
      reportError('lod-metadata', error);
    }).finally(() => {
      controlRefs.lodMetadataPromise = null;
    });
    return controlRefs.lodMetadataPromise;
  }

  async function switchLod(nextLod) {
    const numericLod = Number(nextLod);
    if (!Number.isInteger(numericLod) || numericLod < 0) {
      return;
    }
    if (sceneState.lodSwitchInFlight || numericLod === currentLod()) {
      syncLodSelectRow();
      return;
    }
    sceneState.lodSwitchInFlight = true;
    syncLodSelectRow();
    try {
      const nextAssetConfig = buildLodAssetConfig(getCurrentAssetConfig(), numericLod);
      clearInfluencePreview();
      sceneState.ghostCaptured = false;
      if (sceneState.ghostHandle?.mesh) {
        sceneState.ghostHandle.mesh.visible = false;
      }
      updateGhostButtonState();
      await mhrService.loadAssets(nextAssetConfig);
      syncCurrentLodMetadata();
      updatePageLodState(nextAssetConfig);
      controlsDirty = true;
      sceneDirty = true;
      host.renderer.ensureLoop?.();
    } catch (error) {
      reportError('lod-switch', error);
    } finally {
      sceneState.lodSwitchInFlight = false;
      syncLodSelectRow();
    }
  }

  function onMhrSnapshot(nextSnapshot) {
    mhrSnapshot = nextSnapshot;
    syncCurrentLodMetadata(nextSnapshot);
    syncLodSelectRow();
    if (!sunPresetReady) {
      void ensureSunPreset();
    }
    const nextAssetsKey = currentAssetsKey(nextSnapshot);
    const nextRevision = Number(getMhrSnapshot(nextSnapshot)?.revision || 0);
    const nextEvaluationSeq = Number(getMhrSnapshot(nextSnapshot)?.evaluation?.seq || 0);
    const nextPreviewToken = buildInfluencePreviewSnapshotToken(nextSnapshot);
    if (nextAssetsKey !== lastRenderedAssetsKey) {
      uiStructureDirty = true;
      controlsDirty = true;
      sceneDirty = true;
      clearInfluencePreview();
    } else {
      if (nextRevision !== lastRenderedRevision) {
        controlsDirty = true;
      }
      if (nextEvaluationSeq !== lastRenderedEvaluationSeq) {
        sceneDirty = true;
      }
      if (sceneState.influencePreviewVisible && nextPreviewToken !== lastRenderedPreviewToken) {
        sceneDirty = true;
      }
    }
    const nextTrace = getMhrSnapshot(nextSnapshot)?.evaluation?.debug?.debugTiming ?? null;
    if (nextTrace && typeof nextTrace === 'object') {
      lastDebugTrace = nextTrace;
      updateFamilyRandomObservedRoundtripMs(nextTrace);
      globalThis.__MHR_DEBUG_TRACE__ = debugTraceEnabled ? nextTrace : null;
    }
    const nowMs = performance.now();
    if (nextEvaluationSeq > 0 && nextEvaluationSeq !== perfHudState.lastBackendSeq) {
      recordPerfHudSample(perfHudState.backendSamples, nowMs);
      perfHudState.lastBackendSampleTsMs = nowMs;
      perfHudState.lastBackendSeq = nextEvaluationSeq;
    }
    updatePerfHudText(nowMs);
    if (sceneState.influencePreviewVisible) {
      const hasSnapshotPreview = consumeSnapshotInfluencePreview(nextSnapshot);
      if (!hasSnapshotPreview) {
        queueCurrentInfluencePreviewRequest();
      }
    }
    if (sceneDirty) {
      host.renderer.ensureLoop?.();
    }
  }

  function clearInfluencePreview() {
    sceneState.influencePreviewData = null;
    sceneState.influencePreviewScaleKey = '';
    sceneState.influencePreviewScaleMax = 0;
    sceneState.influencePreviewQueuedRequest = null;
    sceneState.influencePreviewQueuedKey = '';
    sceneState.meshColorModeKey = '';
  }

  function ensurePerfHud() {
    if (perfHudState.root?.isConnected) {
      return;
    }
    const card = document.createElement('div');
    card.className = 'overlay-card visible mhr-perf-hud';
    card.setAttribute('data-testid', 'mhr-perf-hud');
    const grid = document.createElement('div');
    grid.className = 'info-grid';

    const frontLabel = document.createElement('div');
    frontLabel.className = 'info-label';
    frontLabel.textContent = 'Front';
    const frontValue = document.createElement('div');
    frontValue.className = 'info-value';
    frontValue.setAttribute('data-info-field', 'front-fps');
    frontValue.textContent = '0 fps';

    const backendLabel = document.createElement('div');
    backendLabel.className = 'info-label';
    backendLabel.textContent = 'Backend';
    const backendValue = document.createElement('div');
    backendValue.className = 'info-value';
    backendValue.setAttribute('data-info-field', 'backend-fps');
    backendValue.textContent = '0 fps';

    grid.append(frontLabel, frontValue, backendLabel, backendValue);
    card.appendChild(grid);
    overlayRoot?.appendChild?.(card);
    perfHudState.root = card;
    perfHudState.frontValueEl = frontValue;
    perfHudState.backendValueEl = backendValue;
  }

  function updatePerfHudText(nowMs = performance.now()) {
    if (!perfHudState.root?.isConnected) {
      return;
    }
    const frontFps = nowMs - perfHudState.lastFrontSampleTsMs > PERF_HUD_STALE_MS
      ? 0
      : measurePerfHudFps(perfHudState.frontSamples, nowMs);
    const backendFps = nowMs - perfHudState.lastBackendSampleTsMs > PERF_HUD_STALE_MS
      ? 0
      : measurePerfHudFps(perfHudState.backendSamples, nowMs);
    if (perfHudState.frontValueEl) {
      perfHudState.frontValueEl.textContent = formatHudFps(frontFps);
    }
    if (perfHudState.backendValueEl) {
      perfHudState.backendValueEl.textContent = formatHudFps(backendFps);
    }
  }

  function buildInfluencePreviewScaleKey(preview) {
    return `${String(preview?.stateSection || '')}:${String(preview?.parameterKey || '')}:${Number(preview?.vertexCount || 0)}`;
  }

  function updateInfluencePreviewScaleMax(preview) {
    const previewKey = buildInfluencePreviewScaleKey(preview);
    const nextRawMax = Math.max(Number(preview?.maxMagnitude || 0), 1e-9);
    if (!previewKey || !(nextRawMax > 0)) {
      sceneState.influencePreviewScaleKey = '';
      sceneState.influencePreviewScaleMax = 0;
      return nextRawMax;
    }
    if (sceneState.influencePreviewScaleKey !== previewKey || !(sceneState.influencePreviewScaleMax > 0)) {
      sceneState.influencePreviewScaleKey = previewKey;
      sceneState.influencePreviewScaleMax = nextRawMax;
      return nextRawMax;
    }
    const previous = sceneState.influencePreviewScaleMax;
    const alpha = nextRawMax >= previous ? INFLUENCE_PREVIEW_SCALE_UP_ALPHA : INFLUENCE_PREVIEW_SCALE_DOWN_ALPHA;
    const blended = previous + ((nextRawMax - previous) * alpha);
    const bounded = nextRawMax >= previous
      ? Math.min(nextRawMax, Math.max(previous, blended))
      : Math.max(nextRawMax, Math.min(previous, blended));
    sceneState.influencePreviewScaleMax = Math.max(bounded, 1e-9);
    return sceneState.influencePreviewScaleMax;
  }

  function buildCurrentInfluencePreviewRequest() {
    if (!sceneState.influencePreviewVisible) {
      return null;
    }
    const parameter = findSelectedRowState()?.parameter || null;
    if (!parameter) {
      return null;
    }
    return {
      parameterKey: String(parameter.key || ''),
      stateSection: String(parameter.stateSection || ''),
      revision: Number(getMhrSnapshot(mhrSnapshot)?.revision || 0),
    };
  }

  function buildInfluencePreviewRequestKey(preview = null) {
    if (!preview || typeof preview !== 'object') {
      return '';
    }
    return [
      String(preview?.parameterKey || ''),
      String(preview?.stateSection || ''),
      Number(preview?.revision || 0),
    ].join('|');
  }

  function buildInfluencePreviewSnapshotToken(snapshot = mhrSnapshot) {
    const preview = getMhrSnapshot(snapshot)?.evaluation?.influencePreview || null;
    if (!preview) {
      return '';
    }
    return [
      Number(preview?.previewId || 0),
      buildInfluencePreviewRequestKey(preview),
    ].join('|');
  }

  function applyInfluencePreviewPayload(preview = null) {
    if (!sceneState.influencePreviewVisible || !preview) {
      return false;
    }
    const matchesSelection =
      String(preview?.parameterKey || '') === sceneState.selectedParameterKey
      && String(preview?.stateSection || '') === sceneState.selectedParameterSection;
    if (!matchesSelection) {
      return false;
    }
    sceneState.influencePreviewData = {
      parameterKey: String(preview?.parameterKey || ''),
      stateSection: String(preview?.stateSection || ''),
      revision: Number(preview?.revision || 0),
      vertexCount: Number(preview?.vertexCount || 0),
      maxMagnitude: Number(preview?.maxMagnitude || 0),
      displayMaxMagnitude: updateInfluencePreviewScaleMax(preview),
      appliedDelta: Number(preview?.appliedDelta || 0),
      magnitudes: preview?.magnitudes instanceof Float32Array ? preview.magnitudes : null,
    };
    return true;
  }

  function consumeSnapshotInfluencePreview(snapshot = mhrSnapshot) {
    const preview = getMhrSnapshot(snapshot)?.evaluation?.influencePreview || null;
    return applyInfluencePreviewPayload(preview);
  }

  function kickInfluencePreviewLoop() {
    if (sceneState.influencePreviewLoopActive
      || !sceneState.influencePreviewVisible
      || sceneState.lodSwitchInFlight
      || mhrService.hasPendingCommit?.()) {
      return;
    }
    const request = sceneState.influencePreviewQueuedRequest;
    const requestKey = sceneState.influencePreviewQueuedKey;
    if (!request || !requestKey) {
      return;
    }
    sceneState.influencePreviewQueuedRequest = null;
    sceneState.influencePreviewQueuedKey = '';
    sceneState.influencePreviewInFlightKey = requestKey;
    sceneState.influencePreviewLoopActive = true;
    mhrService.previewInfluence(request)
      .catch((error) => reportError('previewInfluence', error))
      .finally(() => {
        sceneState.influencePreviewLoopActive = false;
        sceneState.influencePreviewInFlightKey = '';
        if (!sceneState.influencePreviewVisible || sceneState.lodSwitchInFlight) {
          return;
        }
        if (sceneState.influencePreviewQueuedRequest && !mhrService.hasPendingCommit?.()) {
          kickInfluencePreviewLoop();
        }
      });
  }

  function queueCurrentInfluencePreviewRequest(options = {}) {
    if (!sceneState.influencePreviewVisible || sceneState.lodSwitchInFlight) {
      return;
    }
    const baseRequest = buildCurrentInfluencePreviewRequest();
    if (!baseRequest) {
      return;
    }
    const requestKey = buildInfluencePreviewRequestKey(baseRequest);
    const snapshotPreviewKey = buildInfluencePreviewRequestKey(
      getMhrSnapshot(mhrSnapshot)?.evaluation?.influencePreview || null,
    );
    if (!options?.force) {
      if (!requestKey
        || requestKey === snapshotPreviewKey
        || requestKey === sceneState.influencePreviewQueuedKey
        || requestKey === sceneState.influencePreviewInFlightKey) {
        return;
      }
    }
    sceneState.influencePreviewRequestSeq += 1;
    sceneState.influencePreviewQueuedRequest = {
      ...baseRequest,
      previewId: sceneState.influencePreviewRequestSeq,
    };
    sceneState.influencePreviewQueuedKey = requestKey;
    kickInfluencePreviewLoop();
  }

  function findSelectedRowState() {
    return sceneState.selectedParameterRowKey
      ? findRowState(sceneState.selectedParameterRowKey)
      : null;
  }

  function setSelectedParameter(parameter, rowKey) {
    const nextRowKey = String(rowKey || getParameterRowKey(parameter));
    if (!nextRowKey) {
      return;
    }
    const previous = findSelectedRowState();
    if (previous?.root) {
      previous.root.classList.remove('is-selected');
    }
    sceneState.selectedParameterRowKey = nextRowKey;
    sceneState.selectedParameterKey = String(parameter?.key || '');
    sceneState.selectedParameterSection = String(parameter?.stateSection || '');
    const next = findRowState(nextRowKey);
    if (next?.root) {
      next.root.classList.add('is-selected');
    }
    if (sceneState.influencePreviewVisible) {
      const hasSnapshotPreview = consumeSnapshotInfluencePreview(mhrSnapshot);
      if (!hasSnapshotPreview) {
        clearInfluencePreview();
      }
      queueCurrentInfluencePreviewRequest({ force: true });
      host.renderer.ensureLoop?.();
    }
  }

  function createTrace(parameter, source, rawValue) {
    if (!debugTraceEnabled) {
      return null;
    }
    traceSeq += 1;
    return {
      traceId: `mhr-trace-${traceSeq}`,
      parameterKey: String(parameter?.key || ''),
      stateSection: String(parameter?.stateSection || ''),
      source: String(source || 'unknown'),
      rawValue: Number(rawValue),
      plugin: {
        inputTs: nowTraceTs(),
      },
    };
  }

  function queueParameterValue(parameter, rawValue, options = {}) {
    if (sceneState.lodSwitchInFlight) {
      return;
    }
    const numeric = Number(rawValue);
    const nextValue = clampToParameter(parameter, numeric);
    const trace = createTrace(parameter, options.source || 'ui', nextValue);
    if (trace) {
      trace.plugin = {
        ...(trace.plugin || {}),
        lastInputTs: nowTraceTs(),
        inputToPendingMs: 0,
      };
    }
    mhrService.applyPatch({
      [parameter.stateSection]: {
        [parameter.key]: nextValue,
      },
    }, {
      compareMode: DISPLAY_COMPARE_MODE,
      ...(buildCurrentInfluencePreviewRequest() ? { previewInfluence: buildCurrentInfluencePreviewRequest() } : {}),
      ...(trace ? { __debugTiming: trace } : {}),
    }).catch((error) => reportError('flush', error));
  }

  function dispatchInteractiveParameterValue(parameter, rawValue, options = {}) {
    if (sceneState.lodSwitchInFlight) {
      return;
    }
    const numeric = Number(rawValue);
    const nextValue = clampToParameter(parameter, numeric);
    const trace = createTrace(parameter, options.source || 'ui', nextValue);
    if (trace) {
      const dispatchTs = nowTraceTs();
      trace.plugin = {
        ...(trace.plugin || {}),
        lastInputTs: dispatchTs,
        inputToPendingMs: 0,
        flushStartTs: dispatchTs,
        setStateDispatchTs: dispatchTs,
        applyDispatchTs: dispatchTs,
        evaluateDispatchTs: dispatchTs,
        debounceWaitMs: 0,
      };
      lastDebugTrace = trace;
      globalThis.__MHR_DEBUG_TRACE__ = trace;
    }
    mhrService.applyPatch({
        [parameter.stateSection]: {
          [parameter.key]: nextValue,
        },
      }, {
        interactive: true,
        compareMode: DISPLAY_COMPARE_MODE,
        ...(buildCurrentInfluencePreviewRequest() ? { previewInfluence: buildCurrentInfluencePreviewRequest() } : {}),
        ...(trace ? { __debugTiming: trace } : {}),
      })
      .catch((error) => reportError('interactive-flush', error));
  }

  function getAssets() {
    return getMhrSnapshot(mhrSnapshot)?.assets || null;
  }

  function getParameters() {
    return Array.isArray(getAssets()?.parameterMetadata?.parameters)
      ? getAssets().parameterMetadata.parameters
      : [];
  }

  function syncDisplayAlignment() {
    const parameters = getParameters();
    sceneState.displayAlignmentRx = needsDisplayUpAlignment(parameters) ? MHR_TO_MJ_UP_ALIGNMENT_RX : 0;
  if (sceneState.meshHandle?.mesh) {
    sceneState.meshHandle.mesh.rotation.set(sceneState.displayAlignmentRx, 0, 0);
  }
  if (sceneState.ghostHandle?.mesh) {
    sceneState.ghostHandle.mesh.rotation.set(sceneState.displayAlignmentRx, 0, 0);
  }
  if (sceneState.skeletonHandle?.lines) {
    sceneState.skeletonHandle.lines.rotation.set(sceneState.displayAlignmentRx, 0, 0);
  }
  if (sceneState.skeletonMeshHandle?.mesh) {
    sceneState.skeletonMeshHandle.mesh.rotation.set(sceneState.displayAlignmentRx, 0, 0);
  }
  if (sceneState.skeletonPointsHandle?.mesh) {
    sceneState.skeletonPointsHandle.mesh.rotation.set(sceneState.displayAlignmentRx, 0, 0);
  }
  for (const handle of Object.values(sceneState.skeletonAxesHandles || {})) {
    if (handle?.mesh) {
      handle.mesh.rotation.set(sceneState.displayAlignmentRx, 0, 0);
    }
  }
}

  function getScaleParameters() {
    return getParameters().filter((parameter) => {
      const stateSection = String(parameter.stateSection || '');
      return (
        isAdjustableParameter(parameter)
        && stateSection === 'skeletalProportion'
      );
    });
  }

  function getBlendParameters() {
    return getParameters().filter((parameter) => (
      isAdjustableParameter(parameter)
      && String(parameter.stateSection || '') === 'surfaceShape'
    ));
  }

  function getExpressionParameters() {
    return getParameters().filter((parameter) => (
      isAdjustableParameter(parameter)
      && String(parameter.stateSection || '') === 'expression'
    ));
  }

  function getBlendRegionLabel(parameters, index) {
    const total = Array.isArray(parameters) ? parameters.length : 0;
    if (total <= 0) {
      return '';
    }
    if (index === 0) {
      return 'Body Region';
    }
    if (index === (BLEND_BODY_REGION_END + 1) && index < total) {
      return 'Face Region';
    }
    if (index === (BLEND_FACE_REGION_END + 1) && index < total) {
      return 'Hand Region';
    }
    return '';
  }

  function getFixedSlotParameters() {
    return getParameters().filter((parameter) => isFixedSlotParameter(parameter));
  }

  function getPoseParameters() {
    const parameters = getParameters();
    return [
      ...parameters.filter((parameter) => (
        isAdjustableParameter(parameter)
        && String(parameter.stateSection || '') === 'root'
      )),
      ...parameters.filter((parameter) => (
        isAdjustableParameter(parameter)
        && String(parameter.stateSection || '') === 'pose'
      )),
    ];
  }

  function getPoseFamilyParameters() {
    const parameters = getParameters();
    return parameters.filter((parameter) => {
      if (!isAdjustableParameter(parameter)) {
        return false;
      }
      const stateSection = String(parameter?.stateSection || '').trim();
      const key = String(parameter?.key || '').trim();
      if (stateSection !== 'pose') {
        return false;
      }
      return !/^root/i.test(key);
    });
  }

  function getFamilyParameters(familyKey) {
    switch (String(familyKey || '').trim()) {
      case 'scale':
        return getScaleParameters();
      case 'blend':
        return getBlendParameters();
      case 'expression':
        return getExpressionParameters();
      case 'pose':
        return getPoseFamilyParameters();
      case 'fixed':
        return getFixedSlotParameters();
      default:
        return [];
    }
  }

  function getFamilyRandomBounds(parameter, familyKey) {
    const bounds = getSliderBounds(parameter);
    const min = Number(bounds.min);
    const max = Number(bounds.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) {
      const value = getParameterDefaultValue(parameter);
      return { min: value, max: value };
    }
    if (familyKey === 'scale') {
      return { min, max };
    }
    const center = getParameterDefaultValue(parameter);
    let halfRange = (max - min) * 0.5;
    if (familyKey === 'pose') {
      halfRange *= FAMILY_RANDOM_POSE_RANGE_FRACTION;
    } else if (familyKey === 'fixed') {
      halfRange = Math.min(
        halfRange * FAMILY_RANDOM_FIXED_RANGE_FRACTION,
        FAMILY_RANDOM_FIXED_ABS_RADIUS,
      );
    }
    const nextMin = clampToBounds(center - halfRange, min, max);
    const nextMax = clampToBounds(center + halfRange, min, max);
    if (!(nextMax > nextMin)) {
      return { min, max };
    }
    return { min: nextMin, max: nextMax };
  }

  function buildSmoothRandomTargetMap(parameters, familyKey) {
    if (familyKey === 'blend') {
      return buildBlendRandomTargetMap(parameters);
    }
    if (familyKey === 'expression') {
      return buildFlatAbsoluteRandomTargetMap(parameters, FAMILY_RANDOM_EXPRESSION_ABS_RADIUS);
    }
    const values = new Map();
    for (const parameter of parameters) {
      const key = String(parameter?.key || '').trim();
      if (!key) {
        continue;
      }
      const bounds = getFamilyRandomBounds(parameter, familyKey);
      const min = Number(bounds.min);
      const max = Number(bounds.max);
      if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) {
        values.set(key, getParameterDefaultValue(parameter));
        continue;
      }
      values.set(key, min + ((max - min) * sampleSmoothNormalized()));
    }
    return values;
  }

  function buildBlendRandomTargetMap(parameters) {
    const values = new Map();
    for (let index = 0; index < parameters.length; index += 1) {
      const parameter = parameters[index];
      const key = String(parameter?.key || '').trim();
      if (!key) {
        continue;
      }
      const center = getParameterDefaultValue(parameter);
      const centered = (sampleSmoothNormalized() * 2) - 1;
      const absRadius = index < FAMILY_RANDOM_BLEND_LEADING_COUNT
        ? FAMILY_RANDOM_BLEND_LEADING_ABS_RADIUS
        : FAMILY_RANDOM_BLEND_ABS_RADIUS;
      values.set(key, center + (centered * absRadius));
    }
    return values;
  }

  function buildFlatAbsoluteRandomTargetMap(parameters, absRadius) {
    const values = new Map();
    for (const parameter of parameters) {
      const key = String(parameter?.key || '').trim();
      if (!key) {
        continue;
      }
      const center = getParameterDefaultValue(parameter);
      const centered = (sampleSmoothNormalized() * 2) - 1;
      values.set(key, center + (centered * absRadius));
    }
    return values;
  }

  function createFamilyRandomAnimationState(familyKey, parameters) {
    const now = performance.now();
    const startValues = new Map();
    for (const parameter of parameters) {
      startValues.set(String(parameter?.key || ''), getParameterValue(mhrSnapshot, parameter));
    }
    return {
      startedAt: now,
      durationMs: FAMILY_RANDOM_TRANSITION_MIN_MS
        + ((FAMILY_RANDOM_TRANSITION_MAX_MS - FAMILY_RANDOM_TRANSITION_MIN_MS) * Math.random()),
      familyKey,
      startValues,
      targetValues: buildSmoothRandomTargetMap(parameters, familyKey),
      lastSubmittedAt: 0,
      lastSubmittedSignature: '',
    };
  }

  function ensureFamilyRandomAnimationState(familyKey, parameters) {
    const current = sceneState.familyRandomState[familyKey];
    if (current && current.startValues instanceof Map && current.targetValues instanceof Map) {
      return current;
    }
    const next = createFamilyRandomAnimationState(familyKey, parameters);
    sceneState.familyRandomState[familyKey] = next;
    return next;
  }

  function buildFamilyInterpolatedPatch(parameters, animationState, now) {
    if (!animationState) {
      return null;
    }
    const elapsed = Math.max(0, now - Number(animationState.startedAt || 0));
    const durationMs = Math.max(1, Number(animationState.durationMs || FAMILY_RANDOM_TRANSITION_MIN_MS));
    if (elapsed >= durationMs) {
      animationState.startedAt = now;
      animationState.durationMs = FAMILY_RANDOM_TRANSITION_MIN_MS
        + ((FAMILY_RANDOM_TRANSITION_MAX_MS - FAMILY_RANDOM_TRANSITION_MIN_MS) * Math.random());
      animationState.startValues = animationState.targetValues;
        animationState.targetValues = buildSmoothRandomTargetMap(parameters, String(animationState.familyKey || ''));
    }
    const progress = Math.max(0, Math.min(1, (now - animationState.startedAt) / Math.max(1, animationState.durationMs)));
    const eased = progress * progress * (3 - (2 * progress));
    const patch = Object.create(null);
    for (const parameter of parameters) {
      const section = String(parameter?.stateSection || '').trim();
      const key = String(parameter?.key || '').trim();
      if (!section || !key) {
        continue;
      }
      if (!patch[section]) {
        patch[section] = Object.create(null);
      }
      const startValue = Number(animationState.startValues?.get(key));
      const targetValue = Number(animationState.targetValues?.get(key));
      const baseValue = Number.isFinite(startValue) ? startValue : getParameterValue(mhrSnapshot, parameter);
      const nextTarget = Number.isFinite(targetValue) ? targetValue : baseValue;
      patch[section][key] = baseValue + ((nextTarget - baseValue) * eased);
    }
    return patch;
  }

  function patchSignature(patch) {
    return JSON.stringify(patch || {});
  }

  function readTraceRoundtripMs(trace = lastDebugTrace) {
    const inputTs = Number(trace?.plugin?.inputTs);
    const receiveTs = Number(trace?.mainThread?.evaluationEventReceiveTs);
    if (!Number.isFinite(inputTs) || !Number.isFinite(receiveTs) || receiveTs <= inputTs) {
      return null;
    }
    return receiveTs - inputTs;
  }

  function updateFamilyRandomObservedRoundtripMs(trace = lastDebugTrace) {
    if (!Object.values(sceneState.familyRandomEnabled).some(Boolean)) {
      sceneState.familyRandomUpshiftVotes = 0;
      sceneState.familyRandomDownshiftVotes = 0;
      return sceneState.familyRandomObservedRoundtripMs;
    }
    if (String(trace?.source || '') !== 'family-random') {
      return sceneState.familyRandomObservedRoundtripMs;
    }
    const nextRoundtripMs = readTraceRoundtripMs(trace);
    if (!Number.isFinite(nextRoundtripMs) || nextRoundtripMs <= 0) {
      sceneState.familyRandomUpshiftVotes = 0;
      sceneState.familyRandomDownshiftVotes = 0;
      return sceneState.familyRandomObservedRoundtripMs;
    }
    const previous = Number(sceneState.familyRandomObservedRoundtripMs || 0);
    if (!Number.isFinite(previous) || previous <= 0) {
      sceneState.familyRandomObservedRoundtripMs = nextRoundtripMs;
      return sceneState.familyRandomObservedRoundtripMs;
    }
    sceneState.familyRandomObservedRoundtripMs =
      previous + ((nextRoundtripMs - previous) * FAMILY_RANDOM_ROUNDTRIP_EMA_ALPHA);
    return sceneState.familyRandomObservedRoundtripMs;
  }

  function chooseFamilyRandomTargetFps() {
    const roundtripMs = Number(sceneState.familyRandomObservedRoundtripMs || 0);
    if (!Number.isFinite(roundtripMs) || roundtripMs <= 0) {
      return FAMILY_RANDOM_DEFAULT_TARGET_FPS;
    }
    const currentFps = Number(sceneState.familyRandomCadenceFps || FAMILY_RANDOM_DEFAULT_TARGET_FPS);
    let index = FAMILY_RANDOM_TARGET_FPS_TIERS.indexOf(currentFps);
    if (index < 0) {
      index = FAMILY_RANDOM_TARGET_FPS_TIERS.indexOf(FAMILY_RANDOM_DEFAULT_TARGET_FPS);
      if (index < 0) {
        index = 0;
      }
    }
    let desiredIndex = FAMILY_RANDOM_TARGET_FPS_TIERS.length - 1;
    for (let candidateIndex = 0; candidateIndex < FAMILY_RANDOM_TARGET_FPS_TIERS.length; candidateIndex += 1) {
      const candidateFps = FAMILY_RANDOM_TARGET_FPS_TIERS[candidateIndex];
      const maxRoundtripMs = Number(FAMILY_RANDOM_TARGET_MAX_ROUNDTRIP_MS[candidateFps] || 0);
      if (roundtripMs <= maxRoundtripMs) {
        desiredIndex = candidateIndex;
        break;
      }
    }
    if (desiredIndex > index) {
      sceneState.familyRandomDownshiftVotes += 1;
      sceneState.familyRandomUpshiftVotes = 0;
      if (sceneState.familyRandomDownshiftVotes >= FAMILY_RANDOM_DOWNSHIFT_STREAK) {
        sceneState.familyRandomDownshiftVotes = 0;
        index = desiredIndex;
      }
    } else if (desiredIndex < index) {
      sceneState.familyRandomUpshiftVotes += 1;
      sceneState.familyRandomDownshiftVotes = 0;
      if (sceneState.familyRandomUpshiftVotes >= FAMILY_RANDOM_UPSHIFT_STREAK) {
        sceneState.familyRandomUpshiftVotes = 0;
        index = desiredIndex;
      }
    } else {
      sceneState.familyRandomUpshiftVotes = 0;
      sceneState.familyRandomDownshiftVotes = 0;
    }
    return FAMILY_RANDOM_TARGET_FPS_TIERS[index];
  }

  function hasActiveFamilyRandomFamilies() {
    return Object.values(sceneState.familyRandomEnabled).some(Boolean);
  }

  function resetFamilyRandomCadenceState() {
    sceneState.familyRandomLastCommitTs = 0;
    sceneState.familyRandomNextCommitTs = 0;
    sceneState.familyRandomLastSubmittedSignature = '';
    sceneState.familyRandomCadenceMs = 1000 / FAMILY_RANDOM_DEFAULT_TARGET_FPS;
    sceneState.familyRandomCadenceFps = FAMILY_RANDOM_DEFAULT_TARGET_FPS;
    sceneState.familyRandomObservedRoundtripMs = 1000 / FAMILY_RANDOM_DEFAULT_TARGET_FPS;
    sceneState.familyRandomUpshiftVotes = 0;
    sceneState.familyRandomDownshiftVotes = 0;
  }

  function updateFamilyRandomCommitSchedule(nowMs, targetFps) {
    const intervalMs = 1000 / targetFps;
    const previousFps = Number(sceneState.familyRandomCadenceFps || 0);
    const previousNextCommitTs = Number(sceneState.familyRandomNextCommitTs || 0);
    sceneState.familyRandomCadenceMs = intervalMs;
    sceneState.familyRandomCadenceFps = targetFps;
    if (!Number.isFinite(previousNextCommitTs) || previousNextCommitTs <= 0) {
      sceneState.familyRandomNextCommitTs = nowMs;
      return;
    }
    if (previousFps !== targetFps) {
      const baseCommitTs = Number(sceneState.familyRandomLastCommitTs || nowMs);
      sceneState.familyRandomNextCommitTs = Math.max(previousNextCommitTs, baseCommitTs + intervalMs);
    }
  }

  function advanceFamilyRandomCommitSchedule(nowMs) {
    const intervalMs = Number(sceneState.familyRandomCadenceMs || 0);
    sceneState.familyRandomLastCommitTs = nowMs;
    if (!(intervalMs > 0)) {
      sceneState.familyRandomNextCommitTs = nowMs;
      return;
    }
    let nextCommitTs = Number(sceneState.familyRandomNextCommitTs || nowMs);
    if (!Number.isFinite(nextCommitTs) || nextCommitTs <= 0) {
      nextCommitTs = nowMs;
    }
    do {
      nextCommitTs += intervalMs;
    } while (nextCommitTs <= nowMs);
    sceneState.familyRandomNextCommitTs = nextCommitTs;
  }

  function driveFamilyRandomAnimation() {
    if (sceneState.lodSwitchInFlight) {
      return;
    }
    const now = performance.now();
    const families = [
      ['scale', getFamilyParameters('scale')],
      ['blend', getFamilyParameters('blend')],
      ['expression', getFamilyParameters('expression')],
      ['pose', getFamilyParameters('pose')],
      ['fixed', getFamilyParameters('fixed')],
    ];
    const patch = Object.create(null);
    let hasValues = false;
    for (const [familyKey, parameters] of families) {
      if (!sceneState.familyRandomEnabled[familyKey] || !parameters.length) {
        continue;
      }
      const animationState = ensureFamilyRandomAnimationState(familyKey, parameters);
      const familyPatch = buildFamilyInterpolatedPatch(parameters, animationState, now);
      if (!familyPatch) {
        continue;
      }
      for (const [section, values] of Object.entries(familyPatch)) {
        if (!patch[section]) {
          patch[section] = Object.create(null);
        }
        Object.assign(patch[section], values);
        if (Object.keys(values).length > 0) {
          hasValues = true;
        }
      }
    }
    if (!hasValues) {
      return;
    }
    const targetFps = chooseFamilyRandomTargetFps();
    updateFamilyRandomCommitSchedule(now, targetFps);
    if (now < Number(sceneState.familyRandomNextCommitTs || 0)) {
      host.renderer.ensureLoop?.();
      return;
    }
    const signature = patchSignature(patch);
    if (signature === sceneState.familyRandomLastSubmittedSignature) {
      advanceFamilyRandomCommitSchedule(now);
      host.renderer.ensureLoop?.();
      return;
    }
    sceneState.familyRandomLastSubmittedSignature = signature;
    advanceFamilyRandomCommitSchedule(now);
    const patchedFamilies = new Set(
      families
        .filter(([familyKey]) => sceneState.familyRandomEnabled[familyKey])
        .map(([familyKey]) => familyKey),
    );
    const trace = {
      traceId: `mhr-trace-${++traceSeq}`,
      parameterKey: 'family-random',
      stateSection: 'multi',
      source: 'family-random',
      plugin: {
        inputTs: nowTraceTs(),
      },
    };
    mhrService.applyPatch(patch, {
      interactive: true,
      compareMode: DISPLAY_COMPARE_MODE,
      __debugTiming: trace,
    }).catch((error) => {
      for (const familyKey of patchedFamilies) {
        sceneState.familyRandomEnabled[familyKey] = false;
        sceneState.familyRandomState[familyKey] = null;
      }
      if (!hasActiveFamilyRandomFamilies()) {
        resetFamilyRandomCadenceState();
      }
      reportError('family-random:interactive', error);
    });
    host.renderer.ensureLoop?.();
  }

  function getParameterGroupKey(parameter) {
    if (String(parameter?.stateSection || '') === 'root') {
      return 'root';
    }
    return String(parameter?.group || parameter?.stateSection || 'misc');
  }

  function getParameterDisplayLabel(parameter) {
    const rawLabel = String(parameter?.label || parameter?.key || '').trim();
    if (!rawLabel) {
      return String(parameter?.key || '');
    }
    if (String(parameter?.stateSection || '') === 'surfaceShape') {
      const match = /^blend_(\d+)$/i.exec(rawLabel);
      if (match) {
        return `#${match[1]}`;
      }
    }
    return rawLabel.replace(/^scale_/i, '');
  }

  function getSectionTitle(baseTitle, familyLabel) {
    const suffix = String(familyLabel || '').trim();
    if (!suffix) {
      return baseTitle;
    }
    return `${baseTitle}: ${suffix}`;
  }

  function updateGhostButtonState() {
    const button = controlButtons.ghost;
    if (!button) {
      return;
    }
    button.textContent = sceneState.ghostCaptured ? 'Clear ghost' : 'Capture ghost';
  }

  function getParameterSignature(parameters) {
    return parameters.map((parameter) => `${parameter.stateSection}:${parameter.key}`).join('|');
  }

  function getParameterRowKey(parameter) {
    return `${parameter.stateSection}:${parameter.key}`;
  }

  function getParameterStep(parameter) {
    return Number(getSliderBounds(parameter).step || 0.001);
  }

  function getRangeDisplayValue(parameter, value) {
    const { min, max } = getSliderBounds(parameter);
    return clampToBounds(value, min, max);
  }

  function formatParameterValue(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '';
    return Number(numeric.toPrecision(6)).toString();
  }

  function replaceChildren(root, children) {
    root.replaceChildren(...children);
  }

  function createPanelSeparator(label) {
    const node = document.createElement('div');
    node.className = 'mhr-panel-separator';
    node.textContent = String(label || '').trim();
    return node;
  }

  function syncRowValue(rowState) {
    const nextValue = clampToParameter(rowState.parameter, getParameterValue(mhrSnapshot, rowState.parameter));
    rowState.range.value = String(getRangeDisplayValue(rowState.parameter, nextValue));
    if (!rowState.editing) {
      rowState.textbox.value = formatParameterValue(nextValue);
      rowState.draft = rowState.textbox.value;
    }
  }

  function commitTextboxValue(rowState) {
    rowState.editing = false;
    const raw = String(rowState.textbox.value || '').trim();
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      syncRowValue(rowState);
      return;
    }
    const nextValue = clampToParameter(rowState.parameter, parsed);
    rowState.draft = raw;
    queueParameterValue(rowState.parameter, nextValue, { source: 'textbox' });
  }

  function createParameterWidget(parameter, options = {}) {
    const testIdPrefix = options.testIdPrefix || 'mhr-param';
    const layoutVariant = options.layoutVariant || 'stacked';
    const rowKey = getParameterRowKey(parameter);
    const controlsRow = kit.fullRow();
    controlsRow.row.classList.add('mhr-param-row');
    controlsRow.row.classList.toggle('mhr-param-row--stacked', layoutVariant === 'stacked');
    controlsRow.row.setAttribute('data-testid', `${testIdPrefix}-${parameter.key}`);
    controlsRow.row.dataset.mhrStateSection = String(parameter.stateSection || '');
    controlsRow.row.dataset.mhrGroup = getParameterGroupKey(parameter);
    controlsRow.row.dataset.mhrParamKey = String(parameter.key || '');
    controlsRow.field.classList.add('mhr-param-controls');
    controlsRow.field.classList.toggle('mhr-param-controls--stacked', layoutVariant === 'stacked');

    const title = document.createElement('div');
    title.className = 'mhr-param-name';
    title.textContent = getParameterDisplayLabel(parameter);
    controlsRow.row.addEventListener('pointerdown', () => {
      setSelectedParameter(parameter, rowKey);
    });

    const { min, max, step } = getSliderBounds(parameter);
    const initialValue = getParameterValue(mhrSnapshot, parameter);

    const range = kit.range({
      value: getRangeDisplayValue(parameter, initialValue),
      min,
      max,
      step,
      testId: `${testIdPrefix}-range-${parameter.key}`,
      onInput: (_event, nextValue) => {
        setSelectedParameter(parameter, rowKey);
        const clamped = clampToBounds(nextValue, min, max);
        range.value = String(clamped);
        dispatchInteractiveParameterValue(parameter, clamped, { source: 'slider' });
      },
    });

    const textbox = kit.textbox({
      value: formatParameterValue(getParameterValue(mhrSnapshot, parameter)),
      testId: `${testIdPrefix}-text-${parameter.key}`,
      onInput: (_event, nextValue) => {
        const currentRow = findRowState(rowKey);
        if (!currentRow) return;
        currentRow.editing = true;
        currentRow.draft = String(nextValue ?? '');
      },
    });
    textbox.classList.add('mhr-param-textbox');
    textbox.inputMode = 'decimal';
    textbox.spellcheck = false;
    textbox.addEventListener('focus', () => {
      setSelectedParameter(parameter, rowKey);
      const currentRow = findRowState(rowKey);
      if (!currentRow) return;
      currentRow.editing = true;
      currentRow.draft = textbox.value;
    });
    textbox.addEventListener('blur', () => {
      const currentRow = findRowState(rowKey);
      if (!currentRow) return;
      commitTextboxValue(currentRow);
    });
    textbox.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        textbox.blur();
      }
    });

    controlsRow.field.append(title, range, textbox);

    return {
      key: rowKey,
      parameter,
      root: controlsRow.row,
      range,
      textbox,
      editing: false,
      draft: textbox.value,
    };
  }

  function findRowState(rowKey) {
    return rowRegistry.scale.get(rowKey)
      || rowRegistry.blend.get(rowKey)
      || rowRegistry.expression.get(rowKey)
      || rowRegistry.fixed.get(rowKey)
      || rowRegistry.pose.get(rowKey)
      || null;
  }

  function rebuildPanel(root, panelKey, parameters, options = {}) {
    if (!root) return;
    const registry = rowRegistry[panelKey];
    registry.clear();

    if (!parameters.length) {
      panelSignature[panelKey] = '';
      const empty = document.createElement('div');
      empty.className = 'mhr-empty';
      empty.textContent = options.emptyText || 'No parameters available.';
      replaceChildren(root, [empty]);
      return;
    }

    const stack = document.createElement('div');
    stack.className = 'mhr-panel-stack';
    parameters.forEach((parameter, index) => {
      const separatorLabel = typeof options.getSeparatorLabel === 'function'
        ? options.getSeparatorLabel(parameters, index, parameter)
        : '';
      if (separatorLabel) {
        stack.append(createPanelSeparator(separatorLabel));
      }
      const rowState = createParameterWidget(parameter, {
        testIdPrefix: options.testIdPrefix || 'mhr-param',
        layoutVariant: typeof options.getLayoutVariant === 'function'
          ? options.getLayoutVariant(parameters, index, parameter)
          : 'stacked',
      });
      registry.set(rowState.key, rowState);
      if (rowState.key === sceneState.selectedParameterRowKey) {
        rowState.root.classList.add('is-selected');
      }
      stack.append(rowState.root);
    });
    panelSignature[panelKey] = getParameterSignature(parameters);
    replaceChildren(root, [stack]);
  }

  function syncPanel(panelKey, root, parameters, options = {}) {
    if (!root) return;
    const nextSignature = getParameterSignature(parameters);
    if (panelSignature[panelKey] !== nextSignature || rowRegistry[panelKey].size !== parameters.length) {
      rebuildPanel(root, panelKey, parameters, options);
    }
    syncPanelValues(panelKey, parameters);
  }

  function syncPanelValues(panelKey, parameters) {
    for (const parameter of parameters) {
      const rowState = rowRegistry[panelKey].get(getParameterRowKey(parameter));
      if (!rowState) continue;
      syncRowValue(rowState);
    }
  }

  function buildResetPatch(parameters) {
    const patch = Object.create(null);
    for (const parameter of parameters) {
      const stateSection = String(parameter?.stateSection || '').trim();
      const key = String(parameter?.key || '').trim();
      if (!stateSection || !key) {
        continue;
      }
      if (!patch[stateSection]) {
        patch[stateSection] = Object.create(null);
      }
      patch[stateSection][key] = getParameterDefaultValue(parameter);
    }
    return patch;
  }

  function updateResetButtonState(panelKey, parameters) {
    const button = sectionResetButtons[panelKey];
    if (!button) {
      return;
    }
    button.disabled = !(Array.isArray(parameters) && parameters.length > 0);
  }

  function createSectionResetRow(panelKey, label, getParametersForPanel) {
    const row = document.createElement('div');
    row.className = 'action-row mhr-reset-row';
    row.style.gridColumn = '1 / -1';
    const button = kit.button({
      label,
      variant: 'pill',
      testId: `mhr-reset-${panelKey}`,
      onClick: async () => {
        const parameters = getParametersForPanel();
        if (!parameters.length) {
          return;
        }
        const patch = buildResetPatch(parameters);
        try {
          await mhrService.applyPatch(patch, {
            interactive: false,
            ...(buildCurrentInfluencePreviewRequest() ? { previewInfluence: buildCurrentInfluencePreviewRequest() } : {}),
          });
        } catch (error) {
          reportError(`reset:${panelKey}`, error);
          throw error;
        }
      },
    });
    button.disabled = true;
    row.append(button);
    appendGridSpacer(row);
    sectionResetButtons[panelKey] = button;
    return row;
  }

  function appendGridSpacer(row) {
    const spacer = document.createElement('div');
    spacer.className = 'mhr-grid-spacer';
    spacer.setAttribute('aria-hidden', 'true');
    row.append(spacer);
    return spacer;
  }

  function createControlCell(content, className = '') {
    const cell = document.createElement('div');
    cell.className = className ? `mhr-control-cell ${className}` : 'mhr-control-cell';
    cell.append(content);
    return cell;
  }

  function createControlGrid(cells, gridClass) {
    const grid = document.createElement('div');
    grid.className = gridClass;
    for (const cell of cells) {
      grid.append(cell);
    }
    return grid;
  }

  function createActionCell({ label, testId, onClick }) {
    const button = kit.button({
      label,
      variant: 'pill',
      testId,
      onClick,
    });
    const row = document.createElement('div');
    row.className = 'action-row';
    row.append(button);
    return { row: createControlCell(row, 'mhr-control-action-cell'), button };
  }

  function createControlRow() {
    const align = createActionCell({
      label: 'Align view',
      testId: 'mhr-align-view',
      onClick: () => {
        sceneState.cameraFramed = false;
        sceneState.meshBoundsDirty = true;
        if (ensureMeshBounds(sceneState)) {
          fitCameraToMesh(host, sceneState, { force: true });
        }
        host.renderer.ensureLoop?.();
      },
    });
    const ghost = createActionCell({
      label: 'Capture ghost',
      testId: 'mhr-capture-ghost',
      onClick: () => {
        const assets = getMhrSnapshot(mhrSnapshot)?.assets || null;
        const vertices = getMhrSnapshot(mhrSnapshot)?.evaluation?.mesh?.vertices || null;
        if (!assets?.topology || !vertices) {
          return;
        }
        if (sceneState.ghostCaptured) {
          sceneState.ghostCaptured = false;
          if (sceneState.ghostHandle?.mesh) {
            sceneState.ghostHandle.mesh.visible = false;
          }
          updateGhostButtonState();
          host.renderer.ensureLoop?.();
          return;
        }
        ensureGhostHandle(sceneState, assets.topology, vertices);
        if (sceneState.ghostGeometry) {
          const position = sceneState.ghostGeometry.getAttribute('position');
          position.array.set(vertices, 0);
          position.needsUpdate = true;
          sceneState.ghostGeometry.computeVertexNormals();
          sceneState.ghostGeometry.computeBoundingBox();
          sceneState.ghostGeometry.computeBoundingSphere();
        }
        syncDisplayAlignment();
        if (sceneState.ghostHandle?.mesh) {
          sceneState.ghostHandle.mesh.visible = true;
        }
        sceneState.ghostCaptured = true;
        updateGhostButtonState();
        host.renderer.ensureLoop?.();
      },
    });
    controlButtons.ghost = ghost.button;
    updateGhostButtonState();
    return createControlGrid([align.row, ghost.row], 'mhr-control-action-row');
  }

  function createLodControlRow() {
    const { row, label, field } = kit.namedRow('LoD');
    row.setAttribute('data-testid', 'mhr-lod-row');
    const select = kit.select({
      value: String(currentLod()),
      options: SUPPORTED_LODS.map((lod) => ({
        value: String(lod),
        label: formatLodOptionLabel(lod, null),
      })),
      testId: 'mhr-lod-select',
      onChange: (_event, nextValue) => {
        void switchLod(Number(nextValue));
      },
    });
    field.append(select);
    controlRefs.lodRow = row;
    controlRefs.lodLabel = label;
    controlRefs.lodSelect = select;
    syncLodSelectRow();
    void ensureLodMetadataLoaded();
    return row;
  }

  function createVisibilityToggle({ label, value, testId, onChange }) {
    const { root } = kit.boolButton({
      label,
      value,
      testId,
      onChange: (_event, nextValue) => {
        onChange?.(!!nextValue);
      },
    });
    return createControlCell(root, 'mhr-control-bool-cell');
  }

  function applyThemeMode(nextDarkTheme) {
    const colorValue = nextDarkTheme ? 0 : 1;
    sceneState.darkTheme = !!nextDarkTheme;
    if (host.store && typeof host.store.update === 'function') {
      host.store.update((draft) => {
        if (!draft.theme || typeof draft.theme !== 'object') {
          draft.theme = {};
        }
        draft.theme.color = colorValue;
      });
    }
    const documentRef = globalThis.document;
    const root = documentRef?.documentElement || null;
    if (root) {
      if (colorValue === 1) {
        root.setAttribute('data-play-theme', 'light');
      } else {
        root.removeAttribute('data-play-theme');
      }
    }
    if (documentRef?.body) {
      documentRef.body.classList.toggle('theme-light', colorValue === 1);
    }
  }

  function createPrimaryVisibilityControls() {
    const cells = [
      {
        label: 'Show skin',
        value: sceneState.skinVisible,
        testId: 'mhr-skin-visible',
        onChange: (nextValue) => {
          sceneState.skinVisible = nextValue;
          syncMeshVisibility(sceneState, true);
          sceneDirty = true;
          host.renderer.ensureLoop?.();
        },
      },
      {
        label: 'Show skeleton',
        value: sceneState.skeletonVisible,
        testId: 'mhr-skeleton-visible',
        onChange: (nextValue) => {
          sceneState.skeletonVisible = nextValue;
          syncSkeletonVisibility(sceneState);
          sceneDirty = true;
          host.renderer.ensureLoop?.();
        },
      },
      {
        label: 'Dark theme',
        value: sceneState.darkTheme,
        testId: 'mhr-dark-theme',
        onChange: (nextValue) => {
          applyThemeMode(!!nextValue);
          host.renderer.ensureLoop?.();
        },
      },
      {
        label: 'Translucent skin',
        value: sceneState.skinHalfTransparent,
        testId: 'mhr-skin-half-transparent',
        onChange: (nextValue) => {
          sceneState.skinHalfTransparent = nextValue;
          syncSkinTransparency(sceneState);
          host.renderer.ensureLoop?.();
        },
      },
      {
        label: 'Joint labels',
        value: sceneState.jointLabelsVisible,
        testId: 'mhr-joint-labels',
        onChange: (nextValue) => {
          sceneState.jointLabelsVisible = nextValue;
          host.renderer.ensureLoop?.();
        },
      },
      {
        label: 'Local axes',
        value: sceneState.jointAxesVisible,
        testId: 'mhr-joint-axes',
        onChange: (nextValue) => {
          sceneState.jointAxesVisible = nextValue;
          sceneDirty = true;
          host.renderer.ensureLoop?.();
        },
      },
      {
        label: 'Influence preview',
        value: sceneState.influencePreviewVisible,
        testId: 'mhr-influence-preview',
        onChange: (nextValue) => {
          sceneState.influencePreviewVisible = nextValue;
          if (!nextValue) {
            clearInfluencePreview();
          } else {
            const hasSnapshotPreview = consumeSnapshotInfluencePreview(mhrSnapshot);
            if (!hasSnapshotPreview) {
              clearInfluencePreview();
            }
            queueCurrentInfluencePreviewRequest({ force: true });
          }
          sceneDirty = true;
          host.renderer.ensureLoop?.();
        },
      },
    ].map(createVisibilityToggle);
    return createControlGrid(cells, 'mhr-control-bool-row');
  }

  function createFreeBlendWarningRow() {
    const { row, field } = kit.fullRow();
    row.classList.add('control-static');
    field.classList.add('mhr-control-note-row');
    field.textContent = '* Free blend and free expression can be unsettling.';
    return row;
  }

  function createFamilyRandomControls(items) {
    const cells = items.map((item) => createVisibilityToggle({
      label: item.label,
      value: !!sceneState.familyRandomEnabled[item.key],
      testId: item.testId,
      onChange: (nextValue) => {
        sceneState.familyRandomEnabled[item.key] = nextValue;
        sceneState.familyRandomUpshiftVotes = 0;
        sceneState.familyRandomDownshiftVotes = 0;
        const parameters = getFamilyParameters(item.key);
        if (!parameters.length) {
          return;
        }
        if (!nextValue) {
          sceneState.familyRandomState[item.key] = null;
          if (!hasActiveFamilyRandomFamilies()) {
            resetFamilyRandomCadenceState();
          }
          mhrService.applyPatch(buildResetPatch(parameters), {
            interactive: true,
            compareMode: DISPLAY_COMPARE_MODE,
          }).catch((error) => {
            sceneState.familyRandomEnabled[item.key] = true;
            reportError(`family-random:${item.key}`, error);
          });
          host.renderer.ensureLoop?.();
          return;
        }
        sceneState.familyRandomState[item.key] = createFamilyRandomAnimationState(item.key, parameters);
        if (hasActiveFamilyRandomFamilies() && !(sceneState.familyRandomNextCommitTs > 0)) {
          sceneState.familyRandomNextCommitTs = performance.now();
        }
        host.renderer.ensureLoop?.();
      },
    }));
    return createControlGrid(cells, 'mhr-control-bool-row');
  }

  function renderScalePanel() {
    const parameters = getScaleParameters();
    syncPanel('scale', sectionRoots.scale, parameters, {
      emptyText: 'Scale parameters will appear after bundle load.',
      testIdPrefix: 'mhr-scale',
    });
    updateResetButtonState('scale', parameters);
  }

  function renderBlendPanel() {
    const parameters = getBlendParameters();
    syncPanel('blend', sectionRoots.blend, parameters, {
      emptyText: 'Blend parameters will appear after bundle load.',
      testIdPrefix: 'mhr-blend',
      getSeparatorLabel: getBlendRegionLabel,
    });
    updateResetButtonState('blend', parameters);
  }

  function renderExpressionPanel() {
    const parameters = getExpressionParameters();
    syncPanel('expression', sectionRoots.expression, parameters, {
      emptyText: 'Expression parameters will appear after bundle load.',
      testIdPrefix: 'mhr-expression',
    });
    updateResetButtonState('expression', parameters);
  }

  function renderFixedPanel() {
    const parameters = getFixedSlotParameters();
    syncPanel('fixed', sectionRoots.fixed, parameters, {
      emptyText: 'Fixed raw slots will appear after bundle load.',
      testIdPrefix: 'mhr-fixed',
    });
    updateResetButtonState('fixed', parameters);
  }

  function renderPosePanel() {
    const parameters = getPoseParameters();
    syncPanel('pose', sectionRoots.pose, parameters, {
      emptyText: 'Pose parameters will appear after bundle load.',
      testIdPrefix: 'mhr-pose',
    });
    updateResetButtonState('pose', parameters);
  }

  function updateScene() {
    const mhr = getMhrSnapshot(mhrSnapshot);
    const assets = mhr?.assets;
    const evaluation = mhr?.evaluation;
    if (!assets?.topology || !assets?.jointParents || !evaluation?.mesh?.vertices || !evaluation?.skeleton?.states) {
      return;
    }
    const trace = evaluation?.debug?.debugTiming && typeof evaluation.debug.debugTiming === 'object'
      ? evaluation.debug.debugTiming
      : null;
    const geometryStartTs = nowTraceTs();
    ensureLighting(sceneState);
    ensureMeshHandle(sceneState, assets.topology, evaluation.mesh.vertices);
    ensureSkeletonHandle(sceneState, assets.jointParents);
    ensureSkeletonMeshHandle(sceneState, assets.jointParents);
    ensureSkeletonPointsHandle(sceneState, assets.jointParents);
    ensureSkeletonAxesHandle(sceneState, assets.jointParents);
    syncDisplayAlignment();
    consumeSnapshotInfluencePreview(mhrSnapshot);

    let afterGeometryUploadTs = geometryStartTs;
    let afterNormalsTs = geometryStartTs;
    let afterBoundsTs = geometryStartTs;
    let afterColorTs = geometryStartTs;
    let colorApplied = false;
    if (sceneState.meshGeometry) {
      const position = sceneState.meshGeometry.getAttribute('position');
      position.array.set(evaluation.mesh.vertices, 0);
      position.needsUpdate = true;
      afterGeometryUploadTs = nowTraceTs();
      sceneState.meshGeometry.computeVertexNormals();
      afterNormalsTs = nowTraceTs();
      if (ensureMeshBounds(sceneState)) {
        fitCameraToMesh(host, sceneState);
        afterBoundsTs = nowTraceTs();
      } else {
        afterBoundsTs = afterNormalsTs;
      }
      if (sceneState.meshHandle?.mesh) {
        syncMeshVisibility(sceneState, evaluation.mesh.visible !== false);
      }
      colorApplied = writeMeshColors(sceneState, evaluation.mesh.vertices) === true;
      afterColorTs = colorApplied ? nowTraceTs() : afterBoundsTs;
    }

    writeSkeleton(
      sceneState,
      evaluation.skeleton.states,
      assets.jointParents,
      evaluation.skeleton.visible !== false,
    );
    writeSkeletonAxes(
      sceneState,
      evaluation.skeleton.states,
      evaluation.skeleton.visible !== false && sceneState.jointAxesVisible,
    );
    const afterSkeletonTs = nowTraceTs();
    if (trace) {
      syncTraceFields(trace, {
        eventToGeometryStartMs: Number.isFinite(Number(trace.mainThread?.evaluationEventReceiveTs))
          ? geometryStartTs - Number(trace.mainThread.evaluationEventReceiveTs)
          : 0,
        geometryApplyMs: afterGeometryUploadTs - geometryStartTs,
        normalsUpdateMs: afterNormalsTs - afterGeometryUploadTs,
        boundsUpdateMs: afterBoundsTs - afterNormalsTs,
        meshColorApplyMs: afterColorTs - afterBoundsTs,
        meshColorApplied: colorApplied,
        skeletonApplyMs: afterSkeletonTs - afterColorTs,
        geometryApplyCompleteTs: afterSkeletonTs,
      });
      lastDebugTrace = trace;
      globalThis.__MHR_DEBUG_TRACE__ = trace;
      requestAnimationFrame(() => {
        const firstPresentedTs = nowTraceTs();
        trace.mainThread = {
          ...(trace.mainThread || {}),
          firstPresentedFrameTs: firstPresentedTs,
          firstPresentedAfterGeometryMs: firstPresentedTs - afterSkeletonTs,
        };
        requestAnimationFrame(() => {
          const settledTs = nowTraceTs();
          trace.mainThread = {
            ...(trace.mainThread || {}),
            visuallySettledFrameTs: settledTs,
            visuallySettledAfterGeometryMs: settledTs - afterSkeletonTs,
          };
          lastDebugTrace = trace;
          globalThis.__MHR_DEBUG_TRACE__ = trace;
        });
      });
    }
    lastRenderedPreviewToken = buildInfluencePreviewSnapshotToken(mhrSnapshot);
    host.renderer.ensureLoop?.();
  }

  function currentAssetsKey(snapshot = mhrSnapshot) {
    const assets = getMhrSnapshot(snapshot)?.assets || null;
    return `${assets?.bundleId || ''}:${assets?.parameterMetadata?.parameters?.length || 0}`;
  }

  function flushUiStructure() {
    if (!uiStructureDirty) {
      return;
    }
    const assetsKey = currentAssetsKey();
    const revision = Number(getMhrSnapshot(mhrSnapshot)?.revision || 0);
    renderScalePanel();
    renderBlendPanel();
    renderExpressionPanel();
    renderFixedPanel();
    renderPosePanel();
    lastRenderedAssetsKey = assetsKey;
    lastRenderedRevision = revision;
    uiStructureDirty = false;
    controlsDirty = false;
  }

  function flushControlValues() {
    if (!controlsDirty) {
      return;
    }
    syncPanelValues('scale', getScaleParameters());
    syncPanelValues('blend', getBlendParameters());
    syncPanelValues('expression', getExpressionParameters());
    syncPanelValues('fixed', getFixedSlotParameters());
    syncPanelValues('pose', getPoseParameters());
    lastRenderedRevision = Number(getMhrSnapshot(mhrSnapshot)?.revision || 0);
    controlsDirty = false;
  }

  function flushScene() {
    if (!sceneDirty) {
      return;
    }
    updateScene();
    lastRenderedEvaluationSeq = Number(getMhrSnapshot(mhrSnapshot)?.evaluation?.seq || 0);
    sceneDirty = false;
  }

  ensurePerfHud();

  const handles = [
    host.ui.sections.register({
      panel: 'left',
      sectionId: 'plugin:mhr-control',
      title: 'Control',
      defaultOpen: true,
      render(body) {
        const actionRows = createControlRow();
        body.append(
          actionRows,
          createLodControlRow(),
          createPrimaryVisibilityControls(),
          createFreeBlendWarningRow(),
          createFamilyRandomControls([
            { key: 'scale', label: 'Free scale', testId: 'mhr-free-scale' },
            { key: 'blend', label: 'Free blend', testId: 'mhr-free-blend' },
            { key: 'expression', label: 'Free expression', testId: 'mhr-free-expression' },
            { key: 'pose', label: 'Free pose', testId: 'mhr-free-pose' },
            { key: 'fixed', label: 'Free locked', testId: 'mhr-free-fixed' },
          ]),
        );
      },
    }),
    host.ui.sections.register({
      panel: 'left',
      sectionId: 'plugin:mhr-scale',
      title: getSectionTitle('Scale', 'skeletalProportion'),
      defaultOpen: true,
      render(body) {
        const resetRow = createSectionResetRow('scale', 'Reset', getScaleParameters);
        const root = document.createElement('div');
        root.className = 'mhr-panel-stack';
        sectionRoots.scale = root;
        body.append(resetRow, root);
        renderScalePanel();
      },
    }),
    host.ui.sections.register({
      panel: 'left',
      sectionId: 'plugin:mhr-blend',
      title: getSectionTitle('Blend', 'surfaceShape'),
      defaultOpen: true,
      render(body) {
        const resetRow = createSectionResetRow('blend', 'Reset', getBlendParameters);
        const root = document.createElement('div');
        root.className = 'mhr-panel-stack';
        sectionRoots.blend = root;
        body.append(resetRow, root);
        renderBlendPanel();
      },
    }),
    host.ui.sections.register({
      panel: 'left',
      sectionId: 'plugin:mhr-expression',
      title: getSectionTitle('Expression', 'expression'),
      defaultOpen: true,
      render(body) {
        const resetRow = createSectionResetRow('expression', 'Reset', getExpressionParameters);
        const root = document.createElement('div');
        root.className = 'mhr-panel-stack';
        sectionRoots.expression = root;
        body.append(resetRow, root);
        renderExpressionPanel();
      },
    }),
    host.ui.sections.register({
      panel: 'right',
      sectionId: 'plugin:mhr-pose',
      title: getSectionTitle('Pose', 'root / pose'),
      defaultOpen: true,
      render(body) {
        const resetRow = createSectionResetRow('pose', 'Reset', getPoseParameters);
        const root = document.createElement('div');
        root.className = 'mhr-panel-stack';
        sectionRoots.pose = root;
        body.append(resetRow, root);
        renderPosePanel();
      },
    }),
    host.ui.sections.register({
      panel: 'right',
      sectionId: 'plugin:mhr-fixed',
      title: getSectionTitle('Locked Parameters', 'skeletalProportion / pose'),
      defaultOpen: true,
      render(body) {
        const resetRow = createSectionResetRow('fixed', 'Reset', getFixedSlotParameters);
        const root = document.createElement('div');
        root.className = 'mhr-panel-stack';
        sectionRoots.fixed = root;
        body.append(resetRow, root);
        renderFixedPanel();
      },
    }),
  ];

  const clockDisposers = [
    onUiMainTick(() => {
      if (!mhrSnapshot) {
        return;
      }
      flushUiStructure();
      flushControlValues();
      kickInfluencePreviewLoop();
    }),
    onFrame(() => {
      if (!mhrSnapshot) {
        return;
      }
      const nowMs = performance.now();
      recordPerfHudSample(perfHudState.frontSamples, nowMs);
      perfHudState.lastFrontSampleTsMs = nowMs;
      updatePerfHudText(nowMs);
      driveFamilyRandomAnimation();
      flushScene();
    }),
    host.renderer.labelOverlay.register(() => {
      if (!mhrSnapshot) {
        return;
      }
      const assets = getMhrSnapshot(mhrSnapshot)?.assets || null;
      const skeletonStates = getMhrSnapshot(mhrSnapshot)?.evaluation?.skeleton?.states || null;
      if (!skeletonStates || !assets?.parameterMetadata?.jointNames) {
        clearJointLabelsOverlay(host);
        return;
      }
      renderJointLabelsToPlayOverlay(host, sceneState, skeletonStates, assets.parameterMetadata.jointNames);
    }),
  ];
  onMhrSnapshot(mhrSnapshot);
  mhrUnsubscribe = mhrService.subscribe((nextSnapshot) => {
    onMhrSnapshot(nextSnapshot);
  });

  return () => {
    clockDisposers.reverse().forEach((dispose) => dispose?.());
    mhrUnsubscribe();
    globalThis.__MHR_DEBUG_TRACE__ = null;
    perfHudState.root?.remove?.();
    handles.reverse().forEach((handle) => handle?.dispose?.());
    sceneState.meshHandle?.dispose?.();
    sceneState.ghostHandle?.dispose?.();
    sceneState.skeletonHandle?.dispose?.();
    sceneState.skeletonMeshHandle?.dispose?.();
    sceneState.skeletonPointsHandle?.dispose?.();
    for (const handle of Object.values(sceneState.skeletonAxesHandles || {})) {
      handle?.dispose?.();
    }
    sceneState.scope?.dispose?.();
    if (ownsService) {
      mhrService.dispose?.();
      if (host?.extensions?.mhr?.service === mhrService) {
        delete host.extensions.mhr;
      }
    }
  };
}

export default registerPlayPlugin;
