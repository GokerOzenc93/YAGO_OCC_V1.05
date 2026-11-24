/* BAZA AYAĞI SETİ — gövdeden bağımsız yerleşen ayak seti; hızlı gövdenin ayakları da bu setlerden biridir (`quickBody: true`).
   Model: `PlinthSet.box` = gövde-yerel kapsam kutusu; etkin hacim bölgedir (gövdenin içinde, sırada önce gelen düşey levhaların dışında —
   raf / dikme ile aynı ızgara, freeRegionInBox). Ayağın altı her zaman referans kübün alt yüzünde; `bottomVfId` bağlıysa üstü o panelin altı.
   Yüz rolleri: ön yön gövde parametresi (`faceRoles.frontAxis`, yoksa +Z), her yüz otomatik rol alır (`overrides` üstüne yazar).
   Ayak düzeni her zaman otomatik köşe düzeni (Geometry.autoLegPoints); Custom = üstüne ayak başına Δ. Set henüz paneli itmez / kesmez. */
import {
  type CavityBox, type FaceDescriptor, type Shape, type VirtualFace, useAppStore, shapeById, childPanelsOf, vfOfPanel, panelOfVf, requestRebuild,
} from '../store';
import {
  type AxisDir, type FaceData, type Vec3, axisDirToVec, computeFaceComponentContour, createFaceDescriptor, effectiveBodyGeometry, genId, getFacesAndGroups, localBboxOf,
  round1, type EdgeRole, type FaceKind, type FaceRole, type LegRule, type Pt, isFaceKind, autoLegPoints, clampInsidePoly, cleanPoly, clipPolyToRect, edgeRoles,
  fromFacing, rectPoly, roleOfNormal, signedArea, toFacing,
} from './Geometry';
import { type FreeRegion, freeRegionInBox, legSpots } from './PanelGroupService';
import { type HoleCutter, legHoleCutters, legModelById, legsFromPreset, resolveLegPreset } from './AccessoryService';
import * as THREE from 'three';

/** Ayak düzeni: her zaman kayıtlı bir set (`presetId`, yoksa ilk set); model ve Ø oradan, yerleşim otomatik.
 *  Düzen / mesafeler elle girilince `ownLayout`. Custom (`custom: true`) = ayak başına Δ (du sağa, dv öne, `off` kaldırıldı); Auto'da saklanır
 *  ama uygulanmaz. `rules` (eski) okunmaz. */
export interface LegAdjust { du: number; dv: number; off?: boolean }
export type PlinthLegs = {
  count: 4 | 5 | 6; diameter: number; side: number; front: number; rear: number; legModelId?: string | null; presetId?: string | null; rules?: LegRule[] | null;
  inner?: boolean; ownLayout?: boolean; custom?: boolean; adjust?: LegAdjust[] | null;
};
/** Auto = ayak başına Δ uygulanmaz (liste pasif); eski kayıtta `custom` yoksa Δ listesi varsa Custom. */
export const plinthLegsAuto = (legs: PlinthLegs): boolean => !(legs.custom ?? !!legs.adjust);
/** Düzen / mesafeler setin kendisinde mi (elle girildi); eski kayıtta `custom` aynı anlamdaydı. */
export const plinthOwnLayout = (legs: PlinthLegs): boolean => legs.ownLayout ?? !!legs.custom;
/** Etkin ayak düzeni: model + Ø setten; adet / mesafeler elle girildiyse setin kendisinden. Çizim, damga, engel ve kart bunu okur. */
export function plinthLegsOf(legs: PlinthLegs, st = useAppStore.getState()): PlinthLegs {
  const preset = resolveLegPreset(legs.presetId, st);
  if (!preset) return legs;
  const P = legsFromPreset(preset, st);
  return {
    ...legs, presetId: P.presetId, legModelId: P.legModelId, diameter: P.diameter,
    ...(plinthOwnLayout(legs) ? {} : { count: P.count, side: P.side, front: P.front, rear: P.rear }),
  };
}
/** ÖN yön (gövde-yerel): ayak ön/arka mesafeleri bu yöne göre; gövde parametresi (bkz. bodyFrontAxis). */
export type PlinthFacing = AxisDir;
export const PLINTH_FACINGS: PlinthFacing[] = ['z+', 'z-', 'x+', 'x-'];
export const PLINTH_FACING_LABEL: Record<string, string> = { 'z+': '+Z', 'z-': '−Z', 'x+': '+X', 'x-': '−X', 'y+': '+Y', 'y-': '−Y' };
export interface PlinthSet {
  id: string; shapeId: string; name: string;
  /** Sıralama yer tutucusu VF (store.virtualFaces içinde; `plinthId` = set). */
  vfId: string;
  /** Gövde-yerel KAPSAM kutusu: x/z = setin istendiği alan; y = [zemin, zemin + yükseklik] (taban okunurken zemine demirlenir). */
  box: CavityBox;
  legs: PlinthLegs;
  /** Bağlı alt panel: setin üst yüzü o panelin alt yüzünden canlı okunur (yükseklik oklarla değişmez). */
  bottomVfId?: string;
  /** Hızlı gövdenin kurduğu set (Body satırıyla birlikte kaldırılır / yeniden kurulur). */
  quickBody?: boolean;
  /** Eski kayıt: set başına ön yön. Yeni setlerde yok — ön yön gövdenin parametresidir (bodyFrontAxis). */
  facing?: PlinthFacing;
  createdAt: number;
}
export interface PlinthPick {
  key: string; box: CavityBox; where: 'underBottom' | 'inside'; label: string; bottomVfId?: string; facing: PlinthFacing;
  /** Aday hacmin gerçek şekli (bölge): kutular + taban çokgeni; yoksa kutu. */
  boxes?: CavityBox[]; poly?: Pt[];
}
/** Ok modu: dyn = her tık değer kadar; fixed = o eksendeki toplam ölçü = değer. */
export type ArrowMode = 'dyn' | 'fixed';

