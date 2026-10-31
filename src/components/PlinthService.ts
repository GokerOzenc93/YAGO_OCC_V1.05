/* BAZA AYAĞI SETİ (PlinthService) — gövdeden BAĞIMSIZ yerleşen baza ayağı seti (Goker, Eki 2026: "baza ayağını body haricinde de
   yerleştirebilmeliyim; set olarak; ölçülerini arrow oklarıyla revize edeyim; yerleşeceği hacmi highlight et; kodları ayır, sonra
   detaylandırılacak"). TEK MODEL (Goker: "body'den yerleştirilen ayakla mantığı aynı olmalı, birleştir"): hızlı gövdenin ayakları da
   bu setlerden biridir (`quickBody: true`, alt panele bağlı) — eski `parameters.legs` / CabinetLegs yolu kaldırıldı.

   Model: `PlinthSet` = gövde-yerel bir KUTU (x/z = set kapsamı) + ayak düzeni (adet / Ø / kenar mesafeleri). AYAĞIN ALTI HER ZAMAN
   REFERANS KÜBÜN ALT YÜZÜNDE (zemin): kutunun tabanı okunurken gövdenin alt düzlemine demirlenir (`plinthBoxOf`), yükseklik değişince
   yalnız üst yüz oynar. `bottomVfId` bağlıysa üst yüz = o alt panelin alt yüzü (canlı); bağsız sette yükseklik oklarla / karttan.
   Yerleşim: raf/dikme gibi hacme tıklanır; adaylar (1) yükseltilmiş alt panelin ALTINDAKİ boşluk (zemin → panel altı, panele bağlanır),
   (2) gövdenin içinde zeminden varsayılan yüksekliğe kadar — hiç panel olmasa da yerleşir. Ölçü: Volume (kutu yüzü seçilir; Fixed = o
   eksendeki ölçü, Dyn = yüz değer kadar) — ok gizmosu ve Ø girişi kaldırıldı (Goker: "çap modelden gelsin, sadece yükseklik değişsin").
   Ayaklar her zaman kutunun içinde kalır.
   Şimdilik yalnız geometri: set hiçbir paneli itmez / kesmez — panel ilişkileri sonraki adımda. */
import { type CavityBox, type Shape, type VirtualFace, useAppStore, shapeById, childPanelsOf, vfOfPanel, panelOfVf, requestRebuild } from '../store';
import { type AxisDir, type Vec3, axisDirToVec, effectiveBodyGeometry, genId, localBboxOf, round1 } from './Geometry';
import { legSpots } from './PanelGroupService';

export type PlinthLegs = { count: 4 | 5 | 6; diameter: number; side: number; front: number; rear: number };
export interface PlinthSet {
  id: string; shapeId: string; name: string;
  /** Sıralama yer tutucusu VF (store.virtualFaces içinde; `plinthId` = set). */
  vfId: string;
  /** Gövde-yerel set kutusu: x/z = setin kapsamı; y = [zemin, zemin + yükseklik] (taban okunurken zemine demirlenir). */
  box: CavityBox;
  legs: PlinthLegs;
  /** Bağlı alt panel: setin üst yüzü o panelin alt yüzünden canlı okunur (yükseklik oklarla değişmez). */
  bottomVfId?: string;
  /** Hızlı gövdenin kurduğu set (Body satırıyla birlikte kaldırılır / yeniden kurulur). */
  quickBody?: boolean;
  createdAt: number;
}
export interface PlinthPick { key: string; box: CavityBox; where: 'underBottom' | 'inside'; label: string; bottomVfId?: string }
/** Ok modu: dyn = her tık değer kadar; fixed = o eksendeki toplam ölçü = değer. */
export type ArrowMode = 'dyn' | 'fixed';

