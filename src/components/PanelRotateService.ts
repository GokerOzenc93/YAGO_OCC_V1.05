import * as THREE from 'three';
import type { Shape } from '../store';

export interface RotateStep {
  id: string;
  pivot: [number, number, number];
  angleDeg: number;
  axis: [number, number, number];
  timestamp: number;
  // The panel's actual position/rotation immediately before this step was applied.
  // Stored so each step can be replayed in isolation from the correct geometric base.
  // Older steps without these fields fall back to the panel-level baseRotatePosition.
  stepBasePosition?: [number, number, number];
  stepBaseRotation?: [number, number, number];
}

export interface PanelRotateParams {
  panelShape: Shape;
  pivot: [number, number, number];
  angleDeg: number;
  axis: [number, number, number];
  shapes: Shape[];
  updateShape: (id: string, updates: Partial<Shape>) => void;
}

function computeBaseRotation(panelShape: Shape): [number, number, number] {
  return panelShape.parameters?.baseRotateRotation ?? [...panelShape.rotation] as [number, number, number];
}

function computeBasePosition(panelShape: Shape): [number, number, number] {
  return panelShape.parameters?.baseRotatePosition ?? panelShape.parameters?.baseMovePosition ?? [...panelShape.position] as [number, number, number];
}

export function applyRotateSteps(
  basePosition: [number, number, number],
  baseRotation: [number, number, number],
  steps: RotateStep[]
): { position: [number, number, number]; rotation: [number, number, number] } {
  let pos = new THREE.Vector3(...basePosition);
  let rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(...baseRotation, 'XYZ'));

  for (const step of steps) {
    const pivot = new THREE.Vector3(...step.pivot);
    const rotAxis = new THREE.Vector3(...step.axis).normalize();
    const angle = THREE.MathUtils.degToRad(step.angleDeg);
    const stepQuat = new THREE.Quaternion().setFromAxisAngle(rotAxis, angle);

    const offset = pos.clone().sub(pivot);
    offset.applyQuaternion(stepQuat);
    pos = pivot.clone().add(offset);

    rot = stepQuat.clone().multiply(rot);
  }

  const euler = new THREE.Euler().setFromQuaternion(rot, 'XYZ');
  return {
    position: [pos.x, pos.y, pos.z],
    rotation: [euler.x, euler.y, euler.z],
  };
}

function getParentCenter(panelShape: Shape, shapes: Shape[]): THREE.Vector3 | null {
  const parentId = panelShape.parameters?.parentShapeId;
  if (!parentId) return null;
  const parent = shapes.find(s => s.id === parentId);
  if (!parent || !parent.geometry) return null;

  const pos = parent.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return null;
  const bbox = new THREE.Box3().setFromBufferAttribute(pos);
  const center = new THREE.Vector3();
  bbox.getCenter(center);

  const mat = new THREE.Matrix4().compose(
    new THREE.Vector3(...parent.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...parent.rotation, 'XYZ')),
    new THREE.Vector3(...parent.scale)
  );
  center.applyMatrix4(mat);
  return center;
}

function computeInwardSign(
  panelShape: Shape,
  pivot: [number, number, number],
  axis: [number, number, number],
  shapes: Shape[]
): number {
  const parentCenter = getParentCenter(panelShape, shapes);
  if (!parentCenter) return 1;

  const panelCenter = new THREE.Vector3(...panelShape.position);
  const pivotVec = new THREE.Vector3(...pivot);

  const toPanel = panelCenter.clone().sub(pivotVec);
  if (toPanel.length() < 0.01) return 1;
  toPanel.normalize();

  const toParent = parentCenter.clone().sub(pivotVec);
  if (toParent.length() < 0.01) return 1;
  toParent.normalize();

  const rotAxis = new THREE.Vector3(...axis).normalize();
  const testAngle = THREE.MathUtils.degToRad(5);

  const testQuat = new THREE.Quaternion().setFromAxisAngle(rotAxis, testAngle);
  const rotatedPos = toPanel.clone().applyQuaternion(testQuat);
  const dotPositive = rotatedPos.dot(toParent);

  const testQuatNeg = new THREE.Quaternion().setFromAxisAngle(rotAxis, -testAngle);
  const rotatedNeg = toPanel.clone().applyQuaternion(testQuatNeg);
  const dotNegative = rotatedNeg.dot(toParent);

  return dotPositive >= dotNegative ? 1 : -1;
}


