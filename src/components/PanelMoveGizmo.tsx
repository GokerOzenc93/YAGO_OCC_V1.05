import { useState, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useAppStore } from '../store';
import type { Shape } from '../store';

const RENDER_ORDER = 999;
const GAP_RATIO = 0.08;

// ── EKRAN-ÖLÇEĞİ KİLİDİ ───────────────────────────────────────────────────
// İSTEK (Goker): "okları belli bir uzaklıktan sonra bir ölçüde tut; yaklaşınca
// da çok büyük olmasın, belli bir yaklaşmadan sonra bir ölçüde kalsın."
// Ok uzunluğu panelin ölçüsüne bağlı SABİT dünya boyutuydu → uzakta iğne,
// yakında devasa görünüyordu. Artık iki kilit arasında EKRANDA SABİT boy
// hedeflenir; kilitlerin dışında dünya ölçüsü DONAR:
//   • yakınlaşınca  → ölçek MIN_SCALE'e oturur, ok daha fazla büyümez
//   • uzaklaşınca   → ölçek MAX_SCALE'e oturur, ok daha fazla küçülmez
// Aradaki bantta ok ekranda ~TARGET_PX uzunluğunda kalır.
// Kilit değerleri, ok TABAN uzunluğuna (panel en büyük ölçüsü × 0.2) orandır.
// 600 mm'lik bir panelde taban 120 mm; 45° fov / ~800 px yükseklikte:
//   yakın (≈500 mm)  → ölçek 0.45'e oturur → ok ~54 mm, ekranda ~93 px
//   orta  (≈1500 mm) → ekranda sabit ~56 px
//   uzak  (≈6000 mm) → ölçek 2.2'ye oturur → ok ~264 mm, ekranda ~38 px
const TARGET_PX = 56;
const MIN_SCALE = 0.45;
const MAX_SCALE = 2.20;

/** Dünya biriminde "1 CSS pikselin karşılığı" — perspektif ve ortografik için. */
function worldPerPixel(camera: THREE.Camera, viewportHeight: number, worldPos: THREE.Vector3): number {
  const persp = camera as THREE.PerspectiveCamera;
  if (persp.isPerspectiveCamera) {
    const dist = persp.position.distanceTo(worldPos);
    return (2 * Math.tan(((persp.fov * Math.PI) / 180) / 2) * dist) / Math.max(viewportHeight, 1);
  }
  const ortho = camera as THREE.OrthographicCamera;
  const span = (ortho.top - ortho.bottom) / (ortho.zoom || 1);
  return span / Math.max(viewportHeight, 1);
}

