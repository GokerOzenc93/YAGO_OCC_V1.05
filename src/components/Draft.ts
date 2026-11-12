import { create } from 'zustand';

/* 2B ÇİZİM ÇEKİRDEĞİ — three/React bağımsız (Node'da test edilebilir).
   1) Geometri: nokta/vektör, ilkel (doğru parçası · yay · elips), kesişim, dilimleme, dönüşüm, öteleme (offset), köşe (fillet/chamfer).
   2) Nesne yakalama (object snap) ve koordinat girişi (x,y · @dx,dy · @d<a · <a).
   3) Komut sürücüsü: her komut bir üreteçtir (generator) — `yield` ile istem (Req) verir, girdi (Ev) alır. İstem metinleri ve
      [seçenek] harfleri klasik CAD komut satırı akışını izler; kod özgündür (dışarıdan kopya yok).
   Nesneler her zaman bir ÇİZİM DÜZLEMİNE (DraftPlane) aittir ve o düzlemin 2B koordinatlarında saklanır. */

// ═════════════════════════════════════════════════ 1. TEMEL MATEMATİK ═════════════════════════════════════════════════
export type P2 = { x: number; y: number };
export type V3 = [number, number, number];

const TAU = Math.PI * 2;
const LEN_EPS = 1e-6;   // mm — bu kadar yakın iki nokta aynı sayılır
const ANG_EPS = 1e-7;
export const P = (x: number, y: number): P2 => ({ x, y });
const add = (a: P2, b: P2): P2 => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: P2, b: P2): P2 => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a: P2, k: number): P2 => ({ x: a.x * k, y: a.y * k });
const dot = (a: P2, b: P2) => a.x * b.x + a.y * b.y;
const cross = (a: P2, b: P2) => a.x * b.y - a.y * b.x;
const vlen = (a: P2) => Math.hypot(a.x, a.y);
export const dist = (a: P2, b: P2) => Math.hypot(a.x - b.x, a.y - b.y);
const unit = (a: P2): P2 => { const l = vlen(a); return l < 1e-12 ? { x: 1, y: 0 } : { x: a.x / l, y: a.y / l }; };
const perp = (a: P2): P2 => ({ x: -a.y, y: a.x });           // +90° (sola)
const angOf = (a: P2) => Math.atan2(a.y, a.x);
const polar = (a: number, r = 1): P2 => ({ x: Math.cos(a) * r, y: Math.sin(a) * r });
const lerp = (a: P2, b: P2, t: number): P2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const mid = (a: P2, b: P2) => lerp(a, b, 0.5);
const normAng = (a: number) => { const r = a % TAU; return r < 0 ? r + TAU : r; };
/** a0'dan a1'e saat yönünün TERSİNE açı farkı, [0, 2π). */
const ccwDelta = (a0: number, a1: number) => normAng(a1 - a0);
/** (−π, π] aralığına indirger. */
const wrapPi = (a: number) => { const r = normAng(a); return r > Math.PI ? r - TAU : r; };
const rotAbout = (p: P2, c: P2, a: number): P2 => {
  const s = Math.sin(a), k = Math.cos(a), dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * k - dy * s, y: c.y + dx * s + dy * k };
};
const same = (a: P2, b: P2, tol = LEN_EPS) => Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
export const deg = (r: number) => r * 180 / Math.PI;
export const rad = (d: number) => d * Math.PI / 180;
/** Komut satırı sayı biçimi: en çok 4 ondalık, sondaki sıfırlar atılır. */
export const fmt = (n: number, d = 4) => { const s = (Math.abs(n) < 0.5 * 10 ** -d ? 0 : n).toFixed(d); return s.includes('.') ? s.replace(/\.?0+$/, '') : s; };

// ═════════════════════════════════════════════════ 2. NESNELER VE İLKELLER ════════════════════════════════════════════
export type LineS = { t: 'line'; a: P2; b: P2 };
export type CircleS = { t: 'circle'; c: P2; r: number };
/** Yay her zaman a0 → a1 saat yönünün tersine. */
export type ArcS = { t: 'arc'; c: P2; r: number; a0: number; a1: number };
/** mx: merkezden büyük eksen ucuna vektör; ratio = küçük/büyük; a0/a1 (parametre açısı) verilmişse elips yayı. */
export type EllipseS = { t: 'ellipse'; c: P2; mx: P2; ratio: number; a0?: number; a1?: number };
/** b (bulge): bu köşeden sonrakine giden parçanın yay katsayısı = tan(açı/4); + saat yönünün tersi. */
export type PV = { x: number; y: number; b?: number };
export type PlineS = { t: 'pline'; v: PV[]; closed?: boolean };
export type Shape2 = LineS | CircleS | ArcS | EllipseS | PlineS;
/** pb: kontrol noktalarının parametrik bağ tercihleri (sıra = ctrlPoints) · re: daire yarıçapı formülü — yalnız Parametric kipte anlamlıdır. */
export type Entity = Shape2 & { id: string; plane: string; pb?: (PtPref | undefined)[]; re?: string };
export type GeoStyle = 'ghost' | 'rubber' | 'hi' | 'del' | 'track';
/** Geçici çizim (önizleme): nesne biçimi + stil, veya seçim penceresi. */
export type Geo = (Shape2 & { style?: GeoStyle }) | { t: 'box'; a: P2; b: P2; crossing: boolean };

type Seg = { k: 's'; a: P2; b: P2 };
/** sw: işaretli süpürme açısı (+ saat yönünün tersi). */
type Arc = { k: 'a'; c: P2; r: number; a0: number; sw: number };
type Ell = { k: 'e'; c: P2; mx: P2; ratio: number; a0: number; sw: number };
type Prim = Seg | Arc | Ell;

const L = (a: P2, b: P2): LineS => ({ t: 'line', a, b });
const ellPt = (e: { c: P2; mx: P2; ratio: number }, t: number): P2 => {
  const my = mul(perp(e.mx), e.ratio), k = Math.cos(t), s = Math.sin(t);
  return { x: e.c.x + e.mx.x * k + my.x * s, y: e.c.y + e.mx.y * k + my.y * s };
};
/** Dünya yönü (açı) → elips parametre açısı. */
const ellParamOfDir = (e: { mx: P2; ratio: number }, worldAng: number) => {
  const th = worldAng - angOf(e.mx);
  return Math.atan2(Math.sin(th) / Math.max(e.ratio, 1e-9), Math.cos(th));
};
const ellParamOfPoint = (e: { c: P2; mx: P2; ratio: number }, p: P2) => {
  const a = vlen(e.mx), ux = unit(e.mx), d = sub(p, e.c);
  return Math.atan2(dot(d, perp(ux)) / Math.max(a * e.ratio, 1e-12), dot(d, ux) / Math.max(a, 1e-12));
};

/** a → b parçası için bulge'dan yay ilkelini kurar. */
function bulgeArc(a: P2, b: P2, bulge: number): Arc {
  const d = dist(a, b), u = unit(sub(b, a));
  const off = (d / 2) * (1 - bulge * bulge) / (2 * bulge);
  const c = add(mid(a, b), mul(perp(u), off));
  return { k: 'a', c, r: dist(c, a), a0: angOf(sub(a, c)), sw: 4 * Math.atan(bulge) };
}
const primStart = (p: Prim): P2 => (p.k === 's' ? p.a : primPoint(p, 0));
const primEnd = (p: Prim): P2 => (p.k === 's' ? p.b : primPoint(p, 1));
function primPoint(p: Prim, t: number): P2 {
  if (p.k === 's') return lerp(p.a, p.b, t);
  if (p.k === 'a') return add(p.c, polar(p.a0 + p.sw * t, p.r));
  return ellPt(p, p.a0 + p.sw * t);
}
/** İlerleme yönünde birim teğet. */
function primTan(p: Prim, t: number): P2 {
  if (p.k === 's') return unit(sub(p.b, p.a));
  const s = p.sw < 0 ? -1 : 1;
  if (p.k === 'a') return mul(polar(p.a0 + p.sw * t + Math.PI / 2), s);
  const a = p.a0 + p.sw * t, my = mul(perp(p.mx), p.ratio);
  return unit(mul({ x: -p.mx.x * Math.sin(a) + my.x * Math.cos(a), y: -p.mx.y * Math.sin(a) + my.y * Math.cos(a) }, s));
}
function primLen(p: Prim): number {
  if (p.k === 's') return dist(p.a, p.b);
  if (p.k === 'a') return p.r * Math.abs(p.sw);
  let l = 0, prev = primPoint(p, 0);
  for (let i = 1; i <= 64; i++) { const q = primPoint(p, i / 64); l += dist(prev, q); prev = q; }
  return l;
}
/** Yay üzerindeki bir nokta için t∈[0,1]; yayın dışındaysa null. */
function arcT(a: { c: P2; a0: number; sw: number; r: number }, p: P2): number | null {
  const th = angOf(sub(p, a.c)), full = Math.abs(a.sw);
  const d = a.sw >= 0 ? ccwDelta(a.a0, th) : ccwDelta(th, a.a0);
  const eps = Math.max(ANG_EPS, LEN_EPS / Math.max(a.r, 1e-9));
  if (d <= full + eps) return Math.min(1, d / full);
  if (TAU - d <= eps) return 0;
  return null;
}
function primClosest(p: Prim, q: P2): { t: number; pt: P2; d: number } {
  if (p.k === 's') {
    const ab = sub(p.b, p.a), l2 = dot(ab, ab);
    const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, dot(sub(q, p.a), ab) / l2));
    const pt = lerp(p.a, p.b, t);
    return { t, pt, d: dist(pt, q) };
  }
  if (p.k === 'a') {
    const t = same(q, p.c) ? 0 : arcT(p, add(p.c, mul(unit(sub(q, p.c)), p.r)));
    if (t !== null) { const pt = primPoint(p, t); return { t, pt, d: dist(pt, q) }; }
    const s = primPoint(p, 0), e = primPoint(p, 1), ds = dist(s, q), de = dist(e, q);
    return ds <= de ? { t: 0, pt: s, d: ds } : { t: 1, pt: e, d: de };
  }
  const N = 96;
  let bi = 0, bd = Infinity;
  for (let i = 0; i <= N; i++) { const d = dist(primPoint(p, i / N), q); if (d < bd) { bd = d; bi = i; } }
  let lo = Math.max(0, (bi - 1) / N), hi = Math.min(1, (bi + 1) / N);
  for (let i = 0; i < 40; i++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (dist(primPoint(p, m1), q) < dist(primPoint(p, m2), q)) hi = m2; else lo = m1;
  }
  const t = (lo + hi) / 2, pt = primPoint(p, t);
  return { t, pt, d: dist(pt, q) };
}
const slicePrim = (p: Prim, t0: number, t1: number): Prim => (p.k === 's'
  ? { k: 's', a: lerp(p.a, p.b, t0), b: lerp(p.a, p.b, t1) }
  : { ...p, a0: p.a0 + p.sw * t0, sw: p.sw * (t1 - t0) });

export function primsOf(s: Shape2): Prim[] {
  switch (s.t) {
    case 'line': return [{ k: 's', a: s.a, b: s.b }];
    case 'circle': return [{ k: 'a', c: s.c, r: s.r, a0: 0, sw: TAU }];
    case 'arc': return [{ k: 'a', c: s.c, r: s.r, a0: s.a0, sw: ccwDelta(s.a0, s.a1) || TAU }];
    case 'ellipse': {
      const full = s.a0 === undefined || s.a1 === undefined;
      return [{ k: 'e', c: s.c, mx: s.mx, ratio: s.ratio, a0: full ? 0 : s.a0!, sw: full ? TAU : (ccwDelta(s.a0!, s.a1!) || TAU) }];
    }
    case 'pline': {
      const out: Prim[] = [], n = s.v.length, m = s.closed ? n : n - 1;
      for (let i = 0; i < m; i++) {
        const a = s.v[i], b = s.v[(i + 1) % n];
        if (same(a, b)) continue;
        out.push(a.b ? bulgeArc(a, b, a.b) : { k: 's', a: P(a.x, a.y), b: P(b.x, b.y) });
      }
      return out;
    }
  }
}
export const isClosedShape = (s: Shape2) => s.t === 'circle' || (s.t === 'ellipse' && (s.a0 === undefined || s.a1 === undefined))
  || (s.t === 'pline' && !!s.closed);
const arcOfPrim = (p: Arc): ArcS | CircleS => (Math.abs(p.sw) >= TAU - ANG_EPS
  ? { t: 'circle', c: p.c, r: p.r }
  : p.sw >= 0 ? { t: 'arc', c: p.c, r: p.r, a0: normAng(p.a0), a1: normAng(p.a0 + p.sw) }
    : { t: 'arc', c: p.c, r: p.r, a0: normAng(p.a0 + p.sw), a1: normAng(p.a0) });
const ellOfPrim = (p: Ell): EllipseS => (Math.abs(p.sw) >= TAU - ANG_EPS
  ? { t: 'ellipse', c: p.c, mx: p.mx, ratio: p.ratio }
  : p.sw >= 0 ? { t: 'ellipse', c: p.c, mx: p.mx, ratio: p.ratio, a0: normAng(p.a0), a1: normAng(p.a0 + p.sw) }
    : { t: 'ellipse', c: p.c, mx: p.mx, ratio: p.ratio, a0: normAng(p.a0 + p.sw), a1: normAng(p.a0) });
function plineOfPrims(ps: Prim[], closed = false): PlineS {
  const v: PV[] = ps.map(p => { const s = primStart(p); return p.k === 'a' ? { x: s.x, y: s.y, b: Math.tan(p.sw / 4) } : { x: s.x, y: s.y }; });
  if (!closed && ps.length) { const e = primEnd(ps[ps.length - 1]); v.push({ x: e.x, y: e.y }); }
  return { t: 'pline', v, closed: closed || undefined };
}
/** İlkel dizisinden nesne: `like` polyline ise polyline, değilse tek ilkele indirgenir (aynı çember/elips üzerindeki ardışık parçalar birleşir). */
function shapeOfPrims(ps: Prim[], like: Shape2['t']): Shape2 | null {
  const live = ps.filter(p => primLen(p) > LEN_EPS);
  if (!live.length) return null;
  if (like === 'pline') return plineOfPrims(live);
  const m = { ...live[0] } as Prim;
  for (let i = 1; i < live.length; i++) { if (m.k !== 's' && live[i].k === m.k) m.sw += (live[i] as Arc).sw; }
  return m.k === 's' ? L(m.a, m.b) : m.k === 'a' ? arcOfPrim(m) : ellOfPrim(m);
}

// ═════════════════════════════════════════════════ 3. KESİŞİM ═════════════════════════════════════════════════════════
/** Sonsuz doğruların kesişimi; t: ab üzerinde, u: cd üzerinde parametre. */
function xLL(a: P2, b: P2, c: P2, d: P2): { p: P2; t: number; u: number } | null {
  const r = sub(b, a), s = sub(d, c), den = cross(r, s);
  if (Math.abs(den) < 1e-12 * (vlen(r) * vlen(s) + 1e-12)) return null;
  const t = cross(sub(c, a), s) / den, u = cross(sub(c, a), r) / den;
  return { p: add(a, mul(r, t)), t, u };
}
function xLineCircle(a: P2, b: P2, c: P2, r: number): { p: P2; t: number }[] {
  const d = sub(b, a), f = sub(a, c), A = dot(d, d);
  if (A < 1e-18) return [];
  const B = 2 * dot(f, d), C = dot(f, f) - r * r;
  let disc = B * B - 4 * A * C;
  if (disc < -1e-9 * A * Math.max(r * r, 1)) return [];
  disc = Math.max(0, disc);
  const sq = Math.sqrt(disc), t1 = (-B - sq) / (2 * A), t2 = (-B + sq) / (2 * A);
  return sq < 1e-9 * Math.sqrt(A) ? [{ p: add(a, mul(d, t1)), t: t1 }] : [{ p: add(a, mul(d, t1)), t: t1 }, { p: add(a, mul(d, t2)), t: t2 }];
}
function xCC(c1: P2, r1: number, c2: P2, r2: number): P2[] {
  const d = dist(c1, c2);
  if (d < 1e-9 || d > r1 + r2 + 1e-7 || d < Math.abs(r1 - r2) - 1e-7) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d), h2 = r1 * r1 - a * a, u = unit(sub(c2, c1)), m = add(c1, mul(u, a));
  if (h2 <= 1e-9) return [m];
  const h = Math.sqrt(h2), n = perp(u);
  return [add(m, mul(n, h)), sub(m, mul(n, h))];
}
const segRange = (t: number, len: number) => { const e = LEN_EPS / Math.max(len, 1e-9); return t >= -e && t <= 1 + e; };
function xSegEll(s: Seg, e: Ell): P2[] {
  const a = vlen(e.mx), b = a * e.ratio, ux = unit(e.mx), uy = perp(ux);
  const loc = (p: P2) => { const d = sub(p, e.c); return P(dot(d, ux) / a, dot(d, uy) / b); };
  const A = loc(s.a), B = loc(s.b), len = dist(s.a, s.b);
  return xLineCircle(A, B, P(0, 0), 1).filter(h => segRange(h.t, len)).map(h => lerp(s.a, s.b, h.t))
    .filter(p => arcT({ c: P(0, 0), a0: e.a0, sw: e.sw, r: a }, polar(ellParamOfPoint(e, p))) !== null);
}
function dedupe(pts: P2[], tol = 1e-5): P2[] {
  const out: P2[] = [];
  for (const p of pts) if (!out.some(q => same(p, q, tol))) out.push(p);
  return out;
}
function xPrim(p: Prim, q: Prim): P2[] {
  if (p.k === 'e' || q.k === 'e') {
    const e = (p.k === 'e' ? p : q) as Ell, o = p.k === 'e' ? q : p;
    if (o.k === 's') return xSegEll(o, e);
    const N = 180, out: P2[] = [];
    let prev = primPoint(e, 0);
    for (let i = 1; i <= N; i++) { const cur = primPoint(e, i / N); out.push(...xPrim({ k: 's', a: prev, b: cur }, o)); prev = cur; }
    return dedupe(out, 1e-3);
  }
  if (p.k === 's' && q.k === 's') {
    const h = xLL(p.a, p.b, q.a, q.b);
    return h && segRange(h.t, dist(p.a, p.b)) && segRange(h.u, dist(q.a, q.b)) ? [h.p] : [];
  }
  if (p.k === 's' && q.k === 'a') {
    const len = dist(p.a, p.b);
    return xLineCircle(p.a, p.b, q.c, q.r).filter(h => segRange(h.t, len) && arcT(q, h.p) !== null).map(h => h.p);
  }
  if (p.k === 'a' && q.k === 's') return xPrim(q, p);
  const A = p as Arc, B = q as Arc;
  return xCC(A.c, A.r, B.c, B.r).filter(pt => arcT(A, pt) !== null && arcT(B, pt) !== null);
}
export function intersectShapes(a: Shape2, b: Shape2): P2[] {
  const out: P2[] = [];
  for (const p of primsOf(a)) for (const q of primsOf(b)) out.push(...xPrim(p, q));
  return dedupe(out);
}

// ═════════════════════════════════════════════════ 4. NESNE İŞLEMLERİ ═════════════════════════════════════════════════
/** Nesneye en yakın nokta; u = ilkel indeksi + t (nesne parametresi). */
export function closestOn(s: Shape2, q: P2): { d: number; pt: P2; u: number; i: number; t: number } {
  const ps = primsOf(s);
  let best = { d: Infinity, pt: q, u: 0, i: 0, t: 0 };
  ps.forEach((p, i) => { const c = primClosest(p, q); if (c.d < best.d) best = { d: c.d, pt: c.pt, u: i + c.t, i, t: c.t }; });
  return best;
}
/** Nesnenin u0 → u1 arası parçası (kapalı nesnede u1 ≤ u0 ise başa sarar). */
function sliceShape(s: Shape2, u0: number, u1: number): Shape2 | null {
  const ps = primsOf(s), n = ps.length;
  if (!n) return null;
  if (isClosedShape(s) && u1 <= u0 + 1e-9) u1 += n;
  const out: Prim[] = [];
  for (let i = Math.floor(u0 + 1e-12); i < u1 - 1e-9; i++) {
    const lo = Math.max(u0, i) - i, hi = Math.min(u1, i + 1) - i;
    if (hi - lo > 1e-9) out.push(slicePrim(ps[((i % n) + n) % n], lo, hi));
  }
  return shapeOfPrims(out, s.t);
}
/** Çizim için noktalara döker (yaylar açıya göre bölünür). */
export function tessellate(s: Shape2 | Geo, step = Math.PI / 36): P2[] {
  if (s.t === 'box') return [s.a, P(s.b.x, s.a.y), s.b, P(s.a.x, s.b.y), s.a];
  if (s.t === 'line') return [s.a, s.b];
  const out: P2[] = [];
  for (const p of primsOf(s)) {
    if (p.k === 's') { if (!out.length) out.push(p.a); out.push(p.b); continue; }
    const n = Math.max(2, Math.ceil(Math.abs(p.sw) / step));
    for (let i = out.length ? 1 : 0; i <= n; i++) out.push(primPoint(p, i / n));
  }
  return out;
}
export function bboxOf(s: Shape2): { min: P2; max: P2 } {
  const pts = tessellate(s, Math.PI / 24);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { min: P(x0, y0), max: P(x1, y1) };
}
const bboxOfAll = (ss: Shape2[]) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of ss) { const b = bboxOf(s); x0 = Math.min(x0, b.min.x); y0 = Math.min(y0, b.min.y); x1 = Math.max(x1, b.max.x); y1 = Math.max(y1, b.max.y); }
  return { min: P(x0, y0), max: P(x1, y1) };
};

