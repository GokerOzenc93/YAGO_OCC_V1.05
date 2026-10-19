import React from 'react';
import { Check, Columns3, DoorClosed, Pencil, Rows3, Trash2, Unlink, X } from 'lucide-react';
import { type PanelGroup, type Shape, type VirtualFace, useAppStore, useStoreFields } from '../../store';
import { UI_FONT } from '../Ui';
import { confirmBodyPanelPlacement } from '../SceneObjects';
import { type TreeNode, findNode, treeLeaves } from '../SplitShared';
import {
  type ExtrudeStep, type TransformStep, confirmPanelMoveRef, confirmPanelRotateRef, confirmRefFaceExtrude, deleteExtrudeStep, deleteTransformStep,
  executeFaceExtrude, executePanelMove, executePanelMoveFixed, executePanelRotate, updateExtrudeStep, updateTransformStep,
} from '../PanelOps';
import { confirmRefCavityExtrude, confirmVolumePick, deleteCavityStep, executeCavityExtrude, groupName, updateCavityStep } from '../PanelGroupService';
import { confirmDoorPick, isDoorVf } from '../DoorService';
import { confirmBackPick, isBackVf, vfBackBound } from '../BackService';
import {
  AXIS_COLORS, ApplyBtn, BackTypeSelect, CELL_LABEL, CardAction, DOCK_ROW, DOCK_SHELL, DOCK_STRIP, DockModeBar, DockStatus, ExitBtn, FIELD_INPUT, FieldBox,
  NumInput, PlacementSelect, ROW_DEL_CLASS, ROW_ICON, SectionHead, dockAxisTag, dockModes, iconBtn, stop,
} from './kit';

/* PANEL EDİTÖRÜ PARÇALARI — Extrude / Hacim / Taşı / Döndür şeritleri, işlem adımları, yerleştirme şeritleri, satır parçaları,
   kapak derzi parçaları ve kapak / arkalık şemalarının ortak bölge seçimi (PanelEditor kullanır). Şeritler store'u kendisi okur;
   değer taslakları PanelEditor'da kalır (eksen değişince orada sıfırlanır). */

type Ax = 'u' | 'v';
type DraftProps = { draft: string; setDraft: (s: string) => void };

/* ───────────── ŞERİTLER (Extrude · Hacim · Taşı · Döndür) ───────────── */

/** Eksen etiketi + sayı girişi (Taşı / Döndür). */
const axisInput = (axis: string, { draft, setDraft }: DraftProps, setValue: (v: number) => void, onEnter: () => void, onEscape: () => void) => (
  <>
    <span style={dockAxisTag(AXIS_COLORS[axis] || '#44403c')}>{axis.toUpperCase()}</span>
    <NumInput autoFocus draft={draft} setDraft={setDraft} setValue={setValue} fallback={0} onEnter={onEnter} onEscape={onEscape} />
  </>
);

/** Yüz extrude (panel) ve hacim (`cavity`) şeridi: Fixed / Dyn / Ref modu, ref durumu ya da değer, onay / çıkış. */
export function ExtrudeDock({ panel, cavity, draft, setDraft }: DraftProps & { panel?: Shape; cavity?: PanelGroup }) {
  const {
    faceExtrudeMode, faceExtrudeSelectedFace, faceExtrudeThickness, faceExtrudeValueMode, faceExtrudeRefCandidate, faceExtrudeClickPoint,
    faceExtrudeCavityGroupId, faceExtrudeCavityFaceNormal,
  } = useStoreFields('faceExtrudeMode', 'faceExtrudeSelectedFace', 'faceExtrudeThickness', 'faceExtrudeValueMode', 'faceExtrudeRefCandidate',
    'faceExtrudeClickPoint', 'faceExtrudeCavityGroupId', 'faceExtrudeCavityFaceNormal');
  if (!faceExtrudeMode || (cavity ? faceExtrudeCavityGroupId !== cavity.id : !panel)) return null;
  const { setFaceExtrudeMode, setFaceExtrudeSelectedFace, setFaceExtrudeRefCandidate, setFaceExtrudeValueMode, setFaceExtrudeThickness, updateShape } =
    useAppStore.getState();
  const hf = faceExtrudeSelectedFace !== null && (!cavity || !!faceExtrudeCavityFaceNormal);
  const isRef = faceExtrudeValueMode === 'ref', isFixed = faceExtrudeValueMode === 'fixed';
  const refPanel = isRef && !!faceExtrudeRefCandidate?.panelId;
  const refFace = refPanel && faceExtrudeRefCandidate!.faceGroupIndex >= 0;
  const exit = () => { setFaceExtrudeSelectedFace(null); setFaceExtrudeMode(false); setFaceExtrudeRefCandidate(null); };
  const onApply = async () => {
    if (!hf) return;
    if (cavity) {
      if (isRef) { if (!refFace) return; await confirmRefCavityExtrude(); }
      else { await executeCavityExtrude(cavity.id, faceExtrudeCavityFaceNormal!, faceExtrudeThickness, isFixed, faceExtrudeClickPoint); exit(); }
      return;
    }
    if (isRef) { if (!refFace) return; await confirmRefFaceExtrude(); }
    else await executeFaceExtrude({ panelShape: panel!, faceGroupIndex: faceExtrudeSelectedFace!, value: faceExtrudeThickness, isFixed, updateShape,
      clickPoint: faceExtrudeClickPoint ?? undefined });
    exit();
  };
  return (
    <div style={DOCK_SHELL}>
      {hf && (
        <DockModeBar active={faceExtrudeValueMode}
          modes={dockModes(['fixed', 'dyn', 'ref'], {
            fixed: { sub: 'Constant', title: cavity ? 'Fixed — cavity size along this axis' : 'Fixed — constant thickness' },
            ref: { sub: 'To face', title: 'Ref — up to a reference face' },
          })}
          onPick={k => { setFaceExtrudeValueMode(k as 'fixed' | 'dyn' | 'ref'); if (k !== 'ref') setFaceExtrudeRefCandidate(null); }} />
      )}
      <div style={DOCK_ROW}>
        {cavity && <span style={dockAxisTag('#44403c')}>VOL</span>}
        {!hf ? <DockStatus text={cavity ? 'Pick a face of the volume in the 3D view' : 'Pick a face in the 3D view'} />
          : isRef ? <DockStatus ready={refFace} text={refFace ? 'Reference face selected' : refPanel ? 'Pick the reference face' : 'Pick the reference panel'} />
          : <NumInput draft={draft} setDraft={setDraft} setValue={setFaceExtrudeThickness} fallback={faceExtrudeThickness}
              onEnter={cavity ? onApply : undefined} onEscape={cavity ? exit : undefined} />}
        {hf && <ApplyBtn enabled={!(isRef && !refFace)} onClick={onApply} />}
        <ExitBtn onClick={exit} />
      </div>
    </div>
  );
}

