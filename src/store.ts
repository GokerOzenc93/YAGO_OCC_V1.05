import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import * as THREE from 'three';
import { type AxisDir, type Vec3, type VertexModification, rebuildBodySolid } from './components/Geometry';

// ═══════════════════════════════════════════════════════════════════════════
// VERİ YAPILARI
// ═══════════════════════════════════════════════════════════════════════════

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
  /** TAM YÜZ MODELİ: VF = tıklanan yüz bileşeninin konturu; resize'da yüz eşlemesiyle güncellenir. */
  parentFaceShape?: boolean;
  faceGroupDescriptor?: FaceDescriptor;
  /** Yakalama anında bu yüzeye DEĞEN kardeş panellerin id'leri (kimlik; geometri canlı okunur). */
  touchingSiblingIds?: string[];
  /** DEĞİŞMEZ TARAF SÖZLEŞMESİ: kardeş ayak izine göre taraf (±1); stored-wins birleşir. */
  sideRelations?: Record<string, number>;
  /** YÜZEYİN ŞEKLİNİ AL: açıkken panel serbest bölgenin tam (L/U/çentikli) şeklini alır. */
  fitFaceShape?: boolean;
  /** İÇ PANEL (raf/dikme): gövde yüzüne değil bir raf/dikme grubunun çözülmüş
   *  konumuna bağlıdır; regen'de yüz eşlemesine girmez, grup çözücüsü yazar. */
  interior?: boolean;
  groupId?: string;
  groupIndex?: number;
  /** KAPAK SINIRI (Goker, Eki 2026): bu panel (gövde paneli, raf ya da dikme) kapak
   *  yerleşiminde referans kenardır — kapak adayları bu panellerin kenarlarından kurulur. */
  doorBound?: boolean;
  /** KAPAK ÜYESİ: VF bir kapak grubuna aittir (interior=true; geometriyi DoorService yazar). */
  doorGroupId?: string;
  doorIndex?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// KAPAK (DoorService) — Goker, Eki 2026: "kapak yerleştirmek istiyorum; dikme, raf ve
// gövde panellerine kapak sınırı işareti koyayım; tıkladığım yerde büyükten küçüğe
// kapak alternatifleri dönsün; dış/iç kapak; dikeyde/yatayda böl; kilit + ara ölçü;
// iki kapak arasındaki boşluk."
// ═══════════════════════════════════════════════════════════════════════════

/** Kapak kenar referansı: bir sınır panelinin VF'si ya da gövde kutusunun kenarı. */
export interface DoorBoundRef { vfId?: string; body?: boolean }
export interface DoorBounds { uMin: DoorBoundRef; uMax: DoorBoundRef; vMin: DoorBoundRef; vMax: DoorBoundRef }
/** Kapak düzlemindeki dikdörtgen (gövde-yerel u/v) + kapak ÖN yüzünün düzlem koordinatı (kapak ekseninde). */
export interface DoorRect { u0: number; u1: number; v0: number; v1: number; front: number }
/**
 * KAPAK ADAYI (3B seçim): tıklanan gövde yüzünden (axis/side) bakılan düzlemde, kapak sınırı
 * panellerinin kenarlarıyla kurulan dikdörtgen. Hem iç (panellerin arasına) hem dış
 * (panel kalınlıklarının dışından) dikdörtgeni taşır; alan büyükten küçüğe sıralanır.
 */
export interface DoorPick {
  key: string; axis: 0 | 1 | 2; side: 1 | -1; bounds: DoorBounds;
  inner: DoorRect; outer: DoorRect; area: number;
  /** Sınır panellerinin sayısı (gövde kenarı sayılmaz) — etikette "Body" / "2 panels". */
  boundPanelCount: number;
}
/**
 * KAPAK GRUBU: bir kapak düzlemine yerleşen cols×rows kapak. Dikdörtgen her rebuild'de
 * sınır referanslarından yeniden çözülür (gövde boyutlanınca kapaklar izler).
 */
