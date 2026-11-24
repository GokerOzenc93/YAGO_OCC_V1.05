import * as THREE from 'three';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Line, Html } from '@react-three/drei';
import { useThree, useFrame } from '@react-three/fiber';
import { useAppStore, type SnapType } from '../store';
import { SNAP_KINDS, SNAP_LABEL, useDraft, type SnapKind } from './Draft';
import { SnapGlyph } from './DraftView';
import {
  type ArrowKind, type Cursor, type Dim, type DimStyle, type Preview, type RCtx, DIM_COMMANDS, beginDimDrag, dimActive, dimCenter, dimCommandById, dimEnter,
  dimPointerClick, dimPointerLeave, dimPointerMove, dragDimTo, drawDim, endDimDrag, eraseAllDims, rctx, selectDim, setDimStyle, setDimsVisible, setStyleOpen,
  startDim, cancelDim, useDim, wppAt,
} from './Dim';

/* 3B ÖLÇÜLENDİRME GÖRÜNÜMÜ — Dim.ts çekirdeğinin sahne katmanı (DimLayer, Canvas içinde) ve üst araç çubuğundaki düğmeler (DimToolbar).
   Fare (komut etkinken): sol tık nokta / nesne, sağ tık (sürüklemeden) Enter, sağ sürükle kaydır, orta tuşla sürükle döndür, tekerlek yakınlaş.
   Boştayken: ölçünün yazısına tık = seç (Shift ekler), yazısından sürükle = ölçü çizgisini taşı, Delete = sil. */

type V = THREE.Vector3;
const COL = { ghost: '#ea580c', sel: '#ea580c', hi: '#0f766e', rubber: '#8a8580', result: '#0f766e' };
const UI_FONT = "'Inter','SF Pro Text',system-ui,sans-serif";
const MONO_FONT = "'SF Mono','Fira Code','Cascadia Code',monospace";
const HALO = '0 0 2px #fffdf9,0 0 2px #fffdf9,0 0 3px #fffdf9,0 0 5px #fffdf9,0 0 7px #fffdf9';
const ORDER = 1100;
const pts3 = (l: V[]) => l.map(p => [p.x, p.y, p.z] as [number, number, number]);

