import * as THREE from 'three';
import initOpenCascade from 'opencascade.js';
import { setOC } from 'replicad';
import {
  type VirtualFace, type FaceDescriptor, type FilletInfo, type SubtractedGeometry, type Shape, shapeById, requestRebuild, vfOfPanel, type RefFacePick,
  useAppStore,
} from '../store';

/* GEOMETRY — 1) geometri çekirdeği + OCC katı servisi · 2) yüz bölgesi (serbest bölge, ayak izi, 2B çokgen) ·
   3) panel işlem adımları (taşı / döndür / yüz extrude, referans yüz seçimi). */

// ════════════════════════════════════════════ 1. GEOMETRİ ÇEKİRDEĞİ + OCC ════════════════════════════════════════════
// Geometri çekirdeği: (A) saf three.js — eksen/matris/kutu yardımcıları, VF düzlem tabanı + oransal çıpalar,
// dönüş açısı çözücüleri, mesh yüz çıkarımı + eş-düzlem gruplama + yüz tanımlayıcı;
// (B) replicad/OCC katı servisi — kutu, boolean, VF'den panel, vertex düzenleme, fillet, gövde rebuild, Apply.

export type Vec3 = [number, number, number];
export type AxisDir = 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-';
export type AxisLetter = 'x' | 'y' | 'z';

export const genId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
export const round1 = (v: number) => Math.round(v * 10) / 10;
export const round3 = (v: number) => Math.round(v * 1000) / 1000;
export const errMsg = (e: unknown) => (e as any)?.message || String(e);

type XYZ = { x: number; y: number; z: number };
export const vec3 = (v: XYZ): Vec3 => [v.x, v.y, v.z];
export const toVector3 = (a: ArrayLike<number>) => new THREE.Vector3(a[0], a[1], a[2]);
/** Dizi-nokta · vektör (a[0]·n.x + a[1]·n.y + a[2]·n.z). */
export const dot3 = (a: ArrayLike<number>, n: XYZ) => a[0] * n.x + a[1] * n.y + a[2] * n.z;
/** Düzlem çerçevesinden 3B nokta: u·x + v·y + n·d. */
export const fromPlaneUV = (u: THREE.Vector3, v: THREE.Vector3, n: THREE.Vector3, x: number, y: number, d: number) =>
  new THREE.Vector3().addScaledVector(u, x).addScaledVector(v, y).addScaledVector(n, d);
/** Köşelerin `i` eksenindeki açıklığı (|max − min|). */
export function spanAlong(verts: ArrayLike<number>[], i: number): number {
  let min = Infinity, max = -Infinity;
  for (const c of verts) { if (c[i] < min) min = c[i]; if (c[i] > max) max = c[i]; }
  return Math.abs(max - min);
}

export const axisIndexOf = (axis: string): 0 | 1 | 2 => (axis[0] === 'x' ? 0 : axis[0] === 'y' ? 1 : 2);

/** Tanımsız harf → sıfır vektör. */
export function axisDirToVec(a: string): THREE.Vector3 {
  const v = new THREE.Vector3();
  const i = 'xyz'.indexOf(a[0] || '');
  if (i >= 0) v.setComponent(i, a[1] === '-' ? -1 : 1);
  return v;
}

export function axisLetterVec(axis: string): THREE.Vector3 {
  return new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
}

/** Vektörün baskın ekseni: 'X+' | 'Y-' … (eşitlikte x > y > z; işaret `> 0`). */
export function dominantAxisLabel(v: { x: number; y: number; z: number }): string {
  const a = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)];
  const i = a.indexOf(Math.max(...a));
  return i === 0 ? (v.x > 0 ? 'X+' : 'X-') : i === 1 ? (v.y > 0 ? 'Y+' : 'Y-') : (v.z > 0 ? 'Z+' : 'Z-');
}

export const FLAT_NORMAL_THRESHOLD = 0.999;
export const isFlatNormal = (n: { x: number; y: number; z: number }, tol = FLAT_NORMAL_THRESHOLD) =>
  Math.abs(n.x) > tol || Math.abs(n.y) > tol || Math.abs(n.z) > tol;

export function getShapeMatrix(shape: any): THREE.Matrix4 {
  const s = shape.scale ?? [1, 1, 1];
  return new THREE.Matrix4().compose(
    new THREE.Vector3(shape.position[0], shape.position[1], shape.position[2]),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(shape.rotation[0], shape.rotation[1], shape.rotation[2], 'XYZ')),
    new THREE.Vector3(s[0], s[1], s[2])
  );
}

export function localBboxOf(geometry: THREE.BufferGeometry | undefined | null): THREE.Box3 | null {
  const pos = geometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
  return pos ? new THREE.Box3().setFromBufferAttribute(pos) : null;
}

export function worldBboxOf(shape: any, geometry: THREE.BufferGeometry | undefined): THREE.Box3 | null {
  const bb = localBboxOf(geometry);
  return bb ? bb.applyMatrix4(getShapeMatrix(shape)) : null;
}

export function translatedBboxOf(shape: any): THREE.Box3 | null {
  const bb = localBboxOf(shape?.geometry);
  return bb ? bb.translate(new THREE.Vector3(...(shape.position as Vec3))) : null;
}

/** Bölge/ayak izi hesaplarının tek u/v kuralı. */
export function getFacePlaneAxes(normal: THREE.Vector3): { u: THREE.Vector3; v: THREE.Vector3 } {
  const n = normal.clone().normalize();
  const absX = Math.abs(n.x), absY = Math.abs(n.y), absZ = Math.abs(n.z);
  const up = absY > absX && absY > absZ ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(n, up).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  return { u, v };
}

/** Düzlem üzerinde merkezli, 2H×2H köşe listesi (yarım-uzay kesicileri için). */
export function hugeRectOnPlane(center: THREE.Vector3, n: THREE.Vector3, H: number): Vec3[] {
  const { u, v } = getFacePlaneAxes(n);
  return [[-H, -H], [H, -H], [H, H], [-H, H]].map(([a, b]) => vec3(center.clone().addScaledVector(u, a).addScaledVector(v, b)));
}

export function panelThickness(shape: any): number {
  return parseFloat(shape?.parameters?.panelThickness) || 18;
}

export function projRange(pts: Iterable<THREE.Vector3>, dir: THREE.Vector3): { min: number; max: number } {
  let min = Infinity, max = -Infinity;
  for (const p of pts) { const d = p.dot(dir); if (d < min) min = d; if (d > max) max = d; }
  return { min, max };
}

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

export function boundsOverlapBox(rb: number[][], bb: THREE.Box3): boolean {
  return rb[0][0] < bb.max.x - 0.5 && rb[1][0] > bb.min.x + 0.5
    && rb[0][1] < bb.max.y - 0.5 && rb[1][1] > bb.min.y + 0.5
    && rb[0][2] < bb.max.z - 0.5 && rb[1][2] > bb.min.z + 0.5;
}

