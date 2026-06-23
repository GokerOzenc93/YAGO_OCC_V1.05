import { useState, useMemo } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { useAppStore } from '../store';
import type { Shape } from '../store';
import { getPanelVertices, getPanelCenter } from './PanelRotateService';

const RENDER_ORDER = 999;
const PIVOT_SIZE = 4;

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
  const size = isCenter ? PIVOT_SIZE * 1.3 : PIVOT_SIZE;

  return (
    <group>
      <mesh
        position={position}
        renderOrder={RENDER_ORDER}
      >
        <sphereGeometry args={[hovered || isSelected ? size * 1.4 : size, 16, 16]} />
        <meshStandardMaterial
          color={hovered ? hoverColor : color}
          emissive={new THREE.Color(hovered ? hoverColor : color)}
          emissiveIntensity={isSelected ? 1.2 : hovered ? 0.8 : 0.4}
          transparent
          opacity={0.95}
          depthTest={false}
          roughness={0.2}
          metalness={0.5}
        />
      </mesh>
      <Html position={position} center zIndexRange={[999, 1000]} style={{ pointerEvents: 'none' }}>
        <div
          onClick={e => { e.stopPropagation(); onSelect(); }}
          onMouseEnter={() => { setHovered(true); document.body.style.cursor = 'pointer'; }}
          onMouseLeave={() => { setHovered(false); document.body.style.cursor = 'default'; }}
          style={{
            pointerEvents: 'auto',
            cursor: 'pointer',
            width: 20,
            height: 20,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        />
      </Html>
    </group>
  );
}

interface RotationRingProps {
  center: [number, number, number];
  axis: 'x' | 'y' | 'z';
  radius: number;
  onSelect: (axis: 'x' | 'y' | 'z') => void;
  selectedAxis: 'x' | 'y' | 'z' | null;
}

const AXIS_COLORS: Record<string, { main: string; hover: string }> = {
  x: { main: '#ef4444', hover: '#f87171' },
  y: { main: '#22c55e', hover: '#4ade80' },
  z: { main: '#3b82f6', hover: '#60a5fa' },
};

const AXIS_LABELS: Record<string, string> = { x: 'X', y: 'Y', z: 'Z' };

function RotationRing({ center, axis, radius, onSelect, selectedAxis }: RotationRingProps) {
  const [hovered, setHovered] = useState(false);
  const isSelected = selectedAxis === axis;
  const colors = AXIS_COLORS[axis];

  const { geometry, rotation, labelPos } = useMemo(() => {
    const segments = 64;
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      points.push(new THREE.Vector3(x, y, 0));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(points);

    let rot: [number, number, number] = [0, 0, 0];
    let lPos: [number, number, number] = [center[0], center[1], center[2]];
    if (axis === 'x') {
      rot = [0, Math.PI / 2, 0];
      lPos = [center[0], center[1] + radius + 8, center[2]];
    } else if (axis === 'y') {
      rot = [Math.PI / 2, 0, 0];
      lPos = [center[0] + radius + 8, center[1], center[2]];
    } else {
      rot = [0, 0, 0];
      lPos = [center[0], center[1] + radius + 8, center[2]];
    }

    return { geometry: geo, rotation: rot, labelPos: lPos };
  }, [center, axis, radius]);

  const color = isSelected ? '#ffffff' : hovered ? colors.hover : colors.main;

  const lineObj = useMemo(() => {
    const mat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: isSelected ? 1 : hovered ? 0.95 : 0.75,
      depthTest: false,
    });
    const line = new THREE.Line(geometry, mat);
    line.renderOrder = RENDER_ORDER;
    return line;
  }, [geometry, color, isSelected, hovered]);

  return (
    <group>
      <primitive
        object={lineObj}
        position={center}
        rotation={rotation}
      />

      <Html position={labelPos} center zIndexRange={[999, 1000]} style={{ pointerEvents: 'none' }}>
        <div
          onClick={e => { e.stopPropagation(); onSelect(axis); }}
          onMouseEnter={() => { setHovered(true); document.body.style.cursor = 'pointer'; }}
          onMouseLeave={() => { setHovered(false); document.body.style.cursor = 'default'; }}
          style={{
            pointerEvents: 'auto',
            cursor: 'pointer',
            background: isSelected ? colors.main : 'transparent',
            color: isSelected ? '#fff' : '#000',
            fontFamily: '"Inter", "SF Pro Display", system-ui, sans-serif',
            fontSize: '12px',
            fontWeight: 900,
            letterSpacing: '0.06em',
            padding: '2px 6px',
            borderRadius: '4px',
            border: 'none',
            userSelect: 'none',
            whiteSpace: 'nowrap',
            textShadow: isSelected ? 'none' : '0 0 4px #fff, 0 0 8px #fff',
            lineHeight: '1.4',
            minWidth: '22px',
            textAlign: 'center',
          }}
        >
          {AXIS_LABELS[axis]}
        </div>
      </Html>
    </group>
  );
}

interface PanelRotateGizmoProps {
  panelShape: Shape;
}

export function PanelRotateGizmo({ panelShape }: PanelRotateGizmoProps) {
  const {
    panelRotatePivot, setPanelRotatePivot,
    setPanelRotatePivotType,
    panelRotateAxis, setPanelRotateAxis,
  } = useAppStore();

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
      {/* Center pivot */}
      <PivotPoint
        position={center}
        isCenter
        onSelect={() => handlePivotSelect(center, 'center')}
        isSelected={hasPivot && panelRotatePivot![0] === center[0] && panelRotatePivot![1] === center[1] && panelRotatePivot![2] === center[2]}
      />

      {/* Vertex pivots */}
      {vertices.map((v, i) => (
        <PivotPoint
          key={i}
          position={v}
          onSelect={() => handlePivotSelect(v, 'vertex')}
          isSelected={hasPivot && panelRotatePivot![0] === v[0] && panelRotatePivot![1] === v[1] && panelRotatePivot![2] === v[2]}
        />
      ))}

      {/* Rotation rings shown after pivot is selected */}
      {hasPivot && (
        <>
          <RotationRing center={panelRotatePivot!} axis="x" radius={ringRadius} onSelect={handleAxisSelect} selectedAxis={panelRotateAxis} />
          <RotationRing center={panelRotatePivot!} axis="y" radius={ringRadius} onSelect={handleAxisSelect} selectedAxis={panelRotateAxis} />
          <RotationRing center={panelRotatePivot!} axis="z" radius={ringRadius} onSelect={handleAxisSelect} selectedAxis={panelRotateAxis} />
        </>
      )}
    </group>
  );
}
