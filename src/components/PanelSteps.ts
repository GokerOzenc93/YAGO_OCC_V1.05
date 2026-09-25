import * as THREE from 'three';
import { useAppStore, type Shape } from '../store';
import {
  axisDirToVec, axisLetterVec, mapAxisToVfLocal, vfFracOfPoint, vfRawMinAlong, angleToTouchPlane,
  worldBboxOf, fracInBox, type AxisDir, type Vec3,
} from './PanelMath';

// ═══════════════════════════════════════════════════════════════════════════
// PanelSteps — PANEL DÖNÜŞÜM ADIMLARI (taşı / döndür): model + komutlar.
// Eski PanelMoveService + PanelRotateService + PanelTransformService +
// PanelRebuildService tek dosyada.
//
// SÖZLEŞME
//  • Tek gerçek kaynak: panel.parameters.transformSteps (sıralı move|rotate).
//    Geometriyi motor (PanelEngine.composeSteps) her rebuild'de sıfırdan üretir;
//    burada yalnız adım yazılır + rebuild tetiklenir.
//  • Adımlar birbirini dinler: dönüşten SONRAKİ taşıma dönmüş eksende ilerler.
//  • Eksen PANEL-YEREL: kullanıcının dünya ekseni panelin VF tabanındaki en
//    yakın eksene eşlenir → dönüş her yüzde "yerinde eğer".
//  • Pivot/nişan çıpaları VF'ye ORANSAL (pivotVfFrac, refArmVfFrac); pivotFrac
//    (parent kutusu) ve mutlak pivot yedektir.
//  • REF bağları parametriktir: hedef nokta/yüz her rebuild'de GÜNCEL
//    geometriden yeniden çözülür (value yalnız çözüm başarısızsa yedek).
// ═══════════════════════════════════════════════════════════════════════════

type UpdateShape = (id: string, updates: Partial<Shape>) => void;

export interface MoveTransformStep {
  id: string;
  type: 'move';
  axis: AxisDir;
  value: number;
  timestamp: number;
  /** DYN taşımada oluşturma anındaki VF açıklığı → değer açıklık oranıyla ölçeklenir. */
  anchor?: { faceSpanAlongAxis: number; [k: string]: unknown };
  isFixed?: boolean;
  /** FIXED: oluşturma anında VF ham yüzünün eksen boyunca min konumu (mutlak konum çıpası). */
  fixedRef?: number;
  // REF TAŞIMA: kaynak/hedef köşe, ait oldukları şeklin DÜNYA kutusunda oransal.
  refSourceVertex?: Vec3;
  refTargetPanelId?: string;
  refTargetVertex?: Vec3;
  refSourceFrac?: Vec3;
  refTargetFrac?: Vec3;
  _refAxisVec?: Vec3;
  _refDist?: number;
}

export interface RotateTransformStep {
  id: string;
  type: 'rotate';
  axis: 'x' | 'y' | 'z';
  /** Panel-yerel eksen (VF tabanına eşlenmiş). */
  axisVec?: Vec3;
  /** Derece. REF adımında yalnız yedek; gerçek açı resolvedValue. */
  value: number;
  pivot: Vec3;
  pivotFrac?: Vec3;
  pivotVfFrac?: Vec3;
  timestamp: number;
  // REF DÖNÜŞ: nişan noktası (VF'ye oransal) referans YÜZE değene / oturana kadar döner.
  refTargetPanelId?: string;
  refTargetVertex?: Vec3;          // eski nokta tabanlı bağ (okunur)
  refTargetFrac?: Vec3;
  refTargetFaceGroupIndex?: number;
  refTargetFaceNormal?: Vec3;
  refTargetFacePoint?: Vec3;
  refArmVertex?: Vec3;
  refArmVfFrac?: Vec3;
  resolvedValue?: number;
}

export type TransformStep = MoveTransformStep | RotateTransformStep;

// ── Depolama ────────────────────────────────────────────────────────────────

/**
 * Birleşik adım listesi (timestamp sıralı). Eski parameters.rotateSteps
 * yalnız OKUNUR-göç edilir; yeni yazımlar transformSteps'e gider.
 */
