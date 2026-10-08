import {
  type CavityBox, type DoorAlign, type DoorBond, type DoorBoundRef, type DoorBounds, type DoorEdgeGaps, type DoorGroup, type DoorJointRef, type DoorLeafSplit, type DoorNode, type DoorPick, type DoorRect, type DoorType, type GapSpec, type PanelGroup, type Shape, type VirtualFace,
  panelOfVf, requestRebuild, shapeById, useAppStore,
} from '../store';
import * as THREE from 'three';
import { type Vec3, genId, round1 } from './Geometry';
import { largestFaceNormal, panelHasRotation } from './FaceRegion';
import {
  GROUP_PANEL_THICKNESS, applyGapEdit, bodyLocalBox, boxSpan, collectObstacles, createPanelGroupFromCavity, editGroupGap, fmtBox, gridForObstacles, groupFacing, memberThicknessesOf, panelLocalBox,
  rayCavityCandidates, redistributeForThickness,
} from './PanelGroupService';

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
//  • BÖLME = AĞAÇ (Goker, Eki 2026: "seçili olan kapağı bölmeliyiz; ilk tek kapak yerleşir, o bölünür, bölünen kapağı
//    tıklayıp tekrar dikey/yatay bölünebilmeli — daha esnek bir bölme"): DoorGroup.tree; yaprak = kapak, split = bir
//    eksende çocuklara bölünmüş alan (u = Split V yan yana, v = Split H üst üste). Her split kendi alanını çocuklarına
//    raf kuralıyla dağıtır (redistributeForThickness / applyGapEdit — kilit + girilen korunur, gerisi eşit); çocuklar
//    arası boşluklar split'te (gaps), dış kenar boşlukları grupta (edgeGaps). Bir kapağı bölmek üst bölmenin ölçüsünü
//    DEĞİŞTİRMEZ (toplam = ilk bölünen). Önceki cols×rows ızgarası kaldırıldı.
//  • Üye kapaklar sıradan VF-panelleridir (interior=true, doorGroupId): extrude /
//    move / rotate adımları motorda aynı yoldan uygulanır; VF her rebuild'de buradan
//    yazılır (recalculateDoorVfs). Kapak panelleri gövde panellerini DAMGALAMAZ, hacim
//    engeli DEĞİLDİR, gövdeyle kesilmez (PanelEngine / PanelGroupService isDoorPanel).
//  • AÇILI REFERANS (Goker, Eki 2026: "referans panel açılı yerleşmişse kapak da açılı
//    yerleşsin … aynı oraya panel atsaydım senaryosu gibi, bulunduğu yerin şeklini alarak
//    ama kapak gibi"): kapak DÜZLEMİ değişmez (tıklanan gövde yüzü); DÖNMÜŞ bir kapak-sınırı
//    paneli dikdörtgenin kenarı olmaz (eksen-hizalı kutusu şişkin), onun yerine gövde panelini
//    kestiği gibi kapağı BÜYÜK-YÜZ DÜZLEMİYLE (sonsuz yarım düzlem, boşluk kadar geri) keser:
//    üye çokgeni eğik kenarlı çıkar (yamuk/beşgen), kapak eğik panelin altında biter.
//    İç kapak: panelin kapağa bakan yüzü; dış kapak + panel kapak düzleminin gerisinde: uzak
//    yüzü (kalınlığını örter — düz kenar kuralıyla aynı). Kapağı katı olarak döndürmek
//    (referansın dönüşünü kapağa uygulamak) REDDEDİLDİ ("saçmaladı, 4 kenar bir kapak").
//    Kapak ŞEMASI (DoorSchematic) da üyeyi kırpılmış çokgeniyle çizer (Goker: "kapak previewinde de açılı görünsün").
//  • YARIM BİNME (Goker, Eki 2026): grup şemasında kapak alanının dört DIŞ kenarında checkbox (yalnız kenarın
//    sınır paneli varsa ve kapak onun kalınlığını örtüyorsa — dış kapak); işaretli kenar panel kalınlığının
//    ORTASINA çekilir (DoorGroup.halfOverlay, rectAtDepth), kenar boşluğu üstüne; o eksen eşit bölünür. AÇILI sınır
//    panelinde de aynı: kesici düzlem uzak yüz yerine levhanın ortasından geçer (clipMemberByCuts, cutEdgeOf).
//    İÇ kapakta yoktur: kutucuklar gizlenir, inner'a geçince bayraklar silinir (setDoorPlacement).
//  • KAPAK TİPLERİ (Goker, Eki 2026: "kapağın tipleri olmalı: sağa/sola/yukarı/aşağı açılır, sağa-sola açılır,
//    katlanarak açılır; sağa-sola açılırda ölçülenmiş yeri tekrar bölsün, iki kapak arası ayrıca ölçülensin, sağ ve
//    sol kapağın ölçüsü ayrı ayrı değişsin ama toplam ilk bölünen ölçü olsun; katlanırda dikeyde kendi içinde böl;
//    birden fazla kapağı seçip tek tip verebileyim"): tip YAPRAK başına (DoorNode.type). left / right / up / down tek
//    kanat (yalnız menteşe yönü, geometri aynı). double = yaprak u'da iki KANADA, fold = v'de iki kanada bölünür:
//    yaprağın alanı TOPLAMDIR, kanatlar içinde ayrıca ölçülenir (DoorNode.leafSplit = kanat ölçüleri + kanat arası
//    boşluk; raf kuralı: girilen korunur, kalan diğer kanada). Her kanat ayrı bir üye VF/paneldir (doorMemberRects:
//    DFS yaprak sırası, kanatlar ardışık). Yapı değişince (bölme, birleştirme, tek↔double/fold) yalnız etkilenen
//    yaprakların üyeleri yeniden kurulur (rebuildMembers — yaprak id + kanat sırası eşleşen VF'ler korunur).
//  • ŞEMADAKİ SINIR PANELLERİ + DERZ BAĞI (Goker, Eki 2026: "iç kapakta ya da kapak sınırı panel yoksa kalınlığı hiç
//    gösterme; dikme/rafa 2-3 mm yaklaşan kapakta göster; dikmeyi kapağın sağına/soluna/ortalı, rafı yukarı/aşağı/ortada
//    yerleştireyim, dikme ve raf buna göre hareket etsin, aralıklar revize edilsin; panel ref gösterildikten sonra dikmenin
//    arası değişince kapak kendini ona göre güncellesin — bağlı olduğu dikmeye göre"): doorNearPanels — dış kapakta, kapak
//    alanına (boşluk + 3 mm) değen / yaklaşan kapak-sınırı levhaları GERÇEK konum ve kalınlığıyla (iç kapak → hiç).
//    BAĞ derzdedir (DoorNode.refs[k] = {vfId, align}): bağlı derz her çözümde levhanın GÜNCEL kutusundan türetilir
//    (doorJointTargets → solveNode: 'center' derz levhanın ortasında, 'min' / 'max' levha derzin o tarafındaki kapağın
//    arkasında); bağlı bölmenin ölçüleri çözümden yazılır (girilmiş sayılır → bağsız çözüm de aynı değerleri verir). Levha
//    taşınınca (grup boşluğu girildi, gövde boyutlandı) KAPAK DERZİ LEVHAYI İZLER — rebuild içinde recalculateDoorVfs,
//    sonrasında syncDoorGroups ağacı yazar. Rozet (Left / Center / Right — Up / Center / Down): hiza yazılır ve LEVHA bir
//    kez kendi grubunun boşluğuyla taşınır (editGroupGap; kapak yerinde kalır — Goker: "raf ve dikme hareket etsin, kapak
//    değil"); levha taşınamıyorsa (gövde paneli, eksen uyuşmaz, kilitli komşular) derz levhaya gider. Shift+tık bağı çözer:
//    ölçüler girilmiş sayılır (donar). Dış kenardaki sınır paneli (grup bounds) için bağ YOK — orada kapak paneli izler
//    (yarım binme). Kapak düzlemi değişmez. PANEL REF modu (splitDoorAtPanel): seçilen dikme/rafın ortasından böler ve
//    derzi 'center' bağlar. Eski DoorGroup.panelAlign (levha her rebuild'de derze çekiliyordu — kullanıcının dikme
//    düzenlemesiyle çatışırdı) kaldırıldı; kayıtta varsa syncDoorGroups siler.
//  • KAPAKLARIN ARASINA RAF / DİKME (Goker, Eki 2026: "kapak atadıktan sonra 2 kapak arasına raf veya dikme kapağa göre
//    yerleştirilebilir olsun; raf ekle / dikme ekle düğmeleri; basınca 2 kapak arası belirginleşsin; genel listeye door
//    satırından sonra eklensin; eklenen raf ve dikme her zaman o kapak aralarının arasında çalışsın"): kapak kartındaki
//    Divider / Shelf düğmesi → şemada o eksendeki derzler (dikme = V derzleri, raf = H derzleri) vurgulanır → derze tık →
//    addPanelAtDoorJoint: derzin tıklanan YERİNDEN gövdeye hacim ışını (hacim seçimiyle aynı ızgara; kapaklar engel değil)
//    → yeni raf/dikme grubu (1 üye, listede sona = kapak satırından sonra) ve PanelGroup.doorBond: üye her çözümde derze
//    göre konumlanır (PanelGroupService.solveGroup → doorJointForBond) — LEVHA KAPAĞI İZLER; bu derz panel-ref ile
//    bağlanamaz (iki yönlü bağ yasak). Rozet aynı dili konuşur (Left / Center / Right → hiza; Shift → bağ çözülür, levha
//    kalır); grup kartındaki boşluk girişi KAPAK derzini taşır (moveDoorJointTo). Kapak / derz silinirse bağ düşer
//    (syncPanelGroups).
//    DERZ PARÇALARI (Goker, Eki 2026: "dikme yerleştirdim ama dikmenin sağına ve soluna raf yerleştiremedim, arayüz
//    tıklatmıyor; her dikme ve raf yeni bir satır olsun"): bir derz, onu kesen çapraz levhalarla (yatay derzi dikmeler,
//    dikey derzi raflar — kapak sınırı olsun olmasın, doorNearPanels allPanels) PARÇALARA bölünür; her parça ayrı tıklanır
//    ve `at` (derz boyunca çapraz koordinat) ışının yerini verir → her parçaya AYRI grup = listede ayrı satır. Eski
//    sürüm ışını hep derzin ORTASINDAN atıyordu: orta bir dikmenin içine düşünce serbest hücre yok → null → arayüz tepki
//    vermiyordu; ayrıca "bu derzde zaten bağlı levha var" denetimi aynı derzin öbür parçasını da engelliyordu. Şimdi
//    yinelenme denetimi PARÇA bazlıdır (mevcut bağlı grubun hacmi `at`ı kapsıyorsa).
// ═══════════════════════════════════════════════════════════════════════════

export const DOOR_THICKNESS = 18;
export const DOOR_GAP = 3;
const TOL = 0.5;
const MIN_DOOR_SPAN = 40;
const PREVIEW_ID = 'önizleme';
const MAX_DOOR_SPLIT = 12;
const NEAR_EXTRA = 3;        // kapak kenarı ile levha arasındaki "yaklaşma" payı (mm) — boşluğun üstüne
const THIN_PANEL = 60;       // şemada levha / bağlı derz levhası sayılacak en büyük kalınlık (mm); daha kalını (arkalık vb.) sayılmaz
const JOINT_NEAR = 30;       // levha merkezi ile derz merkezi arasındaki en büyük uzaklık (mm; + yarım kalınlık + yarım derz)

export const isDoorPanel = (p: any): boolean => !!p?.parameters?.doorGroupId;
export const isDoorVf = (vf: any): boolean => !!vf?.doorGroupId;
export const doorGroupName = (g: Pick<DoorGroup, 'name'>) => g.name ?? 'Door';
export const doorPlacementLabel = (p: DoorGroup['placement']) => (p === 'inner' ? 'Inner' : 'Outer');

// ── KAPAK TİPLERİ ───────────────────────────────────────────────────────────

export const DOOR_TYPES: DoorType[] = ['left', 'right', 'up', 'down', 'double', 'fold', 'drawer', 'fixed'];
/** Kısa İngilizce etiketler (Goker: "kapak tipleri kısa bir şekilde İngilizce olsun"). */
export const DOOR_TYPE_LABEL: Record<DoorType, string> = { left: 'Left', right: 'Right', up: 'Up', down: 'Down', double: 'Double', fold: 'Fold', drawer: 'Drawer', fixed: 'Fixed' };
export const DOOR_TYPE_TITLE: Record<DoorType, string> = {
  left: 'Left — hinged on the left, opens to the right (as seen from the front)',
  right: 'Right — hinged on the right, opens to the left',
  up: 'Up — lift-up flap, hinged at the top',
  down: 'Down — drop-down flap, hinged at the bottom',
  double: 'Double — two leaves side by side (left + right hinged); the door is split in two, each leaf sized within the door',
  fold: 'Fold — bi-fold lift-up, two leaves stacked; the door is split in two vertically, each leaf sized within the door',
  drawer: 'Drawer — drawer front (no hinges, pulls out)',
  fixed: 'Fixed — no hinges; fixed / false front panel',
};
/** Menteşesi olmayan tipler (açılış işareti çizilmez). */
export const isHingelessDoorType = (t: DoorType) => t === 'drawer' || t === 'fixed';
/** Kanat ekseni: double → u (yan yana), fold → v (üst üste); tek kanatlı tiplerde null. */
export const doorLeafAxis = (t: DoorType | undefined): 'u' | 'v' | null => (t === 'double' ? 'u' : t === 'fold' ? 'v' : null);
/** Varsayılan tip (yan yana bölmede c. çocuk): tek → left; çok parçada sol yarı left, sağ yarı right (bir çift kapağın doğal menteşeleri). */
export const defaultDoorType = (c: number, count: number): DoorType => (count >= 2 && c >= count / 2 ? 'right' : 'left');

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

/**
 * Gövdenin KAPAK SINIRI işaretli panelleri (gövde-yerel kutularıyla); kapaklar ve dönmüş paneller hariç.
 * `onlyBound=false` → işaretsizler de (derz parçalama: kapak sınırı olmayan bir dikme de derzi keser).
 */
export function collectDoorBoundPanels(parent: Shape, shapes: Shape[] = useAppStore.getState().shapes, vfs: VirtualFace[] = useAppStore.getState().virtualFaces, onlyBound = true): DoorBoundPanel[] {
  const out: DoorBoundPanel[] = [];
  for (const vf of vfs) {
    if (vf.shapeId !== parent.id || (onlyBound && !vf.doorBound) || isDoorVf(vf)) continue;
    const p = panelOfVf(vf.id, shapes);
    if (!p || panelHasRotation(p)) continue;
    const box = panelLocalBox(p, parent);
    if (!box) continue;
    out.push({ vfId: vf.id, panelId: p.id, box, name: vf.description || 'Panel' });
  }
  return out;
}

// ── AÇILI REFERANS KESİMLERİ ────────────────────────────────────────────────

/** Dönmüş kapak-sınırı paneli: büyük-yüz normali (gövde-yerel) + levhanın o normaldeki aralığı + eksen-hizalı kutusu. */
export interface DoorCut { vfId: string; name: string; n: Vec3; dMin: number; dMax: number; box: CavityBox }

/** Gövdenin DÖNMÜŞ kapak-sınırı panelleri (kesici düzlemler). Düz paneller dikdörtgen kenarıdır, burada yok. */
export function collectDoorCuts(parent: Shape, shapes: Shape[] = useAppStore.getState().shapes, vfs: VirtualFace[] = useAppStore.getState().virtualFaces): DoorCut[] {
  const out: DoorCut[] = [];
  for (const vf of vfs) {
    if (vf.shapeId !== parent.id || !vf.doorBound || isDoorVf(vf)) continue;
    const p = panelOfVf(vf.id, shapes);
    if (!p || !panelHasRotation(p)) continue;
    const box = panelLocalBox(p, parent);
    const n = largestFaceNormal(p.geometry);
    const pos = p.geometry?.getAttribute?.('position') as THREE.BufferAttribute | undefined;
    if (!box || !n || !pos) continue;
    const off = [0, 1, 2].map(k => (p.position?.[k] ?? 0) - (parent.position?.[k] ?? 0));
    let dMin = Infinity, dMax = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const d = (pos.getX(i) + off[0]) * n.x + (pos.getY(i) + off[1]) * n.y + (pos.getZ(i) + off[2]) * n.z;
      if (d < dMin) dMin = d; if (d > dMax) dMax = d;
    }
    if (!(dMax - dMin > 0.5)) continue;
    out.push({ vfId: vf.id, name: vf.description || 'Panel', n: [n.x, n.y, n.z], dMin, dMax, box });
  }
  return out;
}