/** Verilen grubu, taban uzunluğuna göre ekran-ölçeğine kilitler. */
function useScreenLockedScale(
  ref: React.RefObject<THREE.Group | THREE.Mesh>,
  baseLength: number,
) {
  const wp = useRef(new THREE.Vector3());
  useFrame(({ camera, size }) => {
    const o = ref.current;
    if (!o || baseLength <= 0) return;
    o.getWorldPosition(wp.current);
    const desired = TARGET_PX * worldPerPixel(camera, size.height, wp.current);
    const s = THREE.MathUtils.clamp(desired / baseLength, MIN_SCALE, MAX_SCALE);
    o.scale.setScalar(s);
  });
}

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
  const groupRef = useRef<THREE.Group>(null);
  // Ölçek kilidi grubun KENDİSİNE uygulanır; grup okun tabanına (origin)
  // oturduğu için ok her ölçekte panele yapışık kalır, merkeze doğru kaymaz.
  useScreenLockedScale(groupRef, length);

  // ── İNCE / KESKİN ORAN ──────────────────────────────────────────────────
  // Eski oranlar (gövde 0.055, koni tabanı 0.16, koni boyu 0.36) tombul ve
  // "yuvarlak" duruyordu. CAD gizmolarının okuması kolay ince gövde + uzun,
  // dar uç oranına çekildi; segment sayıları da artırıldı ki silüet pürüzsüz
  // olsun (kalın az-kenarlı koni köşeli/yuvarlak karışımı görünüyordu).
  const shaftRadius = length * 0.026;
  const coneRadius = length * 0.078;
  const coneHeight = length * 0.24;
  const shaftLength = length - coneHeight;

  const rotation = useMemo(() => {
    const dir = new THREE.Vector3(...direction).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);
    const euler = new THREE.Euler().setFromQuaternion(quat);
    return [euler.x, euler.y, euler.z] as [number, number, number];
  }, [direction]);

  // Konumlar artık GRUBA GÖRE yereldir (grup origin'de durur) — ölçek
  // uygulandığında ok tabanından uca doğru büyür/küçülür.
  const shaftCenter: [number, number, number] = [
    direction[0] * (shaftLength / 2),
    direction[1] * (shaftLength / 2),
    direction[2] * (shaftLength / 2),
  ];

  const coneCenter: [number, number, number] = [
    direction[0] * (shaftLength + coneHeight / 2),
    direction[1] * (shaftLength + coneHeight / 2),
    direction[2] * (shaftLength + coneHeight / 2),
  ];

  const labelPos: [number, number, number] = [
    direction[0] * (length + length * 0.20),
    direction[1] * (length + length * 0.20),
    direction[2] * (length + length * 0.20),
  ];

  // SOFT YÜZEY: yüksek metalness + düşük roughness parlak plastik gibi
  // duruyordu. Mat, hafif dağınık bir yüzeye çekildi; seçilide beyaz yerine
  // rengin açık tonu kullanılır (beyaz, açık zeminde okun silüetini yiyordu).
  const activeColor = isSelected ? hoverColor : hovered ? hoverColor : color;
  const emissiveColor = new THREE.Color(isSelected || hovered ? color : 0x000000);
  const emissiveInt = isSelected ? 0.55 : hovered ? 0.35 : 0.06;
  const opacity = isSelected || hovered ? 1 : 0.88;

  const matProps = {
    color: activeColor,
    transparent: true,
    opacity,
    depthTest: false,
    emissive: emissiveColor,
    emissiveIntensity: emissiveInt,
    roughness: 0.62,
    metalness: 0.04,
  };

  const handleLabelClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(axisLabel);
  };
  const handleLabelEnter = () => { setHovered(true); document.body.style.cursor = 'pointer'; };
  const handleLabelLeave = () => { setHovered(false); document.body.style.cursor = 'default'; };

  return (
    <group ref={groupRef} position={origin}>
      <mesh position={shaftCenter} rotation={rotation} renderOrder={RENDER_ORDER}>
        <cylinderGeometry args={[shaftRadius, shaftRadius, shaftLength, 24]} />
        <meshStandardMaterial {...matProps} />
      </mesh>

      <mesh position={coneCenter} rotation={rotation} renderOrder={RENDER_ORDER}>
        <coneGeometry args={[coneRadius, coneHeight, 32]} />
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
            // SOFT ETİKET: kalın 900 + beyaz halo yerine, hafif buzlu bir hap
            // ve orta kalınlık. Seçilide rengin kendisi dolgu olur.
            background: isSelected ? color : 'rgba(252,251,249,0.82)',
            color: isSelected ? '#fff' : '#57534e',
            fontFamily: '"Inter", "SF Pro Display", system-ui, sans-serif',
            fontSize: '11px',
            fontWeight: 650,
            letterSpacing: '0.04em',
            padding: '2px 6px',
            borderRadius: '5px',
            border: `1px solid ${isSelected ? 'transparent' : 'rgba(60,50,40,0.10)'}`,
            boxShadow: isSelected ? '0 1px 3px rgba(40,30,20,0.22)' : '0 1px 2px rgba(40,30,20,0.08)',
            backdropFilter: 'blur(3px)',
            WebkitBackdropFilter: 'blur(3px)',
            userSelect: 'none',
            whiteSpace: 'nowrap',
            lineHeight: '1.35',
            minWidth: '24px',
            textAlign: 'center',
            transition: 'background 0.12s, color 0.12s',
          }}
        >
          {AXIS_DISPLAY[axisLabel]}
        </div>
      </Html>
    </group>
  );
}

function OriginSphere({ position, size, baseLength }: { position: [number, number, number]; size: number; baseLength: number }) {
  const ref = useRef<THREE.Mesh>(null);
  // Oklarla AYNI tabandan kilitlenir (baseLength = ok boyu) → merkez işareti
  // oklarla birebir aynı oranda büyür/küçülür, yakınlaşınca şişmez. Yarıçap da
  // belirgin küçüldü: eski 0.22×ok boyu top gibi duruyordu ve gizmonun
  // "yuvarlak" algısının asıl kaynağıydı.
  useScreenLockedScale(ref, baseLength);
  return (
    <mesh ref={ref} position={position} renderOrder={RENDER_ORDER}>
      <sphereGeometry args={[size, 28, 20]} />
      <meshStandardMaterial color="#efece7" emissive={new THREE.Color('#b9b3aa')} emissiveIntensity={0.28} transparent opacity={0.9} depthTest={false} roughness={0.7} metalness={0.02} />
    </mesh>
  );
}

