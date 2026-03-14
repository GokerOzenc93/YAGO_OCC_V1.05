import React, { useRef, useMemo, useState, useEffect } from 'react';
import * as THREE from 'three';
import { useAppStore } from '../store';
import { useShallow } from 'zustand/react/shallow';
import { extractFacesFromGeometry, groupCoplanarFaces } from './FaceEditor';

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
    triggerPanelCreationForFace
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
    triggerPanelCreationForFace: state.triggerPanelCreationForFace
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

  const panelColor = shape.color || '#ffffff';
  const faceRole = shape.parameters?.faceRole;

  const getRoleColor = (role: string | undefined): string => {
    if (!role) return panelColor;

    switch (role) {
      case 'left':
      case 'right':
        return '#ef4444';
      case 'top':
      case 'bottom':
        return '#3b82f6';
      case 'back':
        return '#22c55e';
      case 'front':
        return '#f59e0b';
      case 'shelf':
        return '#a855f7';
      case 'divider':
        return '#14b8a6';
      default:
        return panelColor;
    }
  };

  const baseColor = getRoleColor(faceRole);
  const shouldHighlightRed = isPanelRowSelected && panelSelectMode;
  const materialColor = shouldHighlightRed ? '#ef4444' : baseColor;
  const edgeColor = shouldHighlightRed ? '#b91c1c' : isSelected ? '#1e40af' : '#000000';

  return (
    <group
      name={`shape-${shape.id}`}
      position={shape.position}
      rotation={shape.rotation}
      scale={shape.scale}
    >
      <mesh
        ref={meshRef}
        geometry={shape.geometry}
        castShadow
        receiveShadow
        onClick={(e) => {
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

              console.log('🎯 Panel surface clicked for new panel creation:', {
                panelId: shape.id,
                clickedFaceIndex,
                groupIndex,
                parentShapeId,
                surfaceConstraint
              });

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
            setSelectedPanelRow(faceIndex ?? null, extraRowId || null);
            selectSecondaryShape(null);
            console.log('Panel surface selected:', {
              parentShapeId,
              faceIndex,
              extraRowId: extraRowId || 'none',
              panelId: shape.id
            });
          } else if (panelSelectMode && parentShapeId) {
            if (selectedShapeId !== parentShapeId) {
              selectShape(parentShapeId);
            }
            setSelectedPanelRow(faceIndex ?? null, extraRowId || null);
            selectSecondaryShape(null);
          } else {
            selectShape(shape.id);
            selectSecondaryShape(null);
          }
        }}
      >
        <meshStandardMaterial
          color={materialColor}
          emissive={isPanelRowSelected ? '#ef4444' : baseColor}
          emissiveIntensity={isPanelRowSelected ? 0.35 : 0.1}
          metalness={0}
          roughness={0.4}
          transparent={false}
          opacity={1}
          side={THREE.DoubleSide}
          depthWrite={true}
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
  const shaftLength = 80;
  const shaftWidth = 8;
  const shaftDepth = 2;
  const headLength = 30;
  const headWidth = 24;

  return (
    <group position={position} rotation={rotation}>
      <mesh position={[0, shaftLength / 2, 0]}>
        <boxGeometry args={[shaftWidth, shaftLength, shaftDepth]} />
        <meshStandardMaterial
          color="#2196F3"
          emissive="#2196F3"
          emissiveIntensity={0.5}
          metalness={0.2}
          roughness={0.4}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh position={[0, shaftLength + headLength / 2, 0]}>
        <coneGeometry args={[headWidth, headLength, 3]} />
        <meshStandardMaterial
          color="#2196F3"
          emissive="#2196F3"
          emissiveIntensity={0.5}
          metalness={0.2}
          roughness={0.4}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
});

DirectionArrow.displayName = 'DirectionArrow';