function getParentOBBPlanes(panelShape: Shape, shapes: Shape[]): { normal: THREE.Vector3; d: number }[] | null {
  const parentId = panelShape.parameters?.parentShapeId;
  if (!parentId) return null;
  const parent = shapes.find(s => s.id === parentId);
  if (!parent || !parent.geometry) return null;

  const pos = parent.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return null;
  const bbox = new THREE.Box3().setFromBufferAttribute(pos);

  const parentQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...parent.rotation, 'XYZ'));
  const parentPos = new THREE.Vector3(...parent.position);
  const parentScale = new THREE.Vector3(...parent.scale);

  const center = new THREE.Vector3();
  bbox.getCenter(center);
  center.multiply(parentScale).applyQuaternion(parentQuat).add(parentPos);

  const halfSize = new THREE.Vector3();
  bbox.getSize(halfSize).multiply(parentScale).multiplyScalar(0.5);

  const axisX = new THREE.Vector3(1, 0, 0).applyQuaternion(parentQuat).normalize();
  const axisY = new THREE.Vector3(0, 1, 0).applyQuaternion(parentQuat).normalize();
  const axisZ = new THREE.Vector3(0, 0, 1).applyQuaternion(parentQuat).normalize();

  const planes: { normal: THREE.Vector3; d: number }[] = [];
  const axesAndHalves: [THREE.Vector3, number][] = [
    [axisX, halfSize.x],
    [axisY, halfSize.y],
    [axisZ, halfSize.z],
  ];

  for (const [axis, half] of axesAndHalves) {
    const p1 = center.clone().add(axis.clone().multiplyScalar(half));
    planes.push({ normal: axis.clone(), d: axis.dot(p1) });
    const p2 = center.clone().sub(axis.clone().multiplyScalar(half));
    planes.push({ normal: axis.clone().negate(), d: axis.clone().negate().dot(p2) });
  }

  return planes;
}

function rayIntersectOBBPlanes(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  planes: { normal: THREE.Vector3; d: number }[]
): number | null {
  let tMin = -Infinity;
  let tMax = Infinity;

  for (const plane of planes) {
    const denom = plane.normal.dot(dir);
    const dist = plane.d - plane.normal.dot(origin);

    if (Math.abs(denom) < 1e-9) {
      if (dist < 0) return null;
      continue;
    }

    const t = dist / denom;

    if (denom < 0) {
      tMin = Math.max(tMin, t);
    } else {
      tMax = Math.min(tMax, t);
    }
  }

  if (tMin > tMax) return null;
  if (tMax < 0) return null;

  return tMax > 0.01 ? tMax : null;
}

interface AutoExtendResult {
  length: number;
  directionSign: number; // +1 = extends in +localLongDir, -1 = extends in -localLongDir
  longestAxisIdx: number; // the local axis index (0,1,2) to extend along
}

