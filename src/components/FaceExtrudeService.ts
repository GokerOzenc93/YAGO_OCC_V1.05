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

interface AxisExtrudeInfo {
  normal: THREE.Vector3;
  axisIndex: number;
  sign: number;
  currentDimension: number;
  dimensionKey: 'width' | 'height' | 'depth';
  facePosition: number;
  oppositePosition: number;
}

function getAxisExtrudeInfo(
  faceGroupNormal: THREE.Vector3,
  geometry: THREE.BufferGeometry,
  params: { width: number; height: number; depth: number }
): AxisExtrudeInfo | null {
  const absX = Math.abs(faceGroupNormal.x);
  const absY = Math.abs(faceGroupNormal.y);
  const absZ = Math.abs(faceGroupNormal.z);

  const box = new THREE.Box3().setFromBufferAttribute(
    geometry.getAttribute('position') as THREE.BufferAttribute
  );

  let axisIndex: number;
  let sign: number;
  let dimensionKey: 'width' | 'height' | 'depth';
  let facePosition: number;
  let oppositePosition: number;

  if (absX > absY && absX > absZ) {
    axisIndex = 0;
    sign = faceGroupNormal.x > 0 ? 1 : -1;
    dimensionKey = 'width';
    facePosition = sign > 0 ? box.max.x : box.min.x;
    oppositePosition = sign > 0 ? box.min.x : box.max.x;
  } else if (absY > absX && absY > absZ) {
    axisIndex = 1;
    sign = faceGroupNormal.y > 0 ? 1 : -1;
    dimensionKey = 'height';
    facePosition = sign > 0 ? box.max.y : box.min.y;
    oppositePosition = sign > 0 ? box.min.y : box.max.y;
  } else {
    axisIndex = 2;
    sign = faceGroupNormal.z > 0 ? 1 : -1;
    dimensionKey = 'depth';
    facePosition = sign > 0 ? box.max.z : box.min.z;
    oppositePosition = sign > 0 ? box.min.z : box.max.z;
  }

  const currentDimension = Math.abs(facePosition - oppositePosition);

  return {
    normal: faceGroupNormal.clone().normalize(),
    axisIndex,
    sign,
    currentDimension,
    dimensionKey,
    facePosition,
    oppositePosition,
  };
}

function calculateNewDimension(
  info: AxisExtrudeInfo,
  value: number,
  isFixed: boolean
): { newDimension: number; positionShift: number } {
  if (isFixed) {
    const newDimension = Math.max(1, value);
    const delta = newDimension - info.currentDimension;
    const positionShift = (delta / 2) * info.sign;
    return { newDimension, positionShift };
  } else {
    const newDimension = Math.max(1, info.currentDimension + value);
    const positionShift = (value / 2) * info.sign;
    return { newDimension, positionShift };
  }
}

export async function executeFaceExtrude(params: FaceExtrudeParams): Promise<boolean> {
  const { panelShape, faceGroupIndex, value, isFixed, updateShape } = params;

  if (!panelShape.geometry) return false;

  const faces = extractFacesFromGeometry(panelShape.geometry);
  const groups = groupCoplanarFaces(faces);

  if (faceGroupIndex < 0 || faceGroupIndex >= groups.length) return false;

  const selectedGroup = groups[faceGroupIndex];
  const faceNormal = selectedGroup.normal.clone().normalize();

  const currentWidth = panelShape.parameters?.width || 1;
  const currentHeight = panelShape.parameters?.height || 1;
  const currentDepth = panelShape.parameters?.depth || 1;

  const axisInfo = getAxisExtrudeInfo(faceNormal, panelShape.geometry, {
    width: currentWidth,
    height: currentHeight,
    depth: currentDepth,
  });

  if (!axisInfo) return false;

  const { newDimension, positionShift } = calculateNewDimension(axisInfo, value, isFixed);

  if (newDimension <= 0) return false;

  const newParams = {
    width: currentWidth,
    height: currentHeight,
    depth: currentDepth,
  };
  newParams[axisInfo.dimensionKey] = newDimension;

  try {
    const { createReplicadBox, convertReplicadToThreeGeometry } = await import('./ReplicadService');
    const { getReplicadVertices } = await import('./VertexEditorService');

    let newReplicadShape = await createReplicadBox({
      width: newParams.width,
      height: newParams.height,
      depth: newParams.depth,
    });

    if (panelShape.subtractionGeometries && panelShape.subtractionGeometries.length > 0) {
      const { performBooleanCut } = await import('./ReplicadService');
      for (const sub of panelShape.subtractionGeometries) {
        if (!sub) continue;
        const subBox = await createReplicadBox({
          width: parseFloat(sub.parameters?.width || '0'),
          height: parseFloat(sub.parameters?.height || '0'),
          depth: parseFloat(sub.parameters?.depth || '0'),
        });
        newReplicadShape = await performBooleanCut(
          newReplicadShape,
          subBox,
          undefined,
          sub.relativeOffset,
          undefined,
          sub.relativeRotation || [0, 0, 0],
          undefined,
          sub.scale || [1, 1, 1]
        );
      }
    }

    let finalShape = newReplicadShape;
    let newGeometry = convertReplicadToThreeGeometry(finalShape);
    const newVertices = await getReplicadVertices(finalShape);

    let updatedFillets = panelShape.fillets || [];
    if (updatedFillets.length > 0) {
      const { updateFilletCentersForNewGeometry, applyFillets } = await import('./ShapeUpdaterService');
      updatedFillets = await updateFilletCentersForNewGeometry(
        updatedFillets,
        newGeometry,
        { width: newParams.width, height: newParams.height, depth: newParams.depth }
      );
      finalShape = await applyFillets(finalShape, updatedFillets, {
        width: newParams.width,
        height: newParams.height,
        depth: newParams.depth,
      });
      newGeometry = convertReplicadToThreeGeometry(finalShape);
    }

    const newPosition: [number, number, number] = [
      panelShape.position[0] + (axisInfo.axisIndex === 0 ? positionShift : 0),
      panelShape.position[1] + (axisInfo.axisIndex === 1 ? positionShift : 0),
      panelShape.position[2] + (axisInfo.axisIndex === 2 ? positionShift : 0),
    ];

    updateShape(panelShape.id, {
      geometry: newGeometry,
      replicadShape: finalShape,
      fillets: updatedFillets,
      position: newPosition,
      parameters: {
        ...panelShape.parameters,
        ...newParams,
        scaledBaseVertices: newVertices.map((v: THREE.Vector3) => [v.x, v.y, v.z]),
      },
    });

    return true;
  } catch (error) {
    console.error('Face extrude failed:', error);
    return false;
  }
}
