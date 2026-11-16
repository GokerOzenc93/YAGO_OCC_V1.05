/* PANEL TİPLERİ + BAĞLAYICILAR — çekirdek (arayüz Accessories.tsx'te).
   1) Panel tipi kataloğu (İngilizce ad, düzlem, bölge) · yüzey → izinli tipler + varsayılan · panelin konumundan otomatik tip.
   2) Panelin kenar rolleri (ön / arka / üst / alt / sol / sağ) gövdenin yüz rollerinden okunur; bağlayıcı kuralı ve ileride kenar bandı
      aynı rolleri kullanır. 3) Kenar kuralı → kenar boyunca bağlayıcı noktaları.
   4) Bağlayıcı = delikler + çizilmiş operasyonlar (pocket / line) + modeller; hepsi TEMSİLİ BİRLEŞİM çerçevesinde (B paneli ucuyla A'nın
      yüzüne dayanır). Bu sürümde tanımlar gerçek panellere İŞLENMEZ; kayıt AccessoryService veritabanında (IndexedDB). */
import * as THREE from 'three';
import {
  type ConnHole, type ConnOp, type ConnOpType, type ConnPart, type ConnShape, type ConnSurface, type Connector, type EdgeConnectorRule, type PanelEdgeDir,
  type PanelGroup, type PanelSurface, type PanelSurfaceRule, type PanelTypeConfig, type PanelTypeId, type PanelTypeRule, type Shape, type VirtualFace,
  panelOfVf, shapeById, useAppStore,
} from '../store';
import { type Vec3, effectiveBodyGeometry, genId, localBboxOf, round1 } from './Geometry';
import { PANEL_TYPE_CONFIG_ID, libraryDelete, libraryPut } from './AccessoryService';
import { roleOfNormal } from './LegLayout';
import { bodyFaces, bodyFrontAxis } from './PlinthService';
import { geoAxes, panelFrameOf } from './PanelSchematics';

type St = ReturnType<typeof useAppStore.getState>;

