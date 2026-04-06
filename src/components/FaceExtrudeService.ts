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

function findMatchingReplicadFace(
  replicadShape: any,
  targetNormal: THREE.Vector3,
  targetCenter: THREE.Vector3
): any | null {
  const faces = replicadShape.faces;
  if (!faces || faces.length === 0) return null;

  interface Candidate {
    face: any;
    dot: number;
    center: THREE.Vector3;
    dist: number;
  }

  const candidates: Candidate[] = [];

  for (let i = 0; i < faces.length; i++) {
    const face = faces[i];
    try {
      const normalVec = face.normalAt(0.5, 0.5);
      const faceNormal = new THREE.Vector3(normalVec.x, normalVec.y, normalVec.z);
      const dot = faceNormal.dot(targetNormal);

      if (dot < 0.7) continue;

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
        continue;
      }

      const dist = center.distanceTo(targetCenter);
      candidates.push({ face, dot, center, dist });
    } catch {
      continue;
    }
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].face;

  candidates.sort((a, b) => a.dist - b.dist);
  return candidates[0].face;
}

function computeExtrudeVector(
  faceNormal: THREE.Vector3,
  extrudeAmount: number
): [number, number, number] {
  return [
    faceNormal.x * extrudeAmount,
    faceNormal.y * extrudeAmount,
    faceNormal.z * extrudeAmount,
  ];
}

export async function executeFaceExtrude(params: FaceExtrudeParams): Promise<boolean> {
  const { panelShape, faceGroupIndex, value, isFixed, updateShape } = params;

  if (!panelShape.geometry || !panelShape.replicadShape) return false;

  const faces = extractFacesFromGeometry(panelShape.geometry);
  const groups = groupCoplanarFaces(faces);

  if (faceGroupIndex < 0 || faceGroupIndex >= groups.length) return false;

  const selectedGroup = groups[faceGroupIndex];
  const faceNormal = selectedGroup.normal.clone().normalize();
  const faceCenter = selectedGroup.center.clone();

  let extrudeAmount: number;
  if (isFixed) {
    const box = new THREE.Box3().setFromBufferAttribute(
      panelShape.geometry.getAttribute('position') as THREE.BufferAttribute
    );
    const size = new THREE.Vector3();
    box.getSize(size);

    const absX = Math.abs(faceNormal.x);
    const absY = Math.abs(faceNormal.y);
    const absZ = Math.abs(faceNormal.z);

    let currentDimension: number;
    if (absX >= absY && absX >= absZ) {
      currentDimension = size.x;
    } else if (absY >= absX && absY >= absZ) {
      currentDimension = size.y;
    } else {
      currentDimension = size.z;
    }

    extrudeAmount = value - currentDimension;
  } else {
    extrudeAmount = value;
  }

  if (Math.abs(extrudeAmount) < 0.01) return false;

  try {
    const { convertReplicadToThreeGeometry, initReplicad } = await import('./ReplicadService');

    const oc = await initReplicad();

    const matchingFace = findMatchingReplicadFace(
      panelShape.replicadShape,
      faceNormal,
      faceCenter
    );

    if (!matchingFace) {
      console.error('No matching replicad face found for extrusion');
      return false;
    }

    const extVec = computeExtrudeVector(faceNormal, extrudeAmount);
    const ocVec = new oc.gp_Vec_4(extVec[0], extVec[1], extVec[2]);

    const prismBuilder = new oc.BRepPrimAPI_MakePrism_1(
      matchingFace.wrapped,
      ocVec,
      false,
      true
    );
    prismBuilder.Build(new oc.Message_ProgressRange_1());
    const extrudedSolid = prismBuilder.Shape();

    const { cast } = await import('replicad');
    const extrudedShape = cast(extrudedSolid);

    let finalShape: any;
    if (extrudeAmount > 0) {
      finalShape = panelShape.replicadShape.fuse(extrudedShape);
    } else {
      finalShape = panelShape.replicadShape.cut(extrudedShape);
    }

    const newGeometry = convertReplicadToThreeGeometry(finalShape);

    const newBox = new THREE.Box3().setFromBufferAttribute(
      newGeometry.getAttribute('position') as THREE.BufferAttribute
    );
    const newSize = new THREE.Vector3();
    newBox.getSize(newSize);

    const newWidth = Math.round(newSize.x * 10) / 10;
    const newHeight = Math.round(newSize.y * 10) / 10;
    const newDepth = Math.round(newSize.z * 10) / 10;

    updateShape(panelShape.id, {
      geometry: newGeometry,
      replicadShape: finalShape,
      parameters: {
        ...panelShape.parameters,
        width: newWidth,
        height: newHeight,
        depth: newDepth,
      },
    });

    return true;
  } catch (error) {
    console.error('Face extrude failed:', error);
    return false;
  }
}
