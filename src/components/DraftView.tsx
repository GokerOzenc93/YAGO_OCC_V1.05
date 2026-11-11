import * as THREE from 'three';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Line, Html } from '@react-three/drei';
import { useThree, useFrame } from '@react-three/fiber';
import { useAppStore, OrthoMode, SnapType, type Shape } from '../store';
import { getShapeMatrix } from './Geometry';
import {
  type DraftPlane, type Entity, type Geo, type GeoStyle, type LineS, type P2, type Shape2, type SnapKind, COMMANDS, GROUND_PLANE, SNAP_KINDS, SNAP_LABEL,
  activatePlane, closestOn, commandActive, commandById, deg, dist, enterKey, fmt, pointerClick, pointerLeave, pointerMove, selectEntity, setAids, setExtraSnap,
  setPlanePick, startCommand, tessellate, useDraft,
} from './Draft';

/* 2B ÇİZİM GÖRÜNÜMÜ — Draft.ts çekirdeğinin sahne katmanı ve araç şeridi.
   DraftLayer (Canvas içinde): çizim düzlemi (zemin · gövde yüzü · panel yüzü), fare → düzlem koordinatı, nesne/önizleme çizimi,
   yakalama işareti, imleç yanında dinamik giriş, yüz seçilince kamerayı yüze karşıdan getirme.
   DraftRibbon (araç çubuğu satırı): Plane · Draw · Modify · yardımcılar. DraftStatus: durum çubuğu parçası.
   Fare kuralı (komut etkinken): sol tık = nokta/nesne, sağ tık (sürüklemeden) = Enter, sağ sürükle = kaydır, tekerlek = yakınlaş. */

// ═════════════════════════════════════════════════ 1. DÜZLEM · KAMERA ═════════════════════════════════════════════════
const LIFT = 0.3;        // mm — çizgiler yüzeyle çakışıp titremesin
const PICK_PX = 9;       // seçim / yakalama açıklığı (piksel)
const COL = { ent: '#1c1917', other: '#78716c', sel: '#ea580c', hi: '#0f766e', ghost: '#ea580c', rubber: '#8a8580', del: '#dc2626', track: '#0f766e', axisX: '#b91c1c', axisY: '#15803d' };
const UI_FONT = "'Inter','SF Pro Text',system-ui,sans-serif";
const MONO_FONT = "'SF Mono','Fira Code','Cascadia Code',monospace";

