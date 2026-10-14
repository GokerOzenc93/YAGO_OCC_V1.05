import {
  type BackAlign, type BackBoundRef, type BackBounds, type BackEdgeGaps, type BackEdgeRel, type BackGroup, type BackJointRef, type BackNode, type BackPick, type BackPlacement, type BackRect, type CavityBox, type GapSpec, type PanelGroup, type Shape, type VirtualFace,
  panelOfVf, requestRebuild, shapeById, useAppStore,
} from '../store';
import * as THREE from 'three';
import { type Vec3, genId, round1 } from './Geometry';
import { type Point2D, clipHalfPlane, clipPolyToConvex, frontHullOf, largestFaceNormal, panelFrontHull, panelHasRotation, polyArea } from './FaceRegion';
import { type GapMode, applyGapEditProportional, bodyLocalBox, cycleGapMode, gapMode, panelLocalBox, passiveGapIndex, rescaleGaps } from './PanelGroupService';
// DİKKAT: BackService ↔ PanelGroupService döngüsel içe aktarım (groupObstacles → backObstacleFor). Modül üst düzeyinde
// PanelGroupService bağlarını OKUMA; yalnız fonksiyon gövdesinde çağır.

// ARKALIK (BackService) — kapaktan (DoorService) BAĞIMSIZ servis: kendi tipleri, store dilimi, çözücüsü ve VF yazımı.
//  • Sınır = VF.backBound işaretli paneller; yoksa gövde kenarı. Düzlem = gövdenin ARKA yüzü (gövde-yerel ön = +Z → arka = Z−);
//    seçimde tıklama hangi yüzden gelirse gelsin arka yüze taşınır (rayBackEntry). u = X (sütun), v = Y (satır).
//  • Grup dikdörtgeni = İÇ dikdörtgen (sınır panellerinin iç yüzleri), front = sınır panellerinin ARKA yüzü (P). Ağaç bu alanı böler.
//  • HER PARÇA kendi tipini taşır (Goker, Eki 2026 — "tek bir parçayı nailed yapabileyim, kanal boşlukları ayrı ayrı"):
//    'outer' = arkadan ÇAKMA: P'nin dışında, kenarda sınır panelini bini kadar örter (full = kalınlık · half · none);
//    'inner' = KANALLI: P'den `setback` kadar içerde, kenarda panele `inset` kadar girer. Değerler yaprakta; yoksa grup varsayılanı.
//  • Bölme = AĞAÇ (BackGroup.tree); split alanını çocuklarına KATSAYI kuralıyla dağıtır, bölmek üst ölçüsünü değiştirmez.
//  • KENAR İLİŞKİSİ (Goker, Eki 2026 — "dikme veya gövde panelleriyle ilişkisini çakma / kanallı seçebileyim"): grup başına,
//    her sınır kenarı için `edgeRel`: 'groove' (varsayılan) → panel TAM BOY kalır, iç parça kanala `inset` kadar girer;
//    'nail' → iç parça önde olduğundan o kenarın paneli arkalığın ÖN yüzüne kadar OTOMATİK KISALTILIR ve parça ucunu `cover` kadar
//    örter (girilmemişse tamamen). Kısaltma: dikme/raf → hacim engeli (`backObstacleFor`), gövde paneli → arkalık parçası o paneli
//    sırası ne olursa olsun BASAR (`backNailStampFor`, PanelEngine.stamps). Çakma kenar derinlik (P) vermez — yoksa panel kısaldıkça
//    arkalık öne kaçardı. Gövdeyle kesilmez.
//  • SIRA (Goker, Eki 2026 — "arkalıklar da sıralamaya göre çalışsın"): arkalıktan SONRA konan panel (gövde paneli ya da raf/dikme
//    grubu; arkalığın kenarı / derzi değilse) arkalığa kadar yerleşir — iç parça levhasıyla basar / hacim engelidir. Önce konan
//    paneller kenar / derz / geçme kurallarına uyar.
//  • Dönmüş sınır paneli kenar olmaz; arkalığı büyük-yüz düzlemiyle keser (arkalık düzlemi değişmez).
//  • Arkalık-sınırı raf/dikme (Goker, Eki 2026): arkalığın GEÇTİĞİ (kenarı olmayan) kanallı levha KISALIR (levha arkalığın ön
//    yüzünde biter); KENARI olan levha kenar ilişkisine uyar (groove → kısalmaz: "dikme ve sağ yan arasına kanallı arkalık →
//    dikme gereksiz kısalıyordu"); Panel ref ile levhada BÖLÜNÜNCE parçalar levhanın ortasına kadar girer (iki yandan kanallı),
//    levha tam boy kalır ve derz levhayı izler (BackNode.refs, hep 'center'). Derzin de ilişkisi var (BackJointRef.rel — Goker, Eki 2026:
//    "dikme ve rafa göre split edildiğinde oraya da groove veya nailed koy"): groove → iki yandan kanal, levha tam boy; nail → levha
//    arkalığın ön yüzüne kadar KISALIR (hacim engeli), parçalar ucunu `jointIn` kadar örter. Full / Half / Left / Right binisi YOK.

