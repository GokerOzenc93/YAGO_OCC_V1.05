/* AKSESUAR SEKMESİ (Goker, Eki 2026 — "Panel editör yanında Aksesuar sekmesi; ilk seçenek ayak, sonra ray / menteşe"; "üstteki tip seçimine
   gerek yok, soldan işaretliyorum; açıklamaları azalt, temiz olsun; ayak için 3 model ekleyebileyim").
   Kategori soldaki raydan seçilir (şimdilik Legs). Panel Editor / Parameters ile aynı parçalar ve yazı tipleri.

   AYAK
   • Leg models — 3 yuva: Top · Middle · Bottom (üstten alta, ayağın kendisi gibi). Her yuvaya bir model dosyası; birim + yukarı ekseni
     kartta. Her parça: nihai ölçü (Size X / Y / Z, mm), taşıma (Move X / Y / Z), Stretch (açık = ayak boyu değişince uzar; kapalı =
     Size Y'de sabit; varsayılan yalnız Middle açık). Önizleme gerçek montaj; ORİJİN görünür.
   • Leg sets ("kaset") — model + köşe düzeni (4/5/6) + kenar mesafeleri + varsayılan yükseklik. Yerleşim her zaman otomatiktir (gövde
     yüz rolleri); baza seti kartı / Body ayakları / yerleştirme şeridi YALNIZ bu setleri listeler (PanelEditor.LegPresetSelect).
   Kütüphane bu tarayıcıda (IndexedDB). */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useThree } from '@react-three/fiber';
import { ContactShadows, GizmoHelper, GizmoViewport, Grid, Html, Line, OrbitControls } from '@react-three/drei';
import { Plus, Trash2, Upload, Pencil, RotateCcw } from 'lucide-react';
import { type AccessoryUnit, type LegModel, type LegModelPart, type LegPartRole, type LegPreset, useStoreFields } from '../store';
import { UI_FONT } from './Ui';
import { type Vec3 } from './Geometry';
import {
  ACCESSORY_ACCEPT, type LegAssemblyPart, accessoryGeometryNow, assemblyFootprint, deleteLegModel, deleteLegPreset, importAccessoryFile, legAssembly,
  legModelDims, legModelHasStem, legPartDims, legPartOffset, legPartStretches, newLegModel, newLegPreset, onAccessoryGeometry, presetLayout, pruneUnusedAccessoryModels, saveLegModel, saveLegPreset, updateAccessoryModel,
} from './AccessoryService';
import {
  ApplyBtn, CARD_BODY, CARD_BODY_STYLE, CardAction, ExitBtn, FIELD_INPUT, LegLayoutCells, LegLayoutDiagram, QB_CELL_ROW, QbNum, QbSection, QbSelect,
  QbSwitch, ROW_SEL_BAR, ROW_SEL_HEAD, ReadCell, ReadValue, RowCells, RowChevron, SECTION_LABEL, SelectBox, rectLegPoints, rowCardClass,
} from './PanelEditor';
import { standardLegRules } from './LegLayout';
import { syncPlinthSetsUsingPreset } from './PlinthService';
import { fmt1, stop } from './PanelSchematics';

