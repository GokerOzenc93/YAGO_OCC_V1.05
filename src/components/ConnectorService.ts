/* PANEL TİPLERİ + BAĞLAYICILAR — çekirdek (arayüz Accessories.tsx'te).
   1) Panel tipi kataloğu (İngilizce ad, düzlem, bölge) · yüzey → izinli tipler + varsayılan · panelin konumundan otomatik tip.
   2) Panelin kenar rolleri (ön / arka / üst / alt / sol / sağ) gövdenin yüz rollerinden okunur; bağlayıcı kuralı ve ileride kenar bandı
      aynı rolleri kullanır. 3) Kenar kuralı → kenar boyunca bağlayıcı noktaları.
   4) Bağlayıcı = delikler + çizilmiş operasyonlar (pocket / line) + modeller; hepsi TEMSİLİ BİRLEŞİM çerçevesinde (B paneli ucuyla A'nın
      yüzüne dayanır). 5) Birleşimler: kurallar gerçek panellere işlenir. Kayıt AccessoryService veritabanında (IndexedDB).
   KİM NEYİ SÖYLER: panel tipinin kenarı → bağlayıcı GRUBU (sabit · hareketli) + DELİK YÜZÜ (yüz deliklerinin panelin hangi geniş yüzüne
   delineceği) · panel → o grubun hangi SETİ (seçilmezse varsayılan) + istenirse delik yüzünü kendisi için değiştirir · set → hangi
   bağlayıcı, hangi ölçüyle.
   8) KENAR BANDI: bant tipi (panel tipi + kapak) × kenar rolü → bant kalınlığı; panelin her kalınlık yüzü baktığı role göre bant alır, iki
      panelin birleştiği kenara bant atılmaz, panel kendi kenarını elle değiştirebilir (dosyanın sonu). */
import * as THREE from 'three';
import {
  type CavityBox, type ConnHole, type ConnOp, type ConnOpType, type ConnPart, type ConnShape, type ConnSurface, type Connector, type ConnectorGroup, type ConnectorLayoutSet,
  type EdgeConnectorRule, type LayoutKind, type LayoutLine, type LegacyEdgeRule, type LegacyLayout, type PanelEdgeDir, type PanelGroup, type PanelSurface,
  type PanelSurfaceRule, type PanelTypeConfig, type PanelTypeId, type PanelTypeRule, type Shape, type VirtualFace, panelOfVf, requestRebuild, shapeById, useAppStore,
  vfOfPanel, type BandTypeId, type EdgeBandConfig, type EdgeBandRule,
} from '../store';
import { type Vec3, genId, getFacesAndGroups, largestFaceNormal, localBboxOf, outlineGeometry, panelHasRotation, round1, isFaceKind, roleOfNormal } from './Geometry';
import { type ToolSpec } from './CutWorker';
import { type HoleCutter, CONNECTOR_LAYOUTS_ID, EDGE_BAND_CONFIG_ID, PANEL_TYPE_CONFIG_ID, holeCutterBox, holeCutterOf, importAccessoryFile, libraryDelete, libraryPut } from './AccessoryService';
import { isDoorPanel } from './DoorService';
// BackService ↔ PanelGroupService ↔ ConnectorService döngüsel: yalnız fonksiyon içinde kullanılır (üst düzeyde okuma yok).
import { backGrooveCuttersFor } from './BackService';
import { bodyFaceRolesOf, bodyFaces, bodyFrontAxis } from './PlinthService';
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
const bodyBoxOf = (body: Shape): THREE.Box3 | null => localBboxOf(body.geometry);
/** Gövde-yerel yön → rol: o yöne bakan gövde yüzünün rolü (elle verilmiş roller dahil); yüz yoksa ön yöne göre normalden.
 *  `at` (gövde-yerel nokta: kenarın ortası, panelin merkezi) verilirse o yöne bakan yüzlerden noktanın ÖNÜNDEKİ yüz seçilir — düzlemi
 *  noktanın ilerisinde (ya da üstünde) ve sınırları noktanın izdüşümünü kapsayan, en yakın olan. L / çentikli gövdede aynı yöne bakan iki yüzün
 *  rolü farklı olabilir (köşe dolabında büyük +Z yüzü "left", çentik yüzü "front"): EN BÜYÜK yüzü almak çentiğe bakan kenara yanlış rol
 *  veriyordu (sağ panelin ön kenarı "left" → bant gelmedi). `at` yoksa eski davranış: en büyük yüz. */
function roleOfDir(body: Shape, d: Vec3, st: St = useAppStore.getState(), at?: Vec3 | null): PanelEdgeDir {
  let best: { role: PanelEdgeDir; score: number } | null = null;
  for (const f of bodyFaces(body, st)) {
    if (dot3(f.normal, d) <= 0.9) continue;
    let score = -f.area;
    if (at) {
      const along = dot3([f.center[0] - at[0], f.center[1] - at[1], f.center[2] - at[2]], d);
      let outside = 0;
      for (let a = 0; a < 3; a++) if (Math.abs(d[a]) < 0.5) outside += Math.max(0, f.bounds.min[a] - at[a] - 1, at[a] - f.bounds.max[a] - 1);
      // Noktanın gerisinde kalan yüz (düzlemi 2 mm'den fazla arkada) en sona; sonra izdüşümün yüze uzaklığı, sonra düzleme uzaklık.
      score = (along < -2 ? 1e6 : 0) + outside * 4 + Math.max(0, along) - f.area * 1e-9;
    }
    if (!best || score < best.score) best = { role: f.role, score };
  }
  return best?.role ?? roleOfNormal({ x: d[0], y: d[1], z: d[2] }, bodyFrontAxis(body, st).facing);
}
const boxCenterV = (b: THREE.Box3): Vec3 => [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2];
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
  return best && best.d < 3 ? best.role : roleOfDir(body, vf.normal, st, vf.center);
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
  // Rol konuma bağlı (roleOfDir): panelin merkezi ve kenarlarının ortası gövde-yerel.
  const bb = localBboxOf(panel.geometry), c = bb ? boxCenterV(bb) : null;
  const at = (dir: Vec3, half: number): Vec3 | null => (c ? [c[0] + dir[0] * half, c[1] + dir[1] * half, c[2] + dir[2] * half] : null);
  const faces: [PanelEdgeDir, PanelEdgeDir] = [roleOfDir(body, dirOf(thin, 1), st, c), roleOfDir(body, dirOf(thin, -1), st, c)];
  const edges: PanelEdgeInfo[] = [];
  for (const i of inPlane) for (const sign of [1, -1]) {
    const dir = dirOf(i, sign), other = inPlane.find(k => k !== i)!;
    edges.push({ role: roleOfDir(body, dir, st, at(dir, ax.size.getComponent(i) / 2)), dir, length: round1(ax.size.getComponent(other)) });
  }
  return { plane: PLANE_OF_ROLE[faces[0]], thickness: round1(ax.size.getComponent(thin)), faces, edges };
}

// ═════════════════════════════════════════════════ 4. TİP KURALLARI (kenar → bağlayıcı grubu) ═════════════════════════════════════════════════
const typeRuleOf = (type: PanelTypeId, cfg: PanelTypeConfig = useAppStore.getState().panelTypeConfig): PanelTypeRule => cfg.rules?.[type] ?? { edges: {} };
/** Kenarın kuralları (grubu seçilmiş olanlar; kenar başına tek kural — depolama liste). */
const rulesIn = (edges: PanelTypeRule['edges'] | undefined, edge: PanelEdgeDir): EdgeConnectorRule[] => {
  const v = edges?.[edge] as EdgeConnectorRule[] | EdgeConnectorRule | undefined;
  return (Array.isArray(v) ? v : v ? [v] : []).filter(r => !!r?.group);
};
export const edgeRulesOf = (type: PanelTypeId, edge: PanelEdgeDir, cfg?: PanelTypeConfig): EdgeConnectorRule[] => rulesIn(typeRuleOf(type, cfg).edges, edge);
const ruleHasGroup = (rule: PanelTypeRule | undefined): boolean => !!rule && (Object.keys(rule.edges ?? {}) as PanelEdgeDir[]).some(e => rulesIn(rule.edges, e).length > 0);
/** Tipin kenarlarında geçen gruplar (panel satırında hangi set seçimlerinin sunulacağı). */
export const typeGroupsOf = (type: PanelTypeId | null | undefined, cfg?: PanelTypeConfig): ConnectorGroup[] => {
  const edges = type ? typeRuleOf(type, cfg).edges : {};
  const used = new Set((Object.keys(edges) as PanelEdgeDir[]).flatMap(e => rulesIn(edges, e).map(r => r.group!)));
  return CONNECTOR_GROUPS.map(g => g.key).filter(g => used.has(g));
};

/* ───────── GRUPLAR + PANELİN SETİ ───────── */
export const CONNECTOR_GROUPS: Array<{ key: ConnectorGroup; label: string; sub: string }> = [
  { key: 'fixed', label: 'Fixed', sub: 'fixed joints — cam and bolt, dowel, screw' },
  { key: 'movable', label: 'Movable', sub: 'movable parts — adjustable-shelf supports' },
];
export const groupLabel = (g: ConnectorGroup): string => CONNECTOR_GROUPS.find(x => x.key === g)?.label ?? g;
export const setGroupOf = (s: Pick<ConnectorLayoutSet, 'group'>): ConnectorGroup => s.group ?? 'fixed';
export const setsOfGroup = (group: ConnectorGroup, sets: ConnectorLayoutSet[] = useAppStore.getState().connectorLayouts): ConnectorLayoutSet[] =>
  sets.filter(s => setGroupOf(s) === group);
