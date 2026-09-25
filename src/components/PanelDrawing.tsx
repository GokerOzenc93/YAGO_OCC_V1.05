import React, { useRef, useMemo, useState, useEffect } from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useAppStore, ViewMode } from '../store';
import { useShallow } from 'zustand/react/shallow';
import { getFacesAndGroups, createFaceHighlightGeometry, snapToFlatGroup } from './GeometryUtils';
import { cycleRefFacePickFromEvent, REF_COLORS } from './FaceRefPick';
import { applyTransformSteps } from './PanelSteps';
import { getShapeMatrix } from './PanelMath';

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
    viewMode,
    faceExtrudeMode,
    faceExtrudeTargetPanelId,
    faceExtrudeSelectedFace,
    setFaceExtrudeSelectedFace,
    setFaceExtrudeClickPoint,
    raycastMode,
    faceExtrudeValueMode,
    faceExtrudeRefCandidate,
    setFaceExtrudeRefCandidate,
    panelMoveMode,
    panelMoveValueMode,
    panelMoveTargetPanelId,
    panelMoveRefSourceVertex,
    panelMoveRefTargetPanelId,
    panelMoveRefTargetVertex,
    panelRotateMode,
    panelRotateValueMode,
    panelRotateTargetPanelId,
    panelRotatePivot,
    panelRotateRefArmVertex,
    panelRotateAxis,
    panelRotateRefFace,
    setPanelRotateRefFace
  } = useAppStore(useShallow(state => ({
    selectShape: state.selectShape,
    selectSecondaryShape: state.selectSecondaryShape,
    selectedShapeId: state.selectedShapeId,
    selectedPanelRow: state.selectedPanelRow,
    selectedPanelRowExtraId: state.selectedPanelRowExtraId,
    setSelectedPanelRow: state.setSelectedPanelRow,
    panelSelectMode: state.panelSelectMode,
    viewMode: state.viewMode,
    faceExtrudeMode: state.faceExtrudeMode,
    faceExtrudeTargetPanelId: state.faceExtrudeTargetPanelId,
    faceExtrudeSelectedFace: state.faceExtrudeSelectedFace,
    setFaceExtrudeSelectedFace: state.setFaceExtrudeSelectedFace,
    setFaceExtrudeClickPoint: state.setFaceExtrudeClickPoint,
    raycastMode: state.raycastMode,
    faceExtrudeValueMode: state.faceExtrudeValueMode,
    faceExtrudeRefCandidate: state.faceExtrudeRefCandidate,
    setFaceExtrudeRefCandidate: state.setFaceExtrudeRefCandidate,
    panelMoveMode: state.panelMoveMode,
    panelMoveValueMode: state.panelMoveValueMode,
    panelMoveTargetPanelId: state.panelMoveTargetPanelId,
    panelMoveRefSourceVertex: state.panelMoveRefSourceVertex,
    panelMoveRefTargetPanelId: state.panelMoveRefTargetPanelId,
    panelMoveRefTargetVertex: state.panelMoveRefTargetVertex,
    panelRotateMode: state.panelRotateMode,
    panelRotateValueMode: state.panelRotateValueMode,
    panelRotateTargetPanelId: state.panelRotateTargetPanelId,
    panelRotatePivot: state.panelRotatePivot,
    panelRotateRefArmVertex: state.panelRotateRefArmVertex,
    panelRotateAxis: state.panelRotateAxis,
    panelRotateRefFace: state.panelRotateRefFace,
    setPanelRotateRefFace: state.setPanelRotateRefFace
  })));

  const [faceGroups, setFaceGroups] = useState<any[]>([]);
  const [faces, setFaces] = useState<any[]>([]);
  const [hoveredExtrudeGroup, setHoveredExtrudeGroup] = useState<number | null>(null);
  // Ref-move: bu panel aday olarak fare altındayken (hedef seçim aşaması) tüm
  // panel vurgulanır — kullanıcı hangi paneli seçeceğini net görsün.
  const [moveRefHover, setMoveRefHover] = useState(false);

  useEffect(() => {
    if (!shape.geometry) return;
    const { faces: f, groups } = getFacesAndGroups(shape.geometry);
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
  // Ref modu: hedef panel kendi yüz seçimini yapar (Normal akış). Referans için
  // hedef DIŞINDAKİ her panel, aday zaten seçili olsa bile raycast alır — çünkü
  // aynı noktaya tekrar tıklayınca ışın boyunca bir arkadaki yüze geçilir
  // (derinlik döngüsü). Aday olan panel ayrıca vurgulanır.
  // ÖNEMLİ: Referans seçimi ancak EXTRUDE EDİLECEK hedef yüz seçildikten sonra
  // (faceExtrudeSelectedFace !== null) aktifleşir; aksi hâlde hedef yüzü seçerken
  // referans overlay'leri (yeşil vurgu) erkenden çıkıp seçimi bozuyordu.
  const isExtRefMode = faceExtrudeMode && faceExtrudeValueMode === 'ref' && faceExtrudeSelectedFace !== null;
  // ── DÖNDÜRME REF: REFERANS YÜZ SEÇİMİ (extrude-ref ile AYNI akış) ────────
  // Pivot + nişan + eksen seçildikten sonra başka bir panelin YÜZÜ referans
  // alınır: hover'da yüz soft sarı, derinlik döngüsüyle seçilen yüz doygun
  // sarı (REF_COLORS). Nokta/panel seçimi yok.
  const isRotRefMode = panelRotateMode && panelRotateValueMode === 'ref'
    && !!panelRotatePivot && !!panelRotateRefArmVertex && panelRotateAxis !== null;
  const isRefMode = isExtRefMode || isRotRefMode;
  const refOwnerId = isExtRefMode ? faceExtrudeTargetPanelId : panelRotateTargetPanelId;
  const refCandidate = isExtRefMode ? faceExtrudeRefCandidate : panelRotateRefFace;
  const isRefPickablePanel = isRefMode && shape.id !== refOwnerId;
  const isRefCandidatePanel = isRefMode && refCandidate?.panelId === shape.id;
  // ── TAŞIMA REF VURGUSU (panel + nokta seçimi) ────────────────────────────
  const isMoveRefTargetPanel =
    panelMoveMode && panelMoveValueMode === 'ref' && !!panelMoveRefSourceVertex && panelMoveRefTargetPanelId === shape.id;
  // Aday (hover) vurgusu: hedef panel seçim aşaması boyunca (hedef NOKTA
  // seçilene kadar) sürer — seçili referans dışındaki paneller turuncu parlar,
  // böylece derinlik döngüsüyle gezerken sıradaki aday görünür.
  const isMoveRefPickMode =
    panelMoveMode && panelMoveValueMode === 'ref' && !!panelMoveRefSourceVertex && !panelMoveRefTargetVertex && shape.id !== panelMoveTargetPanelId && panelMoveRefTargetPanelId !== shape.id;
  // Ref-move vurgu: hedef seçim aşamasında fare altındaki ADAY panel soft sarı
  // (ref modunun ortak tonu), ONAYLANAN referans panel yeşil kalır — onay ile
  // aday arasındaki fark tek bakışta okunsun diye. Her ikisi de KOMPLE vurgulanır.
  const isMoveRefHovered = isMoveRefPickMode && moveRefHover;
  const moveRefHighlight = isMoveRefTargetPanel || isMoveRefHovered;
  const moveRefEmissiveColor = isMoveRefTargetPanel ? '#22c55e' : REF_COLORS.hoverCss;
  const moveRefEmissiveInt = isMoveRefTargetPanel ? 1.0 : 0.8;
  const moveRefEdgeColor = isMoveRefTargetPanel ? '#15803d' : REF_COLORS.selectedCss;
  const disableRaycast = (isFaceExtrudeTarget || (isFaceExtrudeXray && !isRefPickablePanel) || isRaycastOnParent) && !isMoveRefPickMode;

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    if (disableRaycast) {
      mesh.raycast = () => {};
    } else {
      mesh.raycast = THREE.Mesh.prototype.raycast;
    }
  }, [disableRaycast]);

  useEffect(() => {
    if (!isMoveRefPickMode && moveRefHover) setMoveRefHover(false);
  }, [isMoveRefPickMode, moveRefHover]);

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
  const edgeColor = moveRefHighlight ? moveRefEdgeColor : isSelected ? PANEL_COLORS.selected.shapeEdge : PANEL_COLORS.edge.default;
  // Seçim kenarı İNCE ama okunur: kalınlık yerine renk kontrastı taşır
  // (eski +2.5 / +1.5 px ağır çerçeve gibi duruyordu).
  const edgeWidth = moveRefHighlight ? EDGE_LINE_WIDTH + 0.9 : isSelected ? EDGE_LINE_WIDTH + 0.7 : EDGE_LINE_WIDTH;

  // Tarama yalnız panel satırı seçiliyken ve dolgu görünen modlarda.
  const showHatch = isPanelRowSelected && !isWireframe;

  const handleRefRightClick = async (e: any) => {
    if (e.button !== 2) return;
    e.stopPropagation();
    const { confirmRefFaceExtrude } = await import('./FaceExtrudeService');
    await confirmRefFaceExtrude();
  };

  const handleClick = (e: any) => {
    e.stopPropagation();
    // TAŞIMA MODU: normal panel seçimi YOK. Ref akışında referans panel derinlik
    // döngüsü canvas seviyesinde (MoveRefPanelPicker) yürütülür; tıklama burada
    // normal seçime DÜŞMEMELİ — aksi halde referans panel de seçili kalıyor ve
    // ref modundan çıkınca vurgu üstünde takılı kalıyordu.
    if (panelMoveMode) return;
    // DÖNDÜRME REF MODU: aynı izolasyon — referans panel derinlik döngüsü canvas
    // seviyesinde (RotateRefPanelPicker) yürütülür; tıklama normal seçime
    // DÜŞMEMELİ, aksi halde referans panel de seçili kalıp vurgu takılıyor.
    if (panelRotateMode && panelRotateValueMode === 'ref') {
      // Referans YÜZ seçim aşaması (pivot + nişan + eksen seçildi): extrude-ref
      // ile aynı derinlik döngüsü; yalnız PANEL yüzleri aday (gövde hariç).
      if (isRotRefMode && shape.id !== panelRotateTargetPanelId) {
        const panelsOnly = useAppStore.getState().shapes.filter((x: any) => x.type === 'panel');
        cycleRefFacePickFromEvent(e, panelsOnly, panelRotateTargetPanelId, setPanelRotateRefFace);
      }
      return;
    }
    // DÖNDÜRME (Dyn) MODU: aynı izolasyon — pivot/eksen seçimi gizmo ile yapılır;
    // başka panele tıklamak normal Body-modu seçimine düşüp açık satırı
    // (setSelectedPanelRow(null)) kapatıyordu.
    if (panelRotateMode) return;
    if (isFaceExtrudeTarget) return;
    // FaceExtrude modunda hedef olmayan panellerde normal seçim yapma.
    if (faceExtrudeMode && !isFaceExtrudeTarget) return;
    // Ref modu — tüm normal seçim mantığını atla. Işın boyunca DERİNLİK DÖNGÜSÜ:
    // aynı noktaya her tıklamada bir arkadaki yüze geçer (küp dış yüzü → panel
    // yüzü → arkası...). Tüm şekiller taranır; hedef panel hariç.
    if (isExtRefMode) {
      if (shape.id === faceExtrudeTargetPanelId) return;
      const allShapes = useAppStore.getState().shapes;
      cycleRefFacePickFromEvent(e, allShapes, faceExtrudeTargetPanelId, setFaceExtrudeRefCandidate);
      return;
    }
    // ── BODY MODU: panel tıklansa bile KOMPLE BLOK seçilir ──────────────────
    // İSTEK (Goker): "body modunda panel tıklansa bile bloğu seçsin komple".
    // Ebeveyni olan panel tıklaması HER ZAMAN ebeveyn bloğu seçer. Panel satırı
    // yalnız Panel modunda yazılır; Body modunda varsa TEMİZLENİR.
    const rowSelectModes = panelSelectMode;
    const targetId = parentShapeId ? parentShapeId : shape.id;
    if (selectedShapeId !== targetId) selectShape(targetId);
    if (rowSelectModes && parentShapeId) {
      const rowKey = virtualFaceId ? `vf-${virtualFaceId}` : (faceIndex ?? null);
      setSelectedPanelRow(rowKey, extraRowId || null, parentShapeId);
    } else if (parentShapeId) {
      setSelectedPanelRow(null);
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
          onPointerOver={(e: any) => { if (isMoveRefPickMode) { e.stopPropagation(); setMoveRefHover(true); } }}
          onPointerOut={() => { if (moveRefHover) setMoveRefHover(false); }}
          onPointerDown={(e: any) => { if (isExtRefMode && isRefPickablePanel) handleRefRightClick(e); }}
          onContextMenu={(e: any) => { if (isRefPickablePanel || isMoveRefPickMode || isMoveRefTargetPanel) e.stopPropagation(); }}
        >
          <meshLambertMaterial
            color={materialColor}
            emissive={isPanelRowSelected ? PANEL_COLORS.selected.panelEmissive : moveRefHighlight ? moveRefEmissiveColor : '#2a2a2a'}
            emissiveIntensity={isPanelRowSelected ? 1 : moveRefHighlight ? moveRefEmissiveInt : 1}
            side={THREE.DoubleSide}
            transparent={isFaceExtrudeXray || moveRefHighlight}
            opacity={isFaceExtrudeXray ? 0.12 : isMoveRefTargetPanel ? 0.55 : isMoveRefHovered ? 0.9 : 1}
            depthWrite={!isFaceExtrudeXray && !isMoveRefTargetPanel}
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
            onPointerOver={(e: any) => { if (isMoveRefPickMode) { e.stopPropagation(); setMoveRefHover(true); } }}
            onPointerOut={() => { if (moveRefHover) setMoveRefHover(false); }}
            onPointerDown={(e: any) => { if (isExtRefMode && isRefPickablePanel) handleRefRightClick(e); }}
            onContextMenu={(e: any) => { if (isRefPickablePanel || isMoveRefPickMode || isMoveRefTargetPanel) e.stopPropagation(); }}
          >
            <meshLambertMaterial
              color={materialColor}
              emissive={isPanelRowSelected ? PANEL_COLORS.selected.panelEmissive : moveRefHighlight ? moveRefEmissiveColor : '#2a2a2a'}
              emissiveIntensity={isPanelRowSelected ? 1 : moveRefHighlight ? moveRefEmissiveInt : 1}
              side={THREE.DoubleSide}
              transparent={true}
              opacity={moveRefHighlight ? (isMoveRefTargetPanel ? 0.5 : 0.6) : 0.35}
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
                  // Convert world-space click to local space so the extrude
                  // service can use it as a sample point for face matching.
                  if (e.point) {
                    const local = e.point.clone().applyMatrix4(getShapeMatrix(shape).invert());
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
                }
              }
            }}
            onPointerOut={(e: any) => {
              e.stopPropagation();
              setHoveredExtrudeGroup(null);
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

      {/* ── REF PICKABLE PANEL HOVER + SEÇİLİ YÜZ VURGUSU ────────────────
          Hedef dışındaki her panel hover'da yeşil parlar (ışının değdiği ön
          yüz). Derinlik döngüsüyle seçilen referans yüzü, YALNIZ o panel aday
          olduğunda koyu yeşil kalır. */}
      {isRefPickablePanel && (
        <>
          <mesh
            geometry={shape.geometry}
            renderOrder={10}
            onPointerMove={(e: any) => {
              e.stopPropagation();
              const fi = e.faceIndex;
              if (fi !== undefined && fi !== null) {
                const raw = faceGroups.findIndex(g => g.faceIndices.includes(fi));
                if (raw !== -1) {
                  const gi = snapToFlatGroup(raw, faceGroups);
                  setHoveredExtrudeGroup(gi);
                }
              }
            }}
            onPointerOut={(e: any) => {
              e.stopPropagation();
              setHoveredExtrudeGroup(null);
            }}
            onPointerDown={(e: any) => { if (isExtRefMode) handleRefRightClick(e); }}
            onContextMenu={(e: any) => e.stopPropagation()}
          >
            <meshBasicMaterial transparent opacity={0.01} side={THREE.DoubleSide} depthTest={false} depthWrite={false} />
          </mesh>
          {hoveredExtrudeGroup !== null && faceGroups[hoveredExtrudeGroup] && (
            <mesh geometry={createFaceHighlightGeometry(faces, faceGroups[hoveredExtrudeGroup].faceIndices)} renderOrder={11} raycast={() => null}>
              <meshBasicMaterial
                color={REF_COLORS.hover}
                transparent
                opacity={REF_COLORS.hoverOpacity}
                side={THREE.DoubleSide}
                depthTest={false}
                depthWrite={false}
              />
            </mesh>
          )}
          {isRefCandidatePanel && refCandidate?.faceGroupIndex !== undefined && refCandidate.faceGroupIndex >= 0 && faceGroups[refCandidate.faceGroupIndex] && (
            <mesh geometry={createFaceHighlightGeometry(faces, faceGroups[refCandidate.faceGroupIndex].faceIndices)} renderOrder={12} raycast={() => null}>
              <meshBasicMaterial
                color={REF_COLORS.selected}
                transparent
                opacity={REF_COLORS.selectedOpacity}
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
          transformSteps={shape.parameters?.transformSteps}
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
  /** Panelin sıralı dönüşüm adımları — ok, panelin KENDİ çerçevesinde ölçülür. */
  transformSteps?: any[];
}

const DirectionArrow: React.FC<DirectionArrowProps> = React.memo(({
  geometry,
  faceRole,
  arrowRotated = false,
  transformSteps,
}) => {
  const arrowConfig = useMemo(() => {
    if (!geometry) return null;
    const posAttr = geometry.getAttribute('position');
    if (!posAttr) return null;

    // ── PANEL ÇERÇEVESİ (dönmüş panelde ok yerinde kalsın) ────────────────
    // KÖK NEDEN (Goker: "panel dönse taşınsa ok her zaman panelin üzerinde
    // gelsin"): ölçüler DÜNYA-hizalı bbox'tan alınıyordu. 33° eğik bir
    // 600x18x600 slab'ın bbox'ı ≈600x342x600 olur → "ince eksen" Y sanılır,
    // ok panelin ~171 mm ÜSTÜNDE havada ve panelin eğimini izlemeyen yatay
    // bir düzlemde çizilirdi. Çözüm: panelin kendi dönüşü (transformSteps)
    // ile TERS döndürülmüş çerçevede ölç — orada panel yine eksen-hizalı bir
    // slab'dır, ince eksen gerçek kalınlıktır — sonra oku aynı dönüşle geri
    // getir. Taşıma zaten geometriye işlendiği için kendiliğinden doğrudur.
    const steps = Array.isArray(transformSteps) ? transformSteps : [];
    const { rotation: rot } = applyTransformSteps([0, 0, 0], [0, 0, 0], steps as any);
    const Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ'));
    const Qinv = Q.clone().invert();

    const bbox = new THREE.Box3();
    {
      const v = new THREE.Vector3();
      for (let i = 0; i < posAttr.count; i++) {
        v.fromBufferAttribute(posAttr as THREE.BufferAttribute, i).applyQuaternion(Qinv);
        bbox.expandByPoint(v);
      }
    }
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
    // Panel-yerel çerçevede kurulan ok, panelin dönüşüyle dünyaya taşınır.
    const quat = new THREE.Quaternion().setFromRotationMatrix(basis).premultiply(Q);

    // İnce eksen boyunca hafif dışa ofset (yüzeye otursun, z-fight olmasın).
    // Eğik panelde ok YUKARI bakan büyük yüze konur — kullanıcı onu tepeden
    // görür; dik panellerde (y≈0) yön belirleyici değildir, +yön korunur.
    const normalUnit = new THREE.Vector3().setComponent(thinAxisIndex, 1);
    if (normalUnit.clone().applyQuaternion(Q).y < -1e-6) normalUnit.negate();
    const position = center.clone().addScaledVector(normalUnit, thinHalf + 3).applyQuaternion(Q);

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
  }, [geometry, faceRole, arrowRotated, transformSteps]);

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
