import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import * as THREE from 'three';
import { type AxisDir, type Vec3, type VertexModification, rebuildBodySolid } from './components/Geometry';

export interface SubtractionParameters {
  width: string; height: string; depth: string;
  posX: string; posY: string; posZ: string;
  rotX: string; rotY: string; rotZ: string;
}

export interface FaceDescriptor {
  normal: [number, number, number];
  normalizedCenter: [number, number, number];
  area: number;
  isCurved?: boolean;
  axisDirection?: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-' | null;
  axisPosition?: number;
}

export interface FilletInfo {
  face1Descriptor: FaceDescriptor;
  face2Descriptor: FaceDescriptor;
  face1Data: { normal: [number, number, number]; center: [number, number, number]; planeD?: number };
  face2Data: { normal: [number, number, number]; center: [number, number, number]; planeD?: number };
  radius: number;
  originalSize: { width: number; height: number; depth: number };
}

export interface SubtractedGeometry {
  geometry: THREE.BufferGeometry;
  relativeOffset: [number, number, number];
  relativeRotation: [number, number, number];
  scale: [number, number, number];
  parameters?: SubtractionParameters;
}

export interface VirtualFace {
  id: string; shapeId: string;
  normal: [number, number, number];
  center: [number, number, number];
  vertices: [number, number, number][];
  description: string; hasPanel: boolean;
  /** VF = tıklanan yüz bileşeninin konturu; resize'da yüz eşlemesiyle güncellenir. */
  parentFaceShape?: boolean;
  faceGroupDescriptor?: FaceDescriptor;
  /** Yakalama anında bu yüzeye değen kardeş panel id'leri (geometri canlı okunur). */
  touchingSiblingIds?: string[];
  /** Kardeş ayak izine göre değişmez taraf (±1); stored-wins birleşir. */
  sideRelations?: Record<string, number>;
  /** Açıkken panel serbest bölgenin tam (L/U/çentikli) şeklini alır. */
  fitFaceShape?: boolean;
  /** İç panel (raf/dikme/kapak): konumu grup çözücüsü yazar; regen'de yüz eşlemesine girmez. */
  interior?: boolean;
  groupId?: string;
  groupIndex?: number;
  /** Kapak sınırı: kapak adayları bu panelin kenarlarından kurulur. */
  doorBound?: boolean;
  /** Arkalık sınırı: arkalık adayları bu panelin kenarlarından kurulur; arkalık bu panelde (ref ile) bölünür. */
  backBound?: boolean;
  /** @deprecated Eski "arkalığı böl" bayrağı — okunursa backBound sayılır (bkz. DoorService.vfBackBound). */
  splitBack?: boolean;
  /** Kapak / arkalık üyesi (interior=true; geometriyi DoorService yazar). Rol grubun `role` alanından okunur. */
  doorGroupId?: string;
  doorIndex?: number;
}

/** Kapak kenar referansı: bir sınır panelinin VF'si ya da gövde kutusunun kenarı. */
export interface DoorBoundRef { vfId?: string; body?: boolean }
export interface DoorBounds { uMin: DoorBoundRef; uMax: DoorBoundRef; vMin: DoorBoundRef; vMax: DoorBoundRef }
/** Kapak düzlemindeki dikdörtgen (gövde-yerel u/v) + kapak ÖN yüzünün düzlem koordinatı (kapak ekseninde). */
export interface DoorRect { u0: number; u1: number; v0: number; v1: number; front: number }
/** Kapak adayı: tıklanan gövde yüzü düzleminde sınır paneli kenarlarından kurulan iç/dış dikdörtgen; alan büyükten küçüğe. */
export interface DoorPick {
  key: string; axis: 0 | 1 | 2; side: 1 | -1; bounds: DoorBounds;
  inner: DoorRect; outer: DoorRect; area: number;
  /** Kapak düzleminin derinlik referansı + aynı dikdörtgendeki sırası. */
  depth: DoorBoundRef; depthIndex: number; depthCount: number;
  boundPanelCount: number;
  /** Açılı derinlik referansında panelin dönüşü (gövde-yerel Matrix4); inner/outer bu çerçevededir. Düz referansta yok. */
  rot?: number[];
  /** Tıklanan nokta (u,v): açılı sınır panelinde kapağın hangi tarafta kalacağını belirler. */
  at?: [number, number];
}
/** KAPAK AĞACI: leaf = kapak; split = u (yan yana) / v (üst üste) eksende çocuklar (sizes + n−1 gaps).
 *  Çocuk ölçüleri (+ aralar) toplamı HER ZAMAN düğümün alanıdır → bölmek üst bölmenin ölçüsünü değiştirmez.
 *  Üye sırası = DFS yaprak sırası; double/fold yaprak iki üye verir. */
export type DoorNode =
  | { id: string; kind: 'leaf'; type: DoorType; leafSplit?: DoorLeafSplit }
  | {
    id: string; kind: 'split'; axis: 'u' | 'v'; sizes: GapSpec[]; gaps: number[]; children: DoorNode[];
    /** SPACING: hedef parça ölçüsü (mm); parça sayısı her çözümde alandan türetilir. Sayı elle girilince kalkar. */
    targetSize?: number;
    /** DERZ BAĞI (kapak levhayı izler): k. derz her çözümde bağlı dikme/rafın güncel konumundan türetilir
     *  ('center' = levha ortası, 'min'/'max' = levha o taraftaki kapağın arkasında); bağlı ölçüler çözümden yazılır. */
    refs?: Record<number, DoorJointRef>;
  };