/** Panel geometrisi üst gövdenin yerel koordinatlarındadır → panelin dünyası = gövdenin matrisi. */
function hostMatrix(shape: Shape, shapes: Shape[]): THREE.Matrix4 {
  const pid = shape.type === 'panel' ? shape.parameters?.parentShapeId : undefined;
  return getShapeMatrix((pid && shapes.find(s => s.id === pid)) || shape);
}
const lastPlaneMatrix = new Map<string, THREE.Matrix4>();   // gövde silinirse çizim son bilinen yerinde kalır
function planeMatrix(pl: DraftPlane, shapes: Shape[]): THREE.Matrix4 {
  const local = new THREE.Matrix4().makeBasis(new THREE.Vector3(...pl.u), new THREE.Vector3(...pl.v), new THREE.Vector3(...pl.n)).setPosition(...pl.origin);
  if (pl.kind === 'ground' || !pl.shapeId) return local;
  const shape = shapes.find(s => s.id === pl.shapeId);
  if (!shape) return lastPlaneMatrix.get(pl.id) ?? local;
  const m = hostMatrix(shape, shapes).multiply(local);
  lastPlaneMatrix.set(pl.id, m);
  return m;
}
function worldPerPixel(camera: THREE.Camera, viewportHeight: number, worldPos: THREE.Vector3): number {
  const persp = camera as THREE.PerspectiveCamera;
  if (persp.isPerspectiveCamera) return (2 * Math.tan(((persp.fov * Math.PI) / 180) / 2) * persp.position.distanceTo(worldPos)) / Math.max(viewportHeight, 1);
  const ortho = camera as THREE.OrthographicCamera;
  return (ortho.top - ortho.bottom) / (ortho.zoom || 1) / Math.max(viewportHeight, 1);
}
/** Işının düzlemle kesişimi → düzlem 2B koordinatı. */
function rayOnPlane(ray: THREE.Ray, m: THREE.Matrix4, inv: THREE.Matrix4): { p: P2; world: THREE.Vector3; t: number } | null {
  const o = ray.origin.clone().applyMatrix4(inv), d = ray.origin.clone().add(ray.direction).applyMatrix4(inv).sub(o);
  if (Math.abs(d.z) < 1e-9) return null;
  const t = -o.z / d.z;
  if (t < 0) return null;
  const x = o.x + d.x * t, y = o.y + d.y * t;
  return { p: { x, y }, world: new THREE.Vector3(x, y, 0).applyMatrix4(m), t };
}
const edgeCache = new WeakMap<THREE.BufferGeometry, Float32Array>();
/** Etkin düzleme düşen gövde/panel kenarları — yalnız yakalama kaynağı (uç · orta · kesişim · dik). */
function planeEdges(inv: THREE.Matrix4, shapes: Shape[]): LineS[] {
  const out: LineS[] = [], a = new THREE.Vector3(), b = new THREE.Vector3(), m = new THREE.Matrix4();
  for (const s of shapes) {
    if (!s.geometry?.getAttribute?.('position')) continue;
    let e = edgeCache.get(s.geometry);
    if (!e) { const eg = new THREE.EdgesGeometry(s.geometry, 15); e = new Float32Array(eg.getAttribute('position').array); eg.dispose(); edgeCache.set(s.geometry, e); }
    m.multiplyMatrices(inv, hostMatrix(s, shapes));
    for (let i = 0; i + 5 < e.length; i += 6) {
      a.set(e[i], e[i + 1], e[i + 2]).applyMatrix4(m); b.set(e[i + 3], e[i + 4], e[i + 5]).applyMatrix4(m);
      if (Math.abs(a.z) < 0.6 && Math.abs(b.z) < 0.6) out.push({ t: 'line', a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } });
    }
  }
  return out;
}
type FacePick = { plane: Omit<DraftPlane, 'id'>; center: THREE.Vector3; normal: THREE.Vector3; up: THREE.Vector3; extent: number };
/** Tıklanan gövde / panel yüzünden çizim düzlemi: X sağa, Y yukarı (yatay yüzde arkaya), orijin yüzün sol-alt köşesi. */
function pickFace(ray: THREE.Ray, shapes: Shape[]): FacePick | null {
  const byMesh = new Map<THREE.Object3D, Shape>();
  for (const s of shapes) {
    if (!s.geometry?.getAttribute?.('position')) continue;
    const mesh = new THREE.Mesh(s.geometry);
    mesh.matrixAutoUpdate = false; mesh.matrixWorld.copy(hostMatrix(s, shapes));
    byMesh.set(mesh, s);
  }
  const rc = new THREE.Raycaster(ray.origin, ray.direction);
  const hits = rc.intersectObjects([...byMesh.keys()], false).filter(h => h.face);
  if (!hits.length) return null;
  // Panelin dış yüzü gövde yüzüyle çakışır: aynı derinlikte panel tercih edilir.
  const hit = hits.find(h => h.distance - hits[0].distance < 0.5 && byMesh.get(h.object)?.type === 'panel') ?? hits[0];
  const shape = byMesh.get(hit.object)!, hostM = hostMatrix(shape, shapes), hostInv = hostM.clone().invert();
  const nL = hit.face!.normal.clone();
  (['x', 'y', 'z'] as const).forEach(k => { if (Math.abs(nL[k]) < 1e-6) nL[k] = 0; });
  nL.normalize();
  const nW = nL.clone().transformDirection(hostM);
  let vW = Math.abs(nW.y) > 0.9 ? new THREE.Vector3(0, 0, nW.y > 0 ? -1 : 1) : new THREE.Vector3(0, 1, 0);
  const uW = new THREE.Vector3().crossVectors(vW, nW).normalize();
  vW = new THREE.Vector3().crossVectors(nW, uW).normalize();
  const uL = uW.clone().transformDirection(hostInv), vL = vW.clone().transformDirection(hostInv), pL = hit.point.clone().applyMatrix4(hostInv);
  const pos = shape.geometry.getAttribute('position'), q = new THREE.Vector3();
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    q.fromBufferAttribute(pos as THREE.BufferAttribute, i).sub(pL);
    if (Math.abs(q.dot(nL)) > 0.5) continue;
    const u = q.dot(uL), v = q.dot(vL);
    u0 = Math.min(u0, u); v0 = Math.min(v0, v); u1 = Math.max(u1, u); v1 = Math.max(v1, v);
  }
  if (!isFinite(u0)) { u0 = v0 = u1 = v1 = 0; }
  const origin = pL.clone().addScaledVector(uL, u0).addScaledVector(vL, v0);
  const center = pL.clone().addScaledVector(uL, (u0 + u1) / 2).addScaledVector(vL, (v0 + v1) / 2).applyMatrix4(hostM);
  const name = shape.type === 'panel' ? 'Panel face' : 'Body face';
  return {
    plane: { kind: 'face', shapeId: shape.id, origin: origin.toArray() as [number, number, number], u: uL.toArray() as [number, number, number],
      v: vL.toArray() as [number, number, number], n: nL.toArray() as [number, number, number], label: name },
    center, normal: nW, up: vW, extent: Math.max(u1 - u0, v1 - v0, 100),
  };
}
/** Kamerayı düzleme karşıdan getirir: hedef yüz merkezi, bakış yüz normali boyunca, yüz ekrana sığar. */
type OrbitLike = { target: THREE.Vector3; enableDamping: boolean; update: () => void } | null | undefined;
function flyTo(camera: THREE.Camera, controls: OrbitLike, target: THREE.Vector3, dir: THREE.Vector3, up: THREE.Vector3, extent: number, viewH: number) {
  if (!controls?.target) return;
  const persp = camera as THREE.PerspectiveCamera, ortho = camera as THREE.OrthographicCamera;
  const startT = controls.target.clone(), startDir = camera.position.clone().sub(startT), startDist = startDir.length() || 1;
  startDir.normalize();
  const endDir = dir.clone().normalize(), endUp = up.clone().normalize(), startUp = camera.up.clone();
  const endDist = persp.isPerspectiveCamera ? Math.max(250, (extent * 0.8) / Math.tan((persp.fov * Math.PI / 180) / 2)) : startDist;
  const startZoom = ortho.zoom, endZoom = ortho.isOrthographicCamera ? viewH / (extent * 1.6) : startZoom;
  const full = new THREE.Quaternion().setFromUnitVectors(startDir, endDir), ident = new THREE.Quaternion(), step = new THREE.Quaternion();
  const curDir = new THREE.Vector3(), curT = new THREE.Vector3();
  const wasDamping = controls.enableDamping;
  controls.enableDamping = false;
  const t0 = performance.now(), dur = 420;
  const tick = () => {
    const raw = Math.min((performance.now() - t0) / dur, 1), e = raw < 0.5 ? 2 * raw * raw : 1 - Math.pow(-2 * raw + 2, 2) / 2;
    step.copy(ident).slerp(full, e);
    curDir.copy(startDir).applyQuaternion(step);
    curT.copy(startT).lerp(target, e);
    camera.position.copy(curT).addScaledVector(raw < 1 ? curDir : endDir, startDist + (endDist - startDist) * e);
    camera.up.copy(startUp).lerp(endUp, e).normalize();
    if (raw >= 1) camera.up.copy(endUp);
    controls.target.copy(curT);
    camera.lookAt(curT);
    if (ortho.isOrthographicCamera) { ortho.zoom = startZoom + (endZoom - startZoom) * e; ortho.updateProjectionMatrix(); }
    controls.update();
    if (raw < 1) requestAnimationFrame(tick); else controls.enableDamping = wasDamping;
  };
  tick();
}
/** Şeritteki "View plane" düğmesi — sahne katmanı kaydolur. */
let viewPlaneFn: (() => void) | null = null;

// ═════════════════════════════════════════════════ 2. SAHNE KATMANI ═══════════════════════════════════════════════════
const ptsCache = new WeakMap<object, [number, number, number][]>();
const ptsOf = (s: Shape2 | Geo): [number, number, number][] => {
  let p = ptsCache.get(s);
  if (!p) { p = tessellate(s).map(q => [q.x, q.y, 0] as [number, number, number]); ptsCache.set(s, p); }
  return p;
};
type DLineProps = { s: Shape2 | Geo; color: string; width: number; dash?: number; order: number; depth: boolean; opacity?: number };
const DLine: React.FC<DLineProps> = React.memo(({ s, color, width, dash, order, depth, opacity = 1 }) => {
  const pts = ptsOf(s);
  if (pts.length < 2) return null;
  return <Line points={pts} color={color} lineWidth={width} dashed={!!dash} dashSize={dash ? dash * 1.5 : 1} gapSize={dash ?? 0} depthTest={depth} depthWrite={false}
    renderOrder={order} transparent opacity={opacity} />;
});
const GEO_STYLE: Record<GeoStyle, { color: string; width: number; dash: number }> = {
  ghost: { color: COL.ghost, width: 1.6, dash: 0 }, rubber: { color: COL.rubber, width: 1, dash: 4 }, hi: { color: COL.hi, width: 2.6, dash: 0 },
  del: { color: COL.del, width: 2.4, dash: 4 }, track: { color: COL.track, width: 1, dash: 2.5 },
};
const xfOf = (m: THREE.Matrix4) => {
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(p, q, s);
  return { position: p, quaternion: q, scale: s };
};
/** Bir düzlemin kalıcı nesneleri. */
const PlaneEntities: React.FC<{ matrix: THREE.Matrix4; ents: Entity[]; active: boolean; selection: Set<string>; hoverId: string | null; dash: number }> =
  React.memo(({ matrix, ents, active, selection, hoverId, dash }) => {
    const xf = useMemo(() => xfOf(matrix), [matrix]);
    return (
      <group position={xf.position} quaternion={xf.quaternion} scale={xf.scale}>
        <group position={[0, 0, LIFT]}>
          {ents.map(e => {
            const sel = selection.has(e.id), hov = hoverId === e.id;
            return <DLine key={e.id} s={e} color={sel ? COL.sel : hov ? COL.hi : active ? COL.ent : COL.other} width={sel ? 2.2 : hov ? 2.6 : active ? 1.7 : 1.3}
              dash={sel ? dash * 5 : 0} order={sel || hov ? 21 : 20} depth />;
          })}
        </group>
      </group>
    );
  });