const UNIT_OPTS: Array<{ v: AccessoryUnit; label: string }> = [{ v: 'mm', label: 'mm' }, { v: 'cm', label: 'cm' }, { v: 'm', label: 'm' }, { v: 'in', label: 'in' }];
const UP_OPTS: Array<{ v: 'y' | 'z'; label: string }> = [{ v: 'y', label: 'Y↑' }, { v: 'z', label: 'Z↑' }];
/** Yuvalar ekranda ÜSTTEN alta (ayağın kendisi gibi); montaj alttan üste (AccessoryService.orderedParts). */
const SLOTS: Array<{ role: LegPartRole; label: string }> = [{ role: 'top', label: 'Top' }, { role: 'stem', label: 'Middle' }, { role: 'base', label: 'Bottom' }];
const ROW = 'w-full min-w-0 h-[30px] pl-2 pr-1 flex items-center gap-2 rounded-[8px] bg-white ring-1 ring-[#e6e0d6]';
const ICON_BTN = 'shrink-0 w-[24px] h-[24px] flex items-center justify-center rounded-[6px] text-stone-400 hover:text-stone-700 hover:bg-[#f3efe8] transition-colors';
const DEL_BTN = `${ICON_BTN} hover:!text-red-600 hover:!bg-red-50`;
const TEXT_INPUT: React.CSSProperties = { ...FIELD_INPUT, width: 'auto', flex: 1, textAlign: 'left', fontSize: 12 };
const MUTED = 'text-[10.5px] text-stone-400 tabular-nums';
/** Set düzenleyici önizlemesinin örnek gövde izi (mm): set gövdeden bağımsızdır (kenardan mm), yerleşince gerçek ize göre çözülür. */
const SAMPLE_W = 600, SAMPLE_D = 560;

