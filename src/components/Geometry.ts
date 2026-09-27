import * as THREE from 'three';
import type { FaceDescriptor, FilletInfo, SubtractedGeometry, VirtualFace } from '../store';
import { setOC } from 'replicad';
import initOpenCascade from 'opencascade.js';

/* ═══════════════════════════════════════════════════════════════════════════
   GEOMETRİ ÇEKİRDEĞİ — (A) saf three.js matematiği, mesh yüz çıkarımı, VF/kutu
   yardımcıları; (B) replicad/OpenCascade katı model servisi: kutu, boolean,
   VF'den panel, vertex düzenlemeleri, fillet, gövde yeniden kurma, Apply.
   ═══════════════════════════════════════════════════════════════════════════ */
// ═══════════════════════════════════════════════════════════════════════════
// Geometry — SAF GEOMETRİ ÇEKİRDEĞİ (store'suz, React'siz).
//  1. Küçük ortak yardımcılar: eksen harfi ↔ vektör/indeks, şekil matrisi,
//     kutu/oran, kimlik/yuvarlama/log biçimleri (eski PanelMath + kopyaları).
//  2. VF düzlem tabanı + oransal çıpalar, dönüş açısı çözücüleri.
//  3. Mesh yüz çıkarımı + eş-düzlem gruplama + yüz tanımlayıcı (eski GeometryUtils).
// ═══════════════════════════════════════════════════════════════════════════

export type Vec3 = [number, number, number];
export type AxisDir = 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-';
export type AxisLetter = 'x' | 'y' | 'z';

// ── 1. ORTAK KÜÇÜK YARDIMCILAR ───────────────────────────────────────────────

/** Benzersiz kimlik: `${prefix}-${zaman}-${rastgele}`. */
export const genId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
/** 0.1 mm'e yuvarla. */
export const round1 = (v: number) => Math.round(v * 10) / 10;
/** Hata nesnesi → mesaj (log). */
export const errMsg = (e: unknown) => (e as any)?.message || String(e);
/** Vektör → "x,y,z" (log). */
export const fmtVec = (v: { x: number; y: number; z: number }, digits = 1) => [v.x, v.y, v.z].map(n => n.toFixed(digits)).join(',');
/** replicad bounds → "x,y,z..x,y,z" (log). */
export const fmtBounds = (shape: any) => shape.boundingBox.bounds.map((v: number[]) => v.map(n => n.toFixed(0)).join(',')).join('..');
/** THREE kutusu → "x,y,z..x,y,z" (log). */
export const fmtBox3 = (b: THREE.Box3) => `${fmtVec(b.min, 0)}..${fmtVec(b.max, 0)}`;

/** 'x' | 'x+' | 'x-' … → 0/1/2. */
export const axisIndexOf = (axis: string): 0 | 1 | 2 => (axis[0] === 'x' ? 0 : axis[0] === 'y' ? 1 : 2);

/** 'x+' | 'y-' … → birim vektör (tanımsız harf → sıfır vektör). */
export function axisDirToVec(a: string): THREE.Vector3 {
  const v = new THREE.Vector3();
  const i = 'xyz'.indexOf(a[0] || '');
  if (i >= 0) v.setComponent(i, a[1] === '-' ? -1 : 1);
  return v;
}

/** Dünya ekseni harfi ('x' | 'y' | 'z') → birim vektör. */
export function axisLetterVec(axis: string): THREE.Vector3 {
  return new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
}

/** Vektörün baskın ekseni: 'X+' | 'Y-' … (eşitlikte x > y > z; işaret `> 0`). */
export function dominantAxisLabel(v: { x: number; y: number; z: number }): string {
  const a = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)];
  const i = a.indexOf(Math.max(...a));
  return i === 0 ? (v.x > 0 ? 'X+' : 'X-') : i === 1 ? (v.y > 0 ? 'Y+' : 'Y-') : (v.z > 0 ? 'Z+' : 'Z-');
}

/** Normal bir dünya eksenine paralel mi (0.999 eşiği)? */
export const FLAT_NORMAL_THRESHOLD = 0.999;
export const isFlatNormal = (n: { x: number; y: number; z: number }, tol = FLAT_NORMAL_THRESHOLD) =>
  Math.abs(n.x) > tol || Math.abs(n.y) > tol || Math.abs(n.z) > tol;

/** Şeklin yerel → dünya matrisi (position · Euler XYZ · scale). */
export function getShapeMatrix(shape: any): THREE.Matrix4 {
  const s = shape.scale ?? [1, 1, 1];
  return new THREE.Matrix4().compose(
    new THREE.Vector3(shape.position[0], shape.position[1], shape.position[2]),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(shape.rotation[0], shape.rotation[1], shape.rotation[2], 'XYZ')),
    new THREE.Vector3(s[0], s[1], s[2])
  );
}

/** Geometrinin yerel sınır kutusu (position tamponu yoksa null). */
export function localBboxOf(geometry: THREE.BufferGeometry | undefined | null): THREE.Box3 | null {
  const pos = geometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
  return pos ? new THREE.Box3().setFromBufferAttribute(pos) : null;
}

/** Geometrinin, şeklin dünya matrisiyle taşınmış sınır kutusu. */
export function worldBboxOf(shape: any, geometry: THREE.BufferGeometry | undefined): THREE.Box3 | null {
  const bb = localBboxOf(geometry);
  return bb ? bb.applyMatrix4(getShapeMatrix(shape)) : null;
}

/** Yerel kutu, yalnız konumla ötelenmiş (dönüşsüz şekiller için hızlı yol). */
export function translatedBboxOf(shape: any): THREE.Box3 | null {
  const bb = localBboxOf(shape?.geometry);
  return bb ? bb.translate(new THREE.Vector3(...(shape.position as Vec3))) : null;
}

/** Yüz düzlemi 2B tabanı (bölge/ayak izi hesaplarının tek u/v kuralı). */
export function getFacePlaneAxes(normal: THREE.Vector3): { u: THREE.Vector3; v: THREE.Vector3 } {
  const n = normal.clone().normalize();
  const absX = Math.abs(n.x), absY = Math.abs(n.y), absZ = Math.abs(n.z);
  const up = absY > absX && absY > absZ ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(n, up).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  return { u, v };
}

/** Panel kalınlığı (parametre; yoksa 18). */
export function panelThickness(shape: any): number {
  return parseFloat(shape?.parameters?.panelThickness) || 18;
}

/** Noktaların bir yön boyunca izdüşüm aralığı. */
export function projRange(pts: Iterable<THREE.Vector3>, dir: THREE.Vector3): { min: number; max: number } {
  let min = Infinity, max = -Infinity;
  for (const p of pts) { const d = p.dot(dir); if (d < min) min = d; if (d > max) max = d; }
  return { min, max };
}

/** Noktanın kutudaki oranı, [0,1]'e kırpılmış. */
export function fracInBox(box: THREE.Box3, p: Vec3): Vec3 {
  const fr = (a: number, b: number, x: number) => (Math.abs(b - a) < 1e-9 ? 0 : (x - a) / (b - a));
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  return [clamp01(fr(box.min.x, box.max.x, p[0])), clamp01(fr(box.min.y, box.max.y, p[1])), clamp01(fr(box.min.z, box.max.z, p[2]))];
}

export function pointFromFracBox(box: THREE.Box3, f: Vec3): THREE.Vector3 {
  return new THREE.Vector3(
    box.min.x + f[0] * (box.max.x - box.min.x),
    box.min.y + f[1] * (box.max.y - box.min.y),
    box.min.z + f[2] * (box.max.z - box.min.z),
  );
}

