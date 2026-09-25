import * as THREE from 'three';
import { useAppStore, type Shape } from '../store';
import { getFacesAndGroups, type CoplanarFaceGroup, type FaceData } from './GeometryUtils';
import { getShapeMatrix } from './PanelMath';

// ═══════════════════════════════════════════════════════════════════════════
// FaceExtrudeService — PANEL YÜZ EXTRUDE ADIMLARI.
// Tek gerçek kaynak parameters.extrudeSteps'tir; burada yalnız adım yazılır.
// PanelEngine her rebuild'de paneli VF'den üretir, dönüşümleri uygular ve
// adımları AYNI (parent-yerel) çerçevede applyExtrudeSteps ile işler →
// extrude resize/taşıma/kardeş değişimlerinde korunur.
//   fixed → hedef ölçü (value − mevcut açıklık)   dyn → işaretli delta
//   ref   → yüzü referans panelin seçilen DÜZLEMİNE taşıyan işaretli mesafe,
//           her rebuild'de referansın GÜNCEL geometrisinden çözülür.
// ═══════════════════════════════════════════════════════════════════════════

type UpdateShape = (id: string, updates: Partial<Shape>) => void;
type Vec3 = [number, number, number];

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

function getAxisLabel(normal: THREE.Vector3): string {
  const absX = Math.abs(normal.x), absY = Math.abs(normal.y), absZ = Math.abs(normal.z);
  if (absX >= absY && absX >= absZ) return normal.x > 0 ? 'X+' : 'X-';
  if (absY >= absX && absY >= absZ) return normal.y > 0 ? 'Y+' : 'Y-';
  return normal.z > 0 ? 'Z+' : 'Z-';
}

/** Baskın eksen ('x' | 'y' | 'z'), getAxisLabel ile aynı eşitlik kuralı. */
function dominantAxis(n: THREE.Vector3): 'x' | 'y' | 'z' {
  const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
  return ax >= ay && ax >= az ? 'x' : ay >= ax && ay >= az ? 'y' : 'z';
}

const isFlatNormal = (n: THREE.Vector3) => Math.abs(n.x) > 0.999 || Math.abs(n.y) > 0.999 || Math.abs(n.z) > 0.999;

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
  const m = matchReferenceFace(shapes.find(s => s.id === refShapeId), refFaceGroupIndex, refNormalWorld, refPointWorld);
  return m ? { center: m.group.center.clone(), normal: m.group.normal.clone().normalize() } : null;
}