export const DEFAULT_PLINTH_LEGS: PlinthLegs = { count: 4, diameter: 50, side: 60, front: 60, rear: 60 };
export const plinthRowKey = (id: string) => `plinth-${id}`;
export const plinthSetsOf = (shapeId: string | null | undefined, sets = useAppStore.getState().plinthSets): PlinthSet[] =>
  shapeId ? sets.filter(s => s.shapeId === shapeId) : [];
export const quickPlinthSetOf = (shapeId: string, sets = useAppStore.getState().plinthSets): PlinthSet | undefined =>
  sets.find(s => s.shapeId === shapeId && s.quickBody);
export const plinthName = (s: PlinthSet) => s.name || 'Plinth';
export const plinthIsBound = (s: PlinthSet) => !!s.bottomVfId;
export const isPlinthVf = (vf: unknown): boolean => !!(vf as { plinthId?: string } | null)?.plinthId;

/** Setin VF sırası (basan/basılan); VF yoksa ∞ (herkesten sonra). */
export function plinthVfIndex(s: PlinthSet, vfs = useAppStore.getState().virtualFaces): number {
  const i = vfs.findIndex(f => f.id === s.vfId);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

/* ───────── GÖVDE YÜZ ROLLERİ (gövde parametresi `faceRoles`) ───────── */
/** `role` yoksa yön rolü otomatik kalır; `kind` = kolon / kiriş görevi (yön rolünden bağımsız). */
export interface FaceRoleOverride { descriptor: FaceDescriptor; role?: FaceRole; kind?: FaceKind }
export interface BodyFaceRoles { frontAxis?: PlinthFacing | null; overrides?: FaceRoleOverride[] }
export interface BodyFace {
  gi: number; normal: Vec3; center: Vec3; area: number; axis: AxisDir | null;
  /** Yüzün düzlem-içi ölçüleri (etiket) ve köşe kutusu (kenar eşlemesi). */
  size: [number, number]; bounds: { min: Vec3; max: Vec3 };
  descriptor: FaceDescriptor; auto: FaceRole; role: FaceRole; overridden: boolean;
  /** Özel görev (kolon yanı / kolon önü / kiriş önü / kiriş yatayı) — yalnız elle verilir. */
  kind?: FaceKind;
}
export const FACE_ROLE_ORDER: FaceRole[] = ['front', 'rear', 'left', 'right', 'top', 'bottom'];
export const bodyFaceRolesOf = (body: Shape | undefined | null): BodyFaceRoles => (body?.parameters?.faceRoles as BodyFaceRoles | undefined) ?? {};
/** Ön yön: parametre, yoksa +Z. Kapaklardan çıkarılmaz (roller kübün ayarıdır, kapak rolleri izler). */
export function bodyFrontAxis(body: Shape | undefined | null, _st = useAppStore.getState()): { facing: PlinthFacing; source: 'parameter' | 'default' } {
  const fr = bodyFaceRolesOf(body);
  if (fr.frontAxis && PLINTH_FACINGS.includes(fr.frontAxis)) return { facing: fr.frontAxis, source: 'parameter' };
  return { facing: 'z+', source: 'default' };
}
const axisOfNormal = (n: THREE.Vector3): AxisDir | null => {
  for (const [i, l] of [[0, 'x'], [1, 'y'], [2, 'z']] as Array<[number, string]>) {
    const c = n.getComponent(i);
    if (c > 0.95) return `${l}+` as AxisDir;
    if (c < -0.95) return `${l}-` as AxisDir;
  }
  return null;
};
/** Üstüne yazma eşlemesi: aynı eksen yönü (eğik yüzde normal açısı) + en yakın normalize merkez (boyut değişince de tutar). */
function matchOverride(desc: FaceDescriptor, overrides: FaceRoleOverride[]): FaceRoleOverride | null {
  let best: FaceRoleOverride | null = null, bestD = 0.3;
  const n = new THREE.Vector3(...desc.normal);
  for (const o of overrides) {
    const d = o.descriptor; if (!d) continue;
    const sameAxis = desc.axisDirection && d.axisDirection ? desc.axisDirection === d.axisDirection
      : !desc.axisDirection && !d.axisDirection ? n.dot(new THREE.Vector3(...d.normal)) > 0.9 : false;
    if (!sameAxis) continue;
    const dist = Math.hypot(...[0, 1, 2].map(i => desc.normalizedCenter[i] - d.normalizedCenter[i]));
    if (dist < bestD) { bestD = dist; best = o; }
  }
  return best;
}
const _facesCache = new Map<string, BodyFace[]>();
/** Gövdenin DÜZ yüzleri rolleriyle (otomatik + parametre); sıra: ön, arka, sol, sağ, üst, alt — her rolde alan azalan. */
export function bodyFaces(body: Shape | undefined | null, st = useAppStore.getState()): BodyFace[] {
  if (!body?.geometry) return [];
  const geo = effectiveBodyGeometry(body);
  const facing = bodyFrontAxis(body, st).facing;
  const fr = bodyFaceRolesOf(body);
  const overrides = fr.overrides ?? [];
  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
  const key = `${body.id}|${geo.uuid}|${pos?.version ?? 0}|${facing}|${JSON.stringify(overrides)}`;
  const hit = _facesCache.get(key); if (hit) return hit;
  const out: BodyFace[] = [];
  try {
    const { faces, groups } = getFacesAndGroups(geo);
    groups.forEach((g, gi) => {
      if (g.isCurved) return;
      const n = g.normal.clone().normalize();
      const bounds = { min: [Infinity, Infinity, Infinity] as Vec3, max: [-Infinity, -Infinity, -Infinity] as Vec3 };
      for (const fi of g.faceIndices) for (const v of faces[fi].vertices) for (let a = 0; a < 3; a++) {
        const c = v.getComponent(a); if (c < bounds.min[a]) bounds.min[a] = c; if (c > bounds.max[a]) bounds.max[a] = c;
      }
      const span = [0, 1, 2].map(a => bounds.max[a] - bounds.min[a]);
      const dom = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)].indexOf(Math.max(Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)));
      const inPlane = [0, 1, 2].filter(a => a !== dom);
      const face: FaceData = { faceIndex: -1, normal: n, center: g.center.clone(), vertices: [], area: g.totalArea };
      const descriptor = createFaceDescriptor(face, geo);
      const auto = roleOfNormal(n, facing);
      const ov = matchOverride(descriptor, overrides);
      out.push({
        gi, normal: [n.x, n.y, n.z], center: [g.center.x, g.center.y, g.center.z], area: g.totalArea, axis: axisOfNormal(n),
        size: [round1(span[inPlane[0]]), round1(span[inPlane[1]])], bounds, descriptor, auto, role: ov?.role ?? auto, overridden: !!ov,
        ...(isFaceKind(ov?.kind) ? { kind: ov!.kind } : {}),
      });
    });
  } catch { /* yüz çözümü başarısız → rol yok (kenarlar normalden) */ }
  out.sort((a, b) => (FACE_ROLE_ORDER.indexOf(a.role) - FACE_ROLE_ORDER.indexOf(b.role)) || (b.area - a.area));
  if (_facesCache.size > 48) _facesCache.delete(_facesCache.keys().next().value as string);
  _facesCache.set(key, out);
  return out;
}
/** Gövdenin ön yönü (parametre); null = otomatik (kapaklar / +Z). Ayaklar ve yüz rolleri bundan okunur. */
export function setBodyFrontAxis(shapeId: string, facing: PlinthFacing | null): void {
  const st = useAppStore.getState();
  const body = shapeById(shapeId, st.shapes); if (!body) return;
  const fr = bodyFaceRolesOf(body);
  const next: BodyFaceRoles = { ...fr, frontAxis: facing && facing !== 'y+' && facing !== 'y-' ? facing : null };
  st.updateShape(shapeId, { parameters: { ...body.parameters, faceRoles: next } } as Partial<Shape>);
}
/** Yüz rolü üstüne yazma (parametre). Yön rolü (ön / arka / …): otomatiğe eşitse ya da null ise kayıt silinir (yüz otomatiğe döner), özel
 *  görev kalkar. Özel görev (kolon / kiriş): yüzün yön rolü olduğu gibi kalır, yalnız görev yazılır. */
