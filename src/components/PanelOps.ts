import * as THREE from 'three';
import { type RefFacePick, type Shape, requestRebuild, shapeById, useAppStore, vfOfPanel } from '../store';
import {
  type AxisDir, type AxisLetter, type CoplanarFaceGroup, type FaceData, type Vec3, angleToTouchPlane, axisDirToVec, axisIndexOf, axisLetterVec,
  convertReplicadToThreeGeometry, dominantAxisLabel, fmtVec, fracInBox, genId, getFacesAndGroups, getShapeMatrix, initReplicad, isFlatNormal,
  localBboxOf, mapAxisToVfLocal, snapToFlatGroup, vfFracOfPoint, vfRawMinAlong, worldBboxOf,
} from './Geometry';
import { pointInTriangle3D } from './FaceRegion';

// ═══════════════════════════════════════════════════════════════════════════
// PanelOps — PANEL İŞLEM ADIMLARI (taşı / döndür / yüz extrude) + REFERANS YÜZ SEÇİMİ.
// (Eski PanelSteps + FaceExtrudeService + FaceRefPick tek dosyada.)
//
// SÖZLEŞME
//  • Tek gerçek kaynak: panel.parameters.transformSteps (sıralı move|rotate) ve
//    panel.parameters.extrudeSteps. Geometriyi motor (PanelEngine) her rebuild'de
//    sıfırdan üretir; burada yalnız adım yazılır + rebuild tetiklenir.
//  • Adımlar birbirini dinler: dönüşten SONRAKİ taşıma dönmüş eksende ilerler.
//  • Eksen PANEL-YEREL: kullanıcının dünya ekseni panelin VF tabanındaki en
//    yakın eksene eşlenir → dönüş her yüzde "yerinde eğer".
//  • Pivot/nişan çıpaları VF'ye ORANSAL (pivotVfFrac, refArmVfFrac); mutlak pivot yedektir.
//  • REF bağları parametriktir: hedef nokta/yüz her rebuild'de GÜNCEL
//    geometriden yeniden çözülür (value yalnız çözüm başarısızsa yedek).
//  • Extrude: fixed → hedef ölçü (value − mevcut açıklık); dyn → işaretli delta;
//    ref → yüzü referans panelin seçilen DÜZLEMİNE taşıyan işaretli mesafe.
// ═══════════════════════════════════════════════════════════════════════════

type UpdateShape = (id: string, updates: Partial<Shape>) => void;

// ── ADIM TİPLERİ ─────────────────────────────────────────────────────────────

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
  refTargetPanelId?: string;
  refSourceFrac?: Vec3;
  refTargetFrac?: Vec3;
  _refAxisVec?: Vec3;
  _refDist?: number;
}

export interface RotateTransformStep {
  id: string;
  type: 'rotate';
  axis: AxisLetter;
  /** Panel-yerel eksen (VF tabanına eşlenmiş). */
  axisVec?: Vec3;
  /** Derece. REF adımında yalnız yedek; gerçek açı resolvedValue. */
  value: number;
  pivot: Vec3;
  pivotVfFrac?: Vec3;
  timestamp: number;
  // REF DÖNÜŞ: nişan noktası (VF'ye oransal) referans YÜZE değene / oturana kadar döner.
  refTargetPanelId?: string;
  refTargetFaceGroupIndex?: number;
  refTargetFaceNormal?: Vec3;
  refTargetFacePoint?: Vec3;
  refArmVertex?: Vec3;
  refArmVfFrac?: Vec3;
  resolvedValue?: number;
}

export type TransformStep = MoveTransformStep | RotateTransformStep;

export interface ExtrudeStep {
  id: string;
  faceNormal: Vec3;
  faceCenter: Vec3;
  axisLabel: string;
  value: number;
  isFixed: boolean;
  timestamp: number;
  /** Tıklanan yüzde yerel nokta — doğru replicad yüzünü tekil seçer. */
  samplePoint?: Vec3;
  /** Ref modu: referans panel + yüz grubu + dünya normali/noktası. */
  refShapeId?: string;
  refFaceGroupIndex?: number;
  refNormalWorld?: Vec3;
  refPointWorld?: Vec3;
  /** Yalnız rebuild anında (kalıcı değil): referansın çözülen düzlemi. */
  refPlaneCenterLocal?: Vec3;
  refPlaneNormalLocal?: Vec3;
  /** Ref adımının son rebuild'de çözülen işaretli miktarı (UI gösterimi). */
  resolvedValue?: number;
}

// ── ORTAK ────────────────────────────────────────────────────────────────────

/** Panelin güncel store kopyası (komut, bayat prop yerine bunu kullanır). */
const freshShape = (panel: Shape): Shape => shapeById(panel.id) || panel;

