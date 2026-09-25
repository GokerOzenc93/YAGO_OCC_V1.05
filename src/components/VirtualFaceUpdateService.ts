import * as THREE from 'three';
import type { VirtualFace, Shape } from '../store';
import {
  computeFaceComponentContour, convexHull2D, ensureCCW, getSubtractorFootprints2D, isPointInsidePolygon,
  computeFreeRegionLocal, meshOnPlaneBoundary2D, projectTo2D, subtractPolygon, panelIsTiltedSlab, type Point2D,
} from './FaceRegion';
import { getFacesAndGroups, findFaceByDescriptor, type FaceData, type CoplanarFaceGroup } from './GeometryUtils';
import { composeSteps, resolveRefTranslateDelta } from './PanelEngine';
import { getUnifiedSteps, stepRefTargets } from './PanelSteps';
import { axisDirToVec, getFacePlaneAxes, getShapeMatrix, panelThickness, type Vec3 } from './PanelMath';
import { effectiveBodyGeometry } from './VertexEditorService';

// ═══════════════════════════════════════════════════════════════════════════
// VirtualFaceUpdateService — VF (sanal yüz) BÖLGE YENİDEN HESABI.
//
// Her VF, eşleşen gövde yüzünün konturundan yeniden üretilir ve kardeş
// panellerin AYAK İZLERİ (damga) ile kırpılır. Damga yetkisi TEK YÖNLÜ: bir
// VF'yi yalnız VF sırasında kendinden ÖNCE gelen (basan) kardeşler damgalar;
// istisna yalnız paneli fiziksel olarak bu yüze doğru İLERLETEN adımlardır
// (farklı yüzdeki taşıma; işaretli miktarı yüze doğru olan extrude).
// Datum'unu damgalayamazsın: ref-taşıma/ref-dönüş/extrude-ref hedefi olan
// panelin bölgesi, onu referans alan panel tarafından kırpılmaz.
// Serbest bölgenin kendisi FaceRegion.computeFreeRegionLocal'dadır (yakalama
// ile aynı fonksiyon → highlight = panel).
// ═══════════════════════════════════════════════════════════════════════════

type RawBBox = { xMin: number; xMax: number; yMin: number; yMax: number; xSpan: number; ySpan: number };

/** VF bölge çokgeninden (ön halka) + kalınlık kadar geri (arka halka) indeksli prizma. */
function buildPrismFromVertices(vertices: Vec3[], normal: Vec3, thickness: number): THREE.BufferGeometry | null {
  const N = vertices.length;
  const n = new THREE.Vector3(normal[0], normal[1], normal[2]).normalize();
  const front = vertices.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const back = front.map(p => p.clone().addScaledVector(n, -thickness)); // extrude(-th) ile aynı yön
  const arr = new Float32Array(N * 2 * 3);
  [...front, ...back].forEach((p, i) => { arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z; });
  // Kapaklar fan (dış kenarlar tek kullanımlı kalır → kenar-halkası doğru), yanlar quad.
  const idx: number[] = [];
  for (let i = 1; i < N - 1; i++) idx.push(0, i, i + 1);            // ön kapak
  for (let i = 1; i < N - 1; i++) idx.push(N, N + i + 1, N + i);    // arka kapak (ters sarım)
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    idx.push(i, j, N + j, i, N + j, N + i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  g.setIndex(idx);
  return g;
}

/** Taze ham kontur köşelerinin (u/v) kutusu + düzlem ofseti. */
function freshRawBox(freshRawVerts: Vec3[], n3: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3) {
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const p of freshRawVerts) {
    const pu = p[0] * u.x + p[1] * u.y + p[2] * u.z, pv = p[0] * v.x + p[1] * v.y + p[2] * v.z;
    if (pu < xMin) xMin = pu; if (pu > xMax) xMax = pu;
    if (pv < yMin) yMin = pv; if (pv > yMax) yMax = pv;
  }
  const f0 = freshRawVerts[0];
  return { xMin, xMax, yMin, yMax, xSpan: Math.max(xMax - xMin, 1e-6), ySpan: Math.max(yMax - yMin, 1e-6), planeD: f0[0] * n3.x + f0[1] * n3.y + f0[2] * n3.z };
}

/**
 * DAMGA TABANI = panelin KENDİ VF bölgesi (ham yüz konturu değil). Kutu
 * boyutu değiştiyse bölge kayıtlı rawFaceBBox'tan güncel ham kutuya taşınır:
 * boyut aynı → yalnız öteleme, değişti → oransal. Kayıtlı taban yoksa bölge
 * güncel düzleme izdüşürülür; ham yüzün dışına taşıyorsa ham kontura düşülür.
 */
function stampBaseVertsFromVf(vf: VirtualFace | undefined, freshRawVerts: Vec3[] | undefined): Vec3[] | undefined {
  if (!vf) return freshRawVerts;
  const region = vf.vertices as Vec3[] | undefined;
  if (!region || region.length < 3) return freshRawVerts;
  if (!freshRawVerts || freshRawVerts.length < 3) return region;
  const n3 = new THREE.Vector3(...vf.normal).normalize();
  const { u, v } = getFacePlaneAxes(n3);
  const dU = (a: Vec3) => a[0] * u.x + a[1] * u.y + a[2] * u.z;
  const dV = (a: Vec3) => a[0] * v.x + a[1] * v.y + a[2] * v.z;
  const nb = freshRawBox(freshRawVerts, n3, u, v);
  const at = (pu: number, pv: number): Vec3 => [
    u.x * pu + v.x * pv + n3.x * nb.planeD, u.y * pu + v.y * pv + n3.y * nb.planeD, u.z * pu + v.z * pv + n3.z * nb.planeD,
  ];
  const oldRaw = (vf as any).rawFaceBBox as RawBBox | undefined;
  if (!oldRaw) {
    for (const q of region) {
      const pu = dU(q), pv = dV(q);
      if (pu < nb.xMin - 1 || pu > nb.xMax + 1 || pv < nb.yMin - 1 || pv > nb.yMax + 1) return freshRawVerts;
    }
    return region.map(q => at(dU(q), dV(q)));
  }
  if (Math.abs(oldRaw.xSpan - nb.xSpan) < 1 && Math.abs(oldRaw.ySpan - nb.ySpan) < 1) {
    const du = (nb.xMin + nb.xMax) / 2 - (oldRaw.xMin + oldRaw.xMax) / 2;
    const dv = (nb.yMin + nb.yMax) / 2 - (oldRaw.yMin + oldRaw.yMax) / 2;
    return region.map(q => at(dU(q) + du, dV(q) + dv));
  }
  return region.map(q => at(
    nb.xMin + ((dU(q) - oldRaw.xMin) / oldRaw.xSpan) * nb.xSpan,
    nb.yMin + ((dV(q) - oldRaw.yMin) / oldRaw.ySpan) * nb.ySpan,
  ));
}

