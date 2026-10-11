import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Line, TransformControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { type CavityPick, type DoorGroup, type DoorPick, type FilletInfo, Tool, ViewMode, type VirtualFace, childPanelsOf, useAppStore, useStoreFields } from '../store';
import {
  type CoplanarFaceGroup, type FaceData, type Vec3, applyFillets, convertReplicadToThreeGeometry, createFaceDescriptor, createFaceHighlightGeometry,
  createGroupBoundaryEdges, edgePointsOf, effectiveBodyGeometry, flatGroupOfFace, genId, getFacePlaneAxes, getFacesAndGroups, getShapeMatrix,
  groupIndexOfFace, localBboxOf,
} from './Geometry';
import { REF_COLORS, applyTransformSteps, confirmRefFaceExtrude, cycleRefFacePickFromEvent } from './PanelOps';
import { computeFaceComponentContour, computeFreeRegionLocal, earClipTriangulate, findPanelCoveringPoint, pointInTriangle3D } from './FaceRegion';
import {
  GROUP_PANEL_THICKNESS, boxSpan, boxesSurface, collectObstacles, confirmRefCavityExtrude, confirmVolumePick, gridForObstacles, groupBoundsPanelPredicate,
  rayCavityCandidates, repickObstacles,
} from './PanelGroupService';
import {
  type DoorMemberRect, collectDoorCuts, confirmDoorPick, doorCandidatesAt, doorMembersOf, doorPlaneAxes, doorRoleDefaults, doorSlabPolygon, isDoorPanel, pickRectFor,
  rayDoorEntry, roleOf, splitDoorAtPanel, vfBoundFor,
} from './DoorService';

/* Sahne nesneleri — canvas içinde şekil başına çizilen her şey: PanelDrawing (panel mesh/kenar/seçim tonu, ref-yüz),
   FaceOverlays (yüz yakalama, VF, fillet, hacim/kapak seçimi), ShapeWithTransform (gövde + TransformControls).
   RENK: seçili panel TARANMAZ — dolgu yumuşak çelik-mavi tona karışır (ışık gölgelemesi korunur), kenar koyu petrole döner.
   Her KAPAĞIN ön yüzünde şemadaki açılış işareti (ince kesikli V) durur; kapak seçiliyken petrol tonuna döner. */

const PANEL_COLORS = {
  selected: { shapeEdge: '#e8590c' },
  edge: { default: '#5b6470' },
  arrow: { fill: '#ff0000', outline: '#7f1d1d' },
} as const;

/** Panel/kapak seçim tonu: çelik mavisi — panel rengiyle `mix` oranında harmanlanır (beyaz panelde ≈ #9fb3cb); seçili panelin emissive'i
 *  koyulaşır ki ton beyaza yıkanmasın. Kenar aynı ailenin koyu petrol tonu; ışıklı gölgeleme korunduğu için hacim okunur kalır.
 *  Açılış işareti HER kapakta ince ve nötr (sıcak gri); kapak seçiliyken petrol tonuna döner. */
const PANEL_SELECT = {
  tint: '#4a7fae', mix: 0.7, emissive: '#141c24',
  edge: '#24506e', edgeExtra: 0.8,
} as const;
const DOOR_SWING = {
  idle: '#9a9389', idleWidth: 0.75,
  active: '#24506e', activeWidth: 1.0,
} as const;
const SELECT_TINT = new THREE.Color(PANEL_SELECT.tint);
const tintedPanelColor = (base: string | undefined) => `#${new THREE.Color(base || '#ffffff').lerp(SELECT_TINT, PANEL_SELECT.mix).getHexString()}`;

/** Tek seçim paleti (petrol mavisi): hover/active/edge/muted; extrude* yalnız panel yüz-extrude için (daha koyu).
 *  Hacimler büyük alan kapladığından daha düşük opaklıkla doldurulur. REF_COLORS (sarı) ayrı roldür. */
const SEL_COLORS = {
  hover: 0xa9c6d8, active: 0x3a7ca5, muted: 0xb8b2aa, edge: '#24577a',
  faceHoverOpacity: 0.4, faceActiveOpacity: 0.5,
  volumeHoverOpacity: 0.12, volumeActiveOpacity: 0.16,
  edgeWidth: 1.3,
  volumeEdge: '#dc2626',
  extrudeHover: 0x3a7ca5, extrudeHoverOpacity: 0.4,
  extrudeActive: 0x1f5578, extrudeActiveOpacity: 0.72,
  extrudeEdge: '#0f3550', extrudeEdgeWidth: 2.2,
} as const;

const DOOR_COLORS = { boundEdge: '#d97706', boundEmissive: '#6b4a10' } as const;

const FaceOutline: React.FC<{ geometry: THREE.BufferGeometry; color: string; width: number }> = ({ geometry, color, width }) => {
  const pts = useMemo(() => edgePointsOf(geometry, 1), [geometry]);
  if (pts.length < 2) return null;
  return <Line points={pts} segments color={color} lineWidth={width} transparent={false} depthTest={false} depthWrite={false} renderOrder={13} raycast={() => null} />;
};
/** Yüz-extrude'da hedef dışı paneller: X-ray opaklığı; kenarlar derinlik testli — arkadakiler öndekini delmez. */
const XRAY_PANEL_OPACITY = 0.35;
const EXTRUDE_XRAY_EDGE = '#6b7280';

/* KAPAK AÇILIŞ İŞARETİ (3B) — PanelEditor şemasındaki DIN/AWI sözleşmesinin aynısı: kulp kenarının iki köşesinden menteşe
   kenarının ORTASINA kesikli çizgi, sivri uç menteşe tarafı. Görünüş aynalaması ve double/fold kanat menteşeleri şemayla birebir
   (şemada 'L' = ekranın solu; arka/sağ yan görünüşte u, üst görünüşte v aynalı). */
type Pt2 = { x: number; y: number };
const SWING_LIFT = 0.8;   // ön yüzden dışa pay (mm): z-fighting olmasın, kenar çizgisinin altında kalsın

/** Üyenin menteşe yönü kapak düzleminin (u,v) uzayında birim vektör; menteşesiz tiplerde (drawer/fixed) null. */
function doorHingeUV(group: Pick<DoorGroup, 'axis' | 'side'>, m: Pick<DoorMemberRect, 'type' | 'leaf'>): Pt2 | null {
  const mirrorU = (group.axis === 2 && group.side < 0) || (group.axis === 0 && group.side > 0);
  const mirrorV = group.axis === 1 && group.side > 0;
  const L: Pt2 = { x: mirrorU ? 1 : -1, y: 0 }, R: Pt2 = { x: -L.x, y: 0 };
  const T: Pt2 = { x: 0, y: mirrorV ? -1 : 1 }, B: Pt2 = { x: 0, y: -T.y };
  switch (m.type) {
    case 'left': return L;
    case 'right': return R;
    case 'up': return T;
    case 'down': return B;
    case 'double': return { x: m.leaf === 0 ? -1 : 1, y: 0 };   // kanatlar DIŞ kenarlarından menteşeli (aynalı görünüşte de)
    case 'fold': return T;
    default: return null;
  }
}

/** Çokgen kapakta işaret noktaları [kulp köşesi, tepe, kulp köşesi]: menteşe kenarı = dış normali menteşe yönüne en çok bakan
 *  (eşitlikte en uzun) kenar; kulp kenarı = karşısı. Şemadaki swingPathPoly ile aynı kural. */
