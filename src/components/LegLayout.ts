/* AYAK DÜZENİ — ayak ayak parametrik yerleşim (Goker, Eki 2026 — "ayak kasedinin tek tek ayak ayak nereye yerleşeceğini parametrik
   olarak belirlemem gerekiyor: hacmin ön tarafına bakan kısmını referans al, önden şu kadar geride, yandan şu kadar mesafede; ya da
   hacmin tam ortasına; karmaşık şekillerde bile uyum sağlamalı").

   KURAL (LegRule): her ayak iki eksende bir ÇAPA + mm ÖTELEME taşır.
     ax: left | center | right   dx: kenardan içeri (center: ortadan, + sağa)
     az: front | center | rear   dz: kenardan içeri (center: ortadan, + öne)
   Kurallar hacmin ÖN yönüne göre okunur (PlinthSet.facing): "önden bakan" çerçeve — u sağa, v öne artar (ön = max v).

   ÇÖZÜM (resolveLegRules): ayak izi bir ÇOKGENDİR (dikdörtgen olmak zorunda değil — L gövde, pahlı köşe …). Çapa önce çokgenin
   toplam kapsamına göre alınır, sonra o çizgideki GERÇEK kenarlara göre iki geçişte düzeltilir: u'daki dikey açıklıktan v (ön/arka
   kenar orada neredeyse), v'deki yatay açıklıktan u (sol/sağ kenar orada neredeyse). Çukur şekillerde çizgi birden çok aralık kesebilir;
   mevcut noktaya en yakın aralık alınır. Son olarak ayak (yarıçap R) çokgenin içinde kalacak biçimde kıstırılır.
   YÜZ / KENAR ROLLERİ + OTOMATİK KÖŞE DÜZENİ (Goker, Eki 2026 — "ayak da raf ve dikme gibi hacmin şeklini alsın; L ya da karmaşık
   küplerde ayağın önünü / yanını / arkasını belirleyeyim; otomatik olsun; gerekirse yüzlere rol vereyim, roller parametrede olsun"):
   rol = dış normalin ön yöne göre baskın bileşeni (roleOfHorizontal / roleOfNormal); iz çokgeninin kenarları rol alır (edgeRoles — gövde
   yüzü eşlemesi PlinthService'ten gelir); autoLegPoints her köşeye rolüne göre ötelenmiş kenarların kesişiminde ayak koyar.
   Bu dosya store'a bağlı değildir (saf hesap); PlinthService / Accessories / PanelEditor kullanır. */
import type { AxisDir } from './Geometry';

export type LegAnchorX = 'left' | 'center' | 'right';
export type LegAnchorZ = 'front' | 'center' | 'rear';
export interface LegRule { ax: LegAnchorX; dx: number; az: LegAnchorZ; dz: number }
export type Pt = { x: number; y: number };
export type Facing = AxisDir;

export const LEG_ANCHOR_X: LegAnchorX[] = ['left', 'center', 'right'];
export const LEG_ANCHOR_Z: LegAnchorZ[] = ['front', 'center', 'rear'];
export const LEG_ANCHOR_LABEL: Record<LegAnchorX | LegAnchorZ, string> = { left: 'Left', center: 'Centre', right: 'Right', front: 'Front', rear: 'Rear' };

const r1 = (v: number) => Math.round(v * 10) / 10;
export const sameRule = (a: LegRule, b: LegRule) => a.ax === b.ax && a.az === b.az && Math.abs(a.dx - b.dx) < 0.05 && Math.abs(a.dz - b.dz) < 0.05;

/** STANDART DÜZEN (eski count / side / front / rear): 4 köşe · 5 = + orta · 6 = + ön/arka orta. Kurallar sonra ayak ayak düzenlenebilir. */
export function standardLegRules(count: 4 | 5 | 6, side: number, front: number, rear: number): LegRule[] {
  const rules: LegRule[] = [
    { ax: 'left', dx: side, az: 'front', dz: front }, { ax: 'right', dx: side, az: 'front', dz: front },
    { ax: 'left', dx: side, az: 'rear', dz: rear }, { ax: 'right', dx: side, az: 'rear', dz: rear },
  ];
  if (count === 5) rules.push({ ax: 'center', dx: 0, az: 'center', dz: 0 });
  if (count === 6) rules.push({ ax: 'center', dx: 0, az: 'front', dz: front }, { ax: 'center', dx: 0, az: 'rear', dz: rear });
  return rules;
}
/** Kurallar standart düzene denk mi (4/5/6 + ortak side/front/rear)? Denkse parametreleri döner (basit kart için). */
export function standardOf(rules: LegRule[]): { count: 4 | 5 | 6; side: number; front: number; rear: number } | null {
  if (rules.length < 4 || rules.length > 6) return null;
  const f = rules.find(r => r.ax === 'left' && r.az === 'front'), b = rules.find(r => r.ax === 'left' && r.az === 'rear');
  if (!f || !b) return null;
  const guess = standardLegRules(rules.length as 4 | 5 | 6, f.dx, f.dz, b.dz);
  return guess.every((g, i) => rules[i] && sameRule(g, rules[i])) ? { count: rules.length as 4 | 5 | 6, side: f.dx, front: f.dz, rear: b.dz } : null;
}

