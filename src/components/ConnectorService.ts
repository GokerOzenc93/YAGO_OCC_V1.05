/* PANEL TİPLERİ + BAĞLAYICILAR — çekirdek (arayüz Accessories.tsx'te).
   1) Panel tipi kataloğu (İngilizce ad, düzlem, bölge) · yüzey → izinli tipler + varsayılan · panelin konumundan otomatik tip.
   2) Panelin kenar rolleri (ön / arka / üst / alt / sol / sağ) gövdenin yüz rollerinden okunur; bağlayıcı kuralı ve ileride kenar bandı
      aynı rolleri kullanır. 3) Kenar kuralı → kenar boyunca bağlayıcı noktaları.
   4) Bağlayıcı = delikler + çizilmiş operasyonlar (pocket / line) + modeller; hepsi TEMSİLİ BİRLEŞİM çerçevesinde (B paneli ucuyla A'nın
      yüzüne dayanır). 5) Birleşimler: kurallar gerçek panellere işlenir. Kayıt AccessoryService veritabanında (IndexedDB). */
import * as THREE from 'three';
import {
  type CavityBox, type ConnHole, type ConnOp, type ConnOpType, type ConnPart, type ConnShape, type ConnSurface, type ConnUse, type Connector, type ConnectorLayoutSet,
  type EdgeConnectorRule, type LayoutKind, type LayoutLine, type LegacyEdgeRule, type LegacyLayout, type PanelEdgeDir, type PanelGroup, type PanelSurface,
  type PanelSurfaceRule, type PanelTypeConfig, type PanelTypeId, type PanelTypeRule, type Shape, type VirtualFace, panelOfVf, requestRebuild, shapeById, useAppStore,
  vfOfPanel,
} from '../store';
import { type Vec3, effectiveBodyGeometry, footprintGeometry, genId, localBboxOf, panelHasRotation, round1 } from './Geometry';
import { type ToolSpec } from './CutWorker';
import { type HoleCutter, CONNECTOR_LAYOUTS_ID, PANEL_TYPE_CONFIG_ID, holeCutterBox, holeCutterOf, importAccessoryFile, libraryDelete, libraryPut } from './AccessoryService';
import { isDoorPanel } from './DoorService';
import { isFaceKind, roleOfNormal } from './LegLayout';
import { bodyFaces, bodyFrontAxis } from './PlinthService';
import { geoAxes, panelFrameOf } from './PanelSchematics';
import { QUICK_PANEL_NAME, QUICK_RAIL_NAME, groupName, renameMemberVfs } from './PanelGroupService';

type St = ReturnType<typeof useAppStore.getState>;

// ═════════════════════════════════════════════════ 1. PANEL TİPİ KATALOĞU ═════════════════════════════════════════════════
/** Panelin düzlemi: yan (kalınlık sol–sağ) · yatay (kalınlık üst–alt) · önsel (kalınlık ön–arka) · serbest. Kenar rolleri bundan çıkar. */
export type PanelPlane = 'side' | 'horizontal' | 'frontal' | 'any';
/** Yüzeydeki yeri: otomatik tip seçimi bununla ayırır (üst yüzde öndeki dar şerit = ön kayıt gibi). */
type PanelZone = 'full' | 'front' | 'rear' | 'top' | 'bottom';
type PanelTypeGroup = 'carcass' | 'interior' | 'traverse' | 'plinth' | 'boxing' | 'free';
export interface PanelTypeDef { id: PanelTypeId; label: string; short: string; code: string; group: PanelTypeGroup; plane: PanelPlane; zone?: PanelZone }

export const PANEL_TYPES: PanelTypeDef[] = [
  { id: 'leftSide', label: 'Left side', short: 'Left side', code: 'LS', group: 'carcass', plane: 'side' },
  { id: 'rightSide', label: 'Right side', short: 'Right side', code: 'RS', group: 'carcass', plane: 'side' },
  { id: 'top', label: 'Top panel', short: 'Top', code: 'TP', group: 'carcass', plane: 'horizontal' },
  { id: 'bottom', label: 'Bottom panel', short: 'Bottom', code: 'BP', group: 'carcass', plane: 'horizontal' },
  { id: 'rearPanel', label: 'Rear panel', short: 'Rear panel', code: 'RP', group: 'carcass', plane: 'frontal' },
  { id: 'back', label: 'Back panel', short: 'Back', code: 'BK', group: 'carcass', plane: 'frontal' },
  { id: 'divider', label: 'Divider', short: 'Divider', code: 'DV', group: 'interior', plane: 'side' },
  { id: 'fixedShelf', label: 'Fixed shelf', short: 'Fixed shelf', code: 'FS', group: 'interior', plane: 'horizontal' },
  { id: 'adjustableShelf', label: 'Adjustable shelf', short: 'Adj. shelf', code: 'AS', group: 'interior', plane: 'horizontal' },
  { id: 'topFrontRailH', label: 'Top front traverse · horizontal', short: 'Top front H', code: 'TFH', group: 'traverse', plane: 'horizontal', zone: 'front' },
  { id: 'topFrontRailV', label: 'Top front traverse · vertical', short: 'Top front V', code: 'TFV', group: 'traverse', plane: 'frontal', zone: 'top' },
  { id: 'topRearRailH', label: 'Top rear traverse · horizontal', short: 'Top rear H', code: 'TRH', group: 'traverse', plane: 'horizontal', zone: 'rear' },
  { id: 'topRearRailV', label: 'Top rear traverse · vertical', short: 'Top rear V', code: 'TRV', group: 'traverse', plane: 'frontal', zone: 'top' },
  { id: 'bottomFrontRailH', label: 'Bottom front traverse · horizontal', short: 'Bottom front H', code: 'BFH', group: 'traverse', plane: 'horizontal', zone: 'front' },
  { id: 'bottomFrontRailV', label: 'Bottom front traverse · vertical', short: 'Bottom front V', code: 'BFV', group: 'traverse', plane: 'frontal', zone: 'bottom' },
  { id: 'bottomRearRailH', label: 'Bottom rear traverse · horizontal', short: 'Bottom rear H', code: 'BRH', group: 'traverse', plane: 'horizontal', zone: 'rear' },
  { id: 'bottomRearRailV', label: 'Bottom rear traverse · vertical', short: 'Bottom rear V', code: 'BRV', group: 'traverse', plane: 'frontal', zone: 'bottom' },
  { id: 'frontPlinth', label: 'Front plinth', short: 'Front plinth', code: 'FPL', group: 'plinth', plane: 'frontal', zone: 'bottom' },
  { id: 'rearPlinth', label: 'Rear plinth', short: 'Rear plinth', code: 'RPL', group: 'plinth', plane: 'frontal', zone: 'bottom' },
  // Duvardaki kolonu / kirişi dönen paneller: gövde yüzüne "Column … / Beam …" görevi verilince o yüzün paneli bu tipi alır.
  { id: 'columnSide', label: 'Column side panel', short: 'Column side', code: 'CS', group: 'boxing', plane: 'side' },
  { id: 'columnFront', label: 'Column front panel', short: 'Column front', code: 'CF', group: 'boxing', plane: 'frontal' },
  { id: 'beamFront', label: 'Beam front panel', short: 'Beam front', code: 'BF', group: 'boxing', plane: 'frontal' },
  { id: 'beamHoriz', label: 'Beam horizontal panel', short: 'Beam horizontal', code: 'BH', group: 'boxing', plane: 'horizontal' },
  { id: 'free', label: 'Free panel', short: 'Free', code: 'FR', group: 'free', plane: 'any' },
];
const TYPE_BY_ID = new Map(PANEL_TYPES.map(t => [t.id, t]));
export const PANEL_TYPE_GROUPS: Array<{ key: PanelTypeGroup; label: string }> = [
  { key: 'carcass', label: 'Carcass' }, { key: 'interior', label: 'Interior' }, { key: 'traverse', label: 'Traverses' }, { key: 'plinth', label: 'Plinth' },
  { key: 'boxing', label: 'Column / beam' }, { key: 'free', label: 'Other' },
];
export const panelTypeDef = (id: PanelTypeId | null | undefined): PanelTypeDef | undefined => (id ? TYPE_BY_ID.get(id) : undefined);
export const panelTypeLabel = (id: PanelTypeId | null | undefined): string => panelTypeDef(id)?.label ?? 'Panel';
export const panelTypeShort = (id: PanelTypeId | null | undefined): string => panelTypeDef(id)?.short ?? 'Panel';
export const panelTypeCode = (id: PanelTypeId | null | undefined): string => panelTypeDef(id)?.code ?? '';

export const EDGE_LABEL: Record<PanelEdgeDir, string> = { front: 'Front', rear: 'Rear', top: 'Top', bottom: 'Bottom', left: 'Left', right: 'Right' };
/** Düzlem → kenar rolleri, şema sırasıyla: [üst kenar, alt kenar, sol kenar, sağ kenar] (tipin doğal bakışında). */
export const PLANE_EDGES: Record<Exclude<PanelPlane, 'any'>, [PanelEdgeDir, PanelEdgeDir, PanelEdgeDir, PanelEdgeDir]> = {
  side: ['top', 'bottom', 'rear', 'front'],          // yandan bakış: ön sağda
  horizontal: ['rear', 'front', 'left', 'right'],    // üstten bakış: ön aşağıda
  frontal: ['top', 'bottom', 'left', 'right'],       // önden bakış
};
/** Kenarın uçları [başlangıç, bitiş]: dizilim mesafeleri bu uçlardan ölçülür (derinlikte önden, genişlikte soldan, yükseklikte alttan). */
export const EDGE_ENDS: Record<Exclude<PanelPlane, 'any'>, Partial<Record<PanelEdgeDir, [PanelEdgeDir, PanelEdgeDir]>>> = {
  side: { top: ['front', 'rear'], bottom: ['front', 'rear'], front: ['bottom', 'top'], rear: ['bottom', 'top'] },
  horizontal: { front: ['left', 'right'], rear: ['left', 'right'], left: ['front', 'rear'], right: ['front', 'rear'] },
  frontal: { top: ['left', 'right'], bottom: ['left', 'right'], left: ['bottom', 'top'], right: ['bottom', 'top'] },
};
export const PLANE_LABEL: Record<Exclude<PanelPlane, 'any'>, string> = { side: 'Side view', horizontal: 'Top view', frontal: 'Front view' };