/** 2B benzerlik dönüşümü (öteleme · dönme · eşit ölçek · ayna): x' = a·x + c·y + e, y' = b·x + d·y + f. */
type M2 = { a: number; b: number; c: number; d: number; e: number; f: number };
const mTranslate = (v: P2): M2 => ({ a: 1, b: 0, c: 0, d: 1, e: v.x, f: v.y });
const mRotate = (o: P2, ang: number): M2 => {
  const k = Math.cos(ang), s = Math.sin(ang);
  return { a: k, b: s, c: -s, d: k, e: o.x - o.x * k + o.y * s, f: o.y - o.x * s - o.y * k };
};
const mScale = (o: P2, k: number): M2 => ({ a: k, b: 0, c: 0, d: k, e: o.x * (1 - k), f: o.y * (1 - k) });
const mMirror = (p: P2, q: P2): M2 => {
  const th = 2 * angOf(sub(q, p)), k = Math.cos(th), s = Math.sin(th);
  return { a: k, b: s, c: s, d: -k, e: p.x - p.x * k - p.y * s, f: p.y - p.x * s + p.y * k };
};
const mApply = (m: M2, p: P2): P2 => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });
const mVec = (m: M2, v: P2): P2 => ({ x: m.a * v.x + m.c * v.y, y: m.b * v.x + m.d * v.y });
export function transformShape<T extends Shape2>(s: T, m: M2): T {
  const det = m.a * m.d - m.b * m.c, k = Math.sqrt(Math.abs(det)), flip = det < 0;
  switch (s.t) {
    case 'line': return { ...s, a: mApply(m, s.a), b: mApply(m, s.b) };
    case 'circle': return { ...s, c: mApply(m, s.c), r: s.r * k };
    case 'arc': {
      const c = mApply(m, s.c), p0 = mApply(m, add(s.c, polar(s.a0, s.r))), p1 = mApply(m, add(s.c, polar(s.a1, s.r)));
      const a0 = angOf(sub(p0, c)), a1 = angOf(sub(p1, c));
      return { ...s, c, r: s.r * k, a0: normAng(flip ? a1 : a0), a1: normAng(flip ? a0 : a1) };
    }
    case 'ellipse': {
      const e = s as EllipseS, out: EllipseS = { ...e, c: mApply(m, e.c), mx: mVec(m, e.mx) };
      if (flip && e.a0 !== undefined && e.a1 !== undefined) { out.a0 = normAng(-e.a1); out.a1 = normAng(-e.a0); }
      return out as T;
    }
    case 'pline': return { ...s, v: s.v.map(v => { const p = mApply(m, v); return v.b ? { x: p.x, y: p.y, b: flip ? -v.b : v.b } : { x: p.x, y: p.y }; }) };
  }
}

// Yay kurucuları — hepsi saat yönünün tersine normalleştirilmiş ArcS döndürür.
function circleFrom3(p1: P2, p2: P2, p3: P2): { c: P2; r: number } | null {
  const d = 2 * (p1.x * (p2.y - p3.y) + p2.x * (p3.y - p1.y) + p3.x * (p1.y - p2.y));
  if (Math.abs(d) < 1e-9) return null;
  const s1 = dot(p1, p1), s2 = dot(p2, p2), s3 = dot(p3, p3);
  const c = P((s1 * (p2.y - p3.y) + s2 * (p3.y - p1.y) + s3 * (p1.y - p2.y)) / d, (s1 * (p3.x - p2.x) + s2 * (p1.x - p3.x) + s3 * (p2.x - p1.x)) / d);
  return { c, r: dist(c, p1) };
}
/** p1 → p2 → p3 yayının p1→p3 bulge değeri. */
function bulge3(p1: P2, p2: P2, p3: P2): number | null {
  const k = circleFrom3(p1, p2, p3);
  if (!k) return null;
  const a1 = angOf(sub(p1, k.c)), ccw = cross(sub(p2, p1), sub(p3, p2)) > 0;
  const sw = ccw ? ccwDelta(a1, angOf(sub(p3, k.c))) : -ccwDelta(angOf(sub(p3, k.c)), a1);
  return Math.tan(sw / 4);
}
const arcFromBulge = (a: P2, b: P2, bulge: number): ArcS | null => {
  if (!isFinite(bulge) || Math.abs(bulge) < 1e-9 || same(a, b)) return null;
  const s = arcOfPrim(bulgeArc(a, b, bulge));
  return s.t === 'arc' ? s : null;
};
const arc3 = (p1: P2, p2: P2, p3: P2): ArcS | null => { const b = bulge3(p1, p2, p3); return b === null ? null : arcFromBulge(p1, p3, b); };
/** Başlangıç + merkez + işaretli iç açı. */
const arcSCA = (s: P2, c: P2, incl: number): ArcS | null => {
  const r = dist(s, c);
  if (r < LEN_EPS || Math.abs(incl) < ANG_EPS) return null;
  const a = arcOfPrim({ k: 'a', c, r, a0: angOf(sub(s, c)), sw: Math.max(-TAU + 1e-6, Math.min(TAU - 1e-6, incl)) });
  return a.t === 'arc' ? a : null;
};
/** Başlangıç + merkez + bitiş yönü; cw → saat yönünde. */
const sweepSCE = (s: P2, c: P2, e: P2, cw: boolean) => { const d = ccwDelta(angOf(sub(s, c)), angOf(sub(e, c))); return cw ? d - TAU : d; };
/** r yarıçaplı çemberde kiriş uzunluğunun gördüğü açı (negatif kiriş → büyük yay). */
const chordIncl = (r: number, chord: number): number | null => {
  if (Math.abs(chord) > 2 * r + LEN_EPS || Math.abs(chord) < LEN_EPS || r < LEN_EPS) return null;
  const a = 2 * Math.asin(Math.min(1, Math.abs(chord) / (2 * r)));
  return chord < 0 ? TAU - a : a;
};
/** Başlangıç teğet yönü d olan, a'dan b'ye yayın bulge değeri. */
const bulgeFromTangent = (a: P2, b: P2, dirAng: number) => {
  const th = wrapPi(angOf(sub(b, a)) - dirAng);
  return Math.tan(Math.max(-Math.PI + 1e-6, Math.min(Math.PI - 1e-6, th)) / 2);
};
const arcSER = (s: P2, e: P2, r: number, cw: boolean): ArcS | null => {
  const d = dist(s, e), R = Math.abs(r);
  if (d < LEN_EPS || d > 2 * R + LEN_EPS) return null;
  const minor = 2 * Math.asin(Math.min(1, d / (2 * R))), incl = r < 0 ? TAU - minor : minor;
  return arcFromBulge(s, e, Math.tan((cw ? -incl : incl) / 4));
};
/** Bir parçanın (a→b, bulge) bitiş teğet açısı. */
const endTangent = (a: PV, b: P2) => angOf(sub(b, a)) + (a.b ? 2 * Math.atan(a.b) : 0);

function makeEllipse(c: P2, major: P2, minor: number): EllipseS | null {
  const a = vlen(major);
  if (a < LEN_EPS || minor < LEN_EPS) return null;
  return minor <= a ? { t: 'ellipse', c, mx: major, ratio: minor / a } : { t: 'ellipse', c, mx: mul(perp(unit(major)), minor), ratio: a / minor };
}
/** Dikdörtgen polyline: p1 köşesinden, rot açılı çerçevede (w,h) işaretli ölçülerle; yuvarlatma veya pah seçenekli. */
function rectPline(p1: P2, w: number, h: number, rot = 0, fil = 0, cham: [number, number] | null = null): PlineS {
  const ux = polar(rot), uy = perp(ux), W = Math.abs(w), H = Math.abs(h);
  const o = add(p1, add(mul(ux, Math.min(0, w)), mul(uy, Math.min(0, h))));
  const at = (x: number, y: number, b?: number): PV => { const p = add(o, add(mul(ux, x), mul(uy, y))); return b ? { x: p.x, y: p.y, b } : { x: p.x, y: p.y }; };
  const r = Math.min(fil, W / 2, H / 2);
  if (r > LEN_EPS) {
    const k = Math.tan(Math.PI / 8);
    return { t: 'pline', closed: true, v: [at(r, 0), at(W - r, 0, k), at(W, r), at(W, H - r, k), at(W - r, H), at(r, H, k), at(0, H - r), at(0, r, k)] };
  }
  if (cham && cham[0] > LEN_EPS && cham[1] > LEN_EPS && cham[0] + cham[1] <= Math.min(W, H) + LEN_EPS) {
    const [a, b] = cham;
    return { t: 'pline', closed: true, v: [at(a, 0), at(W - b, 0), at(W, a), at(W, H - b), at(W - a, H), at(b, H), at(0, H - a), at(0, b)] };
  }
  return { t: 'pline', closed: true, v: [at(0, 0), at(W, 0), at(W, H), at(0, H)] };
}
function polygonPline(c: P2, n: number, radius: number, towards: number, circumscribed: boolean): PlineS {
  const R = circumscribed ? radius / Math.cos(Math.PI / n) : radius, a0 = circumscribed ? towards + Math.PI / n : towards;
  return { t: 'pline', closed: true, v: Array.from({ length: n }, (_, i) => { const p = add(c, polar(a0 + (TAU * i) / n, R)); return { x: p.x, y: p.y }; }) };
}

// ── Kırpma / uzatma ──
const sortedParams = (s: Shape2, cutters: Shape2[]): number[] => {
  const ps = primsOf(s), us: number[] = [];
  ps.forEach((p, i) => {
    for (const c of cutters) for (const q of primsOf(c)) for (const x of xPrim(p, q)) us.push(i + primClosest(p, x).t);
  });
  us.sort((a, b) => a - b);
  return us.filter((u, i) => i === 0 || u - us[i - 1] > 1e-7);
};
/** Tıklanan parçayı en yakın kesişimler arasında keser. keep: kalan parçalar, cut: çıkan parça. Kesişim yoksa nesnenin tamamı çıkar. */
export function trimAt(s: Shape2, pick: P2, cutters: Shape2[]): { keep: Shape2[]; cut: Shape2 } | null {
  const n = primsOf(s).length;
  if (!n) return null;
  const us = sortedParams(s, cutters), u = closestOn(s, pick).u;
  if (isClosedShape(s)) {
    const cyc = us.map(x => (x >= n - 1e-9 ? x - n : x)).sort((a, b) => a - b).filter((x, i, arr) => i === 0 || x - arr[i - 1] > 1e-7);
    if (cyc.length < 2) return cyc.length === 0 ? { keep: [], cut: s } : null;
    let lo = cyc[cyc.length - 1], hi = cyc[0];
    for (let i = 0; i < cyc.length - 1; i++) if (u >= cyc[i] && u <= cyc[i + 1]) { lo = cyc[i]; hi = cyc[i + 1]; }
    const keep = sliceShape(s, hi, lo), cut = sliceShape(s, lo, hi);
    return keep && cut ? { keep: [keep], cut } : null;
  }
  const inner = us.filter(x => x > 1e-7 && x < n - 1e-7);
  const lo = Math.max(0, ...inner.filter(x => x < u - 1e-9)), hiC = inner.filter(x => x > u + 1e-9), hi = hiC.length ? Math.min(...hiC) : n;
  if (lo === 0 && hi === n) return { keep: [], cut: s };
  const keep: Shape2[] = [];
  if (lo > 0) { const a = sliceShape(s, 0, lo); if (a) keep.push(a); }
  if (hi < n) { const b = sliceShape(s, hi, n); if (b) keep.push(b); }
  const cut = sliceShape(s, lo, hi);
  return cut ? { keep, cut } : null;
}
/** Açık nesnenin tıklanan uca yakın ucunu en yakın sınıra kadar uzatır. */
export function extendAt(s: Shape2, pick: P2, bounds: Shape2[]): Shape2 | null {
  if (isClosedShape(s)) return null;
  const ps = primsOf(s), n = ps.length;
  if (!n) return null;
  const atEnd = closestOn(s, pick).u >= n / 2, p = atEnd ? ps[n - 1] : ps[0];
  // Uzantı ilkeli: uçtan dışarı doğru devam eder.
  let ext: Prim;
  if (p.k === 's') {
    const from = atEnd ? p.b : p.a, dir = unit(atEnd ? sub(p.b, p.a) : sub(p.a, p.b));
    ext = { k: 's', a: from, b: add(from, mul(dir, 1e7)) };
  } else {
    const rest = TAU - Math.abs(p.sw);
    if (rest < ANG_EPS) return null;
    const sg = p.sw < 0 ? -1 : 1;
    ext = atEnd ? { ...p, a0: p.a0 + p.sw, sw: sg * rest } : { ...p, a0: p.a0, sw: -sg * rest };
  }
  let bt = Infinity;
  const extLen = primLen(ext);
  for (const b of bounds) for (const q of primsOf(b)) for (const x of xPrim(ext, q)) {
    const t = primClosest(ext, x).t;
    if (t * extLen > 1e-4 && t < bt) bt = t;
  }
  if (!isFinite(bt)) return null;
  const esw = ext.k === 's' ? 0 : ext.sw * bt;
  const grown: Prim = p.k === 's'
    ? (atEnd ? { k: 's', a: p.a, b: primPoint(ext, bt) } : { k: 's', a: primPoint(ext, bt), b: p.b })
    : (atEnd ? { ...p, sw: p.sw + esw } : { ...p, a0: p.a0 + esw, sw: p.sw - esw });
  const out = [...ps];
  out[atEnd ? n - 1 : 0] = grown;
  return shapeOfPrims(out, s.t);
}

// ── Öteleme (offset) ──
function offsetPrim(p: Prim, d: number): Prim | null {
  if (p.k === 's') { const n = mul(perp(unit(sub(p.b, p.a))), d); return { k: 's', a: add(p.a, n), b: add(p.b, n) }; }
  if (p.k === 'a') { const r = p.sw >= 0 ? p.r - d : p.r + d; return r > LEN_EPS ? { ...p, r } : null; }
  return null;
}
/** side noktasının bulunduğu tarafa d kadar öteler (d verilmezse side'dan geçer). */
export function offsetShape(s: Shape2, d: number | null, side: P2): Shape2 | null {
  const ps = primsOf(s);
  if (!ps.length || ps.some(p => p.k === 'e')) return null;
  const c = closestOn(s, side), tan = primTan(ps[c.i], c.t);
  const sign = cross(tan, sub(side, c.pt)) >= 0 ? 1 : -1, amt = (d === null ? c.d : d) * sign;
  if (Math.abs(amt) < LEN_EPS) return null;
  const off = ps.map(p => offsetPrim(p, amt));
  if (off.some(p => !p)) return null;
  const o = off as Prim[];
  if (s.t !== 'pline') return shapeOfPrims(o, s.t);
  // Ardışık parçalar taşıyıcılarının (sonsuz doğru / tam çember) kesişiminde birleştirilir.
  const n = o.length, closed = !!s.closed, joins: (P2 | null)[] = [];
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = o[i], b = o[(i + 1) % n], near = primEnd(a);
    let cand: P2[] = [];
    if (a.k === 's' && b.k === 's') { const h = xLL(a.a, a.b, b.a, b.b); cand = h ? [h.p] : [near]; }
    else if (a.k === 's' && b.k === 'a') cand = xLineCircle(a.a, a.b, b.c, b.r).map(h => h.p);
    else if (a.k === 'a' && b.k === 's') cand = xLineCircle(b.a, b.b, a.c, a.r).map(h => h.p);
    else if (a.k === 'a' && b.k === 'a') cand = same(a.c, b.c) ? [near] : xCC(a.c, a.r, b.c, b.r);
    joins.push(cand.length ? cand.reduce((m, q) => (dist(q, near) < dist(m, near) ? q : m)) : null);
  }
  const fit = (p: Prim, from: P2, to: P2): Prim => {
    if (p.k === 's') return { k: 's', a: from, b: to };
    const q = p as Arc, a0 = angOf(sub(from, q.c)), a1 = angOf(sub(to, q.c));
    return { ...q, a0, sw: q.sw >= 0 ? (ccwDelta(a0, a1) || TAU) : -(ccwDelta(a1, a0) || TAU) };
  };
  const res = o.map((p, i) => {
    const from = (closed || i > 0) ? joins[(i - 1 + joins.length) % joins.length] : null, to = (closed || i < n - 1) ? joins[i % joins.length] : null;
    return fit(p, from ?? primStart(p), to ?? primEnd(p));
  });
  return plineOfPrims(res.filter(p => primLen(p) > LEN_EPS), closed);
}

// ── Köşe: yuvarlatma (fillet) / pah (chamfer) ──
type CornerSpec = { kind: 'fillet'; r: number } | { kind: 'chamfer'; d1: number; d2: number };
/** İki doğrunun köşesi: X kesişim, uA/uB korunacak yönler; tA/tB teğet (pah) noktaları ve aradaki bağlantı. */
function cornerOf(X: P2, uA: P2, uB: P2, spec: CornerSpec): { tA: P2; tB: P2; link: Shape2 | null } | null {
  const th = Math.acos(Math.max(-1, Math.min(1, dot(uA, uB))));
  if (th < 1e-6 || Math.PI - th < 1e-6) return null;
  if (spec.kind === 'chamfer') {
    const tA = add(X, mul(uA, spec.d1)), tB = add(X, mul(uB, spec.d2));
    return { tA, tB, link: spec.d1 > LEN_EPS || spec.d2 > LEN_EPS ? L(tA, tB) : null };
  }
  if (spec.r < LEN_EPS) return { tA: X, tB: X, link: null };
  const t = spec.r / Math.tan(th / 2), tA = add(X, mul(uA, t)), tB = add(X, mul(uB, t));
  const c = add(X, mul(unit(add(uA, uB)), spec.r / Math.sin(th / 2)));
  const a = angOf(sub(tA, c)), b = angOf(sub(tB, c));
  return { tA, tB, link: ccwDelta(a, b) <= Math.PI ? { t: 'arc', c, r: spec.r, a0: normAng(a), a1: normAng(b) } : { t: 'arc', c, r: spec.r, a0: normAng(b), a1: normAng(a) } };
}
/** İki ayrı çizgi arasında köşe; trim=false ise çizgiler olduğu gibi kalır. */
function cornerLines(A: LineS, pickA: P2, B: LineS, pickB: P2, spec: CornerSpec, trim: boolean): { a: LineS; b: LineS; link: Shape2 | null } | string {
  const h = xLL(A.a, A.b, B.a, B.b);
  if (!h) return 'Lines are parallel.';
  const X = h.p;
  const keepDir = (l: LineS, pick: P2) => {
    const pr = primClosest({ k: 's', a: l.a, b: l.b }, pick).pt;
    const far = dist(l.a, X) >= dist(l.b, X) ? l.a : l.b;
    return unit(sub(dist(pr, X) > LEN_EPS ? pr : far, X));
  };
  const uA = keepDir(A, pickA), uB = keepDir(B, pickB), k = cornerOf(X, uA, uB, spec);
  if (!k) return 'Lines are parallel.';
  const cutTo = (l: LineS, u: P2, t: P2): LineS => {
    const far = dot(sub(l.a, X), u) >= dot(sub(l.b, X), u) ? l.a : l.b;
    return far === l.a ? { ...l, a: far, b: t } : { ...l, a: t, b: far };
  };
  if (dot(sub(k.tA, X), uA) > Math.max(dist(A.a, X), dist(A.b, X)) + LEN_EPS || dot(sub(k.tB, X), uB) > Math.max(dist(B.a, X), dist(B.b, X)) + LEN_EPS) {
    return spec.kind === 'fillet' ? 'Radius is too large.' : 'Distance is too large.';
  }
  return { a: trim ? cutTo(A, uA, k.tA) : A, b: trim ? cutTo(B, uB, k.tB) : B, link: k.link };
}
/** Polyline'ın tek köşesine (vi) veya tüm köşelerine köşe uygular; yalnız iki yanı düz olan köşeler. */
function cornerPline(pl: PlineS, spec: CornerSpec, only: number | null): { shape: PlineS; count: number } {
  const n = pl.v.length, closed = !!pl.closed, out: PV[] = [];
  let count = 0;
  const segLen = (i: number) => dist(pl.v[i], pl.v[(i + 1) % n]);
  const need = spec.kind === 'fillet' ? null : [spec.d1, spec.d2];
  for (let i = 0; i < n; i++) {
    const v = pl.v[i], isCorner = closed || (i > 0 && i < n - 1);
    const prev = pl.v[(i - 1 + n) % n], next = pl.v[(i + 1) % n];
    if (!isCorner || (only !== null && only !== i) || prev.b || v.b) { out.push({ ...v }); continue; }
    const uIn = unit(sub(prev, v)), uOut = unit(sub(next, v)), k = cornerOf(v, uIn, uOut, spec);
    const lim = only === null ? 0.5 : 1;   // tüm köşelerde her parça iki köşe arasında paylaşılır
    if (!k || dist(k.tA, v) > segLen((i - 1 + n) % n) * lim + LEN_EPS || dist(k.tB, v) > segLen(i) * lim + LEN_EPS
      || (need && (need[0] < LEN_EPS && need[1] < LEN_EPS)) || same(k.tA, k.tB)) { out.push({ ...v }); continue; }
    const turn = cross(mul(uIn, -1), uOut), bulge = spec.kind === 'fillet' ? Math.tan((Math.PI - Math.acos(Math.max(-1, Math.min(1, dot(uIn, uOut))))) / 4) * (turn >= 0 ? 1 : -1) : 0;
    out.push(bulge ? { x: k.tA.x, y: k.tA.y, b: bulge } : { x: k.tA.x, y: k.tA.y }, { x: k.tB.x, y: k.tB.y });
    count++;
  }
  return { shape: { t: 'pline', v: out, closed: pl.closed }, count };
}

