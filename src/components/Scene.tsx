import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GizmoHelper, Html, OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { CameraType, type Shape, childPanelsOf, requestRebuild, shapeById, useAppStore, useStoreFields } from '../store';
import {
  type AxisDir, type AxisLetter, type Vec3, axisDirToVec, axisIndexOf, composeVertexTargets, getReplicadVertices, getShapeMatrix, localBboxOf,
  resolveBaseVertices, uniqueMeshPoints,
} from './Geometry';
import { PanelDrawing, ShapeWithTransform, applyFilletToShape } from './SceneObjects';
import { confirmPanelMoveRef, confirmPanelRotateRef, resetRefFacePick } from './PanelOps';
import { ErrorBoundary } from './Ui';

/* Sahne — gizmolar (taşıma/döndürme referans noktaları, halkalar, vertex editörü), ViewCube, kamera denetimi,
   ref-akış onayları ve ana Canvas (gövde/panel listesi, klavye kısayolları). */

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
const eq = (a: Vec3 | null, b: Vec3) => !!a && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const hoverCursor = (on: boolean) => { document.body.style.cursor = on ? 'pointer' : 'default'; };
const worldOf = (v: THREE.Vector3, m: THREE.Matrix4): Vec3 => { const w = v.clone().applyMatrix4(m); return [w.x, w.y, w.z]; };
const noRaycast = () => null;

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

export function GizmoDot({ position, isSelected, accent = '#44403c', onClick, groupRef }: GizmoDotProps) {
  const [hovered, setHovered] = useState(false);
  const g = useRef<THREE.Group | null>(null);
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
      <mesh geometry={DOT_UNIT} scale={2.4} raycast={hitRaycast}
        onClick={e => { e.stopPropagation(); onClick(position); }}
        onPointerOver={e => { e.stopPropagation(); setHovered(true); hoverCursor(true); }}
        onPointerOut={() => { setHovered(false); hoverCursor(false); }}>
        <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />
      </mesh>
    </group>
  );
}