/** Derz bağı (KAPAK levhayı izler): bağlı levhanın VF id'si + derzin levhaya göre konumu. */
export interface DoorJointRef { vfId: string; align: DoorAlign }
/** Kapak derzine bağ (LEVHA kapağı izler — PanelGroup.doorBond): kapak grubu + bölme + derz sırası + hiza (+ üye). */
export interface DoorBond { doorGroupId: string; splitId: string; k: number; align: DoorAlign; member?: number }
export interface DoorEdgeGaps { uMin: number; uMax: number; vMin: number; vMax: number }
/** KAPAK / ARKALIK GRUBU: dikdörtgen her rebuild'de sınır referanslarından yeniden çözülür; ağaç ölçüleri ona göre dağıtılır.
 *  role 'back' = ARKALIK: aynı çözücü; sınır = VF.backBound; yapraklar 'fixed'. placement 'outer' = arkadan çakma (panellerin
 *  arka yüzüne, hacmin DIŞINA), 'inner' = kanallı (panellerin arasına, kenar boşlukları NEGATİF = kanala giriş; `setback` kadar içerde). */
export interface DoorGroup {
  id: string; shapeId: string;
  /** Yoksa 'door'. */
  role?: DoorRole;
  axis: 0 | 1 | 2; side: 1 | -1;
  /** 'outer' = dış kapak (panel kalınlıklarının dışından, önde); 'inner' = iç kapak (panellerin arasına, önü panellerle hizalı). */
  placement: 'outer' | 'inner';
  /** Yalnız kanallı arkalık: sınır panellerinin arka yüzünden arkalığın arka yüzüne mesafe (mm). */
  setback?: number;
  bounds: DoorBounds;
  /** Kapak düzlemi bu sınır panelinin ön yüzündedir. Yoksa outer = en öndeki, inner = en içerdeki sınır panelinin önü. */
  depthRef?: DoorBoundRef;
  rect: DoorRect;
  /** Bölme ağacı (kök = tüm kapak alanı − kenar boşlukları). */
  tree: DoorNode;
  edgeGaps: DoorEdgeGaps;
  /** Varsayılan kapak boşluğu (mm): yeni bölmede doğan aralar ve kanat araları bununla. */
  gap: number;
  /** YARIM BİNME: işaretli kenarda kapak sınır panelinin kalınlık ORTASINA kadar gider, kalan yeniden EŞİT bölünür.
   *  Yalnız dış kapakta ve kenar paneli kapağın gerisindeyken etkilidir. */
  halfOverlay?: { uMin?: boolean; uMax?: boolean; vMin?: boolean; vMax?: boolean };
  /** HİÇ BİNMEME: işaretli kenarda kapak sınır panelinin İÇ yüzünde biter (panel kalınlığını örtmez). halfOverlay ile birlikte işaretlenmez. */
  noOverlay?: { uMin?: boolean; uMax?: boolean; vMin?: boolean; vMax?: boolean };
  /** ÇIPA (u,v): dönmüş sınır panelinde kapak alanı çıpanın tarafına kırpılır (rectByCuts). Yoksa merkez. */
  anchor?: [number, number];
  /** Eski kayıt: okunmaz, syncDoorGroups siler (derz bağı DoorNode.refs'te). */
  panelAlign?: Record<string, DoorAlign>;
  thickness: number;
  /** Üye VF id'leri: ağacın DFS yaprak sırası, double/fold yaprakta kanatlar ardışık. Üye i ↔ VF.doorIndex = i. */
  memberVfIds: string[];
  name?: string;
  createdAt: number;
}

/** KAPAK TİPİ (bakana göre): left/right = yan menteşe; up = kalkar; down = düşer; double = iki kanat (yatayda bölünür);
 *  fold = katlanır kalkar (dikeyde bölünür); drawer = çekmece ön paneli; fixed = menteşesiz ön panel. */
export type DoorType = 'left' | 'right' | 'up' | 'down' | 'double' | 'fold' | 'drawer' | 'fixed';
/** Grup rolü: kapak ya da arkalık (aynı veri modeli ve çözücü). */
export type DoorRole = 'door' | 'back';
/** Derz hizası: 'min'/'max' = levha o taraftaki kapağın arkasında; 'center' = derz levhanın ortasında. */
export type DoorAlign = 'min' | 'center' | 'max';
/** İki kanatlı hücre: kanat ölçüleri (toplam = hücre ölçüsü − kanat arası boşluk) + kanat arası boşluk (mm). */
export interface DoorLeafSplit { leaves: GapSpec[]; gap: number }

/** Raf/dikme boşluğu: değer (mm) + kilit (küp boyutlanınca sabit kalır). */
export interface GapSpec { value: number; locked: boolean; edited?: boolean }
export interface CavityBox { min: [number, number, number]; max: [number, number, number] }
/** HACİM ADIMI: grup hacminin bir yüzü panel yüz extrude'uyla aynı modlarla (fixed/dyn/ref) itilir.
 *  Her rebuild'de ham hacme sırayla uygulanır; faceNormal gövde-yerel, eksen hizalı. */
export interface CavityStep {
  id: string; faceNormal: Vec3; axisLabel: string; value: number; isFixed: boolean; timestamp: number;
  /** Tıklama, gövde kutusuna oransal — şekilli hacimde hangi bağlantılı yüzün hareket edeceğini seçer. */
  anchorFrac?: Vec3;
  refShapeId?: string; refFaceGroupIndex?: number; refNormalWorld?: Vec3; refPointWorld?: Vec3;
  resolvedValue?: number;
}
/** HACİM ADAYI: gövde katısından ve panellerden kalan, tohumdan taşarak bulunan serbest bölge.
 *  bbox = dizilim açıklığı; boxes = hücre kutuları; surface = önizleme üçgenleri; seed = çıpa. */