export const DEFAULT_PLINTH_LEGS: PlinthLegs = { count: 4, diameter: 50, side: 60, front: 60, rear: 60 };
export const PLINTH_DEFAULT_HEIGHT = 100;
export const plinthRowKey = (id: string) => `plinth-${id}`;
export const plinthSetsOf = (shapeId: string | null | undefined, sets = useAppStore.getState().plinthSets): PlinthSet[] =>
  shapeId ? sets.filter(s => s.shapeId === shapeId) : [];
export const quickPlinthSetOf = (shapeId: string, sets = useAppStore.getState().plinthSets): PlinthSet | undefined =>
  sets.find(s => s.shapeId === shapeId && s.quickBody);
export const plinthName = (s: PlinthSet) => s.name || 'Plinth';
export const plinthIsBound = (s: PlinthSet) => !!s.bottomVfId;
export const isPlinthVf = (vf: unknown): boolean => !!(vf as { plinthId?: string } | null)?.plinthId;
export const plinthOfVf = (vf: { plinthId?: string } | undefined, sets = useAppStore.getState().plinthSets): PlinthSet | undefined =>
  vf?.plinthId ? sets.find(s => s.id === vf.plinthId) : undefined;

/** Setin VF sırası (basan/basılan); VF yoksa ∞ (herkesten sonra). */
export function plinthVfIndex(s: PlinthSet, vfs = useAppStore.getState().virtualFaces): number {
  const i = vfs.findIndex(f => f.id === s.vfId);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

/** Gövdenin zemini (yerel alt düzlem). */
const floorOf = (body: Shape | undefined): number | null => {
  const bb = body ? localBboxOf(effectiveBodyGeometry(body)) : null;
  return bb ? bb.min.y : null;
};
/** Bağlı alt panelin alt yüzü (gövde-yerel y); panel yoksa null. */
const boundTopOf = (s: PlinthSet, shapes: Shape[]): number | null => {
  if (!s.bottomVfId) return null;
  const p = panelOfVf(s.bottomVfId, shapes);
  const bb = p?.geometry ? localBboxOf(p.geometry) : null;
  return bb ? bb.min.y : null;
};
/** ETKİN KUTU: taban = gövde zemini (ayak her zaman zemine basar), üst = bağlı panelin altı ya da zemin + saklı yükseklik. */
export function plinthBoxOf(s: PlinthSet, shapes = useAppStore.getState().shapes, vfs = useAppStore.getState().virtualFaces): CavityBox {
  const body = shapeById(s.shapeId, shapes);
  const floor = floorOf(body);
  const h = Math.max(1, s.box.max[1] - s.box.min[1]);
  const y0 = floor ?? s.box.min[1];
  const bound = boundTopOf(s, shapes);
  const y1 = bound != null && bound - y0 > 0.5 ? bound : y0 + h;
  const box: CavityBox = { min: [s.box.min[0], y0, s.box.min[2]], max: [s.box.max[0], y1, s.box.max[2]] };
  return body ? clipByEarlierPanels(s, box, body, shapes, vfs) : box;
}
/** BASILAN SET (Goker: "sırası değişince volümün birleşim tipi değişsin"): sırada ÖNCE gelen, setin y aralığıyla kesişen düz gövde
 *  panelleri seti x/z'de kırpar — set yanların ARASINDA kalır; sonra gelen paneller ise set tarafından basılır (PanelEngine damgası). */
function clipByEarlierPanels(s: PlinthSet, box: CavityBox, body: Shape, shapes: Shape[], vfs: VirtualFace[]): CavityBox {
  const myIdx = plinthVfIndex(s, vfs);
  if (myIdx === Number.MAX_SAFE_INTEGER) return box;
  const idx = new Map(vfs.map((f, i) => [f.id, i] as const));
  const min = [...box.min] as Vec3, max = [...box.max] as Vec3;
  for (const p of childPanelsOf(body.id, shapes)) {
    const vf = vfOfPanel(p, vfs); if (!vf || vf.interior || vf.doorGroupId || vf.backGroupId) continue;
    const pi = idx.get(vf.id); if (pi == null || pi > myIdx || !p.geometry) continue;
    const b = localBboxOf(p.geometry); if (!b) continue;
    const ov = (a: 0 | 1 | 2) => Math.min(max[a], [b.max.x, b.max.y, b.max.z][a]) - Math.max(min[a], [b.min.x, b.min.y, b.min.z][a]);
    if (ov(0) <= 0.5 || ov(1) <= 0.5 || ov(2) <= 0.5) continue;
    const sz = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
    // Düşey levha: ince ekseni x ya da z — set o levhanın öbür tarafında biter (merkez tarafı korunur)
    const a: 0 | 2 | null = sz[0] <= sz[2] && sz[0] < (max[0] - min[0]) / 2 ? 0 : sz[2] < (max[2] - min[2]) / 2 ? 2 : null;
    if (a === null) continue;
    const bmin = a === 0 ? b.min.x : b.min.z, bmax = a === 0 ? b.max.x : b.max.z, c = (min[a] + max[a]) / 2;
    if ((bmin + bmax) / 2 < c) min[a] = Math.max(min[a], bmax); else max[a] = Math.min(max[a], bmin);
    if (max[a] - min[a] < 1) return box;
  }
  return { min, max };
}
export const plinthHeight = (s: PlinthSet, shapes?: Shape[]) => { const b = plinthBoxOf(s, shapes); return b.max[1] - b.min[1]; };
/** Zeminden setin üstüne (üst üste panel derinliği). */
export const plinthTopDepth = (s: PlinthSet, shapes?: Shape[]) => plinthHeight(s, shapes);
export const plinthSize = (s: PlinthSet, shapes?: Shape[]): Vec3 => {
  const b = plinthBoxOf(s, shapes);
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
};

/** Ayak merkezleri (gövde-yerel x/z): kutu kapsamına `legSpots` düzeni; ayak (taban diski + montaj tablası ≈ 1.15·Ø/2) HER ZAMAN
 *  hacmin içinde kalır — kenar mesafesi küçük ya da hacim dar olsa da merkez [min + R, max − R] aralığına kıstırılır. */
export function plinthLegSpots(s: PlinthSet, box = plinthBoxOf(s)): Array<{ x: number; z: number }> {
  const W = box.max[0] - box.min[0], D = box.max[2] - box.min[2];
  const R = Math.max(10, s.legs.diameter / 2) * 1.15;
  const clamp = (v: number, lo: number, hi: number) => (hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
  return legSpots(s.legs, W, D).map(p => ({
    x: clamp(box.min[0] + p.x, box.min[0] + R, box.max[0] - R), z: clamp(box.min[2] + p.z, box.min[2] + R, box.max[2] - R),
  }));
}

/** Gövdenin ALT yüzündeki (normal −Y) panel: en alçak alt yüzlü olan. */
function bottomPanelOf(body: Shape, shapes: Shape[], vfs: VirtualFace[]): { panel: Shape; vf: VirtualFace } | null {
  let best: { panel: Shape; vf: VirtualFace } | null = null, bestY = Infinity;
  for (const p of childPanelsOf(body.id, shapes)) {
    const vf = vfOfPanel(p, vfs);
    if (!vf || !vf.normal || vf.normal[1] > -0.95 || !p.geometry) continue;
    const bb = localBboxOf(p.geometry); if (!bb) continue;
    if (bb.min.y < bestY) { bestY = bb.min.y; best = { panel: p, vf }; }
  }
  return best;
}

/** Aday hacimler (gövde-yerel), ikisi de ZEMİNDEN başlar: (1) yükseltilmiş alt panelin altı (panele bağlanır), (2) gövdenin içinde
 *  zemin → varsayılan yükseklik — alt panel olmasa da. */
export function plinthCandidates(body: Shape, shapes: Shape[], vfs: VirtualFace[], height: number): PlinthPick[] {
  const bb = localBboxOf(effectiveBodyGeometry(body)); if (!bb) return [];
  const H = Math.max(1, height);
  const x0 = bb.min.x, x1 = bb.max.x, z0 = bb.min.z, z1 = bb.max.z, y0 = bb.min.y;
  const out: PlinthPick[] = [];
  const bottom = bottomPanelOf(body, shapes, vfs);
  const under = bottom ? localBboxOf(bottom.panel.geometry)!.min.y : null;
  if (bottom && under != null && under - y0 > 1) {
    out.push({ key: `under:${bottom.vf.id}:${round1(under)}`, where: 'underBottom', label: 'Under the bottom panel (follows it)', bottomVfId: bottom.vf.id,
      box: { min: [x0, y0, z0], max: [x1, under, z1] } });
  }
  const top = Math.min(y0 + H, bb.max.y);
  out.push({ key: `inside:${round1(top)}`, where: 'inside', label: 'Inside the body, on the floor', box: { min: [x0, y0, z0], max: [x1, top, z1] } });
  return out;
}

/** Seçme kutusu (gövde-yerel): gövdenin kendisi — tıklama her iki adayı da verir. */
export function plinthPickBox(body: Shape): CavityBox | null {
  const bb = localBboxOf(effectiveBodyGeometry(body)); if (!bb) return null;
  return { min: [bb.min.x, bb.min.y, bb.min.z], max: [bb.max.x, bb.max.y, bb.max.z] };
}

/** Set hacmi raf/dikme hacimlerini sınırlar (collectObstacles): hacim değişince gövdede grup varsa yeniden çözülür. */
function syncAfterPlinthChange(shapeId: string): void {
  // Set hacmi raf/dikme hacimlerini sınırlar ve sırada sonraki panelleri basar → panelleri olan gövdede yeniden çözüm.
  const st = useAppStore.getState();
  if (st.panelGroups.some(g => g.shapeId === shapeId) || childPanelsOf(shapeId, st.shapes).length) void requestRebuild(shapeId);
}
export function deletePlinthSetAndSync(id: string): void {
  const st = useAppStore.getState();
  const s = st.plinthSets.find(x => x.id === id); if (!s) return;
  if (st.faceExtrudePlinthId === id) st.setFaceExtrudeMode(false);
  st.deletePlinthSet(id);
  st.deleteVirtualFace(s.vfId);
  // Setin üstüne yerleşmiş paneller setle gider (üst üste tabanı kalmaz).
  for (const f of st.virtualFaces.filter(f => f.stackOnPlinthId === id)) { const p = panelOfVf(f.id, st.shapes); if (p) st.deleteShape(p.id); st.deleteVirtualFace(f.id); }
  syncAfterPlinthChange(s.shapeId);
  void requestRebuild(s.shapeId);
}
/** Set düzenlemesini bitir (✓ / Esc): satır seçimi ve açık hacim düzenlemesi kapanır. */
export function finishPlinthEdit(): void {
  const st = useAppStore.getState();
  if (st.faceExtrudePlinthId) st.setFaceExtrudeMode(false);
  if (typeof st.selectedPanelRow === 'string' && st.selectedPanelRow.startsWith('plinth-')) st.setSelectedPanelRow(null);
}
export const isPlinthRow = (row: unknown): row is string => typeof row === 'string' && row.startsWith('plinth-');

/* HACİM DÜZENLEME (Volume, raf/dikme hacmindeki gibi — yalnız Fixed / Dyn): set kutusunun bir yüzü 3D'de seçilir, değer uygulanır. */
export function startPlinthVolumeEdit(id: string): void {
  const st = useAppStore.getState();
  if (st.panelMoveMode) st.setPanelMoveMode(false);
  if (st.panelRotateMode) st.setPanelRotateMode(false);
  st.setFaceExtrudeMode(true);
  st.setFaceExtrudePlinthId(id);
}
/** Seçilen yüz normali → ok yönü. */
export const axisDirOfNormal = (n: Vec3): AxisDir | null => {
  const a = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])], i = a.indexOf(Math.max(...a));
  if (a[i] < 0.5) return null;
  return (['x', 'y', 'z'][i] + (n[i] > 0 ? '+' : '-')) as AxisDir;
};
export function applyPlinthFace(id: string, normal: Vec3, value: number, mode: ArrowMode): boolean {
  const axis = axisDirOfNormal(normal);
  return axis ? applyPlinthArrow(id, axis, value, mode) : false;
}

