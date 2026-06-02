import React, { useRef, useMemo, useState, useEffect } from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import { useAppStore, ViewMode } from '../store';
import { useShallow } from 'zustand/react/shallow';
import { extractFacesFromGeometry, groupCoplanarFaces, createFaceHighlightGeometry } from './FaceEditor';

// ─── RENK YÖNETİMİ ───────────────────────────────────────────────────────
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
    default: '#ffffff',
  },
  selected: {
    panel:         '#ff0000',
    panelEmissive: '#330000',
    edge:          '#111418',
    shapeEdge:     '#111418',
  },
  edge: {
    // Yumuşak gri — koyu siyah yerine. Düşük belirginlik + birleşim
    // yerlerinde ağır görünmez.
    default: '#5b6470',
  },
  arrow: {
    color:    '#f1c40f',
    emissive: '#f1c40f',
  },
} as const;

// ─── Z-FIGHTING + ÇİZGİ KALİTESİ ─────────────────────────────────────────
//
// Mesh hafif positive polygonOffset alır (kendi edge'inin altına iner),
// edge negative polygonOffset alır (mesh'in üzerinde net çizilir).
// Kenarlar drei <Line> (Line2 / LineMaterial) ile çizilir: antialias'lı,
// kesintisiz, gerçek piksel genişliğinde. Çizgiler OPAK — iki komşu panelin
// kenarı aynı yere denk gelse bile üst üste binip koyulaşmaz.
const MESH_OFFSET_FACTOR = 1.0;
const MESH_OFFSET_UNITS  = 1.0;
const EDGE_OFFSET_FACTOR = -1.0;
const EDGE_OFFSET_UNITS  = -2.0;
const EDGE_RENDER_ORDER  = 1;

// En ince pürüzsüz çizgi (piksel). Belirginlik renk açıklığıyla ayarlanır.
const EDGE_LINE_WIDTH = 1.0;

