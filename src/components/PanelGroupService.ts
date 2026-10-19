import * as THREE from 'three';
import {
  type Point2D, type Vec3, panelHasRotation, largestFaceNormal, clipHalfPlane, frontHullOf, clipPolyToConvex, polyArea, genId, round1, localBboxOf,
  effectiveBodyGeometry, getFacesAndGroups, vertexModsKey, isFlatNormal, matchReferenceFace, getShapeMatrix, dominantAxisLabel, type FaceData,
  type CoplanarFaceGroup, computeFaceComponentContour, computeFreeRegionLocal, fromPlaneUV, vec3, createFaceDescriptor, createPanelFromVirtualFace,
  convertReplicadToThreeGeometry, type MoveTransformStep, type ExtrudeStep, axisDirToVec,
} from './Geometry';
import {
  type CavityBox, type Shape, type VirtualFace, panelOfVf, type GapSpec, useAppStore, type PanelGroup, type CavityPick, type CavityStep, shapeById,
  requestRebuild, type RefFacePick, type CornerKey, type QuickBodyConfig, type JoinPass, type BodyLegs, childPanelsOf,
} from '../store';
import { backObstacleFor, isBackPanel, backPreviewStamp, backCandidatesAt, BACK_AXIS, BACK_SIDE, createBackGroupFromPick } from './BackService';
import { doorJointForBond, moveDoorJointTo, isDoorPanel } from './DoorService';

/* PANEL GRUP SERVİSİ — 1) kapak / arkalık / raf-dikme ortak bölme yardımcıları · 2) raf / dikme grupları · 3) hızlı gövde. */

// ════════════════════════════════════════════ 1. ORTAK BÖLME YARDIMCILARI ════════════════════════════════════════════
// KAPAK / ARKALIK / RAF-DİKME ORTAK YARDIMCILARI: yalnız saf geometri, bölme ağacı gezintisi, ölçü dağıtımı ve üye VF bakımı.
// İş kuralları (sınır seçimi, bini, kanal, bağ yönü) servislerde kalır. Yardımcılar fonksiyon bildirimi → döngüsel içe aktarmada TDZ yok.

export type Pt2 = Point2D;
export type Axis3 = 0 | 1 | 2;
export type EdgeKey = 'uMin' | 'uMax' | 'vMin' | 'vMax';
export type SlabPlacement = 'inner' | 'outer';
export type JointAlign = 'min' | 'center' | 'max';
export interface PlaneRect { u0: number; u1: number; v0: number; v1: number }
export const EDGE_KEYS: EdgeKey[] = ['uMin', 'uMax', 'vMin', 'vMax'];

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

// ══════════════════════════════════════════════ 2. RAF / DİKME GRUPLARI ══════════════════════════════════════════════
// RAF / DİKME GRUPLARI: grup = şekilli serbest hacim (CavityGrid hücre bölgesi, tohumdan floodRegion) + n panel + n+1 boşluk.
//  • Her raf kendi dilimindeki kesitin sınır çokgenini alır (sectionPolygon); çıpa (anchorFrac) tohumdur, kutu merkezi değil.
//  • Boşluk: Σgap + n·t = L; kilitli boşluk sabit, kilitsizler oranla ölçeklenir.
//  • VF SIRASI (basan/basılan): üyelerden ÖNCE gelen gövde paneli hacmi sınırlar, SONRA geleni üyeler damgalar.
//    İç grup yalnız kendinden önceki iç grupların panelleriyle sınırlanır.

export const GROUP_PANEL_THICKNESS = 18;
const TOL = 0.5;
const MIN_GAP = 0;

export const isInteriorPanel = (p: any): boolean => !!p?.parameters?.panelGroupId;
export const isInteriorVf = (vf: any): boolean => !!vf?.interior;
export const groupKindLabel = (k: PanelGroup['kind']) => (k === 'shelf' ? 'Shelf' : 'Divider');
type EntryFace = { axis: 0 | 1 | 2; facing: 1 | -1 };
/** Dizilim ekseni: raf daima Y; dikme oka paralel durur → boşluklar okun yatay diki boyunca (ok X → Z, ok Z → X). */
const groupAxisOf = (k: PanelGroup['kind'], arrow?: EntryFace | null, dir?: Vec3): 0 | 1 | 2 => {
  if (k === 'shelf') return 1;
  if (arrow && arrow.axis !== 1) return arrow.axis === 0 ? 2 : 0;
  if (!dir) return 0;
  const ax = Math.abs(dir[0]), az = Math.abs(dir[2]);
  if (ax < 1e-3 && az < 1e-3) return 0;
  return ax >= az ? 2 : 0;
};

function dominantDir(d: Vec3): EntryFace {
  const a = [Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2])];
  const axis = (a[0] >= a[1] && a[0] >= a[2] ? 0 : a[1] >= a[2] ? 1 : 2) as 0 | 1 | 2;
  return { axis, facing: d[axis] >= 0 ? 1 : -1 };
}

/** Işının gövde kutusuna girdiği yüz; facing tıklanan yüzden İÇERİ (min → +1). Kamera içerideyse null. */
function rayEntryFace(o: Vec3, d: Vec3, b: CavityBox): EntryFace | null {
  const e = rayBoxEntry(o, d, b);
  return e ? { axis: e.axis, facing: e.pos ? 1 : -1 } : null;
}

const r1 = round1;
const cloneBox = (b: CavityBox): CavityBox => ({ min: [...b.min] as Vec3, max: [...b.max] as Vec3 });
export const boxSpan = (b: CavityBox, a: number) => b.max[a] - b.min[a];
export const fmtBox = (b: CavityBox) => `${b.min.map(n => n.toFixed(0)).join(',')}..${b.max.map(n => n.toFixed(0)).join(',')}`;
const boxCenter = (b: CavityBox): Vec3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
const fracInCavity = (body: CavityBox, p: Vec3, clamp = false): Vec3 => [0, 1, 2].map(a => {
  const s = body.max[a] - body.min[a];
  if (s <= 1e-6) return clamp ? 0.5 : 0;
  const f = (p[a] - body.min[a]) / s;
  return clamp ? Math.max(0, Math.min(1, f)) : f;
}) as Vec3;
const pointFromFrac = (body: CavityBox, f: Vec3): Vec3 => [0, 1, 2].map(a => body.min[a] + f[a] * (body.max[a] - body.min[a])) as Vec3;

const toCavityBox = (bb: THREE.Box3): CavityBox => ({ min: [bb.min.x, bb.min.y, bb.min.z], max: [bb.max.x, bb.max.y, bb.max.z] });

export function bodyLocalBox(parent: Shape): CavityBox | null {
  const bb = localBboxOf(effectiveBodyGeometry(parent));
  return bb ? toCavityBox(bb) : null;
}

/** Panel geometrisi gövde çerçevesindedir; yalnız konum farkı eklenir. */
export function panelLocalBox(p: Shape, parent: Shape): CavityBox | null {
  const bb = localBboxOf(p.geometry);
  if (!bb || (p.geometry.getAttribute('position') as THREE.BufferAttribute).count === 0) return null;
  const d = [0, 1, 2].map(i => (p.position?.[i] ?? 0) - (parent.position?.[i] ?? 0));
  return toCavityBox(bb.translate(new THREE.Vector3(d[0], d[1], d[2])));
}

export interface CavityGrid {
  body: CavityBox;
  xs: number[]; ys: number[]; zs: number[];
  nx: number; ny: number; nz: number;
  /** 1 = serbest (gövde içinde, panel dışında). */
  free: Uint8Array;
  obstacles?: CavityBox[];
  /** Eğik panel yüzleri: kutu değil YARIM-UZAY olarak sınırlar. */
  tiltFaces?: TiltFace[];
}

// EĞİK PANELLER: kutu engeli kama boşluğunu kaybettirir → ızgarada engel değil, tohuma bakan yüzün yarım-uzayıyla kırpılır.
// VF sırasında ÖNCE ise (basan) üye uzak yüze uzatılır (motor cutByRotatedPressers pahlar); sonra ise yakın yüze (iç içe geçmez).
interface TiltFace { id: string; vfId?: string; n: Vec3; d: number; bbox: CavityBox }
interface TiltPlane extends TiltFace { bevel?: boolean }
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const planeSpanAxes = (pl: TiltFace): [number, number] => {
  const a = [0, 1, 2].sort((x, y) => Math.abs(pl.n[x]) - Math.abs(pl.n[y]));
  return [a[0], a[1]];
};
const inPlaneRange = (pl: TiltFace, p: Vec3, tol = 2): boolean => {
  const [a, b] = planeSpanAxes(pl);
  return p[a] >= pl.bbox.min[a] - tol && p[a] <= pl.bbox.max[a] + tol && p[b] >= pl.bbox.min[b] - tol && p[b] <= pl.bbox.max[b] + tol;
};
/** Kapsama dışındaki düzlem uygulanmaz. */
const insideTiltPlanes = (planes: TiltPlane[], p: Vec3): boolean =>
  planes.every(pl => !inPlaneRange(pl, p) || dot3(pl.n, p) >= pl.d - TOL);
/** Herhangi bir köşesi içerideyse hücre bölgeye alınır (merkez testi kamayı kaybeder); fazlası kesit/önizlemede kırpılır. */
const cellInsideTiltPlanes = (planes: TiltPlane[], b: CavityBox): boolean => planes.every(pl => {
  if (!inPlaneRange(pl, boxCenter(b))) return true;
  let best = -Infinity;
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) {
    best = Math.max(best, dot3(pl.n, [x, y, z]) - pl.d);
  }
  return best >= TOL;
});

function tiltedPanelFaces(parent: Shape, panels: Shape[]): TiltFace[] {
  const out: TiltFace[] = [];
  for (const p of panels) {
    if (!panelHasRotation(p) || !p.geometry) continue;
    const bbox = panelLocalBox(p, parent);
    if (!bbox) continue;
    const dpos = [0, 1, 2].map(i => (p.position?.[i] ?? 0) - (parent.position?.[i] ?? 0));
    const groups = getFacesAndGroups(p.geometry).groups.slice().sort((a, b) => b.totalArea - a.totalArea).slice(0, 2);
    for (const gr of groups) {
      const n = gr.normal.clone().normalize();
      const c: Vec3 = [gr.center.x + dpos[0], gr.center.y + dpos[1], gr.center.z + dpos[2]];
      const nn: Vec3 = [n.x, n.y, n.z];
      out.push({ id: p.id, vfId: (p.parameters as any)?.virtualFaceId, n: nn, d: dot3(nn, c), bbox });
    }
  }
  return out;
}

/** Tohuma bakan yüz → panel başına en fazla bir yarım-uzay (n·p ≥ d). */
function orientTiltPlanes(faces: TiltFace[] | undefined, seed: Vec3): TiltPlane[] {
  if (!faces?.length) return [];
  const best = new Map<string, TiltPlane>();
  for (const f of faces) {
    const side = dot3(f.n, seed) - f.d;
    if (side <= 0) continue;
    const cur = best.get(f.id);
    if (!cur || side < dot3(cur.n, seed) - cur.d) best.set(f.id, { ...f });
  }
  return Array.from(best.values());
}

type Pt3 = Vec3;
const boxFaces = (b: CavityBox): Pt3[][] => {
  const [x0, y0, z0] = b.min, [x1, y1, z1] = b.max;
  return [
    [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]],
    [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
  ];
};

/** Bölgenin eğik düzlemlerle kırpılmış gerçek dış kutusu; dizilim açıklığı L bunu okur (tık noktasından bağımsız olmalı). */
function clippedRegionBBox(g: CavityGrid, cells: Set<number>, planes: TiltPlane[]): CavityBox {
  const raw = regionBBox(g, cells);
  if (!planes.length || !cells.size) return raw;
  const out: CavityBox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const take = (p: Pt3) => { for (let a = 0; a < 3; a++) { if (p[a] < out.min[a]) out.min[a] = p[a]; if (p[a] > out.max[a]) out.max[a] = p[a]; } };
  for (const c of cells) {
    const b = cellBox(g, c);
    const active = planes.filter(pl => inPlaneRange(pl, boxCenter(b)));
    if (!active.length) { take(b.min); take(b.max); continue; }
    for (const face of boxFaces(b)) {
      let poly = face;
      for (const pl of active) { poly = clipPoly3D(poly, pl.n, pl.d); if (poly.length < 3) break; }
      if (poly.length >= 3) for (const p of poly) take(p);
    }
    for (const pl of active) {
      let poly = planeBoxSection(pl.n, pl.d, b);
      if (!poly) continue;
      for (const other of active) { if (other === pl) continue; poly = clipPoly3D(poly, other.n, other.d); if (poly.length < 3) break; }
      if (poly.length >= 3) for (const p of poly) take(p);
    }
  }
  if (!Number.isFinite(out.min[0]) || !Number.isFinite(out.max[0])) return raw;
  // Ham kutuya kırpılır; eksende 1 mm'den ince kalırsa ham aralık kullanılır.
  for (let a = 0; a < 3; a++) {
    out.min[a] = Math.max(out.min[a], raw.min[a]); out.max[a] = Math.min(out.max[a], raw.max[a]);
    if (out.max[a] - out.min[a] < 1) { out.min[a] = raw.min[a]; out.max[a] = raw.max[a]; }
  }
  return out;
}
function clipPoly3D(poly: Pt3[], n: Vec3, d: number): Pt3[] {
  const out: Pt3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = dot3(n, a) - d, db = dot3(n, b) - d;
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) { const t = da / (da - db); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); }
  }
  return out;
}
function clipPoly2D(poly: Pt2[], a: number, b: number, c: number): Pt2[] {
  const out: Pt2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const dp = a * p.x + b * p.y - c, dq = a * q.x + b * q.y - c;
    if (dp >= 0) out.push(p);
    if ((dp >= 0) !== (dq >= 0)) { const t = dp / (dp - dq); out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }); }
  }
  return out;
}
function planeBoxSection(n: Vec3, d: number, b: CavityBox): Pt3[] | null {
  const M = Math.max(boxSpan(b, 0), boxSpan(b, 1), boxSpan(b, 2)) * 4 + 10;
  const c = boxCenter(b);
  const k = dot3(n, c) - d;
  const o: Vec3 = [c[0] - n[0] * k, c[1] - n[1] * k, c[2] - n[2] * k];
  const ax = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u: Vec3 = [n[1] * ax[2] - n[2] * ax[1], n[2] * ax[0] - n[0] * ax[2], n[0] * ax[1] - n[1] * ax[0]];
  const lu = Math.hypot(u[0], u[1], u[2]) || 1; u[0] /= lu; u[1] /= lu; u[2] /= lu;
  const v: Vec3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  const at = (a: number, bb: number): Vec3 => [o[0] + u[0] * a + v[0] * bb, o[1] + u[1] * a + v[1] * bb, o[2] + u[2] * a + v[2] * bb];
  let poly: Pt3[] = [at(-M, -M), at(M, -M), at(M, M), at(-M, M)];
  for (let a = 0; a < 3; a++) {
    const e: Vec3 = [0, 0, 0]; e[a] = 1;
    poly = clipPoly3D(poly, e, b.min[a]); if (poly.length < 3) return null;
    const e2: Vec3 = [0, 0, 0]; e2[a] = -1;
    poly = clipPoly3D(poly, e2, -b.max[a]); if (poly.length < 3) return null;
  }
  return poly;
}
function polyCentroid(poly: Pt3[]): Vec3 {
  const c: Vec3 = [0, 0, 0];
  for (const p of poly) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  return [c[0] / poly.length, c[1] / poly.length, c[2] / poly.length];
}