/** 1/scale ızgarasında tekilleştirir (ilk görülen kalır). */
export function uniquePoints(pts: Iterable<THREE.Vector3>, scale = 10): THREE.Vector3[] {
  const out: THREE.Vector3[] = [], seen = new Set<string>();
  for (const p of pts) {
    const key = `${Math.round(p.x * scale)},${Math.round(p.y * scale)},${Math.round(p.z * scale)}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push(p);
  }
  return out;
}

export function uniqueMeshPoints(geometry: THREE.BufferGeometry, scale = 10): THREE.Vector3[] {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return [];
  return uniquePoints(Array.from({ length: pos.count }, (_, i) => new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i))), scale);
}

export function edgePointsOf(geometry: THREE.BufferGeometry, thresholdDeg = 15): [number, number, number][] {
  const eg = new THREE.EdgesGeometry(geometry, thresholdDeg);
  const pos = eg.getAttribute('position') as THREE.BufferAttribute;
  const pts: [number, number, number][] = [];
  for (let i = 0; i < pos.count; i++) pts.push([pos.getX(i), pos.getY(i), pos.getZ(i)]);
  eg.dispose();
  return pts;
}

// Pivot/nişan VF dikdörtgenine ORANSAL saklanır (u/v ∈ [0,1] + normal ofseti) → yüzle birlikte kayar.
// NOT: vfPlaneBasis getFacePlaneAxes'tan farklıdır; kayıtlı pivotVfFrac/refArmVfFrac buna bağlı — birleştirilemez.

function vfPlaneBasis(normal: Vec3 | number[]): { n: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3 } {
  const n = new THREE.Vector3(normal[0], normal[1], normal[2]).normalize();
  const up = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(up, n).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  return { n, u, v };
}

type VfLike = { normal: Vec3 | number[]; vertices: Array<Vec3 | number[]> };

function vfUvBox(vf: VfLike) {
  const { n, u, v } = vfPlaneBasis(vf.normal);
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity, nOff = 0;
  for (const c of vf.vertices) {
    const w = toVector3(c);
    uMin = Math.min(uMin, w.dot(u)); uMax = Math.max(uMax, w.dot(u));
    vMin = Math.min(vMin, w.dot(v)); vMax = Math.max(vMax, w.dot(v));
    nOff = w.dot(n);
  }
  return { n, u, v, uMin, uMax, vMin, vMax, nOff };
}

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

export function resolveVfFracPoint(frac: Vec3, vf: VfLike): THREE.Vector3 {
  const b = vfUvBox(vf);
  const [fu, fv, dn] = frac;
  return new THREE.Vector3()
    .addScaledVector(b.u, b.uMin + fu * (b.uMax - b.uMin))
    .addScaledVector(b.v, b.vMin + fv * (b.vMax - b.vMin))
    .addScaledVector(b.n, b.nOff + dn);
}

export function mapAxisToVfLocal(vf: { normal: Vec3 | number[] } | undefined | null, axis: AxisLetter): Vec3 | undefined {
  if (!vf?.normal) return undefined;
  const { n, u, v } = vfPlaneBasis(vf.normal);
  const wa = axisLetterVec(axis);
  const du = Math.abs(wa.dot(u)), dv = Math.abs(wa.dot(v)), dn = Math.abs(wa.dot(n));
  const chosen = dn >= du && dn >= dv ? n : du >= dv ? u : v;
  return vec3(chosen);
}

/** FIXED taşıma çıpası: VF HAM yüzünün eksen boyunca min konumu (yüz kaydıkça ters öteleme → panel mutlak konumda kalır). */
export function vfRawMinAlong(vf: VirtualFace, axisLetter: string): number | null {
  if (!vf?.vertices || vf.vertices.length < 3) return null;
  const a = axisDirToVec(axisLetter);
  const p = new THREE.Vector3(Math.abs(a.x), Math.abs(a.y), Math.abs(a.z));
  if (p.lengthSq() < 0.5) return null;
  const n = new THREE.Vector3(...(vf.normal as Vec3)).normalize();
  const planeD = dot3(vf.vertices[0], n);
  const rb = (vf as any).rawFaceBBox as { xMin: number; xMax: number; yMin: number; yMax: number } | undefined;
  let min = Infinity;
  if (rb) {
    const { u, v } = getFacePlaneAxes(n);
    for (const x of [rb.xMin, rb.xMax]) for (const y of [rb.yMin, rb.yMax]) min = Math.min(min, fromPlaneUV(u, v, n, x, y, planeD).dot(p));
  } else {
    for (const c of vf.vertices) min = Math.min(min, dot3(c, p));
  }
  return Number.isFinite(min) ? min : null;
}

export function rotateAboutAxis(pt: THREE.Vector3, pivot: THREE.Vector3, axis: THREE.Vector3, deg: number): THREE.Vector3 {
  const q = new THREE.Quaternion().setFromAxisAngle(axis.clone().normalize(), (deg * Math.PI) / 180);
  return pt.clone().sub(pivot).applyQuaternion(q).add(pivot);
}

/** Pivot etrafında dönen nişan noktası düzleme hangi açıda değer: A cosθ + B sinθ = c'nin `prefer`e yakın kökü.
 * Ulaşılamıyorsa en yakın yaklaşma açısı (touched=false); nişan eksen üstündeyse null. */
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

export function normDeg(rad: number): number {
  let d = (rad * 180) / Math.PI;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}

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
  if (!positionAttribute) return faces;
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

/** Köşe paylaşan üçgen komşuluğu (tolerans 0.001, `<`). Uzamsal ızgarayla O(F); ikili O(F²) taramayla BİREBİR
 * aynı sonuç, kümeler artan indeks sırasıyla dolar (gruplama gezinme sırası değişmez). */
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

/** DÖNEN DİZİLER PAYLAŞIMLIDIR: çağıran yerinde değiştirmemeli. Önbellek anahtarı: position dizi kimliği + sürüm. */
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

export function groupIndexOfFace(groups: CoplanarFaceGroup[], faceIndex: number | undefined): number {
  if (faceIndex === undefined) return -1;
  return groups.findIndex(g => g.faceIndices.includes(faceIndex));
}

/** Yalnız gerçekten eğri (isCurved) gruplar en yakın aynı-eksenli düz gruba çekilir; coplanar eğik gruplar olduğu gibi kalır. */
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
    if (g1 === undefined || g2 === undefined || g1 === g2) return;
    edgeVertices.push(edge.v1.x, edge.v1.y, edge.v1.z, edge.v2.x, edge.v2.y, edge.v2.z);
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
    normal: vec3(face.normal),
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
  return bestMatch;
}

// Gövde katısı (OCC). rebuildBodySolid TEK yoldur: store, ParametersPanel ve katalog yükleme buradan geçer.

declare global {
  interface Window { __ocInstance?: any; __ocInitPromise?: Promise<any> }
}

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

/** min..max köşeli eksen-hizalı kutu katısı. */
export const createReplicadBoxAt = async (min: ArrayLike<number>, max: ArrayLike<number>): Promise<any> =>
  (await createReplicadBox({ width: max[0] - min[0], height: max[1] - min[1], depth: max[2] - min[2] })).translate(min[0], min[1], min[2]);

/** Boş/bozuk OCC katısında bounds erişimi fırlatır → çağıranın catch'ine düşer (sonuç yazılmaz). */
export function assertBounds(shape: any): void {
  shape.boundingBox.bounds.forEach((v: number[]) => v.forEach(n => n.toFixed(0)));
}

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
    const s = cuttingScale, p = cuttingPosition;
    if (s && (s[0] !== 1 || s[1] !== 1 || s[2] !== 1)) t = t.scale(s[0], s[1], s[2]);
    if (cuttingRotation) {
      const axes: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      for (let i = 0; i < 3; i++) if (cuttingRotation[i] !== 0) t = t.rotate(cuttingRotation[i] * (180 / Math.PI), [0, 0, 0], axes[i]);
    }
    if (p && (p[0] !== 0 || p[1] !== 0 || p[2] !== 0)) t = t.translate(p[0], p[1], p[2]);
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

  // up: normale EN DİK dünya ekseni (en küçük |bileşen|). Baskın bileşen seçimi 45° gibi eşit bileşenli
  // normallerde dejenere cross üretip u/v tabanını bozar.
  const anx = Math.abs(n.x), any_ = Math.abs(n.y), anz = Math.abs(n.z);
  const up = anx <= any_ && anx <= anz ? new THREE.Vector3(1, 0, 0)
    : any_ <= anx && any_ <= anz ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const uAxis = new THREE.Vector3().crossVectors(n, up).normalize();
  const vAxis = new THREE.Vector3().crossVectors(n, uAxis).normalize();

  const v3s = vertices.map(toVector3);
  const center = new THREE.Vector3();
  v3s.forEach(v => center.add(v));
  center.divideScalar(v3s.length);
  let projected: [number, number][] = v3s.map(v => {
    const d = new THREE.Vector3().subVectors(v, center);
    return [d.dot(uAxis), d.dot(vAxis)];
  });

  // Döndürülmüş panelde slab kübü aşacak kadar büyütülür, parent-küp kesişimi duvara kadar kırpar. Köşeleri tek
  // tek itmek konkav VF'yi kendine katlar → yalnız SINIR DİKDÖRTGENİ büyütülür; çentikler kesimle yeniden oluşur.
  if (planeExpand > 0) {
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [pu, pv] of projected) { minU = Math.min(minU, pu); maxU = Math.max(maxU, pu); minV = Math.min(minV, pv); maxV = Math.max(maxV, pv); }
    minU -= planeExpand; maxU += planeExpand; minV -= planeExpand; maxV += planeExpand;
    projected = [[minU, minV], [maxU, minV], [maxU, maxV], [minU, maxV]];
  }

  // Sutherland-Hodgman kırpması mevcut köşeyle BİREBİR aynı nokta üretebilir; draw().lineTo(aynı nokta) OCC'de
  // WASM exception atar → panel üretilmez. Ardışık çiftler (wrap-around dahil) ayıklanır.
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
  if (cleaned.length < 3) return null;   // dejenere çokgen → panel atlanır
  projected = cleaned;

  // CCW garantisi — replicad CW çokgeni delik sayar. SIFIR-ALAN KAPISI: kıymık elenir.
  let signedArea = 0;
  for (let i = 0; i < projected.length; i++) {
    const j = (i + 1) % projected.length;
    signedArea += projected[i][0] * projected[j][1] - projected[j][0] * projected[i][1];
  }
  if (Math.abs(signedArea) / 2 < 1e-3) return null;
  if (signedArea < 0) projected = projected.slice().reverse();

  let sketch = draw().movePointerTo(projected[0]);
  for (let i = 1; i < projected.length; i++) sketch = sketch.lineTo(projected[i]);
  const plane = new Plane(vec3(center), vec3(uAxis), vec3(n));
  return sketch.close().sketchOnPlane(plane).extrude(-panelThickness);
};

/** YARIM-UZAY KESİCİ: düzlemde (center, planeN tabanı) 2H×2H dev levha; levha `keepN`in TERSİNE H kalınlaşır
 *  (createPanelFromVirtualFace −normal yönüne uzar) → keepN tarafı kalır, öbür taraf kesilir. */
export const halfSpaceSlab = (center: THREE.Vector3, planeN: THREE.Vector3, keepN: THREE.Vector3, H: number) =>
  createPanelFromVirtualFace(hugeRectOnPlane(center, planeN, H), vec3(keepN), H, 0);

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

const r2 = (v: number) => Math.round(v * 100) / 100;
const key2 = (x: number, y: number, z: number) => `${r2(x)},${r2(y)},${r2(z)}`;

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
          const x = r2(mesh.vertices[i]), y = r2(mesh.vertices[i + 1]), z = r2(mesh.vertices[i + 2]);
          const k = `${x},${y},${z}`;
          if (!uniq.has(k)) uniq.set(k, new THREE.Vector3(x, y, z));
        }
        return Array.from(uniq.values());
      }
    }
    if (!Array.isArray(vertices) || vertices.length === 0) return [];
    return vertices.map((v: any) => {
      if (v && typeof v.point === 'function') { const p = v.point(); return new THREE.Vector3(p[0], p[1], p[2]); }
      if (Array.isArray(v)) return toVector3(v);
      if (v && typeof v.x === 'number') return new THREE.Vector3(v.x, v.y, v.z);
      return null;
    }).filter((v): v is THREE.Vector3 => v !== null);
  } catch (error) {
    console.error('Failed to get Replicad vertices:', error);
    return [];
  }
}

/** TEK KAYNAK taban köşe listesi: editör, terminal ve mesh aynı listeyi kullanır (vertexIndex = bu listenin indeksi).
 * Öncelik: scaledBaseVertices → replicad köşeleri → kutu parametreleri. */
export async function resolveBaseVertices(shape: any): Promise<THREE.Vector3[]> {
  const p = shape?.parameters;
  if (!p) return [];
  if (Array.isArray(p.scaledBaseVertices) && p.scaledBaseVertices.length > 0) return p.scaledBaseVertices.map(toVector3);
  if (shape.replicadShape) return getReplicadVertices(shape.replicadShape);
  if (shape.type === 'box') return getBoxVertices(p.width, p.height, p.depth);
  return [];
}

/** Her düzenleme yalnız KENDİ ekseninde newPosition yazar (aynı eksende sonraki kazanır). */
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

/** Koordinat eşlemeli: düzenlemenin originalPosition'ındaki TÜM mesh kopyaları yalnız düzenleme EKSENİNDE
 * hedefe çekilir. Düzenleme yoksa girdinin KENDİSİ döner (klon yok). */
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

export function vertexModsKey(mods: any[] | undefined): string {
  if (!Array.isArray(mods) || mods.length === 0) return '';
  return JSON.stringify(mods.map(m => [m?.vertexIndex, m?.direction, m?.originalPosition, m?.newPosition]));
}

/** SÖZLEŞME: store'daki `shape.geometry` hep TABAN'dır; vertex düzenlemeleri çizim, yüz yakalama, VF hesabı ve
 * motorun gövde kutusunda BU fonksiyonla uygulanır. Düzenleme yoksa `shape.geometry`'nin kendisi döner. */
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

export function evaluateExpression(expression: string, context: Record<string, number>, fallback = 0): number {
  try {
    let expr = expression.trim();
    Object.entries(context).forEach(([key, value]) => { expr = expr.replace(new RegExp(`\\b${key}\\b`, 'g'), value.toString()); });
    const result = Function(`"use strict"; return (${expr.replace(/[^0-9+\-*/().\s]/g, '')})`)();
    return isNaN(result) ? fallback : result;
  } catch { return fallback; }
}

export async function updateFilletCentersForNewGeometry(fillets: FilletInfo[], newGeometry: THREE.BufferGeometry, newSize: BoxSize): Promise<FilletInfo[]> {
  if (!fillets || fillets.length === 0) return fillets;
  const faces = extractFacesFromGeometry(newGeometry);
  return fillets.map((fillet, idx) => {
    if (!fillet.face1Descriptor || !fillet.face2Descriptor) return fillet;
    const f1 = findFaceByDescriptor(fillet.face1Descriptor, faces, newGeometry);
    const f2 = findFaceByDescriptor(fillet.face2Descriptor, faces, newGeometry);
    if (!f1 || !f2) { console.error(`Could not find matching face${f1 ? '2' : '1'} for fillet #${idx + 1}`); return fillet; }
    return {
      ...fillet, face1Data: { normal: vec3(f1.normal), center: vec3(f1.center) },
      face2Data: { normal: vec3(f2.normal), center: vec3(f2.center) }, originalSize: newSize,
    };
  });
}

export async function applyFillets(replicadShape: any, fillets: FilletInfo[], shapeSize: BoxSize) {
  if (!fillets || fillets.length === 0) return replicadShape;
  let currentShape = replicadShape;
  const tolerance = Math.max(shapeSize.width || 1, shapeSize.height || 1, shapeSize.depth || 1) * 0.08;
  for (const fillet of fillets) {
    const o = fillet.originalSize;
    const scale = new THREE.Vector3(shapeSize.width / o.width, shapeSize.height / o.height, shapeSize.depth / o.depth);
    // Yüz düzlemi (n, d), fillet kaydedildiği boyuttan güncel boyuta ölçeklenmiş.
    const plane = (f: FilletInfo['face1Data']) => {
      const n = new THREE.Vector3(...f.normal);
      const d = f.planeD !== undefined
        ? f.planeD * (n.x !== 0 ? scale.x : n.y !== 0 ? scale.y : scale.z)
        : n.dot(new THREE.Vector3(...f.center).multiply(scale));
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

/** Kutu − çıkarmalar (+ filletler); fillet merkezleri yeni geometriye göre tazelenir (refreshFillets=false → olduğu gibi). */
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
  return { replicadShape: shape, geometry: convertReplicadToThreeGeometry(shape), scaledBaseVertices: verts.map(vec3), fillets };
}

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
        ? cur.scaledBaseVertices.map(toVector3)
        : await getReplicadVertices(selectedShape.replicadShape);
      newBaseVertices = dimensionsChanged ? curBase.map(v => v.clone().multiply(scale)) : curBase;
    } else if (selectedShape.type === 'box') newBaseVertices = getBoxVertices(width, height, depth);

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
      parameters: {
        ...cur, width, height, depth, customParameters,
        scaledBaseVertices: newBaseVertices.length > 0 ? newBaseVertices.map(vec3) : cur.scaledBaseVertices,
      },
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

    const { rotation, scale: shapeScale, vertexModifications: vMods, parameters } = baseUpdate;
    if (!needsSolid) { updateShape(selectedShape.id, { rotation, scale: shapeScale, vertexModifications: vMods, parameters }); return; }
    const r = await rebuildBodySolid({ parameters: cur, fillets: withRadii(selectedShape.fillets || []) }, subtractions, size);
    updateShape(selectedShape.id, {
      geometry: r.geometry, replicadShape: r.replicadShape, fillets: r.fillets,
      ...(hasSubtractionChanges ? { subtractionGeometries: subtractions } : {}),
      position: [...selectedShape.position] as Vec3,
      rotation, scale: shapeScale, vertexModifications: vMods, parameters: { ...parameters, scaledBaseVertices: r.scaledBaseVertices },
    });
  } catch (error) {
    console.error('Failed to update parameters:', error);
    updateShape(selectedShape.id, { parameters: { ...selectedShape.parameters, width, height, depth, customParameters }, vertexModifications: [] });
  }
}

