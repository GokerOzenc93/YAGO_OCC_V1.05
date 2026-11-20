import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import * as THREE from 'three';
import { type AxisDir, type Vec3, type VertexModification, rebuildBodySolid } from './components/Geometry';
import type { PlinthSet, PlinthPick } from './components/PlinthService';
import type { LegRule } from './components/LegLayout';
import type { PtBind, Shape2 } from './components/Draft';

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

/** Çizim adımı (Geometry.applySketchFeatures): hedefin bir yüzüne bağlı 2B profil — çıkarılır (cut) ya da şekli verilir (shape).
 *  n / u: yüzün dış normali ve çizim X ekseni, gövde-yerel (panelde dönüş adımları geri alınmış → sonradan eklenen dönüş çizimi taşır).
 *  inset: yüzün en dış düzlemden derinliği. anchor: yüz kutusunda çapa, shapes ona göre. stretch: yüzle ölçeklen (baseSize). depth null = boydan boya. */
export interface SketchFeature {
  id: string; name: string; timestamp: number;
  op: 'cut' | 'shape'; depth: number | null;
  n: Vec3; u: Vec3; inset: number;
  anchor: [number, number]; stretch: [boolean, boolean]; baseSize: [number, number];
  shapes: Shape2[];
  /** Parametric kip (`mode: 'points'`): çapa / uzama kullanılmaz; shapes yüz çerçevesinde, her kontrol noktası kendi X / Y bağıyla çözülür
   *  (pts[nesne][nokta]). radii: daire yarıçap formülü. */
  mode?: 'points'; pts?: PtBind[][]; radii?: (string | null)[];
  /** Kenar ölçüleri (Parametric): dims[nesne][kenar] = uzunluk / yarıçap ifadesi (sıra = Draft.segsOf); nokta bağlarından SONRA çözülür.
   *  pin: sabit nokta [nesne, kontrol noktası] (yoksa yüz orijinine en yakın köşe).
   *  fit: profil GÖVDEYİ sürer — gövdenin o yüzdeki iki ölçüsü profilin dış kutusudur (Geometry.fitDrivenBody). */
  dims?: ((string | null)[] | null)[]; pin?: [number, number] | null; fit?: boolean;
  /** Tasarım yönleri (radyan; yalnız çözümün çizildiği yönden saptırdığı kenarlar — Draft.AngList). */
  angs?: ((number | null)[] | null)[];
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
  /** Eğri yüz paneli: yüzeyin içe kalınlaştırılmışı (PanelEngine.curvedPanelSolid). vertices = kiriş dörtgeni, normal = ortalama, center = tık.
   *  Bölge çözümüne girmez; komşularıyla katı düzeyinde sıraya göre kesişir. */
  curved?: boolean;
  /** İç panel (raf/dikme/kapak): konumu grup çözücüsü yazar; regen'de yüz eşlemesine girmez. */
  interior?: boolean;
  groupId?: string;
  groupIndex?: number;
  /** Kapak sınırı: kapak adayları bu panelin kenarlarından kurulur. */
  doorBound?: boolean;
  /** Arkalık sınırı: arkalık adayları bu panelin kenarlarından kurulur; arkalık bu panelde (ref ile) bölünür. */
  backBound?: boolean;
  /** @deprecated Eski "arkalığı böl" bayrağı — okunursa backBound sayılır (bkz. BackService.vfBackBound). */
  splitBack?: boolean;
  /** Kapak üyesi (interior=true; geometriyi DoorService yazar). */
  doorGroupId?: string;
  doorIndex?: number;
  /** Arkalık üyesi (interior=true; geometriyi BackService yazar). */
  backGroupId?: string;
  backIndex?: number;
  /** Üst üste panel: VF düzlemi gövde yüzünün `stackDepth` mm içinde; `stackBaseVfId` = alttaki panel (bölge çözümünde yok sayılır). */
  stackDepth?: number;
  stackBaseVfId?: string;
  /** Taban EĞİMLİ/dönmüşse VF düzlemi tabanın iç BÜYÜK yüzüdür; regen konturu tabanın güncel geometrisinden okur. */
  stackOnPanel?: boolean;
  /** Arkalığın önü: `stackDepth` her regen'de arkalık + önündeki katmanlardan yeniden okunur (backStackAt). */
  stackOnBack?: boolean;
  /** HIZLI GÖVDE parçası (üst / sol / sağ / alt / baza / arka baza): ayarlar gövdede saklanır, yeniden uygulamada aynı VF güncellenir. */
  quickBody?: QuickBodyPart;
  /** Baza ayağı seti yer tutucusu: paneli yok; sıradaki yeri basan / basılan ilişkisini belirler. */
  plinthId?: string;
  /** AYAĞIN ÜSTÜ: `stackDepth` her regen'de setin üst yüzünden yeniden okunur (set yükselince panel onunla gider). */
  stackOnPlinthId?: string;
  /** Kayıt şeridi (hızlı gövde yatay kaydı): serbest bölge yüz konturunun `n` yönlü kenarından `setback`..`setback+size` şeride kırpılır;
   *  kenar her regen'de yeniden bulunur → gövde ölçüsü değişince kayıt izler. */
  railStrip?: RailStripSpec;
  /** Dikey kayıt iç köşe uzatması: bölge `dir` ucundan uzatılır; `band` = levhanın plan bandı (VF düzleminden [lo, hi]). */
  railExt?: Array<RailExt & { band: [number, number] }>;
  /** PANEL TİPİ (elle seçilmiş); yoksa konumdan otomatik bulunur (ConnectorService.panelTypeOf). */
  panelType?: PanelTypeId;
  /** BAĞLAYICI SETİ (elle seçilmiş, grup başına): set kimliği · null = bu panelde o grubun bağlayıcısı yok. Yoksa raf / dikme grubunun seçimi,
   *  o da yoksa grubun varsayılan seti (ConnectorService.panelSetOf). */
  connectorSets?: Partial<Record<ConnectorGroup, string | null>>;
  /** DELİK YÜZÜ (elle, panelin bütün bağlayıcılı kenarları için): false = tipin varsayılan (görünmeyen) yüzü · true = öteki geniş yüz. Yoksa
   *  raf / dikme grubunun seçimi, o da yoksa panel tipinin kenar ayarı (EdgeConnectorRule.flipFace). */
  connectorFlip?: boolean;
  /** KENAR ÖZELİNDE (elle): o kenarın seti (kimlik · null = o kenarda bağlayıcı yok) ve / veya delik yüzü. Panel genelindeki seçimi
   *  (connectorSets / connectorFlip) o kenar için ezer; panel genelinde yeni seçim yapılınca ilgili kenar kayıtları silinir. */
  connectorEdges?: Partial<Record<PanelEdgeDir, { set?: string | null; flip?: boolean }>>;
}
/** İç köşe uzatmasının hedefi: dış normali `n` olan gövde yüzü; uzatma o düzlemden `depth` önce biter. Her regen'de yeniden ölçülür. */
export interface RailExtTarget { n: Vec3; depth: number }
/** Kayıt ucu uzatması: `dir` kenar boyunca o uca doğru birim yön, `amount` mm (kuruluşta ölçülen; `to` yoksa sabit). */
export interface RailExt { dir: Vec3; amount: number; to?: RailExtTarget }
/** Kayıt şeridi: `n` = bağlı kenarın düzlem-içi DIŞ normali (gövde-yerel, yatay); `ext` = kenarın uçlarında uzatma (iç köşede). */
export interface RailStripSpec { n: Vec3; setback: number; size: number; ext?: RailExt[] }

/** Kapak kenar referansı: bir sınır panelinin VF'si ya da gövde kutusunun kenarı. */
export interface DoorBoundRef { vfId?: string; body?: boolean }
export interface DoorBounds { uMin: DoorBoundRef; uMax: DoorBoundRef; vMin: DoorBoundRef; vMax: DoorBoundRef }
/** Kapak düzlemindeki dikdörtgen (gövde-yerel u/v) + kapak ÖN yüzünün düzlem koordinatı (kapak ekseninde). */
export interface DoorRect { u0: number; u1: number; v0: number; v1: number; front: number }
/** Kapak adayı: tıklanan gövde yüzü düzleminde sınır paneli kenarlarından kurulan iç/dış dikdörtgen; alan büyükten küçüğe. */
export interface DoorPick {
  key: string; axis: 0 | 1 | 2; side: 1 | -1; bounds: DoorBounds;
  /** Seçildiği ön yüzün kutusu (gövde-yerel): L köşe dolabında çentik yüzü kutudan dar ve içerde. */
  faceBox?: CavityBox;
  inner: DoorRect; outer: DoorRect; area: number;
  /** Kapak düzleminin derinlik referansı + aynı dikdörtgendeki sırası. */
  depth: DoorBoundRef; depthIndex: number; depthCount: number;
  boundPanelCount: number;
  /** Açılı derinlik referansında panelin dönüşü (gövde-yerel Matrix4); inner/outer bu çerçevededir. Düz referansta yok. */
  rot?: number[];
  /** Tıklanan nokta (u,v): açılı sınır panelinde kapağın hangi tarafta kalacağını belirler. */
  at?: [number, number];
}
/** Kapak ağacı: leaf = kapak; split = u / v eksende çocuklar (sizes + n−1 gaps). Çocuklar + aralar = düğüm alanı (bölmek üstü değiştirmez).
 *  Üye sırası = DFS yaprak sırası; double / fold iki üye verir. */
