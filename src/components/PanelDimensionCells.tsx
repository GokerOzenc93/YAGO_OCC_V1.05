import React from 'react';

export const AXIS_COLORS = {
  x: { text: '#b91c1c', bg: '#fef2f2', border: '#fca5a5' },
  y: { text: '#15803d', bg: '#f0fdf4', border: '#86efac' },
  z: { text: '#1d4ed8', bg: '#eff6ff', border: '#93c5fd' },
  none: { text: '#6b7280', bg: '#ffffff', border: '#d1d5db' },
} as const;

type AxisKey = 'x' | 'y' | 'z' | 'none';

interface DimensionSet {
  primary: number;
  secondary: number;
  thickness: number;
  w: number;
  h: number;
  d: number;
}

function getAxisKey(value: number, dims: DimensionSet): AxisKey {
  if (value === dims.w) return 'x';
  if (value === dims.h) return 'y';
  if (value === dims.d) return 'z';
  return 'none';
}

interface PanelDimensionCellsProps {
  dimensions: DimensionSet | null;
  onClick?: (e: React.MouseEvent) => void;
}

export function PanelDimensionCells({ dimensions, onClick }: PanelDimensionCellsProps) {
  const renderCell = (value: number | string, axis: AxisKey, title: string) => {
    const c = AXIS_COLORS[axis];
    return (
      <input
        type="text"
        value={typeof value === 'number' ? value : value}
        readOnly
        tabIndex={-1}
        onClick={onClick}
        title={title}
        style={{
          color: c.text,
          backgroundColor: c.bg,
          borderColor: c.border,
        }}
        className="w-[48px] px-1 py-0.5 text-xs font-mono font-semibold border rounded text-center"
      />
    );
  };

  if (!dimensions) {
    return (
      <>
        {renderCell('NaN', 'none', 'Arrow Direction Dimension')}
        {renderCell('NaN', 'none', 'Perpendicular to Arrow Direction')}
        {renderCell('NaN', 'none', 'Panel Thickness')}
      </>
    );
  }

  const primaryAxis = getAxisKey(dimensions.primary, dimensions);
  const secondaryAxis = getAxisKey(dimensions.secondary, dimensions);
  const thicknessAxis = getAxisKey(dimensions.thickness, dimensions);

  return (
    <>
      {renderCell(dimensions.primary, primaryAxis, `Arrow Direction (${primaryAxis.toUpperCase()})`)}
      {renderCell(dimensions.secondary, secondaryAxis, `Perpendicular (${secondaryAxis.toUpperCase()})`)}
      {renderCell(dimensions.thickness, thicknessAxis, `Thickness (${thicknessAxis.toUpperCase()})`)}
    </>
  );
}
