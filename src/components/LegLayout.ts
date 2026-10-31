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

/** KURALLAR → gövde-yerel (x, z) ayak merkezleri. `footprint` gövde-yerel çokgen (x, z); `facing` ön yön. */
export function resolveLegRules(rules: LegRule[], footprint: Pt[], facing: Facing, R: number): Array<{ x: number; z: number }> {
  if (footprint.length < 3) return [];
  const poly = footprint.map(p => toFacing({ x: p.x, y: p.y }, facing));
  return rules.map(r => { const q = fromFacing(resolveLegRule(r, poly, R), facing); return { x: q.x, z: q.y }; });
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