type Pt2 = { x: number; y: number };
/** Konveks çokgeni A·x + B·y ≤ C yarım düzlemiyle kırpar (Sutherland–Hodgman, tek kenar). */
function clipHalfPlane(poly: Pt2[], A: number, B: number, C: number): Pt2[] {
  const out: Pt2[] = [];
  const f = (p: Pt2) => A * p.x + B * p.y - C;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const fa = f(a), fb = f(b);
    if (fa <= 0) out.push(a);
    if ((fa < 0 && fb > 0) || (fa > 0 && fb < 0)) { const t = fa / (fa - fb); out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); }
  }
  return out;
}
const polyArea = (p: Pt2[]) => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q.x * r.y - r.x * q.y; } return a / 2; };

/**
 * Üye dikdörtgenini dönmüş sınır panellerinin BÜYÜK-YÜZ düzlemleriyle kırpar → (u,v) çokgeni; kesim yoksa null.
 * Tutulan taraf = üyenin merkezinin bulunduğu taraf. Kesim çizgisi kapağın İKİ yüzeyinde de (ön/arka) alınır,
 * kısıtlayıcı olan tutulur: dik kenarlı kapak eğik panele girmez. Boşluk (gap) düzlemden geri çekilir.
 * Panelin kutusu üyenin (u,v) açıklığıyla örtüşmüyorsa (başka bölme) o panel kesmez.
 */
/**
 * Dönmüş kesicinin hangi KENARI kestiği (yarım binme bayrağı için): kaldırılan yarım düzlemin yönü (kapak
 * düzlemindeki normal bileşeni) hangi eksende baskınsa o kenar — eğik üst panel → vMax, eğik dikme → uMin/uMax.
 * keepBelow = üyenin merkezi levhanın "min" tarafında (tutulan taraf).
 */
function cutEdgeOf(c: DoorCut, cu: number, cv: number, axis: 0 | 1 | 2, front: number): { edge: DoorEdgeKey; keepBelow: boolean } | null {
  const { u, v } = doorPlaneAxes(axis);
  const A = c.n[u], B = c.n[v], Na = c.n[axis];
  if (Math.abs(A) < 1e-6 && Math.abs(B) < 1e-6) return null;   // kapak düzlemine paralel: kesim anlamsız
  const keepBelow = A * cu + B * cv + Na * front < (c.dMin + c.dMax) / 2;
  const ru = keepBelow ? A : -A, rv = keepBelow ? B : -B;       // kaldırılan yön
  const edge: DoorEdgeKey = Math.abs(ru) >= Math.abs(rv) ? (ru > 0 ? 'uMax' : 'uMin') : (rv > 0 ? 'vMax' : 'vMin');
  return { edge, keepBelow };
}
/** Kesici kapağın GERİSİNDE mi (dış kapak kalınlığını örter → uzak yüz; yarım binme burada anlamlı)? */
const cutCoverFar = (c: DoorCut, axis: 0 | 1 | 2, side: 1 | -1, placement: DoorGroup['placement'], front: number) =>
  placement === 'outer' && (side > 0 ? c.box.max[axis] <= front + TOL : c.box.min[axis] >= front - TOL);

