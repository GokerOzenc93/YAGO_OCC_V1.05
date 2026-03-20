import React, { useState } from 'react';
import * as THREE from 'three';
import { Tool, useAppStore, ModificationType, CameraType, SnapType, ViewMode, OrthoMode } from '../store';
import { MousePointer2, Move, RotateCcw, Maximize, FileDown, Upload, Save, FilePlus, Undo2, Redo2, Grid2x2 as Grid, Layers, Box, Cylinder, Settings, HelpCircle, Search, Copy, Scissors, ClipboardPaste, Square, Circle, FlipHorizontal, Copy as Copy1, Eraser, Eye, Monitor, Package, CreditCard as Edit, BarChart3, Cog, FileText, PanelLeft, GitBranch, CreditCard as Edit3, Camera, CameraOff, Target, Navigation, Crosshair, RotateCw, Zap, InspectionPanel as Intersection, MapPin, Frame as Wireframe, Cuboid as Cube, Ruler, FolderOpen, ArrowDownUp, Divide, DivideCircle, Scan } from 'lucide-react';
import { ParametersPanel } from './ParametersPanel';
import { PanelEditor } from './PanelEditor';
import { GlobalSettingsPanel } from './GlobalSettingsPanel';
import { createReplicadBox, convertReplicadToThreeGeometry, performBooleanCut } from './ReplicadService';

