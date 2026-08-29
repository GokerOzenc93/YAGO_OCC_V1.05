import * as THREE from 'three';
import type { VirtualFace } from '../store';
import type { FaceData } from './FaceEditor';

// ═══════════════════════════════════════════════════════════════════════════
// FaceRegion — PANEL ATMA ZİNCİRİNİN SAF GEOMETRİ ÇEKİRDEĞİ.
// FaceRaycastOverlay'den ayrıştırıldı: burada React/UI YOK, yalnız düzlem
// tabanları, 2B poligon işlemleri, ayak izleri, yüz konturu ve serbest bölge
// hesabı var. Hem YAKALAMA (tıklama önizlemesi) hem REGEN (VF güncelleme)
// AYNI fonksiyonları kullanır — iki yol yapısal olarak ayrışamaz (tek kaynak).
//
// Taşınan damıtılmış kurallar:
//  • SALT-KESİT KENAR-TEMASI KAPISI (panelFootprintInParentLocal): yüzü yalnız
//    delen dönmüş kardeşin ince kesiti engel sayılmaz.
//  • ÖNCELİK ZİNCİRİ (computeFreeRegionLocal): kayıtlı bağ-ilişkisi >
//    örtüşme sürekliliği > seed. Taraf, sözleşmeyle deterministiktir.
//  • UZAK-TEĞET KIRPMA: dönmüş kardeş şeridinde bölge şeridin içinden geçer;
//    gerçek gönyeyi rebuild'deki boolean tanımlar.
//  • Kesin-poligon + grid doğrulaması: köşegen kenarlar tırtıksız, sonuç
//    kullanıcının gördüğü bölgeyle uyuşmak zorunda.
// ═══════════════════════════════════════════════════════════════════════════

export function getFacePlaneAxes(normal: THREE.Vector3): { u: THREE.Vector3; v: THREE.Vector3 } {
  const n = normal.clone().normalize();
  const absX = Math.abs(n.x), absY = Math.abs(n.y), absZ = Math.abs(n.z);
  const up = absY > absX && absY > absZ ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(n, up).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  return { u, v };
}

export function getShapeMatrix(shape: any): THREE.Matrix4 {
  const pos = new THREE.Vector3(shape.position[0], shape.position[1], shape.position[2]);
  const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(shape.rotation[0], shape.rotation[1], shape.rotation[2], 'XYZ'));
  const scale = new THREE.Vector3(shape.scale[0], shape.scale[1], shape.scale[2]);
  return new THREE.Matrix4().compose(pos, quat, scale);
}

export function projectTo2D(p: THREE.Vector3, origin: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3): { x: number; y: number } {
  const d = new THREE.Vector3().subVectors(p, origin);
  return { x: d.dot(u), y: d.dot(v) };
}

export function raySegmentIntersect2D(ox: number, oy: number, dx: number, dy: number, ax: number, ay: number, bx: number, by: number): number | null {
  const ex = bx - ax, ey = by - ay;
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((ax - ox) * ey - (ay - oy) * ex) / denom;
  const s = ((ax - ox) * dy - (ay - oy) * dx) / denom;
  if (t > 1e-4 && s >= -1e-4 && s <= 1.0 + 1e-4) return t;
  return null;
}

// ── SERİ IŞIN: görünürlük çokgeni ────────────────────────────────────────────
// Tıklanan noktadan, düzlemdeki TÜM sınır+engel kenarlarına doğru ışın demeti
// atılır: her kenar ucuna (±epsilon açıyla) hedefli ışınlar + düzgün dağılımlı
// yelpaze. Sonuç, tıklanan noktadan "görünen" serbest bölgenin TAM çokgenidir:
// eğik (döndürülmüş) bir panel yüzeyi kestiğinde bölge o eğik çizgiyi birebir
// izler — dik durumlarda ise sonuç mevcut davranışla aynı dikdörtgendir.
// NOT: Bu, yüzeyi "ana yüze eşitle" gibi birebir kopyalamaz; yalnızca tıklanan
// noktanın etrafındaki erişilebilir alanın şeklini üretir.
export interface ObstacleEdge { v1: THREE.Vector3; v2: THREE.Vector3; ownerId?: string; }

/**
 * Bu yüz düzleminde "ana yüzeye eşitlenmiş" (alignToParentFace) kardeş VF'lerin
 * kimlikleri. Eşitlenmiş panel TANIM GEREĞİ parent yüzünün TAMAMINI doldurur
 * (PanelReshapeService: "HER ZAMAN tüm parent yüzünü doldur") ve yüz düzleminde
 * FLUSH durur. Dolayısıyla aynı yüze atılan başka bir paneli in-plane olarak
 * SINIRLAYAMAZ — onun ÜZERİNE istiflenir (lamine olur).
 *
 * Buna rağmen ışın atma onu bir engel sayıyordu: gövde konturu (yüz poligonu,
 * çentikli/açılı olabilir) ışınları durdurup görünürlük çokgenini o şekle
 * sokuyordu. Sonuç: ilk panel 4 kenarlı çıkarken, ondan SONRAKİ her panel
 * sorgusuz yüzün şeklini alıyordu. Bu VF'leri engel kümesinden çıkarıyoruz;
 * böylece her panel varsayılan olarak normal DİKDÖRTGEN yerleşir ve yüz şekli
 * yalnızca kullanıcı "ana yüzeye eşitle"ye bastığında verilir.
 *
 * DİKKAT: yalnızca AYNI DÜZLEMDEKİ eşitlenmiş VF'ler elenir. Başka bir yüze
 * (ör. sol yüze) eşitlenmiş panel, bu yüzü dik olarak kesiyorsa GERÇEK bir
 * engeldir ve korunur.
 */
/**
 * BÖLGEYİ DİKDÖRTGENE İNDİRGE — tıklamayı (köken) içeren EN BÜYÜK ALANLI eksen
 * hizalı dikdörtgen.
 *
 * SÖZLEŞME ("ana yüzeye eşitle" anahtarı): bayrak KAPALIYKEN panel her koşulda
 * 4 kenarlıdır; yüzün şekli (L/U, çentik) yalnızca bayrak AÇIKKEN verilir.
 * Bu fonksiyon bayraksız yoldaki dörtgeni üretir.
 *
 * Aday v sınırları kısıt segmenti uçlarından türetilir; her (vMin, vMax) çifti
 * için u yönleri bağımsız ikili aramayla büyütülür (v aralığı sabitken u'da
 * büyümek monotondur) ve alanı en büyük geçerli aday seçilir — deterministik,
 * sıradan bağımsız. Kısıt testi SEGMENT KESİŞİMİ ile yapılır (görünürlük
 * çokgeninin köşe yongalarına bağışık). Kısıtlar dikdörtgense sonuç tohumla
 * birebir aynıdır (hızlı yol) — düz yüzlerde davranış değişmez.
 */
export function getSubtractionWorldMatrix(parentLocalToWorld: THREE.Matrix4, subtraction: any): THREE.Matrix4 {
  const box = new THREE.Box3().setFromBufferAttribute(subtraction.geometry.attributes.position as THREE.BufferAttribute);
  const size = new THREE.Vector3(), center = new THREE.Vector3();
  box.getSize(size); box.getCenter(center);
  const isCentered = Math.abs(center.x) < 0.01 && Math.abs(center.y) < 0.01 && Math.abs(center.z) < 0.01;
  const meshOffset = isCentered ? new THREE.Vector3(size.x / 2, size.y / 2, size.z / 2) : new THREE.Vector3();
  const groupMatrix = new THREE.Matrix4().compose(
    new THREE.Vector3(...subtraction.relativeOffset),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(subtraction.relativeRotation?.[0] || 0, subtraction.relativeRotation?.[1] || 0, subtraction.relativeRotation?.[2] || 0, 'XYZ')),
    new THREE.Vector3(subtraction.scale?.[0] || 1, subtraction.scale?.[1] || 1, subtraction.scale?.[2] || 1)
  );
  const meshMatrix = new THREE.Matrix4().makeTranslation(meshOffset.x, meshOffset.y, meshOffset.z);
  return new THREE.Matrix4().multiplyMatrices(parentLocalToWorld, groupMatrix).multiply(meshMatrix);
}

export type Point2D = { x: number; y: number };

export function getSubtractorFootprints2D(subtractions: any[], parentLocalToWorld: THREE.Matrix4, facePlaneNormal: THREE.Vector3, facePlaneOrigin: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3, planeTolerance: number = 50): Point2D[][] {
  const footprints: Point2D[][] = [];
  for (const sub of subtractions) {
    if (!sub || !sub.geometry) continue;
    const subWorldMatrix = getSubtractionWorldMatrix(parentLocalToWorld, sub);
    const posAttr = sub.geometry.getAttribute('position');
    const onPlaneVerts: THREE.Vector3[] = [];
    for (let i = 0; i < posAttr.count; i++) {
      const wp = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(subWorldMatrix);
      if (Math.abs(facePlaneNormal.dot(new THREE.Vector3().subVectors(wp, facePlaneOrigin))) < planeTolerance) onPlaneVerts.push(wp);
    }
    if (onPlaneVerts.length < 3) continue;
    const hull = convexHull2D(onPlaneVerts.map(wp => projectTo2D(wp, facePlaneOrigin, u, v)));
    if (hull.length >= 3) footprints.push(hull);
  }
  return footprints;
}