// ── Teğet çember çözümleri (TTR / TTT) ──
type TanObj = { k: 'l'; a: P2; b: P2 } | { k: 'c'; c: P2; r: number };
function tanObjOf(s: Shape2, pick: P2): TanObj | null {
  const ps = primsOf(s);
  if (!ps.length) return null;
  const p = ps[closestOn(s, pick).i];
  return p.k === 's' ? { k: 'l', a: p.a, b: p.b } : p.k === 'a' ? { k: 'c', c: p.c, r: p.r } : null;
}
const tanPoint = (o: TanObj, c: P2): P2 => (o.k === 'l' ? add(o.a, mul(unit(sub(o.b, o.a)), dot(sub(c, o.a), unit(sub(o.b, o.a))))) : add(o.c, mul(unit(sub(c, o.c)), o.r)));
const tanDist = (o: TanObj, p: P2) => (o.k === 'l' ? Math.abs(cross(unit(sub(o.b, o.a)), sub(p, o.a))) : Math.abs(dist(p, o.c) - o.r));
function solveTTR(a: TanObj, pa: P2, b: TanObj, pb: P2, r: number): CircleS | null {
  // Merkez, her nesneden r uzaklıktaki yerlerin kesişimindedir.
  const loci = (o: TanObj): TanObj[] => {
    if (o.k === 'l') { const n = mul(perp(unit(sub(o.b, o.a))), r); return [{ k: 'l', a: add(o.a, n), b: add(o.b, n) }, { k: 'l', a: sub(o.a, n), b: sub(o.b, n) }]; }
    const out: TanObj[] = [{ k: 'c', c: o.c, r: o.r + r }];
    if (Math.abs(o.r - r) > LEN_EPS) out.push({ k: 'c', c: o.c, r: Math.abs(o.r - r) });
    return out;
  };
  const cands: P2[] = [];
  for (const x of loci(a)) for (const y of loci(b)) {
    if (x.k === 'l' && y.k === 'l') { const h = xLL(x.a, x.b, y.a, y.b); if (h) cands.push(h.p); }
    else if (x.k === 'l' && y.k === 'c') cands.push(...xLineCircle(x.a, x.b, y.c, y.r).map(h => h.p));
    else if (x.k === 'c' && y.k === 'l') cands.push(...xLineCircle(y.a, y.b, x.c, x.r).map(h => h.p));
    else if (x.k === 'c' && y.k === 'c') cands.push(...xCC(x.c, x.r, y.c, y.r));
  }
  if (!cands.length) return null;
  const score = (c: P2) => dist(tanPoint(a, c), pa) + dist(tanPoint(b, c), pb);
  return { t: 'circle', c: cands.reduce((m, c) => (score(c) < score(m) ? c : m)), r };
}
function solveTTT(objs: TanObj[], picks: P2[]): CircleS | null {
  const f = (x: number[]) => objs.map(o => tanDist(o, P(x[0], x[1])) - x[2]);
  const solve3 = (A: number[][], b: number[]): number[] | null => {
    const m = A.map((r, i) => [...r, b[i]]);
    for (let i = 0; i < 3; i++) {
      let pv = i;
      for (let j = i + 1; j < 3; j++) if (Math.abs(m[j][i]) > Math.abs(m[pv][i])) pv = j;
      if (Math.abs(m[pv][i]) < 1e-12) return null;
      [m[i], m[pv]] = [m[pv], m[i]];
      for (let j = 0; j < 3; j++) if (j !== i) { const k = m[j][i] / m[i][i]; for (let c = i; c < 4; c++) m[j][c] -= k * m[i][c]; }
    }
    return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
  };
  const cen = mul(add(add(picks[0], picks[1]), picks[2]), 1 / 3);
  const starts = [cen, ...picks.map(p => lerp(cen, p, 0.5)), ...picks.map(p => lerp(cen, p, -0.6))];
  let best: { c: CircleS; s: number } | null = null;
  for (const st of starts) {
    let x = [st.x, st.y, Math.max(1e-3, objs.reduce((s, o) => s + tanDist(o, st), 0) / 3)];
    let ok = false;
    for (let it = 0; it < 60; it++) {
      const r0 = f(x);
      if (Math.max(...r0.map(Math.abs)) < 1e-8) { ok = true; break; }
      const h = 1e-6 * Math.max(1, Math.abs(x[2])), J = [0, 1, 2].map(() => [0, 0, 0]);
      for (let k = 0; k < 3; k++) { const y = [...x]; y[k] += h; const r1 = f(y); for (let i = 0; i < 3; i++) J[i][k] = (r1[i] - r0[i]) / h; }
      const dx = solve3(J, r0.map(v => -v));
      if (!dx) break;
      x = x.map((v, i) => v + dx[i]);
    }
    if (!ok || !(x[2] > LEN_EPS) || !x.every(isFinite)) continue;
    const c = P(x[0], x[1]), s = objs.reduce((sum, o, i) => sum + dist(tanPoint(o, c), picks[i]), 0);
    if (!best || s < best.s) best = { c: { t: 'circle', c, r: x[2] }, s };
  }
  return best ? best.c : null;
}

// ── Seçim penceresi / esnetme ──
const inBox = (p: P2, a: P2, b: P2) => p.x >= Math.min(a.x, b.x) - LEN_EPS && p.x <= Math.max(a.x, b.x) + LEN_EPS && p.y >= Math.min(a.y, b.y) - LEN_EPS && p.y <= Math.max(a.y, b.y) + LEN_EPS;
const boxContains = (s: Shape2, a: P2, b: P2) => { const bb = bboxOf(s); return inBox(bb.min, a, b) && inBox(bb.max, a, b); };
const boxCrosses = (s: Shape2, a: P2, b: P2) => boxContains(s, a, b)
  || intersectShapes(s, { t: 'pline', closed: true, v: [a, P(b.x, a.y), b, P(a.x, b.y)] }).length > 0;
/** Pencere içindeki uç/köşe noktalarını d kadar taşır; tamamı içerideyse nesne taşınır. */
function stretchShape<T extends Shape2>(s: T, a: P2, b: P2, d: P2): T {
  const mv = (p: P2) => (inBox(p, a, b) ? add(p, d) : p);
  switch (s.t) {
    case 'line': return { ...s, a: mv(s.a), b: mv(s.b) };
    case 'circle': case 'ellipse': return inBox(s.c, a, b) ? transformShape(s, mTranslate(d)) : s;
    case 'arc': {
      const p0 = add(s.c, polar(s.a0, s.r)), p1 = add(s.c, polar(s.a1, s.r)), i0 = inBox(p0, a, b), i1 = inBox(p1, a, b);
      if (i0 && i1) return transformShape(s, mTranslate(d));
      if (!i0 && !i1) return s;
      const arc = arcFromBulge(mv(p0), mv(p1), Math.tan(ccwDelta(s.a0, s.a1) / 4));
      return arc ? { ...s, ...arc } : s;
    }
    case 'pline': return { ...s, v: s.v.map(v => (inBox(v, a, b) ? { ...v, x: v.x + d.x, y: v.y + d.y } : v)) };
  }
}
/** Nesne boyunca (uzunlukla) nokta ve teğet açısı. */
function alongShape(s: Shape2, lenAt: number): { p: P2; ang: number } {
  const ps = primsOf(s);
  let rest = lenAt;
  for (let i = 0; i < ps.length; i++) {
    const l = primLen(ps[i]);
    if (rest <= l || i === ps.length - 1) { const t = l < LEN_EPS ? 0 : Math.min(1, rest / l); return { p: primPoint(ps[i], t), ang: angOf(primTan(ps[i], t)) }; }
    rest -= l;
  }
  return { p: P(0, 0), ang: 0 };
}
const shapeLength = (s: Shape2) => primsOf(s).reduce((l, p) => l + primLen(p), 0);

// ── Profil döngüleri — çizim adımı (kes / şekil ver; Geometry.applySketchFeatures) kapalı döngüleri buradan alır ──
const reversePrim = (p: Prim): Prim => (p.k === 's' ? { k: 's', a: p.b, b: p.a } : { ...p, a0: p.a0 + p.sw, sw: -p.sw });
const signedArea = (pts: P2[]) => { let a = 0; for (let i = 0; i < pts.length; i++) { const q = pts[(i + 1) % pts.length]; a += pts[i].x * q.y - q.x * pts[i].y; } return a / 2; };
const pointInPoly = (p: P2, poly: P2[]) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};
/** Döngü parçası: `mid` varsa start→to arası yay o noktadan geçer, yoksa doğru. */
export type ProfileSeg = { to: P2; mid?: P2 };
/** Kapalı profil: saat yönünün tersine; depth = kaç döngünün içinde (çift = dolu bölge, tek = ada/delik). */
export interface ProfileLoop { start: P2; segs: ProfileSeg[]; pts: P2[]; depth: number }
/** Nesnelerden kapalı döngüleri çıkarır: kapalı nesneler (daire · elips · kapalı polyline) doğrudan, açık nesneler (çizgi · yay · açık polyline)
 *  uç uca (tol) zincirlenerek. Kapanmayan zincirler `open` olarak sayılır. Elips parçaları doğru parçalarına bölünür. */
export function profileLoops(shapes: Shape2[], tol = 0.05): { loops: ProfileLoop[]; open: number } {
  const closed: Prim[][] = [], chains: Prim[][] = [];
  for (const s of shapes) {
    const ps = primsOf(s).filter(p => primLen(p) > LEN_EPS);
    if (ps.length) (isClosedShape(s) ? closed : chains).push(ps);
  }
  let open = 0;
  while (chains.length) {
    let cur = chains.pop()!;
    for (;;) {
      const end = primEnd(cur[cur.length - 1]);
      if (same(primStart(cur[0]), end, tol)) break;
      const i = chains.findIndex(c => same(primStart(c[0]), end, tol) || same(primEnd(c[c.length - 1]), end, tol));
      if (i < 0) break;
      const c = chains.splice(i, 1)[0];
      cur = cur.concat(same(primStart(c[0]), end, tol) ? c : c.slice().reverse().map(reversePrim));
    }
    const isLoop = same(primStart(cur[0]), primEnd(cur[cur.length - 1]), tol) && (cur.length > 1 || cur[0].k !== 's');
    if (isLoop) closed.push(cur); else open++;
  }
  const loops: ProfileLoop[] = [];
  for (const ps of closed) {
    let flat: (Seg | Arc)[] = [];
    for (const p of ps) {
      if (p.k === 'e') {
        const n = Math.max(8, Math.ceil(Math.abs(p.sw) / (Math.PI / 36)));
        for (let i = 0; i < n; i++) flat.push({ k: 's', a: primPoint(p, i / n), b: primPoint(p, (i + 1) / n) });
      } else if (p.k === 'a' && Math.abs(p.sw) > Math.PI * 1.5) flat.push(slicePrim(p, 0, 0.5) as Arc, slicePrim(p, 0.5, 1) as Arc);
      else flat.push(p);
    }
    const sample = (list: (Seg | Arc)[]) => list.flatMap(p => {
      if (p.k === 's') return [p.a];
      const n = Math.max(2, Math.ceil(Math.abs(p.sw) / (Math.PI / 18)));
      return Array.from({ length: n }, (_, i) => primPoint(p, i / n));
    });
    let pts = sample(flat);
    const area = signedArea(pts);
    if (Math.abs(area) < 1e-3) continue;
    if (area < 0) { flat = flat.slice().reverse().map(reversePrim) as (Seg | Arc)[]; pts = sample(flat); }
    const start = primStart(flat[0]);
    const segs: ProfileSeg[] = flat.map((p, i) => {
      const to = i === flat.length - 1 ? start : primEnd(p);
      return p.k === 's' ? { to } : { to, mid: primPoint(p, 0.5) };
    });
    loops.push({ start, segs, pts, depth: 0 });
  }
  for (const l of loops) l.depth = loops.filter(o => o !== l && pointInPoly(l.pts[0], o.pts)).length;
  loops.sort((a, b) => a.depth - b.depth);
  return { loops, open };
}
/** Nesneyi orijine göre X ve Y'de ayrı ölçekler. Eşit ölçek birebir; farklı ölçekte daire → elips, yay → elips yayı, yaylı polyline ve
 *  eğik elips → kırık çizgi (doğru parçalarına bölünür). */
export function scaleShapeXY(s: Shape2, sx: number, sy: number): Shape2 {
  if (Math.abs(sx - 1) < 1e-9 && Math.abs(sy - 1) < 1e-9) return s;
  if (Math.abs(sx - sy) < 1e-9) return transformShape(s, mScale(P(0, 0), sx));
  const sc = (p: P2): P2 => ({ x: p.x * sx, y: p.y * sy });
  const poly = (): PlineS => {
    const pts = tessellate(s, Math.PI / 36).map(sc), closed = isClosedShape(s);
    if (closed && pts.length > 1 && same(pts[0], pts[pts.length - 1])) pts.pop();
    return { t: 'pline', v: pts.map(p => ({ x: p.x, y: p.y })), closed: closed || undefined };
  };
  switch (s.t) {
    case 'line': return { t: 'line', a: sc(s.a), b: sc(s.b) };
    case 'circle': return { t: 'ellipse', c: sc(s.c), mx: P(s.r * sx, 0), ratio: sy / sx };
    case 'arc': return { t: 'ellipse', c: sc(s.c), mx: P(s.r * sx, 0), ratio: sy / sx, a0: s.a0, a1: s.a1 };
    case 'ellipse': return poly();
    case 'pline': return s.v.some(v => v.b) ? poly() : { t: 'pline', v: s.v.map(v => ({ x: v.x * sx, y: v.y * sy })), closed: s.closed };
  }
}
export const moveShape = <T extends Shape2>(s: T, d: P2): T => transformShape(s, mTranslate(d));

// ── PARAMETRİK NOKTALAR (Goker, Kas 2026 — "her çizgi her yönde parametrik büyüyüp küçülsün; bazı geometriler belirli bir yöne doğru büyüsün;
//    çizileni sonradan parametrik yapabileyim; tek çapa + uzama yöntemi de kalsın") ──
// Her nesnenin KONTROL NOKTALARI vardır: doğru = 2 uç · yay = başlangıç + bitiş (yay açısı korunur) · polyline = köşeler (bulge korunur) ·
// daire / elips = merkez. Her noktanın X'i ve Y'si AYRI bağlanır: L = sol / alt kenardan sabit · R = sağ / üst kenardan sabit ·
// C = yüz ortasından sabit · P = yüz ölçüsünün oranı · F = formül. Formül değişkenleri: W, H (yüz eni / boyu) + çağıranın verdikleri
// (gövde ölçüleri BW / BH / BD, gövdenin özel parametreleri).
export type BindKind = 'L' | 'R' | 'C' | 'P';
export type SketchBind = { k: BindKind; v: number } | { k: 'F'; e: string };
export interface PtBind { x: SketchBind; y: SketchBind }
/** Düzenleyicide noktanın bağ TERCİHİ: yalnız tür saklanır, değer her zaman çizimdeki koordinattan türetilir (F'de ifade saklanır). */
export type AxisPref = { k: BindKind } | { k: 'F'; e: string };
export interface PtPref { x?: AxisPref; y?: AxisPref }
/** Bağlanmamış noktaların varsayılanı: kenar türü ya da 'A' = en yakın kenar. */
export type BindDefault = 'L' | 'R' | 'C' | 'A';

const EXPR_FN: Record<string, (...a: number[]) => number> = {
  min: Math.min, max: Math.max, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil, sqrt: Math.sqrt,
};
/** Küçük, güvenli ifade değerlendirici: + − * / ^ ( ), sayılar (12.5 ya da 12,5), değişkenler, min / max / abs / round / floor / ceil / sqrt.
 *  Bilinmeyen ad, sözdizimi hatası ya da sonlu olmayan sonuç → null. (İşlev argümanlarında virgül ayırıcıdır, ondalık için nokta yazılır.) */
export function evalExpr(text: string, vars: Record<string, number>): number | null {
  const s = text;
  let i = 0, fnDepth = 0;
  const fail = (): never => { throw new Error('expr'); };
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const lookup = (name: string): number => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
    const k = Object.keys(vars).filter(v => v.toLowerCase() === name.toLowerCase());
    return k.length === 1 ? vars[k[0]] : fail();
  };
  const primary = (): number => {
    ws();
    if (s[i] === '(') { i++; const v = expr(); ws(); if (s[i] !== ')') fail(); i++; return v; }
    const rest = s.slice(i), m = (fnDepth ? /^(?:\d+(?:\.\d+)?|\.\d+)/ : /^(?:\d+(?:[.,]\d+)?|\.\d+)/).exec(rest);
    if (m) { i += m[0].length; return parseFloat(m[0].replace(',', '.')); }
    const id = /^[A-Za-z_À-ɏ][\wÀ-ɏ]*/.exec(rest);
    if (!id) return fail();
    i += id[0].length; ws();
    if (s[i] !== '(') return lookup(id[0]);
    const f = EXPR_FN[id[0].toLowerCase()];
    if (!f) return fail();
    i++; fnDepth++;
    const args = [expr()];
    for (ws(); s[i] === ',' || s[i] === ';'; ws()) { i++; args.push(expr()); }
    if (s[i] !== ')') fail();
    i++; fnDepth--;
    return f(...args);
  };
  const unary = (): number => { ws(); if (s[i] === '-') { i++; return -unary(); } if (s[i] === '+') { i++; return unary(); } return primary(); };
  const factor = (): number => { const b = unary(); ws(); if (s[i] === '^') { i++; return Math.pow(b, factor()); } return b; };
  const term = (): number => {
    let v = factor();
    for (ws(); s[i] === '*' || s[i] === '/'; ws()) { const op = s[i++], r = factor(); v = op === '*' ? v * r : v / r; }
    return v;
  };
  function expr(): number {
    let v = term();
    for (ws(); s[i] === '+' || s[i] === '-'; ws()) { const op = s[i++], r = term(); v = op === '+' ? v + r : v - r; }
    return v;
  }
  try { const v = expr(); ws(); return i === s.length && Number.isFinite(v) ? v : null; } catch { return null; }
}

/** Bağın verdiği koordinat (size = o eksendeki yüz ölçüsü). Formül çözülemezse null. */
export function bindCoord(b: SketchBind, size: number, vars: Record<string, number>): number | null {
  switch (b.k) {
    case 'L': return b.v;
    case 'R': return size - b.v;
    case 'C': return size / 2 + b.v;
    case 'P': return size * b.v;
    case 'F': return evalExpr(b.e, vars);
  }
}
/** Koordinattan bağ: tür verilir, değer o anki yüz ölçüsünden türetilir (nokta yerinde kalır). */
export function bindFrom(k: BindKind, coord: number, size: number): SketchBind {
  const r = (n: number, d: number) => Math.round(n * d) / d;
  return { k, v: k === 'L' ? r(coord, 1000) : k === 'R' ? r(size - coord, 1000) : k === 'C' ? r(coord - size / 2, 1000) : size > LEN_EPS ? r(coord / size, 1e6) : 0 };
}
/** En yakın kenar: tam ortadaysa C, sol / alt yarıdaysa L, değilse R. */
export const autoKind = (coord: number, size: number): 'L' | 'R' | 'C' => (Math.abs(coord - size / 2) < 0.5 ? 'C' : coord < size / 2 ? 'L' : 'R');
/** Bağın okunur ifadesi (formül alanında görünen): 50 · W-50 · W/2+20 · W*0.25 · formülün kendisi. S = eksenin ölçü adı (W ya da H). */
export function bindText(b: SketchBind, S: 'W' | 'H'): string {
  const n = (v: number) => fmt(v, 2);
  switch (b.k) {
    case 'L': return n(b.v);
    case 'R': return Math.abs(b.v) < 0.005 ? S : b.v > 0 ? `${S}-${n(b.v)}` : `${S}+${n(-b.v)}`;
    case 'C': return Math.abs(b.v) < 0.005 ? `${S}/2` : b.v > 0 ? `${S}/2+${n(b.v)}` : `${S}/2-${n(-b.v)}`;
    case 'P': return `${S}*${fmt(b.v, 4)}`;
    case 'F': return b.e;
  }
}
/** Yazılan metinden bağ: sade kalıplar (50 · W-50 · W/2+20 · W*0.25) kenar bağına, gerisi formüle döner. Çözülemeyen metin → null. */
export function parseBind(text: string, S: 'W' | 'H', vars: Record<string, number>): SketchBind | null {
  if (evalExpr(text, vars) === null) return null;
  const t = text.replace(/\s+/g, ''), num = '(\\d+(?:[.,]\\d+)?|\\.\\d+)', f = (x: string) => parseFloat(x.replace(',', '.'));
  const re = (p: string) => new RegExp(`^${p}$`, 'i').exec(t);
  let m: RegExpExecArray | null;
  if ((m = re(`(-?)${num}`))) return { k: 'L', v: (m[1] ? -1 : 1) * f(m[2]) };
  if (re(S)) return { k: 'R', v: 0 };
  if ((m = re(`${S}([+-])${num}`))) return { k: 'R', v: (m[1] === '-' ? 1 : -1) * f(m[2]) };
  if (re(`${S}/2`)) return { k: 'C', v: 0 };
  if ((m = re(`${S}/2([+-])${num}`))) return { k: 'C', v: (m[1] === '+' ? 1 : -1) * f(m[2]) };
  if ((m = re(`${S}\\*${num}`)) || (m = re(`${num}\\*${S}`))) return { k: 'P', v: f(m[1]) };
  return { k: 'F', e: text.trim() };
}

/** Nesnenin kontrol noktaları: doğru 2 uç · yay başlangıç + bitiş · polyline köşeleri · daire / elips merkezi. */
export function ctrlPoints(s: Shape2): P2[] {
  switch (s.t) {
    case 'line': return [s.a, s.b];
    case 'circle': case 'ellipse': return [s.c];
    case 'arc': return [add(s.c, polar(s.a0, s.r)), add(s.c, polar(s.a1, s.r))];
    case 'pline': return s.v.map(v => P(v.x, v.y));
  }
}
/** Kontrol noktaları değiştirilmiş nesne: yayda yeni uçlar + eski yay açısından merkez / yarıçap yeniden bulunur; polyline'da bulge korunur;
 *  dairede isteğe bağlı yeni yarıçap. */
export function withCtrl(s: Shape2, pts: P2[], r?: number): Shape2 {
  switch (s.t) {
    case 'line': return { ...s, a: pts[0], b: pts[1] };
    case 'circle': return { ...s, c: pts[0], r: r !== undefined && r > LEN_EPS ? r : s.r };
    case 'ellipse': return { ...s, c: pts[0] };
    case 'arc': {
      const arc = same(pts[0], pts[1]) ? null : arcFromBulge(pts[0], pts[1], Math.tan(ccwDelta(s.a0, s.a1) / 4));
      return arc ? { ...s, ...arc } : s;
    }
    case 'pline': return { ...s, v: s.v.map((v, i) => ({ ...v, x: pts[i].x, y: pts[i].y })) };
  }
}
/** Nokta bağlı adımın nesnelerini verilen yüz ölçüsünde çözer (koordinatlar yüz çerçevesinde: orijin = yüzün sol-alt köşesi).
 *  Formül çözülemezse hata fırlatır → adım uygulanmaz, listede uyarı görünür. */
export function resolveParam(shapes: Shape2[], pts: PtBind[][], radii: (string | null)[] | undefined, w: number, h: number, vars: Record<string, number>): Shape2[] {
  const v = { ...vars, W: w, H: h };
  const need = (b: SketchBind, size: number): number => {
    const c = bindCoord(b, size, v);
    if (c === null) throw new Error(`Formula "${b.k === 'F' ? b.e : ''}" could not be evaluated`);
    return c;
  };
  return shapes.map((s, i) => {
    const bs = pts[i] ?? [], np = ctrlPoints(s).map((p, j) => (bs[j] ? P(need(bs[j].x, w), need(bs[j].y, h)) : p));
    const re = s.t === 'circle' ? radii?.[i] : null;
    let r: number | undefined;
    if (re) { const x = evalExpr(re, v); if (x === null || x <= 0) throw new Error(`Radius formula "${re}" could not be evaluated`); r = x; }
    return withCtrl(s, np, r);
  });
}
/** Düzenleyicideki nokta tercihlerinden adımın bağları (nesne yüz çerçevesi koordinatında verilir): tür tercihten — yoksa varsayılandan,
 *  'A' = en yakın kenar — değer koordinattan. Formüllü nokta elle taşınmışsa (formül artık o koordinatı vermiyorsa) formül düşer. */
