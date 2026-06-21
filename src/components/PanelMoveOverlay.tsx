import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useAppStore, Tool } from '../store';
import { useShallow } from 'zustand/react/shallow';

type AxisKey = 'X' | 'Y' | 'Z';

const AXIS_COLORS: Record<AxisKey, string> = {
  X: '#ef4444',
  Y: '#22c55e',
  Z: '#3b82f6',
};

// ── Input panel (bottom-center when an axis is active) ───────────────────────
interface PanelMoveInputPanelProps {
  axis: AxisKey;
  panelId: string;
  onDone: () => void;
}

const PanelMoveInputPanel: React.FC<PanelMoveInputPanelProps> = ({ axis, panelId, onDone }) => {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const { updateShape, shapes } = useAppStore(useShallow(s => ({
    updateShape: s.updateShape,
    shapes: s.shapes,
  })));

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 30);
  }, []);

  const apply = useCallback(() => {
    const dist = parseFloat(value);
    if (isNaN(dist) || dist === 0) { onDone(); return; }
    const panel = shapes.find(s => s.id === panelId);
    if (!panel) { onDone(); return; }
    const delta: [number, number, number] = [
      axis === 'X' ? dist : 0,
      axis === 'Y' ? dist : 0,
      axis === 'Z' ? dist : 0,
    ];
    const cur = panel.position as [number, number, number];
    const newPos: [number, number, number] = [cur[0] + delta[0], cur[1] + delta[1], cur[2] + delta[2]];
    const stepId = `move-${Date.now()}`;
    const prevSteps = panel.parameters?.moveSteps || [];
    updateShape(panelId, {
      position: newPos,
      parameters: { ...panel.parameters, moveSteps: [...prevSteps, { id: stepId, axis, value: dist }] },
    });
    onDone();
  }, [value, axis, panelId, shapes, updateShape, onDone]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') apply();
    if (e.key === 'Escape') onDone();
  }, [apply, onDone]);

  const axisColor = AXIS_COLORS[axis];

  return createPortal(
    <div
      style={{
        position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
        zIndex: 9999, display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 14px',
        background: 'linear-gradient(180deg,rgba(250,248,244,0.97),rgba(239,235,227,0.98))',
        backdropFilter: 'blur(16px) saturate(160%)',
        WebkitBackdropFilter: 'blur(16px) saturate(160%)',
        border: '1px solid rgba(60,50,40,0.15)', borderRadius: 10,
        boxShadow: '0 8px 28px -6px rgba(40,30,20,0.28),0 0 0 0.5px rgba(60,50,40,0.06),inset 0 1px 0 rgba(255,255,255,0.90)',
        fontFamily: "'Inter','SF Pro Text',system-ui,sans-serif", minWidth: 280, pointerEvents: 'all',
      }}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    >
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 22, height: 22, borderRadius: 5, flexShrink: 0,
        background: axisColor, color: '#fff', fontSize: 11, fontWeight: 800, fontFamily: 'monospace',
        boxShadow: `0 1px 3px ${axisColor}66`,
      }}>{axis}</span>
      <span style={{ fontSize: 11, color: '#78716c', fontWeight: 500, flexShrink: 0 }}>Mesafe (mm)</span>
      <input
        ref={inputRef} type="number" value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={handleKeyDown} placeholder="0"
        style={{
          flex: 1, height: 28, textAlign: 'center', fontFamily: 'monospace',
          fontSize: 13, fontWeight: 600, color: '#1c1917',
          background: 'linear-gradient(180deg,#fff,#faf8f3)',
          border: '1px solid rgba(60,50,40,0.16)', borderRadius: 7, outline: 'none',
          boxShadow: 'inset 0 1px 2px rgba(40,30,20,0.06)', minWidth: 0,
        }}
        autoFocus
      />
      <button onClick={apply} style={{
        flexShrink: 0, height: 28, padding: '0 12px', borderRadius: 7, border: 'none',
        cursor: 'pointer', outline: 'none',
        background: 'linear-gradient(180deg,#5b5346,#44403c)',
        color: '#fff', fontSize: 12, fontWeight: 700,
        boxShadow: '0 1px 2px rgba(40,30,20,0.25),inset 0 1px 0 rgba(255,255,255,0.18)',
      }}>Uygula</button>
      <button onClick={onDone} style={{
        flexShrink: 0, height: 28, width: 28, borderRadius: 7,
        border: '1px solid rgba(60,50,40,0.14)', cursor: 'pointer',
        background: 'rgba(120,113,108,0.07)', color: '#78716c', fontSize: 13,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>✕</button>
    </div>,
    document.body
  );
};

