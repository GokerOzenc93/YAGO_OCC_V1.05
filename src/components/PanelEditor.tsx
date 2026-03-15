import React, { useState, useEffect, useRef } from 'react';
import { X, GripVertical, MousePointer, Layers, RotateCw, Plus, Trash2, RefreshCw } from 'lucide-react';
import { globalSettingsService, faceLabelRoleDefaultsService, GlobalSettingsProfile } from './GlobalSettingsDatabase';
import { useAppStore } from '../store';
import type { FaceRole } from '../store';
import { extractFacesFromGeometry, groupCoplanarFaces, createFaceDescriptor, FaceData, CoplanarFaceGroup } from './FaceEditor';
import type { FaceDescriptor } from '../store';
import { resolveAllPanelJoints, restoreAllPanels, rebuildAllPanels } from './PanelJointService';
import type { FilletData } from './Fillet';
import * as THREE from 'three';
import { useDrag } from './hooks';

interface PanelEditorProps {
  isOpen: boolean;
  onClose: () => void;
}

const AXIS_ORDER: Record<string, number> = { 'x+': 0, 'x-': 1, 'y+': 2, 'y-': 3, 'z+': 4, 'z-': 5 };

function getAxisDir(n: THREE.Vector3): string | null {
  const tol = 0.95;
  if (n.x > tol) return 'x+';
  if (n.x < -tol) return 'x-';
  if (n.y > tol) return 'y+';
  if (n.y < -tol) return 'y-';
  if (n.z > tol) return 'z+';
  if (n.z < -tol) return 'z-';
  return null;
}

function computeCuttingPlanes(
  subtractionGeometries: any[],
  mainBbox: THREE.Box3,
  withSubtractorIndex = false
): Array<{ normal: THREE.Vector3; constant: number; subtractorIndex?: number }> {
  const planes: Array<{ normal: THREE.Vector3; constant: number; subtractorIndex?: number }> = [];
  subtractionGeometries.forEach((sub: any, subtractorIndex: number) => {
    if (!sub?.geometry) return;
    const subBbox = new THREE.Box3().setFromBufferAttribute(sub.geometry.getAttribute('position'));
    const offset = new THREE.Vector3(...sub.relativeOffset);
    const rot = sub.relativeRotation;
    const rotMatrix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ'));
    const corners = [
      new THREE.Vector3(subBbox.min.x, subBbox.min.y, subBbox.min.z),
      new THREE.Vector3(subBbox.max.x, subBbox.min.y, subBbox.min.z),
      new THREE.Vector3(subBbox.min.x, subBbox.max.y, subBbox.min.z),
      new THREE.Vector3(subBbox.max.x, subBbox.max.y, subBbox.min.z),
      new THREE.Vector3(subBbox.min.x, subBbox.min.y, subBbox.max.z),
      new THREE.Vector3(subBbox.max.x, subBbox.min.y, subBbox.max.z),
      new THREE.Vector3(subBbox.min.x, subBbox.max.y, subBbox.max.z),
      new THREE.Vector3(subBbox.max.x, subBbox.max.y, subBbox.max.z),
    ].map(c => c.applyMatrix4(rotMatrix).add(offset));
    const wb = new THREE.Box3().setFromPoints(corners);
    const faceNormals = [
      new THREE.Vector3(1,0,0), new THREE.Vector3(-1,0,0),
      new THREE.Vector3(0,1,0), new THREE.Vector3(0,-1,0),
      new THREE.Vector3(0,0,1), new THREE.Vector3(0,0,-1),
    ];
    const constants = [-wb.max.x, wb.min.x, -wb.max.y, wb.min.y, -wb.max.z, wb.min.z];
    const positions = [wb.max.x, wb.min.x, wb.max.y, wb.min.y, wb.max.z, wb.min.z];
    for (let pi = 0; pi < 6; pi++) {
      const pos = positions[pi];
      const ai = Math.floor(pi / 2);
      const minV = ai === 0 ? mainBbox.min.x : ai === 1 ? mainBbox.min.y : mainBbox.min.z;
      const maxV = ai === 0 ? mainBbox.max.x : ai === 1 ? mainBbox.max.y : mainBbox.max.z;
      if (pos > minV + 1.0 && pos < maxV - 1.0) {
        planes.push({ normal: faceNormals[pi], constant: constants[pi], ...(withSubtractorIndex ? { subtractorIndex } : {}) });
      }
    }
  });
  return planes;
}

function getArrowTargetAxis(geometry: THREE.BufferGeometry, faceRole?: string, arrowRotated?: boolean): number {
  const posAttr = geometry.getAttribute('position');
  if (!posAttr) return 0;
  const bbox = new THREE.Box3().setFromBufferAttribute(posAttr as THREE.BufferAttribute);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const axes = [{ index: 0, value: size.x }, { index: 1, value: size.y }, { index: 2, value: size.z }];
  axes.sort((a, b) => a.value - b.value);
  const planeAxes = axes.slice(1).map(a => a.index).sort((a, b) => a - b);
  const role = faceRole?.toLowerCase();
  let defaultAxis = planeAxes[0];
  let altAxis = planeAxes[1];
  if (role === 'left' || role === 'right') {
    if (planeAxes.includes(1)) { defaultAxis = 1; altAxis = planeAxes.find(a => a !== 1) ?? planeAxes[1]; }
  } else if (role === 'top' || role === 'bottom') {
    if (planeAxes.includes(0)) { defaultAxis = 0; altAxis = planeAxes.find(a => a !== 0) ?? planeAxes[1]; }
  }
  return arrowRotated ? altAxis : defaultAxis;
}

