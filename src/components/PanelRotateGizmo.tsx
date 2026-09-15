import { useState, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { GizmoDot, computeRealCorners, panelWorldMatrix, resolveDotOverlap } from './GizmoDot';
import { useFrame } from '@react-three/fiber';
import { useAppStore } from '../store';
import type { Shape } from '../store';

const RENDER_ORDER = 999;

// Pivot noktaları: GizmoDot (taşıma referans noktalarıyla ORTAK tasarım/davranış).

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
  const anySelected = selectedAxis !== null;
  const colors = AXIS_COLORS[axis];

  const { geometry, eulerRotation, labelPos } = useMemo(() => {
    const segments = 64;
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      points.push(new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, 0));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(points);

    // Circle is drawn in XY plane (normal = Z).
    // X ring: perpendicular to X -> lies in YZ plane -> rotate 90 around Y
    // Y ring: perpendicular to Y -> lies in XZ plane -> rotate 90 around X
    // Z ring: perpendicular to Z -> lies in XY plane -> no rotation
    let euler: THREE.Euler;
    let lPos: [number, number, number];
    if (axis === 'x') {
      euler = new THREE.Euler(0, Math.PI / 2, 0);
      lPos = [center[0], center[1], center[2] + radius + 10];
    } else if (axis === 'y') {
      euler = new THREE.Euler(Math.PI / 2, 0, 0);
      lPos = [center[0] + radius + 10, center[1], center[2]];
    } else {
      euler = new THREE.Euler(0, 0, 0);
      lPos = [center[0], center[1] + radius + 10, center[2]];
    }

    return { geometry: geo, eulerRotation: euler, labelPos: lPos };
  }, [center, axis, radius]);

  // Seçili: tam opak, canlı kendi rengi. Hover: belirginleş. Başka eksen
  // seçiliyken bu halka: soluk. Hiçbiri seçili değilken: normal.
  const lineColor = isSelected ? colors.main : hovered ? colors.hover : colors.main;
  const lineOpacity = isSelected ? 1 : hovered ? 0.95 : anySelected ? 0.16 : 0.62;

  const lineObj = useMemo(() => {
    const mat = new THREE.LineBasicMaterial({
      color: lineColor,
      transparent: true,
      opacity: lineOpacity,
      depthTest: false,
    });
    const line = new THREE.Line(geometry, mat);
    line.position.set(center[0], center[1], center[2]);
    line.rotation.copy(eulerRotation);
    line.renderOrder = RENDER_ORDER;
    return line;
  }, [geometry, lineColor, lineOpacity, center, eulerRotation]);

  const labelDimmed = anySelected && !isSelected && !hovered;
  const rot: [number, number, number] = [eulerRotation.x, eulerRotation.y, eulerRotation.z];

  return (
    <group>
      {/* Seçili dönme düzlemini dolduran yarı saydam disk — hangi düzlemin
          aktif olduğunu net gösterir */}
      {isSelected && (
        <mesh position={center} rotation={rot} renderOrder={RENDER_ORDER - 1}>
          <circleGeometry args={[radius, 64]} />
          <meshBasicMaterial
            color={colors.main}
            transparent
            opacity={0.15}
            depthTest={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      <primitive object={lineObj} />

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
            boxShadow: isSelected ? '0 1px 6px rgba(0,0,0,0.28)' : 'none',
            textShadow: isSelected ? 'none' : '0 0 4px #fff, 0 0 8px #fff',
            opacity: labelDimmed ? 0.4 : 1,
            transition: 'opacity 0.12s ease',
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

const computeCorners = computeRealCorners;

// Orta noktalar — gerçek köşelerden kalınlık yönünü bulup iki geniş yüzün merkezini hesaplar.
function computeFaceCenters(panelShape: Shape): [number, number, number][] {
  if (!panelShape.geometry) return [];
  const pos = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return [];

  const seen = new Map<string, THREE.Vector3>();
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
    const key = `${Math.round(v.x * 100)},${Math.round(v.y * 100)},${Math.round(v.z * 100)}`;
    if (!seen.has(key)) seen.set(key, v);
  }
  const corners = [...seen.values()];
  if (corners.length < 8) return [];

  let minD = Infinity;
  const thickDir = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < corners.length; i++) {
    for (let j = i + 1; j < corners.length; j++) {
      const d = corners[i].distanceTo(corners[j]);
      if (d > 0.01 && d < minD) { minD = d; thickDir.copy(corners[j]).sub(corners[i]).normalize(); }
    }
  }

  const projs = corners.map(c => c.dot(thickDir));
  const mid = (Math.min(...projs) + Math.max(...projs)) / 2;
  const g1: THREE.Vector3[] = [], g2: THREE.Vector3[] = [];
  for (let i = 0; i < corners.length; i++) {
    (projs[i] <= mid ? g1 : g2).push(corners[i]);
  }
  const avg = (pts: THREE.Vector3[]) => {
    const c = new THREE.Vector3();
    for (const p of pts) c.add(p);
    return c.divideScalar(pts.length || 1);
  };

  const mat = panelWorldMatrix(panelShape);
  return [avg(g1), avg(g2)].map(p => {
    const w = p.clone().applyMatrix4(mat);
    return [w.x, w.y, w.z] as [number, number, number];
  });
}

interface PanelRotateGizmoProps {
  panelShape: Shape;
}

const eq = (a: [number, number, number] | null, b: [number, number, number]) =>
  !!a && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

type PivotKind = 'vertex' | 'center';
interface PivotEntry { pos: [number, number, number]; kind: PivotKind }

export function PanelRotateGizmo({ panelShape }: PanelRotateGizmoProps) {
  const {
    panelRotatePivot, setPanelRotatePivot,
    setPanelRotatePivotType,
    panelRotateAxis, setPanelRotateAxis,
  } = useAppStore();

  const hasPivot = panelRotatePivot !== null;

  const pivots = useMemo<PivotEntry[]>(() => {
    const corners = computeCorners(panelShape).map(p => ({ pos: p, kind: 'vertex' as const }));
    const centers = computeFaceCenters(panelShape).map(p => ({ pos: p, kind: 'center' as const }));
    return [...corners, ...centers];
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

  // ── Çakışan noktalar: yalnız TAM üst üste binenler gizlenir (GizmoDot) ──
  const markRefs = useRef<(THREE.Group | null)[]>([]);
  const tmpVec = useRef(new THREE.Vector3());
  useFrame(({ camera, size }) => {
    resolveDotOverlap(camera, size,
      pivots.map(pv => ({ pos: pv.pos, group: 0 })),
      i => eq(panelRotatePivot, pivots[i].pos),
      markRefs.current, tmpVec.current);
  });

  const handlePivotSelect = (point: [number, number, number], kind: PivotKind) => {
    setPanelRotatePivot(point);
    setPanelRotatePivotType(kind);
    setPanelRotateAxis(null);
  };

  const handleAxisSelect = (axis: 'x' | 'y' | 'z') => {
    setPanelRotateAxis(axis === panelRotateAxis ? null : axis);
  };

  return (
    <group>
      {/* Köşe (8) + üst/alt yüz merkezi (2) — hepsi aynı mavi çarpı işareti */}
      {pivots.map((pv, i) => (
        <GizmoDot
          key={`pivot-${i}`}
          position={pv.pos}
          groupRef={el => { markRefs.current[i] = el; }}
          onClick={() => handlePivotSelect(pv.pos, pv.kind)}
          isSelected={eq(panelRotatePivot, pv.pos)}
          accent={pv.kind === 'center' ? '#ea580c' : '#44403c'}
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