function clipMemberByCuts(
  m: { u0: number; u1: number; v0: number; v1: number }, cuts: DoorCut[], axis: 0 | 1 | 2, side: 1 | -1,
  placement: DoorGroup['placement'], thickness: number, front: number, gap: number, half?: HalfOverlay, ref?: [number, number],
): Pt2[] | null {
  if (!cuts.length) return null;
  const { u, v } = doorPlaneAxes(axis);
  let poly: Pt2[] = [{ x: m.u0, y: m.v0 }, { x: m.u1, y: m.v0 }, { x: m.u1, y: m.v1 }, { x: m.u0, y: m.v1 }];
  const planes = placement === 'outer' ? [front, front + side * thickness] : [front - side * thickness, front];   // kapak levhasının iki yüzeyi
  // TUTULAN TARAF: çıpa (tıklanan nokta / grubun anchor'ı) verilmişse o; yoksa üyenin merkezi (eski davranış).
  const cu = ref ? ref[0] : (m.u0 + m.u1) / 2, cv = ref ? ref[1] : (m.v0 + m.v1) / 2;
  let any = false;
  for (const c of cuts) {
    if (Math.min(c.box.max[u], m.u1) - Math.max(c.box.min[u], m.u0) < TOL || Math.min(c.box.max[v], m.v1) - Math.max(c.box.min[v], m.v0) < TOL) continue;
    const A = c.n[u], B = c.n[v], Na = c.n[axis];
    const ce = cutEdgeOf(c, cu, cv, axis, front);
    if (!ce) continue;
    const { keepBelow } = ce;
    // Panel kapak düzleminin GERİSİNDE mi (dış kapak kalınlığını örter) ?
    const coverFar = cutCoverFar(c, axis, side, placement, front);
    // YARIM BİNME (Goker: "açılı olan yerde kapak yarı binili olmuyor"): o kenarın bayrağı açıksa ve kapak paneli
    // örtüyorsa uzak yüz yerine levhanın ORTASI (dMin+dMax)/2 sınırdır — düz kenardaki (iç+dış)/2 kuralının aynısı.
    const halfHere = coverFar && !!half?.[ce.edge];
    const mid = (c.dMin + c.dMax) / 2;
    let before = poly;
    if (keepBelow) {
      const lim = (halfHere ? mid : coverFar ? c.dMax : c.dMin) - gap;
      const C = Math.min(...planes.map(pa => lim - Na * pa));   // A·u + B·v ≤ C (kısıtlayıcı yüzey)
      poly = clipHalfPlane(poly, A, B, C);
    } else {
      const lim = (halfHere ? mid : coverFar ? c.dMin : c.dMax) + gap;
      const C = Math.max(...planes.map(pa => lim - Na * pa));   // A·u + B·v ≥ C  ⇔  −A·u − B·v ≤ −C
      poly = clipHalfPlane(poly, -A, -B, -C);
    }
    if (poly.length < 3 || polyArea(poly) < MIN_DOOR_SPAN * MIN_DOOR_SPAN) { console.warn('[YAGO][KAPAK-AÇILI] kesim üyeyi yok ediyor, atlandı:', c.name); poly = before; continue; }
    if (poly.length !== before.length || poly.some((q, i) => Math.abs(q.x - before[i].x) > 1e-6 || Math.abs(q.y - before[i].y) > 1e-6)) any = true;
  }
  return any ? poly : null;
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
type EdgeInfo = { ref: DoorBoundRef; inner: number; outer: number; front: number | null };

/**
 * KENAR KURALI (Goker, Eki 2026): "inner dersem kapak referans panellerin her zaman İÇİNE yerleşsin; outer olduğunda
 * referans panelin DIŞINA yerleşsin. İçerde derinliği kısalmış bir dikme varsa outer kapak yine panellerin içine
 * geçebilir — referans aldığı sınır panelinin dışında olması kapağı outer yapıyor."
 *  • Kapak düzlemi P = derinlik referansının ön yüzü. Outer: kapak [P, P+t] (önünde); inner: [P−t, P] (hizalı).
 *  • INNER: her kenar sınır panelinin İÇ yüzünde (paneller arasına).
 *  • OUTER: kenar paneli kapağın ARKASINDA kalıyorsa (ön yüzü P'nin gerisinde/hizasında) kapak onun kalınlığını
 *    örter → DIŞ yüz; panel P'den öne taşıyorsa (daha derin gövde paneli, kapak içerde) kapak ona çarpamaz → İÇ yüz.
 *  • Gövde kenarı (sınır paneli yok): iki yüz aynıdır.
 *  • YARIM BİNME (Goker, Eki 2026: "checkboxa tıkladığımda yerleştiği panel kalınlığının yarısı kadar kapağı o
 *    kenardan kısaltsın, artı kenar boşluğu kadar kısaltsın, sonra eşit bölümlendirsin"): kapak o kenarda panelin
 *    DIŞ yüzüne değil kalınlığının ORTASINA kadar gider ((iç+dış)/2) — yalnız dış yüzün kullanıldığı kenarlarda
 *    (dış kapak + panel kapağın gerisinde); kenar boşluğu dağıtımda zaten bu kenardan düşülür.
 */
type DoorEdges = { l: EdgeInfo; r: EdgeInfo; b: EdgeInfo; t: EdgeInfo };
type HalfOverlay = DoorGroup['halfOverlay'];
/** Kenar panelinin kalınlığı kapak tarafından örtülüyor mu (dış kapak + panel kapak düzleminin gerisinde)? */
const edgeCovered = (x: EdgeInfo, side: 1 | -1, placement: DoorGroup['placement'], P: number) =>
  x.front != null && placement === 'outer' && (side > 0 ? x.front <= P + TOL : x.front >= P - TOL);
function rectAtDepth(e: DoorEdges, side: 1 | -1, placement: DoorGroup['placement'], P: number, half?: HalfOverlay): DoorRect {
  const pick = (x: EdgeInfo, h: boolean | undefined) => {
    if (!edgeCovered(x, side, placement, P)) return x.inner;
    return h ? (x.inner + x.outer) / 2 : x.outer;
  };
  return { u0: pick(e.l, half?.uMin), u1: pick(e.r, half?.uMax), v0: pick(e.b, half?.vMin), v1: pick(e.t, half?.vMax), front: P };
}
/**
 * DERİNLİK (Goker, Eki 2026: "kapak sınırındaki dikme geride olmasına rağmen öndeki seçeneği de sunuyor, buna
 * gerek yok"): bir dikdörtgenin kapak düzlemi, kenar panellerinin EN GERİDEKİ ön yüzüdür — kapağı sınırlayan
 * geride bir dikme/raf varsa kapak ona göre yerleşir (outer: öndeki yan panelin içinde, geridekini örter);
 * öndeki paneller yalnız kendi aralarındaki (daha büyük) dikdörtgenin derinliğini verir. Panel yoksa gövde yüzü.
 */
function depthOptions(e: EdgeInfo[], side: 1 | -1, bodyFront: number): Array<{ ref: DoorBoundRef; front: number }> {
  let best: { ref: DoorBoundRef; front: number } | null = null;
  for (const x of e) {
    if (x.front == null) continue;
    if (!best || side * (x.front - best.front) < 0) best = { ref: x.ref, front: x.front };
  }
  return [best ?? { ref: { body: true }, front: bodyFront }];
}

/**
 * KAPAK ADAYLARI (Goker: "tıkladığım yerde kapak sınırı nerelerde varsa büyükten küçüğe alternatifleri göstersin;
 * içerdeki panel varsa önce dışarıdakiler, sonra içerdeki"; kenar panelleri farklı
 * derinlikteyse düzlem en geridekinin önü — bkz. depthOptions).
 * Dört yanda seçenek = tıklanan noktanın o tarafında kalan sınır panelleri (yoksa gövde kenarı). Her kombinasyon bir
 * dikdörtgen; seçilen panel dikdörtgenin çapraz açıklığıyla örtüşmeli. Sıra: alan büyükten küçüğe.
 */
export function doorCandidatesAt(parent: Shape, axis: 0 | 1 | 2, side: 1 | -1, click: Vec3, shapes?: Shape[], vfs?: VirtualFace[]): DoorPick[] {
  const body = bodyLocalBox(parent);
  if (!body) return [];
  const { u, v } = doorPlaneAxes(axis);
  const bounds = collectDoorBoundPanels(parent, shapes, vfs);
  const cu = click[u], cv = click[v];
  const frontOf = (b: CavityBox) => (side > 0 ? b.max[axis] : b.min[axis]);
  const bodyFront = side > 0 ? body.max[axis] : body.min[axis];
  const bodyOpt = (edge: number, cross: [number, number]): SideOpt => ({ ref: { body: true }, inner: edge, outer: edge, cross, front: null, name: 'Body' });
  // Bir yanda seçenekler = tıklanan noktanın o tarafında kalan sınır panelleri (dıştan içe birden çok olabilir:
  // yan panel + dikme → "önce dışarıdaki, sonra içerdeki"). GÖVDE KENARI da seçenektir — o yanda hiç sınır paneli yoksa,
  // ya da varsa ama hiçbiri gövde kenarına dayanmıyorsa (yalnız iç dikme/raf işaretli; Goker, Eki 2026: "dikmede kapak
  // sınırı varken yine de bütün kapağı seçebilmeliyim") — böylece dikmeye kadar olan kapakla birlikte BÜTÜN kapak da aday olur.
  const optsFor = (ax: 0 | 1 | 2, cx: 0 | 1 | 2, c: number, minSide: boolean): SideOpt[] => {
    const out: SideOpt[] = [];
    const edge = minSide ? body.min[ax] : body.max[ax];
    for (const bp of bounds) {
      const b = bp.box;
      const onSide = minSide ? b.max[ax] <= c + TOL : b.min[ax] >= c - TOL;
      if (!onSide) continue;
      out.push({ ref: { vfId: bp.vfId }, inner: minSide ? b.max[ax] : b.min[ax], outer: minSide ? b.min[ax] : b.max[ax], cross: [b.min[cx], b.max[cx]], front: frontOf(b), name: bp.name });
    }
    if (!out.some(o => Math.abs(o.outer - edge) <= TOL)) out.push(bodyOpt(edge, [body.min[cx], body.max[cx]]));
    return out;
  };
  const L = optsFor(u, v, cu, true), R = optsFor(u, v, cu, false), B = optsFor(v, u, cv, true), T = optsFor(v, u, cv, false);
  const overlaps = (cross: [number, number], a0: number, a1: number) => Math.min(cross[1], a1) - Math.max(cross[0], a0) > TOL;
  // AÇILI sınır panelleri: aday alanı tıklanan noktanın tarafına kırpılır (rectByCuts) — panelin üstüne de altına da kapak atılabilir.
  const cuts = collectDoorCuts(parent, shapes, vfs);
  const at: [number, number] = [cu, cv];
  const shrink = (placement: DoorGroup['placement'], r: DoorRect) => rectByCuts({ axis, side, placement, thickness: DOOR_THICKNESS, gap: DOOR_GAP }, r, cuts, at);
  const seen = new Set<string>();
  const out: DoorPick[] = [];
  for (const l of L) for (const r of R) for (const b of B) for (const t of T) {
    const between: DoorRect = { u0: l.inner, u1: r.inner, v0: b.inner, v1: t.inner, front: 0 };
    if (between.u1 - between.u0 < MIN_DOOR_SPAN || between.v1 - between.v0 < MIN_DOOR_SPAN) continue;
    // Seçilen panel, dikdörtgenin çapraz açıklığında olmalı (kısa dikme üstündeki kapağı sınırlamaz).
    if (!overlaps(l.cross, between.v0, between.v1) || !overlaps(r.cross, between.v0, between.v1)) continue;
    if (!overlaps(b.cross, between.u0, between.u1) || !overlaps(t.cross, between.u0, between.u1)) continue;
    const key = rectKey(between);
    if (seen.has(key)) continue;
    seen.add(key);
    const edges = { l, r, b, t };
    const depths = depthOptions([l, r, b, t], side, bodyFront);
    const boundsRef: DoorBounds = { uMin: l.ref, uMax: r.ref, vMin: b.ref, vMax: t.ref };
    const panelN = [l, r, b, t].filter(o => o.front != null).length;
    depths.forEach((d, di) => {
      const inner = shrink('inner', rectAtDepth(edges, side, 'inner', d.front)), outer = shrink('outer', rectAtDepth(edges, side, 'outer', d.front));
      out.push({
        key: `${axis}${side > 0 ? '+' : '-'}:${key}@${Math.round(d.front)}`, axis, side, bounds: boundsRef,
        inner, outer, at,
        area: (inner.u1 - inner.u0) * (inner.v1 - inner.v0), boundPanelCount: panelN,
        depth: d.ref, depthIndex: di, depthCount: depths.length,
      });
    });
  }
  out.sort((a, b) => b.area - a.area || a.boundPanelCount - b.boundPanelCount || side * (b.inner.front - a.inner.front));
  if (out.length) console.log('[YAGO][KAPAK] adaylar:', out.length, 'düzlem=', `${'XYZ'[axis]}${side > 0 ? '+' : '−'}`, 'sınırPanelN=', bounds.length,
    out.map(c => `${Math.round(c.inner.u1 - c.inner.u0)}x${Math.round(c.inner.v1 - c.inner.v0)}@${Math.round(c.inner.front)}`).join(' > '));
  return out;
}

// ── ÇÖZÜM (BÖLME AĞACI) ─────────────────────────────────────────────────────

export interface DoorMemberRect {
  u0: number; u1: number; v0: number; v1: number;
  /** Yaprak düğümün id'si + tipi; kanat sırası (0 | 1) ve yapraktaki kanat sayısı (1 | 2). */
  leafId: string; type: DoorType; leaf: number; leafCount: number;
  /** AÇILI REFERANS kesimi: dönmüş sınır panelleriyle kırpılmış (u,v) çokgeni (kesim yoksa yok — dikdörtgen). */
  poly?: Array<{ x: number; y: number }>;
}
/** Çözülmüş ağaç: her düğüm kendi alanını (u0..u1, v0..v1) taşır; split düğümünün sizes'ı dağıtılmış, yaprağın kanatları çözülmüş. */
export type DoorNodeSolved =
  | { id: string; kind: 'leaf'; type: DoorType; leafSplit?: DoorLeafSplit; u0: number; u1: number; v0: number; v1: number; depth: number }
  | { id: string; kind: 'split'; axis: 'u' | 'v'; sizes: GapSpec[]; gaps: number[]; children: DoorNodeSolved[]; targetSize?: number; refs?: Record<number, DoorJointRef>; u0: number; u1: number; v0: number; v1: number; depth: number };
export interface DoorSolution { rect: DoorRect; tree: DoorNode; solved: DoorNodeSolved; members: DoorMemberRect[] }
/** DERZ HEDEFLERİ: `${splitId}:${k}` → bağlı derzin MERKEZİ (kapak düzlemi koordinatı, bölmenin ekseninde). */
export type DoorJointTargets = Map<string, number>;
const jointKey = (splitId: string, k: number) => `${splitId}:${k}`;
/** Ağacı çözmek için gereken grup alanları (grup ya da çözümle güncellenmiş kopyası). */
export type DoorLayout = Pick<DoorGroup, 'rect' | 'tree' | 'edgeGaps' | 'gap'>;

export const isLeafNode = (n: DoorNode | DoorNodeSolved): n is Extract<typeof n, { kind: 'leaf' }> => n.kind === 'leaf';
export const makeDoorLeaf = (type: DoorType, leafSplit?: DoorLeafSplit): DoorNode => ({ id: genId('dl'), kind: 'leaf', type, ...(leafSplit ? { leafSplit } : {}) });
/** Kenar boşlukları: eksik/bozuksa varsayılan boşlukla tamamlanır. */
export function edgeGapsOf(g: Pick<DoorGroup, 'edgeGaps' | 'gap'>): DoorEdgeGaps {
  const ok = (x: unknown): x is number => Number.isFinite(x) && (x as number) >= 0;
  const e = g.edgeGaps;
  return { uMin: ok(e?.uMin) ? e.uMin : g.gap, uMax: ok(e?.uMax) ? e.uMax : g.gap, vMin: ok(e?.vMin) ? e.vMin : g.gap, vMax: ok(e?.vMax) ? e.vMax : g.gap };
}
/** DFS yaprakları (sıra = üye sırası, double/fold hariç). */
export function doorLeaves(n: DoorNode): Array<Extract<DoorNode, { kind: 'leaf' }>> { return n.kind === 'leaf' ? [n] : n.children.flatMap(doorLeaves); }
export function doorLeafCount(g: Pick<DoorGroup, 'tree'>): number { return doorLeaves(g.tree).length; }
/** Toplam üye (kanat) sayısı: tek kanatlı yaprak 1, double/fold 2. */
export const doorMemberCount = (g: Pick<DoorGroup, 'tree'>) => doorLeaves(g.tree).reduce((a, l) => a + (doorLeafAxis(l.type) ? 2 : 1), 0);
export function findDoorNode(n: DoorNode, id: string): DoorNode | null { if (n.id === id) return n; if (n.kind === 'split') for (const c of n.children) { const h = findDoorNode(c, id); if (h) return h; } return null; }
export function findDoorParent(n: DoorNode, id: string): Extract<DoorNode, { kind: 'split' }> | null {
  if (n.kind !== 'split') return null;
  if (n.children.some(c => c.id === id)) return n;
  for (const c of n.children) { const h = findDoorParent(c, id); if (h) return h; }
  return null;
}
/** Ağaçta bir düğümü değiştirir (saf — yeni ağaç döner). */
export function replaceDoorNode(n: DoorNode, id: string, repl: (old: DoorNode) => DoorNode): DoorNode {
  if (n.id === id) return repl(n);
  if (n.kind === 'leaf') return n;
  return { ...n, children: n.children.map(c => replaceDoorNode(c, id, repl)) };
}
/**
 * Alt ağacın YENİ KİMLİKLİ kopyası (diğer eksende sarma: her yeni parça mevcut bölmenin aynısını alır). Ölçüler, kilitler,
 * aralar, tipler, kanat bölmeleri ve spacing hedefi kopyalanır (aynı eksen uzunluğu — hepsi geçerli kalır); derz bağları
 * (refs: derz bir levhayı izler) de kopyalanır — levha her iki parçayı da kesiyorsa iki derz de onu izler, kesmiyorsa
 * doorJointTargets o bağı etkisiz bırakır.
 */
export function cloneDoorNode(n: DoorNode): DoorNode {
  if (n.kind === 'leaf') return { ...n, id: genId('dl'), ...(n.leafSplit ? { leafSplit: { gap: n.leafSplit.gap, leaves: n.leafSplit.leaves.map(l => ({ ...l })) } } : {}) };
  return { ...n, id: genId('ds'), sizes: n.sizes.map(s => ({ ...s })), gaps: [...n.gaps], children: n.children.map(cloneDoorNode), ...(n.refs ? { refs: { ...n.refs } } : {}) };
}
export function findSolvedNode(n: DoorNodeSolved, id: string): DoorNodeSolved | null { if (n.id === id) return n; if (n.kind === 'split') for (const c of n.children) { const h = findSolvedNode(c, id); if (h) return h; } return null; }

/**
 * DAĞITIM KURALI (Goker: "girilen boşluk kapağı kısaltmamalı; boşluktan kalan ölçüyü her zaman ilk başta EŞİT dağıt"):
 * kilitli ve elle girilmiş ölçüler korunur; aralardan kalan ölçü diğerlerine EŞİT dağılır (boşluk değişse de, iç/dış
 * değişse de, gövde boyutlansa da). Hepsi girilmişse oransal. 0,1 mm yuvarlama artığı son serbest ölçüye yazılır.
 */
function distributeSizes(specs: GapSpec[], L: number, gaps: number[]): GapSpec[] {
  const out = redistributeForThickness(specs, L, gaps.length, gaps);
  const resid = round1(L - gaps.reduce((a, g) => a + g, 0) - out.reduce((a, g) => a + g.value, 0));
  if (Math.abs(resid) >= 0.05 && Math.abs(resid) < 1) {
    for (let i = out.length - 1; i >= 0; i--) if (!out[i].locked && !out[i].edited) { out[i] = { ...out[i], value: round1(out[i].value + resid) }; break; }
  }
  return out;
}
/** Split düğümünün n−1 arası: kayıtlı dizi boyu tutmuyorsa varsayılan boşlukla (ilk ara değeri korunarak). */
const splitGapsOf = (n: Extract<DoorNode, { kind: 'split' }>, gap: number) => {
  const m = n.children.length - 1;
  if (n.gaps.length === m && n.gaps.every(x => Number.isFinite(x) && x >= 0)) return n.gaps.slice();
  return Array.from({ length: m }, (_, i) => (Number.isFinite(n.gaps[i]) && n.gaps[i] >= 0 ? n.gaps[i] : n.gaps.length ? n.gaps[0] : gap));
};

/**
 * BAĞLI DERZLERLE DAĞITIM (Goker: "dikmenin arası değişince kapak kendini ona göre güncellesin"): `along[k]` = k. derzin
 * merkezinin bölme başlangıcından uzaklığı (u: soldan, v: üstten) — yalnız bağlı derzler. Bağlı derzler alanı PARÇALARA
 * böler: iki bağlı derz arasındaki çocuklar o parçanın uzunluğunu kendi aralarında raf kuralıyla paylaşır (tek çocuk → parça
 * uzunluğu; girilen/kilitli ölçü derzi DEĞİŞTİREMEZ — bağ kazanır). Sonuçta tüm ölçüler girilmiş (edited) yazılır → bağsız
 * çözüm (şema, pill, fallback) aynı değerleri verir (oransal yeniden ölçek = birim). Hedefler sırasız / parçalar ≤ 0 ise
 * bağ yok sayılır (uyarı) ve düz dağıtım yapılır.
 */
function distributeSizesWithJoints(specs: GapSpec[], L: number, gaps: number[], along: Map<number, number>, splitId: string): GapSpec[] {
  const n = gaps.length + 1;
  const base = Array.from({ length: n }, (_, i) => specs[i] ?? { value: 0, locked: false });
  const ks = [...along.keys()].filter(k => k >= 0 && k < n - 1).sort((a, b) => a - b);
  if (!ks.length) return distributeSizes(specs, L, gaps);
  // Parça sınırları: [start_i, end_i] = çocuk aralığının başı/sonu (derz merkezi ± yarım derz).
  const bounds: Array<{ from: number; to: number; a: number; b: number }> = [];
  let from = 0, a = 0;
  for (const k of ks) {
    const c = along.get(k)!, g = gaps[k] ?? 0;
    bounds.push({ from, to: k, a, b: c - g / 2 });
    from = k + 1; a = c + g / 2;
  }
  bounds.push({ from, to: n - 1, a, b: L });
  for (const s of bounds) {
    const inner = gaps.slice(s.from, s.to).reduce((x, y) => x + y, 0);
    if (!(s.b - s.a - inner >= (s.to - s.from + 1) * 1)) {   // her çocuğa en az 1 mm
      console.warn('[YAGO][KAPAK-BAĞ] bağlı derz(ler) bölmeye sığmıyor, bağ bu çözümde yok sayıldı:', splitId, ks.map(k => `${k}@${along.get(k)!.toFixed(1)}`).join(' '), 'L=', L.toFixed(1));
      return distributeSizes(specs, L, gaps);
    }
  }
  const out: GapSpec[] = [];
  for (const s of bounds) {
    const segL = s.b - s.a;
    if (s.to === s.from) { out.push({ ...base[s.from], value: round1(segL), edited: true }); continue; }
    for (const sz of distributeSizes(base.slice(s.from, s.to + 1), segL, gaps.slice(s.from, s.to))) out.push({ ...sz, edited: true });
  }
  return out;
}

/**
 * AĞAÇ ÇÖZÜMÜ: kök alanı = dikdörtgen − kenar boşlukları; her split kendi alanını çocuklarına raf kuralıyla dağıtır
 * (u: soldan sağa, v: ÜSTTEN aşağı); double/fold yaprak kanatlarını kendi alanında çözer. Toplam her zaman üst alan.
 * `targets` (doorJointTargets): bağlı derzlerin merkezleri — varsa o bölmenin ölçüleri derzlerden türetilir.
 */
function solveNode(n: DoorNode, u0: number, u1: number, v0: number, v1: number, gap: number, depth: number, targets?: DoorJointTargets): DoorNodeSolved {
  if (n.kind === 'leaf') {
    const ax = doorLeafAxis(n.type);
    if (!ax) return { ...n, leafSplit: undefined, u0, u1, v0, v1, depth };
    const lg = Number.isFinite(n.leafSplit?.gap) && n.leafSplit!.gap >= 0 ? n.leafSplit!.gap : gap;
    const leaves = redistributeForThickness(n.leafSplit?.leaves ?? [], ax === 'u' ? u1 - u0 : v1 - v0, 1, [lg]);
    return { ...n, leafSplit: { gap: lg, leaves }, u0, u1, v0, v1, depth };
  }
  const gaps = splitGapsOf(n, gap);
  const L = n.axis === 'u' ? u1 - u0 : v1 - v0;
  // Bağlı derzler: hedef merkez → bölme başlangıcından uzaklık (u: u0'dan sağa, v: v1'den aşağı).
  const along = new Map<number, number>();
  if (targets && n.refs) for (const k of Object.keys(n.refs)) { const t = targets.get(jointKey(n.id, +k)); if (t != null) along.set(+k, n.axis === 'u' ? t - u0 : v1 - t); }
  const sizes = along.size ? distributeSizesWithJoints(n.sizes, L, gaps, along, n.id) : distributeSizes(n.sizes, L, gaps);
  const children: DoorNodeSolved[] = [];
  let pos = n.axis === 'u' ? u0 : v1;
  n.children.forEach((c, i) => {
    const w = Math.max(0, sizes[i]?.value ?? 0);
    if (n.axis === 'u') { children.push(solveNode(c, pos, pos + w, v0, v1, gap, depth + 1, targets)); pos += w + (gaps[i] ?? 0); }
    else { children.push(solveNode(c, u0, u1, pos - w, pos, gap, depth + 1, targets)); pos -= w + (gaps[i] ?? 0); }
  });
  return { ...n, sizes, gaps, children, u0, u1, v0, v1, depth };
}
export function solveDoorTree(g: DoorLayout, rect: DoorRect = g.rect, targets?: DoorJointTargets): DoorNodeSolved {
  const e = edgeGapsOf(g);
  return solveNode(g.tree, rect.u0 + e.uMin, rect.u1 - e.uMax, rect.v0 + e.vMin, rect.v1 - e.vMax, g.gap, 0, targets);
}
/** Çözülmüş ağacı kayıt biçimine indirger (sizes/gaps/leafSplit güncel, alanlar atılır; targetSize ve derz bağları korunur). */
export function solvedToTree(n: DoorNodeSolved): DoorNode {
  if (n.kind === 'leaf') return { id: n.id, kind: 'leaf', type: n.type, ...(n.leafSplit ? { leafSplit: n.leafSplit } : {}) };
  return {
    id: n.id, kind: 'split', axis: n.axis, sizes: n.sizes, gaps: n.gaps, children: n.children.map(solvedToTree),
    ...(n.targetSize ? { targetSize: n.targetSize } : {}), ...(n.refs && Object.keys(n.refs).length ? { refs: n.refs } : {}),
  };
}
/** Ağaçtaki derz bağları (DFS): split id + derz sırası + bağ. */
export function doorJointRefs(n: DoorNode): Array<{ splitId: string; k: number; ref: DoorJointRef }> {
  if (n.kind === 'leaf') return [];
  const own = Object.entries(n.refs ?? {}).map(([k, ref]) => ({ splitId: n.id, k: +k, ref }));
  return [...own, ...n.children.flatMap(doorJointRefs)];
}
/**
 * DERZ HEDEFLERİ: bağlı her derz için levhanın GÜNCEL gövde-yerel kutusundan derz merkezi — 'center' → levhanın ortası,
 * 'min' → levhanın max yüzü + yarım derz (levha min taraftaki kapağın arkasında), 'max' → levhanın min yüzü − yarım derz.
 * Levha yoksa (silinmiş), dönmüşse ya da bölmenin ekseninde ince değilse (≤ THIN_PANEL) o derz hedefsiz kalır (düz kural).
 */
export function doorJointTargets(group: DoorLayout & Pick<DoorGroup, 'axis'>, parent: Shape, shapes: Shape[]): DoorJointTargets {
  const out: DoorJointTargets = new Map();
  const refs = doorJointRefs(group.tree);
  if (!refs.length) return out;
  const { u, v } = doorPlaneAxes(group.axis);
  const bonded = new Set(useAppStore.getState().panelGroups.filter(pg => pg.doorBond).flatMap(pg => pg.memberVfIds));   // levha kapağı izliyorsa kapak levhayı izleyemez
  for (const { splitId, k, ref } of refs) {
    const node = findDoorNode(group.tree, splitId);
    if (!node || node.kind !== 'split' || k < 0 || k >= node.children.length - 1) continue;
    if (bonded.has(ref.vfId)) continue;
    const p = panelOfVf(ref.vfId, shapes);
    if (!p || (p.parameters as any)?.parentShapeId !== parent.id || panelHasRotation(p)) continue;
    const box = panelLocalBox(p, parent);
    if (!box) continue;
    const ax = node.axis === 'u' ? u : v;
    const a0 = box.min[ax], a1 = box.max[ax];
    if (!(a1 - a0 > 0) || a1 - a0 > THIN_PANEL) continue;
    const g = splitGapsOf(node, group.gap)[k] ?? group.gap;
    out.set(jointKey(splitId, k), ref.align === 'center' ? (a0 + a1) / 2 : ref.align === 'min' ? a1 + g / 2 : a0 - g / 2);
  }
  return out;
}
/**
 * Üye dikdörtgenleri: ağacın DFS yaprak sırası; double/fold yaprak iki kanada bölünür (double: sol→sağ, fold: üst→alt).
 * Sıra = üye indeksi = VF.doorIndex.
 */
export function doorMemberRects(solved: DoorNodeSolved): DoorMemberRect[] {
  const out: DoorMemberRect[] = [];
  const walk = (n: DoorNodeSolved) => {
    if (n.kind === 'split') { n.children.forEach(walk); return; }
    const ax = doorLeafAxis(n.type), split = n.leafSplit;
    const base = { leafId: n.id, type: n.type };
    if (ax && split && split.leaves.length === 2) {
      const [a, b] = split.leaves.map(l => Math.max(0, l.value));
      if (ax === 'u') {
        out.push({ ...base, leaf: 0, leafCount: 2, u0: n.u0, u1: n.u0 + a, v0: n.v0, v1: n.v1 });
        out.push({ ...base, leaf: 1, leafCount: 2, u0: n.u0 + a + split.gap, u1: n.u0 + a + split.gap + b, v0: n.v0, v1: n.v1 });
      } else {
        out.push({ ...base, leaf: 0, leafCount: 2, u0: n.u0, u1: n.u1, v0: n.v1 - a, v1: n.v1 });
        out.push({ ...base, leaf: 1, leafCount: 2, u0: n.u0, u1: n.u1, v0: n.v1 - a - split.gap - b, v1: n.v1 - a - split.gap });
      }
    } else out.push({ ...base, leaf: 0, leafCount: 1, u0: n.u0, u1: n.u1, v0: n.v0, v1: n.v1 });
  };
  walk(solved);
  return out;
}
/** Gruptan (kayıtlı dikdörtgenle) üyeler — şema ve satır ikonları için. */
export const doorMembersOf = (g: DoorLayout) => doorMemberRects(solveDoorTree(g));

/** Sınır referansının kenar bilgisi: panel kutusu (VF → panel) ya da gövde kenarı; panel bulunamazsa gövde. */
function boundEdgeInfo(ref: DoorBoundRef, parent: Shape, shapes: Shape[], body: CavityBox, ax: 0 | 1 | 2, minSide: boolean, axis: 0 | 1 | 2, side: 1 | -1): EdgeInfo {
  if (ref.vfId) {
    const p = panelOfVf(ref.vfId, shapes);
    const box = p && (p.parameters as any)?.parentShapeId === parent.id ? panelLocalBox(p, parent) : null;
    if (box) return { ref, inner: minSide ? box.max[ax] : box.min[ax], outer: minSide ? box.min[ax] : box.max[ax], front: side > 0 ? box.max[axis] : box.min[axis] };
    console.warn('[YAGO][KAPAK] sınır paneli bulunamadı, gövde kenarı kullanıldı:', ref.vfId);
  }
  const e = minSide ? body.min[ax] : body.max[ax];
  return { ref: { body: true }, inner: e, outer: e, front: null };
}

/** Grubun dört kenarı (sınır panelleri / gövde) + kapak düzlemi P — solveDoorGroup ve yarım-binme uygunluğu buradan. */
function solveDoorEdges(group: DoorGroup, parent: Shape, shapes: Shape[]): { edges: DoorEdges; P: number } | null {
  const body = bodyLocalBox(parent);
  if (!body) return null;
  const { u, v } = doorPlaneAxes(group.axis);
  const ei = (ref: DoorBoundRef, ax: 0 | 1 | 2, minSide: boolean) => boundEdgeInfo(ref, parent, shapes, body, ax, minSide, group.axis, group.side);
  const edges: DoorEdges = { l: ei(group.bounds.uMin, u, true), r: ei(group.bounds.uMax, u, false), b: ei(group.bounds.vMin, v, true), t: ei(group.bounds.vMax, v, false) };
  const bodyFront = group.side > 0 ? body.max[group.axis] : body.min[group.axis];
  // DERİNLİK: kayıtlı referans panelin ön yüzü (taşınsa/boyutlansa izler); yoksa en gerideki sınır panelinin önü.
  const fronts = [edges.l, edges.r, edges.b, edges.t].map(x => x.front).filter((x): x is number => x != null);
  const sgn = group.side;
  let P = !fronts.length ? bodyFront : (sgn > 0 ? Math.min(...fronts) : Math.max(...fronts));   // en gerideki sınır paneli
  if (group.depthRef?.body) P = bodyFront;
  else if (group.depthRef?.vfId) {
    const hit = [edges.l, edges.r, edges.b, edges.t].find(x => x.ref.vfId === group.depthRef!.vfId && x.front != null);
    if (hit) P = hit.front!;
    else console.warn('[YAGO][KAPAK] derinlik referansı bulunamadı, varsayılan derinlik:', group.id, group.depthRef.vfId);
  }
  return { edges, P };
}

export type DoorEdgeKey = keyof DoorBounds;
/**
 * YARIM BİNME UYGUNLUĞU (şemadaki checkbox'lar): kenarın sınır paneli var ve kapak onun kalınlığını örtüyor
 * (dış kapak + panel kapağın gerisinde) → o kenarda yarım binme anlamlı. Gövde kenarı / iç kapak / öndeki panel: hayır.
 */
export function doorHalfOverlayEdges(group: DoorGroup, parent: Shape, shapes: Shape[], cuts: DoorCut[] = []): Record<DoorEdgeKey, boolean> {
  const s = solveDoorEdges(group, parent, shapes);
  if (!s) return { uMin: false, uMax: false, vMin: false, vMax: false };
  const c = (x: EdgeInfo) => edgeCovered(x, group.side, group.placement, s.P);
  const out = { uMin: c(s.edges.l), uMax: c(s.edges.r), vMin: c(s.edges.b), vMax: c(s.edges.t) };
  // AÇILI sınır paneli dikdörtgen kenarı değildir (gövde kenarı görünür) ama kapağı o kenardan keser: örtüyorsa uygun.
  const rect = rectAtDepth(s.edges, group.side, group.placement, s.P, group.halfOverlay);
  const { u, v } = doorPlaneAxes(group.axis);
  for (const k of cuts) {
    if (Math.min(k.box.max[u], rect.u1) - Math.max(k.box.min[u], rect.u0) < TOL || Math.min(k.box.max[v], rect.v1) - Math.max(k.box.min[v], rect.v0) < TOL) continue;
    const ce = cutEdgeOf(k, (rect.u0 + rect.u1) / 2, (rect.v0 + rect.v1) / 2, group.axis, rect.front);
    if (ce && cutCoverFar(k, group.axis, group.side, group.placement, rect.front)) out[ce.edge] = true;
  }
  return out;
}

/** Grubu güncel gövde + sınır panelleriyle çözer (saf). Dikdörtgen bozuksa önceki korunur. */
export function solveDoorGroup(group: DoorGroup, parent: Shape, shapes: Shape[]): DoorSolution | null {
  const s = solveDoorEdges(group, parent, shapes);
  if (!s) return null;
  const { edges, P } = s;
  const cutsAll = collectDoorCuts(parent, shapes);
  let rect: DoorRect = rectByCuts(group, rectAtDepth(edges, group.side, group.placement, P, group.halfOverlay), cutsAll, group.anchor);
  if (rect.u1 - rect.u0 < MIN_DOOR_SPAN || rect.v1 - rect.v0 < MIN_DOOR_SPAN) {
    console.warn('[YAGO][KAPAK] dikdörtgen bozuk/çok küçük, önceki korunuyor:', group.id, fmtRect(rect));
    rect = { ...group.rect };
  }
  // AĞAÇ: kök alanı dikdörtgen − kenar boşlukları; her bölme kendi alanını dağıtır (toplam = üst alan). Bağlı derzler
  // levhaların GÜNCEL kutularından (kapak dikmeyi izler).
  const solved = solveDoorTree(group, rect, doorJointTargets(group, parent, shapes));
  const members = applyDoorCuts(group, rect, doorMemberRects(solved), cutsAll);
  return { rect, tree: solvedToTree(solved), solved, members };
}

/** Üyeleri dönmüş sınır panelleriyle kırpar (AÇILI REFERANS); her rebuild'de güncel panellerden yeniden. */
export function applyDoorCuts(group: Pick<DoorGroup, 'axis' | 'side' | 'placement' | 'thickness' | 'gap' | 'id' | 'halfOverlay' | 'anchor'>, rect: DoorRect, members: DoorMemberRect[], cuts: DoorCut[], silent = false): DoorMemberRect[] {
  if (!cuts.length) return members;
  let n = 0;
  const out = members.map(m => {
    const poly = clipMemberByCuts(m, cuts, group.axis, group.side, group.placement, group.thickness, rect.front, group.gap, group.halfOverlay, group.anchor);
    if (poly) n++;
    return poly ? { ...m, poly } : m;
  });
  if (n && !silent && group.id !== PREVIEW_ID) console.log('[YAGO][KAPAK-AÇILI]', group.id, 'dönmüş sınır paneli kesti:', cuts.map(c => c.name).join('/'), 'kesilen üye=', n, '/', members.length);
  return out;
}

/**
 * AÇILI SINIR PANELİNDE KAPAK ALANI (Goker, Eki 2026: "görseldeki panel kapak sınırı ama kapak yerleştirmek için seçimde yalnız
 * açılı panelin altı görünüyor"): dönmüş sınır paneli dikdörtgenin kenarı değildir; kapak alanı, tıklanan nokta (çıpa) hangi
 * taraftaysa O TARAFA kırpılır ve dikdörtgen kırpılmış çokgenin kutusuna daraltılır (bölme/boşluklar bu alanda çalışır; eğik
 * kenar applyDoorCuts ile çokgen olarak kalır). Eskiden tutulan taraf dikdörtgenin merkeziyle seçiliyordu → ortadan geçen eğik
 * panelde hep aynı taraf (alt) çıkıyordu, panelin üstüne kapak atılamıyordu. Çıpa yoksa (eski kayıt) dikdörtgen değişmez.
 */
export function rectByCuts(group: Pick<DoorGroup, 'axis' | 'side' | 'placement' | 'thickness' | 'gap' | 'halfOverlay'>, rect: DoorRect, cuts: DoorCut[], anchor?: [number, number]): DoorRect {
  if (!anchor || !cuts.length) return rect;
  const poly = clipMemberByCuts(rect, cuts, group.axis, group.side, group.placement, group.thickness, rect.front, group.gap, group.halfOverlay, anchor);
  if (!poly || poly.length < 3) return rect;
  const xs = poly.map(q => q.x), ys = poly.map(q => q.y);
  const out: DoorRect = { u0: Math.min(...xs), u1: Math.max(...xs), v0: Math.min(...ys), v1: Math.max(...ys), front: rect.front };
  if (out.u1 - out.u0 < MIN_DOOR_SPAN || out.v1 - out.v0 < MIN_DOOR_SPAN) return rect;
  return out;
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
  // AÇILI REFERANS: kırpılmış çokgen varsa VF o çokgendir (motor çokgeni olduğu gibi levhaya çevirir).
  const vertices = m.poly ? m.poly.map(q => mk(q.x, q.y)) : [mk(m.u0, m.v0), mk(m.u1, m.v0), mk(m.u1, m.v1), mk(m.u0, m.v1)];
  const c = m.poly ? m.poly.reduce((a, q) => ({ x: a.x + q.x / m.poly!.length, y: a.y + q.y / m.poly!.length }), { x: 0, y: 0 }) : { x: (m.u0 + m.u1) / 2, y: (m.v0 + m.v1) / 2 };
  return { normal, vertices, center: mk(c.x, c.y) };
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

// ── ŞEMADAKİ SINIR PANELLERİ + DERZ HİZALAMASI ───────────────────────────────

/** Kapak ağacındaki DERZ: aynı eksendeki iki kapak arası boşluk [p0, p1], çapraz eksende [c0, c1]. */
export interface DoorJoint { splitId: string; k: number; axis: 'u' | 'v'; p0: number; p1: number; c0: number; c1: number }
export function doorJoints(solved: DoorNodeSolved): DoorJoint[] {
  const out: DoorJoint[] = [];
  const walk = (n: DoorNodeSolved) => {
    if (n.kind !== 'split') return;
    let p = n.axis === 'u' ? n.u0 : n.v1;
    n.children.forEach((c, i) => {
      const w = Math.max(0, n.sizes[i]?.value ?? 0), g = n.gaps[i] ?? 0;
      if (n.axis === 'u') { p += w; if (i < n.children.length - 1) { out.push({ splitId: n.id, k: i, axis: 'u', p0: p, p1: p + g, c0: n.v0, c1: n.v1 }); p += g; } }
      else { p -= w; if (i < n.children.length - 1) { out.push({ splitId: n.id, k: i, axis: 'v', p0: p - g, p1: p, c0: n.u0, c1: n.u1 }); p -= g; } }
      walk(c);
    });
  };
  walk(solved);
  return out;
}

/** Şemada çizilecek sınır levhası (kapak düzlemi koordinatlarında). */
export interface DoorNearPanel {
  vfId: string; panelId: string; name: string;
  /** 'u' = düşey levha (dikme / yan panel: u'da ince), 'v' = yatay levha (raf / üst / alt: v'de ince). */
  kind: 'u' | 'v';
  /** Kalınlık aralığı (kind ekseni) ve çapraz eksendeki uzunluk aralığı. */
  a0: number; a1: number; c0: number; c1: number;
  /** Kapak düzleminin GERİSİNDE mi (dış kapak örtebilir)? Değilse levha kapağın önünde durur, kapak yanında biter. */
  behind: boolean;
  /** Grup kenarı mı (bounds) — hangi kenar; kenar levhasında yarım binme geçerli, hizalama yok. */
  edge?: DoorEdgeKey;
  /** Raf/dikme üyesiyse: grubu + üye sırası (taşınabilir). */
  groupId?: string; memberIndex?: number;
  /** Yakınındaki derz (aynı eksen, çapraz örtüşen) — hizalama / bağ bununla. Levha bir derze BAĞLIYSA o derz. */
  joint?: DoorJoint;
  /**
   * Derz bağı: master 'panel' = DoorNode.refs (KAPAK derzi levhayı izler — panel ref); master 'door' = PanelGroup.doorBond
   * (LEVHA kapak derzini izler — kapak arayüzünden eklenen raf/dikme). Yoksa levha serbest.
   */
  ref?: { splitId: string; k: number; align: DoorAlign; master: 'panel' | 'door' };
}

/**
 * DIŞ kapakta şemada gösterilecek sınır levhaları (Goker: "iç kapakta ya da sınır panel yoksa kalınlığı gösterme; 2-3 mm
 * yaklaşıyorsa göster"): kapak-sınırı işaretli, dönmemiş, ince (≤ THIN_PANEL) levhalardan kapak dikdörtgenlerinden
 * birine boşluk + 3 mm içinde değen / örtüşenler; gerçek konum ve kalınlıkla. İç kapak → boş.
 * `allPanels=true` → kapak sınırı İŞARETSİZ ince düz levhalar da listelenir (yalnız "araya raf/dikme" modunun derz
 * parçalaması için: işaretsiz bir dikme de derzi keser, rafın ışını onun içine düşmemeli). Şema bantları işaretlilerle çizilir.
 */
export function doorNearPanels(group: DoorGroup, parent: Shape, shapes: Shape[], vfs: VirtualFace[], panelGroups: PanelGroup[], members?: DoorMemberRect[], allPanels = false): DoorNearPanel[] {
  if (group.placement !== 'outer') return [];
  const { u, v } = doorPlaneAxes(group.axis);
  const solved = solveDoorTree(group);
  const ms = members ?? doorMemberRects(solved);
  const joints = doorJoints(solved);
  const near = Math.max(group.gap, 0) + NEAR_EXTRA;
  const front = group.rect.front;
  const edgeOf = (vfId: string): DoorEdgeKey | undefined => (['uMin', 'uMax', 'vMin', 'vMax'] as DoorEdgeKey[]).find(k => group.bounds[k]?.vfId === vfId);
  const refs = doorJointRefs(group.tree);
  const out: DoorNearPanel[] = [];
  for (const bp of collectDoorBoundPanels(parent, shapes, vfs, !allPanels)) {
    const b = bp.box;
    const tu = b.max[u] - b.min[u], tv = b.max[v] - b.min[v];
    let kind: 'u' | 'v';
    if (tu <= THIN_PANEL && tu <= tv) kind = 'u'; else if (tv <= THIN_PANEL) kind = 'v'; else continue;
    const a0 = kind === 'u' ? b.min[u] : b.min[v], a1 = kind === 'u' ? b.max[u] : b.max[v];
    const c0 = kind === 'u' ? b.min[v] : b.min[u], c1 = kind === 'u' ? b.max[v] : b.max[u];
    // Yakınlık: bir kapak dikdörtgeninin çapraz aralığı örtüşmeli ve kalınlık ekseninde uzaklık ≤ boşluk + 3 mm (örtüşme dahil).
    const touching = ms.some(m => {
      const mc0 = kind === 'u' ? m.v0 : m.u0, mc1 = kind === 'u' ? m.v1 : m.u1;
      const ma0 = kind === 'u' ? m.u0 : m.v0, ma1 = kind === 'u' ? m.u1 : m.v1;
      if (Math.min(mc1, c1) - Math.max(mc0, c0) < TOL) return false;
      return Math.max(ma0, a0) - Math.min(ma1, a1) <= near;   // negatif = örtüşme
    });
    if (!touching) continue;
    const behind = group.side > 0 ? b.max[group.axis] <= front + TOL : b.min[group.axis] >= front - TOL;
    const vf = vfs.find(f => f.id === bp.vfId);
    const pg = vf?.groupId ? panelGroups.find(g => g.id === vf.groupId) : undefined;
    const memberIndex = pg ? (vf!.groupIndex ?? pg.memberVfIds.indexOf(vf!.id)) : undefined;
    const edge = edgeOf(bp.vfId);
    // Derz: levha bir derze BAĞLIYSA o derz; değilse aynı eksen, çapraz örtüşen, merkezleri yakın (en yakını). Kenar levhasında aranmaz.
    let joint: DoorJoint | undefined, ref: DoorNearPanel['ref'];
    if (!edge) {
      const bound = refs.find(r => r.ref.vfId === bp.vfId && joints.some(j => j.splitId === r.splitId && j.k === r.k && j.axis === kind));
      const bond = pg?.doorBond && pg.doorBond.doorGroupId === group.id && (pg.doorBond.member ?? 0) === memberIndex ? pg.doorBond : undefined;
      if (bound) { ref = { splitId: bound.splitId, k: bound.k, align: bound.ref.align, master: 'panel' }; joint = joints.find(j => j.splitId === bound.splitId && j.k === bound.k); }
      else if (bond && joints.some(j => j.splitId === bond.splitId && j.k === bond.k && j.axis === kind)) { ref = { splitId: bond.splitId, k: bond.k, align: bond.align, master: 'door' }; joint = joints.find(j => j.splitId === bond.splitId && j.k === bond.k); }
      else {
        const pc = (a0 + a1) / 2, t = a1 - a0;
        let best = Infinity;
        for (const j of joints) {
          if (j.axis !== kind || Math.min(j.c1, c1) - Math.max(j.c0, c0) < TOL) continue;
          const d = Math.abs((j.p0 + j.p1) / 2 - pc);
          if (d <= t / 2 + (j.p1 - j.p0) / 2 + JOINT_NEAR && d < best) { best = d; joint = j; }
        }
      }
    }
    out.push({ vfId: bp.vfId, panelId: bp.panelId, name: bp.name, kind, a0, a1, c0, c1, behind, edge, groupId: pg?.id, memberIndex, joint, ref });
  }
  return out;
}

/**
 * DERZ PARÇALARI (araya raf/dikme — Goker, Eki 2026: "dikmenin sağına ve soluna da raf"): `axis` eksenindeki her derz, onu kesen
 * ÇAPRAZ levhalarla (yatay derzi dikmeler, dikey derzi raflar; `obstacles` = doorNearPanels allPanels) parçalara bölünür; en az
 * `minSeg` mm'lik parçalar kalır. `free` = derze değen AYNI türde levhası olmayan parçalar (orada eklenebilir); `all` = tüm parçalar.
 * Şemadaki "+ Shelf / + Divider" rozetleri ve kapak kartının durum metni tek kaynaktan okur.
 */
export function doorJointParts(joints: DoorJoint[], obstacles: DoorNearPanel[], axis: 'u' | 'v', minSeg = 40): Array<{ joint: DoorJoint; all: Array<[number, number]>; free: Array<[number, number]> }> {
  return joints.filter(j => j.axis === axis).map(j => {
    const cutters = obstacles
      .filter(np => np.kind !== j.axis && Math.min(np.c1, j.p1) - Math.max(np.c0, j.p0) > -TOL && np.a1 > j.c0 + TOL && np.a0 < j.c1 - TOL)
      .map(np => [np.a0, np.a1] as [number, number]).sort((a, b) => a[0] - b[0]);
    const all: Array<[number, number]> = [];
    let s0 = j.c0;
    for (const [a0, a1] of cutters) { if (a0 - s0 >= minSeg) all.push([s0, a0]); s0 = Math.max(s0, a1); }
    if (j.c1 - s0 >= minSeg) all.push([s0, j.c1]);
    const free = all.filter(([c0, c1]) => { const mid = (c0 + c1) / 2; return !obstacles.some(np => np.kind === j.axis && Math.min(np.a1, j.p1) - Math.max(np.a0, j.p0) > -TOL && np.c0 - TOL <= mid && mid <= np.c1 + TOL); });
    return { joint: j, all, free };
  });
}

/** Hizalamanın istediği levha min koordinatı (kind ekseni): derz sabitken levhanın gideceği yer. */
export function alignedPanelMin(np: Pick<DoorNearPanel, 'a0' | 'a1' | 'joint'>, align: DoorAlign): number | null {
  if (!np.joint) return null;
  const t = np.a1 - np.a0, { p0, p1 } = np.joint;
  return align === 'min' ? p0 - t : align === 'max' ? p1 : (p0 + p1) / 2 - t / 2;
}

/**
 * KAPAK DERZİNE BAĞLI LEVHA (PanelGroup.doorBond → PanelGroupService.solveGroup): bağın derzi GÖVDE ekseninde —
 * `axis` = derzin kalınlık ekseni (gövde), [p0, p1] derz aralığı, [c0, c1] çapraz aralık (gövde ekseni `cross`),
 * `panelMin(t)` = `t` kalınlığındaki levhanın hizaya göre min koordinatı. Kapak grubu / bölme / derz yoksa null (bağ bayat).
 */
export function doorJointForBond(bond: DoorBond, parent: Shape, shapes: Shape[], doorGroups: DoorGroup[] = useAppStore.getState().doorGroups):
  { axis: 0 | 1 | 2; cross: 0 | 1 | 2; p0: number; p1: number; c0: number; c1: number; panelMin: (t: number) => number } | null {
  const dg = doorGroups.find(g => g.id === bond.doorGroupId);
  if (!dg || dg.shapeId !== parent.id) return null;
  const sol = solveDoorGroup(dg, parent, shapes);
  if (!sol) return null;
  const j = doorJoints(sol.solved).find(x => x.splitId === bond.splitId && x.k === bond.k);
  if (!j) return null;
  const { u, v } = doorPlaneAxes(dg.axis);
  const axis = j.axis === 'u' ? u : v, cross = j.axis === 'u' ? v : u;
  const panelMin = (t: number) => (bond.align === 'min' ? j.p0 - t : bond.align === 'max' ? j.p1 : (j.p0 + j.p1) / 2 - t / 2);
  return { axis, cross, p0: j.p0, p1: j.p1, c0: j.c0, c1: j.c1, panelMin };
}

/**
 * LEVHAYI DERZE GÖRE BİR KEZ TAŞI (Goker: "raf ve dikme hareket etsin, kapak değil"): raf/dikme ÜYESİ levhanın kendi
 * grubundaki boşluğu, levha `align` konumuna gelecek şekilde yazılır (facing'e göre işaret; applyGapEdit → diğer boşluklar
 * yeniden dağılır → "aralıkları revize et"). Taşınamıyorsa (üye değil, grubun dizilim ekseni levhanın kalınlık ekseni
 * değil, boşluk negatif, kilitli komşular kırpıyor) false — çağıran derzi levhaya götürür. Fark < 0,05 mm → true (yerinde).
 */
function movePanelToAlign(group: Pick<DoorGroup, 'id' | 'axis'>, np: DoorNearPanel, align: DoorAlign, panelGroups: PanelGroup[]): boolean {
  const want = alignedPanelMin(np, align);
  if (want == null) return false;
  const delta = want - np.a0;
  if (Math.abs(delta) < 0.05) return true;
  const pg = np.groupId ? panelGroups.find(g => g.id === np.groupId) : undefined;
  if (!pg || np.memberIndex == null || np.memberIndex < 0) { console.warn('[YAGO][KAPAK-HİZA] levha raf/dikme üyesi değil, taşınamaz — derz levhaya gidecek:', np.name); return false; }
  const { u, v } = doorPlaneAxes(group.axis);
  if (pg.axis !== (np.kind === 'u' ? u : v)) { console.warn('[YAGO][KAPAK-HİZA] grubun dizilim ekseni levhanın kalınlık ekseni değil, taşınamaz:', np.name, pg.id); return false; }
  const k = np.memberIndex;
  const cur = pg.gaps[k]?.value;
  if (cur == null) return false;
  const next = round1(cur + groupFacing(pg) * delta);
  if (next < 0) { console.warn('[YAGO][KAPAK-HİZA] istenen boşluk negatif, levha taşınamaz:', np.name, next); return false; }
  const sim = applyGapEdit(pg.gaps, k, next, boxSpan(pg.cavity, pg.axis), pg.count, memberThicknessesOf(pg));
  if (Math.abs((sim[k]?.value ?? NaN) - next) > 0.05) { console.warn('[YAGO][KAPAK-HİZA] boşluk yazılamıyor (kilitli komşular), levha taşınamaz:', np.name, next); return false; }
  console.log('[YAGO][KAPAK-HİZA]', group.id, np.name, '→', align, 'derz', `${np.joint!.p0.toFixed(1)}..${np.joint!.p1.toFixed(1)}`, 'Δ=', delta.toFixed(1), 'boşluk', k, cur, '→', next);
  void editGroupGap(pg.id, k, next);
  return true;
}

// ── STORE İŞLEMLERİ ─────────────────────────────────────────────────────────

const groupById = (id: string) => useAppStore.getState().doorGroups.find(g => g.id === id);

function solveFromStore(group: DoorGroup): DoorSolution | null {
  const st = useAppStore.getState();
  const parent = shapeById(group.shapeId, st.shapes);
  return parent ? solveDoorGroup(group, parent, st.shapes) : null;
}

const fallbackSolution = (group: DoorGroup): DoorSolution => {
  const solved = solveDoorTree(group);
  return { rect: group.rect, tree: solvedToTree(solved), solved, members: doorMemberRects(solved) };
};

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

/** Onaylanan adaydan grup + ilk (tek) kapak oluşturur; grup seçilir. Bölme sonra seçili kapak üzerinden (splitDoorLeaves). */
export function createDoorGroupFromPick(shapeId: string, pick: DoorPick, placement: DoorGroup['placement'], name?: string): DoorGroup | null {
  const st = useAppStore.getState();
  const parent = shapeById(shapeId, st.shapes);
  if (!parent) return null;
  const rect = placement === 'inner' ? { ...pick.inner } : { ...pick.outer };
  const group: DoorGroup = {
    id: genId('door'), shapeId, axis: pick.axis, side: pick.side, placement, bounds: pick.bounds, depthRef: pick.depth, rect, anchor: pick.at,
    tree: makeDoorLeaf('left'), edgeGaps: { uMin: DOOR_GAP, uMax: DOOR_GAP, vMin: DOOR_GAP, vMax: DOOR_GAP }, gap: DOOR_GAP, thickness: DOOR_THICKNESS,
    memberVfIds: [], name: name?.trim() || 'Door', createdAt: Date.now(),
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

/**
 * Çözümü üye VF'lere yazar ve grubu günceller; tam rebuild. `preview` (CANLI ÖNİZLEME — Goker, Eki 2026: "kutucuğa değeri yazar
 * yazmaz kalan ölçüyü diğer taraflara dağıt"): yalnız grup (ağaç / boşluklar) store'a yazılır — VF ve rebuild yok; şema ve
 * kapak içi ölçüler anında yeni dağılımı gösterir, onayda (Enter / odak kaybı) gerçek yazım gelir.
 */
async function writeDoorGroup(group: DoorGroup, patch: Partial<DoorGroup>, why: string, preview = false): Promise<void> {
  const st = useAppStore.getState();
  const next: DoorGroup = { ...group, ...patch };
  const sol = solveFromStore(next) || fallbackSolution(next);
  if (preview) { st.updateDoorGroup(group.id, { ...patch, rect: sol.rect, tree: sol.tree }); return; }
  for (const vfId of next.memberVfIds) {
    const vf = useAppStore.getState().virtualFaces.find(f => f.id === vfId);
    if (!vf) continue;
    const p = doorVfPatch(vf, next, sol);
    if (p) st.updateVirtualFace(vf.id, p);
  }
  st.updateDoorGroup(group.id, { ...patch, rect: sol.rect, tree: sol.tree });
  console.log('[YAGO][KAPAK]', why, group.id, fmtRect(sol.rect), 'ağaç=', fmtTree(sol.solved));
  await requestRebuild(group.shapeId);
}

/** Ağacın kısa dökümü (log): leaf tip, split eksen[ölçü/ölçü]. */
export function fmtTree(n: DoorNodeSolved): string {
  if (n.kind === 'leaf') return n.leafSplit ? `${n.type}(${n.leafSplit.leaves.map(l => l.value).join('+')})` : n.type;
  return `${n.axis}[${n.children.map((c, i) => `${n.sizes[i]?.value}${n.sizes[i]?.locked ? '🔒' : ''}:${fmtTree(c)}`).join(' | ')}]`;
}

/**
 * ÜYELERİ YENİDEN KUR (yapı değişti): yeni ağaca göre üyeler çıkarılır; yaprak id'si + kanat sırası aynı kalan üyelerin
 * VF/panelleri (adımlarıyla) KORUNUR, yalnız doorIndex'leri yeni sıraya yazılır; diğerleri silinir, eksikler yeni VF
 * olarak eklenir (paneli otomatik üretim yaratır → rebuild'i panel ekleme/silme izleyicisi tetikler).
 * `restructured` = yapısı değişen yaprak id'leri (bunların eski üyeleri her durumda yenilenir).
 */
function rebuildMembers(group: DoorGroup, nextGroup: DoorGroup, restructured: Set<string>, why: string): void {
  const st = useAppStore.getState();
  const sol = solveFromStore(nextGroup) || fallbackSolution(nextGroup);
  const oldMembers = fallbackSolution(group).members;
  const oldIds = new Map<string, string>();   // `${leafId}/${leaf}` → vfId
  if (oldMembers.length === group.memberVfIds.length) oldMembers.forEach((m, i) => { if (group.memberVfIds[i]) oldIds.set(`${m.leafId}/${m.leaf}`, group.memberVfIds[i]); });
  else console.warn('[YAGO][KAPAK] üye sayısı tutmuyor, tüm üyeler yeniden kuruluyor:', oldMembers.length, 'vs', group.memberVfIds.length);
  const ids: string[] = [], kept: string[] = [], fresh: VirtualFace[] = [];
  sol.members.forEach((m, i) => {
    const prev = restructured.has(m.leafId) ? undefined : oldIds.get(`${m.leafId}/${m.leaf}`);
    if (prev) { ids.push(prev); kept.push(prev); }
    else { const vf = makeMemberVf(nextGroup, i, sol); ids.push(vf.id); fresh.push(vf); }
  });
  removeMembers(group.memberVfIds.filter(id => !kept.includes(id)));
  for (const id of kept) st.updateVirtualFace(id, { doorIndex: ids.indexOf(id) });
  st.updateDoorGroup(group.id, { ...nextGroup, rect: sol.rect, tree: sol.tree, memberVfIds: ids });
  // Yeni kapaklar listede korunan son üyeden sonra (yoksa sona) — grup bir arada kalır.
  const order = useAppStore.getState().virtualFaces.map(f => f.id);
  const lastKept = kept.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b)).pop() ?? null;
  st.insertVirtualFacesAfter(lastKept, fresh);
  if (useAppStore.getState().selectedDoorGroupId !== group.id && !useAppStore.getState().selectedPanelRow) st.setSelectedDoorGroupId(group.id);
  console.log('[YAGO][KAPAK]', why, group.id, 'ağaç=', fmtTree(sol.solved), 'korunan=', kept.length, 'yeni=', fresh.length, 'silinen=', group.memberVfIds.length - kept.length);
}

/**
 * BÖLGE BÖLME (Goker, Eki 2026: "kapağa tıklayınca dikey veya yatay bölüm gireyim ama kaça bölüneceğini seçmeliyim;
 * seçilen yeri tekrar dikeyde veya yatayda miktar girerek böleyim; kaça bölünmüşse göster, sonradan değiştireyim"):
 * seçili DÜĞÜM (kapak ya da bölünmüş alan) için `axis` eksenindeki parça sayısı `count` yapılır.
 *  • Yaprak + count ≥ 2 → yaprak, o eksende count çocuklu bir split olur (çocuklar eşit; aralar grubun boşluğu;
 *    tipler: u → sol yarı left / sağ yarı right, v → bölünen kapağın tipi).
 *  • Aynı eksenli split → çocuk sayısı değişir: artınca sona yeni parçalar eklenir (son parça bir bölmeyse onun
 *    kopyaları — 2 satır × V×2 → 3 satır × V×2; tek kapaksa eşit yeni kapaklar), azalınca sondakiler gider (ölçüler
 *    eşitlenir); count = 1 → bölme kalkar, İLK PARÇA olduğu gibi kalır (tek kapaksa o kapak — tipi ve adımlarıyla;
 *    sarılmış bir bölmeyse eski bölme geri gelir).
 *  • Diğer eksenli split + count ≥ 2 → alan SARILIR ve MEVCUT BÖLME HER PARÇADA KORUNUR (Goker, Eki 2026: "bir kapağı
 *    2'ye böldüysem, tekrar tüm bloğu seçip yatayda bölüyorsam dikeyde bölünmemiş gibi bölüyor; tüm bloğa tıklıyorsam
 *    daha önce bölünmüş halini koruyarak bölsün"): yeni split'in ilk parçası mevcut bölme (üyeleri korunur), diğer
 *    parçalar mevcut bölmenin yeni kimlikli KOPYALARI (cloneDoorNode: aynı ölçüler/kilitler/tipler) → V×2 sonra H×2 =
 *    2 satır × 2 sütun. Eski davranış (ilk parça mevcut bölme, gerisi tek kapak) kaldırıldı.
 * Üst bölmelerin ölçüleri değişmez. Dönüş: sonuç düğümün id'si (arayüz seçimi orada tutar) — işlem yoksa null.
 */
export function setDoorNodeSplit(groupId: string, nodeId: string, axis: 'u' | 'v', count: number, opts: { keepTargetSize?: boolean } = {}): string | null {
  const group = groupById(groupId);
  const node = group ? findDoorNode(group.tree, nodeId) : null;
  if (!group || !node || !Number.isFinite(count)) return null;
  const n = Math.max(1, Math.min(MAX_DOOR_SPLIT, Math.round(count)));
  const newLeaves = (k: number, from: number, total: number, baseType: DoorType) =>
    Array.from({ length: k }, (_, i) => makeDoorLeaf(axis === 'u' ? defaultDoorType(from + i, total) : baseType));
  const gapsFor = (m: number, old: number[] = []) => Array.from({ length: m }, (_, i) => old[i] ?? old[0] ?? group.gap);
  if (node.kind === 'leaf') {
    if (n <= 1) return node.id;
    const baseType: DoorType = doorLeafAxis(node.type) ? 'left' : node.type;
    const split: DoorNode = { id: genId('ds'), kind: 'split', axis, sizes: [], gaps: gapsFor(n - 1), children: newLeaves(n, 0, n, baseType) };
    rebuildMembers(group, { ...group, tree: replaceDoorNode(group.tree, node.id, () => split) }, new Set([node.id]), `bölme ${axis === 'u' ? 'V' : 'H'} ×${n}`);
    return split.id;
  }
  if (node.axis === axis) {
    if (n === node.children.length) return node.id;
    if (n <= 1) {
      // BİRLEŞTİRME: bölme kalkar, ilk parça olduğu gibi kalır (kapaksa kendi tipi/adımlarıyla; sarılmış bölmeyse geri gelir).
      const first = node.children[0];
      const gone = new Set(node.children.slice(1).flatMap(c => doorLeaves(c).map(l => l.id)));
      rebuildMembers(group, { ...group, tree: replaceDoorNode(group.tree, node.id, () => first) }, gone, 'birleştirme (×1)');
      return first.id;
    }
    const restructured = new Set<string>();
    let children = node.children.slice();
    if (n > children.length) {
      // ARTIŞ: son parça bir bölmeyse yeni parçalar onun kopyası (2 satır × V×2 → 3 satır × V×2; Goker: bölünmüş hal korunsun);
      // son parça tek kapaksa eskisi gibi eşit yeni kapaklar.
      const last = children[children.length - 1];
      children = [...children, ...(last.kind === 'split' ? Array.from({ length: n - children.length }, () => cloneDoorNode(last)) : newLeaves(n - children.length, children.length, n, 'left'))];
    } else { for (const c of children.slice(n)) for (const l of doorLeaves(c)) restructured.add(l.id); children = children.slice(0, n); }
    // Ölçüler eşitlenir; elle sayı girildiyse spacing hedefi kalkar. Derz bağları kalan derzlerde (k < n−1) korunur.
    const refs = Object.fromEntries(Object.entries(node.refs ?? {}).filter(([k]) => +k < n - 1)) as Record<number, DoorJointRef>;
    const next: DoorNode = { ...node, children, gaps: gapsFor(n - 1, node.gaps), sizes: [], targetSize: opts.keepTargetSize ? node.targetSize : undefined, refs: Object.keys(refs).length ? refs : undefined };
    rebuildMembers(group, { ...group, tree: replaceDoorNode(group.tree, node.id, () => next) }, restructured, `bölme sayısı ${node.children.length} → ${n}`);
    return node.id;
  }
  if (n <= 1) return node.id;
  // SARMA — mevcut bölme her parçada korunur: ilk parça mevcut düğüm (üyeleri korunur), diğerleri yeni kimlikli kopyaları.
  const wrap: DoorNode = { id: genId('ds'), kind: 'split', axis, sizes: [], gaps: gapsFor(n - 1), children: [node, ...Array.from({ length: n - 1 }, () => cloneDoorNode(node))] };
  rebuildMembers(group, { ...group, tree: replaceDoorNode(group.tree, node.id, () => wrap) }, new Set(), `sarma ${axis === 'u' ? 'V' : 'H'} ×${n} (mevcut bölme her parçada)`);
  console.log('[YAGO][KAPAK-BÖLME] sarma: mevcut', node.axis === 'u' ? 'V' : 'H', `×${node.children.length}`, 'bölme', n, 'parçanın her birinde korundu →', doorLeaves(wrap).length, 'kapak');
  return wrap.id;
}
/** Eski adlar — tek giriş setDoorNodeSplit. */
export const splitDoorLeaves = (groupId: string, leafIds: string[], axis: 'u' | 'v', count = 2) => leafIds.forEach(id => setDoorNodeSplit(groupId, id, axis, count));
export function mergeDoorLeaf(groupId: string, leafId: string): void {
  const group = groupById(groupId);
  const parent = group ? findDoorParent(group.tree, leafId) : null;
  if (parent) setDoorNodeSplit(groupId, parent.id, parent.axis, 1);
}
export const setDoorSplitCount = (groupId: string, splitId: string, count: number) => {
  const group = groupById(groupId);
  const node = group ? findDoorNode(group.tree, splitId) : null;
  if (node?.kind === 'split') setDoorNodeSplit(groupId, splitId, node.axis, count);
};

/**
 * PANEL REF BÖLME (Goker, Eki 2026: "panel ref modunda sadece dikme ya da raf seçmem yeterli olsun, kapağı dikmenin ta
 * ortasından bölsün; sonra dikme sağa sola, raf yukarı aşağı gitsin — raf ve dikme hareket etsin, kapak değil; panel ref
 * gösterildikten sonra dikmenin arası değişince kapak kendini ona göre güncellesin"): kapak-sınırı iç levhanın (dikme → V,
 * raf → H) merkezinden geçen her kapak yaprağı, levhanın ekseninde ikiye bölünür; DERZ LEVHAYA BAĞLANIR (split.refs[0] =
 * {vfId, 'center'}) → derz her çözümde levhanın güncel ortasından türetilir: levha taşınınca kapak onu izler. Rozetle
 * Left / Center / Right (Up / Center / Down) seçilince LEVHA kendi grubunun boşluğuyla bir kez taşınır (setDoorJointRef),
 * kapak yerinde kalır; sonrası yine bağlı. Döner: yeni split id'leri (yoksa boş).
 */
export function splitDoorAtPanel(groupId: string, vfId: string): string[] {
  const group = groupById(groupId);
  if (!group) return [];
  const st = useAppStore.getState();
  const parent = shapeById(group.shapeId, st.shapes);
  if (!parent) return [];
  const np = doorNearPanels(group, parent, st.shapes, st.virtualFaces, st.panelGroups).find(p => p.vfId === vfId);
  if (!np) { console.warn('[YAGO][KAPAK-REF] seçilen panel bu kapağın sınır levhası değil / kapağa değmiyor:', vfId); return []; }
  if (np.edge) { console.warn('[YAGO][KAPAK-REF] kenar levhası (grup sınırı) ile bölme yapılmaz:', np.name); return []; }
  if (!np.groupId) console.warn('[YAGO][KAPAK-REF] levha raf/dikme üyesi değil — bölünür ve bağlanır ama rozetle taşınamaz (derz levhaya gider):', np.name);
  const solved = solveDoorTree(group);
  const axis = np.kind, pc = (np.a0 + np.a1) / 2, g = group.gap;
  // Levhanın merkezinden geçen yapraklar (iki yarım da en az MIN_DOOR_SPAN; çapraz örtüşme şart).
  const hits: DoorNodeSolved[] = [];
  const walk = (n: DoorNodeSolved) => {
    if (n.kind === 'split') { n.children.forEach(walk); return; }
    const a0 = axis === 'u' ? n.u0 : n.v0, a1 = axis === 'u' ? n.u1 : n.v1, c0 = axis === 'u' ? n.v0 : n.u0, c1 = axis === 'u' ? n.v1 : n.u1;
    if (Math.min(c1, np.c1) - Math.max(c0, np.c0) < TOL) return;
    if (pc - g / 2 - a0 >= MIN_DOOR_SPAN && a1 - (pc + g / 2) >= MIN_DOOR_SPAN) hits.push(n);
  };
  walk(solved);
  if (!hits.length) { console.warn('[YAGO][KAPAK-REF] levhanın merkezinden geçen bölünebilir kapak yok:', np.name); return []; }
  let tree = group.tree;
  const ids: string[] = [], restructured = new Set<string>();
  for (const leaf of hits) {
    const lt: DoorType = leaf.kind === 'leaf' ? leaf.type : 'left';
    const baseType: DoorType = doorLeafAxis(lt) ? 'left' : lt;
    // Ölçüler çözümden (bağlı derz = levhanın ortası): ilk parça yaprağın başından derze, ikinci kalanı alır — ikisi de
    // çözümde girilmiş (edited) yazılır; bağ çözülürse oldukları yerde donarlar.
    const split: DoorNode = {
      id: genId('ds'), kind: 'split', axis, sizes: [], gaps: [g], refs: { 0: { vfId, align: 'center' } },
      children: axis === 'u' ? [makeDoorLeaf('left'), makeDoorLeaf('right')] : [makeDoorLeaf(baseType), makeDoorLeaf(baseType)],
    };
    tree = replaceDoorNode(tree, leaf.id, () => split);
    ids.push(split.id); restructured.add(leaf.id);
  }
  rebuildMembers(group, { ...group, tree }, restructured, `panel ref bölme @ ${np.name} (${axis === 'u' ? 'V' : 'H'}, ${hits.length} kapak, derz levhaya BAĞLI — ortalı @ ${pc.toFixed(1)})`);
  return ids;
}

/** SPACING: hedef parça ölçüsü için parça sayısı — eşit parçalar hedefe en yakın (L = alan uzunluğu, g = ara boşluk). */
export const countForTargetSize = (L: number, size: number, g: number) => Math.max(1, Math.min(MAX_DOOR_SPLIT, Math.round((L + g) / (Math.max(1, size) + g))));
/**
 * SPACING MODU (Goker: "spacing modu da olsun"): seçili bölgeye `axis` ekseninde hedef parça ölçüsü (mm) verilir; parça
 * sayısı alanın uzunluğundan türetilir ve split'e targetSize yazılır — gövde boyutlanınca syncDoorGroups yeniden sayar.
 * null → hedef kalkar (mevcut parçalar durur). Döner: split id (ya da null).
 */
export function setDoorNodeSpacing(groupId: string, nodeId: string, axis: 'u' | 'v', size: number | null): string | null {
  const group = groupById(groupId);
  const node = group ? findDoorNode(group.tree, nodeId) : null;
  if (!group || !node) return null;
  const sn = findSolvedNode(solveDoorTree(group), nodeId);
  if (!sn) return null;
  if (size == null) {
    if (node.kind !== 'split' || !node.targetSize) return node.id;
    useAppStore.getState().updateDoorGroup(groupId, { tree: replaceDoorNode(group.tree, nodeId, old => ({ ...(old as any), targetSize: undefined })) });
    console.log('[YAGO][KAPAK-SPACING] hedef kaldırıldı', nodeId);
    return node.id;
  }
  if (!Number.isFinite(size) || size < MIN_DOOR_SPAN) return null;
  const L = axis === 'u' ? sn.u1 - sn.u0 : sn.v1 - sn.v0;
  const n = countForTargetSize(L, size, group.gap);
  const sameAxisSplit = node.kind === 'split' && node.axis === axis;
  const id = sameAxisSplit && n === node.children.length ? node.id : setDoorNodeSplit(groupId, nodeId, axis, Math.max(2, n), { keepTargetSize: true });
  if (!id) return null;
  const g2 = groupById(groupId);
  if (!g2) return null;
  const target = findDoorNode(g2.tree, id);
  if (!target || target.kind !== 'split') return id;
  useAppStore.getState().updateDoorGroup(groupId, { tree: replaceDoorNode(g2.tree, id, old => ({ ...(old as any), targetSize: round1(size) })) });
  console.log('[YAGO][KAPAK-SPACING]', groupId, id, 'hedef=', size, 'L=', L.toFixed(1), '→ parça', n);
  return id;
}

/** Düğümün altındaki (kendisi dahil) `axis` eksenli, hedef ölçüsü olan bölmeler (DFS). */
export function doorSpacingNodes(n: DoorNode, axis: 'u' | 'v'): Array<Extract<DoorNode, { kind: 'split' }>> {
  if (n.kind !== 'split') return [];
  const own = n.axis === axis && n.targetSize ? [n] : [];
  return [...own, ...n.children.flatMap(c => doorSpacingNodes(c, axis))];
}
/**
 * KAPSAMDAKİ SPACING HEDEFLERİ: seçili bölgelerin (boşsa kök) alt ağacındaki `axis` eksenli hedefler; alt ağaçta yoksa
 * seçili bölgeyi ÜRETEN en yakın üst bölmenin hedefi (bir kapağa tıklayıp "bu kapakları üreten spacing'i iptal et").
 */
export function doorSpacingTargetsInScope(tree: DoorNode, scopeIds: string[], axis: 'u' | 'v'): Array<Extract<DoorNode, { kind: 'split' }>> {
  const roots = (scopeIds.length ? scopeIds : [tree.id]).map(id => findDoorNode(tree, id)).filter((n): n is DoorNode => !!n);
  const out = new Map<string, Extract<DoorNode, { kind: 'split' }>>();
  for (const r of roots) {
    const under = doorSpacingNodes(r, axis);
    if (under.length) { for (const n of under) out.set(n.id, n); continue; }
    for (let par = findDoorParent(tree, r.id); par; par = findDoorParent(tree, par.id)) { if (par.axis === axis && par.targetSize) { out.set(par.id, par); break; } }
  }
  return [...out.values()];
}
/**
 * SPACING İPTALİ (Goker: "spacing değeri girdiğimde yazılan değeri iptal edemiyorum"): kapsamdaki (doorSpacingTargetsInScope)
 * `axis` eksenli hedefler kaldırılır — mevcut parçalar durur, gövde boyutlanınca artık yeniden sayılmaz. Seçim değişmiş olsa
 * da hedef bulunur. Döner: kaldırılan hedef sayısı.
 */
export function clearDoorSpacing(groupId: string, scopeIds: string[], axis: 'u' | 'v'): number {
  const group = groupById(groupId);
  if (!group) return 0;
  const ids = new Set(doorSpacingTargetsInScope(group.tree, scopeIds, axis).map(n => n.id));
  if (!ids.size) return 0;
  let tree = group.tree;
  for (const id of ids) tree = replaceDoorNode(tree, id, old => ({ ...(old as any), targetSize: undefined }));
  useAppStore.getState().updateDoorGroup(groupId, { tree });
  console.log('[YAGO][KAPAK-SPACING] hedef kaldırıldı', groupId, axis === 'u' ? 'V' : 'H', [...ids].join(','), '(parçalar durur)');
  return ids.size;
}

/**
 * KAPAK TİPİ ATAMA (Goker: "birden fazla kapağı seçip bir kapak tipi verebileyim"): seçilen YAPRAKLARA tek tip.
 * Yalnız menteşe yönü değişiyorsa (left↔right↔up↔down, ya da double↔double) geometri aynıdır → tip yazılır, rebuild
 * yok. Kanat YAPISI değişen yapraklar (tek↔double↔fold) yeniden kurulur; diğer kapaklar (adımlarıyla) korunur.
 */
export async function setDoorLeafTypes(groupId: string, leafIds: string[], type: DoorType): Promise<void> {
  const group = groupById(groupId);
  if (!group || !DOOR_TYPES.includes(type)) return;
  let tree = group.tree;
  const restructured = new Set<string>();
  let changed = false;
  for (const id of leafIds) {
    const node = findDoorNode(tree, id);
    if (!node || node.kind !== 'leaf' || node.type === type) continue;
    changed = true;
    const structural = (doorLeafAxis(node.type) ?? 'single') !== (doorLeafAxis(type) ?? 'single');
    if (structural) restructured.add(id);
    tree = replaceDoorNode(tree, id, old => ({
      ...old, type,
      // kanatlı → kanatlı aynı eksen: kanat ölçüleri korunur; aksi halde kanatlar eşit doğar (ara korunur) / silinir
      ...(doorLeafAxis(type) ? (structural ? { leafSplit: { leaves: [], gap: (old as any).leafSplit?.gap ?? group.gap } } : {}) : { leafSplit: undefined }),
    } as DoorNode));
  }
  if (!changed) return;
  if (!restructured.size) {
    useAppStore.getState().updateDoorGroup(groupId, { tree });
    console.log('[YAGO][KAPAK-TİP]', groupId, leafIds.length, 'kapak →', type, '(yalnız menteşe yönü, geometri aynı)');
    return;
  }
  rebuildMembers(group, { ...group, tree }, restructured, `tip → ${type} (${leafIds.length} kapak)`);
}

/**
 * KANAT ÖLÇÜSÜ (Goker: "o bölünmüş yeri ayrıca ölçülendirebileyim ama total ölçü ilk bölünen üzerinden"): double/fold
 * yaprakta kanat k'ya değer girilir; diğer kanat yaprağın alanından (− kanat arası) kalanı alır. Yaprağın alanı değişmez.
 */
export type DoorEditOpts = { preview?: boolean };
export async function editDoorLeafSize(groupId: string, leafId: string, k: number, value: number, opts: DoorEditOpts = {}): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value) || value <= 0) return;
  const sn = findSolvedNode(solveDoorTree(group), leafId);
  if (!sn || sn.kind !== 'leaf' || !sn.leafSplit) return;
  const ax = doorLeafAxis(sn.type)!;
  const leaves = applyGapEdit(sn.leafSplit.leaves, k, value, ax === 'u' ? sn.u1 - sn.u0 : sn.v1 - sn.v0, 1, [sn.leafSplit.gap]);
  const tree = replaceDoorNode(group.tree, leafId, old => ({ ...old, leafSplit: { leaves, gap: sn.leafSplit!.gap } } as DoorNode));
  await writeDoorGroup(group, { tree }, `kanat ${k + 1} = ${value}`, !!opts.preview);
}
/** KANAT ARASI BOŞLUK (Goker: "2 kapak arası ölçülendirilebilsin"): yalnız o yaprağın iki kanadı arasındaki boşluk. */
export async function setDoorLeafGap(groupId: string, leafId: string, gap: number, opts: DoorEditOpts = {}): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(gap) || gap < 0) return;
  const sn = findSolvedNode(solveDoorTree(group), leafId);
  if (!sn || sn.kind !== 'leaf' || !sn.leafSplit || Math.abs(sn.leafSplit.gap - gap) < 0.05) return;
  const tree = replaceDoorNode(group.tree, leafId, old => ({ ...old, leafSplit: { leaves: sn.leafSplit!.leaves, gap: round1(gap) } } as DoorNode));
  await writeDoorGroup(group, { tree }, `kanat arası = ${round1(gap)}`, !!opts.preview);
}