/** Gerçek köşeler (dünya): özellik kenarlarının YÖN DEĞİŞTİRDİĞİ noktalar; düz kenar ortasındaki tesselasyon noktaları köşe sayılmaz. */
export function computeRealCorners(panelShape: Shape): Vec3[] {
  if (!panelShape.geometry) return [];
  const edges = new THREE.EdgesGeometry(panelShape.geometry, 1);
  const ep = edges.getAttribute('position') as THREE.BufferAttribute;
  const k = (x: number, y: number, z: number) => `${Math.round(x * 100)},${Math.round(y * 100)},${Math.round(z * 100)}`;
  const incident = new Map<string, THREE.Vector3[]>();
  const pts = new Map<string, THREE.Vector3>();
  for (let i = 0; i + 1 < ep.count; i += 2) {
    const a = new THREE.Vector3(ep.getX(i), ep.getY(i), ep.getZ(i));
    const b = new THREE.Vector3(ep.getX(i + 1), ep.getY(i + 1), ep.getZ(i + 1));
    if (a.distanceToSquared(b) < 1e-8) continue;
    const ka = k(a.x, a.y, a.z), kb = k(b.x, b.y, b.z);
    const d = b.clone().sub(a).normalize();
    if (!incident.has(ka)) incident.set(ka, []);
    if (!incident.has(kb)) incident.set(kb, []);
    incident.get(ka)!.push(d.clone());
    incident.get(kb)!.push(d.clone().negate());
    pts.set(ka, a); pts.set(kb, b);
  }
  edges.dispose();
  const mat = getShapeMatrix(panelShape);
  const result: Vec3[] = [];
  for (const [key, v] of pts) {
    const dirs = incident.get(key);
    if (!dirs || dirs.length === 0) continue;
    if (dirs.length === 2 && dirs[0].dot(dirs[1]) < -0.999) continue; // düz kenarın ara noktası
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

const AXIS_LABEL: React.CSSProperties = {
  pointerEvents: 'auto', cursor: 'pointer', fontFamily: FONT, padding: '2px 6px', userSelect: 'none', whiteSpace: 'nowrap', textAlign: 'center',
};
type AxisLabelProps = { position: Vec3; text: string; style: React.CSSProperties; onClick: () => void; onHover: (h: boolean) => void };
function AxisLabel({ position, text, style, onClick, onHover }: AxisLabelProps) {
  const hover = (h: boolean) => { onHover(h); hoverCursor(h); };
  return (
    <Html position={position} center zIndexRange={[999, 1000]} style={{ pointerEvents: 'none' }}>
      <div onClick={e => { e.stopPropagation(); onClick(); }} onMouseEnter={() => hover(true)} onMouseLeave={() => hover(false)}
        style={{ ...AXIS_LABEL, ...style }}>
        {text}
      </div>
    </Html>
  );
}

// Ekran-ölçeği kilidi: iki kilit arasında ekranda sabit boy (~TARGET_PX); dışında dünya ölçüsü donar (MIN/MAX_SCALE).
const TARGET_PX = 56, MIN_SCALE = 0.45, MAX_SCALE = 2.20, GAP_RATIO = 0.08;

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
const MOVE_AXES: Array<{ axis: AxisDir; color: string; hover: string }> = [
  { axis: 'x+', color: '#c6635d', hover: '#dd8a84' }, { axis: 'x-', color: '#c6635d', hover: '#dd8a84' },
  { axis: 'y+', color: '#6f9e6c', hover: '#93bd8f' }, { axis: 'y-', color: '#6f9e6c', hover: '#93bd8f' },
  { axis: 'z+', color: '#6485b8', hover: '#8ba6d2' }, { axis: 'z-', color: '#6485b8', hover: '#8ba6d2' },
];

type MoveArrowProps = {
  axisLabel: AxisDir; color: string; hoverColor: string; origin: Vec3; length: number; onSelect: (axis: AxisDir) => void; selectedAxis: string | null;
};
function MoveArrow({ axisLabel, color, hoverColor, origin, length, onSelect, selectedAxis }: MoveArrowProps) {
  const [hovered, setHovered] = useState(false);
  const isSelected = selectedAxis === axisLabel;
  const lit = isSelected || hovered;
  const groupRef = useRef<THREE.Group>(null);
  // Ölçek kilidi grubun KENDİSİNE uygulanır; grup okun tabanına oturduğu için ok her ölçekte panele yapışık kalır.
  useScreenLockedScale(groupRef, length);
  const shaftRadius = length * 0.026, coneRadius = length * 0.078, coneHeight = length * 0.24, shaftLength = length - coneHeight;
  const dir = axisDirToVec(axisLabel);
  const rotation = useMemo(() => {
    const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
    return [e.x, e.y, e.z] as Vec3;
  }, [axisLabel]);
  const along = (d: number): Vec3 => [dir.x * d, dir.y * d, dir.z * d];
  const matProps = {
    color: lit ? hoverColor : color, transparent: true, opacity: lit ? 1 : 0.88, depthTest: false,
    emissive: new THREE.Color(lit ? color : 0x000000), emissiveIntensity: isSelected ? 0.55 : hovered ? 0.35 : 0.06, roughness: 0.62, metalness: 0.04,
  };
  return (
    <group ref={groupRef} position={origin}>
      <mesh position={along(shaftLength / 2)} rotation={rotation} renderOrder={RENDER_ORDER}>
        <cylinderGeometry args={[shaftRadius, shaftRadius, shaftLength, 24]} />
        <meshStandardMaterial {...matProps} />
      </mesh>
      <mesh position={along(shaftLength + coneHeight / 2)} rotation={rotation} renderOrder={RENDER_ORDER}>
        <coneGeometry args={[coneRadius, coneHeight, 32]} />
        <meshStandardMaterial {...matProps} />
      </mesh>
      <AxisLabel position={along(length * 1.2)} text={AXIS_DISPLAY[axisLabel]} onClick={() => onSelect(axisLabel)} onHover={setHovered}
        style={{
          background: isSelected ? color : 'rgba(252,251,249,0.82)', color: isSelected ? '#fff' : '#57534e', fontSize: '11px', fontWeight: 650,
          letterSpacing: '0.04em', borderRadius: '5px', border: `1px solid ${isSelected ? 'transparent' : 'rgba(60,50,40,0.10)'}`,
          boxShadow: isSelected ? '0 1px 3px rgba(40,30,20,0.22)' : '0 1px 2px rgba(40,30,20,0.08)',
          backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)', lineHeight: '1.35', minWidth: '24px', transition: 'background 0.12s, color 0.12s',
        }} />
    </group>
  );
}

function OriginSphere({ position, size, baseLength }: { position: Vec3; size: number; baseLength: number }) {
  const ref = useRef<THREE.Mesh>(null);
  useScreenLockedScale(ref, baseLength);   // oklarla AYNI tabandan kilitlenir
  return (
    <mesh ref={ref} position={position} renderOrder={RENDER_ORDER}>
      <sphereGeometry args={[size, 28, 20]} />
      <meshStandardMaterial color="#efece7" emissive={new THREE.Color('#b9b3aa')} emissiveIntensity={0.28} transparent opacity={0.9}
        depthTest={false} roughness={0.7} metalness={0.02} />
    </mesh>
  );
}

export function PanelMoveGizmo({ panelShape }: { panelShape: Shape }) {
  const s = useStoreFields('panelMoveAxis', 'setPanelMoveAxis', 'panelMoveValueMode', 'panelMoveRefSourceVertex', 'setPanelMoveRefSourceVertex',
    'panelMoveRefTargetPanelId', 'setPanelMoveRefTargetPanelId', 'panelMoveRefTargetVertex', 'setPanelMoveRefTargetVertex', 'shapes');
  const { panelMoveRefSourceVertex: srcVertex, panelMoveRefTargetPanelId: targetId, panelMoveRefTargetVertex: tgtVertex, shapes } = s;
  const isRefMode = s.panelMoveValueMode === 'ref';
  const freshPanel = useMemo(() => shapeById(panelShape.id, shapes) || panelShape, [shapes, panelShape.id, panelShape]);
  const { centerOrigin, axisOrigins, arrowLength } = useMemo(() => {
    const bbox = localBboxOf(freshPanel.geometry);
    if (!bbox) {
      const o = freshPanel.position;
      return { centerOrigin: o, axisOrigins: Object.fromEntries(MOVE_AXES.map(a => [a.axis, o])) as Record<string, Vec3>, arrowLength: 40 };
    }
    const mat = getShapeMatrix(freshPanel);
    const toWorld = (lx: number, ly: number, lz: number) => worldOf(new THREE.Vector3(lx, ly, lz), mat);
    const mn = bbox.min, mx = bbox.max, c = bbox.getCenter(new THREE.Vector3());
    const size = bbox.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const gap = maxDim * GAP_RATIO;
    const gapped = (lx: number, ly: number, lz: number, d: Vec3): Vec3 => {
      const w = toWorld(lx, ly, lz); return [w[0] + d[0] * gap, w[1] + d[1] * gap, w[2] + d[2] * gap];
    };
    return {
      centerOrigin: toWorld(c.x, c.y, c.z),
      axisOrigins: {
        'x+': gapped(mx.x, c.y, c.z, [1, 0, 0]), 'x-': gapped(mn.x, c.y, c.z, [-1, 0, 0]),
        'y+': gapped(c.x, mx.y, c.z, [0, 1, 0]), 'y-': gapped(c.x, mn.y, c.z, [0, -1, 0]),
        'z+': gapped(c.x, c.y, mx.z, [0, 0, 1]), 'z-': gapped(c.x, c.y, mn.z, [0, 0, -1]),
      } as Record<string, Vec3>,
      arrowLength: maxDim * 0.2,
    };
  }, [freshPanel.position, freshPanel.rotation, freshPanel.scale, freshPanel.geometry]);
  const sourceVertices = useMemo(() => (isRefMode && freshPanel.geometry ? computeRealCorners(freshPanel) : []), [isRefMode, freshPanel]);
  const targetPanel = useMemo(() => (isRefMode && targetId ? shapeById(targetId, shapes) || null : null), [isRefMode, targetId, shapes]);
  const targetVertices = useMemo(() => (targetPanel?.geometry ? computeRealCorners(targetPanel) : []), [targetPanel]);
  const allMarks = useMemo(() => [...sourceVertices.map(v => ({ pos: v, group: 0 })), ...targetVertices.map(v => ({ pos: v, group: 1 }))],
    [sourceVertices, targetVertices]);
  const refAt = useDotOverlap(allMarks, i => vertEq(allMarks[i].group ? tgtVertex : srcVertex, allMarks[i].pos));
  const needsTargetPanel = !!srcVertex && !targetId;
  const pickSource = (pos: Vec3) => { s.setPanelMoveRefSourceVertex(pos); s.setPanelMoveRefTargetPanelId(null); s.setPanelMoveRefTargetVertex(null); };
  return (
    <group>
      {!isRefMode && (
        <>
          <OriginSphere position={centerOrigin} size={arrowLength * 0.055} baseLength={arrowLength} />
          {MOVE_AXES.map(({ axis, color, hover }) => (
            <MoveArrow key={axis} axisLabel={axis} color={color} hoverColor={hover} origin={axisOrigins[axis]} length={arrowLength}
              onSelect={a => s.setPanelMoveAxis(a === s.panelMoveAxis ? null : a)} selectedAxis={s.panelMoveAxis} />
          ))}
        </>
      )}
      {isRefMode && !needsTargetPanel && sourceVertices.map((v, i) => (
        <GizmoDot key={`src-${i}`} position={v} isSelected={vertEq(srcVertex, v)} groupRef={refAt(i)} onClick={pickSource} />
      ))}
      {isRefMode && targetId && targetVertices.map((v, i) => (
        <GizmoDot key={`tgt-${i}`} position={v} isSelected={vertEq(tgtVertex, v)} accent="#ea580c" onClick={s.setPanelMoveRefTargetVertex}
          groupRef={refAt(sourceVertices.length + i)} />
      ))}
    </group>
  );
}

type RotationRingProps = { center: Vec3; axis: AxisLetter; radius: number; onSelect: (axis: AxisLetter) => void; selectedAxis: AxisLetter | null };
function RotationRing({ center, axis, radius, onSelect, selectedAxis }: RotationRingProps) {
  const [hovered, setHovered] = useState(false);
  const isSelected = selectedAxis === axis;
  const anySelected = selectedAxis !== null;
  const colors = AXIS_RGB[axis];
  const { geometry, eulerRotation, labelPos } = useMemo(() => {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= 64; i++) { const a = (i / 64) * Math.PI * 2; points.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0)); }
    const euler = axis === 'x' ? new THREE.Euler(0, Math.PI / 2, 0) : axis === 'y' ? new THREE.Euler(Math.PI / 2, 0, 0) : new THREE.Euler(0, 0, 0);
    const lPos: Vec3 = axis === 'x' ? [center[0], center[1], center[2] + radius + 10]
      : axis === 'y' ? [center[0] + radius + 10, center[1], center[2]] : [center[0], center[1] + radius + 10, center[2]];
    return { geometry: new THREE.BufferGeometry().setFromPoints(points), eulerRotation: euler, labelPos: lPos };
  }, [center, axis, radius]);
  const lineColor = hovered && !isSelected ? colors.hover : colors.main;
  const lineOpacity = isSelected ? 1 : hovered ? 0.95 : anySelected ? 0.16 : 0.62;
  const lineObj = useMemo(() => {
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: lineColor, transparent: true, opacity: lineOpacity, depthTest: false }));
    line.position.set(center[0], center[1], center[2]);
    line.rotation.copy(eulerRotation);
    line.renderOrder = RENDER_ORDER;
    return line;
  }, [geometry, lineColor, lineOpacity, center, eulerRotation]);
  const labelDimmed = anySelected && !isSelected && !hovered;
  return (
    <group>
      {isSelected && (
        <mesh position={center} rotation={[eulerRotation.x, eulerRotation.y, eulerRotation.z]} renderOrder={RENDER_ORDER - 1}>
          <circleGeometry args={[radius, 64]} />
          <meshBasicMaterial color={colors.main} transparent opacity={0.15} depthTest={false} side={THREE.DoubleSide} />
        </mesh>
      )}
      <primitive object={lineObj} />
      <AxisLabel position={labelPos} text={axis.toUpperCase()} onClick={() => onSelect(axis)} onHover={setHovered}
        style={{
          background: isSelected ? colors.main : 'transparent', color: isSelected ? '#fff' : '#000', fontSize: '12px', fontWeight: 900,
          letterSpacing: '0.06em', borderRadius: '4px', boxShadow: isSelected ? '0 1px 6px rgba(0,0,0,0.28)' : 'none',
          textShadow: isSelected ? 'none' : '0 0 4px #fff, 0 0 8px #fff',
          opacity: labelDimmed ? 0.4 : 1, transition: 'opacity 0.12s ease', lineHeight: '1.4', minWidth: '22px',
        }} />
    </group>
  );
}

