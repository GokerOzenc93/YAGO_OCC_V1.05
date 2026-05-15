import React, { useState } from 'react';
import * as THREE from 'three';
import { Tool, useAppStore, ModificationType, CameraType, SnapType, ViewMode, OrthoMode } from '../store';
import {
  Search, Settings, HelpCircle, LogOut,
  FilePlus, FileDown, Save, Upload,
  Undo2, Redo2, Scissors, Copy, ClipboardPaste, Eraser,
  MousePointer2, Move, Navigation, RefreshCcw, Maximize2,
  Box, Cog, SlidersHorizontal, MinusSquare, PanelLeft,
  Camera, CameraOff, Crosshair, FolderOpen,
  BoxSelect, ScanEye, Cuboid as Cube,
  Grid2x2 as Grid, Layers, Eye, Cylinder, Package, Square, FlipHorizontal,
  Maximize, Maximize2 as Area, BarChart3, FileText,
  GitBranch, Target, RotateCw, Zap,
  InspectionPanel as Intersection, MapPin, Ruler, Monitor,
  RotateCcw, ArrowDownUp,
} from 'lucide-react';
import { createReplicadBox, convertReplicadToThreeGeometry, performBooleanCut } from './ReplicadService';
import {
  AddBoxButton, SubtractBoxButton,
  CameraPerspectiveButton, CameraOrthographicButton,
  ViewSolidButton, ViewWireframeButton, ViewXRayButton,
} from './icons';

interface ToolbarProps { onOpenCatalog: () => void; }

/* ─── Typography scale ─── */
const TS = {
  /* Top-level UI text — header breadcrumbs, search input, menu bar items */
  ui:           '12.5px',
  uiSep:        '11.5px',   // breadcrumb separator chevron
  uiLabel:      '10.5px',   // tiny eyebrow labels above breadcrumbs
  /* Letter-spacing */
  ls:           '0.012em',
  lsTight:      '-0.005em', // active menu / strong items
  lsLoose:      '0.04em',   // uppercase labels
};

/* ─── Design tokens ─── */
const T = {
  /* surfaces */
  headerBg:    '#fdfcfa',
  /* Menu bar: deeper layered surface for that "milled bone" depth */
  menuBg:      'linear-gradient(180deg,#f7f5f0 0%,#efece5 100%)',
  rowBg:       'linear-gradient(180deg,#f4f2ee 0%,#ebe8e2 100%)',
  /* Button group */
  groupBg:     'linear-gradient(180deg,#fdfcfa 0%,#f6f3ed 100%)',
  groupBorder: 'rgba(60,50,40,0.14)',
  groupShadow: '0 1.5px 3px rgba(40,30,20,0.09),0 0.5px 1px rgba(40,30,20,0.05),0 0 0 0.5px rgba(60,50,40,0.07),inset 0 0.5px 0 rgba(255,255,255,0.95),inset 0 -0.5px 0 rgba(140,120,100,0.06)',
  hdrBorder:   '#e4dfd7',
  rowBorder:   '#d6d1c8',
  menuBorder:  '#dcd6cb',
  iconIdle:    '#6b6560',
  iconHover:   '#1c1917',
  iconActive:  '#ea580c',
  activeBg:    'rgba(234,88,12,0.08)',
  activeBord:  'rgba(234,88,12,0.28)',
  hoverBg:     'rgba(0,0,0,0.05)',

  /* Text */
  textPrimary: '#1c1917',
  textStrong:  '#292524',
  textBody:    '#44403c',
  textMute:    '#706b65',
  textFaint:   '#9c9590',
  textWhisper: '#c9c4be',
};

