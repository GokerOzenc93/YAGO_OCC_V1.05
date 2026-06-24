import { useState, useMemo } from 'react';
import * as THREE from 'three';
import { Html, Line } from '@react-three/drei';
import { useAppStore } from '../store';
import type { Shape } from '../store';
import { getPanelVertices, getPanelCenter } from './PanelRotateService';

const RENDER_ORDER = 999;
const PIVOT_SIZE = 3;

// ── Pivot point (center + vertices) ───────────────────────────────────────
interface PivotPointProps {
  position: [number, number, number];
  isCenter?: boolean;
  onSelect: () => void;
  isSelected: boolean;
}

function PivotPoint({ position, isCenter, onSelect, isSelected }: PivotPointProps) {
  const [hovered, setHovered] = useState(false);
  const color = isSelected ? '#f59e0b' : isCenter ? '#8b5cf6' : '#06b6d4';
  const hoverColor = isSelected ? '#fbbf24' : isCenter ? '#a78bfa' : '#22d3ee';
  const baseSize = isCenter ? PIVOT_SIZE * 1.4 : PIVOT_SIZE;
  const size = (hovered || isSelected) ? baseSize * 1.35 : baseSize;

  return (
    <group>
      <mesh position={position} renderOrder={RENDER_ORDER}>
        <sphereGeometry args={[size, 20, 20]} />
        <meshStandardMaterial
          color={hovered ? hoverColor : color}
          emissive={new THREE.Color(hovered ? hoverColor : color)}
          emissiveIntensity={isSelected ? 1.1 : hovered ? 0.7 : 0.35}
          transparent
          opacity={0.96}
          depthTest={false}
          roughness={0.25}
          metalness={0.4}
        />
      </mesh>
      {isCenter && (
        <mesh position={position} renderOrder={RENDER_ORDER}>
          <ringGeometry args={[size * 1.5, size * 1.7, 24]} />
          <meshBasicMaterial
            color={hovered ? hoverColor : color}
            transparent
            opacity={isSelected ? 0.9 : 0.5}
            depthTest={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
      <Html position={position} center zIndexRange={[999, 1000]} style={{ pointerEvents: 'none' }}>
        <div
          onClick={e => { e.stopPropagation(); onSelect(); }}
          onMouseEnter={() => { setHovered(true); document.body.style.cursor = 'pointer'; }}
          onMouseLeave={() => { setHovered(false); document.body.style.cursor = 'default'; }}
          style={{ pointerEvents: 'auto', cursor: 'pointer', width: 18, height: 18, borderRadius: '50%' }}
        />
      </Html>
    </group>
  );
}

// ── Rotation ring ─────────────────────────────────────────────────────────
interface RotationRingProps {
  center: [number, number, number];
  axis: 'x' | 'y' | 'z';
  radius: number;
  onSelect: (axis: 'x' | 'y' | 'z') => void;
  selectedAxis: 'x' | 'y' | 'z' | null;
  hoveredAxis: 'x' | 'y' | 'z' | null;
  setHoveredAxis: (a: 'x' | 'y' | 'z' | null) => void;
}

const AXIS_COLORS: Record<string, { main: string; hover: string }> = {
  x: { main: '#ef4444', hover: '#f87171' },
  y: { main: '#22c55e', hover: '#4ade80' },
  z: { main: '#3b82f6', hover: '#60a5fa' },
};

const AXIS_LABELS: Record<string, string> = { x: 'X', y: 'Y', z: 'Z' };

// Arrow points along the world axis (== the axis applyRotateSteps rotates
// around). The ring is the plane PERPENDICULAR to that axis — i.e. the exact
// plane the panel moves in when rotating around it. Ring == real rotation.
const AXIS_DIR: Record<string, [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

// Euler that orients a default-XY disc/torus so its normal == the axis,
// matching the rotation plane exactly.
// X ring → YZ plane (normal X), Y ring → XZ plane (normal Y), Z ring → XY plane (normal Z).
const PLANE_ROTATION: Record<string, [number, number, number]> = {
  x: [0, Math.PI / 2, 0],
  y: [Math.PI / 2, 0, 0],
  z: [0, 0, 0],
};

function makeRingPoints(
  center: [number, number, number],
  axis: 'x' | 'y' | 'z',
  radius: number,
  segments = 72
): [number, number, number][] {
  const [cx, cy, cz] = center;
  const pts: [number, number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const c = Math.cos(a) * radius;
    const s = Math.sin(a) * radius;
    if (axis === 'x') pts.push([cx, cy + c, cz + s]);       // YZ plane — rotation around X
    else if (axis === 'y') pts.push([cx + c, cy, cz + s]);  // XZ plane — rotation around Y
    else pts.push([cx + c, cy + s, cz]);                    // XY plane — rotation around Z
  }
  return pts;
}

function RotationRing({ center, axis, radius, onSelect, selectedAxis, hoveredAxis, setHoveredAxis }: RotationRingProps) {
  const colors = AXIS_COLORS[axis];

  const activeAxis = selectedAxis ?? hoveredAxis;
  const isActive = activeAxis === axis;
  const isDimmed = activeAxis !== null && activeAxis !== axis;
  const isSelected = selectedAxis === axis;

  const { points, axlePoints, labelPos } = useMemo(() => {
    const pts = makeRingPoints(center, axis, radius);
    const dir = AXIS_DIR[axis];
    const axleEnd = radius * 1.18;
    const labelR = radius * 1.32;
    const tip: [number, number, number] = [
      center[0] + dir[0] * axleEnd, center[1] + dir[1] * axleEnd, center[2] + dir[2] * axleEnd,
    ];
    const lPos: [number, number, number] = [
      center[0] + dir[0] * labelR, center[1] + dir[1] * labelR, center[2] + dir[2] * labelR,
    ];
    return { points: pts, axlePoints: [center, tip] as [number, number, number][], labelPos: lPos };
  }, [center, axis, radius]);

  const ringWidth = isActive ? 3.5 : isDimmed ? 1.25 : 1.9;
  const ringOpacity = isActive ? 1 : isDimmed ? 0.14 : 0.55;
  const axleWidth = isActive ? 2.5 : 1.5;
  const axleOpacity = isActive ? 0.95 : isDimmed ? 0.18 : 0.6;

  const enter = () => { setHoveredAxis(axis); document.body.style.cursor = 'pointer'; };
  const leave = () => { setHoveredAxis(null); document.body.style.cursor = 'default'; };

  return (
    <group>
      {/* Invisible grab torus — whole ring hoverable / clickable */}
      <mesh
        position={center}
        rotation={PLANE_ROTATION[axis]}
        renderOrder={RENDER_ORDER}
        onPointerOver={e => { e.stopPropagation(); enter(); }}
        onPointerOut={e => { e.stopPropagation(); leave(); }}
        onClick={e => { e.stopPropagation(); onSelect(axis); }}
      >
        <torusGeometry args={[radius, radius * 0.09, 8, 64]} />
        <meshBasicMaterial transparent opacity={0} depthTest={false} />
      </mesh>

      {/* Rotation-plane disc — the exact plane the panel rotates in (focused only) */}
      {isActive && (
        <mesh position={center} rotation={PLANE_ROTATION[axis]} renderOrder={RENDER_ORDER - 1}>
          <circleGeometry args={[radius, 48]} />
          <meshBasicMaterial
            color={colors.main}
            transparent
            opacity={0.12}
            depthTest={false}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* Colored axle — the rotation axis, perpendicular through the ring */}
      <Line
        points={axlePoints}
        color={colors.main}
        lineWidth={axleWidth}
        transparent
        opacity={axleOpacity}
        depthTest={false}
        renderOrder={RENDER_ORDER}
        dashed={false}
      />

      {/* Visible ring — the real rotation plane (perpendicular to its axis) */}
      <Line
        points={points}
        color={colors.main}
        lineWidth={ringWidth}
        transparent
        opacity={ringOpacity}
        depthTest={false}
        renderOrder={RENDER_ORDER}
        dashed={false}
      />

      {/* Axis label at the axle tip — matches world triad direction */}
      <Html position={labelPos} center zIndexRange={[999, 1000]} style={{ pointerEvents: 'none' }}>
        <div
          onClick={e => { e.stopPropagation(); onSelect(axis); }}
          onMouseEnter={enter}
          onMouseLeave={leave}
          style={{
            pointerEvents: 'auto',
            cursor: 'pointer',
            opacity: isDimmed ? 0.35 : 1,
            background: isSelected ? colors.main : 'rgba(255,255,255,0.88)',
            color: isSelected ? '#fff' : colors.main,
            fontFamily: '"Inter", "SF Pro Display", system-ui, sans-serif',
            fontSize: '11px',
            fontWeight: 800,
            letterSpacing: '0.04em',
            width: 18,
            height: 18,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '50%',
            border: `1.5px solid ${colors.main}`,
            boxShadow: isSelected ? `0 0 0 3px ${colors.main}33` : '0 1px 3px rgba(0,0,0,0.18)',
            userSelect: 'none',
            transition: 'all 0.12s',
          }}
        >
          {AXIS_LABELS[axis]}
        </div>
      </Html>
    </group>
  );
}

// ── Main gizmo ────────────────────────────────────────────────────────────
interface PanelRotateGizmoProps {
  panelShape: Shape;
}

export function PanelRotateGizmo({ panelShape }: PanelRotateGizmoProps) {
  const {
    panelRotatePivot, setPanelRotatePivot,
    setPanelRotatePivotType,
    panelRotateAxis, setPanelRotateAxis,
  } = useAppStore();

  const [hoveredAxis, setHoveredAxis] = useState<'x' | 'y' | 'z' | null>(null);

  const hasPivot = panelRotatePivot !== null;

  const { vertices, center } = useMemo(() => {
    return {
      vertices: getPanelVertices(panelShape),
      center: getPanelCenter(panelShape),
    };
  }, [panelShape.position, panelShape.rotation, panelShape.scale, panelShape.geometry]);

  const ringRadius = useMemo(() => {
    if (!panelShape.geometry) return 40;
    const pos = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (!pos) return 40;
    const bbox = new THREE.Box3().setFromBufferAttribute(pos);
    const size = new THREE.Vector3();
    bbox.getSize(size);
    return Math.max(size.x, size.y, size.z) * 0.35;
  }, [panelShape.geometry]);

  const handlePivotSelect = (point: [number, number, number], type: 'center' | 'vertex') => {
    setPanelRotatePivot(point);
    setPanelRotatePivotType(type);
    setPanelRotateAxis(null);
  };

  const handleAxisSelect = (axis: 'x' | 'y' | 'z') => {
    setPanelRotateAxis(axis === panelRotateAxis ? null : axis);
  };

  return (
    <group>
      <PivotPoint
        position={center}
        isCenter
        onSelect={() => handlePivotSelect(center, 'center')}
        isSelected={hasPivot && panelRotatePivot![0] === center[0] && panelRotatePivot![1] === center[1] && panelRotatePivot![2] === center[2]}
      />

      {vertices.map((v, i) => (
        <PivotPoint
          key={i}
          position={v}
          onSelect={() => handlePivotSelect(v, 'vertex')}
          isSelected={hasPivot && panelRotatePivot![0] === v[0] && panelRotatePivot![1] === v[1] && panelRotatePivot![2] === v[2]}
        />
      ))}

      {hasPivot && (
        <>
          <RotationRing center={panelRotatePivot!} axis="x" radius={ringRadius} onSelect={handleAxisSelect} selectedAxis={panelRotateAxis} hoveredAxis={hoveredAxis} setHoveredAxis={setHoveredAxis} />
          <RotationRing center={panelRotatePivot!} axis="y" radius={ringRadius} onSelect={handleAxisSelect} selectedAxis={panelRotateAxis} hoveredAxis={hoveredAxis} setHoveredAxis={setHoveredAxis} />
          <RotationRing center={panelRotatePivot!} axis="z" radius={ringRadius} onSelect={handleAxisSelect} selectedAxis={panelRotateAxis} hoveredAxis={hoveredAxis} setHoveredAxis={setHoveredAxis} />
        </>
      )}
    </group>
  );
}
