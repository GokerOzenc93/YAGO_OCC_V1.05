import { useState, useMemo } from 'react';
import * as THREE from 'three';
import { useAppStore } from '../store';
import type { Shape } from '../store';

const RENDER_ORDER = 999;

interface PivotPointProps {
  position: [number, number, number];
  onSelect: (pos: [number, number, number]) => void;
  isSelected: boolean;
}

function PivotPoint({ position, onSelect, isSelected }: PivotPointProps) {
  const [hovered, setHovered] = useState(false);
  const visualSize = isSelected ? 4.5 : hovered ? 4 : 2.8;
  const hitSize = 10;
  const color = isSelected ? '#ea580c' : hovered ? '#f97316' : '#57534e';
  const ringSize = isSelected ? 7 : hovered ? 6.5 : 0;

  return (
    <group position={position}>
      <mesh
        renderOrder={RENDER_ORDER + 1}
        onPointerOver={e => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer'; }}
        onPointerOut={e => { e.stopPropagation(); setHovered(false); document.body.style.cursor = 'default'; }}
        onClick={e => { e.stopPropagation(); onSelect(position); }}
      >
        <sphereGeometry args={[hitSize, 8, 8]} />
        <meshBasicMaterial visible={false} depthTest={false} />
      </mesh>

      {(hovered || isSelected) && (
        <mesh renderOrder={RENDER_ORDER}>
          <ringGeometry args={[ringSize * 0.6, ringSize, 24]} />
          <meshBasicMaterial
            color={isSelected ? '#ea580c' : '#f97316'}
            transparent
            opacity={isSelected ? 0.25 : 0.15}
            depthTest={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

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
    </group>
  );
}

function getPanelAllCorners(panelShape: Shape): [number, number, number][] {
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

  // All 8 corners of the bounding box
  points.push(toWorld(mn.x, mn.y, mn.z));
  points.push(toWorld(mx.x, mn.y, mn.z));
  points.push(toWorld(mx.x, mx.y, mn.z));
  points.push(toWorld(mn.x, mx.y, mn.z));
  points.push(toWorld(mn.x, mn.y, mx.z));
  points.push(toWorld(mx.x, mn.y, mx.z));
  points.push(toWorld(mx.x, mx.y, mx.z));
  points.push(toWorld(mn.x, mx.y, mx.z));

  // Center
  const cx = (mn.x + mx.x) / 2;
  const cy = (mn.y + mx.y) / 2;
  const cz = (mn.z + mx.z) / 2;
  points.push(toWorld(cx, cy, cz));

  return points;
}

interface PanelRotateGizmoProps {
  panelShape: Shape;
}

export function PanelRotateGizmo({ panelShape }: PanelRotateGizmoProps) {
  const { panelRotatePivot, setPanelRotatePivot } = useAppStore();

  const pivotPoints = useMemo(() => getPanelAllCorners(panelShape), [panelShape]);

  const isPointSelected = (world: [number, number, number]) => {
    if (!panelRotatePivot) return false;
    return (
      Math.abs(world[0] - panelRotatePivot[0]) < 0.01 &&
      Math.abs(world[1] - panelRotatePivot[1]) < 0.01 &&
      Math.abs(world[2] - panelRotatePivot[2]) < 0.01
    );
  };

  return (
    <group>
      {pivotPoints.map((pt, i) => (
        <PivotPoint
          key={i}
          position={pt}
          onSelect={setPanelRotatePivot}
          isSelected={isPointSelected(pt)}
        />
      ))}
    </group>
  );
}
