import React from 'react';
import { useAppStore } from '../store';

const StatusBar: React.FC = () => {
  const { shapes, selectedShapeId, vertexEditMode, selectedVertexIndex } = useAppStore();
  const selectedShape = shapes.find(s => s.id === selectedShapeId);
  const vertexModCount = selectedShape?.vertexModifications?.length || 0;

  return (
    <div className="absolute left-0 right-0 flex items-center h-5 px-4 bg-white text-stone-700 text-xs border-t border-stone-200 z-20" style={{ bottom: '9mm' }}>
      <div className="flex items-center gap-4">
        <span className="text-stone-500">Objects: {shapes.length}</span>
        <span className="text-stone-500">
          Selected: {selectedShape ? `${selectedShape.type} (${selectedShape.id.slice(0, 8)})` : 'None'}
        </span>
        {selectedShape && (
          <span className="text-stone-500">
            Pos: [{selectedShape.position.map(v => v.toFixed(1)).join(', ')}]
          </span>
        )}
        {vertexEditMode && (
          <span className="text-blue-500">
            Vertex Edit {selectedVertexIndex !== null ? `(V${selectedVertexIndex})` : ''}
          </span>
        )}
        {vertexModCount > 0 && (
          <span className="text-purple-500">
            Vertex Mods: {vertexModCount}
          </span>
        )}
      </div>
    </div>
  );
};

export default StatusBar;
