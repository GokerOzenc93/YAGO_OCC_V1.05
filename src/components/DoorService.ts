import {
  type CavityBox, type DoorAlign, type DoorBoundRef, type DoorBounds, type DoorEdgeGaps, type DoorGroup, type DoorLeafSplit, type DoorNode, type DoorPick, type DoorRect, type DoorType, type GapSpec, type PanelGroup, type Shape, type VirtualFace,
  panelOfVf, requestRebuild, shapeById, useAppStore,
} from '../store';
import * as THREE from 'three';
import { type Vec3, genId, round1 } from './Geometry';
import { largestFaceNormal, panelHasRotation } from './FaceRegion';
import { applyGapEdit, bodyLocalBox, boxSpan, editGroupGap, groupFacing, memberThicknessesOf, panelLocalBox, redistributeForThickness } from './PanelGroupService';

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
//  • ŞEMADAKİ SINIR PANELLERİ + DERZ HİZALAMASI (Goker, Eki 2026: "iç kapakta ya da kapak sınırı panel yoksa kalınlığı
//    hiç gösterme; dikme/rafa 2-3 mm yaklaşan kapakta göster; dikmeyi kapağın sağına/soluna/ortalı, rafı yukarı/aşağı/
//    ortada yerleştireyim, dikme ve raf buna göre hareket etsin, aralıklar revize edilsin"): doorNearPanels — dış kapakta,
//    kapak alanına (boşluk + 3 mm) değen / yaklaşan kapak-sınırı levhaları GERÇEK konum ve kalınlığıyla (iç kapak → hiç).
//    Kapak alanının İÇİNDE bir derze (aynı eksendeki iki kapak arası) yakın duran raf/dikme ÜYESİ derze hizalanabilir
//    (DoorGroup.panelAlign: min / center / max): levha kendi grubunun o boşluğuyla taşınır (editGroupGap; applyGapEdit
//    kuralı → diğer boşluklar yeniden dağılır) ve her rebuild sonrası (syncDoorGroups) yeniden uygulanır. Dış kenardaki
//    sınır paneli (grup bounds) için hizalama YOK — orada kapak paneli izler (yarım binme). Kapak düzlemi değişmez.
// ═══════════════════════════════════════════════════════════════════════════

export const DOOR_THICKNESS = 18;
export const DOOR_GAP = 3;
const TOL = 0.5;
const MIN_DOOR_SPAN = 40;
const PREVIEW_ID = 'önizleme';
const MAX_DOOR_SPLIT = 12;

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

