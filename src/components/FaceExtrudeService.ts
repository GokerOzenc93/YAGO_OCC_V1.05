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

function nonUniformScaleShape(
  oc: any,
  wrappedShape: any,
  anchorPos: number,
  scaleFactor: number,
  axisIndex: number
): any {
  const sx = axisIndex === 0 ? scaleFactor : 1;
  const sy = axisIndex === 1 ? scaleFactor : 1;
  const sz = axisIndex === 2 ? scaleFactor : 1;

  const tx = axisIndex === 0 ? anchorPos * (1 - scaleFactor) : 0;
  const ty = axisIndex === 1 ? anchorPos * (1 - scaleFactor) : 0;
  const tz = axisIndex === 2 ? anchorPos * (1 - scaleFactor) : 0;

  const mat = new oc.gp_Mat_2(
    sx, 0, 0,
    0, sy, 0,
    0, 0, sz
  );
  const translationVec = new oc.gp_XYZ_2(tx, ty, tz);
  const gTrsf = new oc.gp_GTrsf_3(mat, translationVec);

  const transformer = new oc.BRepBuilderAPI_GTransform_2(wrappedShape, gTrsf, true);
  transformer.Build(new oc.Message_ProgressRange_1());
  return transformer.Shape();
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

  const delta = isFixed ? value - axis.currentSize : value;
  const newSize = axis.currentSize + delta;
  if (newSize < 0.1) return false;

  const scaleFactor = newSize / axis.currentSize;
  if (Math.abs(scaleFactor - 1) < 1e-9) return false;

  const anchorPos = axis.sign > 0 ? axis.boxMin : axis.boxMax;

  try {
    const { convertReplicadToThreeGeometry, initReplicad } = await import('./ReplicadService');
    const { getReplicadVertices } = await import('./VertexEditorService');
    const { cast } = await import('replicad');

    const oc = await initReplicad();

    const transformedOcShape = nonUniformScaleShape(
      oc,
      panelShape.replicadShape.wrapped,
      anchorPos,
      scaleFactor,
      axis.axisIndex
    );

    let finalShape = cast(transformedOcShape);
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
