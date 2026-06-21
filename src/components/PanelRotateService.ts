import * as THREE from 'three';
import type { Shape } from '../store';

export interface RotateStep {
  id: string;
  pivot: [number, number, number];
  angleDeg: number;
  axis: [number, number, number];
  timestamp: number;
}

export interface PanelRotateParams {
  panelShape: Shape;
  pivot: [number, number, number];
  angleDeg: number;
  axis: [number, number, number];
  shapes: Shape[];
  updateShape: (id: string, updates: Partial<Shape>) => void;
}

function computeBaseRotation(panelShape: Shape): [number, number, number] {
  return panelShape.parameters?.baseRotateRotation ?? [...panelShape.rotation] as [number, number, number];
}

function computeBasePosition(panelShape: Shape): [number, number, number] {
  return panelShape.parameters?.baseRotatePosition ?? panelShape.parameters?.baseMovePosition ?? [...panelShape.position] as [number, number, number];
}

export function applyRotateSteps(
  basePosition: [number, number, number],
  baseRotation: [number, number, number],
  steps: RotateStep[]
): { position: [number, number, number]; rotation: [number, number, number] } {
  let pos = new THREE.Vector3(...basePosition);
  let rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(...baseRotation, 'XYZ'));

  for (const step of steps) {
    const pivot = new THREE.Vector3(...step.pivot);
    const rotAxis = new THREE.Vector3(...step.axis).normalize();
    const angle = THREE.MathUtils.degToRad(step.angleDeg);
    const stepQuat = new THREE.Quaternion().setFromAxisAngle(rotAxis, angle);

    const offset = pos.clone().sub(pivot);
    offset.applyQuaternion(stepQuat);
    pos = pivot.clone().add(offset);

    rot = stepQuat.clone().multiply(rot);
  }

  const euler = new THREE.Euler().setFromQuaternion(rot, 'XYZ');
  return {
    position: [pos.x, pos.y, pos.z],
    rotation: [euler.x, euler.y, euler.z],
  };
}

function getParentCenter(panelShape: Shape, shapes: Shape[]): THREE.Vector3 | null {
  const parentId = panelShape.parameters?.parentShapeId;
  if (!parentId) return null;
  const parent = shapes.find(s => s.id === parentId);
  if (!parent || !parent.geometry) return null;

  const pos = parent.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return null;
  const bbox = new THREE.Box3().setFromBufferAttribute(pos);
  const center = new THREE.Vector3();
  bbox.getCenter(center);

  const mat = new THREE.Matrix4().compose(
    new THREE.Vector3(...parent.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...parent.rotation, 'XYZ')),
    new THREE.Vector3(...parent.scale)
  );
  center.applyMatrix4(mat);
  return center;
}

function computeInwardSign(
  panelShape: Shape,
  pivot: [number, number, number],
  axis: [number, number, number],
  shapes: Shape[]
): number {
  const parentCenter = getParentCenter(panelShape, shapes);
  if (!parentCenter) return 1;

  const panelCenter = new THREE.Vector3(...panelShape.position);
  const pivotVec = new THREE.Vector3(...pivot);

  const toPanel = panelCenter.clone().sub(pivotVec);
  if (toPanel.length() < 0.01) return 1;
  toPanel.normalize();

  const toParent = parentCenter.clone().sub(pivotVec);
  if (toParent.length() < 0.01) return 1;
  toParent.normalize();

  const rotAxis = new THREE.Vector3(...axis).normalize();
  const testAngle = THREE.MathUtils.degToRad(5);

  const testQuat = new THREE.Quaternion().setFromAxisAngle(rotAxis, testAngle);
  const rotatedPos = toPanel.clone().applyQuaternion(testQuat);
  const dotPositive = rotatedPos.dot(toParent);

  const testQuatNeg = new THREE.Quaternion().setFromAxisAngle(rotAxis, -testAngle);
  const rotatedNeg = toPanel.clone().applyQuaternion(testQuatNeg);
  const dotNegative = rotatedNeg.dot(toParent);

  return dotPositive >= dotNegative ? 1 : -1;
}


