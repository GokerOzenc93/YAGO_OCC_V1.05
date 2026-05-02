import React, { useState } from 'react';
import {
  Search, Settings, HelpCircle,
  FilePlus, FileDown, Save, Upload,
  Undo2, Redo2, Scissors, Copy, ClipboardPaste, Eraser,
  Move, Navigation, RefreshCcw, Maximize2,
  Box, Cog, SlidersHorizontal, MinusSquare, PanelLeft,
  Camera,
  BoxSelect, ScanEye, Cuboid as Cube,
  Grid2x2 as Grid, Layers, Eye, Cylinder, Package, Square, FlipHorizontal,
  Maximize, Maximize2 as Area, BarChart3, FileText,
  GitBranch, Target, RotateCw, Zap,
  InspectionPanel as Intersection, MapPin, Ruler, Monitor,
  RotateCcw,
} from 'lucide-react';
import { useAppStore, ViewMode } from '../store';

const TopBar: React.FC = () => {
  const { setViewMode } = useAppStore();
  const [activeMenu, setActiveMenu] = useState<string | null>(null);

  const menus = [
    { label: 'File', items: [{ icon: <FilePlus size={11} />, label: 'New Project', shortcut: 'Ctrl+N' }, { icon: <Upload size={11} />, label: 'Open Project...', shortcut: 'Ctrl+O' }, { type: 'separator' }, { icon: <Save size={11} />, label: 'Save', shortcut: 'Ctrl+S' }, { icon: <FileDown size={11} />, label: 'Save As...', shortcut: 'Ctrl+Shift+S' }, { type: 'separator' }, { icon: <Upload size={11} />, label: 'Import...', shortcut: 'Ctrl+I' }, { icon: <FileDown size={11} />, label: 'Export...', shortcut: 'Ctrl+E' }] },
    { label: 'Edit', items: [{ icon: <Undo2 size={11} />, label: 'Undo', shortcut: 'Ctrl+Z' }, { icon: <Redo2 size={11} />, label: 'Redo', shortcut: 'Ctrl+Y' }, { type: 'separator' }, { icon: <Scissors size={11} />, label: 'Cut', shortcut: 'Ctrl+X' }, { icon: <Copy size={11} />, label: 'Copy', shortcut: 'Ctrl+C' }, { icon: <ClipboardPaste size={11} />, label: 'Paste', shortcut: 'Ctrl+V' }, { type: 'separator' }, { icon: <Eraser size={11} />, label: 'Delete', shortcut: 'Del' }] },
    { label: 'View', items: [{ icon: <Grid size={11} />, label: 'Show Grid', shortcut: 'G' }, { icon: <Layers size={11} />, label: 'Show Layers', shortcut: 'L' }, { icon: <Eye size={11} />, label: 'Visibility', shortcut: 'V' }, { type: 'separator' }, { icon: <Cube size={11} />, label: 'Solid View', shortcut: '1' }, { icon: <BoxSelect size={11} />, label: 'Wireframe View', shortcut: '2' }, { icon: <ScanEye size={11} />, label: 'X-Ray View', shortcut: '3' }, { type: 'separator' }, { label: 'Zoom In', shortcut: 'Ctrl++' }, { label: 'Zoom Out', shortcut: 'Ctrl+-' }, { label: 'Fit to View', shortcut: 'F' }] },
    { label: 'Place', items: [{ icon: <Box size={11} />, label: 'Add Box', shortcut: 'B' }, { icon: <Cylinder size={11} />, label: 'Add Cylinder', shortcut: 'C' }, { icon: <Package size={11} />, label: '3D Objects', shortcut: '3' }, { type: 'separator' }, { icon: <Square size={11} />, label: '2D Shapes', shortcut: '2' }, { icon: <GitBranch size={11} />, label: 'Drawing Tools', shortcut: 'L' }] },
    { label: 'Modify', items: [{ icon: <Move size={11} />, label: 'Move', shortcut: 'M' }, { icon: <RotateCcw size={11} />, label: 'Rotate', shortcut: 'R' }, { icon: <Maximize size={11} />, label: 'Scale', shortcut: 'S' }, { type: 'separator' }, { icon: <FlipHorizontal size={11} />, label: 'Mirror', shortcut: 'Mi' }, { icon: <Copy size={11} />, label: 'Array', shortcut: 'Ar' }, { icon: <SlidersHorizontal size={11} />, label: 'Edit', shortcut: 'E' }] },
    { label: 'Snap', items: [{ icon: <Target size={11} />, label: 'Endpoint Snap', shortcut: 'End' }, { icon: <Navigation size={11} />, label: 'Midpoint Snap', shortcut: 'Mid' }, { icon: <Target size={11} />, label: 'Center Snap', shortcut: 'Cen' }, { icon: <RotateCw size={11} />, label: 'Quadrant Snap', shortcut: 'Qua' }, { icon: <Zap size={11} />, label: 'Perpendicular Snap', shortcut: 'Per' }, { icon: <Intersection size={11} />, label: 'Intersection Snap', shortcut: 'Int' }, { icon: <MapPin size={11} />, label: 'Nearest Snap', shortcut: 'Nea' }, { type: 'separator' }, { icon: <Settings size={11} />, label: 'Snap Settings', shortcut: 'Ctrl+Snap' }] },
    { label: 'Measure', items: [{ icon: <Ruler size={11} />, label: 'Distance', shortcut: 'D' }, { icon: <Ruler size={11} />, label: 'Angle', shortcut: 'A' }, { icon: <Area size={11} />, label: 'Area', shortcut: 'Ar' }, { type: 'separator' }, { icon: <Ruler size={11} />, label: 'Add Dimension', shortcut: 'Ctrl+D' }, { icon: <Settings size={11} />, label: 'Dimension Style', shortcut: 'Ctrl+M' }] },
    { label: 'Display', items: [{ icon: <Monitor size={11} />, label: 'Render Settings', shortcut: 'R' }, { icon: <Eye size={11} />, label: 'View Modes', shortcut: 'V' }, { icon: <Camera size={11} />, label: 'Camera Settings', shortcut: 'C' }, { type: 'separator' }, { icon: <Layers size={11} />, label: 'Material Editor', shortcut: 'M' }, { icon: <Settings size={11} />, label: 'Lighting', shortcut: 'L' }] },
    { label: 'Settings', items: [{ icon: <Cog size={11} />, label: 'General Settings', shortcut: 'Ctrl+,' }, { icon: <Grid size={11} />, label: 'Grid Settings', shortcut: 'G' }, { icon: <Ruler size={11} />, label: 'Unit Settings', shortcut: 'U' }, { type: 'separator' }, { icon: <Settings size={11} />, label: 'Toolbar', shortcut: 'T' }, { icon: <PanelLeft size={11} />, label: 'Panel Layout', shortcut: 'P' }] },
    { label: 'Report', items: [{ icon: <FileText size={11} />, label: 'Project Report', shortcut: 'Ctrl+R' }, { icon: <BarChart3 size={11} />, label: 'Material List', shortcut: 'Ctrl+L' }, { icon: <FileText size={11} />, label: 'Dimension Report', shortcut: 'Ctrl+M' }, { type: 'separator' }, { icon: <FileDown size={11} />, label: 'PDF Export', shortcut: 'Ctrl+P' }, { icon: <FileDown size={11} />, label: 'Excel Export', shortcut: 'Ctrl+E' }] },
    { label: 'Window', items: [{ icon: <PanelLeft size={11} />, label: 'New Window', shortcut: 'Ctrl+N' }, { icon: <Layers size={11} />, label: 'Window Layout', shortcut: 'Ctrl+W' }, { type: 'separator' }, { icon: <Monitor size={11} />, label: 'Full Screen', shortcut: 'F11' }, { icon: <PanelLeft size={11} />, label: 'Hide Panels', shortcut: 'Tab' }] },
    { label: 'Help', items: [{ icon: <HelpCircle size={11} />, label: 'User Manual', shortcut: 'F1' }, { icon: <HelpCircle size={11} />, label: 'Keyboard Shortcuts', shortcut: 'Ctrl+?' }, { icon: <Monitor size={11} />, label: 'Video Tutorials', shortcut: 'Ctrl+T' }, { type: 'separator' }, { icon: <HelpCircle size={11} />, label: 'About', shortcut: 'Ctrl+H' }, { icon: <HelpCircle size={11} />, label: 'Check Updates', shortcut: 'Ctrl+U' }] },
  ];

  return (
    <div className="flex flex-col select-none font-sans shrink-0">
      <style>{`
        @keyframes tb-fade-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
        .tb-menu-enter { animation: tb-fade-in 0.12s ease-out forwards; }
        .tb-active-indicator {
          position: absolute; bottom: -1px; left: 50%; transform: translateX(-50%);
          width: 14px; height: 2px; background: #f97316; border-radius: 9999px;
        }
      `}</style>

      {/* Row 1 · Header */}
      <div className="flex items-center h-11 px-4 bg-white border-b border-stone-200 shadow-sm">
        <div className="flex items-center gap-3">
          <img src="/yago_logo.png" alt="YAGO" className="h-7 w-auto object-contain" />
          <div className="w-px h-5 bg-stone-200" />
          <div className="flex items-center gap-1 text-[13.1px]">
            <span className="text-stone-400 font-medium">Company</span>
            <span className="text-stone-300 mx-0.5">/</span>
            <span className="text-orange-600 font-semibold">Göker İnşaat</span>
          </div>
          <div className="w-px h-5 bg-stone-200" />
          <div className="flex items-center gap-1 text-[13.1px]">
            <span className="text-stone-400 font-medium">Project</span>
            <span className="text-stone-300 mx-0.5">/</span>
            <span className="text-stone-700 font-semibold">Drawing1</span>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400 pointer-events-none" />
            <input type="text" placeholder="Search..." className="w-36 h-7 pl-8 pr-3 text-xs bg-stone-50 rounded-lg border border-stone-200 focus:outline-none focus:border-orange-400 focus:ring-1 focus:ring-orange-200 transition-all placeholder-stone-400 text-stone-700" />
          </div>
          <button title="Settings" className="flex items-center justify-center w-7 h-7 rounded-md text-stone-400 hover:bg-stone-100 hover:text-stone-700 transition-colors">
            <Settings size={17} />
          </button>
          <button title="Help" className="flex items-center justify-center w-7 h-7 rounded-md text-stone-400 hover:bg-stone-100 hover:text-stone-700 transition-colors">
            <HelpCircle size={17} />
          </button>
        </div>
      </div>

      {/* Row 2 · Menu Bar */}
      <div className="flex items-center h-8 px-2 bg-stone-50 border-b border-stone-200">
        {menus.map((menu) => (
          <div key={menu.label} className="relative h-full">
            <button
              className={`relative h-full px-3 text-[13.1px] font-medium transition-colors flex items-center
                ${activeMenu === menu.label ? 'text-orange-500 bg-orange-50' : 'text-stone-600 hover:text-stone-800 hover:bg-stone-100'}`}
              onClick={() => setActiveMenu(activeMenu === menu.label ? null : menu.label)}
              onMouseEnter={() => activeMenu && setActiveMenu(menu.label)}
            >
              {menu.label}
              {activeMenu === menu.label && <div className="tb-active-indicator" />}
            </button>
            {activeMenu === menu.label && (
              <div
                className="tb-menu-enter absolute left-0 top-full mt-0.5 w-52 bg-white rounded-xl border border-stone-200 py-1.5 z-50 shadow-xl shadow-stone-200/60"
                onMouseLeave={() => setActiveMenu(null)}
              >
                {menu.items.map((item, i) =>
                  item.type === 'separator'
                    ? <div key={i} className="border-t border-stone-100 my-1" />
                    : (
                      <button
                        key={i}
                        className="flex items-center justify-between w-full h-8 px-3 text-xs hover:bg-orange-50 hover:text-orange-600 transition-colors text-stone-600"
                        onClick={() => {
                          if (item.label === 'Solid View') setViewMode(ViewMode.SOLID);
                          else if (item.label === 'Wireframe View') setViewMode(ViewMode.WIREFRAME);
                          else if (item.label === 'X-Ray View') setViewMode(ViewMode.XRAY);
                          setActiveMenu(null);
                        }}
                      >
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
    </div>
  );
};

export default TopBar;
