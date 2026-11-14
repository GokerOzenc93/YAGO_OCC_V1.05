import * as THREE from 'three';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Line, Html } from '@react-three/drei';
import { useThree, useFrame } from '@react-three/fiber';
import { useAppStore, OrthoMode, SnapType, type Shape, type SketchFeature, childPanelsOf, requestRebuild, shapeById, vfOfPanel } from '../store';
import {
  createFaceHighlightGeometry, effectiveBodyGeometry, footprintGeometry, genId, getFacesAndGroups, getShapeMatrix, groupIndexOfFace, placeSketchShapes,
  rebuildBodySolid, setSketchSuppressed, sketchFrameOf, sketchVarsOf, type SketchFrame,
} from './Geometry';
import { panelStepRotation, whenRebuildIdle } from './PanelEngine';
import {
  type DraftIsolate, type SketchApply, type DraftPlane, type DraftFace, type BindDefault, type CircleS, type SketchBind, type Entity, type Geo, type GeoStyle, type LineS, type P2, type Shape2, type SnapKind, type V3, GROUND_PLANE, SNAP_KINDS,
  SNAP_LABEL, activatePlane, cancelCommand, closestOn, commandActive, commandById, deg, dist, enterKey, fmt, loadEntities, moveShape, pointerClick, pointerLeave,
  pointerMove, profileLoops, selectEntity, setAids, setApply, setExtraSnap, setIsolate, setPanelOpen, setPlaneCandidate, setPlaneConfirm, setPlanePick, setSession,
  startCommand, stripEnt, takeEntities, tessellate, useDraft,
  autoKind, bindCoord, bindText, bindsOf, ctrlPoints, evalExpr, movePointsTo, paramTargets, parseBind, pointAt, prefsOf, ptKey,
  segmentAt, selectPoints, setCircleRadius, setFace, setPHover, setPointPrefs, setRefEdges, togglePoint,
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
function planeEdges(inv: THREE.Matrix4, list: Shape[], shapes: Shape[]): LineS[] {
  const out: LineS[] = [], a = new THREE.Vector3(), b = new THREE.Vector3(), m = new THREE.Matrix4();
  for (const s of list) {
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
/** Yüz adayı: çizim düzlemi + hedef + vurgu geometrisi (gövde-yerel) + kamera hedefi. */
type FacePick = {
  plane: Omit<DraftPlane, 'id'>; shapeId: string; kind: 'panel' | 'body'; bodyId: string; label: string; key: string;
  center: THREE.Vector3; normal: THREE.Vector3; up: THREE.Vector3; extent: number; highlight: THREE.BufferGeometry; hostM: THREE.Matrix4;
};
const isPanel = (s: Shape) => s.type === 'panel';
const bodyIdOf = (s: Shape): string => (isPanel(s) ? (s.parameters?.parentShapeId as string) || s.id : s.id);
/** Çizilen (tıklanabilir) geometri: panelde kendi mesh'i, gövdede vertex düzenlemeleri uygulanmış mesh. */
const shownGeometryOf = (s: Shape) => (isPanel(s) ? s.geometry : effectiveBodyGeometry(s));
/** İzolasyonda yalnız görünen şekiller: hedef panel (+ gövdesi) ya da hedef gövde. */
const visibleShapes = (shapes: Shape[], iso: DraftIsolate | null) =>
  (iso ? shapes.filter(s => s.id === iso.targetId) : shapes);
/** Tıklanan gövde / panel yüzünden aday: X sağa, Y yukarı (yatay yüzde arkaya), orijin yüzün sol-alt köşesi.
 *  Panelde orijin KESİLMEMİŞ mesh'ten okunur (çizim adımı uygulanmış panelde de yüzün gerçek köşesi). */
function facePickOf(shape: Shape, hit: THREE.Intersection, shapes: Shape[]): FacePick | null {
  const geo = (hit.object as THREE.Mesh).geometry;
  const { faces, groups } = getFacesAndGroups(geo);
  const gi = groupIndexOfFace(groups, hit.faceIndex ?? undefined);
  if (!hit.face || gi < 0 || groups[gi].isCurved) return null;
  const hostM = hostMatrix(shape, shapes), hostInv = hostM.clone().invert();
  const nL = hit.face.normal.clone();
  (['x', 'y', 'z'] as const).forEach(k => { if (Math.abs(nL[k]) < 1e-6) nL[k] = 0; });
  nL.normalize();
  const nW = nL.clone().transformDirection(hostM);
  let vW = Math.abs(nW.y) > 0.9 ? new THREE.Vector3(0, 0, nW.y > 0 ? -1 : 1) : new THREE.Vector3(0, 1, 0);
  const uW = new THREE.Vector3().crossVectors(vW, nW).normalize();
  vW = new THREE.Vector3().crossVectors(nW, uW).normalize();
  const uL = uW.clone().transformDirection(hostInv), vL = vW.clone().transformDirection(hostInv), pL = hit.point.clone().applyMatrix4(hostInv);
  const src = (isPanel(shape) ? footprintGeometry(shape) : null) ?? geo;
  const pos = src.getAttribute('position'), q = new THREE.Vector3();
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
  const label = isPanel(shape) ? vfOfPanel(shape)?.description || 'Panel' : 'Body';
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    plane: { kind: 'face', shapeId: shape.id, origin: origin.toArray() as V3, u: uL.toArray() as V3, v: vL.toArray() as V3, n: nL.toArray() as V3, label },
    shapeId: shape.id, kind: isPanel(shape) ? 'panel' : 'body', bodyId: bodyIdOf(shape), label,
    key: `${shape.id}|${r3(nL.x)},${r3(nL.y)},${r3(nL.z)}|${Math.round(pL.dot(nL) * 10)}`,
    center, normal: nW, up: vW, extent: Math.max(u1 - u0, v1 - v0, 100), highlight: createFaceHighlightGeometry(faces, groups[gi].faceIndices), hostM,
  };
}
/** Şeklin ANA yüzü: en geniş düz yüz (eşit iki geniş yüzden kameraya bakan). Panel satırındaki Sketch aracı seçime bununla başlar. */
function mainFacePick(shape: Shape, shapes: Shape[], camPos: THREE.Vector3 | null): FacePick | null {
  const geo = shownGeometryOf(shape);
  if (!geo?.getAttribute?.('position')) return null;
  const { faces, groups } = getFacesAndGroups(geo), hostM = hostMatrix(shape, shapes);
  let best = -1, bestScore = -Infinity;
  groups.forEach((g, i) => {
    if (g.isCurved || !g.faceIndices.length) return;
    const area = g.faceIndices.reduce((a, fi) => a + (faces[fi]?.area ?? 0), 0);
    const toCam = camPos ? g.normal.clone().transformDirection(hostM).dot(camPos.clone().sub(g.center.clone().applyMatrix4(hostM))) : 0;
    const score = area * (toCam > 0 ? 1.001 : 1);
    if (score > bestScore) { bestScore = score; best = i; }
  });
  const f = best >= 0 ? faces[groups[best].faceIndices[0]] : undefined;
  if (!f) return null;
  // facePickOf vuruştan yalnız geometriyi, üçgen indeksini, yerel normali ve dünya noktasını okur.
  const hit = { object: new THREE.Mesh(geo), faceIndex: f.faceIndex, face: { normal: groups[best].normal.clone().normalize() }, point: f.center.clone().applyMatrix4(hostM) };
  return facePickOf(shape, hit as unknown as THREE.Intersection, shapes);
}
/** Işın boyunca yüz adayları, yakından uzağa. Panelli gövdenin mesh'i sahnede GÖRÜNMEZ (opaklık 0) → o gövdenin yüzleri sıranın sonuna
 *  alınır: ilk tık her zaman görünen paneli vurgular, gövde yüzüne aynı noktaya tekrar tıklayarak geçilir. `only`: yalnız o şekil. */
function faceCandidates(ray: THREE.Ray, shapes: Shape[], iso: DraftIsolate | null, only?: string | null, max = 8): FacePick[] {
  const byMesh = new Map<THREE.Object3D, Shape>(), list = visibleShapes(shapes, iso);
  for (const s of list) {
    if (only && s.id !== only) continue;
    const g = shownGeometryOf(s);
    if (!g?.getAttribute?.('position')) continue;
    const mesh = new THREE.Mesh(g);
    mesh.matrixAutoUpdate = false; mesh.matrixWorld.copy(hostMatrix(s, shapes));
    byMesh.set(mesh, s);
  }
  const all = new THREE.Raycaster(ray.origin, ray.direction).intersectObjects([...byMesh.keys()], false).filter(h => h.face);
  const hosts = new Set(list.filter(isPanel).map(bodyIdOf));
  const ghost = (h: THREE.Intersection) => hosts.has(byMesh.get(h.object)!.id);
  const hits = [...all.filter(h => !ghost(h)), ...all.filter(ghost)];
  const out: FacePick[] = [], seen = new Set<string>();
  for (const hit of hits) {
    const pick = facePickOf(byMesh.get(hit.object)!, hit, shapes);
    if (!pick || seen.has(pick.key)) continue;
    seen.add(pick.key); out.push(pick);
    if (out.length >= max) break;
  }
  return out;
}
/** Kamerayı düzleme karşıdan getirir: hedef yüz merkezi, bakış yüz normali boyunca, yüz ekrana sığar. */
type OrbitLike = { target: THREE.Vector3; enableDamping: boolean; update: () => void } | null | undefined;
let flyGen = 0, flyDamping: boolean | null = null;   // üst üste binen uçuşlarda yalnız sonuncusu sürer; sönümleme ilk uçuştan önceki değere döner
/** Tuvalin GÖRÜNEN bölgesi: açık sol kenar paneli tuvalin üstünü örter (tuval daralmaz) → yüz, kalan bölgenin ortasına getirilir. */
function viewInset(canvas: HTMLElement): { shiftPx: number; visW: number } {
  const r = canvas.getBoundingClientRect(), sb = document.querySelector('[data-yago-sidebar="open"]')?.getBoundingClientRect();
  const cover = sb && sb.left <= r.left + 2 && sb.right > r.left ? Math.min(sb.right - r.left, r.width * 0.7) : 0;
  return { shiftPx: cover / 2, visW: r.width - cover };
}
function flyTo(camera: THREE.Camera, controls: OrbitLike, focus: THREE.Vector3, dir: THREE.Vector3, up: THREE.Vector3, extent: number, viewH: number,
  exact?: { dist: number; zoom: number } | null, view?: { shiftPx: number; visW: number }, done?: () => void) {
  if (!controls?.target) return;
  const persp = camera as THREE.PerspectiveCamera, ortho = camera as THREE.OrthographicCamera;
  const startT = controls.target.clone(), startDir = camera.position.clone().sub(startT), startDist = startDir.length() || 1;
  startDir.normalize();
  const endDir = dir.clone().normalize(), endUp = up.clone().normalize(), startUp = camera.up.clone();
  const fit = view ? Math.min(1, Math.max(0.3, view.visW / viewH)) : 1, tanHalf = persp.isPerspectiveCamera ? Math.tan((persp.fov * Math.PI / 180) / 2) : 0;
  const endDist = exact ? exact.dist : persp.isPerspectiveCamera ? Math.max(250, (extent * 0.8) / tanHalf / fit) : startDist;
  const startZoom = ortho.zoom, endZoom = exact ? exact.zoom : ortho.isOrthographicCamera ? (viewH / (extent * 1.6)) * fit : startZoom;
  // Odak noktası görünen bölgenin ortasına: kamera hedefi ekranda `shiftPx` kadar sola kayar.
  const target = focus.clone();
  if (view?.shiftPx) {
    const wpp = persp.isPerspectiveCamera ? (2 * endDist * tanHalf) / viewH : (ortho.top - ortho.bottom) / endZoom / viewH;
    target.addScaledVector(new THREE.Vector3().crossVectors(endUp, endDir).normalize(), -view.shiftPx * wpp);
  }
  const full = new THREE.Quaternion().setFromUnitVectors(startDir, endDir), ident = new THREE.Quaternion(), step = new THREE.Quaternion();
  const curDir = new THREE.Vector3(), curT = new THREE.Vector3();
  const gen = ++flyGen;
  if (flyDamping === null) flyDamping = controls.enableDamping;
  controls.enableDamping = false;
  const t0 = performance.now(), dur = 420;
  const tick = () => {
    if (gen !== flyGen) return;
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
    if (raw < 1) requestAnimationFrame(tick); else { controls.enableDamping = flyDamping ?? controls.enableDamping; flyDamping = null; done?.(); }
  };
  tick();
}
/** Yüze / düzleme KARŞIDAN bakış bittiğinde: perspektifteyse ortografiğe geçilir (Scene.CameraController — çerçeve korunur). */
const toOrtho = () => { void (window as any).__cameraAuto?.('ortho'); };
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
            // Referans kenar (panelin / gövdenin kendi çizgisi): ince ve soluk; üzerine gelince / seçilince öteki nesneler gibi vurgulanır.
            const ref = !!e.ref && !sel && !hov;
            if (ref) return null;   // panelin kendi kenarı zaten sahnede çizili — üstüne ikinci bir çizgi kalabalık yapar
            return <DLine key={e.id} s={e} color={sel ? COL.sel : hov ? COL.hi : ref ? COL.hi : active ? COL.ent : COL.other} width={sel ? 2.2 : hov ? 2.6 : ref ? 1.2 : active ? 1.7 : 1.3}
              dash={sel ? dash * 5 : 0} order={sel || hov ? 21 : 20} depth opacity={ref ? 0.5 : 1} />;
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
// ── YÜZ OTURUMU: aday → onay → izolasyon; çizim adımı yaz / düzenle / sil ──
/* Goker (Kas 2026): "yüz seçimini tıkladıkça seçilecek yüzeyi göstersin, onaylayınca çalışsın, diğer paneller izole olsun; çizimi panelin
   yüzeyine göre parametrik yapıp panelden / yüzeyden çıkarayım ya da panele şeklini vereyim; sonradan çizimi düzenleyebileyim."
   Adım hedefin `parameters.sketchFeatures` listesine yazılır (store.SketchFeature); katıya Geometry.applySketchFeatures uygular
   (panelde motorun son geçişi, gövdede rebuildBodySolid). Düzenleme: adımın nesneleri geçici bir düzleme yüklenir, o adım bastırılır
   (katı adımsız görünür), kaydedince nesneler çapaya göre geri yazılır. */
type CamPose = { pos: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3; zoom: number };
const sceneApi: {
  fly: ((center: THREE.Vector3, normal: THREE.Vector3, up: THREE.Vector3, extent: number) => void) | null;
  pose: (() => CamPose | null) | null; restore: ((p: CamPose) => void) | null;
} = { fly: null, pose: null, restore: null };
let savedPose: CamPose | null = null;      // yüze geçmeden önceki kamera — yüzden çıkınca geri gelir
let applyBeforeEdit: SketchApply | null = null;   // adım düzenlenirken panel o adımın ayarlarını gösterir; bitince öncekiler döner
const keepPose = () => { if (!savedPose) savedPose = sceneApi.pose?.() ?? null; };
/** Yüzden çıkış: zemin düzlemi, izolasyon kalkar, kamera yüze geçmeden önceki yerine döner. */
function leaveFace() {
  activatePlane('ground'); setIsolate(null);
  if (savedPose) { sceneApi.restore?.(savedPose); savedPose = null; }
}
let pickOnly: string | null = null;        // yüz seçimi yalnız bu şekilde (panel satırındaki Sketch aracı)
let prePick = false;                       // Sketch aracı paneli seçim için tek başına karşıya aldı (onaylanmazsa geri alınır)
let candidate: FacePick | null = null;     // onay bekleyen aday (depoda yalnız etiketi durur)
const v3 = (a: ArrayLike<number>) => new THREE.Vector3(a[0], a[1], a[2]);
const arr3 = (v: THREE.Vector3): V3 => [v.x, v.y, v.z];
export const sketchFeaturesOf = (s: Shape | undefined | null): SketchFeature[] => (s?.parameters?.sketchFeatures as SketchFeature[] | undefined) ?? [];
/** Etkin yüz düzleminin hedefi (panel / gövde). */
export function faceTarget(): { plane: DraftPlane; shape: Shape; kind: 'panel' | 'body'; bodyId: string } | null {
  const st = useDraft.getState(), plane = st.planes.find(p => p.id === st.activePlane);
  const shape = plane?.kind === 'face' ? shapeById(plane.shapeId) : undefined;
  return plane && shape ? { plane, shape, kind: isPanel(shape) ? 'panel' : 'body', bodyId: bodyIdOf(shape) } : null;
}
/** Onaylanmadan biten Sketch aracı seçimi: ön izolasyon kalkar, kamera eski yerine döner (`stay`: yüz kipinde kalınacak — kamera dönmez). */
function dropPrePick(stay = false) {
  if (!prePick) return;
  prePick = false; pickOnly = null; candidate = null;
  setIsolate(null);
  if (!stay && savedPose) { sceneApi.restore?.(savedPose); savedPose = null; }
}
/** Yüz seçimini başlatır. `onlyShapeId` (panel satırındaki Sketch aracı): panel tek başına ve karşıdan gösterilir, ana yüzü aday olarak
 *  vurgulanır — kullanıcı onaylar ya da panelin başka bir yüzüne tıklar (panel listede / başka panellerin arkasında kalsa da görünür). */
export function beginFacePick(onlyShapeId: string | null = null) {
  if (useDraft.getState().session) return;   // düzenleme oturumu sürerken yüz değiştirilmez
  dropPrePick(true);
  pickOnly = onlyShapeId; candidate = null;
  setIsolate(null); setPanelOpen(true); setPlanePick(true);
  (document.activeElement as HTMLElement | null)?.blur?.();   // odak düğmede kalırsa Enter onay yerine düğmeyi yeniden tetikler
  const only = onlyShapeId ? shapeById(onlyShapeId) : undefined;
  const c = only ? mainFacePick(only, useAppStore.getState().shapes, sceneApi.pose?.()?.pos ?? null) : null;
  if (!c) return;
  candidate = c; setPlaneCandidate({ label: c.label });
  keepPose(); prePick = true;
  setIsolate({ targetId: c.shapeId, bodyId: c.bodyId, kind: c.kind });
  sceneApi.fly?.(c.center, c.normal, c.up, c.extent);
}
export function cancelFacePick(stay = false) { dropPrePick(stay); pickOnly = null; candidate = null; setPlanePick(false); }
/** Etkin yüzün hedefindeki, O YÜZE yazılmış çizim adımları (aynı dışa normal + aynı derinlik). */
export async function faceSteps(): Promise<SketchFeature[]> {
  const ft = faceTarget();
  if (!ft) return [];
  const st = useDraft.getState(), feats = sketchFeaturesOf(ft.shape);
  if (!feats.length) return [];
  // Düzenleme oturumunun düzlemi adımın kendi çerçevesidir → aynı yüzün adımları o adımın yönüyle süzülür.
  const cur = st.session ? feats.find(f => f.id === st.session!.featureId) : undefined;
  const ref = cur ? { n: cur.n, inset: cur.inset } : await frameOfPlane(ft.shape, ft.plane).catch(() => null);
  if (!ref) return [];
  return feats.filter(f => v3(f.n).dot(v3(ref.n)) > 0.999 && Math.abs((f.inset || 0) - (ref.inset || 0)) < 0.5);
}
/** Vurgulanan adayı çizim düzlemi yapar: kamera yüze karşıdan gelir, hedef dışındaki paneller gizlenir.
 *  YÜZDE ÇİZİM ADIMI VARSA (Goker, Kas 2026 — "çizimi yaptıktan sonra tekrar düzenlemek çok karışık; yüze girince hazır gelsin"): son adım
 *  kendiliğinden düzenlemeye açılır (nesneleri yüze yüklenir, Apply o adımı günceller) — Assembly'de adımı bulup kaleme basmak gerekmez.
 *  Yüzde uygulanmamış serbest çizim duruyorsa dokunulmaz (o çizim yeni bir adım olacaktır). */
export function confirmFacePick() {
  const c = candidate;
  if (!c) return;
  candidate = null; pickOnly = null; prePick = false;
  keepPose();
  const planeId = activatePlane(c.plane);
  setIsolate({ targetId: c.shapeId, bodyId: c.bodyId, kind: c.kind });
  sceneApi.fly?.(c.center, c.normal, c.up, c.extent);
  void (async () => {
    const st = useDraft.getState();
    if (st.session || st.entities.some(e => e.plane === planeId && !e.ref)) return;
    const on = await faceSteps();
    const now = useDraft.getState();
    if (!on.length || now.session || now.activePlane !== planeId || now.planePick) return;
    await editSketch(c.shapeId, on[on.length - 1].id);
  })();
}
setPlaneConfirm(confirmFacePick);
export function toggleIsolate() {
  if (useDraft.getState().isolate) { setIsolate(null); return; }
  const t = faceTarget();
  if (t) setIsolate({ targetId: t.shape.id, bodyId: t.bodyId, kind: t.kind });
}
/** Zemine dön: oturum varsa kaydedilmeden kapanır, izolasyon kalkar, kamera eski yerine döner. */
export async function exitFace() {
  cancelFacePick();
  if (useDraft.getState().session) await finishSketchEdit(false); else leaveFace();
}
// İZOLASYON — TEK KURAL (Goker, Kas 2026 — "çıktığımda panellerin izole olma durumunu MUTLAKA kaldırsın"): izolasyon yalnız yüz seçimi
// sürerken, bir yüz düzlemi etkinken ya da adım düzenlenirken geçerlidir. Bu üçü de yoksa — hangi yoldan çıkılmış olursa olsun (Esc,
// başka komut, panelin kapanması, hedefin silinmesi, unutulmuş bir çıkış noktası) — izolasyon kalkar ve kamera yüze geçmeden önceki
// yerine döner. Drawing paneli kapanınca yüz kipinden de çıkılır (araçlar yokken izole görünümde kalınmaz).
useDraft.subscribe((st, prev) => {
  if (st.isolate && !st.planePick && !st.session && st.activePlane === GROUND_PLANE.id) {
    setIsolate(null);
    if (savedPose) { const p = savedPose; savedPose = null; sceneApi.restore?.(p); }
  }
  if (prev.panelOpen && !st.panelOpen && (st.activePlane !== GROUND_PLANE.id || st.planePick || st.session)) void exitFace();
  // Adım düzenlenirken oturum düzleminden çıkıldıysa (zemine / başka düzleme geçen bir komut) oturum da kapanır — açık kalan oturum
  // izolasyonu ve bastırılmış adımı asılı bırakırdı.
  else if (st.session && st.session === prev.session && prev.activePlane === st.session.planeId && st.activePlane !== st.session.planeId) void finishSketchEdit(false);
});
/** Hedefin çizim adımları UYGULANMAMIŞ mesh'i (yüz çerçevesinin okunduğu): panelde ayak izi mesh'i, gövdede adımsız katı. */
const uncutCache = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();   // gövde mesh'i → adımsız mesh'i (gövde yeniden kurulunca düşer)
async function uncutMeshOf(target: Shape): Promise<THREE.BufferGeometry> {
  if (isPanel(target)) return footprintGeometry(target) ?? target.geometry;
  if (!sketchFeaturesOf(target).length) return target.geometry;
  const hit = uncutCache.get(target.geometry);
  if (hit) return hit;
  const g = (await rebuildBodySolid({ parameters: target.parameters, fillets: target.fillets }, target.subtractionGeometries, undefined, false, false)).geometry;
  uncutCache.set(target.geometry, g);
  return g;
}
/** Düzlemin yüz çerçevesi: yüz ölçüsü, adımda saklanacak (dönüş öncesi) yönler + inset, ve düzlem → çerçeve ötelemesi (dx, dy). */
async function frameOfPlane(target: Shape, plane: Pick<DraftPlane, 'origin' | 'u' | 'n'>):
  Promise<{ fr: SketchFrame; n: V3; u: V3; inset: number; dx: number; dy: number } | null> {
  const q = stepRotationOf(target), qi = q.clone().invert();
  // Yüz yönleri dönüş ÖNCESİ saklanır → panele sonradan eklenen / yeniden çözülen dönüş çizimi birlikte taşır.
  const n = arr3(v3(plane.n).applyQuaternion(qi)), u = arr3(v3(plane.u).applyQuaternion(qi));
  const mesh = await uncutMeshOf(target), f0 = sketchFrameOf(mesh, n, u, 0, q);
  if (!f0) return null;
  const depthIn = f0.o.clone().sub(v3(plane.origin)).dot(f0.n), inset = depthIn > 0.05 ? depthIn : 0;
  const fr = sketchFrameOf(mesh, n, u, inset, q)!;
  const d = v3(plane.origin).sub(fr.o);
  return { fr, n, u, inset, dx: d.dot(fr.u), dy: d.dot(fr.v) };
}
/** Hedefin formül değişkenleri: gövde ölçüleri + gövdenin özel parametreleri (panelde üst gövdeninkiler). */
const varsOfTarget = (target: Shape): Record<string, number> => sketchVarsOf(shapeById(bodyIdOf(target))?.parameters);
let faceTick = 0;
/** Etkin yüzün çerçevesini depoya yazar (Parametric kip: bağ değerleri, formül değişkenleri, önizleme bunu okur). Yüz yoksa temizler. */
async function syncFace() {
  const tick = ++faceTick, ft = faceTarget();
  if (!ft) { if (useDraft.getState().face) setFace(null); return; }
  const r = await frameOfPlane(ft.shape, ft.plane).catch(() => null);
  if (tick !== faceTick) return;
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6 || 0;   // kayan nokta gürültüsü depoyu boşuna yenilemesin
  const next: DraftFace | null = r ? (() => {
    const w = r6(r.fr.w), h = r6(r.fr.h);
    return { planeId: ft.plane.id, dx: r6(r.dx), dy: r6(r.dy), w, h, vars: { ...varsOfTarget(ft.shape), W: w, H: h } };
  })() : null;
  if (JSON.stringify(next) !== JSON.stringify(useDraft.getState().face)) setFace(next);
}
const anchorKind = (a: number): 'L' | 'R' | 'C' => (a === 0 ? 'L' : a === 1 ? 'R' : 'C');
const bindDefaults = (a: SketchApply): [BindDefault, BindDefault] => (a.auto ? ['A', 'A'] : [anchorKind(a.anchor[0]), anchorKind(a.anchor[1])]);
/** Çizim nesnelerinden adımın geometri alanları. Simple: nesneler çapaya göre + uzama. Parametric: nesneler yüz çerçevesinde, her kontrol
 *  noktası kendi bağıyla (tercih → yoksa varsayılan; değer koordinattan), dairelerde geçerliyse yarıçap formülü. */
function sketchPayload(ents: Entity[], a: SketchApply, w: number, h: number, dx: number, dy: number, vars: Record<string, number>):
  Pick<SketchFeature, 'anchor' | 'stretch' | 'baseSize' | 'shapes' | 'mode' | 'pts' | 'radii'> {
  if (a.mode !== 'points') {
    const off = { x: dx - a.anchor[0] * w, y: dy - a.anchor[1] * h };
    return { anchor: [...a.anchor], stretch: [...a.stretch], baseSize: [w, h], shapes: ents.map(e => moveShape(stripEnt(e), off)) };
  }
  const v = { ...vars, W: w, H: h }, shapes = ents.map(e => moveShape(stripEnt(e), { x: dx, y: dy })), dflt = bindDefaults(a);
  const radii = ents.map(e => { if (e.t !== 'circle' || !e.re) return null; const r = evalExpr(e.re, v); return r !== null && Math.abs(r - e.r) < 0.02 ? e.re : null; });
  return {
    anchor: [...a.anchor], stretch: [false, false], baseSize: [w, h], shapes, mode: 'points',
    pts: shapes.map((sh, i) => bindsOf(sh, ents[i].pb, w, h, dflt, vars)), ...(radii.some(Boolean) ? { radii } : {}),
  };
}
const stepRotationOf = (target: Shape) => (isPanel(target) ? panelStepRotation(target) : new THREE.Quaternion());
/** GÖVDE ŞEKLE UYAR (Goker, Kas 2026 — "referans kutuya çizerek şekil verdiysem en dış sınırlarındaki ölçüleri alsın"): gövdenin TAM bir
 *  dış yüzüne çizilen Shape profili kutudan taşıyorsa kutuyla kırpılıyor (kemerin tepesi düzleşiyor), küçükse gövdenin W / H / D değerleri
 *  eski kutunun ölçüsü olarak kalıyordu. Profilin yüz çerçevesindeki dış kutusu okunur; gövdenin o iki ölçüsü ona eşitlenir, gövde
 *  profilin sol-alt sınırına ötelenir (şekil dünyada yerinden oynamaz; panelleri gövdeyle taşınır). Kutu profilin dışında ≤ 0,01 mm pay
 *  bırakacak şekilde yuvarlanır (yay tepesi kutu yüzüyle kesilip incecik düz yüz doğmasın). Dönen değerler yeni çerçevenin ölçüsü ve
 *  çizimin yeni çerçeveye göre ötelemesidir; uyarlama yapılmadıysa null.
 *  FORMÜLE BAĞLI nokta / yarıçap varsa (Parametric) uyarlama yapılmaz: formüller kutunun kenarlarından ve W / H değerlerinden ölçülür,
 *  kutuyu değiştirmek onları geçersiz kılar (bindsOf formülü düşürürdü) — orada kutu referanstır, şekil kutuyu izler. */
function fitBodyToProfile(target: Shape, fr: SketchFrame, ents: Entity[], dx: number, dy: number, param: boolean): { w: number; h: number; dx: number; dy: number } | null {
  if (isPanel(target) || target.vertexModifications?.length) return null;
  if (param && ents.some(e => (e.t === 'circle' && !!e.re) || e.pb?.some(b => b?.x?.k === 'F' || b?.y?.k === 'F'))) return null;
  const P = target.parameters as { width?: number; height?: number; depth?: number };
  const dims = [Number(P.width), Number(P.height), Number(P.depth)];
  if (dims.some(d => !Number.isFinite(d))) return null;
  const axisOf = (v: THREE.Vector3) => { const a = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)], i = a.indexOf(Math.max(...a)); return a[i] > 0.9999 ? { i, s: Math.sign(v.getComponent(i)) } : null; };
  const U = axisOf(fr.u), V = axisOf(fr.v);
  if (!U || !V || U.i === V.i) return null;
  if (Math.abs(fr.w - dims[U.i]) > 0.05 || Math.abs(fr.h - dims[V.i]) > 0.05) return null;   // gövdenin tam dış yüzü değil (basamak / iç yüz)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of ents) for (const p of tessellate(e, Math.PI / 720)) { x0 = Math.min(x0, p.x + dx); y0 = Math.min(y0, p.y + dy); x1 = Math.max(x1, p.x + dx); y1 = Math.max(y1, p.y + dy); }
  if (!(x1 - x0 > 1) || !(y1 - y0 > 1)) return null;
  const lo = (v: number) => Math.floor(v * 100 + 1e-6) / 100, up = (v: number) => Math.ceil(v * 100 - 1e-6) / 100;
  const ox = lo(x0), oy = lo(y0), w = up(x1 - ox), h = up(y1 - oy);
  if (Math.abs(ox) < 0.011 && Math.abs(oy) < 0.011 && Math.abs(w - fr.w) < 0.011 && Math.abs(h - fr.h) < 0.011) return null;
  // Çerçevenin 0 noktası yüzün (u, v) en küçük köşesidir; u / v gövde ekseninin tersine bakıyorsa kutu öbür uçtan ölçülür.
  const shift = new THREE.Vector3();
  shift.setComponent(U.i, U.s > 0 ? ox : fr.w - (ox + w));
  shift.setComponent(V.i, shift.getComponent(V.i) + (V.s > 0 ? oy : fr.h - (oy + h)));
  const size = [...dims]; size[U.i] = w; size[V.i] = h;
  const pos = arr3(shift.clone().applyMatrix4(hostMatrix(target, useAppStore.getState().shapes)));
  // Gövde + kendi panelleri taşınır (updateShape grubun öbür üyelerini de ötelerdi — şekil yerinde kaldığı için onlar oynamamalı).
  useAppStore.setState(st => ({
    shapes: st.shapes.map(x => (x.id === target.id ? { ...x, position: pos, parameters: { ...x.parameters, width: size[0], height: size[1], depth: size[2] } }
      : x.type === 'panel' && x.parameters?.parentShapeId === target.id ? { ...x, position: [...pos] as V3 } : x)),
  }));
  // Gövdenin çizim düzlemleri gövde-yereldir: gövde ötelenince dünyada yerlerinde kalsınlar (yüzde bekleyen öbür çizimler kaymasın).
  useDraft.setState(st => ({
    planes: st.planes.map(pl => (pl.kind === 'face' && pl.shapeId === target.id ? { ...pl, origin: arr3(v3(pl.origin).sub(shift)) } : pl)),
  }));
  return { w, h, dx: dx - ox, dy: dy - oy };
}
/** Hedef katıyı yeniden üretir: panelde motor (yalnız o panel değişti), gövdede katı + panelleri. */
async function rebuildTarget(id: string) {
  const s = shapeById(id);
  if (!s) return;
  const bodyId = bodyIdOf(s);
  if (isPanel(s)) { await requestRebuild(bodyId, { changedPanelId: s.id }); await whenRebuildIdle(bodyId); return; }
  const r = await rebuildBodySolid({ parameters: s.parameters, fillets: s.fillets }, s.subtractionGeometries, undefined, false);
  const now = shapeById(id);
  if (!now) return;
  useAppStore.getState().updateShape(id, {
    geometry: r.geometry, replicadShape: r.replicadShape, parameters: { ...now.parameters, scaledBaseVertices: r.scaledBaseVertices, sketchErrors: r.sketchErrors },
  });
  if (childPanelsOf(id).length) { await requestRebuild(id); await whenRebuildIdle(id); }
}
const writeFeatures = (targetId: string, next: (old: SketchFeature[]) => SketchFeature[]) => {
  const t = shapeById(targetId);
  if (t) useAppStore.getState().updateShape(targetId, { parameters: { ...t.parameters, sketchFeatures: next(sketchFeaturesOf(t)) } });
};
/** Etkin yüzdeki çizimi (seçim varsa yalnız seçilenleri) hedefe adım olarak yazar; oturum açıksa düzenlenen adımı kaydeder.
 *  Hata varsa kullanıcıya gösterilecek metin döner. */
