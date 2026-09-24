import React, { useState, useEffect } from 'react';
import { X, GripVertical, Plus, Check, Trash2, Spline, Layers, Radius } from 'lucide-react';
import { ToolChip, ToolChipBar } from './ToolbarChips';
import { useAppStore } from '../store';
import * as THREE from 'three';
import { evaluateExpression } from './Expression';
import { applyShapeChanges, applySubtractionChanges } from './ShapeUpdaterService';

interface CustomParameter {
  id: string;
  name: string;
  expression: string;
  result: number;
  description: string;
}

interface ParametersPanelProps {
  isOpen: boolean;
  onClose: () => void;
  embedded?: boolean;
}

interface SubtractionParam {
  expression: string;
  result: number;
}

interface ParameterRowProps {
  label: string;
  value: number;
  onChange?: (value: number) => void;
  display?: string;
  description: string;
  step?: number;
  readOnly?: boolean;
}

/* ── PARAMETRE PANELİ TASARIM DİLİ (Panel Editör ile birebir) ─────────────
   Satırlar panel listesiyle aynı soft kart: sıcak kemik zemin, kıl-çizgi kenar,
   2px aralık. Bölüm başlıkları "İşlem adımları" başlığıyla aynı. Değer alanı
   kutusuz (yago-param-input; bone-skin genel input kutusunu ezer). NOT: bone-skin
   `.text-xs.font-semibold` birleşimini başlık ("eyebrow") yapar — satırlarda
   bilinçli olarak text-[11px] kullanılır. */
const P_ROW = 'group/prow flex items-center gap-1.5 h-[30px] pl-1 pr-1 rounded-[9px] bg-[#fdfcfa] ring-1 ring-[#ece7df] shadow-[0_1px_0_rgba(68,64,60,0.025)] hover:bg-white hover:ring-[#e2dbd0] focus-within:!bg-white focus-within:!ring-[#f0d6ba] transition-colors duration-150';
const P_LABEL = 'shrink-0 w-[30px] text-center text-[11px] font-semibold tracking-wide tabular-nums select-none';
const P_INPUT = 'yago-param-input shrink-0 w-[84px] h-[22px] px-1.5 text-[12px] font-mono tabular-nums text-stone-800 bg-transparent border border-transparent rounded-[6px] outline-none placeholder:text-stone-300 hover:border-[#ebe5dc] focus:bg-white focus:border-orange-400/50 transition-colors';
const P_RESULT = 'shrink-0 w-[56px] text-right text-[11px] tabular-nums text-stone-400 select-none';
const P_DESC = 'flex-1 min-w-0 truncate pl-1 text-[11px] text-stone-400 select-none';
const P_NOTE = 'yago-row-note flex-1 min-w-0 h-[22px] px-[5px] text-[11.5px] text-stone-600 bg-transparent border border-transparent rounded-[5px] outline-none placeholder:text-stone-300 hover:border-[#ebe5dc] focus:bg-white focus:border-orange-400/50 transition-colors';
const P_ICON_BTN = 'shrink-0 w-5 h-5 rounded-md flex items-center justify-center text-stone-400 hover:bg-[#f3efe8] hover:text-stone-700 transition-colors duration-150';

const ParamSection: React.FC<{ title: string; count?: number; accent?: string; right?: React.ReactNode; children: React.ReactNode }> = ({ title, count, accent, right, children }) => (
  <div className="mt-3 first:mt-0">
    <div className="px-1 pb-1.5 flex items-center gap-2">
      <span style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: accent || '#b5ada3', fontFamily: "'Inter','SF Pro Text',system-ui,sans-serif" }}>{title}</span>
      {count !== undefined && <span className="text-[10px] font-medium tabular-nums text-stone-300">{count}</span>}
      <div className="flex-1 h-px bg-[#efeae2]" />
      {right}
    </div>
    <div className="flex flex-col gap-[2px] p-px">{children}</div>
  </div>
);

interface ParameterRowFullProps extends ParameterRowProps { unit?: string; labelColor?: string; trailing?: React.ReactNode }

