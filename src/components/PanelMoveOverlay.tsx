import React, { useMemo, useState, useCallback, useRef } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { useAppStore } from '../store';

interface ArrowHandleProps {
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  color: string;
  label: string;
  onClick: () => void;
}

const ARROW_LENGTH = 80;
const ARROW_SHAFT_RADIUS = 4;
const ARROW_HEAD_RADIUS = 10;
const ARROW_HEAD_LENGTH = 24;

const ArrowHandle: React.FC<ArrowHandleProps> = ({ origin, direction, color, label, onClick }) => {
  const [hovered, setHovered] = useState(false);

  const quaternion = useMemo(() => {
    const q = new THREE.Quaternion();
    q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize());
    return q;
  }, [direction]);

  const shaftCenter = useMemo(() => {
    const shaftLen = ARROW_LENGTH - ARROW_HEAD_LENGTH;
    return origin.clone().addScaledVector(direction, shaftLen / 2);
  }, [origin, direction]);

  const headCenter = useMemo(() => {
    const shaftLen = ARROW_LENGTH - ARROW_HEAD_LENGTH;
    return origin.clone().addScaledVector(direction, shaftLen + ARROW_HEAD_LENGTH / 2);
  }, [origin, direction]);

  const shaftLen = ARROW_LENGTH - ARROW_HEAD_LENGTH;

  const handleClick = useCallback((e: any) => {
    e.stopPropagation();
    onClick();
  }, [onClick]);

  const c = hovered ? '#ffffff' : color;

  return (
    <group
      onPointerEnter={(e) => { e.stopPropagation(); setHovered(true); (document.body.style as any).cursor = 'pointer'; }}
      onPointerLeave={(e) => { e.stopPropagation(); setHovered(false); (document.body.style as any).cursor = 'default'; }}
      onClick={handleClick}
    >
      {/* Shaft */}
      <mesh position={shaftCenter} quaternion={quaternion}>
        <cylinderGeometry args={[ARROW_SHAFT_RADIUS, ARROW_SHAFT_RADIUS, shaftLen, 8]} />
        <meshStandardMaterial color={c} roughness={0.3} metalness={0.4} />
      </mesh>
      {/* Head */}
      <mesh position={headCenter} quaternion={quaternion}>
        <coneGeometry args={[ARROW_HEAD_RADIUS, ARROW_HEAD_LENGTH, 8]} />
        <meshStandardMaterial color={c} roughness={0.3} metalness={0.4} />
      </mesh>
    </group>
  );
};

interface PanelMoveOverlayProps {
  panelShape: any;
  parentShape: any;
}

type AxisKey = 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-';

const AXIS_COLORS: Record<AxisKey, string> = {
  'x+': '#e74c3c', 'x-': '#e74c3c',
  'y+': '#2ecc71', 'y-': '#2ecc71',
  'z+': '#3498db', 'z-': '#3498db',
};

const AXIS_LABELS: Record<AxisKey, string> = {
  'x+': '+X', 'x-': '-X',
  'y+': '+Y', 'y-': '-Y',
  'z+': '+Z', 'z-': '-Z',
};

