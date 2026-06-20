import React, { useRef, useMemo, useState, useEffect } from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import { useAppStore, ViewMode, Tool } from '../store';
import { useShallow } from 'zustand/react/shallow';
import { extractFacesFromGeometry, groupCoplanarFaces, createFaceHighlightGeometry } from './FaceEditor';

// Threshold must match isAxisAligned() in GeometryUtils (0.999) so that any
// face groupCoplanarFaces considers "curved" is also considered non-flat here.
// Using 0.9 was too permissive: fillet arc faces near the flat-face boundary
// (abs(normal) ≈ 0.95–0.998) passed as flat and got extruded instead of snapping.
const FLAT_NORMAL_THRESHOLD = 0.999;

function snapToFlatGroup(gi: number, groups: ReturnType<typeof groupCoplanarFaces>): number {
  if (gi < 0 || gi >= groups.length) return gi;
  const n = groups[gi].normal.clone().normalize();
  const isFlat = Math.abs(n.x) > FLAT_NORMAL_THRESHOLD || Math.abs(n.y) > FLAT_NORMAL_THRESHOLD || Math.abs(n.z) > FLAT_NORMAL_THRESHOLD;
  if (isFlat) return gi;
  const axisOf = (v: THREE.Vector3) => {
    const a = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)];
    const i = a.indexOf(Math.max(...a));
    return i === 0 ? (v.x > 0 ? 'X+' : 'X-') : i === 1 ? (v.y > 0 ? 'Y+' : 'Y-') : (v.z > 0 ? 'Z+' : 'Z-');
  };
  const axLbl = axisOf(n);
  const center = groups[gi].center;
  let bestIdx = gi, bestDist = Infinity;
  groups.forEach((g, idx) => {
    const gn = g.normal.clone().normalize();
    const flat = Math.abs(gn.x) > FLAT_NORMAL_THRESHOLD || Math.abs(gn.y) > FLAT_NORMAL_THRESHOLD || Math.abs(gn.z) > FLAT_NORMAL_THRESHOLD;
    if (flat && axisOf(gn) === axLbl) {
      const d = g.center.distanceTo(center);
      if (d < bestDist) { bestDist = d; bestIdx = idx; }
    }
  });
  return bestIdx;
}