function clipSurfaceByPlanes(g: CavityGrid, cells: Set<number>, surface: number[], planes: TiltPlane[]): number[] {
  if (!planes.length) return surface;
  const out: number[] = [];
  const fan = (poly: Pt3[]) => { for (let i = 1; i < poly.length - 1; i++) out.push(...poly[0], ...poly[i], ...poly[i + 1]); };
  for (let t = 0; t < surface.length; t += 9) {
    const vtx = (i: number): Vec3 => [surface[i], surface[i + 1], surface[i + 2]];
    let poly: Pt3[] = [vtx(t), vtx(t + 3), vtx(t + 6)];
    for (const pl of planes) {
      if (!inPlaneRange(pl, polyCentroid(poly))) continue;
      poly = clipPoly3D(poly, pl.n, pl.d);
      if (poly.length < 3) break;
    }
    if (poly.length >= 3) fan(poly);
  }
  for (const pl of planes) {
    for (const c of cells) {
      const b = cellBox(g, c);
      if (!inPlaneRange(pl, boxCenter(b))) continue;
      let poly = planeBoxSection(pl.n, pl.d, b);
      if (!poly) continue;
      for (const other of planes) {
        if (other === pl || !inPlaneRange(other, polyCentroid(poly))) continue;
        poly = clipPoly3D(poly, other.n, other.d);
        if (poly.length < 3) break;
      }
      if (poly.length >= 3) fan(poly);
    }
  }
  return out;
}

