import * as THREE from 'three';
import { useAppStore, type Shape, type VirtualFace, type PanelGroup, type GapSpec, type CavityBox, type CavityPick } from '../store';
import { effectiveBodyGeometry, vertexModsKey } from './VertexEditorService';
import { getFacesAndGroups } from './GeometryUtils';
import type { Vec3 } from './PanelMath';

// ═══════════════════════════════════════════════════════════════════════════
// RAF / DİKME GRUPLARI (PanelGroupService)
//
// SÖZLEŞME
//  • Grup = seçilen ŞEKİLLİ HACİM (serbest bölge) + n panel + n+1 boşluk.
//    Hacim bir kutu DEĞİLDİR: gövde kutusu, gövde katısının eksen-hizalı yüz
//    düzlemleri ve kardeş panel kutularının düzlemleriyle hücrelere bölünür
//    (CavityGrid); bir hücre gövde katısının İÇİNDE ve hiçbir panelin içinde
//    değilse serbesttir. Tohumdan (çıpa) yüz-komşu serbest hücrelere taşılarak
//    bağlantılı bölge bulunur (floodRegion). Çentikli/çıkarmalı gövdede bölge
//    L/U/çentikli olur; her raf KENDİ yüksekliğindeki kesitin (dilim boyunca
//    tüm katmanlarda serbest hücrelerin) sınır çokgenini alır (sectionPolygon).
//  • Çıpa (anchorFrac) tohum noktasıdır (kutu merkezi değil — L bölgede merkez
//    dışarıda kalabilir); küp boyutlanınca oransal kayar, hücre serbest değilse
//    en yakın serbest hücreye düşer.
//  • Boşluk kuralı: ilk dağılım EŞİT. Bir boşluk girilince fark, kilitsiz ve
//    henüz girilmemiş boşluklara eşit dağılır. Küp boyutlanınca KİLİTLİ boşluk
//    sabit kalır; kilitsizler oranları korunarak yeni açıklığa ölçeklenir:
//    Σgap + n·t = L (bölge kutusunun dizilim eksenindeki açıklığı).
//  • İç paneller (raf/dikme) GÖVDE PANELLERİNİ ASLA BASMAZ; gövde panelleri
//    her sırada iç grupları sınırlar; bir iç grup yalnız KENDİNDEN ÖNCE
//    oluşturulmuş iç grupların panelleriyle sınırlanır (döngü yok).
//  • Üye paneller sıradan VF-panelleridir: extrude / move / rotate adımları
//    motorda aynı yoldan uygulanır; VF (çözülmüş kesit) her rebuild'de yazılır.
// ═══════════════════════════════════════════════════════════════════════════

export const GROUP_PANEL_THICKNESS = 18;
const TOL = 0.5;
const MIN_GAP = 0;

export const isInteriorPanel = (p: any): boolean => !!p?.parameters?.panelGroupId;
export const isInteriorVf = (vf: any): boolean => !!vf?.interior;
export const groupKindLabel = (k: PanelGroup['kind']) => (k === 'shelf' ? 'Shelf' : 'Divider');
export const groupAxisOf = (k: PanelGroup['kind']): 0 | 1 | 2 => (k === 'shelf' ? 1 : 0);

const genId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
const r1 = (v: number) => Math.round(v * 10) / 10;
const cloneBox = (b: CavityBox): CavityBox => ({ min: [...b.min] as Vec3, max: [...b.max] as Vec3 });
export const boxSpan = (b: CavityBox, a: number) => b.max[a] - b.min[a];
export const fmtBox = (b: CavityBox) => `${b.min.map(n => n.toFixed(0)).join(',')}..${b.max.map(n => n.toFixed(0)).join(',')}`;
type Pt2 = { x: number; y: number };

// ── KUTULAR ─────────────────────────────────────────────────────────────────

/** Gövdenin (vertex düzenlemeli etkin) yerel sınır kutusu. */
export function bodyLocalBox(parent: Shape): CavityBox | null {
  const geo = effectiveBodyGeometry(parent);
  const pos = geo?.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) return null;
  const bb = new THREE.Box3().setFromBufferAttribute(pos);
  return { min: [bb.min.x, bb.min.y, bb.min.z], max: [bb.max.x, bb.max.y, bb.max.z] };
}

/** Panelin gövde-yerel kutusu (geometri gövde çerçevesindedir; konum farkı eklenir). */
export function panelLocalBox(p: Shape, parent: Shape): CavityBox | null {
  const pos = p.geometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos || pos.count === 0) return null;
  const bb = new THREE.Box3().setFromBufferAttribute(pos);
  const d = [0, 1, 2].map(i => (p.position?.[i] ?? 0) - (parent.position?.[i] ?? 0));
  return { min: [bb.min.x + d[0], bb.min.y + d[1], bb.min.z + d[2]], max: [bb.max.x + d[0], bb.max.y + d[1], bb.max.z + d[2]] };
}

// ── HÜCRE IZGARASI (CavityGrid) ─────────────────────────────────────────────

export interface CavityGrid {
  body: CavityBox;
  xs: number[]; ys: number[]; zs: number[];
  nx: number; ny: number; nz: number;
  /** 1 = serbest (gövde içinde, panel dışında). */
  free: Uint8Array;
}
const cellIndex = (g: CavityGrid, i: number, j: number, k: number) => (k * g.ny + j) * g.nx + i;
const cellIJK = (g: CavityGrid, c: number): [number, number, number] => [c % g.nx, Math.floor(c / g.nx) % g.ny, Math.floor(c / (g.nx * g.ny))];
const axisPlanes = (g: CavityGrid, a: number) => (a === 0 ? g.xs : a === 1 ? g.ys : g.zs);
const cellBox = (g: CavityGrid, c: number): CavityBox => {
  const [i, j, k] = cellIJK(g, c);
  return { min: [g.xs[i], g.ys[j], g.zs[k]], max: [g.xs[i + 1], g.ys[j + 1], g.zs[k + 1]] };
};