function swingTriangle(pts: Pt2[], hinge: Pt2, ins: number): Pt2[] | null {
  if (pts.length < 3) return null;
  const c = { x: pts.reduce((a, q) => a + q.x, 0) / pts.length, y: pts.reduce((a, q) => a + q.y, 0) / pts.length };
  const edges = pts.map((a, i) => {
    const b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    let nx = (b.y - a.y) / len, ny = -(b.x - a.x) / len;
    if (nx * ((a.x + b.x) / 2 - c.x) + ny * ((a.y + b.y) / 2 - c.y) < 0) { nx = -nx; ny = -ny; }
    return { a, b, len, nx, ny };
  }).filter(e => e.len > 1e-3);
  const pick = (d: Pt2) => {
    const sc = edges.map(e => ({ e, dot: e.nx * d.x + e.ny * d.y })).filter(x => x.dot > 0.5);
    if (!sc.length) return null;
    const top = Math.max(...sc.map(x => x.dot));
    return sc.filter(x => x.dot > top - 0.15).sort((p, q) => q.e.len - p.e.len)[0].e;
  };
  const he = pick(hinge), pe = pick({ x: -hinge.x, y: -hinge.y });
  if (!he || !pe) return null;
  const apex = { x: (he.a.x + he.b.x) / 2 - he.nx * ins, y: (he.a.y + he.b.y) / 2 - he.ny * ins };
  const inward = (q: Pt2) => { const dx = c.x - q.x, dy = c.y - q.y, l = Math.hypot(dx, dy) || 1; return { x: q.x + dx / l * ins * 1.4, y: q.y + dy / l * ins * 1.4 }; };
  return [inward(pe.a), apex, inward(pe.b)];
}

/** Kapağın ön yüzüne açılış işareti (her kapakta; seçiliyken vurgulu). Çerçeve: VF poligonu (kesimli kapakta eğik kenar dahil) panel geometrisinin
 *  ön yüzüne oturtulur — kapakta taşıma adımı olsa da işaret mesh'le birlikte kalır. */
