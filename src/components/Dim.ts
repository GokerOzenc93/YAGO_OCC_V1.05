import * as THREE from 'three';
import { create } from 'zustand';
import { useAppStore, ViewMode, type Shape, type SceneToolStatus } from '../store';
import { effectiveBodyGeometry, getFacesAndGroups, getShapeMatrix, groupIndexOfFace } from './Geometry';
import { useDraft, cancelCommand as cancelDraftCommand, fmt, matchOpt, SNAP_LABEL, type CmdView, type Opt, type SnapKind } from './Draft';
import { panelStepMatrix } from './PanelEngine';

/* 3B ÖLÇÜLENDİRME ÇEKİRDEĞİ — sahnedeki gövde ("referans küp") ve panellerin üzerinde ölçü alma. React'ten bağımsızdır (Node'da denenir).
   Bölümler: 1 kenar / yay çıkarımı · 2 kaynaklar + 3B nesne yakalama · 3 ilişkisel çapa · 4 ölçü modeli + çizimi · 5 sürücü · 6 komutlar.
   Yakalama ayarı uygulama genelidir (store.snapEnabled / snapSettings — 2B çizimle aynı). Ölçüler ilişkiseldir: nokta, ait olduğu şeklin
   kendi çerçevesinde saklanır — gövdede gövdenin yereli, panelde panelin TAŞINMAMIŞ / DÖNDÜRÜLMEMİŞ hâli (adımları geri alınmış) — + kutu oranı.
   Şekil taşınır, döner ya da yeniden kurulursa nokta panelin hareketiyle götürülür, sonra şeklin GERÇEK geometrisine oturtulur (köşe → köşe,
   kenar noktası → kenar, yüzey noktası → yüzey): motor dönen paneli gövdeye sığdırırken büyütüp kırpar, salt adım dönüşümü yetmez. */

type V = THREE.Vector3;
export type T3 = [number, number, number];
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const t3 = (v: V): T3 => [v.x, v.y, v.z];
const vt = (t: T3 | number[]) => new THREE.Vector3(t[0], t[1], t[2]);
const TAU = Math.PI * 2;
const DEG = 180 / Math.PI;
const sgn = (x: number): 1 | -1 => (x < 0 ? -1 : 1);
const anyPerp = (d: V) => V3().crossVectors(d, Math.abs(d.y) < 0.9 ? V3(0, 1, 0) : V3(1, 0, 0)).normalize();
const rotAbout = (p: V, axis: V, ang: number) => p.clone().applyAxisAngle(axis, ang);

// ═════════════════════════════════════════════════ 1. KENAR · YAY ÇIKARIMI ════════════════════════════════════════════
/** Mesh'in keskin kenarları: birleştirilmiş doğrular ve daire yayları (üçgenlenmiş yay zinciri → merkez / yarıçap). Şeklin YEREL koordinatı. */
export interface LineC { t: 'l'; a: V; b: V }
export interface ArcC { t: 'a'; c: V; n: V; r: number; a: V; b: V; sweep: number; closed: boolean; pts: V[] }
export type Curve = LineC | ArcC;

