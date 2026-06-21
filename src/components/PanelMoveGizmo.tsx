import { useState, useMemo } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { useAppStore } from '../store';
import type { Shape } from '../store';

const RENDER_ORDER = 999;
const GAP_RATIO = 0.08; // gap between panel face and arrow start, relative to panel size

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

const AXIS_DISPLAY: Record<string, string> = {
  'x+': '+X', 'x-': '−X',
  'y+': '+Y', 'y-': '−Y',
  'z+': '+Z', 'z-': '−Z',
};

function MoveArrow({ direction, axisLabel, color, hoverColor, origin, length, onSelect, selectedAxis }: ArrowProps) {
  const [hovered, setHovered] = useState(false);
  const isSelected = selectedAxis === axisLabel;

  const shaftRadius = length * 0.055;
  const coneRadius = length * 0.16;
  const coneHeight = length * 0.36;
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
    origin[0] + direction[0] * (length + length * 0.18),
    origin[1] + direction[1] * (length + length * 0.18),
    origin[2] + direction[2] * (length + length * 0.18),
  ];

  const activeColor = isSelected ? '#ffffff' : hovered ? hoverColor : color;
  const emissiveColor = isSelected ? new THREE.Color(color) : hovered ? new THREE.Color(hoverColor) : new THREE.Color(0x000000);
  const emissiveInt = isSelected ? 1.0 : hovered ? 0.6 : 0.1;
  const opacity = isSelected ? 1 : hovered ? 1 : 0.92;

  const matProps = {
    color: activeColor,
    transparent: true,
    opacity,
    depthTest: false,
    emissive: emissiveColor,
    emissiveIntensity: emissiveInt,
    roughness: 0.25,
    metalness: 0.4,
  };

  const handlers = {
    onPointerEnter: (e: { stopPropagation: () => void }) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer'; },
    onPointerLeave: (e: { stopPropagation: () => void }) => { e.stopPropagation(); setHovered(false); document.body.style.cursor = 'default'; },
    onClick: (e: { stopPropagation: () => void }) => { e.stopPropagation(); onSelect(axisLabel); },
  };

  return (
    <group>
      {/* Invisible wide hit zone shaft */}
      <mesh position={shaftCenter} rotation={rotation} renderOrder={RENDER_ORDER} {...handlers}>
        <cylinderGeometry args={[shaftRadius * 2.8, shaftRadius * 2.8, shaftLength, 8]} />
        <meshBasicMaterial visible={false} transparent opacity={0} depthTest={false} />
      </mesh>

      {/* Visible shaft */}
      <mesh position={shaftCenter} rotation={rotation} renderOrder={RENDER_ORDER} {...handlers}>
        <cylinderGeometry args={[shaftRadius, shaftRadius, shaftLength, 12]} />
        <meshStandardMaterial {...matProps} />
      </mesh>

      {/* Invisible wide hit zone cone */}
      <mesh position={coneCenter} rotation={rotation} renderOrder={RENDER_ORDER} {...handlers}>
        <coneGeometry args={[coneRadius * 2, coneHeight * 1.5, 8]} />
        <meshBasicMaterial visible={false} transparent opacity={0} depthTest={false} />
      </mesh>

      {/* Visible cone */}
      <mesh position={coneCenter} rotation={rotation} renderOrder={RENDER_ORDER} {...handlers}>
        <coneGeometry args={[coneRadius, coneHeight, 16]} />
        <meshStandardMaterial {...matProps} />
      </mesh>

      {/* Label */}
      <Html position={labelPos} center zIndexRange={[999, 1000]} style={{ pointerEvents: 'none' }}>
        <div
          style={{
            background: isSelected ? color : hovered ? 'rgba(0,0,0,0.75)' : 'rgba(0,0,0,0.62)',
            color: isSelected ? '#fff' : '#fff',
            fontFamily: '"Inter", "SF Pro Display", system-ui, sans-serif',
            fontSize: '12px',
            fontWeight: 800,
            letterSpacing: '0.06em',
            padding: '2px 6px',
            borderRadius: '4px',
            border: `1.5px solid ${isSelected ? '#fff' : color}`,
            userSelect: 'none',
            whiteSpace: 'nowrap',
            boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
            lineHeight: '1.4',
          }}
        >
          {AXIS_DISPLAY[axisLabel]}
        </div>
      </Html>
    </group>
  );
}

function OriginSphere({ position, size }: { position: [number, number, number]; size: number }) {
  return (
    <mesh position={position} renderOrder={RENDER_ORDER}>
      <sphereGeometry args={[size, 16, 16]} />
      <meshStandardMaterial color="#e7e5e4" emissive={new THREE.Color('#a8a29e')} emissiveIntensity={0.5} transparent opacity={0.95} depthTest={false} roughness={0.3} metalness={0.3} />
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
      return { centerOrigin: o, axisOrigins: { 'x+': o, 'x-': o, 'y+': o, 'y-': o, 'z+': o, 'z-': o }, arrowLength: 40 };
    }
    const pos = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (!pos) {
      const o = fallback;
      return { centerOrigin: o, axisOrigins: { 'x+': o, 'x-': o, 'y+': o, 'y-': o, 'z+': o, 'z-': o }, arrowLength: 40 };
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
    const maxDim = Math.max(size.x, size.y, size.z);
    // Arrow length is short — about 20% of max panel dimension
    const len = maxDim * 0.2;
    // Gap from face to arrow start
    const gap = maxDim * GAP_RATIO;

    const gapped = (lx: number, ly: number, lz: number, dx: number, dy: number, dz: number): [number, number, number] => {
      const w = toWorld(lx, ly, lz);
      return [w[0] + dx * gap, w[1] + dy * gap, w[2] + dz * gap];
    };

    return {
      centerOrigin: center,
      axisOrigins: {
        'x+': gapped(mx.x, cy, cz,  1,  0,  0),
        'x-': gapped(mn.x, cy, cz, -1,  0,  0),
        'y+': gapped(cx, mx.y, cz,  0,  1,  0),
        'y-': gapped(cx, mn.y, cz,  0, -1,  0),
        'z+': gapped(cx, cy, mx.z,  0,  0,  1),
        'z-': gapped(cx, cy, mn.z,  0,  0, -1),
      } as Record<string, [number, number, number]>,
      arrowLength: len,
    };
  }, [panelShape.position, panelShape.rotation, panelShape.scale, panelShape.geometry]);

  const handleSelect = (axis: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-') => {
    setPanelMoveAxis(axis === panelMoveAxis ? null : axis);
  };

  const axes: Array<{ axis: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-'; dir: [number, number, number]; color: string; hover: string }> = [
    { axis: 'x+', dir: [1, 0, 0],  color: '#ef4444', hover: '#f87171' },
    { axis: 'x-', dir: [-1, 0, 0], color: '#ef4444', hover: '#f87171' },
    { axis: 'y+', dir: [0, 1, 0],  color: '#22c55e', hover: '#4ade80' },
    { axis: 'y-', dir: [0, -1, 0], color: '#22c55e', hover: '#4ade80' },
    { axis: 'z+', dir: [0, 0, 1],  color: '#3b82f6', hover: '#60a5fa' },
    { axis: 'z-', dir: [0, 0, -1], color: '#3b82f6', hover: '#60a5fa' },
  ];

  return (
    <group>
      <OriginSphere position={centerOrigin} size={arrowLength * 0.22} />
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