// ───────── Yüzeyler: izinli tipler + varsayılan ─────────
export const PANEL_SURFACES: Array<{ key: PanelSurface; label: string; plane: Exclude<PanelPlane, 'any'>; tool?: boolean }> = [
  { key: 'left', label: 'Left face', plane: 'side' }, { key: 'right', label: 'Right face', plane: 'side' },
  { key: 'top', label: 'Top face', plane: 'horizontal' }, { key: 'bottom', label: 'Bottom face', plane: 'horizontal' },
  { key: 'front', label: 'Front face', plane: 'frontal' }, { key: 'rear', label: 'Rear face', plane: 'frontal' },
  { key: 'columnSide', label: 'Column side', plane: 'side' }, { key: 'columnFront', label: 'Column front', plane: 'frontal' },
  { key: 'beamFront', label: 'Beam front', plane: 'frontal' }, { key: 'beamHoriz', label: 'Beam horizontal', plane: 'horizontal' },
  { key: 'shelf', label: 'Shelf tool', plane: 'horizontal', tool: true }, { key: 'divider', label: 'Divider tool', plane: 'side', tool: true },
  { key: 'back', label: 'Back tool', plane: 'frontal', tool: true },
];
const SURFACE_PLANE = Object.fromEntries(PANEL_SURFACES.map(s => [s.key, s.plane])) as Record<PanelSurface, Exclude<PanelPlane, 'any'>>;
export const surfaceLabel = (s: PanelSurface): string => PANEL_SURFACES.find(x => x.key === s)?.label ?? s;
const DEFAULT_SURFACES: Record<PanelSurface, PanelSurfaceRule> = {
  left: { allowed: ['leftSide', 'free'], def: 'leftSide' },
  right: { allowed: ['rightSide', 'free'], def: 'rightSide' },
  top: { allowed: ['top', 'topFrontRailH', 'topRearRailH', 'free'], def: 'top' },
  bottom: { allowed: ['bottom', 'bottomFrontRailH', 'bottomRearRailH', 'free'], def: 'bottom' },
  front: { allowed: ['frontPlinth', 'topFrontRailV', 'bottomFrontRailV', 'free'], def: 'frontPlinth' },
  rear: { allowed: ['rearPanel', 'rearPlinth', 'topRearRailV', 'bottomRearRailV', 'free'], def: 'rearPanel' },
  columnSide: { allowed: ['columnSide', 'free'], def: 'columnSide' },
  columnFront: { allowed: ['columnFront', 'free'], def: 'columnFront' },
  beamFront: { allowed: ['beamFront', 'free'], def: 'beamFront' },
  beamHoriz: { allowed: ['beamHoriz', 'free'], def: 'beamHoriz' },
  shelf: { allowed: ['fixedShelf', 'adjustableShelf'], def: 'fixedShelf' },
  divider: { allowed: ['divider'], def: 'divider' },
  back: { allowed: ['back'], def: 'back' },
};
/** Yüzeye KONABİLECEK tipler (arayüzde açılıp kapatılan çipler): düzlemi uyanlar + serbest. */
export const candidateTypesFor = (surface: PanelSurface): PanelTypeId[] =>
  PANEL_TYPES.filter(t => t.plane === SURFACE_PLANE[surface] || t.id === 'free').map(t => t.id);
/** Yüzey kuralı: kayıt yoksa / bozuksa varsayılan; varsayılan tip her zaman izinli listede. */
export function surfaceRuleOf(surface: PanelSurface, cfg: PanelTypeConfig = useAppStore.getState().panelTypeConfig): PanelSurfaceRule {
  const stored = cfg.surfaces?.[surface];
  const cand = new Set(candidateTypesFor(surface));
  const allowed = (stored?.allowed ?? []).filter(t => cand.has(t));
  if (!allowed.length) return DEFAULT_SURFACES[surface];
  return { allowed, def: stored && allowed.includes(stored.def) ? stored.def : allowed[0] };
}

// ═════════════════════════════════════════════════ 2. OTOMATİK TİP ═════════════════════════════════════════════════
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const bodyBoxOf = (body: Shape): THREE.Box3 | null => localBboxOf(effectiveBodyGeometry(body));
/** Gövde-yerel yön → rol: o yöne bakan en büyük gövde yüzünün rolü (elle verilmiş roller dahil); yüz yoksa ön yöne göre normalden. */
function roleOfDir(body: Shape, d: Vec3, st: St = useAppStore.getState()): PanelEdgeDir {
  let best: { role: PanelEdgeDir; area: number } | null = null;
  for (const f of bodyFaces(body, st)) if (dot3(f.normal, d) > 0.9 && (!best || f.area > best.area)) best = { role: f.role, area: f.area };
  return best?.role ?? roleOfNormal({ x: d[0], y: d[1], z: d[2] }, bodyFrontAxis(body, st).facing);
}
/** Panelin yüzeyi: iç panelde araç (raf / dikme / arkalık), gövde panelinde üstünde durduğu gövde yüzünün özel görevi (kolon / kiriş),
 *  yoksa yön rolü. Kapak / baza seti → null. */
function surfaceOfVf(vf: VirtualFace, st: St = useAppStore.getState()): PanelSurface | null {
  if (vf.doorGroupId || vf.plinthId) return null;
  if (vf.backGroupId) return 'back';
  if (vf.groupId) return st.panelGroups.find(g => g.id === vf.groupId)?.kind === 'divider' ? 'divider' : 'shelf';
  const body = shapeById(vf.shapeId, st.shapes); if (!body) return null;
  // VF'nin düzlemindeki gövde yüzü (üst üste panelde `stackDepth` kadar içeride); yoksa normalden.
  let best: { role: PanelSurface; d: number } | null = null;
  for (const f of bodyFaces(body, st)) {
    if (dot3(f.normal, vf.normal) < 0.95) continue;
    const d = Math.abs(dot3([vf.center[0] - f.center[0], vf.center[1] - f.center[1], vf.center[2] - f.center[2]], f.normal) + (vf.stackDepth ?? 0));
    // Aynı düzlemde birden çok yüz (kolonun önü + asıl arka yüz hizalıysa): panelin merkezini kapsayan kazanır.
    const inside = [0, 1, 2].every(a => Math.abs(f.normal[a]) > 0.5 || (vf.center[a] >= f.bounds.min[a] - 2 && vf.center[a] <= f.bounds.max[a] + 2));
    const score = d + (inside ? 0 : 1);
    if (!best || score < best.d - 0.5) best = { role: f.kind ?? f.role, d: score };
  }
  return best && best.d < 3 ? best.role : roleOfDir(body, vf.normal, st);
}
const boxOfPoints = (pts: Vec3[]): THREE.Box3 | null => (pts.length ? new THREE.Box3().setFromPoints(pts.map(p => new THREE.Vector3(...p))) : null);
/** Yüzeydeki yer: yüzeyin yarısından fazlasını kaplıyorsa 'full'; değilse hangi yarıda olduğu. Sol / sağ yüzde hep 'full'. */
function zoneOfVf(vf: VirtualFace, surface: PanelSurface, st: St = useAppStore.getState()): PanelZone {
  const body = shapeById(vf.shapeId, st.shapes); if (!body) return 'full';
  const bb = bodyBoxOf(body), panel = vf.hasPanel ? panelOfVf(vf.id, st.shapes) : undefined;
  const pb = (panel?.geometry ? localBboxOf(panel.geometry) : null) ?? boxOfPoints(vf.vertices);
  if (!bb || !pb) return 'full';
  const along = (axis: number, sign: number, hi: PanelZone, lo: PanelZone): PanelZone => {
    const b0 = bb.min.getComponent(axis), b1 = bb.max.getComponent(axis), p0 = pb.min.getComponent(axis), p1 = pb.max.getComponent(axis);
    if (b1 - b0 < 1e-6 || (p1 - p0) / (b1 - b0) >= 0.5) return 'full';
    return sign * ((p0 + p1) / 2 - (b0 + b1) / 2) >= 0 ? hi : lo;
  };
  if (surface === 'top' || surface === 'bottom') {
    const f = bodyFrontAxis(body, st).facing as string;
    return along(f[0] === 'x' ? 0 : 2, f[1] === '-' ? -1 : 1, 'front', 'rear');
  }
  if (surface === 'front' || surface === 'rear') return along(1, 1, 'top', 'bottom');
  return 'full';
}
const fitsZone = (t: PanelTypeDef, zone: PanelZone) => (t.zone ? t.zone === zone : t.id !== 'free' && zone === 'full');
/** İzinli tipler arasında (varsayılan önce) bölgeye uyan ilk tip; hiçbiri uymuyorsa serbest (izinliyse) ya da varsayılan. */
function pickTypeForZone(rule: PanelSurfaceRule, zone: PanelZone): PanelTypeId {
  for (const id of [rule.def, ...rule.allowed.filter(t => t !== rule.def)]) { const t = TYPE_BY_ID.get(id); if (t && fitsZone(t, zone)) return id; }
  return rule.allowed.includes('free') ? 'free' : rule.def;
}
/** Hızlı gövde parçası → tip (kayıt yatay mı dikey mi: VF normalinden). */
function quickBodyType(vf: VirtualFace): PanelTypeId | null {
  const key = String(vf.quickBody).split('#')[0], flat = Math.abs(vf.normal[1]) > 0.7;
  switch (key) {
    case 'top': return 'top'; case 'bottom': return 'bottom'; case 'left': return 'leftSide'; case 'right': return 'rightSide';
    case 'plinth': return 'frontPlinth'; case 'rearPlinth': return 'rearPlinth';
    case 'topFront': return flat ? 'topFrontRailH' : 'topFrontRailV'; case 'topRear': return flat ? 'topRearRailH' : 'topRearRailV';
    case 'bottomFront': return flat ? 'bottomFrontRailH' : 'bottomFrontRailV'; case 'bottomRear': return flat ? 'bottomRearRailH' : 'bottomRearRailV';
    default: return null;
  }
}
/** KONUMDAN otomatik tip (elle seçim yok sayılır). Yerleşmemiş (önizleme) VF'de de çalışır. */
function autoPanelType(vf: VirtualFace, st: St = useAppStore.getState()): PanelTypeId | null {
  const surface = surfaceOfVf(vf, st); if (!surface) return null;
  // Yüze elle kolon / kiriş görevi verilmişse o kazanır (hızlı gövde parçasında da).
  if (vf.quickBody && !isFaceKind(surface)) { const q = quickBodyType(vf); if (q) return q; }
  const rule = surfaceRuleOf(surface, st.panelTypeConfig);
  if (vf.groupId || vf.backGroupId) return rule.def;
  return pickTypeForZone(rule, zoneOfVf(vf, surface, st));
}
const groupOfVf = (vf: VirtualFace, st: St): PanelGroup | undefined => (vf.groupId ? st.panelGroups.find(g => g.id === vf.groupId) : undefined);
/** Panelin tipi: elle seçim → grubun tipi → otomatik. Bağlayıcıların gerçek panellere işlenmesi (sonraki adım) bunu okur. */
export function panelTypeOf(vf: VirtualFace | undefined | null, st: St = useAppStore.getState()): PanelTypeId | null {
  if (!vf) return null;
  return vf.panelType ?? groupOfVf(vf, st)?.panelType ?? autoPanelType(vf, st);
}
export interface PanelTypeChoice { surface: PanelSurface; current: PanelTypeId; auto: PanelTypeId; manual: boolean; options: PanelTypeId[] }
/** Satırdaki tip seçimi: yalnız o yüzeyin izinli tipleri (geçerli tip listede yoksa başa eklenir). */
export function panelTypeChoice(vf: VirtualFace, st: St = useAppStore.getState()): PanelTypeChoice | null {
  const surface = surfaceOfVf(vf, st); if (!surface) return null;
  const auto = groupOfVf(vf, st)?.panelType ?? autoPanelType(vf, st); if (!auto) return null;
  const current = vf.panelType ?? auto, allowed = surfaceRuleOf(surface, st.panelTypeConfig).allowed;
  const options = [...new Set([...(allowed.includes(current) ? [] : [current]), ...(allowed.includes(auto) ? [] : [auto]), ...allowed])];
  return { surface, current, auto, manual: !!vf.panelType && vf.panelType !== auto, options };
}
/* PANEL ADI = ROL. Elle ad yazılmamışsa panel, tipinin (rolünün) adını taşır ve tip değişince ad da değişir. Boş ad ile eski otomatik adlar
   ("Panel", hızlı gövdenin "Top" · "Left 2" · "Plinth" …) elle yazılmış SAYILMAZ. */
