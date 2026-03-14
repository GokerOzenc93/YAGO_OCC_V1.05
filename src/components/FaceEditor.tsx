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
        const nx = group.normal.x;
        const ny = group.normal.y;
        const nz = group.normal.z;
        const absX = Math.abs(nx);
        const absY = Math.abs(ny);
        const absZ = Math.abs(nz);
        const isAxisAligned = absX > 0.9 || absY > 0.9 || absZ > 0.9;
        let planeD: number;
        if (isAxisAligned && shape.geometry) {
          const flatFaces = faces.filter(f =>
            group.faceIndices.includes(f.faceIndex) && !f.isCurved
          );
          const sourceFaces = flatFaces.length > 0 ? flatFaces : faces.filter(f => group.faceIndices.includes(f.faceIndex));
          const allVerts: THREE.Vector3[] = sourceFaces.flatMap(f => f.vertices);
          if (allVerts.length > 0) {
            if (absX > 0.9) {
              const vals = allVerts.map(v => v.x);
              const extreme = nx > 0 ? Math.max(...vals) : Math.min(...vals);
              planeD = nx * extreme;
            } else if (absY > 0.9) {
              const vals = allVerts.map(v => v.y);
              const extreme = ny > 0 ? Math.max(...vals) : Math.min(...vals);
              planeD = ny * extreme;
            } else {
              const vals = allVerts.map(v => v.z);
              const extreme = nz > 0 ? Math.max(...vals) : Math.min(...vals);
              planeD = nz * extreme;
            }
          } else {
            planeD = nx * group.center.x + ny * group.center.y + nz * group.center.z;
          }
        } else {
          planeD = nx * group.center.x + ny * group.center.y + nz * group.center.z;
        }
        console.log(`🎯 Fillet face selected: groupIndex=${groupIndex}, normal=[${nx.toFixed(2)},${ny.toFixed(2)},${nz.toFixed(2)}], planeD=${planeD.toFixed(3)}, center=[${group.center.x.toFixed(2)},${group.center.y.toFixed(2)},${group.center.z.toFixed(2)}]`);
        console.log(`🎯 flatFaces count: ${faces.filter(f => group.faceIndices.includes(f.faceIndex) && !f.isCurved).length}, total in group: ${group.faceIndices.length}`);
        addFilletFace(groupIndex);
        addFilletFaceData({
          normal: [nx, ny, nz],
          center: [group.center.x, group.center.y, group.center.z],
          planeD
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