/**
 * Extrude'lu panelin DAMGASI: VF tabanı, adımların İŞARETLİ miktarı kadar
 * budanır (gerçek extrude ile birebir: ref → resolvedValue, fixed → value −
 * açıklık, dyn → value). Hedef yüze BAKAN adımın büyümesi yansıtılmaz
 * (komşu gereksiz kısalmasın); yalnız kısalma yansır.
 */
function trimmedStampGeometryFromVf(vf: VirtualFace, thickness: number, extrudeSteps: any[], targetFaceNormal: THREE.Vector3): THREE.BufferGeometry | null {
  if (!vf.vertices || vf.vertices.length < 3) return null;
  const trimmed: Vec3[] = vf.vertices.map(v => [...v] as Vec3);
  for (const step of extrudeSteps) {
    if (!step.faceNormal) continue;
    const eN = new THREE.Vector3(...step.faceNormal).normalize();
    const alignT = eN.dot(targetFaceNormal);
    if (alignT < -0.3) continue;   // hedef yüzden uzaklaşan extrude: yakın kenar yerinde
    const projs = trimmed.map(p => p[0] * eN.x + p[1] * eN.y + p[2] * eN.z);
    const resolved = step.resolvedValue !== undefined && step.resolvedValue !== null;
    const amount = resolved ? step.resolvedValue
      : step.isFixed ? (step.value ?? 0) - (Math.max(...projs) - Math.min(...projs))
      : (step.value ?? 0);
    console.log('[YAGO][DAMGA-TRIM]', 'eN=', [eN.x, eN.y, eN.z].map(n => n.toFixed(0)).join(','),
      resolved ? 'ref-çözülü' : step.isFixed ? 'fixed' : 'ref-ÇÖZÜLMEMİŞ/dyn',
      'value=', (step.value ?? 0).toFixed(1), 'amount=', amount.toFixed(1), Math.abs(amount) < 0.01 ? '→ TRIM YOK (tam boy)' : '→ trim');
    if (Math.abs(amount) < 0.01) continue;
    if (alignT > 0.7 && amount > 0) continue;
    const threshold = amount < 0 ? Math.max(...projs) + amount : Math.min(...projs) + amount;
    for (let i = 0; i < trimmed.length; i++) {
      if (amount < 0 ? projs[i] > threshold : projs[i] < threshold) {
        const delta = threshold - projs[i];
        trimmed[i][0] += delta * eN.x; trimmed[i][1] += delta * eN.y; trimmed[i][2] += delta * eN.z;
      }
    }
  }
  return buildPrismFromVertices(trimmed, vf.normal, thickness);
}

/**
 * ORANSAL DAMGA (düz panel, kutu boyutlanınca): panelin baked mesh'i henüz
 * eski boyuttadır; eski VF bölgesi eski ham kutudan yeni ham kutuya taşınarak
 * geçici damga üretilir. Boyut/konum değişmemişse null (baked mesh kullanılır).
 */
function scaledFlatPanelStamp(oldVf: VirtualFace, freshRawVerts: Vec3[], thickness: number): THREE.BufferGeometry | null {
  if (!oldVf.vertices || oldVf.vertices.length < 3 || freshRawVerts.length < 3) return null;
  const oldRaw = (oldVf as any).rawFaceBBox as RawBBox | undefined;
  if (!oldRaw) return null;
  const n3 = new THREE.Vector3(...oldVf.normal).normalize();
  const { u, v } = getFacePlaneAxes(n3);
  const nb = freshRawBox(freshRawVerts, n3, u, v);
  const nrm: Vec3 = [n3.x, n3.y, n3.z];
  if (Math.abs(oldRaw.xSpan - nb.xSpan) < 1 && Math.abs(oldRaw.ySpan - nb.ySpan) < 1) {
    const o0 = oldVf.vertices[0];
    const dN = nb.planeD - (o0[0] * n3.x + o0[1] * n3.y + o0[2] * n3.z);
    const dU = (nb.xMin + nb.xMax) / 2 - (oldRaw.xMin + oldRaw.xMax) / 2;
    const dV = (nb.yMin + nb.yMax) / 2 - (oldRaw.yMin + oldRaw.yMax) / 2;
    if (Math.abs(dN) < 0.5 && Math.abs(dU) < 0.5 && Math.abs(dV) < 0.5) return null;
    const dx = n3.x * dN + u.x * dU + v.x * dV, dy = n3.y * dN + u.y * dU + v.y * dV, dz = n3.z * dN + u.z * dU + v.z * dV;
    return buildPrismFromVertices(oldVf.vertices.map(([x, y, z]) => [x + dx, y + dy, z + dz] as Vec3), nrm, thickness);
  }
  const scaled = oldVf.vertices.map(xyz => {
    const nu = nb.xMin + ((xyz[0] * u.x + xyz[1] * u.y + xyz[2] * u.z - oldRaw.xMin) / oldRaw.xSpan) * nb.xSpan;
    const nv = nb.yMin + ((xyz[0] * v.x + xyz[1] * v.y + xyz[2] * v.z - oldRaw.yMin) / oldRaw.ySpan) * nb.ySpan;
    return [u.x * nu + v.x * nv + n3.x * nb.planeD, u.y * nu + v.y * nv + n3.y * nb.planeD, u.z * nu + v.z * nv + n3.z * nb.planeD] as Vec3;
  });
  return buildPrismFromVertices(scaled, nrm, thickness);
}

// ── YÜZ EŞLEME (VF → güncel gövde yüz grubu) ────────────────────────────────