const DoorSwingMark: React.FC<{ geometry: THREE.BufferGeometry; vfId: string; active: boolean }> = React.memo(({ geometry, vfId, active }) => {
  const vf = useAppStore(s => s.virtualFaces.find(f => f.id === vfId));
  const group = useAppStore(s => (vf?.doorGroupId ? s.doorGroups.find(g => g.id === vf.doorGroupId) : undefined));
  const mark = useMemo(() => {
    if (!vf?.vertices || vf.vertices.length < 3 || !group) return null;
    const idx = vf.doorIndex ?? group.memberVfIds.indexOf(vf.id);
    let m: DoorMemberRect | undefined;
    try { m = doorMembersOf(group)[idx]; } catch { return null; }
    const hinge = m ? doorHingeUV(group, m) : null;
    if (!hinge) return null;
    const bb = localBboxOf(geometry);
    if (!bb) return null;
    const { u, v } = doorPlaneAxes(group.axis);
    const poly = vf.vertices.map(p => ({ x: p[u], y: p[v] }));
    const xs = poly.map(q => q.x), ys = poly.map(q => q.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const du = (bb.min.getComponent(u) + bb.max.getComponent(u)) / 2 - (minX + maxX) / 2;
    const dv = (bb.min.getComponent(v) + bb.max.getComponent(v)) / 2 - (minY + maxY) / 2;
    const span = Math.min(maxX - minX, maxY - minY);
    if (span < 30) return null;
    const ins = THREE.MathUtils.clamp(span * 0.07, 12, 45);
    const tri = swingTriangle(poly, hinge, ins);
    if (!tri) return null;
    const plane = (group.side > 0 ? bb.max.getComponent(group.axis) : bb.min.getComponent(group.axis)) + group.side * SWING_LIFT;
    const to3 = (q: Pt2) => { const p = new THREE.Vector3(); p.setComponent(group.axis, plane); p.setComponent(u, q.x + du); p.setComponent(v, q.y + dv); return p; };
    const dash = THREE.MathUtils.clamp(span * 0.025, 6, 18);
    return { pts: tri.map(to3), dash };
  }, [geometry, vf, group]);
  if (!mark) return null;
  return (
    <Line points={mark.pts} color={active ? DOOR_SWING.active : DOOR_SWING.idle} lineWidth={active ? DOOR_SWING.activeWidth : DOOR_SWING.idleWidth}
      dashed dashSize={mark.dash} gapSize={mark.dash * 0.8}
      transparent={false} depthTest depthWrite={false} renderOrder={3} raycast={() => null} />
  );
});

// Z-FIGHTING: mesh küçük pozitif polygonOffset alır; kenar çizgisi yalnız SABİT birim payı alır, EĞİM (factor) payı ALMAZ —
// eğim payı uzaklaştıkça büyür ve değen arka panellerin kenarı öndeki yüzü delip görünür.
const MESH_OFFSET = 1.0, EDGE_OFFSET_FACTOR = 0, EDGE_OFFSET_UNITS = -1.0, EDGE_RENDER_ORDER = 1;
export const EDGE_LINE_WIDTH = 1.0;
export const EDGE_ANGLE_THRESHOLD = 15;

export const HitMaterial = () => <meshBasicMaterial transparent opacity={0.01} side={THREE.DoubleSide} depthTest={false} depthWrite={false} />;
const OverlayMat = ({ color, opacity }: { color: number; opacity: number }) => <meshBasicMaterial color={color} transparent opacity={opacity} side={THREE.DoubleSide} depthTest={false} depthWrite={false} />;

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

export const confirmRefOnRightClick = async (e: any) => {
  if (e.button !== 2) return;
  e.stopPropagation();
  if (useAppStore.getState().faceExtrudeCavityGroupId) await confirmRefCavityExtrude(); else await confirmRefFaceExtrude();
};

export const PanelDrawing: React.FC<{ shape: any; isSelected: boolean }> = React.memo(({ shape, isSelected }) => {
  const meshRef = useRef<THREE.Mesh>(null);
  const S = useStoreFields('selectShape', 'selectSecondaryShape', 'selectedShapeId', 'selectedPanelRow', 'setSelectedPanelRow', 'panelSelectMode', 'viewMode',
    'faceExtrudeMode', 'faceExtrudeTargetPanelId', 'faceExtrudeSelectedFace', 'setFaceExtrudeSelectedFace', 'setFaceExtrudeClickPoint', 'raycastMode', 'faceExtrudeValueMode', 'faceExtrudeRefCandidate',
    'panelMoveMode', 'panelMoveValueMode', 'panelMoveTargetPanelId', 'panelMoveRefSourceVertex', 'panelMoveRefTargetPanelId', 'panelMoveRefTargetVertex',
    'panelRotateMode', 'panelRotateValueMode', 'panelRotateTargetPanelId', 'panelRotatePivot', 'panelRotateRefArmVertex', 'panelRotateAxis', 'panelRotateRefFace', 'setPanelRotateRefFace',
    'selectedPanelGroupId', 'volumePickMode', 'volumePickGroupId', 'selectedDoorGroupId', 'doorPickMode', 'doorPickRole', 'doorRefPickGroupId', 'setDoorRefPickGroupId', 'virtualFaces');
  const [hoveredExtrudeGroup, setHoveredExtrudeGroup] = useState<number | null>(null);
  const [moveRefHover, setMoveRefHover] = useState(false);
  const { faces, groups: faceGroups } = useMemo(() => (shape.geometry ? getFacesAndGroups(shape.geometry) : { faces: [], groups: [] }), [shape.geometry]);

  const parentShapeId = shape.parameters?.parentShapeId;
  const virtualFaceId = shape.parameters?.virtualFaceId;
  const isParentSelected = parentShapeId === S.selectedShapeId;
  const isGroupSelected = isParentSelected && ((!!S.selectedPanelGroupId && shape.parameters?.panelGroupId === S.selectedPanelGroupId)
    || (!!S.selectedDoorGroupId && shape.parameters?.doorGroupId === S.selectedDoorGroupId));
  const isRowSelectedRaw = isGroupSelected || (isParentSelected && !!virtualFaceId && S.selectedPanelRow === `vf-${virtualFaceId}`);
  // Sınır vurgusu rolün bayrağını okur: kapak seçme/ref → doorBound, arkalık seçme/ref → backBound (ref grubunun rolü store'dan, abonesiz).
  const boundRole = S.doorPickMode ? S.doorPickRole : S.doorRefPickGroupId ? roleOf(useAppStore.getState().doorGroups.find(g => g.id === S.doorRefPickGroupId)) : null;
  const isDoorBoundPanel = isParentSelected && !!boundRole && !!virtualFaceId && vfBoundFor(S.virtualFaces.find(f => f.id === virtualFaceId), boundRole);
  // Bu modlarda kapaklar saydam ve tıklanmaz: arkasındaki dikme/raf seçilebilsin.
  const isDoorPickGhost = isParentSelected && (S.doorPickMode || !!S.doorRefPickGroupId) && isDoorPanel(shape);

  const edgePoints = useMemo<Vec3[] | null>(() => { try { const p = edgePointsOf(shape.geometry, EDGE_ANGLE_THRESHOLD); return p.length ? p : null; } catch { return null; } }, [shape.geometry]);

  const isFaceExtrudeTarget = S.faceExtrudeMode && shape.id === S.faceExtrudeTargetPanelId;
  const isFaceExtrudeXray = S.faceExtrudeMode && shape.id !== S.faceExtrudeTargetPanelId;
  // Yeniden hacim seçimi: sahne grubun adımından ÖNCEKİ duruma döner — sonraki paneller hiç çizilmez
  // (repickObstacles aynı yüklemi okur), grubun kendi üyeleri saydam, öncekiler katı.
  const repickRole: 'none' | 'bounds' | 'member' | 'later' = (() => {
    if (!S.volumePickMode || !S.volumePickGroupId || !isParentSelected) return 'none';
    const st = useAppStore.getState();
    const g = st.panelGroups.find(x => x.id === S.volumePickGroupId);
    if (!g) return 'none';
    if (shape.parameters?.panelGroupId === g.id) return 'member';
    return groupBoundsPanelPredicate(g, st.panelGroups, st.virtualFaces)(shape) ? 'bounds' : 'later';
  })();
  const isRepickXray = repickRole === 'member';
  const isRepickHidden = repickRole === 'later';
  const isGhost = isFaceExtrudeXray || isRepickXray || isDoorPickGhost;
  const isPanelRowSelected = isRowSelectedRaw && !isRepickXray;
  const isRaycastOnParent = (S.raycastMode || S.volumePickMode !== null || S.doorPickMode) && parentShapeId && parentShapeId === S.selectedShapeId;
  // Ref seçimi ancak hedef yüz seçildikten sonra aktif; hedef dışındaki her panel raycast alır.
  const isExtRefMode = S.faceExtrudeMode && S.faceExtrudeValueMode === 'ref' && S.faceExtrudeSelectedFace !== null;
  const isRotRefMode = S.panelRotateMode && S.panelRotateValueMode === 'ref' && !!S.panelRotatePivot && !!S.panelRotateRefArmVertex && S.panelRotateAxis !== null;
  const isRefMode = isExtRefMode || isRotRefMode;
  const refOwnerId = isExtRefMode ? S.faceExtrudeTargetPanelId : S.panelRotateTargetPanelId;
  const refCandidate = isExtRefMode ? S.faceExtrudeRefCandidate : S.panelRotateRefFace;
  const isRefPickablePanel = isRefMode && shape.id !== refOwnerId;
  const isRefCandidatePanel = isRefMode && refCandidate?.panelId === shape.id;
  const isMoveRefTargetPanel = S.panelMoveMode && S.panelMoveValueMode === 'ref' && !!S.panelMoveRefSourceVertex && S.panelMoveRefTargetPanelId === shape.id;
  const isMoveRefPickMode = S.panelMoveMode && S.panelMoveValueMode === 'ref' && !!S.panelMoveRefSourceVertex && !S.panelMoveRefTargetVertex && shape.id !== S.panelMoveTargetPanelId && S.panelMoveRefTargetPanelId !== shape.id;
  const isMoveRefHovered = isMoveRefPickMode && moveRefHover;
  const moveRefHighlight = isMoveRefTargetPanel || isMoveRefHovered;
  const disableRaycast = (isFaceExtrudeTarget || (isFaceExtrudeXray && !isRefPickablePanel) || isRaycastOnParent || (!!S.doorRefPickGroupId && isDoorPanel(shape))) && !isMoveRefPickMode;

  useEffect(() => { const mesh = meshRef.current; if (mesh) mesh.raycast = disableRaycast ? () => {} : THREE.Mesh.prototype.raycast; }, [disableRaycast]);
  useEffect(() => { if (!isMoveRefPickMode && moveRefHover) setMoveRefHover(false); }, [isMoveRefPickMode, moveRefHover]);

  const extrudeHighlightGeometry = useMemo(() => (!isFaceExtrudeTarget || hoveredExtrudeGroup === null || hoveredExtrudeGroup === S.faceExtrudeSelectedFace || !faceGroups[hoveredExtrudeGroup] || faces.length === 0)
    ? null : createFaceHighlightGeometry(faces, faceGroups[hoveredExtrudeGroup].faceIndices), [isFaceExtrudeTarget, hoveredExtrudeGroup, faceGroups, faces, S.faceExtrudeSelectedFace]);
  const extrudeSelectedGeometry = useMemo(() => (!isFaceExtrudeTarget || S.faceExtrudeSelectedFace === null || !faceGroups[S.faceExtrudeSelectedFace] || faces.length === 0)
    ? null : createFaceHighlightGeometry(faces, faceGroups[S.faceExtrudeSelectedFace].faceIndices), [isFaceExtrudeTarget, S.faceExtrudeSelectedFace, faceGroups, faces]);

  if (!shape.geometry) return null;
  if (isRepickHidden) return null;

  const isWireframe = S.viewMode === ViewMode.WIREFRAME;
  const isXray = S.viewMode === ViewMode.XRAY;
  const edgeColor = moveRefHighlight ? (isMoveRefTargetPanel ? '#15803d' : REF_COLORS.selectedCss) : isDoorBoundPanel ? DOOR_COLORS.boundEdge : isSelected ? PANEL_COLORS.selected.shapeEdge
    : isPanelRowSelected ? PANEL_SELECT.edge : isGhost ? EXTRUDE_XRAY_EDGE : PANEL_COLORS.edge.default;
  const edgeWidth = moveRefHighlight ? EDGE_LINE_WIDTH + 0.9 : isDoorBoundPanel ? EDGE_LINE_WIDTH + 1.1 : isSelected ? EDGE_LINE_WIDTH + 0.7
    : isPanelRowSelected ? EDGE_LINE_WIDTH + PANEL_SELECT.edgeExtra : EDGE_LINE_WIDTH;
  // Seçim tonu: tarama yok — dolgu harmanlanır; ref/taşıma vurgusu varken o rol önceliklidir.
  const panelColor = isPanelRowSelected && !moveRefHighlight ? tintedPanelColor(shape.color) : (shape.color || '#ffffff');
  // Açılış işareti her kapakta görünür; kapaklar saydamlaştığı modlarda (kapak seçme/ref, X-ray hedef dışı) gizlenir.
  const showSwing = !!virtualFaceId && isDoorPanel(shape) && !isGhost;

  const handleClick = (e: any) => {
    e.stopPropagation();
    if (S.volumePickMode || S.doorPickMode) return;   // HACİM / KAPAK SEÇME: tıklama araca aittir
    if (S.doorRefPickGroupId) {
      if (virtualFaceId) { const ids = splitDoorAtPanel(S.doorRefPickGroupId, virtualFaceId); if (ids.length) S.setDoorRefPickGroupId(null); }
      return;
    }
    // Taşıma modu: referans döngüsü canvas seviyesinde (MoveRefPanelPicker).
    if (S.panelMoveMode) return;
    if (S.panelRotateMode && S.panelRotateValueMode === 'ref') {
      if (isRotRefMode && shape.id !== S.panelRotateTargetPanelId) {
        cycleRefFacePickFromEvent(e, useAppStore.getState().shapes.filter((x: any) => x.type === 'panel'), S.panelRotateTargetPanelId, S.setPanelRotateRefFace);
      }
      return;
    }
    if (S.panelRotateMode) return;
    if (S.faceExtrudeMode) return;
    // Body modunda panel tıklansa da tüm blok seçilir; panel satırı yalnız Panel modunda yazılır.
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
  const emissive = isPanelRowSelected ? PANEL_SELECT.emissive : moveRefHighlight ? (isMoveRefTargetPanel ? '#22c55e' : REF_COLORS.hoverCss) : isDoorBoundPanel ? DOOR_COLORS.boundEmissive : '#2a2a2a';
  const emissiveIntensity = isPanelRowSelected ? 1 : moveRefHighlight ? (isMoveRefTargetPanel ? 1.0 : 0.8) : isDoorBoundPanel ? 0.55 : 1;
  const edgeLine = (xray: boolean) => edgePoints && (
    <Line points={edgePoints} segments color={edgeColor} lineWidth={edgeWidth} transparent={false} depthTest={!xray} depthWrite={!xray}
      {...(!xray && !isWireframe ? { polygonOffset: true, polygonOffsetFactor: EDGE_OFFSET_FACTOR, polygonOffsetUnits: EDGE_OFFSET_UNITS } : {})}
      renderOrder={EDGE_RENDER_ORDER} raycast={() => null} />
  );

  return (
    <group name={`shape-${shape.id}`} position={shape.position} rotation={shape.rotation} scale={shape.scale}>
      {!isWireframe && (
        <mesh ref={meshRef} geometry={shape.geometry} castShadow receiveShadow {...meshEvents}>
          <meshLambertMaterial color={panelColor} emissive={emissive} emissiveIntensity={emissiveIntensity} side={THREE.DoubleSide}
            transparent={isXray || isGhost || moveRefHighlight}
            opacity={isXray ? (moveRefHighlight ? (isMoveRefTargetPanel ? 0.5 : 0.6) : XRAY_PANEL_OPACITY) : isGhost ? XRAY_PANEL_OPACITY : isMoveRefTargetPanel ? 0.55 : isMoveRefHovered ? 0.9 : 1}
            depthWrite={!isXray && !isGhost && !isMoveRefTargetPanel}
            polygonOffset polygonOffsetFactor={MESH_OFFSET} polygonOffsetUnits={MESH_OFFSET} />
        </mesh>
      )}
      {edgeLine(isXray)}
      {showSwing && <DoorSwingMark geometry={shape.geometry} vfId={virtualFaceId} active={isPanelRowSelected} />}

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

      {isRefPickablePanel && (
        <RefFaceOverlay geometry={shape.geometry} faces={faces} groups={faceGroups} hoveredGroup={hoveredExtrudeGroup}
          candidateGroup={isRefCandidatePanel ? (refCandidate?.faceGroupIndex ?? null) : null} onHover={setHoveredExtrudeGroup}
          onPointerDown={(e: any) => { if (isExtRefMode) confirmRefOnRightClick(e); }} />
      )}

      {isPanelRowSelected && !isGroupSelected && !S.volumePickMode && !S.doorPickMode && <DirectionArrow geometry={shape.geometry} arrowRotated={shape.parameters?.arrowRotated || false} transformSteps={shape.parameters?.transformSteps} />}
    </group>
  );
});

// Yön oku: panel yüzeyine yatık, ışıksız kırmızı ok; depthTest=false ile hep panelin üstünde.
const DirectionArrow: React.FC<{ geometry: THREE.BufferGeometry; arrowRotated?: boolean; transformSteps?: any[] }> = React.memo(({ geometry, arrowRotated = false, transformSteps }) => {
  const arrowConfig = useMemo(() => {
    const posAttr = geometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!posAttr) return null;
    // Ölçüler panel dönüşüyle TERS döndürülmüş çerçevede (panel orada eksen-hizalı slab); ok aynı dönüşle geri getirilir.
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
    const dirVec = new THREE.Vector3().setComponent(targetAxis, 1), perpVec = new THREE.Vector3().setComponent(otherAxis, 1);
    const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(dirVec, perpVec, new THREE.Vector3().crossVectors(dirVec, perpVec).normalize())).premultiply(Q);
    const normalUnit = new THREE.Vector3().setComponent(thinAxisIndex, 1);
    if (normalUnit.clone().applyQuaternion(Q).y < -1e-6) normalUnit.negate();
    const position = center.clone().addScaledVector(normalUnit, thinHalf + 3).applyQuaternion(Q);
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

function useShapeMatrices(shape: any) {
  const localToWorld = useMemo(() => getShapeMatrix(shape),
    [shape.position[0], shape.position[1], shape.position[2], shape.rotation[0], shape.rotation[1], shape.rotation[2], shape.scale[0], shape.scale[1], shape.scale[2]]);
  const worldToLocal = useMemo(() => localToWorld.clone().invert(), [localToWorld]);
  return { localToWorld, worldToLocal };
}

const highlightMat = (color: number, opacity: number, offset = -2, depthTest = false) => (
  <meshBasicMaterial color={color} transparent opacity={opacity} side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={offset} polygonOffsetUnits={offset} depthTest={depthTest} />
);

export function confirmBodyPanelPlacement(vf: VirtualFace | null | undefined): void {
  const st = useAppStore.getState();
  if (!vf) return;
  const name = st.placementName.trim();
  st.addVirtualFace(name ? { ...vf, description: name } : vf);
  st.setRaycastMode(false);
}

interface PendingPreview { geo: THREE.BufferGeometry; edgeGeo: THREE.BufferGeometry; virtualFace: VirtualFace }

/** Tıklanan yüz bileşeninin serbest bölgesi (highlight) ve VF'si. HIGHLIGHT = PANEL: bölge tek kaynaktan (computeFreeRegionLocal);
 *  kontur YEREL uzayda, panel ayak izleri dünya→yerel dönüşümle getirilir. */
export function buildFacePreview(
  clickWorld: THREE.Vector3, group: CoplanarFaceGroup, faces: FaceData[], worldToLocal: THREE.Matrix4,
  shapeId: string, geometry?: THREE.BufferGeometry, childPanels: any[] = []
): PendingPreview | null {
  const clickLocal = clickWorld.clone().applyMatrix4(worldToLocal);
  const contour = computeFaceComponentContour(faces, group.faceIndices, clickLocal, group.normal);
  if (!contour) return null;
  const region = computeFreeRegionLocal(contour.corners, group.normal, clickLocal, childPanels, worldToLocal, shapeId);
  if (!region) return null;
  const { u, v, planeN, uMin, vMin, cw, ch, nx, ny, reach, touchingSiblingIds } = region;
  const nrm = group.normal.clone().normalize();
  const to3D = (px: number, py: number) => new THREE.Vector3().addScaledVector(u, px).addScaledVector(v, py).addScaledVector(nrm, planeN);
  const pos: number[] = [], epos: number[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!reach[j * nx + i]) continue;
    const x0 = uMin + i * cw, x1 = x0 + cw, y0 = vMin + j * ch, y1 = y0 + ch;
    const p00 = to3D(x0, y0), p10 = to3D(x1, y0), p11 = to3D(x1, y1), p01 = to3D(x0, y1);
    pos.push(p00.x, p00.y, p00.z, p10.x, p10.y, p10.z, p11.x, p11.y, p11.z, p00.x, p00.y, p00.z, p11.x, p11.y, p11.z, p01.x, p01.y, p01.z);
    const bnd: Array<[THREE.Vector3, THREE.Vector3]> = [];
    if (i === 0 || !reach[j * nx + i - 1]) bnd.push([p00, p01]);
    if (i === nx - 1 || !reach[j * nx + i + 1]) bnd.push([p10, p11]);
    if (j === 0 || !reach[(j - 1) * nx + i]) bnd.push([p00, p10]);
    if (j === ny - 1 || !reach[(j + 1) * nx + i]) bnd.push([p01, p11]);
    for (const [a, b] of bnd) epos.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  if (pos.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.computeVertexNormals();
  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(epos), 3));

  const localNormal = group.normal.clone().normalize();
  // Merkez = TIKLANAN nokta (bileşen merkezi değil): aynı yüzdeki iki VF ayrışır, kardeş kesimi doğru tarafı tutar.
  const anchor = to3D(region.anchor.x, region.anchor.y);
  const virtualFace: VirtualFace = {
    id: genId('vf'), shapeId,
    normal: [localNormal.x, localNormal.y, localNormal.z],
    center: [clickLocal.x, clickLocal.y, clickLocal.z],
    vertices: region.polygon.map(p2 => { const c = to3D(p2.x, p2.y); return [c.x, c.y, c.z] as [number, number, number]; }),
    description: '', hasPanel: false, parentFaceShape: true, touchingSiblingIds,
    // Taraf sözleşmesi doğuştan kilitli: regen STORED-WINS birleştirir, bir daha değişmez.
    sideRelations: region.sideRelations,
    faceGroupDescriptor: geometry ? createFaceDescriptor(faces[contour.seedFi], geometry) : undefined,
    ...({ regionAnchor: [anchor.x, anchor.y, anchor.z] } as any),
  };
  return { geo, edgeGeo, virtualFace };
}

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
  const { raycastMode, virtualFaces, setSelectedPanelRow, setRaycastPendingVf } = useStoreFields('raycastMode', 'virtualFaces', 'setSelectedPanelRow', 'setRaycastPendingVf');
  const [hoveredGroupIndex, setHoveredGroupIndex] = useState<number | null>(null);
  const [pending, setPending] = useState<PendingPreview | null>(null);
  const lastClickRef = useRef<{ point: THREE.Vector3; groupIndex: number; cycleIndex: number } | null>(null);
  const shapeVirtualFaces = useMemo(() => virtualFaces.filter(vf => vf.shapeId === shape.id), [virtualFaces, shape.id]);
  const vertexModsKeyStr = JSON.stringify(shape.vertexModifications || []);
  const effGeometry = useMemo(() => effectiveBodyGeometry(shape), [shape.geometry, shape.geometry?.uuid, vertexModsKeyStr]);
  const { localToWorld, worldToLocal } = useShapeMatrices(shape);
  const { faces, groups: faceGroups } = useFaceGroups(effGeometry, () => { setPending(null); lastClickRef.current = null; });
  useEffect(() => { if (!raycastMode) { setHoveredGroupIndex(null); setPending(null); lastClickRef.current = null; } }, [raycastMode]);
  useEffect(() => { setRaycastPendingVf(pending ? pending.virtualFace : null); }, [pending]);
  // İç paneller de girer (yeni panel sırada SONRA → mevcutlar onu basar); kapaklar engel değildir.
  const childPanels = useMemo(() => childPanelsOf(shape.id, allShapes).filter(p => !isDoorPanel(p)), [allShapes, shape.id]);
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
      if (pending) { confirmBodyPanelPlacement(pending.virtualFace); setPending(null); lastClickRef.current = null; }
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
    // Nokta değen bir panelin GÜNCEL ayak izi içindeyse yüz orada "tanımlı"dır; aradaki boşluk serbesttir.
    const coveringPanel = findPanelCoveringPoint(clickPoint, childPanels, worldNormalOf(hoveredGroupIndex), clickPoint);
    const hoveredIsDefined = coveringPanel !== null;

    let targetGroupIndex = hoveredGroupIndex;
    let previewClickPoint = clickPoint;
    let cycleCandidates: Array<{ index: number; depth: number; hitPoint: THREE.Vector3 }> | null = null;
    const cameraPos = e.camera?.position?.clone();
    if (cameraPos && (isSameSpot || hoveredIsDefined)) {
      // Derinlik döngüsü: panel izi altındaki gruplar atlanır; boşluklar geçerli hedeftir.
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

export const FaceEditor: React.FC<{ shape: any }> = ({ shape }) => {
  const { filletMode, selectedFilletFaces, addFilletFace, addFilletFaceData } = useStoreFields('filletMode', 'selectedFilletFaces', 'addFilletFace', 'addFilletFaceData');
  const { faces, groups: faceGroups } = useFaceGroups(shape.geometry);
  const [hoveredGroupIndex, setHoveredGroupIndex] = useState<number | null>(null);

  /** Düzlem sabiti eksen-hizalı yüzde düz üçgenlerin UÇ değerinden alınır (fillet doğruluğu). */
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

// Hacim seçme: ışın gövde kutusunu hücre hücre yürür, serbest hücreden taşılarak şekilli bölge bulunur.
// Sol tık aynı ışındaki adaylar arasında döner; sağ tık / ✓ oluşturur. Görünmez kutu olayları alır (açık yüzlerde de).
const PICK_COLORS = { hover: SEL_COLORS.hover, selected: SEL_COLORS.active, selectedEdge: SEL_COLORS.volumeEdge, currentEdge: '#78716c' };

function surfaceMesh(surface: number[]): { geo: THREE.BufferGeometry; edgePts: [number, number, number][] } {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(surface), 3));
  return { geo, edgePts: edgePointsOf(geo, 1) };
}

/** Yön oku: hacmin girildiği dış yüzün önünde (hacmin DIŞINDA), hacme bakar; ekranda minPx..maxPx'e kıstırılır.
 *  Derinlik tamponu okun hemen öncesinde temizlenir: her şeyin üstünde çizilir ama kendi yüzleri doğru örtüşür. */
const FACING_ARROW = { color: '#dc2626', edge: '#7f1d1d', lengthMm: 108, minPx: 43, maxPx: 80, tiltRad: 0.5, gapFrac: 0.2, shaftLen: 0.62 } as const;

const FACING_ARROW_GEO: THREE.BufferGeometry = (() => {
  const L = FACING_ARROW.shaftLen, w = 0.075, h = w / 2, A = 0.34, r2 = Math.SQRT2;
  const up = (s: number, off: number): [number, number] => [(-s - off) / r2, (s - off) / r2];
  const dn = (s: number, off: number): [number, number] => [(-s - off) / r2, (-s + off) / r2];
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
    const back = (len * (FACING_ARROW.gapFrac + FACING_ARROW.shaftLen / 2)) / (t.pScale.getComponent(axis) || 1);
    g.position.set(faceCenter[0], faceCenter[1], faceCenter[2]);
    g.position.setComponent(axis, faceCenter[axis] - facing * back);
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
  const { volumePickMode, volumePickGroupId, volumePickCandidates, volumePickIndex, setVolumePick, panelGroups } =
    useStoreFields('volumePickMode', 'volumePickGroupId', 'volumePickCandidates', 'volumePickIndex', 'setVolumePick', 'panelGroups');
  const [hoverPick, setHoverPick] = useState<CavityPick | null>(null);
  const lastRef = useRef<{ keys: string; index: number } | null>(null);
  // Yeniden seçim: ızgara yalnız gruptan ÖNCEKİ panellerle kurulur (sonrakiler + üyeler engel değil).
  const repickGroup = useMemo(() => (volumePickGroupId ? panelGroups.find(g => g.id === volumePickGroupId) || null : null), [panelGroups, volumePickGroupId]);
  // Düz paneller kutu engeli; dönmüş/eğik paneller yarım-uzay.
  const oset = useMemo(() => (repickGroup ? repickObstacles(repickGroup, shape, allShapes) : collectObstacles(shape, allShapes)), [allShapes, shape, repickGroup]);
  const grid = useMemo(() => (volumePickMode ? gridForObstacles(shape, oset) : null), [shape, oset, volumePickMode]);
  const currentMesh = useMemo(() => (repickGroup ? surfaceMesh(boxesSurface(repickGroup.region || [repickGroup.cavity])) : null), [repickGroup]);
  useEffect(() => () => { currentMesh?.geo.dispose(); }, [currentMesh]);
  const { worldToLocal } = useShapeMatrices(shape);
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
      if (selected) confirmVolumePick(shape.id, volumePickMode, selected);
      return;
    }
    if (e.button !== 0) return;
    const c = candidatesFromEvent(e);
    if (!c.length) { setVolumePick([], 0); lastRef.current = null; return; }
    const keys = c.map(b => b.key).join(';');
    const index = lastRef.current && lastRef.current.keys === keys ? (lastRef.current.index + 1) % c.length : 0;
    lastRef.current = { keys, index };
    setVolumePick(c, index);
  };

  if (!volumePickMode || !pickGeo) return null;
  const hoverIsSelected = !!hoverPick && !!selected && hoverPick.key === selected.key;
  return (
    <>
      <mesh geometry={pickGeo} visible={false} onPointerMove={onPointerMove} onPointerOut={() => setHoverPick(null)} onPointerDown={onPointerDown} onContextMenu={(e: any) => e.stopPropagation()} />
      {currentMesh && currentMesh.edgePts.length >= 2 && (
        <Line points={currentMesh.edgePts} segments color={PICK_COLORS.currentEdge} lineWidth={1.2} transparent opacity={0.8} depthTest={false} depthWrite={false} renderOrder={4} raycast={() => null} />
      )}
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
          {selected && <FacingArrow box={selected.bbox} axis={selected.arrow.axis} facing={selected.arrow.facing} />}
        </>
      )}
    </>
  );
};

