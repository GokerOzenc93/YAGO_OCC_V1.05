/* AKSESUAR SEKMESİ (Goker, Eki 2026 — "Panel editör yanında bir sekme daha: Accessories; ilk seçenek ayak, sonra ray / menteşe").
   Kenar çubuğunun üçüncü sekmesi; Panel Editor / Parameters ile aynı dil (aynı kutular, hücreler, yazı tipleri — PanelEditor parçaları).

   AYAK (Legs)
   • Leg models — içe aktarılan parçalardan (AccessoryService) kurulan ayak modeli: 1–3 parça, her parçaya ROL (Base · Stem · Top plate);
     yalnız Stem set yüksekliğine göre uzar (Goker: "3 parça ekleyelim, sadece orta parça uzasın, uzayacak parçayı seçip rol vereyim").
     Önizleme gerçek montaj (legAssembly) — yükseklik kaydırıcısıyla uzama denenir.
   • Leg sets ("kaset") — model + 4/5/6 ayak + kenar mesafeleri + varsayılan yükseklik; baza seti kartı / Body ayakları / yerleştirme
     şeridi bu setleri çağırır (PanelEditor.LegPresetSelect).
   Kütüphane bu tarayıcıda (IndexedDB) saklanır. Ray: Import (model dosyası) · Leg set (yeni set). */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Plus, Trash2, Upload, Pencil, Boxes, LayoutGrid } from 'lucide-react';
import { type AccessoryCategory, type AccessoryModel, type AccessoryUnit, type LegModel, type LegModelPart, type LegPartRole, type LegPreset, useStoreFields } from '../store';
import { UI_FONT, railActions } from './Ui';
import {
  ACCESSORY_ACCEPT, LEG_ROLE_LABEL, LEG_ROLE_TITLE, type LegAssemblyPart, accessoryGeometryNow, deleteAccessoryModel, deleteLegModel, deleteLegPreset,
  importAccessoryFile, isSupportedAccessoryFile, legAssembly, legModelDims, legModelHasStem, newLegModel, newLegPreset, onAccessoryGeometry, saveLegModel,
  saveLegPreset, updateAccessoryModel,
} from './AccessoryService';
import {
  ApplyBtn, CardAction, DOCK_ROW, DOCK_STRIP, DockStatus, ExitBtn, FIELD_INPUT, LegsBlock, QbNote, QbSection, QbSelect, SECTION_LABEL, Segmented, SelectBox,
  dockAxisTag,
} from './PanelEditor';
import { fmt1, stop } from './PanelSchematics';

const CATEGORIES: Array<{ key: AccessoryCategory; label: string; title: string; disabled?: boolean }> = [
  { key: 'legs', label: 'Legs', title: 'Plinth legs: imported foot models and saved leg sets' },
  { key: 'rails', label: 'Rails', title: 'Drawer rails — coming next', disabled: true },
  { key: 'hinges', label: 'Hinges', title: 'Hinges — coming next', disabled: true },
];
const UNIT_OPTS: Array<{ v: AccessoryUnit; label: string }> = [{ v: 'mm', label: 'mm' }, { v: 'cm', label: 'cm' }, { v: 'm', label: 'm' }, { v: 'in', label: 'in' }];
const UP_OPTS: Array<{ v: 'y' | 'z'; label: string }> = [{ v: 'y', label: 'Y up' }, { v: 'z', label: 'Z up' }];
const ROLES: LegPartRole[] = ['base', 'stem', 'top'];
/** Eklenme sırasına göre rol tahmini: 1. taban, 2. mil, 3. tabla; sonrakiler tabla. */
const guessRole = (i: number): LegPartRole => (i === 0 ? 'base' : i === 1 ? 'stem' : 'top');
const LIST_ROW = 'w-full min-w-0 h-[30px] px-2 flex items-center gap-2 rounded-[8px] bg-white ring-1 ring-[#e6e0d6] text-left transition-colors hover:bg-[#faf7f2]';
const ROW_BTN = 'shrink-0 w-[22px] h-[22px] flex items-center justify-center rounded-[6px] text-stone-400 hover:text-stone-700 hover:bg-[#f3efe8]';
const TEXT_INPUT: React.CSSProperties = { ...FIELD_INPUT, width: 'auto', flex: 1, textAlign: 'left', fontSize: 12 };