export type DoorNode =
  | { id: string; kind: 'leaf'; type: DoorType; leafSplit?: DoorLeafSplit }
  | {
    id: string; kind: 'split'; axis: 'u' | 'v'; sizes: GapSpec[]; gaps: number[]; children: DoorNode[];
    /** SPACING: hedef parça ölçüsü (mm); parça sayısı her çözümde alandan türetilir. Sayı elle girilince kalkar. */
    targetSize?: number;
    /** Derz bağı: k. derz her çözümde bağlı dikme / rafın güncel konumundan türetilir ('center' / 'min' / 'max'). */
    refs?: Record<number, DoorJointRef>;
  };
/** Derz bağı (KAPAK levhayı izler): bağlı levhanın VF id'si + derzin levhaya göre konumu. */
export interface DoorJointRef { vfId: string; align: DoorAlign }
/** Kapak derzine bağ (LEVHA kapağı izler — PanelGroup.doorBond): kapak grubu + bölme + derz sırası + hiza (+ üye). */
export interface DoorBond { doorGroupId: string; splitId: string; k: number; align: DoorAlign; member?: number }
export interface DoorEdgeGaps { uMin: number; uMax: number; vMin: number; vMax: number }
/** KAPAK GRUBU: dikdörtgen her rebuild'de sınır referanslarından yeniden çözülür; ağaç ölçüleri ona göre dağıtılır. */
export interface DoorGroup {
  id: string; shapeId: string;
  axis: 0 | 1 | 2; side: 1 | -1;
  /** Seçildiği ön yüzün köşe kutusu (bkz. DoorPick.faceBox); yoksa gövde kutusu. */
  faceBox?: CavityBox;
  /** 'outer' = dış kapak (panel kalınlıklarının dışından, önde); 'inner' = iç kapak (panellerin arasına, önü panellerle hizalı). */
  placement: 'outer' | 'inner';
  bounds: DoorBounds;
  /** Kapak düzlemi bu sınır panelinin ön yüzündedir. Yoksa outer = en öndeki, inner = en içerdeki sınır panelinin önü. */
  depthRef?: DoorBoundRef;
  rect: DoorRect;
  /** Bölme ağacı (kök = tüm kapak alanı − kenar boşlukları). */
  tree: DoorNode;
  edgeGaps: DoorEdgeGaps;
  /** Varsayılan kapak boşluğu (mm): yeni bölmede doğan aralar ve kanat araları bununla. */
  gap: number;
  /** Yarım binme: işaretli kenarda kapak sınır panelinin kalınlık ortasına gider (yalnız dış kapak, panel gerideyken). */
  halfOverlay?: { uMin?: boolean; uMax?: boolean; vMin?: boolean; vMax?: boolean };
  /** HİÇ BİNMEME: işaretli kenarda kapak sınır panelinin İÇ yüzünde biter; halfOverlay ile birlikte işaretlenmez. */
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

/** Kapak tipi: left / right yan menteşe, up kalkar, down düşer, double iki kanat, fold katlanır, drawer çekmece önü, fixed menteşesiz. */
export type DoorType = 'left' | 'right' | 'up' | 'down' | 'double' | 'fold' | 'drawer' | 'fixed';
/** Derz hizası: 'min'/'max' = levha o taraftaki kapağın arkasında; 'center' = derz levhanın ortasında. */
export type DoorAlign = 'min' | 'center' | 'max';
/** İki kanatlı hücre: kanat ölçüleri (toplam = hücre ölçüsü − kanat arası boşluk) + kanat arası boşluk (mm). */
export interface DoorLeafSplit { leaves: GapSpec[]; gap: number }

// ARKALIK — sınır = VF.backBound, üye = VF.backGroupId. 'outer' = çakma (arka yüze, bini kadar örter); 'inner' = kanallı (setback içerde).
// Kenar ilişkisi (grup başına): 'groove' panel tam boy, parça `inset` girer; 'nail' panel kısalır, parça `cover` örter.
// Tip / setback / inset / bini parça başına.
export type BackPlacement = 'outer' | 'inner';
/** Kenar ilişkisi (yalnız kanallı/iç parçada anlamlı): kanallı (panel tam boy) ya da çakma (panel arkalığın ön yüzünde biter). */
export type BackEdgeRel = 'groove' | 'nail';
/** Arkalık kenar referansı: bir sınır panelinin VF'si ya da gövde kutusunun kenarı. */
export interface BackBoundRef { vfId?: string; body?: boolean }
export interface BackBounds { uMin: BackBoundRef; uMax: BackBoundRef; vMin: BackBoundRef; vMax: BackBoundRef }
/** Arkalık düzlemindeki dikdörtgen (gövde-yerel u/v) + arkalığın ÖN (hacme bakan) yüzünün düzlem koordinatı. */
export interface BackRect { u0: number; u1: number; v0: number; v1: number; front: number }
export interface BackEdgeGaps { uMin: number; uMax: number; vMin: number; vMax: number }
/** Derz hizası: 'min'/'max' = levha o taraftaki parçanın arkasında; 'center' = derz levhanın ortasında. */
export type BackAlign = 'min' | 'center' | 'max';
/** Derz bağı (parça levhayı izler): bağlı levhanın VF id'si + derzin levhaya göre konumu. */
/** rel (yoksa 'groove'): groove → iki yandan kanal; nail → levha arkalığın önüne kadar kısalır, parçalar `jointIn` örter. */
export interface BackJointRef { vfId: string; align: BackAlign; rel?: BackEdgeRel }
/** Arkalık ağacı: leaf = parça; split kapak ağacıyla aynı kural. Alan = iç dikdörtgen; parça kendi tip / setback / giriş değerini taşır. */
export type BackNode =
  | {
    id: string; kind: 'leaf';
    placement?: BackPlacement; setback?: number;
    /** Kanallı: kenar başına kanala giriş (mm ≥ 0). Yalnız grup dikdörtgeninin o kenarına değen parçada anlamlı. */
    inset?: Partial<BackEdgeGaps>;
    /** Çakma: kenar başına sınır panelinin ÜZERİNE BİNME (mm; 0 = iç yüzünde biter, kalınlık/yok = tamamen örter). */
    cover?: Partial<BackEdgeGaps>;
    /** İç levhaya binme (mm, 0..levha kalınlığı); yoksa kalınlık / 2. İki yandaki parçalar ayrı değer taşır. */
    jointIn?: Partial<BackEdgeGaps>;
  }
  | {
    id: string; kind: 'split'; axis: 'u' | 'v'; sizes: GapSpec[]; gaps: number[]; children: BackNode[];
    /** SPACING: hedef parça ölçüsü (mm); parça sayısı her çözümde alandan türetilir. Sayı elle girilince kalkar. */
    targetSize?: number;
    /** DERZ BAĞI: k. derz her çözümde bağlı dikme/rafın güncel konumundan türetilir; bağlı ölçüler çözümden yazılır. */
    refs?: Record<number, BackJointRef>;
  };
/** Arkalık adayı: gövdenin ARKA yüzü düzleminde sınır paneli kenarlarından kurulan iç/dış dikdörtgen; alan büyükten küçüğe. */
export interface BackPick {
  /** Seçildiği arka yüzün köşe kutusu (gövde-yerel); gövde kenarları bununla sınırlanır. */
  faceBox?: CavityBox;
  key: string; axis: 0 | 1 | 2; side: 1 | -1; bounds: BackBounds;
  inner: BackRect; outer: BackRect; area: number;
  depth: BackBoundRef; depthIndex: number; depthCount: number;
  boundPanelCount: number;
  /** Tıklanan nokta (u,v): açılı sınır panelinde arkalığın hangi tarafta kalacağını belirler. */
  at?: [number, number];
}
export interface BackGroup {
  id: string; shapeId: string;
  axis: 0 | 1 | 2; side: 1 | -1;
  /** Parça varsayılanları (parça kendi değerini taşıyabilir): tip, kanallı setback (mm), kanala giriş (mm). */
  placement: BackPlacement;
  setback?: number;
  inset: number;
  bounds: BackBounds;
  /** KENAR İLİŞKİSİ (sınır paneliyle derz; iç parçalarda): yoksa 'groove'. 'nail' kenarın paneli arkalığın ön yüzüne kadar kısaltılır. */
  edgeRel?: Partial<Record<keyof BackBounds, BackEdgeRel>>;
  /** KANAL BOLLAŞTIRMA (mm, grup başına): kanal = parça kalınlığı + front (öne) + back (arkaya); derinlik = giriş + depth. Yoksa varsayılan. */
  grooveClear?: { front?: number; back?: number; depth?: number };
  /** KENAR BAŞINA bollaştırma (sınır / derz panelinin VF id'si → yalnız girilen alanlar); girilmeyen alan grup değerini izler. */
  grooveClearBy?: Record<string, { front?: number; back?: number; depth?: number }>;
  /** Derinlik referansı: sınır panelinin arka yüzü. Yoksa en gerideki sınır panelinin yüzü. Çakma (kısaltılan) kenar derinlik vermez. */
  depthRef?: BackBoundRef;
  /** Canlı derinlik referansı: düzlem `depthRef` panelinin arka yüzünden ölçülür → panel kısalınca / taşınınca arkalık izler. */
  depthRefLive?: boolean;
  /** İÇ dikdörtgen (sınır panellerinin iç yüzleri / gövde kenarları); front = sınır panellerinin ARKA yüzü (P). */
  rect: BackRect;
  /** Bölme ağacı (kök = iç dikdörtgen). */
  tree: BackNode;
  /** Parçalar arası varsayılan boşluk (mm). */
  gap: number;
  /** ÇIPA (u,v): dönmüş sınır panelinde alan çıpanın tarafına kırpılır. Yoksa merkez. */
  anchor?: [number, number];
  thickness: number;
  /** Üye VF id'leri: ağacın DFS yaprak sırası. Üye i ↔ VF.backIndex = i. */
  memberVfIds: string[];
  name?: string;
  createdAt: number;
  /** Hızlı gövdenin kurduğu arkalık: ayarlar yeniden uygulanınca bu grup yerinde güncellenir. */
  quickBody?: boolean;
  /** Seçildiği ARKA yüzün köşe kutusu (gövde-yerel; L gövdede çentikli yüz kutudan dar): gövde kenarı sınırları bu kutuyu okur. */
  faceBox?: CavityBox;
}

/** Raf/dikme boşluğu: değer (mm) + kilit (küp boyutlanınca sabit kalır). */
export interface GapSpec { value: number; locked: boolean; edited?: boolean }
export interface CavityBox { min: [number, number, number]; max: [number, number, number] }
/** Hacim adımı: grup hacminin bir yüzü extrude modlarıyla (fixed / dyn / ref) itilir; her rebuild'de sırayla uygulanır. */
export interface CavityStep {
  id: string; faceNormal: Vec3; axisLabel: string; value: number; isFixed: boolean; timestamp: number;
  /** Tıklama, gövde kutusuna oransal — şekilli hacimde hangi bağlantılı yüzün hareket edeceğini seçer. */
  anchorFrac?: Vec3;
  refShapeId?: string; refFaceGroupIndex?: number; refNormalWorld?: Vec3; refPointWorld?: Vec3;
  resolvedValue?: number;
}
/** Hacim adayı: tohumdan taşarak bulunan serbest bölge. bbox = açıklık, boxes = hücreler, surface = önizleme, seed = çıpa. */
export interface CavityPick {
  key: string; bbox: CavityBox; boxes: CavityBox[]; surface: number[]; seed: [number, number, number];
  /** 'shaped' = bağlantılı serbest bölgenin tamamı; 'box' = tohumu içeren maksimal kutu. */
  shape: 'shaped' | 'box';
  /** arrow = tıklanan yüzden içeri; axis = dizilim ekseni (raf Y, dikme okun yatay diki); facing = sayım tarafı; at = giriş noktası. */
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
  /** Kapak derzine bağ (levha kapağı izler; tersi DoorNode.refs): `member` derze göre konumlanır; kapak / derz silinirse bağ düşer. */
  doorBond?: DoorBond;
  memberVfIds: string[];
  /** Grup adı (vars. 'Shelf' / 'Divider'); üye panellerin adı budur. */
  name?: string;
  /** Üyelerin panel tipi (raf: sabit / hareketli); yoksa yüzey varsayılanı. Üye VF.panelType bunu ezer. */
  panelType?: PanelTypeId;
  /** Üyelerin bağlayıcı seti (grup başına; bkz. VirtualFace.connectorSets). */
  connectorSets?: Partial<Record<ConnectorGroup, string | null>>;
  /** Üyelerin delik yüzü (bkz. VirtualFace.connectorFlip). */
  connectorFlip?: boolean;
  createdAt: number;
}

/* ───────── HIZLI GÖVDE (PanelGroupService › hızlı gövde) ───────── */
/** Taban tipi: düz (yere oturur) / ayaklı (paneller ayak kadar yukarıda) / bazalı (yanlar yere iner, alt panel baza kadar yukarıda). */
/** 'arrow' = ok modu DYN (her tık değer kadar), 'arrowFixed' = ok modu FIXED (o eksendeki toplam ölçü = değer). */
export type FaceExtrudeValueMode = 'arrow' | 'arrowFixed' | 'fixed' | 'dyn' | 'ref';
export type QuickBodyBase = 'plain' | 'legs' | 'plinth';
/** Hızlı gövde parçaları (VF.quickBody); aynı rolde birden çok yüz → `key#n`. topFront / … = üst / alt panel yerine kayıtlar. */
export type QuickBodyPartBase = 'top' | 'left' | 'right' | 'bottom' | 'plinth' | 'rearPlinth' | 'topFront' | 'topRear' | 'bottomFront' | 'bottomRear';
export type QuickBodyPart = QuickBodyPartBase | `${QuickBodyPartBase}#${number}`;
/* ───────── KAYITLAR ─────────
   Üst / alt panel yerine kısa paneller. `kind`: 'horizontal' (yatay şerit) · 'vertical' (ön / arka yüzde dik) · 'none'.
   `setback` = ön / arka yüzden içeri çekme (mm); kalınlık = gövde panel kalınlığı. */
export type RailKind = 'none' | 'horizontal' | 'vertical';
/** Arka kayıt ↔ kanallı arkalık: 'groove' = arkalık kayda kanal açar · 'infront' = kayıt arkalığın önünde. Çakma arkalıkta anlamsız. */
export type RailBackRel = 'groove' | 'infront';
/** Dikey kayıt ↔ aynı yüzdeki tam panel: 'panel' = panel geçer (varsayılan) · 'rail' = kayıt geçer, panel kısalır. */
export type RailJoin = 'panel' | 'rail';
export interface RailSpec { kind: RailKind; size: number; setback: number; join?: RailJoin }
/** Üst ya da alt yüzün yapısı: tam panel ya da kayıtlar (ön + arka; ikisi de 'none' → açık). */
/** Üst / alt yüz yapısı: tam panel ve ön / arka kayıtlar bağımsız; panel varken kayıtlar ona dayanır / istiflenir.
 *  `mode` = eski alan, `railsOf` çevirir. */
export interface QuickBodyRails { panel: boolean; front: RailSpec; rear: RailSpec; backRel: RailBackRel; mode?: 'panel' | 'rails' }
export const DEFAULT_RAILS: QuickBodyRails = {
  panel: true, front: { kind: 'none', size: 100, setback: 0 }, rear: { kind: 'none', size: 100, setback: 0 }, backRel: 'groove',
};
/** Etkin kayıt ayarı (alan yok → tam panel; eski `mode` kaydı → `panel`, eski tam panelde kayıtlar yok). */
export const railsOf = (cfg: Pick<QuickBodyConfig, 'top' | 'bottom'>, face: 'top' | 'bottom'): QuickBodyRails => {
  const r = cfg[face];
  if (!r) return DEFAULT_RAILS;
  const legacy = typeof r.panel !== 'boolean';
  const panel = legacy ? r.mode !== 'rails' : r.panel;
  const front = { ...DEFAULT_RAILS.front, ...(r.front ?? {}) }, rear = { ...DEFAULT_RAILS.rear, ...(r.rear ?? {}) };
  if (legacy && panel) { front.kind = 'none'; rear.kind = 'none'; }
  return { panel, front, rear, backRel: r.backRel ?? 'groove' };
};
/** Köşe birleşimi: 'side' = yan panel köşeden geçer (üst/alt arada), 'horiz' = üst/alt panel geçer (yan arada). */
export type JoinPass = 'side' | 'horiz';
export type CornerKey = 'tl' | 'tr' | 'bl' | 'br';
/** GÖVDE AYAKLARI (gövde `parameters.legs`): silindir ayak; yükseklik alt panelin alt yüzünden canlı okunur (`bottomVfId`), bulunamazsa `height`. */
export interface BodyLegs {
  count: 4 | 5 | 6; diameter: number; side: number; front: number; rear: number; height: number; bottomVfId?: string;
}
export interface QuickBodyConfig {
  base: QuickBodyBase;
  thickness: number;
  joins: Record<CornerKey, JoinPass>;
  /** Baza: yükseklik, ön bazanın önden geri çekilmesi, arka bazanın arkadan öne alınması, arka baza var mı. */
  plinth: { height: number; front: number; rear: number; rearPlinth: boolean };
  /** Ayaklar: bazalıda isteğe bağlı (count 0 = yok); ayaklı tabanda zorunlu. */
  legs: {
    count: 0 | 4 | 5 | 6; height: number; diameter: number; side: number; front: number; rear: number;
    /** Ayak seti (Aksesuar sekmesi; seçilmemişse kütüphanedeki ilk set) — model + Ø her zaman setten (PanelGroupService.quickLegsOf). */
    presetId?: string | null; legModelId?: string | null;
    /** Düzen / mesafeler elle girildi: adet / mesafeler buradaki değerler; yoksa setten canlı (eski kayıtta `custom` aynı anlamda). */
    ownLayout?: boolean; custom?: boolean;
    /** Eski kayıt: ayak ayak kurallar (yerleşimde okunmaz). */
    rules?: LegRule[] | null;
  };
  back: {
    enabled: boolean; placement: BackPlacement; thickness: number; setback: number; inset: number;
    clear: { front: number; back: number; depth: number };
  };
  /** Üst / alt yüz: tam panel ya da kayıtlar (yoksa tam panel — eski kayıtlar). */
  top?: QuickBodyRails;
  bottom?: QuickBodyRails;
  /** Panel uç uzatma / kısaltma (mm; + uzatır): kurulumda o yöndeki dış yüze dyn extrude adımı olarak yazılır (applyQuickBody). */
  ext?: Partial<Record<QuickBodyPanelKey, PanelEdgeExt>>;
  /** Arkalık referansı: setback bu parçanın arka yüzünden ölçülür (parça kısalınca arkalık izler). null → kanallı arka kayıt, o da yoksa
   *  gövdenin arka yüzü; 'body' → her zaman gövdenin arka yüzü. */
  backRef?: QuickBackRefKey | 'body' | null;
}
export type QuickBackRefKey = QuickBodyPanelKey | 'topRear' | 'bottomRear';
export type QuickBodyPanelKey = 'left' | 'right' | 'top' | 'bottom';
export type PanelEdgeDir = 'front' | 'rear' | 'top' | 'bottom' | 'left' | 'right';
export type PanelEdgeExt = Partial<Record<PanelEdgeDir, number>>;
/** Panelin düzenlenebilen uçları: yanlarda ön / arka / üst / alt, üst / alt panelde ön / arka / sol / sağ. */
export const PANEL_EDGE_DIRS: Record<QuickBodyPanelKey, PanelEdgeDir[]> = {
  left: ['front', 'rear', 'top', 'bottom'], right: ['front', 'rear', 'top', 'bottom'],
  top: ['front', 'rear', 'left', 'right'], bottom: ['front', 'rear', 'left', 'right'],
};
/** Panelin uç değeri (yoksa 0). */
export const panelEdgeOf = (cfg: QuickBodyConfig, key: QuickBodyPanelKey, dir: PanelEdgeDir): number => cfg.ext?.[key]?.[dir] ?? 0;
/* ───────── AKSESUAR KÜTÜPHANESİ (AccessoryService) ───────── */
export type AccessoryUnit = 'mm' | 'cm' | 'm' | 'in';
export type AccessoryCategory = 'legs' | 'rails' | 'hinges' | 'layers' | 'connectors' | 'layouts' | 'panelTypes';
/** Aksesuar katmanı: kütüphane geneli liste; parça `layerId` ile bağlanır, katman rengi parçayı boyar. */
export interface AccessoryLayer { id: string; name: string; color: string; createdAt: number }
/** Delik (genel): aksesuar çerçevesinde silindir. `dir` delme yönü, `pos` ağız merkezi, `diameter` / `depth` mm.
 *  `part` verilirse `pos` o parçanın ölçeksiz model uzayında (parça uzayınca delik yerini korur). Panele etkisi: silindir ∩ panel çıkarılır. */
export interface HoleSpec { id: string; part?: LegPartRole | null; pos: Vec3; dir: Vec3; diameter: number; depth: number; name?: string }
/** Paneldeki delik kaydı (üretim / CNC; her rebuild'de): giriş noktası, yön, çap, gerçek derinlik, giriş yüzü, geçiyor mu, kaynak. */
export interface PanelHole {
  id: string; entry: Vec3; dir: Vec3; diameter: number; depth: number; through: boolean; face: AxisDir | null;
  source: { kind: 'leg'; setId: string; legIndex: number; holeId: string } | { kind: string; [k: string]: unknown };
}
/** Ayak parçası rolü: taban (zemine basar) · gövde/mil (set yüksekliğine göre UZAR) · üst tabla (panele vidalanır). */
export type LegPartRole = 'base' | 'stem' | 'top';
/** İçe aktarılmış model (baytlar IndexedDB'de). `size` normalize ölçü. DWG / DXF'ten çevrilmişse baytlar STL; `source` / `note` dönüşüm bilgisi. */
export interface AccessoryModel {
  id: string; name: string; fileName: string; ext: string; unit: AccessoryUnit; upAxis: 'y' | 'z'; size: Vec3; createdAt: number;
  source?: string; note?: string;
}
/** Ayak parçası: `dims` nihai ölçü (mm), `offset` taşıma (y istif içinde, toplam boy değişmez), `stretch` ayak boyuyla uzar
 *  (yoksa yalnız orta parça). `scale` eski kayıt. */
export interface LegModelPart {
  modelId: string; role: LegPartRole; offset?: Vec3; dims?: Vec3; stretch?: boolean; scale?: [number, number]; layerId?: string | null;
  /** Panele giren kısım (mm): parçanın tepesinden bu kadarı temas düzleminin üstünde (pimler); yalnız en üst parçada okunur. */
  embed?: number;
}
/** Ayak modeli: 3 yuva (base / stem / top); `holes` ayağın delikleri. `stretch` eski alan, okunmaz. */
export interface LegModel { id: string; name: string; parts: LegModelPart[]; holes?: HoleSpec[]; stretch?: LegPartRole; createdAt: number }
/** Ayak seti ("kaset"): model, kurallar, varsayılan yükseklik; count / side / front / rear standart düzen parametreleri. */
export interface LegPreset {
  id: string; name: string; legModelId: string | null; count: 4 | 5 | 6; side: number; front: number; rear: number; height: number; createdAt: number;
  rules?: LegRule[];
}

/* ───────── PANEL TİPLERİ + BAĞLAYICILAR (ConnectorService) ─────────
   Panel tipi = panelin dolaptaki görevi. Tip başına kenar kuralları (hangi kenara hangi bağlayıcı, nasıl dizilir) ve yüzey başına
   izinli tipler + varsayılan kütüphanede saklanır; ileride kenar bandı da aynı tip / kenar rolünü kullanır. */
export type PanelTypeId =
  | 'leftSide' | 'rightSide' | 'top' | 'bottom' | 'rearPanel' | 'back' | 'divider' | 'fixedShelf' | 'adjustableShelf'
  | 'topFrontRailH' | 'topFrontRailV' | 'topRearRailH' | 'topRearRailV'
  | 'bottomFrontRailH' | 'bottomFrontRailV' | 'bottomRearRailH' | 'bottomRearRailV'
  | 'frontPlinth' | 'rearPlinth' | 'columnSide' | 'columnFront' | 'beamFront' | 'beamHoriz' | 'free';
/** Panelin yerleştiği yüzey: gövde yüzü rolü, yüzün özel görevi (kolon / kiriş — LegLayout.FaceKind) ya da iç panel aracı (raf / dikme / arkalık). */
export type PanelSurface = PanelEdgeDir | 'shelf' | 'divider' | 'back' | 'columnSide' | 'columnFront' | 'beamFront' | 'beamHoriz';
/* BAĞLAYICI SETİ (Accessories › Layout) — bağlayıcıdan ve panel tipinden BAĞIMSIZ kütüphane kaydı: birleşim boyunca hangi bağlayıcının nereye
   geleceği. Set bir GRUBA aittir (sabit · hareketli): panel tipinin kenarı yalnız GRUBU söyler (Accessories › Types), hangi setin kullanılacağı
   PANELDE seçilir (o grubun setleri arasından; seçilmezse grubun varsayılan seti).
   Set = SATIRLAR; her satır = TEK bağlayıcı + kendi ölçüleri (dört kuraldan biri) + geçerli olduğu birleşim boyu aralığı. Aynı `rule`
   kimliğini taşıyan satırlar arayüzde TEK KURALDIR: boy aralığını paylaşır, her bağlayıcı kendi ölçü bloğuyla durur. Bir boya denk gelen
   satırların HEPSİ uygulanır.
   Kurallar — `start` her zaman baştan (önden) TAM mesafe:
   'ends'  = baştan `start` + sondan `end`; boy `midFrom`'a ulaşınca tam ortaya bir tane daha ·
   'grid'  = 32 ızgarası: sonda `end` EN AZ mesafedir, delik ızgarada ona en yakın deliğe oturur (kalan pay sonda kalır); boy `midFrom`'a
             ulaşınca ortaya en yakın ızgara deliğine bir tane daha ·
   'steps' = verilen adımlarla sırayla ilerler (1. adım, 2. adım …), sonda `end` yine EN AZ mesafe ·
   'list'  = doğrudan liste: her nokta baştan ya da sondan verilen mesafede. */
export type ConnectorGroup = 'fixed' | 'movable';
export type LayoutKind = 'ends' | 'grid' | 'steps' | 'list';
/** 'steps' adımı: `d` mm ilerleyip delik koyar, `n` kez (0 = sığdığı kadar). (`c`: ESKİ, bkz. LayoutLine.connector2Id.) */
export interface LayoutStep { d: number; n: number; c?: number }
/** 'list' noktası: baştan ya da sondan `d` mm · 'mid' = birleşimin TAM ORTASINDAN `d` mm (0 = tam orta, eksi = öne, artı = arkaya). */
export interface LayoutPoint { from: 'start' | 'end' | 'mid'; d: number; c?: number }
export type StepEnds = 'front' | 'both' | 'centre';
export interface LayoutLine {
  id: string; connectorId: string | null; kind: LayoutKind;
  /** Kural kimliği: aynı kuralın bağlayıcı satırları bunu paylaşır (boy aralıkları da aynıdır); yoksa satır tek başına bir kuraldır. */
  rule?: string;
  /** Geçerli olduğu birleşim boyu (mm, ikisi de dahil; boy tam mm'ye yuvarlanarak bakılır). `max` 0 = üst sınır yok. */
  min: number; max: number;
  start: number; end: number; midFrom: number; pitch: number; steps: LayoutStep[]; points: LayoutPoint[];
  /** 'steps' uçları: 'front' (varsayılan) = ön SABİT `start`, arka EN AZ `end` · 'both' = ön + arka SABİT · 'centre' = ön ve arka EŞİT, en az
   *  `start` — adım deseni ortalanır (delikler arası adımlar bozulmaz). */
  stepEnds?: StepEnds;
  /** 'list' kipi: 'hand' (varsayılan) = `points` elle · 'equal' = önden `start` + arkadan `end` SABİT, `count` bağlayıcı (uçlar dahil) arası EŞİT
   *  (`points` saklanır, elle kipe dönülünce geri gelir). */
  listMode?: 'hand' | 'equal'; count?: number;
  /** ESKİ (16. tur): `true` = 'both'. Okurken `stepEndsOf` çevirir; arayüz seçince silinir. */
  endFixed?: boolean;
  /** ESKİ (8. tur): satırda 2. bağlayıcı + nokta başına seçim. Açılışta ayrı satırlara çevrilir (ConnectorService.migrateConnectorGroups). */
  connector2Id?: string | null; use?: { start?: number; mid?: number; end?: number };
}
export interface ConnectorLayoutSet {
  id: string; name: string; lines: LayoutLine[]; createdAt: number;
  /** Grubu (yoksa 'fixed') · grubunun VARSAYILAN seti mi (grupta işaretli yoksa ilk set varsayılandır). */
  group?: ConnectorGroup; isDefault?: boolean;
}
/** Kenar kuralı: o kenara atılacak bağlayıcı GRUBU + DELİK YÜZÜ: `flipFace` → B yüzündeki işlemler (ör. kam yuvası) panelin öteki geniş yüzüne
 *  (varsayılan: görünmeyen yüz — bkz. ConnectorService.hiddenFaceRole / holeFaceOptions). Panel bunu kendi kaydıyla ezebilir (connectorFlip). `layoutId`: ESKİ (7. – 8. tur, kenara atanmış dizilim) — açılışta gruba çevrilir. */
export interface EdgeConnectorRule { group?: ConnectorGroup; flipFace?: boolean; layoutId?: string }
/** ESKİ kayıt (6. tura kadar): dizilim bağlayıcının / kenar kuralının içindeydi. Yalnız açılışta yeni dizilimlere çevrilirken okunur
 *  (ConnectorService.migrateLegacyLayouts). */
export interface LegacyLayout {
  mode?: 'ends' | 'step' | 'spacing' | 'count'; start?: number; end?: number; midFrom?: number; pitch?: number; fill?: 'steps' | 'middle';
  steps?: Array<{ k: number; n: number }>; ranges?: Array<LegacyLayout & { upTo: number }>;
}
export interface LegacyEdgeRule extends LegacyLayout { connectorId: string | null; custom?: boolean; flipFace?: boolean }
/** Tip kuralı: kenar rolü (ön / arka / üst / alt / sol / sağ) → o kenar başka panele dayanıyorsa atılacak bağlayıcı grubu. */
export interface PanelTypeRule { edges: Partial<Record<PanelEdgeDir, EdgeConnectorRule[]>> }
export interface PanelSurfaceRule { allowed: PanelTypeId[]; def: PanelTypeId }
export interface PanelTypeConfig { rules: Partial<Record<PanelTypeId, PanelTypeRule>>; surfaces: Partial<Record<PanelSurface, PanelSurfaceRule>> }
/** Kayıttan gelen ayar → güncel biçim (liste). Dizilimsiz ESKİ kurallar (bağlayıcı + gömülü dizilim) açılışta çevrilmek üzere korunur. */
export function normalizePanelTypeConfig(raw: { rules?: unknown; surfaces?: unknown } | null | undefined): PanelTypeConfig {
  const rules: PanelTypeConfig['rules'] = {};
  for (const [type, rule] of Object.entries((raw?.rules ?? {}) as Record<string, { edges?: Record<string, unknown> } | undefined>)) {
    const edges: PanelTypeRule['edges'] = {};
    for (const [edge, v] of Object.entries(rule?.edges ?? {})) {
      const list = (Array.isArray(v) ? v : v ? [v] : []).filter((r): r is EdgeConnectorRule => !!r && typeof r === 'object' && !!((r as EdgeConnectorRule).group || (r as EdgeConnectorRule).layoutId || (r as LegacyEdgeRule).connectorId));
      if (list.length) edges[edge as PanelEdgeDir] = list;
    }
    rules[type as PanelTypeId] = { edges };
  }
  return { rules, surfaces: (raw?.surfaces ?? {}) as PanelTypeConfig['surfaces'] };
}
/** Temsili birleşim: B paneli UCUYLA A panelinin yüzüne dayanır. bFace = B'nin geniş yüzü · bEdge = B'nin ucu (kalınlığı) · aFace = A'nın temas yüzü. */
export type ConnSurface = 'bFace' | 'bEdge' | 'aFace';
/** Delik: `along` = birleşim çizgisi boyunca bağlayıcı noktasından · `across` = bFace'te birleşimden B'nin içine, bEdge / aFace'te B kalınlığının ortasından. */
export interface ConnHole { id: string; surface: ConnSurface; along: number; across: number; diameter: number; depth: number }
/** Çizim nesnesi — yüzey 2B koordinatında (x = along, y = across); Draft.Shape2 ile yapısal uyumlu. */
export type ConnShape =
  | { t: 'line'; a: { x: number; y: number }; b: { x: number; y: number } }
  | { t: 'circle'; c: { x: number; y: number }; r: number }
  | { t: 'pline'; v: Array<{ x: number; y: number }>; closed?: boolean };
/** Çizilmiş operasyon: 'pocket' = kapalı çevrenin içi `depth` kadar boşaltılır · 'line' = çizgi boyunca `width` çaplı takım `depth` derinlikte yürür. */
export type ConnOpType = 'pocket' | 'line';
export interface ConnOp { id: string; surface: ConnSurface; type: ConnOpType; depth: number; width: number; shapes: ConnShape[] }
/** Bağlayıcı modeli (aksesuar dosyası): delik gibi yüzeye yerleşir; modelin +Y'si yüzeyden DIŞARI bakar (`flip` → içeri), `inset` malzemeye gömme,
 *  `spin` yüzey normali etrafında dönüş (°). Deliklerden bağımsızdır. */
export interface ConnPart { id: string; modelId: string; surface: ConnSurface; along: number; across: number; inset: number; spin: number; flip?: boolean; layerId?: string | null }
export interface Connector {
  id: string; name: string; holes: ConnHole[]; ops: ConnOp[]; parts: ConnPart[]; tA?: number; tB?: number; createdAt: number;
  /** ESKİ: dizilim artık ayrı kayıt (ConnectorLayoutSet); açılışta çevrilir. */
  layout?: LegacyLayout;
}

export const DEFAULT_QUICK_BODY: QuickBodyConfig = {
  base: 'plinth', thickness: 18,
  joins: { tl: 'side', tr: 'side', bl: 'side', br: 'side' },
  plinth: { height: 100, front: 0, rear: 50, rearPlinth: true },   // ön baza gövde önüyle aynı hizada, arka baza 50 mm içeride
  legs: { count: 0, height: 100, diameter: 50, side: 60, front: 60, rear: 60 },   // bazalıda ayak varsayılan yok; Legs tabanına geçince 4
  back: { enabled: true, placement: 'inner', thickness: 8, setback: 10, inset: 10, clear: { front: 0.5, back: 0.5, depth: 1 } },
  top: DEFAULT_RAILS, bottom: DEFAULT_RAILS,
};

export interface Shape {
  id: string; type: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  geometry: THREE.BufferGeometry;
  color?: string;
  parameters: Record<string, any>;
  replicadShape?: any;
  /** Arkalık kanalı / delik açılmış panelde KESİLMEMİŞ mesh (ayak izi / damga için; userData.groovedUuid = eşleştiği `geometry`). */
  ungroovedGeometry?: THREE.BufferGeometry;
  /** Panele işlenen delikler (aksesuar kaynaklı; PanelEngine son geçişte yazar) — üretim listesi. */
  holes?: PanelHole[];
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
export enum SnapType {
  ENDPOINT = 'endpoint', MIDPOINT = 'midpoint', CENTER = 'center', QUADRANT = 'quadrant',
  PERPENDICULAR = 'perpendicular', INTERSECTION = 'intersection', TANGENT = 'tangent', NEAREST = 'nearest',
}
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
  /** Uygulama geneli nesne yakalama: ana anahtar + kipler (2B çizim, ileride panel yerleşimi vb. aynı kaynağı okur). */
  snapEnabled: boolean; setSnapEnabled: (b: boolean) => void;
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
  /** Hacim seçme modu. groupId verilirse yeniden seçim: hacmi yalnız sırada gruptan önce gelen paneller sınırlar. */
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
  /** Kapak seçme modu (adaylar kapak-sınırı panellerden kurulur). */
  doorPickMode: boolean; setDoorPickMode: (b: boolean) => void;
  /** PANEL REF modu: tıklanan kapak-sınırı dikme/rafın ortasından kapak bölünür. */
  doorRefPickGroupId: string | null; setDoorRefPickGroupId: (id: string | null) => void;
  doorPickCandidates: DoorPick[]; doorPickIndex: number;
  setDoorPick: (c: DoorPick[], i: number) => void;
  doorPickPlacement: 'outer' | 'inner'; setDoorPickPlacement: (p: 'outer' | 'inner') => void;

