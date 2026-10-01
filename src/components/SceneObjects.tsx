import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Line, TransformControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { type CavityPick, type FilletInfo, Tool, ViewMode, type VirtualFace, childPanelsOf, useAppStore, useStoreFields } from '../store';
import {
  type CoplanarFaceGroup, type FaceData, type Vec3, applyFillets, convertReplicadToThreeGeometry, createFaceDescriptor, createFaceHighlightGeometry,
  createGroupBoundaryEdges, edgePointsOf, effectiveBodyGeometry, flatGroupOfFace, genId, getFacePlaneAxes, getFacesAndGroups, getShapeMatrix,
  groupIndexOfFace, localBboxOf,
} from './Geometry';
import { REF_COLORS, applyTransformSteps, confirmRefFaceExtrude, cycleRefFacePickFromEvent } from './PanelOps';
import { type Point2D, computeFaceComponentContour, computeFreeRegionLocal, earClipTriangulate, findPanelCoveringPoint, pointInTriangle3D } from './FaceRegion';
import {
  GROUP_PANEL_THICKNESS, boxSpan, boxesSurface, collectObstacles, confirmRefCavityExtrude, createPanelGroupFromCavity, fmtBox, gridForObstacles, rayCavityCandidates,
} from './PanelGroupService';

/* ═══════════════════════════════════════════════════════════════════════════
   SAHNE NESNELERİ — canvas içinde şekil başına çizilen her şey:
   (A) PanelDrawing: panel mesh'i, kenarlar, referans yüz seçimi;
   (B) FaceOverlays: yüz yakalama, VF vurguları, yüz editörü, fillet, hacim seçimi;
   (C) ShapeWithTransform: gövde mesh'i + TransformControls + overlay yerleşimi.
   ═══════════════════════════════════════════════════════════════════════════ */
// ═══════════════════════════════════════════════════════════════════════════
// PanelDrawing — PANEL ÇİZİMİ (solid / wireframe / x-ray), seçim taraması,
// yüz-extrude ve referans-yüz overlay'leri, panel yön oku.
// RENK YÖNETİMİ: seçimde DOLGU asla değişmez; vurgu kenardan (doygun aksan +
// kalın stroke) ve seçili panelde çapraz TARAMA ile gelir (CAD konvansiyonu).
// ═══════════════════════════════════════════════════════════════════════════

const PANEL_COLORS = {
  selected: { shapeEdge: '#e8590c', hatch: '#8a9097', panelEmissive: '#2a2a2a' },
  edge: { default: '#5b6470' },   // yumuşak gri — birleşim yerlerinde ağır görünmez
  arrow: { fill: '#ff0000', outline: '#7f1d1d' },
} as const;

/**
 * SEÇİM PALETİ — TEK KAYNAK (Goker: "tüm seçim, extrude, hacim seçimi, fillet dahil tutarlı;
 * minimal, soft, profesyonel"; mercan beğenilmedi → "daha profesyonel, daha güzel bir dokunuş").
 * Tek ton ailesi: PETROL MAVİSİ (bone/ivory zeminde sakin, turuncu panel aksanıyla tamamlayıcı
 * kontrast; CAD seçim konvansiyonuna yakın). Roller:
 *   hover  = fare altındaki aday (açık petrol, düşük opaklık)
 *   active = seçili yüz/hacim (orta petrol)
 *   edge   = seçili hacmin dış çizgisi (ince, koyu petrol)
 *   muted  = "dolu" durum (ör. panel yerleştirmede zaten paneli olan yüz) — nötr taş grisi
 *   extrude* = YALNIZ PANEL YÜZ-EXTRUDE (Goker: "seçim çok belli olmuyor, daha koyu"):
 *              koyu petrol dolgu + seçili yüzün sınırında çizgi.
 * Hacimler büyük alan kapladığından yüz opaklığından daha düşük opaklıkla doldurulur.
 * REF_COLORS (referans = soft sarı) ve taşıma-ref yeşili AYRI rol olarak korunur.
 */
const SEL_COLORS = {
  hover: 0xa9c6d8, active: 0x3a7ca5, muted: 0xb8b2aa, edge: '#24577a',
  faceHoverOpacity: 0.4, faceActiveOpacity: 0.5,
  volumeHoverOpacity: 0.12, volumeActiveOpacity: 0.16,
  edgeWidth: 1.3,
  // HACİM SINIRI (Goker: "mavi ton çok güzel ama sınırları kırmızı olsun — nereyi seçtiğini daha iyi gösterir"):
  // petrol dolgu + ince KIRMIZI dış çizgi (yön okuyla aynı kırmızı). Hacim seçimi ve hacim düzenlemede.
  volumeEdge: '#dc2626',
  extrudeHover: 0x3a7ca5, extrudeHoverOpacity: 0.4,
  extrudeActive: 0x1f5578, extrudeActiveOpacity: 0.72,
  extrudeEdge: '#0f3550', extrudeEdgeWidth: 2.2,
} as const;

/** Seçili yüzün SINIR çizgisi (yüz-extrude): vurgu geometrisinin dış kenarları (eş-düzlem iç dikişler elenir), her şeyin üstünde. */
const FaceOutline: React.FC<{ geometry: THREE.BufferGeometry; color: string; width: number }> = ({ geometry, color, width }) => {
  const pts = useMemo(() => edgePointsOf(geometry, 1), [geometry]);
  if (pts.length < 2) return null;
  return <Line points={pts} segments color={color} lineWidth={width} transparent={false} depthTest={false} depthWrite={false} renderOrder={13} raycast={() => null} />;
};
/** Yüz-extrude sırasında hedef DIŞI paneller: X-ray görünümüyle aynı opaklık + yumuşatılmış kenar (çizgi karmaşası azalır). */
const XRAY_PANEL_OPACITY = 0.35;
const EXTRUDE_XRAY_EDGE = '#a3a9b0';