/** replicad kutusu (bounds) ile THREE kutusu 0.5 mm paydan fazla örtüşüyor mu? */
export function boundsOverlapBox(rb: number[][], bb: THREE.Box3): boolean {
  return rb[0][0] < bb.max.x - 0.5 && rb[1][0] > bb.min.x + 0.5
    && rb[0][1] < bb.max.y - 0.5 && rb[1][1] > bb.min.y + 0.5
    && rb[0][2] < bb.max.z - 0.5 && rb[1][2] > bb.min.z + 0.5;
}

/** Mesh köşeleri, 1/scale mm'de tekilleştirilmiş (tampon sırası korunur; varsayılan 0.1 mm). */
export function uniqueMeshPoints(geometry: THREE.BufferGeometry, scale = 10): THREE.Vector3[] {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const pts: THREE.Vector3[] = [];
  if (!pos) return pts;
  const seen = new Set<string>();
  for (let i = 0; i < pos.count; i++) {
    const p = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
    const key = `${Math.round(p.x * scale)},${Math.round(p.y * scale)},${Math.round(p.z * scale)}`;
    if (seen.has(key)) continue;
    seen.add(key); pts.push(p);
  }
  return pts;
}

/** EdgesGeometry → [x,y,z][] çizgi uçları (drei Line beslemesi). */
export function edgePointsOf(geometry: THREE.BufferGeometry, thresholdDeg = 15): [number, number, number][] {
  const eg = new THREE.EdgesGeometry(geometry, thresholdDeg);
  const pos = eg.getAttribute('position') as THREE.BufferAttribute;
  const pts: [number, number, number][] = [];
  for (let i = 0; i < pos.count; i++) pts.push([pos.getX(i), pos.getY(i), pos.getZ(i)]);
  eg.dispose();
  return pts;
}

// ── 2. VF DÜZLEM TABANI + ORANSAL ÇIPALAR ────────────────────────────────────
// Pivot ve nişan noktası VF dikdörtgenine ORANSAL (u/v ∈ [0,1] + normal ofseti)
// saklanır: yüz büyüyüp küçüldükçe nokta yüzle kayar; yakalama ve rebuild aynı
// tabanı (vfPlaneBasis) kullanır. NOT: bu taban getFacePlaneAxes'tan farklıdır
// ve kayıtlı pivotVfFrac/refArmVfFrac değerleri bu tabana bağlıdır — birleştirilemez.

/** Deterministik VF düzlem tabanı — yakalama ve rebuild aynı kuralı kullanır. */
function vfPlaneBasis(normal: Vec3 | number[]): { n: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3 } {
  const n = new THREE.Vector3(normal[0], normal[1], normal[2]).normalize();
  const up = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(up, n).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  return { n, u, v };
}

type VfLike = { normal: Vec3 | number[]; vertices: Array<Vec3 | number[]> };

/** VF köşelerinin vfPlaneBasis tabanındaki kutusu (nOff = düzlem ofseti). */
function vfUvBox(vf: VfLike) {
  const { n, u, v } = vfPlaneBasis(vf.normal);
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity, nOff = 0;
  for (const c of vf.vertices) {
    const w = new THREE.Vector3(c[0], c[1], c[2]);
    uMin = Math.min(uMin, w.dot(u)); uMax = Math.max(uMax, w.dot(u));
    vMin = Math.min(vMin, w.dot(v)); vMax = Math.max(vMax, w.dot(v));
    nOff = w.dot(n);
  }
  return { n, u, v, uMin, uMax, vMin, vMax, nOff };
}

/** Dünya noktasının VF dikdörtgenindeki oranı (u/v ∈ [0,1]) + normal ofseti. */
export function vfFracOfPoint(vf: VfLike | undefined | null, point: Vec3): Vec3 | undefined {
  if (!vf?.normal || !Array.isArray(vf.vertices) || vf.vertices.length < 3) return undefined;
  const b = vfUvBox(vf);
  const pw = new THREE.Vector3(...point);
  const su = Math.max(b.uMax - b.uMin, 1e-6), sv = Math.max(b.vMax - b.vMin, 1e-6);
  return [
    Math.max(0, Math.min(1, (pw.dot(b.u) - b.uMin) / su)),
    Math.max(0, Math.min(1, (pw.dot(b.v) - b.vMin) / sv)),
    pw.dot(b.n) - b.nOff,
  ];
}

/** vfFracOfPoint'in tersi: oransal çıpayı GÜNCEL VF'den dünya noktasına çözer. */
export function resolveVfFracPoint(frac: Vec3, vf: VfLike): THREE.Vector3 {
  const b = vfUvBox(vf);
  const [fu, fv, dn] = frac;
  return new THREE.Vector3()
    .addScaledVector(b.u, b.uMin + fu * (b.uMax - b.uMin))
    .addScaledVector(b.v, b.vMin + fv * (b.vMax - b.vMin))
    .addScaledVector(b.n, b.nOff + dn);
}

/** Kullanıcının dünya ekseni harfini panelin VF tabanındaki en yakın yerel eksene eşler. */
export function mapAxisToVfLocal(vf: { normal: Vec3 | number[] } | undefined | null, axis: AxisLetter): Vec3 | undefined {
  if (!vf?.normal) return undefined;
  const { n, u, v } = vfPlaneBasis(vf.normal);
  const wa = axisLetterVec(axis);
  const du = Math.abs(wa.dot(u)), dv = Math.abs(wa.dot(v)), dn = Math.abs(wa.dot(n));
  const chosen = dn >= du && dn >= dv ? n : du >= dv ? u : v;
  return [chosen.x, chosen.y, chosen.z];
}

/**
 * FIXED taşıma referansı: VF'nin HAM yüz konumunun taşıma ekseni boyunca min
 * değeri (rawFaceBBox varsa ondan, yoksa VF köşelerinden). Fixed adımda yüz ne
 * kadar kaydıysa o kadar ters öteleme eklenir → panel mutlak konumda kalır.
 */
export function vfRawMinAlong(vf: VirtualFace, axisLetter: string): number | null {
  if (!vf?.vertices || vf.vertices.length < 3) return null;
  const a = axisDirToVec(axisLetter);
  const p = new THREE.Vector3(Math.abs(a.x), Math.abs(a.y), Math.abs(a.z));
  if (p.lengthSq() < 0.5) return null;
  const n = new THREE.Vector3(...(vf.normal as Vec3)).normalize();
  const c0 = vf.vertices[0];
  const planeD = c0[0] * n.x + c0[1] * n.y + c0[2] * n.z;
  const rb = (vf as any).rawFaceBBox as { xMin: number; xMax: number; yMin: number; yMax: number } | undefined;
  let min = Infinity;
  if (rb) {
    const { u, v } = getFacePlaneAxes(n);
    for (const x of [rb.xMin, rb.xMax]) for (const y of [rb.yMin, rb.yMax]) {
      const w = new THREE.Vector3().addScaledVector(u, x).addScaledVector(v, y).addScaledVector(n, planeD);
      min = Math.min(min, w.dot(p));
    }
  } else {
    for (const c of vf.vertices) min = Math.min(min, c[0] * p.x + c[1] * p.y + c[2] * p.z);
  }
  return Number.isFinite(min) ? min : null;
}

// ── DÖNÜŞ AÇISI ÇÖZÜCÜLERİ ───────────────────────────────────────────────────

/** Noktayı pivot etrafında eksen boyunca deg derece döndürür. */
export function rotateAboutAxis(pt: THREE.Vector3, pivot: THREE.Vector3, axis: THREE.Vector3, deg: number): THREE.Vector3 {
  const q = new THREE.Quaternion().setFromAxisAngle(axis.clone().normalize(), (deg * Math.PI) / 180);
  return pt.clone().sub(pivot).applyQuaternion(q).add(pivot);
}