export function setBodyFaceRole(shapeId: string, gi: number, role: FaceRole | FaceKind | null): void {
  const st = useAppStore.getState();
  const body = shapeById(shapeId, st.shapes); if (!body) return;
  const face = bodyFaces(body, st).find(f => f.gi === gi); if (!face) return;
  const fr = bodyFaceRolesOf(body);
  const kept = (fr.overrides ?? []).filter(o => matchOverride(face.descriptor, [o]) === null);
  const next: FaceRoleOverride | null = isFaceKind(role)
    ? { descriptor: face.descriptor, kind: role, ...(face.role !== face.auto ? { role: face.role } : {}) }
    : role && role !== face.auto ? { descriptor: face.descriptor, role } : null;
  const overrides = next ? [...kept, next] : kept;
  st.updateShape(shapeId, { parameters: { ...body.parameters, faceRoles: { ...fr, overrides } } } as Partial<Shape>);
  // Rol / görev panelin tipini (→ bağlayıcılarını) değiştirebilir: yalnız kesicisi değişen paneller yenilenir.
  void requestRebuild(shapeId, { connectorsOnly: true });
}
/** Rolü `role` olan tüm düz yüzler (eğikler dahil): normal, merkez, alan, eksen (eğikse null); alan azalan. */
export function bodyFacesByRoleAll(body: Shape | undefined | null, role: FaceRole, st = useAppStore.getState()): Array<{ axis: AxisDir | null; bounds: { min: Vec3; max: Vec3 }; center: Vec3; normal: Vec3; area: number }> {
  return bodyFaces(body, st).filter(f => f.role === role).map(f => ({ axis: f.axis ?? null, bounds: f.bounds, center: f.center, normal: f.normal, area: f.area }));
}
/** Rolü `role` olan EKSEN-HİZALI yüzler (arkalık seçimi, baza): eksen, yön, köşe kutusu, merkez; alan azalan. */
export function bodyFacesByRole(body: Shape | undefined | null, role: FaceRole, st = useAppStore.getState()): Array<{ axis: 0 | 1 | 2; side: 1 | -1; bounds: { min: Vec3; max: Vec3 }; center: Vec3; normal: Vec3; area: number }> {
  return bodyFaces(body, st).filter(f => f.role === role && f.axis).map(f => ({
    axis: ({ x: 0, y: 1, z: 2 } as const)[f.axis![0] as 'x' | 'y' | 'z'], side: (f.axis![1] === '+' ? 1 : -1) as 1 | -1,
    bounds: f.bounds, center: f.center, normal: f.normal, area: f.area,
  }));
}
/** Gövde-yerel noktadan geçen, dış normali `n` (yatay) olan düşey gövde yüzü (rolüyle); yoksa null (panel kesiği). */
export function bodyFaceAt(body: Shape | undefined | null, p: Vec3, n: Pt, st = useAppStore.getState()): BodyFace | null {
  if (!body) return null;
  const tol = 2;
  for (const f of bodyFaces(body, st)) {
    if (Math.abs(f.normal[1]) > 0.3) continue;
    const h = Math.hypot(f.normal[0], f.normal[2]); if (h < 1e-6) continue;
    if ((f.normal[0] * n.x + f.normal[2] * n.y) / h < 0.95) continue;
    const dist = f.normal[0] * (p[0] - f.center[0]) + f.normal[1] * (p[1] - f.center[1]) + f.normal[2] * (p[2] - f.center[2]);
    if (Math.abs(dist) > tol) continue;
    if ([0, 1, 2].some(a => p[a] < f.bounds.min[a] - tol || p[a] > f.bounds.max[a] + tol)) continue;
    return f;
  }
  return null;
}
/** Noktadan geçen eş-normalli gövde yüzünün rolü; yüz yoksa null (→ otomatik). */
export const bodyFaceRoleAt = (body: Shape | undefined | null, p: Vec3, n: Pt, st = useAppStore.getState()): FaceRole | null =>
  bodyFaceAt(body, p, n, st)?.role ?? null;