/** Düzlem orijininde X/Y ekseni işareti (ekranda sabit boy). */
const UcsIcon: React.FC<{ matrix: THREE.Matrix4 }> = ({ matrix }) => {
  const ref = useRef<THREE.Group>(null);
  const { camera, size } = useThree();
  const xf = useMemo(() => xfOf(matrix), [matrix]);
  useFrame(() => { if (ref.current) ref.current.scale.setScalar(worldPerPixel(camera, size.height, xf.position) * 46); });
  const label: React.CSSProperties = { fontFamily: MONO_FONT, fontSize: 10, fontWeight: 700, pointerEvents: 'none', userSelect: 'none' };
  return (
    <group position={xf.position} quaternion={xf.quaternion}>
      <group ref={ref} position={[0, 0, LIFT]}>
        {/* transparent: saydam kuyrukta çizilsin ki renderOrder nesne çizgilerinin üstüne çıkarsın */}
        <Line points={[[0, 0, 0], [1, 0, 0]]} color={COL.axisX} lineWidth={2} depthTest={false} depthWrite={false} transparent renderOrder={40} />
        <Line points={[[0, 0, 0], [0, 1, 0]]} color={COL.axisY} lineWidth={2} depthTest={false} depthWrite={false} transparent renderOrder={40} />
        <Html position={[1.22, 0, 0]} center zIndexRange={[20, 0]} style={{ ...label, color: COL.axisX }}>X</Html>
        <Html position={[0, 1.22, 0]} center zIndexRange={[20, 0]} style={{ ...label, color: COL.axisY }}>Y</Html>
      </group>
    </group>
  );
};
const SNAP_GLYPH: Record<SnapKind, React.ReactNode> = {
  endpoint: <rect x="4" y="4" width="12" height="12" />,
  midpoint: <path d="M10 4 17 16H3z" />,
  center: <circle cx="10" cy="10" r="6.5" />,
  quadrant: <path d="M10 3 17 10 10 17 3 10z" />,
  intersection: <path d="M4 4 16 16M16 4 4 16" />,
  perpendicular: <path d="M4 4v12h12M4 10h6v6" />,
  tangent: <><circle cx="10" cy="11.5" r="5" /><path d="M3 5.5h14" /></>,
  nearest: <path d="M4 4h12L4 16h12z" />,
};
const SnapGlyph: React.FC<{ kind: SnapKind; size?: number; color?: string }> = ({ kind, size = 20, color = COL.hi }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke={color} strokeWidth={1.9} strokeLinejoin="round" strokeLinecap="round">{SNAP_GLYPH[kind]}</svg>
);
const TIP_BOX: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 5, padding: '3px 6px', borderRadius: 6, background: 'rgba(253,252,250,0.96)', border: '1px solid rgba(60,50,40,0.18)',
  boxShadow: '0 4px 14px -4px rgba(40,30,20,0.28)', fontFamily: UI_FONT, fontSize: 11, color: '#44403c', whiteSpace: 'nowrap', userSelect: 'none',
};
const tipField = (active: boolean, locked: boolean): React.CSSProperties => ({
  minWidth: 46, padding: '1px 5px', borderRadius: 4, fontFamily: MONO_FONT, fontSize: 11, fontWeight: 600, textAlign: 'right',
  background: active ? '#fff7ed' : '#f4f2ee', color: locked ? '#c2410c' : '#1c1917', boxShadow: active ? 'inset 0 0 0 1px rgba(234,88,12,0.55)' : 'inset 0 0 0 1px rgba(60,50,40,0.12)',
});
/** İmleç yanında dinamik giriş: istem + (taban nokta varsa) uzunluk / açı alanları; yazılan değer etkin alanda görünür. */
const DynTip: React.FC = () => {
  const cmd = useDraft(s => s.cmd), cursor = useDraft(s => s.cursor), dyn = useDraft(s => s.dyn), typed = useDraft(s => s.typed);
  if (!cmd || !cursor) return null;
  const text = cmd.prompt.replace(/^.*? {2}/, ''), base = cursor.base;
  const polarFields = !!base && !cmd.num && cmd.kind === 'point';
  const len = base ? dist(base, cursor.p) : 0, ang = base ? ((deg(Math.atan2(cursor.p.y - base.y, cursor.p.x - base.x)) % 360) + 360) % 360 : 0;
  return (
    <div style={TIP_BOX}>
      <span style={{ color: '#706b65' }}>{text}{cmd.def ? ` <${cmd.def}>` : ''}</span>
      {polarFields ? (
        <>
          <span style={tipField(dyn.field === 'len', dyn.len !== null)}>{dyn.field === 'len' && typed ? typed : fmt(dyn.len ?? len, 2)}</span>
          <span style={tipField(dyn.field === 'ang', dyn.ang !== null)}>{dyn.field === 'ang' && typed ? typed : `${fmt(dyn.ang ?? ang, 1)}°`}</span>
        </>
      ) : typed ? <span style={tipField(true, false)}>{typed}</span>
        : base && cmd.num ? <span style={tipField(false, false)}>{fmt(len, 2)}</span>
          : cmd.kind === 'point' ? <span style={{ fontFamily: MONO_FONT, color: '#1c1917' }}>{fmt(cursor.p.x, 1)}, {fmt(cursor.p.y, 1)}</span> : null}
    </div>
  );
};
const PICKBOX_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15"><rect x="3.5" y="3.5" width="8" height="8" fill="none" stroke="#1c1917" stroke-width="1.2"/></svg>')}") 7 7, crosshair`;
const IDENT = new THREE.Matrix4();

