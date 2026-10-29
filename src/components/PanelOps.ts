import * as THREE from 'three';
import { type RefFacePick, type Shape, requestRebuild, shapeById, useAppStore, vfOfPanel } from '../store';
import {
  type AxisDir, type AxisLetter, type CoplanarFaceGroup, type FaceData, type Vec3, angleToTouchPlane, axisDirToVec, axisIndexOf, axisLetterVec,
  convertReplicadToThreeGeometry, dominantAxisLabel, fracInBox, genId, getFacesAndGroups, getShapeMatrix, halfSpaceSlab, initReplicad, isFlatNormal,
  localBboxOf, mapAxisToVfLocal, round1, round3, snapToFlatGroup, spanAlong, vec3, vfFracOfPoint, vfRawMinAlong, worldBboxOf,
} from './Geometry';
import { pointInTriangle3D } from './FaceRegion';

// Panel işlem adımları (taşı / döndür / yüz extrude) + referans yüz seçimi.
// Tek gerçek kaynak: parameters.transformSteps (sıralı move|rotate) + extrudeSteps; geometriyi PanelEngine
// her rebuild'de sıfırdan üretir — burada yalnız adım yazılır + rebuild tetiklenir. Eksen PANEL-YEREL (VF tabanı),
// pivot/nişan VF'ye ORANSAL; REF bağları her rebuild'de GÜNCEL geometriden çözülür (value yalnız yedek).

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
  fixedRef?: number;
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
  axisVec?: Vec3;
  /** Derece. REF adımında yalnız yedek; gerçek açı resolvedValue. */
  value: number;
  pivot: Vec3;
  pivotVfFrac?: Vec3;
  timestamp: number;
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
  samplePoint?: Vec3;
  refShapeId?: string;
  refFaceGroupIndex?: number;
  refNormalWorld?: Vec3;
  refPointWorld?: Vec3;
  /** Yalnız rebuild anında (kalıcı değil): referansın çözülen düzlemi. */
  refPlaneCenterLocal?: Vec3;
  refPlaneNormalLocal?: Vec3;
  resolvedValue?: number;
  /** OK modu adımı: her rebuild'de bu eksen yönündeki EN DIŞ yüze uygulanır (aynı ok tekrar tıklanınca değer toplanır). */
  outer?: boolean;
}

/** Panelin güncel store kopyası (komut, bayat prop yerine bunu kullanır). */
const freshShape = (panel: Shape): Shape => shapeById(panel.id) || panel;

async function commitAndRebuild(panel: Shape, patch: Record<string, unknown>, updateShape: UpdateShape): Promise<boolean> {
  updateShape(panel.id, { parameters: { ...panel.parameters, ...patch } } as any);
  const parentId = (panel.parameters as any)?.parentShapeId as string | undefined;
  if (parentId) await requestRebuild(parentId, { changedPanelId: panel.id, orderChanged: false });
  return true;
}

export function getUnifiedSteps(panel: Shape): TransformStep[] {
  const t: TransformStep[] = Array.isArray(panel.parameters?.transformSteps) ? [...panel.parameters.transformSteps] : [];
  return t.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

const commitSteps = (panel: Shape, steps: TransformStep[], updateShape: UpdateShape) =>
  commitAndRebuild(panel, { transformSteps: steps }, updateShape);
/** Adımı sıralı listenin sonuna ekler ve rebuild tetikler. */
const appendStep = (panel: Shape, step: TransformStep, updateShape: UpdateShape) =>
  commitSteps(panel, [...getUnifiedSteps(panel), step], updateShape);

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

// Motorla AYNI kural: move o anki dönüş çerçevesinin ekseninde ilerler.
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
  return { position: vec3(pos), rotation: vec3(new THREE.Euler().setFromQuaternion(quat, 'XYZ')) };
}

export interface PanelMoveParams { panelShape: Shape; axis: AxisDir; value: number; updateShape: UpdateShape }