export interface CavityPick {
  key: string; bbox: CavityBox; boxes: CavityBox[]; surface: number[]; seed: [number, number, number];
  /** 'shaped' = bağlantılı serbest bölgenin tamamı; 'box' = tohumu içeren maksimal kutu. */
  shape: 'shaped' | 'box';
  /** arrow = tıklanan gövde yüzünden içeri (kameradan bağımsız; üst/alt yüzden tıkta Z−).
   *  axis = dizilim ekseni: raf daima Y; dikme oka paralel → okun yatay diki.
   *  facing = sayım tarafı (+1 = MİN'den) ve üye VF normali (facing·axis). at = ışının bölgeye girdiği nokta. */
  axis: 0 | 1 | 2; facing: 1 | -1; at: [number, number, number];
  arrow: { axis: 0 | 1 | 2; facing: 1 | -1 };
}
/** RAF / DİKME GRUBU: n panel + n+1 boşluk; hacim her rebuild'de çıpa etrafında yeniden büyütülür, boşluklar kilit kuralıyla dağıtılır. */
export interface PanelGroup {
  id: string; shapeId: string;
  kind: 'shelf' | 'divider';
  /** Dizilim ekseni: raf = 1 (Y); dikme oka paralel (ok Z → 0, ok X → 2). */
  axis: 0 | 1 | 2;
  arrow?: { axis: 0 | 1 | 2; facing: 1 | -1 };
  /** Üye VF normali = facing·eksen; boşluk/üye sayımı tıklanan taraftan (facing<0 → MAX). Yoksa +1. */
  facing?: 1 | -1;
  /** Hacim çıpası: gövde yerel kutusundaki oran (resize'da aynı boşluğa düşer). */
  anchorFrac: [number, number, number];
  cavity: CavityBox;
  region?: CavityBox[];
  /** Düz kutu alternatifi: kayıtlı kutuya (gövde oranı) en çok örtüşen maksimal kutu. */
  boxMode?: boolean;
  boxFrac?: CavityBox;
  count: number;
  gaps: GapSpec[];
  /** HEDEF ARALIK (>0): adet her çözümde açıklıktan türetilir (eşit boşluk hedefe en yakın). Adet/boşluk elle girilince kalkar. */
  targetGap?: number;
  thickness: number;
  /** Üye başına kalınlık; eksik/kısa ise `thickness`. */
  memberThicknesses?: number[];
  cavitySteps?: CavityStep[];
  /** KAPAK DERZİNE BAĞ (levha kapağı izler; tersi DoorNode.refs): `member` (vars. 0) her çözümde derze göre
   *  konumlanır, o boşluk çözümden yazılır. Kapak/derz silinirse bağ düşer. */
  doorBond?: DoorBond;
  memberVfIds: string[];
  /** Grup adı (vars. 'Shelf' / 'Divider'); üye panellerin adı budur. */
  name?: string;
  createdAt: number;
}

export interface Shape {
  id: string; type: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  geometry: THREE.BufferGeometry;
  color?: string;
  parameters: Record<string, any>;
  replicadShape?: any;
  isolated?: boolean;
  vertexModifications?: VertexModification[];
  groupId?: string;
  isReferenceBox?: boolean;
  subtractionGeometries?: (SubtractedGeometry | null)[];
  fillets?: FilletInfo[];
}

export enum CameraType { PERSPECTIVE = 'perspective', ORTHOGRAPHIC = 'orthographic' }
export enum Tool {
  SELECT = 'Select', MOVE = 'Move', ROTATE = 'Rotate', SCALE = 'Scale',
  POINT_TO_POINT_MOVE = 'Point to Point Move',
  POLYLINE = 'Polyline', POLYLINE_EDIT = 'Polyline Edit',
  RECTANGLE = 'Rectangle', CIRCLE = 'Circle', DIMENSION = 'Dimension',
}
export enum ViewMode { WIREFRAME = 'wireframe', SOLID = 'solid', XRAY = 'xray' }
export enum SnapType { ENDPOINT = 'endpoint', MIDPOINT = 'midpoint', CENTER = 'center', PERPENDICULAR = 'perpendicular', INTERSECTION = 'intersection', NEAREST = 'nearest' }
export enum OrthoMode { ON = 'on', OFF = 'off' }

export type RefFacePick = { panelId: string; faceGroupIndex: number; normalWorld: Vec3; pointWorld: Vec3 };
type FilletFaceData = { normal: Vec3; center: Vec3; planeD?: number };

export interface AppState {
  shapes: Shape[];
  addShape: (shape: Shape) => void;
  updateShape: (id: string, updates: Partial<Shape>) => void;
  deleteShape: (id: string) => void;
  exitIsolation: () => void;
  selectedShapeId: string | null; selectShape: (id: string | null) => void;
  secondarySelectedShapeId: string | null; selectSecondaryShape: (id: string | null) => void;
  createGroup: (primaryId: string, secondaryId: string) => void;

  activeTool: Tool; setActiveTool: (t: Tool) => void;
  cameraType: CameraType; setCameraType: (t: CameraType) => void;
  viewMode: ViewMode; setViewMode: (m: ViewMode) => void; cycleViewMode: () => void;
  orthoMode: OrthoMode; toggleOrthoMode: () => void;
  snapSettings: Record<SnapType, boolean>; toggleSnapSetting: (t: SnapType) => void;
  opencascadeLoading: boolean; setOpenCascadeLoading: (l: boolean) => void;

  vertexEditMode: boolean; setVertexEditMode: (b: boolean) => void;
  selectedVertexIndex: number | null; setSelectedVertexIndex: (i: number | null) => void;
  vertexDirection: AxisDir | null; setVertexDirection: (d: AxisDir) => void;
  addVertexModification: (shapeId: string, mod: VertexModification) => void;

  subtractionViewMode: boolean; setSubtractionViewMode: (b: boolean) => void;
  selectedSubtractionIndex: number | null; setSelectedSubtractionIndex: (i: number | null) => void;
  hoveredSubtractionIndex: number | null; setHoveredSubtractionIndex: (i: number | null) => void;
  deleteSubtraction: (shapeId: string, idx: number) => Promise<void>;

