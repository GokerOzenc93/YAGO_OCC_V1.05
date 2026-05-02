import React, { useState } from 'react';
import * as THREE from 'three';
import { Tool, useAppStore, ModificationType, CameraType, SnapType, ViewMode, OrthoMode } from '../store';
import {
  // Header / meta
  Search, Settings, HelpCircle,
  // File ops
  FilePlus, FileDown, Save, Upload,
  // Edit ops
  Undo2, Redo2, Scissors, Copy, ClipboardPaste, Eraser,
  // Transform tools
  MousePointer2, Move, Navigation, RefreshCcw, Maximize2,
  // Geometry tools
  Box, Cog, SlidersHorizontal, MinusSquare, PanelLeft,
  // Camera / view
  Camera, CameraOff, Crosshair, FolderOpen,
  // View mode icons
  BoxSelect, ScanEye, Cuboid as Cube,
  // Menu-only icons (unchanged)
  Grid2x2 as Grid, Layers, Eye, Cylinder, Package, Square, FlipHorizontal,
  Maximize, Maximize2 as Area, BarChart3, FileText,
  GitBranch, Target, RotateCw, Zap,
  InspectionPanel as Intersection, MapPin, Ruler, Monitor,
  RotateCcw, ArrowDownUp,
} from 'lucide-react';
import { createReplicadBox, convertReplicadToThreeGeometry, performBooleanCut } from './ReplicadService';
import AddBoxIcon from './AddBoxIcon';

interface ToolbarProps { onOpenCatalog: () => void; }

/* ─── Reusable animated button ─── */
const TBtn = ({
  icon, label, active = false, disabled = false, danger = false,
  accent = false, onClick, className = ''
}: {
  icon: React.ReactNode; label: string; active?: boolean; disabled?: boolean;
  danger?: boolean; accent?: boolean; onClick?: () => void; className?: string;
}) => (
  <button
    title={label}
    disabled={disabled}
    onClick={onClick}
    className={[
      // ↓ 28px → 22px  (~2 mm küçüldü)
      'relative flex items-center justify-center w-[22px] h-[22px] rounded-md transition-all duration-150 group',
      'outline-none focus-visible:ring-2 focus-visible:ring-orange-200',
      disabled
        ? 'opacity-30 cursor-not-allowed text-stone-400'
        : danger
          ? 'text-red-400 hover:bg-red-50 hover:text-red-500 active:scale-90'
          : active
            // ↓ koyu turuncu → çok soft, beyaza yakın turuncu
            ? 'bg-orange-50 text-orange-400 shadow-sm ring-1 ring-orange-200'
            : accent
              ? 'bg-orange-50 text-orange-400 hover:bg-orange-100 shadow-sm active:scale-90'
              : 'text-stone-400 hover:bg-stone-100 hover:text-stone-700 active:scale-90',
      className
    ].join(' ')}
  >
    {/* ↓ icon wrapper: tam doldur, taşma yok */}
    <span className={[
      'flex items-center justify-center w-full h-full transition-transform duration-150',
      !disabled && !active ? 'group-hover:scale-110' : ''
    ].join(' ')}>
      {icon}
    </span>

    {/* Tooltip */}
    <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 top-full mt-2 px-2 py-1 rounded-md bg-stone-800 text-white text-[10px] font-medium whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-100 z-50 shadow-lg">
      {label}
    </span>
  </button>
);

/* ─── Pill toggle button ─── */
const PillBtn = ({
  icon, label, active = false, onClick
}: {
  icon: React.ReactNode; label: string; active?: boolean; onClick?: () => void;
}) => (
  <button
    title={label}
    onClick={onClick}
    className={[
      'group relative flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs font-semibold',
      'transition-all duration-150 active:scale-95 outline-none focus-visible:ring-2 focus-visible:ring-orange-200',
      active
        ? 'bg-stone-800 text-white shadow-md'
        : 'bg-stone-100 text-stone-600 hover:bg-stone-200 hover:text-stone-800'
    ].join(' ')}
  >
    <span className="transition-transform duration-150 group-hover:scale-110">{icon}</span>
    <span>{label}</span>
  </button>
);

