import {
  type BackAlign, type BackBoundRef, type BackBounds, type BackEdgeGaps, type BackGroup, type BackJointRef, type BackNode, type BackPick, type BackPlacement, type BackRect, type CavityBox, type GapSpec, type PanelGroup, type Shape, type VirtualFace,
  panelOfVf, requestRebuild, shapeById, useAppStore,
} from '../store';
import * as THREE from 'three';
import { type Vec3, genId, round1 } from './Geometry';
import { type Point2D, clipHalfPlane, clipPolyToConvex, frontHullOf, largestFaceNormal, panelFrontHull, panelHasRotation, polyArea } from './FaceRegion';
import { type GapMode, applyGapEditProportional, bodyLocalBox, cycleGapMode, gapMode, panelLocalBox, passiveGapIndex, rescaleGaps } from './PanelGroupService';
// DİKKAT: BackService ↔ PanelGroupService döngüsel içe aktarım (groupObstacles → backShortensGroup). Modül üst düzeyinde
// PanelGroupService bağlarını OKUMA; yalnız fonksiyon gövdesinde çağır.

// ARKALIK (BackService) — kapaktan (DoorService) BAĞIMSIZ servis: kendi tipleri, store dilimi, çözücüsü ve VF yazımı.
//  • Sınır = VF.backBound işaretli paneller; yoksa gövde kenarı. Düzlem = gövdenin ARKA yüzü (gövde-yerel ön = +Z → arka = Z−);
//    seçimde tıklama hangi yüzden gelirse gelsin arka yüze taşınır (rayBackEntry). u = X (sütun), v = Y (satır).
//  • 'outer' = arkadan ÇAKMA: sınır panellerinin arka yüzüne, hacmin DIŞINA; panel kalınlığını örter (kenar binisi Full/Half/None).
//    'inner' = KANALLI: panellerin arasına, kenar boşlukları NEGATİF (= kanala giriş, mm) ve arka yüzden `setback` kadar içerde.
//  • Bölme = AĞAÇ (BackGroup.tree); split alanını çocuklarına KATSAYI kuralıyla dağıtır, bölmek üst ölçüsünü değiştirmez.
//  • Arkalık VF'leri her rebuild'de buradan yazılır; arkalık panelleri DAMGALAMAZ, hacim engeli değildir, gövdeyle kesilmez.
//  • Dönmüş sınır paneli kenar olmaz; arkalığı büyük-yüz düzlemiyle keser (arkalık düzlemi değişmez).
//  • Arkalık-sınırı raf/dikme (Goker, Eki 2026): BÜTÜN kanallı arkalık levhayı KISALTIR (levha arkalığın ön yüzünde biter —
//    `backShortensGroup`, hacim engeli); Panel ref ile levhada BÖLÜNÜNCE parçalar levhanın ortasına kadar girer (iki yandan kanallı),
//    levha tam boy kalır ve derz levhayı izler (BackNode.refs, hep 'center'). Full / Half / Left / Right binisi YOK.

export const BACK_THICKNESS = 8;
export const BACK_GAP = 0;
export const BACK_INSET = 10;      // kanallı: sınır panelinin içine giriş (mm)
export const BACK_SETBACK = 10;    // kanallı: panellerin arka yüzünden arkalığın arka yüzüne (mm)
export const BACK_AXIS = 2 as const;
export const BACK_SIDE = -1 as const;
export const BACK_TYPE_LABEL: Record<BackPlacement, string> = { outer: 'Nailed', inner: 'Grooved' };
export const BACK_TYPE_TITLE: Record<BackPlacement, string> = {
  outer: 'Nailed-on back — sits behind the reference panels, outside the body; covers their thickness (Full / Half per edge)',
  inner: 'Grooved back — sits between the reference panels and enters each one by the groove inset; set back from their rear face',
};
const TOL = 0.5;
const MIN_BACK_SPAN = 40;
const MIN_BACK_SIZE = 1;
const PREVIEW_ID = 'önizleme';
const MAX_BACK_SPLIT = 12;
const NEAR_EXTRA = 3;        // arkalık kenarı ile levha arasındaki "yaklaşma" payı (mm), boşluğun üstüne
const THIN_PANEL = 60;       // levha sayılacak en büyük kalınlık (mm)
export const BACK_JOINT_NEAR = 30;   // levha merkezi ile derz merkezi arası en büyük uzaklık (mm; + yarım kalınlık + yarım derz)
type Pt2 = Point2D;

export const isBackPanel = (p: any): boolean => !!p?.parameters?.backGroupId;
export const isBackVf = (vf: any): boolean => !!vf?.backGroupId;
export const backGroupName = (g: Pick<BackGroup, 'name'>) => g.name ?? 'Back';
/** Arkalık sınırı bayrağı; eski `splitBack` bayrağı sınır sayılır. */
export const vfBackBound = (vf: Pick<VirtualFace, 'backBound' | 'splitBack'> | undefined | null): boolean => !!(vf?.backBound ?? vf?.splitBack);
export type BackEdgeKey = keyof BackBounds;

export function backPlaneAxes(axis: 0 | 1 | 2): { u: 0 | 1 | 2; v: 0 | 1 | 2 } {
  if (axis === 2) return { u: 0, v: 1 };
  if (axis === 0) return { u: 2, v: 1 };
  return { u: 0, v: 2 };
}
export const fmtBackRect = (r: BackRect) => `u ${r.u0.toFixed(0)}..${r.u1.toFixed(0)} v ${r.v0.toFixed(0)}..${r.v1.toFixed(0)} ön=${r.front.toFixed(0)}`;
const rectKey = (r: BackRect) => [r.u0, r.u1, r.v0, r.v1].map(n => Math.round(n)).join('|');

/** Işın hangi yüzden girerse girsin (önden, açıdan) tıklama gövdenin ARKA yüzüne taşınır — ışının arka düzlemle kesişimi, yüzün
 *  içine kırpılır; adaylar hep arka yüzde kurulur. Işın düzleme paralel ya da arkaya bakmıyorsa null. */
export function rayBackEntry(o: Vec3, d: Vec3, b: CavityBox): { axis: 0 | 1 | 2; side: 1 | -1; point: Vec3 } | null {
  const axis = BACK_AXIS, side = BACK_SIDE;
  if (Math.abs(d[axis]) < 1e-9) return null;
  const t = (b.min[axis] - o[axis]) / d[axis];
  if (!(t > 0)) return null;
  const point: Vec3 = [o[0] + d[0] * t, o[1] + d[1] * t, b.min[axis]];
  for (const a of [0, 1] as const) point[a] = Math.min(b.max[a], Math.max(b.min[a], point[a]));
  return { axis, side, point };
}

export interface BackBoundPanel { vfId: string; panelId: string; box: CavityBox; name: string }

/** Arkalık sınırı panelleri (gövde-yerel kutu); arkalıklar ve dönmüş paneller hariç. onlyBound=false: işaretsizler de. */
export function collectBackBoundPanels(parent: Shape, shapes: Shape[] = useAppStore.getState().shapes, vfs: VirtualFace[] = useAppStore.getState().virtualFaces, onlyBound = true): BackBoundPanel[] {
  const out: BackBoundPanel[] = [];
  for (const vf of vfs) {
    if (vf.shapeId !== parent.id || (onlyBound && !vfBackBound(vf)) || isBackVf(vf)) continue;
    const p = panelOfVf(vf.id, shapes);
    if (!p || panelHasRotation(p)) continue;
    const box = panelLocalBox(p, parent);
    if (!box) continue;
    out.push({ vfId: vf.id, panelId: p.id, box, name: vf.description || 'Panel' });
  }
  return out;
}

/** Dönmüş sınır paneli: büyük-yüz normali + o normaldeki [dMin,dMax] + kutu; pts = tekil köşeler (şema ön görünüşü). */
export interface BackCut { vfId: string; name: string; n: Vec3; dMin: number; dMax: number; box: CavityBox; pts?: Vec3[] }

export function collectBackCuts(parent: Shape, shapes: Shape[] = useAppStore.getState().shapes, vfs: VirtualFace[] = useAppStore.getState().virtualFaces): BackCut[] {
  const out: BackCut[] = [];
  for (const vf of vfs) {
    if (vf.shapeId !== parent.id || !vfBackBound(vf) || isBackVf(vf)) continue;
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
      if (d < dMin) dMin = d; if (d > dMax) dMax = d;
      const k = `${Math.round(x * 10)},${Math.round(y * 10)},${Math.round(z * 10)}`;
      if (!seen.has(k)) { seen.add(k); pts.push([x, y, z]); }
    }
    if (!(dMax - dMin > 0.5)) continue;
    out.push({ vfId: vf.id, name: vf.description || 'Panel', n: [n.x, n.y, n.z], dMin, dMax, box, pts });
  }
  return out;
}

/** Dönmüş kesicinin kestiği KENAR = kaldırılan yönün baskın ekseni (eğik üst → vMax, eğik dikme → uMin/uMax). */
function cutEdgeOf(c: BackCut, cu: number, cv: number, axis: 0 | 1 | 2, front: number): { edge: BackEdgeKey; keepBelow: boolean } | null {
  const { u, v } = backPlaneAxes(axis);
  const A = c.n[u], B = c.n[v], Na = c.n[axis];
  if (Math.abs(A) < 1e-6 && Math.abs(B) < 1e-6) return null;   // arkalık düzlemine paralel: kesim anlamsız
  const keepBelow = A * cu + B * cv + Na * front < (c.dMin + c.dMax) / 2;
  const ru = keepBelow ? A : -A, rv = keepBelow ? B : -B;
  const edge: BackEdgeKey = Math.abs(ru) >= Math.abs(rv) ? (ru > 0 ? 'uMax' : 'uMin') : (rv > 0 ? 'vMax' : 'vMin');
  return { edge, keepBelow };
}
const cutCoverFar = (c: BackCut, axis: 0 | 1 | 2, side: 1 | -1, placement: BackPlacement, front: number) =>
  placement === 'outer' && (side > 0 ? c.box.max[axis] <= front + TOL : c.box.min[axis] >= front - TOL);

