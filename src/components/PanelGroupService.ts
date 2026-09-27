import * as THREE from 'three';
import {
  type CavityBox, type CavityPick, type GapSpec, type PanelGroup, type Shape, type VirtualFace, panelOfVf, requestRebuild, shapeById, useAppStore,
} from '../store';
import { type Vec3, effectiveBodyGeometry, genId, getFacesAndGroups, isFlatNormal, localBboxOf, round1, vertexModsKey } from './Geometry';
import { panelHasRotation } from './FaceRegion';

// ═══════════════════════════════════════════════════════════════════════════
// RAF / DİKME GRUPLARI (PanelGroupService)
//
// SÖZLEŞME
//  • Grup = seçilen ŞEKİLLİ HACİM (serbest bölge) + n panel + n+1 boşluk.
//    Hacim bir kutu DEĞİLDİR: gövde kutusu, gövde katısının eksen-hizalı yüz
//    düzlemleri ve kardeş panel kutularının düzlemleriyle hücrelere bölünür
//    (CavityGrid); bir hücre gövde katısının İÇİNDE ve hiçbir panelin içinde
//    değilse serbesttir. Tohumdan (çıpa) yüz-komşu serbest hücrelere taşılarak
//    bağlantılı bölge bulunur (floodRegion). Çentikli/çıkarmalı gövdede bölge
//    L/U/çentikli olur; her raf KENDİ yüksekliğindeki kesitin (dilim boyunca
//    tüm katmanlarda serbest hücrelerin) sınır çokgenini alır (sectionPolygon).
//  • Çıpa (anchorFrac) tohum noktasıdır (kutu merkezi değil — L bölgede merkez
//    dışarıda kalabilir); küp boyutlanınca oransal kayar, hücre serbest değilse
//    en yakın serbest hücreye düşer.
//  • Boşluk kuralı: ilk dağılım EŞİT. Bir boşluk girilince fark, kilitsiz ve
//    henüz girilmemiş boşluklara eşit dağılır. Küp boyutlanınca KİLİTLİ boşluk
//    sabit kalır; kilitsizler oranları korunarak yeni açıklığa ölçeklenir:
//    Σgap + n·t = L (bölge kutusunun dizilim eksenindeki açıklığı).
//  • Gövde paneli ↔ iç panel ilişkisi VF SIRASIDIR (basan/basılan): sırada
//    üyelerden ÖNCE gelen gövde paneli hacmi sınırlar; SONRA gelen gövde
//    panelini üyeler damgalar (bölgesi kırpılır, motor keser). Bir iç grup
//    yalnız KENDİNDEN ÖNCE oluşturulmuş iç grupların panelleriyle sınırlanır.
//  • Üye paneller sıradan VF-panelleridir: extrude / move / rotate adımları
//    motorda aynı yoldan uygulanır; VF (çözülmüş kesit) her rebuild'de yazılır.
// ═══════════════════════════════════════════════════════════════════════════

export const GROUP_PANEL_THICKNESS = 18;
const TOL = 0.5;
const MIN_GAP = 0;

export const isInteriorPanel = (p: any): boolean => !!p?.parameters?.panelGroupId;
export const isInteriorVf = (vf: any): boolean => !!vf?.interior;
export const groupKindLabel = (k: PanelGroup['kind']) => (k === 'shelf' ? 'Shelf' : 'Divider');
const groupAxisOf = (k: PanelGroup['kind']): 0 | 1 | 2 => (k === 'shelf' ? 1 : 0);

const r1 = round1;
const cloneBox = (b: CavityBox): CavityBox => ({ min: [...b.min] as Vec3, max: [...b.max] as Vec3 });
export const boxSpan = (b: CavityBox, a: number) => b.max[a] - b.min[a];
export const fmtBox = (b: CavityBox) => `${b.min.map(n => n.toFixed(0)).join(',')}..${b.max.map(n => n.toFixed(0)).join(',')}`;
const boxCenter = (b: CavityBox): Vec3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
/** Gövde kutusundaki oran ↔ nokta. */
const fracInCavity = (body: CavityBox, p: Vec3, clamp = false): Vec3 => [0, 1, 2].map(a => {
  const s = body.max[a] - body.min[a];
  if (s <= 1e-6) return clamp ? 0.5 : 0;
  const f = (p[a] - body.min[a]) / s;
  return clamp ? Math.max(0, Math.min(1, f)) : f;
}) as Vec3;
const pointFromFrac = (body: CavityBox, f: Vec3): Vec3 => [0, 1, 2].map(a => body.min[a] + f[a] * (body.max[a] - body.min[a])) as Vec3;
type Pt2 = { x: number; y: number };

// ── KUTULAR ─────────────────────────────────────────────────────────────────

const toCavityBox = (bb: THREE.Box3): CavityBox => ({ min: [bb.min.x, bb.min.y, bb.min.z], max: [bb.max.x, bb.max.y, bb.max.z] });

/** Gövdenin (vertex düzenlemeli etkin) yerel sınır kutusu. */
function bodyLocalBox(parent: Shape): CavityBox | null {
  const bb = localBboxOf(effectiveBodyGeometry(parent));
  return bb ? toCavityBox(bb) : null;
}

/** Panelin gövde-yerel kutusu (geometri gövde çerçevesindedir; konum farkı eklenir). */
function panelLocalBox(p: Shape, parent: Shape): CavityBox | null {
  const bb = localBboxOf(p.geometry);
  if (!bb || (p.geometry.getAttribute('position') as THREE.BufferAttribute).count === 0) return null;
  const d = [0, 1, 2].map(i => (p.position?.[i] ?? 0) - (parent.position?.[i] ?? 0));
  return toCavityBox(bb.translate(new THREE.Vector3(d[0], d[1], d[2])));
}

// ── HÜCRE IZGARASI (CavityGrid) ─────────────────────────────────────────────

export interface CavityGrid {
  body: CavityBox;
  xs: number[]; ys: number[]; zs: number[];
  nx: number; ny: number; nz: number;
  /** 1 = serbest (gövde içinde, panel dışında). */
  free: Uint8Array;
  /** Izgarayı kuran engel (panel) kutuları — panel-derinliği alternatifleri için. */
  obstacles?: CavityBox[];
  /** Dönmüş/eğik panellerin büyük yüzleri: kutu değil YARIM-UZAY olarak sınırlar (tohum tarafına göre yönlenir). */
  tiltFaces?: TiltFace[];
}

// ── EĞİK PANELLER = YARIM-UZAY ──────────────────────────────────────────────
// Dönmüş / eğik bir panel (Goker: "sağ panel açılı yerleşmiş olmasına rağmen
// kırmızı yer düz görünüyor") kutusuyla engel sayılırsa bölge eğik yüzeye kadar
// gitmez, kama boşluğu kaybolur. Bu paneller ızgarada engel DEĞİLDİR; yalnız
// kutularının düzlemleri hücre bölmesine girer. Bölge, kesitler, önizleme ve
// kutu açıklığı, panelin tohuma bakan büyük yüzünün yarım-uzayıyla kırpılır.
// Üye VF'ler, panel VF sırasında ÖNCE ise (basan) uzak dilim yüzüne kadar
// uzatılır ki motor (cutByRotatedPressers) ucu eğime göre pahlasın; panel
// sonra ise yakın yüze kadar (asla iç içe geçmez).
interface TiltFace { id: string; vfId?: string; n: Vec3; d: number; bbox: CavityBox }
interface TiltPlane extends TiltFace { bevel?: boolean }
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** Düzlemin "kapsama" eksenleri: normale en az hizalı iki eksen (panelin yayıldığı yönler). */
const planeSpanAxes = (pl: TiltFace): [number, number] => {
  const a = [0, 1, 2].sort((x, y) => Math.abs(pl.n[x]) - Math.abs(pl.n[y]));
  return [a[0], a[1]];
};
/** Nokta panelin yayıldığı alanın (kutu, yayılma eksenlerinde) içinde mi? */
const inPlaneRange = (pl: TiltFace, p: Vec3, tol = 2): boolean => {
  const [a, b] = planeSpanAxes(pl);
  return p[a] >= pl.bbox.min[a] - tol && p[a] <= pl.bbox.max[a] + tol && p[b] >= pl.bbox.min[b] - tol && p[b] <= pl.bbox.max[b] + tol;
};
/** Nokta tüm eğik yarım-uzayların içinde mi (kapsama dışındaki düzlem uygulanmaz)? */
const insideTiltPlanes = (planes: TiltPlane[], p: Vec3): boolean =>
  planes.every(pl => !inPlaneRange(pl, p) || dot3(pl.n, p) >= pl.d - TOL);
/** Hücre (kutu) yarım-uzayla KESİŞİYOR mu — herhangi bir köşesi içerideyse hücre bölgeye alınır;
 *  düzlemi kesen hücrenin arka parçası kesit/önizlemede kırpılır (merkez testi kamayı kaybediyordu). */
const cellInsideTiltPlanes = (planes: TiltPlane[], b: CavityBox): boolean => planes.every(pl => {
  if (!inPlaneRange(pl, boxCenter(b))) return true;
  let best = -Infinity;
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) best = Math.max(best, dot3(pl.n, [x, y, z]) - pl.d);
  return best >= TOL;
});

/** Dönmüş/eğik panellerin iki büyük yüzü (gövde-yerel düzlemler). */
function tiltedPanelFaces(parent: Shape, panels: Shape[]): TiltFace[] {
  const out: TiltFace[] = [];
  for (const p of panels) {
    if (!panelHasRotation(p) || !p.geometry) continue;
    const bbox = panelLocalBox(p, parent);
    if (!bbox) continue;
    const dpos = [0, 1, 2].map(i => (p.position?.[i] ?? 0) - (parent.position?.[i] ?? 0));
    const groups = getFacesAndGroups(p.geometry).groups.slice().sort((a, b) => b.totalArea - a.totalArea).slice(0, 2);
    for (const gr of groups) {
      const n = gr.normal.clone().normalize();
      const c: Vec3 = [gr.center.x + dpos[0], gr.center.y + dpos[1], gr.center.z + dpos[2]];
      const nn: Vec3 = [n.x, n.y, n.z];
      out.push({ id: p.id, vfId: (p.parameters as any)?.virtualFaceId, n: nn, d: dot3(nn, c), bbox });
    }
  }
  return out;
}