export interface DoorGroup {
  id: string; shapeId: string;
  /** Kapak düzleminin normal ekseni + yönü (ön yüzden tık → Z+). */
  axis: 0 | 1 | 2; side: 1 | -1;
  /** 'outer' = dış kapak (panel kalınlıklarının dışından, önde); 'inner' = iç kapak (panellerin arasına, önü panellerle hizalı). */
  placement: 'outer' | 'inner';
  bounds: DoorBounds;
  /** Son çözülen dikdörtgen (gövde-yerel). */
  rect: DoorRect;
  /** Dikeyde böl = sütun sayısı (u ekseni); yatayda böl = satır sayısı (v ekseni). */
  cols: number; rows: number;
  /** Sütun genişlikleri / satır yükseklikleri: değer + kilit (raf boşluklarıyla aynı kural). */
  colWidths: GapSpec[]; rowHeights: GapSpec[];
  /** Varsayılan kapak boşluğu (mm): yeni bölmede doğan aralar ve eski gruplar bununla. */
  gap: number;
  /**
   * HER BOŞLUK AYRI (Goker, Eki 2026: "kapağın kenar boşluğu, her boşluk farklı farklı girilebilmeli"):
   * colGaps = [sol kenar, sütun araları…, sağ kenar] (cols+1); rowGaps = [üst kenar, satır araları…, alt kenar] (rows+1).
   * Yoksa / boyu tutmuyorsa `gap` ile doldurulur.
   */
  colGaps?: number[]; rowGaps?: number[];
  thickness: number;
  /** Üye VF id'leri: satır-major (üst satırdan, soldan sağa): index = r*cols + c. */
  memberVfIds: string[];
  name?: string;
  createdAt: number;
}

/** Raf/dikme boşluğu: değer (mm) + kilit (küp boyutlanınca sabit kalır). */
export interface GapSpec { value: number; locked: boolean; edited?: boolean }
export interface CavityBox { min: [number, number, number]; max: [number, number, number] }
/**
 * HACİM ADIMI (Goker: "rafın yerleştiği hacme face extrude"): grubun çözülen
 * hacminin bir yüzü, panel yüz extrude'uyla aynı üç modda itilir — fixed = eksen
 * boyunca hedef ölçü, dyn = işaretli delta (+ dışa), ref = referans yüz düzlemine.
 * Her rebuild'de ham (engellerden çözülen) hacme sırayla uygulanır; üyeler/boşluklar
 * yeni hacme göre yeniden çözülür. faceNormal gövde-yerel, eksen hizalı.
 */
export interface CavityStep {
  id: string; faceNormal: Vec3; axisLabel: string; value: number; isFixed: boolean; timestamp: number;
  /** Yüzü seçen tıklama, GÖVDE kutusuna oransal — şekilli hacimde hangi bağlantılı yüzün (L kolu / çentik iç yüzü) hareket edeceğini seçer. */
  anchorFrac?: Vec3;
  refShapeId?: string; refFaceGroupIndex?: number; refNormalWorld?: Vec3; refPointWorld?: Vec3;
  /** Ref adımının son çözümde uygulanan işaretli miktarı (UI). */
  resolvedValue?: number;
}
/**
 * HACİM ADAYI (3B seçim): şekilli serbest bölge — gövde katısından (çentik /
 * çıkarma dahil) ve panellerden kalan, tohumdan taşarak bulunan hücre birliği.
 * bbox = dizilim açıklığı; boxes = birleşik hücre kutuları (şema silueti);
 * surface = dış yüzey üçgenleri (önizleme); seed = bölgenin içinde bir nokta (çıpa).
 */
