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

// ── PARAMETRİK REFERANS BAĞI YARDIMCILARI ─────────────────────────────────
// Bir şeklin GÜNCEL geometrisinin DÜNYA sınır kutusu (position/rotation/scale
// uygulanmış). Seçilen köşe bu kutuda oransal (frac) konumla saklanır ki
// referans büyüyüp küçüldüğünde köşe geometrik olarak yeniden çözülebilsin.
function worldBboxOf(shape: Shape): { min: THREE.Vector3; max: THREE.Vector3 } | null {
  if (!shape?.geometry) return null;
  const pos = shape.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return null;
  const box = new THREE.Box3().setFromBufferAttribute(pos);
  const mat = new THREE.Matrix4().compose(
    new THREE.Vector3(...(shape.position as any)),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...(shape.rotation as [number, number, number]), 'XYZ')),
    new THREE.Vector3(...((shape.scale as any) || [1, 1, 1]))
  );
  box.applyMatrix4(mat);
  return { min: box.min.clone(), max: box.max.clone() };
}

function fracInBox(box: { min: THREE.Vector3; max: THREE.Vector3 }, p: [number, number, number]): [number, number, number] {
  const fr = (a: number, b: number, x: number) => (Math.abs(b - a) < 1e-9 ? 0 : (x - a) / (b - a));
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  return [
    clamp01(fr(box.min.x, box.max.x, p[0])),
    clamp01(fr(box.min.y, box.max.y, p[1])),
    clamp01(fr(box.min.z, box.max.z, p[2])),
  ];
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
  const { panelShape, sourceVertex, targetPanelId, targetVertex, updateShape } = params;
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
  const state0 = useAppStore.getState();
  const fresh = state0.shapes.find(s => s.id === panelShape.id) || panelShape;
  const targetShape = state0.shapes.find(s => s.id === targetPanelId) || null;
  const { getUnifiedSteps, setUnifiedSteps, rebuildPanelsForParent } = await import('./PanelEngine');
  const steps = getUnifiedSteps(fresh);
  const now = Date.now();
  const axisVec = [dx / dist, dy / dist, dz / dist] as [number, number, number];

  // GEOMETRİK BAĞ: seçilen köşeleri, ait oldukları şeklin GÜNCEL dünya sınır
  // kutusundaki oranla (frac) sakla. Rebuild'de hedef köşe referansın güncel
  // geometrisinden, kaynak köşe taşınan panelin güncel geometrisinden yeniden
  // çözülür → parametrik büyüme/küçülmede köşe kilitli kalır.
  const srcBox = worldBboxOf(fresh);
  const tgtBox = targetShape ? worldBboxOf(targetShape) : null;
  const refSourceFrac = srcBox ? fracInBox(srcBox, sourceVertex) : undefined;
  const refTargetFrac = tgtBox ? fracInBox(tgtBox, targetVertex) : undefined;
  console.log('[YAGO][REF-BAĞ] kaynakFrac=', refSourceFrac, 'hedefFrac=', refTargetFrac,
    'hedef=', targetPanelId, 'donmuşDelta=', [dx.toFixed(1), dy.toFixed(1), dz.toFixed(1)].join(','));

  const step: any = {
    id: `step-${now}`, type: 'move', axis, value: dist, timestamp: now,
    refSourceVertex: sourceVertex, refTargetPanelId: targetPanelId, refTargetVertex: targetVertex,
    ...(refSourceFrac ? { refSourceFrac } : {}),
    ...(refTargetFrac ? { refTargetFrac } : {}),
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