/** Aynı yönlü yüzlerin eksen boyunca ayrık düzlemleri (sıralı); rank'teki düzlemin konumu. */
function resolveAxisPlaneByRank(faces: FaceData[], axisDirection: string, axisRank: number): number | null {
  const axis = axisDirection[0] as 'x' | 'y' | 'z';
  const axisVec = axisDirToVec(axisDirection.includes('-') ? `${axis}-` : `${axis}+`);
  const positions: number[] = [];
  for (const f of faces) if (f.normal.dot(axisVec) > 0.9) positions.push(f.center[axis]);
  if (positions.length === 0) return null;
  positions.sort((a, b) => a - b);
  const clusters: number[] = [];
  for (const p of positions) {
    if (clusters.length === 0 || Math.abs(p - clusters[clusters.length - 1]) > 1.0) clusters.push(p);
    else clusters[clusters.length - 1] = (clusters[clusters.length - 1] + p) / 2;
  }
  return axisRank < 0 || axisRank >= clusters.length ? null : clusters[axisRank];
}

/** Normalize merkezlerin düzlem-içi farkı (eksen bileşeni hariç). */
function inPlaneCenterDiff(a: Vec3, b: Vec3 | undefined, axisDirection: string): number {
  const skip = axisDirection[0] === 'x' ? 0 : axisDirection[0] === 'y' ? 1 : 2;
  let d = 0;
  for (let i = 0; i < 3; i++) if (i !== skip) d += Math.abs(a[i] - (b?.[i] ?? 0.5));
  return d;
}

/**
 * VF'nin güncel geometrideki yüz grubu. Öncelik: (1) ölçek-bağımsız kimlik
 * (aynı yönlü düzlemler içindeki RANK + düzlem-içi normalize merkez),
 * (2) descriptor (VF merkezini ±5 mm kapsıyorsa), (3) aynı düzlemdeki
 * adaylardan VF merkezine en yakın grup, (4) merkez-kutusu / reçete / en yakın.
 * Eğilmiş yüz (vertex düzenlemesi): normal süzgeci boşsa dot>0.5 olan en yakın grup.
 */
function findMatchingFaceGroup(vf: VirtualFace, faces: FaceData[], faceGroups: CoplanarFaceGroup[], geometry: THREE.BufferGeometry): CoplanarFaceGroup | null {
  const vfN = new THREE.Vector3(vf.normal[0], vf.normal[1], vf.normal[2]).normalize();
  const vfCenter = new THREE.Vector3(vf.center[0], vf.center[1], vf.center[2]);
  const groupBox = (g: CoplanarFaceGroup) => {
    const bb = new THREE.Box3();
    g.faceIndices.forEach(fi => { const f = faces[fi]; if (f) f.vertices.forEach(vv => bb.expandByPoint(vv)); });
    return bb;
  };
  const clampDistToGroup = (g: CoplanarFaceGroup) => { const bb = groupBox(g); return vfCenter.clone().clamp(bb.min, bb.max).distanceTo(vfCenter); };
  const candidateGroups = faceGroups.filter(g => vfN.dot(g.normal.clone().normalize()) > 0.95);

  if (candidateGroups.length === 0) {
    let best: CoplanarFaceGroup | null = null, bestD = Infinity, bestDot = 0;
    for (const g of faceGroups) {
      const dot = vfN.dot(g.normal.clone().normalize());
      if (dot <= 0.5) continue;
      const d = clampDistToGroup(g);
      if (d < bestD - 1e-6 || (Math.abs(d - bestD) <= 1e-6 && dot > bestDot)) { bestD = d; best = g; bestDot = dot; }
    }
    if (best) {
      console.log('[YAGO][VF-EĞİM]', vf.id, 'eğik yüz eşlendi: dot=', bestDot.toFixed(2), 'mesafe=', bestD.toFixed(1),
        'eskiN=', vf.normal.map(n => n.toFixed(2)).join(','), 'yeniN=', [best.normal.x, best.normal.y, best.normal.z].map(n => n.toFixed(2)).join(','));
    }
    return best;
  }

  const recipe = (vf as any).raycastRecipe;
  const desc: any = recipe?.faceGroupDescriptor ?? (vf as any).faceGroupDescriptor;
  if (desc?.axisDirection && desc.axisRank !== undefined && desc.axisRankCount !== undefined) {
    const wantPos = resolveAxisPlaneByRank(faces, desc.axisDirection, desc.axisRank);
    if (wantPos !== null) {
      const axis = (desc.axisDirection as string)[0] as 'x' | 'y' | 'z';
      const onPlane = candidateGroups.filter(g => Math.abs(g.center[axis] - wantPos) <= 1.0);
      if (onPlane.length === 1) return onPlane[0];
      if (onPlane.length > 1) {
        const bb = new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position') as THREE.BufferAttribute);
        const size = new THREE.Vector3(); bb.getSize(size);
        const norm = (p: THREE.Vector3): Vec3 => [
          size.x > 1e-6 ? (p.x - bb.min.x) / size.x : 0.5,
          size.y > 1e-6 ? (p.y - bb.min.y) / size.y : 0.5,
          size.z > 1e-6 ? (p.z - bb.min.z) / size.z : 0.5,
        ];
        let best: CoplanarFaceGroup | null = null, bestD = Infinity;
        for (const g of onPlane) {
          const d = inPlaneCenterDiff(norm(g.center), desc.normalizedCenter, desc.axisDirection);
          if (d < bestD) { bestD = d; best = g; }
        }
        if (best) return best;
      }
    }
  }

  if (vf.faceGroupDescriptor) {
    const matchedFace = findFaceByDescriptor(vf.faceGroupDescriptor, faces, geometry);
    const matchedGroup = matchedFace ? candidateGroups.find(g => g.faceIndices.includes(matchedFace.faceIndex)) : undefined;
    if (matchedGroup && clampDistToGroup(matchedGroup) <= 5) return matchedGroup;
  }
  if (candidateGroups.length === 1) return candidateGroups[0];

  // Aynı düzlemdeki kopuk yüzler: en iyi düzlem-ofsetine ±0.5 mm yakınlar içinden merkeze en yakın.
  const vfPlaneOffset = vfCenter.dot(vfN);
  const planeDiffOf = (g: CoplanarFaceGroup) => Math.abs(g.center.dot(g.normal.clone().normalize()) - vfPlaneOffset);
  let minPlaneDiff = Infinity;
  for (const g of candidateGroups) minPlaneDiff = Math.min(minPlaneDiff, planeDiffOf(g));
  if (minPlaneDiff < 5) {
    let best: CoplanarFaceGroup | null = null, bestD = Infinity;
    for (const g of candidateGroups.filter(g => planeDiffOf(g) <= minPlaneDiff + 0.5)) {
      const d = clampDistToGroup(g);
      if (d < bestD) { bestD = d; best = g; }
    }
    if (best) return best;
  }

  let bestGroup: CoplanarFaceGroup | null = null, bestDist = Infinity;
  for (const g of candidateGroups) {
    if (!groupBox(g).expandByScalar(5).containsPoint(vfCenter)) continue;
    const dist = vfCenter.distanceTo(g.center);
    if (dist < bestDist) { bestDist = dist; bestGroup = g; }
  }
  if (bestGroup) return bestGroup;

  if (recipe) {
    const matchedFace = findFaceByDescriptor(recipe.faceGroupDescriptor, faces, geometry);
    const matchedGroup = matchedFace ? candidateGroups.find(g => g.faceIndices.includes(matchedFace.faceIndex)) : undefined;
    if (matchedGroup) return matchedGroup;
  }
  bestDist = Infinity;
  for (const g of candidateGroups) {
    const dist = vfCenter.distanceTo(g.center);
    if (dist < bestDist) { bestDist = dist; bestGroup = g; }
  }
  return bestGroup;
}

