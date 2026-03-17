import React, { useRef, useMemo, useState, useEffect } from 'react';
import * as THREE from 'three';
import { useAppStore, ViewMode } from '../store';
import { useShallow } from 'zustand/react/shallow';
import { extractFacesFromGeometry, groupCoplanarFaces } from './FaceEditor';

// ─── Tüm panel renklerini buradan yönet ───────────────────────────────────────
const PANEL_COLORS = {
  role: {
    left:    '#ef4444',
    right:   '#ef4444',
    top:     '#3b82f6',
    bottom:  '#3b82f6',
    back:    '#22c55e',
    front:   '#f59e0b',
    shelf:   '#a855f7',
    divider: '#14b8a6',
    default: '#6a329f',
  },
  selected: {
    panel:         '#fb0412',
    panelEmissive: '#fb0412',
    edge:          '#000000',
    shapeEdge:     '#000000',
  },
  edge: {
    default: '#000000',
  },
  arrow: {
    color:    '#efc441',
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
    } catch (error) {
      console.error('Error creating edge geometry:', error);
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

    if (panelSurfaceSelectMode && waitingForSurfaceSelection && e.faceIndex !== undefined) {
      const clickedFaceIndex = e.faceIndex;
      const groupIndex = faceGroups.findIndex(group =>
        group.faceIndices.includes(clickedFaceIndex)
      );

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

    const targetId = (panelSurfaceSelectMode || panelSelectMode) && parentShapeId ? parentShapeId : shape.id;
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
          {/* PÜRÜZSÜZ PANEL MATERYALİ */}
          <meshPhysicalMaterial
            color={materialColor}
            metalness={0}                // Kumlanmayı önlemek için metalness kapatıldı
            roughness={0.12}             // Daha düz ve pürüzsüz yüzey (lake etkisi)
            clearcoat={1.0}              // Tam katman vernik
            clearcoatRoughness={0.03}    // Vernik yüzeyi cam gibi pürüzsüz
            reflectivity={0.5}           // Işık yansıtma gücü
            sheen={0.1}                  // Tırtıklanma yapmaması için sheen minimize edildi
            emissive={isPanelRowSelected ? PANEL_COLORS.selected.panelEmissive : '#000000'}
            emissiveIntensity={isPanelRowSelected ? 0.3 : 0}
            side={THREE.DoubleSide}
            transparent={false}
            depthWrite={true}
          />
        </mesh>
      )}

      {isWireframe && (
        <>
          <mesh
            ref={meshRef}
            geometry={shape.geometry}
            visible={false}
            onClick={handleClick}
          />
          {edgeGeometry && (
            <lineSegments geometry={edgeGeometry}>
              <lineBasicMaterial
                color={isSelected ? PANEL_COLORS.selected.shapeEdge : PANEL_COLORS.edge.default}
                linewidth={isPanelRowSelected ? 3 : isSelected ? 2.5 : 2}
              />
            </lineSegments>
          )}
        </>
      )}

      {isXray && (
        <>
          <mesh
            ref={meshRef}
            geometry={shape.geometry}
            onClick={handleClick}
          >
            <meshPhysicalMaterial
              color={materialColor}
              transparent={true}
              opacity={0.45}
              metalness={0}
              roughness={0.3}
              clearcoat={0.1}
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>
          {edgeGeometry && (
            <lineSegments geometry={edgeGeometry}>
              <lineBasicMaterial color={edgeColor} linewidth={2} />
            </lineSegments>
          )}
        </>
      )}

      {!isWireframe && !isXray && edgeGeometry && (
        <lineSegments geometry={edgeGeometry}>
          <lineBasicMaterial
            color={edgeColor}
            linewidth={isPanelRowSelected ? 3 : isSelected ? 2.5 : 2}
            transparent={true}
            opacity={0.6} // Kenar çizgilerini biraz yumuşattık
          />
        </lineSegments>
      )}

      {isPanelRowSelected && (
        <DirectionArrow
          geometry={shape.geometry}
          faceRole={faceRole}
          arrowRotated={shape.parameters?.arrowRotated || false}
        />
      )}
    </group>
  );
});

PanelDrawing.displayName = 'PanelDrawing';

// ─── DirectionArrow (Yön Oku) ────────────────────────────────────────────────
const DirectionArrow: React.FC<DirectionArrowProps> = React.memo(({
  geometry,
  faceRole,
  arrowRotated = false
}) => {
  const arrowConfig = useMemo(() => {
    if (!geometry) return null;
    const posAttr = geometry.getAttribute('position');
    if (!posAttr) return null;

    const bbox = new THREE.Box3().setFromBufferAttribute(posAttr as THREE.BufferAttribute);
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    bbox.getCenter(center);
    bbox.getSize(size);

    const axes = [
      { index: 0, value: size.x },
      { index: 1, value: size.y },
      { index: 2, value: size.z }
    ].sort((a, b) => a.value - b.value);

    const thinAxisIndex = axes[0].index;
    const offsetDir = new THREE.Vector3().setComponent(thinAxisIndex, 1);
    const gap = (axes[0].value / 2) + 40;
    const arrowPosition = center.clone().add(offsetDir.multiplyScalar(gap));

    const planeAxes = axes.slice(1).map(a => a.index).sort((a, b) => a - b);
    const role = faceRole?.toLowerCase();
    let targetAxis = (role === 'left' || role === 'right') && planeAxes.includes(1) ? 1 : 
                     (role === 'top' || role === 'bottom') && planeAxes.includes(0) ? 0 : planeAxes[0];
    
    if (arrowRotated) {
      targetAxis = planeAxes.find(a => a !== targetAxis) ?? planeAxes[1];
    }

    const rotation: [number, number, number] = targetAxis === 0 ? [0, 0, -Math.PI / 2] : 
                                               targetAxis === 2 ? [Math.PI / 2, 0, 0] : [0, 0, 0];

    return { position: [arrowPosition.x, arrowPosition.y, arrowPosition.z] as [number, number, number], rotation };
  }, [geometry, faceRole, arrowRotated]);

  if (!arrowConfig) return null;

  return (
    <group position={arrowConfig.position} rotation={arrowConfig.rotation}>
      <mesh position={[0, 45, 0]}>
        <cylinderGeometry args={[1.8, 1.8, 90, 16]} />
        <meshPhysicalMaterial color={PANEL_COLORS.arrow.color} emissive={PANEL_COLORS.arrow.emissive} emissiveIntensity={0.6} />
      </mesh>
      <mesh position={[0, 104, 0]}>
        <coneGeometry args={[10, 28, 16]} />
        <meshPhysicalMaterial color={PANEL_COLORS.arrow.color} emissive={PANEL_COLORS.arrow.emissive} emissiveIntensity={0.6} />
      </mesh>
    </group>
  );
});

interface DirectionArrowProps {
  geometry: THREE.BufferGeometry;
  faceRole?: string;
  arrowRotated?: boolean;
}

DirectionArrow.displayName = 'DirectionArrow';