let _genericNames: Set<string> | null = null;
const genericNames = (): Set<string> =>
  (_genericNames ??= new Set([...Object.values(QUICK_PANEL_NAME), ...Object.values(QUICK_RAIL_NAME), 'Plinth', 'Rear plinth'].map(n => n.toLowerCase())));
/** Panele ELLE yazılmış ad (yoksa boş). */
export function customPanelName(vf: Pick<VirtualFace, 'description' | 'quickBody'>): string {
  const d = (vf.description ?? '').trim();
  if (!d || d.toLowerCase() === 'panel') return '';
  return vf.quickBody && genericNames().has(d.replace(/ \d+$/, '').toLowerCase()) ? '' : d;
}
/** Panelin görünen adı: elle ad → raf / dikme üyesinde grubun adı → rolün adı. Tipsiz satırda (kapak, arkalık parçası, baza seti) kayıtlı ad. */
export function panelNameOf(vf: VirtualFace | undefined | null, st: St = useAppStore.getState()): string {
  if (!vf) return 'Panel';
  const group = groupOfVf(vf, st);
  if (group) return groupName(group);
  if (vf.doorGroupId || vf.backGroupId || vf.plinthId) return vf.description?.trim() || 'Panel';
  return customPanelName(vf) || panelTypeLabel(panelTypeOf(vf, st));
}
/** Yerleştirme şeridinde seçilen tip → VF'ye yazılacak değer: o yüzeyde sunulmuyorsa ya da otomatiğe eşitse yazılmaz (panel konumunu izler). */
export function placementTypeFor(vf: VirtualFace, picked: PanelTypeId | null, st: St = useAppStore.getState()): PanelTypeId | undefined {
  const c = picked ? panelTypeChoice({ ...vf, panelType: undefined }, st) : null;
  return c && picked && c.options.includes(picked) && picked !== c.auto ? picked : undefined;
}
/** Elle tip: otomatiğe eşitse kayıt silinir (panel konumunu izlemeye devam eder). */
export function setVfPanelType(vfId: string, type: PanelTypeId | null): void {
  const st = useAppStore.getState(), vf = st.virtualFaces.find(f => f.id === vfId); if (!vf) return;
  const auto = groupOfVf(vf, st)?.panelType ?? autoPanelType({ ...vf, panelType: undefined }, st);
  st.updateVirtualFace(vfId, { panelType: type && type !== auto ? type : undefined });
  refreshConnectorBodies(vf.shapeId);
}
/** Raf / dikme grubunun tipi: tüm üyeler (üyede elle seçim varsa o kalır). */
export function setGroupPanelType(groupId: string, type: PanelTypeId | null): void {
  useAppStore.setState(s => ({ panelGroups: s.panelGroups.map(g => (g.id === groupId ? { ...g, panelType: type ?? undefined } : g)) }));
  const g = useAppStore.getState().panelGroups.find(x => x.id === groupId);
  // Adı role bağlı grupta üyelerin kayıtlı adı da yeni rolün adına döner.
  if (g) renameMemberVfs(g.memberVfIds, groupName(g));
  refreshConnectorBodies(g?.shapeId);
}

// ═════════════════════════════════════════════════ 3. KENAR ROLLERİ ═════════════════════════════════════════════════
export interface PanelEdgeInfo { role: PanelEdgeDir; dir: Vec3; length: number }
export interface PanelOrientation {
  plane: Exclude<PanelPlane, 'any'>; thickness: number;
  /** Geniş yüzlerin baktığı roller (kalınlık ekseninin + ve − ucu). */
  faces: [PanelEdgeDir, PanelEdgeDir];
  /** Dört kenar (panelin kendi çerçevesindeki kutunun kenarları); `dir` kenarın gövde-yerel dış yönü, `length` kenarın boyu. */
  edges: PanelEdgeInfo[];
}
const PLANE_OF_ROLE: Record<PanelEdgeDir, Exclude<PanelPlane, 'any'>> = { left: 'side', right: 'side', top: 'horizontal', bottom: 'horizontal', front: 'frontal', rear: 'frontal' };
/** PANELİN YÖNÜ: kalınlık ekseni ve her kenarın rolü — panelin kendi çerçevesinde (dönmüş / eğik panelde de) gövde yüz rollerinden. */
export function panelOrientation(panel: Shape | undefined | null, st: St = useAppStore.getState()): PanelOrientation | null {
  if (!panel?.geometry || panel.parameters?.curved) return null;
  const body = shapeById(panel.parameters?.parentShapeId, st.shapes); if (!body) return null;
  const fr = panelFrameOf(panel), ax = fr ? geoAxes(fr.geo) : null; if (!fr || !ax) return null;
  const toBody = fr.inv.clone().invert();
  const dirOf = (i: number, sign: number): Vec3 => { const v = new THREE.Vector3().setComponent(i, sign).applyQuaternion(toBody); return [v.x, v.y, v.z]; };
  const thin = ax.axes[0].i, inPlane = [0, 1, 2].filter(i => i !== thin);
  const faces: [PanelEdgeDir, PanelEdgeDir] = [roleOfDir(body, dirOf(thin, 1), st), roleOfDir(body, dirOf(thin, -1), st)];
  const edges: PanelEdgeInfo[] = [];
  for (const i of inPlane) for (const sign of [1, -1]) {
    const dir = dirOf(i, sign), other = inPlane.find(k => k !== i)!;
    edges.push({ role: roleOfDir(body, dir, st), dir, length: round1(ax.size.getComponent(other)) });
  }
  return { plane: PLANE_OF_ROLE[faces[0]], thickness: round1(ax.size.getComponent(thin)), faces, edges };
}

// ═════════════════════════════════════════════════ 4. TİP KURALLARI (kenar → bağlayıcı) ═════════════════════════════════════════════════
const typeRuleOf = (type: PanelTypeId, cfg: PanelTypeConfig = useAppStore.getState().panelTypeConfig): PanelTypeRule => cfg.rules?.[type] ?? { edges: {} };
/** Kenarın kuralları (dizilimi atanmış olanlar). */
const rulesIn = (edges: PanelTypeRule['edges'] | undefined, edge: PanelEdgeDir): EdgeConnectorRule[] => {
  const v = edges?.[edge] as EdgeConnectorRule[] | EdgeConnectorRule | undefined;
  return (Array.isArray(v) ? v : v ? [v] : []).filter(r => !!r?.layoutId);
};
export const edgeRulesOf = (type: PanelTypeId, edge: PanelEdgeDir, cfg?: PanelTypeConfig): EdgeConnectorRule[] => rulesIn(typeRuleOf(type, cfg).edges, edge);
const ruleHasLayout = (rule: PanelTypeRule | undefined): boolean => !!rule && (Object.keys(rule.edges ?? {}) as PanelEdgeDir[]).some(e => rulesIn(rule.edges, e).length > 0);

/* ───────── DİZİLİM (Accessories › Layout): satır = bağlayıcı (bir ya da iki) + boy aralığı + dört kuraldan biri ───────── */
export const LAYOUT_PITCH = 32, MAX_LAYOUT_STEPS = 12, MAX_LAYOUT_POINTS = 24;
export const LAYOUT_KINDS: Array<{ key: LayoutKind; label: string; sub: string }> = [
  { key: 'ends', label: 'Ends + middle', sub: 'fixed from both ends, one in the middle on long joints' },
  { key: 'grid', label: '32 grid', sub: 'fixed front, rear on the grid, middle on long joints' },
  { key: 'steps', label: 'Steps', sub: 'walk from the front: step 1, step 2, step 3 …' },
  { key: 'list', label: 'List', sub: 'every connector typed in, from the front or the rear' },
];
export const layoutKindLabel = (k: LayoutKind): string => LAYOUT_KINDS.find(x => x.key === k)?.label ?? k;
/** Yeni satır: baştan + sondan 50, 600 mm'den sonra ortaya; her boyda geçerli. Öteki kuralların değerleri de hazır gelir (kural değişince
 *  boş kalmasın): adımlar 256 · 224, liste = baştan 50 + sondan 50. */
export const newLayoutLine = (connectorId: string | null, init: Partial<LayoutLine> = {}): LayoutLine => ({
  id: genId('ll'), connectorId, kind: 'ends', min: 0, max: 0, start: 50, end: 50, midFrom: 600, pitch: LAYOUT_PITCH,
  steps: [{ d: 256, n: 1 }, { d: 224, n: 1 }], points: [{ from: 'start', d: 50 }, { from: 'end', d: 50 }], ...init,
});
export const newLayoutSet = (name = 'Layout', connectorId: string | null = null): ConnectorLayoutSet =>
  ({ id: genId('lay'), name, lines: [newLayoutLine(connectorId)], createdAt: Date.now() });