export const DraftLayer: React.FC = () => {
  const camera = useThree(s => s.camera), gl = useThree(s => s.gl), size = useThree(s => s.size), controls = useThree(s => s.controls) as unknown as OrbitLike;
  const shapes = useAppStore(s => s.shapes), ortho = useAppStore(s => s.orthoMode), snapSettings = useAppStore(s => s.snapSettings);
  const planes = useDraft(s => s.planes), activeId = useDraft(s => s.activePlane), entities = useDraft(s => s.entities), selection = useDraft(s => s.selection);
  const hoverId = useDraft(s => s.hoverId), preview = useDraft(s => s.preview), cursor = useDraft(s => s.cursor), cmd = useDraft(s => s.cmd);
  const planePick = useDraft(s => s.planePick), dynOn = useDraft(s => s.aids.dyn);
  const [wpp, setWpp] = useState(1);

  const matrices = useMemo(() => new Map(planes.map(p => [p.id, planeMatrix(p, shapes)])), [planes, shapes]);
  const activeM = matrices.get(activeId) ?? IDENT;
  const activeInv = useMemo(() => activeM.clone().invert(), [activeM]);
  const activeXf = useMemo(() => xfOf(activeM), [activeM]);
  const selSet = useMemo(() => new Set(selection), [selection]);
  const byPlane = useMemo(() => {
    const m = new Map<string, Entity[]>();
    for (const e of entities) { const l = m.get(e.plane); if (l) l.push(e); else m.set(e.plane, [e]); }
    return m;
  }, [entities]);

  // Ortho ve yakalama ayarları uygulamanın mevcut düğmelerinden (store) gelir.
  useEffect(() => { setAids({ ortho: ortho === OrthoMode.ON, snaps: snapSettings as unknown as Record<SnapKind, boolean> }); }, [ortho, snapSettings]);
  const busy = !!cmd;
  useEffect(() => { setExtraSnap(busy ? planeEdges(activeInv, shapes) : []); }, [busy, activeInv, shapes]);
  const kind = cmd?.kind ?? null;
  useEffect(() => {
    gl.domElement.style.cursor = planePick ? 'copy' : kind ? (kind === 'pick' ? PICKBOX_CURSOR : 'crosshair') : '';
    return () => { gl.domElement.style.cursor = ''; };
  }, [gl, planePick, kind]);

  const live = useRef({ camera, size, controls, shapes, matrices, activeM, activeInv });
  live.current = { camera, size, controls, shapes, matrices, activeM, activeInv };
  useEffect(() => {
    viewPlaneFn = () => {
      const L = live.current, st = useDraft.getState(), pl = st.planes.find(p => p.id === st.activePlane) ?? GROUND_PLANE;
      // Düzlem matrisinin sütunları: X, Y (yukarı) ve normal — dünya koordinatında.
      const n = new THREE.Vector3(0, 0, 1).transformDirection(L.activeM), up = new THREE.Vector3(0, 1, 0).transformDirection(L.activeM);
      const on = st.entities.filter(e => e.plane === pl.id);
      let target: THREE.Vector3, extent = 1200;
      if (on.length) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const e of on) for (const p of tessellate(e)) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
        target = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, 0).applyMatrix4(L.activeM); extent = Math.max(x1 - x0, y1 - y0, 200);
      } else {
        // Çizim yoksa: bakılan nokta düzleme izdüşürülür, uzaklık korunur.
        const t = L.controls?.target.clone() ?? new THREE.Vector3();
        const loc = t.clone().applyMatrix4(L.activeInv); loc.z = 0;
        target = loc.applyMatrix4(L.activeM);
        extent = Math.max(200, L.camera.position.distanceTo(t) * 0.5);
      }
      flyTo(L.camera, L.controls, target, n, up, extent, L.size.height);
    };
    return () => { viewPlaneFn = null; };
  }, []);

  // Fare: pencere düzeyinde yakalama aşaması — komut etkinken tıklama gövde/panel işleyicilerine ve yörünge kontrolüne ULAŞMAZ.
  useEffect(() => {
    const el = gl.domElement, rc = new THREE.Raycaster(), ndc = new THREE.Vector2();
    let rightDown: { x: number; y: number } | null = null, swallow = false, inside = false;
    const rayOf = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      rc.setFromCamera(ndc, live.current.camera);
      return rc.ray;
    };
    // Sağ alttaki görünüm küpü kendi tıklamalarını alır.
    const inViewCube = (e: MouseEvent) => { const r = el.getBoundingClientRect(); return Math.hypot(e.clientX - (r.right - 125), e.clientY - (r.bottom - 155)) < 80; };
    const tolAt = (world: THREE.Vector3) => PICK_PX * worldPerPixel(live.current.camera, live.current.size.height, world);
    const onActive = (e: MouseEvent) => {
      const L = live.current, h = rayOnPlane(rayOf(e), L.activeM, L.activeInv);
      return h ? { p: h.p, tol: tolAt(h.world), world: h.world } : null;
    };
    /** Boşta tıklama: hangi düzlemde olursa olsun imlecin altındaki çizim nesnesi. */
    const pickAny = (e: MouseEvent): string | null => {
      const L = live.current, st = useDraft.getState(), ray = rayOf(e);
      let best: string | null = null, bt = Infinity;
      for (const pl of st.planes) {
        const m = L.matrices.get(pl.id), on = st.entities.filter(x => x.plane === pl.id);
        if (!m || !on.length) continue;
        const h = rayOnPlane(ray, m, m.clone().invert());
        if (!h || h.t >= bt) continue;
        const tol = tolAt(h.world);
        let hit: string | null = null, bd = tol;
        for (const x of on) { const d = closestOn(x, h.p).d; if (d <= bd) { bd = d; hit = x.id; } }
        if (hit) { best = hit; bt = h.t; }
      }
      return best;
    };
    const stop = (e: Event) => { e.stopPropagation(); };
    const onMove = (e: PointerEvent) => {
      if (e.target !== el) { if (inside) { inside = false; pointerLeave(); } return; }
      const st = useDraft.getState();
      if (!st.cmd && !st.entities.length) return;
      const h = onActive(e);
      if (!h) return;
      inside = true;
      const w = tolAt(h.world) / PICK_PX;
      setWpp(prev => (Math.abs(w - prev) / prev > 0.12 ? w : prev));
      pointerMove(h.p, h.tol, e.shiftKey, e.ctrlKey || e.metaKey);
      if (st.cmd && e.buttons === 0 && !inViewCube(e)) stop(e);   // komut sırasında gövde hover efektleri tetiklenmesin
    };
    const onDown = (e: PointerEvent) => {
      swallow = false;
      if (e.target !== el || inViewCube(e)) return;
      if (e.button === 2) { rightDown = { x: e.clientX, y: e.clientY }; return; }
      if (e.button !== 0) return;
      const st = useDraft.getState();
      if (st.planePick) {
        const f = pickFace(rayOf(e), live.current.shapes);
        if (f) { activatePlane(f.plane); flyTo(live.current.camera, live.current.controls, f.center, f.normal, f.up, f.extent, live.current.size.height); }
        swallow = true; stop(e);
        return;
      }
      if (commandActive()) {
        const h = onActive(e);
        if (h) pointerClick(h.p, h.tol, e.shiftKey, e.ctrlKey || e.metaKey);
        swallow = true; stop(e);
        return;
      }
      if (!st.entities.length) return;
      const id = pickAny(e);
      if (id) { selectEntity(id, e.shiftKey); swallow = true; stop(e); }
      else if (st.selection.length) selectEntity(null);
    };
    const onUp = (e: PointerEvent) => {
      if (e.button === 2 && rightDown) {
        const still = Math.hypot(e.clientX - rightDown.x, e.clientY - rightDown.y) < 5;
        rightDown = null;
        if (still && commandActive()) enterKey();
      }
      if (swallow && e.button === 0) stop(e);
    };
    const onClick = (e: MouseEvent) => { if (swallow) { stop(e); swallow = false; } };
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

  const toWorld = (p: P2) => new THREE.Vector3(p.x, p.y, 0).applyMatrix4(activeM);
  const showUcs = busy || planePick || activeId !== GROUND_PLANE.id || (byPlane.get(activeId)?.length ?? 0) > 0;
  const track = cursor?.track, trackLen = wpp * 6000;
  return (
    <>
      {planes.map(pl => {
        const m = matrices.get(pl.id), ents = byPlane.get(pl.id);
        return m && ents?.length ? <PlaneEntities key={pl.id} matrix={m} ents={ents} active={pl.id === activeId} selection={selSet} hoverId={hoverId} dash={wpp} /> : null;
      })}
      {showUcs && <UcsIcon matrix={activeM} />}
      {busy && (
        <group position={activeXf.position} quaternion={activeXf.quaternion} scale={activeXf.scale}>
          <group position={[0, 0, LIFT]}>
            {track && <DLine s={{ t: 'line', a: track.from, b: { x: track.from.x + Math.cos(track.ang) * trackLen, y: track.from.y + Math.sin(track.ang) * trackLen } }}
              color={COL.track} width={1} dash={wpp * 2.5} order={1001} depth={false} opacity={0.75} />}
            {preview.map((g, i) => {
              if (g.t === 'box') {
                const w = g.b.x - g.a.x, h = g.b.y - g.a.y;
                return (
                  <group key={i}>
                    <mesh position={[g.a.x + w / 2, g.a.y + h / 2, 0]} renderOrder={1000}>
                      <planeGeometry args={[Math.abs(w) || 1e-6, Math.abs(h) || 1e-6]} />
                      <meshBasicMaterial color={g.crossing ? '#16a34a' : '#2563eb'} transparent opacity={0.1} depthTest={false} depthWrite={false} side={THREE.DoubleSide} />
                    </mesh>
                    <DLine s={g} color={g.crossing ? '#15803d' : '#1d4ed8'} width={1.2} dash={g.crossing ? wpp * 4 : 0} order={1002} depth={false} />
                  </group>
                );
              }
              const st = GEO_STYLE[g.style ?? 'ghost'];
              return <DLine key={i} s={g} color={st.color} width={st.width} dash={st.dash * wpp} order={1002} depth={false} />;
            })}
          </group>
        </group>
      )}
      {busy && cursor?.snap && (
        <Html position={toWorld(cursor.snap.p)} center zIndexRange={[45, 0]} style={{ pointerEvents: 'none' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, transform: 'translateY(9px)' }}>
            <SnapGlyph kind={cursor.snap.kind} />
            <span style={{ ...TIP_BOX, padding: '1px 5px', fontSize: 9.5, color: COL.hi, fontWeight: 600 }}>{SNAP_LABEL[cursor.snap.kind]}</span>
          </div>
        </Html>
      )}
      {busy && dynOn && cursor && (
        <Html position={toWorld(cursor.p)} zIndexRange={[46, 0]} style={{ pointerEvents: 'none', transform: 'translate(20px, 18px)' }}><DynTip /></Html>
      )}
    </>
  );
};

