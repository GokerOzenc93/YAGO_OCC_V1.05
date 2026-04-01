import React, { useRef, useMemo, useState, useEffect } from 'react';
import * as THREE from 'three';
import { useAppStore, ViewMode } from '../store';
import { useShallow } from 'zustand/react/shallow';
import { extractFacesFromGeometry, groupCoplanarFaces } from './FaceEditor';

// ─── RENK YÖNETİMİ (High-Fidelity Beyaz ve Keskin Renkler) ───────────────────
const PANEL_COLORS = {
  role: {
    left:    '#ff4d4d',
    right:   '#ff4d4d',
    top:     '#4d94ff',
    bottom:  '#4d94ff',
    back:    '#2ecc71',
    front:   '#f39c12',
    shelf:   '#9b59b6',
    divider: '#1abc9c',
    default: '#ffffff', // Varsayılan artık saf beyaz
  },
  selected: {
    panel:         '#ff0000',
    panelEmissive: '#330000', // Aşırı parlama yapmayan derin kırmızı
    edge:          '#000000',
    shapeEdge:     '#000000',
  },
  edge: {
    default: '#2c3e50', // Biraz daha yumuşak ama keskin bir koyu gri/mavi
  },
  arrow: {
    color:    '#f1c40f',
    emissive: '#f1c40f',
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

  // Seçim Mantığı Hesaplamaları
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

  // Kenar Geometrisi (Angle Threshold 5 derece ile çok keskin)
  const edgeGeometry = useMemo(() => {
    if (!shape.geometry) return null;
    try {
      return new THREE.EdgesGeometry(shape.geometry, 5);
    } catch (error) {
      return null;
    }
  }, [shape.geometry]);

  if (!shape.geometry) return null;

  const isWireframe = viewMode === ViewMode.WIREFRAME;
  const isXray = viewMode === ViewMode.XRAY;

  const faceRole = shape.parameters?.faceRole;
  const getRoleColor = (role: string | undefined): string => {
    if (!role) return shape.color || PANEL_COLORS.role.default;
    return (PANEL_COLORS.role as Record<string, string>)[role]
      ?? (shape.color || PANEL_COLORS.role.default);
  };

  const baseColor = getRoleColor(faceRole);
  const materialColor = isPanelRowSelected ? PANEL_COLORS.selected.panel : baseColor;
  const edgeColor = isPanelRowSelected
    ? PANEL_COLORS.selected.edge
    : isSelected
      ? PANEL_COLORS.selected.shapeEdge
      : PANEL_COLORS.edge.default;

  const handleClick = (e: any) => {
    e.stopPropagation();
    // Panel yüzey seçim modu
    if (panelSurfaceSelectMode && waitingForSurfaceSelection && e.faceIndex !== undefined) {
      const clickedFaceIndex = e.faceIndex;
      const groupIndex = faceGroups.findIndex(group => group.faceIndices.includes(clickedFaceIndex));
      if (groupIndex !== -1) {
        const faceGroup = faceGroups[groupIndex];
        const surfaceConstraint = {
          center: [faceGroup.center.x, faceGroup.center.y, faceGroup.center.z] as [number, number, number],
          normal: [faceGroup.normal.x, faceGroup.normal.y, faceGroup.normal.z] as [number, number, number],
          constraintPanelId: shape.id
        };
        if (selectedShapeId !== parentShapeId) selectShape(parentShapeId);
        triggerPanelCreationForFace(groupIndex, shape.id, surfaceConstraint);
        return;
      }
    }
    const targetId = (panelSurfaceSelectMode || panelSelectMode) && parentShapeId
      ? parentShapeId
      : shape.id;
    if (selectedShapeId !== targetId) selectShape(targetId);
    if ((panelSurfaceSelectMode || panelSelectMode) && parentShapeId) {
      setSelectedPanelRow(faceIndex ?? null, extraRowId || null, parentShapeId);
    }
    selectSecondaryShape(null);
  };

  return (
    <group
      name={`shape-${shape.id}`}
      position={shape.position}
      rotation={shape.rotation}
      scale={shape.scale}
    >
      {!isWireframe && !isXray && (
        <mesh
          ref={meshRef}
          geometry={shape.geometry}
          castShadow
          receiveShadow
          onClick={handleClick}
        >
          {/*
            MAT AHŞAP/MDF MATERYAL:
            - meshLambertMaterial kullanıldı: speküler hesaplama YOKTUR,
              kamera açısından bağımsız düz/mat görünüm sağlar.
            - clearcoat, reflectivity, envMapIntensity tamamen kaldırıldı.
            - Bu sayede kamera açısına göre parlama/patlama oluşmaz.

            ✅ FIX (Z-fighting):
            polygonOffsetFactor=4, polygonOffsetUnits=8 korundu.
          */}
          <meshLambertMaterial
            color={materialColor}
            emissive={isPanelRowSelected ? PANEL_COLORS.selected.panelEmissive : '#000000'}
            emissiveIntensity={1}
            side={THREE.DoubleSide}
            polygonOffset
            polygonOffsetFactor={4}
            polygonOffsetUnits={8}
          />
        </mesh>
      )}

      {/* Kenar Çizgileri - Keskin ve Net
          ✅ FIX (Z-fighting):
          - renderOrder={1} → çizgiler her zaman mesh'ten SONRA çizilir
          - depthWrite={false} → Z-buffer'ı kirletmez, diğer nesnelerle çakışmaz
      */}
      {!isWireframe && edgeGeometry && (
        <lineSegments
          geometry={edgeGeometry}
          raycast={() => null}
          renderOrder={1}             // ✅ DÜZELTME: mesh'ten sonra render et
        >
          <lineBasicMaterial
            color={edgeColor}
            linewidth={1}
            transparent={true}
            depthTest={true}
            depthWrite={false}        // ✅ DÜZELTME: Z-buffer kirlenmesini önler
            opacity={isSelected || isPanelRowSelected ? 1.0 : 0.9}
          />
        </lineSegments>
      )}

      {/* Wireframe Modu */}
      {isWireframe && edgeGeometry && (
        <lineSegments
          geometry={edgeGeometry}
          raycast={() => null}
          renderOrder={1}
        >
          <lineBasicMaterial
            color={edgeColor}
            linewidth={1.5}
            transparent={true}
            depthTest={true}
            depthWrite={false}
            opacity={1.0}
          />
        </lineSegments>
      )}

      {/* X-Ray Modu */}
      {isXray && (
        <>
          <mesh
            ref={meshRef}
            geometry={shape.geometry}
            castShadow
            receiveShadow
            onClick={handleClick}
          >
            <meshLambertMaterial
              color={materialColor}
              emissive={isPanelRowSelected ? PANEL_COLORS.selected.panelEmissive : '#000000'}
              emissiveIntensity={1}
              side={THREE.DoubleSide}
              transparent={true}
              opacity={0.35}
              polygonOffset
              polygonOffsetFactor={4}
              polygonOffsetUnits={8}
            />
          </mesh>
          {edgeGeometry && (
            <lineSegments
              geometry={edgeGeometry}
              raycast={() => null}
              renderOrder={1}
            >
              <lineBasicMaterial
                color={edgeColor}
                linewidth={1}
                transparent={true}
                depthTest={false}
                depthWrite={false}
                opacity={0.8}
              />
            </lineSegments>
          )}
        </>
      )}
    </group>
  );
});
