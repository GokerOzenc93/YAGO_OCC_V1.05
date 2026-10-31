/* AKSESUAR SEKMESİ (Goker, Eki 2026 — "Panel editör yanında Aksesuar sekmesi; ilk seçenek ayak, sonra ray / menteşe"; "üstteki tip seçimine
   gerek yok, soldan işaretliyorum; açıklamaları azalt, temiz olsun; ayak için 3 model ekleyebileyim").
   Kategori soldaki raydan seçilir (şimdilik Legs). Panel Editor / Parameters ile aynı parçalar ve yazı tipleri.

   AYAK
   • Leg models — 3 yuva: Top · Middle · Bottom (üstten alta, ayağın kendisi gibi). Her yuvaya bir model dosyası; birim + yukarı ekseni
     yuvada. Uzayan yuva seçilir (varsayılan Middle) — set yüksekliği değişince yalnız o uzar. Önizleme gerçek montaj.
   • Leg sets ("kaset") — model + 4/5/6 ayak + kenar mesafeleri + varsayılan yükseklik; baza seti kartı / Body ayakları / yerleştirme
     şeridi çağırır (PanelEditor.LegPresetSelect).
   Kütüphane bu tarayıcıda (IndexedDB). */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Plus, Trash2, Upload, Pencil, MoveVertical } from 'lucide-react';
import { type AccessoryUnit, type LegModel, type LegPartRole, type LegPreset, useStoreFields } from '../store';
import { UI_FONT } from './Ui';
import {
  ACCESSORY_ACCEPT, type LegAssemblyPart, accessoryGeometryNow, deleteLegModel, deleteLegPreset, importAccessoryFile, legAssembly, legModelDims,
  legStretchOf, newLegModel, newLegPreset, onAccessoryGeometry, pruneUnusedAccessoryModels, saveLegModel, saveLegPreset, updateAccessoryModel,
} from './AccessoryService';
import { ApplyBtn, CardAction, ExitBtn, FIELD_INPUT, LegsBlock, QbSection, QbSelect, SECTION_LABEL, SelectBox, dockAxisTag } from './PanelEditor';
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

/* ───────────────────────────── Önizleme ───────────────────────────── */
function useDraftAssembly(leg: LegModel | null, h: number): LegAssemblyPart[] | null {
  const [tick, setTick] = useState(0);
  useEffect(() => onAccessoryGeometry(() => setTick(t => t + 1)), []);
  const key = leg ? `${legStretchOf(leg)}|${leg.parts.map(p => `${p.modelId}:${p.role}`).join('|')}` : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (leg && leg.parts.length ? legAssembly(leg, h, accessoryGeometryNow) : null), [key, h, tick]);
}
function LegPreview({ leg, height, stretch }: { leg: LegModel | null; height: number; stretch: LegPartRole }) {
  const parts = useDraftAssembly(leg, height);
  const footprint = useMemo(() => (parts ? Math.max(20, ...parts.map(p => Math.max(p.size[0], p.size[2]))) : 60), [parts]);
  const total = useMemo(() => (parts ? parts.reduce((a, p) => Math.max(a, p.y + p.size[1] * p.scaleY), 0) : height), [parts, height]);
  const R = Math.max(total, footprint) * 1.15;
  return (
    <div className="relative w-full rounded-[8px] overflow-hidden ring-1 ring-[#e6e0d6]" style={{ height: 170, background: 'linear-gradient(180deg,#fbfaf7 0%,#f1ede6 100%)' }}>
      <Canvas dpr={[1, 2]} camera={{ position: [R * 1.4, total * 0.55 + R * 0.6, R * 1.6], fov: 32, near: 1, far: 20000 }} gl={{ antialias: true, alpha: true }}>
        <ambientLight intensity={0.85} />
        <directionalLight position={[R * 2, R * 3, R * 2]} intensity={0.9} />
        <directionalLight position={[-R * 2, R, -R]} intensity={0.3} />
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]}>
          <circleGeometry args={[footprint * 1.6, 48]} />
          <meshStandardMaterial color="#e6e0d6" roughness={1} />
        </mesh>
        {parts?.map((p, i) => (
          <mesh key={`${p.modelId}-${i}`} geometry={p.geo} position={[0, p.y, 0]} scale={[1, p.scaleY, 1]}>
            {/* Uzayan parça turuncu: hangisinin uzadığı görünür */}
            <meshStandardMaterial color={p.role === stretch ? '#c2410c' : '#2f2d2a'} roughness={0.6} metalness={0.05} />
          </mesh>
        ))}
        <OrbitControls target={[0, total / 2, 0]} enablePan={false} minDistance={R * 0.8} maxDistance={R * 5} />
      </Canvas>
      {!parts && leg && leg.parts.length > 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-stone-400" style={{ fontFamily: UI_FONT }}>Loading…</div>
      )}
      {parts && <div className={`absolute left-2 bottom-1.5 ${MUTED}`} style={{ fontFamily: UI_FONT }}>H {fmt1(total)} · Ø {fmt1(footprint)}</div>}
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
      <div className="flex items-center gap-2 px-1" title="Preview height">
        <span style={dockAxisTag('#16a34a')}>H</span>
        <input type="range" min={40} max={250} step={1} value={testH} onChange={e => setTestH(parseInt(e.target.value, 10))} className="flex-1 accent-[#ea580c]" />
        <span className="w-[32px] text-right text-[11px] font-semibold tabular-nums text-stone-600">{testH}</span>
      </div>
      {SLOTS.map(s => <SlotRow key={s.role} label={s.label} role={s.role} draft={draft} setDraft={setDraft} onPick={pick} busy={busy} />)}
      <input ref={fileRef} type="file" accept={ACCESSORY_ACCEPT} className="hidden" onChange={e => { void onFile(e.target.files); e.target.value = ''; }} />
      {(busy || error) && <div className={`px-1 text-[10.5px] ${error ? 'text-red-600' : 'text-stone-400'}`}>{busy ? 'Importing…' : error}</div>}
    </div>
  );
}

