export function disposeMeshObject(mesh) {
  if (!mesh) {
    return;
  }
  if (mesh.parent && typeof mesh.parent.remove === 'function') {
    mesh.parent.remove(mesh);
  }
  if (mesh.geometry && typeof mesh.geometry.dispose === 'function') {
    mesh.geometry.dispose();
  }
  const material = mesh.material;
  if (Array.isArray(material)) {
    for (const entry of material) {
      if (entry && typeof entry.dispose === 'function') {
        entry.dispose();
      }
    }
  } else if (material && typeof material.dispose === 'function') {
    material.dispose();
  }
}

export function disposeObject3DTree(root) {
  if (!root) {
    return;
  }
  if (root.parent && typeof root.parent.remove === 'function') {
    root.parent.remove(root);
  }
  if (typeof root.traverse !== 'function') {
    return;
  }
  root.traverse((node) => {
    if (!node) {
      return;
    }
    if (node.geometry && typeof node.geometry.dispose === 'function') {
      node.geometry.dispose();
    }
    const material = node.material;
    if (Array.isArray(material)) {
      for (const entry of material) {
        if (entry && typeof entry.dispose === 'function') {
          entry.dispose();
        }
      }
      return;
    }
    if (material && typeof material.dispose === 'function') {
      material.dispose();
    }
  });
}

export function computeBoundsFromPositions(positions, stride = 3) {
  if (!(positions instanceof Float32Array) || positions.length < stride) {
    return null;
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let offset = 0; offset < positions.length; offset += stride) {
    const x = positions[offset];
    const y = positions[offset + 1];
    const z = positions[offset + 2];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }

  const center = {
    x: (minX + maxX) * 0.5,
    y: (minY + maxY) * 0.5,
    z: (minZ + maxZ) * 0.5,
  };
  const dx = maxX - minX;
  const dy = maxY - minY;
  const dz = maxZ - minZ;
  return {
    center,
    radius: Math.max(Math.hypot(dx, dy, dz) * 0.5, 0.25),
  };
}