// Kapak seçme: tıklanan gövde yüzü kapak düzlemini verir; adaylar sınır panellerinden büyükten küçüğe (doorCandidatesAt).
// Aday levha, dönmüş sınır panelleriyle kırpılmış KONVEKS çokgen prizmasıdır (dış yüz −normal yönünde kalınlık kadar).
type DoorSlabPoly = { normal: Vec3; vertices: Vec3[] };
const slabPrism = (poly: DoorSlabPoly, t: number): { geo: THREE.BufferGeometry; edges: Vec3[] } => {
  const n = poly.normal, front = poly.vertices, back = front.map(v => [v[0] - n[0] * t, v[1] - n[1] * t, v[2] - n[2] * t] as Vec3);
  const k = front.length, pos: number[] = [], idx: number[] = [];
  for (const v of front) pos.push(...v); for (const v of back) pos.push(...v);
  for (let i = 1; i + 1 < k; i++) { idx.push(0, i, i + 1); idx.push(k, k + i + 1, k + i); }   // ön yelpaze + arka (ters)
  for (let i = 0; i < k; i++) { const j = (i + 1) % k; idx.push(i, k + i, k + j, i, k + j, j); }   // yan yüzler
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals();
  const edges: Vec3[] = [];
  for (let i = 0; i < k; i++) { const j = (i + 1) % k; edges.push(front[i], front[j], back[i], back[j], front[i], back[i]); }
  return { geo, edges };
};
const polyKey = (p: DoorSlabPoly, t: number) => `${t}|${p.normal.join(',')}|${p.vertices.map(v => v.map(x => x.toFixed(1)).join(',')).join(';')}`;
const DoorSlab: React.FC<{ poly: DoorSlabPoly; thickness: number; fill: number; opacity: number; edge?: string; order: number }> = ({ poly, thickness, fill, opacity, edge, order }) => {
  const key = polyKey(poly, thickness);
  const { geo, edges: pts } = useMemo(() => slabPrism(poly, thickness), [key]);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <>
      <mesh geometry={geo} raycast={() => null} renderOrder={order}>
        <meshBasicMaterial color={fill} transparent opacity={opacity} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      {edge && <Line points={pts} segments color={edge} lineWidth={SEL_COLORS.edgeWidth} transparent={false} depthTest={false} depthWrite={false} renderOrder={order + 1} raycast={() => null} />}
    </>
  );
};