function uniqSorted(vals: number[], lo: number, hi: number): number[] {
  const v = vals.filter(x => x > lo + TOL && x < hi - TOL).sort((a, b) => a - b);
  const out: number[] = [lo];
  for (const x of v) if (x - out[out.length - 1] > TOL) out.push(x);
  if (hi - out[out.length - 1] > TOL) out.push(hi); else out[out.length - 1] = hi;
  return out;
}

/** Nokta kapalı mesh'in içinde mi (ışın pariteси, eğik ışın dejenere durumları önler). */
function makeInsideMeshTest(geo: THREE.BufferGeometry): (p: Vec3) => boolean {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const idx = geo.getIndex();
  const n = idx ? idx.count : pos.count;
  const tri = new Float64Array(n * 3);
  for (let t = 0; t < n; t++) {
    const vi = idx ? idx.getX(t) : t;
    tri[t * 3] = pos.getX(vi); tri[t * 3 + 1] = pos.getY(vi); tri[t * 3 + 2] = pos.getZ(vi);
  }
  const d = [0.8931, 0.3117, 0.3243]; // birim-yakın, eksenlere eğik
  return (p: Vec3) => {
    let hits = 0;
    for (let t = 0; t < n; t += 3) {
      const ax = tri[t * 3], ay = tri[t * 3 + 1], az = tri[t * 3 + 2];
      const e1x = tri[t * 3 + 3] - ax, e1y = tri[t * 3 + 4] - ay, e1z = tri[t * 3 + 5] - az;
      const e2x = tri[t * 3 + 6] - ax, e2y = tri[t * 3 + 7] - ay, e2z = tri[t * 3 + 8] - az;
      const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det;
      const tx = p[0] - ax, ty = p[1] - ay, tz = p[2] - az;
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (tt > 1e-9) hits++;
    }
    return (hits & 1) === 1;
  };
}

const _gridCache = new Map<string, CavityGrid>();
const boxesKey = (bs: CavityBox[]) => bs.map(b => [...b.min, ...b.max].map(n => Math.round(n * 10)).join(',')).sort().join(';');

/**
 * IZGARA: gövde kutusu + gövde katısının eksen-hizalı yüz düzlemleri + engel
 * (panel) kutularının düzlemleri → hücreler. Hücre merkezi gövde katısının
 * içinde (kutu-dışı gövdede mesh parite testi) ve hiçbir engelin içinde
 * değilse serbesttir. Geometri × engeller başına önbellek.
 */
export function buildCavityGrid(parent: Shape, obstacles: CavityBox[]): CavityGrid | null {
  const geo = effectiveBodyGeometry(parent);
  const body = bodyLocalBox(parent);
  if (!geo || !body) return null;
  const key = `${geo.uuid}|${vertexModsKey(parent.vertexModifications || [])}|${boxesKey(obstacles)}`;
  const hit = _gridCache.get(key);
  if (hit) return hit;

  const { groups } = getFacesAndGroups(geo);
  const px: number[] = [], py: number[] = [], pz: number[] = [];
  let axisFaces = 0;
  for (const g of groups) {
    const n = g.normal;
    if (Math.abs(n.x) > 0.999) { px.push(g.center.x); axisFaces++; }
    else if (Math.abs(n.y) > 0.999) { py.push(g.center.y); axisFaces++; }
    else if (Math.abs(n.z) > 0.999) { pz.push(g.center.z); axisFaces++; }
  }
  for (const o of obstacles) { px.push(o.min[0], o.max[0]); py.push(o.min[1], o.max[1]); pz.push(o.min[2], o.max[2]); }
  const xs = uniqSorted(px, body.min[0], body.max[0]);
  const ys = uniqSorted(py, body.min[1], body.max[1]);
  const zs = uniqSorted(pz, body.min[2], body.max[2]);
  const nx = xs.length - 1, ny = ys.length - 1, nz = zs.length - 1;
  const grid: CavityGrid = { body, xs, ys, zs, nx, ny, nz, free: new Uint8Array(nx * ny * nz) };
  // Düz kutu gövde (6 eksen yüzü, ek düzlem yok) → merkez testi gerekmez.
  const plainBox = groups.length === 6 && axisFaces === 6 && !(parent.vertexModifications?.length) && !(parent.subtractionGeometries?.some(Boolean)) && !(parent.fillets?.length);
  const inside = plainBox ? null : makeInsideMeshTest(geo);
  const inObstacle = (c: Vec3) => obstacles.some(o =>
    c[0] > o.min[0] && c[0] < o.max[0] && c[1] > o.min[1] && c[1] < o.max[1] && c[2] > o.min[2] && c[2] < o.max[2]);
  let freeN = 0;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c: Vec3 = [(xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2, (zs[k] + zs[k + 1]) / 2];
    if (inObstacle(c)) continue;
    if (inside && !inside(c)) continue;
    grid.free[cellIndex(grid, i, j, k)] = 1; freeN++;
  }
  console.log('[YAGO][HACİM-IZGARA]', parent.id, `hücre=${nx}x${ny}x${nz}`, 'serbest=', freeN, plainBox ? '(düz kutu)' : '(gövde katısı mesh testi)', 'engelN=', obstacles.length);
  if (_gridCache.size > 12) _gridCache.delete(_gridCache.keys().next().value as string);
  _gridCache.set(key, grid);
  return grid;
}

function planeIndex(planes: number[], v: number): number {
  if (v < planes[0] - TOL || v > planes[planes.length - 1] + TOL) return -1;
  let lo = 0, hi = planes.length - 2;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (planes[m] <= v) lo = m; else hi = m - 1; }
  return lo;
}

/** Noktanın hücresi (-1 = gövde dışı). */
export function cellOfPoint(g: CavityGrid, p: Vec3): number {
  const i = planeIndex(g.xs, p[0]), j = planeIndex(g.ys, p[1]), k = planeIndex(g.zs, p[2]);
  if (i < 0 || j < 0 || k < 0) return -1;
  return cellIndex(g, i, j, k);
}

