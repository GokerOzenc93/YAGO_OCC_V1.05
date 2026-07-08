import * as THREE from 'three';
import type { Shape } from '../store';

// Sanal yüzey için DETERMİNİSTİK düzlem tabanı — pivot çıpalama iki uçta da
// (yakalama ve rebuild) birebir aynı kuralla hesaplanmalıdır.
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
  value: number;
  pivot: [number, number, number];
  // Pivotun, adım oluşturma ANINDAKİ parent kutusuna oransal konumu (0..1).
  // Parent yeniden boyutlanınca rebuild pivotu bu oranlardan güncel kutuya
  // göre yeniden türetir — mutlak dünya pivotu bayatlayıp boşluk yaratmaz.
  pivotFrac?: [number, number, number];
  // ASIL ÇIPA: Pivotun, panelin KENDİ sanal yüzeyine oransal konumu.
  // [fu, fv, dn]: yüzey dikdörtgeninde (deterministik u/v tabanında) 0..1
  // oranları + normal boyunca mm ofseti. Rebuild pivotu her seferinde GÜNCEL
  // yüzeyden türetir: yüzey nereye taşınırsa (küp boyutlanması dahil) pivot
  // da onunla taşınır. pivotFrac ve mutlak pivot yedek olarak kalır.
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

export function applyRotateSteps(
  basePosition: [number, number, number],
  baseRotation: [number, number, number],
  steps: RotateStep[]
): { position: [number, number, number]; rotation: [number, number, number] } {
  let pos = new THREE.Vector3(...basePosition);
  let rot = new THREE.Euler(...baseRotation, 'XYZ');
  let quat = new THREE.Quaternion().setFromEuler(rot);

  for (const step of steps) {
    const pivot = new THREE.Vector3(...step.pivot);
    const angleRad = (step.value * Math.PI) / 180;
    const axisVec = new THREE.Vector3(
      step.axis === 'x' ? 1 : 0,
      step.axis === 'y' ? 1 : 0,
      step.axis === 'z' ? 1 : 0
    );

    const stepQuat = new THREE.Quaternion().setFromAxisAngle(axisVec, angleRad);
    quat.premultiply(stepQuat);

    const offset = pos.clone().sub(pivot);
    offset.applyQuaternion(stepQuat);
    pos = pivot.clone().add(offset);
  }

  const finalEuler = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
  return {
    position: [pos.x, pos.y, pos.z],
    rotation: [finalEuler.x, finalEuler.y, finalEuler.z],
  };
}

