import {
  type CavityBox, type DoorBoundRef, type DoorBounds, type DoorGroup, type DoorPick, type DoorRect, type GapSpec, type Shape, type VirtualFace,
  panelOfVf, requestRebuild, shapeById, useAppStore,
} from '../store';
import { type Vec3, genId, round1 } from './Geometry';
import { panelHasRotation } from './FaceRegion';
import { applyGapEdit, bodyLocalBox, equalGaps, panelLocalBox, redistributeForThickness } from './PanelGroupService';

// ═══════════════════════════════════════════════════════════════════════════
// KAPAKLAR (DoorService) — Goker, Eki 2026
//
// İSTEK: "Kapak yerleştirmek istiyorum. Dikme, raf ve gövde panellerine KAPAK SINIRI
// işareti koyayım. Kapak sınırını işaretledikten sonra, hacim seçimi gibi, fareyle
// tıkladığım yerde kapak sınırı nerelerde varsa büyükten küçüğe alternatifleri bir
// panel gibi highlight ederek döngüyle göstersin. Bir sınır paneli diğerlerine göre
// içerdeyse önce dışarıdaki seçenekleri, sonra içerdeki paneli referans alanı
// göstersin. Dış kapak / iç kapak: içerlek olunca panellerin İÇLERİNE, dıştan olunca
// panel kalınlıklarının DIŞINDAN çalışsın; kapaklar referans hacmin dışında olabilir.
// Kapağı atadıktan sonra dikeyde böl / yatayda böl; raf-dikmedeki kilit ve ara ölçü
// girme aynen; iki kapak arasındaki boşluk da önizlemede girilsin."
//
// SÖZLEŞME
//  • Kapak SINIRI = VF.doorBound işaretli paneller (gövde paneli, raf üyesi, dikme üyesi).
//    Gövde kutusunun kenarı her yönde SON çare sınırdır (sınır paneli işaretlenmemişse).
//  • Kapak DÜZLEMİ = tıklanan gövde yüzü: eksen (axis) + yön (side). Düzlemdeki eksenler:
//    u = yatay dizilim (sütunlar), v = düşey dizilim (satırlar) — doorPlaneAxes.
//  • ADAYLAR (doorCandidatesAt): tıklanan (u,v) noktasının dört yanındaki sınır
//    panellerinin her kombinasyonu bir dikdörtgen verir (sol × sağ × alt × üst); seçilen
//    panel dikdörtgenin çapraz açıklığıyla örtüşmelidir (kısa dikme yalnız kendi boyundaki
//    kapağı sınırlar). Alan büyükten küçüğe → "önce dışarıdaki, sonra içerdeki".
//  • İÇ / DIŞ: iç kapak sınır panellerinin İÇ yüzleri arasına (u: sol panel max → sağ
//    panel min), önü panellerin ön yüzüyle hizalı (en içerdeki panel esas); dış kapak
//    panellerin DIŞ yüzlerine kadar (kalınlıkların dışından) ve panellerin önüne (en
//    öndeki panel esas) yerleşir — gövde kutusunun dışında kalabilir.
//  • BOŞLUK: her kenar (sınır paneline) ve her kapak arası AYRI boşluktur (colGaps / rowGaps).
//  • BÖLME: cols × rows kapak; sütun genişlikleri / satır yükseklikleri raf boşluğu
//    kuralıyla (equalGaps / applyGapEdit / rescaleGaps — kilit + girilen korunur,
//    gerisi eşit); kapaklar arası boşluk (gap) sabit "kalınlık" gibi düşülür.
//  • Üye kapaklar sıradan VF-panelleridir (interior=true, doorGroupId): extrude /
//    move / rotate adımları motorda aynı yoldan uygulanır; VF her rebuild'de buradan
//    yazılır (recalculateDoorVfs). Kapak panelleri gövde panellerini DAMGALAMAZ, hacim
//    engeli DEĞİLDİR, gövdeyle kesilmez (PanelEngine / PanelGroupService isDoorPanel).
// ═══════════════════════════════════════════════════════════════════════════

export const DOOR_THICKNESS = 18;
export const DOOR_GAP = 3;
const TOL = 0.5;
const MIN_DOOR_SPAN = 40;
const MAX_DOOR_SPLIT = 12;

export const isDoorPanel = (p: any): boolean => !!p?.parameters?.doorGroupId;
export const isDoorVf = (vf: any): boolean => !!vf?.doorGroupId;
export const doorGroupName = (g: Pick<DoorGroup, 'name'>) => g.name ?? 'Door';
export const doorPlacementLabel = (p: DoorGroup['placement']) => (p === 'inner' ? 'Inner' : 'Outer');

