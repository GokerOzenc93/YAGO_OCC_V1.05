import React, { useRef, useMemo, useState, useEffect } from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useAppStore, ViewMode } from '../store';
import { useShallow } from 'zustand/react/shallow';
import { extractFacesFromGeometry, groupCoplanarFaces, createFaceHighlightGeometry } from './FaceEditor';

// Threshold must match isAxisAligned() in GeometryUtils (0.999) so that any
// face groupCoplanarFaces considers "curved" is also considered non-flat here.
// Using 0.9 was too permissive: fillet arc faces near the flat-face boundary
// (abs(normal) ≈ 0.95–0.998) passed as flat and got extruded instead of snapping.
const FLAT_NORMAL_THRESHOLD = 0.999;

function snapToFlatGroup(gi: number, groups: ReturnType<typeof groupCoplanarFaces>): number {
  if (gi < 0 || gi >= groups.length) return gi;
  const group = groups[gi];
  const n = group.normal.clone().normalize();
  const isFlat = Math.abs(n.x) > FLAT_NORMAL_THRESHOLD || Math.abs(n.y) > FLAT_NORMAL_THRESHOLD || Math.abs(n.z) > FLAT_NORMAL_THRESHOLD;
  if (isFlat) return gi;
  // If the group is not marked as curved (it's a coplanar flat surface like a miter cut),
  // keep it as-is rather than snapping to a nearby axis-aligned face.
  if (!group.isCurved) return gi;
  const axisOf = (v: THREE.Vector3) => {
    const a = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)];
    const i = a.indexOf(Math.max(...a));
    return i === 0 ? (v.x > 0 ? 'X+' : 'X-') : i === 1 ? (v.y > 0 ? 'Y+' : 'Y-') : (v.z > 0 ? 'Z+' : 'Z-');
  };
  const axLbl = axisOf(n);
  const center = group.center;
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
// Seçim profesyonel CAD konvansiyonuyla: DOLGU asla değişmez, vurgu kenardan
// (doygun aksan rengi + kalın stroke) ve seçili panelde çapraz TARAMA ile gelir.
const PANEL_COLORS = {
  selected: {
    // Şekil (parent) seçili kenar aksanı.
    shapeEdge:     '#e8590c',
    // Tarama (hatch) çizgi rengi — belli belirsiz, grimsi.
    hatch:         '#8a9097',
    // Nötr emissive — panel dolgusu seçimde solmaz.
    panelEmissive: '#2a2a2a',
  },
  edge: {
    // Yumuşak gri — koyu siyah yerine. Düşük belirginlik + birleşim
    // yerlerinde ağır görünmez.
    default: '#5b6470',
  },
  arrow: {
    fill:    '#ff0000',  // tam kırmızı — 2B ok gövdesi
    outline: '#7f1d1d',  // koyu kırmızı kenar (red-900)
  },
} as const;

// ─── SEÇİM TARAMASI (HATCH) ──────────────────────────────────────────────
// 45° çapraz çizgiler, EKRAN UZAYINDA sabit aralıklı (gl_FragCoord). Panel
// ölçeğinden / UV'den bağımsız → her panelde aynı sıklıkta, gerçek CAD taraması.
// Çizgiler arası boşluk şeffaf (discard) — "soft wash" yok, net tarama var.
const HATCH_VERT = /* glsl */`
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const HATCH_FRAG = /* glsl */`
  precision mediump float;
  uniform vec3  uColor;
  uniform float uSpacing;     // çizgiler arası (CSS px)
  uniform float uThickness;   // çizgi kalınlığı (CSS px)
  uniform float uOpacity;
  uniform float uPixelRatio;  // CSS px → cihaz pikseli (drei <Line> ile eşleşsin diye)
  void main() {
    float pr = max(uPixelRatio, 1.0);
    float d = gl_FragCoord.x + gl_FragCoord.y;      // 45° diagonal
    float m = mod(d, uSpacing * pr);
    float t = uThickness * pr;
    // ~1px yumuşak kenarla antialias
    float line = 1.0 - smoothstep(t, t + pr, m);
    if (line < 0.02) discard;
    gl_FragColor = vec4(uColor, uOpacity * line);
  }