/* ───────── Ön çerçeve: gövde-yerel (x, z) ↔ önden bakış (u sağa, v öne) ───────── */
/** Gövde-yerel (x,z) → ön çerçeve (u,v). Önde durup gövdeye bakan kişinin sağı +u, gövdenin önü +v. */
export function toFacing(p: Pt, facing: Facing): Pt {
  switch (facing) {
    case 'z-': return { x: -p.x, y: -p.y };
    case 'x+': return { x: -p.y, y: p.x };
    case 'x-': return { x: p.y, y: -p.x };
    default: return { x: p.x, y: p.y };   // z+
  }
}
export function fromFacing(q: Pt, facing: Facing): Pt {
  switch (facing) {
    case 'z-': return { x: -q.x, y: -q.y };
    case 'x+': return { x: q.y, y: -q.x };
    case 'x-': return { x: -q.y, y: q.x };
    default: return { x: q.x, y: q.y };
  }
}

/* ───────── Çokgen yardımcıları ───────── */
export const rectPoly = (x0: number, y0: number, x1: number, y1: number): Pt[] => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
export function polyExtent(p: Pt[]): { x0: number; x1: number; y0: number; y1: number } {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const q of p) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
  return { x0, x1, y0, y1 };
}
export function pointInPoly(pt: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
/** Dikey çizgi x = c ile çokgenin kesişim aralıkları (y; sıralı, çiftler). */
function spansAtX(poly: Pt[], c: number): Array<[number, number]> {
  const ys: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if ((a.x <= c && b.x > c) || (b.x <= c && a.x > c)) ys.push(a.y + ((c - a.x) * (b.y - a.y)) / (b.x - a.x));
  }
  ys.sort((p, q) => p - q);
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < ys.length; i += 2) out.push([ys[i], ys[i + 1]]);
  return out;
}
const swap = (p: Pt[]): Pt[] => p.map(q => ({ x: q.y, y: q.x }));
/** Yatay çizgi y = c ile kesişim aralıkları (x). */
const spansAtY = (poly: Pt[], c: number) => spansAtX(swap(poly), c);
/** Aralıklardan mevcut değeri içeren, yoksa ona en yakın olanı. */
function pickSpan(spans: Array<[number, number]>, cur: number): [number, number] | null {
  if (!spans.length) return null;
  const hit = spans.find(([a, b]) => cur >= a - 1e-6 && cur <= b + 1e-6);
  if (hit) return hit;
  return spans.reduce((best, s) => (Math.min(Math.abs(s[0] - cur), Math.abs(s[1] - cur)) < Math.min(Math.abs(best[0] - cur), Math.abs(best[1] - cur)) ? s : best));
}
const along = (anchor: 'left' | 'center' | 'right' | 'front' | 'rear', lo: number, hi: number, d: number) =>
  anchor === 'left' || anchor === 'rear' ? lo + d : anchor === 'right' || anchor === 'front' ? hi - d : (lo + hi) / 2 + d;
const clampIn = (v: number, lo: number, hi: number, R: number) => {
  const a = lo + R, b = hi - R;
  return b < a ? (lo + hi) / 2 : Math.min(b, Math.max(a, v));
};

/** TEK KURAL → ön çerçevede nokta. `R` = ayak yarıçapı (iz içinde kalma payı). */
export function resolveLegRule(rule: LegRule, poly: Pt[], R: number): Pt {
  const e = polyExtent(poly);
  let u = along(rule.ax, e.x0, e.x1, rule.dx);
  let v = along(rule.az, e.y0, e.y1, rule.dz);
  for (let pass = 0; pass < 2; pass++) {
    const sv = pickSpan(spansAtX(poly, u), v);
    if (sv) v = along(rule.az, sv[0], sv[1], rule.dz);
    const su = pickSpan(spansAtY(poly, v), u);
    if (su) u = along(rule.ax, su[0], su[1], rule.dx);
  }
  // İz içinde kal: o çizgideki aralıklara R payıyla kıstır (kenara yakın / dışarı taşan kural).
  const sv = pickSpan(spansAtX(poly, u), v);
  if (sv) v = clampIn(v, sv[0], sv[1], R);
  const su = pickSpan(spansAtY(poly, v), u);
  if (su) u = clampIn(u, su[0], su[1], R);
  if (!pointInPoly({ x: u, y: v }, poly)) {
    // Son çare: kapsam dikdörtgenine kıstır (bozuk çokgen).
    u = clampIn(u, e.x0, e.x1, R); v = clampIn(v, e.y0, e.y1, R);
  }
  return { x: r1(u), y: r1(v) };
}