type HalfOverlay = BackGroup['halfOverlay'];
// Üyeyi dönmüş panellerin büyük-yüz düzlemleriyle kırpar; kesim arkalığın İKİ yüzeyinde alınır, kısıtlayıcı olan tutulur
// (arkalık eğik panele girmez). Kenar boşluğu = kesicinin kestiği kenarın boşluğu.
function clipMemberByCuts(
  m: { u0: number; u1: number; v0: number; v1: number }, cuts: BackCut[], axis: 0 | 1 | 2, side: 1 | -1,
  placement: BackPlacement, thickness: number, front: number, gapIn: number | BackEdgeGaps, half?: HalfOverlay, ref?: [number, number],
): Pt2[] | null {
  if (!cuts.length) return null;
  const { u, v } = backPlaneAxes(axis);
  let poly: Pt2[] = [{ x: m.u0, y: m.v0 }, { x: m.u1, y: m.v0 }, { x: m.u1, y: m.v1 }, { x: m.u0, y: m.v1 }];
  const planes = placement === 'outer' ? [front, front + side * thickness] : [front - side * thickness, front];
  const cu = ref ? ref[0] : (m.u0 + m.u1) / 2, cv = ref ? ref[1] : (m.v0 + m.v1) / 2;
  let any = false;
  for (const c of cuts) {
    if (Math.min(c.box.max[u], m.u1) - Math.max(c.box.min[u], m.u0) < TOL || Math.min(c.box.max[v], m.v1) - Math.max(c.box.min[v], m.v0) < TOL) continue;
    const A = c.n[u], B = c.n[v], Na = c.n[axis];
    const ce = cutEdgeOf(c, cu, cv, axis, front);
    if (!ce) continue;
    const { keepBelow } = ce;
    const gap = typeof gapIn === 'number' ? gapIn : gapIn[ce.edge];
    const coverFar = cutCoverFar(c, axis, side, placement, front);
    const halfHere = coverFar && !!half?.[ce.edge];
    const mid = (c.dMin + c.dMax) / 2;
    const before = poly;
    if (keepBelow) {
      const lim = (halfHere ? mid : coverFar ? c.dMax : c.dMin) - gap;
      const C = Math.min(...planes.map(pa => lim - Na * pa));
      poly = clipHalfPlane(poly, A, B, C);
    } else {
      const lim = (halfHere ? mid : coverFar ? c.dMin : c.dMax) + gap;
      const C = Math.max(...planes.map(pa => lim - Na * pa));
      poly = clipHalfPlane(poly, -A, -B, -C);
    }
    if (poly.length < 3 || polyArea(poly) < MIN_BACK_SPAN * MIN_BACK_SPAN) { console.warn('[YAGO][ARKALIK-AÇILI] kesim üyeyi yok ediyor, atlandı:', c.name); poly = before; continue; }
    if (poly.length !== before.length || poly.some((q, i) => Math.abs(q.x - before[i].x) > 1e-6 || Math.abs(q.y - before[i].y) > 1e-6)) any = true;
  }
  return any ? poly : null;
}

/** Arkalık sınırı; eski splitBack bayrağı birlikte temizlenir (tek kaynak backBound). */
export function setVfBackBound(vfId: string, on: boolean): void {
  const st = useAppStore.getState();
  const vf = st.virtualFaces.find(f => f.id === vfId);
  if (!vf || vfBackBound(vf) === on) return;
  st.updateVirtualFace(vfId, { backBound: on, ...(vf.splitBack !== undefined ? { splitBack: undefined } : {}) } as Partial<VirtualFace>);
  if (on) adoptBoundsAfterMark(vf.shapeId);
}
/** Sınır işaretinden sonra: gövde kenarına bağlı kenarı bu levhayı devralan gruplar hemen yeniden yazılır (rebuild). */
function adoptBoundsAfterMark(shapeId: string): void {
  const st = useAppStore.getState();
  const parent = shapeById(shapeId, st.shapes);
  if (!parent) return;
  for (const g of st.backGroups) {
    if (g.shapeId !== shapeId) continue;
    const rb = resolveBackBounds(g, parent, st.shapes, st.virtualFaces);
    if (!sameBounds(rb, g.bounds)) void writeBackGroup(g, { bounds: rb });
  }
}

type SideOpt = { ref: BackBoundRef; inner: number; outer: number; cross: [number, number]; front: number | null; name: string };
type EdgeInfo = { ref: BackBoundRef; inner: number; outer: number; front: number | null };
type BackEdges = { l: EdgeInfo; r: EdgeInfo; b: EdgeInfo; t: EdgeInfo };

// KENAR KURALI: P = derinlik referansının arka yüzü; outer [P, P+t] (hacmin dışına), inner [P−t, P]. Inner → kenar İÇ yüz.
// Outer → panel arkalığın gerisindeyse kalınlığını örter (DIŞ yüz); yarım binme yalnız örtülen kenarda: (iç+dış)/2.
const edgeCovered = (x: EdgeInfo, side: 1 | -1, placement: BackPlacement, P: number) =>
  x.front != null && placement === 'outer' && (side > 0 ? x.front <= P + TOL : x.front >= P - TOL);
function rectAtDepth(e: BackEdges, side: 1 | -1, placement: BackPlacement, P: number, half?: HalfOverlay, none?: HalfOverlay): BackRect {
  const pick = (x: EdgeInfo, h: boolean | undefined, n: boolean | undefined) => {
    if (!edgeCovered(x, side, placement, P) || n) return x.inner;
    return h ? (x.inner + x.outer) / 2 : x.outer;
  };
  return { u0: pick(e.l, half?.uMin, none?.uMin), u1: pick(e.r, half?.uMax, none?.uMax), v0: pick(e.b, half?.vMin, none?.vMin), v1: pick(e.t, half?.vMax, none?.vMax), front: P };
}
/** Düzlem = kenar panellerinin EN GERİDEKİ yüzü (tek seçenek); panel yoksa gövde yüzü. */
function depthOptions(e: EdgeInfo[], side: 1 | -1, bodyFront: number): Array<{ ref: BackBoundRef; front: number }> {
  let best: { ref: BackBoundRef; front: number } | null = null;
  for (const x of e) {
    if (x.front == null) continue;
    if (!best || side * (x.front - best.front) < 0) best = { ref: x.ref, front: x.front };
  }
  return [best ?? { ref: { body: true }, front: bodyFront }];
}

// Arkalık adayları: dört yandaki sınır seçeneklerinin her kombinasyonu bir dikdörtgen; seçilen panel çapraz açıklıkla örtüşmeli.
// Hepsi tıklanan noktayı içerir. Sıra: alan büyükten küçüğe (önce dıştakiler).
export function backCandidatesAt(parent: Shape, axis: 0 | 1 | 2, side: 1 | -1, click: Vec3, shapes?: Shape[], vfs?: VirtualFace[]): BackPick[] {
  const body = bodyLocalBox(parent);
  if (!body) return [];
  const { u, v } = backPlaneAxes(axis);
  const bounds = collectBackBoundPanels(parent, shapes, vfs, true);
  const cu = click[u], cv = click[v];
  const frontOf = (b: CavityBox) => (side > 0 ? b.max[axis] : b.min[axis]);
  const bodyFront = side > 0 ? body.max[axis] : body.min[axis];
  const bodyOpt = (edge: number, cross: [number, number]): SideOpt => ({ ref: { body: true }, inner: edge, outer: edge, cross, front: null, name: 'Body' });
  // Gövde kenarı da seçenektir, o yanda gövde kenarına dayanan sınır paneli yoksa.
  const optsFor = (ax: 0 | 1 | 2, cx: 0 | 1 | 2, c: number, minSide: boolean): SideOpt[] => {
    const out: SideOpt[] = [];
    const edge = minSide ? body.min[ax] : body.max[ax];
    for (const bp of bounds) {
      const b = bp.box;
      const onSide = minSide ? b.max[ax] <= c + TOL : b.min[ax] >= c - TOL;
      if (!onSide) continue;
      out.push({ ref: { vfId: bp.vfId }, inner: minSide ? b.max[ax] : b.min[ax], outer: minSide ? b.min[ax] : b.max[ax], cross: [b.min[cx], b.max[cx]], front: frontOf(b), name: bp.name });
    }
    if (!out.some(o => Math.abs(o.outer - edge) <= TOL)) out.push(bodyOpt(edge, [body.min[cx], body.max[cx]]));
    return out;
  };
  const L = optsFor(u, v, cu, true), R = optsFor(u, v, cu, false), B = optsFor(v, u, cv, true), T = optsFor(v, u, cv, false);
  const overlaps = (cross: [number, number], a0: number, a1: number) => Math.min(cross[1], a1) - Math.max(cross[0], a0) > TOL;
  // Açılı sınır panelleri: aday alanı tıklanan noktanın tarafına kırpılır.
  const cuts = collectBackCuts(parent, shapes, vfs);
  const at: [number, number] = [cu, cv];
  const shrink = (placement: BackPlacement, r: BackRect) => backRectByCuts({ axis, side, placement, thickness: BACK_THICKNESS, gap: BACK_GAP }, r, cuts, at);
  const seen = new Set<string>();
  const out: BackPick[] = [];
  for (const l of L) for (const r of R) for (const b of B) for (const t of T) {
    const between: BackRect = { u0: l.inner, u1: r.inner, v0: b.inner, v1: t.inner, front: 0 };
    if (between.u1 - between.u0 < MIN_BACK_SPAN || between.v1 - between.v0 < MIN_BACK_SPAN) continue;
    if (!overlaps(l.cross, between.v0, between.v1) || !overlaps(r.cross, between.v0, between.v1)) continue;
    if (!overlaps(b.cross, between.u0, between.u1) || !overlaps(t.cross, between.u0, between.u1)) continue;
    const key = rectKey(between);
    if (seen.has(key)) continue;
    seen.add(key);
    const edges = { l, r, b, t };
    const depths = depthOptions([l, r, b, t], side, bodyFront);
    const boundsRef: BackBounds = { uMin: l.ref, uMax: r.ref, vMin: b.ref, vMax: t.ref };
    const panelN = [l, r, b, t].filter(o => o.front != null).length;
    depths.forEach((d, di) => {
      const inner = shrink('inner', rectAtDepth(edges, side, 'inner', d.front)), outer = shrink('outer', rectAtDepth(edges, side, 'outer', d.front));
      out.push({
        key: `${axis}${side > 0 ? '+' : '-'}:${key}@${Math.round(d.front)}`, axis, side, bounds: boundsRef,
        inner, outer, at,
        area: (inner.u1 - inner.u0) * (inner.v1 - inner.v0), boundPanelCount: panelN,
        depth: d.ref, depthIndex: di, depthCount: depths.length,
      });
    });
  }
  out.sort((a, b) => b.area - a.area || a.boundPanelCount - b.boundPanelCount || side * (b.inner.front - a.inner.front));
  return out;
}

export const backSetbackOf = (g: Pick<BackGroup, 'setback'>) => (Number.isFinite(g.setback) && (g.setback as number) >= 0 ? (g.setback as number) : BACK_SETBACK);
/** Arkalığın varsayılan kenar boşlukları: kanallıda panel kenarı −inset (kanala giriş), gövde kenarı 0; çakmada hep 0. */
export function backEdgeGapsDefault(g: Pick<BackGroup, 'bounds' | 'placement'>, inset = BACK_INSET): BackEdgeGaps {
  const e = (k: BackEdgeKey) => (g.placement === 'inner' && g.bounds[k]?.vfId ? -inset : 0);
  return { uMin: e('uMin'), uMax: e('uMax'), vMin: e('vMin'), vMax: e('vMax') };
}
/** Seçme önizlemesi: adayın dikdörtgeni yeni grubun çözüleceği yere taşınır — kanallıda panel kenarları inset kadar genişler, düzlem setback kadar içerde. */
export function backPickRect(pick: BackPick, placement: BackPlacement): BackRect {
  const r = placement === 'inner' ? { ...pick.inner } : { ...pick.outer };
  if (placement !== 'inner') return r;
  const eg = backEdgeGapsDefault({ bounds: pick.bounds, placement });
  return { u0: r.u0 + eg.uMin, u1: r.u1 - eg.uMax, v0: r.v0 + eg.vMin, v1: r.v1 - eg.vMax, front: r.front - pick.side * BACK_SETBACK };
}

