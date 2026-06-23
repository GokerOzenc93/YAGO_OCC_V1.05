import { useState, useMemo } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { useAppStore } from '../store';
import type { Shape } from '../store';

const RENDER_ORDER = 999;

function getPanelCorners(panelShape: Shape): [number, number, number][] {
  const points: [number, number, number][] = [];
  if (!panelShape.geometry) return points;

  const pos = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return points;

  const bbox = new THREE.Box3().setFromBufferAttribute(pos);
  const mat = new THREE.Matrix4().compose(
    new THREE.Vector3(...panelShape.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...panelShape.rotation, 'XYZ')),
    new THREE.Vector3(...panelShape.scale)
  );

  const toWorld = (lx: number, ly: number, lz: number): [number, number, number] => {
    const v = new THREE.Vector3(lx, ly, lz).applyMatrix4(mat);
    return [v.x, v.y, v.z];
  };

  const mn = bbox.min;
  const mx = bbox.max;

  points.push(toWorld(mn.x, mn.y, mn.z));
  points.push(toWorld(mx.x, mn.y, mn.z));
  points.push(toWorld(mx.x, mx.y, mn.z));
  points.push(toWorld(mn.x, mx.y, mn.z));
  points.push(toWorld(mn.x, mn.y, mx.z));
  points.push(toWorld(mx.x, mn.y, mx.z));
  points.push(toWorld(mx.x, mx.y, mx.z));
  points.push(toWorld(mn.x, mx.y, mx.z));

  // Midpoints of edges (along the two longest axes, skipping thin axis)
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const axes = [
    { i: 0, v: size.x },
    { i: 1, v: size.y },
    { i: 2, v: size.z },
  ].sort((a, b) => a.v - b.v);
  const thinIdx = axes[0].i;

  const cx = (mn.x + mx.x) / 2;
  const cy = (mn.y + mx.y) / 2;
  const cz = (mn.z + mx.z) / 2;

  // Edge midpoints (skip thin axis edges — they are too close to corners)
  if (thinIdx !== 0) {
    points.push(toWorld(cx, mn.y, mn.z));
    points.push(toWorld(cx, mx.y, mn.z));
    points.push(toWorld(cx, mn.y, mx.z));
    points.push(toWorld(cx, mx.y, mx.z));
  }
  if (thinIdx !== 1) {
    points.push(toWorld(mn.x, cy, mn.z));
    points.push(toWorld(mx.x, cy, mn.z));
    points.push(toWorld(mn.x, cy, mx.z));
    points.push(toWorld(mx.x, cy, mx.z));
  }
  if (thinIdx !== 2) {
    points.push(toWorld(mn.x, mn.y, cz));
    points.push(toWorld(mx.x, mn.y, cz));
    points.push(toWorld(mn.x, mx.y, cz));
    points.push(toWorld(mx.x, mx.y, cz));
  }

  return points;
}