export function bindsOf(s: Shape2, prefs: (PtPref | undefined)[] | undefined, w: number, h: number, dflt: [BindDefault, BindDefault], vars: Record<string, number>): PtBind[] {
  const v = { ...vars, W: w, H: h };
  const axis = (pref: AxisPref | undefined, coord: number, size: number, d: BindDefault): SketchBind => {
    if (pref?.k === 'F') { const val = evalExpr(pref.e, v); if (val !== null && Math.abs(val - coord) < 0.02) return { k: 'F', e: pref.e }; }
    return bindFrom(pref && pref.k !== 'F' ? pref.k : d === 'A' ? autoKind(coord, size) : d, coord, size);
  };
  return ctrlPoints(s).map((p, j) => ({ x: axis(prefs?.[j]?.x, p.x, w, dflt[0]), y: axis(prefs?.[j]?.y, p.y, h, dflt[1]) }));
}
/** Adımın bağlarından düzenleyici tercihleri (adım düzenlemeye açılırken). */
export const prefsOf = (pts: PtBind[] | undefined): PtPref[] | undefined =>
  pts?.map(b => ({ x: b.x.k === 'F' ? { k: 'F', e: b.x.e } : { k: b.x.k }, y: b.y.k === 'F' ? { k: 'F', e: b.y.e } : { k: b.y.k } }));

// ═════════════════════════════════════════════════ 5. NESNE YAKALAMA ══════════════════════════════════════════════════
export type SnapKind = 'endpoint' | 'midpoint' | 'center' | 'quadrant' | 'intersection' | 'perpendicular' | 'tangent' | 'nearest';
export const SNAP_KINDS: SnapKind[] = ['endpoint', 'midpoint', 'center', 'quadrant', 'intersection', 'perpendicular', 'tangent', 'nearest'];
export const SNAP_LABEL: Record<SnapKind, string> = {
  endpoint: 'Endpoint', midpoint: 'Midpoint', center: 'Center', quadrant: 'Quadrant', intersection: 'Intersection',
  perpendicular: 'Perpendicular', tangent: 'Tangent', nearest: 'Nearest',
};
export interface SnapHit { p: P2; kind: SnapKind }
/** İmlece tol içinde en uygun yakalama noktası. from: son nokta (dik / teğet için). */
export function findSnap(q: P2, tol: number, shapes: Shape2[], on: Record<SnapKind, boolean>, from: P2 | null): SnapHit | null {
  const near: { s: Shape2; ps: Prim[]; hit: boolean }[] = [];
  for (const s of shapes) {
    const ps = primsOf(s), hit = ps.some(p => primClosest(p, q).d <= tol);
    const centerNear = on.center && ps.some(p => p.k !== 's' && dist(p.c, q) <= tol);
    if (hit || centerNear) near.push({ s, ps, hit });
  }
  if (!near.length) return null;
  const cands: SnapHit[] = [];
  const push = (p: P2, kind: SnapKind) => { if (dist(p, q) <= tol) cands.push({ p, kind }); };
  for (const { s, ps, hit } of near) {
    const closed = isClosedShape(s);
    for (const p of ps) {
      if (on.endpoint && hit && !(closed && s.t !== 'pline')) { push(primStart(p), 'endpoint'); push(primEnd(p), 'endpoint'); }
      if (on.midpoint && hit && !(closed && s.t !== 'pline')) push(primPoint(p, 0.5), 'midpoint');
      if (on.center && p.k !== 's') cands.push({ p: p.c, kind: 'center' });
      if (on.quadrant && hit && p.k === 'a') for (let i = 0; i < 4; i++) { const pt = add(p.c, polar(i * Math.PI / 2, p.r)); if (arcT(p, pt) !== null) push(pt, 'quadrant'); }
      if (on.quadrant && hit && p.k === 'e') for (let i = 0; i < 4; i++) { if (arcT({ c: P(0, 0), a0: p.a0, sw: p.sw, r: 1 }, polar(i * Math.PI / 2)) !== null) push(ellPt(p, i * Math.PI / 2), 'quadrant'); }
      if (from && hit && on.perpendicular) {
        if (p.k === 's' && dist(p.a, p.b) > LEN_EPS) { const u = unit(sub(p.b, p.a)); push(add(p.a, mul(u, dot(sub(from, p.a), u))), 'perpendicular'); }
        if (p.k === 'a' && !same(from, p.c)) for (const sg of [1, -1]) { const pt = add(p.c, mul(unit(sub(from, p.c)), p.r * sg)); if (arcT(p, pt) !== null) push(pt, 'perpendicular'); }
      }
      if (from && hit && on.tangent && p.k === 'a') {
        const d = dist(from, p.c);
        if (d > p.r + LEN_EPS) {
          const base = angOf(sub(from, p.c)), off = Math.acos(p.r / d);
          const pts = [add(p.c, polar(base + off, p.r)), add(p.c, polar(base - off, p.r))].filter(pt => arcT(p, pt) !== null);
          // İmleç yay üzerindeyse yakın olan teğet noktası alınır (noktanın kendisinin tol içinde olması gerekmez).
          if (pts.length) cands.push({ p: pts.reduce((m, x) => (dist(x, q) < dist(m, q) ? x : m)), kind: 'tangent' });
        }
      }
      if (on.nearest && hit) cands.push({ p: primClosest(p, q).pt, kind: 'nearest' });
    }
  }
  if (on.intersection) {
    const hits = near.filter(n => n.hit);
    for (let i = 0; i < hits.length; i++) for (let j = i + 1; j < hits.length; j++) {
      for (const p of hits[i].ps) for (const r of hits[j].ps) for (const x of xPrim(p, r)) push(x, 'intersection');
    }
  }
  if (!cands.length) return null;
  // Öncelik: aynı mesafede kesişim/uç öne geçer; 'nearest' ve 'tangent' yalnız başka aday yoksa.
  const rank: Record<SnapKind, number> = { intersection: 0, endpoint: 0, midpoint: 0.02, center: 0.04, quadrant: 0.04, perpendicular: 0.3, tangent: 0.6, nearest: 1 };
  const cost = (c: SnapHit) => {
    const d = dist(c.p, q);
    if (c.kind === 'center') return d <= tol ? d / tol + rank.center : 0.9;   // eğri üzerindeyken merkez: doğrudan adaylara yenilir
    if (c.kind === 'tangent') return 0.95;
    return d / tol + rank[c.kind];
  };
  return cands.reduce((m, c) => (cost(c) < cost(m) ? c : m));
}

// ═════════════════════════════════════════════════ 6. DÜZLEM · DEPO · SÜRÜCÜ ══════════════════════════════════════════
/** Çizim düzlemi. Yüz düzleminde origin/u/v/n gövdenin (panelde üst gövdenin) YEREL koordinatlarındadır → çizim gövdeyle birlikte taşınır. */
export interface DraftPlane { id: string; kind: 'ground' | 'face'; shapeId?: string; origin: V3; u: V3; v: V3; n: V3; label: string }
export const GROUND_PLANE: DraftPlane = { id: 'ground', kind: 'ground', origin: [0, 0, 0], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0], label: 'Ground' };

export interface Opt { label: string; key: string }
export interface Mods { shift: boolean; ctrl: boolean; ent: Entity | null }
/** Komutun beklediği girdi. point: nokta (yakalama + ortho/polar); pick: nesne; value: yalnız klavye. */
export interface Req {
  prompt: string; kind: 'point' | 'pick' | 'value';
  opts?: Opt[]; def?: string; base?: P2 | null;
  /** Yazılan sayı komuta verilir (yoksa base'den "doğrudan mesafe" noktasına çevrilir). */
  num?: boolean;
  noSnap?: boolean; noTrack?: boolean;
  filter?: (e: Entity) => boolean;
  preview?: (cur: P2, m: Mods) => Geo[];
}
export type Ev = { k: 'pt'; p: P2; ent: Entity | null; shift: boolean; ctrl: boolean } | { k: 'opt'; key: string } | { k: 'num'; v: number } | { k: 'enter' };
type G<T = void> = Generator<Req, T, Ev>;

export interface CmdView { id: string; label: string; prompt: string; opts: Opt[]; def?: string; kind: Req['kind']; hasBase: boolean; num: boolean }
export interface CursorView { p: P2; raw: P2; snap: SnapHit | null; track: { from: P2; ang: number; kind: 'ortho' | 'polar' | 'lock' } | null; base: P2 | null }
export interface Aids { ortho: boolean; polar: boolean; polarStep: number; osnap: boolean; dyn: boolean; snaps: Record<SnapKind, boolean> }
export interface DraftState {
  planes: DraftPlane[]; activePlane: string; planePick: boolean;
  entities: Entity[]; selection: string[]; hoverId: string | null;
  undoStack: Entity[][]; redoStack: Entity[][];
  cmd: CmdView | null; log: string[]; cursor: CursorView | null; preview: Geo[];
  /** Dinamik giriş kilitleri: uzunluk (mm) ve açı (derece); Tab alan değiştirir. */
  dyn: { len: number | null; ang: number | null; field: 'len' | 'ang' };
  aids: Aids; lastCmd: string | null; recent: Record<string, string>;
  /** Komut satırında o an yazılan metin (imleç yanındaki dinamik girişte yankılanır). */
  typed: string;
  /** Sağdaki Drawing paneli açık mı. */
  panelOpen: boolean;
  /** Yüz seçiminde tıklanan ADAY yüz (vurgulanır; onaylanınca çizim düzlemi olur). */
  planeCandidate: { label: string } | null;
  /** Yüz çiziminde izolasyon: yalnız hedef (panel ya da gövde) çizilir, diğer paneller gizlenir. */
  isolate: DraftIsolate | null;
  /** Çizim adımı düzenleme oturumu: adımın nesneleri geçici olarak bu düzlemde durur. */
  session: { targetId: string; featureId: string; name: string; planeId: string } | null;
  /** Yüze uygulama ayarları (Cut / Shape, derinlik, çapa, uzama) — Drawing paneli. */
  apply: SketchApply;
  /** Parametric kip — seçili kontrol noktaları ("nesneId:sıra"). */
  psel: string[];
  /** Etkin yüzün çerçevesi (sahne katmanı yazar): düzlem koordinatı + (dx, dy) = yüz çerçevesi koordinatı (orijin yüzün sol-alt köşesi);
   *  w / h yüz ölçüsü; vars formül değişkenleri (W, H dahil). */
  face: DraftFace | null;
  /** Parametric önizleme: sanal yüz ölçüsü (null = kapalı) — çizimin o ölçüde alacağı hâl sahnede hayalet olarak çizilir. */
  pview: { w: number; h: number } | null;
}
export interface DraftFace { planeId: string; dx: number; dy: number; w: number; h: number; vars: Record<string, number> }
export interface DraftIsolate { targetId: string; bodyId: string; kind: 'panel' | 'body' }
/** mode: 'anchor' = tek çapa + uzama (eski yöntem) · 'points' = her nokta kenara / formüle bağlı. auto: bağlanmamış noktalar en yakın
 *  kenara bağlanır (kapalıysa çapaya). */
export interface SketchApply {
  op: 'cut' | 'shape'; through: boolean; depth: number; anchor: [number, number]; stretch: [boolean, boolean];
  mode: 'anchor' | 'points'; auto: boolean;
}
const DYN0 = { len: null, ang: null, field: 'len' as const };
export const useDraft = create<DraftState>(() => ({
  planes: [GROUND_PLANE], activePlane: GROUND_PLANE.id, planePick: false,
  entities: [], selection: [], hoverId: null, undoStack: [], redoStack: [],
  cmd: null, log: [], cursor: null, preview: [], dyn: DYN0,
  aids: {
    ortho: false, polar: true, polarStep: 45, osnap: true, dyn: true,
    snaps: { endpoint: true, midpoint: true, center: true, quadrant: true, intersection: true, perpendicular: true, tangent: false, nearest: false },
  },
  lastCmd: null, recent: {}, typed: '', panelOpen: false,
  planeCandidate: null, isolate: null, session: null,
  apply: { op: 'cut', through: true, depth: 8, anchor: [0, 0], stretch: [false, false], mode: 'anchor', auto: true },
  psel: [], face: null, pview: null,
}));
const get = useDraft.getState, set = useDraft.setState;

/** Komutlar arası kalıcı varsayılanlar (oturum boyunca). */
const vars = {
  radius: 0, polySides: 4, filletR: 0, cornerTrim: true, chamD1: 0, chamD2: 0, offsetDist: 0, rectFillet: 0, rectCham: null as [number, number] | null,
  copyMultiple: true, last: null as { p: P2; ang: number } | null, lastPoint: null as P2 | null,
};
let gen: G | null = null, req: Req | null = null, curDef: CmdDef | null = null, undoBase: Entity[] | null = null, seq = 0;
let lastMove: { raw: P2; tol: number; shift: boolean; ctrl: boolean } | null = null;
/** Aktif düzleme düşen gövde/panel kenarları — yalnız yakalama kaynağı (görünüm katmanı verir). */
let extraSnap: Shape2[] = [];
export const setExtraSnap = (s: Shape2[]) => { extraSnap = s; };
/** Yüz seçimini onaylayan işlev (sahne katmanı kaydolur; Enter ve sağ tık buraya düşer). */
let planeConfirm: (() => void) | null = null;
export const setPlaneConfirm = (f: (() => void) | null) => { planeConfirm = f; };
export const setTyped = (t: string) => { if (get().typed !== t) set({ typed: t }); };
export const setPanelOpen = (b: boolean) => set({ panelOpen: b });
export const setPlaneCandidate = (c: DraftState['planeCandidate']) => set({ planeCandidate: c });
export const setIsolate = (i: DraftIsolate | null) => set({ isolate: i });
export const setSession = (x: DraftState['session']) => set({ session: x });
export const setApply = (patch: Partial<SketchApply>) => set(s => ({ apply: { ...s.apply, ...patch } }));
export const setFace = (f: DraftFace | null) => set({ face: f });
export const setPView = (v: DraftState['pview']) => set({ pview: v });
export const setPSel = (keys: string[]) => set({ psel: keys });

const say = (t: string) => set(s => ({ log: [...s.log.slice(-59), t] }));
export const stripEnt = (e: Entity): Shape2 => { const s: Record<string, unknown> = { ...e }; delete s.id; delete s.plane; delete s.pb; delete s.re; return s as unknown as Shape2; };
/** Nesne güncellenirken nokta bağ tercihleri korunur (tür ve kontrol noktası sayısı aynıysa); yeni biçimle taşınan eski alanlar atılır. */
const keepPrefs = (old: Entity, next: Entity): Entity => {
  const out = { ...next };
  delete out.pb; delete out.re;
  if (old.pb && old.t === next.t && ctrlPoints(old).length === ctrlPoints(next).length) out.pb = old.pb;
  if (old.re && next.t === 'circle') out.re = old.re;
  return out;
};
const planeEnts = () => { const st = get(); return st.entities.filter(e => e.plane === st.activePlane); };

interface Ctx {
  ents(): Entity[]; add(s: Shape2): Entity; addAll(ss: Shape2[]): Entity[]; remove(ids: string[]): void; update(id: string, s: Shape2): void;
  sel(): Entity[]; setSel(ids: string[]): void; msg(t: string): void; snapshot(): Entity[]; restore(s: Entity[]): void; ctrl(): boolean;
}
const ctx: Ctx = {
  ents: planeEnts,
  add(s) {
    const e = { ...s, id: `d${Date.now().toString(36)}${(seq++).toString(36)}`, plane: get().activePlane } as Entity;
    delete e.pb; delete e.re;   // yeni nesne (kopya dahil) bağsız başlar → varsayılan bağ
    set(st => ({ entities: [...st.entities, e] }));
    return e;
  },
  addAll(ss) { return ss.map(s => this.add(s)); },
  remove(ids) { const k = new Set(ids); set(st => ({ entities: st.entities.filter(e => !k.has(e.id)), selection: st.selection.filter(i => !k.has(i)) })); },
  update(id, s) { set(st => ({ entities: st.entities.map(e => (e.id === id ? keepPrefs(e, { ...s, id, plane: e.plane } as Entity) : e)) })); },
  sel() { const k = new Set(get().selection); return planeEnts().filter(e => k.has(e.id)); },
  setSel(ids) { set({ selection: ids }); },
  msg: say,
  snapshot: () => get().entities,
  restore(s) { set({ entities: s }); },
  ctrl: () => !!lastMove?.ctrl,
};

const pickEntity = (ents: Entity[], q: P2, tol: number): Entity | null => {
  let best: Entity | null = null, bd = tol;
  for (const e of ents) { const d = closestOn(e, q).d; if (d <= bd) { bd = d; best = e; } }
  return best;
};
/** İmleci çözer: nesne yakalama → açı kilidi / ortho / polar → uzunluk kilidi. */
function resolve(m: NonNullable<typeof lastMove>): { cursor: CursorView; ent: Entity | null } {
  const st = get(), ents = planeEnts(), plain: CursorView = { p: m.raw, raw: m.raw, snap: null, track: null, base: null };
  if (!gen || !req) return { cursor: plain, ent: pickEntity(ents, m.raw, m.tol) };
  if (req.kind === 'pick') return { cursor: plain, ent: pickEntity(req.filter ? ents.filter(req.filter) : ents, m.raw, m.tol) };
  if (req.kind === 'value') return { cursor: plain, ent: null };
  const base = req.base ?? null, a = st.aids;
  let p = m.raw, snap: SnapHit | null = null, track: CursorView['track'] = null;
  if (base && st.dyn.ang !== null) {
    const ang = rad(st.dyn.ang);
    p = add(base, polar(ang, dist(m.raw, base)));
    track = { from: base, ang, kind: 'lock' };
  } else {
    if (a.osnap && !req.noSnap) snap = findSnap(m.raw, m.tol, [...ents, ...extraSnap], a.snaps, base);
    if (snap) p = snap.p;
    else if (base && !req.noTrack) {
      const d = sub(m.raw, base), ang = angOf(d);
      let lock: number | null = null, kind: 'ortho' | 'polar' = 'ortho';
      if (a.ortho) lock = Math.round(ang / (Math.PI / 2)) * (Math.PI / 2);
      else if (a.polar && vlen(d) > m.tol) {
        const stp = rad(a.polarStep), k = Math.round(ang / stp) * stp;
        if (Math.abs(wrapPi(ang - k)) < rad(3)) { lock = k; kind = 'polar'; }
      }
      if (lock !== null) { const u = polar(lock); p = add(base, mul(u, Math.max(0, dot(d, u)))); track = { from: base, ang: lock, kind }; }
    }
  }
  if (base && st.dyn.len !== null) p = add(base, mul(same(p, base) ? polar(0) : unit(sub(p, base)), st.dyn.len));
  return { cursor: { p, raw: m.raw, snap, track, base }, ent: null };
}
/** Depodaki komut görünümünü, imleci ve önizlemeyi yeniler. */
function refresh() {
  const view: CmdView | null = gen && req && curDef
    ? { id: curDef.id, label: curDef.label, prompt: req.prompt, opts: req.opts ?? [], def: req.def, kind: req.kind, hasBase: !!req.base, num: !!req.num } : null;
  const r = lastMove ? resolve(lastMove) : null;
  const at = r?.cursor.p ?? vars.lastPoint ?? P(0, 0);
  let preview: Geo[] = [];
  if (gen && req?.preview) {
    try { preview = req.preview(at, { shift: !!lastMove?.shift, ctrl: !!lastMove?.ctrl, ent: r?.ent ?? null }); } catch { preview = []; }
  }
  set({ cmd: view, cursor: r?.cursor ?? null, hoverId: r?.ent?.id ?? null, preview });
}
function finish() {
  const st = get();
  if (undoBase && undoBase !== st.entities) set({ undoStack: [...st.undoStack.slice(-49), undoBase], redoStack: [] });
  gen = null; req = null; curDef = null; undoBase = null;
  set({ dyn: DYN0 });
  refresh();
}
function advance(ev?: Ev) {
  if (!gen) return;
  let r: IteratorResult<Req, void>;
  try { r = gen.next(ev as Ev); }
  catch (e) { console.error('[YAGO][DRAFT] komut hatası:', e); say('Command failed.'); r = { done: true, value: undefined }; }
  if (r.done) { finish(); return; }
  req = r.value;
  set({ dyn: DYN0 });
  refresh();
}