  // ARKALIK (BackService) — kapaktan bağımsız dilim.
  backGroups: BackGroup[];
  addBackGroup: (g: BackGroup) => void;
  updateBackGroup: (id: string, u: Partial<BackGroup>) => void;
  deleteBackGroup: (id: string) => void;
  selectedBackGroupId: string | null; setSelectedBackGroupId: (id: string | null) => void;
  /** Şemada seçili arkalık parçalarının VF'leri: 3B'de yalnız bunlar vurgulanır (boş → grup seçiliyse tüm üyeler). */
  backFocusVfIds: string[]; setBackFocusVfIds: (ids: string[]) => void;
  /** Arkalık seçme modu: tıklama gövdenin ARKA yüzüne taşınır, adaylar arkalık-sınırı panellerden kurulur. */
  backPickMode: boolean; setBackPickMode: (b: boolean) => void;
  /** PANEL REF modu: tıklanan arkalık-sınırı dikme/rafın ortasından arkalık bölünür. */
  backRefPickGroupId: string | null; setBackRefPickGroupId: (id: string | null) => void;
  backPickCandidates: BackPick[]; backPickIndex: number;
  setBackPick: (c: BackPick[], i: number) => void;

  /* BAZA AYAĞI SETLERİ (PlinthService): gövdeden bağımsız setler; seçme modu raf/dikme gibi hacim tıklamasıyla. */
  plinthSets: PlinthSet[];
  addPlinthSet: (s: PlinthSet) => void; updatePlinthSet: (id: string, u: Partial<PlinthSet>) => void; deletePlinthSet: (id: string) => void;
  plinthPickMode: boolean; setPlinthPickMode: (b: boolean) => void;
  plinthPickCandidates: PlinthPick[]; plinthPickIndex: number; setPlinthPick: (c: PlinthPick[], i: number) => void;
  /** Aday hacmin varsayılan yüksekliği (mm). */
  plinthPickHeight: number; setPlinthPickHeight: (h: number) => void;
  /** Yerleştirmede ÖN yön: null = gövdenin ön yönü (parametre / kapaklar / +Z); şeritten seçilirse o yön (onayda gövdeye yazılır). */
  plinthPickFacing: AxisDir | null; setPlinthPickFacing: (a: AxisDir | null) => void;
  /** Yerleştirmede kullanılacak ayak seti (LegPreset id; null = yerleşik ayak, varsayılan düzen). */
  plinthPickPresetId: string | null; setPlinthPickPresetId: (id: string | null) => void;
  /** Gövde yüz rolleri: "Show face roles" açıkken liste ve sahnede tıklanabilir rol rozetleri (iki yön de store'dan). */
  showFaceRoles: boolean; setShowFaceRoles: (b: boolean) => void;
  faceRoleHover: { shapeId: string; gi: number } | null; setFaceRoleHover: (h: { shapeId: string; gi: number } | null) => void;

