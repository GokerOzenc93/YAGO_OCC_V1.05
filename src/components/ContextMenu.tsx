import React from 'react';
import { Edit, Copy, RotateCcw, Trash2, Navigation, Save, FileDown, Link, Unlink } from 'lucide-react';
import { useAppStore, Tool } from '../store';

interface ContextMenuProps {
  position: { x: number; y: number };
  shapeId: string;
  shapeType: string;
  onClose: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onMove: () => void;
  onRotate: () => void;
  onDelete: () => void;
  onToggleVisibility: () => void;
  onSave: () => void;
}

const ContextMenu: React.FC<ContextMenuProps> = ({
  position,
  shapeId,
  shapeType,
  onClose,
  onEdit,
  onCopy,
  onMove,
  onRotate,
  onDelete,
  onToggleVisibility,
  onSave,
}) => {
  const { setActiveTool, setPointToPointMoveState, selectShape, selectedShapeId, secondarySelectedShapeId, createGroup, ungroupShapes, shapes } = useAppStore();
  const currentShape = shapes.find(s => s.id === shapeId);
  const hasGroup = !!currentShape?.groupId;
  const canCreateGroup = selectedShapeId && secondarySelectedShapeId && !hasGroup;

  const handlePointToPointMove = () => {
    setActiveTool(Tool.POINT_TO_POINT_MOVE);

    const { enableAutoSnap } = useAppStore.getState();
    enableAutoSnap(Tool.POINT_TO_POINT_MOVE);

    setPointToPointMoveState({
      isActive: true,
      selectedShapeId: shapeId,
      sourcePoint: null,
      targetPoint: null,
    });
    selectShape(shapeId);
    console.log(`Point to Point Move started for shape: ${shapeId}`);
    onClose();
  };

  const handleSave = () => {
    onSave();
  };

  const handleSaveAs = () => {
    console.log('Save As shape:', shapeId);
    onClose();
  };

  const handleCreateGroup = () => {
    if (selectedShapeId && secondarySelectedShapeId) {
      createGroup(selectedShapeId, secondarySelectedShapeId);
      console.log('Group created:', { selectedShapeId, secondarySelectedShapeId });
    }
    onClose();
  };

  const handleUngroup = () => {
    if (currentShape?.groupId) {
      ungroupShapes(currentShape.groupId);
      console.log('Group removed:', currentShape.groupId);
    }
    onClose();
  };

  const menuItems = [
    {
      icon: <Edit size={12} />,
      label: 'Edit',
      action: onEdit,
      enabled: true,
      shortcut: 'E',
      badge: 'ISOLATE'
    },
    {
      icon: <Copy size={12} />,
      label: 'Copy',
      action: onCopy,
      enabled: true,
      shortcut: 'Ctrl+C'
    },
    {
      icon: <RotateCcw size={12} />,
      label: 'Rotate',
      action: onRotate,
      enabled: true,
      shortcut: 'R'
    },
    {
      icon: <Trash2 size={12} />,
      label: 'Delete',
      action: onDelete,
      enabled: true,
      shortcut: 'Del'
    },
    {
      icon: <Navigation size={12} />,
      label: 'Point to Point',
      action: handlePointToPointMove,
      enabled: true,
      shortcut: 'P2P'
    },
    { type: 'separator' },
    {
      icon: <Link size={12} />,
      label: 'Create Group',
      action: handleCreateGroup,
      enabled: !!canCreateGroup,
      shortcut: 'Ctrl+G',
      badge: canCreateGroup ? undefined : undefined
    },
    {
      icon: <Unlink size={12} />,
      label: 'Ungroup',
      action: handleUngroup,
      enabled: hasGroup,
      shortcut: 'Ctrl+U'
    },
    { type: 'separator' },
    {
      icon: <Save size={12} />,
      label: 'Save',
      action: handleSave,
      enabled: true,
      shortcut: 'Ctrl+S'
    },
    {
      icon: <FileDown size={12} />,
      label: 'Save As',
      action: handleSaveAs,
      enabled: true,
      shortcut: 'Ctrl+Shift+S'
    },
  ];

  React.useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      onClose();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    setTimeout(() => {
      document.addEventListener('click', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }, 10);

    return () => {
      document.removeEventListener('click', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      className="fixed bg-white rounded-lg border border-stone-200 py-1.5 z-50 shadow-xl min-w-[180px] font-inter"
      style={{
        left: position.x,
        top: position.y,
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="px-3 py-1.5 border-b border-stone-200">
        <div className="text-xs text-slate-800 font-semibold">
          {shapeType ? shapeType.charAt(0).toUpperCase() + shapeType.slice(1) : 'Shape'}
        </div>
        <div className="text-[10px] text-stone-500 font-mono">
          ID: {shapeId ? shapeId.substring(0, 8) : 'unknown'}...
        </div>
      </div>

      <div className="py-1">
        {menuItems.map((item, index) => (
          item.type === 'separator' ? (
            <div key={index} className="border-t border-stone-200 my-1" />
          ) : (
            <button
              key={index}
              className={`w-full px-3 py-1.5 text-left text-xs flex items-center justify-between transition-colors ${
                item.enabled
                  ? 'hover:bg-orange-50 text-slate-700 hover:text-orange-700 cursor-pointer'
                  : 'text-stone-400 cursor-not-allowed opacity-50'
              }`}
              onClick={(e) => {
                e.stopPropagation();
                if (item.enabled) {
                  item.action();
                }
              }}
              disabled={!item.enabled}
            >
              <div className="flex items-center gap-2">
                {item.icon}
                <span className="font-medium">{item.label}</span>
                {item.badge && (
                  <span className="text-[9px] text-orange-600 bg-orange-100 px-1.5 py-0.5 rounded font-semibold">
                    {item.badge}
                  </span>
                )}
              </div>
              {item.shortcut && (
                <span className="text-[10px] text-stone-500 font-mono">
                  {item.shortcut}
                </span>
              )}
            </button>
          )
        ))}
      </div>
    </div>
  );
};

export default ContextMenu;
