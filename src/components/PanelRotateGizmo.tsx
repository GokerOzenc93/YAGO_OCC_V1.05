import { useState, useMemo } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { useAppStore } from '../store';
import type { Shape } from '../store';
import { getPanelPivotPoints } from './PanelRotateService';

const RENDER_ORDER = 999;

interface PivotPointProps {
  position: [number, number, number];
  label: string;
  onSelect: (pos: [number, number, number]) => void;
  isSelected: boolean;
}

function PivotPoint({ position, label, onSelect, isSelected }: PivotPointProps) {
  const [hovered, setHovered] = useState(false);
  const size = isSelected ? 4 : hovered ? 3.5 : 2.5;
  const color = isSelected ? '#ea580c' : hovered ? '#f97316' : '#78716c';

  return (
    <group>
      <mesh position={position} renderOrder={RENDER_ORDER}>
        <sphereGeometry args={[size, 16, 16]} />
        <meshStandardMaterial
          color={color}
          emissive={new THREE.Color(color)}
          emissiveIntensity={isSelected ? 0.8 : hovered ? 0.5 : 0.2}
          transparent
          opacity={isSelected ? 1 : 0.9}
          depthTest={false}
          roughness={0.2}
          metalness={0.4}
        />
      </mesh>
      <Html position={position} center zIndexRange={[999, 1000]} style={{ pointerEvents: 'none' }}>
        <div
          onClick={e => { e.stopPropagation(); onSelect(position); }}
          onMouseEnter={() => { setHovered(true); document.body.style.cursor = 'pointer'; }}
          onMouseLeave={() => { setHovered(false); document.body.style.cursor = 'default'; }}
          style={{
            pointerEvents: 'auto',
            cursor: 'pointer',
            transform: 'translateY(-18px)',
            background: isSelected ? '#ea580c' : hovered ? 'rgba(249,115,22,0.9)' : 'rgba(68,64,60,0.85)',
            color: '#fff',
            fontFamily: '"Inter", system-ui, sans-serif',
            fontSize: '10px',
            fontWeight: 700,
            padding: '2px 5px',
            borderRadius: '4px',
            userSelect: 'none',
            whiteSpace: 'nowrap',
            lineHeight: '1.3',
            textAlign: 'center',
            boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
          }}
        >
          {label}
        </div>
      </Html>
    </group>
  );
}

interface PanelRotateGizmoProps {
  panelShape: Shape;
}

export function PanelRotateGizmo({ panelShape }: PanelRotateGizmoProps) {
  const { panelRotatePivot, setPanelRotatePivot } = useAppStore();

  const pivotPoints = useMemo(() => getPanelPivotPoints(panelShape), [panelShape]);

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
          position={pt.world}
          label={pt.label}
          onSelect={setPanelRotatePivot}
          isSelected={isPointSelected(pt.world)}
        />
      ))}
    </group>
  );
}