/** Dilim [a0,a1] boyunca: bevel yoksa en kısıtlayıcı doğru (iç içe geçmez), bevel ise en uzak (motor pahlar). */
function clipSectionByPlanes(poly: Pt2[], axis: number, a0: number, a1: number, planes: TiltPlane[]): Pt2[] {
  const [ua, va] = [0, 1, 2].filter(a => a !== axis);
  let out = poly;
  for (const pl of planes) {
    if (a1 < pl.bbox.min[axis] - TOL || a0 > pl.bbox.max[axis] + TOL) continue;
    const nu = pl.n[ua], nv = pl.n[va], ns = pl.n[axis];
    if (Math.abs(nu) < 1e-9 && Math.abs(nv) < 1e-9) continue;
    const r0 = pl.d - ns * a0, r1 = pl.d - ns * a1;
    const rhs = pl.bevel ? Math.min(r0, r1) : Math.max(r0, r1);
    out = clipPoly2D(out, nu, nv, rhs);
    if (out.length < 3) return out;
  }
  return out;
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

/** Kapalı mesh içinde mi: ışın paritesi; eğik ışın kenar/köşe dejenerasyonlarını önler. */
function makeInsideMeshTest(geo: THREE.BufferGeometry): (p: Vec3) => boolean {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const idx = geo.getIndex();
  const n = idx ? idx.count : pos.count;
  const tri = new Float64Array(n * 3);
  for (let t = 0; t < n; t++) {
    const vi = idx ? idx.getX(t) : t;
    tri[t * 3] = pos.getX(vi); tri[t * 3 + 1] = pos.getY(vi); tri[t * 3 + 2] = pos.getZ(vi);
  }
  const d = [0.8931, 0.3117, 0.3243];
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

/** Hacim adımlarının hedef düzlemleri ızgaraya eklenir ki kesim tam hücre sınırına düşsün. */
export interface StepPlane { axis: number; coord: number }
const hasPlane = (g: CavityGrid, pl: StepPlane) => axisPlanes(g, pl.axis).some(v => Math.abs(v - pl.coord) <= TOL);

function buildCavityGrid(
  parent: Shape, obstacles: CavityBox[], splitBoxes: CavityBox[] = [], tiltFaces: TiltFace[] = [], extraPlanes: StepPlane[] = [],
): CavityGrid | null {
  const geo = effectiveBodyGeometry(parent);
  const body = bodyLocalBox(parent);
  if (!geo || !body) return null;
  const tiltKey = tiltFaces.map(f => `${f.id}:${f.n.map(x => x.toFixed(3)).join(',')}:${f.d.toFixed(1)}`).join(';');
  const planesKey = extraPlanes.map(e => `${e.axis}:${e.coord.toFixed(1)}`).join(',');
  const key = `${geo.uuid}|${vertexModsKey(parent.vertexModifications || [])}|${boxesKey(obstacles)}|${boxesKey(splitBoxes)}|${tiltKey}|${planesKey}`;
  const hit = _gridCache.get(key);
  if (hit) return hit;

  const { groups } = getFacesAndGroups(geo);
  const px: number[] = [], py: number[] = [], pz: number[] = [];
  let axisFaces = 0;
  for (const g of groups) {
    if (!isFlatNormal(g.normal)) continue;
    axisFaces++;
    const onX = Math.abs(g.normal.x) > 0.999, onY = Math.abs(g.normal.y) > 0.999;
    (onX ? px : onY ? py : pz).push(onX ? g.center.x : onY ? g.center.y : g.center.z);
  }
  for (const o of [...obstacles, ...splitBoxes]) { px.push(o.min[0], o.max[0]); py.push(o.min[1], o.max[1]); pz.push(o.min[2], o.max[2]); }
  for (const e of extraPlanes) (e.axis === 0 ? px : e.axis === 1 ? py : pz).push(e.coord);
  const xs = uniqSorted(px, body.min[0], body.max[0]);
  const ys = uniqSorted(py, body.min[1], body.max[1]);
  const zs = uniqSorted(pz, body.min[2], body.max[2]);
  const nx = xs.length - 1, ny = ys.length - 1, nz = zs.length - 1;
  const grid: CavityGrid = { body, xs, ys, zs, nx, ny, nz, free: new Uint8Array(nx * ny * nz), obstacles, tiltFaces };
  // Düz kutu gövdede mesh içi testine gerek yok.
  const modified = !!parent.vertexModifications?.length || !!parent.subtractionGeometries?.some(Boolean) || !!parent.fillets?.length;
  const inside = groups.length === 6 && axisFaces === 6 && !modified ? null : makeInsideMeshTest(geo);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c: Vec3 = [(xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2, (zs[k] + zs[k + 1]) / 2];
    if (obstacles.some(o => strictlyInside(c, o))) continue;
    if (inside && !inside(c)) continue;
    grid.free[cellIndex(grid, i, j, k)] = 1;
  }
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

function cellOfPoint(g: CavityGrid, p: Vec3): number {
  const i = planeIndex(g.xs, p[0]), j = planeIndex(g.ys, p[1]), k = planeIndex(g.zs, p[2]);
  if (i < 0 || j < 0 || k < 0) return -1;
  return cellIndex(g, i, j, k);
}

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

function floodRegion(g: CavityGrid, seed: number, allow?: (c: number) => boolean): Set<number> {
  const out = new Set<number>();
  if (seed < 0 || !g.free[seed] || (allow && !allow(seed))) return out;
  const stack = [seed]; out.add(seed);
  while (stack.length) {
    const c = stack.pop()!;
    const [i, j, k] = cellIJK(g, c);
    const nb: Array<[number, number, number]> = [[i - 1, j, k], [i + 1, j, k], [i, j - 1, k], [i, j + 1, k], [i, j, k - 1], [i, j, k + 1]];
    for (const [a, b, d] of nb) {
      if (a < 0 || b < 0 || d < 0 || a >= g.nx || b >= g.ny || d >= g.nz) continue;
      const n = cellIndex(g, a, b, d);
      if (!g.free[n] || out.has(n) || (allow && !allow(n))) continue;
      out.add(n); stack.push(n);
    }
  }
  return out;
}

function regionBBox(g: CavityGrid, cells: Set<number>): CavityBox {
  const b: CavityBox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const c of cells) {
    const cb = cellBox(g, c);
    for (let a = 0; a < 3; a++) { if (cb.min[a] < b.min[a]) b.min[a] = cb.min[a]; if (cb.max[a] > b.max[a]) b.max[a] = cb.max[a]; }
  }
  return b;
}

function regionBoxes(g: CavityGrid, cells: Set<number>): CavityBox[] {
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

const regionKey = (cells: Set<number>) => Array.from(cells).sort((a, b) => a - b).join(',');

function regionSurface(g: CavityGrid, cells: Set<number>): number[] {
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

/** Maske sınır döngüleri (dolu bölge SOLDA); sıkışma noktalarında sağa dönülür → döngüler kesişmez. */
export function traceMaskLoops(us: number[], vs: number[], filled: (i: number, k: number) => boolean): Pt2[][] {
  const nu = us.length - 1, nv = vs.length - 1;
  const f = (i: number, k: number) => i >= 0 && k >= 0 && i < nu && k < nv && filled(i, k);
  type E = { a: [number, number]; b: [number, number]; used: boolean };
  const edges: E[] = [];
  const byStart = new Map<string, E[]>();
  const add = (a: [number, number], b: [number, number]) => {
    const e: E = { a, b, used: false }; edges.push(e);
    const key = `${a[0]},${a[1]}`; if (!byStart.has(key)) byStart.set(key, []); byStart.get(key)!.push(e);
  };
  for (let i = 0; i < nu; i++) for (let k = 0; k < nv; k++) {
    if (!f(i, k)) continue;
    if (!f(i, k - 1)) add([i, k], [i + 1, k]);
    if (!f(i + 1, k)) add([i + 1, k], [i + 1, k + 1]);
    if (!f(i, k + 1)) add([i + 1, k + 1], [i, k + 1]);
    if (!f(i - 1, k)) add([i, k + 1], [i, k]);
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

const pointInPoly = (pt: Pt2, poly: Pt2[]) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};

/** Dilimi kesen TÜM katmanlarda bölgede olan (u,v) hücrelerinin dış sınırı; çok parçada tohumu içeren, yoksa en büyük. */
function sectionPolygon(g: CavityGrid, cells: Set<number>, axis: number, a0: number, a1: number, seed?: Vec3): Pt2[] | null {
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

/** Tık yönü: ışının dizilim bileşeninin işareti; ışın eksene dikse tıklanan yarıdan içeri. Ekseni asla değiştirmez. */
function facingOf(axis: number, dirAxis: number, at: Vec3, bbox: CavityBox): 1 | -1 {
  if (Math.abs(dirAxis) > 1e-3) return dirAxis > 0 ? 1 : -1;
  return at[axis] <= (bbox.min[axis] + bbox.max[axis]) / 2 ? 1 : -1;
}
type RayCtx = { axis: 0 | 1 | 2; dirAxis: number; at: Vec3; arrow: EntryFace };

function pickFromRegion(
  g: CavityGrid, cells: Set<number>, seed: Vec3, shape: CavityPick['shape'] = 'shaped', planes: TiltPlane[] = [], ray?: RayCtx,
): CavityPick {
  const bbox = clippedRegionBBox(g, cells, planes);
  const axis = ray?.axis ?? 0;
  const at: Vec3 = ray ? [...ray.at] as Vec3 : [...seed] as Vec3;
  const facing = ray ? facingOf(axis, ray.dirAxis, at, bbox) : 1;
  const arrow: EntryFace = ray ? { ...ray.arrow } : { axis, facing };
  const surface = clipSurfaceByPlanes(g, cells, regionSurface(g, cells), planes);
  return { key: `${shape}:${regionKey(cells)}`, bbox, boxes: regionBoxes(g, cells), surface, seed, shape, axis, facing, at, arrow };
}

/** Tohum hücresini içeren, hiçbir yönde büyütülemeyen kutular (3B toplam tablosuyla O(1) doluluk); hacme göre azalan. */
function maximalBoxesContaining(g: CavityGrid, cells: Set<number>, seedCell: number): Array<{ cells: Set<number>; bbox: CavityBox; volume: number }> {
  const { nx, ny, nz } = g;
  const [si, sj, sk] = cellIJK(g, seedCell);
  const X = nx + 1, Y = ny + 1, Z = nz + 1;
  const S = new Int32Array(X * Y * Z);
  const at = (i: number, j: number, k: number) => S[(i * Y + j) * Z + k];
  for (let i = 1; i <= nx; i++) for (let j = 1; j <= ny; j++) for (let k = 1; k <= nz; k++) {
    const v = cells.has(cellIndex(g, i - 1, j - 1, k - 1)) ? 1 : 0;
    S[(i * Y + j) * Z + k] = v + at(i - 1, j, k) + at(i, j - 1, k) + at(i, j, k - 1)
      - at(i - 1, j - 1, k) - at(i - 1, j, k - 1) - at(i, j - 1, k - 1) + at(i - 1, j - 1, k - 1);
  }
  const count = (i0: number, i1: number, j0: number, j1: number, k0: number, k1: number) =>
    at(i1 + 1, j1 + 1, k1 + 1) - at(i0, j1 + 1, k1 + 1) - at(i1 + 1, j0, k1 + 1) - at(i1 + 1, j1 + 1, k0)
    + at(i0, j0, k1 + 1) + at(i0, j1 + 1, k0) + at(i1 + 1, j0, k0) - at(i0, j0, k0);
  const full = (i0: number, i1: number, j0: number, j1: number, k0: number, k1: number) =>
    count(i0, i1, j0, j1, k0, k1) === (i1 - i0 + 1) * (j1 - j0 + 1) * (k1 - k0 + 1);
  const out: Array<{ cells: Set<number>; bbox: CavityBox; volume: number }> = [];
  const seen = new Set<string>();
  let budget = 3_000_000;
  for (let i0 = si; i0 >= 0; i0--) for (let i1 = si; i1 < nx; i1++) {
    if (!full(i0, i1, sj, sj, sk, sk)) break;
    for (let j0 = sj; j0 >= 0; j0--) for (let j1 = sj; j1 < ny; j1++) {
      if (!full(i0, i1, j0, j1, sk, sk)) break;
      for (let k0 = sk; k0 >= 0; k0--) for (let k1 = sk; k1 < nz; k1++) {
        if (--budget < 0) break;
        if (!full(i0, i1, j0, j1, k0, k1)) break;
        if (i0 > 0 && full(i0 - 1, i1, j0, j1, k0, k1)) continue;
        if (i1 < nx - 1 && full(i0, i1 + 1, j0, j1, k0, k1)) continue;
        if (j0 > 0 && full(i0, i1, j0 - 1, j1, k0, k1)) continue;
        if (j1 < ny - 1 && full(i0, i1, j0, j1 + 1, k0, k1)) continue;
        if (k0 > 0 && full(i0, i1, j0, j1, k0 - 1, k1)) continue;
        if (k1 < nz - 1 && full(i0, i1, j0, j1, k0, k1 + 1)) continue;
        const key = `${i0},${i1},${j0},${j1},${k0},${k1}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const sub = new Set<number>();
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) sub.add(cellIndex(g, i, j, k));
        const bbox: CavityBox = { min: [g.xs[i0], g.ys[j0], g.zs[k0]], max: [g.xs[i1 + 1], g.ys[j1 + 1], g.zs[k1 + 1]] };
        out.push({ cells: sub, bbox, volume: boxSpan(bbox, 0) * boxSpan(bbox, 1) * boxSpan(bbox, 2) });
      }
    }
  }
  out.sort((a, b) => b.volume - a.volume);
  return out;
}

type BoxAlt = { cells: Set<number>; bbox: CavityBox; volume: number; derived?: boolean };

/** Panel-derinliği alternatifleri: maksimal olmadıkları için maximalBoxesContaining vermez; sınırlar engel düzlemi → hücrelerle örtüşür. */
function panelBoundedBoxes(g: CavityGrid, B: BoxAlt): BoxAlt[] {
  const obs = g.obstacles || [];
  const out: BoxAlt[] = [];
  const seen = new Set<string>([fmtBox(B.bbox)]);
  for (const O of obs) {
    for (let a = 0; a < 3; a++) {
      const touches = Math.abs(O.max[a] - B.bbox.min[a]) < TOL || Math.abs(O.min[a] - B.bbox.max[a]) < TOL;
      if (!touches) continue;
      const others = [0, 1, 2].filter(x => x !== a);
      if (!others.every(b => Math.min(O.max[b], B.bbox.max[b]) - Math.max(O.min[b], B.bbox.min[b]) > TOL)) continue;
      const clipSets: number[][] = [[others[0]], [others[1]], others];
      for (const axes of clipSets) {
        const bb: CavityBox = { min: [...B.bbox.min] as Vec3, max: [...B.bbox.max] as Vec3 };
        let changed = false;
        for (const b of axes) {
          const lo = Math.max(B.bbox.min[b], O.min[b]), hi = Math.min(B.bbox.max[b], O.max[b]);
          if (lo > bb.min[b] + TOL || hi < bb.max[b] - TOL) changed = true;
          bb.min[b] = lo; bb.max[b] = hi;
        }
        if (!changed) continue;
        const k = fmtBox(bb);
        if (seen.has(k)) continue;
        seen.add(k);
        const cells = new Set<number>();
        for (const c of B.cells) {
          const cb = cellBox(g, c);
          if ([0, 1, 2].every(x => cb.min[x] >= bb.min[x] - TOL && cb.max[x] <= bb.max[x] + TOL)) cells.add(c);
        }
        if (!cells.size) continue;
        out.push({ cells, bbox: regionBBox(g, cells), volume: boxSpan(bb, 0) * boxSpan(bb, 1) * boxSpan(bb, 2), derived: true });
      }
    }
  }
  return out;
}

/** Düz alternatifler; seçim ailesi ve düz-mod resize çözümü AYNI listeyi kullanmalı. */
const spansAtLeast = (b: CavityBox, minSpan: number) => boxSpan(b, 0) >= minSpan && boxSpan(b, 1) >= minSpan && boxSpan(b, 2) >= minSpan;
function boxAlternatives(g: CavityGrid, cells: Set<number>, seedCells: number[], minSpan = 0): BoxAlt[] {
  const okSpan = (b: CavityBox) => spansAtLeast(b, minSpan);
  const seen = new Set<string>();
  const out: BoxAlt[] = [];
  const push = (b: BoxAlt) => { const k = fmtBox(b.bbox); if (seen.has(k) || !okSpan(b.bbox)) return; seen.add(k); out.push(b); };
  const maximal: BoxAlt[] = [];
  for (const sc of seedCells) for (const b of maximalBoxesContaining(g, cells, sc)) {
    if (!seen.has(fmtBox(b.bbox)) && okSpan(b.bbox)) maximal.push(b);
    push(b);
  }
  for (const b of maximal) for (const d of panelBoundedBoxes(g, b)) push(d);
  out.sort((a, b) => b.volume - a.volume);
  return out;
}

/** Aday ailesi: şekilli bölge (tek kutu değilse) → düz kutular, büyükten küçüğe. */
function candidateFamily(
  g: CavityGrid, cells: Set<number>, rayCells: number[], seed: Vec3, minSpan: number, planes: TiltPlane[] = [], ray?: RayCtx,
): CavityPick[] {
  const out: CavityPick[] = [];
  const boxes = boxAlternatives(g, cells, rayCells, minSpan);
  const regionIsBox = boxes.some(b => !b.derived && b.cells.size === cells.size);
  const shaped = pickFromRegion(g, cells, seed, 'shaped', planes, ray);
  if (!regionIsBox && spansAtLeast(shaped.bbox, minSpan)) out.push(shaped);
  for (const b of boxes) out.push(pickFromRegion(g, b.cells, seed, 'box', planes, ray));
  return out;
}

/** Işın boyunca bölgeler (derinlik sırasıyla) × aday ailesi; sol tık bu listede döner. */
export function rayCavityCandidates(originLocal: Vec3, dirLocal: Vec3, g: CavityGrid, minSpan: number, kind: PanelGroup['kind'] = 'divider'): CavityPick[] {
  // Ok = tıklanan gövde yüzünden içeri (kameradan bağımsız). Sayım tarafı: ok dizilim eksenindeyse oktan, değilse tıklanan yarıdan.
  let arrow = rayEntryFace(originLocal, dirLocal, g.body) ?? dominantDir(dirLocal);
  // Üst/alt yüzden tık: ok sabit önden arkaya (gövde-yerel ön = +Z → Z−).
  if (arrow.axis === 1) arrow = { axis: 2, facing: -1 };
  const axis = groupAxisOf(kind, arrow, dirLocal);
  const dirAxis = arrow.axis === axis ? arrow.facing : 0;
  const bodyIv = rayBoxInterval(originLocal, dirLocal, g.body);
  if (!bodyIv) return [];
  const t0 = Math.max(bodyIv[0], 0), t1 = bodyIv[1];
  if (t1 <= t0) return [];
  const ts: number[] = [t0, t1];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(dirLocal[a]) < 1e-9) continue;
    for (const p of axisPlanes(g, a)) { const t = (p - originLocal[a]) / dirLocal[a]; if (t > t0 && t < t1) ts.push(t); }
  }
  ts.sort((a, b) => a - b);
  const regions: Array<{ key: string; cells: Set<number>; rayCells: number[]; seed: Vec3; planes: TiltPlane[] }> = [];
  const byKey = new Map<string, number>();
  for (let n = 0; n < ts.length - 1; n++) {
    if (ts[n + 1] - ts[n] < 1e-6) continue;
    const tm = (ts[n] + ts[n + 1]) / 2;
    const p: Vec3 = [originLocal[0] + dirLocal[0] * tm, originLocal[1] + dirLocal[1] * tm, originLocal[2] + dirLocal[2] * tm];
    const c = cellOfPoint(g, p);
    if (c < 0 || !g.free[c]) continue;
    const planes = orientTiltPlanes(g.tiltFaces, p);
    if (!insideTiltPlanes(planes, p)) continue;
    let ri = -1;
    for (let r = 0; r < regions.length; r++) if (regions[r].cells.has(c) && insideTiltPlanes(regions[r].planes, p)) { ri = r; break; }
    if (ri < 0) {
      const cells = floodRegion(g, c, planes.length ? (cc => cellInsideTiltPlanes(planes, cellBox(g, cc))) : undefined);
      if (!cells.size) continue;
      const key = regionKey(cells) + '|' + planes.map(pl => `${pl.id}:${pl.d.toFixed(0)}`).join(',');
      if (byKey.has(key)) ri = byKey.get(key)!;
      else { byKey.set(key, regions.length); regions.push({ key, cells, rayCells: [], seed: p, planes }); ri = regions.length - 1; }
    }
    if (!regions[ri].rayCells.includes(c)) regions[ri].rayCells.push(c);
  }
  const out: CavityPick[] = [];
  for (const r of regions) out.push(...candidateFamily(g, r.cells, r.rayCells, r.seed, minSpan, r.planes, { axis, dirAxis, at: r.seed, arrow }));
  return out;
}

/** Üye başına kalınlık (eksik/kısa dizi grup kalınlığıyla dolar); boşluklar Σkalınlık düşülerek dağıtılır. */
export function memberThicknessesOf(group: Pick<PanelGroup, 'count' | 'thickness' | 'memberThicknesses'>, count = group.count): number[] {
  const src = Array.isArray(group.memberThicknesses) ? group.memberThicknesses : [];
  return Array.from({ length: Math.max(0, count) }, (_, i) => (src[i] > 0 ? src[i] : group.thickness));
}
const sumT = (ts: number[]) => ts.reduce((s, t) => s + t, 0);

export function equalGaps(L: number, count: number, ts: number[]): GapSpec[] {
  const n = Math.max(0, count);
  const g = Math.max(MIN_GAP, (L - sumT(ts)) / (n + 1));
  return Array.from({ length: n + 1 }, () => ({ value: r1(g), locked: false }));
}

/** Kalınlık değişince: kilitli/girilmiş sabit, fark girilmemişlere EŞİT; yoksa rescaleGaps. */
export function redistributeForThickness(gaps: GapSpec[], L: number, count: number, ts: number[]): GapSpec[] {
  if (!Array.isArray(gaps) || gaps.length !== count + 1) return equalGaps(L, count, ts);
  const out = gaps.map(g => ({ ...g }));
  const avail = L - sumT(ts);
  const fresh = out.filter(g => !g.locked && !g.edited);
  if (fresh.length > 0) {
    const fixedSum = out.filter(g => g.locked || g.edited).reduce((s, g) => s + g.value, 0);
    let free = avail - fixedSum;
    if (free < 0) free = 0;   // kilitli/girilmiş boşluklar açıklığa sığmıyor
    for (const g of fresh) g.value = r1(Math.max(MIN_GAP, free / fresh.length));
    return out;
  }
  return rescaleGaps(out, L, count, ts);
}

/** Hacim değişince: kilitliler sabit (sığmazsa oransal küçülür), kalan kilitsizlere oranla; hepsi kilitliyse artık son boşluğa. */
export function rescaleGaps(gaps: GapSpec[], L: number, count: number, ts: number[]): GapSpec[] {
  if (!Array.isArray(gaps) || gaps.length !== count + 1) return equalGaps(L, count, ts);
  const avail = L - sumT(ts);
  const out = gaps.map(g => ({ ...g }));
  const lockedSum = out.filter(g => g.locked).reduce((s, g) => s + g.value, 0);
  let free = avail - lockedSum;
  if (free < -1e-6) {
    // Kilitliler açıklığa sığmıyor: oransal küçültülür.
    const k = lockedSum > 0 ? Math.max(0, avail) / lockedSum : 0;
    for (const g of out) if (g.locked) g.value = r1(g.value * k);
    free = 0;
  }
  const unlocked = out.filter(g => !g.locked);
  if (unlocked.length === 0) {
    const last = out[out.length - 1];
    if (Math.abs(free) > 0.05) last.value = r1(last.value + free);   // tüm boşluklar kilitli: artık son boşluğa
    return out;
  }
  const uSum = unlocked.reduce((s, g) => s + g.value, 0);
  if (uSum > 1e-6) for (const g of unlocked) g.value = r1(g.value * free / uSum);
  else for (const g of unlocked) g.value = r1(free / unlocked.length);
  const total = out.reduce((s, g) => s + g.value, 0);
  const resid = avail - total;
  if (Math.abs(resid) > 0.05) {
    // Artık son AÇIK ölçüye (pinli değer kıpırdamasın), yoksa son kilitsize.
    const tgt = [...unlocked].reverse().find(g => !g.edited) ?? unlocked[unlocked.length - 1];
    tgt.value = r1(tgt.value + resid);
  }
  return out;
}

/** Ölçü modu (DoorService ile ortak): 'open' alan ve kardeşle oranla; 'hold' (edited) kardeş farkını almaz ama alanla ölçeklenir;
 *  'locked' sabit. n ölçüde en fazla n−1 pinli+kilitli (passiveGapIndex). */
export type GapMode = 'open' | 'hold' | 'locked';
export const gapMode = (g: GapSpec | undefined): GapMode => (g?.locked ? 'locked' : g?.edited ? 'hold' : 'open');
export const nextGapMode = (m: GapMode): GapMode => (m === 'open' ? 'hold' : m === 'hold' ? 'locked' : 'open');
/** Pasif ölçü: ≥2 ölçüde tek açık kalan (yoksa tek kilitsiz) farkı toplar; girilemez/pinlenemez/kilitlenemez. Yoksa −1. */
export function passiveGapIndex(gaps: ReadonlyArray<GapSpec | undefined>, count = gaps.length): number {
  if (count < 2) return -1;
  const sole = (pred: (g: GapSpec | undefined) => boolean): number => {
    let idx = -1;
    for (let i = 0; i < count; i++) {
      if (!pred(gaps[i])) continue;
      if (idx >= 0) return -2;
      idx = i;
    }
    return idx;
  };
  const open = sole(g => gapMode(g) === 'open');
  if (open >= 0) return open;
  if (open === -2) return -1;
  const unlocked = sole(g => !g?.locked);
  return unlocked >= 0 ? unlocked : -1;
}
/** Pasif ölçü pinlenemez/kilitlenemez (null = değişiklik yok; pasif kilitliyse → açık). */
export function cycleGapMode(gaps: GapSpec[], k: number, count = gaps.length): GapSpec[] | null {
  if (k < 0 || k >= gaps.length) return null;
  const cur = gapMode(gaps[k]);
  let next = nextGapMode(cur);
  if (next !== 'open' && passiveGapIndex(gaps, count) === k) {
    if (cur === 'open') return null;
    next = 'open';
  }
  return gaps.map((g, i) => (i === k ? { ...g, locked: next === 'locked', edited: next === 'hold' } : g));
}
/** Ölçü girişi (kapak + raf/dikme ortak): fark AÇIK ölçülere oranla (yoksa pinlilere), MIN su doldurma; sığmayan değer kırpılır.
 *  `base` = düzenleme başındaki dizi (oranlar her tuşta kaymasın). Pasif ölçü ve diğerleri kilitliyken giriş yok sayılır;
 *  `force` (kapak derzi bağı) ikisini de yok sayar (hepsi kilitliyse değer alana kırpılır). */
export function applyGapEditProportional(gaps: GapSpec[], k: number, value: number, L: number, count: number, ts: number[],
  opts: { base?: GapSpec[]; min?: number; force?: boolean } = {}): GapSpec[] {
  const n = count + 1, MIN = opts.min ?? MIN_GAP;
  const cur = gaps.length === n ? gaps : equalGaps(L, count, ts);
  const out = (opts.base && opts.base.length === n
    ? rescaleGaps(opts.base.map((b, i) => ({ ...b, locked: !!cur[i].locked, edited: !!cur[i].edited })), L, count, ts)
    : cur).map(g => ({ ...g }));
  if (k < 0 || k >= n) return out;
  if (!opts.force && passiveGapIndex(out, n) === k) return out;
  const avail = L - sumT(ts);
  const others = out.map((_, i) => i).filter(i => i !== k);
  const unlocked = others.filter(i => !out[i].locked);
  if (!unlocked.length) {
    if (!opts.force) return out;
    const lockedSum = others.reduce((a, i) => a + out[i].value, 0);
    out[k] = { ...out[k], value: r1(Math.max(MIN, avail - lockedSum)), edited: true };
    return out;
  }
  const open = unlocked.filter(i => gapMode(out[i]) === 'open');
  const soft = open.length ? open : unlocked;
  const fixedSum = others.filter(i => !soft.includes(i)).reduce((a, i) => a + out[i].value, 0);
  const maxV = avail - fixedSum - soft.length * MIN;
  const v = r1(Math.max(MIN, Math.min(value, maxV)));
  out[k] = { ...out[k], value: v, edited: true };
  let pool = soft.slice(), budget = Math.max(0, avail - fixedSum - v);
  const w = new Map(soft.map(i => [i, Math.max(0, out[i].value)] as [number, number]));
  for (let guard = 0; guard <= soft.length && pool.length; guard++) {
    const wSum = pool.reduce((a, i) => a + w.get(i)!, 0);
    const share = (i: number) => (wSum > 1e-6 ? (w.get(i)! * budget) / wSum : budget / pool.length);
    const low = pool.filter(i => share(i) < MIN);
    if (!low.length) { for (const i of pool) out[i] = { ...out[i], value: r1(share(i)) }; pool = []; break; }
    for (const i of low) { out[i] = { ...out[i], value: MIN }; budget -= MIN; }
    pool = pool.filter(i => !low.includes(i));
  }
  const resid = r1(avail - out.reduce((a, g) => a + g.value, 0));
  if (Math.abs(resid) >= 0.05) { const j = soft[soft.length - 1]; out[j] = { ...out[j], value: r1(out[j].value + resid) }; }
  return out;
}

/** Boşluk girişi: fark girilmemiş kilitsizlere EŞİT, yoksa girilmiş kilitsizlere oransal, yoksa değer kırpılır. */
export function applyGapEdit(gaps: GapSpec[], k: number, value: number, L: number, count: number, ts: number[]): GapSpec[] {
  const out = (gaps.length === count + 1 ? gaps : equalGaps(L, count, ts)).map(g => ({ ...g }));
  if (k < 0 || k >= out.length) return out;
  const avail = L - sumT(ts);
  const v = Math.max(MIN_GAP, value);
  out[k] = { ...out[k], value: r1(v), edited: true };
  const others = out.filter((_, i) => i !== k);
  const fixedSum = others.filter(g => g.locked || g.edited).reduce((s, g) => s + g.value, 0);
  let free = avail - out[k].value - fixedSum;
  const fresh = others.filter(g => !g.locked && !g.edited);
  if (fresh.length > 0) {
    if (free < 0) free = 0;   // girilen değer açıklığı aşıyor
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
  // Diğer boşluklar kilitli: değer kırpılır.
  const lockedSum = others.reduce((s, g) => s + g.value, 0);
  out[k].value = r1(Math.max(MIN_GAP, avail - lockedSum));
  return out;
}

export const groupFacing = (g: Pick<PanelGroup, 'facing'>): 1 | -1 => (g.facing === -1 ? -1 : 1);

/** Levha başlangıçları ([start, start+t]); sayım tıklanan taraftan: gap[0] ve üye 0 daima tıklanan tarafa en yakın. */
export function panelStarts(cavity: CavityBox, axis: number, facing: 1 | -1, gaps: GapSpec[], ts: number[]): number[] {
  const starts: number[] = [];
  if (facing > 0) {
    let p = cavity.min[axis];
    for (let i = 0; i < gaps.length - 1; i++) {
      p += gaps[i].value;
      starts.push(p);
      p += ts[i] ?? ts[ts.length - 1] ?? 0;
    }
  } else {
    let p = cavity.max[axis];
    for (let i = 0; i < gaps.length - 1; i++) {
      p -= gaps[i].value + (ts[i] ?? ts[ts.length - 1] ?? 0);
      starts.push(p);
    }
  }
  return starts;
}

/** Düzlem facing>0 ? start+t : start; createPanelFromVirtualFace −normal yönünde t uzar → levha daima [start, start+t]. */
function memberVfGeometry(
  axis: number, cavity: CavityBox, start: number, t: number, section?: Pt2[] | null, facing: 1 | -1 = 1,
): { normal: Vec3; vertices: Vec3[]; center: Vec3 } {
  const [b, c] = [0, 1, 2].filter(a => a !== axis);
  const plane = facing > 0 ? start + t : start;
  const mk = (vb: number, vc: number): Vec3 => { const p: Vec3 = [0, 0, 0]; p[axis] = plane; p[b] = vb; p[c] = vc; return p; };
  const [b0, b1, c0, c1] = [cavity.min[b], cavity.max[b], cavity.min[c], cavity.max[c]];
  const poly: Pt2[] = section && section.length >= 3 ? section : [{ x: b0, y: c0 }, { x: b1, y: c0 }, { x: b1, y: c1 }, { x: b0, y: c1 }];
  const vertices = poly.map(q => mk(q.x, q.y));
  const normal: Vec3 = [0, 0, 0]; normal[axis] = facing;
  let cb = 0, cc = 0; for (const q of poly) { cb += q.x; cc += q.y; }
  const center = mk(cb / poly.length, cc / poly.length);
  return { normal, vertices, center };
}

interface GroupSolution {
  cavity: CavityBox; region: CavityBox[]; gaps: GapSpec[]; starts: number[]; sections: Array<Pt2[] | null>; seed: Vec3;
  cavityResolved?: Array<{ id: string; value: number }>;
}

/** Normalin baskın ekseni (eşitlikte küçük indeks). */
const maxAbsAxis = (n: Vec3) => { const a = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])]; return a.indexOf(Math.max(...a)); };
const stepFace = (st: CavityStep): { axis: number; side: 1 | -1 } => {
  const n = st.faceNormal, axis = maxAbsAxis(n);
  return { axis, side: n[axis] >= 0 ? 1 : -1 };
};

function refPlaneInParent(st: CavityStep, parent: Shape, shapes: Shape[]): { center: Vec3; normal: Vec3 } | null {
  if (!st.refShapeId) return null;
  const m = matchReferenceFace(shapeById(st.refShapeId, shapes), st.refFaceGroupIndex ?? -1, st.refNormalWorld, st.refPointWorld);
  if (!m) return null;
  const toParent = getShapeMatrix(parent).invert();
  const c = m.group.center.clone().applyMatrix4(m.matrix).applyMatrix4(toParent);
  const n = m.group.normal.clone().normalize().transformDirection(m.matrix).transformDirection(toParent).normalize();
  return { center: [c.x, c.y, c.z], normal: [n.x, n.y, n.z] };
}

/** Hacim adımları hücre düzeyinde: yalnız çıpanın düştüğü BAĞLANTILI sınır yüzü hareket eder (L'nin bir kolu).
 *  Büyüme ham hacmi aşamaz; küçülme 1 mm derinlik bırakır. */
interface StepFace { coord: number; cols: Set<string>; anchorCell: number }
function findStepFace(g: CavityGrid, cells: Set<number>, axis: number, side: 1 | -1, anchor: Vec3): StepFace | null {
  const [ua, va] = [0, 1, 2].filter(a => a !== axis);
  const pa = axisPlanes(g, axis), pu = axisPlanes(g, ua), pv = axisPlanes(g, va);
  type BF = { c: number; iu: number; iv: number; coord: number };
  const bfs: BF[] = [];
  for (const c of cells) {
    const ijk = cellIJK(g, c);
    const nb = [...ijk] as [number, number, number]; nb[axis] += side;
    const inside = nb[axis] >= 0 && nb[axis] < (axis === 0 ? g.nx : axis === 1 ? g.ny : g.nz) && cells.has(cellIndex(g, nb[0], nb[1], nb[2]));
    if (inside) continue;
    bfs.push({ c, iu: ijk[ua], iv: ijk[va], coord: side > 0 ? pa[ijk[axis] + 1] : pa[ijk[axis]] });
  }
  if (!bfs.length) return null;
  const dist = (f: BF) => {
    const du = Math.max(pu[f.iu] - anchor[ua], 0, anchor[ua] - pu[f.iu + 1]);
    const dv = Math.max(pv[f.iv] - anchor[va], 0, anchor[va] - pv[f.iv + 1]);
    return Math.hypot(du, dv) * 4 + Math.abs(f.coord - anchor[axis]);
  };
  const best = bfs.reduce((b, f) => (dist(f) < dist(b) ? f : b));
  const onPlane = new Map<string, BF>();
  for (const f of bfs) if (Math.abs(f.coord - best.coord) <= TOL) onPlane.set(`${f.iu},${f.iv}`, f);
  const cols = new Set<string>();
  const stack = [`${best.iu},${best.iv}`]; cols.add(stack[0]);
  while (stack.length) {
    const [iu, iv] = stack.pop()!.split(',').map(Number);
    for (const [a, b] of [[iu - 1, iv], [iu + 1, iv], [iu, iv - 1], [iu, iv + 1]]) {
      const k = `${a},${b}`;
      if (onPlane.has(k) && !cols.has(k)) { cols.add(k); stack.push(k); }
    }
  }
  return { coord: best.coord, cols, anchorCell: best.c };
}

function depthBehind(g: CavityGrid, cells: Set<number>, axis: number, side: 1 | -1, startCell: number): number {
  const pa = axisPlanes(g, axis);
  let depth = 0;
  const ijk = cellIJK(g, startCell);
  let c = startCell;
  while (cells.has(c)) {
    const i = cellIJK(g, c)[axis];
    depth += pa[i + 1] - pa[i];
    ijk[axis] -= side;
    if (ijk[axis] < 0 || ijk[axis] >= (axis === 0 ? g.nx : axis === 1 ? g.ny : g.nz)) break;
    c = cellIndex(g, ijk[0], ijk[1], ijk[2]);
  }
  return depth;
}

function applyCavityStepsToCells(
  g: CavityGrid, cellsIn: Set<number>, group: PanelGroup, parent: Shape, shapes: Shape[], body: CavityBox,
): { cells: Set<number>; planes: StepPlane[]; resolved: Array<{ id: string; value: number }> } {
  const steps = Array.isArray(group.cavitySteps) ? group.cavitySteps : [];
  const cells = new Set(cellsIn);
  const planes: StepPlane[] = [];
  const resolved: Array<{ id: string; value: number }> = [];
  for (const st of steps) {
    if (!cells.size) break;
    const { axis, side } = stepFace(st);
    const rb = regionBBox(g, cells);
    // Çıpa yoksa bölge kutusunun o yüzünün ortası.
    let anchor: Vec3;
    if (st.anchorFrac) anchor = pointFromFrac(body, st.anchorFrac);
    else { anchor = boxCenter(rb); anchor[axis] = side > 0 ? rb.max[axis] : rb.min[axis]; }
    // Yüz bulunamayan / referans düzlemi çözülemeyen ya da adım eksenine paralel olmayan adım atlanır.
    const face = findStepFace(g, cells, axis, side, anchor);
    if (!face) continue;
    const depth = depthBehind(g, cells, axis, side, face.anchorCell);
    let amount: number;
    if (st.refShapeId) {
      const pl = refPlaneInParent(st, parent, shapes);
      if (!pl || Math.abs(pl.normal[axis]) < 0.7) continue;
      amount = (pl.center[axis] - face.coord) * side;
    } else if (st.isFixed) amount = st.value - depth;
    else amount = st.value;
    if (amount > 1e-6) amount = 0;   // büyüme ham hacmi aşamaz
    if (depth + amount < 1) amount = 1 - depth;   // küçülme 1 mm derinlik bırakır
    if (st.refShapeId) resolved.push({ id: st.id, value: r1(amount) });
    if (Math.abs(amount) < 0.01) continue;
    const target = r1(face.coord + side * amount);
    planes.push({ axis, coord: target });
    // Dilimi kesen hücre 2. geçişte tam bölünür; burada yalnız tam düşenler çıkar.
    const lo = Math.min(target, face.coord), hi = Math.max(target, face.coord);
    const [ua, va] = [0, 1, 2].filter(a => a !== axis);
    for (const c of Array.from(cells)) {
      const ijk = cellIJK(g, c);
      if (!face.cols.has(`${ijk[ua]},${ijk[va]}`)) continue;
      const cb = cellBox(g, c);
      if (cb.min[axis] >= lo - TOL && cb.max[axis] <= hi + TOL) cells.delete(c);
    }
  }
  return { cells, planes, resolved };
}

interface ObstacleSet { obstacles: CavityBox[]; splitBoxes: CavityBox[]; tiltFaces: TiltFace[] }

/** Düz paneller kutu engeli; eğik paneller yalnız bölme düzlemi (splitBoxes) + yarım-uzay (tiltFaces).
 *  Kapak hiç engel değildir; arkalık yalnız `backBox` bir kutu verirse (çakma kenarındaki / geçtiği levhayı kısaltır — BackService). */
export function collectObstacles(
  parent: Shape, panels: Shape[], include: (p: Shape) => boolean = () => true, backBox: (p: Shape) => CavityBox | null = () => null,
): ObstacleSet {
  const obstacles: CavityBox[] = [], splitBoxes: CavityBox[] = [];
  const tilted: Shape[] = [];
  for (const p of panels) {
    if (p.type !== 'panel' || (p.parameters as any)?.parentShapeId !== parent.id) continue;
    if ((p.parameters as any)?.doorGroupId) continue;
    if ((p.parameters as any)?.backGroupId) { const bb = backBox(p); if (bb) obstacles.push(bb); continue; }
    if (!include(p)) continue;
    const b = panelLocalBox(p, parent);
    if (!b) continue;
    if (panelHasRotation(p)) { splitBoxes.push(b); tilted.push(p); } else obstacles.push(b);
  }
  return { obstacles, splitBoxes, tiltFaces: tiltedPanelFaces(parent, tilted) };
}

/** Grubun VF sırası = en küçük üye indeksi (üye yoksa ∞: mevcut her panel önce). */
const groupVfIndex = (group: PanelGroup, vfIdx: Map<string, number>): number => {
  let best = Infinity;
  for (const id of group.memberVfIds) { const i = vfIdx.get(id); if (i != null && i < best) best = i; }
  return best;
};

/** Hacmi SINIRLAYAN panel yüklemi (çözüm, yeniden seçim ve x-ray aynı kuralı okur): VF sırasında üyelerden ÖNCE gelen gövde
 *  paneli sınırlar, SONRA gelen sınırlamaz (grup basar); başka grup yalnız daha önce oluşturulmuşsa. VF'siz panel sınırlar. */
export function groupBoundsPanelPredicate(
  group: PanelGroup, groups: PanelGroup[], vfs: VirtualFace[] = useAppStore.getState().virtualFaces,
): (p: Shape) => boolean {
  const byId = new Map(groups.map(g => [g.id, g] as const));
  const vfIdx = new Map(vfs.map((f, i) => [f.id, i] as const));
  const myIdx = groupVfIndex(group, vfIdx);
  return (p: Shape) => {
    const gid = (p.parameters as any)?.panelGroupId as string | undefined;
    if (!gid) {
      const pi = vfIdx.get((p.parameters as any)?.virtualFaceId);
      return pi == null || pi < myIdx;
    }
    if (gid === group.id) return false;
    const g = byId.get(gid);
    return !!g && g.createdAt < group.createdAt;
  };
}

function groupObstacles(group: PanelGroup, parent: Shape, panels: Shape[], groups: PanelGroup[]): ObstacleSet {
  const bounds = groupBoundsPanelPredicate(group, groups, useAppStore.getState().virtualFaces);
  // Arkalık VF sırasından bağımsız kısaltır: kural anlamsaldır (çakma kenar / geçilen arkalık-sınırı üye), bkz. BackService.
  return collectObstacles(parent, panels, p => bounds(p), p => backObstacleFor(group, p));
}

/** Yeniden seçim ızgarası çözümle AYNI engel kümesiyle kurulur → grubun şu anki yeri de aday olur. */
export function repickObstacles(group: PanelGroup, parent: Shape, panels: Shape[]): ObstacleSet {
  return groupObstacles(group, parent, panels, useAppStore.getState().panelGroups);
}
export const gridForObstacles = (parent: Shape, o: ObstacleSet, extraPlanes: StepPlane[] = []) =>
  buildCavityGrid(parent, o.obstacles, o.splitBoxes, o.tiltFaces, extraPlanes);
/** Nokta kutunun içinde mi (sınırlar hariç). */
const strictlyInside = (c: Vec3, b: CavityBox) =>
  c[0] > b.min[0] && c[0] < b.max[0] && c[1] > b.min[1] && c[1] < b.max[1] && c[2] > b.min[2] && c[2] < b.max[2];

export function boxesSurface(boxes: CavityBox[]): number[] {
  if (!boxes.length) return [];
  const px: number[] = [], py: number[] = [], pz: number[] = [];
  const body: CavityBox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const b of boxes) for (let a = 0; a < 3; a++) { body.min[a] = Math.min(body.min[a], b.min[a]); body.max[a] = Math.max(body.max[a], b.max[a]); }
  for (const b of boxes) { px.push(b.min[0], b.max[0]); py.push(b.min[1], b.max[1]); pz.push(b.min[2], b.max[2]); }
  const xs = uniqSorted(px, body.min[0], body.max[0]), ys = uniqSorted(py, body.min[1], body.max[1]), zs = uniqSorted(pz, body.min[2], body.max[2]);
  const nx = xs.length - 1, ny = ys.length - 1, nz = zs.length - 1;
  const g: CavityGrid = { body, xs, ys, zs, nx, ny, nz, free: new Uint8Array(nx * ny * nz) };
  const cells = new Set<number>();
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c: Vec3 = [(xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2, (zs[k] + zs[k + 1]) / 2];
    if (boxes.some(b => strictlyInside(c, b))) cells.add(cellIndex(g, i, j, k));
  }
  return regionSurface(g, cells);
}

const anchorPoint = (group: PanelGroup, body: CavityBox): Vec3 => pointFromFrac(body, group.anchorFrac);

function solveGroup(group: PanelGroup, parent: Shape, panels: Shape[], groups: PanelGroup[]): GroupSolution | null {
  const oset = groupObstacles(group, parent, panels, groups);
  const ts = memberThicknessesOf(group);
  const tMax = ts.length ? Math.max(...ts) : group.thickness;
  const hasSteps = !!group.cavitySteps?.length;

  const solveCells = (extra: StepPlane[]) => {
    const grid = gridForObstacles(parent, oset, extra);
    if (!grid) return null;
    let seed = anchorPoint(group, grid.body);
    let c = cellOfPoint(grid, seed);
    if (c < 0 || !grid.free[c]) {
      c = nearestFreeCell(grid, seed);
      if (c >= 0) { const b = cellBox(grid, c); seed = boxCenter(b); }
    }
    // Eğik panel VF sırasında üyelerden ÖNCE ise (basan) uç uzak yüze uzatılır (motor pahlar), sonra ise yakın yüze.
    const planes = orientTiltPlanes(grid.tiltFaces, seed);
    if (planes.length) {
      const vfIdx = new Map(useAppStore.getState().virtualFaces.map((f, i) => [f.id, i] as const));
      const memberIdx = group.memberVfIds.length ? (vfIdx.get(group.memberVfIds[0]) ?? Infinity) : Infinity;
      for (const pl of planes) { const pi = pl.vfId ? vfIdx.get(pl.vfId) : undefined; pl.bevel = pi != null && pi < memberIdx; }
    }
    const allow = planes.length ? (cc: number) => cellInsideTiltPlanes(planes, cellBox(grid, cc)) : undefined;
    let cells = c >= 0 ? floodRegion(grid, c, allow) : new Set<number>();
    if (group.boxMode && cells.size && c >= 0) {
      const bf = group.boxFrac;
      const want = bf ? { min: pointFromFrac(grid.body, bf.min), max: pointFromFrac(grid.body, bf.max) } : cloneBox(group.cavity);
      const iou = (a: CavityBox, b: CavityBox) => {
        let inter = 1, va = 1, vb = 1;
        for (let x = 0; x < 3; x++) {
          inter *= Math.max(0, Math.min(a.max[x], b.max[x]) - Math.max(a.min[x], b.min[x]));
          va *= boxSpan(a, x); vb *= boxSpan(b, x);
        }
        return inter / Math.max(va + vb - inter, 1e-6);
      };
      // Kayıtlı kutu çıpayı içermeyebilir → tohum onun merkez hücresi (bölge dışındaysa çıpa hücresi).
      const wc = cellOfPoint(grid, boxCenter(want));
      const boxes = boxAlternatives(grid, cells, [wc >= 0 && cells.has(wc) ? wc : c]);
      if (boxes.length) {
        const best = boxes.reduce((b, x) => (iou(x.bbox, want) > iou(b.bbox, want) ? x : b));
        cells = best.cells;
      }
    }
    return { grid, seed, planes, cells };
  };
  let R = solveCells([]);
  if (!R) return null;
  let cavityResolved: Array<{ id: string; value: number }> | undefined;
  if (hasSteps && R.cells.size) {
    let st = applyCavityStepsToCells(R.grid, R.cells, group, parent, panels, R.grid.body);
    const missing = st.planes.filter(pl => !hasPlane(R!.grid, pl));
    if (missing.length) {
      const R2 = solveCells(st.planes);
      if (R2) { R = R2; st = applyCavityStepsToCells(R.grid, R.cells, group, parent, panels, R.grid.body); }
    }
    R = { ...R, cells: st.cells };
    cavityResolved = st.resolved;
  }
  const { grid, seed, planes, cells } = R;
  let cavity = cells.size ? clippedRegionBBox(grid, cells, planes) : cloneBox(group.cavity);
  let region = cells.size ? regionBoxes(grid, cells) : (group.region || [cloneBox(group.cavity)]);
  const minOk = cells.size > 0 && [0, 1, 2].every(a => boxSpan(cavity, a) >= (a === group.axis ? sumT(ts) : tMax));
  if (!minOk) {
    // Hacim bozuk / çok küçük: önceki hacim korunur.
    cavity = cloneBox(group.cavity);
    region = group.region || [cloneBox(cavity)];
  }
  const L = boxSpan(cavity, group.axis);
  let gaps = rescaleGaps(group.gaps, L, group.count, ts);
  // Kapak derzine bağ: bağlı üyenin boşluğu derzden yazılır, kalanlar katsayı kuralıyla. Derz yoksa / eksen uyuşmuyorsa / derz
  // hacmin dışındaysa bağ bu çözümde yok sayılır (bayat bağı syncPanelGroups düşürür).
  if (group.doorBond) {
    const bj = doorJointForBond(group.doorBond, parent, panels);
    const m = Math.min(Math.max(0, group.doorBond.member ?? 0), group.count - 1);
    if (bj && bj.axis === group.axis && m >= 0) {
      const want = bj.panelMin(ts[m]);
      const prefix = gaps.slice(0, m).reduce((a, g, i) => a + g.value + ts[i], 0);
      const gm = groupFacing(group) > 0 ? want - cavity.min[group.axis] - prefix : cavity.max[group.axis] - want - ts[m] - prefix;
      if (gm >= -0.05) gaps = applyGapEditProportional(gaps, m, Math.max(0, gm), L, group.count, ts, { force: true });
    }
  }
  const starts = panelStarts(cavity, group.axis, groupFacing(group), gaps, ts);
  const sections = starts.map((s, i) => {
    if (!minOk) return null;
    const t = ts[i];
    const poly = sectionPolygon(grid, cells, group.axis, s, s + t, seed);
    if (!poly || !planes.length) return poly;
    const clipped = clipSectionByPlanes(poly, group.axis, s, s + t, planes);
    return clipped.length >= 3 ? clipped : poly;
  });
  return { cavity, region, gaps, starts, sections, seed, cavityResolved };
}

/** Yalnız geometri alanları yazılır; kullanıcı alanlarına dokunulmaz. */
function interiorVfPatch(vf: VirtualFace, group: PanelGroup, sol: GroupSolution): Partial<VirtualFace> | null {
  const i = vf.groupIndex ?? group.memberVfIds.indexOf(vf.id);
  if (i < 0 || i >= sol.starts.length) return null;
  const g = memberGeometry(group, sol, i);
  return { normal: g.normal, vertices: g.vertices, center: g.center, regionAnchor: g.center } as any;
}
const memberGeometry = (group: PanelGroup, sol: GroupSolution, i: number) =>
  memberVfGeometry(group.axis, sol.cavity, sol.starts[i], memberThicknessesOf(group)[i], sol.sections[i], groupFacing(group));
/** Üye VF'lerinin geometrisi çözümden (st = çağıranın store anlık görüntüsü). */
function patchMemberVfs(st: ReturnType<typeof useAppStore.getState>, group: PanelGroup, next: PanelGroup, sol: GroupSolution): void {
  for (const vfId of group.memberVfIds) {
    const vf = st.virtualFaces.find(f => f.id === vfId);
    if (!vf) continue;
    const p = interiorVfPatch(vf, next, sol);
    if (p) st.updateVirtualFace(vf.id, p);
  }
}

/** Regen kancası (VirtualFaceUpdateService): iç VF'ler yüz eşlemesi olmadan grup çözümüyle yeniden yazılır. */
export function recalculateInteriorVfs(parent: Shape, vfs: VirtualFace[], panels: Shape[], groups: PanelGroup[]): Map<string, VirtualFace> {
  const out = new Map<string, VirtualFace>();
  const mine = groups.filter(g => g.shapeId === parent.id);
  for (const g of mine) {
    const sol = solveGroup(g, parent, panels, groups);
    if (!sol) continue;
    for (const vf of vfs) {
      if (vf.shapeId !== parent.id || vf.groupId !== g.id) continue;
      const patch = interiorVfPatch(vf, g, sol);
      if (patch) out.set(vf.id, { ...vf, ...patch });
    }
  }
  return out;
}

const groupById = (id: string) => useAppStore.getState().panelGroups.find(g => g.id === id);

const fallbackSolution = (group: PanelGroup, gaps: GapSpec[], count: number, seed: Vec3): GroupSolution => ({
  cavity: group.cavity, region: group.region || [group.cavity], gaps,
  starts: panelStarts(group.cavity, group.axis, groupFacing(group), gaps, memberThicknessesOf(group, count)), sections: Array(count).fill(null), seed,
});

function removeMembers(vfIds: string[]): void {
  const st = useAppStore.getState();
  for (const vfId of vfIds) {
    const p = panelOfVf(vfId, st.shapes);
    if (p) st.deleteShape(p.id);
    st.deleteVirtualFace(vfId);
    if (st.selectedPanelRow === `vf-${vfId}`) st.setSelectedPanelRow(null);
  }
}

function makeMemberVf(group: PanelGroup, i: number, sol: GroupSolution): VirtualFace {
  const g = memberGeometry(group, sol, i);
  return {
    id: genId('vf-int'), shapeId: group.shapeId,
    normal: g.normal, center: g.center, vertices: g.vertices,
    description: groupName(group), hasPanel: false,
    parentFaceShape: false, interior: true, groupId: group.id, groupIndex: i,
    ...({ regionAnchor: g.center } as any),
  };
}

function solveFromStore(group: PanelGroup): GroupSolution | null {
  const st = useAppStore.getState();
  const parent = shapeById(group.shapeId, st.shapes);
  if (!parent) return null;
  return solveGroup(group, parent, st.shapes, st.panelGroups.some(g => g.id === group.id) ? st.panelGroups : [...st.panelGroups, group]);
}

/** Düz-mod kutusu gövde kesri olarak (gövde boyutlanınca izler). */
const boxFracOf = (body: CavityBox, bbox: CavityBox) => ({ min: fracInCavity(body, bbox.min), max: fracInCavity(body, bbox.max) });

/** Grup + ilk üye VF; grup bilerek SEÇİLMEZ / kartı açılmaz. `extra` (ör. doorBond) çözümden önce eklenir. */
export function createPanelGroupFromCavity(
  shapeId: string, kind: PanelGroup['kind'], pick: CavityPick, name?: string, extra: Partial<PanelGroup> = {},
): PanelGroup | null {
  const st = useAppStore.getState();
  const parent = shapeById(shapeId, st.shapes);
  if (!parent) return null;
  const body = bodyLocalBox(parent);
  if (!body) return null;
  const axisOk = kind === 'shelf' ? pick.axis === 1 : (pick.axis === 0 || pick.axis === 2);
  const axis: 0 | 1 | 2 = axisOk ? pick.axis : groupAxisOf(kind);
  const t = GROUP_PANEL_THICKNESS;
  const count = 1;
  const L = boxSpan(pick.bbox, axis);
  const facing: 1 | -1 = axisOk && pick.facing === -1 ? -1 : 1;
  const arrow = pick.arrow ? { ...pick.arrow } : { axis, facing };
  const group: PanelGroup = {
    id: genId(kind === 'shelf' ? 'shelf' : 'divider'), shapeId, kind, axis, facing, arrow, anchorFrac: fracInCavity(body, pick.seed, true),
    name: name?.trim() || groupKindLabel(kind), cavity: cloneBox(pick.bbox), region: pick.boxes.map(cloneBox), count,
    gaps: equalGaps(L, count, [t]), thickness: t, memberThicknesses: [t], memberVfIds: [], createdAt: Date.now(),
    ...(pick.shape === 'box' ? { boxMode: true, boxFrac: boxFracOf(body, pick.bbox) } : {}),
    ...extra,
  };
  const sol = solveFromStore(group) || fallbackSolution(group, group.gaps, count, pick.seed);
  group.gaps = sol.gaps;
  const vfs = Array.from({ length: count }, (_, i) => makeMemberVf(group, i, sol));
  group.memberVfIds = vfs.map(v => v.id);
  st.addPanelGroup(group);
  st.insertVirtualFacesAfter(null, vfs);
  return group;
}

// YENİDEN HACİM SEÇİMİ: ızgara yalnız gruptan önceki panellerle (repickObstacles). Taşımada adet, kalınlıklar, ad ve
// VF SIRASI korunur; boşluklar aynı eksende ölçeklenir, eksen değişince eşitlenir; hacim adımları eski hacme ait → düşer.

export function startGroupRepick(groupId: string): void {
  const st = useAppStore.getState();
  const group = groupById(groupId);
  if (!group) return;
  if (st.faceExtrudeMode) { st.setFaceExtrudeSelectedFace(null); st.setFaceExtrudeRefCandidate(null); st.setFaceExtrudeMode(false); }
  if (st.panelMoveMode) st.setPanelMoveMode(false);
  if (st.panelRotateMode) st.setPanelRotateMode(false);
  if (st.selectedShapeId !== group.shapeId) st.selectShape(group.shapeId);
  st.setSelectedPanelGroupId(groupId);
  st.setVolumePickMode(group.kind, groupId);
}

export async function relocatePanelGroup(groupId: string, pick: CavityPick): Promise<boolean> {
  const st = useAppStore.getState();
  const group = groupById(groupId);
  const parent = group ? shapeById(group.shapeId, st.shapes) : null;
  const body = parent ? bodyLocalBox(parent) : null;
  if (!group || !parent || !body) return false;
  const axisOk = group.kind === 'shelf' ? pick.axis === 1 : (pick.axis === 0 || pick.axis === 2);
  const axis: 0 | 1 | 2 = axisOk ? pick.axis : group.axis;
  const facing: 1 | -1 = axisOk ? pick.facing : groupFacing(group);
  const arrow = pick.arrow ? { ...pick.arrow } : { axis, facing };
  const ts = memberThicknessesOf(group);
  const L = boxSpan(pick.bbox, axis);
  const gaps = axis === group.axis ? rescaleGaps(group.gaps, L, group.count, ts) : equalGaps(L, group.count, ts);
  const patch: Partial<PanelGroup> = {
    axis, facing, arrow, anchorFrac: fracInCavity(body, pick.seed, true), cavity: cloneBox(pick.bbox), region: pick.boxes.map(cloneBox),
    gaps, cavitySteps: undefined, boxMode: pick.shape === 'box', boxFrac: pick.shape === 'box' ? boxFracOf(body, pick.bbox) : undefined,
    doorBond: undefined,
  };
  const next: PanelGroup = { ...group, ...patch };
  const sol = solveFromStore(next) || fallbackSolution(next, gaps, group.count, pick.seed);
  patchMemberVfs(st, group, next, sol);
  st.updatePanelGroup(groupId, { ...patch, gaps: sol.gaps });
  await requestRebuild(group.shapeId);
  return true;
}

export function confirmVolumePick(shapeId: string, kind: PanelGroup['kind'], pick: CavityPick): void {
  const st = useAppStore.getState();
  const gid = st.volumePickGroupId;
  if (gid) void relocatePanelGroup(gid, pick);
  else createPanelGroupFromCavity(shapeId, kind, pick, st.placementName);
  st.setVolumePickMode(null);
}

// HEDEF ARALIK → ADET: her rebuild sonrası (syncPanelGroups) yeniden türetilir; gövde büyüyünce üye eklenir, küçülünce silinir.
export const MAX_GROUP_COUNT = 40;

/** Eşit boşluğu `target`a en yakın yapan adet; eşitlikte az üye tercih edilir. */
export function countForTargetGap(group: Pick<PanelGroup, 'count' | 'thickness' | 'memberThicknesses'>, L: number, target: number): number {
  let best = 1, bestErr = Infinity;
  for (let n = 1; n <= MAX_GROUP_COUNT; n++) {
    const ts = memberThicknessesOf(group, n);
    const gap = (L - sumT(ts)) / (n + 1);
    if (gap < MIN_GAP && n > 1) break;
    const err = Math.abs(gap - target);
    if (err < bestErr - 1e-9) { best = n; bestErr = err; }
  }
  return best;
}

/** null/0 = kapat; kapatınca mevcut adet/boşluklar kalır, yalnız otomatik güncelleme durur. */
export async function setGroupTargetGap(groupId: string, target: number | null): Promise<void> {
  const group = groupById(groupId);
  if (!group) return;
  const v = target != null && Number.isFinite(target) && target > 0 ? r1(target) : undefined;
  useAppStore.getState().updatePanelGroup(groupId, { targetGap: v });
  if (v == null) return;
  const n = countForTargetGap(group, boxSpan(group.cavity, group.axis), v);
  if (n !== group.count) await setGroupCount(groupId, n, { keepTargetGap: true });
  else await equalizeGroupGaps(groupId, { keepTargetGap: true });
}

/** Elle adet girişi hedef aralığı KAPATIR; otomatik çağrılar keepTargetGap ile korur. Rebuild'i App izleyicisi tetikler. */
export async function setGroupCount(groupId: string, count: number, opts: { keepTargetGap?: boolean } = {}): Promise<void> {
  const st = useAppStore.getState();
  const group = groupById(groupId);
  if (!group) return;
  // En az 1: grup üyesiz kalmamalı.
  const n = Math.max(1, Math.min(MAX_GROUP_COUNT, Math.round(count)));
  if (!opts.keepTargetGap && group.targetGap != null) st.updatePanelGroup(groupId, { targetGap: undefined });
  if (n === group.count) return;
  const memberThicknesses = memberThicknessesOf(group, n);
  const gaps = equalGaps(boxSpan(group.cavity, group.axis), n, memberThicknesses);
  let memberVfIds = group.memberVfIds.slice();
  if (n < group.count) { removeMembers(memberVfIds.slice(n)); memberVfIds = memberVfIds.slice(0, n); }
  const next: PanelGroup = { ...group, count: n, gaps, memberVfIds, memberThicknesses };
  const sol = solveFromStore(next) || fallbackSolution(group, gaps, n, anchorPoint(group, group.cavity));
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
  st.updatePanelGroup(groupId, { count: n, gaps: sol.gaps, memberVfIds: next.memberVfIds, memberThicknesses });
}

function writeGroupGaps(group: PanelGroup, gaps: GapSpec[], extra: Partial<PanelGroup> = {}): void {
  groupEditBase = null;   // onaylı yazım: oran tabanı düşer
  const st = useAppStore.getState();
  const next = { ...group, ...extra, gaps };
  const sol = solveFromStore(next) || fallbackSolution(next, gaps, group.count, anchorPoint(group, group.cavity));
  patchMemberVfs(st, group, next, sol);
  st.updatePanelGroup(group.id, { ...extra, gaps: sol.gaps });
}

/** Üye kalınlığı sınırı: en az 1 mm, diğer üyeler ve her boşluğa 1 mm kalacak kadar. */
const clampMemberThickness = (group: PanelGroup, ts: number[], i: number, value: number, L: number) =>
  r1(Math.max(1, Math.min(value, Math.max(1, L - (sumT(ts) - ts[i]) - group.count - 1))));

/** Üye kalınlığı; panelin `panelThickness`ı da yazılmalı (motor ve damga/şerit sınıfı onu okur). */
export async function setGroupMemberThickness(groupId: string, i: number, value: number): Promise<void> {
  const group = groupById(groupId);
  if (!group || i < 0 || i >= group.count || !Number.isFinite(value)) return;
  const L = boxSpan(group.cavity, group.axis);
  const ts = memberThicknessesOf(group);
  const v = clampMemberThickness(group, ts, i, value, L);
  // Önizleme kalınlığı gruba zaten yazdı: onay yalnız panel parametresi de aynıysa atlanır.
  const panelNow = panelOfVf(group.memberVfIds[i], useAppStore.getState().shapes);
  const panelT = parseFloat(panelNow?.parameters?.panelThickness) || ts[i];
  if (Math.abs(v - ts[i]) < 0.05 && Math.abs(panelT - v) < 0.05) { groupEditBase = null; return; }
  ts[i] = v;
  const gaps = rescaleGaps(group.gaps, L, group.count, ts);
  writeGroupGaps(group, gaps, { memberThicknesses: ts });
  setMemberPanelThickness([group.memberVfIds[i]], v);
  await requestRebuild(group.shapeId);
}

/** Canlı önizleme: her tuşta yalnız STORE'a yazılır (VF / rebuild yok); Esc → groupLayoutSnapshot kaydı geri yüklenir. */
export interface GroupLayoutSnap { gaps: GapSpec[]; memberThicknesses?: number[]; targetGap?: number }
/** Oran tabanı: düzenleme başındaki boşluklar (önizleme oranları kaymasın). */
let groupEditBase: { groupId: string; count: number; gaps: GapSpec[] } | null = null;
const editBaseOf = (group: PanelGroup) =>
  (groupEditBase?.groupId === group.id && groupEditBase.count === group.count ? groupEditBase.gaps : undefined);
/** k. boşluk girilince yeni boşluklar (oran tabanı = düzenleme başı). */
const editedGaps = (group: PanelGroup, k: number, value: number) =>
  applyGapEditProportional(group.gaps, k, value, boxSpan(group.cavity, group.axis), group.count, memberThicknessesOf(group), { base: editBaseOf(group) });
export function groupLayoutSnapshot(groupId: string): GroupLayoutSnap | null {
  const g = groupById(groupId);
  groupEditBase = g ? { groupId, count: g.count, gaps: g.gaps.map(x => ({ ...x })) } : null;
  return g ? { gaps: g.gaps.map(x => ({ ...x })), memberThicknesses: g.memberThicknesses?.slice(), targetGap: g.targetGap } : null;
}
export function restoreGroupLayout(groupId: string, snap: GroupLayoutSnap | null | undefined): void {
  groupEditBase = null;
  if (!snap || !groupById(groupId)) return;
  const gaps = snap.gaps.map(x => ({ ...x }));
  useAppStore.getState().updatePanelGroup(groupId, { gaps, memberThicknesses: snap.memberThicknesses?.slice(), targetGap: snap.targetGap });
}
export function previewGroupGap(groupId: string, k: number, value: number): void {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value) || value < 0) return;
  if (passiveGapIndex(group.gaps, group.count + 1) === k) return;
  useAppStore.getState().updatePanelGroup(groupId, { gaps: editedGaps(group, k, value) });
}
export function previewGroupMemberThickness(groupId: string, i: number, value: number): void {
  const group = groupById(groupId);
  if (!group || i < 0 || i >= group.count || !Number.isFinite(value) || value <= 0) return;
  const L = boxSpan(group.cavity, group.axis);
  const ts = memberThicknessesOf(group);
  ts[i] = clampMemberThickness(group, ts, i, value, L);
  useAppStore.getState().updatePanelGroup(groupId, { memberThicknesses: ts, gaps: rescaleGaps(group.gaps, L, group.count, ts) });
}

/** Elle boşluk girişi hedef aralığı kapatır; pasif boşluk (kalanı toplar) girilemez. */
export async function editGroupGap(groupId: string, k: number, value: number): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value)) return;
  if (passiveGapIndex(group.gaps, group.count + 1) === k) { groupEditBase = null; return; }
  const gaps = editedGaps(group, k, value);
  // Derze bağlı üyenin yan boşluğu girilince LEVHA değil KAPAK DERZİ taşınır (levha rebuild'de derzi izler).
  // Derz taşınamıyorsa girilen değer kazanır: bağ çözülür (levha kapağı artık izlemez).
  let extra: Partial<PanelGroup> = group.targetGap != null ? { targetGap: undefined } : {};
  if (group.doorBond) {
    const m = Math.min(Math.max(0, group.doorBond.member ?? 0), group.count - 1);
    if (k === m || k === m + 1) {
      const st = useAppStore.getState();
      const parent = shapeById(group.shapeId, st.shapes);
      const bj = parent ? doorJointForBond(group.doorBond, parent, st.shapes) : null;
      if (bj && bj.axis === group.axis) {
        const ts = memberThicknessesOf(group);
        const s = panelStarts(group.cavity, group.axis, groupFacing(group), gaps, ts)[m];
        const center = jointCenter(s, s + ts[m], bj.p1 - bj.p0, group.doorBond.align);
        if (await moveDoorJointTo(group.doorBond.doorGroupId, group.doorBond.splitId, group.doorBond.k, center)) return;
        extra = { ...extra, doorBond: undefined };
      }
    }
  }
  writeGroupGaps(group, gaps, extra);
  await requestRebuild(group.shapeId);
}

// HACİM DÜZENLEME: panel yüz extrude akışıyla birebir; adım gruba yazılır, çözücü ham hacme uygular.

export function startCavityEdit(groupId: string): void {
  const st = useAppStore.getState();
  if (st.panelMoveMode) st.setPanelMoveMode(false);
  if (st.panelRotateMode) st.setPanelRotateMode(false);
  st.setFaceExtrudeMode(true);
  st.setFaceExtrudeCavityGroupId(groupId);
}

async function commitCavitySteps(group: PanelGroup, steps: CavityStep[]): Promise<void> {
  useAppStore.getState().updatePanelGroup(group.id, { cavitySteps: steps });
  await requestRebuild(group.shapeId);
}

/** Baskın eksene yuvarlanmış birim normal. */
function axisNormal(n: Vec3): Vec3 {
  const i = maxAbsAxis(n), o: Vec3 = [0, 0, 0];
  o[i] = n[i] >= 0 ? 1 : -1;
  return o;
}
const axisLabelOf = (n: Vec3) => dominantAxisLabel({ x: n[0], y: n[1], z: n[2] });

function stepAnchorFrac(group: PanelGroup, anchor?: Vec3 | null): Vec3 | undefined {
  if (!anchor) return undefined;
  const parent = shapeById(group.shapeId);
  const body = parent ? bodyLocalBox(parent) : null;
  return body ? fracInCavity(body, anchor, true) : undefined;
}

function upsertCavityStepAt(steps: CavityStep[], step: CavityStep): CavityStep[] {
  const f = stepFace(step);
  const near = (a?: Vec3, b?: Vec3) => !a || !b || Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 0.15;
  const idx = steps.findIndex(s => { const g = stepFace(s); return g.axis === f.axis && g.side === f.side && near(s.anchorFrac, step.anchorFrac); });
  return idx >= 0 ? steps.map((s, i) => (i === idx ? step : s)) : [...steps, step];
}

export async function executeCavityExtrude(groupId: string, faceNormal: Vec3, value: number, isFixed: boolean, anchor?: Vec3 | null): Promise<boolean> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value)) return false;
  const n = axisNormal(faceNormal);
  const step: CavityStep = {
    id: genId('cav'), faceNormal: n, axisLabel: axisLabelOf(n), value, isFixed, timestamp: Date.now(), anchorFrac: stepAnchorFrac(group, anchor),
  };
  const existing = group.cavitySteps || [];
  const next = upsertCavityStepAt(existing, step);
  if (!isFixed && Math.abs(value) < 0.01 && next.length === existing.length + 1) return false;
  await commitCavitySteps(group, next);
  return true;
}

export async function executeCavityExtrudeToReference(groupId: string, faceNormal: Vec3, ref: RefFacePick, anchor?: Vec3 | null): Promise<boolean> {
  const group = groupById(groupId);
  if (!group) return false;
  const n = axisNormal(faceNormal);
  const step: CavityStep = {
    id: genId('cav'), faceNormal: n, axisLabel: axisLabelOf(n), value: 0, isFixed: true, timestamp: Date.now(),
    refShapeId: ref.panelId, refFaceGroupIndex: ref.faceGroupIndex, refNormalWorld: ref.normalWorld, refPointWorld: ref.pointWorld,
    anchorFrac: stepAnchorFrac(group, anchor),
  };
  await commitCavitySteps(group, upsertCavityStepAt(group.cavitySteps || [], step));
  return true;
}

export async function confirmRefCavityExtrude(): Promise<void> {
  const st = useAppStore.getState();
  const gid = st.faceExtrudeCavityGroupId, cand = st.faceExtrudeRefCandidate, n = st.faceExtrudeCavityFaceNormal;
  if (!gid || !cand || cand.faceGroupIndex < 0 || !n) return;
  await executeCavityExtrudeToReference(gid, n, cand, st.faceExtrudeClickPoint);
  st.setFaceExtrudeSelectedFace(null);
  st.setFaceExtrudeMode(false);
  st.setFaceExtrudeRefCandidate(null);
}

export function updateCavityStep(groupId: string, stepId: string, value: number): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value)) return Promise.resolve();
  return commitCavitySteps(group, (group.cavitySteps || []).map(s => (s.id === stepId ? { ...s, value } : s)));
}

export function deleteCavityStep(groupId: string, stepId: string): Promise<void> {
  const group = groupById(groupId);
  if (!group) return Promise.resolve();
  return commitCavitySteps(group, (group.cavitySteps || []).filter(s => s.id !== stepId));
}

/** Rozet: açık → pin → kilitli (GapMode); değer değişmez → rebuild yok. Son açık boşluk (pasif) pinlenemez / kilitlenemez. */
export function toggleGroupGapLock(groupId: string, k: number): void {
  const group = groupById(groupId);
  if (!group || k < 0 || k >= group.gaps.length) return;
  const gaps = cycleGapMode(group.gaps, k, group.count + 1);
  if (!gaps) return;
  useAppStore.getState().updatePanelGroup(groupId, { gaps });
}

export async function equalizeGroupGaps(groupId: string, _opts: { keepTargetGap?: boolean } = {}): Promise<void> {
  const group = groupById(groupId);
  if (!group) return;
  writeGroupGaps(group, equalGaps(boxSpan(group.cavity, group.axis), group.count, memberThicknessesOf(group)));
  await requestRebuild(group.shapeId);
}

export const groupName = (g: Pick<PanelGroup, 'name' | 'kind'>) => (g.name ?? groupKindLabel(g.kind));

export function renamePanelGroup(groupId: string, name: string): void {
  const group = groupById(groupId);
  if (!group) return;
  useAppStore.getState().updatePanelGroup(groupId, { name });
  renameMemberVfs(group.memberVfIds, name);
}

export function deletePanelGroupWithMembers(groupId: string): void {
  const group = groupById(groupId);
  if (!group) return;
  removeMembers(group.memberVfIds);
  useAppStore.getState().deletePanelGroup(groupId);
}

const boxKey = (b: CavityBox) => [...b.min, ...b.max].map(n => Math.round(n)).join('|');

export function syncPanelGroups(parentShapeId: string): void {
  const st = useAppStore.getState();
  const parent = shapeById(parentShapeId, st.shapes);
  if (!parent) return;
  const mine = st.panelGroups.filter(g => g.shapeId === parentShapeId);
  for (const g of mine) {
    // Kapak derzi kalmadıysa bağ düşer.
    if (g.doorBond && !doorJointForBond(g.doorBond, parent, st.shapes)) st.updatePanelGroup(g.id, { doorBond: undefined });
    const sol = solveGroup(g, parent, st.shapes, st.panelGroups);
    if (!sol) continue;
    const sameBox = boxKey(sol.cavity) === boxKey(g.cavity);
    const sameRegion = boxesKey(sol.region) === boxesKey(g.region || []);
    const sameGap = (x: GapSpec, i: number) => Math.abs(x.value - g.gaps[i].value) < 0.05 && x.locked === g.gaps[i].locked;
    const sameGaps = sol.gaps.length === g.gaps.length && sol.gaps.every(sameGap);
    // Referanslı hacim adımlarının çözülen değeri adıma yazılır.
    const rv = sol.cavityResolved || [];
    const withResolved = (cs: CavityStep) => {
      const r = rv.find(x => x.id === cs.id);
      return r && Math.abs((cs.resolvedValue ?? NaN) - r.value) > 0.05 ? { ...cs, resolvedValue: r.value } : cs;
    };
    const stepsPatch = rv.length && g.cavitySteps ? g.cavitySteps.map(withResolved) : null;
    const stepsChanged = !!stepsPatch && stepsPatch.some((cs, i) => cs !== g.cavitySteps![i]);
    if (!(sameBox && sameRegion && sameGaps && !stepsChanged)) {
      st.updatePanelGroup(g.id, { cavity: sol.cavity, region: sol.region, gaps: sol.gaps, ...(stepsChanged ? { cavitySteps: stepsPatch! } : {}) });
    }
    // Adet farkı yeni rebuild tetikler; o rebuild aynı n'i verir → döngü durur.
    if (g.targetGap != null && g.targetGap > 0) {
      const n = countForTargetGap(g, boxSpan(sol.cavity, g.axis), g.targetGap);
      if (n !== g.count) void setGroupCount(g.id, n, { keepTargetGap: true });
    }
  }
}

// ═══════════════════════════════════════════════════ 3. HIZLI GÖVDE ═══════════════════════════════════════════════════
/* HIZLI GÖVDE: dört gövde paneli (üst/sol/sağ/alt) + taban (düz / ayaklı / bazalı) + arkalık tek seferde, sanki tek tek
   yerleştirilmiş gibi üretilir. Sonuç sıradan VF-panelleridir (adımlarına girilip değiştirilir); yalnız AYAKLAR gövde
   parametresinde kalıcıdır (`parameters.legs`) ve listede ilk sırada çizilir.

   Köşe birleşimi = VF SIRASI: önce yerleşen panel köşeden geçer (basan), sonra yerleşen arada kalır (basılan).
   Dört köşenin kısıtlarından topolojik sıra çıkarılır; çevrim (fırıldak) kurulamaz → tercih sırası (sol, sağ, üst, alt).
   Bölgeler YEREL olarak, önceki panellerin (gerekirse taşınmış/kısaltılmış) vekil geometrileriyle hesaplanır; her şey
   tek seferde store'a yazılır, arkalık ise paneller gerçekten üretildikten (rebuild boşaldıktan) sonra adaylardan kurulur. */
export type QuickPanelKey = 'top' | 'left' | 'right' | 'bottom';
export const QUICK_PANEL_NAME: Record<QuickPanelKey, string> = { top: 'Top', left: 'Left', right: 'Right', bottom: 'Bottom' };
/** Köşe → (yatay panel, yan panel). */
const CORNER_PANELS: Record<CornerKey, [QuickPanelKey, QuickPanelKey]> = {
  tl: ['top', 'left'], tr: ['top', 'right'], bl: ['bottom', 'left'], br: ['bottom', 'right'],
};
/** Çevrimde ve eşitlikte tercih: yanlar önce (yanlar geçer). */
const PREFERRED: QuickPanelKey[] = ['left', 'right', 'top', 'bottom'];

/** Etkin köşe birleşimleri: bazalıda alt köşeler her zaman 'side' (alt panel yanların arasında, yanlar yere iner). */
export function effectiveJoins(cfg: QuickBodyConfig): Record<CornerKey, JoinPass> {
  return cfg.base === 'plinth' ? { ...cfg.joins, bl: 'side', br: 'side' } : { ...cfg.joins };
}

/** Köşe kısıtlarından panel sırası (Kahn; eşitlikte PREFERRED). Çevrim → kalanlar tercih sırasıyla eklenir ve `cyclic` işaretlenir. */
export function panelOrderFor(joins: Record<CornerKey, JoinPass>): { order: QuickPanelKey[]; cyclic: boolean } {
  const before = new Map<QuickPanelKey, Set<QuickPanelKey>>(PREFERRED.map(k => [k, new Set<QuickPanelKey>()]));
  for (const c of Object.keys(CORNER_PANELS) as CornerKey[]) {
    const [h, s] = CORNER_PANELS[c];
    const [first, second] = joins[c] === 'side' ? [s, h] : [h, s];
    before.get(second)!.add(first);
  }
  const order: QuickPanelKey[] = []; const done = new Set<QuickPanelKey>(); let cyclic = false;
  while (order.length < PREFERRED.length) {
    const next = PREFERRED.find(k => !done.has(k) && [...before.get(k)!].every(b => done.has(b)));
    if (next) { order.push(next); done.add(next); continue; }
    cyclic = true;
    const k = PREFERRED.find(x => !done.has(x))!; order.push(k); done.add(k);
  }
  return { order, cyclic };
}

/** Tabanın alt panelin altında bıraktığı yükseklik (ayak / baza); düzde 0. */
export const baseLiftOf = (cfg: QuickBodyConfig): number => (cfg.base === 'plinth' ? cfg.plinth.height : cfg.base === 'legs' ? cfg.legs.height : 0);

/* ───────── Ayak yerleşimi (gövde-yerel; ön = +Z) ───────── */
export interface LegSpot { x: number; z: number }
/** 4 = köşeler; 5 = + merkez; 6 = + ön/arka ortası. `side/front/rear` = ayak MERKEZİNİN kenara mesafesi. */
export function legSpots(legs: Pick<BodyLegs, 'count' | 'side' | 'front' | 'rear'>, W: number, D: number): LegSpot[] {
  const xl = legs.side, xr = W - legs.side, zf = D - legs.front, zb = legs.rear;
  const pts: LegSpot[] = [{ x: xl, z: zf }, { x: xr, z: zf }, { x: xl, z: zb }, { x: xr, z: zb }];
  if (legs.count === 5) pts.push({ x: W / 2, z: (zf + zb) / 2 });
  if (legs.count === 6) pts.push({ x: W / 2, z: zf }, { x: W / 2, z: zb });
  return pts;
}
/** Ayak yüksekliği: alt panelin alt yüzü − gövde tabanı (canlı); alt panel yoksa kayıtlı yükseklik. */
export function legHeightOf(body: Shape, legs: BodyLegs, shapes = useAppStore.getState().shapes): number {
  const bb = localBboxOf(effectiveBodyGeometry(body));
  const bottom = legs.bottomVfId ? panelOfVf(legs.bottomVfId, shapes) : undefined;
  const pb = bottom ? localBboxOf(bottom.geometry) : null;
  if (bb && pb) { const h = pb.min.y - bb.min.y; if (h > 0.5) return h; }
  return legs.height;
}
export const bodyLegsOf = (body: Shape | undefined | null): BodyLegs | null => (body?.parameters?.legs as BodyLegs | undefined) ?? null;
export function setBodyLegs(shapeId: string, patch: Partial<BodyLegs> | null): void {
  const st = useAppStore.getState();
  const body = shapeById(shapeId, st.shapes); if (!body) return;
  const next = { ...body.parameters };
  const defaults: BodyLegs = { count: 4, diameter: 50, side: 60, front: 60, rear: 60, height: 100 };
  if (patch === null) delete next.legs; else next.legs = { ...(bodyLegsOf(body) ?? defaults), ...patch };
  st.updateShape(shapeId, { parameters: next } as Partial<Shape>);
}

/* ───────── Yerel bölge → VF ───────── */
interface FaceCtx { body: Shape; eff: THREE.BufferGeometry; faces: FaceData[]; groups: CoplanarFaceGroup[]; W2L: THREE.Matrix4; box: THREE.Box3 }

/** Normali `n` olan (dot > 0.999) yüz grupları. */
const groupsFacing = (groups: CoplanarFaceGroup[], n: Vec3) => {
  const nv = new THREE.Vector3(...n);
  return groups.filter(g => g.normal.clone().normalize().dot(nv) > 0.999);
};

function faceGroupFor(ctx: FaceCtx, n: Vec3, seed: THREE.Vector3): CoplanarFaceGroup | null {
  const cands = groupsFacing(ctx.groups, n);
  if (!cands.length) return null;
  // Çentikli gövdede aynı normalli birden çok yüz: tohuma en yakın merkezli ve en büyük alanlı
  return cands.sort((a, b) => a.center.distanceTo(seed) - b.center.distanceTo(seed) || b.totalArea - a.totalArea)[0];
}

/** `buildFacePreview` ile aynı VF kurulumu (önizleme mesh'i olmadan): bölge tek kaynaktan (computeFreeRegionLocal). */
function vfOnFace(ctx: FaceCtx, n: Vec3, seedLocal: THREE.Vector3, siblings: Shape[], name: string): VirtualFace | null {
  const group = faceGroupFor(ctx, n, seedLocal); if (!group) return null;
  const contour = computeFaceComponentContour(ctx.faces, group.faceIndices, seedLocal, group.normal); if (!contour) return null;
  const region = computeFreeRegionLocal(contour.corners, group.normal, seedLocal, siblings, ctx.W2L, ctx.body.id); if (!region) return null;
  const nrm = group.normal.clone().normalize();
  const to3D = (px: number, py: number) => fromPlaneUV(region.u, region.v, nrm, px, py, region.planeN);
  const anchor = to3D(region.anchor.x, region.anchor.y);
  return {
    id: genId('vf'), shapeId: ctx.body.id,
    normal: vec3(nrm), center: vec3(seedLocal),
    vertices: region.polygon.map(p => vec3(to3D(p.x, p.y))),
    description: name, hasPanel: true, parentFaceShape: true, touchingSiblingIds: region.touchingSiblingIds, sideRelations: region.sideRelations,
    faceGroupDescriptor: createFaceDescriptor(ctx.faces[contour.seedFi], ctx.eff),
    doorBound: true, backBound: true,
    ...({ regionAnchor: vec3(anchor) } as Record<string, unknown>),
  };
}

async function slabOf(verts: Vec3[], normal: Vec3, t: number): Promise<{ rp: unknown; geo: THREE.BufferGeometry } | null> {
  const rp = await createPanelFromVirtualFace(verts, normal, t);
  if (!rp) return null;
  return { rp, geo: convertReplicadToThreeGeometry(rp) };
}

function panelShape(body: Shape, vf: VirtualFace, vfIndex: number, geo: THREE.BufferGeometry, rp: unknown, t: number, extra: Record<string, unknown>): Shape {
  const size = localBboxOf(geo)!.getSize(new THREE.Vector3());
  const s = [size.x, size.y, size.z]; const [def, alt] = [0, 1, 2].sort((a, b) => s[a] - s[b]).slice(1).sort((a, b) => a - b);
  return {
    id: genId('panel-vf'), type: 'panel', position: [...body.position] as Vec3, rotation: body.rotation, scale: [...body.scale] as Vec3,
    color: '#ffffff', geometry: geo, replicadShape: rp,
    parameters: {
      width: s[def], height: s[alt], depth: t, parentShapeId: body.id, faceIndex: -(vfIndex + 1), virtualFaceId: vf.id, arrowRotated: false,
      panelThickness: t, ...extra,
    },
  } as Shape;
}

const moveStep = (axis: MoveTransformStep['axis'], value: number, ts: number): MoveTransformStep =>
  ({ id: `step-${ts}`, type: 'move', axis, value, timestamp: ts });
/** Panelin kendi geometrisinde `label` yönündeki dış yüzünden `value` (dyn; − = kısalt). */
function extrudeStepFor(geo: THREE.BufferGeometry, n: Vec3, label: string, value: number, ts: number): ExtrudeStep | null {
  const g = groupsFacing(getFacesAndGroups(geo).groups, n).sort((a, b) => b.totalArea - a.totalArea)[0];
  if (!g) return null;
  return { id: genId('ext'), faceNormal: n, faceCenter: vec3(g.center), axisLabel: label, value, isFixed: false, timestamp: ts };
}

/* ───────── Ana akış ───────── */
export interface QuickBodyResult { panelCount: number; backCreated: boolean; cyclic: boolean; warnings: string[] }

export async function applyQuickBody(shapeId: string, cfg: QuickBodyConfig): Promise<QuickBodyResult | null> {
  const st = useAppStore.getState();
  const body = shapeById(shapeId, st.shapes); if (!body) return null;
  const eff = effectiveBodyGeometry(body);
  const { faces, groups } = getFacesAndGroups(eff);
  const box = localBboxOf(eff); if (!box) return null;
  const ctx: FaceCtx = { body, eff, faces, groups, W2L: getShapeMatrix(body).clone().invert(), box };
  const H = box.max.y - box.min.y;
  const x0 = box.min.x, y0 = box.min.y, z0 = box.min.z, x1 = box.max.x, y1 = box.max.y, z1 = box.max.z;
  const t = Math.max(1, cfg.thickness);
  const warnings: string[] = [];
  const joins = effectiveJoins(cfg);
  const { order, cyclic } = panelOrderFor(joins);
  if (cyclic) warnings.push('Corner joints form a cycle — resolved as sides first.');
  const lift = Math.min(Math.max(0, baseLiftOf(cfg)), Math.max(0, H - 3 * t));

  // Mevcut kardeşler (kapak/arkalık hariç; arkalık parçaları damga olarak)
  const existing = childPanelsOf(body.id, st.shapes);
  const siblings: Shape[] = [
    ...existing.filter(p => !isDoorPanel(p) && !isBackPanel(p)),
    ...existing.filter(isBackPanel).map(backPreviewStamp).filter((p): p is Shape => !!p),
  ];
  const vfCountBefore = st.virtualFaces.filter(f => f.shapeId === body.id).length;

  const FACE: Record<QuickPanelKey, { n: Vec3; seed: THREE.Vector3 }> = {
    top: { n: [0, 1, 0], seed: new THREE.Vector3((x0 + x1) / 2, y1, (z0 + z1) / 2) },
    bottom: { n: [0, -1, 0], seed: new THREE.Vector3((x0 + x1) / 2, y0, (z0 + z1) / 2) },
    left: { n: [-1, 0, 0], seed: new THREE.Vector3(x0, (y0 + y1) / 2, (z0 + z1) / 2) },
    right: { n: [1, 0, 0], seed: new THREE.Vector3(x1, (y0 + y1) / 2, (z0 + z1) / 2) },
  };
  const newVfs: VirtualFace[] = []; const newShapes: Shape[] = [];
  let ts = Date.now();
  let bottomVfId: string | undefined;

  const push = async (key: QuickPanelKey | 'plinth' | 'rearPlinth', n: Vec3, seed: THREE.Vector3, name: string, opts: {
    move?: [MoveTransformStep['axis'], number]; cuts?: Array<[Vec3, string, number]>; proxyVerts?: (v: Vec3[]) => Vec3[]; bound?: boolean;
  }): Promise<boolean> => {
    const vf = vfOnFace(ctx, n, seed, siblings, name);
    if (!vf) { warnings.push(`${name}: no free region on that face`); return false; }
    if (opts.bound === false) { vf.doorBound = false; vf.backBound = false; }
    const slab = await slabOf(vf.vertices, vf.normal, t);
    if (!slab) { warnings.push(`${name}: panel solid failed`); return false; }
    const extra: Record<string, unknown> = {};
    const steps: MoveTransformStep[] = [];
    // 0 mm taşıma adımı yazılmaz (ön baza varsayılan 0 → listede boş adım olmasın)
    if (opts.move && Math.abs(opts.move[1]) < 0.001) opts.move = undefined;
    if (opts.move) steps.push(moveStep(opts.move[0], opts.move[1], ++ts));
    if (steps.length) extra.transformSteps = steps;
    const exts = (opts.cuts ?? []).map(([cn, label, v]) => extrudeStepFor(slab.geo, cn, label, v, ++ts)).filter((e): e is ExtrudeStep => !!e);
    if (exts.length) extra.extrudeSteps = exts;
    const shape = panelShape(body, vf, vfCountBefore + newVfs.length, slab.geo, slab.rp, t, extra);
    newVfs.push(vf); newShapes.push(shape);
    if (key === 'bottom') bottomVfId = vf.id;
    // Sonraki bölgeler için VEKİL: taşınmış / kısaltılmış hâli (motorun üreteceği sonuç)
    let proxyGeo = slab.geo;
    if (opts.proxyVerts) { const p = await slabOf(opts.proxyVerts(vf.vertices), vf.normal, t); if (p) proxyGeo = p.geo; }
    if (opts.move) { const d = axisDirToVec(opts.move[0]).multiplyScalar(opts.move[1]); proxyGeo = proxyGeo.clone().translate(d.x, d.y, d.z); }
    siblings.push({ ...shape, geometry: proxyGeo });
    return true;
  };

  for (const key of order) {
    const f = FACE[key];
    if (key === 'bottom' && lift > 0) {
      // Yükseltilen alt panelin bölgesi motor tarafından GERÇEK konumunda çözülür (damgalar panelin ötelemesi kadar kaydırılır);
      // ayaklıda kısaltılmış yanlar o yükseklikte alt paneli keser → ek extrude gerekmez.
      await push(key, f.n, f.seed, QUICK_PANEL_NAME[key], { move: ['y+', lift] });
    } else if ((key === 'left' || key === 'right') && cfg.base === 'legs' && lift > 0 && joins[key === 'left' ? 'bl' : 'br'] === 'side') {
      // Yan köşeden geçiyor ama ayak kadar yukarıda biter: alt kenar extrude ile kısaltılır (vekil de kısaltılmış).
      await push(key, f.n, f.seed, QUICK_PANEL_NAME[key], {
        cuts: [[[0, -1, 0], 'Y-', -lift]],
        proxyVerts: vs => vs.map(v => [v[0], Math.max(v[1], y0 + lift), v[2]] as Vec3),
      });
    } else {
      await push(key, f.n, f.seed, QUICK_PANEL_NAME[key], {});
    }
  }

  if (cfg.base === 'plinth' && lift > 0) {
    // Ön baza: alt panelin altında kalan ön yüz şeridi; sonra setback kadar geri (−Z). Kapak/arkalık sınırı DEĞİL.
    const xm = (x0 + x1) / 2, ym = y0 + lift / 2;
    await push('plinth', [0, 0, 1], new THREE.Vector3(xm, ym, z1), 'Plinth', { move: ['z-', Math.max(0, cfg.plinth.front)], bound: false });
    if (cfg.plinth.rearPlinth) {
      await push('rearPlinth', [0, 0, -1], new THREE.Vector3(xm, ym, z0), 'Rear plinth', { move: ['z+', Math.max(0, cfg.plinth.rear)], bound: false });
    }
  }

  if (!newVfs.length) return { panelCount: 0, backCreated: false, cyclic, warnings };

  // Tek seferde yaz: VF'ler sırayla (= basan/basılan), paneller hazır geometriyle (otomatik üretim efekti devreye girmez).
  useAppStore.setState(s => ({ virtualFaces: [...s.virtualFaces, ...newVfs], shapes: [...s.shapes, ...newShapes] }));
  // Ayaklar: ayaklı tabanda zorunlu, bazalıda isteğe bağlı (count 0 = yok)
  const legCount = cfg.base === 'legs' ? (cfg.legs.count || 4) : cfg.base === 'plinth' ? cfg.legs.count : 0;
  const { diameter, side, front, rear } = cfg.legs;
  if (legCount) setBodyLegs(body.id, { count: legCount as 4 | 5 | 6, diameter, side, front, rear, height: lift, bottomVfId });

  await requestRebuild(body.id);
  const { whenRebuildIdle } = await import('./PanelEngine');
  await whenRebuildIdle(body.id);

  // Arkalık: paneller gerçek geometrisiyle üretildikten sonra adaydan (en büyük, dört panelin arası)
  let backCreated = false;
  if (cfg.back.enabled) {
    const fresh = shapeById(body.id); if (!fresh) return { panelCount: newVfs.length, backCreated, cyclic, warnings };
    const cy = (y0 + lift + t + (y1 - t)) / 2;
    const picks = backCandidatesAt(fresh, BACK_AXIS, BACK_SIDE, [(x0 + x1) / 2, cy, z0]);
    if (picks.length) {
      // Aday = dört yeni panelin ARASI: yükseltilmiş alt panelin dış yüzü gövde kenarında olmadığından gövde kenarı (yere kadar) da
      // adaydır ve alanı daha büyüktür — bu yüzden en çok yeni panele dayanan aday seçilir, eşitlikte büyük alan.
      const ours = new Set(newVfs.filter(v => v.doorBound !== false).map(v => v.id));
      const score = (p: typeof picks[number]) => [p.bounds.uMin, p.bounds.uMax, p.bounds.vMin, p.bounds.vMax].filter(r => r.vfId && ours.has(r.vfId)).length;
      const pick = [...picks].sort((a, b) => score(b) - score(a) || b.area - a.area)[0];
      const b = cfg.back;
      const g = createBackGroupFromPick(fresh.id, pick, b.placement, 'Back', {
        thickness: Math.max(1, b.thickness), setback: Math.max(0, b.setback), inset: Math.max(0, b.inset),
        grooveClear: { front: Math.max(0, b.clear.front), back: Math.max(0, b.clear.back), depth: Math.max(0, b.clear.depth) },
      });
      backCreated = !!g;
      useAppStore.getState().setSelectedBackGroupId(null);
    } else warnings.push('Back: no candidate between the panels.');
  }
  return { panelCount: newVfs.length, backCreated, cyclic, warnings };
}
