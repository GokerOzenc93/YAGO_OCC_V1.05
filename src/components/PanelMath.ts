import * as THREE from 'three';
import type { VirtualFace } from '../store';

// ═══════════════════════════════════════════════════════════════════════════
// PanelMath — PANEL / VF ORTAK MATEMATİĞİ (saf, store'suz).
// Eskiden 4–5 dosyada ayrı ayrı kopyalanan küçük yardımcılar tek yerde:
// eksen harfi → vektör, şekil matrisi, VF düzlem tabanı + oransal çıpalar,
// dönüş açısı çözücüleri, kutu/oran yardımcıları. Motor (PanelEngine), adım
// komutları (PanelSteps), bölge çekirdeği (FaceRegion) ve gizmolar buradan okur.
// ═══════════════════════════════════════════════════════════════════════════

export type Vec3 = [number, number, number];
export type AxisDir = 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-';

/** 'x+' | 'y-' … → birim vektör (tanımsız harf → sıfır vektör). */
export function axisDirToVec(a: string): THREE.Vector3 {
  switch (a) {
    case 'x+': return new THREE.Vector3(1, 0, 0);
    case 'x-': return new THREE.Vector3(-1, 0, 0);
    case 'y+': return new THREE.Vector3(0, 1, 0);
    case 'y-': return new THREE.Vector3(0, -1, 0);
    case 'z+': return new THREE.Vector3(0, 0, 1);
    case 'z-': return new THREE.Vector3(0, 0, -1);
    default: return new THREE.Vector3(0, 0, 0);
  }
}

/** Dünya ekseni harfi ('x' | 'y' | 'z') → birim vektör. */
export function axisLetterVec(axis: string): THREE.Vector3 {
  return new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
}

/** Şeklin yerel → dünya matrisi (position · Euler XYZ · scale). */
export function getShapeMatrix(shape: any): THREE.Matrix4 {
  const s = shape.scale ?? [1, 1, 1];
  return new THREE.Matrix4().compose(
    new THREE.Vector3(shape.position[0], shape.position[1], shape.position[2]),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(shape.rotation[0], shape.rotation[1], shape.rotation[2], 'XYZ')),
    new THREE.Vector3(s[0], s[1], s[2])
  );
}

/** Yüz düzlemi 2B tabanı (bölge/ayak izi hesaplarının tek u/v kuralı). */
export function getFacePlaneAxes(normal: THREE.Vector3): { u: THREE.Vector3; v: THREE.Vector3 } {
  const n = normal.clone().normalize();
  const absX = Math.abs(n.x), absY = Math.abs(n.y), absZ = Math.abs(n.z);
  const up = absY > absX && absY > absZ ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(n, up).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  return { u, v };
}

/** Panel kalınlığı (parametre; yoksa 18). */
export function panelThickness(shape: any): number {
  return parseFloat(shape?.parameters?.panelThickness) || 18;
}

// ── VF DÜZLEM TABANI + ORANSAL ÇIPALAR ───────────────────────────────────────
// Pivot ve nişan noktası VF dikdörtgenine ORANSAL (u/v ∈ [0,1] + normal ofseti)
// saklanır: yüz büyüyüp küçüldükçe nokta yüzle kayar; yakalama ve rebuild aynı
// tabanı (vfPlaneBasis) kullanır.

/** Deterministik VF düzlem tabanı — yakalama ve rebuild aynı kuralı kullanır. */
export function vfPlaneBasis(normal: Vec3 | number[]): { n: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3 } {
  const n = new THREE.Vector3(normal[0], normal[1], normal[2]).normalize();
  const up = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(up, n).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  return { n, u, v };
}

type VfLike = { normal: Vec3 | number[]; vertices: Array<Vec3 | number[]> };

/** VF köşelerinin vfPlaneBasis tabanındaki kutusu (nOff = düzlem ofseti). */
function vfUvBox(vf: VfLike) {
  const { n, u, v } = vfPlaneBasis(vf.normal);
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity, nOff = 0;
  for (const c of vf.vertices) {
    const w = new THREE.Vector3(c[0], c[1], c[2]);
    uMin = Math.min(uMin, w.dot(u)); uMax = Math.max(uMax, w.dot(u));
    vMin = Math.min(vMin, w.dot(v)); vMax = Math.max(vMax, w.dot(v));
    nOff = w.dot(n);
  }
  return { n, u, v, uMin, uMax, vMin, vMax, nOff };
}

