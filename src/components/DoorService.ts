import {
  type CavityBox, type DoorAlign, type DoorBond, type DoorBoundRef, type DoorBounds, type DoorEdgeGaps, type DoorGroup, type DoorJointRef, type DoorLeafSplit, type DoorNode, type DoorPick, type DoorRect, type DoorType, type GapSpec, type PanelGroup, type Shape, type VirtualFace,
  panelOfVf, requestRebuild, shapeById, useAppStore,
} from '../store';
import * as THREE from 'three';
import { type Vec3, genId, round1 } from './Geometry';
import { convexHull2D, largestFaceNormal, panelHasRotation } from './FaceRegion';
import {
  GROUP_PANEL_THICKNESS, type GapMode, applyGapEdit, applyGapEditProportional, bodyLocalBox, boxSpan, collectObstacles, createPanelGroupFromCavity, cycleGapMode, editGroupGap, fmtBox, gapMode,
  gridForObstacles, groupFacing, memberThicknessesOf, panelLocalBox, passiveGapIndex, rayCavityCandidates, redistributeForThickness, rescaleGaps,
} from './PanelGroupService';

// KAPAKLAR (DoorService)
//  • Sınır = VF.doorBound işaretli paneller; yoksa gövde kenarı. Düzlem = tıklanan gövde yüzü; u = yatay (sütun), v = düşey (satır).
//  • İç kapak sınır panellerinin İÇ yüzleri arasına, dış kapak DIŞ yüzlerine kadar (gövdenin dışına taşabilir).
//  • Bölme = AĞAÇ (DoorGroup.tree); split alanını çocuklarına KATSAYI kuralıyla dağıtır, bölmek üst ölçüsünü değiştirmez.
//  • Kapak VF'leri her rebuild'de buradan yazılır; kapak panelleri DAMGALAMAZ, hacim engeli değildir, gövdeyle kesilmez.
//  • Dönmüş sınır paneli kenar olmaz; kapağı büyük-yüz düzlemiyle keser (kapak düzlemi değişmez).
//  • Bağ yönü tek: ya derz levhayı izler (DoorNode.refs) ya levha derzi (PanelGroup.doorBond) — ikisi birden yasak.

export const DOOR_THICKNESS = 18;
export const DOOR_GAP = 3;
const TOL = 0.5;
const MIN_DOOR_SPAN = 40;
const PREVIEW_ID = 'önizleme';
const MAX_DOOR_SPLIT = 12;
const NEAR_EXTRA = 3;        // kapak kenarı ile levha arasındaki "yaklaşma" payı (mm), boşluğun üstüne
const THIN_PANEL = 60;       // levha sayılacak en büyük kalınlık (mm); daha kalını (arkalık vb.) sayılmaz
export const JOINT_NEAR = 30;   // levha merkezi ile derz merkezi arası en büyük uzaklık (mm; + yarım kalınlık + yarım derz)

export const isDoorPanel = (p: any): boolean => !!p?.parameters?.doorGroupId;
export const isDoorVf = (vf: any): boolean => !!vf?.doorGroupId;
export const doorGroupName = (g: Pick<DoorGroup, 'name'>) => g.name ?? 'Door';
export const doorPlacementLabel = (p: DoorGroup['placement']) => (p === 'inner' ? 'Inner' : 'Outer');

export const DOOR_TYPES: DoorType[] = ['left', 'right', 'up', 'down', 'double', 'fold', 'drawer', 'fixed'];
export const DOOR_TYPE_LABEL: Record<DoorType, string> = { left: 'Left', right: 'Right', up: 'Up', down: 'Down', double: 'Double', fold: 'Fold', drawer: 'Drawer', fixed: 'Fixed' };
export const DOOR_TYPE_TITLE: Record<DoorType, string> = {
  left: 'Left — hinged on the left, opens to the right (as seen from the front)',
  right: 'Right — hinged on the right, opens to the left',
  up: 'Up — lift-up flap, hinged at the top',
  down: 'Down — drop-down flap, hinged at the bottom',
  double: 'Double — two leaves side by side (left + right hinged); the door is split in two, each leaf sized within the door',
  fold: 'Fold — bi-fold lift-up, two leaves stacked; the door is split in two vertically, each leaf sized within the door',
  drawer: 'Drawer — drawer front (no hinges, pulls out)',
  fixed: 'Fixed — no hinges; fixed / false front panel',
};
export const doorLeafAxis = (t: DoorType | undefined): 'u' | 'v' | null => (t === 'double' ? 'u' : t === 'fold' ? 'v' : null);
/** Varsayılan tip: sol yarı left, sağ yarı right (çift kapağın doğal menteşeleri). */
export const defaultDoorType = (c: number, count: number): DoorType => (count >= 2 && c >= count / 2 ? 'right' : 'left');

export function doorPlaneAxes(axis: 0 | 1 | 2): { u: 0 | 1 | 2; v: 0 | 1 | 2 } {
  if (axis === 2) return { u: 0, v: 1 };
  if (axis === 0) return { u: 2, v: 1 };
  return { u: 0, v: 2 };
}

export const fmtRect = (r: DoorRect) => `u ${r.u0.toFixed(0)}..${r.u1.toFixed(0)} v ${r.v0.toFixed(0)}..${r.v1.toFixed(0)} ön=${r.front.toFixed(0)}`;
const rectKey = (r: DoorRect) => [r.u0, r.u1, r.v0, r.v1].map(n => Math.round(n)).join('|');

/** Işının gövde kutusuna girdiği yüz (side: max yüz → +1, min yüz → −1) + nokta; kamera kutunun içindeyse null. */
export function rayDoorEntry(o: Vec3, d: Vec3, b: CavityBox): { axis: 0 | 1 | 2; side: 1 | -1; point: Vec3 } | null {
  let best = -Infinity, axis: 0 | 1 | 2 = 2, side: 1 | -1 = 1;
  for (const a of [0, 1, 2] as const) {
    if (Math.abs(d[a]) < 1e-9) continue;
    const t = d[a] > 0 ? (b.min[a] - o[a]) / d[a] : (b.max[a] - o[a]) / d[a];
    if (t > best) { best = t; axis = a; side = d[a] > 0 ? -1 : 1; }
  }
  if (!(best > 0)) return null;
  const point: Vec3 = [o[0] + d[0] * best, o[1] + d[1] * best, o[2] + d[2] * best];
  return { axis, side, point };
}

export interface DoorBoundPanel { vfId: string; panelId: string; box: CavityBox; name: string }

/** Kapak sınırı panelleri (gövde-yerel kutu); kapaklar ve dönmüş paneller hariç. onlyBound=false: işaretsizler de (derz parçalama). */
export function collectDoorBoundPanels(parent: Shape, shapes: Shape[] = useAppStore.getState().shapes, vfs: VirtualFace[] = useAppStore.getState().virtualFaces, onlyBound = true): DoorBoundPanel[] {
  const out: DoorBoundPanel[] = [];
  for (const vf of vfs) {
    if (vf.shapeId !== parent.id || (onlyBound && !vf.doorBound) || isDoorVf(vf)) continue;
    const p = panelOfVf(vf.id, shapes);
    if (!p || panelHasRotation(p)) continue;
    const box = panelLocalBox(p, parent);
    if (!box) continue;
    out.push({ vfId: vf.id, panelId: p.id, box, name: vf.description || 'Panel' });
  }
  return out;
}

/** Dönmüş sınır paneli: büyük-yüz normali + o normaldeki [dMin,dMax] + kutu; pts = tekil köşeler (şema ön görünüşü). */
export interface DoorCut { vfId: string; name: string; n: Vec3; dMin: number; dMax: number; box: CavityBox; pts?: Vec3[] }

export function collectDoorCuts(parent: Shape, shapes: Shape[] = useAppStore.getState().shapes, vfs: VirtualFace[] = useAppStore.getState().virtualFaces): DoorCut[] {
  const out: DoorCut[] = [];
  for (const vf of vfs) {
    if (vf.shapeId !== parent.id || !vf.doorBound || isDoorVf(vf)) continue;
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

export type Pt2 = { x: number; y: number };
function clipHalfPlane(poly: Pt2[], A: number, B: number, C: number): Pt2[] {
  const out: Pt2[] = [];
  const f = (p: Pt2) => A * p.x + B * p.y - C;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const fa = f(a), fb = f(b);
    if (fa <= 0) out.push(a);
    if ((fa < 0 && fb > 0) || (fa > 0 && fb < 0)) { const t = fa / (fa - fb); out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); }
  }
  return out;
}
export const polyArea = (p: Pt2[]) => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q.x * r.y - r.x * q.y; } return a / 2; };
/** Çokgeni DIŞBÜKEY çokgenle kırpar (yönelim CW / CCW fark etmez). */
export function clipPolyToConvex(poly: Pt2[], convex: Pt2[]): Pt2[] {
  if (convex.length < 3) return poly;
  const ccw = polyArea(convex) > 0;
  let out = poly;
  for (let i = 0; i < convex.length && out.length >= 3; i++) {
    const a = convex[i], b = convex[(i + 1) % convex.length];
    let A = b.y - a.y, B = -(b.x - a.x);   // CCW'de iç taraf kenarın solu: A·x + B·y ≤ A·ax + B·ay
    if (!ccw) { A = -A; B = -B; }
    out = clipHalfPlane(out, A, B, A * a.x + B * a.y);
  }
  return out;
}
function frontHullOf(pts: Iterable<Vec3>, u: 0 | 1 | 2, v: 0 | 1 | 2): Pt2[] {
  const out: Pt2[] = [], seen = new Set<string>();
  for (const q of pts) { const k = `${Math.round(q[u] * 10)},${Math.round(q[v] * 10)}`; if (seen.has(k)) continue; seen.add(k); out.push({ x: q[u], y: q[v] }); }
  return convexHull2D(out);
}
/** Panelin ön görünüşü (u,v izdüşüm zarfı, önbellekli): pahlı yan panel yamuktur, eksen-hizalı kutu eğik paneli örterdi. */
const _frontHullCache = new WeakMap<object, { key: string; hull: Pt2[] }>();
export function panelFrontHull(p: Shape, parent: Shape, u: 0 | 1 | 2, v: 0 | 1 | 2): Pt2[] | null {
  const pos = p.geometry?.getAttribute?.('position') as THREE.BufferAttribute | undefined;
  if (!pos || pos.count < 3) return null;
  const off = [0, 1, 2].map(k => (p.position?.[k] ?? 0) - (parent.position?.[k] ?? 0));
  const key = `${u}${v}:${off.map(x => x.toFixed(2)).join(',')}:${pos.count}:${pos.version}`;
  const hit = _frontHullCache.get(p.geometry);
  if (hit && hit.key === key) return hit.hull;
  const pts = function* () { for (let i = 0; i < pos.count; i++) yield [pos.getX(i) + off[0], pos.getY(i) + off[1], pos.getZ(i) + off[2]] as Vec3; };
  const hull = frontHullOf(pts(), u, v);
  _frontHullCache.set(p.geometry, { key, hull });
  return hull;
}

/** Dönmüş kesicinin kestiği KENAR = kaldırılan yönün baskın ekseni (eğik üst → vMax, eğik dikme → uMin/uMax). */
function cutEdgeOf(c: DoorCut, cu: number, cv: number, axis: 0 | 1 | 2, front: number): { edge: DoorEdgeKey; keepBelow: boolean } | null {
  const { u, v } = doorPlaneAxes(axis);
  const A = c.n[u], B = c.n[v], Na = c.n[axis];
  if (Math.abs(A) < 1e-6 && Math.abs(B) < 1e-6) return null;   // kapak düzlemine paralel: kesim anlamsız
  const keepBelow = A * cu + B * cv + Na * front < (c.dMin + c.dMax) / 2;
  const ru = keepBelow ? A : -A, rv = keepBelow ? B : -B;
  const edge: DoorEdgeKey = Math.abs(ru) >= Math.abs(rv) ? (ru > 0 ? 'uMax' : 'uMin') : (rv > 0 ? 'vMax' : 'vMin');
  return { edge, keepBelow };
}
const cutCoverFar = (c: DoorCut, axis: 0 | 1 | 2, side: 1 | -1, placement: DoorGroup['placement'], front: number) =>
  placement === 'outer' && (side > 0 ? c.box.max[axis] <= front + TOL : c.box.min[axis] >= front - TOL);