export interface CavityPick {
  key: string; bbox: CavityBox; boxes: CavityBox[]; surface: number[]; seed: [number, number, number];
  /** 'shaped' = bağlantılı serbest bölgenin tamamı (en kapsayıcı); 'box' = bölge içinde tohumu içeren maksimal kutu (düz alternatif). */
  shape: 'shaped' | 'box';
  /**
   * OK + DİZİLİM (Goker, 30 Eyl 2026 — "kübün sağına tıklıyorsam ok sola bakacak";
   * "tıklanan kübün yüzeyine göre dönsün"; "ok yönü soldaysa kübün sol yüzüne göre
   * yerleşecek: derinlik 300 ise dikme boşlukları 300'e göre"):
   *  • arrow = OK: tıklanan GÖVDE YÜZÜNDEN içeri (sağ yüz → X−, ön yüz → Z−), kameradan
   *    bağımsız; ÜST/ALT yüzden tıkta raf ve dikme için SABİT önden arkaya (Z−).
   *    Kamera kutunun içindeyse ışının baskın ekseni (düşeyse yine Z−).
   *  • axis = DİZİLİM ekseni (boşlukların dağıldığı eksen): raf daima Y; dikme OKA
   *    PARALEL durur, yani dizilim ekseni okun yatay DİKİ — ok X ise dikmeler Z'de
   *    (derinlik boyunca), ok Z ise X'te (genişlik boyunca).
   *  • facing = dizilim ekseninde sayım tarafı (+1 = MİN'den, −1 = MAX'tan) ve üye VF
   *    normali (facing·axis): ok dizilim eksenindeyse oktan; değilse
   *    tıklanan nokta hacmin hangi yarısındaysa o taraftan (kameradan bağımsız).
   *  • at = ışının bölgeye girdiği nokta (gövde-yerel).
   */
  axis: 0 | 1 | 2; facing: 1 | -1; at: [number, number, number];
  arrow: { axis: 0 | 1 | 2; facing: 1 | -1 };
}
/**
 * RAF / DİKME GRUBU: seçilen hacme (cavity) yerleşen n panel + n+1 boşluk.
 * Hacim her rebuild'de çıpa (anchorFrac) etrafından, gövde panellerinin
 * kutularıyla yeniden büyütülür; boşluklar kilit kuralıyla yeniden dağıtılır.
 */
export interface PanelGroup {
  id: string; shapeId: string;
  kind: 'shelf' | 'divider';
  /** Dizilim ekseni (boşlukların dağıldığı eksen): raf = 1 (Y); dikme oka paralel → ok Z (önden tık) ise 0 (X), ok X (yandan tık) ise 2 (Z). */
  axis: 0 | 1 | 2;
  /** OK: tıklanan gövde yüzünden içeri yön (3B ok ve grup seçiliyken hacim merkezindeki ok). Eski gruplarda yok → dizilim ekseni/yönü. */
  arrow?: { axis: 0 | 1 | 2; facing: 1 | -1 };
  /**
   * YÖN (tık yönü): üye VF normali = facing·eksen; boşluklar ve üye numaraları
   * (6.1, 6.2 …) hacmin facing<0 ise MAX, facing>0 ise MİN tarafından sayılır —
   * yani tıklanan taraftan itibaren. Eski gruplarda yok → +1.
   */
  facing?: 1 | -1;
  /** Hacim çıpası: gövde yerel kutusundaki oran (resize'da aynı boşluğa düşer). */
  anchorFrac: [number, number, number];
  /** Son çözülen hacmin kutusu (gövde yerel) — dizilim açıklığı buradan. */
  cavity: CavityBox;
  /** Şekilli bölge: birleşik hücre kutuları (şema silueti / eski gruplarda yok → kutu). */
  region?: CavityBox[];
  /** DÜZ (kutu) alternatif seçildi: bölge içinde çıpayı içeren maksimal kutulardan, kayıtlı kutuya (gövde oranı) en çok örtüşen. */
  boxMode?: boolean;
  boxFrac?: CavityBox;
  count: number;
  gaps: GapSpec[];
  /**
   * HEDEF ARALIK (Goker: "raf ve dikmeye aralık da verebileyim; yaklaşık o aralığı tutturacak
   * şekilde raf miktarını azaltıp çoğaltsın her zaman"): verildiğinde (>0) ADET her çözümde
   * hacmin dizilim açıklığından türetilir — eşit boşluklar hedefe en yakın olacak n seçilir;
   * gövde büyüyüp küçülünce üye eklenir/silinir. Adet ya da boşluk elle girilince kalkar.
   */
  targetGap?: number;
  /** Varsayılan üye kalınlığı (yeni üyeler bununla doğar). */
  thickness: number;
  /** Üye başına kalınlık (şemadaki kutucuk); eksik/kısa ise `thickness`. Boşluklar bu değerlere göre dağıtılır. */
  memberThicknesses?: number[];
  /** Hacim yüz-extrude adımları (sıralı); ham hacme her çözümde uygulanır. */
  cavitySteps?: CavityStep[];
  memberVfIds: string[];
  /** Kullanıcının verdiği grup adı (varsayılan 'Shelf' / 'Divider'); üye panellerin adı budur (salt-okunur). */
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

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════

export interface AppState {
  // Şekiller
  shapes: Shape[];
  addShape: (shape: Shape) => void;
  updateShape: (id: string, updates: Partial<Shape>) => void;
  deleteShape: (id: string) => void;
  exitIsolation: () => void;
  selectedShapeId: string | null; selectShape: (id: string | null) => void;
  secondarySelectedShapeId: string | null; selectSecondaryShape: (id: string | null) => void;
  createGroup: (primaryId: string, secondaryId: string) => void;

