/* BAZA AYAĞI SETİ (PlinthService) — gövdeden BAĞIMSIZ yerleşen baza ayağı seti (Goker, Eki 2026: "baza ayağını body haricinde de
   yerleştirebilmeliyim; set olarak; ölçülerini arrow oklarıyla revize edeyim; yerleşeceği hacmi highlight et; kodları ayır, sonra
   detaylandırılacak"). TEK MODEL (Goker: "body'den yerleştirilen ayakla mantığı aynı olmalı, birleştir"): hızlı gövdenin ayakları da
   bu setlerden biridir (`quickBody: true`, alt panele bağlı) — eski `parameters.legs` / CabinetLegs yolu kaldırıldı.

   Model: `PlinthSet` = gövde-yerel bir KUTU (x/z = set kapsamı) + ayak düzeni (adet / Ø / kenar mesafeleri). AYAĞIN ALTI HER ZAMAN
   REFERANS KÜBÜN ALT YÜZÜNDE (zemin): kutunun tabanı okunurken gövdenin alt düzlemine demirlenir (`plinthBoxOf`), yükseklik değişince
   yalnız üst yüz oynar. `bottomVfId` bağlıysa üst yüz = o alt panelin alt yüzü (canlı); bağsız sette yükseklik oklarla / karttan.
   Yerleşim: raf/dikme gibi hacme tıklanır; adaylar (1) yükseltilmiş alt panelin ALTINDAKİ boşluk (zemin → panel altı, panele bağlanır),
   (2) gövdenin içinde zeminden varsayılan yüksekliğe kadar — hiç panel olmasa da yerleşir. Oklar: Arrow dyn = o yüz değer kadar dışarı
   (− içeri), Arrow fixed = setin o eksendeki ölçüsü değer olur. Ayaklar her zaman kutunun içinde kalır.
   Şimdilik yalnız geometri: set hiçbir paneli itmez / kesmez — panel ilişkileri sonraki adımda. */
import * as THREE from 'three';
import { type CavityBox, type Shape, type VirtualFace, useAppStore, shapeById, childPanelsOf, vfOfPanel, panelOfVf } from '../store';
import { type AxisDir, type Vec3, axisDirToVec, effectiveBodyGeometry, genId, localBboxOf, round1 } from './Geometry';
import { legSpots } from './PanelGroupService';

export type PlinthLegs = { count: 4 | 5 | 6; diameter: number; side: number; front: number; rear: number };
export interface PlinthSet {
  id: string; shapeId: string; name: string;
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
export function plinthBoxOf(s: PlinthSet, shapes = useAppStore.getState().shapes): CavityBox {
  const body = shapeById(s.shapeId, shapes);
  const floor = floorOf(body);
  const h = Math.max(1, s.box.max[1] - s.box.min[1]);
  const y0 = floor ?? s.box.min[1];
  const bound = boundTopOf(s, shapes);
  const y1 = bound != null && bound - y0 > 0.5 ? bound : y0 + h;
  return { min: [s.box.min[0], y0, s.box.min[2]], max: [s.box.max[0], y1, s.box.max[2]] };
}
export const plinthHeight = (s: PlinthSet, shapes?: Shape[]) => { const b = plinthBoxOf(s, shapes); return b.max[1] - b.min[1]; };
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

/** Set kurar (yerleştirme ve hızlı gövde ortak). */
export function createPlinthSet(shapeId: string, box: CavityBox, legs: PlinthLegs, opts: { name?: string; bottomVfId?: string; quickBody?: boolean } = {}): PlinthSet {
  const st = useAppStore.getState();
  const n = plinthSetsOf(shapeId, st.plinthSets).length + 1;
  const set: PlinthSet = {
    id: genId('plinth'), shapeId, name: (opts.name || '').trim() || (n > 1 ? `Plinth ${n}` : 'Plinth'),
    box: { min: [...box.min] as Vec3, max: [...box.max] as Vec3 }, legs: { ...legs }, createdAt: Date.now(),
    ...(opts.bottomVfId ? { bottomVfId: opts.bottomVfId } : {}), ...(opts.quickBody ? { quickBody: true } : {}),
  };
  st.addPlinthSet(set);
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
  if (!legs) { if (existing) st.deletePlinthSet(existing.id); return; }
  const bb = localBboxOf(effectiveBodyGeometry(body)); if (!bb) return;
  const box: CavityBox = { min: [bb.min.x, bb.min.y, bb.min.z], max: [bb.max.x, bb.min.y + Math.max(1, lift), bb.max.z] };
  if (existing) st.updatePlinthSet(existing.id, { box, legs: { ...legs }, bottomVfId });
  else createPlinthSet(shapeId, box, legs, { name: 'Legs', bottomVfId, quickBody: true });
}
export function removeQuickBodyPlinth(shapeId: string): void {
  const st = useAppStore.getState();
  const existing = quickPlinthSetOf(shapeId, st.plinthSets);
  if (existing) st.deletePlinthSet(existing.id);
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
  return true;
}

/** Kutu yüz merkezleri (gövde-yerel) — gizmo okları. */
export function plinthFaceCenters(box: CavityBox): Record<AxisDir, Vec3> {
  const c: Vec3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  return {
    'x+': [box.max[0], c[1], c[2]], 'x-': [box.min[0], c[1], c[2]], 'y+': [c[0], box.max[1], c[2]], 'y-': [c[0], box.min[1], c[2]],
    'z+': [c[0], c[1], box.max[2]], 'z-': [c[0], c[1], box.min[2]],
  };
}
export const plinthBoxCenter = (box: CavityBox): THREE.Vector3 =>
  new THREE.Vector3((box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2);