export function getUnifiedSteps(panel: Shape): TransformStep[] {
  const p: any = panel.parameters || {};
  const t: TransformStep[] = Array.isArray(p.transformSteps) ? [...p.transformSteps] : [];
  const have = new Set(t.map(s => s.id));
  for (const r of Array.isArray(p.rotateSteps) ? p.rotateSteps : []) {
    if (!have.has(r.id)) t.push({ ...r, type: 'rotate' });
  }
  t.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return t;
}

/** Adımları yazar (+ eski okuyucular için rotateSteps aynası). */
export function setUnifiedSteps(panel: Shape, steps: TransformStep[], updateShape: UpdateShape): void {
  updateShape(panel.id, {
    parameters: { ...panel.parameters, transformSteps: steps, rotateSteps: steps.filter(s => s.type === 'rotate') },
  } as any);
}

/** Panelin referans bağları: kimleri datum/ref alıyor (extrude + taşıma + dönüş). */
export function stepRefTargets(panel: any): { extrude: Set<string>; move: Set<string>; rotate: Set<string> } {
  const extrude = new Set<string>(), move = new Set<string>(), rotate = new Set<string>();
  const p = panel?.parameters;
  if (Array.isArray(p?.extrudeSteps)) for (const s of p.extrudeSteps) if (s?.refShapeId) extrude.add(s.refShapeId);
  if (Array.isArray(p?.transformSteps)) for (const s of p.transformSteps) {
    if (!s?.refTargetPanelId) continue;
    if (s.type === 'move') move.add(s.refTargetPanelId);
    else if (s.type === 'rotate') rotate.add(s.refTargetPanelId);
  }
  return { extrude, move, rotate };
}

/** Panelin güncel store kopyası (komut, bayat prop yerine bunu kullanır). */
function freshShape(panel: Shape): Shape {
  return useAppStore.getState().shapes.find(s => s.id === panel.id) || panel;
}

/** Adımları yazar ve panelin parent'ını (işlem gören panel bilgisiyle) yeniden üretir. */
async function commitSteps(panel: Shape, steps: TransformStep[], updateShape: UpdateShape): Promise<boolean> {
  setUnifiedSteps(panel, steps, updateShape);
  const parentId = (panel.parameters as any)?.parentShapeId;
  if (parentId) {
    const { rebuildPanelsForParent } = await import('./PanelEngine');
    await rebuildPanelsForParent(parentId, { changedPanelId: panel.id, orderChanged: false });
  }
  return true;
}

// ── Önizleme (saf) ──────────────────────────────────────────────────────────

/**
 * Adımları position/rotation üzerine sırayla uygular (gizmo/ok gösterimi).
 * Motorla AYNI kural: move o anki dönüş çerçevesinin ekseninde ilerler.
 */
export function applyTransformSteps(
  basePosition: Vec3, baseRotation: Vec3, steps: TransformStep[]
): { position: Vec3; rotation: Vec3 } {
  let pos = new THREE.Vector3(...basePosition);
  const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...baseRotation, 'XYZ'));
  for (const s of steps) {
    if (s.type === 'move') {
      if (s._refAxisVec && s._refDist) pos.add(new THREE.Vector3(...s._refAxisVec).multiplyScalar(s._refDist));
      else pos.add(axisDirToVec(s.axis).applyQuaternion(quat).multiplyScalar(s.value));
    } else {
      const axis = s.axisVec ? new THREE.Vector3(...s.axisVec).normalize() : axisLetterVec(s.axis);
      const worldAxis = axis.applyQuaternion(quat).normalize();
      const deg = typeof s.resolvedValue === 'number' ? s.resolvedValue : s.value;
      const q = new THREE.Quaternion().setFromAxisAngle(worldAxis, (deg * Math.PI) / 180);
      quat.premultiply(q);
      const pivot = new THREE.Vector3(...s.pivot);
      pos = pivot.clone().add(pos.sub(pivot).applyQuaternion(q));
    }
  }
  const e = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
  return { position: [pos.x, pos.y, pos.z], rotation: [e.x, e.y, e.z] };
}

// ── Ortak ───────────────────────────────────────────────────────────────────

const newStepId = (now: number) => `step-${now}`;

