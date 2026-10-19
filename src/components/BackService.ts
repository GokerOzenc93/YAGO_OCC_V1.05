import {
  type BackAlign, type BackBoundRef, type BackBounds, type BackEdgeGaps, type BackEdgeRel, type BackGroup, type BackJointRef, type BackNode,
  type BackPick, type BackPlacement, type BackRect, type CavityBox, type GapSpec, type PanelGroup, type Shape, type VirtualFace,
  panelOfVf, requestRebuild, shapeById, useAppStore,
} from '../store';
import * as THREE from 'three';
import { type Vec3, genId, round1 } from './Geometry';
import { clipHalfPlane, footprintGeometry, localBboxOf, panelFrontHull, panelHasRotation, polyArea } from './Geometry';
// DİKKAT: BackService ↔ PanelGroupService döngüsel içe aktarım (groupObstacles → backObstacleFor). Modül üst düzeyinde
// PanelGroupService bağlarını OKUMA; yalnız fonksiyon gövdesinde çağır.
import { type GapMode, applyGapEditProportional, bodyLocalBox, cycleGapMode, panelLocalBox, passiveGapIndex } from './PanelGroupService';
import { type BoundPanel, type EdgeInfo, type JointTargets, type PlaneRect, type Pt2, type SlabCut, type SplitJoint, EDGE_KEYS, boundEdgeInfo, cloneTree, collectBoundPanels, collectRotatedCuts, cutBands, cutCoverFar, cutEdgeOf, depthOptions, jointCenter, jointKey, leavesSplittableAt, polyChanged, polyRect, pruneRefs, rectKey, rectPoly, removeMemberVfs, renameMemberVfs, sameBounds, sameTree, setMemberPanelThickness, slabVfGeometry, solveTree, spacingResize, splitGapsOf, unsolveTree, findNode as findBackNode, findNode as findSolvedBackNode, jointRefs as backJointRefs, planeAxes as backPlaneAxes, replaceNode as replaceBackNode, treeJoints as backJoints, treeLeaves as backLeaves } from './PanelGroupService';

// ARKALIK (BackService) — kapaktan (DoorService) BAĞIMSIZ servis: kendi tipleri, store dilimi, çözücüsü ve VF yazımı
// (yalnız saf yardımcılar PanelGroupService'te ortak).
//  • Sınır = VF.backBound işaretli paneller; yoksa gövde kenarı. Düzlem = gövdenin ARKA yüzü (gövde-yerel ön = +Z → arka = Z−);
//    seçimde tıklama hangi yüzden gelirse gelsin arka yüze taşınır (rayBackEntry). u = X (sütun), v = Y (satır).
//  • Grup dikdörtgeni = İÇ dikdörtgen (sınır panellerinin iç yüzleri), front = sınır panellerinin ARKA yüzü (P). Ağaç bu alanı
//    KATSAYI kuralıyla böler; bölmek üst ölçüsünü değiştirmez.
//  • HER PARÇA kendi tipini taşır (yoksa grup varsayılanı): 'outer' = arkadan ÇAKMA (P'nin dışında, kenarda sınır panelini bini
//    kadar örter: full = kalınlık · half · none); 'inner' = KANALLI (P'den `setback` kadar içerde, kenarda panele `inset` kadar girer).
//  • KENAR İLİŞKİSİ (grup başına `edgeRel`): 'groove' (varsayılan) → panel TAM BOY, iç parça kanala `inset` kadar girer; 'nail' → o
//    kenarın paneli arkalığın ÖN yüzüne kadar OTOMATİK KISALTILIR, parça ucunu `cover` kadar örter (girilmemişse tamamen). Kısaltma:
//    dikme/raf → hacim engeli (backObstacleFor), gövde paneli → parça o paneli sırası ne olursa olsun BASAR (backNailStampFor).
//    Çakma kenar derinlik (P) vermez — yoksa panel kısaldıkça arkalık öne kaçardı. Gövdeyle kesilmez.
//  • SIRA: arkalıktan SONRA konan panel (arkalığın kenarı / derzi değilse) arkalığa kadar yerleşir — iç parça levhasıyla basar /
//    hacim engelidir. Önce konan paneller kenar / derz / geçme kurallarına uyar.
//  • Dönmüş sınır paneli kenar olmaz; arkalığı büyük-yüz düzlemiyle keser (arkalık düzlemi değişmez).
//  • Arkalık-sınırı raf/dikme: arkalığın GEÇTİĞİ (kenarı olmayan) kanallı levha KISALIR; KENARI olan levha kenar ilişkisine uyar
//    (groove → kısalmaz). Panel ref ile levhada BÖLÜNÜNCE derz levhayı izler (BackNode.refs, hep 'center'); derz ilişkisi
//    (BackJointRef.rel): groove → iki yandan kanal, levha tam boy; nail → levha arkalığın ön yüzüne kadar KISALIR (hacim engeli),
//    parçalar ucunu `jointIn` kadar örter. Full / Half / Left / Right binisi YOK.

export { backJointRefs, backJoints, backLeaves, backPlaneAxes, findBackNode, findSolvedBackNode, replaceBackNode, cutBands as backCutBands };
export { gapMode as backSizeMode, passiveGapIndex as passiveBackSizeIndex } from './PanelGroupService';

export const BACK_THICKNESS = 8;
export const BACK_GAP = 0;
export const BACK_INSET = 10;      // kanallı: sınır panelinin içine giriş (mm)
export const BACK_SETBACK = 10;    // kanallı: panellerin arka yüzünden arkalığın arka yüzüne (mm)
export const BACK_AXIS = 2 as const;
export const BACK_SIDE = -1 as const;
export const BACK_TYPE_LABEL: Record<BackPlacement, string> = { outer: 'Nailed', inner: 'Grooved' };
export const BACK_TYPE_TITLE: Record<BackPlacement, string> = {
  outer: 'Nailed-on back — sits behind the reference panels, outside the body; covers their thickness by the overlap set per edge',
  inner: 'Grooved back — sits between the reference panels, set back from their rear face. Each edge is Groove (panel keeps its depth, '
    + 'the piece enters it by the groove depth) or Nail (the panel is shortened to the back panel\'s front face and the piece covers its end)',
};
export const BACK_REL_LABEL: Record<BackEdgeRel, string> = { groove: 'Groove', nail: 'Nail' };
/** Kanal bollaştırma varsayılanı (mm): parçanın önüne / arkasına ve kanal dibine (girişin ötesine). */
export const BACK_GROOVE_CLEAR = { front: 0.5, back: 0.5, depth: 1 } as const;
export type BackGrooveClear = { front: number; back: number; depth: number };
/** Etkin bollaştırma: vfId verilirse o kenarın (sınır / derz paneli) kendi değerleri, girilmeyen alanlar grup değeri. */
export const backGrooveClearOf = (g: Pick<BackGroup, 'grooveClear' | 'grooveClearBy'>, vfId?: string): BackGrooveClear => {
  const v = (x: number | undefined, d: number) => (Number.isFinite(x) && (x as number) >= 0 ? (x as number) : d);
  const gc = g.grooveClear, d = BACK_GROOVE_CLEAR;
  const base = { front: v(gc?.front, d.front), back: v(gc?.back, d.back), depth: v(gc?.depth, d.depth) };
  const o = vfId ? g.grooveClearBy?.[vfId] : undefined;
  return o ? { front: v(o.front, base.front), back: v(o.back, base.back), depth: v(o.depth, base.depth) } : base;
};
/** Kenarın kendi bollaştırma değeri var mı (grup değerinden ayrılmış). */
export const backGrooveClearOverridden = (g: Pick<BackGroup, 'grooveClearBy'>, vfId: string): boolean => {
  const o = g.grooveClearBy?.[vfId];
  return !!o && (['front', 'back', 'depth'] as const).some(k => Number.isFinite(o[k]));
};
/** Kenar ilişkisi (grup başına); yoksa kanallı. */
export const edgeRelOf = (g: Pick<BackGroup, 'edgeRel'>, k: keyof BackBounds): BackEdgeRel => g.edgeRel?.[k] ?? 'groove';
const TOL = 0.5;
const MIN_BACK_SPAN = 40;
const MIN_BACK_SIZE = 1;
const PREVIEW_ID = 'önizleme';
const MAX_BACK_SPLIT = 12;
const NEAR_EXTRA = 3;        // arkalık kenarı ile levha arasındaki "yaklaşma" payı (mm), boşluğun üstüne
const THIN_PANEL = 60;       // levha sayılacak en büyük kalınlık (mm)
const EDGE_ADOPT_TOL = 1;    // gövde kenarı ile levhanın dış yüzü arası en büyük fark (mm)
const GROOVE_MOUTH = 5;      // kanal kesicisi panelin iç yüzünden dışa taşar: çakışık yüz olmasın (mm)
export const BACK_JOINT_NEAR = 30;   // levha merkezi ile derz merkezi arası en büyük uzaklık (mm; + yarım kalınlık + yarım derz)

export const isBackPanel = (p: any): boolean => !!p?.parameters?.backGroupId;
export const isBackVf = (vf: any): boolean => !!vf?.backGroupId;
export const backGroupName = (g: Pick<BackGroup, 'name'>) => g.name ?? 'Back';
/** Arkalık sınırı bayrağı; eski `splitBack` bayrağı sınır sayılır. */
export const vfBackBound = (vf: Pick<VirtualFace, 'backBound' | 'splitBack'> | undefined | null): boolean => !!(vf?.backBound ?? vf?.splitBack);
export type BackEdgeKey = keyof BackBounds;

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

export type BackBoundPanel = BoundPanel;
/** Arkalık sınırı panelleri (gövde-yerel kutu); arkalıklar ve dönmüş paneller hariç. onlyBound=false: işaretsizler de. */
export function collectBackBoundPanels(
  parent: Shape, shapes: Shape[] = useAppStore.getState().shapes, vfs: VirtualFace[] = useAppStore.getState().virtualFaces, onlyBound = true,
): BackBoundPanel[] {
  return collectBoundPanels(parent, shapes, vfs, vf => (!onlyBound || vfBackBound(vf)) && !isBackVf(vf));
}

/** Dönmüş sınır paneli: büyük-yüz normali + o normaldeki [dMin,dMax] + kutu; pts = tekil köşeler (şema ön görünüşü). */
export type BackCut = SlabCut;
export function collectBackCuts(
  parent: Shape, shapes: Shape[] = useAppStore.getState().shapes, vfs: VirtualFace[] = useAppStore.getState().virtualFaces,
): BackCut[] {
  return collectRotatedCuts(parent, shapes, vfs, vf => vfBackBound(vf) && !isBackVf(vf));
}

// Üyeyi dönmüş panellerin büyük-yüz düzlemleriyle kırpar; kesim arkalığın İKİ yüzeyinde alınır, kısıtlayıcı olan tutulur
// (arkalık eğik panele girmez). Kenar boşluğu = kesicinin kestiği kenarın boşluğu.
function clipMemberByCuts(
  m: PlaneRect, cuts: BackCut[], axis: 0 | 1 | 2, side: 1 | -1, placement: BackPlacement, thickness: number, front: number,
  gapIn: number | BackEdgeGaps, cover?: Partial<BackEdgeGaps>, ref?: [number, number],
): Pt2[] | null {
  if (!cuts.length) return null;
  const { u, v } = backPlaneAxes(axis);
  let poly = rectPoly(m);
  const planes = placement === 'outer' ? [front, front + side * thickness] : [front - side * thickness, front];
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
    // Çakma binme (mm, levha normali boyunca): girilmemişse levhanın tamamı.
    const cm = cover?.[ce.edge], t = c.dMax - c.dMin;
    const cov = coverFar ? (Number.isFinite(cm) ? Math.max(0, Math.min(t, cm as number)) : t) : 0;
    const before = poly;
    if (ce.keepBelow) {
      const lim = c.dMin + cov - gap;
      poly = clipHalfPlane(poly, A, B, Math.min(...planes.map(pa => lim - Na * pa)));
    } else {
      const lim = c.dMax - cov + gap;
      poly = clipHalfPlane(poly, -A, -B, -Math.max(...planes.map(pa => lim - Na * pa)));
    }
    // Kesim üyeyi yok ediyorsa atlanır.
    if (poly.length < 3 || polyArea(poly) < MIN_BACK_SPAN * MIN_BACK_SPAN) { poly = before; continue; }
    if (polyChanged(poly, before)) any = true;
  }
  return any ? poly : null;
}