export interface BackMemberRect { u0: number; u1: number; v0: number; v1: number; leafId: string; poly?: Pt2[] }
export type BackNodeSolved =
  | { id: string; kind: 'leaf'; u0: number; u1: number; v0: number; v1: number; depth: number }
  | { id: string; kind: 'split'; axis: 'u' | 'v'; sizes: GapSpec[]; gaps: number[]; children: BackNodeSolved[]; targetSize?: number; refs?: Record<number, BackJointRef>; u0: number; u1: number; v0: number; v1: number; depth: number };
export interface BackSolution { rect: BackRect; tree: BackNode; solved: BackNodeSolved; members: BackMemberRect[]; bounds?: BackBounds }
/** `${splitId}:${k}` → bağlı derzin merkezi (bölmenin ekseninde). */
export type BackJointTargets = Map<string, number>;
const jointKey = (splitId: string, k: number) => `${splitId}:${k}`;
export type BackLayout = Pick<BackGroup, 'rect' | 'tree' | 'edgeGaps' | 'gap'>;

export const makeBackLeaf = (): BackNode => ({ id: genId('bl'), kind: 'leaf' });
/** Kenar boşlukları; NEGATİF değer = kenar panelinin içine giriş (kanallı). */
export function backEdgeGapsOf(g: Pick<BackGroup, 'gap'> & { edgeGaps?: BackEdgeGaps }): BackEdgeGaps {
  const ok = (x: unknown): x is number => Number.isFinite(x);
  const e = g.edgeGaps;
  return { uMin: ok(e?.uMin) ? e.uMin : g.gap, uMax: ok(e?.uMax) ? e.uMax : g.gap, vMin: ok(e?.vMin) ? e.vMin : g.gap, vMax: ok(e?.vMax) ? e.vMax : g.gap };
}
export function backLeaves(n: BackNode): Array<Extract<BackNode, { kind: 'leaf' }>> { return n.kind === 'leaf' ? [n] : n.children.flatMap(backLeaves); }
export const backMemberCount = (g: Pick<BackGroup, 'tree'>) => backLeaves(g.tree).length;
export function findBackNode(n: BackNode, id: string): BackNode | null { if (n.id === id) return n; if (n.kind === 'split') for (const c of n.children) { const h = findBackNode(c, id); if (h) return h; } return null; }
export function findBackParent(n: BackNode, id: string): Extract<BackNode, { kind: 'split' }> | null {
  if (n.kind !== 'split') return null;
  if (n.children.some(c => c.id === id)) return n;
  for (const c of n.children) { const h = findBackParent(c, id); if (h) return h; }
  return null;
}
export function replaceBackNode(n: BackNode, id: string, repl: (old: BackNode) => BackNode): BackNode {
  if (n.id === id) return repl(n);
  if (n.kind === 'leaf') return n;
  return { ...n, children: n.children.map(c => replaceBackNode(c, id, repl)) };
}
/** Alt ağacın yeni kimlikli kopyası; derz bağları da kopyalanır. */
export function cloneBackNode(n: BackNode): BackNode {
  if (n.kind === 'leaf') return { ...n, id: genId('bl') };
  return { ...n, id: genId('bs'), sizes: n.sizes.map(s => ({ ...s })), gaps: [...n.gaps], children: n.children.map(cloneBackNode), ...(n.refs ? { refs: { ...n.refs } } : {}) };
}
export function findSolvedBackNode(n: BackNodeSolved, id: string): BackNodeSolved | null { if (n.id === id) return n; if (n.kind === 'split') for (const c of n.children) { const h = findSolvedBackNode(c, id); if (h) return h; } return null; }

// KATSAYI kuralı: kilitli ölçüler sabit; kalan alan kilitsizlere (girilmişler dahil) mevcut oranlarıyla dağılır.
function distributeSizes(specs: GapSpec[], L: number, gaps: number[]): GapSpec[] {
  const out = rescaleGaps(specs, L, gaps.length, gaps);
  const resid = round1(L - gaps.reduce((a, g) => a + g, 0) - out.reduce((a, g) => a + g.value, 0));
  if (Math.abs(resid) >= 0.05 && Math.abs(resid) < 1) {
    let j = -1;
    for (let i = out.length - 1; i >= 0 && j < 0; i--) if (gapMode(out[i]) === 'open') j = i;
    for (let i = out.length - 1; i >= 0 && j < 0; i--) if (!out[i].locked) j = i;
    if (j >= 0) out[j] = { ...out[j], value: round1(out[j].value + resid) };
  }
  return out;
}
export type BackSizeMode = GapMode;
export const backSizeMode = (g: GapSpec | undefined): BackSizeMode => gapMode(g);
export const passiveBackSizeIndex = (sizes: ReadonlyArray<GapSpec | undefined>, count = sizes.length): number => passiveGapIndex(sizes, count);

const splitGapsOf = (n: Extract<BackNode, { kind: 'split' }>, gap: number) => {
  const m = n.children.length - 1;
  if (n.gaps.length === m && n.gaps.every(x => Number.isFinite(x) && x >= 0)) return n.gaps.slice();
  return Array.from({ length: m }, (_, i) => (Number.isFinite(n.gaps[i]) && n.gaps[i] >= 0 ? n.gaps[i] : n.gaps.length ? n.gaps[0] : gap));
};

// along[k] = k. derz merkezinin bölme başlangıcından uzaklığı (u: soldan, v: üstten). Bağ kilitli ölçüye de baskındır;
// tüm ölçüler edited yazılır → bağsız çözüm aynı değerleri verir. Parçalar sığmazsa bağ yok sayılır.
function distributeSizesWithJoints(specs: GapSpec[], L: number, gaps: number[], along: Map<number, number>, splitId: string): GapSpec[] {
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
    if (!(s.b - s.a - inner >= (s.to - s.from + 1) * 1)) {
      console.warn('[YAGO][ARKALIK-BAĞ] bağlı derz(ler) bölmeye sığmıyor, bağ bu çözümde yok sayıldı:', splitId, ks.map(k => `${k}@${along.get(k)!.toFixed(1)}`).join(' '), 'L=', L.toFixed(1));
      return distributeSizes(specs, L, gaps);
    }
  }
  const out: GapSpec[] = [];
  for (const s of bounds) {
    const segL = s.b - s.a;
    if (s.to === s.from) { out.push({ ...base[s.from], value: round1(segL), edited: true }); continue; }
    for (const sz of distributeSizes(base.slice(s.from, s.to + 1), segL, gaps.slice(s.from, s.to))) out.push({ ...sz, edited: true });
  }
  return out;
}

/** Ağaç çözümü: split alanını çocuklarına dağıtır (u: soldan sağa, v: ÜSTTEN aşağı); toplam her zaman üst alan. */
function solveNode(n: BackNode, u0: number, u1: number, v0: number, v1: number, gap: number, depth: number, targets?: BackJointTargets): BackNodeSolved {
  if (n.kind === 'leaf') return { ...n, u0, u1, v0, v1, depth };
  const gaps = splitGapsOf(n, gap);
  const L = n.axis === 'u' ? u1 - u0 : v1 - v0;
  const along = new Map<number, number>();
  if (targets && n.refs) for (const k of Object.keys(n.refs)) { const t = targets.get(jointKey(n.id, +k)); if (t != null) along.set(+k, n.axis === 'u' ? t - u0 : v1 - t); }
  const sizes = along.size ? distributeSizesWithJoints(n.sizes, L, gaps, along, n.id) : distributeSizes(n.sizes, L, gaps);
  const children: BackNodeSolved[] = [];
  let pos = n.axis === 'u' ? u0 : v1;
  n.children.forEach((c, i) => {
    const w = Math.max(0, sizes[i]?.value ?? 0);
    if (n.axis === 'u') { children.push(solveNode(c, pos, pos + w, v0, v1, gap, depth + 1, targets)); pos += w + (gaps[i] ?? 0); }
    else { children.push(solveNode(c, u0, u1, pos - w, pos, gap, depth + 1, targets)); pos -= w + (gaps[i] ?? 0); }
  });
  return { ...n, sizes, gaps, children, u0, u1, v0, v1, depth };
}
export function solveBackTree(g: BackLayout, rect: BackRect = g.rect, targets?: BackJointTargets): BackNodeSolved {
  const e = backEdgeGapsOf(g);
  return solveNode(g.tree, rect.u0 + e.uMin, rect.u1 - e.uMax, rect.v0 + e.vMin, rect.v1 - e.vMax, g.gap, 0, targets);
}
export function solvedToBackTree(n: BackNodeSolved): BackNode {
  if (n.kind === 'leaf') return { id: n.id, kind: 'leaf' };
  return {
    id: n.id, kind: 'split', axis: n.axis, sizes: n.sizes, gaps: n.gaps, children: n.children.map(solvedToBackTree),
    ...(n.targetSize ? { targetSize: n.targetSize } : {}), ...(n.refs && Object.keys(n.refs).length ? { refs: n.refs } : {}),
  };
}
export function backJointRefs(n: BackNode): Array<{ splitId: string; k: number; ref: BackJointRef }> {
  if (n.kind === 'leaf') return [];
  const own = Object.entries(n.refs ?? {}).map(([k, ref]) => ({ splitId: n.id, k: +k, ref }));
  return [...own, ...n.children.flatMap(backJointRefs)];
}
// Bağlı derz merkezi levhanın GÜNCEL kutusundan: 'center' → levha ortası, 'min' → max yüz + yarım derz, 'max' → min yüz − yarım derz.
export function backJointTargets(group: BackLayout & Pick<BackGroup, 'axis'>, parent: Shape, shapes: Shape[]): BackJointTargets {
  const out: BackJointTargets = new Map();
  const refs = backJointRefs(group.tree);
  if (!refs.length) return out;
  const { u, v } = backPlaneAxes(group.axis);
  for (const { splitId, k, ref } of refs) {
    const node = findBackNode(group.tree, splitId);
    if (!node || node.kind !== 'split' || k < 0 || k >= node.children.length - 1) continue;
    const p = panelOfVf(ref.vfId, shapes);
    if (!p || (p.parameters as any)?.parentShapeId !== parent.id || panelHasRotation(p)) continue;
    const box = panelLocalBox(p, parent);
    if (!box) continue;
    const ax = node.axis === 'u' ? u : v;
    const a0 = box.min[ax], a1 = box.max[ax];
    if (!(a1 - a0 > 0) || a1 - a0 > THIN_PANEL) continue;
    const g = splitGapsOf(node, group.gap)[k] ?? group.gap;
    out.set(jointKey(splitId, k), ref.align === 'center' ? (a0 + a1) / 2 : ref.align === 'min' ? a1 + g / 2 : a0 - g / 2);
  }
  return out;
}
/** Üye dikdörtgenleri (DFS yaprak sırası = VF.backIndex). */
export function backMemberRects(solved: BackNodeSolved): BackMemberRect[] {
  const out: BackMemberRect[] = [];
  const walk = (n: BackNodeSolved) => {
    if (n.kind === 'split') { n.children.forEach(walk); return; }
    out.push({ leafId: n.id, u0: n.u0, u1: n.u1, v0: n.v0, v1: n.v1 });
  };
  walk(solved);
  return out;
}
export const backMembersOf = (g: BackLayout) => backMemberRects(solveBackTree(g));