// ── Module-level reactive stores ─────────────────────────────────────────────

// Active axis selection
let _activeMoveAxis: { panelId: string; axis: AxisKey } | null = null;
const _axisListeners = new Set<() => void>();

export function setActiveMoveAxis(v: { panelId: string; axis: AxisKey } | null) {
  _activeMoveAxis = v;
  _axisListeners.forEach(fn => fn());
}

export function useActiveMoveAxis() {
  const [val, setVal] = useState(_activeMoveAxis);
  useEffect(() => {
    const fn = () => setVal(_activeMoveAxis);
    _axisListeners.add(fn);
    return () => { _axisListeners.delete(fn); };
  }, []);
  return val;
}

// Arrow screen positions (updated by R3F useFrame, consumed by HTML layer)
interface ArrowPos { axis: AxisKey; sign: 1 | -1; x: number; y: number; behind: boolean }
let _arrowPositions: ArrowPos[] = [];
const _posListeners = new Set<() => void>();

function setArrowPositions(positions: ArrowPos[]) {
  _arrowPositions = positions;
  _posListeners.forEach(fn => fn());
}

function useArrowPositions() {
  const [val, setVal] = useState<ArrowPos[]>(_arrowPositions);
  useEffect(() => {
    const fn = () => setVal([..._arrowPositions]);
    _posListeners.add(fn);
    return () => { _posListeners.delete(fn); };
  }, []);
  return val;
}

// ── Arrow directions ──────────────────────────────────────────────────────────
const ARROW_DEFS: Array<{ axis: AxisKey; sign: 1 | -1; dir: [number, number, number] }> = [
  { axis: 'X', sign:  1, dir: [1, 0, 0] },
  { axis: 'X', sign: -1, dir: [-1, 0, 0] },
  { axis: 'Y', sign:  1, dir: [0, 1, 0] },
  { axis: 'Y', sign: -1, dir: [0, -1, 0] },
  { axis: 'Z', sign:  1, dir: [0, 0, 1] },
  { axis: 'Z', sign: -1, dir: [0, 0, -1] },
];

// ── R3F-only component: lives INSIDE Canvas, projects 3D→2D each frame ────────
// Renders nothing in the 3D scene; only updates the module-level position store.
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
    const worldPos = new THREE.Vector3(...(panel.position as [number, number, number]));
    const worldRot = new THREE.Euler(...(panel.rotation as [number, number, number]));
    const worldScl = new THREE.Vector3(...(panel.scale as [number, number, number]));
    const mat = new THREE.Matrix4().compose(worldPos, new THREE.Quaternion().setFromEuler(worldRot), worldScl);
    return local.applyMatrix4(mat);
  }, [panel]);

  const arrowOffset = useMemo(() => {
    if (!panel?.geometry) return 120;
    const pos = panel.geometry.getAttribute('position');
    if (!pos) return 120;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const s = panel.scale as [number, number, number];
    const sizeX = (maxX - minX) * s[0];
    const sizeY = (maxY - minY) * s[1];
    const sizeZ = (maxZ - minZ) * s[2];
    return Math.max(sizeX, sizeY, sizeZ) * 0.6 + 90;
  }, [panel]);

  useFrame(() => {
    if (!worldCenter || !canvasEl) return;
    const rect = canvasEl.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    const positions = ARROW_DEFS.map(({ axis, sign, dir }) => {
      const tip = worldCenter.clone().addScaledVector(new THREE.Vector3(...dir), arrowOffset);
      const ndc = tip.clone().project(camera);
      const x = rect.left + (ndc.x + 1) / 2 * w;
      const y = rect.top + (1 - ndc.y) / 2 * h;
      const behind = ndc.z > 1;
      return { axis, sign, x, y, behind };
    });
    setArrowPositions(positions);
  });

  // Clear positions when unmounted
  useEffect(() => () => { setArrowPositions([]); }, []);

  return null;
};