/** Arkalık sınırı; eski splitBack bayrağı birlikte temizlenir (tek kaynak backBound). */
export function setVfBackBound(vfId: string, on: boolean): void {
  const st = useAppStore.getState();
  const vf = st.virtualFaces.find(f => f.id === vfId);
  if (!vf || vfBackBound(vf) === on) return;
  st.updateVirtualFace(vfId, { backBound: on, ...(vf.splitBack !== undefined ? { splitBack: undefined } : {}) } as Partial<VirtualFace>);
  if (on) { adoptBoundsAfterMark(vf.shapeId); splitBacksAtMarked(vf); }
  else unbindBacksFrom(vf);
}
/** Sınır kaldırılınca levhaya bağlı derzler çözülür (ölçüler dondurulur): levha artık sıra kuralına döner (arkalıktan sonraysa arkalıkta biter). */
function unbindBacksFrom(vf: VirtualFace): void {
  const st = useAppStore.getState();
  const others = st.virtualFaces.filter(f => f.id !== vf.id);
  for (const g of st.backGroups) {
    if (g.shapeId !== vf.shapeId) continue;
    const tree = pruneRefs(g.tree, solveBackTree(g), others);
    if (tree) void writeBackGroup(g, { tree });
  }
}
/** Sonradan sınır yapılan raf/dikme (Goker: "arkalık kısalmıyor"): kenar olmadıysa, levhanın geçtiği her arkalık o levhada bölünür
 *  (derz levhaya bağlı, kanallı) → parçalar levhada biter, levha arkaya kadar tam boy. */
function splitBacksAtMarked(vf: VirtualFace): void {
  const st = useAppStore.getState();
  const parent = shapeById(vf.shapeId, st.shapes);
  if (!parent) return;
  for (const g of st.backGroups) {
    if (g.shapeId !== vf.shapeId) continue;
    const np = backNearPanels(g, parent, st.shapes, st.virtualFaces, st.panelGroups).find(p => p.vfId === vf.id);
    if (!np || np.edge || np.ref || !canSplitBackAtPanel(g, np)) continue;
    splitBackAtPanel(g.id, vf.id);
  }
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

type SideOpt = EdgeInfo & { cross: [number, number]; name: string };
type BackEdges = { l: EdgeInfo; r: EdgeInfo; b: EdgeInfo; t: EdgeInfo };

// KENAR KURALI: P = derinlik referansının arka yüzü. Çakma parça P'nin dışında [P, P+side·t]: sınır paneli arkalığın gerisindeyse
// (arka yüzü P'de ya da daha geride) kalınlığını bini kadar örter; kanallı parça P−side·setback'ten içerde, panele inset kadar girer.
const edgeCovered = (x: EdgeInfo, side: 1 | -1, P: number) => x.front != null && (side > 0 ? x.front <= P + TOL : x.front >= P - TOL);
/** Aday önizlemesi: tüm kenarlar iç yüzde (inner) ya da örtülen kenarlar dış yüzde (outer). */
function rectAtDepth(e: BackEdges, side: 1 | -1, placement: BackPlacement, P: number): BackRect {
  const pick = (x: EdgeInfo) => (placement === 'outer' && edgeCovered(x, side, P) ? x.outer : x.inner);
  return { u0: pick(e.l), u1: pick(e.r), v0: pick(e.b), v1: pick(e.t), front: P };
}
/** Kenar bilgisi (çözümden): sınır panelinin kalınlığı (gövde kenarı 0), çakma parçanın onu örtebilmesi (gerisinde mi),
 *  kenar ilişkisi ve `nail` = ilişki çakma + sınır paneli var + kenara değen İÇ parça var (panel kısaltılır, derinlik vermez). */
export type BackEdgeExt = Record<BackEdgeKey, { t: number; covered: boolean; rel: BackEdgeRel; nail: boolean }>;
const edgeExtOf = (e: BackEdges, side: 1 | -1, P: number, g: Pick<BackGroup, 'edgeRel'>, nailActive: Set<BackEdgeKey>): BackEdgeExt => {
  const one = (x: EdgeInfo, k: BackEdgeKey) => ({
    t: x.front == null ? 0 : Math.abs(x.outer - x.inner), covered: edgeCovered(x, side, P), rel: edgeRelOf(g, k), nail: nailActive.has(k),
  });
  return { uMin: one(e.l, 'uMin'), uMax: one(e.r, 'uMax'), vMin: one(e.b, 'vMin'), vMax: one(e.t, 'vMax') };
};
const noExt = (): BackEdgeExt => {
  const z = () => ({ t: 0, covered: false, rel: 'groove' as BackEdgeRel, nail: false });
  return { uMin: z(), uMax: z(), vMin: z(), vMax: z() };
};
/** Hücre iç dikdörtgenin o kenarına değiyor mu. */
export const cellTouchesEdge = (c: PlaneRect, rect: BackRect, k: BackEdgeKey, tol = 0.05) => {
  const d = k === 'uMin' ? c.u0 - rect.u0 : k === 'uMax' ? c.u1 - rect.u1 : k === 'vMin' ? c.v0 - rect.v0 : c.v1 - rect.v1;
  return Math.abs(d) < tol;
};
/** ÇAKMA KENARLAR (etkin): ilişki 'nail', kenarda sınır paneli var ve kenara değen en az bir İÇ (kanallı) parça var. */
function activeNailEdges(
  g: Pick<BackGroup, 'edgeRel' | 'tree' | 'placement' | 'setback' | 'inset' | 'bounds' | 'gap'>, edges: BackEdges, rect: BackRect,
): Set<BackEdgeKey> {
  const out = new Set<BackEdgeKey>();
  const info: Record<BackEdgeKey, EdgeInfo> = { uMin: edges.l, uMax: edges.r, vMin: edges.b, vMax: edges.t };
  const cells = backCells(solveBackTree({ rect, tree: g.tree, gap: g.gap }, rect));
  const innerAt = (c: BackCell) => backPieceOf(g, backLeafById(g.tree, c.leafId)).placement === 'inner';
  for (const k of EDGE_KEYS) {
    if (edgeRelOf(g, k) !== 'nail' || info[k].front == null) continue;
    if (cells.some(c => cellTouchesEdge(c, rect, k) && innerAt(c))) out.add(k);
  }
  return out;
}
const backLeafById = (tree: BackNode, id: string): BackLeaf | null => { const n = findBackNode(tree, id); return n && n.kind === 'leaf' ? n : null; };

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
  // Gövde kenarı da seçenektir, o yanda gövde kenarına dayanan sınır paneli yoksa.
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
  // Açılı sınır panelleri: aday alanı tıklanan noktanın tarafına kırpılır.
  const cuts = collectBackCuts(parent, shapes, vfs);
  const at: [number, number] = [cu, cv];
  const shrink = (placement: BackPlacement, r: BackRect) =>
    backRectByCuts({ axis, side, placement, thickness: BACK_THICKNESS, gap: BACK_GAP }, r, cuts, at);
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

export const backSetbackOf = (g: Pick<BackGroup, 'setback'>) =>
  (Number.isFinite(g.setback) && (g.setback as number) >= 0 ? (g.setback as number) : BACK_SETBACK);
/** Seçme önizlemesi: adayın dikdörtgeni yeni grubun çözüleceği yere taşınır — kanallıda panel kenarları inset kadar genişler,
 *  düzlem setback kadar içerde. */
export function backPickRect(pick: BackPick, placement: BackPlacement): BackRect {
  const r = placement === 'inner' ? { ...pick.inner } : { ...pick.outer };
  if (placement !== 'inner') return r;
  const e = (k: BackEdgeKey) => (pick.bounds[k]?.vfId ? BACK_INSET : 0);
  return { u0: r.u0 - e('uMin'), u1: r.u1 + e('uMax'), v0: r.v0 - e('vMin'), v1: r.v1 + e('vMax'), front: r.front - pick.side * BACK_SETBACK };
}

/** PARÇA (yaprak) etkin değerleri: yaprak değeri, yoksa grup varsayılanı. inset yalnız panel kenarında (gövde kenarı 0). */
export interface BackPiece {
  placement: BackPlacement; setback: number; inset: BackEdgeGaps;
  /** Çakma: sınır paneline binme — yalnız GİRİLMİŞ değerler (mm); girilmeyen kenar paneli tamamen örter. */
  cover: Partial<BackEdgeGaps>;
  /** İç levhaya (dikme/raf) binme — yalnız GİRİLMİŞ değerler; girilmeyen kenar levhanın ortasına kadar (bkz. backJointSides). */
  jointIn: Partial<BackEdgeGaps>;
}
export type BackLeaf = Extract<BackNode, { kind: 'leaf' }>;
export function backPieceOf(g: Pick<BackGroup, 'placement' | 'setback' | 'inset' | 'bounds'>, leaf: BackLeaf | null | undefined): BackPiece {
  const placement = leaf?.placement ?? g.placement;
  const setback = Number.isFinite(leaf?.setback) && (leaf!.setback as number) >= 0 ? (leaf!.setback as number) : backSetbackOf(g);
  const gi = Number.isFinite(g.inset) && g.inset >= 0 ? g.inset : BACK_INSET;
  const own = (k: BackEdgeKey) => (Number.isFinite(leaf?.inset?.[k]) ? Math.max(0, leaf!.inset![k] as number) : gi);
  const ins = (k: BackEdgeKey) => (g.bounds[k]?.vfId ? own(k) : 0);
  return {
    placement, setback,
    inset: { uMin: ins('uMin'), uMax: ins('uMax'), vMin: ins('vMin'), vMax: ins('vMax') },
    cover: { ...(leaf?.cover ?? {}) },
    jointIn: { ...(leaf?.jointIn ?? {}) },
  };
}
/** i. üyenin yaprağı (üye sırası = DFS yaprak sırası). */
export const backLeafOfMember = (g: Pick<BackGroup, 'tree'>, i: number): BackLeaf | undefined => backLeaves(g.tree)[i];
/** Parçanın ÖN (hacme bakan) düzlemi ve VF düzlemi (createPanelFromVirtualFace −normal yönünde t uzar → VF = DIŞ yüz). */
const pieceFront = (P: number, side: 1 | -1, placement: BackPlacement, setback: number) => (placement === 'inner' ? P - side * setback : P);
const piecePlane = (front: number, side: 1 | -1, placement: BackPlacement, thickness: number) => (placement === 'outer' ? front + side * thickness : front);

/** Üye = yaprak hücresi + kenar uzantıları; front/plane parçanın kendi tipinden. */
export interface BackMemberRect {
  u0: number; u1: number; v0: number; v1: number; leafId: string; piece: BackPiece; front: number; plane: number; poly?: Pt2[];
}
export type BackNodeSolved =
  | (BackLeaf & { u0: number; u1: number; v0: number; v1: number; depth: number })
  | {
    id: string; kind: 'split'; axis: 'u' | 'v'; sizes: GapSpec[]; gaps: number[]; children: BackNodeSolved[];
    targetSize?: number; refs?: Record<number, BackJointRef>; u0: number; u1: number; v0: number; v1: number; depth: number;
  };
export interface BackSolution {
  rect: BackRect; tree: BackNode; solved: BackNodeSolved; members: BackMemberRect[]; bounds?: BackBounds; ext: BackEdgeExt; sides: BackJointSides;
}
/** `${splitId}:${k}` → bağlı derzin merkezi (bölmenin ekseninde). */
export type BackJointTargets = JointTargets;
export type BackLayout = Pick<BackGroup, 'rect' | 'tree' | 'gap'>;

export const makeBackLeaf = (): BackNode => ({ id: genId('bl'), kind: 'leaf' });
export const backMemberCount = (g: Pick<BackGroup, 'tree'>) => backLeaves(g.tree).length;
/** Alt ağacın yeni kimlikli kopyası; derz bağları da kopyalanır. */
export const cloneBackNode = (n: BackNode): BackNode => cloneTree(n, 'bs', l => ({ ...l, id: genId('bl') }));

export type BackSizeMode = GapMode;

/** Ağaç çözümü: split alanını çocuklarına dağıtır (u: soldan sağa, v: ÜSTTEN aşağı); toplam her zaman üst alan. */
export function solveBackTree(g: BackLayout, rect: BackRect = g.rect, targets?: BackJointTargets): BackNodeSolved {
  return solveTree(g.tree, rect, g.gap, targets, (l, at): BackNodeSolved => ({ ...l, ...at }));
}
export function solvedToBackTree(n: BackNodeSolved): BackNode {
  // Yaprak parça değerleri (tip / setback / inset / bini) çözümden geri yazılırken KORUNUR.
  return unsolveTree(n, (l): BackNode => {
    const { u0: _u0, u1: _u1, v0: _v0, v1: _v1, depth: _d, ...leaf } = l;
    return leaf;
  });
}
/** Bağlı derzin levhası: bölme ekseninde levhanın iki yüzü (a0 < a1, iç dikdörtgen koordinatı) + adı. */
export interface BackJointFace { a0: number; a1: number; vfId: string; align: BackAlign; rel: BackEdgeRel }
export function backJointFaces(group: Pick<BackGroup, 'tree' | 'axis'>, parent: Shape, shapes: Shape[]): Map<string, BackJointFace> {
  const out = new Map<string, BackJointFace>();
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
    out.set(jointKey(splitId, k), { a0, a1, vfId: ref.vfId, align: ref.align, rel: ref.rel ?? 'groove' });
  }
  return out;
}
// Bağlı derz merkezi levhanın GÜNCEL kutusundan: 'center' → levha ortası, 'min' → max yüz + yarım derz, 'max' → min yüz − yarım derz.
export function backJointTargets(
  group: BackLayout & Pick<BackGroup, 'axis'>, parent: Shape, shapes: Shape[], faces = backJointFaces(group, parent, shapes),
): BackJointTargets {
  const out: BackJointTargets = new Map();
  for (const [key, f] of faces) {
    const [splitId, ks] = [key.slice(0, key.lastIndexOf(':')), key.slice(key.lastIndexOf(':') + 1)];
    const node = findBackNode(group.tree, splitId);
    if (!node || node.kind !== 'split') continue;
    const g = splitGapsOf(node, group.gap)[+ks] ?? group.gap;
    out.set(key, jointCenter(f.a0, f.a1, g, f.align));
  }
  return out;
}
/** Parçanın bağlı derzdeki kenarı: levhanın yüzleri, kalınlığı ve etkin binme (girilmemişse kalınlık/2 = levhanın ortası). */
export interface BackJointSide { splitId: string; k: number; vfId: string; a0: number; a1: number; t: number; in: number; entered: boolean; rel: BackEdgeRel }
export type BackJointSides = Record<string, Partial<Record<BackEdgeKey, BackJointSide>>>;
/** Yaprak → bağlı derze değen kenarları. u bölmesinde k. çocuğun uMax'ı / (k+1). çocuğun uMin'i; v bölmesi ÜSTTEN dizilir:
 *  k. çocuğun vMin'i / (k+1). çocuğun vMax'ı. Dış kenar bilgisi alt düğümlere aktarılır (çocuğun o kenarı da derze değer). */