export async function applySketch(): Promise<string | null> {
  const st = useDraft.getState();
  if (st.session) return finishSketchEdit(true);
  const ft = faceTarget();
  if (!ft) return 'Pick a face first.';
  const ents = st.entities.filter(e => e.plane === ft.plane.id && !e.ref), picked = ents.filter(e => st.selection.includes(e.id)), use = picked.length ? picked : ents;
  if (!profileLoops(use).loops.length) return 'Draw a closed profile on the face first.';
  if (ft.kind === 'body' && ft.shape.vertexModifications?.length) return 'Not available on a vertex-edited body yet.';
  cancelCommand();
  await whenRebuildIdle(ft.bodyId);
  const target = shapeById(ft.shape.id);
  if (!target) return 'The face no longer exists.';
  const a = st.apply, r = await frameOfPlane(target, ft.plane);
  if (!r) return 'The face could not be resolved.';
  const op = a.op, label = op === 'cut' ? 'Cut' : 'Shape';
  const fit = op === 'shape' && ft.kind === 'body' && r.inset < 0.05 ? fitBodyToProfile(target, r.fr, use, r.dx, r.dy, a.mode === 'points') : null;
  const g = fit ?? { w: r.fr.w, h: r.fr.h, dx: r.dx, dy: r.dy };
  const host = fit ? shapeById(target.id) ?? target : target;   // uyarlamadan sonra güncel ölçüler (formül değişkenleri BW / BH / BD)
  const feature: SketchFeature = {
    id: genId('sk'), name: `${label} ${sketchFeaturesOf(target).filter(f => f.op === op).length + 1}`, timestamp: Date.now(),
    op, depth: op === 'shape' || a.through ? null : Math.max(0.1, a.depth), n: r.n, u: r.u, inset: r.inset,
    ...sketchPayload(use, a, g.w, g.h, g.dx, g.dy, varsOfTarget(host)),
  };
  writeFeatures(target.id, old => [...old, feature]);
  takeEntities(ft.plane.id, use.map(e => e.id));
  await rebuildTarget(target.id);
  const err = shapeById(target.id)?.parameters?.sketchErrors?.[feature.id] as string | undefined;
  return err ? `Step added, but it could not be applied: ${err}` : null;
}
// Açık adımın çizimi yüklendiği andan beri değişti mi (boşta Esc kaydedilmemiş emeği silmesin diye sorulur).
let sessionBase = '';
const sessionKey = (planeId: string) => JSON.stringify(useDraft.getState().entities.filter(e => e.plane === planeId && !e.ref));
export const sessionDirty = () => { const ses = useDraft.getState().session; return !!ses && sessionKey(ses.planeId) !== sessionBase; };
/** Adımı düzenlemeye açar: yüz düzlemi + izolasyon, adım bastırılır (katı adımsız), nesneleri oturum düzlemine yüklenir. */
export async function editSketch(targetId: string, featureId: string) {
  if (useDraft.getState().session?.featureId === featureId) return;   // zaten açık — süren düzenleme korunur
  if (useDraft.getState().session) await finishSketchEdit(false, true);
  const first = shapeById(targetId), f = sketchFeaturesOf(first).find(x => x.id === featureId);
  if (!first || !f) return;
  cancelCommand(); cancelFacePick(true);
  const bodyId = bodyIdOf(first), kind = isPanel(first) ? 'panel' as const : 'body' as const;
  await whenRebuildIdle(bodyId);
  setSketchSuppressed(featureId);
  await rebuildTarget(targetId);
  const target = shapeById(targetId);
  const fr = target ? sketchFrameOf(await uncutMeshOf(target), f.n, f.u, f.inset, stepRotationOf(target)) : null;
  if (!target || !fr) { setSketchSuppressed(null); await rebuildTarget(targetId); return; }
  const name = isPanel(target) ? vfOfPanel(target)?.description || 'Panel' : 'Body';
  const planeId = activatePlane({ kind: 'face', shapeId: targetId, origin: arr3(fr.o), u: arr3(fr.u), v: arr3(fr.v), n: arr3(fr.n), label: name }, true);
  // Parametric adım: nesneler o anki yüz ölçüsünde çözülür ve nokta bağ tercihleriyle yüklenir (formül çözülemezse saklı hâliyle).
  const param = f.mode === 'points' && !!f.pts;
  let loaded = f.shapes;
  try { loaded = placeSketchShapes(f, fr.w, fr.h, varsOfTarget(target)); } catch { /* bozuk formül: saklı nesneler düzenlenir */ }
  loadEntities(loaded, planeId, param ? f.pts!.map(prefsOf) : undefined, param ? f.radii : undefined);
  sessionBase = sessionKey(planeId);
  if (!applyBeforeEdit) applyBeforeEdit = { ...useDraft.getState().apply };
  setApply({
    op: f.op, through: f.depth == null, ...(f.depth != null ? { depth: f.depth } : {}), anchor: [f.anchor[0], f.anchor[1]], stretch: [f.stretch[0], f.stretch[1]],
    mode: param ? 'points' : 'anchor',
  });
  setSession({ targetId, featureId, name: f.name, planeId });
  setIsolate({ targetId, bodyId, kind }); setPanelOpen(true);
  keepPose();
  const hostM = hostMatrix(target, useAppStore.getState().shapes);
  sceneApi.fly?.(fr.o.clone().addScaledVector(fr.u, fr.w / 2).addScaledVector(fr.v, fr.h / 2).applyMatrix4(hostM),
    fr.n.clone().transformDirection(hostM), fr.v.clone().transformDirection(hostM), Math.max(fr.w, fr.h, 100));
}
/** Düzenleme oturumunu kapatır. save: oturum düzlemindeki TÜM nesneler adıma (Drawing panelindeki güncel ayarlarla) geri yazılır.
 *  Oturum bitince yüzden de çıkılır (tüm model + önceki kamera) — sonuç bağlamında görünsün; `stay`: başka adıma geçilirken yüzde kal. */