  showOutlines: boolean; setShowOutlines: (b: boolean) => void;
  selectedPanelRow: number | string | null;
  selectedPanelRowParentId: string | null;
  setSelectedPanelRow: (i: number | string | null, parentId?: string | null) => void;
  panelSelectMode: boolean; setPanelSelectMode: (b: boolean) => void;
  faceEditMode: boolean; setFaceEditMode: (b: boolean) => void;

  panelGroups: PanelGroup[];
  addPanelGroup: (g: PanelGroup) => void;
  updatePanelGroup: (id: string, u: Partial<PanelGroup>) => void;
  deletePanelGroup: (id: string) => void;
  /** Grup seçimi = "tüm panelleri seç" (satır seçimiyle karşılıklı dışlayıcı). */
  selectedPanelGroupId: string | null; setSelectedPanelGroupId: (id: string | null) => void;
  /** Hacim seçme modu. groupId verilirse YENİDEN SEÇİM: grup yeni hacme taşınır — hacmi yalnız VF sırasında
   *  gruptan ÖNCE gelen paneller sınırlar; sonrakiler ve grubun kendi üyeleri engel sayılmaz. */
  volumePickMode: 'shelf' | 'divider' | null; setVolumePickMode: (m: 'shelf' | 'divider' | null, groupId?: string | null) => void;
  volumePickGroupId: string | null;
  volumePickCandidates: CavityPick[]; volumePickIndex: number;
  setVolumePick: (c: CavityPick[], i: number) => void;
  /** VF'leri verilen VF'nin hemen ARKASINA ekler (grup üyeleri bitişik kalsın). */
  insertVirtualFacesAfter: (afterId: string | null, vfs: VirtualFace[]) => void;

  doorGroups: DoorGroup[];
  addDoorGroup: (g: DoorGroup) => void;
  updateDoorGroup: (id: string, u: Partial<DoorGroup>) => void;
  deleteDoorGroup: (id: string) => void;
  selectedDoorGroupId: string | null; setSelectedDoorGroupId: (id: string | null) => void;
  /** Kapak / arkalık seçme modu; role = hangisi (adaylar o rolün sınır panellerinden kurulur). */
  doorPickMode: boolean; setDoorPickMode: (b: boolean, role?: DoorRole) => void;
  doorPickRole: DoorRole;
  /** PANEL REF modu: tıklanan kapak-sınırı dikme/rafın ortasından kapak bölünür. */
  doorRefPickGroupId: string | null; setDoorRefPickGroupId: (id: string | null) => void;
  doorPickCandidates: DoorPick[]; doorPickIndex: number;
  setDoorPick: (c: DoorPick[], i: number) => void;
  doorPickPlacement: 'outer' | 'inner'; setDoorPickPlacement: (p: 'outer' | 'inner') => void;
  /** Arkalık seçmede tip: 'outer' = arkadan çakma, 'inner' = kanallı. */
  backPickPlacement: 'outer' | 'inner'; setBackPickPlacement: (p: 'outer' | 'inner') => void;

  filletMode: boolean; setFilletMode: (b: boolean) => void;
  selectedFilletFaces: number[];
  addFilletFace: (i: number) => void; clearFilletFaces: () => void;
  selectedFilletFaceData: FilletFaceData[];
  addFilletFaceData: (d: FilletFaceData) => void;
  clearFilletFaceData: () => void;

  raycastMode: boolean; setRaycastMode: (b: boolean) => void;
  /** Yüz yakalamada önizlenen (henüz yerleşmemiş) VF — şeritteki ✓ bununla onaylar. */
  raycastPendingVf: VirtualFace | null; setRaycastPendingVf: (v: VirtualFace | null) => void;
  /** Yerleştirme şeridindeki ad (boşsa varsayılan); her mod açılışında sıfırlanır. */
  placementName: string; setPlacementName: (s: string) => void;

  faceExtrudeMode: boolean; setFaceExtrudeMode: (b: boolean) => void;
  faceExtrudeTargetPanelId: string | null; setFaceExtrudeTargetPanelId: (id: string | null) => void;
  faceExtrudeSelectedFace: number | null; setFaceExtrudeSelectedFace: (i: number | null) => void;
  faceExtrudeClickPoint: Vec3 | null; setFaceExtrudeClickPoint: (p: Vec3 | null) => void;
  faceExtrudeThickness: number; setFaceExtrudeThickness: (v: number) => void;
  /** 'fixed' = sabit ölçü, 'dyn' = delta, 'ref' = referans yüze bağlı. */
  faceExtrudeValueMode: 'fixed' | 'dyn' | 'ref'; setFaceExtrudeValueMode: (m: 'fixed' | 'dyn' | 'ref') => void;
  faceExtrudeRefCandidate: RefFacePick | null; setFaceExtrudeRefCandidate: (v: RefFacePick | null) => void;
  /** Extrude modu panel yerine raf/dikme grubunun HACMİNİ hedefler. */
  faceExtrudeCavityGroupId: string | null; setFaceExtrudeCavityGroupId: (id: string | null) => void;
  faceExtrudeCavityFaceNormal: Vec3 | null; setFaceExtrudeCavityFaceNormal: (n: Vec3 | null) => void;

