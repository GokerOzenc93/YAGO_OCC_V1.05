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
          <ringGeometry args={[visualSize * 1.8, visualSize * 2.5, 24]} />
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

function RotationArc({ pivot, axis, radius }: { pivot: [number, number, number]; axis: 'x' | 'y' | 'z'; radius: number }) {
  const arcGeometry = useMemo(() => {
    const segments = 48;
    const angle = Math.PI * 1.5;
    const points: THREE.Vector3[] = [];

    for (let i = 0; i <= segments; i++) {
      const t = (i / segments) * angle;
      let x = 0, y = 0, z = 0;
      if (axis === 'z') {
        x = Math.cos(t) * radius;
        y = Math.sin(t) * radius;
      } else if (axis === 'y') {
        x = Math.cos(t) * radius;
        z = Math.sin(t) * radius;
      } else {
        y = Math.cos(t) * radius;
        z = Math.sin(t) * radius;
      }
      points.push(new THREE.Vector3(x, y, z));
    }

    const curve = new THREE.CatmullRomCurve3(points, false);
    const tubeGeo = new THREE.TubeGeometry(curve, segments, radius * 0.035, 8, false);
    return tubeGeo;
  }, [axis, radius]);

  const arrowGeometry = useMemo(() => {
    const angle = Math.PI * 1.5;
    const coneH = radius * 0.2;
    const coneR = radius * 0.08;
    const geo = new THREE.ConeGeometry(coneR, coneH, 12);

    let tipX = 0, tipY = 0, tipZ = 0;
    let tangentX = 0, tangentY = 0, tangentZ = 0;

    if (axis === 'z') {
      tipX = Math.cos(angle) * radius;
      tipY = Math.sin(angle) * radius;
      tangentX = -Math.sin(angle);
      tangentY = Math.cos(angle);
    } else if (axis === 'y') {
      tipX = Math.cos(angle) * radius;
      tipZ = Math.sin(angle) * radius;
      tangentX = -Math.sin(angle);
      tangentZ = Math.cos(angle);
    } else {
      tipY = Math.cos(angle) * radius;
      tipZ = Math.sin(angle) * radius;
      tangentY = -Math.sin(angle);
      tangentZ = Math.cos(angle);
    }

    const tangent = new THREE.Vector3(tangentX, tangentY, tangentZ).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const quat = new THREE.Quaternion().setFromUnitVectors(up, tangent);
    const mat = new THREE.Matrix4().compose(
      new THREE.Vector3(tipX, tipY, tipZ),
      quat,
      new THREE.Vector3(1, 1, 1)
    );
    geo.applyMatrix4(mat);
    return geo;
  }, [axis, radius]);

  const color = axis === 'x' ? '#dc2626' : axis === 'y' ? '#16a34a' : '#2563eb';

  return (
    <group position={pivot}>
      <mesh geometry={arcGeometry} renderOrder={RENDER_ORDER + 2}>
        <meshStandardMaterial
          color={color}
          emissive={new THREE.Color(color)}
          emissiveIntensity={0.6}
          transparent
          opacity={0.85}
          depthTest={false}
          roughness={0.3}
          metalness={0.3}
        />
      </mesh>
      <mesh geometry={arrowGeometry} renderOrder={RENDER_ORDER + 2}>
        <meshStandardMaterial
          color={color}
          emissive={new THREE.Color(color)}
          emissiveIntensity={0.6}
          transparent
          opacity={0.9}
          depthTest={false}
          roughness={0.3}
          metalness={0.3}
        />
      </mesh>

      {/* Translucent disc to show the rotation plane */}
      <mesh renderOrder={RENDER_ORDER}
        rotation={axis === 'x' ? [0, 0, Math.PI / 2] : axis === 'y' ? [0, 0, 0] : [Math.PI / 2, 0, 0]}
      >
        <ringGeometry args={[radius * 0.15, radius * 1.05, 48]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.06}
          depthTest={false}
          side={THREE.DoubleSide}
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

  points.push(toWorld(mn.x, mn.y, mn.z));
  points.push(toWorld(mx.x, mn.y, mn.z));
  points.push(toWorld(mx.x, mx.y, mn.z));
  points.push(toWorld(mn.x, mx.y, mn.z));
  points.push(toWorld(mn.x, mn.y, mx.z));
  points.push(toWorld(mx.x, mn.y, mx.z));
  points.push(toWorld(mx.x, mx.y, mx.z));
  points.push(toWorld(mn.x, mx.y, mx.z));

  const cx = (mn.x + mx.x) / 2;
  const cy = (mn.y + mx.y) / 2;
  const cz = (mn.z + mx.z) / 2;
  points.push(toWorld(cx, cy, cz));

  return points;
}

function getPanelArcRadius(panelShape: Shape): number {
  if (!panelShape.geometry) return 30;
  const pos = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return 30;
  const bbox = new THREE.Box3().setFromBufferAttribute(pos);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  return maxDim * 0.4;
}

interface PanelRotateGizmoProps {
  panelShape: Shape;
}

export function PanelRotateGizmo({ panelShape }: PanelRotateGizmoProps) {
  const { panelRotatePivot, setPanelRotatePivot, panelRotateAxis } = useAppStore();

  const pivotPoints = useMemo(() => getPanelAllCorners(panelShape), [panelShape]);
  const arcRadius = useMemo(() => getPanelArcRadius(panelShape), [panelShape]);

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

      {panelRotatePivot && panelRotateAxis && (
        <RotationArc
          pivot={panelRotatePivot}
          axis={panelRotateAxis}
          radius={arcRadius}
        />
      )}
    </group>
  );
}