/**
 * ÇEMBER ∩ DÜZLEM: pivot etrafında dönen nişan noktası düzleme hangi açıda
 * değer? A cosθ + B sinθ = c'nin iki kökünden `prefer`e en yakını. Ulaşılamıyorsa
 * en yakın yaklaşma açısı (touched=false); nişan eksen üstündeyse null.
 */
export function angleToTouchPlane(
  pivot: THREE.Vector3, arm: THREE.Vector3, axis: THREE.Vector3,
  planeNormal: THREE.Vector3, planePoint: THREE.Vector3, prefer = 0
): { deg: number; touched: boolean } | null {
  const u = axis.clone().normalize();
  const n = planeNormal.clone().normalize();
  const a0 = arm.clone().sub(pivot);
  const aPar = u.clone().multiplyScalar(u.dot(a0));
  const aPerp = a0.clone().sub(aPar);
  if (aPerp.length() < 1e-6) return null;
  const w = new THREE.Vector3().crossVectors(u, aPerp);
  const A = n.dot(aPerp), B = n.dot(w);
  const c = n.dot(planePoint) - n.dot(pivot) - n.dot(aPar);
  const R = Math.hypot(A, B);
  if (R < 1e-9) return null;
  const phi = Math.atan2(B, A);
  if (Math.abs(c) > R) return { deg: normDeg(c > 0 ? phi : phi + Math.PI), touched: false };
  const delta = Math.acos(Math.max(-1, Math.min(1, c / R)));
  const roots = [normDeg(phi - delta), normDeg(phi + delta)];
  const off = (d: number) => Math.abs(((d - prefer + 540) % 360) - 180);
  return { deg: roots.reduce((best, d) => (off(d) < off(best) ? d : best)), touched: true };
}

/** Radyan → (−180, 180] derece. */
export function normDeg(rad: number): number {
  let d = (rad * 180) / Math.PI;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}

// ── 3. MESH YÜZLERİ + EŞ-DÜZLEM GRUPLAR ──────────────────────────────────────

export interface FaceData {
  faceIndex: number;
  normal: THREE.Vector3;
  center: THREE.Vector3;
  vertices: THREE.Vector3[];
  area: number;
  isCurved?: boolean;
}

export interface CoplanarFaceGroup {
  normal: THREE.Vector3;
  faceIndices: number[];
  center: THREE.Vector3;
  totalArea: number;
  isCurved?: boolean;
}

const angleDeg = (a: THREE.Vector3, b: THREE.Vector3) => Math.acos(Math.min(1, Math.max(-1, a.dot(b)))) * (180 / Math.PI);

export function extractFacesFromGeometry(geometry: THREE.BufferGeometry): FaceData[] {
  const faces: FaceData[] = [];
  const positionAttribute = geometry.getAttribute('position');
  if (!positionAttribute) { console.warn('No position attribute found in geometry'); return faces; }
  const positions = positionAttribute.array as Float32Array;
  const indices = geometry.getIndex()?.array as Uint16Array | Uint32Array | undefined;
  const faceCount = Math.floor((indices ? indices.length : positions.length / 3) / 3);
  const at = (i: number) => new THREE.Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  for (let i = 0; i < faceCount; i++) {
    const v0 = at(indices ? indices[i * 3] : i * 3);
    const v1 = at(indices ? indices[i * 3 + 1] : i * 3 + 1);
    const v2 = at(indices ? indices[i * 3 + 2] : i * 3 + 2);
    const edge1 = new THREE.Vector3().subVectors(v1, v0);
    const edge2 = new THREE.Vector3().subVectors(v2, v0);
    const normal = new THREE.Vector3().crossVectors(edge1, edge2).normalize();
    const center = new THREE.Vector3().add(v0).add(v1).add(v2).divideScalar(3);
    const area = edge1.cross(edge2).length() / 2;
    faces.push({ faceIndex: i, normal, center, vertices: [v0, v1, v2], area });
  }
  return faces;
}

/** Yüz tipi: eksen hizalı ya da eş-düzlem komşusu olan (miter/eğik) yüz düz; aksi eğri. */
function calculateSurfaceType(face: FaceData, faces: FaceData[], adjacencyMap: Map<number, Set<number>>): 'flat' | 'curved' {
  if (isFlatNormal(face.normal)) return 'flat';
  const neighbors = adjacencyMap.get(face.faceIndex);
  if (!neighbors || neighbors.size === 0) return 'curved';
  for (const neighborIdx of neighbors) if (angleDeg(face.normal, faces[neighborIdx].normal) < 2) return 'flat';
  return 'curved';
}

/**
 * Köşe paylaşan üçgenlerin komşuluk haritası (paylaşım toleransı 0.001, `<`).
 * Uzamsal ızgara (hücre = tolerans, 27 komşu hücre) ile O(F) — eski ikili
 * O(F²) taramayla BİREBİR aynı sonuç; komşu kümeleri artan indeks sırasıyla
 * doldurulur (gruplama gezinme sırası değişmez).
 */
function buildAdjacencyMap(faces: FaceData[], tolerance = 0.001): Map<number, Set<number>> {
  const cellOf = (x: number) => Math.floor(x / tolerance);
  const grid = new Map<string, Array<{ fi: number; p: THREE.Vector3 }>>();
  faces.forEach((f, fi) => {
    for (const p of f.vertices) {
      const k = `${cellOf(p.x)},${cellOf(p.y)},${cellOf(p.z)}`;
      const list = grid.get(k);
      if (list) list.push({ fi, p }); else grid.set(k, [{ fi, p }]);
    }
  });
  const adjacencyMap = new Map<number, Set<number>>();
  faces.forEach((f, i) => {
    const near = new Set<number>();
    for (const p of f.vertices) {
      const cx = cellOf(p.x), cy = cellOf(p.y), cz = cellOf(p.z);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const list = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
        if (!list) continue;
        for (const e of list) if (e.fi !== i && !near.has(e.fi) && p.distanceTo(e.p) < tolerance) near.add(e.fi);
      }
    }
    adjacencyMap.set(i, new Set([...near].sort((a, b) => a - b)));
  });
  return adjacencyMap;
}

function groupCoplanarFaces(faces: FaceData[], thresholdAngleDegrees = 10): CoplanarFaceGroup[] {
  const groups: CoplanarFaceGroup[] = [];
  const visited = new Set<number>();
  const adjacencyMap = buildAdjacencyMap(faces);
  const surfaceTypes = new Map<number, 'flat' | 'curved'>();
  faces.forEach((face) => {
    const surfaceType = calculateSurfaceType(face, faces, adjacencyMap);
    surfaceTypes.set(face.faceIndex, surfaceType);
    face.isCurved = surfaceType === 'curved';
  });
  for (let startIdx = 0; startIdx < faces.length; startIdx++) {
    if (visited.has(startIdx)) continue;
    const currentGroup: number[] = [startIdx];
    visited.add(startIdx);
    const stack: number[] = [startIdx];
    const startSurfaceType = surfaceTypes.get(startIdx) || 'curved';
    const effectiveThreshold = startSurfaceType === 'curved' ? 45 : thresholdAngleDegrees;
    while (stack.length > 0) {
      const currIdx = stack.pop()!;
      const neighbors = adjacencyMap.get(currIdx);
      if (!neighbors) continue;
      for (const neighborIdx of neighbors) {
        if (visited.has(neighborIdx) || startSurfaceType !== (surfaceTypes.get(neighborIdx) || 'curved')) continue;
        if (angleDeg(faces[currIdx].normal, faces[neighborIdx].normal) < effectiveThreshold) {
          visited.add(neighborIdx);
          currentGroup.push(neighborIdx);
          stack.push(neighborIdx);
        }
      }
    }
    const avgCenter = new THREE.Vector3(), avgNormal = new THREE.Vector3();
    let totalArea = 0;
    for (const idx of currentGroup) { const f = faces[idx]; avgCenter.add(f.center); avgNormal.add(f.normal); totalArea += f.area; }
    avgCenter.divideScalar(currentGroup.length);
    avgNormal.divideScalar(currentGroup.length).normalize();
    groups.push({ normal: avgNormal, faceIndices: currentGroup, center: avgCenter, totalArea, isCurved: startSurfaceType === 'curved' });
  }
  return groups;
}