  panelMoveMode: boolean; setPanelMoveMode: (b: boolean) => void;
  panelMoveTargetPanelId: string | null; setPanelMoveTargetPanelId: (id: string | null) => void;
  panelMoveAxis: AxisDir | null; setPanelMoveAxis: (a: AxisDir | null) => void;
  panelMoveValue: number; setPanelMoveValue: (v: number) => void;
  panelMoveValueMode: 'dyn' | 'fixed' | 'ref'; setPanelMoveValueMode: (m: 'dyn' | 'fixed' | 'ref') => void;
  panelMoveRefSourceVertex: Vec3 | null; setPanelMoveRefSourceVertex: (v: Vec3 | null) => void;
  panelMoveRefTargetPanelId: string | null; setPanelMoveRefTargetPanelId: (id: string | null) => void;
  panelMoveRefTargetVertex: Vec3 | null; setPanelMoveRefTargetVertex: (v: Vec3 | null) => void;

  panelRotateMode: boolean; setPanelRotateMode: (b: boolean) => void;
  panelRotateTargetPanelId: string | null; setPanelRotateTargetPanelId: (id: string | null) => void;
  panelRotatePivot: Vec3 | null; setPanelRotatePivot: (p: Vec3 | null) => void;
  panelRotateAxis: 'x' | 'y' | 'z' | null; setPanelRotateAxis: (a: 'x' | 'y' | 'z' | null) => void;
  panelRotateValue: number; setPanelRotateValue: (v: number) => void;
  /** null = mod HENÜZ seçilmedi (sahnede nokta/halka yok). 'ref': pivot → nişan → eksen → referans yüz → sağ tık. */
  panelRotateValueMode: 'dyn' | 'ref' | null; setPanelRotateValueMode: (m: 'dyn' | 'ref' | null) => void;
  /** Dönen panelin referansa NİŞAN alan kendi noktası. */
  panelRotateRefArmVertex: Vec3 | null; setPanelRotateRefArmVertex: (v: Vec3 | null) => void;
  /** Referans YÜZ (nokta değil): nişan bu yüzün düzlemine değene kadar döner. */
  panelRotateRefFace: RefFacePick | null; setPanelRotateRefFace: (f: RefFacePick | null) => void;

  virtualFaces: VirtualFace[];
  addVirtualFace: (v: VirtualFace) => void;
  updateVirtualFace: (id: string, u: Partial<VirtualFace>) => void;
  deleteVirtualFace: (id: string) => void;
  /** Sıra = basan/basılan önceliği; değişince paneller yeniden üretilir. */
  reorderVirtualFaceGroup: (shapeId: string, fromIds: string[], toGroupFirstId: string | null) => void;
}

export const shapeById = (id: string | null | undefined, shapes: Shape[] = useAppStore.getState().shapes): Shape | undefined =>
  id ? shapes.find(s => s.id === id) : undefined;
const OUTLINE_PREF_KEY = 'yago.showOutlines';
function readOutlinePref(): boolean {
  try { const v = localStorage.getItem(OUTLINE_PREF_KEY); return v === null ? true : v === '1'; } catch { return true; }
}
function writeOutlinePref(b: boolean): void {
  try { localStorage.setItem(OUTLINE_PREF_KEY, b ? '1' : '0'); } catch { /* depolama yok: yalnız oturum içi */ }
}

export const childPanelsOf = (parentId: string, shapes: Shape[] = useAppStore.getState().shapes): Shape[] =>
  shapes.filter(s => s.type === 'panel' && s.parameters?.parentShapeId === parentId);
export const panelOfVf = (vfId: string | undefined, shapes: Shape[] = useAppStore.getState().shapes): Shape | undefined =>
  vfId ? shapes.find(s => s.type === 'panel' && s.parameters?.virtualFaceId === vfId) : undefined;
export const vfOfPanel = (panel: Shape | undefined, vfs: VirtualFace[] = useAppStore.getState().virtualFaces): VirtualFace | undefined =>
  vfs.find(f => f.id === (panel?.parameters as any)?.virtualFaceId);
/** Motoru tembel yükleyip gövdenin panellerini yeniden üretir (tek rebuild giriş noktası). */
export const requestRebuild = (parentId: string, opts?: { changedPanelId?: string; orderChanged?: boolean }): Promise<void> =>
  import('./components/PanelEngine').then(({ rebuildPanelsForParent }) => rebuildPanelsForParent(parentId, opts));

