import {
  computeBoundsFromPositions,
  disposeMeshObject,
  disposeObject3DTree,
} from './three_helpers.mjs';

let threeRuntimePromise = null;

async function loadThreeRuntime() {
  if (!threeRuntimePromise) {
    threeRuntimePromise = Promise.all([
      import('three'),
      import('three/addons/controls/OrbitControls.js'),
    ]).then(([THREE, controlsModule]) => ({
      THREE,
      OrbitControls: controlsModule.OrbitControls,
    }));
  }
  return threeRuntimePromise;
}

function normalizeCompareMode(compareMode) {
  if (compareMode === 'skin' || compareMode === 'skeleton' || compareMode === 'both') {
    return compareMode;
  }
  return 'both';
}

function formatOverlay(snapshot, uiState) {
  const evaluation = snapshot?.evaluation || null;
  return [
    'MHR Play Viewer',
    `status: ${snapshot?.status || 'unknown'}`,
    `compareMode: ${normalizeCompareMode(uiState?.view?.compareMode || 'both')}`,
    `revision: ${snapshot?.revision || 0}`,
    `bundle: ${snapshot?.assets?.bundleId || 'not loaded'}`,
    `vertices: ${evaluation?.mesh?.vertexCount || 0}`,
    `joints: ${evaluation?.skeleton?.jointCount || 0}`,
    `extentY: ${evaluation?.derived?.skeletonExtentY?.toFixed?.(2) || 'n/a'}`,
  ].join('\n');
}