/** Noktaya en yakın SERBEST hücre (çıpa dolu hücreye düşerse). */
function nearestFreeCell(g: CavityGrid, p: Vec3): number {
  let best = -1, bestD = Infinity;
  for (let c = 0; c < g.free.length; c++) {
    if (!g.free[c]) continue;
    const b = cellBox(g, c);
    let d = 0;
    for (let a = 0; a < 3; a++) { const q = Math.max(b.min[a] - p[a], 0, p[a] - b.max[a]); d += q * q; }
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

/** Tohum hücreden yüz-komşu serbest hücrelere taşma → bağlantılı bölge. */
export function floodRegion(g: CavityGrid, seed: number): Set<number> {
  const out = new Set<number>();
  if (seed < 0 || !g.free[seed]) return out;
  const stack = [seed]; out.add(seed);
  while (stack.length) {
    const c = stack.pop()!;
    const [i, j, k] = cellIJK(g, c);
    const nb: Array<[number, number, number]> = [[i - 1, j, k], [i + 1, j, k], [i, j - 1, k], [i, j + 1, k], [i, j, k - 1], [i, j, k + 1]];
    for (const [a, b, d] of nb) {
      if (a < 0 || b < 0 || d < 0 || a >= g.nx || b >= g.ny || d >= g.nz) continue;
      const n = cellIndex(g, a, b, d);
      if (!g.free[n] || out.has(n)) continue;
      out.add(n); stack.push(n);
    }
  }
  return out;
}

export function regionBBox(g: CavityGrid, cells: Set<number>): CavityBox {
  const b: CavityBox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const c of cells) {
    const cb = cellBox(g, c);
    for (let a = 0; a < 3; a++) { if (cb.min[a] < b.min[a]) b.min[a] = cb.min[a]; if (cb.max[a] > b.max[a]) b.max[a] = cb.max[a]; }
  }
  return b;
}

/** Bölge hücreleri X boyunca birleştirilmiş kutular (şema silueti / kayıt). */
export function regionBoxes(g: CavityGrid, cells: Set<number>): CavityBox[] {
  const out: CavityBox[] = [];
  for (let k = 0; k < g.nz; k++) for (let j = 0; j < g.ny; j++) {
    let run: CavityBox | null = null;
    for (let i = 0; i <= g.nx; i++) {
      const inR = i < g.nx && cells.has(cellIndex(g, i, j, k));
      if (inR) {
        if (!run) run = { min: [g.xs[i], g.ys[j], g.zs[k]], max: [g.xs[i + 1], g.ys[j + 1], g.zs[k + 1]] };
        else run.max[0] = g.xs[i + 1];
      } else if (run) { out.push(run); run = null; }
    }
  }
  return out;
}

export const regionKey = (cells: Set<number>) => Array.from(cells).sort((a, b) => a - b).join(',');

/** Bölgenin DIŞ yüzeyi (komşusu bölgede olmayan hücre yüzleri) — üçgen konumları. */
export function regionSurface(g: CavityGrid, cells: Set<number>): number[] {
  const pos: number[] = [];
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => { pos.push(...a, ...b, ...c, ...a, ...c, ...d); };
  for (const c of cells) {
    const [i, j, k] = cellIJK(g, c);
    const b = cellBox(g, c);
    const has = (a: number, bb: number, d: number) => a >= 0 && bb >= 0 && d >= 0 && a < g.nx && bb < g.ny && d < g.nz && cells.has(cellIndex(g, a, bb, d));
    const [x0, y0, z0] = b.min, [x1, y1, z1] = b.max;
    if (!has(i - 1, j, k)) quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
    if (!has(i + 1, j, k)) quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
    if (!has(i, j - 1, k)) quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    if (!has(i, j + 1, k)) quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]);
    if (!has(i, j, k - 1)) quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]);
    if (!has(i, j, k + 1)) quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  }
  return pos;
}

// ── 2B MASKE SINIR İZLEME (dikdörtgensel çokgen) ────────────────────────────

/**
 * Düzensiz ızgara maskesinin sınır döngüleri (dolu bölge SOLDA kalacak
 * şekilde yönlü). Sıkışma noktalarında sağa dönen aday seçilir (döngüler
 * kesişmez); ardışık doğrusal kenarlar birleştirilir.
 */
export function traceMaskLoops(us: number[], vs: number[], filled: (i: number, k: number) => boolean): Pt2[][] {
  const nu = us.length - 1, nv = vs.length - 1;
  const f = (i: number, k: number) => i >= 0 && k >= 0 && i < nu && k < nv && filled(i, k);
  // Yönlü kenarlar: anahtar = başlangıç köşesi "i,k"
  type E = { a: [number, number]; b: [number, number]; used: boolean };
  const edges: E[] = [];
  const byStart = new Map<string, E[]>();
  const add = (a: [number, number], b: [number, number]) => {
    const e: E = { a, b, used: false }; edges.push(e);
    const key = `${a[0]},${a[1]}`; if (!byStart.has(key)) byStart.set(key, []); byStart.get(key)!.push(e);
  };
  for (let i = 0; i < nu; i++) for (let k = 0; k < nv; k++) {
    if (!f(i, k)) continue;
    if (!f(i, k - 1)) add([i, k], [i + 1, k]);          // alt kenar → +u
    if (!f(i + 1, k)) add([i + 1, k], [i + 1, k + 1]);  // sağ kenar → +v
    if (!f(i, k + 1)) add([i + 1, k + 1], [i, k + 1]);  // üst kenar → −u
    if (!f(i - 1, k)) add([i, k + 1], [i, k]);          // sol kenar → −v
  }
  const loops: Pt2[][] = [];
  for (const start of edges) {
    if (start.used) continue;
    const loop: [number, number][] = [];
    let cur = start;
    let guard = 0;
    while (!cur.used && guard++ < edges.length + 2) {
      cur.used = true;
      loop.push(cur.a);
      const cands = (byStart.get(`${cur.b[0]},${cur.b[1]}`) || []).filter(e => !e.used);
      if (!cands.length) break;
      let next = cands[0];
      if (cands.length > 1) {
        // Sağa dönüş önceliği (gelen yön × giden yön çapraz çarpımı en küçük).
        const din = [cur.b[0] - cur.a[0], cur.b[1] - cur.a[1]];
        let best = Infinity;
        for (const e of cands) {
          const dout = [e.b[0] - e.a[0], e.b[1] - e.a[1]];
          const cross = din[0] * dout[1] - din[1] * dout[0];
          if (cross < best) { best = cross; next = e; }
        }
      }
      cur = next;
    }
    if (loop.length < 4) continue;
    // Doğrusal ara köşeleri at.
    const pts: Pt2[] = [];
    for (let n = 0; n < loop.length; n++) {
      const p = loop[(n - 1 + loop.length) % loop.length], q = loop[n], r = loop[(n + 1) % loop.length];
      const col = (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]);
      if (Math.abs(col) < 1e-9) continue;
      pts.push({ x: us[q[0]], y: vs[q[1]] });
    }
    if (pts.length >= 3) loops.push(pts);
  }
  return loops;
}