export function cancelCommand(): boolean {
  if (!gen) return false;
  try { gen.return(undefined); } catch { /* üreteç zaten bitmiş */ }
  say('*Cancel*');
  finish();
  return true;
}
export const commandActive = () => !!gen;
export function undo() {
  cancelCommand();
  const st = get();
  if (!st.undoStack.length) { say('Nothing to undo.'); return; }
  set({ entities: st.undoStack[st.undoStack.length - 1], undoStack: st.undoStack.slice(0, -1), redoStack: [...st.redoStack, st.entities], selection: [] });
}
export function redo() {
  cancelCommand();
  const st = get();
  if (!st.redoStack.length) { say('Nothing to redo.'); return; }
  set({ entities: st.redoStack[st.redoStack.length - 1], redoStack: st.redoStack.slice(0, -1), undoStack: [...st.undoStack, st.entities], selection: [] });
}
/** Komutu adı veya kısaltmasıyla başlatır (LINE · L …). */
export function startCommand(name: string): boolean {
  const up = name.trim().toUpperCase();
  if (up === 'U' || up === 'UNDO') { undo(); return true; }
  if (up === 'REDO') { redo(); return true; }
  const def = COMMANDS.find(c => c.id === up || c.aliases.includes(up));
  if (!def) return false;
  cancelCommand();
  curDef = def; undoBase = get().entities;
  set(s => ({ lastCmd: def.id, recent: def.family ? { ...s.recent, [def.family]: def.id } : s.recent, planePick: false }));
  say(`Command: ${def.id}`);
  gen = def.run(ctx);
  advance();
  return true;
}
export function pointerMove(raw: P2, tol: number, shift: boolean, ctrl: boolean) { lastMove = { raw, tol, shift, ctrl }; refresh(); }
export function pointerLeave() { lastMove = null; set({ cursor: null, hoverId: null }); }
/** Sol tık. Komut girdiyi tükettiyse true. */
export function pointerClick(raw: P2, tol: number, shift: boolean, ctrl: boolean): boolean {
  lastMove = { raw, tol, shift, ctrl };
  if (!gen || !req) return false;
  if (req.kind === 'value') return true;
  const r = resolve(lastMove);
  if (req.kind === 'point') vars.lastPoint = r.cursor.p;
  advance({ k: 'pt', p: r.cursor.p, ent: r.ent, shift, ctrl });
  return true;
}
/** Enter / Boşluk / sağ tık: komut içindeyse onay, boştaysa son komutu yineler. */
export function enterKey() {
  if (gen) { advance({ k: 'enter' }); return; }
  // Yüz seçimi: Enter / sağ tık vurgulanan adayı onaylar (DraftView kaydolur).
  if (get().planePick) { planeConfirm?.(); return; }
  const last = get().lastCmd;
  if (last) startCommand(last);
}
const NUM = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)';
const parseNum = (s: string): number | null => (new RegExp(`^${NUM}$`).test(s) ? parseFloat(s) : null);
/** x,y · #x,y (mutlak) · @dx,dy (göreli) · d<a · @d<a (kutupsal, derece). */
function parsePoint(s: string, rel: P2 | null): P2 | null {
  const c = new RegExp(`^([@#]?)\\s*(${NUM})\\s*,\\s*(${NUM})$`).exec(s);
  if (c) { const v = P(parseFloat(c[2]), parseFloat(c[3])); return c[1] === '@' ? add(rel ?? P(0, 0), v) : v; }
  const p = new RegExp(`^([@#]?)\\s*(${NUM})\\s*<\\s*(${NUM})$`).exec(s);
  if (p) { const v = polar(rad(parseFloat(p[3])), parseFloat(p[2])); return p[1] === '@' ? add(rel ?? P(0, 0), v) : v; }
  return null;
}
const matchOpt = (opts: Opt[] | undefined, up: string): Opt | undefined => opts?.find(o => {
  const lab = o.label.toUpperCase().replace(/\s+/g, ''), u = up.replace(/\s+/g, '');
  return u === o.key || u === lab || (u.length > o.key.length && lab.startsWith(o.key) && lab.startsWith(u));
});
/** Komut satırından gelen metin: seçenek harfi · koordinat · sayı · komut adı. */
export function submitText(text: string) {
  const s = text.trim();
  if (!gen || !req) {
    if (!s) { enterKey(); return; }
    if (!startCommand(s)) say(`Unknown command "${s}".`);
    return;
  }
  if (!s) { enterKey(); return; }
  const opt = matchOpt(req.opts, s.toUpperCase());
  if (opt) { advance({ k: 'opt', key: opt.key }); return; }
  const base = req.base ?? null, st = get();
  const commit = (p: P2) => { vars.lastPoint = p; advance({ k: 'pt', p, ent: null, shift: false, ctrl: !!lastMove?.ctrl }); };
  if (req.kind === 'point') {
    const am = new RegExp(`^<\\s*(${NUM})$`).exec(s);
    if (am && base) { set({ dyn: { ...st.dyn, ang: parseFloat(am[1]) } }); refresh(); return; }
    const pt = parsePoint(s, base ?? vars.lastPoint);
    if (pt) { commit(pt); return; }
  }
  const n = parseNum(s);
  if (n !== null) {
    if (req.num || req.kind !== 'point') { advance({ k: 'num', v: n }); return; }
    if (base) {
      const d = st.dyn;
      if (d.field === 'ang') {
        if (d.len !== null) commit(add(base, polar(rad(n), d.len)));
        else { set({ dyn: { ...d, ang: n } }); refresh(); }
        return;
      }
      const toward = lastMove ? resolve(lastMove).cursor.p : add(base, P(1, 0));
      const u = d.ang !== null ? polar(rad(d.ang)) : same(toward, base) ? P(1, 0) : unit(sub(toward, base));
      commit(add(base, mul(u, n)));
      return;
    }
  }
  say(req.kind === 'point' ? 'Point or option keyword required.' : req.kind === 'pick' ? 'Select an object or enter an option keyword.' : 'Invalid input.');
}
/** Tab: yazılan sayı etkin alana (uzunluk / açı) kilitlenir, alan değişir. Tüketildiyse true. */
export function tabKey(typed: string): boolean {
  if (!gen || !req || req.kind !== 'point' || !req.base || req.num) return false;
  const st = get(), n = parseNum(typed.trim()), d = { ...st.dyn };
  if (n !== null) { if (d.field === 'len') d.len = n; else d.ang = n; }
  d.field = d.field === 'len' ? 'ang' : 'len';
  set({ dyn: d });
  refresh();
  return true;
}
export function setAids(patch: Partial<Aids>) { set(s => ({ aids: { ...s.aids, ...patch } })); if (gen) refresh(); }

// ── Seçim ve düzlem (boşta) ──
export function selectEntity(id: string | null, additive = false) {
  const st = get();
  if (!id) { if (st.selection.length || st.psel.length) set({ selection: [], psel: [] }); return; }
  const e = st.entities.find(x => x.id === id);
  if (!e) return;
  if (e.plane !== st.activePlane) { set({ activePlane: e.plane, selection: [id], psel: [] }); return; }
  set({ selection: additive ? (st.selection.includes(id) ? st.selection.filter(i => i !== id) : [...st.selection, id]) : [id], psel: [] });
}
export function eraseSelection(): boolean {
  const st = get();
  if (!st.selection.length) return false;
  const k = new Set(st.selection);
  set({ entities: st.entities.filter(e => !k.has(e.id)), selection: [], undoStack: [...st.undoStack.slice(-49), st.entities], redoStack: [] });
  say(`${k.size} object(s) erased.`);
  return true;
}
const near3 = (a: V3, b: V3, tol: number) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
/** Çizim düzlemini etkinleştirir; aynı yüz daha önce kullanıldıysa o düzlem (ve üzerindeki çizimler) yeniden kullanılır. */
/** fresh: mevcut düzlem yeniden kullanılmaz (adım düzenleme oturumu kendi düzleminde çalışır). Etkinleşen düzlemin id'si döner. */
export function activatePlane(pl: Omit<DraftPlane, 'id'> | 'ground', fresh = false): string {
  cancelCommand();
  const st = get();
  if (pl === 'ground') { set({ activePlane: GROUND_PLANE.id, planePick: false, planeCandidate: null, selection: [], psel: [], pview: null }); return GROUND_PLANE.id; }
  const hit = fresh ? undefined
    : st.planes.find(q => q.kind === 'face' && q.id !== st.session?.planeId && q.shapeId === pl.shapeId && near3(q.n, pl.n, 1e-4) && near3(q.origin, pl.origin, 0.05) && near3(q.u, pl.u, 1e-4));
  const used = new Set(st.entities.map(e => e.plane));
  const plane: DraftPlane = hit ?? { ...pl, id: `pl${Date.now().toString(36)}${(seq++).toString(36)}` };
  set({ planes: [...st.planes.filter(q => q.id === GROUND_PLANE.id || q.id === plane.id || used.has(q.id)).filter(q => q.id !== plane.id), plane],
    activePlane: plane.id, planePick: false, planeCandidate: null, selection: [], psel: [], pview: null });
  return plane.id;
}
export const setPlanePick = (on: boolean) => { if (on) cancelCommand(); set({ planePick: on, planeCandidate: null }); };
/** Nesneleri bir düzleme yükler (adım düzenleme oturumu); geri alma yığınına girmez. */
export function loadEntities(shapes: Shape2[], planeId: string, prefs?: (PtPref[] | undefined)[], radii?: (string | null | undefined)[]): Entity[] {
  const made = shapes.map((s, i) => ({
    ...s, id: `d${Date.now().toString(36)}${(seq++).toString(36)}`, plane: planeId,
    ...(prefs?.[i] ? { pb: prefs[i] } : {}), ...(radii?.[i] && s.t === 'circle' ? { re: radii[i]! } : {}),
  }) as Entity);
  set(st => ({ entities: [...st.entities, ...made] }));
  return made;
}
/** Düzlemdeki (ids verilirse yalnız onlar) nesneleri depodan çıkarır ve biçimlerini döndürür. Geri alma yığınları temizlenir:
 *  nesneler artık bir çizim adımına aittir, eski anlık görüntüler onları serbest çizim olarak geri getirmemeli. */
export function takeEntities(planeId: string, ids?: string[]): Shape2[] {
  const k = ids ? new Set(ids) : null, st = get();
  const taken = st.entities.filter(e => e.plane === planeId && (!k || k.has(e.id)));
  const gone = new Set(taken.map(e => e.id));
  set({ entities: st.entities.filter(e => !gone.has(e.id)), selection: st.selection.filter(i => !gone.has(i)), undoStack: [], redoStack: [], psel: [] });
  return taken.map(stripEnt);
}

// ── Parametric kip: nokta seçimi ve bağ atama ──
export const ptKey = (id: string, i: number) => `${id}:${i}`;
const splitKey = (k: string): [string, number] => { const j = k.lastIndexOf(':'); return [k.slice(0, j), +k.slice(j + 1)]; };
const groupKeys = (keys: string[]) => { const m = new Map<string, number[]>(); for (const k of keys) { const [id, i] = splitKey(k); m.set(id, [...(m.get(id) ?? []), i]); } return m; };
/** Bağ düğmelerinin hedefi: seçili noktalar; hiç yoksa seçili nesnelerin tüm noktaları (etkin düzlemde). */
export function paramTargets(st: Pick<DraftState, 'entities' | 'activePlane' | 'psel' | 'selection'> = get()): string[] {
  const on = new Map(st.entities.filter(e => e.plane === st.activePlane).map(e => [e.id, e]));
  const live = st.psel.filter(k => { const [id, i] = splitKey(k), e = on.get(id); return !!e && i < ctrlPoints(e).length; });
  if (live.length) return live;
  return st.selection.flatMap(id => { const e = on.get(id); return e ? ctrlPoints(e).map((_, i) => ptKey(id, i)) : []; });
}
/** İmlecin altındaki kontrol noktası (etkin düzlem). */
export function pointAt(q: P2, tol: number): string | null {
  let best: string | null = null, bd = tol;
  for (const e of planeEnts()) ctrlPoints(e).forEach((p, i) => { const d = dist(p, q); if (d <= bd) { bd = d; best = ptKey(e.id, i); } });
  return best;
}
/** Noktayı seçer; additive: seçime ekler / seçiliyse çıkarır. */
export function togglePoint(key: string, additive: boolean) {
  const cur = get().psel;
  set({ psel: additive ? (cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key]) : [key], selection: [] });
}
function mapEnts(ids: Set<string>, f: (e: Entity) => Entity, undoable: boolean) {
  const st = get(), next = st.entities.map(e => (ids.has(e.id) ? f(e) : e));
  set(undoable ? { entities: next, undoStack: [...st.undoStack.slice(-49), st.entities], redoStack: [] } : { entities: next });
}
const prefsArr = (e: Entity): PtPref[] => ctrlPoints(e).map((_, i) => ({ ...(e.pb?.[i] ?? {}) }));
/** Noktalara bağ TÜRÜ verir — nokta yerinde kalır, yalnız hangi kenara bağlı olduğu değişir. pref null: tercih silinir (varsayılana döner). */
export function setPointPrefs(keys: string[], axis: 'x' | 'y', pref: AxisPref | null) {
  const by = groupKeys(keys);
  mapEnts(new Set(by.keys()), e => {
    const pb = prefsArr(e);
    for (const i of by.get(e.id)!) if (pb[i]) { if (pref) pb[i][axis] = pref; else delete pb[i][axis]; }
    return { ...e, pb };
  }, false);
}
/** Noktaları o eksende verilen koordinata TAŞIR (düzlem koordinatı) ve bağ tercihini yazar — değer / formül girişi. Geri alınabilir. */
export function movePointsTo(keys: string[], axis: 'x' | 'y', coord: number, pref: AxisPref) {
  const by = groupKeys(keys);
  mapEnts(new Set(by.keys()), e => {
    const cp = ctrlPoints(e), pb = prefsArr(e);
    for (const i of by.get(e.id)!) if (cp[i]) { cp[i] = axis === 'x' ? P(coord, cp[i].y) : P(cp[i].x, coord); pb[i][axis] = pref; }
    return { ...(withCtrl(e, cp) as Entity), pb };
  }, true);
}
/** Dairelerin yarıçapı: r uygulanır; expr verilirse formül olarak saklanır (yüz ölçüsü değişince yeniden hesaplanır). Geri alınabilir. */
export function setCircleRadius(ids: string[], r: number, expr: string | null) {
  mapEnts(new Set(ids), e => {
    if (e.t !== 'circle' || !(r > LEN_EPS)) return e;
    const out: Entity = { ...e, r };
    if (expr) out.re = expr; else delete out.re;
    return out;
  }, true);
}

// ═════════════════════════════════════════════════ 7. KOMUTLAR ════════════════════════════════════════════════════════
const o = (label: string, key: string): Opt => ({ label, key });
const isOpt = (e: Ev, key: string) => e.k === 'opt' && e.key === key;
const ghost = (s: Shape2 | null, style: GeoStyle = 'ghost'): Geo[] => (s ? [{ ...s, style }] : []);
const rub = (a: P2, b: P2): Geo => ({ t: 'line', a, b, style: 'rubber' });
const ghosts = (set_: Entity[], m: M2): Geo[] => set_.map(e => ({ ...transformShape(stripEnt(e), m), style: 'ghost' as const }));

/** Yalnız klavyeden sayı; Enter varsayılanı verir. Sayı dışı girdi (seçenek / iptal) olduğu gibi döner. */
function* askNum(prompt: string, def?: number, opts?: Opt[]): G<number | Ev> {
  const ev = yield { kind: 'value', prompt, num: true, def: def !== undefined ? fmt(def) : undefined, opts };
  if (ev.k === 'num') return ev.v;
  if (ev.k === 'enter' && def !== undefined) return def;
  return ev;
}
/** "Select objects": tek tık ekler (Shift çıkarır), boşluğa tık pencere açar (soldan sağa: içinde kalanlar · sağdan sola: değenler). */
function* selectObjects(c: Ctx, tag: string, usePre = true): G<Entity[] | null> {
  const pre = usePre ? c.sel() : [];
  if (pre.length) { c.msg(`${pre.length} found`); return pre; }
  const ids = new Set<string>();
  for (;;) {
    c.setSel([...ids]);
    const ev = yield { kind: 'pick', prompt: `${tag}  Select objects${ids.size ? `  (${ids.size} selected)` : ''}`, opts: [o('ALL', 'ALL')] };
    if (ev.k === 'enter') break;
    if (isOpt(ev, 'ALL')) { c.ents().forEach(e => ids.add(e.id)); continue; }
    if (ev.k !== 'pt') continue;
    if (ev.ent) { if (ev.shift) ids.delete(ev.ent.id); else ids.add(ev.ent.id); continue; }
    const a = ev.p;
    const e2 = yield { kind: 'pick', prompt: `${tag}  Specify opposite corner`, preview: cur => [{ t: 'box', a, b: cur, crossing: cur.x < a.x }] };
    if (e2.k !== 'pt') continue;
    const b = e2.p, crossing = b.x < a.x;
    for (const e of c.ents()) if (crossing ? boxCrosses(e, a, b) : boxContains(e, a, b)) { if (e2.shift) ids.delete(e.id); else ids.add(e.id); }
  }
  const out = c.ents().filter(e => ids.has(e.id));
  c.setSel(out.map(e => e.id));
  return out.length ? out : null;
}

/** Parametric kip — kontrol noktası seçimi: noktaya tık ekler / çıkarır; boşluğa tık pencere açar (içindeki noktalar eklenir, Shift çıkarır). */
function* PSEL(c: Ctx): G {
  const all = () => c.ents().flatMap(e => ctrlPoints(e).map((_, i) => ptKey(e.id, i)));
  for (;;) {
    const n = get().psel.length;
    const ev = yield {
      kind: 'point', noSnap: true, noTrack: true, opts: [o('All', 'A'), o('Clear', 'C')],
      prompt: `POINTS  Click a point, or the first corner of a window${n ? `  (${n} selected)` : ''}`,
    };
    if (isOpt(ev, 'A')) { set({ psel: all(), selection: [] }); continue; }
    if (isOpt(ev, 'C')) { set({ psel: [] }); continue; }
    if (ev.k !== 'pt') return;
    const hit = pointAt(ev.p, lastMove?.tol ?? 0);
    if (hit) { togglePoint(hit, true); continue; }
    const a = ev.p;
    const e2 = yield { kind: 'point', noSnap: true, noTrack: true, prompt: 'POINTS  Specify opposite corner', preview: cur => [{ t: 'box', a, b: cur, crossing: false }] };
    if (e2.k !== 'pt') continue;
    const cur = new Set(get().psel);
    for (const e of c.ents()) ctrlPoints(e).forEach((p, i) => { if (inBox(p, a, e2.p)) { if (e2.shift) cur.delete(ptKey(e.id, i)); else cur.add(ptKey(e.id, i)); } });
    set({ psel: [...cur], selection: [] });
  }
}

// ── DRAW ──
function* LINE(c: Ctx): G {
  const pts: P2[] = [], ids: string[] = [];
  for (;;) {
    const n = pts.length, last = pts[n - 1];
    const ev = yield {
      kind: 'point', base: last, prompt: n === 0 ? 'LINE  Specify first point' : 'LINE  Specify next point',
      opts: n === 0 ? [] : n === 1 ? [o('Undo', 'U')] : [o('Close', 'C'), o('Undo', 'U')],
      preview: cur => (n ? [{ t: 'line', a: last, b: cur, style: 'ghost' }] : []),
    };
    if (ev.k === 'pt') {
      if (n && !same(last, ev.p)) { ids.push(c.add(L(last, ev.p)).id); vars.last = { p: ev.p, ang: angOf(sub(ev.p, last)) }; }
      if (!n || !same(last, ev.p)) pts.push(ev.p);
    } else if (isOpt(ev, 'U')) { if (n > 1) c.remove([ids.pop()!]); pts.pop(); }
    else if (isOpt(ev, 'C')) { c.add(L(last, pts[0])); return; }
    else if (ev.k === 'enter' && n === 0 && vars.lastPoint) pts.push(vars.lastPoint);   // Enter: son noktadan devam
    else return;
  }
}

function* PLINE(c: Ctx): G {
  const e0 = yield { kind: 'point', prompt: 'PLINE  Specify start point' };
  if (e0.k !== 'pt') return;
  const v: PV[] = [{ x: e0.p.x, y: e0.p.y }];
  let arcMode = false, id: string | null = null;
  const commit = (closed = false) => {
    if (v.length < 2) { if (id) { c.remove([id]); id = null; } return; }
    const s: PlineS = { t: 'pline', v: v.map(x => ({ ...x })), closed: closed || undefined };
    if (id) c.update(id, s); else id = c.add(s).id;
  };
  const dirNow = () => (v.length < 2 ? (vars.last && same(vars.last.p, v[0]) ? vars.last.ang : 0) : endTangent(v[v.length - 2], v[v.length - 1]));
  const push = (p: P2, bulge = 0) => {
    if (same(p, v[v.length - 1])) return;
    v[v.length - 1] = { x: v[v.length - 1].x, y: v[v.length - 1].y, ...(Math.abs(bulge) > 1e-9 ? { b: bulge } : {}) };
    v.push({ x: p.x, y: p.y });
    commit();
  };
  const withSeg = (p: P2, bulge = 0): Geo[] => [{ t: 'pline', v: [...v.slice(0, -1), { ...v[v.length - 1], b: bulge || undefined }, { x: p.x, y: p.y }], style: 'ghost' }];
  const tag = 'PLINE';
  for (;;) {
    const last: P2 = v[v.length - 1], n = v.length;
    if (!arcMode) {
      const ev = yield {
        kind: 'point', base: last, prompt: 'PLINE (Line)  Specify next point',
        opts: [o('Arc', 'A'), ...(n >= 3 ? [o('Close', 'C')] : []), o('Length', 'L'), o('Undo', 'U')], preview: cur => withSeg(cur),
      };
      if (ev.k === 'pt') push(ev.p);
      else if (isOpt(ev, 'A')) arcMode = true;
      else if (isOpt(ev, 'C')) { commit(true); break; }
      else if (isOpt(ev, 'L')) { const len = yield* askNum(`${tag}  Specify length of line`); if (typeof len === 'number') push(add(last, polar(dirNow(), len))); }
      else if (isOpt(ev, 'U')) { if (n > 1) { v.pop(); delete v[v.length - 1].b; commit(); } }
      else break;
      continue;
    }
    const ev = yield {
      kind: 'point', base: last, noTrack: true, prompt: 'PLINE (Arc)  Specify endpoint of arc',
      opts: [o('Angle', 'A'), o('CEnter', 'CE'), ...(n >= 2 ? [o('CLose', 'CL')] : []), o('Direction', 'D'), o('Line', 'L'), o('Radius', 'R'), o('Second pt', 'S'), o('Undo', 'U')],
      preview: cur => withSeg(cur, bulgeFromTangent(last, cur, dirNow())),
    };
    if (ev.k === 'pt') push(ev.p, bulgeFromTangent(last, ev.p, dirNow()));
    else if (isOpt(ev, 'L')) arcMode = false;
    else if (isOpt(ev, 'U')) { if (n > 1) { v.pop(); delete v[v.length - 1].b; commit(); } }
    else if (isOpt(ev, 'CL')) { v[n - 1] = { ...v[n - 1], b: bulgeFromTangent(last, v[0], dirNow()) }; commit(true); break; }
    else if (isOpt(ev, 'A')) {
      const a = yield* askNum(`${tag}  Specify included angle`);
      if (typeof a !== 'number' || Math.abs(a) < 1e-6) continue;
      const incl = rad(Math.max(-359.99, Math.min(359.99, a))), bl = Math.tan(incl / 4);
      const e2 = yield { kind: 'point', base: last, noTrack: true, prompt: `${tag}  Specify endpoint of arc`, opts: [o('CEnter', 'CE'), o('Radius', 'R')], preview: cur => withSeg(cur, bl) };
      if (e2.k === 'pt') push(e2.p, bl);
      else if (isOpt(e2, 'CE')) {
        const e3 = yield { kind: 'point', base: last, prompt: `${tag}  Specify center point of arc`, preview: cur => withSeg(rotAbout(last, cur, incl), bl) };
        if (e3.k === 'pt') push(rotAbout(last, e3.p, incl), bl);
      } else if (isOpt(e2, 'R')) {
        const r = yield* askNum(`${tag}  Specify radius of arc`);
        if (typeof r !== 'number' || r <= 0) continue;
        const chord = 2 * r * Math.sin(Math.abs(incl) / 2);
        const e3 = yield { kind: 'point', base: last, num: true, prompt: `${tag}  Specify direction of chord for arc`, def: fmt(deg(dirNow())), preview: cur => withSeg(add(last, mul(unit(sub(cur, last)), chord)), bl) };
        const dir = e3.k === 'pt' ? angOf(sub(e3.p, last)) : e3.k === 'num' ? rad(e3.v) : e3.k === 'enter' ? dirNow() : null;
        if (dir !== null) push(add(last, polar(dir, chord)), bl);
      }
    } else if (isOpt(ev, 'CE')) {
      const e2 = yield { kind: 'point', base: last, prompt: `${tag}  Specify center point of arc`, preview: cur => [rub(last, cur)] };
      if (e2.k !== 'pt' || same(e2.p, last)) continue;
      const ctr = e2.p, r = dist(ctr, last);
      const toEnd = (p: P2, cw: boolean) => { const sw = sweepSCE(last, ctr, p, cw); return { end: add(ctr, polar(angOf(sub(p, ctr)), r)), bl: Math.tan(sw / 4) }; };
      const e3 = yield {
        kind: 'point', base: ctr, noTrack: true, prompt: `${tag}  Specify endpoint of arc (hold Ctrl to switch direction)`, opts: [o('Angle', 'A'), o('Length', 'L')],
        preview: (cur, m) => { const k = toEnd(cur, m.ctrl); return [...withSeg(k.end, k.bl), rub(ctr, cur)]; },
      };
      if (e3.k === 'pt') { const k = toEnd(e3.p, e3.ctrl); push(k.end, k.bl); }
      else if (isOpt(e3, 'A')) { const a = yield* askNum(`${tag}  Specify included angle`); if (typeof a === 'number' && Math.abs(a) > 1e-6) push(rotAbout(last, ctr, rad(a)), Math.tan(rad(a) / 4)); }
      else if (isOpt(e3, 'L')) {
        const len = yield* askNum(`${tag}  Specify length of chord`);
        const incl = typeof len === 'number' ? chordIncl(r, len) : null;
        if (incl !== null) push(rotAbout(last, ctr, incl), Math.tan(incl / 4)); else if (typeof len === 'number') c.msg('Chord is longer than the diameter.');
      }
    } else if (isOpt(ev, 'D')) {
      const e2 = yield { kind: 'point', base: last, num: true, prompt: `${tag}  Specify tangent direction for the start point of arc`, preview: cur => [rub(last, cur)] };
      const dir = e2.k === 'pt' ? angOf(sub(e2.p, last)) : e2.k === 'num' ? rad(e2.v) : null;
      if (dir === null) continue;
      const e3 = yield { kind: 'point', base: last, noTrack: true, prompt: `${tag}  Specify endpoint of arc`, preview: cur => withSeg(cur, bulgeFromTangent(last, cur, dir)) };
      if (e3.k === 'pt') push(e3.p, bulgeFromTangent(last, e3.p, dir));
    } else if (isOpt(ev, 'R')) {
      const r = yield* askNum(`${tag}  Specify radius of arc`);
      if (typeof r !== 'number' || r <= 0) continue;
      const bl = (p: P2) => { const inc = chordIncl(r, dist(last, p)); return inc === null ? null : Math.tan(inc / 4); };
      const e2 = yield { kind: 'point', base: last, noTrack: true, prompt: `${tag}  Specify endpoint of arc`, preview: cur => { const b = bl(cur); return b === null ? [rub(last, cur)] : withSeg(cur, b); } };
      if (e2.k === 'pt') { const b = bl(e2.p); if (b === null) c.msg('Endpoint is farther than the diameter.'); else push(e2.p, b); }
    } else if (isOpt(ev, 'S')) {
      const e2 = yield { kind: 'point', base: last, prompt: `${tag}  Specify second point on arc`, preview: cur => [rub(last, cur)] };
      if (e2.k !== 'pt') continue;
      const e3 = yield { kind: 'point', base: e2.p, noTrack: true, prompt: `${tag}  Specify endpoint of arc`, preview: cur => withSeg(cur, bulge3(last, e2.p, cur) ?? 0) };
      if (e3.k === 'pt') push(e3.p, bulge3(last, e2.p, e3.p) ?? 0);
    } else break;
  }
  if (v.length >= 2) vars.last = { p: v[v.length - 1], ang: endTangent(v[v.length - 2], v[v.length - 1]) };
}