const ParameterRow: React.FC<ParameterRowFullProps> = ({ label, value, onChange, display, unit, description, readOnly = false, labelColor, trailing }) => {
  const [inputValue, setInputValue] = useState(value.toString());
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => { if (!isFocused) setInputValue(value.toString()); }, [value, isFocused]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setInputValue(v);
    if (onChange && !readOnly && v !== '' && v !== '-' && v !== '+' && v !== '.') {
      const p = parseFloat(v);
      if (!isNaN(p)) onChange(p);
    }
  };

  const handleBlur = () => {
    setIsFocused(false);
    if (onChange && !readOnly) {
      const p = parseFloat(inputValue);
      if (isNaN(p)) setInputValue(value.toString());
      else { onChange(p); setInputValue(p.toString()); }
    }
  };

  return (
    <div className={P_ROW}>
      <span className={P_LABEL} style={{ color: labelColor || '#a8a29e' }}>{label}</span>
      <input type="text" value={inputValue} onChange={handleChange} onFocus={() => setIsFocused(true)} onBlur={handleBlur} readOnly={readOnly}
        className={P_INPUT} />
      {unit !== undefined
        ? <span className="shrink-0 w-[56px] -ml-1 text-left text-[11px] text-stone-400 select-none">{unit}</span>
        : <span className={P_RESULT}>{display ?? value.toFixed(2)}</span>}
      <span className={P_DESC}>{description}</span>
      {trailing}
    </div>
  );
};

