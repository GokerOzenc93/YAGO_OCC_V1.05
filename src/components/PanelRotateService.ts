import * as THREE from 'three';
import type { Shape } from '../store';

export interface RotateStep {
  id: string;
  pivot: [number, number, number];
  angleDeg: number;
  axis: [number, number, number];
  timestamp: number;
  // The panel's position/rotation immediately before this step was first applied.
  stepBasePosition: [number, number, number];
  stepBaseRotation: [number, number, number];
}

// Apply a single rotation step from a given base position/rotation.
function applySingleStep(
  basePos: [number, number, number],
  baseRot: [number, number, number],
  step: RotateStep
): { position: [number, number, number]; rotation: [number, number, number] } {
  const pos = new THREE.Vector3(...basePos);
  const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(...baseRot, 'XYZ'));

  const pivot = new THREE.Vector3(...step.pivot);
  const rotAxis = new THREE.Vector3(...step.axis).normalize();
  const angle = THREE.MathUtils.degToRad(step.angleDeg);
  const stepQuat = new THREE.Quaternion().setFromAxisAngle(rotAxis, angle);

  const offset = pos.clone().sub(pivot);
  offset.applyQuaternion(stepQuat);
  const newPos = pivot.clone().add(offset);

  const newRot = stepQuat.clone().multiply(rot);
  const euler = new THREE.Euler().setFromQuaternion(newRot, 'XYZ');

  return {
    position: [newPos.x, newPos.y, newPos.z],
    rotation: [euler.x, euler.y, euler.z],
  };
}

// --- OBB helpers ---

interface OBBPlane {
  normal: THREE.Vector3;
  d: number;
}

function getShapeOBBPlanes(shape: Shape): OBBPlane[] | null {
  if (!shape.geometry) return null;
  const pos = shape.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return null;
  const bbox = new THREE.Box3().setFromBufferAttribute(pos);

  const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...shape.rotation, 'XYZ'));
  const shapePos = new THREE.Vector3(...shape.position);
  const shapeScale = new THREE.Vector3(...shape.scale);

  const center = new THREE.Vector3();
  bbox.getCenter(center);
  center.multiply(shapeScale).applyQuaternion(quat).add(shapePos);

  const halfSize = new THREE.Vector3();
  bbox.getSize(halfSize).multiply(shapeScale).multiplyScalar(0.5);

  const axisX = new THREE.Vector3(1, 0, 0).applyQuaternion(quat).normalize();
  const axisY = new THREE.Vector3(0, 1, 0).applyQuaternion(quat).normalize();
  const axisZ = new THREE.Vector3(0, 0, 1).applyQuaternion(quat).normalize();

  const planes: OBBPlane[] = [];
  const axesAndHalves: [THREE.Vector3, number][] = [
    [axisX, halfSize.x],
    [axisY, halfSize.y],
    [axisZ, halfSize.z],
  ];

  for (const [axis, half] of axesAndHalves) {
    const p1 = center.clone().add(axis.clone().multiplyScalar(half));
    planes.push({ normal: axis.clone(), d: axis.dot(p1) });
    const p2 = center.clone().sub(axis.clone().multiplyScalar(half));
    planes.push({ normal: axis.clone().negate(), d: axis.clone().negate().dot(p2) });
  }

  return planes;
}

function getParentOBBPlanes(panelShape: Shape, shapes: Shape[]): OBBPlane[] | null {
  const parentId = panelShape.parameters?.parentShapeId;
  if (!parentId) return null;
  const parent = shapes.find(s => s.id === parentId);
  if (!parent) return null;
  return getShapeOBBPlanes(parent);
}

function rayIntersectOBBPlanes(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  planes: OBBPlane[]
): number | null {
  let tMin = -Infinity;
  let tMax = Infinity;

  for (const plane of planes) {
    const denom = plane.normal.dot(dir);
    const dist = plane.d - plane.normal.dot(origin);

    if (Math.abs(denom) < 1e-9) {
      if (dist < 0) return null;
      continue;
    }

    const t = dist / denom;
    if (denom < 0) {
      tMin = Math.max(tMin, t);
    } else {
      tMax = Math.min(tMax, t);
    }
  }

  if (tMin > tMax) return null;
  if (tMax < 0) return null;
  return tMax > 0.01 ? tMax : null;
}