/** DYN: yüze göre ofset, yüz büyüyünce açıklık oranında ölçeklenir. FIXED: parent çerçevesinde MUTLAK konum. */
export const executePanelMove = (p: PanelMoveParams) => addMoveStep(p, false);
export const executePanelMoveFixed = (p: PanelMoveParams) => addMoveStep(p, true);

async function addMoveStep({ panelShape, axis, value, updateShape }: PanelMoveParams, isFixed: boolean): Promise<boolean> {
  if (Math.abs(value) < 0.001) return false;
  const fresh = freshShape(panelShape);
  const steps = getUnifiedSteps(fresh);
  const vf = vfOfPanel(fresh);
  const now = Date.now();
  let anchor: MoveTransformStep['anchor'];
  if (vf && vf.vertices.length >= 3) {
    const span = spanAlong(vf.vertices, axisIndexOf(axis));
    if (span >= 1) anchor = { faceSpanAlongAxis: span };
  }
  // FIXED çıpası yalnız henüz dönüş adımı yoksa (ham konum dönmemiş çerçevede geçerli).
  let fixedRef: number | undefined;
  if (isFixed && vf && !steps.some(s => s.type === 'rotate')) {
    const r = vfRawMinAlong(vf, axis);
    if (r !== null) fixedRef = r;
  }
  const step: MoveTransformStep = {
    id: `step-${now}`, type: 'move', axis, value, timestamp: now,
    ...(isFixed ? { isFixed: true } : {}), ...(fixedRef !== undefined ? { fixedRef } : {}), ...(anchor ? { anchor } : {}),
  };
  return commitSteps(fresh, [...steps, step], updateShape);
}

/** REF taşıma: köşeler şekillerinin dünya kutusunda ORANSAL saklanır → hedef boyutlanınca bağ yeniden çözülür. */
async function executePanelMoveRef(
  panelShape: Shape, sourceVertex: Vec3, targetPanelId: string, targetVertex: Vec3, updateShape: UpdateShape,
): Promise<boolean> {
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
  const now = Date.now();
  const step: MoveTransformStep = {
    id: `step-${now}`, type: 'move', axis, value: dist, timestamp: now, refTargetPanelId: targetPanelId,
    ...(refSourceFrac ? { refSourceFrac } : {}), ...(refTargetFrac ? { refTargetFrac } : {}),
    _refAxisVec: [d.x / dist, d.y / dist, d.z / dist], _refDist: dist,
  };
  return appendStep(fresh, step, updateShape);
}

export interface PanelRotateParams { panelShape: Shape; axis: AxisLetter; value: number; pivot: Vec3; updateShape: UpdateShape }

export async function executePanelRotate({ panelShape, axis, value, pivot, updateShape }: PanelRotateParams): Promise<boolean> {
  if (Math.abs(value) < 0.001) return false;
  const fresh = freshShape(panelShape);
  const vf = vfOfPanel(fresh);
  const now = Date.now();
  const step: RotateTransformStep = {
    id: `step-${now}`, type: 'rotate', axis, axisVec: vf?.normal ? mapAxisToVfLocal(vf, axis) : undefined,
    value, pivot, pivotVfFrac: vf?.normal ? vfFracOfPoint(vf, pivot) : undefined, timestamp: now,
  };
  return appendStep(fresh, step, updateShape);
}

/** REF dönüş: nişan noktası referans yüzün düzlemine değene kadar döner; açı her rebuild'de
 * yeniden çözülür (PanelEngine.resolveRefRotateDeg). */
