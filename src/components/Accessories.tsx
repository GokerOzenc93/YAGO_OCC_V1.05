/* AKSESUAR SEKMESİ (Goker, Eki 2026 — "Panel editör yanında Aksesuar sekmesi; ilk seçenek ayak, sonra ray / menteşe"; "üstteki tip seçimine
   gerek yok, soldan işaretliyorum; açıklamaları azalt, temiz olsun; ayak için 3 model ekleyebileyim").
   Kategori soldaki raydan seçilir (şimdilik Legs). Panel Editor / Parameters ile aynı parçalar ve yazı tipleri.

   AYAK
   • Leg models — 3 yuva: Top · Middle · Bottom (üstten alta, ayağın kendisi gibi). Her yuvaya bir model dosyası; birim + yukarı ekseni
     yuvada. Uzayan yuva seçilir (varsayılan Middle) — set yüksekliği değişince yalnız o uzar. Önizleme gerçek montaj; ORİJİN görünür
     (Goker: "ayağı eklediğimde gösteren sahne büyük ve profesyonel olsun, ayağın orijin noktasını göster").
   • Leg sets ("kaset") — model + köşe düzeni (4/5/6) + kenar mesafeleri + varsayılan yükseklik. Yerleşim her zaman otomatiktir (gövde
     yüz rolleri); baza seti kartı / Body ayakları / yerleştirme şeridi YALNIZ bu setleri listeler (PanelEditor.LegPresetSelect).
   Kütüphane bu tarayıcıda (IndexedDB). */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useThree } from '@react-three/fiber';