const MOVE_REF_STEPS = ['Pick the source point', 'Pick the target panel', 'Pick the target point', 'Ready — right-click to confirm'];
export function MoveDock({ panel, ...draft }: DraftProps & { panel?: Shape }) {
  const {
    panelMoveMode, panelMoveAxis, panelMoveValue, panelMoveValueMode, panelMoveRefSourceVertex, panelMoveRefTargetPanelId, panelMoveRefTargetVertex,
  } = useStoreFields('panelMoveMode', 'panelMoveAxis', 'panelMoveValue', 'panelMoveValueMode', 'panelMoveRefSourceVertex', 'panelMoveRefTargetPanelId',
    'panelMoveRefTargetVertex');
  if (!panel || !panelMoveMode) return null;
  const {
    setPanelMoveAxis, setPanelMoveMode, setPanelMoveValue, setPanelMoveValueMode, setPanelMoveRefSourceVertex, setPanelMoveRefTargetPanelId,
    setPanelMoveRefTargetVertex, setSelectedPanelRow, updateShape,
  } = useAppStore.getState();
  const isRef = panelMoveValueMode === 'ref', hasAxis = panelMoveAxis !== null;
  const refStep = !panelMoveRefSourceVertex ? 0 : !panelMoveRefTargetPanelId ? 1 : !panelMoveRefTargetVertex ? 2 : 3;
  const refReady = isRef && refStep === 3;
  const exit = () => { setPanelMoveAxis(null); setPanelMoveMode(false); if (isRef) setSelectedPanelRow(null); };
  const onApply = async () => {
    if (isRef) { if (!refReady) return; await confirmPanelMoveRef(); setSelectedPanelRow(null); }
    else {
      if (!hasAxis) return;
      const move = panelMoveValueMode === 'fixed' ? executePanelMoveFixed : executePanelMove;
      await move({ panelShape: panel, axis: panelMoveAxis!, value: panelMoveValue, updateShape });
    }
    setPanelMoveAxis(null); setPanelMoveValue(0); draft.setDraft('0'); setPanelMoveMode(false);
  };
  return (
    <div style={DOCK_SHELL}>
      <DockModeBar active={panelMoveValueMode}
        modes={dockModes(['dyn', 'fixed', 'ref'], {
          dyn: { sub: 'Relative' }, fixed: { sub: 'Absolute', title: 'Fixed — absolute position' }, ref: { sub: 'To point' },
        })}
        onPick={k => {
          setPanelMoveValueMode(k as 'dyn' | 'fixed' | 'ref');
          if (k === 'ref') { setPanelMoveAxis(null); return; }
          setPanelMoveRefSourceVertex(null); setPanelMoveRefTargetPanelId(null); setPanelMoveRefTargetVertex(null);
        }} />
      <div style={DOCK_ROW}>
        {isRef ? <DockStatus ready={refReady} text={MOVE_REF_STEPS[refStep]} />
          : !hasAxis ? <DockStatus text="Pick a direction arrow in the 3D view" />
          : axisInput(panelMoveAxis!, draft, setPanelMoveValue, onApply, () => { setPanelMoveAxis(null); setPanelMoveMode(false); })}
        <ApplyBtn enabled={isRef ? refReady : hasAxis} onClick={onApply} />
        <ExitBtn onClick={exit} />
      </div>
    </div>
  );
}