// ═════════════════════════════════════════════════ 1. SAHNE KATMANI ═══════════════════════════════════════════════════
/** Verilen noktada bir pikselin mm karşılığı; %8'den çok değişince yeniden çizdirir (yakınlaşınca boşluklar piksel olarak aynı kalsın). */
function useWpp(at: V): number {
  const camera = useThree(s => s.camera), size = useThree(s => s.size);
  const [w, setW] = useState(() => wppAt({ cam: camera, w: size.width, h: size.height }, at));
  useFrame(() => { const n = wppAt({ cam: camera, w: size.width, h: size.height }, at); if (Math.abs(n - w) > w * 0.08) setW(n); });
  return w;
}
const CIRCLE: [number, number, number][] = Array.from({ length: 17 }, (_, i) => [0.24 * Math.cos((i / 16) * Math.PI * 2), 0.24 * Math.sin((i / 16) * Math.PI * 2), 0]);
const ARROW_PTS: Record<ArrowKind, [number, number, number][]> = {
  open: [[1, 0.3, 0], [0, 0, 0], [1, -0.3, 0]],
  closed: [[0, 0, 0], [1, 0.2, 0], [1, -0.2, 0], [0, 0, 0]],
  tick: [[0.55, -0.55, 0], [-0.55, 0.55, 0]],
  dot: CIRCLE,
};
const TRI_GEO = (() => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, -0.2, 0, 1, 0.2, 0], 3)); return g; })();
const DOT_GEO = new THREE.CircleGeometry(0.24, 16);
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _s = new THREE.Vector3();
/** Ok ucu: ekranda sabit boy, her karede kameraya dönük düzleme yatırılır. dir = okun gösterdiği yön. */
const Arrow: React.FC<{ tip: V; dir: V; px: number; kind: ArrowKind; color: string }> = ({ tip, dir, px, kind, color }) => {
  const ref = useRef<THREE.Group>(null);
  const camera = useThree(s => s.camera), size = useThree(s => s.size);
  useFrame(() => {
    const g = ref.current;
    if (!g) return;
    const s = wppAt({ cam: camera, w: size.width, h: size.height }, tip) * px;
    _x.copy(dir).negate().normalize();
    if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) _z.copy(camera.position).sub(tip); else camera.getWorldDirection(_z).negate();
    _y.crossVectors(_z, _x);
    if (_y.lengthSq() < 1e-10) _y.set(0, 1, 0).cross(_x);
    _y.normalize(); _z.crossVectors(_x, _y);
    g.matrix.makeBasis(_x, _y, _z).scale(_s.set(s, s, s)).setPosition(tip);
    g.matrixWorldNeedsUpdate = true;
  });
  return (
    <group ref={ref} matrixAutoUpdate={false}>
      <Line points={ARROW_PTS[kind]} color={color} lineWidth={1.25} depthTest={false} depthWrite={false} transparent renderOrder={ORDER + 1} />
      {(kind === 'closed' || kind === 'dot') && (
        <mesh geometry={kind === 'closed' ? TRI_GEO : DOT_GEO} renderOrder={ORDER + 1}>
          <meshBasicMaterial color={color} side={THREE.DoubleSide} depthTest={false} depthWrite={false} transparent />
        </mesh>
      )}
    </group>
  );
};
let pendingDrag: { id: string; x: number; y: number } | null = null;
type ItemProps = { d: Dim; R: RCtx; st: DimStyle; color: string; width?: number; live?: boolean; selected?: boolean };
/** Tek ölçü: ince çizgiler, açık ok uçları, kutusuz beyaz haleli yazı. */
const DimItem: React.FC<ItemProps> = React.memo(({ d, R, st, color, width = 1, live = false, selected = false }) => {
  const center = useMemo(() => dimCenter(d, R), [d, R]);
  const wpp = useWpp(center);
  const dr = useMemo(() => drawDim(d, R, wpp, st), [d, R, wpp, st]);
  if (!dr) return null;
  return (
    <>
      {dr.lines.map((l, i) => l.length > 1 && (
        <Line key={`${i}:${l.length}`} points={pts3(l)} color={color} lineWidth={width} depthTest={false} depthWrite={false} transparent renderOrder={ORDER} />
      ))}
      {dr.arrows.map((a, i) => <Arrow key={i} tip={a.tip} dir={a.dir} px={st.arrow} kind={st.arrowKind} color={color} />)}
      {dr.text && (
        <Html position={dr.at} center zIndexRange={[38, 0]} style={{ pointerEvents: live ? 'auto' : 'none' }}>
          <div title={live ? 'Click to select · drag to move the dimension line · Delete removes it' : undefined}
            onPointerDown={live ? e => { if (e.button !== 0) return; e.stopPropagation(); selectDim(d.id, e.shiftKey); pendingDrag = { id: d.id, x: e.clientX, y: e.clientY }; } : undefined}
            style={{
              fontFamily: MONO_FONT, fontSize: st.text, fontWeight: 620, color, textShadow: HALO, whiteSpace: 'nowrap', userSelect: 'none', lineHeight: 1,
              padding: '2px 3px', cursor: live ? 'pointer' : 'default', borderRadius: 3, boxShadow: selected ? `0 0 0 1px ${COL.sel}` : 'none',
              background: selected ? 'rgba(255,247,237,0.92)' : 'transparent',
            }}>{dr.text}</div>
        </Html>
      )}
    </>
  );
});
DimItem.displayName = 'DimItem';
const NOTE: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 2, padding: '4px 7px', borderRadius: 6, background: 'rgba(253,252,250,0.96)', border: '1px solid rgba(60,50,40,0.18)',
  boxShadow: '0 4px 14px -4px rgba(40,30,20,0.28)', fontFamily: MONO_FONT, fontSize: 11, fontWeight: 600, color: '#1c1917', whiteSpace: 'nowrap', userSelect: 'none',
};
/** Geçici çizim: hayalet ölçüler, lastik çizgi, vurgulanan kenar, alan dolgusu, imleç yanında okuma. */
const PreviewLayer: React.FC<{ pv: Preview; R: RCtx; st: DimStyle; color: string; dashed: boolean; wpp: number }> = ({ pv, R, st, color, dashed, wpp }) => {
  const fill = useMemo(() => {
    if (!pv.fill || pv.fill.length < 3) return null;
    const pos: number[] = [];
    for (let i = 1; i + 1 < pv.fill.length; i++) for (const p of [pv.fill[0], pv.fill[i], pv.fill[i + 1]]) pos.push(p.x, p.y, p.z);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return g;
  }, [pv.fill]);
  useEffect(() => () => { fill?.dispose(); }, [fill]);
  return (
    <>
      {fill && <mesh geometry={fill} renderOrder={ORDER - 2}><meshBasicMaterial color={color} transparent opacity={0.14} side={THREE.DoubleSide} depthTest={false} depthWrite={false} /></mesh>}
      {pv.hi?.map((l, i) => l.length > 1 && <Line key={`h${i}:${l.length}`} points={pts3(l)} color={COL.hi} lineWidth={2.8} depthTest={false} depthWrite={false} transparent renderOrder={ORDER - 1} />)}
      {pv.lines?.map((l, i) => l.length > 1 && (
        <Line key={`l${i}:${l.length}`} points={pts3(l)} color={dashed ? COL.rubber : color} lineWidth={dashed ? 1 : 1.4} dashed={dashed} dashSize={wpp * 6} gapSize={wpp * 4}
          depthTest={false} depthWrite={false} transparent renderOrder={ORDER} />
      ))}
      {pv.dims?.map(d => <DimItem key={d.id} d={d} R={R} st={st} color={color} width={1.3} />)}
      {pv.note?.length && pv.at ? (
        <Html position={pv.at} zIndexRange={[46, 0]} style={{ pointerEvents: 'none', transform: 'translate(18px, 16px)' }}>
          <div style={NOTE}>{pv.note.map((t, i) => <span key={i} style={i ? { fontWeight: 500, color: '#57534e' } : undefined}>{t}</span>)}</div>
        </Html>
      ) : null}
    </>
  );
};
const CROSS_CURSOR = 'crosshair';
const PICK_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15"><rect x="3.5" y="3.5" width="8" height="8" fill="none" stroke="#1c1917" stroke-width="1.2"/></svg>')}") 7 7, crosshair`;