/** Kapak düzleminin eksenleri: u = yatay (sütun dizilimi), v = düşey (satır dizilimi). */
export function doorPlaneAxes(axis: 0 | 1 | 2): { u: 0 | 1 | 2; v: 0 | 1 | 2 } {
  if (axis === 2) return { u: 0, v: 1 };
  if (axis === 0) return { u: 2, v: 1 };
  return { u: 0, v: 2 };
}

export const fmtRect = (r: DoorRect) => `u ${r.u0.toFixed(0)}..${r.u1.toFixed(0)} v ${r.v0.toFixed(0)}..${r.v1.toFixed(0)} ön=${r.front.toFixed(0)}`;
const rectKey = (r: DoorRect) => [r.u0, r.u1, r.v0, r.v1].map(n => Math.round(n)).join('|');

/**
 * Işının gövde kutusuna girdiği yüz + giriş noktası (eksen, yön = yüz normali dışa:
 * max yüzden giriş → +1, min yüzden → −1). Kamera kutunun içindeyse null.
 */
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

// ── SINIR PANELLERİ ─────────────────────────────────────────────────────────

export interface DoorBoundPanel { vfId: string; panelId: string; box: CavityBox; name: string }

/** Gövdenin KAPAK SINIRI işaretli panelleri (gövde-yerel kutularıyla); kapaklar ve dönmüş paneller hariç. */
export function collectDoorBoundPanels(parent: Shape, shapes: Shape[] = useAppStore.getState().shapes, vfs: VirtualFace[] = useAppStore.getState().virtualFaces): DoorBoundPanel[] {
  const out: DoorBoundPanel[] = [];
  for (const vf of vfs) {
    if (vf.shapeId !== parent.id || !vf.doorBound || isDoorVf(vf)) continue;
    const p = panelOfVf(vf.id, shapes);
    if (!p || panelHasRotation(p)) continue;
    const box = panelLocalBox(p, parent);
    if (!box) continue;
    out.push({ vfId: vf.id, panelId: p.id, box, name: vf.description || 'Panel' });
  }
  return out;
}

/** VF'nin kapak sınırı işaretini yazar (geometri değişmez → rebuild yok; yalnız yeni seçimleri etkiler). */
export function setVfDoorBound(vfId: string, on: boolean): void {
  const st = useAppStore.getState();
  const vf = st.virtualFaces.find(f => f.id === vfId);
  if (!vf || !!vf.doorBound === on) return;
  st.updateVirtualFace(vfId, { doorBound: on });
  console.log('[YAGO][KAPAK-SINIR]', vfId, on ? 'İŞARETLENDİ' : 'kaldırıldı');
}

// ── ADAYLAR ─────────────────────────────────────────────────────────────────

type SideOpt = { ref: DoorBoundRef; inner: number; outer: number; cross: [number, number]; front: number | null; name: string };

/**
 * KAPAK ADAYLARI (Goker: "tıkladığım yerde kapak sınırı nerelerde varsa büyükten küçüğe
 * alternatifleri göstersin; içerdeki panel varsa önce dışarıdakiler, sonra içerdeki").
 * Dört yanda seçenek = tıklanan noktanın o tarafında kalan sınır panelleri + gövde kenarı.
 * Her kombinasyon bir dikdörtgen; seçilen panel dikdörtgenin çapraz açıklığıyla örtüşmeli.
 */
