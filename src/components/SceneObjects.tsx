import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Line, TransformControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import {
  type CavityPick, type DoorGroup, type FilletInfo, Tool, ViewMode, type VirtualFace, type XformDelta,
  applyXformDelta, childPanelsOf, shapeById, useAppStore, useStoreFields, vfOfPanel,
} from '../store';
import {
  type CoplanarFaceGroup, type FaceData, type Vec3, applyFillets, convertReplicadToThreeGeometry, createFaceDescriptor, createFaceHighlightGeometry,
  createGroupBoundaryEdges, edgePointsOf, effectiveBodyGeometry, flatGroupOfFace, genId, getFacePlaneAxes, getFacesAndGroups, getShapeMatrix,
  groupIndexOfFace, localBboxOf,
} from './Geometry';
import { REF_COLORS, applyTransformSteps, confirmRefFaceExtrude, cycleRefFacePickFromEvent } from './PanelOps';
import {
  computeFaceComponentContour, computeFreeRegionLocal, earClipTriangulate, findPanelCoveringPoint, panelBehindStackPlane, panelHasRotation,
  panelInnerBigFace, pointInTriangle3D,
} from './FaceRegion';
import {
  GROUP_PANEL_THICKNESS, boxesSurface, collectObstacles, confirmRefCavityExtrude, confirmVolumePick, gridForObstacles, groupBoundsPanelPredicate,
  isInteriorPanel, rayCavityCandidates, repickObstacles,
} from './PanelGroupService';
import {
  type DoorMemberRect, DOOR_GAP, DOOR_THICKNESS, collectDoorCuts, confirmDoorPick, doorCandidatesAt, doorMembersOf, doorPlaneAxes, doorSlabPolygon,
  isDoorPanel, pickRectFor, rayDoorEntry, splitDoorAtPanel,
} from './DoorService';
import { bodyLegsOf, legHeightOf, legSpots } from './QuickBodyService';
import {
  BACK_GAP, BACK_THICKNESS, backCandidatesAt, backPickObstacle, backPreviewStamp, backPickRect, backSlabPolygon, collectBackCuts, confirmBackPick,
  isBackPanel, rayBackEntry, splitBackAtPanel, vfBackBound,
} from './BackService';

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
  const inward = (q: Pt2) => {
    const dx = c.x - q.x, dy = c.y - q.y, l = Math.hypot(dx, dy) || 1;
    return { x: q.x + dx / l * ins * 1.4, y: q.y + dy / l * ins * 1.4 };
  };
  return [inward(pe.a), apex, inward(pe.b)];
}

/** Kapağın ön yüzüne açılış işareti (seçiliyken vurgulu). VF poligonu (eğik kenar dahil) panel geometrisinin ön yüzüne oturtulur —
 *  kapakta taşıma adımı olsa da işaret mesh'le birlikte kalır. */
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
    const to3 = (q: Pt2) => {
      const p = new THREE.Vector3(); p.setComponent(group.axis, plane); p.setComponent(u, q.x + du); p.setComponent(v, q.y + dv); return p;
    };
    const dash = THREE.MathUtils.clamp(span * 0.025, 6, 18);
    return { pts: tri.map(to3), dash };
  }, [geometry, vf, group]);
  if (!mark) return null;
  return (
    <Line points={mark.pts} color={active ? DOOR_SWING.active : DOOR_SWING.idle} lineWidth={active ? DOOR_SWING.activeWidth : DOOR_SWING.idleWidth}
      dashed dashSize={mark.dash} gapSize={mark.dash * 0.8}
      transparent={false} depthTest depthWrite={false} renderOrder={3} raycast={noRaycast} />
  );
});

// Z-FIGHTING: mesh küçük pozitif polygonOffset alır; kenar çizgisi yalnız SABİT birim payı alır, EĞİM (factor) payı ALMAZ —
// eğim payı uzaklaştıkça büyür ve değen arka panellerin kenarı öndeki yüzü delip görünür.
const MESH_OFFSET = 1.0, EDGE_OFFSET_FACTOR = 0, EDGE_OFFSET_UNITS = -1.0, EDGE_RENDER_ORDER = 1;
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
/** Vuruş mesh'inde yüz grubu hover'ı (düz grup). */
const faceHoverEvents = (groups: CoplanarFaceGroup[], onHover: (gi: number | null) => void) => ({
  onPointerMove: (e: any) => { e.stopPropagation(); const gi = flatGroupOfFace(groups, e.faceIndex); if (gi !== -1) onHover(gi); },
  onPointerOut: (e: any) => { e.stopPropagation(); onHover(null); },
});
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

type RefFaceOverlayProps = {
  geometry: THREE.BufferGeometry; faces: any[]; groups: any[]; hoveredGroup: number | null; candidateGroup: number | null;
  onHover: (gi: number | null) => void; onPointerDown?: (e: any) => void; onClick?: (e: any) => void;
};
export function RefFaceOverlay({ geometry, faces, groups, hoveredGroup, candidateGroup, onHover, onPointerDown, onClick }: RefFaceOverlayProps) {
  const hoverGeo = useMemo(() => groupHighlight(faces, groups, hoveredGroup), [hoveredGroup, groups, faces]);
  const candGeo = useMemo(() => groupHighlight(faces, groups, candidateGroup), [candidateGroup, groups, faces]);
  return (
    <>
      <mesh geometry={geometry} renderOrder={10} {...faceHoverEvents(groups, onHover)} onPointerDown={onPointerDown} onClick={onClick} onContextMenu={stopEvent}>
        <HitMaterial />
      </mesh>
      {hoverGeo && <OverlayMesh geometry={hoverGeo} order={11} color={REF_COLORS.hover} opacity={REF_COLORS.hoverOpacity} />}
      {candGeo && <OverlayMesh geometry={candGeo} order={12} color={REF_COLORS.selected} opacity={REF_COLORS.selectedOpacity} />}
    </>
  );
}

