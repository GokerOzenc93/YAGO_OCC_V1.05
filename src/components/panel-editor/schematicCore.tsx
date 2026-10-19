import React, { useEffect } from 'react';
import { UI_FONT } from '../Ui';
import { clipPolyToConvex, polyArea } from '../FaceRegion';
import { type EdgeKey, type SolvedNode, type SplitOf, findParent, treeLeaves } from '../SplitShared';
import {
  DimPill, LOCK_EXT, LOCK_OFF, LOCK_R, LockBadge, PREVIEW_BG, PREVIEW_FRAME, PassivePill, PillEditInput, type Pt, SCHEMATIC_CSS, SOFT, VGrad, fmt1,
  parseNum, pillSize, stop, useEditSession,
} from './kit';

/* KAPAK / ARKALIK ŞEMASI ORTAK ÇEKİRDEĞİ — yalnız çizim ve yerleşim (servisler ayrı): ekran haritası, levha bantları, ölçü zincirleri,
   pill şeritleri, kilit / rozet yerleşimi, ortak SVG parçaları ve değer kutusu. */

const PART_INSET = 1.5;   // parçalar içeri çizilir ki 3 mm boşluklar görünsün
const BAND_MIN = 6;
const CHAIN_OFF_H = 27;          // alt bant ve ortadaki rozetle çakışmasın
const CHAIN_OFF_V = 38;          // pill'ler yatay geniş, sağ bant rozetini aşsın
const CHAIN_STEP = 16;
const PILL_LANE_GAP = 3;

type Axis = 'u' | 'v';
export type Box4 = { u0: number; u1: number; v0: number; v1: number };
type PxBox = { x0: number; y0: number; x1: number; y1: number };
type Rect = { x: number; y: number; w: number; h: number };
type SchemEdit = { key: string; v: string };
/** Ölçü zinciri öğesi; a..b = eksen boyunca mm. `span` (yalnız boşluk): kenarın/derzin çapraz eksendeki GERÇEK uzunluğu —
 *  pill bu uzunluğun ortasına yerleşir (açılı kesimde kenar kısalır). */
export type ChainItem = {
  key: string; kind: 'size' | 'gap'; a: number; b: number; txt: string; title: string; locked?: boolean; edited?: boolean; passive?: boolean;
  onLock?: () => void; lockTitle?: string; commit: (v: number) => void; preview?: (v: number) => void; min: number; span?: [number, number];
};
type Chain = { horiz: boolean; pos: number; items: ChainItem[] };
/** Düzenlenebilir değerin kutusu (pill / rozet). */
export type EditTarget = { cx: number; cy: number; pw: number; ph: number; f: number; item: ChainItem };
type Pill = EditTarget & { key: string; horiz: boolean; deg?: number; lock?: Pt };
/** Rozet ekseni: merkez, birim yön ve yarı boy — rozet bu eksen boyunca kaydırılır. */
export type ChipAxis = { cx: number; cy: number; ux: number; uy: number; half: number };

export const isAdditive = (e: React.MouseEvent) => e.shiftKey || e.ctrlKey || e.metaKey;
const ptsPath = (pts: Pt[]) => pts.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ') + ' Z';
const rectPts = (b: PxBox): Pt[] => [{ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 }, { x: b.x1, y: b.y1 }, { x: b.x0, y: b.y1 }];
/** Yazı okunur yönde (−90°..90°); % yerine döngü: JS % negatifte işaret korur. */
const readableDeg = (deg: number) => { while (deg > 90) deg -= 180; while (deg < -90) deg += 180; return deg; };
/** Aralık en az `min` (ortasından açılır). */
export const widen = (lo: number, hi: number, min: number): [number, number] => (hi - lo < min ? [(lo + hi) / 2 - min / 2, (lo + hi) / 2 + min / 2] : [lo, hi]);
export const crossOf = (r: Box4, ax: Axis): [number, number] => (ax === 'u' ? [r.v0, r.v1] : [r.u0, r.u1]);

/* ───────────── EKRAN HARİTASI ───────────── */

/** mm (u, v) → px. Eksenler ayrı ölçeklenir; aynalı görünüşte u / v ters akar. x1 / y1 = çizim alanının sağ / alt sınırı (bantlar
 *  buraya kırpılır). */
export function schemView(rect: Box4, ox: number, oy: number, SW: number, SH: number, mirrorU: boolean, mirrorV: boolean, x1: number, y1: number) {
  const duR = Math.max(1e-6, rect.u1 - rect.u0), dvR = Math.max(1e-6, rect.v1 - rect.v0);
  const sx = (u: number) => (mirrorU ? ox + SW - ((u - rect.u0) / duR) * SW : ox + ((u - rect.u0) / duR) * SW);
  const sy = (v: number) => (mirrorV ? oy + ((v - rect.v0) / dvR) * SH : oy + ((rect.v1 - v) / dvR) * SH);
  const toMm = ([x, y]: number[]): Pt => ({
    x: rect.u0 + (mirrorU ? (ox + SW - x) : (x - ox)) * duR / SW,
    y: mirrorV ? rect.v0 + (y - oy) * dvR / SH : rect.v1 - (y - oy) * dvR / SH,
  });
  return {
    sx, sy, ox, oy, SW, SH, duR, dvR, mirrorU, mirrorV,
    toPx: (q: Pt): Pt => ({ x: sx(q.x), y: sy(q.y) }),
    /** mm kutusunun px kutusu, `inset` px içeri. */
    box: (r: Box4, inset = 0): PxBox => ({
      x0: Math.min(sx(r.u0), sx(r.u1)) + inset, x1: Math.max(sx(r.u0), sx(r.u1)) - inset,
      y0: Math.min(sy(r.v1), sy(r.v0)) + inset, y1: Math.max(sy(r.v1), sy(r.v0)) - inset,
    }),
    clampX: (x: number) => Math.max(2, Math.min(x1, x)),
    clampY: (y: number) => Math.max(2, Math.min(y1, y)),
    /** Çizim alanı (mm): açılı / pahlı levha zarfı buna kırpılır. */
    areaMm: [[2, 2], [x1, 2], [x1, y1], [2, y1]].map(toMm),
  };
}
export type SchemView = ReturnType<typeof schemView>;
/** Açılı levha şeridinin en ince kalınlığı (mm) = BAND_MIN px. */
export const cutMinMm = (v: SchemView) => BAND_MIN * v.dvR / v.SH;
/** Ekrandaki yan adı (dikeyde Left / Right, yatayda Top / Bottom); `lead` = aynasız görünüşte sol / üst taraf. */
export const sideLabel = (vertical: boolean, lead: boolean, v: SchemView) =>
  (vertical ? (lead !== v.mirrorU ? 'Left' : 'Right') : (lead !== v.mirrorV ? 'Top' : 'Bottom'));