export function doorCandidatesAt(parent: Shape, axis: 0 | 1 | 2, side: 1 | -1, click: Vec3, shapes?: Shape[], vfs?: VirtualFace[]): DoorPick[] {
  const body = bodyLocalBox(parent);
  if (!body) return [];
  const { u, v } = doorPlaneAxes(axis);
  const bounds = collectDoorBoundPanels(parent, shapes, vfs);
  const cu = click[u], cv = click[v];
  const frontOf = (b: CavityBox) => (side > 0 ? b.max[axis] : b.min[axis]);
  const bodyOpt = (edge: number, cross: [number, number]): SideOpt => ({ ref: { body: true }, inner: edge, outer: edge, cross, front: null, name: 'Body' });
  // Bir yanda seçenekler = tıklanan noktanın o tarafında kalan sınır panelleri (dıştan içe birden çok olabilir:
  // yan panel + dikme → "önce dışarıdaki, sonra içerdeki"); o yanda hiç sınır paneli yoksa gövde kenarı.
  // Gövde kenarı ile paneller karıştırılmaz (sol gövde / sağ dikme gibi karışık kombinasyonlar aday listesini şişiriyordu).
  const optsFor = (ax: 0 | 1 | 2, cx: 0 | 1 | 2, c: number, minSide: boolean): SideOpt[] => {
    const out: SideOpt[] = [];
    for (const bp of bounds) {
      const b = bp.box;
      // Panel tıklanan noktanın bu tarafında mı (dizilim ekseninde)?
      const onSide = minSide ? b.max[ax] <= c + TOL : b.min[ax] >= c - TOL;
      if (!onSide) continue;
      out.push({ ref: { vfId: bp.vfId }, inner: minSide ? b.max[ax] : b.min[ax], outer: minSide ? b.min[ax] : b.max[ax], cross: [b.min[cx], b.max[cx]], front: frontOf(b), name: bp.name });
    }
    if (!out.length) out.push(minSide ? bodyOpt(body.min[ax], [body.min[cx], body.max[cx]]) : bodyOpt(body.max[ax], [body.min[cx], body.max[cx]]));
    return out;
  };
  const L = optsFor(u, v, cu, true), R = optsFor(u, v, cu, false), B = optsFor(v, u, cv, true), T = optsFor(v, u, cv, false);
  const overlaps = (cross: [number, number], a0: number, a1: number) => Math.min(cross[1], a1) - Math.max(cross[0], a0) > TOL;
  const seen = new Set<string>();
  const out: DoorPick[] = [];
  for (const l of L) for (const r of R) for (const b of B) for (const t of T) {
    const inner: DoorRect = { u0: l.inner, u1: r.inner, v0: b.inner, v1: t.inner, front: 0 };
    if (inner.u1 - inner.u0 < MIN_DOOR_SPAN || inner.v1 - inner.v0 < MIN_DOOR_SPAN) continue;
    // Seçilen panel, dikdörtgenin çapraz açıklığında olmalı (kısa dikme üstündeki kapağı sınırlamaz).
    if (!overlaps(l.cross, inner.v0, inner.v1) || !overlaps(r.cross, inner.v0, inner.v1)) continue;
    if (!overlaps(b.cross, inner.u0, inner.u1) || !overlaps(t.cross, inner.u0, inner.u1)) continue;
    const key = rectKey(inner);
    if (seen.has(key)) continue;
    seen.add(key);
    // ÖN: dış kapak en ÖNDEKİ sınır panelinin önüne, iç kapak en İÇERDEKİ sınır panelinin önüyle hizalı; sınır paneli yoksa gövde yüzü.
    const fronts = [l, r, b, t].map(o => o.front).filter((x): x is number => x != null);
    const bodyFront = side > 0 ? body.max[axis] : body.min[axis];
    const outerFront = fronts.length ? (side > 0 ? Math.max(...fronts) : Math.min(...fronts)) : bodyFront;
    const innerFront = fronts.length ? (side > 0 ? Math.min(...fronts) : Math.max(...fronts)) : bodyFront;
    inner.front = innerFront;
    const outer: DoorRect = { u0: l.outer, u1: r.outer, v0: b.outer, v1: t.outer, front: outerFront };
    const boundsRef: DoorBounds = { uMin: l.ref, uMax: r.ref, vMin: b.ref, vMax: t.ref };
    out.push({ key: `${axis}${side > 0 ? '+' : '-'}:${key}`, axis, side, bounds: boundsRef, inner, outer, area: (inner.u1 - inner.u0) * (inner.v1 - inner.v0), boundPanelCount: fronts.length });
  }
  out.sort((a, b) => b.area - a.area || a.boundPanelCount - b.boundPanelCount);
  if (out.length) console.log('[YAGO][KAPAK] adaylar:', out.length, 'düzlem=', `${'XYZ'[axis]}${side > 0 ? '+' : '−'}`, 'sınırPanelN=', bounds.length, out.map(c => `${Math.round(c.inner.u1 - c.inner.u0)}x${Math.round(c.inner.v1 - c.inner.v0)}`).join(' > '));
  return out;
}

// ── ÇÖZÜM ───────────────────────────────────────────────────────────────────

export interface DoorMemberRect { r: number; c: number; u0: number; u1: number; v0: number; v1: number }
export interface DoorSolution { rect: DoorRect; colWidths: GapSpec[]; rowHeights: GapSpec[]; members: DoorMemberRect[] }

/**
 * KAPAK BOŞLUKLARI — HER BİRİ AYRI (Goker, Eki 2026: "kenar boşluğu, her boşluk farklı farklı girilebilmeli";
 * önce: "kapağın panelle olan mesafelerinde de kapak boşluğu olmalı — üst, alt, sağ, sol").
 * Eksen başına n+1 boşluk: [başlangıç kenarı, n−1 ara, bitiş kenarı]. u: sol → sağ; v: ÜST → alt.
 * Kayıtlı dizi yoksa / boyu tutmuyorsa varsayılan `gap` ile doldurulur; bölmede kenarlar korunur.
 */