/** Grubun varsayılan seti: işaretli olan, yoksa gruptaki ilk set. */
export const defaultSetOf = (group: ConnectorGroup, sets: ConnectorLayoutSet[] = useAppStore.getState().connectorLayouts): ConnectorLayoutSet | undefined => {
  const list = setsOfGroup(group, sets);
  return list.find(s => s.isDefault) ?? list[0];
};
/** Panelin ELLE seçimi: panelin kendi kaydı → raf / dikme grubunun kaydı. undefined = seçim yok (varsayılan) · null = bu panelde yok. */
export const panelSetPick = (vf: VirtualFace, group: ConnectorGroup, st: St = useAppStore.getState()): string | null | undefined =>
  (vf.connectorSets?.[group] !== undefined ? vf.connectorSets[group] : groupOfVf(vf, st)?.connectorSets?.[group]);
/** Panelin o gruptaki seti: elle seçim → grubun varsayılanı. Elle "yok" seçilmişse undefined; seçilen set silinmişse / grubu değişmişse varsayılan. */
export function panelSetOf(vf: VirtualFace, group: ConnectorGroup, st: St = useAppStore.getState()): ConnectorLayoutSet | undefined {
  const pick = panelSetPick(vf, group, st);
  if (pick === null) return undefined;
  return (pick ? setsOfGroup(group, st.connectorLayouts).find(s => s.id === pick) : undefined) ?? defaultSetOf(group, st.connectorLayouts);
}
const withSet = (cur: Partial<Record<ConnectorGroup, string | null>> | undefined, group: ConnectorGroup, id: string | null | undefined) => {
  const next = { ...cur };
  if (id === undefined) delete next[group]; else next[group] = id;
  return Object.keys(next).length ? next : undefined;
};
/** Kenar kayıtlarından bir alanı siler (`keep` false dönen kenarlarda); boşalan kenar / kayıt tümden kalkar. */
const dropEdgeField = (cur: VirtualFace['connectorEdges'], field: 'set' | 'flip', drop: (edge: PanelEdgeDir) => boolean = () => true): VirtualFace['connectorEdges'] => {
  const next: NonNullable<VirtualFace['connectorEdges']> = {};
  for (const [edge, v] of Object.entries(cur ?? {}) as Array<[PanelEdgeDir, { set?: string | null; flip?: boolean }]>) {
    const o = { ...v }; if (drop(edge)) delete o[field];
    if (o.set !== undefined || o.flip !== undefined) next[edge] = o;
  }
  return Object.keys(next).length ? next : undefined;
};
/** Panelin seti (BÜTÜN kenarları): kimlik · null = bu panelde o grubun bağlayıcısı yok · undefined = seçim kalkar (grubun varsayılanı).
 *  O grubun kenarlarındaki kenar-özel set seçimleri silinir (panel genelindeki seçim hepsine uygulanır). */
export function setVfConnectorSet(vfId: string, group: ConnectorGroup, id: string | null | undefined): void {
  const st = useAppStore.getState(), vf = st.virtualFaces.find(f => f.id === vfId); if (!vf) return;
  const type = panelTypeOf(vf, st);
  st.updateVirtualFace(vfId, { connectorSets: withSet(vf.connectorSets, group, id),
    connectorEdges: dropEdgeField(vf.connectorEdges, 'set', e => !type || edgeRulesOf(type, e, st.panelTypeConfig)[0]?.group !== (group === 'fixed' ? 'movable' : 'fixed')) });
  refreshConnectorBodies(vf.shapeId);
}
/** Panelin TEK KENARI: set (kimlik · null = o kenarda yok) ve / veya delik yüzü; alan `undefined` verilirse o kenarın kaydı silinir (panelin
 *  genel seçimine döner). Verilmeyen alana dokunulmaz. */
export function setVfEdgeConnector(vfId: string, edge: PanelEdgeDir, patch: { set?: string | null; flip?: boolean }): void {
  const st = useAppStore.getState(), vf = st.virtualFaces.find(f => f.id === vfId); if (!vf) return;
  const cur = { ...vf.connectorEdges?.[edge] };
  for (const k of ['set', 'flip'] as const) if (k in patch) { if (patch[k] === undefined) delete cur[k]; else (cur as Record<string, unknown>)[k] = patch[k]; }
  const next = { ...vf.connectorEdges }; if (cur.set !== undefined || cur.flip !== undefined) next[edge] = cur; else delete next[edge];
  st.updateVirtualFace(vfId, { connectorEdges: Object.keys(next).length ? next : undefined });
  refreshConnectorBodies(vf.shapeId);
}
/** Panelin o KENARINDAKİ set: kenarın kendi seçimi → panelin seti (panelSetOf). Kenarda "yok" (null) → undefined; seçilen set silinmişse panelinki. */
export function panelEdgeSetOf(vf: VirtualFace, edge: PanelEdgeDir, group: ConnectorGroup, st: St = useAppStore.getState()): ConnectorLayoutSet | undefined {
  const pick = vf.connectorEdges?.[edge]?.set;
  if (pick === null) return undefined;
  return (pick ? setsOfGroup(group, st.connectorLayouts).find(s => s.id === pick) : undefined) ?? panelSetOf(vf, group, st);
}
/** Panelin o KENARINDAKİ delik yüzü: kenarın kendi seçimi → panelin / grubunun seçimi → tipin kenar ayarı. */
export const panelEdgeFlip = (vf: VirtualFace, edge: PanelEdgeDir, ruleFlip: boolean, st: St = useAppStore.getState()): boolean =>
  vf.connectorEdges?.[edge]?.flip ?? panelFlipPick(vf, st) ?? ruleFlip;
/* ───────── DELİK YÜZÜ (bağlayıcının yönü) ─────────
   Yüz delikleri (bağlayıcının "B face" işlemleri — ör. kam yuvası) dayanan panelin iki geniş yüzünden birine delinir. Tipin kenarı yüzü söyler
   (`flipFace`: false = varsayılan / görünmeyen yüz, bkz. hiddenFaceRole); panel kendi kaydıyla (`connectorFlip`) bütün kenarları için değiştirir. */
export interface HoleFaceOption { flip: boolean; label: string }
/** Tipin iki geniş yüzü, doğal sırayla (üst / alt · dış / iç · ön / arka) + her birinin `flipFace` karşılığı. */
export function holeFaceOptions(type: PanelTypeId, plane: Exclude<PanelPlane, 'any'>): [HoleFaceOption, HoleFaceOption] {
  if (TYPE_BY_ID.get(type)?.group === 'boxing') return [{ flip: true, label: 'Visible face' }, { flip: false, label: 'Hidden face' }];
  if (plane === 'horizontal') { const top = type === 'top' || type.startsWith('top'); return [{ flip: !top, label: 'Top face' }, { flip: top, label: 'Underside' }]; }
  if (plane === 'frontal') return [{ flip: true, label: 'Front face' }, { flip: false, label: 'Rear face' }];
  return [{ flip: false, label: 'Outer face' }, { flip: true, label: 'Inner face' }];
}
/** Yüz adının açıklaması (ipucu) — yalnız adın açıklama istediği yerde (dış / iç · görünmeyen / görünen); üst / alt ve ön / arka kendini anlatır. */
export function holeFaceHint(type: PanelTypeId, plane: Exclude<PanelPlane, 'any'>): string {
  if (TYPE_BY_ID.get(type)?.group === 'boxing') return 'Hidden face = the face that looks at the column / beam.';
  return plane === 'side' ? 'Outer face = the face that looks away from the middle of the cabinet (on a divider standing exactly in the middle: its left face).' : '';
}
/** Tipin bağlayıcılı kenarlarındaki yüz ayarı: hepsi aynıysa o değer · karışıksa null · bağlayıcılı kenar yoksa undefined. */
export function typeFlipOf(type: PanelTypeId | null | undefined, cfg?: PanelTypeConfig): boolean | null | undefined {
  const edges = type ? typeRuleOf(type, cfg).edges : {};
  const flips = (Object.keys(edges) as PanelEdgeDir[]).flatMap(e => rulesIn(edges, e).map(r => !!r.flipFace));
  return !flips.length ? undefined : flips.every(f => f === flips[0]) ? flips[0] : null;
}
/** Panelin ELLE seçtiği delik yüzü: panelin kendi kaydı → raf / dikme grubunun kaydı; yoksa undefined (tipin kenar ayarı geçerli). */
export const panelFlipPick = (vf: VirtualFace, st: St = useAppStore.getState()): boolean | undefined =>
  (vf.connectorFlip !== undefined ? vf.connectorFlip : groupOfVf(vf, st)?.connectorFlip);
/** Panelin delik yüzü (BÜTÜN kenarları): true / false = bu panelin bütün bağlayıcılı kenarlarında o yüz · undefined = kayıt silinir (tipin
 *  ayarı). Kenar-özel yüz seçimleri silinir (panel genelindeki seçim hepsine uygulanır). */
export function setVfConnectorFlip(vfId: string, flip: boolean | undefined): void {
  const st = useAppStore.getState(), vf = st.virtualFaces.find(f => f.id === vfId); if (!vf) return;
  st.updateVirtualFace(vfId, { connectorFlip: flip, connectorEdges: dropEdgeField(vf.connectorEdges, 'flip') });
  refreshConnectorBodies(vf.shapeId);
}
/** Raf / dikme grubunun delik yüzü: tüm üyeler (üyede elle seçim varsa o kalır). */
export function setGroupConnectorFlip(groupId: string, flip: boolean | undefined): void {
  useAppStore.setState(s => ({ panelGroups: s.panelGroups.map(g => (g.id === groupId ? { ...g, connectorFlip: flip } : g)) }));
  refreshConnectorBodies(useAppStore.getState().panelGroups.find(x => x.id === groupId)?.shapeId);
}
/** Raf / dikme grubunun seti: tüm üyeler (üyede elle seçim varsa o kalır). */
export function setGroupConnectorSet(groupId: string, group: ConnectorGroup, id: string | null | undefined): void {
  useAppStore.setState(s => ({ panelGroups: s.panelGroups.map(g => (g.id === groupId ? { ...g, connectorSets: withSet(g.connectorSets, group, id) } : g)) }));
  refreshConnectorBodies(useAppStore.getState().panelGroups.find(x => x.id === groupId)?.shapeId);
}

