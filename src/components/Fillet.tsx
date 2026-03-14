import React, { useMemo } from 'react';
import * as THREE from 'three';
import {
  extractFacesFromGeometry,
  groupCoplanarFaces,
  createGroupBoundaryEdges,
  createFaceDescriptor
} from './FaceEditor';
import { convertReplicadToThreeGeometry } from './ReplicadService';
import { getReplicadVertices } from './VertexEditorService';

export interface FilletData {
  face1Descriptor: any;
  face2Descriptor: any;
  face1Data: any;
  face2Data: any;
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

  console.log(`🔵 Applying fillet with radius ${radius} to faces:`, selectedFilletFaces);
  console.log('📍 Fillet - Current shape position:', shape.position);

  console.log('📐 Face 1 - Normal:', selectedFilletFaceData[0].normal, 'Center:', selectedFilletFaceData[0].center);
  console.log('📐 Face 2 - Normal:', selectedFilletFaceData[1].normal, 'Center:', selectedFilletFaceData[1].center);

  const face1Center = new THREE.Vector3(...selectedFilletFaceData[0].center);
  const face2Center = new THREE.Vector3(...selectedFilletFaceData[1].center);
  const face1Normal = new THREE.Vector3(...selectedFilletFaceData[0].normal);
  const face2Normal = new THREE.Vector3(...selectedFilletFaceData[1].normal);

  const faces = extractFacesFromGeometry(shape.geometry);
  const faceGroups = groupCoplanarFaces(faces);
  const group1 = faceGroups[selectedFilletFaces[0]];
  const group2 = faceGroups[selectedFilletFaces[1]];

  const face1Data = faces.find(f => group1.faceIndices.includes(f.faceIndex));
  const face2Data = faces.find(f => group2.faceIndices.includes(f.faceIndex));

  if (!face1Data || !face2Data) {
    throw new Error('Could not find face data for descriptors');
  }

  const face1Descriptor = createFaceDescriptor(face1Data, shape.geometry);
  const face2Descriptor = createFaceDescriptor(face2Data, shape.geometry);

  console.log('🆔 Face 1 Descriptor:', face1Descriptor);
  console.log('🆔 Face 2 Descriptor:', face2Descriptor);

  let replicadShape = shape.replicadShape;
  let edgeCount = 0;
  let foundEdgeCount = 0;

  const filletedShape = replicadShape.fillet((edge: any) => {
    edgeCount++;
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
      const tolerance = maxDimension * 0.05;

      const startDistFace1 = Math.abs(startVec.clone().sub(face1Center).dot(face1Normal));
      const startDistFace2 = Math.abs(startVec.clone().sub(face2Center).dot(face2Normal));
      const endDistFace1 = Math.abs(endVec.clone().sub(face1Center).dot(face1Normal));
      const endDistFace2 = Math.abs(endVec.clone().sub(face2Center).dot(face2Normal));
      const centerDistFace1 = Math.abs(centerVec.clone().sub(face1Center).dot(face1Normal));
      const centerDistFace2 = Math.abs(centerVec.clone().sub(face2Center).dot(face2Normal));

      const allPointsOnFace1 = startDistFace1 < tolerance && endDistFace1 < tolerance && centerDistFace1 < tolerance;
      const allPointsOnFace2 = startDistFace2 < tolerance && endDistFace2 < tolerance && centerDistFace2 < tolerance;

      if (allPointsOnFace1 && allPointsOnFace2) {
        foundEdgeCount++;
        console.log('Found shared edge #' + foundEdgeCount + ' - applying fillet radius:', radius);
        console.log(`  Start: (${startVec.x.toFixed(2)}, ${startVec.y.toFixed(2)}, ${startVec.z.toFixed(2)})`);
        console.log(`  End: (${endVec.x.toFixed(2)}, ${endVec.y.toFixed(2)}, ${endVec.z.toFixed(2)})`);
        return radius;
      }

      return null;
    } catch (e) {
      console.error('Error checking edge:', e);
      return null;
    }
  });

  console.log('🔢 Total edges checked:', edgeCount);
  console.log('🔢 Edges selected for fillet:', foundEdgeCount);

  const newGeometry = convertReplicadToThreeGeometry(filletedShape);
  const newBaseVertices = await getReplicadVertices(filletedShape);

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

  console.log(`✅ Fillet with radius ${radius} applied successfully!`);

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

export const FilletEdgeLines: React.FC<FilletEdgeLinesProps> = ({ shape, isSelected }) => {
  const boundaryEdgesGeometry = useMemo(() => {
    if (!shape.geometry) return null;
    const faces = extractFacesFromGeometry(shape.geometry);
    const groups = groupCoplanarFaces(faces);
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