export function ParametersPanel({ isOpen, onClose, embedded = false }: ParametersPanelProps) {
  const {
    selectedShapeId, shapes, updateShape, vertexEditMode, setVertexEditMode,
    subtractionViewMode, setSubtractionViewMode, selectedSubtractionIndex, setSelectedSubtractionIndex,
    deleteSubtraction, setShowParametersPanel, filletMode, setFilletMode, faceEditMode, setFaceEditMode,
    selectedFilletFaces, clearFilletFaces, clearFilletFaceData,
  } = useAppStore();

  const [position, setPosition] = useState({ x: 100, y: 100 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [depth, setDepth] = useState(0);
  const [rotX, setRotX] = useState(0);
  const [rotY, setRotY] = useState(0);
  const [rotZ, setRotZ] = useState(0);
  const [customParameters, setCustomParameters] = useState<CustomParameter[]>([]);
  const [vertexModifications, setVertexModifications] = useState<any[]>([]);
  const [filletRadii, setFilletRadii] = useState<number[]>([]);

  const initSubParam = (v = 0): SubtractionParam => ({ expression: String(v), result: v });
  const [subParams, setSubParams] = useState({
    width: initSubParam(), height: initSubParam(), depth: initSubParam(),
    posX: initSubParam(), posY: initSubParam(), posZ: initSubParam(),
    rotX: initSubParam(), rotY: initSubParam(), rotZ: initSubParam()
  });

  const selectedShape = shapes.find((s) => s.id === selectedShapeId);

  const getEvalContext = () => ({
    W: width, H: height, D: depth,
    ...customParameters.reduce((acc, p) => ({ ...acc, [p.name]: p.result }), {})
  });

  useEffect(() => {
    if (selectedShape?.parameters) {
      setWidth(selectedShape.parameters.width || 0);
      setHeight(selectedShape.parameters.height || 0);
      setDepth(selectedShape.parameters.depth || 0);
      setRotX((selectedShape.rotation?.[0] || 0) * (180 / Math.PI));
      setRotY((selectedShape.rotation?.[1] || 0) * (180 / Math.PI));
      setRotZ((selectedShape.rotation?.[2] || 0) * (180 / Math.PI));
      setCustomParameters(selectedShape.parameters.customParameters || []);
      setVertexModifications(selectedShape.vertexModifications || []);
      setFilletRadii((selectedShape.fillets || []).map((f: any) => f.radius));
    } else {
      setWidth(0); setHeight(0); setDepth(0);
      setRotX(0); setRotY(0); setRotZ(0);
      setCustomParameters([]); setVertexModifications([]); setFilletRadii([]);
    }
  }, [selectedShape, selectedShapeId, shapes]);

  useEffect(() => {
    if (!selectedShape || selectedSubtractionIndex === null || !selectedShape.subtractionGeometries) return;
    const subtraction = selectedShape.subtractionGeometries[selectedSubtractionIndex];
    if (!subtraction) return;

    const subGeo = subtraction.geometry;
    if (!subGeo) return;
    const subBox = new THREE.Box3().setFromBufferAttribute(subGeo.getAttribute('position'));
    const subSize = new THREE.Vector3();
    subBox.getSize(subSize);

    const params = subtraction.parameters;
    const ctx = getEvalContext();

    const sw = params?.width ?? String(subSize.x);
    const sh = params?.height ?? String(subSize.y);
    const sd = params?.depth ?? String(subSize.z);
    const px = params?.posX ?? String(subtraction.relativeOffset?.[0] || 0);
    const py = params?.posY ?? String(subtraction.relativeOffset?.[1] || 0);
    const pz = params?.posZ ?? String(subtraction.relativeOffset?.[2] || 0);
    const rx = params?.rotX ?? String((subtraction.relativeRotation?.[0] || 0) * (180 / Math.PI));
    const ry = params?.rotY ?? String((subtraction.relativeRotation?.[1] || 0) * (180 / Math.PI));
    const rz = params?.rotZ ?? String((subtraction.relativeRotation?.[2] || 0) * (180 / Math.PI));

    setSubParams({
      width: { expression: sw, result: evaluateExpression(sw, ctx) },
      height: { expression: sh, result: evaluateExpression(sh, ctx) },
      depth: { expression: sd, result: evaluateExpression(sd, ctx) },
      posX: { expression: px, result: evaluateExpression(px, ctx) },
      posY: { expression: py, result: evaluateExpression(py, ctx) },
      posZ: { expression: pz, result: evaluateExpression(pz, ctx) },
      rotX: { expression: rx, result: evaluateExpression(rx, ctx) },
      rotY: { expression: ry, result: evaluateExpression(ry, ctx) },
      rotZ: { expression: rz, result: evaluateExpression(rz, ctx) },
    });
  }, [selectedShape?.id, selectedSubtractionIndex, selectedShape?.subtractionGeometries?.length, width, height, depth, customParameters]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging) { e.preventDefault(); setPosition({ x: e.clientX - dragOffset.x, y: e.clientY - dragOffset.y }); }
    };
    const handleMouseUp = () => setIsDragging(false);
    if (isDragging) {
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'grabbing';
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragOffset]);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    setDragOffset({ x: e.clientX - position.x, y: e.clientY - position.y });
  };

  const handleClose = () => {
    setSubtractionViewMode(false); setVertexEditMode(false); setFilletMode(false);
    setFaceEditMode(false); clearFilletFaces(); clearFilletFaceData();
    setSelectedSubtractionIndex(null); setShowParametersPanel(false); onClose();
  };

  const handleSubParamChange = (param: string, expression: string) => {
    const result = evaluateExpression(expression, getEvalContext());
    setSubParams(prev => ({ ...prev, [param]: { expression, result } }));
  };

  const addCustomParameter = () => {
    const newParam: CustomParameter = { id: `param-${Date.now()}`, name: `P${customParameters.length + 1}`, expression: '0', result: 0, description: 'Custom Parameter' };
    const updated = [...customParameters, newParam];
    setCustomParameters(updated);
    if (selectedShape) updateShape(selectedShape.id, { parameters: { ...selectedShape.parameters, customParameters: updated } });
  };

  const updateCustomParameter = (id: string, field: keyof CustomParameter, value: string) => {
    const updated = customParameters.map(param => {
      if (param.id !== id) return param;
      const p = { ...param, [field]: value };
      if (field === 'expression') p.result = evaluateExpression(value, getEvalContext());
      return p;
    });
    setCustomParameters(updated);
  };

  const deleteCustomParameter = (id: string) => {
    const updated = customParameters.filter(p => p.id !== id);
    setCustomParameters(updated);
    if (selectedShape) updateShape(selectedShape.id, { parameters: { ...selectedShape.parameters, customParameters: updated } });
  };

  const updateVertexModification = (index: number, field: string, value: any) => {
    const updated = vertexModifications.map((mod, idx) => {
      if (idx !== index) return mod;
      const u = { ...mod, [field]: value };
      if (field === 'expression') {
        const result = evaluateExpression(value, getEvalContext());
        const sign = mod.direction.includes('-') ? -1 : 1;
        const axis = mod.direction[0];
        u.offset = axis === 'x' ? [result * sign, 0, 0] : axis === 'y' ? [0, result * sign, 0] : [0, 0, result * sign];
        u.newPosition = mod.originalPosition.map((v: number, i: number) => v + u.offset[i]);
      }
      return u;
    });
    setVertexModifications(updated);
  };

  const handleApplyChanges = async () => {
    const currentShape = useAppStore.getState().shapes.find(s => s.id === selectedShapeId);
    if (!currentShape) return;
    const pos: [number, number, number] = [...currentShape.position as [number, number, number]];
    const ctx = getEvalContext();
    const ev = (k: keyof typeof subParams) => ({ expression: subParams[k].expression, result: evaluateExpression(subParams[k].expression, ctx) });
    const evalSub = { width: ev('width'), height: ev('height'), depth: ev('depth'), posX: ev('posX'), posY: ev('posY'), posZ: ev('posZ'), rotX: ev('rotX'), rotY: ev('rotY'), rotZ: ev('rotZ') };

    await applyShapeChanges({
      selectedShape: { ...currentShape, position: pos }, width, height, depth, rotX, rotY, rotZ,
      customParameters, vertexModifications, filletRadii, selectedSubtractionIndex,
      subWidth: evalSub.width.result, subHeight: evalSub.height.result, subDepth: evalSub.depth.result,
      subPosX: evalSub.posX.result, subPosY: evalSub.posY.result, subPosZ: evalSub.posZ.result,
      subRotX: evalSub.rotX.result, subRotY: evalSub.rotY.result, subRotZ: evalSub.rotZ.result,
      subParams: evalSub, updateShape
    });
    if (selectedShapeId) {
      const { rebuildPanelsForParent } = await import('./PanelRebuildService');
      await rebuildPanelsForParent(selectedShapeId);
    }
  };

  const handleDeleteFillet = async (filletIndex: number) => {
    const currentShape = useAppStore.getState().shapes.find(s => s.id === selectedShapeId);
    if (!currentShape) return;
    const newFillets = (currentShape.fillets || []).filter((_: any, i: number) => i !== filletIndex);
    const newFilletRadii = filletRadii.filter((_, i) => i !== filletIndex);

    try {
      const { createReplicadBox, performBooleanCut, convertReplicadToThreeGeometry } = await import('./ReplicadService');
      const { getReplicadVertices } = await import('./VertexEditorService');
      const { applyFillets, updateFilletCentersForNewGeometry } = await import('./ShapeUpdaterService');

      let baseShape = await createReplicadBox({ width, height, depth });

      for (const sub of (currentShape.subtractionGeometries || [])) {
        if (!sub) continue;
        const subBox = new THREE.Box3().setFromBufferAttribute(sub.geometry.getAttribute('position'));
        const subSize = new THREE.Vector3();
        subBox.getSize(subSize);
        const subShape = await createReplicadBox({ width: subSize.x, height: subSize.y, depth: subSize.z });
        baseShape = await performBooleanCut(baseShape, subShape, undefined, sub.relativeOffset, undefined, sub.relativeRotation || [0, 0, 0], undefined, sub.scale || [1, 1, 1]);
      }

      let finalGeometry = convertReplicadToThreeGeometry(baseShape);
      let finalBaseVertices = await getReplicadVertices(baseShape);
      let finalShape = baseShape;
      let updatedFillets = newFillets;

      if (newFillets.length > 0) {
        updatedFillets = await updateFilletCentersForNewGeometry(newFillets, finalGeometry, { width, height, depth });
        finalShape = await applyFillets(finalShape, updatedFillets, { width, height, depth });
        finalGeometry = convertReplicadToThreeGeometry(finalShape);
        finalBaseVertices = await getReplicadVertices(finalShape);
      }

      updateShape(currentShape.id, {
        geometry: finalGeometry, replicadShape: finalShape, fillets: updatedFillets,
        position: [...currentShape.position] as [number, number, number],
        parameters: { ...currentShape.parameters, scaledBaseVertices: finalBaseVertices.map((v: any) => [v.x, v.y, v.z]) }
      });
      setFilletRadii(newFilletRadii);
    } catch (error) {
      console.error('Failed to delete fillet:', error);
    }
  };

  const renderSubParamRow = (label: string, param: SubtractionParam, paramKey: string, description: string) => (
    <div key={paramKey} className={P_ROW}>
      <span className={P_LABEL} style={{ color: '#b45309' }}>{label}</span>
      <input type="text" value={param.expression} onChange={e => handleSubParamChange(paramKey, e.target.value)} className={P_INPUT} placeholder="expr" />
      <span className={P_RESULT}>{param.result.toFixed(2)}</span>
      <span className={P_DESC}>{description}</span>
    </div>
  );

  if (!isOpen && !embedded) return null;

  const subtractionCount = selectedShape?.subtractionGeometries?.filter((s: any) => s !== null).length ?? 0;

  // ÜST ARAÇ ÇUBUĞU — Panel Editor ile ORTAK bileşen (ToolbarChips). Mantık aynı.
  const paramToolbar = (
    <ToolChipBar>
      <ToolChip label="Vertex" icon={Spline} active={vertexEditMode}
        onClick={() => { setVertexEditMode(!vertexEditMode); if (!vertexEditMode) { setFilletMode(false); setFaceEditMode(false); } }} title="Edit vertices" />
      {subtractionCount > 0 && (
        <ToolChip label="Subtract" icon={Layers} active={subtractionViewMode} badge={subtractionCount}
          onClick={() => { setSubtractionViewMode(!subtractionViewMode); if (!subtractionViewMode) { setFilletMode(false); setFaceEditMode(false); } }} title="Show subtractions" />
      )}
      <ToolChip label="Fillet" icon={Radius} active={filletMode} badge={selectedFilletFaces.length > 0 ? `${selectedFilletFaces.length}/2` : undefined}
        onClick={() => { const n = !filletMode; setFilletMode(n); setFaceEditMode(n); clearFilletFaces(); clearFilletFaceData(); if (n) { setVertexEditMode(false); setSubtractionViewMode(false); } }} title="Fillet two faces" />
      <ToolChip label="Parameter" icon={Plus} onClick={addCustomParameter} title="Add a custom parameter" />
    </ToolChipBar>
  );

  const paramContent = selectedShape ? (
    <div>
      {/* ÖLÇÜLER — alt alta (Goker): Genişlik / Yükseklik / Derinlik */}
      <ParamSection title="Dimensions">
        <ParameterRow label="W" value={width} onChange={setWidth} unit="mm" description="Width" />
        <ParameterRow label="H" value={height} onChange={setHeight} unit="mm" description="Height" />
        <ParameterRow label="D" value={depth} onChange={setDepth} unit="mm" description="Depth" />
      </ParamSection>

      <ParamSection title="Rotation">
        {([['RX', rotX, setRotX, 'X axis'], ['RY', rotY, setRotY, 'Y axis'], ['RZ', rotZ, setRotZ, 'Z axis']] as Array<[string, number, (v: number) => void, string]>).map(([label, val, set, desc]) => (
          <ParameterRow key={label} label={label} value={val} onChange={set} unit="°" description={desc} step={1} />
        ))}
      </ParamSection>

      {filletRadii.length > 0 && (
        <ParamSection title="Fillet" count={filletRadii.length}>
          {filletRadii.map((radius, idx) => (
            <ParameterRow key={`fillet-${idx}`} label={`F${idx + 1}`} value={radius}
              onChange={v => { const r = [...filletRadii]; r[idx] = v; setFilletRadii(r); }}
              unit="mm" description={`Fillet ${idx + 1} radius`} step={0.1}
              trailing={
                <button onClick={() => selectedShape && handleDeleteFillet(idx)} title="Delete fillet"
                  className={`${P_ICON_BTN} opacity-0 group-hover/prow:opacity-100 hover:!bg-red-50 hover:!text-red-500`}><Trash2 size={11.5} strokeWidth={1.9} /></button>
              } />
          ))}
        </ParamSection>
      )}

      {customParameters.length > 0 && (
        <ParamSection title="Parameters" count={customParameters.length}>
          {customParameters.map(param => (
            <div key={param.id} className={P_ROW}>
              <input type="text" value={param.name} onChange={e => updateCustomParameter(param.id, 'name', e.target.value)}
                className={`${P_INPUT} !w-[40px] text-center !font-semibold`} />
              <input type="text" value={param.expression} onChange={e => updateCustomParameter(param.id, 'expression', e.target.value)}
                className={`${P_INPUT} !w-[74px]`} placeholder="expr" />
              <span className={P_RESULT}>{param.result.toFixed(2)}</span>
              <input type="text" value={param.description} onChange={e => updateCustomParameter(param.id, 'description', e.target.value)}
                className={P_NOTE} placeholder="note…" />
              <button onClick={() => deleteCustomParameter(param.id)} title="Delete"
                className={`${P_ICON_BTN} opacity-0 group-hover/prow:opacity-100 hover:!bg-red-50 hover:!text-red-500`}><Trash2 size={11.5} strokeWidth={1.9} /></button>
            </div>
          ))}
        </ParamSection>
      )}

      {subtractionViewMode && selectedSubtractionIndex !== null && selectedShape.subtractionGeometries?.[selectedSubtractionIndex] && (
        <ParamSection title={`Subtraction #${selectedSubtractionIndex + 1}`} accent="#b45309"
          right={
            <div className="flex items-center gap-px">
              <button onClick={async () => { if (selectedShape && selectedSubtractionIndex !== null) await deleteSubtraction(selectedShape.id, selectedSubtractionIndex); }}
                className={`${P_ICON_BTN} hover:!bg-red-50 hover:!text-red-500`} title="Delete subtraction"><Trash2 size={11.5} strokeWidth={1.9} /></button>
              <button onClick={() => setSelectedSubtractionIndex(null)} className={P_ICON_BTN} title="Close"><X size={12} strokeWidth={2} /></button>
            </div>
          }>
          {renderSubParamRow('W', subParams.width, 'width', 'Width')}
          {renderSubParamRow('H', subParams.height, 'height', 'Height')}
          {renderSubParamRow('D', subParams.depth, 'depth', 'Depth')}
          {renderSubParamRow('X', subParams.posX, 'posX', 'Position X')}
          {renderSubParamRow('Y', subParams.posY, 'posY', 'Position Y')}
          {renderSubParamRow('Z', subParams.posZ, 'posZ', 'Position Z')}
          {renderSubParamRow('RX', subParams.rotX, 'rotX', 'Rotation X')}
          {renderSubParamRow('RY', subParams.rotY, 'rotY', 'Rotation Y')}
          {renderSubParamRow('RZ', subParams.rotZ, 'rotZ', 'Rotation Z')}
        </ParamSection>
      )}

      {vertexEditMode && vertexModifications.length > 0 && (
        <ParamSection title="Vertex edits" count={vertexModifications.length}>
          {vertexModifications.map((mod, idx) => {
            const result = evaluateExpression(mod.expression, getEvalContext());
            return (
              <div key={idx} className={P_ROW}>
                <span className={P_LABEL} style={{ color: '#a8a29e' }}>V{mod.vertexIndex}</span>
                <input type="text" value={mod.expression} onChange={e => updateVertexModification(idx, 'expression', e.target.value)} className={P_INPUT} placeholder="expr" />
                <span className={P_RESULT}>{result.toFixed(2)}</span>
                <input type="text" value={mod.description || ''} onChange={e => updateVertexModification(idx, 'description', e.target.value)}
                  className={P_NOTE} placeholder="note…" />
              </div>
            );
          })}
        </ParamSection>
      )}

      {/* Uygula — Panel Editör'ün onay düğmesiyle aynı koyu taş dil. */}
      <button onClick={handleApplyChanges}
        className="w-full mt-3 h-[30px] rounded-[8px] bg-[#44403c] text-white text-[11.5px] font-semibold tracking-[0.01em] shadow-[0_1px_3px_rgba(40,30,20,0.22)] hover:bg-[#57534e] active:bg-[#292524] transition-colors duration-150 flex items-center justify-center gap-1.5">
        <Check size={13} strokeWidth={2.4} /> Apply
      </button>
    </div>
  ) : (
    <div className="text-center text-stone-400 text-[11.5px] py-6">No shape selected</div>
  );

  if (embedded) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <div className="px-3 py-2 border-b border-stone-100 flex items-center justify-between shrink-0">
          {paramToolbar}
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-1.5 pt-2 pb-2">
          {paramContent}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed bg-white rounded-md shadow-lg border border-stone-200 z-50" style={{ left: `${position.x}px`, top: `${position.y}px`, width: '370px' }}>
      <div className="flex items-center justify-between px-2.5 py-1.5 bg-stone-50 border-b border-stone-200 rounded-t-md select-none"
        style={{ cursor: isDragging ? 'grabbing' : 'grab' }} onMouseDown={handleMouseDown}>
        <div className="flex items-center gap-1.5">
          <GripVertical size={12} className="text-stone-300" />
          <span className="text-xs font-semibold text-stone-600 tracking-wide uppercase">Parameters</span>
        </div>
        <div className="flex items-center gap-1">
          {paramToolbar}
          <button onClick={handleClose} className="p-0.5 hover:bg-stone-200 rounded transition-colors" title="Close">
            <X size={12} className="text-stone-400" />
          </button>
        </div>
      </div>
      <div className="px-1.5 pt-2 pb-2 max-h-[calc(100vh-200px)] overflow-y-auto">
        {paramContent}
      </div>
    </div>
  );
}