const polyArea = (p: Pt2[]) => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q.x * r.y - r.x * q.y; } return a / 2; };
const pointInPoly = (pt: Pt2, poly: Pt2[]) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};

/**
 * KESİT ÇOKGENİ: dizilim ekseni boyunca [a0,a1] dilimini kesen TÜM katmanlarda
 * bölgede olan (u,v) hücreleri → dış sınır (pozitif alanlı, delik yok).
 * Birden çok parça varsa tohum sütununu içeren, yoksa en büyük seçilir.
 */
export function sectionPolygon(g: CavityGrid, cells: Set<number>, axis: number, a0: number, a1: number, seed?: Vec3): Pt2[] | null {
  const [ua, va] = [0, 1, 2].filter(a => a !== axis);
  const planes = axisPlanes(g, axis);
  const layers: number[] = [];
  for (let j = 0; j < planes.length - 1; j++) if (planes[j] < a1 - TOL && planes[j + 1] > a0 + TOL) layers.push(j);
  if (!layers.length) return null;
  const us = axisPlanes(g, ua), vs = axisPlanes(g, va);
  const idx = (iu: number, iv: number, j: number) => {
    const ijk = [0, 0, 0]; ijk[ua] = iu; ijk[va] = iv; ijk[axis] = j;
    return cellIndex(g, ijk[0], ijk[1], ijk[2]);
  };
  const filled = (iu: number, iv: number) => layers.every(j => cells.has(idx(iu, iv, j)));
  const loops = traceMaskLoops(us, vs, filled).filter(l => polyArea(l) > 1);
  if (!loops.length) return null;
  if (seed) {
    const sp = { x: seed[ua], y: seed[va] };
    const hit = loops.find(l => pointInPoly(sp, l));
    if (hit) return hit;
  }
  return loops.reduce((b, l) => (polyArea(l) > polyArea(b) ? l : b));
}

// ── IŞIN BOYUNCA ADAYLAR ────────────────────────────────────────────────────

function rayBoxInterval(o: Vec3, d: Vec3, b: CavityBox): [number, number] | null {
  let t0 = -Infinity, t1 = Infinity;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < b.min[a] || o[a] > b.max[a]) return null;
      continue;
    }
    let ta = (b.min[a] - o[a]) / d[a], tb = (b.max[a] - o[a]) / d[a];
    if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

/** Bölgeden seçim adayı (kutu, kutular, yüzey, anahtar, tohum). */
export function pickFromRegion(g: CavityGrid, cells: Set<number>, seed: Vec3): CavityPick {
  return { key: regionKey(cells), bbox: regionBBox(g, cells), boxes: regionBoxes(g, cells), surface: regionSurface(g, cells), seed };
}

/**
 * IŞIN BOYUNCA ŞEKİLLİ HACİMLER: ışının gövde kutusundaki parçası hücre hücre
 * yürünür (her hücre için t-aralığı); serbest hücreye ilk girişte o hücreden
 * taşılarak bölge bulunur; aynı bölge bir kez sayılır. Sol tık bu liste
 * üzerinde döner (ışın derinliği sırasıyla).
 */
export function rayCavityCandidates(originLocal: Vec3, dirLocal: Vec3, g: CavityGrid, minSpan: number): CavityPick[] {
  const bodyIv = rayBoxInterval(originLocal, dirLocal, g.body);
  if (!bodyIv) return [];
  const t0 = Math.max(bodyIv[0], 0), t1 = bodyIv[1];
  if (t1 <= t0) return [];
  const out: CavityPick[] = [];
  const seen = new Set<string>();
  // Kesişilen düzlem parametreleri → sıralı alt-aralıklar; her aralığın ortası bir hücre.
  const ts: number[] = [t0, t1];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(dirLocal[a]) < 1e-9) continue;
    for (const p of axisPlanes(g, a)) { const t = (p - originLocal[a]) / dirLocal[a]; if (t > t0 && t < t1) ts.push(t); }
  }
  ts.sort((a, b) => a - b);
  for (let n = 0; n < ts.length - 1; n++) {
    if (ts[n + 1] - ts[n] < 1e-6) continue;
    const tm = (ts[n] + ts[n + 1]) / 2;
    const p: Vec3 = [originLocal[0] + dirLocal[0] * tm, originLocal[1] + dirLocal[1] * tm, originLocal[2] + dirLocal[2] * tm];
    const c = cellOfPoint(g, p);
    if (c < 0 || !g.free[c]) continue;
    const cells = floodRegion(g, c);
    const key = regionKey(cells);
    if (seen.has(key)) continue;
    seen.add(key);
    const bb = regionBBox(g, cells);
    if (boxSpan(bb, 0) < minSpan || boxSpan(bb, 1) < minSpan || boxSpan(bb, 2) < minSpan) continue;
    out.push(pickFromRegion(g, cells, p));
  }
  return out;
}