/** Noktayı iz çokgeninin içinde R payıyla tutar (o çizgideki aralığa kıstırma; Δ düzeltmesi dışarı taşınca). */
export function clampInsidePoly(q: Pt, poly: Pt[], R: number): Pt {
  let u = q.x, v = q.y;
  const sv = pickSpan(spansAtX(poly, u), v); if (sv) v = clampIn(v, sv[0], sv[1], R);
  const su = pickSpan(spansAtY(poly, v), u); if (su) u = clampIn(u, su[0], su[1], R);
  if (!pointInPoly({ x: u, y: v }, poly)) { const e = polyExtent(poly); u = clampIn(u, e.x0, e.x1, R); v = clampIn(v, e.y0, e.y1, R); }
  return { x: r1(u), y: r1(v) };
}

/** KURALLAR → gövde-yerel (x, z) ayak merkezleri. `footprint` gövde-yerel çokgen (x, z); `facing` ön yön. */
export function resolveLegRules(rules: LegRule[], footprint: Pt[], facing: Facing, R: number): Array<{ x: number; z: number }> {
  if (footprint.length < 3) return [];
  const poly = footprint.map(p => toFacing({ x: p.x, y: p.y }, facing));
  return rules.map(r => { const q = fromFacing(resolveLegRule(r, poly, R), facing); return { x: q.x, z: q.y }; });
}

/* ───────── YÜZ / KENAR ROLLERİ (Goker, Eki 2026 — "L ya da karmaşık küplerde bile ayağın önünü, yanını, arkasını belirleyeyim; akıllı,
   mümkünse otomatik; olmazsa referans kübün yüzlerine ön / arka / sağ / sol / üst / alt rolü vereyim, roller parametrede olsun").
   Rol = yüzün DIŞ normalinin ön yöne göre baskın bileşeni (üst/alt: |ny| baskın). Gövde yüzlerinin rolü PlinthService.bodyFaces'te
   okunur (parametre üstüne yazar); iz çokgeninin her kenarı gövde yüzünden rolünü alır, panel kesiğinden gelen kenar normalden. ───────── */
export type FaceRole = 'front' | 'rear' | 'left' | 'right' | 'top' | 'bottom';
export const FACE_ROLES: FaceRole[] = ['front', 'rear', 'left', 'right', 'top', 'bottom'];
export const FACE_ROLE_LABEL: Record<FaceRole, string> = { front: 'Front', rear: 'Rear', left: 'Left', right: 'Right', top: 'Top', bottom: 'Bottom' };
export const FACE_ROLE_SHORT: Record<FaceRole, string> = { front: 'F', rear: 'R', left: 'L', right: 'Rt', top: 'T', bottom: 'B' };
/** Ön yön vektörü (gövde-yerel x,z) ve sağ = up × front (önde durup gövdeye bakanın sağı). toFacing ile aynı çerçeve. */
export function facingVectors(facing: Facing): { front: Pt; right: Pt } {
  switch (facing) {
    case 'z-': return { front: { x: 0, y: -1 }, right: { x: -1, y: 0 } };
    case 'x+': return { front: { x: 1, y: 0 }, right: { x: 0, y: -1 } };
    case 'x-': return { front: { x: -1, y: 0 }, right: { x: 0, y: 1 } };
    default: return { front: { x: 0, y: 1 }, right: { x: 1, y: 0 } };
  }
}
/** Yatay DIŞ normal (gövde-yerel x,z) → rol; eşitlikte (45°) ön/arka kazanır. */
export function roleOfHorizontal(n: Pt, facing: Facing): FaceRole {
  const { front, right } = facingVectors(facing);
  const df = n.x * front.x + n.y * front.y, dr = n.x * right.x + n.y * right.y;
  return Math.abs(df) >= Math.abs(dr) - 1e-9 ? (df >= 0 ? 'front' : 'rear') : (dr > 0 ? 'right' : 'left');
}
/** 3B dış normal → rol: |ny| yatay bileşene baskınsa üst / alt. */
export function roleOfNormal(n: { x: number; y: number; z: number }, facing: Facing): FaceRole {
  if (Math.abs(n.y) >= Math.hypot(n.x, n.z)) return n.y > 0 ? 'top' : 'bottom';
  return roleOfHorizontal({ x: n.x, y: n.z }, facing);
}

