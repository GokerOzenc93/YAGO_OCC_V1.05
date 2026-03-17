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
    // Mevcut seçim logic'i korunuyor...
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
          {/* ULTRA KALİTE MATERYAL: 
            Panelin grileşmemesi için yansıma ve roughness dengesi kuruldu.
          */}
          <meshPhysicalMaterial
            color={materialColor}
            metalness={0.0}            // Tamamen dielektrik yüzey
            roughness={0.85}           // Grimsi yansımaları engellemek için yüzeyi hafif mat yaptık
            clearcoat={0.1}            // Çok hafif bir cila etkisi, derinlik katar
            clearcoatRoughness={0.1}
            reflectivity={0.2}         // Çevreden gelen gri ışığı çok az yansıtır
            envMapIntensity={1.0}      // Environment varsa beyazın parlamasını sağlar
            emissive={isPanelRowSelected ? PANEL_COLORS.selected.panelEmissive : '#000000'}
            emissiveIntensity={1}
            side={THREE.DoubleSide}
            polygonOffset              // Çizgilerle yüzeyin çakışmasını (z-fighting) önler
            polygonOffsetFactor={1}
            polygonOffsetUnits={1}
          />
        </mesh>
      )}

      {/* Kenar Çizgileri - Keskin ve Net */}
      {!isWireframe && edgeGeometry && (
        <lineSegments geometry={edgeGeometry} raycast={() => null}>
          <lineBasicMaterial
            color={edgeColor}
            linewidth={1}              // Tarayıcı limitleri dahilinde en ince keskin çizgi
            transparent={true}
            opacity={isSelected || isPanelRowSelected ? 1 : 0.4}
            depthTest={true}
          />
        </lineSegments>
      )}

      {/* Seçili Panel Satırı Görselleştirmesi */}
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

// ─── DirectionArrow (Yön Oku - Materyal Güncellendi) ─────────────────────────
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
        <meshStandardMaterial 
            color={PANEL_COLORS.arrow.color} 
            emissive={PANEL_COLORS.arrow.emissive} 
            emissiveIntensity={1.2} 
        />
      </mesh>
      <mesh position={[0, 104, 0]}>
        <coneGeometry args={[10, 28, 16]} />
        <meshStandardMaterial 
            color={PANEL_COLORS.arrow.color} 
            emissive={PANEL_COLORS.arrow.emissive} 
            emissiveIntensity={1.2} 
        />
      </mesh>
    </group>
  );
});

interface DirectionArrowProps {
  geometry: THREE.BufferGeometry;
  faceRole?: string;
  arrowRotated?: boolean;
}

PanelDrawing.displayName = 'PanelDrawing';
DirectionArrow.displayName = 'DirectionArrow';