/** Dünya noktasının VF dikdörtgenindeki oranı (u/v ∈ [0,1]) + normal ofseti. */
export function vfFracOfPoint(vf: VfLike | undefined | null, point: Vec3): Vec3 | undefined {
  if (!vf?.normal || !Array.isArray(vf.vertices) || vf.vertices.length < 3) return undefined;
  const b = vfUvBox(vf);
  const pw = new THREE.Vector3(...point);
  const su = Math.max(b.uMax - b.uMin, 1e-6), sv = Math.max(b.vMax - b.vMin, 1e-6);
  return [
    Math.max(0, Math.min(1, (pw.dot(b.u) - b.uMin) / su)),
    Math.max(0, Math.min(1, (pw.dot(b.v) - b.vMin) / sv)),
    pw.dot(b.n) - b.nOff,
  ];
}

/** vfFracOfPoint'in tersi: oransal çıpayı GÜNCEL VF'den dünya noktasına çözer. */
export function resolveVfFracPoint(frac: Vec3, vf: VfLike): THREE.Vector3 {
  const b = vfUvBox(vf);
  const [fu, fv, dn] = frac;
  return new THREE.Vector3()
    .addScaledVector(b.u, b.uMin + fu * (b.uMax - b.uMin))
    .addScaledVector(b.v, b.vMin + fv * (b.vMax - b.vMin))
    .addScaledVector(b.n, b.nOff + dn);
}

/** Kullanıcının dünya ekseni harfini panelin VF tabanındaki en yakın yerel eksene eşler. */
export function mapAxisToVfLocal(vf: { normal: Vec3 | number[] } | undefined | null, axis: 'x' | 'y' | 'z'): Vec3 | undefined {
  if (!vf?.normal) return undefined;
  const { n, u, v } = vfPlaneBasis(vf.normal);
  const wa = axisLetterVec(axis);
  const du = Math.abs(wa.dot(u)), dv = Math.abs(wa.dot(v)), dn = Math.abs(wa.dot(n));
  const chosen = dn >= du && dn >= dv ? n : du >= dv ? u : v;
  return [chosen.x, chosen.y, chosen.z];
}

/**
 * FIXED taşıma referansı: VF'nin HAM yüz konumunun taşıma ekseni boyunca min
 * değeri (rawFaceBBox varsa ondan, yoksa VF köşelerinden). Fixed adımda yüz ne
 * kadar kaydıysa o kadar ters öteleme eklenir → panel mutlak konumda kalır.
 */
export function vfRawMinAlong(vf: VirtualFace, axisLetter: string): number | null {
  if (!vf?.vertices || vf.vertices.length < 3) return null;
  const a = axisDirToVec(axisLetter);
  const p = new THREE.Vector3(Math.abs(a.x), Math.abs(a.y), Math.abs(a.z));
  if (p.lengthSq() < 0.5) return null;
  const n = new THREE.Vector3(...(vf.normal as Vec3)).normalize();
  const c0 = vf.vertices[0];
  const planeD = c0[0] * n.x + c0[1] * n.y + c0[2] * n.z;
  const rb = (vf as any).rawFaceBBox as { xMin: number; xMax: number; yMin: number; yMax: number } | undefined;
  let min = Infinity;
  if (rb) {
    const { u, v } = getFacePlaneAxes(n);
    for (const x of [rb.xMin, rb.xMax]) for (const y of [rb.yMin, rb.yMax]) {
      const w = new THREE.Vector3().addScaledVector(u, x).addScaledVector(v, y).addScaledVector(n, planeD);
      min = Math.min(min, w.dot(p));
    }
  } else {
    for (const c of vf.vertices) min = Math.min(min, c[0] * p.x + c[1] * p.y + c[2] * p.z);
  }
  return Number.isFinite(min) ? min : null;
}

// ── DÖNÜŞ AÇISI ÇÖZÜCÜLERİ ───────────────────────────────────────────────────

/** Noktayı pivot etrafında eksen boyunca deg derece döndürür. */
export function rotateAboutAxis(pt: THREE.Vector3, pivot: THREE.Vector3, axis: THREE.Vector3, deg: number): THREE.Vector3 {
  const q = new THREE.Quaternion().setFromAxisAngle(axis.clone().normalize(), (deg * Math.PI) / 180);
  return pt.clone().sub(pivot).applyQuaternion(q).add(pivot);
}

/** a → b İŞARETLİ açı (derece), eksen etrafında; izdüşüm sıfırsa null. */
export function signedAngleAboutAxis(a: THREE.Vector3, b: THREE.Vector3, axis: THREE.Vector3): number | null {
  const ax = axis.clone().normalize();
  const ap = a.clone().addScaledVector(ax, -a.dot(ax));
  const bp = b.clone().addScaledVector(ax, -b.dot(ax));
  if (ap.length() < 1e-6 || bp.length() < 1e-6) return null;
  ap.normalize(); bp.normalize();
  const cross = new THREE.Vector3().crossVectors(ap, bp);
  return (Math.atan2(cross.dot(ax), ap.dot(bp)) * 180) / Math.PI;
}