export function backJointSides(solved: BackNodeSolved, faces: Map<string, BackJointFace>, tree: BackNode): BackJointSides {
  const out: BackJointSides = {};
  if (!faces.size) return out;
  type Raw = Omit<BackJointSide, 'in' | 'entered'>;
  const walk = (n: BackNodeSolved, inh: Partial<Record<BackEdgeKey, Raw>>) => {
    if (n.kind === 'leaf') {
      const leaf = findBackNode(tree, n.id);
      const ji = leaf && leaf.kind === 'leaf' ? leaf.jointIn : undefined;
      const rec: Partial<Record<BackEdgeKey, BackJointSide>> = {};
      for (const [key, r] of Object.entries(inh) as Array<[BackEdgeKey, Raw]>) {
        const v = ji?.[key];
        const entered = Number.isFinite(v);
        rec[key] = { ...r, in: entered ? Math.max(0, Math.min(r.t, v as number)) : r.t / 2, entered };
      }
      if (Object.keys(rec).length) out[n.id] = rec;
      return;
    }
    const lo: BackEdgeKey = n.axis === 'u' ? 'uMax' : 'vMin', hi: BackEdgeKey = n.axis === 'u' ? 'uMin' : 'vMax';
    const raw = (f: BackJointFace, k: number): Raw => ({ splitId: n.id, k, vfId: f.vfId, a0: f.a0, a1: f.a1, t: f.a1 - f.a0, rel: f.rel });
    n.children.forEach((c, i) => {
      const own: Partial<Record<BackEdgeKey, Raw>> = { ...inh };
      // Bölme ekseni boyunca dış kenarlar yalnız uçtaki çocuğa geçer.
      if (i > 0) delete own[hi];
      if (i < n.children.length - 1) delete own[lo];
      const before = i > 0 ? faces.get(jointKey(n.id, i - 1)) : undefined;
      const after = i < n.children.length - 1 ? faces.get(jointKey(n.id, i)) : undefined;
      if (before) own[hi] = raw(before, i - 1);
      if (after) own[lo] = raw(after, i);
      walk(c, own);
    });
  };
  walk(solved, {});
  return out;
}
/** Yaprak HÜCRELERİ (DFS yaprak sırası = VF.backIndex), iç dikdörtgen çerçevesinde. */
export interface BackCell { u0: number; u1: number; v0: number; v1: number; leafId: string }
export function backCells(solved: BackNodeSolved): BackCell[] {
  const out: BackCell[] = [];
  const walk = (n: BackNodeSolved) => {
    if (n.kind === 'split') { n.children.forEach(walk); return; }
    out.push({ leafId: n.id, u0: n.u0, u1: n.u1, v0: n.v0, v1: n.v1 });
  };
  walk(solved);
  return out;
}
/** Hücre → parça: grup dikdörtgeninin kenarına değen kenar parçanın tipine göre uzar — kanallı + groove kenar: panele `inset` kadar
 *  girer; kanallı + NAIL kenar: panel kısaltıldığından ucunun üzerine `cover` kadar biner (girilmemişse tamamen); çakma (dış):
 *  örtülen panelin üzerine `cover` mm biner (girilmemişse kalınlığın tamamı). Sayı bölmesi derzinde uzama yok.
 *  LEVHAYA BAĞLI derzde kenar levhanın yüzünden ölçülür: parça levhanın üzerine kendi `jointIn` değeri kadar biner (iki tip için aynı). */
export function placeBackPieces(
  g: Pick<BackGroup, 'placement' | 'setback' | 'inset' | 'bounds' | 'tree' | 'side' | 'thickness'>, cells: BackCell[], rect: BackRect,
  ext: BackEdgeExt, sides: BackJointSides = {},
): BackMemberRect[] {
  const T0 = 0.05;
  return cells.map(c => {
    const leaf = findBackNode(g.tree, c.leafId);
    const piece = backPieceOf(g, leaf?.kind === 'leaf' ? leaf : null);
    const coverOf = (k: BackEdgeKey, t: number) => { const cv = piece.cover[k]; return Number.isFinite(cv) ? Math.max(0, Math.min(t, cv as number)) : t; };
    const extend = (k: BackEdgeKey) => {
      const e = ext[k];
      if (piece.placement === 'inner') return e.nail && e.t > 0 ? coverOf(k, e.t) : piece.inset[k];
      if (!e.covered || e.t <= 0) return 0;
      return coverOf(k, e.t);
    };
    let u0 = Math.abs(c.u0 - rect.u0) < T0 ? c.u0 - extend('uMin') : c.u0;
    let u1 = Math.abs(c.u1 - rect.u1) < T0 ? c.u1 + extend('uMax') : c.u1;
    let v0 = Math.abs(c.v0 - rect.v0) < T0 ? c.v0 - extend('vMin') : c.v0;
    let v1 = Math.abs(c.v1 - rect.v1) < T0 ? c.v1 + extend('vMax') : c.v1;
    // Bağlı derz kenarı: min kenar = levhanın üst yüzü − binme, max kenar = levhanın alt yüzü + binme.
    const js = sides[c.leafId];
    if (js?.uMin) u0 = js.uMin.a1 - js.uMin.in;
    if (js?.uMax) u1 = js.uMax.a0 + js.uMax.in;
    if (js?.vMin) v0 = js.vMin.a1 - js.vMin.in;
    if (js?.vMax) v1 = js.vMax.a0 + js.vMax.in;
    const front = pieceFront(rect.front, g.side, piece.placement, piece.setback);
    return { leafId: c.leafId, u0, u1, v0, v1, piece, front, plane: piecePlane(front, g.side, piece.placement, g.thickness) };
  });
}