/**
 * BÖLME ÖLÇÜSÜ (şema pill'i): split düğümünün k. çocuğuna değer; fark kilitsiz/girilmemiş kardeşlere EŞİT (applyGapEdit).
 * BAĞLI DERZ (Goker: kapak ↔ dikme bağı iki yönlü okunur): kapağın bitişiğindeki derz bir levhaya bağlıysa ölçü LEVHAYI
 * taşıyarak girilir — derz `k. kapak = değer` olacak yere, levha hizasına göre onun altına (editGroupGap → rebuild → kapak
 * izler). Önce k. derz (kapağın sonu), yoksa k−1. derz (başı). Levha taşınamıyorsa (üye değil, kilitli komşular) ölçü
 * yazılır ama bağlı derz çözümde yine levhadan gelir (uyarı).
 */
export async function editDoorSize(groupId: string, splitId: string, k: number, value: number, opts: DoorEditOpts = {}): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value) || value <= 0) return;
  const sn = findSolvedNode(solveDoorTree(group), splitId);
  if (!sn || sn.kind !== 'split' || k < 0 || k >= sn.children.length) return;
  const refs = sn.refs ?? {};
  const j = refs[k] ? k : refs[k - 1] ? k - 1 : -1;
  // Önizlemede levha taşınmaz; yalnız ağaç (dağılım) gösterilir — onayda bağlı derz levhayı taşır, çözüm levhadan gelir.
  if (j >= 0 && !opts.preview) {
    const st = useAppStore.getState();
    const parent = shapeById(group.shapeId, st.shapes);
    const ref = refs[j], g = sn.gaps[j] ?? group.gap, c = sn.children[k];
    // Derz merkezi: j = k → kapağın başı + değer + yarım derz; j = k−1 → kapağın sonu − değer − yarım derz (v: yukarıdan aşağı).
    const center = sn.axis === 'u' ? (j === k ? c.u0 + value + g / 2 : c.u1 - value - g / 2) : (j === k ? c.v1 - value - g / 2 : c.v0 + value + g / 2);
    const np = parent ? doorNearPanels(group, parent, st.shapes, st.virtualFaces, st.panelGroups).find(p => p.vfId === ref.vfId) : undefined;
    const joint: DoorJoint = { splitId, k: j, axis: sn.axis, p0: center - g / 2, p1: center + g / 2, c0: 0, c1: 0 };
    if (np && movePanelToAlign(group, { ...np, joint }, ref.align, st.panelGroups)) {
      console.log('[YAGO][KAPAK-BAĞ] ölçü', k + 1, '=', value, '→ bağlı levha taşındı, derz', j, 'merkez', round1(center), '(kapak rebuild ile izler)');
      return;
    }
    console.warn('[YAGO][KAPAK-BAĞ] bölmede levhaya bağlı derz var ama levha taşınamadı — ölçü girişi bağlı derzi değiştiremez (Shift+tık ile bağı çözün):', splitId, 'derz', j);
  }
  const L = sn.axis === 'u' ? sn.u1 - sn.u0 : sn.v1 - sn.v0;
  const sizes = applyGapEdit(sn.sizes, k, value, L, sn.gaps.length, sn.gaps);
  const tree = replaceDoorNode(group.tree, splitId, old => ({ ...(old as any), sizes }));
  await writeDoorGroup(group, { tree }, `ölçü ${k + 1} = ${value}`, !!opts.preview);
}
/** Kilit: değer değişmez; gövde boyutlanınca bu kapak sabit kalır (kardeşler dağıtır). Geometri değişmez → rebuild yok. */
export function toggleDoorSizeLock(groupId: string, splitId: string, k: number): void {
  const group = groupById(groupId);
  const sn = group ? findSolvedNode(solveDoorTree(group), splitId) : null;
  if (!group || !sn || sn.kind !== 'split' || k < 0 || k >= sn.sizes.length) return;
  const sizes = sn.sizes.map((g, i) => (i === k ? { ...g, locked: !g.locked } : g));
  useAppStore.getState().updateDoorGroup(groupId, { tree: replaceDoorNode(group.tree, splitId, old => ({ ...(old as any), sizes })) });
}
/** Split düğümündeki TEK ara boşluk (k. çocuk ile k+1. arası): yalnız o değişir; fark serbest kapaklara eşit. */
export async function setDoorSplitGap(groupId: string, splitId: string, k: number, value: number, opts: DoorEditOpts = {}): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value) || value < 0) return;
  const sn = findSolvedNode(solveDoorTree(group), splitId);
  if (!sn || sn.kind !== 'split' || k < 0 || k >= sn.gaps.length || Math.abs(sn.gaps[k] - value) < 0.05) return;
  const gaps = sn.gaps.slice(); gaps[k] = round1(value);
  const tree = replaceDoorNode(group.tree, splitId, old => ({ ...(old as any), gaps }));
  await writeDoorGroup(group, { tree }, `ara boşluk ${k + 1} = ${round1(value)}`, !!opts.preview);
}
/** KENAR BOŞLUĞU (sol/sağ/alt/üst): yalnız o kenar değişir. */
export async function setDoorEdgeGap(groupId: string, edge: DoorEdgeKey, value: number, opts: DoorEditOpts = {}): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value) || value < 0) return;
  const e = edgeGapsOf(group);
  if (Math.abs(e[edge] - value) < 0.05) return;
  await writeDoorGroup(group, { edgeGaps: { ...e, [edge]: round1(value) } }, `kenar boşluğu ${edge} = ${round1(value)}`, !!opts.preview);
}
/** CANLI ÖNİZLEME kaydı: düzenleme başında alınır, Esc ile geri yüklenir (yalnız grup alanları; VF/rebuild yok). */
export interface DoorLayoutSnap { tree: DoorNode; edgeGaps?: DoorEdgeGaps; gap: number; rect: DoorRect }
export function doorLayoutSnapshot(groupId: string): DoorLayoutSnap | null {
  const g = groupById(groupId);
  return g ? { tree: g.tree, edgeGaps: g.edgeGaps ? { ...g.edgeGaps } : undefined, gap: g.gap, rect: { ...g.rect } } : null;
}
export function restoreDoorLayout(groupId: string, snap: DoorLayoutSnap | null | undefined): void {
  if (!snap || !groupById(groupId)) return;
  useAppStore.getState().updateDoorGroup(groupId, { tree: snap.tree, edgeGaps: snap.edgeGaps, gap: snap.gap, rect: snap.rect });
}
/** Ağaçtaki tüm aralar / kanat araları / kenarlar tek değere (ölçü kilit ve girilenleri korunur). */
function mapTreeGaps(n: DoorNode, g: number): DoorNode {
  if (n.kind === 'leaf') return n.leafSplit ? { ...n, leafSplit: { ...n.leafSplit, gap: g } } : n;
  return { ...n, gaps: n.gaps.map(() => g), children: n.children.map(c => mapTreeGaps(c, g)) };
}
/** Tüm boşluklar (kenarlar + aralar + kanat araları) tek değere: kilitli/girilmiş kapak ölçüleri korunur, kalan EŞİT. */
export async function setDoorGap(groupId: string, gap: number): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(gap) || gap < 0) return;
  const g = round1(gap);
  await writeDoorGroup(group, { gap: g, edgeGaps: { uMin: g, uMax: g, vMin: g, vMax: g }, tree: mapTreeGaps(group.tree, g) }, `tüm boşluklar = ${g}`);
}
/** Tüm ölçüler eşit + kilitsiz (kanatlar dahil); boşluklar korunur. */
function equalizeTree(n: DoorNode): DoorNode {
  if (n.kind === 'leaf') return n.leafSplit ? { ...n, leafSplit: { ...n.leafSplit, leaves: [] } } : n;
  return { ...n, sizes: [], children: n.children.map(equalizeTree) };
}
export async function equalizeDoorGroup(groupId: string): Promise<void> {
  const group = groupById(groupId);
  if (!group) return;
  await writeDoorGroup(group, { tree: equalizeTree(group.tree) }, 'eşitlendi');
}
/** Dış / iç kapak: dikdörtgen sınır panellerinin dış/iç yüzlerinden yeniden çözülür. */
export async function setDoorPlacement(groupId: string, placement: DoorGroup['placement']): Promise<void> {
  const group = groupById(groupId);
  if (!group || group.placement === placement) return;
  // İÇ kapakta yarım binme yoktur (Goker: "inset olduğunda yarı bindirmeyi iptal et, gösterme"): bayraklar silinir.
  const patch: Partial<DoorGroup> = placement === 'inner' && group.halfOverlay && Object.values(group.halfOverlay).some(Boolean) ? { placement, halfOverlay: {} } : { placement };
  await writeDoorGroup(group, patch, placement === 'inner' ? 'İÇ kapak (yarım binme iptal)' : 'DIŞ kapak');
}
/**
 * YARIM BİNME (Goker, Eki 2026: "kapakların en dış kısmında bir dikmeye yarım binmesine yarayan checkbox; tıklayınca
 * yerleştiği panel kalınlığının yarısı kadar o kenardan kısaltıp artı kenar boşluğu kadar kısaltsın, sonra eşit
 * bölümlendirsin"): kenar bayrağı yazılır, dikdörtgen yeniden çözülür (kenar = panel kalınlığının ortası − kenar
 * boşluğu) ve o eksendeki kapak ölçüleri yeniden EŞİT bölünür (kilit / girilen sıfırlanır); diğer eksen dokunulmaz.
 */