/* ───────── ETKİN HACİM: bölge ───────── */
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
/** DEMİRLİ KAPSAM: taban = gövde zemini (ayak her zaman zemine basar), üst = bağlı panelin altı ya da zemin + saklı yükseklik. */
function anchoredBox(s: PlinthSet, body: Shape | undefined, shapes: Shape[]): CavityBox {
  const floor = floorOf(body);
  const h = Math.max(1, s.box.max[1] - s.box.min[1]);
  const y0 = floor ?? s.box.min[1];
  const bound = boundTopOf(s, shapes);
  const y1 = bound != null && bound - y0 > 0.5 ? bound : y0 + h;
  return { min: [s.box.min[0], y0, s.box.min[2]], max: [s.box.max[0], y1, s.box.max[2]] };
}
/** Basılan set: sırada önce gelen, y aralığıyla kesişen düşey gövde levhaları bölgeyi sınırlar; sonra gelenler sette basılır. */
function earlierSlabs(myIdx: number, box: CavityBox, body: Shape, shapes: Shape[], vfs: VirtualFace[]): CavityBox[] {
  const out: CavityBox[] = [];
  if (myIdx < 0) return out;
  const idx = new Map(vfs.map((f, i) => [f.id, i] as const));
  for (const p of childPanelsOf(body.id, shapes)) {
    const vf = vfOfPanel(p, vfs); if (!vf || vf.interior || vf.doorGroupId || vf.backGroupId) continue;
    const pi = idx.get(vf.id); if (pi == null || pi > myIdx || !p.geometry) continue;
    const b = localBboxOf(p.geometry); if (!b) continue;
    const bmin: Vec3 = [b.min.x, b.min.y, b.min.z], bmax: Vec3 = [b.max.x, b.max.y, b.max.z];
    const ov = (a: 0 | 1 | 2) => Math.min(box.max[a], bmax[a]) - Math.max(box.min[a], bmin[a]);
    if (ov(0) <= 0.5 || ov(1) <= 0.5 || ov(2) <= 0.5) continue;
    const sz = [bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2]];
    const vertical = (sz[0] <= sz[2] && sz[0] < (box.max[0] - box.min[0]) / 2) || sz[2] < (box.max[2] - box.min[2]) / 2;
    if (!vertical) continue;
    out.push({ min: bmin, max: bmax });
  }
  return out;
}
export interface PlinthRegion extends FreeRegion {
  /** Demirli kapsam kutusu (Volume düzenlemesinin okuduğu). */
  box: CavityBox;
  /** Bölgeyi kesen (kısmi) panel var mı — varsa taban çokgeni ızgaradan, yoksa gövde taban çevresinden (pah / eğik kenar tam). */
  carved: boolean;
}
const boxKey = (b: CavityBox) => [...b.min, ...b.max].map(n => Math.round(n * 10)).join(',');
const _regionCache = new Map<string, PlinthRegion>();
/** Bölgeyi kapsam kutusundan çözer (gövde içi, erken düşey levhalar dışı; tohum = kutunun zemin ortası). */
function regionForBox(body: Shape, box: CavityBox, obstacles: CavityBox[], cacheKey: string): PlinthRegion {
  const hit = _regionCache.get(cacheKey); if (hit) return hit;
  const rect = (b: CavityBox) => rectPoly(b.min[0], b.min[2], b.max[0], b.max[2]);
  const seed: Vec3 = [(box.min[0] + box.max[0]) / 2, box.min[1] + Math.min(0.5, (box.max[1] - box.min[1]) / 2), (box.min[2] + box.max[2]) / 2];
  let region: FreeRegion | null = null;
  try { region = freeRegionInBox(body, obstacles, box, seed); } catch { region = null; }
  let out: PlinthRegion;
  if (!region) out = { box, bbox: box, boxes: [box], poly: rect(box), carved: false };
  else {
    const bb = region.bbox;
    const carved = obstacles.some(o => [0, 1, 2].every(a => Math.min(bb.max[a], o.max[a]) - Math.max(bb.min[a], o.min[a]) > 0.5));
    let poly: Pt[] = region.poly;
    if (!carved) {
      const outline = bodyFloorOutline(body);
      if (outline && outline.length >= 3) { const c = clipPolyToRect(outline, bb.min[0], bb.min[2], bb.max[0], bb.max[2]); if (c.length >= 3) poly = c; }
    }
    poly = cleanPoly(poly);
    if (poly.length < 3) poly = rect(bb);
    out = { box, bbox: bb, boxes: region.boxes.length ? region.boxes : [bb], poly, carved };
  }
  if (_regionCache.size > 64) _regionCache.delete(_regionCache.keys().next().value as string);
  _regionCache.set(cacheKey, out);
  return out;
}
/** ETKİN BÖLGE: demirli kapsam kutusu içinde gövdenin içi − erken düşey levhalar; her okuyuşta çözülür (önbellekli). */
export function plinthRegionOf(s: PlinthSet, shapes = useAppStore.getState().shapes, vfs = useAppStore.getState().virtualFaces): PlinthRegion {
  const body = shapeById(s.shapeId, shapes);
  const box = anchoredBox(s, body, shapes);
  if (!body?.geometry) return { box, bbox: box, boxes: [box], poly: rectPoly(box.min[0], box.min[2], box.max[0], box.max[2]), carved: false };
  const myIdx = plinthVfIndex(s, vfs);
  const obstacles = earlierSlabs(myIdx === Number.MAX_SAFE_INTEGER ? -1 : myIdx, box, body, shapes, vfs);
  const geo = effectiveBodyGeometry(body);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
  const key = `${body.id}|${geo.uuid}|${pos?.version ?? 0}|${boxKey(box)}|${obstacles.map(boxKey).join(';')}`;
  return regionForBox(body, box, obstacles, key);
}
/** Bölgenin dış kutusu (eski kutu tüketicileri: üst üste derinlik, ok düzenleme, ölçü yazıları). */
export function plinthBoxOf(s: PlinthSet, shapes = useAppStore.getState().shapes, vfs = useAppStore.getState().virtualFaces): CavityBox {
  return plinthRegionOf(s, shapes, vfs).bbox;
}
/** Bölge kutuları (hacim çizimi / yüz seçimi / setin üstüne panel). */
export function plinthBoxesOf(s: PlinthSet, shapes?: Shape[], vfs?: VirtualFace[]): CavityBox[] {
  return plinthRegionOf(s, shapes, vfs).boxes;
}
/** Ayak kutuları: engel ve damga set hacmi değil yalnız ayaklardır (taban diski + tabla, R = 1.15·Ø/2, zeminden set üstüne). */
export function plinthLegBoxes(s: PlinthSet, shapes = useAppStore.getState().shapes, vfs?: VirtualFace[]): CavityBox[] {
  const b = plinthRegionOf(s, shapes, vfs).bbox;
  const R = legRadius(plinthLegsOf(s.legs));
  return plinthLegSpots(s, shapes).map(p => ({ min: [p.x - R, b.min[1], p.z - R] as Vec3, max: [p.x + R, b.max[1], p.z + R] as Vec3 }));
}
/** Ayak delikleri → kesiciler: her ayak modelin deliklerini kendi yerine taşır; PanelEngine son geçişte tek boolean ile çıkarır.
 *  Yalnız görünüm / katı — ayak izi, damga, sıralama kesilmemiş geometriyi okur. */
