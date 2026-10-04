import {
  type CavityBox, type DoorBoundRef, type DoorBounds, type DoorGroup, type DoorLeafSplit, type DoorPick, type DoorRect, type DoorType, type GapSpec, type Shape, type VirtualFace,
  panelOfVf, requestRebuild, shapeById, useAppStore,
} from '../store';
import * as THREE from 'three';
import { type Vec3, genId, round1 } from './Geometry';
import { largestFaceNormal, panelHasRotation } from './FaceRegion';
import { applyGapEdit, bodyLocalBox, equalGaps, panelLocalBox, redistributeForThickness } from './PanelGroupService';

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
//  • BÖLME: cols × rows kapak; sütun genişlikleri / satır yükseklikleri raf boşluğu
//    kuralıyla (equalGaps / applyGapEdit / rescaleGaps — kilit + girilen korunur,
//    gerisi eşit); kapaklar arası boşluk (gap) sabit "kalınlık" gibi düşülür.
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
//    birden fazla kapağı seçip tek tip verebileyim"): tip HÜCRE başına (DoorGroup.cellTypes, satır-major). left /
//    right / up / down tek kanat (yalnız menteşe yönü, geometri aynı). double = hücre u'da iki KANADA, fold = v'de iki
//    kanada bölünür: hücre ölçüsü (colWidths / rowHeights — ilk bölme) TOPLAMDIR, kanatlar hücrenin içinde ayrıca
//    ölçülenir (DoorGroup.leafSplits[cell] = kanat ölçüleri + kanat arası boşluk; raf kuralı: girilen korunur, kalan
//    diğer kanada). Her kanat ayrı bir üye VF/paneldir (doorMemberRects sırası: hücreler satır-major, kanatlar ardışık).
//    Tip değişince yalnız kanat YAPISI değişen hücrelerin üyeleri yeniden kurulur (setDoorCellTypes), diğerleri korunur.
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

export const DOOR_TYPES: DoorType[] = ['left', 'right', 'up', 'down', 'double', 'fold'];
/** Kısa İngilizce etiketler (Goker: "kapak tipleri kısa bir şekilde İngilizce olsun"). */
export const DOOR_TYPE_LABEL: Record<DoorType, string> = { left: 'Left', right: 'Right', up: 'Up', down: 'Down', double: 'Double', fold: 'Fold' };
export const DOOR_TYPE_TITLE: Record<DoorType, string> = {
  left: 'Left — hinged on the left, opens to the right (as seen from the front)',
  right: 'Right — hinged on the right, opens to the left',
  up: 'Up — lift-up flap, hinged at the top',
  down: 'Down — drop-down flap, hinged at the bottom',
  double: 'Double — two leaves side by side (left + right hinged); the door is split in two, each leaf sized within the door',
  fold: 'Fold — bi-fold lift-up, two leaves stacked; the door is split in two vertically, each leaf sized within the door',
};
/** Kanat ekseni: double → u (yan yana), fold → v (üst üste); tek kanatlı tiplerde null. */
export const doorLeafAxis = (t: DoorType | undefined): 'u' | 'v' | null => (t === 'double' ? 'u' : t === 'fold' ? 'v' : null);
export const doorCellCount = (g: Pick<DoorGroup, 'cols' | 'rows'>) => g.cols * g.rows;
/** Varsayılan tip: tek sütun → left; çok sütunda sol yarı left, sağ yarı right (bir çift kapağın doğal menteşeleri). */
export const defaultDoorType = (c: number, cols: number): DoorType => (cols >= 2 && c >= cols / 2 ? 'right' : 'left');
/** Hücre tipleri (cols×rows, satır-major); kayıtlı dizi eksikse varsayılanla tamamlanır. */
export function doorCellTypes(g: Pick<DoorGroup, 'cols' | 'rows' | 'cellTypes'>): DoorType[] {
  const out: DoorType[] = [];
  for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
    const t = g.cellTypes?.[r * g.cols + c];
    out.push(t && DOOR_TYPES.includes(t) ? t : defaultDoorType(c, g.cols));
  }
  return out;
}
export const doorTypeOf = (g: Pick<DoorGroup, 'cols' | 'rows' | 'cellTypes'>, cell: number): DoorType => doorCellTypes(g)[cell] ?? 'left';
/** Toplam üye (kanat) sayısı: tek kanatlı hücre 1, double/fold 2. */
export const doorMemberCount = (g: Pick<DoorGroup, 'cols' | 'rows' | 'cellTypes'>) => doorCellTypes(g).reduce((a, t) => a + (doorLeafAxis(t) ? 2 : 1), 0);

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

