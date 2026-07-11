import * as THREE from 'three';
import type { Shape } from '../store';

export interface MoveTransformStep {
  id: string;
  type: 'move';
  axis: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-';
  value: number;
  timestamp: number;
}

export interface RotateTransformStep {
  id: string;
  type: 'rotate';
  axis: 'x' | 'y' | 'z';
  // Panel-yerel dönüş ekseni (vektör). Bkz. PanelRotateService.RotateStep.
  axisVec?: [number, number, number];
  value: number;
  pivot: [number, number, number];
  // Pivot çıpaları PanelRotateService'te hesaplanır ve adımla birlikte taşınır;
  // rebuild pivotu her seferinde güncel sanal yüzeyden yeniden türetir.
  pivotFrac?: [number, number, number];
  pivotVfFrac?: [number, number, number];
  timestamp: number;
}

export type TransformStep = MoveTransformStep | RotateTransformStep;

function axisToVector(axis: string): [number, number, number] {
  switch (axis) {
    case 'x+': return [1, 0, 0];
    case 'x-': return [-1, 0, 0];
    case 'y+': return [0, 1, 0];
    case 'y-': return [0, -1, 0];
    case 'z+': return [0, 0, 1];
    case 'z-': return [0, 0, -1];
    default: return [0, 0, 0];
  }
}