export function gapsOf(saved: number[] | undefined, n: number, gap: number): number[] {
  if (Array.isArray(saved) && saved.length === n + 1 && saved.every(v => Number.isFinite(v) && v >= 0)) return saved.slice();
  const out = Array.from({ length: n + 1 }, () => gap);
  if (Array.isArray(saved) && saved.length >= 2) { out[0] = saved[0]; out[n] = saved[saved.length - 1]; }   // kenarlar korunur
  return out;
}
export const colGapsOf = (g: Pick<DoorGroup, 'colGaps' | 'cols' | 'gap'>) => gapsOf(g.colGaps, g.cols, g.gap);
export const rowGapsOf = (g: Pick<DoorGroup, 'rowGaps' | 'rows' | 'gap'>) => gapsOf(g.rowGaps, g.rows, g.gap);
/** Eksendeki kapak alanı: dikdörtgen − iki kenar boşluğu (aralar ayrıca `inner` olarak düşülür). */
const doorSpan = (rect: DoorRect, axis: 'u' | 'v', gaps: number[]) => (axis === 'u' ? rect.u1 - rect.u0 : rect.v1 - rect.v0) - gaps[0] - gaps[gaps.length - 1];
const innerGaps = (gaps: number[]) => gaps.slice(1, -1);
/**
 * DAĞITIM KURALI (Goker: "girilen boşluk kapağı kısaltmamalı; boşluktan kalan ölçüyü her zaman ilk
 * başta EŞİT dağıt"): kilitli ve elle girilmiş kapak ölçüleri korunur; boşluklardan kalan ölçü diğer
 * kapaklara EŞİT dağılır (boşluk değişse de, iç/dış değişse de, gövde boyutlansa da). Hepsi girilmişse oransal.
 */
function distributeDoors(specs: GapSpec[], rect: DoorRect, axis: 'u' | 'v', gaps: number[]): GapSpec[] {
  const n = gaps.length - 1;
  const L = doorSpan(rect, axis, gaps), mids = innerGaps(gaps);
  const out = redistributeForThickness(specs, L, n - 1, mids);
  // 0,1 mm yuvarlama artığı son serbest kapağa yazılır → kenar boşluğu tam girilen değer kalır.
  const resid = round1(L - mids.reduce((a, g) => a + g, 0) - out.reduce((a, g) => a + g.value, 0));
  if (Math.abs(resid) >= 0.05 && Math.abs(resid) < 1) {
    for (let i = out.length - 1; i >= 0; i--) if (!out[i].locked && !out[i].edited) { out[i] = { ...out[i], value: round1(out[i].value + resid) }; break; }
  }
  return out;
}
const equalDoors = (rect: DoorRect, axis: 'u' | 'v', gaps: number[]) => equalGaps(doorSpan(rect, axis, gaps), gaps.length - 2, innerGaps(gaps));

/** Kapak dikdörtgeninden üye dikdörtgenleri: sütunlar soldan sağa (u↑), satırlar ÜSTTEN aşağı (v↓); her boşluk kendi değeriyle. */
export function doorMemberRects(rect: DoorRect, cols: number, rows: number, colWidths: GapSpec[], rowHeights: GapSpec[], colGaps: number[], rowGaps: number[]): DoorMemberRect[] {
  const out: DoorMemberRect[] = [];
  let top = rect.v1 - (rowGaps[0] ?? 0);
  for (let r = 0; r < rows; r++) {
    const h = rowHeights[r]?.value ?? 0;
    let left = rect.u0 + (colGaps[0] ?? 0);
    for (let c = 0; c < cols; c++) {
      const w = colWidths[c]?.value ?? 0;
      out.push({ r, c, u0: left, u1: left + w, v0: top - h, v1: top });
      left += w + (colGaps[c + 1] ?? 0);
    }
    top -= h + (rowGaps[r + 1] ?? 0);
  }
  return out;
}

/** Sınır referansının kenarı: panel kutusu (VF → panel) ya da gövde kenarı; panel yoksa gövde. */
function boundEdge(ref: DoorBoundRef, parent: Shape, shapes: Shape[], body: CavityBox, ax: 0 | 1 | 2, minSide: boolean, placement: DoorGroup['placement']): { edge: number; box: CavityBox | null } {
  if (ref.vfId) {
    const p = panelOfVf(ref.vfId, shapes);
    const box = p && (p.parameters as any)?.parentShapeId === parent.id ? panelLocalBox(p, parent) : null;
    if (box) {
      const inner = minSide ? box.max[ax] : box.min[ax];
      const outer = minSide ? box.min[ax] : box.max[ax];
      return { edge: placement === 'inner' ? inner : outer, box };
    }
    console.warn('[YAGO][KAPAK] sınır paneli bulunamadı, gövde kenarı kullanıldı:', ref.vfId);
  }
  return { edge: minSide ? body.min[ax] : body.max[ax], box: null };
}