export function PanelEditor({ isOpen, onClose }: PanelEditorProps) {
  const {
    selectedShapeId, shapes, updateShape, addShape,
    showOutlines, setShowOutlines, showRoleNumbers, setShowRoleNumbers,
    selectedPanelRow, setSelectedPanelRow, panelSelectMode, setPanelSelectMode,
    raycastMode, setRaycastMode, showVirtualFaces, setShowVirtualFaces,
    virtualFaces, updateVirtualFace, deleteVirtualFace,
    pendingPanelCreation, setActivePanelProfileId, setShapeRebuilding
  } = useAppStore();

  const { position, isDragging, handleMouseDown } = useDrag({ x: 100, y: 100 });
  const [profiles, setProfiles] = useState<GlobalSettingsProfile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<string>('none');
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState(false);
  const prevProfileRef = useRef<string>('none');
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const selectedProfileRef = useRef<string>('none');
  selectedProfileRef.current = selectedProfile;

  const selectedShape = shapes.find((s) => s.id === selectedShapeId);

  useEffect(() => { setSelectedPanelRow(null); }, [selectedShapeId, setSelectedPanelRow]);

  useEffect(() => {
    if (isOpen) loadProfiles();
    else { setSelectedPanelRow(null); setPanelSelectMode(false); }
  }, [isOpen, setSelectedPanelRow, setPanelSelectMode]);

  useEffect(() => {
    if (selectedPanelRow !== null) {
      rowRefs.current.get(selectedPanelRow as number)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [selectedPanelRow]);

  useEffect(() => {
    setActivePanelProfileId(selectedProfile !== 'none' ? selectedProfile : null);
  }, [selectedProfile]);

  useEffect(() => {
    if (prevProfileRef.current === selectedProfile) return;
    prevProfileRef.current = selectedProfile;
    if (!selectedShapeId) return;
    if (selectedProfile !== 'none') {
      setResolving(true);
      setShapeRebuilding(selectedShapeId, true);
      resolveAllPanelJoints(selectedShapeId, selectedProfile).finally(() => {
        setResolving(false);
        setShapeRebuilding(selectedShapeId, false);
      });
    } else {
      restoreAllPanels(selectedShapeId);
    }
  }, [selectedProfile, selectedShapeId]);

  useEffect(() => {
    if (!selectedShape || !selectedShape.geometry) return;
    const applyLabelDefaults = async () => {
      const labelDefaults = await faceLabelRoleDefaultsService.getAll();
      const geometry = selectedShape.geometry;
      const faces = extractFacesFromGeometry(geometry);
      const faceGroups = groupCoplanarFaces(faces);
      const subtractionGeometries: any[] = selectedShape.subtractionGeometries || [];
      const fillets: any[] = selectedShape.fillets || [];
      const mainBbox = new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position'));
      const cuttingPlanes = computeCuttingPlanes(subtractionGeometries, mainBbox);
      const axisCandidates = new Map<string, number[]>();
      faceGroups.forEach((group, groupIndex) => {
        const axisDir = getAxisDir(group.normal);
        if (axisDir === null) {
          for (const fillet of fillets) {
            const tol = Math.max(fillet.radius * 2.0, 10);
            const n1 = new THREE.Vector3(...fillet.face1Data.normal);
            const n2 = new THREE.Vector3(...fillet.face2Data.normal);
            const d1 = fillet.face1Data.planeD ?? n1.dot(new THREE.Vector3(...fillet.face1Data.center));
            const d2 = fillet.face2Data.planeD ?? n2.dot(new THREE.Vector3(...fillet.face2Data.center));
            if (Math.abs(n1.dot(group.center) - d1) < tol && Math.abs(n2.dot(group.center) - d2) < tol) return;
          }
          return;
        }
        if (cuttingPlanes.some(p => Math.abs(group.normal.dot(p.normal)) >= 0.95 && Math.abs(group.center.dot(p.normal) + p.constant) < 1.0)) return;
        if (!axisCandidates.has(axisDir)) axisCandidates.set(axisDir, []);
        axisCandidates.get(axisDir)!.push(groupIndex);
      });
      const axisSorted = Array.from(axisCandidates.entries()).sort(([a], [b]) => (AXIS_ORDER[a] ?? 99) - (AXIS_ORDER[b] ?? 99));
      const labelForGroupIndex = new Map<number, string>();
      axisSorted.forEach(([, groupIndices], roleIdx) => {
        const roleNumber = roleIdx + 1;
        if (groupIndices.length > 1) {
          groupIndices.forEach((gi, si) => labelForGroupIndex.set(gi, `${roleNumber}-${si + 1}`));
        } else {
          labelForGroupIndex.set(groupIndices[0], `${roleNumber}`);
        }
      });
      const newFaceRoles: Record<number, FaceRole> = {};
      labelForGroupIndex.forEach((label, groupIndex) => {
        const defaultRole = labelDefaults[label];
        if (defaultRole) newFaceRoles[groupIndex] = defaultRole as FaceRole;
      });
      updateShape(selectedShape.id, { faceRoles: newFaceRoles });
    };
    applyLabelDefaults();
  }, [selectedShape?.id, selectedShape?.geometry]);

  useEffect(() => {
    if (!pendingPanelCreation || !isOpen) return;
    const constraint = pendingPanelCreation.surfaceConstraint;
    if (!constraint?.constraintPanelId) return;
    const vf = virtualFaces.find(f => f.id === constraint.constraintPanelId);
    if (!vf || vf.hasPanel) return;
    const currentShape = useAppStore.getState().shapes.find(s => s.id === vf.shapeId);
    if (!currentShape) return;
    const vfIdx = virtualFaces.filter(f => f.shapeId === vf.shapeId).findIndex(f => f.id === vf.id);
    if (vfIdx === -1) return;
    (async () => {
      try {
        const panelThickness = 18;
        const { createPanelFromVirtualFace, convertReplicadToThreeGeometry } = await import('./ReplicadService');
        const replicadPanel = await createPanelFromVirtualFace(vf.vertices, vf.normal, panelThickness);
        if (!replicadPanel) return;
        const geometry = convertReplicadToThreeGeometry(replicadPanel);
        const newPanel: any = {
          id: `panel-vf-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
          type: 'panel', geometry, replicadShape: replicadPanel,
          position: [...currentShape.position] as [number, number, number],
          rotation: currentShape.rotation,
          scale: [...currentShape.scale] as [number, number, number],
          color: '#ffffff',
          parameters: { width: 0, height: 0, depth: panelThickness, parentShapeId: currentShape.id, faceIndex: -(vfIdx + 1), faceRole: vf.role, virtualFaceId: vf.id }
        };
        addShape(newPanel);
        updateVirtualFace(vf.id, { hasPanel: true });
        const currentProfile = selectedProfileRef.current;
        if (currentProfile !== 'none') {
          setResolving(true);
          setShapeRebuilding(currentShape.id, true);
          try { await resolveAllPanelJoints(currentShape.id, currentProfile); }
          finally { setResolving(false); setShapeRebuilding(currentShape.id, false); }
        }
      } catch (err) { console.error('Failed to create panel for virtual face via click:', err); }
    })();
  }, [pendingPanelCreation]);

  const loadProfiles = async () => {
    try {
      setLoading(true);
      setProfiles(await globalSettingsService.listProfiles());
    } catch (error) {
      console.error('Failed to load profiles:', error);
    } finally {
      setLoading(false);
    }
  };

  const createPanelForFace = async (faceGroup: CoplanarFaceGroup, faces: FaceData[], faceIndex: number) => {
    if (!selectedShape?.replicadShape) return;
    try {
      const localVertices: THREE.Vector3[] = [];
      faceGroup.faceIndices.forEach(idx => faces[idx].vertices.forEach(v => localVertices.push(v.clone())));
      const localNormal = faceGroup.normal.clone().normalize();
      const localBox = new THREE.Box3().setFromPoints(localVertices);
      const localCenter = new THREE.Vector3();
      localBox.getCenter(localCenter);
      const panelThickness = 18;
      const { createPanelFromFace, convertReplicadToThreeGeometry } = await import('./ReplicadService');
      const replicadPanel = await createPanelFromFace(
        selectedShape.replicadShape,
        [localNormal.x, localNormal.y, localNormal.z],
        [localCenter.x, localCenter.y, localCenter.z],
        panelThickness, null
      );
      if (!replicadPanel) return;
      const geometry = convertReplicadToThreeGeometry(replicadPanel);
      addShape({
        id: `panel-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
        type: 'panel', geometry, replicadShape: replicadPanel,
        position: [...selectedShape.position] as [number, number, number],
        rotation: selectedShape.rotation,
        scale: [...selectedShape.scale] as [number, number, number],
        color: '#ffffff',
        parameters: { width: 0, height: 0, depth: panelThickness, parentShapeId: selectedShape.id, faceIndex, faceRole: selectedShape.faceRoles?.[faceIndex] }
      } as any);
    } catch (error) { console.error('Failed to create panel:', error); }
  };

  const withResolve = async (fn: () => Promise<void>) => {
    if (!selectedShape || selectedProfile === 'none') return;
    setResolving(true);
    setShapeRebuilding(selectedShape.id, true);
    try { await fn(); }
    finally { setResolving(false); setShapeRebuilding(selectedShape.id, false); }
  };

  if (!isOpen) return null;

  const isDisabled = selectedProfile === 'none';

  return (
    <div className="fixed bg-white rounded-lg shadow-2xl border border-stone-300 z-50" style={{ left: `${position.x}px`, top: `${position.y}px`, width: '565px' }}>
      <div
        className="flex items-center justify-between px-3 py-2 bg-stone-100 border-b border-stone-300 rounded-t-lg select-none"
        style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
        onMouseDown={handleMouseDown}
      >
        <div className="flex items-center gap-2">
          <GripVertical size={14} className="text-stone-400" />
          <span className="text-sm font-semibold text-slate-800">Panel Editor</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setRaycastMode(!raycastMode)}
            className={`p-0.5 rounded transition-colors ${raycastMode ? 'text-amber-600 bg-amber-100 ring-1 ring-amber-400' : 'text-slate-600 hover:bg-stone-200'}`}
            title={raycastMode ? 'Raycast Modu Aktif (kapat)' : 'Raycast Modunu Aç'}
          >
            <Plus size={14} />
          </button>
          <button
            onClick={() => withResolve(async () => { await rebuildAllPanels(selectedShape!.id); await resolveAllPanelJoints(selectedShape!.id, selectedProfile); })}
            disabled={!selectedShape || isDisabled || resolving}
            className={`p-0.5 rounded transition-colors ${!selectedShape || isDisabled || resolving ? 'text-stone-300 cursor-not-allowed' : 'text-slate-600 hover:bg-stone-200'}`}
            title="Panelleri Yeniden Hesapla"
          >
            <RefreshCw size={14} className={resolving ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => setPanelSelectMode(!panelSelectMode)}
            className={`p-0.5 hover:bg-stone-200 rounded transition-colors ${panelSelectMode ? 'text-orange-600' : 'text-slate-600'}`}
            title={panelSelectMode ? 'Panel Mode' : 'Body Mode'}
          >
            {panelSelectMode ? <MousePointer size={14} /> : <Layers size={14} />}
          </button>
          <button onClick={onClose} className="p-0.5 hover:bg-stone-200 rounded transition-colors">
            <X size={14} className="text-stone-600" />
          </button>
        </div>
      </div>

      <div className="p-3 max-h-[calc(100vh-200px)] overflow-y-auto">
        {selectedShape ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <label className="text-xs font-semibold text-slate-800 whitespace-nowrap">Select Body Profile</label>
                {loading ? (
                  <div className="px-2 py-0.5 text-xs text-stone-400 bg-white border border-gray-300 rounded" style={{ width: '30mm' }}>Loading...</div>
                ) : (
                  <select value={selectedProfile} onChange={(e) => setSelectedProfile(e.target.value)} className="px-2 py-0.5 text-xs bg-white text-gray-800 border border-gray-300 rounded focus:outline-none focus:border-orange-500" style={{ width: '30mm' }}>
                    <option value="none">None</option>
                    {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                  </select>
                )}
              </div>
              {[
                { label: 'Raycast Face', checked: showVirtualFaces, onChange: setShowVirtualFaces },
                { label: 'Outline', checked: showOutlines, onChange: setShowOutlines },
                { label: 'Role numbers', checked: showRoleNumbers, onChange: setShowRoleNumbers },
              ].map(({ label, checked, onChange }) => (
                <div key={label} className="flex items-center gap-1">
                  <label className="text-xs font-semibold text-slate-800 whitespace-nowrap">{label}</label>
                  <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500" />
                </div>
              ))}
            </div>

            {(() => {
              const geometry = selectedShape.geometry;
              if (!geometry) return null;
              const faces = extractFacesFromGeometry(geometry);
              const faceGroups = groupCoplanarFaces(faces);
              const faceRoles = selectedShape.faceRoles || {};
              const faceDescriptions = selectedShape.faceDescriptions || {};
              const facePanels = selectedShape.facePanels || {};
              const roleOptions: FaceRole[] = ['Left', 'Right', 'Top', 'Bottom', 'Back', 'Door'];
              const fillets: FilletData[] = selectedShape.fillets || [];
              const subtractionGeometries: any[] = selectedShape.subtractionGeometries || [];
              const mainBbox = new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position'));
              const cuttingPlanes = computeCuttingPlanes(subtractionGeometries, mainBbox, true) as Array<{ normal: THREE.Vector3; constant: number; subtractorIndex: number }>;

              const buildDescriptors = (): Record<number, FaceDescriptor> => {
                const descriptors: Record<number, FaceDescriptor> = { ...(selectedShape.faceGroupDescriptors || {}) };
                faceGroups.forEach((group, gi) => {
                  const repFace = faces[group.faceIndices[0]];
                  if (repFace) descriptors[gi] = createFaceDescriptor(repFace, geometry);
                });
                return descriptors;
              };

              const axisCandidatesForLabels = new Map<string, Array<number>>();
              const subtractorMapForLabels = new Map<number, Array<number>>();
              const filletMapForLabels = new Map<number, Array<number>>();

              faceGroups.forEach((group, groupIndex) => {
                const axisDir = getAxisDir(group.normal);
                if (axisDir === null) {
                  for (let fi = 0; fi < fillets.length; fi++) {
                    const fillet = fillets[fi];
                    const tol = Math.max(fillet.radius * 2.0, 10);
                    const n1 = new THREE.Vector3(...fillet.face1Data.normal);
                    const n2 = new THREE.Vector3(...fillet.face2Data.normal);
                    const d1 = fillet.face1Data.planeD ?? n1.dot(new THREE.Vector3(...fillet.face1Data.center));
                    const d2 = fillet.face2Data.planeD ?? n2.dot(new THREE.Vector3(...fillet.face2Data.center));
                    if (Math.abs(n1.dot(group.center) - d1) < tol && Math.abs(n2.dot(group.center) - d2) < tol) {
                      if (!filletMapForLabels.has(fi)) filletMapForLabels.set(fi, []);
                      filletMapForLabels.get(fi)!.push(groupIndex);
                      return;
                    }
                  }
                  return;
                }
                for (const plane of cuttingPlanes) {
                  if (Math.abs(group.normal.dot(plane.normal)) >= 0.95 && Math.abs(group.center.dot(plane.normal) + plane.constant) < 1.0) {
                    if (!subtractorMapForLabels.has(plane.subtractorIndex)) subtractorMapForLabels.set(plane.subtractorIndex, []);
                    subtractorMapForLabels.get(plane.subtractorIndex)!.push(groupIndex);
                    return;
                  }
                }
                if (!axisCandidatesForLabels.has(axisDir)) axisCandidatesForLabels.set(axisDir, []);
                axisCandidatesForLabels.get(axisDir)!.push(groupIndex);
              });

              const axisSortedForLabels = Array.from(axisCandidatesForLabels.entries()).sort(([a], [b]) => (AXIS_ORDER[a] ?? 99) - (AXIS_ORDER[b] ?? 99));
              const faceGroupLabels = new Map<number, { label: string; color: string }>();
              const orderedFaceIndices: number[] = [];

              axisSortedForLabels.forEach(([, groupIndices], roleIdx) => {
                const roleNumber = roleIdx + 1;
                if (groupIndices.length > 1) {
                  groupIndices.forEach((gi, si) => { faceGroupLabels.set(gi, { label: `${roleNumber}-${si + 1}`, color: '#1a1a1a' }); orderedFaceIndices.push(gi); });
                } else {
                  faceGroupLabels.set(groupIndices[0], { label: `${roleNumber}`, color: '#1a1a1a' }); orderedFaceIndices.push(groupIndices[0]);
                }
              });
              subtractorMapForLabels.forEach((gis, si) => gis.forEach((gi, fi) => { faceGroupLabels.set(gi, { label: `S${si + 1}.${fi + 1}`, color: '#b45000' }); orderedFaceIndices.push(gi); }));
              filletMapForLabels.forEach((gis, fi) => gis.forEach(gi => { faceGroupLabels.set(gi, { label: `F${fi + 1}`, color: '#006eb4' }); orderedFaceIndices.push(gi); }));
              faceGroups.forEach((_, gi) => { if (!orderedFaceIndices.includes(gi)) orderedFaceIndices.push(gi); });

              const getPanelDimensions = (faceIndex: number) => {
                const panel = shapes.find(s => s.type === 'panel' && s.parameters?.parentShapeId === selectedShape.id && s.parameters?.faceIndex === faceIndex && !s.parameters?.extraRowId);
                if (!panel?.geometry) return null;
                const box = new THREE.Box3().setFromBufferAttribute(panel.geometry.getAttribute('position'));
                const size = new THREE.Vector3();
                box.getSize(size);
                const dims = { w: Math.round(size.x * 10) / 10, h: Math.round(size.y * 10) / 10, d: Math.round(size.z * 10) / 10 };
                const targetAxis = getArrowTargetAxis(panel.geometry, panel.parameters?.faceRole, panel.parameters?.arrowRotated);
                const axesSorted = [{ index: 0, value: size.x }, { index: 1, value: size.y }, { index: 2, value: size.z }].sort((a, b) => a.value - b.value);
                const thicknessAxis = axesSorted[0].index;
                const planeAxes = axesSorted.slice(1).map(a => a.index);
                const secondaryAxis = planeAxes.find(a => a !== targetAxis) ?? planeAxes[0];
                const sizeArr = [dims.w, dims.h, dims.d];
                return { primary: sizeArr[targetAxis], secondary: sizeArr[secondaryAxis], thickness: sizeArr[thicknessAxis], ...dims };
              };

              const handleTogglePanel = async (faceIndex: number) => {
                if (isDisabled) return;
                const newFacePanels = { ...facePanels };
                if (newFacePanels[faceIndex]) {
                  delete newFacePanels[faceIndex];
                  const panelToRemove = shapes.find(s => s.type === 'panel' && s.parameters?.parentShapeId === selectedShape.id && s.parameters?.faceIndex === faceIndex);
                  if (panelToRemove) useAppStore.getState().deleteShape(panelToRemove.id);
                } else {
                  newFacePanels[faceIndex] = true;
                  await createPanelForFace(faceGroups[faceIndex], faces, faceIndex);
                }
                updateShape(selectedShape.id, { facePanels: newFacePanels, faceGroupDescriptors: buildDescriptors() });
                if (selectedProfile !== 'none') await withResolve(() => resolveAllPanelJoints(selectedShape.id, selectedProfile));
              };

              const shapeVirtualFaces = virtualFaces.filter(vf => vf.shapeId === selectedShape.id);

              const createVirtualPanel = async (vfId: string, vfIndex: number) => {
                const vf = shapeVirtualFaces[vfIndex];
                if (!vf) return;
                try {
                  const panelThickness = 18;
                  const { createPanelFromVirtualFace, convertReplicadToThreeGeometry } = await import('./ReplicadService');
                  const replicadPanel = await createPanelFromVirtualFace(vf.vertices, vf.normal, panelThickness);
                  if (!replicadPanel) return;
                  const geometry = convertReplicadToThreeGeometry(replicadPanel);
                  const geoSize = new THREE.Vector3();
                  new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position')).getSize(geoSize);
                  const axesBySize = [{ index: 0, value: geoSize.x }, { index: 1, value: geoSize.y }, { index: 2, value: geoSize.z }].sort((a, b) => a.value - b.value);
                  const planeAxes = axesBySize.slice(1).map(a => a.index).sort((a, b) => a - b);
                  const role = vf.role?.toLowerCase();
                  let defaultAxis = planeAxes[0], altAxis = planeAxes[1];
                  if (role === 'left' || role === 'right') { if (planeAxes.includes(1)) { defaultAxis = 1; altAxis = planeAxes.find(a => a !== 1) ?? planeAxes[1]; } }
                  else if (role === 'top' || role === 'bottom') { if (planeAxes.includes(0)) { defaultAxis = 0; altAxis = planeAxes.find(a => a !== 0) ?? planeAxes[1]; } }
                  const sizeArr = [geoSize.x, geoSize.y, geoSize.z];
                  addShape({
                    id: `panel-vf-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
                    type: 'panel', geometry, replicadShape: replicadPanel,
                    position: [...selectedShape.position] as [number, number, number],
                    rotation: selectedShape.rotation,
                    scale: [...selectedShape.scale] as [number, number, number],
                    color: '#ffffff',
                    parameters: { width: sizeArr[defaultAxis], height: sizeArr[altAxis], depth: panelThickness, parentShapeId: selectedShape.id, faceIndex: -(vfIndex + 1), faceRole: vf.role, virtualFaceId: vf.id, arrowRotated: false }
                  } as any);
                  updateVirtualFace(vf.id, { hasPanel: true });
                } catch (err) { console.error('Failed to create panel for virtual face:', err); }
              };

              const removeVirtualPanel = (vfId: string) => {
                const panelToRemove = shapes.find(s => s.type === 'panel' && s.parameters?.parentShapeId === selectedShape.id && s.parameters?.virtualFaceId === vfId);
                if (panelToRemove) useAppStore.getState().deleteShape(panelToRemove.id);
                updateVirtualFace(vfId, { hasPanel: false });
              };

              const dimCls = (bg: string, border: string) =>
                `w-[48px] px-1 py-0.5 text-xs font-mono border rounded text-center ${bg} text-gray-800 ${border} font-semibold`;
              const dimClsEmpty = (bg: string, border: string) =>
                `w-[48px] px-1 py-0.5 text-xs font-mono border rounded text-center ${bg} text-stone-400 ${border}`;
              const inputCls = (disabled: boolean) =>
                `px-1 py-0.5 text-xs border rounded ${disabled ? 'bg-stone-100 text-stone-400 border-stone-200' : 'bg-white text-gray-800 border-gray-300'}`;
              const rotateBtn = (disabled: boolean, active: boolean) =>
                `p-0.5 rounded transition-colors ${disabled ? 'text-stone-300 cursor-not-allowed' : active ? 'text-blue-600 bg-blue-50 hover:bg-blue-100' : 'text-slate-500 hover:bg-stone-100'}`;

              return (
                <div className={`space-y-0.5 pt-2 border-t border-stone-300 ${isDisabled ? 'opacity-40 pointer-events-none' : ''}`}>
                  <div className={`text-xs font-semibold mb-1 flex items-center gap-2 ${isDisabled ? 'text-stone-400' : 'text-orange-700'}`}>
                    <span>Face Roles ({faceGroups.length + shapeVirtualFaces.length} faces)</span>
                    {resolving && <span className="text-[10px] font-normal text-orange-500 animate-pulse">resolving joints...</span>}
                  </div>
                  {orderedFaceIndices.map((i) => {
                    const dimensions = getPanelDimensions(i);
                    const isRowSelected = selectedPanelRow === i;
                    const faceLabel = faceGroupLabels.get(i);
                    const labelText = faceLabel?.label ?? `${i + 1}`;
                    const labelColor = faceLabel?.color ?? '#1a1a1a';
                    const panelShape = shapes.find(s => s.type === 'panel' && s.parameters?.parentShapeId === selectedShape.id && s.parameters?.faceIndex === i && !s.parameters?.extraRowId);
                    const arrowRotated = panelShape?.parameters?.arrowRotated ?? false;
                    return (
                      <div
                        key={`face-${i}`}
                        ref={(el) => { if (el) rowRefs.current.set(i, el); else rowRefs.current.delete(i); }}
                        className={`flex gap-0.5 items-center p-0.5 rounded transition-colors ${isRowSelected ? 'bg-orange-50 ring-1 ring-orange-400' : 'hover:bg-gray-50'} ${facePanels[i] ? 'cursor-pointer' : ''}`}
                        onClick={(e) => { e.stopPropagation(); if (facePanels[i]) setSelectedPanelRow(i, null); }}
                      >
                        <input type="radio" name="panel-selection" checked={isRowSelected} disabled={isDisabled || !facePanels[i]} onChange={(e) => { e.stopPropagation(); setSelectedPanelRow(i, null); }} className={`w-4 h-4 ${isDisabled || !facePanels[i] ? 'text-stone-300 cursor-not-allowed' : 'text-orange-600 focus:ring-orange-500 cursor-pointer'}`} onClick={(e) => e.stopPropagation()} />
                        <input type="text" value={labelText} readOnly tabIndex={-1} disabled={isDisabled} style={isDisabled ? undefined : { color: labelColor }} className={`w-10 px-1 py-0.5 text-xs font-mono font-bold border rounded text-center ${isDisabled ? 'bg-stone-100 text-stone-400 border-stone-200' : 'bg-white border-gray-300'}`} onClick={(e) => e.stopPropagation()} />
                        <select value={faceRoles[i] || ''} disabled={isDisabled} onClick={(e) => e.stopPropagation()} onChange={async (e) => {
                          const newRole = e.target.value === '' ? null : e.target.value as FaceRole;
                          const newFaceRoles = { ...faceRoles, [i]: newRole };
                          if (newRole === null) delete newFaceRoles[i];
                          updateShape(selectedShape.id, { faceRoles: newFaceRoles, faceGroupDescriptors: buildDescriptors() });
                          if (newRole !== null && labelText && !labelText.startsWith('S') && !labelText.startsWith('F')) faceLabelRoleDefaultsService.upsert(labelText, newRole);
                          if (panelShape) {
                            updateShape(panelShape.id, { parameters: { ...panelShape.parameters, faceRole: newRole } });
                            if (selectedProfile !== 'none') await withResolve(async () => { await rebuildAllPanels(selectedShape.id); await resolveAllPanelJoints(selectedShape.id, selectedProfile); });
                          }
                        }} style={{ width: '35mm' }} className={inputCls(isDisabled)}>
                          <option value="">none</option>
                          {roleOptions.map(role => <option key={role} value={role}>{role}</option>)}
                        </select>
                        <input type="text" value={faceDescriptions[i] || ''} disabled={isDisabled} onClick={(e) => e.stopPropagation()} onChange={(e) => updateShape(selectedShape.id, { faceDescriptions: { ...faceDescriptions, [i]: e.target.value }, faceGroupDescriptors: buildDescriptors() })} placeholder="description" style={{ width: '40mm' }} className={`px-2 py-0.5 text-xs border rounded ${isDisabled ? 'bg-stone-100 text-stone-400 border-stone-200 placeholder:text-stone-300' : 'bg-white text-gray-800 border-gray-300'}`} />
                        <input type="text" value={dimensions?.primary || 'NaN'} readOnly tabIndex={-1} onClick={(e) => e.stopPropagation()} className={dimCls('bg-orange-50', 'border-orange-300')} title="Arrow Direction Dimension" />
                        <input type="text" value={dimensions?.secondary || 'NaN'} readOnly tabIndex={-1} onClick={(e) => e.stopPropagation()} className={dimCls('bg-blue-50', 'border-blue-300')} title="Perpendicular to Arrow Direction" />
                        <input type="text" value={dimensions?.thickness || 'NaN'} readOnly tabIndex={-1} onClick={(e) => e.stopPropagation()} className={dimCls('bg-green-50', 'border-green-300')} title="Panel Thickness" />
                        <input type="checkbox" checked={facePanels[i] || false} disabled={isDisabled} onClick={(e) => e.stopPropagation()} onChange={() => handleTogglePanel(i)} className={`w-4 h-4 border-gray-300 rounded ${isDisabled ? 'text-stone-300 cursor-not-allowed' : 'text-green-600 focus:ring-green-500 cursor-pointer'}`} />
                        <button disabled={isDisabled || !facePanels[i]} onClick={(e) => { e.stopPropagation(); if (panelShape) updateShape(panelShape.id, { parameters: { ...panelShape.parameters, arrowRotated: !arrowRotated } }); }} className={rotateBtn(isDisabled || !facePanels[i], arrowRotated)} title="Rotate arrow direction">
                          <RotateCw size={13} />
                        </button>
                      </div>
                    );
                  })}

                  {shapeVirtualFaces.map((vf, vfIdx) => {
                    const virtualPanel = shapes.find(s => s.type === 'panel' && s.parameters?.parentShapeId === selectedShape.id && s.parameters?.virtualFaceId === vf.id);
                    const panelWidth = virtualPanel?.parameters?.width || 0;
                    const panelHeight = virtualPanel?.parameters?.height || 0;
                    const panelDepth = virtualPanel?.parameters?.depth || 0;
                    const arrowRotated = virtualPanel?.parameters?.arrowRotated || false;
                    const isRowSelected = selectedPanelRow === `vf-${vf.id}`;
                    return (
                      <div key={vf.id} className={`flex gap-0.5 items-center p-0.5 rounded transition-colors ${isRowSelected ? 'bg-orange-50 ring-1 ring-orange-400' : 'hover:bg-gray-50'} ${vf.hasPanel ? 'cursor-pointer' : ''}`} onClick={(e) => { e.stopPropagation(); if (vf.hasPanel) setSelectedPanelRow(`vf-${vf.id}`); }}>
                        <input type="radio" name="panel-selection" checked={isRowSelected} disabled={isDisabled || !vf.hasPanel} onChange={(e) => { e.stopPropagation(); setSelectedPanelRow(`vf-${vf.id}`); }} className={`w-4 h-4 ${isDisabled || !vf.hasPanel ? 'text-stone-300 cursor-not-allowed' : 'text-orange-600 focus:ring-orange-500 cursor-pointer'}`} onClick={(e) => e.stopPropagation()} />
                        <input type="text" value={`V${vfIdx + 1}`} readOnly tabIndex={-1} className="w-7 px-1 py-0.5 text-xs font-mono border rounded text-center bg-green-100 text-green-800 border-green-300" onClick={(e) => e.stopPropagation()} />
                        <select value={vf.role || ''} disabled={isDisabled} onClick={(e) => e.stopPropagation()} onChange={async (e) => {
                          const newRole = e.target.value === '' ? null : e.target.value as FaceRole;
                          updateVirtualFace(vf.id, { role: newRole });
                          if (virtualPanel) {
                            updateShape(virtualPanel.id, { parameters: { ...virtualPanel.parameters, faceRole: newRole } });
                            if (selectedProfile !== 'none') await withResolve(async () => { await rebuildAllPanels(selectedShape.id); await resolveAllPanelJoints(selectedShape.id, selectedProfile); });
                          }
                        }} style={{ width: '35mm' }} className={`px-1 py-0.5 text-xs border rounded ${isDisabled ? 'bg-stone-100 text-stone-400 border-stone-200' : 'bg-white text-gray-800 border-green-300'}`}>
                          <option value="">none</option>
                          {roleOptions.map(role => <option key={role} value={role}>{role}</option>)}
                        </select>
                        <input type="text" value={vf.description || ''} disabled={isDisabled} onClick={(e) => e.stopPropagation()} onChange={(e) => updateVirtualFace(vf.id, { description: e.target.value })} placeholder="description" style={{ width: '40mm' }} className={`px-2 py-0.5 text-xs border rounded ${isDisabled ? 'bg-stone-100 text-stone-400 border-stone-200 placeholder:text-stone-300' : 'bg-white text-gray-800 border-green-300'}`} />
                        <input type="text" value={vf.hasPanel ? (arrowRotated ? Math.round(panelHeight) : Math.round(panelWidth)) : '—'} readOnly tabIndex={-1} className={vf.hasPanel ? dimCls('bg-orange-50', 'border-orange-300') : dimClsEmpty('bg-orange-50', 'border-orange-200')} title="Arrow Direction Dimension" onClick={(e) => e.stopPropagation()} />
                        <input type="text" value={vf.hasPanel ? (arrowRotated ? Math.round(panelWidth) : Math.round(panelHeight)) : '—'} readOnly tabIndex={-1} className={vf.hasPanel ? dimCls('bg-blue-50', 'border-blue-300') : dimClsEmpty('bg-blue-50', 'border-blue-200')} title="Perpendicular Dimension" onClick={(e) => e.stopPropagation()} />
                        <input type="text" value={vf.hasPanel ? Math.round(panelDepth) : '—'} readOnly tabIndex={-1} className={vf.hasPanel ? dimCls('bg-green-50', 'border-green-300') : dimClsEmpty('bg-green-50', 'border-green-200')} title="Panel Thickness" onClick={(e) => e.stopPropagation()} />
                        <input type="checkbox" checked={vf.hasPanel} disabled={isDisabled} onClick={(e) => e.stopPropagation()} onChange={async () => {
                          if (vf.hasPanel) { removeVirtualPanel(vf.id); }
                          else {
                            await createVirtualPanel(vf.id, vfIdx);
                            if (selectedProfile !== 'none') await withResolve(() => resolveAllPanelJoints(selectedShape.id, selectedProfile));
                          }
                        }} className={`w-4 h-4 border-gray-300 rounded ${isDisabled ? 'text-stone-300 cursor-not-allowed' : 'text-green-600 focus:ring-green-500 cursor-pointer'}`} />
                        <button disabled={isDisabled || !vf.hasPanel} onClick={(e) => { e.stopPropagation(); if (virtualPanel) updateShape(virtualPanel.id, { parameters: { ...virtualPanel.parameters, arrowRotated: !arrowRotated } }); }} className={rotateBtn(isDisabled || !vf.hasPanel, arrowRotated)} title="Rotate arrow direction">
                          <RotateCw size={13} />
                        </button>
                        <button disabled={isDisabled} onClick={(e) => { e.stopPropagation(); if (vf.hasPanel) removeVirtualPanel(vf.id); deleteVirtualFace(vf.id); }} className="p-0.5 hover:bg-red-100 rounded transition-colors" title="Delete virtual face">
                          <Trash2 size={13} className="text-red-400" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        ) : (
          <div className="text-center text-stone-500 text-xs py-4">No shape selected</div>
        )}
      </div>
    </div>
  );
}
