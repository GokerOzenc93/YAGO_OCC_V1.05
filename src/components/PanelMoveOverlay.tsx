import React, { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore, Tool } from '../store';
import { useShallow } from 'zustand/react/shallow';

// Axis key as reported by TransformControls .axis property
// 'X' | 'Y' | 'Z' | 'XY' | 'XZ' | 'YZ' | 'XYZ' — we only care about single axes
type AxisKey = 'X' | 'Y' | 'Z';

const AXIS_COLORS: Record<AxisKey, string> = {
  X: '#ef4444',
  Y: '#22c55e',
  Z: '#3b82f6',
};

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

    const currentPos = panel.position as [number, number, number];
    const newPos: [number, number, number] = [
      currentPos[0] + delta[0],
      currentPos[1] + delta[1],
      currentPos[2] + delta[2],
    ];

    const currentOffset = panel.parameters?.panelOffset as [number, number, number] | undefined;
    const newOffset: [number, number, number] = currentOffset
      ? [currentOffset[0] + delta[0], currentOffset[1] + delta[1], currentOffset[2] + delta[2]]
      : delta;

    updateShape(panelId, {
      position: newPos,
      parameters: { ...panel.parameters, panelOffset: newOffset },
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
        position: 'fixed',
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 14px',
        background: 'linear-gradient(180deg,rgba(250,248,244,0.95),rgba(239,235,227,0.97))',
        backdropFilter: 'blur(16px) saturate(160%)',
        WebkitBackdropFilter: 'blur(16px) saturate(160%)',
        border: '1px solid rgba(60,50,40,0.15)',
        borderRadius: 10,
        boxShadow: '0 8px 28px -6px rgba(40,30,20,0.28),0 0 0 0.5px rgba(60,50,40,0.06),inset 0 1px 0 rgba(255,255,255,0.90)',
        fontFamily: "'Inter','SF Pro Text',system-ui,sans-serif",
        minWidth: 280,
        pointerEvents: 'all',
      }}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    >
      {/* Axis badge */}
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 22, height: 22, borderRadius: 5, flexShrink: 0,
        background: axisColor, color: '#fff',
        fontSize: 11, fontWeight: 800, fontFamily: 'monospace',
        boxShadow: `0 1px 3px ${axisColor}66`,
      }}>
        {axis}
      </span>

      {/* Label */}
      <span style={{ fontSize: 11, color: '#78716c', fontWeight: 500, flexShrink: 0 }}>
        Mesafe (mm)
      </span>

      {/* Input */}
      <input
        ref={inputRef}
        type="number"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="0"
        style={{
          flex: 1,
          height: 28,
          textAlign: 'center',
          fontFamily: 'monospace',
          fontSize: 13,
          fontWeight: 600,
          color: '#1c1917',
          background: 'linear-gradient(180deg,#fff,#faf8f3)',
          border: '1px solid rgba(60,50,40,0.16)',
          borderRadius: 7,
          outline: 'none',
          boxShadow: 'inset 0 1px 2px rgba(40,30,20,0.06)',
          minWidth: 0,
        }}
        autoFocus
      />

      {/* Apply */}
      <button
        onClick={apply}
        style={{
          flexShrink: 0, height: 28, padding: '0 12px', borderRadius: 7, border: 'none',
          cursor: 'pointer', outline: 'none',
          background: 'linear-gradient(180deg,#5b5346,#44403c)',
          color: '#fff', fontSize: 12, fontWeight: 700,
          boxShadow: '0 1px 2px rgba(40,30,20,0.25),inset 0 1px 0 rgba(255,255,255,0.18)',
        }}
      >
        Uygula
      </button>

      {/* Cancel */}
      <button
        onClick={onDone}
        style={{
          flexShrink: 0, height: 28, width: 28, borderRadius: 7,
          border: '1px solid rgba(60,50,40,0.14)', cursor: 'pointer',
          background: 'rgba(120,113,108,0.07)',
          color: '#78716c', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        ✕
      </button>
    </div>,
    document.body
  );
};

// ── State for active move axis (shared between PanelDrawing and overlay) ────
// Stored in a simple module-level mutable so it survives re-renders without
// adding noise to the global Zustand store.
let _activeMoveAxis: { panelId: string; axis: AxisKey } | null = null;
const _listeners = new Set<() => void>();

export function setActiveMoveAxis(v: { panelId: string; axis: AxisKey } | null) {
  _activeMoveAxis = v;
  _listeners.forEach(fn => fn());
}

export function useActiveMoveAxis() {
  const [val, setVal] = useState(_activeMoveAxis);
  useEffect(() => {
    const fn = () => setVal(_activeMoveAxis);
    _listeners.add(fn);
    return () => { _listeners.delete(fn); };
  }, []);
  return val;
}

// ── Main export: renders the floating input panel when an axis is active ────
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