/**
 * Geometri başına ÖNBELLEKLİ yüz + düz grup çıkarımı. Anahtar: BufferGeometry
 * nesnesi + position tamponu (dizi kimliği + sürüm) — geometri yerinde değişirse
 * yeniden hesaplanır. DÖNEN DİZİLER PAYLAŞIMLIDIR: çağıran yerinde değiştirmemeli.
 */
const _faceGroupCache = new WeakMap<THREE.BufferGeometry, { arr: unknown; ver: number; faces: FaceData[]; groups: CoplanarFaceGroup[] }>();
export function getFacesAndGroups(geometry: THREE.BufferGeometry): { faces: FaceData[]; groups: CoplanarFaceGroup[] } {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  const idx = geometry.getIndex();
  const ver = (pos?.version ?? 0) * 1e6 + (idx?.version ?? 0);
  const hit = _faceGroupCache.get(geometry);
  if (hit && hit.arr === pos?.array && hit.ver === ver) return hit;
  const faces = extractFacesFromGeometry(geometry);
  const groups = groupCoplanarFaces(faces);
  const entry = { arr: pos?.array, ver, faces, groups };
  _faceGroupCache.set(geometry, entry);
  return entry;
}

/** Mesh yüz indeksi → grup indeksi (yoksa -1). */
export function groupIndexOfFace(groups: CoplanarFaceGroup[], faceIndex: number | undefined): number {
  if (faceIndex === undefined) return -1;
  return groups.findIndex(g => g.faceIndices.includes(faceIndex));
}

/**
 * Bir yüz grubunu hover/seçim için en uygun DÜZ (eksen hizalı) gruba eşler. Grup
 * zaten düzse ya da düz-olmayan ama coplanar (isCurved=false) ise olduğu gibi
 * döner; yalnız gerçekten eğri gruplar en yakın aynı-eksenli düz gruba çekilir.
 */
export function snapToFlatGroup(gi: number, groups: CoplanarFaceGroup[]): number {
  if (gi < 0 || gi >= groups.length) return gi;
  const group = groups[gi];
  const n = group.normal.clone().normalize();
  if (isFlatNormal(n) || !group.isCurved) return gi;
  const axLbl = dominantAxisLabel(n);
  let bestIdx = gi, bestDist = Infinity;
  groups.forEach((g, idx) => {
    const gn = g.normal.clone().normalize();
    if (isFlatNormal(gn) && dominantAxisLabel(gn) === axLbl) {
      const d = g.center.distanceTo(group.center);
      if (d < bestDist) { bestDist = d; bestIdx = idx; }
    }
  });
  return bestIdx;
}

/** Yüz indeksi → düz gruba çekilmiş grup indeksi (tıklama/hover yolu). */
export const flatGroupOfFace = (groups: CoplanarFaceGroup[], faceIndex: number | undefined) =>
  snapToFlatGroup(groupIndexOfFace(groups, faceIndex), groups);

