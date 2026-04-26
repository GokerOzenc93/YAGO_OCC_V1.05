import React, { useState, useEffect } from 'react';
import { X, GripVertical, Plus, Check, Trash2 } from 'lucide-react';
import { useAppStore } from '../store';
import type { FaceRole } from '../store';
import * as THREE from 'three';
import { evaluateExpression } from './Expression';
import { applyShapeChanges, applySubtractionChanges } from './ShapeUpdaterService';
import { extractFacesFromGeometry, groupCoplanarFaces } from './FaceEditor';
import type { FilletData } from './Fillet';

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

const inputBase = 'px-1 py-0.5 text-xs font-mono border border-gray-300 rounded';
const inputRO = `${inputBase} bg-white text-gray-400`;

const ParameterRow: React.FC<ParameterRowProps> = ({ label, value, onChange, display, description, readOnly = false }) => {
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
    <div className="flex gap-0.5 items-center">
      <input type="text" value={label} readOnly tabIndex={-1} className={`w-10 ${inputBase} bg-white text-gray-800 text-center`} />
      <input type="text" value={inputValue} onChange={handleChange} onFocus={() => setIsFocused(true)} onBlur={handleBlur} readOnly={readOnly}
        className={`w-16 ${inputBase} ${readOnly ? 'text-gray-400' : 'text-gray-800'} bg-white text-left`} />
      <input type="text" value={display ?? value.toFixed(2)} readOnly tabIndex={-1} className={`w-16 ${inputRO} text-left`} />
      <input type="text" value={description} readOnly tabIndex={-1} className="flex-1 px-2 py-0.5 text-xs bg-white text-gray-600 border border-gray-300 rounded" />
    </div>
  );
};

