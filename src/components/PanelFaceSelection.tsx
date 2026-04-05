import React, { useMemo } from 'react';
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

  return (
    <>
      <mesh
        geometry={shape.geometry}
        onPointerMove={(e) => {
          e.stopPropagation();
          if (e.faceIndex !== undefined) {
            const gi = faceGroups.findIndex(g => g.faceIndices.includes(e.faceIndex));
            if (gi !== -1 && gi !== hoveredPanelFaceIndex) {
              setHoveredPanelFaceIndex(gi);
            }
          }
        }}
        onPointerOut={(e) => {
          e.stopPropagation();
          setHoveredPanelFaceIndex(null);
        }}
      >
        <meshBasicMaterial
          transparent
          opacity={0}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      {hoverHighlightGeometry && (
        <mesh geometry={hoverHighlightGeometry} renderOrder={999}>
          <meshBasicMaterial
            color={0x3b82f6}
            transparent
            opacity={0.7}
            side={THREE.DoubleSide}
            polygonOffset
            polygonOffsetFactor={-4}
            polygonOffsetUnits={-4}
            depthTest={false}
            depthWrite={false}
          />
        </mesh>
      )}
    </>
  );
};
