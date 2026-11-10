/* AKSESUAR SEKMESİ (Goker, Eki 2026 — "Panel editör yanında Aksesuar sekmesi; ilk seçenek ayak, sonra ray / menteşe"; "üstteki tip seçimine
   gerek yok, soldan işaretliyorum; açıklamaları azalt, temiz olsun; ayak için 3 model ekleyebileyim").
   Kategori soldaki raydan seçilir (Legs · Layers). Assembly / Parameters ile aynı parçalar ve yazı tipleri.

   AYAK
   • Leg models — 3 yuva: Top · Middle · Bottom (üstten alta, ayağın kendisi gibi). Her yuvaya bir model dosyası; birim + yukarı ekseni
     kartta. Her parça: nihai ölçü (Size X / Y / Z, mm), taşıma (Move X / Y / Z), Stretch (açık = ayak boyu değişince uzar; kapalı =
     Size Y'de sabit; varsayılan yalnız Middle açık), KATMAN (rengi parçayı boyar). Önizleme gerçek montaj; ORİJİN görünür.
   • Holes (Goker, Kas 2026 — "ayağın modelinin üzerine program üzerinden delik atabileyim; delik listesi: yön, X Y Z ayağın sıfırına göre,
     çap, derinlik"): önizlemede "Hole" kipi açılır, bir parçanın yüzüne tıklanır → delik o noktada, yönü yüzeyin dış normali (eksene
     kıstırılmış), o parçaya bağlı (ayak uzayınca tabla deliği de yükselir). Liste satırı: yön · Ø · derinlik · X / Y / Z (ayak sıfırına
     göre, düzenlenebilir). Gövdede ayak yerleşince delik panele değdiği yerden panelden çıkarılır (PanelEngine, tek boolean).
   • Leg sets ("kaset") — model + köşe düzeni (4/5/6) + kenar mesafeleri + varsayılan yükseklik. Yerleşim her zaman otomatiktir (gövde
     yüz rolleri); baza seti kartı / Body ayakları / yerleştirme şeridi YALNIZ bu setleri listeler (Assembly.LegPresetSelect).
   KATMANLAR (Goker, Kas 2026): kütüphane geneli liste (ad + renk) — her aksesuar parçası bir katmana bağlanır; ileride ray / menteşe de.
   Kütüphane bu tarayıcıda (IndexedDB).

   ÖNİZLEME SAHNESİ (Goker, Kas 2026 — "sahne daha güzel, gizmo daha minimal; bir CAD programının aksesuar düzenleme profesyonelliğinde"):
   düz sıcak zemin + ince ızgara, stüdyo ışığı + yumuşak temas gölgesi, parçalar katman renginde; orijin = küçük nokta + üç kısa ince
   eksen (yazı rozeti / iz halkası yok); yükseklik ölçüsü ince çizgi; köşede ince eksen üçlüsü (MiniTriad — tık o görünüşe döndürür). */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useThree } from '@react-three/fiber';