/* ───────── SET (Accessories › Layout): satır = tek bağlayıcı + kendi ölçüleri (dört kuraldan biri) + boy aralığı ───────── */
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
  id: genId('ll'), connectorId, kind: 'ends', rule: genId('lr'), min: 0, max: 0, start: 50, end: 50, midFrom: 600, pitch: LAYOUT_PITCH,
  steps: [{ d: 256, n: 1 }, { d: 224, n: 1 }], points: [{ from: 'start', d: 50 }, { from: 'end', d: 50 }], ...init,
});
export const newLayoutSet = (name = 'Layout', connectorId: string | null = null, group: ConnectorGroup = 'fixed'): ConnectorLayoutSet =>
  ({ id: genId('lay'), name, group, lines: [newLayoutLine(connectorId)], createdAt: Date.now() });
/** Satırın kuralı (aynı kuralın satırları boy aralığını paylaşır); kimliksiz eski satır tek başına bir kuraldır. */
export const ruleIdOf = (l: Pick<LayoutLine, 'id' | 'rule'>): string => l.rule ?? l.id;
/** Kurala eklenen yeni bağlayıcı satırı: aynı boy aralığı, aynı kural türü; ölçüler öncekinin 32 mm içinde (üst üste gelmesin), orta bağlayıcı yok. */
export function newRuleLine(last: LayoutLine, connectorId: string | null): LayoutLine {
  return newLayoutLine(connectorId, {
    rule: ruleIdOf(last), min: last.min, max: last.max, kind: last.kind, pitch: last.pitch, midFrom: 0, start: last.start + LAYOUT_PITCH, end: last.end + LAYOUT_PITCH,
    steps: last.steps.map(st => ({ d: st.d, n: st.n })), points: last.points.map(p => ({ from: p.from, d: p.d + LAYOUT_PITCH })),
  });
}
export const cloneLayoutSet = (l: ConnectorLayoutSet): ConnectorLayoutSet => JSON.parse(JSON.stringify(l)) as ConnectorLayoutSet;
/** Satır bu birleşim boyunda geçerli mi (boy tam mm'ye yuvarlanır: "40 – 99" ile "100 – 500" arasında boşluk kalmaz). */
export const lineApplies = (l: Pick<LayoutLine, 'min' | 'max'>, length: number): boolean => {
  const L = Math.round(length);
  return L >= (l.min || 0) && (!(l.max > 0) || L <= l.max);
};
/** Liste noktasının birleşimin başından mm'si · tersi: o yere düşen noktanın `d`'si (ortadan ölçülen eksi olabilir). */
type ListPoint = LayoutLine['points'][number];
export const pointPos = (p: Pick<ListPoint, 'from' | 'd'>, length: number): number => (p.from === 'end' ? length - p.d : p.from === 'mid' ? length / 2 + p.d : p.d);
export const pointD = (from: ListPoint['from'], pos: number, length: number): number => (from === 'end' ? length - pos : from === 'mid' ? pos - length / 2 : pos);
/** Satırın bağlayıcı noktaları (birleşimin başından mm) — boy aralığına BAKMADAN. Baş + son mesafesine sığmayan birleşimde tek bağlayıcı ortada.
 *  'grid' / 'steps': son delik sondan EN AZ `end` uzakta kalır; 'steps'te sığmayan adım atlanır, sıra sonrakine geçer. */
/** 'steps' uç kipi (eski `endFixed` → 'both'). */
export const stepEndsOf = (l: Pick<LayoutLine, 'stepEnds' | 'endFixed'>): NonNullable<LayoutLine['stepEnds']> => l.stepEnds ?? (l.endFixed ? 'both' : 'front');
/** Arka / ön değer EN AZ mesafe mi (yaklaşık: gerçek mesafe bu ya da biraz fazlası). Arka: 'grid' her zaman, 'steps' iki uç sabit değilse · ön: yalnız ortalanan 'steps'. */
export const rearIsMin = (l: Pick<LayoutLine, 'kind' | 'stepEnds' | 'endFixed'>): boolean => l.kind === 'grid' || (l.kind === 'steps' && stepEndsOf(l) !== 'both');
export const frontIsMin = (l: Pick<LayoutLine, 'kind' | 'stepEnds' | 'endFixed'>): boolean => l.kind === 'steps' && stepEndsOf(l) === 'centre';
/** Elle girilen liste mi ('list' + eşit aralık kipi değil). */
export const isHandList = (l: Pick<LayoutLine, 'kind' | 'listMode'>): boolean => l.kind === 'list' && (l.listMode ?? 'hand') === 'hand';
export const LIST_EQUAL_COUNT = 3, LIST_EQUAL_GAP = 300;
export function linePositions(l: LayoutLine, length: number): number[] {
  if (!(length > 0)) return [];
  const uniq = (list: number[]) => [...new Set(list.map(round1))].sort((x, y) => x - y);
  if (l.kind === 'list' && (l.listMode === 'equal' || l.listMode === 'gap')) {
    // Uçlar SABİT, aradakiler eşit aralık: `count` bağlayıcı (uçlar dahil) — 'gap'te adet, aralık `gap`'e en yakın çıkacak şekilde hesaplanır.
    // 1 bağlayıcı ya da uçlar sığmıyorsa tek bağlayıcı ortada.
    const a = Math.max(0, l.start), b = length - Math.max(0, l.end);
    const n = l.listMode === 'gap' ? Math.max(1, Math.round((b - a) / Math.max(1, l.gap ?? LIST_EQUAL_GAP))) + 1 : Math.max(1, Math.round(l.count ?? LIST_EQUAL_COUNT));
    if (n === 1 || b - a < 1) return [round1(length / 2)];
    return uniq(Array.from({ length: Math.min(n, 80) }, (_, i) => a + ((b - a) * i) / (n - 1)));
  }
  if (l.kind === 'list') return uniq(l.points.map(p => pointPos(p, length)).filter(d => d >= 0 && d <= length));
  const a = Math.max(0, l.start), b = length - Math.max(0, l.end), mid = l.midFrom > 0 && length >= l.midFrom - 1e-6;
  if (l.kind === 'ends') {
    if (b - a < 1) return [round1(length / 2)];
    return mid && length / 2 - a > 1 && b - length / 2 > 1 ? uniq([a, length / 2, b]) : uniq([a, b]);
  }
  const ends = l.kind === 'steps' ? stepEndsOf(l) : 'front';
  // Ortalanmış adımlar: önce adımlar (iki uçta en az `start` kalacak kadar) sığdırılır, sonra desen ortaya kaydırılır → ön = arka.
  if (ends === 'centre') {
    const room = length - 2 * a, rel = [0];
    if (room < -1e-6) return [round1(length / 2)];
    let p = 0;
    for (const st of l.steps) {
      const d = Math.max(1, st.d);
      for (let i = 0; (st.n <= 0 || i < st.n) && p + d <= room + 1e-6 && rel.length < 80; i++) { p += d; rel.push(p); }
    }
    const off = (length - p) / 2;
    return uniq(rel.map(r => off + r));
  }
  if (b - a < -1e-6) return [round1(length / 2)];
  if (l.kind === 'grid') {
    const pitch = l.pitch > 0 ? l.pitch : LAYOUT_PITCH, m = Math.floor((b - a) / pitch + 1e-6);
    return uniq([a, ...(m >= 2 && mid ? [a + Math.round(m / 2) * pitch] : []), ...(m >= 1 ? [a + m * pitch] : [])]);
  }
  const out = [a], gaps = [0];
  let pos = a;
  for (const st of l.steps) {
    const d = Math.max(1, st.d);
    for (let i = 0; (st.n <= 0 || i < st.n) && pos + d <= b + 1e-6 && out.length < 80; i++) { pos += d; out.push(pos); gaps.push(d); }
  }
  // Arka SABİT: son bağlayıcı tam arka mesafede; ona kendi adımının yarısından fazla yaklaşan adım deliği düşer (yerini sabit delik alır).
  if (ends === 'both' && b - a >= 1) {
    while (out.length > 1 && b - out[out.length - 1] < gaps[gaps.length - 1] / 2) { out.pop(); gaps.pop(); }
    out.push(b);
  }
  return uniq(out);
}
/** Satırın tek satırlık özeti. */
export function lineSummary(l: LayoutLine): string {
  const f = (v: number) => String(round1(v));
  if (l.kind === 'ends') return `${f(l.start)} / ${f(l.end)}${l.midFrom > 0 ? ` · middle from ${f(l.midFrom)}` : ''}`;
  if (l.kind === 'grid') return `${f(l.start)} / min ${f(l.end)} on ${f(l.pitch)}${l.midFrom > 0 ? ` · middle from ${f(l.midFrom)}` : ''}`;
  if (l.kind === 'steps') {
    const st = l.steps.map(s => `${f(s.d)}${s.n === 1 ? '' : s.n > 1 ? `×${s.n}` : '×fit'}`).join(' + '), ends = stepEndsOf(l);
    return ends === 'centre' ? `${st} · centred, min ${f(l.start)}` : `${f(l.start)} + ${st} · ${ends === 'both' ? 'rear' : 'min'} ${f(l.end)}`;
  }
  if (l.listMode === 'equal') return `${f(l.start)} / ${f(l.end)} · ${Math.max(1, Math.round(l.count ?? LIST_EQUAL_COUNT))} equal`;
  if (l.listMode === 'gap') return `${f(l.start)} / ${f(l.end)} · equal ≈ ${f(l.gap ?? LIST_EQUAL_GAP)}`;
  return l.points.map(p => (p.from === 'mid' ? (p.d ? `mid${p.d > 0 ? '+' : '−'}${f(Math.abs(p.d))}` : 'mid') : `${p.from === 'end' ? '←' : ''}${f(p.d)}${p.from === 'end' ? '' : '→'}`)).join(' · ') || 'empty';
}
export const lineRangeText = (l: Pick<LayoutLine, 'min' | 'max'>): string =>
  (l.max > 0 ? `${round1(l.min || 0)} – ${round1(l.max)} mm` : l.min > 0 ? `from ${round1(l.min)} mm` : 'any length');