// Üyeyi dönmüş panellerin büyük-yüz düzlemleriyle kırpar; kesim kapağın İKİ yüzeyinde alınır, kısıtlayıcı olan tutulur
// (kapak eğik panele girmez). Kenar boşluğu = kesicinin kestiği kenarın boşluğu.
function clipMemberByCuts(
  m: { u0: number; u1: number; v0: number; v1: number }, cuts: DoorCut[], axis: 0 | 1 | 2, side: 1 | -1,
  placement: DoorGroup['placement'], thickness: number, front: number, gapIn: number | DoorEdgeGaps, half?: HalfOverlay, ref?: [number, number],
): Pt2[] | null {
  if (!cuts.length) return null;
  const { u, v } = doorPlaneAxes(axis);
  let poly: Pt2[] = [{ x: m.u0, y: m.v0 }, { x: m.u1, y: m.v0 }, { x: m.u1, y: m.v1 }, { x: m.u0, y: m.v1 }];
  const planes = placement === 'outer' ? [front, front + side * thickness] : [front - side * thickness, front];
  // Tutulan taraf: çıpa (tıklanan nokta / anchor) varsa o, yoksa üyenin merkezi.
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
    // Yarım binme: uzak yüz yerine levhanın ortası (düz kenardaki (iç+dış)/2 kuralı).
    const halfHere = coverFar && !!half?.[ce.edge];
    const mid = (c.dMin + c.dMax) / 2;
    let before = poly;
    if (keepBelow) {
      const lim = (halfHere ? mid : coverFar ? c.dMax : c.dMin) - gap;
      const C = Math.min(...planes.map(pa => lim - Na * pa));
      poly = clipHalfPlane(poly, A, B, C);
    } else {
      const lim = (halfHere ? mid : coverFar ? c.dMin : c.dMax) + gap;
      const C = Math.max(...planes.map(pa => lim - Na * pa));
      poly = clipHalfPlane(poly, -A, -B, -C);
    }
    if (poly.length < 3 || polyArea(poly) < MIN_DOOR_SPAN * MIN_DOOR_SPAN) { console.warn('[YAGO][KAPAK-AÇILI] kesim üyeyi yok ediyor, atlandı:', c.name); poly = before; continue; }
    if (poly.length !== before.length || poly.some((q, i) => Math.abs(q.x - before[i].x) > 1e-6 || Math.abs(q.y - before[i].y) > 1e-6)) any = true;
  }
  return any ? poly : null;
}

export function setVfDoorBound(vfId: string, on: boolean): void {
  const st = useAppStore.getState();
  const vf = st.virtualFaces.find(f => f.id === vfId);
  if (!vf || !!vf.doorBound === on) return;
  st.updateVirtualFace(vfId, { doorBound: on });
}

type SideOpt = { ref: DoorBoundRef; inner: number; outer: number; cross: [number, number]; front: number | null; name: string };
type EdgeInfo = { ref: DoorBoundRef; inner: number; outer: number; front: number | null };

// KENAR KURALI: P = derinlik referansının ön yüzü; outer [P, P+t], inner [P−t, P]. Inner → kenar İÇ yüz. Outer → panel kapağın
// gerisindeyse kalınlığını örter (DIŞ yüz), P'den öne taşıyorsa çarpmamak için İÇ yüz. Yarım binme yalnız örtülen kenarda: (iç+dış)/2.
type DoorEdges = { l: EdgeInfo; r: EdgeInfo; b: EdgeInfo; t: EdgeInfo };
type HalfOverlay = DoorGroup['halfOverlay'];
const edgeCovered = (x: EdgeInfo, side: 1 | -1, placement: DoorGroup['placement'], P: number) =>
  x.front != null && placement === 'outer' && (side > 0 ? x.front <= P + TOL : x.front >= P - TOL);
function rectAtDepth(e: DoorEdges, side: 1 | -1, placement: DoorGroup['placement'], P: number, half?: HalfOverlay): DoorRect {
  const pick = (x: EdgeInfo, h: boolean | undefined) => {
    if (!edgeCovered(x, side, placement, P)) return x.inner;
    return h ? (x.inner + x.outer) / 2 : x.outer;
  };
  return { u0: pick(e.l, half?.uMin), u1: pick(e.r, half?.uMax), v0: pick(e.b, half?.vMin), v1: pick(e.t, half?.vMax), front: P };
}
/** Dikdörtgenin kapak düzlemi = kenar panellerinin EN GERİDEKİ ön yüzü (tek seçenek); panel yoksa gövde yüzü. */
function depthOptions(e: EdgeInfo[], side: 1 | -1, bodyFront: number): Array<{ ref: DoorBoundRef; front: number }> {
  let best: { ref: DoorBoundRef; front: number } | null = null;
  for (const x of e) {
    if (x.front == null) continue;
    if (!best || side * (x.front - best.front) < 0) best = { ref: x.ref, front: x.front };
  }
  return [best ?? { ref: { body: true }, front: bodyFront }];
}

