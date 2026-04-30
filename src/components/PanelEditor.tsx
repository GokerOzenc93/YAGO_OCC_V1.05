import React, { useState, useEffect, useRef, useMemo } from 'react';
import { X, GripVertical, RotateCw, Trash2, MoveVertical, Check, Pencil } from 'lucide-react';
import { globalSettingsService, faceLabelRoleDefaultsService, GlobalSettingsProfile } from './GlobalSettingsDatabase';
import { useAppStore } from '../store';
import type { FaceRole } from '../store';
import { extractFacesFromGeometry, groupCoplanarFaces, CoplanarFaceGroup } from './FaceEditor';
import { resolveAllPanelJoints, restoreAllPanels, rebuildAndRecalculatePipeline } from './PanelJointService';
import { findExistingStepForFace } from './FaceExtrudeService';
import type { FilletData } from './Fillet';
import * as THREE from 'three';

const AXIS_ORDER: Record<string, number> = { 'x+': 0, 'x-': 1, 'y+': 2, 'y-': 3, 'z+': 4, 'z-': 5 };
const ROLE_OPTIONS: FaceRole[] = ['Left', 'Right', 'Top', 'Bottom', 'Back', 'Door'];
const PANEL_THICKNESS = 18;
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
const genId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
const r1 = (v: number) => Math.round(v * 10) / 10;

function getAxisDir(n: THREE.Vector3): string | null {
  const t = 0.95;
  if (n.x > t) return 'x+'; if (n.x < -t) return 'x-';
  if (n.y > t) return 'y+'; if (n.y < -t) return 'y-';
  if (n.z > t) return 'z+'; if (n.z < -t) return 'z-';
  return null;
}

function roleBasedAxes(planeAxes: number[], role?: string | null) {
  let [def, alt] = [planeAxes[0], planeAxes[1]];
  const r = role?.toLowerCase();
  if ((r === 'left' || r === 'right') && planeAxes.includes(1)) { def = 1; alt = planeAxes.find(a => a !== 1) ?? planeAxes[1]; }
  else if ((r === 'top' || r === 'bottom') && planeAxes.includes(0)) { def = 0; alt = planeAxes.find(a => a !== 0) ?? planeAxes[1]; }
  return { def, alt };
}

function geoAxes(geo: THREE.BufferGeometry) {
  const pos = geo.getAttribute('position');
  if (!pos) return null;
  const bbox = new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute);
  const size = new THREE.Vector3(); bbox.getSize(size);
  const axes = [{ i: 0, v: size.x }, { i: 1, v: size.y }, { i: 2, v: size.z }].sort((a, b) => a.v - b.v);
  return { axes, size, bbox };
}

function computeCuttingPlanes(mainBbox: THREE.Box3, subs: any[]) {
  const planes: Array<{ normal: THREE.Vector3; constant: number; si: number }> = [];
  subs.forEach((sub, si) => {
    if (!sub?.geometry) return;
    const sb = new THREE.Box3().setFromBufferAttribute(sub.geometry.getAttribute('position'));
    const off = new THREE.Vector3(...sub.relativeOffset);
    const rot = sub.relativeRotation;
    const rm = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ'));
    const corners = [
      [sb.min.x,sb.min.y,sb.min.z],[sb.max.x,sb.min.y,sb.min.z],[sb.min.x,sb.max.y,sb.min.z],[sb.max.x,sb.max.y,sb.min.z],
      [sb.min.x,sb.min.y,sb.max.z],[sb.max.x,sb.min.y,sb.max.z],[sb.min.x,sb.max.y,sb.max.z],[sb.max.x,sb.max.y,sb.max.z],
    ].map(([x,y,z]) => new THREE.Vector3(x,y,z).applyMatrix4(rm).add(off));
    const wb = new THREE.Box3().setFromPoints(corners);
    const normals = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].map(([x,y,z]) => new THREE.Vector3(x,y,z));
    const consts = [-wb.max.x, wb.min.x, -wb.max.y, wb.min.y, -wb.max.z, wb.min.z];
    const positions = [wb.max.x, wb.min.x, wb.max.y, wb.min.y, wb.max.z, wb.min.z];
    for (let pi = 0; pi < 6; pi++) {
      const ax = Math.floor(pi / 2);
      const mn = ax === 0 ? mainBbox.min.x : ax === 1 ? mainBbox.min.y : mainBbox.min.z;
      const mx = ax === 0 ? mainBbox.max.x : ax === 1 ? mainBbox.max.y : mainBbox.max.z;
      if (positions[pi] > mn + 1.0 && positions[pi] < mx - 1.0)
        planes.push({ normal: normals[pi], constant: consts[pi], si });
    }
  });
  return planes;
}