/** Tohumun bulunduğu tarafa bakan yüz seçilir → panel başına en fazla bir yarım-uzay (n·p ≥ d). */
function orientTiltPlanes(faces: TiltFace[] | undefined, seed: Vec3): TiltPlane[] {
  if (!faces?.length) return [];
  const best = new Map<string, TiltPlane>();
  for (const f of faces) {
    const side = dot3(f.n, seed) - f.d;
    if (side <= 0) continue;
    const cur = best.get(f.id);
    if (!cur || side < dot3(cur.n, seed) - cur.d) best.set(f.id, { ...f });
  }
  return Array.from(best.values());
}

type Pt3 = Vec3;
/** Kutunun 6 yüz dörtgeni (3B). */
const boxFaces = (b: CavityBox): Pt3[][] => {
  const [x0, y0, z0] = b.min, [x1, y1, z1] = b.max;
  return [
    [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]],
    [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
  ];
};

/**
 * Bölgenin GERÇEK dış kutusu (hacmin en dış sınırları): eğik düzlemi kesen her
 * hücre yarım-uzaylarla kırpılır (dışbükey çokyüzlü) ve köşelerinin kutusu
 * alınır. Dizilim açıklığı L bunu okur. Eski yol (kutuyu tohum DOĞRUSU boyunca
 * kırpmak) açıklığı tıklanan noktaya bağlıyordu: eğik panelin altındaki üçgen
 * bölgede dikme, hacmin dış sınırlarına göre değil tıklanan yüksekliğe göre
 * ortalanıyordu (Goker: "taralı dikme en dış hacmin sınırlarına göre ortalanmıyor").
 */
function clippedRegionBBox(g: CavityGrid, cells: Set<number>, planes: TiltPlane[]): CavityBox {
  const raw = regionBBox(g, cells);
  if (!planes.length || !cells.size) return raw;
  const out: CavityBox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const take = (p: Pt3) => { for (let a = 0; a < 3; a++) { if (p[a] < out.min[a]) out.min[a] = p[a]; if (p[a] > out.max[a]) out.max[a] = p[a]; } };
  for (const c of cells) {
    const b = cellBox(g, c);
    const active = planes.filter(pl => inPlaneRange(pl, boxCenter(b)));
    if (!active.length) { take(b.min); take(b.max); continue; }
    // Kırpılmış çokyüzlünün tüm köşeleri kırpılmış kutu yüzlerinde ya da düzlem kesitlerindedir.
    for (const face of boxFaces(b)) {
      let poly = face;
      for (const pl of active) { poly = clipPoly3D(poly, pl.n, pl.d); if (poly.length < 3) break; }
      if (poly.length >= 3) for (const p of poly) take(p);
    }
    for (const pl of active) {
      let poly = planeBoxSection(pl.n, pl.d, b);
      if (!poly) continue;
      for (const other of active) { if (other === pl) continue; poly = clipPoly3D(poly, other.n, other.d); if (poly.length < 3) break; }
      if (poly.length >= 3) for (const p of poly) take(p);
    }
  }
  if (!Number.isFinite(out.min[0]) || !Number.isFinite(out.max[0])) return raw;
  for (let a = 0; a < 3; a++) { out.min[a] = Math.max(out.min[a], raw.min[a]); out.max[a] = Math.min(out.max[a], raw.max[a]); if (out.max[a] - out.min[a] < 1) { out.min[a] = raw.min[a]; out.max[a] = raw.max[a]; } }
  if (fmtBox(out) !== fmtBox(raw)) console.log('[YAGO][HACİM-KUTU] eğik kırpım: ham=', fmtBox(raw), '→ dış sınır=', fmtBox(out));
  return out;
}
/** Sutherland–Hodgman: 3B çokgeni n·p ≥ d yarım-uzayına kırpar. */
function clipPoly3D(poly: Pt3[], n: Vec3, d: number): Pt3[] {
  const out: Pt3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = dot3(n, a) - d, db = dot3(n, b) - d;
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) { const t = da / (da - db); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); }
  }
  return out;
}
/** Sutherland–Hodgman (2B): a·u + b·v ≥ c. */
function clipPoly2D(poly: Pt2[], a: number, b: number, c: number): Pt2[] {
  const out: Pt2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const dp = a * p.x + b * p.y - c, dq = a * q.x + b * q.y - c;
    if (dp >= 0) out.push(p);
    if ((dp >= 0) !== (dq >= 0)) { const t = dp / (dp - dq); out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }); }
  }
  return out;
}
/** Düzlem ∩ kutu kesit çokgeni (dışbükey, sıralı). */
function planeBoxSection(n: Vec3, d: number, b: CavityBox): Pt3[] | null {
  const M = Math.max(boxSpan(b, 0), boxSpan(b, 1), boxSpan(b, 2)) * 4 + 10;
  const c = boxCenter(b);
  const k = dot3(n, c) - d;
  const o: Vec3 = [c[0] - n[0] * k, c[1] - n[1] * k, c[2] - n[2] * k];   // düzlem üzerinde merkez izdüşümü
  const ax = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u: Vec3 = [n[1] * ax[2] - n[2] * ax[1], n[2] * ax[0] - n[0] * ax[2], n[0] * ax[1] - n[1] * ax[0]];
  const lu = Math.hypot(u[0], u[1], u[2]) || 1; u[0] /= lu; u[1] /= lu; u[2] /= lu;
  const v: Vec3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  let poly: Pt3[] = [[-M, -M], [M, -M], [M, M], [-M, M]].map(([a, bb]) => [o[0] + u[0] * a + v[0] * bb, o[1] + u[1] * a + v[1] * bb, o[2] + u[2] * a + v[2] * bb] as Vec3);
  for (let a = 0; a < 3; a++) {
    const e: Vec3 = [0, 0, 0]; e[a] = 1;
    poly = clipPoly3D(poly, e, b.min[a]); if (poly.length < 3) return null;
    const e2: Vec3 = [0, 0, 0]; e2[a] = -1;
    poly = clipPoly3D(poly, e2, -b.max[a]); if (poly.length < 3) return null;
  }
  return poly;
}
const polyCentroid = (poly: Pt3[]): Vec3 => { const c: Vec3 = [0, 0, 0]; for (const p of poly) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; } return [c[0] / poly.length, c[1] / poly.length, c[2] / poly.length]; };

/** Bölge dış yüzeyi eğik yarım-uzaylarla kırpılır + kesim yüzeyleri (kapaklar) eklenir. */
function clipSurfaceByPlanes(g: CavityGrid, cells: Set<number>, surface: number[], planes: TiltPlane[]): number[] {
  if (!planes.length) return surface;
  const out: number[] = [];
  const fan = (poly: Pt3[]) => { for (let i = 1; i < poly.length - 1; i++) out.push(...poly[0], ...poly[i], ...poly[i + 1]); };
  for (let t = 0; t < surface.length; t += 9) {
    let poly: Pt3[] = [[surface[t], surface[t + 1], surface[t + 2]], [surface[t + 3], surface[t + 4], surface[t + 5]], [surface[t + 6], surface[t + 7], surface[t + 8]]];
    for (const pl of planes) {
      if (!inPlaneRange(pl, polyCentroid(poly))) continue;
      poly = clipPoly3D(poly, pl.n, pl.d);
      if (poly.length < 3) break;
    }
    if (poly.length >= 3) fan(poly);
  }
  for (const pl of planes) {
    for (const c of cells) {
      const b = cellBox(g, c);
      if (!inPlaneRange(pl, boxCenter(b))) continue;
      let poly = planeBoxSection(pl.n, pl.d, b);
      if (!poly) continue;
      for (const other of planes) {
        if (other === pl || !inPlaneRange(other, polyCentroid(poly))) continue;
        poly = clipPoly3D(poly, other.n, other.d);
        if (poly.length < 3) break;
      }
      if (poly.length >= 3) fan(poly);
    }
  }
  return out;
}

/**
 * Kesit çokgenini dilim [a0,a1] için eğik düzlemlerle kırpar. Düzlem, dilim
 * boyunca değişen bir doğru verir: 'near' = en kısıtlayıcı (asla iç içe
 * geçmez), 'far' = en uzak (motor pahlar → uç eğime oturur).
 */
function clipSectionByPlanes(poly: Pt2[], axis: number, a0: number, a1: number, planes: TiltPlane[]): Pt2[] {
  const [ua, va] = [0, 1, 2].filter(a => a !== axis);
  let out = poly;
  for (const pl of planes) {
    // Dilim, panelin dizilim eksenindeki aralığında değilse uygulanmaz.
    if (a1 < pl.bbox.min[axis] - TOL || a0 > pl.bbox.max[axis] + TOL) continue;
    const nu = pl.n[ua], nv = pl.n[va], ns = pl.n[axis];
    if (Math.abs(nu) < 1e-9 && Math.abs(nv) < 1e-9) continue;
    const r0 = pl.d - ns * a0, r1 = pl.d - ns * a1;
    const rhs = pl.bevel ? Math.min(r0, r1) : Math.max(r0, r1);
    out = clipPoly2D(out, nu, nv, rhs);
    if (out.length < 3) return out;
  }
  return out;
}

const cellIndex = (g: CavityGrid, i: number, j: number, k: number) => (k * g.ny + j) * g.nx + i;
const cellIJK = (g: CavityGrid, c: number): [number, number, number] => [c % g.nx, Math.floor(c / g.nx) % g.ny, Math.floor(c / (g.nx * g.ny))];
const axisPlanes = (g: CavityGrid, a: number) => (a === 0 ? g.xs : a === 1 ? g.ys : g.zs);
const cellBox = (g: CavityGrid, c: number): CavityBox => {
  const [i, j, k] = cellIJK(g, c);
  return { min: [g.xs[i], g.ys[j], g.zs[k]], max: [g.xs[i + 1], g.ys[j + 1], g.zs[k + 1]] };
};

function uniqSorted(vals: number[], lo: number, hi: number): number[] {
  const v = vals.filter(x => x > lo + TOL && x < hi - TOL).sort((a, b) => a - b);
  const out: number[] = [lo];
  for (const x of v) if (x - out[out.length - 1] > TOL) out.push(x);
  if (hi - out[out.length - 1] > TOL) out.push(hi); else out[out.length - 1] = hi;
  return out;
}

