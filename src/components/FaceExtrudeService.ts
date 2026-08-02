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
  /** Değerin nasıl belirlendiği (yalnızca gösterim/rozet için). 'ref' adımları
   *  geometrik olarak Fixed gibi uygulanır (isFixed=true); referans yüzden
   *  otomatik hesaplanan net ölçüyü taşırlar. */
  mode?: 'fixed' | 'dyn' | 'ref';
  /** CANLI REFERANS BAĞI ('ref' modu): adım her rebuild'de bu şeklin ilgili
   *  yüzünü yeniden bulup ölçüyü GEOMETRİK olarak yeniden türetir. value artık
   *  dondurulmuş bir sayı değildir; referans şekil büyür/küçülür/taşınırsa kesici
   *  panel o yüzeyle ilişkili kalır. Çözümleme başarısızsa value yedek olarak
   *  kullanılır. referenceNormalWorld, referans yüzü (o normale sahip DIŞ sınır
   *  yüzü) tekrar bulmak için kullanılır. */
  referenceShapeId?: string;
  referenceNormalWorld?: [number, number, number];
  timestamp: number;
  /** Local-space point on the clicked face surface — used to uniquely
   *  identify the correct replicad face regardless of center/normal ambiguity. */
  samplePoint?: [number, number, number];
}

export interface FaceExtrudeParams {
  panelShape: Shape;
  faceGroupIndex: number;
  value: number;
  isFixed: boolean;
  /** Adıma yazılacak değer-modu etiketi (varsayılan: isFixed'den türetilir). */
  mode?: 'fixed' | 'dyn' | 'ref';
  /** Canlı referans bağı için (yalnız 'ref' modunda). */
  referenceShapeId?: string;
  referenceNormalWorld?: [number, number, number];
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

/**
 * REBUILD BAĞLAMI: extrude adımları uygulanırken canlı referansı çözebilmek için
 * gereken güncel sahne bilgisi. panelWorldOffset, kesici panelin dünya konumu
 * (PanelEngine'de position=parentPos, rotation=0 → dünya=yerel+offset). shapes,
 * referans şeklin GÜNCEL geometri/transform'unu bulmak içindir.
 */
export interface ExtrudeApplyContext {
  panelWorldOffset?: [number, number, number];
  shapes?: Shape[];
  /** Kesici panelin PARENT'ının (küp) yerel bbox'u — panel-yerel çerçevede.
   *  Referans uzatması sonucu parent hacmine kırpılır (dışarı taşmayı önler). */
  parentLocalBox?: { min: [number, number, number]; max: [number, number, number] };
}

/**
 * CANLI REFERANS DÜZLEMİ: adımın referans şeklinin, kayıtlı normale sahip DIŞ
 * SINIR yüzünü GÜNCEL geometride yeniden bulur ve kesici panelin YEREL çerçevesinde
 * {P (düzlem noktası), N (düzlem normali)} olarak döndürür. Panel yerel→dünya SAF
 * ÖTELEMEDİR (PanelEngine: position=parentPos, rotation=0), bu yüzden N dünya=yerel,
 * P = dünyaMerkez − offset. Bulunamazsa null.
 *
 * "Dış sınır yüzü" = o normal yönünde merkez izdüşümü EN BÜYÜK olan grup (kutu/panel
 * için tekildir). Resize'da bu yüz dışa/içe kayar; her rebuild'de yeniden bulunur.
 */
function resolveReferenceLocalPlane(
  step: ExtrudeStep,
  ctx?: ExtrudeApplyContext
): { P: THREE.Vector3; N: THREE.Vector3 } | null {
  if (!step.referenceShapeId || !step.referenceNormalWorld || !ctx?.shapes) return null;
  const refShape = ctx.shapes.find(s => s.id === step.referenceShapeId);
  if (!refShape || !refShape.geometry) return null;

  const refN = new THREE.Vector3(...step.referenceNormalWorld).normalize();

  // Referans şeklin GÜNCEL dünya dönüşümü.
  const rPos = new THREE.Vector3(refShape.position[0], refShape.position[1], refShape.position[2]);
  const rQuat = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(refShape.rotation[0], refShape.rotation[1], refShape.rotation[2], 'XYZ')
  );
  const rScl = new THREE.Vector3(refShape.scale[0], refShape.scale[1], refShape.scale[2]);
  const refL2W = new THREE.Matrix4().compose(rPos, rQuat, rScl);
  const refNMat = new THREE.Matrix3().getNormalMatrix(refL2W);