function* circleCR(c: Ctx, diaFirst: boolean): G {
  const tag = diaFirst ? 'CIRCLE CD' : 'CIRCLE';
  const e0 = yield { kind: 'point', prompt: `${tag}  Specify center point`, opts: diaFirst ? [] : [o('3P', '3P'), o('2P', '2P'), o('Ttr', 'TTR'), o('Ttt', 'TTT')] };
  if (isOpt(e0, '3P')) { yield* circle3P(c); return; }
  if (isOpt(e0, '2P')) { yield* circle2P(c); return; }
  if (isOpt(e0, 'TTR')) { yield* circleTTR(c); return; }
  if (isOpt(e0, 'TTT')) { yield* circleTTT(c); return; }
  if (e0.k !== 'pt') return;
  const ctr = e0.p;
  let dia = diaFirst;
  for (;;) {
    const def = vars.radius > 0 ? (dia ? vars.radius * 2 : vars.radius) : undefined;
    const ev = yield {
      kind: 'point', base: ctr, num: true, prompt: `${tag}  Specify ${dia ? 'diameter' : 'radius'} of circle`, def: def ? fmt(def) : undefined,
      opts: dia ? [] : [o('Diameter', 'D')], preview: cur => [{ t: 'circle', c: ctr, r: dist(ctr, cur) / (dia ? 2 : 1), style: 'ghost' }, rub(ctr, cur)],
    };
    if (isOpt(ev, 'D')) { dia = true; continue; }
    const val = ev.k === 'pt' ? dist(ctr, ev.p) : ev.k === 'num' ? ev.v : ev.k === 'enter' ? def : undefined;
    if (val === undefined) return;
    const r = dia ? val / 2 : val;
    if (!(r > LEN_EPS)) { c.msg('Requires a positive, non-zero value.'); continue; }
    vars.radius = r;
    c.add({ t: 'circle', c: ctr, r });
    return;
  }
}
function* circle2P(c: Ctx): G {
  const e0 = yield { kind: 'point', prompt: 'CIRCLE 2P  Specify first end of diameter' };
  if (e0.k !== 'pt') return;
  const a = e0.p, mk = (b: P2): CircleS => ({ t: 'circle', c: mid(a, b), r: dist(a, b) / 2 });
  for (;;) {
    const e1 = yield { kind: 'point', base: a, prompt: 'CIRCLE 2P  Specify second end of diameter', preview: cur => [...ghost(mk(cur)), rub(a, cur)] };
    if (e1.k !== 'pt') return;
    if (same(a, e1.p)) continue;
    const k = mk(e1.p); vars.radius = k.r; c.add(k);
    return;
  }
}
function* circle3P(c: Ctx): G {
  const e0 = yield { kind: 'point', prompt: 'CIRCLE 3P  Specify first point' };
  if (e0.k !== 'pt') return;
  const e1 = yield { kind: 'point', base: e0.p, prompt: 'CIRCLE 3P  Specify second point', preview: cur => [rub(e0.p, cur)] };
  if (e1.k !== 'pt') return;
  const mk = (p: P2): CircleS | null => { const k = circleFrom3(e0.p, e1.p, p); return k ? { t: 'circle', ...k } : null; };
  for (;;) {
    const e2 = yield { kind: 'point', base: e1.p, noTrack: true, prompt: 'CIRCLE 3P  Specify third point', preview: cur => ghost(mk(cur)) };
    if (e2.k !== 'pt') return;
    const k = mk(e2.p);
    if (!k) { c.msg('Points are collinear.'); continue; }
    vars.radius = k.r; c.add(k);
    return;
  }
}
function* pickTan(prompt: string): G<{ obj: TanObj; p: P2 } | null> {
  for (;;) {
    const ev = yield { kind: 'pick', prompt, filter: e => e.t !== 'ellipse', preview: (_c, m) => ghost(m.ent ? stripEnt(m.ent) : null, 'hi') };
    if (ev.k !== 'pt') return null;
    const obj = ev.ent ? tanObjOf(ev.ent, ev.p) : null;
    if (obj && ev.ent) return { obj, p: closestOn(ev.ent, ev.p).pt };
  }
}
function* circleTTR(c: Ctx): G {
  const a = yield* pickTan('CIRCLE TTR  Select first tangent object');
  if (!a) return;
  const b = yield* pickTan('CIRCLE TTR  Select second tangent object');
  if (!b) return;
  for (;;) {
    const r = yield* askNum('CIRCLE TTR  Specify radius', vars.radius > 0 ? vars.radius : undefined);
    if (typeof r !== 'number') return;
    const k = r > 0 ? solveTTR(a.obj, a.p, b.obj, b.p, r) : null;
    if (!k) { c.msg('No circle with that radius is tangent to both objects.'); continue; }
    vars.radius = r; c.add(k);
    return;
  }
}
function* circleTTT(c: Ctx): G {
  const picks: { obj: TanObj; p: P2 }[] = [];
  for (const w of ['first', 'second', 'third']) {
    const k = yield* pickTan(`CIRCLE TTT  Select ${w} tangent object`);
    if (!k) return;
    picks.push(k);
  }
  const k = solveTTT(picks.map(p => p.obj), picks.map(p => p.p));
  if (!k) { c.msg('No circle is tangent to these three objects.'); return; }
  vars.radius = k.r; c.add(k);
}

const putArc = (c: Ctx, a: ArcS | null, endPt?: P2): boolean => {
  if (!a) { c.msg('Cannot create an arc from these values.'); return false; }
  c.add(a);
  const p0 = add(a.c, polar(a.a0, a.r)), p1 = add(a.c, polar(a.a1, a.r));
  vars.last = !endPt || dist(endPt, p1) <= dist(endPt, p0) ? { p: p1, ang: a.a1 + Math.PI / 2 } : { p: p0, ang: a.a0 - Math.PI / 2 };
  return true;
};
/** Başlangıç + merkez belli: bitiş noktası / iç açı / kiriş uzunluğu. free → seçenekler açık (genel ARC). */
function* arcAfterSC(c: Ctx, tag: string, s: P2, ctr: P2, mode: 'E' | 'A' | 'L', free: boolean): G {
  const r = dist(s, ctr);
  if (r < LEN_EPS) { c.msg('Start point and center coincide.'); return; }
  const byPt = (p: P2, cw: boolean) => arcSCA(s, ctr, sweepSCE(s, ctr, p, cw));
  for (;;) {
    if (mode === 'L') {
      const mk = (len: number, cw: boolean) => { const i = chordIncl(r, len); return i === null ? null : arcSCA(s, ctr, cw ? -i : i); };
      const ev = yield { kind: 'point', base: s, num: true, noTrack: true, prompt: `${tag}  Specify length of chord (hold Ctrl to switch direction)`, preview: (cur, m) => [...ghost(mk(dist(s, cur), m.ctrl)), rub(s, cur)] };
      const len = ev.k === 'num' ? ev.v : ev.k === 'pt' ? dist(s, ev.p) : null;
      if (len === null) return;
      const a = mk(len, ev.k === 'pt' ? ev.ctrl : c.ctrl()), i = chordIncl(r, len);
      if (putArc(c, a, i === null ? undefined : rotAbout(s, ctr, c.ctrl() ? -i : i))) return;
      continue;
    }
    const ev = yield {
      kind: 'point', base: ctr, num: mode === 'A', noTrack: true,
      prompt: mode === 'A' ? `${tag}  Specify included angle (hold Ctrl to switch direction)` : `${tag}  Specify end point of arc (hold Ctrl to switch direction)`,
      opts: free && mode === 'E' ? [o('Angle', 'A'), o('chord Length', 'L')] : [], preview: (cur, m) => [...ghost(byPt(cur, m.ctrl)), rub(ctr, cur)],
    };
    if (ev.k === 'pt') { if (putArc(c, byPt(ev.p, ev.ctrl), add(ctr, polar(angOf(sub(ev.p, ctr)), r)))) return; }
    else if (ev.k === 'num') { const incl = rad(ev.v) * (c.ctrl() ? -1 : 1); if (putArc(c, arcSCA(s, ctr, incl), rotAbout(s, ctr, incl))) return; }
    else if (isOpt(ev, 'A')) mode = 'A';
    else if (isOpt(ev, 'L')) mode = 'L';
    else return;
  }
}
/** Başlangıç + bitiş belli: merkez / iç açı / teğet yönü / yarıçap. */
function* arcAfterSE(c: Ctx, tag: string, s: P2, e: P2, mode: 'C' | 'A' | 'D' | 'R', free: boolean): G {
  if (same(s, e)) { c.msg('Start and end points coincide.'); return; }
  for (;;) {
    if (mode === 'C') {
      const ev = yield {
        kind: 'point', base: s, noTrack: true, prompt: `${tag}  Specify center point of arc (hold Ctrl to switch direction)`,
        opts: free ? [o('Angle', 'A'), o('Direction', 'D'), o('Radius', 'R')] : [], preview: (cur, m) => ghost(arcSCA(s, cur, sweepSCE(s, cur, e, m.ctrl))),
      };
      if (ev.k === 'pt') { if (putArc(c, arcSCA(s, ev.p, sweepSCE(s, ev.p, e, ev.ctrl)), e)) return; }
      else if (isOpt(ev, 'A')) mode = 'A'; else if (isOpt(ev, 'D')) mode = 'D'; else if (isOpt(ev, 'R')) mode = 'R'; else return;
    } else if (mode === 'D') {
      const mk = (dir: number) => arcFromBulge(s, e, bulgeFromTangent(s, e, dir));
      const ev = yield { kind: 'point', base: s, num: true, prompt: `${tag}  Specify tangent direction for the start point of arc`, preview: cur => [...ghost(mk(angOf(sub(cur, s)))), rub(s, cur)] };
      const dir = ev.k === 'pt' ? angOf(sub(ev.p, s)) : ev.k === 'num' ? rad(ev.v) : null;
      if (dir === null) return;
      if (putArc(c, mk(dir), e)) return;
    } else {
      // Fare: yay imleçten geçer. Klavye: iç açı (A) veya yarıçap (R).
      const ev = yield {
        kind: 'point', base: mode === 'R' ? e : s, num: true, noTrack: true,
        prompt: mode === 'A' ? `${tag}  Specify included angle (hold Ctrl to switch direction)` : `${tag}  Specify radius of arc (hold Ctrl to switch direction)`,
        preview: cur => ghost(arc3(s, cur, e)),
      };
      if (ev.k === 'pt') { if (putArc(c, arc3(s, ev.p, e), e)) return; }
      else if (ev.k === 'num') {
        const a = mode === 'A' ? arcFromBulge(s, e, Math.tan(rad(ev.v) * (c.ctrl() ? -1 : 1) / 4)) : arcSER(s, e, ev.v, c.ctrl());
        if (putArc(c, a, e)) return;
      } else return;
    }
  }
}
function* arcCont(c: Ctx): G {
  const l = vars.last;
  if (!l) { c.msg('No previous line or arc to continue from.'); return; }
  const mk = (p: P2, flip: boolean) => arcFromBulge(l.p, p, bulgeFromTangent(l.p, p, l.ang + (flip ? Math.PI : 0)));
  for (;;) {
    const ev = yield { kind: 'point', base: l.p, noTrack: true, prompt: 'ARC Continue  Specify end point (hold Ctrl to flip direction)', preview: (cur, m) => ghost(mk(cur, m.ctrl)) };
    if (ev.k !== 'pt') return;
    if (putArc(c, mk(ev.p, ev.ctrl), ev.p)) return;
  }
}
function* arc3P(c: Ctx, tag = 'ARC 3P', first?: P2): G {
  let s = first;
  if (!s) { const e0 = yield { kind: 'point', prompt: `${tag}  Specify start point` }; if (e0.k !== 'pt') return; s = e0.p; }
  const s0 = s;
  const e1 = yield { kind: 'point', base: s0, prompt: `${tag}  Specify second point on arc`, preview: cur => [rub(s0, cur)] };
  if (e1.k !== 'pt') return;
  for (;;) {
    const e2 = yield { kind: 'point', base: e1.p, noTrack: true, prompt: `${tag}  Specify end point`, preview: cur => ghost(arc3(s0, e1.p, cur)) };
    if (e2.k !== 'pt') return;
    if (putArc(c, arc3(s0, e1.p, e2.p), e2.p)) return;
  }
}
function* ARC(c: Ctx): G {
  const e0 = yield { kind: 'point', prompt: 'ARC  Specify start point of arc', opts: [o('Center', 'C')] };
  if (e0.k === 'enter') { yield* arcCont(c); return; }
  if (isOpt(e0, 'C')) {
    const k = yield { kind: 'point', prompt: 'ARC  Specify center point of arc' };
    if (k.k !== 'pt') return;
    const s = yield { kind: 'point', base: k.p, prompt: 'ARC  Specify start point of arc', preview: cur => [rub(k.p, cur)] };
    if (s.k === 'pt') yield* arcAfterSC(c, 'ARC', s.p, k.p, 'E', true);
    return;
  }
  if (e0.k !== 'pt') return;
  const s = e0.p;
  const e1 = yield { kind: 'point', base: s, prompt: 'ARC  Specify second point of arc', opts: [o('Center', 'C'), o('End', 'E')], preview: cur => [rub(s, cur)] };
  if (isOpt(e1, 'C')) {
    const k = yield { kind: 'point', base: s, prompt: 'ARC  Specify center point of arc', preview: cur => [rub(s, cur)] };
    if (k.k === 'pt') yield* arcAfterSC(c, 'ARC', s, k.p, 'E', true);
  } else if (isOpt(e1, 'E')) {
    const k = yield { kind: 'point', base: s, prompt: 'ARC  Specify end point of arc', preview: cur => [rub(s, cur)] };
    if (k.k === 'pt') yield* arcAfterSE(c, 'ARC', s, k.p, 'C', true);
  } else if (e1.k === 'pt') {
    for (;;) {
      const e2 = yield { kind: 'point', base: e1.p, noTrack: true, prompt: 'ARC  Specify end point of arc', preview: cur => ghost(arc3(s, e1.p, cur)) };
      if (e2.k !== 'pt') return;
      if (putArc(c, arc3(s, e1.p, e2.p), e2.p)) return;
    }
  }
}
/** Hazır yay yöntemleri: iki nokta sorulur, kalan adım ortak alt akışa devredilir. */
const arcPreset = (tag: string, order: 'SC' | 'CS' | 'SE', mode: 'E' | 'A' | 'L' | 'D' | 'R') => function* (c: Ctx): G {
  const first = order === 'CS' ? 'center' : 'start point', second = order === 'SC' ? 'center' : order === 'CS' ? 'start point' : 'end point';
  const e0 = yield { kind: 'point', prompt: `${tag}  Specify ${first}` };
  if (e0.k !== 'pt') return;
  const e1 = yield { kind: 'point', base: e0.p, prompt: `${tag}  Specify ${second}`, preview: cur => [rub(e0.p, cur)] };
  if (e1.k !== 'pt') return;
  if (order === 'SE') yield* arcAfterSE(c, tag, e0.p, e1.p, mode as 'A' | 'D' | 'R', false);
  else yield* arcAfterSC(c, tag, order === 'SC' ? e0.p : e1.p, order === 'SC' ? e1.p : e0.p, mode as 'E' | 'A' | 'L', false);
};