// Ray-OBB intersection returning entry distance (tMin) for sibling collision.
function rayIntersectOBBEntry(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  planes: OBBPlane[]
): number | null {
  let tMin = -Infinity;
  let tMax = Infinity;

  for (const plane of planes) {
    const denom = plane.normal.dot(dir);
    const dist = plane.d - plane.normal.dot(origin);

    if (Math.abs(denom) < 1e-9) {
      if (dist < 0) return null;
      continue;
    }

    const t = dist / denom;
    if (denom < 0) {
      tMin = Math.max(tMin, t);
    } else {
      tMax = Math.min(tMax, t);
    }
  }

  if (tMin > tMax) return null;
  if (tMin < 0 && tMax < 0) return null;
  // Return the ENTRY point (tMin) if positive; if ray starts inside (tMin<0), return 0.
  return tMin > 0.5 ? tMin : null;
}

// --- Auto-extension ---

interface AutoExtendResult {
  length: number;
  directionSign: number;
  longestAxisIdx: number;
}

function computeAutoExtendLength(
  panelShape: Shape,
  newPosition: [number, number, number],
  newRotation: [number, number, number],
  pivot: [number, number, number],
  shapes: Shape[]
): AutoExtendResult | null {
  if (!panelShape.geometry) return null;

  const obbPlanes = getParentOBBPlanes(panelShape, shapes);
  if (!obbPlanes) return null;

  const panelAttr = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!panelAttr) return null;
  const panelLocalBbox = new THREE.Box3().setFromBufferAttribute(panelAttr);
  const panelSize = new THREE.Vector3();
  panelLocalBbox.getSize(panelSize);

  const sorted = [
    { i: 0, v: panelSize.x },
    { i: 1, v: panelSize.y },
    { i: 2, v: panelSize.z },
  ].sort((a, b) => a.v - b.v);

  const candidateLongAxes = sorted.slice(1);

  const panelQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...newRotation, 'XYZ'));
  const pivotVec = new THREE.Vector3(...pivot);

  const bboxCenter = new THREE.Vector3();
  panelLocalBbox.getCenter(bboxCenter);
  const actualWorldCenter = bboxCenter.clone().applyQuaternion(panelQuat)
    .add(new THREE.Vector3(...newPosition));

  let bestDist = -1;
  let bestDirSign = 1;
  let bestAxisIdx = candidateLongAxes[1].i;

  for (const candidate of candidateLongAxes) {
    const localDir = new THREE.Vector3(
      candidate.i === 0 ? 1 : 0,
      candidate.i === 1 ? 1 : 0,
      candidate.i === 2 ? 1 : 0
    );
    const worldDir = localDir.clone().applyQuaternion(panelQuat).normalize();

    const d1 = rayIntersectOBBPlanes(pivotVec, worldDir.clone(), obbPlanes);
    const d2 = rayIntersectOBBPlanes(pivotVec, worldDir.clone().negate(), obbPlanes);

    const v1 = d1 !== null && d1 > 1;
    const v2 = d2 !== null && d2 > 1;

    let chosenDist = -1;
    let chosenSign = 1;
    if (v1 && v2) {
      const dot = actualWorldCenter.clone().sub(pivotVec).dot(worldDir);
      chosenSign = dot >= 0 ? 1 : -1;
      chosenDist = chosenSign === 1 ? d1! : d2!;
    } else if (v1) {
      chosenSign = 1;
      chosenDist = d1!;
    } else if (v2) {
      chosenSign = -1;
      chosenDist = d2!;
    }

    if (chosenDist > bestDist) {
      bestDist = chosenDist;
      bestDirSign = chosenSign;
      bestAxisIdx = candidate.i;
    }
  }

  if (bestDist < 1) return null;

  const bestLocalDir = new THREE.Vector3(
    bestAxisIdx === 0 ? 1 : 0,
    bestAxisIdx === 1 ? 1 : 0,
    bestAxisIdx === 2 ? 1 : 0
  );
  const bestWorldDir = bestLocalDir.clone().applyQuaternion(panelQuat).normalize()
    .multiplyScalar(bestDirSign);

  // Use OBB-based sibling collision (not world-AABB) for accurate interaction with rotated panels.
  const parentId = panelShape.parameters?.parentShapeId;
  const siblings = shapes.filter(
    s => s.type === 'panel' &&
      s.parameters?.parentShapeId === parentId &&
      s.id !== panelShape.id &&
      s.geometry
  );

  let closestCollision = bestDist;

  for (const sib of siblings) {
    const sibOBB = getShapeOBBPlanes(sib);
    if (!sibOBB) continue;

    // Check if pivot is inside sibling OBB — skip if so.
    const pivotInsideSib = rayIntersectOBBEntry(pivotVec, bestWorldDir.clone(), sibOBB);
    // Also test with negated direction to confirm we're not inside.
    const pivotInsideNeg = rayIntersectOBBEntry(pivotVec, bestWorldDir.clone().negate(), sibOBB);
    if (pivotInsideSib === null && pivotInsideNeg === null) {
      // Ray misses sibling in both directions — no collision.
      continue;
    }
    // If entry is null (meaning origin is inside or ray misses), skip this sibling.
    if (pivotInsideSib === null) continue;

    if (pivotInsideSib < closestCollision) {
      closestCollision = pivotInsideSib;
    }
  }

  return { length: closestCollision, directionSign: bestDirSign, longestAxisIdx: bestAxisIdx };
}