  const rGroups = groupCoplanarFaces(extractFacesFromGeometry(refShape.geometry));
  let bestCenterW: THREE.Vector3 | null = null;
  let bestNormalW: THREE.Vector3 | null = null;
  let bestProj = -Infinity;
  for (const g of rGroups) {
    const wN = g.normal.clone().applyMatrix3(refNMat).normalize();
    if (wN.dot(refN) < 0.9) continue; // aynı yön yüzler
    const wC = g.center.clone().applyMatrix4(refL2W);
    const proj = wC.dot(refN);        // bu normal yönünde en dıştaki = sınır yüzü
    if (proj > bestProj) { bestProj = proj; bestCenterW = wC; bestNormalW = wN; }
  }
  if (!bestCenterW || !bestNormalW) return null;

  const off = ctx.panelWorldOffset ?? [0, 0, 0];
  const P = bestCenterW.clone().sub(new THREE.Vector3(off[0], off[1], off[2]));
  const N = bestNormalW.clone(); // ötelemede yön değişmez → yerel normal = dünya normal
  return { P, N };
}

/**
 * Referans düzleminin kesici yüz ekseni boyunca "net ölçü"sü (düz/dik birleşim
 * için yedek yol). Fixed ile aynı çerçeve: karşı bbox sınırından düzleme mesafe.
 */
function resolveReferenceNetDim(
  step: ExtrudeStep,
  faceNormal: THREE.Vector3,
  box: THREE.Box3,
  ctx?: ExtrudeApplyContext
): number | null {
  const plane = resolveReferenceLocalPlane(step, ctx);
  if (!plane) return null;
  const refLocal = plane.P;
  const aX = Math.abs(faceNormal.x), aY = Math.abs(faceNormal.y), aZ = Math.abs(faceNormal.z);
  let coord: number, minC: number, maxC: number, positive: boolean;
  if (aX >= aY && aX >= aZ) { coord = refLocal.x; minC = box.min.x; maxC = box.max.x; positive = faceNormal.x > 0; }
  else if (aY >= aX && aY >= aZ) { coord = refLocal.y; minC = box.min.y; maxC = box.max.y; positive = faceNormal.y > 0; }
  else { coord = refLocal.z; minC = box.min.z; maxC = box.max.z; positive = faceNormal.z > 0; }
  const netDim = positive ? coord - minC : maxC - coord;
  if (!isFinite(netDim)) return null;
  return netDim;
}

/**
 * AÇILI REFERANS BİRLEŞİMİ (döndürülmüş panel): kesici panelin seçili yüzünü
 * önce faceNormal boyunca referans düzlemini AŞACAK kadar UZATIR (kanıtlanmış
 * prizma yolu), sonra düzlemle yarım-uzay KESER. Sonuç: panel ucu referans
 * yüzeyle TAM ÇAKIŞIK biter → panel döndüyse geometrik olarak AÇILI birleşir.
 *
 * KESİLECEK TARAF: seçili yüzün ilerleme yönüyle (faceNormal) hizalı taraf →
 * removeDir = N·sign(N·faceNormal). Bu her zaman faceNormal yarım-uzayını verir;
 * uzat/kes (grow/shrink) ve ters normalde de doğrudur (OCC harness ile doğrulandı:
 * eksen/oblik düzlem, eksen/döndürülmüş panel → uçtaki tüm nokta düzlemde).
 */