// SONRADAN KONAN SINIR LEVHASI: arkalık gövde kenarına bağlıyken o kenara sonradan konup sınır işaretlenen levha (yan/üst/alt panel)
// arkalık kenarı olur → bini / kanal girişi o levhaya göre çalışır. Panel kenarları korunur; yalnız gövde kenarları devralınır.
export function resolveBackBounds(
  group: BackGroup, parent: Shape, shapes: Shape[] = useAppStore.getState().shapes, vfs: VirtualFace[] = useAppStore.getState().virtualFaces,
): BackBounds {
  if (EDGE_KEYS.every(k => group.bounds[k]?.vfId)) return group.bounds;
  const body = bodyLocalBox(parent);
  if (!body) return group.bounds;
  const bps = collectBackBoundPanels(parent, shapes, vfs, true);
  if (!bps.length) return group.bounds;
  const { u, v } = backPlaneAxes(group.axis);
  let out = group.bounds;
  for (const k of EDGE_KEYS) {
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

function solveBackEdges(group: BackGroup, parent: Shape, shapes: Shape[]): { edges: BackEdges; P: number; bounds: BackBounds; nail: Set<BackEdgeKey> } | null {
  const body = bodyLocalBox(parent);
  if (!body) return null;
  const { u, v } = backPlaneAxes(group.axis);
  const bounds = resolveBackBounds(group, parent, shapes);
  const ei = (ref: BackBoundRef, ax: 0 | 1 | 2, minSide: boolean) => boundEdgeInfo(ref, parent, shapes, body, ax, minSide, group.axis, group.side);
  const edges: BackEdges = { l: ei(bounds.uMin, u, true), r: ei(bounds.uMax, u, false), b: ei(bounds.vMin, v, true), t: ei(bounds.vMax, v, false) };
  const bodyFront = group.side > 0 ? body.max[group.axis] : body.min[group.axis];
  // ÇAKMA (kısaltılan) kenarlar derinlik VERMEZ: paneli biz arkalığın ön yüzüne kadar kısaltıyoruz; arka yüzü okunsa arkalık her
  // rebuild'de öne kaçar (geri besleme). İç dikdörtgen derinlikten bağımsızdır → kenarlar önce, derinlik sonra.
  const nail = activeNailEdges({ ...group, bounds }, edges, rectAtDepth(edges, group.side, 'inner', bodyFront));
  const keyed: Array<[BackEdgeKey, EdgeInfo]> = [['uMin', edges.l], ['uMax', edges.r], ['vMin', edges.b], ['vMax', edges.t]];
  const depthEdges = keyed.filter(([k]) => !nail.has(k)).map(([, x]) => x);
  // Derinlik: kayıtlı referans panelin arka yüzü (panel taşınınca izler); yoksa (ya da bulunamazsa) en gerideki sınır panelinin yüzü.
  const fronts = depthEdges.map(x => x.front).filter((x): x is number => x != null);
  let P = !fronts.length ? bodyFront : (group.side > 0 ? Math.min(...fronts) : Math.max(...fronts));
  if (group.depthRef?.body) P = bodyFront;
  else if (group.depthRef?.vfId) {
    const hit = depthEdges.find(x => x.ref.vfId === group.depthRef!.vfId && x.front != null);
    if (hit) P = hit.front!;
  }
  return { edges, P, bounds, nail };
}

export function solveBackGroup(group: BackGroup, parent: Shape, shapes: Shape[]): BackSolution | null {
  const s = solveBackEdges(group, parent, shapes);
  if (!s) return null;
  const { edges, P, bounds, nail } = s;
  const cutsAll = collectBackCuts(parent, shapes, undefined);
  // Grup dikdörtgeni = İÇ dikdörtgen; parça uzantıları (giriş / bini) hücre yerleşiminde eklenir. Bozuk / çok küçükse önceki korunur.
  let rect: BackRect = backRectByCuts(group, rectAtDepth(edges, group.side, 'inner', P), cutsAll, group.anchor);
  if (rect.u1 - rect.u0 < MIN_BACK_SPAN || rect.v1 - rect.v0 < MIN_BACK_SPAN) rect = { ...group.rect };
  const ext = edgeExtOf(edges, group.side, P, group, nail);
  const faces = backJointFaces(group, parent, shapes);
  const solved = solveBackTree(group, rect, backJointTargets(group, parent, shapes, faces));
  const sides = backJointSides(solved, faces, group.tree);
  const members = applyBackCuts(group, placeBackPieces(group, backCells(solved), rect, ext, sides), cutsAll);
  return { rect, tree: solvedToBackTree(solved), solved, members, bounds, ext, sides };
}

// ÇÖZÜM ÖNBELLEĞİ (rebuild içi): aynı store anlık görüntüsü (shapes / VF / gruplar) için grup çözümü bir kez; motor her gövde
// paneli ve her raf/dikme grubu için arkalık baskısını sorar.
let _solMemo: { shapes: Shape[]; vfs: VirtualFace[]; groups: BackGroup[]; sols: Map<string, BackSolution | null> } | null = null;
function backSolutionMemo(group: BackGroup): BackSolution | null {
  const st = useAppStore.getState();
  if (!_solMemo || _solMemo.shapes !== st.shapes || _solMemo.vfs !== st.virtualFaces || _solMemo.groups !== st.backGroups) {
    _solMemo = { shapes: st.shapes, vfs: st.virtualFaces, groups: st.backGroups, sols: new Map() };
  }
  let s = _solMemo.sols.get(group.id);
  if (s === undefined) {
    const parent = shapeById(group.shapeId, st.shapes);
    s = parent ? solveBackGroup(group, parent, st.shapes) : null;
    _solMemo.sols.set(group.id, s);
  }
  return s;
}

/** Arkalık panelinin grubu + çözümdeki üyesi (parça). */
function backMemberOfPanel(backPanel: Shape): { bg: BackGroup; sol: BackSolution; m: BackMemberRect; i: number } | null {
  const st = useAppStore.getState();
  const bg = st.backGroups.find(g => g.id === (backPanel.parameters as any)?.backGroupId);
  if (!bg) return null;
  const vf = st.virtualFaces.find(f => f.id === (backPanel.parameters as any)?.virtualFaceId);
  if (!vf) return null;
  const i = vf.backIndex ?? bg.memberVfIds.indexOf(vf.id);
  const sol = backSolutionMemo(bg);
  const m = sol?.members[i];
  return sol && m ? { bg, sol, m, i } : null;
}

/** Eksen aralıklarından kutu (aralık uçları sırasız). */
function boxOf(ranges: Array<[0 | 1 | 2, number, number]>): CavityBox {
  const box: CavityBox = { min: [0, 0, 0], max: [0, 0, 0] };
  for (const [a, x, y] of ranges) { box.min[a] = Math.min(x, y); box.max[a] = Math.max(x, y); }
  return box;
}

/** BASKI KUTUSU (gövde-yerel): iç parçanın levhası — hücre; çakma kenarda sınır panelinin DIŞ yüzüne kadar uzar (panelin tüm
 *  kalınlığı bloke, bini değerinden bağımsız), kanallı kenarda ve levhaya bağlı derzde panele GİRMEZ (hücre kenarı / levha yüzü),
 *  sayı derzinde hücre kenarı. Derinlik: parçanın gerçek kalınlık aralığı. `extra` = çakma kenarda dış yüzün ötesine pay (damga). */
function backPressBox(bg: BackGroup, sol: BackSolution, m: BackMemberRect, extra = 0): CavityBox {
  const cell = backCells(sol.solved).find(c => c.leafId === m.leafId) ?? m;
  let { u0, u1, v0, v1 } = cell;
  const r = sol.rect, e = sol.ext;
  if (cellTouchesEdge(cell, r, 'uMin') && e.uMin.nail) u0 -= e.uMin.t + extra;
  if (cellTouchesEdge(cell, r, 'uMax') && e.uMax.nail) u1 += e.uMax.t + extra;
  if (cellTouchesEdge(cell, r, 'vMin') && e.vMin.nail) v0 -= e.vMin.t + extra;
  if (cellTouchesEdge(cell, r, 'vMax') && e.vMax.nail) v1 += e.vMax.t + extra;
  // Bağlı derz: kanallıda levhanın yüzünde durur (levha tam boy), ÇAKMADA levhanın tüm kalınlığını kaplar (levha kısalır).
  const js = sol.sides[m.leafId];
  if (js?.uMin) u0 = js.uMin.rel === 'nail' ? js.uMin.a0 : js.uMin.a1;
  if (js?.uMax) u1 = js.uMax.rel === 'nail' ? js.uMax.a1 : js.uMax.a0;
  if (js?.vMin) v0 = js.vMin.rel === 'nail' ? js.vMin.a0 : js.vMin.a1;
  if (js?.vMax) v1 = js.vMax.rel === 'nail' ? js.vMax.a1 : js.vMax.a0;
  const { u, v } = backPlaneAxes(bg.axis);
  return boxOf([[u, u0, u1], [v, v0, v1], [bg.axis, m.front, m.front - bg.side * bg.thickness]]);
}

/** KISALTMA KURALI (PanelGroupService.groupObstacles): iç (kanallı tip) arkalık parçası raf/dikme grubunun hacim engelidir ⇔
 *  grubun bir üyesi parçanın ÇAKMA kenarıdır (kenar ilişkisi 'nail') YA DA arkalık-sınırı bir üyeden parça GEÇİYOR (üye kenar da,
 *  bağlı derz de değil: bütün arkalık). Kanallı kenar (groove) ve levhaya bağlı derz kısaltmaz; dış (çakma tip) parça gövdenin
 *  dışındadır, kısaltmaz. Döner: engel kutusu (çakma kenarda levhanın tüm kalınlığını kapsar) ya da null. */
export function backObstacleFor(group: PanelGroup, backPanel: Shape): CavityBox | null {
  const hit = backMemberOfPanel(backPanel);
  if (!hit || hit.bg.shapeId !== group.shapeId || hit.m.piece.placement !== 'inner') return null;
  const { bg, sol, m } = hit;
  const vfs = useAppStore.getState().virtualFaces;
  const bounds = sol.bounds ?? bg.bounds;
  const cell = backCells(sol.solved).find(c => c.leafId === m.leafId) ?? m;
  const joint = new Set(backJointRefs(bg.tree).map(r => r.ref.vfId));
  const { u, v } = backPlaneAxes(bg.axis);
  const parent = shapeById(bg.shapeId, useAppStore.getState().shapes);
  const nailedJoint = (id: string) => Object.values(sol.sides[m.leafId] ?? {}).some(x => x?.vfId === id && x.rel === 'nail');
  let press = false, involved = false;
  for (const id of group.memberVfIds) {
    const edge = EDGE_KEYS.find(k => bounds[k]?.vfId === id);
    if (edge) {
      involved = true;
      if (sol.ext[edge].nail && cellTouchesEdge(cell, sol.rect, edge)) { press = true; break; }
      continue;
    }
    // Levhaya bağlı derz: yalnız ÇAKMA ilişkide (ve parça o derze değiyorsa) kısaltır; kanallıda iki yandan kanal, levha tam boy.
    if (joint.has(id)) {
      involved = true;
      if (nailedJoint(id)) { press = true; break; }
      continue;
    }
    const mvf = vfs.find(f => f.id === id);
    if (!mvf || !vfBackBound(mvf)) continue;
    const p = parent ? panelOfVf(id, useAppStore.getState().shapes) : null;
    const box = p && parent ? panelLocalBox(p, parent) : null;
    if (!box) continue;
    // Arkalık-sınırı üyenin ortası parçanın hücresindeyse parça o levhadan geçiyor.
    const cu = (box.min[u] + box.max[u]) / 2, cv = (box.min[v] + box.max[v]) / 2;
    if (cu > cell.u0 - TOL && cu < cell.u1 + TOL && cv > cell.v0 - TOL && cv < cell.v1 + TOL) { press = true; break; }
  }
  if (press) return backPressBox(bg, sol, m);
  // SIRA: arkalıktan SONRA konan raf/dikme grubu (kenar / derz ilişkisi yoksa) parçanın levhasıyla sınırlanır → arkalığın ön yüzünde,
  // kanal bolluğu varsa o kadar geride biter (backOrderBox).
  if (!involved && backPrecedes(backPanel, group.memberVfIds, vfs)) return backOrderBox(bg, m, group.memberVfIds);
  return null;
}

/** Arkalık paneli VF sırasında hedef VF'lerin (hepsinden) ÖNCE mi; hedef henüz VF'siz (yeni grup) → sonra sayılır. */
function backPrecedes(backPanel: Shape, targetVfIds: string[], vfs: VirtualFace[]): boolean {
  const idx = (id: string | undefined) => (id ? vfs.findIndex(f => f.id === id) : -1);
  const mine = idx((backPanel.parameters as any)?.virtualFaceId);
  if (mine < 0) return false;
  const others = targetVfIds.map(idx).filter(i => i >= 0);
  return !others.length || others.every(i => i > mine);
}

/** Parçanın TAM levha kutusu (gövde-yerel): kenar uzantıları (kanal girişi / bini) dahil; açılı parçada çokgenin kutusu. */
function backPieceBox(bg: Pick<BackGroup, 'axis' | 'side' | 'thickness'>, m: BackMemberRect): CavityBox {
  const xs = m.poly ? m.poly.map(q => q.x) : [m.u0, m.u1], ys = m.poly ? m.poly.map(q => q.y) : [m.v0, m.v1];
  const { u, v } = backPlaneAxes(bg.axis);
  const box: CavityBox = { min: [0, 0, 0], max: [0, 0, 0] };
  box.min[u] = Math.min(...xs); box.max[u] = Math.max(...xs);
  box.min[v] = Math.min(...ys); box.max[v] = Math.max(...ys);
  const z0 = m.front, z1 = m.front - bg.side * bg.thickness;
  box.min[bg.axis] = Math.min(z0, z1); box.max[bg.axis] = Math.max(z0, z1);
  return box;
}

/** SIRA KUTUSU: arkalıktan SONRA konan panelin engeli = parçanın levhası, derinlikte KANAL BOLLUĞU kadar genişletilmiş (ön yüzde
 *  `front`, arka yüzde `back`) → panel arkalığa değmez, bollaştırılmış kanalın sınırında biter (kanal kesicisiyle aynı z aralığı).
 *  Bolluk: panelin (vfIds) kendi kenar değeri varsa o, yoksa grup değeri; 0 ise levhaya dayanır. */
function backOrderBox(bg: BackGroup, m: BackMemberRect, vfIds: string[] = []): CavityBox {
  const box = backPieceBox(bg, m);
  const own = vfIds.find(id => bg.grooveClearBy?.[id]);
  const clear = backGrooveClearOf(bg, own);
  const rear = m.front, frontF = m.front - bg.side * bg.thickness;
  box.min[bg.axis] = Math.min(rear, frontF) - (bg.side < 0 ? clear.back : clear.front);
  box.max[bg.axis] = Math.max(rear, frontF) + (bg.side < 0 ? clear.front : clear.back);
  return box;
}

/** Yeni konacak raf/dikmenin hacim seçimi (sırada en sonda): iç arkalık parçası (kanal bolluğuyla) engeldir. */
export function backPickObstacle(backPanel: Shape): CavityBox | null {
  const hit = backMemberOfPanel(backPanel);
  return hit && hit.m.piece.placement === 'inner' ? backOrderBox(hit.bg, hit.m) : null;
}

/** Gövde paneli yüz seçimi önizlemesi (yeni panel sırada en sonda): iç arkalık parçası kutu damgası olarak kardeş listesine girer. */
export function backPreviewStamp(backPanel: Shape): Shape | null {
  const box = backPickObstacle(backPanel);
  if (!box) return null;
  const sz = [0, 1, 2].map(a => Math.max(0.01, box.max[a] - box.min[a]));
  const mid = [0, 1, 2].map(a => (box.min[a] + box.max[a]) / 2);
  const geo = new THREE.BoxGeometry(sz[0], sz[1], sz[2]).translate(mid[0], mid[1], mid[2]);
  const parent = shapeById((backPanel.parameters as any)?.parentShapeId);
  return {
    ...backPanel, geometry: geo, position: parent ? [...parent.position] : backPanel.position,
    rotation: parent ? [...parent.rotation] : backPanel.rotation, scale: parent ? [...parent.scale] : backPanel.scale,
  } as Shape;
}

/** ARKALIĞIN ÖNÜNE PANEL (Goker, Eki 2026 — "arkalığın önüne panel yerleştiremiyorum"): gövde yüzünün (gövde-yerel, dışa normal `nL`)
 *  `pL` noktasının arkasında, yüzün İÇİNDE duran arkalık parçası + önüne BİTİŞİK yığılmış katmanlar (`layers`: o yüzde duran dönmemiş
 *  gövde panelleri). Döner: en içteki yüzün yüzden içeri derinliği + o panel (taban). Konuma göre çözülür (parça id'si değil) → arkalık
 *  bölünse / setback ya da kalınlığı değişse de izlenir. Dış (çakma tip) parça yüzün dışındadır → null (yüzün kendisi zaten önüdür). */
export function backStackAt(
  nL: THREE.Vector3, pL: THREE.Vector3, backs: Shape[], layers: Shape[], vfs: VirtualFace[] = useAppStore.getState().virtualFaces,
): { depth: number; base: Shape } | null {
  const k = Math.abs(nL.x) > 0.9 ? 'x' : Math.abs(nL.y) > 0.9 ? 'y' : Math.abs(nL.z) > 0.9 ? 'z' : null;
  if (!k) return null;
  const inSgn = nL[k] < 0 ? 1 : -1;
  const span = (p: Shape) => {
    const vf = vfs.find(f => f.id === (p.parameters as any)?.virtualFaceId);
    if (!vf || new THREE.Vector3(...vf.normal).normalize().dot(nL) < 0.95) return null;
    const bb = localBboxOf(footprintGeometry(p) ?? p.geometry);
    if (!bb || !(['x', 'y', 'z'] as const).every(a => a === k || (pL[a] >= bb.min[a] - 0.5 && pL[a] <= bb.max[a] + 0.5))) return null;
    const a = (bb.min[k] - pL[k]) * inSgn, b = (bb.max[k] - pL[k]) * inSgn;
    return { near: Math.min(a, b), far: Math.max(a, b) };
  };
  let best: { depth: number; base: Shape } | null = null;
  for (const p of backs) { const s = span(p); if (s && s.far > 0.5 && (!best || s.far > best.depth)) best = { depth: s.far, base: p }; }
  if (!best) return null;
  // Katmanlar zincir halinde: yakın yüzü o anki en içteki yüze değen panel bir sonraki katmandır.
  const spans = layers.map(p => ({ p, s: span(p) })).filter(x => !!x.s) as Array<{ p: Shape; s: { near: number; far: number } }>;
  for (let guard = 0; guard < spans.length; guard++) {
    const next = spans.find(x => Math.abs(x.s.near - best!.depth) < 1 && x.s.far > best!.depth + 0.5);
    if (!next) break;
    best = { depth: next.s.far, base: next.p };
  }
  return best;
}

/** GÖVDE PANELİ KISALTMA (PanelEngine.stamps / buildStamp): iç parça, ÇAKMA kenarındaki gövde panelini (VF `vfId`) sırası ne
 *  olursa olsun basar — damga kutusu parçanın levhası, panelin DIŞ yüzünün 1 mm ötesine uzatılmış (yüz düzlemine değsin); bölge
 *  çözücü şeridin UZUN kenarıyla keser → panel arkalığın ön yüzünde biter. Değilse null (arkalık hiçbir paneli damgalamaz). */
export function backNailStampFor(backPanel: Shape, vfId: string, backFirst = false): CavityBox | null {
  const hit = backMemberOfPanel(backPanel);
  if (!hit || hit.m.piece.placement !== 'inner') return null;
  const { bg, sol, m } = hit;
  const bounds = sol.bounds ?? bg.bounds;
  const edge = EDGE_KEYS.find(k => bounds[k]?.vfId === vfId);
  if (edge) {
    if (!sol.ext[edge].nail) return null;
    const cell = backCells(sol.solved).find(c => c.leafId === m.leafId) ?? m;
    return cellTouchesEdge(cell, sol.rect, edge) ? backPressBox(bg, sol, m, 1) : null;
  }
  // SIRA: arkalıktan SONRA konan gövde paneli (arkalığın kenarı / derzi değilse) parçanın levhasıyla basılır → arkalığa kadar,
  // kanal bolluğu varsa o kadar geride biter (backOrderBox).
  if (!backFirst || backJointRefs(bg.tree).some(r => r.ref.vfId === vfId)) return null;
  return backOrderBox(bg, m, [vfId]);
}

/** Levhaya bağlı derzin ilişkisi (yoksa 'groove'). */
export const backJointRelOf = (tree: BackNode, splitId: string, k: number): BackEdgeRel => {
  const n = findBackNode(tree, splitId);
  return (n && n.kind === 'split' ? n.refs?.[k]?.rel : undefined) ?? 'groove';
};
/** Bölmenin ölçü / boşluk / bağ alanlarını yamalar. */
const patchSplit = (tree: BackNode, splitId: string, patch: object) => replaceBackNode(tree, splitId, old => ({ ...(old as any), ...patch }));
/** Bağlı derz ilişkisi: 'groove' → iki yandan kanal, dikme/raf tam boy; 'nail' → dikme/raf arkalığın ön yüzüne kadar kısalır. */
export async function setBackJointRel(groupId: string, splitId: string, k: number, rel: BackEdgeRel): Promise<void> {
  const group = groupById(groupId);
  const node = group ? findBackNode(group.tree, splitId) : null;
  if (!group || !node || node.kind !== 'split' || !node.refs?.[k] || (node.refs[k].rel ?? 'groove') === rel) return;
  const ref = { ...node.refs[k] };
  if (rel === 'groove') delete ref.rel; else ref.rel = rel;
  const tree = replaceBackNode(group.tree, splitId, old => ({ ...(old as any), refs: { ...(old as any).refs, [k]: ref } }));
  await writeBackGroup(group, { tree });
}

// KANAL KESİCİLERİ (PanelEngine.buildPanel): kanallı (groove) ilişkideki sınır paneline / bağlı derz levhasına iç parçanın KANALI
// katıdan çıkarılır — kutu: kenar ekseninde panelin iç yüzünden `inset + depth` kadar içeri (dışa GROOVE_MOUTH taşar), çapraz
// eksende parçanın açıklığı, derinlikte [parça arkası − back, parça önü + front]. Yalnız GÖRÜNÜM/katı içindir: ayak izi, damga ve
// hacim ızgarası kanalsız geometriyi okur (Shape.ungroovedGeometry) → kanal boşluğuna hiçbir panel sızmaz.
export function backGrooveCuttersFor(panel: Shape): CavityBox[] {
  const st = useAppStore.getState();
  const vfId = (panel.parameters as any)?.virtualFaceId as string | undefined;
  const parentId = (panel.parameters as any)?.parentShapeId as string | undefined;
  if (!vfId || !parentId || isBackPanel(panel) || panelHasRotation(panel)) return [];
  const out: CavityBox[] = [];
  for (const bg of st.backGroups) {
    if (bg.shapeId !== parentId) continue;
    const sol = backSolutionMemo(bg);
    if (!sol) continue;
    const bounds = sol.bounds ?? bg.bounds;
    const clear = backGrooveClearOf(bg, vfId);   // bu panelin (kenar / derz) kendi değeri, yoksa grup
    const { u, v } = backPlaneAxes(bg.axis);
    const cells = backCells(sol.solved);
    const edge = EDGE_KEYS.find(k => bounds[k]?.vfId === vfId);
    for (const m of sol.members) {
      if (m.piece.placement !== 'inner') continue;
      const cell = cells.find(c => c.leafId === m.leafId) ?? m;
      const rear = m.front, frontF = m.front - bg.side * bg.thickness;
      const zlo = Math.min(rear, frontF) - (bg.side < 0 ? clear.back : clear.front);
      const zhi = Math.max(rear, frontF) + (bg.side < 0 ? clear.front : clear.back);
      // k kenarında parçaya bakan `face` yüzünden `ins + depth` içeri, GROOVE_MOUTH dışarı; çaprazda parçanın açıklığı.
      const push = (k: BackEdgeKey, face: number, ins: number) => {
        const isU = k === 'uMin' || k === 'uMax', minSide = k === 'uMin' || k === 'vMin';
        const deep = face + (minSide ? -1 : 1) * (ins + clear.depth), mouth = face + (minSide ? 1 : -1) * GROOVE_MOUTH;
        const box = boxOf([[isU ? u : v, deep, mouth], isU ? [v, m.v0, m.v1] : [u, m.u0, m.u1]]);
        box.min[bg.axis] = zlo; box.max[bg.axis] = zhi;
        out.push(box);
      };
      // Grup kenarı: kanallı ilişki, parça kenara değiyor, giriş > 0; yüz = panelin iç yüzü (grup dikdörtgeninin kenarı).
      if (edge && sol.ext[edge].rel === 'groove' && !sol.ext[edge].nail && cellTouchesEdge(cell, sol.rect, edge) && m.piece.inset[edge] > 0) {
        const r = sol.rect;
        push(edge, { uMin: r.u0, uMax: r.u1, vMin: r.v0, vMax: r.v1 }[edge], m.piece.inset[edge]);
      }
      // Bağlı derz (dikme/raf): kanallı ilişkide parça levhanın (parçaya bakan) yüzünden `in` kadar girer.
      const js = sol.sides[m.leafId];
      if (js) for (const [k, side] of Object.entries(js) as Array<[BackEdgeKey, BackJointSide]>) {
        if (side.vfId !== vfId || side.rel !== 'groove' || !(side.in > 0)) continue;
        push(k, k === 'uMin' || k === 'vMin' ? side.a1 : side.a0, side.in);
      }
    }
  }
  return out;
}
/** Kanal bollaştırma (mm ≥ 0): vfId yoksa GRUP değeri (kendi değeri olmayan tüm kenarlar izler), varsa yalnız o kenar (sınır / derz
 *  paneli). Eksik alanlar korunur. */
export async function setBackGrooveClear(groupId: string, patch: Partial<BackGrooveClear>, vfId?: string): Promise<void> {
  const group = groupById(groupId);
  if (!group) return;
  const keys = ['front', 'back', 'depth'] as const;
  const cur = backGrooveClearOf(group, vfId);
  const valid = (x: number | undefined): x is number => Number.isFinite(x) && (x as number) >= 0;
  const changed = keys.filter(k => { const v = patch[k]; return valid(v) && Math.abs(round1(v) - cur[k]) >= 0.05; });
  if (!changed.length) return;
  if (!vfId) {
    const next: BackGrooveClear = { ...backGrooveClearOf(group) };
    for (const k of changed) next[k] = round1(patch[k] as number);
    await writeBackGroup(group, { grooveClear: next });
    return;
  }
  const by = { ...(group.grooveClearBy ?? {}) };
  const own = { ...(by[vfId] ?? {}) };
  for (const k of changed) own[k] = round1(patch[k] as number);
  by[vfId] = own;
  await writeBackGroup(group, { grooveClearBy: by });
}
/** Kenarın kendi bollaştırma değerlerini siler → grup değerine döner. */
export async function resetBackGrooveClear(groupId: string, vfId: string): Promise<void> {
  const group = groupById(groupId);
  if (!group?.grooveClearBy?.[vfId]) return;
  const by = { ...group.grooveClearBy };
  delete by[vfId];
  await writeBackGroup(group, { grooveClearBy: Object.keys(by).length ? by : undefined });
}

/** Kenar ilişkisi (grup başına): 'nail' → o kenarın paneli iç parçaların ön yüzüne kadar kısaltılır; 'groove' → tam boy, kanal. */
export async function setBackEdgeRel(groupId: string, edge: BackEdgeKey, rel: BackEdgeRel): Promise<void> {
  const group = groupById(groupId);
  if (!group || edgeRelOf(group, edge) === rel) return;
  const edgeRel = { ...(group.edgeRel ?? {}) };
  if (rel === 'groove') delete edgeRel[edge]; else edgeRel[edge] = rel;
  await writeBackGroup(group, { edgeRel: Object.keys(edgeRel).length ? edgeRel : undefined });
}

type CutGroup = Pick<BackGroup, 'axis' | 'side' | 'thickness' | 'anchor'>;
/** Açılı sınır kesimi parça başına: kanallı parça eğik panele inset kadar girer (negatif boşluk), çakma parça binisine göre örter. */
export function applyBackCuts(group: CutGroup, members: BackMemberRect[], cuts: BackCut[]): BackMemberRect[] {
  if (!cuts.length) return members;
  return members.map(m => {
    const { placement, inset, cover } = m.piece;
    const gaps: BackEdgeGaps = placement === 'inner'
      ? { uMin: -inset.uMin, uMax: -inset.uMax, vMin: -inset.vMin, vMax: -inset.vMax }
      : { uMin: 0, uMax: 0, vMin: 0, vMax: 0 };
    const cov = placement === 'outer' ? cover : undefined;
    const poly = clipMemberByCuts(m, cuts, group.axis, group.side, placement, group.thickness, m.front, gaps, cov, group.anchor);
    return poly ? { ...m, poly } : m;
  });
}

// Açılı sınır panelinde alan çıpanın (tıklanan nokta) tarafına kırpılıp kutusuna daraltılır; eğik kenar applyBackCuts'ta çokgen kalır.
export function backRectByCuts(
  group: Pick<BackGroup, 'axis' | 'side' | 'placement' | 'thickness' | 'gap'>, rect: BackRect, cuts: BackCut[], anchor?: [number, number],
): BackRect {
  if (!anchor || !cuts.length) return rect;
  // Boşluksuz, grup varsayılan tipiyle kırpılır (parça uzantıları hücre yerleşiminde).
  const poly = clipMemberByCuts(rect, cuts, group.axis, group.side, group.placement, group.thickness, rect.front, 0, undefined, anchor);
  if (!poly || poly.length < 3) return rect;
  const out = polyRect(poly, rect.front);
  return out.u1 - out.u0 < MIN_BACK_SPAN || out.v1 - out.v0 < MIN_BACK_SPAN ? rect : out;
}

/** Bölge dikdörtgeninin açılı panellerle kırpılmış şekli (kesici yüzünde; grup varsayılan tipiyle). */
export function backCutOutline(group: CutGroup & Pick<BackGroup, 'placement'>, rect: BackRect, r: PlaneRect, cuts: BackCut[]): Pt2[] {
  const base = rectPoly(r);
  if (!cuts.length) return base;
  return clipMemberByCuts(r, cuts, group.axis, group.side, group.placement, group.thickness, rect.front, 0, undefined, group.anchor) ?? base;
}

// VF düzlemi = parçanın DIŞ yüzü (m.plane); createPanelFromVirtualFace −normal yönünde t uzar.
const backMemberVfGeometry = (group: Pick<BackGroup, 'axis' | 'side'>, m: BackMemberRect) => slabVfGeometry(group.axis, group.side, m.plane, m);

function backVfPatch(vf: VirtualFace, group: BackGroup, sol: BackSolution): Partial<VirtualFace> | null {
  const i = vf.backIndex ?? group.memberVfIds.indexOf(vf.id);
  const m = sol.members[i];
  if (!m) return null;
  const g = backMemberVfGeometry(group, m);
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
export type BackJoint = SplitJoint;

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
  ref?: { splitId: string; k: number };
  poly?: Pt2[];
}

// Şemada gösterilecek sınır levhaları (çakmada bini, kanallıda kenar şeritleri kanal girişini taşır). allPanels=true → işaretsizler de.
export function backNearPanels(
  group: BackGroup, parent: Shape, shapes: Shape[], vfs: VirtualFace[], panelGroups: PanelGroup[], allPanels = false,
): BackNearPanel[] {
  const { u, v } = backPlaneAxes(group.axis);
  const solved = solveBackTree(group);
  const ms = backCells(solved);
  const joints = backJoints(solved);
  const near = Math.max(group.gap, 0) + NEAR_EXTRA;
  const front = group.rect.front;
  const rb = resolveBackBounds(group, parent, shapes, vfs);
  const edgeOf = (vfId: string): BackEdgeKey | undefined => EDGE_KEYS.find(k => rb[k]?.vfId === vfId);
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
      if (bound) {
        ref = { splitId: bound.splitId, k: bound.k };
        joint = joints.find(j => j.splitId === bound.splitId && j.k === bound.k);
      } else {
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

/** Gövde yokken (ya da şema için parent'sız): hücreler kenar bilgisi olmadan yerleştirilir (giriş/bini yok). */
export const backFallbackSolution = (group: BackGroup): BackSolution => {
  const solved = solveBackTree(group);
  const ext = noExt();
  const members = placeBackPieces(group, backCells(solved), group.rect, ext);
  return { rect: group.rect, tree: solvedToBackTree(solved), solved, members, ext, sides: {} };
};

function makeMemberVf(group: BackGroup, i: number, sol: BackSolution): VirtualFace {
  const g = backMemberVfGeometry(group, sol.members[i]);
  return {
    id: genId('vf-back'), shapeId: group.shapeId,
    normal: g.normal, center: g.center, vertices: g.vertices,
    description: backGroupName(group), hasPanel: false,
    parentFaceShape: false, interior: true, backGroupId: group.id, backIndex: i,
    ...({ regionAnchor: g.center } as any),
  };
}

/** `init`: hızlı gövde gibi çağıranların varsayılanları (kalınlık / setback / giriş / bollaştırma) ezen değerleri. */
export function createBackGroupFromPick(
  shapeId: string, pick: BackPick, placement: BackPlacement, name?: string,
  init?: Partial<Pick<BackGroup, 'thickness' | 'setback' | 'inset' | 'grooveClear' | 'quickBody'>>,
): BackGroup | null {
  const st = useAppStore.getState();
  const parent = shapeById(shapeId, st.shapes);
  if (!parent) return null;
  const rect = { ...pick.inner };   // grup dikdörtgeni = iç dikdörtgen; tip/uzantılar parça başına
  const group: BackGroup = {
    id: genId('back'), shapeId, setback: BACK_SETBACK, inset: BACK_INSET, axis: pick.axis, side: pick.side, placement,
    bounds: pick.bounds, depthRef: pick.depth, rect, anchor: pick.at, tree: makeBackLeaf(),
    gap: BACK_GAP, thickness: BACK_THICKNESS,
    memberVfIds: [], name: name?.trim() || 'Back', createdAt: Date.now(),
    ...init,
  };
  const sol = solveFromStore(group) || backFallbackSolution(group);
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
  const sol = solveFromStore(next) || backFallbackSolution(next);
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
// (paneli otomatik üretim yaratır). restructured = üyeleri her durumda yenilenecek yapraklar. Üye sayısı tutmuyorsa hepsi yenilenir.
function rebuildMembers(group: BackGroup, nextGroup: BackGroup, restructured: Set<string>): void {
  const st = useAppStore.getState();
  const sol = solveFromStore(nextGroup) || backFallbackSolution(nextGroup);
  const oldMembers = backFallbackSolution(group).members;
  const oldIds = new Map<string, string>();
  if (oldMembers.length === group.memberVfIds.length) oldMembers.forEach((m, i) => { if (group.memberVfIds[i]) oldIds.set(m.leafId, group.memberVfIds[i]); });
  const ids: string[] = [], kept: string[] = [], fresh: VirtualFace[] = [];
  sol.members.forEach((m, i) => {
    const prev = restructured.has(m.leafId) ? undefined : oldIds.get(m.leafId);
    if (prev) { ids.push(prev); kept.push(prev); }
    else { const vf = makeMemberVf(nextGroup, i, sol); ids.push(vf.id); fresh.push(vf); }
  });
  // Grubun listedeki YERİ korunur (Goker: arkalık bölününce parçalar listenin sonuna düşüyor, sonra konan raf/dikme arkalığın
  // önünde sayılıp arkalığın dışına taşıyordu): hiç üye korunmazsa yeniler ilk eski üyenin yerine girer.
  const before = useAppStore.getState().virtualFaces.map(f => f.id);
  const mine = new Set(group.memberVfIds);
  let anchorIdx = before.findIndex(id => mine.has(id));
  while (anchorIdx > 0 && mine.has(before[anchorIdx - 1])) anchorIdx--;
  const anchorPrev = anchorIdx > 0 ? before[anchorIdx - 1] : null;
  removeMemberVfs(group.memberVfIds.filter(id => !kept.includes(id)));
  for (const id of kept) st.updateVirtualFace(id, { backIndex: ids.indexOf(id) });
  st.updateBackGroup(group.id, { ...nextGroup, rect: sol.rect, tree: sol.tree, memberVfIds: ids });
  // Yeni parçalar korunan son üyeden sonra eklenir: grup listede bir arada kalır.
  const order = useAppStore.getState().virtualFaces.map(f => f.id);
  const lastKept = kept.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b)).pop() ?? null;
  if (lastKept || anchorIdx < 0) st.insertVirtualFacesAfter(lastKept, fresh);
  else if (anchorPrev) st.insertVirtualFacesAfter(anchorPrev, fresh);
  else useAppStore.setState(s => ({ virtualFaces: [...fresh, ...s.virtualFaces] }));
  const now = useAppStore.getState();
  if (now.selectedBackGroupId !== group.id && !now.selectedPanelRow) st.setSelectedBackGroupId(group.id);
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
  const rebuildWith = (id: string, repl: BackNode, restructured: Set<string>) =>
    rebuildMembers(group, { ...group, tree: replaceBackNode(group.tree, id, () => repl) }, restructured);
  if (node.kind === 'leaf') {
    if (n <= 1) return node.id;
    const split: BackNode = { id: genId('bs'), kind: 'split', axis, sizes: [], gaps: gapsFor(n - 1), children: newLeaves(n) };
    rebuildWith(node.id, split, new Set([node.id]));
    return split.id;
  }
  if (node.axis === axis) {
    if (n === node.children.length) return node.id;
    if (n <= 1) {
      const first = node.children[0];
      rebuildWith(node.id, first, new Set(node.children.slice(1).flatMap(c => backLeaves(c).map(l => l.id))));
      return first.id;
    }
    const restructured = new Set<string>();
    let children = node.children.slice();
    if (n > children.length) {
      // Artış: son parça bir bölmeyse yeni parçalar onun kopyası (bölünmüş hal korunur), değilse eşit yeni parçalar.
      const last = children[children.length - 1], add = n - children.length;
      children = [...children, ...(last.kind === 'split' ? Array.from({ length: add }, () => cloneBackNode(last)) : newLeaves(add))];
    } else {
      for (const c of children.slice(n)) for (const l of backLeaves(c)) restructured.add(l.id);
      children = children.slice(0, n);
    }
    // Elle sayı girildiyse spacing hedefi kalkar; derz bağları kalan derzlerde (k < n−1) korunur.
    const refs = Object.fromEntries(Object.entries(node.refs ?? {}).filter(([k]) => +k < n - 1)) as Record<number, BackJointRef>;
    const next: BackNode = {
      ...node, children, gaps: gapsFor(n - 1, node.gaps), sizes: [],
      targetSize: opts.keepTargetSize ? node.targetSize : undefined, refs: Object.keys(refs).length ? refs : undefined,
    };
    rebuildWith(node.id, next, restructured);
    return node.id;
  }
  if (n <= 1) return node.id;
  const wrap: BackNode = {
    id: genId('bs'), kind: 'split', axis, sizes: [], gaps: gapsFor(n - 1), children: [node, ...Array.from({ length: n - 1 }, () => cloneBackNode(node))],
  };
  rebuildWith(node.id, wrap, new Set());
  return wrap.id;
}

/** Panel ref: levhanın merkezinden geçen her parça ikiye bölünür, derz levhaya 'center' bağlanır (levha taşınınca arkalık izler).
 *  Levha arkalığa değmeli ve grup sınırı olmamalı; raf/dikme üyesi değilse de bölünür ama rozetle taşınamaz (derz levhaya gider). */
export function splitBackAtPanel(groupId: string, vfId: string): string[] {
  const group = groupById(groupId);
  if (!group) return [];
  const st = useAppStore.getState();
  const parent = shapeById(group.shapeId, st.shapes);
  if (!parent) return [];
  const np = backNearPanels(group, parent, st.shapes, st.virtualFaces, st.panelGroups).find(p => p.vfId === vfId);
  if (!np || np.edge) return [];
  const axis = np.kind;
  const hits = leavesSplittableAt(solveBackTree(group), np, group.gap, MIN_BACK_SPAN);
  if (!hits.length) return [];
  let tree = group.tree;
  const ids: string[] = [], restructured = new Set<string>();
  for (const leaf of hits) {
    // Bağlı derzde boşluk YOK: hücreler levhanın ortasında buluşur, parça kenarları levha yüzünden binme (jointIn) ile ölçülür.
    const split: BackNode = {
      id: genId('bs'), kind: 'split', axis, sizes: [], gaps: [0], refs: { 0: { vfId, align: 'center' } }, children: [makeBackLeaf(), makeBackLeaf()],
    };
    tree = replaceBackNode(tree, leaf.id, () => split);
    ids.push(split.id); restructured.add(leaf.id);
  }
  rebuildMembers(group, { ...group, tree }, restructured);
  return ids;
}

export const backCountForTargetSize = (L: number, size: number, g: number) =>
  Math.max(1, Math.min(MAX_BACK_SPLIT, Math.round((L + g) / (Math.max(1, size) + g))));

export type BackEditOpts = { preview?: boolean };
/** k. ölçünün bitişik derzi (k ya da k−1) levhaya bağlı mı → ölçü levhadan türetilir, girilemez. */
export const backSizeBoundByJoint = (sn: Pick<Extract<BackNodeSolved, { kind: 'split' }>, 'refs'>, k: number): boolean => !!(sn.refs?.[k] || sn.refs?.[k - 1]);
/** Ölçü girişi. Pasif ölçü (kalanı toplar) ve levhaya bağlı derze bitişik ölçü (değeri levhanın konumu belirler) girilemez. */
export async function editBackSize(groupId: string, splitId: string, k: number, value: number, opts: BackEditOpts = {}): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value) || value <= 0) return;
  const sn = findSolvedBackNode(solveBackTree(group), splitId);
  if (!sn || sn.kind !== 'split' || k < 0 || k >= sn.children.length) return;
  if (passiveGapIndex(sn.sizes, sn.children.length) === k || backSizeBoundByJoint(sn, k)) return;
  const L = sn.axis === 'u' ? sn.u1 - sn.u0 : sn.v1 - sn.v0;
  const bn = sizeEditBase?.groupId === groupId ? findBackNode(sizeEditBase.tree, splitId) : null;
  const base = bn?.kind === 'split' && bn.sizes.length === sn.sizes.length ? bn.sizes : undefined;
  const sizes = applyGapEditProportional(sn.sizes, k, value, L, sn.gaps.length, sn.gaps, { base, min: MIN_BACK_SIZE });
  await writeBackGroup(group, { tree: patchSplit(group.tree, splitId, { sizes }) }, !!opts.preview);
}
/** Kilit rozeti: açık → pin → kilitli → açık; rebuild yok. Son açık ölçü (pasif) pinlenemez / kilitlenemez. */
export function toggleBackSizeLock(groupId: string, splitId: string, k: number): void {
  const group = groupById(groupId);
  const sn = group ? findSolvedBackNode(solveBackTree(group), splitId) : null;
  if (!group || !sn || sn.kind !== 'split' || k < 0 || k >= sn.sizes.length) return;
  const sizes = cycleGapMode(sn.sizes, k, sn.children.length);
  if (!sizes) return;
  useAppStore.getState().updateBackGroup(groupId, { tree: patchSplit(group.tree, splitId, { sizes }) });
}
/** Derz boşluğu; levhaya bağlı derzde boşluk girilmez (parçaların binme payı jointIn kullanılır). */
export async function setBackSplitGap(groupId: string, splitId: string, k: number, value: number, opts: BackEditOpts = {}): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value) || value < 0) return;
  const sn = findSolvedBackNode(solveBackTree(group), splitId);
  if (!sn || sn.kind !== 'split' || k < 0 || k >= sn.gaps.length) return;
  if (opts.preview && Math.abs(sn.gaps[k] - value) < 0.05) return;   // onay hep yazar
  if (sn.refs?.[k]) return;
  const gaps = sn.gaps.slice(); gaps[k] = round1(value);
  await writeBackGroup(group, { tree: patchSplit(group.tree, splitId, { gaps }) }, !!opts.preview);
}
/** Yaprak(lar)ı günceller; leafIds boşsa TÜM yapraklar. */
function patchLeaves(tree: BackNode, leafIds: string[], patch: (l: BackLeaf) => BackLeaf): BackNode {
  const ids = new Set(leafIds.length ? leafIds : backLeaves(tree).map(l => l.id));
  const walk = (n: BackNode): BackNode => (n.kind === 'leaf' ? (ids.has(n.id) ? patch(n) : n) : { ...n, children: n.children.map(walk) });
  return walk(tree);
}
const leavesOf = (group: BackGroup, leafIds: string[]): BackLeaf[] =>
  (leafIds.length ? leafIds.map(id => findBackNode(group.tree, id)).filter((n): n is BackLeaf => !!n && n.kind === 'leaf') : backLeaves(group.tree));