  /* AKSESUAR KÜTÜPHANESİ (AccessoryService): modeller / ayak modelleri / ayak setleri — IndexedDB'den yüklenir, burada canlı kopya. */
  accessoryModels: AccessoryModel[]; legModels: LegModel[]; legPresets: LegPreset[]; accessoryLayers: AccessoryLayer[];
  setAccessoryLibrary: (lib: { accessoryModels?: AccessoryModel[]; legModels?: LegModel[]; legPresets?: LegPreset[]; accessoryLayers?: AccessoryLayer[] }) => void;
  upsertAccessoryModel: (m: AccessoryModel) => void; removeAccessoryModel: (id: string) => void;
  upsertLegModel: (m: LegModel) => void; removeLegModel: (id: string) => void;
  upsertLegPreset: (p: LegPreset) => void; removeLegPreset: (id: string) => void;
  upsertAccessoryLayer: (l: AccessoryLayer) => void; removeAccessoryLayer: (id: string) => void;
  accessoryCategory: AccessoryCategory; setAccessoryCategory: (c: AccessoryCategory) => void;
  /* PANEL TİPLERİ + BAĞLAYICILAR (ConnectorService): kütüphane kaydı (IndexedDB), burada canlı kopya. */
  connectors: Connector[]; upsertConnector: (c: Connector) => void; removeConnector: (id: string) => void; setConnectors: (list: Connector[]) => void;
  connectorLayouts: ConnectorLayoutSet[]; setConnectorLayouts: (list: ConnectorLayoutSet[]) => void;
  panelTypeConfig: PanelTypeConfig; setPanelTypeConfig: (c: PanelTypeConfig) => void;
  /** Yerleştirme şeridinde seçilen panel tipi (null = otomatik / yüzey varsayılanı); her mod açılışında sıfırlanır. */
  placementPanelType: PanelTypeId | null; setPlacementPanelType: (t: PanelTypeId | null) => void;
  /** Arkalık seçmede tip: 'outer' = arkadan çakma, 'inner' = kanallı. */
  backPickPlacement: BackPlacement; setBackPickPlacement: (p: BackPlacement) => void;