export function createGroupBoundaryEdges(faces: FaceData[], groups: CoplanarFaceGroup[]): THREE.BufferGeometry {
  const edgeVertices: number[] = [];
  const faceToGroup = new Map<number, number>();
  groups.forEach((group, groupIdx) => group.faceIndices.forEach(faceIdx => faceToGroup.set(faceIdx, groupIdx)));
  const edgeMap = new Map<string, { v1: THREE.Vector3; v2: THREE.Vector3; faces: number[] }>();
  const keyOf = (v: THREE.Vector3) => `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;
  faces.forEach((face) => {
    for (let i = 0; i < 3; i++) {
      const v1 = face.vertices[i], v2 = face.vertices[(i + 1) % 3];
      const key1 = keyOf(v1), key2 = keyOf(v2);
      const edgeKey = key1 < key2 ? `${key1}-${key2}` : `${key2}-${key1}`;
      if (!edgeMap.has(edgeKey)) edgeMap.set(edgeKey, { v1: v1.clone(), v2: v2.clone(), faces: [] });
      edgeMap.get(edgeKey)!.faces.push(face.faceIndex);
    }
  });
  edgeMap.forEach((edge) => {
    if (edge.faces.length !== 2) return;
    const g1 = faceToGroup.get(edge.faces[0]), g2 = faceToGroup.get(edge.faces[1]);
    if (g1 !== undefined && g2 !== undefined && g1 !== g2) edgeVertices.push(edge.v1.x, edge.v1.y, edge.v1.z, edge.v2.x, edge.v2.y, edge.v2.z);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(edgeVertices, 3));
  return geometry;
}

export function createFaceHighlightGeometry(faces: FaceData[], faceIndices: number[]): THREE.BufferGeometry {
  const positions: number[] = [];
  for (const fi of faceIndices) faces[fi]?.vertices.forEach(v => positions.push(v.x, v.y, v.z));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

// ── YÜZ TANIMLAYICI (ölçek-bağımsız yüz kimliği) ─────────────────────────────

function getAxisDirection(normal: THREE.Vector3): AxisDir | null {
  const tol = 0.95;
  for (const [i, l] of [[0, 'x'], [1, 'y'], [2, 'z']] as Array<[number, string]>) {
    const c = normal.getComponent(i);
    if (c > tol) return `${l}+` as AxisDir;
    if (c < -tol) return `${l}-` as AxisDir;
  }
  return null;
}

function describeFace(face: FaceData, boundingBox: THREE.Box3): FaceDescriptor {
  const size = new THREE.Vector3();
  boundingBox.getSize(size);
  const min = boundingBox.min;
  const normalizedCenter: Vec3 = [
    size.x > 0 ? (face.center.x - min.x) / size.x : 0.5,
    size.y > 0 ? (face.center.y - min.y) / size.y : 0.5,
    size.z > 0 ? (face.center.z - min.z) / size.z : 0.5,
  ];
  const axisDirection = getAxisDirection(face.normal);
  return {
    normal: [face.normal.x, face.normal.y, face.normal.z],
    normalizedCenter,
    area: face.area,
    isCurved: face.isCurved || axisDirection === null,
    axisDirection,
    axisPosition: axisDirection === null ? undefined : face.center.getComponent(axisIndexOf(axisDirection)),
  };
}

export function createFaceDescriptor(face: FaceData, geometry: THREE.BufferGeometry): FaceDescriptor {
  return describeFace(face, localBboxOf(geometry)!);
}

/** Tanımlayıcıya en iyi uyan yüz: düz yüzlerde eksen + eksen konumu / düzlem-içi merkez; eğrilerde normal açısı + merkez. */
export function findFaceByDescriptor(descriptor: FaceDescriptor, faces: FaceData[], geometry: THREE.BufferGeometry): FaceData | null {
  let bestMatch: FaceData | null = null, bestScore = Infinity;
  const targetNormal = new THREE.Vector3(...descriptor.normal);
  const targetAxisDir = descriptor.axisDirection || getAxisDirection(targetNormal);
  const isFlatSurface = targetAxisDir !== null && !descriptor.isCurved;
  const bbox = localBboxOf(geometry)!;
  const skipAxis = targetAxisDir ? axisIndexOf(targetAxisDir) : -1;
  const centerDiff = (fd: FaceDescriptor, axes: number[]) =>
    Math.sqrt(axes.reduce((s, i) => s + Math.pow(fd.normalizedCenter[i] - descriptor.normalizedCenter[i], 2), 0));
  for (const face of faces) {
    const fd = describeFace(face, bbox);
    let score: number;
    if (isFlatSurface) {
      if (fd.axisDirection !== targetAxisDir) continue;
      score = descriptor.axisPosition !== undefined && fd.axisPosition !== undefined
        ? Math.abs(fd.axisPosition - descriptor.axisPosition)
        : centerDiff(fd, [0, 1, 2].filter(i => i !== skipAxis)) * 10;
    } else {
      const normalAngle = angleDeg(targetNormal, face.normal);
      if (normalAngle > 15) continue;
      score = normalAngle * 2 + centerDiff(fd, [0, 1, 2]) * 10;
    }
    if (score < bestScore) { bestScore = score; bestMatch = face; }
  }
  if (!bestMatch) console.warn(`No face match found for normal: [${descriptor.normal.map(n => n.toFixed(2)).join(', ')}], AxisDir: ${targetAxisDir}`);
  return bestMatch;
}

// ═══════════════════════════════════════════════════════════════════════════
// ShapeService — GÖVDE KATISI (OCC) + VERTEX DÜZENLEME + PARAMETRE UYGULAMA.
//  1. replicad/OCC: başlatma, kutu, boolean çıkarma, VF'den panel katısı, mesh dönüşümü.
//  2. Vertex düzenleme: taban köşe listesi, hedef birleştirme, etkin gövde geometrisi.
//  3. Gövde yeniden kurulumu: kutu + çıkarmalar + filletler (TEK yol: store,
//     ParametersPanel ve katalog yükleme buradan geçer).
//  4. applyShapeChanges: ParametersPanel'in "uygula" komutu; evaluateExpression.
// (Eski ReplicadService + VertexEditorService + ShapeUpdaterService.)
// ═══════════════════════════════════════════════════════════════════════════

declare global {
  interface Window { __ocInstance?: any; __ocInitPromise?: Promise<any> }
}

// ── 1. OCC / replicad ────────────────────────────────────────────────────────

export const initReplicad = async () => {
  if (window.__ocInstance) return window.__ocInstance;
  if (window.__ocInitPromise) return window.__ocInitPromise;
  window.__ocInitPromise = (async () => {
    const oc = await initOpenCascade();
    setOC(oc);
    window.__ocInstance = oc;
    return oc;
  })().catch((error) => {
    window.__ocInitPromise = undefined;
    console.error('Failed to initialize Replicad:', error);
    throw error;
  });
  return window.__ocInitPromise;
};

export interface BoxSize { width: number; height: number; depth: number }

export const createReplicadBox = async ({ width, height, depth }: BoxSize): Promise<any> => {
  await initReplicad();
  const { draw } = await import('replicad');
  return draw().movePointerTo([0, 0]).lineTo([width, 0]).lineTo([width, height]).lineTo([0, height]).close().sketchOnPlane().extrude(depth);
};

export const convertReplicadToThreeGeometry = (shape: any): THREE.BufferGeometry => {
  try {
    const mesh = shape.mesh({ tolerance: 0.1, angularTolerance: 30 });
    if (!mesh.vertices || !mesh.triangles) throw new Error('Invalid mesh data');
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(Array.from(mesh.vertices as ArrayLike<number>), 3));
    geometry.setIndex(Array.from(mesh.triangles as ArrayLike<number>));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  } catch (error) {
    console.error('convertReplicadToThreeGeometry failed:', error);
    throw error;
  }
};

/** base − cutting; kesici önce ölçeklenir, sonra döndürülür (rad, XYZ sırası), sonra ötelenir. */
export const performBooleanCut = async (
  baseShape: any, cuttingShape: any,
  cuttingPosition?: Vec3, cuttingRotation?: Vec3, cuttingScale?: Vec3,
): Promise<any> => {
  await initReplicad();
  try {
    let t = cuttingShape;
    if (cuttingScale && (cuttingScale[0] !== 1 || cuttingScale[1] !== 1 || cuttingScale[2] !== 1)) t = t.scale(cuttingScale[0], cuttingScale[1], cuttingScale[2]);
    if (cuttingRotation) {
      const axes: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      for (let i = 0; i < 3; i++) if (cuttingRotation[i] !== 0) t = t.rotate(cuttingRotation[i] * (180 / Math.PI), [0, 0, 0], axes[i]);
    }
    if (cuttingPosition && (cuttingPosition[0] !== 0 || cuttingPosition[1] !== 0 || cuttingPosition[2] !== 0)) t = t.translate(cuttingPosition[0], cuttingPosition[1], cuttingPosition[2]);
    return baseShape.cut(t);
  } catch (error) {
    console.error('Boolean cut failed:', error);
    throw error;
  }
};

export const createPanelFromVirtualFace = async (
  vertices: Vec3[], normal: Vec3, panelThickness: number, planeExpand = 0
): Promise<any> => {
  await initReplicad();
  const { draw, Plane } = await import('replicad');
  const n = new THREE.Vector3(...normal).normalize();

  // up: normale EN DİK dünya ekseni (en küçük |bileşen|). Eski "dominant
  // bileşen" seçimi 45° gibi iki bileşenin eşit olduğu normallerde dejenere
  // cross üretip u/v tabanını bozuyordu (dönmüş panel kesimi -45° civarı hiç
  // çalışmıyordu — kök buydu). En dik eksen her yönelimde sağlam taban verir.
  const anx = Math.abs(n.x), any_ = Math.abs(n.y), anz = Math.abs(n.z);
  const up = anx <= any_ && anx <= anz ? new THREE.Vector3(1, 0, 0) : any_ <= anx && any_ <= anz ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const uAxis = new THREE.Vector3().crossVectors(n, up).normalize();
  const vAxis = new THREE.Vector3().crossVectors(n, uAxis).normalize();

  const v3s = vertices.map(v => new THREE.Vector3(v[0], v[1], v[2]));
  const center = new THREE.Vector3();
  v3s.forEach(v => center.add(v));
  center.divideScalar(v3s.length);
  let projected: [number, number][] = v3s.map(v => {
    const d = new THREE.Vector3().subVectors(v, center);
    return [d.dot(uAxis), d.dot(vAxis)];
  });

  // Düzlem-içi büyütme: döndürülmüş panelde slab'ı kübü aşacak kadar genişletir;
  // sonrasında parent-küp kesişimi paneli açıya göre tam duvara kadar kırpar.
  // Köşeleri tek tek itmek çentikli/konkav VF'de çokgeni kendine katlar → yalnız
  // SINIR DİKDÖRTGENİ büyütülür (her zaman konveks). Çentikler kesimle yeniden oluşur.
  if (planeExpand > 0) {
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [pu, pv] of projected) { minU = Math.min(minU, pu); maxU = Math.max(maxU, pu); minV = Math.min(minV, pv); maxV = Math.max(maxV, pv); }
    minU -= planeExpand; maxU += planeExpand; minV -= planeExpand; maxV += planeExpand;
    projected = [[minU, minV], [maxU, minV], [maxU, maxV], [minU, maxV]];
  }

  // ÇİFT KÖŞE TEMİZLİĞİ: Sutherland-Hodgman kırpması eğik ayak izi kenarı yüz
  // köşesinin tam üstünden geçince kesişim noktasını mevcut köşeyle BİREBİR
  // AYNI üretir; draw().lineTo(aynı nokta) OCC'de numerik WASM exception
  // ("Auto panel creation failed: 19365648") → panel hiç üretilmez. Ardışık
  // çiftler (wrap-around dahil) ayıklanır; yalnız BİREBİR çift tetikler.
  const DUP_TOL = 1e-4;
  const cleaned: [number, number][] = [];
  for (const p of projected) {
    const prev = cleaned[cleaned.length - 1];
    if (prev && Math.hypot(p[0] - prev[0], p[1] - prev[1]) < DUP_TOL) continue;
    cleaned.push(p);
  }
  while (cleaned.length >= 2) {
    const f = cleaned[0], l = cleaned[cleaned.length - 1];
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) < DUP_TOL) cleaned.pop(); else break;
  }
  if (cleaned.length < 3) {
    console.warn('[YAGO][ÜRETİM] createPanelFromVirtualFace: dejenere çokgen (temizlik sonrası <3 köşe), panel atlandı. hamKöşeN=', vertices.length);
    return null;
  }
  projected = cleaned;

  // CCW garantisi — replicad CW çokgeni delik sayar. SIFIR-ALAN KAPISI: kıymık elenir.
  let signedArea = 0;
  for (let i = 0; i < projected.length; i++) {
    const j = (i + 1) % projected.length;
    signedArea += projected[i][0] * projected[j][1] - projected[j][0] * projected[i][1];
  }
  if (Math.abs(signedArea) / 2 < 1e-3) {
    console.warn('[YAGO][ÜRETİM] createPanelFromVirtualFace: sıfır-alan çokgen, panel atlandı. alan=', Math.abs(signedArea) / 2);
    return null;
  }
  if (signedArea < 0) projected = projected.slice().reverse();

  let sketch = draw().movePointerTo(projected[0]);
  for (let i = 1; i < projected.length; i++) sketch = sketch.lineTo(projected[i]);
  const plane = new Plane([center.x, center.y, center.z], [uAxis.x, uAxis.y, uAxis.z], [n.x, n.y, n.z]);
  return sketch.close().sketchOnPlane(plane).extrude(-panelThickness);
};

// ── 2. VERTEX DÜZENLEME ──────────────────────────────────────────────────────

export interface VertexModification {
  vertexIndex: number;
  originalPosition: Vec3;
  newPosition: Vec3;
  direction: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-';
  expression: string;
  description?: string;
  offset: Vec3;
}

export function getBoxVertices(width: number, height: number, depth: number): THREE.Vector3[] {
  const w2 = width / 2, h2 = height / 2, d2 = depth / 2;
  return [
    new THREE.Vector3(-w2, -h2, -d2), new THREE.Vector3(w2, -h2, -d2), new THREE.Vector3(w2, h2, -d2), new THREE.Vector3(-w2, h2, -d2),
    new THREE.Vector3(-w2, -h2, d2), new THREE.Vector3(w2, -h2, d2), new THREE.Vector3(w2, h2, d2), new THREE.Vector3(-w2, h2, d2),
  ];
}

const key2 = (x: number, y: number, z: number) => `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100},${Math.round(z * 100) / 100}`;

export async function getReplicadVertices(replicadShape: any): Promise<THREE.Vector3[]> {
  try {
    let vertices: any[] = [];
    if (typeof replicadShape.vertices === 'function') vertices = replicadShape.vertices();
    else if (Array.isArray(replicadShape.vertices)) vertices = replicadShape.vertices;
    else {
      const mesh = replicadShape.mesh({ tolerance: 0.1, angularTolerance: 30 });
      if (mesh && mesh.vertices) {
        const uniq = new Map<string, THREE.Vector3>();
        for (let i = 0; i < mesh.vertices.length; i += 3) {
          const x = Math.round(mesh.vertices[i] * 100) / 100, y = Math.round(mesh.vertices[i + 1] * 100) / 100, z = Math.round(mesh.vertices[i + 2] * 100) / 100;
          const k = `${x},${y},${z}`;
          if (!uniq.has(k)) uniq.set(k, new THREE.Vector3(x, y, z));
        }
        return Array.from(uniq.values());
      }
    }
    if (!Array.isArray(vertices) || vertices.length === 0) return [];
    return vertices.map((v: any) => {
      if (v && typeof v.point === 'function') { const p = v.point(); return new THREE.Vector3(p[0], p[1], p[2]); }
      if (Array.isArray(v)) return new THREE.Vector3(v[0], v[1], v[2]);
      if (v && typeof v.x === 'number') return new THREE.Vector3(v.x, v.y, v.z);
      return null;
    }).filter((v): v is THREE.Vector3 => v !== null);
  } catch (error) {
    console.error('Failed to get Replicad vertices:', error);
    return [];
  }
}

/**
 * VERTEX DÜZENLEME — TEK KAYNAK TABAN LİSTESİ. Editördeki noktalar, terminal
 * işleyicisi ve sahnedeki mesh AYNI listeyi kullanır: vertexIndex bu listenin
 * indeksidir. Öncelik: scaledBaseVertices → replicad köşeleri → kutu parametreleri.
 */
export async function resolveBaseVertices(shape: any): Promise<THREE.Vector3[]> {
  const p = shape?.parameters;
  if (!p) return [];
  if (Array.isArray(p.scaledBaseVertices) && p.scaledBaseVertices.length > 0) return p.scaledBaseVertices.map((v: number[]) => new THREE.Vector3(v[0], v[1], v[2]));
  if (shape.replicadShape) return getReplicadVertices(shape.replicadShape);
  if (shape.type === 'box') return getBoxVertices(p.width, p.height, p.depth);
  return [];
}

/**
 * Her köşenin NİHAİ konumu: taban köşeden başlanır, o köşeye ait her düzenleme
 * yalnız KENDİ ekseninde newPosition değerini yazar (aynı eksende sonraki kazanır).
 */
export function composeVertexTargets(base: THREE.Vector3[], mods: any[] | undefined): Map<number, THREE.Vector3> {
  const out = new Map<number, THREE.Vector3>();
  for (const mod of mods || []) {
    const b = base[mod?.vertexIndex];
    if (!b || !mod?.direction || !Array.isArray(mod.newPosition)) continue;
    const ai = axisIndexOf(mod.direction);
    const t = out.get(mod.vertexIndex) || b.clone();
    t.setComponent(ai, mod.newPosition[ai]);
    out.set(mod.vertexIndex, t);
  }
  return out;
}

/**
 * VERTEX DÜZENLEMELERİNİ GEOMETRİYE UYGULA (koordinat eşlemeli, sırasız). Her
 * düzenleme kendi `originalPosition`'ını taşır; mesh'te o koordinattaki TÜM
 * kopyalar bulunur ve yalnız düzenlemenin EKSENİ hedef değere çekilir.
 * Düzenleme yoksa girdinin KENDİSİ döner (klon yok).
 */
function applyVertexModsToGeometry(base: THREE.BufferGeometry, mods: any[] | undefined): THREE.BufferGeometry {
  if (!base || !Array.isArray(mods) || mods.length === 0 || !base.getAttribute('position')) return base;
  const geom = base.clone();
  const attr = geom.getAttribute('position') as THREE.BufferAttribute;
  const positions = attr.array as Float32Array;
  const vertexMap = new Map<string, number[]>();
  for (let i = 0; i < positions.length; i += 3) {
    const key = key2(positions[i], positions[i + 1], positions[i + 2]);
    const g = vertexMap.get(key); if (g) g.push(i); else vertexMap.set(key, [i]);
  }
  const targets = new Map<string, { idx: number[]; t: Vec3 }>();
  for (const mod of mods) {
    const op = mod?.originalPosition, np = mod?.newPosition, d = mod?.direction;
    if (!Array.isArray(op) || !Array.isArray(np) || typeof d !== 'string') continue;
    const key = key2(op[0], op[1], op[2]);
    const idx = vertexMap.get(key);
    if (!idx) continue;
    const e = targets.get(key) || { idx, t: [op[0], op[1], op[2]] as Vec3 };
    e.t[axisIndexOf(d)] = np[axisIndexOf(d)];
    targets.set(key, e);
  }
  targets.forEach(({ idx, t }) => { for (const i of idx) { positions[i] = t[0]; positions[i + 1] = t[1]; positions[i + 2] = t[2]; } });
  attr.needsUpdate = true;
  geom.computeVertexNormals();
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}

/** Düzenleme listesinin kimliği (önbellek anahtarı). */
export function vertexModsKey(mods: any[] | undefined): string {
  if (!Array.isArray(mods) || mods.length === 0) return '';
  return JSON.stringify(mods.map(m => [m?.vertexIndex, m?.direction, m?.originalPosition, m?.newPosition]));
}

/**
 * ETKİN GÖVDE GEOMETRİSİ — vertex düzenlemeleri uygulanmış gövde. SÖZLEŞME:
 * store'daki `shape.geometry` her zaman TABAN'dır; düzenlemeler çizimde, yüz
 * yakalamada, VF yeniden hesabında ve motorun gövde kutusunda BU fonksiyonla
 * uygulanır. Düzenleme yoksa `shape.geometry`'nin kendisi döner.
 */
const _effCache = new WeakMap<THREE.BufferGeometry, { key: string; geo: THREE.BufferGeometry }>();
export function effectiveBodyGeometry(shape: any): THREE.BufferGeometry {
  const base: THREE.BufferGeometry | undefined = shape?.geometry;
  if (!base) return base as any;
  const key = vertexModsKey(shape.vertexModifications);
  if (!key) return base;
  const hit = _effCache.get(base);
  if (hit && hit.key === key) return hit.geo;
  const geo = applyVertexModsToGeometry(base, shape.vertexModifications);
  _effCache.set(base, { key, geo });
  return geo;
}

// ── 3. GÖVDE YENİDEN KURULUMU: kutu + çıkarmalar + filletler ─────────────────

/** Parametrik alanlarda ("W/2 + 10" gibi) kullanılan basit formül çözücü. */
export function evaluateExpression(expression: string, context: Record<string, number>, fallback = 0): number {
  try {
    let expr = expression.trim();
    Object.entries(context).forEach(([key, value]) => { expr = expr.replace(new RegExp(`\\b${key}\\b`, 'g'), value.toString()); });
    const result = Function(`"use strict"; return (${expr.replace(/[^0-9+\-*/().\s]/g, '')})`)();
    return isNaN(result) ? fallback : result;
  } catch { return fallback; }
}

const vec3 = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];

export async function updateFilletCentersForNewGeometry(fillets: FilletInfo[], newGeometry: THREE.BufferGeometry, newSize: BoxSize): Promise<FilletInfo[]> {
  if (!fillets || fillets.length === 0) return fillets;
  const faces = extractFacesFromGeometry(newGeometry);
  return fillets.map((fillet, idx) => {
    if (!fillet.face1Descriptor || !fillet.face2Descriptor) { console.warn(`Fillet #${idx + 1} missing descriptors, skipping update`); return fillet; }
    const f1 = findFaceByDescriptor(fillet.face1Descriptor, faces, newGeometry);
    const f2 = findFaceByDescriptor(fillet.face2Descriptor, faces, newGeometry);
    if (!f1 || !f2) { console.error(`Could not find matching face${f1 ? '2' : '1'} for fillet #${idx + 1}`); return fillet; }
    return { ...fillet, face1Data: { normal: vec3(f1.normal), center: vec3(f1.center) }, face2Data: { normal: vec3(f2.normal), center: vec3(f2.center) }, originalSize: newSize };
  });
}