// Edge tespit eşiği — gereksiz iç üçgen kenarlarını eler.
const EDGE_ANGLE_THRESHOLD = 15;

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
    faceExtrudeMode,
    faceExtrudeTargetPanelId,
    setFaceExtrudeHoveredFace,
    faceExtrudeSelectedFace,
    setFaceExtrudeSelectedFace,
    raycastMode
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
    faceExtrudeMode: state.faceExtrudeMode,
    faceExtrudeTargetPanelId: state.faceExtrudeTargetPanelId,
    setFaceExtrudeHoveredFace: state.setFaceExtrudeHoveredFace,
    faceExtrudeSelectedFace: state.faceExtrudeSelectedFace,
    setFaceExtrudeSelectedFace: state.setFaceExtrudeSelectedFace,
    raycastMode: state.raycastMode
  })));

  const [faceGroups, setFaceGroups] = useState<any[]>([]);
  const [faces, setFaces] = useState<any[]>([]);
  const [hoveredExtrudeGroup, setHoveredExtrudeGroup] = useState<number | null>(null);

  useEffect(() => {
    if (!shape.geometry) return;
    const f = extractFacesFromGeometry(shape.geometry);
    const groups = groupCoplanarFaces(f);
    setFaces(f);
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

  // Edge geometrisi — orijinal geometriden, hiç bozulma yok
  const edgeGeometry = useMemo(() => {
    if (!shape.geometry) return null;
    try {
      return new THREE.EdgesGeometry(shape.geometry, EDGE_ANGLE_THRESHOLD);
    } catch (error) {
      return null;
    }
  }, [shape.geometry]);

  // EdgesGeometry'yi <Line segments> için nokta çiftlerine çeviriyoruz.
  const edgePoints = useMemo<[number, number, number][] | null>(() => {
    if (!edgeGeometry) return null;
    const pos = edgeGeometry.getAttribute('position');
    if (!pos) return null;
    const pts: [number, number, number][] = [];
    for (let i = 0; i < pos.count; i++) {
      pts.push([pos.getX(i), pos.getY(i), pos.getZ(i)]);
    }
    return pts.length ? pts : null;
  }, [edgeGeometry]);

  const isFaceExtrudeTarget = faceExtrudeMode && shape.id === faceExtrudeTargetPanelId;
  const isFaceExtrudeXray = faceExtrudeMode && shape.id !== faceExtrudeTargetPanelId;
  const isRaycastOnParent = raycastMode && parentShapeId && parentShapeId === selectedShapeId;
  const disableRaycast = isFaceExtrudeTarget || isFaceExtrudeXray || isRaycastOnParent;

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    if (disableRaycast) {
      mesh.raycast = () => {};
    } else {
      mesh.raycast = THREE.Mesh.prototype.raycast;
    }
  }, [disableRaycast]);

  const extrudeHighlightGeometry = useMemo(() => {
    if (!isFaceExtrudeTarget || hoveredExtrudeGroup === null || !faceGroups[hoveredExtrudeGroup] || faces.length === 0) return null;
    if (hoveredExtrudeGroup === faceExtrudeSelectedFace) return null;
    return createFaceHighlightGeometry(faces, faceGroups[hoveredExtrudeGroup].faceIndices);
  }, [isFaceExtrudeTarget, hoveredExtrudeGroup, faceGroups, faces, faceExtrudeSelectedFace]);

  const extrudeSelectedGeometry = useMemo(() => {
    if (!isFaceExtrudeTarget || faceExtrudeSelectedFace === null || !faceGroups[faceExtrudeSelectedFace] || faces.length === 0) return null;
    return createFaceHighlightGeometry(faces, faceGroups[faceExtrudeSelectedFace].faceIndices);
  }, [isFaceExtrudeTarget, faceExtrudeSelectedFace, faceGroups, faces]);

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
  const edgeWidth = (isSelected || isPanelRowSelected) ? EDGE_LINE_WIDTH + 0.5 : EDGE_LINE_WIDTH;

  const handleClick = (e: any) => {
    e.stopPropagation();
    if (isFaceExtrudeTarget) return;
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
      const rowKey = virtualFaceId ? `vf-${virtualFaceId}` : (faceIndex ?? null);
      setSelectedPanelRow(rowKey, extraRowId || null, parentShapeId);
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
      {/* ── SOLID MOD ────────────────────────────────────────────────── */}
      {!isWireframe && !isXray && (
        <mesh
          ref={meshRef}
          geometry={shape.geometry}
          castShadow
          receiveShadow
          onClick={handleClick}
        >
          <meshLambertMaterial
            color={materialColor}
            emissive={isPanelRowSelected ? PANEL_COLORS.selected.panelEmissive : '#2a2a2a'}
            emissiveIntensity={1}
            side={THREE.DoubleSide}
            transparent={isFaceExtrudeXray}
            opacity={isFaceExtrudeXray ? 0.12 : 1}
            depthWrite={!isFaceExtrudeXray}
            polygonOffset
            polygonOffsetFactor={MESH_OFFSET_FACTOR}
            polygonOffsetUnits={MESH_OFFSET_UNITS}
          />
        </mesh>
      )}

      {!isWireframe && !isXray && edgePoints && (
        <Line
          points={edgePoints}
          segments
          color={edgeColor}
          lineWidth={edgeWidth}
          transparent={false}
          depthTest
          depthWrite
          polygonOffset
          polygonOffsetFactor={EDGE_OFFSET_FACTOR}
          polygonOffsetUnits={EDGE_OFFSET_UNITS}
          renderOrder={EDGE_RENDER_ORDER}
          raycast={() => null}
        />
      )}

      {/* ── WIREFRAME MOD ────────────────────────────────────────────── */}
      {isWireframe && edgePoints && (
        <Line
          points={edgePoints}
          segments
          color={edgeColor}
          lineWidth={edgeWidth}
          transparent={false}
          depthTest
          depthWrite
          renderOrder={EDGE_RENDER_ORDER}
          raycast={() => null}
        />
      )}

      {/* ── X-RAY MOD ────────────────────────────────────────────────── */}
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
              emissive={isPanelRowSelected ? PANEL_COLORS.selected.panelEmissive : '#2a2a2a'}
              emissiveIntensity={1}
              side={THREE.DoubleSide}
              transparent={true}
              opacity={0.35}
              depthWrite={false}
              polygonOffset
              polygonOffsetFactor={MESH_OFFSET_FACTOR}
              polygonOffsetUnits={MESH_OFFSET_UNITS}
            />
          </mesh>
          {edgePoints && (
            <Line
              points={edgePoints}
              segments
              color={edgeColor}
              lineWidth={edgeWidth}
              transparent={false}
              depthTest={false}
              depthWrite={false}
              renderOrder={EDGE_RENDER_ORDER}
              raycast={() => null}
            />
          )}
        </>
      )}

      {/* ── FACE EXTRUDE OVERLAY ─────────────────────────────────────── */}
      {isFaceExtrudeTarget && (
        <>
          <mesh
            geometry={shape.geometry}
            renderOrder={10}
            onPointerDown={(e: any) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              const fi = e.faceIndex;
              if (fi !== undefined && fi !== null) {
                const gi = faceGroups.findIndex(g => g.faceIndices.includes(fi));
                if (gi !== -1) {
                  setFaceExtrudeSelectedFace(gi);
                  setHoveredExtrudeGroup(gi);
                  setFaceExtrudeHoveredFace(gi);
                }
              }
            }}
            onPointerMove={(e: any) => {
              e.stopPropagation();
              const fi = e.faceIndex;
              if (fi !== undefined && fi !== null) {
                const gi = faceGroups.findIndex(g => g.faceIndices.includes(fi));
                if (gi !== -1) {
                  setHoveredExtrudeGroup(gi);
                  setFaceExtrudeHoveredFace(gi);
                }
              }
            }}
            onPointerOut={(e: any) => {
              e.stopPropagation();
              setHoveredExtrudeGroup(null);
              setFaceExtrudeHoveredFace(null);
            }}
          >
            <meshBasicMaterial transparent opacity={0.01} side={THREE.DoubleSide} depthTest={false} depthWrite={false} />
          </mesh>
          {extrudeHighlightGeometry && (
            <mesh geometry={extrudeHighlightGeometry} renderOrder={11}>
              <meshBasicMaterial
                color={0x38bdf8}
                transparent
                opacity={0.55}
                side={THREE.DoubleSide}
                depthTest={false}
                depthWrite={false}
              />
            </mesh>
          )}
          {extrudeSelectedGeometry && (
            <mesh geometry={extrudeSelectedGeometry} renderOrder={12}>
              <meshBasicMaterial
                color={0xf97316}
                transparent
                opacity={0.75}
                side={THREE.DoubleSide}
                depthTest={false}
                depthWrite={false}
              />
            </mesh>
          )}
        </>
      )}
    </group>
  );
});