export const DoorPickOverlay: React.FC<{ shape: any }> = ({ shape }) => {
  const { doorPickMode, doorPickRole, doorPickCandidates, doorPickIndex, setDoorPick, doorPickPlacement: doorPl, backPickPlacement, shapes, virtualFaces } =
    useStoreFields('doorPickMode', 'doorPickRole', 'doorPickCandidates', 'doorPickIndex', 'setDoorPick', 'doorPickPlacement', 'backPickPlacement', 'shapes', 'virtualFaces');
  // Arkalık seçmede tip (çakma/kanallı) ve kalınlık rolün varsayılanı; adaylar o rolün sınır panellerinden kurulur.
  const doorPickPlacement = doorPickRole === 'back' ? backPickPlacement : doorPl;
  const defs = doorRoleDefaults(doorPickRole);
  const [hoverPick, setHoverPick] = useState<DoorPick | null>(null);
  const lastRef = useRef<{ keys: string; index: number } | null>(null);
  const { worldToLocal } = useShapeMatrices(shape);
  const body = useMemo(() => { const bb = localBboxOf(effectiveBodyGeometry(shape)); return bb ? { min: [bb.min.x, bb.min.y, bb.min.z] as Vec3, max: [bb.max.x, bb.max.y, bb.max.z] as Vec3 } : null; }, [shape.geometry, shape.vertexModifications]);
  const pickGeo = useMemo(() => {
    if (!body) return null;
    const g = new THREE.BoxGeometry(body.max[0] - body.min[0] + 2, body.max[1] - body.min[1] + 2, body.max[2] - body.min[2] + 2);
    g.translate((body.min[0] + body.max[0]) / 2, (body.min[1] + body.max[1]) / 2, (body.min[2] + body.max[2]) / 2);
    return g;
  }, [body]);
  useEffect(() => () => { pickGeo?.dispose(); }, [pickGeo]);
  useEffect(() => { if (!doorPickMode) { setHoverPick(null); lastRef.current = null; } }, [doorPickMode]);
  const selected = doorPickCandidates[doorPickIndex] || null;
  const cuts = useMemo(() => (doorPickMode ? collectDoorCuts(shape, shapes, virtualFaces, doorPickRole) : []), [doorPickMode, doorPickRole, shape, shapes, virtualFaces]);
  const slabOf = (c: DoorPick | null) => (c ? doorSlabPolygon({ axis: c.axis, side: c.side, placement: doorPickPlacement, thickness: defs.thickness, gap: defs.gap, anchor: c.at }, pickRectFor(c, doorPickPlacement, doorPickRole), cuts) : null);
  const selectedBox = useMemo(() => slabOf(selected), [selected, doorPickPlacement, doorPickRole, cuts]);
  const hoverBox = useMemo(() => slabOf(hoverPick), [hoverPick, doorPickPlacement, doorPickRole, cuts]);

  const candidatesFromEvent = (e: any): DoorPick[] => {
    if (!body || !doorPickMode || !e?.ray) return [];
    const o = e.ray.origin.clone().applyMatrix4(worldToLocal);
    const d = e.ray.origin.clone().add(e.ray.direction).applyMatrix4(worldToLocal).sub(o).normalize();
    const entry = rayDoorEntry([o.x, o.y, o.z], [d.x, d.y, d.z], { min: [body.min[0] - 1, body.min[1] - 1, body.min[2] - 1], max: [body.max[0] + 1, body.max[1] + 1, body.max[2] + 1] });
    if (!entry) return [];
    return doorCandidatesAt(shape, entry.axis, entry.side, entry.point, shapes, virtualFaces, doorPickRole);
  };
  const onPointerMove = (e: any) => {
    if (!doorPickMode) return;
    e.stopPropagation();
    const first = candidatesFromEvent(e)[0] || null;
    setHoverPick(prev => (prev?.key === first?.key ? prev : first));
  };
  const onPointerDown = (e: any) => {
    if (!doorPickMode) return;
    e.stopPropagation();
    if (e.button === 2) { if (selected) confirmDoorPick(shape.id, selected); return; }
    if (e.button !== 0) return;
    const c = candidatesFromEvent(e);
    if (!c.length) { setDoorPick([], 0); lastRef.current = null; return; }
    const keys = c.map(x => x.key).join(';');
    const index = lastRef.current && lastRef.current.keys === keys ? (lastRef.current.index + 1) % c.length : 0;
    lastRef.current = { keys, index };
    setDoorPick(c, index);
  };

  if (!doorPickMode || !pickGeo) return null;
  const hoverIsSelected = !!hoverPick && !!selected && hoverPick.key === selected.key;
  return (
    <>
      <mesh geometry={pickGeo} visible={false} onPointerMove={onPointerMove} onPointerOut={() => setHoverPick(null)} onPointerDown={onPointerDown} onContextMenu={(e: any) => e.stopPropagation()} />
      {hoverBox && !hoverIsSelected && <DoorSlab poly={hoverBox} thickness={defs.thickness} fill={PICK_COLORS.hover} opacity={SEL_COLORS.faceHoverOpacity * 0.6} order={5} />}
      {selectedBox && <DoorSlab poly={selectedBox} thickness={defs.thickness} fill={PICK_COLORS.selected} opacity={SEL_COLORS.faceActiveOpacity * 0.7} edge={PICK_COLORS.selectedEdge} order={6} />}
    </>
  );
};

