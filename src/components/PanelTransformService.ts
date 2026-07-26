import * as THREE from 'three';
import type { Shape } from '../store';

// ═══════════════════════════════════════════════════════════════════════════
// PanelTransformService — BİRLEŞİK ADIM DEPOSU (ince).
// Tek gerçek kaynak: panel.parameters.transformSteps (sıralı move|rotate).
// Geometrik yorum PanelEngine.composeSteps'te; burada yalnız CRUD + görsel
// katmanın beklediği imzalar. applyTransformSteps saf önizleme matematiğidir
// (gizmo/step-list gösterimi) ve motorla AYNI kuralı uygular: adımlar
// birbirini dinler (move, o anki dönüş çerçevesinin ekseninde ilerler).
// ═══════════════════════════════════════════════════════════════════════════

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
  axisVec?: [number, number, number];
  value: number;
  pivot: [number, number, number];
  pivotFrac?: [number, number, number];
  pivotVfFrac?: [number, number, number];
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

/**
 * Saf önizleme matematiği: adımları sırayla position/rotation üzerine uygular.
 * move: o anki birleşik dönüş çerçevesinin ekseninde delta. rotate: pivot
 * etrafında; eksen adımdaki panel-yerel vektör (yoksa dünya harfi).
 */
export function applyTransformSteps(
  basePosition: [number, number, number],
  baseRotation: [number, number, number],
  steps: TransformStep[]
): { position: [number, number, number]; rotation: [number, number, number] } {
  let pos = new THREE.Vector3(...basePosition);
  const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...baseRotation, 'XYZ'));
  for (const s of steps) {
    if (s.type === 'move') {
      const base = new THREE.Vector3(...axisToVector(s.axis));
      pos.add(base.applyQuaternion(quat).multiplyScalar(s.value));
    } else {
      const axis = s.axisVec
        ? new THREE.Vector3(...s.axisVec).normalize()
        : new THREE.Vector3(s.axis === 'x' ? 1 : 0, s.axis === 'y' ? 1 : 0, s.axis === 'z' ? 1 : 0);
      const worldAxis = axis.clone().applyQuaternion(quat).normalize();
      const q = new THREE.Quaternion().setFromAxisAngle(worldAxis, (s.value * Math.PI) / 180);
      quat.premultiply(q);
      const pivot = new THREE.Vector3(...s.pivot);
      pos = pivot.clone().add(pos.sub(pivot).applyQuaternion(q));
    }
  }
  const e = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
  return { position: [pos.x, pos.y, pos.z], rotation: [e.x, e.y, e.z] };
}

/** Birleşik dönüşümün özeti (görsel katman step listesi/gizmo için). */
export function resolveUnifiedTransform(panelShape: Shape): {
  steps: TransformStep[];
  position: [number, number, number];
  rotation: [number, number, number];
} {
  const p: any = panelShape.parameters || {};
  const steps: TransformStep[] = Array.isArray(p.transformSteps) ? [...p.transformSteps] : [];
  steps.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const { position, rotation } = applyTransformSteps(
    panelShape.position as any, [0, 0, 0], steps
  );
  return { steps, position, rotation };
}

async function writeAndRebuild(
  panelShape: Shape,
  steps: TransformStep[],
  updateShape: (id: string, u: Partial<Shape>) => void
): Promise<boolean> {
  const { setUnifiedSteps, rebuildPanelsForParent } = await import('./PanelEngine');
  setUnifiedSteps(panelShape, steps, updateShape);
  const parentId = (panelShape.parameters as any)?.parentShapeId;
  if (parentId) await rebuildPanelsForParent(parentId);
  return true;
}

export async function executeTransformStep(
  panelShape: Shape,
  step: { type: 'move'; axis: MoveTransformStep['axis']; value: number } |
        { type: 'rotate'; axis: RotateTransformStep['axis']; value: number; pivot: [number, number, number]; axisVec?: [number, number, number]; pivotFrac?: [number, number, number]; pivotVfFrac?: [number, number, number] },
  _shapes: Shape[],
  updateShape: (id: string, u: Partial<Shape>) => void
): Promise<boolean> {
  const { useAppStore } = await import('../store');
  const fresh = useAppStore.getState().shapes.find(s => s.id === panelShape.id) || panelShape;
  const { getUnifiedSteps } = await import('./PanelEngine');
  const steps = getUnifiedSteps(fresh);
  const now = Date.now();
  const full: TransformStep = step.type === 'move'
    ? { id: `step-${now}`, type: 'move', axis: step.axis, value: step.value, timestamp: now }
    : { id: `step-${now}`, type: 'rotate', axis: step.axis, axisVec: step.axisVec, value: step.value, pivot: step.pivot, pivotFrac: step.pivotFrac, pivotVfFrac: step.pivotVfFrac, timestamp: now };
  return writeAndRebuild(fresh, [...steps, full], updateShape);
}

export async function updateTransformStep(
  panelShape: Shape,
  stepId: string,
  newValue: number,
  _shapes: Shape[],
  updateShape: (id: string, u: Partial<Shape>) => void
): Promise<boolean> {
  const { useAppStore } = await import('../store');
  const fresh = useAppStore.getState().shapes.find(s => s.id === panelShape.id) || panelShape;
  const { getUnifiedSteps } = await import('./PanelEngine');
  const steps = getUnifiedSteps(fresh).map(s => (s.id === stepId ? { ...s, value: newValue } : s));
  return writeAndRebuild(fresh, steps, updateShape);
}

export async function deleteTransformStep(
  panelShape: Shape,
  stepId: string,
  _shapes: Shape[],
  updateShape: (id: string, u: Partial<Shape>) => void
): Promise<boolean> {
  const { useAppStore } = await import('../store');
  const fresh = useAppStore.getState().shapes.find(s => s.id === panelShape.id) || panelShape;
  const { getUnifiedSteps } = await import('./PanelEngine');
  const steps = getUnifiedSteps(fresh).filter(s => s.id !== stepId);
  return writeAndRebuild(fresh, steps, updateShape);
}