export const edgeLabel = (vertical: boolean, k: EdgeKey | undefined, v: SchemView) => sideLabel(vertical, vertical ? k === 'uMin' : k === 'vMax', v);
export const leafIds = (n: SolvedNode): string[] => treeLeaves(n).map(l => l.id);
/** Kökten düğüme kimlik yolu. */
export function nodePath(root: SolvedNode, id: string): string[] {
  const out: string[] = [];
  const dfs = (n: SolvedNode): boolean => {
    out.push(n.id);
    if (n.id === id) return true;
    if (n.kind === 'split') for (const c of n.children) if (dfs(c)) return true;
    out.pop(); return false;
  };
  dfs(root);
  return out;
}

/* ───────────── LEVHA BANTLARI ───────────── */

type NearLike = { kind: Axis; a0: number; a1: number; c0: number; c1: number; poly?: Pt[]; ref?: unknown; joint?: unknown };
/** Sınır levhası bandı (px): kalınlık en az BAND_MIN, boy çizim alanına kırpılı. Ön görünüşü dikdörtgen olmayan levhada (eğik panel
 *  altında pahlı yan) `pts` gerçek izdüşüm zarfı, x/y/w/h = zarfın kutusu. `aligned` = levhaya bağlı derz (sıcak ton). */
export function bandGeom(np: NearLike, v: SchemView) {
  const vertical = np.kind === 'u';
  const along = vertical ? v.sx : v.sy, across = vertical ? v.sy : v.sx, clamp = vertical ? v.clampY : v.clampX;
  const [a0, a1] = widen(Math.min(along(np.a0), along(np.a1)), Math.max(along(np.a0), along(np.a1)), BAND_MIN);
  const c0 = clamp(Math.min(across(np.c0), across(np.c1))), c1 = clamp(Math.max(across(np.c0), across(np.c1)));
  let x = vertical ? a0 : c0, y = vertical ? c0 : a0, w = vertical ? a1 - a0 : c1 - c0, h = vertical ? c1 - c0 : a1 - a0;
  let pts: Pt[] = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  const hull = np.poly ? clipPolyToConvex(np.poly, v.areaMm) : [];
  if (hull.length >= 3) {
    pts = hull.map(v.toPx);
    const xs = pts.map(q => q.x), ys = pts.map(q => q.y);
    x = Math.min(...xs); y = Math.min(...ys); w = Math.max(...xs) - x; h = Math.max(...ys) - y;
  }
  return { vertical, x, y, w, h, pts, aligned: !!np.ref && !!np.joint };
}
export const bandAxis = (b: Rect & { vertical: boolean }): ChipAxis =>
  ({ cx: b.x + b.w / 2, cy: b.y + b.h / 2, ux: b.vertical ? 0 : 1, uy: b.vertical ? 1 : 0, half: (b.vertical ? b.h : b.w) / 2 });
/** Açılı levha şeridi (px): ağırlık merkezi ve okunur yöndeki açısı. */
export function cutBandGeom(cb: { poly: Pt[]; dir: Pt }, v: SchemView) {
  const pts = cb.poly.map(v.toPx);
  const cx = pts.reduce((a, q) => a + q.x, 0) / pts.length, cy = pts.reduce((a, q) => a + q.y, 0) / pts.length;
  return { pts, cx, cy, deg: readableDeg(Math.atan2((v.mirrorV ? 1 : -1) * cb.dir.y, (v.mirrorU ? -1 : 1) * cb.dir.x) * 180 / Math.PI) };
}
export const cutAxis = (cb: { pts: Pt[]; cx: number; cy: number; deg: number }): ChipAxis => {
  const rad = cb.deg * Math.PI / 180, ux = Math.cos(rad), uy = Math.sin(rad);
  return { cx: cb.cx, cy: cb.cy, ux, uy, half: Math.max(...cb.pts.map(q => Math.abs((q.x - cb.cx) * ux + (q.y - cb.cy) * uy))) };
};
/** Bandın parçaların ALTINDA kalan kısımları (taralı, kesikli çizilir). */
const hiddenParts = (pts: Pt[], members: Box4[], v: SchemView) => members.flatMap(m => {
  const b = v.box(m, PART_INSET);
  if (b.x1 - b.x0 < 0.5 || b.y1 - b.y0 < 0.5) return [];
  const part = clipPolyToConvex(pts, rectPts(b));
  return part.length >= 3 && Math.abs(polyArea(part)) > 0.5 ? [part] : [];
});
/** Üyelerin `dir` yönündeki en uzun kenarı (eğik kenar). */
export function longestEdgeAlong<M extends { poly?: Pt[] }>(members: M[], dir: Pt, keep: (m: M) => boolean = () => true) {
  let best: { a: Pt; b: Pt; len: number; m: M } | null = null;
  for (const m of members) {
    if (!m.poly || !keep(m)) continue;
    for (let i = 0; i < m.poly.length; i++) {
      const a = m.poly[i], b = m.poly[(i + 1) % m.poly.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1 || Math.abs((b.x - a.x) * dir.y - (b.y - a.y) * dir.x) / len > 0.01) continue;
      if (!best || len > best.len) best = { a, b, len, m };
    }
  }
  return best;
}
/** Eğik kenarlar: kesilen kenarı olan her açılı şeridin, üyelerdeki en uzun eşyönlü kenarı. Düz kenar zincirlerinde o kenar GÖSTERİLMEZ. */
export const slopeSegsOf = <C extends { edge: EdgeKey | null; dir: Pt }, M extends { poly?: Pt[] }>(cutBands: C[], members: M[]) =>
  cutBands.flatMap(cb => {
    if (!cb.edge) return [];
    const best = longestEdgeAlong(members, cb.dir);
    return best ? [{ cb, edge: cb.edge, ...best }] : [];
  });