export async function setDoorHalfOverlay(groupId: string, edge: DoorEdgeKey, on: boolean): Promise<void> {
  const group = groupById(groupId);
  if (!group || !!group.halfOverlay?.[edge] === on) return;
  const halfOverlay = { ...(group.halfOverlay ?? {}), [edge]: on };
  const isU = edge === 'uMin' || edge === 'uMax';
  // O eksendeki KÖK bölmenin ölçüleri yeniden eşit bölünür (kilit / girilen sıfırlanır); alt bölmeler kendi alanlarında izler.
  const root = group.tree;
  const tree: DoorNode = root.kind === 'split' && root.axis === (isU ? 'u' : 'v') ? { ...root, sizes: [] } : root;
  await writeDoorGroup(group, { halfOverlay, tree }, `yarım binme ${edge} ${on ? 'AÇIK' : 'kapalı'} (${isU ? 'sütunlar' : 'satırlar'} eşitlendi)`);
}
/**
 * DERZ BAĞI / HİZASI (Goker: "dikmeyi kapağın sağına / soluna / ortalı, rafı yukarı / aşağı / ortada yerleştireyim — raf ve
 * dikme hareket etsin, kapak değil; sonra dikmenin arası değişince kapak kendini ona göre güncellesin"): `splitId` bölmesinin
 * k. derzi `vfId` levhasına `align` ile BAĞLANIR ve levha derze göre bir kez taşınır (movePanelToAlign → rebuild; bağ derzi
 * aynı yerde tutar, levha altına gelir — kapak ölçüleri değişmez). Levha taşınamıyorsa derz levhaya gider (kapak değişir).
 * align = null → bağ ÇÖZÜLÜR: bölmenin güncel ölçüleri girilmiş (edited) yazılır → kapaklar oldukları yerde donar (geometri
 * değişmez, rebuild yok).
 */