// ── BOŞLUK ÇÖZÜCÜ ───────────────────────────────────────────────────────────

/** Eşit dağılım: n panel, n+1 boşluk, kilitsiz. */
export function equalGaps(L: number, count: number, t: number): GapSpec[] {
  const n = Math.max(0, count);
  const g = Math.max(MIN_GAP, (L - n * t) / (n + 1));
  return Array.from({ length: n + 1 }, () => ({ value: r1(g), locked: false }));
}

/**
 * YENİDEN DAĞITIM (küp boyutlandı / hacim değişti): kilitli boşluklar aynen
 * kalır; kalan açıklık kilitsizlere ORANLARI korunarak dağılır (hepsi eşitse
 * eşit kalır). Kilitliler sığmıyorsa oransal küçültülür (uyarı). Hepsi
 * kilitliyse artık son boşluğa yazılır.
 */
export function rescaleGaps(gaps: GapSpec[], L: number, count: number, t: number): GapSpec[] {
  if (!Array.isArray(gaps) || gaps.length !== count + 1) return equalGaps(L, count, t);
  const avail = L - count * t;
  const out = gaps.map(g => ({ ...g }));
  const lockedSum = out.filter(g => g.locked).reduce((s, g) => s + g.value, 0);
  let free = avail - lockedSum;
  if (free < -1e-6) {
    const k = lockedSum > 0 ? Math.max(0, avail) / lockedSum : 0;
    console.warn('[YAGO][GRUP-BOŞLUK] kilitli boşluklar açıklığa sığmıyor: kilitliΣ=', lockedSum.toFixed(1), 'açıklık=', avail.toFixed(1), '→ kilitliler oransal küçültüldü');
    for (const g of out) if (g.locked) g.value = r1(g.value * k);
    free = 0;
  }
  const unlocked = out.filter(g => !g.locked);
  if (unlocked.length === 0) {
    const last = out[out.length - 1];
    if (Math.abs(free) > 0.05) { last.value = r1(last.value + free); console.warn('[YAGO][GRUP-BOŞLUK] tüm boşluklar kilitli, artık son boşluğa yazıldı:', free.toFixed(1)); }
    return out;
  }
  const uSum = unlocked.reduce((s, g) => s + g.value, 0);
  if (uSum > 1e-6) for (const g of unlocked) g.value = r1(g.value * free / uSum);
  else for (const g of unlocked) g.value = r1(free / unlocked.length);
  const total = out.reduce((s, g) => s + g.value, 0);
  const resid = avail - total;
  if (Math.abs(resid) > 0.05) unlocked[unlocked.length - 1].value = r1(unlocked[unlocked.length - 1].value + resid);
  return out;
}

/**
 * BOŞLUK GİRİŞİ: k. boşluk value olur ve "girildi" sayılır; fark, kilitsiz ve
 * girilmemiş boşluklara EŞİT dağılır. Öyle boşluk kalmadıysa diğer kilitsiz
 * (girilmiş) boşluklara oransal; o da yoksa değer kalan açıklığa kırpılır.
 */
export function applyGapEdit(gaps: GapSpec[], k: number, value: number, L: number, count: number, t: number): GapSpec[] {
  const out = (gaps.length === count + 1 ? gaps : equalGaps(L, count, t)).map(g => ({ ...g }));
  if (k < 0 || k >= out.length) return out;
  const avail = L - count * t;
  const v = Math.max(MIN_GAP, value);
  out[k] = { ...out[k], value: r1(v), edited: true };
  const others = out.filter((_, i) => i !== k);
  const fixedSum = others.filter(g => g.locked || g.edited).reduce((s, g) => s + g.value, 0);
  let free = avail - out[k].value - fixedSum;
  const fresh = others.filter(g => !g.locked && !g.edited);
  if (fresh.length > 0) {
    if (free < 0) { console.warn('[YAGO][GRUP-BOŞLUK] girilen değer açıklığı aşıyor, serbest boşluklar 0:', free.toFixed(1)); free = 0; }
    for (const g of fresh) g.value = r1(free / fresh.length);
    return out;
  }
  const soft = others.filter(g => !g.locked);
  if (soft.length > 0) {
    if (free < 0) free = 0;
    const sSum = soft.reduce((s, g) => s + g.value, 0);
    if (sSum > 1e-6) for (const g of soft) g.value = r1(g.value * free / sSum);
    else for (const g of soft) g.value = r1(free / soft.length);
    return out;
  }
  const lockedSum = others.reduce((s, g) => s + g.value, 0);
  out[k].value = r1(Math.max(MIN_GAP, avail - lockedSum));
  console.warn('[YAGO][GRUP-BOŞLUK] diğer boşluklar kilitli, değer kırpıldı →', out[k].value);
  return out;
}

/** Panel başlangıçları (dizilim ekseni, hacim min'inden): p_i = min + Σgap[0..i] + i·t. */
export function panelStarts(cavityMin: number, gaps: GapSpec[], t: number): number[] {
  const starts: number[] = [];
  let p = cavityMin;
  for (let i = 0; i < gaps.length - 1; i++) {
    p += gaps[i].value;
    starts.push(p);
    p += t;
  }
  return starts;
}

// ── ÜYE VF GEOMETRİSİ ───────────────────────────────────────────────────────

/**
 * Üye VF: dizilim ekseninde start+t düzleminde (normal +eksen), o dilimin
 * KESİT çokgeni (şekilli). createPanelFromVirtualFace −normal yönünde t kadar
 * uzar → levha [start, start+t] aralığına oturur. Kesit yoksa kutu kesiti.
 */