export const useAppStore = create<AppState>((set, get) => ({
  shapes: [],
  addShape: (shape) => set((s) => ({ shapes: [...s.shapes, shape] })),

  // Gruplu şekilde konum/dönüş/ölçek değişimi grubun diğer üyelerine aynen uygulanır.
  updateShape: (id, updates) => set((state) => {
    const sh = state.shapes.find(s => s.id === id);
    if (!sh) return {};
    const shapes = state.shapes.map((s): Shape => {
      if (s.id === id) return { ...s, ...updates };
      if (sh.groupId && s.groupId === sh.groupId && ('position' in updates || 'rotation' in updates || 'scale' in updates)) {
        const pd = updates.position ? [0, 1, 2].map(i => updates.position![i] - sh.position[i]) : [0, 0, 0];
        const rd = updates.rotation ? [0, 1, 2].map(i => updates.rotation![i] - sh.rotation[i]) : [0, 0, 0];
        const sd = updates.scale ? [0, 1, 2].map(i => updates.scale![i] / sh.scale[i]) : [1, 1, 1];
        return {
          ...s,
          position: [s.position[0] + pd[0], s.position[1] + pd[1], s.position[2] + pd[2]],
          rotation: [s.rotation[0] + rd[0], s.rotation[1] + rd[1], s.rotation[2] + rd[2]],
          scale: [s.scale[0] * sd[0], s.scale[1] * sd[1], s.scale[2] * sd[2]],
        };
      }
      return s;
    });
    return { shapes };
  }),

  deleteShape: (id) => set((state) => {
    const all = new Set([id, ...state.shapes.filter(s => s.type === 'panel' && s.parameters?.parentShapeId === id).map(s => s.id)]);
    return {
      shapes: state.shapes.filter(s => !all.has(s.id)),
      // Gövdeyle birlikte raf/dikme ve kapak grupları da gider (üye VF'leri gövdeye bağlıdır).
      panelGroups: state.panelGroups.filter(g => g.shapeId !== id),
      doorGroups: state.doorGroups.filter(g => g.shapeId !== id),
      selectedShapeId: all.has(state.selectedShapeId || '') ? null : state.selectedShapeId,
      secondarySelectedShapeId: all.has(state.secondarySelectedShapeId || '') ? null : state.secondarySelectedShapeId,
    };
  }),

  exitIsolation: () => set((s) => ({ shapes: s.shapes.map(x => ({ ...x, isolated: undefined })) })),

  selectedShapeId: null,
  selectShape: (id) => {
    if (id && get().activeTool === Tool.SELECT) set({ selectedShapeId: id, activeTool: Tool.MOVE });
    else set({ selectedShapeId: id });
  },
  secondarySelectedShapeId: null,
  selectSecondaryShape: (id) => set({ secondarySelectedShapeId: id }),

  createGroup: (primaryId, secondaryId) => {
    const gid = `group-${Date.now()}`;
    set((s) => ({
      shapes: s.shapes.map(x => x.id === primaryId ? { ...x, groupId: gid } : x.id === secondaryId ? { ...x, groupId: gid, isReferenceBox: true } : x),
    }));
  },

  activeTool: Tool.SELECT, setActiveTool: (t) => set({ activeTool: t }),
  cameraType: CameraType.PERSPECTIVE, setCameraType: (t) => set({ cameraType: t }),
  viewMode: ViewMode.SOLID, setViewMode: (m) => set({ viewMode: m }),
  cycleViewMode: () => {
    const order = [ViewMode.SOLID, ViewMode.WIREFRAME, ViewMode.XRAY];
    set({ viewMode: order[(order.indexOf(get().viewMode) + 1) % order.length] });
  },
  orthoMode: OrthoMode.OFF,
  toggleOrthoMode: () => set((s) => ({ orthoMode: s.orthoMode === OrthoMode.ON ? OrthoMode.OFF : OrthoMode.ON })),
  snapSettings: { endpoint: false, midpoint: false, center: false, perpendicular: false, intersection: false, nearest: false },
  toggleSnapSetting: (t) => set((s) => ({ snapSettings: { ...s.snapSettings, [t]: !s.snapSettings[t] } })),
  opencascadeLoading: false, setOpenCascadeLoading: (l) => set({ opencascadeLoading: l }),

  vertexEditMode: false, setVertexEditMode: (b) => set({ vertexEditMode: b }),
  selectedVertexIndex: null, setSelectedVertexIndex: (i) => set({ selectedVertexIndex: i }),
  vertexDirection: null, setVertexDirection: (d) => set({ vertexDirection: d }),
  addVertexModification: (sid, mod) => set((s) => ({
    shapes: s.shapes.map(sh => {
      if (sh.id !== sid) return sh;
      const mods = sh.vertexModifications || [];
      const i = mods.findIndex(m => m.vertexIndex === mod.vertexIndex && m.direction === mod.direction);
      return { ...sh, vertexModifications: i >= 0 ? mods.map((m, k) => (k === i ? mod : m)) : [...mods, mod] };
    }),
  })),

  subtractionViewMode: false, setSubtractionViewMode: (b) => set({ subtractionViewMode: b }),
  selectedSubtractionIndex: null, setSelectedSubtractionIndex: (i) => set({ selectedSubtractionIndex: i }),
  hoveredSubtractionIndex: null, setHoveredSubtractionIndex: (i) => set({ hoveredSubtractionIndex: i }),

  /** Çıkarmayı siler: kalan çıkarmalar + filletlerle gövde baştan kurulur. */
  deleteSubtraction: async (shapeId, idx) => {
    const sh = get().shapes.find(s => s.id === shapeId);
    if (!sh || !sh.subtractionGeometries) return;
    const arr = [...sh.subtractionGeometries];
    arr[idx] = null;
    try {
      const r = await rebuildBodySolid(sh, arr);
      set((S) => ({
        shapes: S.shapes.map(x => x.id === shapeId ? {
          ...x, geometry: r.geometry, replicadShape: r.replicadShape, subtractionGeometries: arr, fillets: r.fillets, position: [...sh.position] as Vec3,
          parameters: { ...x.parameters, scaledBaseVertices: r.scaledBaseVertices },
        } : x),
        selectedSubtractionIndex: null,
      }));
      try { await requestRebuild(shapeId); } catch (err) { console.error('rebuild after subtractor delete fail:', err); }
    } catch (e) { console.error('deleteSubtraction fail:', e); }
  },

  showOutlines: readOutlinePref(), setShowOutlines: (b) => { writeOutlinePref(b); set({ showOutlines: b }); },
  selectedPanelRow: null, selectedPanelRowParentId: null,
  // Tek panel seçimi grup seçimini düşürür (ikisi aynı anda olmaz).
  setSelectedPanelRow: (i, parentId) => set({
    selectedPanelRow: i, selectedPanelRowParentId: parentId || null,
    ...(i !== null ? { selectedPanelGroupId: null, selectedDoorGroupId: null } : {}),
  }),
  panelSelectMode: false,
  setPanelSelectMode: (b) => set({ panelSelectMode: b, selectedPanelRow: null, selectedPanelRowParentId: null, selectedPanelGroupId: null, selectedDoorGroupId: null }),
  faceEditMode: false, setFaceEditMode: (b) => set({ faceEditMode: b }),

  panelGroups: [],
  addPanelGroup: (g) => set((s) => ({ panelGroups: [...s.panelGroups, g] })),
  updatePanelGroup: (id, u) => set((s) => ({ panelGroups: s.panelGroups.map(g => (g.id === id ? { ...g, ...u } : g)) })),
  deletePanelGroup: (id) => set((s) => ({
    panelGroups: s.panelGroups.filter(g => g.id !== id),
    selectedPanelGroupId: s.selectedPanelGroupId === id ? null : s.selectedPanelGroupId,
  })),
  selectedPanelGroupId: null,
  setSelectedPanelGroupId: (id) => set({
    selectedPanelGroupId: id,
    ...(id ? { selectedPanelRow: null, selectedDoorGroupId: null } : {}),
  }),
  volumePickMode: null,
  setVolumePickMode: (m, groupId = null) => set({
    volumePickMode: m, volumePickGroupId: m ? groupId : null, volumePickCandidates: [], volumePickIndex: 0,
    ...(m ? { raycastMode: false, raycastPendingVf: null, doorPickMode: false, doorPickCandidates: [], doorPickIndex: 0, placementName: '' } : {}),
  }),
  volumePickGroupId: null,
  volumePickCandidates: [], volumePickIndex: 0,
  setVolumePick: (c, i) => set({ volumePickCandidates: c, volumePickIndex: i }),
  insertVirtualFacesAfter: (afterId, vfs) => set((s) => {
    const idx = afterId ? s.virtualFaces.findIndex(f => f.id === afterId) : -1;
    if (idx < 0) return { virtualFaces: [...s.virtualFaces, ...vfs] };
    const out = s.virtualFaces.slice();
    out.splice(idx + 1, 0, ...vfs);
    return { virtualFaces: out };
  }),

  doorGroups: [],
  addDoorGroup: (g) => set((s) => ({ doorGroups: [...s.doorGroups, g] })),
  updateDoorGroup: (id, u) => set((s) => ({ doorGroups: s.doorGroups.map(g => (g.id === id ? { ...g, ...u } : g)) })),
  deleteDoorGroup: (id) => set((s) => ({
    doorGroups: s.doorGroups.filter(g => g.id !== id),
    selectedDoorGroupId: s.selectedDoorGroupId === id ? null : s.selectedDoorGroupId,
  })),
  selectedDoorGroupId: null,
  setSelectedDoorGroupId: (id) => set({
    selectedDoorGroupId: id,
    ...(id ? { selectedPanelRow: null, selectedPanelGroupId: null } : {}),
  }),
  doorRefPickGroupId: null,
  setDoorRefPickGroupId: (id) => set({ doorRefPickGroupId: id }),
  doorPickMode: false,
  setDoorPickMode: (b, role) => set((s) => ({
    doorPickMode: b, doorPickCandidates: [], doorPickIndex: 0, doorPickRole: b ? (role ?? s.doorPickRole) : s.doorPickRole,
    ...(b ? { raycastMode: false, raycastPendingVf: null, volumePickMode: null, volumePickGroupId: null, volumePickCandidates: [], volumePickIndex: 0, placementName: '' } : {}),
  })),
  doorPickRole: 'door',
  doorPickCandidates: [], doorPickIndex: 0,
  setDoorPick: (c, i) => set({ doorPickCandidates: c, doorPickIndex: i }),
  doorPickPlacement: 'outer', setDoorPickPlacement: (p) => set({ doorPickPlacement: p }),
  backPickPlacement: 'outer', setBackPickPlacement: (p) => set({ backPickPlacement: p }),

  filletMode: false, setFilletMode: (e) => set({ filletMode: e, selectedFilletFaces: [], selectedFilletFaceData: [] }),
  selectedFilletFaces: [],
  addFilletFace: (i) => set((s) => (s.selectedFilletFaces.includes(i) ? {} : { selectedFilletFaces: [...s.selectedFilletFaces, i] })),
  clearFilletFaces: () => set({ selectedFilletFaces: [], selectedFilletFaceData: [] }),
  selectedFilletFaceData: [],
  addFilletFaceData: (d) => set((s) => ({ selectedFilletFaceData: [...s.selectedFilletFaceData, d] })),
  clearFilletFaceData: () => set({ selectedFilletFaceData: [] }),

  raycastMode: false,
  setRaycastMode: (b) => set({
    raycastMode: b, raycastPendingVf: null,
    ...(b ? { placementName: '', volumePickMode: null, volumePickGroupId: null, volumePickCandidates: [], volumePickIndex: 0, doorPickMode: false, doorPickCandidates: [], doorPickIndex: 0 } : {}),
  }),
  raycastPendingVf: null, setRaycastPendingVf: (v) => set({ raycastPendingVf: v }),
  placementName: '', setPlacementName: (s) => set({ placementName: s }),

  faceExtrudeMode: false,
  setFaceExtrudeMode: (b) => set({
    faceExtrudeMode: b, faceExtrudeSelectedFace: null, faceExtrudeClickPoint: null, faceExtrudeCavityFaceNormal: null,
    ...(!b ? { faceExtrudeTargetPanelId: null, faceExtrudeRefCandidate: null, faceExtrudeCavityGroupId: null } : {}),
  }),
  faceExtrudeTargetPanelId: null, setFaceExtrudeTargetPanelId: (id) => set({ faceExtrudeTargetPanelId: id, ...(id ? { faceExtrudeCavityGroupId: null, faceExtrudeCavityFaceNormal: null } : {}) }),
  faceExtrudeCavityGroupId: null, setFaceExtrudeCavityGroupId: (id) => set({ faceExtrudeCavityGroupId: id, ...(id ? { faceExtrudeTargetPanelId: null } : {}) }),
  faceExtrudeCavityFaceNormal: null, setFaceExtrudeCavityFaceNormal: (n) => set({ faceExtrudeCavityFaceNormal: n }),
  faceExtrudeSelectedFace: null, setFaceExtrudeSelectedFace: (i) => set({ faceExtrudeSelectedFace: i }),
  faceExtrudeClickPoint: null, setFaceExtrudeClickPoint: (p) => set({ faceExtrudeClickPoint: p }),
  faceExtrudeThickness: 18, setFaceExtrudeThickness: (v) => set({ faceExtrudeThickness: v }),
  faceExtrudeValueMode: 'fixed', setFaceExtrudeValueMode: (m) => set({ faceExtrudeValueMode: m }),
  faceExtrudeRefCandidate: null, setFaceExtrudeRefCandidate: (v) => set({ faceExtrudeRefCandidate: v }),

  panelMoveMode: false,
  setPanelMoveMode: (b) => set({
    panelMoveMode: b,
    ...(!b ? {
      panelMoveTargetPanelId: null, panelMoveAxis: null, panelMoveValue: 0, panelMoveValueMode: 'dyn' as const,
      panelMoveRefSourceVertex: null, panelMoveRefTargetPanelId: null, panelMoveRefTargetVertex: null,
    } : {}),
  }),
  panelMoveTargetPanelId: null, setPanelMoveTargetPanelId: (id) => set({ panelMoveTargetPanelId: id }),
  panelMoveAxis: null, setPanelMoveAxis: (a) => set({ panelMoveAxis: a }),
  panelMoveValue: 0, setPanelMoveValue: (v) => set({ panelMoveValue: v }),
  panelMoveValueMode: 'dyn',
  setPanelMoveValueMode: (m) => set({ panelMoveValueMode: m, panelMoveRefSourceVertex: null, panelMoveRefTargetPanelId: null, panelMoveRefTargetVertex: null }),
  panelMoveRefSourceVertex: null, setPanelMoveRefSourceVertex: (v) => set({ panelMoveRefSourceVertex: v }),
  panelMoveRefTargetPanelId: null, setPanelMoveRefTargetPanelId: (id) => set({ panelMoveRefTargetPanelId: id }),
  panelMoveRefTargetVertex: null, setPanelMoveRefTargetVertex: (v) => set({ panelMoveRefTargetVertex: v }),

  // Giriş/çıkışta alt durum sıfırlanır; hedef panel id girişte korunur (satır düğmesi onu hemen önce yazar).
  panelRotateMode: false,
  setPanelRotateMode: (b) => set({
    panelRotateMode: b,
    panelRotatePivot: null, panelRotateAxis: null, panelRotateValue: 0,
    panelRotateValueMode: null, panelRotateRefArmVertex: null, panelRotateRefFace: null,
    ...(!b ? { panelRotateTargetPanelId: null } : {}),
  }),
  panelRotateTargetPanelId: null, setPanelRotateTargetPanelId: (id) => set({ panelRotateTargetPanelId: id }),
  panelRotatePivot: null, setPanelRotatePivot: (p) => set({ panelRotatePivot: p }),
  panelRotateAxis: null, setPanelRotateAxis: (a) => set({ panelRotateAxis: a }),
  panelRotateValue: 0, setPanelRotateValue: (v) => set({ panelRotateValue: v }),
  // Mod seçimi/değişimi akışı BAŞA alır (yarım kalmış seçim taşınmaz).
  panelRotateValueMode: null,
  setPanelRotateValueMode: (m) => set({
    panelRotateValueMode: m, panelRotatePivot: null, panelRotateAxis: null, panelRotateValue: 0,
    panelRotateRefArmVertex: null, panelRotateRefFace: null,
  }),
  panelRotateRefArmVertex: null, setPanelRotateRefArmVertex: (v) => set({ panelRotateRefArmVertex: v }),
  // Yüz seçimi hedef paneli de belirler.
  panelRotateRefFace: null, setPanelRotateRefFace: (f) => set({ panelRotateRefFace: f }),

  virtualFaces: [],
  // Gövde paneli varsayılan 'Panel' adını alır (description = satır adı); iç üyelerin adı grup adından gelir.
  addVirtualFace: (v) => set((s) => ({ virtualFaces: [...s.virtualFaces, (!v.interior && !v.description) ? { ...v, description: 'Panel' } : v] })),
  updateVirtualFace: (id, u) => set((s) => ({ virtualFaces: s.virtualFaces.map(f => (f.id === id ? { ...f, ...u } : f)) })),
  deleteVirtualFace: (id) => set((s) => ({ virtualFaces: s.virtualFaces.filter(f => f.id !== id) })),
  // Sürüklenen grup hedefin ÖNCESİNE (null = sona) taşınır; diğer şekillerin VF'leri yerinde kalır.
  reorderVirtualFaceGroup: (shapeId, fromIds, toGroupFirstId) => {
    set((s) => {
      const shapeFaces = s.virtualFaces.filter(f => f.shapeId === shapeId);
      const fromSet = new Set(fromIds);
      const group = shapeFaces.filter(f => fromSet.has(f.id));
      const rest = shapeFaces.filter(f => !fromSet.has(f.id));
      const insertIdx = toGroupFirstId === null ? rest.length : rest.findIndex(f => f.id === toGroupFirstId);
      if (insertIdx < 0) return {};
      rest.splice(insertIdx, 0, ...group);
      const queue = [...rest];
      return { virtualFaces: s.virtualFaces.map(f => (f.shapeId === shapeId ? queue.shift()! : f)) };
    });
    requestRebuild(shapeId);
  },
}));

/** Yalnız istenen alanlara abone olur (shallow); tüm store'a abonelik her değişiklikte yeniden çizdirir. */
export function useStoreFields<K extends keyof AppState>(...keys: K[]): Pick<AppState, K> {
  return useAppStore(useShallow((s: AppState) => {
    const o = {} as Pick<AppState, K>;
    for (const k of keys) o[k] = s[k];
    return o;
  }));
}