export const cloneLayoutSet = (l: ConnectorLayoutSet): ConnectorLayoutSet => JSON.parse(JSON.stringify(l)) as ConnectorLayoutSet;
/** Satır bu birleşim boyunda geçerli mi (boy tam mm'ye yuvarlanır: "40 – 99" ile "100 – 500" arasında boşluk kalmaz). */
export const lineApplies = (l: Pick<LayoutLine, 'min' | 'max'>, length: number): boolean => {
  const L = Math.round(length);
  return L >= (l.min || 0) && (!(l.max > 0) || L <= l.max);
};
/** Satır iki bağlayıcılı mı: 2. yuva açık (boş da olabilir) ve 1. ile aynı bağlayıcı değil. */
export const lineHasSecond = (l: Pick<LayoutLine, 'connectorId' | 'connector2Id'>): boolean =>
  l.connector2Id !== undefined && (l.connector2Id === null || l.connector2Id !== l.connectorId);
/** Satırın bağlayıcı kimlikleri [1., 2.] (2. yuva kapalıysa null). */
export const lineConnectorIds = (l: Pick<LayoutLine, 'connectorId' | 'connector2Id'>): [string | null, string | null] =>
  [l.connectorId, lineHasSecond(l) ? l.connector2Id ?? null : null];
/** 2. bağlayıcıyı açar / değiştirir (`id` null = yuva açık, bağlayıcı seçilmemiş) ya da kaldırır (`undefined`): kaldırınca nokta seçimleri de
 *  silinir — bütün noktalar yine 1. bağlayıcıya gider, yuva yeniden açılınca eski seçimler geri gelmez. */
export function secondConnectorPatch(l: LayoutLine, id: string | null | undefined): Partial<LayoutLine> {
  if (id !== undefined) return { connector2Id: id };
  return { connector2Id: undefined, use: undefined, steps: l.steps.map(({ d, n }) => ({ d, n })), points: l.points.map(({ from, d }) => ({ from, d })) };
}
export interface LinePoint { d: number; use: ConnUse }
/** Satırın noktaları (birleşimin başından mm) + her noktaya gelen bağlayıcı — boy aralığına BAKMADAN. Baş + son mesafesine sığmayan
 *  birleşimde tek nokta ortada (baş noktasının bağlayıcısıyla). 'grid' / 'steps': son delik sondan EN AZ `end` uzakta kalır; 'steps'te
 *  sığmayan adım atlanır, sıra sonrakine geçer. Tek bağlayıcılı satırda bütün noktalar 1. bağlayıcınındır (kayıtlı seçimler okunmaz);
 *  aynı yere düşen noktaların seçimleri birleşir. */
export function linePoints(l: LayoutLine, length: number): LinePoint[] {
  if (!(length > 0)) return [];
  const two = lineHasSecond(l), by = new Map<number, number>();
  const put = (d: number, c?: ConnUse) => { const k = round1(d); by.set(k, (by.get(k) ?? 0) | (two && c ? c : 1)); };
  const a = Math.max(0, l.start), b = length - Math.max(0, l.end), mid = l.midFrom > 0 && length >= l.midFrom - 1e-6;
  if (l.kind === 'list') { for (const p of l.points) { const d = p.from === 'end' ? length - p.d : p.d; if (d >= 0 && d <= length) put(d, p.c); } }
  else if (l.kind === 'ends') {
    if (b - a < 1) put(length / 2, l.use?.start);
    else { put(a, l.use?.start); if (mid && length / 2 - a > 1 && b - length / 2 > 1) put(length / 2, l.use?.mid); put(b, l.use?.end); }
  } else if (b - a < -1e-6) put(length / 2, l.use?.start);
  else if (l.kind === 'grid') {
    const pitch = l.pitch > 0 ? l.pitch : LAYOUT_PITCH, m = Math.floor((b - a) / pitch + 1e-6);
    put(a, l.use?.start);
    if (m >= 2 && mid) put(a + Math.round(m / 2) * pitch, l.use?.mid);
    if (m >= 1) put(a + m * pitch, l.use?.end);
  } else {
    put(a, l.use?.start);
    let pos = a, count = 1;
    for (const st of l.steps) {
      const d = Math.max(1, st.d);
      for (let i = 0; (st.n <= 0 || i < st.n) && pos + d <= b + 1e-6 && count < 80; i++) { pos += d; count++; put(pos, st.c); }
    }
  }
  return [...by].sort((x, y) => x[0] - y[0]).map(([d, use]) => ({ d, use: use as ConnUse }));
}
/** Satırın nokta mesafeleri: `slot` verilirse yalnız o bağlayıcının (1. / 2.) noktaları. */
export const linePositions = (l: LayoutLine, length: number, slot?: 1 | 2): number[] =>
  linePoints(l, length).filter(p => !slot || (p.use & slot) !== 0).map(p => p.d);
/** Satırın tek satırlık özeti. */
export function lineSummary(l: LayoutLine): string {
  const f = (v: number) => String(round1(v));
  if (l.kind === 'ends') return `${f(l.start)} / ${f(l.end)}${l.midFrom > 0 ? ` · middle from ${f(l.midFrom)}` : ''}`;
  if (l.kind === 'grid') return `${f(l.start)} / min ${f(l.end)} on ${f(l.pitch)}${l.midFrom > 0 ? ` · middle from ${f(l.midFrom)}` : ''}`;
  if (l.kind === 'steps') return `${f(l.start)} + ${l.steps.map(s => `${f(s.d)}${s.n === 1 ? '' : s.n > 1 ? `×${s.n}` : '×fit'}`).join(' + ')} · min ${f(l.end)}`;
  return l.points.map(p => `${p.from === 'end' ? '←' : ''}${f(p.d)}${p.from === 'end' ? '' : '→'}`).join(' · ') || 'empty';
}
export const lineRangeText = (l: Pick<LayoutLine, 'min' | 'max'>): string =>
  (l.max > 0 ? `${round1(l.min || 0)} – ${round1(l.max)} mm` : l.min > 0 ? `from ${round1(l.min)} mm` : 'any length');
async function saveLayoutSets(sets: ConnectorLayoutSet[]): Promise<void> {
  useAppStore.getState().setConnectorLayouts(sets);
  refreshConnectorBodies();
  await libraryPut('settings', { id: CONNECTOR_LAYOUTS_ID, sets });
}
export function saveLayoutSet(set: ConnectorLayoutSet): Promise<void> {
  const list = useAppStore.getState().connectorLayouts;
  return saveLayoutSets(list.some(x => x.id === set.id) ? list.map(x => (x.id === set.id ? set : x)) : [...list, set]);
}
/** Dizilimi siler; onu kullanan kenarlar boşalır. */
export async function deleteLayoutSet(id: string): Promise<void> {
  const st = useAppStore.getState();
  await saveLayoutSets(st.connectorLayouts.filter(x => x.id !== id));
  const next = mapEdgeRules(st.panelTypeConfig, list => list.filter(r => r.layoutId !== id));
  if (next) await savePanelTypeConfig(next);
}
/** Dizilimi kullanan kenar sayısı (liste rozeti). */
export const layoutUseCount = (id: string, cfg: PanelTypeConfig = useAppStore.getState().panelTypeConfig): number =>
  Object.values(cfg.rules ?? {}).reduce((n, r) => n + (Object.keys(r?.edges ?? {}) as PanelEdgeDir[]).filter(e => rulesIn(r!.edges, e).some(x => x.layoutId === id)).length, 0);
/** Bütün kenar listelerini dönüştürür; hiçbiri değişmediyse null. */
function mapEdgeRules(cfg: PanelTypeConfig, fn: (list: EdgeConnectorRule[], type: PanelTypeId, edge: PanelEdgeDir) => EdgeConnectorRule[]): PanelTypeConfig | null {
  const rules: PanelTypeConfig['rules'] = {};
  let touched = false;
  for (const [type, rule] of Object.entries(cfg.rules ?? {}) as Array<[PanelTypeId, PanelTypeRule]>) {
    const edges: PanelTypeRule['edges'] = {};
    for (const e of Object.keys(rule.edges ?? {}) as PanelEdgeDir[]) {
      const all = (rule.edges[e] ?? []) as EdgeConnectorRule[], kept = fn(all, type, e);
      if (kept !== all && JSON.stringify(kept) !== JSON.stringify(all)) touched = true;
      if (kept.length) edges[e] = kept;
    }
    rules[type] = { edges };
  }
  return touched ? { ...cfg, rules } : null;
}
async function savePanelTypeConfig(cfg: PanelTypeConfig): Promise<void> {
  useAppStore.getState().setPanelTypeConfig(cfg);
  refreshConnectorBodies();
  await libraryPut('settings', { id: PANEL_TYPE_CONFIG_ID, ...cfg });
}
/** Kenara dizilim atar (`layoutId` null → kenardan bağlayıcılar kalkar). */
export function setEdgeLayout(type: PanelTypeId, edge: PanelEdgeDir, layoutId: string | null, flipFace = false): Promise<void> {
  const cfg = useAppStore.getState().panelTypeConfig, edges = { ...typeRuleOf(type, cfg).edges };
  if (layoutId) edges[edge] = [{ layoutId, ...(flipFace ? { flipFace: true } : {}) }]; else delete edges[edge];
  return savePanelTypeConfig({ ...cfg, rules: { ...cfg.rules, [type]: { edges } } });
}
export function setSurfaceRule(surface: PanelSurface, rule: PanelSurfaceRule): Promise<void> {
  const cfg = useAppStore.getState().panelTypeConfig;
  return savePanelTypeConfig({ ...cfg, surfaces: { ...cfg.surfaces, [surface]: rule } });
}
/** Tipi kullanan kenar kuralı sayısı (liste rozeti). */
export const typeEdgeCount = (type: PanelTypeId, cfg?: PanelTypeConfig): number => {
  const edges = typeRuleOf(type, cfg).edges;
  return (Object.keys(edges) as PanelEdgeDir[]).filter(e => rulesIn(edges, e).length > 0).length;
};
/** Kenardaki bağlayıcıların adları (atanmış dizilimin satırlarından, tekrarsız). */
export function edgeConnectorNames(type: PanelTypeId, edge: PanelEdgeDir, st: St = useAppStore.getState()): string[] {
  const ids = edgeRulesOf(type, edge, st.panelTypeConfig).flatMap(r => st.connectorLayouts.find(x => x.id === r.layoutId)?.lines ?? []).flatMap(lineConnectorIds);
  return [...new Set(ids)].map(id => st.connectors.find(c => c.id === id)?.name).filter((x): x is string => !!x);
}