export async function executePanelRotate(params: PanelRotateParams): Promise<boolean> {
  const { panelShape, axis, value, pivot, shapes, updateShape } = params;

  if (Math.abs(value) < 0.001) return false;

  // SİGORTA: UI'dan gelen referans bayat olabilir — store'daki güncel hali baz al.
  const { useAppStore } = await import('../store');
  const fresh = useAppStore.getState().shapes.find(s => s.id === panelShape.id) || panelShape;

  // Pivotu parent kutusuna ORANSAL bağla: parent boyutlanınca pivot da yüzle
  // birlikte taşınır (köşe pivotu köşede kalır). Geometri okunamazsa mutlak
  // pivot ile eski davranışa düşülür.
  let pivotFrac: [number, number, number] | undefined;
  const parentShapeForPivot =
    useAppStore.getState().shapes.find(s => s.id === fresh.parameters?.parentShapeId);
  if (parentShapeForPivot?.geometry) {
    const posAttr = parentShapeForPivot.geometry.getAttribute('position');
    if (posAttr) {
      const bb = new THREE.Box3().setFromBufferAttribute(posAttr as THREE.BufferAttribute);
      const size = new THREE.Vector3();
      bb.getSize(size);
      const pl: [number, number, number] = [
        pivot[0] - parentShapeForPivot.position[0],
        pivot[1] - parentShapeForPivot.position[1],
        pivot[2] - parentShapeForPivot.position[2],
      ];
      pivotFrac = [
        size.x > 1e-6 ? (pl[0] - bb.min.x) / size.x : 0,
        size.y > 1e-6 ? (pl[1] - bb.min.y) / size.y : 0,
        size.z > 1e-6 ? (pl[2] - bb.min.z) / size.z : 0,
      ];
    }
  }

  // ASIL ÇIPA: pivotu panelin kendi sanal yüzeyine oransal bağla.
  let pivotVfFrac: [number, number, number] | undefined;
  const vfForPivot = useAppStore.getState().virtualFaces?.find(
    (f: any) => f.id === fresh.parameters?.virtualFaceId
  );
  if (vfForPivot?.vertices?.length >= 3 && parentShapeForPivot) {
    const { n, u, v } = vfPlaneBasis(vfForPivot.normal);
    const pp = parentShapeForPivot.position;
    const cWorld = new THREE.Vector3();
    for (const vv of vfForPivot.vertices) {
      cWorld.add(new THREE.Vector3(vv[0] + pp[0], vv[1] + pp[1], vv[2] + pp[2]));
    }
    cWorld.divideScalar(vfForPivot.vertices.length);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const vv of vfForPivot.vertices) {
      const w = new THREE.Vector3(vv[0] + pp[0], vv[1] + pp[1], vv[2] + pp[2]).sub(cWorld);
      const pu = w.dot(u), pv = w.dot(v);
      if (pu < minU) minU = pu; if (pu > maxU) maxU = pu;
      if (pv < minV) minV = pv; if (pv > maxV) maxV = pv;
    }
    const pw = new THREE.Vector3(pivot[0], pivot[1], pivot[2]).sub(cWorld);
    const su = maxU - minU, sv = maxV - minV;
    if (su > 1e-6 && sv > 1e-6) {
      pivotVfFrac = [
        (pw.dot(u) - minU) / su,
        (pw.dot(v) - minV) / sv,
        pw.dot(n),
      ];
    }
  }

  // BİRLEŞİK KAYIT: adım, taşıma adımlarıyla aynı transformSteps listesine
  // yazılır (tek doğruluk kaynağı). rotateSteps aynası ve taban kayıtları
  // PanelTransformService tarafından senkron tutulur — UI'daki birleşik
  // "işlem adımları" listesi de bu listeden beslenir.
  const { executeTransformStep } = await import('./PanelTransformService');
  return executeTransformStep(
    fresh,
    { type: 'rotate', axis, value, pivot, pivotFrac, pivotVfFrac },
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
  // Birleşik sisteme delege edilir; eski rotateSteps kayıtları orada
  // transformSteps'e otomatik göç eder (id'ler korunur).
  const { updateTransformStep } = await import('./PanelTransformService');
  return updateTransformStep(panelShape, stepId, newValue, shapes, updateShape);
}

export async function deleteRotateStep(
  panelShape: Shape,
  stepId: string,
  shapes: Shape[],
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  // Birleşik sisteme delege edilir; son adım silinirse taban kayıtları
  // (baseTransform* ve baseRotate*) orada temizlenir — bayat taban kalmaz.
  const { deleteTransformStep } = await import('./PanelTransformService');
  return deleteTransformStep(panelShape, stepId, shapes, updateShape);
}

export function getPanelVertices(panelShape: Shape): [number, number, number][] {
  if (!panelShape.geometry) return [];
  const pos = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return [];

  const mat = new THREE.Matrix4().compose(
    new THREE.Vector3(...panelShape.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...panelShape.rotation, 'XYZ')),
    new THREE.Vector3(...panelShape.scale)
  );

  const seen = new Map<string, [number, number, number]>();
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mat);
    const key = `${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)}`;
    if (!seen.has(key)) seen.set(key, [v.x, v.y, v.z]);
  }
  return Array.from(seen.values());
}

export function getPanelCenter(panelShape: Shape): [number, number, number] {
  if (!panelShape.geometry) return [...panelShape.position] as [number, number, number];
  const pos = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return [...panelShape.position] as [number, number, number];

  const bbox = new THREE.Box3().setFromBufferAttribute(pos);
  const center = new THREE.Vector3();
  bbox.getCenter(center);

  const mat = new THREE.Matrix4().compose(
    new THREE.Vector3(...panelShape.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...panelShape.rotation, 'XYZ')),
    new THREE.Vector3(...panelShape.scale)
  );
  center.applyMatrix4(mat);
  return [center.x, center.y, center.z];
}