function* RECT(c: Ctx): G {
  let rot = 0, p1: P2;
  for (;;) {
    const modes = vars.rectFillet > 0 ? `  (Fillet=${fmt(vars.rectFillet)})` : vars.rectCham ? `  (Chamfer=${fmt(vars.rectCham[0])} x ${fmt(vars.rectCham[1])})` : '';
    const ev = yield { kind: 'point', prompt: `RECT  Specify first corner${modes}`, opts: [o('Chamfer', 'C'), o('Fillet', 'F')] };
    if (ev.k === 'pt') { p1 = ev.p; break; }
    if (isOpt(ev, 'F')) { const r = yield* askNum('RECT  Specify fillet radius for rectangles', vars.rectFillet); if (typeof r === 'number' && r >= 0) { vars.rectFillet = r; vars.rectCham = null; } continue; }
    if (isOpt(ev, 'C')) {
      const d1 = yield* askNum('RECT  Specify first chamfer distance for rectangles', vars.rectCham?.[0] ?? 0);
      if (typeof d1 !== 'number' || d1 < 0) continue;
      const d2 = yield* askNum('RECT  Specify second chamfer distance for rectangles', d1);
      if (typeof d2 === 'number' && d2 >= 0) { vars.rectCham = d1 > 0 || d2 > 0 ? [d1, d2] : null; vars.rectFillet = 0; }
      continue;
    }
    return;
  }
  const mk = (w: number, h: number) => rectPline(p1, w, h, rot, vars.rectFillet, vars.rectCham);
  const wh = (cur: P2) => { const d = sub(cur, p1), ux = polar(rot); return { w: dot(d, ux), h: dot(d, perp(ux)) }; };
  const put = (w: number, h: number) => { if (Math.abs(w) < LEN_EPS || Math.abs(h) < LEN_EPS) { c.msg('Rectangle has no area.'); return false; } c.add(mk(w, h)); return true; };
  /** Ölçüler belli: imlecin çeyreği yönü belirler. */
  function* place(W: number, H: number): G<boolean> {
    const at = (cur: P2) => { const k = wh(cur); return { w: k.w < 0 ? -W : W, h: k.h < 0 ? -H : H }; };
    const ev = yield { kind: 'point', base: p1, noTrack: true, noSnap: true, prompt: 'RECT  Specify other corner point', preview: cur => { const k = at(cur); return ghost(mk(k.w, k.h)); } };
    if (ev.k === 'pt') { const k = at(ev.p); return put(k.w, k.h); }
    if (ev.k === 'enter') return put(W, H);
    return false;
  }
  for (;;) {
    const ev = yield {
      kind: 'point', base: p1, noTrack: true, prompt: 'RECT  Specify other corner', opts: [o('Area', 'A'), o('Dimensions', 'D'), o('Rotation', 'R')],
      preview: cur => { const k = wh(cur); return ghost(mk(k.w, k.h)); },
    };
    if (ev.k === 'pt') { const k = wh(ev.p); if (put(k.w, k.h)) return; }
    else if (isOpt(ev, 'D')) {
      const len = yield* askNum('RECT  Specify length for rectangles');
      if (typeof len !== 'number' || len <= 0) continue;
      const wid = yield* askNum('RECT  Specify width for rectangles');
      if (typeof wid === 'number' && wid > 0 && (yield* place(len, wid))) return;
    } else if (isOpt(ev, 'A')) {
      const area = yield* askNum('RECT  Enter area of rectangle in current units');
      if (typeof area !== 'number' || area <= 0) continue;
      const which = yield { kind: 'value', prompt: 'RECT  Calculate rectangle dimensions based on', opts: [o('Length', 'L'), o('Width', 'W')], def: 'Length' };
      const byWidth = isOpt(which, 'W');
      if (!byWidth && which.k !== 'enter' && !isOpt(which, 'L')) continue;
      const v = yield* askNum(`RECT  Enter rectangle ${byWidth ? 'width' : 'length'}`);
      if (typeof v === 'number' && v > 0 && put(byWidth ? area / v : v, byWidth ? v : area / v)) return;
    } else if (isOpt(ev, 'R')) {
      const e2 = yield { kind: 'point', base: p1, num: true, prompt: 'RECT  Specify rotation angle', def: fmt(deg(rot)), preview: cur => [rub(p1, cur)] };
      if (e2.k === 'num') rot = rad(e2.v); else if (e2.k === 'pt' && !same(e2.p, p1)) rot = angOf(sub(e2.p, p1));
    } else return;
  }
}
function* rectRot(c: Ctx): G {
  const e0 = yield { kind: 'point', prompt: 'RECT ROT  Specify first corner' };
  if (e0.k !== 'pt') return;
  const p1 = e0.p;
  const e1 = yield { kind: 'point', base: p1, prompt: 'RECT ROT  Specify adjacent corner (defines edge direction)', preview: cur => [rub(p1, cur)] };
  if (e1.k !== 'pt' || same(e1.p, p1)) return;
  const w = dist(p1, e1.p), rot = angOf(sub(e1.p, p1)), hOf = (cur: P2) => dot(sub(cur, p1), perp(polar(rot)));
  for (;;) {
    const e2 = yield { kind: 'point', base: e1.p, num: true, noTrack: true, prompt: 'RECT ROT  Specify height (perpendicular pick)', preview: cur => ghost(rectPline(p1, w, hOf(cur), rot)) };
    const h = e2.k === 'pt' ? hOf(e2.p) : e2.k === 'num' ? e2.v : null;
    if (h === null) return;
    if (Math.abs(h) < LEN_EPS) { c.msg('Rectangle has no area.'); continue; }
    c.add(rectPline(p1, w, h, rot));
    return;
  }
}
function* rectCen(c: Ctx): G {
  const e0 = yield { kind: 'point', prompt: 'RECT CEN  Specify center point' };
  if (e0.k !== 'pt') return;
  const ctr = e0.p, mk = (cur: P2) => rectPline(sub(mul(ctr, 2), cur), 2 * (cur.x - ctr.x), 2 * (cur.y - ctr.y));
  for (;;) {
    const e1 = yield { kind: 'point', base: ctr, noTrack: true, prompt: 'RECT CEN  Specify corner point', preview: cur => ghost(mk(cur)) };
    if (e1.k !== 'pt') return;
    if (Math.abs(e1.p.x - ctr.x) < LEN_EPS || Math.abs(e1.p.y - ctr.y) < LEN_EPS) { c.msg('Rectangle has no area.'); continue; }
    c.add(mk(e1.p));
    return;
  }
}
function* askSides(tag: string): G<number | null> {
  for (;;) {
    const n = yield* askNum(`${tag}  Enter number of sides`, vars.polySides);
    if (typeof n !== 'number') return null;
    if (Number.isInteger(n) && n >= 3 && n <= 1024) { vars.polySides = n; return n; }
    say('Requires an integer between 3 and 1024.');
  }
}
function* polyEdge(c: Ctx, tag: string, n: number): G {
  const e0 = yield { kind: 'point', prompt: `${tag}  Specify first endpoint of edge` };
  if (e0.k !== 'pt') return;
  const a = e0.p;
  const mk = (b: P2): PlineS => {
    const side = dist(a, b), R = side / (2 * Math.sin(Math.PI / n)), ctr = add(mid(a, b), mul(perp(unit(sub(b, a))), R * Math.cos(Math.PI / n)));
    return polygonPline(ctr, n, R, angOf(sub(a, ctr)), false);
  };
  for (;;) {
    const e1 = yield { kind: 'point', base: a, prompt: `${tag}  Specify second endpoint of edge`, preview: cur => (same(a, cur) ? [] : ghost(mk(cur))) };
    if (e1.k !== 'pt') return;
    if (same(a, e1.p)) continue;
    c.add(mk(e1.p));
    return;
  }
}
/** fixed: I (iç teğet) / C (dış teğet) hazır yöntemi; null → sorulur. */
const polyCmd = (fixed: 'I' | 'C' | null) => function* (c: Ctx): G {
  const tag = 'POLYGON', n = yield* askSides(tag);
  if (n === null) return;
  const e0 = yield { kind: 'point', prompt: `${tag}  Specify center of polygon`, opts: [o('Edge', 'E')] };
  if (isOpt(e0, 'E')) { yield* polyEdge(c, tag, n); return; }
  if (e0.k !== 'pt') return;
  const ctr = e0.p;
  let circ = fixed === 'C';
  if (!fixed) {
    const k = yield { kind: 'value', prompt: `${tag}  Enter an option`, opts: [o('Inscribed in circle', 'I'), o('Circumscribed about circle', 'C')], def: 'I' };
    if (isOpt(k, 'C')) circ = true; else if (!isOpt(k, 'I') && k.k !== 'enter') return;
  }
  for (;;) {
    const ev = yield { kind: 'point', base: ctr, num: true, prompt: `${tag}  Specify radius of circle`, preview: cur => (same(cur, ctr) ? [] : [...ghost(polygonPline(ctr, n, dist(ctr, cur), angOf(sub(cur, ctr)), circ)), rub(ctr, cur)]) };
    if (ev.k === 'pt' && !same(ev.p, ctr)) { c.add(polygonPline(ctr, n, dist(ctr, ev.p), angOf(sub(ev.p, ctr)), circ)); return; }
    if (ev.k === 'num' && ev.v > 0) { c.add(polygonPline(ctr, n, ev.v, -Math.PI / 2 + (circ ? 0 : Math.PI / n), circ)); return; }   // yazılan yarıçap: alt kenar yatay
    if (ev.k !== 'pt' && ev.k !== 'num') return;
  }
};
function* polyE(c: Ctx): G { const n = yield* askSides('POLYGON E'); if (n !== null) yield* polyEdge(c, 'POLYGON E', n); }

/** Elipsin son adımı: diğer eksen mesafesi (nokta veya sayı); arc → başlangıç/bitiş açıları da sorulur. */
function* ellipseFinish(c: Ctx, tag: string, ctr: P2, major: P2, arc: boolean): G {
  let el: EllipseS | null = null;
  for (;;) {
    const ev = yield { kind: 'point', base: ctr, num: true, noTrack: true, prompt: `${tag}  Specify distance to other axis`, preview: cur => [...ghost(makeEllipse(ctr, major, dist(ctr, cur))), rub(ctr, cur)] };
    const d = ev.k === 'pt' ? dist(ctr, ev.p) : ev.k === 'num' ? ev.v : null;
    if (d === null) return;
    el = makeEllipse(ctr, major, d);
    if (el) break;
    c.msg('Requires a positive, non-zero value.');
  }
  if (!arc) { c.add(el); return; }
  const full = el, m0 = angOf(major);
  const ask = function* (what: string, from: number | null): G<number | null> {
    const ev = yield {
      kind: 'point', base: ctr, num: true, noTrack: true, prompt: `${tag}  Specify ${what} angle point or type degrees`,
      preview: cur => [...ghost(from === null ? full : { ...full, a0: from, a1: ellParamOfDir(full, angOf(sub(cur, ctr))) }), rub(ctr, cur)],
    };
    return ev.k === 'pt' ? ellParamOfDir(full, angOf(sub(ev.p, ctr))) : ev.k === 'num' ? ellParamOfDir(full, m0 + rad(ev.v)) : null;
  };
  const a0 = yield* ask('start', null);
  if (a0 === null) return;
  const a1 = yield* ask('end', a0);
  if (a1 === null) return;
  if (Math.abs(wrapPi(a1 - a0)) < ANG_EPS) c.add(full); else c.add({ ...full, a0: normAng(a0), a1: normAng(a1) });
}
const ellipseCenter = (arc: boolean) => function* (c: Ctx): G {
  const tag = arc ? 'ELLIPSE ARC' : 'ELLIPSE';
  const e0 = yield { kind: 'point', prompt: `${tag}  Specify center`, opts: arc ? [] : [o('Arc', 'ARC'), o('Axis', 'AXIS')] };
  if (isOpt(e0, 'ARC')) { yield* ellipseCenter(true)(c); return; }
  if (isOpt(e0, 'AXIS')) { yield* ellipseAxis(c); return; }
  if (e0.k !== 'pt') return;
  const ctr = e0.p;
  for (;;) {
    const e1 = yield { kind: 'point', base: ctr, prompt: `${tag}  Specify major axis endpoint`, preview: cur => [rub(ctr, cur)] };
    if (e1.k !== 'pt') return;
    if (same(e1.p, ctr)) continue;
    yield* ellipseFinish(c, tag, ctr, sub(e1.p, ctr), arc);
    return;
  }
};
function* ellipseAxis(c: Ctx): G {
  const tag = 'ELLIPSE (Axis)';
  const e0 = yield { kind: 'point', prompt: `${tag}  Specify first endpoint of major axis` };
  if (e0.k !== 'pt') return;
  for (;;) {
    const e1 = yield { kind: 'point', base: e0.p, prompt: `${tag}  Specify second endpoint of major axis`, preview: cur => [rub(e0.p, cur)] };
    if (e1.k !== 'pt') return;
    if (same(e1.p, e0.p)) continue;
    const ctr = mid(e0.p, e1.p);
    yield* ellipseFinish(c, tag, ctr, sub(e1.p, ctr), false);
    return;
  }
}

