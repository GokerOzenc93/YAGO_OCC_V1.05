import * as THREE from 'three';
import { type CavityBox, type GapSpec, type Shape, type VirtualFace, panelOfVf, useAppStore } from '../store';
import { type Vec3, genId, round1 } from './Geometry';
import { type Point2D, clipHalfPlane, clipPolyToConvex, frontHullOf, largestFaceNormal, panelHasRotation, polyArea } from './FaceRegion';
// DİKKAT: PanelGroupService ↔ SplitShared döngüsel içe aktarım; PGS bağları yalnız fonksiyon gövdesinde okunur.
import { gapMode, panelLocalBox, rescaleGaps } from './PanelGroupService';

// KAPAK / ARKALIK / RAF-DİKME ORTAK YARDIMCILARI: yalnız saf geometri, bölme ağacı gezintisi, ölçü dağıtımı ve üye VF bakımı.
// İş kuralları (sınır seçimi, bini, kanal, bağ yönü) servislerde kalır. Yardımcılar fonksiyon bildirimi → döngüsel içe aktarmada TDZ yok.

export type Pt2 = Point2D;
export type Axis3 = 0 | 1 | 2;
export type EdgeKey = 'uMin' | 'uMax' | 'vMin' | 'vMax';
export type SlabPlacement = 'inner' | 'outer';
export type JointAlign = 'min' | 'center' | 'max';
export interface PlaneRect { u0: number; u1: number; v0: number; v1: number }
export const EDGE_KEYS: EdgeKey[] = ['uMin', 'uMax', 'vMin', 'vMax'];
const TOL = 0.5;

// DÜZLEM / ÇOKGEN
/** Levha düzlemi: u = yatay (sütun), v = düşey (satır). */
export function planeAxes(axis: Axis3): { u: Axis3; v: Axis3 } {
  if (axis === 2) return { u: 0, v: 1 };
  if (axis === 0) return { u: 2, v: 1 };
  return { u: 0, v: 2 };
}
export function rectKey(r: PlaneRect): string { return [r.u0, r.u1, r.v0, r.v1].map(n => Math.round(n)).join('|'); }
export function rectPoly(r: PlaneRect): Pt2[] { return [{ x: r.u0, y: r.v0 }, { x: r.u1, y: r.v0 }, { x: r.u1, y: r.v1 }, { x: r.u0, y: r.v1 }]; }
/** Çokgenin dikdörtgen kutusu. */
export function polyRect(poly: Pt2[], front: number): PlaneRect & { front: number } {
  const xs = poly.map(q => q.x), ys = poly.map(q => q.y);
  return { u0: Math.min(...xs), u1: Math.max(...xs), v0: Math.min(...ys), v1: Math.max(...ys), front };
}
/** Kırpma çokgeni değiştirdi mi (köşe sayısı ya da 1e-6'dan büyük kayma). */
export function polyChanged(a: Pt2[], b: Pt2[]): boolean {
  return a.length !== b.length || a.some((q, i) => Math.abs(q.x - b[i].x) > 1e-6 || Math.abs(q.y - b[i].y) > 1e-6);
}
/** Işının kutuya girdiği yüz: eksen, ışının o eksende + yönde olup olmadığı ve giriş t'si; kamera kutunun içindeyse null. */
export function rayBoxEntry(o: Vec3, d: Vec3, b: CavityBox): { axis: Axis3; pos: boolean; t: number } | null {
  let best = -Infinity, axis: Axis3 = 0, pos = false;
  for (const a of [0, 1, 2] as const) {
    if (Math.abs(d[a]) < 1e-9) continue;
    const t = d[a] > 0 ? (b.min[a] - o[a]) / d[a] : (b.max[a] - o[a]) / d[a];
    if (t > best) { best = t; axis = a; pos = d[a] > 0; }
  }
  return best > 0 ? { axis, pos, t: best } : null;
}
/** Derz merkezi levha yüzlerinden (a0 < a1): 'center' → levha ortası, 'min' → max yüz + yarım derz, 'max' → min yüz − yarım derz. */
export function jointCenter(a0: number, a1: number, g: number, align: JointAlign): number {
  return align === 'center' ? (a0 + a1) / 2 : align === 'min' ? a1 + g / 2 : a0 - g / 2;
}
/** Derze (p0..p1) hizalı t kalınlıklı levhanın min yüzü. */
export function alignedMin(p0: number, p1: number, t: number, align: JointAlign): number {
  return align === 'min' ? p0 - t : align === 'max' ? p1 : (p0 + p1) / 2 - t / 2;
}