export function memberVfGeometry(axis: number, cavity: CavityBox, start: number, t: number, section?: Pt2[] | null): { normal: Vec3; vertices: Vec3[]; center: Vec3 } {
  const [b, c] = [0, 1, 2].filter(a => a !== axis);
  const plane = start + t;
  const mk = (vb: number, vc: number): Vec3 => { const p: Vec3 = [0, 0, 0]; p[axis] = plane; p[b] = vb; p[c] = vc; return p; };
  const poly: Pt2[] = section && section.length >= 3 ? section
    : [{ x: cavity.min[b], y: cavity.min[c] }, { x: cavity.max[b], y: cavity.min[c] }, { x: cavity.max[b], y: cavity.max[c] }, { x: cavity.min[b], y: cavity.max[c] }];
  const vertices = poly.map(q => mk(q.x, q.y));
  const normal: Vec3 = [0, 0, 0]; normal[axis] = 1;
  let cb = 0, cc = 0; for (const q of poly) { cb += q.x; cc += q.y; }
  const center = mk(cb / poly.length, cc / poly.length);
  return { normal, vertices, center };
}

export interface GroupSolution { cavity: CavityBox; region: CavityBox[]; gaps: GapSpec[]; starts: number[]; sections: Array<Pt2[] | null>; seed: Vec3 }

/** Grubun engelleri: tüm gövde panelleri + kendinden ÖNCE oluşturulmuş grupların panelleri. */
export function groupObstacles(group: PanelGroup, parent: Shape, panels: Shape[], groups: PanelGroup[]): CavityBox[] {
  const byId = new Map(groups.map(g => [g.id, g] as const));
  const out: CavityBox[] = [];
  for (const p of panels) {
    if ((p.parameters as any)?.parentShapeId !== parent.id) continue;
    const gid = (p.parameters as any)?.panelGroupId as string | undefined;
    if (gid) {
      if (gid === group.id) continue;
      const g = byId.get(gid);
      if (!g || g.createdAt >= group.createdAt) continue;
    }
    const b = panelLocalBox(p, parent);
    if (b) out.push(b);
  }
  return out;
}

/** Çıpa noktası (gövde kutusu oranından). */
const anchorPoint = (group: PanelGroup, body: CavityBox): Vec3 =>
  [0, 1, 2].map(i => body.min[i] + group.anchorFrac[i] * (body.max[i] - body.min[i])) as Vec3;

/**
 * Grubu güncel gövde + panellerle çözer (saf): ızgara → çıpadan bölge → kutu →
 * boşluklar → her üyenin kesit çokgeni. Bölge bozuksa önceki hacimle devam eder.
 */
export function solveGroup(group: PanelGroup, parent: Shape, panels: Shape[], groups: PanelGroup[]): GroupSolution | null {
  const obstacles = groupObstacles(group, parent, panels, groups);
  const grid = buildCavityGrid(parent, obstacles);
  if (!grid) return null;
  const t = group.thickness;
  let seed = anchorPoint(group, grid.body);
  let c = cellOfPoint(grid, seed);
  if (c < 0 || !grid.free[c]) {
    c = nearestFreeCell(grid, seed);
    if (c >= 0) { const b = cellBox(grid, c); seed = [0, 1, 2].map(a => (b.min[a] + b.max[a]) / 2) as Vec3; console.log('[YAGO][GRUP] çıpa dolu hücrede, en yakın serbest hücreye alındı:', group.id, fmtBox(b)); }
  }
  const cells = c >= 0 ? floodRegion(grid, c) : new Set<number>();
  let cavity = cells.size ? regionBBox(grid, cells) : cloneBox(group.cavity);
  let region = cells.size ? regionBoxes(grid, cells) : (group.region || [cloneBox(group.cavity)]);
  const minOk = cells.size > 0 && [0, 1, 2].every(a => boxSpan(cavity, a) >= (a === group.axis ? group.count * t : t));
  if (!minOk) {
    console.warn('[YAGO][GRUP] hacim bozuk/çok küçük, önceki hacim korunuyor:', group.id, fmtBox(cavity));
    cavity = cloneBox(group.cavity);
    region = group.region || [cloneBox(cavity)];
  }
  const L = boxSpan(cavity, group.axis);
  const gaps = rescaleGaps(group.gaps, L, group.count, t);
  const starts = panelStarts(cavity.min[group.axis], gaps, t);
  const sections = starts.map(s => (minOk ? sectionPolygon(grid, cells, group.axis, s, s + t, seed) : null));
  return { cavity, region, gaps, starts, sections, seed };
}

/** Çözümden üye VF yaması (regen bu alanları yazar; kullanıcı alanları dokunulmaz). */
export function interiorVfPatch(vf: VirtualFace, group: PanelGroup, sol: GroupSolution): Partial<VirtualFace> | null {
  const i = vf.groupIndex ?? group.memberVfIds.indexOf(vf.id);
  if (i < 0 || i >= sol.starts.length) return null;
  const g = memberVfGeometry(group.axis, sol.cavity, sol.starts[i], group.thickness, sol.sections[i]);
  return { normal: g.normal, vertices: g.vertices, center: g.center, regionAnchor: g.center } as any;
}

/**
 * REGEN KANCASI (VirtualFaceUpdateService): bir gövdenin tüm iç VF'lerini grup
 * çözümüyle yeniden yazar. Yüz eşlemesi yapılmaz. Grup yoksa VF olduğu gibi kalır.
 */