// ── ÇÖZÜM ───────────────────────────────────────────────────────────────────

export interface DoorMemberRect {
  r: number; c: number; u0: number; u1: number; v0: number; v1: number;
  /** Hücre indeksi (satır-major) + hücrenin tipi; kanat sırası (0 | 1) ve hücredeki kanat sayısı (1 | 2). */
  cell: number; type: DoorType; leaf: number; leafCount: number;
  /** AÇILI REFERANS kesimi: dönmüş sınır panelleriyle kırpılmış (u,v) çokgeni (kesim yoksa yok — dikdörtgen). */
  poly?: Array<{ x: number; y: number }>;
}
export interface DoorSolution { rect: DoorRect; colWidths: GapSpec[]; rowHeights: GapSpec[]; leafSplits: Record<number, DoorLeafSplit>; members: DoorMemberRect[] }
/** Üye dikdörtgenlerini veren düzen: grup ya da çözümle güncellenmiş kopyası. */
export type DoorLayout = Pick<DoorGroup, 'rect' | 'cols' | 'rows' | 'colWidths' | 'rowHeights' | 'gap' | 'colGaps' | 'rowGaps' | 'cellTypes' | 'leafSplits'>;

/**
 * KAPAK BOŞLUKLARI — HER BİRİ AYRI (Goker, Eki 2026: "kenar boşluğu, her boşluk farklı farklı girilebilmeli";
 * önce: "kapağın panelle olan mesafelerinde de kapak boşluğu olmalı — üst, alt, sağ, sol").
 * Eksen başına n+1 boşluk: [başlangıç kenarı, n−1 ara, bitiş kenarı]. u: sol → sağ; v: ÜST → alt.
 * Kayıtlı dizi yoksa / boyu tutmuyorsa varsayılan `gap` ile doldurulur; bölmede kenarlar korunur.
 */
export function gapsOf(saved: number[] | undefined, n: number, gap: number): number[] {
  if (Array.isArray(saved) && saved.length === n + 1 && saved.every(v => Number.isFinite(v) && v >= 0)) return saved.slice();
  const out = Array.from({ length: n + 1 }, () => gap);
  if (Array.isArray(saved) && saved.length >= 2) { out[0] = saved[0]; out[n] = saved[saved.length - 1]; }   // kenarlar korunur
  return out;
}
export const colGapsOf = (g: Pick<DoorGroup, 'colGaps' | 'cols' | 'gap'>) => gapsOf(g.colGaps, g.cols, g.gap);
export const rowGapsOf = (g: Pick<DoorGroup, 'rowGaps' | 'rows' | 'gap'>) => gapsOf(g.rowGaps, g.rows, g.gap);
/** Eksendeki kapak alanı: dikdörtgen − iki kenar boşluğu (aralar ayrıca `inner` olarak düşülür). */
const doorSpan = (rect: DoorRect, axis: 'u' | 'v', gaps: number[]) => (axis === 'u' ? rect.u1 - rect.u0 : rect.v1 - rect.v0) - gaps[0] - gaps[gaps.length - 1];
const innerGaps = (gaps: number[]) => gaps.slice(1, -1);
/**
 * DAĞITIM KURALI (Goker: "girilen boşluk kapağı kısaltmamalı; boşluktan kalan ölçüyü her zaman ilk
 * başta EŞİT dağıt"): kilitli ve elle girilmiş kapak ölçüleri korunur; boşluklardan kalan ölçü diğer
 * kapaklara EŞİT dağılır (boşluk değişse de, iç/dış değişse de, gövde boyutlansa da). Hepsi girilmişse oransal.
 */
