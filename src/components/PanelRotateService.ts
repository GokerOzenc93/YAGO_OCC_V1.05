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
