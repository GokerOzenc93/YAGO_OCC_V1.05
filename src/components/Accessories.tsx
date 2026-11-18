/* AKSESUAR SEKMESİ — kategori soldaki raydan (Legs · Connectors · Types · Layers); Assembly / Parameters ile aynı parçalar.
   Panel tipleri (temsili dolap · üstten görünüş · kenar dizilimi) ve bağlayıcılar dosyanın ikinci yarısında (çekirdek: ConnectorService).
   Ayak modeli: 3 yuva (Top · Middle · Bottom), her parça nihai ölçü + taşıma + Stretch + katman; delikler önizlemede parça yüzüne
   tıklanarak eklenir (yön = yüz normali, parçaya bağlı). Ayak seti ("kaset") = model + köşe düzeni + mesafeler + yükseklik; yerleşim
   otomatik (gövde yüz rolleri). Katmanlar kütüphane geneli (ad + renk). Kütüphane IndexedDB'de. */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { ContactShadows, GizmoHelper, Grid, Html, Line, OrbitControls, useGizmoContext } from '@react-three/drei';
import { Plus, Trash2, Upload, Pencil, RotateCcw, Drill, Check, ChevronDown, Copy, FlaskConical, Crosshair, Magnet, Maximize2, Minus, MousePointer2, PenLine, Spline, Square, BoxSelect, X, Circle as CircleIcon } from 'lucide-react';
import {
  type AccessoryLayer, type AccessoryUnit, type ConnHole, type ConnOp, type ConnOpType, type ConnPart, type ConnShape, type ConnSurface, type ConnUse, type Connector, type ConnectorLayoutSet,
  type HoleSpec, type LayoutKind, type LayoutLine, type LegModel, type LegModelPart, type LegPartRole, type LegPreset, type PanelEdgeDir, type PanelSurface,
  type PanelTypeConfig, type PanelTypeId, useAppStore, useStoreFields,
} from '../store';
import { UI_FONT, useEscapeOwner } from './Ui';
import { type AxisDir, type Vec3, round1 } from './Geometry';
import {
  ACCESSORY_ACCEPT, HOLE_AXES, HOLE_DEFAULTS, LAYER_DEFAULT_COLOR, type LegAssemblyPart, type LegHoleAt, type SnapPoint, accessoryGeometryNow, assemblyFootprint, axisVecOf,
  deleteAccessoryLayer, deleteLegModel, deleteLegPreset, detectPartEmbed, holeAxisOf, holeLegPos, holePosFromLeg, importAccessoryFile, layerUseCount, legAssembly, legContactHeight, legHolesAt,
  legModelDims, legModelHasStem, legPartDims, legPartEmbed, legPartOffset, legPartStretches, legTopHeight, meshSnapPoints, newAccessoryLayer, newHole, newLegModel, newLegPreset, onAccessoryGeometry,
  presetLayout, pruneUnusedAccessoryModels, saveAccessoryLayer, saveLegModel, saveLegPreset, snapDirToAxis, updateAccessoryModel,
} from './AccessoryService';
import {
  ApplyBtn, CARD_BODY, CARD_BODY_STYLE, CardAction, ExitBtn, FIELD_INPUT, LegLayoutCells, LegLayoutDiagram, QB_CELL_ROW, QbNum, QbSection, QbSelect,
  FieldBox, QbSwitch, ROW_SEL_BAR, ROW_SEL_HEAD, ReadCell, ReadValue, RowCells, RowChevron, SECTION_LABEL, type SegItem, Segmented, SelectBox, rectLegPoints, rowCardClass,
} from './Assembly';
import {
  CONN_REP, CONN_SURFACES, EDGE_ENDS, EDGE_LABEL, PANEL_SURFACES, PANEL_TYPES, PANEL_TYPE_GROUPS, PLANE_EDGES, PLANE_LABEL, type PanelPlane, candidateTypesFor, cloneConnector,
  connOpSummary, connShapeClosed, connShapePoints, connSurfaceCoords, connSurfaceDepth, connSurfaceExtent, connSurfacePoint, connThickness, connectorUseCount, deleteConnector, addSampleConnector,
  edgeRulesOf, newConnHole, newConnOp, newConnPart, newConnector, panelTypeDef, panelTypeLabel, panelTypeShort, saveConnector, setEdgeLayout, setSurfaceRule,
  surfaceLabel, surfaceRuleOf, typeEdgeCount, LAYOUT_KINDS, MAX_LAYOUT_POINTS, MAX_LAYOUT_STEPS, cloneLayoutSet, deleteLayoutSet, layoutKindLabel, layoutUseCount, lineApplies,
  lineConnectorIds, lineHasSecond, linePoints, lineRangeText, lineSummary, newLayoutLine, newLayoutSet, saveLayoutSet, secondConnectorPatch,
} from './ConnectorService';
import { standardLegRules } from './LegLayout';
import { syncPlinthSetsUsingPreset } from './PlinthService';
import { fmt1, stop } from './PanelSchematics';

const UNIT_OPTS: Array<{ v: AccessoryUnit; label: string }> = [{ v: 'mm', label: 'mm' }, { v: 'cm', label: 'cm' }, { v: 'm', label: 'm' }, { v: 'in', label: 'in' }];
const UP_OPTS: Array<{ v: 'y' | 'z'; label: string }> = [{ v: 'y', label: 'Y↑' }, { v: 'z', label: 'Z↑' }];
/** Yuvalar ekranda ÜSTTEN alta (ayağın kendisi gibi); montaj alttan üste (AccessoryService.orderedParts). */
const SLOTS: Array<{ role: LegPartRole; label: string }> = [{ role: 'top', label: 'Top' }, { role: 'stem', label: 'Middle' }, { role: 'base', label: 'Bottom' }];
const SLOT_ROLE_LABEL: Record<LegPartRole, string> = { top: 'Top', stem: 'Middle', base: 'Bottom' };
const ROW = 'yago-cell w-full min-w-0 h-[30px] pl-2 pr-1 flex items-center gap-2';
const ICON_BTN = 'shrink-0 w-[24px] h-[24px] flex items-center justify-center rounded-[6px] text-stone-400 hover:text-stone-900 hover:bg-[#ece7e0] transition-colors';
const DEL_BTN = `${ICON_BTN} hover:!text-red-600 hover:!bg-red-50`;
const TEXT_INPUT: React.CSSProperties = { ...FIELD_INPUT, width: 'auto', flex: 1, textAlign: 'left', fontSize: 12 };
const MUTED = 'text-[10.5px] text-stone-400 tabular-nums';
/** Set düzenleyici önizlemesinin örnek gövde izi (mm): set gövdeden bağımsızdır (kenardan mm), yerleşince gerçek ize göre çözülür. */
const SAMPLE_W = 600, SAMPLE_D = 560;

/* ═════════════════════════════════ Önizleme sahnesi ═════════════════════════════════ */
function useDraftAssembly(leg: LegModel | null, h: number): LegAssemblyPart[] | null {
  const [tick, setTick] = useState(0);
  useEffect(() => onAccessoryGeometry(() => setTick(t => t + 1)), []);
  // Parçalar + taşıma / ölçek / katman: değişince montaj yeniden kurulur
  const key = leg ? JSON.stringify(leg.parts.map(p => [p.modelId, p.role, p.offset ?? null, p.dims ?? null, p.stretch ?? null, p.scale ?? null, p.layerId ?? null, p.embed ?? null])) : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (leg && leg.parts.length ? legAssembly(leg, h, accessoryGeometryNow) : null), [key, h, tick]);
}
/* Sahne dili: yumuşak eksen renkleri (doygun kırmızı / yeşil / mavi yerine), turuncu yalnız seçim. */
const AXIS = { x: '#c75050', y: '#4a9a62', z: '#4a74c9' } as const;
const SEL = '#ea580c', INK = '#57534e', SOFT = '#b8b0a4';
const PREVIEW_H = 320;
/** Kamera: model ya da yükseklik kutusu değişince 3/4 görünüşe oturur (fitKey = parçalar + yükseklik). */
function FitView({ R, total, fitKey }: { R: number; total: number; fitKey: string }) {
  const camera = useThree(s => s.camera) as THREE.PerspectiveCamera;
  const controls = useThree(s => s.controls) as unknown as { target: THREE.Vector3; update: () => void } | null;
  useEffect(() => {
    // 3/4 görünüş: hedef modelin ortası, uzaklık görüş alanına (fov 26°) model + pay sığacak kadar
    const target = new THREE.Vector3(0, total * 0.5, 0);
    camera.position.copy(target).addScaledVector(new THREE.Vector3(0.62, 0.42, 0.68).normalize(), R * 3.9);
    camera.near = Math.max(0.2, R * 0.005); camera.far = R * 80; camera.updateProjectionMatrix();
    if (controls) { controls.target.copy(target); controls.update(); } else camera.lookAt(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, !!controls]);
  return null;
}
/** MİNİMAL EKSEN ÜÇLÜSÜ (GizmoViewport yerine): üç ince çubuk + küçük harf başlığı; başlığa tık kamerayı o eksene çevirir. */
function MiniTriad() {
  const { tweenCamera } = useGizmoContext();
  const gl = useThree(s => s.gl);
  const heads = useMemo(() => (['X', 'Y', 'Z'] as const).map((label, i) => {
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.beginPath(); ctx.arc(32, 32, 15, 0, Math.PI * 2); ctx.fillStyle = [AXIS.x, AXIS.y, AXIS.z][i]; ctx.fill();
    ctx.font = '600 20px Inter, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#ffffff'; ctx.fillText(label, 32, 33);
    const tex = new THREE.CanvasTexture(canvas); tex.anisotropy = gl.capabilities.getMaxAnisotropy() || 1;
    return tex;
  }), [gl]);
  const dirs: Array<[number, number, number]> = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const rots: Array<[number, number, number]> = [[0, 0, 0], [0, 0, Math.PI / 2], [0, -Math.PI / 2, 0]];
  const colors = [AXIS.x, AXIS.y, AXIS.z];
  return (
    <group scale={38}>
      {dirs.map((d, i) => (
        <group key={i}>
          <group rotation={rots[i]}>
            <mesh position={[0.4, 0, 0]}><boxGeometry args={[0.8, 0.028, 0.028]} /><meshBasicMaterial color={colors[i]} toneMapped={false} /></mesh>
          </group>
          <sprite position={d} scale={0.52} onPointerDown={e => { e.stopPropagation(); tweenCamera(e.object.position); }}
            onPointerOver={e => { e.stopPropagation(); gl.domElement.style.cursor = 'pointer'; }} onPointerOut={() => { gl.domElement.style.cursor = ''; }}>
            <spriteMaterial map={heads[i]} alphaTest={0.3} toneMapped={false} />
          </sprite>
        </group>
      ))}
    </group>
  );
}
/** ORİJİN (0,0,0): ayağın zemine bastığı nokta, iz merkezi — küçük nokta + üç kısa ince eksen çizgisi (yazı rozeti yok). */
function OriginMark({ len }: { len: number }) {
  const r = Math.max(0.45, len * 0.045);
  const axis = (to: [number, number, number], color: string, label: string) => (
    <group key={label}>
      <Line points={[[0, 0, 0], to]} color={color} lineWidth={1.1} transparent opacity={0.8} depthTest={false} renderOrder={10} />
      <Html position={to} center zIndexRange={[20, 30]} style={{ pointerEvents: 'none' }}>
        <span style={{ fontFamily: UI_FONT, fontSize: 8.5, fontWeight: 700, color, letterSpacing: '0.04em', textShadow: '0 0 2px #fff, 0 0 2px #fff', transform: 'translate(7px, -6px)', display: 'inline-block' }}>{label}</span>
      </Html>
    </group>
  );
  return (
    <group>
      {axis([len, 0, 0], AXIS.x, 'x')}{axis([0, len, 0], AXIS.y, 'y')}{axis([0, 0, len], AXIS.z, 'z')}
      <mesh renderOrder={11}><sphereGeometry args={[r, 16, 12]} /><meshBasicMaterial color={INK} depthTest={false} /></mesh>
    </group>
  );
}
/** Yükseklik ölçüsü: modelin yanında ince dikey ölçü çizgisi + uçlarda kısa tırnaklar + değer. */
function HeightMark({ x, total }: { x: number; total: number }) {
  const t = Math.max(0.8, total * 0.025);
  return (
    <group>
      <Line points={[[x, 0, 0], [x, total, 0]]} color={SOFT} lineWidth={0.9} />
      <Line points={[[x - t, 0, 0], [x + t, 0, 0]]} color={SOFT} lineWidth={0.9} />
      <Line points={[[x - t, total, 0], [x + t, total, 0]]} color={SOFT} lineWidth={0.9} />
      <Html position={[x, total / 2, 0]} zIndexRange={[20, 30]} style={{ pointerEvents: 'none', transform: 'translate(7px, -50%)' }}>
        <span style={{ fontFamily: UI_FONT, fontSize: 9.5, fontWeight: 600, color: INK, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', textShadow: '0 0 2px #fff, 0 0 2px #fff' }}>
          {fmt1(total)}
        </span>
      </Html>
    </group>
  );
}
/** Hayalet panel: temas düzleminde yarı saydam 18 mm levha (panele giren kısım görünür); ışına yanıt vermez. */
function GhostPanel({ y, size }: { y: number; size: number }) {
  const t = 18;
  const edges = useMemo(() => { const h = size / 2; const pts: [number, number, number][] = [[-h, 0, -h], [h, 0, -h], [h, 0, h], [-h, 0, h], [-h, 0, -h]]; return pts; }, [size]);
  return (
    <group position={[0, y, 0]}>
      <mesh position={[0, t / 2, 0]} raycast={() => null} renderOrder={5}>
        <boxGeometry args={[size, t, size]} />
        <meshStandardMaterial color="#d6b98f" transparent opacity={0.16} depthWrite={false} roughness={0.9} />
      </mesh>
      <Line points={edges} color="#c9b18f" lineWidth={0.9} transparent opacity={0.7} />
      <Line points={edges.map(p => [p[0], t, p[2]] as [number, number, number])} color="#c9b18f" lineWidth={0.9} transparent opacity={0.5} />
    </group>
  );
}
const UP = new THREE.Vector3(0, 1, 0);
const quatToDir = (dir: Vec3) => new THREE.Quaternion().setFromUnitVectors(UP, new THREE.Vector3(...dir).normalize());
const circlePts = (r: number, n = 48): [number, number, number][] => Array.from({ length: n + 1 }, (_, i) => { const a = (i / n) * Math.PI * 2; return [Math.cos(a) * r, 0, Math.sin(a) * r]; });
/** DELİK İŞARETİ (CAD delik özelliği gibi): ağızda halka + yönde yarı saydam silindir + eksen çizgisi; seçili turuncu, tık satırı seçer. */
function HoleGlyph({ at, selected, onClick }: { at: Pick<LegHoleAt, 'center' | 'dir' | 'radius' | 'depth'>; selected: boolean; onClick: () => void }) {
  const gl = useThree(s => s.gl);
  const q = useMemo(() => quatToDir(at.dir), [at.dir]);
  const ring = useMemo(() => circlePts(at.radius), [at.radius]);
  const color = selected ? SEL : INK;
  const d = at.depth;
  return (
    <group position={at.center} quaternion={q}>
      <mesh position={[0, d / 2, 0]} onClick={e => { e.stopPropagation(); onClick(); }}
        onPointerOver={e => { e.stopPropagation(); gl.domElement.style.cursor = 'pointer'; }} onPointerOut={() => { gl.domElement.style.cursor = ''; }}>
        <cylinderGeometry args={[at.radius, at.radius, d, 24]} />
        <meshStandardMaterial color={selected ? SEL : '#6b655e'} transparent opacity={selected ? 0.5 : 0.3} depthWrite={false} roughness={0.8} />
      </mesh>
      <Line points={ring} color={color} lineWidth={selected ? 1.8 : 1.2} depthTest={false} renderOrder={12} />
      <Line points={[[0, -d * 0.25, 0], [0, d * 1.2, 0]]} color={color} lineWidth={0.8} dashed dashSize={1.2} gapSize={0.8} depthTest={false} renderOrder={12} transparent opacity={0.9} />
    </group>
  );
}
/** Delik kipinde imlecin altındaki nokta: hayalet halka + artı; yakalanmışsa türüne göre işaret (■ köşe · ▲ orta · ◎ merkez). */
function HoverRing({ at, radius }: { at: HoverAt; radius: number }) {
  const q = useMemo(() => quatToDir(at.dir), [at.dir]);
  const ring = useMemo(() => circlePts(radius), [radius]);
  const mark = at.kind === 'vertex' ? <rect x="2" y="2" width="8" height="8" /> : at.kind === 'mid' ? <path d="M6 1.5 L11 10.5 L1 10.5 Z" /> : at.kind === 'center' ? <circle cx="6" cy="6" r="4.2" /> : null;
  return (
    <group position={at.point} quaternion={q}>
      <Line points={ring} color={SEL} lineWidth={1.4} depthTest={false} renderOrder={13} />
      <Line points={[[-radius * 1.6, 0, 0], [radius * 1.6, 0, 0]]} color={SEL} lineWidth={0.8} depthTest={false} renderOrder={13} />
      <Line points={[[0, 0, -radius * 1.6], [0, 0, radius * 1.6]]} color={SEL} lineWidth={0.8} depthTest={false} renderOrder={13} />
      {mark && (
        <Html center zIndexRange={[20, 30]} style={{ pointerEvents: 'none' }}>
          <svg width="12" height="12" viewBox="0 0 12 12" style={{ display: 'block', fill: 'none', stroke: SEL, strokeWidth: 1.6, filter: 'drop-shadow(0 0 1.5px #fff)' }}>{mark}</svg>
        </Html>
      )}
    </group>
  );
}
type PickAt = { point: Vec3; dir: Vec3; part: LegPartRole };
type HoverAt = PickAt & { kind: SnapPoint['kind'] | null };
/** Yakalama adayı (ayak uzayında): parça yakalama noktası + parça yeri / ölçeği uygulanmış; normaller ölçekle düzeltilmiş. */
type SnapCand = { kind: SnapPoint['kind']; point: Vec3; normals: Vec3[]; part: LegPartRole };
const SNAP_PX = 14;
function snapCandidatesOf(parts: LegAssemblyPart[]): SnapCand[] {
  const out: SnapCand[] = [];
  for (const p of parts) {
    for (const s of meshSnapPoints(p.geo)) {
      const point: Vec3 = [p.x + s.p[0] * p.scaleX, p.y + s.p[1] * p.scaleY, p.z + s.p[2] * p.scaleZ];
      const normals = s.normals.map(n => { const v = new THREE.Vector3(n[0] / (p.scaleX || 1), n[1] / (p.scaleY || 1), n[2] / (p.scaleZ || 1)).normalize(); return [v.x, v.y, v.z] as Vec3; });
      out.push({ kind: s.kind, point, normals, part: p.role });
    }
  }
  return out;
}
/** Parça: katman renginde; normal kipte tık yuva satırını açar; delik kipinde olaylar yakalayıcıya (LegScene) gider. */
function PartMesh({ p, color, highlight, holeMode, onMove, onPick, onSelect, onLeave }: {
  p: LegAssemblyPart; color: string; highlight: boolean; holeMode: boolean;
  onMove: (e: any, part: LegAssemblyPart) => void; onPick: () => void; onSelect: () => void; onLeave: () => void;
}) {
  const gl = useThree(s => s.gl);
  return (
    <mesh geometry={p.geo} position={[p.x, p.y, p.z]} scale={[p.scaleX, p.scaleY, p.scaleZ]} castShadow receiveShadow
      onPointerMove={e => { if (!holeMode) return; e.stopPropagation(); onMove(e, p); }}
      onPointerOver={e => { e.stopPropagation(); gl.domElement.style.cursor = holeMode ? 'crosshair' : 'pointer'; }}
      onPointerOut={() => { onLeave(); gl.domElement.style.cursor = ''; }}
      onClick={e => { e.stopPropagation(); if (holeMode) onPick(); else onSelect(); }}>
      <meshStandardMaterial color={color} roughness={0.52} metalness={0.1} emissive={highlight ? SEL : '#000000'} emissiveIntensity={highlight ? 0.22 : 0} />
    </mesh>
  );
}
/** Delik kipinde TÜM yakalama noktaları soluk nokta olarak (nerede yakalayacağı görünür). */
function SnapDots({ cands }: { cands: SnapCand[] }) {
  const geo = useMemo(() => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(cands.flatMap(c => c.point), 3)); return g; }, [cands]);
  useEffect(() => () => geo.dispose(), [geo]);
  if (!cands.length) return null;
  return <points geometry={geo} renderOrder={11}><pointsMaterial size={3} sizeAttenuation={false} color="#a3998c" depthTest={false} transparent opacity={0.85} /></points>;
}
/** Sahne içi: parçalar + delikler + yakalama. Delik kipinde ≤ 14 px içindeki yakalama noktasına kilitlenir (boşluktaki delik ağzı da),
 *  yoksa yüzey noktası (0,5 mm). Yön: yüz normali ya da noktanın kameraya bakan normali, eksene kıstırılmış. */
function LegScene({ parts, holes, layers, openSlot, onSelectSlot, holeMode, holeRadius, selectedHoleId, onSelectHole, onAddHole, R }: {
  parts: LegAssemblyPart[] | null; holes: LegHoleAt[]; layers: AccessoryLayer[]; openSlot: LegPartRole | null; onSelectSlot: (r: LegPartRole) => void;
  holeMode: boolean; holeRadius: number; selectedHoleId: string | null; onSelectHole: (id: string | null) => void; onAddHole: (at: PickAt) => void; R: number;
}) {
  const camera = useThree(s => s.camera), size = useThree(s => s.size), gl = useThree(s => s.gl);
  const [hover, setHover] = useState<HoverAt | null>(null);
  const hoverRef = useRef<HoverAt | null>(null); hoverRef.current = hover;
  useEffect(() => { if (!holeMode) setHover(null); }, [holeMode]);
  const cands = useMemo(() => (holeMode && parts ? snapCandidatesOf(parts) : []), [holeMode, parts]);
  // Harness kancası (yalnız dev): imlecin altındaki yakalama + ayak uzayı → kanvas pikseli izdüşümü
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as Record<string, unknown>;
    w.__legHover = hover; w.__legSnaps = cands;
    w.__legProject = (pt: Vec3) => { const v = new THREE.Vector3(...pt).project(camera); return [(v.x + 1) / 2 * size.width, (1 - v.y) / 2 * size.height]; };
  }, [hover, cands, camera, size]);
  const colorOf = (p: LegAssemblyPart) => layers.find(l => l.id === p.layerId)?.color ?? LAYER_DEFAULT_COLOR;
  const faceDir = (e: any): Vec3 | null => {
    if (!e.face) return null;
    const n = e.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(e.object.matrixWorld)).normalize();
    return snapDirToAxis([n.x, n.y, n.z]);
  };
  const onMove = (e: any, part: LegAssemblyPart | null) => {
    if (!holeMode) return;
    const px = e.pointer as THREE.Vector2;
    let best: SnapCand | null = null, bestD = SNAP_PX, bestZ = Infinity;
    const v = new THREE.Vector3();
    for (const c of cands) {
      v.set(c.point[0], c.point[1], c.point[2]).project(camera);
      if (v.z > 1 || v.z < -1) continue;
      const d = Math.hypot((v.x - px.x) * size.width / 2, (v.y - px.y) * size.height / 2);
      if (d < bestD - 0.5 || (d <= bestD + 0.5 && v.z < bestZ)) { best = c; bestD = Math.min(bestD, d); bestZ = v.z; }
    }
    const fd = part ? faceDir(e) : null;
    if (best) {
      let dir = fd && part && part.role === best.part ? fd : null;
      if (!dir) {
        // Kameraya en çok bakan normal
        const toCam = new THREE.Vector3().subVectors(camera.position, new THREE.Vector3(...best.point)).normalize();
        let bn = best.normals[0] ?? [0, 1, 0], bd = -Infinity;
        for (const n of best.normals) { const d = n[0] * toCam.x + n[1] * toCam.y + n[2] * toCam.z; if (d > bd) { bd = d; bn = n; } }
        dir = snapDirToAxis(bn);
      }
      setHover({ point: best.point, dir, part: best.part, kind: best.kind });
    } else if (part && fd) {
      const pt = e.point as THREE.Vector3;
      setHover({ point: [Math.round(pt.x * 2) / 2, Math.round(pt.y * 2) / 2, Math.round(pt.z * 2) / 2], dir: fd, part: part.role, kind: null });
    } else setHover(null);
  };
  const pick = () => { const h = hoverRef.current; if (h) onAddHole({ point: h.point, dir: h.dir, part: h.part }); };
  return (
    <>
      {parts?.map((p, i) => (
        <PartMesh key={`${p.modelId}-${i}`} p={p} color={colorOf(p)} highlight={openSlot === p.role} holeMode={holeMode}
          onMove={onMove} onPick={pick} onSelect={() => onSelectSlot(p.role)} onLeave={() => { if (!hoverRef.current?.kind) setHover(null); }} />
      ))}
      {holes.map(at => <HoleGlyph key={at.hole.id} at={at} selected={at.hole.id === selectedHoleId} onClick={() => onSelectHole(at.hole.id)} />)}
      {holeMode && (
        <>
          {/* Arka plan küresi: parça dışında da imleç izlenir (delik merkezi boşlukta kalabilir); görünmez, ışına yanıt verir */}
          <mesh onPointerMove={e => { e.stopPropagation(); onMove(e, null); gl.domElement.style.cursor = 'crosshair'; }} onPointerOut={() => { setHover(null); gl.domElement.style.cursor = ''; }}
            onClick={e => { e.stopPropagation(); pick(); }}>
            <sphereGeometry args={[R * 30, 12, 8]} />
            <meshBasicMaterial side={THREE.BackSide} transparent opacity={0} depthWrite={false} colorWrite={false} />
          </mesh>
          <SnapDots cands={cands} />
          {hover && <HoverRing at={hover} radius={holeRadius} />}
        </>
      )}
    </>
  );
}
const HUD: React.CSSProperties = { fontFamily: UI_FONT, fontSize: 10.5, color: '#8a8378', pointerEvents: 'none', fontVariantNumeric: 'tabular-nums' };
const PREVIEW_TOOL = (on: boolean) => `h-[24px] px-2 flex items-center gap-1.5 rounded-[6px] text-[10.5px] font-semibold transition-colors duration-150
  ${on ? 'bg-[#292524] text-white' : 'bg-white/90 text-stone-600 ring-1 ring-[#e3ddd4] hover:bg-white hover:ring-[#cfc7bc] hover:text-stone-900'}`;