export const confirmRefOnRightClick = async (e: any) => {
  if (e.button !== 2) return;
  e.stopPropagation();
  if (useAppStore.getState().faceExtrudeCavityGroupId) await confirmRefCavityExtrude(); else await confirmRefFaceExtrude();
};

/* PANEL GİRİŞ EFEKTİ: panel ilk belirdiğinde dışarıdan gelip yerine oturur (hareket) ya da yerinde, malzemeye enjekte edilen geçici
   shader ile oluşur (≈%45, oluşma). Efekt bileşimden üretilir (yörünge × yön × dönüş × ölçek × yumuşatma × pivot); son 64 imza
   tekrar çekilmez. Yönler panelin durumunu okur (dış normal, dış yan, uzun/kısa kenar). Aynı anda beliren paneller dalga halinde
   gelir. Yalnız sarmalayıcı grubun transformu oynar (t=1'de kimlik); oluşma bitince shader sökülür, gölge geri açılır. */
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
    start: number; ctx: EntryCtx | null; fx: AnyEntryFx | null; done: boolean; mat: THREE.Material | null; u: Record<string, { value: any }> | null; shadow: boolean;
  }>({ start: -1, ctx: null, fx: null, done: false, mat: null, u: null, shadow: true });
  const finishReveal = () => {
    const a = anim.current;
    if (a.mat) { uninstallRevealShader(a.mat); a.mat = null; a.u = null; }
    const mesh = meshRef.current;
    if (mesh) mesh.castShadow = a.shadow;
    const lm = lineRef.current?.material;
    if (lm) { lm.clippingPlanes = null; lm.transparent = false; lm.opacity = 1; lm.needsUpdate = true; }
  };
  useEffect(() => () => { if (anim.current.mat) uninstallRevealShader(anim.current.mat); }, []);
  useFrame(({ clock }) => {
    const a = anim.current, g = ref.current;
    if (a.done || !g || !shape.geometry) return;
    const now = clock.elapsedTime * 1000;
    if (a.start < 0) {
      a.ctx = entryCtxOf(shape);
      if (!a.ctx) { a.done = true; return; }
      a.fx = Math.random() < 0.45 ? buildRevealFx(a.ctx) : buildEntryFx(a.ctx);
      a.start = now + a.fx.delay;
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
    const t = Math.min(1, Math.max(0, (now - a.start) / fx.dur));
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
      g.position.set(0, 0, 0); g.quaternion.identity(); g.scale.setScalar(1);
      if (fx.kind === 'reveal') finishReveal();
    }
  });
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
    'selectedPanelGroupId', 'volumePickMode', 'volumePickGroupId', 'selectedDoorGroupId', 'doorPickMode', 'doorRefPickGroupId', 'setDoorRefPickGroupId',
    'selectedBackGroupId', 'backFocusVfIds', 'backPickMode', 'backRefPickGroupId', 'setBackRefPickGroupId', 'virtualFaces');
  const [hoveredExtrudeGroup, setHoveredExtrudeGroup] = useState<number | null>(null);
  const [moveRefHover, setMoveRefHover] = useState(false);
  const { faces, groups: faceGroups } = useMemo(() => (shape.geometry ? getFacesAndGroups(shape.geometry) : { faces: [], groups: [] }), [shape.geometry]);

  const params = shape.parameters;
  const parentShapeId = params?.parentShapeId;
  const virtualFaceId = params?.virtualFaceId;
  const isParentSelected = parentShapeId === S.selectedShapeId;
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

  const isFaceExtrudeTarget = S.faceExtrudeMode && shape.id === S.faceExtrudeTargetPanelId;
  const isFaceExtrudeXray = S.faceExtrudeMode && shape.id !== S.faceExtrudeTargetPanelId;
  // Yeniden hacim seçimi: sahne grubun adımından ÖNCEKİ duruma döner — sonraki paneller hiç çizilmez
  // (repickObstacles aynı yüklemi okur), grubun kendi üyeleri saydam, öncekiler katı.
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
  const isGhost = isFaceExtrudeXray || isRepickXray || isDoorPickGhost;
  const isPanelRowSelected = isRowSelectedRaw && !isRepickXray;
  const anyPick = S.raycastMode || S.volumePickMode !== null || S.doorPickMode || S.backPickMode;
  const isRaycastOnParent = anyPick && parentShapeId && parentShapeId === S.selectedShapeId;
  // Ref seçimi ancak hedef yüz seçildikten sonra aktif; hedef dışındaki her panel raycast alır.
  const isExtRefMode = S.faceExtrudeMode && S.faceExtrudeValueMode === 'ref' && S.faceExtrudeSelectedFace !== null;
  const isRotRefMode = S.panelRotateMode && S.panelRotateValueMode === 'ref' && !!S.panelRotatePivot && !!S.panelRotateRefArmVertex
    && S.panelRotateAxis !== null;
  const isRefMode = isExtRefMode || isRotRefMode;
  const refOwnerId = isExtRefMode ? S.faceExtrudeTargetPanelId : S.panelRotateTargetPanelId;
  const refCandidate = isExtRefMode ? S.faceExtrudeRefCandidate : S.panelRotateRefFace;
  const isRefPickablePanel = isRefMode && shape.id !== refOwnerId;
  const isRefCandidatePanel = isRefMode && refCandidate?.panelId === shape.id;
  const moveRefSrc = S.panelMoveMode && S.panelMoveValueMode === 'ref' && !!S.panelMoveRefSourceVertex;
  const isMoveRefTargetPanel = moveRefSrc && S.panelMoveRefTargetPanelId === shape.id;
  const isMoveRefPickMode = moveRefSrc && !S.panelMoveRefTargetVertex && shape.id !== S.panelMoveTargetPanelId && S.panelMoveRefTargetPanelId !== shape.id;
  const isMoveRefHovered = isMoveRefPickMode && moveRefHover;
  const moveRefHighlight = isMoveRefTargetPanel || isMoveRefHovered;
  const disableRaycast = (isFaceExtrudeTarget || (isFaceExtrudeXray && !isRefPickablePanel) || isRaycastOnParent
    || (!!S.doorRefPickGroupId && isDoorPanel(shape)) || (!!S.backRefPickGroupId && isBackPanel(shape))) && !isMoveRefPickMode;

  useEffect(() => { const mesh = meshRef.current; if (mesh) mesh.raycast = disableRaycast ? () => {} : THREE.Mesh.prototype.raycast; }, [disableRaycast]);
  useEffect(() => { if (!isMoveRefPickMode && moveRefHover) setMoveRefHover(false); }, [isMoveRefPickMode, moveRefHover]);

  const extrudeHighlightGeometry = useMemo(() => (isFaceExtrudeTarget && hoveredExtrudeGroup !== S.faceExtrudeSelectedFace && faces.length
    ? groupHighlight(faces, faceGroups, hoveredExtrudeGroup) : null), [isFaceExtrudeTarget, hoveredExtrudeGroup, faceGroups, faces, S.faceExtrudeSelectedFace]);
  const extrudeSelectedGeometry = useMemo(() => (isFaceExtrudeTarget && faces.length ? groupHighlight(faces, faceGroups, S.faceExtrudeSelectedFace) : null),
    [isFaceExtrudeTarget, S.faceExtrudeSelectedFace, faceGroups, faces]);

  if (!shape.geometry) return null;
  if (isRepickHidden) return null;

  const isWireframe = S.viewMode === ViewMode.WIREFRAME;
  const isXray = S.viewMode === ViewMode.XRAY;
  const moveRefCss = isMoveRefTargetPanel ? '#15803d' : REF_COLORS.selectedCss;
  const edgeColor = moveRefHighlight ? moveRefCss : isDoorBoundPanel ? DOOR_COLORS.boundEdge : isSelected ? PANEL_COLORS.selected.shapeEdge
    : isPanelRowSelected ? PANEL_SELECT.edge : isGhost ? EXTRUDE_XRAY_EDGE : PANEL_COLORS.edge.default;
  const edgeWidth = moveRefHighlight ? EDGE_LINE_WIDTH + 0.9 : isDoorBoundPanel ? EDGE_LINE_WIDTH + 1.1 : isSelected ? EDGE_LINE_WIDTH + 0.7
    : isPanelRowSelected ? EDGE_LINE_WIDTH + PANEL_SELECT.edgeExtra : EDGE_LINE_WIDTH;
  // Seçim tonu: tarama yok — dolgu harmanlanır; ref/taşıma vurgusu varken o rol önceliklidir.
  const panelColor = isPanelRowSelected && !moveRefHighlight ? tintedPanelColor(shape.color) : (shape.color || '#ffffff');
  // Açılış işareti her kapakta görünür; kapaklar saydamlaştığı modlarda (kapak seçme/ref, X-ray hedef dışı) gizlenir.
  const showSwing = !!virtualFaceId && isDoorPanel(shape) && !isGhost;

  const handleClick = (e: any) => {
    e.stopPropagation();
    if (S.volumePickMode || S.doorPickMode || S.backPickMode) return;   // HACİM / KAPAK / ARKALIK SEÇME: tıklama araca aittir
    if (S.doorRefPickGroupId) {
      if (virtualFaceId) { const ids = splitDoorAtPanel(S.doorRefPickGroupId, virtualFaceId); if (ids.length) S.setDoorRefPickGroupId(null); }
      return;
    }
    if (S.backRefPickGroupId) {
      if (virtualFaceId) { const ids = splitBackAtPanel(S.backRefPickGroupId, virtualFaceId); if (ids.length) S.setBackRefPickGroupId(null); }
      return;
    }
    // Taşıma modu: referans döngüsü canvas seviyesinde (MoveRefPanelPicker).
    if (S.panelMoveMode) return;
    if (S.panelRotateMode && S.panelRotateValueMode === 'ref') {
      if (isRotRefMode && shape.id !== S.panelRotateTargetPanelId) {
        const panels = useAppStore.getState().shapes.filter((x: any) => x.type === 'panel');
        cycleRefFacePickFromEvent(e, panels, S.panelRotateTargetPanelId, S.setPanelRotateRefFace);
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
  const moveRefEmissive = isMoveRefTargetPanel ? '#22c55e' : REF_COLORS.hoverCss;
  const emissive = isPanelRowSelected ? PANEL_SELECT.emissive : moveRefHighlight ? moveRefEmissive : isDoorBoundPanel ? DOOR_COLORS.boundEmissive : '#2a2a2a';
  const emissiveIntensity = isPanelRowSelected ? 1 : moveRefHighlight ? (isMoveRefTargetPanel ? 1.0 : 0.8) : isDoorBoundPanel ? 0.55 : 1;
  const xrayOpacity = moveRefHighlight ? (isMoveRefTargetPanel ? 0.5 : 0.6) : XRAY_PANEL_OPACITY;
  const opacity = isXray ? xrayOpacity : isGhost ? XRAY_PANEL_OPACITY : isMoveRefTargetPanel ? 0.55 : isMoveRefHovered ? 0.9 : 1;
  const edgeLine = (xray: boolean) => edgePoints && (
    <Line ref={edgeRef} points={edgePoints} segments color={edgeColor} lineWidth={edgeWidth} transparent={false} depthTest={!xray} depthWrite={!xray}
      {...(!xray && !isWireframe ? { polygonOffset: true, polygonOffsetFactor: EDGE_OFFSET_FACTOR, polygonOffsetUnits: EDGE_OFFSET_UNITS } : {})}
      renderOrder={EDGE_RENDER_ORDER} raycast={noRaycast} />
  );
  const showArrow = isPanelRowSelected && !isGroupSelected && !S.volumePickMode && !S.doorPickMode && !S.backPickMode;

  return (
    <group name={`shape-${shape.id}`} position={shape.position} rotation={shape.rotation} scale={shape.scale}>
      <group ref={animRef}>
        {!isWireframe && (
          <mesh ref={meshRef} geometry={shape.geometry} castShadow receiveShadow {...meshEvents}>
            <meshLambertMaterial color={panelColor} emissive={emissive} emissiveIntensity={emissiveIntensity} side={THREE.DoubleSide}
              transparent={isXray || isGhost || moveRefHighlight} opacity={opacity} depthWrite={!isXray && !isGhost && !isMoveRefTargetPanel}
              polygonOffset polygonOffsetFactor={MESH_OFFSET} polygonOffsetUnits={MESH_OFFSET} />
          </mesh>
        )}
        {edgeLine(isXray)}
        {showSwing && <DoorSwingMark geometry={shape.geometry} vfId={virtualFaceId} active={isPanelRowSelected} />}

        {isFaceExtrudeTarget && (
          <>
            <mesh geometry={shape.geometry} renderOrder={10} {...faceHoverEvents(faceGroups, setHoveredExtrudeGroup)}
              onPointerDown={(e: any) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                const gi = flatGroupOfFace(faceGroups, e.faceIndex);
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

        {isRefPickablePanel && (
          <RefFaceOverlay geometry={shape.geometry} faces={faces} groups={faceGroups} hoveredGroup={hoveredExtrudeGroup}
            candidateGroup={isRefCandidatePanel ? (refCandidate?.faceGroupIndex ?? null) : null} onHover={setHoveredExtrudeGroup}
            onPointerDown={(e: any) => { if (isExtRefMode) confirmRefOnRightClick(e); }} />
        )}

        {showArrow && (
          <DirectionArrow geometry={shape.geometry} arrowRotated={params?.arrowRotated || false} transformSteps={params?.transformSteps} />
        )}
      </group>
    </group>
  );
});

// Yön oku: panel yüzeyine yatık, ışıksız kırmızı ok; depthTest=false ile hep panelin üstünde.
type DirectionArrowProps = { geometry: THREE.BufferGeometry; arrowRotated?: boolean; transformSteps?: any[] };
const DirectionArrow: React.FC<DirectionArrowProps> = React.memo(({ geometry, arrowRotated = false, transformSteps }) => {
  const arrowConfig = useMemo(() => {
    const posAttr = geometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!posAttr) return null;
    // Ölçüler panel dönüşüyle TERS döndürülmüş çerçevede (panel orada eksen-hizalı slab); ok aynı dönüşle geri getirilir.
    const steps = (Array.isArray(transformSteps) ? transformSteps : []) as any;
    const { rotation: rot } = applyTransformSteps([0, 0, 0], [0, 0, 0], steps);
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
    const basis = new THREE.Matrix4().makeBasis(dirVec, perpVec, new THREE.Vector3().crossVectors(dirVec, perpVec).normalize());
    const quat = new THREE.Quaternion().setFromRotationMatrix(basis).premultiply(Q);
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
    const quaternion = quat.toArray() as [number, number, number, number];
    return { position: position.toArray() as Vec3, quaternion, arrowGeo: new THREE.ShapeGeometry(shape), outline };
  }, [geometry, arrowRotated, transformSteps]);
  useEffect(() => () => { arrowConfig?.arrowGeo?.dispose(); }, [arrowConfig]);
  if (!arrowConfig) return null;
  return (
    <group position={arrowConfig.position} quaternion={arrowConfig.quaternion} renderOrder={11}>
      <mesh geometry={arrowConfig.arrowGeo} renderOrder={11} raycast={noRaycast}>
        <meshBasicMaterial color={PANEL_COLORS.arrow.fill} side={THREE.DoubleSide} depthTest={false} depthWrite={false} transparent opacity={0.95} />
      </mesh>
      <Line points={arrowConfig.outline} color={PANEL_COLORS.arrow.outline} lineWidth={2} transparent={false} depthTest={false} depthWrite={false}
        renderOrder={12} raycast={noRaycast} />
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
  // Gövde paneli varsayılan olarak kapak + arkalık sınırıdır (Goker); satırdaki düğmelerle kapatılabilir.
  // Var olan kapak/arkalık grupları yeni sınırı sonraki rebuild'de devralır (syncDoorGroups / syncBackGroups).
  const bound = { ...vf, doorBound: vf.doorBound ?? true, backBound: vf.backBound ?? true };
  st.addVirtualFace(name ? { ...bound, description: name } : bound);
  st.setRaycastMode(false);
}

interface PendingPreview { geo: THREE.BufferGeometry; edgeGeo: THREE.BufferGeometry; virtualFace: VirtualFace }

/** ÜST ÜSTE PANEL isteği: yüzün `depth` mm içindeki düzlem (altındaki panelin iç yüzü); altındaki panel bölgede yok sayılır. */
export interface StackSpec {
  depth: number; baseVfId: string; basePanelId: string;
  /** Eğimli taban: düzlem = tabanın büyük yüzü (`face` verilmezse boşluğa bakan). */
  onPanel?: any; face?: CoplanarFaceGroup;
}
/** Tıklanan yüz bileşeninin serbest bölgesi (highlight) ve VF'si. HIGHLIGHT = PANEL: bölge tek kaynaktan (computeFreeRegionLocal);
 *  kontur YEREL uzayda, panel ayak izleri dünya→yerel dönüşümle getirilir. */
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
    // EĞİMLİ TABAN: düzlem = tabanın iç büyük yüzü; tık o düzleme normal boyunca izdüşer; VF normali tabana doğru.
    // Verilen yüz ya da boşluğa bakan büyük yüz.
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
  // Yığındaki paneller (düzlemin gerisinde kalanlar) kardeş değil; düzlemi aşan levhalar delen-engel.
  const stackPlane = clickLocal.dot(nrm.clone().multiplyScalar(-1));
  const siblings = stack
    ? childPanels.filter(p => !panelBehindStackPlane(p, nrm, stackPlane)).map(p => ({ ...p, __pierceObstacle: true }))
    : childPanels;
  const region = computeFreeRegionLocal(corners, nrm, clickLocal, siblings, worldToLocal, shapeId);
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
    ...(stack ? { stackDepth: stack.depth, stackBaseVfId: stack.baseVfId, ...(stack.onPanel ? { stackOnPanel: true } : {}) } : {}),
    ...({ regionAnchor: [anchor.x, anchor.y, anchor.z] } as any),
  };
  return { geo, edgeGeo, virtualFace };
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

/* GÖVDE AYAKLARI: silindir ayak + taban diski, gövde-yerel çerçevede (ShapeWithTransform grubunun çocuğu). Yükseklik alt panelin
   alt yüzünden canlı okunur (QuickBodyService.legHeightOf); seçili ayak satırında ayaklar vurgulanır. Tıklanmaz. */
const LEG_COLORS = { body: '#4a4542', top: '#6b6460', selected: '#c2410c' } as const;
export const CabinetLegs: React.FC<{ shape: any }> = ({ shape }) => {
  const { shapes, selectedPanelRow, viewMode } = useStoreFields('shapes', 'selectedPanelRow', 'viewMode');
  const legs = bodyLegsOf(shape);
  const data = useMemo(() => {
    if (!legs) return null;
    const bb = localBboxOf(effectiveBodyGeometry(shape)); if (!bb) return null;
    const h = legHeightOf(shape, legs, shapes);
    if (!(h > 0.5)) return null;
    const W = bb.max.x - bb.min.x, D = bb.max.z - bb.min.z;
    const spots = legSpots(legs, W, D).map(p => ({ x: bb.min.x + p.x, z: bb.min.z + p.z }));
    return { h, y0: bb.min.y, r: Math.max(4, legs.diameter / 2), spots };
  }, [legs, shape, shapes]);
  if (!data || viewMode === ViewMode.WIREFRAME) return null;
  const active = selectedPanelRow === `legs-${shape.id}`;
  const col = active ? LEG_COLORS.selected : LEG_COLORS.body;
  const xray = viewMode === ViewMode.XRAY;
  return (
    <group raycast={noRaycast}>
      {data.spots.map((p, i) => (
        <group key={i} position={[p.x, data.y0, p.z]}>
          <mesh position={[0, data.h / 2, 0]} castShadow receiveShadow raycast={noRaycast}>
            <cylinderGeometry args={[data.r, data.r, data.h, 28]} />
            <meshStandardMaterial color={col} metalness={0.05} roughness={0.85} transparent={xray} opacity={xray ? 0.35 : 1} />
          </mesh>
          <mesh position={[0, 1.5, 0]} raycast={noRaycast}>
            <cylinderGeometry args={[data.r + 6, data.r + 6, 3, 28]} />
            <meshStandardMaterial color={active ? LEG_COLORS.selected : LEG_COLORS.top} metalness={0.05} roughness={0.9}
              transparent={xray} opacity={xray ? 0.35 : 1} />
          </mesh>
        </group>
      ))}
    </group>
  );
};

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

/** Gövde paneli değil: iç panel (raf/dikme), kapak ya da arkalık. */
const isSpecialPanel = (p: any) => isInteriorPanel(p) || isDoorPanel(p) || isBackPanel(p);
type FaceCandidate = { index: number; depth: number; hitPoint: THREE.Vector3; stack?: StackSpec };

export const FaceRaycastOverlay: React.FC<{ shape: any; allShapes?: any[] }> = ({ shape, allShapes = [] }) => {
  const { raycastMode, virtualFaces, setSelectedPanelRow, setRaycastPendingVf } = useStoreFields('raycastMode', 'virtualFaces', 'setSelectedPanelRow',
    'setRaycastPendingVf');
  const [hoveredGroupIndex, setHoveredGroupIndex] = useState<number | null>(null);
  /** Fare bir panelin ÜZERİNDEYKEN (yüz orada panelle örtülü) o panel vurgulanır; tık o yüzün en yakın boşluğunu aday yapar. */
  const [hoverCover, setHoverCover] = useState<{ id: string; geometry: THREE.BufferGeometry } | null>(null);
  const hoverProbeRef = useRef<{ gi: number; point: THREE.Vector3 } | null>(null);
  const [pending, setPending] = useState<PendingPreview | null>(null);
  const lastClickRef = useRef<{ point: THREE.Vector3; groupIndex: number; cycleIndex: number } | null>(null);
  const shapeVirtualFaces = useMemo(() => virtualFaces.filter(vf => vf.shapeId === shape.id), [virtualFaces, shape.id]);
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
  /* PANEL ÜSTÜNDEN YERLEŞTİRME: örtülü vuruşta yüz atlanmaz — o yüzün tıklanan noktaya EN YAKIN boş noktası tohum olur
     (bölge = panelin önündeki/yanındaki boşluk); yüz tamamen doluysa aday olmaz. */
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
    const cover = findPanelCoveringPoint(pt, childPanels, worldNormalOf(gi), pt);
    setHoverCover(prevC => (!cover ? null
      : prevC && prevC.id === cover.id && prevC.geometry === cover.geometry ? prevC : { id: cover.id, geometry: cover.geometry }));
  };
  // Örten panelin ÖNÜNE panel: yalnız o yüzde duran, dönmemiş gövde paneli; derinlik = o noktada üst üste duran TÜM panellerin
  // en içteki yüzü (yeni panel en öndekinin önüne gelir — 3., 4. panel de yerleşebilir). Eğimli taban: düzlem tabanın iç büyük yüzü.
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
  // EĞİMLİ PANELİN KENDİ YÜZLERİ: ışın dönmüş gövde panellerinin iki büyük yüzüyle de kesiştirilir; her vuruş o yüze yaslanan
  // panel adayıdır (derinlik sırasına girer).
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
    const out: FaceCandidate[] = [...rotHits];
    for (let gi = 0; gi < faceGroups.length; gi++) {
      const group = faceGroups[gi];
      const nW = worldNormalOf(gi);
      const denom = nW.dot(rayDir);
      if (Math.abs(denom) < 1e-6) continue;
      const t = group.center.clone().applyMatrix4(localToWorld).sub(cameraPos).dot(nW) / denom;
      if (t < 0) continue;
      const hitOnPlane = cameraPos.clone().addScaledVector(rayDir, t);
      if (!inGroup(group.faceIndices, faces, hitOnPlane, localToWorld)) continue;
      const cover = findPanelCoveringPoint(hitOnPlane, childPanels, nW, hitOnPlane);
      if (!cover) { out.push({ index: gi, depth: t, hitPoint: hitOnPlane }); continue; }
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
    const isSameSpot = lastClickRef.current && lastClickRef.current.point.distanceTo(clickLocal) < 5;
    // Nokta değen bir panelin GÜNCEL ayak izi içindeyse yüz orada "tanımlı"dır; aradaki boşluk serbesttir.
    const coveringPanel = findPanelCoveringPoint(clickPoint, childPanels, worldNormalOf(hoveredGroupIndex), clickPoint);
    const hoveredIsDefined = coveringPanel !== null;
    let targetGroupIndex = hoveredGroupIndex;
    let previewClickPoint = clickPoint;
    let previewStack: StackSpec | undefined;
    const cameraPos = e.camera?.position?.clone();
    const rotHits = cameraPos ? rotatedFaceHits(cameraPos, clickPoint) : [];
    const cycleCandidates = cameraPos && (isSameSpot || hoveredIsDefined || rotHits.length > 0) ? depthCandidates(cameraPos, clickPoint, rotHits) : null;
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
      <mesh geometry={FACING_ARROW_GEO} raycast={noRaycast} renderOrder={30} frustumCulled={false} onBeforeRender={(r: THREE.WebGLRenderer) => r.clearDepth()}>
        <meshBasicMaterial vertexColors transparent opacity={1} depthTest depthWrite polygonOffset polygonOffsetFactor={1} polygonOffsetUnits={1} />
      </mesh>
      <lineSegments geometry={FACING_ARROW_EDGES} raycast={noRaycast} renderOrder={31} frustumCulled={false}>
        <lineBasicMaterial color={FACING_ARROW.edge} transparent opacity={0.9} depthTest depthWrite={false} />
      </lineSegments>
    </group>
  );
};

const boxCenterOf = (b: { min: Vec3; max: Vec3 }): Vec3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];

/** Görünmez seçim kutusu: gövde kutusundan her yönde 1 mm büyük (açık yüzlerde de olayları alır). */
const pickBoxGeometry = (b: { min: Vec3; max: Vec3 }) => {
  const g = new THREE.BoxGeometry(b.max[0] - b.min[0] + 2, b.max[1] - b.min[1] + 2, b.max[2] - b.min[2] + 2);
  g.translate(...boxCenterOf(b));
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
  const selectedMesh = useMemo(() => (selected ? surfaceMesh(selected.surface) : null), [selected]);
  const hoverMesh = useMemo(() => (hoverPick ? surfaceMesh(hoverPick.surface) : null), [hoverPick]);
  useDisposable(selectedMesh?.geo);
  useDisposable(hoverMesh?.geo);

  if (!volumePickMode || !pickGeo) return null;
  const hoverIsSelected = !!hoverPick && !!selected && hoverPick.key === selected.key;
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

// Kapak / arkalık seçme: tıklanan gövde yüzü levha düzlemini verir; adaylar sınır panellerinden büyükten küçüğe.
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
type DoorSlabProps = { poly: DoorSlabPoly; thickness: number; fill: number; opacity: number; edge?: string; order: number };
const DoorSlab: React.FC<DoorSlabProps> = ({ poly, thickness, fill, opacity, edge, order }) => {
  const key = polyKey(poly, thickness);
  const { geo, edges: pts } = useMemo(() => slabPrism(poly, thickness), [key]);
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
  /** Yerel ışın + gövde kutusu → adaylar (alan büyükten küçüğe). */
  candidatesAt: (o: Vec3, d: Vec3, body: BodyBox) => P[];
  confirm: (c: P) => void;
};
/** Kapak ve arkalık seçmenin ortak gövdesi: görünmez kutu olayları alır, her sol tık sıradaki adaya geçer, sağ tık yerleştirir. */
function SlabPickOverlay<P extends { key: string }>({ shape, active, candidates, index, setPick, thickness, slabOf, deps, candidatesAt, confirm }: SlabPickProps<P>) {
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
        <DoorSlab poly={hoverBox} thickness={thickness} fill={PICK_COLORS.hover} opacity={SEL_COLORS.faceHoverOpacity * 0.6} order={5} />
      )}
      {selectedBox && (
        <DoorSlab poly={selectedBox} thickness={thickness} fill={PICK_COLORS.selected} opacity={SEL_COLORS.faceActiveOpacity * 0.7}
          edge={PICK_COLORS.selectedEdge} order={6} />
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
      slabOf={c => doorSlabPolygon(
        { axis: c.axis, side: c.side, placement, thickness: DOOR_THICKNESS, gap: DOOR_GAP, anchor: c.at }, pickRectFor(c, placement), cuts)}
      candidatesAt={(o, d, body) => {
        const entry = rayDoorEntry(o, d, grownBox(body, 1));
        return entry ? doorCandidatesAt(shape, entry.axis, entry.side, entry.point, shapes, virtualFaces) : [];
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
      slabOf={c => backSlabPolygon(
        { axis: c.axis, side: c.side, placement, thickness: BACK_THICKNESS, gap: BACK_GAP, anchor: c.at }, backPickRect(c, placement), cuts)}
      candidatesAt={(o, d, body) => {
        const entry = rayBackEntry(o, d, body);
        return entry ? backCandidatesAt(shape, entry.axis, entry.side, entry.point, shapes, virtualFaces) : [];
      }} />
  );
};

// Hacim düzenleme: grubun şekilli hacmi çizilir; seçilen yüzün normali + tıklama noktası (çıpa) store'a yazılır.
export const CavityEditOverlay: React.FC<{ shape: any }> = ({ shape }) => {
  const S = useStoreFields('panelGroups', 'faceExtrudeCavityGroupId', 'faceExtrudeSelectedFace', 'setFaceExtrudeSelectedFace',
    'setFaceExtrudeCavityFaceNormal', 'setFaceExtrudeClickPoint', 'faceExtrudeValueMode');
  const selFace = S.faceExtrudeSelectedFace;
  const group = S.panelGroups.find(g => g.id === S.faceExtrudeCavityGroupId);
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
  useDisposable(boxGeo);
  const { faces, groups } = useMemo(() => (boxGeo ? getFacesAndGroups(boxGeo) : { faces: [], groups: [] }), [boxGeo]);
  const edgePts = useMemo(() => (boxGeo ? edgePointsOf(boxGeo, 1) : []), [boxGeo]);
  const hoverGeo = useMemo(() => (hovered !== selFace ? groupHighlight(faces, groups, hovered) : null), [hovered, selFace, groups, faces]);
  const selGeo = useMemo(() => groupHighlight(faces, groups, selFace), [selFace, groups, faces]);
  useEffect(() => { if (!active) setHovered(null); }, [active]);
  if (!active || !boxGeo) return null;
  const isRefPhase = S.faceExtrudeValueMode === 'ref' && selFace !== null;
  const onPointerDown = (e: any) => {
    if (e.button === 2) { if (isRefPhase) void confirmRefOnRightClick(e); return; }
    if (e.button !== 0 || isRefPhase) return;   // ref aşamasında tıklama referans seçimine gider (gövde/panel)
    e.stopPropagation();
    const gi = flatGroupOfFace(groups, e.faceIndex);
    if (gi === -1) return;
    const n = groups[gi].normal.clone().normalize();
    S.setFaceExtrudeSelectedFace(gi);
    S.setFaceExtrudeCavityFaceNormal([n.x, n.y, n.z]);
    const lp = localPointOf(e, shape);
    if (lp) S.setFaceExtrudeClickPoint(lp);
    setHovered(gi);
  };
  return (
    <>
      <mesh geometry={boxGeo} raycast={noRaycast} renderOrder={5}><FillMat color={PICK_COLORS.selected} opacity={SEL_COLORS.volumeActiveOpacity} /></mesh>
      {edgePts.length >= 2 && <EdgeLines points={edgePts} color={PICK_COLORS.selectedEdge} width={SEL_COLORS.edgeWidth} order={7} />}
      <mesh geometry={boxGeo} renderOrder={10} onPointerDown={onPointerDown} {...faceHoverEvents(groups, setHovered)} onContextMenu={stopEvent}>
        <HitMaterial />
      </mesh>
      {hoverGeo && <OverlayMesh geometry={hoverGeo} order={11} color={SEL_COLORS.hover} opacity={SEL_COLORS.faceHoverOpacity} />}
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
    'faceExtrudeCavityGroupId', 'doorPickMode', 'backPickMode');
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
  const { faces: refFaces, groups: refFaceGroups } = useMemo(() => (shape.geometry ? getFacesAndGroups(effectiveBodyGeometry(shape)) : { faces: [], groups: [] }),
    [shape.geometry, vertexModsString]);
  const edgePoints = useMemo(() => safeEdgePoints(localGeometry, 5), [localGeometry]);

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
  const isMoveRefPickActive = S.panelMoveMode && S.panelMoveValueMode === 'ref' && !!S.panelMoveRefSourceVertex && !S.panelMoveRefTargetPanelId;
  const isRefMode = S.faceExtrudeMode && S.faceExtrudeValueMode === 'ref' && S.faceExtrudeSelectedFace !== null;
  // Görünmez gövde mesh'i yalnız panel/yüz seçim modlarında bastırılır (ref modları muaf);
  // hacim/kapak/arkalık seçmede her zaman (olayları overlay'in görünmez kutusu alır).
  const isVolumePickOnThis = (S.volumePickMode !== null || S.doorPickMode || S.backPickMode) && isSelected;
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

  const raycastProps = suppressBodyRaycast ? { raycast: noRaycast } : {};
  const hoverProps = isMoveRefPickActive ? {
    onPointerOver: (e: any) => { e.stopPropagation(); setMoveRefHover(true); },
    onPointerOut: () => { if (moveRefHover) setMoveRefHover(false); },
  } : {};
  const outlinesVisible = S.showOutlines || S.raycastMode || !!S.volumePickMode || S.doorPickMode || S.backPickMode;
  const outline = (color: string, width: number, depthWrite: boolean) => outlinesVisible && edgePoints && (
    <Line points={edgePoints} segments color={color} lineWidth={width} transparent={false} depthTest depthWrite={depthWrite} renderOrder={1} raycast={noRaycast} />
  );
  const accented = isSelected || shouldShowAsReference;
  const geoUuid = shape.geometry?.uuid || '';
  const bodyEmissive = moveRefBodyHighlight ? (isMoveRefTargetPanel ? '#22c55e' : REF_COLORS.hoverCss) : '#000000';
  const bodyOpacity = hasPanels ? (moveRefBodyHighlight ? 0.35 : 0) : (moveRefBodyHighlight ? 0.5 : 0.06);

  return (
    <>
      <group ref={groupRef} name={`shape-${shape.id}`}
        onClick={(e) => {
          if (isRefMode) { e.stopPropagation(); handleRefClick(e); return; }
          if (S.panelMoveMode && S.panelMoveValueMode === 'ref' && !!S.panelMoveRefSourceVertex) { e.stopPropagation(); return; }
          // Aktif panel aracı: stopPropagation YOK — arkadaki panelin araç işleyicisi olayı alsın.
          if (S.faceExtrudeMode || S.panelMoveMode || S.panelRotateMode) return;
          if (S.volumePickMode || S.doorPickMode || S.backPickMode) { e.stopPropagation(); return; }
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
          <SubtractionMesh key={`${shape.id}-subtraction-${index}`} subtraction={sub} index={index} isSelected={isSelected}
            isHovered={S.hoveredSubtractionIndex === index && isSelected} isSubtractionSelected={S.selectedSubtractionIndex === index && isSelected}
            setHovered={S.setHoveredSubtractionIndex} setSelected={S.setSelectedSubtractionIndex} />
        ))}

        {!isWireframe && !isXray && !shouldShowAsReference && (
          <>
            <mesh ref={meshRef} geometry={localGeometry} castShadow receiveShadow {...raycastProps} {...hoverProps}>
              <meshStandardMaterial color="#c8c8c8" emissive={bodyEmissive} emissiveIntensity={moveRefBodyHighlight ? 0.9 : 0}
                metalness={0} roughness={1.0} transparent opacity={bodyOpacity}
                side={THREE.DoubleSide} depthWrite={false} flatShading={false} polygonOffset polygonOffsetFactor={4} polygonOffsetUnits={8} />
            </mesh>
            {outline(EDGE_COLOR, isSelected ? EDGE_LINE_WIDTH + 0.5 : EDGE_LINE_WIDTH, false)}
          </>
        )}
        {isWireframe && (
          <>
            <mesh ref={meshRef} geometry={localGeometry} visible={false} {...raycastProps} />
            {outline(isSelected ? '#60a5fa' : shouldShowAsReference ? '#ef4444' : EDGE_COLOR, accented ? EDGE_LINE_WIDTH + 0.75 : EDGE_LINE_WIDTH + 0.25, true)}
          </>
        )}
        {(isXray || shouldShowAsReference) && (
          <>
            <mesh ref={meshRef} geometry={localGeometry} castShadow receiveShadow {...raycastProps}>
              <meshStandardMaterial color={shouldShowAsReference ? '#ef4444' : '#c8c8c8'} emissive="#000000" emissiveIntensity={0} metalness={0} roughness={1.0}
                transparent opacity={hasPanels ? 0 : shouldShowAsReference ? 0.2 : 0.06} side={THREE.DoubleSide} depthWrite={false} flatShading={false} />
            </mesh>
            {outline(isSelected ? '#1e40af' : shouldShowAsReference ? '#991b1b' : EDGE_COLOR, accented ? EDGE_LINE_WIDTH + 0.5 : EDGE_LINE_WIDTH, false)}
          </>
        )}

        {shape.fillets?.length > 0 && S.filletMode && <FilletEdgeLines shape={shape} />}
        {isSelected && S.faceEditMode && <FaceEditor key={`face-editor-${shape.id}-${geoUuid}-${(shape.fillets || []).length}`} shape={shape} />}
        {isSelected && S.raycastMode && <FaceRaycastOverlay key={`raycast-${shape.id}-${geoUuid}`} shape={shape} allShapes={S.shapes} />}
        {isRefMode && (
          <RefFaceOverlay geometry={localGeometry} faces={refFaces} groups={refFaceGroups} hoveredGroup={hoveredRefGroup}
            candidateGroup={isRefCandidateShape ? (S.faceExtrudeRefCandidate?.faceGroupIndex ?? null) : null}
            onHover={setHoveredRefGroup} onPointerDown={confirmRefOnRightClick} onClick={(e: any) => { e.stopPropagation(); handleRefClick(e); }} />
        )}
        {isSelected && S.volumePickMode && <VolumePickOverlay shape={shape} allShapes={S.shapes} />}
        {isSelected && S.doorPickMode && <DoorPickOverlay shape={shape} />}
        {isSelected && S.backPickMode && <BackPickOverlay shape={shape} />}
        {S.faceExtrudeMode && S.faceExtrudeCavityGroupId && <CavityEditOverlay shape={shape} />}
        <VirtualFaceOverlay shape={shape} />
        <CabinetLegs shape={shape} />
      </group>

      {isSelected && S.activeTool !== Tool.SELECT && groupRef.current && !shape.isReferenceBox && !S.panelSelectMode && (
        <TransformControls key={geometryKey} ref={transformRefCallback} object={groupRef.current}
          mode={S.activeTool === Tool.ROTATE ? 'rotate' : S.activeTool === Tool.SCALE ? 'scale' : 'translate'} size={0.8} />
      )}
    </>
  );
});
ShapeWithTransform.displayName = 'ShapeWithTransform';