async function saveLayoutSets(sets: ConnectorLayoutSet[]): Promise<void> {
  useAppStore.getState().setConnectorLayouts(sets);
  refreshConnectorBodies();
  await libraryPut('settings', { id: CONNECTOR_LAYOUTS_ID, sets });
}
/** Seti kaydeder; varsayılan işaretliyse grubundaki öteki setlerin işareti kalkar (grup başına tek varsayılan). */
export function saveLayoutSet(set: ConnectorLayoutSet): Promise<void> {
  const list = useAppStore.getState().connectorLayouts, g = setGroupOf(set);
  const next = list.some(x => x.id === set.id) ? list.map(x => (x.id === set.id ? set : x)) : [...list, set];
  return saveLayoutSets(set.isDefault ? next.map(x => (x.id !== set.id && setGroupOf(x) === g && x.isDefault ? { ...x, isDefault: undefined } : x)) : next);
}
/** Seti grubunun varsayılanı yapar: panelde elle seçim yapılmamış her yerde bu set kullanılır. */
export function setDefaultLayout(id: string): Promise<void> {
  const set = useAppStore.getState().connectorLayouts.find(x => x.id === id);
  return set ? saveLayoutSet({ ...set, isDefault: true }) : Promise.resolve();
}
/** Seti siler; onu elle seçmiş paneller grubun varsayılan setine döner (bkz. panelSetOf). */
export const deleteLayoutSet = (id: string): Promise<void> => saveLayoutSets(useAppStore.getState().connectorLayouts.filter(x => x.id !== id));
/** Seti ELLE seçmiş panel + raf / dikme grubu sayısı (liste rozeti). */
export const layoutUseCount = (id: string, st: St = useAppStore.getState()): number => {
  const has = (c: VirtualFace['connectorSets']) => !!c && Object.values(c).includes(id);
  return st.virtualFaces.filter(f => has(f.connectorSets)).length + st.panelGroups.filter(g => has(g.connectorSets)).length;
};
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
/** Kenarın bağlayıcı grubu (`group` null → kenardan bağlayıcılar kalkar) + delik yüzü. `flipFace` verilmezse kenarın kendi ayarı korunur;
 *  ilk kez bağlayıcı alan kenar tipin öteki kenarlarının yüzünü alır (hepsi öteki yüzdeyse o da öyle başlar). */