/* ───────── Çokgen kenarları ───────── */
export const signedArea = (p: Pt[]): number => {
  let s = 0;
  for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a.x * b.y - b.x * a.y; }
  return s / 2;
};
export const polyCentroid = (p: Pt[]): Pt => {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[i], r = p[(i + 1) % p.length], w = q.x * r.y - r.x * q.y;
    a += w; cx += (q.x + r.x) * w; cy += (q.y + r.y) * w;
  }
  if (Math.abs(a) < 1e-9) { const e = polyExtent(p); return { x: (e.x0 + e.x1) / 2, y: (e.y0 + e.y1) / 2 }; }
  return { x: cx / (3 * a), y: cy / (3 * a) };
};
/** Ardışık yinelenen ve doğrudaş (kenar ortası) noktalar düşer; kapanış yinelemesi kalkar. */
export function cleanPoly(poly: Pt[], tol = 1e-3): Pt[] {
  const out: Pt[] = [];
  for (const q of poly) { const l = out[out.length - 1]; if (!l || Math.hypot(l.x - q.x, l.y - q.y) > tol) out.push({ x: q.x, y: q.y }); }
  while (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= tol) out.pop();
  for (let pass = 0; pass < 2 && out.length > 3; pass++) {
    for (let i = out.length - 1; i >= 0 && out.length > 3; i--) {
      const p = out[(i - 1 + out.length) % out.length], q = out[i], r = out[(i + 1) % out.length];
      const cr = (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x);
      const l1 = Math.hypot(q.x - p.x, q.y - p.y), l2 = Math.hypot(r.x - q.x, r.y - q.y);
      // |cr| = l1·l2·sinθ → sinθ ≈ 0 ve aynı yön → kenar ortası
      if (Math.abs(cr) <= 1e-6 * Math.max(1, l1 * l2) && (q.x - p.x) * (r.x - q.x) + (q.y - p.y) * (r.y - q.y) > 0) out.splice(i, 1);
    }
  }
  return out;
}
export interface PolyEdge { i: number; a: Pt; b: Pt; mid: Pt; d: Pt; n: Pt; len: number }
/** Kenarlar (a→b), birim yön d ve birim DIŞ normal n (yönelim imzalı alandan). */
export function polygonEdges(poly: Pt[]): PolyEdge[] {
  const ccw = signedArea(poly) > 0;
  const out: PolyEdge[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y); if (len < 1e-6) continue;
    const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    const n = ccw ? { x: d.y, y: -d.x } : { x: -d.y, y: d.x };
    out.push({ i, a, b, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, d, n, len });
  }
  return out;
}
export interface EdgeRole extends PolyEdge { role: FaceRole; source: 'body' | 'auto' }
/** Kenar rolleri: `resolve` (gövde yüzü eşlemesi, parametre rolü dahil) bir rol verirse o; yoksa normalden otomatik. */
export function edgeRoles(poly: Pt[], facing: Facing, resolve?: (mid: Pt, n: Pt) => FaceRole | null): EdgeRole[] {
  return polygonEdges(poly).map(e => {
    const r = resolve ? resolve(e.mid, e.n) : null;
    return { ...e, role: r ?? roleOfHorizontal(e.n, facing), source: r ? 'body' : 'auto' };
  });
}
/** Noktanın [a,b] parçasına uzaklığı. */
const segDist = (q: Pt, a: Pt, b: Pt): number => {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(q.x - (a.x + dx * t), q.y - (a.y + dy * t));
};

/* ───────── OTOMATİK KÖŞE DÜZENİ (Goker: "akıllıca, mümkünse otomatik") ─────────
   Her DIŞBÜKEY köşeye bir ayak: köşeyi kuran iki kenar kendi rolünün mesafesi kadar içeri ötelenir (ön → front, arka → rear, yan → side),
   öteli çizgilerin kesişimi ayak merkezidir — kenar açısı ne olursa olsun (pahlı köşe, L, U). İçbükey köşelere de (`inner`, varsayılan açık)
   aynı yolla ayak gelir (L gövdenin iç köşesi). 5 = + merkez (iz çokgeninde kalır), 6 = + her ön / arka kenarın iki ayağı arasına orta ayak.
   Dikdörtgende sonuç eski 4 / 5 / 6 düzeniyle (legSpots) birebir aynıdır. */
