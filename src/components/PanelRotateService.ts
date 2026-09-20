import * as THREE from 'three';
import type { Shape } from '../store';

// ═══════════════════════════════════════════════════════════════════════════
// PanelRotateService — İNCE ADAPTÖR.
// Görsel katmanın (PanelEditor) ve VF regen'in beklediği imzaları korur;
// dönüş artık BİRLEŞİK adım listesine yazılır ve PanelEngine yeniden üretir.
// Korunan kurallar:
//  • PANEL-YEREL EKSEN: kullanıcının dünya ekseni, panelin VF düzlem tabanına
//    (u/v/n) en yakın yerel eksene eşlenir → dönüş her yüzde "yerinde eğer".
//  • PİVOT ÇIPALARI: pivotVfFrac (VF'ye oransal, ASIL) + pivotFrac (parent
//    kutusuna oransal, yedek) + mutlak pivot (son çare). Rebuild pivotu her
//    seferinde güncel yüzeyden türetir — parametrik.
// ═══════════════════════════════════════════════════════════════════════════

/** Deterministik VF düzlem tabanı — yakalama ve rebuild aynı kuralı kullanır. */
export function vfPlaneBasis(normal: [number, number, number]): {
  n: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3;
} {
  const n = new THREE.Vector3(normal[0], normal[1], normal[2]).normalize();
  const up = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(up, n).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  return { n, u, v };
}

/**
 * Bir DÜNYA noktasının, VF dikdörtgenindeki oransal konumu (u/v ∈ [0,1]) +
 * normal ofseti. Pivot ve NİŞAN noktası aynı çıpa kuralını kullanır: yüz
 * büyüyüp küçüldükçe nokta yüzle birlikte kayar, "büyüt & sığdır" (dönmüş
 * panelin geçici büyütmesi) bu çıpayı hiç etkilemez.
 */
export function vfFracOfPoint(
  vf: { normal: [number, number, number] | number[]; vertices: Array<[number, number, number] | number[]> },
  point: [number, number, number]
): [number, number, number] | undefined {
  if (!vf?.normal || !Array.isArray(vf.vertices) || vf.vertices.length < 3) return undefined;
  const { n, u, v } = vfPlaneBasis(vf.normal as [number, number, number]);
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity, nOff = 0;
  for (const c of vf.vertices) {
    const w = new THREE.Vector3(c[0], c[1], c[2]);
    uMin = Math.min(uMin, w.dot(u)); uMax = Math.max(uMax, w.dot(u));
    vMin = Math.min(vMin, w.dot(v)); vMax = Math.max(vMax, w.dot(v));
    nOff = w.dot(n);
  }
  const pw = new THREE.Vector3(...point);
  const su = Math.max(uMax - uMin, 1e-6), sv = Math.max(vMax - vMin, 1e-6);
  return [
    Math.max(0, Math.min(1, (pw.dot(u) - uMin) / su)),
    Math.max(0, Math.min(1, (pw.dot(v) - vMin) / sv)),
    pw.dot(n) - nOff,
  ];
}

/**
 * a → b arasındaki İŞARETLİ açı (derece), axis ekseni etrafında sağ el kuralı.
 * Her iki vektör önce eksene dik düzleme izdüşürülür (eksen dışı bileşen dönüşe
 * katkı vermez). Düzlemdeki izdüşüm sıfıra düşerse (nokta eksen üstünde) null.
 */
export function signedAngleAboutAxis(
  a: THREE.Vector3, b: THREE.Vector3, axis: THREE.Vector3
): number | null {
  const ax = axis.clone().normalize();
  const ap = a.clone().addScaledVector(ax, -a.dot(ax));
  const bp = b.clone().addScaledVector(ax, -b.dot(ax));
  if (ap.length() < 1e-6 || bp.length() < 1e-6) return null;
  ap.normalize(); bp.normalize();
  const cross = new THREE.Vector3().crossVectors(ap, bp);
  const rad = Math.atan2(cross.dot(ax), ap.dot(bp));
  return (rad * 180) / Math.PI;
}