/* ───────────────────────────── Önizleme ───────────────────────────── */
/** Taslak ayak modelinin montajı (geometriler gelince yenilenir). */
function useDraftAssembly(leg: LegModel | null, h: number): LegAssemblyPart[] | null {
  const [tick, setTick] = useState(0);
  useEffect(() => onAccessoryGeometry(() => setTick(t => t + 1)), []);
  const key = leg ? leg.parts.map(p => `${p.modelId}:${p.role}`).join('|') : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (leg && leg.parts.length ? legAssembly(leg, h, accessoryGeometryNow) : null), [key, h, tick]);
}
const PART_COLOR: Record<LegPartRole, string> = { base: '#2b2a28', stem: '#5b6670', top: '#2f2d2a' };
/** Küçük 3D önizleme: montaj gerçek ölçüde; kamera yüksekliğe göre; sürükleyerek döndürülür. */
function LegPreview({ leg, height }: { leg: LegModel | null; height: number }) {
  const parts = useDraftAssembly(leg, height);
  const footprint = useMemo(() => (parts ? Math.max(20, ...parts.map(p => Math.max(p.size[0], p.size[2]))) : 60), [parts]);
  const total = useMemo(() => (parts ? parts.reduce((a, p) => Math.max(a, p.y + p.size[1] * p.scaleY), 0) : height), [parts, height]);
  const R = Math.max(total, footprint) * 1.15;
  const target: [number, number, number] = [0, total / 2, 0];
  return (
    <div className="relative w-full rounded-[8px] overflow-hidden ring-1 ring-[#e6e0d6]" style={{ height: 190, background: 'linear-gradient(180deg,#fbfaf7 0%,#f1ede6 100%)' }}>
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
            <meshStandardMaterial color={PART_COLOR[p.role]} roughness={0.6} metalness={0.05} />
          </mesh>
        ))}
        <OrbitControls target={target} enablePan={false} minDistance={R * 0.8} maxDistance={R * 5} />
      </Canvas>
      {!parts && (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-stone-400" style={{ fontFamily: UI_FONT }}>
          {leg && leg.parts.length ? 'Loading model…' : 'Add parts to preview the foot'}
        </div>
      )}
      {parts && <div className="absolute left-2 bottom-1.5 text-[10px] font-medium text-stone-400" style={{ fontFamily: UI_FONT }}>H {fmt1(total)} · Ø {fmt1(footprint)} · drag to rotate</div>}
    </div>
  );
}