/** Pivotun parent kutusuna oransal yedek çıpası. */
function parentFracOf(panel: Shape, pivot: Vec3): Vec3 | undefined {
  const parent = useAppStore.getState().shapes.find(s => s.id === (panel.parameters as any)?.parentShapeId);
  if (!parent) return undefined;
  const pp: any = parent.parameters || {};
  const w = parseFloat(pp.width) || 1, h = parseFloat(pp.height) || 1, d = parseFloat(pp.depth) || 1;
  const pos = parent.position;
  return [(pivot[0] - pos[0]) / w, (pivot[1] - pos[1]) / h, (pivot[2] - pos[2]) / d];
}

const vfOfPanel = (panel: Shape) =>
  useAppStore.getState().virtualFaces.find(f => f.id === (panel.parameters as any)?.virtualFaceId);

// ── TAŞIMA ──────────────────────────────────────────────────────────────────

export interface PanelMoveParams { panelShape: Shape; axis: AxisDir; value: number; updateShape: UpdateShape; }

/** DYN taşıma: yüze göre ofset (yüz büyüyünce açıklık oranında ölçeklenir). */
export function executePanelMove(p: PanelMoveParams): Promise<boolean> {
  return addMoveStep(p, false);
}

/** FIXED taşıma: panel parent çerçevesinde MUTLAK konumda kalır. */
export function executePanelMoveFixed(p: PanelMoveParams): Promise<boolean> {
  return addMoveStep(p, true);
}

async function addMoveStep({ panelShape, axis, value, updateShape }: PanelMoveParams, isFixed: boolean): Promise<boolean> {
  if (Math.abs(value) < 0.001) return false;
  const fresh = freshShape(panelShape);
  const steps = getUnifiedSteps(fresh);
  const vf = vfOfPanel(fresh);
  const now = Date.now();
  // DYN ölçek çıpası: VF'nin taşıma ekseni boyunca açıklığı.
  let anchor: MoveTransformStep['anchor'];
  if (vf && vf.vertices.length >= 3) {
    const i = axis[0] === 'x' ? 0 : axis[0] === 'y' ? 1 : 2;
    let min = Infinity, max = -Infinity;
    for (const c of vf.vertices) { if (c[i] < min) min = c[i]; if (c[i] > max) max = c[i]; }
    const span = Math.abs(max - min);
    if (span >= 1) anchor = { faceSpanAlongAxis: span };
  }
  // FIXED: yüzün o anki ham konumu (dönüş adımı öncesindeyse).
  let fixedRef: number | undefined;
  if (isFixed && vf && !steps.some(s => s.type === 'rotate')) {
    const r = vfRawMinAlong(vf, axis);
    if (r !== null) fixedRef = r;
  }
  console.log('[YAGO][TAŞI]', fresh.id, isFixed ? 'FIXED' : 'DYN', 'eksen=', axis, 'değer=', value,
    'yüzSpan=', anchor ? anchor.faceSpanAlongAxis.toFixed(1) : '-', 'fixedRef=', fixedRef ?? '-');
  const step: MoveTransformStep = {
    id: newStepId(now), type: 'move', axis, value, timestamp: now,
    ...(isFixed ? { isFixed: true } : {}), ...(fixedRef !== undefined ? { fixedRef } : {}), ...(anchor ? { anchor } : {}),
  };
  return commitSteps(fresh, [...steps, step], updateShape);
}

export interface PanelMoveRefParams {
  panelShape: Shape; sourceVertex: Vec3; targetPanelId: string; targetVertex: Vec3; updateShape: UpdateShape;
}

/**
 * REF taşıma: panelin seçilen köşesi hedef şeklin köşesine kilitlenir. Köşeler
 * kendi şekillerinin dünya kutusunda ORANSAL saklanır → hedef büyüyüp
 * küçüldükçe bağ geometrik olarak yeniden çözülür.
 */