function distributeDoors(specs: GapSpec[], rect: DoorRect, axis: 'u' | 'v', gaps: number[]): GapSpec[] {
  const n = gaps.length - 1;
  const L = doorSpan(rect, axis, gaps), mids = innerGaps(gaps);
  const out = redistributeForThickness(specs, L, n - 1, mids);
  // 0,1 mm yuvarlama artığı son serbest kapağa yazılır → kenar boşluğu tam girilen değer kalır.
  const resid = round1(L - mids.reduce((a, g) => a + g, 0) - out.reduce((a, g) => a + g.value, 0));
  if (Math.abs(resid) >= 0.05 && Math.abs(resid) < 1) {
    for (let i = out.length - 1; i >= 0; i--) if (!out[i].locked && !out[i].edited) { out[i] = { ...out[i], value: round1(out[i].value + resid) }; break; }
  }
  return out;
}
const equalDoors = (rect: DoorRect, axis: 'u' | 'v', gaps: number[]) => equalGaps(doorSpan(rect, axis, gaps), gaps.length - 2, innerGaps(gaps));

/** Hücrenin kanat eksenindeki ölçüsü (double → sütun genişliği, fold → satır yüksekliği). */
export function doorCellSize(g: Pick<DoorGroup, 'cols' | 'colWidths' | 'rowHeights'>, cell: number, axis: 'u' | 'v'): number {
  const r = Math.floor(cell / g.cols), c = cell % g.cols;
  return axis === 'u' ? (g.colWidths[c]?.value ?? 0) : (g.rowHeights[r]?.value ?? 0);
}
/**
 * KANAT ÖLÇÜLERİ (Goker: "sağ ve sol kapağın ölçüsü ayrı ayrı değişebilir ama toplam ilk bölünen ölçü olsun"):
 * iki kanatlı her hücre için kanatlar hücre ölçüsünden (− kanat arası boşluk) raf kuralıyla dağıtılır — girilen /
 * kilitli kanat korunur, kalan diğerine; hiçbiri girilmemişse eşit. Hücre ölçüsü değişince (gövde boyutlandı, sütun
 * girildi) kanatlar burada yeniden çözülür. Kanat arası boşluk yoksa grubun varsayılan boşluğu.
 */
export function resolveLeafSplits(g: DoorLayout): Record<number, DoorLeafSplit> {
  const out: Record<number, DoorLeafSplit> = {};
  doorCellTypes(g).forEach((t, cell) => {
    const ax = doorLeafAxis(t);
    if (!ax) return;
    const saved = g.leafSplits?.[cell];
    const gap = Number.isFinite(saved?.gap) && saved!.gap >= 0 ? saved!.gap : g.gap;
    out[cell] = { gap, leaves: redistributeForThickness(saved?.leaves ?? [], doorCellSize(g, cell, ax), 1, [gap]) };
  });
  return out;
}

/**
 * Kapak dikdörtgeninden üye dikdörtgenleri: hücreler satır-major (sütunlar soldan sağa u↑, satırlar ÜSTTEN aşağı v↓),
 * her boşluk kendi değeriyle; iki kanatlı hücre kanatlarına bölünür (double: sol→sağ, fold: üst→alt). Sıra = üye
 * indeksi = VF.doorIndex.
 */
