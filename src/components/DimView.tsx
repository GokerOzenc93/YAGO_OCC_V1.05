import * as THREE from 'three';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Line, Html } from '@react-three/drei';
import { useThree, useFrame } from '@react-three/fiber';
import { useAppStore } from '../store';
import { SNAP_LABEL, useDraft } from './Draft';
import { SnapGlyph } from './DraftView';
import {
  type ArrowKind, type Cursor, type Dim, type DimStyle, type Preview, type RCtx, beginDimDrag, dimActive, dimCenter, dimDelete, dimEnter, dimHover,
  dimPointerClick, dimPointerLeave, dimPointerMove, dragDimTo, drawDim, endDimDrag, rctx, selectDim, setDimStyle, setStyleOpen, useDim, wppAt,
} from './Dim';

/* 3B ÖLÇÜLENDİRME GÖRÜNÜMÜ — Dim.ts çekirdeğinin sahne katmanı (DimLayer, Canvas içinde): ölçüler, önizleme, yakalama işareti, stil penceresi.
   Araç düğmeleri üst araç çubuğunda, yakalama düğmeleri komut satırının sağındadır (ikisi de Ui.tsx).
   Fare (komut etkinken): sol tık nokta / nesne, sağ tık (sürüklemeden) Enter, sağ sürükle kaydır, orta tuşla sürükle döndür, tekerlek yakınlaş.
   Boştayken: ölçünün çizgisine / okuna / yazısına tık = seç (Shift ekler), sürükle = ölçü çizgisini taşı, Delete ya da yazının yanındaki × = sil. */

type V = THREE.Vector3;
const COL = { ghost: '#ea580c', sel: '#ea580c', hover: '#c2410c', hi: '#0f766e', rubber: '#8a8580', result: '#0f766e' };
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
type ItemProps = { d: Dim; R: RCtx; st: DimStyle; color: string; width?: number; selected?: boolean };
const DEL_BTN: React.CSSProperties = {
  width: 16, height: 16, borderRadius: 8, border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  background: '#ea580c', color: '#fffdf9', fontSize: 12, lineHeight: 1, fontWeight: 700, boxShadow: '0 1px 4px rgba(124,45,18,0.4)', pointerEvents: 'auto',
};
/** Tek ölçü: ince çizgiler, açık ok uçları, kutusuz beyaz haleli yazı. Tıklama / sürükleme sahne düzeyinde ele alınır (çizgi, ok ve yazı aynı davranır);
 *  seçiliyken yazının yanında tek tıkla silen × çıkar. */
