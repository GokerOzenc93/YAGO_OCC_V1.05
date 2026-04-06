import * as THREE from 'three';
import type { Shape, FaceExtrudeOperation } from '../store';
import {
  extractFacesFromGeometry,
  groupCoplanarFaces,
} from './GeometryUtils';

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

function computeFaceGroupCenter(
  geometry: THREE.BufferGeometry,
  faceIndices: number[]
): THREE.Vector3 {
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
  const indexAttr = geometry.getIndex();
  const center = new THREE.Vector3();
  let count = 0;

  for (const fi of faceIndices) {
    for (let v = 0; v < 3; v++) {
      const idx = indexAttr ? indexAttr.getX(fi * 3 + v) : fi * 3 + v;
      center.x += posAttr.getX(idx);
      center.y += posAttr.getY(idx);
      center.z += posAttr.getZ(idx);
      count++;
    }
  }

  if (count > 0) center.divideScalar(count);
  return center;
}

export function addFaceExtrudeOperation(params: FaceExtrudeParams): FaceExtrudeOperation | null {
  const { panelShape, faceGroupIndex, value, isFixed } = params;
  if (!panelShape.geometry) return null;

  const meshFaces = extractFacesFromGeometry(panelShape.geometry);
  const groups = groupCoplanarFaces(meshFaces);
  if (faceGroupIndex < 0 || faceGroupIndex >= groups.length) return null;

  const selectedGroup = groups[faceGroupIndex];
  const faceNormal = selectedGroup.normal.clone().normalize();
  const faceCenter = computeFaceGroupCenter(panelShape.geometry, selectedGroup.faceIndices);

  return {
    id: `fext-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    faceNormal: [faceNormal.x, faceNormal.y, faceNormal.z],
    faceCenter: [faceCenter.x, faceCenter.y, faceCenter.z],
    axisLabel: getAxisLabel(faceNormal),
    value,
    isFixed,
  };
}

function findMatchingReplicadFace(
  targetNormal: THREE.Vector3,
  targetCenter: THREE.Vector3,
  faces: any[]
): any | null {
  let bestFace: any = null;
  let bestDist = Infinity;

  for (const face of faces) {
    try {
      const fNormal = face.normalAt();
      const n = new THREE.Vector3(fNormal.x, fNormal.y, fNormal.z).normalize();
      if (n.dot(targetNormal) < 0.9) continue;

      const fCenter = face.center;
      const c = new THREE.Vector3(fCenter.x, fCenter.y, fCenter.z);
      const dist = c.distanceTo(targetCenter);
      if (dist < bestDist) {
        bestDist = dist;
        bestFace = face;
      }
    } catch {
      continue;
    }
  }

  return bestFace;
}

function getAxisSize(geometry: THREE.BufferGeometry, normal: THREE.Vector3): number {
  const box = new THREE.Box3().setFromBufferAttribute(
    geometry.getAttribute('position') as THREE.BufferAttribute
  );
  const absX = Math.abs(normal.x);
  const absY = Math.abs(normal.y);
  const absZ = Math.abs(normal.z);
  if (absX >= absY && absX >= absZ) return box.max.x - box.min.x;
  if (absY >= absX && absY >= absZ) return box.max.y - box.min.y;
  return box.max.z - box.min.z;
}

export async function applyAllFaceExtrudeOperations(
  replicadShape: any,
  operations: FaceExtrudeOperation[],
  currentGeometry: THREE.BufferGeometry
): Promise<{ shape: any; geometry: THREE.BufferGeometry } | null> {
  if (!operations || operations.length === 0) return null;

  const { convertReplicadToThreeGeometry, initReplicad } = await import('./ReplicadService');
  const { cast } = await import('replicad');
  const oc = await initReplicad();

  let currentShape = replicadShape;
  let currentGeo = currentGeometry;

  for (const op of operations) {
    try {
      const normal = new THREE.Vector3(...op.faceNormal);
      const center = new THREE.Vector3(...op.faceCenter);

      const replicadFaces = currentShape.faces;
      const matchingFace = findMatchingReplicadFace(normal, center, replicadFaces);

      if (!matchingFace) continue;

      const axisSize = getAxisSize(currentGeo, normal);
      const delta = op.isFixed ? op.value - axisSize : op.value;
      if (Math.abs(delta) < 1e-6) continue;

      const extrudeVec = new oc.gp_Vec_4(
        normal.x * delta,
        normal.y * delta,
        normal.z * delta
      );

      const prismBuilder = new oc.BRepPrimAPI_MakePrism_1(
        matchingFace.wrapped,
        extrudeVec,
        false,
        true
      );
      prismBuilder.Build(new oc.Message_ProgressRange_1());
      const prismOcShape = prismBuilder.Shape();
      const prismSolid = cast(prismOcShape);

      if (delta > 0) {
        currentShape = currentShape.fuse(prismSolid);
      } else {
        currentShape = currentShape.cut(prismSolid);
      }

      currentGeo = convertReplicadToThreeGeometry(currentShape);
    } catch (err) {
      console.error('Face extrude operation failed for op:', op.id, err);
      continue;
    }
  }

  return { shape: currentShape, geometry: currentGeo };
}

export async function executeFaceExtrude(params: FaceExtrudeParams): Promise<boolean> {
  const { panelShape, faceGroupIndex, value, isFixed, updateShape } = params;
  if (!panelShape.geometry || !panelShape.replicadShape) return false;

  const operation = addFaceExtrudeOperation(params);
  if (!operation) return false;

  const existingOps = panelShape.faceExtrudeOperations || [];
  const allOps = [...existingOps, operation];

  const baseShape = panelShape.parameters?.originalReplicadShape || panelShape.replicadShape;

  const result = await applyAllFaceExtrudeOperations(
    baseShape,
    allOps,
    panelShape.geometry
  );

  if (!result) return false;

  const { convertReplicadToThreeGeometry } = await import('./ReplicadService');

  let finalShape = result.shape;
  let newGeometry = result.geometry;

  const newBox = new THREE.Box3().setFromBufferAttribute(
    newGeometry.getAttribute('position') as THREE.BufferAttribute
  );
  const newBoxSize = new THREE.Vector3();
  newBox.getSize(newBoxSize);

  let updatedFillets = panelShape.fillets || [];
  if (updatedFillets.length > 0) {
    const { updateFilletCentersForNewGeometry, applyFillets } = await import('./ShapeUpdaterService');
    updatedFillets = await updateFilletCentersForNewGeometry(
      updatedFillets,
      newGeometry,
      { width: newBoxSize.x, height: newBoxSize.y, depth: newBoxSize.z }
    );
    finalShape = await applyFillets(finalShape, updatedFillets, {
      width: newBoxSize.x, height: newBoxSize.y, depth: newBoxSize.z,
    });
    newGeometry = convertReplicadToThreeGeometry(finalShape);
  }

  updateShape(panelShape.id, {
    geometry: newGeometry,
    replicadShape: finalShape,
    fillets: updatedFillets,
    faceExtrudeOperations: allOps,
    parameters: {
      ...panelShape.parameters,
      width: newBoxSize.x,
      height: newBoxSize.y,
      depth: newBoxSize.z,
    },
  });

  return true;
}