function isFilletFace(group: CoplanarFaceGroup, fillet: FilletData): boolean {
  const tol = Math.max(fillet.radius * 2.0, 10);
  const n1 = new THREE.Vector3(...fillet.face1Data.normal), n2 = new THREE.Vector3(...fillet.face2Data.normal);
  const d1 = fillet.face1Data.planeD ?? n1.dot(new THREE.Vector3(...fillet.face1Data.center));
  const d2 = fillet.face2Data.planeD ?? n2.dot(new THREE.Vector3(...fillet.face2Data.center));
  return Math.abs(n1.dot(group.center) - d1) < tol && Math.abs(n2.dot(group.center) - d2) < tol;
}

function classifyFaceGroups(groups: CoplanarFaceGroup[], fillets: FilletData[], planes: ReturnType<typeof computeCuttingPlanes>) {
  const axis = new Map<string, number[]>(), subs = new Map<number, number[]>(), fills = new Map<number, number[]>();
  groups.forEach((g, gi) => {
    const dir = getAxisDir(g.normal);
    if (!dir) {
      for (let fi = 0; fi < fillets.length; fi++)
        if (isFilletFace(g, fillets[fi])) { if (!fills.has(fi)) fills.set(fi, []); fills.get(fi)!.push(gi); return; }
      return;
    }
    for (const p of planes)
      if (Math.abs(g.normal.dot(p.normal)) >= 0.95 && Math.abs(g.center.dot(p.normal) + p.constant) < 1.0) {
        if (!subs.has(p.si)) subs.set(p.si, []); subs.get(p.si)!.push(gi); return;
      }
    if (!axis.has(dir)) axis.set(dir, []); axis.get(dir)!.push(gi);
  });
  return { axis, subs, fills };
}


const findVPanel = (shapes: any[], pid: string, vfId: string) => shapes.find(s => s.type === 'panel' && s.parameters?.parentShapeId === pid && s.parameters?.virtualFaceId === vfId);

function makePanelBase(shape: any, extra: Record<string, any>) {
  return { id: genId(extra.parameters?.virtualFaceId ? 'panel-vf' : 'panel'), type: 'panel' as const,
    position: [...shape.position] as [number,number,number], rotation: shape.rotation, scale: [...shape.scale] as [number,number,number], color: '#ffffff', ...extra };
}

function getDimsFromGeo(geo: THREE.BufferGeometry, role?: string | null, arrowRotated?: boolean) {
  const r = geoAxes(geo); if (!r) return null;
  const pa = r.axes.slice(1).map(a => a.i).sort((a, b) => a - b);
  const { def, alt } = roleBasedAxes(pa, role);
  const target = arrowRotated ? alt : def, secondary = pa.find(a => a !== target) ?? pa[0], s = [r.size.x, r.size.y, r.size.z];
  return { primary: r1(s[target]), secondary: r1(s[secondary]), thickness: r1(s[r.axes[0].i]), w: r1(r.size.x), h: r1(r.size.y), d: r1(r.size.z) };
}

type Dims = NonNullable<ReturnType<typeof getDimsFromGeo>>;
interface PanelEditorProps { isOpen: boolean; onClose: () => void; embedded?: boolean; }