/** Set kurar (yerleştirme ve hızlı gövde ortak). */
export function createPlinthSet(shapeId: string, box: CavityBox, legs: PlinthLegs, opts: { name?: string; bottomVfId?: string; quickBody?: boolean } = {}): PlinthSet {
  const st = useAppStore.getState();
  const n = plinthSetsOf(shapeId, st.plinthSets).length + 1;
  const id = genId('plinth'), vfId = genId('vf');
  const name = (opts.name || '').trim() || (n > 1 ? `Plinth ${n}` : 'Plinth');
  const set: PlinthSet = {
    id, shapeId, name, vfId,
    box: { min: [...box.min] as Vec3, max: [...box.max] as Vec3 }, legs: { ...legs }, createdAt: Date.now(),
    ...(opts.bottomVfId ? { bottomVfId: opts.bottomVfId } : {}), ...(opts.quickBody ? { quickBody: true } : {}),
  };
  // Sıralama yer tutucusu: listede setin yeri; paneli yok (interior + plinthId → motor yüz eşlemesine almaz).
  const c: Vec3 = [(box.min[0] + box.max[0]) / 2, box.min[1], (box.min[2] + box.max[2]) / 2];
  st.addVirtualFace({
    id: vfId, shapeId, normal: [0, -1, 0], center: c, description: name, hasPanel: false, interior: true, plinthId: id,
    vertices: [[box.min[0], box.min[1], box.min[2]], [box.max[0], box.min[1], box.min[2]], [box.max[0], box.min[1], box.max[2]], [box.min[0], box.min[1], box.max[2]]],
  } as VirtualFace);
  st.addPlinthSet(set);
  if (!opts.quickBody) syncAfterPlinthChange(shapeId);   // hızlı gövde kendi rebuild'ini tetikler
  return set;
}
/** Onay: set kurulur, satırı seçilir, seçme modu kapanır. */
export function confirmPlinthPick(shapeId: string, pick: PlinthPick, name?: string): PlinthSet | null {
  const st = useAppStore.getState();
  if (!shapeById(shapeId, st.shapes)) return null;
  const set = createPlinthSet(shapeId, pick.box, DEFAULT_PLINTH_LEGS, { name, bottomVfId: pick.bottomVfId });
  st.setPlinthPickMode(false);
  st.setSelectedPanelRow(plinthRowKey(set.id), shapeId);
  return set;
}