// ═════════════════════════════════════════════════ 5. BAĞLAYICI ═════════════════════════════════════════════════
/* TEMSİLİ BİRLEŞİM çerçevesi (mm): x = A'nın yüzünden B'nin içine · y = B'nin kalınlığı boyunca (0 = ortası) · z = birleşim çizgisi
   (0 = bağlayıcı noktası). A paneli x ∈ [−tA, 0], B paneli x ∈ [0, bLen], y ∈ [−tB/2, tB/2]. `along` = −z: B tarafından bakınca (varsayılan
   kamera) along + sağa gider, düz çizim alanıyla aynı yön. */
export const CONN_REP = { width: 160, bLen: 150, aHeight: 190 } as const;
const CONN_DEFAULT_T = 18;
export const CONN_SURFACES: Array<{ v: ConnSurface; label: string; short: string; across: string; hint: string }> = [
  { v: 'bFace', label: 'Butting panel · face', short: 'B face', across: 'From joint', hint: 'Wide face of the panel that butts with its end' },
  { v: 'bEdge', label: 'Butting panel · edge', short: 'B edge', across: 'From centre', hint: 'End (thickness) of the butting panel — the face that touches the other panel' },
  { v: 'aFace', label: 'Passing panel · face', short: 'A face', across: 'From centre', hint: 'Face of the panel that runs through, where the other panel lands' },
];
export const connThickness = (c: Pick<Connector, 'tA' | 'tB'>): { tA: number; tB: number } =>
  ({ tA: c.tA && c.tA > 0 ? c.tA : CONN_DEFAULT_T, tB: c.tB && c.tB > 0 ? c.tB : CONN_DEFAULT_T });
/** Yüzey noktası → temsili sahne: konum + DIŞ normal. `gap` = patlatılmış görünüşte B'nin A'dan uzaklığı. */
export function connSurfacePoint(surface: ConnSurface, along: number, across: number, tB: number, gap = 0): { pos: Vec3; normal: Vec3 } {
  if (surface === 'bFace') return { pos: [gap + across, tB / 2, -along], normal: [0, 1, 0] };
  if (surface === 'bEdge') return { pos: [gap, across, -along], normal: [-1, 0, 0] };
  return { pos: [0, across, -along], normal: [1, 0, 0] };
}
/** Sahne noktası → yüzey koordinatı (0,5 mm'ye yuvarlanır). */
export function connSurfaceCoords(surface: ConnSurface, p: Vec3, gap = 0): { along: number; across: number } {
  const r = (v: number) => Math.round(v * 2) / 2;
  return surface === 'bFace' ? { along: r(-p[2]), across: r(p[0] - gap) } : { along: r(-p[2]), across: r(p[1]) };
}
/** Yüzeyin 2B sınırı (x = along, y = across) — çizim alanı ve tıklanabilir bölge. */
export function connSurfaceExtent(surface: ConnSurface, tB: number): { x0: number; x1: number; y0: number; y1: number } {
  const w = CONN_REP.width / 2;
  if (surface === 'bFace') return { x0: -w, x1: w, y0: 0, y1: CONN_REP.bLen };
  if (surface === 'bEdge') return { x0: -w, x1: w, y0: -tB / 2, y1: tB / 2 };
  return { x0: -w, x1: w, y0: -CONN_REP.aHeight / 2, y1: CONN_REP.aHeight / 2 };
}
/** Yüzeyin altındaki malzeme kalınlığı (delik / operasyon en çok bu kadar derin; ≥ ise boydan boya). */
export const connSurfaceDepth = (surface: ConnSurface, tA: number, tB: number): number => (surface === 'bFace' ? tB : surface === 'bEdge' ? CONN_REP.bLen : tA);

export const newConnector = (name = 'Connector'): Connector =>
  ({ id: genId('conn'), name, holes: [], ops: [], parts: [], tA: CONN_DEFAULT_T, tB: CONN_DEFAULT_T, createdAt: Date.now() });
export const newConnHole = (init: Partial<ConnHole> = {}): ConnHole => ({ id: genId('ch'), surface: 'bFace', along: 0, across: 0, diameter: 8, depth: 12, ...init });
export const newConnOp = (surface: ConnSurface, type: ConnOpType = 'pocket', init: Partial<ConnOp> = {}): ConnOp =>
  ({ id: genId('cop'), surface, type, depth: 5, width: 6, shapes: [], ...init });
export const newConnPart = (modelId: string, init: Partial<ConnPart> = {}): ConnPart =>
  ({ id: genId('cp'), modelId, surface: 'bFace', along: 0, across: 0, inset: 0, spin: 0, ...init });
export const cloneConnector = (c: Connector): Connector => JSON.parse(JSON.stringify(c)) as Connector;
/** Kapalı çevre mi (pocket bunlarla çalışır). */
export const connShapeClosed = (s: ConnShape): boolean =>
  s.t === 'circle' || (s.t === 'pline' && (!!s.closed || (s.v.length > 2 && Math.hypot(s.v[0].x - s.v[s.v.length - 1].x, s.v[0].y - s.v[s.v.length - 1].y) < 1e-6)));
/** Nesnenin çizgi noktaları (daire dilimlenir; kapalıysa ilk nokta sona eklenir). */
export function connShapePoints(s: ConnShape, seg = 48): Array<{ x: number; y: number }> {
  if (s.t === 'line') return [s.a, s.b];
  if (s.t === 'circle') return Array.from({ length: seg + 1 }, (_, i) => { const a = (i / seg) * Math.PI * 2; return { x: s.c.x + Math.cos(a) * s.r, y: s.c.y + Math.sin(a) * s.r }; });
  return s.closed && s.v.length > 1 ? [...s.v, s.v[0]] : s.v;
}
export const connOpSummary = (op: ConnOp): string => {
  const n = op.shapes.length, open = op.type === 'pocket' ? op.shapes.filter(s => !connShapeClosed(s)).length : 0;
  return `${n} shape${n === 1 ? '' : 's'}${open ? ` · ${open} open` : ''}`;
};
export async function saveConnector(c: Connector): Promise<void> {
  useAppStore.getState().upsertConnector(c);
  refreshConnectorBodies();
  await libraryPut('connectors', c);
}
/** Bağlayıcıyı siler; dizilimlerde onu kullanan satırların o yuvası bağlayıcısız kalır (satır durur, yeni bağlayıcı seçilir). */
export async function deleteConnector(id: string): Promise<void> {
  const st = useAppStore.getState();
  st.removeConnector(id);
  refreshConnectorBodies();
  await libraryDelete('connectors', id);
  if (st.connectorLayouts.some(x => x.lines.some(l => l.connectorId === id || l.connector2Id === id)))
    await saveLayoutSets(st.connectorLayouts.map(x => ({ ...x, lines: x.lines.map(l => (l.connectorId === id || l.connector2Id === id
      ? { ...l, ...(l.connectorId === id ? { connectorId: null } : {}), ...(l.connector2Id === id ? { connector2Id: null } : {}) } : l)) })));
}
/** Bağlayıcıyı kullanan dizilim sayısı (liste rozeti). */
export const connectorUseCount = (id: string, sets: ConnectorLayoutSet[] = useAppStore.getState().connectorLayouts): number =>
  sets.filter(x => x.lines.some(l => lineConnectorIds(l).includes(id))).length;

// ═════════════════════════════════════════════════ 6. BİRLEŞİMLER: bağlayıcının gerçek panellere atılması ═════════════════════════════════════════════════
/* BİRLEŞİM = B panelinin UCU (kalınlık yüzü) A panelinin geniş yüzüne dayanıyor. B'nin tipinde o kenar için bağlayıcı tanımlıysa temas
   boyunca bağlayıcı noktaları dizilir; her noktada bağlayıcının delikleri / operasyonları B'ye (yüz + uç) ve A'ya (temas yüzü) kesilir, modeli
   sahneye konur. Yalnız eksene hizalı (dönmemiş, düz) paneller; kapaklar birleşime girmez. Okunan geometri kesilmemiş olandır (ayak izi). */
export interface PanelJoint {
  key: string; bId: string; aId: string; connector: Connector;
  /** Temas düzleminde, B kalınlığının ortasında, temasın BAŞLANGIÇ ucundaki nokta (gövde-yerel). */
  o: Vec3;
  /** Birleşim çizgisi yönü (başlangıç → bitiş) · A'nın yüzünden B'nin içine · B'nin işlenen geniş yüzünün dış yönü. */
  along: Vec3; nIn: Vec3; t: Vec3;
  /** Temas boyu · B ve A kalınlığı · bağlayıcı noktaları (başlangıçtan mm). */
  length: number; tB: number; tA: number; positions: number[];
}
type Range3 = { min: Vec3; max: Vec3; n: number };
interface SlabInfo { box: THREE.Box3; size: Vec3; planes: Array<[Range3, Range3]> }
const _slabCache = new WeakMap<THREE.BufferGeometry, SlabInfo | null>();
/** Levhanın kutusu + kutunun altı düzleminin her birindeki köşelerin kapsamı (gerçek uç yüzü / geniş yüz; çentikli panelde kutudan küçük). */
function slabInfo(geo: THREE.BufferGeometry | undefined): SlabInfo | null {
  if (!geo) return null;
  if (_slabCache.has(geo)) return _slabCache.get(geo)!;
  const box = localBboxOf(geo), pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
  let info: SlabInfo | null = null;
  if (box && pos) {
    const mk = (): Range3 => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], n: 0 });
    const planes: Array<[Range3, Range3]> = [[mk(), mk()], [mk(), mk()], [mk(), mk()]];
    const lo = box.min.toArray() as Vec3, hi = box.max.toArray() as Vec3, v: Vec3 = [0, 0, 0];
    for (let i = 0; i < pos.count; i++) {
      v[0] = pos.getX(i); v[1] = pos.getY(i); v[2] = pos.getZ(i);
      for (let a = 0; a < 3; a++) for (const side of [0, 1] as const) {
        if (Math.abs(v[a] - (side ? hi[a] : lo[a])) > 0.3) continue;
        const r = planes[a][side]; r.n++;
        for (let k = 0; k < 3; k++) { if (v[k] < r.min[k]) r.min[k] = v[k]; if (v[k] > r.max[k]) r.max[k] = v[k]; }
      }
    }
    info = { box, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], planes };
  }
  _slabCache.set(geo, info);
  return info;
}
const unit = (axis: number, sign: number): Vec3 => { const v: Vec3 = [0, 0, 0]; v[axis] = sign; return v; };
const overlap = (a0: number, a1: number, b0: number, b1: number): [number, number] => [Math.max(a0, b0), Math.min(a1, b1)];
/** B yüzü işlemlerinin varsayılan tarafı = GÖRÜNMEYEN yüz: üst panel / üst kayıtta üst · öteki yataylarda alt · önsel panellerde arka;
 *  yan panellerde gövdenin dışına bakan yüz (dikme: sol). Kenar kuralındaki `flipFace` öteki yüze çevirir. */