// ── Çarpı işareti (PivotMark ile aynı stil) ──────────────────────────────
// Move gizmo'da küre yerine kameraya bakan sabit piksel boyutlu çarpı (×).
// Tam köşelerde durur, her zaman keskin ve tıklanabilir.
interface CrossMarkProps {
  position: [number, number, number];
  isSelected: boolean;
  isTarget: boolean;
  onClick: (pos: [number, number, number]) => void;
  innerRef?: (el: HTMLDivElement | null) => void;
}

function CrossMark({ position, isSelected, isTarget, onClick, innerRef }: CrossMarkProps) {
  const [hovered, setHovered] = useState(false);
  const active = hovered || isSelected;

  // Kaynak: mavi, Hedef: turuncu
  const baseColor = isTarget ? '#ea580c' : '#2563eb';
  const selColor = isTarget ? '#c2410c' : '#1d4ed8';
  const hoverColor = isTarget ? '#f97316' : '#3b82f6';
  const stroke = isSelected ? selColor : hovered ? hoverColor : baseColor;
  const px = active ? 20 : 16;
  const sw = active ? 2.4 : 2;

  return (
    <Html position={position} center zIndexRange={[999, 1000]} style={{ pointerEvents: 'none' }}>
      <div
        ref={innerRef}
        onClick={e => { e.stopPropagation(); onClick(position); }}
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
            <circle cx="12" cy="12" r="10" fill={isTarget ? 'rgba(234,88,12,0.12)' : 'rgba(37,99,235,0.12)'} stroke={stroke} strokeWidth="1.1" />
          )}
          <line x1="7" y1="7" x2="17" y2="17" stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
          <line x1="17" y1="7" x2="7" y2="17" stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
        </svg>
      </div>
    </Html>
  );
}

interface PanelMoveGizmoProps {
  panelShape: Shape;
}

function panelWorldMatrix(panelShape: Shape): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...panelShape.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...panelShape.rotation, 'XYZ')),
    new THREE.Vector3(...panelShape.scale)
  );
}

// Tam köşeleri al — AABB yerine geometrinin GERÇEK benzersiz köşeleri.
function computeCorners(panelShape: Shape): [number, number, number][] {
  if (!panelShape.geometry) return [];
  const pos = panelShape.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return [];

  const seen = new Map<string, THREE.Vector3>();
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
    const key = `${Math.round(v.x * 100)},${Math.round(v.y * 100)},${Math.round(v.z * 100)}`;
    if (!seen.has(key)) seen.set(key, v);
  }

  const mat = panelWorldMatrix(panelShape);
  const result: [number, number, number][] = [];
  for (const v of seen.values()) {
    const w = v.clone().applyMatrix4(mat);
    result.push([w.x, w.y, w.z]);
  }
  return result;
}