export function doorMemberRects(g: DoorLayout, leafSplits: Record<number, DoorLeafSplit> = resolveLeafSplits(g)): DoorMemberRect[] {
  const { rect, cols, rows, colWidths, rowHeights } = g;
  const colGaps = colGapsOf(g), rowGaps = rowGapsOf(g);
  const types = doorCellTypes(g);
  const out: DoorMemberRect[] = [];
  let top = rect.v1 - (rowGaps[0] ?? 0);
  for (let r = 0; r < rows; r++) {
    const h = rowHeights[r]?.value ?? 0;
    let left = rect.u0 + (colGaps[0] ?? 0);
    for (let c = 0; c < cols; c++) {
      const w = colWidths[c]?.value ?? 0;
      const cell = r * cols + c, type = types[cell];
      const ax = doorLeafAxis(type), split = ax ? leafSplits[cell] : undefined;
      if (ax && split && split.leaves.length === 2) {
        const [a, b] = split.leaves.map(l => Math.max(0, l.value));
        if (ax === 'u') {
          out.push({ r, c, cell, type, leaf: 0, leafCount: 2, u0: left, u1: left + a, v0: top - h, v1: top });
          out.push({ r, c, cell, type, leaf: 1, leafCount: 2, u0: left + a + split.gap, u1: left + a + split.gap + b, v0: top - h, v1: top });
        } else {
          out.push({ r, c, cell, type, leaf: 0, leafCount: 2, u0: left, u1: left + w, v0: top - a, v1: top });
          out.push({ r, c, cell, type, leaf: 1, leafCount: 2, u0: left, u1: left + w, v0: top - a - split.gap - b, v1: top - a - split.gap });
        }
      } else {
        out.push({ r, c, cell, type, leaf: 0, leafCount: 1, u0: left, u1: left + w, v0: top - h, v1: top });
      }
      left += w + (colGaps[c + 1] ?? 0);
    }
    top -= h + (rowGaps[r + 1] ?? 0);
  }
  return out;
}

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
  const cg = colGapsOf(group), rg = rowGapsOf(group);
  const colWidths = distributeDoors(group.colWidths, rect, 'u', cg);
  const rowHeights = distributeDoors(group.rowHeights, rect, 'v', rg);
  // KANATLAR: hücre ölçüleri çözüldükten sonra, hücrenin içinde (toplam = hücre ölçüsü).
  const layout: DoorLayout = { ...group, rect, colWidths, rowHeights };
  const leafSplits = resolveLeafSplits(layout);
  const members = applyDoorCuts(group, rect, doorMemberRects(layout, leafSplits), collectDoorCuts(parent, shapes));
  return { rect, colWidths, rowHeights, leafSplits, members };
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

// ── STORE İŞLEMLERİ ─────────────────────────────────────────────────────────

const groupById = (id: string) => useAppStore.getState().doorGroups.find(g => g.id === id);

function solveFromStore(group: DoorGroup): DoorSolution | null {
  const st = useAppStore.getState();
  const parent = shapeById(group.shapeId, st.shapes);
  return parent ? solveDoorGroup(group, parent, st.shapes) : null;
}