export function plinthHoleCuttersFor(panel: Shape, st = useAppStore.getState()): HoleCutter[] {
  const parentId = (panel.parameters as any)?.parentShapeId as string | undefined;
  if (!parentId) return [];
  const out: HoleCutter[] = [];
  for (const s of plinthSetsOf(parentId, st.plinthSets)) {
    const leg = legModelById(plinthLegsOf(s.legs, st).legModelId, st);
    if (!leg?.holes?.length) continue;
    const b = plinthRegionOf(s, st.shapes, st.virtualFaces).bbox;
    const y0 = b.min[1], h = Math.max(1, b.max[1] - y0);
    plinthLegSpots(s, st.shapes).forEach((p, i) => {
      out.push(...legHoleCutters(leg, h, [p.x, y0, p.z], holeId => ({ kind: 'leg', setId: s.id, legIndex: i, holeId })));
    });
  }
  return out;
}
export const plinthSize = (s: PlinthSet, shapes?: Shape[]): Vec3 => {
  const b = plinthBoxOf(s, shapes);
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
};
/** Çokgen (x, z) prizması [y0, y1]. İndeksli, yüz başına paylaşılan köşeler: onPlaneBoundaryEdges kenarları indeksle sayar
 *  (yan yüz tek dörtgen, kapak içbükey sınırı korur). Normaller dışa. */
