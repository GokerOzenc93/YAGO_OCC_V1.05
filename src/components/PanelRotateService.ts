import * as THREE from 'three';
import type { Shape } from '../store';
import { executeTransformStep, updateTransformStep, deleteTransformStep } from './PanelTransformService';

export interface RotateStep {
  id: string;
  axis: 'x' | 'y' | 'z';
  value: number;
  pivot: [number, number, number];
  timestamp: number;
}

export interface PanelRotateParams {
  panelShape: Shape;
  axis: 'x' | 'y' | 'z';
  value: number;
  pivot: [number, number, number];
  shapes: Shape[];
  updateShape: (id: string, updates: Partial<Shape>) => void;
}

export function applyRotateSteps(
  basePosition: [number, number, number],
  baseRotation: [number, number, number],
  steps: RotateStep[]
): { position: [number, number, number]; rotation: [number, number, number] } {
  let pos = new THREE.Vector3(...basePosition);
  const rot = new THREE.Euler(...baseRotation, 'XYZ');
  let quat = new THREE.Quaternion().setFromEuler(rot);

  for (const step of steps) {
    const pivot = new THREE.Vector3(...step.pivot);
    const angleRad = (step.value * Math.PI) / 180;
    const axisVec = new THREE.Vector3(
      step.axis === 'x' ? 1 : 0,
      step.axis === 'y' ? 1 : 0,
      step.axis === 'z' ? 1 : 0
    );

    const stepQuat = new THREE.Quaternion().setFromAxisAngle(axisVec, angleRad);
    quat.premultiply(stepQuat);

    const offset = pos.clone().sub(pivot);
    offset.applyQuaternion(stepQuat);
    pos = pivot.clone().add(offset);
  }

  const finalEuler = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
  return {
    position: [pos.x, pos.y, pos.z],
    rotation: [finalEuler.x, finalEuler.y, finalEuler.z],
  };
}

export async function executePanelRotate(params: PanelRotateParams): Promise<boolean> {
  const { panelShape, axis, value, pivot, shapes, updateShape } = params;
  if (Math.abs(value) < 0.001) return false;
  return executeTransformStep(panelShape, { type: 'rotate', axis, value, pivot }, shapes, updateShape);
}

export async function updateRotateStep(
  panelShape: Shape,
  stepId: string,
  newValue: number,
  shapes: Shape[],
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  return updateTransformStep(panelShape, stepId, newValue, shapes, updateShape);
}

export async function deleteRotateStep(
  panelShape: Shape,
  stepId: string,
  shapes: Shape[],
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  return deleteTransformStep(panelShape, stepId, shapes, updateShape);
}

export function getPanelVertices(panelShape: Shape): [number, number, number][] {
  if (!panelShape.geometry) return [];
  const pos = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return [];

  const mat = new THREE.Matrix4().compose(
    new THREE.Vector3(...panelShape.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...panelShape.rotation, 'XYZ')),
    new THREE.Vector3(...panelShape.scale)
  );

  const seen = new Map<string, [number, number, number]>();
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mat);
    const key = `${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)}`;
    if (!seen.has(key)) seen.set(key, [v.x, v.y, v.z]);
  }
  return Array.from(seen.values());
}

export function getPanelCenter(panelShape: Shape): [number, number, number] {
  if (!panelShape.geometry) return [...panelShape.position] as [number, number, number];
  const pos = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return [...panelShape.position] as [number, number, number];

  const bbox = new THREE.Box3().setFromBufferAttribute(pos);
  const center = new THREE.Vector3();
  bbox.getCenter(center);

  const mat = new THREE.Matrix4().compose(
    new THREE.Vector3(...panelShape.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...panelShape.rotation, 'XYZ')),
    new THREE.Vector3(...panelShape.scale)
  );
  center.applyMatrix4(mat);
  return [center.x, center.y, center.z];
}