// ═══════════════════════════════════════════════════ 2. YÜZ BÖLGESİ ═══════════════════════════════════════════════════
// YÜZ BÖLGESİ — panel atma zincirinin saf geometri çekirdeği (UI yok). YAKALAMA ve REGEN aynı fonksiyonları
// kullanır; iki yol yapısal olarak ayrışamaz.
//  • Öncelik zinciri (computeFreeRegionLocal): kayıtlı bağ-ilişkisi > örtüşme sürekliliği > seed.
//  • Tam siluet yalnız sentetik damgaya aittir; gerçek dönmüş geometri (__rotatedRealGeom) kesit yolundan geçer.
//  • Çentikli (C/L/U) kardeş yüze birden fazla ayrık şeritle değebilir; her şerit ayrı engeldir.

export type Point2D = { x: number; y: number };
type BBox2 = { x0: number; x1: number; y0: number; y1: number };

function bbox2(pts: Point2D[]): BBox2 {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const q of pts) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; }
  return { x0, x1, y0, y1 };
}
function signedArea2(pts: Point2D[]): number {
  let s = 0;
  for (let k = 0; k < pts.length; k++) { const a = pts[k], b = pts[(k + 1) % pts.length]; s += a.x * b.y - b.x * a.y; }
  return s;
}
const cross2 = (a: Point2D, b: Point2D, c: Point2D) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
/** 3B noktanın (u, v) düzlem koordinatı. */
export const toUV = (p: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3): Point2D => ({ x: p.dot(u), y: p.dot(v) });