/** HIZLI GÖVDE ayakları: aynı set modeli — alt panele bağlı, Body satırıyla yaşar. count 0 → kaldırılır. */
export function syncQuickBodyPlinth(shapeId: string, legs: PlinthLegs | null, bottomVfId: string | undefined, lift: number): void {
  const st = useAppStore.getState();
  const body = shapeById(shapeId, st.shapes); if (!body) return;
  const existing = quickPlinthSetOf(shapeId, st.plinthSets);
  // Ayak kalkınca setin sıralama VF'si de düşer (yalnız set silinirse listede görünmeyen yetim VF kalır, sonraki ekleme ikinci VF açar).
  if (!legs) { removeQuickBodyPlinth(shapeId); return; }
  const bb = localBboxOf(effectiveBodyGeometry(body)); if (!bb) return;
  const box: CavityBox = { min: [bb.min.x, bb.min.y, bb.min.z], max: [bb.max.x, bb.min.y + Math.max(1, lift), bb.max.z] };
  const set = existing ?? createPlinthSet(shapeId, box, legs, { name: 'Legs', bottomVfId, quickBody: true });
  if (existing) st.updatePlinthSet(existing.id, { box, legs: { ...legs }, bottomVfId });
  placeAfterQuickBody(shapeId, set.vfId);
}
/** SIRA (Goker: "ayak her zaman quick body yönteminde bodyden sonra gelmeli"): hızlı gövde ayak setinin VF'si gövdenin SON hızlı gövde
 *  parçasının (Body satırları: yanlar/üst/alt/bazalar) hemen arkasına alınır — her Build/Rebuild'de. Body parçası yoksa yerinde kalır. */