export async function setDoorJointRef(groupId: string, splitId: string, k: number, vfId: string, align: DoorAlign | null): Promise<void> {
  const group = groupById(groupId);
  const node = group ? findDoorNode(group.tree, splitId) : null;
  if (!group || !node || node.kind !== 'split' || k < 0 || k >= node.children.length - 1) return;
  const st = useAppStore.getState();
  const sn = findSolvedNode(solveDoorTree(group), splitId);
  if (!sn || sn.kind !== 'split') return;
  // LEVHA KAPAĞI İZLİYORSA (kapak arayüzünden eklenen raf/dikme — PanelGroup.doorBond): hiza bağda değişir, levha rebuild
  // ile derze göre yeniden konumlanır (kapak yerinde); null → bağ çözülür, levha olduğu yerde kalır (boşlukları kayıtlı).
  const bondPg = st.panelGroups.find(pg => pg.doorBond && pg.memberVfIds.includes(vfId));
  if (bondPg) {
    const bond = bondPg.doorBond!;
    if (bond.doorGroupId !== groupId || bond.splitId !== splitId || bond.k !== k) { console.warn('[YAGO][KAPAK-BAĞ] levha başka bir kapak derzine bağlı, bu derzle bağlanamaz:', vfId, bond); return; }
    if (!align) { st.updatePanelGroup(bondPg.id, { doorBond: undefined }); console.log('[YAGO][KAPAK-BAĞ] levha→kapak bağı çözüldü (levha yerinde kalır):', bondPg.id, splitId, 'derz', k); return; }
    if (bond.align === align) return;
    st.updatePanelGroup(bondPg.id, { doorBond: { ...bond, align } });
    console.log('[YAGO][KAPAK-BAĞ] levha→kapak hizası', bondPg.id, bond.align, '→', align, '(levha derze göre taşınır, kapak yerinde)');
    await requestRebuild(group.shapeId);
    return;
  }
  if (!align) {
    if (!node.refs?.[k]) return;
    const refs = { ...node.refs }; delete refs[k];
    const sizes = sn.sizes.map(s => ({ ...s, edited: true }));
    st.updateDoorGroup(groupId, { tree: replaceDoorNode(group.tree, splitId, old => ({ ...(old as any), sizes, refs: Object.keys(refs).length ? refs : undefined })) });
    console.log('[YAGO][KAPAK-BAĞ] çözüldü', groupId, splitId, 'derz', k, '— ölçüler donduruldu:', sizes.map(s => s.value).join('/'));
    return;
  }
  const parent = shapeById(group.shapeId, st.shapes);
  if (!parent) return;
  const np = doorNearPanels(group, parent, st.shapes, st.virtualFaces, st.panelGroups).find(p => p.vfId === vfId);
  const joint = doorJoints(solveDoorTree(group)).find(j => j.splitId === splitId && j.k === k);
  if (!np || !joint || joint.axis !== np.kind) { console.warn('[YAGO][KAPAK-BAĞ] levha bu derzle bağlanamaz (yakın değil / eksen uyuşmaz):', vfId, splitId, k); return; }
  if (np.edge) { console.warn('[YAGO][KAPAK-BAĞ] kenar levhası (grup sınırı) derze bağlanmaz:', np.name); return; }
  const refs: Record<number, DoorJointRef> = { ...(node.refs ?? {}), [k]: { vfId, align } };
  const tree = replaceDoorNode(group.tree, splitId, old => ({ ...(old as any), refs }));
  // Önce bağ yazılır (rebuild içindeki çözüm bağı görsün), sonra levha derze göre taşınır (editGroupGap → rebuild).
  st.updateDoorGroup(groupId, { tree });
  const moved = movePanelToAlign(group, { ...np, joint }, align, st.panelGroups);
  console.log('[YAGO][KAPAK-BAĞ]', groupId, splitId, 'derz', k, '↔', np.name, '→', align, moved ? '(levha taşındı, kapak yerinde)' : '(levha taşınamadı → derz levhaya)');
  if (!moved) await writeDoorGroup({ ...group, tree }, {}, `derz ${k} → ${np.name} (${align})`);
}
/**
 * DERZİ TAŞI (levha→kapak bağının boşluk girişi — PanelGroupService.editGroupGap): `splitId` bölmesinin k. derzinin merkezi
 * `center` olur: k. çocuğun ölçüsü çocuğun başından derzin min kenarına yazılır (applyGapEdit → kalan kardeşlere), tam rebuild.
 * Derz panel-ref ile levhaya bağlıysa (refs[k]) taşınamaz (levha kazanır) → false.
 */