// ── ANA GİRİŞ ────────────────────────────────────────────────────────────────

/** Panel dönmüş sayılır: rotate adımı (açıdan bağımsız) ya da VF-eğimli levha. */
function isRotatedPanel(p: any): boolean {
  const t = p?.parameters?.transformSteps;
  if (Array.isArray(t) && t.some((st: any) => st?.type === 'rotate')) return true;
  const rs = p?.parameters?.rotateSteps;
  if (Array.isArray(rs) && rs.length > 0) return true;
  return panelIsTiltedSlab(p);
}
const hasExtrudeSteps = (p: any) => Array.isArray(p?.parameters?.extrudeSteps) && p.parameters.extrudeSteps.length > 0;
const hasMoveSteps = (p: any) => Array.isArray(p?.parameters?.transformSteps) && p.parameters.transformSteps.some((st: any) => st?.type === 'move');
const hasExtrudeTowardFace = (p: any, n: THREE.Vector3) =>
  hasExtrudeSteps(p) && p.parameters.extrudeSteps.some((st: any) => st.faceNormal && new THREE.Vector3(...st.faceNormal).normalize().dot(n) > 0.7);

type RotOp = { kind?: 'rotate' | 'translate'; pivot?: THREE.Vector3; axis?: THREE.Vector3; angleRad?: number; d?: THREE.Vector3 };

/**
 * Bir parent'ın tüm VF'lerini güncel gövde geometrisi + kardeş ayak izleriyle
 * yeniden hesaplar (saf: yeni VF dizisi döner, store'a yazmaz).
 */