const ROTATE_REF_STEPS: Array<[string, string]> = [
  ['1/4 · Pivot point', 'The point the panel rotates around (its own corners or center)'],
  ['2/4 · Aim point', 'The point that will TOUCH the reference face — another point on the SAME panel'],
  ['3/4 · Axis ring', 'Rotation axis: pick the X / Y / Z ring in the scene'],
  ['4/4 · Reference face', 'Click a face on another panel (click the same spot again for the face behind). The panel rotates until the aim point touches it.'],
  ['Ready — right-click to confirm', 'Right-click anywhere in the scene — the link is kept and the reference panel edge is beveled to the slope'],
];
/* Döndürme ref modu: onaydan sonra bağ KALICIDIR — referans taşındıkça panel nişan noktasıyla yeniden döner. */
export function RotateDock({ panel, ...draft }: DraftProps & { panel?: Shape }) {
  const { panelRotateMode, panelRotatePivot, panelRotateAxis, panelRotateValue, panelRotateValueMode, panelRotateRefArmVertex, panelRotateRefFace } =
    useStoreFields('panelRotateMode', 'panelRotatePivot', 'panelRotateAxis', 'panelRotateValue', 'panelRotateValueMode', 'panelRotateRefArmVertex',
      'panelRotateRefFace');
  if (!panel || !panelRotateMode) return null;
  const { setPanelRotateAxis, setPanelRotatePivot, setPanelRotateMode, setPanelRotateValue, setPanelRotateValueMode, setSelectedPanelRow, updateShape } =
    useAppStore.getState();
  const isRef = panelRotateValueMode === 'ref';
  const hasPivot = panelRotatePivot !== null, hasAxis = panelRotateAxis !== null, hasArm = panelRotateRefArmVertex !== null;
  const refReady = isRef && hasPivot && hasArm && hasAxis && !!panelRotateRefFace;
  const exit = () => { setPanelRotateAxis(null); setPanelRotatePivot(null); setPanelRotateMode(false); if (isRef) setSelectedPanelRow(null); };
  const onApply = async () => {
    if (isRef) { if (!refReady) return; await confirmPanelRotateRef(); setPanelRotateMode(false); setSelectedPanelRow(null); return; }
    if (!hasAxis || !hasPivot) return;
    await executePanelRotate({ panelShape: panel, axis: panelRotateAxis!, value: panelRotateValue, pivot: panelRotatePivot!, updateShape });
    setPanelRotateAxis(null); setPanelRotateValue(0); draft.setDraft('0');
  };
  const modeBar = (trailing?: React.ReactNode) => (
    <DockModeBar trailing={trailing} active={panelRotateValueMode}
      modes={dockModes(['dyn', 'ref'], {
        dyn: { sub: 'Angle', title: 'Enter an angle: pivot → axis → degrees' },
        ref: { sub: 'Aim at face', title: 'Rotate to a reference: pivot → aim point → axis → reference face → right-click' },
      })}
      onPick={k => { setPanelRotateValueMode(k as 'dyn' | 'ref'); draft.setDraft('0'); }} />
  );
  // Mod seçilene kadar gizmo null döner (sahnede nokta/halka yok).
  if (panelRotateValueMode === null) return (
    <div style={DOCK_SHELL}>
      {modeBar(<div style={{ display: 'flex', alignItems: 'center' }}><ExitBtn onClick={exit} /></div>)}
      <div style={{ padding: '5px 10px 7px', fontSize: 10.5, fontWeight: 500, color: '#a8a29e', fontFamily: UI_FONT }}>Choose a rotation mode</div>
    </div>
  );
  if (isRef) {
    const [text, hint] = ROTATE_REF_STEPS[!hasPivot ? 0 : !hasArm ? 1 : !hasAxis ? 2 : !panelRotateRefFace ? 3 : 4];
    return (
      <div style={DOCK_SHELL}>
        {modeBar()}
        <div style={DOCK_ROW}>
          <DockStatus ready={refReady} text={text} title={hint} trailing={hasAxis && (
            <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 700, color: AXIS_COLORS[panelRotateAxis!] || '#44403c' }}>{panelRotateAxis!.toUpperCase()}</span>
          )} />
          <ApplyBtn enabled={refReady} onClick={onApply} />
          <ExitBtn onClick={exit} />
        </div>
      </div>
    );
  }
  return (
    <div style={DOCK_SHELL}>
      {modeBar()}
      <div style={DOCK_ROW}>
        {hasAxis && hasPivot ? (
          <>
            {axisInput(panelRotateAxis!, draft, setPanelRotateValue, onApply, () => { setPanelRotateAxis(null); setPanelRotateMode(false); })}
            <span style={{ fontSize: 12, fontWeight: 500, color: '#a8a29e', marginLeft: -2 }}>°</span>
            <ApplyBtn enabled onClick={onApply} />
          </>
        ) : hasPivot ? <DockStatus dot="#f59e0b" text="Pick an axis (X/Y/Z ring)" />
          : <DockStatus dot="#06b6d4" text="Pick a pivot point (corners/center)" />}
        <ExitBtn onClick={exit} />
      </div>
    </div>
  );
}