const fallbackSolution = (group: DoorGroup): DoorSolution => {
  const leafSplits = resolveLeafSplits(group);
  return { rect: group.rect, colWidths: group.colWidths, rowHeights: group.rowHeights, leafSplits, members: doorMemberRects(group, leafSplits) };
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

/** Onaylanan adaydan grup + ilk kapak (1×1) oluşturur; grup seçilir. */
export function createDoorGroupFromPick(shapeId: string, pick: DoorPick, placement: DoorGroup['placement'], name?: string): DoorGroup | null {
  const st = useAppStore.getState();
  const parent = shapeById(shapeId, st.shapes);
  if (!parent) return null;
  const rect = placement === 'inner' ? { ...pick.inner } : { ...pick.outer };
  const group: DoorGroup = {
    id: genId('door'), shapeId, axis: pick.axis, side: pick.side, placement, bounds: pick.bounds, depthRef: pick.depth, rect,
    cols: 1, rows: 1, colWidths: equalDoors(rect, 'u', [DOOR_GAP, DOOR_GAP]), rowHeights: equalDoors(rect, 'v', [DOOR_GAP, DOOR_GAP]),
    colGaps: [DOOR_GAP, DOOR_GAP], rowGaps: [DOOR_GAP, DOOR_GAP], gap: DOOR_GAP, thickness: DOOR_THICKNESS, cellTypes: ['left'], leafSplits: {},
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
  st.updateDoorGroup(group.id, { ...patch, rect: sol.rect, colWidths: sol.colWidths, rowHeights: sol.rowHeights, leafSplits: sol.leafSplits });
  console.log('[YAGO][KAPAK]', why, group.id, fmtRect(sol.rect), 'sütun=', sol.colWidths.map(g => `${g.value}${g.locked ? '🔒' : ''}`).join('/'), 'satır=', sol.rowHeights.map(g => `${g.value}${g.locked ? '🔒' : ''}`).join('/'),
    ...(Object.keys(sol.leafSplits).length ? ['kanat=', Object.entries(sol.leafSplits).map(([c, s]) => `h${c}:${s.leaves.map(l => l.value).join('+')}(${s.gap})`).join(' ')] : []));
  await requestRebuild(group.shapeId);
}

/** Kanat yapısını (eksen) karşılaştırmak için: tek kanat 'single', double 'u', fold 'v'. */
const leafKey = (t: DoorType) => doorLeafAxis(t) ?? 'single';
/** Hücre dizilerini (tip / kanat ölçüleri) yeni cols×rows'a (r,c) üzerinden taşır; yeni hücreler varsayılan alır. */
function remapCells(group: DoorGroup, nc: number, nr: number): { cellTypes: DoorType[]; leafSplits: Record<number, DoorLeafSplit> } {
  const old = doorCellTypes(group);
  const cellTypes: DoorType[] = [], leafSplits: Record<number, DoorLeafSplit> = {};
  for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) {
    const inOld = r < group.rows && c < group.cols;
    const oi = r * group.cols + c, ni = r * nc + c;
    cellTypes.push(inOld ? old[oi] : defaultDoorType(c, nc));
    if (inOld && group.leafSplits?.[oi]) leafSplits[ni] = group.leafSplits[oi];
  }
  return { cellTypes, leafSplits };
}

/**
 * BÖLME (dikeyde böl = sütun, yatayda böl = satır): üye sayısı değişince tüm üyeler
 * yeniden kurulur (satır-major sıra); genişlik/yükseklikler eşitlenir.
 */
export async function setDoorSplit(groupId: string, cols: number, rows: number): Promise<void> {
  const group = groupById(groupId);
  if (!group) return;
  const nc = Math.max(1, Math.min(MAX_DOOR_SPLIT, Math.round(cols)));
  const nr = Math.max(1, Math.min(MAX_DOOR_SPLIT, Math.round(rows)));
  if (nc === group.cols && nr === group.rows) return;
  // Kenar boşlukları korunur; yeni aralar mevcut ilk ARANIN değeriyle (yoksa varsayılan boşlukla) doğar;
  // sayı değişmediyse aralar da aynen korunur.
  const resplit = (old: number[], n: number) => (old.length === n + 1 ? old : gapsOf([old[0], old[old.length - 1]], n, old.length > 2 ? old[1] : group.gap));
  const colGaps = resplit(colGapsOf(group), nc);
  const rowGaps = resplit(rowGapsOf(group), nr);
  const colWidths = nc === group.cols ? group.colWidths : equalDoors(group.rect, 'u', colGaps);
  const rowHeights = nr === group.rows ? group.rowHeights : equalDoors(group.rect, 'v', rowGaps);
  // Hücre tipleri / kanatlar (r,c) üzerinden taşınır; yeni hücreler varsayılan tipte (sol yarı left, sağ yarı right).
  const { cellTypes, leafSplits } = remapCells(group, nc, nr);
  const next: DoorGroup = { ...group, cols: nc, rows: nr, colWidths, rowHeights, colGaps, rowGaps, cellTypes, leafSplits, memberVfIds: [] };
  const sol = solveFromStore(next) || fallbackSolution(next);
  const st = useAppStore.getState();
  // Üyeler yeniden kurulur: eski paneller + VF'ler silinir, yeni VF'ler eklenir (panelleri otomatik üretim yaratır).
  removeMembers(group.memberVfIds);
  const vfs = sol.members.map((_, i) => makeMemberVf(next, i, sol));
  next.memberVfIds = vfs.map(v => v.id);
  st.updateDoorGroup(groupId, { cols: nc, rows: nr, colGaps, rowGaps, cellTypes, leafSplits: sol.leafSplits, colWidths: sol.colWidths, rowHeights: sol.rowHeights, rect: sol.rect, memberVfIds: next.memberVfIds });
  st.insertVirtualFacesAfter(null, vfs);
  if (st.selectedDoorGroupId !== groupId && !st.selectedPanelRow) st.setSelectedDoorGroupId(groupId);
  console.log('[YAGO][KAPAK] bölme', groupId, `${group.cols}x${group.rows}`, '→', `${nc}x${nr}`, '(genişlik/yükseklikler eşitlendi) tipler=', cellTypes.join('/'));
  // Rebuild'i panel silme/ekleme izleyicisi (App) tetikler.
}

/**
 * KAPAK TİPİ ATAMA (Goker: "birden fazla kapağı seçip bir kapak tipi verebileyim"): seçilen HÜCRELERE tek tip.
 * Yalnız menteşe yönü değişiyorsa (left↔right↔up↔down, ya da double↔double) geometri aynıdır → tip yazılır, rebuild
 * yok. Kanat YAPISI değişen hücreler (tek↔double↔fold) yeniden kurulur: o hücrenin eski VF/panelleri silinir, yeni
 * kanat VF'leri eklenir (paneli otomatik üretim yaratır → rebuild). Diğer hücrelerin üyeleri (adımlarıyla) korunur;
 * yalnız doorIndex'leri yeni sıraya göre yazılır.
 */
export async function setDoorCellTypes(groupId: string, cells: number[], type: DoorType): Promise<void> {
  const group = groupById(groupId);
  if (!group || !DOOR_TYPES.includes(type)) return;
  const n = doorCellCount(group);
  const old = doorCellTypes(group);
  const next = old.slice();
  let changed = false;
  for (const c of cells) if (c >= 0 && c < n && next[c] !== type) { next[c] = type; changed = true; }
  if (!changed) return;
  const st = useAppStore.getState();
  const leafSplits: Record<number, DoorLeafSplit> = { ...(group.leafSplits ?? {}) };
  const restructured = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (leafKey(old[i]) === leafKey(next[i])) continue;
    restructured.add(i);
    if (doorLeafAxis(next[i])) leafSplits[i] = { leaves: [], gap: leafSplits[i]?.gap ?? group.gap };   // kanatlar eşit doğar
    else delete leafSplits[i];
  }
  if (!restructured.size) {
    st.updateDoorGroup(groupId, { cellTypes: next });
    console.log('[YAGO][KAPAK-TİP]', groupId, 'hücre', cells.join(','), '→', type, '(yalnız menteşe yönü, geometri aynı)');
    return;
  }
  const nextGroup: DoorGroup = { ...group, cellTypes: next, leafSplits };
  const sol = solveFromStore(nextGroup) || fallbackSolution(nextGroup);
  // Eski üyeler hücreye göre (doorIndex sırası = fallbackSolution(group).members sırası).
  const oldMembers = fallbackSolution(group).members;
  const oldByCell = new Map<number, string[]>();
  const consistent = oldMembers.length === group.memberVfIds.length;
  if (consistent) oldMembers.forEach((m, i) => { const id = group.memberVfIds[i]; if (id) oldByCell.set(m.cell, [...(oldByCell.get(m.cell) ?? []), id]); });
  else console.warn('[YAGO][KAPAK-TİP] üye sayısı tutmuyor, tüm üyeler yeniden kuruluyor:', oldMembers.length, 'vs', group.memberVfIds.length);
  const ids: string[] = [], kept: string[] = [], fresh: VirtualFace[] = [];
  sol.members.forEach((m, i) => {
    const prev = consistent && !restructured.has(m.cell) ? oldByCell.get(m.cell)?.[m.leaf] : undefined;
    if (prev) { ids.push(prev); kept.push(prev); }
    else { const vf = makeMemberVf(nextGroup, i, sol); ids.push(vf.id); fresh.push(vf); }
  });
  removeMembers(group.memberVfIds.filter(id => !kept.includes(id)));
  for (const id of kept) st.updateVirtualFace(id, { doorIndex: ids.indexOf(id) });
  st.updateDoorGroup(groupId, { cellTypes: next, leafSplits: sol.leafSplits, memberVfIds: ids, rect: sol.rect, colWidths: sol.colWidths, rowHeights: sol.rowHeights });
  // Yeni kanatlar listede korunan son üyeden sonra (yoksa sona) — grup bir arada kalır.
  const order = useAppStore.getState().virtualFaces.map(f => f.id);
  const lastKept = kept.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b)).pop() ?? null;
  st.insertVirtualFacesAfter(lastKept, fresh);
  if (st.selectedDoorGroupId !== groupId && !useAppStore.getState().selectedPanelRow) st.setSelectedDoorGroupId(groupId);
  console.log('[YAGO][KAPAK-TİP]', groupId, 'hücre', cells.join(','), '→', type, 'yeniden kurulan hücre=', [...restructured].join(','), 'korunan=', kept.length, 'yeni=', fresh.length);
  // Rebuild'i panel silme/ekleme izleyicisi (App) tetikler.
}

