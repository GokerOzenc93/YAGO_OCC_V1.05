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
  const visualSize = isSelected ? 3.5 : hovered ? 3 : 2.2;
  const hitSize = 8;
  const color = isSelected ? '#ea580c' : hovered ? '#f97316' : '#a8a29e';

  return (
    <group position={position}>
      <mesh
        renderOrder={RENDER_ORDER}
        onPointerOver={e => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer'; }}
        onPointerOut={e => { e.stopPropagation(); setHovered(false); document.body.style.cursor = 'default'; }}
        onClick={e => { e.stopPropagation(); onSelect(position); }}
      >
        <sphereGeometry args={[hitSize, 8, 8]} />
        <meshBasicMaterial visible={false} depthTest={false} />
      </mesh>
      <mesh renderOrder={RENDER_ORDER}>
        <sphereGeometry args={[visualSize, 16, 16]} />
        <meshStandardMaterial
          color={color}
          emissive={new THREE.Color(color)}
          emissiveIntensity={isSelected ? 0.9 : hovered ? 0.6 : 0.3}
          transparent
          opacity={isSelected ? 1 : hovered ? 0.95 : 0.85}
          depthTest={false}
          roughness={0.2}
          metalness={0.4}
        />
      </mesh>
    </group>
  );
}

function getPanelOuterPoints(panelShape: Shape): [number, number, number][] {
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
  const size = new THREE.Vector3();
  bbox.getSize(size);

  const axes = [
    { i: 0, v: size.x },
    { i: 1, v: size.y },
    { i: 2, v: size.z },
  ].sort((a, b) => a.v - b.v);
  const thinAxis = axes[0].i;

  const thinMid = thinAxis === 0 ? (mn.x + mx.x) / 2 : thinAxis === 1 ? (mn.y + mx.y) / 2 : (mn.z + mx.z) / 2;

  const getCoords = (a: number, b: number): [number, number, number] => {
    if (thinAxis === 0) return [thinMid, a, b];
    if (thinAxis === 1) return [a, thinMid, b];
    return [a, b, thinMid];
  };

  const aMin = thinAxis === 0 ? mn.y : mn.x;
  const aMax = thinAxis === 0 ? mx.y : mx.x;
  const bMin = thinAxis === 0 ? mn.z : thinAxis === 1 ? mn.z : mn.y;
  const bMax = thinAxis === 0 ? mx.z : thinAxis === 1 ? mx.z : mx.y;
  const aMid = (aMin + aMax) / 2;
  const bMid = (bMin + bMax) / 2;

  // Center
  points.push(toWorld(...getCoords(aMid, bMid)));
  // 4 corners
  points.push(toWorld(...getCoords(aMin, bMin)));
  points.push(toWorld(...getCoords(aMax, bMin)));
  points.push(toWorld(...getCoords(aMax, bMax)));
  points.push(toWorld(...getCoords(aMin, bMax)));
  // 4 edge midpoints
  points.push(toWorld(...getCoords(aMid, bMin)));
  points.push(toWorld(...getCoords(aMax, bMid)));
  points.push(toWorld(...getCoords(aMid, bMax)));
  points.push(toWorld(...getCoords(aMin, bMid)));

  return points;
}

interface PanelRotateGizmoProps {
  panelShape: Shape;
}

export function PanelRotateGizmo({ panelShape }: PanelRotateGizmoProps) {
  const { panelRotatePivot, setPanelRotatePivot } = useAppStore();

  const pivotPoints = useMemo(() => getPanelOuterPoints(panelShape), [panelShape]);

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