`;

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
  const { gl } = useThree();
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
    setFaceExtrudeClickPoint: state.setFaceExtrudeClickPoint,
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
  const faceRole = shape.parameters?.faceRole;
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

  // Seçim taraması materyali — tek instance, hook sırası bozulmasın diye
  // erken return'den ÖNCE kuruluyor.
  const hatchMaterial = useMemo(() => new THREE.ShaderMaterial({
    uniforms: {
      uColor:      { value: new THREE.Color(PANEL_COLORS.selected.hatch) },
      uSpacing:    { value: 7.0 },   // CSS px — çizgiler arası
      uThickness:  { value: 2.0 },   // CSS px — outline ağırlığında + bir tık
      uOpacity:    { value: 0.35 },
      uPixelRatio: { value: 1.0 },
    },
    vertexShader: HATCH_VERT,
    fragmentShader: HATCH_FRAG,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  }), []);

  // Tarama kalınlığı/aralığı CSS px; cihaz pikseline ölçekle ki drei <Line>
  // (Line2, CSS px) ile aynı görünür kalınlıkta olsun.
  useEffect(() => {
    hatchMaterial.uniforms.uPixelRatio.value = gl.getPixelRatio();
  }, [gl, hatchMaterial]);

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

  const baseColor = shape.color || '#ffffff';
  // Dolgu seçimde değişmez — seçim yalnız kırmızı tarama ile gösterilir.
  const materialColor = baseColor;
  // Seçili panelin kenarı normal kalır (siyah kalın çerçeve yok); seçim
  // kırmızı tarama ile gösterilir. Parent seçimde turuncu aksan korunur.
  const edgeColor = isSelected ? PANEL_COLORS.selected.shapeEdge : PANEL_COLORS.edge.default;
  const edgeWidth = isSelected ? EDGE_LINE_WIDTH + 1.5 : EDGE_LINE_WIDTH;

  // Tarama yalnız panel satırı seçiliyken ve dolgu görünen modlarda.
  const showHatch = isPanelRowSelected && !isWireframe;

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

      {/* Seçim taraması (solid mod) */}
      {showHatch && !isXray && (
        <mesh geometry={shape.geometry} renderOrder={2} raycast={() => null}>
          <primitive object={hatchMaterial} attach="material" />
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
          {/* Seçim taraması (x-ray mod) */}
          {showHatch && (
            <mesh geometry={shape.geometry} renderOrder={2} raycast={() => null}>
              <primitive object={hatchMaterial} attach="material" />
            </mesh>
          )}
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
                color={0xff0000}
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
                color={0xff0000}
                transparent
                opacity={0.85}
                side={THREE.DoubleSide}
                depthTest={false}
                depthWrite={false}
              />
            </mesh>
          )}
        </>
      )}

      {/* ── PANEL YÖN OKU (seçili panel satırında) ──────────────────── */}
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

// ─── DirectionArrow (Yön Oku — düz/2B mavi) ──────────────────────────────
// Panelin yüzeyine yatık duran, ışıktan etkilenmeyen (flat) mavi ok. Kalın
// çubuk + koni baş tek bir düz silüet (ShapeGeometry) olarak çizilir; koyu
// mavi ince kenar çizgisi profesyonel görünüm verir. depthTest=false ile her
// zaman panelin üstünde net görünür. Yön, arrowRotated ile değişir.
interface DirectionArrowProps {
  geometry: THREE.BufferGeometry;
  faceRole?: string;
  arrowRotated?: boolean;
}

const DirectionArrow: React.FC<DirectionArrowProps> = React.memo(({
  geometry,
  faceRole,
  arrowRotated = false,
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
      { index: 2, value: size.z },
    ].sort((a, b) => a.value - b.value);

    const thinAxisIndex = axes[0].index;
    const thinHalf = axes[0].value / 2;
    const planeAxes = axes.slice(1).map(a => a.index).sort((a, b) => a - b);

    const role = faceRole?.toLowerCase();
    let targetAxis = (role === 'left' || role === 'right') && planeAxes.includes(1) ? 1 :
                     (role === 'top' || role === 'bottom') && planeAxes.includes(0) ? 0 : planeAxes[0];
    if (arrowRotated) targetAxis = planeAxes.find(a => a !== targetAxis) ?? planeAxes[1];
    const otherAxis = planeAxes.find(a => a !== targetAxis) ?? planeAxes[1];

    // Yüzey düzlemi tabanı: dirVec=ok yönü, perpVec=düzlemde dik, zAxis=normal
    const dirVec  = new THREE.Vector3().setComponent(targetAxis, 1);
    const perpVec = new THREE.Vector3().setComponent(otherAxis, 1);
    const zAxis   = new THREE.Vector3().crossVectors(dirVec, perpVec).normalize();
    const basis = new THREE.Matrix4().makeBasis(dirVec, perpVec, zAxis);
    const quat = new THREE.Quaternion().setFromRotationMatrix(basis);

    // İnce eksen boyunca hafif dışa ofset (yüzeye otursun, z-fight olmasın)
    const normalUnit = new THREE.Vector3().setComponent(thinAxisIndex, 1);
    const position = center.clone().addScaledVector(normalUnit, thinHalf + 3);

    // Düz ok silüeti (+X yönünde), panele oranlı boyut
    const planeSpan = Math.min(size.getComponent(planeAxes[0]), size.getComponent(planeAxes[1]));
    const L  = THREE.MathUtils.clamp(planeSpan * 0.5, 90, 260);
    const sw = L * 0.20;   // kalın çubuk genişliği
    const hw = L * 0.46;   // ok başı genişliği
    const hl = L * 0.34;   // ok başı uzunluğu
    const sx = -L / 2, ex = L / 2, neck = ex - hl;

    const shape = new THREE.Shape();
    shape.moveTo(sx, -sw / 2);
    shape.lineTo(neck, -sw / 2);
    shape.lineTo(neck, -hw / 2);
    shape.lineTo(ex, 0);
    shape.lineTo(neck, hw / 2);
    shape.lineTo(neck, sw / 2);
    shape.lineTo(sx, sw / 2);
    shape.closePath();

    const arrowGeo = new THREE.ShapeGeometry(shape);
    const outline: [number, number, number][] = [
      [sx, -sw / 2, 0], [neck, -sw / 2, 0], [neck, -hw / 2, 0], [ex, 0, 0],
      [neck, hw / 2, 0], [neck, sw / 2, 0], [sx, sw / 2, 0], [sx, -sw / 2, 0],
    ];

    return {
      position: position.toArray() as [number, number, number],
      quaternion: quat.toArray() as [number, number, number, number],
      arrowGeo,
      outline,
    };
  }, [geometry, faceRole, arrowRotated]);

  // ShapeGeometry'yi bağımlılık değişince/unmount'ta temizle
  useEffect(() => () => { arrowConfig?.arrowGeo?.dispose(); }, [arrowConfig]);

  if (!arrowConfig) return null;

  return (
    <group position={arrowConfig.position} quaternion={arrowConfig.quaternion} renderOrder={11}>
      {/* Düz mavi gövde (flat/unlit → 2B görünür) */}
      <mesh geometry={arrowConfig.arrowGeo} renderOrder={11} raycast={() => null}>
        <meshBasicMaterial
          color={PANEL_COLORS.arrow.fill}
          side={THREE.DoubleSide}
          depthTest={false}
          depthWrite={false}
          transparent
          opacity={0.95}
        />
      </mesh>
      {/* Koyu mavi ince kenar — profesyonel silüet */}
      <Line
        points={arrowConfig.outline}
        color={PANEL_COLORS.arrow.outline}
        lineWidth={2}
        transparent={false}
        depthTest={false}
        depthWrite={false}
        renderOrder={12}
        raycast={() => null}
      />
    </group>
  );
});

PanelDrawing.displayName = 'PanelDrawing';
DirectionArrow.displayName = 'DirectionArrow';