export function findExistingStepForFace(steps: ExtrudeStep[], faceNormal: THREE.Vector3, faceCenter?: THREE.Vector3): ExtrudeStep | null {
  const candidates = steps.filter(s => s.axisLabel === getAxisLabel(faceNormal));
  if (candidates.length === 0) return null;
  if (candidates.length === 1 || !faceCenter) return candidates[0];
  let best: ExtrudeStep | null = null, bestDist = Infinity;
  for (const s of candidates) {
    const d = new THREE.Vector3(...s.faceCenter).distanceTo(faceCenter);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return best;
}

// ── GEOMETRİ ────────────────────────────────────────────────────────────────

/** Adımın yüzüne karşılık gelen replicad yüzü (eksen etiketi + tıklama noktası/merkez). */
function findMatchingReplicadFace(replicadShape: any, targetNormal: THREE.Vector3, targetCenter: THREE.Vector3, samplePoint?: THREE.Vector3): any | null {
  const faces = replicadShape.faces;
  if (!faces || faces.length === 0) return null;
  const targetLabel = getAxisLabel(targetNormal);
  const candidates: Array<{ face: any; dot: number; dist: number; minPtDist: number }> = [];
  for (const face of faces) {
    try {
      const nv = face.normalAt(0.5, 0.5);
      const faceNormal = new THREE.Vector3(nv.x, nv.y, nv.z);
      if (getAxisLabel(faceNormal) !== targetLabel) continue;
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
            if (samplePoint) {
              const vx = fm.vertices[j] - samplePoint.x, vy = fm.vertices[j + 1] - samplePoint.y, vz = fm.vertices[j + 2] - samplePoint.z;
              const d = Math.sqrt(vx * vx + vy * vy + vz * vz);
              if (d < minPtDist) minPtDist = d;
            }
          }
          center = new THREE.Vector3(sx / n, sy / n, sz / n);
        }
      } catch {
        candidates.push({ face, dot, dist: Infinity, minPtDist: Infinity });
        continue;
      }
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

async function applyOneExtrudeStep(
  currentShape: any, step: ExtrudeStep, geometry: THREE.BufferGeometry
): Promise<{ replicadShape: any; geometry: THREE.BufferGeometry; amount: number } | null> {
  const { convertReplicadToThreeGeometry, initReplicad } = await import('./ReplicadService');
  const oc = await initReplicad();
  const { groups } = getFacesAndGroups(geometry);
  const stepNormal = new THREE.Vector3(...step.faceNormal);

  // Önce düz (eksen-hizalı) gruplar; yoksa eğri normal saklı eski adımlar için gevşek eşleşme.
  const flatAligned = groups.filter(g => {
    const n = g.normal.clone().normalize();
    return isFlatNormal(n) && getAxisLabel(n) === step.axisLabel;
  });
  const aligned = flatAligned.length > 0 ? flatAligned : groups.filter(g => {
    const n = g.normal.clone().normalize();
    return getAxisLabel(n) === step.axisLabel && n.dot(stepNormal) > 0.5;
  });
  if (aligned.length === 0) {
    console.warn(`[applyOneExtrudeStep] No aligned face group for axis ${step.axisLabel}. Groups:`, groups.map(g => getAxisLabel(g.normal.clone().normalize())));
    return null;
  }

  const box = new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position') as THREE.BufferAttribute);
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
      if (par < 0.7) {
        console.warn(`[applyOneExtrudeStep] Ref yüzü extrude eksenine paralel değil (|dot|=${par.toFixed(2)}) — adım atlandı`);
        return null;
      }
    }
    extrudeAmount = refC.clone().sub(faceCenter).dot(faceNormal);
    console.log(`[YAGO][EXTRUDE-REF] hedefDüzlem= ${refC.toArray().map(x => x.toFixed(1)).join(',')} yüzMerkez= ${faceCenter.toArray().map(x => x.toFixed(1)).join(',')} normal= ${faceNormal.toArray().map(x => x.toFixed(0)).join(',')} miktar= ${extrudeAmount.toFixed(1)}`);
  } else if (step.isFixed) {
    // FIXED: hedef ölçü − seçili yüzden karşı kutu sınırına mevcut açıklık.
    const k = dominantAxis(faceNormal);
    const faceDist = faceNormal[k] > 0 ? faceCenter[k] - box.min[k] : box.max[k] - faceCenter[k];
    extrudeAmount = step.value - faceDist;
  } else {
    extrudeAmount = step.value;
  }

  if (Math.abs(extrudeAmount) < 0.01) {
    console.warn(`[applyOneExtrudeStep] Extrude amount too small: ${extrudeAmount} for step ${step.axisLabel}`);
    return null;
  }

  const samplePt = step.samplePoint ? new THREE.Vector3(...step.samplePoint) : undefined;
  const matchingFace = findMatchingReplicadFace(currentShape, faceNormal, faceCenter, samplePt);
  if (!matchingFace) {
    console.warn(`[applyOneExtrudeStep] No matching replicad face for normal ${faceNormal.toArray()} center ${faceCenter.toArray()}`);
    return null;
  }
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
  const { convertReplicadToThreeGeometry } = await import('./ReplicadService');
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
      effectiveStep = {
        ...step,
        refPlaneCenterLocal: [plane.center.x, plane.center.y, plane.center.z],
        refPlaneNormalLocal: [plane.normal.x, plane.normal.y, plane.normal.z],
      };
    }
    const result = await applyOneExtrudeStep(currentReplicad, effectiveStep, currentGeometry);
    if (result) {
      currentReplicad = result.replicadShape;
      currentGeometry = result.geometry;
      anyApplied = true;
      if (step.refShapeId) resolved.push({ id: step.id, value: Math.round(result.amount * 10) / 10 });
    } else {
      console.warn(`[YAGO][EXTRUDE] Adım uygulanamadı: ${step.axisLabel} (id=${step.id})`);
    }
  }
  return anyApplied ? { shape: currentReplicad, geometry: currentGeometry, resolved } : null;
}

// ── KOMUTLAR: SPEC'i (extrudeSteps) günceller + rebuild ─────────────────────

async function commitStepsAndRebuild(panel: Shape, steps: ExtrudeStep[], updateShape: UpdateShape): Promise<boolean> {
  updateShape(panel.id, { parameters: { ...panel.parameters, extrudeSteps: steps } } as any);
  const parentId = (panel.parameters as any)?.parentShapeId as string | undefined;
  if (parentId) {
    const { rebuildPanelsForParent } = await import('./PanelEngine');
    await rebuildPanelsForParent(parentId, { changedPanelId: panel.id, orderChanged: false });
  }
  return true;
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
    const axLbl = getAxisLabel(faceNormal);
    const candidate = groups
      .filter(g => { const n = g.normal.clone().normalize(); return isFlatNormal(n) && getAxisLabel(n) === axLbl; })
      .sort((a, b) => a.center.distanceTo(raw.center) - b.center.distanceTo(raw.center))[0];
    if (candidate) { faceNormal = candidate.normal.clone().normalize(); faceCenter = candidate.center.clone(); }
  }
  return { faceNormal, faceCenter };
}

/** Aynı yüz için (aynı eksen + merkez < 1 mm) mevcut adımın indeksi, yoksa −1. */
function existingStepIndex(steps: ExtrudeStep[], axisLabel: string, faceCenter: THREE.Vector3): number {
  return steps.findIndex(s => s.axisLabel === axisLabel && new THREE.Vector3(...s.faceCenter).distanceTo(faceCenter) < 1.0);
}