/**
 * KANAT ÖLÇÜSÜ (Goker: "o bölünmüş yeri ayrıca ölçülendirebileyim ama total ölçü ilk bölünen üzerinden"): iki
 * kanatlı hücrede kanat k'ya değer girilir; diğer kanat hücre ölçüsünden (− kanat arası boşluk) kalanı alır. Hücre
 * ölçüsü (sütun / satır) değişmez.
 */
export async function editDoorLeafSize(groupId: string, cell: number, k: number, value: number): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value) || value <= 0) return;
  const ax = doorLeafAxis(doorTypeOf(group, cell));
  if (!ax) return;
  const cur = resolveLeafSplits(group)[cell];
  if (!cur) return;
  const leaves = applyGapEdit(cur.leaves, k, value, doorCellSize(group, cell, ax), 1, [cur.gap]);
  await writeDoorGroup(group, { leafSplits: { ...(group.leafSplits ?? {}), [cell]: { leaves, gap: cur.gap } } }, `hücre ${cell} kanat ${k + 1} = ${value}`);
}
/** KANAT ARASI BOŞLUK (Goker: "2 kapak arası ölçülendirilebilsin"): yalnız o hücrenin iki kanadı arasındaki boşluk. */
export async function setDoorLeafGap(groupId: string, cell: number, gap: number): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(gap) || gap < 0) return;
  const cur = resolveLeafSplits(group)[cell];
  if (!cur || Math.abs(cur.gap - gap) < 0.05) return;
  await writeDoorGroup(group, { leafSplits: { ...(group.leafSplits ?? {}), [cell]: { leaves: cur.leaves, gap: round1(gap) } } }, `hücre ${cell} kanat arası = ${round1(gap)}`);
}