async function executePanelRotateRef(
  panelShape: Shape, pivot: Vec3, armVertex: Vec3, axis: AxisLetter, face: RefFacePick, updateShape: UpdateShape,
): Promise<boolean> {
  const fresh = freshShape(panelShape);
  const vf = vfOfPanel(fresh);
  const axisVec = mapAxisToVfLocal(vf, axis);
  const axisWorld = axisVec ? new THREE.Vector3(...axisVec) : axisLetterVec(axis);
  // Oluşturma anındaki açı — yalnız çözüm başarısız olursa yedek; yüze ulaşılamıyorsa en yakın yaklaşma açısı.
  const sol = angleToTouchPlane(new THREE.Vector3(...pivot), new THREE.Vector3(...armVertex), axisWorld,
    new THREE.Vector3(...face.normalWorld), new THREE.Vector3(...face.pointWorld), 0);
  if (!sol) return false;   // nişan noktası eksen üstünde — açı tanımsız
  const deg0 = round3(sol.deg);
  const pivotVfFrac = vf ? vfFracOfPoint(vf, pivot) : undefined;
  const refArmVfFrac = vf ? vfFracOfPoint(vf, armVertex) : undefined;
  const now = Date.now();
  const step: RotateTransformStep = {
    id: `step-${now}`, type: 'rotate', axis, axisVec, value: deg0, resolvedValue: deg0, pivot, pivotVfFrac, timestamp: now,
    refTargetPanelId: face.panelId, refTargetFaceGroupIndex: face.faceGroupIndex, refTargetFaceNormal: face.normalWorld, refTargetFacePoint: face.pointWorld,
    refArmVertex: armVertex, ...(refArmVfFrac ? { refArmVfFrac } : {}),
  };
  return appendStep(fresh, step, updateShape);
}

export function updateTransformStep(panelShape: Shape, stepId: string, newValue: number, updateShape: UpdateShape): Promise<boolean> {
  const fresh = freshShape(panelShape);
  return commitSteps(fresh, getUnifiedSteps(fresh).map(s => (s.id === stepId ? { ...s, value: newValue } : s)), updateShape);
}

export function deleteTransformStep(panelShape: Shape, stepId: string, updateShape: UpdateShape): Promise<boolean> {
  const fresh = freshShape(panelShape);
  return commitSteps(fresh, getUnifiedSteps(fresh).filter(s => s.id !== stepId), updateShape);
}

const extrudeStepsOf = (panel: Shape): ExtrudeStep[] => panel.parameters?.extrudeSteps || [];

export function updateExtrudeStep(panelShape: Shape, stepId: string, newValue: number, updateShape: UpdateShape): Promise<boolean> {
  const steps = extrudeStepsOf(panelShape).map(s => (s.id === stepId ? { ...s, value: newValue } : s));
  return commitAndRebuild(panelShape, { extrudeSteps: steps }, updateShape);
}

export function deleteExtrudeStep(panelShape: Shape, stepId: string, updateShape: UpdateShape): Promise<boolean> {
  return commitAndRebuild(panelShape, { extrudeSteps: extrudeStepsOf(panelShape).filter(s => s.id !== stepId) }, updateShape);
}

export async function confirmPanelMoveRef(): Promise<boolean> {
  const st = useAppStore.getState();
  const ps = shapeById(st.panelMoveTargetPanelId, st.shapes);
  if (!ps || !st.panelMoveRefSourceVertex || !st.panelMoveRefTargetPanelId || !st.panelMoveRefTargetVertex) return false;
  return executePanelMoveRef(ps, st.panelMoveRefSourceVertex, st.panelMoveRefTargetPanelId, st.panelMoveRefTargetVertex, st.updateShape);
}

export async function confirmPanelRotateRef(): Promise<boolean> {
  const st = useAppStore.getState();
  const ps = shapeById(st.panelRotateTargetPanelId, st.shapes);
  const face = st.panelRotateRefFace;
  if (!ps || !st.panelRotatePivot || !st.panelRotateRefArmVertex || st.panelRotateAxis === null || !face) return false;
  return executePanelRotateRef(ps, st.panelRotatePivot, st.panelRotateRefArmVertex, st.panelRotateAxis, face, st.updateShape);
}

