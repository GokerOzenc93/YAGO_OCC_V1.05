import * as THREE from 'three';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Line, Html } from '@react-three/drei';
import { useThree, useFrame } from '@react-three/fiber';
import { useAppStore, OrthoMode, SnapType, type Shape } from '../store';
import { getShapeMatrix } from './Geometry';
import {
  type DraftPlane, type Entity, type Geo, type GeoStyle, type LineS, type P2, type Shape2, type SnapKind, GROUND_PLANE, SNAP_KINDS, SNAP_LABEL,
  activatePlane, closestOn, commandActive, commandById, deg, dist, enterKey, fmt, pointerClick, pointerLeave, pointerMove, selectEntity, setAids, setExtraSnap,
  setPanelOpen, setPlanePick, startCommand, tessellate, useDraft,
} from './Draft';

/* 2B ÇİZİM GÖRÜNÜMÜ — Draft.ts çekirdeğinin sahne katmanı ve sağdaki Drawing paneli.
   DraftLayer (Canvas içinde): çizim düzlemi (zemin · gövde yüzü · panel yüzü), fare → düzlem koordinatı, nesne/önizleme çizimi,
   yakalama işareti, imleç yanında dinamik giriş, yüz seçilince kamerayı yüze karşıdan getirme.
   DrawingPanel (sağdan açılan panel): Plane · Draw · Modify · Object snap · Drafting aids. DraftViewport: panel açıkken 3B görünümü daraltır.
   DraftStatus: durum çubuğu parçası.
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
  const snapOn = useAppStore(s => s.snapEnabled);
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

  // Ortho ve nesne yakalama uygulama geneli ayardır (store) — çizim sürücüsüne yansıtılır.
  useEffect(() => { setAids({ ortho: ortho === OrthoMode.ON, osnap: snapOn, snaps: snapSettings as unknown as Record<SnapKind, boolean> }); }, [ortho, snapOn, snapSettings]);
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

// ═════════════════════════════════════════════════ 3. DRAWING PANELİ ══════════════════════════════════════════════════
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
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" strokeWidth={1.8} />,
  drawing: <><path d="M4 20l1.2-4.4L16.6 4.2a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.4 18.8z" /><path d="M14.5 6.3l3.2 3.2" /><path d="M13 20h7" /></>,
};
const DIcon: React.FC<{ name: string; size?: number }> = ({ name, size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>{ICONS[name]}</svg>
);
// ── Sağ Drawing paneli ──
/* Sağ kenardan açılan panel (sol kenar çubuğunun aynası). Kenardaki dikey "DRAWING" sekmesi paneli açar/kapatır ve panelle birlikte kayar.
   Panel açıkken 3B görünüm sağdan daralır (görünüm küpü ve çizim alanı panelin altında kalmasın). Düğmeler üst araç çubuğuyla aynı ölçüde
   (30 px, ikon 18 px); özelliğe göre gruplanır. Üzerine gelinen aracın adı ve komut kısaltması alttaki okuma şeridinde görünür. */