// SINIR PANELLERİ / AÇILI KESİCİLER
export interface BoundPanel { vfId: string; panelId: string; box: CavityBox; name: string }
/** Kabul edilen VF'lerin dönmemiş panelleri (gövde-yerel kutu). */
export function collectBoundPanels(parent: Shape, shapes: Shape[], vfs: VirtualFace[], accept: (vf: VirtualFace) => boolean): BoundPanel[] {
  const out: BoundPanel[] = [];
  for (const vf of vfs) {
    if (vf.shapeId !== parent.id || !accept(vf)) continue;
    const p = panelOfVf(vf.id, shapes);
    if (!p || panelHasRotation(p)) continue;
    const box = panelLocalBox(p, parent);
    if (!box) continue;
    out.push({ vfId: vf.id, panelId: p.id, box, name: vf.description || 'Panel' });
  }
  return out;
}

/** Dönmüş sınır paneli: büyük-yüz normali + o normaldeki [dMin,dMax] + kutu; pts = tekil köşeler (şema ön görünüşü). */
export interface SlabCut { vfId: string; name: string; n: Vec3; dMin: number; dMax: number; box: CavityBox; pts?: Vec3[] }
export function collectRotatedCuts(parent: Shape, shapes: Shape[], vfs: VirtualFace[], accept: (vf: VirtualFace) => boolean): SlabCut[] {
  const out: SlabCut[] = [];
  for (const vf of vfs) {
    if (vf.shapeId !== parent.id || !accept(vf)) continue;
    const p = panelOfVf(vf.id, shapes);
    if (!p || !panelHasRotation(p)) continue;
    const box = panelLocalBox(p, parent);
    const n = largestFaceNormal(p.geometry);
    const pos = p.geometry?.getAttribute?.('position') as THREE.BufferAttribute | undefined;
    if (!box || !n || !pos) continue;
    const off = [0, 1, 2].map(k => (p.position?.[k] ?? 0) - (parent.position?.[k] ?? 0));
    let dMin = Infinity, dMax = -Infinity;
    const pts: Vec3[] = [], seen = new Set<string>();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + off[0], y = pos.getY(i) + off[1], z = pos.getZ(i) + off[2];
      const d = x * n.x + y * n.y + z * n.z;
      if (d < dMin) dMin = d;
      if (d > dMax) dMax = d;
      const k = `${Math.round(x * 10)},${Math.round(y * 10)},${Math.round(z * 10)}`;
      if (!seen.has(k)) { seen.add(k); pts.push([x, y, z]); }
    }
    if (!(dMax - dMin > 0.5)) continue;
    out.push({ vfId: vf.id, name: vf.description || 'Panel', n: [n.x, n.y, n.z], dMin, dMax, box, pts });
  }
  return out;
}

/** Dönmüş kesicinin kestiği KENAR = kaldırılan yönün baskın ekseni (eğik üst → vMax, eğik dikme → uMin/uMax). */
export function cutEdgeOf(c: SlabCut, cu: number, cv: number, axis: Axis3, front: number): { edge: EdgeKey; keepBelow: boolean } | null {
  const { u, v } = planeAxes(axis);
  const A = c.n[u], B = c.n[v], Na = c.n[axis];
  if (Math.abs(A) < 1e-6 && Math.abs(B) < 1e-6) return null;   // levha düzlemine paralel: kesim anlamsız
  const keepBelow = A * cu + B * cv + Na * front < (c.dMin + c.dMax) / 2;
  const ru = keepBelow ? A : -A, rv = keepBelow ? B : -B;
  const edge: EdgeKey = Math.abs(ru) >= Math.abs(rv) ? (ru > 0 ? 'uMax' : 'uMin') : (rv > 0 ? 'vMax' : 'vMin');
  return { edge, keepBelow };
}
/** Dış levha kesicinin gerisindeyse onu örter (uzak yüze kadar). */
export function cutCoverFar(c: SlabCut, axis: Axis3, side: 1 | -1, placement: SlabPlacement, front: number): boolean {
  return placement === 'outer' && (side > 0 ? c.box.max[axis] <= front + TOL : c.box.min[axis] >= front - TOL);
}