/** Grubu güncel gövde + sınır panelleriyle çözer (saf). Dikdörtgen bozuksa önceki korunur. */
export function solveDoorGroup(group: DoorGroup, parent: Shape, shapes: Shape[]): DoorSolution | null {
  const body = bodyLocalBox(parent);
  if (!body) return null;
  const { u, v } = doorPlaneAxes(group.axis);
  const pl = group.placement;
  const l = boundEdge(group.bounds.uMin, parent, shapes, body, u, true, pl), r = boundEdge(group.bounds.uMax, parent, shapes, body, u, false, pl);
  const b = boundEdge(group.bounds.vMin, parent, shapes, body, v, true, pl), t = boundEdge(group.bounds.vMax, parent, shapes, body, v, false, pl);
  const fronts = [l, r, b, t].map(x => x.box).filter((x): x is CavityBox => !!x).map(x => (group.side > 0 ? x.max[group.axis] : x.min[group.axis]));
  const bodyFront = group.side > 0 ? body.max[group.axis] : body.min[group.axis];
  const front = !fronts.length ? bodyFront
    : pl === 'outer' ? (group.side > 0 ? Math.max(...fronts) : Math.min(...fronts))
    : (group.side > 0 ? Math.min(...fronts) : Math.max(...fronts));
  let rect: DoorRect = { u0: l.edge, u1: r.edge, v0: b.edge, v1: t.edge, front };
  if (rect.u1 - rect.u0 < MIN_DOOR_SPAN || rect.v1 - rect.v0 < MIN_DOOR_SPAN) {
    console.warn('[YAGO][KAPAK] dikdörtgen bozuk/çok küçük, önceki korunuyor:', group.id, fmtRect(rect));
    rect = { ...group.rect };
  }
  const cg = colGapsOf(group), rg = rowGapsOf(group);
  const colWidths = distributeDoors(group.colWidths, rect, 'u', cg);
  const rowHeights = distributeDoors(group.rowHeights, rect, 'v', rg);
  return { rect, colWidths, rowHeights, members: doorMemberRects(rect, group.cols, group.rows, colWidths, rowHeights, cg, rg) };
}

/**
 * Üye VF geometrisi: kapak düzleminde dikdörtgen, normal = side·eksen (dışa).
 * createPanelFromVirtualFace −normal yönünde t kadar uzar → VF düzlemi kapağın DIŞ yüzüdür:
 * dış kapak: ön + side·t (panel [ön, ön+t] — gövdenin önünde); iç kapak: ön (panel [ön−t, ön] — içerde, önü hizalı).
 */
function doorMemberVfGeometry(group: DoorGroup, m: DoorMemberRect, rect: DoorRect): { normal: Vec3; vertices: Vec3[]; center: Vec3 } {
  const { u, v } = doorPlaneAxes(group.axis);
  const plane = group.placement === 'outer' ? rect.front + group.side * group.thickness : rect.front;
  const mk = (uu: number, vv: number): Vec3 => { const p: Vec3 = [0, 0, 0]; p[group.axis] = plane; p[u] = uu; p[v] = vv; return p; };
  const normal: Vec3 = [0, 0, 0]; normal[group.axis] = group.side;
  const vertices = [mk(m.u0, m.v0), mk(m.u1, m.v0), mk(m.u1, m.v1), mk(m.u0, m.v1)];
  return { normal, vertices, center: mk((m.u0 + m.u1) / 2, (m.v0 + m.v1) / 2) };
}

function doorVfPatch(vf: VirtualFace, group: DoorGroup, sol: DoorSolution): Partial<VirtualFace> | null {
  const i = vf.doorIndex ?? group.memberVfIds.indexOf(vf.id);
  const m = sol.members[i];
  if (!m) return null;
  const g = doorMemberVfGeometry(group, m, sol.rect);
  return { normal: g.normal, vertices: g.vertices, center: g.center, regionAnchor: g.center } as any;
}

/** REGEN KANCASI (PanelEngine): gövdenin kapak VF'lerini grup çözümüyle yeniden yazar. */
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

// ── STORE İŞLEMLERİ ─────────────────────────────────────────────────────────

const groupById = (id: string) => useAppStore.getState().doorGroups.find(g => g.id === id);

function solveFromStore(group: DoorGroup): DoorSolution | null {
  const st = useAppStore.getState();
  const parent = shapeById(group.shapeId, st.shapes);
  return parent ? solveDoorGroup(group, parent, st.shapes) : null;
}

const fallbackSolution = (group: DoorGroup): DoorSolution => ({
  rect: group.rect, colWidths: group.colWidths, rowHeights: group.rowHeights,
  members: doorMemberRects(group.rect, group.cols, group.rows, group.colWidths, group.rowHeights, colGapsOf(group), rowGapsOf(group)),
});

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