export const PANEL_W = 268;
const PANEL_SLIDE_MS = 300;
const P = {
  bg: '#f8f6f2', head: '#fcfbf9', border: '#d9d3ca', soft: '#e4dfd7', group: 'rgba(60,50,40,0.14)',
  ink: '#1c1917', body: '#44403c', mute: '#78716c', faint: '#9c9590', accent: '#ea580c',
};
const PANEL_CSS = `
  .dp-root{font-family:${UI_FONT};color:${P.ink};user-select:none}
  .dp-scroll::-webkit-scrollbar{width:10px}
  .dp-scroll::-webkit-scrollbar-thumb{background:rgba(60,50,40,0.18);border-radius:99px;border:2.5px solid transparent;background-clip:padding-box}
  .dp-sec{border-bottom:1px solid ${P.soft}}
  .dp-sec-h{display:flex;align-items:center;gap:6px;height:34px;padding:0 12px 0 10px}
  .dp-sec-t{display:flex;align-items:center;gap:6px;flex:1;height:100%;border:none;background:transparent;padding:0;cursor:pointer;outline:none;
    font:600 10px ${UI_FONT};letter-spacing:0.09em;text-transform:uppercase;color:${P.mute}}
  .dp-sec-t:hover{color:${P.ink}}
  .dp-sec-t svg{transition:transform .18s}
  .dp-sec-t.shut svg{transform:rotate(-90deg)}
  .dp-sec-b{padding:2px 14px 14px}
  .dp-flow{display:flex;flex-wrap:wrap;gap:12px 8px}
  .dp-blk{display:flex;flex-direction:column;gap:5px}
  .dp-cap{font:600 9.5px ${UI_FONT};letter-spacing:0.08em;text-transform:uppercase;color:${P.faint};padding-left:2px}
  .dp-card{display:grid;gap:1px;padding:2px;background:linear-gradient(180deg,#fdfcfa 0%,#f6f3ed 100%);border:1px solid ${P.group};border-radius:8px;
    box-shadow:0 1.5px 3px rgba(40,30,20,0.09),0 0.5px 1px rgba(40,30,20,0.05),0 0 0 0.5px rgba(60,50,40,0.07),inset 0 0.5px 0 rgba(255,255,255,0.95)}
  .dp-btn{position:relative;display:flex;align-items:center;justify-content:center;gap:6px;width:30px;height:30px;padding:0;border:none;border-radius:6px;
    background:transparent;color:#6b6560;cursor:pointer;outline:none;flex-shrink:0;font:500 12px ${UI_FONT};
    transition:background .1s,color .1s,box-shadow .1s,transform .1s}
  .dp-btn:hover{background:rgba(0,0,0,0.05);color:${P.ink};transform:scale(1.06)}
  .dp-btn:active{transform:scale(0.95)}
  .dp-btn.on{background:rgba(234,88,12,0.08);color:${P.accent};box-shadow:0 0 0 1px rgba(234,88,12,0.28);transform:none}
  .dp-btn.txt{width:auto;flex:1;padding:0 8px}
  .dp-btn.txt:hover{transform:none}
  .dp-btn:focus-visible{box-shadow:0 0 0 2px rgba(234,88,12,0.45)}
  .dp-chips{display:grid;grid-template-columns:1fr 1fr;gap:5px}
  .dp-chip{display:flex;align-items:center;gap:7px;height:30px;padding:0 8px;border:none;border-radius:7px;background:#f3f0ea;box-shadow:0 0 0 1px #e6e1d9;
    color:${P.mute};font:500 11.5px ${UI_FONT};cursor:pointer;outline:none;text-align:left;white-space:nowrap;overflow:hidden;
    transition:box-shadow .12s,background .12s,color .12s,opacity .12s}
  .dp-chip:hover{box-shadow:0 0 0 1px #cfc7bc;color:${P.ink}}
  .dp-chip svg{color:#a8a29e}
  .dp-chip.on{background:#fff;color:${P.ink};box-shadow:0 0 0 1px rgba(234,88,12,0.38),0 1px 2px rgba(40,30,20,0.06)}
  .dp-chip.on svg{color:${P.accent}}
  .dp-chip.dim{opacity:0.45}
  .dp-chip.wide{grid-column:span 2}
  .dp-chip kbd{margin-left:auto;font:500 9.5px ${MONO_FONT};color:${P.faint};background:rgba(60,50,40,0.06);padding:1px 4px;border-radius:3px}
  .dp-chip.on kbd{color:#c2410c;background:rgba(234,88,12,0.07)}
  .dp-steps{display:flex;gap:3px}
  .dp-step{flex:1;min-width:0;height:24px;padding:0;border:none;border-radius:5px;background:#f3f0ea;box-shadow:0 0 0 1px #e6e1d9;font:500 10.5px ${MONO_FONT};color:${P.mute};
    cursor:pointer;outline:none;transition:box-shadow .12s,background .12s,color .12s}
  .dp-step:hover{box-shadow:0 0 0 1px #cfc7bc;color:${P.ink}}
  .dp-step.on{background:#fff;color:#c2410c;box-shadow:0 0 0 1px rgba(234,88,12,0.38),0 1px 2px rgba(40,30,20,0.06)}
  .dp-switch{position:relative;width:30px;height:17px;border:none;border-radius:99px;background:#d6d1c8;cursor:pointer;outline:none;flex-shrink:0;
    transition:background .15s;box-shadow:inset 0 1px 2px rgba(40,30,20,0.12)}
  .dp-switch::after{content:'';position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;
    box-shadow:0 1px 2px rgba(40,30,20,0.25);transition:transform .15s}
  .dp-switch.on{background:${P.accent}}
  .dp-switch.on::after{transform:translateX(13px)}
  .dp-x{width:30px;height:30px;display:flex;align-items:center;justify-content:center;border:none;border-radius:6px;background:transparent;color:${P.mute};
    cursor:pointer;outline:none;transition:background .1s,color .1s}
  .dp-x:hover{background:rgba(60,50,40,0.06);color:${P.ink}}
  .dp-tab{position:absolute;top:50%;left:-26px;width:26px;height:118px;padding:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;
    background:${P.bg};border:1px solid ${P.group};border-right:none;border-radius:11px 0 0 11px;cursor:pointer;outline:none;
    transform:translateY(-50%);transition:transform .22s cubic-bezier(0.4,0,0.2,1),box-shadow .22s,background .15s;
    box-shadow:-2px 1px 8px rgba(40,30,20,0.09),-0.5px 0 1px rgba(40,30,20,0.05),inset 0 0.5px 0 rgba(255,255,255,0.95)}
  .dp-tab span{writing-mode:vertical-rl;font:600 10px ${UI_FONT};letter-spacing:0.2em;text-transform:uppercase;color:${P.body};transition:color .15s}
  .dp-tab i{width:5px;height:5px;border-radius:50%;background:${P.accent};box-shadow:0 0 0 3px rgba(234,88,12,0.15)}
  .dp-tab:hover{box-shadow:-4px 3px 16px rgba(40,30,20,0.16),-1.5px 0 4px rgba(40,30,20,0.10),inset 0 0.5px 0 rgba(255,255,255,0.95)}
  .dp-tab:hover span{color:${P.accent}}
  .dp-tab.shut:hover{transform:translateY(-50%) translateX(-3px)}
  .dp-tab.open{background:#fff;border-color:${P.border}}
  .dp-tab.open span{color:${P.accent}}
  .dp-tab.open::before{content:'';position:absolute;left:-1px;top:18px;bottom:18px;width:2px;border-radius:2px;background:linear-gradient(180deg,transparent,#f97316 50%,transparent)}
`;
type Block = { label: string; prefix?: string; ids: string[] };
const DRAW_BLOCKS: Block[] = [
  { label: 'Lines', ids: ['LINE', 'PLINE'] },
  { label: 'Rectangle', ids: ['RECT', 'RECT_ROT', 'RECT_CEN'] },
  { label: 'Circle', prefix: 'Circle', ids: ['CIRCLE', 'CIRCLE_CD', 'CIRCLE_2P', 'CIRCLE_3P', 'CIRCLE_TTR', 'CIRCLE_TTT'] },
  { label: 'Polygon', ids: ['POLY', 'POLY_C', 'POLY_E'] },
  { label: 'Ellipse', prefix: 'Ellipse', ids: ['ELLIPSE', 'ELLIPSE_AXIS', 'ELLIPSE_ARC'] },
  { label: 'Arc', prefix: 'Arc', ids: ['ARC_3P', 'ARC_SCE', 'ARC_SCA', 'ARC_SCL', 'ARC_SEA', 'ARC_SED', 'ARC_SER', 'ARC_CSE', 'ARC_CSA', 'ARC_CSL', 'ARC_CONT'] },
];
const MODIFY_BLOCKS: Block[] = [
  { label: 'Transform', ids: ['MOVE', 'COPY', 'ROTATE', 'SCALE', 'MIRROR', 'STRETCH'] },
  { label: 'Edit', ids: ['TRIM', 'EXTEND', 'OFFSET', 'FILLET', 'CHAMFER'] },
  { label: 'Clean up', ids: ['EXPLODE', 'ERASE'] },
  { label: 'Array', ids: ['ARRAYRECT', 'ARRAYPATH', 'ARRAYPOLAR'] },
];
const MAX_COLS = 7;
const aliasOf = (id: string) => commandById(id)?.aliases[0] ?? id;
const POLAR_STEPS = [90, 45, 30, 22.5, 15, 10, 5];
type Hint = { title: string; key?: string } | null;