function computeAutoExtendLength(
  panelShape: Shape,
  newPosition: [number, number, number],
  newRotation: [number, number, number],
  pivot: [number, number, number],
  shapes: Shape[]
): AutoExtendResult | null {
  if (!panelShape.geometry) return null;

  const obbPlanes = getParentOBBPlanes(panelShape, shapes);
  if (!obbPlanes) return null;

  const panelAttr = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!panelAttr) return null;
  const panelLocalBbox = new THREE.Box3().setFromBufferAttribute(panelAttr);
  const panelSize = new THREE.Vector3();
  panelLocalBbox.getSize(panelSize);

  const sorted = [
    { i: 0, v: panelSize.x },
    { i: 1, v: panelSize.y },
    { i: 2, v: panelSize.z },
  ].sort((a, b) => a.v - b.v);

  // thinnest is always sorted[0]; the other two are candidates for longest axis.
  // When both face dims are equal (square panel), we must try both to find the
  // one with a valid ray intersection — otherwise the wrong axis gets picked.
  const candidateLongAxes = sorted.slice(1); // [second, longest] by size

  const panelQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...newRotation, 'XYZ'));
  const pivotVec = new THREE.Vector3(...pivot);

  const bboxCenter = new THREE.Vector3();
  panelLocalBbox.getCenter(bboxCenter);
  const actualWorldCenter = bboxCenter.clone().applyQuaternion(panelQuat)
    .add(new THREE.Vector3(...newPosition));

  let bestDist = -1;
  let bestDirSign = 1;
  let bestAxisIdx = candidateLongAxes[1].i; // default to geometrically-longest

  for (const candidate of candidateLongAxes) {
    const localDir = new THREE.Vector3(
      candidate.i === 0 ? 1 : 0,
      candidate.i === 1 ? 1 : 0,
      candidate.i === 2 ? 1 : 0
    );
    const worldDir = localDir.clone().applyQuaternion(panelQuat).normalize();

    const d1 = rayIntersectOBBPlanes(pivotVec, worldDir.clone(), obbPlanes);
    const d2 = rayIntersectOBBPlanes(pivotVec, worldDir.clone().negate(), obbPlanes);

    const v1 = d1 !== null && d1 > 1;
    const v2 = d2 !== null && d2 > 1;

    // When both are valid for this axis, use centroid direction to pick sign
    let chosenDist = -1;
    let chosenSign = 1;
    if (v1 && v2) {
      const dot = actualWorldCenter.clone().sub(pivotVec).dot(worldDir);
      chosenSign = dot >= 0 ? 1 : -1;
      chosenDist = chosenSign === 1 ? d1! : d2!;
    } else if (v1) {
      chosenSign = 1;
      chosenDist = d1!;
    } else if (v2) {
      chosenSign = -1;
      chosenDist = d2!;
    }

    if (chosenDist > bestDist) {
      bestDist = chosenDist;
      bestDirSign = chosenSign;
      bestAxisIdx = candidate.i;
    }
  }

  if (bestDist < 1) return null;

  // Build the final worldDir from the chosen axis
  const bestLocalDir = new THREE.Vector3(
    bestAxisIdx === 0 ? 1 : 0,
    bestAxisIdx === 1 ? 1 : 0,
    bestAxisIdx === 2 ? 1 : 0
  );
  const bestWorldDir = bestLocalDir.clone().applyQuaternion(panelQuat).normalize()
    .multiplyScalar(bestDirSign);

  const parentId = panelShape.parameters?.parentShapeId;
  const siblings = shapes.filter(
    s => s.type === 'panel' &&
      s.parameters?.parentShapeId === parentId &&
      s.id !== panelShape.id &&
      s.geometry
  );

  let closestCollision = bestDist;

  for (const sib of siblings) {
    const sibAttr = sib.geometry!.getAttribute('position') as THREE.BufferAttribute;
    if (!sibAttr) continue;
    const sibBbox = new THREE.Box3().setFromBufferAttribute(sibAttr);
    const sibMat = new THREE.Matrix4().compose(
      new THREE.Vector3(...sib.position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...sib.rotation, 'XYZ')),
      new THREE.Vector3(...sib.scale)
    );
    const sibCorners: THREE.Vector3[] = [];
    const sMn = sibBbox.min;
    const sMx = sibBbox.max;
    for (let xi = 0; xi <= 1; xi++)
      for (let yi = 0; yi <= 1; yi++)
        for (let zi = 0; zi <= 1; zi++)
          sibCorners.push(new THREE.Vector3(
            xi === 0 ? sMn.x : sMx.x,
            yi === 0 ? sMn.y : sMx.y,
            zi === 0 ? sMn.z : sMx.z
          ).applyMatrix4(sibMat));

    const sibWorldBbox = new THREE.Box3().setFromPoints(sibCorners);

    // Skip siblings whose bbox already contains the pivot (they are adjacent to
    // the pivot corner and are not blocking the extension — they are simply
    // touching/sharing that corner). Expand slightly to handle floating-point edge cases.
    const expandedSibBbox = sibWorldBbox.clone().expandByScalar(0.5);
    if (expandedSibBbox.containsPoint(pivotVec)) continue;

    const sibHit = new THREE.Vector3();
    const sibRay = new THREE.Ray(pivotVec.clone(), bestWorldDir.clone());
    if (sibRay.intersectBox(sibWorldBbox, sibHit)) {
      const dist = sibHit.distanceTo(pivotVec);
      if (dist > 0.5 && dist < closestCollision) {
        closestCollision = dist;
      }
    }
  }

  return { length: closestCollision, directionSign: bestDirSign, longestAxisIdx: bestAxisIdx };
}