/** Ayak önizleme sahnesi. Sol sürükle döndür, sağ sürükle kaydır, tekerlek yaklaş (kenar çubuğunu kaydırmaz); "Hole" kipi delik ekler. */
function LegPreview({ leg, parts, height, layers, openSlot, onSelectSlot, holeMode, onHoleMode, holeRadius, selectedHoleId, onSelectHole, onAddHole }: {
  leg: LegModel | null; parts: LegAssemblyPart[] | null; height: number; layers: AccessoryLayer[]; openSlot: LegPartRole | null; onSelectSlot: (r: LegPartRole) => void;
  holeMode: boolean; onHoleMode: (b: boolean) => void; holeRadius: number; selectedHoleId: string | null; onSelectHole: (id: string | null) => void;
  onAddHole: (at: PickAt) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  // Tekerlek sahnede kalır (yakınlaştırma); kenar çubuğu kaymaz. React'in wheel'i passive → yerel dinleyici.
  useEffect(() => {
    const el = box.current; if (!el) return;
    const onWheel = (e: WheelEvent) => e.preventDefault();
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const footprint = useMemo(() => (parts ? Math.max(20, assemblyFootprint(parts)) : 60), [parts]);
  // total = model tepesi (kadraj); contact = temas yüksekliği (panelin altı; ölçü ve HUD) — pimler panele giriyorsa farklıdır
  const total = useMemo(() => (parts ? legTopHeight(parts) : height), [parts, height]);
  const contact = useMemo(() => (parts ? legContactHeight(parts) : height), [parts, height]);
  const holes = useMemo(() => (leg ? legHolesAt(leg, parts) : []), [leg, parts]);
  const R = Math.max(total, footprint) * 1.15;
  // Kamera model ya da yükseklik kutusu değişince modele yeniden oturur (kutu Enter / blur ile tek seferde yazılır).
  const fitKey = parts ? `${parts.map(p => p.modelId).join('|')}@${Math.round(total)}@${Math.round(footprint)}` : 'none';
  return (
    <div ref={box} onContextMenu={e => e.preventDefault()} className="relative w-full rounded-[9px] overflow-hidden ring-1 ring-[#e3ddd4]"
      style={{ height: PREVIEW_H, background: 'linear-gradient(180deg,#fbfaf7 0%,#f2eee7 100%)', overscrollBehavior: 'contain' }}>
      <Canvas dpr={[1, 2]} shadows camera={{ position: [R * 2.6, total * 0.5 + R * 1.9, R * 2.85], fov: 26, near: 1, far: 20000 }}
        gl={{ antialias: true, alpha: true }} style={{ touchAction: 'none' }} onPointerMissed={() => { if (!holeMode) onSelectHole(null); }}>
        <FitView R={R} total={total} fitKey={fitKey} />
        {/* Stüdyo: gökyüzü/zemin yarım küre + yumuşak gölgeli ana ışık + arkadan dolgu */}
        <hemisphereLight args={['#ffffff', '#d8d1c6', 0.95]} />
        <directionalLight position={[R * 1.4, R * 2.4, R * 1.1]} intensity={0.7} castShadow shadow-mapSize={[2048, 2048]}
          shadow-camera-left={-R} shadow-camera-right={R} shadow-camera-top={R} shadow-camera-bottom={-R} shadow-camera-near={0.5} shadow-camera-far={R * 8} shadow-bias={-0.0004} shadow-radius={6} />
        <directionalLight position={[-R * 2, R * 1.1, -R * 1.6]} intensity={0.42} />
        <directionalLight position={[R * 0.4, R * 0.8, -R * 2.2]} intensity={0.22} />
        {/* Zemin: ince, düşük kontrastlı ızgara (10 mm hücre, 50 mm bölüm) + yumuşak temas gölgesi */}
        <Grid position={[0, -0.02, 0]} args={[R * 6, R * 6]} cellSize={10} cellThickness={0.55} cellColor="#d9d2c7" sectionSize={50} sectionThickness={0.9}
          sectionColor="#c3bab0" fadeDistance={R * 4} fadeStrength={1.6} infiniteGrid followCamera={false} />
        <ContactShadows position={[0, 0.01, 0]} opacity={0.3} scale={R * 3} blur={2.8} far={total + 10} resolution={512} color="#2f2a25" />
        <LegScene parts={parts} holes={holes} layers={layers} openSlot={openSlot} onSelectSlot={onSelectSlot} holeMode={holeMode} holeRadius={holeRadius}
          selectedHoleId={selectedHoleId} onSelectHole={onSelectHole} onAddHole={onAddHole} R={R} />
        <OriginMark len={Math.max(footprint * 0.45, total * 0.16)} />
        {parts && <HeightMark x={footprint / 2 + Math.max(8, footprint * 0.22)} total={contact} />}
        {parts && <GhostPanel y={contact} size={Math.max(footprint * 1.9, 90)} />}
        {/* Sol = döndür · orta = yaklaş · SAĞ = kaydır */}
        <OrbitControls makeDefault enablePan screenSpacePanning panSpeed={0.9} enableDamping dampingFactor={0.12} minDistance={R * 1.2} maxDistance={R * 12} maxPolarAngle={Math.PI * 0.85}
          mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }} />
        <GizmoHelper alignment="bottom-right" margin={[38, 38]}>
          <MiniTriad />
        </GizmoHelper>
      </Canvas>
      {/* Sağ üst: Hole kipi (yüzeye / yakalama noktasına tık → delik) */}
      {parts && (
        <div className="absolute right-2 top-2 flex items-center gap-1" style={{ fontFamily: UI_FONT }}>
          <button type="button" title={holeMode ? 'Hole mode — click a face or a snap point (corner · edge middle · circle centre); Esc to leave' : 'Add holes by clicking the part faces (snaps to corners, edge middles and circle centres)'}
            onClick={e => { stop(e); onHoleMode(!holeMode); }} className={PREVIEW_TOOL(holeMode)}>
            <Drill size={12} strokeWidth={2.1} />{holeMode ? 'Click a face' : 'Hole'}
          </button>
        </div>
      )}
      {parts && (
        <div className="absolute left-2.5 bottom-2 flex items-center gap-1.5" style={HUD}>
          <span className="font-semibold text-stone-500" title={total - contact > 0.05 ? `Height to the panel; ${fmt1(total - contact)} mm goes into the panel` : 'Height to the panel'}>H {fmt1(contact)}</span>
          {total - contact > 0.05 && <><span>·</span><span title="Into the panel">↑ {fmt1(total - contact)}</span></>}<span>·</span>
          <span className="font-semibold text-stone-500">Ø {fmt1(footprint)}</span><span>·</span>
          <span>{parts.length} part{parts.length === 1 ? '' : 's'}</span>
          {holes.length > 0 && <><span>·</span><span>{holes.length} hole{holes.length === 1 ? '' : 's'}</span></>}
        </div>
      )}
      {!parts && leg && leg.parts.length > 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-stone-400" style={{ fontFamily: UI_FONT }}>Loading…</div>
      )}
      {!parts && (!leg || !leg.parts.length) && (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-stone-400" style={{ fontFamily: UI_FONT }}>Add a model below</div>
      )}
    </div>
  );
}

/* ═════════════════════════════════ Ayak modeli: 3 yuva ═════════════════════════════════
   Yuva = Assembly satırı gibi başlık; tıklayınca kart (Size / Move nihai mm · Stretch · Unit · Up · Layer). Tek kart açık. */