// ═════════════════════════════════════════════════ 1. PANEL TİPİ KATALOĞU ═════════════════════════════════════════════════
/** Panelin düzlemi: yan (kalınlık sol–sağ) · yatay (kalınlık üst–alt) · önsel (kalınlık ön–arka) · serbest. Kenar rolleri bundan çıkar. */
export type PanelPlane = 'side' | 'horizontal' | 'frontal' | 'any';
/** Yüzeydeki yeri: otomatik tip seçimi bununla ayırır (üst yüzde öndeki dar şerit = ön kayıt gibi). */
type PanelZone = 'full' | 'front' | 'rear' | 'top' | 'bottom';
type PanelTypeGroup = 'carcass' | 'interior' | 'traverse' | 'plinth' | 'free';
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
  { id: 'free', label: 'Free panel', short: 'Free', code: 'FR', group: 'free', plane: 'any' },
];
const TYPE_BY_ID = new Map(PANEL_TYPES.map(t => [t.id, t]));
export const PANEL_TYPE_GROUPS: Array<{ key: PanelTypeGroup; label: string }> = [
  { key: 'carcass', label: 'Carcass' }, { key: 'interior', label: 'Interior' }, { key: 'traverse', label: 'Traverses' }, { key: 'plinth', label: 'Plinth' },
  { key: 'free', label: 'Other' },
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
/** Panelin yüzeyi: iç panelde araç (raf / dikme / arkalık), gövde panelinde üstünde durduğu gövde yüzünün rolü. Kapak / baza seti → null. */
function surfaceOfVf(vf: VirtualFace, st: St = useAppStore.getState()): PanelSurface | null {
  if (vf.doorGroupId || vf.plinthId) return null;
  if (vf.backGroupId) return 'back';
  if (vf.groupId) return st.panelGroups.find(g => g.id === vf.groupId)?.kind === 'divider' ? 'divider' : 'shelf';
  const body = shapeById(vf.shapeId, st.shapes); if (!body) return null;
  // VF'nin düzlemindeki gövde yüzü (üst üste panelde `stackDepth` kadar içeride); yoksa normalden.
  let best: { role: PanelEdgeDir; d: number } | null = null;
  for (const f of bodyFaces(body, st)) {
    if (dot3(f.normal, vf.normal) < 0.95) continue;
    const d = Math.abs(dot3([vf.center[0] - f.center[0], vf.center[1] - f.center[1], vf.center[2] - f.center[2]], f.normal) + (vf.stackDepth ?? 0));
    if (!best || d < best.d - 0.5) best = { role: f.role, d };
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
  if (vf.quickBody) { const q = quickBodyType(vf); if (q) return q; }
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
}
/** Raf / dikme grubunun tipi: tüm üyeler (üyede elle seçim varsa o kalır). */
export function setGroupPanelType(groupId: string, type: PanelTypeId | null): void {
  useAppStore.setState(s => ({ panelGroups: s.panelGroups.map(g => (g.id === groupId ? { ...g, panelType: type ?? undefined } : g)) }));
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
const DEFAULT_EDGE_RULE: EdgeConnectorRule = { connectorId: null, mode: 'spacing', start: 50, end: 50, maxSpacing: 400, count: 2 };
const typeRuleOf = (type: PanelTypeId, cfg: PanelTypeConfig = useAppStore.getState().panelTypeConfig): PanelTypeRule => cfg.rules?.[type] ?? { edges: {} };
export const edgeRuleOf = (type: PanelTypeId, edge: PanelEdgeDir, cfg?: PanelTypeConfig): EdgeConnectorRule => ({ ...DEFAULT_EDGE_RULE, ...(typeRuleOf(type, cfg).edges[edge] ?? {}) });
/** Kenar boyunca bağlayıcı noktaları (kenarın başından mm). Kenar uç mesafelerine sığmıyorsa tek bağlayıcı ortada. */
export function edgeConnectorPositions(rule: Pick<EdgeConnectorRule, 'mode' | 'start' | 'end' | 'maxSpacing' | 'count'>, length: number): number[] {
  if (!(length > 0)) return [];
  const a = Math.max(0, rule.start), b = length - Math.max(0, rule.end), span = b - a;
  if (span < 1) return [round1(length / 2)];
  const n = rule.mode === 'count' ? Math.max(1, Math.round(rule.count)) : Math.max(2, Math.ceil(span / Math.max(1, rule.maxSpacing) - 1e-9) + 1);
  if (n === 1) return [round1(length / 2)];
  return Array.from({ length: n }, (_, i) => round1(a + (span * i) / (n - 1)));
}
async function savePanelTypeConfig(cfg: PanelTypeConfig): Promise<void> {
  useAppStore.getState().setPanelTypeConfig(cfg);
  await libraryPut('settings', { id: PANEL_TYPE_CONFIG_ID, ...cfg });
}
/** Kenar kuralını yazar; `patch` null → kenardan bağlayıcı kalkar. */
export function setEdgeRule(type: PanelTypeId, edge: PanelEdgeDir, patch: Partial<EdgeConnectorRule> | null): Promise<void> {
  const cfg = useAppStore.getState().panelTypeConfig, edges = { ...typeRuleOf(type, cfg).edges };
  if (patch) edges[edge] = { ...edgeRuleOf(type, edge, cfg), ...patch }; else delete edges[edge];
  return savePanelTypeConfig({ ...cfg, rules: { ...cfg.rules, [type]: { edges } } });
}
export function setSurfaceRule(surface: PanelSurface, rule: PanelSurfaceRule): Promise<void> {
  const cfg = useAppStore.getState().panelTypeConfig;
  return savePanelTypeConfig({ ...cfg, surfaces: { ...cfg.surfaces, [surface]: rule } });
}
/** Tipi kullanan kenar kuralı sayısı (liste rozeti). */
export const typeEdgeCount = (type: PanelTypeId, cfg?: PanelTypeConfig): number => Object.values(typeRuleOf(type, cfg).edges).filter(r => r?.connectorId).length;

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

export const newConnector = (name = 'Connector'): Connector => ({ id: genId('conn'), name, holes: [], ops: [], parts: [], tA: CONN_DEFAULT_T, tB: CONN_DEFAULT_T, createdAt: Date.now() });
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
  await libraryPut('connectors', c);
}
/** Bağlayıcıyı siler; onu kullanan kenar kuralları boşalır. */
export async function deleteConnector(id: string): Promise<void> {
  const st = useAppStore.getState();
  st.removeConnector(id);
  await libraryDelete('connectors', id);
  const cfg = st.panelTypeConfig, rules: PanelTypeConfig['rules'] = {};
  let touched = false;
  for (const [type, rule] of Object.entries(cfg.rules ?? {}) as Array<[PanelTypeId, PanelTypeRule]>) {
    const edges = { ...rule.edges };
    for (const e of Object.keys(edges) as PanelEdgeDir[]) if (edges[e]?.connectorId === id) { delete edges[e]; touched = true; }
    rules[type] = { edges };
  }
  if (touched) await savePanelTypeConfig({ ...cfg, rules });
}
/** Bağlayıcıyı kullanan kenar sayısı (liste rozeti). */
export const connectorUseCount = (id: string, cfg: PanelTypeConfig = useAppStore.getState().panelTypeConfig): number =>
  Object.values(cfg.rules ?? {}).reduce((n, r) => n + Object.values(r?.edges ?? {}).filter(e => e?.connectorId === id).length, 0);