// --- Geometry rebuild ---

async function rebuildPanelGeometry(
  panelShape: Shape,
  newLength: number,
  pivot: [number, number, number],
  directionSign: number,
  longestAxisIdx: number,
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<void> {
  if (!panelShape.geometry) return;

  const panelAttr = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!panelAttr) return;
  const panelLocalBbox = new THREE.Box3().setFromBufferAttribute(panelAttr);
  const panelSize = new THREE.Vector3();
  panelLocalBbox.getSize(panelSize);

  const axes = [
    { i: 0, v: panelSize.x },
    { i: 1, v: panelSize.y },
    { i: 2, v: panelSize.z },
  ].sort((a, b) => a.v - b.v);

  const thickness = axes[0].v;
  const thinAxisIdx = axes[0].i;
  const secondAxisIdx = axes.find(a => a.i !== longestAxisIdx && a.i !== thinAxisIdx)!.i;
  const secondLen = panelSize.getComponent(secondAxisIdx);

  const dims: [number, number, number] = [0, 0, 0];
  dims[thinAxisIdx] = thickness;
  dims[longestAxisIdx] = newLength;
  dims[secondAxisIdx] = secondLen;

  try {
    const { createReplicadBox, convertReplicadToThreeGeometry } = await import('./ReplicadService');
    const rp = await createReplicadBox({ width: dims[0], height: dims[1], depth: dims[2] });
    const geometry = convertReplicadToThreeGeometry(rp);

    const panelQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(...panelShape.rotation, 'XYZ')
    );
    const pivotVec = new THREE.Vector3(...pivot);

    // Position the new geometry so that the pivot end stays at the world pivot.
    // The pivot is at local [0 or newLength] on the longestAxis, and centered on others.
    const newBboxAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
    const newBbox = new THREE.Box3().setFromBufferAttribute(newBboxAttr);
    const newSize = new THREE.Vector3();
    newBbox.getSize(newSize);

    const newLocalPivot = new THREE.Vector3();
    newLocalPivot.setComponent(longestAxisIdx, directionSign === 1 ? 0 : newLength);
    newLocalPivot.setComponent(secondAxisIdx, newSize.getComponent(secondAxisIdx) * 0.5);
    newLocalPivot.setComponent(thinAxisIdx, newSize.getComponent(thinAxisIdx) * 0.5);

    // Adjust for any off-center offset of the pivot on secondary/thin axes.
    // Use old geometry + position to determine the actual local pivot offset.
    const panelWorldMatrix = new THREE.Matrix4().compose(
      new THREE.Vector3(...panelShape.position),
      panelQuat,
      new THREE.Vector3(1, 1, 1)
    );
    const invMatrix = panelWorldMatrix.clone().invert();
    const localPivot = pivotVec.clone().applyMatrix4(invMatrix);
    const origCenter = new THREE.Vector3();
    panelLocalBbox.getCenter(origCenter);
    const relPivot = localPivot.clone().sub(origCenter);

    // Apply secondary/thin offsets from original pivot relationship.
    newLocalPivot.setComponent(secondAxisIdx, newSize.getComponent(secondAxisIdx) * 0.5 + relPivot.getComponent(secondAxisIdx));
    newLocalPivot.setComponent(thinAxisIdx, newSize.getComponent(thinAxisIdx) * 0.5 + relPivot.getComponent(thinAxisIdx));

    const rotatedLocalPivot = newLocalPivot.clone().applyQuaternion(panelQuat);
    const newPos: [number, number, number] = [
      pivotVec.x - rotatedLocalPivot.x,
      pivotVec.y - rotatedLocalPivot.y,
      pivotVec.z - rotatedLocalPivot.z,
    ];

    updateShape(panelShape.id, {
      geometry,
      replicadShape: rp,
      position: newPos,
      parameters: {
        ...panelShape.parameters,
        width: secondLen,
        height: newLength,
        autoExtendedLength: newLength,
        baseReplicadShape: rp,
      },
    });
  } catch (err) {
    console.error('[PanelRotateService] Failed to rebuild panel geometry:', err);
  }
}