export function recalculateVirtualFacesForShape(shape: Shape, virtualFaces: VirtualFace[], allShapes?: any[]): VirtualFace[] {
  const shapeFaces = virtualFaces.filter(vf => vf.shapeId === shape.id);
  if (shapeFaces.length === 0 || !shape.geometry) return virtualFaces;

  // VERTEX DÜZENLEMELİ GÖVDE: VF'ler düzenlenmiş (etkin) yüzlere göre hesaplanır.
  const eff = effectiveBodyGeometry(shape);
  if (eff !== shape.geometry) {
    console.log('[YAGO][VERTEX] VF regen düzenlenmiş gövde geometrisiyle:', shape.id, 'düzenlemeN=', shape.vertexModifications?.length ?? 0);
    shape = { ...shape, geometry: eff };
  }
  const { faces, groups: faceGroups } = getFacesAndGroups(shape.geometry);
  const localToWorld = getShapeMatrix(shape);
  const worldToLocal = localToWorld.clone().invert();
  const childPanels = (allShapes || []).filter(s => s.type === 'panel' && s.parameters?.parentShapeId === shape.id);
  const vfById = new Map(virtualFaces.map(f => [f.id, f] as const));
  const vfIndexOf = new Map<string, number>();
  virtualFaces.forEach((f, i) => vfIndexOf.set(f.id, i));
  const panelPriority = (p: any) => vfIndexOf.get(p?.parameters?.virtualFaceId) ?? Number.MAX_SAFE_INTEGER;
  const refsCache = new Map<string, ReturnType<typeof stepRefTargets>>();
  const refsOf = (p: any) => { let r = refsCache.get(p.id); if (!r) { r = stepRefTargets(p); refsCache.set(p.id, r); } return r; };

  // ÖN-GEÇİŞ: her VF'nin eşleşen yüz grubu + konturu (regen de aynısını kullanır)
  // ve güncel HAM kontur köşeleri (damga tabanları için).
  const matchOf = new Map<string, { group: CoplanarFaceGroup; contour: ReturnType<typeof computeFaceComponentContour> } | null>();
  const freshVfVertices = new Map<string, Vec3[]>();
  for (const vf of shapeFaces) {
    const group = findMatchingFaceGroup(vf, faces, faceGroups, shape.geometry);
    const contour = group ? computeFaceComponentContour(faces, group.faceIndices,
      new THREE.Vector3(vf.center[0], vf.center[1], vf.center[2]), group.normal.clone().normalize()) : null;
    matchOf.set(vf.id, group ? { group, contour } : null);
    if (contour && contour.corners.length >= 3) freshVfVertices.set(vf.id, contour.corners.map(c => [c.x, c.y, c.z] as Vec3));
    else if (vf.vertices && vf.vertices.length >= 3) freshVfVertices.set(vf.id, vf.vertices);
  }
  // DAMGA TABANI: her VF için panelin KENDİ bölgesi (güncel ham kutuya taşınmış).
  const stampBaseVertices = new Map<string, Vec3[]>();
  for (const vf of shapeFaces) {
    const base = stampBaseVertsFromVf(vf, freshVfVertices.get(vf.id));
    if (base && base.length >= 3) stampBaseVertices.set(vf.id, base);
  }

  // İŞARETLİ EXTRUDE MİKTARI (damga-trim ile birebir): + uzuyor, − kısalıyor.
  const signedExtrudeAmountOf = (p: any, step: any, eN: THREE.Vector3): number => {
    if (step.resolvedValue !== undefined && step.resolvedValue !== null) return step.resolvedValue;
    if (!step.isFixed) return step.value ?? 0;
    const vfId = p?.parameters?.virtualFaceId;
    const verts = (vfId ? stampBaseVertices.get(vfId) : undefined) || (vfId ? freshVfVertices.get(vfId) : undefined) || (vfId ? vfById.get(vfId)?.vertices : undefined);
    if (!verts || verts.length < 3) return 0;
    let mn = Infinity, mx = -Infinity;
    for (const q of verts) { const pr = q[0] * eN.x + q[1] * eN.y + q[2] * eN.z; if (pr < mn) mn = pr; if (pr > mx) mx = pr; }
    return (step.value ?? 0) - (mx - mn);
  };
  // YÖN TESTİ: extrude adımı paneli bu yüze DOĞRU ilerletiyor mu ((miktar × eN)·n > 0)?
  const extrudeAdvancesTowardFace = (p: any, n: THREE.Vector3 | null): boolean => {
    if (!n || !hasExtrudeSteps(p)) return false;
    for (const step of p.parameters.extrudeSteps) {
      if (!step.faceNormal) continue;
      const eN = new THREE.Vector3(...step.faceNormal).normalize();
      const align = eN.dot(n);
      if (Math.abs(align) < 0.7) continue;
      if (signedExtrudeAmountOf(p, step, eN) * align > 0.01) return true;
    }
    return false;
  };

  /** p, VF'yi damgalama yetkisine sahip mi? (sıra önceliği + fiziksel ilerleme istisnası) */
  const stamps = (p: any, vfId: string, myPanel: any, myFaceNormal: THREE.Vector3 | null): boolean => {
    if (p.parameters?.virtualFaceId === vfId) return false;
    if (myPanel && refsOf(myPanel).extrude.has(p.id)) return false;
    if (myPanel && refsOf(p).rotate.has(myPanel.id)) {
      console.log('[YAGO][DAMGA-YETKI] RED', vfId, '<-', p.id, '— p bu paneli REF DÖNÜŞ HEDEFİ alıyor → bölge kırpılmaz, motor kenarı pahlar');
      return false;
    }
    const pIsRefBoundToMe = !!myPanel && refsOf(p).move.has(myPanel.id);
    if (myPanel && refsOf(p).extrude.has(myPanel.id) && extrudeAdvancesTowardFace(p, myFaceNormal)) return true;
    // Farklı yüzdeki taşınmış / yüze doğru extrude'lu panel sırayı devirebilir (datum hariç).
    const pVf = vfById.get(p.parameters?.virtualFaceId);
    if (pVf && myFaceNormal) {
      const sameFace = Math.abs(myFaceNormal.dot(new THREE.Vector3(...pVf.normal).normalize())) > 0.95;
      if (!sameFace && pIsRefBoundToMe && hasMoveSteps(p) && !extrudeAdvancesTowardFace(p, myFaceNormal)) {
        console.log('[YAGO][DAMGA-YETKI] RED', vfId, '<-', p.id, '— p bu paneli REF TAŞIMA HEDEFİ (datum) alıyor', '→ taşıma istisnası iptal, karar sıra önceliğine bırakıldı');
      }
      if (!sameFace && ((hasMoveSteps(p) && !pIsRefBoundToMe) || extrudeAdvancesTowardFace(p, myFaceNormal))) return true;
    }
    const myIdx = vfIndexOf.get(vfId);
    const byOrder = myIdx != null && panelPriority(p) < myIdx;
    if (!byOrder && myPanel && myFaceNormal && (refsOf(p).extrude.has(myPanel.id) || hasExtrudeTowardFace(p, myFaceNormal)) && !extrudeAdvancesTowardFace(p, myFaceNormal)) {
      console.log('[YAGO][DAMGA-YETKI] RED', vfId, '<-', p.id, '— extrude bu yüze doğru İLERLEMİYOR (kısalıyor/ilgisiz eksen)', '→ sıra önceliği korundu, gereksiz kısaltma engellendi');
    }
    return byOrder;
  };

  /**
   * p'nin DAMGA temsili (ayak izi hesabına giren nesne):
   *  • extrude'lu: VF tabanı (yüze doğru ilerliyorsa) ya da budanmış taban + adım ops'u
   *  • düz: kutu boyutlandıysa oransal damga (taşınmışsa ötelemesiyle), yoksa gerçek mesh
   *  • dönmüş: motorun yazdığı NİHAİ geometri (ops'suz, kesit yolu)
   * Extrude'suz panelde sonuç hedef yüzden bağımsızdır → panel başına bir kez.
   */
  const stampCache = new Map<string, any>();
  const stampOf = (p: any, myFaceNormal: THREE.Vector3 | null): any => {
    const key = hasExtrudeSteps(p) ? `${p.id}|${myFaceNormal ? `${myFaceNormal.x},${myFaceNormal.y},${myFaceNormal.z}` : '-'}` : p.id;
    if (stampCache.has(key)) return stampCache.get(key);
    const r = buildStamp(p, myFaceNormal);
    stampCache.set(key, r);
    return r;
  };
  const buildStamp = (p: any, myFaceNormal: THREE.Vector3 | null): any => {
    const ownVfRaw = vfById.get(p.parameters?.virtualFaceId);
    const ownVfFreshVerts = freshVfVertices.get(p.parameters?.virtualFaceId);
    const ownVf = ownVfRaw && ownVfFreshVerts ? { ...ownVfRaw, vertices: ownVfFreshVerts } : ownVfRaw;
    const ownVfStampVerts = ownVfRaw ? (stampBaseVertices.get(ownVfRaw.id) || ownVfFreshVerts) : undefined;
    const ownVfStamp = ownVfRaw && ownVfStampVerts ? { ...ownVfRaw, vertices: ownVfStampVerts } : ownVfRaw;
    // composeSteps (move/rotate) → ayak izine uygulanacak ops. REF taşıma deltası motorun
    // bu rebuild'de GERÇEKTEN uyguladığı değerden (_refDeltaApplied) okunur — tek kaynak.
    const composedFromSteps = (stampGeo?: THREE.BufferGeometry | null): RotOp[] | undefined => {
      if (!ownVf) return undefined;
      try {
        // Taze ham kontur köşeleri; bayat rawFaceBBox fixed telafisine karışmasın.
        const { ops } = composeSteps(getUnifiedSteps(p), { ...(ownVf as any), rawFaceBBox: undefined });
        const rda = p.parameters?._refDeltaApplied;
        const refDeltaApplied = Array.isArray(rda) && rda.length === 3 ? new THREE.Vector3(rda[0], rda[1], rda[2]) : null;
        let rpBox: THREE.Box3 | null = null;
        const gp = stampGeo?.getAttribute('position') as THREE.BufferAttribute | undefined;
        if (gp) rpBox = new THREE.Box3().setFromBufferAttribute(gp).applyMatrix4(getShapeMatrix(p));
        return ops.map((o: any) =>
          o.kind === 'rotate' ? { kind: 'rotate', pivot: o.pivot, axis: o.axis, angleRad: (o.deg * Math.PI) / 180 }
            : o.kind === 'refTranslate' ? { kind: 'translate', d: refDeltaApplied || (rpBox ? resolveRefTranslateDelta(o, rpBox) : o.fallback) }
              : { kind: 'translate', d: o.d });
      } catch { return undefined; }
    };

    if (hasExtrudeSteps(p) && ownVfStamp) {
      const th = panelThickness(p);
      if (myFaceNormal && hasExtrudeTowardFace(p, myFaceNormal) && extrudeAdvancesTowardFace(p, myFaceNormal)) {
        const baseGeo = ownVfStamp.vertices?.length >= 3 ? buildPrismFromVertices(ownVfStamp.vertices, ownVfStamp.normal, th) : null;
        if (baseGeo) return { ...p, geometry: baseGeo, __isRotatedPanel: true, __composedOps: composedFromSteps(baseGeo) || [] };
      } else if (myFaceNormal) {
        const trimGeo = trimmedStampGeometryFromVf(ownVfStamp, th, p.parameters.extrudeSteps, myFaceNormal);
        if (trimGeo) return { ...p, geometry: trimGeo, __isRotatedPanel: true, __composedOps: composedFromSteps(trimGeo) || [] };
      }
    }
    if (!isRotatedPanel(p)) {
      if (ownVfRaw && ownVfFreshVerts) {
        const scaled = scaledFlatPanelStamp(ownVfRaw, ownVfFreshVerts, panelThickness(p));
        if (scaled) {
          // Taşınmış düz panel: damga panelin çözülmüş ÖTELEMESİ kadar kaydırılır (dönmüş yola sokulmaz).
          if (hasMoveSteps(p)) {
            const ops = composedFromSteps(scaled);
            if (Array.isArray(ops) && ops.length > 0) {
              const d = new THREE.Vector3();
              for (const op of ops) if (op?.kind === 'translate' && op.d) d.add(op.d);
              if (d.lengthSq() > 1e-12) scaled.translate(d.x, d.y, d.z);
            }
          }
          return { ...p, geometry: scaled };
        }
      }
      return p;
    }
    // Dönmüş panel: store'daki geometri ZATEN dönmüş/sığdırılmış → ops'suz gerçek geometri.
    return { ...p, __isRotatedPanel: true, __rotatedRealGeom: true, __composedOps: [] };
  };

  const stampingPanelsFor = (vfId: string): any[] => {
    const myPanel = childPanels.find(p => p.parameters?.virtualFaceId === vfId);
    const myVf = vfById.get(vfId);
    const myFaceNormal = myVf ? new THREE.Vector3(...myVf.normal).normalize() : null;
    return childPanels.filter(p => stamps(p, vfId, myPanel, myFaceNormal)).map(p => stampOf(p, myFaceNormal));
  };

  const updatedMap = new Map<string, VirtualFace>();
  for (const vf of shapeFaces) {
    if (vf.parentFaceShape) {
      // TAM YÜZ MODELİ: yalnız parentFaceShape VF'ler kontur regen'ine girer.
      const m = matchOf.get(vf.id);
      const regen = m && m.contour ? regenerateParentFaceShapeVF(vf, shape.id, m.group, m.contour, worldToLocal, stampingPanelsFor(vf.id), vfById) : null;
      updatedMap.set(vf.id, regen || vf);
    } else {
      // ESKİ ışın-reçeteli VF: yüzü/merkezi değişmez, yalnız kırpılır.
      const clipped = clipVirtualFaceAgainstSubtractionsAndPanels(vf, shape.subtractionGeometries || [], stampingPanelsFor(vf.id), localToWorld, worldToLocal);
      updatedMap.set(vf.id, clipped || vf);
    }
  }
  return virtualFaces.map(vf => updatedMap.get(vf.id) || vf);
}