/** Kanallı parça(lar): kenar panelinin içine giriş (mm, ≥ 0) — parça başına yazılır. leafIds boş → tüm parçalar. */
export async function setBackEdgeInset(groupId: string, edge: BackEdgeKey, inset: number, leafIds: string[], opts: BackEditOpts = {}): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(inset) || inset < 0) return;
  const v = round1(inset);
  // Önizlemede değer aynıysa atlanır; onay hep yazar.
  if (opts.preview && leavesOf(group, leafIds).every(l => Math.abs(backPieceOf(group, l).inset[edge] - v) < 0.05)) return;
  const tree = patchLeaves(group.tree, leafIds, l => ({ ...l, inset: { ...(l.inset ?? {}), [edge]: v } }));
  await writeBackGroup(group, { tree }, !!opts.preview);
}
/** İÇ LEVHAYA BİNME: parça(lar)ın levhaya bağlı derzdeki `edge` kenarında dikme/rafın üzerine binme payı (mm). Parça başına yazılır;
 *  0..levha kalınlığı, karşı yandaki parçaların binmesiyle ÇAKIŞMAYACAK kadar kırpılır. Yalnız o kenarı bağlı derzde olan parçalara yazar. */
export async function setBackJointIn(groupId: string, edge: BackEdgeKey, mm: number, leafIds: string[], opts: BackEditOpts = {}): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(mm) || mm < 0) return;
  const sol = solveFromStore(group);
  if (!sol) return;
  const opp: Record<BackEdgeKey, BackEdgeKey> = { uMin: 'uMax', uMax: 'uMin', vMin: 'vMax', vMax: 'vMin' };
  const isU = edge === 'uMin' || edge === 'uMax';
  // Çapraz eksende örtüşme (u kenarında v aralığı, v kenarında u aralığı).
  const crossOverlap = (a: BackMemberRect, b: BackMemberRect) =>
    (isU ? Math.min(a.v1, b.v1) - Math.max(a.v0, b.v0) : Math.min(a.u1, b.u1) - Math.max(a.u0, b.u0));
  const vals = new Map<string, number>();
  for (const id of leafIds) {
    const js = sol.sides[id]?.[edge];
    if (!js) continue;
    // Karşı yan: aynı derzin öbür kenarındaki parçalar; çapraz eksende örtüşenlerin en büyük binmesi.
    const me = sol.members.find(m => m.leafId === id);
    let other = 0;
    for (const [oid, rec] of Object.entries(sol.sides)) {
      const o = rec[opp[edge]];
      if (!o || o.splitId !== js.splitId || o.k !== js.k) continue;
      const om = sol.members.find(m => m.leafId === oid);
      if (me && om && crossOverlap(me, om) <= TOL) continue;
      other = Math.max(other, o.in);
    }
    // Levha kalınlığı / karşı parça ile kırpılır.
    vals.set(id, round1(Math.min(mm, Math.max(0, js.t - other))));
  }
  if (!vals.size) return;
  // Önizlemede değerler aynıysa atlanır; onay hep yazar.
  if (opts.preview && [...vals].every(([id, v]) => Math.abs((sol.sides[id]?.[edge]?.in ?? -1) - v) < 0.05)) return;
  const tree = patchLeaves(group.tree, [...vals.keys()], l => ({ ...l, jointIn: { ...(l.jointIn ?? {}), [edge]: vals.get(l.id)! } }));
  await writeBackGroup(group, { tree }, !!opts.preview);
}
/** Kanallı: panellerin arka yüzünden parçanın arka yüzüne mesafe (mm). leafIds boş → grup varsayılanı yazılır, parça değerleri silinir. */
export async function setBackSetback(groupId: string, mm: number, leafIds: string[] = []): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(mm) || mm < 0) return;
  const v = round1(mm);
  if (!leafIds.length) {
    if (Math.abs(v - backSetbackOf(group)) < 0.05 && !backLeaves(group.tree).some(l => l.setback != null)) return;
    await writeBackGroup(group, { setback: v, tree: patchLeaves(group.tree, [], l => { const { setback: _s, ...rest } = l; return rest; }) });
    return;
  }
  if (leavesOf(group, leafIds).every(l => Math.abs(backPieceOf(group, l).setback - v) < 0.05)) return;
  await writeBackGroup(group, { tree: patchLeaves(group.tree, leafIds, l => ({ ...l, setback: v })) });
}
export interface BackLayoutSnap { tree: BackNode; gap: number; rect: BackRect }
export function backLayoutSnapshot(groupId: string): BackLayoutSnap | null {
  const g = groupById(groupId);
  sizeEditBase = g ? { groupId, tree: g.tree } : null;
  return g ? { tree: g.tree, gap: g.gap, rect: { ...g.rect } } : null;
}
export function restoreBackLayout(groupId: string, snap: BackLayoutSnap | null | undefined): void {
  sizeEditBase = null;
  if (!snap || !groupById(groupId)) return;
  useAppStore.getState().updateBackGroup(groupId, { tree: snap.tree, gap: snap.gap, rect: snap.rect });
}
/** Tip (çakma/kanallı): leafIds verilirse o parçalar; boşsa grup varsayılanı yazılır ve parça değerleri silinir (hepsi izler).
 *  Hücre ölçüleri değişmez (uzantılar hücrenin dışında); parça kendi inset/bini değerlerini korur. */