function hiddenFaceRole(type: PanelTypeId, plane: Exclude<PanelPlane, 'any'>, body: Shape, box: THREE.Box3, thin: number, st: St): PanelEdgeDir {
  if (plane === 'horizontal') return type === 'top' || type.startsWith('top') ? 'top' : 'bottom';
  if (plane === 'frontal') return 'rear';
  const bb = bodyBoxOf(body), c = (box.min.getComponent(thin) + box.max.getComponent(thin)) / 2, bc = bb ? (bb.min.getComponent(thin) + bb.max.getComponent(thin)) / 2 : c;
  return Math.abs(c - bc) < 1 ? 'left' : roleOfDir(body, unit(thin, c > bc ? 1 : -1), st);
}
const _jointCache = new Map<string, { sig: string; joints: PanelJoint[] }>();
/** Gövdenin tüm birleşimleri (kural + temas). Sonuç panel geometrileri / tipler / kütüphane değişene kadar saklanır. */
export function bodyJoints(bodyId: string, st: St = useAppStore.getState()): PanelJoint[] {
  const cfg = st.panelTypeConfig;
  if (!st.connectors.length || !st.connectorLayouts.length || !Object.values(cfg.rules ?? {}).some(ruleHasLayout)) return [];
  const body = shapeById(bodyId, st.shapes); if (!body) return [];
  const slabs = st.shapes.filter(s => s.type === 'panel' && s.parameters?.parentShapeId === bodyId && !isDoorPanel(s) && !s.parameters?.curved && !panelHasRotation(s))
    .map(p => {
      const vf = vfOfPanel(p, st.virtualFaces), geo = footprintGeometry(p), info = slabInfo(geo); if (!vf || !info) return null;
      // Kalınlık ekseni: VF normali (dar şeritte en küçük ölçü kalınlık olmayabilir); belirsizse en küçük ölçü.
      const na = vf.normal.map(Math.abs), byN = na.indexOf(Math.max(...na));
      const thin = na[byN] > 0.9 ? byN : info.size.indexOf(Math.min(...info.size));
      return { p, vf, info, thin, uuid: geo!.uuid, type: panelTypeOf(vf, st) };
    }).filter((x): x is NonNullable<typeof x> => !!x);
  const sig = `${slabs.map(s => `${s.p.id}:${s.uuid}:${s.type}`).join('|')}#${JSON.stringify(cfg.rules ?? {})}#${st.connectors.map(c => c.id).join(',')}#${JSON.stringify(st.connectorLayouts)}#${bodyFrontAxis(body, st).facing}`;
  const hit = _jointCache.get(bodyId);
  if (hit && hit.sig === sig) {
    // Bağlayıcının içeriği (delik / model) değişmiş olabilir: nesne güncel listeden yeniden bağlanır.
    return hit.joints.map(j => ({ ...j, connector: st.connectors.find(c => c.id === j.connector.id) ?? j.connector }));
  }
  const joints: PanelJoint[] = [];
  for (const B of slabs) {
    const edges = B.type ? cfg.rules?.[B.type]?.edges : undefined;
    if (!B.type || !edges || !ruleHasLayout({ edges })) continue;
    const plane = PLANE_OF_ROLE[roleOfDir(body, unit(B.thin, 1), st)];
    const faceRoles: [PanelEdgeDir, PanelEdgeDir] = [roleOfDir(body, unit(B.thin, 1), st), roleOfDir(body, unit(B.thin, -1), st)];
    for (const i of [0, 1, 2]) if (i !== B.thin) for (const s of [1, -1]) {
      const role = roleOfDir(body, unit(i, s), st);
      // Kenarın dizilim satırları, bağlayıcı yuvası başına (1. / 2.; bağlayıcısı olanlar); satır kimliği (+ 2. yuvada "~2") birleşim anahtarına
      // girer. Boy aralığı temas boyu belli olunca elenir.
      const list = rulesIn(edges, role).flatMap(rule => (st.connectorLayouts.find(x => x.id === rule.layoutId)?.lines ?? [])
        .flatMap(line => lineConnectorIds(line).map((id, k) => ({ rule, line, slot: (k + 1) as 1 | 2, conn: id ? st.connectors.find(c => c.id === id) : undefined }))))
        .filter(x => !!x.conn);
      if (!list.length) continue;
      const end = B.info.planes[i][s > 0 ? 1 : 0]; if (end.n < 3) continue;
      const c = s > 0 ? B.info.box.max.getComponent(i) : B.info.box.min.getComponent(i), a = [0, 1, 2].find(k => k !== i && k !== B.thin)!;
      const tB = end.max[B.thin] - end.min[B.thin];
      // Dizilim yönü: kenarın bitiş ucunun rolüne bakan eksen yönü (derinlikte önden arkaya …).
      const endRole = EDGE_ENDS[plane][role]?.[1];
      const aSign = roleOfDir(body, unit(a, 1), st) === endRole ? 1 : roleOfDir(body, unit(a, -1), st) === endRole ? -1 : 1;
      // Kolon / kiriş panelinde görünmeyen yüz = kolona / kirişe bakan yüz (panelin oturduğu gövde yüzünün dış yönü).
      const want = hiddenFaceRole(B.type, plane, body, B.info.box, B.thin, st);
      const hidden = TYPE_BY_ID.get(B.type)?.group === 'boxing' ? (B.vf.normal[B.thin] >= 0 ? 1 : -1) : faceRoles[0] === want ? 1 : faceRoles[1] === want ? -1 : 1;
      for (const A of slabs) {
        if (A === B || A.thin !== i) continue;
        const faceAt = s > 0 ? A.info.box.min.getComponent(i) : A.info.box.max.getComponent(i);
        if (Math.abs(faceAt - c) > 0.6) continue;
        const face = A.info.planes[i][s > 0 ? 0 : 1]; if (face.n < 3) continue;
        const tOv = overlap(end.min[B.thin], end.max[B.thin], face.min[B.thin], face.max[B.thin]), aOv = overlap(end.min[a], end.max[a], face.min[a], face.max[a]);
        if (tOv[1] - tOv[0] < tB * 0.6 || aOv[1] - aOv[0] < 10) continue;
        const o: Vec3 = [0, 0, 0];
        o[i] = c; o[B.thin] = (end.min[B.thin] + end.max[B.thin]) / 2; o[a] = aSign > 0 ? aOv[0] : aOv[1];
        const length = round1(aOv[1] - aOv[0]);
        for (const { rule, line, slot, conn } of list) {
          if (!lineApplies(line, length)) continue;
          const positions = linePositions(line, length, slot); if (!positions.length) continue;
          joints.push({
            key: `${B.p.id}|${role}|${A.p.id}|${line.id}${slot === 2 ? '~2' : ''}`, bId: B.p.id, aId: A.p.id, connector: conn!, o, along: unit(a, aSign), nIn: unit(i, -s),
            t: unit(B.thin, hidden * (rule.flipFace ? -1 : 1)), length, tB: round1(tB), tA: round1(A.info.size[i]), positions,
          });
        }
      }
    }
  }
  if (_jointCache.size > 40) _jointCache.clear();
  _jointCache.set(bodyId, { sig, joints });
  return joints;
}
/** Bağlayıcı yüzey noktası → gövde-yerel konum + yüzeyin DIŞ normali (`s` = birleşim başlangıcından bağlayıcı noktasına mm). */
export function jointSurfacePoint(j: PanelJoint, s: number, surface: ConnSurface, along: number, across: number): { pos: Vec3; normal: Vec3 } {
  const k = s + along, off = surface === 'bFace' ? j.tB / 2 : across, into = surface === 'bFace' ? across : 0;
  const pos = [0, 1, 2].map(x => j.o[x] + j.along[x] * k + j.t[x] * off + j.nIn[x] * into) as Vec3;
  return { pos, normal: surface === 'bFace' ? j.t : surface === 'bEdge' ? (j.nIn.map(v => -v) as Vec3) : j.nIn };
}
/** Kesici katı (pocket / line): anahtar (önbellek imzası), kaba kutu (eleme) ve tembel kurucu. */
/** Pocket / line katısı: kesici TARİFİ (düz veri — kesim işçisine de gider, bkz. CutWorker.ToolSpec). */
export interface ConnSolidCut { key: string; box: CavityBox; spec: ToolSpec }
const CONN_MOUTH = 1;
const keyOf = (...v: Array<number | string | Vec3>) => v.map(x => (Array.isArray(x) ? x.map(round1).join(',') : typeof x === 'number' ? round1(x) : x)).join('|');
function boxAround(pts: Vec3[], pad: number): CavityBox {
  const b = new THREE.Box3().setFromPoints(pts.map(p => new THREE.Vector3(...p))).expandByScalar(pad);
  return { min: b.min.toArray() as Vec3, max: b.max.toArray() as Vec3 };
}
/** Tek bağlayıcı noktasının (`s` = birleşim başından mm, `k` = sıra) kesicileri — panelin o birleşimdeki görevine göre (B: yüz + uç, A: temas
 *  yüzü). `j` gerçek birleşim ya da KANONİK birleşim (`canonJoint`) olabilir: geometri yalnız birleşimin çerçevesinden okunur. */