function boundEdgeInfo(ref: BackBoundRef, parent: Shape, shapes: Shape[], body: CavityBox, ax: 0 | 1 | 2, minSide: boolean, axis: 0 | 1 | 2, side: 1 | -1): EdgeInfo {
  if (ref.vfId) {
    const p = panelOfVf(ref.vfId, shapes);
    const box = p && (p.parameters as any)?.parentShapeId === parent.id ? panelLocalBox(p, parent) : null;
    if (box) return { ref, inner: minSide ? box.max[ax] : box.min[ax], outer: minSide ? box.min[ax] : box.max[ax], front: side > 0 ? box.max[axis] : box.min[axis] };
    console.warn('[YAGO][ARKALIK] sınır paneli bulunamadı, gövde kenarı kullanıldı:', ref.vfId);
  }
  const e = minSide ? body.min[ax] : body.max[ax];
  return { ref: { body: true }, inner: e, outer: e, front: null };
}
const EDGE_ADOPT_TOL = 1;   // gövde kenarı ile levhanın dış yüzü arası en büyük fark (mm)
// SONRADAN KONAN SINIR LEVHASI: arkalık gövde kenarına bağlıyken o kenara sonradan konup sınır işaretlenen levha (yan/üst/alt panel)
// arkalık kenarı olur → bini / kanal girişi o levhaya göre çalışır. Panel kenarları korunur; yalnız gövde kenarları devralınır.
export function resolveBackBounds(group: BackGroup, parent: Shape, shapes: Shape[] = useAppStore.getState().shapes, vfs: VirtualFace[] = useAppStore.getState().virtualFaces): BackBounds {
  const keys: BackEdgeKey[] = ['uMin', 'uMax', 'vMin', 'vMax'];
  if (keys.every(k => group.bounds[k]?.vfId)) return group.bounds;
  const body = bodyLocalBox(parent);
  if (!body) return group.bounds;
  const bps = collectBackBoundPanels(parent, shapes, vfs, true);
  if (!bps.length) return group.bounds;
  const { u, v } = backPlaneAxes(group.axis);
  let out = group.bounds;
  for (const k of keys) {
    if (group.bounds[k]?.vfId) continue;
    const isU = k === 'uMin' || k === 'uMax', minSide = k === 'uMin' || k === 'vMin';
    const ax = isU ? u : v, cx = isU ? v : u;
    const edge = minSide ? body.min[ax] : body.max[ax];
    const c0 = isU ? group.rect.v0 : group.rect.u0, c1 = isU ? group.rect.v1 : group.rect.u1;
    let best: BackBoundPanel | null = null, bestOv = MIN_BACK_SPAN;
    for (const bp of bps) {
      const b = bp.box, t = b.max[ax] - b.min[ax];
      if (t > THIN_PANEL || t > b.max[cx] - b.min[cx]) continue;
      if (Math.abs((minSide ? b.min[ax] : b.max[ax]) - edge) > EDGE_ADOPT_TOL) continue;
      const ov = Math.min(b.max[cx], c1) - Math.max(b.min[cx], c0);
      if (ov > bestOv) { bestOv = ov; best = bp; }
    }
    if (best) { if (out === group.bounds) out = { ...group.bounds }; out[k] = { vfId: best.vfId }; }
  }
  return out;
}
const sameBounds = (a: BackBounds, b: BackBounds) => (['uMin', 'uMax', 'vMin', 'vMax'] as BackEdgeKey[]).every(k => (a[k]?.vfId ?? '') === (b[k]?.vfId ?? '') && !!a[k]?.body === !!b[k]?.body);

function solveBackEdges(group: BackGroup, parent: Shape, shapes: Shape[]): { edges: BackEdges; P: number; bounds: BackBounds } | null {
  const body = bodyLocalBox(parent);
  if (!body) return null;
  const { u, v } = backPlaneAxes(group.axis);
  const bounds = resolveBackBounds(group, parent, shapes);
  const ei = (ref: BackBoundRef, ax: 0 | 1 | 2, minSide: boolean) => boundEdgeInfo(ref, parent, shapes, body, ax, minSide, group.axis, group.side);
  const edges: BackEdges = { l: ei(bounds.uMin, u, true), r: ei(bounds.uMax, u, false), b: ei(bounds.vMin, v, true), t: ei(bounds.vMax, v, false) };
  const bodyFront = group.side > 0 ? body.max[group.axis] : body.min[group.axis];
  // Derinlik: kayıtlı referans panelin arka yüzü (panel taşınınca izler); yoksa en gerideki sınır panelinin yüzü.
  const fronts = [edges.l, edges.r, edges.b, edges.t].map(x => x.front).filter((x): x is number => x != null);
  const sgn = group.side;
  let P = !fronts.length ? bodyFront : (sgn > 0 ? Math.min(...fronts) : Math.max(...fronts));
  if (group.depthRef?.body) P = bodyFront;
  else if (group.depthRef?.vfId) {
    const hit = [edges.l, edges.r, edges.b, edges.t].find(x => x.ref.vfId === group.depthRef!.vfId && x.front != null);
    if (hit) P = hit.front!;
    else console.warn('[YAGO][ARKALIK] derinlik referansı bulunamadı, varsayılan derinlik:', group.id, group.depthRef.vfId);
  }
  // Kanallı: düzlem panellerin arka yüzünden `setback` kadar içerde (iç kural oradan uygulanır).
  if (group.placement === 'inner') P -= group.side * backSetbackOf(group);
  return { edges, P, bounds };
}

export function solveBackGroup(group: BackGroup, parent: Shape, shapes: Shape[]): BackSolution | null {
  const s = solveBackEdges(group, parent, shapes);
  if (!s) return null;
  const { edges, P, bounds } = s;
  const cutsAll = collectBackCuts(parent, shapes, undefined);
  let rect: BackRect = backRectByCuts(group, rectAtDepth(edges, group.side, group.placement, P, group.halfOverlay, group.noOverlay), cutsAll, group.anchor);
  if (rect.u1 - rect.u0 < MIN_BACK_SPAN || rect.v1 - rect.v0 < MIN_BACK_SPAN) {
    console.warn('[YAGO][ARKALIK] dikdörtgen bozuk/çok küçük, önceki korunuyor:', group.id, fmtBackRect(rect));
    rect = { ...group.rect };
  }
  const solved = solveBackTree(group, rect, backJointTargets(group, parent, shapes));
  const members = applyBackCuts(group, rect, backMemberRects(solved), cutsAll);
  return { rect, tree: solvedToBackTree(solved), solved, members, bounds };
}

type CutGroup = Pick<BackGroup, 'axis' | 'side' | 'placement' | 'thickness' | 'gap' | 'halfOverlay' | 'anchor'> & { edgeGaps?: BackEdgeGaps };
export function applyBackCuts(group: CutGroup, rect: BackRect, members: BackMemberRect[], cuts: BackCut[]): BackMemberRect[] {
  if (!cuts.length) return members;
  const eg = backEdgeGapsOf(group);
  return members.map(m => {
    const poly = clipMemberByCuts(m, cuts, group.axis, group.side, group.placement, group.thickness, rect.front, eg, group.halfOverlay, group.anchor);
    return poly ? { ...m, poly } : m;
  });
}

// Şemada açılı sınır levhası: arkalık düzlemindeki kesit bir ŞERİT (dMin ≤ A·u + B·v + Na·front ≤ dMax), en az minT mm.
export interface BackCutBand { cut: BackCut; poly: Pt2[]; edge: BackEdgeKey | null; covered: boolean; dir: Pt2 }
export function backCutBands(group: Pick<BackGroup, 'axis' | 'side' | 'placement' | 'anchor'>, rect: BackRect, cuts: BackCut[], area: Pt2[], minT: number): BackCutBand[] {
  const { u, v } = backPlaneAxes(group.axis);
  const out: BackCutBand[] = [];
  for (const c of cuts) {
    const A = c.n[u], B = c.n[v], Na = c.n[group.axis];
    const len = Math.hypot(A, B);
    if (len < 1e-6) continue;
    let lo = c.dMin - Na * rect.front, hi = c.dMax - Na * rect.front;
    if (hi - lo < minT * len) { const m = (lo + hi) / 2; lo = m - minT * len / 2; hi = m + minT * len / 2; }
    let poly = clipHalfPlane(area, A, B, hi);
    if (poly.length >= 3) poly = clipHalfPlane(poly, -A, -B, -lo);
    if (poly.length >= 3 && c.pts && c.pts.length >= 3) { const hull = frontHullOf(c.pts, u, v); if (hull.length >= 3) poly = clipPolyToConvex(poly, hull); }
    if (poly.length < 3 || Math.abs(polyArea(poly)) < 1) continue;
    const cu = group.anchor ? group.anchor[0] : (rect.u0 + rect.u1) / 2, cv = group.anchor ? group.anchor[1] : (rect.v0 + rect.v1) / 2;
    const ce = cutEdgeOf(c, cu, cv, group.axis, rect.front);
    out.push({ cut: c, poly, edge: ce?.edge ?? null, covered: cutCoverFar(c, group.axis, group.side, group.placement, rect.front), dir: { x: -B / len, y: A / len } });
  }
  return out;
}

// Açılı sınır panelinde alan çıpanın (tıklanan nokta) tarafına kırpılıp kutusuna daraltılır; eğik kenar applyBackCuts'ta çokgen kalır.
export function backRectByCuts(group: Pick<BackGroup, 'axis' | 'side' | 'placement' | 'thickness' | 'gap' | 'halfOverlay'>, rect: BackRect, cuts: BackCut[], anchor?: [number, number]): BackRect {
  if (!anchor || !cuts.length) return rect;
  // Boşluksuz kırpılır: kenar boşluğu kökte (solveBackTree) düşülür.
  const poly = clipMemberByCuts(rect, cuts, group.axis, group.side, group.placement, group.thickness, rect.front, 0, group.halfOverlay, anchor);
  if (!poly || poly.length < 3) return rect;
  const xs = poly.map(q => q.x), ys = poly.map(q => q.y);
  const out: BackRect = { u0: Math.min(...xs), u1: Math.max(...xs), v0: Math.min(...ys), v1: Math.max(...ys), front: rect.front };
  if (out.u1 - out.u0 < MIN_BACK_SPAN || out.v1 - out.v0 < MIN_BACK_SPAN) return rect;
  return out;
}