/**
 * ÇEMBER ∩ DÜZLEM: pivot etrafında `axis` ile dönen nişan noktası (arm), verilen
 * DÜZLEME (n·X = n·Q) hangi açıda değer? a(θ) = a∥ + a⊥cosθ + (û×a⊥)sinθ →
 * n·a(θ) = c çözülür: A cosθ + B sinθ = c. İki kök vardır; `prefer` derecesine
 * en yakın olan seçilir (oluşturmada 0 = en küçük dönüş, rebuild'de önceki
 * çözüm = süreklilik). Nokta düzleme hiç ulaşamıyorsa (|c| > √(A²+B²)) en
 * yakın yaklaşma açısı döner ve `touched=false` işaretlenir; nişan eksen
 * üstündeyse null.
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
  const norm = (rad: number) => { let d = (rad * 180) / Math.PI; while (d > 180) d -= 360; while (d <= -180) d += 360; return d; };
  const nearest = (cands: number[]) => cands.reduce((best, d) => {
    const dd = Math.abs(((d - prefer + 540) % 360) - 180);
    const db = Math.abs(((best - prefer + 540) % 360) - 180);
    return dd < db ? d : best;
  });
  if (Math.abs(c) > R) {
    // Ulaşılamıyor: düzleme en yakın yaklaşma (c>0 → φ, c<0 → φ+π).
    const deg = norm(c > 0 ? phi : phi + Math.PI);
    return { deg, touched: false };
  }
  const delta = Math.acos(Math.max(-1, Math.min(1, c / R)));
  const roots = [norm(phi - delta), norm(phi + delta)];
  return { deg: nearest(roots), touched: true };
}

/** Kullanıcının dünya ekseni harfini, panelin VF tabanındaki en yakın yerel eksene eşler. */
export function mapAxisToVfLocal(
  vf: { normal: [number, number, number] | number[] } | undefined | null,
  axis: 'x' | 'y' | 'z'
): [number, number, number] | undefined {
  if (!vf?.normal) return undefined;
  const { n, u, v } = vfPlaneBasis(vf.normal as [number, number, number]);
  const wa = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
  const du = Math.abs(wa.dot(u)), dv = Math.abs(wa.dot(v)), dn = Math.abs(wa.dot(n));
  const chosen = dn >= du && dn >= dv ? n : du >= dv ? u : v;
  return [chosen.x, chosen.y, chosen.z];
}

export interface RotateStep {
  id: string;
  axis: 'x' | 'y' | 'z';
  axisVec?: [number, number, number];
  value: number;
  pivot: [number, number, number];
  pivotFrac?: [number, number, number];
  pivotVfFrac?: [number, number, number];
  timestamp: number;
}

export interface PanelRotateParams {
  panelShape: Shape;
  axis: 'x' | 'y' | 'z';
  value: number;
  pivot: [number, number, number];
  shapes: Shape[];
  updateShape: (id: string, updates: Partial<Shape>) => void;
}

/** Saf önizleme: adımları position/rotation üzerinde sırayla uygular. */
export function applyRotateSteps(
  basePosition: [number, number, number],
  baseRotation: [number, number, number],
  steps: RotateStep[]
): { position: [number, number, number]; rotation: [number, number, number] } {
  let pos = new THREE.Vector3(...basePosition);
  const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...baseRotation, 'XYZ'));
  for (const step of steps) {
    const pivot = new THREE.Vector3(...step.pivot);
    const angleRad = (step.value * Math.PI) / 180;
    const axisVec = step.axisVec
      ? new THREE.Vector3(...step.axisVec).normalize()
      : new THREE.Vector3(step.axis === 'x' ? 1 : 0, step.axis === 'y' ? 1 : 0, step.axis === 'z' ? 1 : 0);
    const stepQuat = new THREE.Quaternion().setFromAxisAngle(axisVec, angleRad);
    quat.premultiply(stepQuat);
    pos = pivot.clone().add(pos.sub(pivot).applyQuaternion(stepQuat));
  }
  const e = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
  return { position: [pos.x, pos.y, pos.z], rotation: [e.x, e.y, e.z] };
}