async function applyReferencePlaneCut(
  currentShape: any,
  faceNormal: THREE.Vector3,
  box: THREE.Box3,
  matchingFace: any,
  plane: { P: THREE.Vector3; N: THREE.Vector3 },
  oc: any,
  ctx?: ExtrudeApplyContext
): Promise<{ replicadShape: any; geometry: THREE.BufferGeometry } | null> {
  const { convertReplicadToThreeGeometry } = await import('./ReplicadService');
  const { createReplicadBox } = await import('./ReplicadService');
  const { cast } = await import('replicad');

  const { P, N } = plane;
  const denom = faceNormal.dot(N);
  // Düzlem, ilerleme yönüne (faceNormal) neredeyse dik ise açılı kesim tanımsız →
  // çağıran yedek (düz) yola düşsün.
  if (Math.abs(denom) < 0.05) {
    console.warn('[YAGO][EXTRUDE][REF] düzlem faceNormal\'e ~dik → açılı kesim atlandı (düz yola düşülüyor)');
    return null;
  }

  const size = box.getSize(new THREE.Vector3());
  const diag = size.length();
  const removeDir = N.clone().multiplyScalar(Math.sign(denom) || 1).normalize();

  // 1) UZAT — SADECE panel düzleme ULAŞAMIYORSA, faceNormal boyunca MİNİMUM kadar.
  //    Panel zaten düzlemi aşıyorsa uzatma yok (yalnız kesim). Aşırı taşma
  //    yaratmamak için pay küçük tutulur; kalan taşma (2) ve (3)'te budanır.
  let panelMaxProj = -Infinity;
  for (const cx of [box.min.x, box.max.x])
    for (const cy of [box.min.y, box.max.y])
      for (const cz of [box.min.z, box.max.z])
        panelMaxProj = Math.max(panelMaxProj, removeDir.dot(new THREE.Vector3(cx, cy, cz)));
  const deficit = removeDir.dot(P) - panelMaxProj;
  const growth = deficit > 0 ? deficit / Math.abs(denom) + 20 : 0;

  let grown = currentShape;
  if (growth > 0) {
    const gVec = new oc.gp_Vec_4(faceNormal.x * growth, faceNormal.y * growth, faceNormal.z * growth);
    const pb = new oc.BRepPrimAPI_MakePrism_1(matchingFace.wrapped, gVec, false, true);
    pb.Build(new oc.Message_ProgressRange_1());
    grown = currentShape.fuse(cast(pb.Shape()));
  }

  // 2) KES: referans düzlemiyle yarım-uzay (uç yüzeyle çakışık = açılı birleşim).
  const L = diag * 4 + 100;
  let cutter = await createReplicadBox({ width: L, height: L, depth: L });
  cutter = cutter.translate(-L / 2, -L / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), removeDir);
  const angle = 2 * Math.acos(Math.min(1, Math.max(-1, q.w)));
  const s = Math.sqrt(Math.max(0, 1 - q.w * q.w));
  const axis = s < 1e-6 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(q.x / s, q.y / s, q.z / s);
  const deg = angle * 180 / Math.PI;
  if (deg > 1e-3) cutter = cutter.rotate(deg, [0, 0, 0], [axis.x, axis.y, axis.z]);
  cutter = cutter.translate(P.x, P.y, P.z);
  let result = grown.cut(cutter);

  // 3) KIRP: uzattıysak, sonucu PARENT hacmine (küp) kırp → uzatma parent'ın
  //    dışına (ör. tabanın altına) sarkamaz. Yatık panel duvara hacim içinde
  //    ulaşabildiği kadar ulaşır; ulaşamıyorsa taşmadan olduğu yerde kalır.
  if (growth > 0 && ctx?.parentLocalBox) {
    const { min, max } = ctx.parentLocalBox;
    const m = 1; // çakışık sınır yüzlerini yanlışlıkla budamamak için küçük pay
    const cw = (max[0] - min[0]) + 2 * m;
    const ch = (max[1] - min[1]) + 2 * m;
    const cd = (max[2] - min[2]) + 2 * m;
    if (cw > 0 && ch > 0 && cd > 0) {
      let clip = await createReplicadBox({ width: cw, height: ch, depth: cd });
      clip = clip.translate(min[0] - m, min[1] - m, min[2] - m);
      try { result = result.intersect(clip); }
      catch (e) { console.warn('[YAGO][EXTRUDE][REF] parent kırpma başarısız, atlandı', (e as any)?.message); }
    }
  }

  console.log('[YAGO][EXTRUDE][REF] yüzeye birleştir: kesimAçısı=', deg.toFixed(1),
    '° uzatma=', growth.toFixed(1), (growth > 0 && ctx?.parentLocalBox ? '(parent hacmine kırpıldı)' : ''));
  const newGeometry = convertReplicadToThreeGeometry(result);
  return { replicadShape: result, geometry: newGeometry };
}