async function rebuildPanelGeometry(
  panelShape: Shape,
  newLength: number,
  pivot: [number, number, number],
  directionSign: number,
  longestAxisIdx: number,
  updateShape: (id: string, updates: Partial<Shape>) => void,
  stepBasePosition?: [number, number, number],
  stepBaseRotation?: [number, number, number]
): Promise<void> {
  if (!panelShape.geometry) return;

  const panelAttr = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!panelAttr) return;
  const panelLocalBbox = new THREE.Box3().setFromBufferAttribute(panelAttr);
  const panelSize = new THREE.Vector3();
  panelLocalBbox.getSize(panelSize);

  const axes = [
    { i: 0, v: panelSize.x },
    { i: 1, v: panelSize.y },
    { i: 2, v: panelSize.z },
  ].sort((a, b) => a.v - b.v);

  const thickness = axes[0].v;
  const thinAxisIdx = axes[0].i;
  const secondAxisIdx = axes.find(a => a.i !== longestAxisIdx && a.i !== thinAxisIdx)!.i;
  const secondLen = panelSize.getComponent(secondAxisIdx);

  const dims: [number, number, number] = [0, 0, 0];
  dims[thinAxisIdx] = thickness;
  dims[longestAxisIdx] = newLength;
  dims[secondAxisIdx] = secondLen;

  try {
    const { createReplicadBox, convertReplicadToThreeGeometry } = await import('./ReplicadService');
    const rp = await createReplicadBox({ width: dims[0], height: dims[1], depth: dims[2] });
    const geometry = convertReplicadToThreeGeometry(rp);

    const panelQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(...panelShape.rotation, 'XYZ')
    );
    const pivotVec = new THREE.Vector3(...pivot);

    // Compute the pivot's relative position on the secondary and thin axes.
    // When editing after a rebuild, panelShape.position is the rotated ORIGINAL center
    // but panelShape.geometry is the REBUILT geometry (different longest-axis dimension).
    // Using stepBasePosition/stepBaseRotation (the panel state before any rotation was applied)
    // gives the correct local pivot because secondary/thin dims never change during rebuild.
    const refPos = stepBasePosition ?? panelShape.position;
    const refRot = stepBaseRotation ?? panelShape.rotation;
    const refQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...refRot, 'XYZ'));
    const refMatrix = new THREE.Matrix4().compose(
      new THREE.Vector3(...refPos),
      refQuat,
      new THREE.Vector3(1, 1, 1)
    );
    const localPivotRef = pivotVec.clone().applyMatrix4(refMatrix.clone().invert());

    // relPivot on secondary/thin uses the reference-based local pivot.
    // Secondary/thin bbox centers are the same regardless of rebuild (dims unchanged).
    const relPivotSecond = localPivotRef.getComponent(secondAxisIdx) - secondLen * 0.5;
    const relPivotThin = localPivotRef.getComponent(thinAxisIdx) - thickness * 0.5;

    const newLocalPivot = new THREE.Vector3();
    newLocalPivot.setComponent(longestAxisIdx, directionSign === 1 ? 0 : newLength);
    newLocalPivot.setComponent(secondAxisIdx, secondLen * 0.5 + relPivotSecond);
    newLocalPivot.setComponent(thinAxisIdx, thickness * 0.5 + relPivotThin);

    // position = worldPivot - rotation * newLocalPivot
    const rotatedLocalPivot = newLocalPivot.clone().applyQuaternion(panelQuat);
    const newPos: [number, number, number] = [
      pivotVec.x - rotatedLocalPivot.x,
      pivotVec.y - rotatedLocalPivot.y,
      pivotVec.z - rotatedLocalPivot.z,
    ];

    updateShape(panelShape.id, {
      geometry,
      replicadShape: rp,
      position: newPos,
      rotation: panelShape.rotation,
      parameters: {
        ...panelShape.parameters,
        width: secondLen,
        height: newLength,
        autoExtendedLength: newLength,
        autoExtendDirSign: directionSign,
        autoExtendLongestAxisIdx: longestAxisIdx,
        baseReplicadShape: rp,
      },
    });
  } catch (err) {
    console.error('[PanelRotateService] Failed to rebuild panel geometry for auto-extend:', err);
  }
}