/** Sütun genişliği girişi (şema pill'i): applyGapEdit kuralı — girilen korunur, fark kilitsiz/girilmemişlere eşit. */
export async function editDoorColWidth(groupId: string, k: number, value: number): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value) || value <= 0) return;
  const cg = colGapsOf(group);
  const colWidths = applyGapEdit(group.colWidths, k, value, doorSpan(group.rect, 'u', cg), group.cols - 1, innerGaps(cg));
  await writeDoorGroup(group, { colWidths }, `sütun ${k + 1} = ${value}`);
}
export async function editDoorRowHeight(groupId: string, k: number, value: number): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value) || value <= 0) return;
  const rg = rowGapsOf(group);
  const rowHeights = applyGapEdit(group.rowHeights, k, value, doorSpan(group.rect, 'v', rg), group.rows - 1, innerGaps(rg));
  await writeDoorGroup(group, { rowHeights }, `satır ${k + 1} = ${value}`);
}
/** Kilit: değer değişmez; gövde boyutlanınca bu sütun/satır sabit kalır. */
export function toggleDoorColLock(groupId: string, k: number): void {
  const group = groupById(groupId);
  if (!group || k < 0 || k >= group.colWidths.length) return;
  useAppStore.getState().updateDoorGroup(groupId, { colWidths: group.colWidths.map((g, i) => (i === k ? { ...g, locked: !g.locked } : g)) });
}
export function toggleDoorRowLock(groupId: string, k: number): void {
  const group = groupById(groupId);
  if (!group || k < 0 || k >= group.rowHeights.length) return;
  useAppStore.getState().updateDoorGroup(groupId, { rowHeights: group.rowHeights.map((g, i) => (i === k ? { ...g, locked: !g.locked } : g)) });
}
/** Tüm boşluklar (kenarlar + aralar) tek değere: kilitli/girilmiş kapak ölçüleri korunur, kalan diğerlerine EŞİT (distributeDoors). */
export async function setDoorGap(groupId: string, gap: number): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(gap) || gap < 0) return;
  const g = round1(gap);
  await writeDoorGroup(group, { gap: g, colGaps: gapsOf(undefined, group.cols, g), rowGaps: gapsOf(undefined, group.rows, g) }, `tüm boşluklar = ${g}`);
}
/**
 * TEK BOŞLUK (şemadaki boşluk pill'i): axis 'col' → k = 0 sol kenar … cols sağ kenar; 'row' → k = 0 üst kenar …
 * rows alt kenar. Yalnız o boşluk değişir; fark kilitli/girilmemiş kapaklara EŞİT dağılır.
 */