export async function moveDoorJointTo(groupId: string, splitId: string, k: number, center: number): Promise<boolean> {
  const group = groupById(groupId);
  const sn = group ? findSolvedNode(solveDoorTree(group), splitId) : null;
  if (!group || !sn || sn.kind !== 'split' || k < 0 || k >= sn.children.length - 1 || !Number.isFinite(center)) return false;
  if (sn.refs?.[k]) { console.warn('[YAGO][KAPAK-BAĞ] derz panel-ref ile levhaya bağlı, kapak tarafından taşınamaz:', splitId, k); return false; }
  const g = sn.gaps[k] ?? group.gap, c = sn.children[k];
  const size = round1(sn.axis === 'u' ? (center - g / 2) - c.u0 : c.v1 - (center + g / 2));
  if (size < 1) { console.warn('[YAGO][KAPAK-BAĞ] derz bölmenin dışına çıkıyor, taşınmadı:', splitId, k, center.toFixed(1)); return false; }
  const L = sn.axis === 'u' ? sn.u1 - sn.u0 : sn.v1 - sn.v0;
  const sizes = applyGapEdit(sn.sizes, k, size, L, sn.gaps.length, sn.gaps);
  if (Math.abs((sizes[k]?.value ?? NaN) - size) > 0.05) { console.warn('[YAGO][KAPAK-BAĞ] derz taşınamadı (kilitli kapaklar):', splitId, k, size); return false; }
  const tree = replaceDoorNode(group.tree, splitId, old => ({ ...(old as any), sizes }));
  await writeDoorGroup(group, { tree }, `derz ${k} → ${round1(center)} (levhadan)`);
  return true;
}