import { ContactShadows, GizmoHelper, GizmoViewport, Grid, Html, Line, OrbitControls } from '@react-three/drei';
import { Plus, Trash2, Upload, Pencil, MoveVertical, Crosshair } from 'lucide-react';
import { type AccessoryUnit, type LegModel, type LegPartRole, type LegPreset, useStoreFields } from '../store';
import { UI_FONT } from './Ui';
import {
  ACCESSORY_ACCEPT, type LegAssemblyPart, accessoryGeometryNow, deleteLegModel, deleteLegPreset, importAccessoryFile, legAssembly, legModelDims,
  legModelHasStem, legStretchOf, newLegModel, newLegPreset, onAccessoryGeometry, presetLayout, pruneUnusedAccessoryModels, saveLegModel, saveLegPreset, updateAccessoryModel,
} from './AccessoryService';
import {
  ApplyBtn, CardAction, ExitBtn, FIELD_INPUT, LegLayoutCells, LegLayoutDiagram, QB_CELL_ROW, QbNum, QbSection, QbSelect, ReadCell, ReadValue,
  SECTION_LABEL, SelectBox, rectLegPoints,
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
  const key = leg ? `${legStretchOf(leg)}|${leg.parts.map(p => `${p.modelId}:${p.role}`).join('|')}` : '';
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
          Origin 0 · 0 · 0 <span style={{ fontWeight: 600, color: '#9a3412' }}>· floor contact, centre of footprint</span>
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
function LegPreview({ leg, height, stretch }: { leg: LegModel | null; height: number; stretch: LegPartRole }) {
  const parts = useDraftAssembly(leg, height);
  const footprint = useMemo(() => (parts ? Math.max(20, ...parts.map(p => Math.max(p.size[0], p.size[2]))) : 60), [parts]);
  const total = useMemo(() => (parts ? parts.reduce((a, p) => Math.max(a, p.y + p.size[1] * p.scaleY), 0) : height), [parts, height]);
  const R = Math.max(total, footprint) * 1.15;
  // Kamera model ya da yükseklik kutusu değişince modele yeniden oturur (kutu Enter / blur ile tek seferde yazılır).
  const fitKey = parts ? `${parts.map(p => p.modelId).join('|')}@${Math.round(total)}` : 'none';
  const stretching = parts?.find(p => p.role === stretch);
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
          <mesh key={`${p.modelId}-${i}`} geometry={p.geo} position={[0, p.y, 0]} scale={[1, p.scaleY, 1]} castShadow receiveShadow>
            {/* Uzayan parça turuncu: hangisinin uzadığı görünür */}
            <meshStandardMaterial color={p.role === stretch ? '#c2410c' : '#34312d'} roughness={p.role === stretch ? 0.55 : 0.45} metalness={0.12} />
          </mesh>
        ))}
        <OriginMarker len={Math.max(footprint * 0.8, total * 0.3)} footprint={footprint} />
        {parts && <HeightMark x={footprint / 2 + Math.max(8, footprint * 0.22)} total={total} />}
        <OrbitControls makeDefault enablePan={false} enableDamping dampingFactor={0.12} minDistance={R * 1.2} maxDistance={R * 12} maxPolarAngle={Math.PI * 0.52} />
        <GizmoHelper alignment="bottom-right" margin={[44, 44]}>
          <GizmoViewport axisColors={[AXIS.x, AXIS.y, AXIS.z]} labelColor="#57534e" hideNegativeAxes />
        </GizmoHelper>
      </Canvas>
      {/* HUD */}
      <div className="absolute left-2.5 top-2 flex flex-col gap-0.5" style={HUD}>
        <div className="flex items-center gap-1.5">
          <span className="inline-block w-[9px] h-[9px] rounded-[2px]" style={{ background: '#c2410c' }} />
          <span className="font-semibold text-stone-600">{stretching ? `${SLOTS.find(s => s.role === stretch)?.label ?? stretch} stretches with the set height` : 'no stretching part — fixed height'}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Crosshair size={10} strokeWidth={2.2} style={{ color: '#ea580c' }} />
          <span>origin = floor contact · imports are re-centred (XZ centre, base at Y 0)</span>
        </div>
      </div>
      {parts && (
        <div className="absolute left-2.5 bottom-2 flex items-center gap-2" style={HUD}>
          <span className="font-semibold text-stone-600">H {fmt1(total)}</span><span>·</span>
          <span className="font-semibold text-stone-600">Ø {fmt1(footprint)}</span><span>·</span>
          <span>{parts.length} part{parts.length === 1 ? '' : 's'}</span>
        </div>
      )}
      <div className="absolute right-2.5 top-2" style={HUD}>drag · orbit &nbsp; wheel · zoom</div>
      {!parts && leg && leg.parts.length > 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-stone-400" style={{ fontFamily: UI_FONT }}>Loading model…</div>
      )}
      {!parts && (!leg || !leg.parts.length) && (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-stone-400" style={{ fontFamily: UI_FONT }}>Add a model to a slot below — it is shown here standing on its origin</div>
      )}
    </div>
  );
}

/* ───────────────────────────── Ayak modeli: 3 yuva ───────────────────────────── */
function SlotRow({ label, role, draft, setDraft, onPick, busy }: {
  label: string; role: LegPartRole; draft: LegModel; setDraft: (m: LegModel) => void; onPick: (role: LegPartRole) => void; busy: boolean;
}) {
  const { accessoryModels } = useStoreFields('accessoryModels');
  const part = draft.parts.find(p => p.role === role);
  const m = part ? accessoryModels.find(x => x.id === part.modelId) : undefined;
  const stretch = legStretchOf(draft) === role;
  return (
    <div className={ROW} style={{ height: 34 }}>
      <span className="shrink-0 w-[46px] text-[10px] font-semibold uppercase tracking-[0.06em] text-stone-500">{label}</span>
      {m ? <>
        <div className="flex-1 min-w-0 flex flex-col leading-tight" title={m.fileName}>
          <span className="truncate text-[11.5px] font-medium text-stone-700">{m.name}</span>
          <span className={`truncate ${MUTED}`}>{fmt1(m.size[0])} × {fmt1(m.size[1])} × {fmt1(m.size[2])}</span>
        </div>
        <QbSelect value={m.unit} options={UNIT_OPTS} w={40} onChange={v => void updateAccessoryModel(m.id, { unit: v })} />
        <QbSelect value={m.upAxis} options={UP_OPTS} w={36} onChange={v => void updateAccessoryModel(m.id, { upAxis: v })} />
      </> : (
        <button type="button" disabled={busy} onClick={e => { stop(e); onPick(role); }}
          className="flex-1 min-w-0 h-[24px] flex items-center justify-center gap-1.5 rounded-[6px] border border-dashed border-[#d6cfc3] text-[11px] font-semibold text-stone-500 hover:bg-[#faf7f2] hover:text-stone-700">
          <Upload size={12} strokeWidth={2} />Add model
        </button>
      )}
      <button type="button" title={stretch ? 'Stretches with the set height' : 'Make this part stretch'} onClick={e => { stop(e); setDraft({ ...draft, stretch: role }); }}
        className={`shrink-0 h-[24px] px-1.5 flex items-center gap-1 rounded-[6px] text-[10px] font-semibold transition-colors
          ${stretch ? 'bg-orange-50 text-[#c2410c] ring-1 ring-orange-300' : 'text-stone-300 hover:text-stone-600 hover:bg-[#f3efe8]'}`}>
        <MoveVertical size={12} strokeWidth={2.2} />
      </button>
      {m && <button type="button" title="Replace" disabled={busy} onClick={e => { stop(e); onPick(role); }} className={ICON_BTN}><Upload size={12} strokeWidth={1.9} /></button>}
      {m && <button type="button" title="Remove" onClick={e => { stop(e); setDraft({ ...draft, parts: draft.parts.filter(p => p.role !== role) }); }} className={DEL_BTN}>
        <Trash2 size={12} strokeWidth={1.9} />
      </button>}
    </div>
  );
}