// Hacim düzenleme: grubun şekilli hacmi çizilir; seçilen yüzün normali + tıklama noktası (çıpa) store'a yazılır.
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
          if (e.point) { const local = e.point.clone().applyMatrix4(getShapeMatrix(shape).invert()); setFaceExtrudeClickPoint([local.x, local.y, local.z]); }
          setHovered(gi);
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

const EDGE_COLOR = '#5b6470';
type Xform = { position: Vec3; rotation: Vec3; scale: Vec3 };
const readXform = (o: THREE.Object3D): Xform => ({ position: o.position.toArray() as Vec3, rotation: o.rotation.toArray().slice(0, 3) as Vec3, scale: o.scale.toArray() as Vec3 });
function deltaOf(from: Xform, to: Xform) {
  return { pd: [0, 1, 2].map(i => to.position[i] - from.position[i]), rd: [0, 1, 2].map(i => to.rotation[i] - from.rotation[i]), sd: [0, 1, 2].map(i => to.scale[i] / from.scale[i]) };
}
const applyDelta = (base: Xform, d: ReturnType<typeof deltaOf>): Xform => ({
  position: [base.position[0] + d.pd[0], base.position[1] + d.pd[1], base.position[2] + d.pd[2]],
  rotation: [base.rotation[0] + d.rd[0], base.rotation[1] + d.rd[1], base.rotation[2] + d.rd[2]],
  scale: [base.scale[0] * d.sd[0], base.scale[1] * d.sd[1], base.scale[2] * d.sd[2]],
});