export async function applyFillets(replicadShape: any, fillets: FilletInfo[], shapeSize: BoxSize) {
  if (!fillets || fillets.length === 0) return replicadShape;
  let currentShape = replicadShape;
  const tolerance = Math.max(shapeSize.width || 1, shapeSize.height || 1, shapeSize.depth || 1) * 0.08;
  for (const fillet of fillets) {
    const scale = new THREE.Vector3(shapeSize.width / fillet.originalSize.width, shapeSize.height / fillet.originalSize.height, shapeSize.depth / fillet.originalSize.depth);
    // Yüz düzlemi (n, d), fillet kaydedildiği boyuttan güncel boyuta ölçeklenmiş.
    const plane = (f: FilletInfo['face1Data']) => {
      const n = new THREE.Vector3(...f.normal);
      const d = f.planeD !== undefined ? f.planeD * (n.x !== 0 ? scale.x : n.y !== 0 ? scale.y : scale.z) : n.dot(new THREE.Vector3(...f.center).multiply(scale));
      return { n, d };
    };
    const p1 = plane(fillet.face1Data), p2 = plane(fillet.face2Data);
    const onPlane = (p: { n: THREE.Vector3; d: number }, pts: THREE.Vector3[]) => pts.every(q => Math.abs(p.n.dot(q) - p.d) < tolerance);
    currentShape = currentShape.fillet((edge: any) => {
      try {
        const start = edge.startPoint, end = edge.endPoint;
        if (!start || !end) return null;
        const s = new THREE.Vector3(start.x, start.y, start.z), e = new THREE.Vector3(end.x, end.y, end.z);
        const pts = [s, e, s.clone().add(e).multiplyScalar(0.5)];
        return onPlane(p1, pts) && onPlane(p2, pts) ? fillet.radius : null;
      } catch (err) { console.error('Error checking edge:', err); return null; }
    });
  }
  return currentShape;
}