function getParentOBBPlanes(panelShape: Shape, shapes: Shape[]): { normal: THREE.Vector3; d: number }[] | null {
  const parentId = panelShape.parameters?.parentShapeId;
  if (!parentId) return null;
  const parent = shapes.find(s => s.id === parentId);
  if (!parent || !parent.geometry) return null;

  const pos = parent.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return null;
  const bbox = new THREE.Box3().setFromBufferAttribute(pos);

  const parentQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...parent.rotation, 'XYZ'));
  const parentPos = new THREE.Vector3(...parent.position);
  const parentScale = new THREE.Vector3(...parent.scale);

  const center = new THREE.Vector3();
  bbox.getCenter(center);
  center.multiply(parentScale).applyQuaternion(parentQuat).add(parentPos);

  const halfSize = new THREE.Vector3();
  bbox.getSize(halfSize).multiply(parentScale).multiplyScalar(0.5);

  const axisX = new THREE.Vector3(1, 0, 0).applyQuaternion(parentQuat).normalize();
  const axisY = new THREE.Vector3(0, 1, 0).applyQuaternion(parentQuat).normalize();
  const axisZ = new THREE.Vector3(0, 0, 1).applyQuaternion(parentQuat).normalize();

  const planes: { normal: THREE.Vector3; d: number }[] = [];
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

function rayIntersectOBBPlanes(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  planes: { normal: THREE.Vector3; d: number }[]
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

interface AutoExtendResult {
  length: number;
  directionSign: number; // +1 = extends in +localLongDir, -1 = extends in -localLongDir
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

  const axes = [
    { i: 0, v: panelSize.x },
    { i: 1, v: panelSize.y },
    { i: 2, v: panelSize.z },
  ].sort((a, b) => a.v - b.v);
  const longAxes = axes.slice(1).sort((a, b) => b.v - a.v);
  const longestLocalAxis = longAxes[0].i;

  const panelQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...newRotation, 'XYZ'));
  const localDir = new THREE.Vector3(
    longestLocalAxis === 0 ? 1 : 0,
    longestLocalAxis === 1 ? 1 : 0,
    longestLocalAxis === 2 ? 1 : 0
  );
  const worldDir = localDir.clone().applyQuaternion(panelQuat).normalize();

  const pivotVec = new THREE.Vector3(...pivot);

  // Compute ACTUAL world centroid (not geometry origin) to determine direction
  const bboxCenter = new THREE.Vector3();
  panelLocalBbox.getCenter(bboxCenter);
  const actualWorldCenter = bboxCenter.clone().applyQuaternion(panelQuat)
    .add(new THREE.Vector3(...newPosition));

  const centerDirFromPivot = actualWorldCenter.clone().sub(pivotVec);
  const dotWithDir = centerDirFromPivot.dot(worldDir);
  const directionSign = dotWithDir >= 0 ? 1 : -1;
  const rayDir = worldDir.clone().multiplyScalar(directionSign);

  const maxDist = rayIntersectOBBPlanes(pivotVec, rayDir, obbPlanes);
  if (maxDist === null || maxDist < 1) return null;

  const parentId = panelShape.parameters?.parentShapeId;
  const siblings = shapes.filter(
    s => s.type === 'panel' &&
      s.parameters?.parentShapeId === parentId &&
      s.id !== panelShape.id &&
      s.geometry
  );

  let closestCollision = maxDist;

  for (const sib of siblings) {
    const sibAttr = sib.geometry!.getAttribute('position') as THREE.BufferAttribute;
    if (!sibAttr) continue;
    const sibBbox = new THREE.Box3().setFromBufferAttribute(sibAttr);
    const sibMat = new THREE.Matrix4().compose(
      new THREE.Vector3(...sib.position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...sib.rotation, 'XYZ')),
      new THREE.Vector3(...sib.scale)
    );
    const sibCorners: THREE.Vector3[] = [];
    const sMn = sibBbox.min;
    const sMx = sibBbox.max;
    for (let xi = 0; xi <= 1; xi++)
      for (let yi = 0; yi <= 1; yi++)
        for (let zi = 0; zi <= 1; zi++)
          sibCorners.push(new THREE.Vector3(
            xi === 0 ? sMn.x : sMx.x,
            yi === 0 ? sMn.y : sMx.y,
            zi === 0 ? sMn.z : sMx.z
          ).applyMatrix4(sibMat));

    const sibWorldBbox = new THREE.Box3().setFromPoints(sibCorners);

    const sibHit = new THREE.Vector3();
    const sibRay = new THREE.Ray(pivotVec.clone(), rayDir);
    if (sibRay.intersectBox(sibWorldBbox, sibHit)) {
      const dist = sibHit.distanceTo(pivotVec);
      if (dist > 0.5 && dist < closestCollision) {
        closestCollision = dist;
      }
    }
  }

  return { length: closestCollision, directionSign };
}

