import {
  type CavityBox, type DoorAlign, type DoorBond, type DoorBoundRef, type DoorBounds, type DoorEdgeGaps, type DoorGroup, type DoorJointRef,
  type DoorLeafSplit, type DoorNode, type DoorPick, type DoorRect, type DoorType, type GapSpec, type PanelGroup, type Shape, type VirtualFace,
  panelOfVf, requestRebuild, shapeById, useAppStore,
} from '../store';
import { type Vec3, genId, round1 } from './Geometry';
import { clipHalfPlane, panelFrontHull, panelHasRotation, polyArea } from './FaceRegion';
// DİKKAT: DoorService ↔ PanelGroupService döngüsel içe aktarım. Modül üst düzeyinde PanelGroupService bağlarını OKUMA
// (`= gapMode` takma adı TDZ'ye düşer: "Cannot access before initialization"); yalnız fonksiyon gövdesinde çağır.
import {
  GROUP_PANEL_THICKNESS, type GapMode, applyGapEdit, applyGapEditProportional, bodyLocalBox, boxSpan, collectObstacles, createPanelGroupFromCavity,
  cycleGapMode, editGroupGap, gridForObstacles, groupFacing, memberThicknessesOf, panelLocalBox, passiveGapIndex, rayCavityCandidates,
  redistributeForThickness,
} from './PanelGroupService';
import {
  type BoundPanel, type EdgeInfo, type JointTargets, type LeafOf, type PlaneRect, type Pt2, type SlabCut, type SolvedBox, type SplitJoint,
  EDGE_KEYS, alignedMin, boundEdgeInfo, cloneTree, collectBoundPanels, collectRotatedCuts, cutBands, cutCoverFar, cutEdgeOf, depthOptions,
  jointCenter, jointKey, leavesSplittableAt, polyChanged, polyRect, pruneRefs, rayBoxEntry, rectKey, rectPoly, removeMemberVfs, renameMemberVfs,
  sameBounds, sameTree, setMemberPanelThickness, slabVfGeometry, solveTree, spacingResize, splitGapsOf, unsolveTree,
  findNode as findDoorNode, findNode as findSolvedNode, jointRefs as doorJointRefs, planeAxes as doorPlaneAxes, replaceNode as replaceDoorNode,
  spacingTargetsInScope as doorSpacingTargetsInScope, treeJoints as doorJoints, treeLeaves as doorLeaves,
} from './SplitShared';

// KAPAKLAR (DoorService) — yalnız kapak; ARKALIK ayrı serviste (BackService). Ortak saf yardımcılar SplitShared'de.
//  • Sınır = VF.doorBound işaretli paneller; yoksa gövde kenarı. Düzlem = tıklanan gövde yüzü; u = yatay (sütun), v = düşey (satır).
//  • İç kapak sınır panellerinin İÇ yüzleri arasına, dış kapak DIŞ yüzlerine kadar (gövdenin dışına taşabilir).
//  • Bölme = AĞAÇ (DoorGroup.tree); split alanını çocuklarına KATSAYI kuralıyla dağıtır, bölmek üst ölçüsünü değiştirmez.
//  • Kapak VF'leri her rebuild'de buradan yazılır; kapak panelleri DAMGALAMAZ, hacim engeli değildir, gövdeyle kesilmez.
//  • Dönmüş sınır paneli kenar olmaz; kapağı büyük-yüz düzlemiyle keser (kapak düzlemi değişmez).
//  • Bağ yönü tek: ya derz levhayı izler (DoorNode.refs) ya levha derzi (PanelGroup.doorBond) — ikisi birden yasak.

export {
  doorJointRefs, doorJoints, doorLeaves, doorPlaneAxes, doorSpacingTargetsInScope, findDoorNode, findSolvedNode, replaceDoorNode,
  cutBands as doorCutBands, jointCenter as overlayJointCenter,
};
export { gapMode as doorSizeMode, passiveGapIndex as passiveSizeIndex } from './PanelGroupService';
export type { Pt2 };

export const DOOR_THICKNESS = 18;
export const DOOR_GAP = 3;
const TOL = 0.5;
const MIN_DOOR_SPAN = 40;
const MIN_DOOR_SIZE = 1;
const PREVIEW_ID = 'önizleme';
const MAX_DOOR_SPLIT = 12;
const NEAR_EXTRA = 3;        // kapak kenarı ile levha arasındaki "yaklaşma" payı (mm), boşluğun üstüne
const THIN_PANEL = 60;       // levha sayılacak en büyük kalınlık (mm); daha kalını (arkalık vb.) sayılmaz
const EDGE_ADOPT_TOL = 1;    // gövde kenarı ile levhanın dış yüzü arası en büyük fark (mm)
export const JOINT_NEAR = 30;   // levha merkezi ile derz merkezi arası en büyük uzaklık (mm; + yarım kalınlık + yarım derz)

export const isDoorPanel = (p: any): boolean => !!p?.parameters?.doorGroupId;
export const isDoorVf = (vf: any): boolean => !!vf?.doorGroupId;
export const doorGroupName = (g: Pick<DoorGroup, 'name'>) => g.name ?? 'Door';
export const doorPlacementLabel = (p: DoorGroup['placement']) => (p === 'inner' ? 'Inner' : 'Outer');

export const DOOR_TYPES: DoorType[] = ['left', 'right', 'up', 'down', 'double', 'fold', 'drawer', 'fixed'];
export const DOOR_TYPE_LABEL: Record<DoorType, string> = {
  left: 'Left', right: 'Right', up: 'Up', down: 'Down', double: 'Double', fold: 'Fold', drawer: 'Drawer', fixed: 'Fixed',
};
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

/** Işının gövde kutusuna girdiği yüz (side: max yüz → +1, min yüz → −1) + nokta; kamera kutunun içindeyse null. */
export function rayDoorEntry(o: Vec3, d: Vec3, b: CavityBox): { axis: 0 | 1 | 2; side: 1 | -1; point: Vec3 } | null {
  const e = rayBoxEntry(o, d, b);
  if (!e) return null;
  const point: Vec3 = [o[0] + d[0] * e.t, o[1] + d[1] * e.t, o[2] + d[2] * e.t];
  return { axis: e.axis, side: e.pos ? -1 : 1, point };
}

export type DoorBoundPanel = BoundPanel;
/** Kapak sınırı panelleri (gövde-yerel kutu); kapaklar ve dönmüş paneller hariç. onlyBound=false: işaretsizler de (derz parçalama). */
export function collectDoorBoundPanels(
  parent: Shape, shapes: Shape[] = useAppStore.getState().shapes, vfs: VirtualFace[] = useAppStore.getState().virtualFaces, onlyBound = true,
): DoorBoundPanel[] {
  return collectBoundPanels(parent, shapes, vfs, vf => (!onlyBound || !!vf.doorBound) && !isDoorVf(vf));
}

/** Dönmüş sınır paneli: büyük-yüz normali + o normaldeki [dMin,dMax] + kutu; pts = tekil köşeler (şema ön görünüşü). */
export type DoorCut = SlabCut;
export function collectDoorCuts(
  parent: Shape, shapes: Shape[] = useAppStore.getState().shapes, vfs: VirtualFace[] = useAppStore.getState().virtualFaces,
): DoorCut[] {
  return collectRotatedCuts(parent, shapes, vfs, vf => !!vf.doorBound && !isDoorVf(vf));
}