/**
 * VF = eşleşen yüz bileşeninin konturu ∩ serbest bölge (yakalama ile aynı
 * computeFreeRegionLocal). Seed (tıklama noktası) MUTLAK kalır, yalnız güncel
 * yüz düzlemine izdüşer ve yüz kutusuna kırpılır. Taraf sözleşmesi
 * (sideRelations) STORED-WINS birleşir → panel ilk yerleştiği tarafta kalır.
 */
function regenerateParentFaceShapeVF(
  vf: VirtualFace, shapeId: string, matchedGroup: CoplanarFaceGroup,
  contour: NonNullable<ReturnType<typeof computeFaceComponentContour>>,
  worldToLocal: THREE.Matrix4, siblingPanels: any[], vfById: Map<string, VirtualFace>,
): VirtualFace {
  const localNormal = matchedGroup.normal.clone().normalize();
  const seed = new THREE.Vector3(vf.center[0], vf.center[1], vf.center[2]);
  const { u, v } = getFacePlaneAxes(localNormal);
  const uvOf = (p3: THREE.Vector3) => ({ x: p3.dot(u), y: p3.dot(v) });
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const c of contour.corners) { const q = uvOf(c); xMin = Math.min(xMin, q.x); xMax = Math.max(xMax, q.x); yMin = Math.min(yMin, q.y); yMax = Math.max(yMax, q.y); }
  const newB: RawBBox = { xMin, xMax, yMin, yMax, xSpan: Math.max(xMax - xMin, 1e-6), ySpan: Math.max(yMax - yMin, 1e-6) };
  const cUV = uvOf(seed);
  const planeN = contour.corners[0].dot(localNormal);
  const newCenter = new THREE.Vector3()
    .addScaledVector(u, Math.max(newB.xMin, Math.min(newB.xMax, cUV.x)))
    .addScaledVector(v, Math.max(newB.yMin, Math.min(newB.yMax, cUV.y)))
    .addScaledVector(localNormal, planeN);

  const anchorB = ((vf as any).rawFaceBBox as RawBBox | undefined) ?? newB;
  if (anchorB !== newB && (Math.abs(anchorB.xSpan - newB.xSpan) > 1 || Math.abs(anchorB.ySpan - newB.ySpan) > 1)) {
    console.log('[YAGO][BOYUT-DEĞİŞİM]', vf.id, 'eskiBBox=', `${anchorB.xSpan.toFixed(0)}x${anchorB.ySpan.toFixed(0)}`,
      'yeniBBox=', `${newB.xSpan.toFixed(0)}x${newB.ySpan.toFixed(0)}`, '→ taraf sözleşmesi KORUNUYOR (kalıcı), seed mutlak');
  }
  const storedRel = (vf as any).sideRelations as Record<string, number> | undefined;
  const prevRegion = vf.vertices && vf.vertices.length >= 3 ? vf.vertices.map(([x, y, z]) => new THREE.Vector3(x, y, z)) : undefined;
  const region = computeFreeRegionLocal(contour.corners, localNormal, seed, siblingPanels, worldToLocal, shapeId, prevRegion, storedRel, !!vf.fitFaceShape);

  // TEŞHİS: her kardeşin bu yüzdeki ayak izi (çok parçalıysa parça parça).
  if (region) {
    const pieceCount = new Map<string, number>();
    for (const id of region.footprintIds) if (id) { const base = id.split('#')[0]; pieceCount.set(base, (pieceCount.get(base) || 0) + 1); }
    region.footprints.forEach((fp, f) => {
      const id = region.footprintIds[f];
      if (!id) return;
      const [base, k] = id.split('#');
      const sp = siblingPanels.find(s => s.id === base);
      let fuMin = Infinity, fuMax = -Infinity, fvMin = Infinity, fvMax = -Infinity;
      for (const q of fp) { fuMin = Math.min(fuMin, q.x); fuMax = Math.max(fuMax, q.x); fvMin = Math.min(fvMin, q.y); fvMax = Math.max(fvMax, q.y); }
      const n = pieceCount.get(base) || 1;
      console.log('[YAGO][AYAKİZİ]', vf.id, '<-', base, 'boyut=', `${(fuMax - fuMin).toFixed(0)}x${(fvMax - fvMin).toFixed(0)}`,
        'u=', `${fuMin.toFixed(0)}..${fuMax.toFixed(0)}`, 'v=', `${fvMin.toFixed(0)}..${fvMax.toFixed(0)}`, 'köşeN=', fp.length,
        (sp?.parameters?.rotateSteps?.length ?? 0) > 0 ? 'DÖNMÜŞ' : 'düz', n > 1 ? `parça ${(k ? Number(k) : 0) + 1}/${n}` : '');
    });
  }

  const cornersOut = region && region.polygon.length >= 3
    ? region.polygon.map(p2 => new THREE.Vector3().addScaledVector(u, p2.x).addScaledVector(v, p2.y).addScaledVector(localNormal, planeN))
    : contour.corners;
  let oU0 = Infinity, oU1 = -Infinity, oV0 = Infinity, oV1 = -Infinity;
  for (const c of cornersOut) { const q = uvOf(c); oU0 = Math.min(oU0, q.x); oU1 = Math.max(oU1, q.x); oV0 = Math.min(oV0, q.y); oV1 = Math.max(oV1, q.y); }
  const outUSpan = oU1 - oU0, outVSpan = oV1 - oV0;
  console.log('[YAGO][REGEN]', vf.id,
    'yeniMerkez=', [newCenter.x, newCenter.y, newCenter.z].map(n => n.toFixed(1)).join(','),
    'hamKöşeN=', contour.corners.length, 'VFköşeN=', cornersOut.length,
    'ayakİziN=', region ? region.footprints.length : -1, 'kardeşN=', siblingPanels.length,
    'oranTabanı=', (vf as any).rawFaceBBox ? 'kayıtlıHam' : 'mutlak(ilk)',
    'VFboyut=', `${outUSpan.toFixed(0)}x${outVSpan.toFixed(0)}`,
    'küçülme=', `u%${((1 - outUSpan / Math.max(newB.xSpan, 1e-6)) * 100).toFixed(0)} v%${((1 - outVSpan / Math.max(newB.ySpan, 1e-6)) * 100).toFixed(0)}`,
    outUSpan < 30 || outVSpan < 30 ? '⚠️KIYMIK(regen)' : 'dolu');

  const out: any = {
    ...vf,
    normal: [localNormal.x, localNormal.y, localNormal.z],
    vertices: cornersOut.map(c => [c.x, c.y, c.z] as Vec3),
    center: [newCenter.x, newCenter.y, newCenter.z],
  };
  // HAM kontur kutusu → bir sonraki regen'in taşıma/oran tabanı.
  out.rawFaceBBox = { ...newB };
  // TARAF SÖZLEŞMESİ: kayıtlı işaretler kazanır; region yalnız YENİ kardeşleri ekler.
  out.sideRelations = { ...(region?.sideRelations || {}), ...(storedRel || {}) };
  if (region?.anchor) {
    const a = new THREE.Vector3().addScaledVector(u, region.anchor.x).addScaledVector(v, region.anchor.y).addScaledVector(localNormal, planeN);
    out.regionAnchor = [a.x, a.y, a.z];
  }
  // TEMAS İLİŞKİLERİ: bu bölgeye değen kardeşler + yüz normalleri.
  const contactRelations: Array<{ panelId: string; faceNormal: Vec3; axis: string }> = [];
  for (const sibId of region?.touchingSiblingIds || []) {
    const sibVf = vfById.get(siblingPanels.find(sp => sp.id === sibId)?.parameters?.virtualFaceId);
    if (!sibVf) continue;
    const n = sibVf.normal as Vec3;
    const axis = Math.abs(n[0]) > 0.5 ? (n[0] > 0 ? 'x+' : 'x-') : Math.abs(n[1]) > 0.5 ? (n[1] > 0 ? 'y+' : 'y-') : (n[2] > 0 ? 'z+' : 'z-');
    contactRelations.push({ panelId: sibId, faceNormal: n, axis });
  }
  out.contactRelations = contactRelations.length > 0 ? contactRelations : undefined;
  if (contactRelations.length > 0) {
    console.log('[YAGO][TEMAS]', vf.id, 'temaslar=', contactRelations.map(c => `${c.panelId}(${c.axis})`).join(', '));
  }
  return out;
}