export async function setBackPlacement(groupId: string, placement: BackPlacement, leafIds: string[] = []): Promise<void> {
  const group = groupById(groupId);
  if (!group) return;
  if (!leafIds.length) {
    if (group.placement === placement && !backLeaves(group.tree).some(l => l.placement != null)) return;
    await writeBackGroup(group, { placement, tree: patchLeaves(group.tree, [], l => { const { placement: _p, ...rest } = l; return rest; }) });
    return;
  }
  if (leavesOf(group, leafIds).every(l => backPieceOf(group, l).placement === placement)) return;
  await writeBackGroup(group, { tree: patchLeaves(group.tree, leafIds, l => ({ ...l, placement })) });
}
/** Çakma parça(lar): `edge` kenarındaki sınır panelinin üzerine binme (mm). 0 = panelin iç yüzünde biter, panel kalınlığı = tamamen
 *  örter; kalınlıkla kırpılır (açılı sınır levhasında levha kalınlığıyla). leafIds boş → tüm parçalar. */
export async function setBackEdgeCover(groupId: string, edge: BackEdgeKey, mm: number, leafIds: string[] = [], opts: BackEditOpts = {}): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(mm) || mm < 0) return;
  const sol = solveFromStore(group);
  const st = useAppStore.getState(), parent = shapeById(group.shapeId, st.shapes);
  // En büyük binme: kenar panelinin kalınlığı; açılı kesim kenarındaysa kesen levhaların en kalını.
  let t = sol?.ext[edge]?.t ?? 0;
  if (parent) {
    const { u, v } = backPlaneAxes(group.axis), r = group.rect;
    const cu = group.anchor ? group.anchor[0] : (r.u0 + r.u1) / 2, cv = group.anchor ? group.anchor[1] : (r.v0 + r.v1) / 2;
    for (const c of collectBackCuts(parent, st.shapes, st.virtualFaces)) {
      if (Math.hypot(c.n[u], c.n[v]) > 1e-6 && cutEdgeOf(c, cu, cv, group.axis, r.front)?.edge === edge) t = Math.max(t, c.dMax - c.dMin);
    }
  }
  const v = round1(t > 0 ? Math.min(mm, t) : mm);
  // Önizlemede değer aynıysa atlanır; onay hep yazar.
  if (opts.preview && leavesOf(group, leafIds).every(l => Math.abs((backPieceOf(group, l).cover[edge] ?? t) - v) < 0.05)) return;
  const tree = patchLeaves(group.tree, leafIds, l => ({ ...l, cover: { ...(l.cover ?? {}), [edge]: v } }));
  await writeBackGroup(group, { tree }, !!opts.preview);
}
/** Panel ref ile bölünebilir mi: levhanın ortası bir parçanın içinden, iki yanda en az MIN_BACK_SPAN kalarak geçmeli. */
export function canSplitBackAtPanel(group: BackGroup, np: Pick<BackNearPanel, 'kind' | 'a0' | 'a1' | 'c0' | 'c1' | 'edge'>): boolean {
  return !np.edge && leavesSplittableAt(solveBackTree(group), np, group.gap, MIN_BACK_SPAN).length > 0;
}
export async function setBackThickness(groupId: string, t: number): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(t) || t < 1) return;
  const v = round1(t);
  if (Math.abs(v - group.thickness) < 0.05) return;
  setMemberPanelThickness(group.memberVfIds, v);
  await writeBackGroup(group, { thickness: v });
}
/** Grup varsayılanlarını tek seferde yazar (hızlı gövde ayarları yeniden uygulanınca): tip · kalınlık · setback · giriş · kanal payları.
 *  Parça başına tip / setback / giriş değerleri silinir (hepsi yeni ayarı izler); bölme, bini ve kenar payları korunur. */
