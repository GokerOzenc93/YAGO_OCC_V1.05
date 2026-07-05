import * as THREE from 'three';
import type { Shape } from '../store';

export interface MoveTransformStep {
  id: string;
  type: 'move';
  axis: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-';
  value: number;
  timestamp: number;
}

export interface RotateTransformStep {
  id: string;
  type: 'rotate';
  axis: 'x' | 'y' | 'z';
  value: number;
  pivot: [number, number, number];
  timestamp: number;
}

export type TransformStep = MoveTransformStep | RotateTransformStep;

function axisToVector(axis: string): [number, number, number] {
  switch (axis) {
    case 'x+': return [1, 0, 0];
    case 'x-': return [-1, 0, 0];
    case 'y+': return [0, 1, 0];
    case 'y-': return [0, -1, 0];
    case 'z+': return [0, 0, 1];
    case 'z-': return [0, 0, -1];
    default: return [0, 0, 0];
  }
}

export function applyTransformSteps(
  basePosition: [number, number, number],
  baseRotation: [number, number, number],
  steps: TransformStep[]
): { position: [number, number, number]; rotation: [number, number, number] } {
  let pos = new THREE.Vector3(...basePosition);
  let quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...baseRotation, 'XYZ'));

  for (const step of steps) {
    if (step.type === 'move') {
      const dir = new THREE.Vector3(...axisToVector(step.axis));
      pos.add(dir.multiplyScalar(step.value));
    } else {
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
  }

  const finalEuler = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
  return {
    position: [pos.x, pos.y, pos.z],
    rotation: [finalEuler.x, finalEuler.y, finalEuler.z],
  };
}

function getBaseTransform(panelShape: Shape): {
  basePosition: [number, number, number];
  baseRotation: [number, number, number];
} {
  return {
    basePosition: panelShape.parameters?.baseTransformPosition ?? [...panelShape.position] as [number, number, number],
    baseRotation: panelShape.parameters?.baseTransformRotation ?? [...panelShape.rotation] as [number, number, number],
  };
}

export async function executeTransformStep(
  panelShape: Shape,
  step: Omit<TransformStep, 'id' | 'timestamp'>,
  shapes: Shape[],
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  const { useAppStore } = await import('../store');
  const fresh = useAppStore.getState().shapes.find(s => s.id === panelShape.id) || panelShape;

  const { basePosition, baseRotation } = getBaseTransform(fresh);
  const existingSteps: TransformStep[] = fresh.parameters?.transformSteps || [];

  const newStep: TransformStep = {
    ...step,
    id: `tf-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
    timestamp: Date.now(),
  } as TransformStep;

  const newSteps = [...existingSteps, newStep];
  const { position: newPosition, rotation: newRotation } = applyTransformSteps(basePosition, baseRotation, newSteps);

  updateShape(fresh.id, {
    position: newPosition,
    rotation: newRotation,
    parameters: {
      ...fresh.parameters,
      baseTransformPosition: basePosition,
      baseTransformRotation: baseRotation,
      transformSteps: newSteps,
      // Keep rotateSteps in sync for PanelRebuildService geometry operations
      rotateSteps: newSteps.filter(s => s.type === 'rotate'),
    },
  });

  await rebuildSiblingsAfterTransform(fresh, shapes);
  return true;
}

export async function updateTransformStep(
  panelShape: Shape,
  stepId: string,
  newValue: number,
  shapes: Shape[],
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  const { useAppStore } = await import('../store');
  const fresh = useAppStore.getState().shapes.find(s => s.id === panelShape.id) || panelShape;

  const steps: TransformStep[] = fresh.parameters?.transformSteps || [];
  const newSteps = steps.map(s => s.id === stepId ? { ...s, value: newValue } : s);
  const { basePosition, baseRotation } = getBaseTransform(fresh);
  const { position: newPosition, rotation: newRotation } = applyTransformSteps(basePosition, baseRotation, newSteps);

  updateShape(fresh.id, {
    position: newPosition,
    rotation: newRotation,
    parameters: {
      ...fresh.parameters,
      transformSteps: newSteps,
      rotateSteps: newSteps.filter(s => s.type === 'rotate'),
    },
  });

  await rebuildSiblingsAfterTransform(fresh, shapes);
  return true;
}

export async function deleteTransformStep(
  panelShape: Shape,
  stepId: string,
  shapes: Shape[],
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  const { useAppStore } = await import('../store');
  const fresh = useAppStore.getState().shapes.find(s => s.id === panelShape.id) || panelShape;

  const steps: TransformStep[] = fresh.parameters?.transformSteps || [];
  const newSteps = steps.filter(s => s.id !== stepId);
  const { basePosition, baseRotation } = getBaseTransform(fresh);
  const { position: newPosition, rotation: newRotation } = applyTransformSteps(basePosition, baseRotation, newSteps);

  const newParams: Record<string, any> = {
    ...fresh.parameters,
    transformSteps: newSteps,
    rotateSteps: newSteps.filter(s => s.type === 'rotate'),
  };

  if (newSteps.length === 0) {
    delete newParams.baseTransformPosition;
    delete newParams.baseTransformRotation;
  }

  updateShape(fresh.id, {
    position: newPosition,
    rotation: newRotation,
    parameters: newParams,
  });

  await rebuildSiblingsAfterTransform(fresh, shapes);
  return true;
}

async function rebuildSiblingsAfterTransform(
  panel: Shape,
  shapes: Shape[]
): Promise<void> {
  const parentId = panel.parameters?.parentShapeId;
  if (!parentId) return;

  const parentShape = shapes.find(s => s.id === parentId);
  if (!parentShape) return;

  try {
    const { rebuildPanelsForParent } = await import('./PanelRebuildService');
    await rebuildPanelsForParent(parentId);
  } catch (err) {
    console.error('[PanelTransformService] Failed to rebuild siblings after transform:', err);
  }
}