/** Bölge dikdörtgeninin açılı panellerle kırpılmış şekli; withGap=false → kesici yüzünde (şema boşluk şeritlerinin kırpma alanı). */
export function backCutOutline(group: CutGroup, rect: BackRect, r: { u0: number; u1: number; v0: number; v1: number }, cuts: BackCut[], withGap = true): Pt2[] {
  const base: Pt2[] = [{ x: r.u0, y: r.v0 }, { x: r.u1, y: r.v0 }, { x: r.u1, y: r.v1 }, { x: r.u0, y: r.v1 }];
  if (!cuts.length) return base;
  return clipMemberByCuts(r, cuts, group.axis, group.side, group.placement, group.thickness, rect.front, withGap ? backEdgeGapsOf(group) : 0, group.halfOverlay, group.anchor) ?? base;
}

// createPanelFromVirtualFace −normal yönünde t uzar → VF düzlemi arkalığın DIŞ yüzü: çakma ön + side·t, kanallı ön.
function backMemberVfGeometry(group: Pick<BackGroup, 'axis' | 'side' | 'placement' | 'thickness'>, m: BackMemberRect, rect: BackRect): { normal: Vec3; vertices: Vec3[]; center: Vec3 } {
  const { u, v } = backPlaneAxes(group.axis);
  const plane = group.placement === 'outer' ? rect.front + group.side * group.thickness : rect.front;
  const mk = (uu: number, vv: number): Vec3 => { const p: Vec3 = [0, 0, 0]; p[group.axis] = plane; p[u] = uu; p[v] = vv; return p; };
  const normal: Vec3 = [0, 0, 0]; normal[group.axis] = group.side;
  const vertices = m.poly ? m.poly.map(q => mk(q.x, q.y)) : [mk(m.u0, m.v0), mk(m.u1, m.v0), mk(m.u1, m.v1), mk(m.u0, m.v1)];
  const c = m.poly ? m.poly.reduce((a, q) => ({ x: a.x + q.x / m.poly!.length, y: a.y + q.y / m.poly!.length }), { x: 0, y: 0 }) : { x: (m.u0 + m.u1) / 2, y: (m.v0 + m.v1) / 2 };
  return { normal, vertices, center: mk(c.x, c.y) };
}

function backVfPatch(vf: VirtualFace, group: BackGroup, sol: BackSolution): Partial<VirtualFace> | null {
  const i = vf.backIndex ?? group.memberVfIds.indexOf(vf.id);
  const m = sol.members[i];
  if (!m) return null;
  const g = backMemberVfGeometry(group, m, sol.rect);
  return { normal: g.normal, vertices: g.vertices, center: g.center, regionAnchor: g.center } as any;
}

/** Regen kancası (PanelEngine): gövdenin arkalık VF'lerini grup çözümüyle yeniden yazar. */
export function recalculateBackVfs(parent: Shape, vfs: VirtualFace[], shapes: Shape[], groups: BackGroup[]): Map<string, VirtualFace> {
  const out = new Map<string, VirtualFace>();
  for (const g of groups) {
    if (g.shapeId !== parent.id) continue;
    const sol = solveBackGroup(g, parent, shapes);
    if (!sol) continue;
    for (const vf of vfs) {
      if (vf.shapeId !== parent.id || vf.backGroupId !== g.id) continue;
      const patch = backVfPatch(vf, g, sol);
      if (patch) out.set(vf.id, { ...vf, ...patch });
    }
  }
  return out;
}

/** Derz: iki parça arası boşluk [p0, p1], çapraz eksende [c0, c1]. */
export interface BackJoint { splitId: string; k: number; axis: 'u' | 'v'; p0: number; p1: number; c0: number; c1: number }
export function backJoints(solved: BackNodeSolved): BackJoint[] {
  const out: BackJoint[] = [];
  const walk = (n: BackNodeSolved) => {
    if (n.kind !== 'split') return;
    let p = n.axis === 'u' ? n.u0 : n.v1;
    n.children.forEach((c, i) => {
      const w = Math.max(0, n.sizes[i]?.value ?? 0), g = n.gaps[i] ?? 0;
      if (n.axis === 'u') { p += w; if (i < n.children.length - 1) { out.push({ splitId: n.id, k: i, axis: 'u', p0: p, p1: p + g, c0: n.v0, c1: n.v1 }); p += g; } }
      else { p -= w; if (i < n.children.length - 1) { out.push({ splitId: n.id, k: i, axis: 'v', p0: p - g, p1: p, c0: n.u0, c1: n.u1 }); p -= g; } }
      walk(c);
    });
  };
  walk(solved);
  return out;
}

export interface BackNearPanel {
  vfId: string; panelId: string; name: string;
  kind: 'u' | 'v';
  a0: number; a1: number; c0: number; c1: number;
  behind: boolean;
  /** Grup kenarı levhası: bini / kanal girişi geçerli, hizalama yok. */
  edge?: BackEdgeKey;
  groupId?: string; memberIndex?: number;
  joint?: BackJoint;
  /** Derz levhaya bağlı (BackNode.refs). */
  ref?: { splitId: string; k: number; align: BackAlign };
  poly?: Pt2[];
}

// Şemada gösterilecek sınır levhaları (çakmada bini, kanallıda kenar şeritleri kanal girişini taşır). allPanels=true → işaretsizler de.
export function backNearPanels(group: BackGroup, parent: Shape, shapes: Shape[], vfs: VirtualFace[], panelGroups: PanelGroup[], members?: BackMemberRect[], allPanels = false): BackNearPanel[] {
  const { u, v } = backPlaneAxes(group.axis);
  const solved = solveBackTree(group);
  const ms = members ?? backMemberRects(solved);
  const joints = backJoints(solved);
  const near = Math.max(group.gap, 0) + NEAR_EXTRA;
  const front = group.rect.front;
  const rb = resolveBackBounds(group, parent, shapes, vfs);
  const edgeOf = (vfId: string): BackEdgeKey | undefined => (['uMin', 'uMax', 'vMin', 'vMax'] as BackEdgeKey[]).find(k => rb[k]?.vfId === vfId);
  const refs = backJointRefs(group.tree);
  const out: BackNearPanel[] = [];
  for (const bp of collectBackBoundPanels(parent, shapes, vfs, !allPanels)) {
    const b = bp.box;
    const tu = b.max[u] - b.min[u], tv = b.max[v] - b.min[v];
    let kind: 'u' | 'v';
    if (tu <= THIN_PANEL && tu <= tv) kind = 'u'; else if (tv <= THIN_PANEL) kind = 'v'; else continue;
    const a0 = kind === 'u' ? b.min[u] : b.min[v], a1 = kind === 'u' ? b.max[u] : b.max[v];
    const c0 = kind === 'u' ? b.min[v] : b.min[u], c1 = kind === 'u' ? b.max[v] : b.max[u];
    const touching = ms.some(m => {
      const mc0 = kind === 'u' ? m.v0 : m.u0, mc1 = kind === 'u' ? m.v1 : m.u1;
      const ma0 = kind === 'u' ? m.u0 : m.v0, ma1 = kind === 'u' ? m.u1 : m.v1;
      if (Math.min(mc1, c1) - Math.max(mc0, c0) < TOL) return false;
      return Math.max(ma0, a0) - Math.min(ma1, a1) <= near;
    });
    if (!touching) continue;
    const behind = group.side > 0 ? b.max[group.axis] <= front + TOL : b.min[group.axis] >= front - TOL;
    const vf = vfs.find(f => f.id === bp.vfId);
    const pg = vf?.groupId ? panelGroups.find(g => g.id === vf.groupId) : undefined;
    const memberIndex = pg ? (vf!.groupIndex ?? pg.memberVfIds.indexOf(vf!.id)) : undefined;
    const edge = edgeOf(bp.vfId);
    // Derz: bağlıysa o derz; değilse aynı eksende çapraz örtüşen en yakını. Kenar levhasında aranmaz.
    let joint: BackJoint | undefined, ref: BackNearPanel['ref'];
    if (!edge) {
      const bound = refs.find(r => r.ref.vfId === bp.vfId && joints.some(j => j.splitId === r.splitId && j.k === r.k && j.axis === kind));
      if (bound) { ref = { splitId: bound.splitId, k: bound.k, align: bound.ref.align }; joint = joints.find(j => j.splitId === bound.splitId && j.k === bound.k); }
      else {
        const pc = (a0 + a1) / 2, t = a1 - a0;
        let best = Infinity;
        for (const j of joints) {
          if (j.axis !== kind || Math.min(j.c1, c1) - Math.max(j.c0, c0) < TOL) continue;
          const d = Math.abs((j.p0 + j.p1) / 2 - pc);
          if (d <= t / 2 + (j.p1 - j.p0) / 2 + BACK_JOINT_NEAR && d < best) { best = d; joint = j; }
        }
      }
    }
    const ps = shapeById(bp.panelId, shapes);
    const hull = ps ? panelFrontHull(ps, parent, u, v) : null;
    const boxArea = (b.max[u] - b.min[u]) * (b.max[v] - b.min[v]);
    const poly = hull && hull.length >= 3 && boxArea - Math.abs(polyArea(hull)) > Math.max(1, boxArea * 1e-3) ? hull : undefined;
    out.push({ vfId: bp.vfId, panelId: bp.panelId, name: bp.name, kind, a0, a1, c0, c1, behind, edge, groupId: pg?.id, memberIndex, joint, ref, poly });
  }
  return out;
}

const groupById = (id: string) => useAppStore.getState().backGroups.find(g => g.id === id);

function solveFromStore(group: BackGroup): BackSolution | null {
  const st = useAppStore.getState();
  const parent = shapeById(group.shapeId, st.shapes);
  return parent ? solveBackGroup(group, parent, st.shapes) : null;
}

/** Canlı önizlemede oran tabanı = düzenleme başındaki ağaç; önizleme ağacından oranlansa MIN kırpması oranları kalıcı bozar. */
let sizeEditBase: { groupId: string; tree: BackNode } | null = null;

const fallbackSolution = (group: BackGroup): BackSolution => {
  const solved = solveBackTree(group);
  return { rect: group.rect, tree: solvedToBackTree(solved), solved, members: backMemberRects(solved) };
};

function makeMemberVf(group: BackGroup, i: number, sol: BackSolution): VirtualFace {
  const g = backMemberVfGeometry(group, sol.members[i], sol.rect);
  return {
    id: genId('vf-back'), shapeId: group.shapeId,
    normal: g.normal, center: g.center, vertices: g.vertices,
    description: backGroupName(group), hasPanel: false,
    parentFaceShape: false, interior: true, backGroupId: group.id, backIndex: i,
    ...({ regionAnchor: g.center } as any),
  };
}

