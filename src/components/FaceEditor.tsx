import React, { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { useAppStore } from '../store';

export type {
  FaceData,
  CoplanarFaceGroup,
} from './GeometryUtils';

export {
  extractFacesFromGeometry,
  groupCoplanarFaces,
  createGroupBoundaryEdges,
  findClosestFaceToRay,
  createFaceHighlightGeometry,
  getFaceWorldPosition,
  getFaceWorldNormal,
  createFaceDescriptor,
  findFaceByDescriptor,
} from './GeometryUtils';

import {
  extractFacesFromGeometry,
  groupCoplanarFaces,
  createFaceHighlightGeometry,
  createGroupBoundaryEdges,
  type FaceData,
  type CoplanarFaceGroup,
} from './GeometryUtils';

interface FaceEditorProps {
  shape: any;
  isActive: boolean;
}

export const FaceEditor: React.FC<FaceEditorProps> = ({ shape, isActive }) => {
  const {
    hoveredFaceIndex,
    setHoveredFaceIndex,
    selectedFaceIndex,
    setSelectedFaceIndex,
    filletMode,
    selectedFilletFaces,
    addFilletFace,
    addFilletFaceData,
    panelSurfaceSelectMode,
    waitingForSurfaceSelection,
    triggerPanelCreationForFace
  } = useAppStore();

  const [faces, setFaces] = useState<FaceData[]>([]);
  const [faceGroups, setFaceGroups] = useState<CoplanarFaceGroup[]>([]);
  const [hoveredGroupIndex, setHoveredGroupIndex] = useState<number | null>(null);

  const geometryUuid = shape.geometry?.uuid || '';

  useEffect(() => {
    if (!shape.geometry) return;

    const extractedFaces = extractFacesFromGeometry(shape.geometry);
    setFaces(extractedFaces);

    const groups = groupCoplanarFaces(extractedFaces);
    setFaceGroups(groups);
  }, [shape.geometry, shape.id, geometryUuid]);

  const handleFaceSelection = (groupIndex: number) => {
    if (filletMode && selectedFilletFaces.length < 2) {
      const group = faceGroups[groupIndex];
      if (group) {
        addFilletFace(groupIndex);
        addFilletFaceData({
          normal: [group.normal.x, group.normal.y, group.normal.z],
          center: [group.center.x, group.center.y, group.center.z]
        });
      }
    } else {
      setSelectedFaceIndex(groupIndex);
    }
  };

  const handlePointerMove = (e: any) => {
    if (!isActive || faces.length === 0) return;

    e.stopPropagation();
    const faceIndex = e.faceIndex;

    if (faceIndex !== undefined) {
      const groupIndex = faceGroups.findIndex(group =>
        group.faceIndices.includes(faceIndex)
      );

      if (groupIndex !== -1) {
        setHoveredGroupIndex(groupIndex);
        setHoveredFaceIndex(faceIndex);
      }
    }
  };

  const handlePointerOut = (e: any) => {
    e.stopPropagation();
    setHoveredGroupIndex(null);
    setHoveredFaceIndex(null);
  };

  const handlePointerDown = (e: any) => {
    e.stopPropagation();

    if (panelSurfaceSelectMode && waitingForSurfaceSelection && hoveredGroupIndex !== null) {
      console.log('🎯 Surface clicked for panel creation, faceIndex:', hoveredGroupIndex);
      triggerPanelCreationForFace(hoveredGroupIndex);
      return;
    }

    if (e.button === 2 && hoveredGroupIndex !== null) {
      handleFaceSelection(hoveredGroupIndex);
    }
  };

  const selectedFilletGeometries = useMemo(() => {
    if (!filletMode || selectedFilletFaces.length === 0) return [];

    return selectedFilletFaces.map(faceGroupIndex => {
      const group = faceGroups[faceGroupIndex];
      if (!group) return null;
      return createFaceHighlightGeometry(faces, group.faceIndices);
    }).filter(g => g !== null);
  }, [filletMode, selectedFilletFaces, faceGroups, faces]);

  const highlightGeometry = useMemo(() => {
    if (hoveredGroupIndex === null || !faceGroups[hoveredGroupIndex]) return null;

    const group = faceGroups[hoveredGroupIndex];
    return createFaceHighlightGeometry(faces, group.faceIndices);
  }, [hoveredGroupIndex, faceGroups, faces]);

  const boundaryEdgesGeometry = useMemo(() => {
    if (faces.length === 0 || faceGroups.length === 0) return null;
    return createGroupBoundaryEdges(faces, faceGroups);
  }, [faces, faceGroups]);

  if (!isActive) return null;

  return (
    <>
      <mesh
        geometry={shape.geometry}
        visible={false}
        onPointerMove={handlePointerMove}
        onPointerOut={handlePointerOut}
        onPointerDown={handlePointerDown}
        onContextMenu={(e) => e.stopPropagation()}
      />

      {selectedFilletGeometries.map((geom, idx) => (
        <mesh
          key={`selected-${idx}`}
          geometry={geom}
        >
          <meshBasicMaterial
            color={0xff0000}
            transparent
            opacity={0.6}
            side={THREE.DoubleSide}
            polygonOffset
            polygonOffsetFactor={-1}
            polygonOffsetUnits={-1}
          />
        </mesh>
      ))}

      {highlightGeometry && !selectedFilletFaces.includes(hoveredGroupIndex!) && (
        <mesh
          geometry={highlightGeometry}
        >
          <meshBasicMaterial
            color={0xff0000}
            transparent
            opacity={0.5}
            side={THREE.DoubleSide}
            polygonOffset
            polygonOffsetFactor={-1}
            polygonOffsetUnits={-1}
          />
        </mesh>
      )}

      {boundaryEdgesGeometry && (
        <lineSegments
          geometry={boundaryEdgesGeometry}
        >
          <lineBasicMaterial color={0x000000} linewidth={2} />
        </lineSegments>
      )}
    </>
  );
};