// Kapak adayları: dört yandaki sınır seçeneklerinin her kombinasyonu bir dikdörtgen; seçilen panel çapraz açıklıkla örtüşmeli
// (kısa dikme yalnız kendi boyunu sınırlar). Sıra: alan büyükten küçüğe (önce dıştakiler).
export function doorCandidatesAt(parent: Shape, axis: 0 | 1 | 2, side: 1 | -1, click: Vec3, shapes?: Shape[], vfs?: VirtualFace[]): DoorPick[] {
  const body = bodyLocalBox(parent);
  if (!body) return [];
  const { u, v } = doorPlaneAxes(axis);
  const bounds = collectDoorBoundPanels(parent, shapes, vfs);
  const cu = click[u], cv = click[v];
  const frontOf = (b: CavityBox) => (side > 0 ? b.max[axis] : b.min[axis]);
  const bodyFront = side > 0 ? body.max[axis] : body.min[axis];
  const bodyOpt = (edge: number, cross: [number, number]): SideOpt => ({ ref: { body: true }, inner: edge, outer: edge, cross, front: null, name: 'Body' });
  // Gövde kenarı da seçenektir, o yanda gövde kenarına dayanan sınır paneli yoksa (yalnız iç dikme işaretliyken BÜTÜN kapak da aday).
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
  // Açılı sınır panelleri: aday alanı tıklanan noktanın tarafına kırpılır (panelin iki yanına da kapak atılabilir).
  const cuts = collectDoorCuts(parent, shapes, vfs);
  const at: [number, number] = [cu, cv];
  const shrink = (placement: DoorGroup['placement'], r: DoorRect) => rectByCuts({ axis, side, placement, thickness: DOOR_THICKNESS, gap: DOOR_GAP }, r, cuts, at);
  const seen = new Set<string>();
  const out: DoorPick[] = [];
  for (const l of L) for (const r of R) for (const b of B) for (const t of T) {
    const between: DoorRect = { u0: l.inner, u1: r.inner, v0: b.inner, v1: t.inner, front: 0 };
    if (between.u1 - between.u0 < MIN_DOOR_SPAN || between.v1 - between.v0 < MIN_DOOR_SPAN) continue;
    if (!overlaps(l.cross, between.v0, between.v1) || !overlaps(r.cross, between.v0, between.v1)) continue;
    if (!overlaps(b.cross, between.u0, between.u1) || !overlaps(t.cross, between.u0, between.u1)) continue;
    const key = rectKey(between);
    if (seen.has(key)) continue;
    seen.add(key);
    const edges = { l, r, b, t };
    const depths = depthOptions([l, r, b, t], side, bodyFront);
    const boundsRef: DoorBounds = { uMin: l.ref, uMax: r.ref, vMin: b.ref, vMax: t.ref };
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

export interface DoorMemberRect {
  u0: number; u1: number; v0: number; v1: number;
  leafId: string; type: DoorType; leaf: number; leafCount: number;
  poly?: Array<{ x: number; y: number }>;
}
export type DoorNodeSolved =
  | { id: string; kind: 'leaf'; type: DoorType; leafSplit?: DoorLeafSplit; u0: number; u1: number; v0: number; v1: number; depth: number }
  | { id: string; kind: 'split'; axis: 'u' | 'v'; sizes: GapSpec[]; gaps: number[]; children: DoorNodeSolved[]; targetSize?: number; refs?: Record<number, DoorJointRef>; u0: number; u1: number; v0: number; v1: number; depth: number };
export interface DoorSolution { rect: DoorRect; tree: DoorNode; solved: DoorNodeSolved; members: DoorMemberRect[] }
/** `${splitId}:${k}` → bağlı derzin merkezi (bölmenin ekseninde). */
export type DoorJointTargets = Map<string, number>;
const jointKey = (splitId: string, k: number) => `${splitId}:${k}`;
export type DoorLayout = Pick<DoorGroup, 'rect' | 'tree' | 'edgeGaps' | 'gap'>;

export const makeDoorLeaf = (type: DoorType, leafSplit?: DoorLeafSplit): DoorNode => ({ id: genId('dl'), kind: 'leaf', type, ...(leafSplit ? { leafSplit } : {}) });
export function edgeGapsOf(g: Pick<DoorGroup, 'gap'> & { edgeGaps?: DoorEdgeGaps }): DoorEdgeGaps {
  const ok = (x: unknown): x is number => Number.isFinite(x) && (x as number) >= 0;
  const e = g.edgeGaps;
  return { uMin: ok(e?.uMin) ? e.uMin : g.gap, uMax: ok(e?.uMax) ? e.uMax : g.gap, vMin: ok(e?.vMin) ? e.vMin : g.gap, vMax: ok(e?.vMax) ? e.vMax : g.gap };
}
export function doorLeaves(n: DoorNode): Array<Extract<DoorNode, { kind: 'leaf' }>> { return n.kind === 'leaf' ? [n] : n.children.flatMap(doorLeaves); }
export const doorMemberCount = (g: Pick<DoorGroup, 'tree'>) => doorLeaves(g.tree).reduce((a, l) => a + (doorLeafAxis(l.type) ? 2 : 1), 0);
export function findDoorNode(n: DoorNode, id: string): DoorNode | null { if (n.id === id) return n; if (n.kind === 'split') for (const c of n.children) { const h = findDoorNode(c, id); if (h) return h; } return null; }
export function findDoorParent(n: DoorNode, id: string): Extract<DoorNode, { kind: 'split' }> | null {
  if (n.kind !== 'split') return null;
  if (n.children.some(c => c.id === id)) return n;
  for (const c of n.children) { const h = findDoorParent(c, id); if (h) return h; }
  return null;
}
export function replaceDoorNode(n: DoorNode, id: string, repl: (old: DoorNode) => DoorNode): DoorNode {
  if (n.id === id) return repl(n);
  if (n.kind === 'leaf') return n;
  return { ...n, children: n.children.map(c => replaceDoorNode(c, id, repl)) };
}
/** Alt ağacın yeni kimlikli kopyası; derz bağları da kopyalanır (levha parçayı kesmiyorsa doorJointTargets bağı yok sayar). */
export function cloneDoorNode(n: DoorNode): DoorNode {
  if (n.kind === 'leaf') return { ...n, id: genId('dl'), ...(n.leafSplit ? { leafSplit: { gap: n.leafSplit.gap, leaves: n.leafSplit.leaves.map(l => ({ ...l })) } } : {}) };
  return { ...n, id: genId('ds'), sizes: n.sizes.map(s => ({ ...s })), gaps: [...n.gaps], children: n.children.map(cloneDoorNode), ...(n.refs ? { refs: { ...n.refs } } : {}) };
}
export function findSolvedNode(n: DoorNodeSolved, id: string): DoorNodeSolved | null { if (n.id === id) return n; if (n.kind === 'split') for (const c of n.children) { const h = findSolvedNode(c, id); if (h) return h; } return null; }

// KATSAYI kuralı: kilitli ölçüler sabit; kalan alan kilitsizlere (girilmişler dahil) mevcut oranlarıyla dağılır.
// Toplam alanı tutuyorsa sonuç birimdir (kayma yok).
function distributeSizes(specs: GapSpec[], L: number, gaps: number[]): GapSpec[] {
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
export type DoorSizeMode = GapMode;
// DİKKAT: DoorService ↔ PanelGroupService döngüsel içe aktarım. Modül üst düzeyinde PanelGroupService bağlarını OKUMA
// (`= gapMode` takma adı TDZ'ye düşer: "Cannot access before initialization"); yalnız fonksiyon gövdesinde çağır.
export const doorSizeMode = (g: GapSpec | undefined): DoorSizeMode => gapMode(g);
const MIN_DOOR_SIZE = 1;
export const passiveSizeIndex = (sizes: ReadonlyArray<GapSpec | undefined>, count = sizes.length): number => passiveGapIndex(sizes, count);

const splitGapsOf = (n: Extract<DoorNode, { kind: 'split' }>, gap: number) => {
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
      console.warn('[YAGO][KAPAK-BAĞ] bağlı derz(ler) bölmeye sığmıyor, bağ bu çözümde yok sayıldı:', splitId, ks.map(k => `${k}@${along.get(k)!.toFixed(1)}`).join(' '), 'L=', L.toFixed(1));
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
function solveNode(n: DoorNode, u0: number, u1: number, v0: number, v1: number, gap: number, depth: number, targets?: DoorJointTargets): DoorNodeSolved {
  if (n.kind === 'leaf') {
    const ax = doorLeafAxis(n.type);
    if (!ax) return { ...n, leafSplit: undefined, u0, u1, v0, v1, depth };
    const lg = Number.isFinite(n.leafSplit?.gap) && n.leafSplit!.gap >= 0 ? n.leafSplit!.gap : gap;
    const leaves = redistributeForThickness(n.leafSplit?.leaves ?? [], ax === 'u' ? u1 - u0 : v1 - v0, 1, [lg]);
    return { ...n, leafSplit: { gap: lg, leaves }, u0, u1, v0, v1, depth };
  }
  const gaps = splitGapsOf(n, gap);
  const L = n.axis === 'u' ? u1 - u0 : v1 - v0;
  const along = new Map<number, number>();
  if (targets && n.refs) for (const k of Object.keys(n.refs)) { const t = targets.get(jointKey(n.id, +k)); if (t != null) along.set(+k, n.axis === 'u' ? t - u0 : v1 - t); }
  const sizes = along.size ? distributeSizesWithJoints(n.sizes, L, gaps, along, n.id) : distributeSizes(n.sizes, L, gaps);
  const children: DoorNodeSolved[] = [];
  let pos = n.axis === 'u' ? u0 : v1;
  n.children.forEach((c, i) => {
    const w = Math.max(0, sizes[i]?.value ?? 0);
    if (n.axis === 'u') { children.push(solveNode(c, pos, pos + w, v0, v1, gap, depth + 1, targets)); pos += w + (gaps[i] ?? 0); }
    else { children.push(solveNode(c, u0, u1, pos - w, pos, gap, depth + 1, targets)); pos -= w + (gaps[i] ?? 0); }
  });
  return { ...n, sizes, gaps, children, u0, u1, v0, v1, depth };
}
export function solveDoorTree(g: DoorLayout, rect: DoorRect = g.rect, targets?: DoorJointTargets): DoorNodeSolved {
  const e = edgeGapsOf(g);
  return solveNode(g.tree, rect.u0 + e.uMin, rect.u1 - e.uMax, rect.v0 + e.vMin, rect.v1 - e.vMax, g.gap, 0, targets);
}
export function solvedToTree(n: DoorNodeSolved): DoorNode {
  if (n.kind === 'leaf') return { id: n.id, kind: 'leaf', type: n.type, ...(n.leafSplit ? { leafSplit: n.leafSplit } : {}) };
  return {
    id: n.id, kind: 'split', axis: n.axis, sizes: n.sizes, gaps: n.gaps, children: n.children.map(solvedToTree),
    ...(n.targetSize ? { targetSize: n.targetSize } : {}), ...(n.refs && Object.keys(n.refs).length ? { refs: n.refs } : {}),
  };
}
export function doorJointRefs(n: DoorNode): Array<{ splitId: string; k: number; ref: DoorJointRef }> {
  if (n.kind === 'leaf') return [];
  const own = Object.entries(n.refs ?? {}).map(([k, ref]) => ({ splitId: n.id, k: +k, ref }));
  return [...own, ...n.children.flatMap(doorJointRefs)];
}
// Bağlı derz merkezi levhanın GÜNCEL kutusundan: 'center' → levha ortası, 'min' → max yüz + yarım derz (levha min taraftaki
// kapağın arkasında), 'max' → min yüz − yarım derz. Levha yok / dönmüş / kalın → derz hedefsiz.
export function doorJointTargets(group: DoorLayout & Pick<DoorGroup, 'axis'>, parent: Shape, shapes: Shape[]): DoorJointTargets {
  const out: DoorJointTargets = new Map();
  const refs = doorJointRefs(group.tree);
  if (!refs.length) return out;
  const { u, v } = doorPlaneAxes(group.axis);
  const bonded = new Set(useAppStore.getState().panelGroups.filter(pg => pg.doorBond).flatMap(pg => pg.memberVfIds));   // iki yönlü bağ yasak
  for (const { splitId, k, ref } of refs) {
    const node = findDoorNode(group.tree, splitId);
    if (!node || node.kind !== 'split' || k < 0 || k >= node.children.length - 1) continue;
    if (bonded.has(ref.vfId)) continue;
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
/** Üye dikdörtgenleri (DFS yaprak sırası = VF.doorIndex); double/fold yaprak iki ardışık kanat. */
export function doorMemberRects(solved: DoorNodeSolved): DoorMemberRect[] {
  const out: DoorMemberRect[] = [];
  const walk = (n: DoorNodeSolved) => {
    if (n.kind === 'split') { n.children.forEach(walk); return; }
    const ax = doorLeafAxis(n.type), split = n.leafSplit;
    const base = { leafId: n.id, type: n.type };
    if (ax && split && split.leaves.length === 2) {
      const [a, b] = split.leaves.map(l => Math.max(0, l.value));
      if (ax === 'u') {
        out.push({ ...base, leaf: 0, leafCount: 2, u0: n.u0, u1: n.u0 + a, v0: n.v0, v1: n.v1 });
        out.push({ ...base, leaf: 1, leafCount: 2, u0: n.u0 + a + split.gap, u1: n.u0 + a + split.gap + b, v0: n.v0, v1: n.v1 });
      } else {
        out.push({ ...base, leaf: 0, leafCount: 2, u0: n.u0, u1: n.u1, v0: n.v1 - a, v1: n.v1 });
        out.push({ ...base, leaf: 1, leafCount: 2, u0: n.u0, u1: n.u1, v0: n.v1 - a - split.gap - b, v1: n.v1 - a - split.gap });
      }
    } else out.push({ ...base, leaf: 0, leafCount: 1, u0: n.u0, u1: n.u1, v0: n.v0, v1: n.v1 });
  };
  walk(solved);
  return out;
}
export const doorMembersOf = (g: DoorLayout) => doorMemberRects(solveDoorTree(g));

function boundEdgeInfo(ref: DoorBoundRef, parent: Shape, shapes: Shape[], body: CavityBox, ax: 0 | 1 | 2, minSide: boolean, axis: 0 | 1 | 2, side: 1 | -1): EdgeInfo {
  if (ref.vfId) {
    const p = panelOfVf(ref.vfId, shapes);
    const box = p && (p.parameters as any)?.parentShapeId === parent.id ? panelLocalBox(p, parent) : null;
    if (box) return { ref, inner: minSide ? box.max[ax] : box.min[ax], outer: minSide ? box.min[ax] : box.max[ax], front: side > 0 ? box.max[axis] : box.min[axis] };
    console.warn('[YAGO][KAPAK] sınır paneli bulunamadı, gövde kenarı kullanıldı:', ref.vfId);
  }
  const e = minSide ? body.min[ax] : body.max[ax];
  return { ref: { body: true }, inner: e, outer: e, front: null };
}

function solveDoorEdges(group: DoorGroup, parent: Shape, shapes: Shape[]): { edges: DoorEdges; P: number } | null {
  const body = bodyLocalBox(parent);
  if (!body) return null;
  const { u, v } = doorPlaneAxes(group.axis);
  const ei = (ref: DoorBoundRef, ax: 0 | 1 | 2, minSide: boolean) => boundEdgeInfo(ref, parent, shapes, body, ax, minSide, group.axis, group.side);
  const edges: DoorEdges = { l: ei(group.bounds.uMin, u, true), r: ei(group.bounds.uMax, u, false), b: ei(group.bounds.vMin, v, true), t: ei(group.bounds.vMax, v, false) };
  const bodyFront = group.side > 0 ? body.max[group.axis] : body.min[group.axis];
  // Derinlik: kayıtlı referans panelin ön yüzü (panel taşınınca izler); yoksa en gerideki sınır panelinin önü.
  const fronts = [edges.l, edges.r, edges.b, edges.t].map(x => x.front).filter((x): x is number => x != null);
  const sgn = group.side;
  let P = !fronts.length ? bodyFront : (sgn > 0 ? Math.min(...fronts) : Math.max(...fronts));
  if (group.depthRef?.body) P = bodyFront;
  else if (group.depthRef?.vfId) {
    const hit = [edges.l, edges.r, edges.b, edges.t].find(x => x.ref.vfId === group.depthRef!.vfId && x.front != null);
    if (hit) P = hit.front!;
    else console.warn('[YAGO][KAPAK] derinlik referansı bulunamadı, varsayılan derinlik:', group.id, group.depthRef.vfId);
  }
  return { edges, P };
}

export type DoorEdgeKey = keyof DoorBounds;

export function solveDoorGroup(group: DoorGroup, parent: Shape, shapes: Shape[]): DoorSolution | null {
  const s = solveDoorEdges(group, parent, shapes);
  if (!s) return null;
  const { edges, P } = s;
  const cutsAll = collectDoorCuts(parent, shapes);
  let rect: DoorRect = rectByCuts(group, rectAtDepth(edges, group.side, group.placement, P, group.halfOverlay), cutsAll, group.anchor);
  if (rect.u1 - rect.u0 < MIN_DOOR_SPAN || rect.v1 - rect.v0 < MIN_DOOR_SPAN) {
    console.warn('[YAGO][KAPAK] dikdörtgen bozuk/çok küçük, önceki korunuyor:', group.id, fmtRect(rect));
    rect = { ...group.rect };
  }
  const solved = solveDoorTree(group, rect, doorJointTargets(group, parent, shapes));
  const members = applyDoorCuts(group, rect, doorMemberRects(solved), cutsAll);
  return { rect, tree: solvedToTree(solved), solved, members };
}

export function applyDoorCuts(group: Pick<DoorGroup, 'axis' | 'side' | 'placement' | 'thickness' | 'gap' | 'id' | 'halfOverlay' | 'anchor'> & { edgeGaps?: DoorEdgeGaps }, rect: DoorRect, members: DoorMemberRect[], cuts: DoorCut[]): DoorMemberRect[] {
  if (!cuts.length) return members;
  let n = 0;
  const eg = edgeGapsOf(group);
  const out = members.map(m => {
    const poly = clipMemberByCuts(m, cuts, group.axis, group.side, group.placement, group.thickness, rect.front, eg, group.halfOverlay, group.anchor);
    if (poly) n++;
    return poly ? { ...m, poly } : m;
  });
  return out;
}

// Şemada açılı sınır levhası: kapak düzlemindeki kesit bir ŞERİT (dMin ≤ A·u + B·v + Na·front ≤ dMax), en az minT mm.
// covered → Full/Half rozeti anlamlı (bayrak clipMemberByCuts'ın okuduğu kenar bayrağıdır).
export interface DoorCutBand { cut: DoorCut; poly: Pt2[]; edge: DoorEdgeKey | null; covered: boolean; dir: Pt2 }
export function doorCutBands(group: Pick<DoorGroup, 'axis' | 'side' | 'placement' | 'anchor'>, rect: DoorRect, cuts: DoorCut[], area: Pt2[], minT: number): DoorCutBand[] {
  const { u, v } = doorPlaneAxes(group.axis);
  const out: DoorCutBand[] = [];
  for (const c of cuts) {
    const A = c.n[u], B = c.n[v], Na = c.n[group.axis];
    const len = Math.hypot(A, B);
    if (len < 1e-6) continue;
    let lo = c.dMin - Na * rect.front, hi = c.dMax - Na * rect.front;
    if (hi - lo < minT * len) { const m = (lo + hi) / 2; lo = m - minT * len / 2; hi = m + minT * len / 2; }
    let poly = clipHalfPlane(area, A, B, hi);
    if (poly.length >= 3) poly = clipHalfPlane(poly, -A, -B, -lo);
    // Şerit sonsuzdur: panelin gerçek ön görünüşüyle kırpılır, yoksa yan panelin üstüne taşar.
    if (poly.length >= 3 && c.pts && c.pts.length >= 3) { const hull = frontHullOf(c.pts, u, v); if (hull.length >= 3) poly = clipPolyToConvex(poly, hull); }
    if (poly.length < 3 || Math.abs(polyArea(poly)) < 1) continue;
    const cu = group.anchor ? group.anchor[0] : (rect.u0 + rect.u1) / 2, cv = group.anchor ? group.anchor[1] : (rect.v0 + rect.v1) / 2;
    const ce = cutEdgeOf(c, cu, cv, group.axis, rect.front);
    out.push({ cut: c, poly, edge: ce?.edge ?? null, covered: cutCoverFar(c, group.axis, group.side, group.placement, rect.front), dir: { x: -B / len, y: A / len } });
  }
  return out;
}

// Açılı sınır panelinde kapak alanı çıpanın (tıklanan nokta) tarafına kırpılıp kutusuna daraltılır; eğik kenar applyDoorCuts'ta çokgen kalır.
export function rectByCuts(group: Pick<DoorGroup, 'axis' | 'side' | 'placement' | 'thickness' | 'gap' | 'halfOverlay'>, rect: DoorRect, cuts: DoorCut[], anchor?: [number, number]): DoorRect {
  if (!anchor || !cuts.length) return rect;
  // Boşluksuz kırpılır: kenar boşluğu kökte (solveDoorTree) düşülür; burada da düşülse eğik köşede boşluk iki kez düşer (basamak).
  const poly = clipMemberByCuts(rect, cuts, group.axis, group.side, group.placement, group.thickness, rect.front, 0, group.halfOverlay, anchor);
  if (!poly || poly.length < 3) return rect;
  const xs = poly.map(q => q.x), ys = poly.map(q => q.y);
  const out: DoorRect = { u0: Math.min(...xs), u1: Math.max(...xs), v0: Math.min(...ys), v1: Math.max(...ys), front: rect.front };
  if (out.u1 - out.u0 < MIN_DOOR_SPAN || out.v1 - out.v0 < MIN_DOOR_SPAN) return rect;
  return out;
}

/** Bölge dikdörtgeninin açılı panellerle kırpılmış şekli; withGap=false → kesici yüzünde (şema boşluk şeritlerinin kırpma alanı). */
export function doorCutOutline(
  group: Pick<DoorGroup, 'axis' | 'side' | 'placement' | 'thickness' | 'gap' | 'halfOverlay' | 'anchor'> & { edgeGaps?: DoorEdgeGaps },
  rect: DoorRect, r: { u0: number; u1: number; v0: number; v1: number }, cuts: DoorCut[], withGap = true,
): Pt2[] {
  const base: Pt2[] = [{ x: r.u0, y: r.v0 }, { x: r.u1, y: r.v0 }, { x: r.u1, y: r.v1 }, { x: r.u0, y: r.v1 }];
  if (!cuts.length) return base;
  return clipMemberByCuts(r, cuts, group.axis, group.side, group.placement, group.thickness, rect.front, withGap ? edgeGapsOf(group) : 0, group.halfOverlay, group.anchor) ?? base;
}

// createPanelFromVirtualFace −normal yönünde t uzar → VF düzlemi kapağın DIŞ yüzü: dış kapak ön + side·t, iç kapak ön.
function doorMemberVfGeometry(group: DoorGroup, m: DoorMemberRect, rect: DoorRect): { normal: Vec3; vertices: Vec3[]; center: Vec3 } {
  const { u, v } = doorPlaneAxes(group.axis);
  const plane = group.placement === 'outer' ? rect.front + group.side * group.thickness : rect.front;
  const mk = (uu: number, vv: number): Vec3 => { const p: Vec3 = [0, 0, 0]; p[group.axis] = plane; p[u] = uu; p[v] = vv; return p; };
  const normal: Vec3 = [0, 0, 0]; normal[group.axis] = group.side;
  const vertices = m.poly ? m.poly.map(q => mk(q.x, q.y)) : [mk(m.u0, m.v0), mk(m.u1, m.v0), mk(m.u1, m.v1), mk(m.u0, m.v1)];
  const c = m.poly ? m.poly.reduce((a, q) => ({ x: a.x + q.x / m.poly!.length, y: a.y + q.y / m.poly!.length }), { x: 0, y: 0 }) : { x: (m.u0 + m.u1) / 2, y: (m.v0 + m.v1) / 2 };
  return { normal, vertices, center: mk(c.x, c.y) };
}

function doorVfPatch(vf: VirtualFace, group: DoorGroup, sol: DoorSolution): Partial<VirtualFace> | null {
  const i = vf.doorIndex ?? group.memberVfIds.indexOf(vf.id);
  const m = sol.members[i];
  if (!m) return null;
  const g = doorMemberVfGeometry(group, m, sol.rect);
  return { normal: g.normal, vertices: g.vertices, center: g.center, regionAnchor: g.center } as any;
}

/** Regen kancası (PanelEngine): gövdenin kapak VF'lerini grup çözümüyle yeniden yazar. */
export function recalculateDoorVfs(parent: Shape, vfs: VirtualFace[], shapes: Shape[], groups: DoorGroup[]): Map<string, VirtualFace> {
  const out = new Map<string, VirtualFace>();
  for (const g of groups) {
    if (g.shapeId !== parent.id) continue;
    const sol = solveDoorGroup(g, parent, shapes);
    if (!sol) continue;
    for (const vf of vfs) {
      if (vf.shapeId !== parent.id || vf.doorGroupId !== g.id) continue;
      const patch = doorVfPatch(vf, g, sol);
      if (patch) out.set(vf.id, { ...vf, ...patch });
    }
  }
  return out;
}

/** Derz: iki kapak arası boşluk [p0, p1], çapraz eksende [c0, c1]. */
export interface DoorJoint { splitId: string; k: number; axis: 'u' | 'v'; p0: number; p1: number; c0: number; c1: number }
export function doorJoints(solved: DoorNodeSolved): DoorJoint[] {
  const out: DoorJoint[] = [];
  const walk = (n: DoorNodeSolved) => {
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

export interface DoorNearPanel {
  vfId: string; panelId: string; name: string;
  kind: 'u' | 'v';
  a0: number; a1: number; c0: number; c1: number;
  behind: boolean;
  /** Grup kenarı levhası: yarım binme geçerli, hizalama yok. */
  edge?: DoorEdgeKey;
  groupId?: string; memberIndex?: number;
  joint?: DoorJoint;
  /** master 'panel' = DoorNode.refs (derz levhayı izler); 'door' = PanelGroup.doorBond (levha derzi izler). */
  ref?: { splitId: string; k: number; align: DoorAlign; master: 'panel' | 'door' };
  poly?: Pt2[];
}

// Dış kapakta şemada gösterilecek sınır levhaları (iç kapak → boş). allPanels=true → işaretsizler de (işaretsiz dikme de derzi keser).
export function doorNearPanels(group: DoorGroup, parent: Shape, shapes: Shape[], vfs: VirtualFace[], panelGroups: PanelGroup[], members?: DoorMemberRect[], allPanels = false): DoorNearPanel[] {
  if (group.placement !== 'outer') return [];
  const { u, v } = doorPlaneAxes(group.axis);
  const solved = solveDoorTree(group);
  const ms = members ?? doorMemberRects(solved);
  const joints = doorJoints(solved);
  const near = Math.max(group.gap, 0) + NEAR_EXTRA;
  const front = group.rect.front;
  const edgeOf = (vfId: string): DoorEdgeKey | undefined => (['uMin', 'uMax', 'vMin', 'vMax'] as DoorEdgeKey[]).find(k => group.bounds[k]?.vfId === vfId);
  const refs = doorJointRefs(group.tree);
  const out: DoorNearPanel[] = [];
  for (const bp of collectDoorBoundPanels(parent, shapes, vfs, !allPanels)) {
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
    let joint: DoorJoint | undefined, ref: DoorNearPanel['ref'];
    if (!edge) {
      const bound = refs.find(r => r.ref.vfId === bp.vfId && joints.some(j => j.splitId === r.splitId && j.k === r.k && j.axis === kind));
      const bond = pg?.doorBond && pg.doorBond.doorGroupId === group.id && (pg.doorBond.member ?? 0) === memberIndex ? pg.doorBond : undefined;
      if (bound) { ref = { splitId: bound.splitId, k: bound.k, align: bound.ref.align, master: 'panel' }; joint = joints.find(j => j.splitId === bound.splitId && j.k === bound.k); }
      else if (bond && joints.some(j => j.splitId === bond.splitId && j.k === bond.k && j.axis === kind)) { ref = { splitId: bond.splitId, k: bond.k, align: bond.align, master: 'door' }; joint = joints.find(j => j.splitId === bond.splitId && j.k === bond.k); }
      else {
        const pc = (a0 + a1) / 2, t = a1 - a0;
        let best = Infinity;
        for (const j of joints) {
          if (j.axis !== kind || Math.min(j.c1, c1) - Math.max(j.c0, c0) < TOL) continue;
          const d = Math.abs((j.p0 + j.p1) / 2 - pc);
          if (d <= t / 2 + (j.p1 - j.p0) / 2 + JOINT_NEAR && d < best) { best = d; joint = j; }
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

/** Derz parçaları: derz onu kesen çapraz levhalarla bölünür; free = aynı türde levhası olmayan parçalar. */
export function doorJointParts(joints: DoorJoint[], obstacles: DoorNearPanel[], axis: 'u' | 'v', minSeg = 40): Array<{ joint: DoorJoint; all: Array<[number, number]>; free: Array<[number, number]> }> {
  return joints.filter(j => j.axis === axis).map(j => {
    const cutters = obstacles
      .filter(np => np.kind !== j.axis && Math.min(np.c1, j.p1) - Math.max(np.c0, j.p0) > -TOL && np.a1 > j.c0 + TOL && np.a0 < j.c1 - TOL)
      .map(np => [np.a0, np.a1] as [number, number]).sort((a, b) => a[0] - b[0]);
    const all: Array<[number, number]> = [];
    let s0 = j.c0;
    for (const [a0, a1] of cutters) { if (a0 - s0 >= minSeg) all.push([s0, a0]); s0 = Math.max(s0, a1); }
    if (j.c1 - s0 >= minSeg) all.push([s0, j.c1]);
    const free = all.filter(([c0, c1]) => { const mid = (c0 + c1) / 2; return !obstacles.some(np => np.kind === j.axis && Math.min(np.a1, j.p1) - Math.max(np.a0, j.p0) > -TOL && np.c0 - TOL <= mid && mid <= np.c1 + TOL); });
    return { joint: j, all, free };
  });
}

export function alignedPanelMin(np: Pick<DoorNearPanel, 'a0' | 'a1' | 'joint'>, align: DoorAlign): number | null {
  if (!np.joint) return null;
  const t = np.a1 - np.a0, { p0, p1 } = np.joint;
  return align === 'min' ? p0 - t : align === 'max' ? p1 : (p0 + p1) / 2 - t / 2;
}

/** doorBond'un derzi gövde ekseninde (PanelGroupService.solveGroup için); derz yoksa null (bağ bayat). */
export function doorJointForBond(bond: DoorBond, parent: Shape, shapes: Shape[], doorGroups: DoorGroup[] = useAppStore.getState().doorGroups):
  { axis: 0 | 1 | 2; cross: 0 | 1 | 2; p0: number; p1: number; c0: number; c1: number; panelMin: (t: number) => number } | null {
  const dg = doorGroups.find(g => g.id === bond.doorGroupId);
  if (!dg || dg.shapeId !== parent.id) return null;
  const sol = solveDoorGroup(dg, parent, shapes);
  if (!sol) return null;
  const j = doorJoints(sol.solved).find(x => x.splitId === bond.splitId && x.k === bond.k);
  if (!j) return null;
  const { u, v } = doorPlaneAxes(dg.axis);
  const axis = j.axis === 'u' ? u : v, cross = j.axis === 'u' ? v : u;
  const panelMin = (t: number) => (bond.align === 'min' ? j.p0 - t : bond.align === 'max' ? j.p1 : (j.p0 + j.p1) / 2 - t / 2);
  return { axis, cross, p0: j.p0, p1: j.p1, c0: j.c0, c1: j.c1, panelMin };
}

// Levhayı derze göre bir kez taşır (kapak yerinde kalır), kendi grup boşluğunu yazarak. false → çağıran derzi levhaya götürür.
function movePanelToAlign(group: Pick<DoorGroup, 'id' | 'axis'>, np: DoorNearPanel, align: DoorAlign, panelGroups: PanelGroup[]): boolean {
  const want = alignedPanelMin(np, align);
  if (want == null) return false;
  const delta = want - np.a0;
  if (Math.abs(delta) < 0.05) return true;
  const pg = np.groupId ? panelGroups.find(g => g.id === np.groupId) : undefined;
  if (!pg || np.memberIndex == null || np.memberIndex < 0) { console.warn('[YAGO][KAPAK-HİZA] levha raf/dikme üyesi değil, taşınamaz — derz levhaya gidecek:', np.name); return false; }
  const { u, v } = doorPlaneAxes(group.axis);
  if (pg.axis !== (np.kind === 'u' ? u : v)) { console.warn('[YAGO][KAPAK-HİZA] grubun dizilim ekseni levhanın kalınlık ekseni değil, taşınamaz:', np.name, pg.id); return false; }
  const k = np.memberIndex;
  const cur = pg.gaps[k]?.value;
  if (cur == null) return false;
  const next = round1(cur + groupFacing(pg) * delta);
  if (next < 0) { console.warn('[YAGO][KAPAK-HİZA] istenen boşluk negatif, levha taşınamaz:', np.name, next); return false; }
  const sim = applyGapEditProportional(pg.gaps, k, next, boxSpan(pg.cavity, pg.axis), pg.count, memberThicknessesOf(pg));   // editGroupGap ile aynı kural
  if (Math.abs((sim[k]?.value ?? NaN) - next) > 0.05) { console.warn('[YAGO][KAPAK-HİZA] boşluk yazılamıyor (kilitli komşular), levha taşınamaz:', np.name, next); return false; }
  void editGroupGap(pg.id, k, next);
  return true;
}

const groupById = (id: string) => useAppStore.getState().doorGroups.find(g => g.id === id);

function solveFromStore(group: DoorGroup): DoorSolution | null {
  const st = useAppStore.getState();
  const parent = shapeById(group.shapeId, st.shapes);
  return parent ? solveDoorGroup(group, parent, st.shapes) : null;
}

/** Canlı önizlemede oran tabanı = düzenleme başındaki ağaç; önizleme ağacından oranlansa MIN kırpması oranları kalıcı bozar. */
let sizeEditBase: { groupId: string; tree: DoorNode } | null = null;

const fallbackSolution = (group: DoorGroup): DoorSolution => {
  const solved = solveDoorTree(group);
  return { rect: group.rect, tree: solvedToTree(solved), solved, members: doorMemberRects(solved) };
};

function makeMemberVf(group: DoorGroup, i: number, sol: DoorSolution): VirtualFace {
  const g = doorMemberVfGeometry(group, sol.members[i], sol.rect);
  return {
    id: genId('vf-door'), shapeId: group.shapeId,
    normal: g.normal, center: g.center, vertices: g.vertices,
    description: doorGroupName(group), hasPanel: false,
    parentFaceShape: false, interior: true, doorGroupId: group.id, doorIndex: i,
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

export function createDoorGroupFromPick(shapeId: string, pick: DoorPick, placement: DoorGroup['placement'], name?: string): DoorGroup | null {
  const st = useAppStore.getState();
  const parent = shapeById(shapeId, st.shapes);
  if (!parent) return null;
  const rect = placement === 'inner' ? { ...pick.inner } : { ...pick.outer };
  const group: DoorGroup = {
    id: genId('door'), shapeId, axis: pick.axis, side: pick.side, placement, bounds: pick.bounds, depthRef: pick.depth, rect, anchor: pick.at,
    tree: makeDoorLeaf('left'), edgeGaps: { uMin: DOOR_GAP, uMax: DOOR_GAP, vMin: DOOR_GAP, vMax: DOOR_GAP }, gap: DOOR_GAP, thickness: DOOR_THICKNESS,
    memberVfIds: [], name: name?.trim() || 'Door', createdAt: Date.now(),
  };
  const sol = solveFromStore(group) || fallbackSolution(group);
  const vfs = sol.members.map((_, i) => makeMemberVf(group, i, sol));
  group.memberVfIds = vfs.map(v => v.id);
  group.rect = sol.rect;
  st.addDoorGroup(group);
  st.insertVirtualFacesAfter(null, vfs);
  st.setSelectedDoorGroupId(group.id);
  return group;
}

export function confirmDoorPick(shapeId: string, pick: DoorPick | undefined): void {
  const st = useAppStore.getState();
  if (!pick) return;
  createDoorGroupFromPick(shapeId, pick, st.doorPickPlacement, st.placementName);
  st.setDoorPickMode(false);
}

/** Çözümü üye VF'lere yazar + tam rebuild. preview: yalnız grup (ağaç) store'a yazılır, VF ve rebuild yok. */
async function writeDoorGroup(group: DoorGroup, patch: Partial<DoorGroup>, preview = false): Promise<void> {
  if (!preview) sizeEditBase = null;
  const st = useAppStore.getState();
  const next: DoorGroup = { ...group, ...patch };
  const sol = solveFromStore(next) || fallbackSolution(next);
  if (preview) { st.updateDoorGroup(group.id, { ...patch, rect: sol.rect, tree: sol.tree }); return; }
  for (const vfId of next.memberVfIds) {
    const vf = useAppStore.getState().virtualFaces.find(f => f.id === vfId);
    if (!vf) continue;
    const p = doorVfPatch(vf, next, sol);
    if (p) st.updateVirtualFace(vf.id, p);
  }
  st.updateDoorGroup(group.id, { ...patch, rect: sol.rect, tree: sol.tree });
  await requestRebuild(group.shapeId);
}

// Yapı değişince: yaprak id + kanat sırası eşleşen VF/paneller (adımlarıyla) korunur, yalnız doorIndex yazılır; eksikler yeni VF
// (paneli otomatik üretim yaratır). restructured = üyeleri her durumda yenilenecek yapraklar.
function rebuildMembers(group: DoorGroup, nextGroup: DoorGroup, restructured: Set<string>): void {
  const st = useAppStore.getState();
  const sol = solveFromStore(nextGroup) || fallbackSolution(nextGroup);
  const oldMembers = fallbackSolution(group).members;
  const oldIds = new Map<string, string>();
  if (oldMembers.length === group.memberVfIds.length) oldMembers.forEach((m, i) => { if (group.memberVfIds[i]) oldIds.set(`${m.leafId}/${m.leaf}`, group.memberVfIds[i]); });
  else console.warn('[YAGO][KAPAK] üye sayısı tutmuyor, tüm üyeler yeniden kuruluyor:', oldMembers.length, 'vs', group.memberVfIds.length);
  const ids: string[] = [], kept: string[] = [], fresh: VirtualFace[] = [];
  sol.members.forEach((m, i) => {
    const prev = restructured.has(m.leafId) ? undefined : oldIds.get(`${m.leafId}/${m.leaf}`);
    if (prev) { ids.push(prev); kept.push(prev); }
    else { const vf = makeMemberVf(nextGroup, i, sol); ids.push(vf.id); fresh.push(vf); }
  });
  removeMembers(group.memberVfIds.filter(id => !kept.includes(id)));
  for (const id of kept) st.updateVirtualFace(id, { doorIndex: ids.indexOf(id) });
  st.updateDoorGroup(group.id, { ...nextGroup, rect: sol.rect, tree: sol.tree, memberVfIds: ids });
  // Yeni kapaklar korunan son üyeden sonra eklenir: grup listede bir arada kalır.
  const order = useAppStore.getState().virtualFaces.map(f => f.id);
  const lastKept = kept.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b)).pop() ?? null;
  st.insertVirtualFacesAfter(lastKept, fresh);
  if (useAppStore.getState().selectedDoorGroupId !== group.id && !useAppStore.getState().selectedPanelRow) st.setSelectedDoorGroupId(group.id);
}

// Yaprak → split; aynı eksenli split → çocuk ekle/çıkar (count = 1 → ilk parça kalır); diğer eksen → sarılır, mevcut bölme her
// parçada kopyalanır. Üst ölçüler değişmez. Döner: sonuç düğümün id'si (arayüz seçimi), işlem yoksa null.
export function setDoorNodeSplit(groupId: string, nodeId: string, axis: 'u' | 'v', count: number, opts: { keepTargetSize?: boolean } = {}): string | null {
  const group = groupById(groupId);
  const node = group ? findDoorNode(group.tree, nodeId) : null;
  if (!group || !node || !Number.isFinite(count)) return null;
  const n = Math.max(1, Math.min(MAX_DOOR_SPLIT, Math.round(count)));
  const newLeaves = (k: number, from: number, total: number, baseType: DoorType) =>
    Array.from({ length: k }, (_, i) => makeDoorLeaf(axis === 'u' ? defaultDoorType(from + i, total) : baseType));
  const gapsFor = (m: number, old: number[] = []) => Array.from({ length: m }, (_, i) => old[i] ?? old[0] ?? group.gap);
  if (node.kind === 'leaf') {
    if (n <= 1) return node.id;
    const baseType: DoorType = doorLeafAxis(node.type) ? 'left' : node.type;
    const split: DoorNode = { id: genId('ds'), kind: 'split', axis, sizes: [], gaps: gapsFor(n - 1), children: newLeaves(n, 0, n, baseType) };
    rebuildMembers(group, { ...group, tree: replaceDoorNode(group.tree, node.id, () => split) }, new Set([node.id]));
    return split.id;
  }
  if (node.axis === axis) {
    if (n === node.children.length) return node.id;
    if (n <= 1) {
      const first = node.children[0];
      const gone = new Set(node.children.slice(1).flatMap(c => doorLeaves(c).map(l => l.id)));
      rebuildMembers(group, { ...group, tree: replaceDoorNode(group.tree, node.id, () => first) }, gone);
      return first.id;
    }
    const restructured = new Set<string>();
    let children = node.children.slice();
    if (n > children.length) {
      // Artış: son parça bir bölmeyse yeni parçalar onun kopyası (bölünmüş hal korunur), değilse eşit yeni kapaklar.
      const last = children[children.length - 1];
      children = [...children, ...(last.kind === 'split' ? Array.from({ length: n - children.length }, () => cloneDoorNode(last)) : newLeaves(n - children.length, children.length, n, 'left'))];
    } else { for (const c of children.slice(n)) for (const l of doorLeaves(c)) restructured.add(l.id); children = children.slice(0, n); }
    // Elle sayı girildiyse spacing hedefi kalkar; derz bağları kalan derzlerde (k < n−1) korunur.
    const refs = Object.fromEntries(Object.entries(node.refs ?? {}).filter(([k]) => +k < n - 1)) as Record<number, DoorJointRef>;
    const next: DoorNode = { ...node, children, gaps: gapsFor(n - 1, node.gaps), sizes: [], targetSize: opts.keepTargetSize ? node.targetSize : undefined, refs: Object.keys(refs).length ? refs : undefined };
    rebuildMembers(group, { ...group, tree: replaceDoorNode(group.tree, node.id, () => next) }, restructured);
    return node.id;
  }
  if (n <= 1) return node.id;
  const wrap: DoorNode = { id: genId('ds'), kind: 'split', axis, sizes: [], gaps: gapsFor(n - 1), children: [node, ...Array.from({ length: n - 1 }, () => cloneDoorNode(node))] };
  rebuildMembers(group, { ...group, tree: replaceDoorNode(group.tree, node.id, () => wrap) }, new Set());
  return wrap.id;
}

/** Panel ref: levhanın merkezinden geçen her yaprak ikiye bölünür, derz levhaya 'center' bağlanır (levha taşınınca kapak izler). */
export function splitDoorAtPanel(groupId: string, vfId: string): string[] {
  const group = groupById(groupId);
  if (!group) return [];
  const st = useAppStore.getState();
  const parent = shapeById(group.shapeId, st.shapes);
  if (!parent) return [];
  const np = doorNearPanels(group, parent, st.shapes, st.virtualFaces, st.panelGroups).find(p => p.vfId === vfId);
  if (!np) { console.warn('[YAGO][KAPAK-REF] seçilen panel bu kapağın sınır levhası değil / kapağa değmiyor:', vfId); return []; }
  if (np.edge) { console.warn('[YAGO][KAPAK-REF] kenar levhası (grup sınırı) ile bölme yapılmaz:', np.name); return []; }
  if (!np.groupId) console.warn('[YAGO][KAPAK-REF] levha raf/dikme üyesi değil — bölünür ve bağlanır ama rozetle taşınamaz (derz levhaya gider):', np.name);
  const solved = solveDoorTree(group);
  const axis = np.kind, pc = (np.a0 + np.a1) / 2, g = group.gap;
  const hits: DoorNodeSolved[] = [];
  const walk = (n: DoorNodeSolved) => {
    if (n.kind === 'split') { n.children.forEach(walk); return; }
    const a0 = axis === 'u' ? n.u0 : n.v0, a1 = axis === 'u' ? n.u1 : n.v1, c0 = axis === 'u' ? n.v0 : n.u0, c1 = axis === 'u' ? n.v1 : n.u1;
    if (Math.min(c1, np.c1) - Math.max(c0, np.c0) < TOL) return;
    if (pc - g / 2 - a0 >= MIN_DOOR_SPAN && a1 - (pc + g / 2) >= MIN_DOOR_SPAN) hits.push(n);
  };
  walk(solved);
  if (!hits.length) { console.warn('[YAGO][KAPAK-REF] levhanın merkezinden geçen bölünebilir kapak yok:', np.name); return []; }
  let tree = group.tree;
  const ids: string[] = [], restructured = new Set<string>();
  for (const leaf of hits) {
    const lt: DoorType = leaf.kind === 'leaf' ? leaf.type : 'left';
    const baseType: DoorType = doorLeafAxis(lt) ? 'left' : lt;
    const split: DoorNode = {
      id: genId('ds'), kind: 'split', axis, sizes: [], gaps: [g], refs: { 0: { vfId, align: 'center' } },
      children: axis === 'u' ? [makeDoorLeaf('left'), makeDoorLeaf('right')] : [makeDoorLeaf(baseType), makeDoorLeaf(baseType)],
    };
    tree = replaceDoorNode(tree, leaf.id, () => split);
    ids.push(split.id); restructured.add(leaf.id);
  }
  rebuildMembers(group, { ...group, tree }, restructured);
  return ids;
}

export const countForTargetSize = (L: number, size: number, g: number) => Math.max(1, Math.min(MAX_DOOR_SPLIT, Math.round((L + g) / (Math.max(1, size) + g))));
/** Spacing: hedef parça ölçüsü split'e targetSize olarak yazılır, gövde boyutlanınca syncDoorGroups yeniden sayar; null → hedef kalkar. */
export function setDoorNodeSpacing(groupId: string, nodeId: string, axis: 'u' | 'v', size: number | null): string | null {
  const group = groupById(groupId);
  const node = group ? findDoorNode(group.tree, nodeId) : null;
  if (!group || !node) return null;
  const sn = findSolvedNode(solveDoorTree(group), nodeId);
  if (!sn) return null;
  if (size == null) {
    if (node.kind !== 'split' || !node.targetSize) return node.id;
    useAppStore.getState().updateDoorGroup(groupId, { tree: replaceDoorNode(group.tree, nodeId, old => ({ ...(old as any), targetSize: undefined })) });
    return node.id;
  }
  if (!Number.isFinite(size) || size < MIN_DOOR_SPAN) return null;
  const L = axis === 'u' ? sn.u1 - sn.u0 : sn.v1 - sn.v0;
  const n = countForTargetSize(L, size, group.gap);
  const sameAxisSplit = node.kind === 'split' && node.axis === axis;
  const id = sameAxisSplit && n === node.children.length ? node.id : setDoorNodeSplit(groupId, nodeId, axis, Math.max(2, n), { keepTargetSize: true });
  if (!id) return null;
  const g2 = groupById(groupId);
  if (!g2) return null;
  const target = findDoorNode(g2.tree, id);
  if (!target || target.kind !== 'split') return id;
  useAppStore.getState().updateDoorGroup(groupId, { tree: replaceDoorNode(g2.tree, id, old => ({ ...(old as any), targetSize: round1(size) })) });
  return id;
}

export function doorSpacingNodes(n: DoorNode, axis: 'u' | 'v'): Array<Extract<DoorNode, { kind: 'split' }>> {
  if (n.kind !== 'split') return [];
  const own = n.axis === axis && n.targetSize ? [n] : [];
  return [...own, ...n.children.flatMap(c => doorSpacingNodes(c, axis))];
}
/** Kapsamdaki spacing hedefleri; alt ağaçta yoksa seçili bölgeyi ÜRETEN en yakın üst bölmenin hedefi. */
export function doorSpacingTargetsInScope(tree: DoorNode, scopeIds: string[], axis: 'u' | 'v'): Array<Extract<DoorNode, { kind: 'split' }>> {
  const roots = (scopeIds.length ? scopeIds : [tree.id]).map(id => findDoorNode(tree, id)).filter((n): n is DoorNode => !!n);
  const out = new Map<string, Extract<DoorNode, { kind: 'split' }>>();
  for (const r of roots) {
    const under = doorSpacingNodes(r, axis);
    if (under.length) { for (const n of under) out.set(n.id, n); continue; }
    for (let par = findDoorParent(tree, r.id); par; par = findDoorParent(tree, par.id)) { if (par.axis === axis && par.targetSize) { out.set(par.id, par); break; } }
  }
  return [...out.values()];
}
export function clearDoorSpacing(groupId: string, scopeIds: string[], axis: 'u' | 'v'): number {
  const group = groupById(groupId);
  if (!group) return 0;
  const ids = new Set(doorSpacingTargetsInScope(group.tree, scopeIds, axis).map(n => n.id));
  if (!ids.size) return 0;
  let tree = group.tree;
  for (const id of ids) tree = replaceDoorNode(tree, id, old => ({ ...(old as any), targetSize: undefined }));
  useAppStore.getState().updateDoorGroup(groupId, { tree });
  return ids.size;
}

/** Seçilen yapraklara tek tip. Yalnız menteşe yönü değişiyorsa rebuild yok; kanat yapısı değişen yapraklar yeniden kurulur. */
export async function setDoorLeafTypes(groupId: string, leafIds: string[], type: DoorType): Promise<void> {
  const group = groupById(groupId);
  if (!group || !DOOR_TYPES.includes(type)) return;
  let tree = group.tree;
  const restructured = new Set<string>();
  let changed = false;
  for (const id of leafIds) {
    const node = findDoorNode(tree, id);
    if (!node || node.kind !== 'leaf' || node.type === type) continue;
    changed = true;
    const structural = (doorLeafAxis(node.type) ?? 'single') !== (doorLeafAxis(type) ?? 'single');
    if (structural) restructured.add(id);
    tree = replaceDoorNode(tree, id, old => ({
      ...old, type,
      ...(doorLeafAxis(type) ? (structural ? { leafSplit: { leaves: [], gap: (old as any).leafSplit?.gap ?? group.gap } } : {}) : { leafSplit: undefined }),
    } as DoorNode));
  }
  if (!changed) return;
  if (!restructured.size) {
    useAppStore.getState().updateDoorGroup(groupId, { tree });
    return;
  }
  rebuildMembers(group, { ...group, tree }, restructured);
}

export type DoorEditOpts = { preview?: boolean };
export async function editDoorLeafSize(groupId: string, leafId: string, k: number, value: number, opts: DoorEditOpts = {}): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value) || value <= 0) return;
  const sn = findSolvedNode(solveDoorTree(group), leafId);
  if (!sn || sn.kind !== 'leaf' || !sn.leafSplit) return;
  const ax = doorLeafAxis(sn.type)!;
  const leaves = applyGapEdit(sn.leafSplit.leaves, k, value, ax === 'u' ? sn.u1 - sn.u0 : sn.v1 - sn.v0, 1, [sn.leafSplit.gap]);
  const tree = replaceDoorNode(group.tree, leafId, old => ({ ...old, leafSplit: { leaves, gap: sn.leafSplit!.gap } } as DoorNode));
  await writeDoorGroup(group, { tree }, !!opts.preview);
}
export async function setDoorLeafGap(groupId: string, leafId: string, gap: number, opts: DoorEditOpts = {}): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(gap) || gap < 0) return;
  const sn = findSolvedNode(solveDoorTree(group), leafId);
  // Onayda değer aynı olsa da yazılır: önizleme değeri zaten store'a yazdı, atlanırsa VF / rebuild hiç gelmez.
  if (!sn || sn.kind !== 'leaf' || !sn.leafSplit || (opts.preview && Math.abs(sn.leafSplit.gap - gap) < 0.05)) return;
  const tree = replaceDoorNode(group.tree, leafId, old => ({ ...old, leafSplit: { leaves: sn.leafSplit!.leaves, gap: round1(gap) } } as DoorNode));
  await writeDoorGroup(group, { tree }, !!opts.preview);
}

// Bitişik derz levhaya bağlıysa ölçü LEVHAYI taşıyarak girilir (önce k., yoksa k−1. derz); taşınamazsa bağlı derz yine levhadan gelir.
export async function editDoorSize(groupId: string, splitId: string, k: number, value: number, opts: DoorEditOpts = {}): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value) || value <= 0) return;
  const sn = findSolvedNode(solveDoorTree(group), splitId);
  if (!sn || sn.kind !== 'split' || k < 0 || k >= sn.children.length) return;
  if (passiveSizeIndex(sn.sizes, sn.children.length) === k) { console.warn('[YAGO][KAPAK-KATSAYI] ölçü', k + 1, 'pasif (diğerleri pinli/kilitli, kalanı toplar) — giriş yok sayıldı', splitId); return; }
  const refs = sn.refs ?? {};
  const j = refs[k] ? k : refs[k - 1] ? k - 1 : -1;
  // Önizlemede levha taşınmaz; onayda bağlı derz levhayı taşır.
  if (j >= 0 && !opts.preview) {
    const st = useAppStore.getState();
    const parent = shapeById(group.shapeId, st.shapes);
    const ref = refs[j], g = sn.gaps[j] ?? group.gap, c = sn.children[k];
    const center = sn.axis === 'u' ? (j === k ? c.u0 + value + g / 2 : c.u1 - value - g / 2) : (j === k ? c.v1 - value - g / 2 : c.v0 + value + g / 2);
    const np = parent ? doorNearPanels(group, parent, st.shapes, st.virtualFaces, st.panelGroups).find(p => p.vfId === ref.vfId) : undefined;
    const joint: DoorJoint = { splitId, k: j, axis: sn.axis, p0: center - g / 2, p1: center + g / 2, c0: 0, c1: 0 };
    if (np && movePanelToAlign(group, { ...np, joint }, ref.align, st.panelGroups)) {
      return;
    }
    console.warn('[YAGO][KAPAK-BAĞ] bölmede levhaya bağlı derz var ama levha taşınamadı — ölçü girişi bağlı derzi değiştiremez (Shift+tık ile bağı çözün):', splitId, 'derz', j);
  }
  const L = sn.axis === 'u' ? sn.u1 - sn.u0 : sn.v1 - sn.v0;
  // Oran tabanı düzenleme başındaki ölçüler (bkz. sizeEditBase); mod bayrakları güncelden.
  const bn = sizeEditBase?.groupId === groupId ? findDoorNode(sizeEditBase.tree, splitId) : null;
  const base = bn?.kind === 'split' && bn.sizes.length === sn.sizes.length ? bn.sizes : undefined;
  const sizes = applyGapEditProportional(sn.sizes, k, value, L, sn.gaps.length, sn.gaps, { base, min: MIN_DOOR_SIZE, tag: '[YAGO][KAPAK-KATSAYI]' });
  const tree = replaceDoorNode(group.tree, splitId, old => ({ ...(old as any), sizes }));
  await writeDoorGroup(group, { tree }, !!opts.preview);
}
/** Kilit rozeti: açık → pin → kilitli → açık; rebuild yok. Son açık ölçü pinlenemez / kilitlenemez. */
export function toggleDoorSizeLock(groupId: string, splitId: string, k: number): void {
  const group = groupById(groupId);
  const sn = group ? findSolvedNode(solveDoorTree(group), splitId) : null;
  if (!group || !sn || sn.kind !== 'split' || k < 0 || k >= sn.sizes.length) return;
  const sizes = cycleGapMode(sn.sizes, k, sn.children.length);
  if (!sizes) { console.warn('[YAGO][KAPAK-KATSAYI] son açık ölçü pinlenemez/kilitlenemez (pasif, kalanı toplar):', splitId, 'ölçü', k + 1); return; }
  useAppStore.getState().updateDoorGroup(groupId, { tree: replaceDoorNode(group.tree, splitId, old => ({ ...(old as any), sizes })) });
}
export async function setDoorSplitGap(groupId: string, splitId: string, k: number, value: number, opts: DoorEditOpts = {}): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value) || value < 0) return;
  const sn = findSolvedNode(solveDoorTree(group), splitId);
  if (!sn || sn.kind !== 'split' || k < 0 || k >= sn.gaps.length || (opts.preview && Math.abs(sn.gaps[k] - value) < 0.05)) return;   // onay hep yazar (bkz. setDoorLeafGap)
  const gaps = sn.gaps.slice(); gaps[k] = round1(value);
  const tree = replaceDoorNode(group.tree, splitId, old => ({ ...(old as any), gaps }));
  await writeDoorGroup(group, { tree }, !!opts.preview);
}
export async function setDoorEdgeGap(groupId: string, edge: DoorEdgeKey, value: number, opts: DoorEditOpts = {}): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value) || value < 0) return;
  const e = edgeGapsOf(group);
  if (opts.preview && Math.abs(e[edge] - value) < 0.05) return;   // onay hep yazar (bkz. setDoorLeafGap)
  await writeDoorGroup(group, { edgeGaps: { ...e, [edge]: round1(value) } }, !!opts.preview);
}
export interface DoorLayoutSnap { tree: DoorNode; edgeGaps?: DoorEdgeGaps; gap: number; rect: DoorRect }
export function doorLayoutSnapshot(groupId: string): DoorLayoutSnap | null {
  const g = groupById(groupId);
  sizeEditBase = g ? { groupId, tree: g.tree } : null;
  return g ? { tree: g.tree, edgeGaps: g.edgeGaps ? { ...g.edgeGaps } : undefined, gap: g.gap, rect: { ...g.rect } } : null;
}
export function restoreDoorLayout(groupId: string, snap: DoorLayoutSnap | null | undefined): void {
  sizeEditBase = null;
  if (!snap || !groupById(groupId)) return;
  useAppStore.getState().updateDoorGroup(groupId, { tree: snap.tree, edgeGaps: snap.edgeGaps, gap: snap.gap, rect: snap.rect });
}
function mapTreeGaps(n: DoorNode, g: number): DoorNode {
  if (n.kind === 'leaf') return n.leafSplit ? { ...n, leafSplit: { ...n.leafSplit, gap: g } } : n;
  return { ...n, gaps: n.gaps.map(() => g), children: n.children.map(c => mapTreeGaps(c, g)) };
}
export async function setDoorGap(groupId: string, gap: number): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(gap) || gap < 0) return;
  const g = round1(gap);
  await writeDoorGroup(group, { gap: g, edgeGaps: { uMin: g, uMax: g, vMin: g, vMax: g }, tree: mapTreeGaps(group.tree, g) });
}
function equalizeTree(n: DoorNode): DoorNode {
  if (n.kind === 'leaf') return n.leafSplit ? { ...n, leafSplit: { ...n.leafSplit, leaves: [] } } : n;
  return { ...n, sizes: [], children: n.children.map(equalizeTree) };
}
export async function equalizeDoorGroup(groupId: string): Promise<void> {
  const group = groupById(groupId);
  if (!group) return;
  await writeDoorGroup(group, { tree: equalizeTree(group.tree) });
}
export async function setDoorPlacement(groupId: string, placement: DoorGroup['placement']): Promise<void> {
  const group = groupById(groupId);
  if (!group || group.placement === placement) return;
  const patch: Partial<DoorGroup> = placement === 'inner' && group.halfOverlay && Object.values(group.halfOverlay).some(Boolean) ? { placement, halfOverlay: {} } : { placement };
  await writeDoorGroup(group, patch);
}
/** Yarım binme: kenar panel kalınlığının ortasına çekilir; o eksendeki KÖK bölme yeniden eşit bölünür. */
export async function setDoorHalfOverlay(groupId: string, edge: DoorEdgeKey, on: boolean): Promise<void> {
  const group = groupById(groupId);
  if (!group || !!group.halfOverlay?.[edge] === on) return;
  const halfOverlay = { ...(group.halfOverlay ?? {}), [edge]: on };
  const isU = edge === 'uMin' || edge === 'uMax';
  const root = group.tree;
  const tree: DoorNode = root.kind === 'split' && root.axis === (isU ? 'u' : 'v') ? { ...root, sizes: [] } : root;
  await writeDoorGroup(group, { halfOverlay, tree });
}
// Derz levhaya bağlanır ve LEVHA bir kez taşınır (kapak yerinde); taşınamazsa derz levhaya gider. null → bağ çözülür, kapaklar donar.
export async function setDoorJointRef(groupId: string, splitId: string, k: number, vfId: string, align: DoorAlign | null): Promise<void> {
  const group = groupById(groupId);
  const node = group ? findDoorNode(group.tree, splitId) : null;
  if (!group || !node || node.kind !== 'split' || k < 0 || k >= node.children.length - 1) return;
  const st = useAppStore.getState();
  const sn = findSolvedNode(solveDoorTree(group), splitId);
  if (!sn || sn.kind !== 'split') return;
  // Levha kapağı izliyorsa (doorBond): hiza bağda değişir, levha rebuild'de yeniden konumlanır.
  const bondPg = st.panelGroups.find(pg => pg.doorBond && pg.memberVfIds.includes(vfId));
  if (bondPg) {
    const bond = bondPg.doorBond!;
    if (bond.doorGroupId !== groupId || bond.splitId !== splitId || bond.k !== k) { console.warn('[YAGO][KAPAK-BAĞ] levha başka bir kapak derzine bağlı, bu derzle bağlanamaz:', vfId, bond); return; }
    if (!align) { st.updatePanelGroup(bondPg.id, { doorBond: undefined }); return; }
    if (bond.align === align) return;
    st.updatePanelGroup(bondPg.id, { doorBond: { ...bond, align } });
    await requestRebuild(group.shapeId);
    return;
  }
  if (!align) {
    if (!node.refs?.[k]) return;
    const refs = { ...node.refs }; delete refs[k];
    const sizes = sn.sizes.map(s => ({ ...s, edited: true }));
    st.updateDoorGroup(groupId, { tree: replaceDoorNode(group.tree, splitId, old => ({ ...(old as any), sizes, refs: Object.keys(refs).length ? refs : undefined })) });
    return;
  }
  const parent = shapeById(group.shapeId, st.shapes);
  if (!parent) return;
  const np = doorNearPanels(group, parent, st.shapes, st.virtualFaces, st.panelGroups).find(p => p.vfId === vfId);
  const joint = doorJoints(solveDoorTree(group)).find(j => j.splitId === splitId && j.k === k);
  if (!np || !joint || joint.axis !== np.kind) { console.warn('[YAGO][KAPAK-BAĞ] levha bu derzle bağlanamaz (yakın değil / eksen uyuşmaz):', vfId, splitId, k); return; }
  if (np.edge) { console.warn('[YAGO][KAPAK-BAĞ] kenar levhası (grup sınırı) derze bağlanmaz:', np.name); return; }
  const refs: Record<number, DoorJointRef> = { ...(node.refs ?? {}), [k]: { vfId, align } };
  const tree = replaceDoorNode(group.tree, splitId, old => ({ ...(old as any), refs }));
  // Sıra önemli: önce bağ yazılır (rebuild içindeki çözüm bağı görsün), sonra levha taşınır.
  st.updateDoorGroup(groupId, { tree });
  const moved = movePanelToAlign(group, { ...np, joint }, align, st.panelGroups);
  if (!moved) await writeDoorGroup({ ...group, tree }, {});
}
/** Derz binisi: levha kutusundan derz merkezi. 'center' = Half (iki kapak levha ortasına), 'min'/'max' = o taraftaki kapak Full. */
export const overlayJointCenter = (a0: number, a1: number, g: number, align: DoorAlign) =>
  (align === 'center' ? (a0 + a1) / 2 : align === 'min' ? a1 + g / 2 : a0 - g / 2);
