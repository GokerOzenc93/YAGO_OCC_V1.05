import React, { useRef, useMemo, useState, useEffect } from 'react';
import * as THREE from 'three';
import { useAppStore, ViewMode } from '../store';
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
    triggerPanelCreationForFace,
    viewMode,
    editingPanelId
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
    viewMode: state.viewMode,
    editingPanelId: state.editingPanelId
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

  const isEditingThisPanel = editingPanelId === shape.id;

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

  const axisEdgeData = useMemo(() => {
    if (!shape.geometry || !isEditingThisPanel) return null;
    try {
      const posAttr = shape.geometry.getAttribute('position') as THREE.BufferAttribute;
      if (!posAttr) return null;

      const bbox = new THREE.Box3().setFromBufferAttribute(posAttr);
      const min = bbox.min;
      const max = bbox.max;

      const eps = 0.001;

      const xEdges: [THREE.Vector3, THREE.Vector3][] = [];
      const yEdges: [THREE.Vector3, THREE.Vector3][] = [];
      const zEdges: [THREE.Vector3, THREE.Vector3][] = [];

      const edgesGeo = new THREE.EdgesGeometry(shape.geometry, 5);
      const edgePosAttr = edgesGeo.getAttribute('position') as THREE.BufferAttribute;

      for (let i = 0; i < edgePosAttr.count; i += 2) {
        const v1 = new THREE.Vector3(
          edgePosAttr.getX(i), edgePosAttr.getY(i), edgePosAttr.getZ(i)
        );
        const v2 = new THREE.Vector3(
          edgePosAttr.getX(i + 1), edgePosAttr.getY(i + 1), edgePosAttr.getZ(i + 1)
        );

        const dx = Math.abs(v2.x - v1.x);
        const dy = Math.abs(v2.y - v1.y);
        const dz = Math.abs(v2.z - v1.z);

        const isAlongX = dx > eps && dy < eps && dz < eps;
        const isAlongY = dy > eps && dx < eps && dz < eps;
        const isAlongZ = dz > eps && dx < eps && dy < eps;

        const onMinX = Math.abs(v1.x - min.x) < eps && Math.abs(v2.x - min.x) < eps;
        const onMaxX = Math.abs(v1.x - max.x) < eps && Math.abs(v2.x - max.x) < eps;
        const onMinY = Math.abs(v1.y - min.y) < eps && Math.abs(v2.y - min.y) < eps;
        const onMaxY = Math.abs(v1.y - max.y) < eps && Math.abs(v2.y - max.y) < eps;
        const onMinZ = Math.abs(v1.z - min.z) < eps && Math.abs(v2.z - min.z) < eps;
        const onMaxZ = Math.abs(v1.z - max.z) < eps && Math.abs(v2.z - max.z) < eps;

        if (isAlongX) {
          xEdges.push([v1, v2]);
        } else if (isAlongY) {
          yEdges.push([v1, v2]);
        } else if (isAlongZ) {
          zEdges.push([v1, v2]);
        } else if (dx > eps || dy > eps || dz > eps) {
          if (onMinX || onMaxX) xEdges.push([v1, v2]);
          else if (onMinY || onMaxY) yEdges.push([v1, v2]);
          else if (onMinZ || onMaxZ) zEdges.push([v1, v2]);
        }
      }

      const buildLineGeo = (pairs: [THREE.Vector3, THREE.Vector3][]) => {
        if (pairs.length === 0) return null;
        const positions: number[] = [];
        for (const [a, b] of pairs) {
          positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        return geo;
      };

      return {
        x: buildLineGeo(xEdges),
        y: buildLineGeo(yEdges),
        z: buildLineGeo(zEdges),
        bbox: { min, max }
      };
    } catch {
      return null;
    }
  }, [shape.geometry, isEditingThisPanel]);

  if (!shape.geometry) return null;

  const isWireframe = viewMode === ViewMode.WIREFRAME;
  const isXray = viewMode === ViewMode.XRAY;

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
  const edgeColor = shouldHighlightRed ? '#b91c1c' : isSelected ? '#1e40af' : '#1a1a1a';

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
      setSelectedPanelRow(faceIndex ?? null, extraRowId || null);
      selectSecondaryShape(null);
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
                color={isSelected ? '#60a5fa' : '#1a1a1a'}
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
              emissive={isPanelRowSelected ? '#ef4444' : baseColor}
              emissiveIntensity={isPanelRowSelected ? 0.35 : 0.1}
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
      {!isWireframe && !isXray && edgeGeometry && !isEditingThisPanel && (
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

      {isEditingThisPanel && axisEdgeData && (
        <>
          {axisEdgeData.x && (
            <lineSegments geometry={axisEdgeData.x} renderOrder={10}>
              <lineBasicMaterial
                color="#ef4444"
                linewidth={4}
                depthTest={false}
                transparent={false}
              />
            </lineSegments>
          )}
          {axisEdgeData.y && (
            <lineSegments geometry={axisEdgeData.y} renderOrder={10}>
              <lineBasicMaterial
                color="#22c55e"
                linewidth={4}
                depthTest={false}
                transparent={false}
              />
            </lineSegments>
          )}
          {axisEdgeData.z && (
            <lineSegments geometry={axisEdgeData.z} renderOrder={10}>
              <lineBasicMaterial
                color="#3b82f6"
                linewidth={4}
                depthTest={false}
                transparent={false}
              />
            </lineSegments>
          )}
        </>
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

interface AxisEdgeLabelsProps {
  geometry: THREE.BufferGeometry;
  axisData: { x: THREE.BufferGeometry | null; y: THREE.BufferGeometry | null; z: THREE.BufferGeometry | null; bbox: { min: THREE.Vector3; max: THREE.Vector3 } };
}

const AxisEdgeLabels: React.FC<AxisEdgeLabelsProps> = React.memo(({ geometry, axisData }) => {
  const labelData = useMemo(() => {
    const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
    if (!posAttr) return null;
    const bbox = new THREE.Box3().setFromBufferAttribute(posAttr);
    const min = bbox.min;
    const max = bbox.max;
    const size = new THREE.Vector3();
    bbox.getSize(size);

    const axes = [
      { index: 0, value: size.x, label: 'X', color: '#ef4444' },
      { index: 1, value: size.y, label: 'Y', color: '#22c55e' },
      { index: 2, value: size.z, label: 'Z', color: '#3b82f6' }
    ];

    const cx = (min.x + max.x) / 2;
    const cy = (min.y + max.y) / 2;
    const cz = (min.z + max.z) / 2;

    const offset = 40;

    return [
      { label: `X: ${Math.round(size.x)}`, color: '#ef4444', pos: new THREE.Vector3(cx, min.y - offset, min.z - offset) },
      { label: `Y: ${Math.round(size.y)}`, color: '#22c55e', pos: new THREE.Vector3(max.x + offset, cy, min.z - offset) },
      { label: `Z: ${Math.round(size.z)}`, color: '#3b82f6', pos: new THREE.Vector3(max.x + offset, min.y - offset, cz) },
    ];
  }, [geometry]);

  if (!labelData) return null;

  return (
    <>
      {labelData.map(({ label, color, pos }) => (
        <AxisLabel key={label} position={pos} text={label} color={color} />
      ))}
    </>
  );
});

AxisEdgeLabels.displayName = 'AxisEdgeLabels';

interface AxisLabelProps {
  position: THREE.Vector3;
  text: string;
  color: string;
}

const AxisLabel: React.FC<AxisLabelProps> = React.memo(({ position, text, color }) => {
  const labelGeo = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 96;
    const ctx = canvas.getContext('2d')!;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = 'rgba(15,15,15,0.82)';
    const rx = 12;
    const w = canvas.width, h = canvas.height;
    ctx.beginPath();
    ctx.moveTo(rx, 0);
    ctx.lineTo(w - rx, 0);
    ctx.quadraticCurveTo(w, 0, w, rx);
    ctx.lineTo(w, h - rx);
    ctx.quadraticCurveTo(w, h, w - rx, h);
    ctx.lineTo(rx, h);
    ctx.quadraticCurveTo(0, h, 0, h - rx);
    ctx.lineTo(0, rx);
    ctx.quadraticCurveTo(0, 0, rx, 0);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = color;
    ctx.lineWidth = 5;
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.font = 'bold 52px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }, [text, color]);

  return (
    <sprite position={[position.x, position.y, position.z]} scale={[160, 60, 1]}>
      <spriteMaterial
        map={labelGeo}
        transparent={true}
        depthTest={false}
        sizeAttenuation={true}
      />
    </sprite>
  );
});

AxisLabel.displayName = 'AxisLabel';

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