function circle3(a: V, b: V, c: V): { c: V; n: V; r: number } | null {
  const ab = b.clone().sub(a), ac = c.clone().sub(a), bc = c.clone().sub(b);
  const n = V3().crossVectors(ab, ac), n2 = n.lengthSq(), la = ab.lengthSq(), lc = ac.lengthSq();
  if (n2 < 1e-12 * la * lc || la < 1e-12 || bc.lengthSq() < 1e-12) return null;
  // b'deki dönüş 0,5°'den küçükse doğru sayılır (çok büyük yarıçaplı sahte daire olmasın).
  if (V3().crossVectors(ab, bc).length() / (ab.length() * bc.length()) < 0.0087) return null;
  const cen = a.clone().add(V3().crossVectors(n, ab).multiplyScalar(lc).add(V3().crossVectors(ac, n).multiplyScalar(la)).multiplyScalar(1 / (2 * n2)));
  return { c: cen, n: n.normalize(), r: cen.distanceTo(a) };
}
const onCircle = (ci: { c: V; n: V; r: number }, p: V) => {
  const tol = 0.02 + ci.r * 2e-4, d = p.clone().sub(ci.c);
  return Math.abs(d.dot(ci.n)) < tol && Math.abs(d.length() - ci.r) < tol;
};
const CHORD_K = 0.62;   // kiriş ≤ 0,62 r (adım ≤ ~36°): dikdörtgen / altıgen köşeleri daire sayılmaz
function arcFrom(ci: { c: V; n: V; r: number }, pts: V[], closed: boolean): ArcC {
  const n = V3().crossVectors(pts[0].clone().sub(ci.c), pts[1].clone().sub(ci.c)).normalize();
  let sweep = 0;
  for (let i = 0; i + 1 < pts.length; i++) sweep += pts[i].clone().sub(ci.c).angleTo(pts[i + 1].clone().sub(ci.c));
  return { t: 'a', c: ci.c, n, r: ci.r, a: pts[0], b: pts[pts.length - 1], sweep: closed ? TAU : sweep, closed, pts };
}
/** Sıralı nokta zincirini doğru ve yay parçalarına ayırır. */
function splitChain(P: V[], closed: boolean, out: Curve[]) {
  const n = P.length;
  if (n < 2) return;
  if (closed && n >= 6) {
    const ci = circle3(P[0], P[Math.floor(n / 3)], P[Math.floor((2 * n) / 3)]);
    if (ci && P.every(p => onCircle(ci, p)) && P.every((p, i) => p.distanceTo(P[(i + 1) % n]) <= CHORD_K * ci.r)) { out.push(arcFrom(ci, [...P, P[0]], true)); return; }
  }
  let Q = P;
  if (closed) {
    // Başlangıç bir köşeye ya da doğru parçasının içine alınır: hiçbir yay ortasından bölünmez.
    let k = 0;
    for (let i = 0; i < n; i++) {
      const a = P[(i + n - 1) % n], b = P[i], c = P[(i + 1) % n];
      const t = b.clone().sub(a).normalize().angleTo(c.clone().sub(b).normalize()) * DEG;
      if (t < 0.25 || t > 38) { k = i; break; }
    }
    Q = [...P.slice(k), ...P.slice(0, k), P[k]];
  }
  const m = Q.length, dirOf = (i: number, j: number) => Q[j].clone().sub(Q[i]).normalize();
  let i = 0;
  while (i < m - 1) {
    // Yay adayı: aynı yöne, benzer kirişlerle dönen ardışık parçalar. Daire uçtan uca üç noktadan kurulur (komşu üç nokta float32'de
    // yarıçapı tutturamaz), tüm noktalar üstünde değilse aday sondan kısaltılır.
    if (i + 3 < m) {
      const ch = (k: number) => Q[k].distanceTo(Q[k + 1]), c0 = ch(i), n0 = V3().crossVectors(dirOf(i, i + 1), dirOf(i + 1, i + 2));
      const turns = (k: number) => {   // k köşesindeki dönüş: 0,4°–38°, ilk dönüşle aynı yönde, kirişi ilkine yakın
        const x = V3().crossVectors(dirOf(k - 1, k), dirOf(k, k + 1)), sn = x.length();
        return sn > 0.007 && sn < 0.62 && x.dot(n0) > 0 && dirOf(k - 1, k).dot(dirOf(k, k + 1)) > 0 && ch(k) <= c0 * 4 && ch(k) >= c0 / 4;
      };
      let j = i + 1;
      while (j + 1 < m && turns(j)) j++;
      for (; j - i >= 3; j--) {
        const ci = circle3(Q[i], Q[Math.floor((i + j) / 2)], Q[j]);
        if (!ci || c0 > CHORD_K * ci.r) continue;
        let fit = true;
        for (let k = i; k <= j && fit; k++) fit = onCircle(ci, Q[k]);
        if (!fit) continue;
        out.push(arcFrom(ci, Q.slice(i, j + 1), false));
        break;
      }
      if (j - i >= 3) { i = j; continue; }
    }
    let j = i + 1;
    const d = dirOf(i, j);
    while (j + 1 < m && dirOf(j, j + 1).dot(d) > 0.99999) j++;
    out.push({ t: 'l', a: Q[i], b: Q[j] });
    i = j;
  }
}
const curveCache = new WeakMap<THREE.BufferGeometry, Curve[]>();
export function curvesOf(geo: THREE.BufferGeometry): Curve[] {
  const hit = curveCache.get(geo);
  if (hit) return hit;
  const out: Curve[] = [];
  try {
    const eg = new THREE.EdgesGeometry(geo, 15), pos = eg.getAttribute('position');
    const pts: V[] = [], idOf = new Map<string, number>(), segs: [number, number][] = [], at: number[][] = [];
    const vid = (i: number) => {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), key = `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
      let id = idOf.get(key);
      if (id === undefined) { id = pts.length; pts.push(V3(x, y, z)); idOf.set(key, id); at.push([]); }
      return id;
    };
    for (let i = 0; i + 1 < pos.count; i += 2) {
      const a = vid(i), b = vid(i + 1);
      if (a === b) continue;
      at[a].push(segs.length); at[b].push(segs.length); segs.push([a, b]);
    }
    eg.dispose();
    const used = new Uint8Array(segs.length), COS = Math.cos(38 / DEG);
    const other = (s: number, v: number) => (segs[s][0] === v ? segs[s][1] : segs[s][0]);
    // v köşesinden, geliş yönüne en düz devam eden kullanılmamış kenar (dönüş < 38°).
    const next = (v: number, from: number): number => {
      const d = pts[v].clone().sub(pts[from]).normalize();
      let best = -1, bc = COS;
      for (const s of at[v]) {
        if (used[s]) continue;
        const c = pts[other(s, v)].clone().sub(pts[v]).normalize().dot(d);
        if (c > bc) { bc = c; best = s; }
      }
      return best;
    };
    for (let s0 = 0; s0 < segs.length; s0++) {
      if (used[s0]) continue;
      used[s0] = 1;
      const chain = [segs[s0][0], segs[s0][1]];
      let closed = false;
      for (;;) {
        const v = chain[chain.length - 1], s = next(v, chain[chain.length - 2]);
        if (s < 0) break;
        used[s] = 1;
        const o = other(s, v);
        if (o === chain[0]) { closed = true; break; }
        chain.push(o);
      }
      while (!closed) {
        const v = chain[0], s = next(v, chain[1]);
        if (s < 0) break;
        used[s] = 1;
        const o = other(s, v);
        if (o === chain[chain.length - 1]) { closed = true; break; }
        chain.unshift(o);
      }
      splitChain(chain.map(i => pts[i]), closed, out);
    }
  } catch (err) { console.warn('[YAGO][DIM] kenar çıkarımı başarısız:', err); }
  curveCache.set(geo, out);
  return out;
}

// ═════════════════════════════════════════════════ 2. KAYNAKLAR · 3B NESNE YAKALAMA ═══════════════════════════════════
export interface View { cam: THREE.Camera; w: number; h: number }
/** İmleç: tuval pikseli + dünya ışını + kamera. */
export interface Cursor { x: number; y: number; ray: THREE.Ray; view: View }
export interface Src {
  shape: Shape; panel: boolean; geo: THREE.BufferGeometry; m: THREE.Matrix4; inv: THREE.Matrix4; q: THREE.Quaternion;
  mesh: THREE.Mesh; sphere: THREE.Sphere; visible: boolean; _wc?: Curve[];
  /** Panelin taşıma / döndürme adımlarının dönüşümü (geometri koordinatında, adımsız → şimdiki) ve tersi; adımsız şekilde null. */
  S: THREE.Matrix4 | null; Si: THREE.Matrix4 | null;
}
const RAY_MAT = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
const meshCache = new WeakMap<THREE.BufferGeometry, THREE.Mesh>();
/** Şeklin dünya kenarları (tembel; gövde matrisi uygulanmış). */
export function worldCurves(s: Src): Curve[] {
  if (s._wc) return s._wc;
  const p = (v: V) => v.clone().applyMatrix4(s.m), k = s.m.getMaxScaleOnAxis();
  s._wc = curvesOf(s.geo).map((c): Curve => (c.t === 'l' ? { t: 'l', a: p(c.a), b: p(c.b) }
    : { t: 'a', c: p(c.c), n: c.n.clone().transformDirection(s.m), r: c.r * k, a: p(c.a), b: p(c.b), sweep: c.sweep, closed: c.closed, pts: c.pts.map(p) }));
  return s._wc;
}
export interface RCtx { shapes: Shape[]; all: Map<string, Src>; srcs: Src[] }
const stepCache = new WeakMap<THREE.BufferGeometry, { key: string; S: THREE.Matrix4 | null }>();
/** Panelin adım dönüşümü — geometri + adımlar başına bir kez (geometri her rebuild'de yenilenir). */
function stepMatrixOf(shape: Shape, geo: THREE.BufferGeometry): THREE.Matrix4 | null {
  const key = JSON.stringify([shape.parameters?.transformSteps ?? null, shape.parameters?._refDeltaApplied ?? null]), hit = stepCache.get(geo);
  if (hit && hit.key === key) return hit.S;
  let S: THREE.Matrix4 | null = null;
  try { S = panelStepMatrix(shape); } catch { S = null; }
  if (S && S.equals(new THREE.Matrix4())) S = null;
  stepCache.set(geo, { key, S });
  return S;
}
/** Şeklin adımsız çerçevedeki kutusu (panel geometrisi adım dönüşümünün tersiyle); adımsız şekilde geometrinin kendi kutusu. */
const baseCache = new WeakMap<THREE.BufferGeometry, { Si: THREE.Matrix4 | null; bb: THREE.Box3 }>();
function baseBox(geo: THREE.BufferGeometry, Si: THREE.Matrix4 | null): THREE.Box3 {
  const hit = baseCache.get(geo);
  if (hit && (hit.Si === Si || (hit.Si && Si && hit.Si.equals(Si)))) return hit.bb;
  let bb: THREE.Box3;
  if (!Si) bb = geo.boundingBox!.clone();
  else {
    bb = new THREE.Box3();
    const pos = geo.getAttribute('position'), v = V3();
    for (let i = 0; i < pos.count; i++) bb.expandByPoint(v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(Si));
  }
  baseCache.set(geo, { Si, bb });
  return bb;
}
const _seg = new THREE.Line3(), _tri = new THREE.Triangle(), _q = new THREE.Vector3(), _ta = new THREE.Vector3(), _tb = new THREE.Vector3(), _tc = new THREE.Vector3();
/** Noktayı şeklin gerçek geometrisine oturtur (geometri koordinatı): köşe / kesişim → en yakın köşe · orta → en yakın kenar ortası ·
 *  merkez → en yakın yay merkezi · kenar üstü (en yakın, dik, teğet, çeyrek) → en yakın kenar noktası · serbest → en yakın yüzey noktası. */
function seatOnGeo(p: V, k: Anchor['k'], geo: THREE.BufferGeometry): V {
  const curves = curvesOf(geo);
  const best = (cands: V[]) => { let m: V | null = null, d = Infinity; for (const c of cands) { const x = c.distanceToSquared(p); if (x < d) { d = x; m = c; } } return m ? m.clone() : p; };
  if (k === 'endpoint' || k === 'intersection') return best(curves.flatMap(c => (c.t === 'l' || !c.closed ? [c.a, c.b] : [])));
  if (k === 'midpoint') return best(curves.flatMap(c => (c.t === 'l' ? [c.a.clone().lerp(c.b, 0.5)] : c.closed ? [] : [arcPoint(c, c.sweep / 2)])));
  if (k === 'center') { const arcs = curves.filter((c): c is ArcC => c.t === 'a'); return arcs.length ? best(arcs.map(c => c.c)) : p; }
  if (k !== 'free') {
    let m: V | null = null, d = Infinity;
    for (const c of curves) for (let i = 0, pts = c.t === 'l' ? [c.a, c.b] : c.pts; i + 1 < pts.length; i++) {
      _seg.set(pts[i], pts[i + 1]).closestPointToPoint(p, true, _q);
      const x = _q.distanceToSquared(p);
      if (x < d) { d = x; m = _q.clone(); }
    }
    return m ?? p;
  }
  const pos = geo.getAttribute('position'), idx = geo.getIndex(), n = idx ? idx.count : pos.count, at = (i: number) => (idx ? idx.getX(i) : i);
  let m: V | null = null, d = Infinity;
  for (let i = 0; i + 2 < n; i += 3) {
    _tri.set(_ta.fromBufferAttribute(pos, at(i)), _tb.fromBufferAttribute(pos, at(i + 1)), _tc.fromBufferAttribute(pos, at(i + 2))).closestPointToPoint(p, _q);
    const x = _q.distanceToSquared(p);
    if (x < d) { d = x; m = _q.clone(); }
  }
  return m ?? p;
}
let _rctx: RCtx | null = null, _rctxIso: unknown = null;
/** Çözüm bağlamı: şekil başına matris / geometri (panel geometrisi üst gövdenin yerelindedir → dünyası gövdenin matrisi). */
export function rctx(shapes: Shape[] = useAppStore.getState().shapes): RCtx {
  const ds = useDraft.getState(), iso = ds.isolate, pv = ds.bodyPreview;
  if (_rctx && _rctx.shapes === shapes && _rctxIso === iso) return _rctx;
  const byId = new Map(shapes.map(s => [s.id, s])), all = new Map<string, Src>(), srcs: Src[] = [];
  for (const shape of shapes) {
    const panel = shape.type === 'panel', geo = panel ? shape.geometry : effectiveBodyGeometry(shape);
    if (!geo?.getAttribute?.('position')) continue;
    const host = panel ? byId.get(shape.parameters?.parentShapeId) ?? shape : shape;
    const m = getShapeMatrix(host), inv = m.clone().invert(), q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(m));
    if (!geo.boundingBox) geo.computeBoundingBox();
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    let mesh = meshCache.get(geo);
    if (!mesh) { mesh = new THREE.Mesh(geo, RAY_MAT); mesh.matrixAutoUpdate = false; meshCache.set(geo, mesh); }
    const visible = host.isolated !== false && shape.isolated !== false && (!iso || iso.targetId === shape.id)
      && !(pv && panel && shape.parameters?.parentShapeId === pv.shapeId);
    const S = panel ? stepMatrixOf(shape, geo) : null;
    const src: Src = { shape, panel, geo, m, inv, q, mesh, sphere: geo.boundingSphere!.clone().applyMatrix4(m), visible, S, Si: S ? S.clone().invert() : null };
    all.set(shape.id, src);
    if (visible) srcs.push(src);
  }
  _rctx = { shapes, all, srcs }; _rctxIso = iso;
  return _rctx;
}
const _p = new THREE.Vector3();
type P2 = { x: number; y: number };
function toPx(v: View, p: V, out: P2): boolean {
  _p.copy(p).applyMatrix4(v.cam.matrixWorldInverse);
  if ((v.cam as THREE.PerspectiveCamera).isPerspectiveCamera && _p.z > -1e-3) return false;
  _p.applyMatrix4(v.cam.projectionMatrix);
  out.x = (_p.x + 1) * 0.5 * v.w; out.y = (1 - _p.y) * 0.5 * v.h;
  return true;
}
export function wppAt(v: View, p: V): number {
  const persp = v.cam as THREE.PerspectiveCamera;
  if (persp.isPerspectiveCamera) return (2 * Math.tan((persp.fov / DEG) / 2) * Math.max(1e-6, persp.position.distanceTo(p))) / Math.max(v.h, 1);
  const o = v.cam as THREE.OrthographicCamera;
  return (o.top - o.bottom) / (o.zoom || 1) / Math.max(v.h, 1);
}
export const viewDirOf = (v: View) => v.cam.getWorldDirection(V3());
const segDist2 = (px: number, py: number, a: P2, b: P2) => {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2));
  return Math.hypot(px - (a.x + dx * t), py - (a.y + dy * t));
};
const SNAP_PX = 11;
const _rc = new THREE.Raycaster();
/** Kameradan p'ye giden yolu bir PANEL kesiyor mu (katı görünüşte gizli noktaya yakalanılmaz; gövde saydamdır, örtmez). */
function occluded(cur: Cursor, R: RCtx, p: V): boolean {
  const cam = cur.view.cam, persp = (cam as THREE.PerspectiveCamera).isPerspectiveCamera;
  const dir = persp ? p.clone().sub(cam.position) : viewDirOf(cur.view);
  const dist = persp ? dir.length() : p.clone().sub(cam.position).dot(dir);
  if (dist < 1e-6) return false;
  const origin = persp ? cam.position.clone() : p.clone().addScaledVector(dir, -dist);
  _rc.set(origin, dir.normalize()); _rc.near = 0; _rc.far = dist - Math.max(1, dist * 0.002);
  const hits: THREE.Intersection[] = [];
  for (const s of R.srcs) {
    if (!s.panel || !_rc.ray.intersectsSphere(s.sphere)) continue;
    s.mesh.matrixWorld.copy(s.m);
    s.mesh.raycast(_rc, hits);
    if (hits.length) return true;
  }
  return false;
}
/** İmlecin altındaki yüzey noktası: önce en yakın panel, panel yoksa gövde. */
function surfaceAt(cur: Cursor, R: RCtx): { p: V; src: Src; faceIndex: number } | null {
  _rc.set(cur.ray.origin, cur.ray.direction); _rc.near = 0; _rc.far = Infinity;
  let best: { p: V; src: Src; faceIndex: number; d: number } | null = null;
  for (const s of R.srcs) {
    if (!_rc.ray.intersectsSphere(s.sphere)) continue;
    const hits: THREE.Intersection[] = [];
    s.mesh.matrixWorld.copy(s.m);
    s.mesh.raycast(_rc, hits);
    for (const h of hits) {
      const d = h.distance + (s.panel ? 0 : 1e7);
      if (!best || d < best.d) best = { p: h.point.clone(), src: s, faceIndex: h.faceIndex ?? -1, d };
    }
  }
  return best;
}
const arcAngle = (a: ArcC, p: V) => {
  const u = a.a.clone().sub(a.c).normalize(), w = V3().crossVectors(a.n, u), d = p.clone().sub(a.c);
  const t = Math.atan2(d.dot(w), d.dot(u));
  return t < -1e-6 ? t + TAU : Math.max(0, t);
};
const onArc = (a: ArcC, p: V) => a.closed || arcAngle(a, p) <= a.sweep + 1e-4;
export const arcPoint = (a: ArcC, t: number) => a.c.clone().add(rotAbout(a.a.clone().sub(a.c), a.n, t));
const axesOfQ = (q: THREE.Quaternion): [V, V, V] => [V3(1, 0, 0).applyQuaternion(q), V3(0, 1, 0).applyQuaternion(q), V3(0, 0, 1).applyQuaternion(q)];
/** Yay düzleminin tabanı: düzleme en yatkın gövde ekseni u, v = n × u. n'nin işaretinden bağımsız seçilir (yeniden çözümde aynı kalsın). */
function planeBasis(n: V, axes: V[]): { u: V; v: V } {
  let best = axes[0], bd = Infinity;
  for (const a of axes) { const d = Math.abs(a.dot(n)); if (d < bd - 1e-6) { bd = d; best = a; } }
  const u = best.clone().addScaledVector(n, -best.dot(n)).normalize();
  return { u, v: V3().crossVectors(n, u).normalize() };
}
export interface SnapHit3 { p: V; kind: SnapKind; src: Src }
export interface CurveHit { src: Src; c: Curve; p: V }
type Scan = { snap: SnapHit3 | null; curve: CurveHit | null };
/** 3B nesne yakalama + imlecin altındaki kenar. Mesafeler ekran pikselinde ölçülür; `from` dik / teğet için son noktadır. */
export function scan(cur: Cursor, R: RCtx, on: Record<SnapKind, boolean> | null, from: V | null, pick: 'curve' | 'arc' | 'line' | null): Scan {
  const tol = SNAP_PX, solid = useAppStore.getState().viewMode === ViewMode.SOLID;
  type Cand = { p: V; kind: SnapKind; src: Src; cost: number };
  const cands: Cand[] = [], nearLines: { src: Src; c: LineC }[] = [], curves: (CurveHit & { d: number })[] = [];
  const pa = { x: 0, y: 0 }, pb = { x: 0, y: 0 }, pc = { x: 0, y: 0 };
  const rank: Record<SnapKind, number> = { intersection: 0, endpoint: 0, midpoint: 0.02, center: 0.04, quadrant: 0.04, perpendicular: 0.3, tangent: 0.6, nearest: 1 };
  const put = (p: V, kind: SnapKind, src: Src) => {
    if (!toPx(cur.view, p, pc)) return;
    const d = Math.hypot(pc.x - cur.x, pc.y - cur.y);
    if (d <= tol) cands.push({ p, kind, src, cost: d / tol + rank[kind] + (src.panel ? 0 : 0.001) });
  };
  for (const src of R.srcs) {
    const tolW = tol * wppAt(cur.view, src.sphere.center) * 1.5;
    if (cur.ray.distanceSqToPoint(src.sphere.center) > (src.sphere.radius + tolW) ** 2) continue;
    for (const c of worldCurves(src)) {
      if (c.t === 'l') {
        if (!toPx(cur.view, c.a, pa) || !toPx(cur.view, c.b, pb)) continue;
        const d = segDist2(cur.x, cur.y, pa, pb);
        if (d > tol) continue;
        const near = V3();
        cur.ray.distanceSqToSegment(c.a, c.b, undefined, near);
        if (pick !== 'arc') curves.push({ src, c, p: near, d });
        if (!on) continue;
        nearLines.push({ src, c });
        if (on.endpoint) { put(c.a, 'endpoint', src); put(c.b, 'endpoint', src); }
        if (on.midpoint) put(c.a.clone().lerp(c.b, 0.5), 'midpoint', src);
        if (from && on.perpendicular) {
          const u = c.b.clone().sub(c.a), l = u.length();
          if (l > 1e-6) { u.multiplyScalar(1 / l); const t = from.clone().sub(c.a).dot(u); if (t > -1e-6 && t < l + 1e-6) put(c.a.clone().addScaledVector(u, t), 'perpendicular', src); }
        }
        if (on.nearest) cands.push({ p: near, kind: 'nearest', src, cost: 1 + d / tol });
      } else {
        let d = Infinity, bi = 0;
        for (let i = 0; i + 1 < c.pts.length; i++) {
          if (!toPx(cur.view, c.pts[i], pa) || !toPx(cur.view, c.pts[i + 1], pb)) continue;
          const di = segDist2(cur.x, cur.y, pa, pb);
          if (di < d) { d = di; bi = i; }
        }
        const dc = toPx(cur.view, c.c, pc) ? Math.hypot(pc.x - cur.x, pc.y - cur.y) : Infinity, hit = d <= tol;
        if (!hit && !(on?.center && dc <= tol)) continue;
        const near = V3();
        if (hit) {
          cur.ray.distanceSqToSegment(c.pts[bi], c.pts[bi + 1], undefined, near);
          near.sub(c.c).addScaledVector(c.n, -near.dot(c.n)).setLength(c.r).add(c.c);   // tam dairenin üstüne
          if (pick !== 'line') curves.push({ src, c, p: near, d });
        }
        if (!on) continue;
        // Eğrinin üstündeyken merkez: doğrudan adaylara (uç, orta, çeyrek) yenilir.
        if (on.center) cands.push({ p: c.c, kind: 'center', src, cost: dc <= tol ? dc / tol + rank.center : 0.9 });
        if (!hit) continue;
        if (!c.closed) {
          if (on.endpoint) { put(c.a, 'endpoint', src); put(c.b, 'endpoint', src); }
          if (on.midpoint) put(arcPoint(c, c.sweep / 2), 'midpoint', src);
        }
        if (on.quadrant) {
          const { u, v } = planeBasis(c.n, axesOfQ(src.q));
          for (const w of [u, v]) for (const s of [1, -1]) { const q = c.c.clone().addScaledVector(w, s * c.r); if (onArc(c, q)) put(q, 'quadrant', src); }
        }
        if (from) {
          const f = from.clone().sub(c.c), h = f.dot(c.n);
          f.addScaledVector(c.n, -h);
          const fd = f.length();
          if (Math.abs(h) < 0.5 && fd > 1e-6) {
            if (on.perpendicular) for (const s of [1, -1]) { const q = c.c.clone().addScaledVector(f, (s * c.r) / fd); if (onArc(c, q)) put(q, 'perpendicular', src); }
            if (on.tangent && fd > c.r + 1e-6) {
              const off = Math.acos(c.r / fd), base = f.clone().multiplyScalar(c.r / fd);
              const tp = [off, -off].map(a => c.c.clone().add(rotAbout(base, c.n, a))).filter(q => onArc(c, q));
              if (tp.length) cands.push({ p: tp.reduce((m, x) => (x.distanceToSquared(near) < m.distanceToSquared(near) ? x : m)), kind: 'tangent', src, cost: 0.95 });
            }
          }
        }
        if (on.nearest) cands.push({ p: near, kind: 'nearest', src, cost: 1 + d / tol });
      }
    }
  }
  if (on?.intersection) {
    for (let i = 0; i < nearLines.length; i++) for (let j = i + 1; j < nearLines.length; j++) {
      const A = nearLines[i].c, B = nearLines[j].c, x = lineLine(A.a, A.b, B.a, B.b);
      if (x && x.gap < 0.05 && x.s > 1e-4 && x.s < 1 - 1e-4 && x.t > 1e-4 && x.t < 1 - 1e-4) put(x.p, 'intersection', nearLines[i].src);
    }
  }
  cands.sort((a, b) => a.cost - b.cost);
  curves.sort((a, b) => a.d - b.d || (a.src.panel ? 0 : 1) - (b.src.panel ? 0 : 1));
  let snap: SnapHit3 | null = null, curve: CurveHit | null = null, tries = 0;
  for (const c of cands) { if (!solid || tries++ > 7 || !occluded(cur, R, c.p)) { snap = { p: c.p, kind: c.kind, src: c.src }; break; } }
  // Ekranda üst üste düşen aynı tür adaylardan (deliğin ön ve arka ağzının merkezi gibi) kameraya yakın olan alınır.
  if (snap) {
    const s0 = snap, base = cands.find(c => c.p === s0.p)!.cost, depth = (p: V) => p.distanceToSquared(cur.ray.origin);
    for (const c of cands) if (c.kind === s0.kind && c.cost <= base + 0.06 && depth(c.p) < depth(snap.p) - 1e-6 && (!solid || !occluded(cur, R, c.p))) snap = { p: c.p, kind: c.kind, src: c.src };
  }
  tries = 0;
  if (pick) for (const c of curves) { if (!solid || tries++ > 5 || !occluded(cur, R, c.p)) { curve = { src: c.src, c: c.c, p: c.p }; break; } }
  return { snap, curve };
}
/** İki doğrunun (parça parametreleriyle) en yakın noktaları. */
function lineLine(a: V, b: V, c: V, d: V): { p: V; q: V; s: number; t: number; gap: number } | null {
  const u = b.clone().sub(a), v = d.clone().sub(c), w = a.clone().sub(c);
  const A = u.dot(u), B = u.dot(v), C = v.dot(v), D = u.dot(w), E = v.dot(w), den = A * C - B * B;
  if (den < 1e-9 * A * C || A < 1e-12 || C < 1e-12) return null;
  const s = (B * E - C * D) / den, t = (A * E - B * D) / den;
  const p = a.clone().addScaledVector(u, s), q = c.clone().addScaledVector(v, t);
  return { p, q, s, t, gap: p.distanceTo(q) };
}
function rayPlane(ray: THREE.Ray, point: V, normal: V): V | null {
  const den = ray.direction.dot(normal);
  if (Math.abs(den) < 1e-6) return null;
  const t = point.clone().sub(ray.origin).dot(normal) / den;
  return t < 0 ? null : ray.origin.clone().addScaledVector(ray.direction, t);
}

// ═════════════════════════════════════════════════ 3. İLİŞKİSEL ÇAPA ══════════════════════════════════════════════════
/** Ölçülen nokta. sid: ait olduğu şekil · w: alındığı andaki dünya noktası (şekil silinirse ölçü orada kalır) · k: yakalama türü.
 *  l / bb: şeklin geometri koordinatındaki nokta ve kutu (geometri aynı kaldıysa nokta aynen budur).
 *  u / uf / ub: panelin ADIMSIZ çerçevesindeki nokta, kutu oranı ve kutu (adımsız şekilde l / f / bb ile aynı, yazılmaz) · sk: o anki adım dönüşümünün anahtarı. */
export interface Anchor { sid: string | null; w: T3; l?: T3; f?: T3; bb?: number[]; k: SnapKind | 'free'; u?: T3; uf?: T3; ub?: number[]; sk?: string }
const stepKey = (S: THREE.Matrix4 | null) => (S ? S.elements.map(x => x.toFixed(4)).join(',') : '');
const fracIn = (p: V, bb: THREE.Box3): T3 => {
  const sz = bb.getSize(V3()), fr = (v: number, mn: number, s: number) => (s < 1e-9 ? 0.5 : (v - mn) / s);
  return [fr(p.x, bb.min.x, sz.x), fr(p.y, bb.min.y, sz.y), fr(p.z, bb.min.z, sz.z)];
};
export function makeAnchor(p: V, src: Src | null, k: Anchor['k']): Anchor {
  if (!src) return { sid: null, w: t3(p), k };
  const l = p.clone().applyMatrix4(src.inv), bb = src.geo.boundingBox!;
  const a: Anchor = { sid: src.shape.id, w: t3(p), l: t3(l), f: fracIn(l, bb), bb: [...t3(bb.min), ...t3(bb.max)], k, sk: stepKey(src.S) };
  if (src.Si) {
    // Panel taşınmış / dönmüşse nokta adımsız çerçevede de saklanır: sonra taşınır / dönerse oradan güncel dönüşümle götürülür.
    const u = l.clone().applyMatrix4(src.Si), ub = baseBox(src.geo, src.Si);
    Object.assign(a, { u: t3(u), uf: fracIn(u, ub), ub: [...t3(ub.min), ...t3(ub.max)] });
  }
  return a;
}
const localCache = new WeakMap<Anchor, { geo: THREE.BufferGeometry; S: THREE.Matrix4 | null; p: V }>();
const boxGap = (bb: THREE.Box3, b0: number[]) =>
  Math.abs(bb.min.x - b0[0]) + Math.abs(bb.min.y - b0[1]) + Math.abs(bb.min.z - b0[2]) + Math.abs(bb.max.x - b0[3]) + Math.abs(bb.max.y - b0[4]) + Math.abs(bb.max.z - b0[5]);
/** Çapanın şimdiki yeri, şeklin geometri koordinatında:
 *  1) geometrinin kutusu aynıysa nokta aynen (motor dönen paneli gövdeye sığdırıp aynı levhayı verdiyse de);
 *  2) panel o günden beri taşındı / döndüyse nokta adımsız çerçeveden güncel dönüşümle götürülür (motor levhayı yeniden sığdırdıysa
 *     kutu oranı daha iyi oturuyorsa o);
 *  3) yalnız ölçüler değiştiyse (gövde büyüdü) adımsız kutudaki oranından bulunur.
 *  2 ve 3'te nokta sonra gerçek geometriye oturtulur (köşe → köşe, kenar → kenar, yüzey → yüzey). */
function localOf(a: Anchor, s: Src): V {
  const geo = s.geo, hit = localCache.get(a);
  if (hit && hit.geo === geo && hit.S === s.S) return hit.p;
  let p: V;
  const inBox = (bb: THREE.Box3, f: T3) => { const sz = bb.getSize(V3()); return V3(bb.min.x + f[0] * sz.x, bb.min.y + f[1] * sz.y, bb.min.z + f[2] * sz.z); };
  if (boxGap(geo.boundingBox!, a.bb!) <= 1e-3) p = vt(a.l!);
  else if ((a.sk ?? '') !== stepKey(s.S)) {
    // Panel taşındı / döndü: (A) nokta panelle götürülür; (B) geometrinin kutusundaki oranı. Motor dönen paneli gövdeye sığdırınca levha
    // dönmemiş gibi kalabilir — o zaman B tutar. Geometriye daha iyi oturan seçilir (eşitlikte A).
    const A = vt(a.u ?? a.l!);
    if (s.S) A.applyMatrix4(s.S);
    const B = inBox(geo.boundingBox!, a.f!), sA = seatOnGeo(A, a.k, geo), sB = seatOnGeo(B, a.k, geo);
    p = sB.distanceTo(B) + 0.5 < sA.distanceTo(A) ? sB : sA;
  } else {
    const ub = baseBox(geo, s.Si);
    p = boxGap(ub, a.ub ?? a.bb!) <= 1e-3 ? vt(a.u ?? a.l!) : inBox(ub, a.uf ?? a.f!);
    if (s.S) p.applyMatrix4(s.S);
    p = seatOnGeo(p, a.k, geo);
  }
  localCache.set(a, { geo, S: s.S, p });
  return p;
}
export function anchorPoint(a: Anchor, R: RCtx): V {
  const s = a.sid ? R.all.get(a.sid) : undefined;
  if (!s || !a.l || !a.f || !a.bb) return vt(a.w);
  return localOf(a, s).clone().applyMatrix4(s.m);
}
const IDENT_Q = new THREE.Quaternion();
/** Gövde ekseni (yerleştirme kuralları, ordinat, yay tabanı). */
const quatOf = (sid: string | null, R: RCtx) => (sid ? R.all.get(sid)?.q : undefined) ?? IDENT_Q;
/** Doğrusal ölçünün yönünün saklandığı çerçeve = gövde ekseni: CAD'deki gibi yatay ölçü, ölçülen panel dönse de yatay kalır (uçlar panelle gider). */
const frameOf = quatOf;
/** Yaya bağlı ölçülerin kaynağı: merkez çapası + alındığı andaki yarıçap ve (gövde yerelinde) düzlem normali. */
export interface ArcRef { c: Anchor; r: number; n: T3 }
export interface ArcRes { c: V; n: V; r: number; a: V; b: V; sweep: number; closed: boolean; u: V; v: V }
const makeArcRef = (h: CurveHit): ArcRef => {
  const a = h.c as ArcC;
  return { c: makeAnchor(a.c, h.src, 'center'), r: a.r, n: t3(a.n.clone().applyQuaternion(h.src.q.clone().invert())) };
};
export function resolveArc(ref: ArcRef, R: RCtx): ArcRes {
  const C = anchorPoint(ref.c, R), s = ref.c.sid ? R.all.get(ref.c.sid) : undefined, axes = axesOfQ(quatOf(ref.c.sid, R));
  let found: ArcC | null = null;
  if (s) for (const c of worldCurves(s)) if (c.t === 'a' && c.c.distanceTo(C) < 0.05 && (!found || Math.abs(c.r - ref.r) < Math.abs(found.r - ref.r))) found = c;
  let n = found ? found.n.clone() : vt(ref.n).applyQuaternion(quatOf(ref.c.sid, R)).normalize();
  // Normalin işareti sabitlenir (baskın gövde ekseninde +): kayıtlı açı yeniden çözümde aynı yeri göstersin.
  const dom = axes.reduce((m, a) => (Math.abs(a.dot(n)) > Math.abs(m.dot(n)) ? a : m));
  const flip = dom.dot(n) < 0;
  if (flip) n = n.negate();
  const { u, v } = planeBasis(n, axes);
  if (!found) return { c: C, n, r: ref.r, a: C.clone().addScaledVector(u, ref.r), b: C.clone().addScaledVector(u, ref.r), sweep: TAU, closed: true, u, v };
  return { c: found.c.clone(), n, r: found.r, a: flip ? found.b : found.a, b: flip ? found.a : found.b, sweep: found.sweep, closed: found.closed, u, v };
}

// ── DELİK: çap + derinlik ──
/** Deliğin ölçüsü. through: boydan boya · depth: kör delikte derinlik (bulunamadıysa null) · from: panelin delik kaydı mı, geometriden mi. */
export interface HoleInfo { d: number; depth: number | null; through: boolean; from: 'record' | 'shape' }
const holeCache = new WeakMap<THREE.BufferGeometry, Map<string, HoleInfo | null>>();
/** Ağzının (ya da dibinin) dairesi verilen deliğin çapı ve derinliği (dünya koordinatında daire). Önce panelin delik kaydı (motorun yazdığı:
 *  bağlayıcı, ayak delikleri — üretimdeki değer), yoksa geometride aynı eksende aynı çaplı dairelerin eksen boyunca açıklığı. */
export function holeInfo(s: Src, cW: V, nW: V, rW: number): HoleInfo | null {
  const k = s.m.getMaxScaleOnAxis() || 1, C = cW.clone().applyMatrix4(s.inv), N = nW.clone().transformDirection(s.inv).normalize(), r = rW / k;
  const recs = (s.shape as Shape & { holes?: { id: string; entry: number[]; dir: number[]; diameter: number; depth: number; through: boolean }[] }).holes ?? [];
  const key = `${C.toArray().map(v => v.toFixed(2)).join(',')}|${N.toArray().map(v => Math.abs(v).toFixed(3)).join(',')}|${r.toFixed(2)}|${recs.map(h => `${h.id}:${h.diameter}:${h.depth}:${h.through}`).join(';')}`;
  let per = holeCache.get(s.geo);
  if (!per) { per = new Map(); holeCache.set(s.geo, per); }
  if (per.has(key)) return per.get(key)!;
  let out: HoleInfo | null = null;
  for (const h of recs) {
    const e = vt(h.entry), d = vt(h.dir).normalize();
    if (Math.abs(d.dot(N)) < 0.999 || Math.abs(h.diameter - 2 * r) > 0.6) continue;
    const off = C.clone().sub(e);
    if (off.addScaledVector(d, -off.dot(d)).length() > 0.6) continue;
    out = { d: h.diameter, depth: h.depth, through: h.through, from: 'record' };
    break;
  }
  if (!out) {
    // Geometri: eksen üstündeki eş çaplı daireler (ağız, dip ya da öbür yüzdeki ağız). Boydan boya = iki uç panelin o eksendeki iki yüzünde.
    const ts: number[] = [];
    for (const c of curvesOf(s.geo)) {
      if (c.t !== 'a' || !c.closed || Math.abs(c.n.dot(N)) < 0.999 || Math.abs(c.r - r) > 0.05) continue;
      const off = c.c.clone().sub(C), t = off.dot(N);
      if (off.addScaledVector(N, -t).length() < 0.3) ts.push(t);
    }
    if (ts.length) {
      const t0 = Math.min(...ts), t1 = Math.max(...ts), depth = t1 - t0;
      const pos = s.geo.getAttribute('position'), v = V3();
      let p0 = Infinity, p1 = -Infinity;
      for (let i = 0; i < pos.count; i++) { const t = v.fromBufferAttribute(pos, i).sub(C).dot(N); if (t < p0) p0 = t; if (t > p1) p1 = t; }
      const through = depth > 0.05 && Math.abs(t0 - p0) < 0.1 && Math.abs(t1 - p1) < 0.1;
      out = { d: r * 2, depth: depth > 0.05 ? depth : null, through, from: 'shape' };
    }
  }
  per.set(key, out);
  return out;
}
const hd = (v: number) => fmt(v, get().style.prec);
/** Delik yazısı — ölçü etiketi (CAD dili): "Ø 35 ↧ 13" · "Ø 8 THRU" · derinlik yoksa "Ø 8". */
export const holeLabel = (h: HoleInfo) => `Ø ${hd(h.d)}${h.through ? ' THRU' : h.depth !== null ? ` ↧ ${hd(h.depth)}` : ''}`;
/** Delik — düz dille (durum çubuğu, okuma kutusu). */
export const holeWords = (h: HoleInfo) =>
  `Ø ${hd(h.d)} · ${h.through ? `through${h.depth !== null ? ` (${hd(h.depth)} mm)` : ''}` : h.depth !== null ? `depth ${hd(h.depth)}` : 'depth unknown'}`;
const holeOfHit = (h: CurveHit) => (h.c.t === 'a' && h.c.closed ? holeInfo(h.src, h.c.c, h.c.n, h.c.r) : null);

// ═════════════════════════════════════════════════ 4. ÖLÇÜ MODELİ · ÇİZİMİ ════════════════════════════════════════════
export type AngSrc = { k: '3p'; v: Anchor; p1: Anchor; p2: Anchor } | { k: 'll'; a1: Anchor; b1: Anchor; a2: Anchor; b2: Anchor } | { k: 'arc'; arc: ArcRef };
/** lin: ax = ölçülen yön (a'nın gövde yerelinde; null → hizalı), e = ölçü çizgisinin kaçıklık yönü, off = a'dan ölçü çizgisine uzaklık.
 *  ang: r = ölçü yayının yarıçapı; sa / sb = iki doğruda hangi yarı (dört açıdan biri); reflex = geniş taraf.
 *  rad / dia / arc / jog: ang = yay düzleminde yön, len = merkeze uzaklık. ord: axis = gösterilen koordinat, end = kılavuz ucu (gövde yerelinde). */
export type Dim =
  | { id: string; t: 'lin'; a: Anchor; b: Anchor; ax: T3 | null; e: T3; off: number; txt?: string }
  | { id: string; t: 'ang'; g: AngSrc; r: number; sa: 1 | -1; sb: 1 | -1; reflex: boolean; txt?: string }
  | { id: string; t: 'rad' | 'dia' | 'arc'; arc: ArcRef; ang: number; len: number; txt?: string }
  | { id: string; t: 'jog'; arc: ArcRef; ang: number; len: number; ov: [number, number]; jog: number; txt?: string }
  | { id: string; t: 'ord'; p: Anchor; axis: 0 | 1 | 2; end: T3; txt?: string }
  | { id: string; t: 'cmark'; arc: ArcRef }
  /** Delik etiketi: yayın (deliğin dairesi) ang yönündeki noktasından len uzaklığa kılavuz; yazı çap + derinlik, her çizimde kayıttan / geometriden. */
  | { id: string; t: 'hole'; arc: ArcRef; ang: number; len: number; txt?: string };
type DistOmit<T, K extends string> = T extends unknown ? Omit<T, K> : never;
type NewDim = DistOmit<Dim, 'id'>;
export type ArrowKind = 'open' | 'closed' | 'tick' | 'dot';
/** Ölçü stili — boylar ekran pikselidir (yakınlaşınca yazı ve oklar aynı boyda kalır). */
export interface DimStyle { text: number; arrow: number; arrowKind: ArrowKind; gap: number; over: number; prec: number; aprec: number; color: string; spacing: number }
export const DEFAULT_STYLE: DimStyle = { text: 12, arrow: 9, arrowKind: 'open', gap: 5, over: 7, prec: 1, aprec: 1, color: '#1c1917', spacing: 26 };
export interface DimDraw { lines: V[][]; arrows: { tip: V; dir: V }[]; text: string; at: V; value: number }
const AXIS = ['X', 'Y', 'Z'] as const;
const label = (txt: string | undefined, measured: string) => (txt?.trim() ? txt.replace(/<>/g, measured) : measured);

function angResolve(g: AngSrc, R: RCtx): { v: V; d1: V; d2: V; l1: number; l2: number; n: V | null; sweep: number } | null {
  if (g.k === 'arc') {
    const a = resolveArc(g.arc, R);
    return { v: a.c, d1: a.a.clone().sub(a.c).normalize(), d2: a.b.clone().sub(a.c).normalize(), l1: a.r, l2: a.r, n: a.n, sweep: a.sweep };
  }
  let v: V, P1: V, P2: V, l1: number, l2: number;
  if (g.k === '3p') { v = anchorPoint(g.v, R); P1 = anchorPoint(g.p1, R); P2 = anchorPoint(g.p2, R); l1 = P1.distanceTo(v); l2 = P2.distanceTo(v); }
  else {
    const a1 = anchorPoint(g.a1, R), b1 = anchorPoint(g.b1, R), a2 = anchorPoint(g.a2, R), b2 = anchorPoint(g.b2, R), x = lineLine(a1, b1, a2, b2);
    if (!x) return null;
    v = x.p.clone().lerp(x.q, 0.5);
    // Her doğrunun yönü: tepe noktasından parçanın uzak ucuna doğru.
    P1 = a1.distanceTo(v) > b1.distanceTo(v) ? a1 : b1; P2 = a2.distanceTo(v) > b2.distanceTo(v) ? a2 : b2;
    l1 = P1.distanceTo(v); l2 = P2.distanceTo(v);
  }
  if (l1 < 1e-6 || l2 < 1e-6) return null;
  const d1 = P1.clone().sub(v).normalize(), d2 = P2.clone().sub(v).normalize();
  if (V3().crossVectors(d1, d2).length() < 1e-5) return null;
  return { v, d1, d2, l1, l2, n: null, sweep: d1.angleTo(d2) };
}
/** Açı ölçüsünün çizilecek yayı: tepe, başlangıç yönü, dönme ekseni, açı (rad) ve iki ucun referans uzaklığı. */
function angArc(d: Extract<Dim, { t: 'ang' }>, R: RCtx): { v: V; s: V; m: V; th: number; l1: number; l2: number } | null {
  const a = angResolve(d.g, R);
  if (!a) return null;
  if (a.n) return d.reflex ? { v: a.v, s: a.d2, m: a.n, th: TAU - a.sweep, l1: a.l2, l2: a.l1 } : { v: a.v, s: a.d1, m: a.n, th: a.sweep, l1: a.l1, l2: a.l2 };
  const r1 = a.d1.clone().multiplyScalar(d.sa), r2 = a.d2.clone().multiplyScalar(d.sb), m = V3().crossVectors(r1, r2).normalize(), th = r1.angleTo(r2);
  const f1 = d.sa > 0 ? a.l1 : 0, f2 = d.sb > 0 ? a.l2 : 0;
  return d.reflex ? { v: a.v, s: r2, m, th: TAU - th, l1: f2, l2: f1 } : { v: a.v, s: r1, m, th, l1: f1, l2: f2 };
}
const arcPts = (c: V, s: V, m: V, r: number, th: number) => {
  const n = Math.max(6, Math.ceil(th / (5 / DEG))), out: V[] = [];
  for (let i = 0; i <= n; i++) out.push(c.clone().add(rotAbout(s, m, (th * i) / n).multiplyScalar(r)));
  return out;
};
/** Ölçünün çizimi (dünya koordinatı). wpp: ölçünün bulunduğu yerde bir pikselin mm karşılığı. */
export function drawDim(d: Dim, R: RCtx, wpp: number, st: DimStyle): DimDraw | null {
  const gap = st.gap * wpp, over = st.over * wpp, arr = st.arrow * wpp, lines: V[][] = [], arrows: DimDraw['arrows'] = [];
  const textW = (s: string) => s.length * st.text * 0.62 * wpp;
  /** Uzatma çizgisi: ölçülen noktadan (boşluk bırakarak) ölçü çizgisinin biraz ötesine. */
  const ext = (P: V, f: V) => { const v = f.clone().sub(P), l = v.length(); if (l > gap + 1e-6) { v.multiplyScalar(1 / l); lines.push([P.clone().addScaledVector(v, gap), f.clone().addScaledVector(v, over)]); } };
  if (d.t === 'lin') {
    const A = anchorPoint(d.a, R), B = anchorPoint(d.b, R), q = frameOf(d.a.sid, R);
    const dir = d.ax ? vt(d.ax).applyQuaternion(q) : B.clone().sub(A);
    if (dir.lengthSq() < 1e-12) dir.set(1, 0, 0);
    dir.normalize();
    let e = vt(d.e).applyQuaternion(q);
    e.addScaledVector(dir, -e.dot(dir));
    if (e.lengthSq() < 1e-8) e = anyPerp(dir);
    e.normalize();
    const len = B.clone().sub(A).dot(dir), value = Math.abs(len), u = dir.clone().multiplyScalar(sgn(len));
    const fa = A.clone().addScaledVector(e, d.off), fb = fa.clone().addScaledVector(dir, len), text = label(d.txt, fmt(value, st.prec));
    ext(A, fa); ext(B, fb);
    const at = fa.clone().lerp(fb, 0.5);
    if (value >= textW(text) + 2 * arr + 6 * wpp) { lines.push([fa, fb]); arrows.push({ tip: fa, dir: u.clone().negate() }, { tip: fb, dir: u }); }
    else {
      // Sığmıyor: oklar dışarıdan, yazı ölçü çizgisinin dış yanında.
      lines.push([fa.clone().addScaledVector(u, -2.4 * arr), fb.clone().addScaledVector(u, 2.4 * arr)]);
      arrows.push({ tip: fa, dir: u }, { tip: fb, dir: u.clone().negate() });
      at.addScaledVector(e, sgn(d.off) * st.text * 0.95 * wpp);
    }
    return { lines, arrows, text, at, value };
  }
  if (d.t === 'ang') {
    const a = angArc(d, R);
    if (!a) return null;
    const pts = arcPts(a.v, a.s, a.m, d.r, a.th), e = rotAbout(a.s, a.m, a.th), value = a.th * DEG;
    lines.push(pts);
    for (const [r, l] of [[a.s, a.l1], [e, a.l2]] as [V, number][]) if (d.r + over > l + gap) lines.push([a.v.clone().addScaledVector(r, l + gap), a.v.clone().addScaledVector(r, d.r + over)]);
    arrows.push({ tip: pts[0], dir: V3().crossVectors(a.m, a.s).negate() }, { tip: pts[pts.length - 1], dir: V3().crossVectors(a.m, e) });
    return { lines, arrows, text: label(d.txt, `${fmt(value, st.aprec)}°`), at: a.v.clone().add(rotAbout(a.s, a.m, a.th / 2).multiplyScalar(d.r)), value };
  }
  if (d.t === 'ord') {
    const P = anchorPoint(d.p, R), s = d.p.sid ? R.all.get(d.p.sid) : undefined, q = quatOf(d.p.sid, R), axes = axesOfQ(q);
    const value = (s ? P.clone().applyMatrix4(s.inv) : P).getComponent(d.axis);
    const end = vt(d.end).applyQuaternion(q), x = axes[d.axis], t = end.dot(x), along = end.clone().addScaledVector(x, -t), E = P.clone().add(end);
    const al = along.length();
    if (al < 1e-6) return null;
    along.multiplyScalar(1 / al);
    const P0 = P.clone().addScaledVector(along, Math.min(gap, al * 0.2));
    // Kılavuz: ölçülen eksene dik gider; uç yana kaçıksa ortada bir kırıkla.
    lines.push(Math.abs(t) < 1e-6 ? [P0, E] : [P0, P.clone().addScaledVector(along, al * 0.4), P.clone().addScaledVector(along, al * 0.6).addScaledVector(x, t), E]);
    const text = label(d.txt, `${AXIS[d.axis]} ${fmt(value, st.prec)}`);
    return { lines, arrows, text, at: E.clone().addScaledVector(along, st.text * 0.9 * wpp), value };
  }
  const a = resolveArc(d.arc, R);
  if (d.t === 'cmark') {
    const s = Math.min(a.r * 0.3, 7 * wpp), o = Math.max(over, a.r * 0.12);
    for (const w of [a.u, a.v]) {
      lines.push([a.c.clone().addScaledVector(w, -s), a.c.clone().addScaledVector(w, s)]);
      for (const k of [1, -1]) if (a.r > s * 2.2) lines.push([a.c.clone().addScaledVector(w, k * s * 1.8), a.c.clone().addScaledVector(w, k * (a.r + o))]);
    }
    return { lines, arrows, text: '', at: a.c, value: a.r };
  }
  const w = a.u.clone().multiplyScalar(Math.cos(d.ang)).addScaledVector(a.v, Math.sin(d.ang)), P = a.c.clone().addScaledVector(w, a.r);
  const cross = () => { const s = 4 * wpp; lines.push([a.c.clone().addScaledVector(a.u, -s), a.c.clone().addScaledVector(a.u, s)], [a.c.clone().addScaledVector(a.v, -s), a.c.clone().addScaledVector(a.v, s)]); };
  if (d.t === 'rad') {
    const text = label(d.txt, `R ${fmt(a.r, st.prec)}`), inside = d.len < a.r;
    if (inside) { lines.push([a.c, P]); arrows.push({ tip: P, dir: w }); return { lines, arrows, text, at: a.c.clone().addScaledVector(w, Math.max(d.len, Math.min(a.r * 0.5, textW(text)))), value: a.r }; }
    cross(); lines.push([P, a.c.clone().addScaledVector(w, d.len)]); arrows.push({ tip: P, dir: w.clone().negate() });
    return { lines, arrows, text, at: a.c.clone().addScaledVector(w, d.len + textW(text) * 0.5 + 4 * wpp), value: a.r };
  }
  if (d.t === 'dia') {
    const text = label(d.txt, `Ø ${fmt(a.r * 2, st.prec)}`), Q = a.c.clone().addScaledVector(w, -a.r), inside = d.len < a.r;
    arrows.push({ tip: Q, dir: w.clone().negate() });
    if (inside) { lines.push([Q, P]); arrows.push({ tip: P, dir: w }); return { lines, arrows, text, at: a.c.clone().addScaledVector(w, d.len), value: a.r * 2 }; }
    lines.push([Q, a.c.clone().addScaledVector(w, d.len)]); arrows.push({ tip: P, dir: w });
    return { lines, arrows, text, at: a.c.clone().addScaledVector(w, d.len + textW(text) * 0.5 + 4 * wpp), value: a.r * 2 };
  }
  if (d.t === 'arc') {
    const s = a.a.clone().sub(a.c).normalize(), e = rotAbout(s, a.n, a.sweep), rr = Math.max(d.len, 1e-3), pts = arcPts(a.c, s, a.n, rr, a.sweep), value = a.r * a.sweep;
    lines.push(pts);
    ext(a.c.clone().addScaledVector(s, a.r), a.c.clone().addScaledVector(s, rr)); ext(a.c.clone().addScaledVector(e, a.r), a.c.clone().addScaledVector(e, rr));
    arrows.push({ tip: pts[0], dir: V3().crossVectors(a.n, s).negate() }, { tip: pts[pts.length - 1], dir: V3().crossVectors(a.n, e) });
    return { lines, arrows, text: label(d.txt, `⌒ ${fmt(value, st.prec)}`), at: a.c.clone().add(rotAbout(s, a.n, a.sweep / 2).multiplyScalar(rr)), value };
  }
  if (d.t === 'hole') {
    const s = d.arc.c.sid ? R.all.get(d.arc.c.sid) : undefined, info = s ? holeInfo(s, a.c, a.n, a.r) : null;
    const E = a.c.clone().addScaledVector(w, Math.max(d.len, a.r + 6 * wpp)), shoulder = 10 * wpp;
    // Kılavuz: delik ağzından yazıya; yazının yanında kısa omuz (ekrana göre yatay yön: yayın düzleminde imlecin tarafına).
    const side = w.dot(a.u) >= 0 ? a.u.clone() : a.u.clone().negate(), S = E.clone().addScaledVector(side, shoulder);
    lines.push([P, E, S]);
    arrows.push({ tip: P, dir: P.clone().sub(E).normalize() });
    const text = label(d.txt, info ? holeLabel(info) : `Ø ${fmt(a.r * 2, st.prec)}`);
    return { lines, arrows, text, at: S.clone().addScaledVector(side, textW(text) * 0.5 + 4 * wpp), value: a.r * 2 };
  }
  if (d.t !== 'jog') return null;
  // Kırıklı yarıçap: merkez yerine seçilen noktadan çıkar, gerçek yarıçap doğrultusunda yaya varır; arada 45° kırık.
  const p = V3().crossVectors(a.n, w), O = a.c.clone().addScaledVector(a.u, d.ov[0]).addScaledVector(a.v, d.ov[1]);
  const t0 = O.clone().sub(P).dot(w), dl = O.clone().sub(P).dot(p), h = Math.min(Math.abs(dl) / 2, Math.abs(t0) / 3);
  const tj = Math.max(Math.min(d.jog, -1.5 * h), t0 + 1.5 * h), J2 = P.clone().addScaledVector(w, tj + h), J1 = P.clone().addScaledVector(p, dl).addScaledVector(w, tj - h);
  lines.push([P.clone().addScaledVector(p, dl).addScaledVector(w, t0), J1, J2, P]);
  arrows.push({ tip: P, dir: w });
  const text = label(d.txt, `R ${fmt(a.r, st.prec)}`);
  return { lines, arrows, text, at: J2.clone().lerp(P, 0.5).addScaledVector(p, sgn(-dl) * st.text * 0.95 * wpp), value: a.r };
}
/** Ölçünün dünya üzerindeki yaklaşık yeri (ekran ölçeği için). */
export function dimCenter(d: Dim, R: RCtx): V {
  if (d.t === 'lin') return anchorPoint(d.a, R).lerp(anchorPoint(d.b, R), 0.5);
  if (d.t === 'ord') return anchorPoint(d.p, R);
  if (d.t === 'ang') return (d.g.k === 'arc' ? anchorPoint(d.g.arc.c, R) : d.g.k === '3p' ? anchorPoint(d.g.v, R) : anchorPoint(d.g.a1, R));
  return anchorPoint(d.arc.c, R);
}

// ── YERLEŞTİRME: imleç ışınından ölçü çizgisinin yeri ──
/** d yönünü içeren, kameraya en çok dönük eksen düzlemi: e = kaçıklık yönü, n = düzlem normali. */
function offsetFrame(d: V, axes: V[], view: V): { e: V; n: V } {
  let best: { e: V; n: V } | null = null, bs = -1;
  for (const k of axes) {
    const e = k.clone().addScaledVector(d, -k.dot(d));
    if (e.length() < 0.2) continue;
    e.normalize();
    const n = V3().crossVectors(d, e), s = Math.abs(n.dot(view));
    if (s > bs + 1e-6) { bs = s; best = { e, n }; }
  }
  if (best) return best;
  const e = anyPerp(d);
  return { e, n: V3().crossVectors(d, e) };
}
export type LinLock = 0 | 1 | 2 | 'ali' | null;
/** Doğrusal / hizalı ölçünün yönü ve yeri. Kilit yoksa kameraya dönük eksen düzleminde: imleç noktaların üstünde / altındaysa yatay,
 *  yanındaysa dikey ölçü (2B'deki kural); iki nokta yalnız derinlikte ayrılıyorsa derinlik ekseni. */
export function placeLinear(A: V, B: V, axes: V[], cur: Cursor, lock: LinLock, prevAxis: number | null): { d: V; e: V; off: number; axis: number | null } {
  const view = viewDirOf(cur.view), AB = B.clone().sub(A);
  let d: V, axis: number | null = null;
  if (lock === 'ali') d = AB.lengthSq() < 1e-10 ? axes[0].clone() : AB.clone().normalize();
  else if (lock !== null) { axis = lock; d = axes[lock].clone(); }
  else {
    const k = [0, 1, 2].reduce((m, i) => (Math.abs(axes[i].dot(view)) > Math.abs(axes[m].dot(view)) ? i : m), 0), ui = (k + 1) % 3, vi = (k + 2) % 3;
    const du = AB.dot(axes[ui]), dv = AB.dot(axes[vi]), eps = 0.01, Q = rayPlane(cur.ray, A, axes[k]);
    if (Math.abs(du) < eps && Math.abs(dv) < eps) axis = k;
    else if (Math.abs(du) < eps) axis = vi;
    else if (Math.abs(dv) < eps) axis = ui;
    else {
      const qu = Q ? Q.clone().sub(A).dot(axes[ui]) : 0, qv = Q ? Q.clone().sub(A).dot(axes[vi]) : 0;
      const out = (q: number, dd: number) => Math.max(0, Math.min(0, dd) - q, q - Math.max(0, dd));
      const ex = out(qu, du), ey = out(qv, dv);
      axis = ey > ex ? ui : ex > ey ? vi : prevAxis === ui || prevAxis === vi ? prevAxis : Math.abs(du) >= Math.abs(dv) ? ui : vi;
    }
    d = axes[axis].clone();
  }
  const { e, n } = offsetFrame(d, axes, view), Q = rayPlane(cur.ray, A, n);
  return { d, e, off: Q ? Q.sub(A).dot(e) : 0, axis };
}

// ═════════════════════════════════════════════════ 5. DEPO · SÜRÜCÜ ═══════════════════════════════════════════════════
type PickKind = 'curve' | 'arc' | 'line' | 'dim' | 'lindim' | 'face';
/** İmlecin çözülmüş hâli: nokta (+ çapası), yakalama türü, altındaki kenar / ölçü / yüz. */
export interface Hit {
  p: V; anchor: Anchor; snap: SnapKind | null; /** yakalanan nokta imlecin dibinde mi (eğri üstündeyken gelen merkez / teğet değil) */ snapNear: boolean;
  src: Src | null; curve: CurveHit | null; dimId: string | null;
  face: { src: Src; faceIndex: number; p: V } | null; cur: Cursor; wpp: number;
}
/** Sahnede geçici çizilenler: hayalet ölçüler, lastik çizgiler, vurgulanan kenarlar, imleç yanındaki okuma. */
export interface Preview { dims?: Dim[]; lines?: V[][]; hi?: V[][]; note?: string[]; at?: V; fill?: V[] }
interface Req {
  prompt: string; kind: 'point' | 'pick' | 'value' | 'text'; opts?: Opt[]; def?: string; from?: V | null; pick?: PickKind;
  noSnap?: boolean; num?: boolean; preview?: (h: Hit) => Preview;
  /** Durum çubuğu: komutun kaçıncı adımı · düz dille ne yapılacağı (imlecin altındakine göre değişebilir) · sağ tıkın bu adımdaki anlamı. */
  s?: number; tip?: string | ((h: Hit | null) => string); enter?: string;
}
type Ev = { k: 'pt'; h: Hit } | { k: 'opt'; key: string } | { k: 'num'; v: number } | { k: 'text'; s: string } | { k: 'enter' };
type G<T = void> = Generator<Req, T, Ev>;
export interface DimCursor { p: T3; snap: SnapKind | null; pick: boolean; wpp: number }
export interface DimState {
  dims: Dim[]; selection: string[]; visible: boolean; style: DimStyle; styleOpen: boolean;
  cmd: CmdView | null; cursor: DimCursor | null; preview: Preview | null;
  /** Ölçme komutlarının (DIST, AREA …) sahnede kalan sonucu — sonraki komuta / Esc'ye kadar. */
  result: Preview | null;
  lastCmd: string | null; undo: Dim[][]; dragId: string | null;
  /** Boştayken imlecin altındaki ölçü (çizgisi, oku ya da yazısı). */
  hoverId: string | null;
  /** Etkin komutun durum çubuğu yönergesi: adım, metin, sağ tıkın anlamı. */
  guideStep: number; guideText: string | null; guideEnter: string | null;
}
export const useDim = create<DimState>(() => ({
  dims: [], selection: [], visible: true, style: DEFAULT_STYLE, styleOpen: false, cmd: null, cursor: null, preview: null, result: null,
  lastCmd: null, undo: [], dragId: null, hoverId: null, guideStep: 0, guideText: null, guideEnter: null,
}));
const get = useDim.getState, set = useDim.setState;
const say = (t: string) => useDraft.setState(s => ({ log: [...s.log.slice(-59), t] }));
let gen: G | null = null, req: Req | null = null, curDef: DimCmd | null = null, lastCur: Cursor | null = null, lastHit: Hit | null = null, seq = 0;
let lastWas: 'dim' | 'draft' = 'draft', lastSeries: string | null = null;
// Çizim komutu başlarsa ölçü komutu düşer (iki sürücü aynı anda fareyi tutmaz).
useDraft.subscribe((s, p) => { if (s.cmd && !p.cmd) { lastWas = 'draft'; if (gen) cancelDim(); } });
// Geliştirme (HMR): bu modül sıcak yenilenirse ikinci bir kopya doğar — araç çubuğu yeni kopyada komut başlatır, tuvaldeki
// DimLayer eski kopyayı dinler; kenar yakalama ölür, düğme "çalışmıyor" görünür (git pull sırasında açık sunucu). Tam yenile.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());

const snapsOn = (): Record<SnapKind, boolean> | null => {
  const a = useAppStore.getState();
  return a.snapEnabled ? (a.snapSettings as unknown as Record<SnapKind, boolean>) : null;
};
/** Ölçünün ekrandaki uzaklığı (çizgileri + yazısı) — ölçü seçimi için. */
function dimAt(cur: Cursor, R: RCtx, only: (d: Dim) => boolean, tol = SNAP_PX + 2): string | null {
  const st = get(), pa = { x: 0, y: 0 }, pb = { x: 0, y: 0 };
  let best: string | null = null, bd = tol;
  for (const d of st.dims) {
    if (!only(d)) continue;
    const dr = drawDim(d, R, wppAt(cur.view, dimCenter(d, R)), st.style);
    if (!dr) continue;
    let m = dr.text && toPx(cur.view, dr.at, pa) ? Math.hypot(pa.x - cur.x, pa.y - cur.y) - 8 : Infinity;
    for (const l of dr.lines) for (let i = 0; i + 1 < l.length; i++) if (toPx(cur.view, l[i], pa) && toPx(cur.view, l[i + 1], pb)) m = Math.min(m, segDist2(cur.x, cur.y, pa, pb));
    if (m < bd) { bd = m; best = d.id; }
  }
  return best;
}
/** İmleci isteğe göre çözer: yakalama → yüzey noktası → (hiçbiri yoksa) son noktadan / orijinden geçen, kameraya dönük düzlem. */
export function resolveHit(cur: Cursor, r: Req | null): Hit {
  const R = rctx(), wantPt = !r || r.kind === 'point', pick = r?.pick ?? null;
  const curvePick = pick === 'curve' || pick === 'arc' || pick === 'line' ? pick : null;
  const sc = scan(cur, R, wantPt && !r?.noSnap ? snapsOn() : null, r?.from ?? null, curvePick);
  let p: V | null = sc.snap?.p ?? null, src: Src | null = sc.snap?.src ?? null, face: Hit['face'] = null;
  if (!p || pick === 'face') {
    const s = r?.noSnap && pick !== 'face' ? null : surfaceAt(cur, R);
    if (s) { face = s; if (!p) { p = s.p; src = s.src; } }
  }
  if (!p) {
    const base = r?.from ?? V3(), view = viewDirOf(cur.view);
    p = (!r?.from && Math.abs(view.y) > 0.15 ? rayPlane(cur.ray, V3(), V3(0, 1, 0)) : null) ?? rayPlane(cur.ray, base, view) ?? cur.ray.origin.clone().addScaledVector(cur.ray.direction, 1000);
  }
  const dimId = pick === 'dim' || pick === 'lindim' ? dimAt(cur, R, d => pick === 'dim' || d.t === 'lin') : null;
  const px = { x: 0, y: 0 }, snapNear = !!sc.snap && sc.snap.kind !== 'nearest' && toPx(cur.view, sc.snap.p, px) && Math.hypot(px.x - cur.x, px.y - cur.y) <= SNAP_PX;
  return { p, anchor: makeAnchor(p, src, sc.snap?.kind ?? 'free'), snap: sc.snap?.kind ?? null, snapNear, src, curve: sc.curve, dimId, face, cur, wpp: wppAt(cur.view, p) };
}
const curvePts = (c: Curve): V[] => (c.t === 'l' ? [c.a, c.b] : c.pts);
/** DIM'de kenarın üstündeki tık o NESNENİN ölçüsüdür; yalnız uç / kesişim noktasına yakalanmışsa nokta sayılır (ortası, merkezi, çeyreği nesnedir). */
const objectFirst = (h: Hit) => !!h.curve && !(h.snapNear && (h.snap === 'endpoint' || h.snap === 'intersection'));
function refresh() {
  const view: CmdView | null = gen && req && curDef
    ? { id: curDef.id, label: curDef.label, prompt: req.prompt, opts: req.opts ?? [], def: req.def, kind: req.kind === 'text' ? 'value' : req.kind, hasBase: !!req.from, num: !!req.num } : null;
  let cursor: DimCursor | null = null, preview: Preview | null = null;
  if (gen && req && lastCur && req.kind !== 'value' && req.kind !== 'text') {
    const h = lastHit = resolveHit(lastCur, req);
    cursor = { p: t3(h.p), snap: h.snap, pick: req.kind === 'pick', wpp: h.wpp };
    try { preview = req.preview?.(h) ?? null; } catch (err) { console.warn('[YAGO][DIM] önizleme hatası:', err); }
    // İmlecin altındaki seçilebilir kenar / ölçü vurgulanır (yakalama varken nokta önceliklidir).
    const hi = [...(preview?.hi ?? [])];
    if (h.curve && req.pick && (req.kind === 'pick' || objectFirst(h))) hi.push(curvePts(h.curve.c));
    if (hi.length) preview = { ...(preview ?? {}), hi };
  } else if (gen && req?.preview && lastHit) { try { preview = req.preview(lastHit); } catch { preview = null; } }
  let guideText: string | null = null;
  if (gen && req) { try { guideText = typeof req.tip === 'function' ? req.tip(cursor ? lastHit : null) : req.tip ?? null; } catch { guideText = null; } }
  set({ cmd: view, cursor, preview, guideText, guideStep: req?.s ?? 0, guideEnter: gen ? req?.enter ?? null : null, ...(gen ? { hoverId: null } : null) });
}
function finish() { gen = null; req = null; curDef = null; lastHit = null; refresh(); }
function advance(ev?: Ev) {
  if (!gen) return;
  let r: IteratorResult<Req, void>;
  try { r = gen.next(ev as Ev); }
  catch (err) { console.error('[YAGO][DIM] komut hatası:', err); say('Command failed.'); r = { done: true, value: undefined }; }
  if (r.done) { finish(); return; }
  req = r.value;
  refresh();
}
export const dimActive = () => !!gen;
export function cancelDim(): boolean {
  if (!gen) return false;
  try { gen.return(undefined); } catch { /* üreteç zaten bitmiş */ }
  say('*Cancel*');
  finish();
  return true;
}
const findCmd = (name: string) => { const up = name.trim().toUpperCase(); return DIM_COMMANDS.find(c => c.id === up || c.aliases.includes(up)); };
export const isDimCommand = (name: string) => !!findCmd(name);
export function startDim(name: string): boolean {
  const def = findCmd(name);
  if (!def) return false;
  cancelDraftCommand(); cancelDim();
  curDef = def; lastWas = 'dim';
  set({ lastCmd: def.id, result: null, selection: [], visible: true });
  say(`Command: ${def.id}`);
  gen = def.run(ctx);
  advance();
  return true;
}
export function dimPointerMove(cur: Cursor) { lastCur = cur; if (gen) refresh(); }
export function dimPointerLeave() { lastCur = null; if (get().cursor) set({ cursor: null }); }
/** Sol tık. Komut girdiyi tükettiyse true. */
export function dimPointerClick(cur: Cursor): boolean {
  lastCur = cur;
  if (!gen || !req) return false;
  if (req.kind === 'value' || req.kind === 'text') return true;
  advance({ k: 'pt', h: lastHit = resolveHit(cur, req) });
  return true;
}
export function dimEnter() { if (gen) advance({ k: 'enter' }); else if (lastWas === 'dim' && get().lastCmd) startDim(get().lastCmd!); }
/** Komut satırı metni. true: ölçü sürücüsü tüketti (çizim sürücüsüne gitmez). Boşken komut adı; boş metin son ölçü komutunu yineler. */
export function dimRoute(text: string): boolean {
  const s = text.trim();
  if (!gen || !req) {
    if (!s) { if (lastWas !== 'dim' || !get().lastCmd || useDraft.getState().planePick) return false; dimEnter(); return true; }
    return startDim(s);
  }
  if (req.kind === 'text') { advance({ k: 'text', s }); return true; }
  if (!s) { advance({ k: 'enter' }); return true; }
  const opt = matchOpt(req.opts, s.toUpperCase());
  if (opt) { advance({ k: 'opt', key: opt.key }); return true; }
  const n = /^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(s) ? parseFloat(s) : null;
  if (n !== null && (req.num || req.kind === 'value')) { advance({ k: 'num', v: n }); return true; }
  say(req.kind === 'point' ? 'Point or option keyword required.' : req.kind === 'pick' ? 'Select an object or enter an option keyword.' : 'Invalid input.');
  return true;
}
/** Komut satırı serbest metin mi bekliyor (boşluk karakteri komutu onaylamasın). */
export const dimTextEntry = () => !!gen && req?.kind === 'text';
/** Enter / boşluk ölçü sürücüsüne mi gitmeli. */
export const dimWantsEnter = () => !!gen || (lastWas === 'dim' && !!get().lastCmd);
/** Esc: komut → ölçme sonucu → seçim sırasıyla kapanır. Bir şey kapandıysa true. */
export function dimEscape(): boolean {
  if (cancelDim()) return true;
  const st = get();
  if (st.styleOpen) { set({ styleOpen: false }); return true; }
  if (st.result) { set({ result: null }); return true; }
  if (st.selection.length) { set({ selection: [] }); return true; }
  return false;
}
const pushUndo = () => set(s => ({ undo: [...s.undo.slice(-49), s.dims] }));
export function dimUndo(): boolean {
  const st = get();
  if (!st.undo.length) return false;
  cancelDim();
  set({ dims: st.undo[st.undo.length - 1], undo: st.undo.slice(0, -1), selection: [] });
  return true;
}
export function dimDelete(): boolean {
  const st = get();
  if (gen || !st.selection.length) return false;
  pushUndo();
  set({ dims: st.dims.filter(d => !st.selection.includes(d.id)), selection: [] });
  return true;
}
export function eraseAllDims() { if (!get().dims.length) return; cancelDim(); pushUndo(); set({ dims: [], selection: [], result: null }); }
export function selectDim(id: string | null, additive = false) {
  if (gen) return;
  set(s => ({ selection: id === null ? [] : additive ? (s.selection.includes(id) ? s.selection.filter(x => x !== id) : [...s.selection, id]) : [id] }));
}
export const setDimStyle = (patch: Partial<DimStyle>) => set(s => ({ style: { ...s.style, ...patch } }));
export const setStyleOpen = (b: boolean) => set({ styleOpen: b });
const gk = (k: string, t: string) => ({ k, t });
/** Durum çubuğu yönergesi — ETKİN ölçü komutu: adımlar, düz dille sıradaki iş, o adımda geçerli tuşlar. */
export function useDimCommandStatus(): SceneToolStatus | null {
  const cmd = useDim(s => s.cmd), step = useDim(s => s.guideStep), text = useDim(s => s.guideText), enter = useDim(s => s.guideEnter);
  if (!cmd) return null;
  const def = dimCommandById(cmd.id), opts = cmd.opts.length ? ` [${cmd.opts.map(o => o.label).join(' / ')}]` : '';
  const keys = [...(enter ? [gk('Right-click', enter)] : []), ...(cmd.kind === 'value' ? [gk('Enter', 'confirm')] : [gk('Middle-drag', 'orbit')]), gk('Esc', 'cancel')];
  return { label: cmd.label, type: null, steps: def?.steps, step, text: text ?? cmd.prompt.replace(/^.*? {2}/, '') + opts, keys };
}
/** Durum çubuğu yönergesi — BOŞTAYKEN: sürüklenen / seçili ölçü, ölçme sonucu, imlecin altındaki ölçü. Sahnedeki başka bir kipin yönergesinden sonra gelir. */
export function useDimIdleStatus(): SceneToolStatus | null {
  const n = useDim(s => s.selection.length), drag = useDim(s => !!s.dragId), hover = useDim(s => !!s.hoverId), note = useDim(s => s.result?.note ?? null);
  if (drag) return { label: 'Dimension', type: null, text: 'Release where the dimension line should sit' };
  if (n) return { label: 'Dimension', type: null, text: `${n > 1 ? `${n} dimensions` : 'Dimension'} selected — press Delete or click × to remove · drag to move the dimension line`,
    keys: [gk('Delete', 'remove'), gk('Shift+click', 'add'), gk('Esc', 'deselect')] };
  if (note?.length) return { label: 'Measure', type: null, text: note.join('  ·  '), keys: [gk('Esc', 'clear')] };
  if (hover) return { label: 'Dimension', type: null, text: 'Click to select this dimension — then Delete removes it, dragging moves its line' };
  return null;
}

// ── Ölçüyü sürükleyerek yeniden yerleştirme (yazısından tutulur) ──
/** Verilen ölçünün yerini imleç ışınına göre yeniden hesaplar (oluştururkenki kuralla). */
function replaced(d: Dim, cur: Cursor, R: RCtx): Dim {
  if (d.t === 'lin') {
    const A = anchorPoint(d.a, R), B = anchorPoint(d.b, R), q = frameOf(d.a.sid, R), axes = axesOfQ(quatOf(d.a.sid, R)), qi = q.clone().invert();
    const dir = d.ax ? vt(d.ax).applyQuaternion(q).normalize() : B.clone().sub(A).normalize();
    const { e, n } = offsetFrame(dir, axes, viewDirOf(cur.view)), Q = rayPlane(cur.ray, A, n);
    return Q ? { ...d, e: t3(e.clone().applyQuaternion(qi)), off: Q.sub(A).dot(e) } : d;
  }
  if (d.t === 'ang') { const a = angPlace(d.g, cur, R); return a ? { ...d, ...a } : d; }
  if (d.t === 'ord') { const o = ordPlace(d.p, cur, R, d.axis); return o ? { ...d, end: o.end } : d; }
  if (d.t === 'cmark') return d;
  const a = resolveArc(d.arc, R), Q = rayPlane(cur.ray, a.c, a.n);
  if (!Q) return d;
  const w = Q.sub(a.c);
  return d.t === 'jog' ? { ...d, ang: Math.atan2(w.dot(a.v), w.dot(a.u)) } : { ...d, ang: Math.atan2(w.dot(a.v), w.dot(a.u)), len: w.length() };
}
/** Sahne başka bir tıklama kipindeyken (panel / raf / kapak yerleşimi, köşe düzenleme, sahne araçları, çizim) ölçüler tıklamayı almaz. */
function sceneBusy(): boolean {
  const a = useAppStore.getState(), d = useDraft.getState();
  return !!(a.raycastMode || a.volumePickMode || a.doorPickMode || a.backPickMode || a.plinthPickMode || a.vertexEditMode || a.filletMode || a.sceneExStatus
    || d.cmd || d.planePick || d.activePlane !== 'ground' || d.session);
}
/** Boştayken imlecin altındaki ölçü (çizgi / ok / yazı, 6 px). Değiştiyse depoya yazar. */
export function dimHover(cur: Cursor | null): string | null {
  const st = get();
  const id = !cur || gen || !st.visible || !st.dims.length || sceneBusy() ? null : dimAt(cur, rctx(), () => true, 6);
  if (id !== st.hoverId) set({ hoverId: id });
  return id;
}
export function beginDimDrag(id: string) { if (gen) return; pushUndo(); set({ dragId: id, selection: [id] }); }
export function dragDimTo(cur: Cursor) {
  const id = get().dragId, R = rctx();
  if (id) set(s => ({ dims: s.dims.map(d => (d.id === id ? replaced(d, cur, R) : d)) }));
}
export function endDimDrag() { if (get().dragId) set({ dragId: null }); }

// ═════════════════════════════════════════════════ 6. KOMUTLAR ════════════════════════════════════════════════════════
interface Ctx { add: (d: NewDim) => Dim; remove: (id: string) => void; update: (id: string, d: Dim) => void }
const ctx: Ctx = {
  add: d => { const dim = { ...d, id: `dim-${Date.now().toString(36)}-${++seq}` } as Dim; pushUndo(); set(s => ({ dims: [...s.dims, dim] })); return dim; },
  remove: id => set(s => ({ dims: s.dims.filter(d => d.id !== id) })),
  update: (id, d) => { pushUndo(); set(s => ({ dims: s.dims.map(x => (x.id === id ? d : x)) })); },
};
const o = (label: string, key: string): Opt => ({ label, key });
const isOpt = (e: Ev, key: string) => e.k === 'opt' && e.key === key;
const TMP = 'tmp';
const tmp = (d: NewDim | null): Dim[] => (d ? [{ ...d, id: TMP } as Dim] : []);
const L = (v: number) => fmt(v, get().style.prec);
type Pts = { a: Anchor; b: Anchor };
/** Seçilen kenarın iki ucu: doğru / yay → uçları; tam daire → tıklanan noktadan geçen çap. */
function endsOf(h: CurveHit): Pts {
  const c = h.c;
  if (c.t === 'a' && c.closed) return { a: makeAnchor(h.p, h.src, 'nearest'), b: makeAnchor(c.c.clone().multiplyScalar(2).sub(h.p), h.src, 'nearest') };
  return { a: makeAnchor(c.a, h.src, 'endpoint'), b: makeAnchor(c.b, h.src, 'endpoint') };
}
function* askText(name: string): G<string | undefined> {
  const ev = yield { prompt: `${name}  Enter dimension text (<> = measured value, blank = measured)`, kind: 'text' };
  return ev.k === 'text' && ev.s.trim() ? ev.s.trim() : undefined;
}
/** İlk uzatma çizgisi başlangıcı (Enter → kenar seç) ve ikincisi. */
function* twoPoints(name: string): G<Pts | null> {
  const e1 = yield {
    prompt: `${name}  Specify first extension line origin or <select edge>`, kind: 'point', s: 0, enter: 'pick a whole edge',
    tip: h => (h?.snap && h.snapNear ? `Click to start from this ${SNAP_LABEL[h.snap].toLowerCase()} point` : 'Click the first point — corners and edge middles are caught automatically'),
  };
  if (e1.k === 'enter') {
    const e = yield { prompt: `${name}  Select an edge to dimension`, kind: 'pick', pick: 'curve', s: 0, tip: h => (h?.curve ? 'Click to dimension this edge' : 'Point at an edge of a panel or the body and click') };
    return e.k === 'pt' && e.h.curve ? endsOf(e.h.curve) : null;
  }
  if (e1.k !== 'pt') return null;
  const A = e1.h.p;
  const e2 = yield {
    prompt: `${name}  Specify second extension line origin`, kind: 'point', from: A, s: 1, tip: h => `Click the second point${h ? ` — ${L(A.distanceTo(h.p))} from the first` : ''}`,
    preview: h => ({ lines: [[A, h.p]], note: [L(A.distanceTo(h.p))], at: h.p }),
  };
  return e2.k === 'pt' ? { a: e1.h.anchor, b: e2.h.anchor } : null;
}
function buildLin(p: Pts, cur: Cursor, lock: LinLock, prev: number | null, txt?: string): { dim: NewDim; axis: number | null } {
  const R = rctx(), A = anchorPoint(p.a, R), B = anchorPoint(p.b, R), qi = frameOf(p.a.sid, R).clone().invert();
  const pl = placeLinear(A, B, axesOfQ(quatOf(p.a.sid, R)), cur, lock, prev);
  return { dim: { t: 'lin', a: p.a, b: p.b, ax: lock === 'ali' ? null : t3(pl.d.clone().applyQuaternion(qi)), e: t3(pl.e.clone().applyQuaternion(qi)), off: pl.off, txt }, axis: pl.axis };
}
function* placeLin(c: Ctx, name: string, p: Pts, mode: 'lin' | 'ali', s = 2): G<Dim | null> {
  let lock: LinLock = mode === 'ali' ? 'ali' : null, txt: string | undefined, prev: number | null = null;
  for (;;) {
    const ev = yield {
      prompt: `${name}  Specify dimension line location or`, kind: 'point', noSnap: true, s,
      tip: `Move the pointer away from the edge and click to place the dimension${lock === null ? ' — above / below or beside decides the direction; X, Y, Z lock it' : ''}`,
      opts: mode === 'lin' ? [o('Text', 'T'), o('X', 'X'), o('Y', 'Y'), o('Z', 'Z'), o('Aligned', 'A')] : [o('Text', 'T')],
      preview: h => { const b = buildLin(p, h.cur, lock, prev, txt); prev = b.axis; return { dims: tmp(b.dim) }; },
    };
    if (ev.k === 'pt') { const d = c.add(buildLin(p, ev.h.cur, lock, prev, txt).dim); lastSeries = d.id; return d; }
    if (isOpt(ev, 'T')) txt = yield* askText(name);
    else if (ev.k === 'opt' && 'XYZ'.includes(ev.key)) lock = 'XYZ'.indexOf(ev.key) as 0 | 1 | 2;
    else if (isOpt(ev, 'A')) lock = 'ali';
    else if (ev.k === 'enter') return null;
  }
}
const linearCmd = (name: string, mode: 'lin' | 'ali') => function* (c: Ctx): G {
  const p = yield* twoPoints(name);
  if (p) yield* placeLin(c, name, p, mode);
};
/** Açı ölçüsünün yeri: ışın açı düzlemini keser; iki doğruda imlecin düştüğü dilim, tepe / yayda içeride dar, dışarıda geniş açı. */
function angPlace(g: AngSrc, cur: Cursor, R: RCtx): { r: number; sa: 1 | -1; sb: 1 | -1; reflex: boolean } | null {
  const a = angResolve(g, R);
  if (!a) return null;
  const n = a.n ?? V3().crossVectors(a.d1, a.d2).normalize(), Q = rayPlane(cur.ray, a.v, n);
  if (!Q) return null;
  const w = Q.sub(a.v), r = w.length();
  if (r < 1e-6) return null;
  if (a.n) { const t = Math.atan2(w.dot(V3().crossVectors(a.n, a.d1)), w.dot(a.d1)); return { r, sa: 1, sb: 1, reflex: (t < 0 ? t + TAU : t) > a.sweep }; }
  const g12 = a.d1.dot(a.d2), den = 1 - g12 * g12, w1 = w.dot(a.d1), w2 = w.dot(a.d2), al = (w1 - g12 * w2) / den, be = (w2 - g12 * w1) / den;
  return g.k === 'll' ? { r, sa: sgn(al), sb: sgn(be), reflex: false } : { r, sa: 1, sb: 1, reflex: !(al > 0 && be > 0) };
}
function* placeAng(c: Ctx, name: string, g: AngSrc): G<Dim | null> {
  let txt: string | undefined;
  const build = (cur: Cursor): NewDim | null => { const a = angPlace(g, cur, rctx()); return a ? { t: 'ang', g, ...a, txt } : null; };
  for (;;) {
    const ev = yield {
      prompt: `${name}  Specify dimension arc line location or`, kind: 'point', noSnap: true, opts: [o('Text', 'T')], s: 2,
      tip: 'Move to the side of the angle you want to show and click to place it', preview: h => ({ dims: tmp(build(h.cur)) }),
    };
    if (ev.k === 'pt') { const d = build(ev.h.cur); if (!d) { say('The two lines are parallel.'); return null; } return c.add(d); }
    if (isOpt(ev, 'T')) txt = yield* askText(name);
    else if (ev.k === 'enter') return null;
  }
}
function* threePointAngle(name: string): G<AngSrc | null> {
  const v = yield { prompt: `${name}  Specify angle vertex`, kind: 'point', s: 0, tip: 'Click the corner (vertex) of the angle' };
  if (v.k !== 'pt') return null;
  const V0 = v.h.p;
  const p1 = yield { prompt: `${name}  Specify first angle endpoint`, kind: 'point', from: V0, s: 1, tip: 'Click a point on the first side of the angle', preview: h => ({ lines: [[V0, h.p]] }) };
  if (p1.k !== 'pt') return null;
  const P1 = p1.h.p;
  const p2 = yield { prompt: `${name}  Specify second angle endpoint`, kind: 'point', from: V0, s: 1, tip: 'Click a point on the second side of the angle', preview: h => ({ lines: [[P1, V0, h.p]] }) };
  return p2.k === 'pt' ? { k: '3p', v: v.h.anchor, p1: p1.h.anchor, p2: p2.h.anchor } : null;
}
function* angleSource(name: string): G<AngSrc | null> {
  const e1 = yield {
    prompt: `${name}  Select arc, circle, edge or <specify vertex>`, kind: 'pick', pick: 'curve', s: 0, enter: 'use three points',
    tip: h => (h?.curve ? (h.curve.c.t === 'a' ? 'Click to measure the angle of this arc' : 'Click this edge — it is the first side of the angle') : 'Click the first edge of the angle (or an arc)'),
  };
  if (e1.k === 'enter') return yield* threePointAngle(name);
  if (e1.k !== 'pt' || !e1.h.curve) return null;
  const h1 = e1.h.curve;
  if (h1.c.t === 'a' && !h1.c.closed) return { k: 'arc', arc: makeArcRef(h1) };
  if (h1.c.t === 'a') {
    const C = h1.c.c, P1 = h1.p;
    const e2 = yield { prompt: `${name}  Specify second angle endpoint`, kind: 'point', from: C, preview: h => ({ lines: [[P1, C, h.p]] }) };
    return e2.k === 'pt' ? { k: '3p', v: makeAnchor(C, h1.src, 'center'), p1: makeAnchor(P1, h1.src, 'nearest'), p2: e2.h.anchor } : null;
  }
  const first = curvePts(h1.c);
  const e2 = yield { prompt: `${name}  Select second edge`, kind: 'pick', pick: 'line', s: 1, tip: 'Click the second edge — the angle between the two is measured', preview: () => ({ hi: [first] }) };
  if (e2.k !== 'pt' || !e2.h.curve || e2.h.curve.c === h1.c) return null;
  const A = endsOf(h1), B = endsOf(e2.h.curve);
  return { k: 'll', a1: A.a, b1: A.b, a2: B.a, b2: B.b };
}
function* angularCmd(c: Ctx): G {
  const g = yield* angleSource('DIMANGULAR');
  if (g) yield* placeAng(c, 'DIMANGULAR', g);
}
type ArcKind = 'rad' | 'dia' | 'arc';
/** Yarıçap / çap / yay boyu ölçüsünün yeri. `sw`: DIM'den gelindiyse tür değiştirme seçenekleri. */
function* placeArc(c: Ctx, name: string, hit: CurveHit, t0: ArcKind, sw = false, s = 1): G<Dim | null> {
  const ref = makeArcRef(hit), closed = (hit.c as ArcC).closed;
  let t = t0, txt: string | undefined;
  const build = (cur: Cursor): NewDim | null => {
    const a = resolveArc(ref, rctx()), Q = rayPlane(cur.ray, a.c, a.n);
    if (!Q) return null;
    const w = Q.sub(a.c);
    return { t, arc: ref, ang: Math.atan2(w.dot(a.v), w.dot(a.u)), len: w.length(), txt };
  };
  for (;;) {
    const ev = yield {
      prompt: `${name}  Specify dimension line location or`, kind: 'point', noSnap: true, s,
      tip: `Move inside or outside the ${closed ? 'circle' : 'arc'} and click to place the ${t === 'rad' ? 'radius' : t === 'dia' ? 'diameter' : 'arc length'}${sw ? ' — R radius, D diameter' : ''}`,
      opts: [o('Text', 'T'), ...(sw ? [o('Radius', 'R'), o('Diameter', 'D'), ...(closed ? [] : [o('arc Length', 'L')])] : [])],
      preview: h => ({ dims: tmp(build(h.cur)) }),
    };
    if (ev.k === 'pt') { const d = build(ev.h.cur); return d ? c.add(d) : null; }
    if (isOpt(ev, 'T')) txt = yield* askText(name);
    else if (isOpt(ev, 'R')) t = 'rad';
    else if (isOpt(ev, 'D')) t = 'dia';
    else if (isOpt(ev, 'L')) t = 'arc';
    else if (ev.k === 'enter') return null;
  }
}
const arcCmd = (name: string, t: ArcKind) => function* (c: Ctx): G {
  const ev = yield { prompt: `${name}  Select arc${t === 'arc' ? '' : ' or circle'}`, kind: 'pick', pick: 'arc', s: 0, tip: h => (h?.curve ? 'Click to dimension this one' : 'Point at a round edge — a hole, a fillet, an arc — and click') };
  if (ev.k !== 'pt' || !ev.h.curve) return;
  if (t === 'arc' && (ev.h.curve.c as ArcC).closed) { say('Arc length needs an open arc — use Diameter for a full circle.'); return; }
  yield* placeArc(c, name, ev.h.curve, t);
};
function* joggedCmd(c: Ctx): G {
  const name = 'DIMJOGGED';
  const ev = yield { prompt: `${name}  Select arc or circle`, kind: 'pick', pick: 'arc' };
  if (ev.k !== 'pt' || !ev.h.curve) return;
  const ref = makeArcRef(ev.h.curve), R0 = rctx(), a0 = resolveArc(ref, R0);
  const inPlane = (cur: Cursor) => { const a = resolveArc(ref, rctx()), Q = rayPlane(cur.ray, a.c, a.n); return Q ? { a, w: Q.sub(a.c) } : null; };
  const e1 = yield { prompt: `${name}  Specify center location override`, kind: 'point', noSnap: true, preview: h => { const q = inPlane(h.cur); return q ? { lines: [[q.a.c.clone().add(q.w), a0.c]] } : {}; } };
  if (e1.k !== 'pt') return;
  const q1 = inPlane(e1.h.cur);
  if (!q1) return;
  const ov: [number, number] = [q1.w.dot(q1.a.u), q1.w.dot(q1.a.v)];
  let txt: string | undefined, ang = 0;
  const build = (cur: Cursor, jog: number | null): NewDim | null => {
    const q = inPlane(cur);
    if (!q) return null;
    if (jog === null) ang = Math.atan2(q.w.dot(q.a.v), q.w.dot(q.a.u));
    const w = q.a.u.clone().multiplyScalar(Math.cos(ang)).addScaledVector(q.a.v, Math.sin(ang));
    return { t: 'jog', arc: ref, ang, len: q.a.r, ov, jog: jog === null ? -q.a.r * 0.45 : q.w.dot(w) - q.a.r, txt };
  };
  for (;;) {
    const e2 = yield { prompt: `${name}  Specify dimension line location or`, kind: 'point', noSnap: true, opts: [o('Text', 'T')], preview: h => ({ dims: tmp(build(h.cur, null)) }) };
    if (isOpt(e2, 'T')) { txt = yield* askText(name); continue; }
    if (e2.k !== 'pt') return;
    build(e2.h.cur, null);
    break;
  }
  const e3 = yield { prompt: `${name}  Specify jog location`, kind: 'point', noSnap: true, preview: h => ({ dims: tmp(build(h.cur, 0)) }) };
  if (e3.k !== 'pt') return;
  const d = build(e3.h.cur, 0);
  if (d) c.add(d);
}
/** Ordinat kılavuzunun ucu: noktadan geçen, kameraya dönük eksen düzleminde. Kilit yoksa kılavuz hangi eksene yatkınsa ÖTEKİ eksenin değeri gösterilir. */
function ordPlace(p: Anchor, cur: Cursor, R: RCtx, lock: 0 | 1 | 2 | null): { axis: 0 | 1 | 2; end: T3 } | null {
  const P = anchorPoint(p, R), q = quatOf(p.sid, R), axes = axesOfQ(q), view = viewDirOf(cur.view);
  let k = [0, 1, 2].reduce((m, i) => (Math.abs(axes[i].dot(view)) > Math.abs(axes[m].dot(view)) ? i : m), 0);
  if (lock === k) k = [0, 1, 2].filter(i => i !== lock).reduce((m, i) => (Math.abs(axes[i].dot(view)) > Math.abs(axes[m].dot(view)) ? i : m));
  const Q = rayPlane(cur.ray, P, axes[k]);
  if (!Q) return null;
  const w = Q.sub(P), ui = (k + 1) % 3, vi = (k + 2) % 3;
  if (w.length() < 1e-6) return null;
  const axis = (lock ?? (Math.abs(w.dot(axes[ui])) > Math.abs(w.dot(axes[vi])) ? vi : ui)) as 0 | 1 | 2;
  return { axis, end: t3(w.applyQuaternion(q.clone().invert())) };
}
function* ordinateCmd(c: Ctx): G {
  const name = 'DIMORDINATE';
  const e1 = yield { prompt: `${name}  Specify feature location`, kind: 'point' };
  if (e1.k !== 'pt') return;
  const p = e1.h.anchor;
  let lock: 0 | 1 | 2 | null = null, txt: string | undefined;
  const build = (cur: Cursor): NewDim | null => { const r = ordPlace(p, cur, rctx(), lock); return r ? { t: 'ord', p, ...r, txt } : null; };
  for (;;) {
    const ev = yield { prompt: `${name}  Specify leader endpoint or`, kind: 'point', noSnap: true, opts: [o('Xdatum', 'X'), o('Ydatum', 'Y'), o('Zdatum', 'Z'), o('Text', 'T')], preview: h => ({ dims: tmp(build(h.cur)) }) };
    if (ev.k === 'pt') { const d = build(ev.h.cur); if (d) c.add(d); return; }
    if (isOpt(ev, 'T')) txt = yield* askText(name);
    else if (ev.k === 'opt' && 'XYZ'.includes(ev.key)) lock = 'XYZ'.indexOf(ev.key) as 0 | 1 | 2;
    else if (ev.k === 'enter') return;
  }
}
type LinDim = Extract<Dim, { t: 'lin' }>;
const linById = (id: string | null): LinDim | null => { const d = get().dims.find(x => x.id === id); return d?.t === 'lin' ? d : null; };
/** Doğrusal ölçünün dünya çerçevesi: yön, kaçıklık yönü, iki nokta. */
function linFrame(d: LinDim, R: RCtx) {
  const A = anchorPoint(d.a, R), B = anchorPoint(d.b, R), q = frameOf(d.a.sid, R);
  const dir = (d.ax ? vt(d.ax).applyQuaternion(q) : B.clone().sub(A)).normalize(), e = vt(d.e).applyQuaternion(q);
  e.addScaledVector(dir, -e.dot(dir)).normalize();
  return { A, B, dir, e };
}
/** Bir ölçüyle aynı yönde, verilen iki nokta arasında yeni ölçü; `lineAt` = ölçü çizgisinin geçeceği dünya noktası. */
function linLike(a: Anchor, b: Anchor, dir: V, e: V, lineAt: V, R: RCtx): NewDim {
  const qi = frameOf(a.sid, R).clone().invert();
  return { t: 'lin', a, b, ax: t3(dir.clone().applyQuaternion(qi)), e: t3(e.clone().applyQuaternion(qi)), off: lineAt.clone().sub(anchorPoint(a, R)).dot(e) };
}
function* pickLin(name: string, what: string): G<LinDim | null> {
  const ev = yield { prompt: `${name}  Select ${what}`, kind: 'pick', pick: 'lindim' };
  return ev.k === 'pt' ? linById(ev.h.dimId) : null;
}
/** Taban ölçüden seri: baseline = hep ilk noktadan, her biri bir aralık dışarıda · continue = bir öncekinin bittiği yerden, aynı hizada. */
const seriesCmd = (kind: 'base' | 'cont') => function* (c: Ctx): G {
  const name = kind === 'base' ? 'DIMBASELINE' : 'DIMCONTINUE';
  let base = linById(lastSeries) ?? (yield* pickLin(name, kind === 'base' ? 'base dimension' : 'dimension to continue'));
  if (!base) { say('Select a linear or aligned dimension.'); return; }
  const made: string[] = [];
  for (;;) {
    const b0: LinDim = base, R = rctx(), f = linFrame(b0, R), n: number = made.length + 1;
    const prev = kind === 'cont' && made.length ? linById(made[made.length - 1]) ?? b0 : b0;
    const next = (h: Hit): NewDim => {
      const sp = get().style.spacing * h.wpp * sgn(b0.off || 1), line = f.A.clone().addScaledVector(f.e, b0.off);
      return kind === 'base' ? linLike(b0.a, h.anchor, f.dir, f.e, line.addScaledVector(f.e, sp * n), R) : linLike(prev.b, h.anchor, f.dir, f.e, line, R);
    };
    const ev = yield {
      prompt: `${name}  Specify second extension line origin or`, kind: 'point', from: anchorPoint(prev.b, R), opts: [o('Select', 'S'), o('Undo', 'U')],
      preview: h => ({ dims: tmp(next(h)) }),
    };
    if (ev.k === 'pt') made.push(c.add(next(ev.h)).id);
    else if (isOpt(ev, 'S')) { const b = yield* pickLin(name, 'base dimension'); if (b) { base = b; made.length = 0; } }
    else if (isOpt(ev, 'U')) { const id = made.pop(); if (id) c.remove(id); else say('Nothing to undo in this series.'); }
    else if (ev.k === 'enter') { if (made.length) lastSeries = made[made.length - 1]; return; }
  }
};
/** Hızlı ölçü: seçilen kenarların uçları (ve yay merkezleri) tek seferde zincir / kademeli / tabandan; ya da tüm yaylara yarıçap / çap. */
function* qdimCmd(c: Ctx): G {
  const name = 'QDIM', picked: CurveHit[] = [];
  const hi = () => picked.map(p => curvePts(p.c));
  for (;;) {
    const ev = yield { prompt: `${name}  Select edges to dimension (${picked.length} selected) — Enter when done`, kind: 'pick', pick: 'curve', preview: () => ({ hi: hi() }) };
    if (ev.k === 'enter') break;
    if (ev.k !== 'pt' || !ev.h.curve) continue;
    const i = picked.findIndex(p => p.c === ev.h.curve!.c);
    if (i >= 0) picked.splice(i, 1); else picked.push(ev.h.curve);
  }
  if (!picked.length) return;
  let mode = 'C';
  let prev: number | null = null;
  const build = (h: Hit): NewDim[] => {
    const R = rctx(), arcs = picked.filter(p => p.c.t === 'a');
    if (mode === 'R' || mode === 'D') return arcs.map(p => {
      const ref = makeArcRef(p), a = resolveArc(ref, R), w = (rayPlane(h.cur.ray, a.c, a.n) ?? a.c.clone().add(a.u)).sub(a.c);
      return { t: mode === 'R' ? 'rad' : 'dia', arc: ref, ang: Math.atan2(w.dot(a.v), w.dot(a.u)), len: a.r + get().style.spacing * 1.6 * h.wpp } as NewDim;
    });
    const anchors: Anchor[] = picked.flatMap(p => (p.c.t === 'a' ? [makeAnchor(p.c.c, p.src, 'center')] : [makeAnchor(p.c.a, p.src, 'endpoint'), makeAnchor(p.c.b, p.src, 'endpoint')]));
    const P = anchors.map(a => anchorPoint(a, R)), axes = axesOfQ(quatOf(anchors[0].sid, R)), box = new THREE.Box3().setFromPoints(P);
    const pl = placeLinear(box.min, box.max, axes, h.cur, null, prev);
    prev = pl.axis;
    const line = box.min.clone().addScaledVector(pl.e, pl.off), order = P.map((p, i) => ({ i, t: p.dot(pl.d) })).sort((a, b) => a.t - b.t);
    const uniq = order.filter((x, i) => i === 0 || x.t - order[i - 1].t > 0.05);   // ölçü yönünde üst üste gelen noktalar bir kez
    const sp = get().style.spacing * h.wpp * sgn(pl.off || 1), out: NewDim[] = [];
    for (let i = 1; i < uniq.length; i++) {
      const at = line.clone().addScaledVector(pl.e, mode === 'C' ? 0 : sp * (i - 1));
      out.push(linLike(anchors[uniq[mode === 'B' ? 0 : i - 1].i], anchors[uniq[i].i], pl.d, pl.e, at, R));
    }
    return out;
  };
  for (;;) {
    const ev = yield {
      prompt: `${name}  Specify dimension line position or`, kind: 'point', noSnap: true, def: mode,
      opts: [o('Continuous', 'C'), o('Staggered', 'S'), o('Baseline', 'B'), o('Radius', 'R'), o('Diameter', 'D')],
      preview: h => ({ dims: build(h).map((d, i) => ({ ...d, id: `${TMP}${i}` } as Dim)), hi: hi() }),
    };
    if (ev.k === 'opt') mode = ev.key;
    else if (ev.k === 'pt') { const list = build(ev.h); if (!list.length) say(mode === 'R' || mode === 'D' ? 'No arcs or circles in the selection.' : 'Not enough points to dimension.'); for (const d of list) c.add(d); return; }
    else if (ev.k === 'enter') return;
  }
}
function* centerMarkCmd(c: Ctx): G {
  for (;;) {
    const ev = yield { prompt: 'CENTERMARK  Select circle or arc to add center mark', kind: 'pick', pick: 'arc' };
    if (ev.k === 'enter') return;
    if (ev.k === 'pt' && ev.h.curve) c.add({ t: 'cmark', arc: makeArcRef(ev.h.curve) });
  }
}
/** DIM: tek komutta hepsi — kenara tık → türüne uyan ölçü (doğru: doğrusal / hizalı · daire: çap · yay: yarıçap); noktaya tık → iki nokta arası. */
function* dimCmd(c: Ctx): G {
  const name = 'DIM';
  for (;;) {
    const ev = yield {
      prompt: `${name}  Select an edge or specify first extension line origin or`, kind: 'point', pick: 'curve', s: 0, enter: 'finish',
      tip: h => (!h ? 'Point at an edge and click to dimension it — or click a corner to measure between two points'
        : h.curve && objectFirst(h) ? (h.curve.c.t === 'l' ? `Click to dimension this edge (${L(h.curve.c.a.distanceTo(h.curve.c.b))})`
          : `Click to dimension this ${h.curve.c.closed ? `circle (Ø ${L(h.curve.c.r * 2)})` : `arc (R ${L(h.curve.c.r)})`}`)
        : h.snap && h.snapNear ? 'Click this corner, then a second point — the distance between them is dimensioned'
        : 'Point at an edge and click to dimension it — or click a corner to measure between two points'),
      opts: [o('Angular', 'A'), o('Baseline', 'B'), o('Continue', 'C'), o('Ordinate', 'O'), o('Undo', 'U')],
    };
    if (ev.k === 'enter') return;
    if (isOpt(ev, 'A')) { const g = yield* angleSource(name); if (g) yield* placeAng(c, name, g); continue; }
    if (isOpt(ev, 'B')) { yield* seriesCmd('base')(c); continue; }
    if (isOpt(ev, 'C')) { yield* seriesCmd('cont')(c); continue; }
    if (isOpt(ev, 'O')) { yield* ordinateCmd(c); continue; }
    if (isOpt(ev, 'U')) { if (!dimUndoKeep()) say('Nothing to undo.'); continue; }
    if (ev.k !== 'pt') continue;
    const h = ev.h, R = rctx();
    // Eksenlerden yalnız birinde ayrılan iki nokta → doğrusal; değilse hizalı.
    const modeOf = (p: Pts): 'lin' | 'ali' => {
      const q = quatOf(p.a.sid, R).clone().invert(), v = anchorPoint(p.b, R).sub(anchorPoint(p.a, R)).applyQuaternion(q);
      return [v.x, v.y, v.z].filter(x => Math.abs(x) > 0.01).length > 1 ? 'ali' : 'lin';
    };
    if (h.curve && objectFirst(h)) {
      if (h.curve.c.t === 'a') yield* placeArc(c, name, h.curve, h.curve.c.closed ? 'dia' : 'rad', true, 1);
      else { const p = endsOf(h.curve); yield* placeLin(c, name, p, modeOf(p), 1); }
      continue;
    }
    const A = h.p;
    const e2 = yield {
      prompt: `${name}  Specify second extension line origin`, kind: 'point', from: A, s: 0, tip: x => `Click the second point${x ? ` — ${L(A.distanceTo(x.p))} from the first` : ''}`,
      preview: x => ({ lines: [[A, x.p]], note: [L(A.distanceTo(x.p))], at: x.p }),
    };
    if (e2.k !== 'pt') continue;
    const p = { a: h.anchor, b: e2.h.anchor };
    yield* placeLin(c, name, p, modeOf(p), 1);
  }
}
/** Komut içi geri al: komutu düşürmeden son ölçüyü kaldırır. */
function dimUndoKeep(): boolean {
  const st = get();
  if (!st.undo.length) return false;
  set({ dims: st.undo[st.undo.length - 1], undo: st.undo.slice(0, -1) });
  return true;
}

// ── ÖLÇME (kalıcı ölçü bırakmaz; sonuç sahnede ve komut satırında) ──
const hostCoords = (h: Hit) => (h.src ? h.p.clone().applyMatrix4(h.src.inv) : h.p.clone());
function* distCmd(): G {
  const e1 = yield { prompt: 'DIST  Specify first point', kind: 'point', s: 0, tip: h => (h?.snap && h.snapNear ? `Click to measure from this ${SNAP_LABEL[h.snap].toLowerCase()} point` : 'Click the first point — nothing is left on the model, the result is only shown') };
  if (e1.k !== 'pt') return;
  const A = e1.h.p, qi = (e1.h.src?.q ?? IDENT_Q).clone().invert();
  const info = (B: V): string[] => {
    const v = B.clone().sub(A).applyQuaternion(qi), d = v.length();
    return [`Distance ${L(d)}`, `ΔX ${L(v.x)}   ΔY ${L(v.y)}   ΔZ ${L(v.z)}`];
  };
  const e2 = yield { prompt: 'DIST  Specify second point', kind: 'point', from: A, s: 1, tip: h => `Click the second point${h ? ` — ${L(A.distanceTo(h.p))} so far` : ''}`, preview: h => ({ lines: [[A, h.p]], note: info(h.p), at: h.p }) };
  if (e2.k !== 'pt') return;
  const B = e2.h.p, lines = info(B);
  say(lines.join('   '));
  set({ result: { dims: [{ id: TMP, t: 'lin', a: e1.h.anchor, b: e2.h.anchor, ax: null, e: t3(anyPerp(B.clone().sub(A).normalize())), off: 0 }], note: lines, at: B } });
}
/** HOLE: deliğin çapı + derinliği. İmleç deliğin dairesindeyken okuma görünür; tık → etiket yeri (tık = kalıcı, ilişkisel etiket ·
 *  sağ tık = yalnız ölç, sonuç ekranda kalır). Etiketten sonra sıradaki deliğe geçer; Enter / sağ tık bitirir. */
function* holeCmd(c: Ctx): G {
  const name = 'HOLE';
  for (;;) {
    const ev = yield {
      prompt: `${name}  Select a hole (click its round edge)`, kind: 'pick', pick: 'arc', s: 0, enter: 'finish',
      tip: h => { const i = h?.curve ? holeOfHit(h.curve) : null; return i ? `Click to measure this hole — ${holeWords(i)}` : 'Point at the round edge of a hole and click'; },
      preview: h => { const i = h.curve ? holeOfHit(h.curve) : null; return i && h.curve ? { note: [holeLabel(i), holeWords(i)], at: h.curve.p } : {}; },
    };
    if (ev.k === 'enter') return;
    if (ev.k !== 'pt') continue;
    if (!ev.h.curve) { say('Click the round edge of a hole.'); continue; }
    const hit = ev.h.curve, info = holeOfHit(hit);
    if (!info) { say(hit.c.t === 'a' ? 'That round edge is not a hole.' : 'Click the round edge of a hole.'); continue; }
    say(`Hole ${holeWords(info)}`);
    const ref = makeArcRef(hit), circle = (hit.c as ArcC).pts;
    const build = (cur: Cursor): NewDim | null => {
      const a = resolveArc(ref, rctx()), Q = rayPlane(cur.ray, a.c, a.n);
      if (!Q) return null;
      const w = Q.sub(a.c);
      return { t: 'hole', arc: ref, ang: Math.atan2(w.dot(a.v), w.dot(a.u)), len: w.length() };
    };
    const e2 = yield {
      prompt: `${name}  Specify label location`, kind: 'point', noSnap: true, s: 1, enter: 'measure only (no label)',
      tip: `${holeWords(info)} — click to place a label on the hole, or right-click to just measure`,
      preview: h => ({ dims: tmp(build(h.cur)), hi: [circle] }),
    };
    if (e2.k === 'pt') { const d = build(e2.h.cur); if (d) c.add(d); continue; }
    if (e2.k === 'enter') { set({ result: { hi: [circle], note: [holeLabel(info), holeWords(info)], at: hit.p } }); return; }
  }
}
function* measureRadiusCmd(): G {
  const ev = yield { prompt: 'MEASURERADIUS  Select arc or circle', kind: 'pick', pick: 'arc' };
  if (ev.k !== 'pt' || !ev.h.curve) return;
  const a = ev.h.curve.c as ArcC, lines = [`Radius ${L(a.r)}`, `Diameter ${L(a.r * 2)}`];
  say(lines.join('   '));
  set({ result: { lines: [[a.c, ev.h.curve.p]], hi: [a.pts], note: lines, at: ev.h.curve.p } });
}
function* measureAngleCmd(): G {
  const name = 'MEASUREANGLE';
  const first = yield { prompt: `${name}  Specify vertex point or`, kind: 'point', opts: [o('Lines', 'LINES')] };
  let g: AngSrc | null = null, at: V | null = null;
  if (isOpt(first, 'LINES')) {
    const l1 = yield { prompt: `${name}  Select first edge`, kind: 'pick', pick: 'line' };
    if (l1.k !== 'pt' || !l1.h.curve) return;
    const c1 = l1.h.curve;
    const l2 = yield { prompt: `${name}  Select second edge`, kind: 'pick', pick: 'line', preview: () => ({ hi: [curvePts(c1.c)] }) };
    if (l2.k !== 'pt' || !l2.h.curve || l2.h.curve.c === c1.c) return;
    const A = endsOf(c1), B = endsOf(l2.h.curve);
    g = { k: 'll', a1: A.a, b1: A.b, a2: B.a, b2: B.b }; at = l2.h.curve.p;
  } else if (first.k === 'pt') {
    const V0 = first.h.p;
    const p1 = yield { prompt: `${name}  Specify first ray point`, kind: 'point', from: V0, preview: h => ({ lines: [[V0, h.p]] }) };
    if (p1.k !== 'pt') return;
    const P1 = p1.h.p;
    const ang = (P2: V) => P1.clone().sub(V0).angleTo(P2.clone().sub(V0)) * DEG;
    const p2 = yield { prompt: `${name}  Specify second ray point`, kind: 'point', from: V0, preview: h => ({ lines: [[P1, V0, h.p]], note: [`${fmt(ang(h.p), get().style.aprec)}°`], at: h.p }) };
    if (p2.k !== 'pt') return;
    g = { k: '3p', v: first.h.anchor, p1: p1.h.anchor, p2: p2.h.anchor }; at = p2.h.p;
  }
  if (!g || !at) return;
  const a = angResolve(g, rctx());
  if (!a) { say('The two lines are parallel.'); return; }
  // İki doğruda küçük açı gösterilir.
  const th = a.d1.angleTo(a.d2), small = g.k === 'll' && th > Math.PI / 2, deg = (small ? Math.PI - th : th) * DEG, lines = [`Angle ${fmt(deg, get().style.aprec)}°`];
  say(lines[0]);
  set({ result: { dims: [{ id: TMP, t: 'ang', g, r: Math.min(a.l1, a.l2) * 0.5, sa: 1, sb: small ? -1 : 1, reflex: false }], note: lines, at } });
}
/** Düzlemsel yüzün alanı ve çevresi (üçgenlerinden). */
function faceArea(f: NonNullable<Hit['face']>): { area: number; perim: number; outline: V[][] } | null {
  const { faces, groups } = getFacesAndGroups(f.src.geo), gi = groupIndexOfFace(groups, f.faceIndex);
  if (gi < 0) return null;
  const edges = new Map<string, { a: V; b: V; n: number }>(), key = (p: V) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)},${Math.round(p.z * 100)}`;
  for (const fi of groups[gi].faceIndices) {
    const vs = faces[fi]?.vertices;
    if (!vs) continue;
    for (let i = 0; i < 3; i++) {
      const a = vs[i], b = vs[(i + 1) % 3], ka = key(a), kb = key(b), k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`, e = edges.get(k);
      if (e) e.n++; else edges.set(k, { a, b, n: 1 });
    }
  }
  const outline = [...edges.values()].filter(e => e.n === 1).map(e => [e.a.clone().applyMatrix4(f.src.m), e.b.clone().applyMatrix4(f.src.m)]);
  return { area: groups[gi].totalArea, perim: outline.reduce((s, l) => s + l[0].distanceTo(l[1]), 0), outline };
}
const m2 = (a: number) => `${fmt(a, get().style.prec)} mm²  (${fmt(a / 1e6, 4)} m²)`;
function* areaCmd(): G {
  const name = 'AREA', pts: V[] = [];
  const poly = (P: V[]) => {
    // Düzlemsel olmayan çokgende de gerçek alan: vektör alanların toplamı.
    const s = V3();
    for (let i = 1; i + 1 < P.length; i++) s.add(V3().crossVectors(P[i].clone().sub(P[0]), P[i + 1].clone().sub(P[0])));
    return { area: s.length() / 2, perim: P.reduce((l, p, i) => l + p.distanceTo(P[(i + 1) % P.length]), 0) };
  };
  for (;;) {
    const ev = yield {
      prompt: pts.length ? `${name}  Specify next point (${pts.length}) — Enter to finish` : `${name}  Specify first corner point or`, kind: 'point',
      opts: pts.length ? [o('Undo', 'U')] : [o('Face', 'F')], from: pts[pts.length - 1] ?? null,
      preview: h => { const P = [...pts, h.p]; return { lines: [[...P, P[0]]], fill: P.length >= 3 ? P : undefined, note: P.length >= 3 ? [`Area ${m2(poly(P).area)}`] : undefined, at: h.p }; },
    };
    if (ev.k === 'pt') { pts.push(ev.h.p); continue; }
    if (isOpt(ev, 'U')) { pts.pop(); continue; }
    if (isOpt(ev, 'F')) {
      const f = yield { prompt: `${name}  Click a face of a panel or body`, kind: 'pick', pick: 'face' };
      if (f.k !== 'pt' || !f.h.face) return;
      const r = faceArea(f.h.face);
      if (!r) { say('That face has no measurable area.'); return; }
      const lines = [`Area ${m2(r.area)}`, `Perimeter ${L(r.perim)}`];
      say(lines.join('   '));
      set({ result: { hi: r.outline, note: lines, at: f.h.face.p } });
      return;
    }
    if (ev.k === 'enter') break;
  }
  if (pts.length < 3) { say('At least three points are needed.'); return; }
  const r = poly(pts), lines = [`Area ${m2(r.area)}`, `Perimeter ${L(r.perim)}`];
  say(lines.join('   '));
  set({ result: { lines: [[...pts, pts[0]]], fill: pts, note: lines, at: pts[pts.length - 1] } });
}
function* idCmd(): G {
  const ev = yield { prompt: 'ID  Specify point', kind: 'point', preview: h => { const v = hostCoords(h); return { note: [`X ${L(v.x)}   Y ${L(v.y)}   Z ${L(v.z)}`], at: h.p }; } };
  if (ev.k !== 'pt') return;
  const v = hostCoords(ev.h), lines = [`X ${L(v.x)}   Y ${L(v.y)}   Z ${L(v.z)}`, ev.h.src ? 'from the body origin' : 'world'];
  say(lines.join('   '));
  set({ result: { note: lines, at: ev.h.p, lines: [[ev.h.p, ev.h.p]] } });
}

// ── DÜZENLEME ──
/** DIMSPACE: seçilen doğrusal ölçülerin çizgileri taban ölçüden eşit aralıkla dizilir (0 = aynı hizaya). */
function* spaceCmd(c: Ctx): G {
  const name = 'DIMSPACE', base = yield* pickLin(name, 'base dimension');
  if (!base) return;
  const ids: string[] = [];
  const hi = () => { const R = rctx(), st = get(); return [base.id, ...ids].flatMap(id => { const d = st.dims.find(x => x.id === id), dr = d && drawDim(d, R, lastHit?.wpp ?? 1, st.style); return dr ? dr.lines : []; }); };
  for (;;) {
    const ev = yield { prompt: `${name}  Select dimensions to space (${ids.length} selected) — Enter when done`, kind: 'pick', pick: 'lindim', preview: () => ({ hi: hi() }) };
    if (ev.k === 'enter') break;
    if (ev.k !== 'pt' || !ev.h.dimId || ev.h.dimId === base.id) continue;
    const i = ids.indexOf(ev.h.dimId);
    if (i >= 0) ids.splice(i, 1); else ids.push(ev.h.dimId);
  }
  if (!ids.length) return;
  const ev = yield { prompt: `${name}  Enter spacing value (mm) or`, kind: 'value', num: true, opts: [o('Auto', 'A')], def: 'Auto', preview: () => ({ hi: hi() }) };
  const R = rctx(), f = linFrame(base, R), auto = get().style.spacing * (lastHit?.wpp ?? 1);
  const sp = (ev.k === 'num' ? Math.max(0, ev.v) : auto) * sgn(base.off || 1), line = f.A.clone().addScaledVector(f.e, base.off);
  ids.forEach((id, i) => {
    const d = linById(id);
    if (!d) return;
    const g = linFrame(d, R), qi = frameOf(d.a.sid, R).clone().invert();
    c.update(id, { ...d, e: t3(f.e.clone().applyQuaternion(qi)), off: line.clone().addScaledVector(f.e, sp * (i + 1)).sub(g.A).dot(f.e) });
  });
  say('Spacing adjusted.');
}
/** DIMEDIT: ölçü yazısını değiştirir (boş / <> = ölçülen değer). */
function* editTextCmd(c: Ctx): G {
  const name = 'DIMEDIT';
  for (;;) {
    const ev = yield { prompt: `${name}  Select a dimension to change its text`, kind: 'pick', pick: 'dim' };
    if (ev.k === 'enter') return;
    const d = ev.k === 'pt' ? get().dims.find(x => x.id === ev.h.dimId) : null;
    if (!d || d.t === 'cmark') continue;
    const txt = yield* askText(name);
    c.update(d.id, { ...d, txt });
  }
}
// Anlık komutlar (adımı yok): stil penceresi · göster / gizle · hepsini sil.
/* eslint-disable require-yield */
function* styleCmd(): G { set({ styleOpen: true }); }
function* visCmd(): G { const v = !get().visible; set({ visible: v }); say(v ? 'Dimensions shown.' : 'Dimensions hidden.'); }
function* clearCmd(): G { const n = get().dims.length; eraseAllDims(); say(n ? `${n} dimension${n > 1 ? 's' : ''} erased.` : 'No dimensions to erase.'); }
/* eslint-enable require-yield */

export interface DimCmd { id: string; label: string; group: 'dim' | 'series' | 'measure' | 'edit'; aliases: string[]; tip: string; run: (c: Ctx) => G; /** durum çubuğundaki adım adları */ steps?: string[] }
const C = (id: string, label: string, group: DimCmd['group'], tip: string, run: (c: Ctx) => G, aliases: string[] = [], steps?: string[]): DimCmd => ({ id, label, group, tip, run, aliases, steps });
const PTS = ['First point', 'Second point', 'Place'];
export const DIM_COMMANDS: DimCmd[] = [
  C('DIM', 'Dimension', 'dim', 'One tool for all — click an edge, a circle or two points', dimCmd, [], ['Edge or corner', 'Place']),
  C('DIMLINEAR', 'Linear', 'dim', 'Distance along X, Y or Z', linearCmd('DIMLINEAR', 'lin'), ['DLI', 'DIMLIN'], PTS),
  C('DIMALIGNED', 'Aligned', 'dim', 'True distance between two points', linearCmd('DIMALIGNED', 'ali'), ['DAL'], PTS),
  C('DIMANGULAR', 'Angular', 'dim', 'Angle between two edges, of an arc, or by three points', angularCmd, ['DAN'], ['First edge', 'Second edge', 'Place']),
  C('DIMRADIUS', 'Radius', 'dim', 'Radius of an arc or circle', arcCmd('DIMRADIUS', 'rad'), ['DRA'], ['Arc or circle', 'Place']),
  C('DIMDIAMETER', 'Diameter', 'dim', 'Diameter of a circle or arc', arcCmd('DIMDIAMETER', 'dia'), ['DDI'], ['Arc or circle', 'Place']),
  C('DIMJOGGED', 'Jogged', 'dim', 'Radius of a large arc with a jogged line', joggedCmd, ['DJO', 'DIMJOG']),
  C('DIMARC', 'Arc length', 'dim', 'Length along an arc', arcCmd('DIMARC', 'arc'), ['DAR']),
  C('DIMORDINATE', 'Ordinate', 'dim', 'X, Y or Z of a point from the body origin', ordinateCmd, ['DOR', 'DIMORD']),
  C('DIMBASELINE', 'Baseline', 'series', 'More dimensions from the same first point', seriesCmd('base'), ['DBA', 'DIMBASE']),
  C('DIMCONTINUE', 'Continue', 'series', 'A chain — each starts where the last ended', seriesCmd('cont'), ['DCO', 'DIMCONT']),
  C('QDIM', 'Quick dimension', 'series', 'Dimension several edges at once', qdimCmd),
  C('CENTERMARK', 'Center mark', 'series', 'Center cross on a circle or arc', centerMarkCmd, ['DCE', 'DIMCENTER']),
  C('DIST', 'Distance', 'measure', 'Measure between two points (ΔX ΔY ΔZ)', distCmd, ['DI'], ['First point', 'Second point']),
  C('MEASURERADIUS', 'Measure radius', 'measure', 'Radius and diameter of an arc or circle', measureRadiusCmd),
  C('HOLE', 'Hole', 'measure', 'Diameter and depth of a hole — click its round edge', holeCmd, ['HL', 'MEASUREHOLE'], ['Hole', 'Label']),
  C('MEASUREANGLE', 'Measure angle', 'measure', 'Angle by vertex and two points, or between two edges', measureAngleCmd),
  C('AREA', 'Area', 'measure', 'Area and perimeter by points, or of a face', areaCmd, ['AA']),
  C('ID', 'Point coordinates', 'measure', 'X, Y, Z of a point', idCmd),
  C('DIMEDIT', 'Edit text', 'edit', 'Change the text of a dimension', editTextCmd, ['DED', 'DIMTEDIT']),
  C('DIMSPACE', 'Space', 'edit', 'Space dimension lines evenly from a base dimension', spaceCmd),
  C('DIMSTYLE', 'Style', 'edit', 'Text size, arrows, precision', styleCmd, ['D', 'DST']),
  C('DIMVIS', 'Show / hide', 'edit', 'Show or hide all dimensions', visCmd, ['DIMHIDE', 'DIMSHOW']),
  C('DIMCLEAR', 'Erase all', 'edit', 'Erase every dimension', clearCmd),
];
export const dimCommandById = (id: string) => DIM_COMMANDS.find(c => c.id === id);
