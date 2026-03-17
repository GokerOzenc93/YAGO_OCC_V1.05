import React, { useRef, useMemo, useState, useEffect } from 'react';
import * as THREE from 'three';
import { useAppStore, ViewMode } from '../store';
import { useShallow } from 'zustand/react/shallow';
import { extractFacesFromGeometry, groupCoplanarFaces } from './FaceEditor';

// ─── Tüm panel renklerini buradan yönet ───────────────────────────────────────
const PANEL_COLORS = {
  // Yüzey rolleri (faceRole) → panel rengi
  role: {
    left:    '#ef4444',
    right:   '#ef4444',
    top:     '#3b82f6',
    bottom:  '#3b82f6',
    back:    '#22c55e',
    front:   '#f59e0b',
    shelf:   '#a855f7',
    divider: '#14b8a6',
    default: '#6a329f',   // shape.color yoksa fallback
  },

  // Seçim & vurgulama
  selected: {
    panel:         '#fb0412',   // isPanelRowSelected → mesh rengi
    panelEmissive: '#fb0412',   // isPanelRowSelected → emissive rengi
    edge:          '#fb0412',   // isPanelRowSelected → edge rengi
    shapeEdge:     '#1e40af',   // sadece isSelected → edge rengi
  },

  // Normal (seçilmemiş) kenar
  edge: {
    default: '#1a1a1a',
  },

  // Yön oku (DirectionArrow)
  arrow: {
    color:    '#efc441',
    emissive: '#efc441',
  },
} as const;
// ─────────────────────────────────────────────────────────────────────────────

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
      const edges = new THREE.EdgesGeometry(shape.geometry, 5);
      return edges;
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

  const baseColor     = getRoleColor(faceRole);
  const materialColor = isPanelRowSelected ? PANEL_COLORS.selected.panel : baseColor;
  const edgeColor     = isPanelRowSelected
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

        if (selectedShapeId !== parentShapeId) {
          selectShape(parentShapeId);
        }

        triggerPanelCreationForFace(groupIndex, shape.id, surfaceConstraint);
        return;
      }
    }

    if (panelSurfaceSelectMode && parentShapeId) {
      if (selectedShapeId !== parentShapeId) {
        selectShape(parentShapeId);
      }
      setSelectedPanelRow(faceIndex ?? null, extraRowId || null, parentShapeId);
      selectSecondaryShape(null);
    } else if (panelSelectMode && parentShapeId) {
      if (selectedShapeId !== parentShapeId) {
        selectShape(parentShapeId);
      }
      setSelectedPanelRow(faceIndex ?? null, extraRowId || null, parentShapeId);
      selectSecondaryShape(null);
    } else {
      selectShape(shape.id);
      selectSecondaryShape(null);
    }
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
          <meshStandardMaterial
            color={materialColor}
            emissive={isPanelRowSelected ? PANEL_COLORS.selected.panelEmissive : '#000000'}
            emissiveIntensity={isPanelRowSelected ? 0.4 : 0}
            metalness={0}
            roughness={0.4}
            transparent={false}
            opacity={1}
            side={THREE.DoubleSide}
            depthWrite={true}
            flatShading={false}
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
                depthTest={true}
                depthWrite={true}
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
            castShadow
            receiveShadow
            onClick={handleClick}
          >
            <meshStandardMaterial
              color={materialColor}
              emissive={isPanelRowSelected ? PANEL_COLORS.selected.panelEmissive : '#000000'}
              emissiveIntensity={isPanelRowSelected ? 0.4 : 0}
              metalness={0}
              roughness={0.4}
              transparent={true}
              opacity={0.45}
              side={THREE.DoubleSide}
              depthWrite={false}
              flatShading={false}
            />
          </mesh>
          {edgeGeometry && (
            <lineSegments geometry={edgeGeometry}>
              <lineBasicMaterial
                color={edgeColor}
                linewidth={isPanelRowSelected ? 3 : isSelected ? 2.5 : 2}
                opacity={1}
                transparent={false}
                depthTest={true}
              />
            </lineSegments>
          )}
        </>
      )}
      {!isWireframe && !isXray && edgeGeometry && (
        <lineSegments geometry={edgeGeometry}>
          <lineBasicMaterial
            color={edgeColor}
            linewidth={isPanelRowSelected ? 3 : isSelected ? 2.5 : 2}
            opacity={1}
            transparent={false}
            depthTest={true}
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

interface DirectionArrowProps {
  geometry: THREE.BufferGeometry;
  faceRole?: string;
  arrowRotated?: boolean;
}

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
    ];
    axes.sort((a, b) => a.value - b.value);
    const thinAxisIndex = axes[0].index;
    const thinAxisValue = axes[0].value;

    const offsetDir = new THREE.Vector3();
    offsetDir.setComponent(thinAxisIndex, 1);

    const gap = thinAxisValue / 2 + 40;

    const arrowPosition = center.clone().add(
      offsetDir.clone().multiplyScalar(gap)
    );

    const planeAxes = axes.slice(1).map(a => a.index).sort((a, b) => a - b);

    const axisToRotation = (axis: number): [number, number, number] => {
      if (axis === 0) return [0, 0, -Math.PI / 2];
      if (axis === 2) return [Math.PI / 2, 0, 0];
      return [0, 0, 0];
    };

    const role = faceRole?.toLowerCase();
    let defaultAxis = planeAxes[0];
    let altAxis = planeAxes[1];

    if (role === 'left' || role === 'right') {
      if (planeAxes.includes(1)) {
        defaultAxis = 1;
        altAxis = planeAxes.find(a => a !== 1) ?? planeAxes[1];
      }
    } else if (role === 'top' || role === 'bottom') {
      if (planeAxes.includes(0)) {
        defaultAxis = 0;
        altAxis = planeAxes.find(a => a !== 0) ?? planeAxes[1];
      }
    }

    const targetAxis = arrowRotated ? altAxis : defaultAxis;
    const rotation = axisToRotation(targetAxis);

    return {
      position: [arrowPosition.x, arrowPosition.y, arrowPosition.z] as [number, number, number],
      rotation
    };
  }, [geometry, faceRole, arrowRotated]);

  if (!arrowConfig) return null;

  const { position, rotation } = arrowConfig;
  const shaftRadius = 1.8;
  const shaftLength = 90;
  const headRadius = 10;
  const headLength = 28;
  const segments = 16;

  return (
    <group position={position} rotation={rotation}>
      <mesh position={[0, shaftLength / 2, 0]}>
        <cylinderGeometry args={[shaftRadius, shaftRadius, shaftLength, segments]} />
        <meshStandardMaterial
          color={PANEL_COLORS.arrow.color}
          emissive={PANEL_COLORS.arrow.emissive}
          emissiveIntensity={0.6}
          metalness={0.4}
          roughness={0.2}
        />
      </mesh>
      <mesh position={[0, shaftLength + headLength / 2, 0]}>
        <coneGeometry args={[headRadius, headLength, segments]} />
        <meshStandardMaterial
          color={PANEL_COLORS.arrow.color}
          emissive={PANEL_COLORS.arrow.emissive}
          emissiveIntensity={0.6}
          metalness={0.4}
          roughness={0.2}
        />
      </mesh>
    </group>
  );
});

DirectionArrow.displayName = 'DirectionArrow';