export function prismGeometry(poly: Pt[], y0: number, y1: number): THREE.BufferGeometry {
  const p = cleanPoly(poly);
  const pos: number[] = [], idx: number[] = [];
  if (p.length >= 3) {
    const n = p.length, ccw = signedArea(p) > 0;
    // Kapaklar: üst 0..n-1, alt n..2n-1
    for (const q of p) pos.push(q.x, y1, q.y);
    for (const q of p) pos.push(q.x, y0, q.y);
    const tris = THREE.ShapeUtils.triangulateShape(p.map(q => new THREE.Vector2(q.x, q.y)), []);
    for (const [a, b, c] of tris) {
      // (x,z) düzleminde pozitif çapraz → üçgenin 3B y-normali negatif: üst kapak +Y için ters sırala
      const cross = (p[b].x - p[a].x) * (p[c].y - p[a].y) - (p[b].y - p[a].y) * (p[c].x - p[a].x);
      const [u, v] = cross > 0 ? [c, b] : [b, c];
      idx.push(a, u, v, n + a, n + v, n + u);
    }
    // Yanlar: dörtgen başına 4 vertex (a0, b0, b1, a1), dışa normal
    for (let i = 0; i < n; i++) {
      const a = p[i], b = p[(i + 1) % n], k = pos.length / 3;
      pos.push(a.x, y0, a.y, b.x, y0, b.y, b.x, y1, b.y, a.x, y1, a.y);
      if (ccw) idx.push(k, k + 2, k + 1, k, k + 3, k + 2); else idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/* ───────── AYAKLAR ───────── */
/** Setin ön yönü: eski kayıt set başına; yoksa gövde parametresi (kapaklar / +Z). */
export const plinthFacingOf = (s: Pick<PlinthSet, 'facing' | 'shapeId'>, shapes = useAppStore.getState().shapes): PlinthFacing =>
  s.facing ?? bodyFrontAxis(shapeById(s.shapeId, shapes)).facing;
const legRadius = (legs: PlinthLegs) => Math.max(10, legs.diameter / 2) * 1.15;
/** AYAK İZİ (gövde-yerel x/z çokgeni) = bölgenin taban çokgeni; diyagram ve ayak çözümü aynı çokgeni okur. */
export function plinthFootprint(s: PlinthSet, shapes = useAppStore.getState().shapes): Pt[] {
  return plinthRegionOf(s, shapes).poly;
}
/** İz çokgeninin kenar rolleri: gövde yüzüne oturan kenar o yüzün rolünü (parametre dahil) taşır; panel kesiği / kapsam kenarı normalden. */
export function plinthEdgeRoles(s: PlinthSet, shapes = useAppStore.getState().shapes, region = plinthRegionOf(s, shapes)): EdgeRole[] {
  const body = shapeById(s.shapeId, shapes);
  const facing = plinthFacingOf(s, shapes);
  const yMid = (region.bbox.min[1] + region.bbox.max[1]) / 2;
  return edgeRoles(region.poly, facing, (mid, n) => bodyFaceRoleAt(body, [mid.x, yMid, mid.y], n));
}
/** OTOMATİK ayak merkezleri (gövde-yerel x/z; Δ düzeltme uygulanmamış): köşe düzeni (etkin düzen: Auto'da setten) + kenar rolleri. */
export function plinthAutoLegSpots(s: PlinthSet, shapes = useAppStore.getState().shapes, region = plinthRegionOf(s, shapes)): Pt[] {
  const L = plinthLegsOf(s.legs);
  return autoLegPoints(region.poly, plinthEdgeRoles(s, shapes, region), { count: L.count, side: L.side, front: L.front, rear: L.rear, inner: L.inner }, plinthFacingOf(s, shapes), legRadius(L));
}
/** TÜM ayaklar otomatik sırada: otomatik nokta + CUSTOM Δ (ön çerçevede, izin içinde kıstırılmış) + kapalı mı (kart satırları / diyagram). */
export function plinthLegPoints(s: PlinthSet, shapes = useAppStore.getState().shapes): Array<{ x: number; z: number; off: boolean }> {
  const region = plinthRegionOf(s, shapes);
  const R = legRadius(plinthLegsOf(s.legs));
  const facing = plinthFacingOf(s, shapes);
  const adj = plinthLegsAuto(s.legs) ? [] : (s.legs.adjust ?? []);
  return plinthAutoLegSpots(s, shapes, region).map((p, i) => {
    const a = adj[i];
    if (!a || (!a.du && !a.dv)) return { x: p.x, z: p.y, off: !!a?.off };
    const f = toFacing(p, facing);
    const k = clampInsidePoly(fromFacing({ x: f.x + a.du, y: f.y + a.dv }, facing), region.poly, R);
    return { x: k.x, z: k.y, off: !!a.off };
  });
}
/** Ayak merkezleri (gövde-yerel x / z): otomatik düzen + Custom Δ; ayak her zaman hacmin içinde kalır. */
export function plinthLegSpots(s: PlinthSet, shapes = useAppStore.getState().shapes): Array<{ x: number; z: number }> {
  const all = plinthLegPoints(s, shapes);
  if (all.length) return all.filter(p => !p.off).map(p => ({ x: p.x, z: p.z }));
  const region = plinthRegionOf(s, shapes);
  const L = plinthLegsOf(s.legs);
  const R = legRadius(L);
  const facing = plinthFacingOf(s, shapes);
  // Son çare: dikdörtgen düzen, kutuya kıstırılmış.
  const box = region.bbox, W = box.max[0] - box.min[0], D = box.max[2] - box.min[2];
  const clamp = (v: number, lo: number, hi: number) => (hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
  return legSpotsFacing(L, W, D, facing).map(p => ({
    x: clamp(box.min[0] + p.x, box.min[0] + R, box.max[0] - R), z: clamp(box.min[2] + p.z, box.min[2] + R, box.max[2] - R),
  }));
}
const _outlineCache = new WeakMap<object, Pt[] | null>();
/** Gövde taban yüzünün (normal −Y, en alçak) dış çevresi, (x, z) — pahlı / eğik kenar tam. */
function bodyFloorOutline(body: Shape): Pt[] | null {
  const geo = effectiveBodyGeometry(body);
  if (!geo) return null;
  if (_outlineCache.has(geo)) return _outlineCache.get(geo) ?? null;
  let out: Pt[] | null = null;
  try {
    const { faces, groups } = getFacesAndGroups(geo);
    const bottoms = groups.filter(g => g.normal.y < -0.9).sort((a, b) => a.center.y - b.center.y);
    const g = bottoms[0];
    if (g) {
      const c = computeFaceComponentContour(faces, g.faceIndices, g.center.clone(), g.normal.clone().normalize());
      if (c && c.corners.length >= 3) out = c.corners.map((v: THREE.Vector3) => ({ x: v.x, y: v.z }));
    }
  } catch { out = null; }
  _outlineCache.set(geo, out);
  return out;
}
/** `legSpots` ön = +Z varsayar; ön yöne göre döndürülür (W = x açıklığı, D = z açıklığı; sonuç kutu-yerel x/z). */
export function legSpotsFacing(legs: Pick<PlinthLegs, 'count' | 'side' | 'front' | 'rear'>, W: number, D: number, facing: PlinthFacing): Array<{ x: number; z: number }> {
  if (facing === 'z+') return legSpots(legs, W, D);
  if (facing === 'z-') return legSpots(legs, W, D).map(p => ({ x: p.x, z: D - p.z }));
  // Ön ±X: derinlik ekseni X — düzen (genişlik = D, derinlik = W) hesaplanıp eksenler takas edilir.
  return legSpots(legs, D, W).map(p => ({ x: facing === 'x+' ? p.z : W - p.z, z: p.x }));
}

/* ───────── YERLEŞİM ───────── */
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

/** Aday hacimler (zeminden): (1) yükseltilmiş alt panelin altı (panele bağlanır), (2) gövde içinde zemin → varsayılan yükseklik. */
export function plinthCandidates(body: Shape, shapes: Shape[], vfs: VirtualFace[], height: number, facing: PlinthFacing = bodyFrontAxis(body).facing): PlinthPick[] {
  const bb = localBboxOf(effectiveBodyGeometry(body)); if (!bb) return [];
  const H = Math.max(1, height);
  const x0 = bb.min.x, x1 = bb.max.x, z0 = bb.min.z, z1 = bb.max.z, y0 = bb.min.y;
  const out: PlinthPick[] = [];
  const shaped = (p: PlinthPick): PlinthPick => {
    const obstacles = earlierSlabs(Number.MAX_SAFE_INTEGER - 1, p.box, body, shapes, vfs);
    const geo = effectiveBodyGeometry(body);
    const pos = geo?.getAttribute('position') as THREE.BufferAttribute | undefined;
    const r = regionForBox(body, p.box, obstacles, `pick|${body.id}|${geo?.uuid}|${pos?.version ?? 0}|${boxKey(p.box)}|${obstacles.map(boxKey).join(';')}`);
    return { ...p, boxes: r.boxes, poly: r.poly };
  };
  const bottom = bottomPanelOf(body, shapes, vfs);
  const under = bottom ? localBboxOf(bottom.panel.geometry)!.min.y : null;
  if (bottom && under != null && under - y0 > 1) {
    out.push(shaped({ key: `under:${bottom.vf.id}:${round1(under)}:${facing}`, where: 'underBottom', label: 'Under the bottom panel (follows it)', bottomVfId: bottom.vf.id,
      box: { min: [x0, y0, z0], max: [x1, under, z1] }, facing }));
  }
  const top = Math.min(y0 + H, bb.max.y);
  out.push(shaped({ key: `inside:${round1(top)}:${facing}`, where: 'inside', label: 'Inside the body, on the floor', box: { min: [x0, y0, z0], max: [x1, top, z1] }, facing }));
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
/** Kütüphanedeki set / model değişince onu okuyan her set yeniden çözülür. */
export function syncPlinthSetsUsingPreset(presetId: string | null): void {
  const st = useAppStore.getState();
  const done = new Set<string>();
  for (const s of st.plinthSets) {
    if (done.has(s.shapeId)) continue;
    const p = resolveLegPreset(s.legs.presetId, st);
    if (presetId && p && p.id !== presetId) continue;
    done.add(s.shapeId);
    syncAfterPlinthChange(s.shapeId);
  }
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

/* HACİM DÜZENLEME (Volume, raf/dikme hacmindeki gibi — yalnız Fixed / Dyn): set bölgesinin bir yüzü 3D'de seçilir, kapsam o eksende değişir. */
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
export function createPlinthSet(shapeId: string, box: CavityBox, legs: PlinthLegs, opts: { name?: string; bottomVfId?: string; quickBody?: boolean; facing?: PlinthFacing } = {}): PlinthSet {
  const st = useAppStore.getState();
  const n = plinthSetsOf(shapeId, st.plinthSets).length + 1;
  const id = genId('plinth'), vfId = genId('vf');
  const name = (opts.name || '').trim() || (n > 1 ? `Plinth ${n}` : 'Plinth');
  const set: PlinthSet = {
    id, shapeId, name, vfId,
    box: { min: [...box.min] as Vec3, max: [...box.max] as Vec3 }, legs: { ...legs }, createdAt: Date.now(),
    ...(opts.bottomVfId ? { bottomVfId: opts.bottomVfId } : {}), ...(opts.quickBody ? { quickBody: true } : {}),
  };
  // Ön yön gövdenin parametresidir: adayın yönü gövdenin yönünden farklıysa gövdeye yazılır (sete değil).
  if (opts.facing && PLINTH_FACINGS.includes(opts.facing) && bodyFrontAxis(shapeById(shapeId, st.shapes), st).facing !== opts.facing) setBodyFrontAxis(shapeId, opts.facing);
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
/** Onay: set kurulur (şeritte seçili ayak seti varsa onun düzeni / modeli; ön yön adaydan gövdeye), satırı seçilir, seçme modu kapanır. */
export function confirmPlinthPick(shapeId: string, pick: PlinthPick, name?: string): PlinthSet | null {
  const st = useAppStore.getState();
  if (!shapeById(shapeId, st.shapes)) return null;
  // Şeritte seçili set; seçilmemişse kütüphanedeki ilk set (yerleşik ayak yalnız kütüphane boşsa).
  const preset = resolveLegPreset(st.plinthPickPresetId, st);
  const legs: PlinthLegs = preset ? legsFromPreset(preset, st) : DEFAULT_PLINTH_LEGS;
  const set = createPlinthSet(shapeId, pick.box, legs, { name, bottomVfId: pick.bottomVfId, facing: pick.facing });
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
  // Yeniden kurulumda setin ayak listesi (Auto / Custom + Δ) korunur — hızlı gövde yalnız düzeni / modeli yazar.
  if (existing) st.updatePlinthSet(existing.id, { box, legs: { ...legs, custom: existing.legs.custom, adjust: existing.legs.adjust }, bottomVfId });
  placeBeforeQuickBody(shapeId, set.vfId);
}
/** Sıra: hızlı gövde ayak setinin VF'si gövdenin ilk hızlı gövde parçasının hemen önüne alınır (set basan taraftır). */
function placeBeforeQuickBody(shapeId: string, vfId: string): void {
  useAppStore.setState(s => {
    const vf = s.virtualFaces.find(f => f.id === vfId);
    if (!vf) return {};
    const rest = s.virtualFaces.filter(f => f.id !== vfId);
    const first = rest.findIndex(f => f.shapeId === shapeId && !!f.quickBody);
    if (first < 0 || s.virtualFaces[first]?.id === vfId) return {};
    return { virtualFaces: [...rest.slice(0, first), vf, ...rest.slice(first)] };
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
  // Düzen / mesafe elle girilince setin kendi değeri olur (set bağı — model, Ø — kalır); Δ listesi modu değiştirmez.
  const layout = ['count', 'side', 'front', 'rear', 'inner'].some(k => k in patch);
  const base = layout && !plinthOwnLayout(s.legs) ? plinthLegsOf(s.legs, st) : s.legs;
  const next: PlinthLegs = {
    ...s.legs, ...(layout ? { count: base.count, side: base.side, front: base.front, rear: base.rear } : {}), ...patch,
    ...(layout && !('ownLayout' in patch) ? { ownLayout: true } : {}), custom: 'custom' in patch ? patch.custom : !plinthLegsAuto(s.legs),
  };
  st.updatePlinthSet(id, { legs: next });
}
/** AUTO ↔ CUSTOM (yalnız ayak başına Δ listesi): Custom'da Δ'lar uygulanır ve düzenlenir; Auto'da saklanır, uygulanmaz. */
export function setPlinthLegsMode(id: string, mode: 'auto' | 'custom'): void {
  const st = useAppStore.getState();
  const s = st.plinthSets.find(x => x.id === id); if (!s) return;
  st.updatePlinthSet(id, { legs: { ...s.legs, ownLayout: plinthOwnLayout(s.legs), custom: mode === 'custom', adjust: s.legs.adjust ?? [] } });
}
/** Düzen / mesafeler ayak setine döner (elle girilenler bırakılır). */
export function resetPlinthLayout(id: string): void {
  const st = useAppStore.getState();
  const s = st.plinthSets.find(x => x.id === id); if (!s) return;
  st.updatePlinthSet(id, { legs: { ...s.legs, ownLayout: false, custom: !plinthLegsAuto(s.legs) } });
}
/** Ayak seti uygula: düzen + model setten, Δ'lar silinir (bağsız sette yükseklik de). Set yoksa ilk set. */
export function applyLegPresetToSet(id: string, presetId: string | null): void {
  const st = useAppStore.getState();
  const s = st.plinthSets.find(x => x.id === id); if (!s) return;
  const preset = resolveLegPreset(presetId, st);
  const keep = { custom: !plinthLegsAuto(s.legs), ownLayout: false, adjust: null };
  if (!preset) { st.updatePlinthSet(id, { legs: { ...s.legs, presetId: null, ...keep } }); syncAfterPlinthChange(s.shapeId); return; }
  st.updatePlinthSet(id, { legs: { ...legsFromPreset(preset, st), ...keep } });
  if (!plinthIsBound(s) && preset.height > 0) setPlinthHeight(id, preset.height);
  else syncAfterPlinthChange(s.shapeId);
}
/** Yükseklik: taban zeminde sabit, üst yüz oynar (bağlı sette etkisiz — üst alt panelden gelir). */
export function setPlinthHeight(id: string, h: number): void {
  const st = useAppStore.getState();
  const s = st.plinthSets.find(x => x.id === id); if (!s || plinthIsBound(s)) return;
  const v = Math.max(1, h);
  st.updatePlinthSet(id, { box: { min: [...s.box.min] as Vec3, max: [s.box.max[0], round1(s.box.min[1] + v), s.box.max[2]] } });
  syncAfterPlinthChange(s.shapeId);
}

/** Ok: X / Z o kutu yüzünü, Y yalnız üst yüzü oynatır (taban zeminde). dyn → `value` kadar, fixed → ölçü `value` olur (≥ 1 mm). */
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
