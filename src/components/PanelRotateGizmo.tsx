import { useState, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useAppStore } from '../store';
import type { Shape } from '../store';

const RENDER_ORDER = 999;

// ── Pivot işareti — kameraya dönük, sabit piksel boyutlu mavi çarpı (×) ──
// 3B mesh yerine Html içine SVG gömülür: her zaman keskin/anti-aliased,
// daima aynı boyutta ve daima kameraya bakar. innerRef, ebeveynin üst üste
// binen işaretleri piksel bazında ayırabilmesi (fan-out) için kullanılır.
interface PivotMarkProps {
  position: [number, number, number];
  onSelect: () => void;
  isSelected: boolean;
  innerRef?: (el: HTMLDivElement | null) => void;
}

function PivotMark({ position, onSelect, isSelected, innerRef }: PivotMarkProps) {
  const [hovered, setHovered] = useState(false);
  const active = hovered || isSelected;

  const stroke = isSelected ? '#1d4ed8' : hovered ? '#3b82f6' : '#2563eb';
  const px = active ? 20 : 16;
  const sw = active ? 2.4 : 2;

  return (
    <Html position={position} center zIndexRange={[999, 1000]} style={{ pointerEvents: 'none' }}>
      <div
        ref={innerRef}
        onClick={e => { e.stopPropagation(); onSelect(); }}
        onMouseEnter={() => { setHovered(true); document.body.style.cursor = 'pointer'; }}
        onMouseLeave={() => { setHovered(false); document.body.style.cursor = 'default'; }}
        style={{
          pointerEvents: 'auto',
          cursor: 'pointer',
          width: 26,
          height: 26,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          willChange: 'transform',
        }}
      >
        <svg
          width={px}
          height={px}
          viewBox="0 0 24 24"
          fill="none"
          style={{
            display: 'block',
            transition: 'width 0.12s ease, height 0.12s ease',
            filter: 'drop-shadow(0 0 1.5px rgba(255,255,255,0.9))',
          }}
        >
          {isSelected && (
            <circle cx="12" cy="12" r="10" fill="rgba(37,99,235,0.12)" stroke={stroke} strokeWidth="1.1" />
          )}
          <line x1="7" y1="7" x2="17" y2="17" stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
          <line x1="17" y1="7" x2="7" y2="17" stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
        </svg>
      </div>
    </Html>
  );
}

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

// Yerel bbox + dünya matrisi yardımcıları ──────────────────────────────
function panelWorldMatrix(panelShape: Shape): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...panelShape.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...panelShape.rotation, 'XYZ')),
    new THREE.Vector3(...panelShape.scale)
  );
}

// 8 köşe (üst yüz 4 + alt yüz 4) — mesh köşeleri değil, temiz bbox köşeleri.
function computeCorners(panelShape: Shape): [number, number, number][] {
  if (!panelShape.geometry) return [];
  const pos = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return [];

  const bbox = new THREE.Box3().setFromBufferAttribute(pos);
  const { min, max } = bbox;

  const corners = [
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, min.z),
    new THREE.Vector3(max.x, max.y, min.z),
    new THREE.Vector3(min.x, max.y, min.z),
    new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(max.x, max.y, max.z),
    new THREE.Vector3(min.x, max.y, max.z),
  ];

  const mat = panelWorldMatrix(panelShape);
  return corners.map(c => {
    const w = c.applyMatrix4(mat);
    return [w.x, w.y, w.z] as [number, number, number];
  });
}

// Orta noktalar — en ince eksene dik olan iki büyük yüzün (üst + alt) merkezi.
function computeFaceCenters(panelShape: Shape): [number, number, number][] {
  if (!panelShape.geometry) return [];
  const pos = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return [];

  const bbox = new THREE.Box3().setFromBufferAttribute(pos);
  const size = new THREE.Vector3(); bbox.getSize(size);
  const center = new THREE.Vector3(); bbox.getCenter(center);

  // En ince eksen = kalınlık; ona dik yüzler büyük yüzlerdir.
  const dims = [size.x, size.y, size.z];
  const thin = dims.indexOf(Math.min(...dims));
  const minC = [bbox.min.x, bbox.min.y, bbox.min.z][thin];
  const maxC = [bbox.max.x, bbox.max.y, bbox.max.z][thin];

  const top = center.clone(); top.setComponent(thin, maxC);
  const bot = center.clone(); bot.setComponent(thin, minC);

  const mat = panelWorldMatrix(panelShape);
  return [top, bot].map(p => {
    const w = p.applyMatrix4(mat);
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

  // ── Ekran-uzayı çakışma çözümü (fan-out) ─────────────────────────────
  // Üst üste binen işaretler her karede birkaç piksel ayrılır; böylece ince
  // panellerde ön/arka köşe işaretleri ayrı ayrı tıklanabilir.
  const markRefs = useRef<(HTMLDivElement | null)[]>([]);
  const tmpVec = useRef(new THREE.Vector3());

  useFrame(({ camera, size }) => {
    const n = pivots.length;
    if (!n) return;

    const sx = new Array<number>(n);
    const sy = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const v = tmpVec.current.set(pivots[i].pos[0], pivots[i].pos[1], pivots[i].pos[2]).project(camera);
      sx[i] = (v.x * 0.5 + 0.5) * size.width;
      sy[i] = (1 - (v.y * 0.5 + 0.5)) * size.height;
    }

    const dx = new Array<number>(n).fill(0);
    const dy = new Array<number>(n).fill(0);
    const MIN = 24; // işaret ayırma mesafesi (px)

    for (let pass = 0; pass < 4; pass++) {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let vx = (sx[j] + dx[j]) - (sx[i] + dx[i]);
          let vy = (sy[j] + dy[j]) - (sy[i] + dy[i]);
          let d = Math.hypot(vx, vy);
          if (d < MIN) {
            if (d < 1e-3) {
              // Tam çakışık: altın açıyla deterministik yönde aç
              const a = i * 2.399963;
              vx = Math.cos(a); vy = Math.sin(a); d = 1;
            }
            const push = (MIN - d) / 2;
            const ux = vx / d, uy = vy / d;
            dx[i] -= ux * push; dy[i] -= uy * push;
            dx[j] += ux * push; dy[j] += uy * push;
          }
        }
      }
    }

    const els = markRefs.current;
    for (let i = 0; i < n; i++) {
      const el = els[i];
      if (el) el.style.transform = `translate(${dx[i].toFixed(2)}px, ${dy[i].toFixed(2)}px)`;
    }
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
        <PivotMark
          key={`pivot-${i}`}
          position={pv.pos}
          innerRef={el => { markRefs.current[i] = el; }}
          onSelect={() => handlePivotSelect(pv.pos, pv.kind)}
          isSelected={eq(panelRotatePivot, pv.pos)}
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
