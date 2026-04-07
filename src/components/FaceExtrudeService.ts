import * as THREE from 'three';
import type { Shape } from '../store';
import {
  extractFacesFromGeometry,
  groupCoplanarFaces,
} from './GeometryUtils';

export interface ExtrudeStep {
  id: string;
  faceNormal: [number, number, number];
  faceCenter: [number, number, number];
  axisLabel: string;
  value: number;
  isFixed: boolean;
  timestamp: number;
}

export interface FaceExtrudeParams {
  panelShape: Shape;
  faceGroupIndex: number;
  value: number;
  isFixed: boolean;
  shapes: Shape[];
  updateShape: (id: string, updates: Partial<Shape>) => void;
}

function getAxisLabel(normal: THREE.Vector3): string {
  const absX = Math.abs(normal.x);
  const absY = Math.abs(normal.y);
  const absZ = Math.abs(normal.z);
  if (absX >= absY && absX >= absZ) return normal.x > 0 ? 'X+' : 'X-';
  if (absY >= absX && absY >= absZ) return normal.y > 0 ? 'Y+' : 'Y-';
  return normal.z > 0 ? 'Z+' : 'Z-';
}

export function findExistingStepForFace(
  steps: ExtrudeStep[],
  faceNormal: THREE.Vector3,
  faceCenter?: THREE.Vector3
): ExtrudeStep | null {
  const label = getAxisLabel(faceNormal);
  const candidates = steps.filter(s => s.axisLabel === label);
  if (candidates.length === 0) return null;
  if (candidates.length === 1 || !faceCenter) return candidates[0];
  let best: ExtrudeStep | null = null;
  let bestDist = Infinity;
  for (const s of candidates) {
    const sc = new THREE.Vector3(...s.faceCenter);
    const d = sc.distanceTo(faceCenter);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return best;
}

function findMatchingReplicadFace(
  replicadShape: any,
  targetNormal: THREE.Vector3,
  targetCenter: THREE.Vector3
): any | null {
  const faces = replicadShape.faces;
  if (!faces || faces.length === 0) return null;

  const targetLabel = getAxisLabel(targetNormal);
  const candidates: Array<{ face: any; dot: number; dist: number }> = [];

  for (let i = 0; i < faces.length; i++) {
    const face = faces[i];
    try {
      const normalVec = face.normalAt(0.5, 0.5);
      const faceNormal = new THREE.Vector3(normalVec.x, normalVec.y, normalVec.z);
      const faceLabel = getAxisLabel(faceNormal);
      if (faceLabel !== targetLabel) continue;

      const dot = faceNormal.dot(targetNormal);
      if (dot < 0.5) continue;

      let center = new THREE.Vector3();
      try {
        const faceMesh = face.mesh({ tolerance: 0.5, angularTolerance: 30 });
        if (faceMesh.vertices && faceMesh.vertices.length >= 3) {
          let sx = 0, sy = 0, sz = 0;
          const nv = faceMesh.vertices.length / 3;
          for (let j = 0; j < faceMesh.vertices.length; j += 3) {
            sx += faceMesh.vertices[j];
            sy += faceMesh.vertices[j + 1];
            sz += faceMesh.vertices[j + 2];
          }
          center = new THREE.Vector3(sx / nv, sy / nv, sz / nv);
        }
      } catch {
        candidates.push({ face, dot, dist: Infinity });
        continue;
      }

      candidates.push({ face, dot, dist: center.distanceTo(targetCenter) });
    } catch {
      continue;
    }
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].face;
  candidates.sort((a, b) => b.dot - a.dot || a.dist - b.dist);
  return candidates[0].face;
}

async function applyOneExtrudeStep(
  currentShape: any,
  step: ExtrudeStep,
  geometry: THREE.BufferGeometry
): Promise<{ replicadShape: any; geometry: THREE.BufferGeometry } | null> {
  const { convertReplicadToThreeGeometry, initReplicad } = await import('./ReplicadService');
  const oc = await initReplicad();

  const faces = extractFacesFromGeometry(geometry);
  const groups = groupCoplanarFaces(faces);
  const stepNormal = new THREE.Vector3(...step.faceNormal);

  const aligned = groups.filter(g => {
    const gNorm = g.normal.clone().normalize();
    const gLabel = getAxisLabel(gNorm);
    return gLabel === step.axisLabel && gNorm.dot(stepNormal) > 0.7;
  });
  if (aligned.length === 0) {
    console.warn(`[applyOneExtrudeStep] No aligned face group for axis ${step.axisLabel}. Groups:`, groups.map(g => getAxisLabel(g.normal.clone().normalize())));
    return null;
  }

  const bestGroup = aligned[0];

  const faceNormal = bestGroup.normal.clone().normalize();
  const faceCenter = bestGroup.center.clone();

  const box = new THREE.Box3().setFromBufferAttribute(
    geometry.getAttribute('position') as THREE.BufferAttribute
  );
  const size = new THREE.Vector3();
  box.getSize(size);

  let extrudeAmount: number;
  if (step.isFixed) {
    const absX = Math.abs(faceNormal.x);
    const absY = Math.abs(faceNormal.y);
    const absZ = Math.abs(faceNormal.z);
    let currentDimension: number;
    if (absX >= absY && absX >= absZ) currentDimension = size.x;
    else if (absY >= absX && absY >= absZ) currentDimension = size.y;
    else currentDimension = size.z;
    extrudeAmount = step.value - currentDimension;
  } else {
    extrudeAmount = step.value;
  }

  if (Math.abs(extrudeAmount) < 0.01) {
    console.warn(`[applyOneExtrudeStep] Extrude amount too small: ${extrudeAmount} for step ${step.axisLabel}`);
    return null;
  }

  const matchingFace = findMatchingReplicadFace(currentShape, faceNormal, faceCenter);
  if (!matchingFace) {
    console.warn(`[applyOneExtrudeStep] No matching replicad face for normal ${faceNormal.toArray()} center ${faceCenter.toArray()}`);
    return null;
  }

  const extVec: [number, number, number] = [
    faceNormal.x * extrudeAmount,
    faceNormal.y * extrudeAmount,
    faceNormal.z * extrudeAmount,
  ];
  const ocVec = new oc.gp_Vec_4(extVec[0], extVec[1], extVec[2]);
  const prismBuilder = new oc.BRepPrimAPI_MakePrism_1(
    matchingFace.wrapped, ocVec, false, true
  );
  prismBuilder.Build(new oc.Message_ProgressRange_1());
  const extrudedSolid = prismBuilder.Shape();

  const { cast } = await import('replicad');
  const extrudedShape = cast(extrudedSolid);

  const finalShape = extrudeAmount > 0
    ? currentShape.fuse(extrudedShape)
    : currentShape.cut(extrudedShape);

  const newGeometry = convertReplicadToThreeGeometry(finalShape);
  return { replicadShape: finalShape, geometry: newGeometry };
}

export async function rebuildFromSteps(
  panelShape: Shape,
  steps: ExtrudeStep[],
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  if (!panelShape.parameters?.baseReplicadShape) return false;

  const { convertReplicadToThreeGeometry } = await import('./ReplicadService');

  let currentReplicad = panelShape.parameters.baseReplicadShape;
  let currentGeometry = convertReplicadToThreeGeometry(currentReplicad);
  let anyStepApplied = false;

  for (const step of steps) {
    const result = await applyOneExtrudeStep(currentReplicad, step, currentGeometry);
    if (result) {
      currentReplicad = result.replicadShape;
      currentGeometry = result.geometry;
      anyStepApplied = true;
    } else {
      console.warn(`[rebuildFromSteps] Step ${step.axisLabel} (id=${step.id}) failed to apply`);
    }
  }

  if (!anyStepApplied) {
    console.warn(`[rebuildFromSteps] No extrude steps applied for panel ${panelShape.id}`);
  }

  const newBox = new THREE.Box3().setFromBufferAttribute(
    currentGeometry.getAttribute('position') as THREE.BufferAttribute
  );
  const newSize = new THREE.Vector3();
  newBox.getSize(newSize);

  const baseGeometry = convertReplicadToThreeGeometry(panelShape.parameters.baseReplicadShape);
  const baseBox = new THREE.Box3().setFromBufferAttribute(
    baseGeometry.getAttribute('position') as THREE.BufferAttribute
  );
  const baseSize = new THREE.Vector3();
  baseBox.getSize(baseSize);
  const baseSizes = [baseSize.x, baseSize.y, baseSize.z];
  const thicknessAxis = baseSizes.indexOf(Math.min(...baseSizes));
  const originalThickness = baseSizes[thicknessAxis];

  const sizeArr = [newSize.x, newSize.y, newSize.z];
  const sortedAxes = [0, 1, 2]
    .map(a => ({ axis: a, size: sizeArr[a] }))
    .sort((a, b) => b.size - a.size);
  const newWidth = sortedAxes[0].size;
  const newHeight = sortedAxes[1].size;

  updateShape(panelShape.id, {
    geometry: currentGeometry,
    replicadShape: currentReplicad,
    parameters: {
      ...panelShape.parameters,
      width: Math.round(newWidth * 10) / 10,
      height: Math.round(newHeight * 10) / 10,
      depth: Math.round(originalThickness * 10) / 10,
      extrudeSteps: steps,
    },
  });

  return true;
}

export async function executeFaceExtrude(params: FaceExtrudeParams): Promise<boolean> {
  const { faceGroupIndex, value, isFixed, updateShape } = params;
  let panel = params.panelShape;

  if (!panel.geometry || !panel.replicadShape) return false;

  const faces = extractFacesFromGeometry(panel.geometry);
  const groups = groupCoplanarFaces(faces);

  if (faceGroupIndex < 0 || faceGroupIndex >= groups.length) return false;

  const selectedGroup = groups[faceGroupIndex];
  const faceNormal = selectedGroup.normal.clone().normalize();
  const faceCenter = selectedGroup.center.clone();
  const axisLabel = getAxisLabel(faceNormal);

  if (!panel.parameters?.baseReplicadShape) {
    panel = {
      ...panel,
      parameters: {
        ...panel.parameters,
        baseReplicadShape: panel.replicadShape,
      },
    };
    updateShape(panel.id, {
      parameters: {
        ...panel.parameters,
      },
    });
  }

  const existingSteps: ExtrudeStep[] = panel.parameters?.extrudeSteps || [];

  const existingIdx = existingSteps.findIndex(s => {
    if (s.axisLabel !== axisLabel) return false;
    const sc = new THREE.Vector3(...s.faceCenter);
    return sc.distanceTo(faceCenter) < 1.0;
  });

  let extrudeAmount: number;
  if (isFixed) {
    const box = new THREE.Box3().setFromBufferAttribute(
      panel.geometry!.getAttribute('position') as THREE.BufferAttribute
    );
    const size = new THREE.Vector3();
    box.getSize(size);
    const absX = Math.abs(faceNormal.x);
    const absY = Math.abs(faceNormal.y);
    const absZ = Math.abs(faceNormal.z);
    let currentDimension: number;
    if (absX >= absY && absX >= absZ) currentDimension = size.x;
    else if (absY >= absX && absY >= absZ) currentDimension = size.y;
    else currentDimension = size.z;
    extrudeAmount = value - currentDimension;
  } else {
    extrudeAmount = value;
  }

  if (Math.abs(extrudeAmount) < 0.01 && existingIdx === -1) return false;

  const newStep: ExtrudeStep = {
    id: `ext-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
    faceNormal: [faceNormal.x, faceNormal.y, faceNormal.z],
    faceCenter: [faceCenter.x, faceCenter.y, faceCenter.z],
    axisLabel,
    value,
    isFixed,
    timestamp: Date.now(),
  };

  let newSteps: ExtrudeStep[];
  if (existingIdx >= 0) {
    newSteps = [...existingSteps];
    newSteps[existingIdx] = newStep;
  } else {
    newSteps = [...existingSteps, newStep];
  }

  return rebuildFromSteps(
    {
      ...panel,
      parameters: {
        ...panel.parameters,
        baseReplicadShape: panel.parameters.baseReplicadShape || panel.replicadShape,
      },
    },
    newSteps,
    updateShape
  );
}

export async function deleteExtrudeStep(
  panelShape: Shape,
  stepId: string,
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  const steps: ExtrudeStep[] = panelShape.parameters?.extrudeSteps || [];
  const newSteps = steps.filter(s => s.id !== stepId);

  return rebuildFromSteps(panelShape, newSteps, updateShape);
}

export async function updateExtrudeStep(
  panelShape: Shape,
  stepId: string,
  newValue: number,
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  const steps: ExtrudeStep[] = panelShape.parameters?.extrudeSteps || [];
  const newSteps = steps.map(s =>
    s.id === stepId ? { ...s, value: newValue } : s
  );

  return rebuildFromSteps(panelShape, newSteps, updateShape);
}