/** Eğik kenar pill'i: kenarın ortasında, kenar yönünde döndürülmüş; `off` px parçanın içine (+) / dışına (−). */
export function slopePill(sg: { a: Pt; b: Pt; m: { poly?: Pt[] } }, v: SchemView, fs: number, item: ChainItem, off: number): Pill {
  const a = v.toPx(sg.a), b = v.toPx(sg.b), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const L = Math.hypot(b.x - a.x, b.y - a.y) || 1, tx = (b.x - a.x) / L, ty = (b.y - a.y) / L;
  const poly = sg.m.poly!, cxm = poly.reduce((s0, q) => s0 + v.sx(q.x), 0) / poly.length, cym = poly.reduce((s0, q) => s0 + v.sy(q.y), 0) / poly.length;
  let nx = -ty, ny = tx;
  if (nx * (cxm - mid.x) + ny * (cym - mid.y) < 0) { nx = -nx; ny = -ny; }
  const { pw, ph } = pillSize(item.txt, fs);
  return { key: item.key, cx: mid.x + nx * off, cy: mid.y + ny * off, pw, ph, f: fs, item, horiz: true, deg: readableDeg(Math.atan2(ty, tx) * 180 / Math.PI) };
}

/* ───────────── ÖLÇÜ ZİNCİRLERİ ───────────── */

/** Çokgenin `ax` = val doğrusu üzerindeki kesişim aralığı (çapraz eksende). */
function lineSpan(poly: Pt[], ax: Axis, val: number): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const pa = ax === 'u' ? a.x : a.y, pb = ax === 'u' ? b.x : b.y;
    if ((pa - val) * (pb - val) > 0 || Math.abs(pb - pa) < 1e-9) continue;
    const t = (val - pa) / (pb - pa), q = ax === 'u' ? a.y + t * (b.y - a.y) : a.x + t * (b.x - a.x);
    lo = Math.min(lo, q); hi = Math.max(hi, q);
  }
  return hi - lo > 0.5 ? [lo, hi] : null;
}
const clampSpan = (sp: [number, number], c: [number, number]): [number, number] => {
  const lo = Math.max(sp[0], Math.min(c[0], c[1])), hi = Math.min(sp[1], Math.max(c[0], c[1]));
  return hi - lo > 1 ? [lo, hi] : sp;
};
/** Ölçü zincirleri + turuncu boşluk şeritleri. `outline` = kutunun (açılı kesimli) mm çokgeni: boşluk pill'i kenarın / derzin
 *  gerçek uzunluğunun ortasına yerleşir. */
export function chainKit(v: SchemView, outline: (r: Box4) => Pt[]) {
  const chains: Chain[] = [], strips: Rect[] = [];
  const slots = new Map<string, { h: number; v: number }>();   // bölge başına aynı yöndeki zincir sayısı (kademe)
  const memo = new Map<string, Pt[]>();
  const outlineOf = (r: Box4) => {
    const key = `${r.u0.toFixed(2)},${r.u1.toFixed(2)},${r.v0.toFixed(2)},${r.v1.toFixed(2)}`;
    let o = memo.get(key);
    if (!o) { o = outline(r); memo.set(key, o); }
    return o;
  };
  /** R'nin ax = val doğrusundaki uzunluğu; `on` verilirse o bölgeye kırpılır. */
  const spanAt = (R: Box4, ax: Axis, val: number, on?: Box4) => {
    const sp = lineSpan(outlineOf(R), ax, val) ?? crossOf(R, ax);
    return on ? clampSpan(sp, crossOf(on, ax)) : sp;
  };
  return {
    chains, strips,
    jointSpan: (R: Box4, ax: Axis, a: number, b: number, on?: Box4) => spanAt(R, ax, (a + b) / 2, on),
    /** Doğru kenarın 0.5 mm içinden geçer (tam kenarda kesişim belirsiz). */
    edgeSpan: (R: Box4, k: EdgeKey, on?: Box4) => spanAt(R, k === 'uMin' || k === 'uMax' ? 'u' : 'v',
      k === 'uMin' ? R.u0 + 0.5 : k === 'uMax' ? R.u1 - 0.5 : k === 'vMin' ? R.v0 + 0.5 : R.v1 - 0.5, on),
    /** Boşluk şeridi: `ax` ekseninde a..b (en az 3 px), çapraz eksende c. */
    strip: (ax: Axis, a: number, b: number, [c0, c1]: [number, number]) => {
      let { x0, x1, y0, y1 } = v.box(ax === 'u' ? { u0: a, u1: b, v0: c0, v1: c1 } : { u0: c0, u1: c1, v0: a, v1: b });
      if (ax === 'u') [x0, x1] = widen(x0, x1, 3); else [y0, y1] = widen(y0, y1, 3);
      strips.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    },
    /** Zincir bölgenin alt (yatay) / sağ (düşey) kenarının içinde; aynı bölgede aynı yöndeki her yeni zincir bir adım içeride. */
    pushChain: (on: Box4 & { id: string }, horiz: boolean, items: ChainItem[]) => {
      if (!items.length) return;
      const sl = slots.get(on.id) ?? { h: 0, v: 0 }; slots.set(on.id, sl);
      const b = v.box(on);
      const pos = horiz ? b.y1 - CHAIN_OFF_H - CHAIN_STEP * sl.h : b.x1 - CHAIN_OFF_V - CHAIN_STEP * sl.v;
      if (horiz) sl.h++; else sl.v++;
      chains.push({ horiz, pos, items });
    },
  };
}
type ChainKit = ReturnType<typeof chainKit>;
export type ChainParts<N extends SolvedNode> = {
  size: (P: SplitOf<N>, i: number, a: number, b: number, horiz: boolean) => ChainItem;
  /** Bölme yokken alanın tamamı (`ax` yönünde). */
  full: (ax: Axis, on: N) => ChainItem[];
  gapTitle: string;
  onGap: (splitId: string, k: number, v: number, preview?: boolean) => void;
  /** true → bu derzde zincirde ara yok (levhaya bağlı derz). */
  hideGap?: (P: SplitOf<N>, k: number) => boolean;
  /** Bölge alanın kenarına değiyorsa kenar boşluğu öğesi (`end` = bitiş ucu; `on` = zincirin bölgesi). */
  edge?: (n: N, horiz: boolean, end: boolean, at: number, on?: N) => ChainItem | null;
};
/** Seçili bölgenin zincirleri: bölmede kendi ölçüleri, yaprakta üst bölmedeki yeri; çapraz yönde ilk farklı eksenli üst bölmedeki yer
 *  (yoksa alanın tamamı). */