// ── ESKİ (ışın-reçeteli) VF YOLU: yalnız çıkarma + kardeş ayak izleriyle kırpma ──

function buildRotationOps(panel: any): RotOp[] {
  if (Array.isArray(panel?.__composedOps)) return panel.__composedOps;
  const params = panel?.parameters;
  if (!params) return [];
  const steps: any[] = Array.isArray(params.transformSteps) ? params.transformSteps.filter((s: any) => s?.type === 'rotate')
    : Array.isArray(params.rotateSteps) ? params.rotateSteps : [];
  const ops: RotOp[] = [];
  for (const s of steps) {
    const deg = typeof s.resolvedValue === 'number' ? s.resolvedValue : (s.value || 0);
    if (Math.abs(deg) < 1e-6) continue;
    ops.push({
      pivot: s.pivot ? new THREE.Vector3(...s.pivot) : new THREE.Vector3(),
      axis: s.axisVec ? new THREE.Vector3(...s.axisVec).normalize() : axisDirToVec(s.axis),
      angleRad: (deg * Math.PI) / 180,
    });
  }
  return ops;
}

function getPanelFootprints2D(panels: any[], n: THREE.Vector3, origin: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3, tol = 2.0): Point2D[][] {
  const footprints: Point2D[][] = [];
  for (const panel of panels) {
    const posAttr = panel.geometry?.getAttribute('position');
    if (!posAttr) continue;
    const m = getShapeMatrix(panel);
    const rotOps = panel.__isRotatedPanel ? buildRotationOps(panel) : null;
    const all: Point2D[] = [], onPlane: Point2D[] = [];
    let minD = Infinity, maxD = -Infinity;
    for (let i = 0; i < posAttr.count; i++) {
      const wp = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(m);
      if (rotOps) for (const op of rotOps) {
        if (op.kind === 'translate') { if (op.d) wp.add(op.d); }
        else if (op.pivot && op.axis) { wp.sub(op.pivot); wp.applyAxisAngle(op.axis, op.angleRad || 0); wp.add(op.pivot); }
      }
      const d = n.dot(new THREE.Vector3().subVectors(wp, origin));
      if (d < minD) minD = d; if (d > maxD) maxD = d;
      const p2 = projectTo2D(wp, origin, u, v);
      all.push(p2);
      if (Math.abs(d) < tol) onPlane.push(p2);
    }
    // Düzleme hiç değmeyen (paralel/uzak) panel ayak izi üretmez.
    if (minD > tol || maxD < -tol) continue;
    if (rotOps) {
      // Dönmüş/sentetik damga: tüm köşelerin konveks gövdesi (tam siluet).
      if (all.length < 3) continue;
      const hull = convexHull2D(all);
      if (hull.length >= 3) footprints.push(hull);
      continue;
    }
    const pts = onPlane.length >= 3 ? onPlane : all;
    if (pts.length < 3) continue;
    const boundary = meshOnPlaneBoundary2D(panel.geometry, m, n, origin, u, v, tol);
    if (boundary && boundary.length >= 3) { footprints.push(boundary); continue; }
    const hull = convexHull2D(pts);
    if (hull.length >= 3) footprints.push(hull);
  }
  return footprints;
}