async function applyOneExtrudeStep(
  currentShape: any,
  step: ExtrudeStep,
  geometry: THREE.BufferGeometry,
  ctx?: ExtrudeApplyContext
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
  // CANLI REFERANS: adım bir referans şekle bağlıysa, ölçüyü her rebuild'de o
  // yüzden yeniden türet (dondurulmuş value yerine). Çözülemezse value'ya düş.
  let effectiveValue = step.value;
  let treatAsFixed = step.isFixed;
  if (step.referenceShapeId) {
    const live = resolveReferenceNetDim(step, faceNormal, box, ctx);
    if (live !== null) { effectiveValue = live; treatAsFixed = true; }
    else {
      console.warn(`[YAGO][EXTRUDE][REF] canlı çözüm başarısız → dondurulmuş değere düşülüyor (ref=${step.referenceShapeId})`);
    }
  }
  if (treatAsFixed) {
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
    extrudeAmount = effectiveValue - faceDist;
  } else {
    extrudeAmount = effectiveValue;
  }

  if (Math.abs(extrudeAmount) < 0.01 && !step.referenceShapeId) {
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

  // AÇILI REFERANS BİRLEŞİMİ: referans adımı ise, seçili yüzü referans DÜZLEMİNE
  // kadar uzat/kes; panel döndüyse uç, yüzeyle açılı biter (düz prizma yerine
  // yarım-uzay kesimi). Düzlem çözülemez/tanımsızsa aşağıdaki düz yola düşülür.
  if (step.referenceShapeId && ctx?.shapes) {
    const plane = resolveReferenceLocalPlane(step, ctx);
    if (plane) {
      const cutRes = await applyReferencePlaneCut(currentShape, faceNormal, box, matchingFace, plane, oc, ctx);
      if (cutRes) return cutRes;
    }
    // Açılı kesim atlandı (düzlem yok/tanımsız) → düz yola düş; ölçü ~0 ise iş yok.
    if (Math.abs(extrudeAmount) < 0.01) {
      console.warn(`[applyOneExtrudeStep] Ref fallback amount too small: ${extrudeAmount}`);
      return null;
    }
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
  ctx?: ExtrudeApplyContext
): Promise<{ shape: any; geometry: THREE.BufferGeometry } | null> {
  if (!steps || steps.length === 0) return null;
  const { convertReplicadToThreeGeometry } = await import('./ReplicadService');

  let currentReplicad = shape;
  let currentGeometry = convertReplicadToThreeGeometry(currentReplicad);
  let anyApplied = false;

  for (const step of steps) {
    const result = await applyOneExtrudeStep(currentReplicad, step, currentGeometry, ctx);
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
    mode: params.mode ?? (isFixed ? 'fixed' : 'dyn'),
    ...(params.referenceShapeId ? {
      referenceShapeId: params.referenceShapeId,
      referenceNormalWorld: params.referenceNormalWorld,
    } : {}),
    timestamp: Date.now(),
    samplePoint: params.clickPoint,
  };

  const newSteps = existingIdx >= 0
    ? existingSteps.map((s, i) => (i === existingIdx ? newStep : s))
    : [...existingSteps, newStep];

  return commitStepsAndRebuild(panel, newSteps, updateShape);
}

export interface FaceExtrudeToReferenceParams {
  /** Kesici panel (yüzü seçili olan). */
  panelShape: Shape;
  /** Kesici panelin seçili yüz grubu (GÜNCEL geometri indeksi). */
  faceGroupIndex: number;
  /** CANLI BAĞ için referans şeklin kimliği. */
  referenceShapeId: string;
  /** Referans yüzün DÜNYA uzayındaki bir noktası (yüz merkezi önerilir). */
  referencePointWorld: [number, number, number];
  /** Referans yüzün DÜNYA normali (yalnız bilgi amaçlı; ölçü eksen izdüşümüyle
   *  hesaplandığı için zorunlu değil). */
  referenceNormalWorld?: [number, number, number];
  updateShape: (id: string, updates: Partial<Shape>) => void;
  clickPoint?: [number, number, number];
  virtualFaceId?: string;
  vfNormal?: [number, number, number];
  vfVertex0?: [number, number, number];
  updateVirtualFace?: (id: string, updates: any) => void;
}

/**
 * REFERANS MODU: Kesici panelin seçili yüzünü, BAŞKA bir panel/küpün seçilen
 * yüz düzlemine kadar uzatır/keser. Referans düzlemi, kesici panelin YEREL
 * çerçevesine taşınır ve seçili yüzün ekseni boyunca bir "net ölçü" (Fixed
 * value) olarak ifade edilir. Böylece hiçbir yeni geometri yolu gerekmez:
 * mevcut Fixed uygulaması (extrudeAmount = value − faceDist) referans düzlemine
 * tam olarak oturmayı sağlar.
 *
 * KÖK MANTIK: Fixed value = "karşı bbox sınırından seçili yüze olan net mesafe".
 * Referans düzleminin yerel eksen koordinatı refCoord ise, karşı sınırdan
 * refCoord'a olan mesafe hedef net ölçüdür. Uygulama anında faceDist mevcut yüz
 * konumundan ölçüldüğü için extrudeAmount = refCoord − mevcutYüzKoordinatı olur;
 * yani seçili yüz tam referans düzlemine taşınır (pozitif→uzat, negatif→kes).
 */
export async function executeFaceExtrudeToReference(
  params: FaceExtrudeToReferenceParams
): Promise<boolean> {
  const panel = params.panelShape;
  if (!panel.geometry) return false;

  const faces = extractFacesFromGeometry(panel.geometry);
  const groups = groupCoplanarFaces(faces);
  const g = groups[params.faceGroupIndex];
  if (!g) return false;

  // Seçili yüzün baskın ekseni + işareti (net ölçü yalnızca bunları gerektirir;
  // hafif eğri normalde bile baskın eksen aynı kalır).
  const gn = g.normal.clone().normalize();
  const absX = Math.abs(gn.x), absY = Math.abs(gn.y), absZ = Math.abs(gn.z);
  const axis = absX >= absY && absX >= absZ ? 0 : absY >= absZ ? 1 : 2;
  const positive = gn.getComponent(axis) > 0;

  // Kesici panelin bbox'u (yerel) + referans noktasının yerel koordinatı.
  const box = new THREE.Box3().setFromBufferAttribute(
    panel.geometry.getAttribute('position') as THREE.BufferAttribute
  );
  const pos = new THREE.Vector3(panel.position[0], panel.position[1], panel.position[2]);
  const quat = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(panel.rotation[0], panel.rotation[1], panel.rotation[2], 'XYZ')
  );
  const scl = new THREE.Vector3(panel.scale[0], panel.scale[1], panel.scale[2]);
  const worldToLocal = new THREE.Matrix4().compose(pos, quat, scl).invert();

  const refLocal = new THREE.Vector3(...params.referencePointWorld).applyMatrix4(worldToLocal);
  const refCoord = refLocal.getComponent(axis);
  const minC = box.min.getComponent(axis);
  const maxC = box.max.getComponent(axis);
  const netDim = positive ? refCoord - minC : maxC - refCoord;

  console.log('[YAGO][EXTRUDE][REF] eksen=', ['X', 'Y', 'Z'][axis],
    positive ? '+' : '-', 'refYerel=', refCoord.toFixed(1),
    'netÖlçü=', netDim.toFixed(1));

  if (!isFinite(netDim)) return false;

  return executeFaceExtrude({
    panelShape: panel,
    faceGroupIndex: params.faceGroupIndex,
    value: netDim,
    isFixed: true,
    mode: 'ref',
    referenceShapeId: params.referenceShapeId,
    referenceNormalWorld: params.referenceNormalWorld,
    shapes: [],
    updateShape: params.updateShape,
    clickPoint: params.clickPoint,
    virtualFaceId: params.virtualFaceId,
    vfNormal: params.vfNormal,
    vfVertex0: params.vfVertex0,
    updateVirtualFace: params.updateVirtualFace,
  });
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