/* ───────────────────────────── Ayak modeli düzenleyici ───────────────────────────── */
function LegModelEditor({ draft, setDraft, models, onSave, onCancel, onImport, busy, error }: {
  draft: LegModel; setDraft: (m: LegModel) => void; models: AccessoryModel[]; onSave: () => void; onCancel: () => void;
  onImport: (files: FileList | null) => void; busy: boolean; error: string | null;
}) {
  const [testH, setTestH] = useState(100);
  const fileRef = useRef<HTMLInputElement>(null);
  const dims = legModelDims(draft, models);
  const stem = legModelHasStem(draft);
  const setPart = (i: number, patch: Partial<LegModelPart>) => setDraft({ ...draft, parts: draft.parts.map((p, k) => (k === i ? { ...p, ...patch } : p)) });
  const removePart = (i: number) => setDraft({ ...draft, parts: draft.parts.filter((_, k) => k !== i) });
  const stems = draft.parts.filter(p => p.role === 'stem').length;
  const status = busy ? 'Importing…' : error ? error
    : !draft.parts.length ? 'Add the foot parts: base · stem · top plate (one file each)'
    : !stem ? 'No stem part — the foot keeps its natural height (nothing stretches)'
    : stems > 1 ? `${stems} stem parts — all of them stretch together`
    : `Stem stretches with the set height · natural height ${fmt1(dims?.height ?? 0)}`;
  return (
    <div className="flex flex-col gap-1.5" onClick={stop}>
      <div className="flex items-center gap-1.5">
        <span style={dockAxisTag('#44403c')}>NAME</span>
        <div className="flex-1 min-w-0 h-[28px] px-2 flex items-center rounded-[7px] bg-white ring-1 ring-[#e6e0d6]">
          <input type="text" value={draft.name} placeholder="Leg model" spellCheck={false} onChange={e => setDraft({ ...draft, name: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') onCancel(); }} className="yago-field yago-field-text" style={TEXT_INPUT} />
        </div>
        <ApplyBtn enabled={!busy && draft.parts.length > 0} onClick={onSave} title="Save the leg model" />
        <ExitBtn onClick={onCancel} />
      </div>
      <LegPreview leg={draft} height={testH} />
      <div className="flex items-center gap-2 px-0.5" title="Test height — try how the stem stretches (the real height comes from the plinth set)">
        <span style={SECTION_LABEL}>Test height</span>
        <input type="range" min={40} max={250} step={1} value={testH} onChange={e => setTestH(parseInt(e.target.value, 10))} className="flex-1 accent-[#ea580c]" />
        <span className="w-[44px] text-right text-[11px] font-semibold tabular-nums text-stone-600">{testH}</span>
      </div>
      <div className="flex items-center gap-2 px-0.5 pt-1">
        <span style={SECTION_LABEL}>Parts</span>
        <span className="text-[10px] text-stone-400">give each part a role · only Stem stretches</span>
        <div className="flex-1" />
        <CardAction compact icon={Upload} label="Add part" title={`Import one or more model files as parts (${ACCESSORY_ACCEPT})`} onClick={() => fileRef.current?.click()} />
        <input ref={fileRef} type="file" multiple accept={ACCESSORY_ACCEPT} className="hidden" onChange={e => { onImport(e.target.files); e.target.value = ''; }} />
      </div>
      {draft.parts.length === 0 && <QbNote>No parts yet. Use <b>Add part</b> (or the Import tool on the rail) — e.g. base, stem and top plate files.</QbNote>}
      {draft.parts.map((p, i) => {
        const m = models.find(x => x.id === p.modelId);
        return (
          <div key={`${p.modelId}-${i}`} className="rounded-[8px] ring-1 ring-[#e6e0d6] bg-white p-1.5 flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <span className="shrink-0 w-[18px] h-[18px] rounded-[5px] bg-[#f3efe8] text-[10px] font-bold text-stone-500 flex items-center justify-center tabular-nums">{i + 1}</span>
              <span className="flex-1 min-w-0 truncate text-[11.5px] font-medium text-stone-700" title={m?.fileName}>{m?.name ?? 'missing model'}</span>
              {m && <span className="shrink-0 text-[10px] text-stone-400 tabular-nums">{fmt1(m.size[0])} × {fmt1(m.size[1])} × {fmt1(m.size[2])}</span>}
              <button type="button" title="Remove this part from the leg" onClick={() => removePart(i)} className={ROW_BTN}><Trash2 size={12} strokeWidth={1.9} /></button>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="flex-1 min-w-0">
                <Segmented height={22} active={p.role} onPick={k => setPart(i, { role: k as LegPartRole })}
                  items={ROLES.map(r => ({ key: r, label: LEG_ROLE_LABEL[r], title: LEG_ROLE_TITLE[r] }))} />
              </div>
              {m && <>
                <QbSelect value={m.unit} options={UNIT_OPTS} w={46} onChange={v => void updateAccessoryModel(m.id, { unit: v })} />
                <QbSelect value={m.upAxis} options={UP_OPTS} w={54} onChange={v => void updateAccessoryModel(m.id, { upAxis: v })} />
              </>}
            </div>
          </div>
        );
      })}
      <DockStatus ready={!busy && !error && draft.parts.length > 0 && stem} text={status} />
    </div>
  );
}

/* ───────────────────────────── Ayak seti düzenleyici ───────────────────────────── */
function LegPresetEditor({ draft, setDraft, legModels, onSave, onCancel }: {
  draft: LegPreset; setDraft: (p: LegPreset) => void; legModels: LegModel[]; onSave: () => void; onCancel: () => void;
}) {
  const [hint, setHint] = useState<string | null>(null);
  const W = 600, D = 560;   // plan diyagramı için örnek kutu; set kutudan bağımsız (kenar mesafeleri parametrik)
  const modelOpts: Array<[string, string]> = [['', 'Built-in plastic foot'], ...legModels.map(m => [m.id, m.name] as [string, string])];
  return (
    <div className="flex flex-col gap-1.5" onClick={stop}>
      <div className="flex items-center gap-1.5">
        <span style={dockAxisTag('#44403c')}>NAME</span>
        <div className="flex-1 min-w-0 h-[28px] px-2 flex items-center rounded-[7px] bg-white ring-1 ring-[#e6e0d6]">
          <input type="text" value={draft.name} placeholder="Leg set" spellCheck={false} onChange={e => setDraft({ ...draft, name: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') onCancel(); }} className="yago-field yago-field-text" style={TEXT_INPUT} />
        </div>
        <ApplyBtn enabled onClick={onSave} title="Save the leg set" />
        <ExitBtn onClick={onCancel} />
      </div>
      <div className="flex items-center gap-1.5">
        <span style={SECTION_LABEL}>Model</span>
        <div className="flex-1 min-w-0 flex"><SelectBox value={draft.legModelId ?? ''} options={modelOpts} title="Foot model used by this set" onChange={v => setDraft({ ...draft, legModelId: v || null })} /></div>
      </div>
      <LegsBlock legs={{ count: draft.count, height: draft.height, diameter: legModelDims(legModels.find(m => m.id === draft.legModelId))?.diameter || 50, side: draft.side, front: draft.front, rear: draft.rear }}
        W={W} D={D} heightEditable countOptions={[4, 5, 6]} hint={hint} onHint={setHint}
        onChange={p => setDraft({ ...draft, ...(p.count != null ? { count: p.count as 4 | 5 | 6 } : {}), ...(p.height != null ? { height: p.height } : {}),
          ...(p.side != null ? { side: p.side } : {}), ...(p.front != null ? { front: p.front } : {}), ...(p.rear != null ? { rear: p.rear } : {}) })} />
      <QbNote>Offsets are measured from the set volume's edges, so the same set fits any body width or depth. Height is the default for a free set (a set bound to a bottom panel takes its height from the panel).</QbNote>
    </div>
  );
}

/* ───────────────────────────── Panel ───────────────────────────── */
export function AccessoriesPanel() {
  const { accessoryCategory, setAccessoryCategory, accessoryModels, legModels, legPresets } =
    useStoreFields('accessoryCategory', 'setAccessoryCategory', 'accessoryModels', 'legModels', 'legPresets');
  const [legDraft, setLegDraft] = useState<LegModel | null>(null);
  const [presetDraft, setPresetDraft] = useState<LegPreset | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /** Dosyaları içe aktarır; açık ayak modeli taslağına parça olarak ekler, yoksa yeni taslak açar. */
  const importFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    const list = Array.from(files);
    const bad = list.filter(f => !isSupportedAccessoryFile(f.name));
    if (bad.length) { setError(`Unsupported: ${bad.map(f => f.name).join(', ')}`); return; }
    setBusy(true); setError(null);
    try {
      const base = legDraft ?? newLegModel(list.length === 1 ? list[0].name.replace(/\.[^.]+$/, '') : 'Leg');
      const parts = [...base.parts];
      for (const f of list) {
        const m = await importAccessoryFile(f);
        parts.push({ modelId: m.id, role: guessRole(parts.length) });
      }
      setLegDraft({ ...base, parts });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    railActions.importAccessory = () => { setAccessoryCategory('legs'); fileRef.current?.click(); };
    railActions.newLegSet = () => { setAccessoryCategory('legs'); setPresetDraft(newLegPreset(`Leg set ${legPresets.length + 1}`)); };
    return () => { railActions.importAccessory = null; railActions.newLegSet = null; };
  }, [legPresets.length, setAccessoryCategory]);

  const saveLeg = async () => {
    if (!legDraft || !legDraft.parts.length) return;
    await saveLegModel({ ...legDraft, name: legDraft.name.trim() || 'Leg' });
    setLegDraft(null);
  };
  const savePreset = async () => {
    if (!presetDraft) return;
    await saveLegPreset({ ...presetDraft, name: presetDraft.name.trim() || 'Leg set' });
    setPresetDraft(null);
  };
  const usedBy = (legId: string) => legPresets.filter(p => p.legModelId === legId).length;
  const partName = (p: LegModelPart) => accessoryModels.find(m => m.id === p.modelId)?.name ?? '?';
  const orphans = accessoryModels.filter(m => !legModels.some(l => l.parts.some(p => p.modelId === m.id)) && !legDraft?.parts.some(p => p.modelId === m.id));

  return (
    <div style={{ fontFamily: UI_FONT }}>
      <div className="sticky top-0 z-[3]" style={DOCK_STRIP}>
        <div style={DOCK_ROW}>
          <span style={dockAxisTag('#44403c')} title="Accessory category">TYPE</span>
          <div className="flex-1 min-w-0"><Segmented items={CATEGORIES} active={accessoryCategory} onPick={k => setAccessoryCategory(k as AccessoryCategory)} /></div>
        </div>
        <div style={{ ...DOCK_ROW, paddingTop: 0 }}>
          <DockStatus ready={!busy && !error} text={busy ? 'Importing model…' : error ?? `${legModels.length} leg model${legModels.length === 1 ? '' : 's'} · ${legPresets.length} leg set${legPresets.length === 1 ? '' : 's'} · stored in this browser`} />
        </div>
      </div>
      <input ref={fileRef} type="file" multiple accept={ACCESSORY_ACCEPT} className="hidden" onChange={e => { void importFiles(e.target.files); e.target.value = ''; }} />

      {accessoryCategory === 'legs' && (
        <div className="px-1.5 pt-1.5 pb-2 flex flex-col gap-1.5">
          {/* 1 · AYAK MODELLERİ */}
          <QbSection title="Leg models" sub="base · stem (stretches) · top plate"
            trailing={!legDraft && <CardAction compact icon={Plus} label="New model" title="New leg model from imported parts" onClick={() => setLegDraft(newLegModel(`Leg ${legModels.length + 1}`))} />}>
            {legDraft ? (
              <LegModelEditor draft={legDraft} setDraft={setLegDraft} models={accessoryModels} onSave={() => void saveLeg()} onCancel={() => setLegDraft(null)}
                onImport={f => void importFiles(f)} busy={busy} error={error} />
            ) : legModels.length === 0 ? (
              <QbNote>No leg models yet. <b>New model</b>, then add the foot parts (base, stem, top plate) from files — glb, gltf, obj, stl, fbx, dae, ply, 3mf, 3ds, amf, wrl, step.</QbNote>
            ) : (
              <div className="flex flex-col gap-1">
                {legModels.map(lm => {
                  const d = legModelDims(lm, accessoryModels), n = usedBy(lm.id);
                  return (
                    <div key={lm.id} className={LIST_ROW}>
                      <Boxes size={13} strokeWidth={1.9} className="shrink-0 text-stone-400" />
                      <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-stone-700" title={lm.parts.map(p => `${LEG_ROLE_LABEL[p.role]}: ${partName(p)}`).join(' · ')}>{lm.name}</span>
                      <span className="shrink-0 text-[10px] text-stone-400 tabular-nums">
                        {lm.parts.length} part{lm.parts.length === 1 ? '' : 's'}{d ? ` · H ${fmt1(d.height)} · Ø ${fmt1(d.diameter)}` : ''}{legModelHasStem(lm) ? '' : ' · no stem'}{n ? ` · ${n} set${n === 1 ? '' : 's'}` : ''}
                      </span>
                      <button type="button" title="Edit this leg model" onClick={() => setLegDraft({ ...lm, parts: [...lm.parts] })} className={ROW_BTN}><Pencil size={12} strokeWidth={1.9} /></button>
                      <button type="button" title={n ? `Delete — ${n} leg set${n === 1 ? '' : 's'} will fall back to the built-in foot` : 'Delete this leg model'}
                        onClick={() => void deleteLegModel(lm.id)} className={`${ROW_BTN} hover:!text-red-600 hover:!bg-red-50`}><Trash2 size={12} strokeWidth={1.9} /></button>
                    </div>
                  );
                })}
              </div>
            )}
            {!legDraft && orphans.length > 0 && (
              <div className="mt-1.5">
                <div className="px-0.5 pb-1 flex items-center gap-2"><span style={SECTION_LABEL}>Imported parts not in a model</span></div>
                <div className="flex flex-col gap-1">
                  {orphans.map(m => (
                    <div key={m.id} className={LIST_ROW}>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-stone-600" title={m.fileName}>{m.name}</span>
                      <span className="shrink-0 text-[10px] text-stone-400 tabular-nums">{fmt1(m.size[0])} × {fmt1(m.size[1])} × {fmt1(m.size[2])} · .{m.ext}</span>
                      <button type="button" title="Use in a new leg model" onClick={() => setLegDraft({ ...newLegModel(m.name), parts: [{ modelId: m.id, role: 'base' }] })} className={ROW_BTN}><Plus size={12} strokeWidth={2} /></button>
                      <button type="button" title="Delete this imported file" onClick={() => void deleteAccessoryModel(m.id)} className={`${ROW_BTN} hover:!text-red-600 hover:!bg-red-50`}><Trash2 size={12} strokeWidth={1.9} /></button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </QbSection>

          {/* 2 · AYAK SETLERİ */}
          <QbSection title="Leg sets" sub="model · 4 / 5 / 6 legs · offsets · default height"
            trailing={!presetDraft && <CardAction compact icon={Plus} label="New set" title="New leg set (saved layout, callable from plinth sets and Body legs)"
              onClick={() => setPresetDraft(newLegPreset(`Leg set ${legPresets.length + 1}`))} />}>
            {presetDraft ? (
              <LegPresetEditor draft={presetDraft} setDraft={setPresetDraft} legModels={legModels} onSave={() => void savePreset()} onCancel={() => setPresetDraft(null)} />
            ) : legPresets.length === 0 ? (
              <QbNote>No leg sets yet. A set stores the foot model, the number of legs and the side / front / rear offsets — pick it when placing a plinth leg set, in the set's card, or in the Body legs step.</QbNote>
            ) : (
              <div className="flex flex-col gap-1">
                {legPresets.map(p => {
                  const lm = legModels.find(m => m.id === p.legModelId);
                  return (
                    <div key={p.id} className={LIST_ROW}>
                      <LayoutGrid size={13} strokeWidth={1.9} className="shrink-0 text-stone-400" />
                      <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-stone-700">{p.name}</span>
                      <span className="shrink-0 text-[10px] text-stone-400 tabular-nums" title="model · legs · side / front / rear · default height">
                        {lm ? lm.name : 'built-in'} · {p.count} legs · {fmt1(p.side)} / {fmt1(p.front)} / {fmt1(p.rear)} · H {fmt1(p.height)}
                      </span>
                      <button type="button" title="Edit this leg set" onClick={() => setPresetDraft({ ...p })} className={ROW_BTN}><Pencil size={12} strokeWidth={1.9} /></button>
                      <button type="button" title="Delete this leg set (placed sets keep their legs)" onClick={() => void deleteLegPreset(p.id)}
                        className={`${ROW_BTN} hover:!text-red-600 hover:!bg-red-50`}><Trash2 size={12} strokeWidth={1.9} /></button>
                    </div>
                  );
                })}
              </div>
            )}
          </QbSection>
        </div>
      )}
      {accessoryCategory !== 'legs' && (
        <div className="px-1.5 pt-1.5 pb-2">
          <QbSection title={accessoryCategory === 'rails' ? 'Rails' : 'Hinges'} sub="coming next"><QbNote>This accessory type will be defined next.</QbNote></QbSection>
        </div>
      )}
    </div>
  );
}
