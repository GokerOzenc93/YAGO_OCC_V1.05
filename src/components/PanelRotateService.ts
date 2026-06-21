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

function getParentWorldBbox(panelShape: Shape, shapes: Shape[]): THREE.Box3 | null {
  const parentId = panelShape.parameters?.parentShapeId;
  if (!parentId) return null;
  const parent = shapes.find(s => s.id === parentId);
  if (!parent || !parent.geometry) return null;

  const pos = parent.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return null;
  const bbox = new THREE.Box3().setFromBufferAttribute(pos);
  const mat = new THREE.Matrix4().compose(
    new THREE.Vector3(...parent.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...parent.rotation, 'XYZ')),
    new THREE.Vector3(...parent.scale)
  );

  const corners: THREE.Vector3[] = [];
  const mn = bbox.min;
  const mx = bbox.max;
  for (let xi = 0; xi <= 1; xi++)
    for (let yi = 0; yi <= 1; yi++)
      for (let zi = 0; zi <= 1; zi++)
        corners.push(new THREE.Vector3(
          xi === 0 ? mn.x : mx.x,
          yi === 0 ? mn.y : mx.y,
          zi === 0 ? mn.z : mx.z
        ).applyMatrix4(mat));

  return new THREE.Box3().setFromPoints(corners);
}

function computeAutoExtendLength(
  panelShape: Shape,
  newPosition: [number, number, number],
  newRotation: [number, number, number],
  shapes: Shape[]
): number | null {
  if (!panelShape.geometry) return null;

  const parentBbox = getParentWorldBbox(panelShape, shapes);
  if (!parentBbox) return null;

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
  const thinAxis = axes[0].i;
  const longAxes = axes.slice(1).sort((a, b) => b.v - a.v);
  const longestLocalAxis = longAxes[0].i;

  const panelQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...newRotation, 'XYZ'));
  const localDir = new THREE.Vector3(
    longestLocalAxis === 0 ? 1 : 0,
    longestLocalAxis === 1 ? 1 : 0,
    longestLocalAxis === 2 ? 1 : 0
  );
  const worldDir = localDir.clone().applyQuaternion(panelQuat).normalize();

  const panelWorldPos = new THREE.Vector3(...newPosition);

  let maxParentDist = 0;
  for (const sign of [-1, 1]) {
    const dir = worldDir.clone().multiplyScalar(sign);
    const ray = new THREE.Ray(panelWorldPos, dir);
    const hit = new THREE.Vector3();
    if (ray.intersectBox(parentBbox, hit)) {
      const dist = hit.distanceTo(panelWorldPos);
      maxParentDist = Math.max(maxParentDist, dist);
    }
  }

  if (maxParentDist < 1) return null;

  const parentId = panelShape.parameters?.parentShapeId;
  const siblings = shapes.filter(
    s => s.type === 'panel' &&
      s.parameters?.parentShapeId === parentId &&
      s.id !== panelShape.id &&
      s.geometry
  );

  let closestCollision = maxParentDist;

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

    for (const sign of [-1, 1]) {
      const dir = worldDir.clone().multiplyScalar(sign);
      const ray = new THREE.Ray(panelWorldPos, dir);
      const hit = new THREE.Vector3();
      if (ray.intersectBox(sibWorldBbox, hit)) {
        const dist = hit.distanceTo(panelWorldPos);
        if (dist > 0.5 && dist < closestCollision) {
          closestCollision = dist;
        }
      }
    }
  }

  return closestCollision * 2;
}

async function rebuildPanelGeometry(
  panelShape: Shape,
  newLength: number,
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

  const dims: [number, number, number] = [0, 0, 0];
  dims[axes[0].i] = thickness;
  dims[longestAxisIdx] = newLength;
  dims[secondAxisIdx] = secondLen;

  try {
    const { createReplicadBox, convertReplicadToThreeGeometry } = await import('./ReplicadService');
    const rp = await createReplicadBox({ width: dims[0], height: dims[1], depth: dims[2] });
    const geometry = convertReplicadToThreeGeometry(rp);

    updateShape(panelShape.id, {
      geometry,
      replicadShape: rp,
      parameters: {
        ...panelShape.parameters,
        width: dims[secondAxisIdx > longestAxisIdx ? secondAxisIdx === 0 ? dims[0] : secondAxisIdx === 1 ? dims[1] : dims[2] : secondLen],
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

  const extendedLen = computeAutoExtendLength(panelShape, result.position, result.rotation, shapes);
  if (extendedLen !== null && extendedLen > 1) {
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
    await rebuildPanelGeometry(updatedPanel, extendedLen, updateShape);
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

  const extendedLen = computeAutoExtendLength(panelShape, result.position, result.rotation, shapes);
  if (extendedLen !== null && extendedLen > 1) {
    const updatedPanel: Shape = {
      ...panelShape,
      position: result.position,
      rotation: result.rotation,
      parameters: { ...panelShape.parameters, rotateSteps: newSteps },
    };
    await rebuildPanelGeometry(updatedPanel, extendedLen, updateShape);
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