export function convexHull2D(points: Point2D[]): Point2D[] {
  if (points.length < 3) return [...points];
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Point2D, a: Point2D, b: Point2D) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point2D[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point2D[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

export function pickDominantEdgeDirection(
  boundaryEdges: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }>,
  normal: THREE.Vector3
): THREE.Vector3 | null {
  const bins = new Map<string, { dir: THREE.Vector3; length: number }>();
  for (const e of boundaryEdges) {
    const d = new THREE.Vector3().subVectors(e.v2, e.v1);
    const len = d.length();
    if (len < 1e-3) continue;
    d.divideScalar(len);
    d.addScaledVector(normal, -d.dot(normal)).normalize();
    let dir = d.clone();
    if (dir.x < 0 || (Math.abs(dir.x) < 1e-6 && dir.y < 0) ||
        (Math.abs(dir.x) < 1e-6 && Math.abs(dir.y) < 1e-6 && dir.z < 0)) {
      dir.negate();
    }
    const key = `${dir.x.toFixed(3)},${dir.y.toFixed(3)},${dir.z.toFixed(3)}`;
    const existing = bins.get(key);
    if (existing) existing.length += len;
    else bins.set(key, { dir, length: len });
  }
  let best: { dir: THREE.Vector3; length: number } | null = null;
  bins.forEach(b => { if (!best || b.length > best.length) best = b; });
  return best ? best.dir.clone() : null;
}

export function buildBoundaryLoop2D(
  boundaryEdges: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }>,
  origin: THREE.Vector3,
  u: THREE.Vector3,
  v: THREE.Vector3
): Point2D[] | null {
  if (boundaryEdges.length < 3) return null;
  const keyOf = (p: Point2D) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
  type Edge2D = { a: Point2D; b: Point2D; ak: string; bk: string };
  const edges: Edge2D[] = boundaryEdges.map(e => {
    const a = projectTo2D(e.v1, origin, u, v);
    const b = projectTo2D(e.v2, origin, u, v);
    return { a, b, ak: keyOf(a), bk: keyOf(b) };
  });
  const adj = new Map<string, { other: string; point: Point2D }[]>();
  for (const e of edges) {
    if (e.ak === e.bk) continue;
    if (!adj.has(e.ak)) adj.set(e.ak, []);
    if (!adj.has(e.bk)) adj.set(e.bk, []);
    adj.get(e.ak)!.push({ other: e.bk, point: e.b });
    adj.get(e.bk)!.push({ other: e.ak, point: e.a });
  }
  if (edges.length === 0) return null;
  const startKey = edges[0].ak;
  const startPt = edges[0].a;
  const loop: Point2D[] = [startPt];
  const visited = new Set<string>();
  let cur = startKey, prev = '';
  while (true) {
    visited.add(cur);
    const neigh = adj.get(cur) || [];
    const next = neigh.find(n => n.other !== prev && !visited.has(n.other));
    if (!next) break;
    loop.push(next.point);
    prev = cur; cur = next.other;
    if (cur === startKey) break;
    if (loop.length > edges.length + 2) break;
  }
  return loop.length >= 3 ? loop : null;
}

/**
 * Mesh geometrisinin düzlem-üstü üçgenlerinden gerçek sınır çokgenini çıkarır.
 * İçbükey (concave) şekiller (ör. U-shape) doğru korunur. Zincir başarısız
 * olursa convexHull'a düşer.
 */
export function meshOnPlaneBoundary2D(
  geometry: THREE.BufferGeometry,
  panelMatrix: THREE.Matrix4,
  facePlaneNormal: THREE.Vector3,
  facePlaneOrigin: THREE.Vector3,
  u: THREE.Vector3,
  v: THREE.Vector3,
  planeTolerance: number
): Point2D[] | null {
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!posAttr || posAttr.count < 3) return null;
  const idx = geometry.getIndex();
  const triCount = idx ? idx.count / 3 : posAttr.count / 3;
  if (triCount < 1) return null;

  const worldPts: THREE.Vector3[] = [];
  const onPlane: boolean[] = [];
  for (let i = 0; i < posAttr.count; i++) {
    const wp = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(panelMatrix);
    worldPts.push(wp);
    const dist = Math.abs(facePlaneNormal.dot(new THREE.Vector3().subVectors(wp, facePlaneOrigin)));
    onPlane.push(dist < planeTolerance);
  }

  const at = (k: number) => (idx ? idx.getX(k) : k);
  const edgeCount = new Map<string, number>();
  const edgeData = new Map<string, { v1: THREE.Vector3; v2: THREE.Vector3 }>();
  const edgeKey = (a: number, b: number) => a < b ? `${a}_${b}` : `${b}_${a}`;

  for (let t = 0; t < triCount; t++) {
    const i0 = at(t * 3), i1 = at(t * 3 + 1), i2 = at(t * 3 + 2);
    if (!onPlane[i0] || !onPlane[i1] || !onPlane[i2]) continue;
    const triEdges = [[i0, i1], [i1, i2], [i2, i0]];
    for (const [a, b] of triEdges) {
      const key = edgeKey(a, b);
      edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
      if (!edgeData.has(key)) edgeData.set(key, { v1: worldPts[a], v2: worldPts[b] });
    }
  }

  const boundaryEdges: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }> = [];
  for (const [key, count] of edgeCount) {
    if (count === 1) {
      const e = edgeData.get(key)!;
      boundaryEdges.push(e);
    }
  }

  if (boundaryEdges.length < 3) return null;
  const origin = facePlaneOrigin;
  const loop = buildBoundaryLoop2D(boundaryEdges, origin, u, v);
  if (loop && loop.length >= 3) return loop;

  const pts2D: Point2D[] = [];
  for (let i = 0; i < worldPts.length; i++) {
    if (onPlane[i]) pts2D.push(projectTo2D(worldPts[i], facePlaneOrigin, u, v));
  }
  return pts2D.length >= 3 ? convexHull2D(pts2D) : null;
}

export function sutherlandHodgmanClip(subject: Point2D[], clip: Point2D[]): Point2D[] {
  let output = [...subject];
  for (let i = 0; i < clip.length && output.length > 0; i++) {
    const input = [...output]; output = [];
    const edgeStart = clip[i], edgeEnd = clip[(i + 1) % clip.length];
    for (let j = 0; j < input.length; j++) {
      const current = input[j], prev = input[(j + input.length - 1) % input.length];
      const currInside = isInsideEdge(current, edgeStart, edgeEnd);
      const prevInside = isInsideEdge(prev, edgeStart, edgeEnd);
      if (currInside) {
        if (!prevInside) { const inter = lineIntersect2D(prev, current, edgeStart, edgeEnd); if (inter) output.push(inter); }
        output.push(current);
      } else if (prevInside) {
        const inter = lineIntersect2D(prev, current, edgeStart, edgeEnd);
        if (inter) output.push(inter);
      }
    }
  }
  return output;
}

export function isInsideEdge(p: Point2D, edgeStart: Point2D, edgeEnd: Point2D): boolean {
  return (edgeEnd.x - edgeStart.x) * (p.y - edgeStart.y) - (edgeEnd.y - edgeStart.y) * (p.x - edgeStart.x) >= 0;
}

// Returns true only when all cross-products have the same sign (convex polygon).
// Sutherland-Hodgman clip requires a convex clip polygon; skip it for non-convex faces.
export function isConvexPolygon2D(poly: Point2D[]): boolean {
  if (poly.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], c = poly[(i + 2) % poly.length];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(cross) < 1e-9) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

export function lineIntersect2D(p1: Point2D, p2: Point2D, p3: Point2D, p4: Point2D): Point2D | null {
  const x1 = p1.x, y1 = p1.y, x2 = p2.x, y2 = p2.y;
  const x3 = p3.x, y3 = p3.y, x4 = p4.x, y4 = p4.y;
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
}

export function subtractPolygon(subject: Point2D[], hole: Point2D[]): Point2D[] {
  const invertedHole = [...hole].reverse();
  const clipped = sutherlandHodgmanClip(subject, invertedHole);
  if (clipped.length < 3) return subject;
  const subjectEdges: [Point2D, Point2D][] = subject.map((p, i) => [p, subject[(i + 1) % subject.length]]);
  const holeEdges: [Point2D, Point2D][] = hole.map((p, i) => [p, hole[(i + 1) % hole.length]]);
  const result: Point2D[] = [];
  const EPS = 0.5;
  for (let i = 0; i < subject.length; i++) {
    const pt = subject[i];
    if (!isPointInsidePolygon(pt, hole)) result.push(pt);
    const intersections = findEdgeIntersections(pt, subject[(i + 1) % subject.length], holeEdges);
    intersections.sort((a, b) => (a.x - pt.x) ** 2 + (a.y - pt.y) ** 2 - ((b.x - pt.x) ** 2 + (b.y - pt.y) ** 2));
    for (const inter of intersections) {
      result.push(inter);
      for (const hp of traceHoleEdge(inter, hole, subject)) result.push(hp);
    }
  }
  if (result.length < 3) return subject;
  const deduplicated: Point2D[] = [result[0]];
  for (let i = 1; i < result.length; i++) {
    const prev = deduplicated[deduplicated.length - 1];
    if (Math.abs(result[i].x - prev.x) > EPS || Math.abs(result[i].y - prev.y) > EPS) deduplicated.push(result[i]);
  }
  if (deduplicated.length >= 2) {
    const first = deduplicated[0], last = deduplicated[deduplicated.length - 1];
    if (Math.abs(first.x - last.x) < EPS && Math.abs(first.y - last.y) < EPS) deduplicated.pop();
  }
  return deduplicated.length >= 3 ? deduplicated : subject;
}