/** Derzin levhaya göre durumu (geometriden): hizalardan biri değilse null (serbest). */
export function jointOverlayState(j: Pick<DoorJoint, 'p0' | 'p1'>, a0: number, a1: number, tol = 0.6): DoorAlign | null {
  const c = (j.p0 + j.p1) / 2, g = j.p1 - j.p0;
  return (['center', 'min', 'max'] as DoorAlign[]).find(a => Math.abs(overlayJointCenter(a0, a1, g, a) - c) <= tol) ?? null;
}
// Derzi `center`a kaydırır: yalnız iki komşu parça değişir (k büyür/küçülür, k+1 tersi). v ekseninde çocuklar ÜSTTEN dizilir.
function shiftJointSizes(sn: Extract<DoorNodeSolved, { kind: 'split' }>, k: number, center: number): GapSpec[] | null {
  const j = doorJoints(sn).find(x => x.splitId === sn.id && x.k === k);
  if (!j || k + 1 >= sn.sizes.length) return null;
  const d = center - (j.p0 + j.p1) / 2;
  const dk = sn.axis === 'u' ? d : -d;
  const total = sn.sizes[k].value + sn.sizes[k + 1].value;
  const a = round1(sn.sizes[k].value + dk), b = round1(total - a);
  if (a < MIN_DOOR_SPAN || b < MIN_DOOR_SPAN) return null;
  const sizes = sn.sizes.map(s => ({ ...s }));
  sizes[k] = { ...sizes[k], value: a, edited: true };
  sizes[k + 1] = { ...sizes[k + 1], value: b, edited: true };
  return sizes;
}
// DERZ BİNİSİ (Full/Half): LEVHA yerinde kalır, KAPAKLAR uzar/kısalır. Levha derzi izliyorsa (doorBond) bağın hizası değişir ve
// derz bir kez kaydırılır (levhanın istenen yeri aynı kalır); değilse derz levhaya bağlanır (refs) → kapaklar her çözümde levhayı izler.
export async function setDoorJointOverlay(groupId: string, splitId: string, k: number, vfId: string, align: DoorAlign): Promise<void> {
  const group = groupById(groupId);
  const node = group ? findDoorNode(group.tree, splitId) : null;
  if (!group || !node || node.kind !== 'split' || k < 0 || k >= node.children.length - 1) return;
  const st = useAppStore.getState();
  const parent = shapeById(group.shapeId, st.shapes);
  const sn = findSolvedNode(solveDoorTree(group), splitId);
  if (!parent || !sn || sn.kind !== 'split') return;
  const joint = doorJoints(sn).find(j => j.splitId === splitId && j.k === k);
  const np = doorNearPanels(group, parent, st.shapes, st.virtualFaces, st.panelGroups).find(p => p.vfId === vfId);
  if (!np || !joint || joint.axis !== np.kind || np.edge) { console.warn('[YAGO][KAPAK-BİNİ] levha bu derzin binisi olamaz (yakın değil / eksen uyuşmaz / kenar):', vfId, splitId, k); return; }
  const center = overlayJointCenter(np.a0, np.a1, joint.p1 - joint.p0, align);
  // Yalnız iki komşu kapak değişir; bağlı derzde de kaydırılmış ölçüler yazılır (Σ alanı tutar → çözücü diğerlerine dokunmaz).
  const sizes = shiftJointSizes(sn, k, center);
  if (!sizes) { console.warn('[YAGO][KAPAK-BİNİ] kapak bu biniye sığmıyor (en az', MIN_DOOR_SPAN, 'mm):', splitId, k, align); return; }
  const bondPg = st.panelGroups.find(pg => pg.doorBond && pg.memberVfIds.includes(vfId));
  if (bondPg) {
    const bond = bondPg.doorBond!;
    if (bond.doorGroupId === groupId && bond.splitId === splitId && bond.k === k) st.updatePanelGroup(bondPg.id, { doorBond: { ...bond, align } });
    else console.warn('[YAGO][KAPAK-BİNİ] levha başka bir derze bağlı / bağlanamaz — derz bir kez kaydırıldı (bağsız):', vfId, splitId, k);
    await writeDoorGroup(group, { tree: replaceDoorNode(group.tree, splitId, old => ({ ...(old as any), sizes })) });
    return;
  }
  const refs: Record<number, DoorJointRef> = { ...(node.refs ?? {}), [k]: { vfId, align } };
  await writeDoorGroup(group, { tree: replaceDoorNode(group.tree, splitId, old => ({ ...(old as any), sizes, refs })) });
}
/** Derzi `center`a taşır (doorBond'lu grubun boşluk girişi); derz panel-ref ile bağlıysa levha kazanır → false. */
export async function moveDoorJointTo(groupId: string, splitId: string, k: number, center: number): Promise<boolean> {
  const group = groupById(groupId);
  const sn = group ? findSolvedNode(solveDoorTree(group), splitId) : null;
  if (!group || !sn || sn.kind !== 'split' || k < 0 || k >= sn.children.length - 1 || !Number.isFinite(center)) return false;
  if (sn.refs?.[k]) { console.warn('[YAGO][KAPAK-BAĞ] derz panel-ref ile levhaya bağlı, kapak tarafından taşınamaz:', splitId, k); return false; }
  const g = sn.gaps[k] ?? group.gap, c = sn.children[k];
  const size = round1(sn.axis === 'u' ? (center - g / 2) - c.u0 : c.v1 - (center + g / 2));
  if (size < 1) { console.warn('[YAGO][KAPAK-BAĞ] derz bölmenin dışına çıkıyor, taşınmadı:', splitId, k, center.toFixed(1)); return false; }
  const L = sn.axis === 'u' ? sn.u1 - sn.u0 : sn.v1 - sn.v0;
  const sizes = applyGapEdit(sn.sizes, k, size, L, sn.gaps.length, sn.gaps);
  if (Math.abs((sizes[k]?.value ?? NaN) - size) > 0.05) { console.warn('[YAGO][KAPAK-BAĞ] derz taşınamadı (kilitli kapaklar):', splitId, k, size); return false; }
  const tree = replaceDoorNode(group.tree, splitId, old => ({ ...(old as any), sizes }));
  await writeDoorGroup(group, { tree });
  return true;
}