export function regionChains<N extends SolvedNode>(kit: ChainKit, root: N, n: N, parts: ChainParts<N>) {
  const gap = (P: SplitOf<N>, k: number, a: number, b: number, on: N, clampOn?: N): ChainItem[] => {
    if (parts.hideGap?.(P, k)) return [];
    kit.strip(P.axis, a, b, crossOf(on, P.axis));
    return [{ key: `sgap-${P.id}-${k}`, kind: 'gap', a, b, txt: fmt1(P.gaps[k] ?? 0), title: parts.gapTitle, min: 0,
      span: kit.jointSpan(P, P.axis, a, b, clampOn), commit: x => parts.onGap(P.id, k, x), preview: x => parts.onGap(P.id, k, x, true) }];
  };
  const edge = (m: N, horiz: boolean, end: boolean, at: number, on?: N): ChainItem[] => {
    const it = parts.edge?.(m, horiz, end, at, on);
    return it ? [it] : [];
  };
  const splitItems = (S: SplitOf<N>): ChainItem[] => {
    const horiz = S.axis === 'u', dir = horiz ? 1 : -1;
    let p = horiz ? S.u0 : S.v1;
    const items = edge(S, horiz, false, p);
    S.children.forEach((_c, i) => {
      const w = S.sizes[i]?.value ?? 0;
      items.push(parts.size(S, i, p, p + dir * w, horiz));
      p += dir * w;
      if (i < S.children.length - 1) { const g = S.gaps[i] ?? 0; items.push(...gap(S, i, p, p + dir * g, S)); p += dir * g; }
    });
    return [...items, ...edge(S, horiz, true, p)];
  };
  const placeItems = (m: N, P: SplitOf<N>, on: N): ChainItem[] => {
    const horiz = P.axis === 'u', dir = horiz ? 1 : -1;
    const idx = P.children.findIndex(c => c.id === m.id);
    if (idx < 0) return [];
    const start = horiz ? m.u0 : m.v1, end = start + dir * (P.sizes[idx]?.value ?? 0);
    const head = idx > 0 ? gap(P, idx - 1, start - dir * (P.gaps[idx - 1] ?? 0), start, on, on) : edge(m, horiz, false, start, on);
    const size = parts.size(P, idx, start, end, horiz);
    return [...head, size, ...(idx < P.children.length - 1 ? gap(P, idx, end, end + dir * (P.gaps[idx] ?? 0), on, on) : edge(m, horiz, true, end, on))];
  };
  const crossChain = (m: N, axis: Axis, on: N) => {
    let A: N = m, B = findParent(root, A.id);
    while (B && B.axis === axis) { A = B; B = findParent(root, B.id); }
    if (B) kit.pushChain(on, B.axis === 'u', placeItems(A, B, on));
    else kit.pushChain(on, axis !== 'u', parts.full(axis === 'u' ? 'v' : 'u', on));
  };
  if (n.kind === 'split') {
    const S = n as SplitOf<N>;
    kit.pushChain(n, S.axis === 'u', splitItems(S));
    crossChain(n, S.axis, n);
    return;
  }
  const P = findParent(root, n.id);
  if (P) { kit.pushChain(n, P.axis === 'u', placeItems(n, P, n)); crossChain(P, P.axis, n); }
  else { kit.pushChain(n, true, parts.full('u', n)); kit.pushChain(n, false, parts.full('v', n)); }
}

/* ───────────── PILL / KİLİT / ROZET YERLEŞİMİ ───────────── */