// Şemada açılı sınır levhası: levha düzlemindeki kesit bir ŞERİT (dMin ≤ A·u + B·v + Na·front ≤ dMax), en az minT mm.
// covered → bini rozeti anlamlı.
export interface CutBand { cut: SlabCut; poly: Pt2[]; edge: EdgeKey | null; covered: boolean; dir: Pt2 }
type BandGroup = { axis: Axis3; side: 1 | -1; placement: SlabPlacement; anchor?: [number, number] };
export function cutBands(group: BandGroup, rect: PlaneRect & { front: number }, cuts: SlabCut[], area: Pt2[], minT: number): CutBand[] {
  const { u, v } = planeAxes(group.axis);
  const out: CutBand[] = [];
  for (const c of cuts) {
    const A = c.n[u], B = c.n[v], Na = c.n[group.axis];
    const len = Math.hypot(A, B);
    if (len < 1e-6) continue;
    let lo = c.dMin - Na * rect.front, hi = c.dMax - Na * rect.front;
    if (hi - lo < minT * len) { const m = (lo + hi) / 2; lo = m - minT * len / 2; hi = m + minT * len / 2; }
    let poly = clipHalfPlane(area, A, B, hi);
    if (poly.length >= 3) poly = clipHalfPlane(poly, -A, -B, -lo);
    // Şerit sonsuzdur: panelin gerçek ön görünüşüyle kırpılır, yoksa yan panelin üstüne taşar.
    if (poly.length >= 3 && c.pts && c.pts.length >= 3) {
      const hull = frontHullOf(c.pts, u, v);
      if (hull.length >= 3) poly = clipPolyToConvex(poly, hull);
    }
    if (poly.length < 3 || Math.abs(polyArea(poly)) < 1) continue;
    const cu = group.anchor ? group.anchor[0] : (rect.u0 + rect.u1) / 2, cv = group.anchor ? group.anchor[1] : (rect.v0 + rect.v1) / 2;
    const ce = cutEdgeOf(c, cu, cv, group.axis, rect.front);
    const covered = cutCoverFar(c, group.axis, group.side, group.placement, rect.front);
    out.push({ cut: c, poly, edge: ce?.edge ?? null, covered, dir: { x: -B / len, y: A / len } });
  }
  return out;
}

// KENAR BİLGİSİ
export type BoundRef = { vfId?: string; body?: boolean };
/** Kenar: iç / dış yüz (ax ekseninde) + panelin levha düzlemine bakan yüzü (gövde kenarında null). */
export type EdgeInfo = { ref: BoundRef; inner: number; outer: number; front: number | null };
export function boundEdgeInfo(
  ref: BoundRef, parent: Shape, shapes: Shape[], body: CavityBox, ax: Axis3, minSide: boolean, axis: Axis3, side: 1 | -1,
): EdgeInfo {
  if (ref.vfId) {
    const p = panelOfVf(ref.vfId, shapes);
    const box = p && (p.parameters as any)?.parentShapeId === parent.id ? panelLocalBox(p, parent) : null;
    if (box) {
      const inner = minSide ? box.max[ax] : box.min[ax], outer = minSide ? box.min[ax] : box.max[ax];
      return { ref, inner, outer, front: side > 0 ? box.max[axis] : box.min[axis] };
    }
  }
  const e = minSide ? body.min[ax] : body.max[ax];
  return { ref: { body: true }, inner: e, outer: e, front: null };
}
/** Levha düzlemi = kenar panellerinin EN GERİDEKİ yüzü (tek seçenek); panel yoksa gövde yüzü. */
export function depthOptions(e: EdgeInfo[], side: 1 | -1, bodyFront: number): Array<{ ref: BoundRef; front: number }> {
  let best: { ref: BoundRef; front: number } | null = null;
  for (const x of e) {
    if (x.front == null) continue;
    if (!best || side * (x.front - best.front) < 0) best = { ref: x.ref, front: x.front };
  }
  return [best ?? { ref: { body: true }, front: bodyFront }];
}
export function sameBounds(a: Record<EdgeKey, BoundRef>, b: Record<EdgeKey, BoundRef>): boolean {
  return EDGE_KEYS.every(k => (a[k]?.vfId ?? '') === (b[k]?.vfId ?? '') && !!a[k]?.body === !!b[k]?.body);
}