/** Gövdenin KAPAK SINIRI işaretli panelleri (gövde-yerel kutularıyla); kapaklar ve dönmüş paneller hariç. */
export function collectDoorBoundPanels(parent: Shape, shapes: Shape[] = useAppStore.getState().shapes, vfs: VirtualFace[] = useAppStore.getState().virtualFaces): DoorBoundPanel[] {
  const out: DoorBoundPanel[] = [];
  for (const vf of vfs) {
    if (vf.shapeId !== parent.id || !vf.doorBound || isDoorVf(vf)) continue;
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
  placement: DoorGroup['placement'], thickness: number, front: number, gap: number, half?: HalfOverlay,
): Pt2[] | null {
  if (!cuts.length) return null;
  const { u, v } = doorPlaneAxes(axis);
  let poly: Pt2[] = [{ x: m.u0, y: m.v0 }, { x: m.u1, y: m.v0 }, { x: m.u1, y: m.v1 }, { x: m.u0, y: m.v1 }];
  const planes = placement === 'outer' ? [front, front + side * thickness] : [front - side * thickness, front];   // kapak levhasının iki yüzeyi
  const cu = (m.u0 + m.u1) / 2, cv = (m.v0 + m.v1) / 2;
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
  // yan panel + dikme → "önce dışarıdaki, sonra içerdeki"); o yanda hiç sınır paneli yoksa gövde kenarı.
  const optsFor = (ax: 0 | 1 | 2, cx: 0 | 1 | 2, c: number, minSide: boolean): SideOpt[] => {
    const out: SideOpt[] = [];
    for (const bp of bounds) {
      const b = bp.box;
      const onSide = minSide ? b.max[ax] <= c + TOL : b.min[ax] >= c - TOL;
      if (!onSide) continue;
      out.push({ ref: { vfId: bp.vfId }, inner: minSide ? b.max[ax] : b.min[ax], outer: minSide ? b.min[ax] : b.max[ax], cross: [b.min[cx], b.max[cx]], front: frontOf(b), name: bp.name });
    }
    if (!out.length) out.push(minSide ? bodyOpt(body.min[ax], [body.min[cx], body.max[cx]]) : bodyOpt(body.max[ax], [body.min[cx], body.max[cx]]));
    return out;
  };
  const L = optsFor(u, v, cu, true), R = optsFor(u, v, cu, false), B = optsFor(v, u, cv, true), T = optsFor(v, u, cv, false);
  const overlaps = (cross: [number, number], a0: number, a1: number) => Math.min(cross[1], a1) - Math.max(cross[0], a0) > TOL;
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
      out.push({
        key: `${axis}${side > 0 ? '+' : '-'}:${key}@${Math.round(d.front)}`, axis, side, bounds: boundsRef,
        inner: rectAtDepth(edges, side, 'inner', d.front), outer: rectAtDepth(edges, side, 'outer', d.front),
        area: (between.u1 - between.u0) * (between.v1 - between.v0), boundPanelCount: panelN,
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
  | { id: string; kind: 'split'; axis: 'u' | 'v'; sizes: GapSpec[]; gaps: number[]; children: DoorNodeSolved[]; u0: number; u1: number; v0: number; v1: number; depth: number };
export interface DoorSolution { rect: DoorRect; tree: DoorNode; solved: DoorNodeSolved; members: DoorMemberRect[] }
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
 * AĞAÇ ÇÖZÜMÜ: kök alanı = dikdörtgen − kenar boşlukları; her split kendi alanını çocuklarına raf kuralıyla dağıtır
 * (u: soldan sağa, v: ÜSTTEN aşağı); double/fold yaprak kanatlarını kendi alanında çözer. Toplam her zaman üst alan.
 */
function solveNode(n: DoorNode, u0: number, u1: number, v0: number, v1: number, gap: number, depth: number): DoorNodeSolved {
  if (n.kind === 'leaf') {
    const ax = doorLeafAxis(n.type);
    if (!ax) return { ...n, leafSplit: undefined, u0, u1, v0, v1, depth };
    const lg = Number.isFinite(n.leafSplit?.gap) && n.leafSplit!.gap >= 0 ? n.leafSplit!.gap : gap;
    const leaves = redistributeForThickness(n.leafSplit?.leaves ?? [], ax === 'u' ? u1 - u0 : v1 - v0, 1, [lg]);
    return { ...n, leafSplit: { gap: lg, leaves }, u0, u1, v0, v1, depth };
  }
  const gaps = splitGapsOf(n, gap);
  const L = n.axis === 'u' ? u1 - u0 : v1 - v0;
  const sizes = distributeSizes(n.sizes, L, gaps);
  const children: DoorNodeSolved[] = [];
  let pos = n.axis === 'u' ? u0 : v1;
  n.children.forEach((c, i) => {
    const w = Math.max(0, sizes[i]?.value ?? 0);
    if (n.axis === 'u') { children.push(solveNode(c, pos, pos + w, v0, v1, gap, depth + 1)); pos += w + (gaps[i] ?? 0); }
    else { children.push(solveNode(c, u0, u1, pos - w, pos, gap, depth + 1)); pos -= w + (gaps[i] ?? 0); }
  });
  return { ...n, sizes, gaps, children, u0, u1, v0, v1, depth };
}
export function solveDoorTree(g: DoorLayout, rect: DoorRect = g.rect): DoorNodeSolved {
  const e = edgeGapsOf(g);
  return solveNode(g.tree, rect.u0 + e.uMin, rect.u1 - e.uMax, rect.v0 + e.vMin, rect.v1 - e.vMax, g.gap, 0);
}
/** Çözülmüş ağacı kayıt biçimine indirger (sizes/gaps/leafSplit güncel, alanlar atılır). */
export function solvedToTree(n: DoorNodeSolved): DoorNode {
  if (n.kind === 'leaf') return { id: n.id, kind: 'leaf', type: n.type, ...(n.leafSplit ? { leafSplit: n.leafSplit } : {}) };
  return { id: n.id, kind: 'split', axis: n.axis, sizes: n.sizes, gaps: n.gaps, children: n.children.map(solvedToTree) };
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
  let rect: DoorRect = rectAtDepth(edges, group.side, group.placement, P, group.halfOverlay);
  if (rect.u1 - rect.u0 < MIN_DOOR_SPAN || rect.v1 - rect.v0 < MIN_DOOR_SPAN) {
    console.warn('[YAGO][KAPAK] dikdörtgen bozuk/çok küçük, önceki korunuyor:', group.id, fmtRect(rect));
    rect = { ...group.rect };
  }
  // AĞAÇ: kök alanı dikdörtgen − kenar boşlukları; her bölme kendi alanını dağıtır (toplam = üst alan).
  const solved = solveDoorTree(group, rect);
  const members = applyDoorCuts(group, rect, doorMemberRects(solved), collectDoorCuts(parent, shapes));
  return { rect, tree: solvedToTree(solved), solved, members };
}

/** Üyeleri dönmüş sınır panelleriyle kırpar (AÇILI REFERANS); her rebuild'de güncel panellerden yeniden. */
export function applyDoorCuts(group: Pick<DoorGroup, 'axis' | 'side' | 'placement' | 'thickness' | 'gap' | 'id' | 'halfOverlay'>, rect: DoorRect, members: DoorMemberRect[], cuts: DoorCut[], silent = false): DoorMemberRect[] {
  if (!cuts.length) return members;
  let n = 0;
  const out = members.map(m => {
    const poly = clipMemberByCuts(m, cuts, group.axis, group.side, group.placement, group.thickness, rect.front, group.gap, group.halfOverlay);
    if (poly) n++;
    return poly ? { ...m, poly } : m;
  });
  if (n && !silent && group.id !== PREVIEW_ID) console.log('[YAGO][KAPAK-AÇILI]', group.id, 'dönmüş sınır paneli kesti:', cuts.map(c => c.name).join('/'), 'kesilen üye=', n, '/', members.length);
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

const NEAR_EXTRA = 3;        // kapak kenarı ile levha arasındaki "yaklaşma" payı (mm) — boşluğun üstüne
const THIN_PANEL = 60;       // şemada levha sayılacak en büyük kalınlık (mm); daha kalını (arkalık vb.) çizilmez
const JOINT_NEAR = 30;       // levha merkezi ile derz merkezi arasındaki en büyük uzaklık (mm; + yarım kalınlık + yarım derz)

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
  /** Yakınındaki derz (aynı eksen, çapraz örtüşen) — hizalama bununla. */
  joint?: DoorJoint;
  /** Kayıtlı hizalama (grubun panelAlign'ı). */
  align?: DoorAlign;
}

/**
 * DIŞ kapakta şemada gösterilecek sınır levhaları (Goker: "iç kapakta ya da sınır panel yoksa kalınlığı gösterme; 2-3 mm
 * yaklaşıyorsa göster"): kapak-sınırı işaretli, dönmemiş, ince (≤ THIN_PANEL) levhalardan kapak dikdörtgenlerinden
 * birine boşluk + 3 mm içinde değen / örtüşenler; gerçek konum ve kalınlıkla. İç kapak → boş.
 */
export function doorNearPanels(group: DoorGroup, parent: Shape, shapes: Shape[], vfs: VirtualFace[], panelGroups: PanelGroup[], members?: DoorMemberRect[]): DoorNearPanel[] {
  if (group.placement !== 'outer') return [];
  const { u, v } = doorPlaneAxes(group.axis);
  const solved = solveDoorTree(group);
  const ms = members ?? doorMemberRects(solved);
  const joints = doorJoints(solved);
  const near = Math.max(group.gap, 0) + NEAR_EXTRA;
  const front = group.rect.front;
  const edgeOf = (vfId: string): DoorEdgeKey | undefined => (['uMin', 'uMax', 'vMin', 'vMax'] as DoorEdgeKey[]).find(k => group.bounds[k]?.vfId === vfId);
  const out: DoorNearPanel[] = [];
  for (const bp of collectDoorBoundPanels(parent, shapes, vfs)) {
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
    // Derz: aynı eksen, çapraz örtüşen, merkezleri yakın (en yakını). Kenar levhasında aranmaz.
    let joint: DoorJoint | undefined;
    if (!edge) {
      const pc = (a0 + a1) / 2, t = a1 - a0;
      let best = Infinity;
      for (const j of joints) {
        if (j.axis !== kind || Math.min(j.c1, c1) - Math.max(j.c0, c0) < TOL) continue;
        const d = Math.abs((j.p0 + j.p1) / 2 - pc);
        if (d <= t / 2 + (j.p1 - j.p0) / 2 + JOINT_NEAR && d < best) { best = d; joint = j; }
      }
    }
    out.push({ vfId: bp.vfId, panelId: bp.panelId, name: bp.name, kind, a0, a1, c0, c1, behind, edge, groupId: pg?.id, memberIndex, joint, align: group.panelAlign?.[bp.vfId] });
  }
  return out;
}

/** Hizalamanın istediği levha min koordinatı (kind ekseni). */
export function alignedPanelMin(np: Pick<DoorNearPanel, 'a0' | 'a1' | 'joint'>, align: DoorAlign): number | null {
  if (!np.joint) return null;
  const t = np.a1 - np.a0, { p0, p1 } = np.joint;
  return align === 'min' ? p0 - t : align === 'max' ? p1 : (p0 + p1) / 2 - t / 2;
}

/** Son deneme (döngü kilidi): aynı hedef konum için levha hiç kımıldamadıysa yeniden denenmez (çözücü boşluğu onurlandıramıyor). */
const _alignAttempt = new Map<string, { want: number; a0: number }>();
/**
 * DERZ HİZALAMASINI UYGULA: kayıtlı hizalaması olan her iç levha için üyenin grubundaki boşluk, levha istenen yere gelecek
 * şekilde yazılır (facing'e göre işaret; applyGapEdit → diğer boşluklar yeniden dağılır → "aralıkları revize et").
 * Yalnız fark ≥ 0,05 mm ve boşluk tam yazılabiliyorsa (kilitli komşular kırpmıyorsa, ≥ 0) çağrılır; aynı hedef için levha
 * son denemeden beri hiç kımıldamadıysa (çözücü onurlandıramadı) döngüye girmemek için atlanır. Döner: tetiklenen taşıma sayısı.
 */
export function applyDoorPanelAligns(group: DoorGroup, parent: Shape, shapes: Shape[], vfs: VirtualFace[], panelGroups: PanelGroup[], members?: DoorMemberRect[]): number {
  if (!group.panelAlign || !Object.keys(group.panelAlign).length) return 0;
  let n = 0;
  for (const np of doorNearPanels(group, parent, shapes, vfs, panelGroups, members)) {
    const align = group.panelAlign[np.vfId];
    if (!align || !np.joint || !np.groupId || np.memberIndex == null || np.memberIndex < 0) continue;
    const pg = panelGroups.find(g => g.id === np.groupId);
    if (!pg) continue;
    const { u, v } = doorPlaneAxes(group.axis);
    const want = alignedPanelMin(np, align);
    if (want == null) continue;
    const delta = want - np.a0;
    const key = `${group.id}:${np.vfId}`;
    if (Math.abs(delta) < 0.05) { _alignAttempt.delete(key); continue; }
    if (pg.axis !== (np.kind === 'u' ? u : v)) { console.warn('[YAGO][KAPAK-HİZA] grubun dizilim ekseni levhanın kalınlık ekseni değil, taşınamaz:', np.name, pg.id); continue; }
    const k = np.memberIndex;
    const cur = pg.gaps[k]?.value;
    if (cur == null) continue;
    const next = round1(cur + groupFacing(pg) * delta);
    if (next < 0) { console.warn('[YAGO][KAPAK-HİZA] istenen boşluk negatif, atlandı:', np.name, next); continue; }
    const sim = applyGapEdit(pg.gaps, k, next, boxSpan(pg.cavity, pg.axis), pg.count, memberThicknessesOf(pg));
    if (Math.abs((sim[k]?.value ?? NaN) - next) > 0.05) { console.warn('[YAGO][KAPAK-HİZA] boşluk yazılamıyor (kilitli komşular), atlandı:', np.name, next); continue; }
    const last = _alignAttempt.get(key);
    if (last && Math.abs(last.want - want) < 0.05 && Math.abs(last.a0 - np.a0) < 0.05) { console.warn('[YAGO][KAPAK-HİZA] aynı hedef için levha kımıldamadı — döngü kilidi, yeniden denenmiyor:', np.name, want.toFixed(1)); continue; }
    _alignAttempt.set(key, { want, a0: np.a0 });
    console.log('[YAGO][KAPAK-HİZA]', group.id, np.name, '→', align, 'derz', `${np.joint.p0.toFixed(1)}..${np.joint.p1.toFixed(1)}`, 'Δ=', delta.toFixed(1), 'boşluk', k, cur, '→', next);
    void editGroupGap(pg.id, k, next);
    n++;
  }
  return n;
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
    id: genId('door'), shapeId, axis: pick.axis, side: pick.side, placement, bounds: pick.bounds, depthRef: pick.depth, rect,
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

/** Çözümü üye VF'lere yazar ve grubu günceller; tam rebuild. */
async function writeDoorGroup(group: DoorGroup, patch: Partial<DoorGroup>, why: string): Promise<void> {
  const st = useAppStore.getState();
  const next: DoorGroup = { ...group, ...patch };
  const sol = solveFromStore(next) || fallbackSolution(next);
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
 *  • Aynı eksenli split → çocuk sayısı değişir: artınca sona eşit kapaklar eklenir, azalınca sondakiler gider
 *    (ölçüler eşitlenir); count = 1 → split tek kapağa iner (BİRLEŞTİRME; tip = ilk kapağın tipi).
 *  • Diğer eksenli split + count ≥ 2 → alan SARILIR: yeni split'in ilk parçası mevcut bölme, gerisi yeni kapaklar
 *    (içerik kaybolmaz; 1'e indirince eski bölme geri gelir).
 * Üst bölmelerin ölçüleri değişmez. Dönüş: sonuç düğümün id'si (arayüz seçimi orada tutar) — işlem yoksa null.
 */
export function setDoorNodeSplit(groupId: string, nodeId: string, axis: 'u' | 'v', count: number): string | null {
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
      const first = doorLeaves(node)[0];
      const leaf = makeDoorLeaf(first && !doorLeafAxis(first.type) ? first.type : 'left');
      rebuildMembers(group, { ...group, tree: replaceDoorNode(group.tree, node.id, () => leaf) }, new Set(doorLeaves(node).map(l => l.id)), 'birleştirme (×1)');
      return leaf.id;
    }
    const restructured = new Set<string>();
    let children = node.children.slice();
    if (n > children.length) children = [...children, ...newLeaves(n - children.length, children.length, n, 'left')];
    else { for (const c of children.slice(n)) for (const l of doorLeaves(c)) restructured.add(l.id); children = children.slice(0, n); }
    const next: DoorNode = { ...node, children, gaps: gapsFor(n - 1, node.gaps), sizes: [] };   // ölçüler eşitlenir
    rebuildMembers(group, { ...group, tree: replaceDoorNode(group.tree, node.id, () => next) }, restructured, `bölme sayısı ${node.children.length} → ${n}`);
    return node.id;
  }
  if (n <= 1) return node.id;
  const wrap: DoorNode = { id: genId('ds'), kind: 'split', axis, sizes: [], gaps: gapsFor(n - 1), children: [node, ...newLeaves(n - 1, 1, n, 'left')] };
  rebuildMembers(group, { ...group, tree: replaceDoorNode(group.tree, node.id, () => wrap) }, new Set(), `sarma ${axis === 'u' ? 'V' : 'H'} ×${n}`);
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
export async function editDoorLeafSize(groupId: string, leafId: string, k: number, value: number): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value) || value <= 0) return;
  const sn = findSolvedNode(solveDoorTree(group), leafId);
  if (!sn || sn.kind !== 'leaf' || !sn.leafSplit) return;
  const ax = doorLeafAxis(sn.type)!;
  const leaves = applyGapEdit(sn.leafSplit.leaves, k, value, ax === 'u' ? sn.u1 - sn.u0 : sn.v1 - sn.v0, 1, [sn.leafSplit.gap]);
  const tree = replaceDoorNode(group.tree, leafId, old => ({ ...old, leafSplit: { leaves, gap: sn.leafSplit!.gap } } as DoorNode));
  await writeDoorGroup(group, { tree }, `kanat ${k + 1} = ${value}`);
}
/** KANAT ARASI BOŞLUK (Goker: "2 kapak arası ölçülendirilebilsin"): yalnız o yaprağın iki kanadı arasındaki boşluk. */
export async function setDoorLeafGap(groupId: string, leafId: string, gap: number): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(gap) || gap < 0) return;
  const sn = findSolvedNode(solveDoorTree(group), leafId);
  if (!sn || sn.kind !== 'leaf' || !sn.leafSplit || Math.abs(sn.leafSplit.gap - gap) < 0.05) return;
  const tree = replaceDoorNode(group.tree, leafId, old => ({ ...old, leafSplit: { leaves: sn.leafSplit!.leaves, gap: round1(gap) } } as DoorNode));
  await writeDoorGroup(group, { tree }, `kanat arası = ${round1(gap)}`);
}

/** BÖLME ÖLÇÜSÜ (şema pill'i): split düğümünün k. çocuğuna değer; fark kilitsiz/girilmemiş kardeşlere EŞİT (applyGapEdit). */
export async function editDoorSize(groupId: string, splitId: string, k: number, value: number): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value) || value <= 0) return;
  const sn = findSolvedNode(solveDoorTree(group), splitId);
  if (!sn || sn.kind !== 'split') return;
  const L = sn.axis === 'u' ? sn.u1 - sn.u0 : sn.v1 - sn.v0;
  const sizes = applyGapEdit(sn.sizes, k, value, L, sn.gaps.length, sn.gaps);
  const tree = replaceDoorNode(group.tree, splitId, old => ({ ...(old as any), sizes }));
  await writeDoorGroup(group, { tree }, `ölçü ${k + 1} = ${value}`);
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
export async function setDoorSplitGap(groupId: string, splitId: string, k: number, value: number): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value) || value < 0) return;
  const sn = findSolvedNode(solveDoorTree(group), splitId);
  if (!sn || sn.kind !== 'split' || k < 0 || k >= sn.gaps.length || Math.abs(sn.gaps[k] - value) < 0.05) return;
  const gaps = sn.gaps.slice(); gaps[k] = round1(value);
  const tree = replaceDoorNode(group.tree, splitId, old => ({ ...(old as any), gaps }));
  await writeDoorGroup(group, { tree }, `ara boşluk ${k + 1} = ${round1(value)}`);
}
/** KENAR BOŞLUĞU (sol/sağ/alt/üst): yalnız o kenar değişir. */
export async function setDoorEdgeGap(groupId: string, edge: DoorEdgeKey, value: number): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value) || value < 0) return;
  const e = edgeGapsOf(group);
  if (Math.abs(e[edge] - value) < 0.05) return;
  await writeDoorGroup(group, { edgeGaps: { ...e, [edge]: round1(value) } }, `kenar boşluğu ${edge} = ${round1(value)}`);
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
 * DERZ HİZALAMASI (Goker: "dikmeyi kapağın sağına / soluna / ortalı, rafı yukarı / aşağı / ortada yerleştireyim"): iç
 * levhanın hizalaması yazılır ve hemen uygulanır (levhanın grubu taşınır → rebuild). null = serbest (levha olduğu yerde).
 */