/** Çıkarma kutusunun ölçüsü: sayısal parametre → geometri kutusu → geometrySize → 100. */
function subtractionSize(sub: any): BoxSize {
  const num = (s: any) => { const v = parseFloat(s); return Number.isFinite(v) && v > 0 ? v : undefined; };
  const p = sub.parameters;
  const bb = localBboxOf(sub.geometry);
  const size = bb ? bb.getSize(new THREE.Vector3()) : null;
  const gs = sub.geometrySize;
  return {
    width: num(p?.width) ?? size?.x ?? gs?.[0] ?? 100,
    height: num(p?.height) ?? size?.y ?? gs?.[1] ?? 100,
    depth: num(p?.depth) ?? size?.z ?? gs?.[2] ?? 100,
  };
}

export interface RebuiltBody { replicadShape: any; geometry: THREE.BufferGeometry; scaledBaseVertices: number[][]; fillets: FilletInfo[] }

/**
 * Gövdeyi baştan kurar: parametre kutusu − çıkarmalar (+ filletler). Fillet
 * merkezleri yeni geometriye göre tazelenir (refreshFillets=false → olduğu gibi).
 */
export async function rebuildBodySolid(
  body: { parameters?: any; fillets?: FilletInfo[] }, subtractions: Array<SubtractedGeometry | any | null> | undefined,
  size?: BoxSize, refreshFillets = true
): Promise<RebuiltBody> {
  const sz: BoxSize = size || { width: body.parameters?.width || 1, height: body.parameters?.height || 1, depth: body.parameters?.depth || 1 };
  let shape = await createReplicadBox(sz);
  for (const sub of subtractions || []) {
    if (!sub) continue;
    const cutter = await createReplicadBox(subtractionSize(sub));
    shape = await performBooleanCut(shape, cutter, sub.relativeOffset || [0, 0, 0], sub.relativeRotation || [0, 0, 0], sub.scale || [1, 1, 1]);
  }
  let fillets = body.fillets || [];
  if (fillets.length) {
    if (refreshFillets) fillets = await updateFilletCentersForNewGeometry(fillets, convertReplicadToThreeGeometry(shape), sz);
    shape = await applyFillets(shape, fillets, sz);
  }
  const verts = await getReplicadVertices(shape);
  return { replicadShape: shape, geometry: convertReplicadToThreeGeometry(shape), scaledBaseVertices: verts.map(v => [v.x, v.y, v.z]), fillets };
}