/** Üye VF geometrisi: `plane` düzleminde dikdörtgen ya da kırpılmış çokgen; normal = side (createPanelFromVirtualFace −normal yönünde uzar). */
export function slabVfGeometry(axis: Axis3, side: 1 | -1, plane: number, m: PlaneRect & { poly?: Pt2[] }): { normal: Vec3; vertices: Vec3[]; center: Vec3 } {
  const { u, v } = planeAxes(axis);
  const mk = (uu: number, vv: number): Vec3 => { const p: Vec3 = [0, 0, 0]; p[axis] = plane; p[u] = uu; p[v] = vv; return p; };
  const normal: Vec3 = [0, 0, 0]; normal[axis] = side;
  const vertices = (m.poly || rectPoly(m)).map(q => mk(q.x, q.y));
  const n = m.poly?.length ?? 0;
  const c = m.poly ? m.poly.reduce((a, q) => ({ x: a.x + q.x / n, y: a.y + q.y / n }), { x: 0, y: 0 }) : { x: (m.u0 + m.u1) / 2, y: (m.v0 + m.v1) / 2 };
  return { normal, vertices, center: mk(c.x, c.y) };
}

// BÖLME AĞACI (kapak / arkalık)
// leaf = parça; split = u (yan yana) / v (ÜSTTEN aşağı) eksende çocuklar (sizes + n−1 gaps); refs = levhaya bağlı derzler.
export interface SplitFields<C> {
  id: string; kind: 'split'; axis: 'u' | 'v'; sizes: GapSpec[]; gaps: number[]; children: C[];
  targetSize?: number; refs?: Record<number, { vfId: string }>;
}
export type TreeNode = { id: string; kind: 'leaf' } | SplitFields<TreeNode>;
type Box2 = PlaneRect;
export type SolvedBox = Box2 & { depth: number };
export type SolvedNode = ({ id: string; kind: 'leaf' } & SolvedBox) | (SplitFields<SolvedNode> & SolvedBox);
export type LeafOf<N> = Extract<N, { kind: 'leaf' }>;
export type SplitOf<N> = Extract<N, { kind: 'split' }>;
type RefOf<N> = N extends { kind: 'split'; refs?: Record<number, infer R extends { vfId: string }> } ? R : never;