export const DimLayer: React.FC = () => {
  const camera = useThree(s => s.camera), gl = useThree(s => s.gl), controls = useThree(s => s.controls) as unknown as { mouseButtons?: { MIDDLE?: number } } | null;
  const shapes = useAppStore(s => s.shapes), iso = useDraft(s => s.isolate);
  const dims = useDim(s => s.dims), selection = useDim(s => s.selection), visible = useDim(s => s.visible), st = useDim(s => s.style);
  const cmd = useDim(s => s.cmd), cursor = useDim(s => s.cursor), preview = useDim(s => s.preview), result = useDim(s => s.result), dragId = useDim(s => s.dragId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const R = useMemo(() => rctx(shapes), [shapes, iso]);
  const active = !!cmd, kind = cmd?.kind ?? null;
  const live = useRef({ camera });
  live.current = { camera };

  useEffect(() => {
    gl.domElement.style.cursor = !active ? '' : kind === 'pick' ? PICK_CURSOR : CROSS_CURSOR;
    return () => { gl.domElement.style.cursor = ''; };
  }, [gl, active, kind]);
  // Komut sürerken sol tık nokta seçer; görünüm orta tuşla sürüklenerek döndürülür (ölçü alırken arkaya dönmek gerekir).
  useEffect(() => {
    const mb = controls?.mouseButtons;
    if (!active || !mb) return;
    const prev = mb.MIDDLE;
    mb.MIDDLE = THREE.MOUSE.ROTATE;
    return () => { mb.MIDDLE = prev; };
  }, [active, controls]);

  // Fare: pencere düzeyinde yakalama aşaması — komut etkinken tıklama gövde / panel işleyicilerine ULAŞMAZ.
  useEffect(() => {
    const el = gl.domElement, rc = new THREE.Raycaster(), ndc = new THREE.Vector2();
    let rightDown: { x: number; y: number } | null = null, swallow = false;
    const cursorOf = (e: MouseEvent): Cursor => {
      const r = el.getBoundingClientRect(), cam = live.current.camera;
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      rc.setFromCamera(ndc, cam);
      return { x: e.clientX - r.left, y: e.clientY - r.top, ray: rc.ray.clone(), view: { cam, w: r.width, h: r.height } };
    };
    const inViewCube = (e: MouseEvent) => { const r = el.getBoundingClientRect(); return Math.hypot(e.clientX - (r.right - 125), e.clientY - (r.bottom - 155)) < 80; };
    const onMove = (e: PointerEvent) => {
      // Ölçü yazısından sürükleme: 4 pikseli geçince başlar.
      if (pendingDrag && !useDim.getState().dragId && Math.hypot(e.clientX - pendingDrag.x, e.clientY - pendingDrag.y) > 4) beginDimDrag(pendingDrag.id);
      if (useDim.getState().dragId) { dragDimTo(cursorOf(e)); e.stopPropagation(); return; }
      if (!dimActive()) return;
      if (e.target !== el) { dimPointerLeave(); return; }
      dimPointerMove(cursorOf(e));
      if (e.buttons === 0 && !inViewCube(e)) e.stopPropagation();   // komut sırasında gövde hover efektleri tetiklenmesin
    };
    const onDown = (e: PointerEvent) => {
      swallow = false;
      if (!dimActive() || e.target !== el || inViewCube(e)) return;
      if (e.button === 2) { rightDown = { x: e.clientX, y: e.clientY }; return; }
      if (e.button !== 0) return;
      dimPointerClick(cursorOf(e));
      swallow = true; e.stopPropagation();
    };
    const onUp = (e: PointerEvent) => {
      pendingDrag = null;
      if (useDim.getState().dragId) { endDimDrag(); e.stopPropagation(); }
      if (e.button === 2 && rightDown) {
        const still = Math.hypot(e.clientX - rightDown.x, e.clientY - rightDown.y) < 5;
        rightDown = null;
        if (still && dimActive()) dimEnter();
      }
      if (swallow && e.button === 0) e.stopPropagation();
    };
    const onClick = (e: MouseEvent) => { if (swallow) { e.stopPropagation(); swallow = false; } };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('click', onClick, true);
    };
  }, [gl]);

  const selSet = useMemo(() => new Set(selection), [selection]);
  const idle = !active && !dragId;
  return (
    <>
      {visible && dims.map(d => {
        const sel = selSet.has(d.id);
        return <DimItem key={d.id} d={d} R={R} st={st} color={sel ? COL.sel : st.color} width={sel ? 1.6 : 1} live={idle} selected={sel} />;
      })}
      {result && !active && <PreviewLayer pv={result} R={R} st={st} color={COL.result} dashed={false} wpp={1} />}
      {active && preview && <PreviewLayer pv={preview} R={R} st={st} color={COL.ghost} dashed wpp={cursor?.wpp ?? 1} />}
      {active && cursor?.snap && (
        <Html position={cursor.p} center zIndexRange={[45, 0]} style={{ pointerEvents: 'none' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, transform: 'translateY(9px)' }}>
            <SnapGlyph kind={cursor.snap} />
            <span style={{ ...NOTE, padding: '1px 5px', fontFamily: UI_FONT, fontSize: 9.5, color: COL.hi }}>{SNAP_LABEL[cursor.snap]}</span>
          </div>
        </Html>
      )}
    </>
  );
};