export async function executePanelMoveRef({ panelShape, sourceVertex, targetPanelId, targetVertex, updateShape }: PanelMoveRefParams): Promise<boolean> {
  const d = new THREE.Vector3(...targetVertex).sub(new THREE.Vector3(...sourceVertex));
  const dist = d.length();
  if (dist < 0.001) return false;
  let axis: AxisDir = d.x >= 0 ? 'x+' : 'x-';
  let maxComp = Math.abs(d.x);
  if (Math.abs(d.y) > maxComp) { maxComp = Math.abs(d.y); axis = d.y >= 0 ? 'y+' : 'y-'; }
  if (Math.abs(d.z) > maxComp) axis = d.z >= 0 ? 'z+' : 'z-';
  const fresh = freshShape(panelShape);
  const target = useAppStore.getState().shapes.find(s => s.id === targetPanelId) || null;
  const srcBox = worldBboxOf(fresh, fresh.geometry);
  const tgtBox = target ? worldBboxOf(target, target.geometry) : null;
  const refSourceFrac = srcBox ? fracInBox(srcBox, sourceVertex) : undefined;
  const refTargetFrac = tgtBox ? fracInBox(tgtBox, targetVertex) : undefined;
  console.log('[YAGO][REF-BAĞ] kaynakFrac=', refSourceFrac, 'hedefFrac=', refTargetFrac,
    'hedef=', targetPanelId, 'donmuşDelta=', [d.x.toFixed(1), d.y.toFixed(1), d.z.toFixed(1)].join(','));
  const now = Date.now();
  const step: MoveTransformStep = {
    id: newStepId(now), type: 'move', axis, value: dist, timestamp: now,
    refSourceVertex: sourceVertex, refTargetPanelId: targetPanelId, refTargetVertex: targetVertex,
    ...(refSourceFrac ? { refSourceFrac } : {}),
    ...(refTargetFrac ? { refTargetFrac } : {}),
    _refAxisVec: [d.x / dist, d.y / dist, d.z / dist], _refDist: dist,
  };
  return commitSteps(fresh, [...getUnifiedSteps(fresh), step], updateShape);
}

// ── DÖNDÜRME ────────────────────────────────────────────────────────────────

export interface PanelRotateParams { panelShape: Shape; axis: 'x' | 'y' | 'z'; value: number; pivot: Vec3; updateShape: UpdateShape; }

/** Sabit açılı dönüş (panel-yerel eksen, VF'ye oransal pivot). */
export async function executePanelRotate({ panelShape, axis, value, pivot, updateShape }: PanelRotateParams): Promise<boolean> {
  if (Math.abs(value) < 0.001) return false;
  const fresh = freshShape(panelShape);
  const vf = vfOfPanel(fresh);
  const now = Date.now();
  const step: RotateTransformStep = {
    id: newStepId(now), type: 'rotate', axis,
    axisVec: vf?.normal ? mapAxisToVfLocal(vf, axis) : undefined,
    value, pivot, pivotFrac: parentFracOf(fresh, pivot),
    pivotVfFrac: vf?.normal ? vfFracOfPoint(vf, pivot) : undefined, timestamp: now,
  };
  return commitSteps(fresh, [...getUnifiedSteps(fresh), step], updateShape);
}

export interface PanelRotateRefParams {
  panelShape: Shape;
  pivot: Vec3;
  armVertex: Vec3;
  axis: 'x' | 'y' | 'z';
  targetPanelId: string;
  targetFace: { faceGroupIndex: number; normalWorld: Vec3; pointWorld: Vec3 };
  updateShape: UpdateShape;
}

/**
 * REF dönüş (Goker akışı): pivot → nişan noktası → eksen → referans YÜZ → sağ tık.
 * Nişan noktası referans yüzün düzlemine değene kadar döner; açı her rebuild'de
 * GÜNCEL geometriden yeniden çözülür (PanelEngine.resolveRefRotateDeg).
 */