export function convexHull2D(points: Point2D[]): Point2D[] {
  if (points.length < 3) return [...points];
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const lower: Point2D[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross2(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point2D[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross2(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

// 2B ÇOKGEN YARDIMCILARI (kapak/arkalık şema ve kesimleri ortak kullanır): yarım düzlem kırpma, imzalı alan, dışbükeyle kırpma.
/** A·x + B·y ≤ C tarafı kalır (Sutherland–Hodgman tek kenar). */
export function clipHalfPlane(poly: Point2D[], A: number, B: number, C: number): Point2D[] {
  const out: Point2D[] = [];
  const f = (p: Point2D) => A * p.x + B * p.y - C;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const fa = f(a), fb = f(b);
    if (fa <= 0) out.push(a);
    if ((fa < 0 && fb > 0) || (fa > 0 && fb < 0)) { const t = fa / (fa - fb); out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); }
  }
  return out;
}
export const polyArea = (p: Point2D[]) => signedArea2(p) / 2;
/** Çokgeni DIŞBÜKEY çokgenle kırpar (yönelim CW / CCW fark etmez). */
export function clipPolyToConvex(poly: Point2D[], convex: Point2D[]): Point2D[] {
  if (convex.length < 3) return poly;
  const ccw = polyArea(convex) > 0;
  let out = poly;
  for (let i = 0; i < convex.length && out.length >= 3; i++) {
    const a = convex[i], b = convex[(i + 1) % convex.length];
    let A = b.y - a.y, B = -(b.x - a.x);   // CCW'de iç taraf kenarın solu: A·x + B·y ≤ A·ax + B·ay
    if (!ccw) { A = -A; B = -B; }
    out = clipHalfPlane(out, A, B, A * a.x + B * a.y);
  }
  return out;
}
/** Noktaların (u,v) izdüşümünün dışbükey zarfı (tekilleştirilmiş). */
export function frontHullOf(pts: Iterable<[number, number, number]>, u: 0 | 1 | 2, v: 0 | 1 | 2): Point2D[] {
  const out: Point2D[] = [], seen = new Set<string>();
  for (const q of pts) {
    const k = `${Math.round(q[u] * 10)},${Math.round(q[v] * 10)}`;
    if (!seen.has(k)) { seen.add(k); out.push({ x: q[u], y: q[v] }); }
  }
  return convexHull2D(out);
}
/** Panelin ön görünüşü (gövde çerçevesinde u,v izdüşüm zarfı, önbellekli): pahlı yan panel yamuktur, eksen-hizalı kutu
 *  eğik paneli örterdi. */
const _frontHullCache = new WeakMap<object, { key: string; hull: Point2D[] }>();
export function panelFrontHull(p: { geometry?: any; position?: number[] }, parent: { position?: number[] }, u: 0 | 1 | 2, v: 0 | 1 | 2): Point2D[] | null {
  const pos = p.geometry?.getAttribute?.('position') as THREE.BufferAttribute | undefined;
  if (!pos || pos.count < 3) return null;
  const off = [0, 1, 2].map(k => (p.position?.[k] ?? 0) - (parent.position?.[k] ?? 0));
  const key = `${u}${v}:${off.map(x => x.toFixed(2)).join(',')}:${pos.count}:${pos.version}`;
  const hit = _frontHullCache.get(p.geometry);
  if (hit && hit.key === key) return hit.hull;
  const pts = function* () {
    for (let i = 0; i < pos.count; i++) yield [pos.getX(i) + off[0], pos.getY(i) + off[1], pos.getZ(i) + off[2]] as [number, number, number];
  };
  const hull = frontHullOf(pts(), u, v);
  _frontHullCache.set(p.geometry, { key, hull });
  return hull;
}

function isPointInsidePolygon(p: Point2D, poly: Point2D[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > p.y) !== (yj > p.y) && p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function makePip(poly: Point2D[]): (x: number, y: number) => boolean {
  const b = bbox2(poly);
  const EPS = 1e-6;
  return (x, y) => {
    // y kutu dışı → hiçbir kenar kesişmez; x kutunun ötesinde → kesişim sayısı çift/0.
    if (y >= b.y1 || y < b.y0 || x > b.x1 + EPS || x < b.x0 - EPS) return false;
    return isPointInsidePolygon({ x, y }, poly);
  };
}

function isConvexPolygon2D(poly: Point2D[]): boolean {
  if (poly.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const cr = cross2(poly[i], poly[(i + 1) % poly.length], poly[(i + 2) % poly.length]);
    if (Math.abs(cr) < 1e-9) continue;
    if (sign === 0) sign = Math.sign(cr);
    else if (Math.sign(cr) !== sign) return false;
  }
  return true;
}

/** Çokgeni (a→b) doğrusunun SAĞ tarafıyla (cross <= 0) keser — tek kenarlı Sutherland-Hodgman. */
function clipByHalfPlane(poly: Point2D[], a: Point2D, b: Point2D): Point2D[] {
  const side = (p: Point2D) => cross2(a, b, p);
  const out: Point2D[] = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i], prev = poly[(i + poly.length - 1) % poly.length];
    const sc = side(cur), sp = side(prev);
    const cIn = sc <= 1e-9, pIn = sp <= 1e-9;
    if (cIn !== pIn) { const t = sp / (sp - sc); out.push({ x: prev.x + t * (cur.x - prev.x), y: prev.y + t * (cur.y - prev.y) }); }
    if (cIn) out.push(cur);
  }
  return out;
}

export function earClipTriangulate(vertices: Point2D[]): number[] {
  if (vertices.length < 3) return [];
  if (vertices.length === 3) return [0, 1, 2];
  const sgn = (p1: Point2D, p2: Point2D, p3: Point2D) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  const pointInTriangle = (p: Point2D, a: Point2D, b: Point2D, c: Point2D) => {
    const d1 = sgn(p, a, b), d2 = sgn(p, b, c), d3 = sgn(p, c, a);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  const indices: number[] = [];
  const remaining = vertices.map((_, i) => i);
  let safety = remaining.length * remaining.length;
  while (remaining.length > 3 && safety > 0) {
    safety--;
    let earFound = false;
    for (let i = 0; i < remaining.length; i++) {
      const prevIdx = (i + remaining.length - 1) % remaining.length, nextIdx = (i + 1) % remaining.length;
      const a = vertices[remaining[prevIdx]], b = vertices[remaining[i]], c = vertices[remaining[nextIdx]];
      if (cross2(a, b, c) < 1e-10) continue;
      let isEar = true;
      for (let j = 0; j < remaining.length; j++) {
        if (j === prevIdx || j === i || j === nextIdx) continue;
        if (pointInTriangle(vertices[remaining[j]], a, b, c)) { isEar = false; break; }
      }
      if (isEar) { indices.push(remaining[prevIdx], remaining[i], remaining[nextIdx]); remaining.splice(i, 1); earFound = true; break; }
    }
    if (!earFound) remaining.reverse();
  }
  if (remaining.length === 3) indices.push(remaining[0], remaining[1], remaining[2]);
  return indices;
}

export function pointInTriangle3D(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): boolean {
  const v0 = c.clone().sub(a), v1 = b.clone().sub(a), v2 = p.clone().sub(a);
  const dot00 = v0.dot(v0), dot01 = v0.dot(v1), dot02 = v0.dot(v2), dot11 = v1.dot(v1), dot12 = v1.dot(v2);
  const inv = 1 / (dot00 * dot11 - dot01 * dot01);
  const u = (dot11 * dot02 - dot01 * dot12) * inv;
  const v = (dot00 * dot12 - dot01 * dot02) * inv;
  return u >= -0.01 && v >= -0.01 && (u + v) <= 1.02;
}

type Edge2 = { a: Point2D; b: Point2D };

/** Kenar-halkası grafiğinden halkaları yürür. all=false: yalnız ilk kenardan başlayan halka; all=true: tüm
 *  bağlantısız halkalar (çentikli kardeş yüze ayrı şeritlerle değer; tek halka görünmeyen şeridi kaçırır). */
function walkBoundaryLoops(edges2: Edge2[], all: boolean): Point2D[][] {
  if (edges2.length < 3) return [];
  const keyOf = (p: Point2D) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
  const edges = edges2.map(e => ({ a: e.a, b: e.b, ak: keyOf(e.a), bk: keyOf(e.b) }));
  const adj = new Map<string, { other: string; point: Point2D }[]>();
  for (const e of edges) {
    if (e.ak === e.bk) continue;
    if (!adj.has(e.ak)) adj.set(e.ak, []);
    if (!adj.has(e.bk)) adj.set(e.bk, []);
    adj.get(e.ak)!.push({ other: e.bk, point: e.b });
    adj.get(e.bk)!.push({ other: e.ak, point: e.a });
  }
  const loops: Point2D[][] = [];
  const visited = new Set<string>();
  for (const e0 of edges) {
    if (all && (e0.ak === e0.bk || visited.has(e0.ak))) continue;
    const startKey = e0.ak;
    const loop: Point2D[] = [e0.a];
    let cur = startKey, prev = '';
    while (true) {
      visited.add(cur);
      const next = (adj.get(cur) || []).find(n => n.other !== prev && !visited.has(n.other));
      if (!next) break;
      loop.push(next.point);
      prev = cur; cur = next.other;
      if (cur === startKey || loop.length > edges.length + 2) break;
    }
    if (loop.length >= 3) loops.push(loop);
    if (!all) break;
    // Aynı bağlantılı bileşenin kalan düğümleri de ziyaret edildi sayılır (ikinci kısmi halka üretilmez).
    const stack = [startKey];
    while (stack.length) {
      const k = stack.pop()!;
      for (const n of adj.get(k) || []) if (!visited.has(n.other)) { visited.add(n.other); stack.push(n.other); }
    }
  }
  return loops;
}

/** Üçgen köşe indeksi okuyucu (indeksli / indekssiz geometri). */
function triIndexer(geometry: THREE.BufferGeometry): { cnt: number; at: (k: number) => number } {
  const idx = geometry.getIndex();
  return { cnt: idx ? idx.count : (geometry.getAttribute('position') as THREE.BufferAttribute).count, at: k => (idx ? idx.getX(k) : k) };
}

function onPlaneBoundaryEdges(geometry: THREE.BufferGeometry, onPlane: boolean[], pt2: (i: number) => Point2D): Edge2[] {
  const { cnt, at } = triIndexer(geometry);
  const edgeCount = new Map<string, number>();
  const edgeData = new Map<string, Edge2>();
  for (let t = 0; t + 2 < cnt; t += 3) {
    const i0 = at(t), i1 = at(t + 1), i2 = at(t + 2);
    if (!onPlane[i0] || !onPlane[i1] || !onPlane[i2]) continue;
    for (const [a, b] of [[i0, i1], [i1, i2], [i2, i0]]) {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
      if (!edgeData.has(key)) edgeData.set(key, { a: pt2(a), b: pt2(b) });
    }
  }
  const out: Edge2[] = [];
  for (const [key, c] of edgeCount) if (c === 1) out.push(edgeData.get(key)!);
  return out;
}

/** Ayak izi geometrisi: arkalık kanalı açılmış panelde KANALSIZ mesh (yalnız kendi grooved mesh'iyle eşleşiyorsa — sentetik
 *  damga değil). */
export function footprintGeometry(panel: any): THREE.BufferGeometry | undefined {
  const ug = panel?.ungroovedGeometry as THREE.BufferGeometry | undefined;
  return ug && panel.geometry && ug.userData?.groovedUuid === panel.geometry.uuid ? ug : panel?.geometry;
}
/** Panelin yüz düzlemine değen 2B ayak izi; değmiyorsa null (o yüzeyde engel değil). */
function panelFootprintOnPlane(
  panel: any, facePlaneNormal: THREE.Vector3, facePlaneOrigin: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3, planeTolerance = 5.0
): Point2D[] | null {
  const geometry = footprintGeometry(panel);
  if (!geometry) return null;
  const panelMatrix = getShapeMatrix(panel);
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
  const pts2D: Point2D[] = [], all2D: Point2D[] = [], onPlane: boolean[] = [];
  let nMin = Infinity, nMax = -Infinity;
  for (let i = 0; i < posAttr.count; i++) {
    const d = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(panelMatrix).sub(facePlaneOrigin);
    const signed = facePlaneNormal.dot(d);
    nMin = Math.min(nMin, signed); nMax = Math.max(nMax, signed);
    const p2 = toUV(d, u, v), on = Math.abs(signed) < planeTolerance;
    all2D.push(p2); onPlane.push(on);
    if (on) pts2D.push(p2);
  }
  if (pts2D.length < 3) {
    if (nMin <= planeTolerance && nMax >= -planeTolerance && all2D.length >= 3) {
      const hullAll = convexHull2D(all2D);
      return hullAll.length >= 3 ? hullAll : null;
    }
    return null;
  }
  // Düzlem-üstü üçgenlerin gerçek (içbükey korunur) sınır halkası; zincir başarısızsa dışbükey zarf.
  const loop = walkBoundaryLoops(onPlaneBoundaryEdges(geometry, onPlane, i => all2D[i]), false)[0];
  if (loop && loop.length >= 3) return loop;
  const hull = convexHull2D(pts2D);
  return hull.length >= 3 ? hull : null;
}

/** ÜST ÜSTE PANEL (eğimli taban): tabanın `toward` noktasına bakan BÜYÜK yüzü (iki büyük yüzden normali o yöne bakan). Gövde-yerel. */
export function panelInnerBigFace(panel: any, toward: THREE.Vector3): { faces: FaceData[]; group: CoplanarFaceGroup } | null {
  const geo = panel?.geometry; if (!geo) return null;
  const { faces, groups } = getFacesAndGroups(geo);
  const big = [...groups].filter(g => !g.isCurved).sort((a, b) => b.totalArea - a.totalArea).slice(0, 2);
  const g = big.find(x => x.normal.clone().normalize().dot(toward.clone().sub(x.center)) > 0) ?? null;
  return g ? { faces, group: g } : null;
}

/** ÜST ÜSTE PANEL: panelin tamamı, dışa normali `nOut` olan yüzün `planeInward` kadar içindeki düzlemin GERİSİNDE mi (altta kalan
 *  taban/ara paneller)? Düzlemi aşan levhalar (üst/alt/arkalık) false → engel kalır. Koordinatlar gövde-yerel. */
export function panelBehindStackPlane(panel: any, nOut: THREE.Vector3, planeInward: number, tol = 0.5): boolean {
  // Gerçek köşeler (bbox değil): dönmüş levhanın eksen-hizalı kutusu düzlemin iki yanına taşar, kendisi taşmaz.
  const geo: THREE.BufferGeometry | undefined = footprintGeometry(panel) ?? panel?.geometry;
  const pos = geo?.getAttribute?.('position') as THREE.BufferAttribute | undefined;
  if (!pos) return false;
  const inw = nOut.clone().multiplyScalar(-1);
  let maxIn = -Infinity;
  for (let i = 0; i < pos.count; i++) maxIn = Math.max(maxIn, pos.getX(i) * inw.x + pos.getY(i) * inw.y + pos.getZ(i) * inw.z);
  return maxIn <= planeInward + tol;
}

export function findPanelCoveringPoint(worldPt: THREE.Vector3, childPanels: any[], facePlaneNormal: THREE.Vector3, facePlaneOrigin: THREE.Vector3): any | null {
  const { u, v } = getFacePlaneAxes(facePlaneNormal);
  const p2 = toUV(new THREE.Vector3().subVectors(worldPt, facePlaneOrigin), u, v);
  for (const panel of childPanels) {
    const fp = panelFootprintOnPlane(panel, facePlaneNormal, facePlaneOrigin, u, v);
    if (fp && isPointInsidePolygon(p2, fp)) return panel;
  }
  return null;
}

/** Seed'i içeren/ona en yakın üçgenin bağlantılı bileşeninin konturu, sınır kenarları ve alan-ağırlıklı merkezi.
 *  VF her zaman tıklanan bileşenin GERÇEK konturudur; ayrık eş-düzlem parçalar asla birleşmez. */
export function computeFaceComponentContour(
  faces: FaceData[], faceIndices: number[], seedLocal: THREE.Vector3, groupNormal: THREE.Vector3
): { comp: number[]; seedFi: number; corners: THREE.Vector3[]; center: THREE.Vector3; boundary: Array<{ a: THREE.Vector3; b: THREE.Vector3 }> } | null {
  let seedFi = -1, bestD = Infinity;
  for (const fi of faceIndices) {
    const f = faces[fi];
    if (!f) continue;
    if (pointInTriangle3D(seedLocal, f.vertices[0], f.vertices[1], f.vertices[2])) { seedFi = fi; break; }
    // İçeren üçgen yoksa: en yakın MERKEZ değil, üçgen ÜZERİNDEKİ en yakın nokta (kenar clamp).
    let dMin = Infinity;
    for (let k = 0; k < 3; k++) {
      const a = f.vertices[k], b = f.vertices[(k + 1) % 3];
      const ab = new THREE.Vector3().subVectors(b, a);
      const t = Math.max(0, Math.min(1, new THREE.Vector3().subVectors(seedLocal, a).dot(ab) / (ab.lengthSq() || 1)));
      dMin = Math.min(dMin, a.clone().addScaledVector(ab, t).distanceTo(seedLocal));
    }
    if (dMin < bestD) { bestD = dMin; seedFi = fi; }
  }
  if (seedFi === -1) return null;

  const vKey = (v3: THREE.Vector3) => `${v3.x.toFixed(1)},${v3.y.toFixed(1)},${v3.z.toFixed(1)}`;
  const triKeys = new Map<number, string[]>();
  for (const fi of faceIndices) { const f = faces[fi]; if (f) triKeys.set(fi, f.vertices.map(vKey)); }
  const comp = new Set<number>([seedFi]);
  const stack = [seedFi];
  while (stack.length) {
    const ck = new Set(triKeys.get(stack.pop()!) || []);
    for (const [fi, ks] of triKeys) {
      if (comp.has(fi)) continue;
      if (ks.some(k => ck.has(k))) { comp.add(fi); stack.push(fi); }
    }
  }

  const edgeMap = new Map<string, { a: THREE.Vector3; b: THREE.Vector3; n: number }>();
  for (const fi of comp) {
    const f = faces[fi]!;
    for (let i = 0; i < 3; i++) {
      const a = f.vertices[i], b = f.vertices[(i + 1) % 3];
      const k = [vKey(a), vKey(b)].sort().join('|');
      const e = edgeMap.get(k);
      if (e) e.n++; else edgeMap.set(k, { a: a.clone(), b: b.clone(), n: 1 });
    }
  }
  const boundary = [...edgeMap.values()].filter(e => e.n === 1);
  if (boundary.length < 3) return null;

  const remaining = boundary.map(e => ({ a: e.a, b: e.b }));
  const ring: THREE.Vector3[] = [remaining[0].a, remaining[0].b];
  remaining.splice(0, 1);
  let guard = boundary.length * 2;
  while (remaining.length > 0 && guard-- > 0) {
    const tk = vKey(ring[ring.length - 1]);
    const idx = remaining.findIndex(e => vKey(e.a) === tk || vKey(e.b) === tk);
    if (idx === -1) break;
    const e = remaining[idx];
    ring.push(vKey(e.a) === tk ? e.b : e.a);
    remaining.splice(idx, 1);
  }
  if (ring.length >= 2 && vKey(ring[0]) === vKey(ring[ring.length - 1])) ring.pop();
  if (ring.length < 3) return null;

  const { u, v } = getFacePlaneAxes(groupNormal.clone().normalize());
  const ring2D = ring.map(p3 => toUV(p3, u, v));
  const keep: number[] = [];
  for (let i = 0; i < ring2D.length; i++) {
    if (Math.abs(cross2(ring2D[(i - 1 + ring2D.length) % ring2D.length], ring2D[i], ring2D[(i + 1) % ring2D.length])) > 0.05) keep.push(i);
  }
  const corners = keep.length >= 3 ? keep.map(i => ring[i]) : ring;

  const center = new THREE.Vector3();
  let areaSum = 0;
  for (const fi of comp) {
    const f = faces[fi]!;
    const ar = new THREE.Vector3().subVectors(f.vertices[1], f.vertices[0]).cross(new THREE.Vector3().subVectors(f.vertices[2], f.vertices[0])).length() / 2;
    center.addScaledVector(f.vertices[0].clone().add(f.vertices[1]).add(f.vertices[2]).multiplyScalar(1 / 3), ar);
    areaSum += ar;
  }
  if (areaSum > 0) center.multiplyScalar(1 / areaSum);
  return { comp: [...comp], seedFi, corners, center, boundary };
}

export interface RotOp { kind?: 'rotate' | 'translate'; pivot?: THREE.Vector3; axis?: THREE.Vector3; angleRad?: number; d?: THREE.Vector3 }

/** Dönüş ops'u; varsa composeSteps'in çözdüğü __composedOps (gerçek dönüşle birebir). Pivot/axis DÜNYA koordinatında. */
function buildRotationOpsFromPanel(panel: any): RotOp[] {
  if (Array.isArray(panel?.__composedOps)) return panel.__composedOps;
  const steps: any[] = Array.isArray(panel?.parameters?.transformSteps) ? panel.parameters.transformSteps.filter((s: any) => s?.type === 'rotate') : [];
  const ops: RotOp[] = [];
  for (const s of steps) {
    const deg = s.value || 0;
    if (Math.abs(deg) < 1e-6) continue;
    ops.push({
      kind: 'rotate', angleRad: (deg * Math.PI) / 180,
      axis: s.axisVec ? new THREE.Vector3(...s.axisVec).normalize() : axisDirToVec(s.axis),
      pivot: s.pivot ? new THREE.Vector3(...s.pivot) : new THREE.Vector3(),
    });
  }
  return ops;
}

/** Kardeş panelin bu yüz düzlemindeki ayak izi — tüm bağlantısız parçalar; yüze değmiyorsa null. */
function panelFootprintsInParentLocal(
  panel: any, parentWorldToLocal: THREE.Matrix4, nrm: THREE.Vector3, planeN: number, u: THREE.Vector3, v: THREE.Vector3, tol = 3.0
): Point2D[][] | null {
  const geometry = footprintGeometry(panel);
  if (!geometry) return null;
  const pos = geometry.getAttribute('position');
  if (!pos) return null;
  const M = new THREE.Matrix4().multiplyMatrices(parentWorldToLocal, getShapeMatrix(panel));
  // Konveks gövde (tam siluet) yalnız sentetik damga içindir; GERÇEK dönmüş geometride siluet, yüze kenarıyla
  // değen panelde yüzün yarısını dolu gösterir. Engel, panelin yüze DEĞEN alanıdır, gölgesi değil.
  const isRotated = panel.__isRotatedPanel === true && panel.__rotatedRealGeom !== true;
  const pts: THREE.Vector3[] = []; const d: number[] = [];
  let dMin = Infinity, dMax = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const p = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(M);
    const dd = p.dot(nrm) - planeN;
    pts.push(p); d.push(dd);
    if (dd < dMin) dMin = dd; if (dd > dMax) dMax = dd;
  }
  if (pts.length < 3) return null;
  // Tüm köşeler düzlemin aynı tarafında ve tolerans dışındaysa iz yok (paralel/uzak kardeş).
  if (dMin > tol || dMax < -tol) return null;
  const out: Point2D[] = [];
  let flatVertCount = 0;
  for (let i = 0; i < pts.length; i++) if (Math.abs(d[i]) < tol) { out.push(toUV(pts[i], u, v)); flatVertCount++; }
  if (isRotated) {
    const localOps = buildRotationOpsFromPanel(panel).map(op => ({
      kind: op.kind || 'rotate',
      pivot: op.pivot ? op.pivot.clone().applyMatrix4(parentWorldToLocal) : undefined,
      axis: op.axis ? op.axis.clone().transformDirection(parentWorldToLocal).normalize() : undefined,
      angleRad: op.angleRad || 0,
      // Öteleme normalize EDİLMEZ (transformDirection birim vektör döndürür).
      d: op.d ? op.d.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(parentWorldToLocal)) : undefined,
    }));
    const moved = pts.map(p => {
      const v3 = p.clone();
      for (const op of localOps) {
        if (op.kind === 'translate') { if (op.d) v3.add(op.d); }
        else if (op.pivot && op.axis) { v3.sub(op.pivot); v3.applyAxisAngle(op.axis, op.angleRad); v3.add(op.pivot); }
      }
      return v3;
    });
    // Taşınmış damga: değme kapısı adımlardan SONRA yeniden sınanır (hayalet iz olmasın).
    if (localOps.some(op => op.kind === 'translate' && op.d && op.d.lengthSq() > 1e-6)) {
      let mn = Infinity, mx = -Infinity;
      for (const q of moved) { const dd = q.dot(nrm) - planeN; if (dd < mn) mn = dd; if (dd > mx) mx = dd; }
      if (mn > tol || mx < -tol) return null;
    }
    if (moved.length < 3) return null;
    const hull = convexHull2D(moved.map(v3 => toUV(v3, u, v)));
    return hull.length >= 3 ? [hull] : null;
  }
  const pierces = dMin < -tol && dMax > tol;
  if (pierces) {
    const { cnt, at } = triIndexer(geometry);
    for (let t = 0; t + 2 < cnt; t += 3) {
      const tri = [at(t), at(t + 1), at(t + 2)];
      for (let e = 0; e < 3; e++) {
        const a = tri[e], b = tri[(e + 1) % 3], da = d[a], db = d[b];
        if ((da > 0 && db > 0) || (da < 0 && db < 0)) continue;
        const den = da - db;
        if (Math.abs(den) < 1e-9) continue;
        const sT = da / den;
        if (sT < 0 || sT > 1) continue;
        out.push(toUV(new THREE.Vector3().lerpVectors(pts[a], pts[b], sT), u, v));
      }
    }
  }
  if (out.length < 3) return null;
  // İçbükey sınır: düzlem-üstü üçgenlerin kenar halkaları (çok parçalı temasta hepsi; dejenere halkalar elenir).
  const bEdges = onPlaneBoundaryEdges(geometry, d.map(dd => Math.abs(dd) < tol), i => toUV(pts[i], u, v));
  if (bEdges.length >= 3) {
    const good = walkBoundaryLoops(bEdges, true).filter(l => l.length >= 3 && Math.abs(signedArea2(l)) / 2 > 1.0);
    // Halka yönü mesh sarımından gelir (OCC ve sentetik prizma ters sarılabilir); kırpma (clipByFootprint) CCW
    // (pozitif alan) varsayar — ters halkada şeridin UZAK kenarı seçilir ve bölge dikmenin içinden geçer.
    for (const l of good) if (signedArea2(l) < 0) l.reverse();
    if (good.length > 0) return good;
  }
  const hull = convexHull2D(out);
  if (hull.length < 3) return null;
  // SALT-KESİT KENAR-TEMASI: yüzü yalnız delen (yatık yüzü yok) ince kesit engel değildir — yüzü bölüp bölgenin
  // yarısını silmesin; rebuild'de boolean ile biçilir. Yatık yüzle yaslanan (flatVertCount>0) gerçek engeldir.
  // İstisna: ÜST ÜSTE PANEL düzleminde (gövde yüzünün içinde) delen levhalar gerçek engeldir (__pierceObstacle — PanelEngine / Scene verir).
  if (pierces && flatVertCount === 0 && !isRotated && panel.__pierceObstacle !== true) {
    const hb = bbox2(hull);
    const minSpan = Math.min(hb.x1 - hb.x0, hb.y1 - hb.y0);
    // İnce eşiği: geometrinin en ince ekseni (kalınlık, en az 18) + 12 mm pay.
    const sz = localBboxOf(geometry)!.getSize(new THREE.Vector3());
    const thinThreshold = Math.max(Math.min(sz.x, sz.y, sz.z), 18) + 12;
    if (minSpan <= thinThreshold) return null;
  }
  return [hull];
}

function flood4(free: Uint8Array, nx: number, ny: number, start: number, mark: Uint8Array | Int32Array, value = 1): void {
  const stack = [start];
  mark[start] = value;
  while (stack.length) {
    const k0 = stack.pop()!;
    const i = k0 % nx, j = (k0 / nx) | 0;
    for (const [a, b] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]] as Array<[number, number]>) {
      if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
      const k = b * nx + a;
      if (free[k] && mark[k] !== value && (mark instanceof Uint8Array || mark[k] === -1)) { mark[k] = value; stack.push(k); }
    }
  }
}