export function applyTransformSteps(
  basePosition: [number, number, number],
  baseRotation: [number, number, number],
  steps: TransformStep[]
): { position: [number, number, number]; rotation: [number, number, number] } {
  let pos = new THREE.Vector3(...basePosition);
  let quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...baseRotation, 'XYZ'));

  for (const step of steps) {
    if (step.type === 'move') {
      const dir = new THREE.Vector3(...axisToVector(step.axis));
      pos.add(dir.multiplyScalar(step.value));
    } else {
      const pivot = new THREE.Vector3(...step.pivot);
      const angleRad = (step.value * Math.PI) / 180;
      const axisVec = (step as any).axisVec
        ? new THREE.Vector3(...(step as any).axisVec).normalize()
        : new THREE.Vector3(
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
  }

  const finalEuler = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
  return {
    position: [pos.x, pos.y, pos.z],
    rotation: [finalEuler.x, finalEuler.y, finalEuler.z],
  };
}

// ── Tek doğruluk kaynağı çözümleyici ─────────────────────────────────────
// transformSteps varsa onu kullanır; yoksa ESKİ sistemin moveSteps/rotateSteps
// dizilerini zaman damgasına göre birleştirip birleşik listeye GÖÇ eder.
// Taban konum/rotasyon, hangi sistem daha önce başladıysa onun tabanıdır —
// eski sistemde ikinci sistemin tabanı, birincinin sonucundan yakalanıyordu,
// dolayısıyla en erken taban tüm zinciri doğru üretir.
export function resolveUnifiedTransform(panelShape: Shape): {
  steps: TransformStep[];
  basePosition: [number, number, number];
  baseRotation: [number, number, number];
  migrated: boolean;
} {
  const p = panelShape.parameters || {};
  const existing: TransformStep[] = p.transformSteps || [];
  if (existing.length > 0) {
    return {
      steps: existing,
      basePosition: p.baseTransformPosition ?? [...panelShape.position] as [number, number, number],
      baseRotation: p.baseTransformRotation ?? [...panelShape.rotation] as [number, number, number],
      migrated: false,
    };
  }

  const legacyMoves: any[] = p.moveSteps || [];
  const legacyRotates: any[] = p.rotateSteps || [];
  if (legacyMoves.length === 0 && legacyRotates.length === 0) {
    return {
      steps: [],
      basePosition: [...panelShape.position] as [number, number, number],
      baseRotation: [...panelShape.rotation] as [number, number, number],
      migrated: false,
    };
  }

  const steps: TransformStep[] = [
    ...legacyMoves.map(s => ({ ...s, type: 'move' as const })),
    ...legacyRotates.map(s => ({ ...s, type: 'rotate' as const })),
  ].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  const firstMoveTs = legacyMoves.length ? Math.min(...legacyMoves.map(s => s.timestamp || 0)) : Infinity;
  const firstRotTs = legacyRotates.length ? Math.min(...legacyRotates.map(s => s.timestamp || 0)) : Infinity;
  const basePosition: [number, number, number] =
    (firstMoveTs <= firstRotTs ? p.baseMovePosition : p.baseRotatePosition)
    ?? p.baseRotatePosition ?? p.baseMovePosition
    ?? [...panelShape.position] as [number, number, number];
  const baseRotation: [number, number, number] =
    p.baseRotateRotation ?? [...panelShape.rotation] as [number, number, number];

  return { steps, basePosition, baseRotation, migrated: true };
}

// Parametre paketini birleşik listeden üretir: transformSteps asıl kaynak,
// rotateSteps ise PanelRebuildService'in geometri (gönye/kesim) tarafı için
// senkron tutulan AYNA kopyadır. Eski moveSteps anahtarı göçte temizlenir.
function buildParams(
  fresh: Shape,
  steps: TransformStep[],
  basePosition: [number, number, number],
  baseRotation: [number, number, number]
): Record<string, any> {
  const params: Record<string, any> = {
    ...fresh.parameters,
    transformSteps: steps,
    rotateSteps: steps.filter(s => s.type === 'rotate'),
  };
  delete params.moveSteps;
  delete params.baseMovePosition;

  if (steps.length === 0) {
    delete params.baseTransformPosition;
    delete params.baseTransformRotation;
    delete params.baseRotatePosition;
    delete params.baseRotateRotation;
  } else {
    params.baseTransformPosition = basePosition;
    params.baseTransformRotation = baseRotation;
    // Eski rebuild yolu için uyumluluk aynası
    params.baseRotatePosition = basePosition;
    params.baseRotateRotation = baseRotation;
  }
  return params;
}

export async function executeTransformStep(
  panelShape: Shape,
  step: Omit<MoveTransformStep, 'id' | 'timestamp'> | Omit<RotateTransformStep, 'id' | 'timestamp'>,
  shapes: Shape[],
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  const { useAppStore } = await import('../store');
  const fresh = useAppStore.getState().shapes.find(s => s.id === panelShape.id) || panelShape;

  const { steps: existingSteps, basePosition, baseRotation } = resolveUnifiedTransform(fresh);

  const newStep: TransformStep = {
    ...step,
    id: `tf-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
    timestamp: Date.now(),
  } as TransformStep;

  const newSteps = [...existingSteps, newStep];
  const { position: newPosition, rotation: newRotation } = applyTransformSteps(basePosition, baseRotation, newSteps);

  updateShape(fresh.id, {
    position: newPosition,
    rotation: newRotation,
    parameters: buildParams(fresh, newSteps, basePosition, baseRotation),
  });

  await rebuildSiblingsAfterTransform(fresh, shapes);
  return true;
}

export async function updateTransformStep(
  panelShape: Shape,
  stepId: string,
  newValue: number,
  shapes: Shape[],
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  const { useAppStore } = await import('../store');
  const fresh = useAppStore.getState().shapes.find(s => s.id === panelShape.id) || panelShape;

  const { steps, basePosition, baseRotation } = resolveUnifiedTransform(fresh);
  const newSteps = steps.map(s => s.id === stepId ? { ...s, value: newValue } : s);
  const { position: newPosition, rotation: newRotation } = applyTransformSteps(basePosition, baseRotation, newSteps);

  updateShape(fresh.id, {
    position: newPosition,
    rotation: newRotation,
    parameters: buildParams(fresh, newSteps, basePosition, baseRotation),
  });

  await rebuildSiblingsAfterTransform(fresh, shapes);
  return true;
}

export async function deleteTransformStep(
  panelShape: Shape,
  stepId: string,
  shapes: Shape[],
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  const { useAppStore } = await import('../store');
  const fresh = useAppStore.getState().shapes.find(s => s.id === panelShape.id) || panelShape;

  const { steps, basePosition, baseRotation } = resolveUnifiedTransform(fresh);
  const newSteps = steps.filter(s => s.id !== stepId);
  const { position: newPosition, rotation: newRotation } = applyTransformSteps(basePosition, baseRotation, newSteps);

  updateShape(fresh.id, {
    position: newPosition,
    rotation: newRotation,
    parameters: buildParams(fresh, newSteps, basePosition, baseRotation),
  });

  await rebuildSiblingsAfterTransform(fresh, shapes);
  return true;
}

async function rebuildSiblingsAfterTransform(
  panel: Shape,
  shapes: Shape[]
): Promise<void> {
  const parentId = panel.parameters?.parentShapeId;
  if (!parentId) return;

  const parentShape = shapes.find(s => s.id === parentId);
  if (!parentShape) return;

  try {
    const { rebuildPanelsForParent } = await import('./PanelRebuildService');
    await rebuildPanelsForParent(parentId);
  } catch (err) {
    console.error('[PanelTransformService] Failed to rebuild siblings after transform:', err);
  }
}