/* ───────────────────────────── Önizleme ───────────────────────────── */
function useDraftAssembly(leg: LegModel | null, h: number): LegAssemblyPart[] | null {
  const [tick, setTick] = useState(0);
  useEffect(() => onAccessoryGeometry(() => setTick(t => t + 1)), []);
  // Parçalar + taşıma / ölçek: değişince montaj yeniden kurulur
  const key = leg ? JSON.stringify(leg.parts.map(p => [p.modelId, p.role, p.offset ?? null, p.dims ?? null, p.stretch ?? null, p.scale ?? null])) : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (leg && leg.parts.length ? legAssembly(leg, h, accessoryGeometryNow) : null), [key, h, tick]);
}
const AXIS = { x: '#dc2626', y: '#16a34a', z: '#2563eb' } as const;
const PREVIEW_H = 320;
/** Kamera: model ya da yükseklik kutusu değişince 3/4 görünüşe oturur (fitKey = parçalar + yükseklik). */
function FitView({ R, total, fitKey }: { R: number; total: number; fitKey: string }) {
  const camera = useThree(s => s.camera) as THREE.PerspectiveCamera;
  const controls = useThree(s => s.controls) as unknown as { target: THREE.Vector3; update: () => void } | null;
  useEffect(() => {
    // 3/4 görünüş: hedef modelin ortası, uzaklık görüş alanına (fov 28°) model + pay sığacak kadar — üstteki HUD yazılarıyla çakışmaz
    const target = new THREE.Vector3(0, total * 0.5, 0);
    camera.position.copy(target).addScaledVector(new THREE.Vector3(0.62, 0.46, 0.68).normalize(), R * 4.2);
    camera.near = Math.max(0.2, R * 0.005); camera.far = R * 80; camera.updateProjectionMatrix();
    if (controls) { controls.target.copy(target); controls.update(); } else camera.lookAt(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, !!controls]);
  return null;
}
/** ORİJİN (0,0,0): ayağın zemine bastığı nokta, iz merkezi — içe aktarılan dosya buraya göre normalize edilir (XZ merkez, taban y = 0).
 *  Küçük küre + üç eksen çizgisi (X kırmızı · Y yeşil · Z mavi) + etiket; zeminde iz çapı halkası. */
function OriginMarker({ len, footprint }: { len: number; footprint: number }) {
  const r = Math.max(0.6, len * 0.035);
  const ring = useMemo(() => {
    const pts: [number, number, number][] = [];
    for (let i = 0; i <= 64; i++) { const a = (i / 64) * Math.PI * 2; pts.push([Math.cos(a) * footprint / 2, 0.15, Math.sin(a) * footprint / 2]); }
    return pts;
  }, [footprint]);
  const axis = (to: [number, number, number], color: string, label: string) => (
    <group key={label}>
      {/* Eksenler modelin içinden de görünür (derinlik testi yok — CAD orijin üçlüsü gibi) */}
      <Line points={[[0, 0, 0], to]} color={color} lineWidth={1.6} transparent opacity={0.85} depthTest={false} renderOrder={10} />
      <Html position={to} center zIndexRange={[20, 30]} style={{ pointerEvents: 'none' }}>
        <span style={{ fontFamily: UI_FONT, fontSize: 9.5, fontWeight: 800, color, letterSpacing: '0.06em', textShadow: '0 0 3px #fff, 0 0 3px #fff' }}>{label}</span>
      </Html>
    </group>
  );
  return (
    <group>
      {axis([len, 0, 0], AXIS.x, 'X')}{axis([0, len, 0], AXIS.y, 'Y')}{axis([0, 0, len], AXIS.z, 'Z')}
      <mesh position={[0, 0, 0]} renderOrder={11}>
        <sphereGeometry args={[r, 20, 16]} />
        <meshBasicMaterial color="#ea580c" depthTest={false} transparent opacity={0.95} />
      </mesh>
      <Line points={ring} color="#b8aea0" lineWidth={1} dashed dashSize={3} gapSize={2.5} />
      <Html position={[0, 0, 0]} zIndexRange={[20, 30]} style={{ pointerEvents: 'none', transform: 'translate(16px, 14px)' }}>
        <div style={{
          fontFamily: UI_FONT, fontSize: 9.5, fontWeight: 700, color: '#7c2d12', whiteSpace: 'nowrap', padding: '2px 6px', borderRadius: 6,
          background: 'rgba(255,247,237,0.92)', border: '1px solid rgba(234,88,12,0.35)', boxShadow: '0 1px 2px rgba(68,64,60,0.08)',
        }}>
          Origin 0 · 0 · 0
        </div>
      </Html>
    </group>
  );
}
/** Yükseklik ölçüsü: modelin yanında zeminden tepeye dikey çizgi + değer. */
function HeightMark({ x, total }: { x: number; total: number }) {
  const t = Math.max(1, total * 0.03);
  return (
    <group>
      <Line points={[[x, 0, 0], [x, total, 0]]} color="#78716c" lineWidth={1} />
      <Line points={[[x - t, 0, 0], [x + t, 0, 0]]} color="#78716c" lineWidth={1} />
      <Line points={[[x - t, total, 0], [x + t, total, 0]]} color="#78716c" lineWidth={1} />
      <Html position={[x, total / 2, 0]} zIndexRange={[20, 30]} style={{ pointerEvents: 'none', transform: 'translate(6px, -50%)' }}>
        <span style={{ fontFamily: UI_FONT, fontSize: 10, fontWeight: 700, color: '#57534e', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', textShadow: '0 0 3px #fff, 0 0 3px #fff' }}>
          H {fmt1(total)}
        </span>
      </Html>
    </group>
  );
}
const HUD: React.CSSProperties = { fontFamily: UI_FONT, fontSize: 10.5, color: '#78716c', pointerEvents: 'none', fontVariantNumeric: 'tabular-nums' };
/** AYAK ÖNİZLEME SAHNESİ: büyük 3/4 görünüş — ızgara zemin, temas gölgesi, üç ışık, eksen gizmosu, ORİJİN işareti, yükseklik ölçüsü;
 *  uzayan parça turuncu. Sürükle = döndür, tekerlek = yaklaş. */
function LegPreview({ leg, height }: { leg: LegModel | null; height: number }) {
  const parts = useDraftAssembly(leg, height);
  const footprint = useMemo(() => (parts ? Math.max(20, assemblyFootprint(parts)) : 60), [parts]);
  const total = useMemo(() => (parts ? parts.reduce((a, p) => Math.max(a, p.y + p.size[1] * p.scaleY), 0) : height), [parts, height]);
  const R = Math.max(total, footprint) * 1.15;
  // Kamera model ya da yükseklik kutusu değişince modele yeniden oturur (kutu Enter / blur ile tek seferde yazılır).
  const fitKey = parts ? `${parts.map(p => p.modelId).join('|')}@${Math.round(total)}@${Math.round(footprint)}` : 'none';
  return (
    <div className="relative w-full rounded-[10px] overflow-hidden ring-1 ring-[#e6e0d6] shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]"
      style={{ height: PREVIEW_H, background: 'radial-gradient(120% 90% at 50% 10%, #fdfcfa 0%, #f3eee7 55%, #e9e3da 100%)' }}>
      <Canvas dpr={[1, 2]} shadows camera={{ position: [R * 2.6, total * 0.5 + R * 1.9, R * 2.85], fov: 28, near: 1, far: 20000 }}
        gl={{ antialias: true, alpha: true }} style={{ touchAction: 'none' }}>
        <FitView R={R} total={total} fitKey={fitKey} />
        <hemisphereLight args={['#ffffff', '#d6cfc3', 0.7]} />
        <directionalLight position={[R * 1.6, R * 2.6, R * 1.2]} intensity={1.05} castShadow shadow-mapSize={[2048, 2048]}
          shadow-camera-left={-R} shadow-camera-right={R} shadow-camera-top={R} shadow-camera-bottom={-R} shadow-camera-near={0.5} shadow-camera-far={R * 8} shadow-bias={-0.0004} />
        <directionalLight position={[-R * 2, R * 1.2, -R * 1.5]} intensity={0.35} />
        <directionalLight position={[0, R * 0.6, -R * 2.5]} intensity={0.25} />
        {/* Zemin: ızgara (10 mm hücre, 50 mm bölüm) + temas gölgesi */}
        <Grid position={[0, -0.02, 0]} args={[R * 6, R * 6]} cellSize={10} cellThickness={0.6} cellColor="#d9d2c6" sectionSize={50} sectionThickness={1}
          sectionColor="#b8aea0" fadeDistance={R * 5} fadeStrength={1.4} infiniteGrid followCamera={false} />
        <ContactShadows position={[0, 0.01, 0]} opacity={0.5} scale={R * 3} blur={2.2} far={total + 10} resolution={512} color="#3b352f" />
        {parts?.map((p, i) => (
          <mesh key={`${p.modelId}-${i}`} geometry={p.geo} position={[p.x, p.y, p.z]} scale={[p.scaleX, p.scaleY, p.scaleZ]} castShadow receiveShadow>
            {/* Uzayan parça turuncu: hangisinin uzadığı görünür */}
            <meshStandardMaterial color={p.stretch ? '#c2410c' : '#34312d'} roughness={p.stretch ? 0.55 : 0.45} metalness={0.12} />
          </mesh>
        ))}
        <OriginMarker len={Math.max(footprint * 0.8, total * 0.3)} footprint={footprint} />
        {parts && <HeightMark x={footprint / 2 + Math.max(8, footprint * 0.22)} total={total} />}
        <OrbitControls makeDefault enablePan={false} enableDamping dampingFactor={0.12} minDistance={R * 1.2} maxDistance={R * 12} maxPolarAngle={Math.PI * 0.52} />
        <GizmoHelper alignment="bottom-right" margin={[44, 44]}>
          <GizmoViewport axisColors={[AXIS.x, AXIS.y, AXIS.z]} labelColor="#57534e" hideNegativeAxes />
        </GizmoHelper>
      </Canvas>
      {parts && (
        <div className="absolute left-2.5 bottom-2 flex items-center gap-2" style={HUD}>
          <span className="font-semibold text-stone-600">H {fmt1(total)}</span><span>·</span>
          <span className="font-semibold text-stone-600">Ø {fmt1(footprint)}</span><span>·</span>
          <span>{parts.length} part{parts.length === 1 ? '' : 's'}</span>
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

/* ───────────────────────────── Ayak modeli: 3 yuva ─────────────────────────────
   Goker: "middle / base / bottom'da da scale ve move olsun; panel editör gibi düzenlemeye tıklayınca satırları gelsin; scale yüzde değil
   net ölçü; her parçada stretch özelliği olsun". Yuva = Panel Editor satırı gibi: başlık (yuva · model · X / Y / Z ölçüsü · ↕ · ok);
   tıklayınca kart: Size X / Y / Z (nihai mm) · Move X / Y / Z (mm) · Stretch · Unit · Up · Replace / Remove. Tek kart açık. */
/** Düzenlenebilir hücre (beyaz; Panel Editor hücreleriyle aynı görünüm). */
const EditCell = ({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) => (
  <div title={title} onClick={stop} className="min-w-0 h-full pl-2 pr-1 flex items-center gap-1 rounded-[7px] bg-white ring-1 ring-[#e6e0d6] shadow-[0_1px_0_rgba(40,30,20,0.03)]">
    <span className="flex-1 min-w-0 truncate text-[10px] font-semibold tracking-[0.08em] uppercase text-[#b5ada3]">{label}</span>
    {children}
  </div>
);
const SLOT_ROLE_LABEL: Record<LegPartRole, string> = { top: 'Top', stem: 'Middle', base: 'Bottom' };
function SlotRow({ role, draft, setDraft, onPick, busy, open, onToggle }: {
  role: LegPartRole; draft: LegModel; setDraft: (m: LegModel) => void; onPick: (role: LegPartRole) => void; busy: boolean;
  open: boolean; onToggle: () => void;
}) {
  const { accessoryModels } = useStoreFields('accessoryModels');
  const part = draft.parts.find(p => p.role === role);
  const m = part ? accessoryModels.find(x => x.id === part.modelId) : undefined;
  const setPart = (patch: Partial<LegModelPart>) => setDraft({ ...draft, parts: draft.parts.map(p => (p.role === role ? { ...p, ...patch } : p)) });
  const label = SLOT_ROLE_LABEL[role];
  if (!part || !m) {
    return (
      <div className={`${rowCardClass(false, false, false)} h-[34px] !flex-row items-center gap-2 pl-2.5 pr-1.5`}>
        <span className="shrink-0 w-[50px] text-[10px] font-semibold uppercase tracking-[0.06em] text-stone-500">{label}</span>
        <button type="button" disabled={busy} onClick={e => { stop(e); onPick(role); }}
          className="flex-1 min-w-0 h-[24px] flex items-center justify-center gap-1.5 rounded-[6px] border border-dashed border-[#d6cfc3] text-[11px] font-semibold text-stone-500 hover:bg-white hover:text-stone-700">
          <Upload size={12} strokeWidth={2} />Add model
        </button>
      </div>
    );
  }
  const dims = legPartDims(part, m.size), off = legPartOffset(part), st = legPartStretches(part);
  const setDim = (i: number, v: number) => { const d = [...dims] as Vec3; d[i] = Math.max(0.1, v); setPart({ dims: d, scale: undefined }); };
  const setOff = (i: number, v: number) => { const o = [...off] as Vec3; o[i] = v; setPart({ offset: o }); };
  const num = (v: number, on: (v: number) => void, min = -100000) => <QbNum value={v} min={min} w={46} onCommit={on} />;
  const toggle = (e: React.MouseEvent) => { stop(e); onToggle(); };
  return (
    <div className={rowCardClass(open, false, false)}>
      <div onClick={toggle} className={`relative h-[34px] pl-2.5 pr-1 flex items-center gap-2 cursor-pointer ${open ? ROW_SEL_HEAD : ''}`}>
        {open && <span className={ROW_SEL_BAR} />}
        <span className="shrink-0 w-[50px] text-[10px] font-semibold uppercase tracking-[0.06em] text-stone-500">{label}</span>
        <span className="flex-1 min-w-0 truncate text-[11.5px] font-medium text-stone-700" title={m.fileName}>{m.name}</span>
        <RowCells cells={[['X', dims[0]], ['Y', st ? '↕' : dims[1]], ['Z', dims[2]]]} title={`${fmt1(dims[0])} × ${fmt1(dims[1])} × ${fmt1(dims[2])} mm${st ? ' · stretches' : ''}`} />
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
            </div>
            <div className="flex items-center gap-1 pt-0.5">
              <CardAction compact icon={Upload} label="Replace" title="Replace the model file (size and move are kept)" onClick={() => onPick(role)} />
              <CardAction compact icon={RotateCcw} label="Reset" title="Model size, no move" onClick={() => setPart({ dims: undefined, offset: undefined, scale: undefined })} />
              <div className="flex-1" />
              <CardAction compact icon={Trash2} label="Remove" title="Remove this part" onClick={() => setDraft({ ...draft, parts: draft.parts.filter(p => p.role !== role) })} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LegModelEditor({ draft, setDraft, onSave, onCancel }: { draft: LegModel; setDraft: (m: LegModel) => void; onSave: () => void; onCancel: () => void }) {
  const [testH, setTestH] = useState(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openSlot, setOpenSlot] = useState<LegPartRole | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const slotRef = useRef<LegPartRole>('stem');
  const draftRef = useRef(draft); draftRef.current = draft;
  const pick = (role: LegPartRole) => { slotRef.current = role; setError(null); fileRef.current?.click(); };
  const onFile = async (files: FileList | null) => {
    const f = files?.[0]; if (!f) return;
    setBusy(true); setError(null);
    try {
      const m = await importAccessoryFile(f);
      const role = slotRef.current, cur = draftRef.current;
      // Model değiştirilirse yuvanın ölçü / taşıma / uzama ayarı korunur
      const prev = cur.parts.find(p => p.role === role);
      setDraft({ ...cur, parts: [...cur.parts.filter(p => p.role !== role), { ...(prev ?? {}), modelId: m.id, role }] });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const stretchy = legModelHasStem(draft), natural = legModelDims(draft)?.height ?? 0;
  return (
    <div className="flex flex-col gap-1.5" onClick={stop}>
      <div className="flex items-center gap-1.5">
        <div className="flex-1 min-w-0 h-[28px] px-2 flex items-center rounded-[7px] bg-white ring-1 ring-[#e6e0d6]">
          <input type="text" value={draft.name} placeholder="Leg model" spellCheck={false} onChange={e => setDraft({ ...draft, name: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') onCancel(); }} className="yago-field yago-field-text" style={TEXT_INPUT} />
        </div>
        <ApplyBtn enabled={!busy && draft.parts.length > 0} onClick={onSave} title="Save" />
        <ExitBtn onClick={onCancel} />
      </div>
      <LegPreview leg={draft} height={testH} />
      {/* Ayak yüksekliği (mm kutusu): uzayan parçalar bu boya uzar; uzayan parça yoksa ayak doğal boyunda sabit */}
      <div className="grid grid-cols-2 gap-x-1" style={QB_CELL_ROW}>
        {stretchy
          ? <EditCell label="Leg height"><QbNum value={testH} min={1} w={56} onCommit={setTestH} /></EditCell>
          : <ReadCell label="Leg height"><ReadValue color="#a8a29e">{natural ? `${fmt1(natural)} · fixed` : '—'}</ReadValue></ReadCell>}
        <ReadCell label="Natural height"><ReadValue color="#57534e">{natural ? fmt1(natural) : '—'}</ReadValue></ReadCell>
      </div>
      <div className="flex flex-col gap-1">
        {SLOTS.map(s => <SlotRow key={s.role} role={s.role} draft={draft} setDraft={setDraft} onPick={pick} busy={busy}
          open={openSlot === s.role} onToggle={() => setOpenSlot(o => (o === s.role ? null : s.role))} />)}
      </div>
      <input ref={fileRef} type="file" accept={ACCESSORY_ACCEPT} className="hidden" onChange={e => { void onFile(e.target.files); e.target.value = ''; }} />
      {(busy || error) && <div className={`px-1 text-[10.5px] ${error ? 'text-red-600' : 'text-stone-400'}`}>{busy ? 'Importing…' : error}</div>}
    </div>
  );
}

/* ───────────────────────────── Ayak seti ───────────────────────────── */
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
        <div className="flex-1 min-w-0 h-[28px] px-2 flex items-center rounded-[7px] bg-white ring-1 ring-[#e6e0d6]">
          <input type="text" value={draft.name} placeholder="Leg set" spellCheck={false} onChange={e => setDraft({ ...draft, name: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') onCancel(); }} className="yago-field yago-field-text" style={TEXT_INPUT} />
        </div>
        <ApplyBtn enabled={!!lm || !legModels.length} onClick={onSave} title={lm || !legModels.length ? 'Save' : 'Choose a leg model first'} />
        <ExitBtn onClick={onCancel} />
      </div>
      <div className="flex items-center gap-1.5">
        <span style={SECTION_LABEL}>Model</span>
        <div className="flex-1 min-w-0 flex">
          <SelectBox value={lm ? lm.id : ''} options={modelOpts} title="Foot model (Leg models above) — Ø comes from it" onChange={v => setDraft({ ...draft, legModelId: v || null })} />
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

/* ───────────────────────────── Panel ───────────────────────────── */
const Empty = () => <div className="px-1 py-0.5 text-[11px] text-stone-300">None yet</div>;
export function AccessoriesPanel() {
  const { accessoryCategory, accessoryModels, legModels, legPresets } = useStoreFields('accessoryCategory', 'accessoryModels', 'legModels', 'legPresets');
  const [legDraft, setLegDraft] = useState<LegModel | null>(null);
  const [presetDraft, setPresetDraft] = useState<LegPreset | null>(null);
  const saveLeg = async () => {
    if (!legDraft || !legDraft.parts.length) return;
    await saveLegModel({ ...legDraft, name: legDraft.name.trim() || 'Leg' });
    setLegDraft(null);
    await pruneUnusedAccessoryModels();   // değiştirilen yuvaların eski dosyaları
    syncPlinthSetsUsingPreset(null);      // Ø / model değişmiş olabilir: setleri kullanan gövdeler yeniden çözülür
  };
  const cancelLeg = async () => { setLegDraft(null); await pruneUnusedAccessoryModels(); };
  const savePreset = async () => {
    if (!presetDraft) return;
    await saveLegPreset({ ...presetDraft, name: presetDraft.name.trim() || 'Leg set' });
    setPresetDraft(null);
    syncPlinthSetsUsingPreset(presetDraft.id);   // Auto setler düzeni canlı okur: engel / damga kutuları yenilenir
  };
  if (accessoryCategory !== 'legs') return null;
  return (
    <div className="px-1.5 pt-1.5 pb-2 flex flex-col gap-1.5" style={{ fontFamily: UI_FONT }}>
      <QbSection title="Leg models"
        trailing={!legDraft && <CardAction compact icon={Plus} label="New" title="New leg model" onClick={() => setLegDraft(newLegModel(`Leg ${legModels.length + 1}`))} />}>
        {legDraft ? <LegModelEditor draft={legDraft} setDraft={setLegDraft} onSave={() => void saveLeg()} onCancel={() => void cancelLeg()} />
          : !legModels.length ? <Empty /> : (
            <div className="flex flex-col gap-1">
              {legModels.map(lm => {
                const d = legModelDims(lm, accessoryModels);
                return (
                  <div key={lm.id} className={ROW}>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-stone-700">{lm.name}</span>
                    {d && <span className={`shrink-0 ${MUTED}`}>H {fmt1(d.height)} · Ø {fmt1(d.diameter)}</span>}
                    <button type="button" title="Edit" onClick={() => setLegDraft({ ...lm, parts: [...lm.parts] })} className={ICON_BTN}><Pencil size={12} strokeWidth={1.9} /></button>
                    <button type="button" title="Delete" onClick={() => void deleteLegModel(lm.id).then(() => pruneUnusedAccessoryModels())} className={DEL_BTN}><Trash2 size={12} strokeWidth={1.9} /></button>
                  </div>
                );
              })}
            </div>
          )}
      </QbSection>
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