export function ParametersPanel({ isOpen, onClose }: ParametersPanelProps) {
  const {
    selectedShapeId, shapes, updateShape, vertexEditMode, setVertexEditMode,
    subtractionViewMode, setSubtractionViewMode, selectedSubtractionIndex, setSelectedSubtractionIndex,
    deleteSubtraction, setShowParametersPanel, filletMode, setFilletMode, faceEditMode, setFaceEditMode,
    selectedFilletFaces, clearFilletFaces, clearFilletFaceData, roleEditMode, setRoleEditMode,
    updateFaceRole, backPanelLeftExtend, setBackPanelLeftExtend, showBackPanelLeftExtend, setShowBackPanelLeftExtend,
    backPanelRightExtend, setBackPanelRightExtend, showBackPanelRightExtend, setShowBackPanelRightExtend,
    recalculateVirtualFacesForShape
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
    const handleBottomPanelSelection = async () => {
      if (selectedShape?.type === 'panel' && selectedShape.parameters?.faceRole === 'Bottom' && selectedShape.parameters?.parentShapeId) {
        const { globalSettingsService } = await import('./GlobalSettingsDatabase');
        const { resolveAllPanelJoints } = await import('./PanelJointService');
        const defaultProfile = await globalSettingsService.getDefaultProfile();
        if (defaultProfile) {
          const { setShapeRebuilding } = useAppStore.getState();
          const parentId = selectedShape.parameters.parentShapeId;
          setShapeRebuilding(parentId, true);
          try { await resolveAllPanelJoints(parentId, defaultProfile.id); }
          finally { setShapeRebuilding(parentId, false); }
        }
      }
    };
    handleBottomPanelSelection();
  }, [selectedShapeId]);

  useEffect(() => {
    if (!selectedShape || selectedSubtractionIndex === null || !selectedShape.subtractionGeometries) return;
    const subtraction = selectedShape.subtractionGeometries[selectedSubtractionIndex];
    if (!subtraction) return;
    const { relativeOffset: [px = 0, py = 0, pz = 0] = [], relativeRotation: [rx = 0, ry = 0, rz = 0] = [], parameters } = subtraction;
    const sw = parameters?.width || subtraction.geometrySize?.[0] || 0;
    const sh = parameters?.height || subtraction.geometrySize?.[1] || 0;
    const sd = parameters?.depth || subtraction.geometrySize?.[2] || 0;
    setSubParams({
      width: initSubParam(sw), height: initSubParam(sh), depth: initSubParam(sd),
      posX: initSubParam(px), posY: initSubParam(py), posZ: initSubParam(pz),
      rotX: initSubParam(rx * (180 / Math.PI)), rotY: initSubParam(ry * (180 / Math.PI)), rotZ: initSubParam(rz * (180 / Math.PI)),
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
    setFaceEditMode(false); setRoleEditMode(false); clearFilletFaces(); clearFilletFaceData();
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
      }
      return u;
    });
    setVertexModifications(updated);
    if (selectedShape) updateShape(selectedShape.id, { vertexModifications: updated });
  };

  const handleApplyChanges = () => {
    if (!selectedShape) return;
    const rx = rotX * (Math.PI / 180), ry = rotY * (Math.PI / 180), rz = rotZ * (Math.PI / 180);
    updateShape(selectedShape.id, {
      parameters: { ...selectedShape.parameters, width, height, depth, customParameters },
      rotation: [rx, ry, rz] as [number, number, number],
      vertexModifications,
      fillets: filletRadii.map((radius, idx) => selectedShape.fillets?.[idx] ? { ...selectedShape.fillets[idx], radius } : { radius, edgeIndices: [] })
    });
    if (selectedShape.type === 'panel' && selectedShape.parameters?.parentShapeId) {
      recalculateVirtualFacesForShape(selectedShape.parameters.parentShapeId);
    }
  };

  const renderSubParam = (label: string, param: SubtractionParam, paramKey: string, description: string) => (
    <div key={paramKey} className="flex gap-0.5 items-center">
      <input type="text" value={label} readOnly tabIndex={-1} className={`w-10 ${inputBase} bg-white text-gray-800 text-center`} />
      <input type="text" value={param.expression} onChange={e => handleSubParamChange(paramKey, e.target.value)} className={`w-16 ${inputBase} bg-white text-gray-800`} placeholder="expr" />
      <input type="text" value={param.result.toFixed(2)} readOnly tabIndex={-1} className={`w-16 ${inputRO} text-left`} />
      <input type="text" value={description} readOnly tabIndex={-1} className="flex-1 px-2 py-0.5 text-xs bg-white text-gray-600 border border-gray-300 rounded" />
    </div>
  );

  const renderBackPanelExtend = (label: string, value: number, onChange: (v: number) => void, description: string, onRemove: () => void) => (
    <div className="flex gap-0.5 items-center">
      <input type="text" value={label} readOnly tabIndex={-1} className={`w-10 ${inputBase} bg-orange-100 text-orange-800 border-orange-300 text-center`} />
      <input type="number" value={value} onChange={e => onChange(Number(e.target.value))}
        className={`w-16 ${inputBase} bg-white text-gray-800 border-orange-300 text-left [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`} />
      <input type="text" value={value.toFixed(2)} readOnly tabIndex={-1} className={`w-16 ${inputRO} text-left`} />
      <input type="text" value={description} readOnly tabIndex={-1} className="flex-1 px-2 py-0.5 text-xs bg-white text-gray-600 border border-gray-300 rounded" />
      <button onClick={onRemove} className="p-0.5 hover:bg-red-100 rounded transition-colors" title="Remove"><X size={12} className="text-red-600" /></button>
    </div>
  );

  if (!isOpen) return null;

  const subtractionCount = selectedShape?.subtractionGeometries?.filter((s: any) => s !== null).length ?? 0;
  const roleOptions: FaceRole[] = ['extrude', 'offset', 'bevel'];
  const faceDescriptions = selectedShape?.faceDescriptions || {};

  return (
    <div className="fixed bg-white rounded-lg shadow-2xl border border-stone-300 z-50" style={{ left: `${position.x}px`, top: `${position.y}px`, width: '410px' }}>
      <div className="flex items-center justify-between px-3 py-2 bg-stone-100 border-b border-stone-300 rounded-t-lg select-none"
        style={{ cursor: isDragging ? 'grabbing' : 'grab' }} onMouseDown={handleMouseDown}>
        <div className="flex items-center gap-2">
          <GripVertical size={14} className="text-stone-400" />
          <span className="text-sm font-semibold text-slate-800">Parameters</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => { setVertexEditMode(!vertexEditMode); if (!vertexEditMode) { setFilletMode(false); setFaceEditMode(false); setRoleEditMode(false); } }}
            className={`px-2 py-1 text-[10px] font-medium rounded transition-colors ${vertexEditMode ? 'bg-orange-100 text-orange-600 ring-1 ring-orange-200' : 'text-stone-600 hover:bg-stone-200'}`}
            title="Vertex Edit Mode"
          >
            VERTEX
          </button>
          <button
            onClick={() => { setRoleEditMode(!roleEditMode); if (!roleEditMode) { setVertexEditMode(false); setFilletMode(false); setFaceEditMode(false); } }}
            className={`px-2 py-1 text-[10px] font-medium rounded transition-colors ${roleEditMode ? 'bg-purple-100 text-purple-600 ring-1 ring-purple-200' : 'text-stone-600 hover:bg-stone-200'}`}
            title="Role Edit Mode"
          >
            ROLE
          </button>
          {subtractionCount > 0 && (
            <button
              onClick={() => { setSubtractionViewMode(!subtractionViewMode); if (!subtractionViewMode) { setFilletMode(false); setFaceEditMode(false); } }}
              className={`px-2 py-1 text-[10px] font-medium rounded transition-colors ${subtractionViewMode ? 'bg-red-100 text-red-600 ring-1 ring-red-200' : 'text-stone-600 hover:bg-stone-200'}`}
              title="Subtraction Mode"
            >
              SUB ({subtractionCount})
            </button>
          )}
          <button
            onClick={() => { const n = !filletMode; setFilletMode(n); setFaceEditMode(n); clearFilletFaces(); clearFilletFaceData(); if (n) { setVertexEditMode(false); setSubtractionViewMode(false); } }}
            className={`px-2 py-1 text-[10px] font-medium rounded transition-colors ${filletMode ? 'bg-blue-100 text-blue-600 ring-1 ring-blue-200' : 'text-stone-600 hover:bg-stone-200'}`}
            title={`Fillet${selectedFilletFaces.length > 0 ? ` (${selectedFilletFaces.length}/2)` : ''}`}
          >
            FILLET {selectedFilletFaces.length > 0 && `(${selectedFilletFaces.length}/2)`}
          </button>
          <button onClick={addCustomParameter} className="p-0.5 hover:bg-stone-200 rounded transition-colors" title="Add Parameter"><Plus size={14} className="text-stone-600" /></button>
          <button onClick={handleClose} className="p-0.5 hover:bg-stone-200 rounded transition-colors"><X size={14} className="text-stone-600" /></button>
        </div>
      </div>

      <div className="p-3 max-h-[calc(100vh-200px)] overflow-y-auto">
        {selectedShape ? (
          <div className="space-y-0.5">
            <div className="space-y-0.5">
              {(['width', 'height', 'depth'] as const).map((dim, i) => (
                <ParameterRow key={dim} label={['W', 'H', 'D'][i]} value={[width, height, depth][i]}
                  onChange={v => { [setWidth, setHeight, setDepth][i](v); }} description={['Width', 'Height', 'Depth'][i]} />
              ))}
              {[['RX', rotX, setRotX, 'Rotation X'], ['RY', rotY, setRotY, 'Rotation Y'], ['RZ', rotZ, setRotZ, 'Rotation Z']].map(([label, val, set, desc]) => (
                <ParameterRow key={label as string} label={label as string} value={val as number} onChange={set as (v: number) => void}
                  display={(val as number).toFixed(1) + '°'} description={desc as string} step={1} />
              ))}
              {showBackPanelLeftExtend && renderBackPanelExtend('BPL', backPanelLeftExtend, setBackPanelLeftExtend, 'Back panel left extend', () => { setShowBackPanelLeftExtend(false); setBackPanelLeftExtend(0); })}
              {showBackPanelRightExtend && renderBackPanelExtend('BPR', backPanelRightExtend, setBackPanelRightExtend, 'Back panel right extend', () => { setShowBackPanelRightExtend(false); setBackPanelRightExtend(0); })}
            </div>

            {filletRadii.length > 0 && (
              <div className="space-y-0.5 pt-2 border-t border-stone-300">
                {filletRadii.map((radius, idx) => (
                  <div key={`fillet-${idx}`} className="flex gap-0.5 items-center">
                    <div className="flex-1">
                      <ParameterRow label={`F${idx + 1}`} value={radius} onChange={v => { const r = [...filletRadii]; r[idx] = v; setFilletRadii(r); }} description={`Fillet ${idx + 1} radius`} />
                    </div>
                    <button onClick={() => setFilletRadii(filletRadii.filter((_, i) => i !== idx))} className="p-0.5 hover:bg-red-100 rounded transition-colors" title="Remove"><X size={12} className="text-red-600" /></button>
                  </div>
                ))}
              </div>
            )}

            {roleEditMode && (() => {
              if (!selectedShape.geometry) return null;
              const faces = extractFacesFromGeometry(selectedShape.geometry);
              const groups = groupCoplanarFaces(faces);
              return (
                <div className="space-y-0.5 pt-2 border-t border-stone-300">
                  {groups.map((group, groupIndex) => (
                    <div key={groupIndex} className="flex gap-0.5 items-center">
                      <input type="text" value={`F${groupIndex}`} readOnly tabIndex={-1} className={`w-10 ${inputBase} bg-white text-gray-800 text-center`} />
                      <select value={selectedShape.faceRoles?.[groupIndex] || ''} onChange={e => updateFaceRole(selectedShape.id, groupIndex, e.target.value === '' ? null : e.target.value as FaceRole)}
                        className="w-20 px-1 py-0.5 text-xs bg-white text-gray-800 border border-gray-300 rounded">
                        <option value="">none</option>
                        {roleOptions.map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                      <input type="text" value={faceDescriptions[groupIndex] || ''} onChange={e => updateShape(selectedShape.id, { faceDescriptions: { ...faceDescriptions, [groupIndex]: e.target.value } })}
                        placeholder="description" className="flex-1 px-2 py-0.5 text-xs bg-white text-gray-800 border border-gray-300 rounded" />
                    </div>
                  ))}
                </div>
              );
            })()}

            {customParameters.length > 0 && (
              <div className="space-y-0.5">
                {customParameters.map(param => (
                  <div key={param.id} className="flex gap-0.5 items-center">
                    <input type="text" value={param.name} onChange={e => updateCustomParameter(param.id, 'name', e.target.value)} className={`w-10 ${inputBase} bg-white text-gray-800 text-center`} />
                    <input type="text" value={param.expression} onChange={e => updateCustomParameter(param.id, 'expression', e.target.value)} className={`w-16 ${inputBase} bg-white text-gray-800`} placeholder="expr" />
                    <input type="text" value={param.result.toFixed(2)} readOnly tabIndex={-1} className={`w-16 ${inputRO} text-left`} />
                    <input type="text" value={param.description} onChange={e => updateCustomParameter(param.id, 'description', e.target.value)} className="flex-1 px-2 py-0.5 text-xs bg-white text-gray-800 border border-gray-300 rounded" placeholder="Description" />
                    <button onClick={() => deleteCustomParameter(param.id)} className="p-0.5 hover:bg-red-100 rounded transition-colors" title="Delete"><X size={12} className="text-red-600" /></button>
                  </div>
                ))}
              </div>
            )}

            {subtractionViewMode && selectedSubtractionIndex !== null && selectedShape.subtractionGeometries?.[selectedSubtractionIndex] && (
              <div className="space-y-0.5 pt-2 border-t-2 border-yellow-400">
                {renderSubParam('SW', subParams.width, 'width', 'Subtraction Width')}
                {renderSubParam('SH', subParams.height, 'height', 'Subtraction Height')}
                {renderSubParam('SD', subParams.depth, 'depth', 'Subtraction Depth')}
                {renderSubParam('SX', subParams.posX, 'posX', 'Subtraction Offset X')}
                {renderSubParam('SY', subParams.posY, 'posY', 'Subtraction Offset Y')}
                {renderSubParam('SZ', subParams.posZ, 'posZ', 'Subtraction Offset Z')}
                {renderSubParam('SRX', subParams.rotX, 'rotX', 'Subtraction Rotation X')}
                {renderSubParam('SRY', subParams.rotY, 'rotY', 'Subtraction Rotation Y')}
                {renderSubParam('SRZ', subParams.rotZ, 'rotZ', 'Subtraction Rotation Z')}
                <button onClick={() => { if (selectedSubtractionIndex !== null) deleteSubtraction(selectedShapeId!, selectedSubtractionIndex); setSubtractionViewMode(false); setSelectedSubtractionIndex(null); }}
                  className="w-full mt-1 px-3 py-1 bg-red-500 text-white text-xs font-medium rounded hover:bg-red-600 transition-colors flex items-center justify-center gap-1">
                  <Trash2 size={12} /> Delete Subtraction
                </button>
              </div>
            )}

            {vertexEditMode && vertexModifications.length > 0 && (
              <div className="space-y-0.5 pt-2 border-t border-stone-300">
                {vertexModifications.map((mod, idx) => {
                  const result = evaluateExpression(mod.expression, getEvalContext());
                  return (
                    <div key={idx} className="flex gap-0.5 items-center">
                      <input type="text" value={`V${mod.vertexIndex}`} readOnly tabIndex={-1} className={`w-10 ${inputBase} bg-white text-gray-800 text-center`} />
                      <input type="text" value={mod.expression} onChange={e => updateVertexModification(idx, 'expression', e.target.value)} className={`w-16 ${inputBase} bg-white text-gray-800`} placeholder="expr" />
                      <input type="text" value={result.toFixed(2)} readOnly tabIndex={-1} className={`w-16 ${inputRO} text-left`} />
                      <input type="text" value={mod.description || ''} onChange={e => updateVertexModification(idx, 'description', e.target.value)} className="flex-1 px-2 py-0.5 text-xs bg-white text-gray-800 border border-gray-300 rounded" placeholder="Description" />
                    </div>
                  );
                })}
              </div>
            )}

            <button onClick={handleApplyChanges} className="w-full mt-2 px-3 py-1.5 bg-orange-500 text-white text-xs font-medium rounded hover:bg-orange-600 transition-colors flex items-center justify-center gap-1">
              <Check size={12} /> Apply Changes
            </button>
          </div>
        ) : (
          <div className="text-center text-stone-500 text-xs py-4">No shape selected</div>
        )}
      </div>
    </div>
  );
}