function traceReachBoundary(reach: Uint8Array, nx: number, ny: number, uMin: number, vMin: number, cw: number, ch: number): Point2D[] {
  const segs: Array<[Point2D, Point2D]> = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!reach[j * nx + i]) continue;
    const x0 = uMin + i * cw, x1 = x0 + cw, y0 = vMin + j * ch, y1 = y0 + ch;
    if (i === 0 || !reach[j * nx + i - 1]) segs.push([{ x: x0, y: y0 }, { x: x0, y: y1 }]);
    if (i === nx - 1 || !reach[j * nx + i + 1]) segs.push([{ x: x1, y: y0 }, { x: x1, y: y1 }]);
    if (j === 0 || !reach[(j - 1) * nx + i]) segs.push([{ x: x0, y: y0 }, { x: x1, y: y0 }]);
    if (j === ny - 1 || !reach[(j + 1) * nx + i]) segs.push([{ x: x0, y: y1 }, { x: x1, y: y1 }]);
  }
  if (segs.length < 3) return [];
  // KENAR bazlı yürüyüş: çapraz birleşen köşeden halka iki kez geçer; köşe-ziyaret işareti zinciri erken keserdi.
  const K = (p: Point2D) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`;
  const adj = new Map<string, Array<{ to: Point2D; si: number }>>();
  segs.forEach(([a, b], si) => {
    const ka = K(a), kb = K(b);
    if (!adj.has(ka)) adj.set(ka, []);
    if (!adj.has(kb)) adj.set(kb, []);
    adj.get(ka)!.push({ to: b, si });
    adj.get(kb)!.push({ to: a, si });
  });
  const usedSeg = new Uint8Array(segs.length);
  let bestRing: Point2D[] = [];
  for (let s0 = 0; s0 < segs.length; s0++) {
    if (usedSeg[s0]) continue;
    const startP = segs[s0][0];
    const ring: Point2D[] = [startP];
    let cur = startP;
    for (let guard = 0; guard <= segs.length + 4; guard++) {
      const nxt = (adj.get(K(cur)) || []).find(e => !usedSeg[e.si]);
      if (!nxt) break;
      usedSeg[nxt.si] = 1;
      cur = nxt.to;
      if (K(cur) === K(startP)) break;
      ring.push(cur);
    }
    if (ring.length > bestRing.length) bestRing = ring;
  }
  if (bestRing.length < 3) return [];
  const out = bestRing.filter((b, i) => Math.abs(cross2(bestRing[(i - 1 + bestRing.length) % bestRing.length], b, bestRing[(i + 1) % bestRing.length])) > 1e-6);
  return out.length >= 3 ? out : bestRing;
}

/** Grid halkasını kaynak kenarlara (yüz konturu + ayak izleri) oturtur: köşe en yakın doğruya / iki doğrunun
 *  kesişimine taşınır; eşdoğrusal köşeler atılınca merdiven basamakları tek köşegene çöker. */
function fitTracedPolygonToSources(poly: Point2D[], sources: Point2D[][], tolDist: number): Point2D[] {
  if (poly.length < 3) return poly;
  type Seg = { a: Point2D; d: Point2D; len: number };
  const segs: Seg[] = [];
  for (const src of sources) for (let i = 0; i < src.length; i++) {
    const a = src[i], b = src[(i + 1) % src.length];
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
    if (L > 1e-6) segs.push({ a, d: { x: dx / L, y: dy / L }, len: L });
  }
  const segT = (q: Point2D, s: Seg) => (q.x - s.a.x) * s.d.x + (q.y - s.a.y) * s.d.y;
  const segDist = (q: Point2D, s: Seg): number => {
    const t = segT(q, s);
    if (t < -tolDist || t > s.len + tolDist) return Infinity;
    return Math.abs((q.x - s.a.x) * s.d.y - (q.y - s.a.y) * s.d.x);
  };
  const fitted: Point2D[] = poly.map(q => {
    const near = segs.map(s => ({ s, dd: segDist(q, s) })).filter(e => e.dd <= tolDist).sort((p, r) => p.dd - r.dd);
    if (near.length === 0) return q;
    const s1 = near[0].s;
    const s2 = near.find(e => Math.abs(s1.d.x * e.s.d.y - s1.d.y * e.s.d.x) > 0.15)?.s;
    if (s2) {
      const den = s1.d.x * s2.d.y - s1.d.y * s2.d.x;
      const t = ((s2.a.x - s1.a.x) * s2.d.y - (s2.a.y - s1.a.y) * s2.d.x) / den;
      const ip = { x: s1.a.x + s1.d.x * t, y: s1.a.y + s1.d.y * t };
      if (Math.hypot(ip.x - q.x, ip.y - q.y) <= 2 * tolDist) return ip;
    }
    const t = segT(q, s1);
    return { x: s1.a.x + s1.d.x * t, y: s1.a.y + s1.d.y * t };
  });
  const dedup: Point2D[] = [];
  for (const p of fitted) {
    const prev = dedup[dedup.length - 1];
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 0.5) dedup.push(p);
  }
  while (dedup.length > 1 && Math.hypot(dedup[0].x - dedup[dedup.length - 1].x, dedup[0].y - dedup[dedup.length - 1].y) <= 0.5) dedup.pop();
  let out = dedup;
  for (let pass = 0; pass < 4 && out.length > 3; pass++) {
    const next: Point2D[] = [];
    let removed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
      const dist = Math.abs(cross2(a, b, c)) / (Math.hypot(c.x - a.x, c.y - a.y) || 1e-9);
      if (dist < 0.5) { removed = true; continue; }
      next.push(b);
    }
    if (next.length < 3) break;
    out = next;
    if (!removed) break;
  }
  return out.length >= 3 ? out : poly;
}

/** Etkin levha kalınlığı: parametre ile geometrinin en ince ekseninin büyüğü (extrude'la kalınlaşmış panel). */
function effectiveSlabThickness(panel: any): number {
  const base = panelThickness(panel);
  const box = panel?.geometry ? localBboxOf(panel.geometry) : null;
  if (!box) return base;
  const sz = box.getSize(new THREE.Vector3());
  const mn = Math.min(sz.x, sz.y, sz.z);
  return Number.isFinite(mn) && mn > 0.5 ? Math.max(base, mn) : base;
}

/** Kanonik şerit çerçevesi: hull merkezi + uzun kenara dik, işareti kanonik birim eksen — taraf işareti
 *  (sign(dot(P−c, p̂))) şerit hafif eğilse de regen'ler arası karşılaştırılabilir. */
function canonicalStripFrame(fp: Point2D[]): { c: Point2D; p: Point2D } {
  let cx = 0, cy = 0;
  for (const q of fp) { cx += q.x; cy += q.y; }
  cx /= fp.length; cy /= fp.length;
  let bl = -1, dx = 1, dy = 0;
  for (let k = 0; k < fp.length; k++) {
    const a = fp[k], b = fp[(k + 1) % fp.length];
    const ex = b.x - a.x, ey = b.y - a.y, L = ex * ex + ey * ey;
    if (L > bl) { bl = L; dx = ex; dy = ey; }
  }
  const len = Math.hypot(dx, dy) || 1e-9;
  let px = -dy / len, py = dx / len;
  if (Math.abs(py) >= Math.abs(px)) { if (py < 0) { px = -px; py = -py; } }
  else if (px < 0) { px = -px; py = -py; }
  return { c: { x: cx, y: cy }, p: { x: px, y: py } };
}
const stripSide = (pt: Point2D, fr: { c: Point2D; p: Point2D }) => (pt.x - fr.c.x) * fr.p.x + (pt.y - fr.c.y) * fr.p.y;

/** Dikdörtgensel KESİN serbest bölge: yarım-düzlem kırpması içbükey (L/U) bölgenin bir kolunu siler; eksen-hizalı
 *  geometride koordinat-sıkıştırılmış ızgarada çözülür, uygun değilse null. `nib` = köşe cebi budama eşiği (0 → yok). */
function rectilinearFreeRegion(ring2D: Point2D[], blockers: Point2D[][], anchorPt: Point2D, nib = 25): Point2D[] | null {
  const AX = 0.05;
  if (ring2D.length < 4) return null;
  for (let k = 0; k < ring2D.length; k++) {
    const a = ring2D[k], b = ring2D[(k + 1) % ring2D.length];
    if (Math.abs(a.x - b.x) > AX && Math.abs(a.y - b.y) > AX) return null;
  }
  const rects: BBox2[] = [];
  for (const fp of blockers) {
    if (fp.length < 3) return null;
    const r = bbox2(fp);
    const bbA = (r.x1 - r.x0) * (r.y1 - r.y0);
    if (bbA <= 1e-6 || Math.abs(Math.abs(signedArea2(fp)) / 2 - bbA) > Math.max(1, bbA * 0.01)) return null; // dikdörtgen değil
    rects.push(r);
  }
  const uniq = (vals: number[]) => {
    vals.sort((p, q) => p - q);
    const out: number[] = [];
    for (const val of vals) if (!out.length || val - out[out.length - 1] > AX) out.push(val);
    return out;
  };
  const rb = bbox2(ring2D);
  const clampX = (x: number) => Math.max(rb.x0, Math.min(rb.x1, x));
  const clampY = (y: number) => Math.max(rb.y0, Math.min(rb.y1, y));
  const xs = uniq([...ring2D.map(q => q.x), ...rects.flatMap(r => [clampX(r.x0), clampX(r.x1)])]);
  const ys = uniq([...ring2D.map(q => q.y), ...rects.flatMap(r => [clampY(r.y0), clampY(r.y1)])]);
  const NX = xs.length - 1, NY = ys.length - 1;
  if (NX < 1 || NY < 1 || NX * NY > 40000) return null;
  const free = new Uint8Array(NX * NY);
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const pt = { x: (xs[i] + xs[i + 1]) / 2, y: (ys[j] + ys[j + 1]) / 2 };
    if (!isPointInsidePolygon(pt, ring2D)) continue;
    if (!rects.some(r => pt.x > r.x0 && pt.x < r.x1 && pt.y > r.y0 && pt.y < r.y1)) free[j * NX + i] = 1;
  }
  let ai = -1, aj = -1;
  for (let i = 0; i < NX; i++) if (anchorPt.x >= xs[i] && anchorPt.x <= xs[i + 1]) { ai = i; break; }
  for (let j = 0; j < NY; j++) if (anchorPt.y >= ys[j] && anchorPt.y <= ys[j + 1]) { aj = j; break; }
  if (ai < 0 || aj < 0 || !free[aj * NX + ai]) return null;
  const reached = new Uint8Array(NX * NY);
  flood4(free, NX, NY, aj * NX + ai, reached);
  // KÖŞE CEBİ BUDAMA: ≤nib×≤nib hücre iki eksende de tek taraftan komşuluysa atılır (tırnak/çentik olmasın).
  const R = (i: number, j: number) => i >= 0 && j >= 0 && i < NX && j < NY && reached[j * NX + i] === 1;
  for (let changed = nib > 0; changed;) {
    changed = false;
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      if (!reached[j * NX + i] || (i === ai && j === aj)) continue;
      if (xs[i + 1] - xs[i] > nib || ys[j + 1] - ys[j] > nib) continue;
      if ((R(i - 1, j) && R(i + 1, j)) || (R(i, j - 1) && R(i, j + 1))) continue;
      reached[j * NX + i] = 0; changed = true;
    }
  }
  // Sınır kenarları (CCW); sıkışma köşesi / delik → vazgeç
  const edges = new Map<string, Array<[number, number]>>();
  let edgeCount = 0;
  const addE = (x0: number, y0: number, x1: number, y1: number) => {
    const key = `${x0},${y0}`;
    if (!edges.has(key)) edges.set(key, []);
    edges.get(key)!.push([x1, y1]);
    edgeCount++;
  };
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    if (!R(i, j)) continue;
    if (!R(i, j - 1)) addE(i, j, i + 1, j);
    if (!R(i + 1, j)) addE(i + 1, j, i + 1, j + 1);
    if (!R(i, j + 1)) addE(i + 1, j + 1, i, j + 1);
    if (!R(i - 1, j)) addE(i, j + 1, i, j);
  }
  for (const lst of edges.values()) if (lst.length !== 1) return null;
  const startKey = edges.keys().next().value as string | undefined;
  if (!startKey) return null;
  const loop: Array<[number, number]> = [];
  let cur = startKey.split(',').map(Number) as [number, number];
  for (let guard = 0; guard <= edgeCount; guard++) {
    loop.push(cur);
    const nxt = edges.get(`${cur[0]},${cur[1]}`)![0];
    if (`${nxt[0]},${nxt[1]}` === startKey) break;
    cur = nxt;
  }
  if (loop.length !== edgeCount) return null;
  const simp = loop.filter((c, k) => {
    const p = loop[(k + loop.length - 1) % loop.length], n = loop[(k + 1) % loop.length];
    return !(p[0] === c[0] && c[0] === n[0]) && !(p[1] === c[1] && c[1] === n[1]);
  });
  if (simp.length < 4) return null;
  const poly: Point2D[] = simp.map(([i, j]) => ({ x: xs[i], y: ys[j] }));
  if (Math.sign(signedArea2(poly)) !== Math.sign(signedArea2(ring2D))) poly.reverse();
  return poly;
}

const _tiltCache = new WeakMap<object, boolean>();
/** En büyük toplam alanlı yüz normali (işaret: ilk sıfırdan farklı bileşen pozitif); geometri yoksa null.
 *  `tol`: x / y bileşeni bu kadar negatif olmadıkça çevrilmez (önizleme çerçevesi 1e-6 ile gürültüye karşı korunur). */
export function largestFaceNormal(geo: any, tol = 0): THREE.Vector3 | null {
  if (!geo || typeof geo.getAttribute !== 'function') return null;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) return null;
  const { cnt, at } = triIndexer(geo);
  const bins = new Map<string, { n: THREE.Vector3; a: number }>();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let t = 0; t + 2 < cnt; t += 3) {
    a.fromBufferAttribute(pos, at(t)); b.fromBufferAttribute(pos, at(t + 1)); c.fromBufferAttribute(pos, at(t + 2));
    n.crossVectors(b.sub(a), c.sub(a));
    const area = n.length() / 2;
    if (area < 1e-6) continue;
    n.divideScalar(area * 2);
    const x0 = Math.abs(n.x) < 1e-6;
    if (n.x < -tol || (x0 && n.y < -tol) || (x0 && Math.abs(n.y) < 1e-6 && n.z < 0)) n.negate();
    const key = `${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)}`;
    const e = bins.get(key);
    if (e) e.a += area; else bins.set(key, { n: n.clone(), a: area });
  }
  let best: { n: THREE.Vector3; a: number } | null = null;
  bins.forEach(e => { if (!best || e.a > best.a) best = e; });
  return best ? (best as { n: THREE.Vector3; a: number }).n.clone() : null;
}
/** VF-eğimli levha (eğilmiş gövde yüzünde): dönüş adımı yok ama DÖNMÜŞ kardeş gibi ele alınır. */
export function panelIsTiltedSlab(panel: any): boolean {
  const geo = panel?.geometry;
  if (!geo || typeof geo.getAttribute !== 'function') return false;
  const hit = _tiltCache.get(geo);
  if (hit !== undefined) return hit;
  let tilted = false;
  try {
    const best = largestFaceNormal(geo);
    if (best) tilted = !isFlatNormal(best, 0.999 - Number.EPSILON);
  } catch { tilted = false; }
  _tiltCache.set(geo, tilted);
  return tilted;
}

/** Sıfır olmayan dönüş adımı var mı (VF-eğimli levha da sayılır)? Ref dönüşte gerçek açı resolvedValue'dadır. */
export function panelHasRotation(panel: any): boolean {
  if (panelIsTiltedSlab(panel)) return true;
  const ops = panel?.__composedOps;
  if (Array.isArray(ops) && ops.some((o: any) => o?.kind === 'rotate' && Math.abs(o.angleRad || 0) > 1e-6)) return true;
  const ts = panel?.parameters?.transformSteps;
  const degOf = (st: any) => (typeof st?.resolvedValue === 'number' ? st.resolvedValue : (st?.value || 0));
  return Array.isArray(ts) && ts.some((st: any) => st?.type === 'rotate' && (Math.abs(degOf(st)) > 1e-6 || Math.abs(st?.value || 0) > 1e-6));
}

// SERBEST BÖLGE: ayak izleri tek zincirle parent-yerel uzaya taşınır; geometri tam çokgen farkından gelir
// (köşegen tırtıksız), grid yalnız KARAR verir (hangi iz engelliyor, sonuç görülen reach ile uyuşuyor mu).

export interface FreeRegionResult {
  u: THREE.Vector3; v: THREE.Vector3; planeN: number;
  ring2D: Point2D[]; footprints: Point2D[][]; touchingSiblingIds: string[];
  uMin: number; vMin: number; cw: number; ch: number; nx: number; ny: number;
  reach: Uint8Array; anchor: Point2D;
  polygon: Point2D[];
  /** Her ayak izinin sahibi: panel id (ilk parça) ya da `${id}#k` (ek parçalar). */
  footprintIds: (string | null)[];
  /** Kardeş ayak izine göre taraf (id → ±1); VF'de saklanır, regen'e geri geçer. */
  sideRelations: Record<string, number>;
}

