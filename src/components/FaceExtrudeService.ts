import * as THREE from 'three';
import type { Shape } from '../store';
import {
  extractFacesFromGeometry,
  groupCoplanarFaces,
} from './GeometryUtils';

export interface ExtrudeStep {
  id: string;
  faceNormal: [number, number, number];
  faceCenter: [number, number, number];
  axisLabel: string;
  value: number;
  isFixed: boolean;
  timestamp: number;
  /** Local-space point on the clicked face surface — used to uniquely
   *  identify the correct replicad face regardless of center/normal ambiguity. */
  samplePoint?: [number, number, number];
  /** Ref modu: referans alınan panel id + yüz grubu indeksi + dünya-uzayı normali.
   *  value, her rebuild'de referans panelinin güncel geometrisinden çözülür. */
  refShapeId?: string;
  refFaceGroupIndex?: number;
  refNormalWorld?: [number, number, number];
}

export interface FaceExtrudeParams {
  panelShape: Shape;
  faceGroupIndex: number;
  value: number;
  isFixed: boolean;
  shapes: Shape[];
  updateShape: (id: string, updates: Partial<Shape>) => void;
  /** Local-space click point captured from the Three.js pointer event. */
  clickPoint?: [number, number, number];
  /** VF id, normal, and first vertex for updating the virtual face polygon after extrude. */
  virtualFaceId?: string;
  vfNormal?: [number, number, number];
  vfVertex0?: [number, number, number];
  updateVirtualFace?: (id: string, updates: any) => void;
}

function getAxisLabel(normal: THREE.Vector3): string {
  const absX = Math.abs(normal.x);
  const absY = Math.abs(normal.y);
  const absZ = Math.abs(normal.z);
  if (absX >= absY && absX >= absZ) return normal.x > 0 ? 'X+' : 'X-';
  if (absY >= absX && absY >= absZ) return normal.y > 0 ? 'Y+' : 'Y-';
  return normal.z > 0 ? 'Z+' : 'Z-';
}

/** Referans panelinin seçilen yüzeyinin güncel net boyutunu (dünya uzayında)
 *  döndürür — referans paneli taşınmış/resize edilmiş olsa bile her rebuild'de
 *  güncel ölçüyü verir. */
export function resolveReferenceNetDim(
  refShapeId: string,
  refFaceGroupIndex: number,
  shapes: Shape[]
): number | null {
  const refPanel = shapes.find(s => s.id === refShapeId);
  if (!refPanel?.geometry) return null;
  const faces = extractFacesFromGeometry(refPanel.geometry);
  const groups = groupCoplanarFaces(faces);
  if (refFaceGroupIndex < 0 || refFaceGroupIndex >= groups.length) return null;
  const group = groups[refFaceGroupIndex];
  const n = group.normal.clone().normalize();
  // Yüzün bulunduğu düzlemdeki genişlik (u/v eksenlerinde bbox)
  const { u, v } = facePlaneBasis(n);
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const fi of group.faceIndices) {
    const f = faces[fi]; if (!f) continue;
    for (const vert of f.vertices) {
      const p = vert.clone();
      const pu = p.dot(u), pv = p.dot(v);
      uMin = Math.min(uMin, pu); uMax = Math.max(uMax, pu);
      vMin = Math.min(vMin, pv); vMax = Math.max(vMax, pv);
    }
  }
  const w = uMax - uMin, h = vMax - vMin;
  if (!isFinite(w) || !isFinite(h)) return null;
  // Net boyut: yüzeyin büyük kenarı (basan yüzeyin genişliği)
  return Math.max(w, h);
}

function facePlaneBasis(normal: THREE.Vector3): { u: THREE.Vector3; v: THREE.Vector3 } {
  const n = normal.clone().normalize();
  const up = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(up, n).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  return { u, v };
}