export async function executePanelRotate(params: PanelRotateParams): Promise<boolean> {
  const { panelShape, pivot, angleDeg, axis, shapes, updateShape } = params;

  if (Math.abs(angleDeg) < 0.001) return false;

  // Use the panel's current actual position as the base for the new step.
  // If a prior rotation already rebuilt the geometry (moving the origin from P0 to P1),
  // replaying from P0 would produce the wrong position for step2. Starting from the
  // actual current state (P1) is always correct.
  const currentPosition = [...panelShape.position] as [number, number, number];
  const currentRotation = [...panelShape.rotation] as [number, number, number];
  const existingSteps: RotateStep[] = panelShape.parameters?.rotateSteps || [];

  const newStep: RotateStep = {
    id: `rot-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
    pivot,
    angleDeg,
    axis,
    timestamp: Date.now(),
    stepBasePosition: currentPosition,
    stepBaseRotation: currentRotation,
  };

  const newSteps = [...existingSteps, newStep];
  // Apply only the new step from the current actual position (not all steps from P0).
  const result = applyRotateSteps(currentPosition, currentRotation, [newStep]);

  // Preserve the original P0/R0 base for backward-compat (used by fallback in updateRotateStep).
  const legacyBasePosition = computeBasePosition(panelShape);
  const legacyBaseRotation = computeBaseRotation(panelShape);

  updateShape(panelShape.id, {
    position: result.position,
    rotation: result.rotation,
    parameters: {
      ...panelShape.parameters,
      baseRotatePosition: legacyBasePosition,
      baseRotateRotation: legacyBaseRotation,
      rotateSteps: newSteps,
    },
  });

  const extendResult = computeAutoExtendLength(panelShape, result.position, result.rotation, pivot, shapes);
  if (extendResult !== null && extendResult.length > 1) {
    const updatedPanel: Shape = {
      ...panelShape,
      position: result.position,
      rotation: result.rotation,
      parameters: {
        ...panelShape.parameters,
        baseRotatePosition: legacyBasePosition,
        baseRotateRotation: legacyBaseRotation,
        rotateSteps: newSteps,
      },
    };
    await rebuildPanelGeometry(updatedPanel, extendResult.length, pivot, extendResult.directionSign, extendResult.longestAxisIdx, updateShape);
  }

  await rebuildSiblingsAfterRotate(panelShape, shapes);
  return true;
}

export async function updateRotateStep(
  panelShape: Shape,
  stepId: string,
  newAngleDeg: number,
  shapes: Shape[],
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  const steps: RotateStep[] = panelShape.parameters?.rotateSteps || [];
  const newSteps = steps.map(s => s.id === stepId ? { ...s, angleDeg: newAngleDeg } : s);
  const updatedStep = newSteps.find(s => s.id === stepId)!;

  const stepBase = (updatedStep.stepBasePosition ?? computeBasePosition(panelShape)) as [number, number, number];
  const stepBaseRot = (updatedStep.stepBaseRotation ?? computeBaseRotation(panelShape)) as [number, number, number];
  const result = applyRotateSteps(stepBase, stepBaseRot, [updatedStep]);

  const pivotForExtend: [number, number, number] = updatedStep.pivot;

  // During edit, panelShape.geometry may be a REBUILT geometry (different dimensions than original)
  // but result.position was computed from the ORIGINAL position (stepBase). This mismatch causes
  // computeAutoExtendLength's centroid-based direction detection to pick the wrong sign.
  // Use stored direction/axis from the first successful rebuild when available.
  const storedDirSign = panelShape.parameters?.autoExtendDirSign as number | undefined;
  const storedLongAxisIdx = panelShape.parameters?.autoExtendLongestAxisIdx as number | undefined;

  // Compute the extension length using OBB ray intersection with the correct direction.
  // If we have stored values, use computeAutoExtendLength but override the direction.
  // If not, fall back to full computation (first-time scenario).
  let extendLength: number | null = null;
  let dirSign = storedDirSign ?? 1;
  let longAxisIdx = storedLongAxisIdx ?? 0;

  if (storedDirSign != null && storedLongAxisIdx != null) {
    // We know the direction from the first rebuild. Shoot a ray from pivot in that direction
    // to find the correct length for the new rotation angle.
    const obbPlanes = getParentOBBPlanes(panelShape, shapes);
    if (obbPlanes) {
      const panelQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...result.rotation, 'XYZ'));
      const localDir = new THREE.Vector3(
        storedLongAxisIdx === 0 ? 1 : 0,
        storedLongAxisIdx === 1 ? 1 : 0,
        storedLongAxisIdx === 2 ? 1 : 0
      );
      const worldDir = localDir.clone().applyQuaternion(panelQuat).normalize()
        .multiplyScalar(storedDirSign);
      const pivotVec = new THREE.Vector3(...pivotForExtend);

      const dist = rayIntersectOBBPlanes(pivotVec, worldDir, obbPlanes);
      if (dist !== null && dist > 1) {
        // Check sibling collisions
        const parentId = panelShape.parameters?.parentShapeId;
        const siblings = shapes.filter(
          s => s.type === 'panel' &&
            s.parameters?.parentShapeId === parentId &&
            s.id !== panelShape.id &&
            s.geometry
        );
        let closestCollision = dist;
        for (const sib of siblings) {
          const sibAttr = sib.geometry!.getAttribute('position') as THREE.BufferAttribute;
          if (!sibAttr) continue;
          const sibBbox = new THREE.Box3().setFromBufferAttribute(sibAttr);
          const sibMat = new THREE.Matrix4().compose(
            new THREE.Vector3(...sib.position),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(...sib.rotation, 'XYZ')),
            new THREE.Vector3(...sib.scale)
          );
          const sibCorners: THREE.Vector3[] = [];
          const sMn = sibBbox.min;
          const sMx = sibBbox.max;
          for (let xi = 0; xi <= 1; xi++)
            for (let yi = 0; yi <= 1; yi++)
              for (let zi = 0; zi <= 1; zi++)
                sibCorners.push(new THREE.Vector3(
                  xi === 0 ? sMn.x : sMx.x,
                  yi === 0 ? sMn.y : sMx.y,
                  zi === 0 ? sMn.z : sMx.z
                ).applyMatrix4(sibMat));
          const sibWorldBbox = new THREE.Box3().setFromPoints(sibCorners);
          const expandedSibBbox = sibWorldBbox.clone().expandByScalar(0.5);
          if (expandedSibBbox.containsPoint(pivotVec)) continue;
          const sibHit = new THREE.Vector3();
          const sibRay = new THREE.Ray(pivotVec.clone(), worldDir.clone().normalize());
          if (sibRay.intersectBox(sibWorldBbox, sibHit)) {
            const sibDist = sibHit.distanceTo(pivotVec);
            if (sibDist > 0.5 && sibDist < closestCollision) {
              closestCollision = sibDist;
            }
          }
        }
        extendLength = closestCollision;
      }
    }
  } else {
    // No stored values — first time or legacy step. Use full computation.
    const extendResult = computeAutoExtendLength(panelShape, result.position, result.rotation, pivotForExtend, shapes);
    if (extendResult !== null && extendResult.length > 1) {
      extendLength = extendResult.length;
      dirSign = extendResult.directionSign;
      longAxisIdx = extendResult.longestAxisIdx;
    }
  }

  if (extendLength !== null && extendLength > 1) {
    const updatedPanel: Shape = {
      ...panelShape,
      position: result.position,
      rotation: result.rotation,
      parameters: { ...panelShape.parameters, rotateSteps: newSteps },
    };
    await rebuildPanelGeometry(updatedPanel, extendLength, pivotForExtend, dirSign, longAxisIdx, updateShape, stepBase, stepBaseRot);
  } else if (panelShape.parameters?.autoExtendedLength != null) {
    const fallbackLength = panelShape.parameters.autoExtendedLength as number;
    if (fallbackLength > 1) {
      const updatedPanel: Shape = {
        ...panelShape,
        position: result.position,
        rotation: result.rotation,
        parameters: { ...panelShape.parameters, rotateSteps: newSteps },
      };
      await rebuildPanelGeometry(updatedPanel, fallbackLength, pivotForExtend, dirSign, longAxisIdx, updateShape, stepBase, stepBaseRot);
    } else {
      updateShape(panelShape.id, {
        position: result.position,
        rotation: result.rotation,
        parameters: { ...panelShape.parameters, rotateSteps: newSteps },
      });
    }
  } else {
    updateShape(panelShape.id, {
      position: result.position,
      rotation: result.rotation,
      parameters: {
        ...panelShape.parameters,
        rotateSteps: newSteps,
      },
    });
  }

  await rebuildSiblingsAfterRotate(panelShape, shapes);
  return true;
}

export async function deleteRotateStep(
  panelShape: Shape,
  stepId: string,
  shapes: Shape[],
  updateShape: (id: string, updates: Partial<Shape>) => void
): Promise<boolean> {
  const steps: RotateStep[] = panelShape.parameters?.rotateSteps || [];
  const deletedStep = steps.find(s => s.id === stepId);
  // Remove the deleted step and all subsequent steps (they were derived from it).
  const deletedIdx = steps.findIndex(s => s.id === stepId);
  const newSteps = deletedIdx >= 0 ? steps.slice(0, deletedIdx) : steps.filter(s => s.id !== stepId);

  // Restore to the state that existed immediately before the deleted step was applied.
  const restorePos = (deletedStep?.stepBasePosition ?? computeBasePosition(panelShape)) as [number, number, number];
  const restoreRot = (deletedStep?.stepBaseRotation ?? computeBaseRotation(panelShape)) as [number, number, number];

  updateShape(panelShape.id, {
    position: restorePos,
    rotation: restoreRot,
    parameters: {
      ...panelShape.parameters,
      rotateSteps: newSteps,
      autoExtendedLength: undefined,
    },
  });

  await rebuildSiblingsAfterRotate(panelShape, shapes);
  return true;
}

export function getPanelNormalAxis(panelShape: Shape): [number, number, number] {
  if (!panelShape.geometry) return [0, 0, 1];
  const pos = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return [0, 0, 1];

  const bbox = new THREE.Box3().setFromBufferAttribute(pos);
  const size = new THREE.Vector3();
  bbox.getSize(size);

  const axes = [
    { i: 0, v: size.x },
    { i: 1, v: size.y },
    { i: 2, v: size.z },
  ].sort((a, b) => a.v - b.v);

  const thinAxis = axes[0].i;
  const localNormal = new THREE.Vector3(
    thinAxis === 0 ? 1 : 0,
    thinAxis === 1 ? 1 : 0,
    thinAxis === 2 ? 1 : 0
  );

  const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...panelShape.rotation, 'XYZ'));
  localNormal.applyQuaternion(quat).normalize();

  return [localNormal.x, localNormal.y, localNormal.z];
}

async function rebuildSiblingsAfterRotate(
  rotatedPanel: Shape,
  shapes: Shape[]
): Promise<void> {
  const parentId = rotatedPanel.parameters?.parentShapeId;
  if (!parentId) return;

  const parentShape = shapes.find(s => s.id === parentId);
  if (!parentShape) return;

  try {
    const { useAppStore } = await import('../store');
    const store = useAppStore.getState();
    store.recalculateVirtualFacesForShape(parentId);

    const { rebuildPanelsForParent } = await import('./PanelRebuildService');
    await rebuildPanelsForParent(parentId);
  } catch (err) {
    console.error('[PanelRotateService] Failed to rebuild siblings after rotate:', err);
  }
}
