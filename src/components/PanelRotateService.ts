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

export async function executePanelRotate(params: PanelRotateParams): Promise<boolean> {
  const { panelShape, pivot, angleDeg, axis, shapes, updateShape } = params;

  if (Math.abs(angleDeg) < 0.001) return false;

  const basePosition = computeBasePosition(panelShape);
  const baseRotation = computeBaseRotation(panelShape);
  const existingSteps: RotateStep[] = panelShape.parameters?.rotateSteps || [];

  const newStep: RotateStep = {
    id: `rot-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
    pivot,
    angleDeg,
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
    },
  });

  await rebuildSiblingsAfterRotate(panelShape, shapes);
  return true;
}

export function getPanelPivotPoints(panelShape: Shape): { label: string; world: [number, number, number] }[] {
  const points: { label: string; world: [number, number, number] }[] = [];
  if (!panelShape.geometry) return points;

  const pos = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return points;

  const bbox = new THREE.Box3().setFromBufferAttribute(pos);
  const mat = new THREE.Matrix4().compose(
    new THREE.Vector3(...panelShape.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...panelShape.rotation, 'XYZ')),
    new THREE.Vector3(...panelShape.scale)
  );

  const toWorld = (lx: number, ly: number, lz: number): [number, number, number] => {
    const v = new THREE.Vector3(lx, ly, lz).applyMatrix4(mat);
    return [v.x, v.y, v.z];
  };

  const mn = bbox.min;
  const mx = bbox.max;
  const cx = (mn.x + mx.x) / 2;
  const cy = (mn.y + mx.y) / 2;
  const cz = (mn.z + mx.z) / 2;

  points.push({ label: 'Merkez', world: toWorld(cx, cy, cz) });

  const corners = [
    { label: 'K1', local: [mn.x, mn.y, cz] },
    { label: 'K2', local: [mx.x, mn.y, cz] },
    { label: 'K3', local: [mx.x, mx.y, cz] },
    { label: 'K4', local: [mn.x, mx.y, cz] },
  ];

  const midpoints = [
    { label: 'O1', local: [cx, mn.y, cz] },
    { label: 'O2', local: [mx.x, cy, cz] },
    { label: 'O3', local: [cx, mx.y, cz] },
    { label: 'O4', local: [mn.x, cy, cz] },
  ];

  for (const c of corners) {
    points.push({ label: c.label, world: toWorld(c.local[0], c.local[1], c.local[2]) });
  }
  for (const m of midpoints) {
    points.push({ label: m.label, world: toWorld(m.local[0], m.local[1], m.local[2]) });
  }

  return points;
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