/* ─── Icon button ─── */
interface TBtnProps {
  icon: React.ReactNode; label: string;
  active?: boolean; disabled?: boolean; danger?: boolean;
  exit?: boolean; accent?: boolean;
  onClick?: () => void; className?: string;
}
const TBtn: React.FC<TBtnProps> = ({
  icon, label, active=false, disabled=false,
  danger=false, exit=false, accent=false, onClick, className='',
}) => {
  const [hov, setHov] = useState(false);

  let color = T.iconIdle, bg = 'transparent', shadow = 'none';
  if (disabled)      { color = '#c4bfbb'; }
  else if (exit)     { color = hov ? '#92400e' : '#b45309'; bg = hov ? 'rgba(180,83,9,0.07)' : 'transparent'; }
  else if (danger)   { color = hov ? '#dc2626' : '#ef4444'; bg = hov ? 'rgba(239,68,68,0.08)' : 'transparent'; }
  else if (active)   { color = T.iconActive; bg = T.activeBg; shadow = `0 0 0 1px ${T.activeBord}`; }
  else if (accent)   { color = T.iconActive; bg = T.activeBg; }
  else if (hov)      { color = T.iconHover;  bg = T.hoverBg; }

  return (
    <button
      title={label} disabled={disabled} onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      className={className}
      style={{
        position:'relative', display:'flex', alignItems:'center', justifyContent:'center',
        width:'28px', height:'28px', borderRadius:'6px', border:'none',
        background:bg, boxShadow:shadow, color,
        cursor: disabled ? 'not-allowed' : 'pointer', flexShrink:0, outline:'none',
        transition:'background 0.1s,color 0.1s,box-shadow 0.1s,transform 0.1s',
        transform: hov && !disabled && !active ? 'scale(1.06)' : 'scale(1)',
      }}
    >
      {icon}
      <span style={{
        pointerEvents:'none', position:'absolute', top:'calc(100% + 6px)', left:'50%',
        transform:'translateX(-50%)', background:'#1c1917', color:'#fafaf9',
        fontSize:'10px', fontWeight:500, letterSpacing:'0.02em', padding:'3px 7px',
        borderRadius:'5px', whiteSpace:'nowrap', zIndex:60,
        opacity: hov && !disabled ? 1 : 0, transition:'opacity 0.12s',
      }}>
        {label}
      </span>
    </button>
  );
};

/* ─── Button group ─── */
const BtnGroup: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{
    display:'flex', alignItems:'center', gap:'1px', padding:'2px',
    background:T.groupBg, border:`1px solid ${T.groupBorder}`,
    borderRadius:'8px', boxShadow:T.groupShadow, flexShrink:0,
  }}>
    {children}
  </div>
);

const GrpSep = () => (
  <div style={{
    width:'1px', height:'16px', flexShrink:0, margin:'0 2px',
    background:'linear-gradient(to bottom,transparent 0%,rgba(60,50,40,0.14) 30%,rgba(60,50,40,0.14) 70%,transparent 100%)',
  }} />
);

const Sep = () => (
  <div style={{
    width:'1px', height:'18px', flexShrink:0, margin:'0 8px',
    background:'linear-gradient(to bottom,transparent 0%,rgba(60,50,40,0.12) 25%,rgba(60,50,40,0.12) 75%,transparent 100%)',
  }} />
);