export async function finishSketchEdit(save: boolean, stay = false): Promise<string | null> {
  const st = useDraft.getState(), ses = st.session;
  if (!ses) return null;
  const target = shapeById(ses.targetId), f = sketchFeaturesOf(target).find(x => x.id === ses.featureId);
  cancelCommand();
  if (save && target && f) {
    const ents = st.entities.filter(e => e.plane === ses.planeId && !e.ref);
    if (!profileLoops(ents).loops.length) return 'The step needs at least one closed profile.';
    const fr = sketchFrameOf(await uncutMeshOf(target), f.n, f.u, f.inset, stepRotationOf(target));
    if (!fr) return 'The face could not be resolved.';
    const a = st.apply, op = a.op;
    // Oturum düzleminin orijini yüz çerçevesinin orijinidir (dx = dy = 0). Kip değişmişse eski kipin alanları adımdan düşer.
    const { mode: _m, pts: _p, radii: _r, ...kept } = f;
    void _m; void _p; void _r;
    const fit = op === 'shape' && !isPanel(target) && (f.inset || 0) < 0.05 ? fitBodyToProfile(target, fr, ents, 0, 0, a.mode === 'points') : null;
    const g = fit ?? { w: fr.w, h: fr.h, dx: 0, dy: 0 };
    const next: SketchFeature = {
      ...kept, op, depth: op === 'shape' || a.through ? null : Math.max(0.1, a.depth),
      ...sketchPayload(ents, a, g.w, g.h, g.dx, g.dy, varsOfTarget(fit ? shapeById(target.id) ?? target : target)),
    };
    writeFeatures(target.id, old => old.map(x => (x.id === f.id ? next : x)));
  }
  takeEntities(ses.planeId);
  setSketchSuppressed(null); setSession(null);
  if (!stay && applyBeforeEdit) { setApply(applyBeforeEdit); applyBeforeEdit = null; }
  if (target) await rebuildTarget(target.id);
  if (!stay) leaveFace();
  else {
    // Yüzde kalınıyor ("+ New" / başka adıma geçiş): oturumun boşalan düzlemi yerine yüzün KENDİ düzlemine dönülür — orada bekleyen serbest
    // çizim varsa yeniden görünür, yeni çizilenler de yüze sonraki girişte aynı düzlemde bulunur.
    const now = useDraft.getState(), pl = now.planes.find(q => q.id === ses.planeId);
    if (pl && now.activePlane === pl.id && !now.session) { const { id: _id, ...rest } = pl; void _id; activatePlane(rest); }
  }
  return null;
}
export async function deleteSketch(targetId: string, featureId: string) {
  if (useDraft.getState().session?.featureId === featureId) await finishSketchEdit(false);
  const t = shapeById(targetId);
  if (!t) return;
  await whenRebuildIdle(bodyIdOf(t));
  writeFeatures(targetId, old => old.filter(x => x.id !== featureId));
  await rebuildTarget(targetId);
}