// ── MODIFY ──
const applyTo = (c: Ctx, set_: Entity[], m: M2, copy = false) => { for (const e of set_) { if (copy) c.add(transformShape(stripEnt(e), m)); else c.update(e.id, transformShape(stripEnt(e), m)); } };
function* MOVE(c: Ctx): G {
  const sel = yield* selectObjects(c, 'MOVE');
  if (!sel) return;
  const e0 = yield { kind: 'point', prompt: `MOVE  Specify base point  [${sel.length} objects]`, opts: [o('Displacement', 'D')] };
  let d: P2 | null = null;
  if (isOpt(e0, 'D')) {
    const e1 = yield { kind: 'point', prompt: 'MOVE  Specify displacement', def: '0,0', preview: cur => ghosts(sel, mTranslate(cur)) };
    if (e1.k === 'pt') d = e1.p;
  } else if (e0.k === 'pt') {
    const base = e0.p;
    const e1 = yield { kind: 'point', base, prompt: 'MOVE  Specify second point or <use first point as displacement>', preview: cur => [...ghosts(sel, mTranslate(sub(cur, base))), rub(base, cur)] };
    d = e1.k === 'pt' ? sub(e1.p, base) : e1.k === 'enter' ? base : null;
  }
  if (d) applyTo(c, sel, mTranslate(d));
  c.setSel([]);
}
function* COPY(c: Ctx): G {
  const sel = yield* selectObjects(c, 'COPY');
  if (!sel) return;
  let base: P2 | null = null;
  for (;;) {
    const e0 = yield { kind: 'point', prompt: `COPY  Specify base point  (mode = ${vars.copyMultiple ? 'Multiple' : 'Single'})`, opts: [o('Displacement', 'D'), o('mOde', 'O')] };
    if (e0.k === 'pt') { base = e0.p; break; }
    if (isOpt(e0, 'O')) {
      const k = yield { kind: 'value', prompt: 'COPY  Enter a copy mode option', opts: [o('Single', 'S'), o('Multiple', 'M')], def: vars.copyMultiple ? 'Multiple' : 'Single' };
      if (isOpt(k, 'S')) vars.copyMultiple = false; else if (isOpt(k, 'M')) vars.copyMultiple = true;
      continue;
    }
    if (isOpt(e0, 'D')) {
      const e1 = yield { kind: 'point', prompt: 'COPY  Specify displacement', def: '0,0', preview: cur => ghosts(sel, mTranslate(cur)) };
      if (e1.k === 'pt') applyTo(c, sel, mTranslate(e1.p), true);
    }
    c.setSel([]);
    return;
  }
  const made: string[][] = [];
  const b = base;
  for (;;) {
    const first = made.length === 0;
    const ev = yield {
      kind: 'point', base: b, prompt: first ? 'COPY  Specify second point or <use first point as displacement>' : 'COPY  Specify second point', def: first ? undefined : 'Exit',
      opts: first ? [o('Array', 'A')] : [o('Array', 'A'), o('Exit', 'E'), o('Undo', 'U')], preview: cur => [...ghosts(sel, mTranslate(sub(cur, b))), rub(b, cur)],
    };
    const put = (d: P2, count = 1) => {
      const ids: string[] = [];
      for (let k = 1; k <= count; k++) for (const e of sel) ids.push(c.add(transformShape(stripEnt(e), mTranslate(mul(d, k)))).id);
      made.push(ids);
    };
    if (ev.k === 'pt') put(sub(ev.p, b));
    else if (ev.k === 'enter' && first) put(b);
    else if (isOpt(ev, 'U')) { const ids = made.pop(); if (ids) c.remove(ids); continue; }
    else if (isOpt(ev, 'A')) {
      const n = yield* askNum('COPY  Enter number of items to array');
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 2) continue;
      const e2 = yield {
        kind: 'point', base: b, prompt: 'COPY  Specify second point',
        preview: cur => Array.from({ length: n - 1 }, (_, k) => ghosts(sel, mTranslate(mul(sub(cur, b), k + 1)))).flat(),
      };
      if (e2.k === 'pt') put(sub(e2.p, b), n - 1); else continue;
    } else break;
    if (!vars.copyMultiple) break;
  }
  c.setSel([]);
}
/** Dönme açısı / ölçek katsayısı için ortak "Copy / Reference" akışı. */
function* ROTATE(c: Ctx): G {
  const sel = yield* selectObjects(c, 'ROTATE');
  if (!sel) return;
  const e0 = yield { kind: 'point', prompt: `ROTATE  Specify rotation center  [${sel.length} objects]` };
  if (e0.k !== 'pt') { c.setSel([]); return; }
  const base = e0.p;
  let copy = false, ref = 0;
  for (;;) {
    const ev = yield {
      kind: 'point', base, num: true, prompt: `ROTATE  Specify rotation angle${copy ? '  (copy)' : ''}`, def: '0', opts: [o('Copy', 'C'), o('Reference', 'R')],
      preview: cur => [...ghosts(sel, mRotate(base, angOf(sub(cur, base)) - ref)), rub(base, cur)],
    };
    if (isOpt(ev, 'C')) { copy = true; continue; }
    if (isOpt(ev, 'R')) {
      const r1 = yield { kind: 'point', num: true, prompt: 'ROTATE  Specify first reference point or type reference angle', def: '0' };
      if (r1.k === 'num') ref = rad(r1.v);
      else if (r1.k === 'pt') {
        const r2 = yield { kind: 'point', base: r1.p, prompt: 'ROTATE  Specify second reference point', preview: cur => [rub(r1.p, cur)] };
        if (r2.k !== 'pt') continue;
        ref = angOf(sub(r2.p, r1.p));
      } else continue;
      const r3 = yield {
        kind: 'point', base, num: true, prompt: `ROTATE  Specify new absolute angle  [ref=${fmt(deg(ref), 1)}°]`,
        preview: cur => [...ghosts(sel, mRotate(base, angOf(sub(cur, base)) - ref)), rub(base, cur)],
      };
      const na = r3.k === 'num' ? rad(r3.v) : r3.k === 'pt' ? angOf(sub(r3.p, base)) : null;
      if (na !== null) applyTo(c, sel, mRotate(base, na - ref), copy);
      break;
    }
    const a = ev.k === 'num' ? rad(ev.v) : ev.k === 'pt' ? angOf(sub(ev.p, base)) : ev.k === 'enter' ? 0 : null;
    if (a !== null && Math.abs(a) > ANG_EPS) applyTo(c, sel, mRotate(base, a), copy);
    break;
  }
  c.setSel([]);
}
function* SCALE(c: Ctx): G {
  const sel = yield* selectObjects(c, 'SCALE');
  if (!sel) return;
  const e0 = yield { kind: 'point', prompt: `SCALE  Specify base point  [${sel.length} objects]` };
  if (e0.k !== 'pt') { c.setSel([]); return; }
  const base = e0.p;
  let copy = false;
  for (;;) {
    const ev = yield {
      kind: 'point', base, num: true, noTrack: true, prompt: `SCALE  Specify scale factor${copy ? '  (copy)' : ''}`, def: '1', opts: [o('Copy', 'C'), o('Reference', 'R')],
      preview: cur => (same(cur, base) ? [] : [...ghosts(sel, mScale(base, dist(cur, base))), rub(base, cur)]),
    };
    if (isOpt(ev, 'C')) { copy = true; continue; }
    if (isOpt(ev, 'R')) {
      let refLen = 1;
      const r1 = yield { kind: 'point', num: true, prompt: 'SCALE  Specify first reference point or type reference length', def: '1' };
      if (r1.k === 'num') refLen = r1.v;
      else if (r1.k === 'pt') {
        const r2 = yield { kind: 'point', base: r1.p, prompt: 'SCALE  Specify second reference point', preview: cur => [rub(r1.p, cur)] };
        if (r2.k !== 'pt') continue;
        refLen = dist(r1.p, r2.p);
      } else if (r1.k !== 'enter') continue;
      if (!(refLen > LEN_EPS)) { c.msg('Reference length must be positive.'); continue; }
      const r3 = yield {
        kind: 'point', base, num: true, noTrack: true, prompt: `SCALE  Specify new length from base or type a length  [ref=${fmt(refLen, 3)}]`,
        preview: cur => (same(cur, base) ? [] : [...ghosts(sel, mScale(base, dist(cur, base) / refLen)), rub(base, cur)]),
      };
      const nl = r3.k === 'num' ? r3.v : r3.k === 'pt' ? dist(r3.p, base) : null;
      if (nl !== null && nl > LEN_EPS) applyTo(c, sel, mScale(base, nl / refLen), copy);
      break;
    }
    const f = ev.k === 'num' ? ev.v : ev.k === 'pt' ? dist(ev.p, base) : ev.k === 'enter' ? 1 : null;
    if (f !== null && !(f > 0)) { c.msg('Requires a positive, non-zero value.'); continue; }
    if (f !== null && Math.abs(f - 1) > 1e-12) applyTo(c, sel, mScale(base, f), copy);
    break;
  }
  c.setSel([]);
}
function* MIRROR(c: Ctx): G {
  const sel = yield* selectObjects(c, 'MIRROR');
  if (!sel) return;
  const e0 = yield { kind: 'point', prompt: `MIRROR  Specify first mirror-line point  [${sel.length} objects]` };
  if (e0.k !== 'pt') { c.setSel([]); return; }
  const p1 = e0.p;
  for (;;) {
    const e1 = yield { kind: 'point', base: p1, prompt: 'MIRROR  Specify second point', preview: cur => (same(cur, p1) ? [] : [...ghosts(sel, mMirror(p1, cur)), rub(p1, cur)]) };
    if (e1.k !== 'pt') break;
    if (same(e1.p, p1)) continue;
    const k = yield { kind: 'value', prompt: 'MIRROR  Erase source objects?', opts: [o('Yes', 'Y'), o('No', 'N')], def: 'No', preview: () => ghosts(sel, mMirror(p1, e1.p)) };
    if (k.k !== 'enter' && k.k !== 'opt') break;
    applyTo(c, sel, mMirror(p1, e1.p), !isOpt(k, 'Y'));
    break;
  }
  c.setSel([]);
}
function* STRETCH(c: Ctx): G {
  c.msg('Select objects to stretch by crossing-window...');
  const e0 = yield { kind: 'pick', prompt: 'STRETCH  Specify first corner of crossing window' };
  if (e0.k !== 'pt') return;
  const a = e0.p;
  const e1 = yield { kind: 'pick', prompt: 'STRETCH  Specify opposite corner', preview: cur => [{ t: 'box', a, b: cur, crossing: true }] };
  if (e1.k !== 'pt') return;
  const b = e1.p, sel = c.ents().filter(e => boxCrosses(e, a, b));
  if (!sel.length) { c.msg('No objects in the crossing window.'); return; }
  c.setSel(sel.map(e => e.id));
  const e2 = yield { kind: 'point', prompt: `STRETCH  Specify base point  [${sel.length} objects]` };
  if (e2.k === 'pt') {
    const base = e2.p;
    const e3 = yield { kind: 'point', base, prompt: 'STRETCH  Specify second point', preview: cur => [...sel.map(e => ({ ...stretchShape(stripEnt(e), a, b, sub(cur, base)), style: 'ghost' as const })), rub(base, cur)] };
    if (e3.k === 'pt') for (const e of sel) c.update(e.id, stretchShape(stripEnt(e), a, b, sub(e3.p, base)));
  }
  c.setSel([]);
}
/** TRIM / EXTEND — hızlı kip: tıklanan parça en yakın kesişimler arasında kesilir (uzatılır); Shift diğer işlemi yapar. */
const trimExtend = (name: 'TRIM' | 'EXTEND') => function* (c: Ctx): G {
  let edges: Set<string> | null = null;
  const undoLog: Entity[][] = [];
  const edgeLabel = name === 'TRIM' ? o('cuTting edges', 'T') : o('Boundary edges', 'B');
  const others = (e: Entity) => c.ents().filter(x => x.id !== e.id && (!edges || edges.has(x.id))).map(stripEnt);
  const plan = (e: Entity, p: P2, shift: boolean): { keep: Shape2[]; cut: Shape2 | null } | null => {
    if ((name === 'TRIM') !== shift) return trimAt(stripEnt(e), p, others(e));
    const g = extendAt(stripEnt(e), p, others(e));
    return g ? { keep: [g], cut: null } : null;
  };
  for (;;) {
    const ev = yield {
      kind: 'pick', prompt: `${name}  Select object to ${name === 'TRIM' ? 'trim or shift-select to extend' : 'extend or shift-select to trim'}`,
      opts: [edgeLabel, o('eRase', 'R'), o('Undo', 'U')],
      preview: (cur, m) => { const k = m.ent ? plan(m.ent, cur, m.shift) : null; return k ? (k.cut ? ghost(k.cut, 'del') : k.keep.flatMap(s => ghost(s, 'hi'))) : []; },
    };
    if (ev.k === 'pt') {
      if (!ev.ent) continue;
      const k = plan(ev.ent, ev.p, ev.shift);
      if (!k) { c.msg(name === 'TRIM' !== ev.shift ? 'Object does not intersect an edge.' : 'No edge in that direction.'); continue; }
      undoLog.push(c.snapshot());
      const [first, ...rest] = k.keep;
      if (first) c.update(ev.ent.id, first); else c.remove([ev.ent.id]);
      c.addAll(rest);
    } else if (isOpt(ev, 'U')) { const s = undoLog.pop(); if (s) c.restore(s); else c.msg('Nothing to undo.'); }
    else if (isOpt(ev, edgeLabel.key)) { c.setSel([]); const s = yield* selectObjects(c, name, false); edges = s ? new Set(s.map(e => e.id)) : null; c.setSel([]); }
    else if (isOpt(ev, 'R')) {
      for (;;) {
        const k = yield { kind: 'pick', prompt: `${name}  Erase: click objects to delete`, def: 'done', preview: (_c, m) => ghost(m.ent ? stripEnt(m.ent) : null, 'del') };
        if (k.k !== 'pt') break;
        if (k.ent) { undoLog.push(c.snapshot()); c.remove([k.ent.id]); }
      }
    } else return;
  }
};
type Picked = { ent: Entity; p: P2 };
/** İki seçim arasında köşe uygular; hata varsa metni döner. dry → yalnız önizleme bağlantısı hesaplanır. */
function applyCorner(c: Ctx, A: Picked, B: Picked, spec: CornerSpec, trim: boolean, dry = false): string | Shape2 | null {
  if (A.ent.t === 'line' && B.ent.t === 'line' && A.ent.id !== B.ent.id) {
    const r = cornerLines(A.ent, A.p, B.ent, B.p, spec, trim);
    if (typeof r === 'string') return r;
    if (dry) return r.link;
    c.update(A.ent.id, stripEnt(r.a as Entity)); c.update(B.ent.id, stripEnt(r.b as Entity));
    if (r.link) c.add(r.link);
    return null;
  }
  if (A.ent.id === B.ent.id && A.ent.t === 'pline') {
    const pl = A.ent, n = pl.v.length, m = pl.closed ? n : n - 1, iA = closestOn(pl, A.p).i, iB = closestOn(pl, B.p).i;
    const lo = Math.min(iA, iB), hi = Math.max(iA, iB);
    const vi = hi - lo === 1 ? hi : pl.closed && lo === 0 && hi === m - 1 ? 0 : -1;
    if (vi < 0) return 'Polyline segments are not adjacent.';
    const r = cornerPline(stripEnt(pl) as PlineS, spec, vi);
    if (!r.count) return 'Cannot apply to this corner.';
    if (dry) return r.shape;
    c.update(pl.id, r.shape);
    return null;
  }
  return 'Only lines and adjacent polyline segments are supported.';
}
const cornerCmd = (kind: 'fillet' | 'chamfer') => function* (c: Ctx): G {
  const tag = kind === 'fillet' ? 'FILLET' : 'CHAMFER';
  let multiple = false;
  const undoLog: Entity[][] = [];
  const spec = (zero: boolean): CornerSpec => (kind === 'fillet' ? { kind, r: zero ? 0 : vars.filletR } : { kind, d1: zero ? 0 : vars.chamD1, d2: zero ? 0 : vars.chamD2 });
  const settings = () => c.msg(kind === 'fillet'
    ? `Current settings: Mode = ${vars.cornerTrim ? 'TRIM' : 'NOTRIM'}, Radius = ${fmt(vars.filletR)}`
    : `(${vars.cornerTrim ? 'TRIM' : 'NOTRIM'} mode) Current chamfer Dist1 = ${fmt(vars.chamD1)}, Dist2 = ${fmt(vars.chamD2)}`);
  settings();
  for (;;) {
    const e1 = yield {
      kind: 'pick', prompt: `${tag}  Select first ${kind === 'fillet' ? 'object' : 'line'}`, filter: e => e.t === 'line' || e.t === 'pline',
      opts: [o('Undo', 'U'), o('Polyline', 'P'), kind === 'fillet' ? o('Radius', 'R') : o('Distance', 'D'), o('Trim', 'T'), o('Multiple', 'M')],
      preview: (_c, m) => ghost(m.ent ? stripEnt(m.ent) : null, 'hi'),
    };
    if (isOpt(e1, 'U')) { const s = undoLog.pop(); if (s) c.restore(s); else c.msg('Nothing to undo.'); continue; }
    if (isOpt(e1, 'M')) { multiple = true; continue; }
    if (isOpt(e1, 'R')) { const r = yield* askNum(`${tag}  Specify fillet radius`, vars.filletR); if (typeof r === 'number' && r >= 0) vars.filletR = r; settings(); continue; }
    if (isOpt(e1, 'D')) {
      const d1 = yield* askNum(`${tag}  Enter first chamfer distance`, vars.chamD1);
      if (typeof d1 !== 'number' || d1 < 0) continue;
      const d2 = yield* askNum(`${tag}  Enter second chamfer distance`, d1);
      if (typeof d2 === 'number' && d2 >= 0) { vars.chamD1 = d1; vars.chamD2 = d2; }
      settings();
      continue;
    }
    if (isOpt(e1, 'T')) {
      const k = yield { kind: 'value', prompt: `${tag}  Enter Trim mode option`, opts: [o('Trim', 'T'), o('No trim', 'N')], def: vars.cornerTrim ? 'Trim' : 'No trim' };
      if (isOpt(k, 'T')) vars.cornerTrim = true; else if (isOpt(k, 'N')) vars.cornerTrim = false;
      continue;
    }
    if (isOpt(e1, 'P')) {
      const k = yield { kind: 'pick', prompt: `${tag}  Select 2D polyline`, filter: e => e.t === 'pline', preview: (_c, m) => (m.ent?.t === 'pline' ? ghost(cornerPline(stripEnt(m.ent) as PlineS, spec(false), null).shape, 'hi') : []) };
      if (k.k === 'pt' && k.ent?.t === 'pline') {
        const r = cornerPline(stripEnt(k.ent) as PlineS, spec(false), null);
        if (r.count) { undoLog.push(c.snapshot()); c.update(k.ent.id, r.shape); }
        c.msg(`${r.count} corner(s) ${kind === 'fillet' ? 'filleted' : 'chamfered'}.`);
        if (!multiple) return;
      }
      continue;
    }
    if (e1.k !== 'pt') return;
    if (!e1.ent) continue;
    const A: Picked = { ent: e1.ent, p: e1.p };
    const e2 = yield {
      kind: 'pick', prompt: `${tag}  Select second ${kind === 'fillet' ? 'object' : 'line'} or shift-select to apply corner`, filter: e => e.t === 'line' || e.t === 'pline',
      preview: (cur, m) => { const k = m.ent ? applyCorner(c, A, { ent: m.ent, p: cur }, spec(m.shift), vars.cornerTrim, true) : null; return [...ghost(stripEnt(A.ent), 'hi'), ...(k && typeof k !== 'string' ? ghost(k) : [])]; },
    };
    if (e2.k !== 'pt') return;
    if (!e2.ent) continue;
    const before = c.snapshot(), err = applyCorner(c, A, { ent: e2.ent, p: e2.p }, spec(e2.shift), vars.cornerTrim);
    if (typeof err === 'string') { c.msg(err); continue; }
    undoLog.push(before);
    if (!multiple) return;
  }
};
function* askInt(prompt: string, def: number, min = 1): G<number> {
  const n = yield* askNum(prompt, def);
  return typeof n === 'number' && Number.isInteger(n) && n >= min ? n : def;
}
function* askPos(prompt: string, def: number): G<number> {
  const n = yield* askNum(prompt, def);
  return typeof n === 'number' && isFinite(n) && n !== 0 ? n : def;
}
function* ARRAYRECT(c: Ctx): G {
  const sel = yield* selectObjects(c, 'ARRAYRECT');
  if (!sel) return;
  const bb = bboxOfAll(sel);
  let cols = 4, rows = 3, dx = Math.max((bb.max.x - bb.min.x) * 1.5, 10), dy = Math.max((bb.max.y - bb.min.y) * 1.5, 10);
  const build = (): Shape2[] => {
    const out: Shape2[] = [];
    for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) if (r || k) for (const e of sel) out.push(transformShape(stripEnt(e), mTranslate(P(k * dx, r * dy))));
    return out;
  };
  for (;;) {
    const ev = yield {
      kind: 'value', prompt: `ARRAYRECT  ${cols} columns x ${rows} rows, spacing ${fmt(dx, 2)} x ${fmt(dy, 2)} — Enter to accept`,
      opts: [o('COUnt', 'COU'), o('Spacing', 'S'), o('COLumns', 'COL'), o('Rows', 'R'), o('eXit', 'X')], preview: () => build().flatMap(s => ghost(s)),
    };
    if (ev.k === 'enter' || isOpt(ev, 'X')) { c.addAll(build()); break; }
    if (isOpt(ev, 'COU')) { cols = yield* askInt('ARRAYRECT  Enter the number of columns', cols); rows = yield* askInt('ARRAYRECT  Enter the number of rows', rows); }
    else if (isOpt(ev, 'S')) { dx = yield* askPos('ARRAYRECT  Specify the distance between columns', dx); dy = yield* askPos('ARRAYRECT  Specify the distance between rows', dy); }
    else if (isOpt(ev, 'COL')) { cols = yield* askInt('ARRAYRECT  Enter the number of columns', cols); dx = yield* askPos('ARRAYRECT  Specify the distance between columns', dx); }
    else if (isOpt(ev, 'R')) { rows = yield* askInt('ARRAYRECT  Enter the number of rows', rows); dy = yield* askPos('ARRAYRECT  Specify the distance between rows', dy); }
    else break;
  }
  c.setSel([]);
}
function* ARRAYPOLAR(c: Ctx): G {
  const sel = yield* selectObjects(c, 'ARRAYPOLAR');
  if (!sel) return;
  const e0 = yield { kind: 'point', prompt: 'ARRAYPOLAR  Specify center point of array' };
  if (e0.k !== 'pt') { c.setSel([]); return; }
  const ctr = e0.p, bb = bboxOfAll(sel), own = mid(bb.min, bb.max);
  let items = 6, fill = 360, rotate = true;
  const build = (): Shape2[] => {
    const step = rad(fill) / (Math.abs(fill) >= 360 ? items : Math.max(1, items - 1)), out: Shape2[] = [];
    for (let k = 1; k < items; k++) {
      const m = rotate ? mRotate(ctr, k * step) : mTranslate(sub(rotAbout(own, ctr, k * step), own));
      for (const e of sel) out.push(transformShape(stripEnt(e), m));
    }
    return out;
  };
  for (;;) {
    const ev = yield {
      kind: 'value', prompt: `ARRAYPOLAR  ${items} items, fill angle ${fmt(fill, 2)}° — Enter to accept`,
      opts: [o('Items', 'I'), o('Angle between', 'A'), o('Fill angle', 'F'), o('ROTate items', 'ROT'), o('eXit', 'X')], preview: () => build().flatMap(s => ghost(s)),
    };
    if (ev.k === 'enter' || isOpt(ev, 'X')) { c.addAll(build()); break; }
    if (isOpt(ev, 'I')) items = yield* askInt('ARRAYPOLAR  Enter number of items in array', items, 2);
    else if (isOpt(ev, 'F')) fill = Math.max(-360, Math.min(360, yield* askPos('ARRAYPOLAR  Specify the angle to fill (+ = ccw, - = cw)', fill)));
    else if (isOpt(ev, 'A')) { const a = yield* askPos('ARRAYPOLAR  Specify angle between items', fill / items); fill = Math.max(-360, Math.min(360, Math.abs(a * items) >= 360 ? 360 * Math.sign(a) : a * (items - 1))); }
    else if (isOpt(ev, 'ROT')) {
      const k = yield { kind: 'value', prompt: 'ARRAYPOLAR  Rotate arrayed items?', opts: [o('Yes', 'Y'), o('No', 'N')], def: rotate ? 'Yes' : 'No' };
      if (isOpt(k, 'Y')) rotate = true; else if (isOpt(k, 'N')) rotate = false;
    } else break;
  }
  c.setSel([]);
}
function* ARRAYPATH(c: Ctx): G {
  const sel = yield* selectObjects(c, 'ARRAYPATH');
  if (!sel) return;
  const own = new Set(sel.map(e => e.id));
  const e0 = yield { kind: 'pick', prompt: 'ARRAYPATH  Select path curve', filter: e => !own.has(e.id), preview: (_c, m) => ghost(m.ent ? stripEnt(m.ent) : null, 'hi') };
  if (e0.k !== 'pt' || !e0.ent) { c.setSel([]); return; }
  const path = stripEnt(e0.ent), total = shapeLength(path), closed = isClosedShape(path);
  let items = 6, align = true;
  const build = (): Shape2[] => {
    const step = total / (closed ? items : Math.max(1, items - 1)), b0 = alongShape(path, 0), out: Shape2[] = [];
    for (let k = 1; k < items; k++) {
      const q = alongShape(path, k * step);
      for (const e of sel) {
        const moved = transformShape(stripEnt(e), mTranslate(sub(q.p, b0.p)));
        out.push(align ? transformShape(moved, mRotate(q.p, q.ang - b0.ang)) : moved);
      }
    }
    return out;
  };
  for (;;) {
    const ev = yield {
      kind: 'value', prompt: `ARRAYPATH  ${items} items along the path (${align ? 'aligned' : 'not aligned'}) — Enter to accept`,
      opts: [o('Items', 'I'), o('Align items', 'A'), o('eXit', 'X')], preview: () => build().flatMap(s => ghost(s)),
    };
    if (ev.k === 'enter' || isOpt(ev, 'X')) { c.addAll(build()); break; }
    if (isOpt(ev, 'I')) items = yield* askInt('ARRAYPATH  Enter number of items along path', items, 2);
    else if (isOpt(ev, 'A')) {
      const k = yield { kind: 'value', prompt: 'ARRAYPATH  Align arrayed items to path?', opts: [o('Yes', 'Y'), o('No', 'N')], def: align ? 'Yes' : 'No' };
      if (isOpt(k, 'Y')) align = true; else if (isOpt(k, 'N')) align = false;
    } else break;
  }
  c.setSel([]);
}
function* ERASE(c: Ctx): G {
  const sel = yield* selectObjects(c, 'ERASE');
  if (sel) { c.remove(sel.map(e => e.id)); c.msg(`${sel.length} object(s) erased.`); }
}
function* EXPLODE(c: Ctx): G {
  const sel = yield* selectObjects(c, 'EXPLODE');
  if (!sel) return;
  let n = 0;
  for (const e of sel) {
    if (e.t !== 'pline') continue;
    const parts = primsOf(e).map(p => (p.k === 's' ? L(p.a, p.b) : p.k === 'a' ? arcOfPrim(p) : null)).filter((s): s is LineS | ArcS | CircleS => !!s);
    c.remove([e.id]); c.addAll(parts); n++;
  }
  c.msg(n ? `${n} polyline(s) exploded.` : 'Nothing to explode — only polylines (rectangles, polygons) can be exploded.');
  c.setSel([]);
}
function* OFFSET(c: Ctx): G {
  let through = false, d = vars.offsetDist;
  const e0 = yield { kind: 'point', num: true, prompt: 'OFFSET  Specify offset distance', def: d > 0 ? fmt(d) : 'Through', opts: [o('Through', 'T')] };
  if (e0.k === 'num') { if (!(e0.v > 0)) { c.msg('Requires a positive, non-zero value.'); return; } d = e0.v; }
  else if (e0.k === 'pt') {
    const e1 = yield { kind: 'point', base: e0.p, prompt: 'OFFSET  Specify second point', preview: cur => [rub(e0.p, cur)] };
    if (e1.k !== 'pt' || same(e1.p, e0.p)) return;
    d = dist(e0.p, e1.p);
  } else if (isOpt(e0, 'T') || (e0.k === 'enter' && !(d > 0))) through = true;
  else if (e0.k !== 'enter') return;
  if (!through) vars.offsetDist = d;
  const made: string[] = [];
  for (;;) {
    const e1 = yield { kind: 'pick', prompt: 'OFFSET  Select object to offset', def: 'Exit', opts: [o('Exit', 'E'), o('Undo', 'U')], preview: (_c, m) => ghost(m.ent ? stripEnt(m.ent) : null, 'hi') };
    if (isOpt(e1, 'U')) { const id = made.pop(); if (id) c.remove([id]); else c.msg('Nothing to undo.'); continue; }
    if (e1.k !== 'pt') return;
    if (!e1.ent) continue;
    const src = stripEnt(e1.ent);
    if (src.t === 'ellipse') { c.msg('Cannot offset that object.'); continue; }
    let multi = false;
    for (;;) {
      const e2 = yield {
        kind: 'point', noSnap: !through, prompt: through ? 'OFFSET  Specify through point' : 'OFFSET  Specify point on side to offset', def: multi ? 'next object' : 'Exit',
        opts: [o('Exit', 'E'), ...(multi ? [] : [o('Multiple', 'M')]), o('Undo', 'U')], preview: cur => [...ghost(src, 'hi'), ...ghost(offsetShape(src, through ? null : d, cur))],
      };
      if (isOpt(e2, 'M')) { multi = true; continue; }
      if (isOpt(e2, 'U')) { const id = made.pop(); if (id) c.remove([id]); continue; }
      if (isOpt(e2, 'E')) return;
      if (e2.k !== 'pt') { if (multi) break; return; }
      const res = offsetShape(src, through ? null : d, e2.p);
      if (res) made.push(c.add(res).id); else c.msg('Cannot offset to that side.');
      if (!multi) break;
    }
  }
}

// ── Kayıt ──
export interface CmdDef { id: string; label: string; group: 'draw' | 'modify'; family?: string; aliases: string[]; run: (c: Ctx) => G }
const D = (id: string, label: string, run: (c: Ctx) => G, aliases: string[] = [], family?: string): CmdDef => ({ id, label, group: 'draw', family, aliases, run });
const M = (id: string, label: string, run: (c: Ctx) => G, aliases: string[] = [], family?: string): CmdDef => ({ id, label, group: 'modify', family, aliases, run });
export const COMMANDS: CmdDef[] = [
  D('LINE', 'Line', LINE, ['L']),
  D('PLINE', 'Polyline', PLINE, ['PL', 'POLYLINE']),
  D('CIRCLE', 'Center, Radius', c => circleCR(c, false), ['C'], 'circle'),
  D('CIRCLE_CD', 'Center, Diameter', c => circleCR(c, true), [], 'circle'),
  D('CIRCLE_2P', '2-Point', circle2P, [], 'circle'),
  D('CIRCLE_3P', '3-Point', circle3P, [], 'circle'),
  D('CIRCLE_TTR', 'Tan, Tan, Radius', circleTTR, ['TTR'], 'circle'),
  D('CIRCLE_TTT', 'Tan, Tan, Tan', circleTTT, ['TTT'], 'circle'),
  D('ARC_3P', '3-Point', c => arc3P(c), [], 'arc'),
  D('ARC_SCE', 'Start, Center, End', arcPreset('ARC SCE', 'SC', 'E'), [], 'arc'),
  D('ARC_SCA', 'Start, Center, Angle', arcPreset('ARC SCA', 'SC', 'A'), [], 'arc'),
  D('ARC_SCL', 'Start, Center, Length', arcPreset('ARC SCL', 'SC', 'L'), [], 'arc'),
  D('ARC_SEA', 'Start, End, Angle', arcPreset('ARC SEA', 'SE', 'A'), [], 'arc'),
  D('ARC_SED', 'Start, End, Direction', arcPreset('ARC SED', 'SE', 'D'), [], 'arc'),
  D('ARC_SER', 'Start, End, Radius', arcPreset('ARC SER', 'SE', 'R'), [], 'arc'),
  D('ARC_CSE', 'Center, Start, End', arcPreset('ARC CSE', 'CS', 'E'), [], 'arc'),
  D('ARC_CSA', 'Center, Start, Angle', arcPreset('ARC CSA', 'CS', 'A'), [], 'arc'),
  D('ARC_CSL', 'Center, Start, Length', arcPreset('ARC CSL', 'CS', 'L'), [], 'arc'),
  D('ARC_CONT', 'Continue', arcCont, [], 'arc'),
  D('ARC', 'Arc', ARC, ['A']),
  D('RECT', 'Rectangle - Two Corners', RECT, ['REC', 'RECTANG', 'RECTANGLE'], 'shape'),
  D('RECT_ROT', 'Rectangle - Rotated', rectRot, [], 'shape'),
  D('RECT_CEN', 'Rectangle - Center', rectCen, [], 'shape'),
  D('POLY', 'Polygon - Inscribed', polyCmd('I'), [], 'shape'),
  D('POLY_C', 'Polygon - Circumscribed', polyCmd('C'), [], 'shape'),
  D('POLY_E', 'Polygon - Edge', polyE, [], 'shape'),
  D('POLYGON', 'Polygon', polyCmd(null), ['POL']),
  D('ELLIPSE', 'Center, Axes', ellipseCenter(false), ['EL'], 'ellipse'),
  D('ELLIPSE_AXIS', 'Axis, End', ellipseAxis, [], 'ellipse'),
  D('ELLIPSE_ARC', 'Ellipse Arc', ellipseCenter(true), [], 'ellipse'),
  M('MOVE', 'Move', MOVE, ['M']),
  M('COPY', 'Copy', COPY, ['CO', 'CP']),
  M('STRETCH', 'Stretch', STRETCH, ['S']),
  M('ROTATE', 'Rotate', ROTATE, ['RO']),
  M('MIRROR', 'Mirror', MIRROR, ['MI']),
  M('SCALE', 'Scale', SCALE, ['SC']),
  M('TRIM', 'Trim', trimExtend('TRIM'), ['TR'], 'trim'),
  M('EXTEND', 'Extend', trimExtend('EXTEND'), ['EX'], 'trim'),
  M('FILLET', 'Fillet', cornerCmd('fillet'), ['F'], 'fillet'),
  M('CHAMFER', 'Chamfer', cornerCmd('chamfer'), ['CHA'], 'fillet'),
  M('ARRAYRECT', 'Rectangular Array', ARRAYRECT, ['AR', 'ARRAY'], 'array'),
  M('ARRAYPATH', 'Path Array', ARRAYPATH, [], 'array'),
  M('ARRAYPOLAR', 'Polar Array', ARRAYPOLAR, [], 'array'),
  M('ERASE', 'Erase', ERASE, ['E', 'DELETE']),
  M('EXPLODE', 'Explode', EXPLODE, ['X']),
  M('OFFSET', 'Offset', OFFSET, ['O']),
  M('PSEL', 'Select points', PSEL, ['POINTS']),
];
export const commandById = (id: string) => COMMANDS.find(c => c.id === id);
/** Metin bir komut adı / kısaltması mı? (komut satırında Boşluk = Enter kararı için) */
export const isCommandName = (name: string) => { const up = name.trim().toUpperCase(); return ['U', 'UNDO', 'REDO'].includes(up) || COMMANDS.some(c => c.id === up || c.aliases.includes(up)); };
