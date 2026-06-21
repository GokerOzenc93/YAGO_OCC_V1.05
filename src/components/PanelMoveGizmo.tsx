import { useState, useMemo } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { useAppStore } from '../store';
import type { Shape } from '../store';

const RENDER_ORDER = 999;

interface ArrowProps {
  direction: [number, number, number];
  axisLabel: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-';
  color: string;
  hoverColor: string;
  origin: [number, number, number];
  length: number;
  onSelect: (axis: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-') => void;
  selectedAxis: string | null;
}

function MoveArrow({ direction, axisLabel, color, hoverColor, origin, length, onSelect, selectedAxis }: ArrowProps) {
  const [hovered, setHovered] = useState(false);
  const isSelected = selectedAxis === axisLabel;

  const shaftRadius = length * 0.038;
  const coneRadius = length * 0.11;
  const coneHeight = length * 0.24;
  const shaftLength = length - coneHeight;

  const rotation = useMemo(() => {
    const dir = new THREE.Vector3(...direction).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);
    const euler = new THREE.Euler().setFromQuaternion(quat);
    return [euler.x, euler.y, euler.z] as [number, number, number];
  }, [direction]);

  const shaftCenter: [number, number, number] = [
    origin[0] + direction[0] * (shaftLength / 2),
    origin[1] + direction[1] * (shaftLength / 2),
    origin[2] + direction[2] * (shaftLength / 2),
  ];

  const coneCenter: [number, number, number] = [
    origin[0] + direction[0] * (shaftLength + coneHeight / 2),
    origin[1] + direction[1] * (shaftLength + coneHeight / 2),
    origin[2] + direction[2] * (shaftLength + coneHeight / 2),
  ];

  const labelPos: [number, number, number] = [
    origin[0] + direction[0] * (length + coneHeight * 0.1),
    origin[1] + direction[1] * (length + coneHeight * 0.1),
    origin[2] + direction[2] * (length + coneHeight * 0.1),
  ];

  const activeColor = isSelected ? '#ffffff' : hovered ? hoverColor : color;
  const emissiveColor = isSelected ? new THREE.Color(color) : hovered ? new THREE.Color(hoverColor) : new THREE.Color(0x000000);
  const emissiveInt = isSelected ? 0.8 : hovered ? 0.4 : 0;
  const opacity = isSelected ? 1 : hovered ? 1 : 0.88;

  const matProps = {
    color: activeColor,
    transparent: true,
    opacity,
    depthTest: false,
    emissive: emissiveColor,
    emissiveIntensity: emissiveInt,
  };

  const handlers = {
    onPointerEnter: (e: { stopPropagation: () => void }) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer'; },
    onPointerLeave: (e: { stopPropagation: () => void }) => { e.stopPropagation(); setHovered(false); document.body.style.cursor = 'default'; },
    onClick: (e: { stopPropagation: () => void }) => { e.stopPropagation(); onSelect(axisLabel); },
  };

  const labelText = axisLabel.replace('x', 'X').replace('y', 'Y').replace('z', 'Z').replace('+', '+').replace('-', '-');