// ── PARAMETRIC KİP: nokta tutamakları, bağ işaretleri, seçili noktaların kılavuzları, sanal ölçü önizlemesi ──
const pt = (x: number, y: number): P2 => ({ x, y });
type PInfo = { key: string; id: string; p: P2; bx: SketchBind; by: SketchBind; circle: boolean };
/** Etkin yüzdeki tüm kontrol noktaları, GEÇERLİ bağlarıyla (nokta tercihi → yoksa varsayılan; değer çizimdeki koordinattan). */
function paramPoints(ents: Entity[], face: DraftFace, a: SketchApply): PInfo[] {
  const dflt = bindDefaults(a), d = { x: face.dx, y: face.dy }, out: PInfo[] = [];
  for (const e of ents) {
    const b = bindsOf(moveShape(stripEnt(e), d), e.pb, face.w, face.h, dflt, face.vars);
    ctrlPoints(e).forEach((p, i) => out.push({ key: ptKey(e.id, i), id: e.id, p, bx: b[i].x, by: b[i].y, circle: e.t === 'circle' }));
  }
  return out;
}
type EdgeKind = 'L' | 'C' | 'R';
/** İmlecin altındaki YÜZ REFERANSI: kenar (sol / sağ → X, alt / üst → Y) ya da orta çizgi; köşede ve tam ortada ikisi birden. */
function faceRefAt(p: P2, tol: number, f: DraftFace): { x?: EdgeKind; y?: EdgeKind } | null {
  const fx = p.x + f.dx, fy = p.y + f.dy, t = tol * 1.2;
  if (fx < -t || fx > f.w + t || fy < -t || fy > f.h + t) return null;
  const near = (v: number, size: number): EdgeKind | undefined => (Math.abs(v) <= t ? 'L' : Math.abs(v - size) <= t ? 'R' : Math.abs(v - size / 2) <= t ? 'C' : undefined);
  const x = near(fx, f.w), y = near(fy, f.h);
  return x || y ? { x, y } : null;
}
const refKey = (r: { x?: EdgeKind; y?: EdgeKind }) => [r.x && `x${r.x}`, r.y && `y${r.y}`].filter(Boolean).join(' ');
/** Seçili (yoksa tüm) noktaları en yakın kenarlarına bağlar (tam ortadaysa ortaya). */
function autoBind() {
  const st = useDraft.getState(), f = st.face;
  if (!f || f.planeId !== st.activePlane) return;
  const tg = new Set(paramTargets(st));
  for (const axis of ['x', 'y'] as const) {
    const size = axis === 'x' ? f.w : f.h, off = axis === 'x' ? f.dx : f.dy, by: Record<EdgeKind, string[]> = { L: [], R: [], C: [] };
    for (const e of st.entities) {
      if (e.plane !== st.activePlane || e.ref) continue;
      ctrlPoints(e).forEach((q, i) => { const k = ptKey(e.id, i); if (!tg.size || tg.has(k)) by[autoKind((axis === 'x' ? q.x : q.y) + off, size)].push(k); });
    }
    for (const k of ['L', 'R', 'C'] as const) if (by[k].length) setPointPrefs(by[k], axis, { k });
  }
}
/** Ekrandaki ölçü etiketi: tıklanınca YERİNDE düzenlenir (Enter uygular, Esc / dışarı tık vazgeçer). onCommit false dönerse değer kabul
 *  edilmemiştir (alan kırmızı kalır). Düzenleme durumu DimField'da tutulur: Html içeriği ayrı bir DOM kökünde çizilir, giriş alanının
 *  durumu sahne (R3F) ağacında dursaydı her tuşta eski değere geri dönerdi. */
type DimProps = { text: string; edit: string; color: string; title: string; onCommit: (t: string) => boolean };
/** Açık ölçü alanına metin ekleyen işlev (Drawing panelindeki parametre listesi kullanır); alan kapalıyken null. */
let dimInsert: ((txt: string) => void) | null = null;
const DimField: React.FC<DimProps> = ({ text, edit, color, title, onCommit }) => {
  const [val, setVal] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const editing = val !== null;
  useEffect(() => {
    if (!editing) return;
    const ins = (txt: string) => {
      const el = inputRef.current;
      if (!el) return;
      const a = el.selectionStart ?? el.value.length, b = el.selectionEnd ?? a, next = el.value.slice(0, a) + txt + el.value.slice(b);
      setVal(next); setBad(false);
      requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + txt.length, a + txt.length); });
    };
    dimInsert = ins;
    return () => { if (dimInsert === ins) dimInsert = null; };
  }, [editing]);
  if (val === null) return (
    <button type="button" title={title} aria-label={`Dimension ${text}`} onClick={() => { setVal(edit); setBad(false); }}
      style={{ ...TAG, pointerEvents: 'auto', cursor: 'text', border: 'none', color, boxShadow: `0 0 0 1px ${color}66` }}>{text}</button>
  );
  return (
    <input ref={inputRef} autoFocus value={val} spellCheck={false} aria-label="Dimension value" onFocus={e => e.target.select()}
      onChange={e => { setVal(e.target.value); setBad(false); }} onBlur={() => setVal(null)}
      onKeyDown={e => { if (e.key === 'Enter') { if (onCommit(val)) setVal(null); else setBad(true); } else if (e.key === 'Escape') setVal(null); }}
      style={{
        width: Math.max(52, val.length * 7 + 18), height: 21, padding: '0 5px', borderRadius: 5, border: 'none', outline: 'none', textAlign: 'center',
        font: `600 11px ${MONO_FONT}`, color: '#1c1917', background: '#fff', boxShadow: bad ? '0 0 0 1.5px #dc2626' : '0 0 0 1.5px #ea580c, 0 3px 10px -3px rgba(40,30,20,0.35)',
      }} />
  );
};
const DimTag: React.FC<DimProps & { at: P2 }> = ({ at, ...rest }) => (
  <Html position={[at.x, at.y, 0]} center zIndexRange={[44, 0]}><DimField {...rest} /></Html>
);
const BIND_COL = { edge: '#0f766e', ratio: '#7c3aed', formula: '#2563eb' };
const bindCol = (b: SketchBind) => (b.k === 'F' ? BIND_COL.formula : b.k === 'P' ? BIND_COL.ratio : BIND_COL.edge);
const TAG: React.CSSProperties = {
  padding: '0 4px', borderRadius: 4, background: 'rgba(253,252,250,0.95)', fontFamily: MONO_FONT, fontSize: 10, fontWeight: 600, lineHeight: '15px',
  whiteSpace: 'nowrap', pointerEvents: 'none', userSelect: 'none',
};
/** Sahne katmanı (etkin düzlemin yerel koordinatında). Her noktada küçük kare tutamak (düğüm); seçili noktalarda bağlı kenara kesikli
 *  kılavuz + değer. Bağ çentikleri KALDIRILDI (Goker, Kas 2026 — "parametrik kipte yalnız çizgiler ve parametre düğüm noktaları olsun"):
 *  noktanın neye bağlı olduğu seçilince kılavuzundan ve vurgulanan yüz kenarından okunur. */