function clipVirtualFaceAgainstSubtractionsAndPanels(
  vf: VirtualFace, subtractions: any[], siblingPanels: any[], localToWorld: THREE.Matrix4, worldToLocal: THREE.Matrix4
): VirtualFace | null {
  if (vf.vertices.length < 3) return null;
  const worldNormal = new THREE.Vector3(vf.normal[0], vf.normal[1], vf.normal[2]).normalize()
    .applyMatrix3(new THREE.Matrix3().getNormalMatrix(localToWorld)).normalize();
  const { u, v } = getFacePlaneAxes(worldNormal);
  const cornersWorld = vf.vertices.map(vtx => new THREE.Vector3(vtx[0], vtx[1], vtx[2]).applyMatrix4(localToWorld));
  const planeOrigin = new THREE.Vector3();
  cornersWorld.forEach(c => planeOrigin.add(c));
  planeOrigin.divideScalar(cornersWorld.length);
  let poly: Point2D[] = ensureCCW(cornersWorld.map(c => projectTo2D(c, planeOrigin, u, v)));
  const allFootprints = [
    ...getSubtractorFootprints2D(subtractions, localToWorld, worldNormal, planeOrigin, u, v, 50),
    ...getPanelFootprints2D(siblingPanels, worldNormal, planeOrigin, u, v, 3.0),
  ];
  let changed = false;
  for (const fp of allFootprints) {
    const ccwFp = ensureCCW(fp);
    if (ccwFp.some(p => isPointInsidePolygon(p, poly)) || poly.some(p => isPointInsidePolygon(p, ccwFp))) {
      poly = subtractPolygon(poly, ccwFp);
      changed = true;
    }
  }
  if (!changed || poly.length < 3) return null;
  const newCornersLocal = poly.map(p => planeOrigin.clone().addScaledVector(u, p.x).addScaledVector(v, p.y).applyMatrix4(worldToLocal));
  const newCenter = new THREE.Vector3();
  newCornersLocal.forEach(c => newCenter.add(c));
  newCenter.divideScalar(newCornersLocal.length);
  return { ...vf, vertices: newCornersLocal.map(c => [c.x, c.y, c.z] as Vec3), center: [newCenter.x, newCenter.y, newCenter.z] };
}
