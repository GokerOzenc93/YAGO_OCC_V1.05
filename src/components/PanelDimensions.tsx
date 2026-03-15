import React from 'react';

interface PanelDimensionsProps {
  w: number | undefined;
  h: number | undefined;
  d: number | undefined;
  onClick?: (e: React.MouseEvent) => void;
}

const AXIS_STYLES = {
  x: {
    label: 'X',
    border: 'border-red-400',
    bg: 'bg-red-50',
    text: 'text-red-700',
    labelColor: 'text-red-500',
  },
  y: {
    label: 'Y',
    border: 'border-green-500',
    bg: 'bg-green-50',
    text: 'text-green-700',
    labelColor: 'text-green-500',
  },
  z: {
    label: 'Z',
    border: 'border-blue-400',
    bg: 'bg-blue-50',
    text: 'text-blue-700',
    labelColor: 'text-blue-500',
  },
};

interface AxisCellProps {
  axis: 'x' | 'y' | 'z';
  value: number | undefined;
  title: string;
  onClick?: (e: React.MouseEvent) => void;
}

function AxisCell({ axis, value, title, onClick }: AxisCellProps) {
  const styles = AXIS_STYLES[axis];
  return (
    <div
      className={`flex items-center gap-0.5 w-[58px] rounded border ${styles.border} ${styles.bg} px-1 py-0.5`}
      title={title}
      onClick={onClick}
    >
      <span className={`text-[9px] font-bold leading-none ${styles.labelColor}`}>{styles.label}</span>
      <span className={`text-xs font-mono font-semibold leading-none ${styles.text} flex-1 text-right`}>
        {value !== undefined && !isNaN(value) ? value : 'NaN'}
      </span>
    </div>
  );
}

export function PanelDimensions({ w, h, d, onClick }: PanelDimensionsProps) {
  return (
    <div className="flex items-center gap-0.5" onClick={onClick}>
      <AxisCell axis="x" value={w} title="X (Width)" onClick={onClick} />
      <AxisCell axis="y" value={h} title="Y (Height)" onClick={onClick} />
      <AxisCell axis="z" value={d} title="Z (Depth / Thickness)" onClick={onClick} />
    </div>
  );
}