/** Üye VF'lerin panelini + VF'sini siler (seçili satırsa seçim düşer). */
function removeMembers(vfIds: string[]): void {
  const st = useAppStore.getState();
  for (const vfId of vfIds) {
    const p = panelOfVf(vfId, st.shapes);
    if (p) st.deleteShape(p.id);
    st.deleteVirtualFace(vfId);
    if (useAppStore.getState().selectedPanelRow === `vf-${vfId}`) st.setSelectedPanelRow(null);
  }
}

/** Onaylanan adaydan grup + ilk kapak (1×1) oluşturur; grup seçilir. */
export function createDoorGroupFromPick(shapeId: string, pick: DoorPick, placement: DoorGroup['placement'], name?: string): DoorGroup | null {
  const st = useAppStore.getState();
  const parent = shapeById(shapeId, st.shapes);
  if (!parent) return null;
  const rect = placement === 'inner' ? { ...pick.inner } : { ...pick.outer };
  const group: DoorGroup = {
    id: genId('door'), shapeId, axis: pick.axis, side: pick.side, placement, bounds: pick.bounds, rect,
    cols: 1, rows: 1, colWidths: equalDoors(rect, 'u', [DOOR_GAP, DOOR_GAP]), rowHeights: equalDoors(rect, 'v', [DOOR_GAP, DOOR_GAP]),
    colGaps: [DOOR_GAP, DOOR_GAP], rowGaps: [DOOR_GAP, DOOR_GAP], gap: DOOR_GAP, thickness: DOOR_THICKNESS, memberVfIds: [], name: name?.trim() || 'Door', createdAt: Date.now(),
  };
  const sol = solveFromStore(group) || fallbackSolution(group);
  const vfs = sol.members.map((_, i) => makeMemberVf(group, i, sol));
  group.memberVfIds = vfs.map(v => v.id);
  group.rect = sol.rect;
  st.addDoorGroup(group);
  st.insertVirtualFacesAfter(null, vfs);
  st.setSelectedDoorGroupId(group.id);
  console.log('[YAGO][KAPAK] oluşturuldu', group.id, placement === 'inner' ? 'İÇ' : 'DIŞ', 'düzlem=', `${'XYZ'[group.axis]}${group.side > 0 ? '+' : '−'}`, fmtRect(sol.rect),
    'sınır=', ['uMin', 'uMax', 'vMin', 'vMax'].map(k => (group.bounds as any)[k].vfId ? 'panel' : 'gövde').join('/'));
  return group;
}

/** Seçim onayı (sağ tık / ✓): grup oluşur, mod kapanır. */
export function confirmDoorPick(shapeId: string, pick: DoorPick | undefined): void {
  const st = useAppStore.getState();
  if (!pick) return;
  createDoorGroupFromPick(shapeId, pick, st.doorPickPlacement, st.placementName);   // şeritte yazılan ad (boşsa Door)
  st.setDoorPickMode(false);
}

/** Çözümü üye VF'lere yazar ve grubu günceller; tam rebuild. */
async function writeDoorGroup(group: DoorGroup, patch: Partial<DoorGroup>, why: string): Promise<void> {
  const st = useAppStore.getState();
  const next: DoorGroup = { ...group, ...patch };
  const sol = solveFromStore(next) || fallbackSolution(next);
  for (const vfId of next.memberVfIds) {
    const vf = useAppStore.getState().virtualFaces.find(f => f.id === vfId);
    if (!vf) continue;
    const p = doorVfPatch(vf, next, sol);
    if (p) st.updateVirtualFace(vf.id, p);
  }
  st.updateDoorGroup(group.id, { ...patch, rect: sol.rect, colWidths: sol.colWidths, rowHeights: sol.rowHeights });
  console.log('[YAGO][KAPAK]', why, group.id, fmtRect(sol.rect), 'sütun=', sol.colWidths.map(g => `${g.value}${g.locked ? '🔒' : ''}`).join('/'), 'satır=', sol.rowHeights.map(g => `${g.value}${g.locked ? '🔒' : ''}`).join('/'));
  await requestRebuild(group.shapeId);
}

/**
 * BÖLME (dikeyde böl = sütun, yatayda böl = satır): üye sayısı değişince tüm üyeler
 * yeniden kurulur (satır-major sıra); genişlik/yükseklikler eşitlenir.
 */
