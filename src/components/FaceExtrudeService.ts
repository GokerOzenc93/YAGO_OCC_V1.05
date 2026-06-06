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
  /** Local-space point on the clicked face surface — used to uniquely
   *  identify the correct replicad face regardless of center/normal ambiguity. */
  samplePoint?: [number, number, number];
}

export interface FaceExtrudeParams {
  panelShape: Shape;
  faceGroupIndex: number;
  value: number;
  isFixed: boolean;
  shapes: Shape[];
  updateShape: (id: string, updates: Partial<Shape>) => void;
  /** Local-space click point captured from the Three.js pointer event. */
  clickPoint?: [number, number, number];
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
  targetCenter: THREE.Vector3,
  samplePoint?: THREE.Vector3
): any | null {
  const faces = replicadShape.faces;
  if (!faces || faces.length === 0) return null;

  const targetLabel = getAxisLabel(targetNormal);
  const candidates: Array<{ face: any; dot: number; dist: number; minPtDist: number }> = [];

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
      let minPtDist = Infinity;
      try {
        const faceMesh = face.mesh({ tolerance: 1.0, angularTolerance: 15 });
        if (faceMesh.vertices && faceMesh.vertices.length >= 3) {
          let sx = 0, sy = 0, sz = 0;
          const nv = faceMesh.vertices.length / 3;
          for (let j = 0; j < faceMesh.vertices.length; j += 3) {
            sx += faceMesh.vertices[j];
            sy += faceMesh.vertices[j + 1];
            sz += faceMesh.vertices[j + 2];
            if (samplePoint) {
              const vx = faceMesh.vertices[j] - samplePoint.x;
              const vy = faceMesh.vertices[j + 1] - samplePoint.y;
              const vz = faceMesh.vertices[j + 2] - samplePoint.z;
              const d = Math.sqrt(vx * vx + vy * vy + vz * vz);
              if (d < minPtDist) minPtDist = d;
            }
          }
          center = new THREE.Vector3(sx / nv, sy / nv, sz / nv);
        }
      } catch {
        candidates.push({ face, dot, dist: Infinity, minPtDist: Infinity });
        continue;
      }

      candidates.push({ face, dot, dist: center.distanceTo(targetCenter), minPtDist });
    } catch {
      continue;
    }
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].face;

  // When a sample point is available, prefer the replicad face whose
  // tessellation is CLOSEST to that point. The correct face contains the
  // click point so its minPtDist ≈ 0; inner slot walls are much farther.
  if (samplePoint) {
    candidates.sort((a, b) => a.minPtDist - b.minPtDist || b.dot - a.dot);
  } else {
    candidates.sort((a, b) => a.dist - b.dist || b.dot - a.dot);
  }
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

  // Prefer flat (axis-aligned) groups first; fall back to the full list so
  // that legacy steps with slightly curved stored normals still resolve.
  const flatAligned = groups.filter(g => {
    const gNorm = g.normal.clone().normalize();
    const isFlat = Math.abs(gNorm.x) > 0.999 || Math.abs(gNorm.y) > 0.999 || Math.abs(gNorm.z) > 0.999;
    return isFlat && getAxisLabel(gNorm) === step.axisLabel;
  });
  const aligned = flatAligned.length > 0 ? flatAligned : groups.filter(g => {
    const gNorm = g.normal.clone().normalize();
    return getAxisLabel(gNorm) === step.axisLabel && gNorm.dot(stepNormal) > 0.5;
  });
  if (aligned.length === 0) {
    console.warn(`[applyOneExtrudeStep] No aligned face group for axis ${step.axisLabel}. Groups:`, groups.map(g => getAxisLabel(g.normal.clone().normalize())));
    return null;
  }

  const box = new THREE.Box3().setFromBufferAttribute(
    geometry.getAttribute('position') as THREE.BufferAttribute
  );

  const stepCenter = new THREE.Vector3(...step.faceCenter);
  const stepNorm = new THREE.Vector3(...step.faceNormal).normalize();

  // Determine the expected bbox boundary for this axis direction.
  // The outer face of the panel lives at the bbox extreme; inner slot walls
  // are set back from it. When stepCenter is near the bbox boundary (the user
  // clicked on the outer face), we apply a heavy penalty to candidate groups
  // that are far from the boundary so that inner slot walls are never
  // preferred over the outer face.
  const absNX = Math.abs(stepNorm.x), absNY = Math.abs(stepNorm.y), absNZ = Math.abs(stepNorm.z);
  type AxisKey = 'x' | 'y' | 'z';
  let axisKey: AxisKey;
  let expectedBoundary: number;
  if (absNX >= absNY && absNX >= absNZ) {
    axisKey = 'x';
    expectedBoundary = stepNorm.x > 0 ? box.max.x : box.min.x;
  } else if (absNY >= absNX && absNY >= absNZ) {
    axisKey = 'y';
    expectedBoundary = stepNorm.y > 0 ? box.max.y : box.min.y;
  } else {
    axisKey = 'z';
    expectedBoundary = stepNorm.z > 0 ? box.max.z : box.min.z;
  }
  const BOUNDARY_TOL = 5.0;
  const stepNearBoundary = Math.abs(stepCenter[axisKey] - expectedBoundary) < BOUNDARY_TOL;

  let bestGroup = aligned[0];
  if (aligned.length > 1) {
    let bestScore = Infinity;
    for (const g of aligned) {
      const distToStep = g.center.distanceTo(stepCenter);
      // If the user clicked near the bbox boundary (outer face intent), penalise
      // any candidate group whose centre is NOT on the boundary — these are inner
      // slot/recess faces that should never be preferred over the outer face.
      const distToBoundary = Math.abs(g.center[axisKey] - expectedBoundary);
      const boundaryPenalty = stepNearBoundary && distToBoundary > BOUNDARY_TOL ? 10000 : 0;
      const score = distToStep + boundaryPenalty;
      if (score < bestScore) { bestScore = score; bestGroup = g; }
    }
  }

  const faceNormal = bestGroup.normal.clone().normalize();
  const faceCenter = bestGroup.center.clone();

  let extrudeAmount: number;
  if (step.isFixed) {
    // Measure the current distance from the selected face to the opposite
    // bounding-box boundary along the face's normal. Using the face centre
    // position (not the full bbox size) gives the correct result even for
    // stepped / L-shaped panels where the selected face is not at the bbox edge.
    const absX = Math.abs(faceNormal.x);
    const absY = Math.abs(faceNormal.y);
    const absZ = Math.abs(faceNormal.z);
    let faceDist: number;
    if (absX >= absY && absX >= absZ) {
      faceDist = faceNormal.x > 0
        ? faceCenter.x - box.min.x
        : box.max.x - faceCenter.x;
    } else if (absY >= absX && absY >= absZ) {
      faceDist = faceNormal.y > 0
        ? faceCenter.y - box.min.y
        : box.max.y - faceCenter.y;
    } else {
      faceDist = faceNormal.z > 0
        ? faceCenter.z - box.min.z
        : box.max.z - faceCenter.z;
    }
    extrudeAmount = step.value - faceDist;
  } else {
    extrudeAmount = step.value;
  }

  if (Math.abs(extrudeAmount) < 0.01) {
    console.warn(`[applyOneExtrudeStep] Extrude amount too small: ${extrudeAmount} for step ${step.axisLabel}`);
    return null;
  }

  const samplePt = step.samplePoint
    ? new THREE.Vector3(...step.samplePoint)
    : undefined;
  const matchingFace = findMatchingReplicadFace(currentShape, faceNormal, faceCenter, samplePt);
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

  // Face extrude changes the panel topology; fillets are invalidated and
  // must be cleared so stale fillet data is not re-applied later.
  updateShape(panelShape.id, {
    geometry: currentGeometry,
    replicadShape: currentReplicad,
    fillets: [],
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

  // Snap curved (fillet) face groups to the nearest axis-aligned flat face.
  // A curved group has no normal component above ~0.9; selecting one would
  // produce a non-axis-aligned step that mismatches stored flat-face steps.
  const rawGroup = groups[faceGroupIndex];
  let faceNormal = rawGroup.normal.clone().normalize();
  let faceCenter = rawGroup.center.clone();

  // Must match the isAxisAligned threshold in GeometryUtils (0.999) so that
  // fillet arc faces (classified "curved" by groupCoplanarFaces) are correctly
  // snapped to the nearest true flat face instead of extruded directly.
  const isFlat = (n: THREE.Vector3) =>
    Math.abs(n.x) > 0.999 || Math.abs(n.y) > 0.999 || Math.abs(n.z) > 0.999;

  if (!isFlat(faceNormal)) {
    const axLbl = getAxisLabel(faceNormal);
    const candidate = groups
      .filter(g => {
        const n = g.normal.clone().normalize();
        return isFlat(n) && getAxisLabel(n) === axLbl;
      })
      .sort((a, b) => a.center.distanceTo(rawGroup.center) - b.center.distanceTo(rawGroup.center))[0];
    if (candidate) {
      faceNormal = candidate.normal.clone().normalize();
      faceCenter = candidate.center.clone();
    }
  }

  const axisLabel = getAxisLabel(faceNormal);

  if (!panel.parameters?.baseReplicadShape) {
    // Build the pre-fillet base shape: box + subtractions (no fillets).
    // Using panel.replicadShape directly would capture the filleted topology
    // which causes OpenCASCADE boolean operations to fail or give wrong results.
    const { createReplicadBox, performBooleanCut } = await import('./ReplicadService');
    const W = panel.parameters?.width ?? 1;
    const H = panel.parameters?.height ?? 1;
    const D = panel.parameters?.depth ?? 1;
    let baseShape: any = await createReplicadBox({ width: W, height: H, depth: D });
    for (const sub of (panel.subtractionGeometries ?? [])) {
      try {
        let w: number, h: number, d: number;
        if (sub.parameters) {
          w = parseFloat(sub.parameters.width); h = parseFloat(sub.parameters.height); d = parseFloat(sub.parameters.depth);
        } else {
          const B = new THREE.Box3().setFromBufferAttribute(sub.geometry.getAttribute('position') as THREE.BufferAttribute);
          const S = new THREE.Vector3(); B.getSize(S); w = S.x; h = S.y; d = S.z;
        }
        const SB = await createReplicadBox({ width: w, height: h, depth: d });
        baseShape = await performBooleanCut(baseShape, SB, undefined, sub.relativeOffset, undefined, sub.relativeRotation ?? [0,0,0], undefined, sub.scale ?? [1,1,1]);
      } catch { /* skip failed subtraction */ }
    }
    panel = { ...panel, parameters: { ...panel.parameters, baseReplicadShape: baseShape } };
    updateShape(panel.id, { parameters: { ...panel.parameters } });
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
    const absX = Math.abs(faceNormal.x);
    const absY = Math.abs(faceNormal.y);
    const absZ = Math.abs(faceNormal.z);
    let faceDist: number;
    if (absX >= absY && absX >= absZ) {
      faceDist = faceNormal.x > 0 ? faceCenter.x - box.min.x : box.max.x - faceCenter.x;
    } else if (absY >= absX && absY >= absZ) {
      faceDist = faceNormal.y > 0 ? faceCenter.y - box.min.y : box.max.y - faceCenter.y;
    } else {
      faceDist = faceNormal.z > 0 ? faceCenter.z - box.min.z : box.max.z - faceCenter.z;
    }
    extrudeAmount = value - faceDist;
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
    samplePoint: params.clickPoint,
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