/** Çakışma önlemi: zincir başına şeritler (kademeli ölçü). Sabit boşluk pill'leri (kenar/derz ortasında) yerinde kalır; önce ÖLÇÜ
 *  pill'leri bunlara 2B'de çarpmayan ilk şeride, sonra serbest BOŞLUK pill'leri ilk boş şeride girer (sığmazsa son şerit — hiçbir boşluk
 *  gizlenmez). Şeritler bölgenin içine doğru (yatay → yukarı, düşey → sola). Kilit yeri: ölçünün ucu; çarpıyorsa karşı uç, sonra
 *  pill'in yanları — kilitler pill'lere ve birbirine binmesin. W / H = SVG boyu. */
export function layoutPills(chains: Chain[], v: SchemView, fs: number, slopePills: Pill[], W: number, H: number): Pill[] {
  type LanePill = Pill & { fixed: boolean };
  const chainPills = chains.map(ch => ({ ch, all: ch.items.map((it): LanePill => {
    const { pw, ph } = pillSize(it.txt, fs);
    const along = ch.horiz ? v.sx : v.sy, mid = (along(it.a) + along(it.b)) / 2;
    const sc = it.kind === 'gap' && it.span ? (ch.horiz ? v.sy : v.sx)((it.span[0] + it.span[1]) / 2) : null;
    return { key: it.key, cx: ch.horiz ? mid : (sc ?? ch.pos), cy: ch.horiz ? (sc ?? ch.pos) : mid, pw, ph, f: fs, item: it, horiz: ch.horiz,
      fixed: sc != null };
  }) }));
  const fixedAll: Pill[] = [...chainPills.flatMap(c => c.all.filter(p => p.fixed)), ...slopePills];
  const boxHit = (x: number, y: number, w: number, h: number, q: Pill) => Math.abs(x - q.cx) < (w + q.pw) / 2 + 2 && Math.abs(y - q.cy) < (h + q.ph) / 2 + 2;
  const pills: Pill[] = chainPills.flatMap(({ ch, all }) => {
    const base = all.filter(p => !p.fixed).sort((a, b) => (ch.horiz ? a.cx - b.cx : a.cy - b.cy));
    // Dar kapakta ölçü, boşluk kutucuklarından kaçmak için 5 şeride kadar çıkar.
    const lanes: Array<Array<{ start: number; end: number }>> = [[], [], [], [], []];
    const spanOf = (p: Pill) => {
      const c = ch.horiz ? p.cx : p.cy, half = (ch.horiz ? p.pw : p.ph) / 2 + 1;
      return { start: c - half, end: c + half + (p.item.onLock ? LOCK_EXT : 0) };
    };
    const fits = (lane: number, { start, end }: { start: number; end: number }) => lanes[lane].every(q => end <= q.start || start >= q.end);
    const laneStep = Math.max(...base.map(p => (ch.horiz ? p.ph : p.pw)), 0) + PILL_LANE_GAP;
    const clear2D = (p: Pill, lane: number) => {
      const x = ch.horiz ? p.cx : p.cx - lane * laneStep, y = ch.horiz ? p.cy - lane * laneStep : p.cy;
      if (fixedAll.some(q => boxHit(x, y, p.pw, p.ph, q))) return false;
      if (!p.item.onLock) return true;
      const lx = ch.horiz ? x + p.pw / 2 + LOCK_OFF : x, ly = ch.horiz ? y : y + p.ph / 2 + LOCK_OFF;
      return !fixedAll.some(q => boxHit(lx, ly, 2 * LOCK_R, 2 * LOCK_R, q));
    };
    const place = (p: Pill, lane: number) => {
      lanes[lane].push(spanOf(p));
      if (lane > 0) { if (ch.horiz) p.cy -= lane * laneStep; else p.cx -= lane * laneStep; }
    };
    for (const p of base.filter(x => x.item.kind === 'size')) {
      const sp = spanOf(p);
      // Hiçbir şerit uymazsa 0. şerit: ölçü hep çizilir.
      place(p, [0, 1, 2, 3, 4].find(l => fits(l, sp) && clear2D(p, l)) ?? (fits(0, sp) ? 0 : fits(1, sp) ? 1 : 0));
    }
    for (const p of base.filter(x => x.item.kind === 'gap')) { const sp = spanOf(p); place(p, [0, 1, 2].find(l => fits(l, sp)) ?? 2); }
    return [...base, ...all.filter(p => p.fixed)];
  });
  pills.push(...slopePills);
  const locks: Pt[] = [];
  const clearOf = (x: number, y: number, self: Pill) =>
    x >= LOCK_R + 1 && x <= W - LOCK_R - 1 && y >= LOCK_R + 1 && y <= H - LOCK_R - 1 &&
    pills.every(q => q === self || Math.abs(x - q.cx) >= q.pw / 2 + LOCK_R + 2 || Math.abs(y - q.cy) >= q.ph / 2 + LOCK_R + 2) &&
    locks.every(l => Math.hypot(l.x - x, l.y - y) >= 2 * LOCK_R + 3);
  for (const p of pills) {
    if (!p.item.onLock) continue;
    const d = (p.horiz ? p.pw : p.ph) / 2 + LOCK_OFF, e = (p.horiz ? p.ph : p.pw) / 2 + LOCK_OFF;
    const cand = p.horiz ? [{ x: p.cx + d, y: p.cy }, { x: p.cx - d, y: p.cy }, { x: p.cx, y: p.cy + e }, { x: p.cx, y: p.cy - e }]
      : [{ x: p.cx, y: p.cy + d }, { x: p.cx, y: p.cy - d }, { x: p.cx + e, y: p.cy }, { x: p.cx - e, y: p.cy }];
    p.lock = cand.find(c => clearOf(c.x, c.y, p)) ?? cand[0];
    locks.push(p.lock);
  }
  return pills;
}
/** Bant rozeti yerleşimi: rozet pill / kilide çarpıyorsa bant boyunca (dönüşümlü) kaydırılır, bandın içinde kalır. Parça etiket bloğu
 *  (no · ölçü · tür) da engel: "Split here" gibi rozetler etiketin üstüne binmesin. `obstacles` dışarıdan büyütülebilir. */