export function recalculateInteriorVfs(parent: Shape, vfs: VirtualFace[], panels: Shape[], groups: PanelGroup[]): Map<string, VirtualFace> {
  const out = new Map<string, VirtualFace>();
  const mine = groups.filter(g => g.shapeId === parent.id);
  for (const g of mine) {
    const sol = solveGroup(g, parent, panels, groups);
    if (!sol) continue;
    console.log('[YAGO][GRUP-REGEN]', g.id, g.kind, 'n=', g.count, 'hacim=', fmtBox(sol.cavity), 'parçaN=', sol.region.length,
      'L=', boxSpan(sol.cavity, g.axis).toFixed(1), 'boşluklar=', sol.gaps.map(x => `${x.value}${x.locked ? '🔒' : ''}`).join('/'),
      'kesitKöşeN=', sol.sections.map(s => (s ? s.length : '-')).join('/'));
    for (const vf of vfs) {
      if (vf.shapeId !== parent.id || vf.groupId !== g.id) continue;
      const patch = interiorVfPatch(vf, g, sol);
      if (patch) out.set(vf.id, { ...vf, ...patch });
    }
  }
  return out;
}

// ── STORE İŞLEMLERİ ─────────────────────────────────────────────────────────

const rebuild = (shapeId: string) =>
  import('./PanelEngine').then(({ rebuildPanelsForParent }) => rebuildPanelsForParent(shapeId));

function makeMemberVf(group: PanelGroup, i: number, sol: GroupSolution): VirtualFace {
  const g = memberVfGeometry(group.axis, sol.cavity, sol.starts[i], group.thickness, sol.sections[i]);
  return {
    id: genId('vf-int'), shapeId: group.shapeId,
    normal: g.normal, center: g.center, vertices: g.vertices,
    description: '', hasPanel: false,
    parentFaceShape: false, interior: true, groupId: group.id, groupIndex: i,
    ...( { regionAnchor: g.center } as any ),
  };
}

/** Grubun güncel çözümü (store durumundan); yoksa null. */
function solveFromStore(group: PanelGroup): GroupSolution | null {
  const st = useAppStore.getState();
  const parent = st.shapes.find(s => s.id === group.shapeId);
  if (!parent) return null;
  return solveGroup(group, parent, st.shapes, st.panelGroups.some(g => g.id === group.id) ? st.panelGroups : [...st.panelGroups, group]);
}

/** Onaylanan hacimden grup + ilk üye VF (1 panel, eşit boşluk) oluşturur; grup seçilir. */
export function createPanelGroupFromCavity(shapeId: string, kind: PanelGroup['kind'], pick: CavityPick): PanelGroup | null {
  const st = useAppStore.getState();
  const parent = st.shapes.find(s => s.id === shapeId);
  if (!parent) return null;
  const body = bodyLocalBox(parent);
  if (!body) return null;
  const axis = groupAxisOf(kind);
  const t = GROUP_PANEL_THICKNESS;
  // ÇIPA = tohum noktası (ışının bölgeye girdiği yer) — L bölgede kutu merkezi dışarıda kalabilir.
  const anchorFrac: Vec3 = [0, 1, 2].map(i => {
    const s = body.max[i] - body.min[i];
    return s > 1e-6 ? Math.max(0, Math.min(1, (pick.seed[i] - body.min[i]) / s)) : 0.5;
  }) as Vec3;
  const count = 1;
  const L = boxSpan(pick.bbox, axis);
  const group: PanelGroup = {
    id: genId(kind === 'shelf' ? 'shelf' : 'divider'), shapeId, kind, axis, anchorFrac,
    cavity: cloneBox(pick.bbox), region: pick.boxes.map(cloneBox), count, gaps: equalGaps(L, count, t), thickness: t, memberVfIds: [], createdAt: Date.now(),
  };
  const sol = solveFromStore(group) || { cavity: group.cavity, region: group.region!, gaps: group.gaps, starts: panelStarts(group.cavity.min[axis], group.gaps, t), sections: [null], seed: pick.seed };
  const vfs = Array.from({ length: count }, (_, i) => makeMemberVf(group, i, sol));
  group.memberVfIds = vfs.map(v => v.id);
  st.addPanelGroup(group);
  st.insertVirtualFacesAfter(null, vfs);
  st.setSelectedPanelGroupId(group.id);
  console.log('[YAGO][GRUP] oluşturuldu', group.id, kind, 'hacim=', fmtBox(pick.bbox), 'parçaN=', pick.boxes.length, 'L=', L.toFixed(1), 'çıpa=', anchorFrac.map(n => n.toFixed(2)).join(','));
  return group;
}

/** Üye sayısı: artınca yeni VF'ler son üyenin arkasına eklenir, azalınca son üyeler (panel+VF) silinir. Boşluklar eşitlenir. */
export async function setGroupCount(groupId: string, count: number): Promise<void> {
  const st = useAppStore.getState();
  const group = st.panelGroups.find(g => g.id === groupId);
  if (!group) return;
  const n = Math.max(0, Math.min(40, Math.round(count)));
  if (n === group.count) return;
  const L = boxSpan(group.cavity, group.axis);
  const gaps = equalGaps(L, n, group.thickness);
  let memberVfIds = group.memberVfIds.slice();
  if (n < group.count) {
    const removed = memberVfIds.slice(n);
    memberVfIds = memberVfIds.slice(0, n);
    for (const vfId of removed) {
      const p = st.shapes.find(s => s.type === 'panel' && (s.parameters as any)?.virtualFaceId === vfId);
      if (p) st.deleteShape(p.id);
      st.deleteVirtualFace(vfId);
      if (st.selectedPanelRow === `vf-${vfId}`) st.setSelectedPanelRow(null);
    }
  }
  const next: PanelGroup = { ...group, count: n, gaps, memberVfIds };
  const sol = solveFromStore(next) || { cavity: group.cavity, region: group.region || [group.cavity], gaps, starts: panelStarts(group.cavity.min[group.axis], gaps, group.thickness), sections: Array(n).fill(null), seed: anchorPoint(group, group.cavity) };
  for (let i = 0; i < Math.min(n, group.count); i++) {
    const vf = useAppStore.getState().virtualFaces.find(f => f.id === memberVfIds[i]);
    if (!vf) continue;
    const patch = interiorVfPatch({ ...vf, groupIndex: i }, next, sol);
    if (patch) st.updateVirtualFace(vf.id, { ...patch, groupIndex: i });
  }
  if (n > group.count) {
    const added = Array.from({ length: n - group.count }, (_, k) => makeMemberVf(next, group.count + k, sol));
    next.memberVfIds = [...memberVfIds, ...added.map(v => v.id)];
    st.insertVirtualFacesAfter(memberVfIds[memberVfIds.length - 1] || null, added);
  }
  st.updatePanelGroup(groupId, { count: n, gaps: sol.gaps, memberVfIds: next.memberVfIds });
  console.log('[YAGO][GRUP] adet', group.count, '→', n, groupId, '(boşluklar eşitlendi)');
  // Panel ekleme (VF → otomatik panel) / silme rebuild'i App izleyicisi tetikler.
}

