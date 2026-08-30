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

export interface MoveAnchor {
  faceSpanAlongAxis: number;
  contactPanelId?: string;
  contactFaceNormal?: [number, number, number];
  parentDims: { width: number; height: number; depth: number };
}

export interface MoveTransformStep {
  id: string;
  type: 'move';
  axis: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-';
  value: number;
  timestamp: number;
  anchor?: MoveAnchor;
  isFixed?: boolean;
  refSourceVertex?: [number, number, number];
  refTargetPanelId?: string;
  refTargetVertex?: [number, number, number];
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
      const ms = s as any;
      if (ms._refAxisVec && ms._refDist) {
        const v = new THREE.Vector3(ms._refAxisVec[0], ms._refAxisVec[1], ms._refAxisVec[2]);
        pos.add(v.multiplyScalar(ms._refDist));
      } else {
        const base = new THREE.Vector3(...axisToVector(s.axis));
        pos.add(base.applyQuaternion(quat).multiplyScalar(s.value));
      }
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

function computeVfSpanAlongAxis(vf: any, axis: string): number {
  if (!vf?.vertices || vf.vertices.length < 3) return 0;
  const axisBase = axis[0] as 'x' | 'y' | 'z';
  const idx = axisBase === 'x' ? 0 : axisBase === 'y' ? 1 : 2;
  let min = Infinity, max = -Infinity;
  for (const v of vf.vertices) {
    const c = v[idx];
    if (c < min) min = c;
    if (c > max) max = c;
  }
  return Math.abs(max - min);
}

function findContactPanel(
  panelShape: Shape,
  axis: string,
  value: number,
  state: any
): { contactPanelId: string; contactFaceNormal: [number, number, number] } | null {
  const parentId = (panelShape.parameters as any)?.parentShapeId;
  const vfId = (panelShape.parameters as any)?.virtualFaceId;
  if (!parentId || !vfId) return null;
  const siblings = (state.shapes as Shape[]).filter(
    s => s.type === 'panel' && s.id !== panelShape.id &&
         (s.parameters as any)?.parentShapeId === parentId
  );
  if (siblings.length === 0) return null;
  const axisBase = axis[0] as 'x' | 'y' | 'z';
  const sign = axis.includes('-') ? -1 : 1;
  const normal: [number, number, number] = [
    axisBase === 'x' ? sign : 0,
    axisBase === 'y' ? sign : 0,
    axisBase === 'z' ? sign : 0,
  ];
  const myVf = (state.virtualFaces as any[]).find((f: any) => f.id === vfId);
  if (!myVf) return null;
  const idx = axisBase === 'x' ? 0 : axisBase === 'y' ? 1 : 2;
  const myCenter = myVf.center[idx];
  const targetPos = myCenter + value;
  let best: Shape | null = null;
  let bestDist = Infinity;
  for (const sib of siblings) {
    const sibVfId = (sib.parameters as any)?.virtualFaceId;
    const sibVf = (state.virtualFaces as any[]).find((f: any) => f.id === sibVfId);
    if (!sibVf) continue;
    if (!sib.geometry) continue;
    const posAttr = sib.geometry.getAttribute('position');
    if (!posAttr) continue;
    let sMin = Infinity, sMax = -Infinity;
    for (let i = 0; i < posAttr.count; i++) {
      const c = idx === 0 ? posAttr.getX(i) : idx === 1 ? posAttr.getY(i) : posAttr.getZ(i);
      if (c < sMin) sMin = c;
      if (c > sMax) sMax = c;
    }
    const nearEdge = sign > 0 ? sMin : sMax;
    const dist = Math.abs(targetPos - nearEdge);
    if (dist < bestDist && dist < 50) {
      bestDist = dist;
      best = sib;
    }
  }
  if (best) {
    return { contactPanelId: best.id, contactFaceNormal: normal };
  }
  return null;
}

function buildMoveAnchor(
  panelShape: Shape,
  axis: string,
  value: number,
  state: any
): MoveAnchor | null {
  const parentId = (panelShape.parameters as any)?.parentShapeId;
  const vfId = (panelShape.parameters as any)?.virtualFaceId;
  if (!parentId || !vfId) return null;
  const parent = (state.shapes as Shape[]).find(s => s.id === parentId);
  if (!parent) return null;
  const vf = (state.virtualFaces as any[]).find((f: any) => f.id === vfId);
  if (!vf) return null;
  const faceSpan = computeVfSpanAlongAxis(vf, axis);
  if (faceSpan < 1) return null;
  const parentDims = {
    width: parent.parameters?.width || 1,
    height: parent.parameters?.height || 1,
    depth: parent.parameters?.depth || 1,
  };
  const contact = findContactPanel(panelShape, axis, value, state);
  const anchor: MoveAnchor = {
    faceSpanAlongAxis: faceSpan,
    parentDims,
    ...(contact || {}),
  };
  console.log('[YAGO][ANCHOR] Taşıma çapası oluşturuldu:', panelShape.id,
    'eksen=', axis, 'değer=', value,
    'yüzSpan=', faceSpan.toFixed(1),
    'temas=', contact?.contactPanelId || 'YOK',
    'ebeveynBoyut=', `${parentDims.width}x${parentDims.height}x${parentDims.depth}`);
  return anchor;
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
  step: { type: 'move'; axis: MoveTransformStep['axis']; value: number; isFixed?: boolean } |
        { type: 'rotate'; axis: RotateTransformStep['axis']; value: number; pivot: [number, number, number]; axisVec?: [number, number, number]; pivotFrac?: [number, number, number]; pivotVfFrac?: [number, number, number] },
  _shapes: Shape[],
  updateShape: (id: string, u: Partial<Shape>) => void
): Promise<boolean> {
  const { useAppStore } = await import('../store');
  const fresh = useAppStore.getState().shapes.find(s => s.id === panelShape.id) || panelShape;
  const { getUnifiedSteps } = await import('./PanelEngine');
  const steps = getUnifiedSteps(fresh);
  const now = Date.now();
  let full: TransformStep;
  if (step.type === 'move') {
    const anchor = buildMoveAnchor(fresh, step.axis, step.value, useAppStore.getState());
    full = { id: `step-${now}`, type: 'move', axis: step.axis, value: step.value, timestamp: now, ...(step.isFixed ? { isFixed: true } : {}), ...(anchor ? { anchor } : {}) };
  } else {
    full = { id: `step-${now}`, type: 'rotate', axis: step.axis, axisVec: step.axisVec, value: step.value, pivot: step.pivot, pivotFrac: step.pivotFrac, pivotVfFrac: step.pivotVfFrac, timestamp: now };
  }
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