export function chipPlacer(pills: Pill[], members: Box4[], v: SchemView, fsT: number) {
  const obstacles = pills.flatMap(p => {
    const o = [{ x: p.cx, y: p.cy, r: Math.max(p.pw, p.ph) / 2 }];
    if (p.lock) o.push({ ...p.lock, r: LOCK_R });
    return o;
  });
  for (const m of members) obstacles.push({ x: (v.sx(m.u0) + v.sx(m.u1)) / 2, y: (v.sy(m.v0) + v.sy(m.v1)) / 2, r: fsT * 2.6 });
  const spot = ({ cx, cy, ux, uy, half }: ChipAxis, cw: number): Pt => {
    const r = cw / 2 + 2, step = cw / 2 + 6;
    const free = (x: number, y: number) => obstacles.every(o => Math.hypot(o.x - x, o.y - y) >= o.r + r);
    for (let k = 0; k <= 12; k++) {
      const d = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * step;
      if (Math.abs(d) > Math.max(0, half - cw / 2)) continue;
      const x = cx + ux * d, y = cy + uy * d;
      if (free(x, y)) return { x, y };
    }
    return { x: cx, y: cy };
  };
  return { obstacles, spot };
}

/* ───────────── DÜZENLEME ───────────── */

/** Şema değer düzenleme oturumu: kutu grup / seçim değişince kapanır — ağaç değişince KAPANMAMALI (canlı önizleme her tuşta yazar). */
export function useSchemEdit(
  onBegin: (() => unknown) | undefined, onCancel: ((snap: unknown) => void) | undefined, groupId: string, hasSel: boolean, selKey: string,
) {
  const ed = useEditSession<SchemEdit>(onBegin, onCancel);
  const { setEditing } = ed;
  useEffect(() => { setEditing(null); }, [groupId, hasSel, selKey, setEditing]);
  return ed;
}
type SchemEditSession = ReturnType<typeof useSchemEdit>;
/** Değer kutusu: her tuşta canlı önizleme; Enter / blur onaylar (geçersiz → önizleme geri alınır), Esc iptal eder. */
export function ChainEditInput({ ed, find }: { ed: SchemEditSession; find: (key: string) => EditTarget | undefined }) {
  const { editing, setEditing } = ed;
  const at = editing ? find(editing.key) : undefined;
  if (!editing || !at) return null;
  const valid = (raw: string) => {
    const v = parseNum(raw), p = find(editing.key);
    return isNaN(v) || !p || v < p.item.min ? null : { v, item: p.item };
  };
  const commit = () => {
    if (ed.wasCancelled()) return;   // Esc sonrası blur: onay yok
    const ok = valid(editing.v);
    setEditing(null);
    if (ok) ok.item.commit(ok.v); else ed.revert();
  };
  return (
    <PillEditInput at={at} fs={at.f} value={editing.v} onCommit={commit} onCancel={ed.cancel}
      onChange={raw => { setEditing({ ...editing, v: raw }); const ok = valid(raw); ok?.item.preview?.(ok.v); }} />
  );
}

/* ───────────── SVG PARÇALARI ───────────── */