export async function setBackDefaults(groupId: string, d: { placement: BackPlacement; thickness: number; setback: number; inset: number; grooveClear: BackGrooveClear }): Promise<void> {
  const group = groupById(groupId);
  if (!group) return;
  const t = Math.max(1, round1(d.thickness));
  if (Math.abs(t - group.thickness) >= 0.05) setMemberPanelThickness(group.memberVfIds, t);
  const tree = patchLeaves(group.tree, [], l => { const { placement: _p, setback: _s, inset: _i, ...rest } = l; return rest; });
  await writeBackGroup(group, {
    placement: d.placement, thickness: t, setback: Math.max(0, round1(d.setback)), inset: Math.max(0, round1(d.inset)),
    grooveClear: { front: Math.max(0, d.grooveClear.front), back: Math.max(0, d.grooveClear.back), depth: Math.max(0, d.grooveClear.depth) }, tree,
  });
}
export function renameBackGroup(groupId: string, name: string): void {
  const group = groupById(groupId);
  if (!group) return;
  useAppStore.getState().updateBackGroup(groupId, { name });
  renameMemberVfs(group.memberVfIds, name);
}
export function deleteBackGroupWithMembers(groupId: string): void {
  const group = groupById(groupId);
  if (!group) return;
  removeMemberVfs(group.memberVfIds);
  useAppStore.getState().deleteBackGroup(groupId);
}