/** @param prevRegionCorners (regen) önceki VF çokgeni: dönmüş şerit seed üstünden süpürülünce bölge taraf değiştirmesin.
 *  @param storedSideRelations panel ilk temas ettiği tarafa bağlı kalır (öncelik: ilişki > süreklilik > seed).
 *  @param fitFaceShape true → çapadan dolan serbest bölgenin TAM şekli. */
export function computeFreeRegionLocal(
  contourCorners: THREE.Vector3[], normalLocal: THREE.Vector3, seedLocal: THREE.Vector3,
  siblingPanels: any[], parentWorldToLocal: THREE.Matrix4, parentShapeId?: string,
  prevRegionCorners?: THREE.Vector3[], storedSideRelations?: Record<string, number>, fitFaceShape?: boolean
): FreeRegionResult | null {
  if (contourCorners.length < 3) return null;
  const nrm = normalLocal.clone().normalize();
  const { u, v } = getFacePlaneAxes(nrm);
  const ring2D = contourCorners.map(c => toUV(c, u, v));
  const planeN = contourCorners[0].dot(nrm);

  const footprints: Point2D[][] = [];
  const fpRotated: boolean[] = [];
  const fpIds: (string | null)[] = [];
  // Kalınlık şeridi: yüzü dik kesen düz kardeşin izi; basma düzlemi şeridin UZUN kenarıdır, kısa kenar panelin ucu.
  const fpStrip: boolean[] = [];
  const touchingSiblingIds: string[] = [];
  for (const panel of siblingPanels) {
    if (parentShapeId && panel?.parameters?.parentShapeId && panel.parameters.parentShapeId !== parentShapeId) continue;
    const pieces = panelFootprintsInParentLocal(panel, parentWorldToLocal, nrm, planeN, u, v);
    if (!pieces || pieces.length === 0) continue;
    const rotated = panelHasRotation(panel);
    // Geometrinin en ince ekseni: yoksa extrude'la kalınlaşmış rafın izi şerit sayılmaz, basma-düzlemi kesimi düşer.
    const th = effectiveSlabThickness(panel);
    pieces.forEach((fp, k) => {
      footprints.push(fp);
      const b = bbox2(fp);
      const mn = Math.min(b.x1 - b.x0, b.y1 - b.y0), mx = Math.max(b.x1 - b.x0, b.y1 - b.y0);
      fpStrip.push(mn <= th * 1.5 + 0.5 && mx >= 2 * mn);
      // Dönmüş kardeş: uzak-teğet kırpması; gerçek eğik kesimi PanelEngine'deki dönüş-kesimi yapar.
      fpRotated.push(rotated);
      const pid = panel?.id ?? null;
      fpIds.push(pid ? (k === 0 ? pid : `${pid}#${k}`) : null);
    });
    if (panel.id) touchingSiblingIds.push(panel.id);
  }

  return solveFreeRegionMemo({
    ring2D, nrm, u, v, planeN, footprints, fpRotated, fpIds, fpStrip, touchingSiblingIds,
    seedU: seedLocal.dot(u), seedV: seedLocal.dot(v),
    prev2D: prevRegionCorners && prevRegionCorners.length >= 3 ? prevRegionCorners.map(c => toUV(c, u, v)) : undefined,
    storedSideRelations, fitFaceShape: !!fitFaceShape,
  });
}