export async function setDoorSplit(groupId: string, cols: number, rows: number): Promise<void> {
  const group = groupById(groupId);
  if (!group) return;
  const nc = Math.max(1, Math.min(MAX_DOOR_SPLIT, Math.round(cols)));
  const nr = Math.max(1, Math.min(MAX_DOOR_SPLIT, Math.round(rows)));
  if (nc === group.cols && nr === group.rows) return;
  // Kenar boşlukları korunur; yeni aralar mevcut ilk ARANIN değeriyle (yoksa varsayılan boşlukla) doğar;
  // sayı değişmediyse aralar da aynen korunur.
  const resplit = (old: number[], n: number) => (old.length === n + 1 ? old : gapsOf([old[0], old[old.length - 1]], n, old.length > 2 ? old[1] : group.gap));
  const colGaps = resplit(colGapsOf(group), nc);
  const rowGaps = resplit(rowGapsOf(group), nr);
  const colWidths = nc === group.cols ? group.colWidths : equalDoors(group.rect, 'u', colGaps);
  const rowHeights = nr === group.rows ? group.rowHeights : equalDoors(group.rect, 'v', rowGaps);
  const next: DoorGroup = { ...group, cols: nc, rows: nr, colWidths, rowHeights, colGaps, rowGaps, memberVfIds: [] };
  const sol = solveFromStore(next) || fallbackSolution(next);
  const st = useAppStore.getState();
  // Üyeler yeniden kurulur: eski paneller + VF'ler silinir, yeni VF'ler eklenir (panelleri otomatik üretim yaratır).
  removeMembers(group.memberVfIds);
  const vfs = sol.members.map((_, i) => makeMemberVf(next, i, sol));
  next.memberVfIds = vfs.map(v => v.id);
  st.updateDoorGroup(groupId, { cols: nc, rows: nr, colGaps, rowGaps, colWidths: sol.colWidths, rowHeights: sol.rowHeights, rect: sol.rect, memberVfIds: next.memberVfIds });
  st.insertVirtualFacesAfter(null, vfs);
  if (st.selectedDoorGroupId !== groupId && !st.selectedPanelRow) st.setSelectedDoorGroupId(groupId);
  console.log('[YAGO][KAPAK] bölme', groupId, `${group.cols}x${group.rows}`, '→', `${nc}x${nr}`, '(genişlik/yükseklikler eşitlendi)');
  // Rebuild'i panel silme/ekleme izleyicisi (App) tetikler.
}

/** Sütun genişliği girişi (şema pill'i): applyGapEdit kuralı — girilen korunur, fark kilitsiz/girilmemişlere eşit. */
export async function editDoorColWidth(groupId: string, k: number, value: number): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value) || value <= 0) return;
  const cg = colGapsOf(group);
  const colWidths = applyGapEdit(group.colWidths, k, value, doorSpan(group.rect, 'u', cg), group.cols - 1, innerGaps(cg));
  await writeDoorGroup(group, { colWidths }, `sütun ${k + 1} = ${value}`);
}
export async function editDoorRowHeight(groupId: string, k: number, value: number): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value) || value <= 0) return;
  const rg = rowGapsOf(group);
  const rowHeights = applyGapEdit(group.rowHeights, k, value, doorSpan(group.rect, 'v', rg), group.rows - 1, innerGaps(rg));
  await writeDoorGroup(group, { rowHeights }, `satır ${k + 1} = ${value}`);
}
/** Kilit: değer değişmez; gövde boyutlanınca bu sütun/satır sabit kalır. */
export function toggleDoorColLock(groupId: string, k: number): void {
  const group = groupById(groupId);
  if (!group || k < 0 || k >= group.colWidths.length) return;
  useAppStore.getState().updateDoorGroup(groupId, { colWidths: group.colWidths.map((g, i) => (i === k ? { ...g, locked: !g.locked } : g)) });
}
export function toggleDoorRowLock(groupId: string, k: number): void {
  const group = groupById(groupId);
  if (!group || k < 0 || k >= group.rowHeights.length) return;
  useAppStore.getState().updateDoorGroup(groupId, { rowHeights: group.rowHeights.map((g, i) => (i === k ? { ...g, locked: !g.locked } : g)) });
}
/** Tüm boşluklar (kenarlar + aralar) tek değere: kilitli/girilmiş kapak ölçüleri korunur, kalan diğerlerine EŞİT (distributeDoors). */
export async function setDoorGap(groupId: string, gap: number): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(gap) || gap < 0) return;
  const g = round1(gap);
  await writeDoorGroup(group, { gap: g, colGaps: gapsOf(undefined, group.cols, g), rowGaps: gapsOf(undefined, group.rows, g) }, `tüm boşluklar = ${g}`);
}
/**
 * TEK BOŞLUK (şemadaki boşluk pill'i): axis 'col' → k = 0 sol kenar … cols sağ kenar; 'row' → k = 0 üst kenar …
 * rows alt kenar. Yalnız o boşluk değişir; fark kilitli/girilmemiş kapaklara EŞİT dağılır.
 */
