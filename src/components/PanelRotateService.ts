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
    const { n, u, v } = vfPlaneBasis(vf.normal as [number, number, number]);
    const wa = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
    const du = Math.abs(wa.dot(u)), dv = Math.abs(wa.dot(v)), dn = Math.abs(wa.dot(n));
    const chosen = dn >= du && dn >= dv ? n : du >= dv ? u : v;
    axisVec = [chosen.x, chosen.y, chosen.z];

    // pivotVfFrac: pivotun VF dikdörtgenindeki oranı + normal ofseti.
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity, nOff = 0;
    for (const c of vf.vertices) {
      const w = new THREE.Vector3(c[0], c[1], c[2]);
      uMin = Math.min(uMin, w.dot(u)); uMax = Math.max(uMax, w.dot(u));
      vMin = Math.min(vMin, w.dot(v)); vMax = Math.max(vMax, w.dot(v));
      nOff = w.dot(n);
    }
    const pw = new THREE.Vector3(...pivot);
    const pu = pw.dot(u), pv = pw.dot(v), pn = pw.dot(n);
    const su = Math.max(uMax - uMin, 1e-6), sv = Math.max(vMax - vMin, 1e-6);
    pivotVfFrac = [
      Math.max(0, Math.min(1, (pu - uMin) / su)),
      Math.max(0, Math.min(1, (pv - vMin) / sv)),
      pn - nOff,
    ];
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
// REFERANS İLE DÖNDÜRME (rotate-ref) — "face extrude gibi".
// Kullanıcı: pivot + eksen seçer (mevcut gizmo), Ref moduna geçer, başka bir
// şekilde referans yüzü tıklar. Onayda panel, seçtiği pivot/eksen çevresinde
// referans DÜZLEME İLK DEĞENE kadar döner. Extrude-ref MESAFE hesaplar; burada
// AÇI hesaplanır — eksen/pivot kullanıcıdan, değer (açı) referanstan.
//
// Matematik: dönüş dünya ekseni a (pivot P'den geçer), referans düzlem (nR·x=d).
// Her köşe V için w=V−P; w_par=(w·a)a, w_perp=w−w_par. θ dönüşü sonrası
//   nR·Rot(w) = nR·w_par + cosθ·(nR·w_perp) + sinθ·(nR·(a×w_perp))
// Düzleme değme: nR·Rot(w)+nR·P = d  →  A cosθ + B sinθ = C
//   A=nR·w_perp, B=nR·(a×w_perp), C=d−nR·P−nR·w_par.
// Çözüm: R=hypot(A,B); |C|≤R ise θ=atan2(B,A)±acos(C/R). Tüm köşelerin tüm
// çözümleri arasından EN KÜÇÜK |θ| = ilk temas (panel yüzeye ilk değdiği an).
// ═══════════════════════════════════════════════════════════════════════════

export interface RotateToReferenceParams {
  panelShape: Shape;
  axis: 'x' | 'y' | 'z';
  pivot: [number, number, number];                 // dünya, kullanıcı seçimli
  referencePointWorld: [number, number, number];    // dünya
  referenceNormalWorld: [number, number, number];    // dünya
  shapes: Shape[];
  updateShape: (id: string, updates: Partial<Shape>) => void;
}

export async function executeRotateToReference(params: RotateToReferenceParams): Promise<boolean> {
  const { panelShape, axis, pivot, referencePointWorld, referenceNormalWorld, shapes, updateShape } = params;

  const { useAppStore } = await import('../store');
  const state = useAppStore.getState();
  const fresh = state.shapes.find(s => s.id === panelShape.id) || panelShape;

  // 1) Dönüş DÜNYA ekseni — motorun (composeSteps) kullanacağıyla AYNI kural:
  //    eksen harfi → VF tabanının (u/v/n) en yakınına eşlenir → birleşik
  //    çerçeveyle (önceki adımların dönüşü) döndürülür.
  const vf = state.virtualFaces?.find((f: any) => f.id === (fresh.parameters as any)?.virtualFaceId);
  if (!vf?.normal) { console.warn('[YAGO][ROT-REF] VF bulunamadı, iptal.'); return false; }
  const { n, u, v } = vfPlaneBasis(vf.normal as [number, number, number]);
  const wa = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
  const du = Math.abs(wa.dot(u)), dv = Math.abs(wa.dot(v)), dn = Math.abs(wa.dot(n));
  const axisLocal = dn >= du && dn >= dv ? n : du >= dv ? u : v;

  const { getUnifiedSteps, composeSteps } = await import('./PanelEngine');
  const steps = getUnifiedSteps(fresh);
  const { quat: frame } = composeSteps(steps, vf as any);
  const a = axisLocal.clone().applyQuaternion(frame).normalize();

  // 2) Panelin mevcut yüzey normali (dünya) — VF normali + birleşik çerçeve.
  const panelNormalWorld = n.clone().applyQuaternion(frame).normalize();
  const nR = new THREE.Vector3(...referenceNormalWorld).normalize();
  const EPS = (0.02 * Math.PI) / 180;

  // 3) Dönüş açısı: panelin yüzey normali, referans yüzey normaline paralel
  //    veya anti-paralel olana kadar döndür. Panel referansa UZAYACAKMIŞ gibi
  //    — yani açı, panelin yüzeyi referans yüzeyine yatay (flush) gelecek şekilde
  //    hesaplanır; panelin mevcut kısa boyutu açıyı etkilemez. İki çözüt vardır
  //    (±nR); en küçük |θ| olanı seçilir.
  const pPerp = panelNormalWorld.clone().sub(
    a.clone().multiplyScalar(panelNormalWorld.dot(a))
  );
  if (pPerp.length() < 1e-9) {
    console.warn('[YAGO][ROT-REF] panel normali dönüş eksenine paralel, döndürülemez.');
    return false;
  }

  let best: number | null = null;
  for (const sign of [1, -1]) {
    const target = nR.clone().multiplyScalar(sign);
    const tPerp = target.clone().sub(
      a.clone().multiplyScalar(target.dot(a))
    );
    if (tPerp.length() < 1e-9) continue;
    const cosθ = pPerp.dot(tPerp) / (pPerp.length() * tPerp.length());
    const sinθ = new THREE.Vector3().crossVectors(a, pPerp).dot(tPerp)
      / (pPerp.length() * tPerp.length());
    let θ = Math.atan2(sinθ, cosθ);
    while (θ > Math.PI) θ -= 2 * Math.PI;
    while (θ < -Math.PI) θ += 2 * Math.PI;
    if (Math.abs(θ) < EPS) continue;
    if (best === null || Math.abs(θ) < Math.abs(best)) best = θ;
  }

  if (best === null) {
    console.warn('[YAGO][ROT-REF] referans yüzeye bu eksen/pivotla ulaşılamıyor.');
    return false;
  }

  const deg = (best * 180) / Math.PI;
  console.log('[YAGO][ROT-REF] hesaplanan açı=', deg.toFixed(2), '° eksen=', axis,
    'pivot=', pivot.map(x => x.toFixed(1)).join(','),
    'refN=', referenceNormalWorld.map(x => x.toFixed(2)).join(','));

  // 4) Mevcut döndürme boru hattını kullan (pivot çıpaları + adım yazımı orada).
  return executePanelRotate({ panelShape: fresh, axis, value: deg, pivot, shapes, updateShape });
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