function LegModelEditor({ draft, setDraft, onSave, onCancel }: { draft: LegModel; setDraft: (m: LegModel) => void; onSave: () => void; onCancel: () => void }) {
  const [testH, setTestH] = useState(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      setDraft({ ...cur, parts: [...cur.parts.filter(p => p.role !== role), { modelId: m.id, role }] });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
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
      <LegPreview leg={draft} height={testH} stretch={legStretchOf(draft)} />
      {/* AYAK YÜKSEKLİĞİ (Goker: "yüksekliği bir kutucukla gireyim, slider istemiyorum"): mm kutusu — uzayan parça bu yüksekliğe uzar
          (set yüksekliği gibi). Uzayan parça yoksa ayak sabit boydur: kutu pasif, doğal yükseklik yazılır. */}
      {(() => {
        const stretchy = legModelHasStem(draft), natural = legModelDims(draft)?.height ?? 0;
        return (
          <div className="grid grid-cols-2 gap-x-1" style={QB_CELL_ROW}>
            <ReadCell label="Leg height" title={stretchy ? 'Leg height (mm) — the stretching part follows it, like the set height does'
              : 'No stretching part — the leg keeps its natural height (mark a slot with ↕ to make it stretch)'}>
              {stretchy ? <QbNum value={testH} min={1} w={56} onCommit={setTestH} />
                : <ReadValue color="#a8a29e">{natural ? `${fmt1(natural)} · fixed` : '—'}</ReadValue>}
            </ReadCell>
            <ReadCell label="Natural height" title="Sum of the parts as imported (no stretching)">
              <ReadValue color="#57534e">{natural ? fmt1(natural) : '—'}</ReadValue>
            </ReadCell>
          </div>
        );
      })()}
      {SLOTS.map(s => <SlotRow key={s.role} label={s.label} role={s.role} draft={draft} setDraft={setDraft} onPick={pick} busy={busy} />)}
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
      <LegLayoutCells legs={L} editable diameter={diameter} diameterTitle={lm ? `Foot diameter — from the model "${lm.name}"` : 'Foot diameter (no model: 50)'}
        onChange={setLayout} hint={hint} onHint={setHint}
        heightCell={<ReadCell label="Height" title="Default height of a free set (a set under a bottom panel follows the panel)">
          <QbNum value={draft.height} min={1} onCommit={v => setDraft({ ...draft, height: v })} />
        </ReadCell>} />
      <div className="px-1 text-[10px] text-stone-400">Sample body {SAMPLE_W} × {SAMPLE_D} · when placed, legs follow the real body outline and its face roles</div>
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
