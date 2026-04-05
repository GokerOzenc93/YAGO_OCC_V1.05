import React, { useMemo, useState } from 'react';
import * as THREE from 'three';
import { useAppStore } from '../store';
import { useShallow } from 'zustand/react/shallow';
import {
  extractFacesFromGeometry,
  groupCoplanarFaces,
  createFaceHighlightGeometry,
} from './FaceEditor';

export const PanelFaceSelectionOverlay: React.FC<{ shape: any }> = ({ shape }) => {
  const {
    panelFaceEditMode,
    editingPanelId,
    hoveredPanelFaceIndex,
    setHoveredPanelFaceIndex,
  } = useAppStore(useShallow(state => ({
    panelFaceEditMode: state.panelFaceEditMode,
    editingPanelId: state.editingPanelId,
    hoveredPanelFaceIndex: state.hoveredPanelFaceIndex,
    setHoveredPanelFaceIndex: state.setHoveredPanelFaceIndex,
  })));

  const isEditingThis = panelFaceEditMode && editingPanelId === shape.id;
  const geometryUuid = shape.geometry?.uuid || '';

  const { faces, faceGroups } = useMemo(() => {
    if (!shape.geometry) return { faces: [], faceGroups: [] };
    const f = extractFacesFromGeometry(shape.geometry);
    const g = groupCoplanarFaces(f);
    return { faces: f, faceGroups: g };
  }, [shape.geometry, geometryUuid]);

  const hoverHighlightGeometry = useMemo(() => {
    if (hoveredPanelFaceIndex === null || !faceGroups[hoveredPanelFaceIndex]) return null;
    return createFaceHighlightGeometry(faces, faceGroups[hoveredPanelFaceIndex].faceIndices);
  }, [hoveredPanelFaceIndex, faceGroups, faces]);

  if (!isEditingThis || faces.length === 0) return null;

  const handlePointerMove = (e: any) => {
    e.stopPropagation();
    if (e.faceIndex !== undefined) {
      const gi = faceGroups.findIndex(g => g.faceIndices.includes(e.faceIndex));
      if (gi !== -1) setHoveredPanelFaceIndex(gi);
    }
  };

  const handlePointerOut = (e: any) => {
    e.stopPropagation();
    setHoveredPanelFaceIndex(null);
  };

  return (
    <>
      <mesh
        geometry={shape.geometry}
        visible={false}
        onPointerMove={handlePointerMove}
        onPointerOut={handlePointerOut}
      />
      {hoverHighlightGeometry && (
        <mesh geometry={hoverHighlightGeometry}>
          <meshBasicMaterial
            color={0xff0000}
            transparent
            opacity={0.45}
            side={THREE.DoubleSide}
            polygonOffset
            polygonOffsetFactor={-3}
            polygonOffsetUnits={-3}
            depthTest={false}
          />
        </mesh>
      )}
    </>
  );
};
