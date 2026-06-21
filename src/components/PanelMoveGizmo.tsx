import { useState, useMemo } from 'react';
import * as THREE from 'three';
import { useAppStore } from '../store';
import type { Shape } from '../store';

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

  const shaftRadius = length * 0.035;
  const coneRadius = length * 0.1;
  const coneHeight = length * 0.22;
  const shaftLength = length - coneHeight;

  const rotation = useMemo(() => {
    const dir = new THREE.Vector3(...direction).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);
    const euler = new THREE.Euler().setFromQuaternion(quat);
    return [euler.x, euler.y, euler.z] as [number, number, number];
  }, [direction]);

  const tipPos: [number, number, number] = [
    origin[0] + direction[0] * length,
    origin[1] + direction[1] * length,
    origin[2] + direction[2] * length,
  ];

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

  const activeColor = isSelected ? '#ffffff' : hovered ? hoverColor : color;
  const opacity = isSelected ? 1 : hovered ? 0.95 : 0.8;

  return (
    <group>
      <mesh
        position={shaftCenter}
        rotation={rotation}
        onPointerEnter={e => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer'; }}
        onPointerLeave={e => { e.stopPropagation(); setHovered(false); document.body.style.cursor = 'default'; }}
        onClick={e => { e.stopPropagation(); onSelect(axisLabel); }}
      >
        <cylinderGeometry args={[shaftRadius, shaftRadius, shaftLength, 12]} />
        <meshStandardMaterial color={activeColor} transparent opacity={opacity} emissive={isSelected ? color : '#000000'} emissiveIntensity={isSelected ? 0.5 : 0} />
      </mesh>

      <mesh
        position={coneCenter}
        rotation={rotation}
        onPointerEnter={e => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer'; }}
        onPointerLeave={e => { e.stopPropagation(); setHovered(false); document.body.style.cursor = 'default'; }}
        onClick={e => { e.stopPropagation(); onSelect(axisLabel); }}
      >
        <coneGeometry args={[coneRadius, coneHeight, 16]} />
        <meshStandardMaterial color={activeColor} transparent opacity={opacity} emissive={isSelected ? color : '#000000'} emissiveIntensity={isSelected ? 0.5 : 0} />
      </mesh>
    </group>
  );
}

function OriginSphere({ position, size }: { position: [number, number, number]; size: number }) {
  return (
    <mesh position={position}>
      <sphereGeometry args={[size, 16, 16]} />
      <meshStandardMaterial color="#f5f5f4" emissive="#78716c" emissiveIntensity={0.3} transparent opacity={0.9} />
    </mesh>
  );
}

interface PanelMoveGizmoProps {
  panelShape: Shape;
}

export function PanelMoveGizmo({ panelShape }: PanelMoveGizmoProps) {
  const { panelMoveAxis, setPanelMoveAxis } = useAppStore();

  const gizmoOrigin = useMemo<[number, number, number]>(() => {
    if (!panelShape.geometry) return panelShape.position;
    const pos = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (!pos) return panelShape.position;
    const bbox = new THREE.Box3().setFromBufferAttribute(pos);

    const localOrigin = new THREE.Vector3(bbox.min.x, bbox.min.y, bbox.min.z);

    const mat = new THREE.Matrix4();
    mat.compose(
      new THREE.Vector3(...panelShape.position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...panelShape.rotation, 'XYZ')),
      new THREE.Vector3(...panelShape.scale)
    );

    localOrigin.applyMatrix4(mat);
    return [localOrigin.x, localOrigin.y, localOrigin.z];
  }, [panelShape.position, panelShape.rotation, panelShape.scale, panelShape.geometry]);

  const arrowLength = useMemo(() => {
    if (!panelShape.geometry) return 60;
    const pos = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (!pos) return 60;
    const bbox = new THREE.Box3().setFromBufferAttribute(pos);
    const size = new THREE.Vector3();
    bbox.getSize(size);
    return Math.max(size.x, size.y, size.z) * 0.4;
  }, [panelShape.geometry]);

  const handleSelect = (axis: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-') => {
    setPanelMoveAxis(axis === panelMoveAxis ? null : axis);
  };

  const axes: Array<{ axis: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-'; dir: [number, number, number]; color: string; hover: string }> = [
    { axis: 'x+', dir: [1, 0, 0], color: '#dc2626', hover: '#ef4444' },
    { axis: 'x-', dir: [-1, 0, 0], color: '#991b1b', hover: '#b91c1c' },
    { axis: 'y+', dir: [0, 1, 0], color: '#16a34a', hover: '#22c55e' },
    { axis: 'y-', dir: [0, -1, 0], color: '#166534', hover: '#15803d' },
    { axis: 'z+', dir: [0, 0, 1], color: '#2563eb', hover: '#3b82f6' },
    { axis: 'z-', dir: [0, 0, -1], color: '#1e3a8a', hover: '#1d4ed8' },
  ];

  return (
    <group>
      <OriginSphere position={gizmoOrigin} size={arrowLength * 0.08} />
      {axes.map(({ axis, dir, color, hover }) => (
        <MoveArrow
          key={axis}
          direction={dir}
          axisLabel={axis}
          color={color}
          hoverColor={hover}
          origin={gizmoOrigin}
          length={arrowLength}
          onSelect={handleSelect}
          selectedAxis={panelMoveAxis}
        />
      ))}
    </group>
  );
}