export async function executePanelRotateRef({ panelShape, pivot, armVertex, axis, targetPanelId, targetFace, updateShape }: PanelRotateRefParams): Promise<boolean> {
  const fresh = freshShape(panelShape);
  const vf = vfOfPanel(fresh);
  const axisVec = mapAxisToVfLocal(vf, axis);
  const axisWorld = axisVec ? new THREE.Vector3(...axisVec) : axisLetterVec(axis);
  // Oluşturma anındaki açı — yalnız çözüm başarısız olursa yedek.
  const sol = angleToTouchPlane(
    new THREE.Vector3(...pivot), new THREE.Vector3(...armVertex), axisWorld,
    new THREE.Vector3(...targetFace.normalWorld), new THREE.Vector3(...targetFace.pointWorld), 0
  );
  if (!sol) {
    console.warn('[YAGO][REF-DÖN] nişan noktası eksen üstünde — açı tanımsız, iptal');
    return false;
  }
  if (!sol.touched) {
    console.warn('[YAGO][REF-DÖN] nişan noktası referans yüze ULAŞAMIYOR — en yakın yaklaşma açısı kullanılıyor:', sol.deg.toFixed(2));
  }
  const deg0 = Math.round(sol.deg * 1000) / 1000;
  const pivotVfFrac = vf ? vfFracOfPoint(vf, pivot) : undefined;
  const refArmVfFrac = vf ? vfFracOfPoint(vf, armVertex) : undefined;
  console.log('[YAGO][REF-DÖN] bağ kuruldu — pivotVfFrac=', pivotVfFrac,
    'nişanVfFrac=', refArmVfFrac, 'hedef=', targetPanelId, 'yüzGrubu=', targetFace.faceGroupIndex,
    'yüzN=', targetFace.normalWorld.map(n => n.toFixed(2)).join(','), 'eksen=', axis, 'açı0=', deg0.toFixed(2));
  const now = Date.now();
  const step: RotateTransformStep = {
    id: newStepId(now), type: 'rotate', axis, axisVec,
    value: deg0, resolvedValue: deg0,
    pivot, pivotFrac: parentFracOf(fresh, pivot), pivotVfFrac, timestamp: now,
    refTargetPanelId: targetPanelId,
    refTargetFaceGroupIndex: targetFace.faceGroupIndex,
    refTargetFaceNormal: targetFace.normalWorld,
    refTargetFacePoint: targetFace.pointWorld,
    refArmVertex: armVertex,
    ...(refArmVfFrac ? { refArmVfFrac } : {}),
  };
  return commitSteps(fresh, [...getUnifiedSteps(fresh), step], updateShape);
}

// ── Adım düzenle / sil ──────────────────────────────────────────────────────

export async function updateTransformStep(panelShape: Shape, stepId: string, newValue: number, updateShape: UpdateShape): Promise<boolean> {
  const fresh = freshShape(panelShape);
  return commitSteps(fresh, getUnifiedSteps(fresh).map(s => (s.id === stepId ? { ...s, value: newValue } : s)), updateShape);
}

export async function deleteTransformStep(panelShape: Shape, stepId: string, updateShape: UpdateShape): Promise<boolean> {
  const fresh = freshShape(panelShape);
  return commitSteps(fresh, getUnifiedSteps(fresh).filter(s => s.id !== stepId), updateShape);
}

// ── Store'daki bekleyen REF seçimini onayla (editör "Uygula" + sahnede sağ tık) ──

/** Taşıma-ref: kaynak köşe + hedef panel köşesi seçiliyse bağı kurar. */
export async function confirmPanelMoveRef(): Promise<boolean> {
  const st = useAppStore.getState();
  const ps = st.shapes.find(s => s.id === st.panelMoveTargetPanelId);
  if (!ps || !st.panelMoveRefSourceVertex || !st.panelMoveRefTargetPanelId || !st.panelMoveRefTargetVertex) return false;
  return executePanelMoveRef({
    panelShape: ps, sourceVertex: st.panelMoveRefSourceVertex,
    targetPanelId: st.panelMoveRefTargetPanelId, targetVertex: st.panelMoveRefTargetVertex, updateShape: st.updateShape,
  });
}

/** Dönüş-ref: pivot + nişan + eksen + referans yüz seçiliyse bağı kurar. */
export async function confirmPanelRotateRef(): Promise<boolean> {
  const st = useAppStore.getState();
  const ps = st.shapes.find(s => s.id === st.panelRotateTargetPanelId);
  const face = st.panelRotateRefFace;
  if (!ps || !st.panelRotatePivot || !st.panelRotateRefArmVertex || st.panelRotateAxis === null || !face) return false;
  return executePanelRotateRef({
    panelShape: ps, pivot: st.panelRotatePivot, armVertex: st.panelRotateRefArmVertex, axis: st.panelRotateAxis,
    targetPanelId: face.panelId,
    targetFace: { faceGroupIndex: face.faceGroupIndex, normalWorld: face.normalWorld, pointWorld: face.pointWorld },
    updateShape: st.updateShape,
  });
}