  filletMode: boolean; setFilletMode: (b: boolean) => void;
  selectedFilletFaces: number[];
  addFilletFace: (i: number) => void; clearFilletFaces: () => void;
  selectedFilletFaceData: FilletFaceData[];
  addFilletFaceData: (d: FilletFaceData) => void;
  clearFilletFaceData: () => void;

  /** HIZLI GÖVDE modu: köşe birleşimleri + taban (düz/ayaklı/bazalı) + arkalık tek seferde yerleştirilir. */
  quickBodyMode: boolean; setQuickBodyMode: (b: boolean) => void;
  quickBodyConfig: QuickBodyConfig; setQuickBodyConfig: (patch: Partial<QuickBodyConfig>) => void;
  quickBodyBusy: boolean; setQuickBodyBusy: (b: boolean) => void;
  /** Motor uzun bir üretimde: ekran kilitli, bekleme penceresi açık (PanelEngine iş takibi yazar, Ui.BusyOverlay çizer). */
  engineBusy: EngineBusy | null;

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
  /** 'arrow' / 'arrowFixed' = ok modları: yüz seçilmez, 3D'deki oklar panelin EN DIŞ yüzünü büyütür (dyn: değer kadar · fixed: ölçü = değer). */
  faceExtrudeValueMode: FaceExtrudeValueMode; setFaceExtrudeValueMode: (m: FaceExtrudeValueMode) => void;
  faceExtrudeRefCandidate: RefFacePick | null; setFaceExtrudeRefCandidate: (v: RefFacePick | null) => void;
  /** Extrude modu panel yerine raf/dikme grubunun HACMİNİ hedefler. */
  faceExtrudeCavityGroupId: string | null; setFaceExtrudeCavityGroupId: (id: string | null) => void;
  faceExtrudeCavityFaceNormal: Vec3 | null; setFaceExtrudeCavityFaceNormal: (n: Vec3 | null) => void;
  /** Baza seti hacim düzenleme (Volume): hedef set — panel / grup hedefiyle karşılıklı dışlayıcı. */
  faceExtrudePlinthId: string | null; setFaceExtrudePlinthId: (id: string | null) => void;
  /** Ok modlarında seçili ok: tık yalnız seçer, şeritteki onay uygular. */
  faceExtrudeArrowAxis: AxisDir | null; setFaceExtrudeArrowAxis: (a: AxisDir | null) => void;

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
/** Bekleme penceresinin durumu. İlerleme SÜREYE göre: `frac` = biten adımların tahmini süresi / toplam tahmin; `fracTo` = şimdiki adım
 *  bitince varılacak oran, `stepMs` = o adımın tahmini süresi (çubuk bu sürede `fracTo`'ya kayar — ana iş parçacığı doluyken de akar). */
export interface EngineBusy {
  title: string; detail: string; frac: number; fracTo: number; stepMs: number; step: number; steps: number;
  /** İşin başladığı an (Date.now) ve kalan süre tahmini (ms; bilinmiyorsa null). */
  startedAt: number; etaMs: number | null;
}
/** Motor oturumu sürüyor mu (tepkisiz bayrak — her karede okunur; zincirleme üretimleri kapsar). */
export const engineLoad = { active: false };
/** Panel giriş animasyonu ↔ motor (tepkisiz, her karede okunur):
 *  `ready`   — motorun son geçişte ürettiği paneller: animasyon panelin SON geometrisini bekler (ara geçişte biçim değiştirmesin).
 *  `decor`   — delikleri kesim işçisinde olan paneller: animasyon sonuna doğru yavaşlar, delikler gelince tamamlanır.
 *  `playing` / `waiting` — süren / başlamayı bekleyen animasyon sayısı: animasyon oynarken (ya da bekleyen panel hazır olduğunda,
 *  `readyTick`) motor adım aralarında kare çizdirir. */
export const entryGate = { ready: new Set<string>(), decor: new Set<string>(), playing: 0, waiting: 0, readyTick: 0 };
/** Motoru tembel yükleyip gövdenin panellerini yeniden üretir (tek rebuild giriş noktası). `connectorsOnly` = yalnız bağlayıcı kesicisi
 *  değişen paneller yeniden üretilir (kural / bağlayıcı / tip değişimi); hiçbiri değişmediyse iş yapılmaz. */
export const requestRebuild = (parentId: string, opts?: { changedPanelId?: string; orderChanged?: boolean; connectorsOnly?: boolean }): Promise<void> =>
  import('./components/PanelEngine').then(({ rebuildPanelsForParent }) => rebuildPanelsForParent(parentId, opts));

type Xform = Pick<Shape, 'position' | 'rotation' | 'scale'>;
/** Dönüşüm farkı: konum/dönüş eklenir, ölçek çarpılır (grup üyeleri ve sürüklenen gövdenin panelleri). */
export type XformDelta = { pd: number[]; rd: number[]; sd: number[] };
export const applyXformDelta = (b: Xform, d: XformDelta): Xform => ({
  position: [b.position[0] + d.pd[0], b.position[1] + d.pd[1], b.position[2] + d.pd[2]],
  rotation: [b.rotation[0] + d.rd[0], b.rotation[1] + d.rd[1], b.rotation[2] + d.rd[2]],
  scale: [b.scale[0] * d.sd[0], b.scale[1] * d.sd[1], b.scale[2] * d.sd[2]],
});
const patchById = <T extends { id: string }>(list: T[], id: string, u: Partial<T>): T[] => list.map(x => (x.id === id ? { ...x, ...u } : x));
/** Seçme/yerleştirme modları karşılıklı dışlayıcı: biri açılınca diğerleri adaylarıyla birlikte kapanır. */
const pickModesOff = () => ({
  raycastMode: false, raycastPendingVf: null, placementName: '', placementPanelType: null, quickBodyMode: false,
  volumePickMode: null, volumePickGroupId: null, volumePickCandidates: [], volumePickIndex: 0,
  doorPickMode: false, doorPickCandidates: [], doorPickIndex: 0,
  backPickMode: false, backPickCandidates: [], backPickIndex: 0,
  plinthPickMode: false, plinthPickCandidates: [], plinthPickIndex: 0, plinthPickFacing: null,
});
/** Kimliğe göre ekle / değiştir (sıra korunur, yeni öğe sona). */
const upsertById = <T extends { id: string }>(list: T[], item: T): T[] =>
  list.some(x => x.id === item.id) ? list.map(x => (x.id === item.id ? item : x)) : [...list, item];
/** Panel satırı / raf / kapak / arkalık seçimi karşılıklı dışlayıcı. */
const NO_GROUP_SEL = { selectedPanelRow: null, selectedPanelGroupId: null, selectedDoorGroupId: null, selectedBackGroupId: null };

export const useAppStore = create<AppState>((set, get) => ({
  shapes: [],
  addShape: (shape) => set((s) => ({ shapes: [...s.shapes, shape] })),

  // Gruplu şekilde konum/dönüş/ölçek değişimi grubun diğer üyelerine aynen uygulanır.
  updateShape: (id, updates) => set((state) => {
    const sh = shapeById(id, state.shapes);
    if (!sh) return {};
    const moved = 'position' in updates || 'rotation' in updates || 'scale' in updates;
    // Gövdenin panelleri gövdeyle aynı dönüşümü taşır (geometrileri gövde-yerel) — parametreden döndürmede de.
    const bodyXf = moved && sh.type !== 'panel' ? {
      ...(updates.position ? { position: [...updates.position] as Vec3 } : {}),
      ...(updates.rotation ? { rotation: [...updates.rotation] as Vec3 } : {}),
      ...(updates.scale ? { scale: [...updates.scale] as Vec3 } : {}),
    } : null;
    const shapes = state.shapes.map((s): Shape => {
      if (s.id === id) return { ...s, ...updates };
      if (bodyXf && s.type === 'panel' && (s.parameters as any)?.parentShapeId === id) return { ...s, ...bodyXf };
      if (!sh.groupId || s.groupId !== sh.groupId || !moved) return s;
      const pd = updates.position ? [0, 1, 2].map(i => updates.position![i] - sh.position[i]) : [0, 0, 0];
      const rd = updates.rotation ? [0, 1, 2].map(i => updates.rotation![i] - sh.rotation[i]) : [0, 0, 0];
      const sd = updates.scale ? [0, 1, 2].map(i => updates.scale![i] / sh.scale[i]) : [1, 1, 1];
      return { ...s, ...applyXformDelta(s, { pd, rd, sd }) };
    });
    return { shapes };
  }),

  deleteShape: (id) => set((state) => {
    const all = new Set([id, ...childPanelsOf(id, state.shapes).map(s => s.id)]);
    return {
      shapes: state.shapes.filter(s => !all.has(s.id)),
      // Gövdeyle birlikte raf/dikme, kapak ve arkalık grupları da gider (üye VF'leri gövdeye bağlıdır).
      panelGroups: state.panelGroups.filter(g => g.shapeId !== id),
      doorGroups: state.doorGroups.filter(g => g.shapeId !== id),
      backGroups: state.backGroups.filter(g => g.shapeId !== id),
      plinthSets: state.plinthSets.filter(g => g.shapeId !== id),
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
      shapes: s.shapes.map(x => (x.id === primaryId ? { ...x, groupId: gid }
        : x.id === secondaryId ? { ...x, groupId: gid, isReferenceBox: true } : x)),
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
  // Nesne yakalama — tek kaynak (Draft.ts ve sonraki tüketiciler okur).
  snapEnabled: true, setSnapEnabled: (b) => set({ snapEnabled: b }),
  snapSettings: { endpoint: true, midpoint: true, center: true, quadrant: true, perpendicular: true, intersection: true, tangent: false, nearest: false },
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
    const sh = shapeById(shapeId, get().shapes);
    if (!sh || !sh.subtractionGeometries) return;
    const arr = [...sh.subtractionGeometries];
    arr[idx] = null;
    try {
      const r = await rebuildBodySolid(sh, arr);
      set((S) => ({
        shapes: S.shapes.map(x => (x.id !== shapeId ? x : {
          ...x, geometry: r.geometry, replicadShape: r.replicadShape, subtractionGeometries: arr, fillets: r.fillets,
          position: [...sh.position] as Vec3, parameters: { ...x.parameters, scaledBaseVertices: r.scaledBaseVertices },
        })),
        selectedSubtractionIndex: null,
      }));
      try { await requestRebuild(shapeId); } catch (err) { console.error('rebuild after subtractor delete fail:', err); }
    } catch (e) { console.error('deleteSubtraction fail:', e); }
  },

  showOutlines: readOutlinePref(), setShowOutlines: (b) => { writeOutlinePref(b); set({ showOutlines: b }); },
  selectedPanelRow: null, selectedPanelRowParentId: null,
  // Tek panel seçimi grup seçimini düşürür (ikisi aynı anda olmaz).
  setSelectedPanelRow: (i, parentId) => set({ ...(i !== null ? NO_GROUP_SEL : {}), selectedPanelRow: i, selectedPanelRowParentId: parentId || null }),
  panelSelectMode: false,
  setPanelSelectMode: (b) => set({ ...NO_GROUP_SEL, panelSelectMode: b, selectedPanelRowParentId: null }),
  faceEditMode: false, setFaceEditMode: (b) => set({ faceEditMode: b }),

  panelGroups: [],
  addPanelGroup: (g) => set((s) => ({ panelGroups: [...s.panelGroups, g] })),
  updatePanelGroup: (id, u) => set((s) => ({ panelGroups: patchById(s.panelGroups, id, u) })),
  deletePanelGroup: (id) => set((s) => ({
    panelGroups: s.panelGroups.filter(g => g.id !== id),
    selectedPanelGroupId: s.selectedPanelGroupId === id ? null : s.selectedPanelGroupId,
  })),
  selectedPanelGroupId: null,
  setSelectedPanelGroupId: (id) => set({ ...(id ? NO_GROUP_SEL : {}), selectedPanelGroupId: id }),
  volumePickMode: null,
  setVolumePickMode: (m, groupId = null) => set({
    ...(m ? pickModesOff() : {}),
    volumePickMode: m, volumePickGroupId: m ? groupId : null, volumePickCandidates: [], volumePickIndex: 0,
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
  updateDoorGroup: (id, u) => set((s) => ({ doorGroups: patchById(s.doorGroups, id, u) })),
  deleteDoorGroup: (id) => set((s) => ({
    doorGroups: s.doorGroups.filter(g => g.id !== id),
    selectedDoorGroupId: s.selectedDoorGroupId === id ? null : s.selectedDoorGroupId,
  })),
  selectedDoorGroupId: null,
  setSelectedDoorGroupId: (id) => set({ ...(id ? NO_GROUP_SEL : {}), selectedDoorGroupId: id }),
  doorRefPickGroupId: null,
  setDoorRefPickGroupId: (id) => set({ doorRefPickGroupId: id }),
  doorPickMode: false,
  setDoorPickMode: (b) => set({ ...(b ? pickModesOff() : {}), doorPickMode: b, doorPickCandidates: [], doorPickIndex: 0 }),
  doorPickCandidates: [], doorPickIndex: 0,
  setDoorPick: (c, i) => set({ doorPickCandidates: c, doorPickIndex: i }),
  doorPickPlacement: 'outer', setDoorPickPlacement: (p) => set({ doorPickPlacement: p }),

  backGroups: [],
  addBackGroup: (g) => set((s) => ({ backGroups: [...s.backGroups, g] })),
  updateBackGroup: (id, u) => set((s) => ({ backGroups: patchById(s.backGroups, id, u) })),
  deleteBackGroup: (id) => set((s) => ({
    backGroups: s.backGroups.filter(g => g.id !== id),
    selectedBackGroupId: s.selectedBackGroupId === id ? null : s.selectedBackGroupId,
  })),
  selectedBackGroupId: null,
  backFocusVfIds: [],
  setBackFocusVfIds: (ids) => set((s) => {
    const same = s.backFocusVfIds.length === ids.length && s.backFocusVfIds.every((x, i) => x === ids[i]);
    return same ? {} : { backFocusVfIds: ids };
  }),
  setSelectedBackGroupId: (id) => set({ ...(id ? NO_GROUP_SEL : {}), selectedBackGroupId: id }),
  backRefPickGroupId: null,
  setBackRefPickGroupId: (id) => set({ backRefPickGroupId: id }),
  backPickMode: false,
  setBackPickMode: (b) => set({ ...(b ? pickModesOff() : {}), backPickMode: b, backPickCandidates: [], backPickIndex: 0 }),
  backPickCandidates: [], backPickIndex: 0,
  setBackPick: (c, i) => set({ backPickCandidates: c, backPickIndex: i }),
  backPickPlacement: 'outer', setBackPickPlacement: (p) => set({ backPickPlacement: p }),

  plinthSets: [],
  addPlinthSet: (ps) => set((s) => ({ plinthSets: [...s.plinthSets, ps] })),
  updatePlinthSet: (id, u) => set((s) => ({ plinthSets: patchById(s.plinthSets, id, u) })),
  deletePlinthSet: (id) => set((s) => ({
    plinthSets: s.plinthSets.filter(x => x.id !== id),
    selectedPanelRow: s.selectedPanelRow === `plinth-${id}` ? null : s.selectedPanelRow,
  })),
  plinthPickMode: false,
  setPlinthPickMode: (b) => set({ ...(b ? pickModesOff() : {}), plinthPickMode: b, plinthPickCandidates: [], plinthPickIndex: 0, plinthPickFacing: null }),
  plinthPickCandidates: [], plinthPickIndex: 0,
  setPlinthPick: (c, i) => set({ plinthPickCandidates: c, plinthPickIndex: i }),
  plinthPickHeight: 100, setPlinthPickHeight: (h) => set({ plinthPickHeight: Math.max(1, h), plinthPickCandidates: [], plinthPickIndex: 0 }),
  plinthPickFacing: null, setPlinthPickFacing: (a) => set({ plinthPickFacing: a }),
  plinthPickPresetId: null, setPlinthPickPresetId: (id) => set({ plinthPickPresetId: id }),
  showFaceRoles: false, setShowFaceRoles: (b) => set({ showFaceRoles: b, ...(b ? {} : { faceRoleHover: null }) }),
  faceRoleHover: null, setFaceRoleHover: (h) => set({ faceRoleHover: h }),

  accessoryModels: [], legModels: [], legPresets: [], accessoryLayers: [],
  setAccessoryLibrary: (lib) => set((s) => ({
    accessoryModels: lib.accessoryModels ?? s.accessoryModels, legModels: lib.legModels ?? s.legModels, legPresets: lib.legPresets ?? s.legPresets,
    accessoryLayers: lib.accessoryLayers ?? s.accessoryLayers,
  })),
  upsertAccessoryLayer: (l) => set((s) => ({ accessoryLayers: upsertById(s.accessoryLayers, l) })),
  removeAccessoryLayer: (id) => set((s) => ({ accessoryLayers: s.accessoryLayers.filter(x => x.id !== id) })),
  upsertAccessoryModel: (m) => set((s) => ({ accessoryModels: upsertById(s.accessoryModels, m) })),
  removeAccessoryModel: (id) => set((s) => ({ accessoryModels: s.accessoryModels.filter(x => x.id !== id) })),
  upsertLegModel: (m) => set((s) => ({ legModels: upsertById(s.legModels, m) })),
  removeLegModel: (id) => set((s) => ({ legModels: s.legModels.filter(x => x.id !== id) })),
  upsertLegPreset: (p) => set((s) => ({ legPresets: upsertById(s.legPresets, p) })),
  removeLegPreset: (id) => set((s) => ({ legPresets: s.legPresets.filter(x => x.id !== id) })),
  accessoryCategory: 'legs', setAccessoryCategory: (c) => set({ accessoryCategory: c }),
  connectors: [], upsertConnector: (c) => set((s) => ({ connectors: upsertById(s.connectors, c) })),
  removeConnector: (id) => set((s) => ({ connectors: s.connectors.filter(x => x.id !== id) })), setConnectors: (list) => set({ connectors: list }),
  connectorLayouts: [], setConnectorLayouts: (list) => set({ connectorLayouts: list }),
  panelTypeConfig: { rules: {}, surfaces: {} }, setPanelTypeConfig: (c) => set({ panelTypeConfig: c }),
  placementPanelType: null, setPlacementPanelType: (t) => set({ placementPanelType: t }),

  filletMode: false, setFilletMode: (e) => set({ filletMode: e, selectedFilletFaces: [], selectedFilletFaceData: [] }),
  selectedFilletFaces: [],
  addFilletFace: (i) => set((s) => (s.selectedFilletFaces.includes(i) ? {} : { selectedFilletFaces: [...s.selectedFilletFaces, i] })),
  clearFilletFaces: () => set({ selectedFilletFaces: [], selectedFilletFaceData: [] }),
  selectedFilletFaceData: [],
  addFilletFaceData: (d) => set((s) => ({ selectedFilletFaceData: [...s.selectedFilletFaceData, d] })),
  clearFilletFaceData: () => set({ selectedFilletFaceData: [] }),

  quickBodyMode: false,
  setQuickBodyMode: (b) => set({ ...(b ? pickModesOff() : {}), quickBodyMode: b }),
  quickBodyConfig: DEFAULT_QUICK_BODY,
  setQuickBodyConfig: (patch) => set((s) => ({ quickBodyConfig: { ...s.quickBodyConfig, ...patch } })),
  quickBodyBusy: false, setQuickBodyBusy: (b) => set({ quickBodyBusy: b }),
  engineBusy: null,

  raycastMode: false,
  setRaycastMode: (b) => set({ ...(b ? pickModesOff() : {}), raycastMode: b, raycastPendingVf: null }),
  raycastPendingVf: null, setRaycastPendingVf: (v) => set({ raycastPendingVf: v }),
  placementName: '', setPlacementName: (s) => set({ placementName: s }),

  faceExtrudeMode: false,
  setFaceExtrudeMode: (b) => set({
    faceExtrudeMode: b, faceExtrudeSelectedFace: null, faceExtrudeClickPoint: null, faceExtrudeCavityFaceNormal: null, faceExtrudeArrowAxis: null,
    ...(!b ? { faceExtrudeTargetPanelId: null, faceExtrudeRefCandidate: null, faceExtrudeCavityGroupId: null, faceExtrudePlinthId: null } : {}),
  }),
  faceExtrudeTargetPanelId: null,
  setFaceExtrudeTargetPanelId: (id) => set({
    faceExtrudeTargetPanelId: id, faceExtrudeArrowAxis: null,
    ...(id ? { faceExtrudeCavityGroupId: null, faceExtrudeCavityFaceNormal: null, faceExtrudePlinthId: null } : {}),
  }),
  faceExtrudeCavityGroupId: null,
  setFaceExtrudeCavityGroupId: (id) => set({ faceExtrudeCavityGroupId: id, faceExtrudeArrowAxis: null,
    ...(id ? { faceExtrudeTargetPanelId: null, faceExtrudePlinthId: null } : {}) }),
  faceExtrudePlinthId: null,
  setFaceExtrudePlinthId: (id) => set({ faceExtrudePlinthId: id, faceExtrudeSelectedFace: null, faceExtrudeCavityFaceNormal: null, faceExtrudeArrowAxis: null,
    ...(id ? { faceExtrudeTargetPanelId: null, faceExtrudeCavityGroupId: null } : {}) }),
  faceExtrudeCavityFaceNormal: null, setFaceExtrudeCavityFaceNormal: (n) => set({ faceExtrudeCavityFaceNormal: n }),
  faceExtrudeSelectedFace: null, setFaceExtrudeSelectedFace: (i) => set({ faceExtrudeSelectedFace: i }),
  faceExtrudeClickPoint: null, setFaceExtrudeClickPoint: (p) => set({ faceExtrudeClickPoint: p }),
  faceExtrudeThickness: 18, setFaceExtrudeThickness: (v) => set({ faceExtrudeThickness: v }),
  faceExtrudeValueMode: 'fixed', setFaceExtrudeValueMode: (m) => set({ faceExtrudeValueMode: m, faceExtrudeArrowAxis: null }),
  faceExtrudeArrowAxis: null, setFaceExtrudeArrowAxis: (a) => set({ faceExtrudeArrowAxis: a }),
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
  updateVirtualFace: (id, u) => set((s) => ({ virtualFaces: patchById(s.virtualFaces, id, u) })),
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
