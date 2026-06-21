import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useAppStore, Tool } from '../store';
import { useShallow } from 'zustand/react/shallow';

export type AxisKey = 'X' | 'Y' | 'Z';
export type AxisSign = 1 | -1;

export interface ActiveMoveAxis {
  panelId: string;
  axis: AxisKey;
  sign: AxisSign;
}

// ── Module-level reactive store for active axis selection ────────────────────
let _activeMoveAxis: ActiveMoveAxis | null = null;
const _axisListeners = new Set<() => void>();

export function setActiveMoveAxis(v: ActiveMoveAxis | null) {
  _activeMoveAxis = v;
  _axisListeners.forEach(fn => fn());
}

export function useActiveMoveAxis(): ActiveMoveAxis | null {
  const [val, setVal] = useState(_activeMoveAxis);
  useEffect(() => {
    const fn = () => setVal(_activeMoveAxis);
    _axisListeners.add(fn);
    return () => { _axisListeners.delete(fn); };
  }, []);
  return val;
}

// ── Module-level reactive store for arrow screen positions ───────────────────
export interface ArrowScreenData {
  axis: AxisKey;
  sign: AxisSign;
  tipX: number;
  tipY: number;
  behind: boolean;
}

export interface ArrowStoreData {
  arrows: ArrowScreenData[];
  centerX: number;
  centerY: number;
}

let _arrowStore: ArrowStoreData = { arrows: [], centerX: 0, centerY: 0 };
const _posListeners = new Set<() => void>();

function setArrowStore(data: ArrowStoreData) {
  _arrowStore = data;
  _posListeners.forEach(fn => fn());
}

function useArrowStore(): ArrowStoreData {
  const [val, setVal] = useState<ArrowStoreData>(_arrowStore);
  useEffect(() => {
    const fn = () => setVal({ ..._arrowStore });
    _posListeners.add(fn);
    return () => { _posListeners.delete(fn); };
  }, []);
  return val;
}

// ── Axis colors ───────────────────────────────────────────────────────────────
const AXIS_COLOR: Record<AxisKey, string> = {
  X: '#ef4444',
  Y: '#22c55e',
  Z: '#3b82f6',
};

const ARROW_DEFS: Array<{ axis: AxisKey; sign: AxisSign; dir: [number, number, number] }> = [
  { axis: 'X', sign:  1, dir: [1, 0, 0] },
  { axis: 'X', sign: -1, dir: [-1, 0, 0] },
  { axis: 'Y', sign:  1, dir: [0, 1, 0] },
  { axis: 'Y', sign: -1, dir: [0, -1, 0] },
  { axis: 'Z', sign:  1, dir: [0, 0, 1] },
  { axis: 'Z', sign: -1, dir: [0, 0, -1] },
];

// ── R3F component: lives INSIDE Canvas, projects 3D→2D each frame ─────────────
interface PanelMoveArrowsR3FProps {
  panelId: string;
  canvasEl: HTMLCanvasElement | null;
}

export const PanelMoveArrowsR3F: React.FC<PanelMoveArrowsR3FProps> = ({ panelId, canvasEl }) => {
  const { camera } = useThree();
  const { shapes } = useAppStore(useShallow(s => ({ shapes: s.shapes })));
  const panel = useMemo(() => shapes.find(s => s.id === panelId), [shapes, panelId]);

  const worldCenter = useMemo(() => {
    if (!panel?.geometry) return null;
    const pos = panel.geometry.getAttribute('position');
    if (!pos) return null;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const local = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    const p = panel.position as [number, number, number];
    const r = panel.rotation as [number, number, number];
    const sc = panel.scale as [number, number, number];
    const mat = new THREE.Matrix4().compose(
      new THREE.Vector3(...p),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...r)),
      new THREE.Vector3(...sc)
    );
    return local.applyMatrix4(mat);
  }, [panel]);

  const arrowOffset = useMemo(() => {
    if (!panel?.geometry) return 110;
    const pos = panel.geometry.getAttribute('position');
    if (!pos) return 110;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const s = panel.scale as [number, number, number];
    return Math.max((maxX - minX) * s[0], (maxY - minY) * s[1], (maxZ - minZ) * s[2]) * 0.55 + 90;
  }, [panel]);

  useFrame(() => {
    if (!worldCenter || !canvasEl) return;
    const rect = canvasEl.getBoundingClientRect();
    const w = rect.width, h = rect.height;

    const centerNdc = worldCenter.clone().project(camera);
    const centerX = rect.left + (centerNdc.x + 1) / 2 * w;
    const centerY = rect.top  + (1 - centerNdc.y) / 2 * h;

    const arrows = ARROW_DEFS.map(({ axis, sign, dir }) => {
      const tip = worldCenter.clone().addScaledVector(new THREE.Vector3(...dir), arrowOffset);
      const ndc = tip.clone().project(camera);
      const tipX = rect.left + (ndc.x + 1) / 2 * w;
      const tipY = rect.top  + (1 - ndc.y) / 2 * h;
      return { axis, sign, tipX, tipY, behind: ndc.z > 1 };
    });

    setArrowStore({ arrows, centerX, centerY });
  });

  useEffect(() => () => { setArrowStore({ arrows: [], centerX: 0, centerY: 0 }); }, []);

  return null;
};