export function treeLeaves<N extends TreeNode>(n: N): Array<LeafOf<N>> {
  return n.kind === 'leaf' ? [n as LeafOf<N>] : (n.children as N[]).flatMap(c => treeLeaves(c));
}
export function findNode<N extends TreeNode>(n: N, id: string): N | null {
  if (n.id === id) return n;
  if (n.kind === 'split') for (const c of n.children as N[]) { const h = findNode(c, id); if (h) return h; }
  return null;
}
export function findParent<N extends TreeNode>(n: N, id: string): SplitOf<N> | null {
  if (n.kind !== 'split') return null;
  if (n.children.some(c => c.id === id)) return n as SplitOf<N>;
  for (const c of n.children as N[]) { const h = findParent(c, id); if (h) return h; }
  return null;
}
export function replaceNode<N extends TreeNode>(n: N, id: string, repl: (old: N) => N): N {
  if (n.id === id) return repl(n);
  if (n.kind === 'leaf') return n;
  const s = n as SplitOf<N>;
  return { ...s, children: (s.children as N[]).map(c => replaceNode(c, id, repl)) };
}
/** Alt ağacın yeni kimlikli kopyası (split kimliği çocuklardan önce üretilir); derz bağları da kopyalanır. */
export function cloneTree<N extends TreeNode>(n: N, splitPrefix: string, leaf: (l: LeafOf<N>) => N): N {
  if (n.kind === 'leaf') return leaf(n as LeafOf<N>);
  const s = n as SplitOf<N>;
  return {
    ...s, id: genId(splitPrefix), sizes: s.sizes.map(x => ({ ...x })), gaps: [...s.gaps],
    children: (s.children as N[]).map(c => cloneTree(c, splitPrefix, leaf)), ...(s.refs ? { refs: { ...s.refs } } : {}),
  };
}
export function jointRefs<N extends TreeNode>(n: N): Array<{ splitId: string; k: number; ref: RefOf<N> }> {
  if (n.kind === 'leaf') return [];
  const own = Object.entries(n.refs ?? {}).map(([k, ref]) => ({ splitId: n.id, k: +k, ref: ref as RefOf<N> }));
  return [...own, ...(n.children as N[]).flatMap(c => jointRefs(c))];
}
export function spacingNodes<N extends TreeNode>(n: N, axis: 'u' | 'v'): Array<SplitOf<N>> {
  if (n.kind !== 'split') return [];
  const own = n.axis === axis && n.targetSize ? [n as SplitOf<N>] : [];
  return [...own, ...(n.children as N[]).flatMap(c => spacingNodes(c, axis))];
}
/** Kapsamdaki spacing hedefleri; alt ağaçta yoksa seçili bölgeyi ÜRETEN en yakın üst bölmenin hedefi. */
export function spacingTargetsInScope<N extends TreeNode>(tree: N, scopeIds: string[], axis: 'u' | 'v'): Array<SplitOf<N>> {
  const roots = (scopeIds.length ? scopeIds : [tree.id]).map(id => findNode(tree, id)).filter((n): n is N => !!n);
  const out = new Map<string, SplitOf<N>>();
  for (const r of roots) {
    const under = spacingNodes(r, axis);
    if (under.length) { for (const n of under) out.set(n.id, n); continue; }
    for (let par = findParent(tree, r.id); par; par = findParent(tree, par.id)) {
      if (par.axis === axis && par.targetSize) { out.set(par.id, par); break; }
    }
  }
  return [...out.values()];
}
/** Çözümden ağaca: split ölçüleri çözümden; boş targetSize / refs yazılmaz. */
export function unsolveTree<S extends TreeNode, N>(n: S, leaf: (l: LeafOf<S>) => N): N {
  if (n.kind === 'leaf') return leaf(n as LeafOf<S>);
  const s = n as SplitOf<S>;
  return {
    id: s.id, kind: 'split', axis: s.axis, sizes: s.sizes, gaps: s.gaps, children: (s.children as S[]).map(c => unsolveTree(c, leaf)),
    ...(s.targetSize ? { targetSize: s.targetSize } : {}), ...(s.refs && Object.keys(s.refs).length ? { refs: s.refs } : {}),
  } as N;
}
function sameRefMaps<R>(a: Record<number, R> | undefined, b: Record<number, R> | undefined, eq: (x?: R, y?: R) => boolean): boolean {
  const ka = Object.keys(a ?? {}), kb = Object.keys(b ?? {});
  return ka.length === kb.length && ka.every(k => eq(a?.[+k], b?.[+k]));
}
/** Ağaç eşit mi (ölçü/boşluk 0.05 toleranslı); yaprak ve derz bağı karşılaştırması servisten. */
export function sameTree<N extends TreeNode>(
  a: N, b: N, leafEq: (a: LeafOf<N>, b: LeafOf<N>) => boolean, refEq: (x?: RefOf<N>, y?: RefOf<N>) => boolean,
): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;
  if (a.kind === 'leaf' || b.kind === 'leaf') return leafEq(a as LeafOf<N>, b as LeafOf<N>);
  const x = a as SplitOf<N>, y = b as SplitOf<N>;
  const sameSize = (s: GapSpec, i: number) =>
    Math.abs(s.value - y.sizes[i].value) < 0.05 && s.locked === y.sizes[i].locked && !!s.edited === !!y.sizes[i].edited;
  return x.children.length === y.children.length && x.sizes.length === y.sizes.length && x.sizes.every(sameSize)
    && x.gaps.length === y.gaps.length && x.gaps.every((g, i) => Math.abs(g - y.gaps[i]) < 0.05)
    && sameRefMaps(x.refs as Record<number, RefOf<N>> | undefined, y.refs as Record<number, RefOf<N>> | undefined, refEq)
    && (x.children as N[]).every((c, i) => sameTree(c, y.children[i] as N, leafEq, refEq));
}
/** Bağlı levhası silinmiş derz bağları düşer (o bölmenin ölçüleri çözümden dondurulur); değişiklik yoksa null. */
export function pruneRefs<N extends TreeNode, S extends TreeNode>(tree: N, solved: S, vfs: VirtualFace[]): N | null {
  let out = tree, changed = false;
  for (const { splitId, k, ref } of jointRefs(tree)) {
    if (vfs.some(f => f.id === ref.vfId)) continue;
    const sn = findNode(solved, splitId);
    out = replaceNode(out, splitId, old => {
      const o = old as SplitOf<N>;
      const refs = { ...(o.refs ?? {}) }; delete refs[k];
      const sizes = sn && sn.kind === 'split' ? sn.sizes.map(s => ({ ...s, edited: true })) : o.sizes;
      return { ...o, sizes, refs: Object.keys(refs).length ? refs : undefined };
    });
    changed = true;
  }
  return changed ? out : null;
}