function removeMembers(vfIds: string[]): void {
  const st = useAppStore.getState();
  for (const vfId of vfIds) {
    const p = panelOfVf(vfId, st.shapes);
    if (p) st.deleteShape(p.id);
    st.deleteVirtualFace(vfId);
    if (useAppStore.getState().selectedPanelRow === `vf-${vfId}`) st.setSelectedPanelRow(null);
  }
}

export function createBackGroupFromPick(shapeId: string, pick: BackPick, placement: BackPlacement, name?: string): BackGroup | null {
  const st = useAppStore.getState();
  const parent = shapeById(shapeId, st.shapes);
  if (!parent) return null;
  const rect = placement === 'inner' ? { ...pick.inner } : { ...pick.outer };
  const group: BackGroup = {
    id: genId('back'), shapeId, setback: BACK_SETBACK, axis: pick.axis, side: pick.side, placement, bounds: pick.bounds, depthRef: pick.depth, rect, anchor: pick.at,
    tree: makeBackLeaf(),
    edgeGaps: backEdgeGapsDefault({ bounds: pick.bounds, placement }),
    gap: BACK_GAP, thickness: BACK_THICKNESS,
    memberVfIds: [], name: name?.trim() || 'Back', createdAt: Date.now(),
  };
  const sol = solveFromStore(group) || fallbackSolution(group);
  const vfs = sol.members.map((_, i) => makeMemberVf(group, i, sol));
  group.memberVfIds = vfs.map(v => v.id);
  group.rect = sol.rect;
  st.addBackGroup(group);
  st.insertVirtualFacesAfter(null, vfs);
  st.setSelectedBackGroupId(group.id);
  return group;
}

export function confirmBackPick(shapeId: string, pick: BackPick | undefined): void {
  const st = useAppStore.getState();
  if (!pick) return;
  createBackGroupFromPick(shapeId, pick, st.backPickPlacement, st.placementName);
  st.setBackPickMode(false);
}

/** Çözümü üye VF'lere yazar + tam rebuild. preview: yalnız grup (ağaç) store'a yazılır, VF ve rebuild yok. */
async function writeBackGroup(group: BackGroup, patch: Partial<BackGroup>, preview = false): Promise<void> {
  if (!preview) sizeEditBase = null;
  const st = useAppStore.getState();
  const next: BackGroup = { ...group, ...patch };
  const sol = solveFromStore(next) || fallbackSolution(next);
  if (preview) { st.updateBackGroup(group.id, { ...patch, rect: sol.rect, tree: sol.tree }); return; }
  for (const vfId of next.memberVfIds) {
    const vf = useAppStore.getState().virtualFaces.find(f => f.id === vfId);
    if (!vf) continue;
    const p = backVfPatch(vf, next, sol);
    if (p) st.updateVirtualFace(vf.id, p);
  }
  st.updateBackGroup(group.id, { ...patch, rect: sol.rect, tree: sol.tree });
  await requestRebuild(group.shapeId);
}

// Yapı değişince: yaprak id'si eşleşen VF/paneller (adımlarıyla) korunur, yalnız backIndex yazılır; eksikler yeni VF
// (paneli otomatik üretim yaratır). restructured = üyeleri her durumda yenilenecek yapraklar.
function rebuildMembers(group: BackGroup, nextGroup: BackGroup, restructured: Set<string>): void {
  const st = useAppStore.getState();
  const sol = solveFromStore(nextGroup) || fallbackSolution(nextGroup);
  const oldMembers = fallbackSolution(group).members;
  const oldIds = new Map<string, string>();
  if (oldMembers.length === group.memberVfIds.length) oldMembers.forEach((m, i) => { if (group.memberVfIds[i]) oldIds.set(m.leafId, group.memberVfIds[i]); });
  else console.warn('[YAGO][ARKALIK] üye sayısı tutmuyor, tüm üyeler yeniden kuruluyor:', oldMembers.length, 'vs', group.memberVfIds.length);
  const ids: string[] = [], kept: string[] = [], fresh: VirtualFace[] = [];
  sol.members.forEach((m, i) => {
    const prev = restructured.has(m.leafId) ? undefined : oldIds.get(m.leafId);
    if (prev) { ids.push(prev); kept.push(prev); }
    else { const vf = makeMemberVf(nextGroup, i, sol); ids.push(vf.id); fresh.push(vf); }
  });
  removeMembers(group.memberVfIds.filter(id => !kept.includes(id)));
  for (const id of kept) st.updateVirtualFace(id, { backIndex: ids.indexOf(id) });
  st.updateBackGroup(group.id, { ...nextGroup, rect: sol.rect, tree: sol.tree, memberVfIds: ids });
  // Yeni parçalar korunan son üyeden sonra eklenir: grup listede bir arada kalır.
  const order = useAppStore.getState().virtualFaces.map(f => f.id);
  const lastKept = kept.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b)).pop() ?? null;
  st.insertVirtualFacesAfter(lastKept, fresh);
  if (useAppStore.getState().selectedBackGroupId !== group.id && !useAppStore.getState().selectedPanelRow) st.setSelectedBackGroupId(group.id);
}

// Yaprak → split; aynı eksenli split → çocuk ekle/çıkar (count = 1 → ilk parça kalır); diğer eksen → sarılır, mevcut bölme her
// parçada kopyalanır. Üst ölçüler değişmez. Döner: sonuç düğümün id'si (arayüz seçimi), işlem yoksa null.
export function setBackNodeSplit(groupId: string, nodeId: string, axis: 'u' | 'v', count: number, opts: { keepTargetSize?: boolean } = {}): string | null {
  const group = groupById(groupId);
  const node = group ? findBackNode(group.tree, nodeId) : null;
  if (!group || !node || !Number.isFinite(count)) return null;
  const n = Math.max(1, Math.min(MAX_BACK_SPLIT, Math.round(count)));
  const newLeaves = (k: number) => Array.from({ length: k }, () => makeBackLeaf());
  const gapsFor = (m: number, old: number[] = []) => Array.from({ length: m }, (_, i) => old[i] ?? old[0] ?? group.gap);
  if (node.kind === 'leaf') {
    if (n <= 1) return node.id;
    const split: BackNode = { id: genId('bs'), kind: 'split', axis, sizes: [], gaps: gapsFor(n - 1), children: newLeaves(n) };
    rebuildMembers(group, { ...group, tree: replaceBackNode(group.tree, node.id, () => split) }, new Set([node.id]));
    return split.id;
  }
  if (node.axis === axis) {
    if (n === node.children.length) return node.id;
    if (n <= 1) {
      const first = node.children[0];
      const gone = new Set(node.children.slice(1).flatMap(c => backLeaves(c).map(l => l.id)));
      rebuildMembers(group, { ...group, tree: replaceBackNode(group.tree, node.id, () => first) }, gone);
      return first.id;
    }
    const restructured = new Set<string>();
    let children = node.children.slice();
    if (n > children.length) {
      // Artış: son parça bir bölmeyse yeni parçalar onun kopyası (bölünmüş hal korunur), değilse eşit yeni parçalar.
      const last = children[children.length - 1];
      children = [...children, ...(last.kind === 'split' ? Array.from({ length: n - children.length }, () => cloneBackNode(last)) : newLeaves(n - children.length))];
    } else { for (const c of children.slice(n)) for (const l of backLeaves(c)) restructured.add(l.id); children = children.slice(0, n); }
    // Elle sayı girildiyse spacing hedefi kalkar; derz bağları kalan derzlerde (k < n−1) korunur.
    const refs = Object.fromEntries(Object.entries(node.refs ?? {}).filter(([k]) => +k < n - 1)) as Record<number, BackJointRef>;
    const next: BackNode = { ...node, children, gaps: gapsFor(n - 1, node.gaps), sizes: [], targetSize: opts.keepTargetSize ? node.targetSize : undefined, refs: Object.keys(refs).length ? refs : undefined };
    rebuildMembers(group, { ...group, tree: replaceBackNode(group.tree, node.id, () => next) }, restructured);
    return node.id;
  }
  if (n <= 1) return node.id;
  const wrap: BackNode = { id: genId('bs'), kind: 'split', axis, sizes: [], gaps: gapsFor(n - 1), children: [node, ...Array.from({ length: n - 1 }, () => cloneBackNode(node))] };
  rebuildMembers(group, { ...group, tree: replaceBackNode(group.tree, node.id, () => wrap) }, new Set());
  return wrap.id;
}

/** Panel ref: levhanın merkezinden geçen her parça ikiye bölünür, derz levhaya 'center' bağlanır (levha taşınınca arkalık izler). */
export function splitBackAtPanel(groupId: string, vfId: string): string[] {
  const group = groupById(groupId);
  if (!group) return [];
  const st = useAppStore.getState();
  const parent = shapeById(group.shapeId, st.shapes);
  if (!parent) return [];
  const np = backNearPanels(group, parent, st.shapes, st.virtualFaces, st.panelGroups).find(p => p.vfId === vfId);
  if (!np) { console.warn('[YAGO][ARKALIK-REF] seçilen panel bu arkalığın sınır levhası değil / arkalığa değmiyor:', vfId); return []; }
  if (np.edge) { console.warn('[YAGO][ARKALIK-REF] kenar levhası (grup sınırı) ile bölme yapılmaz:', np.name); return []; }
  if (!np.groupId) console.warn('[YAGO][ARKALIK-REF] levha raf/dikme üyesi değil — bölünür ve bağlanır ama rozetle taşınamaz (derz levhaya gider):', np.name);
  const solved = solveBackTree(group);
  const axis = np.kind, pc = (np.a0 + np.a1) / 2, g = group.gap;
  const hits: BackNodeSolved[] = [];
  const walk = (n: BackNodeSolved) => {
    if (n.kind === 'split') { n.children.forEach(walk); return; }
    const a0 = axis === 'u' ? n.u0 : n.v0, a1 = axis === 'u' ? n.u1 : n.v1, c0 = axis === 'u' ? n.v0 : n.u0, c1 = axis === 'u' ? n.v1 : n.u1;
    if (Math.min(c1, np.c1) - Math.max(c0, np.c0) < TOL) return;
    if (pc - g / 2 - a0 >= MIN_BACK_SPAN && a1 - (pc + g / 2) >= MIN_BACK_SPAN) hits.push(n);
  };
  walk(solved);
  if (!hits.length) { console.warn('[YAGO][ARKALIK-REF] levhanın merkezinden geçen bölünebilir parça yok:', np.name); return []; }
  let tree = group.tree;
  const ids: string[] = [], restructured = new Set<string>();
  for (const leaf of hits) {
    const split: BackNode = { id: genId('bs'), kind: 'split', axis, sizes: [], gaps: [g], refs: { 0: { vfId, align: 'center' } }, children: [makeBackLeaf(), makeBackLeaf()] };
    tree = replaceBackNode(tree, leaf.id, () => split);
    ids.push(split.id); restructured.add(leaf.id);
  }
  rebuildMembers(group, { ...group, tree }, restructured);
  return ids;
}