const NO_PTR: React.CSSProperties = { pointerEvents: 'none' };
const NUM_TXT: React.CSSProperties = { fontVariantNumeric: 'tabular-nums', pointerEvents: 'none', userSelect: 'none' };
const hatch = (gid: string, warm: boolean) => `url(#${gid}-hatch${warm ? '-on' : ''})`;
const HatchDef = ({ id, stroke, w }: { id: string; stroke: string; w: number }) => (
  <pattern id={id} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <line x1="0" y1="0" x2="0" y2="4" stroke={stroke} strokeWidth={w} />
  </pattern>
);
/** Şema çerçevesi: önizleme kutusu, SVG (parça gradyanları, levha taramaları, alan zemini) ve SVG üstü katman (değer kutusu). */
export function SchemFrame({ wrapRef, width, height, gid, view, overlay, children }: {
  wrapRef: React.RefObject<HTMLDivElement>; width: number; height: number; gid: string; view: SchemView; overlay: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div ref={wrapRef} className={PREVIEW_FRAME} style={{ background: PREVIEW_BG, height }}>
      <style>{SCHEMATIC_CSS}</style>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', fontFamily: UI_FONT }}>
        <defs>
          <VGrad id={`${gid}-part`} from={SOFT.part0} to={SOFT.part1} />
          <VGrad id={`${gid}-part-on`} from={SOFT.on0} to={SOFT.on1} />
          <VGrad id={`${gid}-part-sel`} from={SOFT.sel0} to={SOFT.sel1} />
          <HatchDef id={`${gid}-hatch`} stroke="#bfb5a6" w={0.7} />
          <HatchDef id={`${gid}-hatch-on`} stroke="#e8925a" w={0.9} />
        </defs>
        <rect x={view.ox} y={view.oy} width={view.SW} height={view.SH} rx={3} fill={SOFT.area} stroke={SOFT.areaStroke} strokeWidth={0.8} />
        {children}
      </svg>
      {overlay}
    </div>
  );
}
/** Levha bandı (taralı); warm = sıcak ton (bini / bağlı derz). */
export const BandFill = ({ gid, pts, warm }: { gid: string; pts: Pt[]; warm: boolean }) => (
  <g style={NO_PTR}>
    <path d={ptsPath(pts)} fill={warm ? '#f9dcc4' : '#ddd4c6'} />
    <path d={ptsPath(pts)} fill={hatch(gid, warm)} />
    <path d={ptsPath(pts)} fill="none" stroke={warm ? '#e07b3c' : '#a39a8d'} strokeWidth={1} strokeLinejoin="round" />
  </g>
);
/** Bandın parçaların altında kalan kısımları (kesikli). */
export const HiddenParts = ({ gid, pts, warm, members, view }: { gid: string; pts: Pt[]; warm: boolean; members: Box4[]; view: SchemView }) => (
  <>{hiddenParts(pts, members, view).map((hp, k) => (
    <g key={k} style={NO_PTR}>
      <path d={ptsPath(hp)} fill={hatch(gid, warm)} opacity={0.4} />
      <path d={ptsPath(hp)} fill="none" stroke={warm ? '#e8925a' : '#9a9185'} strokeWidth={0.8} strokeDasharray="3 2" opacity={0.9} strokeLinejoin="round" />
    </g>
  ))}</>
);
/** Bant tık alanı + üzerine gelince koyu bant + rozet. `rect` yoksa tık alanı bandın kendi çokgeni. */
export function BandHit({ gid, pts, rect, warm, onClick, chip, title }: {
  gid: string; pts: Pt[]; rect?: Rect; warm: boolean; onClick?: (e: React.MouseEvent) => void; chip?: React.ReactNode; title: string;
}) {
  const d = ptsPath(pts);
  return (
    <g className={`yago-band pnl${chip ? ' on' : ''}`} style={{ cursor: onClick ? 'pointer' : 'default' }} onClick={onClick && (e => { stop(e); onClick(e); })}>
      {rect ? <rect x={rect.x - 2} y={rect.y - 2} width={rect.w + 4} height={rect.h + 4} fill="transparent" className="hit" />
        : <path d={d} fill="transparent" stroke="transparent" strokeWidth={4} strokeLinejoin="round" className="hit" />}
      <g className="hov">
        <path d={d} fill={warm ? '#f6c39c' : '#cbbca6'} fillOpacity={0.92} />
        <path d={d} fill={hatch(gid, warm)} />
        <path d={d} fill="none" stroke={warm ? '#c2410c' : '#6f6457'} strokeWidth={1.3} strokeLinejoin="round" />
      </g>
      {chip}
      <title>{title}</title>
    </g>
  );
}
/** Boşluk şeritleri (turuncu); açılı kesimde alana kırpılır. */
export const FocusStrips = ({ strips, clip }: { strips: Rect[]; clip: Pt[] | null }) => (
  <>{strips.map((r, i) => {
    const sp = [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];
    const cl = clip ? clipPolyToConvex(sp, clip) : sp;
    return cl.length >= 3
      ? <path key={`fs-${i}`} d={ptsPath(cl)} fill="#f97316" fillOpacity={0.28} stroke="#ea580c" strokeOpacity={0.55} strokeWidth={0.6} style={NO_PTR} /> : null;
  })}</>
);
/** Seçili bölge çerçevesi (bölme kesikli); açılı kesimle küçülmüş bölgede gerçek şekli (`shape`, mm). */
export function SelOutline({ n, shape, view }: { n: Box4 & { kind: string }; shape: Pt[] | null; view: SchemView }) {
  const split = n.kind === 'split';
  const line = { fill: '#ea580c', fillOpacity: split ? 0.05 : 0.0, stroke: '#ea580c', strokeWidth: 1.2, strokeDasharray: split ? '5 3' : undefined };
  if (shape && Math.abs(polyArea(shape)) < (n.u1 - n.u0) * (n.v1 - n.v0) - 1) {
    return <g style={NO_PTR}><path d={ptsPath(shape.map(view.toPx))} strokeLinejoin="round" {...line} /></g>;
  }
  const b = view.box(n), pad = split ? 2.5 : 0.5;
  return <g style={NO_PTR}><rect x={b.x0 - pad} y={b.y0 - pad} width={b.x1 - b.x0 + 2 * pad} height={b.y1 - b.y0 + 2 * pad} rx={3} {...line} /></g>;
}
/** Parça ipucu: başlık · W × H mm … — tık açıklaması · son. */
export const memberTip = (head: string, m: Box4 & { poly?: Pt[] }, depth: number, tail: string) =>
  `${head} · ${Math.round(m.u1 - m.u0)} × ${Math.round(m.v1 - m.v0)} mm${m.poly ? ' · angled (cut by rotated reference)' : ''}`
  + ` — click: select the area, click again to go one level deeper (${depth} level${depth === 1 ? '' : 's'})`
  + ` · Shift/Ctrl+click: add another region · ${tail}`;
/** Parça (kapak / arkalık parçası): gradyanlı kutu ya da açılı çokgen + no · W×H · tür yazısı. Zincir pill'i yazı alanına biniyorsa
 *  W×H gizlenir (zincir zaten söyler). `extra` = kutunun üstüne çizilen işaret (kapak açılım çizgisi). */