const DimItem: React.FC<ItemProps> = React.memo(({ d, R, st, color, width = 1, selected = false }) => {
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
      {(dr.text || selected) && (
        <Html position={dr.at} center zIndexRange={[38, 0]} style={{ pointerEvents: 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, pointerEvents: 'none' }}>
            {dr.text && (
              <div style={{
                fontFamily: MONO_FONT, fontSize: st.text, fontWeight: 620, color, textShadow: HALO, whiteSpace: 'nowrap', userSelect: 'none', lineHeight: 1,
                padding: '2px 3px', borderRadius: 3, boxShadow: selected ? `0 0 0 1px ${COL.sel}` : 'none', background: selected ? 'rgba(255,247,237,0.92)' : 'transparent',
              }}>{dr.text}</div>
            )}
            {selected && (
              <button style={DEL_BTN} title="Remove this dimension (Delete)" aria-label="Remove dimension"
                onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); selectDim(d.id); dimDelete(); }}>×</button>
            )}
          </div>
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
  const cmd = useDim(s => s.cmd), cursor = useDim(s => s.cursor), preview = useDim(s => s.preview), result = useDim(s => s.result);
  const hoverId = useDim(s => s.hoverId), styleOpen = useDim(s => s.styleOpen);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const R = useMemo(() => rctx(shapes), [shapes, iso]);
  const active = !!cmd, kind = cmd?.kind ?? null;
  const live = useRef({ camera });
  live.current = { camera };

  useEffect(() => {
    gl.domElement.style.cursor = !active ? (hoverId ? 'pointer' : '') : kind === 'pick' ? PICK_CURSOR : CROSS_CURSOR;
    return () => { gl.domElement.style.cursor = ''; };
  }, [gl, active, kind, hoverId]);
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
      // Ölçüden (çizgi / ok / yazı) sürükleme: 4 pikseli geçince başlar.
      if (pendingDrag && !useDim.getState().dragId && Math.hypot(e.clientX - pendingDrag.x, e.clientY - pendingDrag.y) > 4) beginDimDrag(pendingDrag.id);
      if (useDim.getState().dragId) { dragDimTo(cursorOf(e)); e.stopPropagation(); return; }
      // Boştayken: imlecin altındaki ölçü (tıklanabilir olduğu imleçten ve durum çubuğundan anlaşılır).
      if (!dimActive()) { dimHover(e.target === el && e.buttons === 0 && !inViewCube(e) ? cursorOf(e) : null); return; }
      if (e.target !== el) { dimPointerLeave(); return; }
      dimPointerMove(cursorOf(e));
      if (e.buttons === 0 && !inViewCube(e)) e.stopPropagation();   // komut sırasında gövde hover efektleri tetiklenmesin
    };
    const onDown = (e: PointerEvent) => {
      swallow = false;
      if (!dimActive()) {
        // Ölçüye tık = seç (Shift ekler / çıkarır); tık gövdeye geçmez. Boş yere tık seçimi bırakır.
        if (e.button !== 0 || e.target !== el || inViewCube(e)) return;
        const id = dimHover(cursorOf(e));
        if (id) { selectDim(id, e.shiftKey); pendingDrag = { id, x: e.clientX, y: e.clientY }; swallow = true; e.stopPropagation(); }
        else if (useDim.getState().selection.length) selectDim(null);
        return;
      }
      if (e.target !== el || inViewCube(e)) return;
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
  return (
    <>
      {visible && dims.map(d => {
        const sel = selSet.has(d.id), hov = !active && hoverId === d.id;
        return <DimItem key={d.id} d={d} R={R} st={st} color={sel ? COL.sel : hov ? COL.hover : st.color} width={sel || hov ? 1.7 : 1} selected={sel && !active} />;
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
      {styleOpen && <Html fullscreen zIndexRange={[60, 0]} style={{ pointerEvents: 'none' }}><StylePanel /></Html>}
    </>
  );
};

// ═════════════════════════════════════════════════ 2. STİL PENCERESİ ══════════════════════════════════════════════════
const ARROWS: ArrowKind[] = ['open', 'closed', 'tick', 'dot'];
const INKS = ['#1c1917', '#1f5578', '#b91c1c', '#0f766e'];
const POP: React.CSSProperties = {
  position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', width: 236, padding: '10px 12px 12px', background: '#fff', border: '1px solid #e4dfd7',
  borderRadius: 10, boxShadow: '0 12px 36px -4px rgba(40,30,20,0.14),0 4px 12px -2px rgba(40,30,20,0.06)', display: 'flex', flexDirection: 'column', gap: 9,
  fontFamily: UI_FONT, pointerEvents: 'auto',
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
/** Ölçü stili (DIMSTYLE ya da Measure › Dimension Style): ondalık, yazı boyu, ok ucu, renk — tüm ölçülere birden uygulanır. */
const StylePanel: React.FC = () => {
  const st = useDim(s => s.style);
  const zeros = (n: number) => (n ? `0.${'0'.repeat(n)}` : '0');
  return (
    <div style={POP} role="dialog" aria-label="Dimension style" onPointerDown={e => e.stopPropagation()}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, fontWeight: 650, color: '#1c1917' }}>Dimension style</span>
        <button onClick={() => setStyleOpen(false)} aria-label="Close" title="Close (Esc)"
          style={{ width: 20, height: 20, border: 'none', borderRadius: 5, background: 'transparent', color: '#8a8378', cursor: 'pointer', fontSize: 15, lineHeight: 1 }}>×</button>
      </div>
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
