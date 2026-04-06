import * as THREE from 'three';
import type { Shape } from '../store';
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

interface ExtrudeAxis {
  axisIndex: number;
  sign: number;
  currentSize: number;
  boxMin: number;
  boxMax: number;
}

function resolveExtrudeAxis(
  faceGroupNormal: THREE.Vector3,
  geometry: THREE.BufferGeometry
): ExtrudeAxis | null {
  const absX = Math.abs(faceGroupNormal.x);
  const absY = Math.abs(faceGroupNormal.y);
  const absZ = Math.abs(faceGroupNormal.z);

  const box = new THREE.Box3().setFromBufferAttribute(
    geometry.getAttribute('position') as THREE.BufferAttribute
  );

  if (absX >= absY && absX >= absZ) {
    const sign = faceGroupNormal.x > 0 ? 1 : -1;
    return {
      axisIndex: 0, sign,
      currentSize: box.max.x - box.min.x,
      boxMin: box.min.x, boxMax: box.max.x,
    };
  } else if (absY >= absX && absY >= absZ) {
    const sign = faceGroupNormal.y > 0 ? 1 : -1;
    return {
      axisIndex: 1, sign,
      currentSize: box.max.y - box.min.y,
      boxMin: box.min.y, boxMax: box.max.y,
    };
  } else {
    const sign = faceGroupNormal.z > 0 ? 1 : -1;
    return {
      axisIndex: 2, sign,
      currentSize: box.max.z - box.min.z,
      boxMin: box.min.z, boxMax: box.max.z,
    };
  }
}

function findMatchingReplicadFace(
  replicadShape: any,
  targetNormal: THREE.Vector3,
  targetCenter: THREE.Vector3,
  faces: any[]
): any | null {
  let bestFace: any = null;
  let bestDist = Infinity;

  for (const face of faces) {
    try {
      const fNormal = face.normalAt();
      const fCenter = face.center;

      const n = new THREE.Vector3(fNormal.x, fNormal.y, fNormal.z).normalize();
      const dot = n.dot(targetNormal);

      if (dot < 0.9) continue;

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

export async function executeFaceExtrude(params: FaceExtrudeParams): Promise<boolean> {
  const { panelShape, faceGroupIndex, value, isFixed, updateShape } = params;

  if (!panelShape.geometry || !panelShape.replicadShape) return false;

  const meshFaces = extractFacesFromGeometry(panelShape.geometry);
  const groups = groupCoplanarFaces(meshFaces);

  if (faceGroupIndex < 0 || faceGroupIndex >= groups.length) return false;

  const selectedGroup = groups[faceGroupIndex];
  const faceNormal = selectedGroup.normal.clone().normalize();

  const axis = resolveExtrudeAxis(faceNormal, panelShape.geometry);
  if (!axis) return false;

  const delta = isFixed ? value - axis.currentSize : value;
  if (Math.abs(delta) < 1e-6) return false;

  const faceCenter = computeFaceGroupCenter(
    panelShape.geometry,
    selectedGroup.faceIndices
  );

  try {
    const { convertReplicadToThreeGeometry, initReplicad } = await import('./ReplicadService');
    const { getReplicadVertices } = await import('./VertexEditorService');

    const oc = await initReplicad();

    const replicadFaces = panelShape.replicadShape.faces;
    const matchingFace = findMatchingReplicadFace(
      panelShape.replicadShape,
      faceNormal,
      faceCenter,
      replicadFaces
    );

    if (!matchingFace) {
      console.error('Could not find matching replicad face');
      return false;
    }

    const extrudeVec = new oc.gp_Vec_4(
      faceNormal.x * delta,
      faceNormal.y * delta,
      faceNormal.z * delta
    );

    const prismBuilder = new oc.BRepPrimAPI_MakePrism_1(
      matchingFace.wrapped,
      extrudeVec,
      false,
      true
    );
    prismBuilder.Build(new oc.Message_ProgressRange_1());
    const prismShape = prismBuilder.Shape();

    const { cast } = await import('replicad');
    const prismSolid = cast(prismShape);

    let finalShape: any;
    if (delta > 0) {
      finalShape = panelShape.replicadShape.fuse(prismSolid);
    } else {
      finalShape = panelShape.replicadShape.cut(prismSolid);
    }

    let newGeometry = convertReplicadToThreeGeometry(finalShape);
    const newVertices = await getReplicadVertices(finalShape);

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
        width: newBoxSize.x,
        height: newBoxSize.y,
        depth: newBoxSize.z,
      });
      newGeometry = convertReplicadToThreeGeometry(finalShape);
    }

    updateShape(panelShape.id, {
      geometry: newGeometry,
      replicadShape: finalShape,
      fillets: updatedFillets,
      parameters: {
        ...panelShape.parameters,
        width: newBoxSize.x,
        height: newBoxSize.y,
        depth: newBoxSize.z,
        scaledBaseVertices: newVertices.map((v: THREE.Vector3) => [v.x, v.y, v.z]),
      },
    });

    return true;
  } catch (error) {
    console.error('Face extrude failed:', error);
    return false;
  }
}