async function rebuildPanelGeometry(
  panelShape: Shape,
  newLength: number,
  pivot: [number, number, number],
  directionSign: number,
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
  const longestAxisIdx = axes[2].i;
  const secondAxisIdx = axes[1].i;
  const secondLen = axes[1].v;
  const thinAxisIdx = axes[0].i;

  const dims: [number, number, number] = [0, 0, 0];
  dims[thinAxisIdx] = thickness;
  dims[longestAxisIdx] = newLength;
  dims[secondAxisIdx] = secondLen;

  try {
    const { createReplicadBox, convertReplicadToThreeGeometry } = await import('./ReplicadService');
    const rp = await createReplicadBox({ width: dims[0], height: dims[1], depth: dims[2] });
    const geometry = convertReplicadToThreeGeometry(rp);

    // Center the geometry at local origin
    const newGeoAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
    const newGeoBbox = new THREE.Box3().setFromBufferAttribute(newGeoAttr);
    const geoCenter = new THREE.Vector3();
    newGeoBbox.getCenter(geoCenter);
    const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < positions.count; i++) {
      positions.setXYZ(
        i,
        positions.getX(i) - geoCenter.x,
        positions.getY(i) - geoCenter.y,
        positions.getZ(i) - geoCenter.z
      );
    }
    positions.needsUpdate = true;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const panelQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(...panelShape.rotation, 'XYZ')
    );
    const pivotVec = new THREE.Vector3(...pivot);

    // The pivot is at one end of the panel along the longest axis.
    // directionSign tells us: the panel extends in directionSign * localLongDir from the pivot.
    // For centered geometry: pivot is at -directionSign * newLength/2 along longest axis.
    // We also need to preserve the second-axis and thin-axis offsets from pivot.

    // Transform world pivot into the panel's local coordinate system
    const panelWorldMatrix = new THREE.Matrix4().compose(
      new THREE.Vector3(...panelShape.position),
      panelQuat,
      new THREE.Vector3(1, 1, 1)
    );
    const invMatrix = panelWorldMatrix.clone().invert();
    const localPivot = pivotVec.clone().applyMatrix4(invMatrix);

    // Get pivot position relative to the original geometry's bbox center
    const origCenter = new THREE.Vector3();
    panelLocalBbox.getCenter(origCenter);
    const relPivot = localPivot.clone().sub(origCenter);

    // For the new centered geometry:
    // - Along longest axis: pivot is at the OPPOSITE end from extension direction
    //   Extension goes in +directionSign * localLongDir, so pivot is at -directionSign * newLength/2
    const newLocalPivot = new THREE.Vector3();
    newLocalPivot.setComponent(longestAxisIdx, -directionSign * newLength * 0.5);
    newLocalPivot.setComponent(secondAxisIdx, relPivot.getComponent(secondAxisIdx));
    newLocalPivot.setComponent(thinAxisIdx, relPivot.getComponent(thinAxisIdx));

    // position = worldPivot - rotation * newLocalPivot
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
      },
    });
  } catch (err) {
    console.error('[PanelRotateService] Failed to rebuild panel geometry for auto-extend:', err);
  }
}