/* ───────────── İŞLEM ADIMLARI ───────────── */

export type StepEdit = { id: string; v: string } | null;
type StepEditProps = { edit: StepEdit; setEdit: (e: StepEdit) => void };
type StepItem = {
  id: string; badge: { label: string; bg: string; color: string }; axis: string; axisColor: string; value: number; unit?: string; tag?: string;
  editable: boolean; save: (v: number) => void; remove: () => void;
};
const STEP_BADGE: Record<string, StepItem['badge']> = {
  move: { label: 'Move', bg: 'rgba(22,163,74,0.08)', color: '#15803d' },
  rotate: { label: 'Rotate', bg: 'rgba(37,99,235,0.08)', color: '#1d4ed8' },
  extrude: { label: 'Ext', bg: 'rgba(217,119,6,0.09)', color: '#b45309' },
};
const VOL_BADGE = { label: 'Vol', bg: 'rgba(14,116,144,0.09)', color: '#0e7490' };

/** Adım listesi: sıra · tür · eksen · değer (✎ → ✓ / ✗) · F/D/R · sil. */
function StepList({ label, maxHeight, steps, edit, setEdit }: StepEditProps & { label: string; maxHeight: number; steps: StepItem[] }) {
  const tag = (txt: string) => <span className="shrink-0 text-[10px] font-semibold px-1.5 h-[18px] leading-[18px] rounded-[5px] bg-[#f3efe8] text-stone-500">{txt}</span>;
  const save = (s: StepItem) => { const v = parseFloat(edit?.v ?? ''); if (!isNaN(v)) s.save(v); };
  return (
    <div className="shrink-0 mt-2" style={{ fontFamily: UI_FONT }}>
      <SectionHead label={label} count={steps.length} className="px-1 pb-1.5" />
      <div className="overflow-y-auto" style={{ maxHeight }}>
        <div className="flex flex-col gap-[2px] p-px">
          {steps.map((s, idx) => (
            <div key={s.id} className="group/step flex items-center gap-1.5 pl-1.5 pr-1 h-[30px] rounded-[9px] bg-[#fdfcfa] ring-1 ring-[#ece7df] shadow-[0_1px_0_rgba(68,64,60,0.025)] hover:bg-white hover:ring-[#e2dbd0] transition-colors duration-150">
              <span className="shrink-0 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-[#f3efe8] text-[10.5px] font-semibold text-stone-500 tabular-nums leading-none">{idx + 1}</span>
              <span className="shrink-0 text-[10.5px] font-semibold px-1.5 h-[18px] leading-[18px] rounded-[5px]" style={{ background: s.badge.bg, color: s.badge.color }}>{s.badge.label}</span>
              <span className="shrink-0 min-w-[24px] text-center text-[10.5px] font-bold px-1 h-[18px] leading-[18px] rounded-[5px] bg-[#f5f2ec]" style={{ color: s.axisColor }}>{s.axis}</span>
              {edit?.id === s.id ? (
                <>
                  <input type="text" inputMode="numeric" autoFocus value={edit.v}
                    onChange={e => setEdit({ id: s.id, v: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Escape') setEdit(null); else if (e.key === 'Enter') save(s); }}
                    className="flex-1 min-w-0 h-[22px] text-center font-mono text-[12px] font-medium tabular-nums text-stone-800 bg-white border border-[#e6e0d6] rounded-[6px] outline-none focus:border-orange-400/60 focus:shadow-[0_0_0_2px_rgba(249,115,22,0.10)]" />
                  <button onClick={() => save(s)} style={iconBtn('#5b5346')}><Check size={11} /></button>
                  <button onClick={() => setEdit(null)} style={iconBtn('#a8a29e')}><X size={11} /></button>
                </>
              ) : (
                <>
                  <span className="flex-1 pl-1 font-mono text-[12px] font-medium text-stone-700 tabular-nums">{s.value}{s.unit}</span>
                  {s.tag && tag(s.tag)}
                  {s.editable && (
                    <button onClick={() => setEdit({ id: s.id, v: String(s.value) })} style={iconBtn('#a8a29e')}
                      className="hover:!bg-[#f3efe8] hover:!text-stone-700"><Pencil size={10.5} strokeWidth={1.9} /></button>
                  )}
                  <button onClick={s.remove} style={iconBtn('#a8a29e')}
                    className="hover:!bg-red-50 hover:!text-red-500"><Trash2 size={10.5} strokeWidth={1.9} /></button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
/** Panel adımları (extrude + taşı / döndür, zaman sırasıyla). Ref adımlarında donmuş value değil, çözülen gerçek miktar gösterilir. */
export function PanelSteps({ panel, ...edit }: StepEditProps & { panel?: Shape }) {
  const ext: ExtrudeStep[] = panel?.parameters?.extrudeSteps || [], tr: TransformStep[] = panel?.parameters?.transformSteps || [];
  if (!panel || (!ext.length && !tr.length)) return null;
  const { updateShape } = useAppStore.getState();
  const item = (s: { id: string; timestamp: number }, type: string, axis: string, value: number, isRef: boolean, tag: string | undefined) => {
    const isExt = type === 'extrude';
    return {
      ts: s.timestamp, id: s.id, badge: STEP_BADGE[type] || STEP_BADGE.move, axis: axis.toUpperCase(),
      axisColor: AXIS_COLORS[axis] || '#57534e', value, unit: type === 'rotate' ? '°' : '', tag, editable: !((isExt || type === 'rotate') && isRef),
      save: async (v: number) => { await (isExt ? updateExtrudeStep : updateTransformStep)(panel, s.id, v, updateShape); edit.setEdit(null); },
      remove: () => { void (isExt ? deleteExtrudeStep : deleteTransformStep)(panel, s.id, updateShape); },
    };
  };
  const steps = [
    ...ext.map(s => item(s, 'extrude', s.axisLabel, s.resolvedValue != null ? s.resolvedValue : s.value, !!s.refShapeId,
      s.isFixed !== undefined ? (s.refShapeId ? 'R' : s.isFixed ? 'F' : 'D') : undefined)),
    ...tr.map(s => item(s, s.type, s.axis, s.type === 'rotate' && typeof s.resolvedValue === 'number' ? s.resolvedValue : s.value,
      !!s.refTargetPanelId, s.refTargetPanelId ? 'R' : undefined)),
  ].sort((a, b) => a.ts - b.ts);
  return <StepList label="Steps" maxHeight={200} steps={steps} {...edit} />;
}
/** Hacim (cavity) adımları. */
export function VolumeSteps({ group: g, ...edit }: StepEditProps & { group: PanelGroup }) {
  const steps = g.cavitySteps || [];
  if (!steps.length) return null;
  const items: StepItem[] = [...steps].sort((a, b) => a.timestamp - b.timestamp).map(st => {
    const isRef = !!st.refShapeId, ax = st.axisLabel.toLowerCase();
    return {
      id: st.id, badge: VOL_BADGE, axis: st.axisLabel.toUpperCase(), axisColor: AXIS_COLORS[ax] || AXIS_COLORS[ax[0]] || '#57534e',
      value: isRef && st.resolvedValue != null ? st.resolvedValue : st.value, tag: isRef ? 'R' : st.isFixed ? 'F' : 'D', editable: !isRef,
      save: v => { void updateCavityStep(g.id, st.id, v); edit.setEdit(null); }, remove: () => { void deleteCavityStep(g.id, st.id); },
    };
  });
  return <StepList label="Volume steps" maxHeight={160} steps={items} {...edit} />;
}

/* ───────────── YERLEŞTİRME ŞERİTLERİ ───────────── */

const rectTxt = (r: { u0: number; u1: number; v0: number; v1: number }) => `${Math.round(r.u1 - r.u0)}×${Math.round(r.v1 - r.v0)}`;

/* Ortak yerleştirme şeridi: ad ve (kapakta) outer/inner yerleştirme ÖNCESİ seçilir; Enter = sahnede sağ tık. */
function PlacementDock({ tag, defaultName, showName = true, ready, status, onConfirm, onExit, confirmTitle, lead }: {
  tag: string; defaultName: string; showName?: boolean; ready: boolean; status: string;
  onConfirm: () => void; onExit: () => void; confirmTitle: string; lead?: React.ReactNode;
}) {
  const name = useAppStore(s => s.placementName);
  return (
    <div style={DOCK_STRIP}>
      <div style={DOCK_ROW}>
        <span style={dockAxisTag('#44403c')}>{tag}</span>
        {lead}
        {showName ? (
          <FieldBox label="" title={`Name of the new ${defaultName.toLowerCase()} (empty = ${defaultName})`}>
            <input type="text" autoFocus value={name} placeholder={defaultName} spellCheck={false}
              onChange={e => useAppStore.getState().setPlacementName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && ready) onConfirm(); if (e.key === 'Escape') onExit(); }}
              onClick={stop} className="yago-field yago-field-text"
              style={{ ...FIELD_INPUT, flex: 1, width: 'auto', textAlign: 'left', fontFamily: UI_FONT }} />
          </FieldBox>
        ) : <DockStatus ready={ready} text={status} />}
        <ApplyBtn enabled={ready} onClick={onConfirm} title={confirmTitle} />
        <ExitBtn onClick={onExit} />
      </div>
      {showName && <div style={{ ...DOCK_ROW, paddingTop: 0 }}><DockStatus ready={ready} text={status} /></div>}
    </div>
  );
}
/** Liste üstüne yapışık yerleştirme şeritleri: panel yüzü · raf/dikme hacmi (ya da grubu yeniden konumlama) · kapak · arkalık. */
export function PlacementDocks({ shape }: { shape: Shape | undefined }) {
  const {
    virtualFaces, panelGroups, raycastMode, raycastPendingVf, volumePickMode, volumePickGroupId, volumePickCandidates, volumePickIndex,
    doorPickMode, doorPickCandidates, doorPickIndex, doorPickPlacement, backPickMode, backPickCandidates, backPickIndex, backPickPlacement,
  } = useStoreFields('virtualFaces', 'panelGroups', 'raycastMode', 'raycastPendingVf', 'volumePickMode', 'volumePickGroupId', 'volumePickCandidates',
    'volumePickIndex', 'doorPickMode', 'doorPickCandidates', 'doorPickIndex', 'doorPickPlacement', 'backPickMode', 'backPickCandidates', 'backPickIndex',
    'backPickPlacement');
  const { setRaycastMode, setVolumePickMode, setDoorPickMode, setDoorPickPlacement, setBackPickMode, setBackPickPlacement } = useAppStore.getState();
  const noShape = 'Select a body first';
  const boundCount = (bound: (f: VirtualFace) => boolean) => (shape ? virtualFaces.filter(f => f.shapeId === shape.id && bound(f)).length : 0);

  const raycast = () => {
    const ready = !!shape && !!raycastPendingVf;
    const stackBase = virtualFaces.find(f => f.id === raycastPendingVf?.stackBaseVfId);
    return (
      <PlacementDock tag="PANEL" defaultName="Panel" ready={ready} confirmTitle="Place panel"
        status={!shape ? noShape
          : ready ? `${stackBase ? `In front of ${stackBase.description || 'panel'} (on its inner face)` : 'Face selected'}`
            + ' — click again for the next region · right-click: place'
          : 'Click a body face in the 3D view'}
        onConfirm={() => confirmBodyPanelPlacement(useAppStore.getState().raycastPendingVf)} onExit={() => setRaycastMode(false)} />
    );
  };
  const volume = (mode: 'shelf' | 'divider') => {
    const n = volumePickCandidates.length, ready = !!shape && n > 0, cur = volumePickCandidates[volumePickIndex];
    const reloc = volumePickGroupId ? panelGroups.find(g => g.id === volumePickGroupId) : undefined;
    const kind = mode === 'shelf' ? 'Shelf' : 'Divider';
    return (
      <PlacementDock tag={reloc ? `RELOCATE · ${groupName(reloc).toUpperCase()}` : kind.toUpperCase()} defaultName={kind} showName={!reloc} ready={ready}
        status={!shape ? noShape
          : n === 0 ? (reloc ? 'Click the new volume (only panels before this group bound it)' : 'Click inside a volume in the 3D view')
          : `Volume ${volumePickIndex + 1}/${n} · ${cur?.shape === 'box' ? 'Box' : 'Shaped'} — click: next · right-click: ${reloc ? 'relocate' : 'place'}`}
        onConfirm={() => { if (ready && shape) confirmVolumePick(shape.id, mode, volumePickCandidates[volumePickIndex]); }}
        onExit={() => setVolumePickMode(null)} confirmTitle={reloc ? 'Relocate group to this volume' : `Place ${kind.toLowerCase()}`} />
    );
  };
  const door = () => {
    const n = doorPickCandidates.length, ready = !!shape && n > 0, cur = doorPickCandidates[doorPickIndex];
    const boundN = boundCount(f => !!f.doorBound && !isDoorVf(f));
    return (
      <PlacementDock tag="DOOR" defaultName="Door" ready={ready} confirmTitle="Place door"
        lead={<PlacementSelect value={doorPickPlacement} onChange={setDoorPickPlacement} />}
        status={!shape ? noShape
          : n === 0 ? (boundN ? `Click a body face · ${boundN} door ref${boundN === 1 ? '' : 's'}` : 'No door refs — body edges bound the door · click a body face')
          : `Door ${doorPickIndex + 1}/${n} · ${rectTxt(doorPickPlacement === 'inner' ? cur.inner : cur.outer)}${cur.rot ? ' · angled (follows reference)' : ''}`
            + ' — click: next · right-click: place'}
        onConfirm={() => { if (ready && shape) confirmDoorPick(shape.id, doorPickCandidates[doorPickIndex]); }} onExit={() => setDoorPickMode(false)} />
    );
  };
  // ARKALIK şeridi (BackService): tıklama hangi yüzden gelse arka yüze taşınır; tip = Nailed / Grooved.
  const back = () => {
    const n = backPickCandidates.length, ready = !!shape && n > 0, cur = backPickCandidates[backPickIndex];
    const boundN = boundCount(f => vfBackBound(f) && !isBackVf(f));
    return (
      <PlacementDock tag="BACK" defaultName="Back" ready={ready} confirmTitle="Place back panel"
        lead={<BackTypeSelect value={backPickPlacement} onChange={setBackPickPlacement} />}
        status={!shape ? noShape
          : n === 0 ? (boundN ? `Click the body (taken on its back face) · ${boundN} back ref${boundN === 1 ? '' : 's'}`
            : 'No back refs — body edges bound the back · click the body (taken on its back face)')
          : `Back ${backPickIndex + 1}/${n} · ${rectTxt(backPickPlacement === 'inner' ? cur.inner : cur.outer)} — click: next · right-click: place`}
        onConfirm={() => { if (ready && shape) confirmBackPick(shape.id, backPickCandidates[backPickIndex]); }} onExit={() => setBackPickMode(false)} />
    );
  };
  return <>{raycastMode && raycast()}{volumePickMode && volume(volumePickMode)}{doorPickMode && door()}{backPickMode && back()}</>;
}

/* ───────────── SATIR PARÇALARI ───────────── */

export const RowDelBtn = ({ title, onClick }: { title: string; onClick: () => void }) => (
  <button onClick={e => { stop(e); onClick(); }} title={title} className={ROW_DEL_CLASS}><Trash2 size={ROW_ICON - 1} strokeWidth={1.9} /></button>
);
/** Üye etiketi "satır.sıra": sıra = üyenin listedeki yeri; listede yoksa geometrik sıra (i). */
export const memberLabel = (label: string, members: VirtualFace[], vfId: string | undefined, i: number) => {
  const mi = members.findIndex(m => m.id === vfId);
  return `${label}.${(mi >= 0 ? mi : i) + 1}`;
};
/* Şema sırası = geometrik sıra (memberVfIds); numara = listedeki sıra (members) — ikisi farklı olabilir. */
export const memberLabels = (label: string, members: VirtualFace[], ids: string[]) => ids.map((id, i) => memberLabel(label, members, id, i));

/* ───────────── KAPAK DERZİ ───────────── */

/** Kapak derzine bağlı raf/dikme rozeti (grup kartı) + bağı çözme düğmesi. */
export function DoorBondBadge({ g, onUnbind }: { g: PanelGroup; onUnbind: () => void }) {
  const b = g.doorBond;
  if (!b) return null;
  const how = b.align === 'center' ? 'Half overlay — centered on the joint'
    : b.align === 'min' ? 'Full overlay of the lower / left door' : 'Full overlay of the upper / right door';
  return (
    <span className="shrink-0 h-[28px] pl-2 pr-1 inline-flex items-center gap-1 rounded-[7px] bg-orange-50 ring-1 ring-orange-200/70 text-[10.5px] font-semibold text-orange-700"
      title={`Bound to a door joint (${how}): this ${g.kind} follows the doors — when the door sizes change it moves with the joint. `
        + 'Editing its gap here moves the door joint instead. Unbind to free it (it stays where it is).'}>
      <DoorClosed size={12} strokeWidth={2} /><span>Door joint</span>
      <button type="button" onClick={e => { stop(e); onUnbind(); }}
        title="Unbind from the door joint — the panel stays where it is (to delete the panel use the trash button in the row header, or Remove in the door card)"
        className="w-[18px] h-[18px] rounded-md flex items-center justify-center text-orange-500 hover:bg-orange-100 hover:text-orange-800 transition-colors">
        <Unlink size={11} strokeWidth={2.2} />
      </button>
    </span>
  );
}

/** Kapak kartı "Between doors" satırı: derze dikme (V derzi) / raf (H derzi) ekleme modu — yalnız dış kapakta. */
export function JointPanelBar({ outer, pick, joints, added, freeParts, onToggle }: {
  outer: boolean; pick: Ax | null; joints: Record<Ax, number>; added: number; freeParts: number; onToggle: (ax: Ax) => void;
}) {
  const what = (ax: Ax) => (ax === 'u' ? 'divider' : 'shelf');
  const dir = (ax: Ax) => (ax === 'u' ? 'vertical' : 'horizontal');
  const title = (ax: Ax) => (!outer ? `Add a ${what(ax)} between two doors — outer doors only (inner doors sit between the panels).`
    : joints[ax] ? `Add a ${what(ax)} between two ${ax === 'u' ? 'side-by-side' : 'stacked'} doors: pick a ${dir(ax)} joint in the schematic (${joints[ax]}). `
      + `The ${what(ax)} is created behind that joint, listed after this door row, and follows the joint when the doors change.`
    : `No ${dir(ax)} door joint yet — split the door with Split ${ax === 'u' ? 'V' : 'H'} first.`);
  const rm = added ? ' · ✕ Remove to delete' : '';
  return (
    <div className="flex items-center gap-1 mb-1.5">
      <span className={`shrink-0 pl-0.5 pr-1 ${CELL_LABEL}`}>Between doors</span>
      <CardAction compact icon={Columns3} label="Divider" active={pick === 'u'} tone="amber" title={title('u')} onClick={() => onToggle('u')} />
      <CardAction compact icon={Rows3} label="Shelf" active={pick === 'v'} tone="amber" title={title('v')} onClick={() => onToggle('v')} />
      {pick && (
        <DockStatus ready={outer && freeParts > 0}
          text={!outer ? 'Outer doors only'
            : !joints[pick] ? `No ${dir(pick)} joint — split the door first`
            : freeParts ? `Click a ${dir(pick)} joint to add (Shift: all parts)${rm}`
            : `Every part of the ${dir(pick)} joint${joints[pick] > 1 ? 's' : ''} already has a ${what(pick)}${rm}`}
          title={'The highlighted gaps between doors are the joints you can place the panel at — a joint crossed by a divider / shelf is split into parts, '
            + 'each part takes its own panel (its own row in the list). A panel already added between doors shows ✕ Remove. Esc cancels.'} />
      )}
    </div>
  );
}

/* ───────────── ŞEMA BÖLGE SEÇİMİ (kapak / arkalık) ───────────── */

export type NodeSel = { id: string; nodes: string[] } | null;
/** Verilen düğümlerin yaprak id'leri (sırayla; tekrar edebilir). */
export const leafIdsUnder = (tree: TreeNode, ids: string[]) =>
  ids.flatMap(id => { const n = findNode(tree, id); return n ? treeLeaves(n).map(l => l.id) : []; });

/** Kapak ve arkalık kartının ortak bölge seçimi + bölmesi; yalnız ağaç, servis ve adlar farklı (`whole` / `one`: tüm alan / tek parça). */
export function regionTools<N extends TreeNode>(o: {
  gid: string; tree: N; sel: NodeSel; setSel: (s: NodeSel) => void; depthOf: (id: string) => number | undefined;
  split: (gid: string, nodeId: string, ax: Ax, n: number) => string | null; splitAt: (gid: string, vfId: string) => string[];
  live: () => N | undefined; endRefPick: () => void; whole: string; one: string;
}) {
  const { gid, tree, setSel } = o;
  const picked = o.sel?.id === gid ? o.sel.nodes.filter(id => !!findNode(tree, id)) : [];
  const primaryId = picked[picked.length - 1] as string | undefined;
  const primary = primaryId ? findNode(tree, primaryId) : null;
  const splitNode = primary ?? tree;
  const scope = picked.length ? picked : [tree.id];
  const select = (ids: string[]) => setSel(ids.length ? { id: gid, nodes: ids } : null);
  const regionName = !primary ? o.whole
    : primary.kind === 'leaf' ? o.one : `the selected region (${primary.axis === 'u' ? 'V' : 'H'} ×${primary.children.length})`;
  return {
    picked, splitNode, scope, select, regionName,
    countOf: (ax: Ax) => (splitNode.kind === 'split' && splitNode.axis === ax ? splitNode.children.length : 1),
    // Sonuç bölge seçili kalır (ardışık ayar).
    setCount: (ax: Ax, n: number) => select(scope.map(id => o.split(gid, id, ax, n)).filter((x): x is string => !!x)),
    countTitle: (ax: Ax) => `${ax === 'u' ? 'Split V — pieces side by side' : 'Split H — pieces stacked'} in ${regionName}. `
      + `Type or step the number of pieces (1 = not split on this axis). ${splitNode.kind === 'split' && splitNode.axis !== ax
        ? 'This region is already split the other way: splitting here keeps that split in every new piece (e.g. V ×2 then H ×2 = 2 rows × 2 columns).' : ''}`
      + (picked.length > 1 ? ` Applies to ${picked.length} selected regions.` : ''),
    // Seçili düğüm yoldaysa bir seviye iner; yaprak tekrar tıklanırsa seçim kalkar; yolda değilse kök. Shift: aynı derinlikte çoklu seçim.
    onPathClick: (path: string[], additive: boolean) => {
      if (!path.length) return;
      if (!additive) {
        const i = primaryId ? path.indexOf(primaryId) : -1;
        setSel(i < 0 ? { id: gid, nodes: [path[0]] } : i >= path.length - 1 ? null : { id: gid, nodes: [path[i + 1]] });
        return;
      }
      const depth = primaryId ? (o.depthOf(primaryId) ?? path.length - 1) : path.length - 1;
      const node = path[Math.min(depth, path.length - 1)];
      select(picked.includes(node) ? picked.filter(x => x !== node) : [...picked, node]);
    },
    onRefPick: (vfId: string) => { const ids = o.splitAt(gid, vfId); if (ids.length) { o.endRefPick(); setSel({ id: gid, nodes: ids }); } },
    // Sonradan konan sınır levhası: levhanın ortasından bölünür (Half) ve sol/üst parça seçilir → aynı rozet Full/Half/None döner.
    onSplitAtPanel: (vfId: string) => {
      const ids = o.splitAt(gid, vfId);
      if (!ids.length) return;
      const live = o.live();
      const sp = live ? findNode(live, ids[0]) : null;
      const leafId = sp && sp.kind === 'split' ? sp.children[0]?.id : undefined;
      useAppStore.getState().setSelectedPanelRow(null);
      setSel({ id: gid, nodes: leafId ? [leafId] : ids });
    },
  };
}
