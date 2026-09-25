import React, { useMemo } from 'react';
import * as THREE from 'three';
import {
  getFacesAndGroups,
  createGroupBoundaryEdges,
  createFaceDescriptor
} from './GeometryUtils';
import { convertReplicadToThreeGeometry } from './ReplicadService';

export interface FilletData {
  face1Descriptor: any;
  face2Descriptor: any;
  face1Data: { normal: [number, number, number]; center: [number, number, number]; planeD?: number };
  face2Data: { normal: [number, number, number]; center: [number, number, number]; planeD?: number };
  radius: number;
  originalSize: {
    width: number;
    height: number;
    depth: number;
  };
}

export async function applyFilletToShape(
  shape: any,
  selectedFilletFaces: number[],
  selectedFilletFaceData: any[],
  radius: number
): Promise<{ geometry: THREE.BufferGeometry; replicadShape: any; filletData: FilletData }> {
  if (!shape || !shape.replicadShape) {
    throw new Error('Shape or replicadShape not found');
  }

  if (selectedFilletFaces.length !== 2 || selectedFilletFaceData.length !== 2) {
    throw new Error('Two faces must be selected for fillet operation');
  }

  const face1Center = new THREE.Vector3(...selectedFilletFaceData[0].center);
  const face2Center = new THREE.Vector3(...selectedFilletFaceData[1].center);
  const face1Normal = new THREE.Vector3(...selectedFilletFaceData[0].normal);
  const face2Normal = new THREE.Vector3(...selectedFilletFaceData[1].normal);

  const face1PlaneD = selectedFilletFaceData[0].planeD !== undefined
    ? selectedFilletFaceData[0].planeD
    : face1Normal.dot(face1Center);
  const face2PlaneD = selectedFilletFaceData[1].planeD !== undefined
    ? selectedFilletFaceData[1].planeD
    : face2Normal.dot(face2Center);

  const { faces, groups: faceGroups } = getFacesAndGroups(shape.geometry);
  const group1 = faceGroups[selectedFilletFaces[0]];
  const group2 = faceGroups[selectedFilletFaces[1]];

  const face1Data = faces.find(f => group1.faceIndices.includes(f.faceIndex));
  const face2Data = faces.find(f => group2.faceIndices.includes(f.faceIndex));

  if (!face1Data || !face2Data) {
    throw new Error('Could not find face data for descriptors');
  }

  const face1Descriptor = createFaceDescriptor(face1Data, shape.geometry);
  const face2Descriptor = createFaceDescriptor(face2Data, shape.geometry);

  let replicadShape = shape.replicadShape;

  const filletedShape = replicadShape.fillet((edge: any) => {
    try {
      const start = edge.startPoint;
      const end = edge.endPoint;

      if (!start || !end) return null;

      const startVec = new THREE.Vector3(start.x, start.y, start.z);
      const endVec = new THREE.Vector3(end.x, end.y, end.z);
      const centerVec = new THREE.Vector3(
        (start.x + end.x) / 2,
        (start.y + end.y) / 2,
        (start.z + end.z) / 2
      );

      const maxDimension = Math.max(shape.parameters.width || 1, shape.parameters.height || 1, shape.parameters.depth || 1);
      const tolerance = maxDimension * 0.08;

      const startDistFace1 = Math.abs(face1Normal.dot(startVec) - face1PlaneD);
      const startDistFace2 = Math.abs(face2Normal.dot(startVec) - face2PlaneD);
      const endDistFace1 = Math.abs(face1Normal.dot(endVec) - face1PlaneD);
      const endDistFace2 = Math.abs(face2Normal.dot(endVec) - face2PlaneD);
      const centerDistFace1 = Math.abs(face1Normal.dot(centerVec) - face1PlaneD);
      const centerDistFace2 = Math.abs(face2Normal.dot(centerVec) - face2PlaneD);

      const allPointsOnFace1 = startDistFace1 < tolerance && endDistFace1 < tolerance && centerDistFace1 < tolerance;
      const allPointsOnFace2 = startDistFace2 < tolerance && endDistFace2 < tolerance && centerDistFace2 < tolerance;

      if (allPointsOnFace1 && allPointsOnFace2) {
        return radius;
      }

      return null;
    } catch (e) {
      console.error('Error checking edge:', e);
      return null;
    }
  });

  const newGeometry = convertReplicadToThreeGeometry(filletedShape);

  const filletData: FilletData = {
    face1Descriptor,
    face2Descriptor,
    face1Data: selectedFilletFaceData[0],
    face2Data: selectedFilletFaceData[1],
    radius,
    originalSize: {
      width: shape.parameters.width || 1,
      height: shape.parameters.height || 1,
      depth: shape.parameters.depth || 1
    }
  };

  return {
    geometry: newGeometry,
    replicadShape: filletedShape,
    filletData
  };
}

interface FilletEdgeLinesProps {
  shape: any;
  isSelected: boolean;
}

export const FilletEdgeLines: React.FC<FilletEdgeLinesProps> = ({ shape }) => {
  const boundaryEdgesGeometry = useMemo(() => {
    if (!shape.geometry) return null;
    const { faces, groups } = getFacesAndGroups(shape.geometry);
    return createGroupBoundaryEdges(faces, groups);
  }, [shape.geometry]);

  if (!boundaryEdgesGeometry) return null;

  return (
    <lineSegments geometry={boundaryEdgesGeometry}>
      <lineBasicMaterial
        color="#000000"
        linewidth={2}
        opacity={1}
        transparent={false}
        depthTest={true}
      />
    </lineSegments>
  );
};