export async function executePanelRotate(params: PanelRotateParams): Promise<boolean> {
  const { panelShape, axis, value, pivot, shapes, updateShape } = params;
  if (Math.abs(value) < 0.001) return false;

  const { useAppStore } = await import('../store');
  const state = useAppStore.getState();
  const fresh = state.shapes.find(s => s.id === panelShape.id) || panelShape;

  // PANEL-YEREL EKSEN EŞLEME + PİVOT ÇIPALARI (VF'den).
  let axisVec: [number, number, number] | undefined;
  let pivotVfFrac: [number, number, number] | undefined;
  let pivotFrac: [number, number, number] | undefined;

  const vf = state.virtualFaces?.find((f: any) => f.id === (fresh.parameters as any)?.virtualFaceId);
  if (vf?.normal) {
    axisVec = mapAxisToVfLocal(vf as any, axis);
    // pivotVfFrac: pivotun VF dikdörtgenindeki oranı + normal ofseti.
    pivotVfFrac = vfFracOfPoint(vf as any, pivot);
  }

  // pivotFrac: parent kutusuna oransal yedek çıpa.
  const parent = state.shapes.find(s => s.id === (fresh.parameters as any)?.parentShapeId);
  if (parent) {
    const w = parseFloat((parent.parameters as any)?.width) || 1;
    const h = parseFloat((parent.parameters as any)?.height) || 1;
    const d = parseFloat((parent.parameters as any)?.depth) || 1;
    const pp = parent.position as any;
    pivotFrac = [
      (pivot[0] - pp[0]) / w,
      (pivot[1] - pp[1]) / h,
      (pivot[2] - pp[2]) / d,
    ];
  }

  const { executeTransformStep } = await import('./PanelTransformService');
  return executeTransformStep(
    fresh,
    { type: 'rotate', axis, value, pivot, axisVec, pivotFrac, pivotVfFrac },
    shapes,
    updateShape
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// REFERANS İLE DÖNDÜRME
// Kullanıcı sözleşmesi (Goker):
//   1. pivot (dönme noktası)  — panelin kendi köşe/merkez noktası
//   2. nişan noktası          — panelin, referansa değecek kendi noktası
//   3. eksen                  — X/Y/Z halkası (zorunlu)
//   4. referans YÜZ           — başka bir panelin yüzü (extrude-ref seçimiyle aynı)
//   5. sağ tık onay
// Açı: nişan noktası referans yüzün DÜZLEMİNE değene kadar dönülür. DONMUŞ
// değildir: yüz her rebuild'de referans panelin güncel geometrisinden çözülür,
// pivot/nişan VF çıpasından → referans yüz kaydıkça panel yeniden döner.
// Ayrıca referans panelin kenarı dönen panelin dış yüzeyiyle hizalanacak
// şekilde pahlanır (PanelEngine.shapeRefRotateTargets).
// ═══════════════════════════════════════════════════════════════════════════
export interface PanelRotateRefParams {
  panelShape: Shape;
  pivot: [number, number, number];
  armVertex: [number, number, number];
  axis: 'x' | 'y' | 'z';
  targetPanelId: string;
  targetFace: { faceGroupIndex: number; normalWorld: [number, number, number]; pointWorld: [number, number, number] };
  shapes: Shape[];
  updateShape: (id: string, updates: Partial<Shape>) => void;
}

export async function executePanelRotateRef(params: PanelRotateRefParams): Promise<boolean> {
  const { panelShape, pivot, armVertex, axis, targetPanelId, targetFace, updateShape } = params;

  const { useAppStore } = await import('../store');
  const state = useAppStore.getState();
  const fresh = state.shapes.find(s => s.id === panelShape.id) || panelShape;
  const vf = state.virtualFaces?.find((f: any) => f.id === (fresh.parameters as any)?.virtualFaceId);

  // PANEL-YEREL EKSEN: normal dönüşle BİREBİR aynı eşleme.
  const axisVec = mapAxisToVfLocal(vf as any, axis);
  const axisWorld = axisVec
    ? new THREE.Vector3(...axisVec)
    : new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);

  // Oluşturma anındaki açı — yalnız çözüm başarısız olursa yedek olarak kullanılır.
  const sol = angleToTouchPlane(
    new THREE.Vector3(...pivot), new THREE.Vector3(...armVertex), axisWorld,
    new THREE.Vector3(...targetFace.normalWorld), new THREE.Vector3(...targetFace.pointWorld), 0
  );
  if (!sol) {
    console.warn('[YAGO][REF-DÖN] nişan noktası eksen üstünde — açı tanımsız, iptal');
    return false;
  }
  if (!sol.touched) {
    console.warn('[YAGO][REF-DÖN] nişan noktası referans yüze ULAŞAMIYOR — en yakın yaklaşma açısı kullanılıyor:', sol.deg.toFixed(2));
  }
  const deg0 = Math.round(sol.deg * 1000) / 1000;

  // ÇIPALAR: pivot ve nişan noktası VF'ye oransal (pivotVfFrac ile aynı kural).
  const pivotVfFrac = vf ? vfFracOfPoint(vf as any, pivot) : undefined;
  const refArmVfFrac = vf ? vfFracOfPoint(vf as any, armVertex) : undefined;

  let pivotFrac: [number, number, number] | undefined;
  const parent = state.shapes.find(s => s.id === (fresh.parameters as any)?.parentShapeId);
  if (parent) {
    const w = parseFloat((parent.parameters as any)?.width) || 1;
    const h = parseFloat((parent.parameters as any)?.height) || 1;
    const d = parseFloat((parent.parameters as any)?.depth) || 1;
    const pp = parent.position as any;
    pivotFrac = [(pivot[0] - pp[0]) / w, (pivot[1] - pp[1]) / h, (pivot[2] - pp[2]) / d];
  }

  console.log('[YAGO][REF-DÖN] bağ kuruldu — pivotVfFrac=', pivotVfFrac,
    'nişanVfFrac=', refArmVfFrac, 'hedef=', targetPanelId, 'yüzGrubu=', targetFace.faceGroupIndex,
    'yüzN=', targetFace.normalWorld.map(n => n.toFixed(2)).join(','), 'eksen=', axis, 'açı0=', deg0.toFixed(2));

  const { getUnifiedSteps, setUnifiedSteps, rebuildPanelsForParent } = await import('./PanelEngine');
  const steps = getUnifiedSteps(fresh);
  const now = Date.now();
  const step: any = {
    id: `step-${now}`, type: 'rotate', axis, axisVec,
    value: deg0, resolvedValue: deg0,
    pivot, pivotFrac, pivotVfFrac, timestamp: now,
    refTargetPanelId: targetPanelId,
    refTargetFaceGroupIndex: targetFace.faceGroupIndex,
    refTargetFaceNormal: targetFace.normalWorld,
    refTargetFacePoint: targetFace.pointWorld,
    refArmVertex: armVertex,
    ...(refArmVfFrac ? { refArmVfFrac } : {}),
  };
  setUnifiedSteps(fresh, [...steps, step], updateShape);
  const parentId = (fresh.parameters as any)?.parentShapeId;
  if (parentId) await rebuildPanelsForParent(parentId, { changedPanelId: fresh.id, orderChanged: false });
  return true;
}

export async function updateRotateStep(
  panelShape: Shape,
  stepId: string,
  newValue: number,
  shapes: Shape[],
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  const { updateTransformStep } = await import('./PanelTransformService');
  return updateTransformStep(panelShape, stepId, newValue, shapes, updateShape);
}

export async function deleteRotateStep(
  panelShape: Shape,
  stepId: string,
  shapes: Shape[],
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  const { deleteTransformStep } = await import('./PanelTransformService');
  return deleteTransformStep(panelShape, stepId, shapes, updateShape);
}

/** Görsel yardımcılar (gizmo/step listesi) — davranış korunuyor. */
export function getPanelVertices(panelShape: Shape): [number, number, number][] {
  if (!panelShape.geometry) return [];
  const pos = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return [];
  const out: [number, number, number][] = [];
  const seen = new Set<string>();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = `${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([x + panelShape.position[0], y + panelShape.position[1], z + panelShape.position[2]]);
  }
  return out;
}

export function getPanelCenter(panelShape: Shape): [number, number, number] {
  const verts = getPanelVertices(panelShape);
  if (verts.length === 0) return [...panelShape.position] as [number, number, number];
  const c: [number, number, number] = [0, 0, 0];
  for (const v of verts) { c[0] += v[0]; c[1] += v[1]; c[2] += v[2]; }
  return [c[0] / verts.length, c[1] / verts.length, c[2] / verts.length];
}