export function PanelEditor({ isOpen, onClose, embedded = false }: PanelEditorProps) {
  const { selectedShapeId, shapes, updateShape, addShape, showOutlines, setShowOutlines, showRoleNumbers, setShowRoleNumbers,
    selectedPanelRow, setSelectedPanelRow, panelSelectMode, setPanelSelectMode, raycastMode, setRaycastMode,
    showVirtualFaces, setShowVirtualFaces, virtualFaces, updateVirtualFace, deleteVirtualFace, pendingPanelCreation,
    setActivePanelProfileId, setShapeRebuilding, faceExtrudeMode, setFaceExtrudeMode, faceExtrudeTargetPanelId,
    setFaceExtrudeTargetPanelId, faceExtrudeSelectedFace, setFaceExtrudeSelectedFace, setFaceExtrudeHoveredFace,
    faceExtrudeThickness, setFaceExtrudeThickness, faceExtrudeFixedMode, setFaceExtrudeFixedMode } = useAppStore();

  const [position, setPosition] = useState({ x: 100, y: 100 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [profiles, setProfiles] = useState<GlobalSettingsProfile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState('none');
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState(false);
  const [editingStepId, setEditingStepId] = useState<string | null>(null);
  const [editingStepValue, setEditingStepValue] = useState(0);
  const prevProfileRef = useRef('none');
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const selectedProfileRef = useRef('none');
  selectedProfileRef.current = selectedProfile;
  const selectedShape = shapes.find(s => s.id === selectedShapeId);

  const withResolving = async (sid: string, fn: () => Promise<void>) => {
    setResolving(true); setShapeRebuilding(sid, true);
    try { await fn(); } finally { setResolving(false); setShapeRebuilding(sid, false); }
  };
  const resolveIfActive = async (sid: string, pid?: string) => { const p = pid ?? selectedProfile; if (p !== 'none') await withResolving(sid, () => resolveAllPanelJoints(sid, p)); };
  const rebuildIfActive = async (sid: string) => { if (selectedProfile !== 'none') await withResolving(sid, () => rebuildAndRecalculatePipeline(sid, selectedProfile)); };

  const activePanelId = useMemo(() => {
    if (!selectedShape || selectedPanelRow === null) return null;
    if (typeof selectedPanelRow === 'string' && selectedPanelRow.startsWith('vf-'))
      return findVPanel(shapes, selectedShape.id, selectedPanelRow.replace('vf-', ''))?.id || null;
    return null;
  }, [selectedShape, selectedPanelRow, shapes]);

  useEffect(() => { setSelectedPanelRow(null); }, [selectedShapeId]);
  useEffect(() => {
    if (faceExtrudeMode && activePanelId && activePanelId !== faceExtrudeTargetPanelId)
      { setFaceExtrudeTargetPanelId(activePanelId); setFaceExtrudeSelectedFace(null); setFaceExtrudeHoveredFace(null); }
  }, [faceExtrudeMode, activePanelId, faceExtrudeTargetPanelId]);
  useEffect(() => {
    if (faceExtrudeSelectedFace === null || !activePanelId) return;
    const ps = shapes.find(s => s.id === activePanelId); if (!ps?.geometry) return;
    const steps = ps.parameters?.extrudeSteps || []; if (!steps.length) return;
    const g = groupCoplanarFaces(extractFacesFromGeometry(ps.geometry))[faceExtrudeSelectedFace]; if (!g) return;
    const existing = findExistingStepForFace(steps, g.normal.clone().normalize(), g.center.clone());
    if (existing) { setFaceExtrudeThickness(existing.value); setFaceExtrudeFixedMode(existing.isFixed); }
  }, [faceExtrudeSelectedFace, activePanelId, shapes]);
  useEffect(() => { if (isOpen || embedded) loadProfiles(); else { setSelectedPanelRow(null); setPanelSelectMode(false); if (faceExtrudeMode) setFaceExtrudeMode(false); } }, [isOpen, embedded]);
  useEffect(() => { if (selectedPanelRow !== null) rowRefs.current.get(selectedPanelRow)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [selectedPanelRow]);
  useEffect(() => { setActivePanelProfileId(selectedProfile !== 'none' ? selectedProfile : null); }, [selectedProfile]);
  useEffect(() => {
    if (prevProfileRef.current === selectedProfile) return; prevProfileRef.current = selectedProfile; if (!selectedShapeId) return;
    if (selectedProfile !== 'none') withResolving(selectedShapeId, () => resolveAllPanelJoints(selectedShapeId, selectedProfile));
    else restoreAllPanels(selectedShapeId);
  }, [selectedProfile, selectedShapeId]);
  useEffect(() => {
    if (!selectedShape?.geometry) return;
    (async () => {
      const ld = await faceLabelRoleDefaultsService.getAll();
      const geo = selectedShape.geometry, faces = extractFacesFromGeometry(geo), groups = groupCoplanarFaces(faces);
      const bb = new THREE.Box3().setFromBufferAttribute(geo.getAttribute('position'));
      const { axis } = classifyFaceGroups(groups, selectedShape.fillets || [], computeCuttingPlanes(bb, selectedShape.subtractionGeometries || []));
      const sorted = Array.from(axis.entries()).sort(([a], [b]) => (AXIS_ORDER[a] ?? 99) - (AXIS_ORDER[b] ?? 99));
      const nr: Record<number, FaceRole> = {};
      sorted.forEach(([, gis], ri) => { const rn = ri + 1; gis.forEach((gi, si) => { const l = gis.length > 1 ? `${rn}-${si+1}` : `${rn}`; if (ld[l]) nr[gi] = ld[l] as FaceRole; }); });
      updateShape(selectedShape.id, { faceRoles: nr });
    })();
  }, [selectedShape?.id, selectedShape?.geometry]);
  useEffect(() => {
    if (!pendingPanelCreation || (!isOpen && !embedded)) return;
    const cid = pendingPanelCreation.surfaceConstraint?.constraintPanelId; if (!cid) return;
    const vf = virtualFaces.find(f => f.id === cid); if (!vf || vf.hasPanel) return;
    const cs = useAppStore.getState().shapes.find(s => s.id === vf.shapeId); if (!cs) return;
    const vi = virtualFaces.filter(f => f.shapeId === vf.shapeId).findIndex(f => f.id === vf.id); if (vi === -1) return;
    (async () => {
      try {
        const { createPanelFromVirtualFace, convertReplicadToThreeGeometry } = await import('./ReplicadService');
        const rp = await createPanelFromVirtualFace(vf.vertices, vf.normal, PANEL_THICKNESS); if (!rp) return;
        addShape(makePanelBase(cs, { geometry: convertReplicadToThreeGeometry(rp), replicadShape: rp,
          parameters: { width: 0, height: 0, depth: PANEL_THICKNESS, parentShapeId: cs.id, faceIndex: -(vi+1), faceRole: vf.role, virtualFaceId: vf.id } }));
        updateVirtualFace(vf.id, { hasPanel: true });
        await resolveIfActive(cs.id, selectedProfileRef.current);
      } catch (err) { console.error('Failed to create panel for virtual face via click:', err); }
    })();
  }, [pendingPanelCreation]);

  const loadProfiles = async () => { try { setLoading(true); setProfiles(await globalSettingsService.listProfiles()); } catch (e) { console.error('Failed to load profiles:', e); } finally { setLoading(false); } };


  const handleMouseDown = (e: React.MouseEvent) => { e.preventDefault(); setIsDragging(true); setDragOffset({ x: e.clientX - position.x, y: e.clientY - position.y }); };
  useEffect(() => {
    if (!isDragging) return;
    document.body.style.userSelect = 'none'; document.body.style.cursor = 'grabbing';
    const onMove = (e: MouseEvent) => { e.preventDefault(); setPosition({ x: e.clientX - dragOffset.x, y: e.clientY - dragOffset.y }); };
    const onUp = () => setIsDragging(false);
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
    return () => { document.body.style.userSelect = ''; document.body.style.cursor = ''; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, [isDragging, dragOffset]);

  const saveStep = async (pid: string | null, stepId: string, val: number) => {
    if (!pid) return; const ps = shapes.find(s => s.id === pid); if (!ps) return;
    const { updateExtrudeStep } = await import('./FaceExtrudeService'); await updateExtrudeStep(ps, stepId, val, updateShape); setEditingStepId(null);
  };
  const toggleArrow = (p: any) => { if (p) updateShape(p.id, { parameters: { ...p.parameters, arrowRotated: !p.parameters?.arrowRotated } }); };

  if (!isOpen && !embedded) return null;

  const tb = (active: boolean, onClick: () => void, label: string, cls: [string, string]) => (
    <button onClick={onClick} className={`px-1.5 py-0.5 rounded text-xs font-semibold transition-colors ${active ? cls[0] : cls[1]}`}>{label}</button>
  );

  const panelToolbar = (
    <div className="flex items-center gap-1 flex-wrap">
      {tb(showVirtualFaces, () => setShowVirtualFaces(!showVirtualFaces), 'Raycast', ['text-green-700 bg-green-100 ring-1 ring-green-400', 'text-slate-500 hover:bg-stone-200'])}
      {tb(showOutlines, () => setShowOutlines(!showOutlines), 'Outline', ['text-blue-700 bg-blue-100 ring-1 ring-blue-400', 'text-slate-500 hover:bg-stone-200'])}
      {tb(showRoleNumbers, () => setShowRoleNumbers(!showRoleNumbers), 'Roles', ['text-orange-700 bg-orange-100 ring-1 ring-orange-400', 'text-slate-500 hover:bg-stone-200'])}
      {tb(raycastMode, () => setRaycastMode(!raycastMode), 'Add Face', ['text-amber-700 bg-amber-100 ring-1 ring-amber-400', 'text-slate-500 hover:bg-stone-200'])}
      <button onClick={async () => { if (selectedShape && selectedProfile !== 'none' && !resolving) await withResolving(selectedShape.id, () => rebuildAndRecalculatePipeline(selectedShape.id, selectedProfile)); }}
        disabled={!selectedShape || selectedProfile === 'none' || resolving}
        className={`px-1.5 py-0.5 rounded text-xs font-semibold transition-colors ${!selectedShape || selectedProfile === 'none' || resolving ? 'text-stone-300 cursor-not-allowed' : 'text-slate-500 hover:bg-stone-200'}`}>
        {resolving ? 'Calc...' : 'Recalc'}
      </button>
      {tb(panelSelectMode, () => setPanelSelectMode(!panelSelectMode), panelSelectMode ? 'Panel' : 'Body', ['text-violet-700 bg-violet-100 ring-1 ring-violet-400', 'text-slate-500 hover:bg-stone-200'])}
    </div>
  );

  const panelContent = selectedShape ? (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <label className="text-xs font-semibold text-stone-600 whitespace-nowrap">Select Body Profile</label>
        {loading ? <div className="px-2 py-0.5 text-xs text-stone-400 bg-white border border-stone-300 rounded" style={{ width: '30mm' }}>Loading...</div>
          : <select value={selectedProfile} onChange={e => setSelectedProfile(e.target.value)}
              className="px-2 py-0.5 text-xs bg-white text-stone-700 border border-stone-300 rounded focus:outline-none focus:border-orange-400" style={{ width: '30mm' }}>
              <option value="none">None</option>{profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
      </div>
      {(() => {
        const geo = selectedShape.geometry; if (!geo) return null;
        const isOff = selectedProfile === 'none', sid = selectedShape.id;
        const svf = virtualFaces.filter(vf => vf.shapeId === sid);
        const createVP = async (_: string, vi: number) => {
          const vf = svf[vi]; if (!vf) return;
          try {
            const { createPanelFromVirtualFace, convertReplicadToThreeGeometry } = await import('./ReplicadService');
            const rp = await createPanelFromVirtualFace(vf.vertices, vf.normal, PANEL_THICKNESS); if (!rp) return;
            const g = convertReplicadToThreeGeometry(rp), r = geoAxes(g); if (!r) return;
            const pa = r.axes.slice(1).map(a => a.i).sort((a, b) => a - b), { def, alt } = roleBasedAxes(pa, vf.role), s = [r.size.x, r.size.y, r.size.z];
            addShape(makePanelBase(selectedShape, { geometry: g, replicadShape: rp,
              parameters: { width: s[def], height: s[alt], depth: PANEL_THICKNESS, parentShapeId: sid, faceIndex: -(vi+1), faceRole: vf.role, virtualFaceId: vf.id, arrowRotated: false, roleless: vf.roleSelected && vf.role === null } }));
            updateVirtualFace(vf.id, { hasPanel: true });
          } catch (e) { console.error('Failed to create virtual panel:', e); }
        };
        const removeVP = (vfId: string) => { const p = findVPanel(shapes, sid, vfId); if (p) useAppStore.getState().deleteShape(p.id); updateVirtualFace(vfId, { hasPanel: false }); };
        const roleSel = (val: string, onChange: (v: string) => void, bc = 'border-transparent') => (
          <select value={val} disabled={isOff} onClick={stop} onChange={e => onChange(e.target.value)} style={{ width: '28mm' }}
            className={`px-1 py-0.5 text-xs border-b rounded-none bg-transparent ${isOff ? 'text-stone-400 border-stone-200' : `text-gray-700 ${bc} hover:border-gray-300 focus:border-orange-400`}`}>
            <option value="">—</option>{ROLE_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}<option value="__none__">Rolsüz</option></select>
        );
        return (
          <div className={`space-y-0 pt-2 border-t border-stone-200 ${isOff ? 'opacity-40 pointer-events-none' : ''}`}>
            {resolving && <div className="text-xs font-normal text-orange-500 animate-pulse mb-1">resolving joints...</div>}
            {svf.map((vf, vi) => {
              const vp = findVPanel(shapes, sid, vf.id), ar = vp?.parameters?.arrowRotated||false, sel = selectedPanelRow === `vf-${vf.id}`;
              const roleChosen = !!vf.roleSelected;
              const selVal = roleChosen ? (vf.role || '__none__') : '';
              const rc = () => { if (vf.hasPanel) setSelectedPanelRow(`vf-${vf.id}`, null, sid); };
              return (
                <div key={vf.id} className={`flex w-fit gap-1 items-center py-0.5 px-1 rounded transition-colors ${sel ? 'bg-orange-50 ring-1 ring-orange-300' : 'hover:bg-stone-50'} ${vf.hasPanel ? 'cursor-pointer' : ''}`}
                  onClick={e => { stop(e); rc(); }}>
                  <input type="radio" name="ps" checked={sel} disabled={isOff||!vf.hasPanel} onChange={e => { stop(e); rc(); }}
                    className={`w-3.5 h-3.5 ${isOff||!vf.hasPanel ? 'text-stone-300 cursor-not-allowed' : 'text-orange-500 focus:ring-orange-400 cursor-pointer'}`} onClick={stop} />
                  <span className="w-8 text-xs font-mono font-bold text-center text-green-700 select-none" onClick={stop}>V{vi+1}</span>
                  {roleSel(selVal, async v => {
                    if (v === '') { updateVirtualFace(vf.id, { role: null, roleSelected: false }); if (vp) { updateShape(vp.id, { parameters: { ...vp.parameters, faceRole: null, roleless: false } }); await rebuildIfActive(sid); } return; }
                    const nr: FaceRole = v === '__none__' ? null : (v as FaceRole);
                    updateVirtualFace(vf.id, { role: nr, roleSelected: true });
                    if (vp) { updateShape(vp.id, { parameters: { ...vp.parameters, faceRole: nr, roleless: v === '__none__' } }); await rebuildIfActive(sid); }
                  }, 'border-transparent')}
                  <input type="text" value={vf.description||''} disabled={isOff} onClick={stop} onChange={e => updateVirtualFace(vf.id, { description: e.target.value })}
                    placeholder="note" style={{ width: '32mm' }}
                    className={`px-1 py-0.5 text-xs bg-transparent border-b rounded-none ${isOff ? 'text-stone-400 border-stone-200 placeholder:text-stone-300' : 'text-gray-600 border-transparent hover:border-gray-300 focus:border-orange-400 placeholder:text-stone-300'}`} />
                  <div className="ml-1 flex items-center gap-0.5">
                    <input type="checkbox" checked={vf.hasPanel} disabled={isOff||!roleChosen} onClick={stop}
                      onChange={async () => { if (vf.hasPanel) removeVP(vf.id); else { await createVP(vf.id, vi); await resolveIfActive(sid); } }}
                      className={`w-3.5 h-3.5 rounded ${isOff||!roleChosen ? 'text-stone-300 cursor-not-allowed' : 'text-green-500 focus:ring-green-400 cursor-pointer'}`} title={roleChosen ? `Toggle virtual face V${vi+1}` : 'Önce rol seçin'} />
                    <button disabled={isOff||!vf.hasPanel} onClick={e => { stop(e); toggleArrow(vp); }}
                      className={`p-0.5 rounded transition-colors ${isOff||!vf.hasPanel ? 'text-stone-300 cursor-not-allowed' : ar ? 'text-blue-500' : 'text-stone-300 hover:text-stone-500'}`}
                      title="Rotate arrow direction"><RotateCw size={12} /></button>
                    <button disabled={isOff} onClick={e => { stop(e); if (vf.hasPanel) removeVP(vf.id); deleteVirtualFace(vf.id); }}
                      className="p-0.5 rounded text-stone-300 hover:text-red-400 transition-colors" title="Delete virtual face"><Trash2 size={12} /></button>
                  </div>
                </div>);
            })}
          </div>);
      })()}
    </div>
  ) : <div className="text-center text-stone-500 text-xs py-4">No shape selected</div>;

  const dimsSection = selectedShape && selectedPanelRow !== null && (() => {
    let dims: Dims | null = null, cpId: string | null = null;
    if (typeof selectedPanelRow === 'string' && selectedPanelRow.startsWith('vf-')) {
      const vp = findVPanel(shapes, selectedShape.id, selectedPanelRow.replace('vf-','')); cpId = vp?.id||null;
      if (vp?.geometry) dims = getDimsFromGeo(vp.geometry, vp.parameters?.faceRole, vp.parameters?.arrowRotated);
    }
    if (!dims) return null;
    const isExt = faceExtrudeMode && !!cpId, panel = cpId ? shapes.find(s => s.id === cpId) : null;
    const steps = panel?.parameters?.extrudeSteps || [], hf = faceExtrudeSelectedFace !== null;
    return (
      <div className="border-t border-orange-200 bg-orange-50 px-3 py-2 rounded-b-lg">
        <div className="flex items-center gap-2">
          {[['W',dims.primary],['H',dims.secondary],['T',dims.thickness]].map(([l,v],idx) => (
            <React.Fragment key={l as string}>{idx>0&&<div className="w-px h-4 bg-orange-200 shrink-0"/>}
              <div className="flex items-center gap-1.5"><span className="text-xs text-stone-400 font-medium uppercase tracking-wide">{l}</span>
                <span className="text-xs font-bold text-slate-800 font-mono">{v}</span></div></React.Fragment>))}
          {isExt && <>
            <div className="w-px h-4 bg-orange-200 shrink-0"/>
            <input type="text" inputMode="numeric" value={faceExtrudeThickness} onChange={e => setFaceExtrudeThickness(Number(e.target.value)||0)} disabled={!hf}
              className={`w-14 h-6 px-1 text-xs font-mono text-center border rounded focus:outline-none focus:border-orange-500 ${hf ? 'bg-white border-orange-300' : 'bg-orange-100 border-orange-200 text-orange-300 cursor-not-allowed'}`} />
            <div className={`flex rounded overflow-hidden border shrink-0 ${hf ? 'border-orange-300' : 'border-orange-200 opacity-40'}`}>
              {[true,false].map(f => <button key={String(f)} disabled={!hf} onClick={() => setFaceExtrudeFixedMode(f)}
                className={`px-1.5 h-6 text-xs font-semibold transition-colors ${!f?'border-l border-orange-300':''} ${faceExtrudeFixedMode===f?'bg-orange-500 text-white':'bg-white text-orange-600 hover:bg-orange-50'}`}>{f?'Fix':'Din'}</button>)}
            </div></>}
          <div className="ml-auto flex items-center gap-1">
            <button onClick={e => { stop(e); faceExtrudeMode ? setFaceExtrudeMode(false) : cpId && (setFaceExtrudeTargetPanelId(cpId), setFaceExtrudeMode(true)); }}
              className={`flex items-center justify-center w-6 h-6 rounded border transition-colors shrink-0 ${isExt ? 'border-orange-500 bg-orange-500 text-white shadow-sm' : 'border-orange-300 bg-white hover:bg-orange-100 text-orange-600'}`}
              title="Face Extrude"><MoveVertical size={12}/></button>
            {isExt && <button disabled={!hf} onClick={async () => {
              if (!hf||!cpId) return; const ps = shapes.find(s => s.id === cpId); if (!ps) return;
              const { executeFaceExtrude } = await import('./FaceExtrudeService');
              await executeFaceExtrude({ panelShape: ps, faceGroupIndex: faceExtrudeSelectedFace!, value: faceExtrudeThickness, isFixed: faceExtrudeFixedMode, shapes, updateShape });
              setFaceExtrudeSelectedFace(null);
            }} className={`flex items-center justify-center w-6 h-6 rounded border transition-colors shrink-0 ${hf ? 'border-green-400 bg-green-500 text-white hover:bg-green-600' : 'border-orange-200 bg-orange-100 text-orange-300 cursor-not-allowed'}`}
              title="Onayla"><Check size={12}/></button>}
          </div>
        </div>
        {steps.length > 0 && <div className="mt-1.5 border-t border-orange-200 pt-1.5 space-y-1">
          {steps.map((s: any) => <div key={s.id} className="flex items-center gap-1.5 group">
            <span className="text-xs font-bold text-orange-600 bg-orange-200 rounded px-1 py-0.5 font-mono min-w-[24px] text-center">{s.axisLabel}</span>
            {editingStepId === s.id ? <>
              <input type="text" inputMode="numeric" autoFocus value={editingStepValue} onChange={e => setEditingStepValue(Number(e.target.value)||0)}
                onKeyDown={e => { if (e.key==='Enter') saveStep(cpId,s.id,editingStepValue); else if (e.key==='Escape') setEditingStepId(null); }}
                className="w-14 h-5 px-1 text-xs font-mono text-center border border-orange-400 rounded bg-white focus:outline-none focus:border-orange-500"/>
              <span className="text-xs text-stone-400">{s.isFixed?'Fix':'Din'}</span>
              <button onClick={() => saveStep(cpId,s.id,editingStepValue)} className="flex items-center justify-center w-5 h-5 rounded border border-green-400 bg-green-500 text-white hover:bg-green-600 transition-colors" title="Kaydet"><Check size={10}/></button>
              <button onClick={() => setEditingStepId(null)} className="flex items-center justify-center w-5 h-5 rounded border border-stone-300 bg-white text-stone-500 hover:bg-stone-100 transition-colors" title="Iptal"><X size={10}/></button>
            </> : <>
              <span className="text-xs font-mono text-slate-700 font-semibold">{s.value}</span>
              <span className="text-xs text-stone-400">{s.isFixed?'Fix':'Din'}</span>
              <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onClick={() => { setEditingStepId(s.id); setEditingStepValue(s.value); }}
                  className="flex items-center justify-center w-5 h-5 rounded border border-orange-300 bg-white text-orange-500 hover:bg-orange-100 transition-colors" title="Duzenle"><Pencil size={9}/></button>
                <button onClick={async () => { if (!cpId) return; const ps = shapes.find(x => x.id === cpId); if (!ps) return; const { deleteExtrudeStep } = await import('./FaceExtrudeService'); await deleteExtrudeStep(ps, s.id, updateShape); }}
                  className="flex items-center justify-center w-5 h-5 rounded border border-red-300 bg-white text-red-500 hover:bg-red-50 transition-colors" title="Sil"><Trash2 size={9}/></button>
              </div></>}
          </div>)}
        </div>}
      </div>);
  })();

  if (embedded) return (
    <div className="flex flex-col h-full">
      <div className="px-2.5 py-1.5 border-b border-stone-100 flex items-center justify-between">
        {panelToolbar}
      </div>
      <div className="px-2.5 py-2 overflow-y-auto flex-1">{panelContent}</div>
      {dimsSection}
    </div>
  );

  return (
    <div className="fixed bg-white rounded-md shadow-lg border border-stone-200 z-50" style={{ left: `${position.x}px`, top: `${position.y}px`, width: '370px' }}>
      <div className="flex items-center justify-between px-2.5 py-1.5 bg-stone-50 border-b border-stone-200 rounded-t-md select-none" style={{ cursor: isDragging ? 'grabbing' : 'grab' }} onMouseDown={handleMouseDown}>
        <div className="flex items-center gap-1.5"><GripVertical size={12} className="text-stone-300"/><span className="text-xs font-semibold text-stone-600 tracking-wide uppercase">Parameters</span></div>
        <div className="flex items-center gap-1">{panelToolbar}<button onClick={onClose} className="p-0.5 hover:bg-stone-200 rounded transition-colors"><X size={12} className="text-stone-400"/></button></div>
      </div>
      <div className="px-2.5 py-2 max-h-[calc(100vh-200px)] overflow-y-auto">{panelContent}</div>
      {dimsSection}
    </div>);
}