// Kapaklar arasına raf / dikme: derzden hacim ışını → 1 üyeli grup, doorBond ile 'center' bağlı. `at` = tıklanan derz parçası
// (derzin ortası bir dikmenin içine düşebilir → serbest hücre yok); yinelenme denetimi de PARÇA bazlı.
export function addPanelAtDoorJoint(groupId: string, splitId: string, k: number, at?: number): PanelGroup | null {
  const group = groupById(groupId);
  if (!group) return null;
  const st = useAppStore.getState();
  const parent = shapeById(group.shapeId, st.shapes);
  if (!parent) return null;
  const sol = solveDoorGroup(group, parent, st.shapes);
  const j = sol ? doorJoints(sol.solved).find(x => x.splitId === splitId && x.k === k) : undefined;
  if (!sol || !j) { console.warn('[YAGO][KAPAK-ARA] derz bulunamadı:', splitId, k); return null; }
  const node = findDoorNode(group.tree, splitId);
  if (node?.kind === 'split' && node.refs?.[k]) { console.warn('[YAGO][KAPAK-ARA] derz panel-ref ile bir levhaya bağlı, araya levha eklenmez:', splitId, k); return null; }
  const { u, v } = doorPlaneAxes(group.axis);
  const axis: 0 | 1 | 2 = j.axis === 'u' ? u : v, cross: 0 | 1 | 2 = j.axis === 'u' ? v : u;
  const kind: PanelGroup['kind'] = axis === 1 ? 'shelf' : 'divider';
  const atC = typeof at === 'number' && Number.isFinite(at) ? Math.min(Math.max(at, j.c0), j.c1) : (j.c0 + j.c1) / 2;
  const dup = st.panelGroups.find(pg => pg.doorBond && pg.doorBond.doorGroupId === groupId && pg.doorBond.splitId === splitId && pg.doorBond.k === k
    && pg.cavity.min[cross] - TOL <= atC && atC <= pg.cavity.max[cross] + TOL);
  if (dup) { console.warn('[YAGO][KAPAK-ARA] bu derzin bu parçasında zaten bağlı bir levha var:', splitId, k, dup.id, 'yer=', atC.toFixed(1), fmtBox(dup.cavity)); return null; }
  const body = bodyLocalBox(parent);
  if (!body) return null;
  const origin: Vec3 = [0, 0, 0], dir: Vec3 = [0, 0, 0];
  origin[axis] = (j.p0 + j.p1) / 2; origin[cross] = atC;
  origin[group.axis] = group.side > 0 ? Math.max(sol.rect.front, body.max[group.axis]) + 50 : Math.min(sol.rect.front, body.min[group.axis]) - 50;
  dir[group.axis] = -group.side;
  const grid = gridForObstacles(parent, collectObstacles(parent, st.shapes));
  if (!grid) { console.warn('[YAGO][KAPAK-ARA] hacim ızgarası kurulamadı'); return null; }
  const cands = rayCavityCandidates(origin, dir, grid, GROUP_PANEL_THICKNESS * 2, kind);
  const pick = cands.find(c => c.shape === 'shaped') ?? cands[0];
  if (!pick) { console.warn('[YAGO][KAPAK-ARA] derzin arkasında serbest hacim yok:', splitId, k, 'yer=', `${'XYZ'[cross]}=${atC.toFixed(1)}`, 'derz=', `${j.c0.toFixed(0)}..${j.c1.toFixed(0)}`); return null; }
  // Dizilim ekseni = derzin kalınlık ekseni (ışın yönünden bağımsız); sayım MİN'den.
  const bond: DoorBond = { doorGroupId: groupId, splitId, k, align: 'center', member: 0 };
  const pg = createPanelGroupFromCavity(group.shapeId, kind, { ...pick, axis, facing: 1 }, undefined, { doorBond: bond });
  if (!pg) return null;
  // Kapaklar arasındaki levha kapak sınırıdır (şema bandı + aday sınırı).
  for (const vfId of pg.memberVfIds) setVfDoorBound(vfId, true);
  return pg;
}