export const BACK_THICKNESS = 8;
export const BACK_GAP = 0;
export const BACK_INSET = 10;      // kanallı: sınır panelinin içine giriş (mm)
export const BACK_SETBACK = 10;    // kanallı: panellerin arka yüzünden arkalığın arka yüzüne (mm)
export const BACK_AXIS = 2 as const;
export const BACK_SIDE = -1 as const;
export const BACK_TYPE_LABEL: Record<BackPlacement, string> = { outer: 'Nailed', inner: 'Grooved' };
export const BACK_TYPE_TITLE: Record<BackPlacement, string> = {
  outer: 'Nailed-on back — sits behind the reference panels, outside the body; covers their thickness by the overlap set per edge',
  inner: 'Grooved back — sits between the reference panels, set back from their rear face. Each edge is Groove (panel keeps its depth, the piece enters it by the groove depth) or Nail (the panel is shortened to the back panel\'s front face and the piece covers its end)',
};
export const BACK_REL_LABEL: Record<BackEdgeRel, string> = { groove: 'Groove', nail: 'Nail' };
/** Kanal bollaştırma varsayılanı (mm): parçanın önüne / arkasına ve kanal dibine (girişin ötesine). */
export const BACK_GROOVE_CLEAR = { front: 0.5, back: 0.5, depth: 1 } as const;
export type BackGrooveClear = { front: number; back: number; depth: number };
/** Etkin bollaştırma: vfId verilirse o kenarın (sınır / derz paneli) kendi değerleri, girilmeyen alanlar grup değeri. */
export const backGrooveClearOf = (g: Pick<BackGroup, 'grooveClear' | 'grooveClearBy'>, vfId?: string): BackGrooveClear => {
  const v = (x: number | undefined, d: number) => (Number.isFinite(x) && (x as number) >= 0 ? (x as number) : d);
  const base = { front: v(g.grooveClear?.front, BACK_GROOVE_CLEAR.front), back: v(g.grooveClear?.back, BACK_GROOVE_CLEAR.back), depth: v(g.grooveClear?.depth, BACK_GROOVE_CLEAR.depth) };
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

// Üyeyi dönmüş panellerin büyük-yüz düzlemleriyle kırpar; kesim arkalığın İKİ yüzeyinde alınır, kısıtlayıcı olan tutulur
// (arkalık eğik panele girmez). Kenar boşluğu = kesicinin kestiği kenarın boşluğu.
function clipMemberByCuts(
  m: { u0: number; u1: number; v0: number; v1: number }, cuts: BackCut[], axis: 0 | 1 | 2, side: 1 | -1,
  placement: BackPlacement, thickness: number, front: number, gapIn: number | BackEdgeGaps, cover?: Partial<BackEdgeGaps>, ref?: [number, number],
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
    // Çakma binme (mm, levha normali boyunca): girilmemişse levhanın tamamı.
    const cm = cover?.[ce.edge];
    const cov = coverFar ? (Number.isFinite(cm) ? Math.max(0, Math.min(c.dMax - c.dMin, cm as number)) : c.dMax - c.dMin) : 0;
    const before = poly;
    if (keepBelow) {
      const lim = c.dMin + cov - gap;
      const C = Math.min(...planes.map(pa => lim - Na * pa));
      poly = clipHalfPlane(poly, A, B, C);
    } else {
      const lim = c.dMax - cov + gap;
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
  const one = (x: EdgeInfo, k: BackEdgeKey) => ({ t: x.front == null ? 0 : Math.abs(x.outer - x.inner), covered: edgeCovered(x, side, P), rel: edgeRelOf(g, k), nail: nailActive.has(k) });
  return { uMin: one(e.l, 'uMin'), uMax: one(e.r, 'uMax'), vMin: one(e.b, 'vMin'), vMax: one(e.t, 'vMax') };
};
const noExt = (): BackEdgeExt => {
  const z = () => ({ t: 0, covered: false, rel: 'groove' as BackEdgeRel, nail: false });
  return { uMin: z(), uMax: z(), vMin: z(), vMax: z() };
};
const EDGE_KEYS: BackEdgeKey[] = ['uMin', 'uMax', 'vMin', 'vMax'];
/** Hücre iç dikdörtgenin o kenarına değiyor mu. */
export const cellTouchesEdge = (c: { u0: number; u1: number; v0: number; v1: number }, rect: BackRect, k: BackEdgeKey, tol = 0.05) =>
  (k === 'uMin' ? Math.abs(c.u0 - rect.u0) : k === 'uMax' ? Math.abs(c.u1 - rect.u1) : k === 'vMin' ? Math.abs(c.v0 - rect.v0) : Math.abs(c.v1 - rect.v1)) < tol;
/** ÇAKMA KENARLAR (etkin): ilişki 'nail', kenarda sınır paneli var ve kenara değen en az bir İÇ (kanallı) parça var. */
function activeNailEdges(g: Pick<BackGroup, 'edgeRel' | 'tree' | 'placement' | 'setback' | 'inset' | 'bounds' | 'gap'>, edges: BackEdges, rect: BackRect): Set<BackEdgeKey> {
  const out = new Set<BackEdgeKey>();
  const info: Record<BackEdgeKey, EdgeInfo> = { uMin: edges.l, uMax: edges.r, vMin: edges.b, vMax: edges.t };
  const cells = backCells(solveBackTree({ rect, tree: g.tree, gap: g.gap }, rect));
  for (const k of EDGE_KEYS) {
    if (edgeRelOf(g, k) !== 'nail' || info[k].front == null) continue;
    const inner = cells.some(c => cellTouchesEdge(c, rect, k) && backPieceOf(g, backLeafById(g.tree, c.leafId)).placement === 'inner');
    if (inner) out.add(k);
  }
  return out;
}
const backLeafById = (tree: BackNode, id: string): BackLeaf | null => { const n = findBackNode(tree, id); return n && n.kind === 'leaf' ? n : null; };
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
/** Seçme önizlemesi: adayın dikdörtgeni yeni grubun çözüleceği yere taşınır — kanallıda panel kenarları inset kadar genişler, düzlem setback kadar içerde. */
export function backPickRect(pick: BackPick, placement: BackPlacement): BackRect {
  const r = placement === 'inner' ? { ...pick.inner } : { ...pick.outer };
  if (placement !== 'inner') return r;
  const e = (k: BackEdgeKey) => (pick.bounds[k]?.vfId ? BACK_INSET : 0);
  return { u0: r.u0 - e('uMin'), u1: r.u1 + e('uMax'), v0: r.v0 - e('vMin'), v1: r.v1 + e('vMax'), front: r.front - pick.side * BACK_SETBACK };
}

/** PARÇA (yaprak) etkin değerleri: yaprak değeri, yoksa grup varsayılanı. inset yalnız panel kenarında (gövde kenarı 0). */
export interface BackPiece { placement: BackPlacement; setback: number; inset: BackEdgeGaps;
  /** Çakma: sınır paneline binme — yalnız GİRİLMİŞ değerler (mm); girilmeyen kenar paneli tamamen örter. */
  cover: Partial<BackEdgeGaps>;
  /** İç levhaya (dikme/raf) binme — yalnız GİRİLMİŞ değerler; girilmeyen kenar levhanın ortasına kadar (bkz. backJointSides). */
  jointIn: Partial<BackEdgeGaps> }
export type BackLeaf = Extract<BackNode, { kind: 'leaf' }>;
export function backPieceOf(g: Pick<BackGroup, 'placement' | 'setback' | 'inset' | 'bounds'>, leaf: BackLeaf | null | undefined): BackPiece {
  const placement = leaf?.placement ?? g.placement;
  const setback = Number.isFinite(leaf?.setback) && (leaf!.setback as number) >= 0 ? (leaf!.setback as number) : backSetbackOf(g);
  const gi = Number.isFinite(g.inset) && g.inset >= 0 ? g.inset : BACK_INSET;
  const ins = (k: BackEdgeKey) => (g.bounds[k]?.vfId ? (Number.isFinite(leaf?.inset?.[k]) ? Math.max(0, leaf!.inset![k] as number) : gi) : 0);
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
export interface BackMemberRect { u0: number; u1: number; v0: number; v1: number; leafId: string; piece: BackPiece; front: number; plane: number; poly?: Pt2[] }
export type BackNodeSolved =
  | (BackLeaf & { u0: number; u1: number; v0: number; v1: number; depth: number })
  | { id: string; kind: 'split'; axis: 'u' | 'v'; sizes: GapSpec[]; gaps: number[]; children: BackNodeSolved[]; targetSize?: number; refs?: Record<number, BackJointRef>; u0: number; u1: number; v0: number; v1: number; depth: number };
export interface BackSolution { rect: BackRect; tree: BackNode; solved: BackNodeSolved; members: BackMemberRect[]; bounds?: BackBounds; ext: BackEdgeExt; sides: BackJointSides }
/** `${splitId}:${k}` → bağlı derzin merkezi (bölmenin ekseninde). */
export type BackJointTargets = Map<string, number>;
const jointKey = (splitId: string, k: number) => `${splitId}:${k}`;
export type BackLayout = Pick<BackGroup, 'rect' | 'tree' | 'gap'>;

export const makeBackLeaf = (): BackNode => ({ id: genId('bl'), kind: 'leaf' });
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
  return solveNode(g.tree, rect.u0, rect.u1, rect.v0, rect.v1, g.gap, 0, targets);
}
export function solvedToBackTree(n: BackNodeSolved): BackNode {
  // Yaprak parça değerleri (tip / setback / inset / bini) çözümden geri yazılırken KORUNUR.
  if (n.kind === 'leaf') {
    const { u0: _u0, u1: _u1, v0: _v0, v1: _v1, depth: _d, ...leaf } = n;
    return leaf;
  }
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
export function backJointTargets(group: BackLayout & Pick<BackGroup, 'axis'>, parent: Shape, shapes: Shape[], faces = backJointFaces(group, parent, shapes)): BackJointTargets {
  const out: BackJointTargets = new Map();
  for (const [key, f] of faces) {
    const [splitId, ks] = [key.slice(0, key.lastIndexOf(':')), key.slice(key.lastIndexOf(':') + 1)];
    const node = findBackNode(group.tree, splitId);
    if (!node || node.kind !== 'split') continue;
    const g = splitGapsOf(node, group.gap)[+ks] ?? group.gap;
    out.set(key, f.align === 'center' ? (f.a0 + f.a1) / 2 : f.align === 'min' ? f.a1 + g / 2 : f.a0 - g / 2);
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
    n.children.forEach((c, i) => {
      const own: Partial<Record<BackEdgeKey, Raw>> = { ...inh };
      // Bölme ekseni boyunca dış kenarlar yalnız uçtaki çocuğa geçer.
      if (i > 0) delete own[hi];
      if (i < n.children.length - 1) delete own[lo];
      const before = i > 0 ? faces.get(jointKey(n.id, i - 1)) : undefined;
      const after = i < n.children.length - 1 ? faces.get(jointKey(n.id, i)) : undefined;
      if (before) own[hi] = { splitId: n.id, k: i - 1, vfId: before.vfId, a0: before.a0, a1: before.a1, t: before.a1 - before.a0, rel: before.rel };
      if (after) own[lo] = { splitId: n.id, k: i, vfId: after.vfId, a0: after.a0, a1: after.a1, t: after.a1 - after.a0, rel: after.rel };
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
export function placeBackPieces(g: Pick<BackGroup, 'placement' | 'setback' | 'inset' | 'bounds' | 'tree' | 'side' | 'thickness'>, cells: BackCell[], rect: BackRect, ext: BackEdgeExt, sides: BackJointSides = {}): BackMemberRect[] {
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
  // Derinlik: kayıtlı referans panelin arka yüzü (panel taşınınca izler); yoksa en gerideki sınır panelinin yüzü.
  const fronts = depthEdges.map(x => x.front).filter((x): x is number => x != null);
  const sgn = group.side;
  let P = !fronts.length ? bodyFront : (sgn > 0 ? Math.min(...fronts) : Math.max(...fronts));
  if (group.depthRef?.body) P = bodyFront;
  else if (group.depthRef?.vfId) {
    const hit = depthEdges.find(x => x.ref.vfId === group.depthRef!.vfId && x.front != null);
    if (hit) P = hit.front!;
    else if (!keyed.some(([k, x]) => nail.has(k) && x.ref.vfId === group.depthRef!.vfId)) console.warn('[YAGO][ARKALIK] derinlik referansı bulunamadı, varsayılan derinlik:', group.id, group.depthRef.vfId);
  }
  return { edges, P, bounds, nail };
}

export function solveBackGroup(group: BackGroup, parent: Shape, shapes: Shape[]): BackSolution | null {
  const s = solveBackEdges(group, parent, shapes);
  if (!s) return null;
  const { edges, P, bounds, nail } = s;
  const cutsAll = collectBackCuts(parent, shapes, undefined);
  // Grup dikdörtgeni = İÇ dikdörtgen; parça uzantıları (giriş / bini) hücre yerleşiminde eklenir.
  let rect: BackRect = backRectByCuts(group, rectAtDepth(edges, group.side, 'inner', P), cutsAll, group.anchor);
  if (rect.u1 - rect.u0 < MIN_BACK_SPAN || rect.v1 - rect.v0 < MIN_BACK_SPAN) {
    console.warn('[YAGO][ARKALIK] dikdörtgen bozuk/çok küçük, önceki korunuyor:', group.id, fmtBackRect(rect));
    rect = { ...group.rect };
  }
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
  if (!_solMemo || _solMemo.shapes !== st.shapes || _solMemo.vfs !== st.virtualFaces || _solMemo.groups !== st.backGroups) _solMemo = { shapes: st.shapes, vfs: st.virtualFaces, groups: st.backGroups, sols: new Map() };
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
  if (js?.uMin) u0 = js.uMin.rel === 'nail' ? js.uMin.a0 : js.uMin.a1; if (js?.uMax) u1 = js.uMax.rel === 'nail' ? js.uMax.a1 : js.uMax.a0;
  if (js?.vMin) v0 = js.vMin.rel === 'nail' ? js.vMin.a0 : js.vMin.a1; if (js?.vMax) v1 = js.vMax.rel === 'nail' ? js.vMax.a1 : js.vMax.a0;
  const { u, v } = backPlaneAxes(bg.axis);
  const z0 = Math.min(m.front, m.front - bg.side * bg.thickness), z1 = Math.max(m.front, m.front - bg.side * bg.thickness);
  const box: CavityBox = { min: [0, 0, 0], max: [0, 0, 0] };
  box.min[u] = Math.min(u0, u1); box.max[u] = Math.max(u0, u1);
  box.min[v] = Math.min(v0, v1); box.max[v] = Math.max(v0, v1);
  box.min[bg.axis] = z0; box.max[bg.axis] = z1;
  return box;
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
  let press = false, involved = false;
  for (const id of group.memberVfIds) {
    const edge = EDGE_KEYS.find(k => bounds[k]?.vfId === id);
    if (edge) { involved = true; if (sol.ext[edge].nail && cellTouchesEdge(cell, sol.rect, edge)) { press = true; break; } continue; }
    // Levhaya bağlı derz: yalnız ÇAKMA ilişkide (ve parça o derze değiyorsa) kısaltır; kanallıda iki yandan kanal, levha tam boy.
    if (joint.has(id)) { involved = true; if (Object.values(sol.sides[m.leafId] ?? {}).some(x => x?.vfId === id && x.rel === 'nail')) { press = true; break; } continue; }
    const mvf = vfs.find(f => f.id === id);
    if (!mvf || !vfBackBound(mvf)) continue;
    const p = parent ? panelOfVf(id, useAppStore.getState().shapes) : null;
    const box = p && parent ? panelLocalBox(p, parent) : null;
    if (!box) continue;
    const cu = (box.min[u] + box.max[u]) / 2, cv = (box.min[v] + box.max[v]) / 2;
    if (cu > cell.u0 - TOL && cu < cell.u1 + TOL && cv > cell.v0 - TOL && cv < cell.v1 + TOL) { press = true; break; }
  }
  if (press) return backPressBox(bg, sol, m);
  // SIRA (Goker, Eki 2026 — "arkalıklar da sıralamaya göre çalışsın; arkalık olan yere panel atınca arkalığa kadar yerleşsin"):
  // arkalıktan SONRA konan raf/dikme grubu (kenar / derz ilişkisi yoksa) parçanın levhasıyla sınırlanır → arkalığın ön yüzünde biter.
  if (!involved && backPrecedes(backPanel, group.memberVfIds, vfs)) return backPieceBox(bg, m);
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
  box.min[bg.axis] = Math.min(m.front, m.front - bg.side * bg.thickness); box.max[bg.axis] = Math.max(m.front, m.front - bg.side * bg.thickness);
  return box;
}

/** Yeni konacak raf/dikmenin hacim seçimi (sırada en sonda): iç arkalık parçası engeldir. */
export function backPickObstacle(backPanel: Shape): CavityBox | null {
  const hit = backMemberOfPanel(backPanel);
  return hit && hit.m.piece.placement === 'inner' ? backPieceBox(hit.bg, hit.m) : null;
}

/** Gövde paneli yüz seçimi önizlemesi (yeni panel sırada en sonda): iç arkalık parçası kutu damgası olarak kardeş listesine girer. */
export function backPreviewStamp(backPanel: Shape): Shape | null {
  const box = backPickObstacle(backPanel);
  if (!box) return null;
  const sz = [0, 1, 2].map(a => Math.max(0.01, box.max[a] - box.min[a]));
  const geo = new THREE.BoxGeometry(sz[0], sz[1], sz[2]).translate((box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2);
  const parent = shapeById((backPanel.parameters as any)?.parentShapeId);
  return { ...backPanel, geometry: geo, position: parent ? [...parent.position] : backPanel.position, rotation: parent ? [...parent.rotation] : backPanel.rotation, scale: parent ? [...parent.scale] : backPanel.scale } as Shape;
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
  // SIRA: arkalıktan SONRA konan gövde paneli (arkalığın kenarı / derzi değilse) parçanın levhasıyla basılır → arkalığa kadar yerleşir.
  if (!backFirst || backJointRefs(bg.tree).some(r => r.ref.vfId === vfId)) return null;
  return backPieceBox(bg, m);
}

/** Levhaya bağlı derzin ilişkisi (yoksa 'groove'). */
export const backJointRelOf = (tree: BackNode, splitId: string, k: number): BackEdgeRel => {
  const n = findBackNode(tree, splitId);
  return (n && n.kind === 'split' ? n.refs?.[k]?.rel : undefined) ?? 'groove';
};
/** Bağlı derz ilişkisi: 'groove' → iki yandan kanal, dikme/raf tam boy; 'nail' → dikme/raf arkalığın ön yüzüne kadar kısalır. */
export async function setBackJointRel(groupId: string, splitId: string, k: number, rel: BackEdgeRel): Promise<void> {
  const group = groupById(groupId);
  const node = group ? findBackNode(group.tree, splitId) : null;
  if (!group || !node || node.kind !== 'split' || !node.refs?.[k] || (node.refs[k].rel ?? 'groove') === rel) return;
  const ref = { ...node.refs[k] };
  if (rel === 'groove') delete ref.rel; else ref.rel = rel;
  await writeBackGroup(group, { tree: replaceBackNode(group.tree, splitId, old => ({ ...(old as any), refs: { ...(old as any).refs, [k]: ref } })) });
}

// KANAL KESİCİLERİ (PanelEngine.buildPanel): kanallı (groove) ilişkideki sınır paneline / bağlı derz levhasına iç parçanın KANALI
// katıdan çıkarılır — kutu: kenar ekseninde panelin iç yüzünden `inset + depth` kadar içeri (dışa 5 mm taşar: çakışık yüz olmasın),
// çapraz eksende parçanın açıklığı, derinlikte [parça arkası − back, parça önü + front]. Yalnız GÖRÜNÜM/katı içindir: ayak izi,
// damga ve hacim ızgarası kanalsız geometriyi okur (Shape.ungroovedGeometry) → kanal boşluğuna hiçbir panel sızmaz.
const GROOVE_MOUTH = 5;
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
      const zlo = Math.min(rear, frontF) - (bg.side < 0 ? clear.back : clear.front), zhi = Math.max(rear, frontF) + (bg.side < 0 ? clear.front : clear.back);
      const push = (a: 0 | 1 | 2, a0: number, a1: number, c: 0 | 1 | 2, c0: number, c1: number) => {
        const box: CavityBox = { min: [0, 0, 0], max: [0, 0, 0] };
        box.min[a] = Math.min(a0, a1); box.max[a] = Math.max(a0, a1);
        box.min[c] = Math.min(c0, c1); box.max[c] = Math.max(c0, c1);
        box.min[bg.axis] = zlo; box.max[bg.axis] = zhi;
        out.push(box);
      };
      // Grup kenarı: kanallı ilişki, parça kenara değiyor, giriş > 0.
      if (edge && sol.ext[edge].rel === 'groove' && !sol.ext[edge].nail && cellTouchesEdge(cell, sol.rect, edge)) {
        const ins = m.piece.inset[edge];
        if (ins > 0) {
          const isU = edge === 'uMin' || edge === 'uMax', minSide = edge === 'uMin' || edge === 'vMin';
          const face = isU ? (minSide ? sol.rect.u0 : sol.rect.u1) : (minSide ? sol.rect.v0 : sol.rect.v1);   // panelin iç yüzü
          const deep = face + (minSide ? -1 : 1) * (ins + clear.depth), mouth = face + (minSide ? 1 : -1) * GROOVE_MOUTH;
          if (isU) push(u, deep, mouth, v, m.v0, m.v1); else push(v, deep, mouth, u, m.u0, m.u1);
        }
      }
      // Bağlı derz (dikme/raf): kanallı ilişkide parça levhanın yüzünden `in` kadar girer.
      const js = sol.sides[m.leafId];
      if (js) for (const [k, side] of Object.entries(js) as Array<[BackEdgeKey, BackJointSide]>) {
        if (side.vfId !== vfId || side.rel !== 'groove' || !(side.in > 0)) continue;
        const isU = k === 'uMin' || k === 'uMax', minSide = k === 'uMin' || k === 'vMin';
        const face = minSide ? side.a1 : side.a0;   // parçaya bakan levha yüzü
        const deep = face + (minSide ? -1 : 1) * (side.in + clear.depth), mouth = face + (minSide ? 1 : -1) * GROOVE_MOUTH;
        if (isU) push(u, deep, mouth, v, m.v0, m.v1); else push(v, deep, mouth, u, m.u0, m.u1);
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
  const changed = keys.filter(k => { const v = patch[k]; return Number.isFinite(v) && (v as number) >= 0 && Math.abs(round1(v as number) - cur[k]) >= 0.05; });
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
    const gaps: BackEdgeGaps = placement === 'inner' ? { uMin: -inset.uMin, uMax: -inset.uMax, vMin: -inset.vMin, vMax: -inset.vMax } : { uMin: 0, uMax: 0, vMin: 0, vMax: 0 };
    const poly = clipMemberByCuts(m, cuts, group.axis, group.side, placement, group.thickness, m.front, gaps, placement === 'outer' ? cover : undefined, group.anchor);
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
export function backRectByCuts(group: Pick<BackGroup, 'axis' | 'side' | 'placement' | 'thickness' | 'gap'>, rect: BackRect, cuts: BackCut[], anchor?: [number, number]): BackRect {
  if (!anchor || !cuts.length) return rect;
  // Boşluksuz, grup varsayılan tipiyle kırpılır (parça uzantıları hücre yerleşiminde).
  const poly = clipMemberByCuts(rect, cuts, group.axis, group.side, group.placement, group.thickness, rect.front, 0, undefined, anchor);
  if (!poly || poly.length < 3) return rect;
  const xs = poly.map(q => q.x), ys = poly.map(q => q.y);
  const out: BackRect = { u0: Math.min(...xs), u1: Math.max(...xs), v0: Math.min(...ys), v1: Math.max(...ys), front: rect.front };
  if (out.u1 - out.u0 < MIN_BACK_SPAN || out.v1 - out.v0 < MIN_BACK_SPAN) return rect;
  return out;
}

/** Bölge dikdörtgeninin açılı panellerle kırpılmış şekli (kesici yüzünde; grup varsayılan tipiyle). */
export function backCutOutline(group: CutGroup & Pick<BackGroup, 'placement'>, rect: BackRect, r: { u0: number; u1: number; v0: number; v1: number }, cuts: BackCut[]): Pt2[] {
  const base: Pt2[] = [{ x: r.u0, y: r.v0 }, { x: r.u1, y: r.v0 }, { x: r.u1, y: r.v1 }, { x: r.u0, y: r.v1 }];
  if (!cuts.length) return base;
  return clipMemberByCuts(r, cuts, group.axis, group.side, group.placement, group.thickness, rect.front, 0, undefined, group.anchor) ?? base;
}

// VF düzlemi = parçanın DIŞ yüzü (m.plane); createPanelFromVirtualFace −normal yönünde t uzar.
function backMemberVfGeometry(group: Pick<BackGroup, 'axis' | 'side'>, m: BackMemberRect): { normal: Vec3; vertices: Vec3[]; center: Vec3 } {
  const { u, v } = backPlaneAxes(group.axis);
  const plane = m.plane;
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
  ref?: { splitId: string; k: number };
  poly?: Pt2[];
}

// Şemada gösterilecek sınır levhaları (çakmada bini, kanallıda kenar şeritleri kanal girişini taşır). allPanels=true → işaretsizler de.
export function backNearPanels(group: BackGroup, parent: Shape, shapes: Shape[], vfs: VirtualFace[], panelGroups: PanelGroup[], allPanels = false): BackNearPanel[] {
  const { u, v } = backPlaneAxes(group.axis);
  const solved = solveBackTree(group);
  const ms = backCells(solved);
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
      if (bound) { ref = { splitId: bound.splitId, k: bound.k }; joint = joints.find(j => j.splitId === bound.splitId && j.k === bound.k); }
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

/** Gövde yokken (ya da şema için parent'sız): hücreler kenar bilgisi olmadan yerleştirilir (giriş/bini yok). */
export const backFallbackSolution = (group: BackGroup): BackSolution => {
  const solved = solveBackTree(group);
  const ext = noExt();
  return { rect: group.rect, tree: solvedToBackTree(solved), solved, members: placeBackPieces(group, backCells(solved), group.rect, ext), ext, sides: {} };
};
const fallbackSolution = backFallbackSolution;

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
  const rect = { ...pick.inner };   // grup dikdörtgeni = iç dikdörtgen; tip/uzantılar parça başına
  const group: BackGroup = {
    id: genId('back'), shapeId, setback: BACK_SETBACK, inset: BACK_INSET, axis: pick.axis, side: pick.side, placement, bounds: pick.bounds, depthRef: pick.depth, rect, anchor: pick.at,
    tree: makeBackLeaf(),
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
    // Bağlı derzde boşluk YOK: hücreler levhanın ortasında buluşur, parça kenarları levha yüzünden binme (jointIn) ile ölçülür.
    const split: BackNode = { id: genId('bs'), kind: 'split', axis, sizes: [], gaps: [0], refs: { 0: { vfId, align: 'center' } }, children: [makeBackLeaf(), makeBackLeaf()] };
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
  if (sn.refs?.[k]) { console.warn('[YAGO][ARKALIK-BAĞ] levhaya bağlı derzde boşluk girilmez — parçaların binme payı (jointIn) kullanılır:', splitId, k); return; }
  const gaps = sn.gaps.slice(); gaps[k] = round1(value);
  const tree = replaceBackNode(group.tree, splitId, old => ({ ...(old as any), gaps }));
  await writeBackGroup(group, { tree }, !!opts.preview);
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
  if (opts.preview && leavesOf(group, leafIds).every(l => Math.abs(backPieceOf(group, l).inset[edge] - v) < 0.05)) return;   // onay hep yazar
  await writeBackGroup(group, { tree: patchLeaves(group.tree, leafIds, l => ({ ...l, inset: { ...(l.inset ?? {}), [edge]: v } })) }, !!opts.preview);
}
/** İÇ LEVHAYA BİNME: parça(lar)ın levhaya bağlı derzdeki `edge` kenarında dikme/rafın üzerine binme payı (mm). Parça başına yazılır;
 *  0..levha kalınlığı, karşı yandaki parçaların binmesiyle ÇAKIŞMAYACAK kadar kırpılır. Yalnız o kenarı bağlı derzde olan parçalara yazar. */
export async function setBackJointIn(groupId: string, edge: BackEdgeKey, mm: number, leafIds: string[], opts: BackEditOpts = {}): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(mm) || mm < 0) return;
  const sol = solveFromStore(group);
  if (!sol) return;
  const opp: Record<BackEdgeKey, BackEdgeKey> = { uMin: 'uMax', uMax: 'uMin', vMin: 'vMax', vMax: 'vMin' };
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
      const isU = edge === 'uMin' || edge === 'uMax';
      if (me && om && Math.min(isU ? me.v1 : me.u1, isU ? om.v1 : om.u1) - Math.max(isU ? me.v0 : me.u0, isU ? om.v0 : om.u0) <= TOL) continue;
      other = Math.max(other, o.in);
    }
    const max = Math.max(0, js.t - other);
    if (mm > max + 0.05) console.warn('[YAGO][ARKALIK-BAĞ] binme payı kırpıldı (levha kalınlığı / karşı parça):', id, edge, mm, '→', round1(max));
    vals.set(id, round1(Math.min(mm, max)));
  }
  if (!vals.size) return;
  if (opts.preview && [...vals].every(([id, v]) => Math.abs((sol.sides[id]?.[edge]?.in ?? -1) - v) < 0.05)) return;   // onay hep yazar
  await writeBackGroup(group, { tree: patchLeaves(group.tree, [...vals.keys()], l => ({ ...l, jointIn: { ...(l.jointIn ?? {}), [edge]: vals.get(l.id)! } })) }, !!opts.preview);
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
function equalizeTree(n: BackNode): BackNode {
  if (n.kind === 'leaf') return n;
  return { ...n, sizes: [], children: n.children.map(equalizeTree) };
}
export async function equalizeBackGroup(groupId: string): Promise<void> {
  const group = groupById(groupId);
  if (!group) return;
  await writeBackGroup(group, { tree: equalizeTree(group.tree) });
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
/** Çakma parça(lar): `edge` kenarındaki sınır panelinin üzerine binme (mm). 0 = panelin iç yüzünde biter, panel kalınlığı = tamamen örter;
 *  kalınlıkla kırpılır (açılı sınır levhasında levha kalınlığıyla). leafIds boş → tüm parçalar. */
export async function setBackEdgeCover(groupId: string, edge: BackEdgeKey, mm: number, leafIds: string[] = [], opts: BackEditOpts = {}): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(mm) || mm < 0) return;
  const sol = solveFromStore(group);
  const st = useAppStore.getState(), parent = shapeById(group.shapeId, st.shapes);
  // En büyük binme: kenar panelinin kalınlığı; açılı kesim kenarındaysa kesen levhaların en kalını.
  let t = sol?.ext[edge]?.t ?? 0;
  if (parent) for (const c of collectBackCuts(parent, st.shapes, st.virtualFaces)) {
    const { u, v } = backPlaneAxes(group.axis);
    const cu = group.anchor ? group.anchor[0] : (group.rect.u0 + group.rect.u1) / 2, cv = group.anchor ? group.anchor[1] : (group.rect.v0 + group.rect.v1) / 2;
    if (Math.hypot(c.n[u], c.n[v]) > 1e-6 && cutEdgeOf(c, cu, cv, group.axis, group.rect.front)?.edge === edge) t = Math.max(t, c.dMax - c.dMin);
  }
  const v = round1(t > 0 ? Math.min(mm, t) : mm);
  if (t > 0 && mm > t + 0.05) console.warn('[YAGO][ARKALIK] binme panel kalınlığıyla kırpıldı:', edge, mm, '→', v);
  if (opts.preview && leavesOf(group, leafIds).every(l => Math.abs((backPieceOf(group, l).cover[edge] ?? t) - v) < 0.05)) return;   // onay hep yazar
  await writeBackGroup(group, { tree: patchLeaves(group.tree, leafIds, l => ({ ...l, cover: { ...(l.cover ?? {}), [edge]: v } })) }, !!opts.preview);
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
      return ka.length === kb.length && ka.every(k => b?.[+k]?.vfId === a?.[+k]?.vfId && b?.[+k]?.align === a?.[+k]?.align && (b?.[+k]?.rel ?? 'groove') === (a?.[+k]?.rel ?? 'groove'));
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
  // Önizleme dikdörtgeni (backPickRect) zaten giriş/setback'i içerir → parça uzantısı 0, düzlem rect.front üzerinden.
  const z: BackEdgeGaps = { uMin: 0, uMax: 0, vMin: 0, vMax: 0 };
  const piece: BackPiece = { placement: group.placement, setback: 0, inset: z, cover: {}, jointIn: {} };
  const m: BackMemberRect = { leafId: PREVIEW_ID, u0: rect.u0, u1: rect.u1, v0: rect.v0, v1: rect.v1, piece, front: rect.front, plane: piecePlane(rect.front, group.side, group.placement, group.thickness) };
  const [mm] = applyBackCuts(group, [m], cuts);
  const g = backMemberVfGeometry(group, mm);
  return { normal: g.normal, vertices: g.vertices };
}
