import * as THREE from 'three';
import type { Shape } from '../store';
import { executeTransformStep, updateTransformStep, deleteTransformStep } from './PanelTransformService';

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

export async function executePanelMove(params: PanelMoveParams): Promise<boolean> {
  const { panelShape, axis, value, shapes, updateShape } = params;
  if (Math.abs(value) < 0.001) return false;
  return executeTransformStep(panelShape, { type: 'move', axis, value }, shapes, updateShape);
}

export async function updateMoveStep(
  panelShape: Shape,
  stepId: string,
  newValue: number,
  shapes: Shape[],
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  return updateTransformStep(panelShape, stepId, newValue, shapes, updateShape);
}

export async function deleteMoveStep(
  panelShape: Shape,
  stepId: string,
  shapes: Shape[],
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  return deleteTransformStep(panelShape, stepId, shapes, updateShape);
}

export function getPanelOriginOffset(panelShape: Shape): [number, number, number] {
  if (!panelShape.geometry) return [0, 0, 0];
  const pos = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return [0, 0, 0];
  const bbox = new THREE.Box3().setFromBufferAttribute(pos);
  return [bbox.min.x, bbox.min.y, bbox.min.z];
}