/** Düzenlenebilir hücre (beyaz; Assembly hücreleriyle aynı görünüm). */
const EditCell = ({ label, title, className = '', children }: { label: string; title?: string; className?: string; children: React.ReactNode }) => (
  <div title={title} onClick={stop} className={`${className} yago-cell min-w-0 h-full pl-2 pr-1 flex items-center gap-1`}>
    <span className="yago-label flex-1 min-w-0 truncate">{label}</span>
    {children}
  </div>
);
const Swatch = ({ color, size = 10 }: { color: string; size?: number }) => (
  <span className="shrink-0 rounded-full ring-1 ring-black/10" style={{ width: size, height: size, background: color }} />
);
/** Katman seçici: renk noktası + seçim (— = katmansız). */
function LayerSelect({ value, layers, onChange }: { value: string | null | undefined; layers: AccessoryLayer[]; onChange: (id: string | null) => void }) {
  const cur = layers.find(l => l.id === value);
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <Swatch color={cur?.color ?? LAYER_DEFAULT_COLOR} />
      <QbSelect value={cur ? cur.id : ''} w={88} options={[{ v: '', label: layers.length ? '— none' : 'no layers' }, ...layers.map(l => ({ v: l.id, label: l.name }))]}
        onChange={v => onChange(v || null)} />
    </div>
  );
}
function SlotRow({ role, draft, setDraft, onPick, busy, open, onToggle, layers }: {
  role: LegPartRole; draft: LegModel; setDraft: (m: LegModel) => void; onPick: (role: LegPartRole) => void; busy: boolean;
  open: boolean; onToggle: () => void; layers: AccessoryLayer[];
}) {
  const { accessoryModels } = useStoreFields('accessoryModels');
  const part = draft.parts.find(p => p.role === role);
  const m = part ? accessoryModels.find(x => x.id === part.modelId) : undefined;
  const setPart = (patch: Partial<LegModelPart>) => setDraft({ ...draft, parts: draft.parts.map(p => (p.role === role ? { ...p, ...patch } : p)) });
  const label = SLOT_ROLE_LABEL[role];
  if (!part || !m) {
    return (
      <div className={`${rowCardClass(false, false, false)} h-[34px] !flex-row items-center gap-2 pl-2.5 pr-1.5`}>
        <span className="yago-label shrink-0 w-[50px]">{label}</span>
        <button type="button" disabled={busy} onClick={e => { stop(e); onPick(role); }}
          className="flex-1 min-w-0 h-[24px] flex items-center justify-center gap-1.5 rounded-[6px] border border-dashed border-[#d3ccc2] text-[11px] font-semibold text-stone-500 hover:bg-[#f6f3ee] hover:border-[#bfb7ab] hover:text-stone-800 transition-colors">
          <Upload size={12} strokeWidth={2} />Add model
        </button>
      </div>
    );
  }
  const dims = legPartDims(part, m.size), off = legPartOffset(part), st = legPartStretches(part), embed = legPartEmbed(part, dims[1]);
  // Modelden bul: geometri hazırsa en büyük +Y düzlem; nihai ölçüye (Size Y / model Y) göre
  const detectEmbed = () => { const g = accessoryGeometryNow(part.modelId); return g ? detectPartEmbed(g.geo, dims[1] / (g.size[1] || 1)) : 0; };
  const layer = layers.find(l => l.id === part.layerId);
  const setDim = (i: number, v: number) => { const d = [...dims] as Vec3; d[i] = Math.max(0.1, v); setPart({ dims: d, scale: undefined }); };
  const setOff = (i: number, v: number) => { const o = [...off] as Vec3; o[i] = v; setPart({ offset: o }); };
  const num = (v: number, on: (v: number) => void, min = -100000) => <QbNum value={v} min={min} w={46} onCommit={on} />;
  const toggle = (e: React.MouseEvent) => { stop(e); onToggle(); };
  const removePart = () => setDraft({ ...draft, parts: draft.parts.filter(p => p.role !== role), holes: (draft.holes ?? []).filter(h => h.part !== role) });
  return (
    <div className={rowCardClass(open, false, false)}>
      <div onClick={toggle} className={`relative h-[34px] pl-2.5 pr-1 flex items-center gap-2 cursor-pointer transition-colors duration-150 hover:bg-[#faf8f5] ${open ? ROW_SEL_HEAD : ''}`}>
        {open && <span className={ROW_SEL_BAR} />}
        <span className="yago-label shrink-0 w-[50px]">{label}</span>
        <Swatch color={layer?.color ?? LAYER_DEFAULT_COLOR} size={8} />
        <span className="flex-1 min-w-0 truncate text-[11.5px] font-medium text-stone-700" title={`${m.source ? `${m.source} → STL` : m.fileName}${layer ? ` · layer ${layer.name}` : ''}`}>{m.name}</span>
        {embed > 0 && <span className="shrink-0 text-[10px] font-semibold tabular-nums text-stone-400" title={`${fmt1(embed)} mm goes into the panel`}>↑{fmt1(embed)}</span>}
        <RowCells cells={[['X', dims[0]], ['Y', st ? '↕' : dims[1]], ['Z', dims[2]]]} title={`${fmt1(dims[0])} × ${fmt1(dims[1])} × ${fmt1(dims[2])} mm${st ? ' · stretches' : ''}${embed > 0 ? ` · ${fmt1(embed)} into the panel` : ''}`} />
        <RowChevron open={open} onClick={toggle} />
      </div>
      {open && (
        <div className={CARD_BODY} style={CARD_BODY_STYLE} onClick={stop}>
          <div className="flex flex-col gap-1">
            <div className="grid grid-cols-3 gap-x-1" style={QB_CELL_ROW}>
              <EditCell label="Size X">{num(dims[0], v => setDim(0, v), 0.1)}</EditCell>
              <EditCell label="Size Y" title={st ? 'Stretches with the leg height (this value sets its share)' : undefined}>{num(dims[1], v => setDim(1, v), 0.1)}</EditCell>
              <EditCell label="Size Z">{num(dims[2], v => setDim(2, v), 0.1)}</EditCell>
              <EditCell label="Move X">{num(off[0], v => setOff(0, v))}</EditCell>
              <EditCell label="Move Y">{num(off[1], v => setOff(1, v))}</EditCell>
              <EditCell label="Move Z">{num(off[2], v => setOff(2, v))}</EditCell>
              <EditCell label="Stretch" title={st ? 'Stretches when the leg height changes' : 'Fixed at Size Y'}>
                <QbSwitch on={st} onToggle={() => setPart({ stretch: !st })} />
              </EditCell>
              <EditCell label="Unit"><QbSelect value={m.unit} options={UNIT_OPTS} w={40} onChange={v => void updateAccessoryModel(m.id, { unit: v })} /></EditCell>
              <EditCell label="Up"><QbSelect value={m.upAxis} options={UP_OPTS} w={40} onChange={v => void updateAccessoryModel(m.id, { upAxis: v })} /></EditCell>
              <EditCell label="Layer" className="col-span-2" title="Layer of this part — colour in the preview and the 3D scene (Accessories › Layers)">
                <LayerSelect value={part.layerId} layers={layers} onChange={id => setPart({ layerId: id })} />
              </EditCell>
              {role === 'top' && (
                <EditCell label="Into panel" title="How much of the top of this part sits above the contact plane and goes INTO the panel (pins, screw bosses above the plate). The leg height is measured to the contact plane; the model extends this far into the panel. ↻ = detect from the model (largest upward-facing plane).">
                  <button type="button" title="Detect from the model: the largest upward-facing plane is the contact plane" onClick={e => { stop(e); setPart({ embed: detectEmbed() }); }}
                    className="w-[18px] h-[18px] shrink-0 rounded-[5px] flex items-center justify-center text-stone-400 hover:bg-[#f3efe8] hover:text-stone-700"><RotateCcw size={11} strokeWidth={2.2} /></button>
                  {num(embed, v => setPart({ embed: Math.max(0, v) }), 0)}
                </EditCell>
              )}
            </div>
            <div className="flex items-center gap-1 pt-0.5">
              <CardAction compact icon={Upload} label="Replace" title="Replace the model file (size and move are kept)" onClick={() => onPick(role)} />
              <CardAction compact icon={RotateCcw} label="Reset" title="Model size, no move" onClick={() => setPart({ dims: undefined, offset: undefined, scale: undefined, embed: undefined })} />
              <div className="flex-1" />
              <CardAction compact icon={Trash2} label="Remove" title="Remove this part (and its holes)" onClick={removePart} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ═════════════════════════════════ Delikler ═════════════════════════════════
   Tek satır, kart yok: # · yön · X Y Z (ayak sıfırına göre) · Ø D · parça · sil. Satır ↔ 3D seçimi eşli; Delete siler. */
const PART_OPTS: Array<{ v: string; label: string }> = [{ v: '', label: 'Origin' }, { v: 'top', label: 'Top' }, { v: 'stem', label: 'Middle' }, { v: 'base', label: 'Bottom' }];
const DIR_OPTS = [...HOLE_AXES.map(a => ({ v: a.v as string, label: a.label })), { v: 'custom', label: '·' }];
/** Satır içi küçük alan: harf + değer. */
const Mini = ({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) => (
  <span className="shrink-0 inline-flex items-center gap-[2px]" title={title} onClick={stop}>
    <span className="text-[10px] font-semibold text-stone-400">{label}</span>{children}
  </span>
);
function HoleRow({ hole, index, legPos, parts, selected, onSelect, onChange, onRemove }: {
  hole: HoleSpec; index: number; legPos: Vec3; parts: LegAssemblyPart[] | null; selected: boolean; onSelect: () => void;
  onChange: (patch: Partial<HoleSpec>) => void; onRemove: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (selected) ref.current?.scrollIntoView({ block: 'nearest' }); }, [selected]);
  const axis = holeAxisOf(hole.dir);
  const setLeg = (i: number, v: number) => { const p = [...legPos] as Vec3; p[i] = v; onChange({ pos: holePosFromLeg(p, hole.part, parts) }); };
  const setPartRole = (v: string) => { const part = (v || null) as LegPartRole | null; onChange({ part, pos: holePosFromLeg(legPos, part, parts) }); };
  const num = (v: number, on: (v: number) => void, min = -100000) => <QbNum value={v} min={min} w={36} onCommit={on} />;
  return (
    <div ref={ref} onClick={e => { stop(e); onSelect(); }}
      className={`relative h-[30px] pl-2 pr-1 flex items-center gap-[5px] rounded-[8px] ring-1 cursor-pointer transition-colors duration-150
        ${selected ? 'bg-[#fbf9f6] ring-[#d4cdc3]' : 'bg-white ring-[#e6e1d9] hover:ring-[#cfc7bc]'}`}>
      {selected && <span className={ROW_SEL_BAR} />}
      <span className={`shrink-0 w-[14px] text-[11px] font-semibold tabular-nums ${selected ? 'text-stone-700' : 'text-stone-400'}`}>{index + 1}</span>
      <span onClick={stop} title="Drilling direction — out of the leg surface, into the panel it touches">
        <QbSelect value={axis ?? 'custom'} options={DIR_OPTS} w={40} onChange={v => { if (v !== 'custom') onChange({ dir: axisVecOf(v as AxisDir) }); }} />
      </span>
      <Mini label="X" title="From the leg origin (mm)">{num(legPos[0], v => setLeg(0, v))}</Mini>
      <Mini label="Y" title="From the leg origin (mm)">{num(legPos[1], v => setLeg(1, v))}</Mini>
      <Mini label="Z" title="From the leg origin (mm)">{num(legPos[2], v => setLeg(2, v))}</Mini>
      <span className="w-px h-3.5 bg-[#e6e0d6] shrink-0" />
      <Mini label="Ø" title="Diameter (mm)">{num(hole.diameter, v => onChange({ diameter: Math.max(0.2, v) }), 0.2)}</Mini>
      <Mini label="D" title="Depth from the mouth (mm) — the panel is cut where the cylinder enters it">{num(hole.depth, v => onChange({ depth: Math.max(0.1, v) }), 0.1)}</Mini>
      <span className="flex-1 min-w-0" />
      <span onClick={stop} title="Bound part — the hole moves with it (Origin = fixed to the leg origin)">
        <QbSelect value={hole.part ?? ''} options={PART_OPTS} w={58} onChange={setPartRole} />
      </span>
      <button type="button" title="Remove this hole" onClick={e => { stop(e); onRemove(); }}
        className="shrink-0 w-[22px] h-[22px] rounded-md flex items-center justify-center text-stone-400 hover:bg-red-50 hover:text-red-500 transition-colors"><Trash2 size={12} strokeWidth={2} /></button>
    </div>
  );
}

/** Ayak modeli düzenleyici: üst blok (ad + önizleme) yapışık kalır — sahne kaydırılmadan delikler görülsün; altı kayar. */
function LegModelEditor({ draft, setDraft, onSave, onCancel, layers }: {
  draft: LegModel; setDraft: (m: LegModel) => void; onSave: () => void; onCancel: () => void; layers: AccessoryLayer[];
}) {
  const [testH, setTestH] = useState(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);   // DWG / DXF dönüşüm özeti (hata değil)
  const [openSlot, setOpenSlot] = useState<LegPartRole | null>(null);
  const [holeMode, setHoleMode] = useState(false);
  const [selectedHole, setSelectedHole] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const slotRef = useRef<LegPartRole>('stem');
  const draftRef = useRef(draft); draftRef.current = draft;
  const selRef = useRef(selectedHole); selRef.current = selectedHole;
  const pick = (role: LegPartRole) => { slotRef.current = role; setError(null); setInfo(null); fileRef.current?.click(); };
  const onFile = async (files: FileList | null) => {
    const f = files?.[0]; if (!f) return;
    setBusy(true); setError(null); setInfo(null);
    try {
      const m = await importAccessoryFile(f);
      setInfo(m.note ?? null);
      const role = slotRef.current, cur = draftRef.current;
      // Model değiştirilirse yuvanın ölçü / taşıma / uzama / katman ayarı korunur
      const prev = cur.parts.find(p => p.role === role);
      setDraft({ ...cur, parts: [...cur.parts.filter(p => p.role !== role), { ...(prev ?? {}), modelId: m.id, role }] });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const setHoles = (next: HoleSpec[]) => setDraft({ ...draftRef.current, holes: next });
  const removeHole = (id: string) => { setHoles((draftRef.current.holes ?? []).filter(h => h.id !== id)); if (selRef.current === id) setSelectedHole(null); };
  // Esc delik kipinden çıkar; Delete (bir giriş alanında değilken) seçili deliği siler
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      if (e.key === 'Escape') setHoleMode(false);
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selRef.current && tag !== 'input' && tag !== 'select' && tag !== 'textarea') { e.preventDefault(); removeHole(selRef.current); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEscapeOwner('leg-hole', holeMode);
  const parts = useDraftAssembly(draft, testH);
  const holes = draft.holes ?? [];
  const last = holes[holes.length - 1];
  const holeDefaults = { diameter: last?.diameter ?? HOLE_DEFAULTS.diameter, depth: last?.depth ?? HOLE_DEFAULTS.depth };
  const addHole = (at: PickAt) => {
    const h = newHole({ ...holeDefaults, part: at.part, dir: at.dir, pos: holePosFromLeg(at.point, at.part, parts) });
    setHoles([...(draftRef.current.holes ?? []), h]); setSelectedHole(h.id);
  };
  const changeHole = (id: string, patch: Partial<HoleSpec>) => setHoles((draftRef.current.holes ?? []).map(h => (h.id === id ? { ...h, ...patch } : h)));
  const stretchy = legModelHasStem(draft), natural = legModelDims(draft)?.height ?? 0;
  return (
    <>
      {/* YAPIŞIK üst blok: ad + önizleme (kenar çubuğu kayarken yerinde kalır) */}
      <div className="sticky top-0 z-30 -mx-1.5 -mt-1.5 px-1.5 pt-1.5 pb-1.5 flex flex-col gap-1.5" onClick={stop}
        style={{ background: '#f8f6f2', boxShadow: '0 6px 10px -8px rgba(40,30,20,0.18)' }}>
        <div className="flex items-center gap-1.5">
          <div className="yago-cell flex-1 min-w-0 h-[28px] px-2 flex items-center">
            <input type="text" value={draft.name} placeholder="Leg model" spellCheck={false} onChange={e => setDraft({ ...draft, name: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') onCancel(); }} className="yago-field yago-field-text" style={TEXT_INPUT} />
          </div>
          <ApplyBtn enabled={!busy && draft.parts.length > 0} onClick={onSave} title="Save" />
          <ExitBtn onClick={onCancel} />
        </div>
        <LegPreview leg={draft} parts={parts} height={testH} layers={layers} openSlot={openSlot} onSelectSlot={r => setOpenSlot(o => (o === r ? null : r))}
          holeMode={holeMode} onHoleMode={setHoleMode} holeRadius={holeDefaults.diameter / 2} selectedHoleId={selectedHole} onSelectHole={setSelectedHole} onAddHole={addHole} />
      </div>
      <QbSection title="Leg model" sub={draft.name || undefined}>
        <div className="flex flex-col gap-1.5" onClick={stop}>
          {/* Ayak yüksekliği (mm kutusu): uzayan parçalar bu boya uzar; uzayan parça yoksa ayak doğal boyunda sabit */}
          <div className="grid grid-cols-2 gap-x-1" style={QB_CELL_ROW}>
            {stretchy
              ? <EditCell label="Leg height"><QbNum value={testH} min={1} w={56} onCommit={setTestH} /></EditCell>
              : <ReadCell label="Leg height"><ReadValue color="#a8a29e">{natural ? `${fmt1(natural)} · fixed` : '—'}</ReadValue></ReadCell>}
            <ReadCell label="Natural height"><ReadValue color="#57534e">{natural ? fmt1(natural) : '—'}</ReadValue></ReadCell>
          </div>
          <div className="flex flex-col gap-1">
            {SLOTS.map(s => <SlotRow key={s.role} role={s.role} draft={draft} setDraft={setDraft} onPick={pick} busy={busy} layers={layers}
              open={openSlot === s.role} onToggle={() => setOpenSlot(o => (o === s.role ? null : s.role))} />)}
          </div>
          {/* DELİKLER */}
          {draft.parts.length > 0 && (
            <div className="flex flex-col gap-1 pt-1">
              <div className="flex items-center gap-1.5 px-0.5">
                <span style={SECTION_LABEL}>Holes</span>
                {holes.length > 0 && <span className="text-[10px] font-semibold tabular-nums text-stone-400">{holes.length}</span>}
                <span className="min-w-0 truncate text-[10px] text-stone-400">{holeMode ? 'click a face or a snap point · Esc' : holes.length ? 'cut from the panel they touch · Delete removes the selected' : ''}</span>
                <div className="flex-1" />
                <CardAction compact icon={Drill} label={holeMode ? 'Done' : 'Add hole'} active={holeMode} tone="amber"
                  title={holeMode ? 'Leave hole mode' : 'Add a hole: click a part face or a snap point in the preview (corner · edge middle · circle centre)'} onClick={() => setHoleMode(!holeMode)} />
              </div>
              {holes.map((h, i) => (
                <HoleRow key={h.id} hole={h} index={i} legPos={holeLegPos(h, parts).map(round1) as Vec3} parts={parts} selected={selectedHole === h.id}
                  onSelect={() => setSelectedHole(s => (s === h.id ? null : h.id))} onChange={patch => changeHole(h.id, patch)} onRemove={() => removeHole(h.id)} />
              ))}
            </div>
          )}
          <input ref={fileRef} type="file" accept={ACCESSORY_ACCEPT} className="hidden" onChange={e => { void onFile(e.target.files); e.target.value = ''; }} />
          {(busy || error || info) && <div className={`px-1 text-[10.5px] ${busy ? 'text-stone-400' : error ? 'text-red-600' : 'text-stone-500'}`}>{busy ? 'Importing…' : error ?? info}</div>}
        </div>
      </QbSection>
    </>
  );
}

/* ═════════════════════════════════ Ayak seti ═════════════════════════════════ */
/** Set düzenleyici: model · köşe düzeni · mesafeler · yükseklik. Plan örnek iz (600 × 560) üstünde; yerleşince gerçek ize göre çözülür. */
function LegPresetEditor({ draft, setDraft, legModels, onSave, onCancel }: {
  draft: LegPreset; setDraft: (p: LegPreset) => void; legModels: LegModel[]; onSave: () => void; onCancel: () => void;
}) {
  const [hint, setHint] = useState<string | null>(null);
  const L = presetLayout(draft);
  const lm = legModels.find(m => m.id === draft.legModelId);
  const diameter = legModelDims(lm)?.diameter || 50;
  const modelOpts: Array<[string, string]> = legModels.length
    ? [...(lm ? [] : [['', 'Choose a leg model…'] as [string, string]]), ...legModels.map(m => [m.id, m.name] as [string, string])]
    : [['', 'No leg models yet — add one above']];
  const setLayout = (p: Partial<{ count: number; side: number; front: number; rear: number }>) => {
    const n = { ...L, ...p, count: ((p.count ?? L.count) as 4 | 5 | 6) };
    setDraft({ ...draft, ...n, rules: standardLegRules(n.count, n.side, n.front, n.rear) });
  };
  const points = useMemo(() => rectLegPoints({ ...L, diameter }, SAMPLE_W, SAMPLE_D), [L.count, L.side, L.front, L.rear, diameter]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="flex flex-col gap-1.5" onClick={stop} onMouseLeave={() => setHint(null)}>
      <div className="flex items-center gap-1.5">
        <div className="yago-cell flex-1 min-w-0 h-[28px] px-2 flex items-center">
          <input type="text" value={draft.name} placeholder="Leg set" spellCheck={false} onChange={e => setDraft({ ...draft, name: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') onCancel(); }} className="yago-field yago-field-text" style={TEXT_INPUT} />
        </div>
        <ApplyBtn enabled={!!lm || !legModels.length} onClick={onSave} title={lm || !legModels.length ? 'Save' : 'Choose a leg model first'} />
        <ExitBtn onClick={onCancel} />
      </div>
      <div className="flex items-center gap-1.5">
        <div className="flex-1 min-w-0 flex">
          <SelectBox label="Model" className="flex-1" value={lm ? lm.id : ''} options={modelOpts} title="Foot model (Leg models above) — Ø comes from it" onChange={v => setDraft({ ...draft, legModelId: v || null })} />
        </div>
      </div>
      <LegLayoutDiagram points={points} footprint={[{ x: 0, y: 0 }, { x: SAMPLE_W, y: 0 }, { x: SAMPLE_W, y: SAMPLE_D }, { x: 0, y: SAMPLE_D }]} facing="z+"
        diameter={diameter} active={hint} className="w-full" />
      <LegLayoutCells legs={L} diameter={diameter}
        onChange={setLayout} hint={hint} onHint={setHint}
        heightCell={<EditCell label="Height" title="Default height of a free set (a set under a bottom panel follows the panel)">
          <QbNum value={draft.height} min={1} onCommit={v => setDraft({ ...draft, height: v })} />
        </EditCell>} />
    </div>
  );
}

/* ═════════════════════════════════ Katmanlar ═════════════════════════════════
   Satır: renk · ad (yerinde düzenlenir) · kullanan parça sayısı · sil. */
function LayerRow({ layer, uses }: { layer: AccessoryLayer; uses: number }) {
  const [name, setName] = useState(layer.name);
  useEffect(() => setName(layer.name), [layer.name]);
  const commit = () => { const n = name.trim() || layer.name; if (n !== layer.name) void saveAccessoryLayer({ ...layer, name: n }); else setName(layer.name); };
  return (
    <div className={ROW}>
      <label className="relative shrink-0 w-[18px] h-[18px] rounded-full ring-1 ring-black/10 cursor-pointer overflow-hidden" style={{ background: layer.color }} title="Colour — click to change">
        <input type="color" value={layer.color} onChange={e => void saveAccessoryLayer({ ...layer, color: e.target.value })}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
      </label>
      <input type="text" value={name} spellCheck={false} onChange={e => setName(e.target.value)} onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setName(layer.name); (e.target as HTMLInputElement).blur(); } }}
        className="yago-field yago-field-text" style={TEXT_INPUT} title="Layer name — click to rename" />
      <span className={`shrink-0 ${MUTED}`} title="Parts on this layer">{uses ? `${uses} part${uses === 1 ? '' : 's'}` : 'unused'}</span>
      <button type="button" title={uses ? 'Delete the layer — its parts become unlayered' : 'Delete'} onClick={() => void deleteAccessoryLayer(layer.id)} className={DEL_BTN}><Trash2 size={12} strokeWidth={1.9} /></button>
    </div>
  );
}
function LayersPanel() {
  const { accessoryLayers, legModels, connectors } = useStoreFields('accessoryLayers', 'legModels', 'connectors');
  return (
    <div className="px-1.5 pt-1.5 pb-2 flex flex-col gap-1.5" style={{ fontFamily: UI_FONT }}>
      <QbSection title="Layers" sub="shared by every accessory part"
        trailing={<CardAction compact icon={Plus} label="New" title="New layer" onClick={() => void saveAccessoryLayer(newAccessoryLayer(`Layer ${accessoryLayers.length + 1}`))} />}>
        {!accessoryLayers.length ? <Empty /> : (
          <div className="flex flex-col gap-1">
            {accessoryLayers.map(l => <LayerRow key={l.id} layer={l} uses={layerUseCount(l.id, legModels, connectors)} />)}
          </div>
        )}
      </QbSection>
    </div>
  );
}

/* ═════════════════════════════════ PANEL TİPLERİ ═════════════════════════════════
   1) TEMSİLİ DOLAP (3B, döndürülebilir): her parça bir panel tipi — tıkla, seç. Sol arka köşede kolon, üst arkada kiriş: onları dönen paneller
      (Column side / front · Beam front / horizontal) de dolabın parçası. Üst / alt tam panel ↔ kayıtlar sol üstteki seçimle değişir.
   2) Seçili tipin ÜSTTEN GÖRÜNÜŞÜ: dört kenar, üzerlerinde bağlayıcıların gerçek delik izleri. Kenara tık → o kenar açılır.
   3) KENAR ŞERİDİ: seçili kenar boyunca dizilim — bir kenarda 4'e kadar ayrı bağlayıcı, her biri kendi renginde ve kendi dizilimiyle. Baştaki /
      sondaki bağlayıcı şeritte SÜRÜKLENİR; "Joint length" kaydırıcısı dizilimin kısa / uzun birleşimde nasıl davrandığını gösterir.
   Her değişiklik anında kaydedilir ve gövdeler yeniden üretilir (sürükleme bırakılınca). */
const PT = { stroke: '#8a8073', fill: '#efe6d4', ghost: '#cfc7bc', sel: '#ea580c', ink: '#44403c', mute: '#a39b91', dark: '#292524' } as const;
/** Kenardaki bağlayıcıların renkleri (sıra numarasına göre): turuncu · petrol · mor · hardal. */
const RULE_COLORS = ['#ea580c', '#0f766e', '#6d5fa3', '#a16207'] as const;
/** Işına yanıt: varsayılan / hiç (kipine göre açılıp kapanan nesnelerde `undefined` verilemez). */
const MESH_RAY = THREE.Mesh.prototype.raycast, NO_RAY = () => null;

// ───────── 1. Temsili dolap ─────────
/** Temsili dolap (mm, gövde-yerel: x sol → sağ · y yukarı · z arka → ön). cw × cd = kolon (sol arka köşe) · bh × bd = kiriş (üst arka). */
const CAB = { W: 900, H: 780, D: 540, T: 18, PL: 100, cw: 160, cd: 140, bh: 130, bd: 200 } as const;
type CabBuild = 'panels' | 'railsH' | 'railsV';
/** Parça: kutu ya da `ax` ekseni boyunca çekilmiş çokgen (çentikli yan / alt / raf). Çokgen ekseni izleyen iki eksende: ax 0 → (y, z) · 1 → (z, x). */
type CabPart = { type: PanelTypeId; box?: [Vec3, Vec3]; ex?: { ax: 0 | 1; from: number; to: number; poly: Array<[number, number]> }; pale?: boolean };
function cabinetParts(build: CabBuild, rearPanel: boolean): CabPart[] {
  const { W, H, D, T, PL, cw, cd, bh, bd } = CAB;
  const yB = PL + T, yU = H - bh - T, zB = 18, xd = 500;
  const box = (type: PanelTypeId, a: Vec3, b: Vec3, pale?: boolean): CabPart => ({ type, box: [a, b], pale });
  const parts: CabPart[] = [
    { type: 'leftSide', ex: { ax: 0, from: 0, to: T, poly: [[0, cd], [H - bh, cd], [H - bh, bd], [H, bd], [H, D], [0, D]] } },
    { type: 'rightSide', ex: { ax: 0, from: W - T, to: W, poly: [[0, 0], [H - bh, 0], [H - bh, bd], [H, bd], [H, D], [0, D]] } },
    rearPanel ? box('rearPanel', [cw + T, yB, 0], [W - T, yU, 18]) : box('back', [cw + T, yB, 10], [W - T, yU, 18], true),
    box('columnSide', [cw, yB, 0], [cw + T, yU, cd + T]), box('columnFront', [T, yB, cd], [cw, yU, cd + T]),
    { type: 'beamHoriz', ex: { ax: 1, from: yU, to: yU + T, poly: [[zB, cw], [zB, W - T], [bd + T, W - T], [bd + T, T], [cd, T], [cd, cw]] } },
    box('beamFront', [T, H - bh, bd], [W - T, H - T, bd + T]),
    { type: 'divider', ex: { ax: 0, from: xd, to: xd + T, poly: [[yB, zB], [yU, zB], [yU, bd + T], [H - T, bd + T], [H - T, D - 20], [yB, D - 20]] } },
    { type: 'fixedShelf', ex: { ax: 1, from: 430, to: 448, poly: [[zB, cw + T], [zB, xd], [D - 20, xd], [D - 20, T], [cd + T, T], [cd + T, cw + T]] } },
    box('adjustableShelf', [xd + T + 1, 330, zB + 2], [W - T - 1, 348, D - 45]),
    box('frontPlinth', [T, 0, D - 50 - T], [W - T, PL, D - 50]), box('rearPlinth', [cw + T, 0, 60], [W - T, PL, 60 + T]),
  ];
  if (build === 'panels') {
    parts.push(box('top', [T, H - T, bd], [W - T, H, D]),
      { type: 'bottom', ex: { ax: 1, from: PL, to: PL + T, poly: [[0, cw], [0, W - T], [D, W - T], [D, T], [cd, T], [cd, cw]] } });
  } else if (build === 'railsH') {
    parts.push(box('topFrontRailH', [T, H - T, D - 110], [W - T, H, D]), box('topRearRailH', [T, H - T, bd], [W - T, H, bd + 110]),
      box('bottomFrontRailH', [T, PL, D - 110], [W - T, PL + T, D]), box('bottomRearRailH', [cw, PL, 0], [W - T, PL + T, 110]));
  } else {
    parts.push(box('topFrontRailV', [T, H - 90, D - T], [W - T, H, D]), box('topRearRailV', [T, H - 90, bd + T], [W - T, H, bd + 2 * T]),
      box('bottomFrontRailV', [T, PL, D - T], [W - T, PL + 90, D]), box('bottomRearRailV', [cw + T, PL, zB], [W - T, PL + 90, zB + T]));
  }
  return parts;
}
/** Tipin göründüğü kuruluş: kayıt tipi → kayıtlı kuruluş, üst / alt panel → tam panelli; ötekiler kuruluşu değiştirmez. */
const buildOfType = (t: PanelTypeId): CabBuild | null =>
  (/Rail[HV]$/.test(t) ? (t.endsWith('H') ? 'railsH' : 'railsV') : t === 'top' || t === 'bottom' ? 'panels' : null);
function cabGeometry(p: Pick<CabPart, 'box' | 'ex'>): THREE.BufferGeometry {
  if (p.box) {
    const [a, b] = p.box, g = new THREE.BoxGeometry(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    return g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  }
  const { ax, from, to, poly } = p.ex!;
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(poly.map(([u, v]) => new THREE.Vector2(u, v))), { depth: to - from, bevelEnabled: false });
  // Çokgen düzlemi (u, v) + çekme yönü → gövde eksenleri; taban sağ-elli kalır (yüzler ters dönmez).
  const e = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  return g.applyMatrix4(new THREE.Matrix4().makeBasis(e[(ax + 1) % 3], e[(ax + 2) % 3], e[ax]).setPosition(e[ax].clone().multiplyScalar(from)));
}
/** Katının keskin kenarları → çizgi parçası noktaları (kalın çizgi için; ince `lineSegments` panelleri seçtirmiyordu). */
function edgeSegments(geo: THREE.BufferGeometry): Vec3[] {
  const e = new THREE.EdgesGeometry(geo, 20), pos = e.getAttribute('position') as THREE.BufferAttribute, out: Vec3[] = [];
  for (let i = 0; i < pos.count; i++) out.push([pos.getX(i), pos.getY(i), pos.getZ(i)]);
  e.dispose();
  return out;
}
const CAB_TONE = { wood: '#efe0c6', pale: '#f8f2e6', hover: '#e0c79c', sel: '#f4a261', edge: '#4d453c', selEdge: '#b93c08', concrete: '#c4bfb7', concreteEdge: '#8d8780' } as const;
/** Dolap parçası: ahşap tonunda katı + koyu kenar çizgisi. Seçili parça turuncu ve öteki panellerin ARKASINDAN da görünür (röntgen). */
function CabinetPartMesh({ part, state, onOver, onOut, onPick }: { part: CabPart; state: 'sel' | 'hover' | 'idle'; onOver: () => void; onOut: () => void; onPick: () => void }) {
  const gl = useThree(s => s.gl);
  const geo = useMemo(() => cabGeometry(part), [part]);
  const lines = useMemo(() => edgeSegments(geo), [geo]);
  useEffect(() => () => geo.dispose(), [geo]);
  const sel = state === 'sel';
  return (
    <group>
      <mesh geometry={geo} onClick={e => { e.stopPropagation(); if (e.delta < 5) onPick(); }}
        onPointerOver={e => { e.stopPropagation(); onOver(); gl.domElement.style.cursor = 'pointer'; }} onPointerOut={() => { onOut(); gl.domElement.style.cursor = ''; }}>
        <meshStandardMaterial color={sel ? CAB_TONE.sel : state === 'hover' ? CAB_TONE.hover : part.pale ? CAB_TONE.pale : CAB_TONE.wood} roughness={0.92}
          polygonOffset polygonOffsetFactor={1} polygonOffsetUnits={1} />
      </mesh>
      <Line points={lines} segments color={sel ? CAB_TONE.selEdge : CAB_TONE.edge} lineWidth={sel ? 1.8 : 1.25} raycast={NO_RAY} />
      {sel && (
        <>
          <mesh geometry={geo} raycast={NO_RAY} renderOrder={20}><meshBasicMaterial color={SEL} transparent opacity={0.14} depthTest={false} depthWrite={false} /></mesh>
          <Line points={lines} segments color={SEL} lineWidth={1.6} transparent opacity={0.9} depthTest={false} renderOrder={21} raycast={NO_RAY} />
        </>
      )}
    </group>
  );
}
/** Duvardaki kolon / kiriş: beton tonunda yarı saydam hacim + ad etiketi (tıklanmaz). */
function CabinetGhost({ min, max, label, labelAt }: { min: Vec3; max: Vec3; label: string; labelAt: Vec3 }) {
  const geo = useMemo(() => cabGeometry({ box: [min, max] }), []);   // eslint-disable-line react-hooks/exhaustive-deps
  const lines = useMemo(() => edgeSegments(geo), [geo]);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <group>
      <mesh geometry={geo} raycast={NO_RAY} renderOrder={2}><meshStandardMaterial color={CAB_TONE.concrete} roughness={1} transparent opacity={0.5} depthWrite={false} /></mesh>
      <Line points={lines} segments color={CAB_TONE.concreteEdge} lineWidth={1} transparent opacity={0.85} raycast={NO_RAY} />
      <Html position={labelAt} center zIndexRange={[20, 30]} style={{ pointerEvents: 'none' }}>
        <span style={{ fontFamily: UI_FONT, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.1em', color: '#6f6a62', whiteSpace: 'nowrap', textShadow: '0 0 3px #fff, 0 0 3px #fff' }}>{label}</span>
      </Html>
    </group>
  );
}
const CAB_BUILDS: Array<{ key: CabBuild; label: string; title: string }> = [
  { key: 'panels', label: 'Panels', title: 'Sample cabinet with a full top and bottom panel' },
  { key: 'railsH', label: 'Traverses · H', title: 'Sample cabinet with horizontal (lying) traverses at the top and bottom, front and rear' },
  { key: 'railsV', label: 'Traverses · V', title: 'Sample cabinet with vertical (standing) traverses at the top and bottom, front and rear' },
];
const CAB_VIEW_H = 270;
/** Kamera: önden, biraz sağdan ve yukarıdan — açık ön yüzden dolabın içi (raflar, kolon / kiriş panelleri) görünür. */
const CAB_TARGET: Vec3 = [CAB.W / 2 - 70, CAB.H / 2 - 4, CAB.D / 2];
const CAB_CAMERA = { position: [CAB_TARGET[0] + 2680 * 0.44, CAB_TARGET[1] + 2680 * 0.25, CAB_TARGET[2] + 2680 * 0.86] as Vec3, fov: 25, near: 10, far: 14000 };
/** TEMSİLİ DOLAP: parçaya tık → tipi seçilir. Sol sürükle döndürür. Seçili tip turuncu; üzerine gelinen tipin adı altta yazar. */
function CabinetView({ sel, onSel, build, onBuild }: { sel: PanelTypeId; onSel: (t: PanelTypeId) => void; build: CabBuild; onBuild: (b: CabBuild) => void }) {
  const [hover, setHover] = useState<PanelTypeId | null>(null);
  const parts = useMemo(() => cabinetParts(build, sel === 'rearPanel'), [build, sel === 'rearPanel']);   // eslint-disable-line react-hooks/exhaustive-deps
  const { W, H, cw, cd, bh, bd } = CAB;
  const shown = parts.some(p => p.type === sel);
  return (
    <div onContextMenu={e => e.preventDefault()} className="relative w-full rounded-[9px] overflow-hidden ring-1 ring-[#e3ddd4]" style={{ height: CAB_VIEW_H, background: '#faf8f5' }}>
      <Canvas flat dpr={[1, 2]} frameloop="demand" gl={{ antialias: true, alpha: true }} style={{ touchAction: 'none' }}
        camera={CAB_CAMERA}>
        <hemisphereLight args={['#ffffff', '#e6dccb', 2.25]} />
        <directionalLight position={[1300, 2100, 2300]} intensity={1.45} />
        <directionalLight position={[-1900, 700, 500]} intensity={0.5} />
        <CabinetGhost label="COLUMN" min={[-34, 0, -34]} max={[cw, H - bh, cd]} labelAt={[cw / 2 - 14, H * 0.3, cd + 2]} />
        <CabinetGhost label="BEAM" min={[-34, H - bh, -34]} max={[W + 34, H + 44, bd]} labelAt={[W * 0.72, H + 18, bd + 2]} />
        {parts.map(p => (
          <CabinetPartMesh key={p.type} part={p} state={p.type === sel ? 'sel' : p.type === hover ? 'hover' : 'idle'}
            onOver={() => setHover(p.type)} onOut={() => setHover(h => (h === p.type ? null : h))} onPick={() => onSel(p.type)} />
        ))}
        <OrbitControls target={CAB_TARGET} enableZoom={false} enablePan={false} rotateSpeed={0.7} minPolarAngle={0.5} maxPolarAngle={Math.PI / 2 + 0.2} />
      </Canvas>
      {/* Sol üst: örnek dolabın üstü / altı tam panel mi, kayıt mı (kayıt tiplerini görmek için) */}
      <div className="absolute left-2 top-2 flex flex-col gap-1" style={{ fontFamily: UI_FONT }} onClick={stop}>
        <span className="pl-0.5" style={{ ...HUD, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.09em' }}>TOP / BOTTOM</span>
        {CAB_BUILDS.map(b => <button key={b.key} type="button" title={b.title} onClick={e => { stop(e); onBuild(b.key); }} className={`${PREVIEW_TOOL(build === b.key)} w-[94px]`}>{b.label}</button>)}
      </div>
      <div className="absolute right-2.5 top-2.5" style={HUD}>drag to turn</div>
      <div className="absolute left-2.5 right-2.5 bottom-2 flex items-center gap-1.5" style={{ ...HUD, fontSize: 11.5 }}>
        <span className="shrink-0 w-[8px] h-[8px] rounded-full" style={{ background: SEL }} />
        <span className="shrink-0 font-semibold text-stone-800">{panelTypeLabel(sel)}</span>
        {!shown && <span className="truncate">{sel === 'free' ? '· not a fixed part of the cabinet' : '· switch the top-left option to see it'}</span>}
        <span className="flex-1" />
        {hover && hover !== sel && <span className="shrink-0 h-[20px] px-2 rounded-full bg-[#292524] text-white text-[10.5px] font-semibold flex items-center">{panelTypeLabel(hover)}</span>}
      </div>
    </div>
  );
}

// ───────── 2. Panelin üstten görünüşü ─────────
/** Tipin örnek ölçüsü (mm): şemanın oranı ve dizilim önizlemesinin başlangıç boyu. [yatay, düşey] — tipin doğal bakışında. */
function sampleSizeOf(type: PanelTypeId, plane: Exclude<PanelPlane, 'any'>): [number, number] {
  const def = panelTypeDef(type), rail = def?.group === 'traverse';
  if (type === 'columnSide') return [158, 520];
  if (type === 'columnFront') return [142, 520];
  if (type === 'beamFront') return [864, 112];
  if (type === 'beamHoriz') return [864, 200];
  if (plane === 'side') return [CAB.D, type === 'divider' ? 644 : CAB.H];
  if (plane === 'horizontal') return [864, rail ? 110 : def?.group === 'interior' ? 500 : CAB.D];
  return [864, rail ? 90 : def?.group === 'plinth' ? CAB.PL : 520];
}
/** Çizime hazır dizilim satırı: bağlayıcıları (1. + iki bağlayıcılı kuralda 2.) ve renkleri (renk bağlayıcıya göre — aynı bağlayıcının farklı
 *  boy kuralları aynı renkte). `two` = 2. yuva açık (bağlayıcısı seçilmemiş de olabilir). */
type LineView = { line: LayoutLine; conn: Connector | undefined; color: string; two: boolean; conn2: Connector | undefined; color2: string };
const NO_CONN_COLOR = '#a8a29e';
function lineViews(set: ConnectorLayoutSet | undefined | null, connectors: Connector[]): LineView[] {
  const order: string[] = [];
  const colorOf = (c: Connector | undefined): string => {
    if (!c) return NO_CONN_COLOR;
    if (!order.includes(c.id)) order.push(c.id);
    return RULE_COLORS[order.indexOf(c.id) % RULE_COLORS.length];
  };
  return (set?.lines ?? []).map(line => {
    const [id1, id2] = lineConnectorIds(line), conn = connectors.find(c => c.id === id1), conn2 = id2 ? connectors.find(c => c.id === id2) : undefined;
    return { line, conn, color: colorOf(conn), two: lineHasSecond(line), conn2, color2: colorOf(conn2) };
  });
}
type SlotView = { slot: 1 | 2; conn: Connector; color: string };
/** Satırın DOLU bağlayıcı yuvaları; `use` verilirse yalnız o noktaya gelenler (bağlayıcısı seçilmemiş yuva atlanır). */
const viewSlots = (v: LineView, use: ConnUse = 3): SlotView[] => [
  ...(v.conn && use & 1 ? [{ slot: 1 as const, conn: v.conn, color: v.color }] : []),
  ...(v.conn2 && use & 2 ? [{ slot: 2 as const, conn: v.conn2, color: v.color2 }] : []),
];
const viewNames = (v: LineView): string => viewSlots(v).map(sv => sv.conn.name).join(' + ');
/** Satırın o boyda attığı bağlayıcı adedi (1+2 seçili noktada iki tane). */
const viewCount = (v: LineView, length: number): number => linePoints(v.line, length).reduce((n, p) => n + viewSlots(v, p.use).length, 0);
type EdgeGeom = { role: PanelEdgeDir; x1: number; y1: number; x2: number; y2: number; nx: number; ny: number; length: number; fromStart: boolean };
/** PANELİN ÜSTTEN GÖRÜNÜŞÜ (geniş yüzüne dik bakış): dört kenar rolüyle etiketli; her kenarda atanmış dizilimin o boyda geçerli satırları
 *  gerçek delik iziyle (yüz deliği = halka, uç deliği = kenardan içeri çizgi), her bağlayıcı kendi renginde. Kenara tık → o kenar seçilir. */
function PanelFaceView({ type, plane, size, cur, rowsOf, onEdge }: {
  type: PanelTypeId; plane: Exclude<PanelPlane, 'any'>; size: [number, number]; cur: PanelEdgeDir | null; rowsOf: (e: PanelEdgeDir) => LineView[] | null; onEdge: (e: PanelEdgeDir) => void;
}) {
  const [hover, setHover] = useState<PanelEdgeDir | null>(null);
  const VW = 480, VH = 232, [mw, mh] = size;
  const k = Math.min(300 / mw, 136 / mh), w = Math.max(mw * k, 16), h = Math.max(mh * k, 16), x0 = (VW - w) / 2, y0 = (VH - h) / 2 + 4;
  const [eTop, eBottom, eLeft, eRight] = PLANE_EDGES[plane], ends = EDGE_ENDS[plane];
  // Dizilimin başlangıç ucu şemada nerede: yatay kenarda sol mu, düşey kenarda alt mı.
  const edges: EdgeGeom[] = [
    { role: eTop, x1: x0, y1: y0, x2: x0 + w, y2: y0, nx: 0, ny: -1, length: mw, fromStart: ends[eTop]?.[0] === eLeft },
    { role: eBottom, x1: x0, y1: y0 + h, x2: x0 + w, y2: y0 + h, nx: 0, ny: 1, length: mw, fromStart: ends[eBottom]?.[0] === eLeft },
    { role: eLeft, x1: x0, y1: y0 + h, x2: x0, y2: y0, nx: -1, ny: 0, length: mh, fromStart: ends[eLeft]?.[0] === eBottom },
    { role: eRight, x1: x0 + w, y1: y0 + h, x2: x0 + w, y2: y0, nx: 1, ny: 0, length: mh, fromStart: ends[eRight]?.[0] === eBottom },
  ];
  return (
    <svg viewBox={`0 0 ${VW} ${VH}`} className="block w-full select-none" style={{ fontFamily: UI_FONT }}>
      <rect x={x0} y={y0} width={w} height={h} rx={1.5} fill={PT.fill} stroke={PT.stroke} strokeWidth={1.2} />
      {w > 120 && h > 46 && (
        <>
          <text x={VW / 2} y={y0 + h / 2 + 1} textAnchor="middle" fontSize={12} fontWeight={600} fill={PT.ink}>{panelTypeShort(type)}</text>
          <text x={VW / 2} y={y0 + h / 2 + 14} textAnchor="middle" fontSize={9} fontWeight={500} fill={PT.mute} style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt1(mw)} × {fmt1(mh)} mm</text>
        </>
      )}
      <text x={8} y={14} fontSize={8} fontWeight={600} fill={PT.mute} style={{ letterSpacing: '0.09em' }}>{PLANE_LABEL[plane].toUpperCase()} OF THE PANEL</text>
      {edges.map(e => {
        const all = rowsOf(e.role), has = !!all, on = cur === e.role, hv = hover === e.role;
        const rows = (all ?? []).filter(r => viewSlots(r).length > 0 && lineApplies(r.line, e.length)), dots = [...new Set((all ?? []).flatMap(r => viewSlots(r).map(sv => sv.color)))];
        const ux = (e.x2 - e.x1) / e.length, uy = (e.y2 - e.y1) / e.length, el = Math.hypot(e.x2 - e.x1, e.y2 - e.y1) || 1, tx = (e.x2 - e.x1) / el, ty = (e.y2 - e.y1) / el;
        const at = (d: number, inward = 0) => { const t = e.fromStart ? d : e.length - d; return { x: e.x1 + ux * t - e.nx * inward * k, y: e.y1 + uy * t - e.ny * inward * k }; };
        const mx = (e.x1 + e.x2) / 2, my = (e.y1 + e.y2) / 2;
        const label = EDGE_LABEL[e.role].toUpperCase(), lw = label.length * 5.6 + (dots.length ? 24 + dots.length * 5.5 : 16);
        const lx = mx + e.nx * (lw / 2 + 12), ly = my + e.ny * 21;
        return (
          <g key={e.role} onClick={ev => { stop(ev); onEdge(e.role); }} onMouseEnter={() => setHover(e.role)} onMouseLeave={() => setHover(null)} style={{ cursor: 'pointer' }}>
            <title>{`${EDGE_LABEL[e.role]} edge — ${has ? `${[...new Set((all ?? []).flatMap(r => viewSlots(r).map(sv => sv.conn.name)))].join(' + ') || 'layout without a connector'} · click to ${on ? 'close' : 'open'}` : 'click to choose a connector layout for this edge'}`}</title>
            <line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke="transparent" strokeWidth={24} />
            {(on || has || hv) && <line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke={on ? PT.dark : has ? '#b5a998' : '#7d756b'} strokeWidth={on ? 3.2 : 2}
              strokeLinecap="round" strokeDasharray={on || has ? undefined : '4 3'} />}
            {rows.map((r, ri) => linePoints(r.line, e.length).map(({ d, use }, i) => {
              const slots = viewSlots(r, use), p = at(d);
              return (
                <g key={`${ri}-${i}`}>
                  {slots.map(sv => (
                    <g key={sv.slot}>
                      {sv.conn.holes.filter(hh => hh.surface === 'bEdge').map(hh => {
                        const a = at(d + hh.along), b = at(d + hh.along, Math.min(hh.depth, 60));
                        return <line key={hh.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={sv.color} strokeWidth={Math.max(1.2, hh.diameter * k * 0.5)} strokeOpacity={0.45} />;
                      })}
                      {sv.conn.holes.filter(hh => hh.surface === 'bFace').map(hh => {
                        const c = at(d + hh.along, hh.across);
                        return <circle key={hh.id} cx={c.x} cy={c.y} r={Math.max(1.8, (hh.diameter / 2) * k)} fill="#fff" stroke={sv.color} strokeWidth={1.3} />;
                      })}
                    </g>
                  ))}
                  {/* 1+2 noktasında iki renk yan yana */}
                  {slots.map((sv, si) => { const o = slots.length > 1 ? (si ? 2 : -2) : 0;
                    return <circle key={`d${sv.slot}`} cx={p.x + tx * o} cy={p.y + ty * o} r={2.3} fill={sv.color} stroke="#fff" strokeWidth={0.8} />; })}
                </g>
              );
            }))}
            <rect x={lx - lw / 2} y={ly - 9} width={lw} height={18} rx={9} fill={on ? PT.dark : hv ? '#ece7e0' : '#fff'} stroke={on ? PT.dark : has ? '#cfc7bc' : '#e3ddd4'} strokeWidth={0.9}
              style={{ transition: 'fill 0.12s' }} />
            <text x={lx - (dots.length ? 4 + dots.length * 2.75 : 0)} y={ly + 3.2} textAnchor="middle" fontSize={8.6} fontWeight={700} fill={on ? '#fff' : PT.ink} style={{ letterSpacing: '0.07em' }}>{label}</text>
            {/* kenardaki bağlayıcıların renk noktaları */}
            {dots.map((c, i) => <circle key={i} cx={lx + lw / 2 - 9 - (dots.length - 1 - i) * 5.5} cy={ly} r={2.6} fill={c} stroke={on ? PT.dark : '#fff'} strokeWidth={0.8} />)}
          </g>
        );
      })}
    </svg>
  );
}

// ───────── 3. Dizilim: önizleme şeridi · boy aralığı haritası · kural kartları ─────────
const Unit = () => <span className="yago-unit shrink-0 pr-1">mm</span>;
const LEN_MIN = 40, LEN_MAX = 2400;
/** Sayı kutusu: boş = `placeholder` (ör. "fit" = sığdığı kadar, "any" = sınırsız) → 0 olarak kaydedilir. */
function BlankNum({ value, onCommit, title, placeholder, limit = 9999, w = 30 }: { value: number; onCommit: (n: number) => void; title: string; placeholder: string; limit?: number; w?: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => { if (draft == null) return; const n = parseFloat(draft.replace(',', '.')); setDraft(null); onCommit(Number.isFinite(n) && n > 0 ? Math.min(limit, round1(n)) : 0); };
  return (
    <input type="text" inputMode="numeric" value={draft ?? (value > 0 ? String(value) : '')} placeholder={placeholder} title={title} onClick={stop}
      onChange={e => setDraft(e.target.value)} onBlur={commit} onFocus={e => e.target.select()}
      onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setDraft(null); }}
      className="yago-field placeholder:text-stone-400 placeholder:font-medium" style={{ ...FIELD_INPUT, width: w, flexShrink: 0, textAlign: 'right' }} />
  );
}
type BandRow = LineView;
const BAND = { VW: 480, VH: 140, X0: 24, X1: 456, yA: 22, hA: 13, hB: 54, ky: 0.82 } as const;
/** KENAR ŞERİDİ — birleşime üstten bakış: üstte dayandığı panel (taralı), altında bu panelin kenar bandı; o boyda geçerli her satır kendi
 *  bağlayıcısının renginde, gerçek delik iziyle (iki bağlayıcılı kuralda her nokta kendi bağlayıcısının renginde; etkin satırda noktanın
 *  altında 1 / 2 rozeti). Etkin satırın ölçü zinciri altta (baştaki ve sondaki ölçünün altında "fixed" / "min …").
 *  `onDrag` verilirse tutamaklar SÜRÜKLENİR: ilk / son bağlayıcı (baş mesafesi · son mesafesi ya da EN AZ mesafe), listede her nokta.
 *  '32 grid'de ızgara çentikleri; 'grid' / 'steps'te sondaki EN AZ mesafe bölgesi taralı (delik oraya giremez). */
function LayoutBand({ length, ends, rows, active, onPick, onDrag }: {
  length: number; ends: [string, string]; rows: BandRow[]; active: number; onPick?: (i: number) => void; onDrag?: (lineId: string, patch: Partial<LayoutLine>) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<string | null>(null);
  const [grab, setGrab] = useState(false);
  const { VW, VH, X0, X1, yA, hA, hB, ky } = BAND, yJ = yA + hA, kx = (X1 - X0) / Math.max(1, length), xOf = (d: number) => X0 + d * kx;
  const pts = rows.map(r => linePoints(r.line, length)), pos = pts.map(list => list.map(p => p.d));
  const act = rows[active], actPts = pts[active] ?? [], actPos = pos[active] ?? [], L = act?.line;
  // Farklı satırların üst üste gelen noktaları (≤ 9 mm): kırmızı halka.
  const clash = pos.flatMap((list, i) => list.filter(d => pos.some((o, j) => j !== i && o.some(x => Math.abs(x - d) < 9))));
  const clampI = (v: number, hi: number) => Math.round(Math.min(Math.max(0, hi), Math.max(0, v)));
  /** Noktanın rengi: yalnız 2. bağlayıcıya ayrılmışsa onun rengi, değilse satırın (1. bağlayıcının) rengi. */
  const colorAt = (d: number): string => (act && actPts.find(p => Math.abs(p.d - d) < 0.06)?.use === 2 ? act.color2 : act?.color ?? NO_CONN_COLOR);
  const handles: Array<{ key: string; d: number; title: string; apply: (mm: number) => Partial<LayoutLine> }> = !L || !onDrag ? []
    : L.kind === 'list'
      ? L.points.map((p, i) => ({
        key: `p${i}`, d: p.from === 'end' ? length - p.d : p.d, title: `Drag to move connector ${i + 1} (measured from the ${p.from === 'end' ? ends[1] : ends[0]})`,
        apply: (mm: number) => ({ points: L.points.map((q, k) => (k === i ? { ...q, d: clampI(q.from === 'end' ? length - mm : mm, length) } : q)) }),
      })).filter(hd => hd.d >= 0 && hd.d <= length)
      : actPos.length ? [
        { key: 'start', d: actPos[0], title: `Drag to change the distance from the ${ends[0]}`, apply: (mm: number) => ({ start: clampI(mm, length - L.end - 1) }) },
        ...(actPos.length >= 2 ? [{ key: 'end', d: actPos[actPos.length - 1], title: `Drag to change the ${L.kind === 'ends' ? 'distance' : 'minimum distance'} from the ${ends[1]}`,
          apply: (mm: number) => ({ end: clampI(length - mm, length - L.start - 1) }) }] : []),
      ] : [];
  const mmAt = (e: React.PointerEvent) => { const r = svg.current!.getBoundingClientRect(); return (((e.clientX - r.left) / r.width) * VW - X0) / kx; };
  const move = (e: React.PointerEvent) => { const hd = handles.find(x => x.key === drag.current); if (hd && L && onDrag) onDrag(L.id, hd.apply(mmAt(e))); };
  const drop = (e: React.PointerEvent) => { if (!drag.current) return; (e.target as Element).releasePointerCapture?.(e.pointerId); drag.current = null; setGrab(false); };
  const chain = act ? [0, ...actPos, length] : [];
  const mid = L && (L.kind === 'ends' || L.kind === 'grid') ? { on: actPos.length === 3, from: L.midFrom } : null;
  const minZone = L && (L.kind === 'grid' || L.kind === 'steps') && actPos.length ? Math.min(Math.max(0, L.end), length) : 0;
  const pitch = L?.kind === 'grid' ? (L.pitch > 0 ? L.pitch : 32) : 0;
  const ticks = L && pitch && actPos.length && pitch * kx >= 3 ? Array.from({ length: Math.floor((length - L.start) / pitch + 1e-6) + 1 }, (_, i) => L.start + i * pitch) : [];
  const total = rows.reduce((n, r) => n + viewCount(r, length), 0), rear = actPos.length ? length - actPos[actPos.length - 1] : 0;
  // Etkin satırın adetleri, bağlayıcı başına ("2 × Minifix + 1 × Dowel").
  const actText = act ? viewSlots(act).map(sv => `${actPts.filter(p => p.use & sv.slot).length} × ${sv.conn.name}`).join(' + ') || `${actPos.length} × connector` : '';
  const note = !rows.length ? 'no rule applies to this joint length'
    : clash.length ? 'two connectors overlap'
      : !act ? `${total} connector${total === 1 ? '' : 's'} · ${rows.length} rule${rows.length === 1 ? '' : 's'} at this length`
        : `${actText}${minZone ? ` · ${fmt1(rear)} from ${ends[1]} (min ${fmt1(L!.end)})` : ''}${mid ? (mid.on ? ' · middle added' : mid.from > 0 ? ` · middle from ${fmt1(mid.from)} mm` : '') : ''}`;
  const yC = yJ + hB + 16;
  const cap = (i: number): string => (!L || L.kind === 'list' ? '' : i === 0 ? 'fixed' : L.kind === 'ends' ? 'fixed' : `min ${fmt1(L.end)}`);
  return (
    <svg ref={svg} viewBox={`0 0 ${VW} ${VH}`} className="block w-full select-none" style={{ fontFamily: UI_FONT, touchAction: 'none', cursor: grab ? 'grabbing' : undefined }}
      onPointerMove={move} onPointerUp={drop} onPointerCancel={drop}>
      <defs>
        <linearGradient id="yago-band-fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0.55" stopColor={PT.fill} /><stop offset="1" stopColor={PT.fill} stopOpacity={0} /></linearGradient>
        <pattern id="yago-band-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" stroke="#cfc6b8" strokeWidth="1.1" /></pattern>
        <pattern id="yago-band-keepout" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><line x1="0" y1="0" x2="0" y2="4" stroke="#b5a998" strokeWidth="0.9" /></pattern>
      </defs>
      <text x={X0} y={12} fontSize={8.4} fontWeight={700} fill={PT.ink} style={{ letterSpacing: '0.08em' }}>{ends[0].toUpperCase()}</text>
      <text x={X1} y={12} textAnchor="end" fontSize={8.4} fontWeight={700} fill={PT.ink} style={{ letterSpacing: '0.08em' }}>{ends[1].toUpperCase()}</text>
      <text x={(X0 + X1) / 2} y={12} textAnchor="middle" fontSize={8.4} fontWeight={clash.length ? 700 : 600} style={{ fontVariantNumeric: 'tabular-nums' }}
        fill={clash.length ? '#dc2626' : act ? act.color : PT.mute}>{note}</text>
      {/* dayandığı panel (taralı) + bu panelin kenar bandı */}
      <rect x={X0 - 10} y={yA} width={X1 - X0 + 20} height={hA} fill="#f4efe6" /><rect x={X0 - 10} y={yA} width={X1 - X0 + 20} height={hA} fill="url(#yago-band-hatch)" />
      <rect x={X0} y={yJ} width={X1 - X0} height={hB} fill="url(#yago-band-fade)" />
      {minZone > 0 && (
        <g>
          <rect x={xOf(length - minZone)} y={yJ} width={minZone * kx} height={hB - 22} fill="url(#yago-band-keepout)" opacity={0.7} />
          <line x1={xOf(length - minZone)} y1={yJ} x2={xOf(length - minZone)} y2={yJ + hB - 22} stroke="#8a8073" strokeWidth={0.9} strokeDasharray="2.5 2" />
        </g>
      )}
      {ticks.map((d, i) => <line key={`t${i}`} x1={xOf(d)} y1={yJ} x2={xOf(d)} y2={yJ + 3.5} stroke="#a89f92" strokeWidth={0.7} />)}
      <path d={`M${X0} ${yJ + hB - 6}V${yJ}H${X1}V${yJ + hB - 6}`} fill="none" stroke={PT.stroke} strokeWidth={1.2} />
      {rows.map((r, ri) => {
        const on = ri === active || active < 0;
        return (
          <g key={r.line.id} opacity={on ? 1 : 0.45} onClick={e => { stop(e); onPick?.(ri); }} style={{ cursor: !onPick || ri === active ? undefined : 'pointer' }}>
            {pts[ri].map(({ d, use }, i) => {
              // Noktaya gelen bağlayıcı(lar): her biri kendi renginde; bağlayıcısı seçilmemiş yuvaya ayrılan nokta boş halka.
              const slots = viewSlots(r, use);
              const scale = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v * ky));
              return (
                <g key={i}>
                  {slots.map(sv => (
                    <g key={sv.slot}>
                      {sv.conn.holes.filter(h => h.surface === 'aFace').map(h => { const wv = scale(h.diameter, 1.6, 8), dv = Math.min(h.depth * ky, hA - 2);
                        return <rect key={h.id} x={xOf(d + h.along) - wv / 2} y={yJ - dv} width={wv} height={dv} fill={sv.color} fillOpacity={0.55} />; })}
                      {sv.conn.holes.filter(h => h.surface === 'bEdge').map(h => { const wv = scale(h.diameter, 1.6, 8), dv = Math.min(h.depth * ky, hB - 10);
                        return <rect key={h.id} x={xOf(d + h.along) - wv / 2} y={yJ} width={wv} height={dv} fill={sv.color} fillOpacity={0.16} stroke={sv.color} strokeWidth={0.8} strokeDasharray="2.5 1.8" />; })}
                      {sv.conn.holes.filter(h => h.surface === 'bFace').map(h => { const rr = scale(h.diameter / 2, 2.2, 9.5);
                        return <circle key={h.id} cx={xOf(d + h.along)} cy={yJ + Math.max(rr + 1.5, Math.min(hB - rr - 8, h.across * ky))} r={rr} fill="#fff" stroke={sv.color} strokeWidth={ri === active ? 1.6 : 1.2} />; })}
                    </g>
                  ))}
                  {slots.length > 0 && !slots.some(sv => sv.conn.holes.length) && <path d={`M${xOf(d)} ${yJ + 5}l5 6l-5 6l-5 -6z`} fill="#fff" stroke={slots[0].color} strokeWidth={1.3} />}
                  {!slots.length && <circle cx={xOf(d)} cy={yJ} r={2.8} fill="#fff" stroke={NO_CONN_COLOR} strokeWidth={1.1} strokeDasharray="1.6 1.4" />}
                  {slots.map((sv, si) => <circle key={`d${sv.slot}`} cx={xOf(d) + (slots.length > 1 ? (si ? 2.4 : -2.4) : 0)} cy={yJ} r={2.6} fill={sv.color} stroke="#fff" strokeWidth={0.9} />)}
                </g>
              );
            })}
          </g>
        );
      })}
      {clash.map((d, i) => <circle key={`c${i}`} cx={xOf(d)} cy={yJ} r={8} fill="none" stroke="#dc2626" strokeWidth={1.3} strokeDasharray="3 2" />)}
      {/* orta bağlayıcı henüz yok → geleceği yer */}
      {mid && !mid.on && mid.from > 0 && actPos.length === 2 && <circle cx={(xOf(actPos[0]) + xOf(actPos[1])) / 2} cy={yJ} r={5} fill="none" stroke={act!.color} strokeWidth={1.1} strokeDasharray="2.4 2" opacity={0.75} />}
      {/* etkin satırın ölçü zinciri */}
      {act && chain.slice(0, -1).map((a, i) => {
        const b = chain[i + 1], xa = xOf(a), xb = xOf(b), edge = i === 0 || i === chain.length - 2, wide = xb - xa >= 24, c = edge ? cap(i) : '';
        if (b - a < 0.05) return null;
        return (
          <g key={`d${i}`}>
            <line x1={xa} y1={yC} x2={xb} y2={yC} stroke={edge ? act.color : '#b5ada2'} strokeWidth={edge ? 1.3 : 0.9} />
            <line x1={xa} y1={yJ + (i === 0 ? 0 : 3)} x2={xa} y2={yC + 4} stroke="#cfc7bc" strokeWidth={0.8} /><line x1={xb} y1={yJ + (i === chain.length - 2 ? 0 : 3)} x2={xb} y2={yC + 4} stroke="#cfc7bc" strokeWidth={0.8} />
            {wide && <text x={(xa + xb) / 2} y={yC + 12} textAnchor="middle" fontSize={9.4} fontWeight={edge ? 700 : 500} fill={edge ? act.color : '#8a8378'} style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt1(b - a)}</text>}
            {c && <text x={i === 0 ? Math.max(X0 - 8, (xa + xb) / 2 - 14) : Math.min(X1 + 8, (xa + xb) / 2 + 14)} y={yC + 22} textAnchor={i === 0 ? 'start' : 'end'} fontSize={7.6} fontWeight={600} fill={PT.mute}
              style={{ letterSpacing: '0.05em' }}>{c.toUpperCase()}</text>}
          </g>
        );
      })}
      {/* iki bağlayıcılı etkin satır: her noktanın altında hangi bağlayıcı(lar) — 1 · 2 · 1 + 2 */}
      {act?.two && actPts.map((p, i) => {
        const ks = ([1, 2] as const).filter(k => p.use & k);
        return ks.map((k, ki) => (
          <g key={`u${i}-${k}`} transform={`translate(${xOf(p.d) + (ks.length > 1 ? (ki ? 5.2 : -5.2) : 0)} ${yJ + hB + 3})`}>
            <circle r={4.9} fill={k === 1 ? act.color : act.color2} stroke="#fff" strokeWidth={1} />
            <text y={2.6} textAnchor="middle" fontSize={7.2} fontWeight={700} fill="#fff">{k}</text>
          </g>
        ));
      })}
      {handles.map(hd => (
        <g key={hd.key} style={{ cursor: grab ? 'grabbing' : 'ew-resize' }}
          onPointerDown={e => { stop(e); e.preventDefault(); (e.currentTarget as Element).setPointerCapture(e.pointerId); drag.current = hd.key; setGrab(true); }}>
          <title>{hd.title}</title>
          <rect x={xOf(hd.d) - 9} y={yA - 4} width={18} height={hA + hB + 6} fill="transparent" />
          <path d={`M${xOf(hd.d) - 6} ${yJ - 15}h12v8l-6 7l-6 -7z`} fill={colorAt(hd.d)} stroke="#fff" strokeWidth={1} />
          <path d={`M${xOf(hd.d) - 2.2} ${yJ - 12.5}v4M${xOf(hd.d) + 2.2} ${yJ - 12.5}v4`} stroke="#fff" strokeWidth={1} strokeLinecap="round" />
        </g>
      ))}
    </svg>
  );
}
/** Önizleme boyu: kaydırıcı + kutu. Yalnız önizleme — gerçek panelde dizilim panelin kendi birleşim boyuna uygulanır.
 *  `marks` = boy aralığı sınırları (kaydırıcının altında çentik: nerede kural değişiyor). */
function LengthSlider({ value, onChange, marks = [] }: { value: number; onChange: (v: number) => void; marks?: number[] }) {
  return (
    <div className="flex items-center gap-2 h-[26px] pl-1" onClick={stop}
      title="Preview only: slide to see how the connectors spread on a shorter or longer joint. Real panels use their own joint length.">
      <span className="yago-label shrink-0">Joint length</span>
      <div className="relative flex-1 min-w-0 h-[14px] flex items-center">
        <input type="range" min={LEN_MIN} max={LEN_MAX} step={10} value={Math.min(LEN_MAX, Math.max(LEN_MIN, value))} onChange={e => onChange(Number(e.target.value))}
          className="w-full min-w-0 h-[14px] cursor-pointer" style={{ accentColor: SEL }} />
        {[...new Set(marks)].filter(m => m > LEN_MIN && m < LEN_MAX).map(m => (
          <span key={m} title={`A length rule starts / ends at ${fmt1(m)} mm`} className="pointer-events-none absolute top-[11px] w-[2px] h-[5px] rounded-full bg-stone-500"
            style={{ left: `calc(7px + (100% - 14px) * ${(m - LEN_MIN) / (LEN_MAX - LEN_MIN)} - 1px)` }} />
        ))}
      </div>
      <div className="yago-cell shrink-0 h-[24px] pl-1 pr-0.5 flex items-center"><QbNum value={value} min={1} max={6000} w={40} onCommit={onChange} /><Unit /></div>
    </div>
  );
}
const setMarks = (set: ConnectorLayoutSet | undefined | null): number[] => (set?.lines ?? []).flatMap(l => [l.min, l.max]).filter(v => v > 0);
/** BOY ARALIĞI HARİTASI — hangi kural hangi birleşim boyunda geçerli, tek bakışta: her satır bir çubuk (bağlayıcının renginde, `min`'den
 *  `max`'a; üst sınırsız çubuk sağa açık biter; iki bağlayıcılı kuralda çubuğun alt şeridi 2. bağlayıcının renginde). Dikey imleç = önizleme boyu: haritaya tık / sürükle boyu değiştirir, çubuğa tık o kuralı
 *  da açar. Eksen karekök ölçekli: kısa boylar (40 – 100 mm) da okunur genişlikte. */
function LayoutRangeMap({ rows, length, onLength, activeId, onPick }: {
  rows: LineView[]; length: number; onLength: (v: number) => void; activeId: string | null; onPick: (id: string) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef(false);
  const VW = 480, X0 = 14, X1 = 466, RH = 16, top = 20, H = top + Math.max(1, rows.length) * RH + 20;
  const Lmax = Math.max(LEN_MAX, Math.ceil((Math.max(0, ...rows.flatMap(r => [r.line.min, r.line.max])) * 1.15) / 100) * 100, Math.ceil(length / 100) * 100);
  const xOf = (v: number) => X0 + (X1 - X0) * Math.sqrt(Math.max(0, Math.min(v, Lmax)) / Lmax);
  const lenAt = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect(), t = Math.max(0, Math.min(1, (((e.clientX - r.left) / r.width) * VW - X0) / (X1 - X0)));
    const v = Lmax * t * t, step = v < 200 ? 1 : v < 1000 ? 5 : 10;
    return Math.max(1, Math.round(v / step) * step);
  };
  const xc = xOf(length), yB = top + Math.max(1, rows.length) * RH + 2;
  return (
    <svg ref={svg} viewBox={`0 0 ${VW} ${H}`} className="block w-full select-none" style={{ fontFamily: UI_FONT, touchAction: 'none', cursor: 'ew-resize' }}
      onPointerDown={e => { stop(e); try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* yakalanamayan işaretçi: sürükleme yine çalışır */ } drag.current = true; onLength(lenAt(e)); }}
      onPointerMove={e => { if (drag.current) onLength(lenAt(e)); }} onPointerUp={e => { drag.current = false; (e.currentTarget as Element).releasePointerCapture?.(e.pointerId); }}
      onPointerCancel={() => { drag.current = false; }}>
      <title>Which rule applies to which joint length — click or drag to change the previewed length; click a bar to open that rule</title>
      {[0, 100, 250, 500, 1000, 1500, 2000, 3000, 4000, 6000].filter(t => t <= Lmax).map(t => (
        <g key={t}>
          <line x1={xOf(t)} y1={top - 2} x2={xOf(t)} y2={yB + 3} stroke="#e3ddd4" strokeWidth={0.8} />
          <text x={xOf(t)} y={yB + 13} textAnchor="middle" fontSize={7.8} fontWeight={500} fill={PT.mute} style={{ fontVariantNumeric: 'tabular-nums' }}>{t}</text>
        </g>
      ))}
      {!rows.length && <text x={(X0 + X1) / 2} y={top + RH / 2 + 3} textAnchor="middle" fontSize={8.6} fill={PT.mute}>no rules yet</text>}
      {rows.map((r, i) => {
        const y = top + i * RH + 2, hh = RH - 5, xa = xOf(r.line.min || 0), open = !(r.line.max > 0), xb = Math.max(xa + 4, open ? X1 : xOf(r.line.max));
        const on = r.line.id === activeId, hit = lineApplies(r.line, length);
        const text = `${viewNames(r) || 'no connector'} · ${layoutKindLabel(r.line.kind)}`, tw = text.length * 4.5 + 8;
        const inside = xb - xa > tw + 4, right = !inside && xb + tw < X1;
        return (
          <g key={r.line.id} onPointerDown={() => onPick(r.line.id)} style={{ cursor: 'pointer' }}>
            <rect x={X0} y={y - 2} width={X1 - X0} height={RH - 1} fill={on ? '#f3ede4' : 'transparent'} rx={3} />
            <path d={open ? `M${xa} ${y}H${xb - 5}l5 ${hh / 2}l-5 ${hh / 2}H${xa}Z` : `M${xa} ${y}H${xb}V${y + hh}H${xa}Z`} fill={r.color} fillOpacity={hit ? 0.92 : 0.3}
              stroke={on ? PT.dark : 'none'} strokeWidth={1.1} strokeLinejoin="round" />
            {r.conn2 && <rect x={xa + 0.6} y={y + hh - 3.6} width={Math.max(2, (open ? xb - 5 : xb) - xa - 1.2)} height={3} fill={r.color2} fillOpacity={hit ? 1 : 0.4} style={{ pointerEvents: 'none' }} />}
            <text x={inside ? xa + 5 : right ? xb + 5 : xa - 5} y={y + hh / 2 + 3} textAnchor={inside || right ? 'start' : 'end'} fontSize={8.2} fontWeight={600}
              fill={inside ? (hit ? '#fff' : PT.ink) : PT.ink} style={{ pointerEvents: 'none' }}>{text}</text>
          </g>
        );
      })}
      {/* önizleme boyu */}
      <line x1={xc} y1={top - 4} x2={xc} y2={yB + 3} stroke={PT.dark} strokeWidth={1.2} />
      <g transform={`translate(${Math.max(X0 + 16, Math.min(X1 - 16, xc))} ${top - 8})`}>
        <rect x={-17} y={-9} width={34} height={13} rx={6.5} fill={PT.dark} />
        <text x={0} y={0.6} textAnchor="middle" fontSize={8.2} fontWeight={700} fill="#fff" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt1(length)}</text>
      </g>
    </svg>
  );
}
/** Kuralın küçük resmi (seçim kartında): birleşim şeridi + o kurala özgü işaretler. */
function KindGlyph({ kind, on }: { kind: LayoutKind; on: boolean }) {
  const c = on ? SEL : '#8a8073', soft = on ? '#f5b48a' : '#cfc7bc', y = 15, x0 = 6, x1 = 98;
  const dot = (x: number, hollow = false) => <circle key={`o${x}`} cx={x} cy={y} r={3.1} fill={hollow ? '#fff' : c} stroke={c} strokeWidth={1.2} strokeDasharray={hollow ? '2 1.5' : undefined} />;
  const dim = (xa: number, xb: number, yy: number, key: string) => <path key={key} d={`M${xa} ${yy - 2.5}v5M${xb} ${yy - 2.5}v5M${xa} ${yy}H${xb}`} stroke={c} strokeWidth={1} fill="none" />;
  const hatch = (xa: number) => <g key="h">{[0, 3, 6, 9].map(i => <line key={i} x1={xa + i} y1={y + 2} x2={xa + i + 4} y2={y + 9} stroke={soft} strokeWidth={1} />)}</g>;
  return (
    <svg viewBox="0 0 104 36" className="block w-full" style={{ height: 34 }}>
      <rect x={x0} y={y} width={x1 - x0} height={12} fill={on ? '#fff4ec' : '#f4efe6'} />
      <path d={`M${x0} ${y + 12}V${y}H${x1}V${y + 12}`} fill="none" stroke={soft} strokeWidth={1.1} />
      {kind === 'ends' && [dim(x0, 18, 32, 'a'), dim(86, x1, 32, 'b'), dot(18), dot(52, true), dot(86)]}
      {kind === 'grid' && [
        <g key="t">{Array.from({ length: 12 }, (_, i) => <line key={i} x1={16 + i * 6.4} y1={y} x2={16 + i * 6.4} y2={y + 4} stroke={soft} strokeWidth={1} />)}</g>,
        hatch(x1 - 13), dim(x0, 16, 32, 'a'), dot(16), dot(54.4, true), dot(80),
        <text key="n" x={50} y={9} textAnchor="middle" fontSize={7.4} fontWeight={700} fill={c}>× 32</text>,
      ]}
      {kind === 'steps' && [
        hatch(x1 - 13),
        ...[[16, 40], [40, 60], [60, 76]].map(([a, b], i) => <g key={`s${i}`}>
          <path d={`M${a} ${y - 4}Q${(a + b) / 2} ${y - 14} ${b} ${y - 4}`} fill="none" stroke={c} strokeWidth={1} />
          <text x={(a + b) / 2} y={y - 9.5} textAnchor="middle" fontSize={6.6} fontWeight={700} fill={c}>{i + 1}</text>
        </g>),
        dot(16), dot(40), dot(60), dot(76),
      ]}
      {kind === 'list' && [
        <path key="a" d={`M${x0} 30H22M${x0} 34H44M${x1} 30H74`} stroke={c} strokeWidth={1} fill="none" />,
        <path key="b" d="M22 28v4M44 32v4M74 28v4" stroke={c} strokeWidth={1} fill="none" />,
        dot(22), dot(44), dot(74),
      ]}
    </svg>
  );
}
const KIND_HELP: Record<LayoutKind, string> = {
  ends: 'One connector at a fixed distance from the front, one at a fixed distance from the rear. Once the joint reaches the “Middle ≥” length, a third one goes exactly in the middle.',
  grid: 'The first connector sits exactly at the front distance; the others land on the 32 mm grid counted from it. The rear value is a minimum: the last connector takes the grid hole nearest the rear that still keeps it, and whatever is left over stays at the rear. Once the joint reaches “Middle ≥”, one more goes on the grid hole nearest the middle.',
  steps: 'Walks from the front: the first connector at the front distance, then step 1, step 2, step 3 … one after another, each putting a connector. The rear value is a minimum — a step that would come closer to the rear is skipped.',
  list: 'Every connector is typed in: its distance and whether it is measured from the front or from the rear. Nothing is calculated — best for short joints with fixed positions.',
};
/** Dört kural, resimli kart olarak (seçili = turuncu çerçeve + onay). */
function LayoutKindCards({ value, onPick }: { value: LayoutKind; onPick: (k: LayoutKind) => void }) {
  return (
    <div className="grid grid-cols-4 gap-1" onClick={stop}>
      {LAYOUT_KINDS.map(k => {
        const on = k.key === value;
        return (
          <button key={k.key} type="button" title={KIND_HELP[k.key]} onClick={() => onPick(k.key)}
            className={`relative rounded-[8px] px-1 pt-1 pb-[5px] flex flex-col items-stretch gap-[2px] transition-all duration-150
              ${on ? 'bg-white ring-[1.5px] ring-orange-500' : 'bg-white ring-1 ring-[#e3ddd4] hover:ring-[#bfb7ab] hover:bg-[#faf8f5]'}`}>
            <KindGlyph kind={k.key} on={on} />
            <span className={`text-[11px] font-semibold leading-none text-center ${on ? 'text-orange-700' : 'text-stone-700'}`}>{k.label}</span>
            {on && <span className="absolute -top-[5px] -right-[5px] w-[14px] h-[14px] rounded-full bg-orange-500 text-white flex items-center justify-center ring-2 ring-white"><Check size={9} strokeWidth={3.2} /></span>}
          </button>
        );
      })}
    </div>
  );
}
const SMALL_SELECT = 'h-[22px] pl-1 pr-5 rounded-[5px] bg-transparent text-[12px] font-semibold text-stone-800 appearance-none outline-none cursor-pointer hover:bg-[#f6f3ee] transition-colors duration-150 max-w-full truncate';
const POINT_SEG: SegItem[] = [{ key: 'start', label: 'From front', title: 'Measured from the front (start) of the joint' }, { key: 'end', label: 'From rear', title: 'Measured from the rear (end) of the joint' }];
const USE_SLOTS: Array<{ k: 'start' | 'mid' | 'end'; label: string; what: string }> = [
  { k: 'start', label: 'Front', what: 'Connector at the front' }, { k: 'mid', label: 'Middle', what: 'Connector in the middle' }, { k: 'end', label: 'Rear', what: 'Connector at the rear' },
];
/** Kuralın nokta seçimleri (kuralın türüne göre: baş · orta · son / baş + adımlar / liste noktaları). */
const lineUses = (l: LayoutLine): ConnUse[] => (l.kind === 'list' ? l.points.map(p => p.c ?? 1)
  : l.kind === 'steps' ? [l.use?.start ?? 1, ...l.steps.map(st => st.c ?? 1)] : [l.use?.start ?? 1, l.use?.mid ?? 1, l.use?.end ?? 1]);
/** NOKTAYA GELEN BAĞLAYICI (iki bağlayıcılı kuralda): 1 · 2 · 1+2. Seçili düğme o bağlayıcının renginde, 1+2 iki renkli. */
function UsePick({ value, view, what, onPick }: { value: ConnUse | undefined; view: LineView; what: string; onPick: (u: ConnUse) => void }) {
  const cur = value ?? 1, n1 = view.conn?.name ?? 'connector 1 (not picked)', n2 = view.conn2?.name ?? 'connector 2 (not picked)';
  const opts: Array<{ u: ConnUse; label: string; bg: string; title: string }> = [
    { u: 1, label: '1', bg: view.color, title: `${what}: ${n1}` },
    { u: 2, label: '2', bg: view.color2, title: `${what}: ${n2}` },
    { u: 3, label: '1+2', bg: `linear-gradient(90deg, ${view.color} 50%, ${view.color2} 50%)`, title: `${what}: both — ${n1} and ${n2}` },
  ];
  return (
    <div className="shrink-0 flex items-center gap-[2px] p-[2px] rounded-[7px]" style={{ background: '#ece8e1' }} onClick={stop}>
      {opts.map(o => {
        const on = o.u === cur;
        return (
          <button key={o.u} type="button" title={o.title} aria-label={o.title} aria-pressed={on} onClick={e => { stop(e); onPick(o.u); }}
            className={`h-[20px] rounded-[5px] text-[10.5px] font-bold tabular-nums transition-colors duration-150 ${on ? 'text-white' : 'text-stone-600 hover:bg-white hover:text-stone-900'}`}
            style={{ minWidth: o.u === 3 ? 32 : 22, padding: '0 5px', background: on ? o.bg : undefined, fontFamily: UI_FONT }}>{o.label}</button>
        );
      })}
    </div>
  );
}
/** DİZİLİM SATIRI (kural): sıra · bağlayıcı (+ 2. bağlayıcı) · boy aralığı · özet · kopya · sil. Açıkken: boy aralığı → dört kural kartı → o
 *  kuralın değerleri; iki bağlayıcılı kuralda her noktanın yanında hangi bağlayıcının geleceği (1 · 2 · 1+2). */
function LayoutLineRow({ view, index, open, length, connectors, onOpen, onPatch, onCopy, onRemove }: {
  view: LineView; index: number; open: boolean; length: number; connectors: Connector[];
  onOpen: () => void; onPatch: (p: Partial<LayoutLine>) => void; onCopy: () => void; onRemove: () => void;
}) {
  const l = view.line, hit = lineApplies(l, length), n = hit ? viewCount(view, length) : 0;
  const others = connectors.filter(c => c.id !== l.connectorId), uses = lineUses(l);
  const mark = (k: 1 | 2, color: string) => (view.two
    ? <span className="shrink-0 w-[15px] h-[15px] rounded-full flex items-center justify-center text-[9.5px] font-bold text-white tabular-nums" style={{ background: color }}>{k}</span>
    : <span className="shrink-0 w-[10px] h-[10px] rounded-full ring-2 ring-white" style={{ background: color, boxShadow: `0 0 0 1px ${color}` }} />);
  const mm = (v: number, on: (v: number) => void, min = 0, w = 38) => <><QbNum value={v} min={min} w={w} onCommit={on} /><Unit /></>;
  const front = <EditCell label="From front" title="Exact distance of the first connector from the front (start) of the joint (mm)">{mm(l.start, v => onPatch({ start: v }))}</EditCell>;
  const rearMin = <EditCell label="Rear min" title="Smallest allowed distance of the last connector from the rear (end) of the joint (mm) — the real distance is this or a little more">{mm(l.end, v => onPatch({ end: v }))}</EditCell>;
  const middle = <EditCell label="Middle ≥" title="One more connector goes in the middle when the joint is at least this long (mm) · 0 = never">{mm(l.midFrom, v => onPatch({ midFrom: v }))}</EditCell>;
  return (
    <div className={rowCardClass(open, false, false)} style={{ opacity: hit || open ? 1 : 0.62 }}>
      <div onClick={e => { stop(e); onOpen(); }} className={`relative h-[32px] pl-2.5 pr-1 flex items-center gap-2 cursor-pointer transition-colors duration-150 hover:bg-[#faf8f5] ${open ? ROW_SEL_HEAD : ''}`}>
        {open && <span className={ROW_SEL_BAR} />}
        <span className="shrink-0 text-[10.5px] font-semibold tabular-nums text-stone-400">{index + 1}</span>
        {mark(1, view.color)}
        <div className="relative shrink min-w-0" onClick={stop} title={view.two ? 'Connector 1 of this rule' : 'Connector placed by this rule'}>
          <select aria-label="Connector 1" value={l.connectorId ?? ''} onChange={e => onPatch({ connectorId: e.target.value || null })} className={SMALL_SELECT} style={{ fontFamily: UI_FONT }}>
            {!view.conn && <option value="">Pick a connector</option>}
            {connectors.filter(c => !view.two || c.id !== l.connector2Id).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <ChevronDown size={11} strokeWidth={2.2} className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 text-stone-400" />
        </div>
        {view.two ? (
          <>
            {mark(2, view.color2)}
            <div className="relative shrink min-w-0" onClick={stop} title="Connector 2 of this rule — every point below chooses 1, 2 or both">
              <select aria-label="Connector 2" value={l.connector2Id ?? ''} className={SMALL_SELECT} style={{ fontFamily: UI_FONT }}
                onChange={e => onPatch(secondConnectorPatch(l, e.target.value || null))}>
                {!view.conn2 && <option value="">Pick a connector</option>}
                {others.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <ChevronDown size={11} strokeWidth={2.2} className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 text-stone-400" />
            </div>
            <button type="button" title="Remove the second connector — every point goes back to connector 1" aria-label="Remove the second connector"
              onClick={e => { stop(e); onPatch(secondConnectorPatch(l, undefined)); }}
              className="shrink-0 -ml-1.5 w-[16px] h-[16px] rounded-full flex items-center justify-center text-stone-400 hover:text-stone-900 hover:bg-[#ece7e0] transition-colors"><X size={10} strokeWidth={2.4} /></button>
          </>
        ) : (
          <button type="button" disabled={!others.length} onClick={e => { stop(e); onPatch(secondConnectorPatch(l, others[0]?.id ?? null)); if (!open) onOpen(); }}
            title={others.length ? 'Add a second connector to this rule — then choose for every point which connector goes there: 1, 2 or both'
              : 'A second connector needs another connector in the library — create one under Connect first'}
            className={`shrink-0 h-[20px] pl-1 pr-1.5 rounded-full text-[10px] font-semibold whitespace-nowrap flex items-center gap-[2px] border border-dashed transition-colors duration-150
              ${others.length ? 'border-[#cfc7bc] text-stone-500 hover:text-stone-900 hover:border-[#a89f92] hover:bg-white' : 'border-[#e3ddd4] text-stone-300 cursor-not-allowed'}`}>
            <Plus size={10} strokeWidth={2.4} />2nd
          </button>
        )}
        <span className={`shrink-0 h-[18px] px-1.5 rounded-full text-[10px] font-semibold tabular-nums flex items-center ${hit ? 'bg-[#292524] text-white' : 'bg-[#ece7e0] text-stone-500'}`}
          title={hit ? `Applies to the previewed joint (${fmt1(length)} mm)` : `Not used on the previewed joint (${fmt1(length)} mm)`}>{lineRangeText(l)}</span>
        <span className={`flex-1 min-w-0 truncate text-right ${MUTED}`} title="Rule · values">{layoutKindLabel(l.kind)} · {lineSummary(l)}{n ? ` · ${n} ×` : ''}</span>
        <button type="button" title="Duplicate this rule — e.g. to give another length range its own values" onClick={e => { stop(e); onCopy(); }} className={ICON_BTN}><Copy size={12} strokeWidth={1.9} /></button>
        <RowTrash title="Remove this rule" onClick={onRemove} />
      </div>
      {open && (
        <div className={`${CARD_BODY} flex flex-col gap-1.5`} style={CARD_BODY_STYLE} onClick={stop}>
          <div className="grid grid-cols-2 gap-x-1" style={QB_CELL_ROW}>
            <EditCell label="Joint from" title="This rule applies to joints at least this long (mm) · 0 = from the shortest">{mm(l.min, v => onPatch({ min: Math.round(v) }), 0, 44)}</EditCell>
            <EditCell label="Joint to" title="… and at most this long (mm) · empty = no upper limit">
              <BlankNum value={l.max} placeholder="any" w={44} limit={99999} onCommit={v => onPatch({ max: Math.round(v) })} title="Longest joint this rule applies to (mm) — empty = any length" /><Unit /></EditCell>
          </div>
          {l.max > 0 && l.max < l.min && <div className="text-[10.5px] font-medium text-red-600 px-1">“Joint to” is smaller than “Joint from” — this rule never applies.</div>}
          <LayoutKindCards value={l.kind} onPick={k => onPatch({ kind: k })} />
          <div className="yago-hint px-1">{KIND_HELP[l.kind]}</div>
          {view.two && (
            <div className="yago-hint px-1" style={!view.conn2 || !uses.some(u => u & 2) || !uses.some(u => u & 1) ? { color: '#c2410c' } : undefined}>
              {!view.conn2 ? 'Connector 2 is not picked — the points set to 2 stay empty until you pick one.'
                : !uses.some(u => u & 2) ? 'Connector 2 is not used yet — set a point below to 2 or 1+2.'
                : !uses.some(u => u & 1) ? 'Connector 1 is not used at any point — set a point below to 1 or 1+2.'
                  : 'Two connectors on this rule: every point below chooses connector 1, connector 2 or both (1+2).'}
            </div>
          )}
          {l.kind === 'ends' && (
            <div className="grid grid-cols-3 gap-x-1" style={QB_CELL_ROW}>
              {front}
              <EditCell label="From rear" title="Exact distance of the last connector from the rear (end) of the joint (mm)">{mm(l.end, v => onPatch({ end: v }))}</EditCell>
              {middle}
            </div>
          )}
          {l.kind === 'grid' && (
            <div className="grid grid-cols-2 gap-x-1" style={QB_CELL_ROW}>
              {front}{rearMin}
              <EditCell label="Grid" title="Grid pitch (mm) — 32 for the 32 mm system">{mm(l.pitch, v => onPatch({ pitch: v }), 1)}</EditCell>
              {middle}
            </div>
          )}
          {view.two && (l.kind === 'ends' || l.kind === 'grid') && (
            <div className="grid grid-cols-3 gap-x-1" style={QB_CELL_ROW}>
              {USE_SLOTS.map(sl => (
                <EditCell key={sl.k} label={sl.label} title={`${sl.what} — connector 1, connector 2 or both`}>
                  <UsePick value={l.use?.[sl.k]} view={view} what={sl.what} onPick={u => onPatch({ use: { ...l.use, [sl.k]: u } })} />
                </EditCell>
              ))}
            </div>
          )}
          {l.kind === 'steps' && (
            <>
              <div className="grid grid-cols-2 gap-x-1" style={QB_CELL_ROW}>{front}{rearMin}</div>
              <div className="flex flex-col" style={{ rowGap: QB_CELL_ROW.rowGap }}>
                {view.two && (
                  <div className="yago-cell h-[28px] pl-2 pr-1 flex items-center gap-1" onClick={stop} title="Which connector the first position gets (the one at the front distance)">
                    <span className="yago-label shrink-0 w-[48px]">First</span>
                    <span className="flex-1 min-w-0 truncate yago-hint">at the front distance</span>
                    <UsePick value={l.use?.start} view={view} what="First connector" onPick={u => onPatch({ use: { ...l.use, start: u } })} />
                    <span className="shrink-0 w-[22px]" />
                  </div>
                )}
                {l.steps.map((s, i) => (
                  <div key={i} className="yago-cell h-[28px] pl-2 pr-1 flex items-center gap-1" onClick={stop}
                    title={`Step ${i + 1}: move ${fmt1(s.d)} mm from the previous connector and put one — ${s.n > 0 ? `${s.n} time${s.n === 1 ? '' : 's'}` : 'as many times as fit'}`}>
                    <span className="yago-label shrink-0 w-[48px]">Step {i + 1}</span>
                    <span className="flex-1 min-w-0" />
                    <QbNum value={s.d} min={1} w={44} onCommit={v => onPatch({ steps: l.steps.map((x, k) => (k === i ? { ...x, d: v } : x)) })} /><Unit />
                    <span className="yago-label shrink-0 pl-2">Times</span>
                    <BlankNum value={s.n} placeholder="fit" limit={40} onCommit={v => onPatch({ steps: l.steps.map((x, k) => (k === i ? { ...x, n: Math.round(v) } : x)) })}
                      title="How many connectors this step puts — empty (fit) = as many as fit before the rear minimum" />
                    {view.two && <span className="shrink-0 pl-1"><UsePick value={s.c} view={view} what={`Step ${i + 1} puts`} onPick={u => onPatch({ steps: l.steps.map((x, k) => (k === i ? { ...x, c: u } : x)) })} /></span>}
                    {l.steps.length > 1 ? <RowTrash title="Remove this step" onClick={() => onPatch({ steps: l.steps.filter((_, k) => k !== i) })} /> : <span className="shrink-0 w-[22px]" />}
                  </div>
                ))}
                {l.steps.length < MAX_LAYOUT_STEPS && (
                  <div className="flex justify-end h-[24px]">
                    <CardAction compact icon={Plus} label="Add step" className="!h-[22px] !px-2" title="Add the next step"
                      onClick={() => onPatch({ steps: [...l.steps, { d: l.steps[l.steps.length - 1]?.d ?? 256, n: 1 }] })} />
                  </div>
                )}
              </div>
            </>
          )}
          {l.kind === 'list' && (
            <div className="flex flex-col" style={{ rowGap: QB_CELL_ROW.rowGap }}>
              {l.points.map((p, i) => (
                <div key={i} className="yago-cell h-[28px] pl-2 pr-1 flex items-center gap-1.5" onClick={stop}>
                  <span className="yago-label shrink-0 w-[14px]">{i + 1}</span>
                  <div className="w-[176px] shrink-0"><Segmented items={POINT_SEG} active={p.from} height={20} onPick={k => onPatch({ points: l.points.map((x, j) => (j === i ? { ...x, from: k as 'start' | 'end' } : x)) })} /></div>
                  <span className="flex-1 min-w-0" />
                  <QbNum value={p.d} min={0} w={44} onCommit={v => onPatch({ points: l.points.map((x, j) => (j === i ? { ...x, d: v } : x)) })} /><Unit />
                  {view.two && <span className="shrink-0 pl-1"><UsePick value={p.c} view={view} what={`Position ${i + 1}`} onPick={u => onPatch({ points: l.points.map((x, j) => (j === i ? { ...x, c: u } : x)) })} /></span>}
                  <RowTrash title="Remove this connector from the list" onClick={() => onPatch({ points: l.points.filter((_, j) => j !== i) })} />
                </div>
              ))}
              {l.points.length < MAX_LAYOUT_POINTS && (
                <div className="flex justify-end h-[24px]">
                  <CardAction compact icon={Plus} label="Add connector" className="!h-[22px] !px-2" title="Add one more position to the list"
                    onClick={() => { const last = l.points.filter(p => p.from === 'start').reduce((m, p) => Math.max(m, p.d), 0); onPatch({ points: [...l.points, { from: 'start', d: last + 50 }] }); }} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
/** DİZİLİM DÜZENLEYİCİ. Üstte sabit: ad + önizleme şeridi (o boyda geçerli kuralların hepsi) + boy aralığı haritası; altta kurallar.
 *  Kural açılınca önizleme boyu onun aralığına gelir; haritada boy değişince hangi kuralların devrede olduğu satırlarda görünür. */
function ConnectorLayoutEditor({ draft, setDraft, onSave, onCancel }: { draft: ConnectorLayoutSet; setDraft: (l: ConnectorLayoutSet) => void; onSave: () => void; onCancel: () => void }) {
  const { connectors } = useStoreFields('connectors');
  const [len, setLen] = useState(560);
  const [openId, setOpenId] = useState<string | null>(draft.lines[0]?.id ?? null);
  const ref = useRef(draft); ref.current = draft;
  const setLines = (fn: (lines: LayoutLine[]) => LayoutLine[]) => setDraft({ ...ref.current, lines: fn(ref.current.lines) });
  /** Boy, satırın aralığının dışındaysa içine çekilir (düzenlenen kural şeritte görünsün); ters girilmiş aralıkta dokunulmaz. */
  const reach = (l: Pick<LayoutLine, 'min' | 'max'>) => { if (!lineApplies(l, len) && !(l.max > 0 && l.max < l.min)) setLen(l.max > 0 && len > l.max ? l.max : Math.max(1, l.min)); };
  const patchLine = (id: string, p: Partial<LayoutLine>) => {
    setLines(ls => ls.map(l => (l.id === id ? { ...l, ...p } : l)));
    // Açık kuralın aralığı değişti → önizleme boyu onu izler.
    const cur = ref.current.lines.find(l => l.id === id);
    if (cur && id === openId && ('min' in p || 'max' in p)) reach({ ...cur, ...p });
  };
  const views = lineViews(draft, connectors), rows = views.filter(v => viewSlots(v).length > 0 && lineApplies(v.line, len)), act = rows.findIndex(v => v.line.id === openId);
  /** Kuralı açar; önizleme boyu aralığının dışındaysa içine çekilir (düzenlenen kural şeritte görünsün). */
  const open = (l: LayoutLine, toggle = true) => {
    setOpenId(id => (toggle && id === l.id ? null : l.id));
    reach(l);
  };
  const add = (init?: LayoutLine) => {
    const base = init ?? ref.current.lines.find(l => l.id === openId) ?? ref.current.lines[ref.current.lines.length - 1];
    const line = init ? { ...(JSON.parse(JSON.stringify(init)) as LayoutLine), id: newLayoutLine(null).id } : newLayoutLine(base?.connectorId ?? connectors[0]?.id ?? null);
    setLines(ls => { const i = init ? ls.findIndex(l => l.id === init.id) : -1; return i < 0 ? [...ls, line] : [...ls.slice(0, i + 1), line, ...ls.slice(i + 1)]; });
    setOpenId(line.id);
    reach(line);
  };
  const nConn = new Set(draft.lines.flatMap(lineConnectorIds).filter(Boolean)).size;
  return (
    <>
      <div className="sticky top-0 z-30 -mx-1.5 -mt-1.5 px-1.5 pt-1.5 pb-1.5 flex flex-col gap-1.5" onClick={stop}
        style={{ background: '#f8f6f2', boxShadow: '0 6px 10px -8px rgba(40,30,20,0.18)' }}>
        <div className="flex items-center gap-1.5">
          <div className="yago-cell flex-1 min-w-0 h-[28px] px-2 flex items-center">
            <input type="text" value={draft.name} placeholder="Layout" spellCheck={false} onChange={e => setDraft({ ...ref.current, name: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter') onSave(); }} className="yago-field yago-field-text" style={TEXT_INPUT} />
          </div>
          <ApplyBtn enabled onClick={onSave} title="Save" />
          <ExitBtn onClick={onCancel} />
        </div>
        <div className="rounded-[9px] ring-1 ring-[#e3ddd4] px-1 pt-1" style={{ background: '#faf8f5' }}>
          <LayoutBand length={len} ends={['front', 'rear']} rows={rows} active={act} onPick={i => setOpenId(rows[i].line.id)} onDrag={patchLine} />
        </div>
        <div className="rounded-[9px] ring-1 ring-[#e3ddd4]" style={{ background: '#faf8f5' }}>
          <div className="flex items-center gap-2 h-[26px] pl-2 pr-1">
            <span className="yago-label shrink-0">Joint length</span>
            <span className="flex-1 min-w-0 truncate yago-hint">which rule is used at which length — click or drag</span>
            <div className="yago-cell shrink-0 h-[22px] pl-1 pr-0.5 flex items-center"><QbNum value={len} min={1} max={9999} w={40} onCommit={setLen} /><Unit /></div>
          </div>
          <LayoutRangeMap rows={views} length={len} onLength={setLen} activeId={openId} onPick={setOpenId} />
        </div>
      </div>
      <QbSection title="Rules" sub={`${draft.lines.length} rule${draft.lines.length === 1 ? '' : 's'} · ${nConn} connector${nConn === 1 ? '' : 's'}`}
        trailing={<CardAction compact icon={Plus} label="Add rule" title="Add a rule: another connector, or other values for another joint-length range" onClick={() => add()} />}>
        <div className="flex flex-col gap-1" onClick={stop}>
          {!connectors.length && <div className="yago-hint px-1">No connectors in the library yet — create one under Connect first.</div>}
          {!draft.lines.length && <div className="yago-hint px-1">No rules yet. A rule = one connector (or two) + the joint lengths it is used on + how it is spread along the joint.</div>}
          {views.map((v, i) => (
            <LayoutLineRow key={v.line.id} view={v} index={i} open={v.line.id === openId} length={len} connectors={connectors}
              onOpen={() => open(v.line)} onPatch={p => patchLine(v.line.id, p)} onCopy={() => add(v.line)}
              onRemove={() => { setLines(ls => ls.filter(l => l.id !== v.line.id)); if (openId === v.line.id) setOpenId(null); }} />
          ))}
          <div className="yago-hint px-1 pt-0.5">Every rule whose length range contains the joint is applied — rules for different connectors add up, and one connector can have different rules for short and long joints. A rule can also carry two connectors: add the second with “+ 2nd”, then choose 1, 2 or 1+2 for every point.</div>
        </div>
      </QbSection>
    </>
  );
}
const layoutSetSummary = (l: ConnectorLayoutSet, connectors: Connector[]): string => {
  const names = [...new Set(l.lines.flatMap(lineConnectorIds).map(id => connectors.find(c => c.id === id)?.name).filter((x): x is string => !!x))];
  return `${names.join(' + ') || 'no connector'} · ${l.lines.length} rule${l.lines.length === 1 ? '' : 's'}`;
};
/** DİZİLİMLER (Accessories › Layout): kütüphane listesi + düzenleyici. Taslak üstte (AccessoriesPanel) tutulur. */
function ConnectorLayoutsPanel({ draft, setDraft }: { draft: ConnectorLayoutSet | null; setDraft: (l: ConnectorLayoutSet | null) => void }) {
  const { connectorLayouts: sets, connectors, panelTypeConfig, setAccessoryCategory } = useStoreFields('connectorLayouts', 'connectors', 'panelTypeConfig', 'setAccessoryCategory');
  const save = async () => { if (!draft) return; await saveLayoutSet({ ...draft, name: draft.name.trim() || 'Layout' }); setDraft(null); };
  const nextName = () => { let n = sets.length + 1; while (sets.some(x => x.name === `Layout ${n}`)) n++; return `Layout ${n}`; };
  return (
    <div className="px-1.5 pt-1.5 pb-2 flex flex-col gap-1.5" style={{ fontFamily: UI_FONT }}>
      {draft ? <ConnectorLayoutEditor draft={draft} setDraft={setDraft} onSave={() => void save()} onCancel={() => setDraft(null)} /> : (
        <QbSection title="Connector layouts" sub={sets.length ? 'where the connectors sit along a joint' : undefined}
          trailing={<CardAction compact icon={Plus} label="New" title="New connector layout" onClick={() => setDraft(newLayoutSet(nextName(), connectors[0]?.id ?? null))} />}>
          {!connectors.length && (
            <div className="yago-hint px-1 py-0.5 flex items-center gap-1"><span>A layout places connectors — the library has none yet.</span>
              <button type="button" onClick={e => { stop(e); setAccessoryCategory('connectors'); }} className="font-semibold text-orange-700 hover:underline">Create a connector</button></div>
          )}
          {!sets.length ? <div className="yago-hint px-1 py-0.5">None yet — a layout says where connectors go along a joint: which connector, on which joint lengths, by which rule. Panel types (Types) choose a layout for each edge.</div> : (
            <div className="flex flex-col gap-1">
              {sets.map(l => {
                const uses = layoutUseCount(l.id, panelTypeConfig);
                return (
                  <div key={l.id} className={ROW}>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-stone-700">{l.name}</span>
                    <span className={`shrink min-w-0 truncate ${MUTED}`}>{layoutSetSummary(l, connectors)}</span>
                    <span className={`shrink-0 ${MUTED}`} title="Panel-type edges that use this layout (Accessories › Types)">· {uses ? `${uses} edge${uses === 1 ? '' : 's'}` : 'unused'}</span>
                    <button type="button" title="Edit" onClick={() => setDraft(cloneLayoutSet(l))} className={ICON_BTN}><Pencil size={12} strokeWidth={1.9} /></button>
                    <button type="button" title="Duplicate" onClick={() => void saveLayoutSet({ ...cloneLayoutSet(l), id: newLayoutSet().id, name: `${l.name} copy`, createdAt: Date.now() })} className={ICON_BTN}><Copy size={12} strokeWidth={1.9} /></button>
                    <button type="button" title={uses ? 'Delete — the edges that use it lose their connectors' : 'Delete'} onClick={() => void deleteLayoutSet(l.id)} className={DEL_BTN}><Trash2 size={12} strokeWidth={1.9} /></button>
                  </div>
                );
              })}
            </div>
          )}
        </QbSection>
      )}
    </div>
  );
}
const CHIP = 'h-[22px] px-2 rounded-full text-[10.5px] font-semibold whitespace-nowrap transition-colors duration-150 flex items-center gap-1';
const CHIP_ON = 'bg-[#292524] text-white ring-1 ring-[#292524]', CHIP_IDLE = 'bg-white text-stone-600 ring-1 ring-[#e3ddd4] hover:ring-[#bfb7ab] hover:text-stone-900 hover:bg-[#faf8f5]';
const CHIP_OFF = 'bg-transparent text-stone-400 border border-dashed border-[#d6cfc3] hover:text-stone-700 hover:border-[#bfb7ab]';
/** Yüzey satırı: sunulan tipler çip olarak (koyu = varsayılan; çipe tık → varsayılan olur). Açınca yüzeye konabilecek tüm tipler aç / kapa. */
function SurfaceRow({ surface, cfg, open, onToggle }: { surface: PanelSurface; cfg: PanelTypeConfig; open: boolean; onToggle: () => void }) {
  const rule = surfaceRuleOf(surface, cfg), cands = candidateTypesFor(surface);
  const toggleAllowed = (t: PanelTypeId) => {
    const on = rule.allowed.includes(t);
    if (on && rule.allowed.length === 1) return;   // en az bir tip kalır
    const allowed = on ? rule.allowed.filter(x => x !== t) : cands.filter(x => x === t || rule.allowed.includes(x));
    void setSurfaceRule(surface, { allowed, def: allowed.includes(rule.def) ? rule.def : allowed[0] });
  };
  return (
    <div className={rowCardClass(open, false, false)}>
      <div onClick={e => { stop(e); onToggle(); }} className={`relative min-h-[34px] py-[5px] pl-2.5 pr-1 flex items-center gap-2 cursor-pointer transition-colors duration-150 hover:bg-[#faf8f5] ${open ? ROW_SEL_HEAD : ''}`}>
        {open && <span className={ROW_SEL_BAR} />}
        <span className="yago-label shrink-0 w-[104px]">{surfaceLabel(surface)}</span>
        <div className="flex-1 min-w-0 flex flex-wrap gap-1">
          {rule.allowed.map(t => (
            <button key={t} type="button" onClick={e => { stop(e); if (t !== rule.def) void setSurfaceRule(surface, { ...rule, def: t }); }}
              title={t === rule.def ? `${panelTypeLabel(t)} — the type a new panel gets on this ${surfaceLabel(surface).toLowerCase()}` : `${panelTypeLabel(t)} — offered here · click to make it the default`}
              className={`${CHIP} ${t === rule.def ? CHIP_ON : CHIP_IDLE}`}>{panelTypeShort(t)}</button>
          ))}
        </div>
        <RowChevron open={open} onClick={e => { stop(e); onToggle(); }} title={open ? 'Close' : 'Choose which types are offered on this face'} />
      </div>
      {open && (
        <div className={CARD_BODY} style={CARD_BODY_STYLE} onClick={stop}>
          <div className="yago-hint pb-1.5">Types offered when a panel is placed here — only these appear in the panel's type list. The dark one above is the default.</div>
          <div className="flex flex-wrap gap-1">
            {cands.map(t => {
              const on = rule.allowed.includes(t);
              return (
                <button key={t} type="button" onClick={e => { stop(e); toggleAllowed(t); }}
                  title={`${panelTypeLabel(t)} — ${on ? 'offered · click to remove' : 'not offered · click to add'}`}
                  className={`${CHIP} ${on ? (t === rule.def ? CHIP_ON : CHIP_IDLE) : CHIP_OFF}`}>
                  {on && <Check size={10} strokeWidth={2.6} className="-ml-0.5" />}{panelTypeShort(t)}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
const PLANE_SEG: SegItem[] = [
  { key: 'side', label: 'Side', title: 'Free panel standing like a side / divider' }, { key: 'horizontal', label: 'Horizontal', title: 'Free panel lying like a top / shelf' },
  { key: 'frontal', label: 'Frontal', title: 'Free panel standing like a back / plinth' },
];
/** Tip seçimi: gruplu tek liste; bağlayıcı tanımlı tipler "●" ile işaretli. */
function TypeSelect({ value, onChange, cfg }: { value: PanelTypeId; onChange: (t: PanelTypeId) => void; cfg: PanelTypeConfig }) {
  return (
    <FieldBox label="Panel type" title="Pick the panel type to set up — or click a panel on the cabinet">
      <div className="relative min-w-0">
        <select value={value} onChange={e => onChange(e.target.value as PanelTypeId)} style={{ fontFamily: UI_FONT }}
          className="h-[22px] pl-1 pr-5 rounded-[5px] bg-transparent text-[12px] font-semibold text-stone-800 appearance-none outline-none cursor-pointer text-right">
          {PANEL_TYPE_GROUPS.map(g => (
            <optgroup key={g.key} label={g.label}>
              {PANEL_TYPES.filter(t => t.group === g.key).map(t => <option key={t.id} value={t.id}>{t.label}{typeEdgeCount(t.id, cfg) ? '  ●' : ''}</option>)}
            </optgroup>
          ))}
        </select>
        <ChevronDown size={11} strokeWidth={2.2} className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 text-stone-400" />
      </div>
    </FieldBox>
  );
}
function PanelTypesPanel({ onEditLayout }: { /** dizilimi Layout bölümünde düzenlemeye aç */ onEditLayout: (l: ConnectorLayoutSet) => void }) {
  const { panelTypeConfig: cfg, connectors, connectorLayouts: sets, setAccessoryCategory } = useStoreFields('panelTypeConfig', 'connectors', 'connectorLayouts', 'setAccessoryCategory');
  const [sel, setSel] = useState<PanelTypeId>('bottom');
  const [build, setBuild] = useState<CabBuild>('panels');
  const [edge, setEdge] = useState<PanelEdgeDir | null>(null);
  const [active, setActive] = useState(0);
  const [freePlane, setFreePlane] = useState<Exclude<PanelPlane, 'any'>>('side');
  const [facesOpen, setFacesOpen] = useState(false);
  const [openSurface, setOpenSurface] = useState<PanelSurface | null>(null);
  const def = panelTypeDef(sel)!;
  const plane = def.plane === 'any' ? freePlane : def.plane;
  // Önizleme ölçüsü: tip / düzlem değişince örnek ölçüye döner; "Joint length" seçili kenarın boyunu değiştirir.
  const [size, setSize] = useState<[number, number]>(() => sampleSizeOf(sel, plane));
  useEffect(() => { setSize(sampleSizeOf(sel, plane)); }, [sel, plane]);
  const pick = (t: PanelTypeId) => { setSel(t); setEdge(null); setActive(0); const b = buildOfType(t); if (b) setBuild(b); };
  const cur = edge && PLANE_EDGES[plane].includes(edge) ? edge : null;
  const horizontal = cur ? cur === PLANE_EDGES[plane][0] || cur === PLANE_EDGES[plane][1] : true;
  const length = horizontal ? size[0] : size[1];
  const setLength = (v: number) => setSize(s => (horizontal ? [v, s[1]] : [s[0], v]));
  const ruleOf = (e: PanelEdgeDir) => edgeRulesOf(sel, e, cfg)[0];
  const setOf = (e: PanelEdgeDir) => { const r = ruleOf(e); return r ? sets.find(x => x.id === r.layoutId) : undefined; };
  /** Kenarın satırları (dizilim atanmışsa; kayıp dizilimde boş liste), atanmamışsa null. */
  const rowsOf = (e: PanelEdgeDir): LineView[] | null => (ruleOf(e) ? lineViews(setOf(e), connectors) : null);
  const rule = cur ? ruleOf(cur) : undefined, set = cur ? setOf(cur) : undefined;
  const views = lineViews(set, connectors), rows = views.filter(v => viewSlots(v).length > 0 && lineApplies(v.line, length));
  // Kenara tık: seçilir; seçili kenara tık → kapanır.
  const onEdge = (e: PanelEdgeDir) => { setActive(0); setEdge(cur === e ? null : e); };
  const ends = (cur ? EDGE_ENDS[plane][cur] : undefined) ?? (['left', 'right'] as [PanelEdgeDir, PanelEdgeDir]);
  const n = PLANE_EDGES[plane].filter(e => !!ruleOf(e)).length;
  const total = rows.reduce((k, r) => k + viewCount(r, length), 0);
  return (
    <div className="px-1.5 pt-1.5 pb-2 flex flex-col gap-1.5" style={{ fontFamily: UI_FONT }}>
      <QbSection title="Panel types" sub="click a panel on the cabinet, or pick from the list">
        <div className="flex flex-col gap-1.5" onClick={stop}>
          <CabinetView sel={sel} onSel={pick} build={build} onBuild={setBuild} />
          <TypeSelect value={sel} onChange={pick} cfg={cfg} />
        </div>
      </QbSection>
      <QbSection title={def.label} sub={n ? `connectors on ${n} edge${n === 1 ? '' : 's'}` : 'no connector yet — click an edge'}>
        <div className="flex flex-col gap-1.5" onClick={stop}>
          {def.plane === 'any' && <Segmented items={PLANE_SEG} active={freePlane} onPick={k => { setFreePlane(k as Exclude<PanelPlane, 'any'>); setEdge(null); }} height={24} />}
          <div className="rounded-[9px] ring-1 ring-[#e3ddd4]" style={{ background: '#faf8f5' }}>
            <PanelFaceView type={sel} plane={plane} size={size} cur={cur} rowsOf={rowsOf} onEdge={onEdge} />
          </div>
          {!sets.length ? (
            <div className="yago-hint px-1 flex items-center gap-1">
              <span>No connector layouts yet.</span>
              <button type="button" onClick={e => { stop(e); setAccessoryCategory('layouts'); }} className="font-semibold text-orange-700 hover:underline">Create one</button>
            </div>
          ) : !cur ? (
            <div className="yago-hint px-1">Click an edge to choose its connector layout. The connectors are placed wherever that edge of the panel butts against the face of another panel.</div>
          ) : (
            <>
              <div className="flex items-center gap-1.5 min-h-[28px]">
                <span className="shrink-0 h-[20px] px-2 rounded-full bg-[#292524] text-white text-[9.5px] font-bold tracking-[0.07em] flex items-center">{EDGE_LABEL[cur].toUpperCase()} EDGE</span>
                <SelectBox label="Layout" value={rule?.layoutId ?? ''} className="flex-1 min-w-0"
                  options={[['', 'None'], ...(rule && !set ? [[rule.layoutId, 'Missing layout'] as [string, string]] : []), ...sets.map(x => [x.id, x.name] as [string, string])]}
                  onChange={id => { setActive(0); void setEdgeLayout(sel, cur, id || null, !!rule?.flipFace); }}
                  title="Connector layout used on this edge — layouts are made under Accessories › Layout" />
                {set && <CardAction compact icon={Pencil} label="Edit" title={`Open “${set.name}” in the layout editor`} onClick={() => onEditLayout(set)} />}
              </div>
              {rule && set && (
                <>
                  <div className="rounded-[9px] ring-1 ring-[#e3ddd4] px-1 pt-1" style={{ background: '#faf8f5' }}>
                    <LayoutBand length={length} ends={[ends[0], ends[1]]} rows={rows} active={Math.min(active, rows.length - 1)} onPick={setActive} />
                  </div>
                  <LengthSlider value={length} onChange={setLength} marks={setMarks(set)} />
                  <div className="flex flex-col gap-[3px]">
                    {views.map((v, i) => {
                      const hit = viewSlots(v).length > 0 && lineApplies(v.line, length), ri = rows.indexOf(v);
                      return (
                        <div key={v.line.id} onClick={() => { if (ri >= 0) setActive(ri); }}
                          className={`yago-cell h-[26px] pl-2 pr-2 flex items-center gap-2 ${ri >= 0 ? 'cursor-pointer' : ''} ${ri >= 0 && ri === Math.min(active, rows.length - 1) ? 'is-accent' : ''}`} style={{ opacity: hit ? 1 : 0.55 }}
                          title={hit ? 'Used on the previewed joint — click to show its dimensions' : `Not used on the previewed joint (${fmt1(length)} mm)`}>
                          <span className="shrink-0 flex items-center gap-[2px]">
                            <span className="w-[9px] h-[9px] rounded-full" style={{ background: v.color }} />
                            {v.two && <span className="w-[9px] h-[9px] rounded-full" style={{ background: v.color2 }} />}
                          </span>
                          <span className="shrink-0 text-[10.5px] font-semibold tabular-nums text-stone-400">{i + 1}</span>
                          <span className="shrink min-w-0 truncate text-[11.5px] font-semibold text-stone-700">{viewNames(v) || 'No connector'}</span>
                          <span className={`shrink-0 h-[16px] px-1.5 rounded-full text-[9.5px] font-semibold tabular-nums flex items-center ${hit ? 'bg-[#292524] text-white' : 'bg-[#ece7e0] text-stone-500'}`}>{lineRangeText(v.line)}</span>
                          <span className={`flex-1 min-w-0 truncate text-right ${MUTED}`}>{layoutKindLabel(v.line.kind)} · {lineSummary(v.line)}</span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-2 h-[22px] pl-1">
                    <label className="shrink-0 flex items-center gap-1.5 cursor-pointer" title="Machine the panel-face holes on the other wide face of this panel (default: the hidden face — underside, top of a top panel, outside of a side)">
                      <QbSwitch on={!!rule.flipFace} onToggle={() => void setEdgeLayout(sel, cur, rule.layoutId, !rule.flipFace)} /><span className="yago-label">Other face</span>
                    </label>
                    <span className="flex-1 min-w-0 truncate yago-hint text-right">{total} connector{total === 1 ? '' : 's'} on a {fmt1(length)} mm joint</span>
                  </div>
                </>
              )}
              {rule && !set && <div className="text-[10.5px] font-medium text-red-600 px-1">The layout assigned to this edge no longer exists — pick another one.</div>}
            </>
          )}
        </div>
      </QbSection>
      {/* Yüz varsayılanları: seyrek değişen ayar → kapalı gelir */}
      <div className={rowCardClass(facesOpen, false, false)}>
        <div onClick={e => { stop(e); setFacesOpen(o => !o); }} className="min-h-[34px] pl-3 pr-1 flex items-center gap-2 cursor-pointer transition-colors duration-150 hover:bg-[#faf8f5]">
          <span style={SECTION_LABEL}>Default type by face</span>
          <span className="flex-1 min-w-0 truncate text-[10.5px] text-stone-400">which type a new panel gets, and which types are offered</span>
          <RowChevron open={facesOpen} onClick={e => { stop(e); setFacesOpen(o => !o); }} title={facesOpen ? 'Close' : 'Open'} />
        </div>
        {facesOpen && (
          <div className={`${CARD_BODY} flex flex-col gap-1`} style={CARD_BODY_STYLE} onClick={stop}>
            {PANEL_SURFACES.map(s => <SurfaceRow key={s.key} surface={s.key} cfg={cfg} open={openSurface === s.key}
              onToggle={() => setOpenSurface(o => (o === s.key ? null : s.key))} />)}
          </div>
        )}
      </div>
    </div>
  );
}

/* ═════════════════════════════════ BAĞLAYICILAR ═════════════════════════════════
   Bağlayıcı = delikler + çizilmiş operasyonlar (pocket / line) + modeller; hepsi TEMSİLİ BİRLEŞİMDE tanımlanır: B paneli ucuyla A panelinin
   yüzüne dayanır. Üç yüzey: B'nin geniş yüzü · B'nin ucu (kalınlığı) · A'nın temas yüzü. Etkin yüzey üstten seçilir (kamera ona döner,
   öteki panel saydamlaşır); delik / model yüzeye tıklanarak konur, değerler satırdan düzeltilir. Operasyon düz görünümde 2B araçlarla çizilir. */
const JOINT = { a: '#efe4cf', b: '#e3d3b6', edge: '#9f9486' } as const;
const JOINT_TARGET = new THREE.Vector3(CONN_REP.bLen * 0.36, 6, 0);
const JOINT_VIEW: Record<ConnSurface, [number, number, number]> = { bFace: [0.6, 0.62, 0.7], aFace: [0.82, 0.4, 0.62], bEdge: [-0.8, 0.42, 0.62] };
const JOINT_R = 118;
type ConnMode = 'none' | 'hole' | 'place';
type SurfHover = { along: number; across: number; snapAlong: boolean; snapAcross: boolean };
/** Kamera etkin yüzeye döner (yön yumuşak geçer, uzaklık korunur); ilk açılışta doğrudan oturur. */
function JointCamera({ surface }: { surface: ConnSurface }) {
  const camera = useThree(s => s.camera) as THREE.PerspectiveCamera;
  const controls = useThree(s => s.controls) as unknown as { target: THREE.Vector3; update: () => void } | null;
  const goal = useRef<THREE.Vector3 | null>(null), first = useRef(true);
  useEffect(() => {
    const off = new THREE.Vector3(...JOINT_VIEW[surface]).normalize().multiplyScalar(JOINT_R * 5.3);
    if (first.current) {
      camera.position.copy(JOINT_TARGET).add(off); camera.near = 1; camera.far = 8000; camera.updateProjectionMatrix();
      if (controls) { controls.target.copy(JOINT_TARGET); controls.update(); first.current = false; } else camera.lookAt(JOINT_TARGET);
    } else goal.current = off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface, !!controls]);
  useFrame(() => {
    const g = goal.current; if (!g) return;
    const cur = camera.position.clone().sub(JOINT_TARGET), len = cur.length() + (g.length() - cur.length()) * 0.2;
    cur.lerp(g, 0.2).setLength(len);
    if (cur.distanceTo(g) < 1) { cur.copy(g); goal.current = null; }
    camera.position.copy(JOINT_TARGET).add(cur); controls?.update();
  });
  return null;
}
/** Temsili panel: ahşap tonunda kutu + kenar çizgileri + harf (A / B). Saydam (hayalet) panel ışına yanıt vermez. */
function JointPanel({ min, max, color, ghost, letter, sub, labelAt }: { min: Vec3; max: Vec3; color: string; ghost: boolean; letter: string; sub: string; labelAt: Vec3 }) {
  const size: Vec3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]], center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const edges = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(size[0], size[1], size[2])), [size[0], size[1], size[2]]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => edges.dispose(), [edges]);
  return (
    <group>
      <group position={center}>
        <mesh raycast={() => null} castShadow={!ghost} receiveShadow={!ghost} renderOrder={ghost ? 3 : 0}>
          <boxGeometry args={size} />
          <meshStandardMaterial key={ghost ? 'g' : 's'} color={color} roughness={0.86} transparent={ghost} opacity={ghost ? 0.13 : 1} depthWrite={!ghost} />
        </mesh>
        <lineSegments geometry={edges} raycast={() => null}><lineBasicMaterial color={JOINT.edge} transparent opacity={ghost ? 0.4 : 0.95} /></lineSegments>
      </group>
      <Html position={labelAt} center zIndexRange={[20, 30]} style={{ pointerEvents: 'none' }}>
        <div style={{ fontFamily: UI_FONT, display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap', opacity: ghost ? 0.45 : 1 }}>
          <span style={{ width: 16, height: 16, borderRadius: 8, background: '#292524', color: '#fff', fontSize: 9.5, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{letter}</span>
          <span style={{ fontSize: 9.5, fontWeight: 600, color: '#6b645b', textShadow: '0 0 2px #fff, 0 0 2px #fff' }}>{sub}</span>
        </div>
      </Html>
    </group>
  );
}
/** Yüzey koordinatını sınıra kıstırır ve yakalar: 0 çizgisine (bağlayıcı noktası / kalınlık ortası) ve var olan deliklerin hizasına (≤ 2,5 mm). */
function snapOnSurface(surface: ConnSurface, along: number, across: number, tB: number, refs: Array<{ along: number; across: number }>): SurfHover {
  const ext = connSurfaceExtent(surface, tB), clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  let x = clamp(along, ext.x0, ext.x1), y = clamp(across, ext.y0, ext.y1), sx = false, sy = false;
  const near = (v: number, targets: number[]) => targets.find(t => Math.abs(v - t) <= 2.5);
  const tx = near(x, [0, ...refs.map(r => r.along)]); if (tx !== undefined) { x = tx; sx = true; }
  const ty = near(y, [...(surface === 'bFace' ? [] : [0]), ...refs.map(r => r.across)]); if (ty !== undefined) { y = ty; sy = true; }
  return { along: x, across: y, snapAlong: sx, snapAcross: sy };
}
/** Etkin yüzey: hafif turuncu ton + (araç kipinde) tıklama düzlemi. Düzlem yüzeyin 0,05 mm üstünde; iki yönden ışına yanıt verir. */
function SurfacePlane({ surface, tB, active, interactive, onMove, onLeave, onClick }: {
  surface: ConnSurface; tB: number; active: boolean; interactive: boolean; onMove: (p: Vec3) => void; onLeave: () => void; onClick: () => void;
}) {
  const gl = useThree(s => s.gl);
  const ext = connSurfaceExtent(surface, tB), wAlong = ext.x1 - ext.x0, wAcross = ext.y1 - ext.y0, cAcross = (ext.y0 + ext.y1) / 2;
  const place: { pos: Vec3; rot: Vec3; args: [number, number] } = surface === 'bFace'
    ? { pos: [cAcross, tB / 2 + 0.05, 0], rot: [-Math.PI / 2, 0, 0], args: [wAcross, wAlong] }
    : surface === 'bEdge' ? { pos: [-0.05, cAcross, 0], rot: [0, -Math.PI / 2, 0], args: [wAlong, wAcross] }
      : { pos: [0.05, cAcross, 0], rot: [0, Math.PI / 2, 0], args: [wAlong, wAcross] };
  if (!active) return null;
  return (
    <mesh position={place.pos} rotation={place.rot} renderOrder={6} raycast={interactive ? MESH_RAY : NO_RAY}
      onPointerMove={e => { e.stopPropagation(); onMove([e.point.x, e.point.y, e.point.z]); gl.domElement.style.cursor = 'crosshair'; }}
      onPointerOut={() => { onLeave(); gl.domElement.style.cursor = ''; }}
      onClick={e => { e.stopPropagation(); onClick(); }}>
      <planeGeometry args={place.args} />
      <meshBasicMaterial color={SEL} transparent opacity={interactive ? 0.16 : 0.09} side={THREE.DoubleSide} depthWrite={false} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
    </mesh>
  );
}
/** Yüzey 2B (along, across) → sahne dönüşümü: çizim nesneleri ve pocket dolgusu bununla yüzeye serilir (0,12 mm üstünde). */
function surfaceMatrix(surface: ConnSurface, tB: number): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  // along = −z (bkz. ConnectorService çerçevesi); üçüncü eksen sağ el kuralıyla
  if (surface === 'bFace') m.makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, -1, 0)).setPosition(0, tB / 2 + 0.12, 0);
  else m.makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0)).setPosition(surface === 'bEdge' ? -0.12 : 0.12, 0, 0);
  return m;
}
/** Operasyon sahnede: çizgileri + pocket'ta kapalı çevrelerin yarı saydam dolgusu; line tipinde takım genişliği bant olarak. */
function OpGlyph({ op, tB, selected, faint, onClick }: { op: ConnOp; tB: number; selected: boolean; faint: boolean; onClick: () => void }) {
  const pose = useMemo(() => {
    const m = surfaceMatrix(op.surface, tB);
    return { p: new THREE.Vector3().setFromMatrixPosition(m), q: new THREE.Quaternion().setFromRotationMatrix(m) };
  }, [op.surface, tB]);
  const color = selected ? SEL : '#3f3a35';
  const fills = useMemo(() => (op.type !== 'pocket' ? [] : op.shapes.filter(connShapeClosed).map(s => {
    const pts = connShapePoints(s), sh = new THREE.Shape(pts.map(p => new THREE.Vector2(p.x, p.y)));
    return new THREE.ShapeGeometry(sh);
  })), [op.type, op.shapes]);
  useEffect(() => () => fills.forEach(g => g.dispose()), [fills]);
  return (
    <group position={pose.p} quaternion={pose.q} onClick={e => { e.stopPropagation(); onClick(); }}>
      {fills.map((g, i) => (
        <mesh key={`f${i}`} geometry={g} renderOrder={7}>
          <meshBasicMaterial color={color} transparent opacity={faint ? 0.1 : selected ? 0.32 : 0.2} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      ))}
      {op.shapes.map((s, i) => {
        const pts = connShapePoints(s).map(p => [p.x, p.y, 0] as [number, number, number]);
        if (pts.length < 2) return null;
        return (
          <group key={i}>
            {op.type === 'line' && op.width > 0 && <Line points={pts} color={color} lineWidth={op.width} worldUnits transparent opacity={faint ? 0.1 : 0.22} depthWrite={false} renderOrder={7} />}
            <Line points={pts} color={color} lineWidth={selected ? 2 : 1.4} transparent opacity={faint ? 0.4 : 1} depthTest={false} renderOrder={12} />
          </group>
        );
      })}
    </group>
  );
}
/** Model (aksesuar dosyası): tabanı yüzey noktasında, +Y'si yüzeyden dışarı (flip → içeri), `inset` kadar gömülü, `spin` normal etrafında. */
function ConnPartMesh({ part, tB, color, selected, pickable, onClick }: { part: ConnPart; tB: number; color: string; selected: boolean; pickable: boolean; onClick: () => void }) {
  const gl = useThree(s => s.gl);
  const [, setTick] = useState(0);
  useEffect(() => onAccessoryGeometry(() => setTick(t => t + 1)), []);
  const g = accessoryGeometryNow(part.modelId);
  const { p, q } = useMemo(() => {
    const at = connSurfacePoint(part.surface, part.along, part.across, tB), n = new THREE.Vector3(...at.normal);
    const quat = new THREE.Quaternion().setFromUnitVectors(UP, n.clone().multiplyScalar(part.flip ? -1 : 1));
    quat.multiply(new THREE.Quaternion().setFromAxisAngle(UP, (part.spin * Math.PI) / 180));
    return { p: new THREE.Vector3(...at.pos).addScaledVector(n, -part.inset), q: quat };
  }, [part.surface, part.along, part.across, part.inset, part.spin, part.flip, tB]);
  if (!g) return null;
  return (
    <mesh geometry={g.geo} position={p} quaternion={q} castShadow raycast={pickable ? MESH_RAY : NO_RAY}
      onClick={e => { e.stopPropagation(); onClick(); }}
      onPointerOver={e => { e.stopPropagation(); gl.domElement.style.cursor = 'pointer'; }} onPointerOut={() => { gl.domElement.style.cursor = ''; }}>
      <meshStandardMaterial color={color} roughness={0.5} metalness={0.15} emissive={selected ? SEL : '#000000'} emissiveIntensity={selected ? 0.3 : 0} />
    </mesh>
  );
}
/** İmlecin altındaki yüzey noktası: halka + artı + koordinat etiketi; hizaya yakalanınca o eksen çizgisi uzar. */
function SurfaceHover({ surface, at, tB, radius, acrossLabel }: { surface: ConnSurface; at: SurfHover; tB: number; radius: number; acrossLabel: string }) {
  const sp = connSurfacePoint(surface, at.along, at.across, tB);
  const q = useMemo(() => quatToDir(sp.normal), [sp.normal[0], sp.normal[1], sp.normal[2]]);   // eslint-disable-line react-hooks/exhaustive-deps
  const ring = useMemo(() => circlePts(radius), [radius]);
  const arm = (snap: boolean) => (snap ? 60 : radius * 1.7);
  // Yerel eksenler (yukarı = normal): bFace'te yerel x = across, z = along; öteki yüzeylerde yerel z = along, x ⟂ (across)
  return (
    <group position={sp.pos} quaternion={q}>
      <Line points={ring} color={SEL} lineWidth={1.5} depthTest={false} renderOrder={13} />
      <Line points={[[-arm(at.snapAlong), 0, 0], [arm(at.snapAlong), 0, 0]]} color={SEL} lineWidth={0.8} depthTest={false} renderOrder={13} transparent opacity={at.snapAlong ? 0.9 : 0.7} />
      <Line points={[[0, 0, -arm(at.snapAcross)], [0, 0, arm(at.snapAcross)]]} color={SEL} lineWidth={0.8} depthTest={false} renderOrder={13} transparent opacity={at.snapAcross ? 0.9 : 0.7} />
      <Html center zIndexRange={[30, 40]} style={{ pointerEvents: 'none', transform: 'translate(0, -26px)' }}>
        <span style={{ fontFamily: UI_FONT, fontSize: 10, fontWeight: 600, color: '#fff', background: '#292524', borderRadius: 5, padding: '2px 6px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          along {fmt1(at.along)} · {acrossLabel.toLowerCase()} {fmt1(at.across)}
        </span>
      </Html>
    </group>
  );
}
function JointScene({ conn, tA, tB, active, mode, holeRadius, sel, onSel, onAddHole, onPlace, layers }: {
  conn: Connector; tA: number; tB: number; active: ConnSurface; mode: ConnMode; holeRadius: number; sel: string | null; onSel: (id: string | null) => void;
  onAddHole: (along: number, across: number) => void; onPlace: (along: number, across: number) => void; layers: AccessoryLayer[];
}) {
  const [hover, setHover] = useState<SurfHover | null>(null);
  const hoverRef = useRef<SurfHover | null>(null); hoverRef.current = hover;
  useEffect(() => { setHover(null); }, [mode, active]);
  const tool = mode !== 'none', w = CONN_REP.width / 2;
  const refs = useMemo(() => conn.holes.filter(h => h.surface === active).map(h => ({ along: h.along, across: h.across })), [conn.holes, active]);
  const move = (p: Vec3) => { const c = connSurfaceCoords(active, p); setHover(snapOnSurface(active, c.along, c.across, tB, refs)); };
  const click = () => { const h = hoverRef.current; if (!h) return; if (mode === 'hole') onAddHole(h.along, h.across); else if (mode === 'place') onPlace(h.along, h.across); };
  const acrossLabel = CONN_SURFACES.find(s => s.v === active)!.across;
  return (
    <>
      <JointPanel letter="A" sub="passes" min={[-tA, -CONN_REP.aHeight / 2, -w]} max={[0, CONN_REP.aHeight / 2, w]} color={JOINT.a} ghost={active === 'bEdge'}
        labelAt={[-tA / 2, CONN_REP.aHeight / 2 + 12, 0]} />
      <JointPanel letter="B" sub="butts" min={[0, -tB / 2, -w]} max={[CONN_REP.bLen, tB / 2, w]} color={JOINT.b} ghost={active === 'aFace'}
        labelAt={[CONN_REP.bLen + 14, 0, 0]} />
      {/* Birleşim çizgisi + bağlayıcı noktası (0) */}
      <Line points={[[0, 0, -w - 14], [0, 0, w + 14]]} color={SEL} lineWidth={1} dashed dashSize={4} gapSize={3} depthTest={false} renderOrder={9} transparent opacity={0.75} />
      <mesh renderOrder={11} raycast={() => null}><sphereGeometry args={[2.1, 16, 12]} /><meshBasicMaterial color={SEL} depthTest={false} /></mesh>
      <Html position={[0, 0, -w - 20]} center zIndexRange={[20, 30]} style={{ pointerEvents: 'none' }}>
        <span title="Positive direction along the joint" style={{ fontFamily: UI_FONT, fontSize: 9, fontWeight: 700, color: SEL, whiteSpace: 'nowrap', textShadow: '0 0 2px #fff, 0 0 2px #fff' }}>along +</span>
      </Html>
      {(['bFace', 'bEdge', 'aFace'] as ConnSurface[]).map(s => (
        <SurfacePlane key={s} surface={s} tB={tB} active={s === active} interactive={tool} onMove={move} onLeave={() => setHover(null)} onClick={click} />
      ))}
      {conn.holes.map(h => {
        const sp = connSurfacePoint(h.surface, h.along, h.across, tB);
        const at = { center: sp.pos, dir: [-sp.normal[0], -sp.normal[1], -sp.normal[2]] as Vec3, radius: h.diameter / 2, depth: Math.min(h.depth, connSurfaceDepth(h.surface, tA, tB)) };
        return <HoleGlyph key={h.id} at={at} selected={sel === h.id} onClick={() => { if (!tool) onSel(h.id); }} />;
      })}
      {conn.ops.map(op => <OpGlyph key={op.id} op={op} tB={tB} selected={sel === op.id} faint={false} onClick={() => { if (!tool) onSel(op.id); }} />)}
      {conn.parts.map(p => <ConnPartMesh key={p.id} part={p} tB={tB} color={layers.find(l => l.id === p.layerId)?.color ?? LAYER_DEFAULT_COLOR} selected={sel === p.id} pickable={!tool}
        onClick={() => onSel(p.id)} />)}
      {tool && hover && <SurfaceHover surface={active} at={hover} tB={tB} radius={mode === 'hole' ? holeRadius : 5} acrossLabel={acrossLabel} />}
    </>
  );
}
/** Bağlayıcı sahnesi: sol üstte yüzey seçimi, sağ üstte Hole kipi; sol sürükle döndür · sağ sürükle kaydır · tekerlek yaklaş. */
function JointPreview({ conn, tA, tB, active, onActive, mode, onMode, holeRadius, sel, onSel, onAddHole, onPlace, layers }: {
  conn: Connector; tA: number; tB: number; active: ConnSurface; onActive: (s: ConnSurface) => void; mode: ConnMode; onMode: (m: ConnMode) => void; holeRadius: number;
  sel: string | null; onSel: (id: string | null) => void; onAddHole: (along: number, across: number) => void; onPlace: (along: number, across: number) => void; layers: AccessoryLayer[];
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const onWheel = (e: WheelEvent) => e.preventDefault();
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const R = JOINT_R;
  return (
    <div ref={box} onContextMenu={e => e.preventDefault()} className="relative w-full rounded-[9px] overflow-hidden ring-1 ring-[#e3ddd4]"
      style={{ height: PREVIEW_H, background: 'linear-gradient(180deg,#fbfaf7 0%,#f2eee7 100%)', overscrollBehavior: 'contain' }}>
      <Canvas flat dpr={[1, 2]} shadows camera={{ position: [R * 2.6, R * 2.6, R * 3], fov: 26, near: 1, far: 8000 }} gl={{ antialias: true, alpha: true }} style={{ touchAction: 'none' }}
        onPointerMissed={() => { if (mode === 'none') onSel(null); }}>
        <JointCamera surface={active} />
        <hemisphereLight args={['#ffffff', '#efe6d6', 1.9]} />
        <directionalLight position={[R * 1.4, R * 2.4, R * 1.1]} intensity={0.9} castShadow shadow-mapSize={[1024, 1024]}
          shadow-camera-left={-R * 2} shadow-camera-right={R * 2} shadow-camera-top={R * 2} shadow-camera-bottom={-R * 2} shadow-camera-near={0.5} shadow-camera-far={R * 8} shadow-bias={-0.0004} />
        <directionalLight position={[-R * 2, R * 1.1, -R * 1.6]} intensity={0.5} />
        <directionalLight position={[-R * 1.2, R * 0.8, R * 2.2]} intensity={0.35} />
        <JointScene conn={conn} tA={tA} tB={tB} active={active} mode={mode} holeRadius={holeRadius} sel={sel} onSel={onSel} onAddHole={onAddHole} onPlace={onPlace} layers={layers} />
        <OrbitControls makeDefault enablePan screenSpacePanning panSpeed={0.9} enableDamping dampingFactor={0.12} minDistance={R * 1.2} maxDistance={R * 12}
          mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }} />
      </Canvas>
      {/* Sol üst: etkin yüzey (delik / model / operasyon buraya eklenir; kamera ona döner) */}
      <div className="absolute left-2 top-2 flex items-center gap-1" style={{ fontFamily: UI_FONT }}>
        {CONN_SURFACES.map(s => (
          <button key={s.v} type="button" title={`${s.label} — ${s.hint}`} onClick={e => { stop(e); onActive(s.v); }} className={PREVIEW_TOOL(active === s.v)}>{s.short}</button>
        ))}
      </div>
      <div className="absolute right-2 top-2 flex items-center gap-1" style={{ fontFamily: UI_FONT }}>
        <button type="button" title={mode === 'hole' ? 'Hole mode — click the highlighted surface; Esc to leave' : 'Add holes by clicking the highlighted surface'}
          onClick={e => { stop(e); onMode(mode === 'hole' ? 'none' : 'hole'); }} className={PREVIEW_TOOL(mode === 'hole')}>
          <Drill size={12} strokeWidth={2.1} />{mode === 'hole' ? 'Click the surface' : 'Hole'}
        </button>
      </div>
      {mode === 'place' && (
        <div className="absolute left-1/2 -translate-x-1/2 top-10 h-[22px] px-2.5 rounded-full bg-[#292524] text-white text-[10.5px] font-semibold flex items-center" style={{ fontFamily: UI_FONT }}>
          Click the highlighted surface to place the model · Esc
        </div>
      )}
      <div className="absolute left-2.5 bottom-2 flex items-center gap-1.5" style={HUD}>
        <span className="font-semibold text-stone-500">A {fmt1(tA)}</span><span>·</span><span className="font-semibold text-stone-500">B {fmt1(tB)}</span><span>·</span>
        <span>{conn.holes.length} hole{conn.holes.length === 1 ? '' : 's'}</span><span>·</span>
        <span>{conn.ops.length} operation{conn.ops.length === 1 ? '' : 's'}</span><span>·</span><span>{conn.parts.length} model{conn.parts.length === 1 ? '' : 's'}</span>
      </div>
    </div>
  );
}

/* ───────── 2B ÇİZİM ALANI (operasyon) ─────────
   Seçilen yüzeyin düz görünümü: x = birleşim boyunca (along), y = across (yukarı). Araçlar: Select · Line · Polyline · Rectangle · Circle.
   Yakalama: uç · orta · merkez · yüzey köşeleri · delik merkezleri · 0 noktası, yoksa 0,5 mm ızgara; Shift = dik. Değer kutusu: "x,y" mutlak,
   "@dx,dy" göreli, tek sayı = boy / yarıçap (dikdörtgende "en,boy"), "c" = polyline'ı kapat. Tekerlek yaklaştırır, sağ sürükle kaydırır. */
type SkTool = 'select' | 'line' | 'pline' | 'rect' | 'circle';
type P2 = { x: number; y: number };
type SnapMark = 'end' | 'mid' | 'center' | 'origin' | null;
const SK_TOOLS: Array<{ key: SkTool; label: string; Icon: typeof Minus; title: string }> = [
  { key: 'select', label: 'Select', Icon: MousePointer2, title: 'Select a shape (Delete removes it)' },
  { key: 'line', label: 'Line', Icon: Minus, title: 'Line: two points' },
  { key: 'pline', label: 'Poly', Icon: Spline, title: 'Polyline: click points · click the first point or type c to close · Enter / right-click to finish open' },
  { key: 'rect', label: 'Rect', Icon: Square, title: 'Rectangle: two opposite corners (or type width,height after the first corner)' },
  { key: 'circle', label: 'Circle', Icon: CircleIcon, title: 'Circle: centre, then a point on it (or type the radius)' },
];
const dist2 = (a: P2, b: P2) => Math.hypot(a.x - b.x, a.y - b.y);
const half = (v: number) => Math.round(v * 2) / 2;
/** Nesnenin yakalama noktaları. */
function shapeSnapPoints(s: ConnShape): Array<{ p: P2; kind: Exclude<SnapMark, null> }> {
  if (s.t === 'line') return [{ p: s.a, kind: 'end' }, { p: s.b, kind: 'end' }, { p: { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 }, kind: 'mid' }];
  if (s.t === 'circle') return [{ p: s.c, kind: 'center' }, ...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => ({ p: { x: s.c.x + dx * s.r, y: s.c.y + dy * s.r }, kind: 'end' as const }))];
  const out: Array<{ p: P2; kind: Exclude<SnapMark, null> }> = s.v.map(p => ({ p, kind: 'end' as const }));
  const n = s.v.length, segs = s.closed ? n : n - 1;
  for (let i = 0; i < segs; i++) { const a = s.v[i], b = s.v[(i + 1) % n]; out.push({ p: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, kind: 'mid' }); }
  return out;
}
/** Noktanın nesneye uzaklığı (mm) — seçim için. */
function distToShape(s: ConnShape, q: P2): number {
  if (s.t === 'circle') return Math.abs(dist2(s.c, q) - s.r);
  const pts = connShapePoints(s);
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2));
    best = Math.min(best, Math.hypot(q.x - (a.x + dx * t), q.y - (a.y + dy * t)));
  }
  return best;
}
function SketchPad({ op, conn, tB, onShapes, onDone }: { op: ConnOp; conn: Connector; tB: number; onShapes: (shapes: ConnShape[]) => void; onDone: () => void }) {
  const box = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const [size, setSize] = useState({ w: 480, h: PREVIEW_H });
  const ext = useMemo(() => connSurfaceExtent(op.surface, tB), [op.surface, tB]);
  const fitView = (s = size) => {
    const k = Math.min((s.w - 70) / (ext.x1 - ext.x0), (s.h - 110) / (ext.y1 - ext.y0));
    return { cx: (ext.x0 + ext.x1) / 2, cy: (ext.y0 + ext.y1) / 2, k: Math.max(0.4, Math.min(14, k)) };
  };
  const [view, setView] = useState(() => fitView());
  const [tool, setTool] = useState<SkTool>('line');
  const [pts, setPts] = useState<P2[]>([]);
  const [cursor, setCursor] = useState<{ p: P2; mark: SnapMark } | null>(null);
  const [selIdx, setSelIdx] = useState<number | null>(null);
  const [typed, setTyped] = useState('');
  const [snapOn, setSnapOn] = useState(true);
  const st = useRef({ view, size, pts, tool, cursor, selIdx, shapes: op.shapes });
  st.current = { view, size, pts, tool, cursor, selIdx, shapes: op.shapes };
  const pan = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  // Boyut ölçülür; yüzey değişince / ilk ölçümde görünüm yüzeye oturur.
  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    const read = () => { const r = el.getBoundingClientRect(); if (r.width > 10) setSize(s => (Math.abs(s.w - r.width) > 0.5 ? { w: r.width, h: PREVIEW_H } : s)); };
    read();
    const ro = new ResizeObserver(read); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { setView(fitView(size)); }, [op.surface, tB, size.w]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setPts([]); setSelIdx(null); setTyped(''); }, [op.id, tool]);
  // B yüzünde birleşim ÜSTTE, across aşağı doğru artar (3B görünüşte de birleşim uzakta); öteki yüzeylerde across yukarı.
  const ySign = op.surface === 'bFace' ? 1 : -1;
  const S = (p: P2) => ({ x: size.w / 2 + (p.x - view.cx) * view.k, y: size.h / 2 + ySign * (p.y - view.cy) * view.k });
  const toModel = (sx: number, sy: number, v = st.current.view, s = st.current.size): P2 => ({ x: v.cx + (sx - s.w / 2) / v.k, y: v.cy + ySign * (sy - s.h / 2) / v.k });
  // Yakalama adayları: bu operasyonun ve yüzeydeki öteki operasyonların nesneleri, delik merkezleri, yüzey köşeleri / kenar ortaları, 0.
  const snapPts = useMemo(() => {
    const out: Array<{ p: P2; kind: Exclude<SnapMark, null> }> = [{ p: { x: 0, y: 0 }, kind: 'origin' }];
    for (const o of conn.ops) if (o.surface === op.surface) for (const s of o.shapes) out.push(...shapeSnapPoints(s));
    for (const h of conn.holes) if (h.surface === op.surface) out.push({ p: { x: h.along, y: h.across }, kind: 'center' });
    const { x0, x1, y0, y1 } = ext, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) out.push({ p: { x, y }, kind: 'end' });
    for (const [x, y] of [[mx, y0], [mx, y1], [x0, my], [x1, my]]) out.push({ p: { x, y }, kind: 'mid' });
    return out;
  }, [conn.ops, conn.holes, op.surface, ext]);
  const resolve = (raw: P2, shift: boolean): { p: P2; mark: SnapMark } => {
    const { view: v, pts: cur } = st.current, last = cur[cur.length - 1];
    if (snapOn) {
      let best: { p: P2; kind: Exclude<SnapMark, null> } | null = null, bd = 9 / v.k;
      for (const c of snapPts) { const d = dist2(c.p, raw); if (d < bd) { bd = d; best = c; } }
      if (best) return { p: best.p, mark: best.kind };
    }
    let p = { x: half(raw.x), y: half(raw.y) };
    if (shift && last) p = Math.abs(raw.x - last.x) >= Math.abs(raw.y - last.y) ? { x: p.x, y: last.y } : { x: last.x, y: p.y };
    return { p, mark: null };
  };
  const add = (s: ConnShape) => onShapes([...st.current.shapes, s]);
  const finishPline = (closed: boolean) => {
    const cur = st.current.pts;
    if (cur.length >= (closed ? 3 : 2)) add({ t: 'pline', v: cur, closed: closed || undefined });
    setPts([]);
  };
  /** Bir nokta girildi (tık ya da yazılan değer). */
  const feed = (p: P2) => {
    const { tool: t, pts: cur } = st.current;
    if (t === 'select') return;
    if (!cur.length) { setPts([p]); return; }
    const a = cur[0];
    if (t === 'line') { if (dist2(a, p) > 1e-6) add({ t: 'line', a, b: p }); setPts([]); }
    else if (t === 'rect') { if (Math.abs(p.x - a.x) > 1e-6 && Math.abs(p.y - a.y) > 1e-6) add({ t: 'pline', closed: true, v: [a, { x: p.x, y: a.y }, p, { x: a.x, y: p.y }] }); setPts([]); }
    else if (t === 'circle') { const r = dist2(a, p); if (r > 1e-6) add({ t: 'circle', c: a, r: round1(r) }); setPts([]); }
    else if (cur.length >= 2 && dist2(a, p) < 1e-6) finishPline(true);
    else if (dist2(cur[cur.length - 1], p) > 1e-6) setPts([...cur, p]);
  };
  /** Değer kutusu: "x,y" · "@dx,dy" · tek sayı (boy / yarıçap) · "c". */
  const applyTyped = () => {
    const text = typed.trim().toLowerCase(); setTyped('');
    const { tool: t, pts: cur, cursor: c } = st.current, last = cur[cur.length - 1];
    if (!text) { if (t === 'pline' && cur.length) finishPline(false); return; }
    if (text === 'c') { if (t === 'pline') finishPline(true); return; }
    const rel = text.startsWith('@'), nums = text.replace('@', '').split(/[,;\s]+/).filter(Boolean).map(v => parseFloat(v.replace(',', '.')));
    if (nums.some(v => !Number.isFinite(v))) return;
    if (nums.length >= 2) {
      const relative = rel || (t === 'rect' && !!last);
      feed(relative && last ? { x: last.x + nums[0], y: last.y + nums[1] } : { x: nums[0], y: nums[1] });
    } else if (nums.length === 1 && last) {
      if (t === 'circle') { feed({ x: last.x + nums[0], y: last.y }); return; }
      const d = c ? { x: c.p.x - last.x, y: c.p.y - last.y } : { x: 1, y: 0 }, l = Math.hypot(d.x, d.y) || 1;
      feed({ x: round1(last.x + (d.x / l) * nums[0]), y: round1(last.y + (d.y / l) * nums[0]) });
    }
  };
  const typedRef = useRef(applyTyped); typedRef.current = applyTyped;
  const ySignRef = useRef(ySign); ySignRef.current = ySign;
  const local = (e: { clientX: number; clientY: number }) => { const r = box.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const onMove = (e: React.PointerEvent) => {
    const l = local(e);
    if (pan.current) {
      const dx = l.x - pan.current.x, dy = l.y - pan.current.y;
      if (Math.hypot(dx, dy) > 3) pan.current.moved = true;
      setView(v => ({ ...v, cx: pan.current!.cx - dx / v.k, cy: pan.current!.cy - ySign * dy / v.k }));
      return;
    }
    setCursor(resolve(toModel(l.x, l.y), e.shiftKey));
  };
  const onDown = (e: React.PointerEvent) => {
    const l = local(e);
    if (e.button === 2 || e.button === 1) { pan.current = { x: l.x, y: l.y, cx: view.cx, cy: view.cy, moved: false }; (e.currentTarget as Element).setPointerCapture(e.pointerId); return; }
    if (e.button !== 0) return;
    const hit = resolve(toModel(l.x, l.y), e.shiftKey);
    if (tool === 'select') {
      const raw = toModel(l.x, l.y);
      let best: number | null = null, bd = 7 / view.k;
      op.shapes.forEach((s, i) => { const d = distToShape(s, raw); if (d < bd) { bd = d; best = i; } });
      setSelIdx(best);
    } else feed(hit.p);
  };
  const onUp = (e: React.PointerEvent) => {
    const p = pan.current; if (!p) return;
    pan.current = null;
    // Sürüklemeden sağ tık: polyline'ı bitirir / başlanmış nesneyi iptal eder
    if (!p.moved && e.button === 2) { if (tool === 'pline' && pts.length >= 2) finishPline(false); else setPts([]); }
  };
  // Tekerlek: imlecin altındaki nokta sabit kalarak yaklaş (kenar çubuğu kaymaz)
  useEffect(() => {
    const el = box.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top, { view: v, size: s } = st.current;
      const k = Math.max(0.3, Math.min(60, v.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15))), m = toModel(sx, sy, v, s);
      setView({ k, cx: m.x - (sx - s.w / 2) / k, cy: m.y - ySignRef.current * (sy - s.h / 2) / k });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const removeSel = () => { const i = st.current.selIdx; if (i == null) return; onShapes(st.current.shapes.filter((_, k) => k !== i)); setSelIdx(null); };
  const escape = () => { if (st.current.pts.length) setPts([]); else if (st.current.tool !== 'select') setTool('select'); else onDone(); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null, inOwn = el === input.current, tag = (el?.tagName ?? '').toLowerCase();
      if (!inOwn && (tag === 'input' || tag === 'select' || tag === 'textarea')) return;
      if (e.key === 'Escape') { e.preventDefault(); escape(); }
      else if ((e.key === 'Delete' || (e.key === 'Backspace' && !(inOwn && input.current!.value))) && st.current.selIdx != null) { e.preventDefault(); removeSel(); }
      // Odak kutuda değilken: değer karakteri kutuya gider, Enter kutudaki değeri uygular (ya da polyline'ı bitirir)
      else if (!inOwn && !e.ctrlKey && !e.metaKey && /^[0-9@.,\-c]$/i.test(e.key)) input.current?.focus({ preventScroll: true });
      else if (!inOwn && e.key === 'Enter') { e.preventDefault(); typedRef.current(); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // ── çizim ──
  const path = (s: ConnShape) => { const p = connShapePoints(s).map(S); return p.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(' ') + (connShapeClosed(s) ? ' Z' : ''); };
  const ca = S({ x: ext.x0, y: ext.y0 }), cb = S({ x: ext.x1, y: ext.y1 }), o = S({ x: 0, y: 0 });
  const r0 = { x: Math.min(ca.x, cb.x), y: Math.min(ca.y, cb.y) }, r1 = { x: Math.max(ca.x, cb.x), y: Math.max(ca.y, cb.y) };   // ekranda sol-üst / sağ-alt
  const grid = useMemo(() => {
    const step = view.k * 10 >= 9 ? 10 : 50, xs: number[] = [], ys: number[] = [];
    for (let x = Math.ceil(ext.x0 / step) * step; x <= ext.x1 + 1e-6; x += step) xs.push(x);
    for (let y = Math.ceil(ext.y0 / step) * step; y <= ext.y1 + 1e-6; y += step) ys.push(y);
    return { xs, ys };
  }, [view.k, ext]);
  const last = pts[pts.length - 1], cur = cursor?.p;
  const rubber = (() => {
    if (!last || !cur) return null;
    const a = S(pts[0]), b = S(cur), common = { fill: 'none', stroke: SEL, strokeWidth: 1.3, strokeDasharray: '5 3' } as const;
    if (tool === 'rect') return <rect x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} {...common} />;
    if (tool === 'circle') return <circle cx={a.x} cy={a.y} r={dist2(pts[0], cur) * view.k} {...common} />;
    const l = S(last);
    return <><polyline points={[...pts.map(S), b].map(q => `${q.x},${q.y}`).join(' ')} {...common} strokeDasharray={undefined} opacity={tool === 'pline' ? 1 : 0} /><line x1={l.x} y1={l.y} x2={b.x} y2={b.y} {...common} /></>;
  })();
  const readout = !last || !cur ? null : tool === 'rect' ? `${fmt1(Math.abs(cur.x - pts[0].x))} × ${fmt1(Math.abs(cur.y - pts[0].y))}`
    : tool === 'circle' ? `R ${fmt1(dist2(pts[0], cur))}` : `${fmt1(dist2(last, cur))} mm`;
  const placeholder = tool === 'select' ? 'select a shape' : !last ? 'x,y' : tool === 'rect' ? 'width,height' : tool === 'circle' ? 'radius' : tool === 'pline' ? 'length · @dx,dy · c' : 'length · @dx,dy';
  const sc = cur ? S(cur) : null;
  const strip = op.surface === 'aFace' ? { a: S({ x: ext.x0, y: tB / 2 }), b: S({ x: ext.x1, y: -tB / 2 }) } : null;   // aFace'te y yukarı: a sol-üst
  const surfaceName = CONN_SURFACES.find(s => s.v === op.surface)!;
  return (
    <div ref={box} onContextMenu={e => e.preventDefault()} className="relative w-full rounded-[9px] overflow-hidden ring-1 ring-[#e3ddd4] select-none"
      style={{ height: PREVIEW_H, background: '#faf8f5', overscrollBehavior: 'contain', cursor: tool === 'select' ? 'default' : 'crosshair', touchAction: 'none' }}
      onPointerMove={onMove} onPointerDown={onDown} onPointerUp={onUp} onPointerLeave={() => setCursor(null)}
      onClick={() => input.current?.focus({ preventScroll: true })}>
      <svg width={size.w} height={size.h} className="absolute inset-0 block" style={{ fontFamily: UI_FONT }}>
        <defs>
          <clipPath id={`sk-clip-${op.id}`}><rect x={r0.x} y={r0.y} width={r1.x - r0.x} height={r1.y - r0.y} /></clipPath>
          <pattern id={`sk-hatch-${op.id}`} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1={0} y1={0} x2={0} y2={6} stroke="#d9cfbf" strokeWidth={1.2} /></pattern>
        </defs>
        <rect x={r0.x} y={r0.y} width={r1.x - r0.x} height={r1.y - r0.y} fill="#f0ebe3" stroke={PT.stroke} strokeWidth={1} />
        <g clipPath={`url(#sk-clip-${op.id})`}>
          {grid.xs.map(x => <line key={`x${x}`} x1={S({ x, y: 0 }).x} x2={S({ x, y: 0 }).x} y1={r0.y} y2={r1.y} stroke={x % 50 === 0 ? '#ddd5c9' : '#e8e2d8'} strokeWidth={0.7} />)}
          {grid.ys.map(y => <line key={`y${y}`} y1={S({ x: 0, y }).y} y2={S({ x: 0, y }).y} x1={r0.x} x2={r1.x} stroke={y % 50 === 0 ? '#ddd5c9' : '#e8e2d8'} strokeWidth={0.7} />)}
          {strip && <rect x={strip.a.x} y={strip.a.y} width={strip.b.x - strip.a.x} height={strip.b.y - strip.a.y} fill={`url(#sk-hatch-${op.id})`} stroke="#c9bda9" strokeWidth={0.8} strokeDasharray="4 3" />}
        </g>
        {/* Birleşim: B yüzünde alt kenar (A paneli oradadır); öteki yüzeylerde B kalınlığının ortası */}
        {op.surface === 'bFace'
          ? <><line x1={r0.x} x2={r1.x} y1={o.y} y2={o.y} stroke="#292524" strokeWidth={2.4} />
            <text x={r1.x} y={r0.y - 7} textAnchor="end" fontSize={8} fontWeight={700} fill={PT.ink} style={{ letterSpacing: '0.08em' }}>JOINT · PANEL A</text></>
          : <line x1={r0.x} x2={r1.x} y1={o.y} y2={o.y} stroke={PT.ghost} strokeWidth={0.8} strokeDasharray="6 3 1 3" />}
        {strip && <text x={strip.a.x + 4} y={strip.a.y - 4} fontSize={8} fontWeight={700} fill="#a8997f" style={{ letterSpacing: '0.08em' }}>PANEL B LANDS HERE</text>}
        <line x1={o.x} x2={o.x} y1={r0.y} y2={r1.y} stroke={PT.ghost} strokeWidth={0.8} strokeDasharray="6 3 1 3" />
        {/* Öteki operasyonlar + delikler (soluk) */}
        {conn.ops.filter(x => x.id !== op.id && x.surface === op.surface).map(x => x.shapes.map((s, i) => <path key={`${x.id}-${i}`} d={path(s)} fill="none" stroke="#b8b0a4" strokeWidth={1} />))}
        {conn.holes.filter(h => h.surface === op.surface).map(h => { const c = S({ x: h.along, y: h.across }); return <circle key={h.id} cx={c.x} cy={c.y} r={Math.max(2, (h.diameter / 2) * view.k)} fill="#fff" stroke="#b8b0a4" strokeWidth={1} strokeDasharray="3 2" />; })}
        {/* Bu operasyon */}
        {op.shapes.map((s, i) => {
          const on = selIdx === i, closed = connShapeClosed(s);
          return <g key={i}>
            {op.type === 'line' && op.width > 0 && <path d={path(s)} fill="none" stroke={on ? SEL : '#3f3a35'} strokeOpacity={0.16} strokeWidth={Math.max(1.5, op.width * view.k)} strokeLinecap="round" strokeLinejoin="round" />}
            <path d={path(s)} fill={op.type === 'pocket' && closed ? (on ? 'rgba(234,88,12,0.18)' : 'rgba(41,37,36,0.12)') : 'none'} stroke={on ? SEL : '#292524'} strokeWidth={on ? 2 : 1.5}
              strokeDasharray={op.type === 'pocket' && !closed ? '5 3' : undefined} strokeLinejoin="round" />
          </g>;
        })}
        {rubber}
        {pts.map((p, i) => { const q = S(p); return <rect key={i} x={q.x - 2.5} y={q.y - 2.5} width={5} height={5} fill="#fff" stroke={SEL} strokeWidth={1.2} />; })}
        {/* 0 noktası */}
        <circle cx={o.x} cy={o.y} r={3} fill={SEL} /><text x={o.x + 6} y={o.y - 5} fontSize={8.5} fontWeight={700} fill={SEL}>0</text>
        <text x={r1.x} y={r1.y + 13} textAnchor="end" fontSize={8} fontWeight={600} fill={PT.mute} style={{ letterSpacing: '0.08em' }}>ALONG THE JOINT →</text>
        <text x={r0.x} y={r1.y + 13} fontSize={8} fontWeight={600} fill={PT.mute} style={{ letterSpacing: '0.08em' }}>{ySign > 0 ? '↓' : '↑'} {surfaceName.across.toUpperCase()}</text>
        {sc && tool !== 'select' && <g pointerEvents="none">
          <line x1={sc.x - 9} x2={sc.x + 9} y1={sc.y} y2={sc.y} stroke={SEL} strokeWidth={1} /><line x1={sc.x} x2={sc.x} y1={sc.y - 9} y2={sc.y + 9} stroke={SEL} strokeWidth={1} />
          {cursor?.mark === 'end' && <rect x={sc.x - 4.5} y={sc.y - 4.5} width={9} height={9} fill="none" stroke={SEL} strokeWidth={1.6} />}
          {cursor?.mark === 'mid' && <path d={`M${sc.x} ${sc.y - 5.5} L${sc.x + 5.5} ${sc.y + 4.5} L${sc.x - 5.5} ${sc.y + 4.5} Z`} fill="none" stroke={SEL} strokeWidth={1.6} />}
          {(cursor?.mark === 'center' || cursor?.mark === 'origin') && <circle cx={sc.x} cy={sc.y} r={5} fill="none" stroke={SEL} strokeWidth={1.6} />}
          {readout && <g><rect x={sc.x + 12} y={sc.y + 10} width={readout.length * 5.8 + 12} height={17} rx={5} fill="#292524" />
            <text x={sc.x + 18} y={sc.y + 22} fontSize={10} fontWeight={600} fill="#fff" style={{ fontVariantNumeric: 'tabular-nums' }}>{readout}</text></g>}
        </g>}
      </svg>
      <div className="absolute left-2 top-2 flex items-center gap-1" style={{ fontFamily: UI_FONT }} onPointerDown={stop} onPointerUp={stop}>
        {SK_TOOLS.map(t => (
          <button key={t.key} type="button" title={t.title} onClick={e => { stop(e); setTool(t.key); }} className={PREVIEW_TOOL(tool === t.key)}><t.Icon size={12} strokeWidth={2.1} />{t.label}</button>
        ))}
      </div>
      <div className="absolute right-2 top-2 flex items-center gap-1" style={{ fontFamily: UI_FONT }} onPointerDown={stop} onPointerUp={stop}>
        <button type="button" title={snapOn ? 'Snap on: ends · middles · centres · corners · hole centres · 0 (off = 0.5 mm grid only)' : 'Snap off — 0.5 mm grid only'}
          onClick={e => { stop(e); setSnapOn(v => !v); }} className={PREVIEW_TOOL(snapOn)}><Magnet size={12} strokeWidth={2.1} />Snap</button>
        <button type="button" title="Fit the surface in the view" onClick={e => { stop(e); setView(fitView()); }} className={PREVIEW_TOOL(false)}><Maximize2 size={12} strokeWidth={2.1} /></button>
        <button type="button" title="Finish drawing and go back to the 3D view" onClick={e => { stop(e); onDone(); }}
          className="h-[24px] px-2.5 flex items-center gap-1.5 rounded-[6px] text-[10.5px] font-semibold bg-orange-600 text-white hover:bg-orange-700 transition-colors"><Check size={12} strokeWidth={2.4} />Done</button>
      </div>
      <div className="absolute left-2 bottom-2 flex items-center gap-1.5" style={{ fontFamily: UI_FONT }} onPointerDown={stop} onPointerUp={stop}>
        <div className="yago-cell h-[24px] w-[150px] px-2 flex items-center">
          <input ref={input} type="text" value={typed} placeholder={placeholder} spellCheck={false} onChange={e => setTyped(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); applyTyped(); } }}
            className="yago-field yago-field-text" style={{ ...TEXT_INPUT, fontSize: 11.5 }} title="Type a value and press Enter: x,y (absolute) · @dx,dy (relative) · a single number = length / radius · c = close the polyline" />
        </div>
        <span style={HUD}>{cur ? `X ${fmt1(cur.x)} · Y ${fmt1(cur.y)}` : 'X — · Y —'}</span>
      </div>
      <div className="absolute right-2.5 bottom-2 flex items-center gap-1.5" style={HUD}>
        <span className="font-semibold text-stone-500">{op.type === 'pocket' ? 'Pocket' : 'Line'}</span><span>·</span><span>{surfaceName.short}</span><span>·</span><span>{connOpSummary(op)}</span>
        {selIdx != null && <button type="button" onPointerDown={stop} onClick={e => { stop(e); removeSel(); }} title="Delete the selected shape (Delete)"
          className="pointer-events-auto ml-1 h-[20px] px-1.5 rounded-[5px] bg-white ring-1 ring-[#e3ddd4] text-[10px] font-semibold text-red-600 hover:bg-red-50 flex items-center gap-1"><Trash2 size={10} strokeWidth={2} />Delete</button>}
      </div>
    </div>
  );
}

/* ───────── Satırlar ───────── */
const SURF_OPTS = CONN_SURFACES.map(s => ({ v: s.v, label: s.short }));
const OP_TYPE_OPTS: Array<{ v: ConnOpType; label: string }> = [{ v: 'pocket', label: 'Pocket' }, { v: 'line', label: 'Line' }];
const ROW_SHELL = (selected: boolean) => `relative h-[30px] pl-2 pr-1 flex items-center gap-[5px] rounded-[8px] ring-1 cursor-pointer transition-colors duration-150
  ${selected ? 'bg-[#fbf9f6] ring-[#d4cdc3]' : 'bg-white ring-[#e6e1d9] hover:ring-[#cfc7bc]'}`;
const RowIndex = ({ n, selected }: { n: number; selected: boolean }) => <span className={`shrink-0 w-[14px] text-[11px] font-semibold tabular-nums ${selected ? 'text-stone-700' : 'text-stone-400'}`}>{n}</span>;
const RowTrash = ({ title, onClick }: { title: string; onClick: () => void }) => (
  <button type="button" title={title} onClick={e => { stop(e); onClick(); }}
    className="shrink-0 w-[22px] h-[22px] rounded-md flex items-center justify-center text-stone-400 hover:bg-red-50 hover:text-red-500 transition-colors"><Trash2 size={12} strokeWidth={2} /></button>
);
const ALONG_TIP = 'Along the joint line, from the connector point (mm)';
const acrossTip = (s: ConnSurface) => (s === 'bFace' ? 'Distance from the joint into panel B (mm)' : "Offset from the centre of panel B's thickness (mm)");
/** Delik: # · yüzey · along · across · Ø · derinlik · sil. Derinlik malzemeyi aşıyorsa "thru". */
function ConnHoleRow({ hole, index, selected, limit, onSelect, onChange, onRemove }: {
  hole: ConnHole; index: number; selected: boolean; limit: number; onSelect: () => void; onChange: (patch: Partial<ConnHole>) => void; onRemove: () => void;
}) {
  const num = (v: number, on: (v: number) => void, min = -100000, w = 48) => <QbNum value={v} min={min} w={w} onCommit={on} />;
  return (
    <div onClick={e => { stop(e); onSelect(); }} className={ROW_SHELL(selected)}>
      {selected && <span className={ROW_SEL_BAR} />}
      <RowIndex n={index + 1} selected={selected} />
      <span onClick={stop} title="Surface the hole is drilled from"><QbSelect value={hole.surface} options={SURF_OPTS} w={54} onChange={v => onChange({ surface: v })} /></span>
      <Mini label="Along" title={ALONG_TIP}>{num(hole.along, v => onChange({ along: v }))}</Mini>
      <Mini label={hole.surface === 'bFace' ? 'Joint' : 'Centre'} title={acrossTip(hole.surface)}>{num(hole.across, v => onChange({ across: v }))}</Mini>
      <span className="w-px h-3.5 bg-[#e6e0d6] shrink-0" />
      <Mini label="Ø" title="Diameter (mm)">{num(hole.diameter, v => onChange({ diameter: Math.max(0.2, v) }), 0.2, 36)}</Mini>
      <Mini label="D" title={`Depth from the surface (mm) — the material is ${fmt1(limit)} mm here`}>{num(hole.depth, v => onChange({ depth: Math.max(0.1, v) }), 0.1, 42)}</Mini>
      {hole.depth >= limit - 1e-6 && <span className="shrink-0 text-[9.5px] font-bold tracking-[0.05em] text-orange-600" title="Goes through the panel">THRU</span>}
      <span className="flex-1 min-w-0" />
      <RowTrash title="Remove this hole" onClick={onRemove} />
    </div>
  );
}
/** Operasyon: # · tip · yüzey · derinlik · (line) takım Ø · özet · çiz · sil. */
function ConnOpRow({ op, index, selected, drawing, onSelect, onChange, onDraw, onRemove }: {
  op: ConnOp; index: number; selected: boolean; drawing: boolean; onSelect: () => void; onChange: (patch: Partial<ConnOp>) => void; onDraw: () => void; onRemove: () => void;
}) {
  return (
    <div onClick={e => { stop(e); onSelect(); }} className={ROW_SHELL(selected || drawing)}>
      {(selected || drawing) && <span className={ROW_SEL_BAR} />}
      <RowIndex n={index + 1} selected={selected || drawing} />
      <span onClick={stop} title="Pocket = the inside of closed shapes is cleared to the depth · Line = the tool follows the drawn lines at the depth">
        <QbSelect value={op.type} options={OP_TYPE_OPTS} w={52} onChange={v => onChange({ type: v })} /></span>
      <span onClick={stop} title="Surface the operation is machined on"><QbSelect value={op.surface} options={SURF_OPTS} w={54} onChange={v => onChange({ surface: v })} /></span>
      <Mini label="Depth" title="Machining depth from the surface (mm)"><QbNum value={op.depth} min={0.1} w={36} onCommit={v => onChange({ depth: v })} /></Mini>
      {op.type === 'line' && <Mini label="Tool Ø" title="Cutter diameter — the width of the groove along the line (mm)"><QbNum value={op.width} min={0} w={32} onCommit={v => onChange({ width: v })} /></Mini>}
      <span className="flex-1 min-w-0 truncate text-[10.5px] text-stone-400 text-right">{connOpSummary(op)}</span>
      <button type="button" title={drawing ? 'Drawing — click to go back to the 3D view' : 'Draw / edit the shapes of this operation'} onClick={e => { stop(e); onDraw(); }}
        className={`shrink-0 h-[22px] px-1.5 rounded-md flex items-center gap-1 text-[10.5px] font-semibold transition-colors ${drawing ? 'bg-orange-600 text-white' : 'text-stone-500 hover:bg-[#ece7e0] hover:text-stone-900'}`}>
        <PenLine size={11} strokeWidth={2} />{drawing ? 'Drawing' : 'Draw'}</button>
      <RowTrash title="Remove this operation" onClick={onRemove} />
    </div>
  );
}
/** Model: başlık (katman rengi · ad · yüzey · yerleştir · sil) + iki sıra değer (along · across · gömme / dönüş · çevir · katman). */
function ConnPartRow({ part, selected, placing, layers, onSelect, onChange, onPlace, onRemove }: {
  part: ConnPart; selected: boolean; placing: boolean; layers: AccessoryLayer[]; onSelect: () => void; onChange: (patch: Partial<ConnPart>) => void; onPlace: () => void; onRemove: () => void;
}) {
  const { accessoryModels } = useStoreFields('accessoryModels');
  const m = accessoryModels.find(x => x.id === part.modelId), layer = layers.find(l => l.id === part.layerId);
  const num = (v: number, on: (v: number) => void, min = -100000) => <QbNum value={v} min={min} w={46} onCommit={on} />;
  return (
    <div className={rowCardClass(selected, false, false)} onClick={e => { stop(e); onSelect(); }}>
      <div className={`relative h-[32px] pl-2.5 pr-1 flex items-center gap-2 cursor-pointer ${selected ? ROW_SEL_HEAD : ''}`}>
        {selected && <span className={ROW_SEL_BAR} />}
        <Swatch color={layer?.color ?? LAYER_DEFAULT_COLOR} size={8} />
        <span className="flex-1 min-w-0 truncate text-[11.5px] font-medium text-stone-700" title={m ? (m.source ? `${m.source} → STL` : m.fileName) : 'Model missing'}>{m?.name ?? 'Missing model'}</span>
        {m && <span className={`shrink-0 ${MUTED}`}>{fmt1(m.size[0])} × {fmt1(m.size[1])} × {fmt1(m.size[2])}</span>}
        <span onClick={stop} title="Surface the model sits on"><QbSelect value={part.surface} options={SURF_OPTS} w={54} onChange={v => onChange({ surface: v })} /></span>
        <button type="button" title={placing ? 'Click the highlighted surface in the preview · Esc' : 'Place by clicking the surface in the preview'} onClick={e => { stop(e); onPlace(); }}
          className={`shrink-0 h-[22px] px-1.5 rounded-md flex items-center gap-1 text-[10.5px] font-semibold transition-colors ${placing ? 'bg-orange-600 text-white' : 'text-stone-500 hover:bg-[#ece7e0] hover:text-stone-900'}`}>
          <Crosshair size={11} strokeWidth={2} />Place</button>
        <RowTrash title="Remove this model" onClick={onRemove} />
      </div>
      {selected && (
        <div className={CARD_BODY} style={CARD_BODY_STYLE} onClick={stop}>
          <div className="grid grid-cols-12 gap-x-1" style={QB_CELL_ROW}>
            <EditCell className="col-span-4" label="Along" title={ALONG_TIP}>{num(part.along, v => onChange({ along: v }))}</EditCell>
            <EditCell className="col-span-4" label={part.surface === 'bFace' ? 'From joint' : 'From centre'} title={acrossTip(part.surface)}>{num(part.across, v => onChange({ across: v }))}</EditCell>
            <EditCell className="col-span-4" label="Sink" title="How far the model's base sits below the surface (mm) — e.g. the hole depth for a cam that sits in its hole">{num(part.inset, v => onChange({ inset: v }))}</EditCell>
            <EditCell className="col-span-3" label="Spin °" title="Rotation about the surface normal (degrees)">{num(part.spin, v => onChange({ spin: v }))}</EditCell>
            <EditCell className="col-span-3" label="Flip" title="Off: the model's up axis points out of the surface · On: into the material"><QbSwitch on={!!part.flip} onToggle={() => onChange({ flip: !part.flip })} /></EditCell>
            <EditCell className="col-span-6" label="Layer" title="Layer of this model — colour in the preview (Accessories › Layers)"><LayerSelect value={part.layerId} layers={layers} onChange={id => onChange({ layerId: id })} /></EditCell>
          </div>
        </div>
      )}
    </div>
  );
}
const ListHead = ({ label, count, hint, children }: { label: string; count: number; hint?: string; children?: React.ReactNode }) => (
  <div className="flex items-center gap-1.5 px-0.5 pt-1">
    <span style={SECTION_LABEL}>{label}</span>
    {count > 0 && <span className="text-[10px] font-semibold tabular-nums text-stone-400">{count}</span>}
    <span className="min-w-0 truncate text-[10px] text-stone-400">{hint}</span>
    <div className="flex-1" />
    {children}
  </div>
);

/** Bağlayıcı düzenleyici: üst blok (ad + sahne / çizim alanı) yapışık; altında örnek kalınlıklar, delikler, operasyonlar, modeller. */
function ConnectorEditor({ draft, setDraft, onSave, onCancel, layers }: {
  draft: Connector; setDraft: (c: Connector) => void; onSave: () => void; onCancel: () => void; layers: AccessoryLayer[];
}) {
  const { tA, tB } = connThickness(draft);
  const [active, setActive] = useState<ConnSurface>('bFace');
  const [mode, setMode] = useState<ConnMode>('none');
  const [placeId, setPlaceId] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [drawId, setDrawId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const ref = useRef({ draft, sel, drawId, active }); ref.current = { draft, sel, drawId, active };
  const patch = (p: Partial<Connector>) => setDraft({ ...ref.current.draft, ...p });
  const drawOp = draft.ops.find(o => o.id === drawId) ?? null;
  const removeSelected = () => {
    const { draft: d, sel: id } = ref.current; if (!id) return;
    setDraft({ ...d, holes: d.holes.filter(h => h.id !== id), ops: d.ops.filter(o => o.id !== id), parts: d.parts.filter(p => p.id !== id) });
    setSel(null);
  };
  // Esc araç kipinden çıkar; Delete (giriş alanı dışında, çizim alanı kapalıyken) seçili deliği / operasyonu / modeli siler
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (ref.current.drawId) return;   // çizim alanı kendi tuşlarını yönetir
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      if (e.key === 'Escape') { setMode('none'); setPlaceId(null); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && ref.current.sel && tag !== 'input' && tag !== 'select' && tag !== 'textarea') { e.preventDefault(); removeSelected(); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEscapeOwner('connector-tool', mode !== 'none' || !!drawId);
  const lastHole = draft.holes[draft.holes.length - 1];
  const holeDefaults = { diameter: lastHole?.diameter ?? 8, depth: lastHole?.depth ?? 12 };
  const addHole = (along: number, across: number) => {
    const h = newConnHole({ ...holeDefaults, depth: Math.min(holeDefaults.depth, connSurfaceDepth(active, tA, tB)), surface: active, along, across });
    patch({ holes: [...ref.current.draft.holes, h] }); setSel(h.id);
  };
  const changeHole = (id: string, p: Partial<ConnHole>) => patch({ holes: ref.current.draft.holes.map(h => (h.id === id ? { ...h, ...p } : h)) });
  const changeOp = (id: string, p: Partial<ConnOp>) => patch({ ops: ref.current.draft.ops.map(o => (o.id === id ? { ...o, ...p } : o)) });
  const changePart = (id: string, p: Partial<ConnPart>) => patch({ parts: ref.current.draft.parts.map(x => (x.id === id ? { ...x, ...p } : x)) });
  const addOp = (type: ConnOpType) => {
    const op = newConnOp(active, type, { depth: Math.min(5, connSurfaceDepth(active, tA, tB)) });
    patch({ ops: [...ref.current.draft.ops, op] }); setSel(op.id); setMode('none'); setPlaceId(null); setDrawId(op.id);
  };
  const placePart = (along: number, across: number) => {
    if (!placeId) return;
    changePart(placeId, { surface: active, along, across }); setSel(placeId); setMode('none'); setPlaceId(null);
  };
  const startPlace = (id: string) => {
    if (placeId === id && mode === 'place') { setMode('none'); setPlaceId(null); return; }
    const p = draft.parts.find(x => x.id === id); if (p) setActive(p.surface);
    setDrawId(null); setSel(id); setPlaceId(id); setMode('place');
  };
  const onFile = async (files: FileList | null) => {
    const f = files?.[0]; if (!f) return;
    setBusy(true); setError(null); setInfo(null);
    try {
      const m = await importAccessoryFile(f);
      setInfo(m.note ?? null);
      const part = newConnPart(m.id, { surface: ref.current.active });
      patch({ parts: [...ref.current.draft.parts, part] });
      setDrawId(null); setSel(part.id); setPlaceId(part.id); setMode('place');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  /** Satır seçimi: etkin yüzey o öğenin yüzeyine döner (sahne ona bakar). */
  const select = (id: string, surface: ConnSurface) => { setSel(s => (s === id ? null : id)); setActive(surface); };
  const empty = !draft.holes.length && !draft.ops.length && !draft.parts.length;
  return (
    <>
      <div className="sticky top-0 z-30 -mx-1.5 -mt-1.5 px-1.5 pt-1.5 pb-1.5 flex flex-col gap-1.5" onClick={stop}
        style={{ background: '#f8f6f2', boxShadow: '0 6px 10px -8px rgba(40,30,20,0.18)' }}>
        <div className="flex items-center gap-1.5">
          <div className="yago-cell flex-1 min-w-0 h-[28px] px-2 flex items-center">
            <input type="text" value={draft.name} placeholder="Connector" spellCheck={false} onChange={e => patch({ name: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter') onSave(); }} className="yago-field yago-field-text" style={TEXT_INPUT} />
          </div>
          <ApplyBtn enabled={!busy} onClick={onSave} title="Save" />
          <ExitBtn onClick={onCancel} />
        </div>
        {drawOp
          ? <SketchPad op={drawOp} conn={draft} tB={tB} onShapes={shapes => changeOp(drawOp.id, { shapes })} onDone={() => setDrawId(null)} />
          : <JointPreview conn={draft} tA={tA} tB={tB} active={active} onActive={s => { setActive(s); }} mode={mode} onMode={m => { setMode(m); setPlaceId(null); }}
            holeRadius={holeDefaults.diameter / 2} sel={sel} onSel={setSel} onAddHole={addHole} onPlace={placePart} layers={layers} />}
      </div>
      <QbSection title="Connector" sub={draft.name || undefined}>
        <div className="flex flex-col gap-1.5" onClick={stop}>
          <div className="grid grid-cols-2 gap-x-1" style={QB_CELL_ROW}>
            <EditCell label="Panel A thickness" title="Sample thickness of the passing panel — preview only; real panels use their own thickness"><QbNum value={tA} min={3} w={44} onCommit={v => patch({ tA: v })} /><Unit /></EditCell>
            <EditCell label="Panel B thickness" title="Sample thickness of the butting panel — preview only; real panels use their own thickness"><QbNum value={tB} min={3} w={44} onCommit={v => patch({ tB: v })} /><Unit /></EditCell>
          </div>
          {empty && <div className="yago-hint px-1">Panel B butts with its end against the face of panel A. Pick a surface on the preview (B face · B edge · A face), then add holes, drawn operations or a model to it.</div>}
          <div className="flex flex-col gap-1">
            <ListHead label="Holes" count={draft.holes.length} hint={mode === 'hole' ? 'click the highlighted surface · Esc' : draft.holes.length ? 'Delete removes the selected' : ''}>
              <CardAction compact icon={Drill} label={mode === 'hole' ? 'Done' : 'Add hole'} active={mode === 'hole'} tone="amber"
                title={mode === 'hole' ? 'Leave hole mode' : 'Add a hole: click the highlighted surface in the preview'} onClick={() => { setDrawId(null); setPlaceId(null); setMode(mode === 'hole' ? 'none' : 'hole'); }} />
            </ListHead>
            {draft.holes.map((h, i) => (
              <ConnHoleRow key={h.id} hole={h} index={i} selected={sel === h.id} limit={connSurfaceDepth(h.surface, tA, tB)} onSelect={() => select(h.id, h.surface)}
                onChange={p => { changeHole(h.id, p); if (p.surface) setActive(p.surface); }} onRemove={() => { patch({ holes: draft.holes.filter(x => x.id !== h.id) }); if (sel === h.id) setSel(null); }} />
            ))}
          </div>
          <div className="flex flex-col gap-1">
            <ListHead label="Operations" count={draft.ops.length} hint={drawOp ? 'drawing on the flat view above' : 'drawn on the active surface'}>
              <CardAction compact icon={BoxSelect} label="Pocket" title="New pocket on the active surface — draw closed shapes; their inside is cleared to the depth" onClick={() => addOp('pocket')} />
              <CardAction compact icon={Spline} label="Line" title="New line operation on the active surface — the tool follows the drawn lines at the depth" onClick={() => addOp('line')} />
            </ListHead>
            {draft.ops.map((o, i) => (
              <ConnOpRow key={o.id} op={o} index={i} selected={sel === o.id} drawing={drawId === o.id} onSelect={() => select(o.id, o.surface)}
                onChange={p => { changeOp(o.id, p); if (p.surface) setActive(p.surface); }} onDraw={() => { setMode('none'); setPlaceId(null); setSel(o.id); setActive(o.surface); setDrawId(d => (d === o.id ? null : o.id)); }}
                onRemove={() => { patch({ ops: draft.ops.filter(x => x.id !== o.id) }); if (sel === o.id) setSel(null); if (drawId === o.id) setDrawId(null); }} />
            ))}
          </div>
          <div className="flex flex-col gap-1">
            <ListHead label="Models" count={draft.parts.length} hint="placed like a hole — independent of the holes">
              <CardAction compact icon={Upload} label="Add model" title="Import the connector's 3D model (STL · OBJ · STEP · DWG …), then click the surface to place it" onClick={() => { setError(null); setInfo(null); fileRef.current?.click(); }} />
            </ListHead>
            {draft.parts.map(p => (
              <ConnPartRow key={p.id} part={p} selected={sel === p.id} placing={mode === 'place' && placeId === p.id} layers={layers} onSelect={() => select(p.id, p.surface)}
                onChange={x => { changePart(p.id, x); if (x.surface) setActive(x.surface); }} onPlace={() => startPlace(p.id)}
                onRemove={() => { patch({ parts: draft.parts.filter(x => x.id !== p.id) }); if (sel === p.id) setSel(null); if (placeId === p.id) { setPlaceId(null); setMode('none'); } }} />
            ))}
          </div>
          <input ref={fileRef} type="file" accept={ACCESSORY_ACCEPT} className="hidden" onChange={e => { void onFile(e.target.files); e.target.value = ''; }} />
          {(busy || error || info) && <div className={`px-1 text-[10.5px] ${busy ? 'text-stone-400' : error ? 'text-red-600' : 'text-stone-500'}`}>{busy ? 'Importing…' : error ?? info}</div>}
        </div>
      </QbSection>
    </>
  );
}
const connSummary = (c: Connector): string => {
  const part = (n: number, w: string) => (n ? `${n} ${w}${n === 1 ? '' : 's'}` : '');
  return [part(c.holes.length, 'hole'), part(c.ops.length, 'operation'), part(c.parts.length, 'model')].filter(Boolean).join(' · ') || 'empty';
};
/** Taslak üstte (AccessoriesPanel) tutulur: kategori değişip geri gelince (ör. katman eklemek için) düzenleme kaybolmaz. */
function ConnectorsPanel({ draft, setDraft, keepModels }: { draft: Connector | null; setDraft: (c: Connector | null) => void; /** açık ayak taslağının modelleri (silinmez) */ keepModels: string[] }) {
  const { connectors, accessoryLayers, connectorLayouts } = useStoreFields('connectors', 'accessoryLayers', 'connectorLayouts');
  const save = async () => {
    if (!draft) return;
    await saveConnector({ ...draft, name: draft.name.trim() || 'Connector' });
    setDraft(null);
    await pruneUnusedAccessoryModels(keepModels);
  };
  const cancel = async () => { setDraft(null); await pruneUnusedAccessoryModels(keepModels); };
  return (
    <div className="px-1.5 pt-1.5 pb-2 flex flex-col gap-1.5" style={{ fontFamily: UI_FONT }}>
      {draft ? <ConnectorEditor draft={draft} setDraft={setDraft} layers={accessoryLayers} onSave={() => void save()} onCancel={() => void cancel()} /> : (
        <QbSection title="Connectors" sub={connectors.length ? 'holes, drawn operations and a model on a two-panel joint' : undefined}
          trailing={<div className="flex items-center gap-1">
            <CardAction compact icon={FlaskConical} label="Sample" title="Add a ready-made cam connector to test with: Ø15 cam pocket on the panel face, Ø8 bolt bore in its edge, Ø5 hole in the other panel, with a cam + bolt model"
              onClick={() => void addSampleConnector(connectors.some(c => c.name === 'Connector 1') ? `Connector ${connectors.length + 1}` : 'Connector 1')} />
            <CardAction compact icon={Plus} label="New" title="New connector" onClick={() => setDraft(newConnector(`Connector ${connectors.length + 1}`))} />
          </div>}>
          {!connectors.length ? <div className="yago-hint px-1 py-0.5">None yet — a connector describes what is machined on two joined panels (holes, pockets, grooves) and its 3D model. Layouts decide where it sits along a joint; panel types decide which edges get a layout.</div> : (
            <div className="flex flex-col gap-1">
              {connectors.map(c => {
                const uses = connectorUseCount(c.id, connectorLayouts);
                return (
                  <div key={c.id} className={ROW}>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-stone-700">{c.name}</span>
                    <span className={`shrink-0 ${MUTED}`}>{connSummary(c)}</span>
                    <span className={`shrink-0 ${MUTED}`} title="Connector layouts that place this connector (Accessories › Layout)">· {uses ? `${uses} layout${uses === 1 ? '' : 's'}` : 'unused'}</span>
                    <button type="button" title="Edit" onClick={() => setDraft(cloneConnector(c))} className={ICON_BTN}><Pencil size={12} strokeWidth={1.9} /></button>
                    <button type="button" title={uses ? 'Delete — the layout rules that use it are left without a connector' : 'Delete'} onClick={() => void deleteConnector(c.id).then(() => pruneUnusedAccessoryModels(keepModels))} className={DEL_BTN}><Trash2 size={12} strokeWidth={1.9} /></button>
                  </div>
                );
              })}
            </div>
          )}
        </QbSection>
      )}
    </div>
  );
}

/* ═════════════════════════════════ Panel ═════════════════════════════════ */
const Empty = () => <div className="yago-hint px-1 py-0.5">None yet</div>;
export function AccessoriesPanel() {
  const { accessoryCategory, accessoryModels, legModels, legPresets, accessoryLayers } = useStoreFields('accessoryCategory', 'accessoryModels', 'legModels', 'legPresets', 'accessoryLayers');
  const [legDraft, setLegDraft] = useState<LegModel | null>(null);
  const [presetDraft, setPresetDraft] = useState<LegPreset | null>(null);
  const [connDraft, setConnDraft] = useState<Connector | null>(null);
  const [layoutDraft, setLayoutDraft] = useState<ConnectorLayoutSet | null>(null);
  const setCategory = useAppStore.getState().setAccessoryCategory;
  // Kaydedilmemiş taslakların modelleri budamada korunur (iki düzenleyici aynı anda açık olabilir).
  const connKeep = connDraft?.parts.map(p => p.modelId) ?? [], legKeep = legDraft?.parts.map(p => p.modelId) ?? [];
  const saveLeg = async () => {
    if (!legDraft || !legDraft.parts.length) return;
    await saveLegModel({ ...legDraft, name: legDraft.name.trim() || 'Leg' });
    setLegDraft(null);
    await pruneUnusedAccessoryModels(connKeep);   // değiştirilen yuvaların eski dosyaları (açık bağlayıcı taslağının modelleri kalır)
    syncPlinthSetsUsingPreset(null);      // Ø / model / delikler değişmiş olabilir: setleri kullanan gövdeler yeniden çözülür
  };
  const cancelLeg = async () => { setLegDraft(null); await pruneUnusedAccessoryModels(connKeep); };
  const savePreset = async () => {
    if (!presetDraft) return;
    await saveLegPreset({ ...presetDraft, name: presetDraft.name.trim() || 'Leg set' });
    setPresetDraft(null);
    syncPlinthSetsUsingPreset(presetDraft.id);   // Auto setler düzeni canlı okur: engel / damga kutuları yenilenir
  };
  if (accessoryCategory === 'layers') return <LayersPanel />;
  if (accessoryCategory === 'connectors') return <ConnectorsPanel draft={connDraft} setDraft={setConnDraft} keepModels={legKeep} />;
  if (accessoryCategory === 'layouts') return <ConnectorLayoutsPanel draft={layoutDraft} setDraft={setLayoutDraft} />;
  if (accessoryCategory === 'panelTypes') return <PanelTypesPanel onEditLayout={l => { setLayoutDraft(cloneLayoutSet(l)); setCategory('layouts'); }} />;
  if (accessoryCategory !== 'legs') return null;
  return (
    <div className="px-1.5 pt-1.5 pb-2 flex flex-col gap-1.5" style={{ fontFamily: UI_FONT }}>
      {legDraft && <LegModelEditor draft={legDraft} setDraft={setLegDraft} layers={accessoryLayers} onSave={() => void saveLeg()} onCancel={() => void cancelLeg()} />}
      {!legDraft && <QbSection title="Leg models"
        trailing={<CardAction compact icon={Plus} label="New" title="New leg model" onClick={() => setLegDraft(newLegModel(`Leg ${legModels.length + 1}`))} />}>
        {!legModels.length ? <Empty /> : (
            <div className="flex flex-col gap-1">
              {legModels.map(lm => {
                const d = legModelDims(lm, accessoryModels), nh = lm.holes?.length ?? 0;
                return (
                  <div key={lm.id} className={ROW}>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-stone-700">{lm.name}</span>
                    {d && <span className={`shrink-0 ${MUTED}`}>H {fmt1(d.height)} · Ø {fmt1(d.diameter)}{nh ? ` · ${nh} hole${nh === 1 ? '' : 's'}` : ''}</span>}
                    <button type="button" title="Edit" onClick={() => setLegDraft({ ...lm, parts: [...lm.parts], holes: [...(lm.holes ?? [])] })} className={ICON_BTN}><Pencil size={12} strokeWidth={1.9} /></button>
                    <button type="button" title="Delete" onClick={() => void deleteLegModel(lm.id).then(() => pruneUnusedAccessoryModels(connKeep))} className={DEL_BTN}><Trash2 size={12} strokeWidth={1.9} /></button>
                  </div>
                );
              })}
            </div>
          )}
      </QbSection>}
      <QbSection title="Leg sets" sub={legPresets.length ? 'the sets offered when placing legs' : undefined}
        trailing={!presetDraft && <CardAction compact icon={Plus} label="New" title="New leg set" onClick={() => setPresetDraft(newLegPreset(`Leg set ${legPresets.length + 1}`))} />}>
        {presetDraft ? <LegPresetEditor draft={presetDraft} setDraft={setPresetDraft} legModels={legModels} onSave={() => void savePreset()} onCancel={() => setPresetDraft(null)} />
          : !legPresets.length ? <Empty /> : (
            <div className="flex flex-col gap-1">
              {legPresets.map(p => {
                const lm = legModels.find(m => m.id === p.legModelId), L = presetLayout(p);
                return (
                  <div key={p.id} className={ROW}>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-stone-700">{p.name}</span>
                    <span className={`shrink-0 ${MUTED}`}>{lm ? lm.name : 'no model'} · {L.count} legs · {fmt1(L.side)} / {fmt1(L.front)} / {fmt1(L.rear)} · H {fmt1(p.height)}</span>
                    <button type="button" title="Edit" onClick={() => setPresetDraft({ ...p })} className={ICON_BTN}><Pencil size={12} strokeWidth={1.9} /></button>
                    <button type="button" title="Delete" onClick={() => void deleteLegPreset(p.id).then(() => syncPlinthSetsUsingPreset(null))} className={DEL_BTN}><Trash2 size={12} strokeWidth={1.9} /></button>
                  </div>
                );
              })}
            </div>
          )}
      </QbSection>
    </div>
  );
}