/** Yeni adımı ekler ya da aynı yüzdeki adımın yerine koyar. */
function upsertStep(steps: ExtrudeStep[], idx: number, step: ExtrudeStep): ExtrudeStep[] {
  return idx >= 0 ? steps.map((s, i) => (i === idx ? step : s)) : [...steps, step];
}

const newExtrudeId = () => `ext-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;

export interface FaceExtrudeParams {
  panelShape: Shape;
  faceGroupIndex: number;
  value: number;
  isFixed: boolean;
  updateShape: UpdateShape;
  /** Tıklama noktası (yerel) — replicad yüzünü tekil seçer. */
  clickPoint?: Vec3;
}

export async function executeFaceExtrude({ panelShape: panel, faceGroupIndex, value, isFixed, updateShape, clickPoint }: FaceExtrudeParams): Promise<boolean> {
  const face = resolveClickedFace(panel, faceGroupIndex);
  if (!face) return false;
  const axisLabel = getAxisLabel(face.faceNormal);
  const existing: ExtrudeStep[] = panel.parameters?.extrudeSteps || [];
  const idx = existingStepIndex(existing, axisLabel, face.faceCenter);
  // Dinamik modda değer=delta; ~0 ve yeni adımsa işlem yok.
  if (!isFixed && Math.abs(value) < 0.01 && idx === -1) return false;
  const step: ExtrudeStep = {
    id: newExtrudeId(),
    faceNormal: [face.faceNormal.x, face.faceNormal.y, face.faceNormal.z],
    faceCenter: [face.faceCenter.x, face.faceCenter.y, face.faceCenter.z],
    axisLabel, value, isFixed, timestamp: Date.now(), samplePoint: clickPoint,
  };
  return commitStepsAndRebuild(panel, upsertStep(existing, idx, step), updateShape);
}

export interface FaceExtrudeRefParams {
  panelShape: Shape;
  faceGroupIndex: number;
  refShapeId: string;
  refFaceGroupIndex: number;
  refNormalWorld: Vec3;
  refPointWorld?: Vec3;
  clickPoint?: Vec3;
  updateShape: UpdateShape;
}

/** Ref extrude: değer rebuild'de referansın güncel düzleminden çözülür (value=0 işaretçi). */
export async function executeFaceExtrudeToReference(p: FaceExtrudeRefParams): Promise<boolean> {
  const panel = p.panelShape;
  const face = resolveClickedFace(panel, p.faceGroupIndex);
  if (!face) return false;
  const axisLabel = getAxisLabel(face.faceNormal);
  const existing: ExtrudeStep[] = panel.parameters?.extrudeSteps || [];
  const idx = existingStepIndex(existing, axisLabel, face.faceCenter);
  const step: ExtrudeStep = {
    id: newExtrudeId(),
    faceNormal: [face.faceNormal.x, face.faceNormal.y, face.faceNormal.z],
    faceCenter: [face.faceCenter.x, face.faceCenter.y, face.faceCenter.z],
    axisLabel, value: 0, isFixed: true, timestamp: Date.now(), samplePoint: p.clickPoint,
    refShapeId: p.refShapeId, refFaceGroupIndex: p.refFaceGroupIndex, refNormalWorld: p.refNormalWorld, refPointWorld: p.refPointWorld,
  };
  return commitStepsAndRebuild(panel, upsertStep(existing, idx, step), p.updateShape);
}

/**
 * Store'daki bekleyen REF extrude seçimini onaylar ve modu kapatır. Editörün
 * "Uygula" düğmesi, panel ve gövde üzerindeki sağ tık — üçü de bunu çağırır.
 */
export async function confirmRefFaceExtrude(): Promise<void> {
  const st = useAppStore.getState();
  const cand = st.faceExtrudeRefCandidate;
  const selFace = st.faceExtrudeSelectedFace;
  const ps = st.shapes.find(s => s.id === st.faceExtrudeTargetPanelId);
  if (!cand || cand.faceGroupIndex < 0 || selFace === null || !ps) return;
  await executeFaceExtrudeToReference({
    panelShape: ps, faceGroupIndex: selFace,
    refShapeId: cand.panelId, refFaceGroupIndex: cand.faceGroupIndex,
    refNormalWorld: cand.normalWorld, refPointWorld: cand.pointWorld,
    clickPoint: st.faceExtrudeClickPoint ?? undefined, updateShape: st.updateShape,
  });
  st.setFaceExtrudeSelectedFace(null);
  st.setFaceExtrudeMode(false);
  st.setFaceExtrudeRefCandidate(null);
}

export function deleteExtrudeStep(panelShape: Shape, stepId: string, updateShape: UpdateShape): Promise<boolean> {
  const steps: ExtrudeStep[] = panelShape.parameters?.extrudeSteps || [];
  return commitStepsAndRebuild(panelShape, steps.filter(s => s.id !== stepId), updateShape);
}

export function updateExtrudeStep(panelShape: Shape, stepId: string, newValue: number, updateShape: UpdateShape): Promise<boolean> {
  const steps: ExtrudeStep[] = panelShape.parameters?.extrudeSteps || [];
  return commitStepsAndRebuild(panelShape, steps.map(s => (s.id === stepId ? { ...s, value: newValue } : s)), updateShape);
}