export const backCountForTargetSize = (L: number, size: number, g: number) => Math.max(1, Math.min(MAX_BACK_SPLIT, Math.round((L + g) / (Math.max(1, size) + g))));
/** Spacing: hedef parça ölçüsü split'e targetSize olarak yazılır, gövde boyutlanınca syncBackGroups yeniden sayar; null → hedef kalkar. */
export function setBackNodeSpacing(groupId: string, nodeId: string, axis: 'u' | 'v', size: number | null): string | null {
  const group = groupById(groupId);
  const node = group ? findBackNode(group.tree, nodeId) : null;
  if (!group || !node) return null;
  const sn = findSolvedBackNode(solveBackTree(group), nodeId);
  if (!sn) return null;
  if (size == null) {
    if (node.kind !== 'split' || !node.targetSize) return node.id;
    useAppStore.getState().updateBackGroup(groupId, { tree: replaceBackNode(group.tree, nodeId, old => ({ ...(old as any), targetSize: undefined })) });
    return node.id;
  }
  if (!Number.isFinite(size) || size < MIN_BACK_SPAN) return null;
  const L = axis === 'u' ? sn.u1 - sn.u0 : sn.v1 - sn.v0;
  const n = backCountForTargetSize(L, size, group.gap);
  const sameAxisSplit = node.kind === 'split' && node.axis === axis;
  const id = sameAxisSplit && n === node.children.length ? node.id : setBackNodeSplit(groupId, nodeId, axis, Math.max(2, n), { keepTargetSize: true });
  if (!id) return null;
  const g2 = groupById(groupId);
  if (!g2) return null;
  const target = findBackNode(g2.tree, id);
  if (!target || target.kind !== 'split') return id;
  useAppStore.getState().updateBackGroup(groupId, { tree: replaceBackNode(g2.tree, id, old => ({ ...(old as any), targetSize: round1(size) })) });
  return id;
}

export function backSpacingNodes(n: BackNode, axis: 'u' | 'v'): Array<Extract<BackNode, { kind: 'split' }>> {
  if (n.kind !== 'split') return [];
  const own = n.axis === axis && n.targetSize ? [n] : [];
  return [...own, ...n.children.flatMap(c => backSpacingNodes(c, axis))];
}
/** Kapsamdaki spacing hedefleri; alt ağaçta yoksa seçili bölgeyi ÜRETEN en yakın üst bölmenin hedefi. */
export function backSpacingTargetsInScope(tree: BackNode, scopeIds: string[], axis: 'u' | 'v'): Array<Extract<BackNode, { kind: 'split' }>> {
  const roots = (scopeIds.length ? scopeIds : [tree.id]).map(id => findBackNode(tree, id)).filter((n): n is BackNode => !!n);
  const out = new Map<string, Extract<BackNode, { kind: 'split' }>>();
  for (const r of roots) {
    const under = backSpacingNodes(r, axis);
    if (under.length) { for (const n of under) out.set(n.id, n); continue; }
    for (let par = findBackParent(tree, r.id); par; par = findBackParent(tree, par.id)) { if (par.axis === axis && par.targetSize) { out.set(par.id, par); break; } }
  }
  return [...out.values()];
}
export function clearBackSpacing(groupId: string, scopeIds: string[], axis: 'u' | 'v'): number {
  const group = groupById(groupId);
  if (!group) return 0;
  const ids = new Set(backSpacingTargetsInScope(group.tree, scopeIds, axis).map(n => n.id));
  if (!ids.size) return 0;
  let tree = group.tree;
  for (const id of ids) tree = replaceBackNode(tree, id, old => ({ ...(old as any), targetSize: undefined }));
  useAppStore.getState().updateBackGroup(groupId, { tree });
  return ids.size;
}

export type BackEditOpts = { preview?: boolean };
/** k. ölçünün bitişik derzi (k ya da k−1) levhaya bağlı mı → ölçü levhadan türetilir, girilemez. */
export const backSizeBoundByJoint = (sn: Pick<Extract<BackNodeSolved, { kind: 'split' }>, 'refs'>, k: number): boolean => !!(sn.refs?.[k] || sn.refs?.[k - 1]);
// Bitişik derz levhaya bağlıysa ölçü LEVHAYI taşıyarak girilir (önce k., yoksa k−1. derz); taşınamazsa bağlı derz yine levhadan gelir.
export async function editBackSize(groupId: string, splitId: string, k: number, value: number, opts: BackEditOpts = {}): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value) || value <= 0) return;
  const sn = findSolvedBackNode(solveBackTree(group), splitId);
  if (!sn || sn.kind !== 'split' || k < 0 || k >= sn.children.length) return;
  if (passiveBackSizeIndex(sn.sizes, sn.children.length) === k) { console.warn('[YAGO][ARKALIK-KATSAYI] ölçü', k + 1, 'pasif (diğerleri pinli/kilitli, kalanı toplar) — giriş yok sayıldı', splitId); return; }
  // Bitişik derz levhaya bağlıysa ölçü levhadan gelir: giriş yok sayılır (levha taşınmaz, arkalık levhayı izler).
  if (backSizeBoundByJoint(sn, k)) { console.warn('[YAGO][ARKALIK-BAĞ] ölçü', k + 1, 'levhaya bağlı derze bitişik — değeri levhanın konumu belirler, giriş yok sayıldı', splitId); return; }
  const L = sn.axis === 'u' ? sn.u1 - sn.u0 : sn.v1 - sn.v0;
  const bn = sizeEditBase?.groupId === groupId ? findBackNode(sizeEditBase.tree, splitId) : null;
  const base = bn?.kind === 'split' && bn.sizes.length === sn.sizes.length ? bn.sizes : undefined;
  const sizes = applyGapEditProportional(sn.sizes, k, value, L, sn.gaps.length, sn.gaps, { base, min: MIN_BACK_SIZE, tag: '[YAGO][ARKALIK-KATSAYI]' });
  const tree = replaceBackNode(group.tree, splitId, old => ({ ...(old as any), sizes }));
  await writeBackGroup(group, { tree }, !!opts.preview);
}
/** Kilit rozeti: açık → pin → kilitli → açık; rebuild yok. Son açık ölçü pinlenemez / kilitlenemez. */
export function toggleBackSizeLock(groupId: string, splitId: string, k: number): void {
  const group = groupById(groupId);
  const sn = group ? findSolvedBackNode(solveBackTree(group), splitId) : null;
  if (!group || !sn || sn.kind !== 'split' || k < 0 || k >= sn.sizes.length) return;
  const sizes = cycleGapMode(sn.sizes, k, sn.children.length);
  if (!sizes) { console.warn('[YAGO][ARKALIK-KATSAYI] son açık ölçü pinlenemez/kilitlenemez (pasif, kalanı toplar):', splitId, 'ölçü', k + 1); return; }
  useAppStore.getState().updateBackGroup(groupId, { tree: replaceBackNode(group.tree, splitId, old => ({ ...(old as any), sizes })) });
}
export async function setBackSplitGap(groupId: string, splitId: string, k: number, value: number, opts: BackEditOpts = {}): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value) || value < 0) return;
  const sn = findSolvedBackNode(solveBackTree(group), splitId);
  if (!sn || sn.kind !== 'split' || k < 0 || k >= sn.gaps.length || (opts.preview && Math.abs(sn.gaps[k] - value) < 0.05)) return;   // onay hep yazar
  const gaps = sn.gaps.slice(); gaps[k] = round1(value);
  const tree = replaceBackNode(group.tree, splitId, old => ({ ...(old as any), gaps }));
  await writeBackGroup(group, { tree }, !!opts.preview);
}
export async function setBackEdgeGap(groupId: string, edge: BackEdgeKey, value: number, opts: BackEditOpts = {}): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value) || value < 0) return;
  const e = backEdgeGapsOf(group);
  if (opts.preview && Math.abs(e[edge] - value) < 0.05) return;   // onay hep yazar
  await writeBackGroup(group, { edgeGaps: { ...e, [edge]: round1(value) } }, !!opts.preview);
}
/** Kanallı: kenar panelinin içine giriş (mm, ≥ 0) — kenar boşluğu olarak NEGATİF yazılır. */
export async function setBackEdgeInset(groupId: string, edge: BackEdgeKey, inset: number, opts: BackEditOpts = {}): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(inset) || inset < 0) return;
  const e = backEdgeGapsOf(group), v = -round1(inset);
  if (opts.preview && Math.abs(e[edge] - v) < 0.05) return;   // onay hep yazar
  await writeBackGroup(group, { edgeGaps: { ...e, [edge]: v } }, !!opts.preview);
}
/** Kanallı: panellerin arka yüzünden arkalığın arka yüzüne mesafe (mm). */
export async function setBackSetback(groupId: string, mm: number): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(mm) || mm < 0) return;
  const v = round1(mm);
  if (Math.abs(v - backSetbackOf(group)) < 0.05) return;
  await writeBackGroup(group, { setback: v });
}
export interface BackLayoutSnap { tree: BackNode; edgeGaps?: BackEdgeGaps; gap: number; rect: BackRect }
export function backLayoutSnapshot(groupId: string): BackLayoutSnap | null {
  const g = groupById(groupId);
  sizeEditBase = g ? { groupId, tree: g.tree } : null;
  return g ? { tree: g.tree, edgeGaps: g.edgeGaps ? { ...g.edgeGaps } : undefined, gap: g.gap, rect: { ...g.rect } } : null;
}
export function restoreBackLayout(groupId: string, snap: BackLayoutSnap | null | undefined): void {
  sizeEditBase = null;
  if (!snap || !groupById(groupId)) return;
  useAppStore.getState().updateBackGroup(groupId, { tree: snap.tree, edgeGaps: snap.edgeGaps, gap: snap.gap, rect: snap.rect });
}
function equalizeTree(n: BackNode): BackNode {
  if (n.kind === 'leaf') return n;
  return { ...n, sizes: [], children: n.children.map(equalizeTree) };
}
export async function equalizeBackGroup(groupId: string): Promise<void> {
  const group = groupById(groupId);
  if (!group) return;
  await writeBackGroup(group, { tree: equalizeTree(group.tree) });
}
/** Tip (çakma/kanallı) değişince kenar boşlukları tipin varsayılanına döner (çakma 0 · kanallı −giriş); kanallıda bini bayrakları düşer. */
export async function setBackPlacement(groupId: string, placement: BackPlacement): Promise<void> {
  const group = groupById(groupId);
  if (!group || group.placement === placement) return;
  const patch: Partial<BackGroup> = placement === 'inner' && ((group.halfOverlay && Object.values(group.halfOverlay).some(Boolean)) || (group.noOverlay && Object.values(group.noOverlay).some(Boolean)))
    ? { placement, halfOverlay: {}, noOverlay: {} } : { placement };
  patch.edgeGaps = backEdgeGapsDefault({ bounds: group.bounds, placement });
  await writeBackGroup(group, patch);
}
export type BackEdgeOverlayMode = 'full' | 'half' | 'none';
export const backEdgeOverlayMode = (g: Pick<BackGroup, 'halfOverlay' | 'noOverlay'>, edge: BackEdgeKey): BackEdgeOverlayMode => (g.noOverlay?.[edge] ? 'none' : g.halfOverlay?.[edge] ? 'half' : 'full');
/** Kenar binisi (çakma): full = panel kalınlığını örter, half = ortasına, none = iç yüzünde biter. O eksendeki KÖK bölme yeniden eşit bölünür. */
export async function setBackEdgeOverlay(groupId: string, edge: BackEdgeKey, mode: BackEdgeOverlayMode): Promise<void> {
  const group = groupById(groupId);
  if (!group || backEdgeOverlayMode(group, edge) === mode) return;
  const halfOverlay = { ...(group.halfOverlay ?? {}), [edge]: mode === 'half' };
  const noOverlay = { ...(group.noOverlay ?? {}), [edge]: mode === 'none' };
  const isU = edge === 'uMin' || edge === 'uMax';
  const root = group.tree;
  const tree: BackNode = root.kind === 'split' && root.axis === (isU ? 'u' : 'v') ? { ...root, sizes: [] } : root;
  await writeBackGroup(group, { halfOverlay, noOverlay, tree });
}
/** Açılı sınır levhasının yarım binisi: kesilen kenarın halfOverlay bayrağı. */
export async function setBackHalfOverlay(groupId: string, edge: BackEdgeKey, on: boolean): Promise<void> {
  const group = groupById(groupId);
  if (!group || !!group.halfOverlay?.[edge] === on) return;
  const halfOverlay = { ...(group.halfOverlay ?? {}), [edge]: on };
  const noOverlay = on && group.noOverlay?.[edge] ? { ...group.noOverlay, [edge]: false } : group.noOverlay;
  const isU = edge === 'uMin' || edge === 'uMax';
  const root = group.tree;
  const tree: BackNode = root.kind === 'split' && root.axis === (isU ? 'u' : 'v') ? { ...root, sizes: [] } : root;
  await writeBackGroup(group, { halfOverlay, noOverlay, tree });
}
/** Panel ref ile bölünebilir mi: levhanın ortası bir parçanın içinden, iki yanda en az MIN_BACK_SPAN kalarak geçmeli. */
export function canSplitBackAtPanel(group: BackGroup, np: Pick<BackNearPanel, 'kind' | 'a0' | 'a1' | 'c0' | 'c1' | 'edge'>): boolean {
  if (np.edge) return false;
  const pc = (np.a0 + np.a1) / 2, g = group.gap, axis = np.kind;
  let ok = false;
  const walk = (n: BackNodeSolved) => {
    if (ok) return;
    if (n.kind === 'split') { n.children.forEach(walk); return; }
    const a0 = axis === 'u' ? n.u0 : n.v0, a1 = axis === 'u' ? n.u1 : n.v1, c0 = axis === 'u' ? n.v0 : n.u0, c1 = axis === 'u' ? n.v1 : n.u1;
    if (Math.min(c1, np.c1) - Math.max(c0, np.c0) < TOL) return;
    if (pc - g / 2 - a0 >= MIN_BACK_SPAN && a1 - (pc + g / 2) >= MIN_BACK_SPAN) ok = true;
  };
  walk(solveBackTree(group));
  return ok;
}
export async function setBackThickness(groupId: string, t: number): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(t) || t < 1) return;
  const v = round1(t);
  if (Math.abs(v - group.thickness) < 0.05) return;
  const st = useAppStore.getState();
  for (const vfId of group.memberVfIds) {
    const panel = panelOfVf(vfId, st.shapes);
    if (panel) st.updateShape(panel.id, { parameters: { ...panel.parameters, panelThickness: v, depth: v } } as any);
  }
  await writeBackGroup(group, { thickness: v });
}
export function renameBackGroup(groupId: string, name: string): void {
  const group = groupById(groupId);
  if (!group) return;
  useAppStore.getState().updateBackGroup(groupId, { name });
  const ids = new Set(group.memberVfIds);
  useAppStore.setState(s => ({ virtualFaces: s.virtualFaces.map(f => (ids.has(f.id) ? { ...f, description: name } : f)) }));
}
export function deleteBackGroupWithMembers(groupId: string): void {
  const group = groupById(groupId);
  if (!group) return;
  removeMembers(group.memberVfIds);
  useAppStore.getState().deleteBackGroup(groupId);
}