  return (
    <group>
      {/* Invisible wide hit zone shaft */}
      <mesh position={shaftCenter} rotation={rotation} renderOrder={RENDER_ORDER} {...handlers}>
        <cylinderGeometry args={[shaftRadius * 2.5, shaftRadius * 2.5, shaftLength, 8]} />
        <meshBasicMaterial visible={false} transparent opacity={0} depthTest={false} />
      </mesh>

      {/* Visible shaft */}
      <mesh position={shaftCenter} rotation={rotation} renderOrder={RENDER_ORDER} {...handlers}>
        <cylinderGeometry args={[shaftRadius, shaftRadius, shaftLength, 12]} />
        <meshStandardMaterial {...matProps} />
      </mesh>

      {/* Invisible wide hit zone cone */}
      <mesh position={coneCenter} rotation={rotation} renderOrder={RENDER_ORDER} {...handlers}>
        <coneGeometry args={[coneRadius * 1.8, coneHeight * 1.4, 8]} />
        <meshBasicMaterial visible={false} transparent opacity={0} depthTest={false} />
      </mesh>

      {/* Visible cone */}
      <mesh position={coneCenter} rotation={rotation} renderOrder={RENDER_ORDER} {...handlers}>
        <coneGeometry args={[coneRadius, coneHeight, 16]} />
        <meshStandardMaterial {...matProps} />
      </mesh>

      {/* Label */}
      <Html position={labelPos} center style={{ pointerEvents: 'none' }}>
        <span
          style={{
            color: isSelected ? '#ffffff' : hovered ? hoverColor : color,
            fontFamily: 'monospace',
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.04em',
            textShadow: '0 1px 3px #000, 0 0 6px #000',
            userSelect: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          {labelText}
        </span>
      </Html>
    </group>
  );
}

function OriginSphere({ position, size }: { position: [number, number, number]; size: number }) {
  return (
    <mesh position={position} renderOrder={RENDER_ORDER}>
      <sphereGeometry args={[size, 16, 16]} />
      <meshStandardMaterial color="#f5f5f4" emissive={new THREE.Color('#78716c')} emissiveIntensity={0.4} transparent opacity={0.95} depthTest={false} />
    </mesh>
  );
}

interface PanelMoveGizmoProps {
  panelShape: Shape;
}

export function PanelMoveGizmo({ panelShape }: PanelMoveGizmoProps) {
  const { panelMoveAxis, setPanelMoveAxis } = useAppStore();

  const { centerOrigin, axisOrigins, arrowLength } = useMemo(() => {
    const fallback = panelShape.position;
    if (!panelShape.geometry) {
      const o = fallback;
      return { centerOrigin: o, axisOrigins: { 'x+': o, 'x-': o, 'y+': o, 'y-': o, 'z+': o, 'z-': o }, arrowLength: 80 };
    }
    const pos = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (!pos) {
      const o = fallback;
      return { centerOrigin: o, axisOrigins: { 'x+': o, 'x-': o, 'y+': o, 'y-': o, 'z+': o, 'z-': o }, arrowLength: 80 };
    }

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
    const cx = (mn.x + mx.x) / 2;
    const cy = (mn.y + mx.y) / 2;
    const cz = (mn.z + mx.z) / 2;

    const center = toWorld(cx, cy, cz);

    const size = new THREE.Vector3();
    bbox.getSize(size);
    const len = Math.max(size.x, size.y, size.z) * 0.55;

    return {
      centerOrigin: center,
      axisOrigins: {
        'x+': toWorld(mx.x, cy, cz),
        'x-': toWorld(mn.x, cy, cz),
        'y+': toWorld(cx, mx.y, cz),
        'y-': toWorld(cx, mn.y, cz),
        'z+': toWorld(cx, cy, mx.z),
        'z-': toWorld(cx, cy, mn.z),
      } as Record<string, [number, number, number]>,
      arrowLength: len,
    };
  }, [panelShape.position, panelShape.rotation, panelShape.scale, panelShape.geometry]);

  const handleSelect = (axis: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-') => {
    setPanelMoveAxis(axis === panelMoveAxis ? null : axis);
  };

  const axes: Array<{ axis: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-'; dir: [number, number, number]; color: string; hover: string }> = [
    { axis: 'x+', dir: [1, 0, 0],  color: '#dc2626', hover: '#ef4444' },
    { axis: 'x-', dir: [-1, 0, 0], color: '#b91c1c', hover: '#ef4444' },
    { axis: 'y+', dir: [0, 1, 0],  color: '#16a34a', hover: '#22c55e' },
    { axis: 'y-', dir: [0, -1, 0], color: '#15803d', hover: '#22c55e' },
    { axis: 'z+', dir: [0, 0, 1],  color: '#2563eb', hover: '#3b82f6' },
    { axis: 'z-', dir: [0, 0, -1], color: '#1d4ed8', hover: '#3b82f6' },
  ];

  return (
    <group>
      <OriginSphere position={centerOrigin} size={arrowLength * 0.07} />
      {axes.map(({ axis, dir, color, hover }) => (
        <MoveArrow
          key={axis}
          direction={dir}
          axisLabel={axis}
          color={color}
          hoverColor={hover}
          origin={axisOrigins[axis]}
          length={arrowLength}
          onSelect={handleSelect}
          selectedAxis={panelMoveAxis}
        />
      ))}
    </group>
  );
}
