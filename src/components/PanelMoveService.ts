import * as THREE from 'three';
import type { Shape } from '../store';

export interface MoveStep {
  id: string;
  axis: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-';
  value: number;
  timestamp: number;
}

export interface PanelMoveParams {
  panelShape: Shape;
  axis: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-';
  value: number;
  shapes: Shape[];
  updateShape: (id: string, updates: Partial<Shape>) => void;
}

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

function computeBasePosition(panelShape: Shape): [number, number, number] {
  return panelShape.parameters?.baseMovePosition ?? [...panelShape.position] as [number, number, number];
}

export function applyMoveSteps(
  basePosition: [number, number, number],
  steps: MoveStep[]
): [number, number, number] {
  const pos: [number, number, number] = [...basePosition];
  for (const step of steps) {
    const dir = axisToVector(step.axis);
    pos[0] += dir[0] * step.value;
    pos[1] += dir[1] * step.value;
    pos[2] += dir[2] * step.value;
  }
  return pos;
}

export async function executePanelMove(params: PanelMoveParams): Promise<boolean> {
  const { panelShape, axis, value, shapes, updateShape } = params;

  if (Math.abs(value) < 0.001) return false;

  const basePosition = computeBasePosition(panelShape);
  const existingSteps: MoveStep[] = panelShape.parameters?.moveSteps || [];

  const newStep: MoveStep = {
    id: `move-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
    axis,
    value,
    timestamp: Date.now(),
  };

  const newSteps = [...existingSteps, newStep];
  const newPosition = applyMoveSteps(basePosition, newSteps);

  updateShape(panelShape.id, {
    position: newPosition,
    parameters: {
      ...panelShape.parameters,
      baseMovePosition: basePosition,
      moveSteps: newSteps,
    },
  });

  await rebuildSiblingsAfterMove(panelShape, newPosition, shapes, updateShape);
  return true;
}

export async function updateMoveStep(
  panelShape: Shape,
  stepId: string,
  newValue: number,
  shapes: Shape[],
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  const steps: MoveStep[] = panelShape.parameters?.moveSteps || [];
  const newSteps = steps.map(s => s.id === stepId ? { ...s, value: newValue } : s);
  const basePosition = computeBasePosition(panelShape);
  const newPosition = applyMoveSteps(basePosition, newSteps);

  updateShape(panelShape.id, {
    position: newPosition,
    parameters: {
      ...panelShape.parameters,
      moveSteps: newSteps,
    },
  });

  await rebuildSiblingsAfterMove(panelShape, newPosition, shapes, updateShape);
  return true;
}

export async function deleteMoveStep(
  panelShape: Shape,
  stepId: string,
  shapes: Shape[],
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  const steps: MoveStep[] = panelShape.parameters?.moveSteps || [];
  const newSteps = steps.filter(s => s.id !== stepId);
  const basePosition = computeBasePosition(panelShape);
  const newPosition = applyMoveSteps(basePosition, newSteps);

  updateShape(panelShape.id, {
    position: newPosition,
    parameters: {
      ...panelShape.parameters,
      moveSteps: newSteps,
    },
  });

  await rebuildSiblingsAfterMove(panelShape, newPosition, shapes, updateShape);
  return true;
}

async function rebuildSiblingsAfterMove(
  movedPanel: Shape,
  _newPosition: [number, number, number],
  shapes: Shape[],
  _updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<void> {
  const parentId = movedPanel.parameters?.parentShapeId;
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
    console.error('[PanelMoveService] Failed to rebuild siblings after move:', err);
  }
}

export function getPanelOriginOffset(panelShape: Shape): [number, number, number] {
  if (!panelShape.geometry) return [0, 0, 0];
  const pos = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return [0, 0, 0];
  const bbox = new THREE.Box3().setFromBufferAttribute(pos);
  return [bbox.min.x, bbox.min.y, bbox.min.z];
}