// Üyeyi dönmüş panellerin büyük-yüz düzlemleriyle kırpar; kesim kapağın İKİ yüzeyinde alınır, kısıtlayıcı olan tutulur
// (kapak eğik panele girmez). Kenar boşluğu = kesicinin kestiği kenarın boşluğu.
function clipMemberByCuts(
  m: PlaneRect, cuts: DoorCut[], axis: 0 | 1 | 2, side: 1 | -1, placement: DoorGroup['placement'], thickness: number, front: number,
  gapIn: number | DoorEdgeGaps, half?: HalfOverlay, ref?: [number, number],
): Pt2[] | null {
  if (!cuts.length) return null;
  const { u, v } = doorPlaneAxes(axis);
  let poly = rectPoly(m);
  const planes = placement === 'outer' ? [front, front + side * thickness] : [front - side * thickness, front];
  // Tutulan taraf: çıpa (tıklanan nokta / anchor) varsa o, yoksa üyenin merkezi.
  const cu = ref ? ref[0] : (m.u0 + m.u1) / 2, cv = ref ? ref[1] : (m.v0 + m.v1) / 2;
  let any = false;
  for (const c of cuts) {
    const ovU = Math.min(c.box.max[u], m.u1) - Math.max(c.box.min[u], m.u0), ovV = Math.min(c.box.max[v], m.v1) - Math.max(c.box.min[v], m.v0);
    if (ovU < TOL || ovV < TOL) continue;
    const A = c.n[u], B = c.n[v], Na = c.n[axis];
    const ce = cutEdgeOf(c, cu, cv, axis, front);
    if (!ce) continue;
    const gap = typeof gapIn === 'number' ? gapIn : gapIn[ce.edge];
    const coverFar = cutCoverFar(c, axis, side, placement, front);
    // Yarım binme: uzak yüz yerine levhanın ortası (düz kenardaki (iç+dış)/2 kuralı).
    const halfHere = coverFar && !!half?.[ce.edge];
    const mid = (c.dMin + c.dMax) / 2;
    const before = poly;
    if (ce.keepBelow) {
      const lim = (halfHere ? mid : coverFar ? c.dMax : c.dMin) - gap;
      poly = clipHalfPlane(poly, A, B, Math.min(...planes.map(pa => lim - Na * pa)));
    } else {
      const lim = (halfHere ? mid : coverFar ? c.dMin : c.dMax) + gap;
      poly = clipHalfPlane(poly, -A, -B, -Math.max(...planes.map(pa => lim - Na * pa)));
    }
    // Kesim üyeyi yok ediyorsa atlanır.
    if (poly.length < 3 || polyArea(poly) < MIN_DOOR_SPAN * MIN_DOOR_SPAN) { poly = before; continue; }
    if (polyChanged(poly, before)) any = true;
  }
  return any ? poly : null;
}

export function setVfDoorBound(vfId: string, on: boolean): void {
  const st = useAppStore.getState();
  const vf = st.virtualFaces.find(f => f.id === vfId);
  if (!vf || !!vf.doorBound === on) return;
  st.updateVirtualFace(vfId, { doorBound: on });
  if (on) adoptBoundsAfterMark(vf.shapeId);
}
/** Sınır işaretinden sonra: gövde kenarına bağlı kenarı bu levhayı devralan gruplar hemen yeniden yazılır (rebuild). */
function adoptBoundsAfterMark(shapeId: string): void {
  const st = useAppStore.getState();
  const parent = shapeById(shapeId, st.shapes);
  if (!parent) return;
  for (const g of st.doorGroups) {
    if (g.shapeId !== shapeId) continue;
    const rb = resolveDoorBounds(g, parent, st.shapes, st.virtualFaces);
    if (!sameBounds(rb, g.bounds)) void writeDoorGroup(g, { bounds: rb });
  }
}

type SideOpt = EdgeInfo & { cross: [number, number]; name: string };

// KENAR KURALI: P = derinlik referansının ön yüzü; outer [P, P+t], inner [P−t, P]. Inner → kenar İÇ yüz. Outer → panel kapağın
// gerisindeyse kalınlığını örter (DIŞ yüz), P'den öne taşıyorsa çarpmamak için İÇ yüz. Yarım binme yalnız örtülen kenarda: (iç+dış)/2.
type DoorEdges = { l: EdgeInfo; r: EdgeInfo; b: EdgeInfo; t: EdgeInfo };
type HalfOverlay = DoorGroup['halfOverlay'];
const edgeCovered = (x: EdgeInfo, side: 1 | -1, placement: DoorGroup['placement'], P: number) =>
  x.front != null && placement === 'outer' && (side > 0 ? x.front <= P + TOL : x.front >= P - TOL);
function rectAtDepth(e: DoorEdges, side: 1 | -1, placement: DoorGroup['placement'], P: number, half?: HalfOverlay, none?: HalfOverlay): DoorRect {
  const pick = (x: EdgeInfo, h: boolean | undefined, n: boolean | undefined) => {
    if (!edgeCovered(x, side, placement, P) || n) return x.inner;   // None: örtülebilir kenarda da iç yüzde biter
    return h ? (x.inner + x.outer) / 2 : x.outer;
  };
  return {
    u0: pick(e.l, half?.uMin, none?.uMin), u1: pick(e.r, half?.uMax, none?.uMax),
    v0: pick(e.b, half?.vMin, none?.vMin), v1: pick(e.t, half?.vMax, none?.vMax), front: P,
  };
}