const Section: React.FC<{ title: string; right?: React.ReactNode; children: React.ReactNode }> = ({ title, right, children }) => {
  const [open, setOpen] = useState(true);
  return (
    <div className="dp-sec">
      <div className="dp-sec-h">
        <button className={`dp-sec-t${open ? '' : ' shut'}`} onClick={() => setOpen(!open)} aria-expanded={open}><DIcon name="caret" size={12} />{title}</button>
        {right}
      </div>
      {open && <div className="dp-sec-b">{children}</div>}
    </div>
  );
};

export const DrawingPanel: React.FC = () => {
  const open = useDraft(s => s.panelOpen), cmd = useDraft(s => s.cmd), aids = useDraft(s => s.aids);
  const activePlane = useDraft(s => s.activePlane), planePick = useDraft(s => s.planePick);
  const planeLabel = useDraft(s => s.planes.find(p => p.id === s.activePlane)?.label ?? 'Ground');
  const ortho = useAppStore(s => s.orthoMode) === OrthoMode.ON, toggleOrtho = useAppStore(s => s.toggleOrthoMode);
  const snapOn = useAppStore(s => s.snapEnabled), setSnapOn = useAppStore(s => s.setSnapEnabled);
  const snapSettings = useAppStore(s => s.snapSettings), toggleSnap = useAppStore(s => s.toggleSnapSetting);
  const [hint, setHint] = useState<Hint>(null);
  const tip = (title: string, key?: string) => ({ onMouseEnter: () => setHint({ title, key }), onMouseLeave: () => setHint(null) });
  // Odak düğmede kalmasın: sonraki Enter / Boşluk komut satırına gitsin, düğmeyi yeniden tetiklemesin.
  const run = (id: string) => { (document.activeElement as HTMLElement | null)?.blur?.(); startCommand(id); };
  const blocks = (list: Block[]) => (
    <div className="dp-flow">
      {list.map(b => (
        <div key={b.label} className="dp-blk">
          <span className="dp-cap">{b.label}</span>
          <div className="dp-card" style={{ gridTemplateColumns: `repeat(${Math.min(b.ids.length, MAX_COLS)}, 30px)` }}>
            {b.ids.map(id => {
              const def = commandById(id)!, title = b.prefix ? `${b.prefix} · ${def.label}` : def.label;
              return (
                <button key={id} className={`dp-btn${cmd?.id === id ? ' on' : ''}`} onClick={() => run(id)} aria-label={title} {...tip(title, aliasOf(id))}>
                  <DIcon name={id} />
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
  const onFace = activePlane !== GROUND_PLANE.id;
  const readout = hint
    ? <><span style={{ color: P.ink, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{hint.title}</span>
      {hint.key && <kbd style={{ marginLeft: 'auto', font: `500 10px ${MONO_FONT}`, color: '#c2410c', background: 'rgba(234,88,12,0.08)', padding: '2px 5px', borderRadius: 4 }}>{hint.key}</kbd>}</>
    : cmd
      ? <><i style={{ width: 6, height: 6, borderRadius: '50%', background: P.accent, flexShrink: 0 }} />
        <span style={{ color: '#c2410c', fontWeight: 600, fontFamily: MONO_FONT, fontSize: 10.5 }}>{cmd.id.replace('_', ' ')}</span>
        <span style={{ color: P.mute, overflow: 'hidden', textOverflow: 'ellipsis' }}>{cmd.prompt.replace(/^.*? {2}/, '')}</span></>
      : <span style={{ color: P.faint }}>Pick a tool or type a command</span>;

  return (
    <div className="dp-root" style={{
      position: 'absolute', top: 0, right: 0, bottom: 64, width: PANEL_W, zIndex: 35,
      transform: open ? 'translateX(0)' : `translateX(${PANEL_W}px)`, transition: `transform ${PANEL_SLIDE_MS}ms cubic-bezier(0.4,0,0.2,1)`,
    }}>
      <style>{PANEL_CSS}</style>
      <button className={`dp-tab ${open ? 'open' : 'shut'}`} onClick={() => setPanelOpen(!open)} aria-expanded={open}
        title={open ? 'Close the drawing tools' : 'Open the drawing tools'}>
        <span>Drawing</span>
        {cmd && <i />}
      </button>
      <div style={{
        display: 'flex', flexDirection: 'column', height: '100%', background: P.bg, borderLeft: `1px solid ${P.border}`,
        boxShadow: open ? '-4px 0 18px -8px rgba(40,30,20,0.12),-1px 0 2px rgba(40,30,20,0.06)' : 'none',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 40, padding: '0 6px 0 14px', background: P.head, borderBottom: `1px solid ${P.soft}`, flexShrink: 0 }}>
          <span style={{ color: P.accent, display: 'flex' }}><DIcon name="drawing" size={16} /></span>
          <span style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: '0.01em' }}>Drawing</span>
          <span style={{ fontSize: 10.5, fontWeight: 500, color: P.mute, background: 'rgba(60,50,40,0.06)', padding: '2px 7px', borderRadius: 99, whiteSpace: 'nowrap' }}>
            {planeLabel}
          </span>
          <button className="dp-x" style={{ marginLeft: 'auto' }} onClick={() => setPanelOpen(false)} aria-label="Close" {...tip('Close the panel')}><DIcon name="close" size={15} /></button>
        </div>
        <div className="dp-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
          <Section title="Plane">
            <div className="dp-card" style={{ display: 'flex' }}>
              <button className={`dp-btn txt${!onFace && !planePick ? ' on' : ''}`} onClick={() => activatePlane('ground')} {...tip('Draw on the ground plane')}>
                <DIcon name="ground" size={17} />Ground
              </button>
              <button className={`dp-btn txt${onFace || planePick ? ' on' : ''}`} onClick={() => setPlanePick(!planePick)}
                {...tip('Click a body or panel face — the view turns to face it')}>
                <DIcon name="face" size={17} />{planePick ? 'Pick a face…' : 'Face'}
              </button>
              <button className="dp-btn" onClick={() => viewPlaneFn?.()} aria-label="Look at plane" {...tip('Look straight at the drawing plane')}><DIcon name="look" /></button>
            </div>
          </Section>
          <Section title="Draw">{blocks(DRAW_BLOCKS)}</Section>
          <Section title="Modify">{blocks(MODIFY_BLOCKS)}</Section>
          <Section title="Object snap"
            right={<button className={`dp-switch${snapOn ? ' on' : ''}`} onClick={() => setSnapOn(!snapOn)} aria-pressed={snapOn} aria-label="Object snap"
              {...tip(`Object snap ${snapOn ? 'on' : 'off'}`, 'F3')} />}>
            <div className="dp-chips">
              {SNAP_KINDS.map(k => {
                const on = !!snapSettings[k as unknown as SnapType];
                return (
                  <button key={k} className={`dp-chip${on ? ' on' : ''}${snapOn ? '' : ' dim'}`} onClick={() => toggleSnap(k as unknown as SnapType)} aria-pressed={on}>
                    <SnapGlyph kind={k} size={16} color="currentColor" />{SNAP_LABEL[k]}
                  </button>
                );
              })}
            </div>
          </Section>
          <Section title="Drafting aids">
            <div className="dp-chips">
              <button className={`dp-chip${ortho ? ' on' : ''}`} onClick={toggleOrtho} aria-pressed={ortho} {...tip('Ortho — lock to horizontal / vertical', 'F8')}>
                <DIcon name="ortho" size={16} />Ortho<kbd>F8</kbd>
              </button>
              <button className={`dp-chip${aids.polar ? ' on' : ''}`} onClick={() => setAids({ polar: !aids.polar })} aria-pressed={aids.polar}
                {...tip(`Polar tracking every ${aids.polarStep}°`, 'F10')}>
                <DIcon name="polar" size={16} />Polar<kbd>F10</kbd>
              </button>
              <button className={`dp-chip wide${aids.dyn ? ' on' : ''}`} onClick={() => setAids({ dyn: !aids.dyn })} aria-pressed={aids.dyn}
                {...tip('Dynamic input — prompt and length / angle next to the cursor', 'Tab')}>
                <DIcon name="dyn" size={16} />Dynamic input<kbd>Tab</kbd>
              </button>
            </div>
            <div className="dp-cap" style={{ margin: '12px 0 5px' }}>Polar angle</div>
            <div className="dp-steps">
              {POLAR_STEPS.map(a => (
                <button key={a} className={`dp-step${aids.polarStep === a && aids.polar ? ' on' : ''}`} onClick={() => setAids({ polarStep: a, polar: true })}
                  {...tip(`Track every ${a}°`)}>{a}°</button>
              ))}
            </div>
          </Section>
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 7, height: 34, padding: '0 14px', borderTop: `1px solid ${P.soft}`, background: P.head,
          fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', flexShrink: 0,
        }}>{readout}</div>
      </div>
    </div>
  );
};

/** 3B görünüm sarmalayıcısı: panel açılınca hemen daralır (panel boşalan yere kayar), kapanınca kayma bitince genişler — tuval tek kez yeniden boyutlanır. */
export const DraftViewport: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const open = useDraft(s => s.panelOpen);
  const [inset, setInset] = useState(open ? PANEL_W : 0);
  useEffect(() => {
    if (open) { setInset(PANEL_W); return; }
    const t = window.setTimeout(() => setInset(0), PANEL_SLIDE_MS);
    return () => window.clearTimeout(t);
  }, [open]);
  return <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, right: inset }}>{children}</div>;
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
