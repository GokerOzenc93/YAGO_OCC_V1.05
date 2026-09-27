import * as THREE from 'three';
import { getFacePlaneAxes, getShapeMatrix, axisDirToVec, localBboxOf, isFlatNormal, panelThickness, type FaceData } from './Geometry';

// ═══════════════════════════════════════════════════════════════════════════
// FaceRegion — PANEL ATMA ZİNCİRİNİN SAF GEOMETRİ ÇEKİRDEĞİ.
// Burada React/UI YOK, yalnız 2B poligon işlemleri, ayak izleri, yüz konturu
// ve serbest bölge hesabı var. Hem YAKALAMA (tıklama önizlemesi) hem REGEN (VF
// güncelleme) AYNI fonksiyonları kullanır — iki yol yapısal olarak ayrışamaz.
//
// Damıtılmış kurallar:
//  • SALT-KESİT KENAR-TEMASI KAPISI (panelFootprintsInParentLocal): yüzü yalnız
//    delen dönmüş kardeşin ince kesiti engel sayılmaz.
//  • TAM SİLUET YALNIZ SENTETİK DAMGAYA AİTTİR: __isRotatedPanel yolu (tüm
//    köşelerin konveks gövdesi) yalnız ops UYGULANACAK sentetik damga
//    geometrileri içindir. Motorun yazdığı GERÇEK dönmüş geometri
//    (__rotatedRealGeom) yakalamadaki gibi KESİT/YATIK-YÜZ yolundan geçer.
//  • ÖNCELİK ZİNCİRİ (computeFreeRegionLocal): kayıtlı bağ-ilişkisi >
//    örtüşme sürekliliği > seed. Taraf, sözleşmeyle deterministiktir.
//  • UZAK-TEĞET KIRPMA: dönmüş kardeş şeridinde bölge şeridin içinden geçer;
//    gerçek gönyeyi rebuild'deki boolean tanımlar.
//  • Kesin-poligon + grid doğrulaması: köşegen kenarlar tırtıksız, sonuç
//    kullanıcının gördüğü bölgeyle uyuşmak zorunda.
//  • ÇOK PARÇALI AYAK İZİ: çentikli (C/L/U) kardeş bir yüze birden fazla AYRIK
//    şeritle değer; her şerit ayrı engeldir.
// ═══════════════════════════════════════════════════════════════════════════

export type Point2D = { x: number; y: number };
type BBox2 = { x0: number; x1: number; y0: number; y1: number };

// ── 2B TEMEL YARDIMCILAR ─────────────────────────────────────────────────────

/** Noktaların sınır kutusu. */
function bbox2(pts: Point2D[]): BBox2 {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const q of pts) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; }
  return { x0, x1, y0, y1 };
}
const fmtBox2 = (b: BBox2) => `u=${b.x0.toFixed(0)}..${b.x1.toFixed(0)} v=${b.y0.toFixed(0)}..${b.y1.toFixed(0)}`;
/** İşaretli çokgen alanı ×2 (ayakkabı bağı). */
function signedArea2(pts: Point2D[]): number {
  let s = 0;
  for (let k = 0; k < pts.length; k++) { const a = pts[k], b = pts[(k + 1) % pts.length]; s += a.x * b.y - b.x * a.y; }
  return s;
}
const cross2 = (a: Point2D, b: Point2D, c: Point2D) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const uv = (p: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3): Point2D => ({ x: p.dot(u), y: p.dot(v) });

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