// ── Single SVG arrow (handles its own hover state) ────────────────────────────
interface SvgArrowProps {
  arrow: ArrowScreenData;
  centerX: number;
  centerY: number;
  active: boolean;
  onSelect: (axis: AxisKey, sign: AxisSign) => void;
}

const SvgArrow: React.FC<SvgArrowProps> = ({ arrow, centerX, centerY, active, onSelect }) => {
  const [hovered, setHovered] = useState(false);
  if (arrow.behind) return null;

  const color = AXIS_COLOR[arrow.axis];
  const label = `${arrow.sign > 0 ? '+' : '−'}${arrow.axis}`;
  const isActive = active;

  const dx = arrow.tipX - centerX;
  const dy = arrow.tipY - centerY;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return null;

  const ux = dx / len, uy = dy / len;

  // Shaft: from just outside center sphere (r=8) to arrowhead base
  const headLen = 14, headHalfWidth = 7;
  const shaftStart = { x: centerX + ux * 10, y: centerY + uy * 10 };
  const headBase   = { x: arrow.tipX - ux * headLen, y: arrow.tipY - uy * headLen };
  const perpX = -uy * headHalfWidth, perpY = ux * headHalfWidth;
  const poly = [
    `${headBase.x + perpX},${headBase.y + perpY}`,
    `${headBase.x - perpX},${headBase.y - perpY}`,
    `${arrow.tipX},${arrow.tipY}`,
  ].join(' ');

  // Label: 20px beyond tip
  const labelX = arrow.tipX + ux * 22;
  const labelY = arrow.tipY + uy * 22;

  const strokeWidth = hovered || isActive ? 3.5 : 2.5;
  const opacity     = hovered || isActive ? 1 : 0.82;

  return (
    <g
      style={{ cursor: 'pointer', pointerEvents: 'all' }}
      opacity={opacity}
      onPointerEnter={() => { setHovered(true); document.body.style.cursor = 'pointer'; }}
      onPointerLeave={() => { setHovered(false); document.body.style.cursor = 'default'; }}
      onPointerDown={e => { e.stopPropagation(); e.preventDefault(); onSelect(arrow.axis, arrow.sign); }}
    >
      {/* Wide invisible click target along the arrow */}
      <line
        x1={shaftStart.x} y1={shaftStart.y}
        x2={arrow.tipX}   y2={arrow.tipY}
        stroke="transparent" strokeWidth={22} strokeLinecap="round"
      />
      {/* Visible shaft */}
      <line
        x1={shaftStart.x} y1={shaftStart.y}
        x2={headBase.x}   y2={headBase.y}
        stroke={isActive ? color : (hovered ? color : color)}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      {/* Arrowhead */}
      <polygon
        points={poly}
        fill={color}
        filter={hovered || isActive ? `drop-shadow(0 0 4px ${color}88)` : undefined}
      />
      {/* Label */}
      <text
        x={labelX} y={labelY}
        fill={color}
        fontSize={isActive ? 13 : 12}
        fontWeight="800"
        fontFamily="'SF Mono','Fira Mono',monospace"
        textAnchor="middle"
        dominantBaseline="middle"
        style={{ userSelect: 'none', pointerEvents: 'none' }}
        filter={isActive ? `drop-shadow(0 0 3px ${color}66)` : undefined}
      >{label}</text>
    </g>
  );
};

// ── Center sphere dot ─────────────────────────────────────────────────────────
const CenterDot: React.FC<{ x: number; y: number }> = ({ x, y }) => (
  <circle cx={x} cy={y} r={5} fill="#f59e0b" opacity={0.95}
    filter="drop-shadow(0 0 3px #f59e0b88)"
    style={{ pointerEvents: 'none' }}
  />
);

// ── HTML component: lives OUTSIDE Canvas, renders SVG arrow overlay ───────────
export const PanelMoveArrowsHtml: React.FC = () => {
  const { activeTool, panelMoveTargetId } = useAppStore(
    useShallow(s => ({ activeTool: s.activeTool, panelMoveTargetId: s.panelMoveTargetId }))
  );

  const store = useArrowStore();
  const active = useActiveMoveAxis();
  const isActive = activeTool === Tool.MOVE && !!panelMoveTargetId;

  const handleSelect = (axis: AxisKey, sign: AxisSign) => {
    if (!panelMoveTargetId) return;
    const st = useAppStore.getState();
    st.setPanelMoveActiveAxis(axis);
    setActiveMoveAxis({ panelId: panelMoveTargetId, axis, sign });
  };

  if (!isActive || store.arrows.length === 0) return null;

  return createPortal(
    <svg
      style={{
        position: 'fixed', inset: 0, width: '100%', height: '100%',
        pointerEvents: 'none', zIndex: 8500, overflow: 'visible',
      }}
    >
      {/* Draw all arrows */}
      {store.arrows.map(arrow => (
        <SvgArrow
          key={`${arrow.axis}${arrow.sign}`}
          arrow={arrow}
          centerX={store.centerX}
          centerY={store.centerY}
          active={!!(active && active.axis === arrow.axis && active.sign === arrow.sign)}
          onSelect={handleSelect}
        />
      ))}
      {/* Center dot */}
      {store.centerX > 0 && <CenterDot x={store.centerX} y={store.centerY} />}
    </svg>,
    document.body
  );
};

// ── Legacy export ─────────────────────────────────────────────────────────────
export const PanelMoveInputOverlay: React.FC = () => null;