// ─── RENK YÖNETİMİ ───────────────────────────────────────────────────────
const PANEL_COLORS = {
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
  isSelected,
}) => {
  const meshRef = useRef<THREE.Mesh>(null);
  const groupRef = useRef<THREE.Group>(null);
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
    setFaceExtrudeClickPoint,
    raycastMode,
    activeTool,
    panelMoveTargetId,
    setPanelMoveActiveAxis,
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
    setFaceExtrudeClickPoint: state.setFaceExtrudeClickPoint,
    raycastMode: state.raycastMode,
    activeTool: state.activeTool,
    panelMoveTargetId: state.panelMoveTargetId,
    setPanelMoveActiveAxis: state.setPanelMoveActiveAxis,
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

  // ── Move mode: zero point + arrow axes ────────────────────────────────────
  const isMoveMode = activeTool === Tool.MOVE && panelMoveTargetId === shape.id;

  const zeroPointLocal = useMemo((): THREE.Vector3 | null => {
    if (!isMoveMode || !shape.geometry) return null;
    const pos = shape.geometry.getAttribute('position');
    if (!pos) return null;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getX(i) < minX) minX = pos.getX(i);
      if (pos.getY(i) < minY) minY = pos.getY(i);
      if (pos.getZ(i) < minZ) minZ = pos.getZ(i);
    }
    return new THREE.Vector3(minX, minY, minZ);
  }, [isMoveMode, shape.geometry]);

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

  const baseColor = shape.color || '#ffffff';
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
    <>
    <group
      ref={groupRef}
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
          {...(isMoveMode ? { raycast: () => null } : {})}
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
                const raw = faceGroups.findIndex(g => g.faceIndices.includes(fi));
                if (raw !== -1) {
                  const gi = snapToFlatGroup(raw, faceGroups);
                  setFaceExtrudeSelectedFace(gi);
                  setHoveredExtrudeGroup(gi);
                  setFaceExtrudeHoveredFace(gi);
                  // Convert world-space click to local space so the extrude
                  // service can use it as a sample point for face matching.
                  if (e.point) {
                    const pos = new THREE.Vector3(shape.position[0], shape.position[1], shape.position[2]);
                    const quat = new THREE.Quaternion().setFromEuler(
                      new THREE.Euler(shape.rotation[0], shape.rotation[1], shape.rotation[2], 'XYZ')
                    );
                    const scl = new THREE.Vector3(shape.scale[0], shape.scale[1], shape.scale[2]);
                    const m = new THREE.Matrix4().compose(pos, quat, scl).invert();
                    const local = e.point.clone().applyMatrix4(m);
                    setFaceExtrudeClickPoint([local.x, local.y, local.z]);
                  }
                }
              }
            }}
            onPointerMove={(e: any) => {
              e.stopPropagation();
              const fi = e.faceIndex;
              if (fi !== undefined && fi !== null) {
                const raw = faceGroups.findIndex(g => g.faceIndices.includes(fi));
                if (raw !== -1) {
                  const gi = snapToFlatGroup(raw, faceGroups);
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

      {/* ── MOVE MODE ARROWS ────────────────────────────────────────────── */}
      {isMoveMode && zeroPointLocal && (() => {
        const zp = zeroPointLocal;
        const AL = 80; // arrow total length
        const SR = 3.5; // shaft radius
        const HR = 8.5; // head radius
        const HL = 20; // head length
        const SL = AL - HL;
        const HIT_R = 18; // hit area radius (larger for easier clicking)
        const axes: Array<{ axis: 'X'|'Y'|'Z'; dir: THREE.Vector3; color: string }> = [
          { axis: 'X', dir: new THREE.Vector3(1, 0, 0), color: '#ef4444' },
          { axis: 'Y', dir: new THREE.Vector3(0, 1, 0), color: '#22c55e' },
          { axis: 'Z', dir: new THREE.Vector3(0, 0, 1), color: '#3b82f6' },
        ];
        return axes.map(({ axis, dir, color }) => {
          const shaftPos = new THREE.Vector3().copy(zp).addScaledVector(dir, SL / 2);
          const headPos = new THREE.Vector3().copy(zp).addScaledVector(dir, SL + HL / 2);
          const centerPos = new THREE.Vector3().copy(zp).addScaledVector(dir, AL / 2);
          const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
          return (
            <group key={axis}>
              {/* Invisible wide hit area — always on top of panel mesh */}
              <mesh
                position={centerPos}
                quaternion={q}
                renderOrder={20}
                onClick={(e) => { e.stopPropagation(); setPanelMoveActiveAxis(axis); }}
                onPointerEnter={() => { (document.body.style as any).cursor = 'pointer'; }}
                onPointerLeave={() => { (document.body.style as any).cursor = 'default'; }}
              >
                <cylinderGeometry args={[HIT_R, HIT_R, AL, 8]} />
                <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />
              </mesh>
              {/* Visual shaft */}
              <mesh position={shaftPos} quaternion={q} renderOrder={15}>
                <cylinderGeometry args={[SR, SR, SL, 8]} />
                <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.92} />
              </mesh>
              {/* Visual head */}
              <mesh position={headPos} quaternion={q} renderOrder={15}>
                <coneGeometry args={[HR, HL, 8]} />
                <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.92} />
              </mesh>
            </group>
          );
        });
      })()}

      {/* Zero point sphere */}
      {isMoveMode && zeroPointLocal && (
        <mesh position={zeroPointLocal} renderOrder={15}>
          <sphereGeometry args={[8, 12, 12]} />
          <meshBasicMaterial color="#f59e0b" depthTest={false} transparent opacity={0.95} />
        </mesh>
      )}
    </group>
  </>
  );
});