/** Nokta kapalı mesh'in içinde mi (ışın pariteси, eğik ışın dejenere durumları önler). */
function makeInsideMeshTest(geo: THREE.BufferGeometry): (p: Vec3) => boolean {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const idx = geo.getIndex();
  const n = idx ? idx.count : pos.count;
  const tri = new Float64Array(n * 3);
  for (let t = 0; t < n; t++) {
    const vi = idx ? idx.getX(t) : t;
    tri[t * 3] = pos.getX(vi); tri[t * 3 + 1] = pos.getY(vi); tri[t * 3 + 2] = pos.getZ(vi);
  }
  const d = [0.8931, 0.3117, 0.3243]; // birim-yakın, eksenlere eğik
  return (p: Vec3) => {
    let hits = 0;
    for (let t = 0; t < n; t += 3) {
      const ax = tri[t * 3], ay = tri[t * 3 + 1], az = tri[t * 3 + 2];
      const e1x = tri[t * 3 + 3] - ax, e1y = tri[t * 3 + 4] - ay, e1z = tri[t * 3 + 5] - az;
      const e2x = tri[t * 3 + 6] - ax, e2y = tri[t * 3 + 7] - ay, e2z = tri[t * 3 + 8] - az;
      const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det;
      const tx = p[0] - ax, ty = p[1] - ay, tz = p[2] - az;
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (tt > 1e-9) hits++;
    }
    return (hits & 1) === 1;
  };
}

const _gridCache = new Map<string, CavityGrid>();
const boxesKey = (bs: CavityBox[]) => bs.map(b => [...b.min, ...b.max].map(n => Math.round(n * 10)).join(',')).sort().join(';');

/**
 * IZGARA: gövde kutusu + gövde katısının eksen-hizalı yüz düzlemleri + engel
 * (panel) kutularının düzlemleri → hücreler. Hücre merkezi gövde katısının
 * içinde (kutu-dışı gövdede mesh parite testi) ve hiçbir engelin içinde
 * değilse serbesttir. Geometri × engeller başına önbellek.
 */
function buildCavityGrid(parent: Shape, obstacles: CavityBox[], splitBoxes: CavityBox[] = [], tiltFaces: TiltFace[] = []): CavityGrid | null {
  const geo = effectiveBodyGeometry(parent);
  const body = bodyLocalBox(parent);
  if (!geo || !body) return null;
  const key = `${geo.uuid}|${vertexModsKey(parent.vertexModifications || [])}|${boxesKey(obstacles)}|${boxesKey(splitBoxes)}|${tiltFaces.map(f => `${f.id}:${f.n.map(x => x.toFixed(3)).join(',')}:${f.d.toFixed(1)}`).join(';')}`;
  const hit = _gridCache.get(key);
  if (hit) return hit;

  const { groups } = getFacesAndGroups(geo);
  const px: number[] = [], py: number[] = [], pz: number[] = [];
  let axisFaces = 0;
  for (const g of groups) {
    if (!isFlatNormal(g.normal)) continue;
    axisFaces++;
    (Math.abs(g.normal.x) > 0.999 ? px : Math.abs(g.normal.y) > 0.999 ? py : pz).push(Math.abs(g.normal.x) > 0.999 ? g.center.x : Math.abs(g.normal.y) > 0.999 ? g.center.y : g.center.z);
  }
  for (const o of [...obstacles, ...splitBoxes]) { px.push(o.min[0], o.max[0]); py.push(o.min[1], o.max[1]); pz.push(o.min[2], o.max[2]); }
  const xs = uniqSorted(px, body.min[0], body.max[0]);
  const ys = uniqSorted(py, body.min[1], body.max[1]);
  const zs = uniqSorted(pz, body.min[2], body.max[2]);
  const nx = xs.length - 1, ny = ys.length - 1, nz = zs.length - 1;
  const grid: CavityGrid = { body, xs, ys, zs, nx, ny, nz, free: new Uint8Array(nx * ny * nz), obstacles, tiltFaces };
  // Düz kutu gövde (6 eksen yüzü, ek düzlem yok) → merkez testi gerekmez.
  const plainBox = groups.length === 6 && axisFaces === 6 && !(parent.vertexModifications?.length) && !(parent.subtractionGeometries?.some(Boolean)) && !(parent.fillets?.length);
  const inside = plainBox ? null : makeInsideMeshTest(geo);
  const inObstacle = (c: Vec3) => obstacles.some(o =>
    c[0] > o.min[0] && c[0] < o.max[0] && c[1] > o.min[1] && c[1] < o.max[1] && c[2] > o.min[2] && c[2] < o.max[2]);
  let freeN = 0;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c: Vec3 = [(xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2, (zs[k] + zs[k + 1]) / 2];
    if (inObstacle(c)) continue;
    if (inside && !inside(c)) continue;
    grid.free[cellIndex(grid, i, j, k)] = 1; freeN++;
  }
  console.log('[YAGO][HACİM-IZGARA]', parent.id, `hücre=${nx}x${ny}x${nz}`, 'serbest=', freeN, plainBox ? '(düz kutu)' : '(gövde katısı mesh testi)', 'engelN=', obstacles.length, 'eğikYüzN=', tiltFaces.length);
  if (_gridCache.size > 12) _gridCache.delete(_gridCache.keys().next().value as string);
  _gridCache.set(key, grid);
  return grid;
}

function planeIndex(planes: number[], v: number): number {
  if (v < planes[0] - TOL || v > planes[planes.length - 1] + TOL) return -1;
  let lo = 0, hi = planes.length - 2;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (planes[m] <= v) lo = m; else hi = m - 1; }
  return lo;
}

/** Noktanın hücresi (-1 = gövde dışı). */
function cellOfPoint(g: CavityGrid, p: Vec3): number {
  const i = planeIndex(g.xs, p[0]), j = planeIndex(g.ys, p[1]), k = planeIndex(g.zs, p[2]);
  if (i < 0 || j < 0 || k < 0) return -1;
  return cellIndex(g, i, j, k);
}

/** Noktaya en yakın SERBEST hücre (çıpa dolu hücreye düşerse). */
function nearestFreeCell(g: CavityGrid, p: Vec3): number {
  let best = -1, bestD = Infinity;
  for (let c = 0; c < g.free.length; c++) {
    if (!g.free[c]) continue;
    const b = cellBox(g, c);
    let d = 0;
    for (let a = 0; a < 3; a++) { const q = Math.max(b.min[a] - p[a], 0, p[a] - b.max[a]); d += q * q; }
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

/** Tohum hücreden yüz-komşu serbest hücrelere taşma → bağlantılı bölge. */
function floodRegion(g: CavityGrid, seed: number, allow?: (c: number) => boolean): Set<number> {
  const out = new Set<number>();
  if (seed < 0 || !g.free[seed] || (allow && !allow(seed))) return out;
  const stack = [seed]; out.add(seed);
  while (stack.length) {
    const c = stack.pop()!;
    const [i, j, k] = cellIJK(g, c);
    const nb: Array<[number, number, number]> = [[i - 1, j, k], [i + 1, j, k], [i, j - 1, k], [i, j + 1, k], [i, j, k - 1], [i, j, k + 1]];
    for (const [a, b, d] of nb) {
      if (a < 0 || b < 0 || d < 0 || a >= g.nx || b >= g.ny || d >= g.nz) continue;
      const n = cellIndex(g, a, b, d);
      if (!g.free[n] || out.has(n) || (allow && !allow(n))) continue;
      out.add(n); stack.push(n);
    }
  }
  return out;
}

function regionBBox(g: CavityGrid, cells: Set<number>): CavityBox {
  const b: CavityBox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const c of cells) {
    const cb = cellBox(g, c);
    for (let a = 0; a < 3; a++) { if (cb.min[a] < b.min[a]) b.min[a] = cb.min[a]; if (cb.max[a] > b.max[a]) b.max[a] = cb.max[a]; }
  }
  return b;
}

/** Bölge hücreleri X boyunca birleştirilmiş kutular (şema silueti / kayıt). */
function regionBoxes(g: CavityGrid, cells: Set<number>): CavityBox[] {
  const out: CavityBox[] = [];
  for (let k = 0; k < g.nz; k++) for (let j = 0; j < g.ny; j++) {
    let run: CavityBox | null = null;
    for (let i = 0; i <= g.nx; i++) {
      const inR = i < g.nx && cells.has(cellIndex(g, i, j, k));
      if (inR) {
        if (!run) run = { min: [g.xs[i], g.ys[j], g.zs[k]], max: [g.xs[i + 1], g.ys[j + 1], g.zs[k + 1]] };
        else run.max[0] = g.xs[i + 1];
      } else if (run) { out.push(run); run = null; }
    }
  }
  return out;
}

const regionKey = (cells: Set<number>) => Array.from(cells).sort((a, b) => a - b).join(',');

/** Bölgenin DIŞ yüzeyi (komşusu bölgede olmayan hücre yüzleri) — üçgen konumları. */
function regionSurface(g: CavityGrid, cells: Set<number>): number[] {
  const pos: number[] = [];
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => { pos.push(...a, ...b, ...c, ...a, ...c, ...d); };
  for (const c of cells) {
    const [i, j, k] = cellIJK(g, c);
    const b = cellBox(g, c);
    const has = (a: number, bb: number, d: number) => a >= 0 && bb >= 0 && d >= 0 && a < g.nx && bb < g.ny && d < g.nz && cells.has(cellIndex(g, a, bb, d));
    const [x0, y0, z0] = b.min, [x1, y1, z1] = b.max;
    if (!has(i - 1, j, k)) quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
    if (!has(i + 1, j, k)) quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
    if (!has(i, j - 1, k)) quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    if (!has(i, j + 1, k)) quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]);
    if (!has(i, j, k - 1)) quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]);
    if (!has(i, j, k + 1)) quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  }
  return pos;
}

// ── 2B MASKE SINIR İZLEME (dikdörtgensel çokgen) ────────────────────────────

/**
 * Düzensiz ızgara maskesinin sınır döngüleri (dolu bölge SOLDA kalacak
 * şekilde yönlü). Sıkışma noktalarında sağa dönen aday seçilir (döngüler
 * kesişmez); ardışık doğrusal kenarlar birleştirilir.
 */