function computeFaceCenters(panelShape: Shape): Vec3[] {
  if (!panelShape.geometry) return [];
  const corners = uniqueMeshPoints(panelShape.geometry, 100);
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

export function PanelRotateGizmo({ panelShape }: { panelShape: Shape }) {
  const s = useStoreFields('panelRotatePivot', 'setPanelRotatePivot', 'panelRotateAxis', 'setPanelRotateAxis', 'panelRotateValueMode',
    'panelRotateRefArmVertex', 'setPanelRotateRefArmVertex', 'setPanelRotateRefFace');
  const { panelRotatePivot: pivot, panelRotateRefArmVertex: arm } = s;
  const { setPanelRotatePivot, setPanelRotateAxis, setPanelRotateRefArmVertex, setPanelRotateRefFace } = s;
  const modeChosen = s.panelRotateValueMode !== null;
  const isRefMode = s.panelRotateValueMode === 'ref';
  const hasPivot = pivot !== null;
  const showRings = modeChosen && hasPivot && (!isRefMode || arm !== null);
  const pivots = useMemo<Array<{ pos: Vec3; kind: PivotKind }>>(() => [
    ...computeRealCorners(panelShape).map(p => ({ pos: p, kind: 'vertex' as const })),
    ...computeFaceCenters(panelShape).map(p => ({ pos: p, kind: 'center' as const })),
  ], [panelShape.position, panelShape.rotation, panelShape.scale, panelShape.geometry]);
  const ringRadius = useMemo(() => {
    const bb = localBboxOf(panelShape.geometry);
    if (!bb) return 40;
    const sz = bb.getSize(new THREE.Vector3());
    return Math.max(sz.x, sz.y, sz.z) * 0.35;
  }, [panelShape.geometry]);
  const refAt = useDotOverlap(useMemo(() => pivots.map(pv => ({ pos: pv.pos, group: 0 })), [pivots]),
    i => eq(pivot, pivots[i].pos) || vertEq(arm, pivots[i].pos));

  // dyn: her tıklama pivotu yeniden belirler. ref: 1. tık pivot, 2. tık NİŞAN; seçili pivota tekrar tık akışı sıfırlar.
  const resetAfterPivot = () => { setPanelRotateAxis(null); setPanelRotateRefArmVertex(null); setPanelRotateRefFace(null); };
  const handleOwnDotClick = (point: Vec3) => {
    if (!isRefMode) { setPanelRotatePivot(point); setPanelRotateAxis(null); return; }
    if (!hasPivot) { setPanelRotatePivot(point); resetAfterPivot(); return; }
    if (eq(pivot, point)) { setPanelRotatePivot(null); resetAfterPivot(); return; }
    setPanelRotateRefArmVertex(point); setPanelRotateAxis(null); setPanelRotateRefFace(null);
  };
  const handleAxisSelect = (axis: AxisLetter) => {
    setPanelRotateAxis(axis === s.panelRotateAxis ? null : axis);
    if (isRefMode) setPanelRotateRefFace(null);   // eksen değişti → referans seçimi baştan
  };
  if (!modeChosen) return null;
  return (
    <group>
      {pivots.map((pv, i) => {
        const isArm = isRefMode && vertEq(arm, pv.pos);
        return <GizmoDot key={`pivot-${i}`} position={pv.pos} groupRef={refAt(i)} onClick={() => handleOwnDotClick(pv.pos)}
          isSelected={eq(pivot, pv.pos) || isArm} accent={isArm ? '#0d9488' : pv.kind === 'center' ? '#ea580c' : '#44403c'} />;
      })}
      {showRings && (['x', 'y', 'z'] as AxisLetter[]).map(a => (
        <RotationRing key={a} center={pivot!} axis={a} radius={ringRadius} onSelect={handleAxisSelect} selectedAxis={s.panelRotateAxis} />
      ))}
    </group>
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
const C_OUTLINE  = 'rgba(140,135,128,0.65)';
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

// ViewCube: snap window.__snapView ile CameraController'a devredilir — gerçek up vektörü ANA kameraya uygulanır
// (drei tweenCamera up argümanını yok sayar; üst/ön görünüşler eğri kalıyordu).
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

const CameraController: React.FC<{ controlsRef: React.RefObject<any>; cameraType: CameraType }> = ({ controlsRef, cameraType }) => {
  const cameraRef = useRef<THREE.PerspectiveCamera | THREE.OrthographicCamera>(null);
  const savedRef  = useRef<{ position: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3 } | null>(null);
  const prevType  = useRef<CameraType>(cameraType);
  const { size }  = useThree();  // canvas boyutu (CSS px, pencere değil)

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
    };
    tick();
  }, [controlsRef]);

  useEffect(() => {
    (window as any).__snapView = snapToView;
    return () => { delete (window as any).__snapView; };
  }, [snapToView]);

  // Orto ↔ perspektif: kamera kıpırdamaz, FOV sabit; yalnız projeksiyon değişir — pan/taşıma sonrası görünüm uçmaz.
  useLayoutEffect(() => {
    if (prevType.current === cameraType) return;
    const saved = savedRef.current;
    const cam = cameraRef.current;
    const controls = controlsRef.current;
    if (!saved || !cam || !controls) { prevType.current = cameraType; return; }
    const target = saved.target.clone();
    const dist   = saved.position.distanceTo(target) || 1;
    controls.target.copy(target);
    cam.position.copy(saved.position);  // yerinde kal — dolly yok
    cam.up.copy(saved.up);
    if (cameraType === CameraType.ORTHOGRAPHIC && cam instanceof THREE.OrthographicCamera) {
      cam.zoom = orthoZoomFor(dist, size.height || window.innerHeight);
      cam.updateProjectionMatrix();
    } else if (cameraType === CameraType.PERSPECTIVE && cam instanceof THREE.PerspectiveCamera) {
      cam.fov = PERSP_FOV;
      cam.updateProjectionMatrix();
    }
    cam.lookAt(target);
    controls.update();
    prevType.current = cameraType;
  }, [cameraType, controlsRef, size.height]);

  useEffect(() => {
    const id = setInterval(() => {
      const cam = cameraRef.current, controls = controlsRef.current;
      if (!cam || !controls) return;
      savedRef.current = { position: cam.position.clone(), target: controls.target.clone(), up: cam.up.clone() };
    }, 100);
    return () => clearInterval(id);
  }, [controlsRef]);

  // DİNAMİK NEAR: sabit near'da derinlik çözünürlüğü uzaklığın karesiyle kötüleşir; ~10 m'de polygonOffset panel kalınlığını
  // aşar, değen panelin kenarı öndeki yüzü deler. near = uzaklık/100 (≥1). Ortografik etkilenmez.
  useFrame(() => {
    const cam = cameraRef.current, controls = controlsRef.current;
    if (!(cam instanceof THREE.PerspectiveCamera) || !controls) return;
    const near = Math.max(1, cam.position.distanceTo(controls.target) / 100);
    if (Math.abs(near - cam.near) / cam.near > 0.05) { cam.near = near; cam.updateProjectionMatrix(); }
  });

  // Mount prop'ları YALNIZ kamera tipi değişince (gerçek remount) hesaplanır; aksi halde R3F etkileşim ortasında yeniden
  // uygular ve kamera OrbitControls'tan kopar.
  const mount = useMemo(() => {
    const s = savedRef.current;
    if (!s) return { position: [2000, 2000, 2000] as [number, number, number], zoom: 0.25 };
    const dist = s.position.distanceTo(s.target) || 1;
    return { position: s.position.toArray() as [number, number, number], zoom: orthoZoomFor(dist, size.height || window.innerHeight) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraType]);

  return cameraType === CameraType.PERSPECTIVE
    ? <PerspectiveCamera ref={cameraRef as React.RefObject<THREE.PerspectiveCamera>} makeDefault position={mount.position} fov={PERSP_FOV}
      near={1} far={50000} />
    : <OrthographicCamera ref={cameraRef as React.RefObject<THREE.OrthographicCamera>} makeDefault position={mount.position} zoom={mount.zoom}
      near={-50000} far={50000} />;
};

// Taşıma-ref hedef panel seçici: R3F raycast'ini bilerek atlar; canvas tıklamasında tüm panelleri tarar, aynı noktada derinlik döngüsü.
const SAME_SPOT_PX = 8;
let _movePickState: { x: number; y: number; idx: number } | null = null;

function MoveRefPanelPicker({ shapes }: { shapes: any[] }) {
  const { camera, gl } = useThree();
  const { panelMoveMode, panelMoveValueMode, panelMoveRefSourceVertex, panelMoveRefTargetVertex, panelMoveTargetPanelId,
    setPanelMoveRefTargetPanelId, setPanelMoveRefTargetVertex } = useStoreFields('panelMoveMode', 'panelMoveValueMode', 'panelMoveRefSourceVertex',
    'panelMoveRefTargetVertex', 'panelMoveTargetPanelId', 'setPanelMoveRefTargetPanelId', 'setPanelMoveRefTargetVertex');
  // Kaynak seçildikten sonra hedef NOKTA seçilene kadar aktif: üst üste panellerde her sol tıkta bir arkadakine geçilir.
  const active = panelMoveMode && panelMoveValueMode === 'ref' && !!panelMoveRefSourceVertex && !panelMoveRefTargetVertex;

  useEffect(() => {
    if (!active) return;
    const canvas = gl.domElement;
    const handler = (ev: MouseEvent) => {
      if (ev.button !== 0) return;
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
      const sameSpot = !!_movePickState && Math.hypot(ev.clientX - _movePickState.x, ev.clientY - _movePickState.y) < SAME_SPOT_PX;
      const idx = sameSpot ? (_movePickState!.idx + 1) % ordered.length : 0;
      _movePickState = { x: ev.clientX, y: ev.clientY, idx };
      setPanelMoveRefTargetPanelId(ordered[idx]);
      setPanelMoveRefTargetVertex(null);
    };
    canvas.addEventListener('click', handler, true);
    return () => { canvas.removeEventListener('click', handler, true); _movePickState = null; };
  }, [active, shapes, camera, gl, panelMoveTargetPanelId, setPanelMoveRefTargetPanelId, setPanelMoveRefTargetVertex]);

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
      await confirmPanelMoveRef();
      const st = useAppStore.getState();
      st.setPanelMoveMode(false);
      st.setSelectedPanelRow(null);
      _movePickState = null;
    }} />;
}