const sameBackRef = (x?: BackJointRef, y?: BackJointRef) =>
  y?.vfId === x?.vfId && y?.align === x?.align && (y?.rel ?? 'groove') === (x?.rel ?? 'groove');

/** Rebuild sonrası (PanelEngine): store'daki dikdörtgen/ağaç güncel çözümle eşitlenir (bağlı derzlerin izlediği levha dahil).
 *  Bağlı levhası silinmiş derz bağı düşer (ölçüler dondurulur). */
export function syncBackGroups(parentShapeId: string): void {
  const st = useAppStore.getState();
  const parent = shapeById(parentShapeId, st.shapes);
  if (!parent) return;
  for (const g of st.backGroups) {
    if (g.shapeId !== parentShapeId) continue;
    const sol = solveBackGroup(g, parent, st.shapes);
    if (!sol) continue;
    const pruned = pruneRefs(g.tree, sol.solved, st.virtualFaces);
    const boundsChanged = !!sol.bounds && !sameBounds(sol.bounds, g.bounds);
    if (pruned) { st.updateBackGroup(g.id, { rect: sol.rect, tree: pruned, ...(boundsChanged ? { bounds: sol.bounds } : {}) }); continue; }
    // Devralınan kenar (sonradan konan sınır levhası) kalıcı yazılır: şema ve sonraki çözümler aynı kenarı görsün.
    if (boundsChanged) { st.updateBackGroup(g.id, { bounds: sol.bounds, rect: sol.rect, tree: sol.tree }); continue; }
    // Spacing: alan değiştiyse parça sayısı yeniden türetilir; sonraki rebuild aynı n'i bulup durur (döngü yok).
    try {
      const r = spacingResize(sol.solved, (L, size) => backCountForTargetSize(L, size, g.gap));
      // Üyeler yeniden kuruluyor; bu grubun senkronu bir sonraki rebuild'de.
      if (r) { setBackNodeSplit(g.id, r.id, r.axis, r.n, { keepTargetSize: true }); continue; }
    } catch { /* spacing hatası senkronu durdurmaz */ }
    const sameRect = rectKey(sol.rect) === rectKey(g.rect) && Math.abs(sol.rect.front - g.rect.front) < 0.05;
    if (sameRect && sameTree(sol.tree, g.tree, () => true, sameBackRef)) continue;
    st.updateBackGroup(g.id, { rect: sol.rect, tree: sol.tree });
  }
}

/** Seçme önizlemesi: adayın levhası (açılı sınırlarla kırpılmış çokgen prizma). */
export function backSlabPolygon(
  group: Pick<BackGroup, 'axis' | 'side' | 'placement' | 'thickness' | 'gap' | 'anchor'>, rect: BackRect, cuts: BackCut[],
): { normal: Vec3; vertices: Vec3[] } {
  // Önizleme dikdörtgeni (backPickRect) zaten giriş/setback'i içerir → parça uzantısı 0, düzlem rect.front üzerinden.
  const z: BackEdgeGaps = { uMin: 0, uMax: 0, vMin: 0, vMax: 0 };
  const piece: BackPiece = { placement: group.placement, setback: 0, inset: z, cover: {}, jointIn: {} };
  const plane = piecePlane(rect.front, group.side, group.placement, group.thickness);
  const m: BackMemberRect = { leafId: PREVIEW_ID, u0: rect.u0, u1: rect.u1, v0: rect.v0, v1: rect.v1, piece, front: rect.front, plane };
  const [mm] = applyBackCuts(group, [m], cuts);
  const g = backMemberVfGeometry(group, mm);
  return { normal: g.normal, vertices: g.vertices };
}