export function traceMaskLoops(us: number[], vs: number[], filled: (i: number, k: number) => boolean): Pt2[][] {
  const nu = us.length - 1, nv = vs.length - 1;
  const f = (i: number, k: number) => i >= 0 && k >= 0 && i < nu && k < nv && filled(i, k);
  // Yönlü kenarlar: anahtar = başlangıç köşesi "i,k"
  type E = { a: [number, number]; b: [number, number]; used: boolean };
  const edges: E[] = [];
  const byStart = new Map<string, E[]>();
  const add = (a: [number, number], b: [number, number]) => {
    const e: E = { a, b, used: false }; edges.push(e);
    const key = `${a[0]},${a[1]}`; if (!byStart.has(key)) byStart.set(key, []); byStart.get(key)!.push(e);
  };
  for (let i = 0; i < nu; i++) for (let k = 0; k < nv; k++) {
    if (!f(i, k)) continue;
    if (!f(i, k - 1)) add([i, k], [i + 1, k]);          // alt kenar → +u
    if (!f(i + 1, k)) add([i + 1, k], [i + 1, k + 1]);  // sağ kenar → +v
    if (!f(i, k + 1)) add([i + 1, k + 1], [i, k + 1]);  // üst kenar → −u
    if (!f(i - 1, k)) add([i, k + 1], [i, k]);          // sol kenar → −v
  }
  const loops: Pt2[][] = [];
  for (const start of edges) {
    if (start.used) continue;
    const loop: [number, number][] = [];
    let cur = start;
    let guard = 0;
    while (!cur.used && guard++ < edges.length + 2) {
      cur.used = true;
      loop.push(cur.a);
      const cands = (byStart.get(`${cur.b[0]},${cur.b[1]}`) || []).filter(e => !e.used);
      if (!cands.length) break;
      let next = cands[0];
      if (cands.length > 1) {
        // Sağa dönüş önceliği (gelen yön × giden yön çapraz çarpımı en küçük).
        const din = [cur.b[0] - cur.a[0], cur.b[1] - cur.a[1]];
        let best = Infinity;
        for (const e of cands) {
          const dout = [e.b[0] - e.a[0], e.b[1] - e.a[1]];
          const cross = din[0] * dout[1] - din[1] * dout[0];
          if (cross < best) { best = cross; next = e; }
        }
      }
      cur = next;
    }
    if (loop.length < 4) continue;
    // Doğrusal ara köşeleri at.
    const pts: Pt2[] = [];
    for (let n = 0; n < loop.length; n++) {
      const p = loop[(n - 1 + loop.length) % loop.length], q = loop[n], r = loop[(n + 1) % loop.length];
      const col = (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]);
      if (Math.abs(col) < 1e-9) continue;
      pts.push({ x: us[q[0]], y: vs[q[1]] });
    }
    if (pts.length >= 3) loops.push(pts);
  }
  return loops;
}

const polyArea = (p: Pt2[]) => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q.x * r.y - r.x * q.y; } return a / 2; };
const pointInPoly = (pt: Pt2, poly: Pt2[]) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};

/**
 * KESİT ÇOKGENİ: dizilim ekseni boyunca [a0,a1] dilimini kesen TÜM katmanlarda
 * bölgede olan (u,v) hücreleri → dış sınır (pozitif alanlı, delik yok).
 * Birden çok parça varsa tohum sütununu içeren, yoksa en büyük seçilir.
 */
function sectionPolygon(g: CavityGrid, cells: Set<number>, axis: number, a0: number, a1: number, seed?: Vec3): Pt2[] | null {
  const [ua, va] = [0, 1, 2].filter(a => a !== axis);
  const planes = axisPlanes(g, axis);
  const layers: number[] = [];
  for (let j = 0; j < planes.length - 1; j++) if (planes[j] < a1 - TOL && planes[j + 1] > a0 + TOL) layers.push(j);
  if (!layers.length) return null;
  const us = axisPlanes(g, ua), vs = axisPlanes(g, va);
  const idx = (iu: number, iv: number, j: number) => {
    const ijk = [0, 0, 0]; ijk[ua] = iu; ijk[va] = iv; ijk[axis] = j;
    return cellIndex(g, ijk[0], ijk[1], ijk[2]);
  };
  const filled = (iu: number, iv: number) => layers.every(j => cells.has(idx(iu, iv, j)));
  const loops = traceMaskLoops(us, vs, filled).filter(l => polyArea(l) > 1);
  if (!loops.length) return null;
  if (seed) {
    const sp = { x: seed[ua], y: seed[va] };
    const hit = loops.find(l => pointInPoly(sp, l));
    if (hit) return hit;
  }
  return loops.reduce((b, l) => (polyArea(l) > polyArea(b) ? l : b));
}

// ── IŞIN BOYUNCA ADAYLAR ────────────────────────────────────────────────────

function rayBoxInterval(o: Vec3, d: Vec3, b: CavityBox): [number, number] | null {
  let t0 = -Infinity, t1 = Infinity;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < b.min[a] || o[a] > b.max[a]) return null;
      continue;
    }
    let ta = (b.min[a] - o[a]) / d[a], tb = (b.max[a] - o[a]) / d[a];
    if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

/** Bölgeden seçim adayı (kutu, kutular, yüzey, anahtar, tohum). */
function pickFromRegion(g: CavityGrid, cells: Set<number>, seed: Vec3, shape: CavityPick['shape'] = 'shaped', planes: TiltPlane[] = []): CavityPick {
  const bbox = clippedRegionBBox(g, cells, planes);
  return { key: `${shape}:${regionKey(cells)}`, bbox, boxes: regionBoxes(g, cells), surface: clipSurfaceByPlanes(g, cells, regionSurface(g, cells), planes), seed, shape };
}

/**
 * MAKSİMAL KUTULAR: bölge hücreleri içinde, tohum hücresini içeren ve hiçbir
 * yönde bir hücre daha büyütülemeyen eksen-hizalı kutular (indeks uzayında).
 * 3B toplam tablosuyla O(1) doluluk testi; hacme göre büyükten küçüğe.
 * Bunlar "düz" alternatiflerdir: en kapsayıcı kutu → içeri doğru daha küçükler.
 */