/**
 * KAPAKLARIN ARASINA RAF / DİKME (Goker, Eki 2026: "kapakların arasına tıklayarak raf ve dikme atamak istiyorum; eklenen raf
 * ve dikme her zaman o kapak aralarının arasında çalışsın"): `splitId` bölmesinin k. derzinin merkezinden gövdeye hacim ışını
 * atılır (hacim seçimiyle AYNI ızgara — mevcut raf/dikme/gövde panelleri sınırlar, kapaklar engel değildir); ışının girdiği
 * serbest bölge yeni grubun hacmidir (dikme = V derzi → derzin ekseninde ince; raf = H derzi; grup türü eksenden:
 * Y → shelf, diğer → divider). Grup 1 üyeyle listenin SONUNA eklenir (kapak satırından sonra) ve doorBond ile derze
 * 'center' bağlanır: üye her çözümde derzin ortasında (levha kapağı izler). Derz panel-ref ile bağlıysa eklenmez.
 *
 * `at` = DERZ BOYUNCA YER (çapraz eksen koordinatı, gövde-yerel; Goker, Eki 2026: "dikmenin sağına ve soluna raf"): şema derzi
 * onu kesen levhalarla parçalara böler ve tıklanan parçanın ortasını gönderir; ışın o yerden atılır → her parça (dikmenin solu /
 * sağı) kendi serbest bölgesini (kendi bölmesini) bulur. Verilmezse derzin ortası (tek parçalı derz). KÖK NEDEN (eski): ışın
 * hep derzin ortasından atılıyordu; ortada bir dikme varsa ışın dikmenin içinden geçiyor, serbest hücre bulunmuyor → null →
 * arayüz tepkisiz; "bu derzde zaten bağlı levha var" denetimi de aynı derzin öbür parçasını engelliyordu. Yinelenme denetimi
 * artık PARÇA bazlı: aynı derze bağlı mevcut bir grubun hacmi `at`ı kapsıyorsa (aynı bölme) eklenmez, öbür parça serbesttir.
 * Döner: yeni grup ya da null.
 */
export function addPanelAtDoorJoint(groupId: string, splitId: string, k: number, at?: number): PanelGroup | null {
  const group = groupById(groupId);
  if (!group) return null;
  const st = useAppStore.getState();
  const parent = shapeById(group.shapeId, st.shapes);
  if (!parent) return null;
  const sol = solveDoorGroup(group, parent, st.shapes);
  const j = sol ? doorJoints(sol.solved).find(x => x.splitId === splitId && x.k === k) : undefined;
  if (!sol || !j) { console.warn('[YAGO][KAPAK-ARA] derz bulunamadı:', splitId, k); return null; }
  const node = findDoorNode(group.tree, splitId);
  if (node?.kind === 'split' && node.refs?.[k]) { console.warn('[YAGO][KAPAK-ARA] derz panel-ref ile bir levhaya bağlı, araya levha eklenmez:', splitId, k); return null; }
  const { u, v } = doorPlaneAxes(group.axis);
  const axis: 0 | 1 | 2 = j.axis === 'u' ? u : v, cross: 0 | 1 | 2 = j.axis === 'u' ? v : u;
  const kind: PanelGroup['kind'] = axis === 1 ? 'shelf' : 'divider';
  // Derz üzerindeki yer: tıklanan parçanın ortası (derz aralığına kırpılır); verilmemişse derzin ortası.
  const atC = typeof at === 'number' && Number.isFinite(at) ? Math.min(Math.max(at, j.c0), j.c1) : (j.c0 + j.c1) / 2;
  // Aynı derzin AYNI PARÇASINDA zaten bağlı bir levha varsa eklenmez; başka parça (dikmenin öbür yanı) serbesttir.
  const dup = st.panelGroups.find(pg => pg.doorBond && pg.doorBond.doorGroupId === groupId && pg.doorBond.splitId === splitId && pg.doorBond.k === k
    && pg.cavity.min[cross] - TOL <= atC && atC <= pg.cavity.max[cross] + TOL);
  if (dup) { console.warn('[YAGO][KAPAK-ARA] bu derzin bu parçasında zaten bağlı bir levha var:', splitId, k, dup.id, 'yer=', atC.toFixed(1), fmtBox(dup.cavity)); return null; }
  // Işın: derz merkezi × derz üzerindeki yer, kapak düzleminin önünden gövdeye doğru (hacim seçiminde tıklanan yüzden içeri).
  const body = bodyLocalBox(parent);
  if (!body) return null;
  const origin: Vec3 = [0, 0, 0], dir: Vec3 = [0, 0, 0];
  origin[axis] = (j.p0 + j.p1) / 2; origin[cross] = atC;
  origin[group.axis] = group.side > 0 ? Math.max(sol.rect.front, body.max[group.axis]) + 50 : Math.min(sol.rect.front, body.min[group.axis]) - 50;
  dir[group.axis] = -group.side;
  const grid = gridForObstacles(parent, collectObstacles(parent, st.shapes));
  if (!grid) { console.warn('[YAGO][KAPAK-ARA] hacim ızgarası kurulamadı'); return null; }
  const cands = rayCavityCandidates(origin, dir, grid, GROUP_PANEL_THICKNESS * 2, kind);
  const pick = cands.find(c => c.shape === 'shaped') ?? cands[0];
  if (!pick) { console.warn('[YAGO][KAPAK-ARA] derzin arkasında serbest hacim yok:', splitId, k, 'yer=', `${'XYZ'[cross]}=${atC.toFixed(1)}`, 'derz=', `${j.c0.toFixed(0)}..${j.c1.toFixed(0)}`); return null; }
  // Dizilim ekseni = derzin kalınlık ekseni (ışın yönünden bağımsız); sayım MİN'den; hacim ışının bulduğu bölge.
  const bond: DoorBond = { doorGroupId: groupId, splitId, k, align: 'center', member: 0 };
  const pg = createPanelGroupFromCavity(group.shapeId, kind, { ...pick, axis, facing: 1 }, undefined, { doorBond: bond });
  if (!pg) return null;
  // İki kapağın arasındaki levha doğal olarak KAPAK SINIRIDIR: şemada bandı/rozeti görünür, kapak adaylarına sınır olur.
  for (const vfId of pg.memberVfIds) setVfDoorBound(vfId, true);
  console.log('[YAGO][KAPAK-ARA]', kind, 'eklendi', pg.id, '↔', groupId, splitId, 'derz', k, `@ ${((j.p0 + j.p1) / 2).toFixed(1)}`, 'yer=', `${'XYZ'[cross]}=${atC.toFixed(1)}`,
    'hacim', `${'XYZ'[axis]}`, fmtBox(pg.cavity), 'adayN=', cands.length);
  return pg;
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

/**
 * BAYAT DERZ BAĞLARI: levhası silinmiş (VF yok) bağlar düşer; o bölmenin güncel ölçüleri girilmiş yazılır (kapaklar oldukları
 * yerde donar). Döner: değişen ağaç ya da null.
 */
function pruneDoorRefs(tree: DoorNode, solved: DoorNodeSolved, vfs: VirtualFace[]): DoorNode | null {
  let out = tree, changed = false;
  for (const { splitId, k, ref } of doorJointRefs(tree)) {
    if (vfs.some(f => f.id === ref.vfId)) continue;
    const sn = findSolvedNode(solved, splitId);
    out = replaceDoorNode(out, splitId, old => {
      const o = old as Extract<DoorNode, { kind: 'split' }>;
      const refs = { ...(o.refs ?? {}) }; delete refs[k];
      const sizes = sn && sn.kind === 'split' ? sn.sizes.map(s => ({ ...s, edited: true })) : o.sizes;
      return { ...o, sizes, refs: Object.keys(refs).length ? refs : undefined };
    });
    changed = true;
    console.warn('[YAGO][KAPAK-BAĞ] bağlı levha silinmiş, bağ düştü (ölçüler donduruldu):', splitId, 'derz', k, ref.vfId);
  }
  return changed ? out : null;
}

/**
 * REBUILD SONRASI SENKRON (PanelEngine): grubun store'daki dikdörtgeni/ölçüleri güncel çözümle eşitlenir. Bağlı derzler
 * (DoorNode.refs) çözümde levhaların güncel kutularından geldiği için "dikme taşındı → kapak izledi" burada ağaca yazılır
 * (üye VF'ler rebuild içinde recalculateDoorVfs ile zaten çözüldü).
 */
export function syncDoorGroups(parentShapeId: string): void {
  const st = useAppStore.getState();
  const parent = shapeById(parentShapeId, st.shapes);
  if (!parent) return;
  for (const g of st.doorGroups) {
    if (g.shapeId !== parentShapeId) continue;
    const sol = solveDoorGroup(g, parent, st.shapes);
    if (!sol) continue;
    // GEÇİŞ: eski panelAlign kaydı (levha her rebuild'de derze çekiliyordu) artık okunmaz → silinir.
    if (g.panelAlign) { st.updateDoorGroup(g.id, { panelAlign: undefined }); console.log('[YAGO][KAPAK-SENKRON] eski panelAlign kaydı silindi (bağ artık derzde):', g.id); }
    const pruned = pruneDoorRefs(g.tree, sol.solved, st.virtualFaces);
    if (pruned) { st.updateDoorGroup(g.id, { rect: sol.rect, tree: pruned }); continue; }
    const sameRefs = (a?: Record<number, DoorJointRef>, b?: Record<number, DoorJointRef>) => {
      const ka = Object.keys(a ?? {}), kb = Object.keys(b ?? {});
      return ka.length === kb.length && ka.every(k => b?.[+k]?.vfId === a?.[+k]?.vfId && b?.[+k]?.align === a?.[+k]?.align);
    };
    const sameTree = (a: DoorNode, b: DoorNode): boolean => {
      if (a.kind !== b.kind || a.id !== b.id) return false;
      if (a.kind === 'leaf' || b.kind === 'leaf') {
        const la = (a as any).leafSplit as DoorLeafSplit | undefined, lb = (b as any).leafSplit as DoorLeafSplit | undefined;
        if (!la && !lb) return true;
        return !!la && !!lb && Math.abs(la.gap - lb.gap) < 0.05 && la.leaves.length === lb.leaves.length && la.leaves.every((x, i) => Math.abs(x.value - lb.leaves[i].value) < 0.05);
      }
      return a.children.length === b.children.length && a.sizes.length === b.sizes.length
        && a.sizes.every((x, i) => Math.abs(x.value - b.sizes[i].value) < 0.05 && x.locked === b.sizes[i].locked && !!x.edited === !!b.sizes[i].edited)
        && a.gaps.length === b.gaps.length && a.gaps.every((x, i) => Math.abs(x - b.gaps[i]) < 0.05) && sameRefs(a.refs, b.refs) && a.children.every((c, i) => sameTree(c, b.children[i]));
    };
    // SPACING: alan uzunluğu değiştiyse parça sayısı yeniden türetilir (fark varsa üyeler yeniden kurulur; sonraki rebuild aynı n → durur).
    try {
      const resize: Array<{ id: string; axis: 'u' | 'v'; n: number; cur: number }> = [];
      const scan = (n: DoorNodeSolved) => {
        if (n.kind !== 'split') return;
        if (n.targetSize) { const L = n.axis === 'u' ? n.u1 - n.u0 : n.v1 - n.v0; const want = Math.max(2, countForTargetSize(L, n.targetSize, g.gap)); if (want !== n.children.length) resize.push({ id: n.id, axis: n.axis, n: want, cur: n.children.length }); }
        n.children.forEach(scan);
      };
      scan(sol.solved);
      for (const r of resize.slice(0, 1)) { console.log('[YAGO][KAPAK-SPACING] alan değişti: parça', r.cur, '→', r.n, r.id); setDoorNodeSplit(g.id, r.id, r.axis, r.n, { keepTargetSize: true }); }
      if (resize.length) continue;   // üyeler yeniden kuruluyor; bu grubun senkronu bir sonraki rebuild'de
    } catch (err) { console.warn('[YAGO][KAPAK-SPACING] hata:', err instanceof Error ? err.message : String(err)); }
    if (rectKey(sol.rect) === rectKey(g.rect) && Math.abs(sol.rect.front - g.rect.front) < 0.05 && sameTree(sol.tree, g.tree)) continue;
    st.updateDoorGroup(g.id, { rect: sol.rect, tree: sol.tree });
    console.log('[YAGO][KAPAK-SENKRON]', g.id, fmtRect(sol.rect), 'ağaç=', fmtTree(sol.solved), doorJointRefs(sol.tree).length ? `bağlı derz=${doorJointRefs(sol.tree).length}` : '');
  }
}

/**
 * ÖNİZLEME ÇOKGENİ (aday): dikdörtgen + dönmüş sınır panellerinin kesimi → VF düzlemindeki gövde-yerel köşeler
 * (kapağın DIŞ yüzü) + normal; levha −normal yönünde `thickness` kadar. Kesim yoksa dikdörtgenin dört köşesi.
 */
export function doorSlabPolygon(
  group: Pick<DoorGroup, 'axis' | 'side' | 'placement' | 'thickness' | 'gap' | 'anchor'>, rect: DoorRect, cuts: DoorCut[],
): { normal: Vec3; vertices: Vec3[] } {
  const m: DoorMemberRect = { leafId: PREVIEW_ID, type: 'left', leaf: 0, leafCount: 1, u0: rect.u0, u1: rect.u1, v0: rect.v0, v1: rect.v1 };
  const [mm] = applyDoorCuts({ ...group, id: PREVIEW_ID }, rect, [m], cuts);
  const g = doorMemberVfGeometry({ ...group } as DoorGroup, mm, rect);
  return { normal: g.normal, vertices: g.vertices };
}