// ═════════════════════════════════════════════════ 2. ÜST ARAÇ ÇUBUĞU ═════════════════════════════════════════════════
const sw = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
const dash = { strokeDasharray: '2.2 2' } as const;
const dot = (x: number, y: number, r = 1.5) => <circle cx={x} cy={y} r={r} fill="currentColor" stroke="none" />;
const HEADS_H = 'M6.2 5.6 4 7l2.2 1.4M13.8 5.6 16 7l-2.2 1.4';
/** Özgün ikonlar (20 × 20). Ölçü araçları düz, ölçme araçları kesik çizgili. */
const ICONS: Record<string, React.ReactNode> = {
  DIM: <><path d="M4 4.5v9M16 4.5v9M4 7h12" /><path d={HEADS_H} /><path d="M10 11.2v5.6M7.2 14h5.6" strokeWidth={1.7} /></>,
  DIMLINEAR: <><path d="M4 4.5v8M16 4.5v8M4 7h12" /><path d={HEADS_H} /><path d="M3.5 15.5h13" strokeWidth={2} /></>,
  DIMALIGNED: <><path d="M4 16 15 10" strokeWidth={2} /><path d="M4 16 1.4 11.2M15 10l-2.6-4.8M1.9 12.1l11-6" /><path d="M3 9.9 1.9 12.1l2.5.2M10.4 6.2l2.5.2-1.1 2.2" /></>,
  DIMANGULAR: <><path d="M4 16h12.5M4 16 12 4.5" /><path d="M12.5 16A8.5 8.5 0 0 0 8.9 9" /><path d="M11.3 14l1.2 2 1.2-2M10.9 9.3l-2-.3.4 2" /></>,
  DIMRADIUS: <><circle cx="10" cy="10" r="6.6" /><path d="M10 10l4.6-4.6M12.2 5.5l2.4-.1-.1 2.4" />{dot(10, 10, 1.2)}</>,
  DIMDIAMETER: <><circle cx="10" cy="10" r="6.6" /><path d="M5.4 14.6l9.2-9.2M12.2 5.5l2.4-.1-.1 2.4M7.8 14.5l-2.4.1.1-2.4" /></>,
  DIMJOGGED: <><path d="M3 8.5A9.2 9.2 0 0 1 17 8.5" /><path d="M6.5 17l2.6-4.6H7.4l2.6-7" /><path d="M8.4 7.2l1.6-1.8.7 2.3" /></>,
  DIMARC: <><path d="M4.5 16A7.5 7.5 0 0 1 15.5 16" strokeWidth={2} /><path d="M2.6 12.2A10.6 10.6 0 0 1 17.4 12.2M4.5 16l-2.2-4.6M15.5 16l2.2-4.6" /><path d="M2.9 9.9l-.3 2.3 2.2-.5M17.1 9.9l.3 2.3-2.2-.5" /></>,
  DIMORDINATE: <>{dot(5, 15.5, 1.7)}<path d="M5 13V9.5L9 6V3.5M11.5 4.2H17M11.5 7.4h3.5" /></>,
  DIMBASELINE: <><path d="M4 3v14M4 5.5h12M4 10h8.5M4 14.5h5M16 4v3M12.5 8.5v3M9 13v3" /></>,
  DIMCONTINUE: <><path d="M3 8h14M3 5v10M8 5.5v5M12.5 5.5v5M17 5v10" /><path d="M3 15h14" strokeWidth={2} /></>,
  QDIM: <path d="M11.2 2.5 5.5 11h4.3l-1 6.5L14.5 9h-4.3z" />,
  CENTERMARK: <><circle cx="10" cy="10" r="5.6" /><path d="M10 1.8v16.4M1.8 10h16.4" strokeWidth={1.1} strokeDasharray="4 1.6 1.2 1.6" /></>,
  DIST: <>{dot(4.5, 15.5, 1.8)}{dot(15.5, 4.5, 1.8)}<path d="M6.3 13.7l7.4-7.4" {...dash} /></>,
  MEASURERADIUS: <><circle cx="10" cy="10" r="6.6" /><path d="M10 10h6.6" {...dash} />{dot(10, 10, 1.3)}</>,
  MEASUREANGLE: <><path d="M4 16h12.5M4 16 12 4.5" /><path d="M12.5 16A8.5 8.5 0 0 0 8.9 9" {...dash} /></>,
  AREA: <><path d="M4 5h9l3.5 5-3 5.5H4z" /><path d="M6 13.5l6-6M9 15l5.2-5.2M5.2 10l3.6-3.6" strokeWidth={1} {...dash} /></>,
  ID: <><path d="M10 2.5v4.8M10 12.7v4.8M2.5 10h4.8M12.7 10h4.8" />{dot(10, 10, 1.5)}</>,
  DIMEDIT: <><path d="M4 15.5 7.4 5h1l3.4 10.5M5.3 11.8h5.2" /><path d="M15.8 4.5v11M14.5 4.5h2.6M14.5 15.5h2.6" /></>,
  DIMSPACE: <><path d="M3.5 5h9M3.5 10h9M3.5 15h9" /><path d="M16 6v8M14.6 7.6 16 6l1.4 1.6M14.6 12.4 16 14l1.4-1.6" /></>,
  DIMSTYLE: <><path d="M4 6h12M4 10h12M4 14h12" /><circle cx="8" cy="6" r="1.7" fill="#fdfcfa" /><circle cx="13" cy="10" r="1.7" fill="#fdfcfa" /><circle cx="6.5" cy="14" r="1.7" fill="#fdfcfa" /></>,
  EYE: <><path d="M2.5 10S5.5 4.8 10 4.8 17.5 10 17.5 10 14.5 15.2 10 15.2 2.5 10 2.5 10z" /><circle cx="10" cy="10" r="2.3" /></>,
  EYEOFF: <><path d="M2.5 10S5.5 4.8 10 4.8 17.5 10 17.5 10 14.5 15.2 10 15.2 2.5 10 2.5 10z" opacity={0.45} /><path d="M4 16 16 4" /></>,
  TRASH: <path d="M4.5 6h11M8 6V4.2h4V6M6 6l.7 9.8h6.6L14 6M8.6 8.6v4.8M11.4 8.6v4.8" />,
  SNAP: <><path d="M5 3.5V10a5 5 0 0 0 10 0V3.5h-3.2V10a1.8 1.8 0 0 1-3.6 0V3.5z" /><path d="M5 6.3h3.2M11.8 6.3H15" /></>,
};
const TI: React.FC<{ name: string }> = ({ name }) => <svg width={18} height={18} viewBox="0 0 20 20" {...sw}>{ICONS[name]}</svg>;
const T = { idle: '#6b6560', hover: '#1c1917', active: '#ea580c', activeBg: 'rgba(234,88,12,0.08)', activeBord: 'rgba(234,88,12,0.28)', hoverBg: 'rgba(0,0,0,0.05)' };
const GROUP: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 1, padding: 2, background: 'linear-gradient(180deg,#fdfcfa 0%,#f6f3ed 100%)', border: '1px solid rgba(60,50,40,0.14)',
  borderRadius: 8, flexShrink: 0,
  boxShadow: '0 1.5px 3px rgba(40,30,20,0.09),0 0.5px 1px rgba(40,30,20,0.05),0 0 0 0.5px rgba(60,50,40,0.07),inset 0 0.5px 0 rgba(255,255,255,0.95),inset 0 -0.5px 0 rgba(140,120,100,0.06)',
};
const TIP: React.CSSProperties = {
  pointerEvents: 'none', position: 'absolute', top: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)', background: '#1c1917', color: '#fafaf9',
  fontSize: 10, fontWeight: 500, letterSpacing: '0.02em', padding: '3px 7px', borderRadius: 5, whiteSpace: 'nowrap', zIndex: 60, transition: 'opacity 0.12s',
};
const VSEP = <div style={{ width: 1, height: 18, margin: '0 8px', background: 'rgba(60,50,40,0.12)', flexShrink: 0 }} />;
const GSEP = <div style={{ width: 1, height: 16, margin: '0 2px', background: 'rgba(60,50,40,0.14)', flexShrink: 0 }} />;
type TBProps = { label: string; active?: boolean; /** etkinken yalnız ikon turuncu (zemin / çerçeve yok) */ quiet?: boolean; faded?: boolean; disabled?: boolean; onClick?: () => void; children: React.ReactNode };
/** Üst araç çubuğu düğmesi — Ui.tsx'teki TBtn ile aynı ölçü ve davranış (30 × 30, alt ipucu). */
const TB: React.FC<TBProps> = ({ label, active = false, quiet = false, faded = false, disabled = false, onClick, children }) => {
  const [hov, setHov] = useState(false);
  const color = disabled ? '#c4bfbb' : active ? T.active : hov ? T.hover : faded ? '#b5aea5' : T.idle;
  return (
    <button aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      onMouseDown={e => e.preventDefault()}
      style={{
        position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 6, border: 'none', flexShrink: 0,
        outline: 'none', transition: 'background 0.1s,color 0.1s,box-shadow 0.1s,transform 0.1s', color,
        background: !disabled && active && !quiet ? T.activeBg : !disabled && hov ? T.hoverBg : 'transparent', boxShadow: !disabled && active && !quiet ? `0 0 0 1px ${T.activeBord}` : 'none',
        cursor: disabled ? 'not-allowed' : 'pointer', transform: hov && !disabled && !active ? 'scale(1.06)' : 'scale(1)',
      }}>
      {children}
      <span style={{ ...TIP, opacity: hov && !disabled ? 1 : 0 }}>{label}</span>
    </button>
  );
};
const ARROWS: ArrowKind[] = ['open', 'closed', 'tick', 'dot'];
const INKS = ['#1c1917', '#1f5578', '#b91c1c', '#0f766e'];
const POP: React.CSSProperties = {
  position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 236, padding: '10px 12px', background: '#fff', border: '1px solid #e4dfd7', borderRadius: 10, zIndex: 70,
  boxShadow: '0 12px 36px -4px rgba(40,30,20,0.14),0 4px 12px -2px rgba(40,30,20,0.06)', display: 'flex', flexDirection: 'column', gap: 9, fontFamily: UI_FONT,
};
const POP_LABEL: React.CSSProperties = { fontSize: 9.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#8a8378', marginBottom: 4 };
function Choice<X extends string | number>({ title, value, options, show, onPick }: { title: string; value: X; options: X[]; show: (x: X) => React.ReactNode; onPick: (x: X) => void }) {
  return (
    <div>
      <div style={POP_LABEL}>{title}</div>
      <div style={{ display: 'flex', gap: 3 }}>
        {options.map(x => {
          const on = x === value;
          return (
            <button key={String(x)} onClick={() => onPick(x)} aria-pressed={on}
              style={{
                flex: 1, height: 24, borderRadius: 5, border: 'none', cursor: 'pointer', fontFamily: MONO_FONT, fontSize: 11, fontWeight: on ? 650 : 500, outline: 'none',
                color: on ? '#c2410c' : '#57534e', background: on ? '#fff1e6' : '#f4f2ee', boxShadow: on ? 'inset 0 0 0 1px rgba(234,88,12,0.4)' : 'inset 0 0 0 1px rgba(60,50,40,0.08)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>{show(x)}</button>
          );
        })}
      </div>
    </div>
  );
}
/** Ölçü stili: yazı boyu, ok ucu, ondalık, renk — tüm ölçülere birden uygulanır. */
const StylePopover: React.FC = () => {
  const st = useDim(s => s.style), ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: PointerEvent) => { if (!ref.current?.parentElement?.contains(e.target as Node)) setStyleOpen(false); };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, []);
  const zeros = (n: number) => (n ? `0.${'0'.repeat(n)}` : '0');
  return (
    <div ref={ref} style={POP} role="dialog" aria-label="Dimension style">
      <Choice title="Decimals" value={st.prec} options={[0, 1, 2, 3]} show={zeros} onPick={prec => setDimStyle({ prec })} />
      <Choice title="Angle decimals" value={st.aprec} options={[0, 1, 2]} show={n => `${zeros(n)}°`} onPick={aprec => setDimStyle({ aprec })} />
      <Choice title="Text size" value={st.text} options={[10, 11, 12, 13, 14, 16]} show={n => n} onPick={text => setDimStyle({ text })} />
      <Choice title="Arrowheads" value={st.arrowKind} options={ARROWS} onPick={arrowKind => setDimStyle({ arrowKind })}
        show={k => (
          <svg width={26} height={12} viewBox="0 0 26 12" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h20" />
            {k === 'open' && <path d="M8 3 3 6l5 3" />}
            {k === 'closed' && <path d="M8 3.6 3 6l5 2.4z" fill="currentColor" />}
            {k === 'tick' && <path d="M1 9 6 3" />}
            {k === 'dot' && <circle cx="3.6" cy="6" r="1.9" fill="currentColor" />}
          </svg>
        )} />
      <Choice title="Color" value={st.color} options={INKS} onPick={color => setDimStyle({ color })}
        show={c => <span style={{ width: 12, height: 12, borderRadius: 6, background: c, display: 'block' }} />} />
    </div>
  );
};
const byGroup = (g: string) => DIM_COMMANDS.filter(c => c.group === g && c.id !== 'DIMSTYLE');
const tipOf = (id: string) => { const c = dimCommandById(id)!; return `${c.label}${c.aliases[0] ? ` (${c.aliases[0]})` : ''} — ${c.tip}`; };
/** Üst araç çubuğundaki ölçülendirme düğmeleri: ölçü tipleri · seriler · ölçme · düzenleme · nesne yakalama. */
export const DimToolbar: React.FC = () => {
  const cmdId = useDim(s => s.cmd?.id ?? null), visible = useDim(s => s.visible), styleOpen = useDim(s => s.styleOpen), count = useDim(s => s.dims.length);
  const snapOn = useAppStore(s => s.snapEnabled), snaps = useAppStore(s => s.snapSettings);
  // Etkin araca yeniden basmak komutu kapatır.
  const run = (id: string) => () => { if (cmdId === id) cancelDim(); else startDim(id); };
  const tool = (id: string) => <TB key={id} label={tipOf(id)} active={cmdId === id} onClick={run(id)}><TI name={id} /></TB>;
  // Ayırıcı kendi grubuyla birlikte sarar (dar pencerede satır sonunda tek başına kalmasın).
  const block = (aria: string, children: React.ReactNode, style: React.CSSProperties = GROUP) => (
    <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>{VSEP}<div style={style} role="group" aria-label={aria}>{children}</div></div>
  );
  return (
    <>
      {block('Dimensions', byGroup('dim').map(c => tool(c.id)))}
      {block('Dimension series', byGroup('series').map(c => tool(c.id)))}
      {block('Measure', byGroup('measure').map(c => tool(c.id)))}
      {block('Dimension editing', <>
        {byGroup('edit').map(c => tool(c.id))}
        <TB label="Dimension style — text size, arrowheads, decimals, color" active={styleOpen} onClick={() => setStyleOpen(!styleOpen)}><TI name="DIMSTYLE" /></TB>
        {GSEP}
        <TB label={visible ? 'Dimensions: shown — click to hide' : 'Dimensions: hidden — click to show'} faded={!visible} onClick={() => setDimsVisible(!visible)}><TI name={visible ? 'EYE' : 'EYEOFF'} /></TB>
        <TB label={`Erase all dimensions (${count})`} disabled={!count} onClick={eraseAllDims}><TI name="TRASH" /></TB>
        {styleOpen && <StylePopover />}
      </>, { ...GROUP, position: 'relative' })}
      {block('Object snap', <>
        <TB label={`Object snap: ${snapOn ? 'on' : 'off'} (F3)`} active={snapOn} onClick={() => useAppStore.getState().setSnapEnabled(!snapOn)}><TI name="SNAP" /></TB>
        {GSEP}
        {SNAP_KINDS.map((k: SnapKind) => {
          const on = !!snaps[k as unknown as SnapType];
          return (
            <TB key={k} label={`${SNAP_LABEL[k]} snap: ${on ? 'on' : 'off'}`} active={on && snapOn} quiet faded={!snapOn || !on}
              onClick={() => useAppStore.getState().toggleSnapSetting(k as unknown as SnapType)}>
              <SnapGlyph kind={k} size={17} color="currentColor" />
            </TB>
          );
        })}
      </>)}
    </>
  );
};