function maximalBoxesContaining(g: CavityGrid, cells: Set<number>, seedCell: number): Array<{ cells: Set<number>; bbox: CavityBox; volume: number }> {
  const { nx, ny, nz } = g;
  const [si, sj, sk] = cellIJK(g, seedCell);
  // Toplam tablo: S[i][j][k] = (0..i-1, 0..j-1, 0..k-1) içindeki bölge hücresi sayısı.
  const X = nx + 1, Y = ny + 1, Z = nz + 1;
  const S = new Int32Array(X * Y * Z);
  const at = (i: number, j: number, k: number) => S[(i * Y + j) * Z + k];
  for (let i = 1; i <= nx; i++) for (let j = 1; j <= ny; j++) for (let k = 1; k <= nz; k++) {
    const v = cells.has(cellIndex(g, i - 1, j - 1, k - 1)) ? 1 : 0;
    S[(i * Y + j) * Z + k] = v + at(i - 1, j, k) + at(i, j - 1, k) + at(i, j, k - 1)
      - at(i - 1, j - 1, k) - at(i - 1, j, k - 1) - at(i, j - 1, k - 1) + at(i - 1, j - 1, k - 1);
  }
  const count = (i0: number, i1: number, j0: number, j1: number, k0: number, k1: number) =>
    at(i1 + 1, j1 + 1, k1 + 1) - at(i0, j1 + 1, k1 + 1) - at(i1 + 1, j0, k1 + 1) - at(i1 + 1, j1 + 1, k0)
    + at(i0, j0, k1 + 1) + at(i0, j1 + 1, k0) + at(i1 + 1, j0, k0) - at(i0, j0, k0);
  const full = (i0: number, i1: number, j0: number, j1: number, k0: number, k1: number) =>
    count(i0, i1, j0, j1, k0, k1) === (i1 - i0 + 1) * (j1 - j0 + 1) * (k1 - k0 + 1);
  const out: Array<{ cells: Set<number>; bbox: CavityBox; volume: number }> = [];
  const seen = new Set<string>();
  let budget = 3_000_000;
  for (let i0 = si; i0 >= 0; i0--) for (let i1 = si; i1 < nx; i1++) {
    if (!full(i0, i1, sj, sj, sk, sk)) break;
    for (let j0 = sj; j0 >= 0; j0--) for (let j1 = sj; j1 < ny; j1++) {
      if (!full(i0, i1, j0, j1, sk, sk)) break;
      for (let k0 = sk; k0 >= 0; k0--) for (let k1 = sk; k1 < nz; k1++) {
        if (--budget < 0) break;
        if (!full(i0, i1, j0, j1, k0, k1)) break;
        // Maksimal mi? (6 yönde bir hücre büyütülemez)
        if (i0 > 0 && full(i0 - 1, i1, j0, j1, k0, k1)) continue;
        if (i1 < nx - 1 && full(i0, i1 + 1, j0, j1, k0, k1)) continue;
        if (j0 > 0 && full(i0, i1, j0 - 1, j1, k0, k1)) continue;
        if (j1 < ny - 1 && full(i0, i1, j0, j1 + 1, k0, k1)) continue;
        if (k0 > 0 && full(i0, i1, j0, j1, k0 - 1, k1)) continue;
        if (k1 < nz - 1 && full(i0, i1, j0, j1, k0, k1 + 1)) continue;
        const key = `${i0},${i1},${j0},${j1},${k0},${k1}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const sub = new Set<number>();
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) sub.add(cellIndex(g, i, j, k));
        const bbox: CavityBox = { min: [g.xs[i0], g.ys[j0], g.zs[k0]], max: [g.xs[i1 + 1], g.ys[j1 + 1], g.zs[k1 + 1]] };
        out.push({ cells: sub, bbox, volume: boxSpan(bbox, 0) * boxSpan(bbox, 1) * boxSpan(bbox, 2) });
      }
    }
  }
  out.sort((a, b) => b.volume - a.volume);
  return out;
}

type BoxAlt = { cells: Set<number>; bbox: CavityBox; volume: number; derived?: boolean };

/**
 * PANEL-DERİNLİĞİ ALTERNATİFLERİ (Goker: "taralı panel kadar derinlikte bir
 * hacim de seçenekler arasında olmalı"): maksimal kutu B'nin bir yüzüne
 * DEĞEN panel O (ör. kısaltılmış dikme) B'yi o yüzde yalnız kendi uzunluğu
 * kadar sınırlıyorsa, B diğer eksenlerde O'nun aralığına kırpılır → "panel
 * kadar derin / yüksek" kutu. Tek eksen kırpımları ve ikisi birden üretilir;
 * B ile aynı olanlar atılır. Kırpım sınırları engel düzlemleridir → hücrelerle
 * birebir örtüşür (maksimal olmadıkları için maximalBoxesContaining vermez).
 */
function panelBoundedBoxes(g: CavityGrid, B: BoxAlt): BoxAlt[] {
  const obs = g.obstacles || [];
  const out: BoxAlt[] = [];
  const seen = new Set<string>([fmtBox(B.bbox)]);
  for (const O of obs) {
    for (let a = 0; a < 3; a++) {
      const touches = Math.abs(O.max[a] - B.bbox.min[a]) < TOL || Math.abs(O.min[a] - B.bbox.max[a]) < TOL;
      if (!touches) continue;
      const others = [0, 1, 2].filter(x => x !== a);
      // O, B'nin yüzüyle diğer iki eksende gerçekten örtüşmeli.
      if (!others.every(b => Math.min(O.max[b], B.bbox.max[b]) - Math.max(O.min[b], B.bbox.min[b]) > TOL)) continue;
      const clipSets: number[][] = [[others[0]], [others[1]], others];
      for (const axes of clipSets) {
        const bb: CavityBox = { min: [...B.bbox.min] as Vec3, max: [...B.bbox.max] as Vec3 };
        let changed = false;
        for (const b of axes) {
          const lo = Math.max(B.bbox.min[b], O.min[b]), hi = Math.min(B.bbox.max[b], O.max[b]);
          if (lo > bb.min[b] + TOL || hi < bb.max[b] - TOL) changed = true;
          bb.min[b] = lo; bb.max[b] = hi;
        }
        if (!changed) continue;
        const k = fmtBox(bb);
        if (seen.has(k)) continue;
        seen.add(k);
        const cells = new Set<number>();
        for (const c of B.cells) {
          const cb = cellBox(g, c);
          if ([0, 1, 2].every(x => cb.min[x] >= bb.min[x] - TOL && cb.max[x] <= bb.max[x] + TOL)) cells.add(c);
        }
        if (!cells.size) continue;
        out.push({ cells, bbox: regionBBox(g, cells), volume: boxSpan(bb, 0) * boxSpan(bb, 1) * boxSpan(bb, 2), derived: true });
      }
    }
  }
  return out;
}

/**
 * DÜZ ALTERNATİFLER: verilen hücrelerden herhangi birini içeren maksimal
 * kutular + bunların panel-derinliği kırpımları; tekil, büyükten küçüğe.
 * Hem seçim ailesi hem düz-mod grup çözümü (resize) aynı listeyi kullanır.
 */
function boxAlternatives(g: CavityGrid, cells: Set<number>, seedCells: number[], minSpan = 0): BoxAlt[] {
  const okSpan = (b: CavityBox) => boxSpan(b, 0) >= minSpan && boxSpan(b, 1) >= minSpan && boxSpan(b, 2) >= minSpan;
  const seen = new Set<string>();
  const out: BoxAlt[] = [];
  const push = (b: BoxAlt) => { const k = fmtBox(b.bbox); if (seen.has(k) || !okSpan(b.bbox)) return; seen.add(k); out.push(b); };
  const maximal: BoxAlt[] = [];
  for (const sc of seedCells) for (const b of maximalBoxesContaining(g, cells, sc)) { if (!seen.has(fmtBox(b.bbox)) && okSpan(b.bbox)) maximal.push(b); push(b); }
  for (const b of maximal) for (const d of panelBoundedBoxes(g, b)) push(d);
  out.sort((a, b) => b.volume - a.volume);
  return out;
}

/**
 * ADAY AİLESİ (Goker: "önce en kapsayıcı, sonra içeriye doğru; hem şekilli
 * hem düz"): 1) şekilli bölgenin tamamı, 2) ışının bu bölgede geçtiği
 * hücrelerden herhangi birini içeren maksimal kutular ve bitişik panellerin
 * derinliğine/yüksekliğine kırpılmış halleri, hacme göre büyükten küçüğe.
 * Bölge zaten tek kutuysa şekilli aday tekrar edilmez.
 */
function candidateFamily(g: CavityGrid, cells: Set<number>, rayCells: number[], seed: Vec3, minSpan: number, planes: TiltPlane[] = []): CavityPick[] {
  const okSpan = (b: CavityBox) => boxSpan(b, 0) >= minSpan && boxSpan(b, 1) >= minSpan && boxSpan(b, 2) >= minSpan;
  const out: CavityPick[] = [];
  const boxes = boxAlternatives(g, cells, rayCells, minSpan);
  const regionIsBox = boxes.some(b => !b.derived && b.cells.size === cells.size);
  const shaped = pickFromRegion(g, cells, seed, 'shaped', planes);
  if (!regionIsBox && okSpan(shaped.bbox)) out.push(shaped);
  for (const b of boxes) out.push(pickFromRegion(g, b.cells, seed, 'box', planes));
  return out;
}

/**
 * IŞIN BOYUNCA ŞEKİLLİ HACİMLER: ışının gövde kutusundaki parçası hücre hücre
 * yürünür; serbest hücreler bölgelerine göre (ilk giriş sırasıyla) gruplanır;
 * her bölge için aday ailesi üretilir (şekilli → düz kutular). Sol tık bu
 * liste üzerinde döner (ışın derinliği sırasıyla).
 */
export function rayCavityCandidates(originLocal: Vec3, dirLocal: Vec3, g: CavityGrid, minSpan: number): CavityPick[] {
  const bodyIv = rayBoxInterval(originLocal, dirLocal, g.body);
  if (!bodyIv) return [];
  const t0 = Math.max(bodyIv[0], 0), t1 = bodyIv[1];
  if (t1 <= t0) return [];
  const ts: number[] = [t0, t1];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(dirLocal[a]) < 1e-9) continue;
    for (const p of axisPlanes(g, a)) { const t = (p - originLocal[a]) / dirLocal[a]; if (t > t0 && t < t1) ts.push(t); }
  }
  ts.sort((a, b) => a - b);
  const regions: Array<{ key: string; cells: Set<number>; rayCells: number[]; seed: Vec3; planes: TiltPlane[] }> = [];
  const byKey = new Map<string, number>();
  for (let n = 0; n < ts.length - 1; n++) {
    if (ts[n + 1] - ts[n] < 1e-6) continue;
    const tm = (ts[n] + ts[n + 1]) / 2;
    const p: Vec3 = [originLocal[0] + dirLocal[0] * tm, originLocal[1] + dirLocal[1] * tm, originLocal[2] + dirLocal[2] * tm];
    const c = cellOfPoint(g, p);
    if (c < 0 || !g.free[c]) continue;
    // EĞİK PANELLER: örnek nokta hangi taraftaysa o yarım-uzaylar; nokta bir eğik levhanın içindeyse atlanır.
    const planes = orientTiltPlanes(g.tiltFaces, p);
    if (!insideTiltPlanes(planes, p)) continue;
    let ri = -1;
    for (let r = 0; r < regions.length; r++) if (regions[r].cells.has(c) && insideTiltPlanes(regions[r].planes, p)) { ri = r; break; }
    if (ri < 0) {
      const cells = floodRegion(g, c, planes.length ? (cc => cellInsideTiltPlanes(planes, cellBox(g, cc))) : undefined);
      if (!cells.size) continue;
      const key = regionKey(cells) + '|' + planes.map(pl => `${pl.id}:${pl.d.toFixed(0)}`).join(',');
      if (byKey.has(key)) ri = byKey.get(key)!;
      else { byKey.set(key, regions.length); regions.push({ key, cells, rayCells: [], seed: p, planes }); ri = regions.length - 1; }
    }
    if (!regions[ri].rayCells.includes(c)) regions[ri].rayCells.push(c);
  }
  const out: CavityPick[] = [];
  for (const r of regions) out.push(...candidateFamily(g, r.cells, r.rayCells, r.seed, minSpan, r.planes));
  return out;
}

// ── BOŞLUK ÇÖZÜCÜ ───────────────────────────────────────────────────────────

/**
 * ÜYE KALINLIKLARI (Goker): her üyenin kendi kalınlığı vardır (şemadaki kutucuk);
 * boşluklar Σkalınlık düşülerek dağıtılır — üstteki raf 18, alttaki 10 olsa da
 * aralar eşit (ya da girilen değerde) kalır. Eksik/kısa dizi varsayılanla dolar.
 */
export function memberThicknessesOf(group: Pick<PanelGroup, 'count' | 'thickness' | 'memberThicknesses'>, count = group.count): number[] {
  const src = Array.isArray(group.memberThicknesses) ? group.memberThicknesses : [];
  return Array.from({ length: Math.max(0, count) }, (_, i) => (src[i] > 0 ? src[i] : group.thickness));
}
const sumT = (ts: number[]) => ts.reduce((s, t) => s + t, 0);

/** Eşit dağılım: n panel, n+1 boşluk, kilitsiz. */
function equalGaps(L: number, count: number, ts: number[]): GapSpec[] {
  const n = Math.max(0, count);
  const g = Math.max(MIN_GAP, (L - sumT(ts)) / (n + 1));
  return Array.from({ length: n + 1 }, () => ({ value: r1(g), locked: false }));
}

/**
 * KALINLIK DEĞİŞİNCE YENİDEN DAĞITIM: kilitli ve girilmiş boşluklar değerini korur;
 * fark girilmemiş kilitsiz boşluklara EŞİT dağılır (varsayılan: hepsi eşit). Öyle
 * boşluk yoksa kilitsizlere oransal; hepsi kilitliyse artık son boşluğa.
 */
function redistributeForThickness(gaps: GapSpec[], L: number, count: number, ts: number[]): GapSpec[] {
  if (!Array.isArray(gaps) || gaps.length !== count + 1) return equalGaps(L, count, ts);
  const out = gaps.map(g => ({ ...g }));
  const avail = L - sumT(ts);
  const fresh = out.filter(g => !g.locked && !g.edited);
  if (fresh.length > 0) {
    const fixedSum = out.filter(g => g.locked || g.edited).reduce((s, g) => s + g.value, 0);
    let free = avail - fixedSum;
    if (free < 0) { console.warn('[YAGO][GRUP-KALINLIK] kilitli/girilmiş boşluklar açıklığa sığmıyor, serbest boşluklar 0:', free.toFixed(1)); free = 0; }
    for (const g of fresh) g.value = r1(Math.max(MIN_GAP, free / fresh.length));
    return out;
  }
  return rescaleGaps(out, L, count, ts);
}

/**
 * YENİDEN DAĞITIM (küp boyutlandı / hacim değişti): kilitli boşluklar aynen
 * kalır; kalan açıklık kilitsizlere ORANLARI korunarak dağılır (hepsi eşitse
 * eşit kalır). Kilitliler sığmıyorsa oransal küçültülür (uyarı). Hepsi
 * kilitliyse artık son boşluğa yazılır.
 */
function rescaleGaps(gaps: GapSpec[], L: number, count: number, ts: number[]): GapSpec[] {
  if (!Array.isArray(gaps) || gaps.length !== count + 1) return equalGaps(L, count, ts);
  const avail = L - sumT(ts);
  const out = gaps.map(g => ({ ...g }));
  const lockedSum = out.filter(g => g.locked).reduce((s, g) => s + g.value, 0);
  let free = avail - lockedSum;
  if (free < -1e-6) {
    const k = lockedSum > 0 ? Math.max(0, avail) / lockedSum : 0;
    console.warn('[YAGO][GRUP-BOŞLUK] kilitli boşluklar açıklığa sığmıyor: kilitliΣ=', lockedSum.toFixed(1), 'açıklık=', avail.toFixed(1), '→ kilitliler oransal küçültüldü');
    for (const g of out) if (g.locked) g.value = r1(g.value * k);
    free = 0;
  }
  const unlocked = out.filter(g => !g.locked);
  if (unlocked.length === 0) {
    const last = out[out.length - 1];
    if (Math.abs(free) > 0.05) { last.value = r1(last.value + free); console.warn('[YAGO][GRUP-BOŞLUK] tüm boşluklar kilitli, artık son boşluğa yazıldı:', free.toFixed(1)); }
    return out;
  }
  const uSum = unlocked.reduce((s, g) => s + g.value, 0);
  if (uSum > 1e-6) for (const g of unlocked) g.value = r1(g.value * free / uSum);
  else for (const g of unlocked) g.value = r1(free / unlocked.length);
  const total = out.reduce((s, g) => s + g.value, 0);
  const resid = avail - total;
  if (Math.abs(resid) > 0.05) unlocked[unlocked.length - 1].value = r1(unlocked[unlocked.length - 1].value + resid);
  return out;
}

/**
 * BOŞLUK GİRİŞİ: k. boşluk value olur ve "girildi" sayılır; fark, kilitsiz ve
 * girilmemiş boşluklara EŞİT dağılır. Öyle boşluk kalmadıysa diğer kilitsiz
 * (girilmiş) boşluklara oransal; o da yoksa değer kalan açıklığa kırpılır.
 */
function applyGapEdit(gaps: GapSpec[], k: number, value: number, L: number, count: number, ts: number[]): GapSpec[] {
  const out = (gaps.length === count + 1 ? gaps : equalGaps(L, count, ts)).map(g => ({ ...g }));
  if (k < 0 || k >= out.length) return out;
  const avail = L - sumT(ts);
  const v = Math.max(MIN_GAP, value);
  out[k] = { ...out[k], value: r1(v), edited: true };
  const others = out.filter((_, i) => i !== k);
  const fixedSum = others.filter(g => g.locked || g.edited).reduce((s, g) => s + g.value, 0);
  let free = avail - out[k].value - fixedSum;
  const fresh = others.filter(g => !g.locked && !g.edited);
  if (fresh.length > 0) {
    if (free < 0) { console.warn('[YAGO][GRUP-BOŞLUK] girilen değer açıklığı aşıyor, serbest boşluklar 0:', free.toFixed(1)); free = 0; }
    for (const g of fresh) g.value = r1(free / fresh.length);
    return out;
  }
  const soft = others.filter(g => !g.locked);
  if (soft.length > 0) {
    if (free < 0) free = 0;
    const sSum = soft.reduce((s, g) => s + g.value, 0);
    if (sSum > 1e-6) for (const g of soft) g.value = r1(g.value * free / sSum);
    else for (const g of soft) g.value = r1(free / soft.length);
    return out;
  }
  const lockedSum = others.reduce((s, g) => s + g.value, 0);
  out[k].value = r1(Math.max(MIN_GAP, avail - lockedSum));
  console.warn('[YAGO][GRUP-BOŞLUK] diğer boşluklar kilitli, değer kırpıldı →', out[k].value);
  return out;
}

/** Panel başlangıçları (dizilim ekseni, hacim min'inden): p_i = min + Σgap[0..i] + Σt[0..i). */
export function panelStarts(cavityMin: number, gaps: GapSpec[], ts: number[]): number[] {
  const starts: number[] = [];
  let p = cavityMin;
  for (let i = 0; i < gaps.length - 1; i++) {
    p += gaps[i].value;
    starts.push(p);
    p += ts[i] ?? ts[ts.length - 1] ?? 0;
  }
  return starts;
}

// ── ÜYE VF GEOMETRİSİ ───────────────────────────────────────────────────────

/**
 * Üye VF: dizilim ekseninde start+t düzleminde (normal +eksen), o dilimin
 * KESİT çokgeni (şekilli). createPanelFromVirtualFace −normal yönünde t kadar
 * uzar → levha [start, start+t] aralığına oturur. Kesit yoksa kutu kesiti.
 */
function memberVfGeometry(axis: number, cavity: CavityBox, start: number, t: number, section?: Pt2[] | null): { normal: Vec3; vertices: Vec3[]; center: Vec3 } {
  const [b, c] = [0, 1, 2].filter(a => a !== axis);
  const plane = start + t;
  const mk = (vb: number, vc: number): Vec3 => { const p: Vec3 = [0, 0, 0]; p[axis] = plane; p[b] = vb; p[c] = vc; return p; };
  const poly: Pt2[] = section && section.length >= 3 ? section
    : [{ x: cavity.min[b], y: cavity.min[c] }, { x: cavity.max[b], y: cavity.min[c] }, { x: cavity.max[b], y: cavity.max[c] }, { x: cavity.min[b], y: cavity.max[c] }];
  const vertices = poly.map(q => mk(q.x, q.y));
  const normal: Vec3 = [0, 0, 0]; normal[axis] = 1;
  let cb = 0, cc = 0; for (const q of poly) { cb += q.x; cc += q.y; }
  const center = mk(cb / poly.length, cc / poly.length);
  return { normal, vertices, center };
}

interface GroupSolution { cavity: CavityBox; region: CavityBox[]; gaps: GapSpec[]; starts: number[]; sections: Array<Pt2[] | null>; seed: Vec3 }

interface ObstacleSet { obstacles: CavityBox[]; splitBoxes: CavityBox[]; tiltFaces: TiltFace[] }

/**
 * Engel kümesi: düz paneller kutu engeli; dönmüş/eğik paneller yalnız bölme
 * düzlemi (splitBoxes) + eğik yüz yarım-uzayı (tiltFaces). Izgara bu üçüyle kurulur.
 */
export function collectObstacles(parent: Shape, panels: Shape[], include: (p: Shape) => boolean = () => true): ObstacleSet {
  const obstacles: CavityBox[] = [], splitBoxes: CavityBox[] = [];
  const tilted: Shape[] = [];
  for (const p of panels) {
    if (p.type !== 'panel' || (p.parameters as any)?.parentShapeId !== parent.id || !include(p)) continue;
    const b = panelLocalBox(p, parent);
    if (!b) continue;
    if (panelHasRotation(p)) { splitBoxes.push(b); tilted.push(p); } else obstacles.push(b);
  }
  return { obstacles, splitBoxes, tiltFaces: tiltedPanelFaces(parent, tilted) };
}

/** Grubun VF sırası = en küçük üye indeksi (üye yoksa ∞: yeni grup, mevcut her panel önce). */
const groupVfIndex = (group: PanelGroup, vfIdx: Map<string, number>): number => {
  let best = Infinity;
  for (const id of group.memberVfIds) { const i = vfIdx.get(id); if (i != null && i < best) best = i; }
  return best;
};

/**
 * Grubun engelleri: VF sırasında üyelerden ÖNCE gelen gövde panelleri (basan) +
 * kendinden ÖNCE oluşturulmuş grupların panelleri. Sırada SONRA gelen gövde
 * paneli hacmi SINIRLAMAZ — grup onu basar, bölgesi üye damgalarıyla kırpılır
 * (PanelEngine.stamps). Goker: "6. sırada dikme, 7. sırada dikmeye değen gövde
 * paneli → dikme ve raf kısalmamalı, gövde paneli aralarında kalmalı".
 */
function groupObstacles(group: PanelGroup, parent: Shape, panels: Shape[], groups: PanelGroup[]): ObstacleSet {
  const byId = new Map(groups.map(g => [g.id, g] as const));
  const vfIdx = new Map(useAppStore.getState().virtualFaces.map((f, i) => [f.id, i] as const));
  const myIdx = groupVfIndex(group, vfIdx);
  const pressed: string[] = [];
  const oset = collectObstacles(parent, panels, p => {
    const gid = (p.parameters as any)?.panelGroupId as string | undefined;
    if (!gid) {
      const pi = vfIdx.get((p.parameters as any)?.virtualFaceId);
      const bounds = pi == null || pi < myIdx;   // VF'siz (eski) panel: güvenli taraf, sınırlar
      if (!bounds) pressed.push(`${p.id}(sıra ${pi})`);
      return bounds;
    }
    if (gid === group.id) return false;
    const g = byId.get(gid);
    return !!g && g.createdAt < group.createdAt;
  });
  if (pressed.length) console.log('[YAGO][GRUP-SIRA]', group.id, 'sıra=', myIdx, '→ SONRAKİ gövde panelleri hacmi sınırlamaz (grup basar):', pressed.join(', '));
  return oset;
}
export const gridForObstacles = (parent: Shape, o: ObstacleSet) => buildCavityGrid(parent, o.obstacles, o.splitBoxes, o.tiltFaces);

/** Çıpa noktası (gövde kutusu oranından). */
const anchorPoint = (group: PanelGroup, body: CavityBox): Vec3 => pointFromFrac(body, group.anchorFrac);

/**
 * Grubu güncel gövde + panellerle çözer (saf): ızgara → çıpadan bölge → kutu →
 * boşluklar → her üyenin kesit çokgeni. Bölge bozuksa önceki hacimle devam eder.
 */
function solveGroup(group: PanelGroup, parent: Shape, panels: Shape[], groups: PanelGroup[]): GroupSolution | null {
  const oset = groupObstacles(group, parent, panels, groups);
  const grid = gridForObstacles(parent, oset);
  if (!grid) return null;
  const ts = memberThicknessesOf(group);
  const tMax = ts.length ? Math.max(...ts) : group.thickness;
  let seed = anchorPoint(group, grid.body);
  let c = cellOfPoint(grid, seed);
  if (c < 0 || !grid.free[c]) {
    c = nearestFreeCell(grid, seed);
    if (c >= 0) { const b = cellBox(grid, c); seed = boxCenter(b); console.log('[YAGO][GRUP] çıpa dolu hücrede, en yakın serbest hücreye alındı:', group.id, fmtBox(b)); }
  }
  // EĞİK PANELLER: çıpa tarafına bakan yarım-uzaylar; panel VF sırasında üyelerden
  // ÖNCE ise (basan) uç uzak yüze uzatılır (motor pahlar), sonra ise yakın yüze.
  const planes = orientTiltPlanes(grid.tiltFaces, seed);
  if (planes.length) {
    const vfIdx = new Map(useAppStore.getState().virtualFaces.map((f, i) => [f.id, i] as const));
    const memberIdx = group.memberVfIds.length ? (vfIdx.get(group.memberVfIds[0]) ?? Infinity) : Infinity;
    for (const pl of planes) { const pi = pl.vfId ? vfIdx.get(pl.vfId) : undefined; pl.bevel = pi != null && pi < memberIdx; }
    console.log('[YAGO][GRUP] eğik sınır düzlemleri:', group.id, planes.map(pl => `${pl.id}(${pl.bevel ? 'pah' : 'yakın'})`).join(','));
  }
  const allow = planes.length ? (cc: number) => cellInsideTiltPlanes(planes, cellBox(grid, cc)) : undefined;
  let cells = c >= 0 ? floodRegion(grid, c, allow) : new Set<number>();
  // DÜZ ALTERNATİF: bölge içinde çıpayı içeren maksimal kutulardan, kayıtlı
  // kutuya (gövde oranıyla güncel kutuya taşınmış) en çok örtüşeni seçilir.
  if (group.boxMode && cells.size && c >= 0) {
    const want = group.boxFrac ? { min: pointFromFrac(grid.body, group.boxFrac.min), max: pointFromFrac(grid.body, group.boxFrac.max) } : cloneBox(group.cavity);
    const iou = (a: CavityBox, b: CavityBox) => {
      let inter = 1, va = 1, vb = 1;
      for (let x = 0; x < 3; x++) { inter *= Math.max(0, Math.min(a.max[x], b.max[x]) - Math.max(a.min[x], b.min[x])); va *= boxSpan(a, x); vb *= boxSpan(b, x); }
      return inter / Math.max(va + vb - inter, 1e-6);
    };
    // Tohum: kayıtlı kutunun (oranla taşınmış) merkez hücresi — kutu çıpayı içermeyebilir
    // (ör. arka yüksek kutu, ışının ön hücresinden seçilmiş); merkez bölge dışındaysa çıpa hücresi.
    const wc = cellOfPoint(grid, boxCenter(want));
    const boxes = boxAlternatives(grid, cells, [wc >= 0 && cells.has(wc) ? wc : c]);
    if (boxes.length) {
      const best = boxes.reduce((b, x) => (iou(x.bbox, want) > iou(b.bbox, want) ? x : b));
      console.log('[YAGO][GRUP] düz alternatif: maksimal kutu', fmtBox(best.bbox), 'örtüşme=', iou(best.bbox, want).toFixed(2), 'adayN=', boxes.length);
      cells = best.cells;
    }
  }
  let cavity = cells.size ? clippedRegionBBox(grid, cells, planes) : cloneBox(group.cavity);
  let region = cells.size ? regionBoxes(grid, cells) : (group.region || [cloneBox(group.cavity)]);
  const minOk = cells.size > 0 && [0, 1, 2].every(a => boxSpan(cavity, a) >= (a === group.axis ? sumT(ts) : tMax));
  if (!minOk) {
    console.warn('[YAGO][GRUP] hacim bozuk/çok küçük, önceki hacim korunuyor:', group.id, fmtBox(cavity));
    cavity = cloneBox(group.cavity);
    region = group.region || [cloneBox(cavity)];
  }
  const L = boxSpan(cavity, group.axis);
  const gaps = rescaleGaps(group.gaps, L, group.count, ts);
  const starts = panelStarts(cavity.min[group.axis], gaps, ts);
  const sections = starts.map((s, i) => {
    if (!minOk) return null;
    const t = ts[i];
    const poly = sectionPolygon(grid, cells, group.axis, s, s + t, seed);
    if (!poly || !planes.length) return poly;
    const clipped = clipSectionByPlanes(poly, group.axis, s, s + t, planes);
    return clipped.length >= 3 ? clipped : poly;
  });
  return { cavity, region, gaps, starts, sections, seed };
}

/** Çözümden üye VF yaması (regen bu alanları yazar; kullanıcı alanları dokunulmaz). */
function interiorVfPatch(vf: VirtualFace, group: PanelGroup, sol: GroupSolution): Partial<VirtualFace> | null {
  const i = vf.groupIndex ?? group.memberVfIds.indexOf(vf.id);
  if (i < 0 || i >= sol.starts.length) return null;
  const g = memberVfGeometry(group.axis, sol.cavity, sol.starts[i], memberThicknessesOf(group)[i], sol.sections[i]);
  return { normal: g.normal, vertices: g.vertices, center: g.center, regionAnchor: g.center } as any;
}

/**
 * REGEN KANCASI (VirtualFaceUpdateService): bir gövdenin tüm iç VF'lerini grup
 * çözümüyle yeniden yazar. Yüz eşlemesi yapılmaz. Grup yoksa VF olduğu gibi kalır.
 */
export function recalculateInteriorVfs(parent: Shape, vfs: VirtualFace[], panels: Shape[], groups: PanelGroup[]): Map<string, VirtualFace> {
  const out = new Map<string, VirtualFace>();
  const mine = groups.filter(g => g.shapeId === parent.id);
  for (const g of mine) {
    const sol = solveGroup(g, parent, panels, groups);
    if (!sol) continue;
    console.log('[YAGO][GRUP-REGEN]', g.id, g.kind, 'n=', g.count, 'hacim=', fmtBox(sol.cavity), 'parçaN=', sol.region.length,
      'L=', boxSpan(sol.cavity, g.axis).toFixed(1), 'boşluklar=', sol.gaps.map(x => `${x.value}${x.locked ? '🔒' : ''}`).join('/'),
      'kesitKöşeN=', sol.sections.map(s => (s ? s.length : '-')).join('/'));
    for (const vf of vfs) {
      if (vf.shapeId !== parent.id || vf.groupId !== g.id) continue;
      const patch = interiorVfPatch(vf, g, sol);
      if (patch) out.set(vf.id, { ...vf, ...patch });
    }
  }
  return out;
}

// ── STORE İŞLEMLERİ ─────────────────────────────────────────────────────────

const groupById = (id: string) => useAppStore.getState().panelGroups.find(g => g.id === id);

/** Çözüm yoksa: kayıtlı hacim + verilen boşluklarla düz çözüm. */
const fallbackSolution = (group: PanelGroup, gaps: GapSpec[], count: number, seed: Vec3): GroupSolution => ({
  cavity: group.cavity, region: group.region || [group.cavity], gaps,
  starts: panelStarts(group.cavity.min[group.axis], gaps, memberThicknessesOf(group, count)), sections: Array(count).fill(null), seed,
});

/** Üye VF'lerin panelini + VF'sini siler (seçili satırsa seçim düşer). */
function removeMembers(vfIds: string[]): void {
  const st = useAppStore.getState();
  for (const vfId of vfIds) {
    const p = panelOfVf(vfId, st.shapes);
    if (p) st.deleteShape(p.id);
    st.deleteVirtualFace(vfId);
    if (st.selectedPanelRow === `vf-${vfId}`) st.setSelectedPanelRow(null);
  }
}

function makeMemberVf(group: PanelGroup, i: number, sol: GroupSolution): VirtualFace {
  const g = memberVfGeometry(group.axis, sol.cavity, sol.starts[i], memberThicknessesOf(group)[i], sol.sections[i]);
  return {
    id: genId('vf-int'), shapeId: group.shapeId,
    normal: g.normal, center: g.center, vertices: g.vertices,
    description: groupName(group), hasPanel: false,
    parentFaceShape: false, interior: true, groupId: group.id, groupIndex: i,
    ...( { regionAnchor: g.center } as any ),
  };
}

/** Grubun güncel çözümü (store durumundan); yoksa null. */
function solveFromStore(group: PanelGroup): GroupSolution | null {
  const st = useAppStore.getState();
  const parent = shapeById(group.shapeId, st.shapes);
  if (!parent) return null;
  return solveGroup(group, parent, st.shapes, st.panelGroups.some(g => g.id === group.id) ? st.panelGroups : [...st.panelGroups, group]);
}

/** Onaylanan hacimden grup + ilk üye VF (1 panel, eşit boşluk) oluşturur; grup seçilir. */
export function createPanelGroupFromCavity(shapeId: string, kind: PanelGroup['kind'], pick: CavityPick): PanelGroup | null {
  const st = useAppStore.getState();
  const parent = shapeById(shapeId, st.shapes);
  if (!parent) return null;
  const body = bodyLocalBox(parent);
  if (!body) return null;
  const axis = groupAxisOf(kind);
  const t = GROUP_PANEL_THICKNESS;
  const count = 1;
  const L = boxSpan(pick.bbox, axis);
  const group: PanelGroup = {
    // ÇIPA = tohum noktası (ışının bölgeye girdiği yer) — L bölgede kutu merkezi dışarıda kalabilir.
    id: genId(kind === 'shelf' ? 'shelf' : 'divider'), shapeId, kind, axis, anchorFrac: fracInCavity(body, pick.seed, true), name: groupKindLabel(kind),
    cavity: cloneBox(pick.bbox), region: pick.boxes.map(cloneBox), count, gaps: equalGaps(L, count, [t]), thickness: t, memberThicknesses: [t], memberVfIds: [], createdAt: Date.now(),
    ...(pick.shape === 'box' ? { boxMode: true, boxFrac: { min: fracInCavity(body, pick.bbox.min), max: fracInCavity(body, pick.bbox.max) } } : {}),
  };
  const sol = solveFromStore(group) || fallbackSolution(group, group.gaps, count, pick.seed);
  const vfs = Array.from({ length: count }, (_, i) => makeMemberVf(group, i, sol));
  group.memberVfIds = vfs.map(v => v.id);
  st.addPanelGroup(group);
  st.insertVirtualFacesAfter(null, vfs);
  st.setSelectedPanelGroupId(group.id);
  console.log('[YAGO][GRUP] oluşturuldu', group.id, kind, pick.shape === 'box' ? 'DÜZ (kutu)' : 'ŞEKİLLİ', 'hacim=', fmtBox(pick.bbox), 'parçaN=', pick.boxes.length, 'L=', L.toFixed(1), 'çıpa=', group.anchorFrac.map(n => n.toFixed(2)).join(','));
  return group;
}

/** Üye sayısı: artınca yeni VF'ler son üyenin arkasına eklenir, azalınca son üyeler (panel+VF) silinir. Boşluklar eşitlenir. */
export async function setGroupCount(groupId: string, count: number): Promise<void> {
  const st = useAppStore.getState();
  const group = groupById(groupId);
  if (!group) return;
  const n = Math.max(0, Math.min(40, Math.round(count)));
  if (n === group.count) return;
  // Üye kalınlıkları: mevcutlar korunur, yeni üyeler varsayılanla doğar; boşluklar Σkalınlığa göre eşitlenir.
  const memberThicknesses = memberThicknessesOf(group, n);
  const gaps = equalGaps(boxSpan(group.cavity, group.axis), n, memberThicknesses);
  let memberVfIds = group.memberVfIds.slice();
  if (n < group.count) { removeMembers(memberVfIds.slice(n)); memberVfIds = memberVfIds.slice(0, n); }
  const next: PanelGroup = { ...group, count: n, gaps, memberVfIds, memberThicknesses };
  const sol = solveFromStore(next) || fallbackSolution(group, gaps, n, anchorPoint(group, group.cavity));
  for (let i = 0; i < Math.min(n, group.count); i++) {
    const vf = useAppStore.getState().virtualFaces.find(f => f.id === memberVfIds[i]);
    if (!vf) continue;
    const patch = interiorVfPatch({ ...vf, groupIndex: i }, next, sol);
    if (patch) st.updateVirtualFace(vf.id, { ...patch, groupIndex: i });
  }
  if (n > group.count) {
    const added = Array.from({ length: n - group.count }, (_, k) => makeMemberVf(next, group.count + k, sol));
    next.memberVfIds = [...memberVfIds, ...added.map(v => v.id)];
    st.insertVirtualFacesAfter(memberVfIds[memberVfIds.length - 1] || null, added);
  }
  st.updatePanelGroup(groupId, { count: n, gaps: sol.gaps, memberVfIds: next.memberVfIds, memberThicknesses });
  console.log('[YAGO][GRUP] adet', group.count, '→', n, groupId, '(boşluklar eşitlendi)');
  // Panel ekleme (VF → otomatik panel) / silme rebuild'i App izleyicisi tetikler.
}

function writeGroupGaps(group: PanelGroup, gaps: GapSpec[], extra: Partial<PanelGroup> = {}): void {
  const st = useAppStore.getState();
  const next = { ...group, ...extra, gaps };
  const sol = solveFromStore(next) || fallbackSolution(next, gaps, group.count, anchorPoint(group, group.cavity));
  for (const vfId of group.memberVfIds) {
    const vf = st.virtualFaces.find(f => f.id === vfId);
    if (!vf) continue;
    const patch = interiorVfPatch(vf, next, sol);
    if (patch) st.updateVirtualFace(vf.id, patch);
  }
  st.updatePanelGroup(group.id, { ...extra, gaps: sol.gaps });
}

/**
 * ÜYE KALINLIĞI (şemadaki kutucuk): i. üyenin kalınlığı value olur; üye panelin
 * `panelThickness` parametresi güncellenir (motor levhayı bu kalınlıkla üretir,
 * damga/şerit sınıfı da bunu okur); boşluklar Σkalınlığa göre yeniden dağıtılır
 * (kilitli/girilmiş korunur, diğerleri EŞİT); tam rebuild.
 */
export async function setGroupMemberThickness(groupId: string, i: number, value: number): Promise<void> {
  const group = groupById(groupId);
  if (!group || i < 0 || i >= group.count || !Number.isFinite(value)) return;
  const L = boxSpan(group.cavity, group.axis);
  const ts = memberThicknessesOf(group);
  const others = sumT(ts) - ts[i];
  const v = r1(Math.max(1, Math.min(value, Math.max(1, L - others - group.count - 1))));
  if (Math.abs(v - ts[i]) < 0.05) return;
  ts[i] = v;
  const gaps = redistributeForThickness(group.gaps, L, group.count, ts);
  writeGroupGaps(group, gaps, { memberThicknesses: ts });
  const st = useAppStore.getState();
  const panel = panelOfVf(group.memberVfIds[i], st.shapes);
  if (panel) st.updateShape(panel.id, { parameters: { ...panel.parameters, panelThickness: v, depth: v } } as any);
  console.log('[YAGO][GRUP-KALINLIK] girildi', groupId, 'üye=', i + 1, 'değer=', v, 'kalınlıklar=', ts.join('/'), '→ boşluklar', gaps.map(g => `${g.value}${g.locked ? '🔒' : g.edited ? '*' : ''}`).join('/'));
  await requestRebuild(group.shapeId);
}

/** Boşluk girişi (şema pill'i): kural applyGapEdit; VF'ler güncellenir, tam rebuild. */
export async function editGroupGap(groupId: string, k: number, value: number): Promise<void> {
  const group = groupById(groupId);
  if (!group || !Number.isFinite(value)) return;
  const gaps = applyGapEdit(group.gaps, k, value, boxSpan(group.cavity, group.axis), group.count, memberThicknessesOf(group));
  writeGroupGaps(group, gaps);
  console.log('[YAGO][GRUP-BOŞLUK] girildi', groupId, 'k=', k, 'değer=', value, '→', gaps.map(g => `${g.value}${g.locked ? '🔒' : g.edited ? '*' : ''}`).join('/'));
  await requestRebuild(group.shapeId);
}

/** Kilit: değer değişmez; küp boyutlanınca bu boşluk sabit kalır. */
export function toggleGroupGapLock(groupId: string, k: number): void {
  const group = groupById(groupId);
  if (!group || k < 0 || k >= group.gaps.length) return;
  const gaps = group.gaps.map((g, i) => (i === k ? { ...g, locked: !g.locked } : g));
  useAppStore.getState().updatePanelGroup(groupId, { gaps });
  console.log('[YAGO][GRUP-BOŞLUK]', gaps[k].locked ? 'KİLİTLENDİ' : 'kilit açıldı', groupId, 'k=', k, 'değer=', gaps[k].value);
}

/** Tüm boşluklar eşit + kilitsiz. */
export async function equalizeGroupGaps(groupId: string): Promise<void> {
  const group = groupById(groupId);
  if (!group) return;
  writeGroupGaps(group, equalGaps(boxSpan(group.cavity, group.axis), group.count, memberThicknessesOf(group)));
  console.log('[YAGO][GRUP-BOŞLUK] eşitlendi', groupId);
  await requestRebuild(group.shapeId);
}

/** Grubun görünen adı (eski gruplarda tür etiketi). */
export const groupName = (g: Pick<PanelGroup, 'name' | 'kind'>) => (g.name ?? groupKindLabel(g.kind));

/**
 * GRUP ADI: grup satırında düzenlenir; üye panellerin adı (VF description)
 * aynı adla eşitlenir — üye satırlarında salt-okunur gösterilir. Geometri
 * değişmez → rebuild yok.
 */
export function renamePanelGroup(groupId: string, name: string): void {
  const group = groupById(groupId);
  if (!group) return;
  useAppStore.getState().updatePanelGroup(groupId, { name });
  const ids = new Set(group.memberVfIds);
  useAppStore.setState(s => ({ virtualFaces: s.virtualFaces.map(f => (ids.has(f.id) ? { ...f, description: name } : f)) }));
}

/** Grup + tüm üye paneller ve VF'ler silinir (rebuild'i panel silme izleyicisi tetikler). */
export function deletePanelGroupWithMembers(groupId: string): void {
  const group = groupById(groupId);
  if (!group) return;
  removeMembers(group.memberVfIds);
  useAppStore.getState().deletePanelGroup(groupId);
  console.log('[YAGO][GRUP] silindi', groupId, 'üyeN=', group.memberVfIds.length);
}

const boxKey = (b: CavityBox) => [...b.min, ...b.max].map(n => Math.round(n)).join('|');

/**
 * REBUILD SONRASI SENKRON (PanelEngine): grubun store'daki hacmi/bölgesi/
 * boşlukları güncel çözümle eşitlenir (şema ve kilit değerleri doğru okunsun).
 */
export function syncPanelGroups(parentShapeId: string): void {
  const st = useAppStore.getState();
  const parent = shapeById(parentShapeId, st.shapes);
  if (!parent) return;
  const mine = st.panelGroups.filter(g => g.shapeId === parentShapeId);
  for (const g of mine) {
    const sol = solveGroup(g, parent, st.shapes, st.panelGroups);
    if (!sol) continue;
    const sameBox = boxKey(sol.cavity) === boxKey(g.cavity);
    const sameRegion = boxesKey(sol.region) === boxesKey(g.region || []);
    const sameGaps = sol.gaps.length === g.gaps.length && sol.gaps.every((x, i) => Math.abs(x.value - g.gaps[i].value) < 0.05 && x.locked === g.gaps[i].locked);
    if (sameBox && sameRegion && sameGaps) continue;
    st.updatePanelGroup(g.id, { cavity: sol.cavity, region: sol.region, gaps: sol.gaps });
    console.log('[YAGO][GRUP-SENKRON]', g.id, 'hacim=', fmtBox(sol.cavity), 'parçaN=', sol.region.length, 'boşluklar=', sol.gaps.map(x => x.value).join('/'));
  }
}