const rotateRefReady = () => {
  const st = useAppStore.getState();
  return st.panelRotateMode && st.panelRotateValueMode === 'ref' && !!st.panelRotatePivot && !!st.panelRotateRefArmVertex && st.panelRotateAxis !== null
    && !!st.panelRotateRefFace && !!shapeById(st.panelRotateTargetPanelId, st.shapes);
};
/** Ref-dönüş: referans bir YÜZ (seçim PanelDrawing'de, extrude-ref ile aynı döngü); burada yalnız onay. */
function RotateRefConfirmOnRightClick() {
  const { panelRotateMode, panelRotateValueMode, panelRotatePivot } = useStoreFields('panelRotateMode', 'panelRotateValueMode', 'panelRotatePivot');
  return <RefConfirmOnRightClick active={panelRotateMode && panelRotateValueMode === 'ref' && !!panelRotatePivot} ready={rotateRefReady}
    confirm={async () => {
      await confirmPanelRotateRef();
      const st = useAppStore.getState();
      st.setPanelRotateMode(false);
      st.setSelectedPanelRow(null);
      resetRefFacePick();
    }} />;
}

function PanelGizmos({ shapes }: { shapes: any[] }) {
  const s = useStoreFields('panelMoveMode', 'panelMoveTargetPanelId', 'panelRotateMode', 'panelRotateTargetPanelId');
  const panelOf = (on: boolean, id: string | null) => { const p = on && id ? shapeById(id, shapes) : undefined; return p && p.type === 'panel' ? p : null; };
  const mv = panelOf(s.panelMoveMode, s.panelMoveTargetPanelId), rt = panelOf(s.panelRotateMode, s.panelRotateTargetPanelId);
  return <>{mv && <PanelMoveGizmo panelShape={mv} />}{rt && <PanelRotateGizmo panelShape={rt} />}</>;
}