const ParamOverlay: React.FC<{ ents: Entity[]; face: DraftFace; apply: SketchApply; targets: Set<string>; wpp: number }> =
  ({ ents, face, apply, targets, wpp }) => {
    const show = apply.mode === 'points';
    const infos = useMemo(() => (show ? paramPoints(ents, face, apply) : []), [show, ents, face, apply]);
    const geo = useMemo(() => {
      const all: number[] = [], sel: number[] = [];
      for (const i of infos) (targets.has(i.key) ? sel : all).push(i.p.x, i.p.y, 0);
      const mk = (a: number[]) => { const b = new THREE.BufferGeometry(); b.setAttribute('position', new THREE.Float32BufferAttribute(a, 3)); return b; };
      return { all: mk(all), sel: mk(sel) };
    }, [infos, targets]);
    useEffect(() => () => { geo.all.dispose(); geo.sel.dispose(); }, [geo]);
    // Seçili noktaların kılavuzları: aynı bağı paylaşan noktalara TEK ölçü (eksen başına en çok 3) — bağlı kenardan / ortadan noktaya
    // kesikli çizgi + tıklanıp yerinde düzenlenen değer.
    const guides = useMemo(() => {
      const out: { key: string; info: PInfo; axis: 'x' | 'y'; line: LineS | null; at: P2; text: string; edit: string; color: string }[] = [];
      const x0 = -face.dx, y0 = -face.dy;
      for (const horiz of [true, false]) {
        const seen = new Set<string>();
        for (const i of infos) {
          if (!targets.has(i.key)) continue;
          const b = horiz ? i.bx : i.by, sig = bindText(b, horiz ? 'W' : 'H');
          if (seen.has(sig) || seen.size >= 3) continue;
          seen.add(sig);
          const key = `${i.key}${horiz ? 'x' : 'y'}`, axis = horiz ? 'x' as const : 'y' as const, color = bindCol(b);
          // Etiketler tutamağı ve birbirini örtmesin: değer, kılavuz çizgisinin yüzün İÇİNE bakan yanında durur (köşeye yakın noktada X ve Y
          // etiketleri ayrı yönlere açılır); formül noktanın altında / üstünde.
          const inY = i.p.y + face.dy < face.h / 2 ? 1 : -1, inX = i.p.x + face.dx < face.w / 2 ? 1 : -1;
          if (b.k === 'F') { out.push({ key, info: i, axis, line: null, at: pt(i.p.x, i.p.y + (horiz ? -17 : 17) * wpp), text: `${horiz ? 'X' : 'Y'} = ${b.e}`, edit: b.e, color }); continue; }
          const size = horiz ? face.w : face.h, o = horiz ? x0 : y0, at = horiz ? i.p.x : i.p.y, ref = b.k === 'R' ? o + size : b.k === 'C' ? o + size / 2 : o;
          const text = b.k === 'P' ? `${fmt(b.v * 100, 1)}%` : b.k === 'C' && Math.abs(b.v) < 0.005 ? 'centre' : fmt(Math.abs(b.v), 1);
          const line: LineS = horiz ? { t: 'line', a: pt(ref, i.p.y), b: pt(at, i.p.y) } : { t: 'line', a: pt(i.p.x, ref), b: pt(i.p.x, at) };
          out.push({ key, info: i, axis, line, at: horiz ? pt((ref + at) / 2, i.p.y + inY * 13 * wpp) : pt(i.p.x + inX * 26 * wpp, (ref + at) / 2), text, edit: b.k === 'P' ? `${fmt(b.v * 100, 2)}%` : fmt(Math.abs(b.v), 2), color });
        }
      }
      return out;
    }, [infos, targets, face, wpp]);
    /** Ölçü değeri yazıldı: düz sayı = bağlı kenardan / ortadan mesafe · "25%" = yüz ölçüsünün oranı · başka metin = formül (W, H, özel
     *  parametreler). Aynı bağı paylaşan seçili noktaların hepsi birlikte taşınır. */
    const editDim = (i: PInfo, axis: 'x' | 'y', raw: string): boolean => {
      const X = axis === 'x', S = X ? 'W' as const : 'H' as const, b = X ? i.bx : i.by, size = X ? face.w : face.h, off = X ? face.dx : face.dy;
      const keys = infos.filter(q => targets.has(q.key) && bindText(X ? q.bx : q.by, S) === bindText(b, S)).map(q => q.key);
      const t = raw.trim(), num = /^\d+(?:[.,]\d+)?$/.test(t) ? parseFloat(t.replace(',', '.')) : null, pct = /^(\d+(?:[.,]\d+)?)\s*%$/.exec(t);
      if (pct || (num !== null && b.k === 'P')) { movePointsTo(keys, axis, (size * (pct ? parseFloat(pct[1].replace(',', '.')) : num!)) / 100 - off, { k: 'P' }); return true; }
      if (num !== null && b.k !== 'F') {
        movePointsTo(keys, axis, (b.k === 'L' ? num : b.k === 'R' ? size - num : size / 2 + (b.v < 0 ? -num : num)) - off, { k: b.k });
        return true;
      }
      const nb = parseBind(t, S, face.vars), at = nb ? bindCoord(nb, size, face.vars) : null;
      if (!nb || at === null) return false;
      movePointsTo(keys, axis, at - off, nb.k === 'F' ? { k: 'F', e: nb.e } : { k: nb.k });
      return true;
    };
    // Seçili dairelerin yarıçap etiketi (sayı ya da formül yazılabilir).
    const radii = useMemo(() => [...new Set(infos.filter(i => i.circle && targets.has(i.key)).map(i => i.id))].slice(0, 3)
      .map(id => ents.find(e => e.id === id)).filter((e): e is Entity & CircleS => e?.t === 'circle'), [infos, targets, ents]);
    const editRadius = (id: string, raw: string): boolean => {
      const v = evalExpr(raw, face.vars);
      if (v === null || v <= 0) return false;
      setCircleRadius([id], v, /^\s*\d+(?:[.,]\d+)?\s*$/.test(raw) ? null : raw.trim());
      return true;
    };
    // Yüz referansları (seçim varken): dört kenar + iki orta çizgi. Seçimin bağlı olduğu turuncu, imlecin altındaki kalın.
    const hover = useDraft(st => st.phover);
    const refs = useMemo(() => {
      const sel = infos.filter(i => targets.has(i.key));
      if (!sel.length) return [];
      const kx = sel.every(i => i.bx.k === sel[0].bx.k) ? sel[0].bx.k : null, ky = sel.every(i => i.by.k === sel[0].by.k) ? sel[0].by.k : null;
      const x0 = -face.dx, y0 = -face.dy, w = face.w, h = face.h, ln = (ax: number, ay: number, bx: number, by: number): LineS => ({ t: 'line', a: pt(ax, ay), b: pt(bx, by) });
      return [
        { id: 'xL', s: ln(x0, y0, x0, y0 + h), on: kx === 'L', mid: false }, { id: 'xC', s: ln(x0 + w / 2, y0, x0 + w / 2, y0 + h), on: kx === 'C', mid: true },
        { id: 'xR', s: ln(x0 + w, y0, x0 + w, y0 + h), on: kx === 'R', mid: false }, { id: 'yL', s: ln(x0, y0, x0 + w, y0), on: ky === 'L', mid: false },
        { id: 'yC', s: ln(x0, y0 + h / 2, x0 + w, y0 + h / 2), on: ky === 'C', mid: true }, { id: 'yR', s: ln(x0, y0 + h, x0 + w, y0 + h), on: ky === 'R', mid: false },
      ];
    }, [infos, targets, face]);
    return (
      <>
        {show && (
          <>
            <points geometry={geo.all} renderOrder={1096}><pointsMaterial size={10} sizeAttenuation={false} color="#fdfcfa" depthTest={false} depthWrite={false} transparent /></points>
            <points geometry={geo.all} renderOrder={1097}><pointsMaterial size={6} sizeAttenuation={false} color="#292524" depthTest={false} depthWrite={false} transparent /></points>
            <points geometry={geo.sel} renderOrder={1098}><pointsMaterial size={13} sizeAttenuation={false} color="#fdfcfa" depthTest={false} depthWrite={false} transparent /></points>
            <points geometry={geo.sel} renderOrder={1099}><pointsMaterial size={9} sizeAttenuation={false} color="#ea580c" depthTest={false} depthWrite={false} transparent /></points>
            {refs.map(r => {
              const hot = !!hover && hover.split(' ').includes(r.id);
              return <DLine key={r.id} s={r.s} color={r.on ? '#ea580c' : '#0f766e'} width={hot ? 4.5 : r.on ? 3 : 1.6} dash={r.mid ? wpp * 7 : 0} order={1093} depth={false}
                opacity={hot || r.on ? 1 : 0.5} />;
            })}
            {guides.map(gd => (
              <React.Fragment key={gd.key}>
                {gd.line && <DLine s={gd.line} color={gd.color} width={1} dash={wpp * 3} order={1094} depth={false} opacity={0.9} />}
                <DimTag at={gd.at} text={gd.text} edit={gd.edit} color={gd.color} title="Click to type a value" onCommit={t => editDim(gd.info, gd.axis, t)} />
              </React.Fragment>
            ))}
            {radii.map(c => (
              <DimTag key={`r${c.id}`} at={pt(c.c.x + c.r * 0.71 + 16 * wpp, c.c.y + c.r * 0.71 + 10 * wpp)} text={`R ${c.re ?? fmt(c.r, 1)}`} edit={c.re ?? fmt(c.r, 2)}
                color={c.re ? BIND_COL.formula : BIND_COL.edge} title="Click to type the radius" onCommit={t => editRadius(c.id, t)} />
            ))}
          </>
        )}
      </>
    );
  };