export function setDoorPanelAlign(groupId: string, vfId: string, align: DoorAlign | null): void {
  const group = groupById(groupId);
  if (!group) return;
  const panelAlign = { ...(group.panelAlign ?? {}) };
  if (align) panelAlign[vfId] = align; else delete panelAlign[vfId];
  const st = useAppStore.getState();
  st.updateDoorGroup(groupId, { panelAlign });
  _alignAttempt.delete(`${groupId}:${vfId}`);
  console.log('[YAGO][KAPAK-HİZA]', groupId, vfId, '→', align ?? 'serbest');
  const parent = shapeById(group.shapeId, st.shapes);
  if (parent && align) applyDoorPanelAligns({ ...group, panelAlign }, parent, st.shapes, st.virtualFaces, st.panelGroups);
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

/** REBUILD SONRASI SENKRON (PanelEngine): grubun store'daki dikdörtgeni/ölçüleri güncel çözümle eşitlenir. */
export function syncDoorGroups(parentShapeId: string): void {
  const st = useAppStore.getState();
  const parent = shapeById(parentShapeId, st.shapes);
  if (!parent) return;
  for (const g of st.doorGroups) {
    if (g.shapeId !== parentShapeId) continue;
    const sol = solveDoorGroup(g, parent, st.shapes);
    if (!sol) continue;
    const sameTree = (a: DoorNode, b: DoorNode): boolean => {
      if (a.kind !== b.kind || a.id !== b.id) return false;
      if (a.kind === 'leaf' || b.kind === 'leaf') {
        const la = (a as any).leafSplit as DoorLeafSplit | undefined, lb = (b as any).leafSplit as DoorLeafSplit | undefined;
        if (!la && !lb) return true;
        return !!la && !!lb && Math.abs(la.gap - lb.gap) < 0.05 && la.leaves.length === lb.leaves.length && la.leaves.every((x, i) => Math.abs(x.value - lb.leaves[i].value) < 0.05);
      }
      return a.children.length === b.children.length && a.sizes.length === b.sizes.length && a.sizes.every((x, i) => Math.abs(x.value - b.sizes[i].value) < 0.05 && x.locked === b.sizes[i].locked)
        && a.gaps.length === b.gaps.length && a.gaps.every((x, i) => Math.abs(x - b.gaps[i]) < 0.05) && a.children.every((c, i) => sameTree(c, b.children[i]));
    };
    // DERZ HİZALAMASI (bağ): gövde boyutlandı / kapak ölçüsü değişti → hizalı levhalar derzi izler (fark yoksa hiçbir şey olmaz).
    try { applyDoorPanelAligns({ ...g, rect: sol.rect, tree: sol.tree }, parent, st.shapes, st.virtualFaces, st.panelGroups, sol.members); }
    catch (err) { console.warn('[YAGO][KAPAK-HİZA] hata:', err instanceof Error ? err.message : String(err)); }
    if (rectKey(sol.rect) === rectKey(g.rect) && Math.abs(sol.rect.front - g.rect.front) < 0.05 && sameTree(sol.tree, g.tree)) continue;
    st.updateDoorGroup(g.id, { rect: sol.rect, tree: sol.tree });
    console.log('[YAGO][KAPAK-SENKRON]', g.id, fmtRect(sol.rect), 'ağaç=', fmtTree(sol.solved));
  }
}

/**
 * ÖNİZLEME ÇOKGENİ (aday): dikdörtgen + dönmüş sınır panellerinin kesimi → VF düzlemindeki gövde-yerel köşeler
 * (kapağın DIŞ yüzü) + normal; levha −normal yönünde `thickness` kadar. Kesim yoksa dikdörtgenin dört köşesi.
 */
export function doorSlabPolygon(
  group: Pick<DoorGroup, 'axis' | 'side' | 'placement' | 'thickness' | 'gap'>, rect: DoorRect, cuts: DoorCut[],
): { normal: Vec3; vertices: Vec3[] } {
  const m: DoorMemberRect = { leafId: PREVIEW_ID, type: 'left', leaf: 0, leafCount: 1, u0: rect.u0, u1: rect.u1, v0: rect.v0, v1: rect.v1 };
  const [mm] = applyDoorCuts({ ...group, id: PREVIEW_ID }, rect, [m], cuts);
  const g = doorMemberVfGeometry({ ...group } as DoorGroup, mm, rect);
  return { normal: g.normal, vertices: g.vertices };
}