  // Görünüm / araçlar
  activeTool: Tool; setActiveTool: (t: Tool) => void;
  cameraType: CameraType; setCameraType: (t: CameraType) => void;
  viewMode: ViewMode; setViewMode: (m: ViewMode) => void; cycleViewMode: () => void;
  orthoMode: OrthoMode; toggleOrthoMode: () => void;
  snapSettings: Record<SnapType, boolean>; toggleSnapSetting: (t: SnapType) => void;
  opencascadeLoading: boolean; setOpenCascadeLoading: (l: boolean) => void;

  // Vertex düzenleme
  vertexEditMode: boolean; setVertexEditMode: (b: boolean) => void;
  selectedVertexIndex: number | null; setSelectedVertexIndex: (i: number | null) => void;
  vertexDirection: AxisDir | null; setVertexDirection: (d: AxisDir) => void;
  addVertexModification: (shapeId: string, mod: VertexModification) => void;

  // Çıkarma (subtraction)
  subtractionViewMode: boolean; setSubtractionViewMode: (b: boolean) => void;
  selectedSubtractionIndex: number | null; setSelectedSubtractionIndex: (i: number | null) => void;
  hoveredSubtractionIndex: number | null; setHoveredSubtractionIndex: (i: number | null) => void;
  deleteSubtraction: (shapeId: string, idx: number) => Promise<void>;

  // Paneller / editör
  showOutlines: boolean; setShowOutlines: (b: boolean) => void;
  selectedPanelRow: number | string | null;
  selectedPanelRowParentId: string | null;
  setSelectedPanelRow: (i: number | string | null, parentId?: string | null) => void;
  panelSelectMode: boolean; setPanelSelectMode: (b: boolean) => void;
  faceEditMode: boolean; setFaceEditMode: (b: boolean) => void;

  // Raf / dikme grupları
  panelGroups: PanelGroup[];
  addPanelGroup: (g: PanelGroup) => void;
  updatePanelGroup: (id: string, u: Partial<PanelGroup>) => void;
  deletePanelGroup: (id: string) => void;
  /** Grup seçimi = "tüm panelleri seç" (satır seçimiyle karşılıklı dışlayıcı). */
  selectedPanelGroupId: string | null; setSelectedPanelGroupId: (id: string | null) => void;
  /**
   * Hacim seçme modu (raf / dikme atma): tıklanan noktadan ışın boyunca serbest hacimler.
   * groupId verilirse YENİDEN SEÇİM (Goker: "hacmin mevcut yerini bir düğmeyle yeniden seçtir"):
   * mevcut grup yeni hacme TAŞINIR — hacmi yalnız VF sırasında gruptan ÖNCE gelen paneller
   * sınırlar; sonrakiler ve grubun kendi üyeleri x-ray çizilir, engel sayılmaz.
   */
  volumePickMode: 'shelf' | 'divider' | null; setVolumePickMode: (m: 'shelf' | 'divider' | null, groupId?: string | null) => void;
  volumePickGroupId: string | null;
  volumePickCandidates: CavityPick[]; volumePickIndex: number;
  setVolumePick: (c: CavityPick[], i: number) => void;
  /** VF'leri verilen VF'nin hemen ARKASINA ekler (grup üyeleri bitişik kalsın). */
  insertVirtualFacesAfter: (afterId: string | null, vfs: VirtualFace[]) => void;