const SubtractionMesh: React.FC<{ subtraction: any; index: number; isHovered: boolean; isSubtractionSelected: boolean; isSelected: boolean; setHovered: (i: number | null) => void; setSelected: (i: number | null) => void }> =
  React.memo(({ subtraction, index, isHovered, isSubtractionSelected, isSelected, setHovered, setSelected }) => {
    // Merkezli geometri (eski kayıtlar) kök köşeye ötelenir.
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
    'faceExtrudeCavityGroupId', 'doorPickMode');
  const { scene } = useThree();
  const meshRef = useRef<THREE.Mesh>(null);
  const groupRef = useRef<THREE.Group>(null);
  const isUpdatingRef = useRef(false);
  const cleanupListenersRef = useRef<(() => void) | null>(null);
  const initialRef = useRef<{ self: Xform; childPanels: Map<string, Xform> } | null>(null);
  const [localGeometry, setLocalGeometry] = useState(shape.geometry);
  const [geometryKey, setGeometryKey] = useState(0);
  const [hoveredRefGroup, setHoveredRefGroup] = useState<number | null>(null);
  const [moveRefHover, setMoveRefHover] = useState(false);
  const vertexModsString = useMemo(() => JSON.stringify(shape.vertexModifications || []), [shape.vertexModifications]);
  const { faces: refFaces, groups: refFaceGroups } = useMemo(() => (shape.geometry ? getFacesAndGroups(effectiveBodyGeometry(shape)) : { faces: [], groups: [] }), [shape.geometry, vertexModsString]);
  const edgePoints = useMemo<Vec3[] | null>(() => { try { const p = localGeometry ? edgePointsOf(localGeometry, 5) : []; return p.length ? p : null; } catch { return null; } }, [localGeometry]);

  // Çizilen gövde = effectiveBodyGeometry (yerleştirme, VF regen ve motorla aynı kaynak).
  useEffect(() => {
    const hasVertexMods = shape.vertexModifications && shape.vertexModifications.length > 0;
    if (!shape.geometry || !((shape.geometry !== localGeometry) || hasVertexMods)) return;
    setLocalGeometry(hasVertexMods ? effectiveBodyGeometry(shape).clone() : shape.geometry.clone());
    setGeometryKey(prev => prev + 1);
  }, [shape.parameters?.width, shape.parameters?.height, shape.parameters?.depth, vertexModsString, shape.parameters?.modified, shape.geometry, shape.id]);

  useEffect(() => { isUpdatingRef.current = false; initialRef.current = null; }, [S.panelSelectMode]);

  useEffect(() => {
    if (!groupRef.current || (isUpdatingRef.current && shape.id === useAppStore.getState().selectedShapeId)) return;
    groupRef.current.position.set(...(shape.position as Vec3));
    groupRef.current.rotation.set(...(shape.rotation as Vec3));
    groupRef.current.scale.set(...(shape.scale as Vec3));
  }, [shape.position, shape.rotation, shape.scale, shape.id]);
  useEffect(() => () => { cleanupListenersRef.current?.(); cleanupListenersRef.current = null; }, []);

  // Sürüklerken çocuk paneller canlı taşınır; bırakınca store'a yazılır (grup üyeleri dahil).
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

  const isWireframe = S.viewMode === ViewMode.WIREFRAME;
  const isXray = S.viewMode === ViewMode.XRAY;
  const shouldShowAsReference = shape.isReferenceBox || shape.id === S.secondarySelectedShapeId;
  const hasPanels = S.shapes.some(s => s.type === 'panel' && s.parameters?.parentShapeId === shape.id);
  const noopRaycast = useCallback(() => {}, []);
  const isMoveRefPickActive = S.panelMoveMode && S.panelMoveValueMode === 'ref' && !!S.panelMoveRefSourceVertex && !S.panelMoveRefTargetPanelId;
  const isRefMode = S.faceExtrudeMode && S.faceExtrudeValueMode === 'ref' && S.faceExtrudeSelectedFace !== null;
  // Görünmez gövde mesh'i yalnız panel/yüz seçim modlarında bastırılır (ref modları muaf);
  // hacim/kapak seçmede her zaman (olayları overlay'in görünmez kutusu alır).
  const isVolumePickOnThis = (S.volumePickMode !== null || S.doorPickMode) && isSelected;
  const suppressBodyRaycast = (hasPanels && (S.panelSelectMode || S.raycastMode) && !isRefMode && !isMoveRefPickActive) || isVolumePickOnThis;
  const isMoveRefTargetPanel = S.panelMoveMode && S.panelMoveValueMode === 'ref' && !!S.panelMoveRefSourceVertex && S.panelMoveRefTargetPanelId === shape.id;
  const moveRefBodyHighlight = isMoveRefTargetPanel || (isMoveRefPickActive && moveRefHover);
  useEffect(() => { if (!isMoveRefPickActive && moveRefHover) setMoveRefHover(false); }, [isMoveRefPickActive, moveRefHover]);
  const isRefCandidateShape = isRefMode && S.faceExtrudeRefCandidate?.panelId === shape.id;

  const handleRefClick = useCallback((e: any) => {
    if (!isRefMode || shape.id === S.faceExtrudeTargetPanelId) return;
    // Hacim düzenlemede grubun kendi üyeleri referans olamaz (hacimle birlikte taşınırlar).
    const cav = S.faceExtrudeCavityGroupId;
    const shapes = useAppStore.getState().shapes.filter((x: any) => !cav || x.parameters?.panelGroupId !== cav);
    cycleRefFacePickFromEvent(e, shapes, S.faceExtrudeTargetPanelId, S.setFaceExtrudeRefCandidate);
  }, [isRefMode, shape.id, S.faceExtrudeTargetPanelId, S.faceExtrudeCavityGroupId, S.setFaceExtrudeRefCandidate]);

  if (shape.isolated === false || !localGeometry) return null;

  const raycastProps = suppressBodyRaycast ? { raycast: noopRaycast } : {};
  const hoverProps = isMoveRefPickActive ? { onPointerOver: (e: any) => { e.stopPropagation(); setMoveRefHover(true); }, onPointerOut: () => { if (moveRefHover) setMoveRefHover(false); } } : {};
  const outlinesVisible = S.showOutlines || S.raycastMode || !!S.volumePickMode || S.doorPickMode;
  const outline = (color: string, width: number, depthWrite: boolean) => outlinesVisible && edgePoints && (
    <Line points={edgePoints} segments color={color} lineWidth={width} transparent={false} depthTest depthWrite={depthWrite} renderOrder={1} raycast={() => null} />
  );

  return (
    <>
      <group ref={groupRef} name={`shape-${shape.id}`}
        onClick={(e) => {
          if (isRefMode) { e.stopPropagation(); handleRefClick(e); return; }
          if (S.panelMoveMode && S.panelMoveValueMode === 'ref' && !!S.panelMoveRefSourceVertex) { e.stopPropagation(); return; }
          // Aktif panel aracı: stopPropagation YOK — arkadaki panelin araç işleyicisi olayı alsın.
          if (S.faceExtrudeMode || S.panelMoveMode || S.panelRotateMode) return;
          if (S.volumePickMode || S.doorPickMode) { e.stopPropagation(); return; }
          if (S.panelSelectMode && hasPanels) return;
          e.stopPropagation();
          if (e.nativeEvent.ctrlKey || e.nativeEvent.metaKey) {
            S.selectSecondaryShape(shape.id === S.secondarySelectedShapeId ? null : shape.id);
          } else {
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
        {isWireframe && (
          <>
            <mesh ref={meshRef} geometry={localGeometry} visible={false} {...raycastProps} />
            {outline(isSelected ? '#60a5fa' : shouldShowAsReference ? '#ef4444' : EDGE_COLOR, isSelected || shouldShowAsReference ? EDGE_LINE_WIDTH + 0.75 : EDGE_LINE_WIDTH + 0.25, true)}
          </>
        )}
        {(isXray || shouldShowAsReference) && (
          <>
            <mesh ref={meshRef} geometry={localGeometry} castShadow receiveShadow {...raycastProps}>
              <meshStandardMaterial color={shouldShowAsReference ? '#ef4444' : '#c8c8c8'} emissive="#000000" emissiveIntensity={0} metalness={0} roughness={1.0} transparent
                opacity={hasPanels ? 0 : shouldShowAsReference ? 0.2 : 0.06} side={THREE.DoubleSide} depthWrite={false} flatShading={false} />
            </mesh>
            {outline(isSelected ? '#1e40af' : shouldShowAsReference ? '#991b1b' : EDGE_COLOR, isSelected || shouldShowAsReference ? EDGE_LINE_WIDTH + 0.5 : EDGE_LINE_WIDTH, false)}
          </>
        )}

        {shape.fillets?.length > 0 && S.filletMode && <FilletEdgeLines shape={shape} />}
        {isSelected && S.faceEditMode && <FaceEditor key={`face-editor-${shape.id}-${shape.geometry?.uuid || ''}-${(shape.fillets || []).length}`} shape={shape} />}
        {isSelected && S.raycastMode && <FaceRaycastOverlay key={`raycast-${shape.id}-${shape.geometry?.uuid || ''}`} shape={shape} allShapes={S.shapes} />}
        {isRefMode && (
          <RefFaceOverlay geometry={localGeometry} faces={refFaces} groups={refFaceGroups} hoveredGroup={hoveredRefGroup}
            candidateGroup={isRefCandidateShape ? (S.faceExtrudeRefCandidate?.faceGroupIndex ?? null) : null}
            onHover={setHoveredRefGroup} onPointerDown={confirmRefOnRightClick} onClick={(e: any) => { e.stopPropagation(); handleRefClick(e); }} />
        )}
        {isSelected && S.volumePickMode && <VolumePickOverlay shape={shape} allShapes={S.shapes} />}
        {isSelected && S.doorPickMode && <DoorPickOverlay shape={shape} />}
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