/** Editörün "Uygula" düğmesi ve panel/gövde sağ tıkı — üçü de bunu çağırır. */
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

const dominantAxis = (n: THREE.Vector3): AxisLetter => dominantAxisLabel(n)[0].toLowerCase() as AxisLetter;

/** Referans yüz grubunu GÜNCEL geometride bulur: normal (>0.8) + tıklama noktasına en yakın merkez;
 * nokta/normal yoksa saklı indeks. Referans taşınmış/boyutlanmış olsa da doğru grup bulunur. */
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

export function resolveReferenceFacePlane(
  refShapeId: string, refFaceGroupIndex: number, shapes: Shape[], refNormalWorld?: Vec3, refPointWorld?: Vec3
): { center: THREE.Vector3; normal: THREE.Vector3 } | null {
  const m = matchReferenceFace(shapeById(refShapeId, shapes), refFaceGroupIndex, refNormalWorld, refPointWorld);
  return m ? { center: m.group.center.clone(), normal: m.group.normal.clone().normalize() } : null;
}

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

function findMatchingReplicadFace(
  replicadShape: any, targetNormal: THREE.Vector3, targetCenter: THREE.Vector3, samplePoint?: THREE.Vector3,
): any | null {
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
            const x = fm.vertices[j], y = fm.vertices[j + 1], z = fm.vertices[j + 2];
            sx += x; sy += y; sz += z;
            if (samplePoint) minPtDist = Math.min(minPtDist, Math.hypot(x - samplePoint.x, y - samplePoint.y, z - samplePoint.z));
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

type ExtrudeResult = { replicadShape: any; geometry: THREE.BufferGeometry; amount: number };
/** Adım uygulanabilir ama miktar ≈ 0 (ör. referans düzlemi yüzle çakışık): katı değişmez, çözülen değer yine kaydedilir. */
type ExtrudeNoop = { noop: true; amount: number };

async function applyOneExtrudeStep(currentShape: any, step: ExtrudeStep, geometry: THREE.BufferGeometry): Promise<ExtrudeResult | ExtrudeNoop | null> {
  const oc = await initReplicad();
  const { faces, groups } = getFacesAndGroups(geometry);
  const stepNormal = new THREE.Vector3(...step.faceNormal);

  // Önce düz (eksen-hizalı) gruplar; yoksa eğri normal saklı eski adımlar için gevşek eşleşme.
  const onAxis = (pred: (n: THREE.Vector3) => boolean) =>
    groups.filter(g => { const n = g.normal.clone().normalize(); return dominantAxisLabel(n) === step.axisLabel && pred(n); });
  const flatAligned = onAxis(n => isFlatNormal(n));
  const aligned = flatAligned.length > 0 ? flatAligned : onAxis(n => n.dot(stepNormal) > 0.5);
  if (aligned.length === 0) return null;

  const box = localBboxOf(geometry)!;
  const stepCenter = new THREE.Vector3(...step.faceCenter);
  const stepNorm = stepNormal.clone().normalize();

  // Adım yüzü kutu sınırındaysa (dış yüz niyeti) sınırda olmayan iç yuva yüzleri cezalandırılır.
  const axisKey = dominantAxis(stepNorm);
  const expectedBoundary = stepNorm[axisKey] > 0 ? box.max[axisKey] : box.min[axisKey];
  const BOUNDARY_TOL = 5.0;
  const stepNearBoundary = Math.abs(stepCenter[axisKey] - expectedBoundary) < BOUNDARY_TOL;
  let bestGroup = aligned[0];
  if (step.outer) {
    // OK modu: kaydedilen merkeze bakılmaz, o yöndeki EN DIŞ yüz (çentikli panelde yuva yüzü değil).
    for (const g of aligned) if (g.center.dot(stepNorm) > bestGroup.center.dot(stepNorm) + 1e-6) bestGroup = g;
  } else if (aligned.length > 1) {
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
  // AÇILI referans: yüz köşelerinin düzleme (yüz normali boyunca) mesafe aralığı; uç eğime göre pahlanır.
  let bevel: { refC: THREE.Vector3; nOut: THREE.Vector3; tMin: number; tMax: number } | null = null;
  if (step.refPlaneCenterLocal) {
    const refC = new THREE.Vector3(...step.refPlaneCenterLocal);
    const refN = step.refPlaneNormalLocal ? new THREE.Vector3(...step.refPlaneNormalLocal).normalize() : null;
    const par = refN ? refN.dot(faceNormal) : 1;
    if (Math.abs(par) < 0.5) return null;   // ref yüzü extrude eksenine çok dik → adım atlanır
    if (refN && Math.abs(par) < 0.9999) {
      const tOf = (p: THREE.Vector3) => refC.clone().sub(p).dot(refN) / par;
      let tMin = Infinity, tMax = -Infinity;
      for (const fi of bestGroup.faceIndices) {
        for (const v of faces[fi]?.vertices || []) { const t = tOf(v); if (t < tMin) tMin = t; if (t > tMax) tMax = t; }
      }
      extrudeAmount = tOf(faceCenter);
      // Kesilecek yarım-uzay: düzlemin yüz normali tarafı.
      bevel = { refC, nOut: par > 0 ? refN.clone() : refN.clone().negate(), tMin, tMax };
    } else extrudeAmount = refC.clone().sub(faceCenter).dot(faceNormal);
  } else if (step.isFixed) {
    const k = dominantAxis(faceNormal);
    const faceDist = faceNormal[k] > 0 ? faceCenter[k] - box.min[k] : box.max[k] - faceCenter[k];
    extrudeAmount = step.value - faceDist;
  } else {
    extrudeAmount = step.value;
  }
  if (!bevel && Math.abs(extrudeAmount) < 0.01) return { noop: true, amount: 0 };

  const samplePt = step.samplePoint ? new THREE.Vector3(...step.samplePoint) : undefined;
  const matchingFace = findMatchingReplicadFace(currentShape, faceNormal, faceCenter, samplePt);
  if (!matchingFace) return null;
  const { cast } = await import('replicad');
  const prismOf = (face: any, len: number): any => {
    const vec = new oc.gp_Vec_4(faceNormal.x * len, faceNormal.y * len, faceNormal.z * len);
    const pb = new oc.BRepPrimAPI_MakePrism_1(face.wrapped, vec, false, true);
    pb.Build(new oc.Message_ProgressRange_1());
    return cast(pb.Shape());
  };
  if (bevel) {
    // 1) Yüz, düzlemi her köşede geçecek kadar uzatılır; 2) yüz sütunu ∩ düzlemin ötesi kesilir → uç eğimli.
    let shape = currentShape;
    const ext = bevel.tMax + 1;
    if (ext > 0.01) shape = shape.fuse(prismOf(matchingFace, ext));
    const lo = Math.min(bevel.tMin, 0) - 2, hi = Math.max(bevel.tMax, 0) + 2;
    const column = prismOf(matchingFace.clone().translate(faceNormal.x * lo, faceNormal.y * lo, faceNormal.z * lo), hi - lo);
    const H = Math.max(box.getSize(new THREE.Vector3()).length(), hi - lo) * 2 + 500;
    const half = await halfSpaceSlab(bevel.refC, bevel.nOut, bevel.nOut.clone().negate(), H);
    if (!half) return null;
    const finalShape = shape.cut(column.intersect(half));
    return { replicadShape: finalShape, geometry: convertReplicadToThreeGeometry(finalShape), amount: extrudeAmount };
  }
  // OK modu: en dış düzlemdeki TÜM yüzler birlikte (çentikli panelde yuvanın iki yanındaki uç parçaları da) — tek yüz değil.
  const faceList = step.outer ? outermostReplicadFaces(currentShape, faceNormal, matchingFace) : [matchingFace];
  let finalShape = currentShape;
  for (const f of faceList) {
    const extrudedShape = prismOf(f, extrudeAmount);
    finalShape = extrudeAmount > 0 ? finalShape.fuse(extrudedShape) : finalShape.cut(extrudedShape);
  }
  return { replicadShape: finalShape, geometry: convertReplicadToThreeGeometry(finalShape), amount: extrudeAmount };
}

/** `n` yönünde en dışta (eşleşen yüzün düzleminde, ±0.5 mm) duran, aynı normalli bütün replicad yüzleri; `first` listede kalır. */
function outermostReplicadFaces(replicadShape: any, n: THREE.Vector3, first: any): any[] {
  const planeOf = (face: any): number | null => {
    try {
      const fm = face.mesh({ tolerance: 1.0, angularTolerance: 15 });
      if (!fm.vertices || fm.vertices.length < 3) return null;
      let s = 0; const cnt = fm.vertices.length / 3;
      for (let j = 0; j < fm.vertices.length; j += 3) s += fm.vertices[j] * n.x + fm.vertices[j + 1] * n.y + fm.vertices[j + 2] * n.z;
      return s / cnt;
    } catch { return null; }
  };
  const d0 = planeOf(first);
  if (d0 == null) return [first];
  const out: any[] = [first];
  for (const face of replicadShape.faces || []) {
    if (face === first) continue;
    try {
      const nv = face.normalAt(0.5, 0.5);
      if (new THREE.Vector3(nv.x, nv.y, nv.z).dot(n) < 0.9) continue;
      const d = planeOf(face);
      if (d != null && Math.abs(d - d0) < 0.5) out.push(face);
    } catch { /* yüz okunamadı */ }
  }
  return out;
}

/** Katı, çağıran tarafından DOĞRU ÇERÇEVEDE verilmeli (VF'den üretilmiş + dönüşümler işlenmiş). */
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
      // Referans silinmiş/çözülemiyor → adım HİÇ uygulanmaz (yanlışlıkla tam kesim olmasın).
      if (!plane) continue;
      effectiveStep = { ...step, refPlaneCenterLocal: vec3(plane.center), refPlaneNormalLocal: vec3(plane.normal) };
    }
    const result = await applyOneExtrudeStep(currentReplicad, effectiveStep, currentGeometry);
    // 0 mm'e çözülen REF adımı (referans yüz zaten uçla çakışık): katı değişmez ama resolvedValue=0 YAZILIR — yazılmazsa damga
    // (PanelEngine.stepAmount) adımı "fixed 0 − açıklık" sayıp çöküyordu → yüzeyin şeklini alan kardeş çentiğini kaybediyordu.
    if (result && 'noop' in result) { if (step.refShapeId) resolved.push({ id: step.id, value: 0 }); continue; }
    if (result) {
      currentReplicad = result.replicadShape;
      currentGeometry = result.geometry;
      anyApplied = true;
      if (step.refShapeId) resolved.push({ id: step.id, value: round1(result.amount) });
    }
  }
  // Hiç uygulanmasa da çözülen (0 mm) ref değerleri geri döner → resolvedValue yazılır.
  return anyApplied || resolved.length ? { shape: currentReplicad, geometry: currentGeometry, resolved } : null;
}

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