// ÖLÇÜ DAĞITIMI
/** `${splitId}:${k}` → bağlı derzin merkezi (bölmenin ekseninde). */
export type JointTargets = Map<string, number>;
export function jointKey(splitId: string, k: number): string { return `${splitId}:${k}`; }
/** Bölmenin n−1 boşluğu; eksik / geçersiz değer ilk boşluktan, o da yoksa varsayılandan. */
export function splitGapsOf(n: { children: unknown[]; gaps: number[] }, gap: number): number[] {
  const m = n.children.length - 1;
  if (n.gaps.length === m && n.gaps.every(x => Number.isFinite(x) && x >= 0)) return n.gaps.slice();
  return Array.from({ length: m }, (_, i) => (Number.isFinite(n.gaps[i]) && n.gaps[i] >= 0 ? n.gaps[i] : n.gaps.length ? n.gaps[0] : gap));
}
// KATSAYI kuralı: kilitli ölçüler sabit; kalan alan kilitsizlere (girilmişler dahil) mevcut oranlarıyla dağılır.
// Toplam alanı tutuyorsa sonuç birimdir (kayma yok).
export function distributeSizes(specs: GapSpec[], L: number, gaps: number[]): GapSpec[] {
  const out = rescaleGaps(specs, L, gaps.length, gaps);
  const resid = round1(L - gaps.reduce((a, g) => a + g, 0) - out.reduce((a, g) => a + g.value, 0));
  if (Math.abs(resid) >= 0.05 && Math.abs(resid) < 1) {
    // Artık önce son AÇIK ölçüye (pinli değer kıpırdamasın), yoksa son kilitsize.
    let j = -1;
    for (let i = out.length - 1; i >= 0 && j < 0; i--) if (gapMode(out[i]) === 'open') j = i;
    for (let i = out.length - 1; i >= 0 && j < 0; i--) if (!out[i].locked) j = i;
    if (j >= 0) out[j] = { ...out[j], value: round1(out[j].value + resid) };
  }
  return out;
}
// along[k] = k. derz merkezinin bölme başlangıcından uzaklığı (u: soldan, v: üstten). Bağ kilitli ölçüye de baskındır;
// tüm ölçüler edited yazılır → bağsız çözüm aynı değerleri verir. Parçalar (en az 1 mm) sığmazsa bağ yok sayılır.
export function distributeSizesWithJoints(specs: GapSpec[], L: number, gaps: number[], along: Map<number, number>): GapSpec[] {
  const n = gaps.length + 1;
  const base = Array.from({ length: n }, (_, i) => specs[i] ?? { value: 0, locked: false });
  const ks = [...along.keys()].filter(k => k >= 0 && k < n - 1).sort((a, b) => a - b);
  if (!ks.length) return distributeSizes(specs, L, gaps);
  const bounds: Array<{ from: number; to: number; a: number; b: number }> = [];
  let from = 0, a = 0;
  for (const k of ks) {
    const c = along.get(k)!, g = gaps[k] ?? 0;
    bounds.push({ from, to: k, a, b: c - g / 2 });
    from = k + 1; a = c + g / 2;
  }
  bounds.push({ from, to: n - 1, a, b: L });
  for (const s of bounds) {
    const inner = gaps.slice(s.from, s.to).reduce((x, y) => x + y, 0);
    if (!(s.b - s.a - inner >= s.to - s.from + 1)) return distributeSizes(specs, L, gaps);
  }
  const out: GapSpec[] = [];
  for (const s of bounds) {
    const segL = s.b - s.a;
    if (s.to === s.from) { out.push({ ...base[s.from], value: round1(segL), edited: true }); continue; }
    for (const sz of distributeSizes(base.slice(s.from, s.to + 1), segL, gaps.slice(s.from, s.to))) out.push({ ...sz, edited: true });
  }
  return out;
}
/** Ağaç çözümü: split alanını çocuklarına dağıtır (u: soldan sağa, v: ÜSTTEN aşağı); toplam her zaman üst alan. Yaprak servisten. */
export function solveTree<N extends TreeNode, S>(
  n: N, r: Box2, gap: number, targets: JointTargets | undefined, leaf: (l: LeafOf<N>, at: SolvedBox) => S, depth = 0,
): S {
  const { u0, u1, v0, v1 } = r;
  if (n.kind === 'leaf') return leaf(n as LeafOf<N>, { u0, u1, v0, v1, depth });
  const s = n as SplitOf<N>;
  const gaps = splitGapsOf(s, gap);
  const L = s.axis === 'u' ? u1 - u0 : v1 - v0;
  const along = new Map<number, number>();
  if (targets && s.refs) for (const k of Object.keys(s.refs)) {
    const t = targets.get(jointKey(s.id, +k));
    if (t != null) along.set(+k, s.axis === 'u' ? t - u0 : v1 - t);
  }
  const sizes = along.size ? distributeSizesWithJoints(s.sizes, L, gaps, along) : distributeSizes(s.sizes, L, gaps);
  const children: S[] = [];
  let pos = s.axis === 'u' ? u0 : v1;
  (s.children as N[]).forEach((c, i) => {
    const w = Math.max(0, sizes[i]?.value ?? 0);
    if (s.axis === 'u') { children.push(solveTree(c, { u0: pos, u1: pos + w, v0, v1 }, gap, targets, leaf, depth + 1)); pos += w + (gaps[i] ?? 0); }
    else { children.push(solveTree(c, { u0, u1, v0: pos - w, v1: pos }, gap, targets, leaf, depth + 1)); pos -= w + (gaps[i] ?? 0); }
  });
  return { ...s, sizes, gaps, children, u0, u1, v0, v1, depth } as unknown as S;
}