// ═════════════════════════════════════════════════ 3. ARAÇ ŞERİDİ ═════════════════════════════════════════════════════
const dot = (x: number, y: number, r = 1.7) => <circle cx={x} cy={y} r={r} fill="currentColor" stroke="none" />;
const ring = (x: number, y: number, r = 1.8) => <circle cx={x} cy={y} r={r} fill="#fdfcfa" strokeWidth={1.3} />;
const dash = { strokeDasharray: '2.2 2.2', strokeWidth: 1.1 } as const;
const QARC = 'M19 19A13 13 0 0 0 8.26 6.2';     // merkez (6,19), başlangıç (19,19), bitiş (8.26,6.2)
const SARC = 'M20 16A10 10 0 0 0 4 16';          // merkez (12,22), başlangıç (20,16), bitiş (4,16)
const HEX = '19,12 15.5,18.06 8.5,18.06 5,12 8.5,5.94 15.5,5.94';
/** Araç ikonları — 24×24, çizgi tabanlı, özgün. */
const ICONS: Record<string, React.ReactNode> = {
  LINE: <><path d="M5 19 19 5" />{ring(5, 19)}{ring(19, 5)}</>,
  PLINE: <><path d="M4 18 9 8l5 7 6-9" />{ring(4, 18)}{ring(9, 8)}{ring(14, 15)}{ring(20, 6)}</>,
  CIRCLE: <><circle cx="12" cy="12" r="8" /><path d="M12 12h8" />{dot(12, 12)}</>,
  CIRCLE_CD: <><circle cx="12" cy="12" r="8" /><path d="M4 12h16" />{dot(12, 12)}</>,
  CIRCLE_2P: <><circle cx="12" cy="12" r="8" />{ring(4, 12)}{ring(20, 12)}</>,
  CIRCLE_3P: <><circle cx="12" cy="12" r="8" />{ring(12, 4)}{ring(5.1, 16)}{ring(18.9, 16)}</>,
  CIRCLE_TTR: <><path d="M3 19h18M7 3v18" strokeWidth={1.2} /><circle cx="13" cy="13" r="6" /><path d="M13 13l4.2-4.2" strokeWidth={1.1} /></>,
  CIRCLE_TTT: <><path d="M12 3 22 20H2z" strokeWidth={1.2} /><circle cx="12" cy="14.3" r="5.7" /></>,
  ARC: <><path d={SARC} />{ring(20, 16)}{ring(4, 16)}</>,
  ARC_3P: <><path d={SARC} />{ring(20, 16)}{ring(12, 12)}{ring(4, 16)}</>,
  ARC_SCE: <><path d="M6 19h13M6 19 8.26 6.2" {...dash} /><path d={QARC} />{dot(19, 19, 2)}{ring(6, 19)}{ring(8.26, 6.2)}</>,
  ARC_SCA: <><path d="M6 19h13M6 19 8.26 6.2" strokeWidth={1.1} /><path d="M11 19a5 5 0 0 0-4.13-4.92" strokeWidth={1.1} /><path d={QARC} />{dot(19, 19, 2)}{ring(6, 19)}</>,
  ARC_SCL: <><path d="M19 19 8.26 6.2" {...dash} /><path d={QARC} />{dot(19, 19, 2)}{ring(6, 19)}{ring(8.26, 6.2)}</>,
  ARC_SEA: <><path d="M20 16 12 22 4 16" {...dash} /><path d="M14.4 20.2a3 3 0 0 0-4.8 0" strokeWidth={1.1} /><path d={SARC} />{dot(20, 16, 2)}{ring(4, 16)}</>,
  ARC_SED: <><path d={SARC} /><path d="M20 16 15.5 10M15.5 10l.4 3.4M15.5 10l3.2 1.2" strokeWidth={1.2} />{dot(20, 16, 2)}{ring(4, 16)}</>,
  ARC_SER: <><path d="M12 22V12" strokeWidth={1.1} /><path d={SARC} />{dot(20, 16, 2)}{ring(4, 16)}{dot(12, 22, 1.4)}</>,
  ARC_CSE: <><path d="M6 19h13M6 19 8.26 6.2" {...dash} /><path d={QARC} />{dot(6, 19, 2)}{ring(19, 19)}{ring(8.26, 6.2)}</>,
  ARC_CSA: <><path d="M6 19h13M6 19 8.26 6.2" strokeWidth={1.1} /><path d="M11 19a5 5 0 0 0-4.13-4.92" strokeWidth={1.1} /><path d={QARC} />{dot(6, 19, 2)}{ring(19, 19)}</>,
  ARC_CSL: <><path d="M19 19 8.26 6.2" {...dash} /><path d={QARC} />{dot(6, 19, 2)}{ring(19, 19)}{ring(8.26, 6.2)}</>,
  ARC_CONT: <><path d="M3 19h8" /><path d="M11 19a8 8 0 0 0 8-8" />{ring(11, 19)}{ring(19, 11)}</>,
  RECT: <><rect x="4" y="7" width="16" height="10" />{ring(4, 17)}{ring(20, 7)}</>,
  RECT_ROT: <><path d="M5 15 14 20 19 9 10 4z" />{ring(5, 15)}{ring(14, 20)}</>,
  RECT_CEN: <><rect x="4" y="7" width="16" height="10" />{dot(12, 12)}{ring(20, 7)}</>,
  POLY: <><circle cx="12" cy="12" r="7" {...dash} /><polygon points={HEX} /></>,
  POLY_C: <><polygon points="20.5,12 16.25,19.36 7.75,19.36 3.5,12 7.75,4.64 16.25,4.64" /><circle cx="12" cy="12" r="7.3" {...dash} /></>,
  POLY_E: <><polygon points={HEX} /><path d="M8.5 18.06h7" strokeWidth={2.4} />{ring(8.5, 18.06)}{ring(15.5, 18.06)}</>,
  POLYGON: <polygon points={HEX} />,
  ELLIPSE: <><ellipse cx="12" cy="12" rx="9" ry="5.5" /><path d="M12 12h9" strokeWidth={1.1} />{dot(12, 12)}</>,
  ELLIPSE_AXIS: <><ellipse cx="12" cy="12" rx="8" ry="5.5" /><path d="M4 12h16" strokeWidth={1.1} />{ring(4, 12)}{ring(20, 12)}</>,
  ELLIPSE_ARC: <><path d="M21 12A9 5.5 0 1 0 12 17.5" />{ring(21, 12)}{ring(12, 17.5)}{dot(12, 12, 1.4)}</>,
  MOVE: <path d="M12 3v18M3 12h18M12 3 9 6M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" />,
  COPY: <><rect x="8.5" y="8.5" width="11.5" height="11.5" rx="1.6" /><path d="M15.5 8.5v-3A1.5 1.5 0 0 0 14 4H5.5A1.5 1.5 0 0 0 4 5.5V14a1.5 1.5 0 0 0 1.5 1.5h3" /></>,
  STRETCH: <><rect x="3" y="8" width="8" height="8" /><path d="M11 8h10v8H11" {...dash} /><path d="M7 12h10M14.5 9.5 17 12l-2.5 2.5" strokeWidth={1.3} /></>,
  ROTATE: <><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" /><path d="M19.5 3.5v4h-4" />{dot(12, 12, 1.5)}</>,
  MIRROR: <><path d="M12 3v18" {...dash} /><path d="M9 7v10H3z" /><path d="M15 7v10h6z" /></>,
  SCALE: <><rect x="3" y="13" width="8" height="8" /><path d="M3 9V3h18v18h-6" {...dash} /><path d="M11 13l7-7M14 6h4v4" strokeWidth={1.3} /></>,
  TRIM: <><path d="M15 3v18" /><path d="M3 12h12" /><path d="M15 12h6" stroke="#dc2626" {...dash} strokeWidth={1.5} /><path d="M17 9.5l3 5M20 9.5l-3 5" stroke="#dc2626" strokeWidth={1.2} /></>,
  EXTEND: <><path d="M19.5 3v18" /><path d="M3 12h8" /><path d="M11 12h8" {...dash} strokeWidth={1.4} /><path d="M15.5 9l3 3-3 3" strokeWidth={1.3} /></>,
  FILLET: <><path d="M4 12V4h8" {...dash} /><path d="M4 21v-9a8 8 0 0 1 8-8h9" /></>,
  CHAMFER: <><path d="M4 12V4h8" {...dash} /><path d="M4 21v-9l8-8h9" /></>,
  ARRAYRECT: <>{[5, 14].flatMap(y => [3, 10, 17].map(x => <rect key={`${x}-${y}`} x={x} y={y} width="4.5" height="4.5" />))}</>,
  ARRAYPATH: <><path d="M3 19C7 5 17 5 21 19" {...dash} /><rect x="2" y="15.5" width="4" height="4" /><rect x="10" y="6.5" width="4" height="4" /><rect x="18" y="15.5" width="4" height="4" /></>,
  ARRAYPOLAR: <>{[0, 60, 120, 180, 240, 300].map(a => <circle key={a} cx={12 + 8 * Math.cos(a * Math.PI / 180)} cy={12 + 8 * Math.sin(a * Math.PI / 180)} r="2.1" />)}{dot(12, 12, 1.4)}</>,
  ERASE: <><path d="M9 20h11" /><path d="M5.2 13.2 12.6 5.8a2 2 0 0 1 2.8 0l3 3a2 2 0 0 1 0 2.8L11 19H8l-2.8-2.8a2 2 0 0 1 0-3z" /><path d="M9.5 9 15 14.5" strokeWidth={1.2} /></>,
  EXPLODE: <><rect x="9" y="9" width="6" height="6" /><path d="M7 7 3.5 3.5M17 7l3.5-3.5M7 17l-3.5 3.5M17 17l3.5 3.5M3.5 6.5v-3h3M17.5 3.5h3v3M3.5 17.5v3h3M20.5 17.5v3h-3" strokeWidth={1.3} /></>,
  OFFSET: <><path d="M4 20v-9a7 7 0 0 1 7-7h9" /><path d="M9.5 20v-8.5a2 2 0 0 1 2-2H20" strokeWidth={1.2} {...{ strokeDasharray: '3 2' }} /></>,
  ground: <><path d="M3 17 8 8h13l-5 9z" /><path d="M5.5 12.5h13M12 8l-3 9M17 8l-3.5 9" strokeWidth={1} /></>,
  face: <><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12v9M12 12 4 7.5" strokeWidth={1.1} /><path d="M12 12l8-4.5v9L12 21z" fill="currentColor" fillOpacity={0.22} /></>,
  look: <><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" /><circle cx="12" cy="12" r="2.8" /></>,
  ortho: <><path d="M5 4v15h15" /><path d="M5 14h5v5" strokeWidth={1.2} /></>,
  polar: <><path d="M4 19h16M4 19 17 6" /><path d="M13 19a9 9 0 0 0-2.6-6.4" strokeWidth={1.2} /></>,
  osnap: <><rect x="5" y="5" width="14" height="14" /><rect x="15.5" y="2.5" width="6" height="6" fill="currentColor" stroke="none" /></>,
  dyn: <><path d="M4 4l5.5 13 1.8-5.7L17 9.5z" /><rect x="13" y="15" width="8" height="5.5" rx="1" strokeWidth={1.3} /></>,
  caret: <path d="M7 10l5 5 5-5" strokeWidth={2.2} />,
};
const DIcon: React.FC<{ name: string; size?: number }> = ({ name, size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>{ICONS[name]}</svg>
);
const RIBBON_CSS = `
  .dr-row{position:relative;display:flex;align-items:center;height:42px;padding:0 14px;background:linear-gradient(180deg,#f6f4f0 0%,#edeae4 100%);
    border-bottom:1px solid #d6d1c8;box-shadow:inset 0 1px 0 rgba(255,255,255,0.85),0 1px 4px rgba(60,50,40,0.04);font-family:${UI_FONT};user-select:none}
  .dr-grp{display:flex;align-items:center;gap:1px;padding:2px;background:linear-gradient(180deg,#fdfcfa 0%,#f6f3ed 100%);border:1px solid rgba(60,50,40,0.14);border-radius:8px;
    box-shadow:0 1.5px 3px rgba(40,30,20,0.09),0 0 0 0.5px rgba(60,50,40,0.07),inset 0 0.5px 0 rgba(255,255,255,0.95);flex-shrink:0}
  .dr-cap{font-size:9.5px;font-weight:600;letter-spacing:0.09em;text-transform:uppercase;color:#9c9590;margin:0 7px 0 2px;flex-shrink:0}
  .dr-sep{width:1px;height:18px;margin:0 9px;background:rgba(60,50,40,0.12);flex-shrink:0}
  .dr-btn{position:relative;display:flex;align-items:center;justify-content:center;gap:5px;min-width:30px;height:30px;padding:0;border-radius:6px;border:none;background:transparent;
    color:#6b6560;cursor:pointer;flex-shrink:0;outline:none;font:500 11.5px ${UI_FONT};transition:background .1s,color .1s,box-shadow .1s}
  .dr-btn:hover{background:rgba(0,0,0,0.05);color:#1c1917}
  .dr-btn:active{transform:scale(0.95)}
  .dr-btn.on{background:rgba(234,88,12,0.08);color:#ea580c;box-shadow:0 0 0 1px rgba(234,88,12,0.28)}
  .dr-btn.txt{padding:0 8px}
  .dr-btn.caret{min-width:13px;width:13px;margin-left:-2px;color:#a8a29e}
  .dr-tip{pointer-events:none;position:absolute;top:calc(100% + 6px);left:50%;transform:translateX(-50%);background:#1c1917;color:#fafaf9;font-size:10px;font-weight:500;
    letter-spacing:0.02em;padding:3px 7px;border-radius:5px;white-space:nowrap;z-index:80;opacity:0;transition:opacity .12s}
  .dr-btn:hover>.dr-tip{opacity:1}
  .dr-tip b{font-family:${MONO_FONT};font-weight:500;color:#fdba74;margin-left:6px}
  .dr-menu{position:absolute;top:calc(100% + 5px);left:0;min-width:214px;padding:4px;background:#fdfcfa;border:1px solid rgba(60,50,40,0.16);border-radius:9px;
    box-shadow:0 12px 30px -10px rgba(40,30,20,0.32),0 2px 6px rgba(40,30,20,0.08);z-index:90}
  .dr-mi{display:flex;align-items:center;gap:9px;width:100%;height:30px;padding:0 9px;border:none;background:transparent;border-radius:6px;font:500 12px ${UI_FONT};color:#44403c;
    cursor:pointer;text-align:left;white-space:nowrap}
  .dr-mi:hover{background:#fff7ed;color:#c2410c}
  .dr-mi.on{color:#ea580c}
  .dr-mi i{margin-left:auto;padding-left:14px;font:400 10px ${MONO_FONT};color:#a8a29e;font-style:normal}
  .dr-mi .chk{width:14px;height:14px;border-radius:4px;box-shadow:inset 0 0 0 1px rgba(60,50,40,0.25);display:flex;align-items:center;justify-content:center;flex-shrink:0}
  .dr-mi .chk.on{background:#ea580c;box-shadow:none}
`;
const FAMILIES: Record<string, { label: string; def: string }> = {
  circle: { label: 'Circle', def: 'CIRCLE' }, arc: { label: 'Arc', def: 'ARC_3P' }, shape: { label: 'Rectangle / Polygon', def: 'RECT' }, ellipse: { label: 'Ellipse', def: 'ELLIPSE' },
  trim: { label: 'Trim / Extend', def: 'TRIM' }, fillet: { label: 'Fillet / Chamfer', def: 'FILLET' }, array: { label: 'Array', def: 'ARRAYRECT' },
};
const aliasOf = (id: string) => commandById(id)?.aliases[0] ?? id;
const POLAR_STEPS = [90, 45, 30, 22.5, 15, 10, 5];

export const DraftRibbon: React.FC = () => {
  const cmdId = useDraft(s => s.cmd?.id ?? null), recent = useDraft(s => s.recent), aids = useDraft(s => s.aids);
  const activePlane = useDraft(s => s.activePlane), planePick = useDraft(s => s.planePick), planeLabel = useDraft(s => s.planes.find(p => p.id === s.activePlane)?.label ?? 'Ground');
  const ortho = useAppStore(s => s.orthoMode) === OrthoMode.ON, toggleOrtho = useAppStore(s => s.toggleOrthoMode);
  const snapSettings = useAppStore(s => s.snapSettings), toggleSnap = useAppStore(s => s.toggleSnapSetting);
  const [menu, setMenu] = useState<string | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement | null)?.closest?.('.dr-menu,.dr-btn.caret')) setMenu(null); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);
  // Odak düğmede kalmasın: sonraki Enter / Boşluk komut satırına gitsin, düğmeyi yeniden tetiklemesin.
  const run = (id: string) => { setMenu(null); (document.activeElement as HTMLElement | null)?.blur?.(); startCommand(id); };
  const tool = (id: string) => {
    const def = commandById(id)!;
    return (
      <button key={id} className={`dr-btn${cmdId === id ? ' on' : ''}`} onClick={() => run(id)}>
        <DIcon name={id} /><span className="dr-tip">{def.label}<b>{aliasOf(id)}</b></span>
      </button>
    );
  };
  /** Ana düğme son kullanılan yöntemi çalıştırır; ok tüm yöntemleri açar. */
  const family = (key: string) => {
    const f = FAMILIES[key], cur = recent[key] ?? f.def, items = COMMANDS.filter(c => c.family === key), def = commandById(cur)!;
    return (
      <div key={key} style={{ position: 'relative', display: 'flex' }}>
        <button className={`dr-btn${items.some(c => c.id === cmdId) ? ' on' : ''}`} onClick={() => run(cur)}>
          <DIcon name={cur} /><span className="dr-tip">{f.label}: {def.label}<b>{aliasOf(cur)}</b></span>
        </button>
        <button className="dr-btn caret" onClick={() => setMenu(menu === key ? null : key)} aria-label={`${f.label} methods`}><DIcon name="caret" size={11} /></button>
        {menu === key && (
          <div className="dr-menu">
            {items.map(c => <button key={c.id} className={`dr-mi${c.id === cur ? ' on' : ''}`} onClick={() => run(c.id)}><DIcon name={c.id} size={17} />{c.label}<i>{c.id}</i></button>)}
          </div>
        )}
      </div>
    );
  };
  const toggle = (icon: string, label: string, key: string, on: boolean, onClick: () => void) => (
    <button className={`dr-btn${on ? ' on' : ''}`} onClick={onClick} aria-pressed={on}><DIcon name={icon} /><span className="dr-tip">{label}: {on ? 'on' : 'off'}{key && <b>{key}</b>}</span></button>
  );
  const onFace = activePlane !== GROUND_PLANE.id;
  return (
    <div className="dr-row">
      <style>{RIBBON_CSS}</style>
      <span className="dr-cap">Plane</span>
      <div className="dr-grp">
        <button className={`dr-btn txt${!onFace && !planePick ? ' on' : ''}`} onClick={() => activatePlane('ground')}>
          <DIcon name="ground" size={17} />Ground<span className="dr-tip">Draw on the ground plane</span>
        </button>
        <button className={`dr-btn txt${onFace || planePick ? ' on' : ''}`} onClick={() => setPlanePick(!planePick)}>
          <DIcon name="face" size={17} />{planePick ? 'Click a face…' : onFace ? planeLabel : 'Face'}
          <span className="dr-tip">Click a body or panel face to draw on it — the view turns to face it</span>
        </button>
        <button className="dr-btn" onClick={() => viewPlaneFn?.()}><DIcon name="look" /><span className="dr-tip">Look straight at the drawing plane</span></button>
      </div>
      <span className="dr-sep" />
      <span className="dr-cap">Draw</span>
      <div className="dr-grp">{tool('LINE')}{tool('PLINE')}{family('circle')}{family('arc')}{family('shape')}{family('ellipse')}</div>
      <span className="dr-sep" />
      <span className="dr-cap">Modify</span>
      <div className="dr-grp">
        {tool('MOVE')}{tool('COPY')}{tool('STRETCH')}{tool('ROTATE')}{tool('MIRROR')}{tool('SCALE')}{family('trim')}{family('fillet')}{family('array')}
        {tool('ERASE')}{tool('EXPLODE')}{tool('OFFSET')}
      </div>
      <span className="dr-sep" />
      <div className="dr-grp" style={{ marginLeft: 'auto' }}>
        {toggle('ortho', 'Ortho', 'F8', ortho, toggleOrtho)}
        <div style={{ position: 'relative', display: 'flex' }}>
          {toggle('polar', `Polar tracking ${aids.polarStep}°`, 'F10', aids.polar, () => setAids({ polar: !aids.polar }))}
          <button className="dr-btn caret" onClick={() => setMenu(menu === 'polar' ? null : 'polar')} aria-label="Polar angle"><DIcon name="caret" size={11} /></button>
          {menu === 'polar' && (
            <div className="dr-menu" style={{ left: 'auto', right: 0, minWidth: 150 }}>
              {POLAR_STEPS.map(a => (
                <button key={a} className={`dr-mi${aids.polarStep === a ? ' on' : ''}`} onClick={() => { setAids({ polarStep: a, polar: true }); setMenu(null); }}>
                  <span className={`chk${aids.polarStep === a ? ' on' : ''}`} />{a}° increments
                </button>
              ))}
            </div>
          )}
        </div>
        <div style={{ position: 'relative', display: 'flex' }}>
          {toggle('osnap', 'Object snap', 'F3', aids.osnap, () => setAids({ osnap: !aids.osnap }))}
          <button className="dr-btn caret" onClick={() => setMenu(menu === 'osnap' ? null : 'osnap')} aria-label="Object snap modes"><DIcon name="caret" size={11} /></button>
          {menu === 'osnap' && (
            <div className="dr-menu" style={{ left: 'auto', right: 0, minWidth: 176 }}>
              {SNAP_KINDS.map(k => {
                const on = !!snapSettings[k as unknown as SnapType];
                return (
                  <button key={k} className="dr-mi" onClick={() => toggleSnap(k as unknown as SnapType)}>
                    <span className={`chk${on ? ' on' : ''}`} /><SnapGlyph kind={k} size={15} color={on ? '#0f766e' : '#a8a29e'} />{SNAP_LABEL[k]}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {toggle('dyn', 'Dynamic input', '', aids.dyn, () => setAids({ dyn: !aids.dyn }))}
      </div>
    </div>
  );
};

/** Durum çubuğu parçası: etkin düzlem, çizim nesnesi sayısı ve imleç koordinatı. */
export const DraftStatus: React.FC = () => {
  const label = useDraft(s => s.planes.find(p => p.id === s.activePlane)?.label ?? 'Ground'), count = useDraft(s => s.entities.length);
  const selected = useDraft(s => s.selection.length), x = useDraft(s => (s.cursor && s.cmd ? Math.round(s.cursor.p.x * 10) / 10 : null));
  const y = useDraft(s => (s.cursor && s.cmd ? Math.round(s.cursor.p.y * 10) / 10 : null));
  if (!count && label === 'Ground' && x === null) return null;
  const cap: React.CSSProperties = { color: '#9c9590', fontSize: '10.5px', fontWeight: 420, letterSpacing: '0.05em', textTransform: 'uppercase' };
  const val: React.CSSProperties = { color: '#44403c', fontSize: '11px', fontWeight: 500, fontFamily: MONO_FONT };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, paddingLeft: 10, borderLeft: '1px solid rgba(60,50,40,0.14)' }}>
      <span style={cap}>Sketch</span><span style={val}>{label} · {count}{selected ? ` (${selected} sel)` : ''}</span>
      {x !== null && y !== null && <span style={{ ...val, color: '#0f766e' }}>X {x.toFixed(1)}  Y {y.toFixed(1)}</span>}
    </div>
  );
};