/** Tıklanan yüze extrude adımı; aynı yüz (aynı eksen + merkez < 1 mm) → mevcut adımın yerine konur. */
function upsertFaceStep(
  panel: Shape, faceGroupIndex: number, value: number, isFixed: boolean, clickPoint: Vec3 | undefined, extra: Partial<ExtrudeStep> = {},
): { steps: ExtrudeStep[]; existed: boolean } | null {
  const face = resolveClickedFace(panel, faceGroupIndex);
  if (!face) return null;
  const steps = extrudeStepsOf(panel);
  const step: ExtrudeStep = {
    id: genId('ext'), faceNormal: vec3(face.faceNormal), faceCenter: vec3(face.faceCenter), axisLabel: dominantAxisLabel(face.faceNormal),
    value, isFixed, timestamp: Date.now(), samplePoint: clickPoint, ...extra,
  };
  const center = new THREE.Vector3(...step.faceCenter);
  const idx = steps.findIndex(s => s.axisLabel === step.axisLabel && new THREE.Vector3(...s.faceCenter).distanceTo(center) < 1.0);
  return { steps: idx >= 0 ? steps.map((s, i) => (i === idx ? step : s)) : [...steps, step], existed: idx >= 0 };
}

export interface FaceExtrudeParams {
  panelShape: Shape; faceGroupIndex: number; value: number; isFixed: boolean; updateShape: UpdateShape;
  clickPoint?: Vec3;
}