// ── 4. PARAMETRE UYGULAMA (ParametersPanel "Apply") ──────────────────────────

type ExprResult = { expression: string; result: number };
export interface ApplyShapeChangesParams {
  selectedShape: any;
  width: number; height: number; depth: number;
  rotX: number; rotY: number; rotZ: number;
  customParameters: any[];
  vertexModifications: any[];
  filletRadii?: number[];
  selectedSubtractionIndex: number | null;
  subWidth: number; subHeight: number; subDepth: number;
  subPosX: number; subPosY: number; subPosZ: number;
  subRotX: number; subRotY: number; subRotZ: number;
  subParams?: Record<'width' | 'height' | 'depth' | 'posX' | 'posY' | 'posZ' | 'rotX' | 'rotY' | 'rotZ', ExprResult>;
  updateShape: (id: string, updates: any) => void;
}

const degToRad = (a: number, b: number, c: number): Vec3 => [a * (Math.PI / 180), b * (Math.PI / 180), c * (Math.PI / 180)];

export async function applyShapeChanges(params: ApplyShapeChangesParams) {
  const { selectedShape, width, height, depth, rotX, rotY, rotZ, customParameters, vertexModifications, filletRadii, selectedSubtractionIndex,
    subWidth, subHeight, subDepth, subPosX, subPosY, subPosZ, subRotX, subRotY, subRotZ, subParams, updateShape } = params;
  if (!selectedShape) return;
  try {
    const cur = selectedShape.parameters;
    const scale = new THREE.Vector3(width / cur.width, height / cur.height, depth / cur.depth);
    const dimensionsChanged = width !== cur.width || height !== cur.height || depth !== cur.depth;

    // Taban köşeler (yeni boyuta ölçeklenmiş) — vertex düzenlemelerinin referansı.
    let newBaseVertices: THREE.Vector3[] = [];
    if (cur.scaledBaseVertices?.length > 0 || selectedShape.replicadShape) {
      const curBase: THREE.Vector3[] = cur.scaledBaseVertices?.length > 0
        ? cur.scaledBaseVertices.map((v: number[]) => new THREE.Vector3(v[0], v[1], v[2]))
        : await getReplicadVertices(selectedShape.replicadShape);
      newBaseVertices = dimensionsChanged ? curBase.map(v => v.clone().multiply(scale)) : curBase;
    } else if (selectedShape.type === 'box') newBaseVertices = getBoxVertices(width, height, depth);

    // Düzenlemeler: formül yeni boyutla çözülür; her eksen kendi değerini yazar.
    const evalContext = { W: width, H: height, D: depth, ...customParameters.reduce((acc, p) => ({ ...acc, [p.name]: p.result }), {}) };
    const originOf = (mod: any): Vec3 => newBaseVertices[mod.vertexIndex] ? vec3(newBaseVertices[mod.vertexIndex]) : mod.originalPosition;
    const finalPos = new Map<number, Vec3>();
    for (const mod of vertexModifications) {
      if (!finalPos.has(mod.vertexIndex)) finalPos.set(mod.vertexIndex, [...originOf(mod)] as Vec3);
      finalPos.get(mod.vertexIndex)![axisIndexOf(mod.direction)] = evaluateExpression(mod.expression, evalContext);
    }
    const updatedVertexMods = vertexModifications.map((mod: any) => {
      const o = originOf(mod), ai = axisIndexOf(mod.direction), f = finalPos.get(mod.vertexIndex)!;
      const offset: Vec3 = [0, 0, 0]; offset[ai] = f[ai] - o[ai];
      return { ...mod, originalPosition: o, newPosition: f, offset };
    });

    const baseUpdate = {
      parameters: { ...cur, width, height, depth, customParameters, scaledBaseVertices: newBaseVertices.length > 0 ? newBaseVertices.map(vec3) : cur.scaledBaseVertices },
      vertexModifications: updatedVertexMods,
      rotation: degToRad(rotX, rotY, rotZ),
      scale: selectedShape.scale,
    };
    const withRadii = (fillets: FilletInfo[]) => (filletRadii && filletRadii.length > 0)
      ? fillets.map((f, i) => ({ ...f, radius: filletRadii[i] !== undefined ? filletRadii[i] : f.radius })) : fillets;
    const size: BoxSize = { width, height, depth };

    const hasSubtractionChanges = selectedSubtractionIndex !== null && selectedShape.subtractionGeometries?.length > 0;
    const filletsChanged = !!filletRadii && filletRadii.length > 0 && filletRadii.some((r, i) => (selectedShape.fillets?.[i]?.radius || 0) !== r);

    let subtractions: any[] | undefined = selectedShape.subtractionGeometries;
    let needsSolid = dimensionsChanged || (filletsChanged && !!selectedShape.replicadShape);
    if (hasSubtractionChanges) {
      const updated = {
        ...selectedShape.subtractionGeometries![selectedSubtractionIndex!],
        geometry: convertReplicadToThreeGeometry(await createReplicadBox({ width: subWidth, height: subHeight, depth: subDepth })),
        relativeOffset: [subPosX, subPosY, subPosZ] as Vec3,
        relativeRotation: degToRad(subRotX, subRotY, subRotZ),
        parameters: subParams ? Object.fromEntries(Object.entries(subParams).map(([k, v]) => [k, v.expression])) : undefined,
      };
      subtractions = selectedShape.subtractionGeometries!.map((sub: any, idx: number) => (idx === selectedSubtractionIndex ? updated : sub));
      needsSolid = true;
    }

    if (!needsSolid) {
      updateShape(selectedShape.id, { rotation: baseUpdate.rotation, scale: baseUpdate.scale, vertexModifications: baseUpdate.vertexModifications, parameters: baseUpdate.parameters });
      return;
    }
    const r = await rebuildBodySolid({ parameters: cur, fillets: withRadii(selectedShape.fillets || []) }, subtractions, size);
    updateShape(selectedShape.id, {
      geometry: r.geometry, replicadShape: r.replicadShape, fillets: r.fillets,
      ...(hasSubtractionChanges ? { subtractionGeometries: subtractions } : {}),
      position: [...selectedShape.position] as Vec3,
      rotation: baseUpdate.rotation, scale: baseUpdate.scale, vertexModifications: baseUpdate.vertexModifications,
      parameters: { ...baseUpdate.parameters, scaledBaseVertices: r.scaledBaseVertices },
    });
  } catch (error) {
    console.error('Failed to update parameters:', error);
    updateShape(selectedShape.id, { parameters: { ...selectedShape.parameters, width, height, depth, customParameters }, vertexModifications: [] });
  }
}