export const PanelMoveOverlay: React.FC<PanelMoveOverlayProps> = ({ panelShape, parentShape }) => {
  const updateShape = useAppStore(s => s.updateShape);
  const [activeAxis, setActiveAxis] = useState<AxisKey | null>(null);
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Compute zero point = min bounding box corner of panel geometry in WORLD space,
  // accounting for the parent's rotation so axes align with parent's local space.
  const { zeroPointWorld, axisDirections } = useMemo(() => {
    const geo = panelShape.geometry as THREE.BufferGeometry | undefined;
    if (!geo) return { zeroPointWorld: new THREE.Vector3(), axisDirections: null };

    // Panel world matrix: position only (panels have no rotation themselves relative to world)
    const panelPos = new THREE.Vector3(...(panelShape.position as [number, number, number]));

    // Parent world matrix (parent can have rotation)
    const parentPos = new THREE.Vector3(...(parentShape.position as [number, number, number]));
    const parentRot = new THREE.Euler(...(parentShape.rotation as [number, number, number]), 'XYZ');
    const parentQuat = new THREE.Quaternion().setFromEuler(parentRot);

    // Panel vertices are in geometry local space; panel.position is world position
    // (panels have no rotation stored — geometry is pre-rotated)
    const pos = geo.getAttribute('position');
    if (!pos) return { zeroPointWorld: new THREE.Vector3(), axisDirections: null };

    // Transform panel geometry vertices into parent's local space to find min corner
    const parentWorldMatrix = new THREE.Matrix4().compose(parentPos, parentQuat, new THREE.Vector3(1, 1, 1));
    const parentInverse = parentWorldMatrix.clone().invert();

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    const tmp = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      tmp.fromBufferAttribute(pos, i).add(panelPos);
      tmp.applyMatrix4(parentInverse);
      if (tmp.x < minX) minX = tmp.x;
      if (tmp.y < minY) minY = tmp.y;
      if (tmp.z < minZ) minZ = tmp.z;
    }

    // Zero point in parent local space → back to world space
    const zeroLocal = new THREE.Vector3(minX, minY, minZ);
    const zeroWorld = zeroLocal.clone().applyMatrix4(parentWorldMatrix);

    // Parent's local axes in world space
    const xAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(parentQuat);
    const yAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(parentQuat);
    const zAxis = new THREE.Vector3(0, 0, 1).applyQuaternion(parentQuat);

    return {
      zeroPointWorld: zeroWorld,
      axisDirections: { xAxis, yAxis, zAxis, parentQuat },
    };
  }, [panelShape, parentShape]);

  const arrows = useMemo((): Array<{ key: AxisKey; dir: THREE.Vector3 }> => {
    if (!axisDirections) return [];
    const { xAxis, yAxis, zAxis } = axisDirections;
    return [
      { key: 'x+', dir: xAxis.clone() },
      { key: 'x-', dir: xAxis.clone().negate() },
      { key: 'y+', dir: yAxis.clone() },
      { key: 'y-', dir: yAxis.clone().negate() },
      { key: 'z+', dir: zAxis.clone() },
      { key: 'z-', dir: zAxis.clone().negate() },
    ];
  }, [axisDirections]);

  const handleArrowClick = useCallback((key: AxisKey) => {
    setActiveAxis(key);
    setInputValue('');
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const handleMove = useCallback(() => {
    if (!activeAxis || !axisDirections) return;
    const dist = parseFloat(inputValue);
    if (isNaN(dist) || dist === 0) return;

    const { xAxis, yAxis, zAxis } = axisDirections;
    const axisMap: Record<AxisKey, THREE.Vector3> = {
      'x+': xAxis.clone(), 'x-': xAxis.clone().negate(),
      'y+': yAxis.clone(), 'y-': yAxis.clone().negate(),
      'z+': zAxis.clone(), 'z-': zAxis.clone().negate(),
    };

    const dir = axisMap[activeAxis];
    const delta = dir.multiplyScalar(dist);

    const currentPos = panelShape.position as [number, number, number];
    const newPos: [number, number, number] = [
      currentPos[0] + delta.x,
      currentPos[1] + delta.y,
      currentPos[2] + delta.z,
    ];

    const currentOffset = panelShape.parameters?.panelOffset as [number, number, number] | undefined;
    const newOffset: [number, number, number] = currentOffset
      ? [currentOffset[0] + delta.x, currentOffset[1] + delta.y, currentOffset[2] + delta.z]
      : [delta.x, delta.y, delta.z];

    updateShape(panelShape.id, {
      position: newPos,
      parameters: { ...panelShape.parameters, panelOffset: newOffset },
    });

    setActiveAxis(null);
    setInputValue('');
  }, [activeAxis, axisDirections, inputValue, panelShape, updateShape]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleMove();
    if (e.key === 'Escape') { setActiveAxis(null); setInputValue(''); }
  }, [handleMove]);

  if (!axisDirections) return null;

  return (
    <group>
      {/* Zero point marker — orange sphere */}
      <mesh position={zeroPointWorld}>
        <sphereGeometry args={[12, 16, 16]} />
        <meshStandardMaterial color="#f39c12" emissive="#f39c12" emissiveIntensity={0.6} roughness={0.2} metalness={0.5} />
      </mesh>

      {/* Directional arrows */}
      {arrows.map(({ key, dir }) => (
        <ArrowHandle
          key={key}
          origin={zeroPointWorld}
          direction={dir}
          color={AXIS_COLORS[key]}
          label={AXIS_LABELS[key]}
          onClick={() => handleArrowClick(key)}
        />
      ))}

      {/* Input overlay — rendered via Html so it sits below the canvas */}
      {activeAxis && (
        <Html
          position={zeroPointWorld}
          style={{ pointerEvents: 'none' }}
          zIndexRange={[100, 200]}
          prepend
        >
          <div
            style={{
              position: 'fixed',
              bottom: 24,
              left: '50%',
              transform: 'translateX(-50%)',
              background: 'rgba(15,15,20,0.92)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 8,
              padding: '12px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              pointerEvents: 'all',
              boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
              minWidth: 280,
              zIndex: 9999,
            }}
          >
            <span style={{ color: AXIS_COLORS[activeAxis], fontWeight: 700, fontSize: 13, fontFamily: 'monospace', minWidth: 28 }}>
              {AXIS_LABELS[activeAxis]}
            </span>
            <input
              ref={inputRef}
              type="number"
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Distance (mm)"
              style={{
                flex: 1,
                background: 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: 4,
                color: '#fff',
                fontSize: 14,
                padding: '6px 10px',
                outline: 'none',
                fontFamily: 'monospace',
              }}
              autoFocus
            />
            <button
              onClick={handleMove}
              style={{
                background: '#e8622a',
                border: 'none',
                borderRadius: 4,
                color: '#fff',
                fontWeight: 700,
                fontSize: 13,
                padding: '6px 14px',
                cursor: 'pointer',
              }}
            >
              OK
            </button>
            <button
              onClick={() => { setActiveAxis(null); setInputValue(''); }}
              style={{
                background: 'rgba(255,255,255,0.1)',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 4,
                color: '#aaa',
                fontSize: 13,
                padding: '6px 10px',
                cursor: 'pointer',
              }}
            >
              ✕
            </button>
          </div>
        </Html>
      )}
    </group>
  );
};