function pointCuts(j: PanelJoint, s: number, k: number, isB: boolean, isA: boolean, out: { holes: HoleCutter[]; solids: ConnSolidCut[] }): void {
  const mine = (sf: ConnSurface) => (sf === 'aFace' ? isA : isB);
  const limitOf = (sf: ConnSurface) => (sf === 'bFace' ? j.tB : sf === 'aFace' ? j.tA : Infinity);
  const depthOf = (sf: ConnSurface, d: number) => (d >= limitOf(sf) - 1e-6 ? limitOf(sf) + CONN_MOUTH : d);
  for (const h of j.connector.holes) {
    if (!mine(h.surface) || !(h.diameter > 0) || !(h.depth > 0)) continue;
    const sp = jointSurfacePoint(j, s, h.surface, h.along, h.across), dir = sp.normal.map(v => -v) as Vec3;
    out.holes.push(holeCutterOf({ center: sp.pos, dir, radius: h.diameter / 2, depth: depthOf(h.surface, h.depth) }, [0, 0, 0], `${j.key}#${k}:${h.id}`,
      { kind: 'connector', connectorId: j.connector.id, holeId: h.id, joint: j.key, index: k }));
  }
  for (const op of j.connector.ops) {
    if (!mine(op.surface) || !(op.depth > 0)) continue;
    const depth = depthOf(op.surface, op.depth), at = (x: number, y: number) => jointSurfacePoint(j, s, op.surface, x, y);
    const nOut = at(0, 0).normal, dir = nOut.map(v => -v) as Vec3;
    const lifted = (p: Vec3): Vec3 => [p[0] + nOut[0] * CONN_MOUTH, p[1] + nOut[1] * CONN_MOUTH, p[2] + nOut[2] * CONN_MOUTH];
    const cyl = (c: { x: number; y: number }, r: number) => {
      const p = at(c.x, c.y).pos;
      out.solids.push({ key: keyOf('c', p, r, depth, dir), box: boxAround([lifted(p), [p[0] + dir[0] * depth, p[1] + dir[1] * depth, p[2] + dir[2] * depth]], r),
        spec: { k: 'cyl', start: lifted(p), dir, r, len: depth + CONN_MOUTH } });
    };
    const prism = (poly: Array<{ x: number; y: number }>) => {
      const pts = poly.map(q => at(q.x, q.y).pos);
      out.solids.push({ key: keyOf('p', ...pts, depth, dir), box: boxAround([...pts.map(lifted), ...pts.map(p => [p[0] + dir[0] * depth, p[1] + dir[1] * depth, p[2] + dir[2] * depth] as Vec3)], 0.01),
        spec: { k: 'prism', pts, nOut, lift: CONN_MOUTH, len: depth } });
    };
    op.shapes.forEach(sh => {
      if (op.type === 'pocket') {
        if (sh.t === 'circle') cyl(sh.c, sh.r);
        else if (sh.t === 'pline' && connShapeClosed(sh) && sh.v.length >= 3) prism(sh.v);
        return;
      }
      // LINE: takım yolu — her doğru parçası `width` eninde dikdörtgen, köşe / uçlarda takım çapında silindir; dairede halka.
      const w = op.width; if (!(w > 0)) return;
      if (sh.t === 'circle') {
        const p = at(sh.c.x, sh.c.y).pos, rOut = sh.r + w / 2, rIn = sh.r - w / 2;
        out.solids.push({ key: keyOf('r', p, rOut, rIn, depth, dir), box: boxAround([lifted(p), [p[0] + dir[0] * depth, p[1] + dir[1] * depth, p[2] + dir[2] * depth]], rOut),
          spec: { k: 'ring', start: lifted(p), dir, rOut, rIn, len: depth + CONN_MOUTH } });
        return;
      }
      const pts = connShapePoints(sh);
      for (let q = 0; q + 1 < pts.length; q++) {
        const a = pts[q], b = pts[q + 1], dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy); if (l < 1e-6) continue;
        const ox = (-dy / l) * (w / 2), oy = (dx / l) * (w / 2);
        prism([{ x: a.x + ox, y: a.y + oy }, { x: b.x + ox, y: b.y + oy }, { x: b.x - ox, y: b.y - oy }, { x: a.x - ox, y: a.y - oy }]);
      }
      (connShapeClosed(sh) ? pts.slice(0, -1) : pts).forEach(c => cyl(c, w / 2));
    });
  }
}
/* BİRİM ARAÇ — hız: bir bağlayıcı noktasının araçları çoğu zaman birbirini keser (kam yuvası Ø15 ↔ mil kanalı Ø8, line operasyonunun
   dikdörtgeni ↔ uç silindirleri). OCC boolean'ı araç–araç kesişimini HER noktada, HER üretimde yeniden çözüyordu: silindir × silindir çifti
   başına ~110 ms (ölçüldü; 12 araçlı alt panel 680 ms, aynı delikler birbirini kesmeyince 55 ms). Çözüm: noktanın araçları KANONİK
   çerçevede bir kez birleştirilir (fuse) ve saklanır; her noktaya katı dönüşümle (taşı + döndür) kopyalanır → panel kesimi yalnız
   düzlem × silindir çözer. Kanonik çerçeve: e1 = birleşim yönü (el yönü ters birleşimde −e1) · e2 = B'nin işlenen yüzü · e3 = A'dan B'nin içine. */
export interface ConnUnitCut {
  /** İçerik anahtarı (kanonik geometri): aynı anahtar = aynı birleşik araç (motor önbelleği). */
  key: string;
  /** Kanonik → gövde-yerel katı dönüşüm, satır satır 3 × 4 (gp_Trsf.SetValues sırası). */
  m: number[];
  box: CavityBox;
  /** Kanonik çerçevedeki parçalar (araç ilk kez kurulurken). */
  canon: { holes: HoleCutter[]; solids: ConnSolidCut[] };
  /** Aynı noktanın gövde-yerel kesicileri: birim kurulamazsa tek tek kesilir. */
  real: { holes: HoleCutter[]; solids: ConnSolidCut[] };
}
type CanonUnit = { key: string; holes: HoleCutter[]; solids: ConnSolidCut[] };
const _canonCache = new WeakMap<Connector, Map<string, CanonUnit>>();
/** Bağlayıcının kanonik birimi (görev + el yönü + kalınlıklar başına bir kez; bağlayıcı kaydedilince nesnesi değişir → kendiliğinden yenilenir). */
function canonUnit(j: PanelJoint, isB: boolean, hand: 1 | -1): CanonUnit {
  let byConn = _canonCache.get(j.connector);
  if (!byConn) { byConn = new Map(); _canonCache.set(j.connector, byConn); }
  const id = `${isB ? 'B' : 'A'}|${hand}|${j.tB}|${j.tA}`;
  let u = byConn.get(id);
  if (!u) {
    const jc: PanelJoint = { ...j, key: 'u', o: [0, 0, 0], along: [hand, 0, 0], t: [0, 1, 0], nIn: [0, 0, 1] };
    const parts = { holes: [] as HoleCutter[], solids: [] as ConnSolidCut[] };
    pointCuts(jc, 0, 0, isB, !isB, parts);
    u = { key: `${parts.holes.map(h => h.key).join(';')}~${parts.solids.map(c => c.key).join(';')}`, ...parts };
    byConn.set(id, u);
  }
  return u;
}
/** Kesicinin taşınabilir tarifi (delik silindiri · pocket / line katısı · birim araç). */
export const holeSpec = (c: HoleCutter): ToolSpec => ({ k: 'cyl', start: c.start, dir: c.dir, r: c.radius, len: c.length });
export const unitSpec = (u: ConnUnitCut): ToolSpec => ({
  k: 'unit', key: u.key, m: u.m,
  parts: [...u.canon.holes.map(holeSpec), ...u.canon.solids.map(c => c.spec)], fallback: [...u.real.holes.map(holeSpec), ...u.real.solids.map(c => c.spec)],
});
export interface PanelConnectorCuts {
  /** Tüm delikler (delik kaydı + imza) ve tüm pocket / line katıları (imza). */
  holes: HoleCutter[]; solids: ConnSolidCut[];
  /** KESİM ARAÇLARI: çok parçalı noktalar birim olarak, tek parçalı noktalar `loose` içinde tek tek. */
  units: ConnUnitCut[]; loose: { holes: HoleCutter[]; solids: ConnSolidCut[] };
}
const boxUnion = (boxes: CavityBox[]): CavityBox => ({
  min: [0, 1, 2].map(a => Math.min(...boxes.map(b => b.min[a]))) as Vec3, max: [0, 1, 2].map(a => Math.max(...boxes.map(b => b.max[a]))) as Vec3,
});
/** Panelin bağlayıcı kesicileri: B olduğu birleşimlerde yüz + uç işlemleri, A olduğu birleşimlerde temas yüzü işlemleri.
 *  Delikler `HoleCutter` (panelin delik kaydına girer); pocket / line katıları ayrı. Derinlik malzemeyi aşarsa boydan boya. */