const FaceGlow: React.FC<{ pick: FacePick; strong: boolean }> = ({ pick, strong }) => {
  const xf = useMemo(() => xfOf(pick.hostM), [pick]);
  const edges = useMemo(() => new THREE.EdgesGeometry(pick.highlight, 1), [pick]);
  useEffect(() => () => { edges.dispose(); }, [edges]);
  return (
    <group position={xf.position} quaternion={xf.quaternion} scale={xf.scale}>
      <mesh geometry={pick.highlight} renderOrder={900}>
        <meshBasicMaterial color="#ea580c" transparent opacity={strong ? 0.36 : 0.13} depthTest={false} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      {strong && <lineSegments geometry={edges} renderOrder={901}><lineBasicMaterial color="#c2410c" depthTest={false} transparent /></lineSegments>}
    </group>
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
  const planePick = useDraft(s => s.planePick), dynOn = useDraft(s => s.aids.dyn), iso = useDraft(s => s.isolate), candTick = useDraft(s => s.planeCandidate);
  const face = useDraft(s => s.face), apply = useDraft(s => s.apply), psel = useDraft(s => s.psel);
  const [wpp, setWpp] = useState(1);
  const [hoverFace, setHoverFace] = useState<FacePick | null>(null);
  // Etkin yüzün çerçevesi (ölçü + formül değişkenleri) depoda güncel tutulur: düzlem ya da hedefin geometrisi değişince yeniden okunur.
  useEffect(() => { void syncFace(); }, [activeId, planes, shapes]);
  const cand = planePick && candTick ? candidate : null;
  useEffect(() => { if (!planePick) { setHoverFace(null); dropPrePick(); } }, [planePick]);   // Esc / komut başlatma seçimi kapatırsa ön izolasyon da kalkar
  // Hedef (panel / gövde) silinirse düzenleme oturumu, izolasyon ve o yüzün düzlemi düşer.
  useEffect(() => {
    const st = useDraft.getState(), gone = (id: string) => !shapes.some(s => s.id === id);
    if (st.session && gone(st.session.targetId)) {
      takeEntities(st.session.planeId); setSketchSuppressed(null); setSession(null);
      if (applyBeforeEdit) { setApply(applyBeforeEdit); applyBeforeEdit = null; }
    }
    if (st.isolate && gone(st.isolate.targetId)) setIsolate(null);
    const pl = st.planes.find(p => p.id === st.activePlane);
    if (pl?.kind === 'face' && pl.shapeId && gone(pl.shapeId)) leaveFace();
  }, [shapes]);

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
  // Yakalama kaynağı yalnız GÖRÜNEN şekillerin kenarlarıdır (izolasyonda hedef panel / gövde).
  useEffect(() => { setExtraSnap(busy ? planeEdges(activeInv, visibleShapes(shapes, iso), shapes) : []); }, [busy, activeInv, shapes, iso]);
  // REFERANS KENARLAR (Goker: "yüzü seçtikten sonra ofseti ve diğer işlemleri panelin çizgileri üzerinden de yapabileyim"): etkin yüzün
  // sahibinin (panel / gövde) o düzlemdeki kenarları çizim nesnesi gibi SEÇİLEBİLİR olur (Draft.setRefEdges) — değiştirilemez, adıma girmez.
  useEffect(() => {
    const pl = planes.find(q => q.id === activeId), host = pl?.kind === 'face' ? shapes.find(x => x.id === pl.shapeId) : undefined;
    setRefEdges(host ? activeId : null, host ? planeEdges(activeInv, [host], shapes) : []);
  }, [activeId, planes, activeInv, shapes, entities]);   // entities: çizime katılan / silinen kenar için referanslar yeniden süzülür
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
      flyTo(L.camera, L.controls, target, n, up, extent, L.size.height, null, viewInset(gl.domElement), toOrtho);
    };
    sceneApi.fly = (c, n, up, extent) => { const L = live.current; flyTo(L.camera, L.controls, c, n, up, extent, L.size.height, null, viewInset(gl.domElement), toOrtho); };
    sceneApi.pose = () => {
      const L = live.current;
      return L.controls?.target ? { pos: L.camera.position.clone(), target: L.controls.target.clone(), up: L.camera.up.clone(), zoom: (L.camera as THREE.OrthographicCamera).zoom ?? 1 } : null;
    };
    // Yüzden çıkış: otomatik ortografiğe girildiyse önce perspektife dönülür (kamera nesnesi değişir → iki kare beklenir), sonra eski yere.
    sceneApi.restore = p => {
      const go = () => { const L = live.current; flyTo(L.camera, L.controls, p.target, p.pos.clone().sub(p.target), p.up, 0, L.size.height, { dist: p.pos.distanceTo(p.target), zoom: p.zoom }); };
      const sw = (window as any).__cameraAuto?.('persp') as Promise<void> | undefined;
      if (sw) void sw.then(() => requestAnimationFrame(() => requestAnimationFrame(go))); else go();
    };
    return () => { viewPlaneFn = null; sceneApi.fly = null; sceneApi.pose = null; sceneApi.restore = null; };
  }, []);

  // Fare: pencere düzeyinde yakalama aşaması — komut etkinken tıklama gövde/panel işleyicilerine ve yörünge kontrolüne ULAŞMAZ.
  useEffect(() => {
    const el = gl.domElement, rc = new THREE.Raycaster(), ndc = new THREE.Vector2();
    let rightDown: { x: number; y: number } | null = null, swallow = false, inside = false;
    let pickSpot: { x: number; y: number; idx: number; keys: string } | null = null;
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
        if (pl.kind === 'face' && pl.id !== st.activePlane) continue;   // gizli (etkin olmayan yüz) düzlemin çizimi seçilemez
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
      // Yüz seçimi: imlecin altındaki yüz hafifçe vurgulanır (tıklanınca aday olur).
      if (st.planePick) {
        if (e.buttons !== 0) return;
        const c = inViewCube(e) ? null : faceCandidates(rayOf(e), live.current.shapes, st.isolate, pickOnly, 1)[0] ?? null;
        setHoverFace(prev => (prev?.key === c?.key ? prev : c));
        if (!inViewCube(e)) stop(e);
        return;
      }
      // Drawing paneli kapalıyken çizim nesneleri imlece tepki vermez (Goker: "kalan çizgileri tıklatma bana").
      if (!st.cmd && (!st.entities.length || !st.panelOpen)) { if (st.hoverId) pointerLeave(); return; }
      const h = onActive(e);
      if (!h) return;
      // Parametric kip: seçim varken imlecin altındaki yüz referansı (kenar / orta çizgi) vurgulanır.
      if (!st.cmd && st.apply.mode === 'points' && st.face?.planeId === st.activePlane && e.buttons === 0) {
        const r = paramTargets(st).length && !pointAt(h.p, h.tol) && !segmentAt(h.p, h.tol) ? faceRefAt(h.p, h.tol, st.face) : null;
        setPHover(r ? refKey(r) : null);
      }
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
      // YÜZ SEÇİMİ (Goker: "tıkladıkça seçilecek yüzeyi göstersin, onaylayınca çalışsın"): tık ADAYI belirler ve vurgular; aynı noktaya
      // yeniden tık ışın boyunca bir sonraki yüze geçer (panel → arkasındaki gövde yüzü → …). Onay: sağ tık / Enter / paneldeki ✓.
      if (st.planePick) {
        const list = faceCandidates(rayOf(e), live.current.shapes, st.isolate, pickOnly);
        if (list.length) {
          const keys = list.map(c => c.key).join('|');
          const again = !!pickSpot && pickSpot.keys === keys && Math.hypot(e.clientX - pickSpot.x, e.clientY - pickSpot.y) < 8;
          const idx = again ? (pickSpot!.idx + 1) % list.length : 0;
          pickSpot = { x: e.clientX, y: e.clientY, idx, keys };
          candidate = list[idx];
          setPlaneCandidate({ label: list.length > 1 ? `${candidate.label} (${idx + 1}/${list.length})` : candidate.label });
        }
        swallow = true; stop(e);
        return;
      }
      if (commandActive()) {
        const h = onActive(e);
        if (h) pointerClick(h.p, h.tol, e.shiftKey, e.ctrlKey || e.metaKey);
        swallow = true; stop(e);
        return;
      }
      if (!st.entities.length || !st.panelOpen) return;
      // Parametric kip: tutamağa tık o kontrol noktasını seçer (Shift / Ctrl: seçime ekler / çıkarır).
      // PARAMETRIC KİP — her şey ekranda: tutamak = o nokta · çizimin bir kenarı = iki ucu (Shift / Ctrl seçime ekler) · seçim varken
      // YÜZÜN KENARI ya da ORTA ÇİZGİSİ = seçili noktalar ona bağlanır (köşe: X ve Y birlikte) · boşluk = seçimi bırak.
      if (st.apply.mode === 'points' && st.face?.planeId === st.activePlane) {
        const h = onActive(e), add = e.shiftKey || e.ctrlKey || e.metaKey;
        if (h) {
          const key = pointAt(h.p, h.tol);
          if (key) { togglePoint(key, add); swallow = true; stop(e); return; }
          const seg = segmentAt(h.p, h.tol);
          if (seg) { selectPoints(seg.keys, seg.id, add); swallow = true; stop(e); return; }
          const tg = paramTargets(st), r = tg.length ? faceRefAt(h.p, h.tol, st.face) : null;
          if (r) {
            if (r.x) setPointPrefs(tg, 'x', { k: r.x });
            if (r.y) setPointPrefs(tg, 'y', { k: r.y });
            swallow = true; stop(e);
            return;
          }
        }
        if (st.selection.length || st.psel.length) selectEntity(null);
        return;
      }
      const id = pickAny(e);
      if (id) { selectEntity(id, e.shiftKey); swallow = true; stop(e); }
      else if (st.selection.length) selectEntity(null);
    };
    const onUp = (e: PointerEvent) => {
      if (e.button === 2 && rightDown) {
        const still = Math.hypot(e.clientX - rightDown.x, e.clientY - rightDown.y) < 5;
        rightDown = null;
        if (still && (commandActive() || useDraft.getState().planePick)) enterKey();
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
  const activeEnts = useMemo(() => (byPlane.get(activeId) ?? []).filter(e => !e.ref), [byPlane, activeId]);
  const paramFace = face && face.planeId === activeId && activeEnts.length && apply.mode === 'points' ? face : null;
  const targets = useMemo(() => new Set(paramFace ? paramTargets({ entities, activePlane: activeId, psel, selection }) : []), [paramFace, entities, activeId, psel, selection]);
  const showUcs = busy || planePick || activeId !== GROUND_PLANE.id || (byPlane.get(activeId)?.length ?? 0) > 0;
  const track = cursor?.track, trackLen = wpp * 6000;
  return (
    <>
      {planes.map(pl => {
        const m = matrices.get(pl.id), ents = byPlane.get(pl.id);
        if (iso && pl.kind === 'face' && pl.shapeId !== iso.targetId) return null;   // izolasyonda gizlenen şeklin yüzündeki çizim de gizlenir
        // Yüzden çıkınca o yüzde kalan (uygulanmamış) çizim sahnede durmaz, tıklamayı da çalmaz; aynı yüze girince geri gelir.
        if (pl.kind === 'face' && pl.id !== activeId) return null;
        return m && ents?.length ? <PlaneEntities key={pl.id} matrix={m} ents={ents} active={pl.id === activeId} selection={selSet} hoverId={hoverId} dash={wpp} /> : null;
      })}
      {showUcs && <UcsIcon matrix={activeM} />}
      {/* Komut sürerken (trim, ofset…) tutamaklar ve bağ çizgileri GİZLİDİR — yalnız çizim ve panel kenarları görünür. */}
      {paramFace && !planePick && !busy && (
        <group position={activeXf.position} quaternion={activeXf.quaternion} scale={activeXf.scale}>
          <group position={[0, 0, LIFT]}>
            <ParamOverlay ents={activeEnts} face={paramFace} apply={apply} targets={targets} wpp={wpp} />
          </group>
        </group>
      )}
      {planePick && hoverFace && hoverFace.key !== cand?.key && <FaceGlow pick={hoverFace} strong={false} />}
      {cand && <FaceGlow pick={cand} strong />}
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
  JOIN: <><path d="M4 17 9 8" /><path d="M9 8h7l4 7" />{ring(9, 8, 2.1)}{ring(16, 8, 2.1)}{dot(4, 17, 1.4)}{dot(20, 15, 1.4)}</>,
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
  check: <path d="M5 12.5l4.5 4.5L19 7.5" strokeWidth={2.1} />,
  solo: <><rect x="3.5" y="3.5" width="17" height="17" rx="1.5" {...dash} /><rect x="8" y="8" width="8" height="8" rx="1" /></>,
  auto: <><path d="M4 4v16h16" /><path d="M9 15l3-3M14 10l3-3" /><rect x="11" y="9" width="4" height="4" rx="0.6" transform="rotate(45 13 11)" /></>,
  modeA: <><rect x="4" y="4" width="16" height="16" rx="1.5" /><circle cx="8" cy="16" r="1.8" fill="currentColor" stroke="none" /></>,
  modeP: <><rect x="4" y="4" width="16" height="16" rx="1.5" {...dash} /><path d="M8 4v4M4 8h4M16 20v-4M20 16h-4" /><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" /><circle cx="16" cy="16" r="1.5" fill="currentColor" stroke="none" /></>,
  cut: <><rect x="4" y="4" width="16" height="16" rx="1.5" /><circle cx="12" cy="12" r="4.2" {...dash} strokeWidth={1.4} /></>,
  shape: <><rect x="3.5" y="3.5" width="17" height="17" {...dash} /><path d="M6 18.5V11a5 5 0 0 1 5-5h7.5v7.5a5 5 0 0 1-5 5z" /></>,
  stretchx: <path d="M3 12h18M3 12l3.5-3.5M3 12l3.5 3.5M21 12l-3.5-3.5M21 12l-3.5 3.5" />,
  stretchy: <path d="M12 3v18M12 3 8.5 6.5M12 3l3.5 3.5M12 21l-3.5-3.5M12 21l3.5-3.5" />,
  pencil: <><path d="M4 20l1.2-4.4L16.6 4.2a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.4 18.8z" /><path d="M14.5 6.3l3.2 3.2" /></>,
  trash: <path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v6M14 11v6" />,
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
  .dp-btn.lg{width:36px;height:36px;border-radius:7px}
  .dp-btn.fam:not(.on){box-shadow:inset 0 -2px 0 ${P.accent}}
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
  .dp-btn:disabled{opacity:0.4;cursor:not-allowed}
  .dp-note{margin-top:8px;padding:9px 10px;border-radius:8px;background:#fff;box-shadow:0 0 0 1px rgba(234,88,12,0.28)}
  .dp-seg{display:flex;gap:1px;padding:2px;background:#efebe4;border-radius:8px;box-shadow:inset 0 0 0 1px rgba(60,50,40,0.08)}
  .dp-seg button{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;height:26px;border:none;border-radius:6px;background:transparent;color:${P.mute};
    font:500 11.5px ${UI_FONT};cursor:pointer;outline:none;white-space:nowrap;transition:background .12s,color .12s,box-shadow .12s}
  .dp-seg button:hover{color:${P.ink}}
  .dp-seg button.on{background:#fff;color:${P.ink};font-weight:600;box-shadow:0 1px 2px rgba(40,30,20,0.12),0 0 0 0.5px rgba(60,50,40,0.10)}
  .dp-seg button.on svg{color:${P.accent}}
  .dp-num{display:flex;align-items:center;gap:3px;width:76px;height:30px;padding:0 7px;border-radius:7px;background:#fff;box-shadow:0 0 0 1px #e3ddd4;
    transition:box-shadow .12s}
  .dp-num:focus-within{box-shadow:0 0 0 1px rgba(234,88,12,0.55),0 0 0 3px rgba(234,88,12,0.10)}
  .dp-num.off{background:#f3f0ea;box-shadow:0 0 0 1px #ebe6df}
  .dp-num input{flex:1;min-width:0;width:100%;border:none;outline:none;background:transparent;text-align:right;font:600 12px ${MONO_FONT};color:${P.ink}}
  .dp-num span{font:500 10px ${UI_FONT};color:${P.faint}}
  .dp-anchor{display:grid;grid-template-columns:repeat(3,22px);grid-template-rows:repeat(3,22px);gap:1px;padding:3px;border-radius:8px;background:#fff;
    box-shadow:0 0 0 1px #e3ddd4;flex-shrink:0}
  .dp-anchor button{display:flex;align-items:center;justify-content:center;border:none;border-radius:5px;background:transparent;cursor:pointer;outline:none;padding:0}
  .dp-anchor button i{width:6px;height:6px;border-radius:50%;background:#d6d1c8;transition:transform .12s,background .12s}
  .dp-anchor button:hover{background:#f6f3ee}
  .dp-anchor button:hover i{background:${P.mute}}
  .dp-anchor button.on i{background:${P.accent};transform:scale(1.5);box-shadow:0 0 0 3px rgba(234,88,12,0.16)}
  .dp-primary{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;height:30px;border:none;border-radius:7px;cursor:pointer;outline:none;
    background:linear-gradient(180deg,#f97316 0%,#ea580c 100%);color:#fff;font:600 12px ${UI_FONT};
    box-shadow:0 1px 2px rgba(234,88,12,0.35),0 0 0 0.5px rgba(154,52,18,0.4),inset 0 1px 0 rgba(255,255,255,0.25);transition:filter .12s,transform .08s}
  .dp-primary:hover{filter:brightness(1.06)}
  .dp-primary:active{transform:translateY(0.5px)}
  .dp-primary:disabled{background:#e7e2da;color:#a8a29e;box-shadow:inset 0 0 0 0.5px rgba(60,50,40,0.1);cursor:not-allowed;filter:none}
  .dp-ghost{height:30px;padding:0 11px;border:none;border-radius:7px;background:#fff;box-shadow:0 0 0 1px #e3ddd4;color:${P.body};font:500 12px ${UI_FONT};
    cursor:pointer;outline:none;transition:box-shadow .12s,color .12s}
  .dp-ghost:hover{box-shadow:0 0 0 1px #cfc7bc;color:${P.ink}}
  .dp-ghost:disabled{opacity:0.5;cursor:not-allowed}
  .dp-chip:disabled{opacity:0.4;cursor:not-allowed}
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
  { label: 'Join / split', ids: ['JOIN', 'EXPLODE', 'ERASE'] },
  { label: 'Array', ids: ['ARRAYRECT', 'ARRAYPATH', 'ARRAYPOLAR'] },
];
const aliasOf = (id: string) => commandById(id)?.aliases[0] ?? id;
const POLAR_STEPS = [90, 45, 30, 22.5, 15, 10, 5];
type Hint = { title: string; key?: string } | null;

const Section: React.FC<{ title: string; right?: React.ReactNode; closed?: boolean; children: React.ReactNode }> = ({ title, right, closed, children }) => {
  const [open, setOpen] = useState(!closed);
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

/** Çapa ızgarası: üst sıra önce (yüzde Y yukarı). */
const ANCHORS: [number, number][] = [[0, 1], [0.5, 1], [1, 1], [0, 0.5], [0.5, 0.5], [1, 0.5], [0, 0], [0.5, 0], [1, 0]];
const anchorName = (ax: number, ay: number) => (ax === 0.5 && ay === 0.5 ? 'the centre of the face'
  : `the ${ay === 1 ? 'top' : ay === 0 ? 'bottom' : 'middle'}${ax === 0.5 ? ' centre' : ax === 0 ? '-left' : '-right'}${ax !== 0.5 && ay !== 0.5 ? ' corner' : ' edge'}`);
type TipFn = (title: string, key?: string) => { onMouseEnter: () => void; onMouseLeave: () => void };
/** YÜZE UYGULA: etkin yüzdeki kapalı profilleri hedefe adım olarak yazar (Cut = çıkar · Shape = panele şeklini ver); derinlik, çapa ve
 *  uzama burada seçilir. Düzenleme oturumunda aynı blok o adımın ayarlarını gösterir ve "Save changes" ile geri yazar. */
const FaceApply: React.FC<{ tip: TipFn }> = ({ tip }) => {
  const apply = useDraft(s => s.apply), session = useDraft(s => s.session), activePlane = useDraft(s => s.activePlane);
  const entities = useDraft(s => s.entities), selection = useDraft(s => s.selection);
  const shapesNow = useAppStore(s => s.shapes);   // hedef silinir / değişirse blok yenilensin
  const faceVars = useDraft(s => s.face?.vars ?? null);
  const [showVars, setShowVars] = useState(false);
  // Bu yüze yazılmış adımlar: yüze girince sonuncusu kendiliğinden açılır; birden çoksa buradan geçilir, "New" yeni adım başlatır.
  const [steps, setSteps] = useState<SketchFeature[]>([]);
  useEffect(() => { let live = true; void faceSteps().then(x => { if (live) setSteps(x); }); return () => { live = false; }; }, [activePlane, session?.featureId, shapesNow]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [depthStr, setDepthStr] = useState(String(apply.depth));
  useEffect(() => { setDepthStr(String(apply.depth)); }, [apply.depth]);
  useEffect(() => { setMsg(null); }, [activePlane, session?.featureId]);
  const stats = useMemo(() => {
    const on = entities.filter(e => e.plane === activePlane && !e.ref), picked = on.filter(e => selection.includes(e.id));
    const r = profileLoops(session || !picked.length ? on : picked);
    return { loops: r.loops.length, open: r.open, picked: session ? 0 : picked.length, count: on.length };
  }, [entities, selection, activePlane, session]);
  const nSel = useDraft(st => (st.apply.mode === 'points' ? paramTargets(st).length : 0));
  const ft = faceTarget();
  if (!ft) return null;
  const isBody = ft.kind === 'body', op = apply.op, shaped = op === 'shape', param = apply.mode === 'points';
  const commitDepth = () => { const v = parseFloat(depthStr.replace(',', '.')); if (isFinite(v) && v > 0) setApply({ depth: Math.round(v * 100) / 100 }); else setDepthStr(String(apply.depth)); };
  const go = async () => {
    if (busy) return;
    setBusy(true); setMsg(null);
    try {
      const wasEdit = !!session, err = await applySketch();
      setMsg(err ? { text: err, ok: false } : null);   // başarı ayrıca yazılmaz: sonuç sahnede ve Assembly'de görünür
      void wasEdit;
    } catch (e) { setMsg({ text: `Failed: ${(e as Error)?.message ?? e}`, ok: false }); }
    finally { setBusy(false); }
  };
  const cancelEdit = async () => { if (busy) return; setBusy(true); try { await finishSketchEdit(false); } finally { setBusy(false); } };
  /** Başka adıma / yeni adıma geçiş: açık adım önce kaydedilir (kapalı profil yoksa uyarıp yerinde kalır), yüzde kalınır. */
  const switchStep = async (id: string | null) => {
    if (busy || (id && session?.featureId === id) || (!id && !session)) return;
    setBusy(true); setMsg(null);
    try {
      if (session) { const err = await finishSketchEdit(true, true); if (err) { setMsg({ text: err, ok: false }); return; } }
      if (id) await editSketch(ft.shape.id, id);
    } catch (e) { setMsg({ text: `Failed: ${(e as Error)?.message ?? e}`, ok: false }); }
    finally { setBusy(false); }
  };
  // Parametre listesi (Goker: "noktalara parametre vermek için Parameters kısmındaki liste bir düğmeyle gelsin"): tıklanan ad, sahnede
  // AÇIK olan ölçü alanına imlecin olduğu yere yazılır. Önce gövdenin özel parametreleri, sonra yüz / gövde ölçüleri.
  const BUILTIN = ['W', 'H', 'BW', 'BH', 'BD'];
  const varList = faceVars ? [...Object.keys(faceVars).filter(k => !BUILTIN.includes(k)), ...BUILTIN.filter(k => k in faceVars)] : [];
  const pickVar = (name: string) => {
    if (dimInsert) { dimInsert(name); setMsg(null); }
    else setMsg({ text: 'Click a dimension on the drawing first, then pick the parameter.', ok: true });
  };
  const [ax, ay] = apply.anchor;
  const noun = isBody ? 'body' : 'panel';
  return (
    <Section title={session ? `Edit · ${session.name}` : `Apply to ${noun}`}
      right={<span style={{ fontSize: 10.5, fontWeight: 500, color: stats.loops ? '#0f766e' : P.faint }}>{stats.loops} profile{stats.loops === 1 ? '' : 's'}</span>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {steps.length > 0 && (
          <div className="dp-steps" role="tablist" aria-label="Steps on this face" style={{ flexWrap: 'wrap' }}>
            {steps.map(f => (
              <button key={f.id} role="tab" aria-selected={session?.featureId === f.id} className={`dp-step${session?.featureId === f.id ? ' on' : ''}`} disabled={busy}
                style={{ padding: '0 8px', width: 'auto', flex: 'none' }} onClick={() => { void switchStep(f.id); }} {...tip(`Edit ${f.name} — its drawing is loaded on the face`)}>{f.name}</button>
            ))}
            <button role="tab" aria-selected={!session} className={`dp-step${!session ? ' on' : ''}`} disabled={busy} style={{ padding: '0 8px', width: 'auto', flex: 'none' }}
              onClick={() => { void switchStep(null); }} {...tip('Start another step on this face')}>+ New</button>
          </div>
        )}
        <div className="dp-seg">
          <button className={op === 'cut' ? 'on' : ''} onClick={() => setApply({ op: 'cut' })} {...tip(`Cut — remove the drawn profile from the ${noun}`)}>
            <DIcon name="cut" size={16} />Cut
          </button>
          <button className={shaped ? 'on' : ''} onClick={() => setApply({ op: 'shape' })} {...tip(`Shape — the ${noun} takes the outline of the drawn profile`)}>
            <DIcon name="shape" size={16} />Shape
          </button>
        </div>
        {!shaped && (
          <div style={{ display: 'flex', gap: 5 }}>
            <div className="dp-seg" style={{ flex: 1 }}>
              <button className={apply.through ? 'on' : ''} onClick={() => setApply({ through: true })} {...tip('Cut all the way through')}>Through</button>
              <button className={!apply.through ? 'on' : ''} onClick={() => setApply({ through: false })} {...tip('Pocket — cut to a set depth from the face')}>Pocket</button>
            </div>
            <label className={`dp-num${apply.through ? ' off' : ''}`}>
              <input type="text" inputMode="decimal" value={apply.through ? '' : depthStr} disabled={apply.through} placeholder="—" spellCheck={false}
                onChange={e => setDepthStr(e.target.value)} onBlur={commitDepth} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
              <span>mm</span>
            </label>
          </div>
        )}
        <div className="dp-seg">
          <button className={!param ? 'on' : ''} onClick={() => setApply({ mode: 'anchor' })} {...tip(`Simple — the drawing follows one anchor of the ${noun}, with optional stretch`)}>
            <DIcon name="modeA" size={16} />Simple
          </button>
          <button className={param ? 'on' : ''} onClick={() => setApply({ mode: 'points', auto: true })}
            {...tip('Parametric — click a point or edge of the drawing, then the face edge it follows; click a dimension to type it')}>
            <DIcon name="modeP" size={16} />Parametric
          </button>
        </div>
        {param ? (
          /* PARAMETRIC — düzenleme EKRANDA yapılır: nokta / kenar seç → yüzün kenarını göster → ölçüye tıklayıp yaz. Panelde yalnız Auto. */
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: nSel ? P.ink : P.faint, fontWeight: nSel ? 600 : 400 }}>{nSel ? `${nSel} selected` : 'Nearest edge'}</span>
            <button className={`dp-chip${showVars ? ' on' : ''}`} style={{ height: 26, padding: '0 9px', gap: 5 }} aria-pressed={showVars} aria-label="Parameters"
              onMouseDown={e => e.preventDefault()} onClick={() => setShowVars(v => !v)}
              {...tip('Parameters — click a dimension on the drawing, then pick a parameter to write it in')}>
              <span style={{ fontFamily: MONO_FONT, fontWeight: 700, color: '#a8a29e' }}>ƒ</span>Parameters
            </button>
            <button className="dp-chip" style={{ height: 26, padding: '0 9px', gap: 5 }} disabled={!stats.count} onClick={autoBind}
              {...tip(nSel ? 'Auto — tie the selected points to their nearest edges' : 'Auto — tie every point to its nearest edges')}>
              <DIcon name="auto" size={15} />Auto
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div className="dp-anchor" role="radiogroup" aria-label="Anchor">
              {ANCHORS.map(([x, y]) => (
                <button key={`${x}-${y}`} role="radio" aria-checked={x === ax && y === ay} className={x === ax && y === ay ? 'on' : ''}
                  onClick={() => setApply({ anchor: [x, y] })} {...tip(`Anchor: keeps its distance from ${anchorName(x, y)}`)}><i /></button>
              ))}
            </div>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
              {(['X', 'Y'] as const).map((k, i) => (
                <button key={k} className={`dp-chip${apply.stretch[i] ? ' on' : ''}`} style={{ gap: 6 }} aria-pressed={apply.stretch[i]} aria-label={`Stretch ${k}`}
                  onClick={() => setApply({ stretch: i === 0 ? [!apply.stretch[0], apply.stretch[1]] : [apply.stretch[0], !apply.stretch[1]] })}
                  {...tip(`Stretch ${k} — the drawing scales with the face ${i === 0 ? 'width' : 'height'}`)}>
                  <DIcon name={i === 0 ? 'stretchx' : 'stretchy'} size={15} />Stretch {k}
                </button>
              ))}
            </div>
          </div>
        )}
        {param && showVars && (
          <div role="listbox" aria-label="Parameter list" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {varList.map(k => (
              <button key={k} role="option" aria-selected={false} className="dp-chip" style={{ height: 24, padding: '0 7px', gap: 5, fontFamily: MONO_FONT, fontSize: 11 }}
                onMouseDown={e => e.preventDefault()} onClick={() => pickVar(k)} {...tip(`${k} = ${fmt(faceVars![k], 2)}`)}>
                <b style={{ color: P.ink }}>{k}</b><span style={{ color: P.faint }}>{fmt(faceVars![k], 1)}</span>
              </button>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 5, marginTop: 2 }}>
          <button className="dp-primary" disabled={busy || !stats.loops} onClick={() => { void go(); }} {...tip(stats.loops ? '' : 'Draw a closed profile on the face first')}>
            <DIcon name="check" size={15} />{busy ? 'Working…' : session ? (shaped ? 'Update shape' : 'Update cut') : shaped ? 'Apply shape' : 'Apply cut'}
          </button>
          {session && <button className="dp-ghost" disabled={busy} onClick={() => { void cancelEdit(); }}>Cancel</button>}
        </div>
        {msg && <div style={{ fontSize: 11, lineHeight: 1.35, color: msg.ok ? P.mute : '#b91c1c' }}>{msg.text}</div>}
      </div>
    </Section>
  );
};

export const DrawingPanel: React.FC = () => {
  const open = useDraft(s => s.panelOpen), cmd = useDraft(s => s.cmd), aids = useDraft(s => s.aids);
  const activePlane = useDraft(s => s.activePlane), planePick = useDraft(s => s.planePick);
  const planeLabel = useDraft(s => s.planes.find(p => p.id === s.activePlane)?.label ?? 'Ground');
  const candLabel = useDraft(s => s.planeCandidate?.label ?? null), iso = useDraft(s => s.isolate), session = useDraft(s => s.session);
  const ortho = useAppStore(s => s.orthoMode) === OrthoMode.ON, toggleOrtho = useAppStore(s => s.toggleOrthoMode);
  const snapOn = useAppStore(s => s.snapEnabled), setSnapOn = useAppStore(s => s.setSnapEnabled);
  const snapSettings = useAppStore(s => s.snapSettings), toggleSnap = useAppStore(s => s.toggleSnapSetting);
  const [hint, setHint] = useState<Hint>(null);
  const tip = (title: string, key?: string) => ({ onMouseEnter: () => setHint({ title, key }), onMouseLeave: () => setHint(null) });
  // Odak düğmede kalmasın: sonraki Enter / Boşluk komut satırına gitsin, düğmeyi yeniden tetiklemesin.
  const run = (id: string) => { (document.activeElement as HTMLElement | null)?.blur?.(); startCommand(id); };
  // ARAÇLAR (Goker: "düğmeleri daha da büyüt; basit ve kategorilerine göre sınıflanmış olsun"): 36 px düğmeler, her kategori kendi başlığı
  // altında. Çizimde her AİLE (dikdörtgen, çokgen, daire, elips, yay) tek düğmedir ve son kullanılan yöntemi başlatır; ailenin öteki
  // yöntemleri o aile etkinken en altta tek satır olarak açılır.
  const [fam, setFam] = useState<string | null>(null);
  const [last, setLast] = useState<Record<string, string>>({});
  const titleOf = (b: Block | null, id: string) => { const def = commandById(id)!; return b?.prefix ? `${b.prefix} · ${def.label}` : def.label; };
  const tool = (id: string, b: Block | null, big: boolean, onPick?: () => void) => (
    <button key={id} className={`dp-btn${big ? ' lg' : ''}${cmd?.id === id ? ' on' : ''}`} onClick={() => { onPick?.(); run(id); }} aria-label={titleOf(b, id)} {...tip(titleOf(b, id), aliasOf(id))}>
      <DIcon name={id} size={big ? 21 : 18} />
    </button>
  );
  const group = (label: string, kids: React.ReactNode, n: number) => (
    <div key={label} className="dp-blk">
      <span className="dp-cap">{label}</span>
      <div className="dp-card" style={{ gridTemplateColumns: `repeat(${n}, 36px)` }}>{kids}</div>
    </div>
  );
  const family = (b: Block) => {
    const id = last[b.label] ?? b.ids[0], on = !!cmd && b.ids.includes(cmd.id);
    return (
      <button key={b.label} className={`dp-btn lg${on ? ' on' : ''}${fam === b.label ? ' fam' : ''}`} aria-label={titleOf(b, id)} aria-expanded={fam === b.label}
        onClick={() => { setFam(b.label); run(id); }} {...tip(`${titleOf(b, id)}  ·  ${b.ids.length} methods`, aliasOf(id))}>
        <DIcon name={id} size={21} />
      </button>
    );
  };
  const blk = (label: string) => DRAW_BLOCKS.find(b => b.label === label)!;
  const openFam = DRAW_BLOCKS.find(b => b.label === fam && b.ids.length > 2) ?? null;
  const drawTools = (
    <>
      <div className="dp-flow">
        {group('Lines', blk('Lines').ids.map(id => tool(id, blk('Lines'), true, () => setFam(null))), 2)}
        {group('Curves', [family(blk('Arc')), family(blk('Circle')), family(blk('Ellipse'))], 3)}
        {group('Shapes', [family(blk('Rectangle')), family(blk('Polygon'))], 2)}
      </div>
      {openFam && (
        <div className="dp-blk" style={{ marginTop: 9 }}>
          <span className="dp-cap">{openFam.label} methods</span>
          <div className="dp-card" style={{ gridTemplateColumns: `repeat(${Math.min(openFam.ids.length, 6)}, 36px)` }}>
            {openFam.ids.map(id => tool(id, openFam, true, () => setLast(l => ({ ...l, [openFam.label]: id }))))}
          </div>
        </div>
      )}
    </>
  );
  const modifyTools = <div className="dp-flow">{MODIFY_BLOCKS.map(b => group(b.label, b.ids.map(id => tool(id, b, true)), b.ids.length))}</div>;
  const onFace = activePlane !== GROUND_PLANE.id;
  const readout = hint
    ? <><span style={{ color: P.ink, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{hint.title}</span>
      {hint.key && <kbd style={{ marginLeft: 'auto', font: `500 10px ${MONO_FONT}`, color: '#c2410c', background: 'rgba(234,88,12,0.08)', padding: '2px 5px', borderRadius: 4 }}>{hint.key}</kbd>}</>
    : cmd
      ? <><i style={{ width: 6, height: 6, borderRadius: '50%', background: P.accent, flexShrink: 0 }} />
        <span style={{ color: '#c2410c', fontWeight: 600, fontFamily: MONO_FONT, fontSize: 10.5 }}>{cmd.id.replace('_', ' ')}</span>
        <span style={{ color: P.mute, overflow: 'hidden', textOverflow: 'ellipsis' }}>{cmd.prompt.replace(/^.*? {2}/, '')}</span></>
      : null;

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
              <button className={`dp-btn txt${!onFace && !planePick ? ' on' : ''}`} onClick={() => { void exitFace(); }} {...tip('Draw on the ground plane')}>
                <DIcon name="ground" size={17} />Ground
              </button>
              <button className={`dp-btn txt${onFace || planePick ? ' on' : ''}`} disabled={!!session} onClick={() => (planePick ? cancelFacePick() : beginFacePick())}
                {...tip(session ? 'Finish editing the step first' : 'Pick a body or panel face to draw on')}>
                <DIcon name="face" size={17} />{planePick ? 'Picking…' : 'Face'}
              </button>
              <button className="dp-btn" onClick={() => viewPlaneFn?.()} aria-label="Look at plane" {...tip('Look straight at the drawing plane')}><DIcon name="look" /></button>
              {onFace && !planePick && (
                <button className={`dp-btn${iso ? ' on' : ''}`} aria-pressed={!!iso} aria-label="Isolate" onClick={toggleIsolate}
                  {...tip(iso ? 'Isolated — click to show the other parts again' : 'Isolate — hide everything except this face')}><DIcon name="solo" /></button>
              )}
            </div>
            {/* Yüz seçimi: tıklanan aday vurgulanır, ONAYLANINCA düzlem olur (sağ tık / Enter da onaylar). */}
            {planePick && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 7 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, fontWeight: candLabel ? 600 : 400, color: candLabel ? P.ink : P.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {candLabel ?? 'Click a face'}
                </span>
                <button className="dp-primary" style={{ flex: 'none', padding: '0 11px' }} disabled={!candLabel} onClick={confirmFacePick}
                  {...tip('Confirm the highlighted face — click the same spot again for the face behind', 'Enter')}>
                  <DIcon name="check" size={15} />Confirm
                </button>
                <button className="dp-ghost" style={{ padding: '0 9px' }} onClick={() => cancelFacePick()}>Cancel</button>
              </div>
            )}
          </Section>
          {onFace && !planePick && <FaceApply tip={tip} />}
          <Section title="Draw">{drawTools}</Section>
          <Section title="Modify">{modifyTools}</Section>
          <Section title="Object snap" closed
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
          <Section title="Drafting aids" closed>
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
  const label = useDraft(s => s.planes.find(p => p.id === s.activePlane)?.label ?? 'Ground'), count = useDraft(s => s.entities.reduce((n, e) => n + (e.ref ? 0 : 1), 0));
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