interface FreeRegionInput {
  ring2D: Point2D[]; nrm: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3; planeN: number;
  footprints: Point2D[][]; fpRotated: boolean[]; fpIds: (string | null)[]; fpStrip: boolean[];
  touchingSiblingIds: string[]; seedU: number; seedV: number; prev2D?: Point2D[];
  storedSideRelations?: Record<string, number>; fitFaceShape: boolean;
}

// Çözüm girdilerin saf fonksiyonudur; rebuild her panelden sonra tüm VF'leri yeniden hesapladığı için önbelleklenir.
const _regionMemo = new Map<string, FreeRegionResult>();
const REGION_MEMO_MAX = 400;
function regionKey(q: FreeRegionInput): string {
  const P = (pts: Point2D[]) => pts.map(p => `${p.x},${p.y}`).join(';');
  return [
    P(q.ring2D), `${q.nrm.x},${q.nrm.y},${q.nrm.z}`, q.planeN,
    q.footprints.map(P).join('|'), q.fpRotated.join(','), q.fpIds.join(','), q.fpStrip.join(','),
    q.touchingSiblingIds.join(','), q.seedU, q.seedV, q.prev2D ? P(q.prev2D) : '-',
    q.storedSideRelations ? JSON.stringify(q.storedSideRelations) : '-', q.fitFaceShape ? 1 : 0,
  ].join('#');
}
function solveFreeRegionMemo(q: FreeRegionInput): FreeRegionResult {
  const key = regionKey(q);
  let r = _regionMemo.get(key);
  if (!r) {
    r = solveFreeRegion(q);
    if (_regionMemo.size >= REGION_MEMO_MAX) _regionMemo.delete(_regionMemo.keys().next().value as string);
    _regionMemo.set(key, r);
  }
  // Çağıranlar sonucu VF'ye yazar — paylaşılan kapsayıcılar kopyalanır.
  return { ...r, polygon: [...r.polygon], footprints: [...r.footprints], footprintIds: [...r.footprintIds], touchingSiblingIds: [...r.touchingSiblingIds],
    sideRelations: { ...r.sideRelations }, reach: r.reach.slice(), anchor: { ...r.anchor }, ring2D: [...r.ring2D] };
}

/** UZAK-TEĞET KIRPMA: kenar, çapadan uzağa hull'un en uzak noktasının 1mm İÇİNE ötelenir — bölge şeridin içinde
 *  biter, dönüş-kesimi temizler (dışarıda kırpılırsa eğime paralel kıymık kalır). */
function farTangentEdge(fp: Point2D[], a: Point2D, b: Point2D, anchorPt: Point2D): [Point2D, Point2D] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1e-9;
  let nX = dy / len, nY = -dx / len;      // sağ normal
  if (nX * (anchorPt.x - a.x) + nY * (anchorPt.y - a.y) > 0) { nX = -nX; nY = -nY; }
  let w = 0;
  for (const q of fp) { const dpr = nX * (q.x - a.x) + nY * (q.y - a.y); if (dpr > w) w = dpr; }
  const off = w - 1.0;
  return [{ x: a.x + nX * off, y: a.y + nY * off }, { x: b.x + nX * off, y: b.y + nY * off }];
}