export async function executeFaceExtrude({ panelShape: panel, faceGroupIndex, value, isFixed, updateShape, clickPoint }: FaceExtrudeParams): Promise<boolean> {
  const up = upsertFaceStep(panel, faceGroupIndex, value, isFixed, clickPoint);
  if (!up) return false;
  // Dinamik modda değer = delta.
  if (!isFixed && Math.abs(value) < 0.01 && !up.existed) return false;
  return commitAndRebuild(panel, { extrudeSteps: up.steps }, updateShape);
}

/** Ref extrude: değer rebuild'de referansın güncel düzleminden çözülür (value=0 işaretçi). */
async function executeFaceExtrudeToReference(
  panel: Shape, faceGroupIndex: number, ref: RefFacePick, clickPoint: Vec3 | undefined, updateShape: UpdateShape,
): Promise<boolean> {
  const up = upsertFaceStep(panel, faceGroupIndex, 0, true, clickPoint, {
    refShapeId: ref.panelId, refFaceGroupIndex: ref.faceGroupIndex, refNormalWorld: ref.normalWorld, refPointWorld: ref.pointWorld,
  });
  if (!up) return false;
  return commitAndRebuild(panel, { extrudeSteps: up.steps }, updateShape);
}

// Referans yüz seçimi: aynı noktaya her tıklamada ışın boyunca bir arkadaki yüze geçilir (tüm şekiller).
// PanelDrawing ve ShapeWithTransform aynı fonksiyonu çağırır; döngü durumu modül düzeyinde (tek seçim).

