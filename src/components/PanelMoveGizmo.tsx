import { useState, useMemo } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { useAppStore } from '../store';
import type { Shape } from '../store';

const RENDER_ORDER = 999;
const GAP_RATIO = 0.08;

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
    origin[0] + direction[0] * (length + length * 0.22),
    origin[1] + direction[1] * (length + length * 0.22),
    origin[2] + direction[2] * (length + length * 0.22),
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

  const handleLabelClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(axisLabel);
  };
  const handleLabelEnter = () => { setHovered(true); document.body.style.cursor = 'pointer'; };
  const handleLabelLeave = () => { setHovered(false); document.body.style.cursor = 'default'; };

  return (
    <group>
      <mesh position={shaftCenter} rotation={rotation} renderOrder={RENDER_ORDER}>
        <cylinderGeometry args={[shaftRadius, shaftRadius, shaftLength, 12]} />
        <meshStandardMaterial {...matProps} />
      </mesh>

      <mesh position={coneCenter} rotation={rotation} renderOrder={RENDER_ORDER}>
        <coneGeometry args={[coneRadius, coneHeight, 16]} />
        <meshStandardMaterial {...matProps} />
      </mesh>

      <Html position={labelPos} center zIndexRange={[999, 1000]} style={{ pointerEvents: 'none' }}>
        <div
          onClick={handleLabelClick}
          onMouseEnter={handleLabelEnter}
          onMouseLeave={handleLabelLeave}
          style={{
            pointerEvents: 'auto',
            cursor: 'pointer',
            background: isSelected ? color : 'transparent',
            color: isSelected ? '#fff' : '#000',
            fontFamily: '"Inter", "SF Pro Display", system-ui, sans-serif',
            fontSize: '13px',
            fontWeight: 900,
            letterSpacing: '0.06em',
            padding: '3px 7px',
            borderRadius: '4px',
            border: 'none',
            userSelect: 'none',
            whiteSpace: 'nowrap',
            textShadow: isSelected ? 'none' : '0 0 4px #fff, 0 0 8px #fff',
            lineHeight: '1.4',
            minWidth: '28px',
            textAlign: 'center',
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

function VertexDot({ position, size, isSelected, onClick }: {
  position: [number, number, number]; size: number; isSelected: boolean;
  onClick: (pos: [number, number, number]) => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <group>
      <mesh position={position} renderOrder={RENDER_ORDER + 1}>
        <sphereGeometry args={[size, 16, 16]} />
        <meshStandardMaterial
          color={isSelected ? '#16a34a' : hovered ? '#f59e0b' : '#3b82f6'}
          emissive={new THREE.Color(isSelected ? '#16a34a' : hovered ? '#f59e0b' : '#3b82f6')}
          emissiveIntensity={isSelected ? 1.2 : hovered ? 0.8 : 0.4}
          transparent opacity={1} depthTest={false} roughness={0.2} metalness={0.5}
        />
      </mesh>
      <Html position={position} center zIndexRange={[1001, 1002]} style={{ pointerEvents: 'none' }}>
        <div
          onClick={e => { e.stopPropagation(); onClick(position); }}
          onMouseEnter={() => { setHovered(true); document.body.style.cursor = 'pointer'; }}
          onMouseLeave={() => { setHovered(false); document.body.style.cursor = 'default'; }}
          style={{ pointerEvents: 'auto', cursor: 'pointer', width: 24, height: 24, borderRadius: '50%' }}
        />
      </Html>
    </group>
  );
}

interface PanelMoveGizmoProps {
  panelShape: Shape;
}

function getUniqueVertices(geo: THREE.BufferGeometry, mat: THREE.Matrix4, tolerance = 0.5): [number, number, number][] {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return [];
  const verts: [number, number, number][] = [];
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mat);
    const dup = verts.some(e => Math.abs(e[0] - v.x) < tolerance && Math.abs(e[1] - v.y) < tolerance && Math.abs(e[2] - v.z) < tolerance);
    if (!dup) verts.push([v.x, v.y, v.z]);
  }
  return verts;
}

export function PanelMoveGizmo({ panelShape }: PanelMoveGizmoProps) {
  const { panelMoveAxis, setPanelMoveAxis, panelMoveValueMode,
    panelMoveRefSourceVertex, setPanelMoveRefSourceVertex,
    panelMoveRefTargetPanelId, setPanelMoveRefTargetPanelId,
    panelMoveRefTargetVertex, setPanelMoveRefTargetVertex,
    shapes } = useAppStore();

  const isRefMode = panelMoveValueMode === 'ref';

  const mat = useMemo(() => {
    return new THREE.Matrix4().compose(
      new THREE.Vector3(...panelShape.position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...panelShape.rotation, 'XYZ')),
      new THREE.Vector3(...panelShape.scale)
    );
  }, [panelShape.position, panelShape.rotation, panelShape.scale]);

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
    const len = maxDim * 0.2;
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
  }, [panelShape.position, panelShape.rotation, panelShape.scale, panelShape.geometry, mat]);

  const sourceVertices = useMemo(() => {
    if (!isRefMode || !panelShape.geometry) return [];
    return getUniqueVertices(panelShape.geometry, mat);
  }, [isRefMode, panelShape.geometry, mat]);

  const targetPanel = useMemo(() => {
    if (!isRefMode || !panelMoveRefTargetPanelId) return null;
    return shapes.find(s => s.id === panelMoveRefTargetPanelId) || null;
  }, [isRefMode, panelMoveRefTargetPanelId, shapes]);

  const targetVertices = useMemo(() => {
    if (!targetPanel?.geometry) return [];
    const tMat = new THREE.Matrix4().compose(
      new THREE.Vector3(...targetPanel.position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...targetPanel.rotation, 'XYZ')),
      new THREE.Vector3(...targetPanel.scale)
    );
    return getUniqueVertices(targetPanel.geometry, tMat);
  }, [targetPanel]);

  const handleSelect = (axis: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-') => {
    setPanelMoveAxis(axis === panelMoveAxis ? null : axis);
  };

  const handleSourceVertexClick = (pos: [number, number, number]) => {
    setPanelMoveRefSourceVertex(pos);
    setPanelMoveRefTargetPanelId(null);
    setPanelMoveRefTargetVertex(null);
  };

  const handleTargetVertexClick = (pos: [number, number, number]) => {
    setPanelMoveRefTargetVertex(pos);
  };

  const axes: Array<{ axis: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-'; dir: [number, number, number]; color: string; hover: string }> = [
    { axis: 'x+', dir: [1, 0, 0],  color: '#ef4444', hover: '#f87171' },
    { axis: 'x-', dir: [-1, 0, 0], color: '#ef4444', hover: '#f87171' },
    { axis: 'y+', dir: [0, 1, 0],  color: '#22c55e', hover: '#4ade80' },
    { axis: 'y-', dir: [0, -1, 0], color: '#22c55e', hover: '#4ade80' },
    { axis: 'z+', dir: [0, 0, 1],  color: '#3b82f6', hover: '#60a5fa' },
    { axis: 'z-', dir: [0, 0, -1], color: '#3b82f6', hover: '#60a5fa' },
  ];

  const dotSize = arrowLength * 0.18;
  const isSourceSelected = !!panelMoveRefSourceVertex;
  const needsTargetPanel = isSourceSelected && !panelMoveRefTargetPanelId;

  return (
    <group>
      {!isRefMode && (
        <>
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
        </>
      )}
      {isRefMode && !needsTargetPanel && sourceVertices.map((v, i) => (
        <VertexDot
          key={`src-${i}`}
          position={v}
          size={dotSize}
          isSelected={!!panelMoveRefSourceVertex && Math.abs(v[0] - panelMoveRefSourceVertex[0]) < 0.5 && Math.abs(v[1] - panelMoveRefSourceVertex[1]) < 0.5 && Math.abs(v[2] - panelMoveRefSourceVertex[2]) < 0.5}
          onClick={handleSourceVertexClick}
        />
      ))}
      {isRefMode && panelMoveRefTargetPanelId && targetVertices.map((v, i) => (
        <VertexDot
          key={`tgt-${i}`}
          position={v}
          size={dotSize}
          isSelected={!!panelMoveRefTargetVertex && Math.abs(v[0] - panelMoveRefTargetVertex[0]) < 0.5 && Math.abs(v[1] - panelMoveRefTargetVertex[1]) < 0.5 && Math.abs(v[2] - panelMoveRefTargetVertex[2]) < 0.5}
          onClick={handleTargetVertexClick}
        />
      ))}
    </group>
  );
}
