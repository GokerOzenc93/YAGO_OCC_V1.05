import React, { useRef, useMemo, useState, useEffect } from 'react';
import * as THREE from 'three';
import { useAppStore, ViewMode } from '../store';
import { useShallow } from 'zustand/react/shallow';
import { extractFacesFromGeometry, groupCoplanarFaces } from './FaceEditor';

const PANEL_COLORS = {
  role: {
    left: '#ef4444',
    right: '#ef4444',
    top: '#3b82f6',
    bottom: '#3b82f6',
    back: '#22c55e',
    front: '#f59e0b',
    shelf: '#a855f7',
    divider: '#14b8a6',
    default: '#6a329f',
  },
  selected: {
    panel: '#fb0412',
    panelEmissive: '#fb0412',
    edge: '#000000',
    shapeEdge: '#000000',
  },
  edge: {
    default: '#000000',
  },
  arrow: {
    color: '#efc441',
    emissive: '#efc441',
  },
} as const;

interface PanelDrawingProps {
  shape: any;
  isSelected: boolean;
}

export const PanelDrawing: React.FC<PanelDrawingProps> = React.memo(({
  shape,
  isSelected
}) => {
  const meshRef = useRef<THREE.Mesh>(null);

  const {
    selectShape,
    selectSecondaryShape,
    selectedShapeId,
    selectedPanelRow,
    selectedPanelRowExtraId,
    setSelectedPanelRow,
    panelSelectMode,
    panelSurfaceSelectMode,
    waitingForSurfaceSelection,
    triggerPanelCreationForFace,
    viewMode
  } = useAppStore(useShallow(state => ({
    selectShape: state.selectShape,
    selectSecondaryShape: state.selectSecondaryShape,
    selectedShapeId: state.selectedShapeId,
    selectedPanelRow: state.selectedPanelRow,
    selectedPanelRowExtraId: state.selectedPanelRowExtraId,
    setSelectedPanelRow: state.setSelectedPanelRow,
    panelSelectMode: state.panelSelectMode,
    panelSurfaceSelectMode: state.panelSurfaceSelectMode,
    waitingForSurfaceSelection: state.waitingForSurfaceSelection,
    triggerPanelCreationForFace: state.triggerPanelCreationForFace,
    viewMode: state.viewMode
  })));

  const [faceGroups, setFaceGroups] = useState<any[]>([]);

  useEffect(() => {
    if (!shape.geometry) return;
    const faces = extractFacesFromGeometry(shape.geometry);
    const groups = groupCoplanarFaces(faces);
    setFaceGroups(groups);
  }, [shape.geometry]);

  const parentShapeId = shape.parameters?.parentShapeId;
  const faceIndex = shape.parameters?.faceIndex;
  const extraRowId = shape.parameters?.extraRowId;
  const virtualFaceId = shape.parameters?.virtualFaceId;

  const isParentSelected = parentShapeId === selectedShapeId;

  const isPanelRowSelected = isParentSelected &&
    (
      (virtualFaceId && selectedPanelRow === `vf-${virtualFaceId}`) ||
      (faceIndex !== undefined &&
        (
          (typeof faceIndex === 'string' && faceIndex === selectedPanelRow) ||
          (typeof faceIndex === 'number' && faceIndex === selectedPanelRow &&
            ((extraRowId && extraRowId === selectedPanelRowExtraId) ||
              (!extraRowId && !selectedPanelRowExtraId)))
        )
      )
    );

  const edgeGeometry = useMemo(() => {
    if (!shape.geometry) return null;
    try {
      return new THREE.EdgesGeometry(shape.geometry, 5);
    } catch {
      return null;
    }
  }, [shape.geometry]);

  if (!shape.geometry) return null;

  const isWireframe = viewMode === ViewMode.WIREFRAME;
  const isXray = viewMode === ViewMode.XRAY;

  const faceRole = shape.parameters?.faceRole;

  const getRoleColor = (role?: string) => {
    if (!role) return shape.color || PANEL_COLORS.role.default;
    return PANEL_COLORS.role[role as keyof typeof PANEL_COLORS.role] ?? shape.color;
  };

  const baseColor = getRoleColor(faceRole);
  const materialColor = isPanelRowSelected ? PANEL_COLORS.selected.panel : baseColor;

  const edgeColor = isPanelRowSelected
    ? PANEL_COLORS.selected.edge
    : isSelected
      ? PANEL_COLORS.selected.shapeEdge
      : PANEL_COLORS.edge.default;

  // 🔥 YENİ MATERIAL
  const panelMaterial = useMemo(() => (
    <meshPhysicalMaterial
      color={materialColor}
      metalness={0}
      roughness={0.75}
      clearcoat={0.1}
      clearcoatRoughness={0.4}
      reflectivity={0.2}
      emissive={isPanelRowSelected ? PANEL_COLORS.selected.panelEmissive : '#000000'}
      emissiveIntensity={isPanelRowSelected ? 0.4 : 0}
      side={THREE.DoubleSide}
    />
  ), [materialColor, isPanelRowSelected]);

  const handleClick = (e: any) => {
    e.stopPropagation();

    if (panelSurfaceSelectMode && waitingForSurfaceSelection && e.faceIndex !== undefined) {
      const groupIndex = faceGroups.findIndex(g => g.faceIndices.includes(e.faceIndex));

      if (groupIndex !== -1) {
        const g = faceGroups[groupIndex];
        triggerPanelCreationForFace(groupIndex, shape.id, {
          center: [g.center.x, g.center.y, g.center.z],
          normal: [g.normal.x, g.normal.y, g.normal.z],
          constraintPanelId: shape.id
        });
        return;
      }
    }

    if (parentShapeId) {
      selectShape(parentShapeId);
      setSelectedPanelRow(faceIndex ?? null, extraRowId || null, parentShapeId);
      selectSecondaryShape(null);
    } else {
      selectShape(shape.id);
      selectSecondaryShape(null);
    }
  };

  return (
    <group position={shape.position} rotation={shape.rotation} scale={shape.scale}>

      {/* NORMAL */}
      {!isWireframe && !isXray && (
        <mesh ref={meshRef} geometry={shape.geometry} onClick={handleClick}>
          {panelMaterial}
        </mesh>
      )}

      {/* XRAY */}
      {isXray && (
        <mesh ref={meshRef} geometry={shape.geometry} onClick={handleClick}>
          <meshPhysicalMaterial
            color={materialColor}
            roughness={0.75}
            transparent
            opacity={0.45}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      )}

      {/* WIREFRAME */}
      {isWireframe && (
        <>
          <mesh ref={meshRef} geometry={shape.geometry} visible={false} onClick={handleClick} />
          {edgeGeometry && (
            <lineSegments geometry={edgeGeometry}>
              <lineBasicMaterial color={edgeColor} />
            </lineSegments>
          )}
        </>
      )}

      {/* EDGE */}
      {!isWireframe && edgeGeometry && (
        <lineSegments geometry={edgeGeometry}>
          <lineBasicMaterial color={edgeColor} />
        </lineSegments>
      )}

      {/* ARROW */}
      {isPanelRowSelected && (
        <DirectionArrow geometry={shape.geometry} faceRole={faceRole} />
      )}

    </group>
  );
});

PanelDrawing.displayName = 'PanelDrawing';

const DirectionArrow = ({ geometry }: any) => {
  return (
    <mesh>
      <coneGeometry args={[10, 30, 16]} />
      <meshPhysicalMaterial
        color="#efc441"
        emissive="#efc441"
        emissiveIntensity={0.8}
        metalness={0.6}
        roughness={0.2}
      />
    </mesh>
  );
};