  // Kapak grupları
  doorGroups: DoorGroup[];
  addDoorGroup: (g: DoorGroup) => void;
  updateDoorGroup: (id: string, u: Partial<DoorGroup>) => void;
  deleteDoorGroup: (id: string) => void;
  /** Kapak grubu seçimi = "tüm kapakları seç" (satır / raf grubu seçimiyle karşılıklı dışlayıcı). */
  selectedDoorGroupId: string | null; setSelectedDoorGroupId: (id: string | null) => void;
  /** Kapak yerleştirme modu: tıklanan gövde yüzünde kapak sınırı panellerinden adaylar (büyükten küçüğe döner). */
  doorPickMode: boolean; setDoorPickMode: (b: boolean) => void;
  doorPickCandidates: DoorPick[]; doorPickIndex: number;
  setDoorPick: (c: DoorPick[], i: number) => void;
  /** Seçim sırasında dış/iç kapak önizlemesi (grup bununla doğar). */
  doorPickPlacement: 'outer' | 'inner'; setDoorPickPlacement: (p: 'outer' | 'inner') => void;

  // Fillet
  filletMode: boolean; setFilletMode: (b: boolean) => void;
  selectedFilletFaces: number[];
  addFilletFace: (i: number) => void; clearFilletFaces: () => void;
  selectedFilletFaceData: FilletFaceData[];
  addFilletFaceData: (d: FilletFaceData) => void;
  clearFilletFaceData: () => void;

  // Panel yerleştirme (yüz yakalama)
  raycastMode: boolean; setRaycastMode: (b: boolean) => void;
  /** Yüz yakalamada önizlenen (henüz yerleşmemiş) VF — şeritteki ✓ bununla onaylar. */
  raycastPendingVf: VirtualFace | null; setRaycastPendingVf: (v: VirtualFace | null) => void;
  /**
   * YERLEŞTİRME ADI (Goker, Eki 2026: "paneli yüzey seçerken isim yazabileyim"): Body Panel /
   * Shelf / Divider / Door yerleştirme şeridindeki ad; boşsa varsayılan ad. Her mod açılışında sıfırlanır.
   */
  placementName: string; setPlacementName: (s: string) => void;

  // Yüz extrude
  faceExtrudeMode: boolean; setFaceExtrudeMode: (b: boolean) => void;
  faceExtrudeTargetPanelId: string | null; setFaceExtrudeTargetPanelId: (id: string | null) => void;
  faceExtrudeSelectedFace: number | null; setFaceExtrudeSelectedFace: (i: number | null) => void;
  /** Yüzü seçen tıklamanın yerel noktası. */
  faceExtrudeClickPoint: Vec3 | null; setFaceExtrudeClickPoint: (p: Vec3 | null) => void;
  faceExtrudeThickness: number; setFaceExtrudeThickness: (v: number) => void;
  /** 'fixed' = sabit ölçü, 'dyn' = delta, 'ref' = referans yüze bağlı. */
  faceExtrudeValueMode: 'fixed' | 'dyn' | 'ref'; setFaceExtrudeValueMode: (m: 'fixed' | 'dyn' | 'ref') => void;
  faceExtrudeRefCandidate: RefFacePick | null; setFaceExtrudeRefCandidate: (v: RefFacePick | null) => void;
  /** HACİM DÜZENLEME: extrude modu bir panel yerine raf/dikme grubunun HACMİNİ hedefler (aynı akış: yüz seç → fixed/dyn/ref → uygula). */
  faceExtrudeCavityGroupId: string | null; setFaceExtrudeCavityGroupId: (id: string | null) => void;
  /** Hacim kutusunda seçilen yüzün gövde-yerel normali (faceExtrudeSelectedFace ile birlikte). */
  faceExtrudeCavityFaceNormal: Vec3 | null; setFaceExtrudeCavityFaceNormal: (n: Vec3 | null) => void;