interface ToolbarProps { onOpenCatalog: () => void; }

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@500;600;700&display=swap');
  .tb-root *, .tb-root *::before, .tb-root *::after { box-sizing: border-box; }
  .tb-root {
    font-family: 'Syne', sans-serif;
    --bg: #0f0f10; --surf: #17171a; --brd: rgba(255,255,255,0.07);
    --brd2: rgba(255,255,255,0.13); --txt: #e8e8ea; --muted: #5a5a62;
    --acc: #e8622a; --acc-dim: rgba(232,98,42,0.13); --acc-glow: rgba(232,98,42,0.3);
    --red: #e04040; --red-dim: rgba(224,64,64,0.13);
    background: var(--bg);
  }

  /* HEADER */
  .tb-hdr { display:flex; align-items:center; height:48px; padding:0 16px; background:var(--bg); border-bottom:1px solid var(--brd); }
  .tb-logo { height:26px; filter:brightness(1.15); opacity:.92; }
  .tb-vsep { width:1px; height:20px; background:var(--brd); margin:0 14px; flex-shrink:0; }
  .tb-label { font-size:10px; font-weight:600; letter-spacing:.09em; text-transform:uppercase; color:var(--muted); }
  .tb-val { font-size:12px; font-weight:700; letter-spacing:.02em; color:var(--txt); margin-left:6px; }
  .tb-val.a { color:var(--acc); }
  .tb-hdr-r { margin-left:auto; display:flex; align-items:center; gap:5px; }

  /* PILLS */
  .tb-pill {
    display:flex; align-items:center; gap:5px; padding:5px 10px;
    border-radius:6px; border:1px solid var(--brd); background:var(--surf);
    color:var(--muted); font-size:10px; font-weight:700; letter-spacing:.07em;
    cursor:pointer; transition:all .18s ease; font-family:'Syne',sans-serif;
  }
  .tb-pill:hover { border-color:var(--brd2); color:var(--txt); background:#1e1e22; }
  .tb-pill:hover svg { transform:scale(1.15); }
  .tb-pill svg { transition:transform .2s cubic-bezier(.34,1.56,.64,1); }
  .tb-pill.on { background:var(--acc-dim); border-color:var(--acc); color:var(--acc); }
  .tb-pill.cat { background:var(--acc); border-color:var(--acc); color:#fff; }
  .tb-pill.cat:hover { background:#d4581f; }
  .tb-dot { width:5px; height:5px; border-radius:50%; background:var(--acc); box-shadow:0 0 6px var(--acc); animation:dpulse 2s ease infinite; }
  @keyframes dpulse { 0%,100%{opacity:1} 50%{opacity:.35} }

  .tb-search-w { position:relative; }
  .tb-search-w svg { position:absolute; left:9px; top:50%; transform:translateY(-50%); color:var(--muted); pointer-events:none; }
  .tb-search { width:140px; height:30px; padding:0 10px 0 30px; background:var(--surf); border:1px solid var(--brd); border-radius:6px; color:var(--txt); font-size:11px; font-family:'DM Mono',monospace; outline:none; transition:border-color .18s, width .25s ease; }
  .tb-search::placeholder { color:var(--muted); }
  .tb-search:focus { border-color:var(--acc); width:170px; }
  .tb-icon-b { width:30px; height:30px; border-radius:6px; border:1px solid transparent; background:transparent; color:var(--muted); display:flex; align-items:center; justify-content:center; cursor:pointer; transition:all .18s ease; }
  .tb-icon-b:hover { background:var(--surf); border-color:var(--brd); color:var(--txt); }
  .tb-icon-b:hover svg { transform:scale(1.15) rotate(15deg); }
  .tb-icon-b svg { transition:transform .2s cubic-bezier(.34,1.56,.64,1); }

  /* MENU BAR */
  .tb-mbar { display:flex; align-items:center; height:30px; padding:0 6px; background:var(--bg); border-bottom:1px solid var(--brd); }
  .tb-mitem { position:relative; height:100%; }
  .tb-mbtn { height:100%; padding:0 11px; background:transparent; border:none; color:var(--muted); font-size:10.5px; font-weight:700; letter-spacing:.07em; cursor:pointer; transition:color .15s, background .15s; font-family:'Syne',sans-serif; display:flex; align-items:center; }
  .tb-mbtn:hover, .tb-mbtn.open { color:var(--txt); background:var(--surf); }
  .tb-drop { position:absolute; left:0; top:100%; margin-top:4px; width:196px; background:#18181b; border:1px solid var(--brd); border-radius:8px; padding:4px; z-index:200; box-shadow:0 20px 60px rgba(0,0,0,.7),0 0 0 1px rgba(255,255,255,.03); animation:din .14s ease; }
  @keyframes din { from{opacity:0;transform:translateY(-5px) scale(.97)} to{opacity:1;transform:translateY(0) scale(1)} }
  .tb-dsep { height:1px; background:var(--brd); margin:3px 0; }
  .tb-ditem { display:flex; align-items:center; justify-content:space-between; width:100%; height:29px; padding:0 9px; border-radius:5px; background:transparent; border:none; color:var(--muted); font-size:10.5px; font-weight:600; cursor:pointer; transition:background .12s, color .12s; font-family:'Syne',sans-serif; }
  .tb-ditem:hover { background:rgba(255,255,255,.05); color:var(--txt); }
  .tb-ditem-l { display:flex; align-items:center; gap:8px; }
  .tb-dshort { font-family:'DM Mono',monospace; font-size:9.5px; color:var(--muted); opacity:.65; }

  /* TOOL STRIP */
  .tb-strip { display:flex; align-items:center; height:44px; padding:0 12px; gap:3px; background:var(--bg); border-bottom:1px solid var(--brd); }
  .tb-ssep { width:1px; height:22px; background:var(--brd); margin:0 3px; flex-shrink:0; }
  .tb-grp { display:flex; align-items:center; background:var(--surf); border:1px solid var(--brd); border-radius:8px; overflow:hidden; }
  .tb-gsep { width:1px; height:20px; background:var(--brd); flex-shrink:0; }

  /* TOOL BUTTONS */
  .tb-btn {
    position:relative; display:flex; align-items:center; justify-content:center;
    width:36px; height:34px; background:transparent; border:none;
    color:var(--muted); cursor:pointer; overflow:hidden;
    transition:color .15s, background .15s;
  }
  .tb-btn svg { transition:transform .22s cubic-bezier(.34,1.56,.64,1), color .15s; }
  .tb-btn:hover { color:var(--txt); background:rgba(255,255,255,.055); }
  .tb-btn:hover svg { transform:scale(1.18); }
  .tb-btn.act { color:var(--acc); background:var(--acc-dim); }
  .tb-btn.act::after { content:''; position:absolute; bottom:0; left:50%; transform:translateX(-50%); width:14px; height:2px; background:var(--acc); border-radius:1px 1px 0 0; box-shadow:0 0 8px var(--acc-glow); }
  .tb-btn.act svg { transform:scale(1.05); }
  .tb-btn.dng { color:var(--red); background:var(--red-dim); }
  .tb-btn.dng:hover svg { transform:scale(1.2) rotate(-12deg); }
  .tb-btn.off { opacity:.25; cursor:not-allowed; pointer-events:none; }
  .tb-btn:active:not(.off) svg { transform:scale(.88) !important; }

  /* per-icon hover animations */
  .tb-btn:hover .i-move { animation:ib 0.4s ease; }
  .tb-btn:hover .i-rot  { animation:ir 0.5s ease; }
  .tb-btn:hover .i-undo { animation:iu 0.4s ease; }
  .tb-btn:hover .i-redo { animation:ire 0.4s ease; }
  .tb-btn:hover .i-save { animation:ip 0.35s ease; }
  .tb-btn:hover .i-box  { animation:ibox 0.38s ease; }
  .tb-btn:hover .i-cog  { animation:icog 0.55s ease; }
  .tb-btn:hover .i-div  { animation:ish 0.4s ease; }
  .tb-btn:hover .i-ptr  { animation:iptr 0.35s ease; }
  @keyframes ib   { 0%,100%{transform:translateY(0) scale(1.18)} 50%{transform:translateY(-3px) scale(1.22)} }
  @keyframes ir   { from{transform:rotate(0) scale(1.18)} to{transform:rotate(180deg) scale(1.18)} }
  @keyframes iu   { 0%,100%{transform:rotate(0) scale(1.18)} 45%{transform:rotate(-35deg) scale(1.22)} }
  @keyframes ire  { 0%,100%{transform:rotate(0) scale(1.18)} 45%{transform:rotate(35deg) scale(1.22)} }
  @keyframes ip   { 0%,100%{transform:scale(1.18)} 50%{transform:scale(1.3)} }
  @keyframes ibox { 0%{transform:scale(1.18)} 40%{transform:scale(1.32) translateY(-2px)} 100%{transform:scale(1.18)} }
  @keyframes icog { from{transform:rotate(0) scale(1.18)} to{transform:rotate(90deg) scale(1.18)} }
  @keyframes ish  { 0%,100%{transform:translateX(0) scale(1.18)} 25%{transform:translateX(-3px) scale(1.18)} 75%{transform:translateX(3px) scale(1.18)} }
  @keyframes iptr { 0%,100%{transform:scale(1.18)} 50%{transform:scale(1.25) translateX(2px) translateY(-2px)} }

  /* TOOLTIP */
  .tb-wrap { position:relative; }
  .tb-tip { position:absolute; bottom:calc(100% + 7px); left:50%; transform:translateX(-50%); background:#222226; border:1px solid var(--brd); color:var(--txt); font-size:10px; font-weight:600; padding:4px 8px; border-radius:5px; white-space:nowrap; pointer-events:none; opacity:0; transition:opacity .15s; font-family:'Syne',sans-serif; letter-spacing:.04em; box-shadow:0 6px 16px rgba(0,0,0,.5); z-index:300; }
  .tb-wrap:hover .tb-tip { opacity:1; }
`;

const Toolbar: React.FC<ToolbarProps> = ({ onOpenCatalog }) => {
  const {
    setActiveTool, activeTool, setLastTransformTool, addShape, selectedShapeId,
    modifyShape, cameraType, setCameraType, snapSettings, toggleSnapSetting,
    viewMode, setViewMode, cycleViewMode, orthoMode, toggleOrthoMode,
    opencascadeInstance, extrudeShape, shapes, updateShape, deleteShape,
    showParametersPanel, setShowParametersPanel, showGlobalSettingsPanel,
    setShowGlobalSettingsPanel, panelSelectMode, panelSurfaceSelectMode, setPanelSurfaceSelectMode,
  } = useAppStore();

  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [showModifyMenu, setShowModifyMenu] = useState(false);
  const [showPolylineMenu, setShowPolylineMenu] = useState(false);
  const [polylineMenuPosition, setPolylineMenuPosition] = useState({ x: 0, y: 0 });
  const [showPanelEditor, setShowPanelEditor] = useState(false);

  const hasIntersectingShapes = React.useMemo(() => {
    if (!selectedShapeId) return false;
    const selectedShape = shapes.find((s) => s.id === selectedShapeId);
    if (!selectedShape?.geometry) return false;
    if (selectedShape.type === 'panel') return false;
    try {
      const selectedBox = new THREE.Box3().setFromBufferAttribute(selectedShape.geometry.getAttribute('position'));
      const sMin = selectedBox.min.clone().add(new THREE.Vector3(...selectedShape.position));
      const sMax = selectedBox.max.clone().add(new THREE.Vector3(...selectedShape.position));
      selectedBox.set(sMin, sMax);
      return shapes.some((s) => {
        if (s.id === selectedShapeId || !s.geometry) return false;
        if (s.type === 'panel') return false;
        try {
          const b = new THREE.Box3().setFromBufferAttribute(s.geometry.getAttribute('position'));
          b.set(b.min.clone().add(new THREE.Vector3(...s.position)), b.max.clone().add(new THREE.Vector3(...s.position)));
          return selectedBox.intersectsBox(b);
        } catch { return false; }
      });
    } catch { return false; }
  }, [selectedShapeId, shapes]);

  const vmLabel = () => ({ [ViewMode.SOLID]: 'SOLID', [ViewMode.WIREFRAME]: 'WIRE', [ViewMode.XRAY]: 'X-RAY' }[viewMode] ?? 'SOLID');
  const vmIcon = () => { const s = 11; if (viewMode === ViewMode.WIREFRAME) return <Wireframe size={s} />; if (viewMode === ViewMode.XRAY) return <Eye size={s} />; return <Cube size={s} />; };

  const handleTransformToolSelect = (tool: Tool) => { setActiveTool(tool); setLastTransformTool(tool); };
  const handleModify = (type: ModificationType) => {
    if (!selectedShapeId) return;
    const configs: Record<string, object> = { [ModificationType.MIRROR]: { type, mirror: { axis: 'x', distance: 1000 } }, [ModificationType.ARRAY]: { type, array: { count: 3, spacing: 750, direction: 'x' } }, [ModificationType.FILLET]: { type, fillet: { radius: 50 } }, [ModificationType.CHAMFER]: { type, chamfer: { distance: 50 } } };
    if (configs[type]) modifyShape(selectedShapeId, configs[type] as any);
    setShowModifyMenu(false);
  };
  const handleCameraToggle = () => setCameraType(cameraType === CameraType.PERSPECTIVE ? CameraType.ORTHOGRAPHIC : CameraType.PERSPECTIVE);

  React.useEffect(() => {
    const h = () => setShowPolylineMenu(false);
    if (showPolylineMenu) { document.addEventListener('click', h); return () => document.removeEventListener('click', h); }
  }, [showPolylineMenu]);
  React.useEffect(() => { if (panelSelectMode && activeTool !== Tool.SELECT) setActiveTool(Tool.SELECT); }, [panelSelectMode, activeTool, setActiveTool]);

  const selectedShape = shapes.find((s) => s.id === selectedShapeId);
  const isBoxSelected = selectedShape?.type === 'box';

  const handleAddBox = async (e?: React.MouseEvent) => {
    e?.preventDefault(); e?.stopPropagation();
    try {
      const w = 600, h = 600, d = 600;
      const rs = await createReplicadBox({ width: w, height: h, depth: d });
      addShape({ id: `box-${Date.now()}`, type: 'box', geometry: convertReplicadToThreeGeometry(rs), replicadShape: rs, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: '#2563eb', parameters: { width: w, height: h, depth: d } });
    } catch (e) { alert(`Failed to add box: ${(e as Error).message}`); }
  };

  const handleSubtract = async () => {
    if (!selectedShapeId || !hasIntersectingShapes) return;
    try {
      const sel = shapes.find((s) => s.id === selectedShapeId);
      if (!sel?.geometry || !sel.replicadShape) return;
      const selBox = new THREE.Box3().setFromBufferAttribute(sel.geometry.getAttribute('position'));
      selBox.set(selBox.min.clone().add(new THREE.Vector3(...sel.position)), selBox.max.clone().add(new THREE.Vector3(...sel.position)));
      const intersecting = shapes.filter((s) => {
        if (s.id === selectedShapeId || !s.geometry) return false;
        const b = new THREE.Box3().setFromBufferAttribute(s.geometry.getAttribute('position'));
        b.set(b.min.clone().add(new THREE.Vector3(...s.position)), b.max.clone().add(new THREE.Vector3(...s.position)));
        return selBox.intersectsBox(b);
      });
      if (!intersecting.length) return;
      const { getReplicadVertices } = await import('./VertexEditorService');
      for (const target of intersecting) {
        if (!target.replicadShape) continue;
        const relOff = sel.position.map((v, i) => v - target.position[i]) as [number, number, number];
        const relRot = sel.rotation.map((v, i) => v - target.rotation[i]) as [number, number, number];
        const result = await performBooleanCut(target.replicadShape, sel.replicadShape, undefined, relOff, undefined, relRot, undefined, sel.scale);
        const newGeo = convertReplicadToThreeGeometry(result);
        const newVerts = await getReplicadVertices(result);
        updateShape(target.id, { geometry: newGeo, replicadShape: result, subtractionGeometries: [...(target.subtractionGeometries || []), { geometry: sel.geometry.clone(), relativeOffset: relOff, relativeRotation: relRot, scale: [1, 1, 1] }], parameters: { ...target.parameters, scaledBaseVertices: newVerts.map((v) => [v.x, v.y, v.z]) } });
      }
      deleteShape(selectedShapeId);
    } catch (e) { alert(`Failed to subtract: ${(e as Error).message}`); }
  };

  const transformTools = [
    { id: Tool.SELECT,              icon: <MousePointer2 size={15} className="i-ptr"  />, label: 'Select',         shortcut: 'V'   },
    { id: Tool.MOVE,                icon: <Move          size={15} className="i-move" />, label: 'Move',           shortcut: 'M'   },
    { id: Tool.POINT_TO_POINT_MOVE, icon: <ArrowDownUp   size={15}                   />, label: 'Point to Point', shortcut: 'P2P' },
    { id: Tool.ROTATE,              icon: <RotateCcw     size={15} className="i-rot"  />, label: 'Rotate',         shortcut: 'Ro'  },
    { id: Tool.SCALE,               icon: <Maximize      size={15}                   />, label: 'Scale',           shortcut: 'S', disabledForBox: true },
  ];

  const menus = [
    { label: 'File',     items: [{ icon: <FilePlus size={11}/>, label:'New Project', shortcut:'Ctrl+N' }, { icon:<Upload size={11}/>, label:'Open Project...', shortcut:'Ctrl+O' }, { type:'separator' }, { icon:<Save size={11}/>, label:'Save', shortcut:'Ctrl+S' }, { icon:<FileDown size={11}/>, label:'Save As...', shortcut:'Ctrl+Shift+S' }, { type:'separator' }, { icon:<Upload size={11}/>, label:'Import...', shortcut:'Ctrl+I' }, { icon:<FileDown size={11}/>, label:'Export...', shortcut:'Ctrl+E' }] },
    { label: 'Edit',     items: [{ icon:<Undo2 size={11}/>, label:'Undo', shortcut:'Ctrl+Z' }, { icon:<Redo2 size={11}/>, label:'Redo', shortcut:'Ctrl+Y' }, { type:'separator' }, { icon:<Scissors size={11}/>, label:'Cut', shortcut:'Ctrl+X' }, { icon:<Copy size={11}/>, label:'Copy', shortcut:'Ctrl+C' }, { icon:<ClipboardPaste size={11}/>, label:'Paste', shortcut:'Ctrl+V' }, { type:'separator' }, { icon:<Eraser size={11}/>, label:'Delete', shortcut:'Del' }] },
    { label: 'View',     items: [{ icon:<Grid size={11}/>, label:'Show Grid', shortcut:'G' }, { icon:<Layers size={11}/>, label:'Show Layers', shortcut:'L' }, { icon:<Eye size={11}/>, label:'Visibility', shortcut:'V' }, { type:'separator' }, { icon:<Cube size={11}/>, label:'Solid View', shortcut:'1' }, { icon:<Wireframe size={11}/>, label:'Wireframe View', shortcut:'2' }, { icon:<Eye size={11}/>, label:'X-Ray View', shortcut:'3' }, { type:'separator' }, { label:'Zoom In', shortcut:'Ctrl++' }, { label:'Zoom Out', shortcut:'Ctrl+-' }, { label:'Fit to View', shortcut:'F' }] },
    { label: 'Place',    items: [{ icon:<Box size={11}/>, label:'Add Box', shortcut:'B' }, { icon:<Cylinder size={11}/>, label:'Add Cylinder', shortcut:'C' }, { icon:<Package size={11}/>, label:'3D Objects', shortcut:'3' }, { type:'separator' }, { icon:<Square size={11}/>, label:'2D Shapes', shortcut:'2' }, { icon:<GitBranch size={11}/>, label:'Drawing Tools', shortcut:'L' }] },
    { label: 'Modify',   items: [{ icon:<Move size={11}/>, label:'Move', shortcut:'M' }, { icon:<RotateCcw size={11}/>, label:'Rotate', shortcut:'R' }, { icon:<Maximize size={11}/>, label:'Scale', shortcut:'S' }, { type:'separator' }, { icon:<FlipHorizontal size={11}/>, label:'Mirror', shortcut:'Mi' }, { icon:<Copy1 size={11}/>, label:'Array', shortcut:'Ar' }, { icon:<Edit size={11}/>, label:'Edit', shortcut:'E' }] },
    { label: 'Snap',     items: [{ icon:<Target size={11}/>, label:'Endpoint Snap', shortcut:'End' }, { icon:<Navigation size={11}/>, label:'Midpoint Snap', shortcut:'Mid' }, { icon:<Crosshair size={11}/>, label:'Center Snap', shortcut:'Cen' }, { icon:<RotateCw size={11}/>, label:'Quadrant Snap', shortcut:'Qua' }, { icon:<Zap size={11}/>, label:'Perpendicular Snap', shortcut:'Per' }, { icon:<Intersection size={11}/>, label:'Intersection Snap', shortcut:'Int' }, { icon:<MapPin size={11}/>, label:'Nearest Snap', shortcut:'Nea' }, { type:'separator' }, { icon:<Settings size={11}/>, label:'Snap Settings', shortcut:'Ctrl+Snap' }] },
    { label: 'Measure',  items: [{ icon:<Layers size={11}/>, label:'Distance', shortcut:'D' }, { icon:<Layers size={11}/>, label:'Angle', shortcut:'A' }, { icon:<Layers size={11}/>, label:'Area', shortcut:'Ar' }, { type:'separator' }, { icon:<Layers size={11}/>, label:'Add Dimension', shortcut:'Ctrl+D' }, { icon:<Layers size={11}/>, label:'Dimension Style', shortcut:'Ctrl+M' }] },
    { label: 'Display',  items: [{ icon:<Monitor size={11}/>, label:'Render Settings', shortcut:'R' }, { icon:<Eye size={11}/>, label:'View Modes', shortcut:'V' }, { icon:<Layers size={11}/>, label:'Camera Settings', shortcut:'C' }, { type:'separator' }, { icon:<Layers size={11}/>, label:'Material Editor', shortcut:'M' }, { icon:<Settings size={11}/>, label:'Lighting', shortcut:'L' }] },
    { label: 'Settings', items: [{ icon:<Cog size={11}/>, label:'General Settings', shortcut:'Ctrl+,' }, { icon:<Grid size={11}/>, label:'Grid Settings', shortcut:'G' }, { icon:<Layers size={11}/>, label:'Unit Settings', shortcut:'U' }, { type:'separator' }, { icon:<Settings size={11}/>, label:'Toolbar', shortcut:'T' }, { icon:<PanelLeft size={11}/>, label:'Panel Layout', shortcut:'P' }] },
    { label: 'Report',   items: [{ icon:<FileText size={11}/>, label:'Project Report', shortcut:'Ctrl+R' }, { icon:<BarChart3 size={11}/>, label:'Material List', shortcut:'Ctrl+L' }, { icon:<FileText size={11}/>, label:'Dimension Report', shortcut:'Ctrl+M' }, { type:'separator' }, { icon:<FileDown size={11}/>, label:'PDF Export', shortcut:'Ctrl+P' }, { icon:<FileDown size={11}/>, label:'Excel Export', shortcut:'Ctrl+E' }] },
    { label: 'Window',   items: [{ icon:<PanelLeft size={11}/>, label:'New Window', shortcut:'Ctrl+N' }, { icon:<Layers size={11}/>, label:'Window Layout', shortcut:'Ctrl+W' }, { type:'separator' }, { icon:<Monitor size={11}/>, label:'Full Screen', shortcut:'F11' }, { icon:<PanelLeft size={11}/>, label:'Hide Panels', shortcut:'Tab' }] },
    { label: 'Help',     items: [{ icon:<HelpCircle size={11}/>, label:'User Manual', shortcut:'F1' }, { icon:<HelpCircle size={11}/>, label:'Keyboard Shortcuts', shortcut:'Ctrl+?' }, { icon:<Layers size={11}/>, label:'Video Tutorials', shortcut:'Ctrl+T' }, { type:'separator' }, { icon:<HelpCircle size={11}/>, label:'About', shortcut:'Ctrl+H' }, { icon:<HelpCircle size={11}/>, label:'Check Updates', shortcut:'Ctrl+U' }] },
  ];

  // Reusable tool button with tooltip
  const TBtn = ({ icon, label, active = false, danger = false, disabled = false, onClick }: { icon: React.ReactNode; label: string; active?: boolean; danger?: boolean; disabled?: boolean; onClick?: () => void }) => (
    <div className="tb-wrap">
      <button className={`tb-btn${active ? ' act' : ''}${danger ? ' dng' : ''}${disabled ? ' off' : ''}`} onClick={onClick}>{icon}</button>
      <span className="tb-tip">{label}</span>
    </div>
  );

  return (
    <div className="tb-root">
      <style>{CSS}</style>

      {/* HEADER */}
      <div className="tb-hdr">
        <img src="/yago_logo.png" alt="YAGO" className="tb-logo" />
        <div className="tb-vsep" />
        <span className="tb-label">Co.</span><span className="tb-val a">Göker İnşaat</span>
        <div className="tb-vsep" />
        <span className="tb-label">Prj.</span><span className="tb-val">Drawing1</span>
        <div className="tb-hdr-r">
          <button className={`tb-pill${cameraType === CameraType.ORTHOGRAPHIC ? ' on' : ''}`} onClick={handleCameraToggle}>
            {cameraType === CameraType.PERSPECTIVE ? <Camera size={11} /> : <CameraOff size={11} />}
            {cameraType === CameraType.PERSPECTIVE ? 'PERSP' : 'ORTHO'}
          </button>
          <button className="tb-pill" onClick={() => useAppStore.getState().cycleViewMode()}>{vmIcon()}{vmLabel()}</button>
          <button className={`tb-pill${orthoMode === OrthoMode.ON ? ' on' : ''}`} onClick={() => toggleOrthoMode()}>
            {orthoMode === OrthoMode.ON && <span className="tb-dot" />}
            <Grid size={11} />LINEAR
          </button>
          <div className="tb-vsep" />
          <button className="tb-pill cat" onClick={onOpenCatalog}><FolderOpen size={11} />CATALOG</button>
          <div className="tb-search-w">
            <Search size={12} />
            <input type="text" placeholder="Search…" className="tb-search" />
          </div>
          <button className="tb-icon-b" title="Settings"><Settings size={14} /></button>
          <button className="tb-icon-b" title="Help"><HelpCircle size={14} /></button>
        </div>
      </div>

      {/* MENU BAR */}
      <div className="tb-mbar">
        {menus.map((menu) => (
          <div key={menu.label} className="tb-mitem">
            <button className={`tb-mbtn${activeMenu === menu.label ? ' open' : ''}`} onClick={() => setActiveMenu(activeMenu === menu.label ? null : menu.label)} onMouseEnter={() => activeMenu && setActiveMenu(menu.label)}>
              {menu.label}
            </button>
            {activeMenu === menu.label && (
              <div className="tb-drop" onMouseLeave={() => setActiveMenu(null)}>
                {menu.items.map((item, i) =>
                  item.type === 'separator' ? <div key={i} className="tb-dsep" /> : (
                    <button key={i} className="tb-ditem" onClick={() => { if (item.label === 'Solid View') setViewMode(ViewMode.SOLID); else if (item.label === 'Wireframe View') setViewMode(ViewMode.WIREFRAME); else if (item.label === 'X-Ray View') setViewMode(ViewMode.XRAY); setActiveMenu(null); }}>
                      <div className="tb-ditem-l">{item.icon}<span>{item.label}</span></div>
                      {item.shortcut && <span className="tb-dshort">{item.shortcut}</span>}
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* TOOL STRIP */}
      <div className="tb-strip">
        <div className="tb-grp">
          <TBtn icon={<FilePlus size={15} className="i-save" />} label="New (Ctrl+N)" />
          <TBtn icon={<Save size={15} className="i-save" />} label="Save (Ctrl+S)" />
          <TBtn icon={<FileDown size={15} />} label="Save As (Ctrl+Shift+S)" />
          <div className="tb-gsep" />
          <TBtn icon={<Undo2 size={15} className="i-undo" />} label="Undo (Ctrl+Z)" />
          <TBtn icon={<Redo2 size={15} className="i-redo" />} label="Redo (Ctrl+Y)" />
        </div>

        <div className="tb-ssep" />

        <div className="tb-grp">
          {transformTools.map((tool) => {
            const dis = (tool.id !== Tool.SELECT && !selectedShapeId) || (tool.disabledForBox && isBoxSelected);
            return (
              <TBtn key={tool.id} icon={tool.icon} label={`${tool.label} (${tool.shortcut})`} active={activeTool === tool.id} disabled={!!dis}
                onClick={() => tool.id === Tool.SELECT ? setActiveTool(tool.id) : !dis && handleTransformToolSelect(tool.id)} />
            );
          })}
        </div>

        <div className="tb-ssep" />

        <div className="tb-grp">
          <TBtn icon={<Box size={15} className="i-box" />} label="Add Box (B)" onClick={handleAddBox} />
          <TBtn icon={<Cog size={15} className="i-cog" />} label="Global Settings" onClick={() => setShowGlobalSettingsPanel(!showGlobalSettingsPanel)} />
          <TBtn icon={<Settings size={15} />} label={selectedShapeId ? 'Parameters' : 'Select a shape first'} disabled={!selectedShapeId} onClick={() => selectedShapeId && setShowParametersPanel(!showParametersPanel)} />
          <TBtn icon={<DivideCircle size={15} className="i-div" />} label={hasIntersectingShapes ? 'Subtract Intersecting Shapes' : selectedShapeId ? 'No intersecting shapes' : 'Select a shape first'} danger={hasIntersectingShapes} disabled={!selectedShapeId} onClick={handleSubtract} />
          <TBtn icon={<PanelLeft size={15} />} label="Panel Editor" onClick={() => setShowPanelEditor(!showPanelEditor)} />
        </div>
      </div>

      {showPolylineMenu && (
        <div style={{ position:'fixed', left:polylineMenuPosition.x, top:polylineMenuPosition.y, background:'#18181b', border:'1px solid rgba(255,255,255,.07)', borderRadius:8, padding:4, zIndex:300, boxShadow:'0 20px 60px rgba(0,0,0,.7)' }}>
          <button className="tb-ditem" onClick={() => { setActiveTool(Tool.POLYLINE_EDIT); setShowPolylineMenu(false); }}><div className="tb-ditem-l"><Edit3 size={12} /><span>Edit Polyline</span></div></button>
          <button className="tb-ditem" onClick={() => { setActiveTool(Tool.POLYLINE); setShowPolylineMenu(false); }}><div className="tb-ditem-l"><GitBranch size={12} /><span>Draw Polyline</span></div></button>
        </div>
      )}

      <ParametersPanel isOpen={showParametersPanel} onClose={() => setShowParametersPanel(false)} />
      <PanelEditor isOpen={showPanelEditor} onClose={() => setShowPanelEditor(false)} />
      <GlobalSettingsPanel isOpen={showGlobalSettingsPanel} onClose={() => setShowGlobalSettingsPanel(false)} />
    </div>
  );
};

export default Toolbar;
