import React from 'react';
import * as THREE from 'three';
import {
  FilePlus, Save, FileDown,
  Undo2, Redo2,
  MousePointer2, Move, Navigation, RefreshCcw, Maximize2,
  MinusSquare, Camera, CameraOff, Crosshair, FolderOpen,
  BoxSelect, ScanEye, Cuboid as Cube,
} from 'lucide-react';
import { Tool, useAppStore, CameraType, ViewMode, OrthoMode } from '../store';
import { createReplicadBox, convertReplicadToThreeGeometry, performBooleanCut } from './ReplicadService';
import { AddBoxButton } from './icons';

interface VerticalToolbarProps {
  onOpenCatalog: () => void;
}

const VerticalToolbar: React.FC<VerticalToolbarProps> = ({ onOpenCatalog }) => {
  const {
    setActiveTool, activeTool, setLastTransformTool, addShape, selectedShapeId,
    modifyShape, cameraType, setCameraType, viewMode, setViewMode,
    orthoMode, toggleOrthoMode, shapes, updateShape, deleteShape,
    showToolbarLabels, setShowToolbarLabels, leftSidebarOpen,
  } = useAppStore();

  const showLabels = showToolbarLabels && !leftSidebarOpen;

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

  const selectedShape = shapes.find(s => s.id === selectedShapeId);
  const isBoxSelected = selectedShape?.type === 'box';

  const handleTransformTool = (tool: Tool) => { setActiveTool(tool); setLastTransformTool(tool); };

  const handleAddBox = async () => {
    try {
      const w = 600, h = 600, d = 600;
      const rs = await createReplicadBox({ width: w, height: h, depth: d });
      addShape({ id: `box-${Date.now()}`, type: 'box', geometry: convertReplicadToThreeGeometry(rs), replicadShape: rs, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: '#2563eb', parameters: { width: w, height: h, depth: d } });
    } catch (e) { alert(`Failed to add box: ${(e as Error).message}`); }
  };

  const handleSubtract = async () => {
    if (!selectedShapeId || !hasIntersectingShapes) return;
    try {
      const sel = shapes.find(s => s.id === selectedShapeId);
      if (!sel?.geometry || !sel.replicadShape) return;
      const sb = new THREE.Box3().setFromBufferAttribute(sel.geometry.getAttribute('position'));
      sb.set(sb.min.clone().add(new THREE.Vector3(...sel.position)), sb.max.clone().add(new THREE.Vector3(...sel.position)));
      const intersecting = shapes.filter(s => {
        if (s.id === selectedShapeId || !s.geometry) return false;
        const b = new THREE.Box3().setFromBufferAttribute(s.geometry.getAttribute('position'));
        b.set(b.min.clone().add(new THREE.Vector3(...s.position)), b.max.clone().add(new THREE.Vector3(...s.position)));
        return sb.intersectsBox(b);
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
        updateShape(target.id, { geometry: newGeo, replicadShape: result, subtractionGeometries: [...(target.subtractionGeometries || []), { geometry: sel.geometry.clone(), relativeOffset: relOff, relativeRotation: relRot, scale: [1, 1, 1] }], parameters: { ...target.parameters, scaledBaseVertices: newVerts.map(v => [v.x, v.y, v.z]) } });
      }
      deleteShape(selectedShapeId);
    } catch (e) { alert(`Failed to subtract: ${(e as Error).message}`); }
  };

  const viewModeLabel = { [ViewMode.SOLID]: 'Solid', [ViewMode.WIREFRAME]: 'Wire', [ViewMode.XRAY]: 'X-Ray' }[viewMode] ?? 'Solid';
  const viewModeIcon =
    viewMode === ViewMode.WIREFRAME ? <BoxSelect size={16} /> :
    viewMode === ViewMode.XRAY     ? <ScanEye size={16} /> :
                                     <Cube size={16} />;

  // Button definitions for each group
  const groups: {
    key: string;
    items: {
      key: string;
      icon: React.ReactNode;
      label: string;
      active?: boolean;
      disabled?: boolean;
      danger?: boolean;
      accent?: boolean;
      custom?: React.ReactNode;
      onClick?: () => void;
    }[];
  }[] = [
    {
      key: 'file',
      items: [
        { key: 'new', icon: <FilePlus size={16} />, label: 'New', onClick: () => {} },
        { key: 'save', icon: <Save size={16} />, label: 'Save', onClick: () => {} },
        { key: 'saveas', icon: <FileDown size={16} />, label: 'Save As', onClick: () => {} },
      ],
    },
    {
      key: 'history',
      items: [
        { key: 'undo', icon: <Undo2 size={16} />, label: 'Undo', onClick: () => {} },
        { key: 'redo', icon: <Redo2 size={16} />, label: 'Redo', onClick: () => {} },
      ],
    },
    {
      key: 'transform',
      items: [
        { key: 'select', icon: <MousePointer2 size={16} />, label: 'Select', active: activeTool === Tool.SELECT, onClick: () => setActiveTool(Tool.SELECT) },
        { key: 'move', icon: <Move size={16} />, label: 'Move', active: activeTool === Tool.MOVE, disabled: !selectedShapeId, onClick: () => handleTransformTool(Tool.MOVE) },
        { key: 'p2p', icon: <Navigation size={16} />, label: 'Point to Point', active: activeTool === Tool.POINT_TO_POINT_MOVE, disabled: !selectedShapeId, onClick: () => handleTransformTool(Tool.POINT_TO_POINT_MOVE) },
        { key: 'rotate', icon: <RefreshCcw size={16} />, label: 'Rotate', active: activeTool === Tool.ROTATE, disabled: !selectedShapeId, onClick: () => handleTransformTool(Tool.ROTATE) },
        { key: 'scale', icon: <Maximize2 size={16} />, label: 'Scale', active: activeTool === Tool.SCALE, disabled: !selectedShapeId || isBoxSelected, onClick: () => handleTransformTool(Tool.SCALE) },
      ],
    },
    {
      key: 'geometry',
      items: [
        { key: 'addbox', icon: null, label: 'Add Box', custom: <AddBoxButton onClick={handleAddBox} /> },
        { key: 'subtract', icon: <MinusSquare size={16} />, label: hasIntersectingShapes ? 'Subtract Intersection' : 'Subtract', danger: hasIntersectingShapes, disabled: !selectedShapeId, onClick: handleSubtract },
      ],
    },
    {
      key: 'view',
      items: [
        { key: 'camera', icon: cameraType === CameraType.PERSPECTIVE ? <Camera size={16} /> : <CameraOff size={16} />, label: cameraType === CameraType.PERSPECTIVE ? 'Perspective' : 'Orthographic', onClick: () => setCameraType(cameraType === CameraType.PERSPECTIVE ? CameraType.ORTHOGRAPHIC : CameraType.PERSPECTIVE) },
        { key: 'viewmode', icon: viewModeIcon, label: `View: ${viewModeLabel}`, active: viewMode !== ViewMode.SOLID, onClick: () => useAppStore.getState().cycleViewMode() },
        { key: 'ortho', icon: <Crosshair size={16} />, label: `Linear: ${orthoMode === OrthoMode.ON ? 'On' : 'Off'}`, active: orthoMode === OrthoMode.ON, onClick: toggleOrthoMode },
        { key: 'catalog', icon: <FolderOpen size={16} />, label: 'Catalog', accent: true, onClick: onOpenCatalog },
      ],
    },
  ];

  return (
    <div
      className="flex flex-col items-stretch gap-1 py-2 px-1.5 bg-stone-50 border-r border-stone-200 overflow-y-auto overflow-x-hidden select-none"
      style={{ minWidth: showLabels ? 148 : 40, transition: 'min-width 0.25s cubic-bezier(0.4,0,0.2,1)' }}
    >
      {/* Label toggle button at top */}
      <button
        title={showToolbarLabels ? 'Hide Labels' : 'Show Labels'}
        onClick={() => setShowToolbarLabels(!showToolbarLabels)}
        className="flex items-center justify-center w-full h-6 rounded text-stone-300 hover:text-stone-500 hover:bg-stone-100 transition-colors duration-150 mb-0.5"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          {showToolbarLabels
            ? <><rect x="1" y="3" width="5" height="2" rx="1" fill="currentColor"/><rect x="1" y="6.5" width="8" height="2" rx="1" fill="currentColor"/><rect x="1" y="10" width="6" height="2" rx="1" fill="currentColor"/></>
            : <><rect x="4" y="3" width="2" height="2" rx="1" fill="currentColor"/><rect x="4" y="6.5" width="2" height="2" rx="1" fill="currentColor"/><rect x="4" y="10" width="2" height="2" rx="1" fill="currentColor"/></>
          }
        </svg>
      </button>

      {groups.map((group, gi) => (
        <React.Fragment key={group.key}>
          {gi > 0 && <div className="w-full h-px bg-stone-200 my-0.5" />}
          <div className="flex flex-col gap-0.5">
            {group.items.map(item => {
              if (item.custom) {
                return (
                  <div key={item.key} className="flex items-center gap-2 px-0.5 h-[26px]">
                    {item.custom}
                    {showLabels && (
                      <span className="text-[11px] font-medium text-stone-500 truncate leading-none">{item.label}</span>
                    )}
                  </div>
                );
              }

              const isActive = !!item.active;
              const isDanger = !!item.danger;
              const isAccent = !!item.accent;
              const isDisabled = !!item.disabled;

              return (
                <button
                  key={item.key}
                  title={item.label}
                  disabled={isDisabled}
                  onClick={item.onClick}
                  className={[
                    'flex items-center gap-2 px-1 h-[26px] rounded-md transition-all duration-150 group w-full text-left',
                    'outline-none focus-visible:ring-2 focus-visible:ring-orange-200',
                    isDisabled
                      ? 'opacity-30 cursor-not-allowed text-stone-400'
                      : isDanger
                        ? 'text-red-400 hover:bg-red-50 hover:text-red-500 active:scale-95'
                        : isActive
                          ? 'bg-orange-50 text-orange-400 shadow-sm ring-1 ring-orange-200'
                          : isAccent
                            ? 'bg-orange-50 text-orange-400 hover:bg-orange-100 shadow-sm active:scale-95'
                            : 'text-stone-400 hover:bg-stone-100 hover:text-stone-700 active:scale-95',
                  ].join(' ')}
                >
                  <span className={['flex items-center justify-center w-[18px] h-[18px] shrink-0 transition-transform duration-150', !isDisabled && !isActive ? 'group-hover:scale-110' : ''].join(' ')}>
                    {item.icon}
                  </span>
                  {showLabels && (
                    <span className="text-[11px] font-medium truncate leading-none whitespace-nowrap overflow-hidden">
                      {item.label}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
};

export default VerticalToolbar;