export function connectorCutsFor(panel: Shape, st: St = useAppStore.getState()): PanelConnectorCuts {
  const out: PanelConnectorCuts = { holes: [], solids: [], units: [], loose: { holes: [], solids: [] } };
  const bodyId = panel.parameters?.parentShapeId as string | undefined; if (!bodyId) return out;
  for (const j of bodyJoints(bodyId, st)) {
    const isB = j.bId === panel.id, isA = j.aId === panel.id; if (!isB && !isA) continue;
    // El yönü: (birleşim yönü, işlenen yüz, içe yön) üçlüsü sol-elliyse kanonik birim ayna kurulur (dönüşüm katı kalır).
    const [A, T, N] = [j.along, j.t, j.nIn];
    const det = A[0] * (T[1] * N[2] - T[2] * N[1]) - A[1] * (T[0] * N[2] - T[2] * N[0]) + A[2] * (T[0] * N[1] - T[1] * N[0]);
    const hand: 1 | -1 = det < 0 ? -1 : 1;
    j.positions.forEach((s, k) => {
      const real = { holes: [] as HoleCutter[], solids: [] as ConnSolidCut[] };
      pointCuts(j, s, k, isB, isA, real);
      out.holes.push(...real.holes); out.solids.push(...real.solids);
      if (real.holes.length + real.solids.length < 2) { out.loose.holes.push(...real.holes); out.loose.solids.push(...real.solids); return; }
      const canon = canonUnit(j, isB, hand), p = [0, 1, 2].map(x => j.o[x] + A[x] * s);
      out.units.push({
        key: canon.key, canon, real,
        m: [0, 1, 2].flatMap(r => [hand * A[r], T[r], N[r], p[r]]),
        box: boxUnion([...real.holes.map(holeCutterBox), ...real.solids.map(c => c.box)]),
      });
    });
  }
  return out;
}
/** Panelin bağlayıcı kesicilerinin imzası: motor, son üretimde kullandığıyla karşılaştırıp bayat paneli yeniden üretir. */
export function connectorCutSig(panel: Shape, st: St = useAppStore.getState()): string {
  const c = connectorCutsFor(panel, st);
  return c.holes.length || c.solids.length ? `${c.holes.map(h => h.key).join(';')}~${c.solids.map(s => s.key).join(';')}` : '';
}
export interface ConnPartInstance { key: string; modelId: string; layerId?: string | null; pos: Vec3; quat: [number, number, number, number] }
/** Gövdedeki bağlayıcı modelleri (sahne çizimi): her birleşim noktasında bağlayıcının modelleri, editördeki duruşuyla. */
export function connectorPartInstances(bodyId: string, st: St = useAppStore.getState()): ConnPartInstance[] {
  const out: ConnPartInstance[] = [], up = new THREE.Vector3(0, 1, 0);
  for (const j of bodyJoints(bodyId, st)) {
    if (!j.connector.parts.length) continue;
    // Temsili çerçeve (x = nIn, y = t, z = −along) → gövde-yerel dönüş; sol-elli üçlüde z = x × y alınır (ayna yerine dönüş).
    const X = new THREE.Vector3(...j.nIn), Y = new THREE.Vector3(...j.t), frame = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, new THREE.Vector3().crossVectors(X, Y)));
    j.positions.forEach((s, k) => j.connector.parts.forEach(part => {
      const sp = jointSurfacePoint(j, s, part.surface, part.along, part.across), n = new THREE.Vector3(...sp.normal);
      const rep = connSurfacePoint(part.surface, 0, 0, j.tB).normal;
      const q = new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(...rep).multiplyScalar(part.flip ? -1 : 1))
        .multiply(new THREE.Quaternion().setFromAxisAngle(up, (part.spin * Math.PI) / 180)).premultiply(frame);
      const p = new THREE.Vector3(...sp.pos).addScaledVector(n, -part.inset);
      out.push({ key: `${j.key}#${k}:${part.id}`, modelId: part.modelId, layerId: part.layerId, pos: [p.x, p.y, p.z], quat: [q.x, q.y, q.z, q.w] });
    }));
  }
  return out;
}
let _refreshTimer: ReturnType<typeof setTimeout> | null = null;
/** Kural / bağlayıcı / tip değişti: gövdelerin bağlayıcı kesimleri tazelenir (delikler ve modeller güncellenir). Art arda değişiklikler tek seferde. */
export function refreshConnectorBodies(onlyBodyId?: string): void {
  if (_refreshTimer) clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(() => {
    _refreshTimer = null;
    const st = useAppStore.getState();
    const ids = new Set(st.shapes.filter(s => s.type === 'panel' && s.parameters?.parentShapeId).map(s => s.parameters.parentShapeId as string));
    // Yalnız kesicisi değişen paneller yeniden üretilir (tam rebuild değil; değişmeyen gövdede hiç iş yok).
    for (const id of ids) if (!onlyBodyId || id === onlyBodyId) void requestRebuild(id, { connectorsOnly: true });
  }, 120);
}

// ═════════════════════════════════════════════════ 7. ÖRNEK BAĞLAYICI ═════════════════════════════════════════════════
/** Silindir STL (z yukarı, taban z = 0) — örnek bağlayıcının modelleri dosyasız üretilir. */
function cylinderStl(name: string, r: number, h: number, seg = 36): string {
  const f = (a: number[], b: number[], c: number[]) => `facet normal 0 0 0\nouter loop\nvertex ${a.join(' ')}\nvertex ${b.join(' ')}\nvertex ${c.join(' ')}\nendloop\nendfacet\n`;
  let out = `solid ${name}\n`;
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const p0 = [r * Math.cos(a0), r * Math.sin(a0)], p1 = [r * Math.cos(a1), r * Math.sin(a1)];
    out += f([0, 0, 0], [p1[0], p1[1], 0], [p0[0], p0[1], 0]) + f([0, 0, h], [p0[0], p0[1], h], [p1[0], p1[1], h])
      + f([p0[0], p0[1], 0], [p1[0], p1[1], 0], [p1[0], p1[1], h]) + f([p0[0], p0[1], 0], [p1[0], p1[1], h], [p0[0], p0[1], h]);
  }
  return `${out}endsolid ${name}\n`;
}
/** ÖRNEK kam bağlayıcı (minifix düzeni): B yüzünde Ø15 × 12,5 kam yuvası (birleşimden 34) · B ucunda Ø8 × 34 mil kanalı · A yüzünde Ø5 × 11 mil deliği;
 *  modeller: kam (yuvasında) + mil. Model üretilemezse yalnız deliklerle kaydedilir. */
export async function addSampleConnector(name = 'Connector 1'): Promise<Connector> {
  const c = newConnector(name);
  c.holes = [
    newConnHole({ surface: 'bFace', along: 0, across: 34, diameter: 15, depth: 12.5 }),
    newConnHole({ surface: 'bEdge', along: 0, across: 0, diameter: 8, depth: 34 }),
    newConnHole({ surface: 'aFace', along: 0, across: 0, diameter: 5, depth: 11 }),
  ];
  try {
    const metal = useAppStore.getState().accessoryLayers.find(l => l.name.toLowerCase() === 'metal')?.id ?? null;
    const stl = (file: string, r: number, h: number) => importAccessoryFile(new File([cylinderStl(file, r, h)], `${file}.stl`, { type: 'model/stl' }), 'mm', 'z');
    const cam = await stl('cam-15', 7.5, 12), bolt = await stl('bolt-5x45', 2.5, 45);
    c.parts = [
      newConnPart(cam.id, { surface: 'bFace', along: 0, across: 34, inset: 12.5, layerId: metal }),
      newConnPart(bolt.id, { surface: 'aFace', along: 0, across: 0, inset: 11, layerId: metal }),
    ];
  } catch (err) { console.warn('[YAGO][BAĞLAYICI] örnek model üretilemedi, yalnız delikler:', err); }
  await saveConnector(c);
  return c;
}
/** ÖRNEK dizilim: verilen bağlayıcı baştan + sondan 50 mm, 600 mm'den sonra ortaya. */
export async function addSampleLayout(connectorId: string | null, name = 'Layout 1'): Promise<ConnectorLayoutSet> {
  const set = newLayoutSet(name, connectorId);
  await saveLayoutSet(set);
  return set;
}
/** ESKİ dizilim (bağlayıcıya / kenar kuralına gömülü, "≤ upTo" aralıklı) → yeni satırlar. Eşit dağıtım (spacing / count) kipi kalktı:
 *  o satırlar baştan + sondan + ortaya çevrilir. */
function legacyLines(lay: LegacyLayout | undefined, connectorId: string): LayoutLine[] {
  const ranges = [...(lay?.ranges ?? [])].filter(r => r.upTo > 0).sort((x, y) => x.upTo - y.upTo);
  const rows: Array<{ p: LegacyLayout; min: number; max: number }> = [
    ...ranges.map((r, i) => ({ p: r as LegacyLayout, min: i ? ranges[i - 1].upTo + 1 : 0, max: r.upTo })),
    { p: lay ?? {}, min: ranges.length ? ranges[ranges.length - 1].upTo + 1 : 0, max: 0 },
  ];
  return rows.map(({ p, min, max }) => {
    const pitch = p.pitch && p.pitch > 0 ? p.pitch : LAYOUT_PITCH, step = p.mode === 'step';
    return newLayoutLine(connectorId, {
      min, max, start: p.start ?? 50, end: p.end ?? 50, midFrom: p.midFrom ?? 600, pitch,
      kind: step ? (p.fill === 'middle' ? 'grid' : 'steps') : 'ends',
      ...(step && p.fill !== 'middle' && p.steps?.length ? { steps: p.steps.map(x => ({ d: Math.max(1, x.k) * pitch, n: Math.max(0, x.n) })) } : {}),
    });
  });
}
/** Açılışta bir kez: eski kenar kuralları (bağlayıcı + gömülü dizilim) dizilim kayıtlarına çevrilir; aynı içerik tek dizilim olur. */
export async function migrateLegacyLayouts(): Promise<void> {
  const st = useAppStore.getState(), sets = [...st.connectorLayouts], byBody = new Map<string, string>();
  const next = mapEdgeRules(st.panelTypeConfig, list => {
    const old = (list as unknown as LegacyEdgeRule[]).filter(r => !(r as unknown as EdgeConnectorRule).layoutId && !!r.connectorId);
    if (!old.length) return list;
    const lines = old.flatMap(r => legacyLines(r.custom ? r : st.connectors.find(c => c.id === r.connectorId)?.layout, r.connectorId!));
    const body = JSON.stringify(lines.map(l => ({ ...l, id: '' })));
    let id = byBody.get(body);
    if (!id) { const set: ConnectorLayoutSet = { id: genId('lay'), name: `Layout ${sets.length + 1}`, lines, createdAt: Date.now() + sets.length }; sets.push(set); id = set.id; byBody.set(body, id); }
    return [...list.filter(r => !!r.layoutId), { layoutId: id, ...(old.some(r => r.flipFace) ? { flipFace: true } : {}) }];
  });
  if (!next) return;
  await saveLayoutSets(sets);
  await savePanelTypeConfig(next);
}
const SAMPLE_SEEDED_KEY = 'yago.accessories.connectorSampleSeeded', LAYOUT_SEEDED_KEY = 'yago.accessories.layoutSampleSeeded';
/** Açılışta: eski dizilimler çevrilir; ilk açılışta bir kez "Connector 1" yoksa örnek bağlayıcı, hiç dizilim yoksa onunla örnek dizilim
 *  eklenir (silinirse geri gelmez). */
export async function seedConnectorSample(): Promise<void> {
  try { await migrateLegacyLayouts(); } catch (err) { console.warn('[YAGO][BAĞLAYICI] eski dizilimler çevrilemedi:', err); }
  try {
    if (!localStorage.getItem(SAMPLE_SEEDED_KEY)) {
      localStorage.setItem(SAMPLE_SEEDED_KEY, '1');
      if (!useAppStore.getState().connectors.some(c => c.name.trim().toLowerCase() === 'connector 1')) await addSampleConnector();
    }
    if (!localStorage.getItem(LAYOUT_SEEDED_KEY)) {
      // İşaret ancak karar verilebildiğinde konur: dizilim zaten varsa ya da örnek eklendiyse (bağlayıcı henüz yoksa sonraki açılışta denenir).
      const st = useAppStore.getState(), conn = st.connectors.find(c => c.name.trim().toLowerCase() === 'connector 1') ?? st.connectors[0];
      if (!st.connectorLayouts.length && conn) await addSampleLayout(conn.id);
      if (useAppStore.getState().connectorLayouts.length) localStorage.setItem(LAYOUT_SEEDED_KEY, '1');
    }
  } catch (err) { console.warn('[YAGO][BAĞLAYICI] örnek bağlayıcı / dizilim eklenemedi:', err); }
}
