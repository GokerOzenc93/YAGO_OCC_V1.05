import React, { useState, useEffect } from 'react';
import { X, GripVertical, RefreshCw, MousePointer, Layers } from 'lucide-react';
import { useAppStore } from '../store';
import type { Panel } from '../types';

interface PanelEditorProps {
  isOpen: boolean;
  onClose: () => void;
}

export function PanelEditor({ isOpen, onClose }: PanelEditorProps) {
  const { selectedShapeId, shapes, panels, setPanels, updatePanel, resolving } = useAppStore();
  const [panelSelectMode, setPanelSelectMode] = useState(false);
  const [raycastFaceMode, setRaycastFaceMode] = useState(false);
  const [outlineMode, setOutlineMode] = useState(false);
  const [roleNumbersMode, setRoleNumbersMode] = useState(false);

  const shape = selectedShapeId ? shapes.find(s => s.id === selectedShapeId) : null;

  const handleTogglePanel = (panelId: string) => {
    const updated = panels.map(p => p.id === panelId ? { ...p, enabled: !p.enabled } : p);
    setPanels(updated);
  };

  const handleRotatePanel = (panelId: string) => {
    const panel = panels.find(p => p.id === panelId);
    if (!panel) return;
    const newRotation = (panel.rotation + 90) % 360;
    updatePanel(panelId, { rotation: newRotation });
  };

  const handleEditPanel = (panelId: string) => {
    console.log('Edit panel:', panelId);
  };

  const handleDeletePanel = (panelId: string) => {
    const updated = panels.filter(p => p.id !== panelId);
    setPanels(updated);
  };

  const handleResolve = () => {
    console.log('Resolving panels...');
  };

  if (!isOpen) return null;

  return (
    <div className="fixed left-0 top-0 w-[320px] h-full bg-white border-r border-stone-200 shadow-lg z-40 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-stone-50 border-b border-stone-200">
        <div className="flex items-center gap-2">
          <GripVertical size={14} className="text-stone-400" />
          <span className="text-xs font-semibold text-stone-700">Panel Editor</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setRaycastFaceMode(!raycastFaceMode)}
            className={`px-2 py-1 text-[10px] font-medium rounded transition-colors ${raycastFaceMode ? 'bg-orange-100 text-orange-600 ring-1 ring-orange-200' : 'text-stone-600 hover:bg-stone-200'}`}
            title="Raycast Face Mode"
          >
            RAYCAST FACE
          </button>
          <button
            onClick={() => setOutlineMode(!outlineMode)}
            className={`px-2 py-1 text-[10px] font-medium rounded transition-colors ${outlineMode ? 'bg-blue-100 text-blue-600 ring-1 ring-blue-200' : 'text-stone-600 hover:bg-stone-200'}`}
            title="Outline Mode"
          >
            OUTLINE
          </button>
          <button
            onClick={() => setRoleNumbersMode(!roleNumbersMode)}
            className={`px-2 py-1 text-[10px] font-medium rounded transition-colors ${roleNumbersMode ? 'bg-green-100 text-green-600 ring-1 ring-green-200' : 'text-stone-600 hover:bg-stone-200'}`}
            title="Role Numbers Mode"
          >
            ROLE NUMBERS
          </button>
          <button
            onClick={handleResolve}
            disabled={resolving}
            className={`p-1 rounded transition-colors ${resolving ? 'text-stone-300 cursor-not-allowed' : 'text-stone-600 hover:bg-stone-200'}`}
            title="Resolve Panels"
          >
            <RefreshCw size={14} className={resolving ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => setPanelSelectMode(!panelSelectMode)}
            className={`p-1 hover:bg-stone-200 rounded transition-colors ${panelSelectMode ? 'text-orange-600' : 'text-stone-600'}`}
            title={panelSelectMode ? 'Panel Mode' : 'Body Mode'}
          >
            {panelSelectMode ? <MousePointer size={14} /> : <Layers size={14} />}
          </button>
          <button onClick={onClose} className="p-1 hover:bg-stone-200 rounded transition-colors" title="Close">
            <X size={14} className="text-stone-600" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {shape ? (
          <div className="space-y-2">
            <div className="text-[10px] font-semibold text-stone-500 uppercase mb-2">Panels for {shape.type}</div>
            {panels.length === 0 ? (
              <div className="text-xs text-stone-400 text-center py-4">No panels defined</div>
            ) : (
              panels.map(panel => (
                <div key={panel.id} className="flex items-center gap-2 p-2 bg-stone-50 rounded border border-stone-200">
                  <input
                    type="checkbox"
                    checked={panel.enabled}
                    onChange={() => handleTogglePanel(panel.id)}
                    className="w-3.5 h-3.5"
                  />
                  <div className="flex-1">
                    <div className="text-xs font-medium text-stone-700">{panel.name}</div>
                    <div className="text-[10px] text-stone-500">
                      {panel.width.toFixed(0)} × {panel.height.toFixed(0)} @ {panel.rotation}°
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleRotatePanel(panel.id)}
                      className="px-1.5 py-0.5 text-[9px] font-medium bg-blue-100 text-blue-600 rounded hover:bg-blue-200 transition-colors"
                      title="Rotate 90°"
                    >
                      ROTATE
                    </button>
                    <button
                      onClick={() => handleEditPanel(panel.id)}
                      className="px-1.5 py-0.5 text-[9px] font-medium bg-orange-100 text-orange-600 rounded hover:bg-orange-200 transition-colors"
                      title="Edit Panel"
                    >
                      EDIT
                    </button>
                    <button
                      onClick={() => handleDeletePanel(panel.id)}
                      className="px-1.5 py-0.5 text-[9px] font-medium bg-red-100 text-red-600 rounded hover:bg-red-200 transition-colors"
                      title="Delete Panel"
                    >
                      DELETE
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="text-center text-stone-500 text-xs py-4">No shape selected</div>
        )}
      </div>
    </div>
  );
}