  // Panel taşıma
  panelMoveMode: boolean; setPanelMoveMode: (b: boolean) => void;
  panelMoveTargetPanelId: string | null; setPanelMoveTargetPanelId: (id: string | null) => void;
  panelMoveAxis: AxisDir | null; setPanelMoveAxis: (a: AxisDir | null) => void;
  panelMoveValue: number; setPanelMoveValue: (v: number) => void;
  panelMoveValueMode: 'dyn' | 'fixed' | 'ref'; setPanelMoveValueMode: (m: 'dyn' | 'fixed' | 'ref') => void;
  panelMoveRefSourceVertex: Vec3 | null; setPanelMoveRefSourceVertex: (v: Vec3 | null) => void;
  panelMoveRefTargetPanelId: string | null; setPanelMoveRefTargetPanelId: (id: string | null) => void;
  panelMoveRefTargetVertex: Vec3 | null; setPanelMoveRefTargetVertex: (v: Vec3 | null) => void;

  // Panel döndürme
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

  // Sanal yüzler (VF)
  virtualFaces: VirtualFace[];
  addVirtualFace: (v: VirtualFace) => void;
  updateVirtualFace: (id: string, u: Partial<VirtualFace>) => void;
  deleteVirtualFace: (id: string) => void;
  /** Sıra = basan/basılan önceliği; değişince paneller yeniden üretilir. */
  reorderVirtualFaceGroup: (shapeId: string, fromIds: string[], toGroupFirstId: string | null) => void;
}

// ═══════════════════════════════════════════════════════════════════════════
// ORTAK ARAMALAR — store'a bağlı küçük yardımcılar (eskiden her dosyada kopyaydı).
// ═══════════════════════════════════════════════════════════════════════════

/** Kimliğe göre şekil (güncel store). */
export const shapeById = (id: string | null | undefined, shapes: Shape[] = useAppStore.getState().shapes): Shape | undefined =>
  id ? shapes.find(s => s.id === id) : undefined;
/** Bir gövdenin çocuk panelleri. */
const OUTLINE_PREF_KEY = 'yago.showOutlines';
function readOutlinePref(): boolean {
  try { const v = localStorage.getItem(OUTLINE_PREF_KEY); return v === null ? true : v === '1'; } catch { return true; }
}
function writeOutlinePref(b: boolean): void {
  try { localStorage.setItem(OUTLINE_PREF_KEY, b ? '1' : '0'); } catch { /* depolama yok: yalnız oturum içi */ }
}

export const childPanelsOf = (parentId: string, shapes: Shape[] = useAppStore.getState().shapes): Shape[] =>
  shapes.filter(s => s.type === 'panel' && s.parameters?.parentShapeId === parentId);
/** VF'nin paneli. */
export const panelOfVf = (vfId: string | undefined, shapes: Shape[] = useAppStore.getState().shapes): Shape | undefined =>
  vfId ? shapes.find(s => s.type === 'panel' && s.parameters?.virtualFaceId === vfId) : undefined;
/** Panelin VF'si. */
export const vfOfPanel = (panel: Shape | undefined, vfs: VirtualFace[] = useAppStore.getState().virtualFaces): VirtualFace | undefined =>
  vfs.find(f => f.id === (panel?.parameters as any)?.virtualFaceId);
/** Motoru tembel yükleyip gövdenin panellerini yeniden üretir (tek rebuild giriş noktası). */
export const requestRebuild = (parentId: string, opts?: { changedPanelId?: string; orderChanged?: boolean }): Promise<void> =>
  import('./components/PanelEngine').then(({ rebuildPanelsForParent }) => rebuildPanelsForParent(parentId, opts));

export const useAppStore = create<AppState>((set, get) => ({
  // ── Şekiller ──────────────────────────────────────────────────────────────
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

  // Şekil silinince çocuk panelleri de silinir.
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

  // ── Görünüm / araçlar ─────────────────────────────────────────────────────
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

  // ── Vertex düzenleme ──────────────────────────────────────────────────────
  vertexEditMode: false, setVertexEditMode: (b) => set({ vertexEditMode: b }),
  selectedVertexIndex: null, setSelectedVertexIndex: (i) => set({ selectedVertexIndex: i }),
  vertexDirection: null, setVertexDirection: (d) => set({ vertexDirection: d }),
  // Aynı köşe + yön için düzenleme varsa değiştirilir, yoksa eklenir.
  addVertexModification: (sid, mod) => set((s) => ({
    shapes: s.shapes.map(sh => {
      if (sh.id !== sid) return sh;
      const mods = sh.vertexModifications || [];
      const i = mods.findIndex(m => m.vertexIndex === mod.vertexIndex && m.direction === mod.direction);
      return { ...sh, vertexModifications: i >= 0 ? mods.map((m, k) => (k === i ? mod : m)) : [...mods, mod] };
    }),
  })),

  // ── Çıkarma ───────────────────────────────────────────────────────────────
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

  // ── Paneller / editör ─────────────────────────────────────────────────────
  // OUTLINE TERCİHİ: son seçim hatırlanır (oturumlar arası localStorage; erişilemezse açık başlar).
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

  // ── Raf / dikme grupları ──────────────────────────────────────────────────
  panelGroups: [],
  addPanelGroup: (g) => set((s) => ({ panelGroups: [...s.panelGroups, g] })),
  updatePanelGroup: (id, u) => set((s) => ({ panelGroups: s.panelGroups.map(g => (g.id === id ? { ...g, ...u } : g)) })),
  deletePanelGroup: (id) => set((s) => ({
    panelGroups: s.panelGroups.filter(g => g.id !== id),
    selectedPanelGroupId: s.selectedPanelGroupId === id ? null : s.selectedPanelGroupId,
  })),
  selectedPanelGroupId: null,
  // Grup seçimi ("tümünü seç") tek panel satırını düşürür.
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

  // ── Kapak grupları ────────────────────────────────────────────────────────
  doorGroups: [],
  addDoorGroup: (g) => set((s) => ({ doorGroups: [...s.doorGroups, g] })),
  updateDoorGroup: (id, u) => set((s) => ({ doorGroups: s.doorGroups.map(g => (g.id === id ? { ...g, ...u } : g)) })),
  deleteDoorGroup: (id) => set((s) => ({
    doorGroups: s.doorGroups.filter(g => g.id !== id),
    selectedDoorGroupId: s.selectedDoorGroupId === id ? null : s.selectedDoorGroupId,
  })),
  selectedDoorGroupId: null,
  // Kapak grubu seçimi ("tüm kapakları seç") tek satırı ve raf grubunu düşürür.
  setSelectedDoorGroupId: (id) => set({
    selectedDoorGroupId: id,
    ...(id ? { selectedPanelRow: null, selectedPanelGroupId: null } : {}),
  }),
  // Kapak yerleştirme modu diğer yerleştirme modlarını (yüz yakalama, hacim seçme) kapatır.
  doorPickMode: false,
  setDoorPickMode: (b) => set({
    doorPickMode: b, doorPickCandidates: [], doorPickIndex: 0,
    ...(b ? { raycastMode: false, raycastPendingVf: null, volumePickMode: null, volumePickGroupId: null, volumePickCandidates: [], volumePickIndex: 0, placementName: '' } : {}),
  }),
  doorPickCandidates: [], doorPickIndex: 0,
  setDoorPick: (c, i) => set({ doorPickCandidates: c, doorPickIndex: i }),
  doorPickPlacement: 'outer', setDoorPickPlacement: (p) => set({ doorPickPlacement: p }),

  // ── Fillet ────────────────────────────────────────────────────────────────
  filletMode: false, setFilletMode: (e) => set({ filletMode: e, selectedFilletFaces: [], selectedFilletFaceData: [] }),
  selectedFilletFaces: [],
  addFilletFace: (i) => set((s) => (s.selectedFilletFaces.includes(i) ? {} : { selectedFilletFaces: [...s.selectedFilletFaces, i] })),
  clearFilletFaces: () => set({ selectedFilletFaces: [], selectedFilletFaceData: [] }),
  selectedFilletFaceData: [],
  addFilletFaceData: (d) => set((s) => ({ selectedFilletFaceData: [...s.selectedFilletFaceData, d] })),
  clearFilletFaceData: () => set({ selectedFilletFaceData: [] }),

  raycastMode: false,
  // Yüz yakalama diğer yerleştirme modlarını kapatır; açılışta ad sıfırlanır.
  setRaycastMode: (b) => set({
    raycastMode: b, raycastPendingVf: null,
    ...(b ? { placementName: '', volumePickMode: null, volumePickGroupId: null, volumePickCandidates: [], volumePickIndex: 0, doorPickMode: false, doorPickCandidates: [], doorPickIndex: 0 } : {}),
  }),
  raycastPendingVf: null, setRaycastPendingVf: (v) => set({ raycastPendingVf: v }),
  placementName: '', setPlacementName: (s) => set({ placementName: s }),

  // ── Yüz extrude ───────────────────────────────────────────────────────────
  faceExtrudeMode: false,
  setFaceExtrudeMode: (b) => set({
    faceExtrudeMode: b, faceExtrudeSelectedFace: null, faceExtrudeClickPoint: null, faceExtrudeCavityFaceNormal: null,
    ...(!b ? { faceExtrudeTargetPanelId: null, faceExtrudeRefCandidate: null, faceExtrudeCavityGroupId: null } : {}),
  }),
  // Panel hedefi yazılınca hacim hedefi düşer (ikisi karşılıklı dışlayıcı).
  faceExtrudeTargetPanelId: null, setFaceExtrudeTargetPanelId: (id) => set({ faceExtrudeTargetPanelId: id, ...(id ? { faceExtrudeCavityGroupId: null, faceExtrudeCavityFaceNormal: null } : {}) }),
  faceExtrudeCavityGroupId: null, setFaceExtrudeCavityGroupId: (id) => set({ faceExtrudeCavityGroupId: id, ...(id ? { faceExtrudeTargetPanelId: null } : {}) }),
  faceExtrudeCavityFaceNormal: null, setFaceExtrudeCavityFaceNormal: (n) => set({ faceExtrudeCavityFaceNormal: n }),
  faceExtrudeSelectedFace: null, setFaceExtrudeSelectedFace: (i) => set({ faceExtrudeSelectedFace: i }),
  faceExtrudeClickPoint: null, setFaceExtrudeClickPoint: (p) => set({ faceExtrudeClickPoint: p }),
  faceExtrudeThickness: 18, setFaceExtrudeThickness: (v) => set({ faceExtrudeThickness: v }),
  faceExtrudeValueMode: 'fixed', setFaceExtrudeValueMode: (m) => set({ faceExtrudeValueMode: m }),
  faceExtrudeRefCandidate: null, setFaceExtrudeRefCandidate: (v) => set({ faceExtrudeRefCandidate: v }),

  // ── Panel taşıma ──────────────────────────────────────────────────────────
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

  // ── Panel döndürme ────────────────────────────────────────────────────────
  // Moda girişte/çıkışta alt durum sıfırlanır (her komut mod seçiminden başlar);
  // hedef panel id'si girişte korunur (satır düğmesi onu hemen önce yazar).
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

  // ── Sanal yüzler ──────────────────────────────────────────────────────────
  virtualFaces: [],
  // PANEL ADI (Goker): gövdeye yerleşen her panel varsayılan olarak 'Panel' adını
  // alır (description alanı = satırdaki ad, değiştirilebilir). İç (raf/dikme)
  // üyelerin adı grup adından gelir.
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

/**
 * Store'dan YALNIZ istenen alanlara abone olur (shallow karşılaştırma).
 * `useAppStore()` tüm store'a abone olup her değişiklikte (hover, rebuild'in
 * her panel yazımı…) bileşeni yeniden çizdiriyordu; bu kanca yalnız seçilen
 * alanlar değişince çizdirir.
 */
export function useStoreFields<K extends keyof AppState>(...keys: K[]): Pick<AppState, K> {
  return useAppStore(useShallow((s: AppState) => {
    const o = {} as Pick<AppState, K>;
    for (const k of keys) o[k] = s[k];
    return o;
  }));
}