export async function setDoorThickness(groupId: string, t: number): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(t) || t < 1) return;
  const v = round1(t);
  if (Math.abs(v - group.thickness) < 0.05) return;
  const st = useAppStore.getState();
  for (const vfId of group.memberVfIds) {
    const panel = panelOfVf(vfId, st.shapes);
    if (panel) st.updateShape(panel.id, { parameters: { ...panel.parameters, panelThickness: v, depth: v } } as any);
  }
  await writeDoorGroup(group, { thickness: v });
}
export function renameDoorGroup(groupId: string, name: string): void {
  const group = groupById(groupId);
  if (!group) return;
  useAppStore.getState().updateDoorGroup(groupId, { name });
  const ids = new Set(group.memberVfIds);
  useAppStore.setState(s => ({ virtualFaces: s.virtualFaces.map(f => (ids.has(f.id) ? { ...f, description: name } : f)) }));
}
export function deleteDoorGroupWithMembers(groupId: string): void {
  const group = groupById(groupId);
  if (!group) return;
  removeMembers(group.memberVfIds);
  useAppStore.getState().deleteDoorGroup(groupId);
}

function pruneDoorRefs(tree: DoorNode, solved: DoorNodeSolved, vfs: VirtualFace[]): DoorNode | null {
  let out = tree, changed = false;
  for (const { splitId, k, ref } of doorJointRefs(tree)) {
    if (vfs.some(f => f.id === ref.vfId)) continue;
    const sn = findSolvedNode(solved, splitId);
    out = replaceDoorNode(out, splitId, old => {
      const o = old as Extract<DoorNode, { kind: 'split' }>;
      const refs = { ...(o.refs ?? {}) }; delete refs[k];
      const sizes = sn && sn.kind === 'split' ? sn.sizes.map(s => ({ ...s, edited: true })) : o.sizes;
      return { ...o, sizes, refs: Object.keys(refs).length ? refs : undefined };
    });
    changed = true;
    console.warn('[YAGO][KAPAK-BAĞ] bağlı levha silinmiş, bağ düştü (ölçüler donduruldu):', splitId, 'derz', k, ref.vfId);
  }
  return changed ? out : null;
}