/** Derz: iki parça arası boşluk [p0, p1], çapraz eksende [c0, c1]. */
export interface SplitJoint { splitId: string; k: number; axis: 'u' | 'v'; p0: number; p1: number; c0: number; c1: number }
export function treeJoints(solved: SolvedNode): SplitJoint[] {
  const out: SplitJoint[] = [];
  const walk = (n: SolvedNode) => {
    if (n.kind !== 'split') return;
    const last = n.children.length - 1;
    let p = n.axis === 'u' ? n.u0 : n.v1;
    n.children.forEach((c, i) => {
      const w = Math.max(0, n.sizes[i]?.value ?? 0), g = n.gaps[i] ?? 0;
      if (n.axis === 'u') {
        p += w;
        if (i < last) { out.push({ splitId: n.id, k: i, axis: 'u', p0: p, p1: p + g, c0: n.v0, c1: n.v1 }); p += g; }
      } else {
        p -= w;
        if (i < last) { out.push({ splitId: n.id, k: i, axis: 'v', p0: p - g, p1: p, c0: n.u0, c1: n.u1 }); p -= g; }
      }
      walk(c);
    });
  };
  walk(solved);
  return out;
}
/** Levhanın ortasından (kind ekseninde a0..a1, çaprazda c0..c1) bölünebilen yapraklar: iki yanda en az minSpan kalmalı. */
export function leavesSplittableAt<S extends SolvedNode>(
  solved: S, np: { kind: 'u' | 'v'; a0: number; a1: number; c0: number; c1: number }, gap: number, minSpan: number,
): S[] {
  const axis = np.kind, pc = (np.a0 + np.a1) / 2, hits: S[] = [];
  const walk = (n: S) => {
    if (n.kind === 'split') { (n.children as S[]).forEach(walk); return; }
    const a0 = axis === 'u' ? n.u0 : n.v0, a1 = axis === 'u' ? n.u1 : n.v1, c0 = axis === 'u' ? n.v0 : n.u0, c1 = axis === 'u' ? n.v1 : n.u1;
    if (Math.min(c1, np.c1) - Math.max(c0, np.c0) < TOL) return;
    if (pc - gap / 2 - a0 >= minSpan && a1 - (pc + gap / 2) >= minSpan) hits.push(n);
  };
  walk(solved);
  return hits;
}
/** Spacing: hedef ölçülü ilk (DFS) bölmenin alandan türeyen yeni parça sayısı (en az 2); sayı tutuyorsa null. */
export function spacingResize(solved: SolvedNode, count: (L: number, size: number) => number): { id: string; axis: 'u' | 'v'; n: number } | null {
  if (solved.kind !== 'split') return null;
  if (solved.targetSize) {
    const L = solved.axis === 'u' ? solved.u1 - solved.u0 : solved.v1 - solved.v0;
    const want = Math.max(2, count(L, solved.targetSize));
    if (want !== solved.children.length) return { id: solved.id, axis: solved.axis, n: want };
  }
  for (const c of solved.children) { const r = spacingResize(c, count); if (r) return r; }
  return null;
}