export async function setDoorGapAt(groupId: string, axis: 'col' | 'row', k: number, value: number): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value) || value < 0) return;
  const v = round1(value);
  const gaps = axis === 'col' ? colGapsOf(group) : rowGapsOf(group);
  if (k < 0 || k >= gaps.length || Math.abs(gaps[k] - v) < 0.05) return;
  gaps[k] = v;
  const n = gaps.length - 1;
  const where = k === 0 ? (axis === 'col' ? 'sol kenar' : 'üst kenar') : k === n ? (axis === 'col' ? 'sağ kenar' : 'alt kenar') : `${axis === 'col' ? 'sütun' : 'satır'} arası ${k}`;
  await writeDoorGroup(group, axis === 'col' ? { colGaps: gaps } : { rowGaps: gaps }, `boşluk ${where} = ${v}`);
}
/** Tüm sütun/satırlar eşit + kilitsiz. */
export async function equalizeDoorGroup(groupId: string): Promise<void> {
  const group = groupById(groupId);
  if (!group) return;
  await writeDoorGroup(group, {
    colWidths: equalDoors(group.rect, 'u', colGapsOf(group)),
    rowHeights: equalDoors(group.rect, 'v', rowGapsOf(group)),
  }, 'eşitlendi');
}
/** Dış / iç kapak: dikdörtgen sınır panellerinin dış/iç yüzlerinden yeniden çözülür. */
export async function setDoorPlacement(groupId: string, placement: DoorGroup['placement']): Promise<void> {
  const group = groupById(groupId);
  if (!group || group.placement === placement) return;
  await writeDoorGroup(group, { placement }, placement === 'inner' ? 'İÇ kapak' : 'DIŞ kapak');
}
/** Kapak kalınlığı: üye panellerin panelThickness parametresi güncellenir (motor levhayı bununla üretir). */
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
  await writeDoorGroup(group, { thickness: v }, `kalınlık = ${v}`);
}
/** Grup adı: üye kapakların adı (VF description) aynı adla eşitlenir. */
export function renameDoorGroup(groupId: string, name: string): void {
  const group = groupById(groupId);
  if (!group) return;
  useAppStore.getState().updateDoorGroup(groupId, { name });
  const ids = new Set(group.memberVfIds);
  useAppStore.setState(s => ({ virtualFaces: s.virtualFaces.map(f => (ids.has(f.id) ? { ...f, description: name } : f)) }));
}
/** Grup + tüm kapaklar (panel + VF) silinir (rebuild'i panel silme izleyicisi tetikler). */
export function deleteDoorGroupWithMembers(groupId: string): void {
  const group = groupById(groupId);
  if (!group) return;
  removeMembers(group.memberVfIds);
  useAppStore.getState().deleteDoorGroup(groupId);
  console.log('[YAGO][KAPAK] silindi', groupId, 'üyeN=', group.memberVfIds.length);
}

/** REBUILD SONRASI SENKRON (PanelEngine): grubun store'daki dikdörtgeni/ölçüleri güncel çözümle eşitlenir. */
export function syncDoorGroups(parentShapeId: string): void {
  const st = useAppStore.getState();
  const parent = shapeById(parentShapeId, st.shapes);
  if (!parent) return;
  for (const g of st.doorGroups) {
    if (g.shapeId !== parentShapeId) continue;
    const sol = solveDoorGroup(g, parent, st.shapes);
    if (!sol) continue;
    const same = (a: GapSpec[], b: GapSpec[]) => a.length === b.length && a.every((x, i) => Math.abs(x.value - b[i].value) < 0.05 && x.locked === b[i].locked);
    if (rectKey(sol.rect) === rectKey(g.rect) && Math.abs(sol.rect.front - g.rect.front) < 0.05 && same(sol.colWidths, g.colWidths) && same(sol.rowHeights, g.rowHeights)) continue;
    st.updateDoorGroup(g.id, { rect: sol.rect, colWidths: sol.colWidths, rowHeights: sol.rowHeights });
    console.log('[YAGO][KAPAK-SENKRON]', g.id, fmtRect(sol.rect), 'sütun=', sol.colWidths.map(x => x.value).join('/'), 'satır=', sol.rowHeights.map(x => x.value).join('/'));
  }
}

/** Kapak düzleminde (u,v) → gövde-yerel kutu köşeleri (önizleme levhası): dış kapak öne, iç kapak içeri. */
export function doorSlabBox(group: Pick<DoorGroup, 'axis' | 'side' | 'placement' | 'thickness'>, rect: DoorRect): CavityBox {
  const { u, v } = doorPlaneAxes(group.axis);
  const min: Vec3 = [0, 0, 0], max: Vec3 = [0, 0, 0];
  min[u] = rect.u0; max[u] = rect.u1; min[v] = rect.v0; max[v] = rect.v1;
  const a0 = group.placement === 'outer' ? rect.front : rect.front - group.side * group.thickness;
  const a1 = group.placement === 'outer' ? rect.front + group.side * group.thickness : rect.front;
  min[group.axis] = Math.min(a0, a1); max[group.axis] = Math.max(a0, a1);
  return { min, max };
}