/** Rebuild sonrası (PanelEngine): store'daki dikdörtgen/ağaç güncel çözümle eşitlenir (bağlı derzlerin izlediği levha dahil). */
export function syncDoorGroups(parentShapeId: string): void {
  const st = useAppStore.getState();
  const parent = shapeById(parentShapeId, st.shapes);
  if (!parent) return;
  for (const g of st.doorGroups) {
    if (g.shapeId !== parentShapeId) continue;
    const sol = solveDoorGroup(g, parent, st.shapes);
    if (!sol) continue;
    if (g.panelAlign) { st.updateDoorGroup(g.id, { panelAlign: undefined }); }
    const pruned = pruneDoorRefs(g.tree, sol.solved, st.virtualFaces);
    if (pruned) { st.updateDoorGroup(g.id, { rect: sol.rect, tree: pruned }); continue; }
    const sameRefs = (a?: Record<number, DoorJointRef>, b?: Record<number, DoorJointRef>) => {
      const ka = Object.keys(a ?? {}), kb = Object.keys(b ?? {});
      return ka.length === kb.length && ka.every(k => b?.[+k]?.vfId === a?.[+k]?.vfId && b?.[+k]?.align === a?.[+k]?.align);
    };
    const sameTree = (a: DoorNode, b: DoorNode): boolean => {
      if (a.kind !== b.kind || a.id !== b.id) return false;
      if (a.kind === 'leaf' || b.kind === 'leaf') {
        const la = (a as any).leafSplit as DoorLeafSplit | undefined, lb = (b as any).leafSplit as DoorLeafSplit | undefined;
        if (!la && !lb) return true;
        return !!la && !!lb && Math.abs(la.gap - lb.gap) < 0.05 && la.leaves.length === lb.leaves.length && la.leaves.every((x, i) => Math.abs(x.value - lb.leaves[i].value) < 0.05);
      }
      return a.children.length === b.children.length && a.sizes.length === b.sizes.length
        && a.sizes.every((x, i) => Math.abs(x.value - b.sizes[i].value) < 0.05 && x.locked === b.sizes[i].locked && !!x.edited === !!b.sizes[i].edited)
        && a.gaps.length === b.gaps.length && a.gaps.every((x, i) => Math.abs(x - b.gaps[i]) < 0.05) && sameRefs(a.refs, b.refs) && a.children.every((c, i) => sameTree(c, b.children[i]));
    };
    // Spacing: alan değiştiyse parça sayısı yeniden türetilir; sonraki rebuild aynı n'i bulup durur (döngü yok).
    try {
      const resize: Array<{ id: string; axis: 'u' | 'v'; n: number; cur: number }> = [];
      const scan = (n: DoorNodeSolved) => {
        if (n.kind !== 'split') return;
        if (n.targetSize) { const L = n.axis === 'u' ? n.u1 - n.u0 : n.v1 - n.v0; const want = Math.max(2, countForTargetSize(L, n.targetSize, g.gap)); if (want !== n.children.length) resize.push({ id: n.id, axis: n.axis, n: want, cur: n.children.length }); }
        n.children.forEach(scan);
      };
      scan(sol.solved);
      for (const r of resize.slice(0, 1)) { setDoorNodeSplit(g.id, r.id, r.axis, r.n, { keepTargetSize: true }); }
      if (resize.length) continue;   // üyeler yeniden kuruluyor; bu grubun senkronu bir sonraki rebuild'de
    } catch (err) { console.warn('[YAGO][KAPAK-SPACING] hata:', err instanceof Error ? err.message : String(err)); }
    if (rectKey(sol.rect) === rectKey(g.rect) && Math.abs(sol.rect.front - g.rect.front) < 0.05 && sameTree(sol.tree, g.tree)) continue;
    st.updateDoorGroup(g.id, { rect: sol.rect, tree: sol.tree });
  }
}

export function doorSlabPolygon(
  group: Pick<DoorGroup, 'axis' | 'side' | 'placement' | 'thickness' | 'gap' | 'anchor'>, rect: DoorRect, cuts: DoorCut[],
): { normal: Vec3; vertices: Vec3[] } {
  const m: DoorMemberRect = { leafId: PREVIEW_ID, type: 'left', leaf: 0, leafCount: 1, u0: rect.u0, u1: rect.u1, v0: rect.v0, v1: rect.v1 };
  const [mm] = applyDoorCuts({ ...group, id: PREVIEW_ID }, rect, [m], cuts);
  const g = doorMemberVfGeometry({ ...group } as DoorGroup, mm, rect);
  return { normal: g.normal, vertices: g.vertices };
}