function placeAfterQuickBody(shapeId: string, vfId: string): void {
  useAppStore.setState(s => {
    const vf = s.virtualFaces.find(f => f.id === vfId);
    if (!vf) return {};
    const rest = s.virtualFaces.filter(f => f.id !== vfId);
    let last = -1;
    rest.forEach((f, i) => { if (f.shapeId === shapeId && f.quickBody) last = i; });
    if (last < 0 || s.virtualFaces[last + 1]?.id === vfId) return {};
    return { virtualFaces: [...rest.slice(0, last + 1), vf, ...rest.slice(last + 1)] };
  });
}
export function removeQuickBodyPlinth(shapeId: string): void {
  const st = useAppStore.getState();
  const existing = quickPlinthSetOf(shapeId, st.plinthSets);
  if (existing) { st.deletePlinthSet(existing.id); st.deleteVirtualFace(existing.vfId); }
}

export function setPlinthLegs(id: string, patch: Partial<PlinthLegs>): void {
  const st = useAppStore.getState();
  const s = st.plinthSets.find(x => x.id === id); if (!s) return;
  st.updatePlinthSet(id, { legs: { ...s.legs, ...patch } });
}
/** Yükseklik: taban zeminde sabit, üst yüz oynar (bağlı sette etkisiz — üst alt panelden gelir). */
export function setPlinthHeight(id: string, h: number): void {
  const st = useAppStore.getState();
  const s = st.plinthSets.find(x => x.id === id); if (!s || plinthIsBound(s)) return;
  const v = Math.max(1, h);
  st.updatePlinthSet(id, { box: { min: [...s.box.min] as Vec3, max: [s.box.max[0], round1(s.box.min[1] + v), s.box.max[2]] } });
  syncAfterPlinthChange(s.shapeId);
}