const GL_OPTS = { antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' } as const;

const Scene: React.FC = () => {
  const controlsRef = useRef<any>(null);
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
      if (e.key === 'Delete' && selectedShapeId) deleteShape(selectedShapeId);
      else if (e.key === 'Escape') {
        // Aktif araç/mod varsa Escape yalnız onu kapatır (şeridin ✕'i gibi); seçim korunur.
        const st = useAppStore.getState();
        if (st.volumePickMode) { st.setVolumePickMode(null); return; }
        if (st.doorPickMode) { st.setDoorPickMode(false); return; }
        if (st.backPickMode) { st.setBackPickMode(false); return; }
        if (st.faceExtrudeMode || st.panelMoveMode || st.panelRotateMode) {
          if (st.faceExtrudeMode) { st.setFaceExtrudeSelectedFace(null); st.setFaceExtrudeRefCandidate(null); st.setFaceExtrudeMode(false); }
          if (st.panelMoveMode) { st.setPanelMoveAxis(null); st.setPanelMoveMode(false); }
          if (st.panelRotateMode) { st.setPanelRotateAxis(null); st.setPanelRotatePivot(null); st.setPanelRotateMode(false); }
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

        {/* Turntable: OrbitControls yörünge eksenini camera.up'tan alır; üst/alt görünüş up'ı (0,0,∓1) yaptığından
            döndürme başlarken up dünya-Y'ye alınır — zemin hep yatay (kutupta olunduğundan sıçrama görünmez). */}
        <OrbitControls ref={controlsRef} makeDefault target={[0, 0, 0]} enableDamping dampingFactor={0.2} rotateSpeed={0.8} maxDistance={25000} minDistance={50}
          onStart={() => {
            const c: any = controlsRef.current;
            const cam: any = c?.object;
            if (!cam?.up) return;
            if (cam.up.x !== 0 || cam.up.y !== 1 || cam.up.z !== 0) { cam.up.set(0, 1, 0); c.update(); }
          }} />

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
        <PanelGizmos shapes={shapes} />

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