export async function executePanelRotate(params: PanelRotateParams): Promise<boolean> {
  const { panelShape, pivot, angleDeg, axis, shapes, updateShape } = params;

  if (Math.abs(angleDeg) < 0.001) return false;

  const inwardSign = computeInwardSign(panelShape, pivot, axis, shapes);
  const effectiveAngle = angleDeg * inwardSign;

  const basePosition = computeBasePosition(panelShape);
  const baseRotation = computeBaseRotation(panelShape);
  const existingSteps: RotateStep[] = panelShape.parameters?.rotateSteps || [];

  const newStep: RotateStep = {
    id: `rot-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
    pivot,
    angleDeg: effectiveAngle,
    axis,
    timestamp: Date.now(),
  };

  const newSteps = [...existingSteps, newStep];
  const result = applyRotateSteps(basePosition, baseRotation, newSteps);

  updateShape(panelShape.id, {
    position: result.position,
    rotation: result.rotation,
    parameters: {
      ...panelShape.parameters,
      baseRotatePosition: basePosition,
      baseRotateRotation: baseRotation,
      rotateSteps: newSteps,
    },
  });

  const extendResult = computeAutoExtendLength(panelShape, result.position, result.rotation, pivot, shapes);
  if (extendResult !== null && extendResult.length > 1) {
    const updatedPanel: Shape = {
      ...panelShape,
      position: result.position,
      rotation: result.rotation,
      parameters: {
        ...panelShape.parameters,
        baseRotatePosition: basePosition,
        baseRotateRotation: baseRotation,
        rotateSteps: newSteps,
      },
    };
    await rebuildPanelGeometry(updatedPanel, extendResult.length, pivot, extendResult.directionSign, updateShape);
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
  const newSteps = steps.map(s => s.id === stepId ? { ...s, angleDeg: newAngleDeg } : s);
  const basePosition = computeBasePosition(panelShape);
  const baseRotation = computeBaseRotation(panelShape);
  const result = applyRotateSteps(basePosition, baseRotation, newSteps);

  updateShape(panelShape.id, {
    position: result.position,
    rotation: result.rotation,
    parameters: {
      ...panelShape.parameters,
      rotateSteps: newSteps,
    },
  });

  const updatedStep = newSteps.find(s => s.id === stepId);
  const pivotForExtend: [number, number, number] = updatedStep?.pivot ?? newSteps[newSteps.length - 1]?.pivot ?? [0, 0, 0];
  const extendResult = computeAutoExtendLength(panelShape, result.position, result.rotation, pivotForExtend, shapes);
  if (extendResult !== null && extendResult.length > 1) {
    const updatedPanel: Shape = {
      ...panelShape,
      position: result.position,
      rotation: result.rotation,
      parameters: { ...panelShape.parameters, rotateSteps: newSteps },
    };
    await rebuildPanelGeometry(updatedPanel, extendResult.length, pivotForExtend, extendResult.directionSign, updateShape);
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
  const newSteps = steps.filter(s => s.id !== stepId);
  const basePosition = computeBasePosition(panelShape);
  const baseRotation = computeBaseRotation(panelShape);
  const result = applyRotateSteps(basePosition, baseRotation, newSteps);

  updateShape(panelShape.id, {
    position: result.position,
    rotation: result.rotation,
    parameters: {
      ...panelShape.parameters,
      rotateSteps: newSteps,
      autoExtendedLength: undefined,
    },
  });

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

async function rebuildSiblingsAfterRotate(
  rotatedPanel: Shape,
  shapes: Shape[]
): Promise<void> {
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
    console.error('[PanelRotateService] Failed to rebuild siblings after rotate:', err);
  }
}