// --- Sibling rebuild ---

async function rebuildSiblingsAfterRotate(rotatedPanel: Shape, shapes: Shape[]): Promise<void> {
  const parentId = rotatedPanel.parameters?.parentShapeId;
  if (!parentId) return;

  const parentShape = shapes.find(s => s.id === parentId);
  if (!parentShape) return;

  try {
    const { useAppStore } = await import('../store');
    const store = useAppStore.getState();
    store.recalculateVirtualFacesForShape(parentId);

    const { rebuildPanelsForParent } = await import('./PanelRebuildService');
    await rebuildPanelsForParent(parentId);
  } catch (err) {
    console.error('[PanelRotateService] Failed to rebuild siblings:', err);
  }
}

// --- Public API ---

export async function executePanelRotate(
  panelShape: Shape,
  pivot: [number, number, number],
  angleDeg: number,
  axis: [number, number, number],
  shapes: Shape[],
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  if (Math.abs(angleDeg) < 0.001) return false;

  const currentPosition = [...panelShape.position] as [number, number, number];
  const currentRotation = [...panelShape.rotation] as [number, number, number];
  const existingSteps: RotateStep[] = panelShape.parameters?.rotateSteps || [];

  const newStep: RotateStep = {
    id: `rot-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
    pivot,
    angleDeg,
    axis,
    timestamp: Date.now(),
    stepBasePosition: currentPosition,
    stepBaseRotation: currentRotation,
  };

  const newSteps = [...existingSteps, newStep];
  const result = applySingleStep(currentPosition, currentRotation, newStep);

  // First update position/rotation so the panel is at post-rotation state.
  updateShape(panelShape.id, {
    position: result.position,
    rotation: result.rotation,
    parameters: {
      ...panelShape.parameters,
      rotateSteps: newSteps,
    },
  });

  // Compute auto-extension using the post-rotation state.
  // Use the CURRENT geometry for axis detection (it correctly identifies thin vs long axes).
  const extendResult = computeAutoExtendLength(panelShape, result.position, result.rotation, pivot, shapes);
  if (extendResult !== null && extendResult.length > 1) {
    const updatedPanel: Shape = {
      ...panelShape,
      position: result.position,
      rotation: result.rotation,
      parameters: { ...panelShape.parameters, rotateSteps: newSteps },
    };
    await rebuildPanelGeometry(updatedPanel, extendResult.length, pivot, extendResult.directionSign, extendResult.longestAxisIdx, updateShape);
  }

  await rebuildSiblingsAfterRotate(panelShape, shapes);
  return true;
}

export async function updateRotateStep(
  panelShape: Shape,
  stepId: string,
  newAngleDeg: number,
  shapes: Shape[],
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  const steps: RotateStep[] = panelShape.parameters?.rotateSteps || [];
  const stepIdx = steps.findIndex(s => s.id === stepId);
  if (stepIdx < 0) return false;

  const updatedSteps = steps.map(s => s.id === stepId ? { ...s, angleDeg: newAngleDeg } : s);
  const step = updatedSteps[stepIdx];

  // Replay from the step's own stored base.
  const result = applySingleStep(step.stepBasePosition, step.stepBaseRotation, step);
  const pivot = step.pivot;

  // Use step's base state as reference for geometry — this is the panel's state BEFORE
  // this step was applied, consistent with the original geometry dimensions.
  const refPanel: Shape = {
    ...panelShape,
    position: step.stepBasePosition,
    rotation: step.stepBaseRotation,
  };

  const extendResult = computeAutoExtendLength(refPanel, result.position, result.rotation, pivot, shapes);
  if (extendResult !== null && extendResult.length > 1) {
    const updatedPanel: Shape = {
      ...panelShape,
      position: step.stepBasePosition,
      rotation: result.rotation,
      parameters: { ...panelShape.parameters, rotateSteps: updatedSteps },
    };
    await rebuildPanelGeometry(updatedPanel, extendResult.length, pivot, extendResult.directionSign, extendResult.longestAxisIdx, updateShape);
  } else {
    updateShape(panelShape.id, {
      position: result.position,
      rotation: result.rotation,
      parameters: { ...panelShape.parameters, rotateSteps: updatedSteps, autoExtendedLength: undefined },
    });
  }

  await rebuildSiblingsAfterRotate(panelShape, shapes);
  return true;
}

export async function deleteRotateStep(
  panelShape: Shape,
  stepId: string,
  shapes: Shape[],
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  const steps: RotateStep[] = panelShape.parameters?.rotateSteps || [];
  const deletedIdx = steps.findIndex(s => s.id === stepId);
  if (deletedIdx < 0) return false;

  const deletedStep = steps[deletedIdx];
  // Remove deleted step and all subsequent steps.
  const newSteps = steps.slice(0, deletedIdx);

  if (newSteps.length > 0) {
    const lastStep = newSteps[newSteps.length - 1];

    // Replay the last remaining step to get its post-rotation state.
    const lastResult = applySingleStep(lastStep.stepBasePosition, lastStep.stepBaseRotation, lastStep);

    // Use lastStep's base state as reference for geometry (same logic as updateRotateStep).
    const refPanel: Shape = {
      ...panelShape,
      position: lastStep.stepBasePosition,
      rotation: lastStep.stepBaseRotation,
      parameters: { ...panelShape.parameters, rotateSteps: newSteps, autoExtendedLength: undefined },
    };

    const extendResult = computeAutoExtendLength(refPanel, lastResult.position, lastResult.rotation, lastStep.pivot, shapes);

    if (extendResult !== null && extendResult.length > 1) {
      const geoRefPanel: Shape = {
        ...panelShape,
        position: lastStep.stepBasePosition,
        rotation: lastResult.rotation,
        parameters: { ...panelShape.parameters, rotateSteps: newSteps, autoExtendedLength: undefined },
      };
      await rebuildPanelGeometry(geoRefPanel, extendResult.length, lastStep.pivot, extendResult.directionSign, extendResult.longestAxisIdx, updateShape);
    } else {
      // No extension needed — place at post-rotation of last step.
      updateShape(panelShape.id, {
        position: lastResult.position,
        rotation: lastResult.rotation,
        parameters: { ...panelShape.parameters, rotateSteps: newSteps, autoExtendedLength: undefined },
      });
    }
  } else {
    // No remaining steps — restore to position before the deleted step was applied.
    updateShape(panelShape.id, {
      position: deletedStep.stepBasePosition,
      rotation: deletedStep.stepBaseRotation,
      parameters: { ...panelShape.parameters, rotateSteps: [], autoExtendedLength: undefined },
    });
  }

  await rebuildSiblingsAfterRotate(panelShape, shapes);
  return true;
}

export function getPanelNormalAxis(panelShape: Shape): [number, number, number] {
  if (!panelShape.geometry) return [0, 0, 1];
  const pos = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return [0, 0, 1];

  const bbox = new THREE.Box3().setFromBufferAttribute(pos);
  const size = new THREE.Vector3();
  bbox.getSize(size);

  const axes = [
    { i: 0, v: size.x },
    { i: 1, v: size.y },
    { i: 2, v: size.z },
  ].sort((a, b) => a.v - b.v);

  const thinAxis = axes[0].i;
  const localNormal = new THREE.Vector3(
    thinAxis === 0 ? 1 : 0,
    thinAxis === 1 ? 1 : 0,
    thinAxis === 2 ? 1 : 0
  );

  const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...panelShape.rotation, 'XYZ'));
  localNormal.applyQuaternion(quat).normalize();

  return [localNormal.x, localNormal.y, localNormal.z];
}