function writeGroupGaps(group: PanelGroup, gaps: GapSpec[]): void {
  const st = useAppStore.getState();
  const next = { ...group, gaps };
  const sol = solveFromStore(next) || { cavity: group.cavity, region: group.region || [group.cavity], gaps, starts: panelStarts(group.cavity.min[group.axis], gaps, group.thickness), sections: Array(group.count).fill(null), seed: anchorPoint(group, group.cavity) };
  for (const vfId of group.memberVfIds) {
    const vf = st.virtualFaces.find(f => f.id === vfId);
    if (!vf) continue;
    const patch = interiorVfPatch(vf, next, sol);
    if (patch) st.updateVirtualFace(vf.id, patch);
  }
  st.updatePanelGroup(group.id, { gaps: sol.gaps });
}

/** Boşluk girişi (şema pill'i): kural applyGapEdit; VF'ler güncellenir, tam rebuild. */
export async function editGroupGap(groupId: string, k: number, value: number): Promise<void> {
  const st = useAppStore.getState();
  const group = st.panelGroups.find(g => g.id === groupId);
  if (!group || !Number.isFinite(value)) return;
  const L = boxSpan(group.cavity, group.axis);
  const gaps = applyGapEdit(group.gaps, k, value, L, group.count, group.thickness);
  writeGroupGaps(group, gaps);
  console.log('[YAGO][GRUP-BOŞLUK] girildi', groupId, 'k=', k, 'değer=', value, '→', gaps.map(g => `${g.value}${g.locked ? '🔒' : g.edited ? '*' : ''}`).join('/'));
  await rebuild(group.shapeId);
}

/** Kilit: değer değişmez; küp boyutlanınca bu boşluk sabit kalır. */
export function toggleGroupGapLock(groupId: string, k: number): void {
  const st = useAppStore.getState();
  const group = st.panelGroups.find(g => g.id === groupId);
  if (!group || k < 0 || k >= group.gaps.length) return;
  const gaps = group.gaps.map((g, i) => (i === k ? { ...g, locked: !g.locked } : g));
  st.updatePanelGroup(groupId, { gaps });
  console.log('[YAGO][GRUP-BOŞLUK]', gaps[k].locked ? 'KİLİTLENDİ' : 'kilit açıldı', groupId, 'k=', k, 'değer=', gaps[k].value);
}

/** Tüm boşluklar eşit + kilitsiz. */
export async function equalizeGroupGaps(groupId: string): Promise<void> {
  const st = useAppStore.getState();
  const group = st.panelGroups.find(g => g.id === groupId);
  if (!group) return;
  const L = boxSpan(group.cavity, group.axis);
  writeGroupGaps(group, equalGaps(L, group.count, group.thickness));
  console.log('[YAGO][GRUP-BOŞLUK] eşitlendi', groupId);
  await rebuild(group.shapeId);
}

/** Grup + tüm üye paneller ve VF'ler silinir (rebuild'i panel silme izleyicisi tetikler). */
export function deletePanelGroupWithMembers(groupId: string): void {
  const st = useAppStore.getState();
  const group = st.panelGroups.find(g => g.id === groupId);
  if (!group) return;
  for (const vfId of group.memberVfIds) {
    const p = st.shapes.find(s => s.type === 'panel' && (s.parameters as any)?.virtualFaceId === vfId);
    if (p) st.deleteShape(p.id);
    st.deleteVirtualFace(vfId);
    if (st.selectedPanelRow === `vf-${vfId}`) st.setSelectedPanelRow(null);
  }
  st.deletePanelGroup(groupId);
  console.log('[YAGO][GRUP] silindi', groupId, 'üyeN=', group.memberVfIds.length);
}

const boxKey = (b: CavityBox) => [...b.min, ...b.max].map(n => Math.round(n)).join('|');

/**
 * REBUILD SONRASI SENKRON (PanelEngine): grubun store'daki hacmi/bölgesi/
 * boşlukları güncel çözümle eşitlenir (şema ve kilit değerleri doğru okunsun).
 */
export function syncPanelGroups(parentShapeId: string): void {
  const st = useAppStore.getState();
  const parent = st.shapes.find(s => s.id === parentShapeId);
  if (!parent) return;
  const mine = st.panelGroups.filter(g => g.shapeId === parentShapeId);
  for (const g of mine) {
    const sol = solveGroup(g, parent, st.shapes, st.panelGroups);
    if (!sol) continue;
    const sameBox = boxKey(sol.cavity) === boxKey(g.cavity);
    const sameRegion = boxesKey(sol.region) === boxesKey(g.region || []);
    const sameGaps = sol.gaps.length === g.gaps.length && sol.gaps.every((x, i) => Math.abs(x.value - g.gaps[i].value) < 0.05 && x.locked === g.gaps[i].locked);
    if (sameBox && sameRegion && sameGaps) continue;
    st.updatePanelGroup(g.id, { cavity: sol.cavity, region: sol.region, gaps: sol.gaps });
    console.log('[YAGO][GRUP-SENKRON]', g.id, 'hacim=', fmtBox(sol.cavity), 'parçaN=', sol.region.length, 'boşluklar=', sol.gaps.map(x => x.value).join('/'));
  }
}