/**
 * ÇEMBER ∩ DÜZLEM: pivot etrafında dönen nişan noktası düzleme hangi açıda
 * değer? A cosθ + B sinθ = c'nin iki kökünden `prefer`e en yakını. Ulaşılamıyorsa
 * en yakın yaklaşma açısı (touched=false); nişan eksen üstündeyse null.
 */
export function angleToTouchPlane(
  pivot: THREE.Vector3, arm: THREE.Vector3, axis: THREE.Vector3,
  planeNormal: THREE.Vector3, planePoint: THREE.Vector3, prefer = 0
): { deg: number; touched: boolean } | null {
  const u = axis.clone().normalize();
  const n = planeNormal.clone().normalize();
  const a0 = arm.clone().sub(pivot);
  const aPar = u.clone().multiplyScalar(u.dot(a0));
  const aPerp = a0.clone().sub(aPar);
  if (aPerp.length() < 1e-6) return null;
  const w = new THREE.Vector3().crossVectors(u, aPerp);
  const A = n.dot(aPerp), B = n.dot(w);
  const c = n.dot(planePoint) - n.dot(pivot) - n.dot(aPar);
  const R = Math.hypot(A, B);
  if (R < 1e-9) return null;
  const phi = Math.atan2(B, A);
  if (Math.abs(c) > R) return { deg: normDeg(c > 0 ? phi : phi + Math.PI), touched: false };
  const delta = Math.acos(Math.max(-1, Math.min(1, c / R)));
  const roots = [normDeg(phi - delta), normDeg(phi + delta)];
  const off = (d: number) => Math.abs(((d - prefer + 540) % 360) - 180);
  return { deg: roots.reduce((best, d) => (off(d) < off(best) ? d : best)), touched: true };
}

/** Radyan → (−180, 180] derece. */
export function normDeg(rad: number): number {
  let d = (rad * 180) / Math.PI;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}

// ── KUTU / ORAN YARDIMCILARI ─────────────────────────────────────────────────

/** Geometrinin, şeklin dünya matrisiyle taşınmış sınır kutusu. */
export function worldBboxOf(shape: any, geometry: THREE.BufferGeometry | undefined): THREE.Box3 | null {
  const pos = geometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) return null;
  return new THREE.Box3().setFromBufferAttribute(pos).applyMatrix4(getShapeMatrix(shape));
}

/** Noktanın kutudaki oranı, [0,1]'e kırpılmış. */
export function fracInBox(box: THREE.Box3, p: Vec3): Vec3 {
  const fr = (a: number, b: number, x: number) => (Math.abs(b - a) < 1e-9 ? 0 : (x - a) / (b - a));
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  return [
    clamp01(fr(box.min.x, box.max.x, p[0])),
    clamp01(fr(box.min.y, box.max.y, p[1])),
    clamp01(fr(box.min.z, box.max.z, p[2])),
  ];
}

export function pointFromFracBox(box: THREE.Box3, f: Vec3): THREE.Vector3 {
  return new THREE.Vector3(
    box.min.x + f[0] * (box.max.x - box.min.x),
    box.min.y + f[1] * (box.max.y - box.min.y),
    box.min.z + f[2] * (box.max.z - box.min.z),
  );
}

/** replicad kutusu (bounds) ile THREE kutusu 0.5 mm paydan fazla örtüşüyor mu? */
export function boundsOverlapBox(rb: number[][], bb: THREE.Box3): boolean {
  return rb[0][0] < bb.max.x - 0.5 && rb[1][0] > bb.min.x + 0.5
    && rb[0][1] < bb.max.y - 0.5 && rb[1][1] > bb.min.y + 0.5
    && rb[0][2] < bb.max.z - 0.5 && rb[1][2] > bb.min.z + 0.5;
}

/** replicad bounds → "x,y,z..x,y,z" (log). */
export function fmtBounds(shape: any): string {
  return shape.boundingBox.bounds.map((v: number[]) => v.map(n => n.toFixed(0)).join(',')).join('..');
}

/** Vektör → "x,y,z" (log). */
export function fmtVec(v: { x: number; y: number; z: number }, digits = 1): string {
  return [v.x, v.y, v.z].map(n => n.toFixed(digits)).join(',');
}

/** Mesh köşeleri, 0.1 mm'de tekilleştirilmiş (tampon sırası korunur). */
export function uniqueMeshPoints(geometry: THREE.BufferGeometry): THREE.Vector3[] {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const pts: THREE.Vector3[] = [];
  if (!pos) return pts;
  const seen = new Set<string>();
  for (let i = 0; i < pos.count; i++) {
    const p = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
    const key = `${Math.round(p.x * 10)},${Math.round(p.y * 10)},${Math.round(p.z * 10)}`;
    if (seen.has(key)) continue;
    seen.add(key); pts.push(p);
  }
  return pts;
}