/* ───────────────────────────── Ayak seti ───────────────────────────── */
function LegPresetEditor({ draft, setDraft, legModels, onSave, onCancel }: {
  draft: LegPreset; setDraft: (p: LegPreset) => void; legModels: LegModel[]; onSave: () => void; onCancel: () => void;
}) {
  const [hint, setHint] = useState<string | null>(null);
  const modelOpts: Array<[string, string]> = [['', 'Built-in foot'], ...legModels.map(m => [m.id, m.name] as [string, string])];
  return (
    <div className="flex flex-col gap-1.5" onClick={stop}>
      <div className="flex items-center gap-1.5">
        <div className="flex-1 min-w-0 h-[28px] px-2 flex items-center rounded-[7px] bg-white ring-1 ring-[#e6e0d6]">
          <input type="text" value={draft.name} placeholder="Leg set" spellCheck={false} onChange={e => setDraft({ ...draft, name: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') onCancel(); }} className="yago-field yago-field-text" style={TEXT_INPUT} />
        </div>
        <ApplyBtn enabled onClick={onSave} title="Save" />
        <ExitBtn onClick={onCancel} />
      </div>
      <div className="flex items-center gap-1.5">
        <span style={SECTION_LABEL}>Model</span>
        <div className="flex-1 min-w-0 flex"><SelectBox value={draft.legModelId ?? ''} options={modelOpts} title="Foot model" onChange={v => setDraft({ ...draft, legModelId: v || null })} /></div>
      </div>
      <LegsBlock legs={{ count: draft.count, height: draft.height, diameter: legModelDims(legModels.find(m => m.id === draft.legModelId))?.diameter || 50, side: draft.side, front: draft.front, rear: draft.rear }}
        W={600} D={560} heightEditable countOptions={[4, 5, 6]} hint={hint} onHint={setHint}
        onChange={p => setDraft({ ...draft, ...(p.count != null ? { count: p.count as 4 | 5 | 6 } : {}), ...(p.height != null ? { height: p.height } : {}),
          ...(p.side != null ? { side: p.side } : {}), ...(p.front != null ? { front: p.front } : {}), ...(p.rear != null ? { rear: p.rear } : {}) })} />
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
  };
  const cancelLeg = async () => { setLegDraft(null); await pruneUnusedAccessoryModels(); };
  const savePreset = async () => {
    if (!presetDraft) return;
    await saveLegPreset({ ...presetDraft, name: presetDraft.name.trim() || 'Leg set' });
    setPresetDraft(null);
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
      <QbSection title="Leg sets"
        trailing={!presetDraft && <CardAction compact icon={Plus} label="New" title="New leg set" onClick={() => setPresetDraft(newLegPreset(`Leg set ${legPresets.length + 1}`))} />}>
        {presetDraft ? <LegPresetEditor draft={presetDraft} setDraft={setPresetDraft} legModels={legModels} onSave={() => void savePreset()} onCancel={() => setPresetDraft(null)} />
          : !legPresets.length ? <Empty /> : (
            <div className="flex flex-col gap-1">
              {legPresets.map(p => {
                const lm = legModels.find(m => m.id === p.legModelId);
                return (
                  <div key={p.id} className={ROW}>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-stone-700">{p.name}</span>
                    <span className={`shrink-0 ${MUTED}`}>{lm ? lm.name : 'Built-in'} · {p.count} · H {fmt1(p.height)}</span>
                    <button type="button" title="Edit" onClick={() => setPresetDraft({ ...p })} className={ICON_BTN}><Pencil size={12} strokeWidth={1.9} /></button>
                    <button type="button" title="Delete" onClick={() => void deleteLegPreset(p.id)} className={DEL_BTN}><Trash2 size={12} strokeWidth={1.9} /></button>
                  </div>
                );
              })}
            </div>
          )}
      </QbSection>
    </div>
  );
}