function pruneBackRefs(tree: BackNode, solved: BackNodeSolved, vfs: VirtualFace[]): BackNode | null {
  let out = tree, changed = false;
  for (const { splitId, k, ref } of backJointRefs(tree)) {
    if (vfs.some(f => f.id === ref.vfId)) continue;
    const sn = findSolvedBackNode(solved, splitId);
    out = replaceBackNode(out, splitId, old => {
      const o = old as Extract<BackNode, { kind: 'split' }>;
      const refs = { ...(o.refs ?? {}) }; delete refs[k];
      const sizes = sn && sn.kind === 'split' ? sn.sizes.map(s => ({ ...s, edited: true })) : o.sizes;
      return { ...o, sizes, refs: Object.keys(refs).length ? refs : undefined };
    });
    changed = true;
    console.warn('[YAGO][ARKALIK-BAĞ] bağlı levha silinmiş, bağ düştü (ölçüler donduruldu):', splitId, 'derz', k, ref.vfId);
  }
  return changed ? out : null;
}

/** KISALTMA KURALI (PanelGroupService.groupObstacles): kanallı BÜTÜN arkalık, üyesi arkalık-sınırı olan raf/dikme grubunun hacim
 *  engelidir → levha arkalığın ön yüzünde biter. Arkalık grubun bir üyesinde BÖLÜNMÜŞSE (derz bağı) engel değildir: parçalar
 *  levhanın ortasına kadar girer (iki yandan kanallı), levha tam boy kalır. Çakma arkalık gövdenin dışındadır, kısaltmaz. */
export function backShortensGroup(group: PanelGroup, backPanel: Shape, backGroups: BackGroup[] = useAppStore.getState().backGroups, vfs: VirtualFace[] = useAppStore.getState().virtualFaces): boolean {
  const bg = backGroups.find(g => g.id === (backPanel.parameters as any)?.backGroupId);
  if (!bg || bg.placement !== 'inner' || bg.shapeId !== group.shapeId) return false;
  if (!group.memberVfIds.some(id => vfBackBound(vfs.find(f => f.id === id)))) return false;
  const bound = new Set(backJointRefs(bg.tree).map(r => r.ref.vfId));
  return !group.memberVfIds.some(id => bound.has(id));
}

/** Rebuild sonrası (PanelEngine): store'daki dikdörtgen/ağaç güncel çözümle eşitlenir (bağlı derzlerin izlediği levha dahil). */
export function syncBackGroups(parentShapeId: string): void {
  const st = useAppStore.getState();
  const parent = shapeById(parentShapeId, st.shapes);
  if (!parent) return;
  for (const g of st.backGroups) {
    if (g.shapeId !== parentShapeId) continue;
    const sol = solveBackGroup(g, parent, st.shapes);
    if (!sol) continue;
    const pruned = pruneBackRefs(g.tree, sol.solved, st.virtualFaces);
    if (pruned) { st.updateBackGroup(g.id, { rect: sol.rect, tree: pruned, ...(sol.bounds && !sameBounds(sol.bounds, g.bounds) ? { bounds: sol.bounds } : {}) }); continue; }
    // Devralınan kenar (sonradan konan sınır levhası) kalıcı yazılır: şema ve sonraki çözümler aynı kenarı görsün.
    if (sol.bounds && !sameBounds(sol.bounds, g.bounds)) { st.updateBackGroup(g.id, { bounds: sol.bounds, rect: sol.rect, tree: sol.tree }); continue; }
    const sameRefs = (a?: Record<number, BackJointRef>, b?: Record<number, BackJointRef>) => {
      const ka = Object.keys(a ?? {}), kb = Object.keys(b ?? {});
      return ka.length === kb.length && ka.every(k => b?.[+k]?.vfId === a?.[+k]?.vfId && b?.[+k]?.align === a?.[+k]?.align);
    };
    const sameTree = (a: BackNode, b: BackNode): boolean => {
      if (a.kind !== b.kind || a.id !== b.id) return false;
      if (a.kind === 'leaf' || b.kind === 'leaf') return true;
      return a.children.length === b.children.length && a.sizes.length === b.sizes.length
        && a.sizes.every((x, i) => Math.abs(x.value - b.sizes[i].value) < 0.05 && x.locked === b.sizes[i].locked && !!x.edited === !!b.sizes[i].edited)
        && a.gaps.length === b.gaps.length && a.gaps.every((x, i) => Math.abs(x - b.gaps[i]) < 0.05) && sameRefs(a.refs, b.refs) && a.children.every((c, i) => sameTree(c, b.children[i]));
    };
    // Spacing: alan değiştiyse parça sayısı yeniden türetilir; sonraki rebuild aynı n'i bulup durur (döngü yok).
    try {
      const resize: Array<{ id: string; axis: 'u' | 'v'; n: number; cur: number }> = [];
      const scan = (n: BackNodeSolved) => {
        if (n.kind !== 'split') return;
        if (n.targetSize) { const L = n.axis === 'u' ? n.u1 - n.u0 : n.v1 - n.v0; const want = Math.max(2, backCountForTargetSize(L, n.targetSize, g.gap)); if (want !== n.children.length) resize.push({ id: n.id, axis: n.axis, n: want, cur: n.children.length }); }
        n.children.forEach(scan);
      };
      scan(sol.solved);
      for (const r of resize.slice(0, 1)) { setBackNodeSplit(g.id, r.id, r.axis, r.n, { keepTargetSize: true }); }
      if (resize.length) continue;   // üyeler yeniden kuruluyor; bu grubun senkronu bir sonraki rebuild'de
    } catch (err) { console.warn('[YAGO][ARKALIK-SPACING] hata:', err instanceof Error ? err.message : String(err)); }
    if (rectKey(sol.rect) === rectKey(g.rect) && Math.abs(sol.rect.front - g.rect.front) < 0.05 && sameTree(sol.tree, g.tree)) continue;
    st.updateBackGroup(g.id, { rect: sol.rect, tree: sol.tree });
  }
}

/** Seçme önizlemesi: adayın levhası (açılı sınırlarla kırpılmış çokgen prizma). */
export function backSlabPolygon(
  group: Pick<BackGroup, 'axis' | 'side' | 'placement' | 'thickness' | 'gap' | 'anchor'>, rect: BackRect, cuts: BackCut[],
): { normal: Vec3; vertices: Vec3[] } {
  const m: BackMemberRect = { leafId: PREVIEW_ID, u0: rect.u0, u1: rect.u1, v0: rect.v0, v1: rect.v1 };
  const [mm] = applyBackCuts(group, rect, [m], cuts);
  const g = backMemberVfGeometry(group, mm, rect);
  return { normal: g.normal, vertices: g.vertices };
}