export function PanelMoveGizmo({ panelShape }: PanelMoveGizmoProps) {
  const { panelMoveAxis, setPanelMoveAxis, panelMoveValueMode,
    panelMoveRefSourceVertex, setPanelMoveRefSourceVertex,
    panelMoveRefTargetPanelId, setPanelMoveRefTargetPanelId,
    panelMoveRefTargetVertex, setPanelMoveRefTargetVertex,
    shapes } = useAppStore();

  const isRefMode = panelMoveValueMode === 'ref';

  // Güncel geometriyi store'dan al — prop olarak gelen panelShape
  // eski olabilir (extrude sonrası geometry referansı güncellenmeyebilir).
  const freshPanel = useMemo(() => {
    return shapes.find(s => s.id === panelShape.id) || panelShape;
  }, [shapes, panelShape.id, panelShape]);

  const mat = useMemo(() => {
    return new THREE.Matrix4().compose(
      new THREE.Vector3(...freshPanel.position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...freshPanel.rotation, 'XYZ')),
      new THREE.Vector3(...freshPanel.scale)
    );
  }, [freshPanel.position, freshPanel.rotation, freshPanel.scale]);

  const { centerOrigin, axisOrigins, arrowLength } = useMemo(() => {
    const fallback = freshPanel.position;
    if (!freshPanel.geometry) {
      const o = fallback;
      return { centerOrigin: o, axisOrigins: { 'x+': o, 'x-': o, 'y+': o, 'y-': o, 'z+': o, 'z-': o }, arrowLength: 40 };
    }
    const pos = freshPanel.geometry.getAttribute('position') as THREE.BufferAttribute;
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
  }, [freshPanel.position, freshPanel.rotation, freshPanel.scale, freshPanel.geometry, mat]);

  const sourceVertices = useMemo(() => {
    if (!isRefMode || !freshPanel.geometry) return [];
    return computeCorners(freshPanel);
  }, [isRefMode, freshPanel]);

  const targetPanel = useMemo(() => {
    if (!isRefMode || !panelMoveRefTargetPanelId) return null;
    return shapes.find(s => s.id === panelMoveRefTargetPanelId) || null;
  }, [isRefMode, panelMoveRefTargetPanelId, shapes]);

  const targetVertices = useMemo(() => {
    if (!targetPanel?.geometry) return [];
    return computeCorners(targetPanel);
  }, [targetPanel]);

  // ── Ekran-uzayı çakışma çözümü (fan-out) ─────────────────────────────
  // Üst üste binen çarpı işaretleri her karede birkaç piksel ayrılır.
  const markRefs = useRef<(HTMLDivElement | null)[]>([]);
  const tmpVec = useRef(new THREE.Vector3());
  const allMarks = useMemo(() => {
    const src = sourceVertices.map(v => ({ pos: v, isTarget: false }));
    const tgt = targetVertices.map(v => ({ pos: v, isTarget: true }));
    return [...src, ...tgt];
  }, [sourceVertices, targetVertices]);

  useFrame(({ camera, size }) => {
    const n = allMarks.length;
    if (!n) return;

    const sx = new Array<number>(n);
    const sy = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const v = tmpVec.current.set(allMarks[i].pos[0], allMarks[i].pos[1], allMarks[i].pos[2]).project(camera);
      sx[i] = (v.x * 0.5 + 0.5) * size.width;
      sy[i] = (1 - (v.y * 0.5 + 0.5)) * size.height;
    }

    const dx = new Array<number>(n).fill(0);
    const dy = new Array<number>(n).fill(0);
    const MIN = 24;

    for (let pass = 0; pass < 4; pass++) {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let vx = (sx[j] + dx[j]) - (sx[i] + dx[i]);
          let vy = (sy[j] + dy[j]) - (sy[i] + dy[i]);
          let d = Math.hypot(vx, vy);
          if (d < MIN) {
            if (d < 1e-3) {
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
    // Eksen kimliği (X kırmızı / Y yeşil / Z mavi) korunur; tonlar neon
    // doygunluktan alınıp kemik-fildişi zeminle uyumlu, mat bir palete çekildi.
    { axis: 'x+', dir: [1, 0, 0],  color: '#c6635d', hover: '#dd8a84' },
    { axis: 'x-', dir: [-1, 0, 0], color: '#c6635d', hover: '#dd8a84' },
    { axis: 'y+', dir: [0, 1, 0],  color: '#6f9e6c', hover: '#93bd8f' },
    { axis: 'y-', dir: [0, -1, 0], color: '#6f9e6c', hover: '#93bd8f' },
    { axis: 'z+', dir: [0, 0, 1],  color: '#6485b8', hover: '#8ba6d2' },
    { axis: 'z-', dir: [0, 0, -1], color: '#6485b8', hover: '#8ba6d2' },
  ];

  const dotSize = arrowLength * 0.09;
  const isSourceSelected = !!panelMoveRefSourceVertex;
  const needsTargetPanel = isSourceSelected && !panelMoveRefTargetPanelId;

  const vertEq = (a: [number, number, number] | null, b: [number, number, number], tol = 0.5) =>
    !!a && Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol && Math.abs(a[2] - b[2]) < tol;

  return (
    <group>
      {!isRefMode && (
        <>
          <OriginSphere position={centerOrigin} size={arrowLength * 0.055} baseLength={arrowLength} />
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
        <CrossMark
          key={`src-${i}`}
          position={v}
          isSelected={vertEq(panelMoveRefSourceVertex, v)}
          isTarget={false}
          onClick={handleSourceVertexClick}
          innerRef={el => { markRefs.current[i] = el; }}
        />
      ))}
      {isRefMode && panelMoveRefTargetPanelId && targetVertices.map((v, i) => (
        <CrossMark
          key={`tgt-${i}`}
          position={v}
          isSelected={vertEq(panelMoveRefTargetVertex, v)}
          isTarget
          onClick={handleTargetVertexClick}
          innerRef={el => { markRefs.current[sourceVertices.length + i] = el; }}
        />
      ))}
    </group>
  );
}