export async function setDoorGapAt(groupId: string, axis: 'col' | 'row', k: number, value: number): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value) || value < 0) return;
  const v = round1(value);
  const gaps = axis === 'col' ? colGapsOf(group) : rowGapsOf(group);
  if (k < 0 || k >= gaps.length || Math.abs(gaps[k] - v) < 0.05) return;
  gaps[k] = v;
  const n = gaps.length - 1;
  const where = k === 0 ? (axis === 'col' ? 'sol kenar' : 'üst kenar') : k === n ? (axis === 'col' ? 'sağ kenar' : 'alt kenar') : `${axis === 'col' ? 'sütun' : 'satır'} arası ${k}`;
  await writeDoorGroup(group, axis === 'col' ? { colGaps: gaps } : { rowGaps: gaps }, `boşluk ${where} = ${v}`);
}
/** Tüm sütun/satırlar eşit + kilitsiz. */
export async function equalizeDoorGroup(groupId: string): Promise<void> {
  const group = groupById(groupId);
  if (!group) return;
  // Kanatlar da eşitlenir (kanat arası boşluk korunur).
  const leafSplits: Record<number, DoorLeafSplit> = {};
  for (const [c, s] of Object.entries(resolveLeafSplits(group))) leafSplits[Number(c)] = { leaves: [], gap: s.gap };
  await writeDoorGroup(group, {
    colWidths: equalDoors(group.rect, 'u', colGapsOf(group)),
    rowHeights: equalDoors(group.rect, 'v', rowGapsOf(group)),
    leafSplits,
  }, 'eşitlendi');
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
  const patch: Partial<DoorGroup> = isU
    ? { halfOverlay, colWidths: equalDoors(group.rect, 'u', colGapsOf(group)) }
    : { halfOverlay, rowHeights: equalDoors(group.rect, 'v', rowGapsOf(group)) };
  await writeDoorGroup(group, patch, `yarım binme ${edge} ${on ? 'AÇIK' : 'kapalı'} (${isU ? 'sütunlar' : 'satırlar'} eşitlendi)`);
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
    const same = (a: GapSpec[], b: GapSpec[]) => a.length === b.length && a.every((x, i) => Math.abs(x.value - b[i].value) < 0.05 && x.locked === b[i].locked);
    const leafSame = Object.keys(sol.leafSplits).every(k => { const a = sol.leafSplits[Number(k)], b = g.leafSplits?.[Number(k)]; return !!b && Math.abs(a.gap - b.gap) < 0.05 && same(a.leaves, b.leaves); });
    if (rectKey(sol.rect) === rectKey(g.rect) && Math.abs(sol.rect.front - g.rect.front) < 0.05 && same(sol.colWidths, g.colWidths) && same(sol.rowHeights, g.rowHeights) && leafSame) continue;
    st.updateDoorGroup(g.id, { rect: sol.rect, colWidths: sol.colWidths, rowHeights: sol.rowHeights, leafSplits: sol.leafSplits });
    console.log('[YAGO][KAPAK-SENKRON]', g.id, fmtRect(sol.rect), 'sütun=', sol.colWidths.map(x => x.value).join('/'), 'satır=', sol.rowHeights.map(x => x.value).join('/'));
  }
}

/**
 * ÖNİZLEME ÇOKGENİ (aday): dikdörtgen + dönmüş sınır panellerinin kesimi → VF düzlemindeki gövde-yerel köşeler
 * (kapağın DIŞ yüzü) + normal; levha −normal yönünde `thickness` kadar. Kesim yoksa dikdörtgenin dört köşesi.
 */
export function doorSlabPolygon(
  group: Pick<DoorGroup, 'axis' | 'side' | 'placement' | 'thickness' | 'gap'>, rect: DoorRect, cuts: DoorCut[],
): { normal: Vec3; vertices: Vec3[] } {
  const m: DoorMemberRect = { r: 0, c: 0, cell: 0, type: 'left', leaf: 0, leafCount: 1, u0: rect.u0, u1: rect.u1, v0: rect.v0, v1: rect.v1 };
  const [mm] = applyDoorCuts({ ...group, id: PREVIEW_ID }, rect, [m], cuts);
  const g = doorMemberVfGeometry({ ...group } as DoorGroup, mm, rect);
  return { normal: g.normal, vertices: g.vertices };
}
