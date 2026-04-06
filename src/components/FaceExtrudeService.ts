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
  dimensionKey: 'x' | 'y' | 'z';
  currentSize: number;
  faceMin: number;
  faceMax: number;
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
      axisIndex: 0,
      sign,
      dimensionKey: 'x',
      currentSize: box.max.x - box.min.x,
      faceMin: sign > 0 ? box.max.x : box.min.x,
      faceMax: sign > 0 ? box.max.x : box.min.x,
      boxMin: box.min.x,
      boxMax: box.max.x,
    };
  } else if (absY >= absX && absY >= absZ) {
    const sign = faceGroupNormal.y > 0 ? 1 : -1;
    return {
      axisIndex: 1,
      sign,
      dimensionKey: 'y',
      currentSize: box.max.y - box.min.y,
      faceMin: sign > 0 ? box.max.y : box.min.y,
      faceMax: sign > 0 ? box.max.y : box.min.y,
      boxMin: box.min.y,
      boxMax: box.max.y,
    };
  } else {
    const sign = faceGroupNormal.z > 0 ? 1 : -1;
    return {
      axisIndex: 2,
      sign,
      dimensionKey: 'z',
      currentSize: box.max.z - box.min.z,
      faceMin: sign > 0 ? box.max.z : box.min.z,
      faceMax: sign > 0 ? box.max.z : box.min.z,
      boxMin: box.min.z,
      boxMax: box.max.z,
    };
  }
}

export async function executeFaceExtrude(params: FaceExtrudeParams): Promise<boolean> {
  const { panelShape, faceGroupIndex, value, isFixed, updateShape } = params;

  if (!panelShape.geometry || !panelShape.replicadShape) return false;

  const faces = extractFacesFromGeometry(panelShape.geometry);
  const groups = groupCoplanarFaces(faces);

  if (faceGroupIndex < 0 || faceGroupIndex >= groups.length) return false;

  const selectedGroup = groups[faceGroupIndex];
  const faceNormal = selectedGroup.normal.clone().normalize();

  const axis = resolveExtrudeAxis(faceNormal, panelShape.geometry);
  if (!axis) return false;

  let delta: number;
  if (isFixed) {
    delta = value - axis.currentSize;
  } else {
    delta = value;
  }

  const newSize = axis.currentSize + delta;
  if (newSize < 0.1) return false;

  const anchorPos = axis.sign > 0 ? axis.boxMin : axis.boxMax;
  const newFacePos = anchorPos + (axis.sign > 0 ? newSize : -newSize);
  const newMin = Math.min(anchorPos, newFacePos);
  const newMax = Math.max(anchorPos, newFacePos);

  const oldBox = new THREE.Box3().setFromBufferAttribute(
    panelShape.geometry.getAttribute('position') as THREE.BufferAttribute
  );
  const oldSize = new THREE.Vector3();
  oldBox.getSize(oldSize);

  const newWidth = axis.axisIndex === 0 ? newSize : oldSize.x;
  const newHeight = axis.axisIndex === 1 ? newSize : oldSize.y;
  const newDepth = axis.axisIndex === 2 ? newSize : oldSize.z;

  try {
    const { convertReplicadToThreeGeometry, initReplicad } = await import('./ReplicadService');
    const { getReplicadVertices } = await import('./VertexEditorService');
    const { draw } = await import('replicad');

    await initReplicad();

    const corners: [number, number, number][] = [
      [axis.axisIndex === 0 ? newMin : oldBox.min.x, axis.axisIndex === 1 ? newMin : oldBox.min.y, axis.axisIndex === 2 ? newMin : oldBox.min.z],
      [axis.axisIndex === 0 ? newMax : oldBox.max.x, axis.axisIndex === 1 ? newMax : oldBox.max.y, axis.axisIndex === 2 ? newMax : oldBox.max.z],
    ];

    const minC = corners[0];
    const maxC = corners[1];

    const w = maxC[0] - minC[0];
    const h = maxC[1] - minC[1];
    const d = maxC[2] - minC[2];

    const boxSketch = draw()
      .movePointerTo([minC[0], minC[1]])
      .lineTo([minC[0] + w, minC[1]])
      .lineTo([minC[0] + w, minC[1] + h])
      .lineTo([minC[0], minC[1] + h])
      .close()
      .sketchOnPlane('XY', minC[2])
      .extrude(d);

    let finalShape = boxSketch;
    let newGeometry = convertReplicadToThreeGeometry(finalShape);
    const newVertices = await getReplicadVertices(finalShape);

    let updatedFillets = panelShape.fillets || [];
    if (updatedFillets.length > 0) {
      const { updateFilletCentersForNewGeometry, applyFillets } = await import('./ShapeUpdaterService');
      updatedFillets = await updateFilletCentersForNewGeometry(
        updatedFillets,
        newGeometry,
        { width: newWidth, height: newHeight, depth: newDepth }
      );
      finalShape = await applyFillets(finalShape, updatedFillets, {
        width: newWidth,
        height: newHeight,
        depth: newDepth,
      });
      newGeometry = convertReplicadToThreeGeometry(finalShape);
    }

    updateShape(panelShape.id, {
      geometry: newGeometry,
      replicadShape: finalShape,
      fillets: updatedFillets,
      parameters: {
        ...panelShape.parameters,
        width: newWidth,
        height: newHeight,
        depth: newDepth,
        scaledBaseVertices: newVertices.map((v: THREE.Vector3) => [v.x, v.y, v.z]),
      },
    });

    return true;
  } catch (error) {
    console.error('Face extrude failed:', error);
    return false;
  }
}
