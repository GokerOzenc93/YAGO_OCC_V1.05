import * as THREE from 'three';
import React, { useMemo, useRef, useEffect, useState, useCallback, useLayoutEffect } from 'react';
import { Line, TransformControls, PerspectiveCamera, OrthographicCamera, Html, OrbitControls, GizmoHelper } from '@react-three/drei';
import { useThree, useFrame, Canvas } from '@react-three/fiber';
import { RefreshCw } from 'lucide-react';
import {
  type DoorGroup, engineLoad, entryGate, useAppStore, shapeById, useStoreFields, ViewMode, type VirtualFace, childPanelsOf, vfOfPanel, type FilletInfo, type CavityPick,
  type XformDelta, applyXformDelta, Tool, type Shape, CameraType, requestRebuild, type SceneToolStatus, type GuideKey, type PanelGroup,
} from '../store';
import {
  type DoorMemberRect, doorMembersOf, doorPlaneAxes, isDoorPanel, splitDoorAtPanel, collectDoorCuts, DOOR_THICKNESS, confirmDoorPick, doorSlabPolygon,
  DOOR_GAP, pickRectFor, rayDoorEntry, doorCandidatesAt,
} from './DoorService';
import {
  localBboxOf, type Vec3, edgePointsOf, planeCornerShift, planeNeighbourNormal, planeSpanOf, type FaceData, type CoplanarFaceGroup, createFaceHighlightGeometry,
  flatGroupOfFace, getShapeMatrix, REF_COLORS, confirmRefFaceExtrude, getFacesAndGroups, computeFaceComponentContour, panelInnerBigFace, panelBehindStackPlane,
  computeFreeRegionLocal, genId, createFaceDescriptor, getFacePlaneAxes, earClipTriangulate, effectiveBodyGeometry, pointInTriangle3D, findPanelCoveringPoint,
  groupIndexOfFace, panelHasRotation, createGroupBoundaryEdges, applyFillets, matchCurvedFaceGroup, convertReplicadToThreeGeometry, type AxisLetter, type AxisDir,
  axisDirToVec, uniqueMeshPoints, resolveBaseVertices, composeVertexTargets, confirmPanelMoveRef, confirmPanelRotateRef, axisIndexOf, getReplicadVertices, round1,
  swingPoints, footprintGeometry, outlineGeometry, isPostSketchFace, dominantAxisLabel, executeFaceExtrude, mapAxisToVfLocal, angleToTouchPlane, executePanelMove,
  executePanelMoveFixed, executePanelRotate, FACE_KINDS, FACE_KIND_LABEL, FACE_ROLES, FACE_ROLE_LABEL, type FaceKind, type FaceRole, faceRoleText,
} from './Geometry';
import { connectorPartInstances, paintPanelBands, panelBandKey, panelBanding, placementTypeFor } from './ConnectorService';
import {
  type PlinthPick, type PlinthRegion, type PlinthSet, confirmPlinthPick, plinthBoxOf, plinthBoxesOf, plinthCandidates, plinthLegSpots, plinthPickBox,
  plinthRowKey, plinthSetsOf, isPlinthRow, finishPlinthEdit, plinthRegionOf, prismGeometry, bodyFrontAxis, bodyFaces, setBodyFaceRole, bodyFacesByRole,
  plinthLegsOf, applyPlinthFace,
} from './PlinthService';
import { LAYER_DEFAULT_COLOR, type LegAssemblyPart, accessoryGeometryNow, legAssembly, onAccessoryGeometry } from './AccessoryService';
import {
  boxCenter, executeCavityExtrudeAt, executeCavityExtrudeToReference, groupBoundsPanelPredicate, isInteriorPanel, repickObstacles, collectObstacles,
  gridForObstacles, boxesSurface, rayCavityCandidates, GROUP_PANEL_THICKNESS, confirmVolumePick,
} from './PanelGroupService';
import {
  vfBackBound, isBackPanel, splitBackAtPanel, backPreviewStamp, backPickObstacle, collectBackCuts, BACK_THICKNESS, confirmBackPick, backSlabPolygon,
  BACK_GAP, backPickRect, rayBackEntry, backCandidatesAt, backStackAt,
} from './BackService';
import { panelStampsRegions, panelStepRotation } from './PanelEngine';
import { ErrorBoundary, MONO_FONT } from './Ui';
import { DimLayer, DraftLayer } from './DraftView';
import { useDraft } from './Draft';

// ═════════════════════════════════════════════════ 1. SAHNE NESNELERİ ═════════════════════════════════════════════════
/* Sahne nesneleri — şekil başına çizilenler: PanelDrawing, FaceOverlays (yüz / VF / fillet / hacim / kapak seçimi), ShapeWithTransform.
   Seçili panel taranmaz: dolgu çelik-mavi tona karışır, kenar koyu petrol. Her kapakta şemadaki açılış işareti. */

const PANEL_COLORS = {
  selected: { shapeEdge: '#e8590c' },
  edge: { default: '#5b6470' },
} as const;

/** Seçim tonu: çelik mavisi panel rengiyle `mix` oranında; seçili panelin emissive'i koyulaşır (beyaza yıkanmasın). Açılış işareti nötr gri. */
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

/** Tek seçim paleti (petrol mavisi); extrude* yalnız yüz-extrude için. Hacimler düşük opaklıkta. REF_COLORS (sarı) ayrı rol. */
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

/** Yüz-extrude'da hedef dışı paneller: X-ray opaklığı; kenarlar derinlik testli — arkadakiler öndekini delmez. */
const XRAY_PANEL_OPACITY = 0.35;
/** X-ray kipinde panel dolgusu (kenarlar net okunsun diye hayalet panellerden daha saydam). */
const XRAY_MODE_PANEL_OPACITY = 0.22;
const EXTRUDE_XRAY_EDGE = '#6b7280';

/* Kapak açılış işareti (3B) — şemadaki DIN/AWI sözleşmesinin aynısı (aynalama ve double / fold kanatları dahil). */
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


/** Kapağın ön yüzüne açılış işareti; VF çokgeni panel geometrisinin ön yüzüne oturtulur (taşıma adımında da mesh'le kalır). */
const DoorSwingMark: React.FC<{ geometry: THREE.BufferGeometry; vfId: string; active: boolean; mono?: string }> = React.memo(({ geometry, vfId, active, mono }) => {
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
    const tri = swingPoints(poly, hinge, ins, 1e-3);
    if (!tri) return null;
    const plane = (group.side > 0 ? bb.max.getComponent(group.axis) : bb.min.getComponent(group.axis)) + group.side * SWING_LIFT;
    const to3 = (q: Pt2) => {
      const p = new THREE.Vector3(); p.setComponent(group.axis, plane); p.setComponent(u, q.x + du); p.setComponent(v, q.y + dv); return p;
    };
    const dash = THREE.MathUtils.clamp(span * 0.025, 6, 18);
    return { pts: tri.map(to3), dash };
  }, [geometry, vf, group]);
  if (!mark) return null;
  return (
    <Line points={mark.pts} color={mono ?? (active ? DOOR_SWING.active : DOOR_SWING.idle)} lineWidth={active ? DOOR_SWING.activeWidth : DOOR_SWING.idleWidth}
      dashed dashSize={mark.dash} gapSize={mark.dash * 0.8}
      transparent={!!mono} depthTest={!mono} depthWrite={false} renderOrder={mono ? XRAY_EDGE.order : 3} raycast={noRaycast} />
  );
});

// Z-fighting: mesh küçük polygonOffset alır; kenar çizgisi yalnız sabit birim payı (eğim payı uzakta büyüyüp arka kenarı öne çıkarır).
const MESH_OFFSET = 1.0, EDGE_OFFSET_FACTOR = 0, EDGE_OFFSET_UNITS = -1.0, EDGE_RENDER_ORDER = 1;
/** Görünüm kipi çizgileri: wireframe'de tek renk (seçim kalınlıkla); X-ray'de kenarlar saydam dolguların ardından, koyu ve kalın. */
const WIRE_COLOR = '#3f4650';
const XRAY_EDGE = { color: '#2f3640', extra: 0.45, order: 30 };
export const EDGE_LINE_WIDTH = 1.0;
export const EDGE_ANGLE_THRESHOLD = 15;

export const HitMaterial = () => <meshBasicMaterial transparent opacity={0.01} side={THREE.DoubleSide} depthTest={false} depthWrite={false} />;
const OverlayMat = ({ color, opacity }: { color: number; opacity: number }) =>
  <meshBasicMaterial color={color} transparent opacity={opacity} side={THREE.DoubleSide} depthTest={false} depthWrite={false} />;
/** Yarı saydam dolgu (derinlik yazmaz, derinlik testli): hacim / levha önizlemeleri. */
const FillMat = ({ color, opacity }: { color: number; opacity: number }) =>
  <meshBasicMaterial color={color} transparent opacity={opacity} side={THREE.DoubleSide} depthWrite={false} />;
const noRaycast = () => null;
const stopEvent = (e: any) => e.stopPropagation();
/** Vurgu katmanı: tıklanmaz, her şeyin üstünde. */
const OverlayMesh = ({ geometry, color, opacity, order }: { geometry: THREE.BufferGeometry; color: number; opacity: number; order: number }) => (
  <mesh geometry={geometry} renderOrder={order} raycast={noRaycast}><OverlayMat color={color} opacity={opacity} /></mesh>
);
/** Tıklanmaz, derinlik testsiz kenar çizgileri (segment çiftleri). */
const EdgeLines = ({ points, color, width, order }: { points: Vec3[]; color: string; width: number; order: number }) => (
  <Line points={points} segments color={color} lineWidth={width} transparent={false} depthTest={false} depthWrite={false} renderOrder={order} raycast={noRaycast} />
);
const FaceOutline: React.FC<{ geometry: THREE.BufferGeometry; color: string; width: number }> = ({ geometry, color, width }) => {
  const pts = useMemo(() => edgePointsOf(geometry, 1), [geometry]);
  if (pts.length < 2) return null;
  return <EdgeLines points={pts} color={color} width={width} order={13} />;
};
/** Yüz grubunun vurgu geometrisi (grup yoksa null). */
const groupHighlight = (faces: FaceData[], groups: CoplanarFaceGroup[], gi: number | null) =>
  (gi !== null && groups[gi] ? createFaceHighlightGeometry(faces, groups[gi].faceIndices) : null);
/** Vuruş mesh'inde yüz grubu hover'ı (düz grup). `pick`: yüz → grup eşlemesi (varsayılan: eğri grup en yakın düz gruba yaslanır). */
const faceHoverEvents = (groups: CoplanarFaceGroup[], onHover: (gi: number | null) => void,
  pick: (groups: CoplanarFaceGroup[], faceIndex: number | undefined) => number = flatGroupOfFace) => ({
  onPointerMove: (e: any) => { e.stopPropagation(); const gi = pick(groups, e.faceIndex); onHover(gi !== -1 ? gi : null); },
  onPointerOut: (e: any) => { e.stopPropagation(); onHover(null); },
});
/** Extrude hedef yüzü: yalnız düz yüzler; eğri yüz vurgulanmaz, tık yok sayılır. */
const planarGroupOfFace = (groups: CoplanarFaceGroup[], faceIndex: number | undefined) => {
  const gi = groupIndexOfFace(groups, faceIndex);
  return gi >= 0 && !groups[gi].isCurved ? gi : -1;
};
/** Gövdeye (ya da panellerinden birine) çift tık: gövdenin düzenlemesine girilir — gövde seçilir, panel seçim kipi açılır (paneller tek tek
 *  tıklanır, gövdenin taşıma okları kalkar) ve sol kenar çubuğu açılır. Aktif araç / yerleştirme sürerken çift tık yok sayılır. */
function enterBodyEdit(bodyId: string) {
  const st = useAppStore.getState();
  if (st.faceExtrudeMode || st.panelMoveMode || st.panelRotateMode || st.raycastMode || st.volumePickMode || st.doorPickMode || st.backPickMode
    || st.plinthPickMode || st.quickBodyMode) return;
  const d = useDraft.getState();
  if (d.isolate || d.bodyPreview || d.planePick) return;
  if (st.selectedShapeId !== bodyId) st.selectShape(bodyId);
  if (!st.panelSelectMode) st.setPanelSelectMode(true);
  st.requestSidebarOpen();
}
/** Olay noktası şeklin yerel uzayında. */
const localPointOf = (e: any, shape: any): Vec3 | null => {
  if (!e.point) return null;
  const l = e.point.clone().applyMatrix4(getShapeMatrix(shape).invert());
  return [l.x, l.y, l.z];
};
/** Kenar noktaları (açı eşiğiyle); geometri yok / hata → null. */
const safeEdgePoints = (geo: THREE.BufferGeometry | undefined, angle: number): Vec3[] | null => {
  try { const p = geo ? edgePointsOf(geo, angle) : []; return p.length ? p : null; } catch { return null; }
};

/* Panel giriş efekti: panel ilk belirdiğinde yerine gelir ya da geçici shader ile oluşur; efekt bileşimden üretilir (son 64 imza
   tekrarlanmaz). Yalnız sarmalayıcı grubun transformu oynar; bitince shader sökülür. */
interface EntryCtx {
  center: THREE.Vector3; size: THREE.Vector3; min: THREE.Vector3; max: THREE.Vector3;
  normal: THREE.Vector3; side: THREE.Vector3; long: THREE.Vector3; short: THREE.Vector3; far: number;
}
type Ease = (t: number) => number;
const EASES: Record<string, Ease> = {
  cubic: t => 1 - Math.pow(1 - t, 3),
  quint: t => 1 - Math.pow(1 - t, 5),
  expo: t => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  circ: t => Math.sqrt(1 - Math.pow(t - 1, 2)),
  back: t => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
  backHard: t => { const c = 2.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
  elastic: t => (t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1),
  bounce: t => {
    const n = 7.5625, d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
};
const Y_UP = new THREE.Vector3(0, 1, 0);
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];
const sgnR = () => (Math.random() < 0.5 ? -1 : 1);
const perpOf = (d: THREE.Vector3) => new THREE.Vector3().crossVectors(d, Math.abs(d.y) < 0.9 ? Y_UP : new THREE.Vector3(1, 0, 0)).normalize();
const axisIdx = (v: THREE.Vector3) => { const a = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)]; return a.indexOf(Math.max(...a)); };

const FX_PATHS = ['line', 'arc', 'spiral', 'serpent', 'orbit', 'drop', 'still'] as const;
const FX_DIRS = ['normal', 'side', 'up', 'down', 'long', 'longNeg', 'normalUp', 'normalSide', 'sideUp', 'normalDown'] as const;
const FX_ROTS = ['none', 'flipLong', 'flipShort', 'twist', 'tumble', 'yaw', 'wobble'] as const;
const FX_SCALES = ['none', 'grow', 'unfoldLong', 'unfoldShort', 'stretch', 'pulse'] as const;
const FX_PIVOTS = ['center', 'base', 'longEnd', 'longEndFar', 'sideEdge'] as const;
interface EntryFx {
  kind: 'motion'; sig: string; dur: number; delay: number; ease: Ease;
  path: typeof FX_PATHS[number]; D: THREE.Vector3; L: THREE.Vector3; A: THREE.Vector3; B: THREE.Vector3;
  k: number; turns: number; waves: number; phi: number;
  rot: typeof FX_ROTS[number]; ax1: THREE.Vector3; ax2: THREE.Vector3; ang1: number; ang2: number; wobF: number;
  scale: typeof FX_SCALES[number]; s0: number; sIdx: number; pivot: THREE.Vector3;
}
const _recentFx: string[] = [];
const _burst = { t: -1e9, n: 0 };
/** Aynı anda beliren paneller sırayla (dalga) gelir. */
function burstDelay(): number {
  const now = performance.now();
  _burst.n = now - _burst.t < 140 ? _burst.n + 1 : 0;
  _burst.t = now;
  return Math.min(_burst.n, 18) * 60 + rnd(0, 70);
}
function rememberFx(sig: string) { _recentFx.push(sig); if (_recentFx.length > 64) _recentFx.shift(); }

function buildEntryFx(c: EntryCtx): EntryFx {
  const dirVec = (d: typeof FX_DIRS[number]): THREE.Vector3 => {
    switch (d) {
      case 'normal': return c.normal.clone();
      case 'side': return c.side.clone();
      case 'up': return Y_UP.clone();
      case 'down': return Y_UP.clone().negate();
      case 'long': return c.long.clone();
      case 'longNeg': return c.long.clone().negate();
      case 'normalUp': return c.normal.clone().add(Y_UP).normalize();
      case 'normalSide': return c.normal.clone().add(c.side).normalize();
      case 'sideUp': return c.side.clone().add(Y_UP).normalize();
      default: return c.normal.clone().sub(Y_UP.clone().multiplyScalar(0.7)).normalize();
    }
  };
  let path: EntryFx['path'] = 'line', dir: typeof FX_DIRS[number] = 'normal', rot: EntryFx['rot'] = 'none', scale: EntryFx['scale'] = 'none';
  let pivotK: typeof FX_PIVOTS[number] = 'center', easeK = 'cubic', sig = '';
  for (let tries = 0; tries < 30; tries++) {
    path = pick(FX_PATHS);
    dir = path === 'drop' ? 'up' : pick(FX_DIRS);
    rot = pick(FX_ROTS);
    scale = pick(FX_SCALES);
    // Yerinde efekt yalnız büyüme/açılma ile: panel hep 'yoktan' gelir, yerinde belirip sallanmaz.
    if (path === 'still' && scale !== 'grow' && scale !== 'unfoldLong' && scale !== 'unfoldShort') scale = pick(['grow', 'unfoldLong', 'unfoldShort'] as const);
    pivotK = scale === 'unfoldLong' ? pick(['longEnd', 'longEndFar'] as const) : scale === 'unfoldShort' ? 'sideEdge' : pick(FX_PIVOTS);
    easeK = path === 'drop' ? pick(['bounce', 'backHard', 'elastic'] as const)
      : pick(path === 'line' || path === 'still' ? Object.keys(EASES) : ['cubic', 'quint', 'expo', 'circ', 'back', 'backHard', 'elastic']);
    sig = `${path}|${dir}|${rot}|${scale}|${pivotK}|${easeK}`;
    if (!_recentFx.includes(sig)) break;
  }
  rememberFx(sig);

  const D = dirVec(dir);
  const L = path === 'arc' && Math.abs(D.y) < 0.7 ? Y_UP.clone() : perpOf(D).multiplyScalar(sgnR());
  const A = perpOf(D), B = new THREE.Vector3().crossVectors(D, A).normalize();
  const long = c.long, short = c.short, normal = c.normal;
  const rotAxes: Record<string, [THREE.Vector3, THREE.Vector3]> = {
    none: [normal, short], flipLong: [long, short], flipShort: [short, long], twist: [normal, long],
    tumble: [long, short], yaw: [Y_UP, normal], wobble: [pick([long, short, normal]), normal],
  };
  const [ax1, ax2] = rotAxes[rot];
  const ang1 = rot === 'twist' ? sgnR() * rnd(Math.PI * 0.6, Math.PI * 2)
    : rot === 'tumble' ? sgnR() * rnd(Math.PI * 0.5, Math.PI * 1.3)
    : rot === 'yaw' ? sgnR() * rnd(Math.PI / 3, Math.PI)
    : rot === 'wobble' ? sgnR() * rnd(0.12, 0.28)
    : sgnR() * rnd(Math.PI / 2, Math.PI * 1.15);
  const half = c.size.clone().multiplyScalar(0.5);
  const along = (v: THREE.Vector3) => Math.abs(v.x) * half.x + Math.abs(v.y) * half.y + Math.abs(v.z) * half.z;
  const pivot = pivotK === 'base' ? c.center.clone().addScaledVector(Y_UP, -half.y)
    : pivotK === 'longEnd' ? c.center.clone().addScaledVector(long, -along(long))
    : pivotK === 'longEndFar' ? c.center.clone().addScaledVector(long, along(long))
    : pivotK === 'sideEdge' ? c.center.clone().addScaledVector(short, sgnR() * along(short))
    : c.center.clone();
  const slow = easeK === 'elastic' || easeK === 'bounce' ? 250 : 0;
  return {
    kind: 'motion', sig, ease: EASES[easeK], dur: rnd(620, 1050) + slow, delay: burstDelay(),
    path, D, L, A, B, k: rnd(0.65, 1.35), turns: rnd(0.6, 1.8) * sgnR(), waves: Math.floor(rnd(2, 5)), phi: sgnR() * rnd(Math.PI / 3, Math.PI * 0.9),
    rot, ax1: ax1.clone().normalize(), ax2: ax2.clone().normalize(), ang1, ang2: sgnR() * rnd(Math.PI / 4, Math.PI), wobF: Math.floor(rnd(2, 4)) * 2,
    scale, s0: rnd(0.04, 0.45), sIdx: axisIdx(scale === 'unfoldShort' ? short : scale === 'stretch' ? D : long), pivot,
  };
}

const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
function applyEntryFx(fx: EntryFx, t: number, c: EntryCtx, g: THREE.Group) {
  const e = fx.ease(t), r = 1 - e, far = c.far * fx.k;
  // Yörünge
  const off = new THREE.Vector3();
  switch (fx.path) {
    case 'line': case 'drop': off.copy(fx.D).multiplyScalar(far * r); break;
    case 'arc': off.copy(fx.D).multiplyScalar(far * r).addScaledVector(fx.L, far * 0.55 * 4 * e * r); break;
    case 'spiral': {
      const th = fx.turns * 2 * Math.PI * r;
      off.copy(fx.D).multiplyScalar(far * r).addScaledVector(fx.A, Math.cos(th) * far * 0.4 * r).addScaledVector(fx.B, Math.sin(th) * far * 0.4 * r);
      break;
    }
    case 'serpent': off.copy(fx.D).multiplyScalar(far * r).addScaledVector(fx.L, far * 0.2 * Math.sin(fx.waves * Math.PI * e) * r); break;
    case 'orbit': off.copy(fx.D).applyAxisAngle(Y_UP, fx.phi * r).multiplyScalar(far * r); break;
    default: break;
  }
  // Dönüş
  const q = new THREE.Quaternion();
  if (fx.rot === 'wobble') q.setFromAxisAngle(fx.ax1, fx.ang1 * Math.sin(fx.wobF * Math.PI * t) * Math.pow(1 - t, 2) * 4);
  else if (fx.rot === 'tumble') q.multiplyQuaternions(_q1.setFromAxisAngle(fx.ax1, fx.ang1 * r), _q2.setFromAxisAngle(fx.ax2, fx.ang2 * r));
  else if (fx.rot !== 'none') q.setFromAxisAngle(fx.ax1, fx.ang1 * r);
  // Ölçek (geometri ekseninde; sıfıra yaklaşmaz → matris tekil olmaz)
  const s = new THREE.Vector3(1, 1, 1);
  if (fx.scale === 'grow') s.setScalar(fx.s0 + (1 - fx.s0) * e);
  else if (fx.scale === 'unfoldLong' || fx.scale === 'unfoldShort') s.setComponent(fx.sIdx, 0.03 + 0.97 * e);
  else if (fx.scale === 'stretch') { const st = 1 + 0.45 * r; s.setScalar(1 / Math.sqrt(Math.max(0.2, st))); s.setComponent(fx.sIdx, st); }
  else if (fx.scale === 'pulse') s.setScalar(1 + 0.1 * Math.sin(2 * Math.PI * t) * (1 - t));
  s.set(Math.max(0.01, s.x), Math.max(0.01, s.y), Math.max(0.01, s.z));
  // p' = pivot + R·S·(p − pivot) + off
  g.quaternion.copy(q);
  g.scale.copy(s);
  g.position.copy(fx.pivot).add(off).sub(fx.pivot.clone().multiply(s).applyQuaternion(q));
}

/* ── OLUŞMA (reveal) ailesi ── */
const REVEAL_MODES = ['wipe', 'shutter', 'radial', 'corner', 'pixel', 'mosaic', 'dissolve', 'blinds', 'scan', 'diag'] as const;
type RevealMode = typeof REVEAL_MODES[number];
// Shader mod kimlikleri: 1 silme · 2 perde · 3 halka · 4 piksel · 5 mozaik · 6 erime · 7 jaluzi · 8 tarama
const REVEAL_SHADER_ID: Record<RevealMode, number> = {
  wipe: 1, diag: 1, shutter: 2, radial: 3, corner: 3, pixel: 4, mosaic: 5, dissolve: 6, blinds: 7, scan: 8,
};
const REVEAL_GLOWS = ['#f59e0b', '#ea580c', '#fbbf24', '#fde68a', '#fff7ed', '#fb923c'] as const;
interface RevealFx {
  kind: 'reveal'; sig: string; dur: number; delay: number; mode: RevealMode; shaderId: number;
  clip: 'wipe' | 'shutter' | null; axis: THREE.Vector3; u: THREE.Vector3; origin: THREE.Vector3; len: number;
  cell: number; band: number; seed: number; glow: THREE.Color; drift: THREE.Vector3;
}
type AnyEntryFx = EntryFx | RevealFx;

function buildRevealFx(c: EntryCtx): RevealFx {
  const inPlane = [c.long, c.short];
  const yIn = inPlane.find(a => Math.abs(a.y) > 0.9);   // dik panel: alttan oluşma doğal
  const corners: THREE.Vector3[] = [];
  for (let i = 0; i < 8; i++) corners.push(new THREE.Vector3(i & 1 ? c.max.x : c.min.x, i & 2 ? c.max.y : c.min.y, i & 4 ? c.max.z : c.min.z));
  let mode: RevealMode = 'wipe', axis = Y_UP.clone(), axisKey = 'y', sig = '';
  for (let tries = 0; tries < 30; tries++) {
    mode = pick(REVEAL_MODES);
    // Eksen: dikse ağırlıklı olarak alttan yukarı; aksi halde düzlem içi eksenlerden biri, rastgele yön.
    const r = Math.random();
    if (yIn && r < 0.45) { axis = Y_UP.clone().multiplyScalar(r < 0.33 ? 1 : -1); axisKey = r < 0.33 ? 'up' : 'down'; }
    else if (mode === 'diag') { axis = c.long.clone().multiplyScalar(sgnR()).add(c.short.clone().multiplyScalar(sgnR())).normalize(); axisKey = 'diag'; }
    else { const a = pick(inPlane); axis = a.clone().multiplyScalar(sgnR()); axisKey = a === c.long ? 'long' : 'short'; }
    sig = `reveal|${mode}|${axisKey}`;
    if (!_recentFx.includes(sig)) break;
  }
  const proj = corners.map(p => p.dot(axis));
  const minP = Math.min(...proj), maxP = Math.max(...proj);
  const span = Math.max(1, maxP - minP);
  const u = new THREE.Vector3().crossVectors(c.normal, axis).normalize();
  const inSpan = Math.max(c.size.x, c.size.y, c.size.z);
  let origin = axis.clone().multiplyScalar(minP), len = span, cell = 10;
  if (mode === 'shutter') { origin = c.center.clone(); len = span / 2; }
  else if (mode === 'radial' || mode === 'corner') {
    origin = mode === 'radial' ? c.center.clone() : pick(corners).clone();
    len = Math.max(1, ...corners.map(p => p.distanceTo(origin)));
  }
  if (mode === 'pixel') cell = THREE.MathUtils.clamp(inSpan / 70, 3, 12);
  else if (mode === 'mosaic') cell = inSpan / rnd(5, 10);
  else if (mode === 'dissolve') cell = rnd(50, 130);
  else if (mode === 'blinds') cell = rnd(28, 80);
  sig += `|${pick(['a', 'b', 'c'])}`;
  rememberFx(sig);
  const drift = Math.random() < 0.5 ? new THREE.Vector3()
    : (Math.random() < 0.5 ? axis.clone().multiplyScalar(-rnd(25, 80)) : c.normal.clone().multiplyScalar(rnd(30, 110)));
  return {
    kind: 'reveal', sig, dur: rnd(950, 1650), delay: burstDelay(), mode, shaderId: REVEAL_SHADER_ID[mode],
    clip: mode === 'wipe' || mode === 'diag' || mode === 'scan' ? 'wipe' : mode === 'shutter' ? 'shutter' : null,
    axis, u, origin, len, cell, band: rnd(0.035, 0.09), seed: Math.random() * 100, glow: new THREE.Color(pick(REVEAL_GLOWS)), drift,
  };
}

const REVEAL_VERT_PARS = 'varying vec3 vRvPos;\n';
const REVEAL_FRAG_PARS = `
uniform float uRvMode; uniform float uRvProg; uniform float uRvLen; uniform float uRvCell; uniform float uRvBand; uniform float uRvSeed;
uniform vec3 uRvAxis; uniform vec3 uRvOrigin; uniform vec3 uRvGlow; uniform vec3 uRvU;
varying vec3 vRvPos;
float rvHash(vec3 p) { p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419) + uRvSeed); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float rvNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(rvHash(i), rvHash(i + vec3(1, 0, 0)), f.x), mix(rvHash(i + vec3(0, 1, 0)), rvHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(rvHash(i + vec3(0, 0, 1)), rvHash(i + vec3(1, 0, 1)), f.x), mix(rvHash(i + vec3(0, 1, 1)), rvHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
`;
const REVEAL_FRAG_MAIN = `
  float rvGlow = 0.0;
  if (uRvMode > 0.5) {
    vec3 rp = vRvPos - uRvOrigin;
    float sweep = clamp(dot(rp, uRvAxis) / uRvLen, 0.0, 1.0);
    float d;
    if (uRvMode < 1.5) d = sweep;
    else if (uRvMode < 2.5) d = abs(dot(rp, uRvAxis)) / uRvLen;
    else if (uRvMode < 3.5) d = length(rp) / uRvLen;
    else if (uRvMode < 4.5) { float c = mix(uRvCell * 9.0, uRvCell, smoothstep(0.0, 0.8, uRvProg)); d = rvHash(floor(vRvPos / c)) * 0.93; }
    else if (uRvMode < 5.5) d = rvHash(floor(vRvPos / uRvCell)) * 0.82 + sweep * 0.12;
    else if (uRvMode < 6.5) d = rvNoise(vRvPos / uRvCell) * 0.78 + sweep * 0.2;
    else if (uRvMode < 7.5) d = fract(dot(rp, uRvU) / uRvCell) * 0.62 + sweep * 0.34;
    else d = sweep;
    if (d > uRvProg) discard;
    float z = uRvProg - d;
    rvGlow = 1.0 - smoothstep(0.0, uRvBand, z);
    if (uRvMode > 7.5 && z < uRvBand * 5.0) {
      if (fract(dot(vRvPos, uRvAxis) / 6.0) > 0.5) discard;
      rvGlow = max(rvGlow, 0.55 * (1.0 - z / (uRvBand * 5.0)));
    }
  }
`;
const REVEAL_FRAG_TAIL = '\n  gl_FragColor.rgb = mix(gl_FragColor.rgb, uRvGlow, clamp(rvGlow, 0.0, 1.0) * 0.85);\n';
const _defaultOnBeforeCompile = THREE.Material.prototype.onBeforeCompile;
const _defaultCacheKey = THREE.Material.prototype.customProgramCacheKey;

function installRevealShader(mat: THREE.Material, fx: RevealFx): Record<string, { value: any }> {
  const u: Record<string, { value: any }> = {
    uRvMode: { value: fx.shaderId }, uRvProg: { value: 0 }, uRvLen: { value: fx.len }, uRvCell: { value: fx.cell }, uRvBand: { value: fx.band },
    uRvSeed: { value: fx.seed }, uRvAxis: { value: fx.axis.clone() }, uRvOrigin: { value: fx.origin.clone() }, uRvGlow: { value: fx.glow.clone() },
    uRvU: { value: fx.u.clone() },
  };
  mat.onBeforeCompile = (sh: any) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = REVEAL_VERT_PARS + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vRvPos = transformed;');
    sh.fragmentShader = REVEAL_FRAG_PARS + sh.fragmentShader
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n' + REVEAL_FRAG_MAIN)
      .replace('#include <opaque_fragment>', '#include <opaque_fragment>' + REVEAL_FRAG_TAIL);
  };
  mat.customProgramCacheKey = () => 'yago-reveal-v1';
  mat.needsUpdate = true;
  return u;
}
function uninstallRevealShader(mat: THREE.Material) {
  mat.onBeforeCompile = _defaultOnBeforeCompile;
  mat.customProgramCacheKey = _defaultCacheKey;
  mat.needsUpdate = true;
}
const revealCurve = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function entryCtxOf(shape: any): EntryCtx | null {
  const bb = localBboxOf(shape.geometry);
  if (!bb) return null;
  const size = bb.getSize(new THREE.Vector3()), center = bb.getCenter(new THREE.Vector3());
  const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  const dims = [size.x, size.y, size.z];
  const thin = dims.indexOf(Math.min(...dims)), longI = dims.indexOf(Math.max(...dims));
  const parent = shapeById(shape.parameters?.parentShapeId);
  const pbb = parent?.geometry ? localBboxOf(parent.geometry) : null;
  const pc = pbb ? pbb.getCenter(new THREE.Vector3()) : center.clone();
  const psize = pbb ? pbb.getSize(new THREE.Vector3()) : size;
  const rel = center.clone().sub(pc);
  const sgn = (i: number) => (rel.getComponent(i) >= 0 ? 1 : -1);
  const normal = axes[thin].clone().multiplyScalar(sgn(thin));
  const sideI = thin !== 0 ? 0 : 2;
  const side = axes[sideI].clone().multiplyScalar(sgn(sideI));
  const long = axes[longI === thin ? (thin + 1) % 3 : longI].clone().multiplyScalar(sgn(longI));
  const short = new THREE.Vector3().crossVectors(normal, long).normalize();
  const far = Math.max(psize.x, psize.y, psize.z) * 0.6 + 250;
  return { center, size, min: bb.min.clone(), max: bb.max.clone(), normal, side, long, short, far };
}
function usePanelEntryAnimation(ref: React.RefObject<THREE.Group>, meshRef: React.RefObject<THREE.Mesh>, lineRef: React.MutableRefObject<any>, shape: any) {
  const gl = useThree(st => st.gl);
  const anim = useRef<{
    started: boolean; ctx: EntryCtx | null; fx: AnyEntryFx | null; done: boolean; mat: THREE.Material | null; u: Record<string, { value: any }> | null; shadow: boolean;
    /** Yerel animasyon saati (ms; gecikme süresince negatif) ve başlamadan önce beklenen süre (ms). */
    t: number; waited: number;
    /** Sayaçtaki yeri (entryGate.waiting / playing). */
    slot: 'none' | 'waiting' | 'playing';
  }>({ started: false, ctx: null, fx: null, done: false, mat: null, u: null, shadow: true, t: 0, waited: 0, slot: 'none' });
  const setSlot = (to: 'none' | 'waiting' | 'playing') => {
    const a = anim.current;
    if (a.slot === to) return;
    if (a.slot === 'waiting') entryGate.waiting--; else if (a.slot === 'playing') entryGate.playing--;
    if (to === 'waiting') entryGate.waiting++; else if (to === 'playing') entryGate.playing++;
    a.slot = to;
  };
  const finishReveal = () => {
    const a = anim.current;
    if (a.mat) { uninstallRevealShader(a.mat); a.mat = null; a.u = null; }
    const mesh = meshRef.current;
    if (mesh) mesh.castShadow = a.shadow;
    const lm = lineRef.current?.material;
    if (lm) { lm.clippingPlanes = null; lm.transparent = false; lm.opacity = 1; lm.needsUpdate = true; }
  };
  useEffect(() => () => { if (anim.current.mat) uninstallRevealShader(anim.current.mat); setSlot('none'); }, []);
  useFrame((_, delta) => {
    const a = anim.current, g = ref.current;
    if (a.done || !g || !shape.geometry) return;
    if (!a.started) {
      // Motorun ürettiği panel SON geçiş geometrisini bekler (ara geçişte biçim değiştirip zıplamasın). Motor dışında doğan panel, motor boşsa
      // kısa bir beklemeden sonra başlar; en çok 20 sn beklenir (kapı hiç açılmazsa panel görünmez kalmasın).
      const ready = entryGate.ready.has(shape.id) || (!engineLoad.active && a.waited > 120) || a.waited > 20000;
      if (!ready) { a.waited += delta * 1000; g.visible = false; setSlot('waiting'); return; }
      g.visible = true;
      a.started = true;
      a.ctx = entryCtxOf(shape);
      if (!a.ctx) { a.done = true; setSlot('none'); return; }
      setSlot('playing');
      a.fx = Math.random() < 0.45 ? buildRevealFx(a.ctx) : buildEntryFx(a.ctx);
      a.t = -a.fx.delay;
      if (a.fx.kind === 'reveal') {
        gl.localClippingEnabled = true;
        const mesh = meshRef.current;
        if (mesh && mesh.material && !Array.isArray(mesh.material)) {
          a.mat = mesh.material;
          a.u = installRevealShader(a.mat, a.fx);
          a.shadow = mesh.castShadow;
          mesh.castShadow = false;   // oluşurken tam gövdenin gölgesi düşmesin
        }
      }
    }
    const fx = a.fx!;
    // YEREL SAAT: kare aralığı 1/30 sn ile sınırlı — ana iş parçacığı dolu kaldığında animasyon zıplamaz, durduğu yerden sürer.
    // Delikleri kesim işçisindeyken sona doğru yavaşlar (≈ %93'e asimptotik yaklaşır); delikler gelince normal hızla tamamlanır.
    const t0 = a.t / fx.dur;
    const speed = entryGate.decor.has(shape.id) && t0 > 0.5 ? Math.max(0.025, Math.min(1, (0.93 - t0) / 0.43)) : 1;
    a.t += Math.min(delta, 1 / 30) * 1000 * speed;
    const t = Math.min(1, Math.max(0, a.t / fx.dur));
    if (fx.kind === 'motion') applyEntryFx(fx, t, a.ctx!, g);
    else {
      const p = revealCurve(t) * 1.04;
      if (a.u) a.u.uRvProg.value = p;
      const e = 1 - Math.pow(1 - t, 3);
      g.position.copy(fx.drift).multiplyScalar(1 - e);
      g.quaternion.identity(); g.scale.setScalar(1);
      const line = lineRef.current, lm = line?.material;
      if (lm) {
        // Kenarlar: silme/perde modlarında oluşma cephesiyle kırpılır, diğerlerinde sona doğru belirir.
        if (fx.clip) {
          line.updateWorldMatrix(true, false);
          const c0 = fx.origin.dot(fx.axis), reach = Math.min(1, p) * fx.len;
          const planes = fx.clip === 'wipe'
            ? [new THREE.Plane(fx.axis.clone().negate(), c0 + reach)]
            : [new THREE.Plane(fx.axis.clone().negate(), c0 + reach), new THREE.Plane(fx.axis.clone(), -(c0 - reach))];
          lm.clippingPlanes = planes.map(pl => pl.applyMatrix4(line.matrixWorld));
        } else {
          const o = THREE.MathUtils.smoothstep(t, 0.45, 1);
          if (!lm.transparent) { lm.transparent = true; lm.needsUpdate = true; }
          lm.opacity = o;
        }
      }
    }
    if (t >= 1) {
      a.done = true;
      setSlot('none');
      g.position.set(0, 0, 0); g.quaternion.identity(); g.scale.setScalar(1);
      if (fx.kind === 'reveal') finishReveal();
    }
  });
}

const NO_FACES: ReturnType<typeof getFacesAndGroups> = { faces: [], groups: [] };
/** Giriş animasyonunun gölgelendiricisini açılışta, boşta derletir: yoksa İLK animasyon başlarken program derlenir / bağlanır (ölçülen
 *  ~300–500 ms; yazılımsal GPU'da). Panel malzemesiyle aynı tür ve ayarlar (Lambert, iki yüz, gölge) → program önbelleğine aynı anahtar. */
export function RevealShaderWarmup() {
  const gl = useThree(st => st.gl), scene = useThree(st => st.scene), camera = useThree(st => st.camera);
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      const mat = new THREE.MeshLambertMaterial({ color: '#f0ebe3', side: THREE.DoubleSide, vertexColors: true });
      const fx = { shaderId: 1, len: 1, cell: 1, band: 0.05, seed: 0, axis: new THREE.Vector3(0, 1, 0), origin: new THREE.Vector3(), glow: new THREE.Color('#fff'), u: new THREE.Vector3(1, 0, 0) };
      installRevealShader(mat, fx as unknown as RevealFx);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false; mesh.scale.setScalar(1e-6);
      scene.add(mesh);
      const done = () => { scene.remove(mesh); mesh.geometry.dispose(); mat.dispose(); };
      // Yalnız bu mesh derlenir (ışıklar sahneden): bütün sahne verilirse three, derleme sürerken silinen başka bir malzemede
      // "reading 'isReady'" hatası fırlatıp hiç bitmiyordu (ısınma mesh'i sahnede kalıyordu).
      try { void gl.compileAsync(mesh, camera, scene).then(done, done); } catch { done(); }
    };
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    const t = setTimeout(() => (w.requestIdleCallback ? w.requestIdleCallback(run, { timeout: 4000 }) : run()), 2500);
    return () => { cancelled = true; clearTimeout(t); };
  }, [gl, scene, camera]);
  return null;
}

export const PanelDrawing: React.FC<{ shape: any; isSelected: boolean }> = React.memo(({ shape, isSelected }) => {
  const meshRef = useRef<THREE.Mesh>(null);
  const animRef = useRef<THREE.Group>(null);
  const edgeRef = useRef<any>(null);
  usePanelEntryAnimation(animRef, meshRef, edgeRef, shape);
  const S = useStoreFields('selectShape', 'selectSecondaryShape', 'selectedShapeId', 'selectedPanelRow', 'setSelectedPanelRow', 'panelSelectMode',
    'viewMode', 'faceExtrudeMode', 'faceExtrudeTargetPanelId', 'faceExtrudeSelectedFace', 'setFaceExtrudeSelectedFace', 'setFaceExtrudeClickPoint',
    'raycastMode', 'faceExtrudeValueMode', 'faceExtrudeRefCandidate', 'panelMoveMode', 'panelMoveValueMode', 'panelMoveTargetPanelId',
    'panelMoveRefSourceVertex', 'panelMoveRefTargetPanelId', 'panelMoveRefTargetVertex', 'panelRotateMode', 'panelRotateValueMode',
    'panelRotateTargetPanelId', 'panelRotatePivot', 'panelRotateRefArmVertex', 'panelRotateAxis', 'panelRotateRefFace', 'setPanelRotateRefFace',
    'selectedPanelGroupId', 'volumePickMode', 'volumePickGroupId', 'selectedDoorGroupId', 'doorPickMode', 'doorRefPickGroupId', 'setDoorRefPickGroupId', 'plinthPickMode',
    'selectedBackGroupId', 'backFocusVfIds', 'backPickMode', 'backRefPickGroupId', 'setBackRefPickGroupId', 'virtualFaces');
  const [hoveredExtrudeGroup, setHoveredExtrudeGroup] = useState<number | null>(null);
  const [moveRefHover, setMoveRefHover] = useState(false);
  const draftIso = useDraft(st => st.isolate);
  const rp = useRefPick();
  const draftBodyEdit = useDraft(st => st.bodyPreview?.shapeId ?? null);

  const params = shape.parameters;
  const parentShapeId = params?.parentShapeId;
  const virtualFaceId = params?.virtualFaceId;
  const isParentSelected = parentShapeId === S.selectedShapeId;
  // Panel her zaman gövdenin güncel dönüşümüyle çizilir (eski kayıtlarda panelin kendi dönüşü 0 kalmış olabilir).
  const parentPos = useAppStore(st => (parentShapeId ? st.shapes.find(x => x.id === parentShapeId)?.position : undefined));
  const parentRot = useAppStore(st => (parentShapeId ? st.shapes.find(x => x.id === parentShapeId)?.rotation : undefined));
  const parentScale = useAppStore(st => (parentShapeId ? st.shapes.find(x => x.id === parentShapeId)?.scale : undefined));
  // Arkalık: şemada parça seçiliyse yalnız o parçalar (backFocusVfIds), değilse grubun tüm üyeleri.
  const backFocused = !S.backFocusVfIds.length || S.backFocusVfIds.includes(virtualFaceId);
  const isGroupSelected = isParentSelected && ((!!S.selectedPanelGroupId && params?.panelGroupId === S.selectedPanelGroupId)
    || (!!S.selectedDoorGroupId && params?.doorGroupId === S.selectedDoorGroupId)
    || (!!S.selectedBackGroupId && params?.backGroupId === S.selectedBackGroupId && backFocused));
  const isRowSelectedRaw = isGroupSelected || (isParentSelected && !!virtualFaceId && S.selectedPanelRow === `vf-${virtualFaceId}`);
  // Sınır vurgusu: kapak seçme/ref → doorBound, arkalık seçme/ref → backBound.
  const ownVf = virtualFaceId ? S.virtualFaces.find(f => f.id === virtualFaceId) : undefined;
  const doorPicking = S.doorPickMode || !!S.doorRefPickGroupId, backPicking = S.backPickMode || !!S.backRefPickGroupId;
  const isDoorBoundPanel = isParentSelected && !!ownVf && ((doorPicking && !!ownVf.doorBound) || (backPicking && vfBackBound(ownVf)));
  // Bu modlarda kapaklar/arkalıklar saydam ve tıklanmaz: arkasındaki dikme/raf seçilebilsin.
  const isDoorPickGhost = isParentSelected && ((doorPicking && isDoorPanel(shape)) || (backPicking && isBackPanel(shape)));

  const edgePoints = useMemo(() => safeEdgePoints(shape.geometry, EDGE_ANGLE_THRESHOLD), [shape.geometry]);
  // KENAR BANDI: bantsız kenar ham levha renginde, bantlı kenar yüzey renginde (köşe rengi). İmza komşu panel değişince de değişir (birleşim).
  const bandKey = useAppStore(st => panelBandKey(shape.id, st));
  useMemo(() => paintPanelBands(shape.geometry, panelBanding(shape.id), shape.color || '#ffffff'), [shape.geometry, bandKey, shape.color]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Ok modunda yüz seçilmez (oklar en dış yüzü büyütür) → yüz yakalama / vurgu kapalı, panel normal çizilir.
  const isFaceExtrudeTarget = S.faceExtrudeMode && shape.id === S.faceExtrudeTargetPanelId;
  // Yüz grupları YALNIZ yüz extrude hedefinde gerekir (vurgu + yüz seçimi). Her geometri değişiminde her panel için hesaplanıyordu (üretim
  // sırasında ana iş parçacığının en büyük kalemlerinden biri).
  const { faces, groups: faceGroups } = useMemo(() => (isFaceExtrudeTarget && shape.geometry ? getFacesAndGroups(shape.geometry) : NO_FACES), [isFaceExtrudeTarget, shape.geometry]);
  const isFaceExtrudeXray = S.faceExtrudeMode && shape.id !== S.faceExtrudeTargetPanelId;
  // Referans seçiminde yalnız bırakılan panel (yüzü / köşesi seçilirken): olduğu gibi çizilir, öteki her şey gizlenir.
  const isRefIso = rp?.stage === 'isolated' && rp.isoId === shape.id;
  const isRefHidden = rp?.stage === 'isolated' && rp.isoId !== shape.id;
  // Yeniden hacim seçimi: sahne grubun adımından önceki duruma döner (sonraki paneller çizilmez, grubun üyeleri saydam).
  const repickRole: 'none' | 'bounds' | 'member' | 'later' = (() => {
    if (!S.volumePickMode || !S.volumePickGroupId || !isParentSelected) return 'none';
    const st = useAppStore.getState();
    const g = st.panelGroups.find(x => x.id === S.volumePickGroupId);
    if (!g) return 'none';
    if (params?.panelGroupId === g.id) return 'member';
    return groupBoundsPanelPredicate(g, st.panelGroups, st.virtualFaces)(shape) ? 'bounds' : 'later';
  })();
  const isRepickXray = repickRole === 'member';
  const isRepickHidden = repickRole === 'later';
  const isGhost = (isFaceExtrudeXray && !isRefIso) || isRepickXray || isDoorPickGhost;
  const isPanelRowSelected = isRowSelectedRaw && !isRepickXray;
  const anyPick = S.raycastMode || S.volumePickMode !== null || S.doorPickMode || S.backPickMode;
  const isRaycastOnParent = anyPick && parentShapeId && parentShapeId === S.selectedShapeId;
  // REFERANS SEÇİMİ (bkz. refPickOf): önce PANEL tıklanır → o panel yalnız bırakılır → yüzü (taşımada köşesi) seçilir.
  // Panel aşamasında hedef dışındaki her panel tıklanabilir ve üzerine gelince vurgulanır; hacimde grubun kendi üyeleri referans olamaz.
  const moveRefSrc = rp?.tool === 'move';
  const isMoveRefTargetPanel = moveRefSrc && rp!.stage === 'picked' && S.panelMoveRefTargetPanelId === shape.id;
  const isMoveRefPickMode = !!rp && shape.id !== rp.ownerId && !(rp.cavityId && params?.panelGroupId === rp.cavityId)
    && (rp.stage === 'panel' || (rp.stage === 'picked' && rp.tool !== 'move'));
  const isMoveRefHovered = isMoveRefPickMode && moveRefHover;
  const moveRefHighlight = isMoveRefTargetPanel || isMoveRefHovered;
  const disableRaycast = isRefIso || ((isFaceExtrudeTarget || (isFaceExtrudeXray && !isMoveRefPickMode) || isRaycastOnParent
    || (!!S.doorRefPickGroupId && isDoorPanel(shape)) || (!!S.backRefPickGroupId && isBackPanel(shape))) && !isMoveRefPickMode);

  useEffect(() => { const mesh = meshRef.current; if (mesh) mesh.raycast = disableRaycast ? () => {} : THREE.Mesh.prototype.raycast; }, [disableRaycast]);
  useEffect(() => { if (!isMoveRefPickMode && moveRefHover) setMoveRefHover(false); }, [isMoveRefPickMode, moveRefHover]);

  const extrudeHighlightGeometry = useMemo(() => (isFaceExtrudeTarget && hoveredExtrudeGroup !== S.faceExtrudeSelectedFace && faces.length
    ? groupHighlight(faces, faceGroups, hoveredExtrudeGroup) : null), [isFaceExtrudeTarget, hoveredExtrudeGroup, faceGroups, faces, S.faceExtrudeSelectedFace]);
  const extrudeSelectedGeometry = useMemo(() => (isFaceExtrudeTarget && faces.length ? groupHighlight(faces, faceGroups, S.faceExtrudeSelectedFace) : null),
    [isFaceExtrudeTarget, S.faceExtrudeSelectedFace, faceGroups, faces]);

  if (!shape.geometry) return null;
  if (isRepickHidden || isRefHidden) return null;
  // Yüz çiziminde izolasyon (DraftView): yalnız hedef panel çizilir; gövde yüzüne çizimde tüm paneller gizlenir.
  if (draftIso && draftIso.targetId !== shape.id) return null;
  // Gövde adımı düzenlenirken (izolasyon kapatılsa da) gövdenin panelleri çizilmez: yalnız çizgiler görünür; paneller depoda aynen durur.
  if (draftBodyEdit && shape.parameters?.parentShapeId === draftBodyEdit) return null;

  // Çizim hedefi panel dolgusuz, yalnız kenarlarla çizilir (çizim ve düğümler kaybolmasın); yüz seçimi kendi ışınıyla çalışır.
  const isDraftTarget = !!draftIso && draftIso.targetId === shape.id;
  const isWireframe = S.viewMode === ViewMode.WIREFRAME || isDraftTarget;
  const isXray = S.viewMode === ViewMode.XRAY && !isDraftTarget;
  const moveRefCss = isMoveRefTargetPanel ? '#15803d' : REF_COLORS.selectedCss;
  const edgeColorRaw = moveRefHighlight ? moveRefCss : isDoorBoundPanel ? DOOR_COLORS.boundEdge : isSelected ? PANEL_COLORS.selected.shapeEdge
    : isPanelRowSelected ? PANEL_SELECT.edge : isGhost ? EXTRUDE_XRAY_EDGE : PANEL_COLORS.edge.default;
  // Wireframe: tek renk; X-ray: varsayılan kenar koyulaşır (vurgular kendi rengini korur).
  const edgeColor = isDraftTarget ? PANEL_COLORS.edge.default : isWireframe ? WIRE_COLOR : isXray && edgeColorRaw === PANEL_COLORS.edge.default ? XRAY_EDGE.color : edgeColorRaw;
  const edgeWidth = moveRefHighlight ? EDGE_LINE_WIDTH + 0.9 : isDoorBoundPanel ? EDGE_LINE_WIDTH + 1.1 : isSelected ? EDGE_LINE_WIDTH + 0.7
    : isPanelRowSelected ? EDGE_LINE_WIDTH + PANEL_SELECT.edgeExtra : EDGE_LINE_WIDTH;
  // Seçim tonu: tarama yok — dolgu harmanlanır; ref/taşıma vurgusu varken o rol önceliklidir.
  const panelColor = isPanelRowSelected && !moveRefHighlight ? tintedPanelColor(shape.color) : (shape.color || '#ffffff');
  // Açılış işareti her kapakta görünür; kapaklar saydamlaştığı modlarda (kapak seçme/ref, X-ray hedef dışı) gizlenir.
  const showSwing = !!virtualFaceId && isDoorPanel(shape) && !isGhost && !isDraftTarget;

  const handleClick = (e: any) => {
    e.stopPropagation();
    if (S.volumePickMode || S.doorPickMode || S.backPickMode || S.plinthPickMode) return;   // HACİM / KAPAK / ARKALIK / BAZA SEÇME: tıklama araca aittir
    if (S.doorRefPickGroupId) {
      if (virtualFaceId) { const ids = splitDoorAtPanel(S.doorRefPickGroupId, virtualFaceId); if (ids.length) S.setDoorRefPickGroupId(null); }
      return;
    }
    if (S.backRefPickGroupId) {
      if (virtualFaceId) { const ids = splitBackAtPanel(S.backRefPickGroupId, virtualFaceId); if (ids.length) S.setBackRefPickGroupId(null); }
      return;
    }
    // Taşıma modu: hedef panel canvas seviyesinde seçilir (MoveRefPanelPicker).
    if (S.panelMoveMode) return;
    // Extrude / hacim / döndürme referansı: tıklanan panel yalnız bırakılır (yüzü RefIsolatePicker'da seçilir).
    if (rp && rp.tool !== 'move') { if (isMoveRefPickMode) pickRefPanelFromEvent(e, rp); return; }
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
    onDoubleClick: (e: any) => { e.stopPropagation(); if (parentShapeId) enterBodyEdit(parentShapeId); },
    onPointerOver: (e: any) => { if (isMoveRefPickMode) { e.stopPropagation(); setMoveRefHover(true); } },
    onPointerOut: () => { if (moveRefHover) setMoveRefHover(false); },
    onContextMenu: (e: any) => { if (isMoveRefPickMode || isMoveRefTargetPanel) e.stopPropagation(); },
  };
  const moveRefEmissive = isMoveRefTargetPanel ? '#22c55e' : REF_COLORS.hoverCss;
  const emissive = isPanelRowSelected ? PANEL_SELECT.emissive : moveRefHighlight ? moveRefEmissive : isDoorBoundPanel ? DOOR_COLORS.boundEmissive : '#2a2a2a';
  const emissiveIntensity = isPanelRowSelected ? 1 : moveRefHighlight ? (isMoveRefTargetPanel ? 1.0 : 0.8) : isDoorBoundPanel ? 0.55 : 1;
  const xrayOpacity = moveRefHighlight ? (isMoveRefTargetPanel ? 0.5 : 0.6) : XRAY_MODE_PANEL_OPACITY;
  const opacity = isXray ? xrayOpacity : isMoveRefHovered ? 0.9 : isGhost ? XRAY_PANEL_OPACITY : isMoveRefTargetPanel ? 0.55 : 1;
  const edgeLine = (xray: boolean) => edgePoints && (
    <Line ref={edgeRef} points={edgePoints} segments color={edgeColor} lineWidth={xray ? edgeWidth + XRAY_EDGE.extra : edgeWidth}
      transparent={xray} opacity={1} depthTest={!xray} depthWrite={!xray}
      {...(!xray && !isWireframe ? { polygonOffset: true, polygonOffsetFactor: EDGE_OFFSET_FACTOR, polygonOffsetUnits: EDGE_OFFSET_UNITS } : {})}
      renderOrder={xray ? XRAY_EDGE.order : EDGE_RENDER_ORDER} raycast={noRaycast} />
  );

  return (
    <group name={`shape-${shape.id}`} position={parentPos ?? shape.position} rotation={parentRot ?? shape.rotation} scale={parentScale ?? shape.scale}>
      <group ref={animRef}>
        {!isWireframe && (
          <mesh ref={meshRef} geometry={shape.geometry} castShadow receiveShadow {...meshEvents}>
            <meshLambertMaterial color={panelColor} vertexColors emissive={emissive} emissiveIntensity={emissiveIntensity} side={THREE.DoubleSide}
              transparent={isXray || isGhost || moveRefHighlight} opacity={opacity} depthWrite={!isXray && !isGhost && !isMoveRefTargetPanel}
              polygonOffset polygonOffsetFactor={MESH_OFFSET} polygonOffsetUnits={MESH_OFFSET} />
          </mesh>
        )}
        {edgeLine(isXray)}
        {showSwing && <DoorSwingMark geometry={shape.geometry} vfId={virtualFaceId} active={isPanelRowSelected} mono={isWireframe ? WIRE_COLOR : isXray ? XRAY_EDGE.color : undefined} />}

        {isFaceExtrudeTarget && (
          <>
            <mesh geometry={shape.geometry} renderOrder={10} {...faceHoverEvents(faceGroups, setHoveredExtrudeGroup, planarGroupOfFace)}
              onPointerDown={(e: any) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                const gi = planarGroupOfFace(faceGroups, e.faceIndex);
                if (gi === -1) return;
                S.setFaceExtrudeSelectedFace(gi);
                setHoveredExtrudeGroup(gi);
                const lp = localPointOf(e, shape);
                if (lp) S.setFaceExtrudeClickPoint(lp);
              }}>
              <HitMaterial />
            </mesh>
            {extrudeHighlightGeometry && (
              <mesh geometry={extrudeHighlightGeometry} renderOrder={11}>
                <OverlayMat color={SEL_COLORS.extrudeHover} opacity={SEL_COLORS.extrudeHoverOpacity} />
              </mesh>
            )}
            {extrudeSelectedGeometry && (
              <>
                <mesh geometry={extrudeSelectedGeometry} renderOrder={12}>
                  <OverlayMat color={SEL_COLORS.extrudeActive} opacity={SEL_COLORS.extrudeActiveOpacity} />
                </mesh>
                <FaceOutline geometry={extrudeSelectedGeometry} color={SEL_COLORS.extrudeEdge} width={SEL_COLORS.extrudeEdgeWidth} />
              </>
            )}
          </>
        )}

      </group>
    </group>
  );
});

PanelDrawing.displayName = 'PanelDrawing';

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
  const p = shape.position, r = shape.rotation, s = shape.scale;
  const localToWorld = useMemo(() => getShapeMatrix(shape), [p[0], p[1], p[2], r[0], r[1], r[2], s[0], s[1], s[2]]);
  const worldToLocal = useMemo(() => localToWorld.clone().invert(), [localToWorld]);
  return { localToWorld, worldToLocal };
}

const highlightMat = (color: number, opacity: number, offset = -2, depthTest = false) => (
  <meshBasicMaterial color={color} transparent opacity={opacity} side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={offset} polygonOffsetUnits={offset}
    depthTest={depthTest} />
);

export function confirmBodyPanelPlacement(vf: VirtualFace | null | undefined): void {
  const st = useAppStore.getState();
  if (!vf) return;
  const name = st.placementName.trim();
  // Gövde paneli varsayılan kapak + arkalık sınırıdır (satırdan kapatılır); var olan gruplar sonraki rebuild'de devralır.
  // Eğri yüz paneli sınır başlamaz (sınır kutusu köşe bloğu gibi davranırdı).
  const bound = { ...vf, doorBound: vf.doorBound ?? !vf.curved, backBound: vf.backBound ?? !vf.curved };
  // Şeritte elle seçilen tip yalnız otomatikten farklıysa yazılır (yoksa panel konumunu izler).
  const type = placementTypeFor(vf, st.placementPanelType), typed = type ? { ...bound, panelType: type } : bound;
  st.addVirtualFace(name ? { ...typed, description: name } : typed);
  st.setRaycastMode(false);
}

interface PendingPreview { geo: THREE.BufferGeometry; edgeGeo: THREE.BufferGeometry; virtualFace: VirtualFace }

/** ÜST ÜSTE PANEL isteği: yüzün `depth` mm içindeki düzlem (altındaki panelin iç yüzü); altındaki panel bölgede yok sayılır. */
export interface StackSpec {
  depth: number; baseVfId: string; basePanelId: string;
  /** Eğimli taban: düzlem = tabanın büyük yüzü (`face` verilmezse boşluğa bakan). */
  onPanel?: any; face?: CoplanarFaceGroup;
  /** Arkalığın önü: derinlik her regen'de arkalık + önündeki katmanlardan yeniden okunur (VF.stackOnBack). */
  onBack?: boolean;
  /** Ayağın üstü: derinlik her regen'de baza setinin üst yüzünden okunur (VF.stackOnPlinthId). */
  onPlinth?: string;
}
/** Tıklanan yüzün serbest bölgesi ve VF'si: bölge tek kaynaktan (computeFreeRegionLocal), yerel uzayda. */
export function buildFacePreview(
  clickWorld: THREE.Vector3, group: CoplanarFaceGroup, faces: FaceData[], worldToLocal: THREE.Matrix4,
  shapeId: string, geometry?: THREE.BufferGeometry, childPanels: any[] = [], stack?: StackSpec
): PendingPreview | null {
  const clickOnFace = clickWorld.clone().applyMatrix4(worldToLocal);
  const faceContour = computeFaceComponentContour(faces, group.faceIndices, clickOnFace, group.normal);
  if (!faceContour) return null;
  let contour = faceContour, corners = faceContour.corners, clickLocal = clickOnFace;
  let nrm = group.normal.clone().normalize();
  if (stack?.onPanel) {
    // Eğimli taban: düzlem tabanın iç büyük yüzü; tık o düzleme izdüşer, VF normali tabana doğru.
    const inner = stack.face ? { faces: getFacesAndGroups(stack.onPanel.geometry).faces, group: stack.face }
      : panelInnerBigFace(stack.onPanel, clickOnFace.clone().addScaledVector(nrm, -200));
    if (!inner) return null;
    const nIn = inner.group.normal.clone().normalize();
    const seed = clickOnFace.clone().sub(nIn.clone().multiplyScalar(clickOnFace.clone().sub(inner.group.center).dot(nIn)));
    const c = computeFaceComponentContour(inner.faces, inner.group.faceIndices, seed, nIn);
    if (!c) return null;
    contour = c; corners = c.corners; clickLocal = seed; nrm = nIn.clone().multiplyScalar(-1);
  } else if (stack) {
    const shift = nrm.clone().multiplyScalar(-stack.depth);
    corners = faceContour.corners.map(c => c.clone().add(shift));
    clickLocal = clickOnFace.clone().add(shift);
  }
  // Yığındaki paneller kardeş değil; düzlemi aşanlar delen-engel. Arkalık damgası gerçek parçasıyla sınanır (bolluk bölgeyi silmesin).
  const stackPlane = clickLocal.dot(nrm.clone().multiplyScalar(-1));
  const realOf = (p: any) => (isBackPanel(p) ? shapeById(p.id) ?? p : p);
  const siblings = stack
    ? childPanels.filter(p => !panelBehindStackPlane(realOf(p), nrm, stackPlane)).map(p => ({ ...p, __pierceObstacle: true }))
    : childPanels;
  // Eğri yüz paneli bölge damgalamaz (motorla aynı kural: komşusuyla katı düzeyinde kesişir).
  const region = computeFreeRegionLocal(corners, nrm, clickLocal, siblings.filter(p => panelStampsRegions(p, shapeById(shapeId))), worldToLocal, shapeId);
  if (!region) return null;
  const { u, v, planeN, uMin, vMin, cw, ch, nx, ny, reach, touchingSiblingIds } = region;
  const to3D = (px: number, py: number) => new THREE.Vector3().addScaledVector(u, px).addScaledVector(v, py).addScaledVector(nrm, planeN);
  const pos: number[] = [], epos: number[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!reach[j * nx + i]) continue;
    const x0 = uMin + i * cw, x1 = x0 + cw, y0 = vMin + j * ch, y1 = y0 + ch;
    const p00 = to3D(x0, y0), p10 = to3D(x1, y0), p11 = to3D(x1, y1), p01 = to3D(x0, y1);
    for (const q of [p00, p10, p11, p00, p11, p01]) pos.push(q.x, q.y, q.z);
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

  const localNormal = nrm;   // eğimli tabanda VF normali taban yüzünün tersidir (gövde yüzü değil)
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
    ...(stack ? {
      stackDepth: stack.depth, stackBaseVfId: stack.baseVfId,
      ...(stack.onPanel ? { stackOnPanel: true } : {}), ...(stack.onBack ? { stackOnBack: true } : {}),
      ...(stack.onPlinth ? { stackOnPlinthId: stack.onPlinth } : {}),
    } : {}),
    ...({ regionAnchor: [anchor.x, anchor.y, anchor.z] } as any),
  };
  return { geo, edgeGeo, virtualFace };
}

/** Eğri yüz adayı: vurgu yüzün tamamı; VF `curved`. Panel yüzün içe kalınlaştırılmışı; bölge çözülmez, katı düzeyinde sıraya göre kesişir. */
export function buildCurvedFacePreview(
  clickWorld: THREE.Vector3, group: CoplanarFaceGroup, faces: FaceData[], worldToLocal: THREE.Matrix4, shapeId: string, geometry?: THREE.BufferGeometry,
): PendingPreview | null {
  const clickLocal = clickWorld.clone().applyMatrix4(worldToLocal);
  const nrm = group.normal.clone().normalize();
  const contour = computeFaceComponentContour(faces, group.faceIndices, clickLocal, nrm);
  if (!contour) return null;
  const epos: number[] = [];
  for (const e of contour.boundary) epos.push(e.a.x, e.a.y, e.a.z, e.b.x, e.b.y, e.b.z);
  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(epos), 3));
  const seed = faces[contour.seedFi].center;
  const virtualFace: VirtualFace = {
    id: genId('vf'), shapeId, curved: true,
    normal: [nrm.x, nrm.y, nrm.z], center: [seed.x, seed.y, seed.z],
    vertices: contour.corners.map(c => [c.x, c.y, c.z] as [number, number, number]),
    description: '', hasPanel: false, parentFaceShape: true, touchingSiblingIds: [], sideRelations: {},
    faceGroupDescriptor: geometry ? createFaceDescriptor(faces[contour.seedFi], geometry) : undefined,
  };
  return { geo: createFaceHighlightGeometry(faces, contour.comp), edgeGeo, virtualFace };
}

const RAYCAST_COLORS = {
  previewFill: SEL_COLORS.active, previewEdge: SEL_COLORS.edge, hoverEmpty: SEL_COLORS.hover, hoverHasVF: SEL_COLORS.muted, vfFill: 0x38bdf8, vfEdge: 0x0369a1,
};

function buildSurfaceMeshes(vf: VirtualFace): { geo: THREE.BufferGeometry; edgeGeo: THREE.BufferGeometry } | null {
  if (vf.vertices.length < 3) return null;
  const corners = vf.vertices.map(v => new THREE.Vector3(v[0], v[1], v[2]));
  const normal = new THREE.Vector3(...vf.normal).normalize();
  const { u: uAxis, v: vAxis } = getFacePlaneAxes(normal);
  const origin = corners[0];
  const projected2D = corners.map(c => { const d = new THREE.Vector3().subVectors(c, origin); return { x: d.dot(uAxis), y: d.dot(vAxis) }; });
  let area = 0;
  for (let i = 0; i < projected2D.length; i++) {
    const a = projected2D[i], b = projected2D[(i + 1) % projected2D.length];
    area += a.x * b.y - b.x * a.y;
  }
  if (area < 0) { projected2D.reverse(); corners.reverse(); }
  const triIndices = earClipTriangulate(projected2D);
  const positions = new Float32Array(triIndices.length * 3);
  triIndices.forEach((ti, i) => corners[ti].toArray(positions, i * 3));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  const edgeVerts: number[] = [];
  corners.forEach((a, i) => { const b = corners[(i + 1) % corners.length]; edgeVerts.push(a.x, a.y, a.z, b.x, b.y, b.z); });
  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(edgeVerts), 3));
  return { geo, edgeGeo };
}

const LEG_COLORS = { selected: '#c2410c' } as const;

export const VirtualFaceOverlay: React.FC<{ shape: any }> = ({ shape }) => {
  const { virtualFaces, setSelectedPanelRow, panelSelectMode } = useStoreFields('virtualFaces', 'setSelectedPanelRow', 'panelSelectMode');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const shapeFaces = useMemo(() => virtualFaces.filter(f => f.shapeId === shape.id && !f.hasPanel && !f.plinthId), [virtualFaces, shape.id]);
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

/** Gövde paneli değil: iç panel (raf/dikme), kapak ya da arkalık. */
const isSpecialPanel = (p: any) => isInteriorPanel(p) || isDoorPanel(p) || isBackPanel(p);
type FaceCandidate = { index: number; depth: number; hitPoint: THREE.Vector3; stack?: StackSpec };

export const FaceRaycastOverlay: React.FC<{ shape: any; allShapes?: any[] }> = ({ shape, allShapes = [] }) => {
  const { raycastMode, virtualFaces, setSelectedPanelRow, setRaycastPendingVf, plinthSets } = useStoreFields('raycastMode', 'virtualFaces', 'setSelectedPanelRow',
    'setRaycastPendingVf', 'plinthSets');
  const [hoveredGroupIndex, setHoveredGroupIndex] = useState<number | null>(null);
  /** Fare bir panelin ÜZERİNDEYKEN (yüz orada panelle örtülü) o panel vurgulanır; tık o yüzün en yakın boşluğunu aday yapar. */
  const [hoverCover, setHoverCover] = useState<{ id: string; geometry: THREE.BufferGeometry } | null>(null);
  const hoverProbeRef = useRef<{ gi: number; point: THREE.Vector3 } | null>(null);
  const [pending, setPending] = useState<PendingPreview | null>(null);
  const lastClickRef = useRef<{ point: THREE.Vector3; groupIndex: number; cycleIndex: number } | null>(null);
  const shapeVirtualFaces = useMemo(() => virtualFaces.filter(vf => vf.shapeId === shape.id && !vf.plinthId), [virtualFaces, shape.id]);
  const vertexModsKeyStr = JSON.stringify(shape.vertexModifications || []);
  const effGeometry = useMemo(() => effectiveBodyGeometry(shape), [shape.geometry, shape.geometry?.uuid, vertexModsKeyStr]);
  const { localToWorld, worldToLocal } = useShapeMatrices(shape);
  const normalMatrix = useMemo(() => new THREE.Matrix3().getNormalMatrix(localToWorld), [localToWorld]);
  const { faces, groups: faceGroups } = useFaceGroups(effGeometry, () => { setPending(null); lastClickRef.current = null; });
  useEffect(() => {
    if (raycastMode) return;
    setHoveredGroupIndex(null); setHoverCover(null); hoverProbeRef.current = null; setPending(null); lastClickRef.current = null;
  }, [raycastMode]);
  useEffect(() => { setRaycastPendingVf(pending ? pending.virtualFace : null); }, [pending]);
  // İç paneller de girer (yeni panel sırada SONRA → mevcutlar onu basar); kapaklar/arkalıklar engel değildir.
  const childPanels = useMemo(() => childPanelsOf(shape.id, allShapes).filter(p => !isDoorPanel(p) && !isBackPanel(p)), [allShapes, shape.id]);
  // Bölge önizlemesi: iç arkalık parçaları da basar (yeni panel sırada en sonda → arkalığa kadar yerleşir; motorla aynı kural).
  const regionSiblings = useMemo(() => [
    ...childPanels, ...childPanelsOf(shape.id, allShapes).filter(isBackPanel).map(backPreviewStamp).filter((x): x is NonNullable<typeof x> => !!x),
  ], [childPanels, allShapes, shape.id]);
  // Arkalığın önü: arkalık parçaları + önlerine yığılabilen gövde panelleri (katmanlar).
  const backPanels = useMemo(() => childPanelsOf(shape.id, allShapes).filter(isBackPanel), [allShapes, shape.id]);
  const stackLayers = useMemo(() => childPanels.filter(p => !isSpecialPanel(p) && !panelHasRotation(p)), [childPanels]);
  const groupHasVirtualFace = useCallback((gi: number): boolean => {
    if (gi < 0 || gi >= faceGroups.length || shapeVirtualFaces.length === 0) return false;
    const gn = faceGroups[gi].normal.clone().normalize(), gc = faceGroups[gi].center;
    return shapeVirtualFaces.some(vf => Math.abs(gn.dot(new THREE.Vector3(...vf.normal).normalize())) >= 0.98
      && Math.abs(new THREE.Vector3(...vf.center).sub(gc).dot(gn)) < 2);
  }, [faceGroups, shapeVirtualFaces]);
  const hoverHighlightGeometry = useMemo(() => groupHighlight(faces, faceGroups, hoveredGroupIndex), [hoveredGroupIndex, faceGroups, faces]);
  const localNormalOf = (gi: number) => faceGroups[gi].normal.clone().normalize();
  const worldNormalOf = (gi: number) => localNormalOf(gi).applyMatrix3(normalMatrix).normalize();
  const inGroup = (fis: number[], fcs: FaceData[], p: THREE.Vector3, toWorld?: THREE.Matrix4) => fis.some(fi => {
    const f = fcs[fi];
    if (!f) return false;
    const [a, b, c] = toWorld ? f.vertices.map(v => v.clone().applyMatrix4(toWorld)) : f.vertices;
    return pointInTriangle3D(p, a, b, c);
  });
  /* Panel üstünden yerleştirme: örtülü vuruşta yüzün tıklanan noktaya en yakın boş noktası tohum olur; yüz doluysa aday yok. */
  const nearestFreePointOnGroup = (gi: number, hitWorld: THREE.Vector3, nW: THREE.Vector3): THREE.Vector3 | null => {
    const group = faceGroups[gi]; if (!group) return null;
    const nL = group.normal.clone().normalize();
    const { u, v } = getFacePlaneAxes(nL);
    const verts = group.faceIndices.flatMap(fi => faces[fi]?.vertices ?? []);
    if (!verts.length) return null;
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const p of verts) {
      const a = p.dot(u), b = p.dot(v);
      if (a < uMin) uMin = a; if (a > uMax) uMax = a; if (b < vMin) vMin = b; if (b > vMax) vMax = b;
    }
    const planeN = verts[0].dot(nL);
    const N = 28, du = (uMax - uMin) / N, dv = (vMax - vMin) / N;
    if (!(du > 0.01) || !(dv > 0.01)) return null;
    let best: THREE.Vector3 | null = null, bestD = Infinity;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const pl = new THREE.Vector3().addScaledVector(u, uMin + (i + 0.5) * du).addScaledVector(v, vMin + (j + 0.5) * dv).addScaledVector(nL, planeN);
      const pw = pl.clone().applyMatrix4(localToWorld);
      const d = pw.distanceTo(hitWorld);
      if (d >= bestD) continue;
      if (!inGroup(group.faceIndices, faces, pl)) continue;
      // Kanallı arkalığın arkası boşluk değildir (panel arkalığın içine girerdi).
      if (backPanels.length && backStackAt(nL, pl, backPanels, [])) continue;
      if (findPanelCoveringPoint(pw, childPanels, nW, pw)) continue;
      best = pw; bestD = d;
    }
    return best;
  };
  const handlePointerMove = (e: any) => {
    if (!raycastMode || faces.length === 0) return;
    e.stopPropagation();
    const gi = groupIndexOfFace(faceGroups, e.faceIndex);
    if (gi === -1) return;
    setHoveredGroupIndex(gi);
    // Örten panel vurgusu: yüz ya da nokta (≥ 8 mm) değişince yeniden bakılır.
    const pt: THREE.Vector3 = e.point.clone();
    const prev = hoverProbeRef.current;
    if (prev && prev.gi === gi && prev.point.distanceTo(pt) < 8) return;
    hoverProbeRef.current = { gi, point: pt };
    const cover = findPanelCoveringPoint(pt, childPanels, worldNormalOf(gi), pt)
      ?? (backPanels.length ? backStackAt(localNormalOf(gi), pt.clone().applyMatrix4(worldToLocal), backPanels, stackLayers)?.base : null) ?? null;
    setHoverCover(prevC => (!cover ? null
      : prevC && prevC.id === cover.id && prevC.geometry === cover.geometry ? prevC : { id: cover.id, geometry: cover.geometry }));
  };
  // Örten panelin önüne panel: o yüzdeki dönmemiş gövde paneli; derinlik = üst üste duran tüm panellerin en içteki yüzü.
  const stackSpecFor = (cover: any, gi: number, hitWorld: THREE.Vector3): StackSpec | undefined => {
    if (!cover || isSpecialPanel(cover)) return undefined;
    if (panelHasRotation(cover)) {
      const cvf = vfOfPanel(cover); if (!cvf) return undefined;
      const inner = panelInnerBigFace(cover, hitWorld.clone().applyMatrix4(worldToLocal).addScaledVector(localNormalOf(gi), -200));
      if (!inner) return undefined;
      return { depth: 0, baseVfId: cvf.id, basePanelId: cover.id, onPanel: cover, face: inner.group };
    }
    const nL = localNormalOf(gi);
    const k = Math.abs(nL.x) > 0.9 ? 'x' : Math.abs(nL.y) > 0.9 ? 'y' : 'z';
    const hitL = hitWorld.clone().applyMatrix4(worldToLocal);
    const plane = hitL[k];
    let depth = 0, top: any = null;
    for (const p of childPanels) {
      if (isSpecialPanel(p) || panelHasRotation(p)) continue;
      const pvf = vfOfPanel(p); if (!pvf || new THREE.Vector3(...pvf.normal).normalize().dot(nL) < 0.95) continue;
      const bb = localBboxOf(p.geometry); if (!bb) continue;
      const inside = (['x', 'y', 'z'] as const).every(a => a === k || (hitL[a] >= bb.min[a] - 0.5 && hitL[a] <= bb.max[a] + 0.5));
      if (!inside) continue;
      const d = Math.abs((nL[k] < 0 ? bb.max[k] : bb.min[k]) - plane);
      if (d > depth) { depth = d; top = p; }
    }
    const tvf = top ? vfOfPanel(top) : undefined;
    return depth > 0.5 && top && tvf ? { depth, baseVfId: tvf.id, basePanelId: top.id } : undefined;
  };
  /** Ayağın üstü: ışın baza setinin üst düzlemini kesiyorsa derinlik döngüsüne aday eklenir (alt yüz setin üstüne kaydırılmış). */
  const bodySets = useMemo(() => plinthSetsOf(shape.id, plinthSets), [plinthSets, shape.id]);
  const plinthTopHits = (cameraPos: THREE.Vector3, clickPoint: THREE.Vector3): FaceCandidate[] => {
    if (!bodySets.length) return [];
    // Alt yüz grubu (normal −Y); çentikli gövdede set merkezine en yakın
    const bottoms = faceGroups.map((g, i) => ({ g, i })).filter(x => x.g.normal.clone().normalize().y < -0.95);
    if (!bottoms.length) return [];
    const rayDir = clickPoint.clone().sub(cameraPos).normalize();
    const oL = cameraPos.clone().applyMatrix4(worldToLocal);
    const dL = clickPoint.clone().applyMatrix4(worldToLocal).sub(oL).normalize();
    const out: FaceCandidate[] = [];
    for (const ps of bodySets) {
      const b = plinthBoxOf(ps);
      const depth = b.max[1] - b.min[1];
      if (!(depth > 0.5) || Math.abs(dL.y) < 1e-6) continue;
      const tL = (b.max[1] - oL.y) / dL.y; if (tL < 0) continue;
      const hL = oL.clone().addScaledVector(dL, tL);
      // Setin üstü bölge şeklindedir (L / çentik): vuruş bölge kutularından birinin x/z kapsamında olmalı
      if (!plinthBoxesOf(ps).some(rb => hL.x >= rb.min[0] - 0.5 && hL.x <= rb.max[0] + 0.5 && hL.z >= rb.min[2] - 0.5 && hL.z <= rb.max[2] + 0.5)) continue;
      const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
      const gi = bottoms.reduce((best, x) => (Math.hypot(x.g.center.x - cx, x.g.center.z - cz) < Math.hypot(best.g.center.x - cx, best.g.center.z - cz) ? x : best)).i;
      const hitW = hL.clone().applyMatrix4(localToWorld);
      // Önizleme noktası alt yüzün düzleminde (buildFacePreview stack.depth kadar içeri kaydırır)
      const onFace = new THREE.Vector3(hL.x, b.min[1], hL.z).applyMatrix4(localToWorld);
      out.push({ index: gi, depth: hitW.clone().sub(cameraPos).dot(rayDir), hitPoint: onFace,
        stack: { depth, baseVfId: ps.vfId, basePanelId: `plinth-${ps.id}`, onPlinth: ps.id } });
    }
    return out;
  };
  /** Arkalığın önü: noktanın arkasında kanallı arkalık varsa önüne panel isteği; örtülü nokta gibi davranır. */
  const backSpecAt = (gi: number, hitWorld: THREE.Vector3): StackSpec | undefined => {
    if (!backPanels.length) return undefined;
    const hit = backStackAt(localNormalOf(gi), hitWorld.clone().applyMatrix4(worldToLocal), backPanels, stackLayers);
    const bvf = hit ? vfOfPanel(hit.base) : undefined;
    return hit && bvf ? { depth: hit.depth, baseVfId: bvf.id, basePanelId: hit.base.id, onBack: true } : undefined;
  };
  // Eğimli panelin kendi yüzleri: ışın dönmüş gövde panellerinin iki büyük yüzüyle de kesiştirilir (derinlik sırasına girer).
  const rotatedFaceHits = (cameraPos: THREE.Vector3, clickPoint: THREE.Vector3) => {
    const hits: Array<FaceCandidate & { stack: StackSpec }> = [];
    const rayLocalO = cameraPos.clone().applyMatrix4(worldToLocal);
    const rayLocalD = clickPoint.clone().sub(cameraPos).normalize().transformDirection(worldToLocal).normalize();
    for (const p of childPanels) {
      if (isSpecialPanel(p) || !panelHasRotation(p) || !p.geometry) continue;
      const pvf = vfOfPanel(p); if (!pvf) continue;
      const nVf = new THREE.Vector3(...pvf.normal).normalize();
      // Taban VF'sinin gövde yüzü (descriptor için)
      let gi = -1, best = Infinity;
      faceGroups.forEach((g, i) => {
        if (!(g.normal.clone().normalize().dot(nVf) > 0.95)) return;
        const d = g.center.distanceTo(new THREE.Vector3(...pvf.center));
        if (d < best) { best = d; gi = i; }
      });
      if (gi < 0) continue;
      const { faces: pf, groups: pg } = getFacesAndGroups(p.geometry);
      const big = [...pg].filter(g => !g.isCurved).sort((a, b) => b.totalArea - a.totalArea).slice(0, 2);
      for (const g of big) {
        const n = g.normal.clone().normalize();
        const den = n.dot(rayLocalD); if (Math.abs(den) < 1e-6) continue;
        const t = g.center.clone().sub(rayLocalO).dot(n) / den; if (t < 0) continue;
        const hitL = rayLocalO.clone().addScaledVector(rayLocalD, t);
        if (!inGroup(g.faceIndices, pf, hitL)) continue;
        // Yalnız ışına BAKAN yüz (arka yüz aynı panelin öbür tarafı; o da kendi vuruşuyla gelir)
        if (den > 0) continue;
        const stack = { depth: 0, baseVfId: pvf.id, basePanelId: p.id, onPanel: p, face: g };
        hits.push({ index: gi, depth: t, hitPoint: hitL.clone().applyMatrix4(localToWorld), stack });
      }
    }
    return hits;
  };
  // Derinlik döngüsü adayları: panel izi altındaki gruplarda o panelin önü + yüzün en yakın boşluğu; boşluklar geçerli hedeftir.
  const depthCandidates = (cameraPos: THREE.Vector3, clickPoint: THREE.Vector3, rotHits: Array<FaceCandidate & { stack: StackSpec }>) => {
    const rayDir = clickPoint.clone().sub(cameraPos).normalize();
    const out: FaceCandidate[] = [...rotHits, ...plinthTopHits(cameraPos, clickPoint)];
    for (let gi = 0; gi < faceGroups.length; gi++) {
      const group = faceGroups[gi];
      if (group.isCurved) continue;   // eğri yüzün düzlemi yoktur; doğrudan tıklanır (handlePointerDown)
      const nW = worldNormalOf(gi);
      const denom = nW.dot(rayDir);
      if (Math.abs(denom) < 1e-6) continue;
      const t = group.center.clone().applyMatrix4(localToWorld).sub(cameraPos).dot(nW) / denom;
      if (t < 0) continue;
      const hitOnPlane = cameraPos.clone().addScaledVector(rayDir, t);
      if (!inGroup(group.faceIndices, faces, hitOnPlane, localToWorld)) continue;
      const cover = findPanelCoveringPoint(hitOnPlane, childPanels, nW, hitOnPlane);
      if (!cover) {
        const bst = backSpecAt(gi, hitOnPlane);
        if (!bst) { out.push({ index: gi, depth: t, hitPoint: hitOnPlane }); continue; }
        out.push({ index: gi, depth: t, hitPoint: hitOnPlane, stack: bst });
        const freeB = nearestFreePointOnGroup(gi, hitOnPlane, nW);
        if (freeB) out.push({ index: gi, depth: t + 0.01, hitPoint: freeB });
        continue;
      }
      const st = stackSpecFor(cover, gi, hitOnPlane);
      // Eğimli örten panelin yüzleri ışın kesişiminden (rotHits) zaten adaydır; aynı yüz iki kez eklenmez.
      if (st && !(st.onPanel && rotHits.some(h => h.stack.basePanelId === st.basePanelId))) out.push({ index: gi, depth: t, hitPoint: hitOnPlane, stack: st });
      const free = nearestFreePointOnGroup(gi, hitOnPlane, nW);
      if (free) out.push({ index: gi, depth: t + 0.01, hitPoint: free });
    }
    return out.sort((a, b) => a.depth - b.depth);
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
    // EĞRİ YÜZ (radüs): yüzün tamamı tek adaydır; o yüzde zaten eğri panel varsa satırı seçilir.
    const hovered = faceGroups[hoveredGroupIndex];
    if (hovered.isCurved) {
      const own = shapeVirtualFaces.find(vf => vf.curved
        && matchCurvedFaceGroup(new THREE.Vector3(...vf.center), new THREE.Vector3(...vf.normal).normalize(), faces, faceGroups)?.group === hovered);
      if (own) { setSelectedPanelRow(`vf-${own.id}`, shape.id); return; }
      lastClickRef.current = { point: clickLocal, groupIndex: hoveredGroupIndex, cycleIndex: 0 };
      setPending(buildCurvedFacePreview(clickPoint, hovered, faces, worldToLocal, shape.id, effGeometry));
      return;
    }
    const isSameSpot = lastClickRef.current && lastClickRef.current.point.distanceTo(clickLocal) < 5;
    // Nokta değen bir panelin GÜNCEL ayak izi içindeyse yüz orada "tanımlı"dır; aradaki boşluk serbesttir.
    const coveringPanel = findPanelCoveringPoint(clickPoint, childPanels, worldNormalOf(hoveredGroupIndex), clickPoint);
    const hoveredIsDefined = coveringPanel !== null;
    // Kanallı arkalığın arkasına tık da örtülü sayılır: ilk tıkta adaylar (arkalığın önü → boşluk) gelir.
    const hoveredUnderBack = !hoveredIsDefined && !!backSpecAt(hoveredGroupIndex, clickPoint);
    let targetGroupIndex = hoveredGroupIndex;
    let previewClickPoint = clickPoint;
    let previewStack: StackSpec | undefined;
    const cameraPos = e.camera?.position?.clone();
    const rotHits = cameraPos ? rotatedFaceHits(cameraPos, clickPoint) : [];
    const cycleCandidates = cameraPos && (isSameSpot || hoveredIsDefined || hoveredUnderBack || rotHits.length > 0)
      ? depthCandidates(cameraPos, clickPoint, rotHits) : null;
    if (cycleCandidates && cycleCandidates.length > 0) {
      // Aynı noktaya tekrar tık adayları döndürür — örtülü noktada da (panelin önü → o yüzün boşluğu → arkadaki yüzler).
      const next = isSameSpot ? (lastClickRef.current!.cycleIndex + 1) % cycleCandidates.length : 0;
      targetGroupIndex = cycleCandidates[next].index;
      previewClickPoint = cycleCandidates[next].hitPoint;
      previewStack = cycleCandidates[next].stack;
      lastClickRef.current = { point: clickLocal, groupIndex: targetGroupIndex, cycleIndex: next };
    } else if (hoveredIsDefined) {
      const vfId = coveringPanel?.parameters?.virtualFaceId;
      if (vfId) setSelectedPanelRow(`vf-${vfId}`, shape.id);
      return;
    } else {
      lastClickRef.current = { point: clickLocal, groupIndex: targetGroupIndex, cycleIndex: 0 };
    }
    setHoveredGroupIndex(targetGroupIndex);
    setPending(buildFacePreview(previewClickPoint, faceGroups[targetGroupIndex], faces, worldToLocal, shape.id, effGeometry, regionSiblings, previewStack));
  };
  if (!raycastMode) return null;
  const hoverColor = hoveredGroupIndex !== null && groupHasVirtualFace(hoveredGroupIndex) ? RAYCAST_COLORS.hoverHasVF : RAYCAST_COLORS.hoverEmpty;
  return (
    <>
      <mesh geometry={effGeometry} visible={false} onPointerMove={handlePointerMove} onPointerDown={handlePointerDown}
        onPointerOut={(e) => { e.stopPropagation(); setHoveredGroupIndex(null); setHoverCover(null); hoverProbeRef.current = null; }} />
      {hoverCover && !pending && (
        <mesh geometry={hoverCover.geometry} raycast={noRaycast}>
          {highlightMat(RAYCAST_COLORS.hoverEmpty, SEL_COLORS.faceHoverOpacity, -1, true)}
        </mesh>
      )}
      {hoverHighlightGeometry && (
        <mesh geometry={hoverHighlightGeometry} raycast={noRaycast}>{highlightMat(hoverColor, SEL_COLORS.faceHoverOpacity, -1, true)}</mesh>
      )}
      {pending && (
        <>
          <mesh geometry={pending.geo} raycast={noRaycast}>{highlightMat(RAYCAST_COLORS.previewFill, SEL_COLORS.faceActiveOpacity)}</mesh>
          <lineSegments geometry={pending.edgeGeo} raycast={noRaycast}>
            <lineBasicMaterial color={RAYCAST_COLORS.previewEdge} depthTest={false} transparent opacity={0.9} />
          </lineSegments>
        </>
      )}
    </>
  );
};

export const FaceEditor: React.FC<{ shape: any }> = ({ shape }) => {
  const { filletMode, selectedFilletFaces, addFilletFace, addFilletFaceData } = useStoreFields('filletMode', 'selectedFilletFaces', 'addFilletFace',
    'addFilletFaceData');
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
    : selectedFilletFaces.map(gi => groupHighlight(faces, faceGroups, gi)).filter((g): g is THREE.BufferGeometry => !!g),
  [filletMode, selectedFilletFaces, faceGroups, faces]);
  const highlightGeometry = useMemo(() => groupHighlight(faces, faceGroups, hoveredGroupIndex), [hoveredGroupIndex, faceGroups, faces]);
  const boundaryEdgesGeometry = useMemo(() => (faces.length === 0 || faceGroups.length === 0) ? null : createGroupBoundaryEdges(faces, faceGroups),
    [faces, faceGroups]);
  return (
    <>
      <mesh geometry={shape.geometry} visible={false} onPointerMove={handlePointerMove} onPointerOut={(e) => { e.stopPropagation(); setHoveredGroupIndex(null); }}
        onPointerDown={(e) => { e.stopPropagation(); if (e.button === 2 && hoveredGroupIndex !== null) handleFaceSelection(hoveredGroupIndex); }} />
      {selectedFilletGeometries.map((geom, idx) => (
        <mesh key={`selected-${idx}`} geometry={geom}>{highlightMat(SEL_COLORS.active, SEL_COLORS.faceActiveOpacity)}</mesh>
      ))}
      {highlightGeometry && !selectedFilletFaces.includes(hoveredGroupIndex!) && (
        <mesh geometry={highlightGeometry}>{highlightMat(SEL_COLORS.hover, SEL_COLORS.faceHoverOpacity)}</mesh>
      )}
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
  const geo = useMemo(() => {
    if (!shape.geometry) return null;
    const { faces, groups } = getFacesAndGroups(shape.geometry);
    return createGroupBoundaryEdges(faces, groups);
  }, [shape.geometry]);
  if (!geo) return null;
  return (
    <lineSegments geometry={geo}>
      <lineBasicMaterial color="#000000" linewidth={2} opacity={1} transparent={false} depthTest={true} />
    </lineSegments>
  );
};

// Hacim seçme: ışın gövde kutusunu hücre hücre yürür. Sol tık aynı ışındaki adaylarda döner; sağ tık / ✓ oluşturur.
const PICK_COLORS = { hover: SEL_COLORS.hover, selected: SEL_COLORS.active, selectedEdge: SEL_COLORS.volumeEdge, currentEdge: '#78716c' };

function surfaceMesh(surface: number[]): { geo: THREE.BufferGeometry; edgePts: [number, number, number][] } {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(surface), 3));
  return { geo, edgePts: edgePointsOf(geo, 1) };
}

// Gerçek şekil önizlemesi: kutu önizleme hemen çizilir, OCC ile kesilmiş şekil (refinedVolumeSurface / refinedSlabSurface) gelince
// yerini alır; düz kutuda motor null döner. Sonuç anahtarla saklanır.
const _refinedCache = new Map<string, Float32Array | null>();
function useRefinedSoup(key: string | null, build: () => Promise<Float32Array | null>, delayMs = 0): Float32Array | null {
  const [, bump] = useState(0);
  const buildRef = useRef(build);
  buildRef.current = build;
  useEffect(() => {
    if (!key || _refinedCache.has(key)) return;
    let live = true;
    const h = setTimeout(() => {
      buildRef.current().catch(() => null).then(v => {
        if (_refinedCache.size > 48) _refinedCache.delete(_refinedCache.keys().next().value as string);
        _refinedCache.set(key, v ?? null);
        if (live) bump(x => x + 1);
      });
    }, delayMs);
    return () => { live = false; clearTimeout(h); };
  }, [key, delayMs]);
  return key ? _refinedCache.get(key) ?? null : null;
}
/** Üçgen çorbası → mesh + kenar çizgileri (eğri yüzün faset kenarları çizilmez). */
function soupMesh(soup: Float32Array): { geo: THREE.BufferGeometry; edgePts: [number, number, number][] } {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(soup, 3));
  geo.computeVertexNormals();
  return { geo, edgePts: edgePointsOf(geo, 20) };
}
const panelsStamp = (shapeId: string, shapes: any[]) => childPanelsOf(shapeId, shapes).map(p => p.geometry?.uuid ?? '').join(',');

/** Yön oku: hacmin dışında, hacme bakar; ekranda minPx..maxPx. Derinlik tamponu okun öncesinde temizlenir (her şeyin üstünde). */
const FACING_ARROW = { edge: '#7f1d1d', lengthMm: 108, minPx: 43, maxPx: 80, tiltRad: 0.5, gapFrac: 0.2, shaftLen: 0.62 } as const;

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

export const FacingArrow: React.FC<{ box: { min: Vec3; max: Vec3 }; axis: 0 | 1 | 2; facing: 1 | -1; label?: string }> = ({ box, axis, facing, label }) => {
  const ref = useRef<THREE.Group>(null);
  const faceCenter = useMemo<Vec3>(() => {
    const c = boxCenter(box); c[axis] = facing > 0 ? box.min[axis] : box.max[axis]; return c;
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
      <mesh geometry={FACING_ARROW_GEO} raycast={noRaycast} renderOrder={30} frustumCulled={false} onBeforeRender={(r: THREE.WebGLRenderer) => r.clearDepth()}>
        <meshBasicMaterial vertexColors transparent opacity={1} depthTest depthWrite polygonOffset polygonOffsetFactor={1} polygonOffsetUnits={1} />
      </mesh>
      <lineSegments geometry={FACING_ARROW_EDGES} raycast={noRaycast} renderOrder={31} frustumCulled={false}>
        <lineBasicMaterial color={FACING_ARROW.edge} transparent opacity={0.9} depthTest depthWrite={false} />
      </lineSegments>
      {label && (
        <Html position={[-(FACING_ARROW.gapFrac + FACING_ARROW.shaftLen + 0.55), 0, 0]} center zIndexRange={[999, 1000]} style={{ pointerEvents: 'none' }}>
          <div style={{
            fontFamily: FONT, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#ffffff', background: '#b91c1c',
            padding: '2px 7px', borderRadius: 5, whiteSpace: 'nowrap', boxShadow: '0 1px 3px rgba(40,30,20,0.25)',
          }}>{label}</div>
        </Html>
      )}
    </group>
  );
};


/** Görünmez seçim kutusu: gövde kutusundan her yönde 1 mm büyük (açık yüzlerde de olayları alır). */
const pickBoxGeometry = (b: { min: Vec3; max: Vec3 }) => {
  const g = new THREE.BoxGeometry(b.max[0] - b.min[0] + 2, b.max[1] - b.min[1] + 2, b.max[2] - b.min[2] + 2);
  g.translate(...boxCenter(b));
  return g;
};
/** Olay ışını şeklin yerel uzayında. */
const localRay = (e: any, worldToLocal: THREE.Matrix4): [Vec3, Vec3] => {
  const o = e.ray.origin.clone().applyMatrix4(worldToLocal);
  const d = e.ray.origin.clone().add(e.ray.direction).applyMatrix4(worldToLocal).sub(o).normalize();
  return [[o.x, o.y, o.z], [d.x, d.y, d.z]];
};
type PickCycle<P> = { hoverPick: P | null; setHoverPick: (p: P | null) => void; onPointerMove: (e: any) => void; onPointerDown: (e: any) => void };
/** Aday döngüsü (hacim / kapak / arkalık seçme): hover ilk adayı önizler; sol tık aynı aday kümesinde sıradakine geçer, sağ tık onaylar. */
function usePickCycle<P extends { key: string }>(active: boolean, fromEvent: (e: any) => P[], setPick: (c: P[], i: number) => void, confirm: () => void)
  : PickCycle<P> {
  const [hoverPick, setHoverPick] = useState<P | null>(null);
  const lastRef = useRef<{ keys: string; index: number } | null>(null);
  useEffect(() => { if (!active) { setHoverPick(null); lastRef.current = null; } }, [active]);
  const onPointerMove = (e: any) => {
    if (!active) return;
    e.stopPropagation();
    const first = fromEvent(e)[0] || null;
    setHoverPick(prev => (prev?.key === first?.key ? prev : first));
  };
  const onPointerDown = (e: any) => {
    if (!active) return;
    e.stopPropagation();
    if (e.button === 2) { confirm(); return; }
    if (e.button !== 0) return;
    const c = fromEvent(e);
    if (!c.length) { setPick([], 0); lastRef.current = null; return; }
    const keys = c.map(x => x.key).join(';');
    const index = lastRef.current && lastRef.current.keys === keys ? (lastRef.current.index + 1) % c.length : 0;
    lastRef.current = { keys, index };
    setPick(c, index);
  };
  return { hoverPick, setHoverPick, onPointerMove, onPointerDown };
}
const PickHitBox = ({ geometry, cycle }: { geometry: THREE.BufferGeometry; cycle: PickCycle<any> }) => (
  <mesh geometry={geometry} visible={false} onPointerMove={cycle.onPointerMove} onPointerOut={() => cycle.setHoverPick(null)}
    onPointerDown={cycle.onPointerDown} onContextMenu={stopEvent} />
);
const useDisposable = <T extends { dispose: () => void } | null | undefined>(x: T) => { useEffect(() => () => { x?.dispose(); }, [x]); };

export const VolumePickOverlay: React.FC<{ shape: any; allShapes: any[] }> = ({ shape, allShapes }) => {
  const { volumePickMode, volumePickGroupId, volumePickCandidates, volumePickIndex, setVolumePick, panelGroups } =
    useStoreFields('volumePickMode', 'volumePickGroupId', 'volumePickCandidates', 'volumePickIndex', 'setVolumePick', 'panelGroups');
  // Yeniden seçim: ızgara yalnız gruptan ÖNCEKİ panellerle kurulur (sonrakiler + üyeler engel değil).
  const repickGroup = useMemo(() => (volumePickGroupId ? panelGroups.find(g => g.id === volumePickGroupId) || null : null), [panelGroups, volumePickGroupId]);
  // Düz paneller kutu engeli; dönmüş/eğik paneller yarım-uzay. Yeni grup sırada en sonda: iç arkalık parçaları engeldir.
  const oset = useMemo(() => (repickGroup ? repickObstacles(repickGroup, shape, allShapes) : collectObstacles(shape, allShapes, () => true, backPickObstacle)),
    [allShapes, shape, repickGroup]);
  const grid = useMemo(() => (volumePickMode ? gridForObstacles(shape, oset) : null), [shape, oset, volumePickMode]);
  const currentMesh = useMemo(() => (repickGroup ? surfaceMesh(boxesSurface(repickGroup.region || [repickGroup.cavity])) : null), [repickGroup]);
  useDisposable(currentMesh?.geo);
  const { worldToLocal } = useShapeMatrices(shape);
  const pickGeo = useMemo(() => (grid ? pickBoxGeometry(grid.body) : null), [grid]);
  useDisposable(pickGeo);
  const selected = volumePickCandidates[volumePickIndex] || null;
  const cycle = usePickCycle<CavityPick>(!!volumePickMode,
    e => (grid && volumePickMode && e?.ray ? rayCavityCandidates(...localRay(e, worldToLocal), grid, GROUP_PANEL_THICKNESS * 2, volumePickMode) : []),
    setVolumePick, () => { if (selected) confirmVolumePick(shape.id, volumePickMode!, selected); });
  const { hoverPick } = cycle;
  const hoverIsSelected = !!hoverPick && !!selected && hoverPick.key === selected.key;
  // Gerçek şekil: bölge kutuları ∩ gövde − ızgaradaki eğri / eğik paneller.
  const cutIds = useMemo(() => [...(oset.solids ?? []).map(x => x.id), ...oset.tiltFaces.map(x => x.id)], [oset]);
  const refineKey = (p: CavityPick | null) => (p && volumePickMode
    ? `vol|${shape.geometry?.uuid}|${p.boxes.map(b => [...b.min, ...b.max].map(n => n.toFixed(1)).join(',')).join(';')}|${p.seed.map(n => n.toFixed(0)).join(',')}|${cutIds.map(id => shapeById(id, allShapes)?.geometry?.uuid ?? '').join(',')}`
    : null);
  const refine = (p: CavityPick | null) => async () => (p ? (await import('./PanelEngine')).refinedVolumeSurface(shape, p.boxes, p.seed, cutIds) : null);
  const selectedSoup = useRefinedSoup(refineKey(selected), refine(selected));
  const hoverSoup = useRefinedSoup(hoverIsSelected ? null : refineKey(hoverPick), refine(hoverPick), 180);
  const selectedMesh = useMemo(() => (selected ? (selectedSoup ? soupMesh(selectedSoup) : surfaceMesh(selected.surface)) : null), [selected, selectedSoup]);
  const hoverMesh = useMemo(() => (hoverPick ? (hoverSoup ? soupMesh(hoverSoup) : surfaceMesh(hoverPick.surface)) : null), [hoverPick, hoverSoup]);
  useDisposable(selectedMesh?.geo);
  useDisposable(hoverMesh?.geo);

  if (!volumePickMode || !pickGeo) return null;
  return (
    <>
      <PickHitBox geometry={pickGeo} cycle={cycle} />
      {currentMesh && currentMesh.edgePts.length >= 2 && (
        <Line points={currentMesh.edgePts} segments color={PICK_COLORS.currentEdge} lineWidth={1.2} transparent opacity={0.8} depthTest={false} depthWrite={false}
          renderOrder={4} raycast={noRaycast} />
      )}
      {hoverMesh && !hoverIsSelected && (
        <mesh geometry={hoverMesh.geo} raycast={noRaycast} renderOrder={5}><FillMat color={PICK_COLORS.hover} opacity={SEL_COLORS.volumeHoverOpacity} /></mesh>
      )}
      {selectedMesh && (
        <>
          <mesh geometry={selectedMesh.geo} raycast={noRaycast} renderOrder={6}>
            <FillMat color={PICK_COLORS.selected} opacity={SEL_COLORS.volumeActiveOpacity} />
          </mesh>
          {selectedMesh.edgePts.length >= 2 && <EdgeLines points={selectedMesh.edgePts} color={PICK_COLORS.selectedEdge} width={SEL_COLORS.edgeWidth} order={7} />}
          {selected && <FacingArrow box={selected.bbox} axis={selected.arrow.axis} facing={selected.arrow.facing} />}
        </>
      )}
    </>
  );
};

// Kapak / arkalık seçme: tıklanan yüz levha düzlemini verir; aday dönmüş sınır panelleriyle kırpılmış konveks çokgen prizması.
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
type SlabRefine = { key: string; build: () => Promise<Float32Array | null> };
type DoorSlabProps = { poly: DoorSlabPoly; thickness: number; fill: number; opacity: number; edge?: string; order: number; refine?: SlabRefine | null; delay?: number };
const DoorSlab: React.FC<DoorSlabProps> = ({ poly, thickness, fill, opacity, edge, order, refine, delay = 0 }) => {
  const key = polyKey(poly, thickness);
  // Şekilli gövdede levhanın gerçek şekli (kemeri izleyen kapak / arkalık) hazır olunca dikdörtgen prizmanın yerini alır.
  const soup = useRefinedSoup(refine ? `${refine.key}|${key}` : null, refine ? refine.build : async () => null, delay);
  const { geo, edges: pts } = useMemo(() => {
    if (!soup) return slabPrism(poly, thickness);
    const m = soupMesh(soup);
    return { geo: m.geo, edges: m.edgePts as Vec3[] };
  }, [key, soup]);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <>
      <mesh geometry={geo} raycast={noRaycast} renderOrder={order}><FillMat color={fill} opacity={opacity} /></mesh>
      {edge && <EdgeLines points={pts} color={edge} width={SEL_COLORS.edgeWidth} order={order + 1} />}
    </>
  );
};

type BodyBox = { min: Vec3; max: Vec3 };
type SlabPickProps<P extends { key: string }> = {
  shape: any; active: boolean; candidates: P[]; index: number; setPick: (c: P[], i: number) => void; thickness: number;
  /** Aday önizleme levhası; `deps` (yerleşim + kesimler) değişince yeniden kurulur. */
  slabOf: (c: P) => DoorSlabPoly; deps: [unknown, unknown];
  /** Şekilli gövdede adayın gerçek şekli (PanelEngine.refinedSlabSurface); anahtar adayın çokgeniyle tamamlanır. */
  refineOf?: (c: P, poly: DoorSlabPoly) => SlabRefine | null;
  /** Yerel ışın + gövde kutusu → adaylar (alan büyükten küçüğe). */
  candidatesAt: (o: Vec3, d: Vec3, body: BodyBox) => P[];
  confirm: (c: P) => void;
};
/** Kapak ve arkalık seçmenin ortak gövdesi: görünmez kutu olayları alır, her sol tık sıradaki adaya geçer, sağ tık yerleştirir. */
function SlabPickOverlay<P extends { key: string }>({ shape, active, candidates, index, setPick, thickness, slabOf, deps, candidatesAt, confirm, refineOf }: SlabPickProps<P>) {
  const { worldToLocal } = useShapeMatrices(shape);
  const body = useMemo((): BodyBox | null => {
    const bb = localBboxOf(effectiveBodyGeometry(shape));
    return bb ? { min: [bb.min.x, bb.min.y, bb.min.z], max: [bb.max.x, bb.max.y, bb.max.z] } : null;
  }, [shape.geometry, shape.vertexModifications]);
  const pickGeo = useMemo(() => (body ? pickBoxGeometry(body) : null), [body]);
  useDisposable(pickGeo);
  const selected = candidates[index] || null;
  const cycle = usePickCycle<P>(active, e => (body && active && e?.ray ? candidatesAt(...localRay(e, worldToLocal), body) : []), setPick,
    () => { if (selected) confirm(selected); });
  const selectedBox = useMemo(() => (selected ? slabOf(selected) : null), [selected, ...deps]);
  const hoverBox = useMemo(() => (cycle.hoverPick ? slabOf(cycle.hoverPick) : null), [cycle.hoverPick, ...deps]);
  if (!active || !pickGeo) return null;
  const hoverIsSelected = !!cycle.hoverPick && !!selected && cycle.hoverPick.key === selected.key;
  return (
    <>
      <PickHitBox geometry={pickGeo} cycle={cycle} />
      {hoverBox && !hoverIsSelected && (
        <DoorSlab poly={hoverBox} thickness={thickness} fill={PICK_COLORS.hover} opacity={SEL_COLORS.faceHoverOpacity * 0.6} order={5}
          refine={refineOf && cycle.hoverPick ? refineOf(cycle.hoverPick, hoverBox) : null} delay={180} />
      )}
      {selectedBox && (
        <DoorSlab poly={selectedBox} thickness={thickness} fill={PICK_COLORS.selected} opacity={SEL_COLORS.faceActiveOpacity * 0.7}
          edge={PICK_COLORS.selectedEdge} order={6} refine={refineOf && selected ? refineOf(selected, selectedBox) : null} />
      )}
    </>
  );
}
const grownBox = (b: BodyBox, m: number): BodyBox => ({
  min: [b.min[0] - m, b.min[1] - m, b.min[2] - m], max: [b.max[0] + m, b.max[1] + m, b.max[2] + m],
});

export const DoorPickOverlay: React.FC<{ shape: any }> = ({ shape }) => {
  const s = useStoreFields('doorPickMode', 'doorPickCandidates', 'doorPickIndex', 'setDoorPick', 'doorPickPlacement', 'shapes', 'virtualFaces');
  const { doorPickMode, doorPickPlacement: placement, shapes, virtualFaces } = s;
  const cuts = useMemo(() => (doorPickMode ? collectDoorCuts(shape, shapes, virtualFaces) : []), [doorPickMode, shape, shapes, virtualFaces]);
  return (
    <SlabPickOverlay shape={shape} active={doorPickMode} candidates={s.doorPickCandidates} index={s.doorPickIndex} setPick={s.setDoorPick}
      thickness={DOOR_THICKNESS} deps={[placement, cuts]} confirm={c => confirmDoorPick(shape.id, c)}
      refineOf={(c, poly) => ({
        key: `door|${shape.geometry?.uuid}|${placement}|${panelsStamp(shape.id, shapes)}`,
        build: async () => (await import('./PanelEngine')).refinedSlabSurface(shape, 'door', poly, DOOR_THICKNESS, c.axis, c.side, DOOR_GAP),
      })}
      slabOf={c => doorSlabPolygon(
        { axis: c.axis, side: c.side, placement, thickness: DOOR_THICKNESS, gap: DOOR_GAP, anchor: c.at }, pickRectFor(c, placement), cuts)}
      candidatesAt={(o, d, body) => {
        // Önce FRONT rolündeki yüzler (Parameters › Faces; L köşe dolabının çentik yüzü dahil), sonra gövde kutusunun girilen yüzü
        const entry = rayDoorEntry(o, d, grownBox(body, 1), bodyFacesByRole(shape, 'front'));
        return entry ? doorCandidatesAt(shape, entry.axis, entry.side, entry.point, shapes, virtualFaces, entry.faceBox) : [];
      }} />
  );
};

// ARKALIK SEÇME (BackService): kapak akışıyla aynı — tıklama gövdenin ARKA yüzüne taşınır (rayBackEntry).
export const BackPickOverlay: React.FC<{ shape: any }> = ({ shape }) => {
  const s = useStoreFields('backPickMode', 'backPickCandidates', 'backPickIndex', 'setBackPick', 'backPickPlacement', 'shapes', 'virtualFaces');
  const { backPickMode, backPickPlacement: placement, shapes, virtualFaces } = s;
  const cuts = useMemo(() => (backPickMode ? collectBackCuts(shape, shapes, virtualFaces) : []), [backPickMode, shape, shapes, virtualFaces]);
  return (
    <SlabPickOverlay shape={shape} active={backPickMode} candidates={s.backPickCandidates} index={s.backPickIndex} setPick={s.setBackPick}
      thickness={BACK_THICKNESS} deps={[placement, cuts]} confirm={c => confirmBackPick(shape.id, c)}
      refineOf={(c, poly) => ({
        key: `back|${shape.geometry?.uuid}|${placement}|${panelsStamp(shape.id, shapes)}`,
        build: async () => (await import('./PanelEngine')).refinedSlabSurface(shape, 'back', poly, BACK_THICKNESS, c.axis, c.side, 0),
      })}
      slabOf={c => backSlabPolygon(
        { axis: c.axis, side: c.side, placement, thickness: BACK_THICKNESS, gap: BACK_GAP, anchor: c.at }, backPickRect(c, placement), cuts)}
      candidatesAt={(o, d, body) => {
        // Tıklama REAR rolündeki yüze taşınır (Parameters › Faces); L gövdede iki rear yüz → hangisine tıklandıysa o
        const entry = rayBackEntry(o, d, body, bodyFacesByRole(shape, 'rear'));
        return entry ? backCandidatesAt(shape, entry.axis, entry.side, entry.point, shapes, virtualFaces, entry.bounds) : [];
      }} />
  );
};

// Hacim düzenleme: grubun şekilli hacmi çizilir; seçilen yüzün normali + tıklama noktası (çıpa) store'a yazılır.
export const CavityEditOverlay: React.FC<{ shape: any }> = ({ shape }) => {
  const S = useStoreFields('panelGroups', 'faceExtrudeCavityGroupId');
  const group = S.panelGroups.find(g => g.id === S.faceExtrudeCavityGroupId);
  const active = !!group && group.shapeId === shape.id;
  const cav = group?.cavity;
  const boxes = group ? (group.region && group.region.length ? group.region : cav ? [cav] : []) : [];
  return <BoxFacePickOverlay shape={shape} active={active} boxes={boxes} />;
};
// Baza seti hacim düzenleme (Volume): set kutusu — aynı yüz seçimi, yalnız Fixed / Dyn (şerit uygular).
export const PlinthEditOverlay: React.FC<{ shape: any }> = ({ shape }) => {
  const S = useStoreFields('plinthSets', 'faceExtrudePlinthId', 'shapes');
  const set = S.plinthSets.find(x => x.id === S.faceExtrudePlinthId);
  const active = !!set && set.shapeId === shape.id;
  // Bölge kutuları: L sette iki +X yüzü gibi ayrı düzlemler de seçilebilir; uygulanan ölçü kapsamın o eksenidir (applyPlinthFace)
  const boxes = useMemo(() => (set ? plinthBoxesOf(set, S.shapes) : []), [set, S.shapes]);
  return <BoxFacePickOverlay shape={shape} active={active} boxes={boxes} />;
};
/** Kutu yüzeyinin (bölge kutularının dış kabuğu) ağı — hacim / baza seti çizimi ve sahne oklarının yüzleri AYNI ağdan okunur (yüz indeksleri tutar). */
function boxSurfaceGeometry(boxes: Array<{ min: Vec3; max: Vec3 }>): THREE.BufferGeometry | null {
  const surface = boxes.length ? boxesSurface(boxes) : [];
  if (surface.length < 9) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(surface), 3));
  g.computeVertexNormals();
  return g;
}
const boxesKey = (boxes: Array<{ min: Vec3; max: Vec3 }>) => boxes.map(b => [...b.min, ...b.max].map(n => n.toFixed(1)).join('|')).join(';');
/** Düzenlenen hacmin / baza setinin çizimi + seçili yüzün vurgusu. Yüz, sahnedeki oklarla seçilir (VolumeSceneExtrude / PlinthSceneExtrude). */
const BoxFacePickOverlay: React.FC<{ shape: any; active: boolean; boxes: Array<{ min: Vec3; max: Vec3 }> }> = ({ active, boxes }) => {
  const selFace = useAppStore(st => st.faceExtrudeSelectedFace);
  const cavKey = boxesKey(boxes);
  const boxGeo = useMemo(() => boxSurfaceGeometry(boxes), [cavKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  useDisposable(boxGeo);
  const { faces, groups } = useMemo(() => (boxGeo ? getFacesAndGroups(boxGeo) : NO_FACES), [boxGeo]);
  const edgePts = useMemo(() => (boxGeo ? edgePointsOf(boxGeo, 1) : []), [boxGeo]);
  const selGeo = useMemo(() => groupHighlight(faces, groups, selFace), [selFace, groups, faces]);
  if (!active || !boxGeo) return null;
  return (
    <>
      <mesh geometry={boxGeo} raycast={noRaycast} renderOrder={5}><FillMat color={PICK_COLORS.selected} opacity={SEL_COLORS.volumeActiveOpacity} /></mesh>
      {edgePts.length >= 2 && <EdgeLines points={edgePts} color={PICK_COLORS.selectedEdge} width={SEL_COLORS.edgeWidth} order={7} />}
      {selGeo && (
        <>
          <OverlayMesh geometry={selGeo} order={12} color={SEL_COLORS.active} opacity={SEL_COLORS.faceActiveOpacity} />
          <FaceOutline geometry={selGeo} color={SEL_COLORS.edge} width={SEL_COLORS.extrudeEdgeWidth} />
        </>
      )}
    </>
  );
};

const EDGE_COLOR = PANEL_COLORS.edge.default;
type Xform = { position: Vec3; rotation: Vec3; scale: Vec3 };
const readXform = (o: THREE.Object3D): Xform => ({
  position: o.position.toArray() as Vec3, rotation: o.rotation.toArray().slice(0, 3) as Vec3, scale: o.scale.toArray() as Vec3,
});
const deltaOf = (from: Xform, to: Xform): XformDelta => ({
  pd: [0, 1, 2].map(i => to.position[i] - from.position[i]),
  rd: [0, 1, 2].map(i => to.rotation[i] - from.rotation[i]),
  sd: [0, 1, 2].map(i => to.scale[i] / from.scale[i]),
});

type SubtractionMeshProps = {
  subtraction: any; index: number; isHovered: boolean; isSubtractionSelected: boolean; isSelected: boolean;
  setHovered: (i: number | null) => void; setSelected: (i: number | null) => void;
};
const SubtractionMesh: React.FC<SubtractionMeshProps> =
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
          <meshStandardMaterial color={(isHovered || isSubtractionSelected) ? 0xff0000 : 0xffff00} transparent opacity={0.35} depthWrite={false}
            side={THREE.DoubleSide} />
        </mesh>
      </group>
    );
  });
SubtractionMesh.displayName = 'SubtractionMesh';

export const ShapeWithTransform: React.FC<{ shape: any; isSelected: boolean; orbitControlsRef: any }> = React.memo(({ shape, isSelected, orbitControlsRef }) => {
  const S = useStoreFields('selectShape', 'selectSecondaryShape', 'secondarySelectedShapeId', 'selectedShapeId', 'activeTool', 'viewMode',
    'subtractionViewMode', 'hoveredSubtractionIndex', 'setHoveredSubtractionIndex', 'selectedSubtractionIndex', 'setSelectedSubtractionIndex',
    'showOutlines', 'setSelectedPanelRow', 'panelSelectMode', 'faceEditMode', 'filletMode', 'raycastMode', 'shapes', 'faceExtrudeMode',
    'faceExtrudeValueMode', 'faceExtrudeTargetPanelId', 'faceExtrudeSelectedFace', 'faceExtrudeRefCandidate', 'setFaceExtrudeRefCandidate',
    'panelMoveMode', 'panelMoveValueMode', 'panelMoveRefSourceVertex', 'panelMoveRefTargetPanelId', 'panelRotateMode', 'volumePickMode',
    'faceExtrudeCavityGroupId', 'doorPickMode', 'backPickMode', 'plinthPickMode', 'faceExtrudePlinthId', 'faceRoleHover', 'showFaceRoles',
    'selectedPanelRow', 'selectedPanelGroupId', 'selectedDoorGroupId', 'selectedBackGroupId');
  const { scene } = useThree();
  const meshRef = useRef<THREE.Mesh>(null);
  const groupRef = useRef<THREE.Group>(null);
  const isUpdatingRef = useRef(false);
  const cleanupListenersRef = useRef<(() => void) | null>(null);
  const initialRef = useRef<{ self: Xform; childPanels: Map<string, Xform> } | null>(null);
  const [localGeometry, setLocalGeometry] = useState(shape.geometry);
  const [geometryKey, setGeometryKey] = useState(0);
  const [moveRefHover, setMoveRefHover] = useState(false);
  const draftIso = useDraft(st => st.isolate);
  const rp = useRefPick();
  // Gövde adımı düzenlenirken çizilen katı ADIMSIZ önizlemedir; depodaki gövde (ve panelleri) oturum boyunca değişmez.
  const draftPreview = useDraft(st => (st.bodyPreview && st.bodyPreview.shapeId === shape.id ? st.bodyPreview.geometry as THREE.BufferGeometry : null));
  const vertexModsString = useMemo(() => JSON.stringify(shape.vertexModifications || []), [shape.vertexModifications]);
  const { faces: refFaces, groups: refFaceGroups } = useMemo(() => (shape.geometry ? getFacesAndGroups(effectiveBodyGeometry(shape)) : { faces: [], groups: [] }),
    [shape.geometry, vertexModsString]);
  const drawGeometry = draftPreview ?? localGeometry;
  const edgePoints = useMemo(() => safeEdgePoints(drawGeometry, 5), [drawGeometry]);

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
        const snapshot = (p: Xform): Xform => ({ position: [...p.position] as Vec3, rotation: [...p.rotation] as Vec3, scale: [...p.scale] as Vec3 });
        initialRef.current = { self: readXform(groupRef.current), childPanels: new Map(childPanelsOf(shape.id).map(p => [p.id, snapshot(p)])) };
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
            if (sh.groupId && s.groupId === sh.groupId) return { ...s, ...applyXformDelta(s, d) };
            const init = captured.get(s.id);
            return init ? { ...s, ...applyXformDelta(init, d) } : s;
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
        const x = applyXformDelta(init, d);
        g.position.set(...x.position); g.rotation.set(...x.rotation); g.scale.set(...x.scale);
      });
    };
    controls.addEventListener('dragging-changed', onDraggingChanged);
    controls.addEventListener('change', onChange);
    cleanupListenersRef.current = () => {
      controls.removeEventListener('dragging-changed', onDraggingChanged); controls.removeEventListener('change', onChange);
    };
  }, [shape.id, orbitControlsRef, scene]);

  const isWireframe = S.viewMode === ViewMode.WIREFRAME;
  const isXray = S.viewMode === ViewMode.XRAY;
  const shouldShowAsReference = shape.isReferenceBox || shape.id === S.secondarySelectedShapeId;
  const hasPanels = S.shapes.some(s => s.type === 'panel' && s.parameters?.parentShapeId === shape.id);
  // REFERANS SEÇİMİ: extrude / hacim / döndürmede gövde de referans olabilir (ışın sırasının SONUNDA — önce paneller). Taşımada yalnız panel.
  const isRefMode = !!rp && rp.tool !== 'move' && rp.stage !== 'isolated';
  const isRefIsoBody = rp?.stage === 'isolated' && rp.isoId === shape.id;
  const isMoveRefPickActive = isRefMode;
  // Görünmez gövde mesh'i yalnız panel / yüz seçim modlarında bastırılır (ref modları muaf); hacim / kapak / arkalıkta her zaman.
  const isVolumePickOnThis = (S.volumePickMode !== null || S.doorPickMode || S.backPickMode || S.plinthPickMode) && isSelected;
  const suppressBodyRaycast = isRefIsoBody || (hasPanels && (S.panelSelectMode || S.raycastMode) && !isRefMode) || isVolumePickOnThis;
  const moveRefBodyHighlight = isMoveRefPickActive && moveRefHover;
  useEffect(() => { if (!isMoveRefPickActive && moveRefHover) setMoveRefHover(false); }, [isMoveRefPickActive, moveRefHover]);

  const partSelected = S.selectedPanelRow !== null || !!S.selectedPanelGroupId || !!S.selectedDoorGroupId || !!S.selectedBackGroupId
    || S.faceExtrudeMode || S.panelMoveMode || S.panelRotateMode;

  if (shape.isolated === false || !localGeometry) return null;
  // Referans seçiminde yalnız bırakılan şey bu gövde değilse gövde (ve üstündeki her şey) çizilmez.
  if (rp?.stage === 'isolated' && !isRefIsoBody) return null;
  // Yüz çiziminde izolasyon (DraftView): başka gövdeler gizlenir; hedef GÖVDE yüzüyse (panelleri gizli) gövde görünür kılınır.
  if (draftIso && draftIso.bodyId !== shape.id) return null;
  const isoBody = !!draftPreview || (draftIso?.kind === 'body' && draftIso.targetId === shape.id) || isRefIsoBody;

  const raycastProps = suppressBodyRaycast ? { raycast: noRaycast } : {};
  const hoverProps = isMoveRefPickActive ? {
    onPointerOver: (e: any) => { e.stopPropagation(); setMoveRefHover(true); },
    onPointerOut: () => { if (moveRefHover) setMoveRefHover(false); },
  } : {};
  const outlinesVisible = S.showOutlines || S.raycastMode || !!S.volumePickMode || S.doorPickMode || S.backPickMode || S.plinthPickMode || isoBody;
  const outline = (color: string, width: number, depthWrite: boolean, onTop = false) => outlinesVisible && edgePoints && (
    <Line points={edgePoints} segments color={color} lineWidth={width} transparent={onTop} depthTest={!onTop} depthWrite={depthWrite && !onTop}
      renderOrder={onTop ? XRAY_EDGE.order : 1} raycast={noRaycast} />
  );
  const accented = isSelected || shouldShowAsReference;
  const geoUuid = shape.geometry?.uuid || '';
  const bodyEmissive = moveRefBodyHighlight ? REF_COLORS.hoverCss : '#000000';
  const bodyOpacity = isRefIsoBody ? 0.72 : isoBody ? 0.14 : hasPanels ? (moveRefBodyHighlight ? 0.35 : 0) : (moveRefBodyHighlight ? 0.5 : 0.06);

  return (
    <>
      <group ref={groupRef} name={`shape-${shape.id}`}
        onClick={(e) => {
          if (rp && rp.tool !== 'move') { e.stopPropagation(); if (isRefMode) pickRefPanelFromEvent(e, rp); return; }
          if (S.panelMoveMode && S.panelMoveValueMode === 'ref' && !!S.panelMoveRefSourceVertex) { e.stopPropagation(); return; }
          // Aktif panel aracı: stopPropagation YOK — arkadaki panelin araç işleyicisi olayı alsın.
          if (S.faceExtrudeMode || S.panelMoveMode || S.panelRotateMode) return;
          if (S.volumePickMode || S.doorPickMode || S.backPickMode || S.plinthPickMode) { e.stopPropagation(); return; }
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
        onDoubleClick={(e) => { e.stopPropagation(); enterBodyEdit(shape.id); }}
        onContextMenu={(e: any) => { if (isMoveRefPickActive) e.stopPropagation(); }}>
        {shape.subtractionGeometries && S.subtractionViewMode && shape.subtractionGeometries.map((sub: any, index: number) => sub && (
          <SubtractionMesh key={`${shape.id}-subtraction-${index}`} subtraction={sub} index={index} isSelected={isSelected}
            isHovered={S.hoveredSubtractionIndex === index && isSelected} isSubtractionSelected={S.selectedSubtractionIndex === index && isSelected}
            setHovered={S.setHoveredSubtractionIndex} setSelected={S.setSelectedSubtractionIndex} />
        ))}

        {!isWireframe && !isXray && !shouldShowAsReference && (
          <>
            <mesh ref={meshRef} geometry={drawGeometry} castShadow receiveShadow {...raycastProps} {...hoverProps}>
              <meshStandardMaterial color="#c8c8c8" emissive={bodyEmissive} emissiveIntensity={moveRefBodyHighlight ? 0.9 : 0}
                metalness={0} roughness={1.0} transparent opacity={bodyOpacity}
                side={THREE.DoubleSide} depthWrite={false} flatShading={false} polygonOffset polygonOffsetFactor={4} polygonOffsetUnits={8} />
            </mesh>
            {outline(EDGE_COLOR, isSelected ? EDGE_LINE_WIDTH + 0.5 : EDGE_LINE_WIDTH, false)}
          </>
        )}
        {isWireframe && (
          <>
            <mesh ref={meshRef} geometry={drawGeometry} visible={false} {...raycastProps} />
            {outline(WIRE_COLOR, accented ? EDGE_LINE_WIDTH + 0.75 : EDGE_LINE_WIDTH + 0.25, true)}
          </>
        )}
        {(isXray || shouldShowAsReference) && (
          <>
            <mesh ref={meshRef} geometry={drawGeometry} castShadow receiveShadow {...raycastProps}>
              <meshStandardMaterial color={shouldShowAsReference ? '#ef4444' : '#c8c8c8'} emissive="#000000" emissiveIntensity={0} metalness={0} roughness={1.0}
                transparent opacity={hasPanels ? 0 : shouldShowAsReference ? 0.2 : 0.06} side={THREE.DoubleSide} depthWrite={false} flatShading={false} />
            </mesh>
            {outline(isSelected ? '#1e40af' : shouldShowAsReference ? '#991b1b' : XRAY_EDGE.color, (accented ? EDGE_LINE_WIDTH + 0.5 : EDGE_LINE_WIDTH) + XRAY_EDGE.extra, false, isXray)}
          </>
        )}

        {shape.fillets?.length > 0 && S.filletMode && <FilletEdgeLines shape={shape} />}
        {isSelected && S.faceEditMode && <FaceEditor key={`face-editor-${shape.id}-${geoUuid}-${(shape.fillets || []).length}`} shape={shape} />}
        {isSelected && S.raycastMode && <FaceRaycastOverlay key={`raycast-${shape.id}-${geoUuid}`} shape={shape} allShapes={S.shapes} />}
        {isSelected && S.volumePickMode && <VolumePickOverlay shape={shape} allShapes={S.shapes} />}
        {isSelected && S.doorPickMode && <DoorPickOverlay shape={shape} />}
        {isSelected && S.backPickMode && <BackPickOverlay shape={shape} />}
        {isSelected && S.plinthPickMode && <PlinthPickOverlay shape={shape} />}
        {!draftIso && !draftPreview && !isRefIsoBody && <PlinthSets shape={shape} />}
        {!draftIso && !draftPreview && !isRefIsoBody && <ConnectorParts shape={shape} xray={isXray} />}
        {S.faceExtrudeMode && S.faceExtrudeCavityGroupId && !isRefIsoBody && <CavityEditOverlay shape={shape} />}
        {S.faceExtrudeMode && S.faceExtrudePlinthId && <PlinthEditOverlay shape={shape} />}
        {!draftIso && !draftPreview && !isRefIsoBody && <VirtualFaceOverlay shape={shape} />}
        {S.showFaceRoles && isSelected && <BodyFaceRoleLabels shape={shape} hovered={S.faceRoleHover?.shapeId === shape.id ? S.faceRoleHover!.gi : null} />}
        {S.faceRoleHover && S.faceRoleHover.shapeId === shape.id && <FaceRoleHighlight shape={shape} faces={refFaces} groups={refFaceGroups} gi={S.faceRoleHover.gi} />}
      </group>

      {/* Gövdenin taşıma okları: bir panel / grup satırı seçiliyken ya da panel aracı açıkken çizilmez (sahnede yalnız o işin okları kalsın). */}
      {isSelected && S.activeTool !== Tool.SELECT && groupRef.current && !shape.isReferenceBox && !S.panelSelectMode && !partSelected && (
        <TransformControls key={geometryKey} ref={transformRefCallback} object={groupRef.current}
          mode={S.activeTool === Tool.ROTATE ? 'rotate' : S.activeTool === Tool.SCALE ? 'scale' : 'translate'} size={0.8} />
      )}
    </>
  );
});
ShapeWithTransform.displayName = 'ShapeWithTransform';

// ════════════════════════════════════════ 2. SAHNE (gizmolar, kamera, Canvas) ════════════════════════════════════════
/* Sahne — gizmolar, ViewCube, kamera denetimi, ref-akış onayları ve ana Canvas. */

const RENDER_ORDER = 999;
export const DOT_RENDER_ORDER = 1009;
const DOT_UNIT = new THREE.CircleGeometry(1, 32);
const DOT_IVORY = '#fffdf9';
const FONT = '"Inter", "SF Pro Display", system-ui, sans-serif';
const AXIS_RGB: Record<AxisLetter, { main: string; hover: string }> = {
  x: { main: '#ef4444', hover: '#f87171' }, y: { main: '#22c55e', hover: '#4ade80' }, z: { main: '#3b82f6', hover: '#60a5fa' },
};
const vertEq = (a: Vec3 | null, b: Vec3, tol = 0.5) =>
  !!a && Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol && Math.abs(a[2] - b[2]) < tol;
const hoverCursor = (on: boolean) => { document.body.style.cursor = on ? 'pointer' : 'default'; };
const worldOf = (v: THREE.Vector3, m: THREE.Matrix4): Vec3 => { const w = v.clone().applyMatrix4(m); return [w.x, w.y, w.z]; };

export function worldPerPixel(camera: THREE.Camera, viewportHeight: number, worldPos: THREE.Vector3): number {
  const persp = camera as THREE.PerspectiveCamera;
  if (persp.isPerspectiveCamera) {
    const dist = persp.position.distanceTo(worldPos);
    return (2 * Math.tan(((persp.fov * Math.PI) / 180) / 2) * dist) / Math.max(viewportHeight, 1);
  }
  const ortho = camera as THREE.OrthographicCamera;
  return (ortho.top - ortho.bottom) / (ortho.zoom || 1) / Math.max(viewportHeight, 1);
}

interface GizmoDotProps {
  position: Vec3;
  isSelected: boolean;
  accent?: string;
  onClick: (pos: Vec3) => void;
  groupRef?: (g: THREE.Group | null) => void;
}

const DotMat = ({ color, opacity = 1 }: { color: string; opacity?: number }) =>
  <meshBasicMaterial color={color} transparent opacity={opacity} depthTest={false} depthWrite={false} toneMapped={false} />;

/** İmlecin üzerinde durduğu nokta: tuval seviyesindeki seçiciler (MoveRefPanelPicker) nokta tıklamasını panel tıklaması saymasın. */
let _hoveredDot: THREE.Group | null = null;
export function GizmoDot({ position, isSelected, accent = '#44403c', onClick, groupRef }: GizmoDotProps) {
  const [hovered, setHovered] = useState(false);
  const g = useRef<THREE.Group | null>(null);
  // Nokta, üzerindeyken kaldırılırsa (kaynak köşe seçilince liste kapanır) pointerout gelmez → iz burada silinir.
  useEffect(() => { const el = g.current; return () => { if (_hoveredDot === el) _hoveredDot = null; }; }, []);
  const filled = hovered || isSelected;
  const diameterPx = isSelected ? 12 : hovered ? 13 : 10;
  useFrame(({ camera, size }) => {
    const o = g.current;
    if (!o) return;
    o.quaternion.copy(camera.quaternion);
    o.scale.setScalar((diameterPx / 2) * worldPerPixel(camera, size.height, o.position));
  });
  // Tıklama önceliği: disk panellerin önünde sayılsın (mesafe 0); gizliyken (çakışan köşe) hiç yakalanmasın.
  const hitRaycast = function (this: THREE.Mesh, rc: THREE.Raycaster, hits: THREE.Intersection[]) {
    if (!g.current?.visible) return;
    const before = hits.length;
    THREE.Mesh.prototype.raycast.call(this, rc, hits);
    for (let i = before; i < hits.length; i++) hits[i].distance = 0;
  };
  return (
    <group ref={el => { g.current = el; groupRef?.(el); }} position={position} renderOrder={DOT_RENDER_ORDER}>
      {isSelected && (
        <mesh geometry={DOT_UNIT} scale={2.1} renderOrder={DOT_RENDER_ORDER} raycast={noRaycast}><DotMat color={accent} opacity={0.2} /></mesh>
      )}
      <mesh geometry={DOT_UNIT} scale={1.3} position={[0.12, -0.18, 0]} renderOrder={DOT_RENDER_ORDER + 1} raycast={noRaycast}>
        <DotMat color="#281e14" opacity={0.22} />
      </mesh>
      <mesh geometry={DOT_UNIT} renderOrder={DOT_RENDER_ORDER + 2} raycast={noRaycast}><DotMat color={filled ? DOT_IVORY : accent} /></mesh>
      <mesh geometry={DOT_UNIT} scale={0.6} renderOrder={DOT_RENDER_ORDER + 3} raycast={noRaycast}><DotMat color={filled ? accent : DOT_IVORY} /></mesh>
      <mesh name="gz-dot" geometry={DOT_UNIT} scale={2.4} raycast={hitRaycast}
        onClick={e => { e.stopPropagation(); onClick(position); }}
        onPointerOver={e => { e.stopPropagation(); setHovered(true); hoverCursor(true); _hoveredDot = g.current; }}
        onPointerOut={() => { setHovered(false); hoverCursor(false); if (_hoveredDot === g.current) _hoveredDot = null; }}>
        <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />
      </mesh>
    </group>
  );
}

/** Gerçek köşeler (dünya) — taşıma / döndürme referans noktaları. Panelin BİÇİM ağından okunur (Geometry.outlineGeometry): çizimin verdiği
 *  şekil dahil, kanal / delik / bağlayıcı kesimleri HARİÇ (her delik çemberi onlarca nokta ekliyordu). Eğri kenarın (yay, daire, radüs)
 *  ara noktaları da köşe değildir: yalnız yayın düz kenarla buluştuğu uçlar kalır. */
export function computeRealCorners(panelShape: Shape): Vec3[] {
  const geo = outlineGeometry(panelShape) ?? panelShape.geometry;
  if (!geo) return [];
  const edges = new THREE.EdgesGeometry(geo, 1);
  const ep = edges.getAttribute('position') as THREE.BufferAttribute;
  const k = (x: number, y: number, z: number) => `${Math.round(x * 100)},${Math.round(y * 100)},${Math.round(z * 100)}`;
  const incident = new Map<string, Array<{ d: THREE.Vector3; len: number }>>();
  const pts = new Map<string, THREE.Vector3>();
  for (let i = 0; i + 1 < ep.count; i += 2) {
    const a = new THREE.Vector3(ep.getX(i), ep.getY(i), ep.getZ(i));
    const b = new THREE.Vector3(ep.getX(i + 1), ep.getY(i + 1), ep.getZ(i + 1));
    const len = a.distanceTo(b);
    if (len < 1e-4) continue;
    const ka = k(a.x, a.y, a.z), kb = k(b.x, b.y, b.z);
    const d = b.clone().sub(a).divideScalar(len);
    if (!incident.has(ka)) incident.set(ka, []);
    if (!incident.has(kb)) incident.set(kb, []);
    incident.get(ka)!.push({ d: d.clone(), len });
    incident.get(kb)!.push({ d: d.clone().negate(), len });
    pts.set(ka, a); pts.set(kb, b);
  }
  edges.dispose();
  const mat = getShapeMatrix(panelShape);
  const result: Vec3[] = [];
  for (const [key, v] of pts) {
    const inc = incident.get(key);
    if (!inc || inc.length === 0) continue;
    if (inc.length === 2 && inc[0].d.dot(inc[1].d) < -0.999) continue; // düz kenarın ara noktası
    // Eğri kenarın ara noktası: neredeyse karşılıklı (< ~25°) ve boyları yakın iki kenar = aynı yayın ardışık kirişleri. Tam doğrusal çift
    // (T birleşimi) ve boyları çok farklı çift (düz kenar ↔ yay ucu) köşe sayılır.
    let curve = false;
    for (let i = 0; i < inc.length && !curve; i++) for (let j = i + 1; j < inc.length; j++) {
      const dot = inc[i].d.dot(inc[j].d);
      if (dot < -0.9 && dot > -0.999999 && Math.max(inc[i].len, inc[j].len) < 4 * Math.min(inc[i].len, inc[j].len)) { curve = true; break; }
    }
    if (curve) continue;
    result.push(worldOf(v, mat));
  }
  return result;
}

/** Ekranda üst üste binen noktalardan yalnız kameraya en yakını (ya da `preferred`) görünür; konum asla ötelenmez. */
function resolveDotOverlap(
  camera: THREE.Camera, size: { width: number; height: number },
  marks: Array<{ pos: Vec3; group: number }>, preferred: (i: number) => boolean,
  groups: (THREE.Group | null)[], tmp: THREE.Vector3, overlapPx = 4,
): void {
  const n = marks.length;
  if (!n) return;
  const sx = new Array<number>(n), sy = new Array<number>(n), dist = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    tmp.set(...marks[i].pos);
    dist[i] = camera.position.distanceTo(tmp);
    const v = tmp.project(camera);
    sx[i] = (v.x * 0.5 + 0.5) * size.width;
    sy[i] = (1 - (v.y * 0.5 + 0.5)) * size.height;
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => (Number(preferred(b)) - Number(preferred(a))) || (dist[a] - dist[b]));
  const shown: number[] = [];
  const visible = new Array<boolean>(n).fill(false);
  for (const i of order) {
    const clash = shown.some(j => marks[j].group === marks[i].group && Math.hypot(sx[i] - sx[j], sy[i] - sy[j]) < overlapPx);
    if (!clash) { shown.push(i); visible[i] = true; }
  }
  for (let i = 0; i < n; i++) { const el = groups[i]; if (el && el.visible !== visible[i]) el.visible = visible[i]; }
}

function useDotOverlap(marks: Array<{ pos: Vec3; group: number }>, preferred: (i: number) => boolean) {
  const markRefs = useRef<(THREE.Group | null)[]>([]);
  const tmpVec = useRef(new THREE.Vector3());
  useFrame(({ camera, size }) => resolveDotOverlap(camera, size, marks, preferred, markRefs.current, tmpVec.current));
  return (i: number) => (el: THREE.Group | null) => { markRefs.current[i] = el; };
}

// Ekran-ölçeği kilidi: iki kilit arasında ekranda sabit boy (~TARGET_PX); dışında dünya ölçüsü donar (MIN/MAX_SCALE).
const TARGET_PX = 56, MIN_SCALE = 0.45, MAX_SCALE = 2.20;

function useScreenLockedScale(ref: React.RefObject<THREE.Group | THREE.Mesh>, baseLength: number) {
  const wp = useRef(new THREE.Vector3());
  useFrame(({ camera, size }) => {
    const o = ref.current;
    if (!o || baseLength <= 0) return;
    o.getWorldPosition(wp.current);
    o.scale.setScalar(THREE.MathUtils.clamp(TARGET_PX * worldPerPixel(camera, size.height, wp.current) / baseLength, MIN_SCALE, MAX_SCALE));
  });
}

const AXIS_DISPLAY: Record<string, string> = { 'x+': '+X', 'x-': '−X', 'y+': '+Y', 'y-': '−Y', 'z+': '+Z', 'z-': '−Z' };

/* BAZA AYAĞI SETİ (PlinthService) — seçme kaplaması, çizim ve ok gizmosu. */
/** Seçme: gövde + altındaki varsayılan yükseklik tıklanır; adaylar (alt panelin altı · gövdenin altı) raf/dikme gibi döner, sağ tık yerleştirir. */
export const PlinthPickOverlay: React.FC<{ shape: any }> = ({ shape }) => {
  const s = useStoreFields('plinthPickMode', 'plinthPickCandidates', 'plinthPickIndex', 'setPlinthPick', 'plinthPickHeight', 'shapes', 'virtualFaces');
  const { plinthPickMode: active, plinthPickHeight: H, shapes, virtualFaces } = s;
  const hitBox = useMemo(() => (active ? plinthPickBox(shape) : null), [active, shape]);
  const pickGeo = useMemo(() => (hitBox ? pickBoxGeometry(hitBox) : null), [hitBox]);
  useDisposable(pickGeo);
  // ÖN YÖN gövdenin parametresidir (bodyFrontAxis: parametre → kapaklar → +Z).
  const candsAt = () => (active ? plinthCandidates(shape, shapes, virtualFaces, H, bodyFrontAxis(shape).facing) : []);
  const selected = s.plinthPickCandidates[s.plinthPickIndex] || null;
  const cycle = usePickCycle<PlinthPick>(active, candsAt, s.setPlinthPick, () => { if (selected) confirmPlinthPick(shape.id, selected, useAppStore.getState().placementName); });
  const { hoverPick } = cycle;
  // Aday hacim gerçek şekliyle (bölge prizması: L gövde, çıkarma, yanlar arası); bölge yoksa kutu
  const pickMesh = (p: PlinthPick) => (p.poly && p.poly.length >= 3
    ? (() => { const geo = prismGeometry(p.poly, p.box.min[1], p.box.max[1]); return { geo, edgePts: edgePointsOf(geo, 1) }; })()
    : surfaceMesh(boxesSurface(p.boxes?.length ? p.boxes : [p.box])));
  const selectedMesh = useMemo(() => (selected ? pickMesh(selected) : null), [selected]);
  const hoverMesh = useMemo(() => (hoverPick ? pickMesh(hoverPick) : null), [hoverPick]);
  useDisposable(selectedMesh?.geo); useDisposable(hoverMesh?.geo);
  if (!active || !pickGeo) return null;
  const hoverIsSelected = !!hoverPick && !!selected && hoverPick.key === selected.key;
  return (
    <>
      <PickHitBox geometry={pickGeo} cycle={cycle} />
      {hoverMesh && !hoverIsSelected && (
        <mesh geometry={hoverMesh.geo} raycast={noRaycast} renderOrder={5}><FillMat color={PICK_COLORS.hover} opacity={SEL_COLORS.volumeHoverOpacity} /></mesh>
      )}
      {selectedMesh && (
        <>
          <mesh geometry={selectedMesh.geo} raycast={noRaycast} renderOrder={6}><FillMat color={PICK_COLORS.selected} opacity={SEL_COLORS.volumeActiveOpacity} /></mesh>
          {selectedMesh.edgePts.length >= 2 && <EdgeLines points={selectedMesh.edgePts} color={PICK_COLORS.selectedEdge} width={SEL_COLORS.edgeWidth} order={7} />}
        </>
      )}
    </>
  );
};
/** Setler (gövde-yerel çerçevede): ayak silindirleri + taban diski; tık satırı seçer; seçili sette oklar. */
/* Yerleşik plastik baza ayağı: taban + ayar mili + kovan + tabla; ölçüler Ø ve set yüksekliğinden. */
const FOOT_COLORS = { plastic: '#2b2a28', housing: '#34322f', plate: '#2f2d2a', screw: '#8c8a86' } as const;
function lathe(profile: Array<[number, number]>, seg = 40): THREE.LatheGeometry {
  return new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), seg);
}
/** Ayak geometrileri (set yüksekliği h, taban çapı d) — aynı (h, d) için önbellek. */
const footGeoCache = new Map<string, { base: THREE.BufferGeometry; stem: THREE.BufferGeometry; housing: THREE.BufferGeometry; plate: THREE.BufferGeometry; screwR: number }>();
function plinthFootGeometries(h: number, d: number) {
  const key = `${round1(h)}|${round1(d)}`;
  const hit = footGeoCache.get(key); if (hit) return hit;
  const r = Math.max(10, d / 2), rs = r * 0.5, rh = r * 0.7, plateR = r * 1.15, baseH = Math.min(12, h * 0.15);
  // Taban: düz oturma yüzü, yuvarlatılmış kenar, mile geçişte boyun
  const base = lathe([[0, 0], [r, 0], [r, baseH * 0.45], [r * 0.93, baseH * 0.8], [r * 0.75, baseH], [rs * 1.15, baseH], [rs * 1.15, baseH + 3], [0, baseH + 3]]);
  // Dişli mil: kovanın altına kadar görünür; dişler 3 mm hatveli zigzag profil
  const stemTop = Math.max(baseH + 6, h * 0.62), pitch = 3, depth = Math.min(1.2, rs * 0.12);
  const prof: Array<[number, number]> = [[0, baseH + 2], [rs - depth, baseH + 2]];
  for (let y = baseH + 2; y < stemTop - pitch; y += pitch) prof.push([rs, y + pitch * 0.5], [rs - depth, y + pitch]);
  prof.push([rs - depth, stemTop], [0, stemTop]);
  const stem = lathe(prof, 32);
  // Kovan (ayar yuvası): alt ucu hafif konik, gövdede tutma kanalları, üstte tablaya geçiş
  const hb = Math.max(baseH + 8, h * 0.5), ht = h - 4;
  const hp: Array<[number, number]> = [[0, hb], [rh * 0.9, hb], [rh, hb + 3]];
  const ribs = Math.max(2, Math.floor((ht - hb - 10) / 6));
  for (let i = 0; i < ribs; i++) { const y = hb + 6 + i * 6; hp.push([rh, y], [rh * 0.94, y + 1.5], [rh * 0.94, y + 3.5], [rh, y + 5]); }
  hp.push([rh, ht - 2], [rh * 0.8, ht], [0, ht]);
  const housing = lathe(hp, 40);
  // Montaj tablası: kalın disk + 4 vida yuvası
  const plate = new THREE.CylinderGeometry(plateR, plateR * 0.96, 4, 40).translate(0, h - 2, 0);
  const out = { base, stem, housing, plate, screwR: plateR * 0.72 };
  if (footGeoCache.size > 64) footGeoCache.clear();
  footGeoCache.set(key, out);
  return out;
}
function PlinthFoot({ h, d, active, xray, onClick, pickable = true }: { h: number; d: number; active: boolean; xray: boolean; onClick: (e: any) => void; pickable?: boolean }) {
  const g = useMemo(() => plinthFootGeometries(h, d), [h, d]);
  const mat = (color: string, rough = 0.62) => (
    <meshStandardMaterial color={color} metalness={0.05} roughness={rough} transparent={xray} opacity={xray ? 0.35 : 1}
      emissive={active ? LEG_COLORS.selected : '#000000'} emissiveIntensity={active ? 0.45 : 0} />
  );
  const ev = pickable ? { onClick, onPointerOver: (e: any) => { e.stopPropagation(); hoverCursor(true); }, onPointerOut: () => hoverCursor(false) }
    : { raycast: noRaycast };
  return (
    <group>
      <mesh geometry={g.base} castShadow receiveShadow {...ev}>{mat(FOOT_COLORS.plastic, 0.7)}</mesh>
      <mesh geometry={g.stem} castShadow {...ev}>{mat(FOOT_COLORS.plastic, 0.55)}</mesh>
      <mesh geometry={g.housing} castShadow {...ev}>{mat(FOOT_COLORS.housing, 0.65)}</mesh>
      <mesh geometry={g.plate} castShadow {...ev}>{mat(FOOT_COLORS.plate, 0.6)}</mesh>
      {[45, 135, 225, 315].map(a => (
        <mesh key={a} position={[Math.cos(a * Math.PI / 180) * g.screwR, h - 0.2, Math.sin(a * Math.PI / 180) * g.screwR]} raycast={noRaycast}>
          <cylinderGeometry args={[2.2, 2.2, 1.2, 12]} />
          <meshStandardMaterial color={FOOT_COLORS.screw} metalness={0.6} roughness={0.35} transparent={xray} opacity={xray ? 0.35 : 1} />
        </mesh>
      ))}
    </group>
  );
}

/** Setler (gövde-yerel çerçevede): plastik baza ayakları; tık satırı seçer; seçili sette set hacmi (raf/dikme seçimi gibi) + oklar. */
export const PlinthSets: React.FC<{ shape: any }> = ({ shape }) => {
  const { plinthSets, selectedPanelRow, setSelectedPanelRow, viewMode, shapes, faceExtrudeMode, faceExtrudePlinthId, raycastMode, legPresets, legModels, accessoryModels } =
    useStoreFields('plinthSets', 'selectedPanelRow', 'setSelectedPanelRow', 'viewMode', 'shapes', 'faceExtrudeMode', 'faceExtrudePlinthId', 'raycastMode',
      'legPresets', 'legModels', 'accessoryModels');
  const sets = useMemo(() => plinthSetsOf(shape.id, plinthSets), [plinthSets, shape.id]);
  // Etkin bölge: taban zeminde, üst bağlı alt panelden (canlı), şekil gövde + erken yanlardan (L / çentik) — ayaklar bölgenin içinde.
  const regions = useMemo(() => sets.map(set => plinthRegionOf(set, shapes)), [sets, shapes]);
  // Etkin ayak düzeni kayıtlı setten: kütüphane değişince ayaklar yenilenir.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const legsOf = useMemo(() => sets.map(set => plinthLegsOf(set.legs)), [sets, legPresets, legModels, accessoryModels]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const spots = useMemo(() => sets.map(set => plinthLegSpots(set, shapes)), [sets, shapes, legsOf]);
  if (!sets.length || viewMode === ViewMode.WIREFRAME) return null;
  const xray = viewMode === ViewMode.XRAY;
  return (
    <>
      {sets.map((set, k) => {
        const active = selectedPanelRow === plinthRowKey(set.id);
        const box = regions[k].bbox, h = box.max[1] - box.min[1], y0 = box.min[1];
        const click = (e: any) => { e.stopPropagation(); setSelectedPanelRow(active ? null : plinthRowKey(set.id), shape.id); };
        // Model ve Ø kayıtlı setten (Auto'da düzen de); kütüphanede set yoksa yerleşik ayak.
        const L = legsOf[k];
        return (
          <group key={set.id}>
            {spots[k].map((p, i) => (
              <group key={i} position={[p.x, y0, p.z]}>
                {/* Panel yerleştirme kipinde ayaklar tıklamayı ALMAZ: ışın gövdenin yüz seçimine gider (setin üstü orada aday) */}
                {L.legModelId
                  ? <ImportedFoot legModelId={L.legModelId} h={h} d={L.diameter} active={active} xray={xray} onClick={click} pickable={!raycastMode} />
                  : <PlinthFoot h={h} d={L.diameter} active={active} xray={xray} onClick={click} pickable={!raycastMode} />}
              </group>
            ))}
            {/* Hacim düzenlemede (Volume) bölge ve yüz seçimi PlinthEditOverlay'de çizilir */}
            {active && !(faceExtrudeMode && faceExtrudePlinthId === set.id) && <PlinthVolume region={regions[k]} />}
          </group>
        );
      })}
    </>
  );
};
/* Aksesuar kütüphanesinden ayak: parçalar alt alta, `stem` set yüksekliğine göre ölçeklenir; geometri yoksa yerleşik ayak. */
export function useLegAssembly(legModelId: string | null | undefined, h: number): LegAssemblyPart[] | null {
  const { legModels } = useStoreFields('legModels');
  const [tick, setTick] = useState(0);
  useEffect(() => onAccessoryGeometry(() => setTick(t => t + 1)), []);
  const leg = legModelId ? legModels.find(x => x.id === legModelId) : undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (leg ? legAssembly(leg, h) : null), [leg, h, tick]);
}
const IMPORTED_FOOT_COLORS: Record<string, string> = { base: FOOT_COLORS.plastic, stem: FOOT_COLORS.housing, top: FOOT_COLORS.plate };
/** BAĞLAYICI MODELLERİ: gövdenin birleşim noktalarında (gövde-yerel), bağlayıcı editöründeki duruşuyla. Tıklanmaz; rengi katmanından. */
function ConnectorParts({ shape, xray }: { shape: { id: string }; xray: boolean }) {
  const { shapes, virtualFaces, panelGroups, connectors, panelTypeConfig, accessoryLayers } =
    useStoreFields('shapes', 'virtualFaces', 'panelGroups', 'connectors', 'panelTypeConfig', 'accessoryLayers');
  const [, setTick] = useState(0);
  useEffect(() => onAccessoryGeometry(() => setTick(t => t + 1)), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const items = useMemo(() => connectorPartInstances(shape.id), [shape.id, shapes, virtualFaces, panelGroups, connectors, panelTypeConfig]);
  if (!items.length) return null;
  return (
    <>
      {items.map(it => {
        const g = accessoryGeometryNow(it.modelId);
        return g ? (
          <mesh key={it.key} geometry={g.geo} position={it.pos} quaternion={it.quat} raycast={noRaycast} castShadow>
            <meshStandardMaterial color={accessoryLayers.find(l => l.id === it.layerId)?.color ?? LAYER_DEFAULT_COLOR} metalness={0.25} roughness={0.5}
              transparent={xray} opacity={xray ? 0.5 : 1} />
          </mesh>
        ) : null;
      })}
    </>
  );
}
export function ImportedFoot({ legModelId, h, d, active, xray, onClick, pickable = true }: {
  legModelId: string; h: number; d: number; active: boolean; xray: boolean; onClick: (e: any) => void; pickable?: boolean;
}) {
  const parts = useLegAssembly(legModelId, h);
  const { accessoryLayers } = useStoreFields('accessoryLayers');   // katman rengi değişince parçalar yeniden boyanır
  if (!parts) return <PlinthFoot h={h} d={d} active={active} xray={xray} onClick={onClick} pickable={pickable} />;
  const ev = pickable ? { onClick, onPointerOver: (e: any) => { e.stopPropagation(); hoverCursor(true); }, onPointerOut: () => hoverCursor(false) }
    : { raycast: noRaycast };
  // Parça rengi KATMANINDAN (Aksesuar › Layers); katmansız parça rolüne göre eski renk.
  const colorOf = (p: LegAssemblyPart) => accessoryLayers.find(l => l.id === p.layerId)?.color ?? IMPORTED_FOOT_COLORS[p.role];
  return (
    <group>
      {parts.map((p, i) => (
        <mesh key={`${p.modelId}-${i}`} geometry={p.geo} position={[p.x, p.y, p.z]} scale={[p.scaleX, p.scaleY, p.scaleZ]} castShadow receiveShadow {...ev}>
          <meshStandardMaterial color={colorOf(p)} metalness={0.05} roughness={0.6} transparent={xray} opacity={xray ? 0.35 : 1}
            emissive={active ? LEG_COLORS.selected : '#000000'} emissiveIntensity={active ? 0.45 : 0} />
        </mesh>
      ))}
    </group>
  );
}
const ROLE_CHIP: Record<string, string> = {
  front: '#c2410c', rear: '#44403c', left: '#2563eb', right: '#0f766e', top: '#78716c', bottom: '#78716c',
  columnSide: '#6d5fa3', columnFront: '#6d5fa3', beamFront: '#a16207', beamHoriz: '#a16207',
};
/** Kübün üzerinde roller: seçili gövdenin her düz yüzünde tıklanabilir rol seçimi (gövde parametresine yazılır; elle = dolu, otomatik = soluk).
 *  Listenin sonunda kolon / kiriş görevleri (yüzün yön rolü değişmez; o yüze konan panelin tipi olur). */
const BodyFaceRoleLabels: React.FC<{ shape: any; hovered: number | null }> = ({ shape, hovered }) => {
  const { doorGroups, setFaceRoleHover } = useStoreFields('doorGroups', 'setFaceRoleHover');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const faces = useMemo(() => bodyFaces(shape), [shape, shape.parameters?.faceRoles, doorGroups]);
  const stopAll = { onPointerDown: stopEvent, onPointerUp: stopEvent, onClick: stopEvent, onDoubleClick: stopEvent, onContextMenu: stopEvent };
  return (
    <>
      {faces.map(f => {
        const hot = hovered === f.gi, chip = ROLE_CHIP[f.kind ?? f.role];
        const optStyle = { textTransform: 'none', color: '#1c1917', background: '#fff' } as const;
        return (
          <Html key={f.gi} position={[f.center[0] + f.normal[0] * 6, f.center[1] + f.normal[1] * 6, f.center[2] + f.normal[2] * 6]} center zIndexRange={[880, 900]}
            style={{ pointerEvents: 'none' }}>
            <select value={f.kind ?? f.role} title={`${faceRoleText(f)} — click to change this face's role`} {...stopAll}
              onChange={e => setBodyFaceRole(shape.id, f.gi, e.target.value as FaceRole | FaceKind)}
              onMouseEnter={() => setFaceRoleHover({ shapeId: shape.id, gi: f.gi })} onMouseLeave={() => setFaceRoleHover(null)}
              style={{
                // Kutu en uzun seçeneğe ("Beam horizontal") göre genişlemesin: genişlik görünen ada göre.
                width: Math.round(faceRoleText(f).length * (hot ? 7.5 : 6.8) + 17), boxSizing: 'border-box',
                pointerEvents: 'auto', cursor: 'pointer', appearance: 'none', WebkitAppearance: 'none', outline: 'none',
                fontFamily: FONT, fontSize: hot ? 10 : 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', lineHeight: '14px', padding: '0 7px',
                borderRadius: 4, whiteSpace: 'nowrap', border: `1px solid ${chip}`,
                background: f.overridden || hot ? chip : 'rgba(255,252,247,0.92)', color: f.overridden || hot ? '#fff' : chip,
                boxShadow: hot ? '0 1px 4px rgba(40,30,20,0.35)' : '0 1px 3px rgba(40,30,20,0.22)', transition: 'font-size 0.1s',
              }}>
              {FACE_ROLES.map(r => <option key={r} value={r} style={optStyle}>{FACE_ROLE_LABEL[r]}</option>)}
              <optgroup label="Column / beam" style={optStyle}>{FACE_KINDS.map(k => <option key={k} value={k} style={optStyle}>{FACE_KIND_LABEL[k]}</option>)}</optgroup>
            </select>
          </Html>
        );
      })}
    </>
  );
};
/** YÜZ ROLÜ VURGUSU (Faces satırına ya da küpteki rozete gelince): yüz grubu turuncu dolgu + kenar (rozet BodyFaceRoleLabels'ta). */
const FaceRoleHighlight: React.FC<{ shape: any; faces: FaceData[]; groups: CoplanarFaceGroup[]; gi: number }> = ({ faces, groups, gi }) => {
  const geo = useMemo(() => groupHighlight(faces, groups, gi), [faces, groups, gi]);
  useDisposable(geo);
  if (!geo) return null;
  return (
    <>
      <OverlayMesh geometry={geo} order={12} color={SEL_COLORS.active} opacity={SEL_COLORS.faceActiveOpacity} />
      <FaceOutline geometry={geo} color={SEL_COLORS.edge} width={SEL_COLORS.extrudeEdgeWidth} />
    </>
  );
};
/** Seçili setin hacmi: raf / dikme seçimiyle aynı dil, bölge prizması (gerçek şekil). */
function PlinthVolume({ region }: { region: PlinthRegion }) {
  const { bbox, poly } = region;
  const m = useMemo(() => { const geo = prismGeometry(poly, bbox.min[1], bbox.max[1]); return { geo, edgePts: edgePointsOf(geo, 1) }; }, [poly, bbox]);
  useDisposable(m.geo);
  return (
    <>
      <mesh geometry={m.geo} raycast={noRaycast} renderOrder={6}><FillMat color={PICK_COLORS.selected} opacity={SEL_COLORS.volumeActiveOpacity} /></mesh>
      {m.edgePts.length >= 2 && <EdgeLines points={m.edgePts} color={PICK_COLORS.selectedEdge} width={SEL_COLORS.edgeWidth} order={7} />}
    </>
  );
}

const ALL_DIRS: AxisDir[] = ['x+', 'x-', 'y+', 'y-', 'z+', 'z-'];
const CONE_ROT: Record<AxisDir, Vec3> = {
  'x+': [0, 0, -Math.PI / 2], 'x-': [0, 0, Math.PI / 2], 'y+': [0, 0, 0], 'y-': [Math.PI, 0, 0], 'z+': [Math.PI / 2, 0, 0], 'z-': [-Math.PI / 2, 0, 0],
};
const dirColor = (d: AxisDir) => AXIS_RGB[d[0] as AxisLetter].main;

type DirArrowProps = {
  position: THREE.Vector3; direction: AxisDir; length: number; cone: [number, number]; color: string; opacity?: number; onClick?: () => void;
};
function DirArrow({ position, direction, length, cone, color, opacity, onClick }: DirArrowProps) {
  const end = useMemo(() => position.clone().add(axisDirToVec(direction).multiplyScalar(length)), [position.x, position.y, position.z, direction, length]);
  const lineGeometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([position.x, position.y, position.z, end.x, end.y, end.z]), 3));
    return g;
  }, [position.x, position.y, position.z, end.x, end.y, end.z]);
  return (
    <group>
      <lineSegments geometry={lineGeometry}>
        <lineBasicMaterial color={color} linewidth={3} transparent={opacity !== undefined} opacity={opacity ?? 1} />
      </lineSegments>
      <mesh position={end} rotation={CONE_ROT[direction]} onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}>
        <coneGeometry args={[cone[0], cone[1], 8]} />
        <meshBasicMaterial color={color} />
      </mesh>
    </group>
  );
}

type VertexEditorProps = { shape: any; onVertexSelect: (index: number | null) => void; onDirectionChange: (direction: AxisDir) => void };
export const VertexEditor: React.FC<VertexEditorProps> = ({ shape, onVertexSelect, onDirectionChange }) => {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [currentDirection, setCurrentDirection] = useState<AxisDir | null>(null);
  const [showDirectionSelector, setShowDirectionSelector] = useState(false);
  const [modifiedVertices, setModifiedVertices] = useState<THREE.Vector3[]>([]);
  useEffect(() => {
    (async () => {
      if (!shape.parameters) return;
      const baseVerts = await resolveBaseVertices(shape);
      // Mesh ile AYNI bileşim (eksen bazlı) — nokta, kübün köşesiyle birlikte hareket eder.
      const targets = composeVertexTargets(baseVerts, shape.vertexModifications);
      setModifiedVertices(baseVerts.map((v, i) => (targets.get(i) || v).clone()));
    })();
  }, [shape, shape.parameters?.width, shape.parameters?.height, shape.parameters?.depth, shape.replicadShape, shape.vertexModifications]);
  if (!shape.parameters || modifiedVertices.length === 0) return null;
  const handleVertexClick = (index: number, e: any) => {
    e.stopPropagation();
    if (selectedIndex === index && currentDirection) setShowDirectionSelector(true);
    else { setSelectedIndex(index); setCurrentDirection(null); setShowDirectionSelector(true); onVertexSelect(index); }
  };
  const sel = selectedIndex !== null ? modifiedVertices[selectedIndex] : null;
  return (
    <group position={shape.position} rotation={shape.rotation} scale={shape.scale}>
      {modifiedVertices.map((vertex, index) => (
        <mesh key={index} position={vertex} onClick={(e) => handleVertexClick(index, e)}
          onPointerOver={(e) => { e.stopPropagation(); setHoveredIndex(index); }} onPointerOut={(e) => { e.stopPropagation(); setHoveredIndex(null); }}>
          <sphereGeometry args={[selectedIndex === index ? 8 : 6, 16, 16]} />
          <meshBasicMaterial color={hoveredIndex === index ? '#ef4444' : selectedIndex === index ? '#f97316' : '#1f2937'} />
        </mesh>
      ))}
      {showDirectionSelector && sel && ALL_DIRS.map(dir => (
        <DirArrow key={dir} position={sel} direction={dir} length={60} cone={[8, 16]} color={dirColor(dir)} opacity={0.8}
          onClick={() => { setCurrentDirection(dir); setShowDirectionSelector(false); onDirectionChange(dir); }} />
      ))}
      {currentDirection && sel && !showDirectionSelector && <DirArrow position={sel} direction={currentDirection} length={50} cone={[4, 10]} color="#ef4444" />}
    </group>
  );
};

const C_FACE_BG  = 'rgba(240,238,234,0.96)';
const C_FACE_HOV = 'rgba(232,98,42,0.93)';
const C_EDGE_BG  = 'rgba(210,207,202,0.90)';
const C_EDGE_HOV = 'rgba(232,98,42,0.88)';
const C_BODY     = '#dbd8d2';
const C_OUTLINE  = 'rgb(140,135,128)';
const C_ACCENT   = '#e8622a';

/** Kare canvas dokusu: `draw` çizer, CanvasTexture döner. */
function canvasTexture(S: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  draw(cv.getContext('2d')!);
  const t = new THREE.CanvasTexture(cv);
  t.needsUpdate = true;
  return t;
}
const faceFont = (px: number) => `900 ${px}px Arial,Helvetica,sans-serif`;
const makeFaceTex = (letter: string, hovered: boolean) => canvasTexture(256, ctx => {
  const S = 256, PAD = 20;
  ctx.fillStyle = hovered ? C_FACE_HOV : C_FACE_BG;
  ctx.fillRect(0, 0, S, S);
  ctx.strokeStyle = hovered ? 'rgba(255,255,255,0.5)' : 'rgba(80,75,70,0.45)';
  ctx.lineWidth = 5;
  ctx.strokeRect(4, 4, S - 8, S - 8);
  let fs = 172;
  ctx.font = faceFont(fs);
  while (ctx.measureText(letter).width > S - PAD * 2 && fs > 40) { fs -= 4; ctx.font = faceFont(fs); }
  ctx.fillStyle = hovered ? '#ffffff' : '#111111';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, S / 2, S / 2);
});
const makeEdgeTex = (hovered: boolean) => canvasTexture(64, ctx => { ctx.fillStyle = hovered ? C_EDGE_HOV : C_EDGE_BG; ctx.fillRect(0, 0, 64, 64); });
const makeCardTex = (letter: string, isNorth: boolean) => canvasTexture(128, ctx => {
  ctx.clearRect(0, 0, 128, 128);
  ctx.fillStyle = isNorth ? C_ACCENT : '#4a4845';
  ctx.font = `900 88px "Syne","DM Sans",system-ui,sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, 64, 64);
});

function norm(x: number, y: number, z: number): [number, number, number] {
  const l = Math.sqrt(x * x + y * y + z * z);
  return [x / l, y / l, z / l];
}

const hoverHandlers = (setHov: (h: boolean) => void, onSnap: () => void) => ({
  onPointerEnter: (e: any) => { e.stopPropagation(); setHov(true); hoverCursor(true); },
  onPointerLeave: (e: any) => { e.stopPropagation(); setHov(false); hoverCursor(false); },
  onClick: (e: any) => { e.stopPropagation(); onSnap(); },
});

type FacePlaneProps = {
  geo: THREE.BufferGeometry; pos: [number, number, number]; rot: [number, number, number]; letter?: string; isEdge?: boolean; onSnap: () => void;
};
const FacePlane: React.FC<FacePlaneProps> = ({ geo, pos, rot, letter = '', isEdge = false, onSnap }) => {
  const [hov, setHov] = useState(false);
  const tex = useMemo(() => (isEdge ? makeEdgeTex(hov) : makeFaceTex(letter, hov)), [hov, letter, isEdge]);
  useEffect(() => () => tex.dispose(), [tex]);
  return (
    <mesh geometry={geo} position={pos} rotation={new THREE.Euler(...rot)} renderOrder={3} {...hoverHandlers(setHov, onSnap)}>
      <meshBasicMaterial map={tex} transparent depthTest={false} depthWrite={false} side={THREE.FrontSide} />
    </mesh>
  );
};

const CornerZone: React.FC<{ pos: [number, number, number]; onSnap: () => void }> = ({ pos, onSnap }) => {
  const [hov, setHov] = useState(false);
  const geo = useMemo(() => new THREE.BoxGeometry(0.20, 0.20, 0.20), []);
  return (
    <mesh geometry={geo} position={pos} renderOrder={6} {...hoverHandlers(setHov, onSnap)}>
      <meshBasicMaterial color={C_ACCENT} transparent opacity={hov ? 0.85 : 0} depthTest={false} depthWrite={false} />
    </mesh>
  );
};

const flatMat = (color: string, opacity: number) =>
  new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity, depthTest: false });
const CompassRing: React.FC = () => {
  const ringRef = useRef<THREE.Group>(null);
  const { camera } = useThree();
  useFrame(() => {
    if (!ringRef.current) return;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    ringRef.current.rotation.set(-Math.PI / 2, 0, Math.atan2(dir.x, dir.z));
  });
  const ringGeo = useMemo(() => new THREE.RingGeometry(0.90, 1.02, 72), []);
  const ringMat = useMemo(() => flatMat('#a09890', 0.75), []);
  const tickGeos = useMemo(() => [0, Math.PI / 2, Math.PI, -Math.PI / 2].map(angle => {
    const inner = 1.02, outer = 1.22, hw = 0.038;
    const sa = Math.sin(angle), ca = Math.cos(angle);
    const perp = [-ca, sa];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      sa * inner + perp[0] * hw, ca * inner + perp[1] * hw, 0,
      sa * inner - perp[0] * hw, ca * inner - perp[1] * hw, 0,
      sa * outer,                ca * outer,                0,
    ]), 3));
    g.setIndex([0, 1, 2]);
    return g;
  }), []);
  const tickMat = useMemo(() => flatMat(C_ACCENT, 0.95), []);
  const cardinals = useMemo(() => [
    { letter: 'N', angle: 0 },
    { letter: 'E', angle:  Math.PI / 2 },
    { letter: 'S', angle:  Math.PI },
    { letter: 'W', angle: -Math.PI / 2 },
  ].map(({ letter, angle }) => ({
    letter,
    tex: makeCardTex(letter, letter === 'N'),
    pos: new THREE.Vector3(Math.sin(angle) * 1.52, Math.cos(angle) * 1.52, 0),
  })), []);
  const labelGeo = useMemo(() => new THREE.PlaneGeometry(0.38, 0.38), []);
  return (
    <group position={[0, -0.62, 0]}>
      <group ref={ringRef}>
        <mesh geometry={ringGeo} material={ringMat} renderOrder={2} />
        {tickGeos.map((g, i) => <mesh key={`tk${i}`} geometry={g} material={tickMat} renderOrder={3} />)}
        {cardinals.map(({ letter, pos, tex }) => (
          <mesh key={letter} position={pos} renderOrder={4}>
            <primitive object={labelGeo} attach="geometry" />
            <meshBasicMaterial map={tex} transparent depthTest={false} depthWrite={false} side={THREE.DoubleSide} />
          </mesh>
        ))}
      </group>
    </group>
  );
};

// ViewCube: snap __snapView ile CameraController'a devredilir (drei tweenCamera up argümanını yok sayar).
const ViewCube: React.FC = () => {
  const { camera } = useThree();
  const cubeRef    = useRef<THREE.Group>(null);
  useFrame(() => { if (cubeRef.current) cubeRef.current.quaternion.copy(camera.quaternion).invert(); });

  const snap = useCallback((dir: [number,number,number], up: [number,number,number] = [0,1,0]) => {
    (window as any).__snapView?.(new THREE.Vector3(...dir), new THREE.Vector3(...up));
  }, []);

  const S = 1, H = 0.5, FW = 0.68, EW = 0.155, D = 0.003;

  const geoFace  = useMemo(() => new THREE.PlaneGeometry(FW, FW), []);
  const geoEdgeH = useMemo(() => new THREE.PlaneGeometry(FW, EW), []);
  const geoEdgeV = useMemo(() => new THREE.PlaneGeometry(EW, FW), []);
  const geoBody  = useMemo(() => new THREE.BoxGeometry(S, S, S),  []);
  const geoEdges = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(S, S, S)), []);
  const matBody  = useMemo(() => new THREE.MeshBasicMaterial({ color: C_BODY, depthTest: false, depthWrite: false }), []);
  const matEdges = useMemo(() => new THREE.LineBasicMaterial({ color: C_OUTLINE, transparent: true, opacity: 1, depthTest: false }), []);

  const P = H + D, EC = (FW + EW) / 2;
  type V3 = [number,number,number];

  const FACES: { letter: string; pos: V3; rot: V3; dir: V3; up: V3 }[] = [
    { letter: 'F', pos: [0,0,P],   rot: [0,0,0],            dir: [0,0,1],  up: [0,1,0]  },
    { letter: 'B', pos: [0,0,-P],  rot: [0,Math.PI,0],      dir: [0,0,-1], up: [0,1,0]  },
    { letter: 'R', pos: [P,0,0],   rot: [0,Math.PI/2,0],    dir: [1,0,0],  up: [0,1,0]  },
    { letter: 'L', pos: [-P,0,0],  rot: [0,-Math.PI/2,0],   dir: [-1,0,0], up: [0,1,0]  },
    { letter: 'T', pos: [0,P,0],   rot: [-Math.PI/2,0,0],   dir: [0,1,0],  up: [0,0,-1] },
    { letter: 'U', pos: [0,-P,0],  rot: [Math.PI/2,0,0],    dir: [0,-1,0], up: [0,0,1]  },
  ];

  const EDGES: { pos: V3; rot: V3; geo: 'h'|'v'; dir: V3; up: V3 }[] = [
    { pos:[0,EC,P],   rot:[0,0,0],           geo:'h', dir:norm(0,1,1),   up:[0,1,0]  },
    { pos:[0,-EC,P],  rot:[0,0,0],           geo:'h', dir:norm(0,-1,1),  up:[0,1,0]  },
    { pos:[-EC,0,P],  rot:[0,0,0],           geo:'v', dir:norm(-1,0,1),  up:[0,1,0]  },
    { pos:[EC,0,P],   rot:[0,0,0],           geo:'v', dir:norm(1,0,1),   up:[0,1,0]  },
    { pos:[0,EC,-P],  rot:[0,Math.PI,0],     geo:'h', dir:norm(0,1,-1),  up:[0,1,0]  },
    { pos:[0,-EC,-P], rot:[0,Math.PI,0],     geo:'h', dir:norm(0,-1,-1), up:[0,1,0]  },
    { pos:[EC,0,-P],  rot:[0,Math.PI,0],     geo:'v', dir:norm(1,0,-1),  up:[0,1,0]  },
    { pos:[-EC,0,-P], rot:[0,Math.PI,0],     geo:'v', dir:norm(-1,0,-1), up:[0,1,0]  },
    { pos:[P,EC,0],   rot:[0,-Math.PI/2,0],  geo:'h', dir:norm(1,1,0),   up:[0,1,0]  },
    { pos:[P,-EC,0],  rot:[0,-Math.PI/2,0],  geo:'h', dir:norm(1,-1,0),  up:[0,1,0]  },
    { pos:[P,0,EC],   rot:[0,-Math.PI/2,0],  geo:'v', dir:norm(1,0,1),   up:[0,1,0]  },
    { pos:[P,0,-EC],  rot:[0,-Math.PI/2,0],  geo:'v', dir:norm(1,0,-1),  up:[0,1,0]  },
    { pos:[-P,EC,0],  rot:[0,Math.PI/2,0],   geo:'h', dir:norm(-1,1,0),  up:[0,1,0]  },
    { pos:[-P,-EC,0], rot:[0,Math.PI/2,0],   geo:'h', dir:norm(-1,-1,0), up:[0,1,0]  },
    { pos:[-P,0,-EC], rot:[0,Math.PI/2,0],   geo:'v', dir:norm(-1,0,-1), up:[0,1,0]  },
    { pos:[-P,0,EC],  rot:[0,Math.PI/2,0],   geo:'v', dir:norm(-1,0,1),  up:[0,1,0]  },
    { pos:[0,P,EC],   rot:[-Math.PI/2,0,0],  geo:'h', dir:norm(0,1,1),   up:[0,1,0]  },
    { pos:[0,P,-EC],  rot:[-Math.PI/2,0,0],  geo:'h', dir:norm(0,1,-1),  up:[0,1,0]  },
    { pos:[-EC,P,0],  rot:[-Math.PI/2,0,0],  geo:'v', dir:norm(-1,1,0),  up:[0,1,0]  },
    { pos:[EC,P,0],   rot:[-Math.PI/2,0,0],  geo:'v', dir:norm(1,1,0),   up:[0,1,0]  },
    { pos:[0,-P,EC],  rot:[Math.PI/2,0,0],   geo:'h', dir:norm(0,-1,1),  up:[0,1,0]  },
    { pos:[0,-P,-EC], rot:[Math.PI/2,0,0],   geo:'h', dir:norm(0,-1,-1), up:[0,1,0]  },
    { pos:[-EC,-P,0], rot:[Math.PI/2,0,0],   geo:'v', dir:norm(-1,-1,0), up:[0,1,0]  },
    { pos:[EC,-P,0],  rot:[Math.PI/2,0,0],   geo:'v', dir:norm(1,-1,0),  up:[0,1,0]  },
  ];

  // Köşeler ve üst/alt kenarlar: up = dünya-Y, zemin yatay kalır.
  const CORNERS: { pos: V3; dir: V3; up: V3 }[] = [
    { pos:[ H, H, H], dir:norm(1,1,1),    up:[0,1,0] },
    { pos:[-H, H, H], dir:norm(-1,1,1),   up:[0,1,0] },
    { pos:[ H,-H, H], dir:norm(1,-1,1),   up:[0,1,0] },
    { pos:[-H,-H, H], dir:norm(-1,-1,1),  up:[0,1,0] },
    { pos:[ H, H,-H], dir:norm(1,1,-1),   up:[0,1,0] },
    { pos:[-H, H,-H], dir:norm(-1,1,-1),  up:[0,1,0] },
    { pos:[ H,-H,-H], dir:norm(1,-1,-1),  up:[0,1,0] },
    { pos:[-H,-H,-H], dir:norm(-1,-1,-1), up:[0,1,0] },
  ];

  return (
    <>
      <group ref={cubeRef}>
        <mesh geometry={geoBody} material={matBody} renderOrder={1} />
        <lineSegments geometry={geoEdges} material={matEdges} renderOrder={4} />
        {FACES.map((f, i) => <FacePlane key={`f${i}`} geo={geoFace} pos={f.pos} rot={f.rot} letter={f.letter} onSnap={() => snap(f.dir, f.up)} />)}
        {EDGES.map((e, i) => (
          <FacePlane key={`e${i}`} geo={e.geo === 'h' ? geoEdgeH : geoEdgeV} pos={e.pos} rot={e.rot} isEdge onSnap={() => snap(e.dir, e.up)} />
        ))}
        {CORNERS.map((c, i) => <CornerZone key={`c${i}`} pos={c.pos} onSnap={() => snap(c.dir, c.up)} />)}
      </group>
      <CompassRing />
    </>
  );
};

const PERSP_FOV = 45;
/** Odak düzleminde perspektifle aynı ölçeği veren ortografik zoom. */
const orthoZoomFor = (dist: number, h: number) => h / (2 * dist * Math.tan((PERSP_FOV * Math.PI / 180) / 2));
/** Ters eşleme: ortografik zoom'un verdiği çerçeveyi perspektifte veren uzaklık. */
const perspDistFor = (zoom: number, h: number) => h / (2 * Math.max(zoom, 1e-6) * Math.tan((PERSP_FOV * Math.PI / 180) / 2));
// Perspektif ↔ ortografik geçiş: "dolly-zoom" — perspektif kamera çerçeveyi koruyarak PERSP_FOV → NARROW_FOV daralıp geri çekilir,
// ortografik aynı çerçeveyle devralır; dönüşte tersi. O → P uzaklığı zoom'dan (yakınlaştırma sonrası sıçrama olmasın).
const NARROW_FOV = 4, CAMERA_BLEND_MS = 260;
const tanHalfDeg = (deg: number) => Math.tan((deg * Math.PI / 180) / 2);

/** Sola yaslı şeridin sahneyi o an örttüğü genişlik (görünüm kabının soluna göre; kayarken ara değer). Şerit yaslı değilse null. */
function sidebarVisualInset(parentRect: DOMRect): number | null {
  const el = document.querySelector('[data-yago-dock]');
  if (!el) return null;
  return Math.max(0, Math.min(parentRect.width, el.getBoundingClientRect().right - parentRect.left));
}
/** Görünen genişlik `fromW` → `toW` daralırken seçili (yoksa görünen) gövdelerin yatayda sığması için gereken ek pay: perspektifte geri
 *  çekilme (dünya birimi), ortografikte ln(yakınlaştırma çarpanı) (< 0 = uzaklaş). Daralmadan önce de sığmıyorsa (yakın çalışma) pay yok. */
function sidebarFitPull(cam: THREE.Camera, controls: { target: THREE.Vector3 }, fromW: number, toW: number, h: number): { persp: number; ortho: number } {
  const none = { persp: 0, ortho: 0 };
  if (!(toW < fromW - 1) || toW < 40) return none;
  const st = useAppStore.getState();
  const bodies = st.shapes.filter(x => x.type !== 'panel' && x.geometry && x.isolated !== false);
  const pool = bodies.some(x => x.id === st.selectedShapeId) ? bodies.filter(x => x.id === st.selectedShapeId) : bodies;
  const box = new THREE.Box3();
  for (const b of pool) { const bb = localBboxOf(b.geometry); if (bb) box.union(bb.applyMatrix4(getShapeMatrix(b))); }
  if (box.isEmpty()) return none;
  cam.updateMatrixWorld();
  const pts = [0, 1, 2, 3, 4, 5, 6, 7].map(i => new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)
    .applyMatrix4(cam.matrixWorldInverse));
  if (cam instanceof THREE.PerspectiveCamera) {
    const tan = tanHalfDeg(cam.fov), dist = cam.position.distanceTo(controls.target);
    const reach = (w: number) => Math.max(...pts.map(q => (q.z < -1 ? Math.abs(q.x) / -q.z / (tan * w / h) : Infinity)));
    const before = reach(fromW);
    if (before > 1.001 || reach(toW) <= Math.max(0.9, before)) return none;
    const lim = Math.max(0.9, before) * tan * toW / h;
    const back = Math.min(25000 - dist, Math.max(0, ...pts.map(q => Math.abs(q.x) / lim + q.z)));
    return back > 0.5 ? { persp: back, ortho: 0 } : none;
  }
  if (cam instanceof THREE.OrthographicCamera) {
    const reach = (w: number) => Math.max(...pts.map(q => Math.abs(q.x) * cam.zoom / (w / 2)));
    const before = reach(fromW), after = reach(toW);
    if (before > 1.001 || after <= Math.max(0.9, before)) return none;
    return { persp: 0, ortho: Math.log(Math.max(0.9, before) / after) };
  }
  return none;
}

const CameraController: React.FC<{ controlsRef: React.RefObject<any>; cameraType: CameraType }> = ({ controlsRef, cameraType }) => {
  const cameraRef = useRef<THREE.PerspectiveCamera | THREE.OrthographicCamera>(null);
  const savedRef  = useRef<{ position: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3 } | null>(null);
  const prevType  = useRef<CameraType>(cameraType);
  const { size, invalidate } = useThree();  // canvas boyutu (CSS px, pencere değil)
  // Sahnedeki kamera tipi: store'daki tipten geçiş animasyonu kadar geride kalır (perspektif önce daralır, sonra değişir).
  const [shown, setShown] = useState<CameraType>(cameraType);
  const busyRef = useRef(false);       // geçiş sürüyor: konum kaydı ve yörünge algısı durur
  const autoRef = useRef(false);       // ortografiğe OTOMATİK girildi (yüz / standart görünüş) → döndürünce perspektife dönülür
  const internalRef = useRef(false);   // tip değişimini biz istedik (araç çubuğundan elle değişim otomatiği bırakır)
  const waiters = useRef<Array<() => void>>([]);
  const enterRef = useRef<{ target: THREE.Vector3; dir: THREE.Vector3; dist: number } | null>(null);
  const boundControls = useRef<any>(null);
  const blendTarget = useRef<THREE.Vector3 | null>(null);
  const blendUp = useRef(new THREE.Vector3(0, 1, 0));
  const blendM = useRef(new THREE.Matrix4());
  const epochRef = useRef(0);          // her geçiş bir kuşak: üst üste gelen geçişte eski animasyon döngüsü kendini bırakır
  // Geçiş boyunca drei'nin kontrol güncellemesinden (−1) önce: yeni OrbitControls kurulurken hedef (0,0,0) ile kamerayı çevirir →
  // hedef ve yönelim her karede yeniden yazılır.
  useFrame(() => {
    const c = controlsRef.current, t = blendTarget.current, cam = cameraRef.current;
    if (!busyRef.current || !t) return;
    if (c) { c.target.copy(t); c.enabled = false; }
    if (cam) { cam.quaternion.setFromRotationMatrix(blendM.current.lookAt(cam.position, t, blendUp.current)); cam.updateMatrixWorld(); }
  }, -2);
  const finishBlend = useCallback((target?: THREE.Vector3, viewUp?: THREE.Vector3, oldControls?: any) => {
    // OrbitControls yörünge çerçevesini kurulurken camera.up'tan alır; üst / alt görünüşte up (0,0,∓1) döndürmeyi kilitler →
    // kamera up = dünya-Y ile bağlanır, görünüşün up'ı yeni kontrol geldikten sonra geri yazılır.
    let n = 0;
    const settle = () => {
      const c = controlsRef.current, cam = cameraRef.current;
      const fresh = !!c && (c !== oldControls || n >= 3);
      if (c && target) {
        c.target.copy(target);
        if (fresh) { if (cam && viewUp) cam.up.copy(viewUp); c.enabled = true; c.update(); }
        else c.enabled = false;
      }
      invalidate();
      if (++n < 5 && !(fresh && n >= 2)) { requestAnimationFrame(settle); return; }
      busyRef.current = false;
      blendTarget.current = null;
      waiters.current.splice(0).forEach(r => r());
    };
    blendTarget.current = target ? target.clone() : null;
    if (viewUp) blendUp.current.copy(viewUp);
    settle();
  }, [controlsRef, invalidate]);

  // Snap: hedef etrafında sabit yarıçapla yörünge (yön slerp, konum lerp değil); tween boyunca damping kapalı ki ilk tıkta tam otursun.
  const snapToView = useCallback((dir: THREE.Vector3, up: THREE.Vector3) => {
    const cam = cameraRef.current;
    const controls = controlsRef.current;
    if (!cam || !controls) return;
    const target  = controls.target.clone();
    const dist    = cam.position.distanceTo(target);
    if (dist < 1e-6) return;
    const startDir = cam.position.clone().sub(target).normalize();
    const endDir   = dir.clone().normalize();
    const startUp  = cam.up.clone();
    const endUp    = up.clone().normalize();
    const fullRot = new THREE.Quaternion().setFromUnitVectors(startDir, endDir);
    const identity = new THREE.Quaternion();
    const frameRot = new THREE.Quaternion();
    const curDir   = new THREE.Vector3();
    const wasDamping = controls.enableDamping;
    controls.enableDamping = false;
    const t0 = performance.now(), dur = 350;
    const tick = () => {
      const raw = Math.min((performance.now() - t0) / dur, 1);
      const e = raw < 0.5 ? 2 * raw * raw : 1 - Math.pow(-2 * raw + 2, 2) / 2; // easeInOutQuad
      frameRot.copy(identity).slerp(fullRot, e);
      curDir.copy(startDir).applyQuaternion(frameRot);
      cam.position.copy(target).addScaledVector(curDir, dist);
      cam.up.copy(startUp).lerp(endUp, e).normalize();
      cam.lookAt(target);
      if (cam instanceof THREE.OrthographicCamera) cam.updateProjectionMatrix();
      controls.update();
      if (raw < 1) { requestAnimationFrame(tick); return; }
      cam.position.copy(target).addScaledVector(endDir, dist);
      cam.up.copy(endUp);
      cam.lookAt(target);
      controls.update();
      controls.enableDamping = wasDamping;
      // Standart (eksene dik) görünüş → ortografik; köşe / kenar görünüşü → otomatik girildiyse perspektife.
      const axial = Math.max(Math.abs(endDir.x), Math.abs(endDir.y), Math.abs(endDir.z)) > 0.999;
      void (window as any).__cameraAuto?.(axial ? 'ortho' : 'persp');
    };
    tick();
  }, [controlsRef]);

  useEffect(() => {
    const ORTHO = CameraType.ORTHOGRAPHIC, PERSP = CameraType.PERSPECTIVE;
    (window as any).__cameraAuto = (type: 'ortho' | 'persp'): Promise<void> => new Promise<void>(res => {
      const st = useAppStore.getState(), cur = st.cameraType;
      // Geçiş sürerken gelen istek kaybolmaz: süren geçiş bitince yeniden denenir (yüze girip hemen çıkmak gibi).
      if (busyRef.current) { waiters.current.push(() => { void ((window as any).__cameraAuto?.(type) ?? Promise.resolve()).then(res); }); return; }
      if (type === 'ortho') { if (cur === ORTHO) { res(); return; } autoRef.current = true; }
      else { if (cur !== ORTHO || !autoRef.current) { res(); return; } autoRef.current = false; }
      internalRef.current = true;
      waiters.current.push(res);
      st.setCameraType(type === 'ortho' ? ORTHO : PERSP);
    });
    return () => { delete (window as any).__cameraAuto; };
  }, []);

  // Store'daki tip değişti → geçiş. P→O: önce bu (perspektif) kamerada daral, sonra tipi değiştir. O→P: tipi değiştir, yeni kamerada aç.
  useEffect(() => {
    if (!internalRef.current) autoRef.current = false;
    internalRef.current = false;
    if (cameraType === shown) return;
    const cam = cameraRef.current, controls = controlsRef.current;
    if (!cam || !controls) { setShown(cameraType); return; }
    const target = controls.target.clone();
    const off = cam.position.clone().sub(target), dir = off.clone().normalize(), up = cam.up.clone();
    const h = size.height || window.innerHeight;
    const ep = ++epochRef.current;
    busyRef.current = true;
    blendTarget.current = target.clone();
    blendUp.current.copy(up);
    if (cameraType === CameraType.ORTHOGRAPHIC && cam instanceof THREE.PerspectiveCamera) {
      // Başlangıç kameranın O ANKİ açısıdır (yarıda kalmış bir açılmanın üstüne gelindiyse 45° değildir) → çerçeve yine korunur.
      const fov0 = cam.fov, dNow = off.length() || 1, tanNow = tanHalfDeg(fov0), d0 = dNow * tanNow / tanHalfDeg(PERSP_FOV), t0 = performance.now();
      controls.enabled = false;
      const tick = () => {
        if (ep !== epochRef.current) return;
        const raw = Math.min((performance.now() - t0) / CAMERA_BLEND_MS, 1), e = raw * raw * (3 - 2 * raw);
        const fov = fov0 + (NARROW_FOV - fov0) * e, d = dNow * tanNow / tanHalfDeg(fov);
        cam.fov = fov; cam.near = Math.max(1, d / 100); cam.far = d + 50000;
        cam.position.copy(target).addScaledVector(dir, d);
        cam.lookAt(target); cam.updateProjectionMatrix(); cam.updateMatrixWorld();
        invalidate();
        if (raw < 1) { requestAnimationFrame(tick); return; }
        savedRef.current = { position: target.clone().addScaledVector(dir, d0), target: target.clone(), up };
        if (useAppStore.getState().cameraType !== CameraType.ORTHOGRAPHIC) {
          // Daralma sürerken tip geri alındı: perspektif kamera eski açısına / yerine döner, kamera değişmez.
          cam.fov = PERSP_FOV; cam.near = Math.max(1, d0 / 100); cam.far = 50000;
          cam.position.copy(target).addScaledVector(dir, d0); cam.lookAt(target); cam.updateProjectionMatrix();
          finishBlend(target, up);
          return;
        }
        setShown(CameraType.ORTHOGRAPHIC);
      };
      tick();
    } else if (cameraType === CameraType.PERSPECTIVE && cam instanceof THREE.OrthographicCamera) {
      const d0 = Math.min(25000, Math.max(50, perspDistFor(cam.zoom, h)));
      savedRef.current = { position: target.clone().addScaledVector(dir, d0), target: target.clone(), up };
      enterRef.current = { target: target.clone(), dir, dist: d0 };
      setShown(CameraType.PERSPECTIVE);
    } else { busyRef.current = false; blendTarget.current = null; setShown(cameraType); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraType]);

  useEffect(() => {
    (window as any).__snapView = snapToView;
    return () => { delete (window as any).__snapView; };
  }, [snapToView]);

  // Orto ↔ perspektif: kamera kıpırdamaz, FOV sabit; yalnız projeksiyon değişir — pan/taşıma sonrası görünüm uçmaz.
  useLayoutEffect(() => {
    if (prevType.current === shown) return;
    const saved = savedRef.current;
    const cam = cameraRef.current;
    const controls = controlsRef.current;
    if (!saved || !cam || !controls) { prevType.current = shown; finishBlend(); return; }
    const target = saved.target.clone(), viewUp = saved.up.clone();
    const dist   = saved.position.distanceTo(target) || 1;
    const lookM = new THREE.Matrix4();
    const orient = (at: THREE.Vector3) => { cam.quaternion.setFromRotationMatrix(lookM.lookAt(cam.position, at, viewUp)); cam.updateMatrixWorld(); };
    cam.position.copy(saved.position);  // yerinde kal — dolly yok
    cam.up.set(0, 1, 0);                // yeni OrbitControls bu up'la kurulur (bkz. finishBlend)
    prevType.current = shown;
    if (shown === CameraType.ORTHOGRAPHIC && cam instanceof THREE.OrthographicCamera) {
      cam.zoom = orthoZoomFor(dist, size.height || window.innerHeight);
      cam.updateProjectionMatrix();
      orient(target);
      finishBlend(target, viewUp, controls);
      return;
    }
    const enter = enterRef.current;
    enterRef.current = null;
    if (shown === CameraType.PERSPECTIVE && cam instanceof THREE.PerspectiveCamera && enter) {
      // Ortografikten gelindi: dar açıyla (aynı çerçeve) başla, boyamadan önce yerleş, sonra PERSP_FOV'a açıl.
      const d0 = enter.dist, tan0 = tanHalfDeg(PERSP_FOV), t0 = performance.now(), ep = epochRef.current;
      const place = (e: number) => {
        const fov = NARROW_FOV + (PERSP_FOV - NARROW_FOV) * e, d = d0 * tan0 / tanHalfDeg(fov);
        cam.fov = fov; cam.near = Math.max(1, d / 100); cam.far = Math.max(50000, d + 50000);
        cam.position.copy(enter.target).addScaledVector(enter.dir, d);
        orient(enter.target); cam.updateProjectionMatrix();
        invalidate();
      };
      place(0);
      const tick = () => {
        if (ep !== epochRef.current) return;   // açılırken yeniden ortografik istendi: o geçiş bu kameranın şimdiki açısından sürdürür
        const c = controlsRef.current;
        if (c) { c.enabled = false; c.target.copy(enter.target); }
        const raw = Math.min((performance.now() - t0) / CAMERA_BLEND_MS, 1), e = raw * raw * (3 - 2 * raw);
        place(e);
        if (raw < 1) { requestAnimationFrame(tick); return; }
        cam.far = 50000; cam.updateProjectionMatrix();
        finishBlend(enter.target, viewUp, controls);
      };
      requestAnimationFrame(tick);
      return;
    }
    if (cam instanceof THREE.PerspectiveCamera) { cam.fov = PERSP_FOV; cam.updateProjectionMatrix(); }
    orient(target);
    finishBlend(target, viewUp, controls);
  }, [shown, controlsRef, size.height, finishBlend, invalidate]);

  useEffect(() => {
    // Otomatik ortografikten çıkış: görünüm döndürülüp bırakılınca perspektif (sürüklerken kamera değişirse sürükleme kopar).
    let dir0: THREE.Vector3 | null = null;
    const dirOf = (c: any) => c.object.position.clone().sub(c.target).normalize();
    const onStart = () => { const c = boundControls.current; dir0 = c && !busyRef.current ? dirOf(c) : null; };
    const onEnd = () => {
      const c = boundControls.current;
      if (!c || !dir0 || busyRef.current || !autoRef.current) return;
      if (dirOf(c).angleTo(dir0) > 0.02) void (window as any).__cameraAuto?.('persp');
    };
    const bind = (c: any) => {
      const old = boundControls.current;
      if (old === c) return;
      old?.removeEventListener?.('start', onStart); old?.removeEventListener?.('end', onEnd);
      c?.addEventListener?.('start', onStart); c?.addEventListener?.('end', onEnd);
      boundControls.current = c ?? null;
    };
    const id = setInterval(() => {
      const cam = cameraRef.current, controls = controlsRef.current;
      if (!cam || !controls) return;
      bind(controls);
      if (busyRef.current) return;
      savedRef.current = { position: cam.position.clone(), target: controls.target.clone(), up: cam.up.clone() };
    }, 100);
    return () => { clearInterval(id); bind(null); };
  }, [controlsRef]);

  // Dinamik near: sabit near'da uzakta polygonOffset panel kalınlığını aşar; near = uzaklık / 100 (≥ 1). Ortografik etkilenmez.
  useFrame(() => {
    const cam = cameraRef.current, controls = controlsRef.current;
    if (!(cam instanceof THREE.PerspectiveCamera) || !controls || busyRef.current) return;
    const near = Math.max(1, cam.position.distanceTo(controls.target) / 100);
    if (Math.abs(near - cam.near) / cam.near > 0.05) { cam.near = near; cam.updateProjectionMatrix(); }
  });

  // SOL ŞERİT KAYMASI — sahne şeritle birlikte akar: şerit kayarken tuval TAM genişlikte kalır (DraftViewport açılışta kayma bitince
  // daralır, kapanışta hemen genişler); her karede kamera projeksiyonu (setViewOffset) şeridin GERÇEK kenarına göre kaydırılır → gövde
  // görünen alanın ortasına süzülür. Daralınca yatayda sığmayacak gövde için kamera yalnız GEREKTİĞİ kadar geri çekilir (daralmadan önce de
  // sığmıyorsa — yakın çalışma — dokunulmaz), şerit kapanınca verilen pay geri alınır; ikisi de şeridin yolu boyunca, oranla.
  // Kaymanın sonunda tuval boyutu değişir: R3F yeni boyutu ResizeObserver → React ile bir kare geç görür → değiştiği karede burada uygulanır,
  // projeksiyon kaydırması da gerçek dikdörtgenlerden hesaplandığından el değişiminde sahne kımıldamaz.
  const sbInset = useAppStore(st => st.sidebarInset);
  const prevInset = useRef(sbInset);
  const pulled = useRef({ persp: 0, ortho: 0 });   // şerit yüzünden verilmiş pay (perspektif: dünya birimi geri · ortografik: ln yakınlaştırma)
  const glide = useRef<{ from: number; to: number; t0: number; pull: { persp: number; ortho: number }; done: number; still: number; lastV: number } | null>(null);
  const offCam = useRef<THREE.Camera | null>(null);
  useEffect(() => {
    const from0 = prevInset.current;
    prevInset.current = sbInset;
    if (from0 === sbInset) return;
    const cv = document.querySelector('[data-yago-viewport] canvas') as HTMLCanvasElement | null;
    const vp = cv?.closest('[data-yago-viewport]') as HTMLElement | null, par = vp?.parentElement;
    const from = par ? sidebarVisualInset(par.getBoundingClientRect()) ?? from0 : from0;
    let pull = { persp: 0, ortho: 0 };
    const cam = cameraRef.current, controls = controlsRef.current;
    if (sbInset < from) pull = { persp: -pulled.current.persp, ortho: -pulled.current.ortho };   // açılıyor değil → verilen pay geri
    else if (vp && par && cam && controls?.target && !busyRef.current) {
      const right = vp.getBoundingClientRect().right, left = par.getBoundingClientRect().left;
      pull = sidebarFitPull(cam, controls, right - (left + from), right - (left + sbInset), size.height || 1);
    }
    glide.current = { from, to: sbInset, t0: performance.now(), pull, done: 0, still: 0, lastV: NaN };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sbInset]);
  useFrame(state => {
    const g = glide.current;
    if (!g) return;
    const cam = state.camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    if (offCam.current && offCam.current !== cam) (offCam.current as THREE.PerspectiveCamera).clearViewOffset?.();
    offCam.current = cam;
    const cv = state.gl.domElement, wrapEl = cv.parentElement, vp = cv.closest('[data-yago-viewport]'), par = vp?.parentElement;
    const end = () => { if (cam.view?.enabled) cam.clearViewOffset(); glide.current = null; };
    if (!wrapEl || !vp || !par) { end(); return; }
    // Kap yeni boyuttaysa R3F'in görmesi beklenmez: tuval + kamera bu karede güncellenir.
    const wr = wrapEl.getBoundingClientRect();
    if (Math.abs(wr.width - state.size.width) > 0.5 || Math.abs(wr.height - state.size.height) > 0.5) {
      state.setSize(wr.width, wr.height, undefined, wr.top, wr.left);
    }
    const pr = par.getBoundingClientRect(), vr = vp.getBoundingClientRect();
    const v = sidebarVisualInset(pr) ?? g.to;
    // Geri çekilme: şeridin yolundaki ilerleme oranında.
    const e = Math.abs(g.to - g.from) < 0.5 ? 1 : Math.min(1, Math.max(0, (v - g.from) / (g.to - g.from)));
    const d = e - g.done, controls = controlsRef.current;
    if (Math.abs(d) > 1e-5 && controls?.target && !busyRef.current) {
      if (cam instanceof THREE.PerspectiveCamera && g.pull.persp) {
        const dir = cam.position.clone().sub(controls.target), dist = dir.length() || 1;
        const next = dist + g.pull.persp * d;
        if (next >= 50) { cam.position.copy(controls.target).addScaledVector(dir.normalize(), next); pulled.current.persp += g.pull.persp * d; }
      } else if (cam instanceof THREE.OrthographicCamera && g.pull.ortho) {
        cam.zoom *= Math.exp(g.pull.ortho * d); cam.updateProjectionMatrix(); pulled.current.ortho += g.pull.ortho * d;
      }
      g.done = e;
    }
    if (g.to < g.from && e >= 1) pulled.current = { persp: 0, ortho: 0 };
    // Görünen alanın ortası ↔ tuvalin ortası: fark projeksiyonla kaydırılır.
    const visL = Math.max(vr.left, Math.min(vr.right - 120, pr.left + v));
    const off = (visL + vr.right) / 2 - (wr.left + wr.width / 2);
    if (Math.abs(off) > 0.25) cam.setViewOffset(wr.width, wr.height, -off, 0, wr.width, wr.height);
    else if (cam.view?.enabled) cam.clearViewOffset();
    g.still = Math.abs(v - g.lastV) < 0.3 ? g.still + 1 : 0;
    g.lastV = v;
    const age = performance.now() - g.t0;
    if (g.still >= 3 && ((age > 200 && e >= 1 && Math.abs(off) <= 0.25) || age > 2600)) end();   // şerit durduysa; el değişimi gecikirse 2,6 s güvenlik
  }, -3);

  // Mount prop'ları yalnız kamera tipi değişince; yoksa R3F etkileşim ortasında yeniden uygular, kamera kontrolden kopar.
  const mount = useMemo(() => {
    const s = savedRef.current;
    if (!s) return { position: [2000, 2000, 2000] as [number, number, number], zoom: 0.25 };
    const dist = s.position.distanceTo(s.target) || 1;
    return { position: s.position.toArray() as [number, number, number], zoom: orthoZoomFor(dist, size.height || window.innerHeight) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  return shown === CameraType.PERSPECTIVE
    ? <PerspectiveCamera ref={cameraRef as React.RefObject<THREE.PerspectiveCamera>} makeDefault position={mount.position} fov={PERSP_FOV}
      near={1} far={50000} />
    : <OrthographicCamera ref={cameraRef as React.RefObject<THREE.OrthographicCamera>} makeDefault position={mount.position} zoom={mount.zoom}
      near={-50000} far={50000} />;
};

// Taşıma-ref hedef panel seçici: R3F raycast'ini bilerek atlar; canvas tıklamasında tüm panelleri tarar (ışın sırası: Tab ile arkadaki).

function MoveRefPanelPicker({ shapes }: { shapes: any[] }) {
  const { camera, gl } = useThree();
  const { panelMoveMode, panelMoveValueMode, panelMoveRefSourceVertex, panelMoveRefTargetPanelId, panelMoveTargetPanelId } =
    useStoreFields('panelMoveMode', 'panelMoveValueMode', 'panelMoveRefSourceVertex', 'panelMoveRefTargetPanelId', 'panelMoveTargetPanelId');
  // Kaynak seçildikten sonra hedef PANEL seçilene kadar aktif. Tıklanan panel yalnız bırakılır (köşesi orada seçilir); ışının arkadaki
  // panelleri sıraya yazılır → yalnızken Tab sıradakine geçer.
  const active = panelMoveMode && panelMoveValueMode === 'ref' && !!panelMoveRefSourceVertex && !panelMoveRefTargetPanelId;

  useEffect(() => {
    if (!active) return;
    const canvas = gl.domElement;
    const handler = (ev: MouseEvent) => {
      if (ev.button !== 0) return;
      if (_hoveredDot?.visible && _hoveredDot.parent) return;   // hedef KÖŞE tıklandı: hedef panel değişmesin (köşe eski panelin, panel öndeki olurdu)
      const rect = canvas.getBoundingClientRect();
      const ndcX = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
      const idMap = new Map<THREE.Mesh, string>();
      for (const p of shapes) {
        if (p.type !== 'panel' || !p.geometry || p.id === panelMoveTargetPanelId) continue;
        const m = new THREE.Mesh(p.geometry);
        m.matrixWorld.copy(getShapeMatrix(p));
        m.matrixAutoUpdate = false;
        idMap.set(m, p.id);
      }
      const hits = raycaster.intersectObjects([...idMap.keys()], false);
      if (hits.length === 0) return;
      const ordered = [...new Set(hits.map(h => idMap.get(h.object as THREE.Mesh)).filter((id): id is string => !!id))];
      if (ordered.length === 0) return;
      _refPanelRing = { ids: ordered, idx: 0 };
      isolateRefShape('move', ordered[0]);
    };
    canvas.addEventListener('click', handler, true);
    return () => canvas.removeEventListener('click', handler, true);
  }, [active, shapes, camera, gl, panelMoveTargetPanelId]);

  return null;
}

/** Ref akışı sağ tık onayı: hazır değilse yalnız menüyü engeller. capture=true → orbit/diğer contextmenu dinleyicilerinden önce. */
function RefConfirmOnRightClick({ active, ready, confirm }: { active: boolean; ready: () => boolean; confirm: () => Promise<unknown> }) {
  const { gl } = useThree();
  useEffect(() => {
    if (!active) return;
    const canvas = gl.domElement;
    let busy = false;
    const handler = async (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (busy || !ready()) return;
      busy = true;
      try { await confirm(); } finally { busy = false; }
    };
    canvas.addEventListener('contextmenu', handler, true);
    return () => canvas.removeEventListener('contextmenu', handler, true);
  }, [active, gl]);
  return null;
}

const moveRefReady = () => {
  const st = useAppStore.getState();
  return st.panelMoveMode && st.panelMoveValueMode === 'ref' && !!st.panelMoveRefSourceVertex && !!st.panelMoveRefTargetPanelId
    && !!st.panelMoveRefTargetVertex && !!shapeById(st.panelMoveTargetPanelId, st.shapes);
};
function MoveRefConfirmOnRightClick() {
  const { panelMoveMode, panelMoveValueMode, panelMoveRefSourceVertex } = useStoreFields('panelMoveMode', 'panelMoveValueMode', 'panelMoveRefSourceVertex');
  return <RefConfirmOnRightClick active={panelMoveMode && panelMoveValueMode === 'ref' && !!panelMoveRefSourceVertex} ready={moveRefReady}
    confirm={async () => {
      if (!(await confirmPanelMoveRef())) return;   // aynı noktaya taşıma: seçim durur
      useAppStore.getState().setPanelMoveValueMode('ref');   // seçimler sıfırlanır, araç açık kalır (sıradaki taşıma için)
    }} />;
}

const rotateRefReady = () => {
  const st = useAppStore.getState();
  return st.panelRotateMode && st.panelRotateValueMode === 'ref' && !!st.panelRotatePivot && !!st.panelRotateRefArmVertex && st.panelRotateAxis !== null
    && !!st.panelRotateRefFace && !!shapeById(st.panelRotateTargetPanelId, st.shapes);
};
/** Ref-dönüş: referans bir YÜZ (panel → yalnız bırak → yüz; bkz. REFERANS SEÇİMİ); burada yalnız onay. */
function RotateRefConfirmOnRightClick() {
  const { panelRotateMode, panelRotateValueMode, panelRotatePivot } = useStoreFields('panelRotateMode', 'panelRotateValueMode', 'panelRotatePivot');
  return <RefConfirmOnRightClick active={panelRotateMode && panelRotateValueMode === 'ref' && !!panelRotatePivot} ready={rotateRefReady}
    confirm={async () => {
      if (!(await confirmPanelRotateRef())) return;   // açı çözülemedi: seçim durur
      useAppStore.getState().setPanelRotateValueMode('ref');   // seçimler sıfırlanır, araç açık kalır
    }} />;
}

/* ─────────────────────────── REFERANS SEÇİMİ ───────────────────────────
   Extrude · hacim · döndürme · taşıma ortak akışı (Goker): ÖNCE PANEL tıklanır → o panel YALNIZ bırakılır (öteki her şey gizlenir, çevresinde
   dönülebilir) → YÜZÜ seçilir (taşımada köşesi) → sahne geri gelir, seçilen yüz vurgulu kalır → sağ tık onaylar.
   Eski akışta yüz doğrudan ışınla seçiliyordu: gövde yüzüyle aynı düzlemdeki panellerde tıklama yutuluyor, panelde seçilen yüz hiç
   vurgulanmıyordu ("neresi seçili anlamadım"). Yalnız bırakılan panelde HER yüz tıklanabilir; referans olamayan yüz (extrude yönüne paralel,
   eğri) koyu gösterilir ve nedeni durum çubuğuna yazılır.
   Aşama depodan türetilir (`refPickOf`): extrude / döndürmede yalnız bırakılan şey `refIsolateId`, taşımada hedef panel (köşesi seçilene kadar). */
type RefPick = {
  tool: 'extrude' | 'rotate' | 'move';
  /** panel: referans paneli bekleniyor · isolated: panel yalnız, yüzü / köşesi bekleniyor · picked: seçildi, onay bekleniyor */
  stage: 'panel' | 'isolated' | 'picked';
  isoId: string | null; /** aracın kendi paneli (referans olamaz) */ ownerId: string | null; /** hacim: grubun üyeleri referans olamaz */ cavityId: string | null;
};
type AppState = ReturnType<typeof useAppStore.getState>;
function refPickOf(st: Pick<AppState, 'faceExtrudeMode' | 'faceExtrudeValueMode' | 'faceExtrudeSelectedFace' | 'faceExtrudePlinthId' | 'faceExtrudeRefCandidate'
  | 'faceExtrudeTargetPanelId' | 'faceExtrudeCavityGroupId' | 'refIsolateId' | 'panelRotateMode' | 'panelRotateValueMode' | 'panelRotatePivot'
  | 'panelRotateRefArmVertex' | 'panelRotateAxis' | 'panelRotateRefFace' | 'panelRotateTargetPanelId' | 'panelMoveMode' | 'panelMoveValueMode'
  | 'panelMoveRefSourceVertex' | 'panelMoveRefTargetPanelId' | 'panelMoveRefTargetVertex' | 'panelMoveTargetPanelId'>): RefPick | null {
  const faceStage = (picked: boolean): RefPick['stage'] => (st.refIsolateId ? 'isolated' : picked ? 'picked' : 'panel');
  if (st.faceExtrudeMode && st.faceExtrudeValueMode === 'ref' && st.faceExtrudeSelectedFace !== null && !st.faceExtrudePlinthId) {
    const c = st.faceExtrudeRefCandidate;
    return { tool: 'extrude', stage: faceStage(!!c && c.faceGroupIndex >= 0), isoId: st.refIsolateId, ownerId: st.faceExtrudeTargetPanelId, cavityId: st.faceExtrudeCavityGroupId };
  }
  if (st.panelRotateMode && st.panelRotateValueMode === 'ref' && !!st.panelRotatePivot && !!st.panelRotateRefArmVertex && st.panelRotateAxis !== null) {
    const c = st.panelRotateRefFace;
    return { tool: 'rotate', stage: faceStage(!!c && c.faceGroupIndex >= 0), isoId: st.refIsolateId, ownerId: st.panelRotateTargetPanelId, cavityId: null };
  }
  if (st.panelMoveMode && st.panelMoveValueMode === 'ref' && !!st.panelMoveRefSourceVertex) {
    const tp = st.panelMoveRefTargetPanelId, tv = st.panelMoveRefTargetVertex;
    return { tool: 'move', stage: tv ? 'picked' : tp ? 'isolated' : 'panel', isoId: tp && !tv ? tp : null, ownerId: st.panelMoveTargetPanelId, cavityId: null };
  }
  return null;
}
function useRefPick(): RefPick | null {
  return refPickOf(useStoreFields('faceExtrudeMode', 'faceExtrudeValueMode', 'faceExtrudeSelectedFace', 'faceExtrudePlinthId', 'faceExtrudeRefCandidate',
    'faceExtrudeTargetPanelId', 'faceExtrudeCavityGroupId', 'refIsolateId', 'panelRotateMode', 'panelRotateValueMode', 'panelRotatePivot',
    'panelRotateRefArmVertex', 'panelRotateAxis', 'panelRotateRefFace', 'panelRotateTargetPanelId', 'panelMoveMode', 'panelMoveValueMode',
    'panelMoveRefSourceVertex', 'panelMoveRefTargetPanelId', 'panelMoveRefTargetVertex', 'panelMoveTargetPanelId'));
}
/** Son panel tıklamasının ışın sırası: yalnız bırakılmışken Tab sıradaki (arkadaki) panele geçer. */
let _refPanelRing: { ids: string[]; idx: number } | null = null;
function isolateRefShape(tool: RefPick['tool'], id: string) {
  const st = useAppStore.getState();
  if (tool === 'move') { st.setPanelMoveRefTargetPanelId(id); st.setPanelMoveRefTargetVertex(null); return; }
  if (tool === 'rotate') st.setPanelRotateRefFace(null); else st.setFaceExtrudeRefCandidate(null);
  st.setRefIsolateId(id);
}
/** Referans PANELİ tıklaması (extrude · hacim · döndürme): ışının geçtiği paneller derinlik sırasıyla, gövde EN SONDA (panelli gövdenin mesh'i
 *  görünmez — ilk tık her zaman görünen paneli alır). Tıklanan yalnız bırakılır. */
function pickRefPanelFromEvent(e: any, rp: RefPick) {
  const st = useAppStore.getState();
  const panels: string[] = [], bodies: string[] = [];
  for (const hit of (e.intersections ?? []) as THREE.Intersection[]) {
    let id: string | null = null;
    for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) if (o.name?.startsWith('shape-')) { id = o.name.slice(6); break; }
    if (!id || id === rp.ownerId) continue;
    const sh = shapeById(id, st.shapes);
    if (!sh?.geometry) continue;
    if (sh.type !== 'panel') { if (!bodies.includes(id)) bodies.push(id); continue; }
    if (rp.cavityId && sh.parameters?.panelGroupId === rp.cavityId) continue;
    if (!panels.includes(id)) panels.push(id);
  }
  const ids = [...panels, ...bodies];
  if (!ids.length) return;
  _refPanelRing = { ids, idx: 0 };
  isolateRefShape(rp.tool, ids[0]);
}
/** Tab: yalnız bırakılmış panelden, aynı tıklamanın arkasındaki sıradaki panele. */
function cycleRefPanel(): boolean {
  const rp = refPickOf(useAppStore.getState());
  if (!rp || rp.stage !== 'isolated' || !_refPanelRing || _refPanelRing.ids.length < 2) return false;
  const at = _refPanelRing.ids.indexOf(rp.isoId ?? '');
  if (at < 0) return false;
  _refPanelRing.idx = (at + 1) % _refPanelRing.ids.length;
  isolateRefShape(rp.tool, _refPanelRing.ids[_refPanelRing.idx]);
  return true;
}
const refRingCount = () => _refPanelRing?.ids.length ?? 0;

/** Referans şeklinin yüz ağı: panelde kendi ağı, gövdede çizilen (vertex düzenlemeli) ağ — motorun `matchReferenceFace`i aynısını okur. */
const refGeometryOf = (shape: Shape): THREE.BufferGeometry | undefined => (shape.type === 'panel' ? shape.geometry : effectiveBodyGeometry(shape));
/** Hareket eden yüzün dünya normali (extrude / hacim): referans yüzün geçerliliği buna göre. Döndürmede null. */
function refMovingNormal(st: AppState, rp: RefPick): { n: THREE.Vector3; min: number } | null {
  if (rp.tool !== 'extrude' || st.faceExtrudeSelectedFace === null) return null;
  if (rp.cavityId) {
    const g = st.panelGroups.find(x => x.id === rp.cavityId), body = g ? shapeById(g.shapeId, st.shapes) : undefined, n = st.faceExtrudeCavityFaceNormal;
    return body && n ? { n: new THREE.Vector3(...n).transformDirection(getShapeMatrix(body)), min: 0.7 } : null;
  }
  const panel = shapeById(rp.ownerId, st.shapes);
  const g = panel?.geometry ? getFacesAndGroups(panel.geometry).groups[st.faceExtrudeSelectedFace] : undefined;
  return panel && g ? { n: g.normal.clone().normalize().transformDirection(getShapeMatrix(panel)), min: 0.5 } : null;
}

/** YALNIZ BIRAKILAN panelin / gövdenin yüz seçimi: üzerine gelinen yüz vurgulanır, referans olamayanlar koyu durur (nedeni durum çubuğunda),
 *  geçerli yüze tık referansı yazar ve sahneyi geri getirir. */
function RefIsolatePicker({ rp }: { rp: RefPick }) {
  const s = useStoreFields('shapes', 'faceExtrudeSelectedFace', 'faceExtrudeCavityFaceNormal', 'panelGroups');
  const shape = shapeById(rp.isoId, s.shapes);
  const geometry = useMemo(() => (shape ? refGeometryOf(shape) : undefined), [shape?.geometry, shape?.vertexModifications]);   // eslint-disable-line react-hooks/exhaustive-deps
  const { faces, groups } = useMemo(() => (geometry ? getFacesAndGroups(geometry) : NO_FACES), [geometry]);
  const matrix = useMemo(() => (shape ? getShapeMatrix(shape) : new THREE.Matrix4()), [shape?.position, shape?.rotation, shape?.scale]);   // eslint-disable-line react-hooks/exhaustive-deps
  const moving = useMemo(() => refMovingNormal(useAppStore.getState(), rp), [rp.tool, rp.cavityId, rp.ownerId, s.faceExtrudeSelectedFace, s.faceExtrudeCavityFaceNormal]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Yüz başına hüküm: null = referans olabilir, metin = neden olamaz.
  const verdicts = useMemo(() => groups.map((g: CoplanarFaceGroup): string | null => {
    if (g.isCurved) return 'Curved face — pick a flat face';
    if (!moving) return null;
    const dot = Math.abs(g.normal.clone().normalize().transformDirection(matrix).dot(moving.n));
    return dot >= moving.min ? null : rp.cavityId ? 'This face is not square to the volume face — it cannot be reached'
      : 'This face runs along the direction the edge moves — the edge can never reach it';
  }), [groups, moving, matrix, rp.cavityId]);
  const [hover, setHover] = useState<number | null>(null);
  const blockedGeo = useMemo(() => {
    const idx = groups.flatMap((g: CoplanarFaceGroup, i: number) => (verdicts[i] ? g.faceIndices : []));
    return idx.length ? createFaceHighlightGeometry(faces, idx) : null;
  }, [faces, groups, verdicts]);
  const hoverGeo = useMemo(() => groupHighlight(faces, groups, hover), [faces, groups, hover]);
  useDisposable(blockedGeo); useDisposable(hoverGeo);
  const edges = useMemo(() => (hoverGeo ? edgePointsOf(hoverGeo, 1) : []), [hoverGeo]);
  useEffect(() => () => { hoverCursor(false); useAppStore.getState().setRefPickNote(null); }, []);
  if (!shape || !geometry) return null;
  const giOf = (e: any) => { const gi = groupIndexOfFace(groups, e.faceIndex); return gi >= 0 ? gi : null; };
  const note = (gi: number | null) => useAppStore.getState().setRefPickNote(gi === null ? null : verdicts[gi] ?? `Click to use this face (${dominantAxisLabel(groups[gi].normal)})`);
  const ok = hover !== null && !verdicts[hover];
  return (
    <group matrix={matrix} matrixAutoUpdate={false}>
      <mesh geometry={geometry} renderOrder={10} onContextMenu={stopEvent}
        onPointerMove={(e: any) => { e.stopPropagation(); const gi = giOf(e); if (gi !== hover) { setHover(gi); note(gi); document.body.style.cursor = gi !== null && verdicts[gi] ? 'not-allowed' : 'pointer'; } }}
        onPointerOut={() => { setHover(null); note(null); hoverCursor(false); }}
        onClick={(e: any) => {
          e.stopPropagation();
          const gi = giOf(e);
          if (gi === null || verdicts[gi]) return;
          const N = groups[gi].normal.clone().normalize().transformDirection(matrix), st = useAppStore.getState();
          const pick = { panelId: shape.id, faceGroupIndex: gi, normalWorld: [N.x, N.y, N.z] as Vec3, pointWorld: [e.point.x, e.point.y, e.point.z] as Vec3 };
          if (rp.tool === 'rotate') st.setPanelRotateRefFace(pick); else st.setFaceExtrudeRefCandidate(pick);
        }}>
        <HitMaterial />
      </mesh>
      {blockedGeo && <mesh geometry={blockedGeo} renderOrder={11} raycast={noRaycast}><OverlayMat color={0x44403c} opacity={0.3} /></mesh>}
      {hoverGeo && ok && (
        <>
          <OverlayMesh geometry={hoverGeo} order={12} color={REF_COLORS.selected} opacity={0.55} />
          <EdgeLines points={edges} color={SCENE_EX.ref.main} width={2} order={13} />
        </>
      )}
    </group>
  );
}

/** SEÇİLEN referans yüz (onay bekleniyor): sahne geri geldiğinde yüz, öteki panellerin arkasında kalsa da vurgulu görünür. */
function RefFaceMark({ rp }: { rp: RefPick }) {
  const s = useStoreFields('shapes', 'faceExtrudeRefCandidate', 'panelRotateRefFace');
  const cand = rp.tool === 'rotate' ? s.panelRotateRefFace : s.faceExtrudeRefCandidate;
  const shape = cand ? shapeById(cand.panelId, s.shapes) : undefined;
  const geometry = useMemo(() => (shape ? refGeometryOf(shape) : undefined), [shape?.geometry, shape?.vertexModifications]);   // eslint-disable-line react-hooks/exhaustive-deps
  const geo = useMemo(() => {
    if (!geometry || !cand || cand.faceGroupIndex < 0) return null;
    const { faces, groups } = getFacesAndGroups(geometry);
    return groupHighlight(faces, groups, cand.faceGroupIndex);
  }, [geometry, cand?.faceGroupIndex]);   // eslint-disable-line react-hooks/exhaustive-deps
  useDisposable(geo);
  const edges = useMemo(() => (geo ? edgePointsOf(geo, 1) : []), [geo]);
  if (!shape || !geo) return null;
  return (
    <group matrix={getShapeMatrix(shape)} matrixAutoUpdate={false}>
      <OverlayMesh geometry={geo} order={12} color={REF_COLORS.selected} opacity={REF_COLORS.selectedOpacity} />
      <EdgeLines points={edges} color={SCENE_EX.ref.main} width={2.2} order={13} />
    </group>
  );
}

const extrudeRefReady = () => refPickOf(useAppStore.getState())?.stage === 'picked';
/** Extrude / hacim referansı: sağ tık onaylar (yüz seçilmeden yalnız menüyü engeller). Araç açık kalır. */
function ExtrudeRefConfirmOnRightClick() {
  const rp = useRefPick();
  return <RefConfirmOnRightClick active={rp?.tool === 'extrude'} ready={extrudeRefReady}
    confirm={async () => {
      const st = useAppStore.getState(), gid = st.faceExtrudeCavityGroupId, cand = st.faceExtrudeRefCandidate, n = st.faceExtrudeCavityFaceNormal;
      if (!gid) { await confirmRefFaceExtrude(); return; }
      if (!cand || !n) return;
      await executeCavityExtrudeToReference(gid, n, cand, st.faceExtrudeClickPoint);
      const now = useAppStore.getState();
      now.setFaceExtrudeSelectedFace(null); now.setFaceExtrudeCavityFaceNormal(null); now.setFaceExtrudeRefCandidate(null);
    }} />;
}

/* ─────────────────────────── SAHNE EXTRUDE ───────────────────────────
   Tek başına seçili panelin her düz yüzünde: Fixed / Dyn modunda OK, Ref modunda NOKTA. Tip (Fixed / Dyn / Ref) HER OKUN KENDİSİNE aittir: okun yanındaki
   döngü düğmesi (SceneExTypeBtn) o okun tipini çevirir, okun dönmesi tipi anlatır; açıklama durum çubuğunda. Araç Assembly'deki
   Extrude düğmesiyle açılır (sceneExtrudePanelId). Değer girişi okun ucunda, çerçevesiz. Ok kenarın GİDECEĞİ yöne bakar: Fixed içeri (kenar karşı kenardan ölçülen sabit
   ölçüye çekilir), Dyn dışarı (değer kadar oynar); girilen değer yönü değiştirirse ok da döner. Üzerine gelinen / seçili kenarın nereye
   gideceğini akan hayalet çizgiler ve taranan hacim gösterir (kısalma kırmızı, uzama mavi). Adım motoru aynı: executeFaceExtrude / ref onayı. */

type SceneExMode = 'fixed' | 'dyn' | 'ref';
const SCENE_EX_ORDER: SceneExMode[] = ['fixed', 'dyn', 'ref'];
const SCENE_EX_LABEL: Record<SceneExMode, string> = { fixed: 'Fixed', dyn: 'Dyn', ref: 'Ref' };
/** Okların tipi panel başına, oturum boyunca hatırlanır (anahtar: yüzün kalıcı adı — `SceneFace.key`). Kayda yazılmaz. */
const _exTypes = new Map<string, Record<string, SceneExMode>>();
const SCENE_EX = {
  fixed: { main: '#1f5578', lit: '#2f7fb3' }, dyn: { main: '#d9540a', lit: '#f97316' }, ref: { main: '#a16207', lit: '#ca8a04' },
  rim: '#fffdf9', shrink: '#d9480f', grow: '#2f7fb3', ink: '#292524',
} as const;
const EX_GAP = 0.2, EX_Y = new THREE.Vector3(0, 1, 0);

/** Ok: tek parça döner gövde (ince sap + geriye taranmış uç), birim boy, +Y'ye bakar; `pad` kadar şişirilmişi fildişi kenar çizgisidir. */
const exArrowLathe = (pad: number) => new THREE.LatheGeometry([
  new THREE.Vector2(0, -0.5 - pad), new THREE.Vector2(0.02 + pad, -0.5 - pad), new THREE.Vector2(0.027 + pad, 0.2 - pad * 0.4),
  new THREE.Vector2(0.108 + pad * 1.5, 0.04 - pad * 1.9), new THREE.Vector2(0, 0.5 + pad * 2.4),
], 32);
const EX_ARROW = { body: exArrowLathe(0), rim: exArrowLathe(0.015), knob: new THREE.SphereGeometry(0.044, 20, 14), knobRim: new THREE.SphereGeometry(0.06, 20, 14) };

type SceneFace = {
  gi: number;
  /** rebuild'ler arası kalıcı ad: bakış yönü + o yöndeki sıra (ok tipi buna bağlanır; `gi` her üretimde değişebilir) */ key: string;
  /** yüz normali ve yüz ÜSTÜNDE bir nokta (panel-yerel) */ n: THREE.Vector3; anchor: THREE.Vector3;
  /** Fixed ölçüsü: karşı kutu sınırından bu yüze (motorun `faceDist`i) */ span: number;
  /** Dimensions edit'in Fixed ölçüsü: katının yüz NORMALİ boyunca yüzün arkasındaki boyu (motorun `planeSpanOf`u) */ spanN?: number;
  /** Dimensions edit: yüz düzlemi 1 mm oynarken sınır köşelerinin kayması (komşu yüzlerin düzleminde; anahtar = `ptKey`). Yoksa köşe dik gider. */
  shifts?: Map<string, THREE.Vector3>;
  /** motorun yüz eşlemesi için örnek nokta (adımın `samplePoint`i) */ sample: Vec3;
  /** büyük yüz (kalınlık yönü): ok yerine küçük nokta, üzerine gelince ok; arkası dönükken gizli */ thick: boolean;
  /** yüzün uzun ekseni boyunca orta çizgi (yüzün İÇİNDE kalıyorsa): işaret ekran dışına düşünce bu ray üstünde görünen yere kayar */
  rail: [THREE.Vector3, THREE.Vector3] | null;
  fill: THREE.BufferGeometry; edges: Vec3[];
};

/** Yüzün işaret çıpası: alan ağırlıklı merkez; yüzün dışına düşerse (L / U yüz) ona en yakın üçgenin merkezi. */
function faceAnchorOf(faces: FaceData[], g: CoplanarFaceGroup): THREE.Vector3 {
  const c = new THREE.Vector3();
  let area = 0;
  for (const fi of g.faceIndices) { const f = faces[fi]; if (f) { c.addScaledVector(f.center, f.area); area += f.area; } }
  if (area > 0) c.divideScalar(area); else c.copy(g.center);
  if (g.faceIndices.some(fi => { const v = faces[fi]?.vertices; return !!v && pointInTriangle3D(c, v[0], v[1], v[2]); })) return c;
  let anchor = c, best = Infinity;
  for (const fi of g.faceIndices) { const f = faces[fi]; if (!f) continue; const d = f.center.distanceToSquared(c); if (d < best) { best = d; anchor = f.center.clone(); } }
  return anchor;
}
/** Ray: en uzun kenarın yönünde, çıpadan geçen doğru parçası (uçlardan içeri); ara noktaları yüzün içindeyse geçerli. */
function faceRailOf(faces: FaceData[], g: CoplanarFaceGroup, anchor: THREE.Vector3, edges: Vec3[]): SceneFace['rail'] {
  let long = 0;
  const dir = new THREE.Vector3(), e = new THREE.Vector3();
  for (let i = 0; i + 1 < edges.length; i += 2) {
    const l = e.set(edges[i + 1][0] - edges[i][0], edges[i + 1][1] - edges[i][1], edges[i + 1][2] - edges[i][2]).length();
    if (l > long) { long = l; dir.copy(e).divideScalar(l); }
  }
  if (long <= 1) return null;
  let lo = 0, hi = 0;
  for (const fi of g.faceIndices) for (const v of faces[fi]?.vertices ?? []) { const t = e.copy(v).sub(anchor).dot(dir); if (t < lo) lo = t; if (t > hi) hi = t; }
  const pad = Math.min((hi - lo) * 0.12, 40);
  const a = anchor.clone().addScaledVector(dir, lo + pad), b = anchor.clone().addScaledVector(dir, hi - pad);
  const inside = (q: THREE.Vector3) => g.faceIndices.some(fi => { const v = faces[fi]?.vertices; return !!v && pointInTriangle3D(q, v[0], v[1], v[2]); });
  return hi - lo > 60 && [0, 0.25, 0.5, 0.75, 1].every(t => inside(a.clone().lerp(b, t))) ? [a, b] : null;
}
/** Kalıcı adlar: bakış yönü + o yöndeki sıra (ok tipi buna bağlanır). */
function nameSceneFaces(out: SceneFace[]) {
  const byLabel = new Map<string, SceneFace[]>();
  for (const f of out) { const l = dominantAxisLabel(f.n); byLabel.set(l, [...(byLabel.get(l) ?? []), f]); }
  for (const [l, list] of byLabel) {
    list.sort((a, b) => a.anchor.dot(a.n) - b.anchor.dot(b.n) || a.anchor.x - b.anchor.x || a.anchor.y - b.anchor.y || a.anchor.z - b.anchor.z)
      .forEach((f, i) => { f.key = `${l}#${i}`; });
  }
}
/** Kutu yüzeyinin (hacim / baza seti) düz yüzleri — hepsi ok alır. `spanOf`: Fixed ölçüsü (yüzün arkasındaki derinlik / setin o eksendeki ölçüsü). */
function boxSceneFaces(geo: THREE.BufferGeometry, spanOf: (n: THREE.Vector3, anchor: THREE.Vector3) => number): SceneFace[] {
  const { faces, groups } = getFacesAndGroups(geo);
  const out: SceneFace[] = [];
  groups.forEach((g, gi) => {
    if (g.isCurved || g.totalArea < 4) return;
    const n = g.normal.clone().normalize(), anchor = faceAnchorOf(faces, g);
    const fill = createFaceHighlightGeometry(faces, g.faceIndices), edges = edgePointsOf(fill, 1);
    out.push({ gi, key: '', n, anchor, span: round1(spanOf(n, anchor)), sample: [anchor.x, anchor.y, anchor.z], thick: false, rail: faceRailOf(faces, g, anchor, edges), fill, edges });
  });
  nameSceneFaces(out);
  return out;
}
/** Hacim yüzünün arkasındaki derinlik: çıpadan içeri, bitişik bölge kutuları boyunca (motorun `depthBehind`i — Fixed bunu hedefler). */
function boxColumnDepth(boxes: Array<{ min: Vec3; max: Vec3 }>, p: THREE.Vector3, n: THREE.Vector3): number {
  const a = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)].indexOf(Math.max(Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)));
  const side = n.getComponent(a) > 0 ? 1 : -1, [u, v] = [0, 1, 2].filter(k => k !== a), pu = p.getComponent(u), pv = p.getComponent(v);
  let coord = p.getComponent(a), depth = 0;
  for (let guard = 0; guard < 64; guard++) {
    const q = coord - side * 0.05;
    const b = boxes.find(x => q > x.min[a] && q < x.max[a] && pu > x.min[u] - 0.01 && pu < x.max[u] + 0.01 && pv > x.min[v] - 0.01 && pv < x.max[v] + 0.01);
    if (!b) break;
    const far = side > 0 ? b.min[a] : b.max[a];
    depth += Math.abs(coord - far); coord = far;
  }
  return depth;
}

const ptKey = (p: { x: number; y: number; z: number }) => `${Math.round(p.x * 50)},${Math.round(p.y * 50)},${Math.round(p.z * 50)}`;
/** Dimensions edit önizlemesi: istenen yüz gruplarının sınır köşelerinin birim kayması — motorun `planeMoveTool`uyla aynı kural, ağ üzerinden
 *  (kenarın komşusu = o kenarı sınırında taşıyan öteki grup; düz ve yüze açılıysa köşe onun düzleminde kayar, değilse dik gider). */
function planeShiftsOf(faces: FaceData[], groups: CoplanarFaceGroup[], want: number[]): Map<number, Map<string, THREE.Vector3>> {
  const bounds = groups.map(g => {
    const seen = new Map<string, { n: number; a: THREE.Vector3; b: THREE.Vector3 }>();
    for (const fi of g.faceIndices) {
      const v = faces[fi]?.vertices;
      if (!v || v.length < 3) continue;
      for (let i = 0; i < 3; i++) {
        const a = v[i], b = v[(i + 1) % 3], ka = ptKey(a), kb = ptKey(b);
        if (ka === kb) continue;
        const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`, hit = seen.get(k);
        if (hit) hit.n++; else seen.set(k, { n: 1, a, b });
      }
    }
    return [...seen].filter(([, e]) => e.n === 1);
  });
  const owners = new Map<string, number[]>();
  bounds.forEach((list, gi) => { for (const [k] of list) { const o = owners.get(k); if (o) o.push(gi); else owners.set(k, [gi]); } });
  const out = new Map<number, Map<string, THREE.Vector3>>();
  for (const gi of want) {
    const n = groups[gi].normal.clone().normalize();
    const at = new Map<string, Array<{ e: THREE.Vector3; m: THREE.Vector3 }>>();
    for (const [k, seg] of bounds[gi]) {
      const e = seg.b.clone().sub(seg.a).normalize();
      const nb = (owners.get(k) ?? []).filter(x => x !== gi);
      const nbN = nb.length === 1 && !groups[nb[0]].isCurved ? groups[nb[0]].normal.clone().normalize() : null;
      const m = planeNeighbourNormal(n, e, nbN);
      for (const p of [seg.a, seg.b]) { const key = ptKey(p), l = at.get(key); if (l) l.push({ e, m }); else at.set(key, [{ e, m }]); }
    }
    const map = new Map<string, THREE.Vector3>();
    let tilted = false;
    for (const [key, l] of at) {
      if (l.length !== 2) continue;
      const sft = planeCornerShift(n, l[0].e, l[0].m, l[1].m);
      if (sft.distanceToSquared(n) > 1e-8) tilted = true;
      map.set(key, sft);
    }
    if (tilted) out.set(gi, map);
  }
  return out;
}

/** Panelin extrude edilebilir düz yüzleri. Kanal / delik gibi son geçiş kesimlerinin açtığı yüzler alınmaz (kesilmemiş ağda karşılığı yok). */
function sceneFacesOf(panel: Shape): SceneFace[] {
  const geometry = panel.geometry;
  const box = localBboxOf(geometry);
  if (!geometry || !box) return [];
  const { faces, groups } = getFacesAndGroups(geometry);
  const pre = footprintGeometry(panel);
  const preGroups = pre && pre !== geometry ? (() => {
    const r = getFacesAndGroups(pre);
    return r.groups.filter(g => !g.isCurved).map(g => {
      const bb = new THREE.Box3();
      for (const fi of g.faceIndices) for (const v of r.faces[fi]?.vertices ?? []) bb.expandByPoint(v);
      const n = g.normal.clone().normalize();
      return { n, d: g.center.dot(n), bb: bb.expandByScalar(0.5) };
    });
  })() : null;
  let bigN: THREE.Vector3 | null = null, bigA = 0;
  for (const g of groups) if (!g.isCurved && g.totalArea > bigA) { bigA = g.totalArea; bigN = g.normal.clone().normalize(); }
  const out: SceneFace[] = [];
  groups.forEach((g, gi) => {
    if (g.isCurved || g.totalArea < 4) return;
    const n = g.normal.clone().normalize();
    // Büyük yüzün kanalla ayrılmış dar şeritleri (kanalın arkasında kalan 10 mm) ayrı kenar değildir.
    const thick = !!bigN && Math.abs(n.dot(bigN)) > 0.95;
    if (thick && g.totalArea < bigA * 0.25) return;
    const anchor = faceAnchorOf(faces, g);
    if (preGroups && !preGroups.some(q => q.n.dot(n) > 0.9995 && Math.abs(q.d - anchor.dot(n)) < 0.1 && q.bb.containsPoint(anchor))
      && !isPostSketchFace(panel, gi)) return;
    const k = axisIndexOf(dominantAxisLabel(n).toLowerCase());
    const span = n.getComponent(k) > 0 ? anchor.getComponent(k) - box.min.getComponent(k) : box.max.getComponent(k) - anchor.getComponent(k);
    const fill = createFaceHighlightGeometry(faces, g.faceIndices);
    const edges = edgePointsOf(fill, 1);
    const rail = faceRailOf(faces, g, anchor, edges);
    out.push({ gi, key: '', n, anchor, span: round1(span), spanN: round1(planeSpanOf(geometry, n, anchor)), sample: [anchor.x, anchor.y, anchor.z], thick, rail, fill, edges });
  });
  nameSceneFaces(out);
  const shifts = planeShiftsOf(faces, groups, out.map(f => f.gi));
  for (const f of out) f.shifts = shifts.get(f.gi);
  // Örnek nokta: motor adımın yüzünü, katı yüzlerinin KÖŞELERİNE en yakın olana göre eşler. Yüz ortası iki paralel yüze neredeyse eşit
  // uzak kalabiliyor (L panelin iki ucu) → aynı yöne bakan öteki yüzlerin köşelerinden EN UZAK kendi köşesi, 0.5 mm içeri.
  const labelOf = (g: CoplanarFaceGroup) => dominantAxisLabel(g.normal);
  for (const f of out) {
    const g = groups[f.gi], lbl = labelOf(g);
    const others: THREE.Vector3[] = [];
    groups.forEach((q, qi) => { if (qi !== f.gi && labelOf(q) === lbl) for (const fi of q.faceIndices) for (const v of faces[fi]?.vertices ?? []) others.push(v); });
    if (!others.length) continue;
    let best: THREE.Vector3 | null = null, bestD = -1;
    for (const fi of g.faceIndices) for (const v of faces[fi]?.vertices ?? []) {
      let dm = Infinity;
      for (const o of others) { const d = v.distanceToSquared(o); if (d < dm) dm = d; }
      if (dm > bestD) { bestD = dm; best = v; }
    }
    if (best) { const p = best.clone().add(f.anchor.clone().sub(best).setLength(0.5)); f.sample = [p.x, p.y, p.z]; }
  }
  return out;
}

/** Sahne extrude hedefi: tek başına seçili panel satırının paneli, Extrude aracı O panelde açıkken. Başka araç / yerleştirme / çizim / gövde düzenleme açıkken yok. */
function useSceneExtrudePanel(): Shape | null {
  const s = useStoreFields('shapes', 'selectedShapeId', 'selectedPanelRow', 'sceneExtrudePanelId', 'panelMoveMode', 'panelRotateMode', 'raycastMode', 'volumePickMode',
    'doorPickMode', 'backPickMode', 'plinthPickMode', 'quickBodyMode', 'faceExtrudeMode', 'faceExtrudeTargetPanelId', 'faceExtrudeCavityGroupId',
    'faceExtrudePlinthId', 'doorRefPickGroupId', 'backRefPickGroupId', 'vertexEditMode', 'faceEditMode', 'filletMode');
  const drafting = useDraft(st => !!st.isolate || !!st.bodyPreview || !!st.planePick);
  const row = s.selectedPanelRow;
  if (row === null || !s.selectedShapeId || drafting) return null;
  if (s.panelMoveMode || s.panelRotateMode || s.raycastMode || s.volumePickMode || s.doorPickMode || s.backPickMode || s.plinthPickMode || s.quickBodyMode
    || s.doorRefPickGroupId || s.backRefPickGroupId || s.vertexEditMode || s.faceEditMode || s.filletMode) return null;
  const panel = typeof row === 'number' ? childPanelsOf(s.selectedShapeId, s.shapes).find(p => p.parameters?.faceIndex === row)
    : row.startsWith('vf-') ? s.shapes.find(p => p.type === 'panel' && p.parameters?.virtualFaceId === row.slice(3)) : undefined;
  if (!panel?.geometry || panel.parameters?.parentShapeId !== s.selectedShapeId) return null;
  if (panel.id !== s.sceneExtrudePanelId) return null;   // yalnız Assembly'deki Extrude düğmesiyle açılır
  if (s.faceExtrudeMode && (s.faceExtrudeCavityGroupId || s.faceExtrudePlinthId || s.faceExtrudeTargetPanelId !== panel.id)) return null;
  return panel;
}

/** Seçili kenarı bırakır (panel seçili kalır, oklar geri gelir). */
/** Durum çubuğu yönlendiricisini yayınlar (içerik değişince); araç kalkınca siler. Sahnede yazı yok — adımlar ve tuşlar orada. */
function useStatusGuide(guide: SceneToolStatus) {
  const key = JSON.stringify(guide);
  useEffect(() => { useAppStore.getState().setSceneExStatus(guide); }, [key]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => useAppStore.getState().setSceneExStatus(null), []);
}
const gk = (k: string, t: string): GuideKey => ({ k, t });
function stopSceneExtrude() {
  const st = useAppStore.getState();
  st.setFaceExtrudeSelectedFace(null); st.setFaceExtrudeRefCandidate(null); st.setFaceExtrudeMode(false);
}
/** Ok / nokta tıklaması: yüz extrude modu bu panelde, O OKUN tipiyle açılır, yüz seçilir (ref akışı ve hedef dışı panellerin saydamlığı aynı moddan gelir). */
function pickSceneFace(panel: Shape, f: SceneFace, type: SceneExMode) {
  const st = useAppStore.getState();
  if (!st.faceExtrudeMode || st.faceExtrudeTargetPanelId !== panel.id) { st.setFaceExtrudeMode(true); st.setFaceExtrudeTargetPanelId(panel.id); }
  // Depodaki mod seçili kenarın tipidir (ref akışı ve yüz yakalama onu okur).
  if (st.faceExtrudeValueMode !== type) st.setFaceExtrudeValueMode(type);
  st.setFaceExtrudeRefCandidate(null);
  st.setFaceExtrudeSelectedFace(f.gi);
  st.setFaceExtrudeClickPoint(f.sample);
}

/** Tıklama önceliği: vuruş mesafesi 0 → derinlik testsiz çizilen işaret, önündeki panelden önce yakalanır. Gizli işaret yakalanmaz. */
function frontHitRaycast(this: THREE.Mesh, rc: THREE.Raycaster, hits: THREE.Intersection[]) {
  for (let o: THREE.Object3D | null = this; o; o = o.parent) if (!o.visible) return;
  const before = hits.length;
  THREE.Mesh.prototype.raycast.call(this, rc, hits);
  for (let i = before; i < hits.length; i++) hits[i].distance = 0;
}
/** İşaretin dünyadaki yeri: çıpa ekranda görünüyorsa çıpa; ekran dışındaysa (uzun kenar, yakın çalışma) rayın görünen kısmında çıpaya en
 *  yakın nokta. Ray yoksa / kameranın arkasına geçiyorsa çıpa. */
const _railA = new THREE.Vector3(), _railB = new THREE.Vector3(), _railP = new THREE.Vector3();
function placeOnRail(out: THREE.Vector3, camera: THREE.Camera, anchor: Vec3, rail: [THREE.Vector3, THREE.Vector3] | null): THREE.Vector3 {
  out.set(anchor[0], anchor[1], anchor[2]);
  if (!rail) return out;
  const LIM = 0.84;
  const p = _railP.copy(out).project(camera);
  if (Math.abs(p.x) <= LIM && Math.abs(p.y) <= LIM && p.z < 1) return out;
  const a = _railA.copy(rail[0]).project(camera), b = _railB.copy(rail[1]).project(camera);
  if (a.z >= 1 || b.z >= 1) return out;
  // Liang–Barsky: ekran kutusuna kırpılan ray aralığı (NDC'de).
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  for (const [pp, q] of [[-dx, a.x + LIM], [dx, LIM - a.x], [-dy, a.y + LIM], [dy, LIM - a.y]] as const) {
    if (Math.abs(pp) < 1e-9) { if (q < 0) return out; continue; }
    const r = q / pp;
    if (pp < 0) { if (r > t1) return out; if (r > t0) t0 = r; } else { if (r < t0) return out; if (r < t1) t1 = r; }
  }
  // NDC oranı → dünya oranı (perspektifte doğrusal değil): ikiye bölerek.
  const want = THREE.MathUtils.clamp(0.5, t0, t1), len2 = dx * dx + dy * dy || 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 14; i++) {
    const m = (lo + hi) / 2;
    _railP.copy(rail[0]).lerp(rail[1], m).project(camera);
    if (((_railP.x - a.x) * dx + (_railP.y - a.y) * dy) / len2 < want) lo = m; else hi = m;
  }
  return out.copy(rail[0]).lerp(rail[1], (lo + hi) / 2);
}
/** Tekrarlanan "itme": gideceği yöne yumuşakça ilerler, geri döner (0 → 1 → 0). */
const exPush = (t: number) => { const p = (t % 1.15) / 1.15; return p < 0.55 ? 1 - Math.pow(1 - p / 0.55, 3) : 1 - Math.pow((p - 0.55) / 0.45, 2); };
const fmtEx = (v: number) => String(round1(v));
/** Kutusuz sahne yazısı: fildişi hale ile panelin / çizgilerin üstünde okunur. */
const EX_HALO = '0 0 2px #fffdf9,0 0 2px #fffdf9,0 0 4px #fffdf9,0 0 6px #fffdf9,0 1px 1px rgba(255,253,249,0.9)';
const EX_TEXT: React.CSSProperties = { fontFamily: MONO_FONT, fontWeight: 650, color: SCENE_EX.ink, textShadow: EX_HALO, userSelect: 'none', whiteSpace: 'nowrap' };

/** Okun yanındaki DEĞİŞTİR düğmesi: yalnız döngü simgesi (yazı yok — okun kendisi tipi gösterir, açıklama durum çubuğunda). Basınca o okun
 *  tipi Fixed → Dyn → Ref çevrilir; simge her basışta yarım tur döner, üzerine gelince hafifçe döner ve tipin renginde kenar alır. */
function SceneExTypeBtn({ type, onCycle, onHover }: { type: SceneExMode; onCycle: () => void; onHover: (h: boolean) => void }) {
  const c = SCENE_EX[type].main;
  const [hov, setHov] = useState(false);
  const [turns, setTurns] = useState(0);
  const hover = (h: boolean) => { setHov(h); onHover(h); };
  // Düğme üzerindeyken kalkarsa (ok ↔ nokta dalı değişir) mouseleave gelmez → vurgu burada bırakılır (durum çubuğunda "Switch…" kalıyordu).
  const hovRef = useRef(false), offRef = useRef(onHover);
  hovRef.current = hov; offRef.current = onHover;
  useEffect(() => () => { if (hovRef.current) offRef.current(false); }, []);
  return (
    <button type="button" aria-label="Switch arrow type"
      onClick={e => { e.stopPropagation(); setTurns(t => t + 1); onCycle(); }} onMouseDown={e => e.preventDefault()} onPointerDown={e => e.stopPropagation()}
      onMouseEnter={() => hover(true)} onMouseLeave={() => hover(false)} onContextMenu={e => e.preventDefault()}
      style={{
        pointerEvents: 'auto', width: 20, height: 20, borderRadius: 10, padding: 0, margin: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: hov ? '#ffffff' : 'rgba(255,253,249,0.94)', color: c, cursor: 'pointer', outline: 'none',
        border: `1px solid ${hov ? c : 'rgba(60,50,40,0.16)'}`,
        boxShadow: hov ? `0 0 0 3px ${c}1f,0 2px 6px -2px rgba(40,30,20,0.35)` : '0 1px 3px rgba(40,30,20,0.18),inset 0 1px 0 #fff',
        transform: `scale(${hov ? 1.1 : 1})`, transition: 'transform 0.15s, border-color 0.15s, box-shadow 0.15s, background 0.15s, color 0.2s',
      }}>
      <RefreshCw size={11} strokeWidth={2.3} style={{
        display: 'block', transform: `rotate(${turns * 180 + (hov ? 30 : 0)}deg)`, transition: 'transform 0.38s cubic-bezier(0.34,1.4,0.5,1)',
      }} />
    </button>
  );
}

type SceneExArrowProps = {
  origin: Vec3; normal: THREE.Vector3; rail: [THREE.Vector3, THREE.Vector3] | null; /** +1 dışarı · −1 içeri */ sign: 1 | -1; base: number;
  color: string; litColor: string; lit: boolean; active: boolean; compact: boolean; phase: number; tip?: string | null; onPick: () => void; onHover: (h: boolean) => void;
  /** okun YANINDA duran tip düğmesi */ side?: React.ReactNode; children?: React.ReactNode;
};
/** Kenar oku: yüzün hemen dışında durur, hareket yönüne DÖNEREK geçer (mod değişimi / değer işareti), boşta hafifçe nefes alır, vurguda iter.
 *  Kameraya arkası dönük yüzün oku soluklaşır. `compact`: büyük yüzde küçük nokta — üzerine gelince ok olur. */
function SceneExArrow({ origin, normal, rail, sign, base, color, litColor, lit, active, compact, phase, tip, onPick, onHover, side, children }: SceneExArrowProps) {
  const root = useRef<THREE.Group>(null), spin = useRef<THREE.Group>(null), slide = useRef<THREE.Group>(null), dot = useRef<THREE.Group>(null);
  const bodyMat = useRef<THREE.MeshBasicMaterial>(null), rimMat = useRef<THREE.MeshBasicMaterial>(null);
  const knobMat = useRef<THREE.MeshBasicMaterial>(null), knobRimMat = useRef<THREE.MeshBasicMaterial>(null);
  const tag = useRef<HTMLDivElement>(null), sideTag = useRef<HTMLDivElement>(null), tagA = useRef(new THREE.Vector3()), tagB = useRef(new THREE.Vector3());
  const settled = useRef<THREE.Group | null>(null);
  useScreenLockedScale(root, base);
  const target = useMemo(() => new THREE.Quaternion().setFromUnitVectors(EX_Y, normal.clone().multiplyScalar(sign)), [normal, sign]);
  const tmp = useRef(new THREE.Vector3());
  const showArrow = !compact || lit;
  useFrame(({ camera, clock, size }, dt) => {
    const g = spin.current, r = root.current;
    if (!r) return;
    placeOnRail(r.position, camera, origin, rail);
    if (g) {
      if (settled.current !== g) { g.quaternion.copy(target); settled.current = g; }   // yeni kurulan ok dönerek değil, yerinde gelir
      else if (g.quaternion.angleTo(target) > 1e-3) g.quaternion.slerp(target, 1 - Math.exp(-dt * 15));
    }
    const t = clock.elapsedTime;
    if (slide.current) slide.current.position.y = (lit ? exPush(t) * 0.17 - 0.04 : Math.sin(t * 1.7 + phase) * 0.028) * base;
    // Arkası dönük yüz: kamera yüzün arka yarı-uzayında.
    const back = tmp.current.copy(camera.position).sub(r.position).dot(normal) < 0 && !lit;
    // Büyük yüzün arkası dönük olanı çizilmez: ince panelde iki yüzün noktası üst üste biner.
    r.visible = !(compact && back);
    // Arkadaki ok SOLUK RENKLE çizilir (saydamlıkla değil: saydam katmanlar üst üste binip lekeleniyordu).
    const c = back ? tones.pale : tones.fill;
    bodyMat.current?.color.copy(c); knobMat.current?.color.copy(c);
    const ro = back ? 0.7 : 0.96;
    if (rimMat.current) rimMat.current.opacity = ro;
    if (knobRimMat.current) knobRimMat.current.opacity = ro;
    if (dot.current) { dot.current.quaternion.copy(camera.quaternion); dot.current.scale.setScalar(4.2 * worldPerPixel(camera, size.height, r.position) / (r.scale.x || 1)); }
    const el = tag.current, sd = sideTag.current;
    if (el || sd) {
      // Okun ekrandaki yönü; kameraya doğru bakan okta (izdüşümü birkaç piksel) etiket okun üstüne, düğme sağına alınır.
      const a = tagA.current.copy(r.position).project(camera), b = tagB.current.copy(r.position).addScaledVector(normal, base * r.scale.x).project(camera);
      let dx = (b.x - a.x) * size.width, dy = -(b.y - a.y) * size.height;
      const len = Math.hypot(dx, dy), head = len < 16;
      if (head) { dx = 0; dy = -1; } else { dx /= len; dy /= len; }
      if (el) {
        const k = Math.abs(dx) * el.offsetWidth / 2 + Math.abs(dy) * el.offsetHeight / 2 + (head ? 20 : 9);
        el.style.transform = `translate(${(dx * k).toFixed(1)}px, ${(dy * k).toFixed(1)}px)`;
      }
      if (sd) {
        // Okun YANI: ekranda oka dik, hep üst / sağ tarafta (ok dönse de düğme yer değiştirmez).
        let px = -dy, py = dx;
        if (py > 0.02 || (Math.abs(py) <= 0.02 && px < 0)) { px = -px; py = -py; }
        if (head) { px = 1; py = 0; }
        sd.style.transform = `translate(${(px * 18).toFixed(1)}px, ${(py * 18).toFixed(1)}px)`;
        sd.style.opacity = back ? '0.6' : '1';
      }
    }
  });
  const mid = (EX_GAP + 0.5) * base;
  const off = (k: number): Vec3 => [normal.x * k, normal.y * k, normal.z * k];
  const hover = (h: boolean) => { onHover(h); hoverCursor(h); };
  const fill = lit ? litColor : color;
  const tones = useMemo(() => ({ fill: new THREE.Color(fill), pale: new THREE.Color(color).lerp(new THREE.Color('#f1eee9'), 0.55) }), [fill, color]);
  const hitQ = useMemo(() => new THREE.Quaternion().setFromUnitVectors(EX_Y, normal), [normal]);
  return (
    <group ref={root} position={origin}>
      {/* Ayrı anahtarlar: ok ↔ nokta geçişinde aynı THREE.Group yeniden kullanılırsa noktanın ölçeği / yönü oka kalır. */}
      {showArrow ? (
        <group key="arrow" position={off(mid)}>
          <group ref={spin}>
            <group ref={slide} scale={base * (active ? 1.12 : 1)} dispose={null}>
              <mesh geometry={EX_ARROW.rim} renderOrder={RENDER_ORDER} raycast={noRaycast}>
                <meshBasicMaterial ref={rimMat} color={SCENE_EX.rim} transparent depthTest={false} depthWrite={false} toneMapped={false} side={THREE.DoubleSide} />
              </mesh>
              <mesh geometry={EX_ARROW.knobRim} position={[0, -0.5, 0]} renderOrder={RENDER_ORDER} raycast={noRaycast}>
                <meshBasicMaterial ref={knobRimMat} color={SCENE_EX.rim} transparent depthTest={false} depthWrite={false} toneMapped={false} />
              </mesh>
              <mesh geometry={EX_ARROW.body} renderOrder={RENDER_ORDER + 1} raycast={noRaycast}>
                {/* transparent: kenar çizgisiyle aynı (saydam) sıralama listesinde, ondan SONRA çizilsin — opaklık hep 1 */}
                <meshBasicMaterial ref={bodyMat} color={fill} transparent depthTest={false} depthWrite={false} toneMapped={false} side={THREE.DoubleSide} />
              </mesh>
              <mesh geometry={EX_ARROW.knob} position={[0, -0.5, 0]} renderOrder={RENDER_ORDER + 1} raycast={noRaycast}>
                <meshBasicMaterial ref={knobMat} color={fill} transparent depthTest={false} depthWrite={false} toneMapped={false} />
              </mesh>
            </group>
          </group>
        </group>
      ) : (
        <group key="dot" ref={dot} renderOrder={DOT_RENDER_ORDER} dispose={null}>
          <mesh geometry={DOT_UNIT} scale={1.45} renderOrder={DOT_RENDER_ORDER} raycast={noRaycast}><DotMat color={SCENE_EX.rim} opacity={0.95} /></mesh>
          <mesh geometry={DOT_UNIT} renderOrder={DOT_RENDER_ORDER + 1} raycast={noRaycast}><DotMat color={color} opacity={0.8} /></mesh>
        </group>
      )}
      {/* Vuruş alanı: yüzden ok ucuna kadar görünmez kapsül (ince sap zor hedef). */}
      <mesh name="sx-arrow" position={off((EX_GAP + 1) * base * 0.5)} quaternion={hitQ} raycast={frontHitRaycast}
        onClick={e => { e.stopPropagation(); onPick(); }} onPointerDown={stopEvent}
        onPointerOver={e => { e.stopPropagation(); hover(true); }} onPointerOut={() => hover(false)}>
        <cylinderGeometry args={[base * 0.19, base * 0.19, (EX_GAP + 1.05) * base, 10]} />
        <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />
      </mesh>
      {side && showArrow && (
        <Html position={off(mid)} center zIndexRange={[66, 56]} style={{ pointerEvents: 'none' }}><div ref={sideTag} style={{ pointerEvents: 'none' }}>{side}</div></Html>
      )}
      {/* Etiket / değer girişi: kutusuz. Çıpası okun ucu; `tag` her karede okun EKRANDAKİ yönünde kendi yarı boyu kadar itilir → oku örtmez. */}
      {(children || tip) && (
        <Html position={off((EX_GAP + 1.2) * base)} center zIndexRange={children ? [70, 60] : [60, 50]} style={{ pointerEvents: 'none' }}>
          <div ref={tag} style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }}>
            {children ?? <span style={{ ...EX_TEXT, fontSize: 11.5 }}>{tip}</span>}
          </div>
        </Html>
      )}
    </group>
  );
}

/** Ref modunun noktası: yüzün ortasında, ekranda sabit boy; seçiliyken halkası atar. */
function SceneExDot({ position, normal, rail, thick, selected, onPick, onHover, side }: {
  position: Vec3; normal: THREE.Vector3; rail: [THREE.Vector3, THREE.Vector3] | null; thick: boolean; selected: boolean; onPick: () => void; onHover: (h: boolean) => void;
  /** noktanın yanında duran tip düğmesi */ side?: React.ReactNode;
}) {
  const g = useRef<THREE.Group>(null), halo = useRef<THREE.Mesh>(null), tmp = useRef(new THREE.Vector3()), sideTag = useRef<HTMLDivElement>(null);
  const [hov, setHov] = useState(false);
  const px = selected ? 13 : hov ? 13 : 10;
  useFrame(({ camera, size, clock }) => {
    const o = g.current;
    if (!o) return;
    placeOnRail(o.position, camera, position, rail);
    const back = tmp.current.copy(camera.position).sub(o.position).dot(normal) < 0;
    o.visible = selected || !(thick && back);
    if (sideTag.current) { sideTag.current.style.display = o.visible ? '' : 'none'; sideTag.current.style.opacity = back && !selected ? '0.6' : '1'; }
    o.quaternion.copy(camera.quaternion);
    o.scale.setScalar((px / 2) * worldPerPixel(camera, size.height, o.position));
    if (halo.current) { const p = (clock.elapsedTime % 1.3) / 1.3; halo.current.scale.setScalar(1.4 + p * 1.9); (halo.current.material as THREE.MeshBasicMaterial).opacity = 0.34 * (1 - p); }
  });
  const c = SCENE_EX.ref.main, filled = selected || hov;
  const hover = (h: boolean) => { setHov(h); onHover(h); hoverCursor(h); };
  return (
    <group ref={g} position={position} renderOrder={DOT_RENDER_ORDER}>
      {selected && <mesh ref={halo} geometry={DOT_UNIT} renderOrder={DOT_RENDER_ORDER} raycast={noRaycast}><DotMat color={c} opacity={0.3} /></mesh>}
      <mesh geometry={DOT_UNIT} scale={1.32} renderOrder={DOT_RENDER_ORDER + 1} raycast={noRaycast}><DotMat color={filled ? c : DOT_IVORY} /></mesh>
      <mesh geometry={DOT_UNIT} renderOrder={DOT_RENDER_ORDER + 2} raycast={noRaycast}><DotMat color={filled ? DOT_IVORY : c} /></mesh>
      <mesh geometry={DOT_UNIT} scale={0.52} renderOrder={DOT_RENDER_ORDER + 3} raycast={noRaycast}><DotMat color={c} /></mesh>
      <mesh name="sx-dot" geometry={DOT_UNIT} scale={2.5} raycast={frontHitRaycast} onClick={e => { e.stopPropagation(); onPick(); }} onPointerDown={stopEvent}
        onPointerOver={e => { e.stopPropagation(); hover(true); }} onPointerOut={() => hover(false)}>
        <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />
      </mesh>
      {side && (
        <Html center zIndexRange={[66, 56]} style={{ pointerEvents: 'none' }}>
          <div ref={sideTag} style={{ pointerEvents: 'none', transform: 'translate(14px, -14px)' }}>{side}</div>
        </Html>
      )}
    </group>
  );
}

/** Kenarın gideceği yer (panel-yerel çizilir): taranan hacim + hedef çizgisi + kenardan hedefe AKAN hayalet çizgiler.
 *  `demo`: değer yokken yalnız yön gösterimi (dolgu ve hedef yok). `measure`: Fixed ölçüsünün çizgisi — karşı kenardan (kalın çentik) hedefe; değer okun ucundaki girişte. */
function SceneExPreview({ matrix, face, amount, demo, color, measure, plane }: {
  matrix: THREE.Matrix4; face: SceneFace; amount: number; demo: boolean; color: string; measure?: { from: number } | null;
  /** Dimensions edit: köşeler komşu yüzlerin düzleminde kayar (`face.shifts`) → taranan hacim ve hedef çizgisi GERÇEK sonucu gösterir. */ plane?: boolean;
}) {
  const d = useMemo(() => face.n.clone().multiplyScalar(amount), [face, amount]);
  const shifts = plane ? face.shifts ?? null : null;
  // Noktanın tam değerdeki yer değiştirmesi: düzlem kaydırmada köşeye özel, yoksa yüz normali boyunca.
  const dispOf = useMemo(() => (p: ArrayLike<number>) => {
    const sft = shifts?.get(ptKey({ x: p[0], y: p[1], z: p[2] }));
    return sft ? [sft.x * amount, sft.y * amount, sft.z * amount] : [d.x, d.y, d.z];
  }, [shifts, amount, d]);
  const sweep = useMemo(() => {
    const pos: number[] = [];
    for (let i = 0; i + 1 < face.edges.length; i += 2) {
      const a = face.edges[i], b = face.edges[i + 1], da = dispOf(a), db = dispOf(b);
      pos.push(a[0], a[1], a[2], b[0], b[1], b[2], b[0] + db[0], b[1] + db[1], b[2] + db[2], a[0], a[1], a[2], b[0] + db[0], b[1] + db[1], b[2] + db[2], a[0] + da[0], a[1] + da[1], a[2] + da[2]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return g;
  }, [face, dispOf]);
  useEffect(() => () => sweep.dispose(), [sweep]);
  // Düzlem kaydırma: hedef yüz ve çizgisi yeni biçimiyle (köşeler ayrı ayrı kayar); akan çizgiler her karede köşe köşe ilerler.
  const warp = useMemo(() => {
    if (!shifts) return null;
    const base = new Float32Array(face.edges.length * 3), disp = new Float32Array(face.edges.length * 3);
    face.edges.forEach((p, i) => { const q = dispOf(p); base.set(p, i * 3); disp.set(q, i * 3); });
    const target: Vec3[] = face.edges.map((p, i) => [p[0] + disp[i * 3], p[1] + disp[i * 3 + 1], p[2] + disp[i * 3 + 2]]);
    const fill = face.fill.clone(), pos = fill.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) { const q = dispOf([pos.getX(i), pos.getY(i), pos.getZ(i)]); pos.setXYZ(i, pos.getX(i) + q[0], pos.getY(i) + q[1], pos.getZ(i) + q[2]); }
    return { base, disp, target, fill, tmp: new Float32Array(base.length) };
  }, [shifts, face, dispOf]);
  useEffect(() => () => warp?.fill.dispose(), [warp]);
  const echoes = useRef<Array<THREE.Group | null>>([]);
  const N = 3;
  useFrame(({ clock }) => {
    for (let i = 0; i < N; i++) {
      const g = echoes.current[i];
      if (!g) continue;
      const p = (clock.elapsedTime / 1.5 + i / N) % 1, e = p * p * (3 - 2 * p);
      const line: any = g.children[0];
      if (warp) {
        for (let k = 0; k < warp.tmp.length; k++) warp.tmp[k] = warp.base[k] + warp.disp[k] * e;
        g.position.set(0, 0, 0);
        line?.geometry?.setPositions?.(warp.tmp);
      } else g.position.set(d.x * e, d.y * e, d.z * e);
      if (line?.material) line.material.opacity = Math.sin(Math.PI * p) * (demo ? 0.85 : 0.95);
    }
  });
  const css = new THREE.Color(color).getHex();
  // Fixed ölçü çizgisi: yüzün ortasından geçer; çentikler yüz düzleminde, harekete dik.
  const dim = useMemo(() => {
    if (!measure) return null;
    const p0 = face.anchor.clone().addScaledVector(face.n, -measure.from), p1 = face.anchor.clone().add(d);
    const ax = Math.abs(face.n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const t = new THREE.Vector3().crossVectors(face.n, ax).normalize();
    const len = THREE.MathUtils.clamp(p0.distanceTo(p1) * 0.05, 5, 16);
    const seg = (p: THREE.Vector3, k: number): Vec3[] => [vec3Of(p.clone().addScaledVector(t, -len * k)), vec3Of(p.clone().addScaledVector(t, len * k))];
    return { main: [vec3Of(p0), vec3Of(p1)] as Vec3[], fixedTick: seg(p0, 1.5), endTick: seg(p1, 1) };
  }, [measure, face, d]);
  return (
    <group matrix={matrix} matrixAutoUpdate={false}>
      {demo && <mesh geometry={sweep} renderOrder={14} raycast={noRaycast}><OverlayMat color={css} opacity={0.1} /></mesh>}
      {!demo && (
        <>
          <mesh geometry={sweep} renderOrder={14} raycast={noRaycast}><OverlayMat color={css} opacity={0.2} /></mesh>
          {warp ? (
            <>
              <mesh geometry={warp.fill} renderOrder={14} raycast={noRaycast} dispose={null}><OverlayMat color={css} opacity={0.3} /></mesh>
              <EdgeLines points={warp.target} color={color} width={2.4} order={16} />
            </>
          ) : (
            <>
              <mesh geometry={face.fill} position={d} renderOrder={14} raycast={noRaycast} dispose={null}><OverlayMat color={css} opacity={0.3} /></mesh>
              <group position={d}><EdgeLines points={face.edges} color={color} width={2.4} order={16} /></group>
            </>
          )}
        </>
      )}
      {Array.from({ length: N }, (_, i) => (
        <group key={i} ref={el => { echoes.current[i] = el; }}>
          <Line points={face.edges} segments color={color} lineWidth={demo ? 1.6 : 1.9} transparent opacity={0} depthTest={false} depthWrite={false} renderOrder={15} raycast={noRaycast} />
        </group>
      ))}
      {dim && (
        <>
          <EdgeLines points={dim.main} color={SCENE_EX.ink} width={1.1} order={17} />
          <EdgeLines points={dim.fixedTick} color={SCENE_EX.ink} width={3.2} order={17} />
          <EdgeLines points={dim.endTick} color={SCENE_EX.ink} width={1.6} order={17} />
        </>
      )}
    </group>
  );
}
const vec3Of = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];

/** Girilen metnin anlamı: Fixed'de değer = karşı kenardan ölçü (hareket = değer − şimdiki ölçü), Dyn'de değer = hareket. */
function exEntry(mode: 'fixed' | 'dyn', span: number, text: string) {
  const p = parseFloat(text.replace(',', '.'));
  const value = Number.isFinite(p) ? p : null;
  const amount = value === null ? null : mode === 'fixed' ? value - span : value;
  const moving = amount !== null && Math.abs(amount) > 0.01;
  return { value, amount, moving, valid: value !== null && (mode === 'fixed' ? value > 0 : moving && value > -span + 0.5) };
}
/** Sahnedeki değer girişi: KUTUSUZ — yalnız rakam, renkli ince alt çizgi ve birim. Enter uygular, Esc bırakır.
 *  Metin durumu BURADA (Html'in kendi DOM kökünde) tutulur: sahne kökündeki durumla denetlenen giriş, tuş aralarında eski değere dönüp
 *  imleci kaydırıyordu. Üst bileşene yalnız önizleme için haber verilir. */
function SceneNumInput({ initial, placeholder, unit, color, title, parse, onText, onApply, onCancel }: {
  initial: string; placeholder: string; unit: string; color: string; title: string; parse: (t: string) => { value: number | null; valid: boolean };
  onText: (t: string) => void; onApply: (v: number) => void; onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const { value, valid } = parse(text);
  const line = valid || !text ? color : '#dc2626';
  return (
    <div style={{ pointerEvents: 'auto', display: 'flex', alignItems: 'baseline', gap: 3 }} onPointerDown={e => e.stopPropagation()} onContextMenu={e => e.preventDefault()}>
      <input autoFocus type="text" inputMode="decimal" value={text} placeholder={placeholder} spellCheck={false} title={title}
        onFocus={e => e.currentTarget.select()} onChange={e => { setText(e.target.value); onText(e.target.value); }}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && valid && value !== null) onApply(value); if (e.key === 'Escape') onCancel(); }}
        style={{
          ...EX_TEXT, userSelect: 'auto', width: `${Math.max(3, text.length + 0.6)}ch`, boxSizing: 'content-box', padding: '0 1px 1px', margin: 0, fontSize: 14,
          lineHeight: 1.2, textAlign: 'center', background: 'transparent', border: 'none', borderBottom: `1.5px solid ${line}`, borderRadius: 0, outline: 'none',
          caretColor: color,
        }} />
      <span style={{ ...EX_TEXT, fontSize: 10, fontWeight: 600, color: '#6b645c' }}>{unit}</span>
    </div>
  );
}
/** Extrude okunun girişi: Fixed'de şimdiki ölçüyle dolu gelir. */
function SceneExInput({ mode, span, color, onText, onApply, onCancel }: {
  mode: 'fixed' | 'dyn'; span: number; color: string; onText: (t: string) => void; onApply: (v: number) => void; onCancel: () => void;
}) {
  return <SceneNumInput initial={mode === 'fixed' ? fmtEx(span) : ''} placeholder={mode === 'fixed' ? fmtEx(span) : '0'} unit="mm" color={color}
    title={mode === 'fixed' ? 'Size (mm) — Enter applies, Esc cancels' : 'Move from where it is now (mm): + out, − in — Enter applies, Esc cancels'}
    parse={t => exEntry(mode, span, t)} onText={onText} onApply={onApply} onCancel={onCancel} />;
}

/** Sahne extrude aracının HEDEFİ: panelin kenarları, raf / dikme hacminin yüzleri ya da baza setinin yüzleri. Oklar, okun yanındaki tip düğmesi,
 *  kutusuz giriş, önizleme ve durum çubuğu ortaktır (`SceneExtrudeTool`); hedef yalnız yüzleri ve adımın nasıl yazılacağını verir. */
type SceneExTarget = {
  /** tip hafızası (`_exTypes`) anahtarı */ id: string;
  /** durum çubuğunda araç adı · yüzün adı */ label: string; noun: 'edge' | 'face';
  /** Dimensions edit: önizleme düzlem kaydırmayı gösterir (köşeler komşu yüzlerde kayar) */ plane?: boolean;
  faces: SceneFace[]; matrix: THREE.Matrix4; /** okların dünya ölçeği */ base: number;
  /** izinli tipler (baza setinde Ref yok); ilki varsayılan */ modes: SceneExMode[];
  /** depoda seçili yüz (yüz extrude modu bu hedefteyse) */ activeGi: number | null;
  select: (f: SceneFace, type: SceneExMode) => void; /** seçili yüzü bırakır (araç açık kalır) */ deselect: () => void;
  apply: (f: SceneFace, mode: 'fixed' | 'dyn', v: number) => Promise<unknown>;
  fixedText: (span: string) => string; dynText: string; refText: string;
};
const SX_NOUN = { edge: 'Edge', face: 'Face' } as const;

let _sceneExBusy = false;
function SceneExtrudeTool({ t }: { t: SceneExTarget }) {
  const S = useStoreFields('faceExtrudeRefCandidate', 'refPickNote');
  const rp = useRefPick();
  const { faces, matrix, base } = t;
  const world = useMemo(() => faces.map(f => ({
    origin: worldOf(f.anchor, matrix), normal: f.n.clone().transformDirection(matrix),
    rail: f.rail ? [f.rail[0].clone().applyMatrix4(matrix), f.rail[1].clone().applyMatrix4(matrix)] as [THREE.Vector3, THREE.Vector3] : null,
  })), [faces, matrix]);
  // HER OKUN KENDİ TİPİ (varsayılan: hedefin ilk tipi): okun yanındaki düğme yalnız o oku çevirir.
  const [types, setTypes] = useState<Record<string, SceneExMode>>(() => _exTypes.get(t.id) ?? {});
  const typeOf = (f: SceneFace): SceneExMode => { const x = types[f.key]; return x && t.modes.includes(x) ? x : t.modes[0]; };
  const nextType = (f: SceneFace) => nextOf(t.modes, typeOf(f));
  const [hover, setHover] = useState<number | null>(null);
  const [swHover, setSwHover] = useState<number | null>(null);
  const [entry, setEntry] = useState<{ key: string; text: string } | null>(null);
  const active = t.activeGi !== null ? faces.find(f => f.gi === t.activeGi) ?? null : null;
  const mode = active ? typeOf(active) : null;
  // Vurgu bırakma kısa gecikmeli: imleç oktan yanındaki düğmeye geçerken ok (ve büyük yüzde düğmenin kendisi) kaybolmasın.
  const hoverOff = useRef<number | undefined>(undefined);
  const hoverFace = (gi: number, h: boolean) => {
    window.clearTimeout(hoverOff.current);
    if (h) setHover(gi);
    else hoverOff.current = window.setTimeout(() => setHover(cur => (cur === gi ? null : cur)), 160);
  };
  useEffect(() => () => window.clearTimeout(hoverOff.current), []);
  // Yüzler değişti (uygulama / başka yerden rebuild): yüz indeksleri eskidir → vurgu ve seçili yüz düşer.
  const facesRef = useRef(faces), activeRef = useRef(t.activeGi), deselectRef = useRef(t.deselect);
  activeRef.current = t.activeGi; deselectRef.current = t.deselect;
  useEffect(() => {
    window.clearTimeout(hoverOff.current);
    setHover(null);
    if (facesRef.current === faces) return;
    facesRef.current = faces;
    if (activeRef.current !== null && !_sceneExBusy) deselectRef.current();
  }, [faces]);
  /** Okun tipini sıradakine çevirir; seçili yüzün oku ise yüz korunur, giriş yeni tipte yeniden açılır. */
  const cycleType = (f: SceneFace) => {
    const next = nextType(f);
    const all = { ...types, [f.key]: next };
    _exTypes.set(t.id, all);
    setTypes(all);
    if (f === active) t.select(f, next);
  };
  // Yüz ya da tip değişince giriş yenilenir: Fixed'de ŞİMDİKİ ölçü yazılı ve seçili gelir, Dyn boş başlar (şimdiki yerden fark).
  const entryKey = active ? `${active.gi}|${mode}|${active.span}` : '';
  const draft = entry && entry.key === entryKey ? entry.text : active && mode === 'fixed' ? fmtEx(active.span) : '';
  const setDraft = (text: string) => setEntry({ key: entryKey, text });

  const cur = active && mode && mode !== 'ref' ? exEntry(mode, active.span, draft) : null;
  const amount = cur?.amount ?? null, moving = !!cur?.moving;
  const amountOf = (f: SceneFace): number | null => (f === active ? amount : null);
  const signOf = (f: SceneFace): 1 | -1 => { const a = amountOf(f); return a !== null && Math.abs(a) > 0.01 ? (a > 0 ? 1 : -1) : typeOf(f) === 'fixed' ? -1 : 1; };
  const demoOf = (f: SceneFace) => (typeOf(f) === 'fixed' ? -Math.min(Math.max(f.span * 0.3, 6), base * 1.1, Math.max(f.span - 1, 1)) : base * 0.9);

  const apply = async (v: number) => {
    if (!active || !mode || mode === 'ref' || _sceneExBusy) return;
    _sceneExBusy = true;
    try { await t.apply(active, mode, v); }
    catch (e) { console.error('[YAGO][SAHNE-EXTRUDE] uygulanamadı:', e); }
    finally { _sceneExBusy = false; }
    t.deselect();
  };

  // Ref: seçili yüzün referans yüze kadar gideceği yol (yüz normali boyunca); çok dik referansta yol yok.
  const refAmount = useMemo(() => {
    const cand = S.faceExtrudeRefCandidate;
    if (mode !== 'ref' || !active || !cand || cand.faceGroupIndex < 0) return null;
    const i = faces.indexOf(active), nW = world[i].normal, N = new THREE.Vector3(...cand.normalWorld), par = nW.dot(N);
    if (Math.abs(par) < 0.5) return null;
    return new THREE.Vector3(...cand.pointWorld).sub(new THREE.Vector3(...world[i].origin)).dot(N) / par;
  }, [mode, active, S.faceExtrudeRefCandidate, faces, world]);
  const hovered = hover !== null ? faces.find(f => f.gi === hover) ?? null : null;
  const previewFace = active ?? hovered;
  // Durum çubuğu: okun yanında yazı yok — tip, adımlar ve ne yapılacağı burada.
  const swFace = swHover !== null ? faces.find(f => f.gi === swHover) ?? null : null;
  const exType: SceneExMode | null = active && mode ? mode : hovered ? typeOf(hovered) : null;
  const noun = t.noun, Noun = SX_NOUN[noun];
  const refStage = active && mode === 'ref' && rp?.tool === 'extrude' ? rp.stage : null;
  const isolated = refStage === 'isolated';
  const exStep = !active || !mode ? 0 : mode !== 'ref' ? 1 : refStage === 'picked' ? 3 : isolated ? 2 : 1;
  const more = refRingCount() > 1;
  useStatusGuide({
    label: t.label, type: swFace ? typeOf(swFace) : exType,
    steps: exType === 'ref' ? [Noun, 'Reference panel', 'Its face', 'Confirm'] : [Noun, exType === 'fixed' ? 'Size' : exType === 'dyn' ? 'Distance' : 'Value'],
    step: exStep,
    text: !active || !mode ? `Click the arrow of the ${noun} to move${t.modes.length > 1 ? ' · the round button next to an arrow switches its type' : ''}`
      : mode === 'fixed' ? t.fixedText(fmtEx(active.span))
      : mode === 'dyn' ? t.dynText
      : refStage === 'picked' ? `Right-click — the ${noun} goes up to that face and follows it · click another panel to change it`
      : isolated ? 'Click the face to reach — the panel is shown alone, turn the view to see every face'
      : `Click the panel (or the body) the ${noun} should reach — it is then shown alone to pick its face`,
    note: swFace ? `Switch this arrow → ${SCENE_EX_LABEL[nextType(swFace)]}`
      : isolated ? S.refPickNote
      : !active && hovered ? (typeOf(hovered) === 'fixed' ? `Fixed — ${t.fixedText(fmtEx(hovered.span))}` : typeOf(hovered) === 'dyn' ? `Dyn — ${t.dynText}` : `Ref — ${t.refText}`)
      : null,
    keys: !active || !mode ? [gk('Esc', 'close')]
      : mode !== 'ref' ? [gk('Enter', 'apply'), gk('Esc', 'back')]
      : refStage === 'picked' ? [gk('Right-click', 'confirm'), gk('Esc', 'back')]
      : isolated ? [...(more ? [gk('Tab', 'panel behind')] : []), gk('Esc', 'back')] : [gk('Esc', 'back')],
  });
  const pType = previewFace ? typeOf(previewFace) : 'fixed', PC = SCENE_EX[pType];
  const previewAmount = !previewFace ? null
    : pType === 'ref' ? (previewFace === active ? refAmount : null)
    : previewFace === active && moving ? Math.max(amount!, -active!.span + 0.5) : null;
  // Referans paneli yalnız bırakılmışken (yüzü seçiliyor) aracın kendi işaretleri çizilmez.
  if (isolated) return null;
  return (
    <group>
      {faces.map((f, i) => {
        const ty = typeOf(f), C = SCENE_EX[ty], isActive = f === active, lit = isActive || hover === f.gi;
        const typeBtn = t.modes.length > 1 ? <SceneExTypeBtn type={ty} onCycle={() => cycleType(f)}
          onHover={h => { hoverFace(f.gi, h); setSwHover(c => (h ? f.gi : c === f.gi ? null : c)); }} /> : undefined;
        if (ty === 'ref') {
          return (
            <SceneExDot key={f.key} position={world[i].origin} normal={world[i].normal} rail={world[i].rail} thick={f.thick} selected={isActive}
              onPick={() => t.select(f, ty)} onHover={h => hoverFace(f.gi, h)} side={typeBtn} />
          );
        }
        return (
          <SceneExArrow key={f.key} origin={world[i].origin} normal={world[i].normal} rail={world[i].rail} sign={signOf(f)} base={base} color={C.main} litColor={C.lit}
            lit={lit} active={isActive} compact={f.thick} phase={i * 1.3} tip={lit && !isActive ? (ty === 'fixed' ? `${fmtEx(f.span)} mm` : '± mm') : null}
            onPick={() => t.select(f, ty)} onHover={h => hoverFace(f.gi, h)} side={typeBtn}>
            {isActive ? <SceneExInput key={entryKey} mode={ty} span={f.span} color={C.main} onText={setDraft} onApply={v => { void apply(v); }} onCancel={t.deselect} /> : null}
          </SceneExArrow>
        );
      })}
      {/* Üzerine gelinen yüz (seçili değilken): açık vurgu + yön gösterimi. */}
      {hovered && hovered !== active && (
        <group matrix={matrix} matrixAutoUpdate={false}>
          <mesh geometry={hovered.fill} renderOrder={11} raycast={noRaycast} dispose={null}><OverlayMat color={new THREE.Color(PC.lit).getHex()} opacity={0.34} /></mesh>
          <EdgeLines points={hovered.edges} color={PC.main} width={1.8} order={13} />
        </group>
      )}
      {previewFace && pType !== 'ref' && previewAmount === null && (
        <SceneExPreview matrix={matrix} face={previewFace} amount={demoOf(previewFace)} demo color={PC.lit} plane={t.plane} />
      )}
      {previewFace && previewAmount !== null && Math.abs(previewAmount) > 0.01 && (
        <SceneExPreview matrix={matrix} face={previewFace} amount={previewAmount} demo={false} plane={t.plane}
          color={pType === 'ref' ? SCENE_EX.ref.lit : previewAmount < 0 ? SCENE_EX.shrink : SCENE_EX.grow}
          measure={pType === 'fixed' && previewFace === active ? { from: active!.span } : null} />
      )}
    </group>
  );
}
const useFaceDisposal = (faces: SceneFace[]) => useEffect(() => () => { for (const f of faces) f.fill.dispose(); }, [faces]);
const sceneExBase = (maxDim: number) => THREE.MathUtils.clamp(maxDim * 0.12, 34, 96);

/** PANEL: kenar okları. Adım motoru aynı (executeFaceExtrude / ref onayı). */
export function PanelSceneExtrude({ panel }: { panel: Shape }) {
  const S = useStoreFields('faceExtrudeMode', 'faceExtrudeTargetPanelId', 'faceExtrudeSelectedFace', 'sceneExtrudePlane');
  const plane = S.sceneExtrudePlane;   // Dimensions edit: aynı oklar; adım düzlem kaydırma, Fixed ölçüsü yüz normali boyunca
  const all = useMemo(() => sceneFacesOf(panel), [panel.geometry, panel.ungroovedGeometry]);   // eslint-disable-line react-hooks/exhaustive-deps
  useFaceDisposal(all);
  const faces = useMemo(() => (plane ? all.map(f => ({ ...f, span: f.spanN ?? f.span })) : all), [all, plane]);
  const matrix = useMemo(() => getShapeMatrix(panel), [panel.position, panel.rotation, panel.scale]);   // eslint-disable-line react-hooks/exhaustive-deps
  const base = useMemo(() => { const sz = localBboxOf(panel.geometry)?.getSize(new THREE.Vector3()); return sceneExBase(sz ? Math.max(sz.x, sz.y, sz.z) : 400); }, [panel.geometry]);
  return <SceneExtrudeTool t={{
    id: plane ? `${panel.id}:dims` : panel.id, label: plane ? 'Dimensions edit' : 'Extrude', noun: 'edge', plane, faces, matrix, base, modes: SCENE_EX_ORDER,
    activeGi: S.faceExtrudeMode && S.faceExtrudeTargetPanelId === panel.id ? S.faceExtrudeSelectedFace : null,
    select: (f, type) => pickSceneFace(panel, f, type), deselect: stopSceneExtrude,
    apply: async (f, mode, v) => {
      const st = useAppStore.getState(), fresh = shapeById(panel.id, st.shapes);
      if (fresh) await executeFaceExtrude({ panelShape: fresh, faceGroupIndex: f.gi, value: v, isFixed: mode === 'fixed', updateShape: st.updateShape,
        clickPoint: st.faceExtrudeClickPoint ?? undefined, plane });
    },
    ...(plane ? {
      fixedText: (span: string) => `Type the size across the panel up to this edge (now ${span} mm) — the neighbouring edges stretch to it`,
      dynText: 'Type how far the edge plane moves: + out, − in — the neighbouring edges stretch or shorten to it',
      refText: 'the edge plane goes up to a face you pick and follows it — the neighbouring edges stretch to it',
    } : {
      fixedText: (span: string) => `Type the size from the opposite edge (now ${span} mm)`, dynText: 'Type how far the edge moves: + out, − in',
      refText: 'the edge goes up to a face you pick, and follows it',
    }),
  }} />;
}

/** Kutu hedefinin (hacim / baza seti) yüz seçimi: depodaki yüz + normal + çıpa (motor adımı bunlarla yazar). */
function selectBoxFace(f: SceneFace, type: SceneExMode) {
  const st = useAppStore.getState();
  if (st.faceExtrudeValueMode !== type) st.setFaceExtrudeValueMode(type);
  st.setFaceExtrudeRefCandidate(null);
  st.setFaceExtrudeSelectedFace(f.gi);
  st.setFaceExtrudeCavityFaceNormal([f.n.x, f.n.y, f.n.z]);
  st.setFaceExtrudeClickPoint(f.sample);
}
function deselectBoxFace() {
  const st = useAppStore.getState();
  st.setFaceExtrudeSelectedFace(null); st.setFaceExtrudeCavityFaceNormal(null); st.setFaceExtrudeRefCandidate(null);
}
function useBoxFaces(boxes: Array<{ min: Vec3; max: Vec3 }>, spanOf: (n: THREE.Vector3, anchor: THREE.Vector3) => number) {
  const key = boxesKey(boxes);
  const geo = useMemo(() => boxSurfaceGeometry(boxes), [key]);   // eslint-disable-line react-hooks/exhaustive-deps
  useDisposable(geo);
  const faces = useMemo(() => (geo ? boxSceneFaces(geo, spanOf) : []), [geo]);   // eslint-disable-line react-hooks/exhaustive-deps
  useFaceDisposal(faces);
  const base = useMemo(() => {
    const bb = new THREE.Box3();
    for (const b of boxes) { bb.expandByPoint(new THREE.Vector3(...b.min)); bb.expandByPoint(new THREE.Vector3(...b.max)); }
    const sz = bb.getSize(new THREE.Vector3());
    return sceneExBase(Math.max(sz.x, sz.y, sz.z, 0) || 400);
  }, [key]);   // eslint-disable-line react-hooks/exhaustive-deps
  return { faces, base };
}

/** RAF / DİKME HACMİ (Volume): hacmin her yüzünde ok. Fixed = yüzün arkasındaki derinlik · Dyn = yüz şimdiki yerinden · Ref = panel yüzüne kadar. */
function VolumeSceneExtrude({ group, parent }: { group: PanelGroup; parent: Shape }) {
  const S = useStoreFields('faceExtrudeSelectedFace', 'faceExtrudeCavityFaceNormal');
  const boxes = useMemo(() => (group.region && group.region.length ? group.region : group.cavity ? [group.cavity] : []), [group.region, group.cavity]);
  const { faces, base } = useBoxFaces(boxes, (n, a) => boxColumnDepth(boxes, a, n));
  const matrix = useMemo(() => getShapeMatrix(parent), [parent.position, parent.rotation, parent.scale]);   // eslint-disable-line react-hooks/exhaustive-deps
  return <SceneExtrudeTool t={{
    id: group.id, label: 'Volume', noun: 'face', faces, matrix, base, modes: SCENE_EX_ORDER,
    activeGi: S.faceExtrudeCavityFaceNormal ? S.faceExtrudeSelectedFace : null, select: selectBoxFace, deselect: deselectBoxFace,
    apply: (f, mode, v) => executeCavityExtrudeAt(group.id, [f.n.x, f.n.y, f.n.z], v, mode, f.sample),
    fixedText: span => `Type the depth of the volume behind this face (now ${span} mm) — the shelves follow`,
    dynText: 'Type how far the face moves from where it is now: − in, + out (never beyond the free volume)',
    refText: 'the face goes up to a panel face you pick, and follows it',
  }} />;
}

/** BAZA SETİ (Volume): setin her yüzünde ok — yalnız Fixed / Dyn. Fixed = setin o eksendeki ölçüsü · Dyn = yüz değer kadar dışarı (− içeri). */
function PlinthSceneExtrude({ set, parent, shapes }: { set: PlinthSet; parent: Shape; shapes: Shape[] }) {
  const S = useStoreFields('faceExtrudeSelectedFace', 'faceExtrudeCavityFaceNormal');
  const boxes = useMemo(() => plinthBoxesOf(set, shapes), [set, shapes]);
  const { faces, base } = useBoxFaces(boxes, n => {
    const a = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)].indexOf(Math.max(Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)));
    return Math.max(...boxes.map(b => b.max[a])) - Math.min(...boxes.map(b => b.min[a]));
  });
  const matrix = useMemo(() => getShapeMatrix(parent), [parent.position, parent.rotation, parent.scale]);   // eslint-disable-line react-hooks/exhaustive-deps
  return <SceneExtrudeTool t={{
    id: set.id, label: 'Plinth set', noun: 'face', faces, matrix, base, modes: ['fixed', 'dyn'],
    activeGi: S.faceExtrudeCavityFaceNormal ? S.faceExtrudeSelectedFace : null, select: selectBoxFace, deselect: deselectBoxFace,
    apply: async (f, mode, v) => { applyPlinthFace(set.id, [f.n.x, f.n.y, f.n.z], v, mode); },
    fixedText: span => `Type the size of the set along this direction (now ${span} mm)`, dynText: 'Type how far the face moves: + out, − in',
    refText: '',
  }} />;
}

/* ─────────────────────────── SAHNE TAŞIMA + DÖNDÜRME ───────────────────────────
   Extrude ile aynı düzen: araç Assembly'deki Move / Rotate düğmesiyle açılır; tip sahnedeki döngü düğmesiyle çevrilir, değer okun / halkanın
   ucundaki kutusuz girişe yazılır, panelin gideceği yer akan hayalet çizgilerle görünür, açıklama durum çubuğundadır.
   TAŞIMA  — Dyn / Fixed: altı ok (panelin o anki dönüş çerçevesinde, motorla aynı eksenler); ok → mesafe. Ref: köşe noktaları (kaynak → hedef panel →
             hedef köşe → sağ tık). Dyn ve Fixed aynı kadar taşır; fark gövde boyutlanınca: Dyn oranla ölçeklenir, Fixed mm olarak sabit kalır.
   DÖNDÜRME — Dyn: eksen noktası → halka (X / Y / Z) → açı. Ref: eksen noktası → nişan noktası → halka → referans yüz → sağ tık. */

const numOf = (t: string): number | null => { const p = parseFloat(t.replace(',', '.')); return Number.isFinite(p) ? p : null; };
const nextOf = <T,>(order: T[], cur: T): T => order[(order.indexOf(cur) + 1) % order.length];

/** Panelin TAMAMININ gideceği yer: hedefte net çizgi + şimdiki yerden hedefe akan hayalet çizgiler. `pose(e, o)`: 0..1 ilerlemede panelin duruşunu
 *  (panel-yerel) `o`ya yazar. `demo`: değer yokken yalnız yön gösterimi (hedef çizgisi yok). */
function ScenePanelGhost({ matrix, edges, color, demo, pose }: {
  matrix: THREE.Matrix4; edges: Vec3[]; color: string; demo: boolean; pose: (e: number, o: THREE.Object3D) => void;
}) {
  const echoes = useRef<Array<THREE.Group | null>>([]), target = useRef<THREE.Group>(null);
  const N = 3;
  useFrame(({ clock }) => {
    if (target.current) pose(1, target.current);
    for (let i = 0; i < N; i++) {
      const g = echoes.current[i];
      if (!g) continue;
      const p = (clock.elapsedTime / 1.6 + i / N) % 1;
      pose(p * p * (3 - 2 * p), g);
      const line: any = g.children[0];
      if (line?.material) line.material.opacity = Math.sin(Math.PI * p) * (demo ? 0.7 : 0.9);
    }
  });
  if (edges.length < 2) return null;
  return (
    <group matrix={matrix} matrixAutoUpdate={false}>
      {!demo && <group ref={target}><EdgeLines points={edges} color={color} width={2.2} order={16} /></group>}
      {Array.from({ length: N }, (_, i) => (
        <group key={i} ref={el => { echoes.current[i] = el; }}>
          <Line points={edges} segments color={color} lineWidth={demo ? 1.3 : 1.6} transparent opacity={0} depthTest={false} depthWrite={false} renderOrder={15} raycast={noRaycast} />
        </group>
      ))}
    </group>
  );
}

/** Aracın tip düğmesi (panelin ortasında): extrude'daki döngü düğmesinin aynısı, bütün gizmonun tipini çevirir. */
function SceneTypeSwitch({ position, shift, type, onCycle, onHover }: {
  position: Vec3; shift?: string; type: SceneExMode; onCycle: () => void; onHover: (h: boolean) => void;
}) {
  return (
    <Html position={position} center zIndexRange={[66, 56]} style={{ pointerEvents: 'none' }}>
      <div style={{ pointerEvents: 'none', transform: shift }}><SceneExTypeBtn type={type} onCycle={onCycle} onHover={onHover} /></div>
    </Html>
  );
}

const MOVE_DIRS: AxisDir[] = ['x+', 'x-', 'y+', 'y-', 'z+', 'z-'];
const MOVE_TYPES: SceneExMode[] = ['dyn', 'fixed', 'ref'];
let _sceneMoveBusy = false;
export function PanelMoveGizmo({ panelShape }: { panelShape: Shape }) {
  const s = useStoreFields('panelMoveAxis', 'setPanelMoveAxis', 'panelMoveValueMode', 'setPanelMoveValueMode', 'panelMoveRefSourceVertex',
    'setPanelMoveRefSourceVertex', 'panelMoveRefTargetPanelId', 'setPanelMoveRefTargetPanelId', 'panelMoveRefTargetVertex', 'setPanelMoveRefTargetVertex',
    'shapes', 'virtualFaces');
  const { panelMoveRefSourceVertex: srcVertex, panelMoveRefTargetPanelId: targetId, panelMoveRefTargetVertex: tgtVertex, shapes } = s;
  const type = s.panelMoveValueMode as SceneExMode, isRef = type === 'ref', C = SCENE_EX[type];
  const panel = useMemo(() => shapeById(panelShape.id, shapes) || panelShape, [shapes, panelShape.id, panelShape]);
  const matrix = useMemo(() => getShapeMatrix(panel), [panel.position, panel.rotation, panel.scale]);   // eslint-disable-line react-hooks/exhaustive-deps
  const frame = useMemo(() => panelStepRotation(panel, s.virtualFaces), [panel.parameters?.transformSteps, s.virtualFaces]);   // eslint-disable-line react-hooks/exhaustive-deps
  const edges = useMemo(() => safeEdgePoints(panel.geometry, EDGE_ANGLE_THRESHOLD) ?? [], [panel.geometry]);
  // Oklar: panelin dönüş çerçevesindeki ±X / ±Y / ±Z; her ok panelin o yöndeki en dış noktasından çıkar.
  const layout = useMemo(() => {
    const pos = panel.geometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
    const bb = localBboxOf(panel.geometry);
    if (!pos || !bb) return null;
    const c = bb.getCenter(new THREE.Vector3()), sz = bb.getSize(new THREE.Vector3()), v = new THREE.Vector3();
    const arrows = MOVE_DIRS.map(axis => {
      const dir = axisDirToVec(axis).applyQuaternion(frame).normalize();
      let ext = 0;
      for (let i = 0; i < pos.count; i++) { const d = v.fromBufferAttribute(pos, i).sub(c).dot(dir); if (d > ext) ext = d; }
      return { axis, dir, origin: worldOf(c.clone().addScaledVector(dir, ext), matrix), normal: dir.clone().transformDirection(matrix) };
    });
    return { arrows, center: worldOf(c, matrix), base: THREE.MathUtils.clamp(Math.max(sz.x, sz.y, sz.z) * 0.12, 34, 96) };
  }, [panel.geometry, frame, matrix]);
  const [hover, setHover] = useState<AxisDir | null>(null);
  const [swHover, setSwHover] = useState(false);
  const [entry, setEntry] = useState<{ key: string; text: string } | null>(null);
  const axis = isRef ? null : s.panelMoveAxis;
  const entryKey = axis ? `${axis}|${type}` : '';
  const value = entry && entry.key === entryKey ? numOf(entry.text) : null;
  const moving = value !== null && Math.abs(value) > 0.001;

  const apply = async (v: number) => {
    if (!axis || _sceneMoveBusy) return;
    const st = useAppStore.getState();
    const fresh = shapeById(panel.id, st.shapes);
    if (!fresh) return;
    _sceneMoveBusy = true;
    try { await (type === 'fixed' ? executePanelMoveFixed : executePanelMove)({ panelShape: fresh, axis, value: v, updateShape: st.updateShape }); }
    catch (e) { console.error('[YAGO][SAHNE-TAŞIMA] uygulanamadı:', e); }
    finally { _sceneMoveBusy = false; }
    useAppStore.getState().setPanelMoveAxis(null);
  };
  const cycle = () => {
    const next = nextOf(MOVE_TYPES, type) as 'dyn' | 'fixed' | 'ref';
    s.setPanelMoveValueMode(next);
    if (next === 'ref') s.setPanelMoveAxis(null);
  };

  // Ref: kaynak / hedef köşe noktaları (mevcut akış) + seçilen iki nokta arasındaki yol.
  const sourceVertices = useMemo(() => (isRef && panel.geometry ? computeRealCorners(panel) : []), [isRef, panel]);
  const targetPanel = useMemo(() => (isRef && targetId ? shapeById(targetId, shapes) || null : null), [isRef, targetId, shapes]);
  const targetVertices = useMemo(() => (targetPanel?.geometry ? computeRealCorners(targetPanel) : []), [targetPanel]);
  const allMarks = useMemo(() => [...sourceVertices.map(v => ({ pos: v, group: 0 })), ...targetVertices.map(v => ({ pos: v, group: 1 }))],
    [sourceVertices, targetVertices]);
  const refAt = useDotOverlap(allMarks, i => vertEq(allMarks[i].group ? tgtVertex : srcVertex, allMarks[i].pos));
  const needsTargetPanel = !!srcVertex && !targetId;
  // Hedef panel seçildi, köşesi bekleniyor: hedef panel YALNIZ çizilir (refPickOf) → burada yalnız onun köşeleri görünür.
  const isolated = isRef && !!srcVertex && !!targetId && !tgtVertex;
  const pickSource = (pos: Vec3) => { s.setPanelMoveRefSourceVertex(pos); s.setPanelMoveRefTargetPanelId(null); s.setPanelMoveRefTargetVertex(null); };

  // Önizleme: panel-yerel öteleme vektörü.
  const lit = axis ?? hover;
  const litArrow = lit && layout ? layout.arrows.find(a => a.axis === lit) ?? null : null;
  const shift = useMemo(() => {
    if (isRef) {
      if (!srcVertex || !tgtVertex) return null;
      const inv = matrix.clone().invert();
      return { d: new THREE.Vector3(...tgtVertex).applyMatrix4(inv).sub(new THREE.Vector3(...srcVertex).applyMatrix4(inv)), demo: false };
    }
    if (!litArrow || !layout) return null;
    return axis && moving ? { d: litArrow.dir.clone().multiplyScalar(value!), demo: false } : { d: litArrow.dir.clone().multiplyScalar(layout.base * 1.1), demo: true };
  }, [isRef, srcVertex, tgtVertex, matrix, litArrow, layout, axis, moving, value]);

  const refStep = !srcVertex ? 0 : !targetId ? 1 : !tgtVertex ? 2 : 3;
  useStatusGuide(isRef ? {
    label: 'Move', type, steps: ['Corner', 'Target panel', 'Target corner', 'Confirm'], step: refStep,
    text: ['Click the corner of this panel to move from', 'Click the panel to move to — it is then shown alone to pick its corner',
      'Click the corner it should land on — the target panel is shown alone, turn the view to see every corner',
      'Right-click — the panel moves so the two corners meet'][refStep],
    note: swHover ? `Switch the move type → ${SCENE_EX_LABEL[nextOf(MOVE_TYPES, type)]}` : null,
    keys: refStep === 0 ? [gk('Esc', 'close')]
      : refStep === 1 ? [gk('Esc', 'back')]
      : refStep === 2 ? [...(refRingCount() > 1 ? [gk('Tab', 'panel behind')] : []), gk('Esc', 'back')] : [gk('Right-click', 'move'), gk('Esc', 'back')],
  } : {
    label: 'Move', type, steps: ['Arrow', 'Distance'], step: axis ? 1 : 0,
    text: axis ? `Type the distance along ${AXIS_DISPLAY[axis]} · negative moves the other way`
      : `Click an arrow — the direction to move · ${type === 'fixed' ? 'Fixed keeps the distance in mm' : 'Dyn scales the distance'} when the body is resized`,
    note: swHover ? `Switch the move type → ${SCENE_EX_LABEL[nextOf(MOVE_TYPES, type)]}` : !axis && hover ? `Move along ${AXIS_DISPLAY[hover]}` : null,
    keys: axis ? [gk('Enter', 'apply'), gk('Esc', 'back')] : [gk('Esc', 'close')],
  });
  if (!layout) return null;
  return (
    <group>
      {!isRef && layout.arrows.map((a, i) => {
        const isActive = a.axis === axis;
        return (
          <SceneExArrow key={a.axis} origin={a.origin} normal={a.normal} rail={null} sign={isActive && value !== null && value < 0 ? -1 : 1} base={layout.base}
            color={C.main} litColor={C.lit} lit={isActive || hover === a.axis} active={isActive} compact={false} phase={i * 1.1}
            tip={hover === a.axis && !isActive ? AXIS_DISPLAY[a.axis] : null}
            onPick={() => s.setPanelMoveAxis(isActive ? null : a.axis)} onHover={h => setHover(cur => (h ? a.axis : cur === a.axis ? null : cur))}>
            {isActive ? (
              <SceneNumInput key={entryKey} initial="" placeholder="0" unit="mm" color={C.main}
                title={`Distance along ${AXIS_DISPLAY[a.axis]} (mm) — Enter applies, Esc cancels`}
                parse={t => { const v = numOf(t); return { value: v, valid: v !== null && Math.abs(v) > 0.001 }; }}
                onText={t => setEntry({ key: entryKey, text: t })} onApply={v => { void apply(v); }} onCancel={() => useAppStore.getState().setPanelMoveAxis(null)} />
            ) : null}
          </SceneExArrow>
        );
      })}
      {isRef && !needsTargetPanel && !isolated && sourceVertices.map((v, i) => (
        <GizmoDot key={`src-${i}`} position={v} isSelected={vertEq(srcVertex, v)} accent={SCENE_EX.ref.main} groupRef={refAt(i)} onClick={pickSource} />
      ))}
      {isRef && targetId && targetVertices.map((v, i) => (
        <GizmoDot key={`tgt-${i}`} position={v} isSelected={vertEq(tgtVertex, v)} accent="#ea580c" onClick={s.setPanelMoveRefTargetVertex}
          groupRef={refAt(sourceVertices.length + i)} />
      ))}
      {isRef && srcVertex && tgtVertex && <EdgeLines points={[srcVertex, tgtVertex]} color={SCENE_EX.ref.main} width={1.6} order={17} />}
      {shift && (
        <ScenePanelGhost matrix={matrix} edges={edges} demo={shift.demo} color={isRef ? SCENE_EX.ref.lit : C.lit}
          pose={(e, o) => { o.position.copy(shift.d).multiplyScalar(e); }} />
      )}
      {!isolated && <SceneTypeSwitch position={layout.center} shift="translate(0, 26px)" type={type} onCycle={cycle} onHover={setSwHover} />}
    </group>
  );
}

/** Dönüş halkası: eksene dik çember (çizgi + görünmez simit vuruş alanı) ve üzerinde eksen harfi (kutusuz). Açı girişi harfin üstünde açılır. */
function SceneRotateRing({ center, normal, labelDir, radius, letter, color, selected, dimmed, disabled, onPick, onHover, children }: {
  center: Vec3; normal: THREE.Vector3; /** çember üstünde harfin duracağı yön (eksene dik, dünya) */ labelDir: THREE.Vector3; radius: number; letter: string;
  color: string; selected: boolean; dimmed: boolean; /** seçilemez (soluk, tıklanmaz) */ disabled?: boolean; onPick: () => void; onHover: (h: boolean) => void;
  children?: React.ReactNode;
}) {
  const [hov, setHov] = useState(false);
  const quat = useMemo(() => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal.clone().normalize()), [normal]);
  const pts = useMemo(() => Array.from({ length: 97 }, (_, i): Vec3 => { const a = (i / 96) * Math.PI * 2; return [Math.cos(a) * radius, Math.sin(a) * radius, 0]; }), [radius]);
  const labelPos = useMemo<Vec3>(() => [center[0] + labelDir.x * radius, center[1] + labelDir.y * radius, center[2] + labelDir.z * radius], [center, labelDir, radius]);
  const hover = (h: boolean) => { setHov(h); onHover(h); hoverCursor(h); };
  const on = !disabled && (selected || hov);
  const fade = disabled ? 0.12 : dimmed ? 0.18 : 0.7;
  return (
    <group>
      <group position={center} quaternion={quat}>
        <Line points={pts} color={color} lineWidth={selected ? 2.8 : hov ? 2.3 : 1.5} transparent opacity={on ? 1 : fade} depthTest={false} depthWrite={false}
          renderOrder={RENDER_ORDER} raycast={noRaycast} />
        {selected && (
          <mesh renderOrder={RENDER_ORDER - 1} raycast={noRaycast}>
            <circleGeometry args={[radius, 64]} />
            <meshBasicMaterial color={color} transparent opacity={0.07} depthTest={false} depthWrite={false} side={THREE.DoubleSide} />
          </mesh>
        )}
        {!disabled && (
          <mesh name="sx-ring" raycast={frontHitRaycast} onClick={e => { e.stopPropagation(); onPick(); }} onPointerDown={stopEvent}
            onPointerOver={e => { e.stopPropagation(); hover(true); }} onPointerOut={() => hover(false)}>
            <torusGeometry args={[radius, radius * 0.05, 8, 64]} />
            <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} side={THREE.DoubleSide} />
          </mesh>
        )}
      </group>
      <Html position={labelPos} center zIndexRange={[64, 54]} style={{ pointerEvents: 'none' }}>
        <div onClick={e => { e.stopPropagation(); if (!disabled) onPick(); }} onMouseEnter={() => { if (!disabled) hover(true); }} onMouseLeave={() => hover(false)}
          style={{ ...EX_TEXT, pointerEvents: disabled ? 'none' : 'auto', cursor: 'pointer', fontFamily: FONT, fontSize: 12, fontWeight: 800, color, padding: '1px 4px',
            opacity: on ? 1 : disabled ? 0.25 : dimmed ? 0.35 : 0.9 }}>{letter}</div>
      </Html>
      {children && (
        <Html position={labelPos} center zIndexRange={[70, 60]} style={{ pointerEvents: 'none' }}>
          <div style={{ pointerEvents: 'none', transform: 'translate(0, -24px)', whiteSpace: 'nowrap' }}>{children}</div>
        </Html>
      )}
    </group>
  );
}

/** Dönüş açısı dilimi: eksen noktasında, halka düzleminde 0 → açı (dünya koordinatları). */
function SceneAngleSector({ center, normal, toward, fallback, radius, deg, color }: {
  center: Vec3; normal: THREE.Vector3; /** dilimin başladığı yön (düzleme izdüşer); eksene paralelse `fallback` */ toward: THREE.Vector3; fallback: THREE.Vector3;
  radius: number; deg: number; color: string;
}) {
  const { fill, arc } = useMemo(() => {
    const c = new THREE.Vector3(...center), n = normal.clone().normalize();
    const flat = (v: THREE.Vector3) => v.clone().addScaledVector(n, -v.dot(n));
    let u = flat(toward);
    if (u.lengthSq() < 1) u = flat(fallback);
    u.normalize();
    const w = new THREE.Vector3().crossVectors(n, u);
    const rad = (deg * Math.PI) / 180, steps = Math.max(6, Math.ceil(Math.abs(deg) / 4));
    const at = (t: number) => c.clone().addScaledVector(u, Math.cos(t) * radius).addScaledVector(w, Math.sin(t) * radius);
    const pos: number[] = [], line: Vec3[] = [[c.x, c.y, c.z]];
    for (let i = 0; i < steps; i++) {
      const a = at((rad * i) / steps), b = at((rad * (i + 1)) / steps);
      pos.push(c.x, c.y, c.z, a.x, a.y, a.z, b.x, b.y, b.z);
      if (i === 0) line.push([a.x, a.y, a.z]);
      line.push([b.x, b.y, b.z]);
    }
    line.push([c.x, c.y, c.z]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return { fill: g, arc: line };
  }, [center, normal, toward, fallback, radius, deg]);
  useEffect(() => () => fill.dispose(), [fill]);
  return (
    <>
      <mesh geometry={fill} renderOrder={14} raycast={noRaycast}><OverlayMat color={new THREE.Color(color).getHex()} opacity={0.3} /></mesh>
      <Line points={arc} color={color} lineWidth={2} depthTest={false} depthWrite={false} transparent renderOrder={16} raycast={noRaycast} />
    </>
  );
}

function computeFaceCenters(panelShape: Shape): Vec3[] {
  const geo = outlineGeometry(panelShape) ?? panelShape.geometry;   // delik / kanal köşeleri merkezi kaydırmasın
  if (!geo) return [];
  const corners = uniqueMeshPoints(geo, 100);
  if (corners.length < 8) return [];
  let minD = Infinity;
  const thickDir = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < corners.length; i++) for (let j = i + 1; j < corners.length; j++) {
    const d = corners[i].distanceTo(corners[j]);
    if (d > 0.01 && d < minD) { minD = d; thickDir.copy(corners[j]).sub(corners[i]).normalize(); }
  }
  const projs = corners.map(c => c.dot(thickDir));
  const mid = (Math.min(...projs) + Math.max(...projs)) / 2;
  const g1: THREE.Vector3[] = [], g2: THREE.Vector3[] = [];
  corners.forEach((c, i) => (projs[i] <= mid ? g1 : g2).push(c));
  const avg = (pts: THREE.Vector3[]) => { const c = new THREE.Vector3(); for (const p of pts) c.add(p); return c.divideScalar(pts.length || 1); };
  const mat = getShapeMatrix(panelShape);
  return [avg(g1), avg(g2)].map(p => worldOf(p, mat));
}

type PivotKind = 'vertex' | 'center';
const ROTATE_TYPES: SceneExMode[] = ['dyn', 'ref'];
const ROT_LETTERS: AxisLetter[] = ['x', 'y', 'z'];
let _sceneRotateBusy = false;
export function PanelRotateGizmo({ panelShape }: { panelShape: Shape }) {
  const s = useStoreFields('panelRotatePivot', 'setPanelRotatePivot', 'panelRotateAxis', 'setPanelRotateAxis', 'panelRotateValueMode', 'setPanelRotateValueMode',
    'panelRotateRefArmVertex', 'setPanelRotateRefArmVertex', 'panelRotateRefFace', 'setPanelRotateRefFace', 'virtualFaces', 'refPickNote');
  const { panelRotatePivot: pivot, panelRotateRefArmVertex: arm, panelRotateRefFace: refFace, refPickNote: refNote } = s;
  const { setPanelRotatePivot, setPanelRotateAxis, setPanelRotateRefArmVertex, setPanelRotateRefFace } = s;
  const type: SceneExMode = s.panelRotateValueMode === 'ref' ? 'ref' : 'dyn', isRef = type === 'ref', C = SCENE_EX[type];
  const hasPivot = pivot !== null, axis = s.panelRotateAxis;
  const showRings = hasPivot && (!isRef || arm !== null);
  const vf = vfOfPanel(panelShape, s.virtualFaces);
  const matrix = useMemo(() => getShapeMatrix(panelShape), [panelShape.position, panelShape.rotation, panelShape.scale]);   // eslint-disable-line react-hooks/exhaustive-deps
  const frame = useMemo(() => panelStepRotation(panelShape, s.virtualFaces), [panelShape.parameters?.transformSteps, s.virtualFaces]);   // eslint-disable-line react-hooks/exhaustive-deps
  const edges = useMemo(() => safeEdgePoints(panelShape.geometry, EDGE_ANGLE_THRESHOLD) ?? [], [panelShape.geometry]);
  const pivots = useMemo<Array<{ pos: Vec3; kind: PivotKind }>>(() => [
    ...computeRealCorners(panelShape).map(p => ({ pos: p, kind: 'vertex' as const })),
    ...computeFaceCenters(panelShape).map(p => ({ pos: p, kind: 'center' as const })),
  ], [panelShape.position, panelShape.rotation, panelShape.scale, panelShape.geometry]);   // eslint-disable-line react-hooks/exhaustive-deps
  const { ringRadius, center } = useMemo(() => {
    const bb = localBboxOf(panelShape.geometry);
    if (!bb) return { ringRadius: 40, center: panelShape.position as Vec3 };
    const sz = bb.getSize(new THREE.Vector3());
    return { ringRadius: Math.max(sz.x, sz.y, sz.z) * 0.35, center: worldOf(bb.getCenter(new THREE.Vector3()), matrix) };
  }, [panelShape.geometry, matrix]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Eksenler motorla aynı: harf → VF'ye en yakın yerel eksen (`mapAxisToVfLocal`) → birikmiş dönüş çerçevesi. Dünya = gövde dönüşüyle.
  const axes = useMemo(() => Object.fromEntries(ROT_LETTERS.map(l => {
    const m = mapAxisToVfLocal(vf, l);
    const local = (m ? new THREE.Vector3(...m) : axisDirToVec(`${l}+`)).normalize().applyQuaternion(frame).normalize();
    return [l, { local, world: local.clone().transformDirection(matrix) }];
  })) as Record<AxisLetter, { local: THREE.Vector3; world: THREE.Vector3 }>, [vf, frame, matrix]);
  // Ref: nişan noktası bir eksenin ÜZERİNDEYSE o eksende dönmez (açı tanımsız) → o halka seçilemez.
  const blocked = useMemo(() => {
    const out: Record<AxisLetter, boolean> = { x: false, y: false, z: false };
    if (!isRef || !pivot || !arm) return out;
    const a0 = new THREE.Vector3(...arm).sub(new THREE.Vector3(...pivot));
    for (const l of ROT_LETTERS) out[l] = new THREE.Vector3().crossVectors(axes[l].world, a0).length() < 0.5;
    return out;
  }, [isRef, pivot, arm, axes]);
  const anyBlocked = blocked.x || blocked.y || blocked.z;
  const refAt = useDotOverlap(useMemo(() => pivots.map(pv => ({ pos: pv.pos, group: 0 })), [pivots]),
    i => vertEq(pivot, pivots[i].pos) || vertEq(arm, pivots[i].pos));
  const [hover, setHover] = useState<AxisLetter | null>(null);
  const [swHover, setSwHover] = useState(false);
  const [entry, setEntry] = useState<{ key: string; text: string } | null>(null);
  const entryKey = axis && pivot ? `${axis}|${pivot.join(',')}` : '';
  const value = entry && entry.key === entryKey ? numOf(entry.text) : null;
  const turning = value !== null && Math.abs(value) > 0.001;

  // dyn: her tıklama eksen noktasını yeniden belirler. ref: 1. tık eksen noktası, 2. tık NİŞAN; seçili noktaya tekrar tık akışı sıfırlar.
  const resetAfterPivot = () => { setPanelRotateAxis(null); setPanelRotateRefArmVertex(null); setPanelRotateRefFace(null); };
  const handleOwnDotClick = (point: Vec3) => {
    if (!isRef) { setPanelRotatePivot(point); setPanelRotateAxis(null); return; }
    if (!hasPivot) { setPanelRotatePivot(point); resetAfterPivot(); return; }
    if (vertEq(pivot, point)) { setPanelRotatePivot(null); resetAfterPivot(); return; }
    setPanelRotateRefArmVertex(point); setPanelRotateAxis(null); setPanelRotateRefFace(null);
  };
  const handleAxisSelect = (a: AxisLetter) => {
    if (blocked[a]) return;
    setPanelRotateAxis(a === axis ? null : a);
    if (isRef) setPanelRotateRefFace(null);   // eksen değişti → referans seçimi baştan
  };
  const apply = async (v: number) => {
    if (isRef || !axis || !pivot || _sceneRotateBusy) return;
    const st = useAppStore.getState();
    const fresh = shapeById(panelShape.id, st.shapes);
    if (!fresh) return;
    _sceneRotateBusy = true;
    // Motor eksen noktasını GÖVDE-YEREL çözer (VF oranı); sahnedeki nokta dünya koordinatında → taşınmış / dönmüş gövdede yerele çevrilir.
    const local = new THREE.Vector3(...pivot).applyMatrix4(getShapeMatrix(fresh).clone().invert());
    try { await executePanelRotate({ panelShape: fresh, axis, value: v, pivot: [local.x, local.y, local.z], updateShape: st.updateShape }); }
    catch (e) { console.error('[YAGO][SAHNE-DÖNDÜRME] uygulanamadı:', e); }
    finally { _sceneRotateBusy = false; }
    useAppStore.getState().setPanelRotateAxis(null);
  };

  // Önizleme açısı: Dyn'de girilen (yoksa yön gösterimi), Ref'te nişan noktası referans yüze değene kadar.
  const litAxis = axis ?? hover;
  const turn = useMemo(() => {
    if (!pivot || !litAxis || !showRings) return null;
    if (isRef) {
      if (!axis || !arm || !refFace || refFace.faceGroupIndex < 0) return null;
      const sol = angleToTouchPlane(new THREE.Vector3(...pivot), new THREE.Vector3(...arm), axes[axis].world, new THREE.Vector3(...refFace.normalWorld),
        new THREE.Vector3(...refFace.pointWorld), 0);
      return sol && Math.abs(sol.deg) > 0.01 ? { deg: sol.deg, demo: false, letter: axis } : null;
    }
    return axis && turning ? { deg: value!, demo: false, letter: axis } : { deg: 24, demo: true, letter: litAxis };
  }, [pivot, litAxis, showRings, isRef, axis, arm, refFace, axes, turning, value]);
  const pivotLocal = useMemo(() => (pivot ? new THREE.Vector3(...pivot).applyMatrix4(matrix.clone().invert()) : null), [pivot, matrix]);
  const tmpQ = useRef(new THREE.Quaternion()), tmpV = useRef(new THREE.Vector3());

  // Panel yeniden kurulunca (uygulama / dış değişiklik) seçili nokta artık bir köşe değilse akış başa döner.
  useEffect(() => {
    const st = useAppStore.getState();
    const gone = (p: Vec3 | null) => !!p && !pivots.some(pv => vertEq(p, pv.pos));
    if (gone(st.panelRotatePivot)) { st.setPanelRotatePivot(null); st.setPanelRotateAxis(null); st.setPanelRotateRefArmVertex(null); st.setPanelRotateRefFace(null); }
    else if (gone(st.panelRotateRefArmVertex)) { st.setPanelRotateRefArmVertex(null); st.setPanelRotateAxis(null); st.setPanelRotateRefFace(null); }
  }, [pivots]);
  // Referans: panel tıklanır → yalnız bırakılır → yüzü seçilir (REFERANS SEÇİMİ); o sırada gizmo çizilmez.
  const rp = useRefPick(), isolated = isRef && rp?.tool === 'rotate' && rp.stage === 'isolated';
  const refStep = !hasPivot ? 0 : !arm ? 1 : !axis ? 2 : refFace ? 5 : isolated ? 4 : 3;
  const dynStep = !hasPivot ? 0 : !axis ? 1 : 2;
  const swNote = swHover ? `Switch the rotate type → ${SCENE_EX_LABEL[nextOf(ROTATE_TYPES, type)]}` : null;
  useStatusGuide(isRef ? {
    label: 'Rotate', type, steps: ['Pivot', 'Aim point', 'Axis', 'Reference panel', 'Its face', 'Confirm'], step: refStep,
    text: ['Click the point the panel turns around — a corner or a face centre', 'Click the aim point — the point that will touch the face',
      `Click a ring — the axis to turn around${anyBlocked ? ' · the faded ring passes through the aim point' : ''}`,
      'Click the panel (or the body) to aim at — it is then shown alone to pick its face',
      'Click the face to aim at — the panel is shown alone, turn the view to see every face',
      'Right-click — the panel turns until the aim point touches the face · click another panel to change it'][refStep],
    note: swNote ?? (isolated ? refNote : refStep === 2 && hover && !blocked[hover] ? `Turn around ${hover.toUpperCase()}` : null),
    keys: refStep === 0 ? [gk('Esc', 'close')]
      : refStep === 4 ? [...(refRingCount() > 1 ? [gk('Tab', 'panel behind')] : []), gk('Esc', 'back')]
      : refStep === 5 ? [gk('Right-click', 'turn'), gk('Esc', 'back')] : [gk('Esc', 'back')],
  } : {
    label: 'Rotate', type, steps: ['Pivot', 'Axis', 'Angle'], step: dynStep,
    text: ['Click the point the panel turns around — a corner or a face centre', 'Click a ring — the axis to turn around',
      `Type the angle around ${(axis ?? 'x').toUpperCase()} in degrees · negative turns the other way`][dynStep],
    note: swNote ?? (dynStep === 1 && hover ? `Turn around ${hover.toUpperCase()}` : null),
    keys: dynStep === 2 ? [gk('Enter', 'apply'), gk('Esc', 'back')] : dynStep === 1 ? [gk('Esc', 'back')] : [gk('Esc', 'close')],
  });
  if (isolated) return null;
  return (
    <group>
      {pivots.map((pv, i) => {
        const isArm = isRef && vertEq(arm, pv.pos);
        return <GizmoDot key={`pivot-${i}`} position={pv.pos} groupRef={refAt(i)} onClick={() => handleOwnDotClick(pv.pos)}
          isSelected={vertEq(pivot, pv.pos) || isArm} accent={isArm ? '#0d9488' : pv.kind === 'center' ? '#ea580c' : '#44403c'} />;
      })}
      {showRings && ROT_LETTERS.map((l, i) => (
        <SceneRotateRing key={l} center={pivot!} normal={axes[l].world} labelDir={axes[ROT_LETTERS[(i + 1) % 3]].world} radius={ringRadius} letter={l.toUpperCase()}
          color={AXIS_RGB[l].main} selected={axis === l} dimmed={axis !== null && axis !== l} disabled={blocked[l]} onPick={() => handleAxisSelect(l)}
          onHover={h => setHover(cur => (h ? l : cur === l ? null : cur))}>
          {!isRef && axis === l ? (
            <SceneNumInput key={entryKey} initial="" placeholder="0" unit="°" color={AXIS_RGB[l].main}
              title={`Angle around ${l.toUpperCase()} (degrees) — Enter applies, Esc cancels`}
              parse={t => { const v = numOf(t); return { value: v, valid: v !== null && Math.abs(v) > 0.001 }; }}
              onText={t => setEntry({ key: entryKey, text: t })} onApply={v => { void apply(v); }} onCancel={() => useAppStore.getState().setPanelRotateAxis(null)} />
          ) : null}
        </SceneRotateRing>
      ))}
      {turn && pivot && pivotLocal && (
        <>
          {!turn.demo && (
            <SceneAngleSector center={pivot} normal={axes[turn.letter].world} radius={ringRadius} deg={turn.deg} color={C.lit}
              toward={new THREE.Vector3(...center).sub(new THREE.Vector3(...pivot))} fallback={axes[ROT_LETTERS[(ROT_LETTERS.indexOf(turn.letter) + 1) % 3]].world} />
          )}
          <ScenePanelGhost matrix={matrix} edges={edges} demo={turn.demo} color={C.lit}
            pose={(e, o) => {
              const q = tmpQ.current.setFromAxisAngle(axes[turn.letter].local, (turn.deg * e * Math.PI) / 180);
              o.quaternion.copy(q);
              o.position.copy(pivotLocal).sub(tmpV.current.copy(pivotLocal).applyQuaternion(q));
            }} />
        </>
      )}
      <SceneTypeSwitch position={center} shift="translate(22px, -22px)" type={type} onHover={setSwHover}
        onCycle={() => s.setPanelRotateValueMode(nextOf(ROTATE_TYPES, type) as 'dyn' | 'ref')} />
    </group>
  );
}

export function PanelGizmos({ shapes }: { shapes: any[] }) {
  const s = useStoreFields('panelMoveMode', 'panelMoveTargetPanelId', 'panelRotateMode', 'panelRotateTargetPanelId', 'faceExtrudeMode',
    'faceExtrudeCavityGroupId', 'faceExtrudePlinthId', 'panelGroups', 'plinthSets');
  const rp = useRefPick();
  const panelOf = (on: boolean, id: string | null) => { const p = on && id ? shapeById(id, shapes) : undefined; return p && p.type === 'panel' ? p : null; };
  const mv = panelOf(s.panelMoveMode, s.panelMoveTargetPanelId), rt = panelOf(s.panelRotateMode, s.panelRotateTargetPanelId);
  // Extrude sahnede: panelin kenarları (PanelSceneExtrude), raf / dikme hacminin yüzleri (VolumeSceneExtrude), baza setinin yüzleri (PlinthSceneExtrude).
  const ex = useSceneExtrudePanel();
  const cav = s.faceExtrudeMode && s.faceExtrudeCavityGroupId ? s.panelGroups.find(g => g.id === s.faceExtrudeCavityGroupId) : undefined;
  const ps = s.faceExtrudeMode && s.faceExtrudePlinthId ? s.plinthSets.find(x => x.id === s.faceExtrudePlinthId) : undefined;
  const cavParent = cav ? shapeById(cav.shapeId, shapes) : undefined, psParent = ps ? shapeById(ps.shapeId, shapes) : undefined;
  // Referans seçimi: yalnız bırakılan panelin yüzleri (taşımada köşeleri gizmonun kendisinde) · seçilmiş yüzün vurgusu.
  const facePick = rp && rp.tool !== 'move' ? rp : null;
  return <>{mv && <PanelMoveGizmo panelShape={mv} />}{rt && <PanelRotateGizmo panelShape={rt} />}{ex && <PanelSceneExtrude key={ex.id} panel={ex} />}
    {cav && cavParent && <VolumeSceneExtrude key={cav.id} group={cav} parent={cavParent} />}
    {ps && psParent && <PlinthSceneExtrude key={ps.id} set={ps} parent={psParent} shapes={shapes} />}
    {facePick?.stage === 'isolated' && <RefIsolatePicker key={facePick.isoId} rp={facePick} />}
    {facePick?.stage === 'picked' && <RefFaceMark rp={facePick} />}</>;
}

const GL_OPTS = { antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' } as const;

const Scene: React.FC = () => {
  const controlsRef = useRef<any>(null);
  const upFixRef = useRef<THREE.Vector3 | null>(null);   // hareketin başındaki bakış yönü; yalnız yön değişirse (döndürme) up düzeltilir
  const { shapes, cameraType, selectedShapeId, secondarySelectedShapeId, selectShape, deleteShape, exitIsolation, vertexEditMode, setVertexEditMode,
    selectedVertexIndex, setSelectedVertexIndex, vertexDirection, setVertexDirection, setFaceEditMode, filletMode, selectedFilletFaces, clearFilletFaces } =
    useStoreFields('shapes', 'cameraType', 'selectedShapeId', 'secondarySelectedShapeId', 'selectShape', 'deleteShape', 'exitIsolation',
      'vertexEditMode', 'setVertexEditMode', 'selectedVertexIndex', 'setSelectedVertexIndex', 'vertexDirection', 'setVertexDirection',
      'setFaceEditMode', 'filletMode', 'selectedFilletFaces', 'clearFilletFaces');

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      // Kısayollar input/textarea içindeyken ÇALIŞMAZ (Delete gövdeyi silmesin, Escape panel satırını kapatmasın).
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      // Tab: referans paneli yalnız bırakılmışken aynı tıklamanın arkasındaki panele geçer.
      if (e.key === 'Tab' && cycleRefPanel()) { e.preventDefault(); return; }
      if (e.key === 'Delete' && selectedShapeId) deleteShape(selectedShapeId);
      else if (e.key === 'Escape') {
        // Aktif araç/mod varsa Escape yalnız onu kapatır (şeridin ✕'i gibi); seçim korunur.
        const st = useAppStore.getState();
        // preventDefault: kenar çubuğunun Esc'i aynı basışta şeridi kapatmasın (durum çubuğu "Esc exit" der, yalnız araç kapanır).
        if (st.volumePickMode) { e.preventDefault(); st.setVolumePickMode(null); return; }
        if (st.doorPickMode) { e.preventDefault(); st.setDoorPickMode(false); return; }
        if (st.backPickMode) { e.preventDefault(); st.setBackPickMode(false); return; }
        if (st.plinthPickMode) { e.preventDefault(); st.setPlinthPickMode(false); return; }
        if (st.raycastMode) { e.preventDefault(); st.setRaycastMode(false); return; }
        if (st.quickBodyMode) { e.preventDefault(); st.setQuickBodyMode(false); return; }
        // Vertex: önce seçili köşe bırakılır, sonra kip kapanır. Fillet: seçimler ve kip kapanır (gövde seçili kalır).
        if (st.vertexEditMode) {
          e.preventDefault();
          if (st.selectedVertexIndex !== null) { st.setSelectedVertexIndex(null); st.setVertexDirection(null); } else st.setVertexEditMode(false);
          return;
        }
        if (st.filletMode) { e.preventDefault(); st.setFilletMode(false); st.setFaceEditMode(false); st.clearFilletFaces(); st.clearFilletFaceData(); return; }
        // REFERANS SEÇİMİ (extrude · hacim · döndürme): yalnız bırakılan panel → geri (panel seçimi); seçilmiş yüz → geri.
        if (st.refIsolateId) { e.preventDefault(); st.setRefIsolateId(null); return; }
        // SAHNE EXTRUDE (panel · hacim · baza seti): Esc bir adım geri — referans yüzü → seçili yüz → araç. Kenar çubuğu açık kalır.
        if (st.faceExtrudeMode || st.sceneExtrudePanelId) {
          e.preventDefault();
          const box = !!st.faceExtrudeCavityGroupId || !!st.faceExtrudePlinthId;
          if (st.faceExtrudeMode && st.faceExtrudeRefCandidate) st.setFaceExtrudeRefCandidate(null);
          else if (st.faceExtrudeMode && st.faceExtrudeSelectedFace !== null) {
            if (box) { st.setFaceExtrudeSelectedFace(null); st.setFaceExtrudeCavityFaceNormal(null); } else st.setFaceExtrudeMode(false);
          }
          else if (st.sceneExtrudePanelId) { st.setFaceExtrudeMode(false); st.setSceneExtrudePanelId(null); }
          else st.setFaceExtrudeMode(false);
          return;
        }
        if (isPlinthRow(st.selectedPanelRow)) { finishPlinthEdit(); return; }   // seçili baza seti: önce seti bırak
        // Sahne taşıma / döndürme: Esc bir adım geri alır (eksen → seçimler → araç). preventDefault: kenar çubuğu açık kalsın.
        if (st.panelMoveMode) {
          e.preventDefault();
          if (st.panelMoveAxis) st.setPanelMoveAxis(null);
          else if (st.panelMoveValueMode === 'ref' && st.panelMoveRefTargetVertex) st.setPanelMoveRefTargetVertex(null);   // → hedef panel yine yalnız
          else if (st.panelMoveValueMode === 'ref' && st.panelMoveRefTargetPanelId) st.setPanelMoveRefTargetPanelId(null);   // → hedef panel seçimi
          else if (st.panelMoveValueMode === 'ref' && st.panelMoveRefSourceVertex) st.setPanelMoveValueMode('ref');
          else st.setPanelMoveMode(false);
          return;
        }
        if (st.panelRotateMode) {
          e.preventDefault();
          if (st.panelRotateRefFace) st.setPanelRotateRefFace(null);
          else if (st.panelRotateAxis !== null) { st.setPanelRotateAxis(null); st.setPanelRotateRefFace(null); }
          else if (st.panelRotateRefArmVertex) st.setPanelRotateRefArmVertex(null);
          else if (st.panelRotatePivot) st.setPanelRotatePivot(null);
          else st.setPanelRotateMode(false);
          return;
        }
        selectShape(null); exitIsolation(); setVertexEditMode(false); setFaceEditMode(false); clearFilletFaces();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'g') {
        e.preventDefault();
        if (selectedShapeId && secondarySelectedShapeId) useAppStore.getState().createGroup(selectedShapeId, secondarySelectedShapeId);
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [selectedShapeId, secondarySelectedShapeId, deleteShape, selectShape, exitIsolation, setVertexEditMode, setFaceEditMode, clearFilletFaces]);

  useEffect(() => {
    const blockContextMenu = (e: MouseEvent) => e.preventDefault();
    window.addEventListener('contextmenu', blockContextMenu, true);
    return () => window.removeEventListener('contextmenu', blockContextMenu, true);
  }, []);

  // Terminal köprüsü: girilen sayı bekleyen vertex düzenlemesine / fillet yarıçapına gider.
  useEffect(() => {
    (window as any).handleVertexOffset = async (newValue: number) => {
      const cs = useAppStore.getState();
      const { selectedShapeId: sid, selectedVertexIndex: vi, vertexDirection: vd } = cs;
      if (sid && vi !== null && vd) {
        const shape = shapeById(sid, cs.shapes);
        if (!shape?.parameters) return;
        // vi editörün köşe listesinin indeksidir (mesh tamponu değil); tek kaynak resolveBaseVertices.
        const bv = await resolveBaseVertices(shape);
        if (vi >= bv.length) return;
        const op: Vec3 = [bv[vi].x, bv[vi].y, bv[vi].z];
        const ai = axisIndexOf(vd);
        const np: Vec3 = [...op] as Vec3; np[ai] = newValue;
        const off: Vec3 = [0, 0, 0]; off[ai] = newValue - op[ai];
        const description = `Vertex ${vi} ${vd[0].toUpperCase()}${vd[1] === '+' ? '+' : '-'}`;
        cs.addVertexModification(sid, {
          vertexIndex: vi, originalPosition: op, newPosition: np, direction: vd, expression: String(newValue), description, offset: off,
        });
        if (childPanelsOf(sid).length) {
          try { await requestRebuild(sid); }
          catch (e) { console.error('[YAGO][VERTEX] rebuild hatası:', e); }
        }
      }
      (window as any).pendingVertexEdit = false; cs.setSelectedVertexIndex(null);
    };
    (window as any).pendingVertexEdit = selectedVertexIndex !== null && vertexDirection !== null;
    return () => { delete (window as any).handleVertexOffset; delete (window as any).pendingVertexEdit; };
  }, [selectedVertexIndex, vertexDirection]);

  useEffect(() => {
    (window as any).handleFilletRadius = async (radius: number) => {
      const cs = useAppStore.getState();
      const { selectedShapeId: sid, filletMode: fm, selectedFilletFaces: sff, selectedFilletFaceData: sffd } = cs;
      if (sid && fm && sff.length === 2 && sffd.length === 2) {
        const shape = shapeById(sid, cs.shapes); if (!shape?.replicadShape) return;
        try {
          const oc = localBboxOf(shape.geometry)?.getCenter(new THREE.Vector3()) ?? new THREE.Vector3();
          const result = await applyFilletToShape(shape, sff, sffd, radius);
          const nbv = await getReplicadVertices(result.replicadShape);
          const nc = localBboxOf(result.geometry)!.getCenter(new THREE.Vector3());
          // Fillet sonrası kutu merkezi kayar: gövde konumu (dönüş dahil) aynı miktar geri alınır.
          const ro = new THREE.Vector3().subVectors(nc, oc);
          const [rx, ry, rz] = shape.rotation;
          if (rx || ry || rz) ro.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ')));
          const p = shape.parameters;
          cs.updateShape(sid, {
            geometry: result.geometry, replicadShape: result.replicadShape,
            position: [shape.position[0] - ro.x, shape.position[1] - ro.y, shape.position[2] - ro.z], rotation: shape.rotation, scale: shape.scale,
            parameters: { ...p, scaledBaseVertices: nbv.map(v => [v.x, v.y, v.z]), width: p.width || 1, height: p.height || 1, depth: p.depth || 1 },
            fillets: [...(shape.fillets || []), result.filletData],
          });
          cs.clearFilletFaces();
          try { await requestRebuild(sid); } catch (err) { console.error('rebuild after fillet failed:', err); }
        } catch (err) { console.error('fillet failed:', err); cs.clearFilletFaces(); alert(`Failed to apply fillet: ${(err as Error).message}`); }
      }
      (window as any).pendingFilletOperation = false;
    };
    (window as any).pendingFilletOperation = filletMode && selectedFilletFaces.length === 2;
    return () => { delete (window as any).handleFilletRadius; delete (window as any).pendingFilletOperation; };
  }, [filletMode, selectedFilletFaces.length]);

  const handleCreated = useCallback(({ gl }: { gl: THREE.WebGLRenderer }) => {
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.0;
    gl.shadowMap.type = THREE.PCFSoftShadowMap;
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.domElement.addEventListener('webglcontextlost', e => e.preventDefault());
  }, []);

  return (
    <ErrorBoundary>
      <Canvas shadows gl={GL_OPTS} dpr={[1, 2]} onCreated={handleCreated}>
        <color attach="background" args={['#fdfcfa']} />
        <CameraController controlsRef={controlsRef} cameraType={cameraType} />

        <ambientLight intensity={4.0} />
        <directionalLight position={[1500, 2500, 1500]} intensity={4.8} castShadow
          shadow-mapSize-width={2048} shadow-mapSize-height={2048} shadow-bias={-0.0005}
          shadow-camera-far={15000} shadow-camera-left={-3000} shadow-camera-right={3000}
          shadow-camera-top={3000} shadow-camera-bottom={-3000} />
        <directionalLight position={[-1000, 1500, -1000]} intensity={0.4} />
        <directionalLight position={[0, 2000, -2000]} intensity={0.3} />
        <directionalLight position={[500, 500, 3000]} intensity={0.5} />

        {/* Turntable: üst / alt / yüz görünüşünde up dünya-Y değildir; up yalnız görünüm GERÇEKTEN döndürülünce dünya-Y'ye alınır.
            'start' kaydırma (sağ tık), tekerlek ve sürüklemesiz tıkta da gelir — orada up'a dokunmak görünümü kendi ekseninde çeviriyordu. */}
        <OrbitControls ref={controlsRef} makeDefault target={[0, 0, 0]} enableDamping dampingFactor={0.2} rotateSpeed={0.8} maxDistance={25000} minDistance={50}
          onStart={() => {
            const c: any = controlsRef.current;
            upFixRef.current = c?.object ? c.object.position.clone().sub(c.target).normalize() : null;
          }}
          onChange={() => {
            const d0 = upFixRef.current, c: any = controlsRef.current, cam: any = c?.object;
            if (!d0 || !cam?.up) return;
            if (cam.position.clone().sub(c.target).normalize().angleTo(d0) < 1e-4) return;   // kaydırma / yakınlaştırma: yön aynı
            upFixRef.current = null;
            if (cam.up.x !== 0 || cam.up.y !== 1 || cam.up.z !== 0) { cam.up.set(0, 1, 0); c.update(); }
          }}
          onEnd={() => { upFixRef.current = null; }} />
        <RevealShaderWarmup />

        {shapes.map(shape => {
          const isSel = selectedShapeId === shape.id;
          if (shape.type === 'panel') return <PanelDrawing key={shape.id} shape={shape} isSelected={isSel} />;
          return (
            <React.Fragment key={shape.id}>
              <ShapeWithTransform shape={shape} isSelected={isSel} orbitControlsRef={controlsRef} />
              {isSel && vertexEditMode && (
                <VertexEditor shape={shape} onVertexSelect={i => setSelectedVertexIndex(i)} onDirectionChange={d => setVertexDirection(d)} />
              )}
            </React.Fragment>
          );
        })}

        <MoveRefPanelPicker shapes={shapes} />
        <MoveRefConfirmOnRightClick />
        <RotateRefConfirmOnRightClick />
        <ExtrudeRefConfirmOnRightClick />
        <PanelGizmos shapes={shapes} />
        {/* 2B çizim katmanı: çizim düzlemi, nesneler, önizleme, yakalama işareti (DraftView). */}
        <DraftLayer />
        {/* 3B ölçülendirme katmanı: ölçüler, önizleme, yakalama işareti (DraftView › DimLayer). */}
        <DimLayer />

        <mesh position={[0, -1, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <planeGeometry args={[30000, 30000]} />
          <shadowMaterial opacity={0.12} />
        </mesh>

        <GizmoHelper alignment="bottom-right" margin={[125, 155]}>
          <group scale={42}>
            <ViewCube />
          </group>
        </GizmoHelper>
      </Canvas>
    </ErrorBoundary>
  );
};

export default Scene;