function PivotPoint({ position, onSelect, isSelected }: {
  position: [number, number, number];
  onSelect: (pos: [number, number, number]) => void;
  isSelected: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const visualSize = isSelected ? 5 : hovered ? 4.5 : 3.5;
  const color = isSelected ? '#ea580c' : hovered ? '#f97316' : '#78716c';

  return (
    <group position={position}>
      {/* Visual sphere — always rendered on top */}
      <mesh renderOrder={RENDER_ORDER + 1}>
        <sphereGeometry args={[visualSize, 16, 16]} />
        <meshStandardMaterial
          color={color}
          emissive={new THREE.Color(color)}
          emissiveIntensity={isSelected ? 1.0 : hovered ? 0.7 : 0.3}
          transparent
          opacity={1}
          depthTest={false}
          roughness={0.15}
          metalness={0.5}
        />
      </mesh>
      {/* White ring for contrast */}
      {(hovered || isSelected) && (
        <mesh renderOrder={RENDER_ORDER}>
          <ringGeometry args={[visualSize * 1.6, visualSize * 2.2, 24]} />
          <meshBasicMaterial
            color={isSelected ? '#ea580c' : '#f97316'}
            transparent
            opacity={0.2}
            depthTest={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
      {/* HTML hit area — always clickable, bypasses 3D raycasting */}
      <Html center zIndexRange={[999, 1000]} style={{ pointerEvents: 'none' }}>
        <div
          onClick={(e) => { e.stopPropagation(); onSelect(position); }}
          onMouseEnter={() => { setHovered(true); document.body.style.cursor = 'pointer'; }}
          onMouseLeave={() => { setHovered(false); document.body.style.cursor = 'default'; }}
          style={{
            pointerEvents: 'auto',
            width: 22,
            height: 22,
            borderRadius: '50%',
            cursor: 'pointer',
            transform: 'translate(-50%, -50%)',
            position: 'absolute',
            left: '50%',
            top: '50%',
          }}
        />
      </Html>
    </group>
  );
}

function RotationRing({ pivot, axis, radius, onAxisClick }: {
  pivot: [number, number, number];
  axis: 'x' | 'y' | 'z';
  radius: number;
  onAxisClick: (axis: 'x' | 'y' | 'z') => void;
}) {
  const [hovered, setHovered] = useState(false);

  const arcGeometry = useMemo(() => {
    const segments = 48;
    const angle = Math.PI * 2;
    const points: THREE.Vector3[] = [];

    for (let i = 0; i <= segments; i++) {
      const t = (i / segments) * angle;
      let x = 0, y = 0, z = 0;
      if (axis === 'z') { x = Math.cos(t) * radius; y = Math.sin(t) * radius; }
      else if (axis === 'y') { x = Math.cos(t) * radius; z = Math.sin(t) * radius; }
      else { y = Math.cos(t) * radius; z = Math.sin(t) * radius; }
      points.push(new THREE.Vector3(x, y, z));
    }

    const curve = new THREE.CatmullRomCurve3(points, true);
    return new THREE.TubeGeometry(curve, segments, radius * 0.04, 8, true);
  }, [axis, radius]);

  const color = axis === 'x' ? '#dc2626' : axis === 'y' ? '#16a34a' : '#2563eb';
  const labelOffset: [number, number, number] = axis === 'x'
    ? [pivot[0], pivot[1] + radius + 12, pivot[2]]
    : axis === 'y'
    ? [pivot[0] + radius + 12, pivot[1], pivot[2]]
    : [pivot[0] + radius + 12, pivot[1], pivot[2]];

  return (
    <group position={pivot}>
      <mesh geometry={arcGeometry} renderOrder={RENDER_ORDER + 2}>
        <meshStandardMaterial
          color={color}
          emissive={new THREE.Color(color)}
          emissiveIntensity={hovered ? 0.9 : 0.5}
          transparent
          opacity={hovered ? 1 : 0.7}
          depthTest={false}
          roughness={0.3}
          metalness={0.3}
        />
      </mesh>
      {/* Clickable label — HTML so it's always on top */}
      <Html position={[labelOffset[0] - pivot[0], labelOffset[1] - pivot[1], labelOffset[2] - pivot[2]]} center zIndexRange={[999, 1000]} style={{ pointerEvents: 'none' }}>
        <div
          onClick={(e) => { e.stopPropagation(); onAxisClick(axis); }}
          onMouseEnter={() => { setHovered(true); document.body.style.cursor = 'pointer'; }}
          onMouseLeave={() => { setHovered(false); document.body.style.cursor = 'default'; }}
          style={{
            pointerEvents: 'auto',
            cursor: 'pointer',
            background: hovered ? color : 'rgba(255,255,255,0.9)',
            color: hovered ? '#fff' : color,
            fontFamily: '"Inter", system-ui, sans-serif',
            fontSize: '12px',
            fontWeight: 900,
            padding: '3px 8px',
            borderRadius: '6px',
            border: `2px solid ${color}`,
            userSelect: 'none',
            whiteSpace: 'nowrap',
            boxShadow: '0 2px 4px rgba(0,0,0,0.15)',
            transition: 'all 0.12s',
          }}
        >
          {axis.toUpperCase()}
        </div>
      </Html>
    </group>
  );
}

function getPanelArcRadius(panelShape: Shape): number {
  if (!panelShape.geometry) return 30;
  const pos = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return 30;
  const bbox = new THREE.Box3().setFromBufferAttribute(pos);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  return maxDim * 0.35;
}

interface PanelRotateGizmoProps {
  panelShape: Shape;
}

export function PanelRotateGizmo({ panelShape }: PanelRotateGizmoProps) {
  const { panelRotatePivot, setPanelRotatePivot, setPanelRotateAxis } = useAppStore();

  const pivotPoints = useMemo(() => getPanelCorners(panelShape), [panelShape]);
  const arcRadius = useMemo(() => getPanelArcRadius(panelShape), [panelShape]);

  const isPointSelected = (world: [number, number, number]) => {
    if (!panelRotatePivot) return false;
    return (
      Math.abs(world[0] - panelRotatePivot[0]) < 0.01 &&
      Math.abs(world[1] - panelRotatePivot[1]) < 0.01 &&
      Math.abs(world[2] - panelRotatePivot[2]) < 0.01
    );
  };

  const handlePivotSelect = (pos: [number, number, number]) => {
    setPanelRotatePivot(pos);
    setPanelRotateAxis(null);
  };

  const handleAxisClick = (axis: 'x' | 'y' | 'z') => {
    setPanelRotateAxis(axis);
  };

  return (
    <group>
      {pivotPoints.map((pt, i) => (
        <PivotPoint
          key={i}
          position={pt}
          onSelect={handlePivotSelect}
          isSelected={isPointSelected(pt)}
        />
      ))}

      {panelRotatePivot && (
        <>
          <RotationRing pivot={panelRotatePivot} axis="x" radius={arcRadius} onAxisClick={handleAxisClick} />
          <RotationRing pivot={panelRotatePivot} axis="y" radius={arcRadius} onAxisClick={handleAxisClick} />
          <RotationRing pivot={panelRotatePivot} axis="z" radius={arcRadius} onAxisClick={handleAxisClick} />
        </>
      )}
    </group>
  );
}