// ÜYE VF BAKIMI
/** Üye VF'leri ve panellerini siler; silinen satır seçiliyse seçim düşer. */
export function removeMemberVfs(vfIds: string[]): void {
  const st = useAppStore.getState();
  for (const vfId of vfIds) {
    const p = panelOfVf(vfId, st.shapes);
    if (p) st.deleteShape(p.id);
    st.deleteVirtualFace(vfId);
    if (useAppStore.getState().selectedPanelRow === `vf-${vfId}`) st.setSelectedPanelRow(null);
  }
}
/** Üye VF açıklamaları = grup adı. */
export function renameMemberVfs(vfIds: string[], name: string): void {
  const ids = new Set(vfIds);
  useAppStore.setState(s => ({ virtualFaces: s.virtualFaces.map(f => (ids.has(f.id) ? { ...f, description: name } : f)) }));
}
/** Üye panellerin kalınlığı (motor panelThickness, kutu depth okur). */
export function setMemberPanelThickness(vfIds: string[], t: number): void {
  const st = useAppStore.getState();
  for (const vfId of vfIds) {
    const panel = panelOfVf(vfId, st.shapes);
    if (panel) st.updateShape(panel.id, { parameters: { ...panel.parameters, panelThickness: t, depth: t } } as any);
  }
}