export function findExistingStepForFace(
  steps: ExtrudeStep[],
  faceNormal: THREE.Vector3,
  faceCenter?: THREE.Vector3
): ExtrudeStep | null {
  const label = getAxisLabel(faceNormal);
  const candidates = steps.filter(s => s.axisLabel === label);
  if (candidates.length === 0) return null;
  if (candidates.length === 1 || !faceCenter) return candidates[0];
  let best: ExtrudeStep | null = null;
  let bestDist = Infinity;
  for (const s of candidates) {
    const sc = new THREE.Vector3(...s.faceCenter);
    const d = sc.distanceTo(faceCenter);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return best;
}

function findMatchingReplicadFace(
  replicadShape: any,
  targetNormal: THREE.Vector3,
  targetCenter: THREE.Vector3,
  samplePoint?: THREE.Vector3
): any | null {
  const faces = replicadShape.faces;
  if (!faces || faces.length === 0) return null;

  const targetLabel = getAxisLabel(targetNormal);
  const candidates: Array<{ face: any; dot: number; dist: number; minPtDist: number }> = [];

  for (let i = 0; i < faces.length; i++) {
    const face = faces[i];
    try {
      const normalVec = face.normalAt(0.5, 0.5);
      const faceNormal = new THREE.Vector3(normalVec.x, normalVec.y, normalVec.z);
      const faceLabel = getAxisLabel(faceNormal);
      if (faceLabel !== targetLabel) continue;

      const dot = faceNormal.dot(targetNormal);
      if (dot < 0.5) continue;

      let center = new THREE.Vector3();
      let minPtDist = Infinity;
      try {
        const faceMesh = face.mesh({ tolerance: 1.0, angularTolerance: 15 });
        if (faceMesh.vertices && faceMesh.vertices.length >= 3) {
          let sx = 0, sy = 0, sz = 0;
          const nv = faceMesh.vertices.length / 3;
          for (let j = 0; j < faceMesh.vertices.length; j += 3) {
            sx += faceMesh.vertices[j];
            sy += faceMesh.vertices[j + 1];
            sz += faceMesh.vertices[j + 2];
            if (samplePoint) {
              const vx = faceMesh.vertices[j] - samplePoint.x;
              const vy = faceMesh.vertices[j + 1] - samplePoint.y;
              const vz = faceMesh.vertices[j + 2] - samplePoint.z;
              const d = Math.sqrt(vx * vx + vy * vy + vz * vz);
              if (d < minPtDist) minPtDist = d;
            }
          }
          center = new THREE.Vector3(sx / nv, sy / nv, sz / nv);
        }
      } catch {
        candidates.push({ face, dot, dist: Infinity, minPtDist: Infinity });
        continue;
      }

      candidates.push({ face, dot, dist: center.distanceTo(targetCenter), minPtDist });
    } catch {
      continue;
    }
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].face;

  // When a sample point is available, prefer the replicad face whose
  // tessellation is CLOSEST to that point. The correct face contains the
  // click point so its minPtDist ≈ 0; inner slot walls are much farther.
  if (samplePoint) {
    candidates.sort((a, b) => a.minPtDist - b.minPtDist || b.dot - a.dot);
  } else {
    candidates.sort((a, b) => a.dist - b.dist || b.dot - a.dot);
  }
  return candidates[0].face;
}

async function applyOneExtrudeStep(
  currentShape: any,
  step: ExtrudeStep,
  geometry: THREE.BufferGeometry
): Promise<{ replicadShape: any; geometry: THREE.BufferGeometry } | null> {
  const { convertReplicadToThreeGeometry, initReplicad } = await import('./ReplicadService');
  const oc = await initReplicad();

  const faces = extractFacesFromGeometry(geometry);
  const groups = groupCoplanarFaces(faces);
  const stepNormal = new THREE.Vector3(...step.faceNormal);

  // Prefer flat (axis-aligned) groups first; fall back to the full list so
  // that legacy steps with slightly curved stored normals still resolve.
  const flatAligned = groups.filter(g => {
    const gNorm = g.normal.clone().normalize();
    const isFlat = Math.abs(gNorm.x) > 0.999 || Math.abs(gNorm.y) > 0.999 || Math.abs(gNorm.z) > 0.999;
    return isFlat && getAxisLabel(gNorm) === step.axisLabel;
  });
  const aligned = flatAligned.length > 0 ? flatAligned : groups.filter(g => {
    const gNorm = g.normal.clone().normalize();
    return getAxisLabel(gNorm) === step.axisLabel && gNorm.dot(stepNormal) > 0.5;
  });
  if (aligned.length === 0) {
    console.warn(`[applyOneExtrudeStep] No aligned face group for axis ${step.axisLabel}. Groups:`, groups.map(g => getAxisLabel(g.normal.clone().normalize())));
    return null;
  }

  const box = new THREE.Box3().setFromBufferAttribute(
    geometry.getAttribute('position') as THREE.BufferAttribute
  );

  const stepCenter = new THREE.Vector3(...step.faceCenter);
  const stepNorm = new THREE.Vector3(...step.faceNormal).normalize();

  // Determine the expected bbox boundary for this axis direction.
  // The outer face of the panel lives at the bbox extreme; inner slot walls
  // are set back from it. When stepCenter is near the bbox boundary (the user
  // clicked on the outer face), we apply a heavy penalty to candidate groups
  // that are far from the boundary so that inner slot walls are never
  // preferred over the outer face.
  const absNX = Math.abs(stepNorm.x), absNY = Math.abs(stepNorm.y), absNZ = Math.abs(stepNorm.z);
  type AxisKey = 'x' | 'y' | 'z';
  let axisKey: AxisKey;
  let expectedBoundary: number;
  if (absNX >= absNY && absNX >= absNZ) {
    axisKey = 'x';
    expectedBoundary = stepNorm.x > 0 ? box.max.x : box.min.x;
  } else if (absNY >= absNX && absNY >= absNZ) {
    axisKey = 'y';
    expectedBoundary = stepNorm.y > 0 ? box.max.y : box.min.y;
  } else {
    axisKey = 'z';
    expectedBoundary = stepNorm.z > 0 ? box.max.z : box.min.z;
  }
  const BOUNDARY_TOL = 5.0;
  const stepNearBoundary = Math.abs(stepCenter[axisKey] - expectedBoundary) < BOUNDARY_TOL;

  let bestGroup = aligned[0];
  if (aligned.length > 1) {
    let bestScore = Infinity;
    for (const g of aligned) {
      const distToStep = g.center.distanceTo(stepCenter);
      // If the user clicked near the bbox boundary (outer face intent), penalise
      // any candidate group whose centre is NOT on the boundary — these are inner
      // slot/recess faces that should never be preferred over the outer face.
      const distToBoundary = Math.abs(g.center[axisKey] - expectedBoundary);
      const boundaryPenalty = stepNearBoundary && distToBoundary > BOUNDARY_TOL ? 10000 : 0;
      const score = distToStep + boundaryPenalty;
      if (score < bestScore) { bestScore = score; bestGroup = g; }
    }
  }

  const faceNormal = bestGroup.normal.clone().normalize();
  const faceCenter = bestGroup.center.clone();

  let extrudeAmount: number;
  if (step.isFixed) {
    // Measure the current distance from the selected face to the opposite
    // bounding-box boundary along the face's normal. Using the face centre
    // position (not the full bbox size) gives the correct result even for
    // stepped / L-shaped panels where the selected face is not at the bbox edge.
    const absX = Math.abs(faceNormal.x);
    const absY = Math.abs(faceNormal.y);
    const absZ = Math.abs(faceNormal.z);
    let faceDist: number;
    if (absX >= absY && absX >= absZ) {
      faceDist = faceNormal.x > 0
        ? faceCenter.x - box.min.x
        : box.max.x - faceCenter.x;
    } else if (absY >= absX && absY >= absZ) {
      faceDist = faceNormal.y > 0
        ? faceCenter.y - box.min.y
        : box.max.y - faceCenter.y;
    } else {
      faceDist = faceNormal.z > 0
        ? faceCenter.z - box.min.z
        : box.max.z - faceCenter.z;
    }
    extrudeAmount = step.value - faceDist;
  } else {
    extrudeAmount = step.value;
  }

  if (Math.abs(extrudeAmount) < 0.01) {
    console.warn(`[applyOneExtrudeStep] Extrude amount too small: ${extrudeAmount} for step ${step.axisLabel}`);
    return null;
  }

  const samplePt = step.samplePoint
    ? new THREE.Vector3(...step.samplePoint)
    : undefined;
  const matchingFace = findMatchingReplicadFace(currentShape, faceNormal, faceCenter, samplePt);
  if (!matchingFace) {
    console.warn(`[applyOneExtrudeStep] No matching replicad face for normal ${faceNormal.toArray()} center ${faceCenter.toArray()}`);
    return null;
  }

  const extVec: [number, number, number] = [
    faceNormal.x * extrudeAmount,
    faceNormal.y * extrudeAmount,
    faceNormal.z * extrudeAmount,
  ];
  const ocVec = new oc.gp_Vec_4(extVec[0], extVec[1], extVec[2]);
  const prismBuilder = new oc.BRepPrimAPI_MakePrism_1(
    matchingFace.wrapped, ocVec, false, true
  );
  prismBuilder.Build(new oc.Message_ProgressRange_1());
  const extrudedSolid = prismBuilder.Shape();

  const { cast } = await import('replicad');
  const extrudedShape = cast(extrudedSolid);

  const finalShape = extrudeAmount > 0
    ? currentShape.fuse(extrudedShape)
    : currentShape.cut(extrudedShape);

  const newGeometry = convertReplicadToThreeGeometry(finalShape);
  return { replicadShape: finalShape, geometry: newGeometry };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verilen (DOĞRU ÇERÇEVEDE üretilmiş) katıya extrude adımlarını sırayla uygular.
 * Katı, çağıran tarafından panelin GÜNCEL çerçevesinde verilir (VF panelinden
 * üretilmiş + transform adımları işlenmiş). Adımların faceNormal/faceCenter/
 * samplePoint verisi de aynı çerçevede yakalandığı için eşleşme birebir tutar.
 *
 * KÖK NEDEN (bu düzeltmenin sebebi): Eski akış tabanı createReplicadBox ile
 * ORIGIN'de bir kutu kuruyordu. PanelEngine'e geçince panel geometrisi artık
 * parent-yerel VF konumunda üretiliyor; origin kutusu YANLIŞ ÇERÇEVEDEYDİ →
 * onaylayınca panel "alakasız yere" ışınlanıyordu. Taban artık çağıranın verdiği
 * doğru-çerçeve katıdan geldiği için ışınlanma yok ("highlight = panel").
 */
export async function applyExtrudeSteps(
  shape: any,
  steps: ExtrudeStep[],
  shapes?: Shape[]
): Promise<{ shape: any; geometry: THREE.BufferGeometry } | null> {
  if (!steps || steps.length === 0) return null;
  const { convertReplicadToThreeGeometry } = await import('./ReplicadService');

  let currentReplicad = shape;
  let currentGeometry = convertReplicadToThreeGeometry(currentReplicad);
  let anyApplied = false;

  for (const step of steps) {
    // Ref adımı: değer, referans panelinin güncel geometrisinden çözülür.
    let effectiveStep = step;
    if (step.refShapeId && shapes) {
      const refDim = resolveReferenceNetDim(step.refShapeId, step.refFaceGroupIndex ?? -1, shapes);
      if (refDim != null) {
        effectiveStep = { ...step, value: refDim, isFixed: true };
      } else {
        console.warn(`[YAGO][EXTRUDE-REF] Referans ölçüsü çözülemedi: ${step.refShapeId}`);
      }
    }
    const result = await applyOneExtrudeStep(currentReplicad, effectiveStep, currentGeometry);
    if (result) {
      currentReplicad = result.replicadShape;
      currentGeometry = result.geometry;
      anyApplied = true;
    } else {
      console.warn(`[YAGO][EXTRUDE] Adım uygulanamadı: ${step.axisLabel} (id=${step.id})`);
    }
  }

  if (!anyApplied) return null;
  return { shape: currentReplicad, geometry: currentGeometry };
}

// ── Onay / düzenleme / silme: hepsi SPEC'i (extrudeSteps) günceller + rebuild ──
// Geometri artık BURADA yazılmaz. Tek gerçek kaynak parameters.extrudeSteps'tir;
// PanelEngine rebuild'i VF panelini üretir, transform + extrude adımlarını
// doğru çerçevede uygular ve geometriyi yazar. Böylece extrude hem tıklanan yüze
// oturur hem de sonraki rebuild'lerde (resize/move/kardeş) KORUNUR.
async function commitStepsAndRebuild(
  panel: Shape,
  steps: ExtrudeStep[],
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  updateShape(panel.id, {
    parameters: { ...panel.parameters, extrudeSteps: steps },
  } as any);
  const parentId = (panel.parameters as any)?.parentShapeId as string | undefined;
  if (parentId) {
    const { rebuildPanelsForParent } = await import('./PanelRebuildService');
    await rebuildPanelsForParent(parentId);
  }
  return true;
}

export async function executeFaceExtrude(params: FaceExtrudeParams): Promise<boolean> {
  const { faceGroupIndex, value, isFixed, updateShape } = params;
  const panel = params.panelShape;

  if (!panel.geometry) return false;

  const faces = extractFacesFromGeometry(panel.geometry);
  const groups = groupCoplanarFaces(faces);
  if (faceGroupIndex < 0 || faceGroupIndex >= groups.length) return false;

  // Tıklanan yüz grubu — normal/merkez GÜNCEL (parent-yerel) geometri
  // çerçevesinde okunur; clickPoint (samplePoint) da aynı çerçevede yakalandı.
  const rawGroup = groups[faceGroupIndex];
  let faceNormal = rawGroup.normal.clone().normalize();
  let faceCenter = rawGroup.center.clone();

  // Fillet (eğri) yüz grubunu en yakın eksen-hizalı düz yüze yasla; aksi halde
  // eksen-dışı bir adım üretilir ve saklı düz-yüz adımlarıyla eşleşmez.
  const isFlat = (n: THREE.Vector3) =>
    Math.abs(n.x) > 0.999 || Math.abs(n.y) > 0.999 || Math.abs(n.z) > 0.999;
  if (!isFlat(faceNormal)) {
    const axLbl = getAxisLabel(faceNormal);
    const candidate = groups
      .filter(g => {
        const n = g.normal.clone().normalize();
        return isFlat(n) && getAxisLabel(n) === axLbl;
      })
      .sort((a, b) => a.center.distanceTo(rawGroup.center) - b.center.distanceTo(rawGroup.center))[0];
    if (candidate) {
      faceNormal = candidate.normal.clone().normalize();
      faceCenter = candidate.center.clone();
    }
  }

  const axisLabel = getAxisLabel(faceNormal);
  const existingSteps: ExtrudeStep[] = panel.parameters?.extrudeSteps || [];

  // Aynı yüz için mevcut adım? (aynı eksen + merkez yakınlığı) → güncelle.
  const existingIdx = existingSteps.findIndex(s => {
    if (s.axisLabel !== axisLabel) return false;
    const sc = new THREE.Vector3(...s.faceCenter);
    return sc.distanceTo(faceCenter) < 1.0;
  });

  // Dinamik modda değer=delta; ~0 ve yeni adımsa işlem yok.
  if (!isFixed && Math.abs(value) < 0.01 && existingIdx === -1) return false;

  const newStep: ExtrudeStep = {
    id: `ext-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
    faceNormal: [faceNormal.x, faceNormal.y, faceNormal.z],
    faceCenter: [faceCenter.x, faceCenter.y, faceCenter.z],
    axisLabel,
    value,
    isFixed,
    timestamp: Date.now(),
    samplePoint: params.clickPoint,
  };

  const newSteps = existingIdx >= 0
    ? existingSteps.map((s, i) => (i === existingIdx ? newStep : s))
    : [...existingSteps, newStep];

  return commitStepsAndRebuild(panel, newSteps, updateShape);
}

export interface FaceExtrudeRefParams {
  panelShape: Shape;
  faceGroupIndex: number;
  refShapeId: string;
  refFaceGroupIndex: number;
  refNormalWorld: [number, number, number];
  clickPoint?: [number, number, number];
  shapes: Shape[];
  updateShape: (id: string, updates: Partial<Shape>) => void;
  virtualFaceId?: string;
  vfNormal?: [number, number, number];
  vfVertex0?: [number, number, number];
  updateVirtualFace?: (id: string, updates: any) => void;
}

/** Ref modu: extrude değerini referans panelinin yüzey ölçüsüne bağlar.
 *  Adım isFixed=true ve ref alanlarıyla saklanır; her rebuild'de
 *  resolveReferenceNetDim güncel ölçüyü çözüp uygular. */
export async function executeFaceExtrudeToReference(params: FaceExtrudeRefParams): Promise<boolean> {
  const { faceGroupIndex, refShapeId, refFaceGroupIndex, shapes, updateShape } = params;
  const panel = params.panelShape;

  if (!panel.geometry) return false;

  const faces = extractFacesFromGeometry(panel.geometry);
  const groups = groupCoplanarFaces(faces);
  if (faceGroupIndex < 0 || faceGroupIndex >= groups.length) return false;

  const rawGroup = groups[faceGroupIndex];
  let faceNormal = rawGroup.normal.clone().normalize();
  let faceCenter = rawGroup.center.clone();

  const isFlat = (n: THREE.Vector3) =>
    Math.abs(n.x) > 0.999 || Math.abs(n.y) > 0.999 || Math.abs(n.z) > 0.999;
  if (!isFlat(faceNormal)) {
    const axLbl = getAxisLabel(faceNormal);
    const candidate = groups
      .filter(g => {
        const n = g.normal.clone().normalize();
        return isFlat(n) && getAxisLabel(n) === axLbl;
      })
      .sort((a, b) => a.center.distanceTo(rawGroup.center) - b.center.distanceTo(rawGroup.center))[0];
    if (candidate) {
      faceNormal = candidate.normal.clone().normalize();
      faceCenter = candidate.center.clone();
    }
  }

  const axisLabel = getAxisLabel(faceNormal);
  const existingSteps: ExtrudeStep[] = panel.parameters?.extrudeSteps || [];

  const existingIdx = existingSteps.findIndex(s => {
    if (s.axisLabel !== axisLabel) return false;
    const sc = new THREE.Vector3(...s.faceCenter);
    return sc.distanceTo(faceCenter) < 1.0;
  });

  // Referans ölçüsünü şimdilik 0 olarak sakla; rebuild sırasında çözülecek.
  // value=0 geçici — applyExtrudeSteps ref alanlarını görüp resolveReferenceNetDim çağırır.
  const newStep: ExtrudeStep = {
    id: `ext-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
    faceNormal: [faceNormal.x, faceNormal.y, faceNormal.z],
    faceCenter: [faceCenter.x, faceCenter.y, faceCenter.z],
    axisLabel,
    value: 0,
    isFixed: true,
    timestamp: Date.now(),
    samplePoint: params.clickPoint,
    refShapeId,
    refFaceGroupIndex,
    refNormalWorld: params.refNormalWorld,
  };

  const newSteps = existingIdx >= 0
    ? existingSteps.map((s, i) => (i === existingIdx ? newStep : s))
    : [...existingSteps, newStep];

  return commitStepsAndRebuild(panel, newSteps, updateShape);
}

export async function deleteExtrudeStep(
  panelShape: Shape,
  stepId: string,
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  const steps: ExtrudeStep[] = panelShape.parameters?.extrudeSteps || [];
  const newSteps = steps.filter(s => s.id !== stepId);
  return commitStepsAndRebuild(panelShape, newSteps, updateShape);
}

export async function updateExtrudeStep(
  panelShape: Shape,
  stepId: string,
  newValue: number,
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  const steps: ExtrudeStep[] = panelShape.parameters?.extrudeSteps || [];
  const newSteps = steps.map(s => (s.id === stepId ? { ...s, value: newValue } : s));
  return commitStepsAndRebuild(panelShape, newSteps, updateShape);
}