/** Ok: X/Z = o kutu yüzü oynar; Y (iki ok da) = yalnız ÜST yüz / yükseklik — taban zeminde kalır. dyn → `value` kadar (− içeri; y− için
 *  aşağı = kısalma); fixed → o eksendeki ölçü `value` olur. Ölçü 1 mm'in altına inmez. */
export function plinthBoxAfterArrow(box: CavityBox, axis: AxisDir, value: number, mode: ArrowMode): CavityBox {
  const d = axisDirToVec(axis); const a = Math.abs(d.x) > 0.5 ? 0 : Math.abs(d.y) > 0.5 ? 1 : 2; const pos = d.getComponent(a) > 0;
  const min = [...box.min] as Vec3, max = [...box.max] as Vec3;
  const span = max[a] - min[a];
  const delta = mode === 'fixed' ? value - span : (a === 1 && !pos ? -value : value);
  if (span + delta < 1) return box;
  if (a === 1 || pos) max[a] = round1(max[a] + delta); else min[a] = round1(min[a] - delta);
  return { min, max };
}
export function applyPlinthArrow(id: string, axis: AxisDir, value: number, mode: ArrowMode): boolean {
  const st = useAppStore.getState();
  const s = st.plinthSets.find(x => x.id === id); if (!s || !Number.isFinite(value) || Math.abs(value) < 1e-6) return false;
  const a = axisDirToVec(axis);
  if (Math.abs(a.y) > 0.5 && plinthIsBound(s)) return false;   // bağlı sette yükseklik alt panelden gelir
  const cur = plinthBoxOf(s, st.shapes);
  const next = plinthBoxAfterArrow(cur, axis, value, mode);
  if (next === cur) return false;
  st.updatePlinthSet(id, { box: next });
  syncAfterPlinthChange(s.shapeId);
  return true;
}