// Kapak adayları: dört yandaki sınır seçeneklerinin her kombinasyonu bir dikdörtgen; seçilen panel çapraz açıklıkla örtüşmeli
// (kısa dikme yalnız kendi boyunu sınırlar). Sıra: alan büyükten küçüğe (önce dıştakiler).
export function doorCandidatesAt(parent: Shape, axis: 0 | 1 | 2, side: 1 | -1, click: Vec3, shapes?: Shape[], vfs?: VirtualFace[]): DoorPick[] {
  const body = bodyLocalBox(parent);
  if (!body) return [];
  const { u, v } = doorPlaneAxes(axis);
  const bounds = collectDoorBoundPanels(parent, shapes, vfs, true);
  const cu = click[u], cv = click[v];
  const frontOf = (b: CavityBox) => (side > 0 ? b.max[axis] : b.min[axis]);
  const bodyFront = side > 0 ? body.max[axis] : body.min[axis];
  // Gövde kenarı da seçenektir, o yanda gövde kenarına dayanan sınır paneli yoksa (yalnız iç dikme işaretliyken BÜTÜN kapak da aday).
  const optsFor = (ax: 0 | 1 | 2, cx: 0 | 1 | 2, c: number, minSide: boolean): SideOpt[] => {
    const out: SideOpt[] = [];
    const edge = minSide ? body.min[ax] : body.max[ax];
    for (const bp of bounds) {
      const b = bp.box;
      const onSide = minSide ? b.max[ax] <= c + TOL : b.min[ax] >= c - TOL;
      if (!onSide) continue;
      out.push({
        ref: { vfId: bp.vfId }, inner: minSide ? b.max[ax] : b.min[ax], outer: minSide ? b.min[ax] : b.max[ax],
        cross: [b.min[cx], b.max[cx]], front: frontOf(b), name: bp.name,
      });
    }
    if (!out.some(o => Math.abs(o.outer - edge) <= TOL)) {
      out.push({ ref: { body: true }, inner: edge, outer: edge, cross: [body.min[cx], body.max[cx]], front: null, name: 'Body' });
    }
    return out;
  };
  const L = optsFor(u, v, cu, true), R = optsFor(u, v, cu, false), B = optsFor(v, u, cv, true), T = optsFor(v, u, cv, false);
  const overlaps = (cross: [number, number], a0: number, a1: number) => Math.min(cross[1], a1) - Math.max(cross[0], a0) > TOL;
  // Açılı sınır panelleri: aday alanı tıklanan noktanın tarafına kırpılır (panelin iki yanına da kapak atılabilir).
  const cuts = collectDoorCuts(parent, shapes, vfs);
  const at: [number, number] = [cu, cv];
  const shrink = (placement: DoorGroup['placement'], r: DoorRect) =>
    rectByCuts({ axis, side, placement, thickness: DOOR_THICKNESS, gap: DOOR_GAP }, r, cuts, at);
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
type DoorLeaf = LeafOf<DoorNode>;
export type DoorNodeSolved =
  | { id: string; kind: 'leaf'; type: DoorType; leafSplit?: DoorLeafSplit; u0: number; u1: number; v0: number; v1: number; depth: number }
  | {
    id: string; kind: 'split'; axis: 'u' | 'v'; sizes: GapSpec[]; gaps: number[]; children: DoorNodeSolved[];
    targetSize?: number; refs?: Record<number, DoorJointRef>; u0: number; u1: number; v0: number; v1: number; depth: number;
  };
export interface DoorSolution { rect: DoorRect; tree: DoorNode; solved: DoorNodeSolved; members: DoorMemberRect[]; bounds?: DoorBounds }
/** `${splitId}:${k}` → bağlı derzin merkezi (bölmenin ekseninde). */
export type DoorJointTargets = JointTargets;
export type DoorLayout = Pick<DoorGroup, 'rect' | 'tree' | 'edgeGaps' | 'gap'>;

export const makeDoorLeaf = (type: DoorType, leafSplit?: DoorLeafSplit): DoorNode =>
  ({ id: genId('dl'), kind: 'leaf', type, ...(leafSplit ? { leafSplit } : {}) });
/** Kenar boşlukları; NEGATİF değer = kenar panelinin içine giriş (kanallı arkalık). Kapak girişleri ≥ 0 tutulur (setDoorEdgeGap). */
export function edgeGapsOf(g: Pick<DoorGroup, 'gap'> & { edgeGaps?: DoorEdgeGaps }): DoorEdgeGaps {
  const e = g.edgeGaps;
  const of = (x: number | undefined) => (Number.isFinite(x) ? x as number : g.gap);
  return { uMin: of(e?.uMin), uMax: of(e?.uMax), vMin: of(e?.vMin), vMax: of(e?.vMax) };
}
export const doorMemberCount = (g: Pick<DoorGroup, 'tree'>) => doorLeaves(g.tree).reduce((a, l) => a + (doorLeafAxis(l.type) ? 2 : 1), 0);
/** Alt ağacın yeni kimlikli kopyası; derz bağları da kopyalanır (levha parçayı kesmiyorsa doorJointTargets bağı yok sayar). */
export function cloneDoorNode(n: DoorNode): DoorNode {
  return cloneTree(n, 'ds', l => {
    const ls = l.leafSplit;
    return { ...l, id: genId('dl'), ...(ls ? { leafSplit: { gap: ls.gap, leaves: ls.leaves.map(x => ({ ...x })) } } : {}) };
  });
}

export type DoorSizeMode = GapMode;

/** Yaprak çözümü: double/fold kanatları hücreye dağıtılır (kanat arası boşluk yoksa kapak boşluğu). */
function solveDoorLeaf(n: DoorLeaf, at: SolvedBox, gap: number): DoorNodeSolved {
  const ax = doorLeafAxis(n.type);
  if (!ax) return { ...n, leafSplit: undefined, ...at };
  const lg = Number.isFinite(n.leafSplit?.gap) && n.leafSplit!.gap >= 0 ? n.leafSplit!.gap : gap;
  const leaves = redistributeForThickness(n.leafSplit?.leaves ?? [], ax === 'u' ? at.u1 - at.u0 : at.v1 - at.v0, 1, [lg]);
  return { ...n, leafSplit: { gap: lg, leaves }, ...at };
}
/** Ağaç çözümü (kök alanı = dikdörtgen − kenar boşlukları); u: soldan sağa, v: ÜSTTEN aşağı. */
export function solveDoorTree(g: DoorLayout, rect: DoorRect = g.rect, targets?: DoorJointTargets): DoorNodeSolved {
  const e = edgeGapsOf(g);
  const r = { u0: rect.u0 + e.uMin, u1: rect.u1 - e.uMax, v0: rect.v0 + e.vMin, v1: rect.v1 - e.vMax };
  return solveTree(g.tree, r, g.gap, targets, (l, at) => solveDoorLeaf(l, at, g.gap));
}
export function solvedToTree(n: DoorNodeSolved): DoorNode {
  return unsolveTree(n, (l): DoorNode => ({ id: l.id, kind: 'leaf', type: l.type, ...(l.leafSplit ? { leafSplit: l.leafSplit } : {}) }));
}
// Bağlı derz merkezi levhanın GÜNCEL kutusundan: 'center' → levha ortası, 'min' → max yüz + yarım derz (levha min taraftaki
// kapağın arkasında), 'max' → min yüz − yarım derz. Levha yok / dönmüş / kalın → derz hedefsiz.
export function doorJointTargets(group: DoorLayout & Pick<DoorGroup, 'axis'>, parent: Shape, shapes: Shape[]): DoorJointTargets {
  const out: DoorJointTargets = new Map();
  const refs = doorJointRefs(group.tree);
  if (!refs.length) return out;
  const { u, v } = doorPlaneAxes(group.axis);
  // İki yönlü bağ yasak: levhası derzi izleyen (doorBond) bağ yok sayılır.
  const bonded = new Set(useAppStore.getState().panelGroups.filter(pg => pg.doorBond).flatMap(pg => pg.memberVfIds));
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
    out.set(jointKey(splitId, k), jointCenter(a0, a1, g, ref.align));
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

// SONRADAN KONAN SINIR LEVHASI: kapak gövde kenarına bağlıyken o kenara sonradan konup sınır işaretlenen levha (yan/üst/alt panel)
// kapak kenarı olur → Full / Half / None o levhaya göre çalışır. Panel kenarları korunur; yalnız gövde kenarları devralınır.
export function resolveDoorBounds(
  group: DoorGroup, parent: Shape, shapes: Shape[] = useAppStore.getState().shapes, vfs: VirtualFace[] = useAppStore.getState().virtualFaces,
): DoorBounds {
  if (EDGE_KEYS.every(k => group.bounds[k]?.vfId)) return group.bounds;
  const body = bodyLocalBox(parent);
  if (!body) return group.bounds;
  const bps = collectDoorBoundPanels(parent, shapes, vfs, true);
  if (!bps.length) return group.bounds;
  const { u, v } = doorPlaneAxes(group.axis);
  let out = group.bounds;
  for (const k of EDGE_KEYS) {
    if (group.bounds[k]?.vfId) continue;
    const isU = k === 'uMin' || k === 'uMax', minSide = k === 'uMin' || k === 'vMin';
    const ax = isU ? u : v, cx = isU ? v : u;
    const edge = minSide ? body.min[ax] : body.max[ax];
    const c0 = isU ? group.rect.v0 : group.rect.u0, c1 = isU ? group.rect.v1 : group.rect.u1;
    let best: DoorBoundPanel | null = null, bestOv = MIN_DOOR_SPAN;
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

function solveDoorEdges(group: DoorGroup, parent: Shape, shapes: Shape[]): { edges: DoorEdges; P: number; bounds: DoorBounds } | null {
  const body = bodyLocalBox(parent);
  if (!body) return null;
  const { u, v } = doorPlaneAxes(group.axis);
  const bounds = resolveDoorBounds(group, parent, shapes);
  const ei = (ref: DoorBoundRef, ax: 0 | 1 | 2, minSide: boolean) => boundEdgeInfo(ref, parent, shapes, body, ax, minSide, group.axis, group.side);
  const edges: DoorEdges = { l: ei(bounds.uMin, u, true), r: ei(bounds.uMax, u, false), b: ei(bounds.vMin, v, true), t: ei(bounds.vMax, v, false) };
  const bodyFront = group.side > 0 ? body.max[group.axis] : body.min[group.axis];
  // Derinlik: kayıtlı referans panelin ön yüzü (panel taşınınca izler); yoksa (ya da bulunamazsa) en gerideki sınır panelinin önü.
  const all = [edges.l, edges.r, edges.b, edges.t];
  const fronts = all.map(x => x.front).filter((x): x is number => x != null);
  let P = !fronts.length ? bodyFront : (group.side > 0 ? Math.min(...fronts) : Math.max(...fronts));
  if (group.depthRef?.body) P = bodyFront;
  else if (group.depthRef?.vfId) {
    const hit = all.find(x => x.ref.vfId === group.depthRef!.vfId && x.front != null);
    if (hit) P = hit.front!;
  }
  return { edges, P, bounds };
}
/** Seçme önizlemesi: adayın yerleşime göre dikdörtgeni. */
export const pickRectFor = (pick: DoorPick, placement: DoorGroup['placement']): DoorRect => (placement === 'inner' ? { ...pick.inner } : { ...pick.outer });

export type DoorEdgeKey = keyof DoorBounds;

export function solveDoorGroup(group: DoorGroup, parent: Shape, shapes: Shape[]): DoorSolution | null {
  const s = solveDoorEdges(group, parent, shapes);
  if (!s) return null;
  const { edges, P, bounds } = s;
  const cutsAll = collectDoorCuts(parent, shapes, undefined);
  const base = rectAtDepth(edges, group.side, group.placement, P, group.halfOverlay, group.noOverlay);
  let rect: DoorRect = rectByCuts(group, base, cutsAll, group.anchor);
  // Dikdörtgen bozuk / çok küçükse önceki korunur.
  if (rect.u1 - rect.u0 < MIN_DOOR_SPAN || rect.v1 - rect.v0 < MIN_DOOR_SPAN) rect = { ...group.rect };
  const solved = solveDoorTree(group, rect, doorJointTargets(group, parent, shapes));
  const members = applyDoorCuts(group, rect, doorMemberRects(solved), cutsAll);
  return { rect, tree: solvedToTree(solved), solved, members, bounds };
}

type DoorCutGroup = Pick<DoorGroup, 'axis' | 'side' | 'placement' | 'thickness' | 'gap' | 'halfOverlay' | 'anchor'> & { edgeGaps?: DoorEdgeGaps };
export function applyDoorCuts(group: DoorCutGroup & Pick<DoorGroup, 'id'>, rect: DoorRect, members: DoorMemberRect[], cuts: DoorCut[]): DoorMemberRect[] {
  if (!cuts.length) return members;
  const eg = edgeGapsOf(group);
  return members.map(m => {
    const poly = clipMemberByCuts(m, cuts, group.axis, group.side, group.placement, group.thickness, rect.front, eg, group.halfOverlay, group.anchor);
    return poly ? { ...m, poly } : m;
  });
}

// Açılı sınır panelinde kapak alanı çıpanın (tıklanan nokta) tarafına kırpılıp kutusuna daraltılır; eğik kenar applyDoorCuts'ta çokgen kalır.
export function rectByCuts(
  group: Pick<DoorGroup, 'axis' | 'side' | 'placement' | 'thickness' | 'gap' | 'halfOverlay'>, rect: DoorRect, cuts: DoorCut[], anchor?: [number, number],
): DoorRect {
  if (!anchor || !cuts.length) return rect;
  // Boşluksuz kırpılır: kenar boşluğu kökte (solveDoorTree) düşülür; burada da düşülse eğik köşede boşluk iki kez düşer (basamak).
  const poly = clipMemberByCuts(rect, cuts, group.axis, group.side, group.placement, group.thickness, rect.front, 0, group.halfOverlay, anchor);
  if (!poly || poly.length < 3) return rect;
  const out = polyRect(poly, rect.front);
  return out.u1 - out.u0 < MIN_DOOR_SPAN || out.v1 - out.v0 < MIN_DOOR_SPAN ? rect : out;
}

/** Bölge dikdörtgeninin açılı panellerle kırpılmış şekli; withGap=false → kesici yüzünde (şema boşluk şeritlerinin kırpma alanı). */
export function doorCutOutline(group: DoorCutGroup, rect: DoorRect, r: PlaneRect, cuts: DoorCut[], withGap = true): Pt2[] {
  const base = rectPoly(r);
  if (!cuts.length) return base;
  const gaps = withGap ? edgeGapsOf(group) : 0;
  return clipMemberByCuts(r, cuts, group.axis, group.side, group.placement, group.thickness, rect.front, gaps, group.halfOverlay, group.anchor) ?? base;
}

// createPanelFromVirtualFace −normal yönünde t uzar → VF düzlemi kapağın DIŞ yüzü: dış kapak ön + side·t, iç kapak ön.
function doorMemberVfGeometry(group: DoorGroup, m: DoorMemberRect, rect: DoorRect): { normal: Vec3; vertices: Vec3[]; center: Vec3 } {
  const plane = group.placement === 'outer' ? rect.front + group.side * group.thickness : rect.front;
  return slabVfGeometry(group.axis, group.side, plane, m);
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
export type DoorJoint = SplitJoint;

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
export function doorNearPanels(
  group: DoorGroup, parent: Shape, shapes: Shape[], vfs: VirtualFace[], panelGroups: PanelGroup[], members?: DoorMemberRect[], allPanels = false,
): DoorNearPanel[] {
  if (group.placement !== 'outer') return [];   // iç kapakta şerit yok
  const { u, v } = doorPlaneAxes(group.axis);
  const solved = solveDoorTree(group);
  const ms = members ?? doorMemberRects(solved);
  const joints = doorJoints(solved);
  const near = Math.max(group.gap, 0) + NEAR_EXTRA;
  const front = group.rect.front;
  const rb = resolveDoorBounds(group, parent, shapes, vfs);
  const edgeOf = (vfId: string): DoorEdgeKey | undefined => EDGE_KEYS.find(k => rb[k]?.vfId === vfId);
  const jointAt = (splitId: string, k: number) => joints.find(j => j.splitId === splitId && j.k === k);
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
      const onAxis = (splitId: string, k: number) => joints.some(j => j.splitId === splitId && j.k === k && j.axis === kind);
      const bound = refs.find(r => r.ref.vfId === bp.vfId && onAxis(r.splitId, r.k));
      const db = pg?.doorBond;
      const bond = db && db.doorGroupId === group.id && (db.member ?? 0) === memberIndex ? db : undefined;
      if (bound) {
        ref = { splitId: bound.splitId, k: bound.k, align: bound.ref.align, master: 'panel' };
        joint = jointAt(bound.splitId, bound.k);
      } else if (bond && onAxis(bond.splitId, bond.k)) {
        ref = { splitId: bond.splitId, k: bond.k, align: bond.align, master: 'door' };
        joint = jointAt(bond.splitId, bond.k);
      } else {
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
export function doorJointParts(
  joints: DoorJoint[], obstacles: DoorNearPanel[], axis: 'u' | 'v', minSeg = 40,
): Array<{ joint: DoorJoint; all: Array<[number, number]>; free: Array<[number, number]> }> {
  return joints.filter(j => j.axis === axis).map(j => {
    const crosses = (np: DoorNearPanel) => Math.min(np.c1, j.p1) - Math.max(np.c0, j.p0) > -TOL && np.a1 > j.c0 + TOL && np.a0 < j.c1 - TOL;
    const cutters = obstacles.filter(np => np.kind !== j.axis && crosses(np)).map(np => [np.a0, np.a1] as [number, number]).sort((a, b) => a[0] - b[0]);
    const all: Array<[number, number]> = [];
    let s0 = j.c0;
    for (const [a0, a1] of cutters) { if (a0 - s0 >= minSeg) all.push([s0, a0]); s0 = Math.max(s0, a1); }
    if (j.c1 - s0 >= minSeg) all.push([s0, j.c1]);
    // Parça ortası aynı türde (derz boyunca uzanan) bir levhanın içindeyse serbest değil.
    const covers = (np: DoorNearPanel, mid: number) =>
      np.kind === j.axis && Math.min(np.a1, j.p1) - Math.max(np.a0, j.p0) > -TOL && np.c0 - TOL <= mid && mid <= np.c1 + TOL;
    const free = all.filter(([c0, c1]) => !obstacles.some(np => covers(np, (c0 + c1) / 2)));
    return { joint: j, all, free };
  });
}

export function alignedPanelMin(np: Pick<DoorNearPanel, 'a0' | 'a1' | 'joint'>, align: DoorAlign): number | null {
  return np.joint ? alignedMin(np.joint.p0, np.joint.p1, np.a1 - np.a0, align) : null;
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
  const panelMin = (t: number) => alignedMin(j.p0, j.p1, t, bond.align);
  return { axis, cross, p0: j.p0, p1: j.p1, c0: j.c0, c1: j.c1, panelMin };
}

// Levhayı derze göre bir kez taşır (kapak yerinde kalır), kendi grup boşluğunu yazarak. false → çağıran derzi levhaya götürür
// (levha raf/dikme üyesi değil, grubun dizilim ekseni levhanın kalınlık ekseni değil ya da boşluk yazılamıyor).
function movePanelToAlign(group: Pick<DoorGroup, 'id' | 'axis'>, np: DoorNearPanel, align: DoorAlign, panelGroups: PanelGroup[]): boolean {
  const want = alignedPanelMin(np, align);
  if (want == null) return false;
  const delta = want - np.a0;
  if (Math.abs(delta) < 0.05) return true;
  const pg = np.groupId ? panelGroups.find(g => g.id === np.groupId) : undefined;
  if (!pg || np.memberIndex == null || np.memberIndex < 0) return false;
  const { u, v } = doorPlaneAxes(group.axis);
  if (pg.axis !== (np.kind === 'u' ? u : v)) return false;
  const k = np.memberIndex;
  const cur = pg.gaps[k]?.value;
  if (cur == null) return false;
  const next = round1(cur + groupFacing(pg) * delta);
  if (next < 0) return false;
  const sim = applyGapEditProportional(pg.gaps, k, next, boxSpan(pg.cavity, pg.axis), pg.count, memberThicknessesOf(pg));   // editGroupGap ile aynı kural
  if (Math.abs((sim[k]?.value ?? NaN) - next) > 0.05) return false;   // kilitli komşular
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

export function createDoorGroupFromPick(shapeId: string, pick: DoorPick, placement: DoorGroup['placement'], name?: string): DoorGroup | null {
  const st = useAppStore.getState();
  const parent = shapeById(shapeId, st.shapes);
  if (!parent) return null;
  const rect = placement === 'inner' ? { ...pick.inner } : { ...pick.outer };
  const group: DoorGroup = {
    id: genId('door'), shapeId, axis: pick.axis, side: pick.side, placement, bounds: pick.bounds, depthRef: pick.depth, rect,
    anchor: pick.at, tree: makeDoorLeaf('left'),
    edgeGaps: { uMin: DOOR_GAP, uMax: DOOR_GAP, vMin: DOOR_GAP, vMax: DOOR_GAP },
    gap: DOOR_GAP, thickness: DOOR_THICKNESS,
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
// (paneli otomatik üretim yaratır). restructured = üyeleri her durumda yenilenecek yapraklar. Üye sayısı tutmuyorsa hepsi yenilenir.
function rebuildMembers(group: DoorGroup, nextGroup: DoorGroup, restructured: Set<string>): void {
  const st = useAppStore.getState();
  const sol = solveFromStore(nextGroup) || fallbackSolution(nextGroup);
  const oldMembers = fallbackSolution(group).members;
  const oldIds = new Map<string, string>();
  if (oldMembers.length === group.memberVfIds.length) {
    oldMembers.forEach((m, i) => { if (group.memberVfIds[i]) oldIds.set(`${m.leafId}/${m.leaf}`, group.memberVfIds[i]); });
  }
  const ids: string[] = [], kept: string[] = [], fresh: VirtualFace[] = [];
  sol.members.forEach((m, i) => {
    const prev = restructured.has(m.leafId) ? undefined : oldIds.get(`${m.leafId}/${m.leaf}`);
    if (prev) { ids.push(prev); kept.push(prev); }
    else { const vf = makeMemberVf(nextGroup, i, sol); ids.push(vf.id); fresh.push(vf); }
  });
  removeMemberVfs(group.memberVfIds.filter(id => !kept.includes(id)));
  for (const id of kept) st.updateVirtualFace(id, { doorIndex: ids.indexOf(id) });
  st.updateDoorGroup(group.id, { ...nextGroup, rect: sol.rect, tree: sol.tree, memberVfIds: ids });
  // Yeni kapaklar korunan son üyeden sonra eklenir: grup listede bir arada kalır.
  const order = useAppStore.getState().virtualFaces.map(f => f.id);
  const lastKept = kept.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b)).pop() ?? null;
  st.insertVirtualFacesAfter(lastKept, fresh);
  const now = useAppStore.getState();
  if (now.selectedDoorGroupId !== group.id && !now.selectedPanelRow) st.setSelectedDoorGroupId(group.id);
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
  const rebuildWith = (id: string, repl: DoorNode, restructured: Set<string>) =>
    rebuildMembers(group, { ...group, tree: replaceDoorNode(group.tree, id, () => repl) }, restructured);
  if (node.kind === 'leaf') {
    if (n <= 1) return node.id;
    const baseType: DoorType = doorLeafAxis(node.type) ? 'left' : node.type;
    const split: DoorNode = { id: genId('ds'), kind: 'split', axis, sizes: [], gaps: gapsFor(n - 1), children: newLeaves(n, 0, n, baseType) };
    rebuildWith(node.id, split, new Set([node.id]));
    return split.id;
  }
  if (node.axis === axis) {
    if (n === node.children.length) return node.id;
    if (n <= 1) {
      const first = node.children[0];
      rebuildWith(node.id, first, new Set(node.children.slice(1).flatMap(c => doorLeaves(c).map(l => l.id))));
      return first.id;
    }
    const restructured = new Set<string>();
    let children = node.children.slice();
    if (n > children.length) {
      // Artış: son parça bir bölmeyse yeni parçalar onun kopyası (bölünmüş hal korunur), değilse eşit yeni kapaklar.
      const last = children[children.length - 1], add = n - children.length;
      const extra = last.kind === 'split' ? Array.from({ length: add }, () => cloneDoorNode(last)) : newLeaves(add, children.length, n, 'left');
      children = [...children, ...extra];
    } else {
      for (const c of children.slice(n)) for (const l of doorLeaves(c)) restructured.add(l.id);
      children = children.slice(0, n);
    }
    // Elle sayı girildiyse spacing hedefi kalkar; derz bağları kalan derzlerde (k < n−1) korunur.
    const refs = Object.fromEntries(Object.entries(node.refs ?? {}).filter(([k]) => +k < n - 1)) as Record<number, DoorJointRef>;
    const next: DoorNode = {
      ...node, children, gaps: gapsFor(n - 1, node.gaps), sizes: [],
      targetSize: opts.keepTargetSize ? node.targetSize : undefined, refs: Object.keys(refs).length ? refs : undefined,
    };
    rebuildWith(node.id, next, restructured);
    return node.id;
  }
  if (n <= 1) return node.id;
  const wrap: DoorNode = {
    id: genId('ds'), kind: 'split', axis, sizes: [], gaps: gapsFor(n - 1), children: [node, ...Array.from({ length: n - 1 }, () => cloneDoorNode(node))],
  };
  rebuildWith(node.id, wrap, new Set());
  return wrap.id;
}

/** Panel ref: levhanın merkezinden geçen her yaprak ikiye bölünür, derz levhaya 'center' bağlanır (levha taşınınca kapak izler).
 *  Levha kapağa değmeli ve grup sınırı olmamalı; raf/dikme üyesi değilse de bölünür ama rozetle taşınamaz (derz levhaya gider). */
export function splitDoorAtPanel(groupId: string, vfId: string): string[] {
  const group = groupById(groupId);
  if (!group) return [];
  const st = useAppStore.getState();
  const parent = shapeById(group.shapeId, st.shapes);
  if (!parent) return [];
  const np = doorNearPanels(group, parent, st.shapes, st.virtualFaces, st.panelGroups).find(p => p.vfId === vfId);
  if (!np || np.edge) return [];
  const axis = np.kind, g = group.gap;
  const hits = leavesSplittableAt(solveDoorTree(group), np, g, MIN_DOOR_SPAN);
  if (!hits.length) return [];
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

export const countForTargetSize = (L: number, size: number, g: number) =>
  Math.max(1, Math.min(MAX_DOOR_SPLIT, Math.round((L + g) / (Math.max(1, size) + g))));
const withTargetSize = (tree: DoorNode, id: string, targetSize: number | undefined) =>
  replaceDoorNode(tree, id, old => ({ ...(old as any), targetSize }));
/** Spacing: hedef parça ölçüsü split'e targetSize olarak yazılır, gövde boyutlanınca syncDoorGroups yeniden sayar; null → hedef kalkar. */
export function setDoorNodeSpacing(groupId: string, nodeId: string, axis: 'u' | 'v', size: number | null): string | null {
  const group = groupById(groupId);
  const node = group ? findDoorNode(group.tree, nodeId) : null;
  if (!group || !node) return null;
  const sn = findSolvedNode(solveDoorTree(group), nodeId);
  if (!sn) return null;
  if (size == null) {
    if (node.kind !== 'split' || !node.targetSize) return node.id;
    useAppStore.getState().updateDoorGroup(groupId, { tree: withTargetSize(group.tree, nodeId, undefined) });
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
  useAppStore.getState().updateDoorGroup(groupId, { tree: withTargetSize(g2.tree, id, round1(size)) });
  return id;
}

export function clearDoorSpacing(groupId: string, scopeIds: string[], axis: 'u' | 'v'): number {
  const group = groupById(groupId);
  if (!group) return 0;
  const ids = new Set(doorSpacingTargetsInScope(group.tree, scopeIds, axis).map(n => n.id));
  if (!ids.size) return 0;
  let tree = group.tree;
  for (const id of ids) tree = withTargetSize(tree, id, undefined);
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
    const leafSplit = (old: DoorNode) => (doorLeafAxis(type)
      ? (structural ? { leafSplit: { leaves: [], gap: (old as any).leafSplit?.gap ?? group.gap } } : {})
      : { leafSplit: undefined });
    tree = replaceDoorNode(tree, id, old => ({ ...old, type, ...leafSplit(old) } as DoorNode));
  }
  if (!changed) return;
  if (!restructured.size) {
    useAppStore.getState().updateDoorGroup(groupId, { tree });
    return;
  }
  rebuildMembers(group, { ...group, tree }, restructured);
}

export type DoorEditOpts = { preview?: boolean };
const spanOf = (n: { axis: 'u' | 'v'; u0: number; u1: number; v0: number; v1: number }) => (n.axis === 'u' ? n.u1 - n.u0 : n.v1 - n.v0);
/** Bölmenin ölçü / boşluk / bağ alanlarını yamalar. */
const patchSplit = (tree: DoorNode, splitId: string, patch: object) => replaceDoorNode(tree, splitId, old => ({ ...(old as any), ...patch }));
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

// Bitişik derz levhaya bağlıysa ölçü LEVHAYI taşıyarak girilir (önce k., yoksa k−1. derz); taşınamazsa bağlı derz yine levhadan gelir
// (ölçü girişi bağlı derzi değiştiremez; bağ Shift+tık ile çözülür). Pasif ölçü (kalanı toplar) girilemez.
export async function editDoorSize(groupId: string, splitId: string, k: number, value: number, opts: DoorEditOpts = {}): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value) || value <= 0) return;
  const sn = findSolvedNode(solveDoorTree(group), splitId);
  if (!sn || sn.kind !== 'split' || k < 0 || k >= sn.children.length) return;
  if (passiveGapIndex(sn.sizes, sn.children.length) === k) return;
  const refs = sn.refs ?? {};
  const j = refs[k] ? k : refs[k - 1] ? k - 1 : -1;
  // Önizlemede levha taşınmaz; onayda bağlı derz levhayı taşır.
  if (j >= 0 && !opts.preview) {
    const st = useAppStore.getState();
    const parent = shapeById(group.shapeId, st.shapes);
    const ref = refs[j], g = sn.gaps[j] ?? group.gap, c = sn.children[k];
    const center = sn.axis === 'u'
      ? (j === k ? c.u0 + value + g / 2 : c.u1 - value - g / 2)
      : (j === k ? c.v1 - value - g / 2 : c.v0 + value + g / 2);
    const nps = parent ? doorNearPanels(group, parent, st.shapes, st.virtualFaces, st.panelGroups) : [];
    const np = nps.find(p => p.vfId === ref.vfId);
    const joint: DoorJoint = { splitId, k: j, axis: sn.axis, p0: center - g / 2, p1: center + g / 2, c0: 0, c1: 0 };
    if (np && movePanelToAlign(group, { ...np, joint }, ref.align, st.panelGroups)) return;
  }
  // Oran tabanı düzenleme başındaki ölçüler (bkz. sizeEditBase); mod bayrakları güncelden.
  const bn = sizeEditBase?.groupId === groupId ? findDoorNode(sizeEditBase.tree, splitId) : null;
  const base = bn?.kind === 'split' && bn.sizes.length === sn.sizes.length ? bn.sizes : undefined;
  const sizes = applyGapEditProportional(sn.sizes, k, value, spanOf(sn), sn.gaps.length, sn.gaps, { base, min: MIN_DOOR_SIZE });
  await writeDoorGroup(group, { tree: patchSplit(group.tree, splitId, { sizes }) }, !!opts.preview);
}
/** Kilit rozeti: açık → pin → kilitli → açık; rebuild yok. Son açık ölçü (pasif) pinlenemez / kilitlenemez. */
export function toggleDoorSizeLock(groupId: string, splitId: string, k: number): void {
  const group = groupById(groupId);
  const sn = group ? findSolvedNode(solveDoorTree(group), splitId) : null;
  if (!group || !sn || sn.kind !== 'split' || k < 0 || k >= sn.sizes.length) return;
  const sizes = cycleGapMode(sn.sizes, k, sn.children.length);
  if (!sizes) return;
  useAppStore.getState().updateDoorGroup(groupId, { tree: patchSplit(group.tree, splitId, { sizes }) });
}
export async function setDoorSplitGap(groupId: string, splitId: string, k: number, value: number, opts: DoorEditOpts = {}): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value) || value < 0) return;
  const sn = findSolvedNode(solveDoorTree(group), splitId);
  if (!sn || sn.kind !== 'split' || k < 0 || k >= sn.gaps.length) return;
  if (opts.preview && Math.abs(sn.gaps[k] - value) < 0.05) return;   // onay hep yazar (bkz. setDoorLeafGap)
  const gaps = sn.gaps.slice(); gaps[k] = round1(value);
  await writeDoorGroup(group, { tree: patchSplit(group.tree, splitId, { gaps }) }, !!opts.preview);
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
  // İç kapakta bini yok: Half / None işaretleri silinir.
  const anyOn = (o?: Record<string, boolean | undefined>) => !!o && Object.values(o).some(Boolean);
  const clear = placement === 'inner' && (anyOn(group.halfOverlay) || anyOn(group.noOverlay));
  await writeDoorGroup(group, clear ? { placement, halfOverlay: {}, noOverlay: {} } : { placement });
}
export type EdgeOverlayMode = 'full' | 'half' | 'none';
export const edgeOverlayMode = (g: Pick<DoorGroup, 'halfOverlay' | 'noOverlay'>, edge: DoorEdgeKey): EdgeOverlayMode =>
  (g.noOverlay?.[edge] ? 'none' : g.halfOverlay?.[edge] ? 'half' : 'full');
/** Kenar binisi değişince o eksendeki KÖK bölme yeniden eşit bölünür. */
function resetRootSizesFor(tree: DoorNode, edge: DoorEdgeKey): DoorNode {
  const isU = edge === 'uMin' || edge === 'uMax';
  return tree.kind === 'split' && tree.axis === (isU ? 'u' : 'v') ? { ...tree, sizes: [] } : tree;
}
/** Kenar binisi: full = panel kalınlığını örter, half = ortasına, none = iç yüzünde biter. */
export async function setDoorEdgeOverlay(groupId: string, edge: DoorEdgeKey, mode: EdgeOverlayMode): Promise<void> {
  const group = groupById(groupId);
  if (!group || edgeOverlayMode(group, edge) === mode) return;
  const halfOverlay = { ...(group.halfOverlay ?? {}), [edge]: mode === 'half' };
  const noOverlay = { ...(group.noOverlay ?? {}), [edge]: mode === 'none' };
  await writeDoorGroup(group, { halfOverlay, noOverlay, tree: resetRootSizesFor(group.tree, edge) });
}
/** Panel ref ile bölünebilir mi: levhanın ortası bir kapağın içinden, iki yanda en az MIN_DOOR_SPAN kalarak geçmeli (splitDoorAtPanel kuralı). */
export function canSplitDoorAtPanel(group: DoorGroup, np: Pick<DoorNearPanel, 'kind' | 'a0' | 'a1' | 'c0' | 'c1' | 'edge'>): boolean {
  return !np.edge && leavesSplittableAt(solveDoorTree(group), np, group.gap, MIN_DOOR_SPAN).length > 0;
}
/** Yarım binme: kenar panel kalınlığının ortasına çekilir. */
export async function setDoorHalfOverlay(groupId: string, edge: DoorEdgeKey, on: boolean): Promise<void> {
  const group = groupById(groupId);
  if (!group || !!group.halfOverlay?.[edge] === on) return;
  const halfOverlay = { ...(group.halfOverlay ?? {}), [edge]: on };
  const noOverlay = on && group.noOverlay?.[edge] ? { ...group.noOverlay, [edge]: false } : group.noOverlay;
  await writeDoorGroup(group, { halfOverlay, noOverlay, tree: resetRootSizesFor(group.tree, edge) });
}
// Derz levhaya bağlanır ve LEVHA bir kez taşınır (kapak yerinde); taşınamazsa derz levhaya gider. null → bağ çözülür, kapaklar donar.
// Levha yakın değil / eksen uyuşmuyor / kenar levhası / başka bir kapak derzine bağlı → işlem yok.
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
    if (bond.doorGroupId !== groupId || bond.splitId !== splitId || bond.k !== k) return;
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
    st.updateDoorGroup(groupId, { tree: patchSplit(group.tree, splitId, { sizes, refs: Object.keys(refs).length ? refs : undefined }) });
    return;
  }
  const parent = shapeById(group.shapeId, st.shapes);
  if (!parent) return;
  const np = doorNearPanels(group, parent, st.shapes, st.virtualFaces, st.panelGroups).find(p => p.vfId === vfId);
  const joint = doorJoints(solveDoorTree(group)).find(j => j.splitId === splitId && j.k === k);
  if (!np || !joint || joint.axis !== np.kind || np.edge) return;
  const refs: Record<number, DoorJointRef> = { ...(node.refs ?? {}), [k]: { vfId, align } };
  const tree = patchSplit(group.tree, splitId, { refs });
  // Sıra önemli: önce bağ yazılır (rebuild içindeki çözüm bağı görsün), sonra levha taşınır.
  st.updateDoorGroup(groupId, { tree });
  const moved = movePanelToAlign(group, { ...np, joint }, align, st.panelGroups);
  if (!moved) await writeDoorGroup({ ...group, tree }, {});
}
/** Derzin levhaya göre durumu (geometriden): hizalardan biri değilse null (serbest). */
export function jointOverlayState(j: Pick<DoorJoint, 'p0' | 'p1'>, a0: number, a1: number, tol = 0.6): DoorAlign | null {
  const c = (j.p0 + j.p1) / 2, g = j.p1 - j.p0;
  return (['center', 'min', 'max'] as DoorAlign[]).find(a => Math.abs(jointCenter(a0, a1, g, a) - c) <= tol) ?? null;
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
// Levha yakın değil / eksen uyuşmuyor / kenar levhası ya da kapak bu biniye sığmıyorsa (en az MIN_DOOR_SPAN) işlem yok.
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
  if (!np || !joint || joint.axis !== np.kind || np.edge) return;
  const center = jointCenter(np.a0, np.a1, joint.p1 - joint.p0, align);
  // Yalnız iki komşu kapak değişir; bağlı derzde de kaydırılmış ölçüler yazılır (Σ alanı tutar → çözücü diğerlerine dokunmaz).
  const sizes = shiftJointSizes(sn, k, center);
  if (!sizes) return;
  const bondPg = st.panelGroups.find(pg => pg.doorBond && pg.memberVfIds.includes(vfId));
  if (bondPg) {
    // Levha başka bir derze bağlıysa bağ değişmez; derz yine bir kez kaydırılır (bağsız).
    const bond = bondPg.doorBond!;
    if (bond.doorGroupId === groupId && bond.splitId === splitId && bond.k === k) st.updatePanelGroup(bondPg.id, { doorBond: { ...bond, align } });
    await writeDoorGroup(group, { tree: patchSplit(group.tree, splitId, { sizes }) });
    return;
  }
  const refs: Record<number, DoorJointRef> = { ...(node.refs ?? {}), [k]: { vfId, align } };
  await writeDoorGroup(group, { tree: patchSplit(group.tree, splitId, { sizes, refs }) });
}
/** Derzi `center`a taşır (doorBond'lu grubun boşluk girişi). Derz panel-ref ile bağlıysa levha kazanır; derz bölmenin dışına
 *  çıkıyorsa ya da kilitli kapaklar izin vermiyorsa taşınmaz → false. */
export async function moveDoorJointTo(groupId: string, splitId: string, k: number, center: number): Promise<boolean> {
  const group = groupById(groupId);
  const sn = group ? findSolvedNode(solveDoorTree(group), splitId) : null;
  if (!group || !sn || sn.kind !== 'split' || k < 0 || k >= sn.children.length - 1 || !Number.isFinite(center)) return false;
  if (sn.refs?.[k]) return false;
  const g = sn.gaps[k] ?? group.gap, c = sn.children[k];
  const size = round1(sn.axis === 'u' ? (center - g / 2) - c.u0 : c.v1 - (center + g / 2));
  if (size < 1) return false;
  const sizes = applyGapEdit(sn.sizes, k, size, spanOf(sn), sn.gaps.length, sn.gaps);
  if (Math.abs((sizes[k]?.value ?? NaN) - size) > 0.05) return false;
  await writeDoorGroup(group, { tree: patchSplit(group.tree, splitId, { sizes }) });
  return true;
}

// Kapaklar arasına raf / dikme: derzden hacim ışını → 1 üyeli grup, doorBond ile 'center' bağlı. `at` = tıklanan derz parçası
// (derzin ortası bir dikmenin içine düşebilir → serbest hücre yok); yinelenme denetimi de PARÇA bazlı. Derz panel-ref ile
// levhaya bağlıysa, parçada zaten bağlı levha varsa ya da derzin arkasında serbest hacim yoksa null.
export function addPanelAtDoorJoint(groupId: string, splitId: string, k: number, at?: number): PanelGroup | null {
  const group = groupById(groupId);
  if (!group) return null;
  const st = useAppStore.getState();
  const parent = shapeById(group.shapeId, st.shapes);
  if (!parent) return null;
  const sol = solveDoorGroup(group, parent, st.shapes);
  const j = sol ? doorJoints(sol.solved).find(x => x.splitId === splitId && x.k === k) : undefined;
  if (!sol || !j) return null;
  const node = findDoorNode(group.tree, splitId);
  if (node?.kind === 'split' && node.refs?.[k]) return null;
  const { u, v } = doorPlaneAxes(group.axis);
  const axis: 0 | 1 | 2 = j.axis === 'u' ? u : v, cross: 0 | 1 | 2 = j.axis === 'u' ? v : u;
  const kind: PanelGroup['kind'] = axis === 1 ? 'shelf' : 'divider';
  const atC = typeof at === 'number' && Number.isFinite(at) ? Math.min(Math.max(at, j.c0), j.c1) : (j.c0 + j.c1) / 2;
  const dup = st.panelGroups.find(pg => {
    const b = pg.doorBond;
    return b && b.doorGroupId === groupId && b.splitId === splitId && b.k === k && pg.cavity.min[cross] - TOL <= atC && atC <= pg.cavity.max[cross] + TOL;
  });
  if (dup) return null;
  const body = bodyLocalBox(parent);
  if (!body) return null;
  const origin: Vec3 = [0, 0, 0], dir: Vec3 = [0, 0, 0];
  origin[axis] = (j.p0 + j.p1) / 2; origin[cross] = atC;
  const ga = group.axis;
  origin[ga] = group.side > 0 ? Math.max(sol.rect.front, body.max[ga]) + 50 : Math.min(sol.rect.front, body.min[ga]) - 50;
  dir[ga] = -group.side;
  const grid = gridForObstacles(parent, collectObstacles(parent, st.shapes));
  if (!grid) return null;
  const cands = rayCavityCandidates(origin, dir, grid, GROUP_PANEL_THICKNESS * 2, kind);
  const pick = cands.find(c => c.shape === 'shaped') ?? cands[0];
  if (!pick) return null;
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
  setMemberPanelThickness(group.memberVfIds, v);
  await writeDoorGroup(group, { thickness: v });
}
export function renameDoorGroup(groupId: string, name: string): void {
  const group = groupById(groupId);
  if (!group) return;
  useAppStore.getState().updateDoorGroup(groupId, { name });
  renameMemberVfs(group.memberVfIds, name);
}
export function deleteDoorGroupWithMembers(groupId: string): void {
  const group = groupById(groupId);
  if (!group) return;
  removeMemberVfs(group.memberVfIds);
  useAppStore.getState().deleteDoorGroup(groupId);
}

const sameDoorLeaf = (a: DoorLeaf, b: DoorLeaf): boolean => {
  const la = a.leafSplit, lb = b.leafSplit;
  if (!la && !lb) return true;
  return !!la && !!lb && Math.abs(la.gap - lb.gap) < 0.05 && la.leaves.length === lb.leaves.length
    && la.leaves.every((x, i) => Math.abs(x.value - lb.leaves[i].value) < 0.05);
};
const sameDoorRef = (x?: DoorJointRef, y?: DoorJointRef) => y?.vfId === x?.vfId && y?.align === x?.align;

/** Rebuild sonrası (PanelEngine): store'daki dikdörtgen/ağaç güncel çözümle eşitlenir (bağlı derzlerin izlediği levha dahil).
 *  Bağlı levhası silinmiş derz bağı düşer (ölçüler dondurulur). */
export function syncDoorGroups(parentShapeId: string): void {
  const st = useAppStore.getState();
  const parent = shapeById(parentShapeId, st.shapes);
  if (!parent) return;
  for (const g of st.doorGroups) {
    if (g.shapeId !== parentShapeId) continue;
    const sol = solveDoorGroup(g, parent, st.shapes);
    if (!sol) continue;
    if (g.panelAlign) st.updateDoorGroup(g.id, { panelAlign: undefined });   // eski kayıt
    const pruned = pruneRefs(g.tree, sol.solved, st.virtualFaces);
    const boundsChanged = !!sol.bounds && !sameBounds(sol.bounds, g.bounds);
    if (pruned) { st.updateDoorGroup(g.id, { rect: sol.rect, tree: pruned, ...(boundsChanged ? { bounds: sol.bounds } : {}) }); continue; }
    // Devralınan kenar (sonradan konan sınır levhası) kalıcı yazılır: şema ve sonraki çözümler aynı kenarı görsün.
    if (boundsChanged) { st.updateDoorGroup(g.id, { bounds: sol.bounds, rect: sol.rect, tree: sol.tree }); continue; }
    // Spacing: alan değiştiyse parça sayısı yeniden türetilir; sonraki rebuild aynı n'i bulup durur (döngü yok).
    try {
      const r = spacingResize(sol.solved, (L, size) => countForTargetSize(L, size, g.gap));
      // Üyeler yeniden kuruluyor; bu grubun senkronu bir sonraki rebuild'de.
      if (r) { setDoorNodeSplit(g.id, r.id, r.axis, r.n, { keepTargetSize: true }); continue; }
    } catch { /* spacing hatası senkronu durdurmaz */ }
    const sameRect = rectKey(sol.rect) === rectKey(g.rect) && Math.abs(sol.rect.front - g.rect.front) < 0.05;
    if (sameRect && sameTree(sol.tree, g.tree, sameDoorLeaf, sameDoorRef)) continue;
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
