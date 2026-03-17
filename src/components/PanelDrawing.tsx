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

  // Görünüm Modları
  const isWireframe = viewMode === ViewMode.WIREFRAME;
  const isXray = viewMode === ViewMode.XRAY;

  // Renk Hesaplama
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

  // ─── MeshPhysicalMaterial Parametreleri ──────────────────────────────────────
  const physicalProps = useMemo(() => ({
    color: materialColor,
    emissive: isPanelRowSelected ? PANEL_COLORS.selected.panelEmissive : '#000000',
    emissiveIntensity: isPanelRowSelected ? 0.25 : 0,
    
    // Gerçekçilik Ayarları
    metalness: 0.0,           // Mobilya panelleri genelde metalik değildir
    roughness: 0.2,           // Hafif pürüzsüz, kaliteli bir yüzey
    
    // Vernik (Cila) Etkisi
    clearcoat: 1.0,           // Yüzeyde ekstra bir parlak katman
    clearcoatRoughness: 0.1,  // Ciladaki yansıma netliği
    
    // Kumaşsı/Yumuşak Parlama (Kenar hatları için)
    sheen: 0.5,               
    sheenRoughness: 0.2,
    sheenColor: new THREE.Color('#ffffff'),

    // X-Ray & Opacity Ayarları
    transparent: isXray,
    opacity: isXray ? 0.45 : 1,
    depthWrite: !isXray,      // Şeffaf modda derinlik hatalarını önler
    side: THREE.DoubleSide,
  }), [materialColor, isPanelRowSelected, isXray]);

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
    const targetShapeId = (panelSurfaceSelectMode || panelSelectMode) && parentShapeId ? parentShapeId : shape.id;
    if (selectedShapeId !== targetShapeId) selectShape(targetShapeId);
    if ((panelSurfaceSelectMode || panelSelectMode) && parentShapeId) {
      setSelectedPanelRow(faceIndex ?? null, extraRowId || null, parentShapeId);
    }
    selectSecondaryShape(null);
  };

  if (!shape.geometry) return null;

  return (
    <group
      name={`shape-${shape.id}`}
      position={shape.position}
      rotation={shape.rotation}
      scale={shape.scale}
    >
      {/* 1. ANA GÖVDE (Solid veya X-Ray) */}
      {!isWireframe && (
        <mesh
          ref={meshRef}
          geometry={shape.geometry}
          castShadow
          receiveShadow
          onClick={handleClick}
        >
          <meshPhysicalMaterial {...physicalProps} />
        </mesh>
      )}

      {/* 2. WIREFRAME INTERACTION (Sadece tıklama yakalamak için) */}
      {isWireframe && (
        <mesh
          ref={meshRef}
          geometry={shape.geometry}
          visible={false}
          onClick={handleClick}
        />
      )}

      {/* 3. KENAR ÇİZGİLERİ (EDGES) */}
      {edgeGeometry && (
        <lineSegments geometry={edgeGeometry}>
          <lineBasicMaterial
            color={edgeColor}
            linewidth={isPanelRowSelected ? 3 : isSelected ? 2.5 : 2}
            transparent={true}
            opacity={isWireframe ? 0.8 : 1}
            depthTest={true}
          />
        </lineSegments>
      )}

      {/* 4. YÖN OKU */}
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

// ─── DirectionArrow Bileşeni (Geliştirilmiş Materyal) ──────────────────────────
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
    let defaultAxis = planeAxes[0];
    let altAxis = planeAxes[1];

    if ((role === 'left' || role === 'right') && planeAxes.includes(1)) {
        defaultAxis = 1;
        altAxis = planeAxes.find(a => a !== 1) ?? planeAxes[1];
    } else if ((role === 'top' || role === 'bottom') && planeAxes.includes(0)) {
        defaultAxis = 0;
        altAxis = planeAxes.find(a => a !== 0) ?? planeAxes[1];
    }

    const targetAxis = arrowRotated ? altAxis : defaultAxis;
    const rotation: [number, number, number] = targetAxis === 0 ? [0, 0, -Math.PI / 2] : targetAxis === 2 ? [Math.PI / 2, 0, 0] : [0, 0, 0];

    return { position: [arrowPosition.x, arrowPosition.y, arrowPosition.z] as [number, number, number], rotation };
  }, [geometry, faceRole, arrowRotated]);

  if (!arrowConfig) return null;

  const { position, rotation } = arrowConfig;
  const commonMatProps = {
    color: PANEL_COLORS.arrow.color,
    emissive: PANEL_COLORS.arrow.emissive,
    emissiveIntensity: 0.6,
    metalness: 0.6,
    roughness: 0.1,
    clearcoat: 1.0
  };

  return (
    <group position={position} rotation={rotation}>
      <mesh position={[0, 45, 0]}>
        <cylinderGeometry args={[1.8, 1.8, 90, 16]} />
        <meshPhysicalMaterial {...commonMatProps} />
      </mesh>
      <mesh position={[0, 104, 0]}>
        <coneGeometry args={[10, 28, 16]} />
        <meshPhysicalMaterial {...commonMatProps} />
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