export interface AutoLegCfg { count: 4 | 5 | 6; side: number; front: number; rear: number; inner?: boolean }
export const offsetForRole = (r: FaceRole, cfg: Pick<AutoLegCfg, 'side' | 'front' | 'rear'>): number =>
  r === 'front' ? cfg.front : r === 'rear' ? cfg.rear : cfg.side;
export function autoLegPoints(poly: Pt[], edges: EdgeRole[], cfg: AutoLegCfg, facing: Facing, R: number): Pt[] {
  const n = edges.length; if (n < 3) return [];
  const ccw = signedArea(poly) > 0;
  const inner = cfg.inner !== false;
  const lineC = (e: EdgeRole) => e.n.x * e.a.x + e.n.y * e.a.y - offsetForRole(e.role, cfg);   // n·q = c (içeri öteli)
  const settle = (q: Pt): Pt | null => {
    // Ayak (yarıçap R) hiçbir kenara R'den yakın olmasın: yakın kenardan içeri itilir; sonunda çokgenin içinde kalmalı.
    let p = { x: q.x, y: q.y };
    for (let pass = 0; pass < 3; pass++) {
      for (const e of edges) {
        const dist = segDist(p, e.a, e.b);
        if (dist < R - 1e-6) { const push = R - dist; p = { x: p.x - e.n.x * push, y: p.y - e.n.y * push }; }
      }
    }
    return pointInPoly(p, poly) ? { x: r1(p.x), y: r1(p.y) } : null;
  };
  const pts: Pt[] = [];
  const add = (q: Pt | null) => { if (q && !pts.some(p => Math.hypot(p.x - q.x, p.y - q.y) < 1)) pts.push(q); };
  for (let i = 0; i < n; i++) {
    const e0 = edges[(i - 1 + n) % n], e1 = edges[i];
    const cross = e0.d.x * e1.d.y - e0.d.y * e1.d.x;
    if (Math.abs(cross) < 1e-6) continue;                       // doğrudaş: köşe değil
    const convex = (cross > 0) === ccw;
    if (!convex && !inner) continue;
    const c0 = lineC(e0), c1 = lineC(e1), det = e0.n.x * e1.n.y - e0.n.y * e1.n.x;
    if (Math.abs(det) < 1e-9) continue;
    add(settle({ x: (c0 * e1.n.y - c1 * e0.n.y) / det, y: (e0.n.x * c1 - e1.n.x * c0) / det }));
  }
  if (cfg.count === 5) {
    const q = fromFacing(resolveLegRule({ ax: 'center', dx: 0, az: 'center', dz: 0 }, poly.map(p => toFacing(p, facing)), R), facing);
    add(settle(q));
  }
  if (cfg.count === 6) {
    for (const e of edges) {
      if (e.role !== 'front' && e.role !== 'rear') continue;
      const c = lineC(e);
      const on = pts.filter(p => Math.abs(e.n.x * p.x + e.n.y * p.y - c) < 0.5).sort((p, q) => (p.x * e.d.x + p.y * e.d.y) - (q.x * e.d.x + q.y * e.d.y));
      for (let k = 0; k + 1 < on.length; k++) {
        const a = on[k], b = on[k + 1];
        if (Math.hypot(b.x - a.x, b.y - a.y) > 4 * R) add(settle({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }));
      }
    }
  }
  // Numaralama kararlı: önden arkaya (v azalan), soldan sağa (u artan).
  return pts.map(p => ({ p, f: toFacing(p, facing) })).sort((a, b) => (b.f.y - a.f.y) || (a.f.x - b.f.x)).map(x => x.p);
}

/** Çokgeni eksen-hizalı dikdörtgenle kırpar (Sutherland–Hodgman, 4 kenar). */
export function clipPolyToRect(poly: Pt[], x0: number, y0: number, x1: number, y1: number): Pt[] {
  const clip = (p: Pt[], keep: (q: Pt) => number): Pt[] => {
    const out: Pt[] = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length], fa = keep(a), fb = keep(b);
      if (fa >= 0) out.push(a);
      if ((fa < 0 && fb > 0) || (fa > 0 && fb < 0)) { const t = fa / (fa - fb); out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); }
    }
    return out;
  };
  let p = poly;
  p = clip(p, q => q.x - x0); p = clip(p, q => x1 - q.x); p = clip(p, q => q.y - y0); p = clip(p, q => y1 - q.y);
  return p;
}