export const REF_COLORS = {
  hover: 0xf2d57e, selected: 0xdfae4c, hoverCss: '#f2d57e', selectedCss: '#dfae4c', hoverOpacity: 0.42, selectedOpacity: 0.68,
} as const;

interface RefFaceCandidate { shapeId: string; faceGroupIndex: number; depth: number; pointWorld: Vec3; normalWorld: Vec3 }

/** Işının deldiği yüz grupları (hedef hariç), derinlik sıralı; düz gruba indirgenir, kopyalar elenir. */
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
      const inside = group.faceIndices.some(fi => {
        const w = faces[fi]?.vertices.map(q => q.clone().applyMatrix4(M));
        return !!w && pointInTriangle3D(hit, w[0], w[1], w[2]);
      });
      if (!inside) continue;
      const snapped = snapToFlatGroup(gi, groups);
      const sNormalWorld = (groups[snapped] || group).normal.clone().normalize().applyMatrix3(normalMatrix).normalize();
      out.push({ shapeId: s.id, faceGroupIndex: snapped, depth: t, pointWorld: vec3(hit), normalWorld: vec3(sNormalWorld) });
    }
  }
  out.sort((a, b) => a.depth - b.depth);
  const seen = new Set<string>();
  return out.filter(c => { const k = `${c.shapeId}#${c.faceGroupIndex}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

let lastPick: { x: number; y: number; index: number; ctx: string } | null = null;
const SAME_SPOT_PX = 6;

export function resetRefFacePick() { lastPick = null; }

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