// ── HTML arrow button ─────────────────────────────────────────────────────────
const ArrowButton: React.FC<{ ap: ArrowPos; onSelect: (axis: AxisKey) => void }> = ({ ap, onSelect }) => {
  const [hovered, setHovered] = useState(false);
  if (ap.behind) return null;
  const color = AXIS_COLORS[ap.axis];
  const label = `${ap.axis}${ap.sign > 0 ? '+' : '−'}`;
  return (
    <button
      onPointerEnter={() => { setHovered(true); document.body.style.cursor = 'pointer'; }}
      onPointerLeave={() => { setHovered(false); document.body.style.cursor = 'default'; }}
      onPointerDown={e => { e.stopPropagation(); e.preventDefault(); onSelect(ap.axis); }}
      style={{
        position: 'fixed', left: ap.x, top: ap.y, transform: 'translate(-50%, -50%)',
        zIndex: 8888, width: 46, height: 46, borderRadius: '50%',
        border: `2.5px solid ${color}`,
        background: hovered ? color : 'rgba(255,255,255,0.95)',
        color: hovered ? '#fff' : color,
        fontSize: 11, fontWeight: 800, fontFamily: 'monospace', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: hovered
          ? `0 4px 16px ${color}66, 0 0 0 3px ${color}33`
          : `0 2px 10px rgba(0,0,0,0.2), 0 0 0 1px ${color}22`,
        transition: 'background 0.1s, color 0.1s, box-shadow 0.1s',
        pointerEvents: 'all', userSelect: 'none', lineHeight: 1,
      }}
      title={`${ap.axis} ekseninde taşı`}
    >{label}</button>
  );
};

// ── Pure-HTML component: lives OUTSIDE Canvas, reads from module-level store ──
export const PanelMoveArrowsHtml: React.FC = () => {
  const { activeTool, panelMoveTargetId, setPanelMoveActiveAxis, setPanelMoveTargetId } = useAppStore(
    useShallow(s => ({
      activeTool: s.activeTool,
      panelMoveTargetId: s.panelMoveTargetId,
      setPanelMoveActiveAxis: s.setPanelMoveActiveAxis,
      setPanelMoveTargetId: s.setPanelMoveTargetId,
    }))
  );

  const positions = useArrowPositions();
  const active = useActiveMoveAxis();
  const isActive = activeTool === Tool.MOVE && !!panelMoveTargetId;

  const handleSelect = useCallback((axis: AxisKey) => {
    if (!panelMoveTargetId) return;
    setPanelMoveActiveAxis(axis);
    setActiveMoveAxis({ panelId: panelMoveTargetId, axis });
  }, [panelMoveTargetId, setPanelMoveActiveAxis]);

  const handleDone = useCallback(() => {
    setActiveMoveAxis(null);
    setPanelMoveTargetId(null);
  }, [setPanelMoveTargetId]);

  if (!isActive) return null;

  return (
    <>
      {/* Arrow buttons — hidden while input panel is open */}
      {!active && positions.length > 0 && createPortal(
        <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 8888 }}>
          {positions.map(ap => (
            <ArrowButton key={`${ap.axis}${ap.sign}`} ap={ap} onSelect={handleSelect} />
          ))}
        </div>,
        document.body
      )}

      {/* Input panel after axis selected */}
      {active && (
        <PanelMoveInputPanel
          key={`${active.panelId}-${active.axis}`}
          axis={active.axis}
          panelId={active.panelId}
          onDone={handleDone}
        />
      )}
    </>
  );
};

// ── Legacy export kept for any remaining references ───────────────────────────
export const PanelMoveInputOverlay: React.FC = () => {
  const { activeTool } = useAppStore(useShallow(s => ({ activeTool: s.activeTool })));
  const active = useActiveMoveAxis();
  if (activeTool !== Tool.MOVE || !active) return null;
  return (
    <PanelMoveInputPanel
      key={`${active.panelId}-${active.axis}`}
      axis={active.axis}
      panelId={active.panelId}
      onDone={() => setActiveMoveAxis(null)}
    />
  );
};