import { ContactShadows, GizmoHelper, Grid, Html, Line, OrbitControls, useGizmoContext } from '@react-three/drei';
import { Plus, Trash2, Upload, Pencil, RotateCcw, Drill } from 'lucide-react';
import {
  type AccessoryLayer, type AccessoryUnit, type HoleSpec, type LegModel, type LegModelPart, type LegPartRole, type LegPreset, useStoreFields,
} from '../store';
import { UI_FONT } from './Ui';
import { type AxisDir, type Vec3, round1 } from './Geometry';
import {
  ACCESSORY_ACCEPT, HOLE_AXES, HOLE_DEFAULTS, LAYER_DEFAULT_COLOR, type LegAssemblyPart, type LegHoleAt, type SnapPoint, accessoryGeometryNow, assemblyFootprint, axisVecOf,
  deleteAccessoryLayer, deleteLegModel, deleteLegPreset, detectPartEmbed, holeAxisOf, holeLegPos, holePosFromLeg, importAccessoryFile, layerUseCount, legAssembly, legContactHeight, legHolesAt,
  legModelDims, legModelHasStem, legPartDims, legPartEmbed, legPartOffset, legPartStretches, legTopHeight, meshSnapPoints, newAccessoryLayer, newHole, newLegModel, newLegPreset, onAccessoryGeometry,
  presetLayout, pruneUnusedAccessoryModels, saveAccessoryLayer, saveLegModel, saveLegPreset, snapDirToAxis, updateAccessoryModel,
} from './AccessoryService';
import {
  ApplyBtn, CARD_BODY, CARD_BODY_STYLE, CardAction, ExitBtn, FIELD_INPUT, LegLayoutCells, LegLayoutDiagram, QB_CELL_ROW, QbNum, QbSection, QbSelect,
  QbSwitch, ROW_SEL_BAR, ROW_SEL_HEAD, ReadCell, ReadValue, RowCells, RowChevron, SECTION_LABEL, SelectBox, rectLegPoints, rowCardClass,
} from './Assembly';
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
/** HAYALET PANEL: temas düzleminde oturan yarı saydam 18 mm levha — ayağın neye vidalandığı ve panele giren kısım (pimler) görünür.
 *  Işına yanıt vermez (parça seçimi / yakalama engellenmez). */
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
function HoleGlyph({ at, selected, onClick }: { at: LegHoleAt; selected: boolean; onClick: () => void }) {
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
/** SAHNE İÇİ: parçalar + delikler + yakalama. Delik kipinde imleç parçanın üstünde olmasa da (arka plan küresi) en yakın yakalama
 *  noktasına (ekranda ≤ 14 px) kilitlenir — delik merkezi boşluktayken bile yakalanır; yoksa yüzeydeki nokta (0.5 mm'e yuvarlanmış).
 *  Yön: yüzeye gelinmişse o yüzün normali, yakalanan noktada aynı parça değilse noktanın kameraya bakan normali — eksene kıstırılmış. */
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
/** AYAK ÖNİZLEME SAHNESİ: stüdyo ışığı, ince ızgara zemin, temas gölgesi, katman renkli parçalar, delik işaretleri, sade orijin,
 *  yükseklik ölçüsü, köşede ince eksen üçlüsü. Sol sürükle = döndür, SAĞ sürükle = kaydır (pan), tekerlek = yaklaş (kenar çubuğunu
 *  kaydırmaz — Goker). Sağ üstte "Hole" kipi (yüzeye / yakalama noktasına tık → delik). */
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
   Goker: "middle / base / bottom'da da scale ve move olsun; panel editör gibi düzenlemeye tıklayınca satırları gelsin; scale yüzde değil
   net ölçü; her parçada stretch özelliği olsun". Yuva = Assembly satırı gibi: başlık (yuva · model · X / Y / Z ölçüsü · ↕ · ok);
   tıklayınca kart: Size X / Y / Z (nihai mm) · Move X / Y / Z (mm) · Stretch · Unit · Up · Layer · Replace / Remove. Tek kart açık. */
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
   TEK SATIR (Goker: "pozisyon, çap, derinlik girdileri tek satıra sığsın, sade görünsün"): # · yön · X Y Z · Ø D · parça · sil —
   hepsi satırda düzenlenir, kart yok. Satıra tık deliği seçer (3D'de turuncu); 3D'de deliğe tık satırı seçer; Delete seçili deliği siler.
   X / Y / Z AYAK SIFIRINA göre gösterilir ve düzenlenir; parçaya bağlı delik parçayla birlikte taşınır (tabla deliği ayak boyuyla yükselir). */
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

/** Ayak modeli düzenleyici: üst blok (ad + önizleme) kenar çubuğunda YAPIŞIK kalır (Goker: "sahneyi scroll ile kaydırmasın, hem sahneyi
 *  hem delikleri göreyim"); altındaki yükseklik / yuvalar / delikler kayar. */
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
/** SET DÜZENLEYİCİ (sade): model · köşe düzeni (4/5/6) · yan / ön / arka mesafeleri · varsayılan yükseklik. Plan diyagramı örnek gövde
 *  izinde (600 × 560) otomatik yerleşimi gösterir; yerleşince gerçek gövde izine ve yüz rollerine göre çözülür. */
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
   Satır: renk (tık → renk seçici) · ad (yerinde düzenlenir) · kullanan parça sayısı · sil. Liste kütüphane genelidir. */
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
  const { accessoryLayers, legModels } = useStoreFields('accessoryLayers', 'legModels');
  return (
    <div className="px-1.5 pt-1.5 pb-2 flex flex-col gap-1.5" style={{ fontFamily: UI_FONT }}>
      <QbSection title="Layers" sub="shared by every accessory part"
        trailing={<CardAction compact icon={Plus} label="New" title="New layer" onClick={() => void saveAccessoryLayer(newAccessoryLayer(`Layer ${accessoryLayers.length + 1}`))} />}>
        {!accessoryLayers.length ? <Empty /> : (
          <div className="flex flex-col gap-1">
            {accessoryLayers.map(l => <LayerRow key={l.id} layer={l} uses={layerUseCount(l.id, legModels)} />)}
          </div>
        )}
      </QbSection>
    </div>
  );
}

/* ═════════════════════════════════ Panel ═════════════════════════════════ */
const Empty = () => <div className="yago-hint px-1 py-0.5">None yet</div>;
export function AccessoriesPanel() {
  const { accessoryCategory, accessoryModels, legModels, legPresets, accessoryLayers } = useStoreFields('accessoryCategory', 'accessoryModels', 'legModels', 'legPresets', 'accessoryLayers');
  const [legDraft, setLegDraft] = useState<LegModel | null>(null);
  const [presetDraft, setPresetDraft] = useState<LegPreset | null>(null);
  const saveLeg = async () => {
    if (!legDraft || !legDraft.parts.length) return;
    await saveLegModel({ ...legDraft, name: legDraft.name.trim() || 'Leg' });
    setLegDraft(null);
    await pruneUnusedAccessoryModels();   // değiştirilen yuvaların eski dosyaları
    syncPlinthSetsUsingPreset(null);      // Ø / model / delikler değişmiş olabilir: setleri kullanan gövdeler yeniden çözülür
  };
  const cancelLeg = async () => { setLegDraft(null); await pruneUnusedAccessoryModels(); };
  const savePreset = async () => {
    if (!presetDraft) return;
    await saveLegPreset({ ...presetDraft, name: presetDraft.name.trim() || 'Leg set' });
    setPresetDraft(null);
    syncPlinthSetsUsingPreset(presetDraft.id);   // Auto setler düzeni canlı okur: engel / damga kutuları yenilenir
  };
  if (accessoryCategory === 'layers') return <LayersPanel />;
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
                    <button type="button" title="Delete" onClick={() => void deleteLegModel(lm.id).then(() => pruneUnusedAccessoryModels())} className={DEL_BTN}><Trash2 size={12} strokeWidth={1.9} /></button>
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