export function setEdgeGroup(type: PanelTypeId, edge: PanelEdgeDir, group: ConnectorGroup | null, flipFace?: boolean): Promise<void> {
  const cfg = useAppStore.getState().panelTypeConfig, edges = { ...typeRuleOf(type, cfg).edges }, cur = rulesIn(edges, edge)[0];
  const flip = flipFace ?? (cur ? !!cur.flipFace : typeFlipOf(type, cfg) === true);
  if (group) edges[edge] = [{ group, ...(flip ? { flipFace: true } : {}) }]; else delete edges[edge];
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
/** Panelin o kenarındaki bağlayıcıların adları (kenarın grubu → panelin o gruptaki seti → satırları; tekrarsız). */
export function edgeConnectorNames(vf: VirtualFace, type: PanelTypeId, edge: PanelEdgeDir, st: St = useAppStore.getState()): string[] {
  const ids = edgeRulesOf(type, edge, st.panelTypeConfig).flatMap(r => panelEdgeSetOf(vf, edge, r.group!, st)?.lines ?? []).map(l => l.connectorId);
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
/** Bağlayıcıyı siler; dizilimlerde onu kullanan satırlar bağlayıcısız kalır (satır durur, yeni bağlayıcı seçilir). */
export async function deleteConnector(id: string): Promise<void> {
  const st = useAppStore.getState();
  st.removeConnector(id);
  refreshConnectorBodies();
  await libraryDelete('connectors', id);
  if (st.connectorLayouts.some(x => x.lines.some(l => l.connectorId === id)))
    await saveLayoutSets(st.connectorLayouts.map(x => ({ ...x, lines: x.lines.map(l => (l.connectorId === id ? { ...l, connectorId: null } : l)) })));
}
/** Bağlayıcıyı kullanan dizilim sayısı (liste rozeti). */
export const connectorUseCount = (id: string, sets: ConnectorLayoutSet[] = useAppStore.getState().connectorLayouts): number =>
  sets.filter(x => x.lines.some(l => l.connectorId === id)).length;

// ═════════════════════════════════════════════════ 6. BİRLEŞİMLER: bağlayıcının gerçek panellere atılması ═════════════════════════════════════════════════
/* BİRLEŞİM = B panelinin UCU (kalınlık yüzü) A panelinin geniş yüzüne dayanıyor. B'nin tipinde o kenar için bağlayıcı tanımlıysa temas
   boyunca bağlayıcı noktaları dizilir; her noktada bağlayıcının delikleri / operasyonları B'ye (yüz + uç) ve A'ya (temas yüzü) kesilir, modeli
   sahneye konur. Yalnız eksene hizalı (dönmemiş, düz) paneller; kapaklar birleşime girmez. Okunan geometri panelin BİÇİM ağıdır
   (Geometry.outlineGeometry: çizim uygulanmış, kanal / delik kesilmemiş). */
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
 *  yan panellerde gövdenin dışına bakan yüz (tam ortadaki dikme: sol). Kenar kuralındaki `flipFace` — ya da panelin kendi `connectorFlip`
 *  kaydı — öteki yüze çevirir. Arayüzdeki yüz adları buna göre verilir (holeFaceOptions). */
function hiddenFaceRole(type: PanelTypeId, plane: Exclude<PanelPlane, 'any'>, body: Shape, box: THREE.Box3, thin: number, st: St): PanelEdgeDir {
  if (plane === 'horizontal') return type === 'top' || type.startsWith('top') ? 'top' : 'bottom';
  if (plane === 'frontal') return 'rear';
  const bb = bodyBoxOf(body), c = (box.min.getComponent(thin) + box.max.getComponent(thin)) / 2, bc = bb ? (bb.min.getComponent(thin) + bb.max.getComponent(thin)) / 2 : c;
  return Math.abs(c - bc) < 1 ? 'left' : roleOfDir(body, unit(thin, c > bc ? 1 : -1), st, boxCenterV(box));
}
const _jointCache = new Map<string, { sig: string; joints: PanelJoint[] }>();
/** Arkalıkla birleşimde bağlayıcı yalnız KALIN arkalıkta (mm; 18'lik levha — ölçü yuvarlaması payıyla). İnce arkalık çakılır / kanala girer. */
export const BACK_CONNECTOR_MIN_T = 17.5;
/** İki kutu gerçekten kesişiyor mu (her eksende `tol`'dan fazla). */
const boxesCut = (a: CavityBox, b: CavityBox, tol = 0.05): boolean => [0, 1, 2].every(k => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]) > tol);
/** Gövdenin tüm birleşimleri (kural + temas). Sonuç panel geometrileri / tipler / kütüphane değişene kadar saklanır. */
export function bodyJoints(bodyId: string, st: St = useAppStore.getState()): PanelJoint[] {
  const cfg = st.panelTypeConfig;
  if (!st.connectors.length || !st.connectorLayouts.length || !Object.values(cfg.rules ?? {}).some(ruleHasGroup)) return [];
  const body = shapeById(bodyId, st.shapes); if (!body) return [];
  const slabs = st.shapes.filter(s => s.type === 'panel' && s.parameters?.parentShapeId === bodyId && !isDoorPanel(s) && !s.parameters?.curved && !panelHasRotation(s))
    .map(p => {
      // Biçim ağı: çizimle biçimlenmiş panelde birleşim panelin GERÇEK kenarından okunur (çizim öncesi ayak izinden değil).
      const vf = vfOfPanel(p, st.virtualFaces), geo = outlineGeometry(p), info = slabInfo(geo); if (!vf || !info) return null;
      // Kalınlık ekseni: VF normali (dar şeritte en küçük ölçü kalınlık olmayabilir); belirsizse en küçük ölçü.
      const na = vf.normal.map(Math.abs), byN = na.indexOf(Math.max(...na));
      const thin = na[byN] > 0.9 ? byN : info.size.indexOf(Math.min(...info.size));
      return { p, vf, info, thin, uuid: geo!.uuid, type: panelTypeOf(vf, st), back: !!vf.backGroupId };
    }).filter((x): x is NonNullable<typeof x> => !!x);
  // Arkalık kanalları (panel başına bir kez): kanal açılan birleşime bağlayıcı atılmaz.
  const grooves = new Map<string, CavityBox[]>();
  const groovesOf = (p: Shape): CavityBox[] => grooves.get(p.id) ?? grooves.set(p.id, backGrooveCuttersFor(p)).get(p.id)!;
  // İmzada panelin elle set seçimi de var (setlerin içeriği ve varsayılanı `connectorLayouts` ile zaten imzada).
  const picks = (vf: VirtualFace) => `${CONNECTOR_GROUPS.map(g => panelSetPick(vf, g.key, st) ?? (panelSetPick(vf, g.key, st) === null ? '-' : '')).join('/')}/${panelFlipPick(vf, st) ?? ''}/${vf.connectorEdges ? JSON.stringify(vf.connectorEdges) : ''}`;
  const sig = `${slabs.map(s => `${s.p.id}:${s.uuid}:${s.type}:${picks(s.vf)}`).join('|')}#${JSON.stringify(cfg.rules ?? {})}#${st.connectors.map(c => c.id).join(',')}#${JSON.stringify(st.connectorLayouts)}#${bodyFrontAxis(body, st).facing}#${JSON.stringify(bodyFaceRolesOf(body))}#${JSON.stringify(st.backGroups.filter(g => g.shapeId === bodyId))}`;
  const hit = _jointCache.get(bodyId);
  if (hit && hit.sig === sig) {
    // Bağlayıcının içeriği (delik / model) değişmiş olabilir: nesne güncel listeden yeniden bağlanır.
    return hit.joints.map(j => ({ ...j, connector: st.connectors.find(c => c.id === j.connector.id) ?? j.connector }));
  }
  const joints: PanelJoint[] = [];
  for (const B of slabs) {
    const edges = B.type ? cfg.rules?.[B.type]?.edges : undefined;
    if (!B.type || !edges || !ruleHasGroup({ edges })) continue;
    const bc = boxCenterV(B.info.box);
    const plane = PLANE_OF_ROLE[roleOfDir(body, unit(B.thin, 1), st, bc)];
    const faceRoles: [PanelEdgeDir, PanelEdgeDir] = [roleOfDir(body, unit(B.thin, 1), st, bc), roleOfDir(body, unit(B.thin, -1), st, bc)];
    for (const i of [0, 1, 2]) if (i !== B.thin) for (const s of [1, -1]) {
      // Kenarın ortası (rol konuma bağlı — L gövdede aynı yöne bakan yüzlerin rolü farklı olabilir).
      const ec: Vec3 = [...bc]; ec[i] = s > 0 ? B.info.box.max.getComponent(i) : B.info.box.min.getComponent(i);
      const role = roleOfDir(body, unit(i, s), st, ec);
      // Kenarın grubu → PANELİN o kenardaki seti (kenar-özel seçim → panelin seti → varsayılan) → satırları (bağlayıcısı olanlar); satır kimliği birleşim anahtarına girer. Boy aralığı temas
      // boyu belli olunca elenir.
      const list = rulesIn(edges, role).flatMap(rule => (panelEdgeSetOf(B.vf, role, rule.group!, st)?.lines ?? [])
        .map(line => ({ rule, line, conn: st.connectors.find(c => c.id === line.connectorId) }))).filter(x => !!x.conn);
      if (!list.length) continue;
      const end = B.info.planes[i][s > 0 ? 1 : 0]; if (end.n < 3) continue;
      const c = s > 0 ? B.info.box.max.getComponent(i) : B.info.box.min.getComponent(i), a = [0, 1, 2].find(k => k !== i && k !== B.thin)!;
      const tB = end.max[B.thin] - end.min[B.thin];
      // Dizilim yönü: kenarın bitiş ucunun rolüne bakan eksen yönü (derinlikte önden arkaya …).
      const endRole = EDGE_ENDS[plane][role]?.[1];
      const aSign = roleOfDir(body, unit(a, 1), st, ec) === endRole ? 1 : roleOfDir(body, unit(a, -1), st, ec) === endRole ? -1 : 1;
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
        // ARKALIK: bağlayıcı yalnız kalın (18) arkalıkla DÜZ birleşimde — birleşimde kanal açılıyorsa (kanallı kenar / derz) atılmaz.
        if (B.back || A.back) {
          const bk = B.back ? B : A, other = B.back ? A : B;
          if (bk.info.size[bk.thin] < BACK_CONNECTOR_MIN_T) continue;
          const zone: CavityBox = { min: [0, 0, 0], max: [0, 0, 0] };
          zone.min[i] = c - 1; zone.max[i] = c + 1;
          zone.min[B.thin] = tOv[0] - 1; zone.max[B.thin] = tOv[1] + 1;
          zone.min[a] = aOv[0]; zone.max[a] = aOv[1];
          const solid: CavityBox = { min: other.info.box.min.toArray() as Vec3, max: other.info.box.max.toArray() as Vec3 };
          if (!other.back && groovesOf(other.p).some(g => boxesCut(g, zone) && boxesCut(g, solid))) continue;
        }
        const o: Vec3 = [0, 0, 0];
        o[i] = c; o[B.thin] = (end.min[B.thin] + end.max[B.thin]) / 2; o[a] = aSign > 0 ? aOv[0] : aOv[1];
        const length = round1(aOv[1] - aOv[0]);
        for (const { rule, line, conn } of list) {
          if (!lineApplies(line, length)) continue;
          const positions = linePositions(line, length); if (!positions.length) continue;
          joints.push({
            key: `${B.p.id}|${role}|${A.p.id}|${line.id}`, bId: B.p.id, aId: A.p.id, connector: conn!, o, along: unit(a, aSign), nIn: unit(i, -s),
            t: unit(B.thin, hidden * (panelEdgeFlip(B.vf, role, !!rule.flipFace, st) ? -1 : 1)), length, tB: round1(tB), tA: round1(A.info.size[i]), positions,
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
    return [...list.filter(r => !!r.layoutId || !!r.group), { layoutId: id, ...(old.some(r => r.flipFace) ? { flipFace: true } : {}) }];
  });
  if (!next) return;
  await saveLayoutSets(sets);
  await savePanelTypeConfig(next);
}
/** ESKİ iki bağlayıcılı satır (8. tur: `connector2Id` + nokta başına 1 / 2 / 1+2 seçimi) → her bağlayıcıya kendi satırı, aynı kuralda.
 *  Listede her bağlayıcı kendi noktalarını alır (birebir); öteki kurallarda iki satır da aynı ölçülerle gelir (nokta seçimi yeni düzende yok). */
function splitTwoConnectorLine(l: LayoutLine): LayoutLine[] {
  const { connector2Id, use, ...rest } = l, two = connector2Id !== undefined && connector2Id !== l.connectorId, rule = ruleIdOf(l);
  const uses = l.kind === 'list' ? l.points.map(p => p.c ?? 1) : l.kind === 'steps' ? [use?.start ?? 1, ...l.steps.map(s => s.c ?? 1)] : [use?.start ?? 1, use?.mid ?? 1, use?.end ?? 1];
  const part = (slot: 1 | 2): LayoutLine => ({
    ...rest, rule, steps: l.steps.map(({ d, n }) => ({ d, n })),
    points: l.points.filter(p => !two || l.kind !== 'list' || ((p.c ?? 1) & slot) !== 0).map(({ from, d }) => ({ from, d })),
  });
  if (!two) return [part(1)];
  const out = [
    ...(uses.some(u => u & 1) ? [part(1)] : []),
    ...(connector2Id && uses.some(u => u & 2) ? [{ ...part(2), id: genId('ll'), connectorId: connector2Id }] : []),
  ];
  return out.length ? out : [part(1)];
}
const isLegacyLine = (l: LayoutLine): boolean => l.connector2Id !== undefined || l.use !== undefined || l.steps.some(s => s.c !== undefined) || l.points.some(p => p.c !== undefined);
/** Açılışta bir kez: (a) iki bağlayıcılı eski satırlar ayrılır · (b) kenara ATANMIŞ dizilim (7. – 8. tur) → kenarın GRUBU; en çok kenarda
 *  kullanılan dizilim grubunun varsayılanı olur (panellerde elle seçim yokken önceki sonuca en yakın). */
export async function migrateConnectorGroups(): Promise<void> {
  const st = useAppStore.getState();
  let sets = st.connectorLayouts, setsTouched = false;
  if (sets.some(s => s.lines.some(isLegacyLine))) { sets = sets.map(s => (s.lines.some(isLegacyLine) ? { ...s, lines: s.lines.flatMap(splitTwoConnectorLine) } : s)); setsTouched = true; }
  const uses = new Map<string, number>();
  const next = mapEdgeRules(st.panelTypeConfig, list => {
    if (!list.some(r => !r.group && !!r.layoutId)) return list;
    const out: EdgeConnectorRule[] = [];
    for (const r of list) {
      const set = r.layoutId ? sets.find(x => x.id === r.layoutId) : undefined, group = r.group ?? (r.layoutId ? (set ? setGroupOf(set) : 'fixed') : undefined);
      if (!group || out.some(x => x.group === group)) continue;
      if (!r.group && r.layoutId) uses.set(r.layoutId, (uses.get(r.layoutId) ?? 0) + 1);
      out.push({ group, ...(r.flipFace ? { flipFace: true } : {}) });
    }
    return out;
  });
  for (const g of CONNECTOR_GROUPS) {
    const list = setsOfGroup(g.key, sets); if (list.some(s => s.isDefault)) continue;
    const best = [...list].sort((x, y) => (uses.get(y.id) ?? 0) - (uses.get(x.id) ?? 0))[0];
    if (best && (uses.get(best.id) ?? 0) > 0 && best !== list[0]) { sets = sets.map(s => (s.id === best.id ? { ...s, isDefault: true } : s)); setsTouched = true; }
  }
  if (setsTouched) await saveLayoutSets(sets);
  if (next) await savePanelTypeConfig(next);
}
const SAMPLE_SEEDED_KEY = 'yago.accessories.connectorSampleSeeded', LAYOUT_SEEDED_KEY = 'yago.accessories.layoutSampleSeeded';
/** Açılışta: eski dizilimler çevrilir; ilk açılışta bir kez "Connector 1" yoksa örnek bağlayıcı, hiç dizilim yoksa onunla örnek dizilim
 *  eklenir (silinirse geri gelmez). */
export async function seedConnectorSample(): Promise<void> {
  try { await migrateLegacyLayouts(); await migrateConnectorGroups(); } catch (err) { console.warn('[YAGO][BAĞLAYICI] eski dizilimler çevrilemedi:', err); }
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

// ═════════════════════════════════════════════════ 8. KENAR BANDI ═════════════════════════════════════════════════
/* KİM NEYİ SÖYLER: bant tipi (panel tipi · kapak) × KENAR ROLÜ → bant kalınlığı (Accessories › Edge banding) · panel → kendi kenarını elle
   değiştirir (VirtualFace.edgeBands; kuralı da birleşim kuralını da ezer) · BİRLEŞİM → o kenarın boyu başka bir panele dayanıyorsa bant atılmaz
   (kural bant dese de).
   KENAR = panelin biçim ağındaki (Geometry.outlineGeometry: çizim uygulanmış, kanal / delik kesilmemiş) her KALINLIK YÜZÜ. Rolü, yüzün
   baktığı yöndeki gövde yüzünün rolüdür (roleOfDir) — panele sonradan çıkarma / çentik / çizim uygulanınca oluşan yeni yüzler de baktıkları
   role göre kendiliğinden bant alır; kenar sayısı dört değildir. Dönmüş / eğik / gönyeli panelde de aynı hesap (hepsi gövde-yerel 3B).
   BİRLEŞİM ALGISI: kenar yüzü boyunca örnek noktalar yüzün dışına `BAND_REACH` mm itilir; nokta başka bir panelin (kapak hariç) hacmine
   düşüyorsa orası örtülüdür (yüzüne dayanma · uç uca dayanma · kanala girme hepsi). Örtülü boy oranı `BAND_JOINT_COVER`'ı aşarsa birleşimdir.
   GÖRÜNÜM: bantsız kenar ham levha renginde (kahverengi), bantlı kenar yüzey renginde — paintPanelBands panel ağına köşe rengi yazar. */
/** `raw` = arayüzde ham levha rengi · `rawPaint` = 3B sahnede köşe rengi (sahne ışığı parlak; aynı ton için daha koyu yazılır) ·
 *  `band` = panel önizlemesinde BANTLI kenarın rengi (kenarın tam üstünde ince çizgi; etiket ve göstergedeki işaret de bu renk). */
export const BAND_COLORS = { raw: '#b0855a', rawEdge: '#7f5b36', rawSoft: '#d9bf9f', rawPaint: '#6f4f31', band: '#2563eb' } as const;
/** Kenar boyunun bu oranı başka panele dayanıyorsa kenar BİRLEŞİMDİR (bant atılmaz). */
export const BAND_JOINT_COVER = 0.9;
/** Temas payı (mm): kenarla komşu panel arasındaki bu kadar boşluk dayanma sayılır (arkalık boşluğu 0,5 dahil). */
const BAND_REACH = 0.75;
export interface BandTypeDef { id: BandTypeId; label: string; short: string; group: PanelTypeGroup | 'door'; plane: PanelPlane }
export const BAND_TYPES: BandTypeDef[] = [...PANEL_TYPES.map(({ id, label, short, group, plane }) => ({ id, label, short, group, plane })),
  { id: 'door', label: 'Door', short: 'Door', group: 'door', plane: 'frontal' }];
export const BAND_TYPE_GROUPS: Array<{ key: BandTypeDef['group']; label: string }> = [...PANEL_TYPE_GROUPS.filter(g => g.key !== 'free'), { key: 'door', label: 'Doors' }, { key: 'free', label: 'Other' }];
export const bandTypeDef = (id: BandTypeId | null | undefined): BandTypeDef | undefined => BAND_TYPES.find(t => t.id === id);
/** Panelin bant tipi: kapak → 'door' · baza seti → yok · ötekiler panel tipi. */
export function bandTypeOf(vf: VirtualFace | undefined | null, st: St = useAppStore.getState()): BandTypeId | null {
  if (!vf || vf.plinthId) return null;
  return vf.doorGroupId ? 'door' : panelTypeOf(vf, st);
}
/** Kuralın o kenar rolündeki bant kalınlığı (0 = bantsız). Yan yüze konmuş kapakta ön / arka kenar, kapağın sağ / sol kuralını okur. */
export function bandRuleOf(type: BandTypeId | null | undefined, role: PanelEdgeDir, cfg: EdgeBandConfig = useAppStore.getState().edgeBandConfig): number {
  const r = type ? cfg.rules[type] : undefined; if (!r) return 0;
  if (r[role]) return r[role]!;
  return type === 'door' && (role === 'front' || role === 'rear') ? r[role === 'front' ? 'right' : 'left'] ?? 0 : 0;
}
export const bandMm = (v: number): number => (Number.isFinite(v) && v > 0 ? Math.min(10, Math.round(v * 100) / 100) : 0);
/** Bant kalınlığı yazısı (iki ondalığa kadar: 0.45 · 1 · 2). */
export const fmtBand = (mm: number): string => String(Math.round(mm * 100) / 100);
export function saveEdgeBandConfig(cfg: EdgeBandConfig): Promise<void> {
  useAppStore.getState().setEdgeBandConfig(cfg);
  return libraryPut('settings', { id: EDGE_BAND_CONFIG_ID, ...cfg });
}
/** Tipin kenar(lar)ına bant kalınlığı (0 → bantsız). */
export function setBandRule(type: BandTypeId, roles: PanelEdgeDir | PanelEdgeDir[], mm: number): Promise<void> {
  const cfg = useAppStore.getState().edgeBandConfig, edges: EdgeBandRule = { ...(cfg.rules[type] ?? {}) }, t = bandMm(mm);
  for (const role of Array.isArray(roles) ? roles : [roles]) { if (t > 0) edges[role] = t; else delete edges[role]; }
  return saveEdgeBandConfig({ ...cfg, rules: { ...cfg.rules, [type]: edges } });
}
export const patchEdgeBandConfig = (p: Partial<EdgeBandConfig>): Promise<void> => saveEdgeBandConfig({ ...useAppStore.getState().edgeBandConfig, ...p });
/** Tipin bantlı kenar sayısı (liste rozeti). */
export const bandEdgeCount = (type: BandTypeId, cfg: EdgeBandConfig = useAppStore.getState().edgeBandConfig): number => Object.values(cfg.rules[type] ?? {}).filter(v => (v ?? 0) > 0).length;
/** PANELİN kenarı (elle): mm · 0 = bu kenarda bant yok · undefined = kayıt silinir (kural + birleşim izlenir). */
export function setVfEdgeBand(vfId: string, role: PanelEdgeDir, mm: number | undefined): void {
  const st = useAppStore.getState(), vf = st.virtualFaces.find(f => f.id === vfId); if (!vf) return;
  const next = { ...(vf.edgeBands ?? {}) };
  if (mm === undefined) delete next[role]; else next[role] = bandMm(mm);
  st.updateVirtualFace(vfId, { edgeBands: Object.keys(next).length ? next : undefined });
}
export const clearVfEdgeBands = (vfId: string): void => useAppStore.getState().updateVirtualFace(vfId, { edgeBands: undefined });

/** Panelin bir kenarı (kalınlık yüzü). Konumlar gövde-yerel. */
export interface BandEdge {
  /** `rol#sıra` (aynı role bakan yüzler dıştan içe sıralı). */
  key: string; role: PanelEdgeDir; curved: boolean;
  /** Yüzün dış normali (panel düzlemindeki bileşeni) · orta çizgisinin uçları · boyu · eni (panel kalınlığı). */
  out: Vec3; a: Vec3; b: Vec3; length: number; width: number;
  /** Kuralın değeri · panelin elle kaydı (varsa) · başka panele dayanan boy oranı · birleşim mi · dayandığı panellerin adları. */
  rule: number; own?: number; cover: number; joint: boolean; jointWith: string[];
  /** SONUÇ bant kalınlığı (0 = bantsız) ve nereden geldiği. */
  band: number; source: 'manual' | 'joint' | 'rule' | 'none';
}
interface BandPaintEdge { n: THREE.Vector3; d: number; L: THREE.Vector3; l0: number; l1: number; on: boolean; cents: Array<{ c: THREE.Vector3; n: THREE.Vector3; r: number }> | null }
export interface PanelBanding {
  /** İçerik imzası: değişince görünüm (3B renkler, önizleme) yenilenir. */
  key: string; panelId: string; vfId: string; type: BandTypeId | null; edges: BandEdge[];
  /** Bitmiş ölçü ve KESİM ölçüsü (bant düşülmüş) — panelin kendi çerçevesinde [küçük eksen, büyük eksen] sırasıyla (önizlemenin en / boy sırası). */
  size: [number, number] | null; cut: [number, number] | null;
  /** Boyama verisi (paintPanelBands). */
  thin: THREE.Vector3 | null; tRange: [number, number]; paint: BandPaintEdge[];
}
/** Örten panel: kalınlık yönü + kalınlık aralığı + geniş yüz üçgenleri (kalınlık yönüne dik düzlemde). */
interface BandSlab { id: string; name: string; thin: THREE.Vector3; t0: number; t1: number; u: THREE.Vector3; v: THREE.Vector3; box: THREE.Box3; tris: number[] }
const v3 = (a: THREE.Vector3): Vec3 => [round1(a.x), round1(a.y), round1(a.z)];
/** Panelin kalınlık yönü (gövde-yerel): VF normalinin ekseni panelin kendi çerçevesinde (dönmüş panelde geri döndürülür); eğri panelde yok. */
function bandThinDir(panel: Shape, vf: VirtualFace | undefined, geo: THREE.BufferGeometry): THREE.Vector3 | null {
  if (panel.parameters?.curved) return null;
  const fr = panelFrameOf(panel);
  if (fr && vf) {
    const na = vf.normal.map(Math.abs), i = na.indexOf(Math.max(...na));
    if (na[i] > 0.9) return new THREE.Vector3().setComponent(i, 1).applyQuaternion(fr.inv.clone().invert()).normalize();
  }
  return largestFaceNormal(geo)?.normalize() ?? null;
}
const perpTo = (n: THREE.Vector3): THREE.Vector3 => {
  const a = Math.abs(n.x) < 0.8 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  return a.addScaledVector(n, -a.dot(n)).normalize();
};
/** Nokta (x, y) üçgen listesinin (6'şar sayı) içinde mi. */
function inTris(tris: number[], x: number, y: number, eps = 0.02): boolean {
  for (let i = 0; i < tris.length; i += 6) {
    const ax = tris[i], ay = tris[i + 1], bx = tris[i + 2], by = tris[i + 3], cx = tris[i + 4], cy = tris[i + 5];
    const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by), d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy), d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
    if (!((d1 < -eps || d2 < -eps || d3 < -eps) && (d1 > eps || d2 > eps || d3 > eps))) return true;
  }
  return false;
}
interface BandSource { panel: Shape; vf: VirtualFace; geo: THREE.BufferGeometry; type: BandTypeId | null; thin: THREE.Vector3 | null; door: boolean }
function bandSlabOf(s: BandSource, st: St): BandSlab | null {
  if (!s.thin || s.door) return null;
  const { faces } = getFacesAndGroups(s.geo), u = perpTo(s.thin), v = new THREE.Vector3().crossVectors(s.thin, u), tris: number[] = [];
  let t0 = Infinity, t1 = -Infinity;
  const box = new THREE.Box3();
  for (const f of faces) {
    for (const p of f.vertices) { const t = p.dot(s.thin); if (t < t0) t0 = t; if (t > t1) t1 = t; box.expandByPoint(p); }
    if (Math.abs(f.normal.dot(s.thin)) > 0.95) for (const p of f.vertices) tris.push(p.dot(u), p.dot(v));
  }
  return tris.length ? { id: s.panel.id, name: panelNameOf(s.vf, st), thin: s.thin, t0, t1, u, v, box: box.expandByScalar(1), tris } : null;
}
/** Kenar yüzünün başka panellere dayanan boy oranı + dayandığı paneller. `cols` = boy boyunca örnek sütunları (her biri yüz üstünde noktalar). */
function bandCoverOf(cols: THREE.Vector3[][], weights: number[] | null, slabs: BandSlab[], selfId: string): { cover: number; by: string[] } {
  const hits = new Map<string, number>();
  let total = 0, covered = 0;
  cols.forEach((col, ci) => {
    const w = weights?.[ci] ?? 1; total += w;
    for (const p of col) {
      let hit: BandSlab | null = null;
      for (const s of slabs) {
        if (s.id === selfId || !s.box.containsPoint(p)) continue;
        const t = p.dot(s.thin); if (t < s.t0 - 0.05 || t > s.t1 + 0.05) continue;
        if (inTris(s.tris, p.dot(s.u), p.dot(s.v))) { hit = s; break; }
      }
      if (hit) { covered += w; hits.set(hit.name, (hits.get(hit.name) ?? 0) + w); return; }
    }
  });
  return { cover: total > 0 ? covered / total : 0, by: [...hits].filter(([, w]) => w >= total * 0.15).sort((x, y) => y[1] - x[1]).map(([n]) => n) };
}
function panelBandingOf(s: BandSource, body: Shape, slabs: BandSlab[], cfg: EdgeBandConfig, st: St): PanelBanding {
  const { faces, groups } = getFacesAndGroups(s.geo), T = s.thin;
  let t0 = Infinity, t1 = -Infinity;
  if (T) for (const f of faces) for (const p of f.vertices) { const t = p.dot(T); if (t < t0) t0 = t; if (t > t1) t1 = t; }
  const thick = T ? t1 - t0 : Number(s.panel.parameters?.panelThickness) || 18;
  const raws: Array<{ e: Omit<BandEdge, 'key'>; paint: BandPaintEdge }> = [];
  for (const g of groups) {
    const n = g.normal.clone().normalize();
    // Geniş yüz: düz panelde kalınlık yönüne bakan düz yüzler; eğri panelde eğri yüzler.
    if (T ? !g.isCurved && Math.abs(n.dot(T)) > 0.95 : !!g.isCurved) continue;
    const nIn = T ? n.clone().addScaledVector(T, -n.dot(T)) : n.clone();
    if (nIn.lengthSq() < 1e-6) continue;
    nIn.normalize();
    // Rol, kenarın ÖNÜNDEKİ gövde yüzünden (konuma bağlı): L gövdede çentiğe bakan kenar çentik yüzünün rolünü alır.
    const role = roleOfDir(body, [nIn.x, nIn.y, nIn.z], st, [g.center.x, g.center.y, g.center.z]), tris = g.faceIndices.map(fi => faces[fi]);
    const own = s.vf.edgeBands?.[role], rule = bandRuleOf(s.type, role, cfg);
    let cols: THREE.Vector3[][] = [], weights: number[] | null = null, length = 0, a = g.center.clone(), b = g.center.clone();
    const paint: BandPaintEdge = { n, d: 0, L: new THREE.Vector3(), l0: 0, l1: 0, on: false, cents: null };
    const byCentroid = () => { cols = tris.map(f => [f.center.clone().addScaledVector(f.normal, BAND_REACH)]); weights = tris.map(f => f.area); };
    if (g.isCurved) {
      // Eğri kenar (radüslü köşe): boy = alan ÷ kalınlık; örnekler üçgen merkezleri.
      length = thick > 0 ? g.totalArea / thick : 0;
      byCentroid();
      paint.cents = tris.map(f => ({ c: f.center, n: f.normal, r: Math.max(...f.vertices.map(p => p.distanceTo(f.center))) }));
    } else {
      // Düz kenar: yüz düzleminde (L = boy yönü, W = en yönü) kutusu; orta çizgi boyunca üç sıra örnek, yüzün dışına düşen örnek sayılmaz.
      const L = (T ? new THREE.Vector3().crossVectors(T, nIn) : perpTo(n)).normalize(), W = new THREE.Vector3().crossVectors(n, L).normalize();
      let l0 = Infinity, l1 = -Infinity, w0 = Infinity, w1 = -Infinity;
      const d = n.dot(tris[0].vertices[0]), flat: number[] = [];
      for (const f of tris) for (const p of f.vertices) {
        const l = p.dot(L), w = p.dot(W); flat.push(l, w);
        if (l < l0) l0 = l; if (l > l1) l1 = l; if (w < w0) w0 = w; if (w > w1) w1 = w;
      }
      // Eğri panelin uç yüzü yay biçimli şerittir: kutusu dolu değil → boy = alan ÷ kalınlık, örnekler üçgen merkezleri.
      const boxy = g.totalArea > (l1 - l0) * (w1 - w0) * 0.7;
      length = boxy ? l1 - l0 : thick > 0 ? g.totalArea / thick : l1 - l0;
      const at = (l: number, w: number) => new THREE.Vector3().addScaledVector(L, l).addScaledVector(W, w).addScaledVector(n, d);
      a = at(l0, (w0 + w1) / 2); b = at(l1, (w0 + w1) / 2);
      if (boxy) {
        const nCol = Math.max(6, Math.min(120, Math.ceil((l1 - l0) / 6)));
        for (let i = 0; i < nCol; i++) {
          const l = l0 + ((i + 0.5) / nCol) * (l1 - l0), col: THREE.Vector3[] = [];
          for (const k of [0.5, 0.25, 0.75]) { const w = w0 + k * (w1 - w0); if (inTris(flat, l, w)) col.push(at(l, w).addScaledVector(n, BAND_REACH)); }
          if (col.length) cols.push(col);
        }
      }
      if (cols.length < 3) byCentroid();
      Object.assign(paint, { d, L, l0, l1 });
    }
    // Kapak hiçbir panele dayanmaz (boşlukla çalışır): birleşim aranmaz.
    const cv = s.door ? { cover: 0, by: [] as string[] } : bandCoverOf(cols, weights, slabs, s.panel.id);
    const joint = cfg.skipJoints && cv.cover >= BAND_JOINT_COVER;
    const band = own !== undefined ? own : joint ? 0 : rule;
    paint.on = band > 0;
    raws.push({ paint, e: {
      role, curved: !!g.isCurved, out: [nIn.x, nIn.y, nIn.z], a: v3(a), b: v3(b), length: round1(length), width: round1(thick), rule, ...(own !== undefined ? { own } : {}),
      cover: Math.round(cv.cover * 100) / 100, joint, jointWith: cv.by, band, source: own !== undefined ? 'manual' : joint ? 'joint' : rule > 0 ? 'rule' : 'none',
    } });
  }
  // Sıra: rol, sonra dıştan içe (aynı role bakan çentik yüzleri panelin dış kenarından sonra gelir), sonra konum.
  raws.sort(({ e: x, paint: px }, { e: y, paint: py }) => x.role.localeCompare(y.role) || py.d - px.d || x.a[0] - y.a[0] || x.a[1] - y.a[1] || x.a[2] - y.a[2]);
  const count: Partial<Record<PanelEdgeDir, number>> = {};
  const edges: BandEdge[] = raws.map(({ e }) => ({ ...e, key: `${e.role}#${(count[e.role] = (count[e.role] ?? 0) + 1)}` }));
  // Bitmiş / kesim ölçüsü: panelin kendi çerçevesinde düzlem eksenleri; en dıştaki düz kenarların bantları düşülür.
  let size: PanelBanding['size'] = null, cut: PanelBanding['cut'] = null;
  const fr = T ? panelFrameOf(s.panel) : null;
  if (T && fr) {
    const toBody = fr.inv.clone().invert(), ax = [0, 1, 2].map(i => new THREE.Vector3().setComponent(i, 1).applyQuaternion(toBody));
    const thinI = ax.map(v => Math.abs(v.dot(T))), ti = thinI.indexOf(Math.max(...thinI)), planar = [0, 1, 2].filter(i => i !== ti);
    const dims = planar.map(i => {
      const U = ax[i]; let lo = Infinity, hi = -Infinity;
      for (const f of faces) for (const p of f.vertices) { const c = p.dot(U); if (c < lo) lo = c; if (c > hi) hi = c; }
      let dLo = 0, dHi = 0;
      for (const { e: r } of raws) {
        if (r.curved || !(r.band > 0)) continue;
        const o = r.out[0] * U.x + r.out[1] * U.y + r.out[2] * U.z, c = ((r.a[0] + r.b[0]) * U.x + (r.a[1] + r.b[1]) * U.y + (r.a[2] + r.b[2]) * U.z) / 2;
        if (o > 0.95 && Math.abs(c - hi) < 0.6) dHi = Math.max(dHi, r.band); else if (o < -0.95 && Math.abs(c - lo) < 0.6) dLo = Math.max(dLo, r.band);
      }
      return [hi - lo, hi - lo - dLo - dHi];
    });
    size = [round1(dims[0][0]), round1(dims[1][0])];
    cut = cfg.deduct ? [Math.round(dims[0][1] * 100) / 100, Math.round(dims[1][1] * 100) / 100] : size;
  }
  const key = `${s.geo.uuid}|${edges.map(e => `${e.key}:${e.band}:${e.source[0]}:${e.cover}:${e.length}`).join(',')}|${cut?.join('x') ?? ''}`;
  return { key, panelId: s.panel.id, vfId: s.vf.id, type: s.type, edges, size, cut, thin: T, tRange: [t0, t1], paint: raws.map(r => r.paint) };
}
const _bandBody = new Map<string, { sig: string; list: PanelBanding[] }>();
/** Gövdenin bütün panellerinin kenar bandı durumu. Sonuç panel geometrileri / tipler / kurallar / elle kayıtlar değişene kadar saklanır. */
export function bodyBanding(bodyId: string, st: St = useAppStore.getState()): PanelBanding[] {
  const body = shapeById(bodyId, st.shapes); if (!body) return [];
  const cfg = st.edgeBandConfig;
  const srcs: BandSource[] = [];
  for (const p of st.shapes) {
    if (p.type !== 'panel' || p.parameters?.parentShapeId !== bodyId) continue;
    const vf = vfOfPanel(p, st.virtualFaces), geo = outlineGeometry(p); if (!vf || !geo?.getAttribute('position')) continue;
    srcs.push({ panel: p, vf, geo, type: bandTypeOf(vf, st), thin: bandThinDir(p, vf, geo), door: isDoorPanel(p) });
  }
  const sig = `${srcs.map(s => `${s.panel.id}:${s.geo.uuid}:${s.type}:${s.vf.edgeBands ? JSON.stringify(s.vf.edgeBands) : ''}`).join('|')}#${JSON.stringify(cfg.rules)}#${cfg.skipJoints}${cfg.deduct}#${bodyFrontAxis(body, st).facing}#${body.geometry.uuid}#${JSON.stringify(bodyFaceRolesOf(body))}`;
  const hit = _bandBody.get(bodyId);
  if (hit && hit.sig === sig) return hit.list;
  // Panel başına korumalı: beklenmedik bir ağ yalnız o paneli bantsız (boyasız) bırakır, gövdenin kalanı etkilenmez.
  const guard = <T,>(s: BandSource, fn: () => T): T | null => { try { return fn(); } catch (err) { console.warn(`[YAGO][KENAR BANDI] ${s.vf.description || s.panel.id} hesaplanamadı:`, err); return null; } };
  const slabs = srcs.map(s => guard(s, () => bandSlabOf(s, st))).filter((x): x is BandSlab => !!x);
  const list = srcs.map(s => guard(s, () => panelBandingOf(s, body, slabs, cfg, st))).filter((x): x is PanelBanding => !!x);
  if (_bandBody.size > 40) _bandBody.clear();
  _bandBody.set(bodyId, { sig, list });
  return list;
}
let _bandAll: { shapes: unknown; vfs: unknown; cfg: unknown; ptc: unknown; groups: unknown; map: Map<string, PanelBanding> } | null = null;
/** Bütün paneller (panel kimliği → durum): depo dilimleri değişmedikçe aynı nesne (seçici olarak her depo değişiminde çağrılır). */
function allBanding(st: St): Map<string, PanelBanding> {
  const m = _bandAll;
  if (m && m.shapes === st.shapes && m.vfs === st.virtualFaces && m.cfg === st.edgeBandConfig && m.ptc === st.panelTypeConfig && m.groups === st.panelGroups) return m.map;
  const map = new Map<string, PanelBanding>(), bodies = new Set<string>();
  for (const p of st.shapes) if (p.type === 'panel' && p.parameters?.parentShapeId) bodies.add(p.parameters.parentShapeId as string);
  for (const id of bodies) for (const b of bodyBanding(id, st)) map.set(b.panelId, b);
  _bandAll = { shapes: st.shapes, vfs: st.virtualFaces, cfg: st.edgeBandConfig, ptc: st.panelTypeConfig, groups: st.panelGroups, map };
  return map;
}
export const panelBanding = (panelId: string | undefined, st: St = useAppStore.getState()): PanelBanding | null => (panelId ? allBanding(st).get(panelId) ?? null : null);
/** Panelin bant imzası (zustand seçicisi: komşu panel değişip birleşim oluşunca da değişir). */
export const panelBandKey = (panelId: string | undefined, st: St = useAppStore.getState()): string => panelBanding(panelId, st)?.key ?? '';

/** Kenar rolü başına özet (önizleme etiketi, satır çipi): o role bakan bütün yüzler. `band` = ortak kalınlık, karışıksa null. */
export interface BandRoleSummary { role: PanelEdgeDir; edges: BandEdge[]; band: number | null; rule: number; own?: number; joint: 'all' | 'some' | 'none'; jointWith: string[]; length: number; banded: number }
export function bandRoles(b: PanelBanding | null): BandRoleSummary[] {
  const out: BandRoleSummary[] = [];
  for (const e of b?.edges ?? []) {
    let r = out.find(x => x.role === e.role);
    if (!r) { r = { role: e.role, edges: [], band: e.band, rule: e.rule, ...(e.own !== undefined ? { own: e.own } : {}), joint: 'none', jointWith: [], length: 0, banded: 0 }; out.push(r); }
    r.edges.push(e); r.length = round1(r.length + e.length);
    if (e.band > 0) r.banded = round1(r.banded + e.length);
    if (r.band !== e.band) r.band = null;
    for (const n of e.jointWith) if (e.joint && !r.jointWith.includes(n)) r.jointWith.push(n);
  }
  for (const r of out) { const j = r.edges.filter(e => e.joint).length; r.joint = !j ? 'none' : j === r.edges.length ? 'all' : 'some'; }
  return out;
}
/** Gövdenin bant toplamı: bant kalınlığı × kenar eni (panel kalınlığı) başına toplam boy (mm) ve kenar sayısı — kalın bant önce. */
export interface BandTotal { band: number; width: number; length: number; edges: number }
export function bodyBandTotals(bodyId: string, st: St = useAppStore.getState()): { rows: BandTotal[]; joints: number; manual: number } {
  const rows: BandTotal[] = [];
  let joints = 0, manual = 0;
  for (const b of bodyBanding(bodyId, st)) for (const e of b.edges) {
    if (e.source === 'joint' && e.rule > 0) joints++;
    if (e.source === 'manual') manual++;
    if (!(e.band > 0)) continue;
    let r = rows.find(x => x.band === e.band && x.width === e.width);
    if (!r) { r = { band: e.band, width: e.width, length: 0, edges: 0 }; rows.push(r); }
    r.length = round1(r.length + e.length); r.edges++;
  }
  return { rows: rows.sort((x, y) => y.band - x.band || y.width - x.width), joints, manual };
}

/* ───────── 3B görünüm: köşe renkleri ───────── */
const _bandPainted = new WeakMap<THREE.BufferGeometry, string>();
/** Panel ağına köşe rengi yazar (malzeme rengiyle ÇARPILIR): geniş yüzler ve BANTLI kenarlar 1 (yüzey rengi) · bantsız kenarlar, kanal / delik /
 *  cep yüzleri ham levha rengi. Köşeler B-Rep yüzü başınadır (yüzler köşe paylaşmaz) → renk yüzden yüze taşmaz. Aynı imzayla yeniden boyanmaz. */
export function paintPanelBands(geo: THREE.BufferGeometry | undefined | null, b: PanelBanding | null, base = '#ffffff'): void {
  const pos = geo?.getAttribute('position') as THREE.BufferAttribute | undefined; if (!geo || !pos) return;
  const sig = `${b?.key ?? '-'}|${base}|${pos.count}`;
  if (_bandPainted.get(geo) === sig && geo.getAttribute('color')) return;
  _bandPainted.set(geo, sig);
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute, col = new Float32Array(pos.count * 3).fill(1);
  if (b) {
    // Ham renk, panel rengine ORANLA (malzeme rengi çarpınca ham renk çıksın); doğrusal renk uzayında.
    const raw = new THREE.Color(BAND_COLORS.rawPaint), bc = new THREE.Color(base);
    const rr = Math.min(1, raw.r / Math.max(bc.r, 1e-3)), rg = Math.min(1, raw.g / Math.max(bc.g, 1e-3)), rb = Math.min(1, raw.b / Math.max(bc.b, 1e-3));
    const p = new THREE.Vector3(), n = new THREE.Vector3(), T = b.thin, [t0, t1] = b.tRange;
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i); n.fromBufferAttribute(nrm, i);
      let on: boolean;
      if (T && Math.abs(n.dot(T)) > 0.95) { const t = p.dot(T); on = Math.abs(t - t0) < 0.3 || Math.abs(t - t1) < 0.3; }   // geniş yüz; cep tabanı ham
      else {
        let hit: BandPaintEdge | null = null;
        for (const e of b.paint) {
          if (e.cents) { if (e.cents.some(c => Math.abs((p.x - c.c.x) * c.n.x + (p.y - c.c.y) * c.n.y + (p.z - c.c.z) * c.n.z) < 0.8 && p.distanceTo(c.c) < c.r + 1)) { hit = e; break; } continue; }
          if (n.dot(e.n) < 0.985 || Math.abs(p.dot(e.n) - e.d) > 0.4) continue;
          const l = p.dot(e.L); if (l < e.l0 - 0.6 || l > e.l1 + 0.6) continue;
          hit = e; break;
        }
        on = hit ? hit.on : !T;   // eşleşmeyen kalınlık yüzü = kanal / delik duvarı → ham (eğri panelde geniş yüz)
      }
      if (!on) { col[i * 3] = rr; col[i * 3 + 1] = rg; col[i * 3 + 2] = rb; }
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}