/** Parametre yamasını yazar ve panelin parent'ını (işlem gören panel bilgisiyle) yeniden üretir. */
async function commitAndRebuild(panel: Shape, patch: Record<string, unknown>, updateShape: UpdateShape): Promise<boolean> {
  updateShape(panel.id, { parameters: { ...panel.parameters, ...patch } } as any);
  const parentId = (panel.parameters as any)?.parentShapeId as string | undefined;
  if (parentId) await requestRebuild(parentId, { changedPanelId: panel.id, orderChanged: false });
  return true;
}

/** Birleşik dönüşüm adımı listesi (zaman damgası sıralı). */
export function getUnifiedSteps(panel: Shape): TransformStep[] {
  const t: TransformStep[] = Array.isArray(panel.parameters?.transformSteps) ? [...panel.parameters.transformSteps] : [];
  return t.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

const commitSteps = (panel: Shape, steps: TransformStep[], updateShape: UpdateShape) =>
  commitAndRebuild(panel, { transformSteps: steps }, updateShape);

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

/**
 * Adımları position/rotation üzerine sırayla uygular (gizmo/ok gösterimi).
 * Motorla AYNI kural: move o anki dönüş çerçevesinin ekseninde ilerler.
 */
export function applyTransformSteps(basePosition: Vec3, baseRotation: Vec3, steps: TransformStep[]): { position: Vec3; rotation: Vec3 } {
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

// ── TAŞIMA ───────────────────────────────────────────────────────────────────

export interface PanelMoveParams { panelShape: Shape; axis: AxisDir; value: number; updateShape: UpdateShape }

/** DYN taşıma: yüze göre ofset (yüz büyüyünce açıklık oranında ölçeklenir). */
export const executePanelMove = (p: PanelMoveParams) => addMoveStep(p, false);
/** FIXED taşıma: panel parent çerçevesinde MUTLAK konumda kalır. */
export const executePanelMoveFixed = (p: PanelMoveParams) => addMoveStep(p, true);

async function addMoveStep({ panelShape, axis, value, updateShape }: PanelMoveParams, isFixed: boolean): Promise<boolean> {
  if (Math.abs(value) < 0.001) return false;
  const fresh = freshShape(panelShape);
  const steps = getUnifiedSteps(fresh);
  const vf = vfOfPanel(fresh);
  const now = Date.now();
  // DYN ölçek çıpası: VF'nin taşıma ekseni boyunca açıklığı.
  let anchor: MoveTransformStep['anchor'];
  if (vf && vf.vertices.length >= 3) {
    const i = axisIndexOf(axis);
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
    id: `step-${now}`, type: 'move', axis, value, timestamp: now,
    ...(isFixed ? { isFixed: true } : {}), ...(fixedRef !== undefined ? { fixedRef } : {}), ...(anchor ? { anchor } : {}),
  };
  return commitSteps(fresh, [...steps, step], updateShape);
}

/**
 * REF taşıma: panelin seçilen köşesi hedef şeklin köşesine kilitlenir. Köşeler
 * kendi şekillerinin dünya kutusunda ORANSAL saklanır → hedef büyüyüp
 * küçüldükçe bağ geometrik olarak yeniden çözülür.
 */
async function executePanelMoveRef(panelShape: Shape, sourceVertex: Vec3, targetPanelId: string, targetVertex: Vec3, updateShape: UpdateShape): Promise<boolean> {
  const d = new THREE.Vector3(...targetVertex).sub(new THREE.Vector3(...sourceVertex));
  const dist = d.length();
  if (dist < 0.001) return false;
  const axis = dominantAxisLabel(d).toLowerCase() as AxisDir;
  const fresh = freshShape(panelShape);
  const target = shapeById(targetPanelId);
  const srcBox = worldBboxOf(fresh, fresh.geometry);
  const tgtBox = target ? worldBboxOf(target, target.geometry) : null;
  const refSourceFrac = srcBox ? fracInBox(srcBox, sourceVertex) : undefined;
  const refTargetFrac = tgtBox ? fracInBox(tgtBox, targetVertex) : undefined;
  console.log('[YAGO][REF-BAĞ] kaynakFrac=', refSourceFrac, 'hedefFrac=', refTargetFrac, 'hedef=', targetPanelId, 'donmuşDelta=', fmtVec(d));
  const now = Date.now();
  const step: MoveTransformStep = {
    id: `step-${now}`, type: 'move', axis, value: dist, timestamp: now, refTargetPanelId: targetPanelId,
    ...(refSourceFrac ? { refSourceFrac } : {}), ...(refTargetFrac ? { refTargetFrac } : {}),
    _refAxisVec: [d.x / dist, d.y / dist, d.z / dist], _refDist: dist,
  };
  return commitSteps(fresh, [...getUnifiedSteps(fresh), step], updateShape);
}

// ── DÖNDÜRME ─────────────────────────────────────────────────────────────────

export interface PanelRotateParams { panelShape: Shape; axis: AxisLetter; value: number; pivot: Vec3; updateShape: UpdateShape }

/** Sabit açılı dönüş (panel-yerel eksen, VF'ye oransal pivot). */
export async function executePanelRotate({ panelShape, axis, value, pivot, updateShape }: PanelRotateParams): Promise<boolean> {
  if (Math.abs(value) < 0.001) return false;
  const fresh = freshShape(panelShape);
  const vf = vfOfPanel(fresh);
  const now = Date.now();
  const step: RotateTransformStep = {
    id: `step-${now}`, type: 'rotate', axis, axisVec: vf?.normal ? mapAxisToVfLocal(vf, axis) : undefined,
    value, pivot, pivotVfFrac: vf?.normal ? vfFracOfPoint(vf, pivot) : undefined, timestamp: now,
  };
  return commitSteps(fresh, [...getUnifiedSteps(fresh), step], updateShape);
}

/**
 * REF dönüş (Goker akışı): pivot → nişan noktası → eksen → referans YÜZ → sağ tık.
 * Nişan noktası referans yüzün düzlemine değene kadar döner; açı her rebuild'de
 * GÜNCEL geometriden yeniden çözülür (PanelEngine.resolveRefRotateDeg).
 */
async function executePanelRotateRef(panelShape: Shape, pivot: Vec3, armVertex: Vec3, axis: AxisLetter, face: RefFacePick, updateShape: UpdateShape): Promise<boolean> {
  const fresh = freshShape(panelShape);
  const vf = vfOfPanel(fresh);
  const axisVec = mapAxisToVfLocal(vf, axis);
  const axisWorld = axisVec ? new THREE.Vector3(...axisVec) : axisLetterVec(axis);
  // Oluşturma anındaki açı — yalnız çözüm başarısız olursa yedek.
  const sol = angleToTouchPlane(new THREE.Vector3(...pivot), new THREE.Vector3(...armVertex), axisWorld,
    new THREE.Vector3(...face.normalWorld), new THREE.Vector3(...face.pointWorld), 0);
  if (!sol) { console.warn('[YAGO][REF-DÖN] nişan noktası eksen üstünde — açı tanımsız, iptal'); return false; }
  if (!sol.touched) console.warn('[YAGO][REF-DÖN] nişan noktası referans yüze ULAŞAMIYOR — en yakın yaklaşma açısı kullanılıyor:', sol.deg.toFixed(2));
  const deg0 = Math.round(sol.deg * 1000) / 1000;
  const pivotVfFrac = vf ? vfFracOfPoint(vf, pivot) : undefined;
  const refArmVfFrac = vf ? vfFracOfPoint(vf, armVertex) : undefined;
  console.log('[YAGO][REF-DÖN] bağ kuruldu — pivotVfFrac=', pivotVfFrac, 'nişanVfFrac=', refArmVfFrac, 'hedef=', face.panelId,
    'yüzGrubu=', face.faceGroupIndex, 'yüzN=', face.normalWorld.map(n => n.toFixed(2)).join(','), 'eksen=', axis, 'açı0=', deg0.toFixed(2));
  const now = Date.now();
  const step: RotateTransformStep = {
    id: `step-${now}`, type: 'rotate', axis, axisVec, value: deg0, resolvedValue: deg0, pivot, pivotVfFrac, timestamp: now,
    refTargetPanelId: face.panelId, refTargetFaceGroupIndex: face.faceGroupIndex, refTargetFaceNormal: face.normalWorld, refTargetFacePoint: face.pointWorld,
    refArmVertex: armVertex, ...(refArmVfFrac ? { refArmVfFrac } : {}),
  };
  return commitSteps(fresh, [...getUnifiedSteps(fresh), step], updateShape);
}

// ── ADIM DÜZENLE / SİL ───────────────────────────────────────────────────────

export function updateTransformStep(panelShape: Shape, stepId: string, newValue: number, updateShape: UpdateShape): Promise<boolean> {
  const fresh = freshShape(panelShape);
  return commitSteps(fresh, getUnifiedSteps(fresh).map(s => (s.id === stepId ? { ...s, value: newValue } : s)), updateShape);
}

export function deleteTransformStep(panelShape: Shape, stepId: string, updateShape: UpdateShape): Promise<boolean> {
  const fresh = freshShape(panelShape);
  return commitSteps(fresh, getUnifiedSteps(fresh).filter(s => s.id !== stepId), updateShape);
}

export function updateExtrudeStep(panelShape: Shape, stepId: string, newValue: number, updateShape: UpdateShape): Promise<boolean> {
  const steps: ExtrudeStep[] = panelShape.parameters?.extrudeSteps || [];
  return commitAndRebuild(panelShape, { extrudeSteps: steps.map(s => (s.id === stepId ? { ...s, value: newValue } : s)) }, updateShape);
}

export function deleteExtrudeStep(panelShape: Shape, stepId: string, updateShape: UpdateShape): Promise<boolean> {
  const steps: ExtrudeStep[] = panelShape.parameters?.extrudeSteps || [];
  return commitAndRebuild(panelShape, { extrudeSteps: steps.filter(s => s.id !== stepId) }, updateShape);
}

// ── STORE'DAKİ BEKLEYEN REF SEÇİMİNİ ONAYLA (editör "Uygula" + sahnede sağ tık) ──

/** Taşıma-ref: kaynak köşe + hedef panel köşesi seçiliyse bağı kurar. */
export async function confirmPanelMoveRef(): Promise<boolean> {
  const st = useAppStore.getState();
  const ps = shapeById(st.panelMoveTargetPanelId, st.shapes);
  if (!ps || !st.panelMoveRefSourceVertex || !st.panelMoveRefTargetPanelId || !st.panelMoveRefTargetVertex) return false;
  return executePanelMoveRef(ps, st.panelMoveRefSourceVertex, st.panelMoveRefTargetPanelId, st.panelMoveRefTargetVertex, st.updateShape);
}

/** Dönüş-ref: pivot + nişan + eksen + referans yüz seçiliyse bağı kurar. */
export async function confirmPanelRotateRef(): Promise<boolean> {
  const st = useAppStore.getState();
  const ps = shapeById(st.panelRotateTargetPanelId, st.shapes);
  const face = st.panelRotateRefFace;
  if (!ps || !st.panelRotatePivot || !st.panelRotateRefArmVertex || st.panelRotateAxis === null || !face) return false;
  return executePanelRotateRef(ps, st.panelRotatePivot, st.panelRotateRefArmVertex, st.panelRotateAxis, face, st.updateShape);
}

/**
 * Store'daki bekleyen REF extrude seçimini onaylar ve modu kapatır. Editörün
 * "Uygula" düğmesi, panel ve gövde üzerindeki sağ tık — üçü de bunu çağırır.
 */
export async function confirmRefFaceExtrude(): Promise<void> {
  const st = useAppStore.getState();
  const cand = st.faceExtrudeRefCandidate;
  const selFace = st.faceExtrudeSelectedFace;
  const ps = shapeById(st.faceExtrudeTargetPanelId, st.shapes);
  if (!cand || cand.faceGroupIndex < 0 || selFace === null || !ps) return;
  await executeFaceExtrudeToReference(ps, selFace, cand, st.faceExtrudeClickPoint ?? undefined, st.updateShape);
  st.setFaceExtrudeSelectedFace(null);
  st.setFaceExtrudeMode(false);
  st.setFaceExtrudeRefCandidate(null);
}

// ═══════════════════════════════════════════════════════════════════════════
// YÜZ EXTRUDE
// ═══════════════════════════════════════════════════════════════════════════

/** Baskın eksen ('x' | 'y' | 'z'), dominantAxisLabel ile aynı eşitlik kuralı. */
const dominantAxis = (n: THREE.Vector3): AxisLetter => dominantAxisLabel(n)[0].toLowerCase() as AxisLetter;

// ── REFERANS YÜZ EŞLEME (extrude-ref + ref-dönüş ortak) ─────────────────────

/**
 * Referans panelin GÜNCEL geometrisinde tıklanan yüz grubunu bulur: normal
 * (>0.8) + tıklama noktasına en yakın merkez; nokta/normal yoksa saklı indeks.
 * Referans taşınmış/boyutlanmış olsa da her rebuild'de doğru grup bulunur.
 */
export function matchReferenceFace(
  ref: Shape | undefined, refFaceGroupIndex: number, refNormalWorld?: Vec3, refPointWorld?: Vec3
): { group: CoplanarFaceGroup; faces: FaceData[]; matrix: THREE.Matrix4 } | null {
  if (!ref?.geometry) return null;
  const { faces, groups } = getFacesAndGroups(ref.geometry);
  let group = groups[refFaceGroupIndex];
  const matrix = getShapeMatrix(ref);
  if (refNormalWorld && refPointWorld) {
    // Nokta için TERS matris (klon), normal için orijinal matris.
    const localPoint = new THREE.Vector3(...refPointWorld).applyMatrix4(matrix.clone().invert());
    const targetNormal = new THREE.Vector3(...refNormalWorld).transformDirection(matrix);
    const matched = groups
      .filter(g => g.normal.clone().normalize().dot(targetNormal) > 0.8)
      .sort((a, b) => a.center.distanceTo(localPoint) - b.center.distanceTo(localPoint))[0];
    if (matched) group = matched;
  }
  return group ? { group, faces, matrix } : null;
}

/** Referans yüzünün güncel DÜZLEMİ (merkez + normal), referansın yerel çerçevesinde. */
export function resolveReferenceFacePlane(
  refShapeId: string, refFaceGroupIndex: number, shapes: Shape[], refNormalWorld?: Vec3, refPointWorld?: Vec3
): { center: THREE.Vector3; normal: THREE.Vector3 } | null {
  const m = matchReferenceFace(shapeById(refShapeId, shapes), refFaceGroupIndex, refNormalWorld, refPointWorld);
  return m ? { center: m.group.center.clone(), normal: m.group.normal.clone().normalize() } : null;
}

/** Aynı eksendeki adımlardan yüz merkezine en yakını (editör ön-doldurma). */
export function findExistingStepForFace(steps: ExtrudeStep[], faceNormal: THREE.Vector3, faceCenter?: THREE.Vector3): ExtrudeStep | null {
  const candidates = steps.filter(s => s.axisLabel === dominantAxisLabel(faceNormal));
  if (candidates.length === 0) return null;
  if (candidates.length === 1 || !faceCenter) return candidates[0];
  let best: ExtrudeStep | null = null, bestDist = Infinity;
  for (const s of candidates) {
    const d = new THREE.Vector3(...s.faceCenter).distanceTo(faceCenter);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return best;
}

// ── GEOMETRİ ─────────────────────────────────────────────────────────────────

/** Adımın yüzüne karşılık gelen replicad yüzü (eksen etiketi + tıklama noktası/merkez). */
function findMatchingReplicadFace(replicadShape: any, targetNormal: THREE.Vector3, targetCenter: THREE.Vector3, samplePoint?: THREE.Vector3): any | null {
  const faces = replicadShape.faces;
  if (!faces || faces.length === 0) return null;
  const targetLabel = dominantAxisLabel(targetNormal);
  const candidates: Array<{ face: any; dot: number; dist: number; minPtDist: number }> = [];
  for (const face of faces) {
    try {
      const nv = face.normalAt(0.5, 0.5);
      const faceNormal = new THREE.Vector3(nv.x, nv.y, nv.z);
      if (dominantAxisLabel(faceNormal) !== targetLabel) continue;
      const dot = faceNormal.dot(targetNormal);
      if (dot < 0.5) continue;
      let center = new THREE.Vector3();
      let minPtDist = Infinity;
      try {
        const fm = face.mesh({ tolerance: 1.0, angularTolerance: 15 });
        if (fm.vertices && fm.vertices.length >= 3) {
          let sx = 0, sy = 0, sz = 0;
          const n = fm.vertices.length / 3;
          for (let j = 0; j < fm.vertices.length; j += 3) {
            sx += fm.vertices[j]; sy += fm.vertices[j + 1]; sz += fm.vertices[j + 2];
            if (samplePoint) minPtDist = Math.min(minPtDist, Math.hypot(fm.vertices[j] - samplePoint.x, fm.vertices[j + 1] - samplePoint.y, fm.vertices[j + 2] - samplePoint.z));
          }
          center = new THREE.Vector3(sx / n, sy / n, sz / n);
        }
      } catch { candidates.push({ face, dot, dist: Infinity, minPtDist: Infinity }); continue; }
      candidates.push({ face, dot, dist: center.distanceTo(targetCenter), minPtDist });
    } catch { continue; }
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].face;
  // Tıklama noktası varsa: tessellation'ı o noktaya EN YAKIN yüz (iç yuva duvarları uzak kalır).
  if (samplePoint) candidates.sort((a, b) => a.minPtDist - b.minPtDist || b.dot - a.dot);
  else candidates.sort((a, b) => a.dist - b.dist || b.dot - a.dot);
  return candidates[0].face;
}

async function applyOneExtrudeStep(currentShape: any, step: ExtrudeStep, geometry: THREE.BufferGeometry): Promise<{ replicadShape: any; geometry: THREE.BufferGeometry; amount: number } | null> {
  const oc = await initReplicad();
  const { groups } = getFacesAndGroups(geometry);
  const stepNormal = new THREE.Vector3(...step.faceNormal);

  // Önce düz (eksen-hizalı) gruplar; yoksa eğri normal saklı eski adımlar için gevşek eşleşme.
  const flatAligned = groups.filter(g => { const n = g.normal.clone().normalize(); return isFlatNormal(n) && dominantAxisLabel(n) === step.axisLabel; });
  const aligned = flatAligned.length > 0 ? flatAligned : groups.filter(g => { const n = g.normal.clone().normalize(); return dominantAxisLabel(n) === step.axisLabel && n.dot(stepNormal) > 0.5; });
  if (aligned.length === 0) {
    console.warn(`[applyOneExtrudeStep] No aligned face group for axis ${step.axisLabel}. Groups:`, groups.map(g => dominantAxisLabel(g.normal.clone().normalize())));
    return null;
  }

  const box = localBboxOf(geometry)!;
  const stepCenter = new THREE.Vector3(...step.faceCenter);
  const stepNorm = stepNormal.clone().normalize();

  // Adım yüzü kutu sınırındaysa (dış yüz niyeti) sınırda olmayan iç yuva yüzleri cezalandırılır.
  const axisKey = dominantAxis(stepNorm);
  const expectedBoundary = stepNorm[axisKey] > 0 ? box.max[axisKey] : box.min[axisKey];
  const BOUNDARY_TOL = 5.0;
  const stepNearBoundary = Math.abs(stepCenter[axisKey] - expectedBoundary) < BOUNDARY_TOL;
  let bestGroup = aligned[0];
  if (aligned.length > 1) {
    let bestScore = Infinity;
    for (const g of aligned) {
      const penalty = stepNearBoundary && Math.abs(g.center[axisKey] - expectedBoundary) > BOUNDARY_TOL ? 10000 : 0;
      const score = g.center.distanceTo(stepCenter) + penalty;
      if (score < bestScore) { bestScore = score; bestGroup = g; }
    }
  }
  const faceNormal = bestGroup.normal.clone().normalize();
  const faceCenter = bestGroup.center.clone();

  let extrudeAmount: number;
  if (step.refPlaneCenterLocal) {
    // REF: yüzü SEÇİLEN referans düzlemine taşıyan işaretli mesafe (+ uzar, − kısalır).
    const refC = new THREE.Vector3(...step.refPlaneCenterLocal);
    if (step.refPlaneNormalLocal) {
      const par = Math.abs(new THREE.Vector3(...step.refPlaneNormalLocal).normalize().dot(faceNormal));
      if (par < 0.7) { console.warn(`[applyOneExtrudeStep] Ref yüzü extrude eksenine paralel değil (|dot|=${par.toFixed(2)}) — adım atlandı`); return null; }
    }
    extrudeAmount = refC.clone().sub(faceCenter).dot(faceNormal);
    console.log(`[YAGO][EXTRUDE-REF] hedefDüzlem= ${fmtVec(refC)} yüzMerkez= ${fmtVec(faceCenter)} normal= ${fmtVec(faceNormal, 0)} miktar= ${extrudeAmount.toFixed(1)}`);
  } else if (step.isFixed) {
    // FIXED: hedef ölçü − seçili yüzden karşı kutu sınırına mevcut açıklık.
    const k = dominantAxis(faceNormal);
    const faceDist = faceNormal[k] > 0 ? faceCenter[k] - box.min[k] : box.max[k] - faceCenter[k];
    extrudeAmount = step.value - faceDist;
  } else {
    extrudeAmount = step.value;
  }
  if (Math.abs(extrudeAmount) < 0.01) { console.warn(`[applyOneExtrudeStep] Extrude amount too small: ${extrudeAmount} for step ${step.axisLabel}`); return null; }

  const samplePt = step.samplePoint ? new THREE.Vector3(...step.samplePoint) : undefined;
  const matchingFace = findMatchingReplicadFace(currentShape, faceNormal, faceCenter, samplePt);
  if (!matchingFace) { console.warn(`[applyOneExtrudeStep] No matching replicad face for normal ${faceNormal.toArray()} center ${faceCenter.toArray()}`); return null; }
  const ocVec = new oc.gp_Vec_4(faceNormal.x * extrudeAmount, faceNormal.y * extrudeAmount, faceNormal.z * extrudeAmount);
  const prismBuilder = new oc.BRepPrimAPI_MakePrism_1(matchingFace.wrapped, ocVec, false, true);
  prismBuilder.Build(new oc.Message_ProgressRange_1());
  const { cast } = await import('replicad');
  const extrudedShape = cast(prismBuilder.Shape());
  const finalShape = extrudeAmount > 0 ? currentShape.fuse(extrudedShape) : currentShape.cut(extrudedShape);
  return { replicadShape: finalShape, geometry: convertReplicadToThreeGeometry(finalShape), amount: extrudeAmount };
}

/**
 * Extrude adımlarını, çağıranın DOĞRU ÇERÇEVEDE verdiği katıya sırayla uygular
 * (panel VF'den üretilmiş + dönüşümler işlenmiş). Ref adımlarının çözülen
 * miktarları `resolved` ile döner (motor UI için adıma yazar).
 */
export async function applyExtrudeSteps(
  shape: any, steps: ExtrudeStep[], shapes?: Shape[]
): Promise<{ shape: any; geometry: THREE.BufferGeometry; resolved: Array<{ id: string; value: number }> } | null> {
  if (!steps || steps.length === 0) return null;
  let currentReplicad = shape;
  let currentGeometry = convertReplicadToThreeGeometry(currentReplicad);
  let anyApplied = false;
  const resolved: Array<{ id: string; value: number }> = [];
  for (const step of steps) {
    let effectiveStep = step;
    if (step.refShapeId && shapes) {
      const plane = resolveReferenceFacePlane(step.refShapeId, step.refFaceGroupIndex ?? -1, shapes, step.refNormalWorld, step.refPointWorld);
      if (!plane) {
        // Referans silinmiş/çözülemiyor → adım HİÇ uygulanmaz (yanlışlıkla tam kesim olmasın).
        console.warn(`[YAGO][EXTRUDE-REF] Referans düzlemi çözülemedi: ${step.refShapeId} — adım atlandı`);
        continue;
      }
      effectiveStep = { ...step, refPlaneCenterLocal: [plane.center.x, plane.center.y, plane.center.z], refPlaneNormalLocal: [plane.normal.x, plane.normal.y, plane.normal.z] };
    }
    const result = await applyOneExtrudeStep(currentReplicad, effectiveStep, currentGeometry);
    if (result) {
      currentReplicad = result.replicadShape;
      currentGeometry = result.geometry;
      anyApplied = true;
      if (step.refShapeId) resolved.push({ id: step.id, value: Math.round(result.amount * 10) / 10 });
    } else console.warn(`[YAGO][EXTRUDE] Adım uygulanamadı: ${step.axisLabel} (id=${step.id})`);
  }
  return anyApplied ? { shape: currentReplicad, geometry: currentGeometry, resolved } : null;
}

// ── KOMUTLAR: SPEC'i (extrudeSteps) günceller + rebuild ──────────────────────

/** Tıklanan yüz grubu (parent-yerel); eğri (fillet) grup en yakın aynı eksenli düz yüze yaslanır. */
function resolveClickedFace(panel: Shape, faceGroupIndex: number): { faceNormal: THREE.Vector3; faceCenter: THREE.Vector3 } | null {
  if (!panel.geometry) return null;
  const { groups } = getFacesAndGroups(panel.geometry);
  if (faceGroupIndex < 0 || faceGroupIndex >= groups.length) return null;
  const raw = groups[faceGroupIndex];
  let faceNormal = raw.normal.clone().normalize();
  let faceCenter = raw.center.clone();
  if (!isFlatNormal(faceNormal)) {
    const axLbl = dominantAxisLabel(faceNormal);
    const candidate = groups
      .filter(g => { const n = g.normal.clone().normalize(); return isFlatNormal(n) && dominantAxisLabel(n) === axLbl; })
      .sort((a, b) => a.center.distanceTo(raw.center) - b.center.distanceTo(raw.center))[0];
    if (candidate) { faceNormal = candidate.normal.clone().normalize(); faceCenter = candidate.center.clone(); }
  }
  return { faceNormal, faceCenter };
}

/** Yeni adımı ekler ya da aynı yüzdeki (aynı eksen + merkez < 1 mm) adımın yerine koyar. */
function upsertExtrudeStep(steps: ExtrudeStep[], step: ExtrudeStep): { steps: ExtrudeStep[]; existed: boolean } {
  const idx = steps.findIndex(s => s.axisLabel === step.axisLabel && new THREE.Vector3(...s.faceCenter).distanceTo(new THREE.Vector3(...step.faceCenter)) < 1.0);
  return { steps: idx >= 0 ? steps.map((s, i) => (i === idx ? step : s)) : [...steps, step], existed: idx >= 0 };
}

export interface FaceExtrudeParams {
  panelShape: Shape; faceGroupIndex: number; value: number; isFixed: boolean; updateShape: UpdateShape;
  /** Tıklama noktası (yerel) — replicad yüzünü tekil seçer. */
  clickPoint?: Vec3;
}

export async function executeFaceExtrude({ panelShape: panel, faceGroupIndex, value, isFixed, updateShape, clickPoint }: FaceExtrudeParams): Promise<boolean> {
  const face = resolveClickedFace(panel, faceGroupIndex);
  if (!face) return false;
  const existing: ExtrudeStep[] = panel.parameters?.extrudeSteps || [];
  const up = upsertExtrudeStep(existing, {
    id: genId('ext'), faceNormal: [face.faceNormal.x, face.faceNormal.y, face.faceNormal.z], faceCenter: [face.faceCenter.x, face.faceCenter.y, face.faceCenter.z],
    axisLabel: dominantAxisLabel(face.faceNormal), value, isFixed, timestamp: Date.now(), samplePoint: clickPoint,
  });
  // Dinamik modda değer=delta; ~0 ve yeni adımsa işlem yok.
  if (!isFixed && Math.abs(value) < 0.01 && !up.existed) return false;
  return commitAndRebuild(panel, { extrudeSteps: up.steps }, updateShape);
}

/** Ref extrude: değer rebuild'de referansın güncel düzleminden çözülür (value=0 işaretçi). */
async function executeFaceExtrudeToReference(panel: Shape, faceGroupIndex: number, ref: RefFacePick, clickPoint: Vec3 | undefined, updateShape: UpdateShape): Promise<boolean> {
  const face = resolveClickedFace(panel, faceGroupIndex);
  if (!face) return false;
  const existing: ExtrudeStep[] = panel.parameters?.extrudeSteps || [];
  const up = upsertExtrudeStep(existing, {
    id: genId('ext'), faceNormal: [face.faceNormal.x, face.faceNormal.y, face.faceNormal.z], faceCenter: [face.faceCenter.x, face.faceCenter.y, face.faceCenter.z],
    axisLabel: dominantAxisLabel(face.faceNormal), value: 0, isFixed: true, timestamp: Date.now(), samplePoint: clickPoint,
    refShapeId: ref.panelId, refFaceGroupIndex: ref.faceGroupIndex, refNormalWorld: ref.normalWorld, refPointWorld: ref.pointWorld,
  });
  return commitAndRebuild(panel, { extrudeSteps: up.steps }, updateShape);
}

// ═══════════════════════════════════════════════════════════════════════════
// REFERANS YÜZ SEÇİMİ: IŞIN BOYUNCA DERİNLİK DÖNGÜSÜ
// Panel yerleştirirkenki "aynı noktaya her tıklamada bir arkadaki yüze geç"
// davranışının panel-extrude / dönüş REFERANS seçimine taşınmış hâli; adaylar
// imlecin altındaki ışının deldiği TÜM şekillere (parent küp + paneller) yayılır.
// TEK KAYNAK: PanelDrawing ve ShapeWithTransform aynı fonksiyonu çağırır;
// döngü durumu modül düzeyinde tutulur (aynı anda tek referans seçimi olur).
// ═══════════════════════════════════════════════════════════════════════════

// REFERANS MODU RENK PALETİ (Goker): tüm seçim vurguları soft sarı; hover = aday, selected = onaylı.
export const REF_COLORS = {
  hover: 0xf2d57e, selected: 0xdfae4c, hoverCss: '#f2d57e', selectedCss: '#dfae4c', hoverOpacity: 0.42, selectedOpacity: 0.68,
} as const;

interface RefFaceCandidate { shapeId: string; faceGroupIndex: number; depth: number; pointWorld: Vec3; normalWorld: Vec3 }

/**
 * Işının deldiği tüm yüz gruplarını (hedef panel hariç) derinliğe göre sıralı
 * döndürür. Her aday DÜZ (snap edilmiş) gruba indirgenir; aynı şekilde aynı düz
 * gruba düşen kopyalar (en yakın derinlik tutularak) elenir.
 */
function gatherRefFaceCandidates(rayOrigin: THREE.Vector3, rayDir: THREE.Vector3, shapes: any[], targetPanelId: string | null): RefFaceCandidate[] {
  const dir = rayDir.clone().normalize();
  const out: RefFaceCandidate[] = [];
  for (const s of shapes) {
    if (!s?.geometry || s.id === targetPanelId) continue;
    const M = getShapeMatrix(s);
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(M);
    const { faces, groups } = getFacesAndGroups(s.geometry);
    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      const nWorld = group.normal.clone().normalize().applyMatrix3(normalMatrix).normalize();
      const denom = nWorld.dot(dir);
      if (Math.abs(denom) < 1e-6) continue;
      const planePt = group.center.clone().applyMatrix4(M);
      const t = planePt.clone().sub(rayOrigin).dot(nWorld) / denom;
      if (t < 0) continue;
      const hit = rayOrigin.clone().addScaledVector(dir, t);
      // Bu grubun üçgenlerinden biri, çarpma noktasını gerçekten içeriyor mu?
      const inside = group.faceIndices.some(fi => {
        const f = faces[fi];
        return !!f && pointInTriangle3D(hit, f.vertices[0].clone().applyMatrix4(M), f.vertices[1].clone().applyMatrix4(M), f.vertices[2].clone().applyMatrix4(M));
      });
      if (!inside) continue;
      const snapped = snapToFlatGroup(gi, groups);
      const sNormalWorld = (groups[snapped] || group).normal.clone().normalize().applyMatrix3(normalMatrix).normalize();
      out.push({ shapeId: s.id, faceGroupIndex: snapped, depth: t, pointWorld: [hit.x, hit.y, hit.z], normalWorld: [sNormalWorld.x, sNormalWorld.y, sNormalWorld.z] });
    }
  }
  out.sort((a, b) => a.depth - b.depth);
  const seen = new Set<string>();
  return out.filter(c => { const k = `${c.shapeId}#${c.faceGroupIndex}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// Döngü durumu: son ekran noktası + sıra indeksi + bağlam anahtarı.
let lastPick: { x: number; y: number; index: number; ctx: string } | null = null;
const SAME_SPOT_PX = 6;

export function resetRefFacePick() { lastPick = null; }

/**
 * R3F tıklama olayından: ışın + ekran koordinatı ile adayları toplar, aynı
 * noktada arka arkaya tıklamada bir sonraki derinliğe geçer, seçilen adayı
 * setCandidate'e yazar. Aday bulunduysa true döner.
 */
export function cycleRefFacePickFromEvent(e: any, shapes: any[], targetPanelId: string | null, setCandidate: (v: RefFacePick) => void): boolean {
  const ray: THREE.Ray | undefined = e?.ray;
  if (!ray) return false;
  const cands = gatherRefFaceCandidates(ray.origin.clone(), ray.direction.clone(), shapes, targetPanelId);
  if (cands.length === 0) return false;
  const sx = e?.nativeEvent?.clientX ?? 0, sy = e?.nativeEvent?.clientY ?? 0;
  const ctx = String(targetPanelId ?? '');
  const sameSpot = !!lastPick && lastPick.ctx === ctx && Math.hypot(sx - lastPick.x, sy - lastPick.y) < SAME_SPOT_PX;
  const index = sameSpot ? (lastPick!.index + 1) % cands.length : 0;
  lastPick = { x: sx, y: sy, index, ctx };
  const c = cands[index];
  setCandidate({ panelId: c.shapeId, faceGroupIndex: c.faceGroupIndex, normalWorld: c.normalWorld, pointWorld: c.pointWorld });
  return true;
}