function isPointInsidePolygon(p: Point2D, poly: Point2D[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > p.y) !== (yj > p.y) && p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Nokta-çokgen testi, sınır kutusu ön elemeli (isPointInsidePolygon ile birebir). */
function makePip(poly: Point2D[]): (x: number, y: number) => boolean {
  const b = bbox2(poly);
  const EPS = 1e-6;
  return (x, y) => {
    // y kutu dışı → hiçbir kenar kesişmez; x kutunun ötesinde → kesişim sayısı çift/0.
    if (y >= b.y1 || y < b.y0 || x > b.x1 + EPS || x < b.x0 - EPS) return false;
    return isPointInsidePolygon({ x, y }, poly);
  };
}

/** Tüm çaprazlar aynı işaretliyse konveks. */
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

// ── MESH SINIR HALKALARI ─────────────────────────────────────────────────────

type Edge2 = { a: Point2D; b: Point2D };

/**
 * Kenar-halkası grafiğinden halkaları yürür. `all=false`: yalnız İLK kenardan
 * başlayan tek halka (dejenere olsa bile o kenar seçilir; <3 köşe → boş).
 * `all=true`: TÜM bağlantısız halkalar — çentikli (C/L/U) bir yan panel arka
 * yüze İKİ AYRI şeritle değer; tek halka yalnız ilk şeridi buluyordu ve
 * görünmeyen şerit panelin kardeşin içine girmesine yol açıyordu.
 */
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

/** Üçgen mesh'te, düzlem-üstü (onPlane) üçgenlerin tek kullanımlı (sınır) kenarları. */
function onPlaneBoundaryEdges(geometry: THREE.BufferGeometry, onPlane: boolean[], pt2: (i: number) => Point2D): Edge2[] {
  const idx = geometry.getIndex();
  const cnt = idx ? idx.count : (geometry.getAttribute('position') as THREE.BufferAttribute).count;
  const at = (k: number) => (idx ? idx.getX(k) : k);
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

/**
 * Mesh geometrisinin düzlem-üstü üçgenlerinden gerçek sınır çokgenini çıkarır.
 * İçbükey (U) şekiller korunur. Zincir başarısız olursa convexHull'a düşer.
 */
function meshOnPlaneBoundary2D(
  geometry: THREE.BufferGeometry, panelMatrix: THREE.Matrix4,
  facePlaneNormal: THREE.Vector3, facePlaneOrigin: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3, planeTolerance: number
): Point2D[] | null {
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!posAttr || posAttr.count < 3) return null;
  const pts2: Point2D[] = [], onPlane: boolean[] = [];
  for (let i = 0; i < posAttr.count; i++) {
    const wp = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(panelMatrix);
    const d = new THREE.Vector3().subVectors(wp, facePlaneOrigin);
    onPlane.push(Math.abs(facePlaneNormal.dot(d)) < planeTolerance);
    pts2.push(uv(d, u, v));
  }
  const loop = walkBoundaryLoops(onPlaneBoundaryEdges(geometry, onPlane, i => pts2[i]), false)[0];
  if (loop && loop.length >= 3) return loop;
  const flat = pts2.filter((_, i) => onPlane[i]);
  return flat.length >= 3 ? convexHull2D(flat) : null;
}

// ── PANEL AYAK İZLERİ ────────────────────────────────────────────────────────

/** Panelin, verilen yüz DÜZLEMİNE değen 2D ayak izi (u/v hull). Panel düzleme
 *  değmiyorsa (on-plane köşe < 3) null döner — o yüzeyde engel değildir. */
function panelFootprintOnPlane(panel: any, facePlaneNormal: THREE.Vector3, facePlaneOrigin: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3, planeTolerance = 5.0): Point2D[] | null {
  if (!panel.geometry) return null;
  const panelMatrix = getShapeMatrix(panel);
  const posAttr = panel.geometry.getAttribute('position') as THREE.BufferAttribute;
  const pts2D: Point2D[] = [], all2D: Point2D[] = [];
  let nMin = Infinity, nMax = -Infinity;
  for (let i = 0; i < posAttr.count; i++) {
    const d = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(panelMatrix).sub(facePlaneOrigin);
    const signed = facePlaneNormal.dot(d);
    nMin = Math.min(nMin, signed); nMax = Math.max(nMax, signed);
    const p2 = uv(d, u, v);
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
 *  içinde mi? İçindeyse o paneli döndürür (taşınmış paneller dahil — panelin
 *  GÜNCEL geometrisiyle test edilir). */
export function findPanelCoveringPoint(worldPt: THREE.Vector3, childPanels: any[], facePlaneNormal: THREE.Vector3, facePlaneOrigin: THREE.Vector3): any | null {
  const { u, v } = getFacePlaneAxes(facePlaneNormal);
  const p2 = uv(new THREE.Vector3().subVectors(worldPt, facePlaneOrigin), u, v);
  for (const panel of childPanels) {
    const fp = panelFootprintOnPlane(panel, facePlaneNormal, facePlaneOrigin, u, v);
    if (fp && isPointInsidePolygon(p2, fp)) return panel;
  }
  return null;
}

/**
 * Bir yüz grubundan, seed noktasına en yakın/onu içeren üçgenin kenar-köşe
 * paylaşan BAĞLANTILI BİLEŞENİNİ toplar; bileşenin sınır konturunu (sıralı
 * köşeler), sınır kenarlarını, üçgen indekslerini ve alan-ağırlıklı merkezini
 * döndürür. Hem yakalama önizlemesi hem resize regen'i aynı mantığı kullanır —
 * VF her zaman tıklanan bileşenin GERÇEK konturudur; ayrık eş-düzlem parçalar asla birleşmez.
 */
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
  const ring2D = ring.map(p3 => uv(p3, u, v));
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

interface RotOp { kind?: 'rotate' | 'translate'; pivot?: THREE.Vector3; axis?: THREE.Vector3; angleRad?: number; d?: THREE.Vector3 }

/**
 * Panel parametrelerinden dönüş işlemlerini çıkarır. composeSteps ile önceden
 * çözülmüş (doğru pivot + zincirlenmiş eksen) ops varsa onu kullanır — gerçek
 * panel dönüşüyle bire bir eşleşir. Pivot ve axis DÜNYA koordinatlarında.
 */
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

/**
 * Bir kardeş panelin bu yüz düzlemindeki ayak izi — TÜM BAĞLANTISIZ PARÇALAR
 * (çentikli kardeş yüze birden fazla ayrık şeritle değebilir). Yüze hiç değmiyorsa null.
 */
function panelFootprintsInParentLocal(
  panel: any, parentWorldToLocal: THREE.Matrix4, nrm: THREE.Vector3, planeN: number, u: THREE.Vector3, v: THREE.Vector3, tol = 3.0
): Point2D[][] | null {
  if (!panel?.geometry) return null;
  const pos = panel.geometry.getAttribute('position');
  if (!pos) return null;
  const M = new THREE.Matrix4().multiplyMatrices(parentWorldToLocal, getShapeMatrix(panel));
  // TAM SİLUET vs GERÇEK KESİT: __isRotatedPanel yolu tüm köşelerin konveks
  // gövdesini alır (sentetik damga için doğru). Motorun yazdığı GERÇEK dönmüş
  // geometride (__rotatedRealGeom) siluet, yüze yalnız KENARIYLA değen panelde
  // yüzün yarısını "dolu" gösteriyordu (yakalama 600x21 şerit, regen 600x411
  // siluet → bölge öbür tarafa savruldu). Bölge hesabında engel, panelin yüze
  // DEĞEN alanıdır, gölgesi değil.
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
  // DÜZLEME-DEĞME KONTROLÜ: tüm köşeler düzlemin AYNI tarafında ve tolerans
  // dışındaysa ayak izi YOK (paralel/uzak kardeş; extrude'lu üst panel kendine
  // paralel alt panelin yüzünü siluetiyle kaplamasın).
  if (dMin > tol || dMax < -tol) return null;
  const out: Point2D[] = [];
  let flatVertCount = 0;
  for (let i = 0; i < pts.length; i++) if (Math.abs(d[i]) < tol) { out.push(uv(pts[i], u, v)); flatVertCount++; }
  // DÖNMÜŞ (sentetik) DAMGA: composeSteps'ten çözülmüş ops köşelere uygulanır, tüm köşeler izdüşürülür (tam siluet).
  if (isRotated) {
    const localOps = buildRotationOpsFromPanel(panel).map(op => ({
      kind: op.kind || 'rotate',
      pivot: op.pivot ? op.pivot.clone().applyMatrix4(parentWorldToLocal) : undefined,
      axis: op.axis ? op.axis.clone().transformDirection(parentWorldToLocal).normalize() : undefined,
      angleRad: op.angleRad || 0,
      // ÖTELEME VEKTÖRÜ NORMALİZE EDİLMEZ (transformDirection birim döndürür → −122mm taşıma 1mm'ye iniyordu).
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
    // TAŞINMIŞ DAMGA DÜZLEME DEĞMİYORSA İZ YOK: değme kapısı adımlar SONRASI yeniden sınanır (hayalet iz olmasın).
    if (localOps.some(op => op.kind === 'translate' && op.d && op.d.lengthSq() > 1e-6)) {
      let mn = Infinity, mx = -Infinity;
      for (const q of moved) { const dd = q.dot(nrm) - planeN; if (dd < mn) mn = dd; if (dd > mx) mx = dd; }
      if (mn > tol || mx < -tol) return null;
    }
    if (moved.length < 3) return null;
    const hull = convexHull2D(moved.map(v3 => uv(v3, u, v)));
    return hull.length >= 3 ? [hull] : null;
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
        out.push(uv(new THREE.Vector3().lerpVectors(pts[a], pts[b], sT), u, v));
      }
    }
  }
  if (out.length < 3) return null;
  // İçbükey sınır çıkarımı: düzlem-üstü üçgenlerin kenar-halkası — ÇOK PARÇALI
  // TEMAS: çentikli kardeş ayrık şeritlerle değiyorsa hepsi döner; dejenere halkalar elenir.
  const bEdges = onPlaneBoundaryEdges(panel.geometry, d.map(dd => Math.abs(dd) < tol), i => uv(pts[i], u, v));
  if (bEdges.length >= 3) {
    const good = walkBoundaryLoops(bEdges, true).filter(l => l.length >= 3 && Math.abs(signedArea2(l)) / 2 > 1.0);
    // YÖN NORMALİZASYONU: halka yönü mesh sarımından gelir (OCC mesh'i ile sentetik
    // damga prizması ters sarılabilir). Kırpma (clipByFootprint: cross2<0 = çapa dışarıda,
    // basma-düzlemi kenar seçimi) SAAT YÖNÜNÜN TERSİNİ (pozitif alan, convexHull2D ile
    // aynı) varsayar; ters halkada "dış" kenar şeridin UZAK uzun kenarı seçiliyor ve
    // bölge dikmenin içinden geçiyordu (u 291..600 yerine 309..600).
    for (const l of good) if (signedArea2(l) < 0) l.reverse();
    if (good.length > 0) return good;
  }
  const hull = convexHull2D(out);
  if (hull.length < 3) return null;
  // SALT-KESİT KENAR-TEMASI KAPISI: dönmüş panel bu yüzü SADECE deliyorsa (yatık
  // yüzü yok: flatVertCount==0) ve kesit İNCE bir şeritse, bu engel değil
  // KENAR-TEMASIdır — yüzü ortadan bölen "duvar" gibi davranıp bölgenin yarısını
  // silmez; rebuild'de yarım-uzay/gövde kesimiyle doğru biçilir. Düz komşu 18mm
  // kenarıyla ama YATIK yüzeyle yaslanır (flatVertCount>0) → gerçek engel.
  if (pierces && flatVertCount === 0 && !isRotated) {
    const hb = bbox2(hull);
    const minSpan = Math.min(hb.x1 - hb.x0, hb.y1 - hb.y0);
    // İnce eşiği: panel geometrisinin en ince ekseni (kalınlık) + pay; bulunamazsa 40mm.
    const sz = localBboxOf(panel.geometry)!.getSize(new THREE.Vector3());
    const thinThreshold = Math.max(Math.min(sz.x, sz.y, sz.z), 18) + 12;
    if (minSpan <= thinThreshold) return null;
  }
  return [hull];
}

// ── IZGARA YARDIMCILARI ──────────────────────────────────────────────────────

/** 4-komşuluk taşkın dolumu: `free` içinde start'tan erişilen hücreler; label verilirse bileşen etiketi yazar. */
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

/** reach hücrelerinin sınırını sıralı 2B halkaya çevirir (kenar bazlı yürüyüş; en uzun halka). */
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
  // KENAR bazlı yürüyüş: dört hücrenin çapraz birleştiği köşeden halka İKİ kez geçer;
  // köşeyi "ziyaret edildi" saymak zinciri erken kesip ince şerit üretiyordu.
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

/**
 * Grid'den izlenen halkayı KAYNAK KENARLARA (yüz konturu + ayak izleri) KÖŞE
 * bazlı oturtur: her köşe toleranstaki en yakın kaynak doğrusuna izdüşürülür;
 * iki farklı yönlü doğru varsa kesişimlerine taşınır. Yinelenen/eşdoğrusal
 * köşeler atılınca merdiven basamakları tek düz köşegene çöker.
 */
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
  // Uçları tol kadar uzatılmış segmente uzaklık; aralık dışı → Infinity.
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
  // Eşdoğrusal köşeleri at (yineleyerek — basamak zinciri tek kenara çöker)
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

// KANONİK ŞERİT ÇERÇEVESİ: ayak izi hull'unun merkezi + uzun kenarına dik,
// işareti kanonikleştirilmiş birim eksen. Taraf işareti = sign(dot(P-c, p̂));
// kanonikleştirme sayesinde şerit hafif eğilse de işaret regen'ler arası karşılaştırılabilir.
/** Düz levhanın etkin kalınlığı: parametre ile geometri kutusunun en ince ekseninin büyüğü (extrude'la kalınlaşmış panel). */
function effectiveSlabThickness(panel: any): number {
  const base = panelThickness(panel);
  const box = panel?.geometry ? localBboxOf(panel.geometry) : null;
  if (!box) return base;
  const sz = box.getSize(new THREE.Vector3());
  const mn = Math.min(sz.x, sz.y, sz.z);
  return Number.isFinite(mn) && mn > 0.5 ? Math.max(base, mn) : base;
}

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

/**
 * DİKDÖRTGENSEL (RECTILINEAR) KESİN SERBEST BÖLGE: yarım-düzlem kırpması her
 * ayak izi için TEK sonsuz doğruyla keser ve İÇBÜKEY (L/U) bölgenin bir kolunu
 * siler. Yüz halkası ve engeller eksen-hizalıysa bölge koordinat-sıkıştırılmış
 * ızgarada KESİN çözülür (çapadan taşkın dolum → köşe cebi budama → tek dış
 * halka). Uygun değilse (eğik kenar, delik, çoklu halka) null.
 * `nib` = köşe cebi budama eşiği (mm); 0 → hiçbir cep budanmaz (yüzeyin şeklini al).
 */
function rectilinearFreeRegion(ring2D: Point2D[], blockers: Point2D[][], anchorPt: Point2D, nib = 25): Point2D[] | null {
  const AX = 0.05;
  if (ring2D.length < 4) return null;
  for (let k = 0; k < ring2D.length; k++) {
    const a = ring2D[k], b = ring2D[(k + 1) % ring2D.length];
    if (Math.abs(a.x - b.x) > AX && Math.abs(a.y - b.y) > AX) return null;   // halka kenarları eksen-hizalı olmalı
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
  // KÖŞE CEBİ BUDAMA: ≤NIB×≤NIB boşluk hücreleri her iki eksende de yalnız TEK
  // taraftan komşuluysa bölgeye katılmaz (18x18 tırnak/çentik olmasın); iç hücreler asla budanmaz.
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
  // Sınır kenarları (içerisi solda, CCW) — ızgara indeksleriyle; sıkışma köşesi / delik → vazgeç
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
  if (Math.sign(signedArea2(poly)) !== Math.sign(signedArea2(ring2D))) poly.reverse(); // halkayla aynı dönüş yönü
  return poly;
}

// ── DÖNMÜŞ / EĞİK PANEL TESPİTİ ──────────────────────────────────────────────

/**
 * VF-EĞİMLİ LEVHA: vertex düzenlemesiyle eğilmiş gövde yüzüne yerleşen panel.
 * Dönüş adımı yoktur ama levhası eksen-hizalı değildir; bölge hesabında ve
 * dönüş-kesiminde DÖNMÜŞ kardeş gibi ele alınır. Tespit geometriden: en büyük
 * yüz alanlı normal hiçbir dünya eksenine paralel değilse levha eğiktir.
 */
const _tiltCache = new WeakMap<object, boolean>();
export function panelIsTiltedSlab(panel: any): boolean {
  const geo = panel?.geometry;
  if (!geo || typeof geo.getAttribute !== 'function') return false;
  const hit = _tiltCache.get(geo);
  if (hit !== undefined) return hit;
  let tilted = false;
  try {
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const idx = geo.getIndex();
    const cnt = idx ? idx.count : pos.count;
    const at = (k: number) => (idx ? idx.getX(k) : k);
    const bins = new Map<string, { n: THREE.Vector3; a: number }>();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    for (let t = 0; t + 2 < cnt; t += 3) {
      a.fromBufferAttribute(pos, at(t)); b.fromBufferAttribute(pos, at(t + 1)); c.fromBufferAttribute(pos, at(t + 2));
      n.crossVectors(b.sub(a), c.sub(a));
      const area = n.length() / 2;
      if (area < 1e-6) continue;
      n.divideScalar(area * 2);
      if (n.x < 0 || (Math.abs(n.x) < 1e-6 && n.y < 0) || (Math.abs(n.x) < 1e-6 && Math.abs(n.y) < 1e-6 && n.z < 0)) n.negate();
      const key = `${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)}`;
      const e = bins.get(key);
      if (e) e.a += area; else bins.set(key, { n: n.clone(), a: area });
    }
    let best: { n: THREE.Vector3; a: number } | null = null;
    bins.forEach(e => { if (!best || e.a > best.a) best = e; });
    if (best) tilted = !isFlatNormal((best as { n: THREE.Vector3; a: number }).n, 0.999 - Number.EPSILON);
  } catch { tilted = false; }
  _tiltCache.set(geo, tilted);
  return tilted;
}

/** Panelin açısı sıfır olmayan bir DÖNÜŞ adımı var mı? VF-eğimli levhalar da dönmüş sayılır.
 *  REF DÖNÜŞ: gerçek açı resolvedValue'dadır (value donmuş yedek). */
export function panelHasRotation(panel: any): boolean {
  if (panelIsTiltedSlab(panel)) return true;
  const ops = panel?.__composedOps;
  if (Array.isArray(ops) && ops.some((o: any) => o?.kind === 'rotate' && Math.abs(o.angleRad || 0) > 1e-6)) return true;
  const ts = panel?.parameters?.transformSteps;
  const degOf = (st: any) => (typeof st?.resolvedValue === 'number' ? st.resolvedValue : (st?.value || 0));
  return Array.isArray(ts) && ts.some((st: any) => st?.type === 'rotate' && (Math.abs(degOf(st)) > 1e-6 || Math.abs(st?.value || 0) > 1e-6));
}

// ═══════════════════════════════════════════════════════════════════════════
// SERBEST BÖLGE — TEK KAYNAK, TEK UZAY, DOĞRULAMALI
//  1) Ayak izi TEK açık zincirle: panel yerel → dünya → PARENT YEREL.
//  2) Bölge, kullanıcının GÖRDÜĞÜ reach grid'inden türetilir.
//  3) Geometri tam çokgen farkından gelir (köşegen kenar tırtıksız); grid yalnız
//     KARAR verir (hangi ayak izi engelliyor, sonuç görülenle uyuşuyor mu).
//  4) Hem yakalama hem regen bu fonksiyonu çağırır → ayrışmaları imkânsız.
// ═══════════════════════════════════════════════════════════════════════════

export interface FreeRegionResult {
  u: THREE.Vector3; v: THREE.Vector3; planeN: number;
  ring2D: Point2D[]; footprints: Point2D[][]; touchingSiblingIds: string[];
  uMin: number; vMin: number; cw: number; ch: number; nx: number; ny: number;
  reach: Uint8Array; anchor: Point2D;
  /** Serbest bölgenin kaynak kenarlara oturtulmuş konturu (yerel u/v). */
  polygon: Point2D[];
  /** Her ayak izinin sahibi: panel id (ilk parça) ya da `${id}#k` (ek parçalar). */
  footprintIds: (string | null)[];
  /** KALICI BAĞ İLİŞKİSİ: seçilen bölgenin her kardeş ayak izinin kanonik dik
   *  eksenine göre tarafı (kardeşPanelId → ±1). VF'de saklanır, regen'e geri geçer. */
  sideRelations: Record<string, number>;
}

/**
 * @param prevRegionCorners BÖLGE SÜREKLİLİĞİ (yalnız regen): önceki VF çokgeni —
 *   dönmüş kardeş şeridi sabit seed'in üstünden süpürülünce bölge taraf değiştirmesin;
 *   önceki bölgeyle EN ÇOK örtüşen bileşen seçilir.
 * @param storedSideRelations KALICI BAĞ İLİŞKİSİ (öncelik: ilişki > süreklilik > seed):
 *   panel hep ilk temas ettiği tarafa bağlı kalır; o taraf yok olursa yeniden çözülür.
 * @param fitFaceShape YÜZEYİN ŞEKLİNİ AL: sonuç, çapadan taşkın dolan serbest bölgenin
 *   TAM şekli; false = mevcut davranış birebir (yakalama yolu bunları geçmez).
 */
export function computeFreeRegionLocal(
  contourCorners: THREE.Vector3[], normalLocal: THREE.Vector3, seedLocal: THREE.Vector3,
  siblingPanels: any[], parentWorldToLocal: THREE.Matrix4, parentShapeId?: string,
  prevRegionCorners?: THREE.Vector3[], storedSideRelations?: Record<string, number>, fitFaceShape?: boolean
): FreeRegionResult | null {
  if (contourCorners.length < 3) return null;
  const nrm = normalLocal.clone().normalize();
  const { u, v } = getFacePlaneAxes(nrm);
  const ring2D = contourCorners.map(c => uv(c, u, v));
  const planeN = contourCorners[0].dot(nrm);

  const footprints: Point2D[][] = [];
  const fpRotated: boolean[] = [];
  const fpIds: (string | null)[] = [];
  // KALINLIK ŞERİDİ: bu yüzü DİK kesen düz kardeşin ayak izi (kısa kenar ≈ kalınlık).
  // Basan panelin "basma düzlemi" şeridin UZUN kenarıdır; kısa kenar panelin UCUDUR.
  const fpStrip: boolean[] = [];
  const touchingSiblingIds: string[] = [];
  for (const panel of siblingPanels) {
    if (parentShapeId && panel?.parameters?.parentShapeId && panel.parameters.parentShapeId !== parentShapeId) continue;
    // ÇOK PARÇALI AYAK İZİ: her parça ayrı engel; tek parçalı kardeşte liste tek elemanlı.
    const pieces = panelFootprintsInParentLocal(panel, parentWorldToLocal, nrm, planeN, u, v);
    if (!pieces || pieces.length === 0) continue;
    const rotated = panelHasRotation(panel);
    // GERÇEK KALINLIK: kalınlığı extrude ile değişmiş panelde (18→100) parametre değil, geometrinin
    // (damga prizması / motor mesh'i) en ince ekseni — yoksa 100 mm'lik raf izi "şerit" sayılmaz,
    // basma-düzlemi kesimi düşer ve basılan panelin bölgesi rafın içinden geçerdi.
    const th = effectiveSlabThickness(panel);
    if (pieces.length > 1) console.log('[YAGO][AYAKİZİ][ÇOK-PARÇA]', panel?.id, 'parçaN=', pieces.length, pieces.map(pc => fmtBox2(bbox2(pc))).join(' | '));
    pieces.forEach((fp, k) => {
      footprints.push(fp);
      const b = bbox2(fp);
      const mn = Math.min(b.x1 - b.x0, b.y1 - b.y0), mx = Math.max(b.x1 - b.x0, b.y1 - b.y0);
      fpStrip.push(mn <= th * 1.5 + 0.5 && mx >= 2 * mn);
      // GERÇEKTEN DÖNMÜŞ kardeş: uzak-teğet kırpması AÇIK — bölge şeridin içinden geçer,
      // PanelEngine'deki DÖNÜŞ-KESİMİ kalınlık kenarını gerçek eğik düzleme biçer.
      fpRotated.push(rotated);
      // BAĞ-İLİŞKİSİ ANAHTARI: ilk parça eski anahtarı (panel id) korur; ek parçalar `${id}#k`.
      const pid = panel?.id ?? null;
      fpIds.push(pid ? (k === 0 ? pid : `${pid}#${k}`) : null);
    });
    if (panel.id) touchingSiblingIds.push(panel.id);
  }

  return solveFreeRegionMemo({
    ring2D, nrm, u, v, planeN, footprints, fpRotated, fpIds, fpStrip, touchingSiblingIds,
    seedU: seedLocal.dot(u), seedV: seedLocal.dot(v),
    prev2D: prevRegionCorners && prevRegionCorners.length >= 3 ? prevRegionCorners.map(c => uv(c, u, v)) : undefined,
    storedSideRelations, fitFaceShape: !!fitFaceShape,
  });
}

interface FreeRegionInput {
  ring2D: Point2D[]; nrm: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3; planeN: number;
  footprints: Point2D[][]; fpRotated: boolean[]; fpIds: (string | null)[]; fpStrip: boolean[];
  touchingSiblingIds: string[]; seedU: number; seedV: number; prev2D?: Point2D[];
  storedSideRelations?: Record<string, number>; fitFaceShape: boolean;
}

// SERBEST BÖLGE ÇÖZÜM ÖNBELLEĞİ: çözüm girdilerin SAF fonksiyonudur; rebuild her
// panelden sonra tüm VF'leri yeniden hesapladığından aynı girdi defalarca çözülüyordu.
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

/**
 * UZAK-TEĞET KIRPMA ÇİZGİSİ: (a→b) kenarını, çapadan uzağa bakan normal boyunca
 * hull'un en uzak noktasına kadar öteler — 1mm İÇİ (eskiden +0.5mm dışına
 * kırpılıyordu ve dönüş-kesimi dışarıda kalan şeridi temizlemediğinden eğime
 * paralel kıymık kalıyordu). Bölge şeridin İÇİNDE biter; alt yüzey kesimi temizler.
 */
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

  // Hücre merkezleri + yüz-içi maskesi bir kez hesaplanır (tüm geçişler paylaşır).
  const PX = new Float64Array(nx), PY = new Float64Array(ny);
  for (let i = 0; i < nx; i++) PX[i] = uMin + (i + 0.5) * cw;
  for (let j = 0; j < ny; j++) PY[j] = vMin + (j + 0.5) * ch;
  const pipRing = makePip(ring2D);
  const inRing = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (pipRing(PX[i], PY[j])) inRing[j * nx + i] = 1;
  const fpPips = footprints.map(makePip);
  /** Yüz içi ve verilen engellerin hiçbirine girmeyen hücreler. */
  const freeMask = (pips: Array<(x: number, y: number) => boolean>) => {
    const m = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (inRing[j * nx + i] && !pips.some(pip => pip(PX[i], PY[j]))) m[j * nx + i] = 1;
    }
    return m;
  };
  const free = freeMask(fpPips);
  /** pred'i sağlayan serbest hücreler içinde (ti,tj)'ye en yakını; yoksa [-1,-1]. */
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

  // ── ÖNCELİK 1: YARI-DÜZLEM KISITLARI ──────────────────────────────────────
  // Kayıtlı taraf işaretleri varsa onlar, YOKSA seed konumundan türetilen taraf
  // işaretleri kullanılır: engel regen'ler arası ne kadar sıçrarsa sıçrasın panel
  // hep kısıt tarafında kalır. Kısıt kümesi boşsa sezgisel katmanlara düşülür.
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
        if (bi !== ci || bj !== cj) {
          console.log('[YAGO][BÖLGE] bağ-ilişkisi: çapa kayıtlı tarafa zorlandı. kısıtN=', constraints.length,
            'kayıtlıTaraf=', constraints.map(k => k.sign).join(','), 'çapa(', bi, ',', bj, ') seed(', ci, ',', cj, ')');
        }
        ci = bi; cj = bj;
        relationChosen = true;
      } else {
        // Kayıtlı tarafta seed'e yakın serbest hücre yok; taraf sözleşmesi MUTLAKTIR:
        // kayıtlı tarafı sağlayan serbest hücrelerin merkezine en yakın hücreye gidilir.
        let sumI = 0, sumJ = 0, cnt = 0;
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (free[j * nx + i] && satisfies(i, j)) { sumI += i; sumJ += j; cnt++; }
        const [fbi, fbj, fbCount] = cnt > 0 ? nearestFree(sumI / cnt, sumJ / cnt, satisfies) : [-1, -1, 0];
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

  // ── ÖNCELİK 2: BÖLGE SÜREKLİLİĞİ (önceki VF ile örtüşme) ──────────────────
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
        const [si, sj] = cellOf(cu, cv);
        if (label[sj * nx + si] !== bl) console.log('[YAGO][BÖLGE] süreklilik: seed karşı bileşende kaldı, önceki bölgeyle örtüşen bileşen seçildi. örtüşme=', bo);
      }
    } else if (nComp === 1 && footprints.length > 0) {
      // TEK BAĞLANTILI SÜREKLİLİK: şerit yüz kenarına ulaşmayıp boşluk bıraktığında
      // bölge tek bileşen kalır; kırpma tarafını ÇAPA belirler → çapa ÖNCEKİ
      // BÖLGENİN AĞIRLIK MERKEZİNE en yakın serbest hücreye taşınır.
      let pcx = 0, pcy = 0;
      for (const p of prev2D) { pcx += p.x; pcy += p.y; }
      const [pi, pj] = cellOf(pcx / prev2D.length, pcy / prev2D.length);
      const [bi, bj] = nearestFree(pi, pj, (i, j) => isPointInsidePolygon(cellPt(i, j), prev2D));
      if (bi >= 0) {
        if (bi !== ci || bj !== cj) console.log('[YAGO][BÖLGE] süreklilik(bağlantılı): çapa önceki bölge merkezine taşındı.');
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

  // ── GEOMETRİ: TAM ÇOKGEN FARKI (grid DEĞİL) ──────────────────────────────
  // Grid yalnız KARAR verir: (a) hangi ayak izi engelliyor, (b) sonuç görülenle uyuşuyor mu.
  // ENGEL = çapanın ERİŞTİĞİ bölgeye (reach) BİTİŞİK ayak izi. Yüzün başka yerindeki
  // bir iz (ör. dikmenin ÖBÜR tarafındaki raf) engel değildir: yarım-düzlem kırpımı
  // sonsuz olduğu için o rafın çizgisi bu bölmeye taşınıyor, sol gövde paneli sağ
  // raf varmış gibi kısa çıkıyordu (Goker: "dikmenin sol tarafında raf olmamasına
  // rağmen o body panel de raf varmış gibi kısa çıktı"). Bitişiklik: reach 1 hücre
  // genişletilir (8-komşuluk); izin içindeki hücreler serbest olmadığından reach'e
  // girmez, sınır hücreleri genişletmeyle yakalanır.
  const nearReach = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!reach[j * nx + i]) continue;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const a = i + di, b = j + dj;
      if (a >= 0 && b >= 0 && a < nx && b < ny) nearReach[b * nx + a] = 1;
    }
  }
  const blocking: Point2D[][] = [], blockingRotated: boolean[] = [], blockingStrip: boolean[] = [];
  const farIds: string[] = [];
  for (let f = 0; f < footprints.length; f++) {
    const pip = fpPips[f];
    let blocks = false, onFace = false;
    for (let j = 0; j < ny && !blocks; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!inRing[k] || !pip(PX[i], PY[j])) continue;
      onFace = true;
      if (nearReach[k]) { blocks = true; break; }
    }
    if (blocks) { blocking.push(footprints[f]); blockingRotated.push(fpRotated[f]); blockingStrip.push(fpStrip[f]); }
    else if (onFace) farIds.push(fpIds[f] || `#${f}`);
  }
  if (farIds.length) console.log('[YAGO][BÖLGE] bölgeye bitişik olmayan izler engel sayılmadı (başka bölme):', farIds.join(', '));

  const anchorPt = cellPt(ci, cj);
  // Dönmüş engel şeridi içindeki hücreler (taşma sayılmaz) — bir kez.
  const rotPips = blocking.map((fp, f) => (blockingRotated[f] ? makePip(fp) : null)).filter(Boolean) as Array<(x: number, y: number) => boolean>;
  const inRot = new Uint8Array(nx * ny);
  if (rotPips.length) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    for (const pip of rotPips) if (pip(PX[i], PY[j])) { inRot[j * nx + i] = 1; break; }
  }
  // Aday çokgenin reach ızgarasına göre sayımı (keep/bad).
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
      // DÖNMÜŞ KARDEŞ: kırpma çizgisi şeridin UZAK teğetine ötelenir (bölge şeridin içinden geçer).
      if (rotated) [a, b] = farTangentEdge(fp, a, b, anchorPt);
      const cand = clipByHalfPlane(poly, a, b);
      const sc = scoreOf(cand);
      if (sc > bestScore) { bestScore = sc; best = cand; }
    }
    return best && best.length >= 3 ? best : null;
  };

  // ── BASMA DÜZLEMİ TERCİHİ (mod-kapalı sözleşmesi) ─────────────────────────
  // KURAL: basan panel, basılanı BÜYÜK YÜZÜNÜN düzlemiyle (şeridin uzun kenarı)
  // keser — ucuyla değil (kısaltılmış+taşınmış üst panelin yan yüzdeki 100×18
  // şeridi "en çok alan koruyan" uç kenarla kesilince yan panel üstün ÜSTÜNDEN de
  // devam ediyordu — o davranış yalnız "yüzeyin şeklini al" AÇIKKEN istenir).
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
      if (pressEdges) {
        pressedCutApplied = true;
        console.log('[YAGO][BÖLGE][BASMA-DÜZLEMİ]', 'şerit ayak izi uzun kenarıyla (büyük yüz düzlemi) kesildi; uç kenarı yok sayıldı. köşeN=', exact.length);
      }
    }
  }

  // ── DOĞRULAMA: sonuç, kullanıcının GÖRDÜĞÜ reach hücreleriyle uyuşmalı ──
  let polygon = ring2D;
  // İÇBÜKEY BÖLGE KURTARMA: yarım-düzlem sonucu reach'in belirgin kısmını kaybettiyse
  // (L/U: bir kol silindi) ve geometri eksen-hizalıysa KESİN dikdörtgensel bölge denenir.
  // BASMA DÜZLEMİ + DİKDÖRTGEN YÜZ: kurtarma bilerek atlanır (basanın altındaki hücreler
  // bilerek kaybedilmiştir; kurtarma paneli basanın etrafına sardırırdı).
  const skipConcaveRecovery = pressedCutApplied && isConvexPolygon2D(ring2D);
  if (skipConcaveRecovery) console.log('[YAGO][BÖLGE] içbükey kurtarma atlandı: basma düzlemi kesimi + dikdörtgen yüz (mod kapalı)');
  if (exact.length >= 3 && blocking.length > 0 && !blockingRotated.some(Boolean) && !skipConcaveRecovery) {
    const hp = scorePoly(exact);
    if (hp.cover < 0.95) {
      const rl = rectilinearFreeRegion(ring2D, blocking, anchorPt);
      if (rl) {
        const rs = scorePoly(rl);
        const accepted = rs.cover >= 0.9 && rs.leak <= 0.1 && rs.cover > hp.cover;
        console.log('[YAGO][BÖLGE] içbükey bölge: yarım-düzlem kapsama=', hp.cover.toFixed(2), '→ dikdörtgensel köşeN=', rl.length,
          'kapsama=', rs.cover.toFixed(2), 'taşma=', rs.leak.toFixed(2), accepted ? 'KABUL' : 'RED');
        if (accepted) exact = rl;
      }
    }
  }

  if (exact.length >= 3 && blocking.length > 0) {
    let total = 0;
    for (let k = 0; k < nx * ny; k++) if (reach[k]) total++;
    const { cover, leak } = scorePoly(exact);
    // Tek-bileşenli süreklilikte reach HER İKİ tarafı da kapsar; basma düzlemi kesimi de
    // reach'in bir kısmını BİLEREK bırakır → kapsama eşiği gevşetilir, taşma sınırı kalır.
    const coverMin = (continuityConnected || relationChosen || pressedCutApplied) ? 0.25 : 0.9;
    if (total > 0 && cover >= coverMin && leak <= 0.1) polygon = exact;
    else {
      // GÜVENLİ YEDEK: tam kontur DEĞİL (kardeş izlerini yok sayıp panelin yan panellerin
      // içine girmesini garanti ediyordu); çapayı içeren, engelleyen ayak izlerine hiç
      // girmeyen eksen-hizalı en geniş dikdörtgen.
      let rx0 = rb.x0, rx1 = rb.x1, ry0 = rb.y0, ry1 = rb.y1;
      const EPS = 1e-6;
      for (let f = 0; f < blocking.length; f++) {
        if (blockingRotated[f]) continue;            // dönmüş şerit: açılı, dikdörtgen kırpmaya uygun değil
        const fb = bbox2(blocking[f]);
        if (anchorPt.y > fb.y0 - EPS && anchorPt.y < fb.y1 + EPS) {       // çapanın SATIRINI kesiyor
          if (fb.x1 <= anchorPt.x + EPS && fb.x1 > rx0) rx0 = fb.x1;
          if (fb.x0 >= anchorPt.x - EPS && fb.x0 < rx1) rx1 = fb.x0;
        }
        if (anchorPt.x > fb.x0 - EPS && anchorPt.x < fb.x1 + EPS) {       // çapanın SÜTUNUNU kesiyor
          if (fb.y1 <= anchorPt.y + EPS && fb.y1 > ry0) ry0 = fb.y1;
          if (fb.y0 >= anchorPt.y - EPS && fb.y0 < ry1) ry1 = fb.y0;
        }
      }
      if (rx1 - rx0 > 0.5 && ry1 - ry0 > 0.5) {
        const rect: Point2D[] = [{ x: rx0, y: ry0 }, { x: rx1, y: ry0 }, { x: rx1, y: ry1 }, { x: rx0, y: ry1 }];
        const rs = scorePoly(rect);
        // ADAY SEÇİMİ: taşmayan adaylar arasında kapsaması en yüksek olan; kırpılmış
        // poligon taşmıyorsa dar dikdörtgen tercih edilmez (alakasız paneller kısalmasın).
        const exactSafe = leak <= 0.1 && exact.length >= 3;
        if (exactSafe && (!(rs.leak <= 0.1) || cover >= rs.cover)) {
          polygon = exact;
          console.warn('[YAGO][BÖLGE] doğrulama düştü → kırpılmış poligon korundu (taşma yok)', { kapsama: cover.toFixed(2), taşma: leak.toFixed(2), dikdörtgenKapsama: rs.cover.toFixed(2) });
        } else {
          polygon = rect;
          console.warn('[YAGO][BÖLGE] doğrulama düştü → güvenli serbest dikdörtgen',
            { kapsama: cover.toFixed(2), taşma: leak.toFixed(2), yeniKapsama: rs.cover.toFixed(2), u: `${rx0.toFixed(0)}..${rx1.toFixed(0)}`, v: `${ry0.toFixed(0)}..${ry1.toFixed(0)}` });
        }
      } else {
        console.warn('[YAGO][BÖLGE] çokgen grid ile uyuşmadı, tam kontur kullanıldı', { kapsama: cover.toFixed(2), taşma: leak.toFixed(2), köşeN: exact.length });
      }
    }
  }

  // ── YÜZEYİN ŞEKLİNİ AL (fitFaceShape) ────────────────────────────────────
  // Mod AÇIKKEN panel, çapadan taşarak dolan serbest bölgenin TAMAMINI alır (L/U/
  // çentikli şekli izler, kısa kardeşin etrafını sarar). Düz engeller: eksen-hizalıysa
  // KESİN çözüm (cep budama KAPALI), değilse grid taşkın dolumu izlenip kaynak
  // kenarlara oturtulur. Dönmüş engeller: uzak-teğet sözleşmesi aynen. Sonuç reach
  // ile doğrulanır; geçmezse mod-kapalı sonuç kalır.
  if (fitFaceShape) {
    const straight: Point2D[][] = [], rotatedFps: Point2D[][] = [];
    for (let f = 0; f < blocking.length; f++) (blockingRotated[f] ? rotatedFps : straight).push(blocking[f]);
    let shapePoly: Point2D[] | null = straight.length === 0 ? ring2D.map(p => ({ ...p })) : rectilinearFreeRegion(ring2D, straight, anchorPt, 0);
    let shapeSrc = straight.length === 0 ? 'tam-kontur' : 'dikdörtgensel-kesin';
    if (!shapePoly) {
      // GENEL YOL: eğik yüz konturu / eksen-hizasız düz engel. Dönmüş şeritler engel SAYILMAZ.
      const free2 = freeMask(straight.map(makePip));
      const reach2 = new Uint8Array(nx * ny);
      if (free2[cj * nx + ci]) flood4(free2, nx, ny, cj * nx + ci, reach2);
      const traced = traceReachBoundary(reach2, nx, ny, uMin, vMin, cw, ch);
      if (traced.length >= 3) { shapePoly = fitTracedPolygonToSources(traced, [ring2D, ...straight], Math.max(cw, ch) * 1.6); shapeSrc = 'grid-izleme'; }
    }
    if (shapePoly && shapePoly.length >= 3) {
      for (const fp of rotatedFps) { const best = clipByFootprint(shapePoly, fp, true); if (best) shapePoly = best; }
      const ss = scorePoly(shapePoly);
      const okShape = ss.leak <= 0.1 && ss.cover >= 0.9;
      console.log('[YAGO][BÖLGE][YÜZ-ŞEKLİ]', okShape ? 'KABUL' : 'RED', 'kaynak=', shapeSrc, 'köşeN=', shapePoly.length,
        'düzEngelN=', straight.length, 'dönmüşEngelN=', rotatedFps.length, 'kapsama=', ss.cover.toFixed(2), 'taşma=', ss.leak.toFixed(2), okShape ? '' : '→ mod-kapalı sonuç korundu');
      if (okShape) polygon = shapePoly;
    } else {
      console.warn('[YAGO][BÖLGE][YÜZ-ŞEKLİ] şekil poligonu üretilemedi → mod-kapalı sonuç korundu');
    }
  }

  // KALICI BAĞ İLİŞKİSİ ÇIKIŞI: nihai çapanın her kardeş ayak izine göre taraf işareti.
  const finalAnchor = cellPt(ci, cj);
  const sideRelations: Record<string, number> = {};
  for (let f = 0; f < footprints.length; f++) {
    const id = fpIds[f];
    if (!id) continue;
    const s = stripSide(finalAnchor, canonicalStripFrame(footprints[f]));
    if (Math.abs(s) > 1e-6) sideRelations[id] = s > 0 ? 1 : -1;
  }

  return { u, v, planeN, ring2D, footprints, footprintIds: fpIds, touchingSiblingIds, uMin, vMin, cw, ch, nx, ny, reach, anchor: finalAnchor, polygon, sideRelations };
}