function makeSkinMesh(snapshot, THREE) {
  const vertices = snapshot?.evaluation?.mesh?.vertices;
  const topology = snapshot?.assets?.topology;
  if (!(vertices instanceof Float32Array) || !(topology instanceof Uint32Array) || topology.length < 3) {
    return null;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices.slice(), 3));
  geometry.setIndex(new THREE.BufferAttribute(topology.slice(), 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({
    color: 0xc95e1d,
    roughness: 0.62,
    metalness: 0.06,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

function makeSkeletonRoot(snapshot, THREE) {
  const states = snapshot?.evaluation?.skeleton?.states;
  const parents = snapshot?.assets?.jointParents;
  if (!(states instanceof Float32Array) || !(parents instanceof Int32Array) || parents.length < 1) {
    return null;
  }

  const root = new THREE.Group();
  const jointPositions = new Float32Array(parents.length * 3);
  for (let jointIndex = 0; jointIndex < parents.length; jointIndex += 1) {
    const sourceOffset = jointIndex * 8;
    const targetOffset = jointIndex * 3;
    jointPositions[targetOffset] = states[sourceOffset];
    jointPositions[targetOffset + 1] = states[sourceOffset + 1];
    jointPositions[targetOffset + 2] = states[sourceOffset + 2];
  }

  const jointGeometry = new THREE.BufferGeometry();
  jointGeometry.setAttribute('position', new THREE.BufferAttribute(jointPositions, 3));
  const jointMaterial = new THREE.PointsMaterial({
    color: 0x274e73,
    size: 0.085,
    sizeAttenuation: true,
  });
  root.add(new THREE.Points(jointGeometry, jointMaterial));

  const linePositions = [];
  for (let jointIndex = 0; jointIndex < parents.length; jointIndex += 1) {
    const parentIndex = parents[jointIndex];
    if (parentIndex < 0) {
      continue;
    }
    const childOffset = jointIndex * 3;
    const parentOffset = parentIndex * 3;
    linePositions.push(
      jointPositions[parentOffset],
      jointPositions[parentOffset + 1],
      jointPositions[parentOffset + 2],
      jointPositions[childOffset],
      jointPositions[childOffset + 1],
      jointPositions[childOffset + 2],
    );
  }
  if (linePositions.length) {
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(linePositions, 3),
    );
    const lineMaterial = new THREE.LineBasicMaterial({
      color: 0x274e73,
      linewidth: 2,
    });
    root.add(new THREE.LineSegments(lineGeometry, lineMaterial));
  }

  return root;
}

function makePlaceholderCard(canvas, overlay, renderer, scene, camera) {
  const width = canvas.width || 1;
  const height = canvas.height || 1;
  renderer.setViewport(0, 0, width, height);
  renderer.setScissorTest(false);
  renderer.setClearColor(0xf4ebda, 1);
  renderer.render(scene, camera);
  if (overlay) {
    overlay.textContent = 'MHR Play Viewer\nstatus: booting\nbundle: not loaded\nvertices: 0\njoints: 0';
  }
}

export function createRendererManager({ canvas, overlay }) {
  if (!canvas) {
    throw new Error('createRendererManager requires a canvas.');
  }
  let runtime = null;

  let skinMesh = null;
  let skeletonRoot = null;
  let lastSignature = '';

  async function ensureRuntime() {
    if (runtime) {
      return runtime;
    }
    const { THREE, OrbitControls } = await loadThreeRuntime();
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf4ebda);

    const camera = new THREE.PerspectiveCamera(36, 1, 0.01, 100);
    camera.position.set(1.8, 1.3, 3.2);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 1.0, 0);

    const hemiLight = new THREE.HemisphereLight(0xfff7ec, 0x8a7351, 1.35);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
    keyLight.position.set(2.5, 4.0, 3.5);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xf2c99d, 0.7);
    fillLight.position.set(-2.0, 1.4, 2.0);
    scene.add(fillLight);

    const grid = new THREE.GridHelper(6, 12, 0xd0c1aa, 0xe3d7c5);
    grid.position.y = -0.02;
    scene.add(grid);

    const axes = new THREE.AxesHelper(0.5);
    axes.position.set(0, 0.02, 0);
    scene.add(axes);

    const runtimeGroup = new THREE.Group();
    scene.add(runtimeGroup);
    runtime = {
      THREE,
      renderer,
      scene,
      camera,
      controls,
      runtimeGroup,
    };
    return runtime;
  }

  function resize() {
    if (!runtime) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    if (canvas.width === width && canvas.height === height) {
      return;
    }
    runtime.renderer.setSize(width, height, false);
    runtime.camera.aspect = width / height;
    runtime.camera.updateProjectionMatrix();
  }

  function clearRuntimeObjects() {
    if (skinMesh) {
      disposeMeshObject(skinMesh);
      skinMesh = null;
    }
    if (skeletonRoot) {
      disposeObject3DTree(skeletonRoot);
      skeletonRoot = null;
    }
  }

  function fitCamera(snapshot) {
    if (!runtime) {
      return;
    }
    const vertices = snapshot?.evaluation?.mesh?.vertices;
    const skeleton = snapshot?.evaluation?.skeleton?.states;
    const meshBounds = computeBoundsFromPositions(vertices, 3);
    const skeletonBounds = computeBoundsFromPositions(skeleton, 8);
    const chosen = meshBounds || skeletonBounds;
    if (!chosen) {
      runtime.controls.target.set(0, 1.0, 0);
      runtime.camera.position.set(1.8, 1.3, 3.2);
      runtime.controls.update();
      return;
    }
    const radius = Math.max(chosen.radius, 0.4);
    runtime.controls.target.set(chosen.center.x, chosen.center.y, chosen.center.z);
    runtime.camera.position.set(
      chosen.center.x + radius * 1.5,
      chosen.center.y + radius * 0.9,
      chosen.center.z + radius * 2.4,
    );
    runtime.camera.near = Math.max(radius * 0.02, 0.01);
    runtime.camera.far = Math.max(radius * 20, 20);
    runtime.camera.updateProjectionMatrix();
    runtime.controls.update();
  }

  function buildSignature(snapshot, uiState) {
    const compareMode = normalizeCompareMode(uiState?.view?.compareMode || 'both');
    const vertexCount = snapshot?.evaluation?.mesh?.vertexCount || 0;
    const jointCount = snapshot?.evaluation?.skeleton?.jointCount || 0;
    const revision = snapshot?.revision || 0;
    return `${revision}:${compareMode}:${vertexCount}:${jointCount}:${snapshot?.status || 'unknown'}`;
  }

  async function render(snapshot, uiState) {
    await ensureRuntime();
    resize();
    const signature = buildSignature(snapshot, uiState);
    const compareMode = normalizeCompareMode(uiState?.view?.compareMode || 'both');

    if (!snapshot?.evaluation?.mesh?.vertices && !snapshot?.evaluation?.skeleton?.states) {
      makePlaceholderCard(canvas, overlay, runtime.renderer, runtime.scene, runtime.camera);
      lastSignature = signature;
      return;
    }

    if (signature !== lastSignature) {
      clearRuntimeObjects();
      skinMesh = makeSkinMesh(snapshot, runtime.THREE);
      skeletonRoot = makeSkeletonRoot(snapshot, runtime.THREE);
      if (skinMesh) {
        runtime.runtimeGroup.add(skinMesh);
      }
      if (skeletonRoot) {
        runtime.runtimeGroup.add(skeletonRoot);
      }
      fitCamera(snapshot);
      lastSignature = signature;
    }

    if (skinMesh) {
      skinMesh.visible = compareMode !== 'skeleton';
    }
    if (skeletonRoot) {
      skeletonRoot.visible = compareMode !== 'skin';
    }

    runtime.controls.update();
    runtime.renderer.render(runtime.scene, runtime.camera);
    if (overlay) {
      overlay.textContent = formatOverlay(snapshot, uiState);
    }
  }

  function dispose() {
    clearRuntimeObjects();
    if (runtime) {
      runtime.controls.dispose();
      runtime.renderer.dispose();
      runtime = null;
    }
    if (overlay) {
      overlay.textContent = 'Renderer disposed.';
    }
  }

  return {
    render,
    resize,
    dispose,
  };
}