/* ─── Divider ─── */
const Sep = () => <div className="w-px h-5 bg-stone-200 mx-0.5 flex-shrink-0" />;

const Toolbar: React.FC<ToolbarProps> = ({ onOpenCatalog }) => {
  const {
    setActiveTool, activeTool, setLastTransformTool, addShape, selectedShapeId,
    modifyShape, cameraType, setCameraType, snapSettings, toggleSnapSetting,
    viewMode, setViewMode, cycleViewMode, orthoMode, toggleOrthoMode,
    opencascadeInstance, extrudeShape, shapes, updateShape, deleteShape,
    panelSelectMode, panelSurfaceSelectMode, setPanelSurfaceSelectMode,
  } = useAppStore();

  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [showModifyMenu, setShowModifyMenu] = useState(false);
  const [showPolylineMenu, setShowPolylineMenu] = useState(false);
  const [polylineMenuPosition, setPolylineMenuPosition] = useState({ x: 0, y: 0 });

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

  const viewModeLabel = { [ViewMode.SOLID]: 'Solid', [ViewMode.WIREFRAME]: 'Wire', [ViewMode.XRAY]: 'X-Ray' }[viewMode] ?? 'Solid';
  // ↓ view mode ikonları da 15px
  const viewModeIcon =
    viewMode === ViewMode.WIREFRAME ? <BoxSelect size={15} /> :
    viewMode === ViewMode.XRAY     ? <ScanEye size={15} /> :
                                     <Cube size={15} />;

  const handleTransformToolSelect = (tool: Tool) => { setActiveTool(tool); setLastTransformTool(tool); };
  const handleModify = (type: ModificationType) => {
    if (!selectedShapeId) return;
    const configs: Record<string, object> = {
      [ModificationType.MIRROR]: { type, mirror: { axis: 'x', distance: 1000 } },
      [ModificationType.ARRAY]: { type, array: { count: 3, spacing: 750, direction: 'x' } },
      [ModificationType.FILLET]: { type, fillet: { radius: 50 } },
      [ModificationType.CHAMFER]: { type, chamfer: { distance: 50 } },
    };
    if (configs[type]) modifyShape(selectedShapeId, configs[type] as any);
    setShowModifyMenu(false);
  };
  const handleCameraToggle = () => setCameraType(cameraType === CameraType.PERSPECTIVE ? CameraType.ORTHOGRAPHIC : CameraType.PERSPECTIVE);

  React.useEffect(() => {
    const hide = () => setShowPolylineMenu(false);
    if (showPolylineMenu) { document.addEventListener('click', hide); return () => document.removeEventListener('click', hide); }
  }, [showPolylineMenu]);

  React.useEffect(() => {
    if (panelSelectMode && activeTool !== Tool.SELECT) setActiveTool(Tool.SELECT);
  }, [panelSelectMode, activeTool, setActiveTool]);

  const selectedShape = shapes.find((s) => s.id === selectedShapeId);
  const isBoxSelected = selectedShape?.type === 'box';

  const handleAddBox = async (e?: React.MouseEvent) => {
    e?.preventDefault(); e?.stopPropagation();
    try {
      const w = 600, h = 600, d = 600;
      const replicadShape = await createReplicadBox({ width: w, height: h, depth: d });
      addShape({ id: `box-${Date.now()}`, type: 'box', geometry: convertReplicadToThreeGeometry(replicadShape), replicadShape, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: '#2563eb', parameters: { width: w, height: h, depth: d } });
    } catch (error) { alert(`Failed to add box: ${(error as Error).message}`); }
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
    } catch (error) { alert(`Failed to subtract: ${(error as Error).message}`); }
  };

  /* ─── Menu definitions ─── */
  const menus = [
    { label: 'File', items: [{ icon: <FilePlus size={11} />, label: 'New Project', shortcut: 'Ctrl+N' }, { icon: <Upload size={11} />, label: 'Open Project...', shortcut: 'Ctrl+O' }, { type: 'separator' }, { icon: <Save size={11} />, label: 'Save', shortcut: 'Ctrl+S' }, { icon: <FileDown size={11} />, label: 'Save As...', shortcut: 'Ctrl+Shift+S' }, { type: 'separator' }, { icon: <Upload size={11} />, label: 'Import...', shortcut: 'Ctrl+I' }, { icon: <FileDown size={11} />, label: 'Export...', shortcut: 'Ctrl+E' }] },
    { label: 'Edit', items: [{ icon: <Undo2 size={11} />, label: 'Undo', shortcut: 'Ctrl+Z' }, { icon: <Redo2 size={11} />, label: 'Redo', shortcut: 'Ctrl+Y' }, { type: 'separator' }, { icon: <Scissors size={11} />, label: 'Cut', shortcut: 'Ctrl+X' }, { icon: <Copy size={11} />, label: 'Copy', shortcut: 'Ctrl+C' }, { icon: <ClipboardPaste size={11} />, label: 'Paste', shortcut: 'Ctrl+V' }, { type: 'separator' }, { icon: <Eraser size={11} />, label: 'Delete', shortcut: 'Del' }] },
    { label: 'View', items: [{ icon: <Grid size={11} />, label: 'Show Grid', shortcut: 'G' }, { icon: <Layers size={11} />, label: 'Show Layers', shortcut: 'L' }, { icon: <Eye size={11} />, label: 'Visibility', shortcut: 'V' }, { type: 'separator' }, { icon: <Cube size={11} />, label: 'Solid View', shortcut: '1' }, { icon: <BoxSelect size={11} />, label: 'Wireframe View', shortcut: '2' }, { icon: <ScanEye size={11} />, label: 'X-Ray View', shortcut: '3' }, { type: 'separator' }, { label: 'Zoom In', shortcut: 'Ctrl++' }, { label: 'Zoom Out', shortcut: 'Ctrl+-' }, { label: 'Fit to View', shortcut: 'F' }] },
    { label: 'Place', items: [{ icon: <Box size={11} />, label: 'Add Box', shortcut: 'B' }, { icon: <Cylinder size={11} />, label: 'Add Cylinder', shortcut: 'C' }, { icon: <Package size={11} />, label: '3D Objects', shortcut: '3' }, { type: 'separator' }, { icon: <Square size={11} />, label: '2D Shapes', shortcut: '2' }, { icon: <GitBranch size={11} />, label: 'Drawing Tools', shortcut: 'L' }] },
    { label: 'Modify', items: [{ icon: <Move size={11} />, label: 'Move', shortcut: 'M' }, { icon: <RotateCcw size={11} />, label: 'Rotate', shortcut: 'R' }, { icon: <Maximize size={11} />, label: 'Scale', shortcut: 'S' }, { type: 'separator' }, { icon: <FlipHorizontal size={11} />, label: 'Mirror', shortcut: 'Mi' }, { icon: <Copy size={11} />, label: 'Array', shortcut: 'Ar' }, { icon: <SlidersHorizontal size={11} />, label: 'Edit', shortcut: 'E' }] },
    { label: 'Snap', items: [{ icon: <Target size={11} />, label: 'Endpoint Snap', shortcut: 'End' }, { icon: <Navigation size={11} />, label: 'Midpoint Snap', shortcut: 'Mid' }, { icon: <Crosshair size={11} />, label: 'Center Snap', shortcut: 'Cen' }, { icon: <RotateCw size={11} />, label: 'Quadrant Snap', shortcut: 'Qua' }, { icon: <Zap size={11} />, label: 'Perpendicular Snap', shortcut: 'Per' }, { icon: <Intersection size={11} />, label: 'Intersection Snap', shortcut: 'Int' }, { icon: <MapPin size={11} />, label: 'Nearest Snap', shortcut: 'Nea' }, { type: 'separator' }, { icon: <Settings size={11} />, label: 'Snap Settings', shortcut: 'Ctrl+Snap' }] },
    { label: 'Measure', items: [{ icon: <Ruler size={11} />, label: 'Distance', shortcut: 'D' }, { icon: <Ruler size={11} />, label: 'Angle', shortcut: 'A' }, { icon: <Area size={11} />, label: 'Area', shortcut: 'Ar' }, { type: 'separator' }, { icon: <Ruler size={11} />, label: 'Add Dimension', shortcut: 'Ctrl+D' }, { icon: <Settings size={11} />, label: 'Dimension Style', shortcut: 'Ctrl+M' }] },
    { label: 'Display', items: [{ icon: <Monitor size={11} />, label: 'Render Settings', shortcut: 'R' }, { icon: <Eye size={11} />, label: 'View Modes', shortcut: 'V' }, { icon: <Camera size={11} />, label: 'Camera Settings', shortcut: 'C' }, { type: 'separator' }, { icon: <Layers size={11} />, label: 'Material Editor', shortcut: 'M' }, { icon: <Settings size={11} />, label: 'Lighting', shortcut: 'L' }] },
    { label: 'Settings', items: [{ icon: <Cog size={11} />, label: 'General Settings', shortcut: 'Ctrl+,' }, { icon: <Grid size={11} />, label: 'Grid Settings', shortcut: 'G' }, { icon: <Ruler size={11} />, label: 'Unit Settings', shortcut: 'U' }, { type: 'separator' }, { icon: <Settings size={11} />, label: 'Toolbar', shortcut: 'T' }, { icon: <PanelLeft size={11} />, label: 'Panel Layout', shortcut: 'P' }] },
    { label: 'Report', items: [{ icon: <FileText size={11} />, label: 'Project Report', shortcut: 'Ctrl+R' }, { icon: <BarChart3 size={11} />, label: 'Material List', shortcut: 'Ctrl+L' }, { icon: <FileText size={11} />, label: 'Dimension Report', shortcut: 'Ctrl+M' }, { type: 'separator' }, { icon: <FileDown size={11} />, label: 'PDF Export', shortcut: 'Ctrl+P' }, { icon: <FileDown size={11} />, label: 'Excel Export', shortcut: 'Ctrl+E' }] },
    { label: 'Window', items: [{ icon: <PanelLeft size={11} />, label: 'New Window', shortcut: 'Ctrl+N' }, { icon: <Layers size={11} />, label: 'Window Layout', shortcut: 'Ctrl+W' }, { type: 'separator' }, { icon: <Monitor size={11} />, label: 'Full Screen', shortcut: 'F11' }, { icon: <PanelLeft size={11} />, label: 'Hide Panels', shortcut: 'Tab' }] },
    { label: 'Help', items: [{ icon: <HelpCircle size={11} />, label: 'User Manual', shortcut: 'F1' }, { icon: <HelpCircle size={11} />, label: 'Keyboard Shortcuts', shortcut: 'Ctrl+?' }, { icon: <Monitor size={11} />, label: 'Video Tutorials', shortcut: 'Ctrl+T' }, { type: 'separator' }, { icon: <HelpCircle size={11} />, label: 'About', shortcut: 'Ctrl+H' }, { icon: <HelpCircle size={11} />, label: 'Check Updates', shortcut: 'Ctrl+U' }] },
  ];

  return (
    <>
      <style>{`
        @keyframes tb-fade-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
        .tb-menu-enter { animation: tb-fade-in 0.12s ease-out forwards; }
        .tb-active-indicator {
          position: absolute; bottom: -1px; left: 50%; transform: translateX(-50%);
          width: 14px; height: 2px; background: #f97316; border-radius: 9999px;
        }
      `}</style>

      <div className="flex flex-col select-none font-sans">

        {/* ── Row 1 · Header ── */}
        <div className="flex items-center h-11 px-4 bg-white border-b border-stone-200 shadow-sm">
          <div className="flex items-center gap-3">
            <img src="/yago_logo.png" alt="YAGO" className="h-7 w-auto object-contain" />
            <div className="w-px h-5 bg-stone-200" />
            <div className="flex items-center gap-1 text-xs">
              <span className="text-stone-400 font-medium">Şirket</span>
              <span className="text-stone-300 mx-0.5">/</span>
              <span className="text-orange-600 font-semibold">Göker İnşaat</span>
            </div>
            <div className="w-px h-5 bg-stone-200" />
            <div className="flex items-center gap-1 text-xs">
              <span className="text-stone-400 font-medium">Proje</span>
              <span className="text-stone-300 mx-0.5">/</span>
              <span className="text-stone-700 font-semibold">Drawing1</span>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400 pointer-events-none" />
              <input type="text" placeholder="Ara..." className="w-36 h-7 pl-8 pr-3 text-xs bg-stone-50 rounded-lg border border-stone-200 focus:outline-none focus:border-orange-400 focus:ring-1 focus:ring-orange-200 transition-all placeholder-stone-400 text-stone-700" />
            </div>
            <button className="p-1.5 rounded-lg hover:bg-stone-100 transition-colors text-stone-500 hover:text-stone-700" title="Ayarlar"><Settings size={13} /></button>
            <button className="p-1.5 rounded-lg hover:bg-stone-100 transition-colors text-stone-500 hover:text-stone-700" title="Yardım"><HelpCircle size={13} /></button>
          </div>
        </div>

        {/* ── Row 2 · Menu Bar ── */}
        <div className="flex items-center h-8 px-2 bg-stone-50 border-b border-stone-200">
          {menus.map((menu) => (
            <div key={menu.label} className="relative h-full">
              <button
               className={`relative h-full px-3 text-[12.1px] font-medium transition-colors flex items-center gap-0.2
                  ${activeMenu === menu.label ? 'text-orange-500 bg-orange-50' : 'text-stone-600 hover:text-stone-800 hover:bg-stone-100'}`}
                onClick={() => setActiveMenu(activeMenu === menu.label ? null : menu.label)}
                onMouseEnter={() => activeMenu && setActiveMenu(menu.label)}
              >
                {menu.label}
                {activeMenu === menu.label && <div className="tb-active-indicator" />}
              </button>
              {activeMenu === menu.label && (
                <div className="tb-menu-enter absolute left-0 top-full mt-0.5 w-52 bg-white rounded-xl border border-stone-200 py-1.5 z-50 shadow-xl shadow-stone-200/60" onMouseLeave={() => setActiveMenu(null)}>
                  {menu.items.map((item, i) =>
                    item.type === 'separator'
                      ? <div key={i} className="border-t border-stone-100 my-1" />
                      : (
                        <button key={i} className="flex items-center justify-between w-full h-8 px-3 text-xs hover:bg-orange-50 hover:text-orange-600 transition-colors text-stone-600 rounded-lg mx-0"
                          onClick={() => {
                            if (item.label === 'Solid View') setViewMode(ViewMode.SOLID);
                            else if (item.label === 'Wireframe View') setViewMode(ViewMode.WIREFRAME);
                            else if (item.label === 'X-Ray View') setViewMode(ViewMode.XRAY);
                            setActiveMenu(null);
                          }}>
                          <div className="flex items-center gap-2">{item.icon}<span className="font-medium">{item.label}</span></div>
                          {item.shortcut && <span className="text-stone-400 text-[10px] font-mono">{item.shortcut}</span>}
                        </button>
                      )
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* ── Row 3 · Main Toolbar ── */}
        {/* ↓ yükseklik 34px → 30px, butonlar küçüldüğü için */}
        <div className="flex items-center h-[30px] gap-0.5 px-3 bg-stone-50 border-b border-stone-200">

          {/* File group */}
          <div className="flex items-center bg-white rounded-lg shadow-sm border border-stone-200 p-0.5 gap-0">
            <TBtn icon={<FilePlus size={15} />}  label="Yeni (Ctrl+N)" />
            <TBtn icon={<Save size={15} />}       label="Kaydet (Ctrl+S)" />
            <TBtn icon={<FileDown size={15} />}   label="Farklı Kaydet (Ctrl+Shift+S)" />
          </div>

          <Sep />

          {/* Undo / Redo */}
          <div className="flex items-center bg-white rounded-lg shadow-sm border border-stone-200 p-0.5 gap-0">
            <TBtn icon={<Undo2 size={15} />}  label="Geri Al (Ctrl+Z)" />
            <TBtn icon={<Redo2 size={15} />}  label="Yinele (Ctrl+Y)" />
          </div>

          <Sep />

          {/* Transform tools */}
          <div className="flex items-center bg-white rounded-lg shadow-sm border border-stone-200 p-0.5 gap-0">
            <TBtn
              icon={<MousePointer2 size={15} />}
              label="Seç (V)"
              active={activeTool === Tool.SELECT}
              onClick={() => setActiveTool(Tool.SELECT)}
            />
            <TBtn
              icon={<Move size={15} />}
              label="Taşı (M)"
              active={activeTool === Tool.MOVE}
              disabled={!selectedShapeId}
              onClick={() => handleTransformToolSelect(Tool.MOVE)}
            />
            <TBtn
              icon={<Navigation size={15} />}
              label="Noktadan Noktaya"
              active={activeTool === Tool.POINT_TO_POINT_MOVE}
              disabled={!selectedShapeId}
              onClick={() => handleTransformToolSelect(Tool.POINT_TO_POINT_MOVE)}
            />
            <TBtn
              icon={<RefreshCcw size={15} />}
              label="Döndür (R)"
              active={activeTool === Tool.ROTATE}
              disabled={!selectedShapeId}
              onClick={() => handleTransformToolSelect(Tool.ROTATE)}
            />
            <TBtn
              icon={<Maximize2 size={15} />}
              label={isBoxSelected ? 'Ölçek – kutu için devre dışı' : 'Ölçekle (S)'}
              active={activeTool === Tool.SCALE}
              disabled={!selectedShapeId || isBoxSelected}
              onClick={() => handleTransformToolSelect(Tool.SCALE)}
            />
          </div>

          <Sep />

          {/* Geometry & Tools */}
          <div className="flex items-center bg-white rounded-lg shadow-sm border border-stone-200 p-0.5 gap-0">
            <TBtn icon={<AddBoxIcon size={15} />}       label="Kutu Ekle (B)"    onClick={handleAddBox} />
            <TBtn
              icon={<MinusSquare size={15} />}
              label={hasIntersectingShapes ? 'Kesişen Şekilleri Çıkar' : selectedShapeId ? 'Kesişen şekil yok' : 'Önce şekil seçin'}
              danger={hasIntersectingShapes}
              disabled={!selectedShapeId}
              onClick={handleSubtract}
            />
          </div>

          <Sep />

          {/* View controls */}
          <div className="flex items-center bg-white rounded-lg shadow-sm border border-stone-200 p-0.5 gap-0">
            <TBtn
              icon={cameraType === CameraType.PERSPECTIVE ? <Camera size={15} /> : <CameraOff size={15} />}
              label={cameraType === CameraType.PERSPECTIVE ? 'Perspektif' : 'Ortografik'}
              onClick={handleCameraToggle}
            />
            <TBtn
              icon={viewModeIcon}
              label={`Görünüm: ${viewModeLabel}`}
              active={viewMode !== ViewMode.SOLID}
              onClick={() => useAppStore.getState().cycleViewMode()}
            />
            <TBtn
              icon={<Crosshair size={15} />}
              label={`Lineer Mod: ${orthoMode === OrthoMode.ON ? 'Açık' : 'Kapalı'}`}
              active={orthoMode === OrthoMode.ON}
              onClick={() => toggleOrthoMode()}
            />
            <TBtn
              icon={<FolderOpen size={15} />}
              label="Katalog"
              accent
              onClick={onOpenCatalog}
            />
          </div>

        </div>
      </div>

      {/* Polyline context menu */}
      {showPolylineMenu && (
        <div className="fixed bg-white rounded-xl border border-stone-200 py-1.5 z-50 shadow-xl shadow-stone-200/60 tb-menu-enter" style={{ left: polylineMenuPosition.x, top: polylineMenuPosition.y }}>
          <button className="w-full px-3 py-2 text-left text-xs hover:bg-orange-50 hover:text-orange-600 flex items-center gap-2 text-stone-600 transition-colors"
            onClick={() => { setActiveTool(Tool.POLYLINE_EDIT); setShowPolylineMenu(false); }}>
            <SlidersHorizontal size={13} /><span className="font-medium">Polilini Düzenle</span>
          </button>
          <button className="w-full px-3 py-2 text-left text-xs hover:bg-orange-50 hover:text-orange-600 flex items-center gap-2 text-stone-600 transition-colors"
            onClick={() => { setActiveTool(Tool.POLYLINE); setShowPolylineMenu(false); }}>
            <GitBranch size={13} /><span className="font-medium">Polilini Çiz</span>
          </button>
        </div>
      )}

    </>
  );
};

export default Toolbar;