export function MemberCell({ m, view, gid, on, inSel, lbl, tip, caption, fsT, pills, onPick, extra }: {
  m: Box4 & { poly?: Pt[] }; view: SchemView; gid: string; on: boolean; inSel: boolean; lbl: string; tip: string; caption: string | null; fsT: number;
  pills: Pill[]; onPick: (additive: boolean) => void; extra?: (b: PxBox, pts: Pt[] | null) => React.ReactNode;
}) {
  const b = view.box(m, PART_INSET), { x0, y0, x1, y1 } = b, w = x1 - x0, h = y1 - y0;
  const pts = m.poly ? m.poly.map(view.toPx) : null;
  const fill = `url(#${gid}-part${on ? '-on' : inSel ? '-sel' : ''})`, stroke = on ? SOFT.onStroke : inSel ? SOFT.selStroke : SOFT.partStroke;
  const wMm = Math.round(m.u1 - m.u0), hMm = Math.round(m.v1 - m.v0);
  const cx = pts ? pts.reduce((a, q) => a + q.x, 0) / pts.length : (x0 + x1) / 2;
  const cy = pts ? pts.reduce((a, q) => a + q.y, 0) / pts.length : (y0 + y1) / 2;
  const fsz = fsT * 0.86, lh = fsT * 1.18;
  const capW = `${wMm} × ${hMm}`.length * fsz * 0.6 + 6, capH = fsz * 1.2;
  const capHit = pills.some(pp => Math.abs(pp.cx - cx) < (pp.pw + capW) / 2 && Math.abs(pp.cy - cy) < (pp.ph + capH) / 2 + lh);
  const showSize = w > 58 && h > 34 && !capHit, showCap = !!caption && showSize && h > 50;
  const lines = 1 + (showSize ? 1 : 0) + (showCap ? 1 : 0);
  const ty0 = capHit ? cy - lh : cy - ((lines - 1) * lh) / 2;
  return (
    <g style={{ cursor: 'pointer' }} onClick={e => { stop(e); onPick(isAdditive(e)); }}>
      {pts ? (
        <polygon points={pts.map(q => `${q.x},${q.y}`).join(' ')} fill={fill} stroke={stroke} strokeWidth={on ? 1.2 : 0.9} strokeLinejoin="round">
          <title>{tip}</title>
        </polygon>
      ) : (
        <rect x={x0} y={y0} width={Math.max(1, w)} height={Math.max(1, h)} rx={2.5} fill={fill} stroke={stroke} strokeWidth={on ? 1.2 : 0.8}
          style={{ filter: SOFT.shadow }}>
          <title>{tip}</title>
        </rect>
      )}
      {!pts && w > 6 && h > 6 && (
        <rect x={x0 + 1} y={y0 + 1} width={Math.max(0, w - 2)} height={Math.max(0, h - 2)} rx={1.5} fill="none" stroke="#ffffff" strokeOpacity={0.55}
          strokeWidth={0.8} style={NO_PTR} />
      )}
      {extra?.(b, pts)}
      <text x={cx} y={ty0 + fsT * 0.36} textAnchor="middle" fontSize={fsT} fontWeight={on ? 700 : 650} fill={on ? '#ea580c' : '#8f877c'} fontFamily={UI_FONT}
        style={NUM_TXT}>{lbl}</text>
      {showSize && (
        <text x={cx} y={ty0 + lh + fsz * 0.36} textAnchor="middle" fontSize={fsz} fontWeight={500} fill={on ? '#c2410c' : '#a39b90'} fontFamily={UI_FONT}
          style={NUM_TXT}>{wMm} × {hMm}</text>
      )}
      {showCap && (
        <text x={cx} y={ty0 + 2 * lh + fsz * 0.36} textAnchor="middle" fontSize={fsz * 0.92} fontWeight={600} fill="#b5ada3" letterSpacing="0.06em"
          fontFamily={UI_FONT} style={{ textTransform: 'uppercase', pointerEvents: 'none', userSelect: 'none' }}>{caption!.toUpperCase()}</text>
      )}
    </g>
  );
}
/** Zincir pill'leri: boşluk (turuncu, eğik kenarda döndürülmüş), pasif ölçü (kalanı toplar), ölçü + kilit rozeti. Düzenlenebilir ölçü =
 *  kilitlenebilir ya da canlı önizlemeli (kanat ölçüsü); alanın tamamı sınırlardan gelir (`bounds`). */
export function ChainPills({ pills, ed, bounds }: { pills: Pill[]; ed: SchemEditSession; bounds: string }) {
  const edit = (p: Pill) => (e: React.MouseEvent) => { stop(e); ed.begin({ key: p.key, v: p.item.txt }); };
  return (
    <>{pills.map(p => {
      const { item: it, f } = p;
      const hide = ed.editing?.key === p.key;
      if (it.kind === 'gap') {
        const gp = <DimPill cx={p.cx} cy={p.cy} txt={it.txt} fs={f} fill="#fff7ed" stroke="#f97316" strokeWidth={1} color="#c2410c" hideText={hide}
          title={it.title} onClick={edit(p)} />;
        return p.deg ? <g key={p.key} transform={`rotate(${p.deg.toFixed(1)} ${p.cx} ${p.cy})`}>{gp}</g> : <g key={p.key}>{gp}</g>;
      }
      if (it.passive) {
        return (
          <g key={p.key} className="yago-gap passive" style={{ cursor: 'not-allowed' }}><PassivePill cx={p.cx} cy={p.cy} txt={it.txt} fs={f} title={it.title} /></g>
        );
      }
      const locked = !!it.locked, edited = !locked && !!it.edited, editable = !!(it.onLock || it.preview);
      return (
        <g key={p.key} className={`yago-gap${locked ? ' locked' : ''}`}>
          <DimPill cx={p.cx} cy={p.cy} txt={it.txt} fs={f} fill={locked || edited ? '#fff7ed' : '#ffffff'} stroke={edited ? '#fbbf24' : '#f97316'}
            strokeWidth={locked ? 1.2 : 1} color={locked ? '#c2410c' : edited ? '#9a3412' : '#1c1917'} hideText={hide} onClick={editable ? edit(p) : undefined}
            title={!editable ? `${it.title} — set by the ${bounds} bounds` : edited ? `${it.title} (${it.lockTitle ? 'held' : 'entered'} value)` : it.title} />
          {it.onLock && p.lock && (
            <LockBadge cx={p.lock.x} cy={p.lock.y} locked={locked} edited={edited} onClick={it.onLock} title={it.lockTitle} holdIcon={!!it.lockTitle} />
          )}
        </g>
      );
    })}</>
  );
}
