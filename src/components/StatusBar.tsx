import React from 'react';
import { useAppStore } from '../store';

/* ─── Design tokens (toolbar ile birebir uyumlu) ─── */
const T = {
  bg:        'linear-gradient(180deg,#faf9f6 0%,#f4f2ee 100%)',
  border:    '#e4dfd7',
  topShine:  'inset 0 1px 0 rgba(255,255,255,0.7)',
  labelClr:  '#9c9590',
  valueClr:  '#292524',
  accentClr: '#d9540a',
  infoClr:   '#0369a1',
  modClr:    '#7c3aed',
  divider:   'linear-gradient(to bottom,transparent,rgba(60,50,40,0.14) 30%,rgba(60,50,40,0.14) 70%,transparent)',
};

const Pair: React.FC<{ label: string; value: React.ReactNode; valueColor?: string; mono?: boolean }> = ({
  label, value, valueColor = T.valueClr, mono = false,
}) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
    <span style={{
      color: T.labelClr, fontSize: '11px', fontWeight: 420,
      letterSpacing: '0.04em', textTransform: 'uppercase',
    }}>
      {label}
    </span>
    <span style={{
      color: valueColor, fontSize: '11.5px', fontWeight: 540,
      letterSpacing: mono ? '0.02em' : '-0.005em',
      fontFamily: mono
        ? "'SF Mono','Fira Code','Cascadia Code',monospace"
        : "'Inter',system-ui,sans-serif",
    }}>
      {value}
    </span>
  </div>
);

const Sep = () => (
  <div style={{ width: '1px', height: '14px', flexShrink: 0, background: T.divider }} />
);

const StatusBar: React.FC = () => {
  const { shapes, selectedShapeId, vertexEditMode, selectedVertexIndex } = useAppStore();
  const selectedShape = shapes.find(s => s.id === selectedShapeId);
  const vertexModCount = selectedShape?.vertexModifications?.length || 0;

  return (
    <div
      className="absolute left-0 right-0 z-20"
      style={{
        bottom: '38px',
        height: '26px',
        display: 'flex',
        alignItems: 'center',
        padding: '0 14px',
        gap: '10px',
        background: T.bg,
        borderTop: `1px solid ${T.border}`,
        boxShadow: T.topShine,
        fontFamily: "'Inter','SF Pro Text',system-ui,sans-serif",
      }}
    >
      {/* Live status dot */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
        <span style={{
          width: '6px', height: '6px', borderRadius: '50%',
          background: '#10b981',
          boxShadow: '0 0 0 2.5px rgba(16,185,129,0.18),0 0 4px rgba(16,185,129,0.4)',
        }} />
        <span style={{
          color: '#047857', fontSize: '11px', fontWeight: 540,
          letterSpacing: '0.04em', textTransform: 'uppercase',
        }}>
          Ready
        </span>
      </div>

      <Sep />

      <Pair label="Nesne" value={shapes.length} mono />

      <Sep />

      <Pair
        label="Seçili"
        value={selectedShape ? `${selectedShape.type} · ${selectedShape.id.slice(0, 8)}` : '—'}
        valueColor={selectedShape ? T.accentClr : '#b0aaa4'}
        mono={!!selectedShape}
      />

      {selectedShape && (
        <>
          <Sep />
          <Pair
            label="Konum"
            value={`[${selectedShape.position.map(v => v.toFixed(1)).join(', ')}]`}
            mono
          />
        </>
      )}

      {vertexEditMode && (
        <>
          <Sep />
          <Pair
            label="Vertex Edit"
            value={selectedVertexIndex !== null ? `V${selectedVertexIndex}` : 'Aktif'}
            valueColor={T.infoClr}
            mono
          />
        </>
      )}

      {vertexModCount > 0 && (
        <>
          <Sep />
          <Pair label="Mod" value={vertexModCount} valueColor={T.modClr} mono />
        </>
      )}

      {/* Right side — coordinate hint */}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
        <span style={{
          color: T.labelClr, fontSize: '10.5px', fontWeight: 420,
          letterSpacing: '0.05em', textTransform: 'uppercase',
        }}>
          mm
        </span>
        <Sep />
        <span style={{
          color: '#6b6560', fontSize: '11px', fontWeight: 500,
          fontFamily: "'SF Mono','Fira Code',monospace", letterSpacing: '0.02em',
        }}>
          YAGO v1.0
        </span>
      </div>
    </div>
  );
};

export default StatusBar;