/* ═══════════════════════════════════════════
   Toolbar
═══════════════════════════════════════════ */
const Toolbar: React.FC<ToolbarProps> = ({ onOpenCatalog }) => {
  const {
    setActiveTool, activeTool, setLastTransformTool, addShape, selectedShapeId,
    modifyShape, cameraType, setCameraType, snapSettings, toggleSnapSetting,
    viewMode, setViewMode, cycleViewMode, orthoMode, toggleOrthoMode,
    opencascadeInstance, extrudeShape, shapes, updateShape, deleteShape,
    panelSelectMode, panelSurfaceSelectMode, setPanelSurfaceSelectMode,
  } = useAppStore();

  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [showPolylineMenu, setShowPolylineMenu] = useState(false);
  const [polylineMenuPosition, setPolylineMenuPosition] = useState({ x:0, y:0 });

  const hasIntersectingShapes = React.useMemo(() => {
    if (!selectedShapeId) return false;
    const sel = shapes.find(s => s.id === selectedShapeId);
    if (!sel?.geometry || sel.type === 'panel') return false;
    try {
      const sb = new THREE.Box3().setFromBufferAttribute(sel.geometry.getAttribute('position'));
      sb.set(sb.min.clone().add(new THREE.Vector3(...sel.position)), sb.max.clone().add(new THREE.Vector3(...sel.position)));
      return shapes.some(s => {
        if (s.id === selectedShapeId || !s.geometry || s.type === 'panel') return false;
        try {
          const b = new THREE.Box3().setFromBufferAttribute(s.geometry.getAttribute('position'));
          b.set(b.min.clone().add(new THREE.Vector3(...s.position)), b.max.clone().add(new THREE.Vector3(...s.position)));
          return sb.intersectsBox(b);
        } catch { return false; }
      });
    } catch { return false; }
  }, [selectedShapeId, shapes]);

  const handleTransformToolSelect = (tool: Tool) => { setActiveTool(tool); setLastTransformTool(tool); };
  const handleCameraToggle = () => setCameraType(cameraType === CameraType.PERSPECTIVE ? CameraType.ORTHOGRAPHIC : CameraType.PERSPECTIVE);

  React.useEffect(() => {
    const hide = () => setShowPolylineMenu(false);
    if (showPolylineMenu) { document.addEventListener('click', hide); return () => document.removeEventListener('click', hide); }
  }, [showPolylineMenu]);

  React.useEffect(() => {
    if (panelSelectMode && activeTool !== Tool.SELECT) setActiveTool(Tool.SELECT);
  }, [panelSelectMode, activeTool, setActiveTool]);

  const selectedShape = shapes.find(s => s.id === selectedShapeId);
  const isBoxSelected = selectedShape?.type === 'box';

  const handleAddBox = async (e?: React.MouseEvent) => {
    e?.preventDefault(); e?.stopPropagation();
    try {
      const w=600,h=600,d=600;
      const rs = await createReplicadBox({width:w,height:h,depth:d});
      addShape({id:`box-${Date.now()}`,type:'box',geometry:convertReplicadToThreeGeometry(rs),replicadShape:rs,position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],color:'#2563eb',parameters:{width:w,height:h,depth:d}});
    } catch (err) { alert(`Failed to add box: ${(err as Error).message}`); }
  };

  const handleSubtract = async () => {
    if (!selectedShapeId || !hasIntersectingShapes) return;
    try {
      const sel = shapes.find(s => s.id === selectedShapeId);
      if (!sel?.geometry || !sel.replicadShape) return;
      const sb = new THREE.Box3().setFromBufferAttribute(sel.geometry.getAttribute('position'));
      sb.set(sb.min.clone().add(new THREE.Vector3(...sel.position)), sb.max.clone().add(new THREE.Vector3(...sel.position)));
      const intersecting = shapes.filter(s => {
        if (s.id===selectedShapeId||!s.geometry) return false;
        const b=new THREE.Box3().setFromBufferAttribute(s.geometry.getAttribute('position'));
        b.set(b.min.clone().add(new THREE.Vector3(...s.position)),b.max.clone().add(new THREE.Vector3(...s.position)));
        return sb.intersectsBox(b);
      });
      if (!intersecting.length) return;
      const {getReplicadVertices} = await import('./VertexEditorService');
      for (const tgt of intersecting) {
        if (!tgt.replicadShape) continue;
        const relOff = sel.position.map((v,i)=>v-tgt.position[i]) as [number,number,number];
        const relRot = sel.rotation.map((v,i)=>v-tgt.rotation[i]) as [number,number,number];
        const result = await performBooleanCut(tgt.replicadShape,sel.replicadShape,undefined,relOff,undefined,relRot,undefined,sel.scale);
        const newGeo = convertReplicadToThreeGeometry(result);
        const newVerts = await getReplicadVertices(result);
        updateShape(tgt.id,{geometry:newGeo,replicadShape:result,subtractionGeometries:[...(tgt.subtractionGeometries||[]),{geometry:sel.geometry.clone(),relativeOffset:relOff,relativeRotation:relRot,scale:[1,1,1]}],parameters:{...tgt.parameters,scaledBaseVertices:newVerts.map(v=>[v.x,v.y,v.z])}});
      }
      deleteShape(selectedShapeId);
    } catch (err) { alert(`Failed to subtract: ${(err as Error).message}`); }
  };

  const menus = [
    {label:'File',items:[{icon:<FilePlus size={11}/>,label:'New Project',shortcut:'Ctrl+N'},{icon:<Upload size={11}/>,label:'Open Project...',shortcut:'Ctrl+O'},{type:'separator'},{icon:<Save size={11}/>,label:'Save',shortcut:'Ctrl+S'},{icon:<FileDown size={11}/>,label:'Save As...',shortcut:'Ctrl+Shift+S'},{type:'separator'},{icon:<Upload size={11}/>,label:'Import...',shortcut:'Ctrl+I'},{icon:<FileDown size={11}/>,label:'Export...',shortcut:'Ctrl+E'}]},
    {label:'Edit',items:[{icon:<Undo2 size={11}/>,label:'Undo',shortcut:'Ctrl+Z'},{icon:<Redo2 size={11}/>,label:'Redo',shortcut:'Ctrl+Y'},{type:'separator'},{icon:<Scissors size={11}/>,label:'Cut',shortcut:'Ctrl+X'},{icon:<Copy size={11}/>,label:'Copy',shortcut:'Ctrl+C'},{icon:<ClipboardPaste size={11}/>,label:'Paste',shortcut:'Ctrl+V'},{type:'separator'},{icon:<Eraser size={11}/>,label:'Delete',shortcut:'Del'}]},
    {label:'View',items:[{icon:<Grid size={11}/>,label:'Show Grid',shortcut:'G'},{icon:<Layers size={11}/>,label:'Show Layers',shortcut:'L'},{icon:<Eye size={11}/>,label:'Visibility',shortcut:'V'},{type:'separator'},{icon:<Cube size={11}/>,label:'Solid View',shortcut:'1'},{icon:<BoxSelect size={11}/>,label:'Wireframe View',shortcut:'2'},{icon:<ScanEye size={11}/>,label:'X-Ray View',shortcut:'3'},{type:'separator'},{label:'Zoom In',shortcut:'Ctrl++'},{label:'Zoom Out',shortcut:'Ctrl+-'},{label:'Fit to View',shortcut:'F'}]},
    {label:'Place',items:[{icon:<Box size={11}/>,label:'Add Box',shortcut:'B'},{icon:<Cylinder size={11}/>,label:'Add Cylinder',shortcut:'C'},{icon:<Package size={11}/>,label:'3D Objects',shortcut:'3'},{type:'separator'},{icon:<Square size={11}/>,label:'2D Shapes',shortcut:'2'},{icon:<GitBranch size={11}/>,label:'Drawing Tools',shortcut:'L'}]},
    {label:'Modify',items:[{icon:<Move size={11}/>,label:'Move',shortcut:'M'},{icon:<RotateCcw size={11}/>,label:'Rotate',shortcut:'R'},{icon:<Maximize size={11}/>,label:'Scale',shortcut:'S'},{type:'separator'},{icon:<FlipHorizontal size={11}/>,label:'Mirror',shortcut:'Mi'},{icon:<Copy size={11}/>,label:'Array',shortcut:'Ar'},{icon:<SlidersHorizontal size={11}/>,label:'Edit',shortcut:'E'}]},
    {label:'Snap',items:[{icon:<Target size={11}/>,label:'Endpoint Snap',shortcut:'End'},{icon:<Navigation size={11}/>,label:'Midpoint Snap',shortcut:'Mid'},{icon:<Crosshair size={11}/>,label:'Center Snap',shortcut:'Cen'},{icon:<RotateCw size={11}/>,label:'Quadrant Snap',shortcut:'Qua'},{icon:<Zap size={11}/>,label:'Perpendicular Snap',shortcut:'Per'},{icon:<Intersection size={11}/>,label:'Intersection Snap',shortcut:'Int'},{icon:<MapPin size={11}/>,label:'Nearest Snap',shortcut:'Nea'},{type:'separator'},{icon:<Settings size={11}/>,label:'Snap Settings',shortcut:'Ctrl+Snap'}]},
    {label:'Measure',items:[{icon:<Ruler size={11}/>,label:'Distance',shortcut:'D'},{icon:<Ruler size={11}/>,label:'Angle',shortcut:'A'},{icon:<Area size={11}/>,label:'Area',shortcut:'Ar'},{type:'separator'},{icon:<Ruler size={11}/>,label:'Add Dimension',shortcut:'Ctrl+D'},{icon:<Settings size={11}/>,label:'Dimension Style',shortcut:'Ctrl+M'}]},
    {label:'Display',items:[{icon:<Monitor size={11}/>,label:'Render Settings',shortcut:'R'},{icon:<Eye size={11}/>,label:'View Modes',shortcut:'V'},{icon:<Camera size={11}/>,label:'Camera Settings',shortcut:'C'},{type:'separator'},{icon:<Layers size={11}/>,label:'Material Editor',shortcut:'M'},{icon:<Settings size={11}/>,label:'Lighting',shortcut:'L'}]},
    {label:'Settings',items:[{icon:<Cog size={11}/>,label:'General Settings',shortcut:'Ctrl+,'},{icon:<Grid size={11}/>,label:'Grid Settings',shortcut:'G'},{icon:<Ruler size={11}/>,label:'Unit Settings',shortcut:'U'},{type:'separator'},{icon:<Settings size={11}/>,label:'Toolbar',shortcut:'T'},{icon:<PanelLeft size={11}/>,label:'Panel Layout',shortcut:'P'}]},
    {label:'Report',items:[{icon:<FileText size={11}/>,label:'Project Report',shortcut:'Ctrl+R'},{icon:<BarChart3 size={11}/>,label:'Material List',shortcut:'Ctrl+L'},{icon:<FileText size={11}/>,label:'Dimension Report',shortcut:'Ctrl+M'},{type:'separator'},{icon:<FileDown size={11}/>,label:'PDF Export',shortcut:'Ctrl+P'},{icon:<FileDown size={11}/>,label:'Excel Export',shortcut:'Ctrl+E'}]},
    {label:'Window',items:[{icon:<PanelLeft size={11}/>,label:'New Window',shortcut:'Ctrl+N'},{icon:<Layers size={11}/>,label:'Window Layout',shortcut:'Ctrl+W'},{type:'separator'},{icon:<Monitor size={11}/>,label:'Full Screen',shortcut:'F11'},{icon:<PanelLeft size={11}/>,label:'Hide Panels',shortcut:'Tab'}]},
    {label:'Help',items:[{icon:<HelpCircle size={11}/>,label:'User Manual',shortcut:'F1'},{icon:<HelpCircle size={11}/>,label:'Keyboard Shortcuts',shortcut:'Ctrl+?'},{icon:<Monitor size={11}/>,label:'Video Tutorials',shortcut:'Ctrl+T'},{type:'separator'},{icon:<HelpCircle size={11}/>,label:'About',shortcut:'Ctrl+H'},{icon:<HelpCircle size={11}/>,label:'Check Updates',shortcut:'Ctrl+U'}]},
  ];

  const dropStyle: React.CSSProperties = {
    position:'absolute', left:0, top:'100%', marginTop:'5px',
    width:'216px', background:'#ffffff',
    border:`1px solid ${T.hdrBorder}`, borderRadius:'10px', padding:'5px',
    zIndex:50,
    boxShadow:'0 12px 36px -4px rgba(40,30,20,0.14),0 4px 12px -2px rgba(40,30,20,0.06),0 0 0 0.5px rgba(40,30,20,0.04)',
  };

  const menuItemBase: React.CSSProperties = {
    display:'flex', alignItems:'center', justifyContent:'space-between',
    width:'100%', height:'30px', padding:'0 10px',
    fontSize: TS.ui,
    fontFamily:"'Inter',system-ui,sans-serif",
    fontWeight:420, letterSpacing: TS.ls, color: T.textBody,
    background:'transparent', border:'none', cursor:'pointer',
    borderRadius:'6px', outline:'none', transition:'background 0.08s,color 0.08s',
  };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
        @keyframes tb-in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:translateY(0)}}
        .tb-drop{animation:tb-in 0.11s ease-out forwards;}
        .tb-dot{
          position:absolute;bottom:-1px;left:50%;transform:translateX(-50%);
          width:18px;height:2px;border-radius:99px;
          background:linear-gradient(90deg,transparent,#f97316 50%,transparent);
        }
        .tb-mi:hover{background:#fff7ed!important;color:#ea580c!important;}
      `}</style>

      <div className="flex flex-col select-none" style={{fontFamily:"'Inter','SF Pro Text',system-ui,sans-serif"}}>

        {/* ── ROW 1 · Header ── */}
        <div style={{
          position:'relative',
          display:'flex', alignItems:'center', height:'46px', padding:'0 18px',
          background:T.headerBg,
          borderBottom:`1px solid ${T.hdrBorder}`,
          boxShadow:'0 1px 0 rgba(255,255,255,0.5)',
          gap:'12px',
        }}>
          <img src="/yago_logo.png" alt="YAGO" style={{height:'26px',width:'auto',objectFit:'contain',flexShrink:0}}/>
          <div style={{
            width:'1px', height:'20px', flexShrink:0,
            background:'linear-gradient(to bottom,transparent,rgba(60,50,40,0.18) 40%,rgba(60,50,40,0.18) 60%,transparent)',
          }}/>

          {/* Breadcrumb — Company */}
          <div style={{display:'flex',alignItems:'center',gap:'6px'}}>
            <span style={{
              fontSize: TS.ui,
              fontWeight: 400,
              letterSpacing: TS.ls,
              color: T.textFaint,
              fontFamily: "'Inter','SF Pro Text',system-ui,sans-serif",
            }}>
              Company
            </span>
            <span style={{
              fontSize: TS.uiSep,
              color: T.textWhisper,
              fontWeight: 300,
            }}>›</span>
            <span style={{
              fontSize: TS.ui,
              fontWeight: 600,
              letterSpacing: TS.lsTight,
              color: '#d9540a',
              fontFamily: "'Inter','SF Pro Text',system-ui,sans-serif",
            }}>
              Göker İnşaat
            </span>
          </div>

          <div style={{
            width:'1px', height:'20px', flexShrink:0,
            background:'linear-gradient(to bottom,transparent,rgba(60,50,40,0.18) 40%,rgba(60,50,40,0.18) 60%,transparent)',
          }}/>

          {/* Breadcrumb — Project */}
          <div style={{display:'flex',alignItems:'center',gap:'6px'}}>
            <span style={{
              fontSize: TS.ui,
              fontWeight: 400,
              letterSpacing: TS.ls,
              color: T.textFaint,
              fontFamily: "'Inter','SF Pro Text',system-ui,sans-serif",
            }}>
              Project
            </span>
            <span style={{
              fontSize: TS.uiSep,
              color: T.textWhisper,
              fontWeight: 300,
            }}>›</span>
            <span style={{
              fontSize: TS.ui,
              fontWeight: 600,
              letterSpacing: TS.lsTight,
              color: T.textStrong,
              fontFamily: "'Inter','SF Pro Text',system-ui,sans-serif",
            }}>
              Drawing1
            </span>
          </div>

          {/* Right */}
          <div style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:'6px'}}>

            {/* Search */}
            <div style={{position:'relative',display:'flex',alignItems:'center'}}>
              <Search size={12} style={{position:'absolute',left:'10px',color:'#b0aaa4',pointerEvents:'none'}}/>
              <input
                type="text" placeholder="Search..."
                style={{
                  width:'180px', height:'28px', paddingLeft:'30px', paddingRight:'10px',
                  fontSize: TS.ui,
                  fontFamily: "'Inter','SF Pro Text',system-ui,sans-serif",
                  fontWeight: 400,
                  letterSpacing: TS.ls,
                  color: T.textStrong,
                  background:'#f7f6f3', border:`1px solid ${T.groupBorder}`,
                  borderRadius:'7px', outline:'none',
                  boxShadow:'inset 0 1px 2px rgba(0,0,0,0.04)',
                  transition:'border-color 0.15s,box-shadow 0.15s,background 0.15s',
                }}
                onFocus={e=>{
                  e.currentTarget.style.borderColor='#f97316';
                  e.currentTarget.style.boxShadow='0 0 0 2.5px rgba(249,115,22,0.14),inset 0 1px 2px rgba(0,0,0,0.03)';
                  e.currentTarget.style.background='#fff';
                }}
                onBlur={e=>{
                  e.currentTarget.style.borderColor=T.groupBorder;
                  e.currentTarget.style.boxShadow='inset 0 1px 2px rgba(0,0,0,0.04)';
                  e.currentTarget.style.background='#f7f6f3';
                }}
              />
            </div>

            <div style={{
              width:'1px', height:'18px', flexShrink:0, margin:'0 4px',
              background:'linear-gradient(to bottom,transparent,rgba(60,50,40,0.16) 40%,rgba(60,50,40,0.16) 60%,transparent)',
            }}/>

            <BtnGroup>
              {viewMode===ViewMode.SOLID
                ? <ViewSolidButton onClick={()=>cycleViewMode()}/>
                : viewMode===ViewMode.WIREFRAME
                  ? <ViewWireframeButton onClick={()=>cycleViewMode()}/>
                  : <ViewXRayButton onClick={()=>cycleViewMode()}/>
              }
              {cameraType===CameraType.PERSPECTIVE
                ? <CameraPerspectiveButton onClick={handleCameraToggle}/>
                : <CameraOrthographicButton onClick={handleCameraToggle}/>
              }
              <TBtn
                icon={<Crosshair size={14}/>}
                label={`Linear Mode: ${orthoMode===OrthoMode.ON?'On':'Off'}`}
                active={orthoMode===OrthoMode.ON}
                onClick={()=>toggleOrthoMode()}
              />
              <GrpSep/>
              <TBtn icon={<Settings size={14}/>} label="Settings"/>
              <TBtn icon={<HelpCircle size={14}/>} label="Help"/>
              <GrpSep/>
              <TBtn icon={<LogOut size={14}/>} label="Exit" exit onClick={()=>{/* handle exit */}}/>
            </BtnGroup>
          </div>
        </div>

        {/* ══════════════════════════════════════════════
            ROW 2 · MENU BAR — Premium milled-bone surface
            • Gradient background with depth
            • Inset top highlight + bottom shadow
            • Subtle texture via layered box-shadows
        ══════════════════════════════════════════════ */}
        <div style={{
          position:'relative',
          display:'flex', alignItems:'center',
          height:'34px',
          padding:'0 14px',
          background:T.menuBg,
          borderBottom:`1px solid ${T.menuBorder}`,
          boxShadow:[
            /* Inner top highlight — looks like light catching the milled edge */
            'inset 0 1px 0 rgba(255,255,255,0.85)',
            /* Inner bottom shade — subtle depression */
            'inset 0 -1px 0 rgba(140,120,100,0.08)',
            /* Inner side accents — wall feeling */
            'inset 1px 0 0 rgba(255,255,255,0.4)',
            'inset -1px 0 0 rgba(140,120,100,0.04)',
            /* Drop shadow underneath — separates from row 3 */
            '0 1px 0 rgba(255,255,255,0.45)',
            '0 2px 4px -1px rgba(60,50,40,0.06)',
          ].join(','),
        }}>
          {/* Subtle horizontal "grain" texture overlay — barely visible but adds depth */}
          <div style={{
            position:'absolute',
            inset:0,
            pointerEvents:'none',
            backgroundImage:
              'repeating-linear-gradient(0deg,' +
              'rgba(255,255,255,0) 0px,' +
              'rgba(255,255,255,0) 2px,' +
              'rgba(140,120,100,0.012) 2px,' +
              'rgba(140,120,100,0.012) 3px)',
            opacity: 0.6,
          }}/>

          {menus.map(menu=>(
            <div key={menu.label} style={{position:'relative',height:'100%',zIndex:1}}>
              <button
                style={{
                  height:'100%',
                  padding:'0 13px',
                  fontSize: TS.ui,
                  fontFamily: "'Inter','SF Pro Text',system-ui,sans-serif",
                  fontWeight: activeMenu===menu.label ? 600 : 450,
                  letterSpacing: activeMenu===menu.label ? TS.lsTight : TS.ls,
                  color: activeMenu===menu.label ? '#ea580c' : T.textMute,
                  background: activeMenu===menu.label
                    ? 'linear-gradient(180deg,#fff7ed 0%,#ffedd5 100%)'
                    : 'transparent',
                  boxShadow: activeMenu===menu.label
                    ? '0 0 0 0.5px rgba(234,88,12,0.12),inset 0 1px 0 rgba(255,255,255,0.9),inset 0 -1px 0 rgba(234,88,12,0.06)'
                    : 'none',
                  border:'none', cursor:'pointer', display:'flex', alignItems:'center',
                  position:'relative', outline:'none', borderRadius:'5px',
                  transition:'color 0.12s,background 0.12s,box-shadow 0.12s,letter-spacing 0.12s',
                }}
                onClick={()=>setActiveMenu(activeMenu===menu.label?null:menu.label)}
                onMouseEnter={e=>{
                  if (activeMenu) setActiveMenu(menu.label);
                  if (activeMenu!==menu.label){
                    (e.currentTarget as HTMLButtonElement).style.color = T.textStrong;
                    (e.currentTarget as HTMLButtonElement).style.background = 'linear-gradient(180deg,#fdfcfa 0%,#f4f1ea 100%)';
                    (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 0 0 0.5px rgba(60,50,40,0.08),inset 0 1px 0 rgba(255,255,255,0.9)';
                  }
                }}
                onMouseLeave={e=>{
                  if (activeMenu!==menu.label){
                    (e.currentTarget as HTMLButtonElement).style.color = T.textMute;
                    (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                    (e.currentTarget as HTMLButtonElement).style.boxShadow = 'none';
                  }
                }}
              >
                {menu.label}
                {activeMenu===menu.label && <div className="tb-dot"/>}
              </button>

              {activeMenu===menu.label && (
                <div className="tb-drop" style={dropStyle} onMouseLeave={()=>setActiveMenu(null)}>
                  {menu.items.map((item,i)=>
                    item.type==='separator'
                      ? <div key={i} style={{height:'1px',background:'#f0ede8',margin:'3px 0'}}/>
                      : (
                        <button key={i} className="tb-mi" style={menuItemBase}
                          onClick={()=>{
                            if(item.label==='Solid View')setViewMode(ViewMode.SOLID);
                            else if(item.label==='Wireframe View')setViewMode(ViewMode.WIREFRAME);
                            else if(item.label==='X-Ray View')setViewMode(ViewMode.XRAY);
                            setActiveMenu(null);
                          }}>
                          <div style={{display:'flex',alignItems:'center',gap:'8px'}}>{item.icon}<span>{item.label}</span></div>
                          {item.shortcut&&<span style={{
                            fontFamily:"'SF Mono','Fira Code',monospace",
                            fontSize:'10px',
                            letterSpacing:'0.03em',
                            color: T.textFaint,
                            fontWeight:400,
                          }}>{item.shortcut}</span>}
                        </button>
                      )
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* ── ROW 3 · Main Toolbar ── */}
        <div style={{
          position:'relative',
          display:'flex', alignItems:'center', height:'42px', padding:'0 14px',
          gap:'0',
          background:T.rowBg,
          borderBottom:`1px solid ${T.rowBorder}`,
          boxShadow:'inset 0 1px 0 rgba(255,255,255,0.85),inset 0 -1px 0 rgba(140,120,100,0.06),0 1px 4px rgba(60,50,40,0.04)',
        }}>
          <BtnGroup>
            <TBtn icon={<FilePlus size={16}/>} label="New (Ctrl+N)"/>
            <TBtn icon={<Save size={16}/>}     label="Save (Ctrl+S)"/>
            <TBtn icon={<FileDown size={16}/>} label="Save As"/>
          </BtnGroup>
          <Sep/>
          <BtnGroup>
            <TBtn icon={<Undo2 size={16}/>} label="Undo (Ctrl+Z)"/>
            <TBtn icon={<Redo2 size={16}/>} label="Redo (Ctrl+Y)"/>
          </BtnGroup>
          <Sep/>
          <BtnGroup>
            <TBtn icon={<MousePointer2 size={16}/>} label="Select (V)" active={activeTool===Tool.SELECT} onClick={()=>setActiveTool(Tool.SELECT)}/>
            <TBtn icon={<Move size={16}/>} label="Move (M)" active={activeTool===Tool.MOVE} disabled={!selectedShapeId} onClick={()=>handleTransformToolSelect(Tool.MOVE)}/>
            <TBtn icon={<Navigation size={16}/>} label="Point to Point" active={activeTool===Tool.POINT_TO_POINT_MOVE} disabled={!selectedShapeId} onClick={()=>handleTransformToolSelect(Tool.POINT_TO_POINT_MOVE)}/>
            <TBtn icon={<RefreshCcw size={16}/>} label="Rotate (R)" active={activeTool===Tool.ROTATE} disabled={!selectedShapeId} onClick={()=>handleTransformToolSelect(Tool.ROTATE)}/>
            <TBtn icon={<Maximize2 size={16}/>} label={isBoxSelected?'Scale — disabled for box':'Scale (S)'} active={activeTool===Tool.SCALE} disabled={!selectedShapeId||isBoxSelected} onClick={()=>handleTransformToolSelect(Tool.SCALE)}/>
          </BtnGroup>
          <Sep/>
          <BtnGroup>
            <AddBoxButton onClick={handleAddBox}/>
            <SubtractBoxButton onClick={handleSubtract} disabled={!selectedShapeId||!hasIntersectingShapes} className={hasIntersectingShapes?'text-red-400 hover:bg-red-50 hover:text-red-500':''}/>
            <GrpSep/>
            <TBtn icon={<FolderOpen size={16}/>} label="Catalog" accent onClick={onOpenCatalog}/>
          </BtnGroup>
        </div>

      </div>

      {/* Polyline context menu */}
      {showPolylineMenu&&(
        <div className="tb-drop" style={{
          position:'fixed', left:polylineMenuPosition.x, top:polylineMenuPosition.y,
          background:'#ffffff', border:`1px solid ${T.hdrBorder}`,
          borderRadius:'10px', padding:'4px', zIndex:50,
          boxShadow:'0 8px 28px rgba(0,0,0,0.1)',
        }}>
          {[
            {icon:<SlidersHorizontal size={13}/>,label:'Edit Polyline',tool:Tool.POLYLINE_EDIT},
            {icon:<GitBranch size={13}/>,label:'Draw Polyline',tool:Tool.POLYLINE},
          ].map(it=>(
            <button key={it.label} className="tb-mi" style={menuItemBase}
              onClick={()=>{setActiveTool(it.tool);setShowPolylineMenu(false);}}>
              <div style={{display:'flex',alignItems:'center',gap:'8px'}}>{it.icon}<span>{it.label}</span></div>
            </button>
          ))}
        </div>
      )}
    </>
  );
};

export default Toolbar;