function solveFreeRegion(q: FreeRegionInput): FreeRegionResult {
  const { ring2D, u, v, planeN, footprints, fpRotated, fpIds, fpStrip, touchingSiblingIds, storedSideRelations, fitFaceShape } = q;

  const rb = bbox2(ring2D);
  const uMin = rb.x0, vMin = rb.y0;
  const uSpan = Math.max(rb.x1 - rb.x0, 1e-6), vSpan = Math.max(rb.y1 - rb.y0, 1e-6);
  const cell = Math.min(20, Math.max(2, Math.max(uSpan, vSpan) / 140));
  const nx = Math.min(240, Math.max(1, Math.ceil(uSpan / cell)));
  const ny = Math.min(240, Math.max(1, Math.ceil(vSpan / cell)));
  const cw = uSpan / nx, ch = vSpan / ny;
  const cellPt = (i: number, j: number): Point2D => ({ x: uMin + (i + 0.5) * cw, y: vMin + (j + 0.5) * ch });
  const cellOf = (x: number, y: number): [number, number] => [
    Math.max(0, Math.min(nx - 1, Math.floor((x - uMin) / cw))), Math.max(0, Math.min(ny - 1, Math.floor((y - vMin) / ch)))];

  const PX = new Float64Array(nx), PY = new Float64Array(ny);
  for (let i = 0; i < nx; i++) PX[i] = uMin + (i + 0.5) * cw;
  for (let j = 0; j < ny; j++) PY[j] = vMin + (j + 0.5) * ch;
  const pipRing = makePip(ring2D);
  const inRing = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (pipRing(PX[i], PY[j])) inRing[j * nx + i] = 1;
  const fpPips = footprints.map(makePip);
  const freeMask = (pips: Array<(x: number, y: number) => boolean>) => {
    const m = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (inRing[j * nx + i] && !pips.some(pip => pip(PX[i], PY[j]))) m[j * nx + i] = 1;
    }
    return m;
  };
  const free = freeMask(fpPips);
  const nearestFree = (ti: number, tj: number, pred?: (i: number, j: number) => boolean): [number, number, number] => {
    let bd = Infinity, bi = -1, bj = -1, count = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (!free[j * nx + i] || (pred && !pred(i, j))) continue;
      count++;
      const dd = (i - ti) * (i - ti) + (j - tj) * (j - tj);
      if (dd < bd) { bd = dd; bi = i; bj = j; }
    }
    return [bi, bj, count];
  };

  const cu = q.seedU, cv = q.seedV;
  let [ci, cj] = cellOf(cu, cv);
  let continuityChosen = false;
  let continuityConnected = false; // tek-bileşenli süreklilik (doğrulama gevşetilir)
  let relationChosen = false;      // kayıtlı bağ ilişkisi uygulandı (doğrulama gevşetilir)

  // ÖNCELİK 1 — yarı-düzlem kısıtları: kayıtlı taraf işaretleri, yoksa seed'den türetilen; engel regen'ler arası
  // sıçrasa da panel kısıt tarafında kalır. Kısıt yoksa sonraki katmanlara düşülür.
  {
    const seedPt = cellPt(ci, cj);
    const constraints: Array<{ fr: { c: Point2D; p: Point2D }; sign: number }> = [];
    for (let f = 0; f < footprints.length; f++) {
      const id = fpIds[f];
      if (!id) continue;
      const fr = canonicalStripFrame(footprints[f]);
      let sgn: number | undefined;
      const stored = storedSideRelations?.[id];
      if (stored === 1 || stored === -1) sgn = stored;
      if (sgn === undefined) { const s = stripSide(seedPt, fr); if (Math.abs(s) > 1e-6) sgn = s > 0 ? 1 : -1; }
      if (sgn !== undefined) constraints.push({ fr, sign: sgn });
    }
    if (constraints.length > 0) {
      const satisfies = (i: number, j: number) => { const pt = cellPt(i, j); return constraints.every(k => stripSide(pt, k.fr) * k.sign >= 0); };
      const [bi, bj] = nearestFree(ci, cj, satisfies);
      if (bi >= 0) {
        ci = bi; cj = bj;
        relationChosen = true;
      } else {
        // Taraf sözleşmesi MUTLAK: kısıtı sağlayan serbest hücrelerin merkezine en yakın hücreye gidilir.
        let sumI = 0, sumJ = 0, cnt = 0;
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (free[j * nx + i] && satisfies(i, j)) { sumI += i; sumJ += j; cnt++; }
        const [fbi, fbj] = cnt > 0 ? nearestFree(sumI / cnt, sumJ / cnt, satisfies) : [-1, -1, 0];
        if (fbi >= 0) {
          ci = fbi; cj = fbj;
          relationChosen = true;
        }
      }
    }
  }

  // ÖNCELİK 2 — bölge sürekliliği (önceki VF ile en çok örtüşen bileşen).
  if (!relationChosen && q.prev2D) {
    const prev2D: Point2D[] = q.prev2D;
    const label = new Int32Array(nx * ny).fill(-1);
    let nComp = 0;
    for (let s = 0; s < nx * ny; s++) if (free[s] && label[s] === -1) flood4(free, nx, ny, s, label, nComp++);
    if (nComp > 1) {
      const overlap = new Array<number>(nComp).fill(0);
      const bestCell = new Array<number>(nComp).fill(-1);
      const bestD = new Array<number>(nComp).fill(Infinity);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (!free[k]) continue;
        const L = label[k];
        if (isPointInsidePolygon(cellPt(i, j), prev2D)) overlap[L]++;
        const dd = (i - ci) * (i - ci) + (j - cj) * (j - cj);
        if (dd < bestD[L]) { bestD[L] = dd; bestCell[L] = k; }
      }
      let bl = -1, bo = 0;
      for (let L = 0; L < nComp; L++) if (overlap[L] > bo) { bo = overlap[L]; bl = L; }
      if (bl >= 0 && bestCell[bl] >= 0) {
        ci = bestCell[bl] % nx; cj = (bestCell[bl] / nx) | 0;
        continuityChosen = true;
      }
    } else if (nComp === 1 && footprints.length > 0) {
      // Tek bileşen (şerit kenara ulaşmıyor): kırpma tarafını çapa belirler → çapa önceki bölgenin merkezine taşınır.
      let pcx = 0, pcy = 0;
      for (const p of prev2D) { pcx += p.x; pcy += p.y; }
      const [pi, pj] = cellOf(pcx / prev2D.length, pcy / prev2D.length);
      const [bi, bj] = nearestFree(pi, pj, (i, j) => isPointInsidePolygon(cellPt(i, j), prev2D));
      if (bi >= 0) {
        ci = bi; cj = bj;
        continuityChosen = true;
        continuityConnected = true;
      }
    }
  }
  if (!relationChosen && !continuityChosen && !free[cj * nx + ci]) {
    const [bi, bj] = nearestFree(ci, cj);
    if (bi >= 0) { ci = bi; cj = bj; }
  }
  const reach = new Uint8Array(nx * ny);
  if (free[cj * nx + ci]) flood4(free, nx, ny, cj * nx + ci, reach);

  // ENGEL = yalnız çapanın eriştiği bölgeye (reach, 1 hücre genişletilmiş) BİTİŞİK iz; yarım-düzlem kırpması sonsuz
  // olduğundan uzak bir iz (dikmenin öbür tarafındaki raf) bu bölmeyi de keserdi.
  const nearReach = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!reach[j * nx + i]) continue;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const a = i + di, b = j + dj;
      if (a >= 0 && b >= 0 && a < nx && b < ny) nearReach[b * nx + a] = 1;
    }
  }
  const blocking: Point2D[][] = [], blockingRotated: boolean[] = [], blockingStrip: boolean[] = [];
  for (let f = 0; f < footprints.length; f++) {
    const pip = fpPips[f];
    let blocks = false;
    for (let j = 0; j < ny && !blocks; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (inRing[k] && nearReach[k] && pip(PX[i], PY[j])) { blocks = true; break; }
    }
    if (blocks) { blocking.push(footprints[f]); blockingRotated.push(fpRotated[f]); blockingStrip.push(fpStrip[f]); }
  }

  const anchorPt = cellPt(ci, cj);
  const rotPips = blocking.map((fp, f) => (blockingRotated[f] ? makePip(fp) : null)).filter(Boolean) as Array<(x: number, y: number) => boolean>;
  const inRot = new Uint8Array(nx * ny);
  if (rotPips.length) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    for (const pip of rotPips) if (pip(PX[i], PY[j])) { inRot[j * nx + i] = 1; break; }
  }
  const gridCount = (poly: Point2D[]) => {
    const pip = makePip(poly);
    let total = 0, inside = 0, stray = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const isIn = pip(PX[i], PY[j]);
      if (reach[k]) { total++; if (isIn) inside++; }
      else if (isIn && inRing[k] && !inRot[k]) stray++;
    }
    return { total, inside, stray };
  };
  const scoreOf = (poly: Point2D[]): number => { if (poly.length < 3) return -Infinity; const c = gridCount(poly); return c.inside - 3 * c.stray; };
  const scorePoly = (poly: Point2D[]): { cover: number; leak: number } => {
    const { total, inside, stray } = gridCount(poly);
    return { cover: total > 0 ? inside / total : 0, leak: total > 0 ? stray / total : 1 };
  };
  /** Konveks ayak izini, çapaya göre DIŞARIDA kalınan kenarların en iyi (grid) skorlu yarım-düzlemiyle keser. */
  const clipByFootprint = (poly: Point2D[], fp: Point2D[], rotated: boolean, allowEdge?: (k: number) => boolean): Point2D[] | null => {
    let best: Point2D[] | null = null, bestScore = -Infinity;
    for (let k = 0; k < fp.length; k++) {
      let a = fp[k], b = fp[(k + 1) % fp.length];
      if (cross2(a, b, anchorPt) >= -1e-9) continue;          // çapa bu kenara göre dışarıda değil
      if (allowEdge && !allowEdge(k)) continue;
      if (rotated) [a, b] = farTangentEdge(fp, a, b, anchorPt);
      const cand = clipByHalfPlane(poly, a, b);
      const sc = scoreOf(cand);
      if (sc > bestScore) { bestScore = sc; best = cand; }
    }
    return best && best.length >= 3 ? best : null;
  };

  // BASMA DÜZLEMİ: basan panel basılanı büyük yüzünün düzlemiyle (şeridin uzun kenarı) keser, ucuyla değil;
  // uç kenarla kesim (basanın üstünden devam) yalnız "yüzeyin şeklini al" açıkken istenir.
  let pressedCutApplied = false;
  let exact: Point2D[] = ring2D;
  for (let f = 0; f < blocking.length; f++) {
    const fp = blocking[f];
    let pressEdges: Set<number> | null = null;
    if (!fitFaceShape && !blockingRotated[f] && blockingStrip[f]) {
      const fr = canonicalStripFrame(fp);           // fr.p ⟂ en uzun kenar
      const cand = new Set<number>();
      for (let k = 0; k < fp.length; k++) {
        const a = fp[k], b = fp[(k + 1) % fp.length];
        const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
        if (L < 1e-6 || cross2(a, b, anchorPt) >= -1e-9) continue;
        if (Math.abs((dx / L) * fr.p.x + (dy / L) * fr.p.y) < 0.2) cand.add(k); // uzun eksene paralel
      }
      if (cand.size > 0) pressEdges = cand;
    }
    const best = clipByFootprint(exact, fp, blockingRotated[f], pressEdges ? (k => pressEdges!.has(k)) : undefined);
    if (best) {
      exact = best;
      if (pressEdges) pressedCutApplied = true;
    }
  }

  let polygon = ring2D;
  // İçbükey kurtarma: yarım-düzlem sonucu reach'in belirgin kısmını kaybettiyse (L/U kolu) kesin dikdörtgensel bölge.
  // Basma düzlemi + konveks yüzde atlanır: basanın altı bilerek kaybedilmiştir, kurtarma paneli onun etrafına sarar.
  const skipConcaveRecovery = pressedCutApplied && isConvexPolygon2D(ring2D);
  if (exact.length >= 3 && blocking.length > 0 && !blockingRotated.some(Boolean) && !skipConcaveRecovery) {
    const hp = scorePoly(exact);
    if (hp.cover < 0.95) {
      const rl = rectilinearFreeRegion(ring2D, blocking, anchorPt);
      if (rl) {
        const rs = scorePoly(rl);
        if (rs.cover >= 0.9 && rs.leak <= 0.1 && rs.cover > hp.cover) exact = rl;
      }
    }
  }

  if (exact.length >= 3 && blocking.length > 0) {
    let total = 0;
    for (let k = 0; k < nx * ny; k++) if (reach[k]) total++;
    const { cover, leak } = scorePoly(exact);
    // Tek-bileşen süreklilik / ilişki / basma kesimi reach'in bir kısmını bilerek bırakır → kapsama eşiği gevşer.
    const coverMin = (continuityConnected || relationChosen || pressedCutApplied) ? 0.25 : 0.9;
    if (total > 0 && cover >= coverMin && leak <= 0.1) polygon = exact;
    else {
      // GÜVENLİ YEDEK (tam kontur yan panellerin içine girer): çapayı içeren, engellere girmeyen en geniş dikdörtgen.
      let rx0 = rb.x0, rx1 = rb.x1, ry0 = rb.y0, ry1 = rb.y1;
      const EPS = 1e-6;
      for (let f = 0; f < blocking.length; f++) {
        if (blockingRotated[f]) continue;            // dönmüş şerit: açılı, dikdörtgen kırpmaya uygun değil
        const fb = bbox2(blocking[f]);
        if (anchorPt.y > fb.y0 - EPS && anchorPt.y < fb.y1 + EPS) {
          if (fb.x1 <= anchorPt.x + EPS && fb.x1 > rx0) rx0 = fb.x1;
          if (fb.x0 >= anchorPt.x - EPS && fb.x0 < rx1) rx1 = fb.x0;
        }
        if (anchorPt.x > fb.x0 - EPS && anchorPt.x < fb.x1 + EPS) {
          if (fb.y1 <= anchorPt.y + EPS && fb.y1 > ry0) ry0 = fb.y1;
          if (fb.y0 >= anchorPt.y - EPS && fb.y0 < ry1) ry1 = fb.y0;
        }
      }
      // Dikdörtgen de çıkmazsa tam kontur kalır.
      if (rx1 - rx0 > 0.5 && ry1 - ry0 > 0.5) {
        const rect: Point2D[] = [{ x: rx0, y: ry0 }, { x: rx1, y: ry0 }, { x: rx1, y: ry1 }, { x: rx0, y: ry1 }];
        const rs = scorePoly(rect);
        // Taşmayan kırpılmış poligon, kapsaması düşük değilse dar dikdörtgene tercih edilir (alakasız paneller kısalmasın).
        const exactSafe = leak <= 0.1 && exact.length >= 3;
        polygon = exactSafe && (!(rs.leak <= 0.1) || cover >= rs.cover) ? exact : rect;
      }
    }
  }

  // YÜZEYİN ŞEKLİNİ AL: çapadan dolan serbest bölgenin tamamı. Düz engeller eksen-hizalıysa kesin çözüm (cep budama
  // kapalı), değilse grid izlenip kaynak kenarlara oturtulur; dönmüşlerde uzak-teğet aynen. Doğrulanmazsa mod-kapalı sonuç kalır.
  if (fitFaceShape) {
    const straight: Point2D[][] = [], rotatedFps: Point2D[][] = [];
    for (let f = 0; f < blocking.length; f++) (blockingRotated[f] ? rotatedFps : straight).push(blocking[f]);
    let shapePoly: Point2D[] | null = straight.length === 0 ? ring2D.map(p => ({ ...p })) : rectilinearFreeRegion(ring2D, straight, anchorPt, 0);
    if (!shapePoly) {
      // Genel yol (eğik kontur / eksen-hizasız engel); dönmüş şeritler burada engel sayılmaz.
      const free2 = freeMask(straight.map(makePip));
      const reach2 = new Uint8Array(nx * ny);
      if (free2[cj * nx + ci]) flood4(free2, nx, ny, cj * nx + ci, reach2);
      const traced = traceReachBoundary(reach2, nx, ny, uMin, vMin, cw, ch);
      if (traced.length >= 3) shapePoly = fitTracedPolygonToSources(traced, [ring2D, ...straight], Math.max(cw, ch) * 1.6);
    }
    if (shapePoly && shapePoly.length >= 3) {
      for (const fp of rotatedFps) { const best = clipByFootprint(shapePoly, fp, true); if (best) shapePoly = best; }
      const ss = scorePoly(shapePoly);
      if (ss.leak <= 0.1 && ss.cover >= 0.9) polygon = shapePoly;
    }
  }

  const finalAnchor = cellPt(ci, cj);
  const sideRelations: Record<string, number> = {};
  for (let f = 0; f < footprints.length; f++) {
    const id = fpIds[f];
    if (!id) continue;
    const s = stripSide(finalAnchor, canonicalStripFrame(footprints[f]));
    if (Math.abs(s) > 1e-6) sideRelations[id] = s > 0 ? 1 : -1;
  }

  return {
    u, v, planeN, ring2D, footprints, footprintIds: fpIds, touchingSiblingIds, uMin, vMin, cw, ch, nx, ny, reach, anchor: finalAnchor, polygon, sideRelations,
  };
}

// ══════════════════════════════════════════════ 3. PANEL İŞLEM ADIMLARI ══════════════════════════════════════════════
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

/** OK MODU (Goker, Eki 2026 — "yüz seçmek istemiyorum; move'daki gibi oklar olsun, panelin en dış sınırını yazılan ölçü kadar büyütsün"):
 *  `axis` yönündeki EN DIŞ yüz `delta` kadar büyür (− küçülür). Aynı yönün ok adımı zaten varsa değeri toplanır (her tık = +delta);
 *  adım `outer` işaretlidir → rebuild'de hep o yöndeki en dış yüze uygulanır. */
export async function executeFaceExtrudeOuter({ panelShape, axis, delta: value, mode = 'dyn', updateShape }: {
  panelShape: Shape; axis: AxisDir; delta: number; /** fixed: panelin o eksendeki TOPLAM ölçüsü `delta` olur (ok ucundaki Dyn/Fixed) */ mode?: 'dyn' | 'fixed'; updateShape: UpdateShape;
}): Promise<boolean> {
  const panel = freshShape(panelShape);
  if (!panel.geometry) return false;
  const dir = axisDirToVec(axis);
  const bbSize = localBboxOf(panel.geometry)?.getSize(new THREE.Vector3());
  const span = bbSize ? Math.abs(bbSize.dot(new THREE.Vector3(Math.abs(dir.x), Math.abs(dir.y), Math.abs(dir.z)))) : 0;
  const delta = mode === 'fixed' ? round1(value - span) : value;
  if (Math.abs(delta) < 0.01) return false;
  const { groups } = getFacesAndGroups(panel.geometry);
  let best = -1, bestD = -Infinity;
  groups.forEach((g, i) => {
    if (g.normal.clone().normalize().dot(dir) < 0.7) return;
    const d = g.center.dot(dir);
    if (d > bestD + 1e-6 || (Math.abs(d - bestD) <= 1e-6 && best >= 0 && g.totalArea > groups[best].totalArea)) { bestD = d; best = i; }
  });
  if (best < 0) return false;
  const face = resolveClickedFace(panel, best);
  if (!face) return false;
  const label = dominantAxisLabel(face.faceNormal);
  const steps = extrudeStepsOf(panel);
  const idx = steps.findIndex(s => s.outer && s.axisLabel === label);
  const next = idx >= 0
    ? steps.map((s, i) => (i === idx ? { ...s, value: round1(s.value + delta), isFixed: false, resolvedValue: undefined } : s))
    : [...steps, { id: genId('ext'), faceNormal: vec3(face.faceNormal), faceCenter: vec3(face.faceCenter), axisLabel: label, value: round1(delta),
        isFixed: false, timestamp: Date.now(), outer: true } as ExtrudeStep];
  // Toplam 0'a dönen ok adımı silinir (listede boş adım kalmasın).
  const cleaned = next.filter(s => !(s.outer && Math.abs(s.value) < 0.01));
  return commitAndRebuild(panel, { extrudeSteps: cleaned }, updateShape);
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
