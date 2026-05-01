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

const inputBase = 'px-1 py-0.5 text-xs font-mono bg-transparent border-b border-transparent hover:border-gray-300 focus:border-orange-400 rounded-none outline-none';
const inputRO = 'px-1 py-0.5 text-xs font-mono bg-transparent text-gray-400 border-b border-transparent rounded-none';

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
    <div className={`flex gap-1 items-center py-0.5 px-1 rounded transition-colors ${isFocused ? 'bg-orange-50 ring-1 ring-orange-300' : 'hover:bg-stone-50'}`}>
      <span className="w-8 text-xs font-mono font-bold text-gray-500 text-center select-none">{label}</span>
      <input type="text" value={inputValue} onChange={handleChange} onFocus={() => setIsFocused(true)} onBlur={handleBlur} readOnly={readOnly}
        className={`w-16 ${inputBase} ${readOnly ? 'text-gray-400' : 'text-gray-800'} text-left`} />
      <span className="w-16 text-xs font-mono text-gray-400 text-left select-none">{display ?? value.toFixed(2)}</span>
      <span className="flex-1 text-xs text-gray-400 select-none truncate">{description}</span>
    </div>
  );
};

export function ParametersPanel({ isOpen, onClose, embedded = false }: ParametersPanelProps) {
  const {
    selectedShapeId, shapes, updateShape, vertexEditMode, setVertexEditMode,
    subtractionViewMode, setSubtractionViewMode, selectedSubtractionIndex, setSelectedSubtractionIndex,
    deleteSubtraction, setShowParametersPanel, filletMode, setFilletMode, faceEditMode, setFaceEditMode,
    selectedFilletFaces, clearFilletFaces, clearFilletFaceData, roleEditMode, setRoleEditMode,
    updateFaceRole, recalculateVirtualFacesForShape
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
    if (selectedShapeId) recalculateVirtualFacesForShape(selectedShapeId);
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
    <div key={paramKey} className="flex gap-1 items-center py-0.5 px-1 rounded transition-colors focus-within:bg-orange-50 focus-within:ring-1 focus-within:ring-orange-300 hover:bg-stone-50">
      <span className="w-8 text-xs font-mono font-bold text-yellow-600 text-center select-none">{label}</span>
      <input type="text" value={param.expression} onChange={e => handleSubParamChange(paramKey, e.target.value)} className={`w-16 ${inputBase} text-gray-800`} placeholder="expr" />
      <span className="w-16 text-xs font-mono text-gray-400 text-left select-none">{param.result.toFixed(2)}</span>
      <span className="flex-1 text-xs text-gray-400 select-none truncate">{description}</span>
    </div>
  );

  if (!isOpen && !embedded) return null;

  const subtractionCount = selectedShape?.subtractionGeometries?.filter((s: any) => s !== null).length ?? 0;

  const tb = (active: boolean, onClick: () => void, label: string, cls: [string, string]) => (
    <button onClick={onClick} className={`px-1.5 py-0.5 rounded text-xs font-semibold transition-colors ${active ? cls[0] : cls[1]}`}>{label}</button>
  );

  const paramToolbar = (
    <div className="flex items-center gap-1 flex-wrap">
      {tb(vertexEditMode, () => { setVertexEditMode(!vertexEditMode); if (!vertexEditMode) { setFilletMode(false); setFaceEditMode(false); setRoleEditMode(false); } }, 'Vertex', ['text-orange-700 bg-orange-100 ring-1 ring-orange-400', 'text-slate-500 hover:bg-stone-200'])}
      {tb(roleEditMode, () => { setRoleEditMode(!roleEditMode); if (!roleEditMode) { setVertexEditMode(false); setFilletMode(false); setFaceEditMode(false); } }, 'Role', ['text-purple-700 bg-purple-100 ring-1 ring-purple-400', 'text-slate-500 hover:bg-stone-200'])}
      {subtractionCount > 0 && tb(subtractionViewMode, () => { setSubtractionViewMode(!subtractionViewMode); if (!subtractionViewMode) { setFilletMode(false); setFaceEditMode(false); } }, `Sub (${subtractionCount})`, ['text-yellow-700 bg-yellow-100 ring-1 ring-yellow-400', 'text-slate-500 hover:bg-stone-200'])}
      {tb(filletMode, () => { const n = !filletMode; setFilletMode(n); setFaceEditMode(n); clearFilletFaces(); clearFilletFaceData(); if (n) { setVertexEditMode(false); setSubtractionViewMode(false); } }, selectedFilletFaces.length > 0 ? `Fillet (${selectedFilletFaces.length}/2)` : 'Fillet', ['text-blue-700 bg-blue-100 ring-1 ring-blue-400', 'text-slate-500 hover:bg-stone-200'])}
      <button onClick={addCustomParameter} className="px-1.5 py-0.5 rounded text-xs font-semibold text-slate-500 hover:bg-stone-200 transition-colors">+ Param</button>
    </div>
  );

  const paramContent = selectedShape ? (
    <div className="space-y-0">
      <div className="space-y-0">
        {(['width', 'height', 'depth'] as const).map((dim, i) => (
          <ParameterRow key={dim} label={['W', 'H', 'D'][i]} value={[width, height, depth][i]}
            onChange={v => { [setWidth, setHeight, setDepth][i](v); }} description={['Width', 'Height', 'Depth'][i]} />
        ))}
        {[['RX', rotX, setRotX, 'Rotation X'], ['RY', rotY, setRotY, 'Rotation Y'], ['RZ', rotZ, setRotZ, 'Rotation Z']].map(([label, val, set, desc]) => (
          <ParameterRow key={label as string} label={label as string} value={val as number} onChange={set as (v: number) => void}
            display={(val as number).toFixed(1) + '°'} description={desc as string} step={1} />
        ))}
      </div>

      {filletRadii.length > 0 && (
        <div className="space-y-0 pt-2 border-t border-stone-200">
          {filletRadii.map((radius, idx) => (
            <div key={`fillet-${idx}`} className="flex gap-0.5 items-center">
              <div className="flex-1">
                <ParameterRow label={`F${idx + 1}`} value={radius} onChange={v => { const r = [...filletRadii]; r[idx] = v; setFilletRadii(r); }} description={`Fillet ${idx + 1} Radius`} step={0.1} />
              </div>
              <button onClick={() => selectedShape && handleDeleteFillet(idx)} className="p-0.5 rounded text-stone-300 hover:text-red-400 transition-colors" title="Delete fillet">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {roleEditMode && selectedShape && (() => {
        const geometry = selectedShape.geometry;
        if (!geometry) return null;
        const faces = extractFacesFromGeometry(geometry);
        const faceGroups = groupCoplanarFaces(faces);
        const faceRoles = selectedShape.faceRoles || {};
        const faceDescriptions = selectedShape.faceDescriptions || {};
        const roleOptions: FaceRole[] = ['Left', 'Right', 'Top', 'Bottom', 'Back', 'Door'];
        const fillets: FilletData[] = selectedShape.fillets || [];
        const AXIS_ORDER: Record<string, number> = { 'x+': 0, 'x-': 1, 'y+': 2, 'y-': 3, 'z+': 4, 'z-': 5 };
        const getAxisDir = (n: THREE.Vector3) => {
          const t = 0.95;
          if (n.x > t) return 'x+'; if (n.x < -t) return 'x-';
          if (n.y > t) return 'y+'; if (n.y < -t) return 'y-';
          if (n.z > t) return 'z+'; if (n.z < -t) return 'z-';
          return null;
        };
        const bbox = new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position'));
        const subGeos: Array<any> = selectedShape.subtractionGeometries || [];
        const cuttingPlanes: Array<{ normal: THREE.Vector3; constant: number; subtractorIndex: number }> = [];

        subGeos.forEach((sub: any, si: number) => {
          if (!sub?.geometry) return;
          const subBbox = new THREE.Box3().setFromBufferAttribute(sub.geometry.getAttribute('position'));
          const rot = sub.relativeRotation;
          const rotM = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ'));
          const offset = new THREE.Vector3(...sub.relativeOffset);
          const corners = [
            [subBbox.min.x, subBbox.min.y, subBbox.min.z], [subBbox.max.x, subBbox.min.y, subBbox.min.z],
            [subBbox.min.x, subBbox.max.y, subBbox.min.z], [subBbox.max.x, subBbox.max.y, subBbox.min.z],
            [subBbox.min.x, subBbox.min.y, subBbox.max.z], [subBbox.max.x, subBbox.min.y, subBbox.max.z],
            [subBbox.min.x, subBbox.max.y, subBbox.max.z], [subBbox.max.x, subBbox.max.y, subBbox.max.z],
          ].map(([x, y, z]) => new THREE.Vector3(x, y, z).applyMatrix4(rotM).add(offset));
          const wb = new THREE.Box3().setFromPoints(corners);
          const ns = [new THREE.Vector3(1,0,0), new THREE.Vector3(-1,0,0), new THREE.Vector3(0,1,0), new THREE.Vector3(0,-1,0), new THREE.Vector3(0,0,1), new THREE.Vector3(0,0,-1)];
          const pos = [wb.max.x, wb.min.x, wb.max.y, wb.min.y, wb.max.z, wb.min.z];
          const consts = [-wb.max.x, wb.min.x, -wb.max.y, wb.min.y, -wb.max.z, wb.min.z];
          ns.forEach((n, i) => {
            const ai = Math.floor(i / 2);
            const [mn, mx] = ai === 0 ? [bbox.min.x, bbox.max.x] : ai === 1 ? [bbox.min.y, bbox.max.y] : [bbox.min.z, bbox.max.z];
            if (pos[i] > mn + 1.0 && pos[i] < mx - 1.0) cuttingPlanes.push({ normal: n, constant: consts[i], subtractorIndex: si });
          });
        });

        const axisCandidates = new Map<string, Array<{ groupIndex: number }>>();
        const subtractorMap = new Map<number, Array<{ groupIndex: number }>>();
        const filletMap = new Map<number, Array<{ groupIndex: number }>>();

        faceGroups.forEach((group, groupIndex) => {
          const axisDir = getAxisDir(group.normal);
          if (axisDir === null) {
            for (let fi = 0; fi < fillets.length; fi++) {
              const f = fillets[fi];
              const tol = Math.max(f.radius * 2.0, 10);
              const n1 = new THREE.Vector3(...f.face1Data.normal);
              const n2 = new THREE.Vector3(...f.face2Data.normal);
              const d1 = f.face1Data.planeD ?? n1.dot(new THREE.Vector3(...f.face1Data.center));
              const d2 = f.face2Data.planeD ?? n2.dot(new THREE.Vector3(...f.face2Data.center));
              if (Math.abs(n1.dot(group.center) - d1) < tol && Math.abs(n2.dot(group.center) - d2) < tol) {
                if (!filletMap.has(fi)) filletMap.set(fi, []);
                filletMap.get(fi)!.push({ groupIndex }); return;
              }
            }
            return;
          }
          for (const plane of cuttingPlanes) {
            if (Math.abs(group.normal.dot(plane.normal)) >= 0.95 && Math.abs(group.center.dot(plane.normal) + plane.constant) < 1.0) {
              if (!subtractorMap.has(plane.subtractorIndex)) subtractorMap.set(plane.subtractorIndex, []);
              subtractorMap.get(plane.subtractorIndex)!.push({ groupIndex }); return;
            }
          }
          if (!axisCandidates.has(axisDir)) axisCandidates.set(axisDir, []);
          axisCandidates.get(axisDir)!.push({ groupIndex });
        });

        const faceEntries: Array<{ label: string; groupIndex: number; color: string }> = [];
        Array.from(axisCandidates.entries())
          .sort(([a], [b]) => (AXIS_ORDER[a] ?? 99) - (AXIS_ORDER[b] ?? 99))
          .forEach(([, candidates], ri) => {
            if (candidates.length > 1) candidates.forEach((c, si) => faceEntries.push({ label: `${ri + 1}-${si + 1}`, groupIndex: c.groupIndex, color: '#1a1a1a' }));
            else faceEntries.push({ label: `${ri + 1}`, groupIndex: candidates[0].groupIndex, color: '#1a1a1a' });
          });
        subtractorMap.forEach((c, si) => c.forEach((f, fi) => faceEntries.push({ label: `S${si + 1}.${fi + 1}`, groupIndex: f.groupIndex, color: '#b45000' })));
        filletMap.forEach((c, fi) => c.forEach(f => faceEntries.push({ label: `F${fi + 1}`, groupIndex: f.groupIndex, color: '#006eb4' })));

        return (
          <div className="space-y-0 pt-2 border-t border-stone-200">
            <div className="text-xs font-semibold text-stone-500 mb-1">Face Roles ({faceEntries.length})</div>
            {faceEntries.map(({ label, groupIndex, color }) => (
              <div key={`face-${groupIndex}`} className="flex gap-1 items-center py-0.5 px-1 rounded transition-colors focus-within:bg-orange-50 focus-within:ring-1 focus-within:ring-orange-300 hover:bg-stone-50">
                <span style={{ color }} className="w-8 text-xs font-mono font-bold text-center select-none">{label}</span>
                <select value={faceRoles[groupIndex] || ''} onChange={e => updateFaceRole(selectedShape.id, groupIndex, e.target.value === '' ? null : e.target.value as FaceRole)}
                  className="w-20 px-1 py-0.5 text-xs bg-transparent text-gray-700 border-b border-transparent hover:border-gray-300 focus:border-orange-400 rounded-none outline-none">
                  <option value="">—</option>
                  {roleOptions.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <input type="text" value={faceDescriptions[groupIndex] || ''} onChange={e => updateShape(selectedShape.id, { faceDescriptions: { ...faceDescriptions, [groupIndex]: e.target.value } })}
                  placeholder="note" className="flex-1 px-1 py-0.5 text-xs bg-transparent text-gray-600 border-b border-transparent hover:border-gray-300 focus:border-orange-400 rounded-none outline-none placeholder:text-stone-300" />
              </div>
            ))}
          </div>
        );
      })()}

      {customParameters.length > 0 && (
        <div className="space-y-0">
          {customParameters.map(param => (
            <div key={param.id} className="flex gap-1 items-center py-0.5 px-1 rounded transition-colors focus-within:bg-orange-50 focus-within:ring-1 focus-within:ring-orange-300 hover:bg-stone-50">
              <input type="text" value={param.name} onChange={e => updateCustomParameter(param.id, 'name', e.target.value)} className={`w-8 ${inputBase} text-gray-800 text-center font-bold`} />
              <input type="text" value={param.expression} onChange={e => updateCustomParameter(param.id, 'expression', e.target.value)} className={`w-16 ${inputBase} text-gray-800`} placeholder="expr" />
              <span className="w-16 text-xs font-mono text-gray-400 text-left select-none">{param.result.toFixed(2)}</span>
              <input type="text" value={param.description} onChange={e => updateCustomParameter(param.id, 'description', e.target.value)}
                className="flex-1 px-1 py-0.5 text-xs bg-transparent text-gray-600 border-b border-transparent hover:border-gray-300 focus:border-orange-400 rounded-none outline-none placeholder:text-stone-300" placeholder="note" />
              <button onClick={() => deleteCustomParameter(param.id)} className="p-0.5 rounded text-stone-300 hover:text-red-400 transition-colors" title="Delete"><X size={12} /></button>
            </div>
          ))}
        </div>
      )}

      {subtractionViewMode && selectedSubtractionIndex !== null && selectedShape.subtractionGeometries?.[selectedSubtractionIndex] && (
        <div className="space-y-0 pt-2 border-t border-yellow-300">
          <div className="flex items-center justify-between text-xs font-semibold text-yellow-600 mb-1">
            <span>Subtraction #{selectedSubtractionIndex + 1}</span>
            <div className="flex items-center gap-1">
              <button onClick={async () => { if (selectedShape && selectedSubtractionIndex !== null) await deleteSubtraction(selectedShape.id, selectedSubtractionIndex); }}
                className="p-0.5 rounded text-stone-300 hover:text-red-400 transition-colors" title="Delete subtraction"><Trash2 size={12} /></button>
              <button onClick={() => setSelectedSubtractionIndex(null)} className="p-0.5 rounded text-stone-300 hover:text-stone-500 transition-colors" title="Close"><X size={12} /></button>
            </div>
          </div>
          <div className="space-y-0.5">
            {renderSubParamRow('W', subParams.width, 'width', 'Subtraction Width')}
            {renderSubParamRow('H', subParams.height, 'height', 'Subtraction Height')}
            {renderSubParamRow('D', subParams.depth, 'depth', 'Subtraction Depth')}
            {renderSubParamRow('X', subParams.posX, 'posX', 'Subtraction Position X')}
            {renderSubParamRow('Y', subParams.posY, 'posY', 'Subtraction Position Y')}
            {renderSubParamRow('Z', subParams.posZ, 'posZ', 'Subtraction Position Z')}
            {renderSubParamRow('RX', subParams.rotX, 'rotX', 'Subtraction Rotation X')}
            {renderSubParamRow('RY', subParams.rotY, 'rotY', 'Subtraction Rotation Y')}
            {renderSubParamRow('RZ', subParams.rotZ, 'rotZ', 'Subtraction Rotation Z')}
          </div>
        </div>
      )}

      {vertexEditMode && vertexModifications.length > 0 && (
        <div className="space-y-0 pt-2 border-t border-stone-200">
          <div className="text-xs font-semibold text-stone-500 mb-1">Vertex Modifications</div>
          {vertexModifications.map((mod, idx) => {
            const result = evaluateExpression(mod.expression, getEvalContext());
            return (
              <div key={idx} className="flex gap-1 items-center py-0.5 px-1 rounded transition-colors focus-within:bg-orange-50 focus-within:ring-1 focus-within:ring-orange-300 hover:bg-stone-50">
                <span className="w-8 text-xs font-mono font-bold text-gray-500 text-center select-none">V{mod.vertexIndex}</span>
                <input type="text" value={mod.expression} onChange={e => updateVertexModification(idx, 'expression', e.target.value)} className={`w-16 ${inputBase} text-gray-800`} placeholder="expr" />
                <span className="w-16 text-xs font-mono text-gray-400 text-left select-none">{result.toFixed(2)}</span>
                <input type="text" value={mod.description || ''} onChange={e => updateVertexModification(idx, 'description', e.target.value)}
                  className="flex-1 px-1 py-0.5 text-xs bg-transparent text-gray-600 border-b border-transparent hover:border-gray-300 focus:border-orange-400 rounded-none outline-none placeholder:text-stone-300" placeholder="note" />
              </div>
            );
          })}
        </div>
      )}

      <button onClick={handleApplyChanges} className="w-full mt-3 px-3 py-1.5 bg-orange-500 text-white text-xs font-medium rounded hover:bg-orange-600 transition-colors flex items-center justify-center gap-1.5">
        <Check size={12} /> Apply Changes
      </button>
    </div>
  ) : (
    <div className="text-center text-stone-500 text-xs py-4">No shape selected</div>
  );

  if (embedded) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-2.5 py-1.5 border-b border-stone-100 flex items-center justify-between">
          {paramToolbar}
        </div>
        <div className="px-2.5 py-2 overflow-y-auto flex-1">
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
      <div className="px-2.5 py-2 max-h-[calc(100vh-200px)] overflow-y-auto">
        {paramContent}
      </div>
    </div>
  );
}