// SEÇİM TARAMASI (HATCH): 45° çapraz çizgiler, EKRAN UZAYINDA sabit aralıklı (gl_FragCoord);
// panel ölçeğinden bağımsız gerçek CAD taraması. Çizgiler arası boşluk şeffaf (discard).
const HATCH_VERT = /* glsl */`void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const HATCH_FRAG = /* glsl */`
  precision mediump float;
  uniform vec3 uColor; uniform float uSpacing; uniform float uThickness; uniform float uOpacity; uniform float uPixelRatio;
  void main() {
    float pr = max(uPixelRatio, 1.0);
    float m = mod(gl_FragCoord.x + gl_FragCoord.y, uSpacing * pr);
    float t = uThickness * pr;
    float line = 1.0 - smoothstep(t, t + pr, m);
    if (line < 0.02) discard;
    gl_FragColor = vec4(uColor, uOpacity * line);
  }`;

// Z-FIGHTING: mesh hafif pozitif polygonOffset (kendi edge'inin altına); edge ve tarama yalnız
// küçük SABİT birim payı alır, EĞİM (factor) payı ALMAZ. Goker: "iki panelin değdiği yerde kamera
// uzaklaştıkça arkadaki panellerin kalınlıkları öndeki panelin üstünde görünüyor". KÖK NEDEN: eğim
// payı ekranda 1 pikselin derinlik değişimiyle ölçeklenir — uzaklaştıkça piksel başına düşen dünya
// boyu büyür; tarama (-2) + kenar (-1) + mesh (+1) eğim payları toplamı 18 mm'yi aşınca değen
// panelin TARAMASI (kesik çizgi görünümü) ve kenarları öndeki yüzü delip görünüyordu. Mesh'in +1
// payı kendi kenarını/taramasını üstte tutmaya yeter. Başsız WebGL testi: 4–25 m'de sızıntı 0,
// yakında kenar görünürlüğü değişmedi.
// Kenarlar drei <Line> (Line2) ile: antialias'lı, gerçek piksel genişliğinde, OPAK.
const MESH_OFFSET = 1.0, EDGE_OFFSET_FACTOR = 0, EDGE_OFFSET_UNITS = -1.0, EDGE_RENDER_ORDER = 1;
export const EDGE_LINE_WIDTH = 1.0;
export const EDGE_ANGLE_THRESHOLD = 15;

/** Görünmez yakalama yüzeyi (overlay olayları için). */
export const HitMaterial = () => <meshBasicMaterial transparent opacity={0.01} side={THREE.DoubleSide} depthTest={false} depthWrite={false} />;
/** Yüz vurgusu (overlay). */
const OverlayMat = ({ color, opacity }: { color: number; opacity: number }) => <meshBasicMaterial color={color} transparent opacity={opacity} side={THREE.DoubleSide} depthTest={false} depthWrite={false} />;

/**
 * REFERANS YÜZ OVERLAY'İ (PanelDrawing + ShapeWithTransform ortak): hover'da yüz soft
 * sarı, derinlik döngüsüyle seçilen referans yüz doygun sarı (REF_COLORS).
 */
export function RefFaceOverlay({ geometry, faces, groups, hoveredGroup, candidateGroup, onHover, onPointerDown, onClick }:
  { geometry: THREE.BufferGeometry; faces: any[]; groups: any[]; hoveredGroup: number | null; candidateGroup: number | null; onHover: (gi: number | null) => void; onPointerDown?: (e: any) => void; onClick?: (e: any) => void }) {
  const hoverGeo = useMemo(() => (hoveredGroup !== null && groups[hoveredGroup] ? createFaceHighlightGeometry(faces, groups[hoveredGroup].faceIndices) : null), [hoveredGroup, groups, faces]);
  const candGeo = useMemo(() => (candidateGroup !== null && candidateGroup >= 0 && groups[candidateGroup] ? createFaceHighlightGeometry(faces, groups[candidateGroup].faceIndices) : null), [candidateGroup, groups, faces]);
  return (
    <>
      <mesh geometry={geometry} renderOrder={10}
        onPointerMove={(e: any) => { e.stopPropagation(); const gi = flatGroupOfFace(groups, e.faceIndex); if (gi !== -1) onHover(gi); }}
        onPointerOut={(e: any) => { e.stopPropagation(); onHover(null); }}
        onPointerDown={onPointerDown} onClick={onClick} onContextMenu={(e: any) => e.stopPropagation()}>
        <HitMaterial />
      </mesh>
      {hoverGeo && <mesh geometry={hoverGeo} renderOrder={11} raycast={() => null}><OverlayMat color={REF_COLORS.hover} opacity={REF_COLORS.hoverOpacity} /></mesh>}
      {candGeo && <mesh geometry={candGeo} renderOrder={12} raycast={() => null}><OverlayMat color={REF_COLORS.selected} opacity={REF_COLORS.selectedOpacity} /></mesh>}
    </>
  );
}

/** Sağ tık → bekleyen ref-extrude seçimini onaylar (panel yüzü ya da raf/dikme HACMİ). */
export const confirmRefOnRightClick = async (e: any) => {
  if (e.button !== 2) return;
  e.stopPropagation();
  if (useAppStore.getState().faceExtrudeCavityGroupId) await confirmRefCavityExtrude(); else await confirmRefFaceExtrude();
};

export const PanelDrawing: React.FC<{ shape: any; isSelected: boolean }> = React.memo(({ shape, isSelected }) => {
  const meshRef = useRef<THREE.Mesh>(null);
  const { gl } = useThree();
  const S = useStoreFields('selectShape', 'selectSecondaryShape', 'selectedShapeId', 'selectedPanelRow', 'setSelectedPanelRow', 'panelSelectMode', 'viewMode',
    'faceExtrudeMode', 'faceExtrudeTargetPanelId', 'faceExtrudeSelectedFace', 'setFaceExtrudeSelectedFace', 'setFaceExtrudeClickPoint', 'raycastMode', 'faceExtrudeValueMode', 'faceExtrudeRefCandidate',
    'panelMoveMode', 'panelMoveValueMode', 'panelMoveTargetPanelId', 'panelMoveRefSourceVertex', 'panelMoveRefTargetPanelId', 'panelMoveRefTargetVertex',
    'panelRotateMode', 'panelRotateValueMode', 'panelRotateTargetPanelId', 'panelRotatePivot', 'panelRotateRefArmVertex', 'panelRotateAxis', 'panelRotateRefFace', 'setPanelRotateRefFace',
    'selectedPanelGroupId', 'volumePickMode');
  const [hoveredExtrudeGroup, setHoveredExtrudeGroup] = useState<number | null>(null);
  // Ref-move: bu panel aday olarak fare altındayken tüm panel vurgulanır.
  const [moveRefHover, setMoveRefHover] = useState(false);
  const { faces, groups: faceGroups } = useMemo(() => (shape.geometry ? getFacesAndGroups(shape.geometry) : { faces: [], groups: [] }), [shape.geometry]);

  // ── Seçim mantığı ──────────────────────────────────────────────────────────
  const parentShapeId = shape.parameters?.parentShapeId;
  const virtualFaceId = shape.parameters?.virtualFaceId;
  const isParentSelected = parentShapeId === S.selectedShapeId;
  // GRUP SEÇİMİ ("tümünü seç"): raf/dikme grubunun her üyesi seçili çizilir.
  const isGroupSelected = isParentSelected && !!S.selectedPanelGroupId && shape.parameters?.panelGroupId === S.selectedPanelGroupId;
  const isPanelRowSelected = isGroupSelected || (isParentSelected && !!virtualFaceId && S.selectedPanelRow === `vf-${virtualFaceId}`);

  const edgePoints = useMemo<Vec3[] | null>(() => { try { const p = edgePointsOf(shape.geometry, EDGE_ANGLE_THRESHOLD); return p.length ? p : null; } catch { return null; } }, [shape.geometry]);

  // Seçim taraması materyali — tek instance (hook sırası için erken return'den önce).
  const hatchMaterial = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(PANEL_COLORS.selected.hatch) }, uSpacing: { value: 7.0 }, uThickness: { value: 2.0 }, uOpacity: { value: 0.35 }, uPixelRatio: { value: 1.0 } },
    vertexShader: HATCH_VERT, fragmentShader: HATCH_FRAG, transparent: true, depthTest: true, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: 0, polygonOffsetUnits: -1,   // eğim payı yok (bkz. Z-FIGHTING notu)
  }), []);
  useEffect(() => { hatchMaterial.uniforms.uPixelRatio.value = gl.getPixelRatio(); }, [gl, hatchMaterial]);

  const isFaceExtrudeTarget = S.faceExtrudeMode && shape.id === S.faceExtrudeTargetPanelId;
  const isFaceExtrudeXray = S.faceExtrudeMode && shape.id !== S.faceExtrudeTargetPanelId;
  const isRaycastOnParent = (S.raycastMode || S.volumePickMode !== null) && parentShapeId && parentShapeId === S.selectedShapeId;
  // Ref modu: referans seçimi ancak EXTRUDE EDİLECEK hedef yüz seçildikten sonra aktifleşir;
  // hedef DIŞINDAKİ her panel raycast alır (derinlik döngüsü).
  const isExtRefMode = S.faceExtrudeMode && S.faceExtrudeValueMode === 'ref' && S.faceExtrudeSelectedFace !== null;
  // DÖNDÜRME REF: pivot + nişan + eksen seçildikten sonra başka panelin YÜZÜ referans alınır (extrude-ref ile aynı akış).
  const isRotRefMode = S.panelRotateMode && S.panelRotateValueMode === 'ref' && !!S.panelRotatePivot && !!S.panelRotateRefArmVertex && S.panelRotateAxis !== null;
  const isRefMode = isExtRefMode || isRotRefMode;
  const refOwnerId = isExtRefMode ? S.faceExtrudeTargetPanelId : S.panelRotateTargetPanelId;
  const refCandidate = isExtRefMode ? S.faceExtrudeRefCandidate : S.panelRotateRefFace;
  const isRefPickablePanel = isRefMode && shape.id !== refOwnerId;
  const isRefCandidatePanel = isRefMode && refCandidate?.panelId === shape.id;
  // TAŞIMA REF VURGUSU: onaylanan referans panel yeşil; hedef seçim aşamasında fare altındaki ADAY soft sarı.
  const isMoveRefTargetPanel = S.panelMoveMode && S.panelMoveValueMode === 'ref' && !!S.panelMoveRefSourceVertex && S.panelMoveRefTargetPanelId === shape.id;
  const isMoveRefPickMode = S.panelMoveMode && S.panelMoveValueMode === 'ref' && !!S.panelMoveRefSourceVertex && !S.panelMoveRefTargetVertex && shape.id !== S.panelMoveTargetPanelId && S.panelMoveRefTargetPanelId !== shape.id;
  const isMoveRefHovered = isMoveRefPickMode && moveRefHover;
  const moveRefHighlight = isMoveRefTargetPanel || isMoveRefHovered;
  const disableRaycast = (isFaceExtrudeTarget || (isFaceExtrudeXray && !isRefPickablePanel) || isRaycastOnParent) && !isMoveRefPickMode;

  useEffect(() => { const mesh = meshRef.current; if (mesh) mesh.raycast = disableRaycast ? () => {} : THREE.Mesh.prototype.raycast; }, [disableRaycast]);
  useEffect(() => { if (!isMoveRefPickMode && moveRefHover) setMoveRefHover(false); }, [isMoveRefPickMode, moveRefHover]);

  const extrudeHighlightGeometry = useMemo(() => (!isFaceExtrudeTarget || hoveredExtrudeGroup === null || hoveredExtrudeGroup === S.faceExtrudeSelectedFace || !faceGroups[hoveredExtrudeGroup] || faces.length === 0)
    ? null : createFaceHighlightGeometry(faces, faceGroups[hoveredExtrudeGroup].faceIndices), [isFaceExtrudeTarget, hoveredExtrudeGroup, faceGroups, faces, S.faceExtrudeSelectedFace]);
  const extrudeSelectedGeometry = useMemo(() => (!isFaceExtrudeTarget || S.faceExtrudeSelectedFace === null || !faceGroups[S.faceExtrudeSelectedFace] || faces.length === 0)
    ? null : createFaceHighlightGeometry(faces, faceGroups[S.faceExtrudeSelectedFace].faceIndices), [isFaceExtrudeTarget, S.faceExtrudeSelectedFace, faceGroups, faces]);

  if (!shape.geometry) return null;

  const isWireframe = S.viewMode === ViewMode.WIREFRAME;
  const isXray = S.viewMode === ViewMode.XRAY;
  const edgeColor = moveRefHighlight ? (isMoveRefTargetPanel ? '#15803d' : REF_COLORS.selectedCss) : isSelected ? PANEL_COLORS.selected.shapeEdge
    : isFaceExtrudeXray ? EXTRUDE_XRAY_EDGE : PANEL_COLORS.edge.default;
  const edgeWidth = moveRefHighlight ? EDGE_LINE_WIDTH + 0.9 : isSelected ? EDGE_LINE_WIDTH + 0.7 : EDGE_LINE_WIDTH;
  const showHatch = isPanelRowSelected && !isWireframe;   // tarama yalnız satır seçiliyken ve dolgu görünen modlarda

  const handleClick = (e: any) => {
    e.stopPropagation();
    if (S.volumePickMode) return;              // HACİM SEÇME: tıklama araca aittir
    // TAŞIMA MODU: normal panel seçimi YOK (referans döngüsü canvas seviyesinde, MoveRefPanelPicker).
    if (S.panelMoveMode) return;
    // DÖNDÜRME REF: referans YÜZ seçimi (pivot + nişan + eksen seçildi) — yalnız PANEL yüzleri aday.
    if (S.panelRotateMode && S.panelRotateValueMode === 'ref') {
      if (isRotRefMode && shape.id !== S.panelRotateTargetPanelId) {
        cycleRefFacePickFromEvent(e, useAppStore.getState().shapes.filter((x: any) => x.type === 'panel'), S.panelRotateTargetPanelId, S.setPanelRotateRefFace);
      }
      return;
    }
    if (S.panelRotateMode) return;             // DÖNDÜRME (Dyn): pivot/eksen gizmo ile; normal seçime düşmez
    if (S.faceExtrudeMode) return;             // extrude modunda hedef/hedef-dışı panelde normal seçim yok
    // BODY MODU (Goker): panel tıklansa bile KOMPLE BLOK seçilir; panel satırı yalnız Panel modunda yazılır.
    const targetId = parentShapeId ? parentShapeId : shape.id;
    if (S.selectedShapeId !== targetId) S.selectShape(targetId);
    if (S.panelSelectMode && parentShapeId) S.setSelectedPanelRow(virtualFaceId ? `vf-${virtualFaceId}` : null, parentShapeId);
    else if (parentShapeId) S.setSelectedPanelRow(null);
    S.selectSecondaryShape(null);
  };

  const meshEvents = {
    onClick: handleClick,
    onPointerOver: (e: any) => { if (isMoveRefPickMode) { e.stopPropagation(); setMoveRefHover(true); } },
    onPointerOut: () => { if (moveRefHover) setMoveRefHover(false); },
    onPointerDown: (e: any) => { if (isExtRefMode && isRefPickablePanel) confirmRefOnRightClick(e); },
    onContextMenu: (e: any) => { if (isRefPickablePanel || isMoveRefPickMode || isMoveRefTargetPanel) e.stopPropagation(); },
  };
  const emissive = isPanelRowSelected ? PANEL_COLORS.selected.panelEmissive : moveRefHighlight ? (isMoveRefTargetPanel ? '#22c55e' : REF_COLORS.hoverCss) : '#2a2a2a';
  const emissiveIntensity = isPanelRowSelected ? 1 : moveRefHighlight ? (isMoveRefTargetPanel ? 1.0 : 0.8) : 1;
  const hatch = showHatch && <mesh geometry={shape.geometry} renderOrder={2} raycast={() => null}><primitive object={hatchMaterial} attach="material" /></mesh>;
  const edgeLine = (xray: boolean) => edgePoints && (
    <Line points={edgePoints} segments color={edgeColor} lineWidth={edgeWidth} transparent={false} depthTest={!xray} depthWrite={!xray}
      {...(!xray && !isWireframe ? { polygonOffset: true, polygonOffsetFactor: EDGE_OFFSET_FACTOR, polygonOffsetUnits: EDGE_OFFSET_UNITS } : {})}
      renderOrder={EDGE_RENDER_ORDER} raycast={() => null} />
  );

  return (
    <group name={`shape-${shape.id}`} position={shape.position} rotation={shape.rotation} scale={shape.scale}>
      {/* SOLID / X-RAY: aynı mesh, farklı saydamlık */}
      {!isWireframe && (
        <mesh ref={meshRef} geometry={shape.geometry} castShadow receiveShadow {...meshEvents}>
          <meshLambertMaterial color={shape.color || '#ffffff'} emissive={emissive} emissiveIntensity={emissiveIntensity} side={THREE.DoubleSide}
            transparent={isXray || isFaceExtrudeXray || moveRefHighlight}
            opacity={isXray ? (moveRefHighlight ? (isMoveRefTargetPanel ? 0.5 : 0.6) : XRAY_PANEL_OPACITY) : isFaceExtrudeXray ? XRAY_PANEL_OPACITY : isMoveRefTargetPanel ? 0.55 : isMoveRefHovered ? 0.9 : 1}
            depthWrite={!isXray && !isFaceExtrudeXray && !isMoveRefTargetPanel}
            polygonOffset polygonOffsetFactor={MESH_OFFSET} polygonOffsetUnits={MESH_OFFSET} />
        </mesh>
      )}
      {!isWireframe && hatch}
      {edgeLine(isXray)}

      {/* FACE EXTRUDE OVERLAY: hedef panelde yüz seçimi (tıklama noktası yerel olarak saklanır). */}
      {isFaceExtrudeTarget && (
        <>
          <mesh geometry={shape.geometry} renderOrder={10}
            onPointerDown={(e: any) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              const gi = flatGroupOfFace(faceGroups, e.faceIndex);
              if (gi === -1) return;
              S.setFaceExtrudeSelectedFace(gi);
              setHoveredExtrudeGroup(gi);
              if (e.point) { const local = e.point.clone().applyMatrix4(getShapeMatrix(shape).invert()); S.setFaceExtrudeClickPoint([local.x, local.y, local.z]); }
            }}
            onPointerMove={(e: any) => { e.stopPropagation(); const gi = flatGroupOfFace(faceGroups, e.faceIndex); if (gi !== -1) setHoveredExtrudeGroup(gi); }}
            onPointerOut={(e: any) => { e.stopPropagation(); setHoveredExtrudeGroup(null); }}>
            <HitMaterial />
          </mesh>
          {extrudeHighlightGeometry && <mesh geometry={extrudeHighlightGeometry} renderOrder={11}><OverlayMat color={SEL_COLORS.extrudeHover} opacity={SEL_COLORS.extrudeHoverOpacity} /></mesh>}
          {extrudeSelectedGeometry && (
            <>
              <mesh geometry={extrudeSelectedGeometry} renderOrder={12}><OverlayMat color={SEL_COLORS.extrudeActive} opacity={SEL_COLORS.extrudeActiveOpacity} /></mesh>
              <FaceOutline geometry={extrudeSelectedGeometry} color={SEL_COLORS.extrudeEdge} width={SEL_COLORS.extrudeEdgeWidth} />
            </>
          )}
        </>
      )}

      {/* REF PICKABLE PANEL: hover + seçili referans yüz vurgusu */}
      {isRefPickablePanel && (
        <RefFaceOverlay geometry={shape.geometry} faces={faces} groups={faceGroups} hoveredGroup={hoveredExtrudeGroup}
          candidateGroup={isRefCandidatePanel ? (refCandidate?.faceGroupIndex ?? null) : null} onHover={setHoveredExtrudeGroup}
          onPointerDown={(e: any) => { if (isExtRefMode) confirmRefOnRightClick(e); }} />
      )}

      {/* Hacim seçme modunda panel yön oku gizlenir (Goker: yön oku gösterilirken panel gizmo okları görünmesin); moddan çıkınca geri gelir. */}
      {isPanelRowSelected && !isGroupSelected && !S.volumePickMode && <DirectionArrow geometry={shape.geometry} arrowRotated={shape.parameters?.arrowRotated || false} transformSteps={shape.parameters?.transformSteps} />}
    </group>
  );
});

// ─── DirectionArrow (Yön Oku — düz/2B) ────────────────────────────────────────
// Panelin yüzeyine yatık, ışıktan etkilenmeyen kırmızı ok (ShapeGeometry silüet + koyu
// kenar). depthTest=false ile her zaman panelin üstünde. Yön arrowRotated ile değişir.
const DirectionArrow: React.FC<{ geometry: THREE.BufferGeometry; arrowRotated?: boolean; transformSteps?: any[] }> = React.memo(({ geometry, arrowRotated = false, transformSteps }) => {
  const arrowConfig = useMemo(() => {
    const posAttr = geometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!posAttr) return null;
    // PANEL ÇERÇEVESİ (Goker: "panel dönse taşınsa ok her zaman panelin üzerinde gelsin"):
    // ölçüler panelin kendi dönüşüyle TERS döndürülmüş çerçevede alınır (orada panel
    // eksen-hizalı slab, ince eksen gerçek kalınlık), ok aynı dönüşle geri getirilir.
    const { rotation: rot } = applyTransformSteps([0, 0, 0], [0, 0, 0], (Array.isArray(transformSteps) ? transformSteps : []) as any);
    const Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ'));
    const Qinv = Q.clone().invert();
    const bbox = new THREE.Box3();
    const v = new THREE.Vector3();
    for (let i = 0; i < posAttr.count; i++) bbox.expandByPoint(v.fromBufferAttribute(posAttr, i).applyQuaternion(Qinv));
    const center = bbox.getCenter(new THREE.Vector3()), size = bbox.getSize(new THREE.Vector3());
    const axes = [0, 1, 2].map(i => ({ index: i, value: size.getComponent(i) })).sort((a, b) => a.value - b.value);
    const thinAxisIndex = axes[0].index, thinHalf = axes[0].value / 2;
    const planeAxes = axes.slice(1).map(a => a.index).sort((a, b) => a - b);
    let targetAxis = planeAxes[0];
    if (arrowRotated) targetAxis = planeAxes.find(a => a !== targetAxis) ?? planeAxes[1];
    const otherAxis = planeAxes.find(a => a !== targetAxis) ?? planeAxes[1];
    // Yüzey düzlemi tabanı: dirVec=ok yönü, perpVec=düzlemde dik, zAxis=normal; panel dönüşüyle dünyaya.
    const dirVec = new THREE.Vector3().setComponent(targetAxis, 1), perpVec = new THREE.Vector3().setComponent(otherAxis, 1);
    const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(dirVec, perpVec, new THREE.Vector3().crossVectors(dirVec, perpVec).normalize())).premultiply(Q);
    // İnce eksen boyunca dışa ofset; eğik panelde ok YUKARI bakan büyük yüze konur.
    const normalUnit = new THREE.Vector3().setComponent(thinAxisIndex, 1);
    if (normalUnit.clone().applyQuaternion(Q).y < -1e-6) normalUnit.negate();
    const position = center.clone().addScaledVector(normalUnit, thinHalf + 3).applyQuaternion(Q);
    // Düz ok silüeti (+X yönünde), panele oranlı boyut
    const planeSpan = Math.min(size.getComponent(planeAxes[0]), size.getComponent(planeAxes[1]));
    const L = THREE.MathUtils.clamp(planeSpan * 0.5, 90, 260), sw = L * 0.20, hw = L * 0.46, hl = L * 0.34;
    const sx = -L / 2, ex = L / 2, neck = ex - hl;
    const pts: [number, number][] = [[sx, -sw / 2], [neck, -sw / 2], [neck, -hw / 2], [ex, 0], [neck, hw / 2], [neck, sw / 2], [sx, sw / 2]];
    const shape = new THREE.Shape();
    shape.moveTo(pts[0][0], pts[0][1]);
    for (const [x, y] of pts.slice(1)) shape.lineTo(x, y);
    shape.closePath();
    const outline: Vec3[] = [...pts, pts[0]].map(([x, y]) => [x, y, 0]);
    return { position: position.toArray() as Vec3, quaternion: quat.toArray() as [number, number, number, number], arrowGeo: new THREE.ShapeGeometry(shape), outline };
  }, [geometry, arrowRotated, transformSteps]);
  useEffect(() => () => { arrowConfig?.arrowGeo?.dispose(); }, [arrowConfig]);
  if (!arrowConfig) return null;
  return (
    <group position={arrowConfig.position} quaternion={arrowConfig.quaternion} renderOrder={11}>
      <mesh geometry={arrowConfig.arrowGeo} renderOrder={11} raycast={() => null}>
        <meshBasicMaterial color={PANEL_COLORS.arrow.fill} side={THREE.DoubleSide} depthTest={false} depthWrite={false} transparent opacity={0.95} />
      </mesh>
      <Line points={arrowConfig.outline} color={PANEL_COLORS.arrow.outline} lineWidth={2} transparent={false} depthTest={false} depthWrite={false} renderOrder={12} raycast={() => null} />
    </group>
  );
});

PanelDrawing.displayName = 'PanelDrawing';
DirectionArrow.displayName = 'DirectionArrow';

// ═══════════════════════════════════════════════════════════════════════════
// FaceOverlays — SEÇİLİ GÖVDE ÜZERİNDE ÇALIŞAN 3B KATMANLAR.
//  1. FaceRaycastOverlay: panel yerleştirme (yüz yakalama + serbest bölge önizlemesi)
//  2. VirtualFaceOverlay: paneli olmayan VF'lerin çizimi
//  3. FaceEditor: fillet için yüz seçimi (sağ tık) + grup sınır çizgileri
//  4. Fillet: applyFilletToShape + FilletEdgeLines
//  5. VolumePickOverlay: raf/dikme için 3B hacim seçimi
// (Eski FaceRaycastOverlay + FaceEditor + Fillet + VolumePickOverlay.)
// ═══════════════════════════════════════════════════════════════════════════

/** Geometrinin yüzleri + eş-düzlem grupları (geometri değişince tazelenir). */
function useFaceGroups(geometry: THREE.BufferGeometry | undefined, onChange?: () => void) {
  const [faces, setFaces] = useState<FaceData[]>([]);
  const [groups, setGroups] = useState<CoplanarFaceGroup[]>([]);
  const uuid = geometry?.uuid || '';
  useEffect(() => {
    if (!geometry) return;
    const r = getFacesAndGroups(geometry);
    setFaces(r.faces); setGroups(r.groups);
    onChange?.();
  }, [geometry, uuid]);
  return { faces, groups };
}

/** Şeklin yerel→dünya ve dünya→yerel matrisleri (konum/dönüş/ölçek değişince). */
function useShapeMatrices(shape: any) {
  const localToWorld = useMemo(() => getShapeMatrix(shape),
    [shape.position[0], shape.position[1], shape.position[2], shape.rotation[0], shape.rotation[1], shape.rotation[2], shape.scale[0], shape.scale[1], shape.scale[2]]);
  const worldToLocal = useMemo(() => localToWorld.clone().invert(), [localToWorld]);
  return { localToWorld, worldToLocal };
}

const highlightMat = (color: number, opacity: number, offset = -2, depthTest = false) => (
  <meshBasicMaterial color={color} transparent opacity={opacity} side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={offset} polygonOffsetUnits={offset} depthTest={depthTest} />
);

// ── 1. PANEL YERLEŞTİRME (yüz yakalama) ──────────────────────────────────────

interface PendingPreview { geo: THREE.BufferGeometry; edgeGeo: THREE.BufferGeometry; virtualFace: VirtualFace }

/**
 * Tıklanan yüz bileşeninin serbest bölgesini (highlight) ve ondan doğan VF'yi üretir.
 * HIGHLIGHT = PANEL: bölge, ayak izleri ve grid tek fonksiyondan (computeFreeRegionLocal)
 * gelir; sanal yüzey gördüğünüz mavi alanın ta kendisidir. Kontur/düzlem YEREL
 * uzaydadır; panel ayak izleri dünya→yerel ters dönüşümle aynı düzleme getirilir.
 */
export function buildFacePreview(
  clickWorld: THREE.Vector3, group: CoplanarFaceGroup, faces: FaceData[], worldToLocal: THREE.Matrix4,
  shapeId: string, geometry?: THREE.BufferGeometry, childPanels: any[] = []
): PendingPreview | null {
  const clickLocal = clickWorld.clone().applyMatrix4(worldToLocal);
  const contour = computeFaceComponentContour(faces, group.faceIndices, clickLocal, group.normal);
  if (!contour) return null;
  const region = computeFreeRegionLocal(contour.corners, group.normal, clickLocal, childPanels, worldToLocal, shapeId);
  if (!region) return null;
  const { u, v, planeN, uMin, vMin, cw, ch, nx, ny, reach, footprints, touchingSiblingIds } = region;
  const nrm = group.normal.clone().normalize();
  const to3D = (px: number, py: number) => new THREE.Vector3().addScaledVector(u, px).addScaledVector(v, py).addScaledVector(nrm, planeN);
  const pos: number[] = [], epos: number[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!reach[j * nx + i]) continue;
    const x0 = uMin + i * cw, x1 = x0 + cw, y0 = vMin + j * ch, y1 = y0 + ch;
    const p00 = to3D(x0, y0), p10 = to3D(x1, y0), p11 = to3D(x1, y1), p01 = to3D(x0, y1);
    pos.push(p00.x, p00.y, p00.z, p10.x, p10.y, p10.z, p11.x, p11.y, p11.z, p00.x, p00.y, p00.z, p11.x, p11.y, p11.z, p01.x, p01.y, p01.z);
    // Sınır kenarı: komşusu erişilemezse çiz
    const bnd: Array<[THREE.Vector3, THREE.Vector3]> = [];
    if (i === 0 || !reach[j * nx + i - 1]) bnd.push([p00, p01]);
    if (i === nx - 1 || !reach[j * nx + i + 1]) bnd.push([p10, p11]);
    if (j === 0 || !reach[(j - 1) * nx + i]) bnd.push([p00, p10]);
    if (j === ny - 1 || !reach[(j + 1) * nx + i]) bnd.push([p01, p11]);
    for (const [a, b] of bnd) epos.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  // YER YOKSA HIGHLIGHT YOK: yüzey tamamen kardeşlerle kaplıysa panel yaratılmaz.
  if (pos.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.computeVertexNormals();
  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(epos), 3));

  const bb2 = (pts: Point2D[]) => { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const q of pts) { a = Math.min(a, q.x); b = Math.max(b, q.x); c = Math.min(c, q.y); d = Math.max(d, q.y); }
    return `u[${a.toFixed(0)}..${b.toFixed(0)}] v[${c.toFixed(0)}..${d.toFixed(0)}]`; };
  console.log('[YAGO][TIK] BÖLGE yüz=', bb2(region.ring2D), 'VF=', bb2(region.polygon), 'köşeN=', region.polygon.length, 'ayakİziN=', footprints.length,
    'ayakİzleri=', footprints.map(f => bb2(f)).join(' | ') || 'YOK');
  console.log('[YAGO][TIK]', 'clickLocal=', `${clickLocal.x.toFixed(1)},${clickLocal.y.toFixed(1)},${clickLocal.z.toFixed(1)}`, 'konturKöşeN=', contour.corners.length);
  const localNormal = group.normal.clone().normalize();
  // BÖLGE KİMLİĞİ: merkez = kullanıcının TIKLADIĞI nokta (bileşen merkezi değil): aynı
  // yüzdeki iki panelin VF'leri farklı merkez taşır; kardeş kesimi doğru tarafı tutar.
  const anchor = to3D(region.anchor.x, region.anchor.y);
  const virtualFace: VirtualFace = {
    id: genId('vf'), shapeId,
    normal: [localNormal.x, localNormal.y, localNormal.z],
    center: [clickLocal.x, clickLocal.y, clickLocal.z],
    vertices: region.polygon.map(p2 => { const c = to3D(p2.x, p2.y); return [c.x, c.y, c.z] as [number, number, number]; }),
    description: '', hasPanel: false, parentFaceShape: true, touchingSiblingIds,
    // DEĞİŞMEZ TARAF SÖZLEŞMESİ — DOĞUŞTAN KİLİT: tıklama anındaki taraf işaretleri VF'ye
    // hemen yazılır; regen STORED-WINS birleştirdiğinden bir daha değişmez.
    sideRelations: region.sideRelations,
    // ÖLÇEK-BAĞIMSIZ YÜZ KİMLİĞİ: resize'da regen yüzü bu descriptor ile bulur.
    faceGroupDescriptor: geometry ? createFaceDescriptor(faces[contour.seedFi], geometry) : undefined,
    // BÖLGE ÇAPASI (3B, parent-yerel): bölgenin içinde serbest bir hücre — dönüş-kesiminde taraf tayini.
    ...({ regionAnchor: [anchor.x, anchor.y, anchor.z] } as any),
  };
  return { geo, edgeGeo, virtualFace };
}

// Panel yerleştirme: hover/önizleme ortak SEÇİM PALETİ'nden; paneli olan yüz nötr gri. VF çizimi (seçim değil) sky kalır.
const RAYCAST_COLORS = { previewFill: SEL_COLORS.active, previewEdge: SEL_COLORS.edge, hoverEmpty: SEL_COLORS.hover, hoverHasVF: SEL_COLORS.muted, vfFill: 0x38bdf8, vfEdge: 0x0369a1 };

function buildSurfaceMeshes(vf: VirtualFace): { geo: THREE.BufferGeometry; edgeGeo: THREE.BufferGeometry } | null {
  if (vf.vertices.length < 3) return null;
  const corners = vf.vertices.map(v => new THREE.Vector3(v[0], v[1], v[2]));
  const normal = new THREE.Vector3(...vf.normal).normalize();
  const { u: uAxis, v: vAxis } = getFacePlaneAxes(normal);
  const origin = corners[0];
  const projected2D = corners.map(c => { const d = new THREE.Vector3().subVectors(c, origin); return { x: d.dot(uAxis), y: d.dot(vAxis) }; });
  let area = 0;
  for (let i = 0; i < projected2D.length; i++) { const j = (i + 1) % projected2D.length; area += projected2D[i].x * projected2D[j].y - projected2D[j].x * projected2D[i].y; }
  if (area < 0) { projected2D.reverse(); corners.reverse(); }
  const triIndices = earClipTriangulate(projected2D);
  const positions = new Float32Array(triIndices.length * 3);
  triIndices.forEach((ti, i) => { const c = corners[ti]; positions[i * 3] = c.x; positions[i * 3 + 1] = c.y; positions[i * 3 + 2] = c.z; });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  const edgeVerts: number[] = [];
  for (let i = 0; i < corners.length; i++) { const a = corners[i], b = corners[(i + 1) % corners.length]; edgeVerts.push(a.x, a.y, a.z, b.x, b.y, b.z); }
  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(edgeVerts), 3));
  return { geo, edgeGeo };
}

// ── 2. VF ÇİZİMİ (paneli olmayan VF'ler) ─────────────────────────────────────

export const VirtualFaceOverlay: React.FC<{ shape: any }> = ({ shape }) => {
  const { virtualFaces, setSelectedPanelRow, panelSelectMode } = useStoreFields('virtualFaces', 'setSelectedPanelRow', 'panelSelectMode');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const shapeFaces = useMemo(() => virtualFaces.filter(f => f.shapeId === shape.id && !f.hasPanel), [virtualFaces, shape.id]);
  const meshes = useMemo(() => shapeFaces.map(vf => { const r = buildSurfaceMeshes(vf); return r ? { id: vf.id, vf, ...r } : null; })
    .filter(Boolean) as Array<{ id: string; vf: VirtualFace; geo: THREE.BufferGeometry; edgeGeo: THREE.BufferGeometry }>, [shapeFaces]);
  if (meshes.length === 0) return null;
  return (
    <>
      {meshes.map((surface) => (
        <React.Fragment key={surface.id}>
          <mesh geometry={surface.geo}
            onClick={(e) => { e.stopPropagation(); if (panelSelectMode) setSelectedPanelRow(`vf-${surface.vf.id}`, shape.id); }}
            onPointerOver={(e) => { e.stopPropagation(); setHoveredId(surface.id); }}
            onPointerOut={(e) => { e.stopPropagation(); setHoveredId(null); }}>
            {highlightMat(RAYCAST_COLORS.vfFill, hoveredId === surface.id ? 0.55 : 0.30)}
          </mesh>
          <lineSegments geometry={surface.edgeGeo}>
            <lineBasicMaterial color={RAYCAST_COLORS.vfEdge} linewidth={2} depthTest={false} transparent opacity={0.85} />
          </lineSegments>
        </React.Fragment>
      ))}
    </>
  );
};

export const FaceRaycastOverlay: React.FC<{ shape: any; allShapes?: any[] }> = ({ shape, allShapes = [] }) => {
  const { raycastMode, setRaycastMode, addVirtualFace, virtualFaces, setSelectedPanelRow } = useStoreFields('raycastMode', 'setRaycastMode', 'addVirtualFace', 'virtualFaces', 'setSelectedPanelRow');
  const [hoveredGroupIndex, setHoveredGroupIndex] = useState<number | null>(null);
  const [pending, setPending] = useState<PendingPreview | null>(null);
  const lastClickRef = useRef<{ point: THREE.Vector3; groupIndex: number; cycleIndex: number } | null>(null);
  const shapeVirtualFaces = useMemo(() => virtualFaces.filter(vf => vf.shapeId === shape.id), [virtualFaces, shape.id]);
  // Panel yerleştirme düzenlenmiş gövdeyi görür — tıklanan yüz ve VF kübün yeni şekline aittir.
  const vertexModsKeyStr = JSON.stringify(shape.vertexModifications || []);
  const effGeometry = useMemo(() => effectiveBodyGeometry(shape), [shape.geometry, shape.geometry?.uuid, vertexModsKeyStr]);
  const { localToWorld, worldToLocal } = useShapeMatrices(shape);
  const { faces, groups: faceGroups } = useFaceGroups(effGeometry, () => { setPending(null); lastClickRef.current = null; });
  useEffect(() => { if (!raycastMode) { setHoveredGroupIndex(null); setPending(null); lastClickRef.current = null; } }, [raycastMode]);
  // Kısaltılmış panelin bıraktığı boşluk gezilebilsin diye GÜNCEL geometri. İÇ PANELLER (raf/dikme) de
  // girer: yeni panel her zaman sırada SONRA → mevcut dikme/raf onu basar, bölge tıklanan bölmede kalır.
  const childPanels = useMemo(() => childPanelsOf(shape.id, allShapes), [allShapes, shape.id]);
  // Aynı DÜZLEMDEKİ tüm VF'ler (bir yüzde birden çok panel olabilir).
  const groupHasVirtualFace = useCallback((gi: number): boolean => {
    if (gi < 0 || gi >= faceGroups.length || shapeVirtualFaces.length === 0) return false;
    const gn = faceGroups[gi].normal.clone().normalize(), gc = faceGroups[gi].center;
    return shapeVirtualFaces.some(vf => Math.abs(gn.dot(new THREE.Vector3(...vf.normal).normalize())) >= 0.98
      && Math.abs(new THREE.Vector3(...vf.center).sub(gc).dot(gn)) < 2);
  }, [faceGroups, shapeVirtualFaces]);
  const hoverHighlightGeometry = useMemo(() => (hoveredGroupIndex === null || !faceGroups[hoveredGroupIndex]) ? null
    : createFaceHighlightGeometry(faces, faceGroups[hoveredGroupIndex].faceIndices), [hoveredGroupIndex, faceGroups, faces]);
  const handlePointerMove = (e: any) => {
    if (!raycastMode || faces.length === 0) return;
    e.stopPropagation();
    const gi = groupIndexOfFace(faceGroups, e.faceIndex);
    if (gi !== -1) setHoveredGroupIndex(gi);
  };
  const handlePointerDown = (e: any) => {
    if (!raycastMode) return;
    if (e.button === 2) {
      e.stopPropagation();
      if (pending) { addVirtualFace(pending.virtualFace); setPending(null); lastClickRef.current = null; setRaycastMode(false); }
      return;
    }
    if (e.button !== 0) return;
    e.stopPropagation();
    if (hoveredGroupIndex === null || !faceGroups[hoveredGroupIndex]) return;
    const clickPoint: THREE.Vector3 = e.point.clone();
    const clickLocal = clickPoint.clone().applyMatrix4(worldToLocal);
    const isSameSpot = lastClickRef.current && lastClickRef.current.point.distanceTo(clickLocal) < 5;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(localToWorld);
    const worldNormalOf = (gi: number) => faceGroups[gi].normal.clone().normalize().applyMatrix3(normalMatrix).normalize();
    // PANEL-İÇİ TIKLAMA: tıklanan nokta bu yüzeye DEĞEN bir panelin GÜNCEL ayak izi
    // içindeyse yüz o noktada "tanımlıdır" (taşınmış olsa bile); aradaki boşluk serbesttir.
    const coveringPanel = findPanelCoveringPoint(clickPoint, childPanels, worldNormalOf(hoveredGroupIndex), clickPoint);
    const hoveredIsDefined = coveringPanel !== null;

    let targetGroupIndex = hoveredGroupIndex;
    let previewClickPoint = clickPoint;
    let cycleCandidates: Array<{ index: number; depth: number; hitPoint: THREE.Vector3 }> | null = null;
    const cameraPos = e.camera?.position?.clone();
    if (cameraPos && (isSameSpot || hoveredIsDefined)) {
      // DERİNLİK DÖNGÜSÜ: ışının deldiği yüz grupları (panel izi altındakiler atlanır; boşluklar geçerli hedeftir).
      const rayDir = clickPoint.clone().sub(cameraPos).normalize();
      const candidateGroups: Array<{ index: number; depth: number; hitPoint: THREE.Vector3 }> = [];
      for (let gi = 0; gi < faceGroups.length; gi++) {
        const group = faceGroups[gi];
        const nW = worldNormalOf(gi);
        const denom = nW.dot(rayDir);
        if (Math.abs(denom) < 1e-6) continue;
        const t = group.center.clone().applyMatrix4(localToWorld).sub(cameraPos).dot(nW) / denom;
        if (t < 0) continue;
        const hitOnPlane = cameraPos.clone().addScaledVector(rayDir, t);
        if (findPanelCoveringPoint(hitOnPlane, childPanels, nW, hitOnPlane)) continue;
        const inside = group.faceIndices.some(fi => {
          const f = faces[fi];
          return !!f && pointInTriangle3D(hitOnPlane, f.vertices[0].clone().applyMatrix4(localToWorld), f.vertices[1].clone().applyMatrix4(localToWorld), f.vertices[2].clone().applyMatrix4(localToWorld));
        });
        if (inside) candidateGroups.push({ index: gi, depth: t, hitPoint: hitOnPlane });
      }
      cycleCandidates = candidateGroups.sort((a, b) => a.depth - b.depth);
    }
    if (cycleCandidates && cycleCandidates.length > 0) {
      const nextCycleIndex = isSameSpot && !hoveredIsDefined ? (lastClickRef.current!.cycleIndex + 1) % cycleCandidates.length : 0;
      targetGroupIndex = cycleCandidates[nextCycleIndex].index;
      previewClickPoint = cycleCandidates[nextCycleIndex].hitPoint;
      lastClickRef.current = { point: clickLocal, groupIndex: targetGroupIndex, cycleIndex: nextCycleIndex };
    } else if (hoveredIsDefined) {
      const vfId = coveringPanel?.parameters?.virtualFaceId;
      if (vfId) setSelectedPanelRow(`vf-${vfId}`, shape.id);
      return;
    } else {
      lastClickRef.current = { point: clickLocal, groupIndex: targetGroupIndex, cycleIndex: 0 };
    }
    setHoveredGroupIndex(targetGroupIndex);
    // TAM YÜZ SEÇİMİ: tıklanan yüzün bağlantılı bileşeni komple seçilir.
    setPending(buildFacePreview(previewClickPoint, faceGroups[targetGroupIndex], faces, worldToLocal, shape.id, effGeometry, childPanels));
  };
  if (!raycastMode) return null;
  return (
    <>
      <mesh geometry={effGeometry} visible={false} onPointerMove={handlePointerMove} onPointerOut={(e) => { e.stopPropagation(); setHoveredGroupIndex(null); }} onPointerDown={handlePointerDown} />
      {hoverHighlightGeometry && (
        <mesh geometry={hoverHighlightGeometry} raycast={() => null}>
          {highlightMat(hoveredGroupIndex !== null && groupHasVirtualFace(hoveredGroupIndex) ? RAYCAST_COLORS.hoverHasVF : RAYCAST_COLORS.hoverEmpty, SEL_COLORS.faceHoverOpacity, -1, true)}
        </mesh>
      )}
      {pending && (
        <>
          <mesh geometry={pending.geo} raycast={() => null}>{highlightMat(RAYCAST_COLORS.previewFill, SEL_COLORS.faceActiveOpacity)}</mesh>
          <lineSegments geometry={pending.edgeGeo} raycast={() => null}>
            <lineBasicMaterial color={RAYCAST_COLORS.previewEdge} depthTest={false} transparent opacity={0.9} />
          </lineSegments>
        </>
      )}
    </>
  );
};

// ── 3. FILLET YÜZ SEÇİMİ ─────────────────────────────────────────────────────

export const FaceEditor: React.FC<{ shape: any }> = ({ shape }) => {
  const { filletMode, selectedFilletFaces, addFilletFace, addFilletFaceData } = useStoreFields('filletMode', 'selectedFilletFaces', 'addFilletFace', 'addFilletFaceData');
  const { faces, groups: faceGroups } = useFaceGroups(shape.geometry);
  const [hoveredGroupIndex, setHoveredGroupIndex] = useState<number | null>(null);

  /** Sağ tık: yüz grubunu seçer; düzlem sabiti eksen-hizalı yüzde düz üçgenlerin UÇ değerinden (fillet doğruluğu). */
  const handleFaceSelection = (groupIndex: number) => {
    if (!filletMode || selectedFilletFaces.length >= 2) return;
    const group = faceGroups[groupIndex];
    if (!group) return;
    const n = group.normal;
    const ax = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)];
    const k = ax.indexOf(Math.max(...ax));
    let planeD = n.dot(group.center);
    if (ax[k] > 0.9 && shape.geometry) {
      const inGroup = faces.filter(f => group.faceIndices.includes(f.faceIndex));
      const flat = inGroup.filter(f => !f.isCurved);
      const vals = (flat.length > 0 ? flat : inGroup).flatMap(f => f.vertices).map(v => v.getComponent(k));
      if (vals.length > 0) planeD = n.getComponent(k) * (n.getComponent(k) > 0 ? Math.max(...vals) : Math.min(...vals));
    }
    addFilletFace(groupIndex);
    addFilletFaceData({ normal: [n.x, n.y, n.z], center: [group.center.x, group.center.y, group.center.z], planeD });
  };
  const handlePointerMove = (e: any) => {
    if (faces.length === 0) return;
    e.stopPropagation();
    const gi = groupIndexOfFace(faceGroups, e.faceIndex);
    if (gi !== -1) setHoveredGroupIndex(gi);
  };
  const selectedFilletGeometries = useMemo(() => (!filletMode || selectedFilletFaces.length === 0) ? []
    : selectedFilletFaces.map(gi => faceGroups[gi] ? createFaceHighlightGeometry(faces, faceGroups[gi].faceIndices) : null).filter((g): g is THREE.BufferGeometry => !!g),
    [filletMode, selectedFilletFaces, faceGroups, faces]);
  const highlightGeometry = useMemo(() => (hoveredGroupIndex === null || !faceGroups[hoveredGroupIndex]) ? null
    : createFaceHighlightGeometry(faces, faceGroups[hoveredGroupIndex].faceIndices), [hoveredGroupIndex, faceGroups, faces]);
  const boundaryEdgesGeometry = useMemo(() => (faces.length === 0 || faceGroups.length === 0) ? null : createGroupBoundaryEdges(faces, faceGroups), [faces, faceGroups]);
  return (
    <>
      <mesh geometry={shape.geometry} visible={false} onPointerMove={handlePointerMove} onPointerOut={(e) => { e.stopPropagation(); setHoveredGroupIndex(null); }}
        onPointerDown={(e) => { e.stopPropagation(); if (e.button === 2 && hoveredGroupIndex !== null) handleFaceSelection(hoveredGroupIndex); }} />
      {selectedFilletGeometries.map((geom, idx) => <mesh key={`selected-${idx}`} geometry={geom}>{highlightMat(SEL_COLORS.active, SEL_COLORS.faceActiveOpacity)}</mesh>)}
      {highlightGeometry && !selectedFilletFaces.includes(hoveredGroupIndex!) && <mesh geometry={highlightGeometry}>{highlightMat(SEL_COLORS.hover, SEL_COLORS.faceHoverOpacity)}</mesh>}
      {boundaryEdgesGeometry && (
        <lineSegments geometry={boundaryEdgesGeometry}>
          <lineBasicMaterial color={0xffffff} linewidth={2} depthTest={false} transparent opacity={0.9} />
        </lineSegments>
      )}
    </>
  );
};

// ── 4. FILLET UYGULAMA + KENAR ÇİZGİLERİ ─────────────────────────────────────

/** Seçili iki yüz grubunun ortak kenarlarına fillet uygular; FilletInfo (yeniden kurulumda kullanılır) döner. */
export async function applyFilletToShape(shape: any, selectedFilletFaces: number[], selectedFilletFaceData: any[], radius: number)
  : Promise<{ geometry: THREE.BufferGeometry; replicadShape: any; filletData: FilletInfo }> {
  if (!shape || !shape.replicadShape) throw new Error('Shape or replicadShape not found');
  if (selectedFilletFaces.length !== 2 || selectedFilletFaceData.length !== 2) throw new Error('Two faces must be selected for fillet operation');
  const { faces, groups } = getFacesAndGroups(shape.geometry);
  const faceOf = (gi: number) => faces.find(f => groups[gi].faceIndices.includes(f.faceIndex));
  const f1 = faceOf(selectedFilletFaces[0]), f2 = faceOf(selectedFilletFaces[1]);
  if (!f1 || !f2) throw new Error('Could not find face data for descriptors');
  const originalSize = { width: shape.parameters.width || 1, height: shape.parameters.height || 1, depth: shape.parameters.depth || 1 };
  const filletData: FilletInfo = {
    face1Descriptor: createFaceDescriptor(f1, shape.geometry), face2Descriptor: createFaceDescriptor(f2, shape.geometry),
    face1Data: selectedFilletFaceData[0], face2Data: selectedFilletFaceData[1], radius, originalSize,
  };
  const filletedShape = await applyFillets(shape.replicadShape, [filletData], originalSize);
  return { geometry: convertReplicadToThreeGeometry(filletedShape), replicadShape: filletedShape, filletData };
}

export const FilletEdgeLines: React.FC<{ shape: any }> = ({ shape }) => {
  const geo = useMemo(() => { if (!shape.geometry) return null; const { faces, groups } = getFacesAndGroups(shape.geometry); return createGroupBoundaryEdges(faces, groups); }, [shape.geometry]);
  if (!geo) return null;
  return (
    <lineSegments geometry={geo}>
      <lineBasicMaterial color="#000000" linewidth={2} opacity={1} transparent={false} depthTest={true} />
    </lineSegments>
  );
};

// ── 5. HACİM SEÇME (raf / dikme atma) ────────────────────────────────────────
// Tıklanan noktadan geçen ışın gövde kutusunu hücre hücre yürür; serbest hücreden
// taşılarak şekilli bölge bulunur (gövde katısı + paneller sınırlar). Fare: ilk aday
// çok soluk petrol; sol tık aynı ışındaki adaylar arasında döner — soluk petrol dolgu +
// İNCE KIRMIZI dış çizgi (SEL_COLORS.volumeEdge); sağ tık (ya da şerit ✓) gruptan oluşturur.
// Görünmez kutu mesh'i olayları alır — açık yüzlerde de çalışır.
const PICK_COLORS = { hover: SEL_COLORS.hover, selected: SEL_COLORS.active, selectedEdge: SEL_COLORS.volumeEdge };

/** Bölge dış yüzeyi → mesh geometrisi + siluet kenar noktaları (eş-düzlem dikişler elenir). */
function surfaceMesh(surface: number[]): { geo: THREE.BufferGeometry; edgePts: [number, number, number][] } {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(surface), 3));
  return { geo, edgePts: edgePointsOf(geo, 1) };
}

/**
 * YÖN OKU (Goker: "tıklanan hacmin tam ortasına, hangi yüzeyden tıklandığını
 * gösteren temsili bir ok"; ok = tıklanan gövde yüzünden içeri, kameradan
 * bağımsız; dikme oka PARALEL yerleşir). BİÇİM (Goker'in örnek görseli): uzun
 * kare kesitli gövde, ucu 45° iki koldan oluşan AÇIK V (chevron), kök DÜZ kesik,
 * kırmızı; yüzler ışıktan bağımsız köşe renkleriyle gölgelenir + koyu kenar çizgisi.
 * BOYUT: raf ve dikmede AYNI dünya boyu (FACING_ARROW.lengthMm); yakınlaşıp
 * uzaklaşınca ekranda minPx..maxPx aralığına kıstırılır — o eşiklerden sonra
 * ekranda sabit boyda kalır. Ok, ekseni etrafında kameraya döner (hafif eğimle,
 * kalınlık görünsün). Derinlik tamponu okun hemen öncesinde temizlenir: her şeyin
 * üstünde çizilir ama kendi yüzleri doğru örtüşür.
 * KONUM (Goker: "hacmin içinde değil, okun geldiği dış yüzeyde, biraz boşluklu —
 * içeride panel varsa ok panelin içine denk geliyor"): ok hacim kutusunun DIŞINDA,
 * ışının girdiği yüzün (okun geldiği yüz) merkezinin önünde durur; ucu yüzden
 * gapFrac·boy kadar açıkta, gövdesi dışarı doğru uzanır, hacme doğru bakar.
 * Yalnız hacim seçilirken görünür; raf/dikme yerleştikten sonra çizilmez.
 */
// Goker: "kırmızı ok çok az daha küçük olsun, çubuğu da kısa olsun" → ölçek ~%10 küçük (lengthMm/minPx/maxPx),
// gövde (çubuk) birim boyu 1 → shaftLen; uç (chevron) boyutu ölçekle birlikte aynı oranda kalır.
const FACING_ARROW = { color: '#dc2626', edge: '#7f1d1d', lengthMm: 108, minPx: 43, maxPx: 80, tiltRad: 0.5, gapFrac: 0.2, shaftLen: 0.62 } as const;

/** Chevron ok (toplam boy = shaftLen, uç ölçüsü birim ölçeğe göre), +X'e bakar, merkezli; kalınlık = kol genişliği. Köşe renkli (kapak açık, yanlar koyu). */
const FACING_ARROW_GEO: THREE.BufferGeometry = (() => {
  const L = FACING_ARROW.shaftLen, w = 0.075, h = w / 2, A = 0.34, r2 = Math.SQRT2;
  const up = (s: number, off: number): [number, number] => [(-s - off) / r2, (s - off) / r2];     // üst kol: dış kenardan off içeri
  const dn = (s: number, off: number): [number, number] => [(-s - off) / r2, (-s + off) / r2];    // alt kol
  const jx = -h - w * r2;                                                                          // gövde kenarı ↔ kol iç kenarı
  const pts: Array<[number, number]> = [[0, 0], up(A, 0), up(A, w), [jx, h], [-L, h], [-L, -h], [jx, -h], dn(A, w), dn(A, 0)];
  const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  let g: THREE.BufferGeometry = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false });
  g = g.index ? g.toNonIndexed() : g;
  g.computeBoundingBox();
  const c = g.boundingBox!.getCenter(new THREE.Vector3());
  g.translate(-c.x, -c.y, -c.z);
  g.computeVertexNormals();
  const pos = g.getAttribute('position'), cols = new Float32Array(pos.count * 3);
  const cap = new THREE.Color('#e02424'), sideLo = new THREE.Color('#8f1818'), sideHi = new THREE.Color('#b91c1c'), tmp = new THREE.Color();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); d.fromBufferAttribute(pos, i + 2);
    n.subVectors(b, a).cross(d.sub(a)).normalize();
    if (Math.abs(n.z) > 0.9) tmp.copy(cap); else tmp.copy(sideLo).lerp(sideHi, 0.5 + 0.5 * n.y);
    for (let k = 0; k < 3; k++) tmp.toArray(cols, (i + k) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  return g;
})();
const FACING_ARROW_EDGES = new THREE.EdgesGeometry(FACING_ARROW_GEO, 25);

export const FacingArrow: React.FC<{ box: { min: Vec3; max: Vec3 }; axis: 0 | 1 | 2; facing: 1 | -1 }> = ({ box, axis, facing }) => {
  const ref = useRef<THREE.Group>(null);
  // Okun geldiği yüzün merkezi (gövde-yerel): facing>0 → ok MİN yüzden içeri, facing<0 → MAX yüzden.
  const faceCenter = useMemo<Vec3>(() => {
    const c = boxCenterOf(box); c[axis] = facing > 0 ? box.min[axis] : box.max[axis]; return c;
  }, [box, axis, facing]);
  const t = useMemo(() => ({
    pPos: new THREE.Vector3(), pQuat: new THREE.Quaternion(), pScale: new THREE.Vector3(), pQuatInv: new THREE.Quaternion(),
    wp: new THREE.Vector3(), cam: new THREE.Vector3(), D: new THREE.Vector3(), V: new THREE.Vector3(), N: new THREE.Vector3(), Y: new THREE.Vector3(),
    m: new THREE.Matrix4(), q: new THREE.Quaternion(),
  }), []);
  useFrame(({ camera, size }) => {
    const g = ref.current;
    if (!g || !g.parent) return;
    g.parent.updateWorldMatrix(true, false);
    g.parent.matrixWorld.decompose(t.pPos, t.pQuat, t.pScale);
    t.wp.set(faceCenter[0], faceCenter[1], faceCenter[2]).applyMatrix4(g.parent.matrixWorld);
    camera.getWorldPosition(t.cam);
    // Ekran ölçeği: piksel başına dünya birimi (perspektif: mesafeye göre; ortografik: zoom).
    let wpp: number;
    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      const c = camera as THREE.OrthographicCamera;
      wpp = (c.top - c.bottom) / c.zoom / Math.max(1, size.height);
    } else {
      const c = camera as THREE.PerspectiveCamera;
      wpp = (2 * t.cam.distanceTo(t.wp) * Math.tan(THREE.MathUtils.degToRad(c.fov) / 2)) / (c.zoom || 1) / Math.max(1, size.height);
    }
    const px = THREE.MathUtils.clamp(FACING_ARROW.lengthMm / wpp, FACING_ARROW.minPx, FACING_ARROW.maxPx);
    const len = px * wpp;
    g.scale.set(len / (t.pScale.x || 1), len / (t.pScale.y || 1), len / (t.pScale.z || 1));
    // KONUM: yüz merkezinden okun TERSİNE (dışarı) boşluk + yarım boy (toplam boy = shaftLen·len) → ucu yüzün önünde, hacmin dışında.
    const back = (len * (FACING_ARROW.gapFrac + FACING_ARROW.shaftLen / 2)) / (t.pScale.getComponent(axis) || 1);
    g.position.set(faceCenter[0], faceCenter[1], faceCenter[2]);
    g.position.setComponent(axis, faceCenter[axis] - facing * back);
    // Yönelim: yerel X = ok yönü; düz yüz ok ekseni etrafında kameraya döner (+ eğim → kalınlık görünür).
    t.D.set(0, 0, 0).setComponent(axis, facing).applyQuaternion(t.pQuat).normalize();
    t.V.subVectors(t.cam, t.wp);
    t.N.copy(t.V).addScaledVector(t.D, -t.V.dot(t.D));
    if (t.N.lengthSq() < 1e-8) t.N.set(0, 1, 0).cross(t.D);
    if (t.N.lengthSq() < 1e-8) t.N.set(1, 0, 0).cross(t.D);
    t.N.normalize().applyAxisAngle(t.D, FACING_ARROW.tiltRad);
    t.Y.crossVectors(t.N, t.D).normalize();
    t.m.makeBasis(t.D, t.Y, t.N);
    t.q.setFromRotationMatrix(t.m);
    g.quaternion.copy(t.pQuatInv.copy(t.pQuat).invert().multiply(t.q));
  });
  return (
    <group ref={ref} position={faceCenter} scale={0.0001} renderOrder={30}>
      <mesh geometry={FACING_ARROW_GEO} raycast={() => null} renderOrder={30} frustumCulled={false} onBeforeRender={(r: THREE.WebGLRenderer) => r.clearDepth()}>
        <meshBasicMaterial vertexColors transparent opacity={1} depthTest depthWrite polygonOffset polygonOffsetFactor={1} polygonOffsetUnits={1} />
      </mesh>
      <lineSegments geometry={FACING_ARROW_EDGES} raycast={() => null} renderOrder={31} frustumCulled={false}>
        <lineBasicMaterial color={FACING_ARROW.edge} transparent opacity={0.9} depthTest depthWrite={false} />
      </lineSegments>
    </group>
  );
};

const boxCenterOf = (b: { min: Vec3; max: Vec3 }): Vec3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];

export const VolumePickOverlay: React.FC<{ shape: any; allShapes: any[] }> = ({ shape, allShapes }) => {
  const { volumePickMode, volumePickCandidates, volumePickIndex, setVolumePick, setVolumePickMode } =
    useStoreFields('volumePickMode', 'volumePickCandidates', 'volumePickIndex', 'setVolumePick', 'setVolumePickMode');
  const [hoverPick, setHoverPick] = useState<CavityPick | null>(null);
  const lastRef = useRef<{ keys: string; index: number } | null>(null);
  // Düz paneller kutu engeli; dönmüş/eğik paneller yarım-uzay (PanelGroupService.collectObstacles).
  const oset = useMemo(() => collectObstacles(shape, allShapes), [allShapes, shape]);
  const grid = useMemo(() => (volumePickMode ? gridForObstacles(shape, oset) : null), [shape, oset, volumePickMode]);
  const { worldToLocal } = useShapeMatrices(shape);
  // Görünmez yakalama kutusu: gövde kutusundan bir tık büyük (açık yüzlerde de tıklanır).
  const pickGeo = useMemo(() => {
    if (!grid) return null;
    const b = grid.body;
    const g = new THREE.BoxGeometry(boxSpan(b, 0) + 2, boxSpan(b, 1) + 2, boxSpan(b, 2) + 2);
    g.translate((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
    return g;
  }, [grid]);
  useEffect(() => () => { pickGeo?.dispose(); }, [pickGeo]);
  const selected = volumePickCandidates[volumePickIndex] || null;
  const selectedMesh = useMemo(() => (selected ? surfaceMesh(selected.surface) : null), [selected]);
  const hoverMesh = useMemo(() => (hoverPick ? surfaceMesh(hoverPick.surface) : null), [hoverPick]);
  useEffect(() => () => { selectedMesh?.geo.dispose(); }, [selectedMesh]);
  useEffect(() => () => { hoverMesh?.geo.dispose(); }, [hoverMesh]);
  useEffect(() => { if (!volumePickMode) { setHoverPick(null); lastRef.current = null; } }, [volumePickMode]);

  const candidatesFromEvent = (e: any): CavityPick[] => {
    if (!grid || !volumePickMode || !e?.ray) return [];
    const o = e.ray.origin.clone().applyMatrix4(worldToLocal);
    const d = e.ray.origin.clone().add(e.ray.direction).applyMatrix4(worldToLocal).sub(o).normalize();
    return rayCavityCandidates([o.x, o.y, o.z], [d.x, d.y, d.z], grid, GROUP_PANEL_THICKNESS * 2, volumePickMode);
  };
  const onPointerMove = (e: any) => {
    if (!volumePickMode) return;
    e.stopPropagation();
    const first = candidatesFromEvent(e)[0] || null;
    setHoverPick(prev => (prev?.key === first?.key ? prev : first));
  };
  const onPointerDown = (e: any) => {
    if (!volumePickMode) return;
    e.stopPropagation();
    if (e.button === 2) {
      if (selected) { createPanelGroupFromCavity(shape.id, volumePickMode, selected); setVolumePickMode(null); }
      return;
    }
    if (e.button !== 0) return;
    const c = candidatesFromEvent(e);
    if (!c.length) { setVolumePick([], 0); lastRef.current = null; console.log('[YAGO][HACİM] ışın boyunca serbest hacim yok'); return; }
    const keys = c.map(b => b.key).join(';');
    const index = lastRef.current && lastRef.current.keys === keys ? (lastRef.current.index + 1) % c.length : 0;
    lastRef.current = { keys, index };
    setVolumePick(c, index);
    const s = c[index];
    console.log('[YAGO][HACİM] aday', index + 1, '/', c.length, s.shape === 'box' ? 'DÜZ' : 'ŞEKİLLİ', fmtBox(s.bbox),
      'boyut=', [0, 1, 2].map(a => boxSpan(s.bbox, a).toFixed(0)).join('x'), 'parçaN=', s.boxes.length, 'engelN=', oset.obstacles.length, 'eğikN=', oset.tiltFaces.length,
      'ok=', `${'XYZ'[s.arrow.axis]}${s.arrow.facing > 0 ? '+' : '−'}`, 'dizilim=', `${'XYZ'[s.axis]}${s.facing > 0 ? '+' : '−'}`, 'giriş=', s.at.map(v => v.toFixed(0)).join(','));
  };

  if (!volumePickMode || !pickGeo) return null;
  const hoverIsSelected = !!hoverPick && !!selected && hoverPick.key === selected.key;
  return (
    <>
      <mesh geometry={pickGeo} visible={false} onPointerMove={onPointerMove} onPointerOut={() => setHoverPick(null)} onPointerDown={onPointerDown} onContextMenu={(e: any) => e.stopPropagation()} />
      {hoverMesh && !hoverIsSelected && (
        <mesh geometry={hoverMesh.geo} raycast={() => null} renderOrder={5}>
          <meshBasicMaterial color={PICK_COLORS.hover} transparent opacity={SEL_COLORS.volumeHoverOpacity} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      )}
      {selectedMesh && (
        <>
          <mesh geometry={selectedMesh.geo} raycast={() => null} renderOrder={6}>
            <meshBasicMaterial color={PICK_COLORS.selected} transparent opacity={SEL_COLORS.volumeActiveOpacity} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
          {selectedMesh.edgePts.length >= 2 && (
            <Line points={selectedMesh.edgePts} segments color={PICK_COLORS.selectedEdge} lineWidth={SEL_COLORS.edgeWidth} transparent={false} depthTest={false} depthWrite={false} renderOrder={7} raycast={() => null} />
          )}
          {/* YÖN OKU: yalnız sol tıkla seçilen adayda (hover'da değil), okun geldiği yüzün DIŞINDA, boşluklu; yerleştikten sonra çizilmez */}
          {selected && <FacingArrow box={selected.bbox} axis={selected.arrow.axis} facing={selected.arrow.facing} />}
        </>
      )}
    </>
  );
};

// ── 6. HACİM DÜZENLEME (raf/dikme hacmine yüz extrude) ──────────────────────
// Grubun güncel ŞEKİLLİ hacmi (bölge kutularının dış yüzeyi: L / çentik) soluk petrol dolgu
// + ince kırmızı kenarla çizilir; yüzleri panel extrude hedefi gibi seçilir (SEL_COLORS:
// hover açık, seçili orta petrol + sınır çizgisi). Seçilen yüzün gövde-yerel normali + tıklama noktası store'a
// yazılır (çıpa: hangi kolun/yüzün hareket edeceği); fixed/dyn şeritten, ref sağ tıkla.
export const CavityEditOverlay: React.FC<{ shape: any }> = ({ shape }) => {
  const { panelGroups, faceExtrudeCavityGroupId, faceExtrudeSelectedFace, setFaceExtrudeSelectedFace, setFaceExtrudeCavityFaceNormal, setFaceExtrudeClickPoint, faceExtrudeValueMode } =
    useStoreFields('panelGroups', 'faceExtrudeCavityGroupId', 'faceExtrudeSelectedFace', 'setFaceExtrudeSelectedFace', 'setFaceExtrudeCavityFaceNormal', 'setFaceExtrudeClickPoint', 'faceExtrudeValueMode');
  const group = panelGroups.find(g => g.id === faceExtrudeCavityGroupId);
  const active = !!group && group.shapeId === shape.id;
  const cav = group?.cavity;
  const boxes = group ? (group.region && group.region.length ? group.region : cav ? [cav] : []) : [];
  const cavKey = boxes.map(b => [...b.min, ...b.max].map(n => n.toFixed(1)).join('|')).join(';');
  const [hovered, setHovered] = useState<number | null>(null);
  const boxGeo = useMemo(() => {
    if (!boxes.length) return null;
    const surface = boxesSurface(boxes);
    if (surface.length < 9) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(surface), 3));
    g.computeVertexNormals();
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cavKey]);
  useEffect(() => () => { boxGeo?.dispose(); }, [boxGeo]);
  const { faces, groups } = useMemo(() => (boxGeo ? getFacesAndGroups(boxGeo) : { faces: [], groups: [] }), [boxGeo]);
  const edgePts = useMemo(() => (boxGeo ? edgePointsOf(boxGeo, 1) : []), [boxGeo]);
  const hoverGeo = useMemo(() => (hovered !== null && hovered !== faceExtrudeSelectedFace && groups[hovered] ? createFaceHighlightGeometry(faces, groups[hovered].faceIndices) : null), [hovered, faceExtrudeSelectedFace, groups, faces]);
  const selGeo = useMemo(() => (faceExtrudeSelectedFace !== null && groups[faceExtrudeSelectedFace] ? createFaceHighlightGeometry(faces, groups[faceExtrudeSelectedFace].faceIndices) : null), [faceExtrudeSelectedFace, groups, faces]);
  useEffect(() => { if (!active) setHovered(null); }, [active]);
  if (!active || !boxGeo) return null;
  const isRefPhase = faceExtrudeValueMode === 'ref' && faceExtrudeSelectedFace !== null;
  return (
    <>
      <mesh geometry={boxGeo} raycast={() => null} renderOrder={5}>
        <meshBasicMaterial color={PICK_COLORS.selected} transparent opacity={SEL_COLORS.volumeActiveOpacity} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      {edgePts.length >= 2 && <Line points={edgePts} segments color={PICK_COLORS.selectedEdge} lineWidth={SEL_COLORS.edgeWidth} transparent={false} depthTest={false} depthWrite={false} renderOrder={7} raycast={() => null} />}
      <mesh geometry={boxGeo} renderOrder={10}
        onPointerDown={(e: any) => {
          if (e.button === 2) { if (isRefPhase) void confirmRefOnRightClick(e); return; }
          if (e.button !== 0 || isRefPhase) return;   // ref aşamasında tıklama referans seçimine gider (gövde/panel)
          e.stopPropagation();
          const gi = flatGroupOfFace(groups, e.faceIndex);
          if (gi === -1) return;
          const n = groups[gi].normal.clone().normalize();
          setFaceExtrudeSelectedFace(gi);
          setFaceExtrudeCavityFaceNormal([n.x, n.y, n.z]);
          // ÇIPA: tıklama noktası gövde-yerel (şekilli hacimde hangi bağlantılı yüz hareket edecek).
          if (e.point) { const local = e.point.clone().applyMatrix4(getShapeMatrix(shape).invert()); setFaceExtrudeClickPoint([local.x, local.y, local.z]); }
          setHovered(gi);
          console.log('[YAGO][HACİM-ADIM] yüz seçildi', group!.id, 'normal=', [n.x, n.y, n.z].map(v => v.toFixed(0)).join(','), 'nokta=', e.point ? e.point.toArray().map((v: number) => v.toFixed(0)).join(',') : '-');
        }}
        onPointerMove={(e: any) => { e.stopPropagation(); const gi = flatGroupOfFace(groups, e.faceIndex); if (gi !== -1) setHovered(gi); }}
        onPointerOut={(e: any) => { e.stopPropagation(); setHovered(null); }}
        onContextMenu={(e: any) => e.stopPropagation()}>
        <HitMaterial />
      </mesh>
      {hoverGeo && <mesh geometry={hoverGeo} renderOrder={11} raycast={() => null}><OverlayMat color={SEL_COLORS.hover} opacity={SEL_COLORS.faceHoverOpacity} /></mesh>}
      {selGeo && (
        <>
          <mesh geometry={selGeo} renderOrder={12} raycast={() => null}><OverlayMat color={SEL_COLORS.active} opacity={SEL_COLORS.faceActiveOpacity} /></mesh>
          <FaceOutline geometry={selGeo} color={SEL_COLORS.edge} width={SEL_COLORS.extrudeEdgeWidth} />
        </>
      )}
    </>
  );
};

// ═══════════════════════════════════════════════════════════════════════════
// ShapeWithTransform — GÖVDE (kutu) ÇİZİMİ + TransformControls + seçili gövdede
// katmanlar (yüz yakalama, fillet yüz seçimi, hacim seçme, VF çizimi, ref-yüz).
// Paneller PanelDrawing ile çizilir (Scene panelleri oraya yollar).
// ═══════════════════════════════════════════════════════════════════════════

const EDGE_COLOR = '#5b6470';   // panellerdekiyle aynı: ince, antialias'lı, opak, yumuşak gri
type Xform = { position: Vec3; rotation: Vec3; scale: Vec3 };
const readXform = (o: THREE.Object3D): Xform => ({ position: o.position.toArray() as Vec3, rotation: o.rotation.toArray().slice(0, 3) as Vec3, scale: o.scale.toArray() as Vec3 });
/** İlk duruma göre (fark) dönüşüm: konum/dönüş toplanır, ölçek çarpılır. */
function deltaOf(from: Xform, to: Xform) {
  return { pd: [0, 1, 2].map(i => to.position[i] - from.position[i]), rd: [0, 1, 2].map(i => to.rotation[i] - from.rotation[i]), sd: [0, 1, 2].map(i => to.scale[i] / from.scale[i]) };
}
const applyDelta = (base: Xform, d: ReturnType<typeof deltaOf>): Xform => ({
  position: [base.position[0] + d.pd[0], base.position[1] + d.pd[1], base.position[2] + d.pd[2]],
  rotation: [base.rotation[0] + d.rd[0], base.rotation[1] + d.rd[1], base.rotation[2] + d.rd[2]],
  scale: [base.scale[0] * d.sd[0], base.scale[1] * d.sd[1], base.scale[2] * d.sd[2]],
});

/** Bir çıkarma (subtraction) kutusunun sahnedeki önizleme mesh'i. */
const SubtractionMesh: React.FC<{ subtraction: any; index: number; isHovered: boolean; isSubtractionSelected: boolean; isSelected: boolean; setHovered: (i: number | null) => void; setSelected: (i: number | null) => void }> =
  React.memo(({ subtraction, index, isHovered, isSubtractionSelected, isSelected, setHovered, setSelected }) => {
    // Merkezli (eski) geometri kök köşeye ötelenir.
    const meshOffset = useMemo<Vec3>(() => {
      const box = localBboxOf(subtraction.geometry)!;
      const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
      const isCentered = Math.abs(center.x) < 0.01 && Math.abs(center.y) < 0.01 && Math.abs(center.z) < 0.01;
      return isCentered ? [size.x / 2, size.y / 2, size.z / 2] : [0, 0, 0];
    }, [subtraction.geometry]);
    return (
      <group position={subtraction.relativeOffset} rotation={subtraction.relativeRotation}>
        <mesh geometry={subtraction.geometry} position={meshOffset}
          onPointerOver={(e) => { e.stopPropagation(); if (isSelected) setHovered(index); }}
          onPointerOut={(e) => { e.stopPropagation(); setHovered(null); }}
          onClick={(e) => { e.stopPropagation(); if (isSelected) setSelected(isSubtractionSelected ? null : index); }}>
          <meshStandardMaterial color={(isHovered || isSubtractionSelected) ? 0xff0000 : 0xffff00} transparent opacity={0.35} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      </group>
    );
  });
SubtractionMesh.displayName = 'SubtractionMesh';

export const ShapeWithTransform: React.FC<{ shape: any; isSelected: boolean; orbitControlsRef: any }> = React.memo(({ shape, isSelected, orbitControlsRef }) => {
  const S = useStoreFields('selectShape', 'selectSecondaryShape', 'secondarySelectedShapeId', 'selectedShapeId', 'activeTool', 'viewMode', 'subtractionViewMode',
    'hoveredSubtractionIndex', 'setHoveredSubtractionIndex', 'selectedSubtractionIndex', 'setSelectedSubtractionIndex', 'showOutlines', 'setSelectedPanelRow', 'panelSelectMode',
    'faceEditMode', 'filletMode', 'raycastMode', 'shapes', 'faceExtrudeMode', 'faceExtrudeValueMode', 'faceExtrudeTargetPanelId', 'faceExtrudeSelectedFace', 'faceExtrudeRefCandidate',
    'setFaceExtrudeRefCandidate', 'panelMoveMode', 'panelMoveValueMode', 'panelMoveRefSourceVertex', 'panelMoveRefTargetPanelId', 'panelRotateMode', 'volumePickMode',
    'faceExtrudeCavityGroupId');
  const { scene } = useThree();
  const meshRef = useRef<THREE.Mesh>(null);
  const groupRef = useRef<THREE.Group>(null);
  const isUpdatingRef = useRef(false);
  const cleanupListenersRef = useRef<(() => void) | null>(null);
  const initialRef = useRef<{ self: Xform; childPanels: Map<string, Xform> } | null>(null);
  const [localGeometry, setLocalGeometry] = useState(shape.geometry);
  const [geometryKey, setGeometryKey] = useState(0);
  const [hoveredRefGroup, setHoveredRefGroup] = useState<number | null>(null);
  // Ref-move: gövde (parent) hedef seçim aşamasında fare altındayken vurgulanır.
  const [moveRefHover, setMoveRefHover] = useState(false);
  const vertexModsString = useMemo(() => JSON.stringify(shape.vertexModifications || []), [shape.vertexModifications]);
  // Referans yüz seçimi (extrude-ref / rotate-ref) düzenlenmiş gövde yüzlerini görür.
  const { faces: refFaces, groups: refFaceGroups } = useMemo(() => (shape.geometry ? getFacesAndGroups(effectiveBodyGeometry(shape)) : { faces: [], groups: [] }), [shape.geometry, vertexModsString]);
  const edgePoints = useMemo<Vec3[] | null>(() => { try { const p = localGeometry ? edgePointsOf(localGeometry, 5) : []; return p.length ? p : null; } catch { return null; } }, [localGeometry]);

  // TEK KAYNAK: çizilen gövde = effectiveBodyGeometry (panel yerleştirme, VF regen ve motor da aynı geometriyi kullanır).
  useEffect(() => {
    const hasVertexMods = shape.vertexModifications && shape.vertexModifications.length > 0;
    if (!shape.geometry || !((shape.geometry !== localGeometry) || hasVertexMods)) return;
    if (hasVertexMods) console.log('[YAGO][VERTEX] gövde çizimi düzenlenmiş geometriyle güncellendi: düzenlemeN=', shape.vertexModifications.length);
    setLocalGeometry(hasVertexMods ? effectiveBodyGeometry(shape).clone() : shape.geometry.clone());
    setGeometryKey(prev => prev + 1);
  }, [shape.parameters?.width, shape.parameters?.height, shape.parameters?.depth, vertexModsString, shape.parameters?.modified, shape.geometry, shape.id]);

  useEffect(() => { isUpdatingRef.current = false; initialRef.current = null; }, [S.panelSelectMode]);

  // Pozisyon / rotasyon / ölçek senkronizasyonu
  useEffect(() => {
    if (!groupRef.current || (isUpdatingRef.current && shape.id === useAppStore.getState().selectedShapeId)) return;
    groupRef.current.position.set(...(shape.position as Vec3));
    groupRef.current.rotation.set(...(shape.rotation as Vec3));
    groupRef.current.scale.set(...(shape.scale as Vec3));
  }, [shape.position, shape.rotation, shape.scale, shape.id]);
  useEffect(() => () => { cleanupListenersRef.current?.(); cleanupListenersRef.current = null; }, []);

  // TransformControls: sürükleme boyunca çocuk paneller canlı taşınır; bırakınca store'a yazılır (grup üyeleri dahil).
  const transformRefCallback = useCallback((controls: any) => {
    cleanupListenersRef.current?.(); cleanupListenersRef.current = null;
    if (!controls || !groupRef.current) return;
    let isDragging = false;
    const onDraggingChanged = (event: any) => {
      isDragging = event.value;
      if (orbitControlsRef.current) orbitControlsRef.current.enabled = !event.value;
      if (event.value && groupRef.current) {
        initialRef.current = { self: readXform(groupRef.current), childPanels: new Map(childPanelsOf(shape.id).map(p => [p.id, { position: [...p.position] as Vec3, rotation: [...p.rotation] as Vec3, scale: [...p.scale] as Vec3 }])) };
      }
      if (!event.value && groupRef.current && initialRef.current) {
        const final = readXform(groupRef.current);
        const d = deltaOf(initialRef.current.self, final);
        const captured = initialRef.current.childPanels;
        initialRef.current = null;
        isUpdatingRef.current = true;
        useAppStore.setState((state) => {
          const sh = state.shapes.find(s => s.id === shape.id);
          if (!sh) return state;
          return { shapes: state.shapes.map(s => {
            if (s.id === shape.id) return { ...s, ...final };
            if (sh.groupId && s.groupId === sh.groupId) return { ...s, ...applyDelta(s, d) };
            const init = captured.get(s.id);
            return init ? { ...s, ...applyDelta(init, d) } : s;
          }) };
        });
        requestAnimationFrame(() => { isUpdatingRef.current = false; });
      }
    };
    const onChange = () => {
      if (!groupRef.current || !isDragging || !initialRef.current) return;
      isUpdatingRef.current = true;
      const d = deltaOf(initialRef.current.self, readXform(groupRef.current));
      initialRef.current.childPanels.forEach((init, panelId) => {
        const g = scene.getObjectByName(`shape-${panelId}`);
        if (!g) return;
        const x = applyDelta(init, d);
        g.position.set(...x.position); g.rotation.set(...x.rotation); g.scale.set(...x.scale);
      });
    };
    controls.addEventListener('dragging-changed', onDraggingChanged);
    controls.addEventListener('change', onChange);
    cleanupListenersRef.current = () => { controls.removeEventListener('dragging-changed', onDraggingChanged); controls.removeEventListener('change', onChange); };
  }, [shape.id, orbitControlsRef, scene]);

  // ── Görünüm / seçim durumu ─────────────────────────────────────────────────
  const isWireframe = S.viewMode === ViewMode.WIREFRAME;
  const isXray = S.viewMode === ViewMode.XRAY;
  const shouldShowAsReference = shape.isReferenceBox || shape.id === S.secondarySelectedShapeId;
  const hasPanels = S.shapes.some(s => s.type === 'panel' && s.parameters?.parentShapeId === shape.id);
  const noopRaycast = useCallback(() => {}, []);
  // Move ref modunda (kaynak köşe seçilip hedef panel beklenirken) gövde de tıklanabilir olmalı.
  const isMoveRefPickActive = S.panelMoveMode && S.panelMoveValueMode === 'ref' && !!S.panelMoveRefSourceVertex && !S.panelMoveRefTargetPanelId;
  const isRefMode = S.faceExtrudeMode && S.faceExtrudeValueMode === 'ref' && S.faceExtrudeSelectedFace !== null;
  // GÖVDE IŞINI (Goker: Body modunda blok TIKLAYARAK seçilebilmeli): görünmez gövde mesh'i yalnız
  // panel/yüz SEÇİMİ yapılan modlarda bastırılır; ref modları muaf. HACİM SEÇME: her zaman bastırılır
  // (olayları VolumePickOverlay'in görünmez kutusu alır).
  const isVolumePickOnThis = S.volumePickMode !== null && isSelected;
  const suppressBodyRaycast = (hasPanels && (S.panelSelectMode || S.raycastMode) && !isRefMode && !isMoveRefPickActive) || isVolumePickOnThis;
  const isMoveRefTargetPanel = S.panelMoveMode && S.panelMoveValueMode === 'ref' && !!S.panelMoveRefSourceVertex && S.panelMoveRefTargetPanelId === shape.id;
  // Gövde ref-move vurgusu: seçili referans gövde (yeşil) veya aday gövde (turuncu).
  const moveRefBodyHighlight = isMoveRefTargetPanel || (isMoveRefPickActive && moveRefHover);
  useEffect(() => { if (!isMoveRefPickActive && moveRefHover) setMoveRefHover(false); }, [isMoveRefPickActive, moveRefHover]);
  const isRefCandidateShape = isRefMode && S.faceExtrudeRefCandidate?.panelId === shape.id;

  // Gövdenin bir yüz grubunu referans adayı olarak işaretle — ışın boyunca DERİNLİK DÖNGÜSÜ (tüm şekiller, hedef hariç).
  const handleRefClick = useCallback((e: any) => {
    if (!isRefMode || shape.id === S.faceExtrudeTargetPanelId) return;
    // HACİM DÜZENLEME: grubun kendi üyeleri referans olamaz (hacimle birlikte taşınırlar).
    const cav = S.faceExtrudeCavityGroupId;
    const shapes = useAppStore.getState().shapes.filter((x: any) => !cav || x.parameters?.panelGroupId !== cav);
    cycleRefFacePickFromEvent(e, shapes, S.faceExtrudeTargetPanelId, S.setFaceExtrudeRefCandidate);
  }, [isRefMode, shape.id, S.faceExtrudeTargetPanelId, S.faceExtrudeCavityGroupId, S.setFaceExtrudeRefCandidate]);

  if (shape.isolated === false || !localGeometry) return null;

  const raycastProps = suppressBodyRaycast ? { raycast: noopRaycast } : {};
  const hoverProps = isMoveRefPickActive ? { onPointerOver: (e: any) => { e.stopPropagation(); setMoveRefHover(true); }, onPointerOut: () => { if (moveRefHover) setMoveRefHover(false); } } : {};
  // OUTLINE GÖRÜNÜRLÜĞÜ = kullanıcı tercihi VEYA panel yerleştirme (Body Panel / Shelf / Divider
  // seçimi) sürüyor: kapalıyken bile yerleştirme boyunca görünür, bitince tercihe döner.
  const outlinesVisible = S.showOutlines || S.raycastMode || !!S.volumePickMode;
  const outline = (color: string, width: number, depthWrite: boolean) => outlinesVisible && edgePoints && (
    <Line points={edgePoints} segments color={color} lineWidth={width} transparent={false} depthTest depthWrite={depthWrite} renderOrder={1} raycast={() => null} />
  );

  return (
    <>
      <group ref={groupRef} name={`shape-${shape.id}`}
        onClick={(e) => {
          // Referans modu tüm normal seçim mantığından ÖNCE: gövde yüzünü referans yap.
          if (isRefMode) { e.stopPropagation(); handleRefClick(e); return; }
          // Ref taşıma akışı: gövde seçimi YOK (referans döngüsü canvas seviyesinde, MoveRefPanelPicker).
          if (S.panelMoveMode && S.panelMoveValueMode === 'ref' && !!S.panelMoveRefSourceVertex) { e.stopPropagation(); return; }
          // AKTİF PANEL ARACI: tıklama ARACA aittir; stopPropagation YOK (arkadaki panelin araç işleyicisi olayı alır).
          if (S.faceExtrudeMode || S.panelMoveMode || S.panelRotateMode) return;
          if (S.volumePickMode) { e.stopPropagation(); return; }
          if (S.panelSelectMode && hasPanels) return;
          e.stopPropagation();
          if (e.nativeEvent.ctrlKey || e.nativeEvent.metaKey) {
            S.selectSecondaryShape(shape.id === S.secondarySelectedShapeId ? null : shape.id);
          } else {
            // BODY MODUNDA GÖVDE TIKLAMASI: blok komple seçilir, panel satırı temizlenir.
            S.selectShape(shape.id);
            S.selectSecondaryShape(null);
            if (S.panelSelectMode || hasPanels) S.setSelectedPanelRow(null);
          }
        }}
        onDoubleClick={(e) => { e.stopPropagation(); S.selectShape(shape.id); }}
        onContextMenu={(e: any) => { if (isMoveRefPickActive || isMoveRefTargetPanel) e.stopPropagation(); }}>
        {shape.subtractionGeometries && S.subtractionViewMode && shape.subtractionGeometries.map((sub: any, index: number) => sub && (
          <SubtractionMesh key={`${shape.id}-subtraction-${index}`} subtraction={sub} index={index} isHovered={S.hoveredSubtractionIndex === index && isSelected}
            isSubtractionSelected={S.selectedSubtractionIndex === index && isSelected} isSelected={isSelected} setHovered={S.setHoveredSubtractionIndex} setSelected={S.setSelectedSubtractionIndex} />
        ))}

        {/* SOLID */}
        {!isWireframe && !isXray && !shouldShowAsReference && (
          <>
            <mesh ref={meshRef} geometry={localGeometry} castShadow receiveShadow {...raycastProps} {...hoverProps}>
              <meshStandardMaterial color="#c8c8c8" emissive={moveRefBodyHighlight ? (isMoveRefTargetPanel ? '#22c55e' : REF_COLORS.hoverCss) : '#000000'} emissiveIntensity={moveRefBodyHighlight ? 0.9 : 0}
                metalness={0} roughness={1.0} transparent opacity={hasPanels ? (moveRefBodyHighlight ? 0.35 : 0) : (moveRefBodyHighlight ? 0.5 : 0.06)}
                side={THREE.DoubleSide} depthWrite={false} flatShading={false} polygonOffset polygonOffsetFactor={4} polygonOffsetUnits={8} />
            </mesh>
            {outline(EDGE_COLOR, isSelected ? EDGE_LINE_WIDTH + 0.5 : EDGE_LINE_WIDTH, false)}
          </>
        )}
        {/* WIREFRAME */}
        {isWireframe && (
          <>
            <mesh ref={meshRef} geometry={localGeometry} visible={false} {...raycastProps} />
            {outline(isSelected ? '#60a5fa' : shouldShowAsReference ? '#ef4444' : EDGE_COLOR, isSelected || shouldShowAsReference ? EDGE_LINE_WIDTH + 0.75 : EDGE_LINE_WIDTH + 0.25, true)}
          </>
        )}
        {/* X-RAY / REFERENCE */}
        {(isXray || shouldShowAsReference) && (
          <>
            <mesh ref={meshRef} geometry={localGeometry} castShadow receiveShadow {...raycastProps}>
              <meshStandardMaterial color={shouldShowAsReference ? '#ef4444' : '#c8c8c8'} emissive="#000000" emissiveIntensity={0} metalness={0} roughness={1.0} transparent
                opacity={hasPanels ? 0 : shouldShowAsReference ? 0.2 : 0.06} side={THREE.DoubleSide} depthWrite={false} flatShading={false} />
            </mesh>
            {outline(isSelected ? '#1e40af' : shouldShowAsReference ? '#991b1b' : EDGE_COLOR, isSelected || shouldShowAsReference ? EDGE_LINE_WIDTH + 0.5 : EDGE_LINE_WIDTH, false)}
          </>
        )}

        {/* EK KATMANLAR */}
        {shape.fillets?.length > 0 && S.filletMode && <FilletEdgeLines shape={shape} />}
        {isSelected && S.faceEditMode && <FaceEditor key={`face-editor-${shape.id}-${shape.geometry?.uuid || ''}-${(shape.fillets || []).length}`} shape={shape} />}
        {isSelected && S.raycastMode && <FaceRaycastOverlay key={`raycast-${shape.id}-${shape.geometry?.uuid || ''}`} shape={shape} allShapes={S.shapes} />}
        {/* REFERANS ADAYI GÖVDE: hover + seçili yüz vurgusu; sağ tık onaylar (Uygula ✓ ile eşdeğer). */}
        {isRefMode && (
          <RefFaceOverlay geometry={localGeometry} faces={refFaces} groups={refFaceGroups} hoveredGroup={hoveredRefGroup}
            candidateGroup={isRefCandidateShape ? (S.faceExtrudeRefCandidate?.faceGroupIndex ?? null) : null}
            onHover={setHoveredRefGroup} onPointerDown={confirmRefOnRightClick} onClick={(e: any) => { e.stopPropagation(); handleRefClick(e); }} />
        )}
        {isSelected && S.volumePickMode && <VolumePickOverlay shape={shape} allShapes={S.shapes} />}
        {S.faceExtrudeMode && S.faceExtrudeCavityGroupId && <CavityEditOverlay shape={shape} />}
        <VirtualFaceOverlay shape={shape} />
      </group>

      {isSelected && S.activeTool !== Tool.SELECT && groupRef.current && !shape.isReferenceBox && !S.panelSelectMode && (
        <TransformControls key={geometryKey} ref={transformRefCallback} object={groupRef.current}
          mode={S.activeTool === Tool.ROTATE ? 'rotate' : S.activeTool === Tool.SCALE ? 'scale' : 'translate'} size={0.8} />
      )}
    </>
  );
});
ShapeWithTransform.displayName = 'ShapeWithTransform';