export function isPointInsidePolygon(p: Point2D, poly: Point2D[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > p.y) !== (yj > p.y) && p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function findEdgeIntersections(a: Point2D, b: Point2D, edges: [Point2D, Point2D][]): Point2D[] {
  const results: Point2D[] = [];
  for (const [e1, e2] of edges) { const inter = segmentIntersect2D(a, b, e1, e2); if (inter) results.push(inter); }
  return results;
}

export function segmentIntersect2D(p1: Point2D, p2: Point2D, p3: Point2D, p4: Point2D): Point2D | null {
  const dx1 = p2.x - p1.x, dy1 = p2.y - p1.y, dx2 = p4.x - p3.x, dy2 = p4.y - p3.y;
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((p3.x - p1.x) * dy2 - (p3.y - p1.y) * dx2) / denom;
  const s = ((p3.x - p1.x) * dy1 - (p3.y - p1.y) * dx1) / denom;
  if (t > 1e-6 && t < 1 - 1e-6 && s > 1e-6 && s < 1 - 1e-6) return { x: p1.x + t * dx1, y: p1.y + t * dy1 };
  return null;
}

export function traceHoleEdge(entryPoint: Point2D, hole: Point2D[], subject: Point2D[]): Point2D[] {
  const subjectEdges: [Point2D, Point2D][] = subject.map((p, i) => [p, subject[(i + 1) % subject.length]]);
  let closestEdgeIdx = 0, minDist = Infinity;
  for (let i = 0; i < hole.length; i++) {
    const mid = { x: (hole[i].x + hole[(i + 1) % hole.length].x) / 2, y: (hole[i].y + hole[(i + 1) % hole.length].y) / 2 };
    const d = (mid.x - entryPoint.x) ** 2 + (mid.y - entryPoint.y) ** 2;
    if (d < minDist) { minDist = d; closestEdgeIdx = i; }
  }
  const trace: Point2D[] = [];
  const startIdx = (closestEdgeIdx + 1) % hole.length;
  for (let step = 0; step < hole.length; step++) {
    const idx = (startIdx + step) % hole.length;
    const pt = hole[idx];
    if (!isPointInsidePolygon(pt, subject)) continue;
    trace.push(pt);
    const intersections = findEdgeIntersections(pt, hole[(idx + 1) % hole.length], subjectEdges);
    if (intersections.length > 0) { trace.push(intersections[0]); break; }
  }
  return trace;
}

export function earClipTriangulate(vertices: Point2D[]): number[] {
  if (vertices.length < 3) return [];
  if (vertices.length === 3) return [0, 1, 2];
  const indices: number[] = [];
  const remaining = vertices.map((_, i) => i);
  let safety = remaining.length * remaining.length;
  while (remaining.length > 3 && safety > 0) {
    safety--;
    let earFound = false;
    for (let i = 0; i < remaining.length; i++) {
      const prevIdx = (i + remaining.length - 1) % remaining.length;
      const nextIdx = (i + 1) % remaining.length;
      const a = vertices[remaining[prevIdx]], b = vertices[remaining[i]], c = vertices[remaining[nextIdx]];
      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (cross < 1e-10) continue;
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

export function pointInTriangle(p: Point2D, a: Point2D, b: Point2D, c: Point2D): boolean {
  const d1 = sign(p, a, b), d2 = sign(p, b, c), d3 = sign(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

export function sign(p1: Point2D, p2: Point2D, p3: Point2D): number {
  return (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
}

export function pointInTriangle3D(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): boolean {
  const v0 = c.clone().sub(a);
  const v1 = b.clone().sub(a);
  const v2 = p.clone().sub(a);
  const dot00 = v0.dot(v0), dot01 = v0.dot(v1), dot02 = v0.dot(v2);
  const dot11 = v1.dot(v1), dot12 = v1.dot(v2);
  const inv = 1 / (dot00 * dot11 - dot01 * dot01);
  const u = (dot11 * dot02 - dot01 * dot12) * inv;
  const v = (dot00 * dot12 - dot01 * dot02) * inv;
  return u >= -0.01 && v >= -0.01 && (u + v) <= 1.02;
}

export function ensureCCW(poly: Point2D[]): Point2D[] {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    area += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return area < 0 ? [...poly].reverse() : poly;
}

export interface RayHitResult {
  hitPoint: THREE.Vector3;
  hitEdge: ObstacleEdge | null;
  edgeT: number;
  isBoundaryEdge: boolean;
  /** Işını durduran komşunun kimliği ('panel:<id>' | 'vf:<id>' | 'sub:<i>'); sınıra çarptıysa null. */
  hitOwnerId: string | null;
}

export function castRayOnFaceWorldDetailed(originWorld: THREE.Vector3, dirWorld: THREE.Vector3, boundaryEdges: ObstacleEdge[], obstacleEdges: ObstacleEdge[], u: THREE.Vector3, v: THREE.Vector3, planeOrigin: THREE.Vector3, maxDist: number): RayHitResult {
  const o2d = projectTo2D(originWorld, planeOrigin, u, v);
  const dir2d = { x: dirWorld.dot(u), y: dirWorld.dot(v) };
  let tMin = maxDist, hitEdge: ObstacleEdge | null = null, hitEdgeT = 0, isBoundary = false;
  for (const edge of boundaryEdges) {
    const a2d = projectTo2D(edge.v1, planeOrigin, u, v), b2d = projectTo2D(edge.v2, planeOrigin, u, v);
    const t = raySegmentIntersect2D(o2d.x, o2d.y, dir2d.x, dir2d.y, a2d.x, a2d.y, b2d.x, b2d.y);
    if (t !== null && t < tMin) {
      tMin = t; hitEdge = edge; isBoundary = true;
      const hitX = o2d.x + dir2d.x * t, hitY = o2d.y + dir2d.y * t;
      const ex = b2d.x - a2d.x, ey = b2d.y - a2d.y, eLen = Math.sqrt(ex * ex + ey * ey);
      hitEdgeT = eLen > 1e-8 ? ((hitX - a2d.x) * ex + (hitY - a2d.y) * ey) / (eLen * eLen) : 0;
    }
  }
  for (const edge of obstacleEdges) {
    const a2d = projectTo2D(edge.v1, planeOrigin, u, v), b2d = projectTo2D(edge.v2, planeOrigin, u, v);
    const t = raySegmentIntersect2D(o2d.x, o2d.y, dir2d.x, dir2d.y, a2d.x, a2d.y, b2d.x, b2d.y);
    if (t !== null && t < tMin) {
      tMin = t; hitEdge = edge; isBoundary = false;
      const hitX = o2d.x + dir2d.x * t, hitY = o2d.y + dir2d.y * t;
      const ex = b2d.x - a2d.x, ey = b2d.y - a2d.y, eLen = Math.sqrt(ex * ex + ey * ey);
      hitEdgeT = eLen > 1e-8 ? ((hitX - a2d.x) * ex + (hitY - a2d.y) * ey) / (eLen * eLen) : 0;
    }
  }
  return {
    hitPoint: originWorld.clone().addScaledVector(dirWorld, tMin),
    hitEdge,
    edgeT: Math.max(0, Math.min(1, hitEdgeT)),
    isBoundaryEdge: isBoundary,
    hitOwnerId: isBoundary ? null : (hitEdge?.ownerId ?? null),
  };
}

export function castRayOnFaceWorld(originWorld: THREE.Vector3, dirWorld: THREE.Vector3, boundaryEdges: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }>, obstacleEdges: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }>, u: THREE.Vector3, v: THREE.Vector3, planeOrigin: THREE.Vector3, maxDist: number): THREE.Vector3 {
  return castRayOnFaceWorldDetailed(originWorld, dirWorld, boundaryEdges, obstacleEdges, u, v, planeOrigin, maxDist).hitPoint;
}


/**
 * Returns true if the given world-space point falls inside the panel's CURRENT geometry
 * footprint projected onto the face plane. Used to detect void areas left by shortened
 * panels, without relying on VF polygons (which stay as original full-face for rebuild).
 */
/** Panelin, verilen yüz DÜZLEMİNE değen 2D ayak izi (u/v hull). Panel düzleme
 *  değmiyorsa (on-plane köşe < 3) null döner — o yüzeyde engel değildir. */
export function panelFootprintOnPlane(
  panel: any,
  facePlaneNormal: THREE.Vector3,
  facePlaneOrigin: THREE.Vector3,
  u: THREE.Vector3,
  v: THREE.Vector3,
  planeTolerance: number = 5.0
): Point2D[] | null {
  if (!panel.geometry) return null;
  const panelMatrix = getShapeMatrix(panel);
  const posAttr = panel.geometry.getAttribute('position') as THREE.BufferAttribute;
  const pts2D: Point2D[] = [];
  let nMin = Infinity, nMax = -Infinity;
  const all2D: Point2D[] = [];
  for (let i = 0; i < posAttr.count; i++) {
    const wp = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(panelMatrix);
    const signed = facePlaneNormal.dot(new THREE.Vector3().subVectors(wp, facePlaneOrigin));
    nMin = Math.min(nMin, signed); nMax = Math.max(nMax, signed);
    const p2 = projectTo2D(wp, facePlaneOrigin, u, v);
    all2D.push(p2);
    if (Math.abs(signed) < planeTolerance) pts2D.push(p2);
  }
  if (pts2D.length < 3) {
    if (nMin <= planeTolerance && nMax >= -planeTolerance && all2D.length >= 3) {
      const hullAll = convexHull2D(all2D);
      return hullAll.length >= 3 ? hullAll : null;
    }
    return null;
  }
  const boundary = meshOnPlaneBoundary2D(panel.geometry, panelMatrix, facePlaneNormal, facePlaneOrigin, u, v, planeTolerance);
  if (boundary && boundary.length >= 3) return boundary;
  const hull = convexHull2D(pts2D);
  return hull.length >= 3 ? hull : null;
}

/** Tıklanan düzlem noktası, bu yüzeye değen HERHANGİ bir panelin ayak izi
 *  içinde mi? İçindeyse o paneli döndürür (taşınmış paneller dahil — VF
 *  konumundan bağımsız, panelin GÜNCEL geometrisiyle test edilir). */
export function findPanelCoveringPoint(
  worldPt: THREE.Vector3,
  childPanels: any[],
  facePlaneNormal: THREE.Vector3,
  facePlaneOrigin: THREE.Vector3
): any | null {
  const { u, v } = getFacePlaneAxes(facePlaneNormal);
  const p2 = projectTo2D(worldPt, facePlaneOrigin, u, v);
  for (const panel of childPanels) {
    const fp = panelFootprintOnPlane(panel, facePlaneNormal, facePlaneOrigin, u, v);
    if (fp && isPointInsidePolygon(p2, fp)) return panel;
  }
  return null;
}

export function isWorldPointInsidePanelFootprint(
  worldPt: THREE.Vector3,
  panel: any,
  facePlaneNormal: THREE.Vector3,
  facePlaneOrigin: THREE.Vector3,
  planeTolerance: number = 5.0
): boolean {
  if (!panel.geometry) return false;
  const panelMatrix = getShapeMatrix(panel);
  const { u, v } = getFacePlaneAxes(facePlaneNormal);
  const boundary = meshOnPlaneBoundary2D(panel.geometry, panelMatrix, facePlaneNormal, facePlaneOrigin, u, v, planeTolerance);
  if (boundary && boundary.length >= 3) {
    return isPointInsidePolygon(projectTo2D(worldPt, facePlaneOrigin, u, v), boundary);
  }
  const posAttr = panel.geometry.getAttribute('position') as THREE.BufferAttribute;
  const pts2D: Point2D[] = [];
  for (let i = 0; i < posAttr.count; i++) {
    const wp = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(panelMatrix);
    const dist = Math.abs(facePlaneNormal.dot(new THREE.Vector3().subVectors(wp, facePlaneOrigin)));
    if (dist < planeTolerance) pts2D.push(projectTo2D(wp, facePlaneOrigin, u, v));
  }
  if (pts2D.length < 3) {
    pts2D.length = 0;
    for (let i = 0; i < posAttr.count; i++) {
      const wp = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(panelMatrix);
      pts2D.push(projectTo2D(wp, facePlaneOrigin, u, v));
    }
  }
  if (pts2D.length < 3) return false;
  const hull = convexHull2D(pts2D);
  if (hull.length < 3) return false;
  return isPointInsidePolygon(projectTo2D(worldPt, facePlaneOrigin, u, v), hull);
}

export function collectVirtualFaceObstacleEdgesWorld(virtualFaces: VirtualFace[], excludeId: string | null, shapeLocalToWorld: THREE.Matrix4, facePlaneNormal: THREE.Vector3, facePlaneOrigin: THREE.Vector3, planeTolerance: number = 20, excludeVfIds?: Set<string>): ObstacleEdge[] {
  const edges: ObstacleEdge[] = [];
  for (const vf of virtualFaces) {
    if (vf.id === excludeId || vf.vertices.length < 3) continue;
    // Aynı düzlemde eşitlenmiş kardeş VF de engel sayılmaz (yukarıdaki gerekçe).
    if (excludeVfIds && excludeVfIds.has(vf.id)) continue;
    const ownerId = `vf:${vf.id}`;
    const worldVerts = vf.vertices.map(vtx => new THREE.Vector3(vtx[0], vtx[1], vtx[2]).applyMatrix4(shapeLocalToWorld));
    for (let i = 0; i < worldVerts.length; i++) {
      const va = worldVerts[i], vb = worldVerts[(i + 1) % worldVerts.length];
      const distA = Math.abs(facePlaneNormal.dot(new THREE.Vector3().subVectors(va, facePlaneOrigin)));
      const distB = Math.abs(facePlaneNormal.dot(new THREE.Vector3().subVectors(vb, facePlaneOrigin)));
      if (distA < planeTolerance && distB < planeTolerance) edges.push({ v1: va, v2: vb, ownerId });
    }
  }
  return edges;
}

/**
 * TAM YÜZ SEÇİMİ: Tıklanan noktadan, o noktayı içeren yüz ÜÇGENİNİN
 * kenar/köşe paylaşan BAĞLANTILI BİLEŞENİ toplanır; VF bu bileşenin sınır
 * konturudur. Panel her zaman tıklanan yüzün TAMAMINA yayılır (üretim
 * PanelRebuildService'te OCC yüz-extrusion ile yapılır; kısaltılmış kardeş
 * paneller kesilir, tıklanan taraf tutulur). Işın/görünürlük çokgeni ve
 * reçete mekanizması kaldırıldı — VF parentFaceShape olarak işaretlenir ve
 * resize'da yüz eşlemesiyle (regenerateParentFaceShapeVF) güncellenir.
 */
/**
 * Bir yüz grubundan, seed noktasına en yakın/onu içeren üçgenin kenar-köşe
 * paylaşan BAĞLANTILI BİLEŞENİNİ toplar; bileşenin sınır konturunu (sıralı
 * köşeler), sınır kenarlarını, üçgen indekslerini ve alan-ağırlıklı merkezini
 * döndürür. Hem yakalama önizlemesi (buildFacePreview) hem resize regen'i
 * (regenerateParentFaceShapeVF) aynı mantığı kullanır — VF her zaman tıklanan
 * bileşenin GERÇEK konturudur; ayrık eş-düzlem parçalar asla birleşmez.
 */
export function computeFaceComponentContour(
  faces: FaceData[],
  faceIndices: number[],
  seedLocal: THREE.Vector3,
  groupNormal: THREE.Vector3
): { comp: number[]; seedFi: number; corners: THREE.Vector3[]; center: THREE.Vector3; boundary: Array<{ a: THREE.Vector3; b: THREE.Vector3 }> } | null {
  let seedFi = -1, bestD = Infinity;
  for (const fi of faceIndices) {
    const f = faces[fi];
    if (!f) continue;
    if (pointInTriangle3D(seedLocal, f.vertices[0], f.vertices[1], f.vertices[2])) { seedFi = fi; break; }
    // İçeren üçgen yoksa: en yakın MERKEZ değil, üçgen ÜZERİNDEKİ en yakın
    // nokta (kenar clamp) — büyük üçgen merkez-uzak olsa da doğru komşu seçilir.
    let dMin = Infinity;
    for (let k = 0; k < 3; k++) {
      const a = f.vertices[k], b = f.vertices[(k + 1) % 3];
      const ab = new THREE.Vector3().subVectors(b, a);
      const t = Math.max(0, Math.min(1, new THREE.Vector3().subVectors(seedLocal, a).dot(ab) / (ab.lengthSq() || 1)));
      const q = a.clone().addScaledVector(ab, t);
      dMin = Math.min(dMin, q.distanceTo(seedLocal));
    }
    if (dMin < bestD) { bestD = dMin; seedFi = fi; }
  }
  if (seedFi === -1) return null;

  const vKey = (v3: THREE.Vector3) => `${v3.x.toFixed(1)},${v3.y.toFixed(1)},${v3.z.toFixed(1)}`;
  const triKeys = new Map<number, string[]>();
  for (const fi of faceIndices) {
    const f = faces[fi];
    if (f) triKeys.set(fi, f.vertices.map(vKey));
  }
  const comp = new Set<number>([seedFi]);
  const stack = [seedFi];
  while (stack.length) {
    const cur = stack.pop()!;
    const ck = new Set(triKeys.get(cur) || []);
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
  const ring2D = ring.map(p3 => ({ x: p3.dot(u), y: p3.dot(v) }));
  const keep: number[] = [];
  for (let i = 0; i < ring2D.length; i++) {
    const a = ring2D[(i - 1 + ring2D.length) % ring2D.length], b = ring2D[i], c = ring2D[(i + 1) % ring2D.length];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(cross) > 0.05) keep.push(i);
  }
  const corners = keep.length >= 3 ? keep.map(i => ring[i]) : ring;

  const center = new THREE.Vector3();
  let areaSum = 0;
  for (const fi of comp) {
    const f = faces[fi]!;
    const ar = new THREE.Vector3().subVectors(f.vertices[1], f.vertices[0])
      .cross(new THREE.Vector3().subVectors(f.vertices[2], f.vertices[0])).length() / 2;
    const c = f.vertices[0].clone().add(f.vertices[1]).add(f.vertices[2]).multiplyScalar(1 / 3);
    center.addScaledVector(c, ar);
    areaSum += ar;
  }
  if (areaSum > 0) center.multiplyScalar(1 / areaSum);

  return { comp: [...comp], seedFi, corners, center, boundary };
}


// ═══════════════════════════════════════════════════════════════════════════
// SERBEST BÖLGE — TEK KAYNAK, TEK UZAY, DOĞRULAMALI
//
// NEDEN YENİDEN YAZILDI: Sanal yüzey ile highlight AYRI yollardan üretiliyordu
// ve sürekli ayrışıyorlardı. Ayak izleri de karışık uzayda hesaplanıyordu:
// panelFootprintOnPlane köşeleri DÜNYAYA taşırken kendisine YEREL normal/orijin
// veriliyor, dönen sonuç yerel eksenlerle 3B'ye kurulup bir kez daha
// worldToLocal'dan geçiriliyordu (çifte dönüşüm). Küp orijindeyken görünmeyen,
// taşınınca ayak izini kaydıran bir hata sınıfı.
//
// YENİ KURAL:
//  1) Ayak izi TEK açık zincirle: panel yerel → dünya → PARENT YEREL.
//  2) Bölge, kullanıcının GÖRDÜĞÜ reach grid'inden türetilir (kanıtlanmış doğru).
//  3) Grid kuantizasyonu, izlenen sınırın KAYNAK DOĞRULARA oturtulmasıyla
//     giderilir: şekil grid'den, hassasiyet gerçek kenarlardan gelir.
//  4) Bu fonksiyonu hem yakalama hem regen çağırır → ayrışmaları imkânsız.
// ═══════════════════════════════════════════════════════════════════════════

export interface FreeRegionResult {
  u: THREE.Vector3; v: THREE.Vector3; planeN: number;
  ring2D: Point2D[]; footprints: Point2D[][]; touchingSiblingIds: string[];
  uMin: number; vMin: number; cw: number; ch: number; nx: number; ny: number;
  reach: Uint8Array; anchor: Point2D; regionOk: boolean;
  /** Serbest bölgenin kaynak kenarlara oturtulmuş konturu (yerel u/v). */
  polygon: Point2D[];
  /** KALICI BAĞ İLİŞKİSİ: seçilen bölgenin, her kardeş ayak izinin kanonik
   *  dik eksenine göre hangi tarafta olduğu (kardeşPanelId → ±1). Çağıran
   *  bunu VF'de saklar ve sonraki regen'lerde geri geçer; taraf seçimi
   *  böylece açıdan/örtüşme sezgisellerinden bağımsız DETERMİNİSTİK olur. */
  sideRelations: Record<string, number>;
}

interface RotOp {
  kind?: 'rotate' | 'translate';
  pivot?: THREE.Vector3;
  axis?: THREE.Vector3;
  angleRad?: number;
  d?: THREE.Vector3;
}

/**
 * Panel parametrelerinden (rotateSteps / transformSteps) dönüş işlemlerini çıkarır.
 * PanelEngine.composeSteps ile aynı mantık, ancak bağımlılık döngüsünden kaçınmak
 * için basitleştirilmiş versiyon. Pivot ve axis DÜNYA koordinatlarında.
 */
function buildRotationOpsFromPanel(panel: any): RotOp[] {
  // composeSteps ile önceden çözülmüş (doğru pivot + zincirlenmiş eksen) ops
  // varsa onu kullan — gerçek panel dönüşüyle bire bir eşleşir.
  if (Array.isArray(panel?.__composedOps)) return panel.__composedOps;
  const params = panel?.parameters;
  if (!params) return [];
  const steps: any[] = [];
  if (Array.isArray(params.transformSteps)) {
    for (const s of params.transformSteps) {
      if (s?.type === 'rotate') steps.push(s);
    }
  } else if (Array.isArray(params.rotateSteps)) {
    for (const s of params.rotateSteps) steps.push(s);
  }
  if (steps.length === 0) return [];

  const ops: RotOp[] = [];
  for (const s of steps) {
    const deg = s.value || 0;
    if (Math.abs(deg) < 1e-6) continue;
    const angleRad = (deg * Math.PI) / 180;
    const axis = s.axisVec
      ? new THREE.Vector3(...s.axisVec).normalize()
      : letterToVec(s.axis);
    const pivot = s.pivot
      ? new THREE.Vector3(...s.pivot)
      : new THREE.Vector3();
    ops.push({ kind: 'rotate', pivot, axis, angleRad });
  }
  return ops;
}

function letterToVec(a: string): THREE.Vector3 {
  switch (a) {
    case 'x+': return new THREE.Vector3(1, 0, 0);
    case 'x-': return new THREE.Vector3(-1, 0, 0);
    case 'y+': return new THREE.Vector3(0, 1, 0);
    case 'y-': return new THREE.Vector3(0, -1, 0);
    case 'z+': return new THREE.Vector3(0, 0, 1);
    case 'z-': return new THREE.Vector3(0, 0, -1);
    default: return new THREE.Vector3(0, 0, 0);
  }
}

/** Panelin ayak izi — PARENT YEREL uzayında, tek dönüşüm zinciriyle. */
export function panelFootprintInParentLocal(
  panel: any, parentWorldToLocal: THREE.Matrix4,
  nrm: THREE.Vector3, planeN: number,
  u: THREE.Vector3, v: THREE.Vector3, tol = 3.0
): Point2D[] | null {
  if (!panel?.geometry) return null;
  const pos = panel.geometry.getAttribute('position');
  if (!pos) return null;
  const M = new THREE.Matrix4().multiplyMatrices(parentWorldToLocal, getShapeMatrix(panel));
  const isRotated = panel.__isRotatedPanel === true;
  const pts: THREE.Vector3[] = []; const d: number[] = [];
  let dMin = Infinity, dMax = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const p = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(M);
    const dd = p.dot(nrm) - planeN;
    pts.push(p); d.push(dd);
    if (dd < dMin) dMin = dd;
    if (dd > dMax) dMax = dd;
  }
  if (pts.length < 3) return null;
  // ── DÜZLEME-DEĞME KONTROLÜ ────────────────────────────────────────────────
  // Panel bu yüze hiç DEĞMİYORSA (tüm köşeler düzlemin AYNI tarafında ve tolerans
  // dışında) ayak izi YOK. Özellikle __isRotatedPanel yolu için şart: o yol tüm
  // siluetin konveks gövdesini alır ve düzleme-değmeye BAKMAZ. Extrude'lu paneller
  // de (VirtualFaceUpdateService .map) o yoldan geçtiği için, extrude'lu üst panel
  // kendisine PARALEL alt/ara panelin yüzünü tüm siluetiyle KAPLIYOR → "yüz yok
  // oldu → tam kontur" ile o panel yan panelleri dikkate almadan büyüyordu. Bu
  // kapı, değmeyen (paralel/uzak) kardeşi ayak izi üretmeden eler; değen/kesen
  // kardeşler (dMin≤tol≤dMax veya yatık köşe) etkilenmez.
  if (dMin > tol || dMax < -tol) return null;
  const out: Point2D[] = [];
  // Düzleme yatık köşeler
  let flatVertCount = 0;
  for (let i = 0; i < pts.length; i++) {
    if (Math.abs(d[i]) < tol) { out.push({ x: pts[i].dot(u), y: pts[i].dot(v) }); flatVertCount++; }
  }
  // DÖNMÜŞ PANEL: composeSteps'ten çözülmüş DOĞRU dönüşüm (gerçek panel dönüşü
  // ile bire bir pivot/eksen) düz köşelere uygulanır, ardından TÜM köşeler
  // hedef düzleme izdüşürülür (tam siluet). Önceki fazla-kısaltma bayat
  // ham s.pivot yüzünden izin kaymasından kaynaklanıyordu; artık pivot
  // pivotVfFrac'tan doğru çözüldüğü için iz doğru yerde ve doğru boyutta.
  if (isRotated) {
    const rotOps = buildRotationOpsFromPanel(panel);
    const localOps = rotOps.map(op => ({
      kind: op.kind || 'rotate',
      pivot: op.pivot ? op.pivot.clone().applyMatrix4(parentWorldToLocal) : undefined,
      axis: op.axis ? op.axis.clone().transformDirection(parentWorldToLocal).normalize() : undefined,
      angleRad: op.angleRad || 0,
      d: op.d ? op.d.clone().transformDirection(parentWorldToLocal) : undefined,
    }));
    const rOut: Point2D[] = pts.map(p => {
      const v3 = p.clone();
      for (const op of localOps) {
        if (op.kind === 'translate') { if (op.d) v3.add(op.d); }
        else if (op.pivot && op.axis) { v3.sub(op.pivot); v3.applyAxisAngle(op.axis, op.angleRad); v3.add(op.pivot); }
      }
      return { x: v3.dot(u), y: v3.dot(v) };
    });
    if (rOut.length < 3) return null;
    const hull = convexHull2D(rOut);
    return hull.length >= 3 ? hull : null;
  }
  // EĞİK PANEL: düzlemi kesiyorsa gerçek KESİT (siluet değil)
  const pierces = dMin < -tol && dMax > tol;
  if (pierces) {
    const idx = panel.geometry.getIndex();
    const cnt = idx ? idx.count : pos.count;
    const at = (k: number) => (idx ? idx.getX(k) : k);
    for (let t = 0; t + 2 < cnt; t += 3) {
      const tri = [at(t), at(t + 1), at(t + 2)];
      for (let e = 0; e < 3; e++) {
        const a = tri[e], b = tri[(e + 1) % 3], da = d[a], db = d[b];
        if ((da > 0 && db > 0) || (da < 0 && db < 0)) continue;
        const den = da - db;
        if (Math.abs(den) < 1e-9) continue;
        const sT = da / den;
        if (sT < 0 || sT > 1) continue;
        const ip = new THREE.Vector3().lerpVectors(pts[a], pts[b], sT);
        out.push({ x: ip.dot(u), y: ip.dot(v) });
      }
    }
  }
  // Düzleme hiç değmiyorsa ayak izi YOK (hayalet kırpma olmaz)
  if (out.length < 3) return null;
  // İçbükey sınır çıkarımı: düzlem-üstü üçgenlerin kenar-halkası
  {
    const idx = panel.geometry.getIndex();
    const cnt = idx ? idx.count : pos.count;
    const at2 = (k: number) => (idx ? idx.getX(k) : k);
    const edgeCount2 = new Map<string, number>();
    const edgeData2 = new Map<string, { p1: Point2D; p2: Point2D }>();
    const eKey = (a: number, b: number) => a < b ? `${a}_${b}` : `${b}_${a}`;
    for (let t = 0; t + 2 < cnt; t += 3) {
      const i0 = at2(t), i1 = at2(t + 1), i2 = at2(t + 2);
      if (Math.abs(d[i0]) >= tol || Math.abs(d[i1]) >= tol || Math.abs(d[i2]) >= tol) continue;
      const tri2 = [[i0, i1], [i1, i2], [i2, i0]];
      for (const [a, b] of tri2) {
        const key = eKey(a, b);
        edgeCount2.set(key, (edgeCount2.get(key) || 0) + 1);
        if (!edgeData2.has(key)) {
          edgeData2.set(key, { p1: { x: pts[a].dot(u), y: pts[a].dot(v) }, p2: { x: pts[b].dot(u), y: pts[b].dot(v) } });
        }
      }
    }
    const bEdges: Array<{ v1: THREE.Vector3; v2: THREE.Vector3 }> = [];
    for (const [key, c] of edgeCount2) {
      if (c === 1) {
        const ed = edgeData2.get(key)!;
        bEdges.push({ v1: new THREE.Vector3(ed.p1.x, ed.p1.y, 0), v2: new THREE.Vector3(ed.p2.x, ed.p2.y, 0) });
      }
    }
    if (bEdges.length >= 3) {
      const loop2 = buildBoundaryLoop2D(bEdges, new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0));
      if (loop2 && loop2.length >= 3) return loop2;
    }
  }
  const hull = convexHull2D(out);
  if (hull.length < 3) return null;

  // ── SALT-KESİT KENAR-TEMASI KAPISI ──────────────────────────────────────
  // Dönmüş bir panel bu yüzü SADECE deliyorsa (yüze YATIK hiçbir yüzeyi yok:
  // flatVertCount==0) ve ürettiği kesit İNCE bir şerit ise (dar kenarı ~panel
  // kalınlığı mertebesinde), bu bir ENGEL değil KENAR-TEMASIdır: panel yüzün
  // ÖNÜNDE durmuyor, yalnız kenarıyla değiyor. Bunu ayak izi (bloklayan alan)
  // saymak, computeFreeRegionLocal'da yüzü ortadan bölen bir "duvar" gibi
  // davranıp bölgenin yarısını sildiriyordu (log kanıtı: dönmüş kardeş ayak
  // izi 600x~20, v konumu -345→-239→-180 kayıyor, VF %40-58 çöküyor,
  // "sağ panel hatalı yerleşti"). Kenar-teması VF'yi oymaz; rebuild'de
  // yarım-uzay/gövde kesimiyle (kardeş kesimi) doğru biçilir.
  //
  // Düz komşu panel de yüze 18mm kalınlık KENARIYLA değer ama o YATIK yüzeyle
  // yaslanır (flatVertCount>0) → gerçek engeldir, bu kapıdan GEÇMEZ. Yatık yüz
  // yoksa ve şerit inceyse yalnız kesit-teması vardır → engel sayılmaz.
  if (pierces && flatVertCount === 0 && !isRotated) {
    let huMin = Infinity, huMax = -Infinity, hvMin = Infinity, hvMax = -Infinity;
    for (const q of hull) { huMin = Math.min(huMin, q.x); huMax = Math.max(huMax, q.x); hvMin = Math.min(hvMin, q.y); hvMax = Math.max(hvMax, q.y); }
    const minSpan = Math.min(huMax - huMin, hvMax - hvMin);
    // İnce eşiği: panel kalınlığının biraz üstü. Panel geometrisinin en ince
    // ekseninden (kalınlık) türetilir; bulunamazsa güvenli sabit (40mm).
    const gp = panel.geometry.getAttribute('position');
    let pMinX = Infinity, pMaxX = -Infinity, pMinY = Infinity, pMaxY = -Infinity, pMinZ = Infinity, pMaxZ = -Infinity;
    for (let i = 0; i < gp.count; i++) {
      const x = gp.getX(i), y = gp.getY(i), z = gp.getZ(i);
      pMinX = Math.min(pMinX, x); pMaxX = Math.max(pMaxX, x);
      pMinY = Math.min(pMinY, y); pMaxY = Math.max(pMaxY, y);
      pMinZ = Math.min(pMinZ, z); pMaxZ = Math.max(pMaxZ, z);
    }
    const panelThk = Math.min(pMaxX - pMinX, pMaxY - pMinY, pMaxZ - pMinZ);
    const thinThreshold = Math.max(panelThk, 18) + 12; // kalınlık + pay
    if (minSpan <= thinThreshold) {
      return null; // salt kenar-teması → engel değil
    }
  }

  return hull;
}

/** reach hücrelerinin sınırını sıralı 2B halkaya çevirir. */
export function traceReachBoundary(
  reach: Uint8Array, nx: number, ny: number,
  uMin: number, vMin: number, cw: number, ch: number
): Point2D[] {
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

  // KENAR bazlı yürüyüş (KÖŞE bazlı DEĞİL). Dört hücrenin çapraz birleştiği
  // köşeye DÖRT kenar bağlanır ve halka oradan İKİ kez geçer; köşeyi
  // "ziyaret edildi" diye işaretlemek zinciri erken kesip ince şerit üretiyordu.
  const K = (p: Point2D) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`;
  const adj = new Map<string, Array<{ to: Point2D; si: number }>>();
  segs.forEach(([a, b], si) => {
    const ka = K(a), kb = K(b);
    if (!adj.has(ka)) adj.set(ka, []);
    if (!adj.has(kb)) adj.set(kb, []);
    adj.get(ka)!.push({ to: b, si });
    adj.get(kb)!.push({ to: a, si });
  });

  // Birden çok kopuk halka olabilir (ada); EN UZUNU alınır.
  const usedSeg = new Uint8Array(segs.length);
  let bestRing: Point2D[] = [];
  for (let s0 = 0; s0 < segs.length; s0++) {
    if (usedSeg[s0]) continue;
    const startP = segs[s0][0];
    const ring: Point2D[] = [startP];
    let cur = startP;
    for (let guard = 0; guard <= segs.length + 4; guard++) {
      const nb = adj.get(K(cur)) || [];
      const nxt = nb.find(e => !usedSeg[e.si]);
      if (!nxt) break;
      usedSeg[nxt.si] = 1;
      cur = nxt.to;
      if (K(cur) === K(startP)) break;
      ring.push(cur);
    }
    if (ring.length > bestRing.length) bestRing = ring;
  }
  if (bestRing.length < 3) return [];

  // Eşdoğrusal sadeleştirme
  const out: Point2D[] = [];
  for (let i = 0; i < bestRing.length; i++) {
    const a = bestRing[(i - 1 + bestRing.length) % bestRing.length];
    const b = bestRing[i];
    const c = bestRing[(i + 1) % bestRing.length];
    const cr = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(cr) > 1e-6) out.push(b);
  }
  return out.length >= 3 ? out : bestRing;
}

/** İzlenen sınırı, gerçek kaynak kenarlara (yüz konturu + ayak izleri) oturtur. */
export function snapPolygonToSourceLines(
  poly: Point2D[], sources: Point2D[][], tolDist: number
): Point2D[] {
  if (poly.length < 3) return poly;
  type Line = { p: Point2D; d: Point2D };
  const lines: Line[] = [];
  for (const src of sources) {
    for (let i = 0; i < src.length; i++) {
      const a = src[i], b = src[(i + 1) % src.length];
      const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
      if (L > 1e-6) lines.push({ p: a, d: { x: dx / L, y: dy / L } });
    }
  }
  const distToLine = (q: Point2D, l: Line) =>
    Math.abs((q.x - l.p.x) * l.d.y - (q.y - l.p.y) * l.d.x);
  const edgeLines: Line[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
    const own: Line = L > 1e-6 ? { p: a, d: { x: dx / L, y: dy / L } } : { p: a, d: { x: 1, y: 0 } };
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    let best: Line | null = null, bestD = tolDist;
    for (const l of lines) {
      if (Math.abs(own.d.x * l.d.y - own.d.y * l.d.x) > 0.15) continue; // paralel değil
      const dd = distToLine(mid, l);
      if (dd < bestD) { bestD = dd; best = l; }
    }
    edgeLines.push(best || own);
  }
  const out: Point2D[] = [];
  for (let i = 0; i < poly.length; i++) {
    const l1 = edgeLines[(i - 1 + poly.length) % poly.length], l2 = edgeLines[i];
    const den = l1.d.x * l2.d.y - l1.d.y * l2.d.x;
    if (Math.abs(den) < 1e-9) { out.push(poly[i]); continue; }
    const t = ((l2.p.x - l1.p.x) * l2.d.y - (l2.p.y - l1.p.y) * l2.d.x) / den;
    out.push({ x: l1.p.x + l1.d.x * t, y: l1.p.y + l1.d.y * t });
  }
  return out;
}

/**
 * Çokgeni bir YARIM DÜZLEMLE keser: (a→b) doğrusunun SAĞ tarafında kalan
 * (cross <= 0) parça tutulur. Sutherland-Hodgman'ın tek kenarlı hâli — her
 * açıda kesin sonuç verir, köşegen kenarda tırtık üretmez.
 */
export function clipByHalfPlane(poly: Point2D[], a: Point2D, b: Point2D): Point2D[] {
  const side = (p: Point2D) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const out: Point2D[] = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i], prev = poly[(i + poly.length - 1) % poly.length];
    const sc = side(cur), sp = side(prev);
    const cIn = sc <= 1e-9, pIn = sp <= 1e-9;
    if (cIn) {
      if (!pIn) {
        const t = sp / (sp - sc);
        out.push({ x: prev.x + t * (cur.x - prev.x), y: prev.y + t * (cur.y - prev.y) });
      }
      out.push(cur);
    } else if (pIn) {
      const t = sp / (sp - sc);
      out.push({ x: prev.x + t * (cur.x - prev.x), y: prev.y + t * (cur.y - prev.y) });
    }
  }
  return out;
}

// KANONİK ŞERİT ÇERÇEVESİ: ayak izi hull'unun merkezi + uzun kenarına dik,
// işareti kanonikleştirilmiş birim eksen. Taraf işareti = sign(dot(P-c, p̂)).
// Kanonikleştirme (p̂'nin baskın bileşeni pozitif yapılır) sayesinde şerit
// açıyla hafif eğilse de işaret regen'ler arası KARŞILAŞTIRILABİLİR kalır.
export function canonicalStripFrame(fp: Point2D[]): { c: Point2D; p: Point2D } {
  let cx = 0, cy = 0;
  for (const q of fp) { cx += q.x; cy += q.y; }
  cx /= fp.length; cy /= fp.length;
  let bl = -1, dx = 1, dy = 0;
  for (let k = 0; k < fp.length; k++) {
    const a = fp[k], b = fp[(k + 1) % fp.length];
    const ex = b.x - a.x, ey = b.y - a.y;
    const L = ex * ex + ey * ey;
    if (L > bl) { bl = L; dx = ex; dy = ey; }
  }
  const len = Math.hypot(dx, dy) || 1e-9;
  let px = -dy / len, py = dx / len;
  if (Math.abs(py) >= Math.abs(px)) { if (py < 0) { px = -px; py = -py; } }
  else if (px < 0) { px = -px; py = -py; }
  return { c: { x: cx, y: cy }, p: { x: px, y: py } };
}

export function computeFreeRegionLocal(
  contourCorners: THREE.Vector3[],
  normalLocal: THREE.Vector3,
  seedLocal: THREE.Vector3,
  siblingPanels: any[],
  parentWorldToLocal: THREE.Matrix4,
  parentShapeId?: string,
  // BÖLGE SÜREKLİLİĞİ (yalnız REGEN yolu doldurur): önceki VF çokgeni.
  // Dönmüş bir kardeşin şeridi yüzü İKİYE böler ve açı değişince şerit sabit
  // seed'in ÜSTÜNDEN süpürülürse, seed karşı bileşende kalır ve bölge komple
  // taraf değiştirir (log kanıtı: -32° VF=alt 233, -33° VF=üst 390 — "panel
  // üste çıkıyor"). Önceki bölgeyle EN ÇOK örtüşen bileşen seçilerek kimlik
  // korunur. Capture yolu bu parametreyi geçmez; tıklama davranışı değişmez.
  prevRegionCorners?: THREE.Vector3[],
  // KALICI BAĞ İLİŞKİSİ (öncelik: ilişki > süreklilik > seed): önceki
  // regen'lerin kaydettiği kardeş→taraf işaretleri. Örtüşme sezgiseli, engel
  // regen'ler arası BÜYÜK sıçrama yaptığında (hızlı döndürme) bayat prev'in
  // üst tarafla daha çok örtüşmesi yüzünden yanlış tarafı seçebiliyordu (log
  // kanıtı: şerit z454→z189 sıçrayınca VF üste zıpladı, GÖNYE dS>near). Bu
  // kayıt, tarafı geometriden bağımsız SÖZLEŞME yapar: panel hep ilk temas
  // ettiği tarafa bağlı kalır; o taraf yok olursa yeniden çözülüp yazılır.
  storedSideRelations?: Record<string, number>
): FreeRegionResult | null {
  if (contourCorners.length < 3) return null;
  const nrm = normalLocal.clone().normalize();
  const { u, v } = getFacePlaneAxes(nrm);
  const ring2D: Point2D[] = contourCorners.map(c => ({ x: c.dot(u), y: c.dot(v) }));
  const planeN = contourCorners[0].dot(nrm);

  const footprints: Point2D[][] = [];
  const fpRotated: boolean[] = [];
  const fpIds: (string | null)[] = [];
  const touchingSiblingIds: string[] = [];
  for (const panel of siblingPanels) {
    if (parentShapeId && panel?.parameters?.parentShapeId &&
        panel.parameters.parentShapeId !== parentShapeId) continue;
    const fp = panelFootprintInParentLocal(panel, parentWorldToLocal, nrm, planeN, u, v);
    if (!fp) continue;
    footprints.push(fp);
    // Dönüş zaten footprint'e uygulandı — uzak-teğet ötelemesi KAPATILIR.
    // Eski davranış: dönmüş panelin düz (18mm) izi uzak-teğete ötelenirdi.
    // Yeni: rotateSteps köşelere uygulanıp tam siluet hesaplandığı için
    // footprint doğrudan kullanılır, ekstra öteleme gerekmez.
    fpRotated.push(false);
    fpIds.push(panel?.id ?? null);
    if (panel.id) touchingSiblingIds.push(panel.id);
  }

  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const q of ring2D) {
    uMin = Math.min(uMin, q.x); uMax = Math.max(uMax, q.x);
    vMin = Math.min(vMin, q.y); vMax = Math.max(vMax, q.y);
  }
  const uSpan = Math.max(uMax - uMin, 1e-6), vSpan = Math.max(vMax - vMin, 1e-6);
  const cell = Math.min(20, Math.max(2, Math.max(uSpan, vSpan) / 140));
  const nx = Math.min(240, Math.max(1, Math.ceil(uSpan / cell)));
  const ny = Math.min(240, Math.max(1, Math.ceil(vSpan / cell)));
  const cw = uSpan / nx, ch = vSpan / ny;

  const free = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const pt = { x: uMin + (i + 0.5) * cw, y: vMin + (j + 0.5) * ch };
    if (!isPointInsidePolygon(pt, ring2D)) continue;
    let blocked = false;
    for (const fp of footprints) if (isPointInsidePolygon(pt, fp)) { blocked = true; break; }
    if (!blocked) free[j * nx + i] = 1;
  }

  const cu = seedLocal.dot(u), cv = seedLocal.dot(v);
  let ci = Math.max(0, Math.min(nx - 1, Math.floor((cu - uMin) / cw)));
  let cj = Math.max(0, Math.min(ny - 1, Math.floor((cv - vMin) / ch)));

  // ── BÖLGE SÜREKLİLİĞİ: bileşen, önceki VF ile örtüşmeye göre seçilir ──
  // Seed statiktir (orijinal tıklama); engel şeridi onun üstünden süpürülünce
  // seed karşı bileşene düşer ve bölge zıplar. prevRegionCorners varsa serbest
  // hücreler bileşenlere ayrılır, önceki bölgeyle EN ÇOK örtüşen bileşen
  // kazanır; başlangıç hücresi o bileşenin seed'e en yakın hücresidir. Örtüşen
  // bileşen yoksa (önceki bölge tamamen yok olduysa) seed davranışına düşülür.
  let continuityChosen = false;
  let continuityConnected = false; // tek-bileşenli süreklilik (doğrulama gevşetilir)
  let relationChosen = false;      // kayıtlı bağ ilişkisi uygulandı (doğrulama gevşetilir)

  // ── ÖNCELİK 1: KALICI BAĞ İLİŞKİSİ ──────────────────────────────────────
  // Kayıtlı taraf işaretleri varsa çapa, TÜM uygulanabilir kısıtları sağlayan
  // serbest hücreler arasından seed'e en yakını olur. Deterministiktir: engel
  // regen'ler arası ne kadar sıçrarsa sıçrasın panel hep kayıtlı tarafta
  // kalır. Kısıt kümesi boşsa (o taraf geometrik olarak yok oldu) sezgisel
  // katmanlara düşülür ve sonuçtan YENİ ilişki yazılır (ilk-temas yeniden).
  if (storedSideRelations) {
    const constraints: Array<{ c: Point2D; p: Point2D; sign: number }> = [];
    for (let f = 0; f < footprints.length; f++) {
      const id = fpIds[f];
      if (!id) continue;
      const sgn = storedSideRelations[id];
      if (sgn !== 1 && sgn !== -1) continue;
      const fr = canonicalStripFrame(footprints[f]);
      constraints.push({ c: fr.c, p: fr.p, sign: sgn });
    }
    if (constraints.length > 0) {
      let bd = Infinity, bi = -1, bj = -1;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        if (!free[j * nx + i]) continue;
        const pt = { x: uMin + (i + 0.5) * cw, y: vMin + (j + 0.5) * ch };
        let ok = true;
        for (const k of constraints) {
          const s = (pt.x - k.c.x) * k.p.x + (pt.y - k.c.y) * k.p.y;
          if (s * k.sign < 0) { ok = false; break; }
        }
        if (!ok) continue;
        const dd = (i - ci) * (i - ci) + (j - cj) * (j - cj);
        if (dd < bd) { bd = dd; bi = i; bj = j; }
      }
      if (bi >= 0) {
        if (bi !== ci || bj !== cj) {
          console.log('[YAGO][BÖLGE] bağ-ilişkisi: çapa kayıtlı tarafa zorlandı. kısıtN=', constraints.length,
            'kayıtlıTaraf=', constraints.map(k => k.sign).join(','),
            'çapa(', bi, ',', bj, ') seed(', ci, ',', cj, ')');
        }
        ci = bi; cj = bj;
        relationChosen = true;
      } else {
        // Kayıtlı tarafta seed'e yakın serbest hücre yok; ama taraf sözleşmesi
        // MUTLAKTIR (zıplamayı önlemek için). Kayıtlı tarafı sağlayan HERHANGİ
        // bir serbest hücre varsa (en büyük bileşenin merkezi) ona git; hiç
        // yoksa ancak o zaman sezgisele düş.
        let fb = -1, fbi = -1, fbj = -1, fbCount = 0;
        // kayıtlı tarafı sağlayan serbest hücrelerin sayısı + merkezi
        let sumI = 0, sumJ = 0, cnt = 0;
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
          if (!free[j * nx + i]) continue;
          const pt = { x: uMin + (i + 0.5) * cw, y: vMin + (j + 0.5) * ch };
          let ok = true;
          for (const k of constraints) {
            const s = (pt.x - k.c.x) * k.p.x + (pt.y - k.c.y) * k.p.y;
            if (s * k.sign < 0) { ok = false; break; }
          }
          if (ok) { sumI += i; sumJ += j; cnt++; }
        }
        if (cnt > 0) {
          // merkeze en yakın serbest, kayıtlı-taraf hücresi
          const tI = sumI / cnt, tJ = sumJ / cnt;
          for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
            if (!free[j * nx + i]) continue;
            const pt = { x: uMin + (i + 0.5) * cw, y: vMin + (j + 0.5) * ch };
            let ok = true;
            for (const k of constraints) {
              const s = (pt.x - k.c.x) * k.p.x + (pt.y - k.c.y) * k.p.y;
              if (s * k.sign < 0) { ok = false; break; }
            }
            if (!ok) continue;
            const dd = (i - tI) * (i - tI) + (j - tJ) * (j - tJ);
            if (fb < 0 || dd < fb) { fb = dd; fbi = i; fbj = j; }
            fbCount++;
          }
        }
        if (fbi >= 0) {
          console.log('[YAGO][BÖLGE] bağ-ilişkisi: seed kayıtlı tarafta değil ama sözleşme korunuyor → kayıtlı taraf merkezine gidildi. serbestN=', fbCount);
          ci = fbi; cj = fbj;
          relationChosen = true;
        } else {
          console.log('[YAGO][BÖLGE] bağ-ilişkisi: kayıtlı taraf TAMAMEN doldu (yüz yok oldu) → yeniden çözülüyor. kısıtN=', constraints.length);
        }
      }
    }
  }

  if (!relationChosen && prevRegionCorners && prevRegionCorners.length >= 3) {
    const prev2D: Point2D[] = prevRegionCorners.map(c => ({ x: c.dot(u), y: c.dot(v) }));
    const label = new Int32Array(nx * ny).fill(-1);
    let nComp = 0;
    for (let s = 0; s < nx * ny; s++) {
      if (!free[s] || label[s] !== -1) continue;
      const q: number[] = [s]; label[s] = nComp;
      while (q.length) {
        const k0 = q.pop()!;
        const i0 = k0 % nx, j0 = (k0 / nx) | 0;
        for (const [a, b] of [[i0 - 1, j0], [i0 + 1, j0], [i0, j0 - 1], [i0, j0 + 1]] as Array<[number, number]>) {
          if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
          const k = b * nx + a;
          if (free[k] && label[k] === -1) { label[k] = nComp; q.push(k); }
        }
      }
      nComp++;
    }
    if (nComp > 1) {
      const overlap = new Array<number>(nComp).fill(0);
      const bestCell = new Array<number>(nComp).fill(-1);
      const bestD = new Array<number>(nComp).fill(Infinity);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (!free[k]) continue;
        const L = label[k];
        const pt = { x: uMin + (i + 0.5) * cw, y: vMin + (j + 0.5) * ch };
        if (isPointInsidePolygon(pt, prev2D)) overlap[L]++;
        const dd = (i - ci) * (i - ci) + (j - cj) * (j - cj);
        if (dd < bestD[L]) { bestD[L] = dd; bestCell[L] = k; }
      }
      let bl = -1, bo = 0;
      for (let L = 0; L < nComp; L++) if (overlap[L] > bo) { bo = overlap[L]; bl = L; }
      if (bl >= 0 && bestCell[bl] >= 0) {
        ci = bestCell[bl] % nx; cj = (bestCell[bl] / nx) | 0;
        continuityChosen = true;
        if (label[Math.max(0, Math.min(ny - 1, Math.floor((cv - vMin) / ch))) * nx +
                  Math.max(0, Math.min(nx - 1, Math.floor((cu - uMin) / cw)))] !== bl) {
          console.log('[YAGO][BÖLGE] süreklilik: seed karşı bileşende kaldı, önceki bölgeyle örtüşen bileşen seçildi. örtüşme=', bo);
        }
      }
    } else if (nComp === 1 && footprints.length > 0) {
      // TEK BAĞLANTILI SÜREKLİLİK: şerit ayak izi yüz kenarına ulaşmayıp
      // boşluk bıraktığında bölge tek bileşen kalır; ama kırpma çizgisinin
      // hangi tarafı tutacağını ÇAPA belirler. Statik seed engel süpürmesiyle
      // yanlış tarafa düşmüş olabilir. Çapa, ÖNCEKİ BÖLGENİN AĞIRLIK
      // MERKEZİNE en yakın serbest hücreye taşınır — kırpma her açıda önceki
      // bölge tarafını tutar, taraf zıplaması tek-bileşenli durumda da biter.
      let pcx = 0, pcy = 0;
      for (const p of prev2D) { pcx += p.x; pcy += p.y; }
      pcx /= prev2D.length; pcy /= prev2D.length;
      const pi = Math.max(0, Math.min(nx - 1, Math.floor((pcx - uMin) / cw)));
      const pj = Math.max(0, Math.min(ny - 1, Math.floor((pcy - vMin) / ch)));
      let bd = Infinity, bi = -1, bj = -1;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        if (!free[j * nx + i]) continue;
        const pt = { x: uMin + (i + 0.5) * cw, y: vMin + (j + 0.5) * ch };
        if (!isPointInsidePolygon(pt, prev2D)) continue;
        const dd = (i - pi) * (i - pi) + (j - pj) * (j - pj);
        if (dd < bd) { bd = dd; bi = i; bj = j; }
      }
      if (bi >= 0) {
        if (bi !== ci || bj !== cj) {
          console.log('[YAGO][BÖLGE] süreklilik(bağlantılı): çapa önceki bölge merkezine taşındı.');
        }
        ci = bi; cj = bj;
        continuityChosen = true;
        continuityConnected = true;
      }
    }
  }
  if (!relationChosen && !continuityChosen && !free[cj * nx + ci]) {
    let bd = Infinity, bi = ci, bj = cj;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (!free[j * nx + i]) continue;
      const dd = (i - ci) * (i - ci) + (j - cj) * (j - cj);
      if (dd < bd) { bd = dd; bi = i; bj = j; }
    }
    ci = bi; cj = bj;
  }
  const reach = new Uint8Array(nx * ny);
  if (free[cj * nx + ci]) {
    const q: number[] = [cj * nx + ci];
    reach[cj * nx + ci] = 1;
    while (q.length) {
      const k0 = q.pop()!;
      const i = k0 % nx, j = (k0 / nx) | 0;
      for (const [a, b] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]] as Array<[number, number]>) {
        if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        const k = b * nx + a;
        if (free[k] && !reach[k]) { reach[k] = 1; q.push(k); }
      }
    }
  }

  // ── GEOMETRİ: TAM ÇOKGEN FARKI (grid DEĞİL) ──────────────────────────────
  // Grid'den kontur izlemek KÖŞEGEN kenarlarda merdiven basamağı üretir: her
  // basamak yatay/dikey küçük bir parçadır, köşegen kaynak kenara paralel
  // olmadığı için doğruya oturtulamaz ve tırtık ekranda kalır. Bu yüzden
  // geometri tam çokgen farkından gelir — köşegen kenar birebir düz çıkar.
  //
  // Grid'in görevi yalnızca KARAR vermek:
  //   (a) hangi ayak izi bu yüzü gerçekten engelliyor (hücre sayarak),
  //   (b) sonuç, kullanıcının gördüğü bölgeyle uyuşuyor mu (doğrulama).
  const blocking: Point2D[][] = [];
  const blockingRotated: boolean[] = [];
  for (let f = 0; f < footprints.length; f++) {
    const fp = footprints[f];
    let blocks = 0;
    for (let j = 0; j < ny && blocks === 0; j++) for (let i = 0; i < nx; i++) {
      const pt = { x: uMin + (i + 0.5) * cw, y: vMin + (j + 0.5) * ch };
      if (isPointInsidePolygon(pt, ring2D) && isPointInsidePolygon(pt, fp)) { blocks = 1; break; }
    }
    if (blocks) { blocking.push(fp); blockingRotated.push(fpRotated[f]); }
  }

  // Ayak izi convexHull2D çıktısıdır → KONVEKS. Bu yüzden onu dışlamak için
  // tek bir yarım düzlemle kesmek yeter: hangi kenarına göre çapa DIŞARIDA
  // kalıyorsa o kenarın doğrusuyla keseriz. Köşegen kenarda bile sonuç birebir
  // düzdür (grid izlemenin ürettiği 120 köşelik tırtık burada imkânsız).
  // Birden çok uygun kenar varsa, gördüğünüz bölgeyi EN İYİ koruyanı seçilir.
  //
  // DÖNMÜŞ KARDEŞ İSTİSNASI: dönmüş kardeşin şeridi YAKIN kenardan kırpılırsa
  // panelin kalınlık kenarı eğik kardeşin EN ALÇAK çizgisinde kare biter ve
  // eğik altyüzeyle arasında kama boşluğu kalır ("kalınlık tarafı açıya göre
  // şekil almıyor"). Bu yüzden dönmüş ayak izinde kırpma çizgisi şeridin UZAK
  // teğetine ötelenir: bölge şeridin İÇİNDEN geçer, panel dönmüş kardeşle
  // örtüşür ve rebuild'deki gövde kesimi gerçek eğik kesişimi oyarak kalınlık
  // kenarını açıya birebir şekillendirir. Düz kardeşlerde davranış değişmez
  // (düz kesişimde yakın kenar = boolean sonucuyla zaten özdeştir).
  const anchorPt = { x: uMin + (ci + 0.5) * cw, y: vMin + (cj + 0.5) * ch };
  const insideAnyRotated = (pt: Point2D): boolean => {
    for (let f = 0; f < blocking.length; f++) {
      if (blockingRotated[f] && isPointInsidePolygon(pt, blocking[f])) return true;
    }
    return false;
  };
  const scoreOf = (poly: Point2D[]): number => {
    if (poly.length < 3) return -Infinity;
    let keep = 0, bad = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const pt = { x: uMin + (i + 0.5) * cw, y: vMin + (j + 0.5) * ch };
      const isIn = isPointInsidePolygon(pt, poly);
      if (reach[j * nx + i]) { if (isIn) keep++; }
      else if (isIn && isPointInsidePolygon(pt, ring2D) && !insideAnyRotated(pt)) bad++;
    }
    return keep - 3 * bad;
  };

  let exact: Point2D[] = ring2D;
  for (let f = 0; f < blocking.length; f++) {
    const fp = blocking[f];
    let best: Point2D[] | null = null, bestScore = -Infinity;
    for (let k = 0; k < fp.length; k++) {
      let a = fp[k], b = fp[(k + 1) % fp.length];
      const sA = (b.x - a.x) * (anchorPt.y - a.y) - (b.y - a.y) * (anchorPt.x - a.x);
      if (sA >= -1e-9) continue;               // çapa bu kenara göre dışarıda değil
      if (blockingRotated[f]) {
        // Kırpma çizgisini şeridin uzak teğetine ötele: kenar normali (çapadan
        // uzağa bakan yönde) boyunca hull'un en uzak noktası kadar + 0.5mm pay.
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1e-9;
        let nX = dy / len, nY = -dx / len;      // sağ normal
        if (nX * (anchorPt.x - a.x) + nY * (anchorPt.y - a.y) > 0) { nX = -nX; nY = -nY; }
        let w = 0;
        for (const q of fp) {
          const dpr = nX * (q.x - a.x) + nY * (q.y - a.y);
          if (dpr > w) w = dpr;
        }
        const off = w + 0.5;
        a = { x: a.x + nX * off, y: a.y + nY * off };
        b = { x: b.x + nX * off, y: b.y + nY * off };
      }
      const cand = clipByHalfPlane(exact, a, b);
      const sc = scoreOf(cand);
      if (sc > bestScore) { bestScore = sc; best = cand; }
    }
    if (best && best.length >= 3) exact = best;
  }

  // ── DOĞRULAMA: sonuç, kullanıcının GÖRDÜĞÜ reach hücreleriyle uyuşmalı ──
  // Uyuşmazsa (çıkarma bozuldu, bölge ikiye ayrıldı vb.) KABUL EDİLMEZ ve tam
  // kontura dönülür. En kötü ihtimal eski davranıştır; bozuk/ince/tırtıklı
  // panel yapısal olarak doğamaz.
  let polygon = ring2D;
  let regionOk = false;
  if (exact.length >= 3 && blocking.length > 0) {
    let total = 0, inside = 0, stray = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const pt = { x: uMin + (i + 0.5) * cw, y: vMin + (j + 0.5) * ch };
      const isIn = isPointInsidePolygon(pt, exact);
      if (reach[j * nx + i]) { total++; if (isIn) inside++; }
      // Dönmüş kardeş şeridi bölgeye BİLEREK dahildir (uzak-teğet kırpması);
      // o hücreler taşma sayılmaz, yoksa doğrulama haksız yere tam-kontura düşer.
      else if (isIn && isPointInsidePolygon(pt, ring2D) && !insideAnyRotated(pt)) stray++;
    }
    const cover = total > 0 ? inside / total : 0;
    const leak = total > 0 ? stray / total : 1;
    // Tek-bileşenli süreklilikte reach HER İKİ tarafı da kapsar (bölge grid'de
    // bağlantılıdır); tek taraflı doğru poligon cover>=0.9'u yapısal olarak
    // geçemez ve tam-kontura düşerdi (panel tüm yüze yayılır = "üste çıktı"
    // görüntüsü). Bu durumda kapsama eşiği gevşetilir; taşma sınırı kalır.
    const coverMin = (continuityConnected || relationChosen) ? 0.25 : 0.9;
    regionOk = total > 0 && cover >= coverMin && leak <= 0.1;
    if (regionOk) polygon = exact;
    else console.warn('[YAGO][BÖLGE] çokgen grid ile uyuşmadı, tam kontur kullanıldı',
      { kapsama: cover.toFixed(2), taşma: leak.toFixed(2), köşeN: exact.length });
  }

  // KALICI BAĞ İLİŞKİSİ ÇIKIŞI: seçilen bölgenin (nihai çapanın) her kardeş
  // ayak izine göre taraf işareti. Çağıran VF'de saklar; sonraki regen'ler
  // bunu kısıt olarak geri geçer. İlk temasta doğal olarak tıklama tarafı
  // yazılır; taraf yok olup yeniden çözüldüğünde yeni taraf yazılır.
  const finalAnchor = { x: uMin + (ci + 0.5) * cw, y: vMin + (cj + 0.5) * ch };
  const sideRelations: Record<string, number> = {};
  for (let f = 0; f < footprints.length; f++) {
    const id = fpIds[f];
    if (!id) continue;
    const fr = canonicalStripFrame(footprints[f]);
    const s = (finalAnchor.x - fr.c.x) * fr.p.x + (finalAnchor.y - fr.c.y) * fr.p.y;
    if (Math.abs(s) > 1e-6) sideRelations[id] = s > 0 ? 1 : -1;
  }

  return {
    u, v, planeN, ring2D, footprints, touchingSiblingIds,
    uMin, vMin, cw, ch, nx, ny, reach, regionOk,
    anchor: finalAnchor,
    polygon,
    sideRelations,
  };
}
