import * as THREE from 'three';
import type { Shape } from '../store';
import { executeTransformStep, updateTransformStep, deleteTransformStep } from './PanelTransformService';

// ═══════════════════════════════════════════════════════════════════════════
// PanelMoveService — İNCE ADAPTÖR. Taşıma, birleşik adım listesine tek 'move'
// adımı olarak yazılır; PanelEngine sıralı tekrar eder (dönüşten SONRAKİ
// taşıma dönmüş eksenleri izler — adımlar birbirini dinler).
// ═══════════════════════════════════════════════════════════════════════════

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

export async function executePanelMoveFixed(params: PanelMoveParams): Promise<boolean> {
  const { panelShape, axis, value, shapes, updateShape } = params;
  if (Math.abs(value) < 0.001) return false;
  return executeTransformStep(panelShape, { type: 'move', axis, value, isFixed: true }, shapes, updateShape);
}

export interface PanelMoveRefParams {
  panelShape: Shape;
  sourceVertex: [number, number, number];
  targetPanelId: string;
  targetVertex: [number, number, number];
  shapes: Shape[];
  updateShape: (id: string, updates: Partial<Shape>) => void;
}

export async function executePanelMoveRef(params: PanelMoveRefParams): Promise<boolean> {
  const { panelShape, sourceVertex, targetPanelId, targetVertex, shapes, updateShape } = params;
  const dx = targetVertex[0] - sourceVertex[0];
  const dy = targetVertex[1] - sourceVertex[1];
  const dz = targetVertex[2] - sourceVertex[2];
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < 0.001) return false;
  let maxComp = Math.abs(dx);
  let axis: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-' = dx >= 0 ? 'x+' : 'x-';
  if (Math.abs(dy) > maxComp) { maxComp = Math.abs(dy); axis = dy >= 0 ? 'y+' : 'y-'; }
  if (Math.abs(dz) > maxComp) { axis = dz >= 0 ? 'z+' : 'z-'; }
  const { useAppStore } = await import('../store');
  const fresh = useAppStore.getState().shapes.find(s => s.id === panelShape.id) || panelShape;
  const { getUnifiedSteps, setUnifiedSteps, rebuildPanelsForParent } = await import('./PanelEngine');
  const steps = getUnifiedSteps(fresh);
  const now = Date.now();
  const axisVec = [dx / dist, dy / dist, dz / dist] as [number, number, number];
  const step: any = {
    id: `step-${now}`, type: 'move', axis, value: dist, timestamp: now,
    refSourceVertex: sourceVertex, refTargetPanelId: targetPanelId, refTargetVertex: targetVertex,
    _refAxisVec: axisVec, _refDist: dist,
  };
  setUnifiedSteps(fresh, [...steps, step], updateShape);
  const parentId = (fresh.parameters as any)?.parentShapeId;
  if (parentId) await rebuildPanelsForParent(parentId);
  return true;
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
